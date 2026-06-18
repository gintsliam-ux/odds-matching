// POST /api/swift-bets — return SwiftBet bets that include this game as a leg.
//
// Bets in gutsy.bets link to a game via `derived.event_key` / `derived.legs_event_keys`
// — slug strings like `mlb/2026-06-16/new-york-yankees-vs-chicago-white-sox` that the
// enrichment pipeline computes. The newer `legs` JSON no longer carries the SwiftBet
// event UUID, so slug matching is the practical join.
//
// Body:
//   { date: "YYYY-MM-DD",            // event date (gutsy.events.start_date prefix)
//     home: "New York Yankees",       // home team name
//     away: "Chicago White Sox",      // away team name
//     swiftActualStart?: string }     // ISO timestamp; bets with bet_time > this are flagged
//
// Response:
//   { bets: BetRow[], matchPattern: string }

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const BETS_COLL = process.env.MONGO_BETS_COLL ?? 'bets'

let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

function slug(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `bet_time` in gutsy.bets is Melbourne wall-clock with a misleading `Z`
 * suffix. To compare against UTC timestamps (swift_actual_start) we strip
 * the Z and tag the wall-clock with the correct Australia/Sydney offset for
 * that date — +10 (AEST) outside DST, +11 (AEDT) during DST. Intl confirms
 * the offset round-trip.
 */
function melbWallToUtc(raw: string | Date): Date | null {
  if (!raw) return null
  // Mongo BSON Date arrives as a Date object; normalize to an ISO string.
  const s = raw instanceof Date ? raw.toISOString() : String(raw)
  const wall = s.endsWith('Z') ? s.slice(0, -1) : s
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(wall)
  if (!m) return null
  const trial = new Date(`${wall}+10:00`)
  if (isNaN(trial.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(trial)
  const get = (t: string) => parts.find((p) => p.type === t)?.value
  if (get('year') === m[1] && get('hour') === m[4]) return trial
  return new Date(`${wall}+11:00`)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      date?: string
      home?: string
      away?: string
      swiftActualStart?: string
    }
    if (!body.date || !body.home || !body.away) {
      res.status(400).json({ error: 'date, home and away are required' })
      return
    }
    const homeSlug = slug(body.home)
    const awaySlug = slug(body.away)
    // Slug format: `<sport[-competition]>/<YYYY-MM-DD>/<home>-vs-<away>`. Match either
    // ordering of teams (some sources flip them).
    const matchPattern = new RegExp(
      `/${esc(body.date)}/(${esc(homeSlug)}-vs-${esc(awaySlug)}|${esc(awaySlug)}-vs-${esc(homeSlug)})$`,
    )

    const client = await getClient()
    const bets = client.db(MONGO_DB).collection(BETS_COLL)

    // `bet_date` is indexed; `derived.event_date_iso` isn't. So we narrow by
    // a bet-date window (1 week before to 1 day after the event date — bets
    // for a game are placed in that span) and then regex-match the slug.
    const eventDate = new Date(`${body.date}T00:00:00Z`)
    const loDate = new Date(eventDate.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
    const hiDate = new Date(eventDate.getTime() + 1 * 86_400_000).toISOString().slice(0, 10)
    const cursor = bets
      .find(
        {
          bet_date: { $gte: loDate, $lte: hiDate },
          'derived.is_racing': false,
          'derived.legs_event_keys': { $elemMatch: { $regex: matchPattern } },
        },
        {
          projection: {
            _id: 1,
            bet_id: 1,
            user_id: 1,
            bet_time: 1,
            bet_amount: 1,
            bet_type: 1,
            odd: 1,
            pl: 1,
            is_bonus: 1,
            'derived.event_key': 1,
            'derived.legs_event_keys': 1,
            'derived.event_name': 1,
            'derived.market_category': 1,
            'derived.sport': 1,
            'derived.type': 1,
            'derived.legs_breakdown': 1,
            'enrichment.blendFair': 1,
            'enrichment.emPercent': 1,
            'enrichment.scratched': 1,
          },
        },
      )
      .sort({ bet_time: -1 })
      .limit(200)

    const docs = await cursor.toArray()
    const cutoff = body.swiftActualStart ? Date.parse(body.swiftActualStart) : null
    const result = docs.map((d) => {
      // bet_time is Melbourne wall-clock with a misleading Z; convert to a
      // real UTC moment for the after-start comparison.
      const betUtc = d.bet_time ? melbWallToUtc(d.bet_time) : null
      const placedAfterStart =
        cutoff != null && betUtc != null ? betUtc.getTime() > cutoff : false
      // Pinpoint which leg in a multi corresponds to this game so the UI can
      // call it out — match on the regex against each leg key.
      const legs: string[] = d.derived?.legs_event_keys ?? []
      const matchedLegIndex = legs.findIndex((k) => matchPattern.test(k))
      return {
        id: d._id,
        bet_id: d.bet_id,
        user_id: d.user_id,
        bet_time: d.bet_time,
        bet_amount: d.bet_amount,
        bet_type: d.bet_type,
        odd: d.odd,
        pl: d.pl,
        is_bonus: !!d.is_bonus,
        sport: d.derived?.sport ?? null,
        type: d.derived?.type ?? null,
        market_category: d.derived?.market_category ?? null,
        event_key: d.derived?.event_key ?? null,
        legs_event_keys: legs,
        matched_leg_index: matchedLegIndex,
        leg_count: legs.length,
        leg_breakdown: d.derived?.legs_breakdown ?? null,
        em_percent: d.enrichment?.emPercent ?? null,
        scratched: d.enrichment?.scratched ?? false,
        placed_after_start: placedAfterStart,
      }
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ bets: result, matchPattern: matchPattern.source, count: result.length })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

export const config = { maxDuration: 30 }
