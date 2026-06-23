// Vite dev-server middleware that exposes live SWIFT (gutsy.events) status
// queries to the browser. The static catalogue under /public is built once by
// `npm run build-mapping`, so its `status` field goes stale — this middleware
// is how the Notifications page picks up an event flipping prematch → live.
//
// Endpoint:
//   POST /api/swift-status  body: { ids: string[] }
//   → { events: { id, status, name, start }[] }
//
// Dev-only: in production there is no node runtime. Deploy alongside the
// SPA (e.g. as a Vercel function) before relying on it in prod.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { MongoClient } from 'mongodb'

// Read these lazily (at request time), NOT at module load: vite.config.ts
// injects MONGO_*/VITE_SUPABASE_* into process.env from `.env` inside its
// defineConfig callback, which runs *after* this module is imported. Capturing
// the const here would freeze MONGO_URI as undefined and every Mongo route
// would 500 with "MONGO_URI not set".
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const MONGO_COLL = process.env.MONGO_COLL ?? 'events'

// Hold a single client across HMR reloads so we don't churn connections.
let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI not set — SWIFT polling disabled')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(uri, { maxPoolSize: 4 }).connect())
}

// --- mapping-tick throttle (mirrors api/mapping-tick.ts) ------------------
const MAPPING_THROTTLE_MS = 10 * 60 * 1000
let mappingRunning = false

/** Newest event_mapping.resolved_at in epoch-ms (= last matcher run), or null. */
async function mappingLastRunMs(): Promise<number | null> {
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null
  const r = await fetch(
    `${url}/rest/v1/event_mapping?select=resolved_at&order=resolved_at.desc.nullslast&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  )
  if (!r.ok) return null
  const rows = (await r.json()) as Array<{ resolved_at: string | null }>
  const ts = rows?.[0]?.resolved_at
  return ts ? Date.parse(ts) : null
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<{ ids?: unknown }> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function slugify(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** The matched leg's event_time (epoch ms) — to pin a bet to the right game. */
function legEventTimeMs(legsRaw: unknown, index: number): number | null {
  if (index < 0) return null
  let legs: unknown
  try {
    legs = typeof legsRaw === 'string' ? JSON.parse(legsRaw) : legsRaw
  } catch {
    return null
  }
  if (!Array.isArray(legs)) return null
  const et = (legs[index] as { event_time?: unknown } | undefined)?.event_time
  const t = typeof et === 'string' ? Date.parse(et) : NaN
  return Number.isFinite(t) ? t : null
}

/** Mirror of api/swift-bets.ts extractLeg — leg market/outcome/odds + all
 *  selections (an SGM is one leg with several selections). */
interface LegSelection { market: string | null; mt: string | null; outcome: string | null; odds: number | null; status: string | null }
function extractLeg(legsRaw: unknown, index: number): (LegSelection & { selections: LegSelection[] }) | null {
  if (index < 0) return null
  let legs: unknown
  try {
    legs = typeof legsRaw === 'string' ? JSON.parse(legsRaw) : legsRaw
  } catch {
    return null
  }
  if (!Array.isArray(legs)) return null
  const leg = legs[index] as
    | { dividend?: unknown; selections?: Array<{ fixed_odds?: unknown; status?: unknown; selection_data?: Array<{ market_name?: unknown; market_type?: unknown; name?: unknown }> }> }
    | undefined
  if (!leg) return null
  // Decimal odds are always > 1; singles store 0 in the leg dividend → treat ≤1
  // as missing so the UI falls back to the bet's top-level odd.
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 1 ? v : null)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const rawSels = Array.isArray(leg.selections) ? leg.selections : []
  const selections: LegSelection[] = rawSels.map((sel) => {
    const sd = Array.isArray(sel?.selection_data) ? sel.selection_data[0] : null
    return {
      market: str(sd?.market_name) ?? str(sd?.market_type),
      mt: str(sd?.market_type),
      outcome: str(sd?.name),
      odds: num(sel?.fixed_odds),
      status: str(sel?.status),
    }
  })
  const first = selections[0] ?? { market: null, mt: null, outcome: null, odds: null, status: null }
  return {
    market: first.market,
    mt: first.mt,
    outcome: first.outcome,
    odds: num(leg.dividend) ?? first.odds,
    status: first.status,
    selections,
  }
}

/** bet_time is Melbourne wall-clock with a misleading `Z` suffix; convert to a real UTC moment. */
function melbWallToUtc(raw: string | Date): Date | null {
  if (!raw) return null
  const s = raw instanceof Date ? raw.toISOString() : String(raw)
  const wall = s.endsWith('Z') ? s.slice(0, -1) : s
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(wall)
  if (!m) return null
  const trial = new Date(`${wall}+10:00`)
  if (isNaN(trial.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(trial)
  const get = (t: string) => parts.find((p) => p.type === t)?.value
  if (get('year') === m[1] && get('hour') === m[4]) return trial
  return new Date(`${wall}+11:00`)
}

export function swiftApiPlugin(): Plugin {
  return {
    name: 'swift-api',
    configureServer(server) {
      server.middlewares.use('/api/swift-search', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        try {
          const body = await readJson(req) as {
            q?: string; kind?: 'events' | 'competitions'; sport?: string | null
            competitionId?: string | null; limit?: number
          }
          const q = (body.q ?? '').trim()
          if (q.length < 2) return send(res, 200, { events: [], competitions: [] })
          const limit = Math.min(Math.max(body.limit ?? 50, 1), 200)
          const re = new RegExp(escapeRegex(q), 'i')
          const client = await getClient()
          const coll = client.db(MONGO_DB).collection(MONGO_COLL)
          const sportFilter = body.sport ? { 'sport.name': body.sport } : {}
          if (body.kind === 'competitions') {
            const rows = await coll.aggregate([
              { $match: { ...sportFilter, $or: [{ 'competition.name': re }, { 'sport.name': re }] } },
              { $group: { _id: '$competition.id', name: { $first: '$competition.name' }, sport: { $first: '$sport.name' }, n: { $sum: 1 } } },
              { $sort: { n: -1 } },
              { $limit: limit },
            ]).toArray()
            const competitions = rows.filter((r) => r._id && r.name).map((r) => ({
              id: String(r._id), name: r.name as string, sport: (r.sport as string | null) ?? null, n: r.n as number,
            }))
            return send(res, 200, { competitions })
          }
          const eventFilter: Record<string, unknown> = { ...sportFilter, $or: [{ name: re }, { 'teams.name': re }] }
          if (body.competitionId) eventFilter['competition.id'] = body.competitionId
          const docs = await coll
            .find(eventFilter, { projection: { _id: 1, name: 1, sport: 1, competition: 1, teams: 1, start_date: 1, status: 1 } })
            .sort({ start_date: -1 }).limit(limit).toArray()
          const events = docs.map((d) => {
            const teams = (d.teams as Array<{ name?: string; team_position?: string }> | undefined) ?? []
            const home = teams.find((t) => t.team_position === 'Home')?.name ?? null
            const away = teams.find((t) => t.team_position === 'Away')?.name ?? null
            const competition = d.competition as { id?: string; name?: string } | undefined
            const sport = d.sport as { name?: string } | undefined
            return {
              id: String(d._id), cid: competition?.id ?? null, sport: sport?.name ?? null,
              competition: competition?.name ?? null, name: (d.name as string | null) ?? null,
              home, away, start: (d.start_date as string | null) ?? null, status: (d.status as string | null) ?? null,
            }
          })
          return send(res, 200, { events })
        } catch (e) {
          return send(res, 500, { error: String((e as { message?: unknown })?.message ?? e) })
        }
      })

      // GET /api/mapping-tick — see api/mapping-tick.ts. Server-throttled
      // self-trigger for the matcher; the open terminal pings it on a timer.
      server.middlewares.use('/api/mapping-tick', async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return send(res, 405, { ok: false, error: 'GET only' })
        }
        try {
          const last = await mappingLastRunMs()
          const now = Date.now()
          const ageMs = last == null ? Infinity : now - last
          if (ageMs < MAPPING_THROTTLE_MS) {
            return send(res, 200, {
              ok: true, ran: false, reason: 'throttled',
              ageSec: Math.round(ageMs / 1000),
              nextInSec: Math.ceil((MAPPING_THROTTLE_MS - ageMs) / 1000),
            })
          }
          if (mappingRunning) return send(res, 200, { ok: true, ran: false, reason: 'busy' })
          mappingRunning = true
          const t0 = Date.now()
          try {
            // build-mapping.mjs is plain JS with no .d.ts — runMapping() is
            // typed via the cast on the import result.
            // @ts-expect-error untyped local .mjs module
            const mod = (await import('./build-mapping.mjs')) as { runMapping: () => Promise<void> }
            await mod.runMapping()
          } finally {
            mappingRunning = false
          }
          return send(res, 200, { ok: true, ran: true, ms: Date.now() - t0 })
        } catch (e) {
          mappingRunning = false
          return send(res, 500, { ok: false, error: String((e as { message?: unknown })?.message ?? e) })
        }
      })

      // GET /api/mongo-pulse — see api/mongo-pulse.ts for the contract. Keeps
      // the dev server behaving like prod so the header pulse works under
      // `npm run dev` too.
      server.middlewares.use('/api/mongo-pulse', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET only' })
        try {
          const client = await getClient()
          const coll = client.db(MONGO_DB).collection(MONGO_COLL)
          const [agg] = await coll.aggregate([
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
          ]).toArray()
          const byStatus = new Map<string | null, number>(
            ((agg?.byStatus as Array<{ _id: string | null; n: number }>) ?? []).map((r) => [r._id, r.n]),
          )
          const rawNewest = (agg?.newest as Array<{ scraped_at: string | Date | null }>)?.[0]?.scraped_at ?? null
          const newestScrapedAt = rawNewest ? new Date(rawNewest).toISOString() : null
          const serverNow = new Date().toISOString()
          const ageSec = newestScrapedAt
            ? Math.max(0, Math.round((Date.parse(serverNow) - Date.parse(newestScrapedAt)) / 1000))
            : null
          const total = [...byStatus.values()].reduce((a, b) => a + b, 0)
          const sports = ((agg?.bySport as Array<{ _id: string | null; total: number; live: number }>) ?? [])
            .filter((s) => s._id)
            .map((s) => ({ name: s._id as string, total: s.total, live: s.live }))
          return send(res, 200, {
            ok: true,
            serverNow,
            newestScrapedAt,
            ageSec,
            live: byStatus.get('inprogress') ?? 0,
            prematch: byStatus.get('prematch') ?? 0,
            postmatch: byStatus.get('postmatch') ?? 0,
            total,
            sports,
          })
        } catch (e) {
          return send(res, 500, { ok: false, error: String((e as { message?: unknown })?.message ?? e) })
        }
      })

      server.middlewares.use('/api/swift-status', async (req, res) => {
        if (req.method !== 'POST') {
          return send(res, 405, { error: 'POST only' })
        }
        try {
          const { ids } = await readJson(req)
          if (!Array.isArray(ids) || ids.length === 0) {
            return send(res, 200, { events: [] })
          }
          const client = await getClient()
          const coll = client.db(MONGO_DB).collection(MONGO_COLL)
          // Slice into chunks of 500 so the $in stays small even when the
          // mapping table grows; Mongo handles 1k fine but this is friendlier.
          const events: Array<{
            id: string; cid: string | null; sport: string | null; competition: string | null
            name: string | null; home: string | null; away: string | null
            start: string | null; status: string | null; actualStart: string | null
          }> = []
          for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500)
            const docs = await coll
              .find(
                { _id: { $in: chunk } },
                { projection: { _id: 1, status: 1, name: 1, start_date: 1, teams: 1, sport: 1, competition: 1 } },
              )
              .toArray()
            for (const d of docs) {
              const teams = (d.teams as Array<{ name?: string; team_position?: string }> | undefined) ?? []
              const home = teams.find((t) => t.team_position === 'Home')?.name ?? null
              const away = teams.find((t) => t.team_position === 'Away')?.name ?? null
              const competition = d.competition as { id?: string; name?: string } | undefined
              const sport = d.sport as { name?: string } | undefined
              events.push({
                id: String(d._id),
                cid: competition?.id ?? null,
                sport: sport?.name ?? null,
                competition: competition?.name ?? null,
                name: (d.name as string | null) ?? null,
                home,
                away,
                start: (d.start_date as string | null) ?? null,
                status: (d.status as string | null) ?? null,
                actualStart: null,
              })
            }
          }
          await captureActualStarts(events).catch(() => {})
          send(res, 200, { events })
        } catch (e) {
          send(res, 500, { error: String((e as { message?: unknown })?.message ?? e) })
        }
      })

      // POST /api/swift-bets — see api/swift-bets.ts for the contract.
      server.middlewares.use('/api/swift-bets', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        try {
          const body = await readJson(req) as {
            date?: string; home?: string; away?: string; swiftActualStart?: string; scheduledStart?: string
          }
          if (!body.date || !body.home || !body.away) {
            return send(res, 400, { error: 'date, home and away are required' })
          }
          const homeSlug = slugify(body.home)
          const awaySlug = slugify(body.away)
          const re = new RegExp(
            `/${escapeRegex(body.date)}/(${escapeRegex(homeSlug)}-vs-${escapeRegex(awaySlug)}|${escapeRegex(awaySlug)}-vs-${escapeRegex(homeSlug)})$`,
          )
          const client = await getClient()
          const bets = client.db(MONGO_DB).collection('bets')
          const evD = new Date(`${body.date}T00:00:00Z`)
          const loDate = new Date(evD.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
          const hiDate = new Date(evD.getTime() + 1 * 86_400_000).toISOString().slice(0, 10)
          const docs = await bets
            .find(
              {
                bet_date: { $gte: loDate, $lte: hiDate },
                'derived.is_racing': false,
                'derived.legs_event_keys': { $elemMatch: { $regex: re } },
              },
              {
                projection: {
                  _id: 1, bet_id: 1, user_id: 1, bet_time: 1, bet_amount: 1,
                  bet_type: 1, odd: 1, pl: 1, is_bonus: 1,
                  'derived.event_key': 1, 'derived.legs_event_keys': 1,
                  'derived.event_name': 1, 'derived.market_category': 1,
                  'derived.sport': 1, 'derived.type': 1, 'derived.legs_breakdown': 1,
                  legs: 1,
                  'enrichment.blendFair': 1, 'enrichment.emPercent': 1, 'enrichment.scratched': 1,
                },
              },
            )
            .sort({ bet_time: -1 })
            .limit(200)
            .toArray()
          // 2-min grace — see api/swift-bets.ts.
          const AFTER_START_GRACE_MS = 2 * 60_000
          const SAME_GAME_TOLERANCE_MS = 3 * 60 * 60 * 1000
          const cutoff = body.swiftActualStart ? Date.parse(body.swiftActualStart) + AFTER_START_GRACE_MS : null
          const schedMs = body.scheduledStart ? Date.parse(body.scheduledStart) : null
          const out = docs.flatMap((d) => {
            const legs: string[] = d.derived?.legs_event_keys ?? []
            const matchedLegIndex = legs.findIndex((k) => re.test(k))
            // Pin to the correct game in a same-teams doubleheader/series.
            if (Number.isFinite(schedMs)) {
              const evtMs = legEventTimeMs(d.legs, matchedLegIndex)
              if (evtMs != null && Math.abs(evtMs - (schedMs as number)) > SAME_GAME_TOLERANCE_MS) return []
            }
            const betUtc = d.bet_time ? melbWallToUtc(d.bet_time) : null
            const placedAfterStart =
              cutoff != null && betUtc != null ? betUtc.getTime() > cutoff : false
            return [{
              id: d._id, bet_id: d.bet_id, user_id: d.user_id, bet_time: d.bet_time,
              bet_amount: d.bet_amount, bet_type: d.bet_type, odd: d.odd, pl: d.pl,
              is_bonus: !!d.is_bonus, sport: d.derived?.sport ?? null,
              type: d.derived?.type ?? null, market_category: d.derived?.market_category ?? null,
              event_key: d.derived?.event_key ?? null, legs_event_keys: legs,
              matched_leg_index: matchedLegIndex,
              matched_leg: extractLeg(d.legs, matchedLegIndex),
              leg_count: legs.length, leg_breakdown: d.derived?.legs_breakdown ?? null,
              em_percent: d.enrichment?.emPercent ?? null,
              scratched: d.enrichment?.scratched ?? false,
              placed_after_start: placedAfterStart,
            }]
          })
          send(res, 200, { bets: out, count: out.length, matchPattern: re.source })
        } catch (e) {
          send(res, 500, { error: String((e as { message?: unknown })?.message ?? e) })
        }
      })
    },
  }
}

/** See api/swift-status.ts for the rationale. */
async function captureActualStarts(
  events: Array<{ id: string; status: string | null; start: string | null; actualStart: string | null }>,
): Promise<void> {
  // Read lazily — vite.config injects .env into process.env after this module
  // is imported (same reason getClient() reads MONGO_URI lazily).
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  if (events.length === 0) return
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  }
  // Hydrate stored stamps for ALL ids, not just inprogress — see api/swift-status.ts.
  const allIds = events.map((e) => e.id)
  const inList = allIds.map((id) => `"${id}"`).join(',')
  const sel = await fetch(
    `${SUPABASE_URL}/rest/v1/event_mapping?select=gutsy_event_id,swift_actual_start&gutsy_event_id=in.(${inList})`,
    { headers },
  )
  if (!sel.ok) return
  const rows = (await sel.json()) as Array<{ gutsy_event_id: string; swift_actual_start: string | null }>
  const byId = new Map(rows.map((r) => [r.gutsy_event_id, r.swift_actual_start]))
  const now = new Date().toISOString()
  const toWrite: Array<{ id: string; stamp: string }> = []
  const toClear: string[] = []
  for (const ev of events) {
    const existing = byId.get(ev.id) ?? null
    // Delayed/reopened: back to prematch after we stamped → clear (see api/swift-status.ts).
    if (existing && ev.status === 'prematch') { ev.actualStart = null; toClear.push(ev.id); continue }
    if (existing) { ev.actualStart = existing; continue }
    if (ev.status !== 'inprogress') continue
    if (!byId.has(ev.id)) continue
    ev.actualStart = now
    toWrite.push({ id: ev.id, stamp: now })
  }
  if (toWrite.length === 0 && toClear.length === 0) return
  await Promise.all([
    ...toWrite.map(({ id, stamp }) =>
      fetch(
        `${SUPABASE_URL}/rest/v1/event_mapping?gutsy_event_id=eq.${id}&swift_actual_start=is.null`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ swift_actual_start: stamp }),
        },
      ),
    ),
    ...toClear.map((id) =>
      fetch(`${SUPABASE_URL}/rest/v1/event_mapping?gutsy_event_id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ swift_actual_start: null }),
      }),
    ),
  ])
}
