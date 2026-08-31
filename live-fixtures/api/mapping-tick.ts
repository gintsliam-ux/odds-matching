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

/** Hard ceiling per matcher, well inside the 300s function budget. Without it
 *  a matcher that keeps retrying a timing-out page runs until Vercel kills the
 *  whole invocation (FUNCTION_INVOCATION_TIMEOUT), which is a worse failure
 *  than reporting the error: no response body, and the workflow alerts anyway. */
const MATCHER_BUDGET_MS = 100_000

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} exceeded ${ms / 1000}s budget`)), ms),
    ),
  ])
}

async function runMapping(): Promise<void> {
  // Lazy import so the mongodb driver only cold-starts when we actually rebuild.
  const mod = (await import('../scripts/build-mapping.mjs')) as { runMapping: () => Promise<void> }
  await withDeadline(mod.runMapping(), MATCHER_BUDGET_MS, 'swift matcher')
}

// mybet rides the same tick as SwiftBet. It used to run ONLY in the daily
// /api/cron/build-mapping, so mybet mappings could sit 24h stale while the
// SwiftBet side refreshed every ~10 min — a mybet fixture added after 04:00 UTC
// stayed unmapped all day and had to be mapped by hand. Both providers now
// refresh on the same cadence, bounded by the same throttle.
async function runMybetMapping(): Promise<void> {
  const mod = (await import('../scripts/build-mybet-mapping.mjs')) as {
    runMybetMapping: () => Promise<void>
  }
  await withDeadline(mod.runMybetMapping(), MATCHER_BUDGET_MS, 'mybet matcher')
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
    let mybetError: string | null = null
    let swiftError: string | null = null
    try {
      try {
        await runMapping()
      } catch (e) {
        // A matcher failure is NOT a tick failure. `fixtures` currently
        // statement-timeouts (57014) partway through any paged read — a
        // keyset walk dies around page 17 of ~97k rows — so this throws on
        // most runs. Returning 500 made the workflow email on every tick
        // while the app itself was fine, which is noise, not signal: the
        // matchers are a background refresh and the mappings they already
        // wrote stay valid.
        //
        // Reported in the body so the failure is still visible to anyone
        // reading it, rather than swallowed.
        swiftError = String((e as { message?: unknown })?.message ?? e)
      }
      // mybet runs AFTER SwiftBet and in its own catch: the two write disjoint
      // rows (provider column), so a mybet failure must not discard a SwiftBet
      // pass that already succeeded, nor 500 the tick and trip the workflow.
      try {
        await runMybetMapping()
      } catch (e) {
        mybetError = String((e as { message?: unknown })?.message ?? e)
      }
    } finally {
      running = false
    }
    res.status(200).json({ ok: true, ran: true, ms: Date.now() - t0, swiftError, mybetError })
  } catch (e) {
    running = false
    res.status(500).json({ ok: false, error: String((e as { message?: unknown })?.message ?? e) })
  }
}

// Both rebuilds run in one invocation, SEQUENTIALLY.
//
// Measured 2026-08-22: ~105s on prod, ~33s locally (SwiftBet ~21s, mybet ~12s).
// The gap is cold start plus Vercel→Atlas/Supabase latency across ~15 paginated
// pages. An earlier note here claimed ~13s; that predated both the growth in
// `live_fixtures` and a spell where the pass was aborting early on a permission
// error, so it never reflected a completed run at current volume.
//
// Running the two CONCURRENTLY was tried and is slower, not faster: they
// contend on the same Atlas and Supabase connections, and mybet's Mongo read
// alone went 4.4s → 15s. The work is I/O-bound on shared upstream resources,
// so overlapping it just makes the two fight. Left sequential deliberately.
export const config = { maxDuration: 300 }
