import { useMemo } from 'react';
import { brandById, type MarketGroup } from '../lib/markets';
import { BookmakerLogo } from './BookmakerLogo';

const MEL = 'Australia/Melbourne';

function clockAt(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-AU', {
    timeZone: MEL,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const fmt = (n: number) => n.toFixed(2);

interface Move {
  key: string;
  t: number;
  iso: string;
  bookId: string;
  selection: string;
  price: number;
  /** The price before this one; null for the opening quote. */
  prev: number | null;
}

/**
 * Every head-to-head price move, newest first, in a box that scrolls on its
 * own so the grid below keeps its place.
 *
 * Built from the grid's own cells rather than a separate fetch: each cell's
 * detail carries the row's full `flucs` series, so this is the same data the
 * hover card draws as a sparkline, laid out as a log across every book and
 * selection at once. A price that shortened reads rose, one that drifted
 * reads emerald, the same way the movers page signs them.
 */
export function H2HFlucs({ group }: { group: MarketGroup }) {
  const moves = useMemo(() => {
    const out: Move[] = [];
    for (const s of group.selections) {
      for (const cell of [...s.prices, s.betfairBack]) {
        const flucs = cell.detail?.flucs ?? [];
        flucs.forEach((f, i) => {
          out.push({
            key: `${cell.bookId}|${s.key}|${f.t}|${f.p}`,
            t: Date.parse(f.t),
            iso: f.t,
            bookId: cell.bookId,
            selection: s.label,
            price: f.p,
            prev: i > 0 ? flucs[i - 1].p : null,
          });
        });
      }
    }
    return out.sort((a, b) => b.t - a.t);
  }, [group]);

  if (moves.length === 0) return null;

  return (
    <section
      aria-label="Head to head price moves"
      className="flex max-h-52 shrink-0 flex-col border-b border-surface-border bg-surface-raised/40"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        <span>{group.label} flucs</span>
        <span className="tabular-nums text-slate-600">{moves.length}</span>
      </header>
      <div className="min-h-0 overflow-y-auto">
        <table className="w-full text-xs tabular-nums">
          <tbody>
            {moves.map((m) => {
              const brand = brandById(m.bookId);
              const delta = m.prev == null ? null : m.price - m.prev;
              const tone =
                delta == null || delta === 0
                  ? 'text-slate-400'
                  : delta < 0
                    ? 'text-rose-300'
                    : 'text-emerald-300';
              return (
                <tr key={m.key} className="border-t border-surface-border/40">
                  <td className="w-20 px-3 py-1 text-slate-500">{clockAt(m.iso)}</td>
                  <td className="w-28 px-2 py-1">
                    <span className="flex items-center gap-1.5 text-slate-300">
                      {brand ? <BookmakerLogo brand={brand} size={14} /> : null}
                      <span className="truncate">{brand?.name ?? m.bookId}</span>
                    </span>
                  </td>
                  <td className="px-2 py-1 text-slate-200">{m.selection}</td>
                  <td className="w-16 px-2 py-1 text-right text-slate-500">
                    {m.prev == null ? 'open' : fmt(m.prev)}
                  </td>
                  <td className={`w-16 px-3 py-1 text-right font-semibold ${tone}`}>{fmt(m.price)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
