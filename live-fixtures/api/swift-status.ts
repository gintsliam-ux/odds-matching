// POST /api/swift-status — live SWIFT (gutsy.events) status for a batch of
// event ids. Mirrors scripts/vite-swift-api.ts so the prod build behaves the
// same as `npm run dev`. The notifications page polls this every 15s with
// the small set of ids it actually cares about.
//
// SIDE EFFECT — actual-start capture:
//   gutsy.events overwrites the prematch row when it flips to inprogress, so
//   the transition timestamp is lost upstream. The first time we observe a
//   mapped event in `inprogress`, we record NOW() into event_mapping
//   .swift_actual_start. Idempotent — only writes when the column is null.
//   The detail page reads this for "ACTUAL START".
//
// Env required (Project Settings → Environment Variables):
//   MONGO_URI   — mongodb+srv://… (also used by scripts/build-mapping.mjs)
//   MONGO_DB    — defaults to "gutsy"
//   MONGO_COLL  — defaults to "events"
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — for the side-effect write.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const MONGO_COLL = process.env.MONGO_COLL ?? 'events'

// Fluid Compute reuses instances across invocations, so this client survives
// between calls — exactly what we want for Mongo (one warm pool per region).
let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    // Vercel parses JSON bodies for us when Content-Type is application/json.
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as { ids?: unknown }
    const ids = Array.isArray(body?.ids) ? (body.ids as string[]).filter((x) => typeof x === 'string') : []
    if (ids.length === 0) {
      res.status(200).json({ events: [] })
      return
    }
    const client = await getClient()
    const coll = client.db(MONGO_DB).collection(MONGO_COLL)
    // Returns the full SwiftEvent shape — the detail page uses this as a live
    // fallback when the static /public snapshot is missing a freshly-mapped
    // event. Notifications only need {id, status, name, start} but the extra
    // fields are tiny and let one endpoint serve both callers.
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

    // Side-effect: capture actual SWIFT start (prematch → inprogress flip).
    // Best-effort — failures are swallowed; the live-status response is the
    // primary product.
    await captureActualStarts(events).catch(() => {})
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ events })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

// --- actual-start capture ----------------------------------------------------

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY

/**
 * For each `inprogress` swift event id we just observed, set
 * `event_mapping.swift_actual_start = NOW()` if it's still null. Reads each
 * row's current value first so we never overwrite a previously recorded
 * earlier observation. Mutates `events[i].actualStart` to surface the value
 * back to the caller in the same response.
 */
async function captureActualStarts(
  events: Array<{ id: string; status: string | null; start: string | null; actualStart: string | null }>,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  if (events.length === 0) return

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  }

  // Pull stored swift_actual_start for EVERY requested id, not just the
  // currently-inprogress ones — past games (postmatch) still have a real
  // stamp the detail page wants to display.
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
  // Use our observation moment (NOW()) as the stamp — the polling frequency
  // bounds the error. Mongo's `start_date` was tried as a more accurate
  // signal but SwiftBet only bumps it on some events; for others it stays
  // pinned at the scheduled time, which would have us claim SwiftBet flipped
  // _before_ the game began (seen with Bangladesh vs Australia ODI). NOW()
  // is always observation-true.
  const toWrite: Array<{ id: string; stamp: string }> = []
  const toClear: string[] = []
  for (const ev of events) {
    const existing = byId.get(ev.id) ?? null
    // Delayed / reopened: SWIFT moved BACK to prematch after we'd stamped a
    // start, so the stamp was premature (a brief false flip, or the game got
    // pushed back). Clear it and re-capture when it really starts. A finished
    // game is `postmatch`, not `prematch`, so this won't wipe real stamps.
    if (existing && ev.status === 'prematch') {
      ev.actualStart = null
      toClear.push(ev.id)
      continue
    }
    // Hydrate existing stamp regardless of current status — so postmatch /
    // finished events still show their recorded start on the detail page.
    if (existing) {
      ev.actualStart = existing
      continue
    }
    // Only write a new stamp when the event is currently inprogress and the
    // mapping row exists with a null column.
    if (ev.status !== 'inprogress') continue
    if (!byId.has(ev.id)) continue
    ev.actualStart = now
    toWrite.push({ id: ev.id, stamp: now })
  }
  if (toWrite.length === 0 && toClear.length === 0) return

  // PATCH each row individually because Supabase doesn't support a
  // multi-PK conditional update in one call. The set is tiny (≤ a handful per
  // call) so the latency is negligible. The `is.null` guard makes the write
  // idempotent — earlier observations never get overwritten.
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
