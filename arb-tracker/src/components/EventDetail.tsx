import type { SportEvent } from '../lib/types';
import { countdownFor, TONE_CLASSES } from '../lib/countdown';
import { BETFAIR, BOOKMAKERS, brandById, type MarketGroup } from '../lib/markets';
import { LeagueBadge } from './LeagueBadge';
import { BookmakerLogo } from './BookmakerLogo';
import { TeamLogo } from './TeamLogo';

// Selection + Betfair(back,lay) + Best + one column per fixed-odds book.
const TOTAL_COLS = 4 + BOOKMAKERS.length;

function metaLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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

interface Props {
  event: SportEvent;
  now: number;
  markets: MarketGroup[];
  loading: boolean;
}

export function EventDetail({ event, now, markets, loading }: Props) {
  const cd = countdownFor(event, now);
  const { home, away, homeScore, awayScore } = event;
  const hasScore = homeScore != null && awayScore != null;

  return (
    <div className="flex h-full flex-col">
      {/* Event info scoreboard — pinned, full width */}
      <div className="shrink-0 border-b border-surface-border bg-surface-raised px-4 py-2.5">
        {/* meta line */}
        <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <LeagueBadge league={event.league} size={16} />
            {event.league.name} · {event.sport}
          </span>
          <span>{metaLabel(event.startsAt)}</span>
        </div>

        {/* scoreboard */}
        <div className="flex items-center gap-3">
          {/* home */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2.5">
            <span className="truncate text-right text-base font-semibold text-slate-100">
              {home}
            </span>
            <TeamLogo name={home} size={40} />
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
              className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${TONE_CLASSES[cd.tone]}`}
            >
              {cd.pulse && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                </span>
              )}
              {cd.label}
            </div>
          </div>

          {/* away */}
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <TeamLogo name={away} size={40} />
            <span className="truncate text-base font-semibold text-slate-100">
              {away}
            </span>
          </div>
        </div>
      </div>

      {/* Markets × bookmakers price grid — scrolls under the pinned info */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          Loading odds…
        </div>
      ) : markets.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          No odds available for this event.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="h-14">
                <th className="sticky left-0 top-0 z-40 border-b border-surface-border bg-surface-raised px-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Selection
                </th>
                <th className="sticky top-0 z-30 border-b border-l border-surface-border bg-surface-raised px-2">
                  <BetfairHead label="Back" />
                </th>
                <th className="sticky top-0 z-30 border-b border-surface-border bg-surface-raised px-2">
                  <BetfairHead label="Lay" />
                </th>
                <th className="sticky top-0 z-30 border-b border-l border-surface-border bg-surface-raised px-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Best
                </th>
                {BOOKMAKERS.map((book) => (
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
            {markets.map((group) => (
              <MarketRows key={group.key} group={group} />
            ))}
          </table>
        </div>
      )}
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

function MarketRows({ group }: { group: MarketGroup }) {
  // Each market is its own <tbody> so its sticky name is bounded by the market
  // — the next market's name pushes it out and replaces it.
  return (
    <tbody>
      {/* Sticky market name — pinned below the column header until replaced. */}
      <tr>
        <td
          colSpan={TOTAL_COLS}
          className="sticky top-14 z-20 border-b border-surface-border bg-surface p-0"
        >
          <span className="sticky left-0 inline-block px-3 py-1.5 text-xs font-semibold text-slate-300">
            {group.label}
          </span>
        </td>
      </tr>
      {group.selections.map((row) => {
        const bestBrand = row.bestBookId ? brandById(row.bestBookId) : undefined;
        const cellBg = row.isMain ? 'bg-emerald-500/[0.06]' : 'bg-surface-raised';
        return (
          <tr
            key={row.key}
            className={`border-b border-surface-border/50 hover:bg-white/[0.02] ${
              row.isMain ? 'bg-emerald-500/[0.06]' : ''
            }`}
          >
            <td className={`sticky left-0 z-10 px-3 py-2 text-slate-200 ${cellBg}`}>
              <span className="flex items-center gap-2">
                {row.team && <TeamLogo name={row.team} size={18} />}
                {row.label}
                {row.isMain && row.groupStart && (
                  <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                    Pick&apos;em
                  </span>
                )}
              </span>
            </td>

            {/* Betfair back / lay */}
            <td className="border-l border-surface-border bg-sky-500/[0.06] px-2 py-2 text-center tabular-nums text-sky-200">
              {row.betfairBack != null ? fmt(row.betfairBack) : <span className="text-slate-600">–</span>}
            </td>
            <td className="bg-pink-500/[0.06] px-2 py-2 text-center tabular-nums text-pink-200">
              {row.betfairLay != null ? fmt(row.betfairLay) : <span className="text-slate-600">–</span>}
            </td>

            {/* Best price + best book's logo */}
            <td className="border-l border-surface-border px-2 py-2 text-center">
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
            {row.prices.map((cell) => {
              const isBest = cell.price != null && cell.bookId === row.bestBookId;
              return (
                <td
                  key={cell.bookId}
                  className={`border-l border-surface-border px-1.5 py-2 text-center tabular-nums ${
                    isBest
                      ? 'bg-emerald-500/10 font-semibold text-emerald-300'
                      : cell.price != null
                        ? 'text-slate-300'
                        : 'text-slate-700'
                  }`}
                >
                  {fmt(cell.price)}
                </td>
              );
            })}
          </tr>
        );
      })}
    </tbody>
  );
}
