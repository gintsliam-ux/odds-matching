// Daily cron backstop: re-runs the OPTIC ↔ SWIFT matcher and upserts fresh rows
// into `competition_mapping` + `event_mapping`. Vercel Hobby caps cron at once
// per day, so the ~10-min refresh is driven instead by /api/mapping-tick, which
// the open terminal pings on a timer (server-side throttled). This daily run is
// the floor for when the app is closed. Does NOT touch /public — the dev
// snapshot ages out gracefully now that the picker queries Mongo live via
// /api/swift-search.
//
// Schedule lives in vercel.json (`crons`). Vercel posts a Bearer token in
// `Authorization: Bearer <CRON_SECRET>` — we verify that to keep the endpoint
// from being kicked by anonymous traffic.

import type { VercelRequest, VercelResponse } from '@vercel/node'

// scripts/*.mjs live outside /api so they're not auto-bundled. We import them
// lazily to give them a chance to read MONGO_URI / VITE_SUPABASE_* from the
// function env at first call.
async function runMapping() {
  // Vercel bundles any reachable import; pulled lazily so the cold start of
  // unrelated functions doesn't drag the mongodb driver in.
  const mod = (await import('../../scripts/build-mapping.mjs')) as { runMapping: () => Promise<void> }
  await mod.runMapping()
}

// Hobby caps us at 2 cron slots (both taken: this + resolve-logos), so the
// mybet matcher rides along in this handler rather than getting its own cron.
async function runMybetMapping() {
  const mod = (await import('../../scripts/build-mybet-mapping.mjs')) as { runMybetMapping: () => Promise<void> }
  await mod.runMybetMapping()
}

// Orphaned mappings accrue whenever fixtures are deleted and nothing prunes
// them — 39% of event_mapping by the time it was first measured. This runs
// here, on the DAILY cron, rather than in the ~10-min tick: it needs the full
// fixture id set (~97 paged reads), where the matchers deliberately load a
// windowed one.
async function pruneOrphans(log: (m: string) => void) {
  const mod = (await import('../../scripts/prune-orphan-mappings.mjs')) as {
    pruneOrphanMappings: (o: { log: (m: string) => void }) => Promise<{ deleted: number }>
  }
  return mod.pruneOrphanMappings({ log })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // GET-only to match Vercel Cron's behaviour, with a header-based shared
  // secret so the public URL can't trigger paid Mongo/Supabase work.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'GET only' })
    return
  }
  const expected = process.env.CRON_SECRET
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!expected || got !== expected) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  const t0 = Date.now()
  try {
    await runMapping()
    // mybet runs after SwiftBet — independent tables (provider column), so a
    // mybet failure shouldn't fail the whole cron once SwiftBet has succeeded.
    let mybetError: string | null = null
    try {
      await runMybetMapping()
    } catch (e) {
      mybetError = String((e as { message?: unknown })?.message ?? e)
    }
    // Prune LAST and in its own catch: it is housekeeping, and a failure here
    // must not discard a matcher run that already succeeded.
    let pruned = 0
    let pruneError: string | null = null
    try {
      const notes: string[] = []
      const r = await pruneOrphans((m) => notes.push(m))
      pruned = r.deleted
      for (const n of notes) console.log(n)
    } catch (e) {
      pruneError = String((e as { message?: unknown })?.message ?? e)
    }
    res.status(200).json({ ok: true, ms: Date.now() - t0, mybetError, pruned, pruneError })
  } catch (e) {
    res.status(500).json({ ok: false, ms: Date.now() - t0, error: String((e as { message?: unknown })?.message ?? e) })
  }
}

// Vercel cron functions need a long-ish wall-clock budget: Mongo aggregate +
// Supabase upserts of ~1500 rows takes 30-60s on first run.
export const config = { maxDuration: 300 }
