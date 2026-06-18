import { useEffect, useMemo, useState } from 'react'
import { Check, Search, Trash2, X } from 'lucide-react'
import { getSwiftCatalog, type SwiftCompetition, type SwiftEvent } from '../lib/swiftCatalog'
import {
  setCompetitionMappingsManual,
  setEventMappingManual,
  markUnmapped,
} from '../lib/mappingData'
import { swiftSportOf } from '../lib/sports'
import { ListSkeleton } from './Skeleton'
import { searchSwiftCompetitions, searchSwiftEvents } from '../lib/swiftStatus'

export type EditorTarget =
  | {
      kind: 'competition'
      // raw OpticOdds slugs (must match DB)
      opticSportRaw: string
      opticLeagueRaw: string
      opticTournamentRaw: string
      // current mapping (for display + pre-selection)
      label: string // e.g. "AFL · AFL"
      /** All currently-mapped SWIFT competition ids — picker pre-checks these. */
      currentSwiftIds: string[]
    }
  | {
      kind: 'event'
      opticFixtureId: string
      /** Raw OPTIC sport slug — used to narrow the candidate list to that sport. */
      opticSportRaw: string
      label: string // e.g. "Brisbane Lions v Carlton — 18:50 UTC"
      // restrict event candidates to a competition when known
      swiftCompetitionId: string | null
      swiftCompetitionName: string | null
      currentSwiftId: string | null
    }

interface Props {
  target: EditorTarget
  onClose: () => void
  onSaved: () => void
}

export function MappingEditor({ target, onClose, onSaved }: Props) {
  const [query, setQuery] = useState('')
  const [comps, setComps] = useState<SwiftCompetition[]>([])
  const [events, setEvents] = useState<SwiftEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Competition kind is multi-select: a Set of swift competition ids.
  // Event kind stays single-select: 0 or 1 id (we use a Set anyway for symmetry).
  const initialPicks =
    target.kind === 'competition'
      ? new Set(target.currentSwiftIds)
      : new Set(target.currentSwiftId ? [target.currentSwiftId] : [])
  const [picked, setPicked] = useState<Set<string>>(initialPicks)
  const isMulti = target.kind === 'competition'

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (isMulti) {
        next.has(id) ? next.delete(id) : next.add(id)
      } else {
        next.clear()
        next.add(id)
      }
      return next
    })
  }

  useEffect(() => {
    let alive = true
    getSwiftCatalog()
      .then((cat) => {
        if (!alive) return
        setComps(cat.competitions)
        if (target.kind === 'event') {
          // limit events to those in the paired competition when known, else all.
          const cid = target.swiftCompetitionId
          setEvents(cid ? (cat.eventsByCompId.get(cid) ?? []) : cat.events)
        }
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // SWIFT sport name to restrict the candidate list to. Falls back to "no
  // filter" if we don't recognize the OPTIC sport — better to show everything
  // than to lock the user out.
  const swiftSport =
    target.kind === 'competition'
      ? swiftSportOf(target.opticSportRaw)
      : swiftSportOf(target.opticSportRaw)
  const sportMatches = (s: string | null) =>
    !swiftSport || (s ?? '').toLowerCase() === swiftSport.toLowerCase()

  // Live SWIFT search results, merged into the local filtered list. Keeps the
  // editor useful when an event was added after the last build-mapping snapshot.
  const [liveEvents, setLiveEvents] = useState<SwiftEvent[]>([])
  const [liveComps, setLiveComps] = useState<SwiftCompetition[]>([])
  const [liveSearching, setLiveSearching] = useState(false)
  useEffect(() => {
    setLiveEvents([])
    setLiveComps([])
    const q = query.trim()
    if (q.length < 2) return
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      setLiveSearching(true)
      try {
        if (target.kind === 'competition') {
          const comps = await searchSwiftCompetitions({ q, sport: swiftSport, signal: ctl.signal })
          if (!ctl.signal.aborted) setLiveComps(comps)
        } else {
          const events = await searchSwiftEvents({
            q,
            sport: target.swiftCompetitionId ? null : swiftSport,
            competitionId: target.swiftCompetitionId,
            signal: ctl.signal,
          })
          if (!ctl.signal.aborted) setLiveEvents(events)
        }
      } catch {
        /* swallow — local filter still works */
      } finally {
        if (!ctl.signal.aborted) setLiveSearching(false)
      }
    }, 250)
    return () => {
      ctl.abort()
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, target, swiftSport])

  const visibleComps = useMemo(() => {
    const q = query.trim().toLowerCase()
    const local = comps.filter((c) => {
      if (!sportMatches(c.sport)) return false
      if (q && !`${c.name} ${c.sport ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
    if (!q) return local
    // Merge live results in, deduped by id; snapshot first so the user's
    // familiar candidates stay on top, then any fresh ones.
    const seen = new Set(local.map((c) => c.id))
    for (const c of liveComps) {
      if (seen.has(c.id)) continue
      if (!sportMatches(c.sport)) continue
      seen.add(c.id)
      local.push(c)
    }
    return local
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comps, query, swiftSport, liveComps])

  const visibleEvents = useMemo(() => {
    const q = query.trim().toLowerCase()
    const local = events.filter((e) => {
      // When the event is scoped to a paired competition, events are already
      // pre-filtered by competition (which implies the right sport).
      if (target.kind === 'event' && !target.swiftCompetitionId && !sportMatches(e.sport)) return false
      if (q && !`${e.name ?? ''} ${e.home ?? ''} ${e.away ?? ''} ${e.competition ?? ''}`
        .toLowerCase()
        .includes(q))
        return false
      return true
    })
    if (!q) return local
    const seen = new Set(local.map((e) => e.id))
    for (const e of liveEvents) {
      if (seen.has(e.id)) continue
      if (target.kind === 'event' && !target.swiftCompetitionId && !sportMatches(e.sport)) continue
      if (target.kind === 'event' && target.swiftCompetitionId && e.cid && e.cid !== target.swiftCompetitionId) continue
      seen.add(e.id)
      local.push(e)
    }
    return local
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, query, swiftSport, target, liveEvents])

  async function save() {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      if (target.kind === 'competition') {
        const picks = [...picked]
          .map((id) => comps.find((c) => c.id === id))
          .filter((c): c is SwiftCompetition => !!c)
          .map((c) => ({ id: c.id, name: c.name, sport: c.sport }))
        await setCompetitionMappingsManual({
          opticSportRaw: target.opticSportRaw,
          opticLeagueRaw: target.opticLeagueRaw,
          opticTournamentRaw: target.opticTournamentRaw,
          picks,
        })
      } else {
        const id = [...picked][0] ?? null
        await setEventMappingManual({
          opticFixtureId: target.opticFixtureId,
          swiftEventId: id,
        })
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function unmap() {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      if (target.kind === 'competition') {
        await markUnmapped({
          opticSportRaw: target.opticSportRaw,
          opticLeagueRaw: target.opticLeagueRaw,
          opticTournamentRaw: target.opticTournamentRaw,
        })
      } else {
        await setEventMappingManual({ opticFixtureId: target.opticFixtureId, swiftEventId: null })
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const isComp = target.kind === 'competition'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-md border border-[var(--line)] bg-[var(--panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-2 text-[12px] font-bold tracking-widest text-gray-100">
            EDIT MAPPING
            <span className="text-gray-600">·</span>
            <span className="text-gray-400">{isComp ? 'COMPETITION' : 'EVENT'}</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 transition-colors hover:text-gray-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-3 text-[12px] text-gray-300">
          <div className="text-[10px] tracking-widest text-gray-600">OPTIC</div>
          <div className="mt-0.5 truncate">{target.label}</div>
          {!isComp && (target as { swiftCompetitionName: string | null }).swiftCompetitionName && (
            <div className="mt-1.5 text-[10px] tracking-widest text-gray-600">
              SCOPED TO ·{' '}
              <span className="text-gray-400">
                {(target as { swiftCompetitionName: string | null }).swiftCompetitionName}
              </span>
            </div>
          )}
        </div>

        <div className="border-y border-white/10 px-5 py-2">
          {swiftSport && (
            <div className="mb-2 flex items-center gap-2 text-[10px] tracking-widest text-gray-500">
              SHOWING
              <span className="rounded border border-[var(--total)]/40 bg-[var(--total)]/10 px-1.5 py-0.5 font-bold text-[var(--total)]">
                {swiftSport.toUpperCase()}
              </span>
              ONLY
            </div>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isComp ? 'SEARCH SWIFT COMPETITION…' : 'SEARCH SWIFT EVENT…'}
              autoFocus
              className="w-full rounded-md border border-[var(--line)] bg-black/30 py-2 pl-9 pr-3 text-[12px] tracking-wider text-gray-200 placeholder:text-gray-600 focus:border-gray-600 focus:outline-none"
            />
            {liveSearching && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-500">
                searching live…
              </span>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {error ? (
            <div className="px-3 py-4 text-[12px] text-[var(--live)]">{error}</div>
          ) : loading ? (
            <ListSkeleton rows={6} />
          ) : isComp ? (
            visibleComps.map((c) => (
              <CandidateRow
                key={c.id}
                active={picked.has(c.id)}
                onClick={() => togglePick(c.id)}
                title={c.name}
                meta={`${c.sport ?? '—'} · ${c.n} events`}
              />
            ))
          ) : (
            visibleEvents.map((e) => (
              <CandidateRow
                key={e.id}
                active={picked.has(e.id)}
                onClick={() => togglePick(e.id)}
                title={e.name ?? `${e.home ?? '?'} v ${e.away ?? '?'}`}
                meta={[
                  e.competition,
                  e.start ? new Date(e.start).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null,
                  e.status,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))
          )}
          {!loading && !error && (isComp ? visibleComps.length : visibleEvents.length) === 0 && (
            <div className="px-3 py-6 text-center text-[11px] tracking-widest text-gray-600">
              NO MATCHES
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-white/10 px-5 py-3">
          {(target.kind === 'event' ? !!target.currentSwiftId : target.currentSwiftIds.length > 0) && (
            <button
              onClick={unmap}
              disabled={saving}
              className="flex items-center gap-1.5 rounded border border-[var(--line)] px-3 py-1.5 text-[11px] font-bold tracking-widest text-[var(--live)] hover:bg-white/5 disabled:opacity-50"
              title="Remove all SWIFT mappings (sticky — won't auto-rematch)"
            >
              <Trash2 className="h-3.5 w-3.5" />
              UNMAP
            </button>
          )}
          <span className="ml-auto text-[10px] tracking-widest text-gray-600">
            {isMulti
              ? `${picked.size} SELECTED`
              : picked.size === 0
                ? 'WILL CLEAR MAPPING'
                : 'NEW MAPPING SELECTED'}
          </span>
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[11px] font-bold tracking-widest text-gray-400 hover:bg-white/5"
          >
            CANCEL
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 rounded bg-[var(--total)] px-4 py-1.5 text-[11px] font-bold tracking-widest text-black disabled:opacity-50"
          >
            {saving ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CandidateRow({
  active,
  onClick,
  title,
  meta,
}: {
  active: boolean
  onClick: () => void
  title: string
  meta: string
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex w-full items-start gap-2 rounded px-3 py-2 text-left transition-colors',
        active ? 'bg-[var(--total)]/15 ring-1 ring-[var(--total)]/40' : 'hover:bg-white/5',
      ].join(' ')}
    >
      <span
        className={[
          'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
          active ? 'border-[var(--total)] bg-[var(--total)] text-black' : 'border-gray-600',
        ].join(' ')}
      >
        {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-gray-100">{title}</div>
        {meta && <div className="truncate text-[10px] tracking-widest text-gray-500">{meta}</div>}
      </div>
    </button>
  )
}
