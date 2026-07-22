import { useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Activity, Bell, ChevronDown, ChevronRight, Clock, GitMerge, LayoutGrid, ListChecks, Pencil, Plus, Radio, Star } from 'lucide-react'
import type { Fixture } from '../lib/types'
import { useMappedLeagues } from '../hooks/useMappedLeagues'
import { displaySport, sportGroupKey } from '../lib/sports'
import { LeagueBadge } from './LeagueBadge'
import { favouriteMatches, useFavourites, type Favourite } from '../lib/favourites'
import { FavouriteEditor } from './FavouriteEditor'
import type { DayView } from './Layout'
import { useSportUniverse } from '../hooks/useSportUniverse'

interface Props {
  fixtures: Fixture[]
  day: DayView
  /** OPTIC-live ∧ SWIFT-prematch mismatches; rendered as a badge in Tools. */
  notificationCount: number
  /** Collapsed to an icon-only rail when true. */
  collapsed: boolean
}

export function Sidebar({ fixtures, day, notificationCount, collapsed }: Props) {
  const favourites = useFavourites()
  // Single open sport (accordion) — expanding one collapses any other.
  const [expanded, setExpanded] = useState<string | null>(null)
  const universe = useSportUniverse()
  const [editing, setEditing] = useState<Favourite | 'new' | null>(null)

  const counts = useMemo(() => {
    let live = 0
    let upcoming = 0
    let completed = 0
    for (const f of fixtures) {
      if (f.status === 'live') live++
      else if (f.status === 'upcoming') upcoming++
      else completed++
    }
    // While browsing a specific day, the UPCOMING/COMPLETED count reflects that
    // day's total (matching the board), not the live window.
    if (day.mode && !day.loading) {
      if (day.status === 'upcoming') upcoming = day.fixtures.length
      else completed = day.fixtures.length
    }
    return { all: fixtures.length, live, upcoming, completed }
  }, [fixtures, day])

  // Sports grouped by their PARENT (OpticOdds' league-as-sport buckets — AFL,
  // MLB, NBA … — roll up under Australian Rules / Baseball / Basketball). The
  // group key is the board route (`/sport/<groupKey>`); `badgeRaw` is a member
  // raw slug so the icon resolves (the group name alone often has no emoji).
  const sports = useMemo(() => {
    const m = new Map<string, { label: string; badgeRaw: string; total: number; live: number }>()
    const seed = (raw: string) => {
      const key = sportGroupKey(raw)
      if (!m.has(key)) m.set(key, { label: displaySport(raw), badgeRaw: raw, total: 0, live: 0 })
      return m.get(key)!
    }
    for (const s of universe.sports) seed(universe.rawSport.get(s) ?? s)
    // Live count comes from the fresh ±6h board feed (updates as games flip);
    // the total comes from the whole-table universe so a sport whose next game
    // is beyond ±6h isn't shown as a misleading "0".
    for (const f of fixtures) {
      if (!f.rawSport) continue
      const e = seed(f.rawSport)
      if (f.status === 'live') e.live++
    }
    for (const [key, e] of m) e.total = Math.max(universe.activeBySport.get(key) ?? 0, e.live)
    return [...m.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort(
        (a, b) =>
          b.live - a.live ||
          (b.total > 0 ? 1 : 0) - (a.total > 0 ? 1 : 0) ||
          b.total - a.total ||
          a.label.localeCompare(b.label),
      )
  }, [fixtures, universe])

  const favStats = useMemo(() => {
    const map = new Map<string, { total: number; live: number }>()
    for (const f of favourites) map.set(f.id, { total: 0, live: 0 })
    for (const fx of fixtures) {
      for (const f of favourites) {
        if (favouriteMatches(f, fx.sport, fx.league)) {
          const e = map.get(f.id)!
          e.total++
          if (fx.status === 'live') e.live++
        }
      }
    }
    return map
  }, [favourites, fixtures])

  // Leagues mapped to at least one brand (SwiftBet or mybet) — the nav shows
  // only these under each sport.
  const mappedLeagues = useMappedLeagues()

  // Every KNOWN league per PARENT sport group, from the full universe (not just
  // the live window) so the tree is complete even when a league's games are
  // briefly out of window. Buckets roll up: MLB/NPB/KBO under Baseball,
  // AFL/SANFL/VFL/WAFL under Australian Rules, all Super League/NRL under Rugby
  // League, etc. `sportGroupKey` canonicalises the prettified sport key.
  const allLeaguesByGroup = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [prettifiedSport, leagues] of universe.leaguesBySport) {
      const g = sportGroupKey(prettifiedSport)
      let set = m.get(g)
      if (!set) m.set(g, (set = new Set()))
      for (const l of leagues) set.add(l)
    }
    return m
  }, [universe])

  // Live counts per (group, league) from the current window — overlaid on the
  // known-league list so active leagues show a tally + live dot, inactive dim.
  const leagueCounts = useMemo(() => {
    const m = new Map<string, Map<string, { total: number; live: number }>>()
    for (const f of fixtures) {
      if (!f.rawSport) continue
      const groupKey = sportGroupKey(f.rawSport)
      let byLeague = m.get(groupKey)
      if (!byLeague) m.set(groupKey, (byLeague = new Map()))
      const e = byLeague.get(f.league) ?? { total: 0, live: 0 }
      e.total++
      if (f.status === 'live') e.live++
      byLeague.set(f.league, e)
    }
    return m
  }, [fixtures])

  /** Leagues under a sport group that are mapped to at least one brand,
   *  active-first. Unmapped leagues are hidden. */
  const leaguesForGroup = (groupKey: string) => {
    const counts = leagueCounts.get(groupKey)
    const names = new Set<string>([...(allLeaguesByGroup.get(groupKey) ?? []), ...(counts?.keys() ?? [])])
    return [...names]
      .filter((league) => mappedLeagues.has(league))
      .map((league) => {
        // Live from the fresh feed; total from the whole-table universe so a
        // league with games beyond the ±6h window still shows its real count.
        const live = counts?.get(league)?.live ?? 0
        const total = Math.max(universe.activeByLeague.get(`${groupKey}|${league}`) ?? 0, live)
        return { league, total, live }
      })
      .sort((a, b) => b.live - a.live || b.total - a.total || a.league.localeCompare(b.league))
  }

  // Clicking the sport name OR the chevron toggles its league list (navigating
  // to the board too); clicking an open sport again closes it. Accordion: only
  // one sport open at a time.
  const toggleExpand = (k: string) => setExpanded((prev) => (prev === k ? null : k))

  // Collapsed icon rail — just the navigable icons, tooltips on hover.
  if (collapsed) {
    return <CollapsedRail sports={sports} notificationCount={notificationCount} />
  }

  return (
    <>
      <nav className="hidden w-56 shrink-0 flex-col border-r border-[color:var(--line-soft)] bg-[color:var(--bg)] md:flex">
        {/* brand — moved here from the top header */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-[color:var(--line-soft)] px-4">
          <Activity className="h-4 w-4 shrink-0 text-[color:var(--total)]" strokeWidth={2.5} />
          <span className="text-[14px] font-semibold tracking-tight text-white">Live Events Terminal</span>
        </div>

        {/* Events, Favourites, Sports. flex-1 pushes Tools to the bottom; a
            contained scroll here (min-h-0) keeps Tools pinned and reachable when
            many sports are expanded — the nav as a whole never moves with the
            page body. */}
        <div className="min-h-0 flex-1 overflow-y-auto py-3 [scrollbar-width:thin]">
          <Group title="Events">
            <Item to="/" end label="All" count={counts.all} icon={<LayoutGrid className="h-3.5 w-3.5" />} />
            <Item to="/live" label="Live" count={counts.live} accent="live" icon={<Radio className="h-3.5 w-3.5" />} />
            <Item to="/upcoming" label="Upcoming" count={counts.upcoming} accent="up" icon={<Clock className="h-3.5 w-3.5" />} />
            <Item to="/completed" label="Completed" count={counts.completed} icon={<ListChecks className="h-3.5 w-3.5" />} />
          </Group>

          <Group
            title="Favourites"
            action={
              <button
                onClick={() => setEditing('new')}
                className="text-gray-500 transition-colors hover:text-gray-200"
                title="New filter"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {favourites.length === 0 ? (
              <button
                onClick={() => setEditing('new')}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-[11px] tracking-widest text-gray-600 hover:bg-white/5 hover:text-gray-400"
              >
                <Star className="h-3.5 w-3.5" />
                New filter…
              </button>
            ) : (
              favourites.map((f) => (
                <FavItem
                  key={f.id}
                  fav={f}
                  stats={favStats.get(f.id) ?? { total: 0, live: 0 }}
                  onEdit={() => setEditing(f)}
                />
              ))
            )}
          </Group>

          <Group title="Sports">
            {sports.map((s) => (
              <SportRow
                key={s.key}
                sportKey={s.key}
                label={s.label}
                badgeRaw={s.badgeRaw}
                total={s.total}
                live={s.live}
                leagues={leaguesForGroup(s.key)}
                expanded={expanded === s.key}
                onToggle={() => toggleExpand(s.key)}
              />
            ))}
          </Group>
        </div>

        {/* Tools — pinned to the bottom, always visible. */}
        <div className="shrink-0 border-t border-[color:var(--line-soft)] py-3">
          <Group title="Tools">
            <Item to="/mapping" label="Mapping" icon={<GitMerge className="h-3.5 w-3.5" />} />
            <Item
              to="/notifications"
              label="Notifications"
              icon={<Bell className="h-3.5 w-3.5" />}
              count={notificationCount || undefined}
              accent={notificationCount ? 'live' : undefined}
            />
          </Group>
        </div>
      </nav>

      {editing && (
        <FavouriteEditor
          fixtures={fixtures}
          favourite={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

function Group({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between px-4 pb-1.5">
        <span className="text-[11px] font-medium text-[color:var(--muted-2)]">{title}</span>
        {action}
      </div>
      <div className="space-y-0.5 px-2">{children}</div>
    </div>
  )
}

function Item({
  to,
  end,
  label,
  emoji,
  icon,
  count,
  live,
  accent,
  dim,
}: {
  to: string
  end?: boolean
  label: string
  emoji?: string
  icon?: React.ReactNode
  count?: number
  live?: number
  accent?: 'live' | 'up'
  /** Render in a muted style — used for sports with zero in-window fixtures. */
  dim?: boolean
}) {
  const accentText = dim
    ? 'text-gray-500'
    : accent === 'live'
      ? 'text-[color:var(--live)]'
      : accent === 'up'
        ? 'text-[color:var(--up)]'
        : 'text-gray-300'
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors',
          isActive
            ? 'bg-white/[0.08] text-white shadow-[inset_2px_0_0_var(--total)]'
            : `${accentText} hover:bg-white/[0.04]`,
        ].join(' ')
      }
    >
      {icon ? (
        <span className={`flex w-4 shrink-0 justify-center ${dim ? 'opacity-50' : ''}`}>{icon}</span>
      ) : (
        emoji && <span className={`text-sm leading-none ${dim ? 'opacity-60' : ''}`}>{emoji}</span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {live ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--live)] pulse-dot" /> : null}
      {count != null && (
        <span className={`tabular-nums ${dim ? 'text-gray-600' : 'text-[color:var(--muted-2)]'}`}>{count}</span>
      )}
    </NavLink>
  )
}

/** A sport row that can expand to show its mapped + active leagues. */
function SportRow({
  sportKey,
  label,
  badgeRaw,
  total,
  live,
  leagues,
  expanded,
  onToggle,
}: {
  sportKey: string
  label: string
  badgeRaw: string
  total: number
  live: number
  leagues: Array<{ league: string; total: number; live: number }>
  expanded: boolean
  onToggle: () => void
}) {
  const dim = total === 0
  const canExpand = leagues.length > 0
  return (
    <div>
      <div className="group flex items-center">
        <NavLink
          to={`/sport/${encodeURIComponent(sportKey)}`}
          onClick={() => canExpand && onToggle()}
          className={({ isActive }) =>
            [
              'flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2.5 pr-1 text-[12.5px] font-medium transition-colors',
              isActive
                ? 'bg-white/[0.08] text-white shadow-[inset_2px_0_0_var(--total)]'
                : `${dim ? 'text-gray-500' : 'text-gray-300'} hover:bg-white/[0.04]`,
            ].join(' ')
          }
        >
          <span className={`flex w-4 shrink-0 justify-center ${dim ? 'opacity-50' : ''}`}>
            <LeagueBadge sport={badgeRaw} league="" size={16} />
          </span>
          <span className="flex-1 truncate">{label}</span>
          {live ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--live)] pulse-dot" /> : null}
          <span className={`tabular-nums ${dim ? 'text-gray-600' : 'text-[color:var(--muted-2)]'}`}>{total}</span>
        </NavLink>
        <button
          onClick={onToggle}
          disabled={!canExpand}
          className={`shrink-0 rounded p-1 ${canExpand ? 'text-gray-500 hover:bg-white/10 hover:text-gray-200' : 'invisible'}`}
          title={expanded ? 'Collapse leagues' : 'Show mapped leagues'}
          aria-label="Toggle leagues"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      </div>
      {expanded && canExpand && (
        <div className="mb-1 ml-[26px] mt-0.5 space-y-0.5 border-l border-[color:var(--line-soft)] pl-2">
          {leagues.map((l) => {
            const dimLeague = l.total === 0
            return (
              <NavLink
                key={l.league}
                to={`/sport/${encodeURIComponent(sportKey)}?league=${encodeURIComponent(l.league)}`}
                className={`flex items-center gap-2 rounded px-2 py-1 text-[11.5px] hover:bg-white/[0.04] hover:text-gray-200 ${dimLeague ? 'text-gray-600' : 'text-gray-400'}`}
              >
                <span className="flex-1 truncate">{l.league}</span>
                {l.live ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--live)] pulse-dot" /> : null}
                {l.total > 0 && <span className="tabular-nums text-[color:var(--muted-2)]">{l.total}</span>}
              </NavLink>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Icon-only rail shown when the sidebar is collapsed. */
function CollapsedRail({
  sports,
  notificationCount,
}: {
  sports: Array<{ key: string; label: string; badgeRaw: string; total: number; live: number }>
  notificationCount: number
}) {
  const railLink = ({ isActive }: { isActive: boolean }) =>
    [
      'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
      isActive ? 'bg-white/[0.10] text-white' : 'text-gray-400 hover:bg-white/[0.05] hover:text-gray-200',
    ].join(' ')
  return (
    <nav className="hidden w-14 shrink-0 flex-col items-center border-r border-[color:var(--line-soft)] bg-[color:var(--bg)] md:flex">
      <div className="flex h-14 shrink-0 items-center justify-center border-b border-[color:var(--line-soft)]">
        <Activity className="h-4 w-4 text-[color:var(--total)]" strokeWidth={2.5} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-3">
        <NavLink to="/" end className={railLink} title="All"><LayoutGrid className="h-4 w-4" /></NavLink>
        <NavLink to="/live" className={railLink} title="Live"><Radio className="h-4 w-4" /></NavLink>
        <NavLink to="/upcoming" className={railLink} title="Upcoming"><Clock className="h-4 w-4" /></NavLink>
        <NavLink to="/completed" className={railLink} title="Completed"><ListChecks className="h-4 w-4" /></NavLink>
        <div className="my-1 h-px w-6 bg-[color:var(--line-soft)]" />
        {sports.map((s) => (
          <NavLink
            key={s.key}
            to={`/sport/${encodeURIComponent(s.key)}`}
            className={railLink}
            title={`${s.label}${s.total ? ` · ${s.total}` : ''}`}
          >
            <span className={s.total === 0 ? 'opacity-40' : ''}>
              <LeagueBadge sport={s.badgeRaw} league="" size={18} />
            </span>
          </NavLink>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-[color:var(--line-soft)] py-3">
        <NavLink to="/mapping" className={railLink} title="Mapping"><GitMerge className="h-4 w-4" /></NavLink>
        <NavLink to="/notifications" className={railLink} title="Notifications">
          <span className="relative">
            <Bell className="h-4 w-4" />
            {notificationCount > 0 && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[color:var(--live)]" />
            )}
          </span>
        </NavLink>
      </div>
    </nav>
  )
}

function FavItem({
  fav,
  stats,
  onEdit,
}: {
  fav: Favourite
  stats: { total: number; live: number }
  onEdit: () => void
}) {
  return (
    <div className="group relative">
      <NavLink
        to={`/favourite/${fav.id}`}
        className={({ isActive }) =>
          [
            'flex items-center gap-2 rounded-md py-1.5 pl-2.5 pr-7 text-[12.5px] font-medium transition-colors',
            isActive ? 'bg-white/[0.08] text-white' : 'text-gray-300 hover:bg-white/[0.04]',
          ].join(' ')
        }
      >
        <Star className="h-3 w-3 shrink-0 text-[color:var(--up)]" />
        <span className="flex-1 truncate">{fav.name}</span>
        {stats.live ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--live)] pulse-dot" />
        ) : null}
        <span className="tabular-nums text-[color:var(--muted-2)] group-hover:opacity-0">
          {stats.total}
        </span>
      </NavLink>
      <button
        onClick={onEdit}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[color:var(--muted-2)] opacity-0 transition-opacity hover:text-gray-200 group-hover:opacity-100"
        title="Rename / edit"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  )
}
