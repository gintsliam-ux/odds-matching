// POST /api/mybet-status — live mybet (gutsy.mybet_events) state for a batch of
// event ids. The mybet analogue of /api/swift-status, but simpler: mybet has no
// prematch→inprogress flip to capture. Its market-close moment is the scheduled
// `suspendAt` (== `outcomeAt`), which is always present on the doc — so there is
// no side-effect write, we just read and return it.
//
// mybet `_id` is numeric; event_mapping stores it as a string, so we coerce back.
//
// Body:     { ids: string[] }
// Response: { events: MybetEvent[] }   // see the shape below
//
// Env: MONGO_URI, MONGO_DB (default "gutsy"), MONGO_MYBET_COLL (default "mybet_events").

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

function toIso(v: unknown): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as { ids?: unknown }
    const rawIds = Array.isArray(body?.ids) ? (body.ids as unknown[]).map(String) : []
    if (rawIds.length === 0) {
      res.status(200).json({ events: [] })
      return
    }
    // mybet _id is a number; keep both the numeric form (for the query) and the
    // original string (for the response, matching event_mapping.gutsy_event_id).
    const numeric = rawIds.map((s) => Number(s)).filter((n) => Number.isFinite(n))

    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MYBET_COLL)
    const nowMs = Date.now()

    const events: Array<{
      id: string
      sport: string | null
      competition: string | null
      name: string | null
      home: string | null
      away: string | null
      start: string | null
      suspendAt: string | null
      lastSeenAt: string | null
      /** true while the market is scheduled to still be open (now < suspendAt). */
      open: boolean
      status: 'open' | 'closed'
    }> = []

    for (let i = 0; i < numeric.length; i += 500) {
      const chunk = numeric.slice(i, i + 500)
      const docs = await coll
        .find(
          { _id: { $in: chunk } },
          { projection: { _id: 1, sport: 1, league: 1, match: 1, suspendAt: 1, lastSeenAt: 1 } },
        )
        .toArray()
      for (const d of docs) {
        const match = d.match as { teamA?: string; teamB?: string } | undefined
        const home = match?.teamA ?? null
        const away = match?.teamB ?? null
        const suspendAt = toIso(d.suspendAt)
        const open = suspendAt ? Date.parse(suspendAt) > nowMs : false
        events.push({
          id: String(d._id),
          sport: (d.sport as string | null) ?? null,
          competition: (d.league as string | null) ?? null,
          name: home && away ? `${home} vs ${away}` : null,
          home,
          away,
          start: suspendAt,
          suspendAt,
          lastSeenAt: toIso(d.lastSeenAt),
          open,
          status: open ? 'open' : 'closed',
        })
      }
    }

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ events })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

export const config = { maxDuration: 30 }
