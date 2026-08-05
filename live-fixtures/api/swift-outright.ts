// POST /api/swift-outright — SwiftBet's outright markets for one event.
//
// Golf's book side is a single event carrying the whole field, with the prices
// living in `markets[].selections[]` rather than in the flat h2h/spread columns
// every other sport uses. Nothing else in the app reads that structure, hence a
// dedicated endpoint.
//
// Body:  { eventId: string, market?: string }   // market defaults to the winner
// Response:
//   { event: { id, name, competition, start, status },
//     markets: [{ name, selections: [{ name, odds, status }] }] }
//
// Selections come back sorted shortest-price first — the caller wants
// favourites, and sorting here keeps that ordering identical everywhere.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const MONGO_COLL = process.env.MONGO_COLL ?? 'events'

let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

interface RawSelection {
  name?: unknown
  odds?: unknown
  status?: unknown
}
interface RawMarket {
  name?: unknown
  selections?: unknown
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      eventId?: string
      market?: string
    }
    const eventId = typeof body.eventId === 'string' ? body.eventId : ''
    if (!eventId) {
      res.status(400).json({ error: 'eventId is required' })
      return
    }

    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MONGO_COLL)
    const d = await coll.findOne(
      { _id: eventId as unknown as string },
      { projection: { _id: 1, name: 1, status: 1, start_date: 1, competition: 1, sport: 1, markets: 1 } },
    )
    if (!d) {
      res.status(200).json({ event: null, markets: [] })
      return
    }

    const wanted = (body.market ?? '').trim().toLowerCase()
    const raw = Array.isArray(d.markets) ? (d.markets as RawMarket[]) : []
    const markets = raw
      .filter((m) => (wanted ? String(m.name ?? '').toLowerCase() === wanted : true))
      .map((m) => {
        const sels = Array.isArray(m.selections) ? (m.selections as RawSelection[]) : []
        const selections = sels
          .map((s) => ({
            name: typeof s.name === 'string' ? s.name : null,
            odds: typeof s.odds === 'number' && Number.isFinite(s.odds) ? s.odds : null,
            status: typeof s.status === 'string' ? s.status : null,
          }))
          // A withdrawn runner is left in the market at odds 1 with status
          // "suspended" (3 of 150 on Wyndham). Keeping it would put a phantom
          // 1.00 at the top of a favourites list.
          .filter((s) => s.name && s.odds != null && s.odds > 1 && s.status !== 'suspended')
          .sort((a, b) => (a.odds ?? 0) - (b.odds ?? 0))
        return { name: (m.name as string | null) ?? null, selections }
      })

    const competition = d.competition as { id?: string; name?: string } | undefined
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({
      event: {
        id: String(d._id),
        name: (d.name as string | null) ?? null,
        competition: competition?.name ?? null,
        competitionId: competition?.id ?? null,
        start: (d.start_date as string | null) ?? null,
        status: (d.status as string | null) ?? null,
      },
      markets,
    })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

export const config = { maxDuration: 20 }
