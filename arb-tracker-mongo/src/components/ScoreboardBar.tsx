import { useMemo, useState } from 'react';
import type { SportEvent } from '../lib/types';
import type { H2HPrices } from '../lib/db';
import { countdownFor, effectiveStatus, livePositionLabel } from '../lib/countdown';
import { teamAbbr } from '../lib/teamLogos';
import { LeagueBadge } from './LeagueBadge';
import { TeamLogo } from './TeamLogo';
import { IS_MAIN_SPORT, MAIN_LEAGUES, MAIN_SPORTS, inLeague, type MainSport } from '../lib/leagues';

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

// Individuals (abbreviated by surname, may fly a flag) rather than teams.
const PERSON_SPORTS = new Set(['Tennis', 'MMA', 'Boxing', 'Golf', 'Darts']);

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
  const isPerson = PERSON_SPORTS.has(event.sport);
  const name = side === 'home' ? event.home : event.away;
  const country = side === 'home' ? event.homeCountry : event.awayCountry;
  const logo = side === 'home' ? event.homeLogo : event.awayLogo;
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
        <TeamLogo name={name} size={14} country={country} logo={logo} />
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

/** A board event, in the shape the league table matches on. */
const asLeagueKey = (e: SportEvent) => ({
  tournament: e.league?.name,
  category: e.league?.category,
});

/**
 * The top ticker: every event in view as a compact card — team abbreviations
 * with the score once a game is under way, or the best H2H price while it's
 * still upcoming. Scrolls horizontally when the slate is wide.
 *
 * Its own filter, which is the point of it being here rather than wired to the
 * rail's. The rail narrows the EVENT LIST to a day and a competition; this bar
 * deliberately ignores that and shows the whole slate, which is what makes it
 * worth glancing at — and also what makes three and a half thousand events
 * scroll past the right-hand edge. The filter trims the bar without touching
 * what the rail is showing underneath.
 *
 * The filter is deliberately local state and not in the URL. It is a way of
 * looking at the strip for a minute, not a view anyone needs to link someone
 * else to, and the rail's filters already own the shareable part.
 */
export function ScoreboardBar({ events, now, prices, activeId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [sport, setSport] = useState<string | null>(null);
  const [league, setLeague] = useState<string | null>(null);

  const leagues = sport && IS_MAIN_SPORT.has(sport) ? MAIN_LEAGUES[sport as MainSport] : [];
  const activeLeague = leagues.find((l) => l.label === league) ?? null;

  const shown = useMemo(
    () =>
      events.filter(
        (e) =>
          (!sport || e.sport === sport) && (!activeLeague || inLeague(asLeagueKey(e), activeLeague)),
      ),
    [events, sport, activeLeague],
  );

  const bySport = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of events) c.set(e.sport, (c.get(e.sport) ?? 0) + 1);
    return c;
  }, [events]);

  /*
   * Only the leagues with something on the slate, plus the one selected so the
   * chip cannot vanish under the pointer. Soccer has twenty-one here and a
   * fixed row would be mostly zeroes.
   */
  const leagueChips = useMemo(() => {
    const inSport = events.filter((e) => e.sport === sport);
    return leagues
      .map((l) => ({ league: l, n: inSport.filter((e) => inLeague(asLeagueKey(e), l)).length }))
      .filter(({ league: l, n }) => n > 0 || l.label === league);
  }, [events, sport, leagues, league]);

  const filtered = sport != null;

  // Nothing to show at all is the bar's old empty case and still hides it. A
  // filter that matches nothing is NOT that: the bar has to stay so the filter
  // that emptied it can be cleared.
  if (events.length === 0) return null;

  const pickSport = (s: string | null) => {
    setSport(s);
    setLeague(null);
  };

  const chip = (on: boolean, tone: 'sport' | 'league') =>
    `rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
      on
        ? tone === 'league'
          ? 'bg-emerald-500/15 text-emerald-300'
          : 'bg-white/10 text-slate-100'
        : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
    }`;

  return (
    <div className="shrink-0 border-b border-surface-border bg-surface">
      <div className="flex">
        {/*
          * "Filter" on its side, reading downwards, inline with the bar.
          *
          * Vertical because the bar is a horizontal scroller and every pixel
          * across is a pixel of slate you cannot see: a horizontal label would
          * cost most of a card's width permanently. `vertical-rl` rather than
          * a rotate — a transform turns the glyphs but leaves the box as wide
          * as the word, so the cards would still start six characters in.
          *
          * Outside the scrolling div, so it stays put when the bar is scrolled;
          * `self-stretch` keeps it exactly the height of the cards beside it.
          * It turns emerald while a filter is on, because a trimmed ticker that
          * looks untrimmed is a quiet way to miss half the board.
          */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={
            filtered
              ? `Ticker filtered to ${league ? `${sport} · ${league}` : sport} — ${shown.length} of ${events.length}`
              : 'Filter the ticker by sport and league'
          }
          className={`flex shrink-0 items-center self-stretch border-r border-surface-border px-1.5 text-[10px] uppercase leading-none tracking-widest transition [writing-mode:vertical-rl] ${
            filtered
              ? 'bg-emerald-500/10 text-emerald-300'
              : open
                ? 'bg-white/5 text-slate-300'
                : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
          }`}
        >
          Filter
        </button>

        <div className="flex flex-1 overflow-x-auto">
          {shown.map((event) => (
            <Cell
              key={event.id}
              event={event}
              now={now}
              prices={prices}
              selected={event.id === activeId}
              onSelect={onSelect}
            />
          ))}
          {shown.length === 0 && (
            <span className="px-3 py-2 text-xs text-slate-500">
              Nothing on the slate for that filter.
            </span>
          )}
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-1 border-t border-surface-border px-2 py-1.5">
          {/* The eight, alphabetically, always — see MAIN_SPORTS. */}
          <div role="group" aria-label="Sport" className="flex flex-wrap items-center gap-1">
            <button type="button" onClick={() => pickSport(null)} className={chip(sport === null, 'sport')}>
              All sports
            </button>
            {MAIN_SPORTS.map((s) => {
              const n = bySport.get(s) ?? 0;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => pickSport(s)}
                  className={
                    sport !== s && n === 0
                      ? 'rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-700 transition hover:bg-white/5 hover:text-slate-400'
                      : chip(sport === s, 'sport')
                  }
                >
                  {s}
                  <span className="ml-1 tabular-nums opacity-60">{n}</span>
                </button>
              );
            })}
          </div>

          {/* The leagues of the sport above it, once there is a sport. */}
          {leagueChips.length > 0 && (
            <div role="group" aria-label="League" className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => setLeague(null)} className={chip(league === null, 'sport')}>
                All leagues
              </button>
              {leagueChips.map(({ league: l, n }) => (
                <button
                  key={l.label}
                  type="button"
                  onClick={() => setLeague(l.label)}
                  className={chip(league === l.label, 'league')}
                >
                  {l.label}
                  <span className="ml-1 tabular-nums opacity-60">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
