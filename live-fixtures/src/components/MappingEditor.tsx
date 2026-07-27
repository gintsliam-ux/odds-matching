import { useEffect, useMemo, useState } from 'react'
import { Check, Search, Trash2, X } from 'lucide-react'
import { getSwiftCatalog, type SwiftCompetition, type SwiftEvent } from '../lib/swiftCatalog'
import { getMybetCatalog } from '../lib/mybetCatalog'
import {
  setCompetitionMappingsManual,
  setEventMappingManual,
  markUnmapped,
  type Provider,
} from '../lib/mappingData'
import { mybetSportOf, swiftSportOf } from '../lib/sports'
import { ListSkeleton } from './Skeleton'
import { searchSwiftCompetitions, searchSwiftEvents } from '../lib/swiftStatus'
import { searchMybetCompetitions, searchMybetEvents } from '../lib/mybetStatus'

// The editor is provider-agnostic: SwiftBet and mybet catalogues share the same
// competition/event shape, so we type against the SwiftBet interfaces and the
// mybet results assign structurally. `provider` on the target picks the
// catalogue, the live-search endpoint, the sport filter, and the save table.
export type EditorTarget =
  | {
      kind: 'competition'
      /** 'swift' (default) or 'mybet' — which book this mapping targets. */
      provider?: Provider
      // raw OpticOdds slugs (must match DB)
      opticSportRaw: string
      opticLeagueRaw: string
      opticTournamentRaw: string
      // current mapping (for display + pre-selection)
      label: string // e.g. "AFL · AFL"
      /** All currently-mapped book competition ids — picker pre-checks these. */
      currentSwiftIds: string[]
    }
  | {
      kind: 'event'
      provider?: Provider
      opticFixtureId: string
      /** Raw OPTIC sport slug — used to narrow the candidate list to that sport. */
      opticSportRaw: string
      label: string // e.g. "Brisbane Lions v Carlton — 18:50 UTC"
      // restrict event candidates to a competition when known
      swiftCompetitionId: string | null
      swiftCompetitionName: string | null
      currentSwiftId: string | null
    }

/**
 * Opening value for the search box.
 *
 * The candidate list starts from the /public catalogue snapshots, which are
 * only rebuilt by a local `npm run build-mapping` — the Vercel cron runs with
 * writeSnapshot:false because that runtime has no writable /public. So the
 * snapshot goes stale, and tennis rotates its ENTIRE competition set weekly:
 * a 5-day-old snapshot carried 10 tennis competitions, all of them last week's,
 * with the current ones missing outright. Opening the picker on an empty query
 * showed that stale list and nothing else, which reads as "this tournament
 * can't be mapped" — the live search only fires once you type.
 *
 * Seeding the query fires that live search immediately. Seed with the LEADING
 * segment only: OPTIC names a tennis tournament "Los Cabos, Mexico, Qualifying"
 * where the book calls it "ATP Los Cabos", and searching the full string
 * matches nothing while "Los Cabos" matches exactly.
 */
function initialQueryFor(target: EditorTarget): string {
  if (target.kind !== 'competition') return ''
  const head = (target.opticTournamentRaw ?? '').split(',')[0].trim()
  // Guard the 1-char case: the live search needs >= 2 chars to fire at all.
  return head.length >= 2 ? head : ''
}

interface Props {
  target: EditorTarget
  onClose: () => void
  onSaved: () => void
}

export function MappingEditor({ target, onClose, onSaved }: Props) {
  const provider: Provider = target.provider ?? 'swift'
  const bookLabel = provider === 'mybet' ? 'MYBET' : 'SWIFT'
  const [query, setQuery] = useState(() => initialQueryFor(target))
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
    const catalog = provider === 'mybet' ? getMybetCatalog() : getSwiftCatalog()
    catalog
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
  }, [target, provider])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Book sport name to restrict the candidate list to. Each book uses its own
  // sport casing/names (swiftSportOf vs mybetSportOf — e.g. mybet keeps "Soccer"
  // where SwiftBet uses "Football"). Falls back to "no filter" for sports the
  // book doesn't map, so an unknown sport shows everything rather than nothing.
  const swiftSport = provider === 'mybet' ? mybetSportOf(target.opticSportRaw) : swiftSportOf(target.opticSportRaw)
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
          const comps =
            provider === 'mybet'
              ? await searchMybetCompetitions({ q, signal: ctl.signal })
              : await searchSwiftCompetitions({ q, sport: swiftSport, signal: ctl.signal })
          if (!ctl.signal.aborted) setLiveComps(comps)
        } else {
          const events =
            provider === 'mybet'
              ? await searchMybetEvents({ q, competitionId: target.swiftCompetitionId, signal: ctl.signal })
              : await searchSwiftEvents({
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
  }, [query, target, swiftSport, provider])

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

  // Only offer UPCOMING candidates — a completed game is never a valid mapping
  // target and just clutters the picker. "Upcoming" = start within a small
  // grace of now onward (grace keeps a just-started/live game selectable). The
  // currently-mapped event is always kept so re-opening the editor still shows
  // the existing pick even if it has since kicked off.
  const UPCOMING_GRACE_MS = 3 * 60 * 60 * 1000
  const currentId = target.kind === 'event' ? target.currentSwiftId : null
  const isUpcoming = (e: SwiftEvent) =>
    e.id === currentId || !e.start || Date.parse(e.start) > Date.now() - UPCOMING_GRACE_MS

  const visibleEvents = useMemo(() => {
    const q = query.trim().toLowerCase()
    const local = events.filter((e) => {
      // When the event is scoped to a paired competition, events are already
      // pre-filtered by competition (which implies the right sport).
      if (target.kind === 'event' && !target.swiftCompetitionId && !sportMatches(e.sport)) return false
      if (!isUpcoming(e)) return false
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
      if (!isUpcoming(e)) continue
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
          provider,
        })
      } else {
        const id = [...picked][0] ?? null
        await setEventMappingManual({
          opticFixtureId: target.opticFixtureId,
          swiftEventId: id,
          provider,
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
          provider,
        })
      } else {
        await setEventMappingManual({ opticFixtureId: target.opticFixtureId, swiftEventId: null, provider })
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
            <span
              className={
                provider === 'mybet'
                  ? 'rounded border border-[var(--live)]/40 bg-[var(--live)]/10 px-1.5 py-0.5 text-[10px] text-[var(--live)]'
                  : 'rounded border border-[var(--up)]/40 bg-[var(--up)]/10 px-1.5 py-0.5 text-[10px] text-[var(--up)]'
              }
            >
              {bookLabel}
            </span>
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
              placeholder={isComp ? `SEARCH ${bookLabel} COMPETITION…` : `SEARCH ${bookLabel} EVENT…`}
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
          {!loading && !error && !liveSearching && (isComp ? visibleComps.length : visibleEvents.length) === 0 && (
            <div className="px-3 py-6 text-center text-[11px] tracking-widest text-gray-600">
              NO MATCHES
              {/* The bundled catalogue is a periodic snapshot, so a brand-new
                  competition only shows up via the live search. Say so, rather
                  than letting an empty list imply the mapping is impossible. */}
              {query.trim().length < 2 && (
                <div className="mt-2 normal-case tracking-normal text-gray-500">
                  Type at least 2 characters to search {bookLabel} live.
                </div>
              )}
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
