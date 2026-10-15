import { memo } from 'react';
import type { SportEvent } from '../lib/types';
import { countdownFor, effectiveStatus, livePositionLabel, TONE_CLASSES } from '../lib/countdown';
import { LeagueBadge } from './LeagueBadge';

interface Props {
  event: SportEvent;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
}

function Row({ event, now, selected, onSelect }: Props) {
  const cd = countdownFor(event, now);
  // Live rows show where the game is up to instead of "LIVE"; the live tone and
  // blinker (from cd) stay.
  const label =
    effectiveStatus(event, now) === 'live' ? livePositionLabel(event) : cd.label;

  return (
    <button
      type="button"
      onClick={() => onSelect(event.id)}
      className={`flex w-full items-center gap-2.5 rounded-lg border-l-2 py-2 pl-2 pr-2 text-left transition-colors ${
        selected
          ? 'border-emerald-400 bg-emerald-500/10'
          : 'border-transparent hover:bg-white/5'
      }`}
    >
      <LeagueBadge league={event.league} size={30} />

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">
          {event.name}
        </div>
        <div className="truncate text-xs text-slate-500">
          {event.subtitle ? `${event.league.name} · ${event.subtitle}` : event.league.name}
        </div>
      </div>

      <span
        className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold tabular-nums ${TONE_CLASSES[cd.tone]}`}
      >
        {cd.pulse && (
          <span className="relative flex h-1 w-1">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
            <span className="relative inline-flex h-1 w-1 rounded-full bg-current" />
          </span>
        )}
        {label}
      </span>
    </button>
  );
}

/**
 * Memoised, because the rail is long and the clock is fast.
 *
 * Nothing here is expensive on its own — a button, a crest, two lines of text —
 * but the board carries ~2,500 of them and the page ticks every second, so React
 * was reconciling every row sixty times a minute to redraw labels that had not
 * changed. Most of them cannot change: `countdownFor` returns a constant for
 * anything live, final or cancelled, and only minutes for anything more than
 * half an hour out.
 *
 * Two things in App make this actually hold, and both are easy to undo by
 * accident:
 *   - `visible` no longer depends on the 1s tick, so `event` keeps its identity
 *     between polls;
 *   - `now` is QUANTISED per row to the resolution that row's own label needs,
 *     so a row showing "3d" is handed a number that changes once a minute and a
 *     row showing LIVE one that never changes.
 * An inline `onSelect={() => …}` in the parent would also defeat it, which is
 * why the callback takes the id.
 */
export const EventRow = memo(Row);
