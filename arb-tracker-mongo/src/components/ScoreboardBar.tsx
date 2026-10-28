import { useMemo, useState } from 'react';
import type { SportEvent } from '../lib/types';
import type { H2HPrices } from '../lib/db';
import { countdownFor, effectiveStatus, livePositionLabel } from '../lib/countdown';
import { teamAbbr } from '../lib/teamLogos';
import { LeagueBadge } from './LeagueBadge';
import { TeamLogo } from './TeamLogo';
import { IS_MAIN_SPORT, MAIN_LEAGUES, MAIN_SPORTS, inLeague, type MainSport } from '../lib/leagues';
import { MultiPill } from './FilterBar';

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
  const [sports, setSports] = useState<string[]>([]);
  const [leagueSel, setLeagueSel] = useState<string[]>([]);

  /*
   * Which sports to offer: the eight, always, in alphabetical order, and then
   * anything else actually on the slate. The eight hold their places whether
   * or not there is anything on them — the point of a fixed list is that the
   * one you reach for does not move — while volleyball or MMA appear only when
   * they are there to be chosen.
   */
  const sportOptions = useMemo(() => {
    const present = new Set(events.map((e) => e.sport));
    return [...MAIN_SPORTS, ...[...present].filter((s) => !IS_MAIN_SPORT.has(s)).sort()];
  }, [events]);

  /*
   * The leagues of the chosen sports, and ONLY of those: picking Soccer and
   * Tennis offers the soccer leagues and the tours, not all seventy. With no
   * sport chosen there is nothing sensible to put here — every league of every
   * sport is a worse list than none — so the league pill stays empty until a
   * sport is picked, which is also what the rail's pair does.
   *
   * A label can repeat across sports (both codes have a Super League), so the
   * options are de-duplicated and a chosen label matches in any selected sport.
   */
  const leagueOptions = useMemo(() => {
    const names: string[] = [];
    for (const s of sports) {
      if (!IS_MAIN_SPORT.has(s)) continue;
      for (const l of MAIN_LEAGUES[s as MainSport]) {
        // Only leagues with something on the slate: a pill full of competitions
        // that are not playing today is a list you have to read to dismiss.
        const any = events.some(
          (e) => e.sport === s && inLeague(asLeagueKey(e), l),
        );
        if (any && !names.includes(l.label)) names.push(l.label);
      }
    }
    return names;
  }, [events, sports]);

  // A league chosen under a sport that is later unchecked would filter
  // everything away invisibly, so the selection is trimmed to what is offered.
  const leagues = leagueSel.filter((l) => leagueOptions.includes(l));

  const matchesLeagues = (e: SportEvent) => {
    if (leagues.length === 0) return true;
    if (!IS_MAIN_SPORT.has(e.sport)) return false;
    return MAIN_LEAGUES[e.sport as MainSport].some(
      (l) => leagues.includes(l.label) && inLeague(asLeagueKey(e), l),
    );
  };

  const shown = useMemo(
    () =>
      events.filter(
        (e) => (sports.length === 0 || sports.includes(e.sport)) && matchesLeagues(e),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, sports, leagues.join('\u0000')],
  );

  const filtered = sports.length > 0 || leagues.length > 0;

  // Nothing to show at all is the bar's old empty case and still hides it. A
  // filter that matches nothing is NOT that: the bar has to stay so the filter
  // that emptied it can be cleared.
  if (events.length === 0) return null;



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
          *
          * Sized to very nearly fill that height rather than to be small. A
          * card is about 78px — 8px of padding each end around a badge row and
          * two team lines — and six characters at 12px with 0.3em between them
          * come to about 65, so the word runs the depth of the bar with a
          * little air top and bottom. Going further would start clipping on
          * the shorter cards, which is why it is pinned here and not nudged up
          * again later.
          */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={
            filtered
              ? `Ticker filtered to ${[sports.join(', '), leagues.join(', ')]
                  .filter(Boolean)
                  .join(' · ')} — showing ${shown.length} of ${events.length}`
              : 'Filter the ticker by sport and league'
          }
          className={`flex shrink-0 select-none items-center justify-center self-stretch border-r border-surface-border px-2 text-[12px] font-semibold uppercase leading-none tracking-[0.3em] transition [writing-mode:vertical-rl] ${
            filtered
              ? 'bg-emerald-500/10 text-emerald-300'
              : open
                ? 'bg-white/5 text-slate-200'
                : 'bg-white/[0.03] text-slate-300 hover:bg-white/10 hover:text-slate-100'
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

      {/*
        * Side by side, and the second depends on the first: choose any number
        * of sports, and the league pill then offers the leagues of those
        * sports only. The same control the rail uses for the same job — see
        * MultiPill — rather than a second dropdown that looks like it and
        * behaves slightly differently.
        */}
      {open && (
        <div className="grid grid-cols-2 gap-2 border-t border-surface-border px-2 py-2 sm:max-w-md">
          <MultiPill label="Sport" selected={sports} options={sportOptions} onChange={setSports} />
          <MultiPill
            label="League"
            selected={leagues}
            options={leagueOptions}
            onChange={setLeagueSel}
          />
        </div>
      )}
    </div>
  );
}
