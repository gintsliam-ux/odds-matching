import type { Fixture, FixtureStatus, PeriodScore } from './types'
import { prettyLeague, prettySport, reclassifySport, sportGroupKey } from './sports'
import { espnLogoUrl } from './teamLogos'
import { cachedLogo, ensureLogoCache } from './logoCache'
import { countryFlagUrl } from './countryFlags'
import { melbDayRangeUtc } from './dates'
import { getSupabase } from './supabase'

const TABLE = 'live_fixtures'

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

// The feed sometimes leaves `is_live=true` long after a game ends (seen 10–20h),
// which would otherwise show a runaway live clock.
//
// The test for that is whether the feed has STOPPED UPDATING, not how long ago
// the game started. "No sport runs longer than 8h" is simply untrue: a Test
// match runs five days, and West Indies v Pakistan sat 62.7 h past its
// actual_start with live_updated_at moving seconds earlier — genuinely live,
// and shown as completed.
//
// A live game's feed ticks constantly; a runaway flag's does not. This window
// has to clear the longest real lull in play (rain, innings break, half-time)
// while still catching a dead feed sooner than the old rule did.
const STALE_LIVE_FEED_H = 3
// Fallback only, for rows carrying no heartbeat at all.
const STALE_LIVE_H = 8
/** A scheduled fixture that never got odds, live data, or an actual_start
 *  and is this many hours past kickoff is a ghost — postponed, cancelled, or
 *  duplicated. Demote to completed in the UI so it doesn't sit forever as
 *  "upcoming" stuck-overdue. */
const STALE_GHOST_H = 4

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
    .returns<Row[]>()

  if (error) throw error
  const nowMs = Date.now()
  return (data ?? []).map((r) => mapRow(r, nowMs))
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
    .returns<Row[]>()

  if (error) throw error
  const nowMs = Date.now()
  return (data ?? []).map((r) => mapRow(r, nowMs))
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
    .returns<Row[]>()
  if (error) throw error
  const nowMs = Date.now()
  return (data ?? []).map((r) => mapRow(r, nowMs))
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
    .returns<Row[]>()
  if (error) throw error
  const nowMs = Date.now()
  return (data ?? []).map((r) => mapRow(r, nowMs))
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
    .returns<Row[]>()
  if (error) throw error
  const rows = data ?? []
  const nowMs = Date.now()
  return { rows: rows.map((r) => mapRow(r, nowMs)), hasMore: rows.length === SPORT_PAGE_SIZE }
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
  let q = getSupabase().from(TABLE).select(COLUMNS).eq('league', rawLeague)
  if (rawSeasonType) q = q.eq('season_type', rawSeasonType)
  const { data, error } = await q
    .order('scheduled_start', { ascending: false })
    .limit(1000)
    .returns<Row[]>()
  if (error) throw error
  const nowMs = Date.now()
  const want = sportGroupKey(prettySport(reclassifySport(rawSport, rawLeague)))
  return (data ?? [])
    .map((r) => mapRow(r, nowMs))
    .filter((f) => !want || sportGroupKey(f.sport) === want)
}

/** A single fixture by its OpticOdds id — used when deep-linking the detail page
 *  to a fixture that's outside the board's window. */
export async function fetchFixtureById(id: string): Promise<Fixture | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(COLUMNS)
    .eq('optic_fixture_id', id)
    .limit(1)
    .returns<Row[]>()

  if (error) throw error
  await ensureLogoCache()
  const row = data?.[0]
  return row ? mapRow(row, Date.now()) : null
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

interface Row {
  optic_fixture_id: string | null
  sport: string | null
  league: string | null
  home_team: string | null
  away_team: string | null
  scheduled_start: string | null
  actual_start: string | null
  status: string | null
  is_live: boolean | null
  home_score: number | null
  away_score: number | null
  /**
   * The closing_* columns were DROPPED from live_fixtures. Everything they held
   * now lives in pregame_odds (per book, per line), so the odds below are
   * derived from that instead. Declared optional purely so a re-added column
   * would still type-check.
   */
  closing_bookmaker?: string | null
  /** Which book the live in-play prices come from. Not currently published by
   *  the feed — see liveBookmaker in mapRow. */
  live_bookmaker?: string | null
  live_h2h_home: number | null
  live_h2h_draw: number | null
  live_h2h_away: number | null
  live_updated_at: string | null
  updated_at: string | null
  venue: string | null
  broadcast: string | null
  season_type: string | null
  period_scores: { home?: Record<string, number | null>; away?: Record<string, number | null> } | null
  pregame_odds: import('./types').PregameOdds | null
  flucs: import('./types').Flucs | null
  open_at: string | null
  close_at: string | null
  // Optional logo/headshot columns — not present yet, but read if the scraper
  // ever persists OpticOdds' team/player image URLs.
  home_team_logo?: string | null
  away_team_logo?: string | null
  home_logo?: string | null
  away_logo?: string | null
}

/** `{home:{period_1:N,..}, away:{...}}` → ordered [{index, home, away}]. */
function parsePeriods(ps: Row['period_scores']): PeriodScore[] {
  if (!ps || typeof ps !== 'object') return []
  const home = ps.home ?? {}
  const away = ps.away ?? {}
  const idx = new Set<number>()
  for (const k of [...Object.keys(home), ...Object.keys(away)]) {
    const m = /(?:period|set|inning|quarter)_?(\d+)/i.exec(k) ?? /^(\d+)$/.exec(k)
    if (m) idx.add(Number(m[1]))
  }
  return [...idx]
    .sort((a, b) => a - b)
    .map((i) => ({
      index: i,
      home: numOrNull(home[`period_${i}`]),
      away: numOrNull(away[`period_${i}`]),
    }))
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * A single representative h2h price per outcome, taken across the books in
 * `pregame_odds` — the board's odds column and the "before kickoff" reference
 * now that closing_h2h_* is gone.
 *
 * MEDIAN, not best and not a favoured book: the best price is an outlier by
 * construction, and picking one book leaves the column blank whenever that book
 * is absent (Pinnacle covers most fixtures but far from all).
 */
function consensusH2h(pregame: unknown): { home: number | null; draw: number | null; away: number | null } {
  const h2h = (pregame as { h2h?: Record<string, unknown> } | null)?.h2h
  const out = { home: null as number | null, draw: null as number | null, away: null as number | null }
  if (!h2h || typeof h2h !== 'object') return out
  for (const side of ['home', 'draw', 'away'] as const) {
    const vals: number[] = []
    for (const [book, v] of Object.entries(h2h)) {
      if (book === 'line' || !v || typeof v !== 'object') continue
      const n = (v as Record<string, unknown>)[side]
      if (typeof n === 'number' && Number.isFinite(n)) vals.push(n)
    }
    if (!vals.length) continue
    vals.sort((a, b) => a - b)
    const mid = Math.floor(vals.length / 2)
    out[side] = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
  }
  return out
}

function mapRow(r: Row, nowMs: number): Fixture {
  let status = normStatus(r.status, r.is_live)

  // Demote runaway "live" rows (stale is_live flag) to completed — judged on
  // the feed's heartbeat, falling back to elapsed time when there is none.
  if (status === 'live') {
    const beat = r.live_updated_at ?? r.updated_at
    const beatMs = beat ? Date.parse(beat) : NaN
    if (Number.isFinite(beatMs)) {
      if (nowMs - beatMs > STALE_LIVE_FEED_H * 3_600_000) status = 'completed'
    } else {
      const ref = r.actual_start ?? r.scheduled_start
      if (ref && nowMs - new Date(ref).getTime() > STALE_LIVE_H * 3_600_000) status = 'completed'
    }
  }
  // Ghost upcoming fixtures: scheduled in the past with no actual_start, no
  // pregame_odds and no live data — game didn't happen. Mark completed so they
  // fall out of upcoming counts and stop firing the "OPTIC still upcoming"
  // notification. The closing-line arm of this test went with the columns; it
  // was never load-bearing, since a fixture with a closing line always had
  // pregame odds too.
  if (status === 'upcoming' && !r.actual_start && r.scheduled_start) {
    const overdueMs = nowMs - new Date(r.scheduled_start).getTime()
    if (overdueMs > STALE_GHOST_H * 3_600_000) {
      const noPregame =
        !r.pregame_odds || (typeof r.pregame_odds === 'object' && Object.keys(r.pregame_odds).length === 0)
      const noLive = r.live_h2h_home == null && r.live_updated_at == null
      if (noPregame && noLive) status = 'completed'
    }
  }
  const live = status === 'live'

  // Live games clock off when they actually started; everything else off the
  // scheduled time. The footer kickoff label uses the same reference.
  const startTime =
    (live ? r.actual_start ?? r.scheduled_start : r.scheduled_start ?? r.actual_start) ??
    new Date().toISOString()

  const liveH2h = { home: r.live_h2h_home, draw: r.live_h2h_draw, away: r.live_h2h_away }
  // The last price we hold before kickoff, taken across the books in
  // pregame_odds. It used to come from closing_h2h_*, which no longer exists —
  // leaving the board's odds column blank on 486 of the 703 recent fixtures
  // that have no live price but do have pregame books.
  const closingH2h = consensusH2h(r.pregame_odds)

  // The feed's `sport` needs correcting from the league: generic `rugby` rows
  // mix Union + League, and a few leagues arrive filed under the wrong sport
  // outright. Note the resolveLogo calls below deliberately keep `r.sport` —
  // entity_logos is keyed by the *raw* feed sport, so correcting it here would
  // miss the cache.
  const rawSport = reclassifySport(r.sport ?? '', r.league ?? '')
  return {
    id: r.optic_fixture_id ?? `${r.home_team}-${r.away_team}-${r.scheduled_start}`,
    sport: prettySport(rawSport),
    league: prettyLeague(r.league ?? ''),
    rawSport,
    rawLeague: r.league ?? '',
    status,
    startTime,
    homeName: r.home_team ?? 'Home',
    awayName: r.away_team ?? 'Away',
    homeLogo: resolveLogo(r.sport ?? '', r.league ?? '', r.home_team ?? '', r.home_team_logo ?? r.home_logo ?? null),
    awayLogo: resolveLogo(r.sport ?? '', r.league ?? '', r.away_team ?? '', r.away_team_logo ?? r.away_logo ?? null),
    homeScore: r.home_score ?? null,
    awayScore: r.away_score ?? null,
    clock: null,
    // Prefer live prices when in-play, fall back to the closing line.
    oddsHome: liveH2h.home ?? closingH2h.home,
    oddsDraw: liveH2h.draw ?? closingH2h.draw,
    oddsAway: liveH2h.away ?? closingH2h.away,

    opticId: r.optic_fixture_id,
    scheduledStart: r.scheduled_start,
    actualStart: r.actual_start,
    venue: r.venue,
    broadcast: r.broadcast,
    seasonType: r.season_type,
    liveUpdatedAt: r.live_updated_at,
    updatedAt: r.updated_at,
    bookmaker: r.closing_bookmaker ?? null,
    liveBookmaker: r.live_bookmaker ?? null,
    liveH2h,
    closingH2h,
    spread: {
      line: null,
      home: null,
      away: null,
    },
    total: {
      line: null,
      over: null,
      under: null,
    },
    periods: parsePeriods(r.period_scores),
    pregameOdds: r.pregame_odds ?? null,
    flucs: r.flucs ?? null,
    openAt: r.open_at ?? null,
    closeAt: r.close_at ?? null,
  }
}

function normStatus(status: string | null, isLive: boolean | null): FixtureStatus {
  if (isLive === true) return 'live'
  const s = (status ?? '').toLowerCase()
  if (['live', 'in_play', 'inplay', 'playing', 'started'].includes(s)) return 'live'
  if (['completed', 'final', 'finished', 'ended', 'closed', 'ft'].includes(s)) return 'completed'
  return 'upcoming'
}
