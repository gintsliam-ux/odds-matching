import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { FixtureGrid } from '../components/FixtureGrid'
import { DateBar } from '../components/DateBar'
import { GridSkeleton } from '../components/Skeleton'
import { useTerminal } from '../components/Layout'
import { favouriteMatches, useFavourites } from '../lib/favourites'
import { sportGroupKey } from '../lib/sports'
import { useSportUniverse } from '../hooks/useSportUniverse'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { fetchFixturesBySport } from '../lib/dataSource'
import type { Fixture, FixtureStatus } from '../lib/types'

function DropdownLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-[11px] tracking-widest text-gray-500">
      {label}
      <div className="relative">
        {children}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
      </div>
    </label>
  )
}

function titleCaseSport(s: string): string {
  return s
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''))
    .join(' ')
}

function statusFromPath(pathname: string): FixtureStatus | 'all' {
  if (pathname.startsWith('/live')) return 'live'
  if (pathname.startsWith('/upcoming')) return 'upcoming'
  if (pathname.startsWith('/completed')) return 'completed'
  return 'all'
}

export default function Terminal() {
  const { fixtures, now, feed, error, day } = useTerminal()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { sport, favId } = useParams()
  const [params, setParams] = useSearchParams()
  const favourites = useFavourites()
  const universe = useSportUniverse()

  /** Match a fixture against a chosen sport, including parent-group siblings.
   *  e.g. selecting "basketball" matches NBA/WNBA rows too; selecting "nba"
   *  matches only NBA. Same for baseball↔mlb, ice hockey↔nhl, etc. */
  function sportMatches(fixtureSport: string, target: string): boolean {
    return fixtureSport === target || sportGroupKey(fixtureSport) === target
  }

  // Path drives status for the top-level views (/, /live, /upcoming, /completed).
  // On `/sport/:sport` the path is "all" so the status comes from `?status=`
  // — that's what the in-page tab strip writes to.
  const pathStatus = statusFromPath(pathname)
  const sportStatusParam = params.get('status')
  const status: FixtureStatus | 'all' = sport
    ? sportStatusParam === 'live' || sportStatusParam === 'upcoming' || sportStatusParam === 'completed'
      ? sportStatusParam
      : 'all'
    : pathStatus
  const fav = favId ? favourites.find((f) => f.id === favId) : undefined
  const search = params.get('q') ?? ''
  // Sport is pinned by the URL on `/sport/:sport`; elsewhere it's a local filter.
  const [sportFilter, setSportFilter] = useState('all')
  const [league, setLeague] = useState('all')
  const effectiveSport = sport ?? (sportFilter === 'all' ? null : sportFilter)

  // /upcoming and /completed browse a specific day (fetched in Layout).
  const dateMode = day.mode
  const date = day.date

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    value ? next.set(key, value) : next.delete(key)
    setParams(next, { replace: true })
  }

  // When the user pins a sport via /sport/:sport, the in-window ±6h feed often
  // has nothing (NBA between games, EPL midweek, etc). Fall back to a direct
  // by-sport DB fetch (paginated; first page = 200 rows; user can "Load more").
  const [sportFallback, setSportFallback] = useState<Fixture[] | null>(null)
  const [sportFallbackLoading, setSportFallbackLoading] = useState(false)
  const [sportPage, setSportPage] = useState(0)
  const [sportHasMore, setSportHasMore] = useState(false)
  const [sportLoadingMore, setSportLoadingMore] = useState(false)
  // Reset paging when the sport switches.
  useEffect(() => {
    setSportFallback(null)
    setSportPage(0)
    setSportHasMore(false)
    if (!sport || dateMode) return
    // Multiple raw slugs can resolve to one prettified sport (Rugby Union pulls
    // from rugby_union AND reclassified `rugby` rows).
    const raws = universe.rawSportsAll.get(sport) ?? [universe.rawSport.get(sport) ?? sport]
    let alive = true
    setSportFallbackLoading(true)
    fetchFixturesBySport(raws, 0)
      .then(({ rows, hasMore }) => {
        if (!alive) return
        setSportFallback(rows)
        setSportHasMore(hasMore)
      })
      .catch(() => alive && setSportFallback([]))
      .finally(() => alive && setSportFallbackLoading(false))
    return () => {
      alive = false
    }
  }, [sport, dateMode, universe])

  const loadMoreSport = async () => {
    if (!sport || sportLoadingMore || !sportHasMore) return
    setSportLoadingMore(true)
    try {
      const raws = universe.rawSportsAll.get(sport) ?? [universe.rawSport.get(sport) ?? sport]
      const next = sportPage + 1
      const { rows, hasMore } = await fetchFixturesBySport(raws, next)
      setSportFallback((prev) => (prev ?? []).concat(rows))
      setSportPage(next)
      setSportHasMore(hasMore)
    } catch {
      /* keep current page on error */
    } finally {
      setSportLoadingMore(false)
    }
  }

  // On /sport/:sport, prefer the fallback so the page can show next/recent
  // games even when the live ±6h window is empty.
  const source = dateMode
    ? day.fixtures
    : sport && sportFallback
      ? sportFallback
      : fixtures

  // Status / route-sport / favourite scope (before the user's local sport+league dropdowns).
  const routeScoped = useMemo(
    () =>
      source.filter(
        (f) =>
          (status === 'all' || f.status === status) &&
          (!sport || sportMatches(f.sport, sport)) &&
          (!fav || favouriteMatches(fav, f.sport, f.league)),
      ),
    [source, status, sport, fav],
  )

  // Status-tab counts for /sport/:sport: same scope as `routeScoped` but
  // ignoring the status filter, so the tabs show the totals across every bucket.
  const sportStatusCounts = useMemo(() => {
    if (!sport) return { all: 0, live: 0, upcoming: 0, completed: 0 }
    let live = 0, upcoming = 0, completed = 0
    for (const f of source) {
      if (!sportMatches(f.sport, sport)) continue
      if (f.status === 'live') live++
      else if (f.status === 'upcoming') upcoming++
      else completed++
    }
    return { all: live + upcoming + completed, live, upcoming, completed }
  }, [source, sport])

  // Counts per sport in the current scope (for the SPORT dropdown badges).
  const sportCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of routeScoped) m.set(f.sport, (m.get(f.sport) ?? 0) + 1)
    return m
  }, [routeScoped])

  // Hybrid sport list: union of universe + anything in scope (covers a future
  // sport before its first universe-cache load). In-scope sports come first.
  const sportsForFilter = useMemo(() => {
    const all = new Set<string>([...universe.sports, ...sportCounts.keys()])
    return [...all].sort((a, b) => {
      const ca = sportCounts.get(a) ?? 0
      const cb = sportCounts.get(b) ?? 0
      if ((ca > 0) !== (cb > 0)) return ca > 0 ? -1 : 1 // active sports first
      return a.localeCompare(b)
    })
  }, [universe, sportCounts])

  // Reset the league when the selected sport changes (a stale value would yield zero matches).
  const sportKey = effectiveSport ?? '__all__'
  const lastSportKey = useRef(sportKey)
  useEffect(() => {
    if (lastSportKey.current !== sportKey) {
      lastSportKey.current = sportKey
      setLeague('all')
    }
  }, [sportKey])

  // Counts per league in scope (for the LEAGUE dropdown badges).
  const leagueCounts = useMemo(() => {
    const within = effectiveSport
      ? routeScoped.filter((f) => sportMatches(f.sport, effectiveSport))
      : routeScoped
    const m = new Map<string, number>()
    for (const f of within) if (f.league) m.set(f.league, (m.get(f.league) ?? 0) + 1)
    return m
  }, [routeScoped, effectiveSport])

  // Hybrid league list: full universe for the chosen sport (or every league
  // when SPORT=ALL), merged with anything in scope; in-scope leagues first.
  const leagues = useMemo(() => {
    const fromUniverse = effectiveSport
      ? (universe.leaguesBySport.get(effectiveSport) ?? [])
      : [...universe.leaguesBySport.values()].flat()
    const all = new Set<string>([...fromUniverse, ...leagueCounts.keys()])
    return [...all].sort((a, b) => {
      const ca = leagueCounts.get(a) ?? 0
      const cb = leagueCounts.get(b) ?? 0
      if ((ca > 0) !== (cb > 0)) return ca > 0 ? -1 : 1
      return a.localeCompare(b)
    })
  }, [universe, leagueCounts, effectiveSport])

  const scoped = useMemo(
    () => (effectiveSport ? routeScoped.filter((f) => sportMatches(f.sport, effectiveSport)) : routeScoped),
    [routeScoped, effectiveSport],
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = scoped.filter((f) => {
      if (league !== 'all' && f.league !== league) return false
      if (q && !`${f.homeName} ${f.awayName} ${f.league}`.toLowerCase().includes(q)) return false
      return true
    })
    // Apply the same upcoming → live → completed ordering as the home board,
    // so clicking into a sport or league doesn't flip the cards back to
    // newest-first (the by-sport fetch returns DESC by scheduled_start).
    const prio: Record<typeof filtered[number]['status'], number> = {
      upcoming: 0, live: 1, completed: 2,
    }
    return filtered.slice().sort((a, b) => {
      const pa = prio[a.status] ?? 99
      const pb = prio[b.status] ?? 99
      if (pa !== pb) return pa - pb
      const ta = Date.parse(a.startTime)
      const tb = Date.parse(b.startTime)
      return a.status === 'completed' ? tb - ta : ta - tb
    })
  }, [scoped, league, search])

  const title = fav
    ? fav.name
    : sport
      ? titleCaseSport(sport)
      : status === 'all'
        ? 'All events'
        : status.charAt(0).toUpperCase() + status.slice(1)

  useDocumentTitle(title)

  const loading = dateMode
    ? day.loading
    : sport
      ? sportFallbackLoading && !sportFallback
      : feed === 'connecting' && fixtures.length === 0
  const errMsg = dateMode ? day.error : feed === 'error' && fixtures.length === 0 ? error : null
  const favMissing = !!favId && !fav && fixtures.length > 0

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-[color:var(--line-soft)] px-5 py-4">
        <h1 className="text-[18px] font-semibold tracking-tight text-gray-100">{title}</h1>

        {/* Only show the SPORT picker when the route hasn't pinned one. */}
        {!sport && (
          <DropdownLabel label="SPORT">
            <select
              value={sportFilter}
              onChange={(e) => setSportFilter(e.target.value)}
              className="appearance-none rounded-md border border-[var(--line)] bg-[var(--panel)] py-1.5 pl-3 pr-8 text-[12px] font-bold tracking-wider text-gray-200 focus:border-gray-600 focus:outline-none"
            >
              <option value="all">ALL ({routeScoped.length})</option>
              {sportsForFilter.map((s) => {
                const n = sportCounts.get(s) ?? 0
                return (
                  <option key={s} value={s}>
                    {s.toUpperCase()} ({n})
                  </option>
                )
              })}
            </select>
          </DropdownLabel>
        )}

        <DropdownLabel label="LEAGUE">
          <select
            value={league}
            onChange={(e) => setLeague(e.target.value)}
            disabled={leagues.length === 0}
            className="appearance-none rounded-md border border-[var(--line)] bg-[var(--panel)] py-1.5 pl-3 pr-8 text-[12px] font-bold tracking-wider text-gray-200 focus:border-gray-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            <option value="all">ALL</option>
            {leagues.map((l) => {
              const n = leagueCounts.get(l) ?? 0
              return (
                <option key={l} value={l}>
                  {l} ({n})
                </option>
              )
            })}
          </select>
        </DropdownLabel>

        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
          <input
            value={search}
            onChange={(e) => setParam('q', e.target.value)}
            placeholder="SEARCH TEAM…"
            className="w-48 rounded-md border border-[var(--line)] bg-[var(--panel)] py-1.5 pl-9 pr-3 text-[12px] tracking-wider text-gray-200 placeholder:text-gray-600 focus:border-gray-600 focus:outline-none"
          />
        </div>
      </div>

      {sport && (
        <div className="flex items-center gap-1 border-b border-[color:var(--line-soft)] px-5 py-2">
          {(['all', 'live', 'upcoming', 'completed'] as const).map((s) => {
            const n = sportStatusCounts[s]
            const active = status === s
            return (
              <button
                key={s}
                onClick={() => setParam('status', s === 'all' ? '' : s)}
                className={[
                  'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                  active
                    ? 'bg-white/[0.08] text-white'
                    : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200',
                  s === 'live' && !active && n > 0 ? 'text-[color:var(--live)]' : '',
                  s === 'upcoming' && !active && n > 0 ? 'text-[color:var(--up)]' : '',
                ].join(' ')}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
                <span className="ml-1.5 tabular-nums text-[color:var(--muted-2)]">{n}</span>
                {s === 'live' && n > 0 && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot align-middle" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {dateMode && (
        <DateBar
          status={status as 'upcoming' | 'completed'}
          date={date}
          onChange={(d) => setParam('date', d)}
        />
      )}

      {loading ? (
        <GridSkeleton />
      ) : errMsg ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-[12px] tracking-widest">
          <span className="text-[var(--live)]">FEED ERROR</span>
          <span className="text-gray-600">{errMsg}</span>
        </div>
      ) : favMissing ? (
        <div className="flex h-64 items-center justify-center text-[12px] tracking-widest text-gray-600">
          FILTER NOT FOUND
        </div>
      ) : (
        <>
          <FixtureGrid
            fixtures={visible}
            now={now}
            onSelect={(f) => navigate(`/fixture/${encodeURIComponent(f.id)}`)}
          />
          {sport && sportHasMore && (
            <div className="flex justify-center py-6">
              <button
                onClick={loadMoreSport}
                disabled={sportLoadingMore}
                className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-2 text-[12px] font-medium text-gray-300 transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sportLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}
