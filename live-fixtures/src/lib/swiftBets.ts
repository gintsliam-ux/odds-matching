// Client for /api/swift-bets — fetches SwiftBet bets matched to a single game
// via the derived.event_key/legs_event_keys slug join.

export interface SwiftBetRow {
  id: string
  bet_id: string
  user_id: string
  bet_time: string | null
  bet_amount: number | null
  bet_type: string | null
  odd: number | null
  pl: number | null
  is_bonus: boolean
  sport: string | null
  type: string | null // SINGLE | MULTI
  market_category: string | null
  event_key: string | null
  legs_event_keys: string[]
  matched_leg_index: number
  // Leg-specific market / outcome / price for the leg that IS this game (for a
  // single, the whole bet). Lets the UI show the actual selection + leg odds
  // rather than a multi's combined headline.
  matched_leg: {
    market: string | null
    outcome: string | null
    odds: number | null
    status: string | null
  } | null
  leg_count: number
  leg_breakdown:
    | Array<{ sport: string; market_category: string; result: string | null; share: number }>
    | null
  em_percent: number | null
  scratched: boolean
  placed_after_start: boolean
}

/**
 * Fetch SwiftBet bets that touch this game.
 *
 * `date` is the YYYY-MM-DD prefix of the SWIFT event's start_date (indexed
 * via `derived.event_date_iso`). The server builds a regex of
 * `/<date>/<home>-vs-<away>` to match against `derived.legs_event_keys`. If
 * `swiftActualStart` is provided, each row carries `placed_after_start` so
 * the UI can flag late bets that landed after SwiftBet should have closed
 * the market.
 */
export async function fetchSwiftBets(args: {
  date: string
  home: string
  away: string
  swiftActualStart?: string | null
}): Promise<SwiftBetRow[]> {
  const res = await fetch('/api/swift-bets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: args.date,
      home: args.home,
      away: args.away,
      swiftActualStart: args.swiftActualStart ?? undefined,
    }),
  })
  if (!res.ok) throw new Error(`swift-bets ${res.status}`)
  const json = (await res.json()) as { bets: SwiftBetRow[] }
  return json.bets ?? []
}
