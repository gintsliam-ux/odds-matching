import { cached } from './cache.mjs';
import { brandOddsFor } from './brandOdds.mjs';
import { coll, mirrorConfigured } from './mongo.mjs';
import { fixtureMapping } from './fixtureMapping.mjs';
import {
  expireStaleLive, FIXTURE_PROJECTION, LIVE, SKIP_SPORTS, toEvents,
} from './events.mjs';
import { isApi } from './source.mjs';
import { apiFixtureById, apiFixtures, apiOddsForFixture, apiOddsForSport, apiSports, apiFixturesForDay, boardWindow } from './sportApi.mjs';

/** BSON Dates on the wire are ISO strings. */
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/** How far back to load finished events (the UI drops finals after 24h). */
/*
 * Three days back, matching the date picker's own floor.
 *
 * This was 48 hours while the picker was unbounded, so choosing three days ago
 * returned an empty rail: the drain fetched the day and this cutoff then
 * dropped it. The two numbers have to agree — the board's back edge, the
 * surface drain's back edge and the earliest date the picker will accept are
 * one decision, not three.
 */
const WINDOW_MS = 72 * 60 * 60 * 1000;

/** How far forward the mirrored schedule is read — matches WINDOW_FWD_DAYS, so
 *  the schedule half of the board covers the same span the odds half does. */
const SCHEDULE_FWD_MS = 7 * 24 * 60 * 60 * 1000;
/** And how far back: enough that a game which has just kicked off does not
 *  vanish mid-refresh, not enough to carry finished fixtures nobody priced. */
const SCHEDULE_BACK_MS = 2 * 60 * 60 * 1000;

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
    /*
     * A materially incomplete board is an outage, not an empty schedule.
     *
     * This used to throw only when EVERY sport failed, so fifteen of sixteen
     * failing produced a one-sport board -- which `cached` then held for 45s
     * and served. The client replaces its list with whatever arrives, so the
     * rail lost soccer, or basketball, or everything but volleyball, and got
     * it back on the next poll from a different instance.
     *
     * Throwing is strictly better than answering partially: the board poll
     * swallows errors, so the rail keeps the events it already has, and a warm
     * `cached('board')` entry keeps serving the last complete board rather
     * than being overwritten by a broken one.
     *
     * A quarter is the line because a failure now means the sport had no
     * cached fixtures to fall back on either -- cachedDrain serves stale on
     * failure -- so this only fires on a cold instance meeting a real outage.
     */
    if (failures.length > Math.max(1, Math.floor(sports.length / 4))) {
      throw new Error(
        `odds surface degraded — ${failures.length}/${sports.length} sports failed (${failures[0] ?? 'no detail'})`,
      );
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
    return toEvents([...recent, ...await scheduleOnly(recent)]);
  }
  return toEvents(await fixturesInWindow(new Date(Date.now() - WINDOW_MS)));
}

/**
 * The fixtures that are ON but not PRICED, from the mirrored schedule.
 *
 * Everything the deployed board knows comes from an odds query, so a fixture
 * nobody has quoted yet cannot be in it. That hid 766 upcoming games: 47 NHL,
 * 58 NCAAF, 31 Premier League, 26 NBA. Wednesday's NHL slate was in the
 * schedule with the right teams and times and had no odds row anywhere, so
 * there was no odds query that could have returned it.
 *
 * These rows carry no prices and are not pretending to — the board renders a
 * fixture with an empty price pair, which is the honest answer: the game is on,
 * nobody is quoting it yet. A schedule we hold is strictly better than a gap.
 *
 * Limited to fixtures SwiftBet or MyBet has an event for (see bookableIds). An
 * unpriced game is only worth a row if it is one we could be taking bets on;
 * the rest of the schedule's tail is noise on a board about prices.
 *
 * Additive and best-effort. The odds-derived row always wins where both exist,
 * because only it carries live scores and the clock, and a mirror that is
 * missing or mid-sync leaves the board exactly as it was.
 */
/**
 * Of these fixtures, the ones SwiftBet or MyBet actually has an event for.
 *
 * An unpriced fixture is only worth a row if it is a game we could be taking
 * bets on. Without this the schedule brings its whole tail with it: 796
 * unpriced upcoming fixtures, most of them Ivy League NCAAF, darts Super
 * Series qualifiers and third-tier volleyball that no book here lists. Gated
 * on a book event it is 224 — including all 16 of Wednesday's NHL games.
 *
 * NOTE a row in `event_mapping` does NOT mean the book has the event. The
 * matcher writes a row for every fixture it ATTEMPTS and records a miss as
 * `confidence: 0, gutsy_event_id: null` — which is why 70% of swift's rows and
 * 58% of mybet's are misses, and why "is it mapped" looked like it was true of
 * all 2,016 upcoming fixtures. The link is the `gutsy_event_id`.
 */
async function bookableIds(ids) {
  const out = new Set();
  if (ids.length === 0) return out;
  const em = await coll('eventMapping');
  for (let i = 0; i < ids.length; i += 1000) {
    const hit = await em.distinct('optic_fixture_id', {
      provider: { $in: ['swift', 'mybet'] },
      gutsy_event_id: { $ne: null },
      optic_fixture_id: { $in: ids.slice(i, i + 1000) },
    });
    for (const x of hit) out.add(x);
  }
  return out;
}

/**
 * How long a fixture nobody is quoting may still claim to be in play.
 *
 * The live state on these rows comes from `fixtures`, where it goes stale: 26
 * of the 41 rows flagged live had started more than twelve hours earlier, a La
 * Liga match 44 hours gone among them. The mirror is only rebuilt hourly on top
 * of that, and because nobody is pricing these fixtures there is no second
 * opinion to check the flag against. The board already learned this from stale
 * live PRICES, where honouring them took it from 11 live events to 554.
 *
 * So the clock is the arbiter, per sport, because "too long to still be on" is
 * a different number for different games. Cricket really does run for days -- a
 * Ranji match 29 hours in and a Test 72 hours in are both genuinely in progress
 * -- and golf tournaments likewise, so those keep a long allowance. Everything
 * else is a single session: generous at six hours, and past it the La Liga
 * match from the day before yesterday stops claiming to be live.
 */

async function scheduleOnly(have) {
  if (!mirrorConfigured) return [];
  try {
    const seen = new Set(have.map((f) => f.fixture_id));
    /*
     * Deliberately NOT fixturesInWindow. That helper ends in keepPriceable,
     * which is both unavailable here -- it reads `odds`, which the mirror does
     * not carry -- and the exact opposite of what this wants. Its job is to
     * drop fixtures with no prices; this function exists to find them.
     */
    const rows = await (await coll('fixtures'))
      .find({
        /*
         * Forward only, bar a short grace. A fixture with no price and no book
         * event is worth a row because it is a game you could be taking bets
         * on; once it has started that is no longer true, and a FINISHED one
         * with no prices has nothing to show at all — no result worth trusting
         * from an hourly mirror and no price history to read.
         *
         * It also keeps the work small: reaching 48h back made this consider
         * ~3,500 schedule rows and ask Atlas about every one of them, against
         * ~800 looking forward.
         */
        scheduled_start: {
          $gte: new Date(Date.now() - SCHEDULE_BACK_MS),
          $lte: new Date(Date.now() + SCHEDULE_FWD_MS),
        },
      })
      .project(FIXTURE_PROJECTION)
      .sort({ scheduled_start: 1 })
      .toArray();
    const candidates = rows.filter(
      (f) => f.fixture_id && !seen.has(f.fixture_id) && !SKIP_SPORTS.has(f.sport),
    );
    const linked = await bookableIds(candidates.map((f) => f.fixture_id));
    /*
     * A TAB-sourced fixture skips the gate, because the gate's premise does not
     * hold for it: it exists BECAUSE TAB priced it. The `TAB`-prefixed ids come
     * from the TAB scraper rather than OPTIC, so the event matcher — which
     * works off OPTIC fixtures — has never seen them and never will, and all
     * nine of them had zero event_mapping rows.
     *
     * Which is how the whole Rugby League World Cup came to be invisible: TAB
     * has moneyline, spread, total and 1h_spread on every game, OPTIC carries
     * no rugby league at all, and the one store that had the prices was the one
     * a deployed instance cannot read. They looked unpriced from here and were
     * dropped as noise.
     */
    return candidates
      .filter((f) => linked.has(f.fixture_id) || f.source === 'tab')
      .map(expireStaleLive);
  } catch {
    // The mirror is a bonus here, never a dependency.
    return [];
  }
}

/**
 * How long a computed board stays good for, and the ONE cache it lives in.
 *
 * Everything that needs the board goes through here -- the board route, the
 * single-event lookup, the day view, search. They used to call allEvents()
 * directly, so opening an event re-derived all sixteen sports' worth of
 * fixtures from scratch: 2.6s on every click through to a match, paid again
 * for every event id because the per-event cache key could not help.
 */
export const BOARD_TTL_MS = 45_000;
export const cachedBoard = () => cached('board', BOARD_TTL_MS, allEvents);

/** Fixtures for one local calendar day (YYYY-MM-DD), for browsing past dates. */
export async function eventsForDay(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(start.getTime())) return [];
  if (isApi) {
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const w = boardWindow();
    const inBoard = dateStr >= w.date_from && dateStr <= w.date_to;
    /*
     * A day the board already holds is filtered out of it, which is free.
     *
     * A day OUTSIDE it used to be filtered out of it too, and so came back
     * empty with nothing to say why: the picker let you choose March and the
     * rail went blank. The board reaches three days back and seven forward
     * because that is what it is for; the picker is allowed past both ends, so
     * a day past them is asked for directly — one request per sport for that
     * single date, cached. Deliberately not how the board is built: fifteen
     * requests is fine for a day somebody chose and not fine on every load.
     */
    if (inBoard) {
      const all = await cachedBoard();
      return all.filter((e) => {
        const t = new Date(e.startsAt).getTime();
        return t >= start.getTime() && t < end.getTime();
      });
    }
    const sports = (await apiSports()).filter((sp) => !SKIP_SPORTS.has(sp));
    const perSport = await Promise.all(
      sports.map((sp) => apiFixturesForDay(sp, dateStr).catch(() => [])),
    );
    // Bounded to the day asked for: a single-date request can still answer with
    // a fixture either side of it.
    const onDay = perSport.flat().filter((f) => {
      const t = f.scheduled_start ? new Date(f.scheduled_start).getTime() : NaN;
      return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
    });
    return toEvents(onDay);
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
    const all = await cachedBoard();
    const onBoard = all.find((e) => e.id === fixtureId);
    if (onBoard) return onBoard;
    // Off the board, which for anything more than two days old is every link
    // ever shared. The id names the day it happened on, so ask for that day
    // rather than give up — this is exactly the case the function exists for.
    // The surface's own sport slugs, not the board's display labels. Handing it
    // `e.sport` ("Basketball") instead of "basketball" found the fixture — the
    // surface is forgiving about case — but stamped the label onto the fixture
    // as its sport, so the page then asked for odds with `sport=Basketball` and
    // got nothing back.
    const row = await apiFixtureById(fixtureId, await apiSports().catch(() => []));
    return row ? (await toEvents([row]))[0] ?? null : null;
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
    const all = await cachedBoard();
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
/**
 * The raw fixture document from whichever Mongo this instance can reach.
 *
 * On the tailnet that is the NAS; deployed it is the mirror, which carries a
 * rolling -3/+10 day window of `fixtures`. Null when neither has it, which is
 * the honest answer for anything older than the mirrored window.
 */
async function mirrorFixtureDoc(fixtureId) {
  if (!fixtureId || (isApi && !mirrorConfigured)) return null;
  try {
    return await (await coll('fixtures')).findOne({ fixture_id: fixtureId });
  } catch {
    return null;
  }
}

async function apiEventDetails(fixtureId, sport) {
  if (!sport) return null;
  const [fixtures, rows, doc] = await Promise.all([
    apiFixtures(sport).catch(() => []),
    apiOddsForFixture(fixtureId, sport).catch(() => []),
    /*
     * The mirrored schedule row, which is strictly richer than anything this
     * function can assemble from an odds pivot -- venue, season, broadcast,
     * tier, round, the real created/updated stamps.
     *
     * It is also the only way this panel can describe a fixture nobody has
     * priced. Keyed off the odds-derived list alone, a schedule-only fixture
     * failed both tests below and the whole panel came back null, so opening
     * Wednesday's NHL games showed no details at all.
     */
    mirrorFixtureDoc(fixtureId),
  ]);
  const f = fixtures.find((x) => x.fixture_id === fixtureId) ?? doc;
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
    venue: doc?.venue ?? null,
    location: doc?.location ?? null,
    country: doc?.country ?? f?.category ?? null,
    season: doc?.season ?? null,
    seasonType: doc?.season_type ?? null,
    tier: doc?.tier ?? null,
    broadcast: doc?.broadcast ?? null,
    status: f?.status ?? null,
    opticStatus: doc?.optic_status ?? null,
    isLive: !!f?.is_live,
    source: 'optic',
    category: f?.category ?? null,
    tournament: f?.tournament ?? null,
    tournamentStage: doc?.tournament_stage ?? null,
    opticLeague: f?.optic_league ?? null,
    opticLeagueId: doc?.optic_league_id ?? null,
    currentRound: doc?.current_round ?? null,
    hasOdds: rows.length > 0,
    hasSp: !!doc?.has_sp,
    competitors: (doc?.competitors?.length
      ? doc.competitors.map((c) => ({
        name: c.name ?? null, side: c.side ?? null, id: c.id ?? null, country: c.country ?? null,
      }))
      : [
        f?.home_team ? { name: f.home_team, side: 'home', id: null, country: null } : null,
        f?.away_team ? { name: f.away_team, side: 'away', id: null, country: null } : null,
      ].filter(Boolean)),
    times: {
      scheduledStart: iso(doc?.scheduled_start) ?? f?.scheduled_start ?? null,
      actualStart: iso(doc?.actual_start) ?? f?.actual_start ?? null,
      endDate: iso(doc?.end_date),
      oddsOpenAt: iso(doc?.odds_open_at) ?? (firstSeen ? new Date(firstSeen).toISOString() : null),
      oddsCloseAt: iso(doc?.odds_close_at),
      settledAt: iso(doc?.settled_at),
      createdAt: iso(doc?.created_at),
      updatedAt: iso(doc?.updated_at),
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
/**
 * TAB's own prices for a TAB-sourced fixture, from the mirror.
 *
 * These fixtures exist only because the TAB scraper wrote them — OPTIC carries
 * no rugby league at all — so the odds surface has nothing for them and the
 * prices live in `odds`, which a deployed instance cannot reach. A small
 * mirrored slice closes that: ~400 rows for the nine World Cup games.
 *
 * Empty for every OPTIC fixture, because only TAB-sourced fixtures' rows are
 * copied. So this cannot shadow or double up a price the surface already
 * serves, including TAB's own price on an OPTIC fixture.
 */
async function tabOddsFor(fixtureId) {
  if (!mirrorConfigured || !fixtureId) return [];
  try {
    return await (await coll('tabOdds'))
      .find({ fixture_id: fixtureId, is_live: false })
      .project(ODDS_PROJECTION)
      .sort({ id: 1 })
      .toArray();
  } catch {
    return [];
  }
}

export async function oddsForFixture(fixtureId, sport) {
  if (!fixtureId) return [];
  /*
   * Our own two brands are appended to whatever the field is, on every path.
   *
   * They are not on the odds surface — they are OUR books — so they come from
   * their own stores through `event_mapping`. Fetched alongside rather than
   * after, because the page waits on this call and the brand read is two
   * indexed lookups.
   */
  const ours = brandOddsFor(fixtureId, await fixtureSides(fixtureId, sport));

  if (isApi) {
    // Checked first and returned whole: a fixture with mirrored TAB odds has
    // nothing on the surface to merge with.
    const tab = await tabOddsFor(fixtureId);
    if (tab.length) {
      return [...foldBookAliases(tab.map(serializeOdds), await bookAliases()), ...(await ours)];
    }
    return [...(await apiOddsForFixture(fixtureId, sport)), ...(await ours)];
  }
  const [rows, aliases] = await Promise.all([
    (await coll('odds'))
      .find({ fixture_id: fixtureId, is_live: false })
      .project(ODDS_PROJECTION)
      .sort({ id: 1 })
      .toArray(),
    bookAliases(),
  ]);
  return [...foldBookAliases(rows.map(serializeOdds), aliases), ...(await ours)];
}

/**
 * The fixture's two sides, which is all brandOddsFor needs to place a price.
 *
 * Both brands name their selections, not their outcome numbers, so a row can
 * only be put on the right side of the grid by matching the name. Read from
 * the mirrored schedule where there is one, else from the odds-derived list.
 */
async function fixtureSides(fixtureId, sport) {
  const doc = await mirrorFixtureDoc(fixtureId);
  if (doc) return { home: doc.home_team, away: doc.away_team, sport: doc.sport ?? sport };
  if (!isApi) return { home: null, away: null, sport };
  const list = await apiFixtures(sport).catch(() => []);
  const f = list.find((x) => x.fixture_id === fixtureId);
  return { home: f?.home_team ?? null, away: f?.away_team ?? null, sport };
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
    /*
     * TAB-sourced fixtures are not on any per-sport pivot — the surface has
     * never heard of them — so their moneyline comes from the mirror or the
     * board shows them with empty price columns.
     */
    const tabRows = mirrorConfigured
      ? await (await coll('tabOdds'))
        .find({ fixture_id: { $in: ids }, market_id: 'moneyline', is_lay: false, is_live: false })
        .project({
          _id: 0, fixture_id: 1, outcome_no: 1, current_price: 1, open_price: 1,
          market_id: 1, is_lay: 1,
        })
        .toArray()
        .catch(() => [])
      : [];
    for (const r of [...perSport.flat(), ...tabRows]) {
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

/**
 * The per-player box score for one fixture — NBA and NFL only.
 *
 * `player_stats` is keyed by `fixture_id`, the same id the board uses, so this
 * is one indexed read. Only games that have been PLAYED are in it: there are no
 * rows for an upcoming fixture, which is why the tab says so rather than
 * showing an empty table.
 *
 * The collection carries 28 top-level stats and a 28-to-72 key `stats`
 * sub-object; what comes back here is the handful each sport is actually bet
 * on, promoted to the top of the row. For basketball that is the props ladder
 * — points, rebounds, assists, threes, and the PRA combination — and for
 * gridiron the yardage and touchdown markets.
 */
const NBA_FIELDS = ['minutes', 'points', 'rebounds', 'assists', 'threes', 'pra'];
const NFL_FIELDS = [
  'passing_yards', 'passing_touchdowns', 'passing_interceptions',
  'rushing_yards', 'rushing_attempts', 'rushing_touchdowns',
  'receiving_yards', 'receptions', 'receiving_targets', 'receiving_touchdowns',
  'touchdowns',
];

/**
 * Did this man take the field?
 *
 * Nothing in the row says so outright: `player_status` is "completed" on every
 * row we have, and there is no snaps or participation key, so the only
 * evidence is whether he recorded anything. The test has to run over the WHOLE
 * `stats` sub-object and not over the columns this module projects — those are
 * passing, rushing and receiving, which a kicker never touches. Nick Folk went
 * 3 from 3 and Jason Myers 2 from 2; both had passing_yards 0, rushing_yards 0,
 * receiving_yards 0, and judged on those they had not played, so the bets on
 * them were called void while the brand was paying them out as winners.
 *
 * `stats` carries seventy-odd keys per player and the client needs one bit of
 * it, so the bit is computed here and the object is dropped.
 */
const tookPart = (row) => Object.values(row?.stats ?? {}).some((v) => Number(v) > 0);

export async function playerStats(fixtureId) {
  if (!fixtureId) return null;
  const rows = await (await coll('playerStats'))
    .find({ fixture_id: fixtureId })
    .project({
      _id: 0, sport: 1, league: 1, team: 1, side: 1, opponent: 1,
      player: 1, player_id: 1, position: 1, number: 1, is_starter: 1,
      home_team: 1, away_team: 1, fixture_status: 1, updated_at: 1,
      ...Object.fromEntries([...NBA_FIELDS, ...NFL_FIELDS].map((f) => [f, 1])),
      // Read for `played` only, and deliberately not returned — see below.
      stats: 1,
    })
    .toArray()
    .catch(() => []);
  if (!rows.length) return { configured: true, sport: null, teams: [], updatedAt: null };

  const sport = rows[0].sport ?? null;
  const fields = sport === 'basketball' ? NBA_FIELDS : NFL_FIELDS;
  /*
   * Ordered the way a box score is read: starters first, then by the stat that
   * decides who mattered — minutes in basketball, where everyone who played has
   * one, and total yards in gridiron, where most of a 96-man roster did not
   * touch the ball.
   */
  const weight = (r) =>
    sport === 'basketball'
      ? Number(r.minutes) || 0
      : (Number(r.passing_yards) || 0) + (Number(r.rushing_yards) || 0) + (Number(r.receiving_yards) || 0);

  const byTeam = new Map();
  for (const r of rows) {
    const key = r.side ?? r.team ?? 'unknown';
    const t = byTeam.get(key) ?? { side: r.side ?? null, team: r.team ?? null, players: [] };
    t.players.push({
      player: r.player ?? null,
      playerId: r.player_id ?? null,
      position: r.position ?? null,
      number: r.number ?? null,
      starter: !!r.is_starter,
      played: tookPart(r),
      ...Object.fromEntries(fields.map((f) => [f, r[f] ?? null])),
    });
    byTeam.set(key, t);
  }
  for (const t of byTeam.values()) {
    t.players.sort((a, b) => (b.starter ? 1 : 0) - (a.starter ? 1 : 0) || weight(b) - weight(a));
  }
  // Home first, which is how the rest of the page reads.
  const teams = [...byTeam.values()].sort((a) => (a.side === 'home' ? -1 : 1));
  const updatedAt = rows.reduce((m, r) => {
    const v = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    return v > m ? v : m;
  }, 0);

  return {
    configured: true,
    sport,
    league: rows[0].league ?? null,
    fields,
    teams,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}
