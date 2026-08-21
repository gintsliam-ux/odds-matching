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
/**
 * Routes this file still implements by hand, and which therefore must NOT be
 * delegated. Everything else under /api resolves to its real handler.
 *
 * ONLY mapping-tick. It runs the matcher in-process by importing
 * build-mapping.mjs, which the deployed handler cannot do, so the dev version
 * is genuinely different rather than a copy.
 *
 * mongo-pulse used to be here "likewise" and had no such reason — it was a
 * copy that stopped keeping up. The real handler gained a `mybet` block; the
 * dev mirror never did, so the Mybet feed pulse was missing from the header on
 * localhost while working in production, and the dev copy also reported a
 * wildly different live count (1,429 against production's 14). Delegating it
 * removes the divergence rather than re-syncing a duplicate that will drift
 * again.
 */
const HAND_WRITTEN = new Set(['mapping-tick'])

/** `/api/foo` -> `foo`, ignoring query string and any trailing path. */
function routeName(url: string | undefined): string | null {
  const path = (url ?? '').split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '')
  return /^[a-z0-9-]+$/i.test(path) ? path : null
}

function mountDelegated(server: ViteDevServer) {
  // A catch-all rather than a list. Adding an api/*.ts used to mean also
  // remembering to name it here, and forgetting simply made the route return
  // nothing in dev — the same silent divergence that the hand-written copies
  // caused, in a new place. Now any handler that exists is served.
  server.middlewares.use('/api', async (req, res, next) => {
    const name = routeName(req.url)
    if (!name || HAND_WRITTEN.has(name)) return next()
    let mod: { default?: (req: unknown, res: unknown) => unknown | Promise<unknown> }
    try {
      mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as typeof mod
    } catch {
      return next() // no such handler — let Vite 404 it
    }
    if (typeof mod.default !== 'function') return next()
    try {
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
      // Last: anything under /api not handled above resolves to its real
      // api/*.ts handler.
      mountDelegated(server)
    },
  }
}
