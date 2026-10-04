import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { bookLogo } from '../lib/bookLogos'
import { melbDayTime } from '../lib/format'

/**
 * Hover card for a single price: where it opened, how far it has moved, and the
 * snapshot ladder behind it.
 *
 * Ported from Arb Tracker, with one real difference. Arb plots a continuous
 * `flucs` time series, so its X axis is real time and a price that sat still
 * for an hour reads as a flat run. Here the history arrives as STAGES — open,
 * 6h/3h/1h out, 30m, 10m, close, current — which are already a ladder with a
 * fixed order, and several carry no timestamp at all. Plotting those against
 * real time would put most of the line in whatever gaps happened to have
 * stamps, so the X axis is the stage sequence instead.
 *
 * Portalled to the body so the scrolling price grid can't clip it, and
 * positioned off the hovered cell so it never covers the number it describes.
 */

const CARD_W = 250
const GAP = 10

export interface PriceSnap {
  stage: string
  label: string
  price: number
  at: string | null
}

export interface HoverTarget {
  /** Book id, for the logo. Null for a column that isn't one book (Best). */
  book: string | null
  /** Column heading — a book name, or "Best". */
  column: string
  /** Which selection this price is for, e.g. "Carlton −13.5". */
  title: string
  price: number
  snaps: PriceSnap[]
  rect: DOMRect
}

const fmt = (n: number) => n.toFixed(2)

/** "4m ago" / "2h ago" — how stale the number on screen is. */
function agoLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

/** Price now against where it opened. Null when it never moved. */
function movementOf(open: number | null, price: number): { drifted: boolean; pct: number } | null {
  if (open == null || open === price) return null
  return { drifted: price > open, pct: (Math.abs(price - open) / open) * 100 }
}

/**
 * The stage ladder as a sparkline. X is the stage index (see the note above),
 * Y is the price, with the latest point accented.
 */
function Sparkline({ snaps }: { snaps: PriceSnap[] }) {
  const W = CARD_W - 28
  const H = 44
  const PAD = 5

  const ps = snaps.map((s) => s.price)
  const lo = Math.min(...ps)
  const hi = Math.max(...ps)
  const span = hi - lo

  const x = (i: number) => PAD + (i / (snaps.length - 1)) * (W - PAD * 2)
  // A price that never moved draws down the middle, not along the floor.
  const y = (p: number) => (span === 0 ? H / 2 : H - PAD - ((p - lo) / span) * (H - PAD * 2))

  const pts = snaps.map((s, i) => `${x(i)},${y(s.price)}`)
  const line = `M${pts.join('L')}`
  const area = `${line}L${x(snaps.length - 1)},${H}L${x(0)},${H}Z`

  return (
    <div className="mt-2">
      <svg width={W} height={H} className="block overflow-visible" aria-hidden="true">
        <defs>
          <linearGradient id="fluc-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#94a3b8" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#fluc-fade)" />
        <path
          d={line}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Latest price — accented and ringed in the panel colour so it clears
            the line rather than sitting on top of it. */}
        <circle
          cx={x(snaps.length - 1)}
          cy={y(ps[ps.length - 1])}
          r={4}
          fill="var(--total)"
          stroke="var(--panel-2)"
          strokeWidth={2}
        />
      </svg>
      <div className="flex justify-between text-[10px] tabular-nums text-[color:var(--muted-2)]">
        <span>{snaps[0].label}</span>
        <span>
          {snaps.length} point{snaps.length === 1 ? '' : 's'}
        </span>
        <span>{snaps[snaps.length - 1].label}</span>
      </div>
    </div>
  )
}

export function PriceHoverCard({ target, now }: { target: HoverTarget; now: number }) {
  const { book, column, title, price, snaps, rect } = target
  const logo = book ? bookLogo(book) : null
  const open = snaps.find((s) => s.stage === 'open')?.price ?? null
  const move = movementOf(open, price)
  const newest = [...snaps].reverse().find((s) => s.at)?.at ?? null

  // Height varies with how much history a price has, so measure rather than
  // guess — under-estimating silently clips the footer off the bottom of the
  // screen. Measured in useLayoutEffect, before paint, so it never flickers.
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight)
  }, [target])

  const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - CARD_W - GAP))
  // Prefer below the cell; flip above when it wouldn't fit, then clamp so the
  // card is always fully on screen.
  const below = rect.bottom + GAP
  const top =
    height > 0 && below + height > window.innerHeight
      ? Math.max(GAP, Math.min(rect.top - GAP - height, window.innerHeight - height - GAP))
      : below

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ position: 'fixed', left, top, width: CARD_W }}
      className="pointer-events-none z-50 rounded-lg border border-[var(--line)] bg-[color:var(--panel-2)] p-3 shadow-2xl shadow-black/60"
    >
      <div className="flex items-center gap-1.5">
        {logo && <img src={logo} alt="" className="h-3.5 w-3.5 rounded-[2px] object-contain" />}
        <span className="truncate text-[11px] font-medium text-gray-300">{column}</span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-[color:var(--muted)]">{title}</div>

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold leading-none tabular-nums text-gray-100">
          {fmt(price)}
        </span>
        {move ? (
          <span
            className={`text-[11px] font-medium ${
              move.drifted ? 'text-[color:var(--total)]' : 'text-[color:var(--live)]'
            }`}
          >
            {move.drifted ? '▲' : '▼'} {move.pct.toFixed(1)}% {move.drifted ? 'drifted' : 'firmed'}
          </span>
        ) : (
          <span className="text-[11px] text-[color:var(--muted-2)]">no move</span>
        )}
      </div>

      {snaps.length > 1 ? (
        <Sparkline snaps={snaps} />
      ) : (
        <div className="mt-2 rounded border border-dashed border-[var(--line)] px-2 py-2 text-center text-[10px] text-[color:var(--muted-2)]">
          No price movement recorded yet
        </div>
      )}

      {/* The numbers the sparkline only implies. */}
      <dl className="mt-2 space-y-1 border-t border-[color:var(--line-soft)] pt-2 text-[11px]">
        {snaps.map((s) => (
          <div key={s.stage} className="flex justify-between gap-2">
            <dt className="truncate text-[color:var(--muted)]">{s.label}</dt>
            <dd className="shrink-0 tabular-nums text-gray-300">{fmt(s.price)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-2">
          <dt className="text-[color:var(--muted)]">Implied</dt>
          <dd className="shrink-0 tabular-nums text-gray-300">{(100 / price).toFixed(1)}%</dd>
        </div>
      </dl>

      {newest && (
        <div className="mt-1.5 text-[10px] text-[color:var(--muted-2)]" title={melbDayTime(newest)}>
          Updated {agoLabel(newest, now)}
        </div>
      )}
    </div>,
    document.body,
  )
}
