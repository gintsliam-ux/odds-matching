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

/** Above this many named runners an event is a field, not a matchup. A golf
 *  3-ball has 3; the Wyndham outright has 143. */
const MIN_OUTRIGHT_RUNNERS = 5

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
      /** Return OUTRIGHT events (a field of runners) instead of head-to-heads. */
      outright?: boolean
    }
    const q = (body.q ?? '').trim()
    // LIST MODE: an empty query is allowed when a competitionId scopes the
    // result set. The drill's auto-map needs every event in a competition, not
    // a text search — it used to pool candidates from the /public snapshot,
    // which is rebuilt only by a local build-mapping run and so had ZERO events
    // for e.g. Argentina Liga Profesional while Mongo had 8. Auto-map then
    // matched nothing at all. Without a scoping filter an empty q would mean
    // "scan the whole collection", so that stays rejected.
    // Competitions also list with an empty q: the tournament-level auto-map
    // needs the FULL competition set to match against, and was matching against
    // the /public snapshot instead — 237 competitions where Mongo has 313, so
    // 76 were invisible to it. The aggregate is grouped and limited, so an
    // empty q here is bounded work, not a collection scan.
    const listMode =
      q.length < 2 && (!!body.competitionId || body.kind === 'competitions')
    if (q.length < 2 && !listMode) {
      res.status(200).json({ events: [], competitions: [] })
      return
    }
    const limit = Math.min(Math.max(body.limit ?? 50, 1), 500)
    const re = listMode ? null : new RegExp(escapeRegex(q), 'i')
    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MONGO_COLL)

    res.setHeader('Cache-Control', 'no-store')
    const sportFilter = body.sport ? { 'sport.name': body.sport } : {}

    if (body.kind === 'competitions') {
      // Distinct competitions whose name (or sport) matches the query. We mine
      // gutsy.events because that's where the user-facing names live; group to
      // dedupe and count how many events back each competition.
      const compFilter: Record<string, unknown> = { ...sportFilter }
      // No text in list mode — the group/limit below bounds the work.
      if (re) compFilter.$or = [{ 'competition.name': re }, { 'sport.name': re }]
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
    //
    // OUTRIGHT MODE. Golf has no home-vs-away: a tournament is one event
    // carrying the whole field, e.g. "2026 Wyndham Championship" with a single
    // "Competitors" team holding 143 players, sitting in the same competition
    // as that week's 3-ball matchups (3 players each). The head-to-head filter
    // below drops exactly those events, which is why golf could never be mapped
    // — so this mode inverts it and returns the field instead, using the player
    // count to tell an outright from a matchup.
    const eventFilter: Record<string, unknown> = { ...sportFilter }
    // In list mode there's no text to match on — the competition filter below
    // is the whole query.
    if (re) eventFilter.$or = [{ name: re }, { 'teams.name': re }]
    if (body.competitionId) eventFilter['competition.id'] = body.competitionId

    // Over-fetch: outrights/futures are filtered out below, so pull extra to
    // still fill `limit` with head-to-head matches.
    const docs = await coll
      .find(eventFilter, {
        projection: {
          _id: 1, name: 1, sport: 1, competition: 1, teams: 1, start_date: 1, status: 1, event_view_status: 1,
          // Names only — a selection carries its whole price_history.
          'markets.name': 1, 'markets.selections.name': 1,
        },
      })
      .sort({ start_date: -1 })
      .limit(limit * 3)
      .toArray()

    if (body.outright) {
      const outrights = docs
        .map((d) => {
          const teams =
            (d.teams as Array<{ name?: string; players?: Array<{ name?: string }> }> | undefined) ?? []
          const teamRunners = teams.flatMap((t) => (t.players ?? []).map((p) => p.name).filter(Boolean)) as string[]
          // `teams` is not reliably the field. LIV Golf New York lists FOUR
          // players there while its outright winner market prices 58 — so the
          // player count called it a 3-ball and the tournament could never
          // resolve its SwiftBet event. The market is the real field; take
          // whichever list is longer, so events that only populate one of the
          // two (and the pre-market events that only have `teams`) both work.
          const markets =
            (d.markets as Array<{ name?: string; selections?: Array<{ name?: string }> }> | undefined) ?? []
          const outrightMarket =
            markets.find((m) => /outright winner/i.test(m.name ?? '')) ??
            markets.reduce<{ name?: string; selections?: Array<{ name?: string }> } | null>(
              (best, m) => ((m.selections?.length ?? 0) > (best?.selections?.length ?? 0) ? m : best),
              null,
            )
          const marketRunners = (outrightMarket?.selections ?? [])
            .map((sel) => sel.name)
            .filter(Boolean) as string[]
          const runners = marketRunners.length > teamRunners.length ? marketRunners : teamRunners
          const competition = d.competition as { id?: string; name?: string } | undefined
          const sport = d.sport as { name?: string } | undefined
          return {
            id: String(d._id),
            cid: competition?.id ?? null,
            sport: sport?.name ?? null,
            competition: competition?.name ?? null,
            name: (d.name as string | null) ?? null,
            start: (d.start_date as string | null) ?? null,
            status: ((d.status as string | null) ?? (d.event_view_status as string | null)) ?? null,
            runnerCount: runners.length,
            runners: runners.slice(0, 200),
          }
        })
        // A matchup is 2-3 named players; a field is far more. The threshold
        // keeps 3-balls and head-to-heads out without hard-coding a sport.
        .filter((e) => e.runnerCount > MIN_OUTRIGHT_RUNNERS)
        .slice(0, limit)
      res.status(200).json({ events: outrights })
      return
    }

    const events = docs
      .map((d) => {
        const teams =
          (d.teams as
            | Array<{ name?: string; team_position?: string; players?: Array<{ name?: string }> }>
            | undefined) ?? []
        let home = teams.find((t) => t.team_position === 'Home')?.name ?? null
        let away = teams.find((t) => t.team_position === 'Away')?.name ?? null
        if (!home || !away) {
          // Individual sports (tennis/MMA/boxing) carry ONE "Competitors" team
          // whose players[] holds the real names — preferred over parsing the
          // event name, which is only a last resort.
          const players = teams.flatMap((t) => (t.players ?? []).map((p) => p.name).filter(Boolean))
          if (players.length >= 2) {
            home = players[0] as string
            away = players[1] as string
          } else if (d.name) {
            const parts = String(d.name).split(/\s+vs\.?\s+/i)
            if (parts.length === 2) {
              home = parts[0].trim()
              away = parts[1].trim()
            }
          }
        }
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
          // Null-only fallback — see the note in api/swift-status.ts.
          status: ((d.status as string | null) ?? (d.event_view_status as string | null)) ?? null,
        }
      })
      // Drop outrights/futures — no two competitors, never a head-to-head target.
      .filter((e) => e.home && e.away)
      .slice(0, limit)
    res.status(200).json({ events })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}
