import type { Fixture, FixtureStatus, PeriodScore } from './types'
import { prettyLeague, prettySport, reclassifyRugbySport } from './sports'
import { espnLogoUrl } from './teamLogos'
import { cachedLogo, ensureLogoCache } from './logoCache'
import { melbDayRangeUtc } from './dates'
import { getSupabase } from './supabase'

const TABLE = 'live_fixtures'

// Window for the board: everything scheduled up to this far ahead, plus all
// currently-live games regardless of their (possibly stale) scheduled_start.
const UPCOMING_HORIZON_H = 6
const RECENT_COMPLETED_H = 3
const ROW_LIMIT = 500

// The feed sometimes leaves `is_live=true` long after a game ends (seen 10–20h).
// No sport runs this long, so treat such rows as finished rather than show a
// runaway live clock.
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
): Promise<{ rows: Fixture[]; hasMore: boolean }> {
  await ensureLogoCache()
  const from = page * SPORT_PAGE_SIZE
  const to = from + SPORT_PAGE_SIZE - 1
  const list = Array.isArray(rawSports) ? rawSports : [rawSports]
  let q = getSupabase().from(TABLE).select(COLUMNS)
  q = list.length === 1 ? q.eq('sport', list[0]) : q.in('sport', list)
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
  let q = getSupabase().from(TABLE).select(COLUMNS).eq('sport', rawSport).eq('league', rawLeague)
  if (rawSeasonType) q = q.eq('season_type', rawSeasonType)
  const { data, error } = await q
    .order('scheduled_start', { ascending: false })
    .limit(1000)
    .returns<Row[]>()
  if (error) throw error
  const nowMs = Date.now()
  return (data ?? []).map((r) => mapRow(r, nowMs))
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

/** Logo precedence: feed column → ESPN majors → resolved cache → monogram (null). */
function resolveLogo(sport: string, league: string, name: string, feedLogo: string | null): string | null {
  return feedLogo ?? espnLogoUrl(sport, league, name) ?? cachedLogo(sport, name) ?? null
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
  closing_h2h_home: number | null
  closing_h2h_draw: number | null
  closing_h2h_away: number | null
  closing_spread_line: number | null
  closing_spread_home: number | null
  closing_spread_away: number | null
  closing_total_line: number | null
  closing_total_over: number | null
  closing_total_under: number | null
  closing_bookmaker: string | null
  live_h2h_home: number | null
  live_h2h_draw: number | null
  live_h2h_away: number | null
  live_updated_at: string | null
  venue: string | null
  broadcast: string | null
  season_type: string | null
  period_scores: { home?: Record<string, number | null>; away?: Record<string, number | null> } | null
  pregame_odds: import('./types').PregameOdds | null
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

function mapRow(r: Row, nowMs: number): Fixture {
  let status = normStatus(r.status, r.is_live)

  // Demote runaway "live" rows (stale is_live flag) to completed.
  if (status === 'live') {
    const ref = r.actual_start ?? r.scheduled_start
    if (ref && nowMs - new Date(ref).getTime() > STALE_LIVE_H * 3_600_000) status = 'completed'
  }
  // Ghost upcoming fixtures: scheduled in the past with no actual_start, no
  // pregame_odds, no closing line, no live data — game didn't happen. Mark
  // completed so they fall out of upcoming counts and stop firing the
  // "OPTIC still upcoming" notification.
  if (status === 'upcoming' && !r.actual_start && r.scheduled_start) {
    const overdueMs = nowMs - new Date(r.scheduled_start).getTime()
    if (overdueMs > STALE_GHOST_H * 3_600_000) {
      const noPregame =
        !r.pregame_odds || (typeof r.pregame_odds === 'object' && Object.keys(r.pregame_odds).length === 0)
      const noClosing = r.closing_h2h_home == null && r.closing_bookmaker == null
      const noLive = r.live_h2h_home == null && r.live_updated_at == null
      if (noPregame && noClosing && noLive) status = 'completed'
    }
  }
  const live = status === 'live'

  // Live games clock off when they actually started; everything else off the
  // scheduled time. The footer kickoff label uses the same reference.
  const startTime =
    (live ? r.actual_start ?? r.scheduled_start : r.scheduled_start ?? r.actual_start) ??
    new Date().toISOString()

  const liveH2h = { home: r.live_h2h_home, draw: r.live_h2h_draw, away: r.live_h2h_away }
  const closingH2h = { home: r.closing_h2h_home, draw: r.closing_h2h_draw, away: r.closing_h2h_away }

  // Generic `rugby` rows mix Union + League — reclassify by league name so
  // they slot under the proper Rugby Union / Rugby League sidebar entry.
  const rawSport = reclassifyRugbySport(r.sport ?? '', r.league ?? '')
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
    bookmaker: r.closing_bookmaker,
    liveH2h,
    closingH2h,
    spread: {
      line: r.closing_spread_line,
      home: r.closing_spread_home,
      away: r.closing_spread_away,
    },
    total: {
      line: r.closing_total_line,
      over: r.closing_total_over,
      under: r.closing_total_under,
    },
    periods: parsePeriods(r.period_scores),
    pregameOdds: r.pregame_odds ?? null,
  }
}

function normStatus(status: string | null, isLive: boolean | null): FixtureStatus {
  if (isLive === true) return 'live'
  const s = (status ?? '').toLowerCase()
  if (['live', 'in_play', 'inplay', 'playing', 'started'].includes(s)) return 'live'
  if (['completed', 'final', 'finished', 'ended', 'closed', 'ft'].includes(s)) return 'completed'
  return 'upcoming'
}
