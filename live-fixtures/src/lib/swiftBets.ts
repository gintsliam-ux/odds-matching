// Client for /api/swift-bets — fetches SwiftBet bets matched to a single game,
// by the leg's SwiftBet event_id when the bet carries one, else by the
// derived.event_key/legs_event_keys slug join.

/** Coarse settlement state derived from SwiftBet's `bet_status`.
 *
 *  - `pending`  the book hasn't resulted it yet ("Unresulted"/"Unsettled")
 *  - `settled`  resulted and paid out ("paid")
 *  - `void`     money returned or the bet never stood ("FullyRefunded",
 *               "PartiallyRefunded", "Rejected", "Cancelled", "Failed")
 *  - `unknown`  no bet_status — every bet placed before 2026-07-31, when
 *               SwiftBet added the field. NOT the same as pending: we simply
 *               don't know, so callers must not count these as outstanding.
 *
 *  Upstream casing is inconsistent ("paid" lower-case, the rest PascalCase),
 *  so this lower-cases before comparing.
 */
export type BetSettlement = 'pending' | 'settled' | 'void' | 'unknown'

export function betSettlement(betStatus: string | null | undefined): BetSettlement {
  const s = (betStatus ?? '').trim().toLowerCase()
  if (!s) return 'unknown'
  if (s === 'paid') return 'settled'
  if (s.startsWith('unresulted') || s.startsWith('unsettled')) return 'pending'
  if (s.includes('refund') || s === 'rejected' || s === 'cancelled' || s === 'failed') return 'void'
  // An unrecognised value is more likely a new settled/void state than a
  // pending one — treat it as unknown rather than inventing an outstanding bet.
  return 'unknown'
}

export interface SwiftBetRow {
  id: string
  bet_id: string
  user_id: string
  bet_time: string | null
  bet_amount: number | null
  bet_type: string | null
  odd: number | null
  pl: number | null
  /** SwiftBet's settlement state — "paid" | "Unresulted" | "FullyRefunded" |
   *  "Rejected" | … Null on bets from before 2026-07-31, when the field was
   *  added. Casing is inconsistent upstream, so normalise before comparing. */
  bet_status: string | null
  is_bonus: boolean
  sport: string | null
  type: string | null // SINGLE | MULTI
  market_category: string | null
  /** The book's market label ("Outright Winner", "3-Ball", "Top 5"). Prefer it
   *  over market_category, which flattens a matchup to the sport name. */
  market_raw?: string | null
  /** The event as the book names it. For an outright that's the tournament;
   *  for a matchup it's the pairing. */
  event_name?: string | null
  event_key: string | null
  legs_event_keys: string[]
  matched_leg_index: number
  /** How the bet was joined to this game: the leg's own SwiftBet `event_id`
   *  (exact) or the derived event_key slug (name/date based). */
  matched_by: 'event_id' | 'slug'
  // Leg-specific market / outcome / price for the leg that IS this game (for a
  // single, the whole bet). `selections` holds every pick in that leg — one for
  // a single/normal multi leg, several for a Same Game Multi (where `odds` is
  // the combined SGM price). Lets the UI show the real selection and expand SGMs.
  matched_leg: {
    market: string | null
    mt: string | null
    outcome: string | null
    odds: number | null
    status: string | null
    selections: Array<{
      market: string | null
      mt: string | null
      outcome: string | null
      odds: number | null
      status: string | null
    }>
  } | null
  leg_count: number
  leg_breakdown:
    | Array<{ sport: string; market_category: string; result: string | null; share: number }>
    | null
  em_percent: number | null
  scratched: boolean
  placed_after_start: boolean
  /** Real UTC placement time (bet_time is Melbourne wall-clock). */
  placed_at_utc: string | null
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
  /** The mapped `gutsy.events._id`. Newer bets carry it on each leg, letting the
   *  server join exactly instead of by team-name slug. */
  swiftEventId?: string | null
  swiftActualStart?: string | null
  /** The fixture's scheduled start. Same-teams doubleheaders/series share a
   *  date+teams slug, so the server keeps only bets whose leg event_time is
   *  near this — pinning each bet to the correct game. */
  scheduledStart?: string | null
  /** OUTRIGHT: OPTIC's tournament name. Joins on `derived.event_tournament`,
   *  which reaches finished tournaments and matchup bets that the event id
   *  cannot — and works even when the tournament has no SwiftBet mapping. */
  tournament?: string | null
  /** OUTRIGHT: the sport as `derived.event_sport` spells it, e.g. "Golf". */
  eventSport?: string | null
}): Promise<SwiftBetRow[]> {
  const res = await fetch('/api/swift-bets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: args.date,
      home: args.home,
      away: args.away,
      swiftEventId: args.swiftEventId ?? undefined,
      swiftActualStart: args.swiftActualStart ?? undefined,
      scheduledStart: args.scheduledStart ?? undefined,
      tournament: args.tournament ?? undefined,
      eventSport: args.eventSport ?? undefined,
    }),
  })
  if (!res.ok) throw new Error(`swift-bets ${res.status}`)
  const json = (await res.json()) as { bets: SwiftBetRow[] }
  return json.bets ?? []
}
