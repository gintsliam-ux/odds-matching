import { coll } from './mongo.mjs';
import { fixtureMapping } from './fixtureMapping.mjs';
import { FIXTURE_PROJECTION, SKIP_SPORTS, toEvents } from './events.mjs';
import { isApi } from './source.mjs';
import { apiFixtures, apiOddsForFixture, apiOddsForSport, apiSports } from './sportApi.mjs';

/** BSON Dates on the wire are ISO strings. */
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/** How far back to load finished events (the UI drops finals after 24h). */
const WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Which of these fixtures actually carry odds.
 *
 * `fixtures.has_odds` looks like the right filter and is not: in this database
 * it is a *live* flag, cleared once an event settles. Yesterday's games read
 * `has_odds: false` while still holding hundreds of odds rows — gating on it
 * costs the board ~570 recently-finished events and makes past-date browsing
 * come back completely empty.
 *
 * So ask the odds collection instead. A `distinct` scoped to a known id list
 * rides the `{fixture_id, …}` index and runs in a few seconds for a full board,
 * which the response cache absorbs.
 */
async function keepPriceable(rows) {
  if (rows.length === 0) return rows;
  // A set flag is trustworthy — it's only the cleared one that lies — so those
  // fixtures need no lookup, which takes roughly a third off the id list.
  const unknown = rows.filter((r) => r.has_odds !== true);
  if (unknown.length === 0) return rows;

  const priced = new Set(
    await (await coll('odds')).distinct('fixture_id', {
      fixture_id: { $in: unknown.map((r) => r.fixture_id) },
    }),
  );
  return rows.filter((r) => r.has_odds === true || priced.has(r.fixture_id));
}

/**
 * Fixtures in a time window that have odds. `until` bounds a specific day
 * (past-date browsing); omit it for the open-ended live window.
 *
 * Note the second pass: multi-day events (golf tournaments) are still running
 * over the window even though they started before it, so they're picked up by
 * `end_date`. Scoped to golf so it stays a cheap partition scan.
 */
async function fixturesInWindow(since, until) {
  const fixtures = await coll('fixtures');
  const range = until ? { $gte: since, $lt: until } : { $gte: since };

  const [main, golf] = await Promise.all([
    fixtures
      .find({ scheduled_start: range })
      .project(FIXTURE_PROJECTION)
      .sort({ scheduled_start: 1 })
      .toArray(),
    fixtures
      .find({
        sport: 'golf',
        end_date: { $gte: since },
        ...(until ? { scheduled_start: { $lt: until } } : {}),
      })
      .project(FIXTURE_PROJECTION)
      .toArray(),
  ]);

  const byId = new Map();
  for (const r of [...main, ...golf]) byId.set(r.fixture_id, r);
  return keepPriceable([...byId.values()]);
}

/**
 * Every priceable fixture in the live window, normalised for the board.
 *
 * On the API source there is no single "all sports" call, so each sport is
 * fetched and merged. They go out together because the surface is remote and
 * the round trips dominate.
 */
export async function allEvents() {
  if (isApi) {
    const sports = (await apiSports()).filter((s) => !SKIP_SPORTS.has(s));
    const failures = [];
    const perSport = await Promise.all(
      sports.map((s) =>
        apiFixtures(s).catch((err) => {
          // One sport failing is survivable; silence is not. Swallowing these
          // turned a transient upstream blip into an empty board that then sat
          // in the CDN for five minutes reading "No events match these filters".
          failures.push(`${s}: ${err instanceof Error ? err.message : err}`);
          return [];
        }),
      ),
    );
    if (failures.length) {
      console.warn(`[api] ${failures.length}/${sports.length} sports failed:`, failures.join(' | '));
    }
    // Every sport failing is an outage, not an empty schedule. Throwing lets
    // the caller return an error the client can retry past, instead of a
    // cacheable, plausible-looking empty list.
    if (failures.length === sports.length) {
      throw new Error(`odds surface unreachable (${failures[0] ?? 'no detail'})`);
    }
    // Window it the same way the Mongo path does. The surface publishes about
    // a week, which is 1,040 events and half a megabyte of JSON for a board
    // that only ever shows a couple of days — 297 events and 0.15 MB once
    // bounded, and correspondingly less for the browser to render.
    const since = Date.now() - WINDOW_MS;
    const recent = perSport
      .flat()
      .filter((f) => {
        const t = f.scheduled_start ? new Date(f.scheduled_start).getTime() : NaN;
        return !Number.isFinite(t) || t >= since;
      });
    return toEvents(recent);
  }
  return toEvents(await fixturesInWindow(new Date(Date.now() - WINDOW_MS)));
}

/** Fixtures for one local calendar day (YYYY-MM-DD), for browsing past dates. */
export async function eventsForDay(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(start.getTime())) return [];
  if (isApi) {
    // The surface publishes a rolling window only; a day inside it can be
    // filtered out of the board, and one outside it simply is not available.
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const all = await allEvents();
    return all.filter((e) => {
      const t = new Date(e.startsAt).getTime();
      return t >= start.getTime() && t < end.getTime();
    });
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return toEvents(await fixturesInWindow(start, end));
}

/**
 * One fixture by id, for a link that names an event the board isn't holding —
 * anything older than the rolling window, or filtered out of it. A URL is a
 * promise that it opens what it says, so the filters (and the odds check) are
 * deliberately skipped here.
 */
export async function eventById(fixtureId) {
  if (!fixtureId) return null;
  if (isApi) {
    // The API has no by-id lookup, so find it among the fixtures it lists.
    const all = await allEvents();
    return all.find((e) => e.id === fixtureId) ?? null;
  }
  const row = await (await coll('fixtures'))
    .findOne({ fixture_id: fixtureId }, { projection: FIXTURE_PROJECTION });
  if (!row) return null;
  return (await toEvents([row]))[0] ?? null;
}

/* -------------------------------------------------------------- search */

export const SEARCH_MIN_CHARS = 2;
/** Results kept per pass, after the odds filter has thinned them. */
const SEARCH_LIMIT = 60;
/**
 * Rows pulled per pass before that filter. Priceable fixtures are roughly half
 * the archive, so over-fetching here keeps a full page of hits on the far side.
 */
const SEARCH_FETCH = 180;
/** Fixtures older than this are the "past" half of the split. */
const SEARCH_PAST_MS = 24 * 60 * 60 * 1000;

/** Escape a user term so it can't inject regex syntax into the query. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Golf outright fields: the player is in the odds selections, not the fixture.
 *
 * Scoped to golf's fixture ids first. A bare regex over `odds.selection` is a
 * 43-second scan of 6.6M rows; handing it a few hundred ids to check makes it an
 * index lookup and half a second, for the same answer — outright markets only
 * ever hang off golf fixtures.
 */
async function searchOutrights(re) {
  const fixtures = await coll('fixtures');
  const golf = await fixtures
    .find({ sport: 'golf' })
    .project({ _id: 0, fixture_id: 1 })
    .toArray();
  if (golf.length === 0) return [];

  const ids = await (await coll('odds')).distinct('fixture_id', {
    fixture_id: { $in: golf.map((g) => g.fixture_id) },
    market_id: 'outright',
    selection: re,
  });
  if (ids.length === 0) return [];

  return fixtures
    .find({ fixture_id: { $in: ids.slice(0, 40) } })
    .project(FIXTURE_PROJECTION)
    .toArray();
}

/**
 * Team/player search over the whole fixtures archive — deliberately NOT scoped
 * to the board's sport/league/date filters, so "arsenal" finds Arsenal whatever
 * the rail is currently showing.
 *
 * Three passes, merged: upcoming matches (soonest first), past matches (most
 * recent first) and — for outright fields, where the fixture row carries no
 * competitor names at all — the golf tournaments whose `outright` selections
 * name the player. Each pass is capped.
 */
export async function searchEvents(query) {
  const term = String(query ?? '').trim();
  if (term.length < SEARCH_MIN_CHARS) return [];
  if (isApi) {
    // No search endpoint upstream; filter the window the surface publishes.
    const re = new RegExp(escapeRe(term), 'i');
    const all = await allEvents();
    return all.filter((e) => re.test(`${e.name} ${e.home} ${e.away}`)).slice(0, SEARCH_LIMIT);
  }
  const re = new RegExp(escapeRe(term), 'i');
  const or = [{ home_team: re }, { away_team: re }, { event_name: re }];
  const cutoff = new Date(Date.now() - SEARCH_PAST_MS);
  const fixtures = await coll('fixtures');

  const pass = (extra, dir) =>
    fixtures
      .find({ $or: or, scheduled_start: extra })
      .project(FIXTURE_PROJECTION)
      .sort({ scheduled_start: dir })
      .limit(SEARCH_FETCH)
      .toArray()
      .then(keepPriceable)
      .then((rows) => rows.slice(0, SEARCH_LIMIT));

  const [upcoming, past, outrights] = await Promise.all([
    pass({ $gte: cutoff }, 1),
    pass({ $lt: cutoff }, -1),
    searchOutrights(re).catch(() => []),
  ]);

  const byId = new Map();
  for (const r of [...upcoming, ...past, ...outrights]) byId.set(r.fixture_id, r);
  return toEvents([...byId.values()]);
}

/* ------------------------------------------------------------- details */

/**
 * Everything the Details tab shows: the fixture fields the board itself has no
 * use for (venue, season, provenance, the full timestamp trail) plus a summary
 * of what we actually hold in `odds` for this event.
 *
 * Fetched only when that tab is opened. These fields are dead weight on the
 * board payload — 1800 events do not need a venue string each — so they are
 * deliberately not part of the `SportEvent` shape.
 */
/**
 * The Details panel, assembled without `gutsys_sport`.
 *
 * A deployed instance has no `fixtures` document and cannot aggregate `odds`
 * (10.7 GB), so this used to answer "unavailable" outright. That threw away the
 * part of the panel that matters most and IS reachable: the swiftbet/mybet
 * mapping block, which lives in the mirrored `event_mapping` and
 * `competition_mapping`.
 *
 * So the three sections come from three places instead of one:
 *   league / times / teams  the board row, which the pivot already carries
 *   mapping                 the Atlas mirror, via fixtureMapping
 *   odds coverage           counted off the rows the event page just fetched,
 *                           rather than aggregated over the whole collection
 *
 * The fields with no source — venue, broadcast, tier, season, the odds open and
 * close stamps — come back null rather than absent, so the panel renders its
 * normal empty state for them instead of looking broken.
 */
async function apiEventDetails(fixtureId, sport) {
  if (!sport) return null;
  const [fixtures, rows] = await Promise.all([
    apiFixtures(sport).catch(() => []),
    apiOddsForFixture(fixtureId, sport).catch(() => []),
  ]);
  const f = fixtures.find((x) => x.fixture_id === fixtureId);
  if (!f && rows.length === 0) return null;

  const mapping = await fixtureMapping(fixtureId, f?.optic_league).catch(() => null);

  const books = new Set();
  const markets = new Set();
  let firstSeen = null;
  let lastSeen = null;
  for (const r of rows) {
    if (r.sportsbook) books.add(r.sportsbook);
    if (r.market_id) markets.add(r.market_id);
    const o = r.open_at ? new Date(r.open_at).getTime() : null;
    const c = r.current_at ? new Date(r.current_at).getTime() : null;
    if (o && (!firstSeen || o < firstSeen)) firstSeen = o;
    if (c && (!lastSeen || c > lastSeen)) lastSeen = c;
  }

  return {
    fixtureId,
    venue: null,
    location: null,
    country: f?.category ?? null,
    season: null,
    seasonType: null,
    tier: null,
    broadcast: null,
    status: f?.status ?? null,
    opticStatus: null,
    isLive: !!f?.is_live,
    source: 'optic',
    category: f?.category ?? null,
    tournament: f?.tournament ?? null,
    tournamentStage: null,
    opticLeague: f?.optic_league ?? null,
    opticLeagueId: null,
    currentRound: null,
    hasOdds: rows.length > 0,
    hasSp: false,
    competitors: [
      f?.home_team ? { name: f.home_team, side: 'home', id: null, country: null } : null,
      f?.away_team ? { name: f.away_team, side: 'away', id: null, country: null } : null,
    ].filter(Boolean),
    times: {
      scheduledStart: f?.scheduled_start ?? null,
      actualStart: null,
      endDate: null,
      oddsOpenAt: firstSeen ? new Date(firstSeen).toISOString() : null,
      oddsCloseAt: null,
      settledAt: null,
      createdAt: null,
      updatedAt: null,
    },
    mapping,
    coverage: {
      rows: rows.length,
      // This path serves pre-match prices only, so there is nothing in-play to
      // count — see the closing-pivot note in sportApi.explode.
      liveRows: 0,
      books: [...books].sort(),
      markets: [...markets].sort(),
      firstSeen: firstSeen ? new Date(firstSeen).toISOString() : null,
      lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    },
  };
}

export async function eventDetails(fixtureId, sport) {
  if (!fixtureId) return null;
  // The raw fixture document is Mongo-only, but most of what this panel shows
  // is reachable without it — see apiEventDetails.
  if (isApi) return apiEventDetails(fixtureId, sport);
  const f = await (await coll('fixtures')).findOne({ fixture_id: fixtureId });
  if (!f) return null;
  const mapping = isApi ? null : await fixtureMapping(fixtureId, f.optic_league).catch(() => null);

  // One pass over the fixture's odds rows for the coverage summary. Same
  // indexed read the market grid does, so it costs about the same.
  const [cov] = await (await coll('odds'))
    .aggregate([
      { $match: { fixture_id: fixtureId } },
      {
        $group: {
          _id: null,
          rows: { $sum: 1 },
          books: { $addToSet: '$sportsbook' },
          markets: { $addToSet: '$market_id' },
          firstSeen: { $min: '$open_at' },
          lastSeen: { $max: '$current_at' },
          live: { $sum: { $cond: ['$is_live', 1, 0] } },
        },
      },
    ])
    .toArray();

  return {
    fixtureId: f.fixture_id,
    venue: f.venue ?? null,
    location: f.location ?? null,
    country: f.country ?? null,
    season: f.season ?? null,
    seasonType: f.season_type ?? null,
    tier: f.tier ?? null,
    broadcast: f.broadcast ?? null,
    status: f.status ?? null,
    opticStatus: f.optic_status ?? null,
    isLive: !!f.is_live,
    source: f.source ?? null,
    category: f.category ?? null,
    tournament: f.tournament ?? null,
    tournamentStage: f.tournament_stage ?? null,
    opticLeague: f.optic_league ?? null,
    opticLeagueId: f.optic_league_id ?? null,
    currentRound: f.current_round ?? null,
    hasOdds: !!f.has_odds,
    hasSp: !!f.has_sp,
    competitors: (f.competitors ?? []).map((c) => ({
      name: c.name ?? null,
      side: c.side ?? null,
      id: c.id ?? null,
      country: c.country ?? null,
    })),
    times: {
      scheduledStart: iso(f.scheduled_start),
      actualStart: iso(f.actual_start),
      endDate: iso(f.end_date),
      oddsOpenAt: iso(f.odds_open_at),
      oddsCloseAt: iso(f.odds_close_at),
      settledAt: iso(f.settled_at),
      createdAt: iso(f.created_at),
      updatedAt: iso(f.updated_at),
    },
    mapping,
    coverage: {
      rows: cov?.rows ?? 0,
      liveRows: cov?.live ?? 0,
      books: (cov?.books ?? []).sort(),
      markets: (cov?.markets ?? []).sort(),
      firstSeen: iso(cov?.firstSeen),
      lastSeen: iso(cov?.lastSeen),
    },
  };
}

/* ---------------------------------------------------------------- odds */

/** Only the odds fields the market grid reads. */
const ODDS_PROJECTION = {
  _id: 0,
  market_id: 1, market_name: 1, selection: 1, normalized_selection: 1, line: 1,
  line_group: 1, pair_key: 1, outcome_no: 1, is_main: 1, sportsbook: 1, is_lay: 1,
  current_price: 1, open_price: 1, status: 1, flucs: 1, open_at: 1,
  price_6h: 1, price_3h: 1, price_1h: 1, price_30m: 1, price_10m: 1,
  close_price: 1, closed_at: 1, current_at: 1, daily_prices: 1,
};

/** BSON Dates inside an odds row become ISO strings for the wire. */
function serializeOdds(r) {
  return {
    ...r,
    open_at: iso(r.open_at),
    current_at: iso(r.current_at),
    closed_at: iso(r.closed_at),
    flucs: (r.flucs ?? []).map((f) => ({ p: f.p, t: iso(f.t) })),
  };
}

/**
 * Alias sportsbook key -> canonical key, from the `books` reference table.
 *
 * The odds collection carries both spellings: `betfair_exchange_australia`
 * alongside `betfair`, `ladbrokes_australia` alongside `ladbrokes`. The UI's
 * columns are keyed on the canonical id, so an alias-keyed row matches no
 * column and its price silently vanishes from the grid. Fold them here, at the
 * edge, so nothing downstream has to know these spellings exist.
 */
let bookAliasCache = { at: 0, map: new Map() };
const ALIAS_TTL_MS = 10 * 60 * 1000;

/** Alias keys are compared loosely — the `books` table has at least one typo
 *  (`ladbrokes_australia_`) that would otherwise never match a real row. */
const aliasKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

async function bookAliases() {
  if (Date.now() - bookAliasCache.at < ALIAS_TTL_MS) return bookAliasCache.map;
  const map = new Map();
  try {
    for (const b of await (await coll('books')).find({}).toArray()) {
      if (!b.book_key) continue;
      for (const a of b.aliases ?? []) {
        const k = aliasKey(a);
        // Never let an alias shadow a book key that stands on its own.
        if (k && k !== aliasKey(b.book_key)) map.set(k, b.book_key);
      }
    }
  } catch {
    // No books table is survivable: rows just keep their original keys.
  }
  bookAliasCache = { at: Date.now(), map };
  return map;
}

/**
 * Fold alias-keyed rows onto their canonical book.
 *
 * A fixture can carry both spellings for the same selection, so folding can
 * collide. Keep the freshest row of each collision — the alias feed is
 * sometimes the only one still being written, and sometimes the stale leftover,
 * so recency decides rather than which spelling it happens to use.
 */
function foldBookAliases(rows, aliases) {
  if (aliases.size === 0) return rows;
  const at = (r) => Date.parse(r.closed_at ?? r.current_at ?? r.open_at ?? 0) || 0;
  const best = new Map();
  const out = [];
  for (const r of rows) {
    const canonical = aliases.get(aliasKey(r.sportsbook));
    if (!canonical) {
      out.push(r);
      continue;
    }
    const folded = { ...r, sportsbook: canonical };
    const key = [
      folded.market_id, folded.selection, folded.line, folded.sportsbook, folded.is_lay,
    ].join('|');
    const prev = best.get(key);
    if (!prev || at(folded) > at(prev)) best.set(key, folded);
  }
  // A folded row must also not duplicate a canonical row already present.
  const seen = new Set(
    out.map((r) => [r.market_id, r.selection, r.line, r.sportsbook, r.is_lay].join('|')),
  );
  for (const [key, r] of best) if (!seen.has(key)) out.push(r);
  return out;
}

/**
 * The odds rows for a single fixture. In-play rows (`is_live: true`) are
 * excluded — we price off pregame/close odds only (the live capture covers
 * sports it shouldn't and its rows lack `outcome_no`), so they're filtered at
 * the source. Rides the `{fixture_id, is_live, status}` index.
 */
export async function oddsForFixture(fixtureId, sport) {
  if (!fixtureId) return [];
  if (isApi) return apiOddsForFixture(fixtureId, sport);
  const [rows, aliases] = await Promise.all([
    (await coll('odds'))
      .find({ fixture_id: fixtureId, is_live: false })
      .project(ODDS_PROJECTION)
      .sort({ id: 1 })
      .toArray(),
    bookAliases(),
  ]);
  return foldBookAliases(rows.map(serializeOdds), aliases);
}

/**
 * Best moneyline price per side for a batch of fixtures, for the scoreboard
 * ticker. Sides come from `outcome_no` (1 = home, 2 = away) — no name matching.
 */
export async function h2hPrices(fixtureIds) {
  const out = {};
  const ids = [...new Set(fixtureIds ?? [])].filter(Boolean);
  if (ids.length === 0) return out;
  if (isApi) {
    const wanted = new Set(ids);
    const sports = (await apiSports()).filter((s) => !SKIP_SPORTS.has(s));
    const perSport = await Promise.all(sports.map((s) => apiOddsForSport(s).catch(() => [])));
    for (const r of perSport.flat()) {
      if (r.market_id !== 'moneyline' || r.is_lay || !wanted.has(r.fixture_id)) continue;
      const price = r.current_price ?? r.open_price;
      if (price == null) continue;
      const cur = out[r.fixture_id] ?? { home: null, away: null };
      if (r.outcome_no === 1) cur.home = Math.max(cur.home ?? 0, price);
      else if (r.outcome_no === 2) cur.away = Math.max(cur.away ?? 0, price);
      out[r.fixture_id] = cur;
    }
    return out;
  }

  const odds = await coll('odds');
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await odds
      .find({
        market_id: 'moneyline',
        is_lay: false,
        is_live: false,
        fixture_id: { $in: ids.slice(i, i + 200) },
      })
      .project({ _id: 0, fixture_id: 1, outcome_no: 1, current_price: 1, open_price: 1 })
      .toArray();
    for (const r of rows) {
      const price = r.current_price ?? r.open_price;
      if (price == null) continue;
      const cur = out[r.fixture_id] ?? { home: null, away: null };
      if (r.outcome_no === 1) cur.home = Math.max(cur.home ?? 0, price);
      else if (r.outcome_no === 2) cur.away = Math.max(cur.away ?? 0, price);
      out[r.fixture_id] = cur;
    }
  }
  return out;
}
