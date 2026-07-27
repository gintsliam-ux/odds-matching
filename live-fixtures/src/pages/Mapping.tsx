import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowLeftRight, Check, ChevronRight, Database, GitMerge, Loader2, Pencil, Sparkles } from 'lucide-react'
import { TableSkeleton } from '../components/Skeleton'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useTerminal } from '../components/Layout'
import { useSportUniverse } from '../hooks/useSportUniverse'
import { useTournamentFixtures } from '../hooks/useTournamentFixtures'
import { useNow } from '../hooks/useNow'
import { MappingEditor, type EditorTarget } from '../components/MappingEditor'
import { getSwiftCatalog, type SwiftCompetition, type SwiftEvent } from '../lib/swiftCatalog'
import { getMybetCatalog, type MybetEvent } from '../lib/mybetCatalog'
import { fetchSwiftStatuses } from '../lib/swiftStatus'
import { fetchMybetStatuses } from '../lib/mybetStatus'
import { displaySport, mybetSportOf, slugToSport, sportEmoji, sportGroupKey, sportLabel, sportToSlug } from '../lib/sports'
import { kickoffLabel, melbDateTimeShort, utcDateTimeShort } from '../lib/format'
import {
  fetchCompetitionMappings,
  fetchEventMappingsFor,
  setCompetitionMappingsManual,
  setCompetitionVerified,
  setEventMappingManual,
  type CompetitionMapping,
  type EventMapping,
} from '../lib/mappingData'
import { bestSwiftEventMatch, bestSwiftMatch } from '../lib/autoMatch'
import { BRAND_PILL, BRAND_CHIP, type Brand } from '../lib/brand'

// Mapping tab: OPTIC (Supabase `live_fixtures`) ↔ SWIFT (Mongo `gutsy.events`).
//
// Layout:
//   - Sport tab strip (ALL · Baseball · Basketball · Tennis · …) — `?sport=` in URL.
//   - List view: tournaments under the selected sport.
//   - Drill view: click a tournament → events under it (`?tournament=key`).


// OPTIC leagues we never list in the Mapping table. Mirrors EXCLUDE_LEAGUES in
// scripts/build-mapping.mjs — ITF / UTR tennis tiers don't appear in gutsy.
const EXCLUDE_LEAGUES = new Set(['itf_men', 'itf_women', 'utr_men', 'utr_women'])

/** Keep only the rows that actually represent a SWIFT mapping (have a
 *  competition id + name). The `''`-id sentinel rows are dropped from the UI. */
function realMappings(list: CompetitionMapping[] | undefined): CompetitionMapping[] {
  if (!list) return []
  return list.filter((c) => !!c.swift_competition_id && !!c.swift_competition)
}

/** True when the user explicitly marked this tournament as having no SWIFT
 *  mapping (the `''`-id sentinel row with source='manual'). Auto-map honours
 *  this and skips the tournament. */
function isStickyUnmapped(list: CompetitionMapping[] | undefined): boolean {
  if (!list) return false
  return list.some(
    (c) => c.source === 'manual' && !c.swift_competition_id && !c.swift_competition,
  )
}

export default function MappingPage() {
  useDocumentTitle('Mapping')
  const { fixtures } = useTerminal()
  const universe = useSportUniverse()
  const navigate = useNavigate()
  // `/mapping/:sport` pins a sport tab (URL slug → group key); adding `/:league`
  // (raw league slug) drills into that tournament. Tennis season_type + filters
  // (`mapped`, `q`) ride as query params.
  const { sport: sportSlug, league: leagueSlug } = useParams()
  const [params, setParams] = useSearchParams()

  // One OPTIC tournament can have multiple SWIFT mappings (e.g. cricket
  // "Test Matches" → many test series). Keep them as a list per key.
  const [compMap, setCompMap] = useState<Map<string, CompetitionMapping[]>>(new Map())
  // Parallel mybet map (provider='mybet'), rendered as a third column. Event
  // mappings are NOT held here — DrillView loads its own, scoped to the
  // fixtures it renders.
  const [mybetCompMap, setMybetCompMap] = useState<Map<string, CompetitionMapping[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [autoRunning, setAutoRunning] = useState(false)
  const [autoStatus, setAutoStatus] = useState<string | null>(null)
  const [swiftEventById, setSwiftEventById] = useState<Map<string, SwiftEvent>>(new Map())
  const [mybetEventById, setMybetEventById] = useState<Map<string, MybetEvent>>(new Map())
  // SwiftBet competitions are kept so the sport tab strip can include sports
  // that exist only on the SwiftBet side (no OPTIC tournaments yet).
  const [swiftComps, setSwiftComps] = useState<SwiftCompetition[]>([])

  useEffect(() => {
    let alive = true
    getSwiftCatalog()
      .then((cat) => {
        if (!alive) return
        setSwiftEventById(cat.eventById)
        setSwiftComps(cat.competitions)
      })
      .catch(() => {/* catalogue may not exist yet — drill will show ids as fallback */})
    getMybetCatalog()
      .then((cat) => alive && setMybetEventById(cat.eventById))
      .catch(() => {/* mybet catalogue optional */})
    return () => {
      alive = false
    }
  }, [])

  // The static catalogue is a daily snapshot, so a freshly-mapped (or aged-out)
  // event isn't in it and the row would fall back to a bare id (a UUID for
  // SWIFT, a plain number for mybet). Those names are resolved live from Mongo.
  //
  // Resolution is ON DEMAND — the drill view asks for the ids it is actually
  // rendering. It used to sweep the whole mapping table on mount instead
  // (~5.7k SWIFT + ~1.4k mybet ids), which fired ~20 concurrent /api/*-status
  // POSTs, saturated the browser's connection pool, and left the page pinned
  // while every label sat on its id fallback. Event names are only ever shown
  // in the drill, so the sweep was pure waste: one league needs a handful.
  //
  // Attempts are COUNTED, not just flagged: a successful id is never refetched,
  // and a failed one gets one retry (so a transient blip doesn't strand a row on
  // its id for the session) but no more — the effect below re-runs on every
  // state change, so an uncapped retry would refire on each one.
  const MAX_ATTEMPTS = 2
  const resolveAttempts = useRef<Map<string, number>>(new Map())
  const mybetResolveAttempts = useRef<Map<string, number>>(new Map())
  const requestEventNames = useCallback((provider: 'swift' | 'mybet', ids: string[]) => {
    const attempted = provider === 'mybet' ? mybetResolveAttempts : resolveAttempts
    const missing = ids.filter((id) => id && (attempted.current.get(id) ?? 0) < MAX_ATTEMPTS)
    if (missing.length === 0) return
    for (const id of missing) attempted.current.set(id, (attempted.current.get(id) ?? 0) + 1)
    // Chunked so each batch merges as it arrives rather than all-or-nothing.
    const CHUNK = 300
    for (let i = 0; i < missing.length; i += CHUNK) {
      const slice = missing.slice(i, i + CHUNK)
      // A resolved id drops out of the caller's missing set on its own (it's in
      // the byId map now), so failure needs no bookkeeping — the attempt is
      // already counted and the row simply keeps its id fallback meanwhile.
      const keepFallback = () => {}
      if (provider === 'mybet') {
        fetchMybetStatuses(slice)
          .then((evs) => {
            if (evs.length === 0) return
            setMybetEventById((prev) => {
              const next = new Map(prev)
              for (const e of evs) next.set(e.id, { id: e.id, cid: null, sport: e.sport, competition: e.competition, name: e.name, home: e.home, away: e.away, start: e.start, suspendAt: e.suspendAt, status: e.status })
              return next
            })
          })
          .catch(keepFallback)
      } else {
        fetchSwiftStatuses(slice)
          .then((evs) => {
            if (evs.length === 0) return
            setSwiftEventById((prev) => {
              const next = new Map(prev)
              for (const e of evs) next.set(e.id, e)
              return next
            })
          })
          .catch(keepFallback)
      }
    }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    // Competitions only. Event mappings used to be pulled whole-table here —
    // 13.9k swift + 8.1k mybet rows over ~22 sequential pages, none of them
    // abortable, restarted by every setReloadKey. Only the drill reads them, so
    // it now fetches just the fixtures on screen (fetchEventMappingsFor).
    Promise.all([fetchCompetitionMappings(), fetchCompetitionMappings('mybet')])
      .then(([comps, mybetComps]) => {
        if (!alive) return
        const groupComps = (list: CompetitionMapping[]) => {
          const cm = new Map<string, CompetitionMapping[]>()
          for (const c of list) {
            const k = `${c.optic_sport}|${c.optic_league}|${c.optic_tournament}`
            let arr = cm.get(k)
            if (!arr) cm.set(k, (arr = []))
            arr.push(c)
          }
          return cm
        }
        setCompMap(groupComps(comps))
        setMybetCompMap(groupComps(mybetComps))
        setError(null)
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [reloadKey])

  // URL state ------------------------------------------------------------
  const sportFilter = sportSlug ? slugToSport(sportSlug) : 'all' // sportGroupKey or 'all'
  const tournamentTennis = params.get('t') ?? '' // tennis season_type (drill only)
  const search = params.get('q') ?? ''
  const mappedFilter =
    (params.get('mapped') as 'all' | 'mapped' | 'unmapped' | 'verified' | 'unverified' | null) ?? 'all'
  // Opt back in to the full backlog of finished tournaments. Default off.
  const showAllPeriods = params.get('all') === '1'

  function setParam(key: string, value: string | null) {
    updateParams({ [key]: value })
  }

  /** The current filter query (mapped/q), preserved when navigating between
   *  sport/league paths so a tab click doesn't reset the filters. */
  function filterQuery() {
    const q = new URLSearchParams()
    if (mappedFilter !== 'all') q.set('mapped', mappedFilter)
    if (showAllPeriods) q.set('all', '1')
    if (search) q.set('q', search)
    const s = q.toString()
    return s ? `?${s}` : ''
  }

  /**
   * Batched URL-param update. Chaining setParam twice (e.g. set sport + clear
   * tournament) reads stale `params` each time and the second call clobbers
   * the first — that was the "can't click sport tabs" bug. Always go through
   * this helper when changing more than one param.
   */
  function updateParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: false })
  }

  // ---------------------------------------------------------------------

  // Build tournament rows. Each row carries both prettified labels (for display)
  // and raw OpticOdds slugs (for tournament-scoped queries when drilling in).
  // `mappings` is the list of SWIFT competitions paired with this OPTIC
  // tournament — may be empty (no mapping), a single entry (1-to-1), or many
  // (e.g. cricket "Test Matches" → multiple test series).
  interface TournamentRow {
    sport: string
    league: string
    tournament: string
    rawSport: string
    rawLeague: string
    rawTournament: string
    count: number
    mappings: CompetitionMapping[]
    mybetMappings: CompetitionMapping[]
    /** User explicitly marked this tournament as unmapped — auto-map skips it. */
    stickyUnmapped: boolean
    /** Live/upcoming, or finished within ACTIVE_WINDOW_D. Drives the default
     *  "active only" list — see the note on ACTIVE_WINDOW_D. */
    isActive: boolean
  }

  // A tennis season_type ("Vancouver, Canada, Qualifying") is a one-week event,
  // but the mapping list used to carry every one the feed had ever seen: 121
  // tennis rows against 9 with an unfinished fixture. Rows now default to the
  // current slate — anything live/upcoming, plus anything that wrapped up in
  // the last week so a just-finished tournament is still there to reconcile.
  // `?all=1` brings the full backlog back.
  // Via useNow rather than a bare Date.now(): reading the clock during render
  // is impure (the lint rule catches it) and the cutoff would freeze at mount.
  // A minute's granularity is far finer than a 7-day window needs.
  const ACTIVE_WINDOW_D = 7
  const nowTick = useNow(60_000)
  const activeCutoffMs = useMemo(
    () => nowTick.getTime() - ACTIVE_WINDOW_D * 86_400_000,
    [nowTick],
  )
  const isActiveKey = useCallback(
    (k: string) => {
      const act = universe.activityByTournament.get(k)
      // No activity row at all = a competition_mapping left over for a
      // tournament the feed no longer carries. That's exactly the stale case.
      if (!act) return false
      return act.active > 0 || act.lastMs >= activeCutoffMs
    },
    [universe, activeCutoffMs],
  )

  const tournaments = useMemo<TournamentRow[]>(() => {
    const counts = new Map<string, number>()
    for (const f of fixtures) {
      const tournament = f.sport === 'tennis' ? (f.seasonType ?? '') : ''
      const k = `${f.sport}|${f.league}|${tournament}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const rows: TournamentRow[] = []
    const seen = new Set<string>()

    function rawFromFixture(sport: string, league: string): { rs: string; rl: string } | null {
      const f = fixtures.find((x) => x.sport === sport && x.league === league)
      return f ? { rs: f.rawSport, rl: f.rawLeague } : null
    }
    function rawFromUniverse(sport: string, league: string): { rs: string; rl: string } {
      return {
        rs: universe.rawSport.get(sport) ?? sport,
        rl: universe.rawLeague.get(`${sport}|${league}`) ?? league,
      }
    }

    for (const [sport, leagues] of universe.leaguesBySport) {
      if (sport === 'tennis') continue
      const rs = universe.rawSport.get(sport) ?? sport
      for (const league of leagues) {
        const k = `${sport}|${league}|`
        seen.add(k)
        const rl = universe.rawLeague.get(`${sport}|${league}`) ?? league
        rows.push({
          sport,
          league,
          tournament: '',
          rawSport: rs,
          rawLeague: rl,
          rawTournament: '',
          count: counts.get(k) ?? 0,
          mappings: realMappings(compMap.get(k)),
          mybetMappings: realMappings(mybetCompMap.get(k)),
          stickyUnmapped: isStickyUnmapped(compMap.get(k)),
          isActive: isActiveKey(k),
        })
      }
    }
    for (const f of fixtures) {
      if (f.sport !== 'tennis') continue
      const tournament = f.seasonType ?? ''
      if (!tournament) continue
      const k = `${f.sport}|${f.league}|${tournament}`
      if (seen.has(k)) continue
      seen.add(k)
      rows.push({
        sport: f.sport,
        league: f.league,
        tournament,
        rawSport: f.rawSport,
        rawLeague: f.rawLeague,
        rawTournament: tournament,
        count: counts.get(k) ?? 0,
        mappings: realMappings(compMap.get(k)),
          mybetMappings: realMappings(mybetCompMap.get(k)),
          stickyUnmapped: isStickyUnmapped(compMap.get(k)),
          isActive: isActiveKey(k),
      })
    }
    // Tennis tournament rows derived from competition_mapping entries that
    // aren't currently in fixtures (e.g. cached mapping for an off-day tournament).
    for (const list of compMap.values()) {
      for (const c of list) {
        if (c.optic_sport !== 'tennis' || !c.optic_tournament) continue
        const k = `${c.optic_sport}|${c.optic_league}|${c.optic_tournament}`
        if (seen.has(k)) continue
        seen.add(k)
        const raw = rawFromFixture(c.optic_sport, c.optic_league) ?? rawFromUniverse(c.optic_sport, c.optic_league)
        rows.push({
          sport: c.optic_sport,
          league: c.optic_league,
          tournament: c.optic_tournament,
          rawSport: raw.rs,
          rawLeague: raw.rl,
          rawTournament: c.optic_tournament,
          count: 0,
          mappings: realMappings(compMap.get(k)),
          mybetMappings: realMappings(mybetCompMap.get(k)),
          stickyUnmapped: isStickyUnmapped(compMap.get(k)),
          isActive: isActiveKey(k),
        })
      }
    }
    for (const f of fixtures) {
      if (f.sport === 'tennis') continue
      const k = `${f.sport}|${f.league}|`
      if (seen.has(k)) continue
      seen.add(k)
      rows.push({
        sport: f.sport,
        league: f.league,
        tournament: '',
        rawSport: f.rawSport,
        rawLeague: f.rawLeague,
        rawTournament: '',
        count: counts.get(k) ?? 0,
        mappings: realMappings(compMap.get(k)),
          mybetMappings: realMappings(mybetCompMap.get(k)),
          stickyUnmapped: isStickyUnmapped(compMap.get(k)),
          isActive: isActiveKey(k),
      })
    }
    return rows
      .filter((r) => !EXCLUDE_LEAGUES.has(r.rawLeague))
      .sort((a, b) => {
        const am = a.mappings.length > 0 ? 1 : 0
        const bm = b.mappings.length > 0 ? 1 : 0
        if (am !== bm) return bm - am
        return b.count - a.count || a.sport.localeCompare(b.sport) || a.league.localeCompare(b.league)
      })
  }, [universe, fixtures, compMap, mybetCompMap, isActiveKey])

  // Sport tab list (display-grouped: `mlb` and `baseball` share "Baseball").
  // Includes SwiftBet sports too — clicking a SwiftBet-only sport tab shows
  // no OPTIC tournaments but lets the user see SwiftBet exists for it.
  const sportTabs = useMemo(() => {
    interface Tab {
      key: string
      name: string
      emoji: string
      total: number // OPTIC tournament count
      paired: number
      swiftComps: number // SwiftBet competition count for the same sport
    }
    const m = new Map<string, Tab>()
    // Count only what the list will actually show, or the Tennis tab reads 121
    // while the table under it holds 57.
    for (const t of tournaments) {
      if (!showAllPeriods && !t.isActive) continue
      const key = sportGroupKey(t.sport)
      const e = m.get(key) ?? {
        key,
        name: displaySport(t.sport),
        emoji: sportEmoji(t.sport),
        total: 0,
        paired: 0,
        swiftComps: 0,
      }
      e.total++
      if (t.mappings.length > 0) e.paired++
      m.set(key, e)
    }
    for (const c of swiftComps) {
      if (!c.sport) continue
      const key = sportGroupKey(c.sport)
      const e = m.get(key) ?? {
        key,
        name: displaySport(c.sport),
        emoji: sportEmoji(c.sport),
        total: 0,
        paired: 0,
        swiftComps: 0,
      }
      e.swiftComps++
      m.set(key, e)
    }
    // Sort: OPTIC-active first (most paired, most fixtures), then SwiftBet-only
    // tabs at the end alphabetically.
    return [...m.values()].sort((a, b) => {
      if ((a.total > 0) !== (b.total > 0)) return a.total > 0 ? -1 : 1
      return b.paired - a.paired || b.total - a.total || a.name.localeCompare(b.name)
    })
  }, [tournaments, swiftComps, showAllPeriods])

  // Apply sport-tab + mapped/unmapped/verified + search filter.
  const visibleTournaments = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tournaments.filter((t) => {
      if (sportFilter !== 'all' && sportGroupKey(t.sport) !== sportFilter) return false
      if (!showAllPeriods && !t.isActive) return false
      // Filters consider EITHER brand. "mapped" = SwiftBet or mybet has a
      // mapping; "verified" = everything mapped across both is verified;
      // "unverified" = mapped but something still needs confirming. "All" shows
      // every row (mapped + unmapped) so the tab counts stay consistent —
      // All == Mapped + Unmapped, and Mapped == Verified + Unverified.
      const allMaps = [...t.mappings, ...t.mybetMappings]
      const mapped = allMaps.length > 0
      const verified = mapped && allMaps.every((m) => m.verified)
      if (mappedFilter === 'mapped' && !mapped) return false
      if (mappedFilter === 'unmapped' && mapped) return false
      if (mappedFilter === 'verified' && !verified) return false
      if (mappedFilter === 'unverified' && (!mapped || verified)) return false
      if (
        q &&
        !`${t.sport} ${t.league} ${t.tournament} ${t.mappings.map((m) => m.swift_competition ?? '').join(' ')}`
          .toLowerCase()
          .includes(q)
      )
        return false
      return true
    })
  }, [tournaments, sportFilter, mappedFilter, search, showAllPeriods])

  // How many rows the active-window filter is holding back, under the CURRENT
  // sport tab — so the toggle can say what it would reveal instead of being an
  // unlabelled switch.
  const hiddenOldCount = useMemo(() => {
    if (showAllPeriods) return 0
    return tournaments.filter(
      (t) => !t.isActive && (sportFilter === 'all' || sportGroupKey(t.sport) === sportFilter),
    ).length
  }, [tournaments, sportFilter, showAllPeriods])

  // Selected tournament for the drill-down view (if any). Looked up from the
  // already-rendered list rather than re-parsing from the URL, which keeps the
  // raw query slugs handy without any extra plumbing.
  const selectedTournament = useMemo(() => {
    if (!leagueSlug) return null
    return (
      tournaments.find(
        (row) =>
          sportGroupKey(row.rawSport) === sportFilter &&
          row.rawLeague === leagueSlug &&
          row.rawTournament === tournamentTennis,
      ) ?? null
    )
  }, [leagueSlug, sportFilter, tournamentTennis, tournaments])

  // -----------------------------------------------------------------

  const totals = useMemo(() => {
    const tPaired = visibleTournaments.filter((t) => t.mappings.length > 0).length
    return { tPaired, tTotal: visibleTournaments.length }
  }, [visibleTournaments])

  // Auto-map every CURRENTLY-VISIBLE unmapped tournament using bestSwiftMatch
  // (same scoring as the offline matcher). Saves as source='manual' so reruns
  // of build-mapping leave the user's accepted suggestions alone.
  // Auto-map one brand's competitions. Name-matches ONLY unmapped, non-sticky
  // tournaments against that brand's catalogue; each competition stays 1:1 (a
  // competition already attached to another tournament is never reused). Tennis
  // is skipped on the mybet side (its "wta"/"atp" buckets name-match every
  // WTA/ATP competition, so mybet tennis is only trustworthy from event evidence).
  async function runAutoMap(provider: 'swift' | 'mybet') {
    if (autoRunning) return
    setAutoRunning(true)
    setAutoStatus('Loading catalogue…')
    const brand = provider === 'mybet' ? 'mybet' : 'SwiftBet'
    try {
      const cat = provider === 'mybet' ? await getMybetCatalog().catch(() => null) : await getSwiftCatalog()
      if (!cat) {
        setAutoStatus('mybet catalogue unavailable.')
        setAutoRunning(false)
        return
      }
      // competition id → the tournament base names already using it. A book
      // competition legitimately spans SIBLING tournaments — OPTIC splits a
      // tennis event into "Los Cabos, Mexico" and "Los Cabos, Mexico,
      // Qualifying" where the book has one "ATP Los Cabos" (SwiftBet is already
      // mapped to both). So 1:1 is enforced per BASE NAME (text before the
      // first comma) rather than outright: siblings may share, unrelated
      // tournaments still may not.
      const usedBy = new Map<string, Set<string>>()
      for (const t of tournaments) {
        for (const m of provider === 'mybet' ? t.mybetMappings : t.mappings) {
          const id = m.swift_competition_id
          if (!id) continue
          let bases = usedBy.get(id)
          if (!bases) usedBy.set(id, (bases = new Set()))
          bases.add(tournamentBase(t))
        }
      }
      const jobs = visibleTournaments.filter((t) =>
        provider === 'swift'
          ? t.mappings.length === 0 && !t.stickyUnmapped
          : t.mybetMappings.length === 0 && t.sport.toLowerCase() !== 'tennis',
      )
      if (jobs.length === 0) {
        setAutoStatus(`Nothing to auto-map on ${brand} in this view.`)
        setAutoRunning(false)
        setTimeout(() => setAutoStatus(null), 3500)
        return
      }
      let paired = 0
      for (let i = 0; i < jobs.length; i++) {
        const t = jobs[i]
        setAutoStatus(`Auto-mapping ${brand} ${i + 1}/${jobs.length}…`)
        const hit = bestSwiftMatch({
          opticSportRaw: t.rawSport,
          opticLeagueRaw: t.rawLeague,
          opticTournamentRaw: t.rawTournament,
          catalog: cat.competitions,
        })
        if (!hit) continue
        // 1:1, relaxed for siblings — reuse is allowed only when every other
        // tournament holding this competition shares our base name.
        const base = tournamentBase(t)
        const holders = usedBy.get(hit.competition.id)
        if (holders && [...holders].some((b) => b !== base)) continue
        try {
          await setCompetitionMappingsManual({
            opticSportRaw: t.rawSport,
            opticLeagueRaw: t.rawLeague,
            opticTournamentRaw: t.rawTournament,
            picks: [{ id: hit.competition.id, name: hit.competition.name, sport: hit.competition.sport }],
            provider,
            // A machine guess, so mark it disposable: the offline matcher may
            // wipe and re-derive it. Writing these as 'manual' made them sticky
            // and hid them from every guard the matcher has.
            source: 'auto',
          })
          // Claim it for THIS base name, so later jobs in the run see it as
          // taken unless they're siblings.
          const claimed = usedBy.get(hit.competition.id) ?? new Set<string>()
          claimed.add(base)
          usedBy.set(hit.competition.id, claimed)
          paired++
        } catch {
          /* per-row failure shouldn't kill the whole run */
        }
      }
      setAutoStatus(`Done — paired ${paired}/${jobs.length} on ${brand}.`)
      setReloadKey((k) => k + 1)
      setTimeout(() => setAutoStatus(null), 4000)
    } catch (e) {
      setAutoStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAutoRunning(false)
    }
  }

  return (
    <div className="px-5 py-4">
      {/* row 1: title */}
      <div className="mb-5 flex items-center gap-3">
        <h1 className="flex items-center gap-2.5 text-[20px] font-semibold tracking-tight text-gray-100">
          <GitMerge className="h-5 w-5 text-[color:var(--total)]" />
          Mapping
        </h1>
        <span className="flex items-center gap-1.5">
          <SourcePill kind="OPTIC" />
          <ArrowLeftRight className="h-3 w-3 text-[color:var(--muted-2)]" />
          <SourcePill kind="SWIFT" />
          <SourcePill kind="MYBET" />
        </span>
        <span className="ml-auto text-[12px] text-[color:var(--muted)]">
          Paired <span className="font-semibold tabular-nums text-gray-100">{totals.tPaired}</span>
          <span className="text-[color:var(--muted-2)]"> / {totals.tTotal}</span>
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => runAutoMap('swift')}
            disabled={autoRunning || !visibleTournaments.some((t) => t.mappings.length === 0 && !t.stickyUnmapped)}
            className="flex items-center gap-1.5 rounded-md border border-[color:var(--swift)]/40 bg-[color:var(--swift)]/10 px-3 py-1.5 text-[12px] font-medium text-[color:var(--swift)] transition-colors hover:bg-[color:var(--swift)]/15 disabled:cursor-not-allowed disabled:opacity-40"
            title="Auto-map every unmapped tournament to SwiftBet in the current view"
          >
            {autoRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Auto-map SWIFT
          </button>
          <button
            onClick={() => runAutoMap('mybet')}
            disabled={autoRunning || !visibleTournaments.some((t) => t.mybetMappings.length === 0 && t.sport.toLowerCase() !== 'tennis')}
            className="flex items-center gap-1.5 rounded-md border border-[color:var(--mybet)]/40 bg-[color:var(--mybet)]/10 px-3 py-1.5 text-[12px] font-medium text-[color:var(--mybet)] transition-colors hover:bg-[color:var(--mybet)]/15 disabled:cursor-not-allowed disabled:opacity-40"
            title="Auto-map every unmapped tournament to mybet in the current view"
          >
            {autoRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Auto-map MYBET
          </button>
        </div>
      </div>

      {autoStatus && (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-[color:var(--panel)] px-3 py-2 text-[12px] text-gray-300">
          {autoRunning && <Loader2 className="h-3 w-3 animate-spin text-[color:var(--total)]" />}
          {autoStatus}
        </div>
      )}

      {/* row 2: sport tabs — wrap across (up to) two lines */}
      <div className="-mx-1 mb-4 flex flex-wrap items-center gap-1.5 px-1">
        <SportTab
          active={sportFilter === 'all'}
          onClick={() => navigate(`/mapping${filterQuery()}`)}
          label="All"
          count={tournaments.length}
        />
        {sportTabs.map((s) => (
          <SportTab
            key={s.key}
            active={sportFilter === s.key}
            onClick={() => navigate(`/mapping/${sportToSlug(s.key)}${filterQuery()}`)}
            emoji={s.emoji}
            label={s.name}
            count={s.total}
            paired={s.paired}
            swiftOnly={s.total === 0 && s.swiftComps > 0 ? s.swiftComps : undefined}
          />
        ))}
      </div>

      {/* row 3: filter chips + search */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md bg-[color:var(--panel-2)] p-1">
          <FilterChip
            active={mappedFilter === 'all'}
            onClick={() => setParam('mapped', null)}
            label="All"
          />
          <FilterChip
            active={mappedFilter === 'mapped'}
            onClick={() => setParam('mapped', 'mapped')}
            label="Mapped"
            tone="green"
          />
          <FilterChip
            active={mappedFilter === 'unmapped'}
            onClick={() => setParam('mapped', 'unmapped')}
            label="Unmapped"
            tone="amber"
          />
          <span className="mx-0.5 h-4 w-px bg-[color:var(--line)]" />
          <FilterChip
            active={mappedFilter === 'verified'}
            onClick={() => setParam('mapped', 'verified')}
            label="Verified"
            tone="green"
          />
          <FilterChip
            active={mappedFilter === 'unverified'}
            onClick={() => setParam('mapped', 'unverified')}
            label="Unverified"
            tone="amber"
          />
        </div>
        {/* Active-window toggle. Its own group so it reads as orthogonal to the
            mapped/verified chips — those narrow by mapping state, this one by
            recency. Labelled with the hidden count so it's obvious what's
            being withheld rather than looking like an empty list. */}
        <div className="flex items-center gap-1 rounded-md bg-[color:var(--panel-2)] p-1">
          <FilterChip
            active={!showAllPeriods}
            onClick={() => setParam('all', null)}
            label="Active"
            tone="green"
          />
          <FilterChip
            active={showAllPeriods}
            onClick={() => setParam('all', '1')}
            label={hiddenOldCount > 0 ? `All time (+${hiddenOldCount})` : 'All time'}
          />
        </div>
        <input
          value={search}
          onChange={(e) => setParam('q', e.target.value)}
          placeholder="Search tournaments…"
          className="ml-auto w-64 rounded-md border border-[color:var(--line-soft)] bg-[color:var(--panel)] px-3 py-2 text-[13px] text-gray-200 placeholder:text-[color:var(--muted-2)] focus:border-[color:var(--line)] focus:outline-none"
        />
      </div>

      {/* status / callout */}
      {error ? (
        <Callout tone="error">
          Could not load mappings: {error}. Has{' '}
          <code className="text-gray-200">npm run build-mapping</code> been run?
        </Callout>
      ) : loading ? (
        <TableSkeleton rows={10} cols={6} />
      ) : compMap.size === 0 && mybetCompMap.size === 0 ? (
        <Callout tone="warn">
          Mapping tables are empty. Run <code className="text-gray-200">npm run build-mapping</code>.
        </Callout>
      ) : null}

      {/* SwiftBet-only sport selected — surface the count so the empty OPTIC
          table makes sense and link the user toward Notifications coverage. */}
      {sportFilter !== 'all' && !selectedTournament && (() => {
        const tab = sportTabs.find((t) => t.key === sportFilter)
        if (!tab || tab.total > 0 || tab.swiftComps === 0) return null
        return (
          <Callout tone="info">
            <span className="font-medium text-gray-100">{tab.name}</span> has{' '}
            {tab.swiftComps} SwiftBet competition{tab.swiftComps === 1 ? '' : 's'} but no OPTIC
            tournaments yet. See the{' '}
            <a href="/notifications" className="text-[color:var(--total)] underline">
              Notifications → SwiftBet competitions list
            </a>{' '}
            to browse them.
          </Callout>
        )
      })()}

      {/* main view: tournaments list or drill-down */}
      {selectedTournament ? (
        <DrillView
          row={selectedTournament}
          swiftEventById={swiftEventById}
          mybetEventById={mybetEventById}
          onNeedEventNames={requestEventNames}
          reloadToken={reloadKey}
          onBack={() => navigate(`/mapping/${sportSlug ?? ''}${filterQuery()}`)}
          onEditEvent={(t) => setEditor(t)}
          onReloadMappings={() => setReloadKey((k) => k + 1)}
        />
      ) : (
        <TournamentTable
          rows={visibleTournaments}
          onOpen={(t) =>
            navigate(
              `/mapping/${sportToSlug(sportGroupKey(t.rawSport))}/${encodeURIComponent(t.rawLeague)}${
                t.rawTournament ? `?t=${encodeURIComponent(t.rawTournament)}` : ''
              }`,
            )
          }
          onEdit={(t) =>
            setEditor({
              kind: 'competition',
              opticSportRaw: t.rawSport,
              opticLeagueRaw: t.rawLeague,
              opticTournamentRaw: t.rawTournament,
              label: `${sportLabel(t.sport)} · ${t.league}${
                t.tournament ? ' · ' + t.tournament : ''
              }`,
              currentSwiftIds: t.mappings
                .map((m) => m.swift_competition_id)
                .filter((x): x is string => !!x),
            })
          }
          onEditMybet={(t) =>
            setEditor({
              kind: 'competition',
              provider: 'mybet',
              opticSportRaw: t.rawSport,
              opticLeagueRaw: t.rawLeague,
              opticTournamentRaw: t.rawTournament,
              label: `${sportLabel(t.sport)} · ${t.league}${
                t.tournament ? ' · ' + t.tournament : ''
              }`,
              currentSwiftIds: t.mybetMappings
                .map((m) => m.swift_competition_id)
                .filter((x): x is string => !!x),
            })
          }
          onToggleVerify={async (t, m) => {
            if (!m.swift_competition_id) return
            try {
              await setCompetitionVerified({
                opticSportRaw: t.rawSport,
                opticLeagueRaw: t.rawLeague,
                opticTournamentRaw: t.rawTournament,
                swiftCompetitionId: m.swift_competition_id,
                verified: !m.verified,
                provider: m.provider,
              })
              setReloadKey((k) => k + 1)
            } catch (e) {
              setError(String(e))
            }
          }}
        />
      )}

      {editor && (
        <MappingEditor
          target={editor}
          onClose={() => setEditor(null)}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  )
}

// --- subcomponents -------------------------------------------------------

interface TournamentRowShape {
  sport: string
  league: string
  tournament: string
  rawSport: string
  rawLeague: string
  rawTournament: string
  count: number
  mappings: CompetitionMapping[]
  mybetMappings: CompetitionMapping[]
}

function TournamentTable({
  rows,
  onOpen,
  onEdit,
  onEditMybet,
  onToggleVerify,
}: {
  rows: TournamentRowShape[]
  onOpen: (t: TournamentRowShape) => void
  onEdit: (t: TournamentRowShape) => void
  onEditMybet: (t: TournamentRowShape) => void
  onToggleVerify: (t: TournamentRowShape, m: CompetitionMapping) => void
}) {
  return (
    <Table headers={['SPORT · LEAGUE', 'OPTIC · TOURNAMENT', 'FIXTURES', 'SWIFT · MAPPED TO', 'MYBET · MAPPED TO', 'CONF', '']}>
      {rows.map((t) => {
        const mapped = t.mappings.length > 0
        const allVerified = mapped && t.mappings.every((m) => m.verified)
        const mybetMapped = t.mybetMappings.length > 0
        return (
          <Row key={`${t.sport}|${t.league}|${t.tournament}`} onClick={() => onOpen(t)}>
            <Cell width="w-56">
              <span className="mr-2">{sportEmoji(t.sport)}</span>
              <span className="text-gray-400">{sportLabel(t.sport)}</span>
              <ChevronRight className="mx-1 inline h-3 w-3 text-gray-600" />
              <span className="font-bold text-gray-200">{t.league}</span>
            </Cell>
            <Cell>
              <SourceLabel kind="OPTIC" />
              <span className="text-gray-100">
                {t.tournament ? t.tournament : <span className="text-gray-500">{t.league}</span>}
              </span>
            </Cell>
            <Cell width="w-20" align="right">
              <span className="tabular-nums text-gray-400">{t.count}</span>
            </Cell>
            <Cell>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(t)
                  }}
                  className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-[var(--up)]"
                  title="Edit SWIFT mapping"
                  aria-label="Edit SWIFT mapping"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {mapped ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {t.mappings.map((m) => (
                      <SwiftChip
                        key={m.swift_competition_id ?? ''}
                        mapping={m}
                        onToggleVerify={(e) => {
                          e.stopPropagation()
                          onToggleVerify(t, m)
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <UnmappedSlot />
                )}
              </div>
            </Cell>
            <Cell>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onEditMybet(t)
                  }}
                  className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-[var(--live)]"
                  title="Edit mybet mapping"
                  aria-label="Edit mybet mapping"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {mybetMapped ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {t.mybetMappings.map((m) => (
                      <MybetChip
                        key={m.swift_competition_id ?? ''}
                        mapping={m}
                        onToggleVerify={(e) => {
                          e.stopPropagation()
                          onToggleVerify(t, m)
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <UnmappedSlot />
                )}
              </div>
            </Cell>
            <Cell width="w-20" align="right">
              {mapped ? (
                <span
                  className={[
                    'text-[11px] font-bold tabular-nums',
                    allVerified ? 'text-[var(--total)]' : 'text-gray-300',
                  ].join(' ')}
                >
                  {t.mappings.length}
                  <span className="ml-0.5 text-[9px] text-gray-500">
                    /{t.mappings.filter((m) => m.verified).length}✓
                  </span>
                </span>
              ) : (
                <span className="text-[10px] tracking-widest text-gray-700">—</span>
              )}
            </Cell>
            <Cell width="w-10" align="right">
              <ChevronRight className="inline h-3.5 w-3.5 text-gray-600" />
            </Cell>
          </Row>
        )
      })}
    </Table>
  )
}

/** One SWIFT mapping rendered as a pill with an inline verify-toggle. */
function SwiftChip({
  mapping,
  onToggleVerify,
}: {
  mapping: CompetitionMapping
  onToggleVerify: (e: React.MouseEvent) => void
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border ${BRAND_CHIP.swift} px-2 py-0.5 text-[11px]`}>
      <SourcePill kind="SWIFT" />
      <span className="text-gray-100">{mapping.swift_competition}</span>
      <span className="text-[9px] tabular-nums text-gray-500">{Math.round(mapping.confidence * 100)}%</span>
      {mapping.source === 'manual' && <ManualBadge />}
      <button
        onClick={onToggleVerify}
        className={[
          'rounded p-0.5 transition-colors',
          mapping.verified
            ? 'text-[var(--total)] hover:bg-[var(--total)]/10'
            : 'text-gray-500 hover:bg-white/10 hover:text-gray-200',
        ].join(' ')}
        title={mapping.verified ? 'Click to unverify' : 'Confirm this mapping is correct'}
        aria-label="Toggle verified"
      >
        <Check className="h-3 w-3" strokeWidth={mapping.verified ? 3 : 2} />
      </button>
    </span>
  )
}


function ManualBadge() {
  return (
    <span className="rounded border border-[color:var(--up)]/30 bg-[color:var(--up)]/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--up)]">
      Manual
    </span>
  )
}

/** One mybet mapping rendered as a pill (live accent) with a verify-toggle. */
function MybetChip({
  mapping,
  onToggleVerify,
}: {
  mapping: CompetitionMapping
  onToggleVerify: (e: React.MouseEvent) => void
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border ${BRAND_CHIP.mybet} px-2 py-0.5 text-[11px]`}>
      <SourcePill kind="MYBET" />
      <span className="text-gray-100">{mapping.swift_competition}</span>
      <span className="text-[9px] tabular-nums text-gray-500">{Math.round(mapping.confidence * 100)}%</span>
      {mapping.source === 'manual' && (
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${BRAND_PILL.mybet}`}>Manual</span>
      )}
      <button
        onClick={onToggleVerify}
        className={[
          'rounded p-0.5 transition-colors',
          mapping.verified
            ? 'text-[var(--total)] hover:bg-[var(--total)]/10'
            : 'text-gray-500 hover:bg-white/10 hover:text-gray-200',
        ].join(' ')}
        title={mapping.verified ? 'Click to unverify' : 'Confirm this mapping is correct'}
        aria-label="Toggle verified"
      >
        <Check className="h-3 w-3" strokeWidth={mapping.verified ? 3 : 2} />
      </button>
    </span>
  )
}

type EventStatus = 'all' | 'live' | 'upcoming' | 'completed'

function DrillView({
  row,
  swiftEventById,
  mybetEventById,
  onNeedEventNames,
  reloadToken,
  onBack,
  onEditEvent,
  onReloadMappings,
}: {
  row: {
    sport: string
    league: string
    tournament: string
    rawSport: string
    rawLeague: string
    rawTournament: string
    mappings: CompetitionMapping[]
    mybetMappings: CompetitionMapping[]
  }
  swiftEventById: Map<string, SwiftEvent>
  mybetEventById: Map<string, MybetEvent>
  onNeedEventNames: (provider: 'swift' | 'mybet', ids: string[]) => void
  /** Page-level reload counter — bumped by editor saves and auto-map runs. */
  reloadToken: number
  onBack: () => void
  onEditEvent: (t: EditorTarget) => void
  onReloadMappings: () => void
}) {
  const navigate = useNavigate()
  const { fixtures, loading, error } = useTournamentFixtures(
    row.rawSport,
    row.rawLeague,
    row.rawTournament || null,
  )
  const [statusFilter, setStatusFilter] = useState<EventStatus>('all')
  const [autoRunning, setAutoRunning] = useState(false)
  const [autoStatus, setAutoStatus] = useState<string | null>(null)

  // Event mappings for THIS tournament's fixtures only. The page used to hold
  // every row for both books (13.9k + 8.1k, ~22 sequential pages) purely so the
  // drill could read a few dozen. `bump` re-reads after a save/auto-map.
  const [eventMap, setEventMap] = useState<Map<string, EventMapping>>(new Map())
  const [mybetEventMap, setMybetEventMap] = useState<Map<string, EventMapping>>(new Map())
  const fixtureIdKey = useMemo(() => fixtures.map((f) => f.id).sort().join(','), [fixtures])
  useEffect(() => {
    let alive = true
    // No early-return-with-setState for the empty case: fetchEventMappingsFor
    // short-circuits on an empty id list, so the maps still clear, but they do
    // it in the .then rather than synchronously during the effect body.
    const ids = fixtureIdKey ? fixtureIdKey.split(',') : []
    const index = (list: EventMapping[]) => {
      const m = new Map<string, EventMapping>()
      for (const e of list) m.set(e.optic_fixture_id, e)
      return m
    }
    Promise.all([fetchEventMappingsFor(ids, 'swift'), fetchEventMappingsFor(ids, 'mybet')])
      .then(([sw, mb]) => {
        if (!alive) return
        setEventMap(index(sw))
        setMybetEventMap(index(mb))
      })
      .catch(() => {/* rows fall back to unmapped; the page still works */})
    return () => {
      alive = false
    }
    // reloadToken is the page's reloadKey: both the editor's onSaved and this
    // drill's auto-map bump it, so a write refreshes these maps too.
  }, [fixtureIdKey, reloadToken])

  const counts = useMemo(() => {
    const c = { all: fixtures.length, live: 0, upcoming: 0, completed: 0 }
    for (const f of fixtures) c[f.status]++
    return c
  }, [fixtures])

  // Ask for the SWIFT/mybet names this drill actually needs — the ones the daily
  // catalogue snapshot doesn't already have. Keyed off `fixtures` rather than the
  // status-filtered `visible` so toggling a filter doesn't kick off fresh
  // requests; one tournament is a single small batch either way.
  useEffect(() => {
    const swiftIds: string[] = []
    const mybetIds: string[] = []
    for (const f of fixtures) {
      const s = eventMap.get(f.id)?.swift_event_id
      if (s && !swiftEventById.has(s)) swiftIds.push(s)
      const mb = mybetEventMap.get(f.id)?.swift_event_id
      if (mb && !mybetEventById.has(mb)) mybetIds.push(mb)
    }
    if (swiftIds.length) onNeedEventNames('swift', swiftIds)
    if (mybetIds.length) onNeedEventNames('mybet', mybetIds)
  }, [fixtures, eventMap, mybetEventMap, swiftEventById, mybetEventById, onNeedEventNames])

  const visible = useMemo(() => {
    const filtered = statusFilter === 'all' ? fixtures : fixtures.filter((f) => f.status === statusFilter)
    // Sort: LIVE first → UPCOMING (soonest first) → COMPLETED (most recent first).
    const order: Record<typeof filtered[number]['status'], number> = {
      live: 0,
      upcoming: 1,
      completed: 2,
    }
    return [...filtered].sort((a, b) => {
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
      const ta = new Date(a.startTime).getTime()
      const tb = new Date(b.startTime).getTime()
      return a.status === 'completed' ? tb - ta : ta - tb
    })
  }, [fixtures, statusFilter])

  // Auto-map every currently-visible unmapped event for one brand, by team names
  // + start time. SwiftBet candidates are pooled from the tournament's mapped
  // competitions; mybet's competitions are too sparse, so its candidates are all
  // mybet events of the tournament's sport (the team+time match does the rest).
  async function runEventAutoMap(provider: 'swift' | 'mybet') {
    if (autoRunning) return
    setAutoRunning(true)
    const brand = provider === 'mybet' ? 'mybet' : 'SwiftBet'
    setAutoStatus(`Loading ${brand} catalogue…`)
    try {
      const emap = provider === 'mybet' ? mybetEventMap : eventMap
      let candidates: SwiftEvent[] = []
      if (provider === 'swift') {
        const cat = await getSwiftCatalog()
        const seen = new Set<string>()
        for (const m of row.mappings) {
          if (!m.swift_competition_id) continue
          for (const e of cat.eventsByCompId.get(m.swift_competition_id) ?? []) {
            if (!seen.has(e.id)) {
              seen.add(e.id)
              candidates.push(e)
            }
          }
        }
      } else {
        const cat = await getMybetCatalog().catch(() => null)
        if (!cat) {
          setAutoStatus('mybet catalogue unavailable.')
          setAutoRunning(false)
          return
        }
        const wantSport = (mybetSportOf(row.rawSport) ?? '').toLowerCase()
        candidates = cat.events.filter((e) => (e.sport ?? '').toLowerCase() === wantSport)
      }
      if (candidates.length === 0) {
        setAutoStatus(`No ${brand} events available for this tournament.`)
        setAutoRunning(false)
        setTimeout(() => setAutoStatus(null), 3500)
        return
      }
      // Don't reassign an event already taken by an existing event_mapping.
      const taken = new Set<string>()
      for (const m of emap.values()) if (m.swift_event_id) taken.add(m.swift_event_id)

      const todo = visible.filter((f) => !emap.get(f.id)?.swift_event_id)
      if (todo.length === 0) {
        setAutoStatus(`Nothing to auto-map on ${brand} — every visible event is already mapped.`)
        setAutoRunning(false)
        setTimeout(() => setAutoStatus(null), 3500)
        return
      }
      let paired = 0
      for (let i = 0; i < todo.length; i++) {
        const f = todo[i]
        setAutoStatus(`Auto-mapping ${brand} ${i + 1}/${todo.length}…`)
        const hit = bestSwiftEventMatch({
          opticHome: f.homeName,
          opticAway: f.awayName,
          opticStartIso: f.startTime,
          candidates: candidates.filter((c) => !taken.has(c.id)),
        })
        if (!hit) continue
        try {
          // 'auto' — a machine guess the matcher is free to revisit (see
          // MappingSource). Only the editor's hand-picks are 'manual'.
          await setEventMappingManual({ opticFixtureId: f.id, swiftEventId: hit.event.id, provider, source: 'auto' })
          taken.add(hit.event.id)
          paired++
        } catch {
          /* per-row failure shouldn't kill the run */
        }
      }
      setAutoStatus(`Done — paired ${paired}/${todo.length} on ${brand}.`)
      onReloadMappings()
      setTimeout(() => setAutoStatus(null), 4500)
    } catch (e) {
      setAutoStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAutoRunning(false)
    }
  }

  return (
    <div>
      {/* breadcrumb + back */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-[11px] font-bold tracking-widest text-gray-300 hover:border-gray-600"
        >
          <ArrowLeft className="h-3 w-3" />
          BACK
        </button>
        <div className="flex items-center gap-2 text-[12px] tracking-widest">
          <span>{sportEmoji(row.sport)}</span>
          <span className="text-gray-400">{sportLabel(row.sport)}</span>
          <ChevronRight className="h-3 w-3 text-gray-600" />
          <span className="font-bold text-gray-100">{row.league}</span>
          {row.tournament && (
            <>
              <ChevronRight className="h-3 w-3 text-gray-600" />
              <span className="text-gray-200">{row.tournament}</span>
            </>
          )}
        </div>
        {row.mappings.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px] tracking-widest">
            {row.mappings.map((m) => (
              <span
                key={m.swift_competition_id}
                className="inline-flex items-center gap-1.5 rounded border border-[var(--up)]/30 bg-[var(--up)]/[0.06] px-2 py-0.5"
              >
                <SourcePill kind="SWIFT" />
                <span className="text-gray-200">{m.swift_competition}</span>
                <ConfidenceBadge value={m.confidence} mapped />
                {m.verified && (
                  <Check className="h-3 w-3 text-[var(--total)]" strokeWidth={3} aria-label="verified" />
                )}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* status tabs + auto-map */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <StatusChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} label="ALL" count={counts.all} />
        <StatusChip active={statusFilter === 'live'} onClick={() => setStatusFilter('live')} label="LIVE" count={counts.live} tone="live" />
        <StatusChip active={statusFilter === 'upcoming'} onClick={() => setStatusFilter('upcoming')} label="UPCOMING" count={counts.upcoming} tone="up" />
        <StatusChip active={statusFilter === 'completed'} onClick={() => setStatusFilter('completed')} label="COMPLETED" count={counts.completed} />

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => runEventAutoMap('swift')}
            disabled={
              autoRunning ||
              row.mappings.length === 0 ||
              visible.every((f) => !!eventMap.get(f.id)?.swift_event_id)
            }
            className="flex items-center gap-1.5 rounded-md border border-[var(--swift)]/40 bg-[var(--swift)]/10 px-3 py-1.5 text-[10px] font-bold tracking-widest text-[var(--swift)] transition-colors hover:bg-[var(--swift)]/20 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              row.mappings.length === 0
                ? 'Map this tournament to SwiftBet first, then auto-map its events.'
                : 'Auto-map every unmapped SwiftBet event currently visible'
            }
          >
            {autoRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AUTO-MAP SWIFT
          </button>
          <button
            onClick={() => runEventAutoMap('mybet')}
            disabled={autoRunning || visible.every((f) => !!mybetEventMap.get(f.id)?.swift_event_id)}
            className="flex items-center gap-1.5 rounded-md border border-[var(--mybet)]/40 bg-[var(--mybet)]/10 px-3 py-1.5 text-[10px] font-bold tracking-widest text-[var(--mybet)] transition-colors hover:bg-[var(--mybet)]/20 disabled:cursor-not-allowed disabled:opacity-40"
            title="Auto-map every unmapped mybet event currently visible"
          >
            {autoRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AUTO-MAP MYBET
          </button>
        </div>
      </div>

      {autoStatus && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[11px] tracking-widest text-gray-300">
          {autoRunning && <Loader2 className="h-3 w-3 animate-spin text-[var(--total)]" />}
          {autoStatus}
        </div>
      )}

      {error ? (
        <div className="flex h-32 items-center justify-center rounded-md border border-[var(--line)] text-[12px] tracking-widest text-gray-600">
          ERROR LOADING EVENTS — {error}
        </div>
      ) : loading ? (
        <TableSkeleton rows={8} cols={5} />
      ) : visible.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-md border border-[var(--line)] text-[12px] tracking-widest text-gray-600">
          NO EVENTS
        </div>
      ) : (
        <Table headers={['START', 'STATUS', 'OPTIC · EVENT', 'SWIFT · MAPPED TO', 'MYBET · MAPPED TO', 'CONFIDENCE']}>
          {visible.map((f) => {
            const m = eventMap.get(f.id)
            const mb = mybetEventMap.get(f.id)
            return (
              <Row key={f.id} onClick={() => navigate(`/fixture/${encodeURIComponent(f.id)}`)}>
                <Cell width="w-44">
                  <span className="flex flex-col gap-0.5 tabular-nums">
                    <span className="text-gray-200">
                      {melbDateTimeShort(f.startTime)} <span className="text-gray-500">MEL</span>
                    </span>
                    <span className="text-[11px] text-gray-500">
                      {utcDateTimeShort(f.startTime)} UTC
                    </span>
                  </span>
                </Cell>
                <Cell width="w-24">
                  <StatusBadge status={f.status} />
                </Cell>
                <Cell>
                  <SourceLabel kind="OPTIC" />
                  <span className="text-gray-100">
                    {f.homeName} <span className="text-gray-600">v</span> {f.awayName}
                  </span>
                  <span className="ml-2 text-[10px] tracking-widest text-gray-600">
                    {f.opticId ?? f.id}
                  </span>
                </Cell>
                <Cell width="w-80">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onEditEvent({
                          kind: 'event',
                          opticFixtureId: f.id,
                          opticSportRaw: row.rawSport,
                          label: `${f.homeName} v ${f.awayName} — ${kickoffLabel(f.startTime)} UTC`,
                          // Event editor scopes candidate events to ONE SWIFT
                          // competition. If the OPTIC tournament has multiple,
                          // we surface the first; the user can still search by
                          // name across the catalogue.
                          swiftCompetitionId: row.mappings[0]?.swift_competition_id ?? null,
                          swiftCompetitionName: row.mappings[0]?.swift_competition ?? null,
                          currentSwiftId: m?.swift_event_id ?? null,
                        })
                      }}
                      className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-[var(--swift)]"
                      title="Edit SWIFT mapping"
                      aria-label="Edit SWIFT mapping"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <div className="min-w-0 flex-1">
                      {m?.swift_event_id ? (
                        <span className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            <SourcePill kind="SWIFT" />
                            <span className="truncate text-gray-100">
                              {swiftEventLabel(m.swift_event_id, swiftEventById)}
                            </span>
                            {m.source === 'manual' && <ManualBadge />}
                          </span>
                          <span className="ml-8 truncate text-[10px] tracking-widest text-gray-600">
                            {m.swift_event_id}
                          </span>
                        </span>
                      ) : (
                        <UnmappedSlot />
                      )}
                    </div>
                  </div>
                </Cell>
                <Cell width="w-80">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onEditEvent({
                          kind: 'event',
                          provider: 'mybet',
                          opticFixtureId: f.id,
                          opticSportRaw: row.rawSport,
                          label: `${f.homeName} v ${f.awayName} — ${kickoffLabel(f.startTime)} UTC`,
                          swiftCompetitionId: null,
                          swiftCompetitionName: null,
                          currentSwiftId: mb?.swift_event_id ?? null,
                        })
                      }}
                      className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-[var(--mybet)]"
                      title="Edit mybet mapping"
                      aria-label="Edit mybet mapping"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <div className="min-w-0 flex-1">
                      {mb?.swift_event_id ? (
                        <span className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            <SourcePill kind="MYBET" />
                            <span className="truncate text-gray-100">
                              {mybetEventLabel(mb.swift_event_id, mybetEventById)}
                            </span>
                            {mb.source === 'manual' && <ManualBadge />}
                          </span>
                          <span className="ml-8 truncate text-[10px] tracking-widest text-gray-600">
                            {mb.swift_event_id}
                            {mb.confidence ? ` · ${Math.round(mb.confidence * 100)}%` : ''}
                          </span>
                        </span>
                      ) : (
                        <UnmappedSlot />
                      )}
                    </div>
                  </div>
                </Cell>
                <Cell width="w-20" align="right">
                  <ConfidenceBadge value={m?.confidence ?? 0} mapped={!!m?.swift_event_id} />
                </Cell>
              </Row>
            )
          })}
        </Table>
      )}
    </div>
  )
}

/** Readable label for a SWIFT event by id: prefer "Home v Away", else `name`,
 *  else a shortened id so the row never falls apart while the catalogue loads. */
function swiftEventLabel(id: string, byId: Map<string, SwiftEvent>): string {
  const e = byId.get(id)
  if (!e) return id.slice(0, 8) + '…'
  if (e.home && e.away) return `${e.home} v ${e.away}`
  if (e.name) return e.name
  return id.slice(0, 8) + '…'
}

/**
 * Identity a book competition is allowed to span. OPTIC splits one real tennis
 * event into sibling tournaments — "Los Cabos, Mexico" and "Los Cabos, Mexico,
 * Qualifying" — that the books carry as a single competition, so both siblings
 * collapse to the base "Los Cabos". Non-tennis rows have no tournament and fall
 * back to sport|league, which keeps them strictly 1:1 as before.
 */
function tournamentBase(t: { sport: string; league: string; rawTournament: string }): string {
  const head = (t.rawTournament ?? '').split(',')[0].trim().toLowerCase()
  return head || `${t.sport}|${t.league}`.toLowerCase()
}

/** Readable label for a mybet event by id — "Home v Away", else name, else id. */
function mybetEventLabel(id: string, byId: Map<string, MybetEvent>): string {
  const e = byId.get(id)
  if (!e) return id
  if (e.home && e.away) return `${e.home} v ${e.away}`
  if (e.name) return e.name
  return id
}

function StatusChip({
  active,
  onClick,
  label,
  count,
  tone,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  tone?: 'live' | 'up'
}) {
  const activeBg =
    tone === 'live'
      ? 'bg-[color:var(--live)] text-white'
      : tone === 'up'
        ? 'bg-[color:var(--up)] text-black'
        : 'bg-white/10 text-white'
  return (
    <button
      onClick={onClick}
      className={[
        'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
        active
          ? activeBg
          : 'border border-[color:var(--line-soft)] bg-[color:var(--panel)] text-[color:var(--muted)] hover:border-[color:var(--line)] hover:text-gray-200',
      ].join(' ')}
    >
      <span>{label}</span>
      <span className={`tabular-nums ${active ? 'opacity-80' : 'text-[color:var(--muted-2)]'}`}>
        {count}
      </span>
    </button>
  )
}

function StatusBadge({ status }: { status: 'live' | 'upcoming' | 'completed' }) {
  if (status === 'live') {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[color:var(--live)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />
        Live
      </span>
    )
  }
  if (status === 'upcoming') {
    return <span className="text-[11.5px] font-medium text-[color:var(--up)]">Upcoming</span>
  }
  return <span className="text-[11.5px] font-medium text-[color:var(--muted)]">Final</span>
}

// --- atoms ---------------------------------------------------------------

function FilterChip({
  active,
  onClick,
  label,
  tone,
}: {
  active: boolean
  onClick: () => void
  label: string
  tone?: 'green' | 'amber'
}) {
  const activeBg =
    tone === 'green'
      ? 'bg-[color:var(--total)] text-black'
      : tone === 'amber'
        ? 'bg-[color:var(--up)] text-black'
        : 'bg-white/10 text-white'
  return (
    <button
      onClick={onClick}
      className={[
        'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
        active ? activeBg : 'text-[color:var(--muted)] hover:bg-white/[0.04]',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function SportTab({
  active,
  onClick,
  label,
  emoji,
  count,
  paired,
  swiftOnly,
}: {
  active: boolean
  onClick: () => void
  label: string
  emoji?: string
  count: number
  paired?: number
  /** Number of SwiftBet competitions in this sport when OPTIC has zero. */
  swiftOnly?: number
}) {
  // SwiftBet-only sports get a softer styling so they read as "available to
  // explore on the SWIFT side" rather than active OPTIC coverage.
  const isSwiftOnly = !!swiftOnly
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-[color:var(--total)] text-black'
          : isSwiftOnly
            ? 'border border-dashed border-[color:var(--line-soft)] bg-transparent text-gray-500 hover:border-[color:var(--line)] hover:bg-white/[0.03] hover:text-gray-300'
            : 'border border-[color:var(--line-soft)] bg-[color:var(--panel)] text-gray-300 hover:border-[color:var(--line)] hover:bg-white/[0.04] hover:text-white',
      ].join(' ')}
    >
      {emoji && <span className={`text-sm leading-none ${isSwiftOnly && !active ? 'opacity-60' : ''}`}>{emoji}</span>}
      <span>{label}</span>
      <span
        className={`rounded px-1 py-0.5 text-[10px] tabular-nums ${
          active
            ? 'bg-black/15 text-black/80'
            : isSwiftOnly
              ? 'bg-white/[0.03] text-gray-600'
              : 'bg-white/[0.04] text-[color:var(--muted-2)]'
        }`}
      >
        {isSwiftOnly ? `SWIFT ${swiftOnly}` : paired != null ? `${paired}/${count}` : count}
      </span>
    </button>
  )
}

function SourcePill({ kind, inline }: { kind: 'OPTIC' | 'SWIFT' | 'MYBET'; inline?: boolean }) {
  const cls = BRAND_PILL[kind.toLowerCase() as Brand]
  return (
    <span
      className={`${inline ? '' : 'inline-flex'} items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {kind}
    </span>
  )
}

function SourceLabel({ kind }: { kind: 'OPTIC' | 'SWIFT' | 'MYBET' }) {
  return (
    <span className="mr-2 align-baseline">
      <SourcePill kind={kind} />
    </span>
  )
}

function ConfidenceBadge({ value, mapped }: { value: number; mapped: boolean }) {
  const pct = Math.round(value * 100)
  if (!mapped) {
    return <span className="text-[11px] tabular-nums text-[color:var(--muted-2)]/60">{pct ? `${pct}%` : '—'}</span>
  }
  const tone =
    value >= 0.8
      ? 'text-[color:var(--total)]'
      : value >= 0.5
        ? 'text-[color:var(--up)]'
        : 'text-[color:var(--live)]'
  return <span className={`text-[12px] font-semibold tabular-nums ${tone}`}>{pct}%</span>
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg bg-[color:var(--panel)]/40">
      <table className="w-full">
        <thead className="bg-black/[0.15]">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="border-b border-[color:var(--line-soft)] px-3 py-2.5 text-left text-[11px] font-medium text-[color:var(--muted)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Row({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={`border-b border-white/[0.03] last:border-b-0 hover:bg-white/[0.02] ${
        onClick ? 'cursor-pointer' : ''
      }`}
    >
      {children}
    </tr>
  )
}

function Cell({
  children,
  width,
  align = 'left',
}: {
  children: React.ReactNode
  width?: string
  align?: 'left' | 'right'
}) {
  return (
    <td className={`px-3 py-2.5 text-[12.5px] ${width ?? ''} ${align === 'right' ? 'text-right' : ''}`}>
      {children}
    </td>
  )
}

function UnmappedSlot() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[color:var(--line)] px-2 py-1 text-[11px] text-[color:var(--muted-2)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--muted-2)]/60" />
      Unmapped
    </span>
  )
}

function Callout({ tone, children }: { tone: 'info' | 'warn' | 'error'; children: React.ReactNode }) {
  const border =
    tone === 'error'
      ? 'border-[color:var(--live)]/35'
      : tone === 'warn'
        ? 'border-[color:var(--up)]/35'
        : 'border-[color:var(--line-soft)]'
  const icon =
    tone === 'error' ? (
      <Database className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--live)]" />
    ) : tone === 'warn' ? (
      <Database className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--up)]" />
    ) : (
      <Database className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--muted)]" />
    )
  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-lg border bg-[color:var(--panel)] px-4 py-3 ${border}`}
    >
      {icon}
      <div className="text-[13px] leading-relaxed text-[color:var(--muted)]">{children}</div>
    </div>
  )
}
