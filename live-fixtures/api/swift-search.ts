// POST /api/swift-search — live name/team search against gutsy.events for the
// MappingEditor picker. The /public/swift-events.json snapshot is built once a
// day by build-mapping; this endpoint lets the editor see newly-added events
// without waiting for the next build.
//
// Body:
//   { q: string, kind: "events"|"competitions", sport?: string,
//     competitionId?: string|null, limit?: number }
// Response:
//   { events?: [...], competitions?: [...] }
//
// Sport names follow SWIFT's casing ("Basketball", "Ice Hockey") — caller
// passes the result of swiftSportOf() from src/lib/sports.ts.

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

// Escape a user-supplied string for a Mongo regex. Without this, ".*" in a
// query name would silently broaden the search.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      q?: string
      kind?: 'events' | 'competitions'
      sport?: string | null
      competitionId?: string | null
      limit?: number
    }
    const q = (body.q ?? '').trim()
    if (q.length < 2) {
      res.status(200).json({ events: [], competitions: [] })
      return
    }
    const limit = Math.min(Math.max(body.limit ?? 50, 1), 200)
    const re = new RegExp(escapeRegex(q), 'i')
    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MONGO_COLL)

    res.setHeader('Cache-Control', 'no-store')
    const sportFilter = body.sport ? { 'sport.name': body.sport } : {}

    if (body.kind === 'competitions') {
      // Distinct competitions whose name (or sport) matches the query. We mine
      // gutsy.events because that's where the user-facing names live; group to
      // dedupe and count how many events back each competition.
      const compFilter: Record<string, unknown> = {
        ...sportFilter,
        $or: [{ 'competition.name': re }, { 'sport.name': re }],
      }
      const rows = await coll
        .aggregate([
          { $match: compFilter },
          {
            $group: {
              _id: '$competition.id',
              name: { $first: '$competition.name' },
              sport: { $first: '$sport.name' },
              n: { $sum: 1 },
            },
          },
          { $sort: { n: -1 } },
          { $limit: limit },
        ])
        .toArray()
      const competitions = rows
        .filter((r) => r._id && r.name)
        .map((r) => ({ id: String(r._id), name: r.name as string, sport: (r.sport as string | null) ?? null, n: r.n as number }))
      res.status(200).json({ competitions })
      return
    }

    // Default: search events. Name field is the primary signal; team names
    // appear inside `teams.name` (an array).
    const eventFilter: Record<string, unknown> = {
      ...sportFilter,
      $or: [{ name: re }, { 'teams.name': re }],
    }
    if (body.competitionId) eventFilter['competition.id'] = body.competitionId

    const docs = await coll
      .find(eventFilter, {
        projection: { _id: 1, name: 1, sport: 1, competition: 1, teams: 1, start_date: 1, status: 1 },
      })
      .sort({ start_date: -1 })
      .limit(limit)
      .toArray()

    const events = docs.map((d) => {
      const teams = (d.teams as Array<{ name?: string; team_position?: string }> | undefined) ?? []
      const home = teams.find((t) => t.team_position === 'Home')?.name ?? null
      const away = teams.find((t) => t.team_position === 'Away')?.name ?? null
      const competition = d.competition as { id?: string; name?: string } | undefined
      const sport = d.sport as { name?: string } | undefined
      return {
        id: String(d._id),
        cid: competition?.id ?? null,
        sport: sport?.name ?? null,
        competition: competition?.name ?? null,
        name: (d.name as string | null) ?? null,
        home,
        away,
        start: (d.start_date as string | null) ?? null,
        status: (d.status as string | null) ?? null,
      }
    })
    res.status(200).json({ events })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}
