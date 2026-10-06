import { coll } from './mongo.mjs';
import { isApi } from './source.mjs';
import { apiOddsForSport, apiSports } from './sportApi.mjs';

/**
 * Feed freshness for the status bar: how long ago each source last moved.
 *
 * The Supabase build could ask "newest `updated_at` for book X" directly. Mongo
 * has no index on `(sportsbook, updated_at)` and `odds` holds 6.6M rows, so that
 * same question is a 50-second collection scan here. Instead every read is
 * scoped to the fixtures about to jump — a few hundred ids that ride the
 * `{fixture_id, sportsbook, is_live}` index — which is both fast and a better
 * answer to the question actually being asked: are the feeds moving on the games
 * we're pricing right now.
 */

/** Window around now whose fixtures define "what the books should be pricing". */
const SCOPE_BACK_MS = 6 * 60 * 60 * 1000;
const SCOPE_FWD_MS = 12 * 60 * 60 * 1000;

/** The books whose freshness is worth a dot of its own. */
const WATCHED_BOOKS = [
  { key: 'tab', label: 'TAB', warn: 15, stale: 45 },
  { key: 'pinnacle', label: 'Pinnacle', warn: 10, stale: 30 },
];

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/**
 * The same bar, from the public surface.
 *
 * `fetchPulse` asks Mongo "when did each feed last write", which a deployed
 * instance cannot ask at all — so the bar was simply absent there, and the one
 * place you most want to know whether the upstream is moving had no indicator.
 *
 * The pivot answers a near-identical question: every price carries the moment
 * the book last moved it, so the newest `current_at` per book IS that book's
 * heartbeat. It reuses the drains the board has already cached, so the bar costs
 * nothing extra.
 *
 * Two entries cannot be reproduced and are left out rather than faked: `optic`
 * is a fixture-table write time with no counterpart here, and `scores` needs a
 * score-change timestamp the surface does not publish.
 */
/**
 * Sports sampled for the heartbeat, rather than all sixteen.
 *
 * "When did TAB last move a price" is answered just as well by the busy sports
 * as by every one of them, and draining the lot took 13.6s cold. These six
 * between them cover the clock, and they are the drains the board has already
 * cached — so on a warm instance the bar costs nothing.
 */
const PULSE_SPORTS = ['soccer', 'tennis', 'basketball', 'baseball', 'icehockey', 'amfootball'];

async function apiPulse() {
  const rows = (
    await Promise.all(PULSE_SPORTS.map((s) => apiOddsForSport(s).catch(() => [])))
  ).flat();

  const bookAt = new Map();
  let liveAt = null;
  const liveFixtures = new Set();
  for (const r of rows) {
    const at = r.current_at ? new Date(r.current_at).getTime() : null;
    if (!at) continue;
    const prev = bookAt.get(r.sportsbook);
    if (!prev || at > prev) bookAt.set(r.sportsbook, at);
    if (r.status === 'active') {
      if (!liveAt || at > liveAt) liveAt = at;
      if (r.fixture_id) liveFixtures.add(r.fixture_id);
    }
  }
  const stamp = (ms) => (ms ? new Date(ms).toISOString() : null);

  return [
    ...WATCHED_BOOKS.map((b) => ({
      key: b.key,
      label: b.label,
      at: stamp(bookAt.get(b.key)),
      idle: !bookAt.has(b.key),
      warn: b.warn,
      stale: b.stale,
    })),
    {
      key: 'live',
      label: 'Quoting',
      at: stamp(liveAt),
      detail: liveFixtures.size ? `${liveFixtures.size}` : undefined,
      // Nothing being quoted at 4am is not a fault.
      idle: liveFixtures.size === 0,
      warn: 5,
      stale: 15,
    },
  ];
}

export async function fetchPulse() {
  if (isApi) return apiPulse();
  const fixtures = await coll('fixtures');
  const now = Date.now();

  const [scope, live, optic] = await Promise.all([
    fixtures
      .find({
        has_odds: true,
        scheduled_start: { $gte: new Date(now - SCOPE_BACK_MS), $lte: new Date(now + SCOPE_FWD_MS) },
      })
      .project({ _id: 0, fixture_id: 1 })
      .toArray(),
    fixtures
      .find({ is_live: true })
      .project({ _id: 0, updated_at: 1, scores: 1 })
      .sort({ updated_at: -1 })
      .limit(300)
      .toArray(),
    // Newest Optic write, bounded to the same live window so it stays an index
    // range rather than a sort of the whole table.
    fixtures
      .aggregate([
        { $match: { source: 'optic', scheduled_start: { $gte: new Date(now - SCOPE_BACK_MS) } } },
        { $group: { _id: null, at: { $max: '$updated_at' } } },
      ])
      .toArray(),
  ]);

  const ids = scope.map((f) => f.fixture_id);
  const bookAt = new Map();
  if (ids.length) {
    const rows = await (await coll('odds'))
      .aggregate([
        { $match: { fixture_id: { $in: ids }, sportsbook: { $in: WATCHED_BOOKS.map((b) => b.key) } } },
        { $group: { _id: '$sportsbook', at: { $max: '$updated_at' } } },
      ])
      .toArray();
    for (const r of rows) bookAt.set(r._id, r.at);
  }

  // A score only counts once it carries a number — an empty `scores` object is
  // the shape the feed writes before anything has been played.
  const total = (s) => (typeof s === 'number' ? s : s?.total);
  const scored = live.filter(
    (r) => typeof total(r.scores?.home) === 'number' || typeof total(r.scores?.away) === 'number',
  );

  return [
    { key: 'optic', label: 'Optic', at: iso(optic[0]?.at), warn: 10, stale: 30 },
    ...WATCHED_BOOKS.map((b) => ({
      key: b.key,
      label: b.label,
      at: iso(bookAt.get(b.key)),
      detail: ids.length ? `${ids.length} fx` : undefined,
      // No fixtures in the window is not a fault — say so rather than alarm.
      idle: ids.length === 0,
      warn: b.warn,
      stale: b.stale,
    })),
    {
      key: 'live',
      label: 'Live',
      at: iso(live[0]?.updated_at),
      detail: live.length ? `${live.length}` : undefined,
      // No live fixtures at 4am is not a fault either.
      idle: live.length === 0,
      warn: 5,
      stale: 15,
    },
    {
      key: 'scores',
      label: 'Scores',
      at: iso(scored[0]?.updated_at),
      detail: live.length ? `${scored.length}/${live.length}` : undefined,
      idle: live.length === 0,
      warn: 10,
      stale: 30,
    },
  ];
}
