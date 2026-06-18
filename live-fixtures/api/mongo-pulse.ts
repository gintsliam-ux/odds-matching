// GET /api/mongo-pulse — health/freshness probe for the SWIFT feed (gutsy.events
// in Mongo). The header shows this next to the OpticOdds "Live feed" pulse so we
// can see at a glance that Mongo is reachable AND still being written to (new
// events arriving, start times / statuses flipping). The board itself reads
// Supabase `live_fixtures`; this endpoint answers the separate question "is the
// upstream SwiftBet scraper alive?".
//
// Response:
//   { ok, serverNow, newestScrapedAt, ageSec, live, prematch, postmatch, total,
//     sports: [{ name, total, live }] }   // sports sorted live-desc for a tooltip
//
// Env required: MONGO_URI (MONGO_DB defaults "gutsy", MONGO_COLL defaults "events").

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const MONGO_COLL = process.env.MONGO_COLL ?? 'events'

// Fluid Compute reuses instances, so the client survives between invocations.
let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

export interface MongoPulse {
  ok: boolean
  serverNow: string
  newestScrapedAt: string | null
  ageSec: number | null
  live: number
  prematch: number
  postmatch: number
  total: number
  sports: Array<{ name: string; total: number; live: number }>
}

/** One aggregation pass: status histogram, newest scrape stamp, per-sport
 *  live/total. Mirrored in scripts/vite-swift-api.ts for the dev server. */
export async function readMongoPulse(): Promise<MongoPulse> {
  const client = await getClient()
  const coll = client.db(MONGO_DB).collection(MONGO_COLL)
  const [agg] = await coll
    .aggregate<{
      byStatus: Array<{ _id: string | null; n: number }>
      newest: Array<{ scraped_at: string | Date | null }>
      bySport: Array<{ _id: string | null; total: number; live: number }>
    }>([
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
          newest: [{ $sort: { scraped_at: -1 } }, { $limit: 1 }, { $project: { scraped_at: 1 } }],
          bySport: [
            {
              $group: {
                _id: '$sport.name',
                total: { $sum: 1 },
                live: { $sum: { $cond: [{ $eq: ['$status', 'inprogress'] }, 1, 0] } },
              },
            },
            { $sort: { live: -1, total: -1 } },
          ],
        },
      },
    ])
    .toArray()

  const byStatus = new Map((agg?.byStatus ?? []).map((r) => [r._id, r.n]))
  const rawNewest = agg?.newest?.[0]?.scraped_at ?? null
  const newestScrapedAt = rawNewest ? new Date(rawNewest).toISOString() : null
  const serverNow = new Date().toISOString()
  const ageSec = newestScrapedAt
    ? Math.max(0, Math.round((Date.parse(serverNow) - Date.parse(newestScrapedAt)) / 1000))
    : null
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0)
  const sports = (agg?.bySport ?? [])
    .filter((s) => s._id)
    .map((s) => ({ name: s._id as string, total: s.total, live: s.live }))

  return {
    ok: true,
    serverNow,
    newestScrapedAt,
    ageSec,
    live: byStatus.get('inprogress') ?? 0,
    prematch: byStatus.get('prematch') ?? 0,
    postmatch: byStatus.get('postmatch') ?? 0,
    total,
    sports,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'GET only' })
    return
  }
  try {
    const pulse = await readMongoPulse()
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json(pulse)
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e as { message?: unknown })?.message ?? e) })
  }
}
