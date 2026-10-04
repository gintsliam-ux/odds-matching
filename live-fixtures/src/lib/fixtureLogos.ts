/**
 * Team and player logos, looked up per fixture.
 *
 * Replaces two broken things at once.
 *
 * `logoCache` read `entity_logos`, which does not exist — the table is
 * `entities`. PostgREST answers 404 (PGRST205, "Perhaps you meant
 * public.entities") and the cache swallows the error, so the board had simply
 * been rendering monograms for everyone, silently.
 *
 * The bigger win is `fixture_entities`: it carries the logo already attached to
 * a fixture and side, so a logo is a lookup on (fixture_id, side) instead of
 * matching a name against a table. Name matching is what put West Perth's crest
 * on Perth — the two share every token that survives normalisation.
 */

import { getSupabase } from './supabase'

export interface FixtureLogos {
  home: string | null
  away: string | null
}

/** Same shape as cardOdds: PostgREST caps a page at 1000 rows however many ids
 *  are asked for, and a fixture has ~2 entity rows. */
const IDS_PER_CHUNK = 300
const CONCURRENCY = 4

interface Row {
  fixture_id: string
  side: string | null
  logo_url: string | null
}

async function fetchChunk(ids: string[]): Promise<Row[]> {
  const { data, error } = await getSupabase()
    .from('fixture_entities')
    .select('fixture_id,side,logo_url')
    .in('fixture_id', ids)
    .not('logo_url', 'is', null)
    .order('fixture_id', { ascending: true })
    .range(0, 999)
  // A missing logo is a monogram; it must never take the board down.
  if (error) return []
  return (data ?? []) as unknown as Row[]
}

/**
 * Resolved logos, held for the life of the tab.
 *
 * Which crest belongs to a fixture does not change, but the board re-polls
 * every 15s and used to re-resolve every fixture each time — the most
 * expensive read on the page, paid again and again for an answer that was
 * already known. A fixture with no logo is cached too (as a pair of nulls),
 * or every poll would re-ask for exactly the ids that have nothing to return.
 */
const cache = new Map<string, FixtureLogos>()

/** Logos for a page of fixtures, keyed by fixture id. */
export async function fetchFixtureLogos(fixtureIds: string[]): Promise<Map<string, FixtureLogos>> {
  const ids = [...new Set(fixtureIds.filter(Boolean))]
  if (!ids.length) return new Map()

  const missing = ids.filter((id) => !cache.has(id))
  if (missing.length) {
    const chunks: string[][] = []
    for (let i = 0; i < missing.length; i += IDS_PER_CHUNK) chunks.push(missing.slice(i, i + IDS_PER_CHUNK))

    const rows: Row[] = []
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = await Promise.all(chunks.slice(i, i + CONCURRENCY).map(fetchChunk))
      for (const r of batch) rows.push(...r)
    }

    // Seed every id asked for, so ones the table has no row for are remembered
    // as "nothing" rather than being re-requested on the next poll.
    for (const id of missing) cache.set(id, { home: null, away: null })
    for (const r of rows) {
      if (!r.logo_url) continue
      const e = cache.get(r.fixture_id)
      if (!e) continue
      if (r.side === 'home') e.home = r.logo_url
      else if (r.side === 'away') e.away = r.logo_url
    }
  }

  const out = new Map<string, FixtureLogos>()
  for (const id of ids) {
    const e = cache.get(id)
    if (e && (e.home || e.away)) out.set(id, e)
  }
  return out
}
