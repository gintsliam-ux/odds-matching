import type { SportEvent } from '../lib/types';
import type { H2HPrices } from '../lib/db';
import { countdownFor, effectiveStatus, livePositionLabel } from '../lib/countdown';
import { teamAbbr } from '../lib/teamLogos';
import { LeagueBadge } from './LeagueBadge';
import { TeamLogo } from './TeamLogo';

interface Props {
  events: SportEvent[];
  now: number;
  prices: Map<string, H2HPrices>;
  activeId: string | null;
  onSelect: (event: SportEvent) => void;
}

function priceText(p: number | null | undefined): string {
  return p != null ? p.toFixed(2) : '–';
}

/** One team's line: crest/flag + abbreviation, then its score or H2H price. */
function SideLine({
  event,
  side,
  played,
  prices,
}: {
  event: SportEvent;
  side: 'home' | 'away';
  played: boolean;
  prices: Map<string, H2HPrices>;
}) {
  const isPerson = event.sport === 'Tennis';
  const name = side === 'home' ? event.home : event.away;
  const country = side === 'home' ? event.homeCountry : event.awayCountry;
  const score = side === 'home' ? event.homeScore : event.awayScore;
  const other = side === 'home' ? event.awayScore : event.homeScore;
  const winning = played && score != null && other != null && score > other;

  // Played -> the score (leader emphasised); upcoming -> best H2H price.
  const value = played
    ? `${score ?? 0}`
    : priceText(prices.get(event.id)?.[side]);

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <TeamLogo name={name} size={14} country={country} />
        <span className="text-xs font-medium text-slate-200">
          {teamAbbr(name, isPerson)}
        </span>
      </span>
      <span
        className={`text-xs tabular-nums ${
          played
            ? winning
              ? 'font-bold text-slate-100'
              : 'text-slate-400'
            : 'text-emerald-300'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function Cell({
  event,
  now,
  prices,
  selected,
  onSelect,
}: {
  event: SportEvent;
  now: number;
  prices: Map<string, H2HPrices>;
  selected: boolean;
  onSelect: (event: SportEvent) => void;
}) {
  const status = effectiveStatus(event, now);
  const played = event.homeScore != null && event.awayScore != null;
  const cd = countdownFor(event, now);
  const statusLabel =
    status === 'live' ? livePositionLabel(event) : status === 'final' ? 'FT' : cd.label;

  return (
    <button
      type="button"
      onClick={() => onSelect(event)}
      title={event.name}
      className={`flex w-[132px] shrink-0 flex-col gap-1.5 border-r border-surface-border px-3 py-2 text-left transition-colors ${
        selected ? 'bg-emerald-500/10' : 'hover:bg-white/5'
      }`}
    >
      <div className="flex items-center justify-between">
        <LeagueBadge league={event.league} size={14} />
        <span
          className={`flex items-center gap-1 text-[10px] font-semibold tracking-wide tabular-nums ${
            status === 'live' ? 'text-emerald-300' : 'text-slate-500'
          }`}
        >
          {status === 'live' && (
            <span className="relative flex h-1 w-1">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75" />
              <span className="relative inline-flex h-1 w-1 rounded-full bg-emerald-300" />
            </span>
          )}
          {statusLabel}
        </span>
      </div>
      <SideLine event={event} side="home" played={played} prices={prices} />
      <SideLine event={event} side="away" played={played} prices={prices} />
    </button>
  );
}

/**
 * The top ticker: every event in view as a compact card — team abbreviations
 * with the score once a game is under way, or the best H2H price while it's
 * still upcoming. Scrolls horizontally when the slate is wide.
 */
export function ScoreboardBar({ events, now, prices, activeId, onSelect }: Props) {
  if (events.length === 0) return null;
  return (
    <div className="flex shrink-0 overflow-x-auto border-b border-surface-border bg-surface">
      {events.map((event) => (
        <Cell
          key={event.id}
          event={event}
          now={now}
          prices={prices}
          selected={event.id === activeId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
