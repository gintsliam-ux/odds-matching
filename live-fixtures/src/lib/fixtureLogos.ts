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

/** Logos for a page of fixtures, keyed by fixture id. */
export async function fetchFixtureLogos(fixtureIds: string[]): Promise<Map<string, FixtureLogos>> {
  const ids = [...new Set(fixtureIds.filter(Boolean))]
  if (!ids.length) return new Map()

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += IDS_PER_CHUNK) chunks.push(ids.slice(i, i + IDS_PER_CHUNK))

  const rows: Row[] = []
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = await Promise.all(chunks.slice(i, i + CONCURRENCY).map(fetchChunk))
    for (const r of batch) rows.push(...r)
  }

  const out = new Map<string, FixtureLogos>()
  for (const r of rows) {
    if (!r.logo_url) continue
    const e = out.get(r.fixture_id) ?? { home: null, away: null }
    if (r.side === 'home') e.home = r.logo_url
    else if (r.side === 'away') e.away = r.logo_url
    out.set(r.fixture_id, e)
  }
  return out
}
