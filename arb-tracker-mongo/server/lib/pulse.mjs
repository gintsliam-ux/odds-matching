import { coll } from './mongo.mjs';
import { isApi } from './source.mjs';
import { apiFixtures, apiOddsForSport } from './sportApi.mjs';

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

/**
 * A dot for every brand we scrape, read from the `books` roster.
 *
 * It used to be two, hardcoded: TAB and Pinnacle. Betfair then stopped dead at
 * 14:37 one afternoon — back and lay, every sport, inside one scrape cycle —
 * and nothing on the bar moved, because Betfair had no dot. It was eight hours
 * before anyone noticed, and only by opening a fixture and finding a column
 * missing. That is precisely the question this bar exists to answer, so it now
 * answers it for all of them.
 *
 * Read rather than listed, so a book added upstream appears on its own and a
 * retired one leaves. `books` carries the canonical key, the display name and
 * the aliases the feed also spells it by.
 */
const BOOK_TTL_MS = 10 * 60_000;
let bookCache = { at: 0, rows: [] };

/**
 * How long a book may go quiet before the dot complains.
 *
 * Generous by default, because cadence varies a lot between them — TAB sits
 * three to six minutes behind on a quiet night while Pinnacle is inside one —
 * and a bar that cries wolf gets ignored, which costs more than the lag it was
 * reporting. The two that were hardcoded keep the tighter numbers they were
 * given; anything at twenty minutes is worth a glance and an hour is broken.
 */
const BOOK_THRESHOLDS = {
  tab: { warn: 15, stale: 45 },
  pinnacle: { warn: 10, stale: 30 },
};
const DEFAULT_THRESHOLD = { warn: 20, stale: 60 };

/**
 * The roster, with each book's alternative spellings folded onto its key.
 *
 * A lay book is NOT given a dot of its own. `betfair` and `betfair_lay` are one
 * scrape of one exchange — they stopped at the same second — so a second dot
 * would be a second alarm for one fault, on a bar whose whole value is that
 * every dot means something. The lay rows still count towards the exchange's
 * heartbeat.
 */
async function bookRoster() {
  if (Date.now() - bookCache.at < BOOK_TTL_MS && bookCache.rows.length) return bookCache.rows;
  let docs = [];
  try {
    docs = await (await coll('books'))
      .find({ active: { $ne: false } })
      .project({ _id: 0, book_key: 1, display_name: 1, aliases: 1, is_exchange: 1 })
      .toArray();
  } catch {
    // No roster is survivable: fall back to the two that were always watched.
    docs = [{ book_key: 'tab', display_name: 'TAB' }, { book_key: 'pinnacle', display_name: 'Pinnacle' }];
  }
  const byKey = new Map();
  for (const d of docs) {
    const key = String(d.book_key ?? '').trim();
    if (!key) continue;
    // A lay book folds into the back book it shares a scrape with.
    const base = key.replace(/_lay$/, '');
    const owner = byKey.get(base) ?? {
      key: base,
      label: null,
      keys: new Set(),
      ...(BOOK_THRESHOLDS[base] ?? DEFAULT_THRESHOLD),
    };
    owner.keys.add(key);
    for (const a of d.aliases ?? []) if (a) owner.keys.add(String(a));
    // The base book's own name wins over the lay variant's.
    if (key === base) owner.label = d.display_name ?? base;
    else if (!owner.label) owner.label = String(d.display_name ?? base).replace(/\s*Lay$/i, '');
    byKey.set(base, owner);
  }
  const rows = [...byKey.values()]
    .map((b) => ({ ...b, keys: [...b.keys], label: shortLabel(b.label ?? b.key) }))
    // Busiest first is meaningless here; alphabetical is at least stable, and a
    // dot that moves position between polls is one you cannot watch.
    .sort((a, b) => a.label.localeCompare(b.label));
  bookCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Names that fit a dot. "Betfair Exchange (AU)" and "TABtouch (RWWA)" are
 * right in a column header and too long for a bar of thirteen slots.
 */
function shortLabel(name) {
  return String(name)
    .replace(/\s*\((?:AU|RWWA|Australia)\)\s*/gi, '')
    .replace(/\s*Exchange\s*/i, ' ')
    .trim();
}

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
 * Both of the entries this could not reproduce now have a real timestamp on the
 * pivot: `fixture_updated_at` for the Optic dot, `score_updated_at` for Scores.
 * Neither is derived from price movement, which is what kept them out before --
 * a Scores dot aged off the quoting heartbeat would go green exactly when
 * scores had stopped arriving and prices had not.
 *
 * `score_updated_at` is null until the store starts stamping it, so the Scores
 * dot appears on its own once that lands rather than sitting grey until then.
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
  const now = Date.now();
  // Both already cached for the board, so the bar costs nothing extra.
  const [rows, liveRows, fixtures] = await Promise.all([
    Promise.all(PULSE_SPORTS.map((s) => apiOddsForSport(s).catch(() => []))).then((r) => r.flat()),
    /*
     * The live feed, for the live dot's own age.
     *
     * The closing drain cannot answer it. For a game in play the newest
     * `current_at` it holds is whenever that book last moved a PRE-MATCH
     * price, which read as 29 minutes old on a bar sitting next to a running
     * game. The live rows move constantly, and share their cache entry with
     * the board's own fixture build, so this costs nothing.
     */
    Promise.all(PULSE_SPORTS.map((s) => apiOddsForSport(s, { live: true }).catch(() => []))).then(
      (r) => r.flat(),
    ),
    Promise.all(PULSE_SPORTS.map((s) => apiFixtures(s).catch(() => []))).then((r) => r.flat()),
  ]);

  // The same window the Mongo path scopes to: the games the books should be
  // pricing right now. Scoping matters for the book dots -- unscoped, "when did
  // TAB last move" is answered by any one of thousands of rows and can never go
  // amber.
  const scope = new Set(
    fixtures
      .filter((f) => {
        const t = f.scheduled_start ? new Date(f.scheduled_start).getTime() : NaN;
        return Number.isFinite(t) && t >= now - SCOPE_BACK_MS && t <= now + SCOPE_FWD_MS;
      })
      .map((f) => f.fixture_id),
  );
  /*
   * In play as the surface now reports it, not "has an active price".
   *
   * The latter counted every fixture anyone was quoting -- 1,219 of them,
   * against the 37 actually being played -- so the number beside the dot
   * disagreed with the same dot locally by a factor of thirty.
   */
  const inPlay = new Set(fixtures.filter((f) => f.is_live).map((f) => f.fixture_id));

  const max = (pick) => {
    let best = null;
    for (const f of fixtures) {
      const v = pick(f);
      const t = v ? new Date(v).getTime() : null;
      if (t && Number.isFinite(t) && (!best || t > best)) best = t;
    }
    return best;
  };
  const opticAt = max((f) => f.updated_at);
  const scoreAt = max((f) => f.score_updated_at);

  const books = await bookRoster();
  // Every spelling a book answers to, pointing at the key its dot uses.
  const ownerOf = new Map();
  for (const b of books) for (const k of b.keys) ownerOf.set(k, b.key);

  const bookAt = new Map();
  for (const r of rows) {
    if (!scope.has(r.fixture_id)) continue;
    const at = r.current_at ? new Date(r.current_at).getTime() : null;
    if (!at) continue;
    const owner = ownerOf.get(r.sportsbook) ?? r.sportsbook;
    const prev = bookAt.get(owner);
    if (!prev || at > prev) bookAt.set(owner, at);
  }

  let liveAt = null;
  for (const r of liveRows) {
    const at = r.current_at ? new Date(r.current_at).getTime() : null;
    if (at && (!liveAt || at > liveAt)) liveAt = at;
  }
  const stamp = (ms) => (ms ? new Date(ms).toISOString() : null);

  // Same order the Mongo path returns, so the two bars read alike.
  const scored = fixtures.filter((f) => f.is_live && f.score_updated_at).length;

  return [
    { key: 'optic', label: 'Optic', at: stamp(opticAt), detail: scope.size ? `${scope.size} fx` : undefined, warn: 10, stale: 30 },
    ...books.map((b) => ({
      key: b.key,
      label: b.label,
      at: stamp(bookAt.get(b.key)),
      // No per-book detail now there are a dozen of them: it was the same
      // fixture count on every slot, which is width spent saying one thing
      // eleven times. The count lives on the Optic dot instead.
      detail: undefined,
      // No fixtures in the window is not a fault — say so rather than alarm.
      idle: scope.size === 0,
      warn: b.warn,
      stale: b.stale,
    })),
    {
      key: 'live',
      // "Live", as the Mongo path calls it. The same key labelled two different
      // things read as two different checks.
      label: 'Live',
      at: stamp(liveAt),
      detail: inPlay.size ? `${inPlay.size}` : undefined,
      // Nothing in play at 4am is not a fault.
      idle: inPlay.size === 0,
      warn: 5,
      stale: 15,
    },
    // Only once the store stamps score changes. Until then the column is null
    // for every fixture and a dot would be permanently grey, which reads as
    // broken rather than as not-yet-available.
    ...(scoreAt
      ? [
          {
            key: 'scores',
            label: 'Scores',
            at: stamp(scoreAt),
            detail: inPlay.size ? `${scored}/${inPlay.size}` : undefined,
            idle: inPlay.size === 0,
            warn: 10,
            stale: 30,
          },
        ]
      : []),
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
  const books = await bookRoster();
  const ownerOf = new Map();
  for (const b of books) for (const k of b.keys) ownerOf.set(k, b.key);

  const bookAt = new Map();
  if (ids.length) {
    const rows = await (await coll('odds'))
      .aggregate([
        { $match: { fixture_id: { $in: ids }, sportsbook: { $in: [...ownerOf.keys()] } } },
        { $group: { _id: '$sportsbook', at: { $max: '$current_at' } } },
      ])
      .toArray();
    for (const r of rows) {
      const owner = ownerOf.get(r._id) ?? r._id;
      const prev = bookAt.get(owner);
      if (!prev || new Date(r.at) > new Date(prev)) bookAt.set(owner, r.at);
    }
  }

  // A score only counts once it carries a number — an empty `scores` object is
  // the shape the feed writes before anything has been played.
  const total = (s) => (typeof s === 'number' ? s : s?.total);
  const scored = live.filter(
    (r) => typeof total(r.scores?.home) === 'number' || typeof total(r.scores?.away) === 'number',
  );

  return [
    { key: 'optic', label: 'Optic', at: iso(optic[0]?.at), detail: ids.length ? `${ids.length} fx` : undefined, warn: 10, stale: 30 },
    ...books.map((b) => ({
      key: b.key,
      label: b.label,
      at: iso(bookAt.get(b.key)),
      detail: undefined,
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
