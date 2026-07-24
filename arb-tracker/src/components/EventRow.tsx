import type { SportEvent } from '../lib/types';
import { countdownFor, TONE_CLASSES } from '../lib/countdown';
import { LeagueBadge } from './LeagueBadge';

interface Props {
  event: SportEvent;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function EventRow({ event, now, selected, onSelect }: Props) {
  const cd = countdownFor(event, now);

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
        {cd.label}
      </span>
    </button>
  );
}
