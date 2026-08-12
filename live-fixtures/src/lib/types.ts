// Normalized fixture model the UI renders against. The data source (mock today,
// the Supabase `live_fixtures` table later) maps its own columns into this shape,
// so swapping sources never touches a component.

export type FixtureStatus = 'live' | 'upcoming' | 'completed'

export interface OddsLine {
  home: number | null
  draw: number | null
  away: number | null
}

export interface SpreadMarket {
  line: number | null
  home: number | null
  away: number | null
}

export interface TotalMarket {
  line: number | null
  over: number | null
  under: number | null
}

/** One period/set/inning/quarter of the line score. */
export interface PeriodScore {
  index: number
  home: number | null
  away: number | null
}

export interface Fixture {
  id: string
  sport: string // prettified, e.g. "Soccer", "Rugby union"
  league: string // prettified, e.g. "EPL", "T20I"
  /** Raw OpticOdds slugs — used to query the DB by tournament/league. */
  rawSport: string
  rawLeague: string
  status: FixtureStatus

  /** Scheduled start, ISO 8601 (UTC). Drives kickoff time + the live clock. */
  startTime: string

  homeName: string
  awayName: string

  /** Logo/headshot URLs when the feed provides them (else null → monogram). */
  homeLogo: string | null
  awayLogo: string | null

  /** null when the match hasn't started (upcoming). */
  homeScore: number | null
  awayScore: number | null

  /**
   * Game clock supplied by the feed, e.g. "67'", "Q3 04:12", "T7".
   * When null on a live fixture, the UI shows elapsed wall-time since startTime.
   */
  clock: string | null

  /** Card display odds (live price when in-play, else closing). Draw null = 2-way. */
  oddsHome: number | null
  oddsDraw: number | null
  oddsAway: number | null

  // --- full detail (shown when a card is opened) ---
  opticId: string | null
  scheduledStart: string | null
  actualStart: string | null
  venue: string | null
  broadcast: string | null
  seasonType: string | null
  liveUpdatedAt: string | null
  /**
   * Row's last write. On a COMPLETED fixture this is effectively when the game
   * ended: verified that it stops moving at completion (0 of 200 fixtures from
   * 4 days ago had an updated_at inside the last 6 h) and sits a median 1.98 h
   * after scheduled_start, i.e. one game's duration. OPTIC exposes no explicit
   * end time, so this is the best available. Meaningless while a game is live.
   */
  updatedAt: string | null
  bookmaker: string | null
  /** Book behind the live in-play prices, when the feed names one. */
  liveBookmaker: string | null

  liveH2h: OddsLine
  /** In-play spread and total. Each carries its own line, which need not match
   *  any line the books quoted before the jump. */
  liveSpread: { line: number | null; home: number | null; away: number | null }
  liveTotal: { line: number | null; over: number | null; under: number | null }
  closingH2h: OddsLine
  spread: SpreadMarket
  total: TotalMarket

  /** Per-period line score (sets / innings / quarters / periods), in order. */
  periods: PeriodScore[]

  /**
   * Closing pregame odds per bookmaker. Structure mirrors the `pregame_odds`
   * column in `live_fixtures`: each market has a `line` (for spread/total) and
   * one nested object per bookmaker keyed by book name.
   */
  pregameOdds: PregameOdds | null
  /** Per-book price history at fixed stages before the jump. */
  flucs: Flucs | null
  /** When the market first opened / was last priced before going off. */
  openAt: string | null
  closeAt: string | null
}

export interface PregameH2hBook {
  home?: number | null
  away?: number | null
  draw?: number | null
}
export interface PregameSpreadBook {
  home?: number | null
  away?: number | null
}
export interface PregameTotalBook {
  over?: number | null
  under?: number | null
}
export interface PregameOdds {
  h2h?: { line?: number | null } & Record<string, PregameH2hBook>
  spread?: { line?: number | null } & Record<string, PregameSpreadBook>
  total?: { line?: number | null } & Record<string, PregameTotalBook>
}

/** The stages a fluc is snapshotted at, oldest first. Not every stage exists on
 *  every book — a book listed 20 minutes before the jump has no `6h`, and only
 *  a fixture that has actually closed has a `close`. */
export const FLUC_STAGES = ['open', '6h', '30m', '10m', 'close'] as const
export type FlucStage = (typeof FLUC_STAGES)[number]

/** One snapshot: the prices at that moment, plus when it was taken. Carries the
 *  same outcome keys as the matching pregame_odds book, so h2h has home/away
 *  (/draw), total has over/under and spread has home/away (+ its own line). */
export interface FlucSnapshot {
  at?: string | null
  home?: number | null
  away?: number | null
  draw?: number | null
  over?: number | null
  under?: number | null
  line?: number | null
}

/** live_fixtures.flucs — market → book → stage → snapshot. */
export interface Flucs {
  h2h?: Record<string, Partial<Record<FlucStage, FlucSnapshot>>>
  spread?: Record<string, Partial<Record<FlucStage, FlucSnapshot>>>
  total?: Record<string, Partial<Record<FlucStage, FlucSnapshot>>>
}

export type StatusFilter = 'all' | FixtureStatus

export interface Filters {
  status: StatusFilter
  sport: string // "all" or a sport name
  league: string // "all" or a league name
  search: string
}
