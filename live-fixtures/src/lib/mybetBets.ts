// Client for /api/mybet-bets — MyBet bets (gutsy.multi_bets, license "MyBet")
// on one game, joined by the mybet event_identifier (singles) or leg
// description (multis).

/** One leg of a mybet multi (from the bet's `legs[]`), normalised for display. */
export interface MybetLeg {
  sport: string | null
  event: string | null
  outcome: string | null
  odds: number | null
  date: string | null
}

/** Settlement state for a mybet bet, read from its free-text `bet_status`.
 *
 *  mybet has no enum like SwiftBet's. Instead the placement row's status is
 *  rewritten as the bet moves:
 *
 *    "Accepted"              taken, not yet resulted        -> pending
 *    "No Return"             resulted, nothing came back    -> settled (lost)
 *    "Return @<br>Tkt  N"    resulted, money returned       -> settled (won/part)
 *    "Rejected"              never stood                    -> void
 *    "Cancelled at Tkt: N"   cancelled                      -> void
 *
 *  The paired "Return of<br>Tkt: N" / "Cancellation of Tkt: N" rows are the
 *  CREDIT transactions, not bets — api/mybet-bets.ts filters those out, so they
 *  should never reach here.
 */
export type MybetSettlement = 'pending' | 'settled' | 'void' | 'unknown'

export function mybetSettlement(betStatus: string | null | undefined): MybetSettlement {
  const s = (betStatus ?? '').replace(/<br\s*\/?>/gi, ' ').trim().toLowerCase()
  if (!s) return 'unknown'
  if (s.startsWith('accepted')) return 'pending'
  if (s.startsWith('no return') || s.startsWith('return')) return 'settled'
  if (s.startsWith('rejected') || s.startsWith('cancel')) return 'void'
  return 'unknown'
}

export interface MybetBetRow {
  id: string
  transaction_id: number | null
  user_accountID: number | null
  transaction_date: string | null
  amount_bet: number | null
  price: number | null
  selections: string | null
  bet_type: string | null
  bet_status: string | null
  bet_result: number | null
  is_bonus: boolean
  sgm: boolean
  sport: string | null
  /** Upstream event label — for an outright this names the market, e.g.
   *  "PGA Rocket Classic 2026 - Winner". */
  event_string: string | null
  is_multi: boolean
  leg_count: number
  legs: MybetLeg[]
  /** How the bet joined this game: the single's event_identifier, or a multi
   *  leg's description matched on both team names. */
  matched_by: 'event_id' | 'leg_desc'
  /** Placed after OPTIC went live (past a 2-min grace) — only set when `liveAt`
   *  was supplied. The core "bet landed after the game started" signal. */
  placed_after_live: boolean
}

export async function fetchMybetBets(args: {
  /** gutsy.mybet_events._id (numeric) for this fixture's mybet mapping. */
  eventId: string | number
  /** Event close time — centres the transaction_date scan window. */
  suspendAt?: string | null
  home?: string | null
  away?: string | null
  /** When OPTIC went live — flags bets placed after it as `placed_after_live`. */
  liveAt?: string | null
}): Promise<MybetBetRow[]> {
  const res = await fetch('/api/mybet-bets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: args.eventId,
      suspendAt: args.suspendAt ?? undefined,
      home: args.home ?? undefined,
      away: args.away ?? undefined,
      liveAt: args.liveAt ?? undefined,
    }),
  })
  if (!res.ok) throw new Error(`mybet-bets ${res.status}`)
  const json = (await res.json()) as { bets: MybetBetRow[] }
  return json.bets ?? []
}
