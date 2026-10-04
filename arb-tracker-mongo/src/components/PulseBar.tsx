import { Bone } from './Skeleton';
import type { Pulse } from '../lib/db';

/**
 * A pulse check across the feeds the board is built from, pinned above
 * everything: the Optic fixture feed, the two books whose prices anchor the
 * card, and whether live scores are still ticking.
 *
 * It answers one question — "is what I'm looking at current?" — so it shows an
 * age, not a status word. "Optic 1m" tells you the feed is alive; a green dot
 * with no number would not.
 */

/** Compact age: 8s, 4m, 2h, 3d. */
function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

type Level = 'ok' | 'warn' | 'stale' | 'idle' | 'unknown';

function level(p: Pulse, now: number): Level {
  if (p.idle) return 'idle';
  if (!p.at) return 'unknown';
  const mins = (now - new Date(p.at).getTime()) / 60000;
  if (mins <= p.warn) return 'ok';
  if (mins <= p.stale) return 'warn';
  return 'stale';
}

const DOT: Record<Level, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  stale: 'bg-red-500',
  idle: 'bg-slate-600',
  unknown: 'bg-slate-600',
};

const TEXT: Record<Level, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  stale: 'text-red-300',
  idle: 'text-slate-600',
  unknown: 'text-slate-600',
};

/** A halo behind the dot — only healthy feeds get one, so green carries. */
const GLOW: Partial<Record<Level, string>> = {
  ok: 'shadow-[0_0_8px_1px_rgba(52,211,153,0.75)]',
  warn: 'shadow-[0_0_6px_0_rgba(251,191,36,0.5)]',
  stale: 'shadow-[0_0_6px_0_rgba(239,68,68,0.5)]',
};

/** Shared by the live bar and its loading state, so neither can drift. */
const BAR =
  'flex shrink-0 items-stretch overflow-x-auto border-b border-surface-border bg-surface text-[11px] leading-none whitespace-nowrap';
/** One slot. 132px is the ticker cell's width — the two strips line up. */
const SLOT = 'flex min-w-[132px] flex-1 items-center justify-center gap-1.5 px-3 py-1.5';
const DIVIDER = 'border-l border-surface-border';

/** The five feeds, in the order fetchPulse returns them. */
const SLOT_LABELS = ['Optic', 'TAB', 'Pinnacle', 'Live', 'Scores'];

export function PulseBar({ pulses, now }: { pulses: Pulse[]; now: number }) {
  // Hold the bar's height and its five slots while the first read is in
  // flight. Returning null instead made the whole page jump down a row the
  // moment it landed — and the labels are known before the data is, so there
  // is no reason to withhold them.
  if (pulses.length === 0) {
    return (
      <div className={BAR} role="status" aria-label="Checking feeds">
        {SLOT_LABELS.map((label, i) => (
          <span key={label} className={`${SLOT} ${i ? DIVIDER : ''}`}>
            <span className="h-2 w-2 shrink-0 rounded-full bg-slate-700" />
            <span className="text-slate-600">{label}</span>
            <Bone className="h-2.5 w-6" />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={BAR}>
      {pulses.map((p, i) => {
        const lv = level(p, now);
        const age = p.at ? ago(p.at, now) : '—';
        return (
          <span
            key={p.key}
            className={`${SLOT} ${i ? DIVIDER : ''}`}
            title={
              p.at
                ? `${p.label}: last write ${new Date(p.at).toLocaleString()}`
                : `${p.label}: nothing to read`
            }
          >
            {/* A dot that dims on and off is easy to read as "off". A steady
                core with a ring expanding out of it reads as a heartbeat — so
                the healthy state is the one that moves, and green carries the
                bar rather than sitting quietly under the text. */}
            <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
              {lv === 'ok' && (
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${DOT[lv]}`}
                  // Offset each ring so the five read as separate heartbeats
                  // rather than one strobe across the top of the page.
                  style={{ animationDelay: `${i * 180}ms` }}
                />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${DOT[lv]} ${GLOW[lv] ?? ''}`}
              />
            </span>
            <span className={lv === 'ok' ? 'text-slate-400' : 'text-slate-500'}>{p.label}</span>
            <span className={`font-semibold tabular-nums ${TEXT[lv]}`}>
              {p.idle ? 'idle' : age}
            </span>
            {p.detail && !p.idle && <span className="text-slate-600">{p.detail}</span>}
          </span>
        );
      })}
    </div>
  );
}
