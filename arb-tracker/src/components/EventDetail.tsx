import { Bell } from 'lucide-react';
import type { SportEvent } from '../lib/types';
import { countdownFor, TONE_CLASSES } from '../lib/countdown';
import { BETFAIR, BOOKMAKERS, brandById, type MarketGroup } from '../lib/markets';
import { LeagueBadge } from './LeagueBadge';
import { BookmakerLogo } from './BookmakerLogo';
import { TeamLogo } from './TeamLogo';

// Selection + Betfair(back,lay) + Best + one column per fixed-odds book.
const TOTAL_COLS = 4 + BOOKMAKERS.length;

function startLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
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
  const { home, away } = event;

  return (
    <div className="space-y-3">
      {/* Event header — the two teams + start time + info */}
      <div className="rounded-xl border border-surface-border bg-surface-raised p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <LeagueBadge league={event.league} size={40} />
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold leading-tight text-slate-100">
                <Bell size={14} className="text-slate-500" />
                <TeamLogo name={home} size={24} />
                {home}
                <span className="mx-1 text-sm font-normal text-slate-500">vs</span>
                <TeamLogo name={away} size={24} />
                {away}
              </h2>
              <p className="mt-0.5 text-sm text-slate-500">
                {event.league.name} · {event.sport} · {startLabel(event.startsAt)}
              </p>
            </div>
          </div>
          <div
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold tabular-nums ${TONE_CLASSES[cd.tone]}`}
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
      </div>

      {/* Markets × bookmakers price grid */}
      {loading ? (
        <div className="grid place-items-center rounded-xl border border-surface-border bg-surface-raised py-16 text-sm text-slate-500">
          Loading odds…
        </div>
      ) : markets.length === 0 ? (
        <div className="grid place-items-center rounded-xl border border-dashed border-surface-border bg-surface-raised/50 py-16 text-sm text-slate-500">
          No odds available for this event.
        </div>
      ) : (
      <div className="overflow-x-auto rounded-xl border border-surface-border bg-surface-raised">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-surface-border">
              <th
                rowSpan={2}
                className="sticky left-0 z-10 bg-surface-raised px-3 py-2 text-left align-bottom text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Selection
              </th>
              <th
                colSpan={2}
                className="border-l border-surface-border px-2 pt-2 text-center"
              >
                <BookmakerLogo brand={BETFAIR} />
              </th>
              <th
                rowSpan={2}
                className="border-l border-surface-border px-2 py-2 text-center align-bottom text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Best
              </th>
              {BOOKMAKERS.map((book) => (
                <th
                  key={book.id}
                  rowSpan={2}
                  className="border-l border-surface-border px-1.5 py-2 text-center align-bottom"
                >
                  <BookmakerLogo brand={book} />
                </th>
              ))}
            </tr>
            <tr className="border-b border-surface-border text-[11px] uppercase tracking-wide text-slate-500">
              <th className="border-l border-surface-border px-2 pb-1.5 text-center font-medium">
                Back
              </th>
              <th className="px-2 pb-1.5 text-center font-medium">Lay</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((group) => (
              <MarketRows key={group.key} group={group} />
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

function MarketRows({ group }: { group: MarketGroup }) {
  return (
    <>
      <tr className="border-b border-surface-border bg-surface/60">
        <td
          colSpan={TOTAL_COLS}
          className="sticky left-0 px-3 py-1.5 text-xs font-semibold text-slate-300"
        >
          {group.label}
        </td>
      </tr>
      {group.selections.map((row) => {
        const bestBrand = row.bestBookId ? brandById(row.bestBookId) : undefined;
        return (
          <tr
            key={row.key}
            className="border-b border-surface-border/60 last:border-0 hover:bg-white/[0.02]"
          >
            <td className="sticky left-0 z-10 bg-surface-raised px-3 py-2 text-slate-200">
              <span className="flex items-center gap-2">
                {row.team && <TeamLogo name={row.team} size={18} />}
                {row.label}
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
    </>
  );
}
