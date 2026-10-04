import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Link } from 'react-router-dom'
import { fixturePath } from '../lib/routes'
import { NotificationsSkeleton } from '../components/Skeleton'
import { AlertTriangle, Bell, BellOff, ChevronDown, ChevronRight, ExternalLink, GitMerge } from 'lucide-react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useTerminal } from '../components/Layout'
import type { Notification } from '../hooks/useNotifications'
import { useCoverageGaps } from '../hooks/useCoverageGaps'
import { sportGroupKey, sportLabel, sportToSlug } from '../lib/sports'
import { BRAND_LABEL, BRAND_PILL, type Brand } from '../lib/brand'
import { LeagueBadge } from '../components/LeagueBadge'
import { melbDateTimeShort, placementOffset, utcDateTimeShort } from '../lib/format'
import { swiftEventUrl } from '../lib/swiftStatus'
import { mybetEventUrl } from '../lib/mybetStatus'

const KIND_LABEL: Record<Notification['kind'], string> = {
  swift_late_bet: 'Bets placed on SwiftBet after OPTIC went live',
  mybet_late_bet: 'Bets placed on mybet after OPTIC went live',
  swift_still_open: 'SwiftBet still taking bets on started event',
  mybet_still_open: 'mybet market still open on started event',
  optic_overdue_prematch: 'OPTIC still upcoming after scheduled kickoff',
  swift_missettled: 'SwiftBet settled against the final score',
  mybet_missettled: 'mybet settled against the final score',
  swift_unsettled: 'SwiftBet has not resulted a finished event',
  mybet_unsettled: 'mybet has not resulted a finished event',
}

/** Which book a notification kind belongs to (drives the brand-coloured pill). */
function kindBrand(kind: Notification['kind']): Brand {
  if (kind.startsWith('mybet')) return 'mybet'
  if (kind.startsWith('optic')) return 'optic'
  return 'swift'
}

/** Small brand-coloured pill: SWIFT (blue) · MYBET (green) · OPTIC (amber). */
function BrandPill({ brand }: { brand: Brand }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${BRAND_PILL[brand]}`}>
      {BRAND_LABEL[brand]}
    </span>
  )
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

/**
 * Which alerts a page shows. All three read the SAME notification sweep — the
 * two focused pages are a filter over it, not a second source, so a bet can
 * never appear on one page and be missing from the other.
 */
export type NotificationsVariant = 'all' | 'late' | 'settlement'

const VARIANT_KINDS: Record<NotificationsVariant, readonly Notification['kind'][]> = {
  all: [
    'swift_late_bet', 'mybet_late_bet',
    'swift_still_open', 'mybet_still_open',
    'swift_unsettled', 'mybet_unsettled',
    'optic_overdue_prematch',
  ],
  // Money already at risk: bets that landed after OPTIC turned the game live.
  late: ['swift_late_bet', 'mybet_late_bet'],
  // Finished games a book still hasn't resulted.
  settlement: ['swift_unsettled', 'mybet_unsettled', 'swift_missettled', 'mybet_missettled'],
}

/** Settlement splits two different problems that both need chasing. */
type SettlementTab = 'unsettled' | 'missettled'
const SETTLEMENT_TABS: Array<{ key: SettlementTab; label: string; kinds: readonly Notification['kind'][] }> = [
  { key: 'unsettled', label: 'Unsettled', kinds: ['swift_unsettled', 'mybet_unsettled'] },
  { key: 'missettled', label: 'Incorrectly settled', kinds: ['swift_missettled', 'mybet_missettled'] },
]

/**
 * Brand filter. "Multis" is not a brand — it is the cross-game bets both books
 * carry, which are counted separately because a multi waiting on another game
 * is somebody else's problem, not this fixture's.
 */
type BrandTab = 'all' | 'swift' | 'mybet' | 'multis'
const BRAND_TABS: Array<{ key: BrandTab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'swift', label: 'SwiftBet' },
  { key: 'mybet', label: 'mybet' },
  { key: 'multis', label: 'Multis' },
]

function matchesBrand(n: Notification, brand: BrandTab): boolean {
  if (brand === 'all') return true
  // Multis: the alert carries a count of bets whose exposure spans other games.
  if (brand === 'multis') return (n.unsettledMultiCount ?? 0) > 0
  if (brand === 'swift') return n.kind.startsWith('swift')
  return n.kind.startsWith('mybet')
}

const VARIANT_COPY: Record<NotificationsVariant, { title: string; blurb: string; empty: string }> = {
  all: {
    title: 'Notifications',
    blurb:
      'Events where OPTIC has turned live but a book still has the market open (SwiftBet prematch, or mybet before its close time). Polled every 10s. Plus finished events where a book still hasn\u2019t resulted this event\u2019s leg 30+ minutes after OPTIC called them over, re-checked every 45s.',
    empty: 'No SwiftBet or mybet markets are open on OPTIC-live games.',
  },
  late: {
    title: 'Late bets',
    blurb:
      'Bets accepted AFTER OPTIC turned the event live \u2014 the book\u2019s market was still open when the game had already started. Each row carries how many landed late and their total stake. Re-checked every 45s.',
    empty: 'No bets have landed after an event went live.',
  },
  settlement: {
    title: 'Settlement',
    blurb:
      'Finished events a book has not resulted 30+ minutes after OPTIC called them over, and events where the book\u2019s result contradicts the final score. Re-checked every 45s, off the same bet sweep.',
    empty: 'Nothing outstanding.',
  },
}

export default function NotificationsPage({ variant = 'all' }: { variant?: NotificationsVariant }) {
  const copy = VARIANT_COPY[variant]
  useDocumentTitle(copy.title)
  const { notifications: allNotifications, notificationsLoading: loading } = useTerminal()
  const { swiftUnmapped, opticUnmapped, loading: coverageLoading } = useCoverageGaps()

  // Settlement's two-level filter. Both live in the URL so a view can be
  // linked to and survives a reload.
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as SettlementTab) || 'unsettled'
  const brand = (params.get('brand') as BrandTab) || 'all'
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const kinds = useMemo(() => {
    if (variant !== 'settlement') return VARIANT_KINDS[variant]
    return SETTLEMENT_TABS.find((t) => t.key === tab)?.kinds ?? VARIANT_KINDS.settlement
  }, [variant, tab])

  const notifications = useMemo(
    () =>
      allNotifications.filter(
        (n) => kinds.includes(n.kind) && (variant !== 'settlement' || matchesBrand(n, brand)),
      ),
    [allNotifications, kinds, variant, brand],
  )

  /** Counts for the tab badges — computed off the unfiltered sweep. */
  const tabCount = (t: SettlementTab) =>
    allNotifications.filter(
      (n) =>
        SETTLEMENT_TABS.find((x) => x.key === t)!.kinds.includes(n.kind) && matchesBrand(n, brand),
    ).length

  const grouped = useMemo(() => {
    const m = new Map<Notification['kind'], Notification[]>()
    // Force order: bets-after-live first (money already at risk), then still-open.
    for (const kind of kinds) m.set(kind, [])
    for (const n of notifications) m.get(n.kind)?.push(n)
    return [...m.entries()].filter(([, list]) => list.length > 0)
  }, [notifications, kinds])

  // Collapsible notification groups (all expanded by default).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (k: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })

  const stillOpen = notifications.filter(
    (n) =>
      n.kind === 'swift_still_open' ||
      n.kind === 'mybet_still_open' ||
      n.kind === 'swift_late_bet' ||
      n.kind === 'mybet_late_bet',
  ).length

  return (
    <div className="px-5 py-5">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-[20px] font-semibold tracking-tight text-gray-100">
            <Bell className="h-5 w-5 text-[color:var(--total)]" />
            {copy.title}
          </h1>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-[color:var(--muted-2)]">
            {copy.blurb}
          </p>
        </div>
        {stillOpen > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[color:var(--live)]/15 px-3 py-1.5 text-sm font-semibold text-[color:var(--live)]">
            <AlertTriangle className="h-4 w-4" />
            {stillOpen} open
          </span>
        )}
      </header>

      {variant === 'settlement' && (
        <div className="mb-5 space-y-2.5">
          {/* What kind of settlement problem. */}
          <div className="flex items-center gap-1">
            {SETTLEMENT_TABS.map((t) => {
              const n = tabCount(t.key)
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => setParam('tab', t.key)}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    active
                      ? 'bg-white/[0.08] text-gray-100'
                      : 'text-[color:var(--muted)] hover:bg-white/[0.04] hover:text-gray-200'
                  }`}
                >
                  {t.label}
                  {n > 0 && (
                    <span
                      className={`tabular-nums ${
                        t.key === 'missettled' ? 'text-[color:var(--live)]' : 'text-[color:var(--up)]'
                      }`}
                    >
                      {n}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Whose bets. */}
          <div className="flex items-center gap-1">
            {BRAND_TABS.map((b) => {
              const active = brand === b.key
              return (
                <button
                  key={b.key}
                  onClick={() => setParam('brand', b.key === 'all' ? '' : b.key)}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    active
                      ? 'bg-white/[0.06] text-gray-200'
                      : 'text-[color:var(--muted-2)] hover:bg-white/[0.03] hover:text-gray-300'
                  }`}
                >
                  {b.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {loading && notifications.length === 0 ? (
        <NotificationsSkeleton />
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg bg-[color:var(--panel)]/40 p-12 text-center">
          <BellOff className="h-8 w-8 text-[color:var(--muted-2)]" />
          <div className="text-sm text-white">All clear</div>
          <div className="text-xs text-[color:var(--muted-2)]">{copy.empty}</div>
        </div>
      ) : (
        grouped.map(([kind, list]) => {
          const open = !collapsed.has(kind)
          return (
            <section key={kind} className="mb-8">
              <button
                onClick={() => toggle(kind)}
                className="mb-3 flex w-full items-center gap-2 text-left text-xs font-medium uppercase tracking-wide text-[color:var(--muted-2)] transition-colors hover:text-gray-300"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <BrandPill brand={kindBrand(kind)} />
                {KIND_LABEL[kind]}
                <span className="text-[color:var(--muted)]">· {list.length}</span>
              </button>
              {open && (
                <div className="overflow-x-auto rounded-lg bg-[color:var(--panel)]/40">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-[color:var(--muted-2)]">
                        <th className="px-4 py-2.5 font-medium">Sport</th>
                        <th className="px-4 py-2.5 font-medium">Match-up</th>
                        <th className="px-4 py-2.5 font-medium">Book event</th>
                        <th className="px-4 py-2.5 font-medium">Started / ended</th>
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
              )}
            </section>
          )
        })
      )}

      {variant === 'all' && (
        <>
          <CoverageSection
            title="SwiftBet competitions without an OPTIC mapping"
            brand="swift"
            emptyHint="Every SwiftBet competition has at least one OPTIC tournament pointing at it."
            loading={coverageLoading}
            count={swiftUnmapped.length}
          >
            {swiftUnmapped.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 border-t border-white/[0.04] px-4 py-2 first:border-t-0"
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
            brand="optic"
            emptyHint="Every OPTIC tournament has been mapped (or explicitly marked unmapped)."
            loading={coverageLoading}
            count={opticUnmapped.length}
          >
            {opticUnmapped.map((t) => (
              <li
                key={t.tournamentKey}
                className="flex items-center gap-3 border-t border-white/[0.04] px-4 py-2 first:border-t-0"
              >
                <LeagueBadge sport={t.sport} league={t.league} size={18} />
                <div className="flex-1">
                  <div className="text-sm text-gray-100">{t.league}</div>
                  <div className="text-[11px] text-[color:var(--muted-2)]">{sportLabel(t.sport)}</div>
                </div>
                <Link
                  to={`/mapping/${sportToSlug(sportGroupKey(t.rawSport))}/${encodeURIComponent(t.rawLeague)}`}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-white/5"
                >
                  <GitMerge className="h-3 w-3" /> Map
                </Link>
              </li>
            ))}
          </CoverageSection>
        </>
      )}
    </div>
  )
}

function NotificationRow({ n }: { n: Notification }) {
  // Unsettled alerts are measured from when the game ENDED, not when it started
  // — "3h ago" on a settlement alert means three hours unresulted.
  const startedRef = (n.kind === 'swift_unsettled' || n.kind === 'mybet_unsettled' || n.kind === 'swift_missettled' || n.kind === 'mybet_missettled')
    ? n.endedAt ?? n.opticActualStart ?? n.scheduledStart
    : n.opticActualStart ?? n.scheduledStart
  const utc = startedRef ? utcDateTimeShort(startedRef) : '—'
  const melb = startedRef ? melbDateTimeShort(startedRef) : '—'
  const ago = lateLabel(startedRef)
  const isLateBet = n.kind === 'swift_late_bet' || n.kind === 'mybet_late_bet'
  const isUnsettled = n.kind === 'swift_unsettled' || n.kind === 'mybet_unsettled'
  const isMisSettled = n.kind === 'swift_missettled' || n.kind === 'mybet_missettled'
  const isMybet =
    n.kind === 'mybet_still_open' ||
    n.kind === 'mybet_late_bet' ||
    n.kind === 'mybet_unsettled' ||
    n.kind === 'mybet_missettled'
  const isPrimary = n.kind !== 'optic_overdue_prematch'
  return (
    <tr className={`border-t border-white/[0.04] ${isPrimary ? 'bg-[color:var(--live)]/[0.04] hover:bg-[color:var(--live)]/[0.08]' : 'hover:bg-white/[0.02]'}`}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-gray-300">
          <LeagueBadge sport={n.sport} league={n.league} size={18} />
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
        {isMisSettled ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <BrandPill brand={isMybet ? 'mybet' : 'swift'} />
            <span className="inline-flex items-center rounded bg-[color:var(--live)]/15 px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--live)]">
              {n.misSettledCount} settled against the score
            </span>
            {n.misSettledStake ? (
              <span className="tabular-nums text-[11px] text-gray-300">
                ${n.misSettledStake.toFixed(2)} at stake
              </span>
            ) : null}
          </div>
        ) : isUnsettled ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <BrandPill brand={isMybet ? 'mybet' : 'swift'} />
              <span className="inline-flex items-center rounded bg-[color:var(--up)]/15 px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--up)]">
                {n.unsettledCount} {n.unsettledCount === 1 ? 'leg' : 'legs'} unresulted
              </span>
              {n.unsettledStake ? (
                <span className="tabular-nums text-[11px] text-gray-300">${n.unsettledStake.toFixed(2)} at stake</span>
              ) : null}
            </div>
            {n.unsettledMultiCount ? (
              <div className="text-[11px] text-[color:var(--muted-2)]">
                {/* Two different facts behind one number. For SwiftBet we KNOW
                    this event's leg is resolved, because legs carry a status.
                    mybet legs carry none, so all we can say is that the bet
                    spans other games — claiming they were "resulted here"
                    would be asserting something we can't see. */}
                {isMybet
                  ? `+ ${n.unsettledMultiCount} multi${n.unsettledMultiCount === 1 ? '' : 's'} spanning other games — mybet gives no per-leg status`
                  : `+ ${n.unsettledMultiCount} resulted here, bet still open on another game`}
              </div>
            ) : null}
            {isMybet
              ? n.mybetEventId && (
                  <a
                    href={mybetEventUrl(n.mybetEventId, n.sport)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-gray-200 hover:text-[color:var(--mybet)]"
                  >
                    {n.mybetEventName ?? 'Open on mybet'} <ExternalLink className="h-3 w-3" />
                  </a>
                )
              : n.swiftEventId && (
                  <a
                    href={swiftEventUrl(n.swiftEventId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-gray-200 hover:text-[color:var(--swift)]"
                  >
                    {n.swiftEventName ?? 'Open on SwiftBet'} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
          </div>
        ) : isLateBet ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <BrandPill brand={isMybet ? 'mybet' : 'swift'} />
              <span className="inline-flex items-center rounded bg-[color:var(--live)]/15 px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--live)]">
                {n.lateBetCount} {n.lateBetCount === 1 ? 'bet' : 'bets'} after live
              </span>
              {n.lateBetStake ? (
                <span className="tabular-nums text-[11px] text-gray-300">${n.lateBetStake.toFixed(2)} total</span>
              ) : null}
            </div>
            {n.lateBets?.length ? (
              <ul className="space-y-1 border-l-2 border-[color:var(--live)]/30 pl-2.5">
                {n.lateBets.map((lb, i) => {
                  const off = placementOffset(lb.placedUtc, n.scheduledStart, n.opticActualStart)
                  return (
                    <li key={i} className="leading-snug">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                        {off && <span className="font-semibold text-[color:var(--live)]">{off.label}</span>}
                        <span className="tabular-nums text-gray-200">${(lb.stake ?? 0).toFixed(2)}</span>
                        {lb.odds ? <span className="tabular-nums text-[color:var(--muted-2)]">@ {lb.odds.toFixed(2)}</span> : null}
                        {lb.legCount > 1 && lb.betType ? (
                          <span className="rounded bg-white/5 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-gray-400">
                            {lb.betType} · {lb.legCount} legs
                          </span>
                        ) : null}
                        {lb.isBonus ? (
                          <span className="rounded bg-white/5 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-gray-400">bonus</span>
                        ) : null}
                      </div>
                      {lb.selection ? (
                        <div className="max-w-[260px] truncate text-[11px] text-[color:var(--muted-2)]">{lb.selection}</div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
        ) : isMybet ? (
          n.mybetEventId ? (
            <>
              <a
                href={mybetEventUrl(n.mybetEventId, n.sport)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-gray-200 hover:text-[color:var(--mybet)]"
              >
                {n.mybetEventName ?? '—'} <ExternalLink className="h-3 w-3" />
              </a>
              <div className="font-mono text-[10px] text-[color:var(--muted-2)]">{n.mybetEventId}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <BrandPill brand="mybet" />
                <span className="inline-flex items-center rounded bg-[color:var(--live)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--live)]">
                  OPEN
                </span>
              </div>
            </>
          ) : (
            <div className="text-[color:var(--muted-2)]">unmapped</div>
          )
        ) : n.swiftEventId ? (
          <>
            <a
              href={swiftEventUrl(n.swiftEventId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-gray-200 hover:text-[color:var(--swift)]"
            >
              {n.swiftEventName ?? '—'} <ExternalLink className="h-3 w-3" />
            </a>
            <div className="font-mono text-[10px] text-[color:var(--muted-2)]">{n.swiftEventId}</div>
            <div className="mt-1 flex items-center gap-1.5">
              <BrandPill brand="swift" />
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                n.swiftStatus === 'prematch'
                  ? 'bg-[color:var(--live)]/15 text-[color:var(--live)]'
                  : 'bg-white/5 text-gray-300'
              }`}>
                {n.swiftStatus ?? '—'}
              </span>
            </div>
          </>
        ) : (
          <div className="text-[color:var(--muted-2)]">unmapped</div>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          <BrandPill brand="optic" />
          <span className="inline-flex items-center rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
            {n.opticStatus}
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-xs tabular-nums">
        <div className="text-gray-200">{utc} UTC</div>
        <div className="text-[color:var(--muted-2)]">{melb} MEL</div>
        {ago && (
          <div className={`mt-0.5 font-semibold ${isPrimary ? 'text-[color:var(--live)]' : 'text-[color:var(--muted-2)]'}`}>
            {ago} {isUnsettled ? 'unresulted' : isPrimary ? 'ago' : 'late'}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to={fixturePath(n.opticFixtureId, { home: n.home, away: n.away })}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-white/5"
        >
          Open <ExternalLink className="h-3 w-3" />
        </Link>
      </td>
    </tr>
  )
}

function CoverageSection({
  title,
  brand,
  emptyHint,
  loading,
  count,
  children,
}: {
  title: string
  brand: Brand
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
        className="flex w-full items-center gap-2 rounded-lg bg-[color:var(--panel)]/40 px-4 py-3 text-left transition-colors hover:bg-[color:var(--panel)]/70"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-[color:var(--muted-2)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[color:var(--muted-2)]" />
        )}
        <BrandPill brand={brand} />
        <span className="flex-1 text-xs font-medium uppercase tracking-wide text-[color:var(--muted-2)]">
          {title}
        </span>
        <span className="tabular-nums text-[12px] text-gray-300">{loading ? '…' : count}</span>
      </button>
      {open && (
        <div className="mt-2 overflow-hidden rounded-lg bg-[color:var(--panel)]/40">
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
