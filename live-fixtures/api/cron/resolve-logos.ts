// Daily cron: resolve logos for team/player names that entered `live_fixtures`
// since the last run (expansion clubs, promoted sides, new tennis entrants) and
// cache them in `entity_logos`. The board reads that cache via lib/logoCache;
// names with no logo fall back to a monogram.
//
// The resolver is deliberately slow — Wikimedia throttles aggressive callers, so
// it runs 2-wide with a 200ms politeness delay, ~1 name/sec. A backlog of a few
// thousand names therefore cannot finish inside one function invocation. We pass
// a deadline below maxDuration and let it stop cleanly: unresolved names simply
// stay uncached and the next daily run resumes where this one stopped. Steady
// state is a handful of new names per day, well inside one run.
//
// Schedule lives in vercel.json (`crons`). Vercel posts `Authorization: Bearer
// <CRON_SECRET>` — we verify it so the public URL can't trigger Wikipedia +
// Supabase work anonymously.

import type { VercelRequest, VercelResponse } from '@vercel/node'

interface ResolverResult {
  scanned: number
  resolved: number
  missed: number
  failed: number
  remaining: number
  timedOut: boolean
  ms: number
}

// scripts/ lives outside /api so it isn't auto-bundled; imported lazily so the
// cold start of unrelated functions doesn't pull it in.
async function runResolver(deadlineMs: number): Promise<ResolverResult> {
  const mod = (await import('../../scripts/resolve-logos.mjs')) as {
    runResolver: (o: { deadlineMs: number; log: (s: string) => void }) => Promise<ResolverResult>
  }
  return mod.runResolver({ deadlineMs, log: (s) => console.log(s) })
}

// Leave ~40s of the 300s budget for the final Supabase upsert flush and the
// response, so a deadline stop never becomes a function timeout (which would
// lose the batch that hasn't been flushed yet).
const DEADLINE_MS = 260_000

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
    const result = await runResolver(DEADLINE_MS)
    res.status(200).json({ ok: true, ...result })
  } catch (e) {
    res.status(500).json({ ok: false, ms: Date.now() - t0, error: String((e as { message?: unknown })?.message ?? e) })
  }
}

export const config = { maxDuration: 300 }
