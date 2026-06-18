import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, BellOff, ChevronDown, ChevronRight, ExternalLink, GitMerge } from 'lucide-react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useTerminal } from '../components/Layout'
import type { Notification } from '../hooks/useNotifications'
import { useCoverageGaps } from '../hooks/useCoverageGaps'
import { sportEmoji, sportLabel } from '../lib/sports'
import { melbDateTimeShort, utcDateTimeShort } from '../lib/format'

const KIND_LABEL: Record<Notification['kind'], string> = {
  swift_still_open: 'SwiftBet still taking bets on started event',
  optic_overdue_prematch: 'OPTIC still upcoming after scheduled kickoff',
}

/** "12m" / "1h 30m" delta past the reference time. */
function lateLabel(ref: string | null): string | null {
  if (!ref) return null
  const diffMin = Math.floor((Date.now() - Date.parse(ref)) / 60_000)
  if (!Number.isFinite(diffMin) || diffMin <= 0) return null
  if (diffMin < 60) return `${diffMin}m`
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export default function NotificationsPage() {
  useDocumentTitle('Notifications')
  const { notifications, notificationsLoading: loading } = useTerminal()
  const { swiftUnmapped, opticUnmapped, loading: coverageLoading } = useCoverageGaps()

  const grouped = useMemo(() => {
    const m = new Map<Notification['kind'], Notification[]>()
    // Force order: swift_still_open first (highest priority).
    for (const kind of ['swift_still_open', 'optic_overdue_prematch'] as const) m.set(kind, [])
    for (const n of notifications) m.get(n.kind)!.push(n)
    return [...m.entries()].filter(([, list]) => list.length > 0)
  }, [notifications])

  const stillOpen = notifications.filter((n) => n.kind === 'swift_still_open').length

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Notifications</h1>
          <p className="mt-1 text-sm text-[color:var(--muted-2)]">
            Events still open on SwiftBet after the game has started. Polled every 10s.
          </p>
        </div>
        {stillOpen > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--live)]/15 px-3 py-1.5 text-sm font-semibold text-[color:var(--live)]">
            <AlertTriangle className="h-4 w-4" />
            {stillOpen} open
          </span>
        )}
      </header>

      {loading && notifications.length === 0 ? (
        <div className="rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--panel)] p-8 text-sm text-[color:var(--muted-2)]">
          Loading…
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--panel)] p-12 text-center">
          <BellOff className="h-8 w-8 text-[color:var(--muted-2)]" />
          <div className="text-sm text-white">All clear</div>
          <div className="text-xs text-[color:var(--muted-2)]">
            No SwiftBet markets are open on started games.
          </div>
        </div>
      ) : (
        grouped.map(([kind, list]) => (
          <section key={kind} className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--muted-2)]">
              {KIND_LABEL[kind]} · {list.length}
            </h2>
            <div className="overflow-hidden rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--panel)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[color:var(--line-soft)] text-left text-[11px] uppercase tracking-wide text-[color:var(--muted-2)]">
                    <th className="px-4 py-2.5 font-medium">Sport</th>
                    <th className="px-4 py-2.5 font-medium">Match-up</th>
                    <th className="px-4 py-2.5 font-medium">SWIFT event</th>
                    <th className="px-4 py-2.5 font-medium">Started</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((n) => (
                    <NotificationRow key={n.id} n={n} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      <CoverageSection
        title="SwiftBet competitions without an OPTIC mapping"
        emptyHint="Every SwiftBet competition has at least one OPTIC tournament pointing at it."
        loading={coverageLoading}
        count={swiftUnmapped.length}
      >
        {swiftUnmapped.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-3 border-b border-[color:var(--line-soft)] px-4 py-2 last:border-b-0"
          >
            <div className="flex-1">
              <div className="text-sm text-gray-100">{c.name}</div>
              <div className="text-[11px] text-[color:var(--muted-2)]">
                {(c.sport ?? '—')} · {c.n} event{c.n === 1 ? '' : 's'} in snapshot
              </div>
            </div>
            <code className="hidden font-mono text-[10px] text-[color:var(--muted-2)] md:block">{c.id}</code>
          </li>
        ))}
      </CoverageSection>

      <CoverageSection
        title="OPTIC tournaments without a SwiftBet mapping"
        emptyHint="Every OPTIC tournament has been mapped (or explicitly marked unmapped)."
        loading={coverageLoading}
        count={opticUnmapped.length}
      >
        {opticUnmapped.map((t) => (
          <li
            key={t.tournamentKey}
            className="flex items-center gap-3 border-b border-[color:var(--line-soft)] px-4 py-2 last:border-b-0"
          >
            <span className="text-base leading-none">{sportEmoji(t.sport)}</span>
            <div className="flex-1">
              <div className="text-sm text-gray-100">{t.league}</div>
              <div className="text-[11px] text-[color:var(--muted-2)]">{sportLabel(t.sport)}</div>
            </div>
            <Link
              to={`/mapping?tournament=${encodeURIComponent(t.tournamentKey)}`}
              className="inline-flex items-center gap-1 rounded border border-[color:var(--line-soft)] px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-white/5"
            >
              <GitMerge className="h-3 w-3" /> Map
            </Link>
          </li>
        ))}
      </CoverageSection>
    </div>
  )
}

function NotificationRow({ n }: { n: Notification }) {
  const startedRef = n.opticActualStart ?? n.scheduledStart
  const utc = startedRef ? utcDateTimeShort(startedRef) : '—'
  const melb = startedRef ? melbDateTimeShort(startedRef) : '—'
  const ago = lateLabel(startedRef)
  const isPrimary = n.kind === 'swift_still_open'
  return (
    <tr className={`border-t border-[color:var(--line-soft)] ${isPrimary ? 'bg-[color:var(--live)]/[0.04] hover:bg-[color:var(--live)]/[0.08]' : 'hover:bg-white/[0.02]'}`}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-gray-300">
          <span className="text-base leading-none">{sportEmoji(n.sport)}</span>
          <div>
            <div className="font-medium text-gray-100">{sportLabel(n.sport)}</div>
            <div className="text-[11px] text-[color:var(--muted-2)]">{n.league}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-100">
        <div>{n.home}</div>
        <div className="text-[color:var(--muted-2)]">vs {n.away}</div>
      </td>
      <td className="px-4 py-3 text-xs">
        {n.swiftEventId ? (
          <>
            <div className="text-gray-200">{n.swiftEventName ?? '—'}</div>
            <div className="font-mono text-[10px] text-[color:var(--muted-2)]">{n.swiftEventId}</div>
            <div className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              n.swiftStatus === 'prematch'
                ? 'bg-[color:var(--live)]/15 text-[color:var(--live)]'
                : 'bg-white/5 text-gray-300'
            }`}>
              SWIFT: {n.swiftStatus ?? '—'}
            </div>
          </>
        ) : (
          <div className="text-[color:var(--muted-2)]">unmapped</div>
        )}
        <div className="mt-1 inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
          OPTIC: {n.opticStatus}
        </div>
      </td>
      <td className="px-4 py-3 text-xs tabular-nums">
        <div className="text-gray-200">{utc} UTC</div>
        <div className="text-[color:var(--muted-2)]">{melb} MEL</div>
        {ago && (
          <div className={`mt-0.5 font-semibold ${isPrimary ? 'text-[color:var(--live)]' : 'text-[color:var(--muted-2)]'}`}>
            {ago} {isPrimary ? 'ago' : 'late'}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to={`/fixture/${encodeURIComponent(n.opticFixtureId)}`}
          className="inline-flex items-center gap-1 rounded border border-[color:var(--line-soft)] px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-white/5"
        >
          Open <ExternalLink className="h-3 w-3" />
        </Link>
      </td>
    </tr>
  )
}

function CoverageSection({
  title,
  emptyHint,
  loading,
  count,
  children,
}: {
  title: string
  emptyHint: string
  loading: boolean
  count: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--panel)] px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-[color:var(--muted-2)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[color:var(--muted-2)]" />
        )}
        <span className="flex-1 text-xs font-medium uppercase tracking-wide text-[color:var(--muted-2)]">
          {title}
        </span>
        <span className="tabular-nums text-[12px] text-gray-300">{loading ? '…' : count}</span>
      </button>
      {open && (
        <div className="mt-2 overflow-hidden rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--panel)]">
          {count === 0 ? (
            <div className="px-4 py-4 text-[12px] text-[color:var(--muted-2)]">{emptyHint}</div>
          ) : (
            <ul className="max-h-[480px] overflow-y-auto text-sm">{children}</ul>
          )}
        </div>
      )}
    </section>
  )
}
