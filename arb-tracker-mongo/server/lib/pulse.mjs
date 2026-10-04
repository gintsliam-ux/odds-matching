import { coll } from './mongo.mjs';

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

export async function fetchPulse() {
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
