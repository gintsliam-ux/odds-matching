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
  bookmaker: string | null

  liveH2h: OddsLine
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

export type StatusFilter = 'all' | FixtureStatus

export interface Filters {
  status: StatusFilter
  sport: string // "all" or a sport name
  league: string // "all" or a league name
  search: string
}
