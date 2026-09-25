import { coll } from './mongo.mjs';

/* ---------------------------------------------------------------------------
   The Odds Library reads three collections — `fixtures` for the event list,
   `odds_sp` for the closing record, `odds` for the live/pregame board — plus
   `leagues` and `entities` for labels and badges.

   The Supabase build did its grouping in the browser: to list a sport's
   competitions it paged every one of that sport's fixture rows down the wire
   (51k for soccer, 52 requests) and folded them client-side. Mongo can group
   where the data is, so `competitions()` returns a few hundred counted triples
   instead. The page's own `groupCompetitions` still does the merging — it just
   receives rows that already carry an `n`.
   ------------------------------------------------------------------------- */

/** Everything the event list and the cards render. */
const FIXTURE_FIELDS = {
  _id: 0,
  fixture_id: 1, sport: 1, optic_league: 1, category: 1, country: 1, tournament: 1,
  event_name: 1, competitors: 1, home_team: 1, away_team: 1,
  scheduled_start: 1, actual_start: 1, status: 1, is_live: 1, scores: 1,
  venue: 1, location: 1, has_odds: 1, tier: 1,
};

/* Name only the columns the page reads. The closing record is wide and
   `flucs`-free, but `book_prices`/`book_fairs`/`book_overround` are the bulk of
   it and all three are rendered. */
const SP_FIELDS = {
  _id: 0,
  market_id: 1, market_name: 1, selection: 1, line: 1, line_group: 1, pair_key: 1,
  outcome_no: 1, n_outcomes: 1,
  book_prices: 1, book_fairs: 1, book_overround: 1,
  fair_blend: 1, fair_prob: 1, n_books: 1, blend_books: 1, blend_tier: 1,
  og_blend: 1, og_prob: 1,
};

/* The live board is one row per book, and it carries a `flucs` array that can
   run to hundreds of points per selection. The page draws none of it, so it is
   projected away rather than shipped. */
const LIVE_FIELDS = {
  _id: 0,
  market_id: 1, market_name: 1, selection: 1, line: 1, line_group: 1, pair_key: 1,
  outcome_no: 1, is_main: 1, sportsbook: 1, is_lay: 1, is_live: 1,
  open_price: 1, current_price: 1, close_price: 1, status: 1,
};

/** The UTC half-open range [start of month, start of next) as BSON dates. */
export function monthRange(year, month) {
  const start = Date.UTC(year, month - 1, 1);
  const end = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  return { $gte: new Date(start), $lt: new Date(end) };
}

function monthMatch(sport, year, month) {
  const m = { sport };
  if (year && month) m.scheduled_start = monthRange(year, month);
  return m;
}

/**
 * The span of dates a sport has, so the period picker knows its options.
 * A $group min/max scans the sport's fixtures once rather than sorting them
 * twice, and the result is cached for an hour — the span moves by a day at most.
 */
export async function dateRange(sport) {
  const [row] = await (await coll('fixtures')).aggregate([
    { $match: { sport, scheduled_start: { $ne: null } } },
    { $group: { _id: null, min: { $min: '$scheduled_start' }, max: { $max: '$scheduled_start' } } },
  ]).toArray();
  return { min: row?.min ?? null, max: row?.max ?? null };
}

/**
 * The competitions a sport ran, counted — for the whole archive when no period
 * is given, for one month when it is.
 *
 * Grouping on (optic_league, tournament, country) keeps every distinction the
 * page's own merge depends on: a bucket league carries a different tournament
 * per fixture, and the country is what lets a competition whose category is a
 * restatement of its own name still show where it is played.
 */
export async function competitions(sport, year, month) {
  const rows = await (await coll('fixtures')).aggregate([
    { $match: monthMatch(sport, year, month) },
    {
      $group: {
        _id: { optic_league: '$optic_league', tournament: '$tournament', country: '$country' },
        n: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0, n: 1,
        optic_league: '$_id.optic_league',
        tournament: '$_id.tournament',
        country: '$_id.country',
      },
    },
  ]).toArray();
  const total = rows.reduce((t, r) => t + r.n, 0);
  return { total, rows };
}

/**
 * One month of a sport's fixtures, optionally narrowed to a competition.
 *
 * `leagues` carries every optic_league a merged competition spans (Ligue 1 has
 * two ids), and `tournament` is the fallback for the fixtures that have no
 * league at all — 676 of tennis's in a month grouped on their tournament, and
 * they have to be selectable the same way.
 */
export async function fixtures({ sport, year, month, leagues = [], tournament = null }) {
  const q = monthMatch(sport, year, month);
  if (leagues.length) q.optic_league = leagues.length === 1 ? leagues[0] : { $in: leagues };
  else if (tournament) q.tournament = tournament;

  return (await coll('fixtures'))
    .find(q)
    .project(FIXTURE_FIELDS)
    .sort({ scheduled_start: 1, fixture_id: 1 })
    .limit(20_000)
    .toArray();
}

/** One fixture by id — what a deep link needs to find the month it lives in. */
export async function fixtureById(id) {
  if (!id) return null;
  return (await coll('fixtures')).findOne({ fixture_id: id }, { projection: FIXTURE_FIELDS });
}

const RX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Free-text search over event names, both sides of which are in the one field. */
export async function search(q, limit = 40) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const rx = new RegExp(term.replace(RX_SPECIAL, '\\$&'), 'i');
  return (await coll('fixtures'))
    .find({ event_name: rx })
    .project(FIXTURE_FIELDS)
    .sort({ scheduled_start: -1 })
    .limit(limit)
    .toArray();
}

/**
 * The odds for one event.
 *
 * The closing record is the richer of the two — book prices, vig-stripped
 * fairs, the blend and its tier — but it is written when a market closes, so
 * anything still open falls back to the live board. Which of the board's two
 * kinds of row to use is the page's call (a live price is not a pregame price
 * and the two must never be averaged), so both come back and it splits them.
 */
export async function oddsForFixture(fixtureId) {
  if (!fixtureId) return { source: 'none', rows: [] };

  const closing = await (await coll('oddsSp'))
    .find({ fixture_id: fixtureId })
    .project(SP_FIELDS)
    .limit(2000)
    .toArray();
  if (closing.length) return { source: 'closing', rows: closing };

  const live = await (await coll('odds'))
    .find({ fixture_id: fixtureId, is_lay: false })
    .project(LIVE_FIELDS)
    .limit(3000)
    .toArray();
  return { source: live.length ? 'live' : 'none', rows: live };
}

/** The authoritative optic_league → (category, tournament) map. ~400 rows. */
export async function leagueDirectory() {
  return (await coll('leagues'))
    .find({})
    .project({ _id: 0, optic_league: 1, sport: 1, category: 1, tournament: 1 })
    .toArray();
}

/** Competition badges, keyed by the same name `fixtures.tournament` carries. */
export async function competitionLogos() {
  return (await coll('entities'))
    .find({ sport: 'competition', logo_url: { $nin: [null, ''] } })
    .project({ _id: 0, name: 1, logo_url: 1 })
    .limit(5000)
    .toArray();
}
