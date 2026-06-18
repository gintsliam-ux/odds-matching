import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronDown, Trash2, X } from 'lucide-react'
import type { Fixture } from '../lib/types'
import { sportEmoji } from '../lib/sports'
import { useSportUniverse } from '../hooks/useSportUniverse'
import { addFavourite, removeFavourite, updateFavourite, type Favourite } from '../lib/favourites'

interface Props {
  fixtures: Fixture[]
  /** undefined = create a new favourite; otherwise edit this one. */
  favourite?: Favourite
  onClose: () => void
}

export function FavouriteEditor({ fixtures, favourite, onClose }: Props) {
  const navigate = useNavigate()
  const editing = !!favourite
  const universe = useSportUniverse()

  const [name, setName] = useState(favourite?.name ?? '')
  const [sports, setSports] = useState<Set<string>>(new Set(favourite?.sports ?? []))
  const [leagues, setLeagues] = useState<Set<string>>(new Set(favourite?.leagues ?? []))
  const [query, setQuery] = useState('')
  // Sport filter for the LEAGUE list — "all" or one of the sports. Defaults to
  // "all" but narrows automatically when the user toggles a single sport chip,
  // so picking "Ice Hockey" reveals every hockey league (even 0-count today).
  const [filterSport, setFilterSport] = useState<string>('all')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Full universe (every sport + league in `live_fixtures`), merged with any
  // current-scope entries (covers brand-new sports before the universe loads).
  const allSports = useMemo(() => {
    const set = new Set<string>(universe.sports)
    for (const f of fixtures) if (f.sport) set.add(f.sport)
    return [...set].sort()
  }, [universe, fixtures])

  const allLeagues = useMemo(() => {
    const m = new Map<string, string>() // league -> sport (for the tag)
    for (const [s, ls] of universe.leaguesBySport) for (const l of ls) if (!m.has(l)) m.set(l, s)
    for (const f of fixtures) if (f.league && !m.has(f.league)) m.set(f.league, f.sport)
    return [...m.entries()]
      .map(([league, sport]) => ({ league, sport }))
      .sort((a, b) => a.league.localeCompare(b.league))
  }, [universe, fixtures])

  const shownLeagues = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allLeagues.filter((l) => {
      if (filterSport !== 'all' && l.sport !== filterSport) return false
      if (q && !l.league.toLowerCase().includes(q) && !l.sport.toLowerCase().includes(q)) return false
      return true
    })
  }, [allLeagues, filterSport, query])

  const count = sports.size + leagues.size
  const canSave = name.trim().length > 0 && count > 0

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) {
    // functional update so rapid clicks accumulate (no stale-closure clobbering)
    setter((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Convenience: when the user toggles a single sport chip on, narrow the
  // league list to that sport so they can immediately see "all hockey leagues".
  function pickSport(s: string) {
    toggle(setSports, s)
    setFilterSport((cur) => (cur === s ? 'all' : s))
  }

  function save() {
    if (!canSave) return
    const payload = { name: name.trim(), sports: [...sports], leagues: [...leagues] }
    if (editing && favourite) {
      updateFavourite(favourite.id, payload)
      navigate(`/favourite/${favourite.id}`)
    } else {
      const created = addFavourite(payload)
      navigate(`/favourite/${created.id}`)
    }
    onClose()
  }

  function del() {
    if (editing && favourite) {
      removeFavourite(favourite.id)
      navigate('/')
    }
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-md border border-[var(--line)] bg-[var(--panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <span className="text-[12px] font-bold tracking-widest text-gray-100">
            {editing ? 'EDIT FILTER' : 'NEW FILTER'}
          </span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* name */}
        <div className="px-5 pt-4">
          <label className="mb-1.5 block text-[10px] tracking-widest text-gray-600">NAME</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. US Sports"
            autoFocus
            className="w-full rounded-md border border-[var(--line)] bg-black/30 px-3 py-2 text-[13px] tracking-wider text-gray-100 placeholder:text-gray-600 focus:border-gray-600 focus:outline-none"
          />
        </div>

        {/* sports */}
        <div className="px-5 pt-4">
          <div className="mb-2 text-[10px] tracking-widest text-gray-600">SPORTS</div>
          <div className="flex flex-wrap gap-1.5">
            {allSports.map((s) => {
              const on = sports.has(s)
              return (
                <button
                  key={s}
                  onClick={() => pickSport(s)}
                  className={[
                    'flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] font-bold tracking-wider transition-colors',
                    on
                      ? 'border-[var(--total)] bg-[var(--total)]/15 text-[var(--total)]'
                      : 'border-[var(--line)] text-gray-400 hover:border-gray-600',
                  ].join(' ')}
                >
                  <span>{sportEmoji(s)}</span>
                  {s.toUpperCase()}
                </button>
              )
            })}
          </div>
        </div>

        {/* leagues */}
        <div className="flex min-h-0 flex-1 flex-col px-5 pb-2 pt-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] tracking-widest text-gray-600">LEAGUES</span>
            <div className="relative">
              <select
                value={filterSport}
                onChange={(e) => setFilterSport(e.target.value)}
                className="appearance-none rounded border border-[var(--line)] bg-black/30 py-1 pl-2 pr-6 text-[11px] font-bold tracking-wider text-gray-200 focus:border-gray-600 focus:outline-none"
                title="Filter the league list by sport"
              >
                <option value="all">ALL SPORTS</option>
                {allSports.map((s) => (
                  <option key={s} value={s}>
                    {s.toUpperCase()}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-500" />
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter…"
              className="ml-auto w-32 rounded border border-[var(--line)] bg-black/30 px-2 py-1 text-[11px] tracking-wider text-gray-200 placeholder:text-gray-600 focus:border-gray-600 focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto rounded border border-[var(--line)] bg-black/20 p-1.5">
            {shownLeagues.map(({ league, sport }) => {
              const on = leagues.has(league)
              return (
                <button
                  key={league}
                  onClick={() => toggle(setLeagues, league)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-white/5"
                >
                  <span
                    className={[
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                      on ? 'border-[var(--total)] bg-[var(--total)] text-black' : 'border-gray-600',
                    ].join(' ')}
                  >
                    {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  </span>
                  <span className="flex-1 truncate tracking-wider text-gray-200">{league}</span>
                  <span className="shrink-0 text-[10px] tracking-widest text-gray-600">
                    {sport.toUpperCase()}
                  </span>
                </button>
              )
            })}
            {shownLeagues.length === 0 && (
              <div className="px-2 py-4 text-center text-[11px] tracking-widest text-gray-600">
                NO LEAGUES MATCH
              </div>
            )}
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center gap-3 border-t border-white/10 px-5 py-3">
          <span className="text-[11px] tracking-widest text-gray-500">{count} SELECTED</span>
          {editing && (
            <button
              onClick={del}
              className="flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-[var(--live)] hover:opacity-80"
            >
              <Trash2 className="h-3.5 w-3.5" />
              DELETE
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded px-3 py-1.5 text-[11px] font-bold tracking-widest text-gray-400 hover:bg-white/5"
          >
            CANCEL
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="rounded bg-[var(--total)] px-4 py-1.5 text-[11px] font-bold tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-30"
          >
            SAVE
          </button>
        </div>
      </div>
    </div>
  )
}
