// POST /api/mybet-bets — MyBet bets (gutsy.multi_bets, transaction_licenseid
// "MyBet") on one event. The mybet analogue of /api/swift-bets.
//
// Join model:
//   • SINGLES carry `event_identifier` (numeric) === gutsy.mybet_events._id, so
//     they join exactly on the mybet event id passed in.
//   • MULTIS have `event_identifier: 0`; their legs only hold a description
//     string (`multileg_evetdescription`, e.g. "ATP Challenger Segovia - A vs B").
//     When home/away are supplied we also match a leg's description on both team
//     names — best-effort, since there's no per-leg event id.
//
// `event_identifier` isn't indexed, so we bound the scan with the indexed
// `transaction_date` (bets land in the days before the event's close time).
//
// Body:
//   { eventId: number|string,       // gutsy.mybet_events._id
//     suspendAt?: string,           // event close time — centres the date window
//     home?: string, away?: string } // enables multi leg-description matching
// Response: { bets: MybetBetRow[], count }

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const MULTI_COLL = process.env.MONGO_MULTI_COLL ?? 'multi_bets'

let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `transaction_date` is Melbourne wall-clock stored in a Date (a misleading `Z`)
 * — verified as consistently +10/+11h ahead of the true-UTC `_synced_at`. Read
 * the wall-clock components and re-tag them with the correct Australia/Sydney
 * offset for that date (AEST +10 / AEDT +11), then that's the real UTC instant.
 * Mirrors melbWallToUtc in api/swift-bets.ts.
 */
function melbWallToUtc(raw: string | Date | null | undefined): Date | null {
  if (!raw) return null
  const s = raw instanceof Date ? raw.toISOString() : String(raw)
  const wall = s.endsWith('Z') ? s.slice(0, -1) : s
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(wall)
  if (!m) return null
  const trial = new Date(`${wall}+10:00`)
  if (isNaN(trial.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(trial)
  const get = (t: string) => parts.find((p) => p.type === t)?.value
  if (get('year') === m[1] && get('hour') === m[4]) return trial
  return new Date(`${wall}+11:00`)
}

// Bets on an event land mostly in the days before it. Window the indexed
// transaction_date to bound the scan (no index on event_identifier).
const WINDOW_BEFORE_MS = 10 * 86_400_000
const WINDOW_AFTER_MS = 1 * 86_400_000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      eventId?: string | number
      suspendAt?: string
      home?: string
      away?: string
      /** When OPTIC went live — bets placed after this (past a grace) are flagged. */
      liveAt?: string
    }
    const eventId = Number(body.eventId)
    if (!Number.isFinite(eventId) || eventId <= 0) {
      res.status(400).json({ error: 'eventId (numeric mybet event id) is required' })
      return
    }

    // Date window centred on the event's close time (fallback: now).
    // transaction_date is a BSON Date, so the bounds must be Date objects too —
    // string bounds silently match nothing against a Date field.
    const centreMs = body.suspendAt && Number.isFinite(Date.parse(body.suspendAt)) ? Date.parse(body.suspendAt) : Date.now()
    const lo = new Date(centreMs - WINDOW_BEFORE_MS)
    const hi = new Date(centreMs + WINDOW_AFTER_MS)

    // Singles join on event_identifier; multis (event_identifier 0) match on a
    // leg whose description contains BOTH team names — both in the SAME leg (via
    // $elemMatch), so a multi that merely has the two teams in different legs
    // (different games) doesn't false-match.
    const joins: Record<string, unknown>[] = [{ event_identifier: eventId }]
    if (body.home && body.away) {
      joins.push({
        legs: {
          $elemMatch: {
            $and: [
              { multileg_evetdescription: { $regex: esc(body.home), $options: 'i' } },
              { multileg_evetdescription: { $regex: esc(body.away), $options: 'i' } },
            ],
          },
        },
      })
    }

    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MULTI_COLL)
    const cursor = coll
      .find(
        {
          transaction_licenseid: 'MyBet',
          // "Return of Tkt…" / "Return @ Tkt…" rows are SETTLEMENT transactions,
          // not placements — their transaction_date is the settle time (after the
          // game), so they'd falsely read as "placed after live". Settlement is
          // carried by the placement row's own bet_result; drop the returns.
          bet_status: { $not: /^Return/i },
          transaction_date: { $gte: lo, $lte: hi },
          ...(joins.length > 1 ? { $or: joins } : joins[0]),
        },
        {
          projection: {
            _id: 1, transaction_id: 1, user_accountID: 1, transaction_date: 1,
            amount_bet: 1, price: 1, selections: 1, bet_type: 1, bet_status: 1,
            bet_result: 1, bonus_bet: 1, sgm_flag: 1, sport_name: 1,
            event_identifier: 1, event_string: 1, legs: 1,
          },
        },
      )
      .sort({ transaction_date: -1 })
      .limit(300)

    const docs = await cursor.toArray()
    // 2-min grace on the recorded live time — the transition moment isn't exact.
    const AFTER_LIVE_GRACE_MS = 2 * 60_000
    const liveCutoff = body.liveAt && Number.isFinite(Date.parse(body.liveAt)) ? Date.parse(body.liveAt) + AFTER_LIVE_GRACE_MS : null
    const bets = docs.map((d) => {
      const legs = Array.isArray(d.legs) ? d.legs : []
      const byEventId = d.event_identifier === eventId
      // transaction_date is Melbourne wall-clock — convert to real UTC before
      // any comparison against the (UTC) live time, and before returning it.
      const placedUtc = melbWallToUtc(d.transaction_date)
      const placedMs = placedUtc ? placedUtc.getTime() : NaN
      const placedAfterLive = liveCutoff != null && Number.isFinite(placedMs) && placedMs > liveCutoff
      return {
        id: String(d._id),
        transaction_id: d.transaction_id ?? null,
        user_accountID: d.user_accountID ?? null,
        transaction_date: placedUtc ? placedUtc.toISOString() : null,
        amount_bet: (d.amount_bet as number | null) ?? null,
        price: (d.price as number | null) ?? null,
        selections: (d.selections as string | null) ?? null,
        bet_type: (d.bet_type as string | null) ?? null,
        bet_status: (d.bet_status as string | null) ?? null,
        bet_result: (d.bet_result as number | null) ?? null,
        is_bonus: !!d.bonus_bet,
        sgm: !!d.sgm_flag,
        sport: (d.sport_name as string | null) ?? null,
        is_multi: legs.length > 0,
        leg_count: legs.length,
        // Per-leg detail so the UI can show a SwiftBet-style multi breakdown.
        legs: legs.map((lg: Record<string, unknown>) => ({
          sport: (lg.multileg_sport as string | null) ?? null,
          event: (lg.multileg_evetdescription as string | null) ?? null,
          outcome: (lg.multileg_outcome as string | null) ?? null,
          odds: typeof lg.multileg_dividend === 'number' ? (lg.multileg_dividend as number) : null,
          date: lg.multileg_outcomedate ? new Date(lg.multileg_outcomedate as string).toISOString() : null,
        })),
        matched_by: byEventId ? 'event_id' : 'leg_desc',
        placed_after_live: placedAfterLive,
      }
    })

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ bets, count: bets.length })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

export const config = { maxDuration: 30 }
