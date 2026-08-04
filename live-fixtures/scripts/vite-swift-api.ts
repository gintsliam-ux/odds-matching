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
import type { Plugin, ViteDevServer } from 'vite'
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

/**
 * Routes with no hand-written dev implementation are served by loading the REAL
 * `api/<name>.ts` Vercel handler through Vite's SSR pipeline and calling it
 * behind a thin req/res shim.
 *
 * The five routes above are hand-mirrored, and every time one of them gained a
 * feature (swift-search list mode, swift-bets `bet_status`, swift-status
 * participant resolution) the dev copy was forgotten and `npm run dev` quietly
 * behaved differently from prod. Delegating removes that whole failure mode for
 * these three: there is exactly one implementation.
 *
 * All of mybet was simply absent — so locally the mybet panel, its bets and its
 * search picker all returned nothing, which reads identically to "this event
 * has no mybet data".
 */
const DELEGATED = [
  'mybet-bets',
  'mybet-search',
  'mybet-status',
  'swift-bets',
  'swift-search',
  'swift-status',
] as const

function mountDelegated(server: ViteDevServer, name: string) {
  server.middlewares.use(`/api/${name}`, async (req, res) => {
    try {
      const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as {
        default: (req: unknown, res: unknown) => unknown | Promise<unknown>
      }
      // The handler reads req.body (Vercel pre-parses it) and writes via the
      // Express-style res.status().json() chain, neither of which node's raw
      // http objects provide.
      const body = req.method === 'POST' ? await readJson(req) : {}
      const shimRes = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code
          return this
        },
        setHeader(k: string, v: string) {
          res.setHeader(k, v)
          return this
        },
        json(payload: unknown) {
          send(res, this.statusCode, payload)
          return this
        },
        end(chunk?: string) {
          res.statusCode = this.statusCode
          res.end(chunk)
          return this
        },
      }
      await mod.default({ ...req, method: req.method, body, query: {}, headers: req.headers }, shimRes)
    } catch (e) {
      send(res, 500, { error: String((e as { message?: unknown })?.message ?? e) })
    }
  })
}

export function swiftApiPlugin(): Plugin {
  return {
    name: 'swift-api',
    configureServer(server) {
      for (const name of DELEGATED) mountDelegated(server, name)

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
    },
  }
}
