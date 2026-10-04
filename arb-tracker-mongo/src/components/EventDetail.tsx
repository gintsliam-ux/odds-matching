import { useState, useMemo } from 'react';
import type { SportEvent } from '../lib/types';
import { countdownFor, effectiveStatus, PERIOD_PREFIX, TONE_CLASSES } from '../lib/countdown';
import {
  BETFAIR,
  brandById,
  bookMargins,
  isSuspended,
  type Bookmaker,
  type MarketGroup,
  type MarketKind,
  type PriceCell,
  type PriceDetail,
} from '../lib/markets';
import { LeagueBadge } from './LeagueBadge';
import { BookmakerLogo } from './BookmakerLogo';
import { TeamLogo } from './TeamLogo';
import { PriceCard, type HoverTarget } from './PriceCard';
import { MarketsSkeleton } from './Skeleton';
import { DrawIcon } from './DrawIcon';
import { EventTabs, SubTabs, type EventTab, type SubTab } from './EventTabs';
import { EventDetailsPanel } from './EventDetailsPanel';
import { BetsPanel } from './BetsPanel';
import { useCapabilities } from '../lib/capabilitiesContext';

// Selection + Best (+ Betfair back/lay for two-sided events), then one column
// per fixed-odds book. Golf outrights have no exchange, so those two drop out.
const FIXED_COLS_MATCH = 4;
const FIXED_COLS_OUTRIGHT = 2;

function metaLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dayShort(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** "Thu 6 Aug – Sun 9 Aug" for a multi-day event. */
function dateRangeLabel(startsAt: string, endsAt?: string): string {
  return endsAt ? `${dayShort(startsAt)} – ${dayShort(endsAt)}` : dayShort(startsAt);
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmt(n: number | null): string {
  return n != null ? n.toFixed(2) : '–';
}

type HoverFn = (t: HoverTarget | null) => void;

// A pulled market keeps its last price on screen, tinted red so it's obvious
// the number isn't live. Overrides the column's own tint and the best-price
// highlight — "you can't take this" outranks "this is the top price". The
// strike is deliberate: red alone would lean on colour, and the Betfair lay
// column is already pink-tinted right beside it.
const SUSPENDED_TONE = 'bg-rose-500/15 text-rose-200 line-through decoration-rose-300/60';

// The pick'em highlight, as a gradient *over* an opaque surface. A translucent
// bg-colour alone can't sit on the sticky Selection cell — the scrolling price
// columns would show through it; this keeps the cell opaque and just tints it.
const PICKEM_TINT = 'bg-[linear-gradient(rgba(16,185,129,0.06),rgba(16,185,129,0.06))]';

/**
 * Cell props that raise the price's history on hover and keyboard focus. The
 * whole cell is the hit target, not just the digits.
 */
function hoverProps(
  detail: PriceDetail | null | undefined,
  title: string,
  column: string,
  onHover: HoverFn,
) {
  if (!detail) return {};
  const show = (el: HTMLTableCellElement) =>
    onHover({ detail, title, column, rect: el.getBoundingClientRect() });
  return {
    tabIndex: 0,
    // The cell lifts on hover so the reader sees it respond to the pointer.
    className: 'cursor-help transition-colors hover:bg-white/[0.07]',
    onMouseEnter: (e: React.MouseEvent<HTMLTableCellElement>) => show(e.currentTarget),
    // Don't yank the card out from under a cell the keyboard still holds.
    onMouseLeave: (e: React.MouseEvent<HTMLTableCellElement>) => {
      if (document.activeElement !== e.currentTarget) onHover(null);
    },
    onFocus: (e: React.FocusEvent<HTMLTableCellElement>) => show(e.currentTarget),
    onBlur: () => onHover(null),
  };
}

/** Merge the hover handlers' className with the cell's own. */
function withHover(
  base: string,
  props: ReturnType<typeof hoverProps>,
): React.HTMLAttributes<HTMLTableCellElement> & { tabIndex?: number } {
  const { className, ...rest } = props as { className?: string };
  return { ...rest, className: `${base} ${className ?? ''}` };
}

function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * The Markets sub-tabs. Every market the grid can build has a `kind`, so the
 * buckets are derived from the data rather than a second list to keep in sync —
 * a new market definition lands in the right pill automatically. Half/quarter
 * variants ride with their parent: a 1st-half line is still a handicap.
 */
const MARKET_GROUPS: { key: string; label: string; kinds: MarketKind[] }[] = [
  { key: 'all', label: 'All', kinds: ['h2h', 'spread', 'total', 'flat', 'outright'] },
  { key: 'moneyline', label: 'Moneyline', kinds: ['h2h'] },
  { key: 'handicap', label: 'Handicap', kinds: ['spread'] },
  { key: 'totals', label: 'Totals', kinds: ['total'] },
  { key: 'specials', label: 'Specials', kinds: ['flat'] },
  { key: 'outright', label: 'Outright', kinds: ['outright'] },
];

const isBaseball = (sport: string) => sport === 'Baseball';

/** Period abbreviation per sport (Q quarters, H halves, S sets, R rounds). */
function periodPrefix(sport: string): string {
  return PERIOD_PREFIX[sport] ?? 'P';
}

/** Short label for a completed/current period: "Q3", "6th" for innings. */
function periodLabel(sport: string, period: number): string {
  return isBaseball(sport) ? ordinal(period) : `${periodPrefix(sport)}${period}`;
}

/**
 * The live badge text. Baseball's `clock` is the half-inning ("Top"/"Bot")
 * rather than a countdown, so it reads ahead of the inning.
 */
function liveLabel(
  sport: string,
  period: number | null | undefined,
  clock: string | null | undefined,
): string {
  if (period == null) return 'LIVE';
  if (isBaseball(sport)) return `${clock ? `${clock} ` : ''}${ordinal(period)}`;
  return `${periodLabel(sport, period)}${clock ? ` ${clock}` : ''}`;
}

interface Props {
  event: SportEvent;
  now: number;
  markets: MarketGroup[];
  /** Book columns in display order — computed per event by buildMarkets. */
  books: Bookmaker[];
  loading: boolean;
}

export function EventDetail({ event, now, markets, books, loading }: Props) {
  const cd = countdownFor(event, now);
  const { home, away, homeScore, awayScore, periodScores } = event;
  const status = effectiveStatus(event, now);
  const hasScore = homeScore != null && awayScore != null;
  const outright = !!event.outright;
  const showExchange = !outright;
  const totalCols = (outright ? FIXED_COLS_OUTRIGHT : FIXED_COLS_MATCH) + books.length;
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [tab, setTab] = useState<EventTab>('markets');
  const [marketGroup, setMarketGroup] = useState('all');
  const [shownId, setShownId] = useState(event.id);
  // A deployed instance reads the public odds surface, which publishes no bets
  // and no mapping tables. Those tabs are dropped rather than shown empty.
  const caps = useCapabilities();

  // Every event opens on Markets. Adjusting state during render (rather than in
  // an effect) is React's own idiom for resetting on a prop change: it re-runs
  // the component before anything is committed, so the new event never paints
  // for a frame under the previous event's tab.
  if (shownId !== event.id) {
    setShownId(event.id);
    setTab('markets');
    // A stale hover card describes a price that is no longer on screen.
    setHover(null);
  }

  // Only offer a bucket this event actually prices, so no pill is ever a dead
  // end. "All" survives on its own; the rest appear as the markets do.
  const groupTabs: SubTab<string>[] = MARKET_GROUPS.flatMap((g) => {
    const n = markets.filter((m) => g.kinds.includes(m.kind)).length;
    return n === 0 ? [] : [{ key: g.key, label: g.label, badge: n }];
  });
  // A pill that disappears (the event's markets changed under a poll) must not
  // leave an empty grid selected.
  const activeGroup = groupTabs.some((g) => g.key === marketGroup) ? marketGroup : 'all';
  const activeKinds =
    MARKET_GROUPS.find((g) => g.key === activeGroup)?.kinds ?? MARKET_GROUPS[0].kinds;
  const shownMarkets = markets.filter((m) => activeKinds.includes(m.kind));
  // Selection labels carry a competitor name; map it back to its flag.
  const countryFor = (team: string) =>
    team === home ? event.homeCountry : team === away ? event.awayCountry : null;
  const logoFor = (team: string) =>
    team === home ? event.homeLogo : team === away ? event.awayLogo : null;
  const clockText = liveLabel(event.sport, event.period, event.clock);

  return (
    <div className="flex h-full flex-col">
      {/* Event info scoreboard — pinned, full width */}
      <div className="shrink-0 border-b border-surface-border bg-surface-raised px-4 py-2.5">
        {/* meta line */}
        <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <LeagueBadge league={event.league} size={16} />
            {/* category · competition · stage — e.g. "ATP · Cincinnati ·
                Quarterfinals"; falls back to the sport for a second segment. */}
            {(() => {
              const parts = [event.league.category, event.league.name, event.subtitle].filter(
                Boolean,
              ) as string[];
              if (parts.length === 1) parts.push(event.sport);
              return parts.join(' · ');
            })()}
          </span>
          <span>
            {outright ? dateRangeLabel(event.startsAt, event.endsAt) : metaLabel(event.startsAt)}
          </span>
        </div>

        {/* scoreboard — golf is a single tournament header, not a two-sided match */}
        {outright ? (
          <div className="flex flex-col items-center gap-1 py-1">
            <div className="flex min-w-0 items-center gap-2.5">
              <LeagueBadge league={event.league} size={28} />
              <span className="truncate text-lg font-semibold text-slate-100">{event.name}</span>
            </div>
            {/* live round indicator */}
            {(status === 'live' || event.round) && (
              <div className="flex items-center justify-center text-xs">
                {status === 'live' ? (
                  <span
                    className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 font-semibold ${TONE_CLASSES.live}`}
                  >
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                    </span>
                    {event.round ?? 'Live'}
                  </span>
                ) : (
                  <span className="text-slate-400">{event.round}</span>
                )}
              </div>
            )}
          </div>
        ) : (
        <div className="flex items-center gap-3">
          {/* home */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2.5">
            <span className="truncate text-right text-base font-semibold text-slate-100">
              {home}
            </span>
            <TeamLogo name={home} size={40} country={event.homeCountry} logo={event.homeLogo} />
          </div>

          {/* score / status */}
          <div className="flex shrink-0 flex-col items-center gap-1">
            {hasScore ? (
              <div className="flex items-baseline gap-2 text-3xl font-bold tabular-nums text-slate-100">
                <span>{homeScore}</span>
                <span className="text-lg text-slate-600">–</span>
                <span>{awayScore}</span>
              </div>
            ) : (
              <div className="text-xl font-semibold tabular-nums text-slate-300">
                {timeLabel(event.startsAt)}
              </div>
            )}
            <div
              className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${
                status === 'live' ? TONE_CLASSES.live : TONE_CLASSES[cd.tone]
              }`}
            >
              {(status === 'live' || cd.pulse) && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                </span>
              )}
              {status === 'live' ? clockText : cd.label}
            </div>
          </div>

          {/* away */}
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <TeamLogo name={away} size={40} country={event.awayCountry} logo={event.awayLogo} />
            <span className="truncate text-base font-semibold text-slate-100">
              {away}
            </span>
          </div>
        </div>
        )}

        {/* per-period breakdown — only once it adds info beyond the total */}
        {periodScores && periodScores.length > 1 && (
          <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            {periodScores.map((ps) => (
              <span key={ps.period} className="tabular-nums">
                {periodLabel(event.sport, ps.period)}{' '}
                <span className="text-slate-300">
                  {ps.home}-{ps.away}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      <EventTabs
        tabs={[
          { key: 'markets' as const, label: 'Markets', badge: markets.length || null },
          ...(caps.bets ? [{ key: 'bets' as const, label: 'Bets' }] : []),
          ...(caps.mapping ? [{ key: 'details' as const, label: 'Details' }] : []),
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'bets' && (
        <div
          role="tabpanel"
          id="panel-bets"
          aria-labelledby="tab-bets"
          className="flex min-h-0 flex-1 flex-col"
        >
          <BetsPanel fixtureId={event.id} />
        </div>
      )}

      {tab === 'details' && (
        <div
          role="tabpanel"
          id="panel-details"
          aria-labelledby="tab-details"
          className="flex min-h-0 flex-1 flex-col"
        >
          <EventDetailsPanel fixtureId={event.id} />
        </div>
      )}

      {/* Markets × bookmakers price grid — scrolls under the pinned info */}
      {tab === 'markets' && (
        <SubTabs
          label="Market types"
          tabs={groupTabs}
          active={activeGroup}
          onChange={setMarketGroup}
        />
      )}
      {tab === 'markets' && (status === 'cancelled' ? (
        <div className="flex flex-1 items-center justify-center text-sm text-rose-300">
          This fixture was cancelled.
        </div>
      ) : loading ? (
        <MarketsSkeleton />
      ) : shownMarkets.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          No odds available for this event.
        </div>
      ) : (
        // Scrolling detaches the card from the cell it describes, so drop it.
        <div className="min-h-0 flex-1 overflow-auto" onScroll={() => setHover(null)}>
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="h-14">
                <th className="sticky left-0 top-0 z-40 border-b border-surface-border bg-surface-raised px-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Selection
                </th>
                {showExchange && (
                  <>
                    <th className="sticky top-0 z-30 border-b border-l border-surface-border bg-surface-raised px-2">
                      <BetfairHead label="Back" />
                    </th>
                    <th className="sticky top-0 z-30 border-b border-surface-border bg-surface-raised px-2">
                      <BetfairHead label="Lay" />
                    </th>
                  </>
                )}
                <th className="sticky top-0 z-30 border-b border-l border-surface-border bg-surface-raised px-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Best
                </th>
                {books.map((book) => (
                  <th
                    key={book.id}
                    className="sticky top-0 z-30 border-b border-l border-surface-border bg-surface-raised px-1.5"
                  >
                    <div className="flex justify-center">
                      <BookmakerLogo brand={book} />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            {shownMarkets.map((group) => (
              <MarketRows
                key={group.key}
                group={group}
                totalCols={totalCols}
                showExchange={showExchange}
                onHover={setHover}
                countryFor={countryFor}
                logoFor={logoFor}
                sport={event.sport}
              />
            ))}
          </table>
        </div>
      ))}

      {hover && <PriceCard target={hover} now={now} />}
    </div>
  );
}

function BetfairHead({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <BookmakerLogo brand={BETFAIR} size={18} />
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

/** Rows that name no competitor because neither side wins it. */
const DRAW_LABEL = /^(draw|tie|tied)$/i;

function MarketRows({
  group,
  totalCols,
  showExchange,
  onHover,
  countryFor,
  logoFor,
  sport,
}: {
  group: MarketGroup;
  totalCols: number;
  showExchange: boolean;
  onHover: HoverFn;
  countryFor: (team: string) => string | null | undefined;
  logoFor: (team: string) => string | null | undefined;
  /** Display sport, for the draw row's stand-in icon. */
  sport: string;
}) {
  // Each market is its own <tbody> so its sticky name is bounded by the market
  // — the next market's name pushes it out and replaces it.
  return (
    <tbody>
      {/* Sticky market name — pinned below the column header until replaced. */}
      <tr>
        <td
          colSpan={totalCols}
          className="sticky top-14 z-20 border-b border-surface-border bg-surface p-0"
        >
          <span className="sticky left-0 inline-block px-3 py-1.5 text-xs font-semibold text-slate-300">
            {group.label}
          </span>
        </td>
      </tr>
      {group.selections.map((row) => {
        const bestBrand = row.bestBookId ? brandById(row.bestBookId) : undefined;
        // The sticky Selection cell has to be opaque, or the price columns show
        // through it as they scroll underneath. So the pick'em tint is painted
        // as a background-image layer over the solid surface colour rather than
        // as a translucent background-colour on its own.
        const cellBg = row.isMain
          ? `bg-surface-raised ${PICKEM_TINT}`
          : 'bg-surface-raised';
        return (
          <tr
            key={row.key}
            className={`border-b border-surface-border/50 hover:bg-white/[0.02] ${
              row.isMain ? 'bg-emerald-500/[0.06]' : ''
            }`}
          >
            <td className={`sticky left-0 z-10 px-3 py-2 text-slate-200 ${cellBg}`}>
              <span className="flex items-center gap-2">
                {row.team ? (
                  <TeamLogo name={row.team} size={18} country={countryFor(row.team)} logo={logoFor(row.team)} />
                ) : DRAW_LABEL.test(row.label) ? (
                  // No competitor to crest — the sport's own object stands in.
                  <DrawIcon sport={sport} size={18} />
                ) : null}
                {row.label}
              </span>
            </td>

            {/* Betfair back / lay — omitted for outrights (no exchange). */}
            {showExchange && (
              <>
                <td
                  {...withHover(
                    `border-l border-surface-border px-2 py-2 text-center tabular-nums ${
                      isSuspended(row.betfairBack) ? SUSPENDED_TONE : 'bg-sky-500/[0.06] text-sky-200'
                    }`,
                    hoverProps(row.betfairBack.detail, row.label, 'Betfair back', onHover),
                  )}
                >
                  {row.betfairBack.price != null ? (
                    fmt(row.betfairBack.price)
                  ) : (
                    <span className="text-slate-600">–</span>
                  )}
                </td>
                <td
                  {...withHover(
                    `px-2 py-2 text-center tabular-nums ${
                      isSuspended(row.betfairLay) ? SUSPENDED_TONE : 'bg-pink-500/[0.06] text-pink-200'
                    }`,
                    hoverProps(row.betfairLay.detail, row.label, 'Betfair lay', onHover),
                  )}
                >
                  {row.betfairLay.price != null ? (
                    fmt(row.betfairLay.price)
                  ) : (
                    <span className="text-slate-600">–</span>
                  )}
                </td>
              </>
            )}

            {/* Best price + best book's logo */}
            <td
              {...withHover(
                'border-l border-surface-border px-2 py-2 text-center',
                hoverProps(
                  row.bestDetail,
                  row.label,
                  bestBrand ? `Best · ${bestBrand.name}` : 'Best',
                  onHover,
                ),
              )}
            >
              {row.bestPrice != null && bestBrand ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-0.5">
                  <BookmakerLogo brand={bestBrand} size={16} />
                  <span className="font-semibold tabular-nums text-emerald-300">
                    {fmt(row.bestPrice)}
                  </span>
                </span>
              ) : (
                <span className="text-slate-600">–</span>
              )}
            </td>

            {/* Fixed-odds books */}
            {row.prices.map((cell: PriceCell) => {
              const isBest = cell.price != null && cell.bookId === row.bestBookId;
              const brand = brandById(cell.bookId);
              return (
                <td
                  key={cell.bookId}
                  {...withHover(
                    `border-l border-surface-border px-1.5 py-2 text-center tabular-nums ${
                      isSuspended(cell)
                        ? SUSPENDED_TONE
                        : isBest
                          ? 'bg-emerald-500/10 font-semibold text-emerald-300'
                          : cell.price != null
                            ? 'text-slate-300'
                            : 'text-slate-700'
                    }`,
                    hoverProps(cell.detail, row.label, brand?.name ?? cell.bookId, onHover),
                  )}
                >
                  {fmt(cell.price)}
                </td>
              );
            })}
          </tr>
        );
      })}
      {group.kind === 'h2h' && <MarginRow group={group} showExchange={showExchange} />}
    </tbody>
  );
}

/**
 * Each book's over-round across this market's outcomes.
 *
 * Only for head-to-head: a spread or totals group holds many lines, so summing
 * it would add up unrelated markets rather than one book's take on a single
 * one. A book that is not pricing every outcome gets a dash rather than a
 * number — see bookMargins.
 */
function MarginRow({ group, showExchange }: { group: MarketGroup; showExchange: boolean }) {
  const margins = useMemo(() => bookMargins(group), [group]);
  const values = [...margins.books.values()].filter((v): v is number => v != null);
  if (values.length === 0 && margins.best == null) return null;
  // The sharpest complete book on this market, highlighted the way the best
  // price is — lowest margin, not lowest price.
  const sharpest = values.length ? Math.min(...values) : null;
  const bookIds = group.selections[0]?.prices.map((c) => c.bookId) ?? [];

  const cell = (v: number | null, extra = '') => (
    <span
      className={
        v == null
          ? 'text-slate-700'
          : v < 100
            // Under 100 across the field is an arb, not a tight margin — it is
            // the one number on this row worth interrupting someone for.
            ? 'font-semibold text-amber-300'
            : v === sharpest
              ? 'font-semibold text-emerald-300'
              : `text-slate-400 ${extra}`
      }
    >
      {v == null ? '–' : v.toFixed(1)}
    </span>
  );
  const title = (v: number | null) =>
    v == null
      ? 'Not every outcome is priced here'
      : v < 100
        ? `${v.toFixed(2)}% — under 100, every outcome can be backed for a guaranteed profit`
        : `${v.toFixed(2)}% over-round`;

  return (
    <tr className="border-b border-surface-border bg-surface-raised/40">
      <td className="sticky left-0 z-10 bg-surface-raised px-3 py-1.5 text-[11px] font-medium text-slate-400">
        Market %
      </td>
      {showExchange && (
        <>
          <td
            className="border-l border-surface-border px-2 py-1.5 text-center text-[11px] tabular-nums"
            title={title(margins.betfairBack)}
          >
            {cell(margins.betfairBack)}
          </td>
          {/* Lay is left blank: the sum of lay prices is not a margin the
              backer pays, so a number here would invite the wrong comparison. */}
          <td />
        </>
      )}
      <td
        className="border-l border-surface-border px-2 py-1.5 text-center text-[11px] font-semibold tabular-nums"
        title={title(margins.best)}
      >
        {cell(margins.best)}
      </td>
      {bookIds.map((id) => {
        const v = margins.books.get(id) ?? null;
        return (
          <td
            key={id}
            className="border-l border-surface-border px-1.5 py-1.5 text-center text-[11px] tabular-nums"
            title={title(v)}
          >
            {cell(v)}
          </td>
        );
      })}
    </tr>
  );
}
