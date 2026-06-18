import { useEffect, useState } from 'react'
import { getSupabase } from '../lib/supabase'
import { prettyLeague, prettySport, reclassifyRugbySport, sportGroupKey } from '../lib/sports'

export interface SportUniverse {
  sports: string[] // distinct prettified sports across the whole table
  leaguesBySport: Map<string, string[]> // sport -> distinct prettified leagues
  /** prettified sport → first raw slug we saw (for DB queries). */
  rawSport: Map<string, string>
  /**
   * prettified sport → every underlying raw slug that resolves to it. Rugby
   * Union, for instance, draws from both `rugby_union` and the reclassified
   * `rugby` rows — `.in('sport', list)` then post-filters by f.sport.
   */
  rawSportsAll: Map<string, string[]>
  /** "prettifiedSport|prettifiedLeague" → raw league slug. */
  rawLeague: Map<string, string>
}

let cached: SportUniverse | null = null
let inflight: Promise<SportUniverse> | null = null

// Loads the full (sport, league) universe from `live_fixtures` once per session.
// PostgREST caps responses at 1000 rows; we paginate. Dropdowns use this so
// every sport/league is always listable — current scope decides counts.
async function load(): Promise<SportUniverse> {
  const sb = getSupabase()
  const PAGE = 1000
  const seen = new Map<string, Set<string>>() // sport -> leagues set
  const rawSport = new Map<string, string>()
  const rawSportsAll = new Map<string, Set<string>>() // sport -> all underlying raw slugs
  const rawLeague = new Map<string, string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('live_fixtures')
      .select('sport,league')
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as { sport: string | null; league: string | null }[]
    for (const r of rows) {
      // Reclassify generic "rugby" rows so they merge into rugby_union /
      // rugby_league based on the competition. Matches what mapRow does for
      // the Fixture objects, so the sidebar key lines up with f.sport.
      const rs = reclassifyRugbySport(r.sport ?? '', r.league ?? '')
      const rl = r.league ?? ''
      // Drop rows whose raw sport field is empty — they'd surface as a broken
      // "Unknown" sidebar entry whose by-sport DB fetch returns nothing
      // (universe map has no rawSport for them, so the fetcher queries
      // `sport='Unknown'` which doesn't exist).
      if (!rs) continue
      const s = prettySport(rs)
      const l = prettyLeague(rl)
      if (!s) continue
      if (rs && !rawSport.has(s)) rawSport.set(s, rs)
      // Track every original raw slug that funneled into this prettified
      // sport — Rugby Union pulls from both `rugby_union` and `rugby`.
      let raws = rawSportsAll.get(s)
      if (!raws) rawSportsAll.set(s, (raws = new Set()))
      if (r.sport) raws.add(r.sport)
      // Also accumulate under the parent group so /sport/basketball can fetch
      // NBA + WNBA rows too. nba's sportGroupKey is "basketball"; for sports
      // without an explicit parent the group equals the sport itself, which is
      // a no-op.
      const parent = sportGroupKey(rs)
      if (parent !== s) {
        let pRaws = rawSportsAll.get(parent)
        if (!pRaws) rawSportsAll.set(parent, (pRaws = new Set()))
        if (r.sport) pRaws.add(r.sport)
      }
      let set = seen.get(s)
      if (!set) seen.set(s, (set = new Set()))
      if (l) {
        set.add(l)
        if (rl) rawLeague.set(`${s}|${l}`, rl)
      }
    }
    if (rows.length < PAGE) break
  }
  const sports = [...seen.keys()].sort()
  const leaguesBySport = new Map<string, string[]>()
  for (const [s, lset] of seen) leaguesBySport.set(s, [...lset].sort())
  const rawSportsAllOut = new Map<string, string[]>()
  for (const [s, raws] of rawSportsAll) rawSportsAllOut.set(s, [...raws])
  return { sports, leaguesBySport, rawSport, rawSportsAll: rawSportsAllOut, rawLeague }
}

const EMPTY: SportUniverse = {
  sports: [],
  leaguesBySport: new Map(),
  rawSport: new Map(),
  rawSportsAll: new Map(),
  rawLeague: new Map(),
}

export function useSportUniverse(): SportUniverse {
  const [u, setU] = useState<SportUniverse>(cached ?? EMPTY)
  useEffect(() => {
    if (cached) return
    if (!inflight) inflight = load().then((r) => (cached = r))
    inflight.then((r) => setU(r)).catch(() => {/* keep empty; current-scope sports still render */})
  }, [])
  return u
}
