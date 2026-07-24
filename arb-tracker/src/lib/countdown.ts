import type { EventStatus, SportEvent } from './types';

export type CountdownTone =
  | 'live' // started, in play
  | 'final' // completed
  | 'imminent' // <= 5 min
  | 'soon' // <= 10 min
  | 'near' // <= 30 min
  | 'scheduled'; // > 30 min out

export interface Countdown {
  tone: CountdownTone;
  /** Text shown in the badge, e.g. "04:12", "27m", "2h 15m", "LIVE". */
  label: string;
  /** True for tones that should pulse (LIVE + imminent). */
  pulse: boolean;
}

const MIN = 60_000;

/** Effective status: a scheduled event whose start has passed reads as live. */
export function effectiveStatus(event: SportEvent, now: number): EventStatus {
  if (event.status === 'final') return 'final';
  if (event.status === 'live') return 'live';
  return now >= new Date(event.startsAt).getTime() ? 'live' : 'upcoming';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Human gap for events more than 30 min out, e.g. "2h 15m" or "3d". */
function relativeLabel(ms: number): string {
  const totalMin = Math.round(ms / MIN);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Derive the countdown badge for an event at a given `now`.
 * Under 30 min it becomes a live mm:ss countdown and escalates in colour;
 * once started it reads LIVE, and when completed it reads Final.
 */
export function countdownFor(event: SportEvent, now: number): Countdown {
  const status = effectiveStatus(event, now);
  if (status === 'final') return { tone: 'final', label: 'Final', pulse: false };
  if (status === 'live') return { tone: 'live', label: 'LIVE', pulse: true };

  const ms = new Date(event.startsAt).getTime() - now;
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mmss = `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`;

  if (ms <= 5 * MIN) return { tone: 'imminent', label: mmss, pulse: true };
  if (ms <= 10 * MIN) return { tone: 'soon', label: mmss, pulse: false };
  if (ms <= 30 * MIN) return { tone: 'near', label: mmss, pulse: false };
  return { tone: 'scheduled', label: relativeLabel(ms), pulse: false };
}

/**
 * Where a live game is up to, abbreviated: "Q3" (quarters), "H2" (halves),
 * "S2" (tennis sets), and baseball's half-inning as "Top 5" / "Mid 5" /
 * "Bot 5" / "End 5". Falls back to "LIVE" when no period is reported yet.
 */
export function livePositionLabel(event: SportEvent): string {
  const { sport, period, clock } = event;
  if (period == null) return 'LIVE';
  if (sport === 'Baseball') {
    // clock is the half-inning: Top / Middle / Bottom / End.
    const abbr = clock ? clock.slice(0, 3) : '';
    const half = abbr ? abbr.charAt(0).toUpperCase() + abbr.slice(1).toLowerCase() : '';
    return half ? `${half} ${period}` : `${period}`;
  }
  const prefix =
    sport === 'Aussie Rules'
      ? 'Q'
      : sport === 'Rugby League'
        ? 'H'
        : sport === 'Tennis'
          ? 'S'
          : 'P';
  return `${prefix}${period}`;
}

export const TONE_CLASSES: Record<CountdownTone, string> = {
  live: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  final: 'bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/20',
  imminent: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/40',
  soon: 'bg-orange-500/15 text-orange-300 ring-1 ring-orange-500/30',
  near: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  scheduled: 'bg-white/5 text-slate-300 ring-1 ring-white/10',
};
