import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ExternalLink, X } from 'lucide-react'
import type { AlertToast } from '../hooks/useAlertToasts'
import { sportEmoji, sportLabel } from '../lib/sports'

interface Props {
  toasts: AlertToast[]
  onDismiss: (id: string) => void
  onDismissAll: () => void
}

/** "12m ago" / "1h 30m ago" — relative time past `iso`. */
function ago(iso: string | null): string {
  if (!iso) return ''
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(m) || m <= 0) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}

/**
 * Fixed-position toast stack in the top-right corner. Each toast is for one
 * "SwiftBet still open" alert and persists until the X is clicked. Stacks
 * vertically; the most recent fire sits at the top. A "Dismiss all" link
 * appears once there are 2+ toasts.
 */
export function AlertToasts({ toasts, onDismiss, onDismissAll }: Props) {
  const navigate = useNavigate()
  if (toasts.length === 0) return null
  // Newest first so the most recent flip is at the top of the stack.
  const ordered = [...toasts].reverse()
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {ordered.length > 1 && (
        <div className="pointer-events-auto flex items-center justify-between rounded-md border border-[color:var(--line-soft)] bg-[color:var(--panel)]/95 px-3 py-1.5 text-[11px] backdrop-blur">
          <span className="text-[color:var(--muted-2)]">{ordered.length} active alerts</span>
          <button
            onClick={onDismissAll}
            className="font-medium text-gray-300 hover:text-white"
          >
            Dismiss all
          </button>
        </div>
      )}
      {ordered.map((t) => {
        const n = t.notification
        const startedRef = n.opticActualStart ?? n.scheduledStart
        const resolved = !!t.resolvedAt
        // Resolved tone (green) vs firing tone (red) drives header colour,
        // border, body copy, and the time-row tag.
        const accent = resolved
          ? { ring: 'border-emerald-500/40', headerRing: 'border-emerald-500/30', headerBg: 'bg-emerald-500/10', headerText: 'text-emerald-400', timeText: 'text-emerald-400' }
          : { ring: 'border-[color:var(--live)]/40', headerRing: 'border-[color:var(--live)]/30', headerBg: 'bg-[color:var(--live)]/10', headerText: 'text-[color:var(--live)]', timeText: 'text-[color:var(--live)]' }
        return (
          <div
            key={t.id}
            className={`pointer-events-auto overflow-hidden rounded-md border ${accent.ring} bg-[color:var(--panel)] shadow-lg`}
          >
            <div className={`flex items-start gap-2 border-b ${accent.headerRing} ${accent.headerBg} px-3 py-2`}>
              {resolved ? (
                <CheckCircle2 className={`h-4 w-4 shrink-0 ${accent.headerText}`} />
              ) : (
                <AlertTriangle className={`h-4 w-4 shrink-0 ${accent.headerText}`} />
              )}
              <div className={`flex-1 text-[11px] font-semibold uppercase tracking-wide ${accent.headerText}`}>
                {resolved ? 'Resolved' : 'SwiftBet still open'}
              </div>
              <button
                onClick={() => onDismiss(t.id)}
                className="shrink-0 text-[color:var(--muted-2)] transition-colors hover:text-white"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[11px] text-[color:var(--muted-2)]">
                <span className="text-sm leading-none">{sportEmoji(n.sport)}</span>
                <span className="text-gray-200">{sportLabel(n.sport)}</span>
                <span>·</span>
                <span className="truncate">{n.league}</span>
              </div>
              <div className="text-sm font-medium text-gray-100">
                {n.home} <span className="text-[color:var(--muted-2)]">vs</span> {n.away}
              </div>
              <div className="text-[11.5px] leading-snug text-gray-300">
                {resolved
                  ? 'SwiftBet flipped to in-progress. The market is closed.'
                  : 'SwiftBet is still accepting bets on this event even though OPTIC reports it already kicked off. Close the market.'}
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className={`font-semibold ${accent.timeText}`}>
                  {resolved
                    ? `resolved ${ago(new Date(t.resolvedAt!).toISOString())}`
                    : `started ${ago(startedRef)}`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigate(`/fixture/${encodeURIComponent(n.opticFixtureId)}`)
                    onDismiss(t.id)
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 rounded border border-[color:var(--line-soft)] px-2 py-0.5 font-medium text-gray-300 hover:bg-white/5"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
