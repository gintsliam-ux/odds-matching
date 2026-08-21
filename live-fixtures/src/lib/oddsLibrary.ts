/**
 * Read layer for the Odds Library schema — `fixtures`, `odds`, `odds_sp`.
 *
 * NOT WIRED INTO THE UI YET. The board still reads `live_fixtures` via
 * dataSource.ts. This module exists so the switch is a one-line change in the
 * pages once two operational gaps close (measured 2026-08-20):
 *
 *   · `odds` has ZERO rows with is_live=true — capture.mjs live isn't on cron,
 *     so there is no in-play pricing to replace live_fixtures.live_h2h_*.
 *   · Pregame coverage is thin on upcoming fixtures, which is when the board is
 *     actually used.
 *
 * Everything here is written against the real column names and verified against
 * live data. What the new schema gets right, and what this leans on:
 *
 *   · `normalized_selection` is 100% populated — home/away/draw/over/under — so
 *     sides are read from a field instead of string-matching `selection`
 *     against `home_team`. That matching is what put West Perth's crest on
 *     Perth and picked the wrong leg out of a multi holding both Botev clubs.
 *   · `outcome_no` gives a stable order (1 home/over, 2 away/under, 3 draw).
 *   · `pair_key` is the handicap signed from the home side, which is what pairs
 *     the two sides of a market. `line_group` = abs(line) is NOT safe for this:
 *     home -1.5/away +1.5 and home +1.5/away -1.5 both exist and are different
 *     markets, and abs() collapses them into one.
 *   · `odds_sp.fair_blend` is vig-stripped per book and blended, so a fair
 *     price no longer has to be derived in the client.
 */

import { getSupabase } from './supabase'
import { prettyLeague, prettySport, reclassifySport } from './sports'
import type { Fixture, FixtureStatus, PeriodScore } from './types'

// --- row shapes -------------------------------------------------------------

export interface Competitor {
  name: string
  side?: string | null
  id?: string | null
  country?: string | null
  abbr?: string | null
}

interface SideScore {
  total?: number | null
  periods?: Record<string, number | null> | null
  aggregate?: number | null
}

export interface FixtureRow {
  fixture_id: string
  source: string | null
  sport: string | null
  category: string | null
  /** Renamed from `league` in the Odds Library schema. */
  optic_league: string | null
  tournament: string | null
  event_name: string | null
  competitors: Competitor[] | null
  home_team: string | null
  away_team: string | null
  scheduled_start: string | null
  actual_start: string | null
  odds_open_at: string | null
  odds_close_at: string | null
  status: string | null
  optic_status: string | null
  tournament_stage: string | null
  is_live: boolean | null
  scores: { home?: SideScore; away?: SideScore } | null
  in_play_data: Record<string, unknown> | null
  venue: string | null
  location: string | null
  country: string | null
  season: string | null
  season_type: string | null
  broadcast: string | null
  end_date: string | null
  current_round: string | null
  has_odds: boolean | null
  has_sp: boolean | null
  tier: number | null
  settled_at: string | null
  updated_at: string | null
}

export interface OddsRow {
  fixture_id: string
  sport: string | null
  market_id: string | null
  selection: string | null
  normalized_selection: string | null
  outcome_no: number | null
  line: number | null
  line_group: number | null
  /** The handicap line signed from the HOME side — the correct key for pairing
   *  a two-sided market. See groupMarkets. */
  pair_key: number | null
  is_main: boolean | null
  sportsbook: string | null
  is_lay: boolean | null
  is_live: boolean | null
  open_price: number | null
  current_price: number | null
  close_price: number | null
  // The jsonb price columns are written empty rather than null — `[]` and `{}`
  // — so they are typed non-nullable. Verified across all 1.2M rows: zero
  // nulls on either. Modelling them as nullable only forced a `?? {}` at every
  // read for a state the table does not produce.
  flucs: Array<{ p: number; t: string }>
  daily_prices: Record<string, number>
  price_6h: number | null
  price_3h: number | null
  price_1h: number | null
  price_30m: number | null
  price_10m: number | null
  status: string | null
  updated_at: string | null
}

export interface SpRow {
  fixture_id: string
  market_id: string | null
  selection: string | null
  normalized_selection?: string | null
  outcome_no: number | null
  line: number | null
  line_group: number | null
  // Same as the odds row: always an object, never null (0 of 5.93M).
  book_prices: Record<string, number>
  book_fairs: Record<string, number>
  book_overround: Record<string, number>
  fair_blend: number | null
  fair_prob: number | null
  n_books: number | null
  // Genuinely nullable, unlike the three above — null on 72,312 rows, the same
  // rows where `fair_blend` is null (no blend was computed, so no book list).
  blend_books: string[] | null
  blend_tier: string | null
}

const FIXTURE_COLS =
  'fixture_id,source,sport,category,optic_league,tournament,event_name,competitors,home_team,away_team,' +
  'scheduled_start,actual_start,odds_open_at,odds_close_at,status,optic_status,tournament_stage,is_live,' +
  'scores,in_play_data,venue,location,country,season,season_type,broadcast,end_date,current_round,' +
  'has_odds,has_sp,tier,settled_at,updated_at'

// --- mapping ----------------------------------------------------------------

/**
 * A fixture stuck on `status='live'` long past any plausible duration is
 * finished, whatever the column says.
 *
 * Measured 2026-08-21: of 29 fixtures marked live, only 8 had started within
 * four hours. Fifteen were 12-24h old and England v Pakistan had been "live"
 * for 44 hours. Without this the board would carry a permanent tail of phantom
 * live games, and every "live fixtures with live odds" ratio would be measured
 * against a denominator full of matches that ended yesterday — which is exactly
 * how I mis-read the live-odds coverage for several days.
 *
 * dataSource.ts already does this for live_fixtures (STALE_LIVE_FEED_H); the
 * same disease is in the new table, so the same guard travels with it.
 *
 * Eight hours is deliberately generous: a Test match session, a rain-delayed
 * tennis match and a long golf round all legitimately run past four.
 */
const STALE_LIVE_H = 8

/** `cancelled` has no place on a live board; it reads as finished. */
function mapStatus(row: FixtureRow, nowMs = Date.now()): FixtureStatus {
  switch (row.status) {
    case 'live': {
      const ref = row.actual_start ?? row.scheduled_start
      const started = ref ? Date.parse(ref) : NaN
      if (Number.isFinite(started) && nowMs - started > STALE_LIVE_H * 3_600_000) return 'completed'
      return 'live'
    }
    case 'upcoming':
      return 'upcoming'
    default:
      return 'completed'
  }
}

/**
 * Competitor names.
 *
 * `home_team`/`away_team` are denormalised for 2-way events and null on golf,
 * where the field is the n-way `competitors` array instead. Fall back to it so
 * an n-way event still names something rather than rendering "Home".
 */
function names(row: FixtureRow): { home: string; away: string } {
  const home = row.home_team ?? row.competitors?.find((c) => c.side === 'home')?.name
  const away = row.away_team ?? row.competitors?.find((c) => c.side === 'away')?.name
  return { home: home ?? row.event_name ?? 'Home', away: away ?? 'Away' }
}

/** `scores.{home,away}.periods` is an object keyed period_1, period_2, … */
function periodList(row: FixtureRow): PeriodScore[] {
  const h = row.scores?.home?.periods ?? {}
  const a = row.scores?.away?.periods ?? {}
  const keys = [...new Set([...Object.keys(h), ...Object.keys(a)])].sort((x, y) => {
    const nx = Number(x.replace(/\D+/g, '')) || 0
    const ny = Number(y.replace(/\D+/g, '')) || 0
    return nx - ny
  })
  return keys.map((k, i) => ({ index: i + 1, home: h[k] ?? null, away: a[k] ?? null }))
}

/**
 * A library `fixtures` row in the shape the existing UI already renders.
 *
 * Deliberately produces the SAME `Fixture` type the board uses today, so the
 * cutover is a swap of the fetch function rather than a rewrite of every page.
 * The odds fields are left null here — prices come from `odds`/`odds_sp` via
 * fetchMarkets, not from the fixture row.
 */
export function mapFixture(row: FixtureRow, nowMs = Date.now()): Fixture {
  const status = mapStatus(row, nowMs)
  const { home, away } = names(row)
  const rawSport = reclassifySport(row.sport ?? '', row.optic_league ?? '')
  // Display the league from `tournament` (+ `category`), NOT from prettifying
  // the slug. The Odds Library slugs lead with the sport, so prettyLeague turns
  // `soccer_hungary_nb_ii` into "Soccer Hungary Nb Ii" — the sport repeated
  // beside itself in the UI. `tournament` is the display name the schema
  // provides for exactly this ("Serie A", "Cincinnati", "UFC 300"), and
  // `category` disambiguates same-named competitions across countries.
  const league = row.tournament
    ? row.category && row.category !== 'International' && !row.tournament.includes(row.category)
      ? `${row.category} · ${row.tournament}`
      : row.tournament
    : prettyLeague(row.optic_league ?? '')
  const startTime =
    (status === 'live' ? row.actual_start ?? row.scheduled_start : row.scheduled_start) ??
    row.scheduled_start ??
    new Date().toISOString()

  return {
    id: row.fixture_id,
    sport: prettySport(rawSport),
    league,
    rawSport,
    rawLeague: row.optic_league ?? '',
    status,
    startTime,
    homeName: home,
    awayName: away,
    // Logos come from `entities` / the fixture_entities view, resolved
    // separately so the board doesn't pay for a join it may not need.
    homeLogo: null,
    awayLogo: null,
    homeScore: row.scores?.home?.total ?? null,
    awayScore: row.scores?.away?.total ?? null,
    clock: null,
    oddsHome: null,
    oddsDraw: null,
    oddsAway: null,

    opticId: row.fixture_id,
    scheduledStart: row.scheduled_start,
    actualStart: row.actual_start,
    venue: row.venue,
    broadcast: row.broadcast,
    seasonType: row.season_type,
    liveUpdatedAt: null,
    updatedAt: row.updated_at,
    bookmaker: null,
    liveBookmaker: null,
    liveH2h: { home: null, draw: null, away: null },
    liveSpread: { line: null, home: null, away: null },
    liveTotal: { line: null, over: null, under: null },
    closingH2h: { home: null, draw: null, away: null },
    spread: { line: null, home: null, away: null },
    total: { line: null, over: null, under: null },
    periods: periodList(row),
    pregameOdds: null,
    flucs: null,
    openAt: row.odds_open_at,
    closeAt: row.odds_close_at,
  }
}

// --- queries ----------------------------------------------------------------

/** Live now, plus everything scheduled in the window either side. */
export async function fetchLibraryFixtures(hoursBack = 24, hoursAhead = 24): Promise<Fixture[]> {
  const now = Date.now()
  const lo = new Date(now - hoursBack * 3_600_000).toISOString()
  const hi = new Date(now + hoursAhead * 3_600_000).toISOString()
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select(FIXTURE_COLS)
    .or(`is_live.eq.true,and(scheduled_start.gte.${lo},scheduled_start.lte.${hi})`)
    .order('scheduled_start', { ascending: true })
    .limit(1000)
    .returns<FixtureRow[]>()
  if (error) throw error
  const nowMs = Date.now()
  return (data ?? []).map((r) => mapFixture(r, nowMs))
}

export async function fetchLibraryFixture(fixtureId: string): Promise<Fixture | null> {
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select(FIXTURE_COLS)
    .eq('fixture_id', fixtureId)
    .limit(1)
    .returns<FixtureRow[]>()
  if (error) throw error
  return data?.[0] ? mapFixture(data[0]) : null
}

// --- markets ----------------------------------------------------------------

export interface MarketSide {
  selection: string
  /** home | away | draw | over | under | yes | no | <outright slug> */
  side: string
  outcomeNo: number | null
  price: number | null
  openPrice: number | null
  closePrice: number | null
  status: string | null
  /** Vig-stripped blend from odds_sp, when the fixture has settled prices. */
  fairBlend?: number | null
}

export interface MarketLine {
  /**
   * The handicap signed from the home side (`pair_key`), or the total's line.
   *
   * NOT abs(line). Both ladders exist — home -1.5 with away +1.5, AND home
   * +1.5 with away -1.5 — and they are different markets. Grouping on abs()
   * merges them, so a favourite's line and an underdog's land in one row and
   * the two prices read as a pair when they are nothing of the sort.
   */
  pairKey: number | null
  /** Signed line as the book quotes it, per side. */
  sides: MarketSide[]
}

export interface BookMarket {
  book: string
  isLay: boolean
  isLive: boolean
  lines: MarketLine[]
}

export interface Market {
  marketId: string
  books: BookMarket[]
}

/**
 * Every market for a fixture, grouped book → line → side.
 *
 * Sides come from `normalized_selection` and order from `outcome_no`, so
 * nothing here parses a team name out of a selection string.
 *
 * `is_main` now selects exactly one line per book per market — verified: 0 of
 * 1000 sampled (fixture, book, is_live, side) groups had more than one, where
 * a day earlier 46 of 49 did. Pass `live` alongside `mainOnly`: a fixture with
 * both pregame and in-play prices legitimately has one main line for EACH, so
 * filtering on is_main alone returns two.
 */
export async function fetchMarkets(
  fixtureId: string,
  opts: { mainOnly?: boolean; live?: boolean | null } = {},
): Promise<Market[]> {
  let q = getSupabase()
    .from('odds')
    .select(
      'fixture_id,sport,market_id,selection,normalized_selection,outcome_no,line,line_group,is_main,' +
        'sportsbook,is_lay,is_live,open_price,current_price,close_price,flucs,daily_prices,' +
        'price_6h,price_3h,price_1h,price_30m,price_10m,status,updated_at',
    )
    .eq('fixture_id', fixtureId)
  if (opts.mainOnly) q = q.eq('is_main', true)
  if (opts.live != null) q = q.eq('is_live', opts.live)

  const { data, error } = await q.limit(5000).returns<OddsRow[]>()
  if (error) throw error
  return groupMarkets(data ?? [])
}

export function groupMarkets(rows: OddsRow[]): Market[] {
  const markets = new Map<string, Map<string, BookMarket>>()
  for (const r of rows) {
    const marketId = r.market_id ?? 'unknown'
    const bookKey = `${r.sportsbook ?? '?'}|${r.is_lay ? 'lay' : 'back'}|${r.is_live ? 'live' : 'pre'}`
    const byBook = markets.get(marketId) ?? new Map<string, BookMarket>()
    markets.set(marketId, byBook)
    const book =
      byBook.get(bookKey) ??
      ({ book: r.sportsbook ?? '?', isLay: !!r.is_lay, isLive: !!r.is_live, lines: [] } as BookMarket)
    byBook.set(bookKey, book)

    const pairKey = r.pair_key ?? r.line ?? null
    let line = book.lines.find((l) => l.pairKey === pairKey)
    if (!line) {
      line = { pairKey, sides: [] }
      book.lines.push(line)
    }
    line.sides.push({
      selection: r.selection ?? '',
      side: r.normalized_selection ?? '',
      outcomeNo: r.outcome_no,
      price: r.current_price,
      openPrice: r.open_price,
      closePrice: r.close_price,
      status: r.status,
    })
  }
  // outcome_no is the schema's ordering: 1 home/over, 2 away/under, 3 draw.
  for (const byBook of markets.values()) {
    for (const b of byBook.values()) {
      b.lines.sort((x, y) => (x.pairKey ?? 0) - (y.pairKey ?? 0))
      for (const l of b.lines) l.sides.sort((a, c) => (a.outcomeNo ?? 9) - (c.outcomeNo ?? 9))
    }
  }
  return [...markets.entries()].map(([marketId, byBook]) => ({ marketId, books: [...byBook.values()] }))
}

/** The permanent closing record: vig-stripped fair prices per selection. */
export async function fetchClosingPrices(fixtureId: string): Promise<SpRow[]> {
  const { data, error } = await getSupabase()
    .from('odds_sp')
    .select(
      'fixture_id,market_id,selection,outcome_no,line,line_group,book_prices,book_fairs,' +
        'book_overround,fair_blend,fair_prob,n_books,blend_books,blend_tier',
    )
    .eq('fixture_id', fixtureId)
    .order('line_group', { ascending: true })
    .limit(5000)
    .returns<SpRow[]>()
  if (error) throw error
  return data ?? []
}
