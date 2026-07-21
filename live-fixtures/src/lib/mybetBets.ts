// Client for /api/mybet-bets — MyBet bets (gutsy.multi_bets, license "MyBet")
// on one game, joined by the mybet event_identifier (singles) or leg
// description (multis).

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
  is_multi: boolean
  leg_count: number
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
