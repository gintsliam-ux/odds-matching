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
  ok: 'text-slate-400',
  warn: 'text-amber-300',
  stale: 'text-red-300',
  idle: 'text-slate-600',
  unknown: 'text-slate-600',
};

export function PulseBar({ pulses, now }: { pulses: Pulse[]; now: number }) {
  if (pulses.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-surface-border bg-surface px-3 py-1 text-[11px] leading-none whitespace-nowrap sm:gap-4">
      {pulses.map((p) => {
        const lv = level(p, now);
        const age = p.at ? ago(p.at, now) : '—';
        return (
          <span
            key={p.key}
            className="flex shrink-0 items-center gap-1.5"
            title={
              p.at
                ? `${p.label}: last write ${new Date(p.at).toLocaleString()}`
                : `${p.label}: nothing to read`
            }
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[lv]} ${
                lv === 'ok' ? 'animate-pulse' : ''
              }`}
            />
            <span className="text-slate-500">{p.label}</span>
            <span className={`font-medium tabular-nums ${TEXT[lv]}`}>
              {p.idle ? 'idle' : age}
            </span>
            {p.detail && !p.idle && <span className="text-slate-600">{p.detail}</span>}
          </span>
        );
      })}
    </div>
  );
}
