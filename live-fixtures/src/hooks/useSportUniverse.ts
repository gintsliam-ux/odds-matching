import { useEffect, useState } from 'react'
import { getSupabase } from '../lib/supabase'
import { prettySport, reclassifySport, sportGroupKey } from '../lib/sports'
import { leagueLabel } from '../lib/oddsLibrary'

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
  /** "groupKey|prettifiedLeague" → raw league slug (for building clean URLs). */
  rawLeagueByGroup: Map<string, string>
  /** Non-completed (upcoming + live) fixture count per PARENT sport group key
   *  (sportGroupKey), computed over the whole table. The sidebar uses this so a
   *  sport whose next game is outside the board's ±6h window isn't shown as a
   *  misleading "0" while the sport board is full of upcoming games. */
  activeBySport: Map<string, number>
  /** Same, keyed by "groupKey|prettifiedLeague". */
  activeByLeague: Map<string, number>
  /**
   * Per-TOURNAMENT activity, keyed exactly like the Mapping page's row key:
   * `prettifiedSport|prettifiedLeague|tournament`, where tournament is the
   * tennis season_type and '' for every other sport.
   *
   * Tennis is why this exists: its "leagues" (atp/wta/atp_challenger) are
   * permanent but each season_type is a one-week event, so the mapping list
   * accumulated every tournament the feed had ever carried — 121 rows of which
   * only 9 had an unfinished fixture. `lastMs` lets that list default to the
   * current slate instead of the full backlog.
   */
  activityByTournament: Map<string, TournamentActivity>
}

export interface TournamentActivity {
  /** Fixtures not yet completed (live + upcoming). */
  active: number
  /** Latest scheduled_start seen, epoch ms (0 if none had a date). */
  lastMs: number
}

let cached: SportUniverse | null = null
let inflight: Promise<SportUniverse> | null = null

// Loads the full (sport, league) universe from `fixtures` once per session.
// PostgREST caps responses at 1000 rows; we paginate. Dropdowns use this so
// every sport/league is always listable — current scope decides counts.
/** How far back the sidebar's league list reaches. Covers every competition
 *  with a recent or upcoming fixture without paging the archive. */
const UNIVERSE_HORIZON_D = 90

async function load(): Promise<SportUniverse> {
  const horizon = new Date(Date.now() - UNIVERSE_HORIZON_D * 86_400_000).toISOString()
  const sb = getSupabase()
  const PAGE = 1000
  const seen = new Map<string, Set<string>>() // sport -> leagues set
  const rawSport = new Map<string, string>()
  const rawSportsAll = new Map<string, Set<string>>() // sport -> all underlying raw slugs
  const rawLeague = new Map<string, string>()
  const rawLeagueByGroup = new Map<string, string>() // `${groupKey}|${prettyLeague}` -> raw league slug
  const activeBySport = new Map<string, number>()
  const activeByLeague = new Map<string, number>()
  const activityByTournament = new Map<string, TournamentActivity>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('fixtures')
      .select('sport,optic_league,tournament,category,status,season_type,scheduled_start')
      // BOUNDED. `fixtures` holds 141,824 rows where `live_fixtures` held
      // 15,445, and this pages the whole result 1,000 at a time — unbounded it
      // fired ~142 sequential requests before the sidebar could render, which
      // hung the app on load. The universe only needs the leagues currently
      // worth listing, so it reads the live slate, not the archive.
      .eq('source', 'optic')
      .gte('scheduled_start', horizon)
      // Ordered, or PostgREST gives no stable slice across pages: rows shift
      // between requests, so a paged read both repeats and DROPS rows.
      .order('fixture_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as {
      sport: string | null
      optic_league: string | null
      tournament: string | null
      category: string | null
      status: string | null
      season_type: string | null
      scheduled_start: string | null
    }[]
    for (const r of rows) {
      // Reclassify generic "rugby" rows so they merge into rugby_union /
      // rugby_league based on the competition. Matches what mapRow does for
      // the Fixture objects, so the sidebar key lines up with f.sport.
      const rs = reclassifySport(r.sport ?? '', r.optic_league ?? '')
      const rl = r.optic_league ?? ''
      // Drop rows whose raw sport field is empty — they'd surface as a broken
      // "Unknown" sidebar entry whose by-sport DB fetch returns nothing
      // (universe map has no rawSport for them, so the fetcher queries
      // `sport='Unknown'` which doesn't exist).
      if (!rs) continue
      const s = prettySport(rs)
      // Same label the board renders, or the sport/league routes stop matching.
      const l = leagueLabel(r.tournament, r.category, rl)
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
      if (l && rl) rawLeagueByGroup.set(`${parent}|${l}`, rl)
      let set = seen.get(s)
      if (!set) seen.set(s, (set = new Set()))
      if (l) {
        set.add(l)
        if (rl) rawLeague.set(`${s}|${l}`, rl)
      }
      // "Active" = anything not completed (upcoming + live), counted per parent
      // group and per league so the sidebar reflects the full slate, not just
      // the board's ±6h live window.
      if ((r.status ?? '') !== 'completed') {
        activeBySport.set(parent, (activeBySport.get(parent) ?? 0) + 1)
        if (l) {
          const lk = `${parent}|${l}`
          activeByLeague.set(lk, (activeByLeague.get(lk) ?? 0) + 1)
        }
      }
      // Per-tournament rollup. The key MUST mirror how Mapping.tsx builds its
      // row key (`${sport}|${league}|${tournament}`, tournament only for
      // tennis) or the lookup silently misses and every row reads as inactive.
      const tourn = s === 'tennis' ? (r.season_type ?? '') : ''
      const tk = `${s}|${l}|${tourn}`
      let act = activityByTournament.get(tk)
      if (!act) activityByTournament.set(tk, (act = { active: 0, lastMs: 0 }))
      if ((r.status ?? '') !== 'completed') act.active++
      if (r.scheduled_start) {
        const ms = Date.parse(r.scheduled_start)
        if (Number.isFinite(ms) && ms > act.lastMs) act.lastMs = ms
      }
    }
    if (rows.length < PAGE) break
  }
  const sports = [...seen.keys()].sort()
  const leaguesBySport = new Map<string, string[]>()
  for (const [s, lset] of seen) leaguesBySport.set(s, [...lset].sort())
  const rawSportsAllOut = new Map<string, string[]>()
  for (const [s, raws] of rawSportsAll) rawSportsAllOut.set(s, [...raws])
  return { sports, leaguesBySport, rawSport, rawSportsAll: rawSportsAllOut, rawLeague, rawLeagueByGroup, activeBySport, activeByLeague, activityByTournament }
}

const EMPTY: SportUniverse = {
  sports: [],
  leaguesBySport: new Map(),
  rawSport: new Map(),
  rawSportsAll: new Map(),
  rawLeague: new Map(),
  rawLeagueByGroup: new Map(),
  activeBySport: new Map(),
  activeByLeague: new Map(),
  activityByTournament: new Map(),
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
