import { getSupabase } from './supabase'

// In-memory view of the `entity_logos` cache table. Loaded once on first fetch
// (and refreshed periodically). If the table doesn't exist yet, this no-ops and
// the app falls back to ESPN logos + monograms.

let cache = new Map<string, string | null>()
let loadedAt = 0
let inflight: Promise<void> | null = null

const TTL_MS = 10 * 60_000

function key(sport: string, name: string): string {
  return `${sport.trim().toLowerCase()}|${name.trim().toLowerCase()}`
}

export async function ensureLogoCache(): Promise<void> {
  if (Date.now() - loadedAt < TTL_MS && loadedAt !== 0) return
  if (!inflight) inflight = load()
  await inflight
  inflight = null
}

async function load(): Promise<void> {
  try {
    const next = new Map<string, string | null>()
    const PAGE = 1000
    // page past PostgREST's 1000-row cap so the whole cache loads
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getSupabase()
        .from('entity_logos')
        .select('sport,name,logo_url')
        .not('logo_url', 'is', null)
        .range(from, from + PAGE - 1)
      if (error) throw error
      for (const r of data ?? []) next.set(key(r.sport, r.name), r.logo_url)
      if (!data || data.length < PAGE) break
    }
    cache = next
    loadedAt = Date.now()
  } catch {
    // table missing or unreachable → keep whatever we have; ESPN/monogram cover it
    loadedAt = Date.now()
  }
}

/** Cached logo URL for a team/player, or undefined if not in the cache. */
export function cachedLogo(sport: string, name: string): string | undefined {
  return cache.get(key(sport, name)) ?? undefined
}
