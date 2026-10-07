import type { EventStatus, SportEvent } from './types';

export type CountdownTone =
  | 'live' // started, in play
  | 'final' // completed
  | 'cancelled' // called off
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

/**
 * Effective status, from the fixture's authoritative signals — NOT the clock.
 * An event is live only if the feed says so (`status='live'`, the `is_live`
 * flag, or a stamped `actualStart`); a scheduled start that has merely passed
 * does NOT imply live (matches run late / get postponed, especially tennis).
 */
export function effectiveStatus(event: SportEvent, _now: number): EventStatus {
  if (event.status === 'final') return 'final';
  if (event.status === 'cancelled') return 'cancelled';
  if (event.status === 'live' || event.isLive || event.actualStart) return 'live';
  return 'upcoming';
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
  if (status === 'cancelled') return { tone: 'cancelled', label: 'Cancelled', pulse: false };
  if (status === 'live') return { tone: 'live', label: 'LIVE', pulse: true };

  const ms = new Date(event.startsAt).getTime() - now;

  // Start time has passed but the feed hasn't marked it live/final — it's late
  // or postponed (common in tennis). Don't pulse a fake "00:00"; show "Delayed".
  if (ms <= 0) return { tone: 'scheduled', label: 'Delayed', pulse: false };

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
/** Period abbreviation per sport (Q quarters, H halves, S sets, R rounds). */
export const PERIOD_PREFIX: Record<string, string> = {
  'Aussie Rules': 'Q',
  'Rugby League': 'H',
  'American Football': 'Q',
  Basketball: 'Q',
  Soccer: 'H',
  MMA: 'R',
  Tennis: 'S',
};

/*
 * How many periods a game has, for the sports whose feed carries a running
 * clock.
 *
 * Tennis, cricket, darts and esports are deliberately absent. They have no
 * clock at all -- not one live tennis match of seven had a value -- so a
 * stopped clock there means nothing, and reading it as a break would label a
 * match mid-set "End S1".
 */
const CLOCK_PERIODS: Record<string, number> = {
  Basketball: 4,
  'American Football': 4,
  'Aussie Rules': 4,
  'Ice Hockey': 3,
  Soccer: 2,
  'Rugby League': 2,
  'Rugby Union': 2,
};

/**
 * The label for a game sitting at a break.
 *
 * A clock that is STOPPED and absent is the feed's way of saying nothing is
 * running: Golden State v LA Lakers sat at period 2 with a frozen 81-53 and no
 * clock for as long as it was watched, which is halftime, but the badge read
 * "Q2" and looked like a clock we had failed to fetch. A clock that is stopped
 * and still has a value is an ordinary stoppage mid-period -- a timeout reads
 * "00:34" -- and keeps its time.
 */
export function breakLabel(sport: string, period: number): string | null {
  const periods = CLOCK_PERIODS[sport];
  if (!periods) return null;
  if (period * 2 === periods) return 'HT';
  if (period >= periods) return 'END';
  return `End ${PERIOD_PREFIX[sport] ?? 'P'}${period}`;
}

/**
 * The clock as it should read.
 *
 * Sports played to a countdown send "MM:SS" -- "Q4 02:13" -- but soccer sends
 * the minute elapsed as a bare number, which rendered as "H1 3" and read like
 * a scoreline. A digits-only clock is a minute count, so it gets the prime the
 * sport is always written with: "H1 3'".
 */
const clockText = (clock: string): string => (/^\d+$/.test(clock) ? `${clock}'` : clock);

export function livePositionLabel(event: SportEvent): string {
  const { sport, period, clock, clockStopped } = event;
  if (period == null) return 'LIVE';
  if (sport === 'Baseball') {
    // clock is the half-inning: Top / Middle / Bottom / End.
    const abbr = clock ? clock.slice(0, 3) : '';
    const half = abbr ? abbr.charAt(0).toUpperCase() + abbr.slice(1).toLowerCase() : '';
    return half ? `${half} ${period}` : `${period}`;
  }
  /*
   * The time on the clock, where the feed gives one: "Q4 13:36", not "Q4".
   *
   * It is the same `clock` the detail panel has always shown, and this label
   * dropped it -- so the list said only how far through a game was, never how
   * much of it was left. The feed omits it at a break (soccer reads period
   * "HALF" with no clock) and for some fixtures entirely, which is what the
   * guard is for.
   */
  if (!clock && clockStopped) {
    const atBreak = breakLabel(sport, period);
    if (atBreak) return atBreak;
  }
  const period_ = `${PERIOD_PREFIX[sport] ?? 'P'}${period}`;
  return clock ? `${period_} ${clockText(clock)}` : period_;
}

export const TONE_CLASSES: Record<CountdownTone, string> = {
  live: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  final: 'bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/20',
  cancelled: 'bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/25',
  imminent: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/40',
  soon: 'bg-orange-500/15 text-orange-300 ring-1 ring-orange-500/30',
  near: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  scheduled: 'bg-white/5 text-slate-300 ring-1 ring-white/10',
};
