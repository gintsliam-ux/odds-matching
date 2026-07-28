// POST /api/mybet-search — live name/team search against gutsy.mybet_events for
// the MappingEditor's mybet picker. Mirror of /api/swift-search. Lets the editor
// see events/leagues added since the last build-mybet-mapping snapshot.
//
// Body:     { q, kind: "events"|"competitions", competitionId?, limit? }
// Response: { events?: MybetEvent[] } | { competitions?: MybetCompetition[] }
//
// mybet has no sport filter here — its pool is small, so the query narrows it.

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      q?: string
      kind?: 'events' | 'competitions'
      competitionId?: string | null
      /** mybet sport name ("Basketball") — see mybetSportOf. */
      sport?: string | null
      limit?: number
    }
    const q = (body.q ?? '').trim()
    // LIST MODE: an empty query is allowed when a sport or competitionId scopes
    // the result set. The drill's auto-map needs every mybet event of a sport,
    // not a text search — it used to pool candidates from the /public snapshot,
    // whose basketball events were a week stale (all dated Jul 21 while the
    // WNBA fixtures were Aug 9), so nothing fell inside the time window and
    // auto-map matched nothing. Without a scoping filter an empty q would mean
    // "scan the whole collection", so that stays rejected.
    const listMode =
      q.length < 2 && (!!(body.sport || body.competitionId) || body.kind === 'competitions')
    if (q.length < 2 && !listMode) {
      res.status(200).json({ events: [], competitions: [] })
      return
    }
    const limit = Math.min(Math.max(body.limit ?? 50, 1), 500)
    const re = listMode ? null : new RegExp(escapeRegex(q), 'i')
    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MYBET_COLL)
    res.setHeader('Cache-Control', 'no-store')

    if (body.kind === 'competitions') {
      const rows = await coll
        .aggregate([
          // Only count head-to-head events, so pure outright/futures leagues
          // don't surface as competition candidates.
          {
            $match: {
              league: re ? { $ne: null, $regex: re } : { $ne: null },
              ...(body.sport ? { sport: body.sport } : {}),
              'match.teamA': { $ne: null },
              'match.teamB': { $ne: null },
            },
          },
          { $group: { _id: '$leagueId', name: { $first: '$league' }, sport: { $first: '$sport' }, n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $limit: limit },
        ])
        .toArray()
      const competitions = rows
        .filter((r) => r.name)
        .map((r) => ({
          id: String(r._id ?? r.name),
          name: r.name as string,
          sport: (r.sport as string | null) ?? null,
          n: r.n as number,
        }))
      res.status(200).json({ competitions })
      return
    }

    // Events: only head-to-head (both teams present) match an OPTIC fixture.
    const eventFilter: Record<string, unknown> = {
      'match.teamA': { $ne: null },
      'match.teamB': { $ne: null },
    }
    // In list mode the sport/competition filter IS the query.
    if (re) eventFilter.$or = [{ 'match.teamA': re }, { 'match.teamB': re }, { league: re }]
    if (body.sport) eventFilter.sport = body.sport
    if (body.competitionId) eventFilter.leagueId = isNaN(Number(body.competitionId))
      ? body.competitionId
      : Number(body.competitionId)

    const docs = await coll
      .find(eventFilter, {
        projection: { _id: 1, sport: 1, league: 1, leagueId: 1, match: 1, suspendAt: 1 },
      })
      .sort({ suspendAt: -1 })
      .limit(limit)
      .toArray()

    const events = docs.map((d) => {
      const match = d.match as { teamA?: string; teamB?: string } | undefined
      const home = match?.teamA ?? null
      const away = match?.teamB ?? null
      const suspendAt = toIso(d.suspendAt)
      return {
        id: String(d._id),
        cid: d.leagueId != null ? String(d.leagueId) : ((d.league as string | null) ?? null),
        sport: (d.sport as string | null) ?? null,
        competition: (d.league as string | null) ?? null,
        name: home && away ? `${home} vs ${away}` : null,
        home,
        away,
        start: suspendAt,
        suspendAt,
        status: null,
      }
    })
    res.status(200).json({ events })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}
