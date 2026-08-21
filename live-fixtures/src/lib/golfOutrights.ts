import { getSupabase } from './supabase'

/**
 * Golf on the OPTIC side is two tables, and they do different jobs.
 *
 *  • `golf_tournaments` — the catalogue. One row per tournament+market, with
 *    the dates, venue, status/is_live/is_active, and how many books list it.
 *    This is the source of truth for what a tournament IS.
 *  • `golf_outrights` — the prices. One row per (tournament, golfer, market,
 *    sportsbook). Only covers tournaments we actually hold prices for, and only
 *    the books we take them from — Wyndham reads book_count 25 in the catalogue
 *    while the price table has FanDuel and Fanatics.
 *
 * Neither is a fixture table, which is why golf has never appeared in the sport
 * universe and has to be rolled up here before the rest of the app can list it.
 *
 * The catalogue used to be derived from the price table. It can't be any more —
 * `golf_outrights.start_date` is now null, so a tournament's dates only exist in
 * `golf_tournaments`.
 */
const TOURNAMENTS = 'golf_tournaments'
const OUTRIGHTS = 'golf_outrights'

export interface GolfTournament {
  /** OpticOdds' id for the tournament — stable, and what a mapping pins to. */
  tournamentId: string
  /** Display name, e.g. "Wyndham Championship 2026". */
  tournament: string
  /** Tour: pga, korn_ferry, liv, legends_tour. Plays the part `league` does. */
  league: string
  /** The outright market this row describes, e.g. "Winner". */
  market: string
  startDate: string | null
  endDate: string | null
  /** OPTIC's own status, e.g. "unplayed". */
  status: string | null
  isLive: boolean
  isActive: boolean
  venueName: string | null
  venueLocation: string | null
  seasonYear: number | null
  /** How many books OPTIC sees listing this tournament. */
  bookCount: number
  /** Which books — a comma-separated list from the feed. */
  booksListed: string[]
  hasGoodBook: boolean
  /** OPTIC's own coverage state: priced / awaiting_good_books / no_books. */
  priceStatus: string | null
  updatedAt: string | null
  /** Distinct golfers we hold a price for. 0 when nothing is priced yet. */
  golfers: number
  /** Books we actually hold prices from — a subset of booksListed. */
  books: string[]
}

interface TRow {
  tournament_id: string | null
  tournament: string | null
  league: string | null
  market: string | null
  start_date: string | null
  end_date: string | null
  status: string | null
  is_live: boolean | null
  is_active: boolean | null
  venue_name: string | null
  venue_location: string | null
  season_year: number | null
  book_count: number | null
  books_listed: string | null
  has_good_book: boolean | null
  price_status: string | null
  updated_at: string | null
}

async function pageAll<T>(table: string, select: string, order: string): Promise<T[]> {
  const sb = getSupabase()
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(order, { ascending: true })
      .range(from, from + PAGE - 1)
      .returns<T[]>()
    if (error) throw error
    const page = data ?? []
    out.push(...page)
    if (page.length < PAGE) break
  }
  return out
}

/** Every golf tournament in the catalogue, newest first, with price coverage. */
export async function fetchGolfTournaments(): Promise<GolfTournament[]> {
  const [tRows, pRows] = await Promise.all([
    pageAll<TRow>(TOURNAMENTS, '*', 'tournament_id'),
    pageAll<{ tournament_id: string | null; golfer: string | null; sportsbook: string | null }>(
      OUTRIGHTS,
      'tournament_id,golfer,sportsbook',
      'id',
    ),
  ])

  // Price coverage per tournament, from the price table.
  const cover = new Map<string, { golfers: Set<string>; books: Set<string> }>()
  for (const p of pRows) {
    if (!p.tournament_id) continue
    let c = cover.get(p.tournament_id)
    if (!c) cover.set(p.tournament_id, (c = { golfers: new Set(), books: new Set() }))
    if (p.golfer) c.golfers.add(p.golfer)
    if (p.sportsbook) c.books.add(p.sportsbook)
  }

  return tRows
    .filter((r) => r.tournament_id)
    .map((r) => {
      const c = cover.get(r.tournament_id as string)
      return {
        tournamentId: r.tournament_id as string,
        tournament: r.tournament ?? (r.tournament_id as string),
        league: r.league ?? '',
        market: r.market ?? 'Winner',
        startDate: r.start_date,
        endDate: r.end_date,
        status: r.status,
        isLive: !!r.is_live,
        isActive: !!r.is_active,
        venueName: r.venue_name,
        venueLocation: r.venue_location,
        seasonYear: r.season_year,
        bookCount: r.book_count ?? 0,
        booksListed: (r.books_listed ?? '')
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean),
        hasGoodBook: !!r.has_good_book,
        priceStatus: r.price_status,
        updatedAt: r.updated_at,
        golfers: c?.golfers.size ?? 0,
        books: c ? [...c.books].sort() : [],
      }
    })
    .sort((a, b) => String(b.startDate ?? '').localeCompare(String(a.startDate ?? '')))
}

/**
 * Should this tournament appear in the current slate?
 *
 * OPTIC now says so directly via `is_active`, which is what we trust. The date
 * fallback only covers a row that predates the flag.
 */
export function isGolfTournamentActive(t: GolfTournament, graceDays = 7): boolean {
  if (t.isActive) return true
  const end = Date.parse(t.endDate ?? t.startDate ?? '')
  if (!Number.isFinite(end)) return false
  return end > Date.now() - graceDays * 86_400_000
}

// --- prices -----------------------------------------------------------------

export interface GolfPrice {
  golfer: string
  /** Best (shortest) price across the books we hold, and the per-book detail. */
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
      .from(OUTRIGHTS)
      .select('golfer,price,sportsbook')
      .eq('tournament_id', tournamentId)
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
 * Letters NFD cannot decompose. A stroked or ligature letter is a distinct
 * codepoint rather than base + combining mark, so normalize() leaves it whole
 * and the [^a-z] strip below would delete it — "Højgaard" became "h jgaard"
 * and stopped matching SwiftBet's "Hojgaard".
 */
const LETTER_FOLD: Record<string, string> = {
  ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', å: 'a', Å: 'a',
  ß: 'ss', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd', ł: 'l', Ł: 'l', þ: 'th', Þ: 'th',
}

/**
 * Canonical form of a golfer's name, for joining the two feeds.
 *
 * OPTIC writes "Cameron Young"; SwiftBet writes "Young, Cameron". Sorting makes
 * the two identical without having to know which convention a feed uses.
 *
 * Sorting *letters* rather than *words* is the part that matters. Sorting words
 * still relies on both feeds breaking a name in the same place, and they do
 * not: "SONG Younghan" split to [song, younghan] while "Young-han Song" split
 * to [han, song, young], so the field fragmented on hyphenated Korean names.
 * Dropping separators first and sorting letters collapses hyphens, periods,
 * initials and word order under one rule, so "Young-han Song", "J.T. Poston"
 * and "Jun Yong Park" now meet "SONG Younghan", "JT Poston" and "JunYong Park".
 *
 * Accents fold first, including the stroked letters NFD leaves whole (see
 * LETTER_FOLD) — without that the [^a-z] strip eats them and "Højgaard" stops
 * matching SwiftBet's "Hojgaard".
 *
 * Two known limits. It does NOT fix short forms: "Zach Bauchou" and "Zachary
 * Bauchou" stay distinct, which is most of what still doesn't join. And a
 * letter multiset can collide: across 5,509 real player names the only wrong
 * merge was "Philipe Lins" against a stray "Phillipines", and the near-misses
 * it does join ("Jaime"/"Jamie", "Jeffery"/"Jeffrey") are the same person.
 */
export function golferKey(name: string): string {
  return name
    .replace(/[øØæÆåÅßđĐðÐłŁþÞ]/g, (c) => LETTER_FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .split('')
    .sort()
    .join('')
}
