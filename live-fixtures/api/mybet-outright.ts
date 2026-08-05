// POST /api/mybet-outright — mybet's outright market for a tournament.
//
// mybet stores an outright completely differently from its head-to-heads. An
// h2h event has `match` with A/B lines; an outright has `comps`, an OBJECT
// keyed by competitor id whose values hold the runner name (`team`), the
// current price (`win`) and a price history (`flucs`). Shape, not description
// text, is what identifies one — the golf outrights include "Top 5 Finish" and
// "1st Round Leader", which no keyword search for "winner|outright" would find.
//
// There is no competition id to join on (mybet golf carries `competition: null`)
// so the tournament is matched on the description, which embeds it:
//   "PGA Wyndham Championship 2026 - Winner"
//
// Body:  { tournament: string, market?: string }  // market defaults to Winner
// Response:
//   { event: { id, description, market, suspendAt, outcomeAt, lastSeenAt, open },
//     selections: [{ name, odds }],        // priced only, shortest first
//     markets: string[] }                  // every outright market for it

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const MYBET_COLL = process.env.MONGO_MYBET_COLL ?? 'mybet_events'

let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Comp {
  team?: unknown
  win?: unknown
  eliminated?: unknown
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      tournament?: string
      market?: string
    }
    const tournament = (body.tournament ?? '').trim()
    if (!tournament) {
      res.status(400).json({ error: 'tournament is required' })
      return
    }
    const market = (body.market ?? 'Winner').trim()

    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MYBET_COLL)
    // `comps` present is what makes it an outright rather than a matchup.
    const all = await coll
      .find(
        { sport: 'Golf', comps: { $exists: true }, description: { $regex: esc(tournament), $options: 'i' } },
        { projection: { _id: 1, description: 1, comps: 1, suspendAt: 1, outcomeAt: 1, lastSeenAt: 1 } },
      )
      .limit(25)
      .toArray()

    const marketOf = (d: string | null | undefined) => {
      const parts = String(d ?? '').split(' - ')
      return parts.length > 1 ? parts[parts.length - 1].trim() : ''
    }
    const markets = [...new Set(all.map((d) => marketOf(d.description as string)).filter(Boolean))]
    const doc = all.find((d) => marketOf(d.description as string).toLowerCase() === market.toLowerCase())

    if (!doc) {
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).json({ event: null, selections: [], markets })
      return
    }

    const comps = (doc.comps ?? {}) as Record<string, Comp>
    const selections = Object.values(comps)
      .map((c) => ({
        name: typeof c.team === 'string' ? c.team : null,
        odds: typeof c.win === 'number' && Number.isFinite(c.win) ? c.win : null,
        eliminated: !!c.eliminated,
      }))
      // `win: 0` means no live price — a withdrawn or suspended runner. Keeping
      // it would put a phantom 0.00 at the head of a favourites list.
      .filter((s) => s.name && s.odds != null && s.odds > 0 && !s.eliminated)
      .sort((a, b) => (a.odds ?? 0) - (b.odds ?? 0))
      .map(({ name, odds }) => ({ name, odds }))

    const suspendAt = doc.suspendAt ? new Date(doc.suspendAt as string).toISOString() : null
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({
      event: {
        id: String(doc._id),
        description: (doc.description as string | null) ?? null,
        market: marketOf(doc.description as string),
        suspendAt,
        outcomeAt: doc.outcomeAt ? new Date(doc.outcomeAt as string).toISOString() : null,
        lastSeenAt: doc.lastSeenAt ? new Date(doc.lastSeenAt as string).toISOString() : null,
        open: suspendAt ? Date.parse(suspendAt) > Date.now() : null,
        runners: Object.keys(comps).length,
      },
      selections,
      markets,
    })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

export const config = { maxDuration: 20 }
