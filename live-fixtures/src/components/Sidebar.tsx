import { useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Bell, GitMerge, Pencil, Plus, Star } from 'lucide-react'
import type { Fixture } from '../lib/types'
import { sportEmoji, sportLabel } from '../lib/sports'
import { favouriteMatches, useFavourites, type Favourite } from '../lib/favourites'
import { FavouriteEditor } from './FavouriteEditor'
import type { DayView } from './Layout'
import { useSportUniverse } from '../hooks/useSportUniverse'

interface Props {
  fixtures: Fixture[]
  day: DayView
  /** OPTIC-live ∧ SWIFT-prematch mismatches; rendered as a badge in Tools. */
  notificationCount: number
}

export function Sidebar({ fixtures, day, notificationCount }: Props) {
  const favourites = useFavourites()
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

  const sports = useMemo(() => {
    // Seed with every sport known from the universe so NBA/EPL/etc. are
    // always listed even when nothing is in the current ±6h window; counts
    // reflect the in-window fixtures only.
    const m = new Map<string, { total: number; live: number }>()
    for (const s of universe.sports) m.set(s, { total: 0, live: 0 })
    for (const f of fixtures) {
      // Fixtures with no raw sport prettify to "Unknown" — they'd render as
      // a broken sidebar entry whose by-sport DB fetch returns nothing. The
      // backfill cleared the table but this guards against any new stray.
      if (!f.rawSport) continue
      const e = m.get(f.sport) ?? { total: 0, live: 0 }
      e.total++
      if (f.status === 'live') e.live++
      m.set(f.sport, e)
    }
    // Active sports first (any live → top, then any upcoming, then idle).
    return [...m.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort(
        (a, b) =>
          b.live - a.live ||
          (b.total > 0 ? 1 : 0) - (a.total > 0 ? 1 : 0) ||
          b.total - a.total ||
          a.key.localeCompare(b.key),
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

  return (
    <>
      <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-[color:var(--line-soft)] bg-[color:var(--bg)] py-5 md:block">
        <Group title="Events">
          <Item to="/" end label="All" count={counts.all} />
          <Item to="/live" label="Live" count={counts.live} accent="live" />
          <Item to="/upcoming" label="Upcoming" count={counts.upcoming} accent="up" />
          <Item to="/completed" label="Completed" count={counts.completed} />
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
            <Item
              key={s.key}
              to={`/sport/${encodeURIComponent(s.key)}`}
              emoji={sportEmoji(s.key)}
              label={sportLabel(s.key)}
              count={s.total}
              live={s.live}
              dim={s.total === 0}
            />
          ))}
        </Group>

        {/* Tools — pinned to the bottom by the auto-margin spacer above. */}
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
          isActive ? 'bg-white/[0.08] text-white' : `${accentText} hover:bg-white/[0.04]`,
        ].join(' ')
      }
    >
      {icon ?? (emoji && <span className={`text-sm leading-none ${dim ? 'opacity-60' : ''}`}>{emoji}</span>)}
      <span className="flex-1 truncate">{label}</span>
      {live ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--live)] pulse-dot" /> : null}
      {count != null && (
        <span className={`tabular-nums ${dim ? 'text-gray-600' : 'text-[color:var(--muted-2)]'}`}>{count}</span>
      )}
    </NavLink>
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
