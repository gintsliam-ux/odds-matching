import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { fixturePath, golfPath } from '../lib/routes'
import { FixtureGrid } from '../components/FixtureGrid'
import { FilterBar } from '../components/FilterBar'
import { GridSkeleton } from '../components/Skeleton'
import { useTerminal } from '../components/Layout'
import { favouriteMatches, useFavourites } from '../lib/favourites'
import { displaySport, prettyLeague, prettySport, sportGroupKey, slugToSport } from '../lib/sports'
import { melbDateTimeShort } from '../lib/format'
import { melbDateOf, melbToday } from '../lib/dates'
import type { GolfTournament } from '../lib/golfOutrights'
import { useSportUniverse } from '../hooks/useSportUniverse'
import { useGolfTournaments } from '../hooks/useGolfTournaments'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useMainScrollMemory } from '../hooks/useMainScrollMemory'
import { fetchFixturesBySport } from '../lib/dataSource'
import type { Fixture, FixtureStatus } from '../lib/types'

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
  const { sport: sportSlug, league: leagueSlug, favId } = useParams()
  // `/sport/:sport` pins a sport group (URL slug → group key, "rugby-league" →
  // "rugby league"); `/sport/:sport/:league` also pins a raw league slug.
  const sport = sportSlug ? slugToSport(sportSlug) : undefined

  // Keep the board's scroll position across a trip into a fixture page. The
  // scroller is Layout's <main>, so the browser never restores it on its own.
  useMainScrollMemory(`terminal|${location.pathname}|${location.search}`, true)
  const [params, setParams] = useSearchParams()
  const favourites = useFavourites()
  const universe = useSportUniverse()
  // /sport/golf can't use the fixture board — golf has no fixtures. The board
  // is replaced by a tournament list, keeping the URL shape every other sport
  // uses so the sidebar, rail and dropdown all work unchanged.
  const isGolf = sportGroupKey(sport ?? '') === 'golf'
  const { active: golfActive, tournaments: golfAll, loading: golfLoading } = useGolfTournaments()

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
  // Sport is pinned by the URL on `/sport/:sport`; elsewhere it's a local
  // filter. Multi-select: [] means "all", so the pills read as unset.
  const [sportSel, setSportSel] = useState<string[]>([])
  const [leagueSel, setLeagueSel] = useState<string[]>([])
  // `effectiveSport` still drives the league options and counts, which are
  // single-sport concepts. With several sports picked there is no one sport to
  // scope them to, so they widen to everything and `sportSel` does the filtering.
  const effectiveSport = sport ?? (sportSel.length === 1 ? sportSel[0] : null)

  // /upcoming and /completed browse a specific day (fetched in Layout).
  const dateMode = day.mode

  // Board date filter, on the Melbourne day.
  //
  // Defaults to TODAY rather than "no filter", so every Events board opens on
  // today's card. An absent param means "never touched", so clearing the pill
  // writes an `all` sentinel rather than removing the param — otherwise the
  // default would put today straight back and the pill could never be cleared.
  //
  // /upcoming and /completed already FETCH a single day (Layout reads `?date=`),
  // so there the pill drives that fetch rather than filtering on top of it.
  // This is the ONLY date control on those boards now — they used to carry a
  // day-chip strip with its own picker as well, which meant two controls that
  // could disagree and blank the board between them.
  const onParam = params.get('on')
  const dateFilter = dateMode
    ? day.date
    : onParam === null
      ? melbToday()
      : onParam === 'all'
        ? ''
        : onParam

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    value ? next.set(key, value) : next.delete(key)
    setParams(next, { replace: true })
  }

  // When the user pins a sport via /sport/:sport, the in-window ±6h feed often
  // has nothing (NBA between games, EPL midweek, etc). Fall back to a direct
  // by-sport DB fetch (paginated; first page = 200 rows; user can "Load more").
  // Completed browses into the past; every other view walks forward from now,
  // so anything in play leads the page instead of sitting behind the whole
  // future slate.
  const sportDirection: 'forward' | 'back' = status === 'completed' ? 'back' : 'forward'
  const [sportFallback, setSportFallback] = useState<Fixture[] | null>(null)
  const [sportFallbackLoading, setSportFallbackLoading] = useState(false)
  const [sportPage, setSportPage] = useState(0)
  const [sportHasMore, setSportHasMore] = useState(false)
  const [sportLoadingMore, setSportLoadingMore] = useState(false)
  /**
   * What to query for the sport currently being viewed.
   *
   * `own` is only the slugs the feed already files under this sport; `leagues`
   * carries every competition in the group, which is how the ones filed under
   * another sport get picked up (cricket's One Day Cup arrives as soccer).
   * Passing the foreign slugs as sports instead would drag that whole sport
   * into the result set — see fetchFixturesBySport.
   */
  const sportQuery = useMemo(() => {
    if (!sport) return null
    const raws = universe.rawSportsAll.get(sport) ?? [universe.rawSport.get(sport) ?? sport]
    const own = raws.filter((rs) => prettySport(rs) === sport)
    const leagues: string[] = []
    for (const [k, v] of universe.rawLeagueByGroup) {
      if (k.slice(0, k.indexOf('|')) === sport && v) leagues.push(v)
    }
    return { raws: own.length ? own : raws, leagues }
  }, [sport, universe])

  // Reset paging when the sport switches — or when the direction flips, since
  // switching to Completed asks for a different slice of the slate entirely.
  useEffect(() => {
    setSportFallback(null)
    setSportPage(0)
    setSportHasMore(false)
    if (!sport || dateMode) return
    // Multiple raw slugs can resolve to one prettified sport (Rugby Union pulls
    // from rugby_union AND reclassified `rugby` rows).
    let alive = true
    setSportFallbackLoading(true)
    fetchFixturesBySport(
      sportQuery?.raws ?? [sport],
      0,
      sportQuery?.leagues ?? [],
      sportDirection,
    )
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
  }, [sport, dateMode, sportQuery, sportDirection])

  const loadMoreSport = async () => {
    if (!sport || sportLoadingMore || !sportHasMore) return
    setSportLoadingMore(true)
    try {
      const next = sportPage + 1
      const { rows, hasMore } = await fetchFixturesBySport(
        sportQuery?.raws ?? [sport],
        next,
        sportQuery?.leagues ?? [],
        sportDirection,
      )
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

  // Route-sport / favourite scope, WITHOUT the status filter — the status pill
  // counts each bucket against this, so its numbers don't collapse to the
  // bucket you are already looking at.
  const baseScoped = useMemo(
    () =>
      source.filter(
        (f) =>
          (!sport || sportMatches(f.sport, sport)) &&
          (!fav || favouriteMatches(fav, f.sport, f.league)),
      ),
    [source, sport, fav],
  )

  const routeScoped = useMemo(
    () => (status === 'all' ? baseScoped : baseScoped.filter((f) => f.status === status)),
    [baseScoped, status],
  )

  /** Per-bucket counts for the status pill, in the current sport/fav scope. */
  const statusCounts = useMemo(() => {
    let live = 0, upcoming = 0, completed = 0
    for (const f of baseScoped) {
      if (f.status === 'live') live++
      else if (f.status === 'upcoming') upcoming++
      else completed++
    }
    return { live, upcoming, completed }
  }, [baseScoped])

  // Status-tab counts for /sport/:sport[/:league]: the same scope the grid uses
  // but ignoring the status filter, so the tabs show totals across every bucket.
  //
  // These MUST honour the league too. Counting by sport alone made a league page
  // advertise its whole sport: /sport/australian-rules/australia_-_vfl showed
  // "Upcoming 9" — every upcoming AFL game — above a grid of nothing, because
  // the VFL's own five fixtures had all finished. Matching is on the raw slug or
  // the pretty name, exactly as `visible` does, since the league arrives from a
  // URL as one and from the dropdown as the other.
  const sportStatusCounts = useMemo(() => {
    if (!sport) return { all: 0, live: 0, upcoming: 0, completed: 0 }
    let live = 0, upcoming = 0, completed = 0
    for (const f of source) {
      if (!sportMatches(f.sport, sport)) continue
      if (leagueSel.length && !leagueSel.some((l) => f.league === l || f.rawLeague === l)) continue
      if (f.status === 'live') live++
      else if (f.status === 'upcoming') upcoming++
      else completed++
    }
    return { all: live + upcoming + completed, live, upcoming, completed }
  }, [source, sport, leagueSel])

  // Counts per sport in the current scope (for the SPORT dropdown badges).
  //
  // Keyed by GROUP, not by the feed's `sport`. OPTIC files some competitions
  // under a sport named after the league — `afl`, `mlb`, `nfl`, `nrl`, `ucl`,
  // `laliga`, `epl` — so counting the raw value split one sport across two
  // entries and the picker offered "afl" beside "aussierules". A sport is
  // chosen here; the league dropdown beside it chooses the tournament.
  const sportCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of routeScoped) {
      const key = sportGroupKey(f.sport)
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  }, [routeScoped])

  // Hybrid sport list: union of universe + anything in scope (covers a future
  // sport before its first universe-cache load). In-scope sports come first.
  //
  // Options are GROUP keys with a proper display label, so the feed's
  // league-as-sport buckets collapse into the sport they belong to. The value
  // stays a group key because `sportMatches` already accepts one, and any old
  // link carrying a raw sport still resolves through its other branch.
  const sportsForFilter = useMemo(() => {
    const label = new Map<string, string>()
    const add = (raw: string) => {
      const key = sportGroupKey(raw)
      if (!label.has(key)) label.set(key, displaySport(raw))
    }
    for (const s of universe.sports) add(universe.rawSport.get(s) ?? s)
    for (const key of sportCounts.keys()) if (!label.has(key)) label.set(key, displaySport(key))
    // Golf has no fixtures to filter, so the universe never offers it. Include
    // it anyway when tournaments exist — picking it jumps to the golf board
    // rather than filtering this one to nothing. See the select's onChange.
    if (golfActive.length > 0 && !label.has('golf')) label.set('golf', 'Golf')
    return (
      [...label.entries()]
        // Nothing on the board means nothing to filter to, so the option is
        // dead weight — the list was mostly zeroes. The current selection is
        // kept regardless, or choosing a sport that then empties would blank
        // the control instead of showing what is selected.
        .filter(([key]) => (sportCounts.get(key) ?? 0) > 0 || sportSel.includes(key) || key === 'golf')
        .map(([key, name]) => ({ key, name }))
        .sort((a, b) => {
          const ca = sportCounts.get(a.key) ?? 0
          const cb = sportCounts.get(b.key) ?? 0
          if ((ca > 0) !== (cb > 0)) return ca > 0 ? -1 : 1 // active sports first
          return a.name.localeCompare(b.name)
        })
    )
  }, [universe, sportCounts, golfActive, sportSel])

  // The `/sport/:sport/:league` path segment (raw league slug, e.g. from the
  // sidebar's expandable sports) pre-selects the league filter. The dropdown
  // takes over after — it holds a prettified name, so the filter below matches
  // EITHER the raw slug or the pretty league.
  //
  // PRETTIFIED HERE, though, because the <select> options are prettified: a raw
  // "australia_-_vfl" matches no option, so the control fell back to displaying
  // "ALL" while the page was in fact filtered to the VFL — the board said one
  // thing and the dropdown another.
  const leagueParam = leagueSlug ? prettyLeague(leagueSlug) : null
  useEffect(() => {
    if (leagueParam) setLeagueSel([leagueParam])
  }, [leagueParam])

  // Reset the league when the selected sport changes (a stale value would yield
  // zero matches) — unless a league param came in with the same navigation.
  const sportKey = sport ?? sportSel.join(',') ?? '__all__'
  const lastSportKey = useRef(sportKey)
  useEffect(() => {
    if (lastSportKey.current !== sportKey) {
      lastSportKey.current = sportKey
      setLeagueSel(leagueParam ? [leagueParam] : [])
    }
  }, [sportKey, leagueParam])

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
    return [...all]
      // Same as the sport list: an empty league filters to nothing, so it is
      // only noise. The selected one stays so the control never reads blank.
      .filter((l) => (leagueCounts.get(l) ?? 0) > 0 || leagueSel.includes(l))
      .sort((a, b) => {
        const ca = leagueCounts.get(a) ?? 0
        const cb = leagueCounts.get(b) ?? 0
        if ((ca > 0) !== (cb > 0)) return ca > 0 ? -1 : 1
        return a.localeCompare(b)
      })
  }, [universe, leagueCounts, effectiveSport, leagueSel])

  const scoped = useMemo(() => {
    if (sport) return routeScoped.filter((f) => sportMatches(f.sport, sport))
    if (sportSel.length === 0) return routeScoped
    return routeScoped.filter((f) => sportSel.some((t) => sportMatches(f.sport, t)))
  }, [routeScoped, sport, sportSel])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = scoped.filter((f) => {
      // A selection holds pretty names (the pill) or a raw slug (the URL) —
      // match either, so /sport/x/y and the pill agree on what is selected.
      if (leagueSel.length && !leagueSel.some((l) => f.league === l || f.rawLeague === l)) return false
      // In day mode the fetch already scoped the day; filtering again on the
      // scheduled start would drop anything that rolled over midnight.
      if (!dateMode && dateFilter && melbDateOf(new Date(f.startTime)) !== dateFilter) return false
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
  }, [scoped, leagueSel, dateFilter, dateMode, search])

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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-[color:var(--line-soft)] px-5 py-3">
        <h1 className="shrink-0 text-[18px] font-semibold tracking-tight text-gray-100">{title}</h1>

        <div className="min-w-0 flex-1">
          <FilterBar
            date={dateFilter}
            // Clearing writes the sentinel, not an empty param — see `dateFilter`.
            onDate={(v) => (dateMode ? setParam('date', v || melbToday()) : setParam('on', v || 'all'))}
            // Upcoming can't look back, Completed can't look forward — the
            // bounds the old day-chip strip enforced.
            dateMin={dateMode && pathStatus === 'upcoming' ? melbToday() : undefined}
            dateMax={dateMode && pathStatus === 'completed' ? melbToday() : undefined}
            // On /live, /upcoming and /completed the route IS the status, so the
            // pill shows it locked rather than offering a choice that would
            // contradict the page you clicked to get here.
            // On a sport route the status is a query param alongside the tab
            // strip; on the top-level boards it IS the route, because /upcoming
            // and /completed don't filter the loaded board — they fetch a
            // specific day. So the pill navigates there rather than filtering,
            // which is exactly what the nav items it replaced used to do.
            statusSel={
              sport ? (sportStatusParam ? [sportStatusParam] : []) : pathStatus === 'all' ? [] : [pathStatus]
            }
            statusOptions={[
              { value: 'live', label: 'Live', hint: statusCounts.live },
              { value: 'upcoming', label: 'Upcoming', hint: statusCounts.upcoming },
              { value: 'completed', label: 'Completed', hint: statusCounts.completed },
            ]}
            onStatus={(v) => {
              // Sport routes: same `?status=` the tab strip writes, so the two
              // controls stay in step and the sport stays pinned.
              if (sport) {
                setParam('status', v[0] ?? '')
                return
              }
              // Top-level: carry the other filters across, or picking a status
              // would silently drop the date, search and league you had set.
              const next = new URLSearchParams(params)
              next.delete('status')
              const qs = next.toString()
              navigate(`/${v[0] ?? ''}${qs ? `?${qs}` : ''}`)
            }}
            // The sport pill is hidden when /sport/:sport already pins one —
            // there is nothing to choose, and a pill saying "Sport" over a
            // board locked to Tennis would be a lie.
            sportSel={sport ? undefined : sportSel}
            sportOptions={
              sport
                ? undefined
                : sportsForFilter.map(({ key, name }) => ({
                    value: key,
                    label: name,
                    hint: key === 'golf' ? golfActive.length : (sportCounts.get(key) ?? 0),
                  }))
            }
            onSport={
              sport
                ? undefined
                : (v) => {
                    // Golf isn't a filter over this board — it has no fixtures
                    // on it — so choosing it navigates to the golf board.
                    if (v.some((k) => sportGroupKey(k) === 'golf')) navigate('/sport/golf')
                    else setSportSel(v)
                  }
            }
            leagueSel={leagueSel}
            leagueOptions={leagues.map((l) => ({ value: l, label: l, hint: leagueCounts.get(l) ?? 0 }))}
            onLeague={setLeagueSel}
            query={search}
            onQuery={(v) => setParam('q', v)}
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

      {isGolf ? (
        <GolfBoard tournaments={golfActive.length ? golfActive : golfAll} loading={golfLoading} />
      ) : loading ? (
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
            onSelect={(f) => navigate(fixturePath(f.id, { home: f.homeName, away: f.awayName }))}
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

/**
 * The golf board: one card per tournament, standing in for the fixture grid.
 *
 * A golf "event" is a week-long tournament with a field, not a game between two
 * teams, so there is no score, clock or h2h price to show on a card. What is
 * useful up front is when it runs, how big the field is, and who is pricing it.
 */
function GolfBoard({ tournaments, loading }: { tournaments: GolfTournament[]; loading: boolean }) {
  const navigate = useNavigate()
  if (loading) return <GridSkeleton />
  if (tournaments.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[12px] tracking-widest text-gray-600">
        NO GOLF TOURNAMENTS
      </div>
    )
  }
  return (
    <div className="grid gap-3 px-5 py-5 sm:grid-cols-2 xl:grid-cols-3">
      {tournaments.map((t) => (
        <button
          key={t.tournamentId}
          onClick={() => navigate(golfPath(t.tournamentId, { tournament: t.tournament }))}
          className="rounded-lg bg-[color:var(--panel)] p-4 text-left transition-colors hover:bg-white/[0.04]"
        >
          <div className="flex items-center gap-2 text-[11px] text-[color:var(--muted-2)]">
            <span>⛳</span>
            <span className="uppercase tracking-wide">{prettyLeague(t.league)}</span>
            <span className="ml-auto">{t.market}</span>
          </div>
          <div className="mt-2 text-[15px] font-semibold text-gray-100">{t.tournament}</div>
          <div className="mt-1 text-[12px] text-[color:var(--muted)]">
            {t.venueName ?? '—'}
          </div>
          {/* Tournaments with no prices are still listed — the catalogue knows
              about them before any book we read is quoting. */}
          <div className="mt-1 text-[11px] text-[color:var(--muted-2)]">
            {t.golfers
              ? `${t.golfers} priced · ${t.books.join(' + ')}`
              : `${(t.priceStatus ?? 'no prices').replace(/_/g, ' ')} · ${t.bookCount} books listing`}
          </div>
          <div className="mt-2 text-[11px] tabular-nums text-[color:var(--muted-2)]">
            {melbDateTimeShort(t.startDate)} MEL
          </div>
        </button>
      ))}
    </div>
  )
}
