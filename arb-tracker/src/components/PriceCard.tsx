import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { brandById, type Fluc, type PriceDetail } from '../lib/markets';
import { BookmakerLogo } from './BookmakerLogo';

const CARD_W = 264;
const GAP = 10;

function fmt(n: number): string {
  return n.toFixed(2);
}

function clockAt(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "4m ago" / "2h ago" — how stale the price we're showing is. */
function agoLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

interface Move {
  drifted: boolean;
  pct: number;
}

/** Current price against its open. Null when it opened here and never moved. */
function movementOf(d: PriceDetail): Move | null {
  if (d.open == null || d.open === d.price) return null;
  return { drifted: d.price > d.open, pct: (Math.abs(d.price - d.open) / d.open) * 100 };
}

/**
 * Price history as a sparkline: neutral line, accent dot on the live price.
 * X is real time, so a price that sat still for an hour reads as a flat run
 * rather than an evenly-spaced step.
 */
function Sparkline({ flucs }: { flucs: Fluc[] }) {
  const W = CARD_W - 28;
  const H = 46;
  const PAD = 5;

  const ts = flucs.map((f) => new Date(f.t).getTime());
  const ps = flucs.map((f) => f.p);
  const t0 = ts[0];
  const tSpan = ts[ts.length - 1] - t0 || 1;
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const pSpan = hi - lo;

  const x = (t: number) => PAD + ((t - t0) / tSpan) * (W - PAD * 2);
  // A price that never moved draws down the middle rather than on the floor.
  const y = (p: number) =>
    pSpan === 0 ? H / 2 : H - PAD - ((p - lo) / pSpan) * (H - PAD * 2);

  const pts = flucs.map((f, i) => `${x(ts[i])},${y(f.p)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${x(ts[ts.length - 1])},${H}L${x(t0)},${H}Z`;
  const lastX = x(ts[ts.length - 1]);
  const lastY = y(ps[ps.length - 1]);

  return (
    <div className="mt-2">
      <svg width={W} height={H} className="block overflow-visible" aria-hidden="true">
        <defs>
          <linearGradient id="fluc-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.18" />
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
        {/* Live price — accent, ringed in the surface so it clears the line. */}
        <circle cx={lastX} cy={lastY} r={4} fill="#34d399" stroke="#11151f" strokeWidth={2} />
      </svg>
      <div className="flex justify-between text-[10px] tabular-nums text-slate-600">
        <span>{clockAt(flucs[0].t)}</span>
        <span>{flucs.length} moves</span>
        <span>{clockAt(flucs[flucs.length - 1].t)}</span>
      </div>
    </div>
  );
}

export interface HoverTarget {
  detail: PriceDetail;
  /** Selection this price belongs to, e.g. "Milwaukee Brewers -1.5". */
  title: string;
  /** Column the price sits in — a book name, or "Back"/"Lay" for the exchange. */
  column: string;
  rect: DOMRect;
}

/**
 * Hover card for a single price: where it opened, how it has moved, and the
 * pre-jump snapshots. Portalled to the body so the scrolling grid can't clip
 * it, and positioned off the hovered cell's rect (flipping when it would run
 * off the right edge or bottom).
 */
export function PriceCard({ target, now }: { target: HoverTarget; now: number }) {
  const { detail, title, column, rect } = target;
  const brand = brandById(detail.bookId);
  const move = movementOf(detail);
  const implied = (100 / detail.price).toFixed(1);

  // Height varies with how much history a price has, so measure rather than
  // guess — an under-estimate silently clips the footer off-screen. The
  // measurement lands in useLayoutEffect, before paint, so it never flickers.
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  }, [detail]);

  const left = Math.max(
    GAP,
    Math.min(rect.left, window.innerWidth - CARD_W - GAP),
  );
  // Prefer below the cell; flip above when it wouldn't fit, then clamp so the
  // card is always fully on screen.
  const below = rect.bottom + GAP;
  const top =
    height > 0 && below + height > window.innerHeight
      ? Math.max(GAP, Math.min(rect.top - GAP - height, window.innerHeight - height - GAP))
      : below;

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ position: 'fixed', left, top, width: CARD_W }}
      className="pointer-events-none z-50 rounded-lg border border-surface-border bg-surface-raised p-3 shadow-2xl shadow-black/60"
    >
      {/* who + what */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {brand && <BookmakerLogo brand={brand} size={14} />}
          <span className="truncate text-[11px] font-medium text-slate-300">{column}</span>
        </span>
        {detail.status && detail.status !== 'active' && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
            {detail.status}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-slate-500">{title}</div>

      {/* the number, then how it got here */}
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-slate-100">{fmt(detail.price)}</span>
        {move ? (
          <span
            className={`text-xs font-medium ${move.drifted ? 'text-emerald-300' : 'text-rose-300'}`}
          >
            {move.drifted ? '▲' : '▼'} {move.pct.toFixed(1)}%{' '}
            {move.drifted ? 'drifted' : 'firmed'}
          </span>
        ) : (
          <span className="text-xs text-slate-600">no move</span>
        )}
      </div>

      {detail.flucs.length > 1 ? (
        <Sparkline flucs={detail.flucs} />
      ) : (
        <div className="mt-2 rounded border border-dashed border-surface-border px-2 py-2 text-center text-[10px] text-slate-600">
          No price movement recorded yet
        </div>
      )}

      {/* the numbers the sparkline only implies */}
      <dl className="mt-2 space-y-1 border-t border-surface-border pt-2 text-[11px]">
        {detail.open != null && (
          <div className="flex justify-between">
            <dt className="text-slate-500">
              Open{detail.openAt && <span className="text-slate-600"> · {clockAt(detail.openAt)}</span>}
            </dt>
            <dd className="tabular-nums text-slate-300">{fmt(detail.open)}</dd>
          </div>
        )}
        {detail.snapshots.map((s) => (
          <div key={s.label} className="flex justify-between">
            <dt className="text-slate-500">{s.label}</dt>
            <dd className="tabular-nums text-slate-300">{fmt(s.price)}</dd>
          </div>
        ))}
        <div className="flex justify-between">
          <dt className="text-slate-500">Implied</dt>
          <dd className="tabular-nums text-slate-300">{implied}%</dd>
        </div>
      </dl>

      {detail.updatedAt && (
        <div className="mt-1.5 text-[10px] text-slate-600">
          Updated {agoLabel(detail.updatedAt, now)}
        </div>
      )}
    </div>,
    document.body,
  );
}
