import type { Fixture } from './types'
import { prettySport, reclassifySport, sportGroupKey } from './sports'
import { espnLogoUrl } from './teamLogos'
import { cachedLogo, ensureLogoCache } from './logoCache'
import { countryFlagUrl } from './countryFlags'
import { melbDayRangeUtc } from './dates'
import { getSupabase } from './supabase'
import { mapFixture, type FixtureRow } from './oddsLibrary'
import { fetchCardOdds } from './cardOdds'
import { fetchFixtureLogos } from './fixtureLogos'

// The Odds Library's fixture table. `live_fixtures` stopped being written on
// 2026-08-24 — 0 rows in the hour this was changed, against 734 for `fixtures`
// — and by then 424 of the next week's 804 upcoming fixtures existed only
// here, so the board was missing more than half its slate and both matchers
// were pairing against a frozen list.
//
// Prices are NOT on this table: `fixtures` carries no odds columns at all.
// The board's odds column comes from `odds` via fetchCardOdds, joined in after
// the rows land.
const TABLE = 'fixtures'
/** Column the fixture id lives under here (`optic_fixture_id` on the old one). */
const ID_COL = 'fixture_id'
/** Raw league slug column (`league` on the old one). */
const LEAGUE_COL = 'optic_league'

// Window for the board: everything scheduled up to this far ahead, plus all
// currently-live games regardless of their (possibly stale) scheduled_start.
//
// A full day either side. Measured on a normal slate that is 490 fixtures
// against 95 for the old -3h/+6h window, so ROW_LIMIT had to move with it —
// at 500 the query sat one busy weekend away from silently truncating, and
// because the rows come back ascending by scheduled_start the ones dropped
// would have been the furthest-future, i.e. the whole tail of tomorrow.
//
// 1000 is PostgREST's own per-response ceiling, so it is the most this can
// fetch without paging.
const UPCOMING_HORIZON_H = 24
const RECENT_COMPLETED_H = 24
const ROW_LIMIT = 1000



const COLUMNS = '*'

/** The board feed: all live games + everything scheduled in the near window. */
export async function fetchFixtures(): Promise<Fixture[]> {
  const now = Date.now()
  const lo = new Date(now - RECENT_COMPLETED_H * 3_600_000).toISOString()
  const hi = new Date(now + UPCOMING_HORIZON_H * 3_600_000).toISOString()

  await ensureLogoCache()
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(COLUMNS)
    .or(`is_live.eq.true,and(scheduled_start.gte.${lo},scheduled_start.lte.${hi})`)
    .order('scheduled_start', { ascending: true })
    .limit(ROW_LIMIT)
    .returns<FixtureRow[]>()

  if (error) throw error
  const nowMs = Date.now()
  return enrich((data ?? []).map((r) => mapFixture(r, nowMs)))
}

/** All UPCOMING or COMPLETED fixtures on a given Melbourne calendar day — backs
 *  the day browser. Completed are newest-first, upcoming soonest-first. */
export async function fetchFixturesByDate(
  dateStr: string,
  status: 'upcoming' | 'completed',
): Promise<Fixture[]> {
  await ensureLogoCache()
  const [lo, hi] = melbDayRangeUtc(dateStr)

  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(COLUMNS)
    .eq('status', status)
    .gte('scheduled_start', lo)
    .lt('scheduled_start', hi)
    .order('scheduled_start', { ascending: status === 'upcoming' })
    .limit(1000)
    .returns<FixtureRow[]>()

  if (error) throw error
  const nowMs = Date.now()
  return enrich((data ?? []).map((r) => mapFixture(r, nowMs)))
}

/**
 * Recent + upcoming fixtures for a single prettified sport. Used by the
 * `/sport/:sport` route when the current ±6h window is empty (e.g. NBA between
 * games) so the page can still show the next match instead of "no fixtures".
 */
/**
 * Upcoming fixtures whose scheduled kickoff has already passed by at least
 * `staleMinutes`. Used by the Notifications page to flag stuck OPTIC rows that
 * the board feed's narrow ±6h window would otherwise hide. Capped by
 * `maxAgeHours` so we don't drag in every never-updated row in the table.
 */
export async function fetchOverdueUpcomingFixtures(opts: {
  staleMinutes?: number
  maxAgeHours?: number
  limit?: number
} = {}): Promise<Fixture[]> {
  const { staleMinutes = 15, maxAgeHours = 48, limit = 200 } = opts
  await ensureLogoCache()
  const now = Date.now()
  const hi = new Date(now - staleMinutes * 60_000).toISOString()
  const lo = new Date(now - maxAgeHours * 3_600_000).toISOString()
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(COLUMNS)
    .eq('status', 'upcoming')
    .gte('scheduled_start', lo)
    .lt('scheduled_start', hi)
    .order('scheduled_start', { ascending: false })
    .limit(limit)
    .returns<FixtureRow[]>()
  if (error) throw error
  const nowMs = Date.now()
  return enrich((data ?? []).map((r) => mapFixture(r, nowMs)))
}

/**
 * Completed fixtures that ended at least `endedMinutes` ago — the candidate set
 * for the "book hasn't settled this yet" alert.
 *
 * "Ended" is `updated_at`, since OPTIC has no end-time column; see the note on
 * Fixture.updatedAt for why that stands in. Bounded by `maxAgeHours` because
 * the unsettled backlog does NOT converge (sampled: 17 of 28 games from 2-4
 * days ago still had pending bets), so an unbounded window would grow into a
 * list nobody reads.
 */
export async function fetchRecentlyCompletedFixtures(opts: {
  endedMinutes?: number
  maxAgeHours?: number
  limit?: number
} = {}): Promise<Fixture[]> {
  const { endedMinutes = 15, maxAgeHours = 24, limit = 120 } = opts
  await ensureLogoCache()
  const now = Date.now()
  const hi = new Date(now - endedMinutes * 60_000).toISOString()
  const lo = new Date(now - maxAgeHours * 3_600_000).toISOString()
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(COLUMNS)
    .eq('status', 'completed')
    .gte('updated_at', lo)
    .lt('updated_at', hi)
    .order('updated_at', { ascending: false })
    .limit(limit)
    .returns<FixtureRow[]>()
  if (error) throw error
  const nowMs = Date.now()
  return enrich((data ?? []).map((r) => mapFixture(r, nowMs)))
}

export const SPORT_PAGE_SIZE = 200

/**
 * Newest-first page of fixtures for a sport. `page` is zero-indexed and each
 * page holds SPORT_PAGE_SIZE rows. The caller paginates via the "Load more"
 * button — accumulating pages on the client beats one giant fetch when the
 * table grows.
 */
export async function fetchFixturesBySport(
  rawSports: string | string[],
  page = 0,
  rawLeagues: string[] = [],
): Promise<{ rows: Fixture[]; hasMore: boolean }> {
  await ensureLogoCache()
  const from = page * SPORT_PAGE_SIZE
  const to = from + SPORT_PAGE_SIZE - 1
  const list = Array.isArray(rawSports) ? rawSports : [rawSports]
  let q = getSupabase().from(TABLE).select(COLUMNS)
  // `rawSports` must be the sport's OWN slugs. Competitions the feed files
  // under another sport are picked up by league instead.
  //
  // They used to be picked up by querying every contributing slug and
  // post-filtering on the client, which quietly broke the page: 21 of cricket's
  // 41 active fixtures arrive as sport='soccer' (One Day Cup, Caribbean Premier
  // League, Lanka Premier League…), so the query became sport IN (cricket,
  // soccer) and a 200-row page was 180 soccer rows. Sorted furthest-future
  // first, cricket's last fixture sat at index 774 — four "Load more" clicks
  // and 800 mostly-irrelevant rows away — and the moment soccer publishes
  // fixtures beyond cricket's horizon the sport shows nothing at all while the
  // sidebar still counts 41.
  //
  // Filtering by league instead keeps the page dense: every row fetched belongs
  // to the sport being viewed.
  if (rawLeagues.length > 0) {
    const quote = (v: string) => `"${v.replace(/["\\]/g, '')}"`
    q = q.or(
      `sport.in.(${list.map(quote).join(',')}),league.in.(${rawLeagues.map(quote).join(',')})`,
    )
  } else {
    q = list.length === 1 ? q.eq('sport', list[0]) : q.in('sport', list)
  }
  const { data, error } = await q
    .order('scheduled_start', { ascending: false })
    .range(from, to)
    .returns<FixtureRow[]>()
  if (error) throw error
  const rows = data ?? []
  const nowMs = Date.now()
  return { rows: await enrich(rows.map((r) => mapFixture(r, nowMs))), hasMore: rows.length === SPORT_PAGE_SIZE }
}

/**
 * All fixtures for a given OpticOdds tournament — backs the Mapping drill-down.
 * For tennis pass `seasonType` to scope to a single tournament inside the league.
 */
export async function fetchFixturesByTournament(
  rawSport: string,
  rawLeague: string,
  rawSeasonType?: string | null,
): Promise<Fixture[]> {
  await ensureLogoCache()
  // Query by LEAGUE, not sport+league.
  //
  // The feed files whole cricket competitions under the wrong sport — every one
  // of England One Day Cup's fixtures is stored as sport='soccer' — and
  // reclassifySport only rescues them once they are already in hand. Asking the
  // DB for sport='cricket' AND league='england_-_one_day_cup' therefore matched
  // nothing, and the drill showed "no events" for a tournament the board itself
  // was listing.
  //
  // The league slug carries the sport on its own: of 367 slugs in the table,
  // ZERO resolve to more than one sport after reclassification, so dropping the
  // sport predicate loses no precision. The post-filter below keeps it honest
  // anyway.
  let q = getSupabase().from(TABLE).select(COLUMNS).eq(LEAGUE_COL, rawLeague)
  if (rawSeasonType) q = q.eq('season_type', rawSeasonType)
  const { data, error } = await q
    .order('scheduled_start', { ascending: false })
    .limit(1000)
    .returns<FixtureRow[]>()
  if (error) throw error
  const nowMs = Date.now()
  const want = sportGroupKey(prettySport(reclassifySport(rawSport, rawLeague)))
  return (data ?? [])
    .map((r) => mapFixture(r, nowMs))
    .filter((f) => !want || sportGroupKey(f.sport) === want)
}

/** A single fixture by its OpticOdds id — used when deep-linking the detail page
 *  to a fixture that's outside the board's window. */
export async function fetchFixtureById(id: string): Promise<Fixture | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(COLUMNS)
    .eq(ID_COL, id)
    .limit(1)
    .returns<FixtureRow[]>()

  if (error) throw error
  await ensureLogoCache()
  const row = data?.[0]
  if (!row) return null
  const [one] = await enrich([mapFixture(row, Date.now())])
  return one
}

/** Logo precedence: feed column → national-team flag → ESPN majors →
 *  resolved cache → monogram (null). */
function resolveLogo(sport: string, league: string, name: string, feedLogo: string | null): string | null {
  // Some feed rows carry trailing whitespace ("UMF Grindavik ") which misses
  // every exact-match lookup below.
  const n = name.trim()
  const s = sport.toLowerCase()
  // Teams named by country get a flag: soccer internationals (World Cup,
  // friendlies) and cricket's bilateral series. Cricket's *domestic* leagues
  // (T20 Blast) name clubs, which never match the country table — but scoping
  // to `international_*` keeps a club called "Georgia" from flying a flag.
  const national = s === 'soccer' || (s === 'cricket' && league.toLowerCase().startsWith('international'))
  const flag = national ? countryFlagUrl(n) : null
  return feedLogo ?? flag ?? espnLogoUrl(sport, league, n) ?? cachedLogo(sport, n) ?? null
}

// --- column mapping -------------------------------------------------------





/**
 * Fill in what `fixtures` cannot carry.
 *
 * The Odds Library splits concerns: `fixtures` is the fixture, `odds` is the
 * price, and logos are resolved from names. `mapFixture` therefore returns
 * null for both, and the board fills them here rather than in the mapper —
 * which keeps the mapper synchronous and pure.
 *
 * Odds are fetched in one batched call for the whole page. Logos are local
 * (flag CDN, ESPN pattern, or the prefetched cache), so they cost nothing.
 */
async function enrich(input: Fixture[]): Promise<Fixture[]> {
  // No dedupe: `fixtures.fixture_id` is the PRIMARY KEY and cannot repeat. The
  // "2,681 duplicates" that prompted one were an artefact of paging PostgREST
  // without an ORDER BY, which is not a stable slice — the same read ordered
  // returns 13,943 rows and 13,943 distinct ids. The pagers were fixed instead.
  const fixtures = input
  if (!fixtures.length) return fixtures
  const ids = fixtures.map((f) => f.id)
  const [prices, logos] = await Promise.all([fetchCardOdds(ids), fetchFixtureLogos(ids)])
  for (const f of fixtures) {
    // `fixture_entities` already ties a logo to this fixture and side, so it is
    // exact. resolveLogo (flag CDN / ESPN pattern / name cache) is the fallback
    // for fixtures the table has no row for.
    const known = logos.get(f.id)
    f.homeLogo = known?.home ?? resolveLogo(f.rawSport, f.rawLeague, f.homeName, null)
    f.awayLogo = known?.away ?? resolveLogo(f.rawSport, f.rawLeague, f.awayName, null)
    const p = prices.get(f.id)
    if (p) {
      f.oddsHome = p.home
      f.oddsDraw = p.draw
      f.oddsAway = p.away
      if (p.live) f.liveH2h = { home: p.home, draw: p.draw, away: p.away }
      else f.closingH2h = { home: p.home, draw: p.draw, away: p.away }
    }
  }
  return fixtures
}

// mapRow lived here. Row mapping is now mapFixture in oddsLibrary.ts —
// one mapper for one source, rather than two drifting copies of the same
// status guards. `enrich` above adds the logos and prices that live
// outside the fixtures table.


