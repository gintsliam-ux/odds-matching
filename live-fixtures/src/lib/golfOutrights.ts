import { getSupabase } from './supabase'

/**
 * Golf on the OPTIC side lives in `golf_outrights`, not `live_fixtures`.
 *
 * It isn't a fixture table: there is one row per (tournament, golfer, market,
 * sportsbook), so a single tournament is a few hundred rows of prices rather
 * than one row of a game. Nothing about it fits the home-vs-away shape the rest
 * of the terminal is built on — which is why golf has never appeared in the
 * sport universe, and why it has to be rolled up to a tournament here before
 * the mapping page can list it.
 */
const TABLE = 'golf_outrights'

export interface GolfTournament {
  /** OpticOdds' id for the tournament — stable, and what a mapping should pin to. */
  tournamentId: string
  /** Display name, e.g. "Wyndham Championship 2026". */
  tournament: string
  /** Tour, e.g. "pga". Plays the part `league` does for every other sport. */
  league: string
  startDate: string | null
  endDate: string | null
  /** Distinct markets present — currently only "Winner". */
  markets: string[]
  /** Distinct golfers priced. */
  golfers: number
  /** Distinct sportsbooks quoting it. */
  books: string[]
  /** Most recent price update across the tournament. */
  updatedAt: string | null
}

interface Row {
  tournament_id: string | null
  tournament: string | null
  league: string | null
  start_date: string | null
  end_date: string | null
  market: string | null
  golfer: string | null
  sportsbook: string | null
  updated_at: string | null
}

/**
 * Every golf tournament we hold outright prices for, newest first.
 *
 * Paged because PostgREST caps a response at 1000 rows and this table grows by
 * hundreds per tournament — a single unpaged read would silently truncate and
 * drop whole tournaments off the mapping list.
 */
export async function fetchGolfTournaments(): Promise<GolfTournament[]> {
  const sb = getSupabase()
  const PAGE = 1000
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(TABLE)
      .select('tournament_id,tournament,league,start_date,end_date,market,golfer,sportsbook,updated_at')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
      .returns<Row[]>()
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE) break
  }

  const byId = new Map<string, GolfTournament & { _markets: Set<string>; _books: Set<string>; _golfers: Set<string> }>()
  for (const r of rows) {
    const id = r.tournament_id ?? r.tournament
    if (!id) continue
    let t = byId.get(id)
    if (!t) {
      t = {
        tournamentId: id,
        tournament: r.tournament ?? id,
        league: r.league ?? '',
        startDate: r.start_date,
        endDate: r.end_date,
        markets: [],
        golfers: 0,
        books: [],
        updatedAt: r.updated_at,
        _markets: new Set(),
        _books: new Set(),
        _golfers: new Set(),
      }
      byId.set(id, t)
    }
    if (r.market) t._markets.add(r.market)
    if (r.sportsbook) t._books.add(r.sportsbook)
    if (r.golfer) t._golfers.add(r.golfer)
    if (r.updated_at && (!t.updatedAt || r.updated_at > t.updatedAt)) t.updatedAt = r.updated_at
  }

  return [...byId.values()]
    .map((t) => ({
      tournamentId: t.tournamentId,
      tournament: t.tournament,
      league: t.league,
      startDate: t.startDate,
      endDate: t.endDate,
      markets: [...t._markets].sort(),
      golfers: t._golfers.size,
      books: [...t._books].sort(),
      updatedAt: t.updatedAt,
    }))
    .sort((a, b) => String(b.startDate ?? '').localeCompare(String(a.startDate ?? '')))
}

/** Still to be played, or finished within the last `graceDays`. */
export function isGolfTournamentActive(t: GolfTournament, graceDays = 7): boolean {
  const end = Date.parse(t.endDate ?? t.startDate ?? '')
  if (!Number.isFinite(end)) return true
  return end > Date.now() - graceDays * 86_400_000
}

// --- prices -----------------------------------------------------------------

export interface GolfPrice {
  golfer: string
  /** Best (shortest) price across the OPTIC books, and the per-book detail. */
  best: number | null
  byBook: Record<string, number>
}

/** Every priced golfer in one tournament, shortest price first. */
export async function fetchGolfPrices(tournamentId: string): Promise<GolfPrice[]> {
  const sb = getSupabase()
  const PAGE = 1000
  const rows: Array<{ golfer: string | null; price: number | null; sportsbook: string | null }> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(TABLE)
      .select('golfer,price,sportsbook')
      .eq('tournament_id', tournamentId)
      .eq('market', 'Winner')
      .range(from, from + PAGE - 1)
      .returns<Array<{ golfer: string | null; price: number | null; sportsbook: string | null }>>()
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE) break
  }
  const byGolfer = new Map<string, GolfPrice>()
  for (const r of rows) {
    if (!r.golfer || r.price == null) continue
    let g = byGolfer.get(r.golfer)
    if (!g) byGolfer.set(r.golfer, (g = { golfer: r.golfer, best: null, byBook: {} }))
    if (r.sportsbook) g.byBook[r.sportsbook] = r.price
    if (g.best == null || r.price < g.best) g.best = r.price
  }
  return [...byGolfer.values()].sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity))
}

/**
 * Canonical form of a golfer's name, for joining the two feeds.
 *
 * OPTIC writes "Cameron Young"; SwiftBet writes "Young, Cameron". Sorting the
 * name tokens makes the two identical without having to know which convention a
 * given feed uses. Accents are folded too — the feeds disagree on Højgaard.
 *
 * It does NOT fix short forms: "Zach Bauchou" and "Zachary Bauchou" stay
 * distinct, which is most of the ~15% that doesn't join.
 */
export function golferKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}
