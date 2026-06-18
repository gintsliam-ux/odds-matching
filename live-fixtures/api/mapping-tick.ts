// GET /api/mapping-tick — self-trigger for the OPTIC ↔ SWIFT matcher so it can
// run ~every 10 min on a Vercel Hobby plan, where native cron is capped at once
// per day. The open terminal pings this on a timer; the SERVER throttles, so
// however many clients/tabs call it, an actual rebuild happens at most once per
// THROTTLE_MS. The daily `vercel.json` cron stays as a backstop for when the
// app is closed.
//
// Throttle signal: max(event_mapping.resolved_at) — the matcher stamps every
// row it upserts, so the newest resolved_at IS the last rebuild time. No new
// table needed.
//
// Unauthenticated by design (it's browser-called) but cheap to abuse: a spammed
// call just does one indexed Supabase read and returns `ran:false`. Only when
// the throttle has elapsed does it do the heavy Mongo+Supabase work.
//
// Env: MONGO_URI (+ MONGO_DB/COLL) for the matcher, VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY for the throttle read.

import type { VercelRequest, VercelResponse } from '@vercel/node'

const THROTTLE_MS = 10 * 60 * 1000

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY

// Per-instance guard so a warm Fluid Compute instance never runs two rebuilds
// at once. Cross-instance races are still possible but rare for a single-user
// app, and the matcher is idempotent (a clobbered run self-heals next tick).
let running = false

/** Newest event_mapping.resolved_at in epoch-ms, or null if the table is empty
 *  / unreadable (→ treat as "never run, go now"). */
async function lastRunMs(): Promise<number | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/event_mapping?select=resolved_at&order=resolved_at.desc.nullslast&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  )
  if (!r.ok) return null
  const rows = (await r.json()) as Array<{ resolved_at: string | null }>
  const ts = rows?.[0]?.resolved_at
  return ts ? Date.parse(ts) : null
}

async function runMapping(): Promise<void> {
  // Lazy import so the mongodb driver only cold-starts when we actually rebuild.
  const mod = (await import('../scripts/build-mapping.mjs')) as { runMapping: () => Promise<void> }
  await mod.runMapping()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'GET only' })
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  try {
    const last = await lastRunMs()
    const now = Date.now()
    const ageMs = last == null ? Infinity : now - last
    if (ageMs < THROTTLE_MS) {
      res.status(200).json({
        ok: true,
        ran: false,
        reason: 'throttled',
        ageSec: Math.round(ageMs / 1000),
        nextInSec: Math.ceil((THROTTLE_MS - ageMs) / 1000),
      })
      return
    }
    if (running) {
      res.status(200).json({ ok: true, ran: false, reason: 'busy' })
      return
    }
    running = true
    const t0 = Date.now()
    try {
      await runMapping()
    } finally {
      running = false
    }
    res.status(200).json({ ok: true, ran: true, ms: Date.now() - t0 })
  } catch (e) {
    running = false
    res.status(500).json({ ok: false, error: String((e as { message?: unknown })?.message ?? e) })
  }
}

// The rebuild (Mongo aggregate + ~1.5k Supabase upserts) can take 30-60s.
export const config = { maxDuration: 300 }
