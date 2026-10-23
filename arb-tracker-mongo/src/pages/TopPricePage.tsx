import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Trophy } from 'lucide-react';
import { fetchTopPrice, type TopPrice, type TopPriceRow } from '../lib/db';
import { brandById } from '../lib/markets';
import { BookmakerLogo } from '../components/BookmakerLogo';
import { BetsTableSkeleton } from '../components/Skeleton';
import { SignOut } from '../components/SignOut';
import { useParam } from '../lib/urlState';
import { eventSlug } from '../lib/routing';

/**
 * Every upcoming selection our own price is longer on than the whole field.
 *
 * The event page makes this comparison one fixture at a time; here it is swept
 * across everything upcoming, which is the only way to read it as a book. The
 * list is deliberately short — on a sample of 126 fixtures swiftbet was longest
 * on 8% of comparable selections and mybet on none — so these are rows to look
 * at individually, not a feed to scroll.
 */
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;

/** Decimal odds read better at the precision they were written. */
const odds = (n: number | null | undefined) =>
  n == null ? '–' : String(Math.round(n * 1000) / 1000);

const startLabel = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

/** The market id, as the grid labels it. */
const marketLabel = (m: string, line: number | null) => {
  const base = m.replace(/_/g, ' ').replace(/\b3way\b/, '3-way');
  return line == null ? base : `${base} ${line > 0 ? '+' : ''}${line}`;
};

export default function TopPricePage() {
  const [data, setData] = useState<TopPrice | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [brand, setBrand] = useParam('brand', 'all');

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTopPrice()
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setState('ready');
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : 'could not load');
          setState('error');
        });
    load();
    // Five minutes, matching the route's own cache — polling faster cannot
    // return anything newer.
    const id = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const rows = data?.rows ?? [];
  const brands = useMemo(
    () => [...new Set(rows.map((r) => r.brand))].sort(),
    [rows],
  );
  const shown = useMemo(
    () => rows.filter((r) => brand === 'all' || r.brand === brand),
    [rows, brand],
  );
  const c = data?.counts;

  return (
    <div className="flex h-dvh flex-col bg-surface text-slate-200">
      <header className="shrink-0 border-b border-surface-border">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500 transition hover:text-slate-300"
          >
            <ArrowLeft size={14} /> Board
          </Link>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-100">
              <Trophy size={16} className="text-amber-400" />
              Top Price
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Upcoming selections where our price is longer than every other book
            </p>
          </div>

          {c && (
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
              <span>
                <b className="tabular-nums text-amber-300">{c.longest}</b> longest
              </span>
              <span
                title={`Of ${c.comparable} selections where one of our brands and at least one other book price the same market, line and side. ${c.equal} are level. "Longest" means longer than the BEST of the field, not its average.`}
              >
                of <b className="tabular-nums text-slate-400">{c.comparable}</b> comparable
              </span>
              <span title={`${c.withOurs} of ${c.fixtures} upcoming fixtures carried one of our prices at all.`}>
                <b className="tabular-nums text-slate-400">{c.withOurs}</b>/{c.fixtures} fixtures
              </span>
              {state === 'loading' && <Loader2 size={13} className="animate-spin text-slate-600" />}
            </div>
          )}
          <span className="ml-auto">
            <SignOut />
          </span>
        </div>

        {brands.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border/60 px-4 py-2">
            {(['all', ...brands] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBrand(b)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  brand === b
                    ? 'bg-white/10 text-slate-100'
                    : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                }`}
              >
                {b === 'all' ? 'All' : (brandById(b)?.name ?? b)}
              </button>
            ))}
            <span className="ml-auto text-xs text-slate-600">{shown.length} shown</span>
          </div>
        )}
      </header>

      {state === 'loading' && !data && (
        <div className="min-h-0 flex-1">
          <BetsTableSkeleton rows={10} cols={8} />
          <p className="px-4 pt-3 text-xs text-slate-600">
            Comparing our two brands against the field on every upcoming fixture. The first load
            after five minutes takes a moment; after that it is instant.
          </p>
        </div>
      )}

      {state === 'error' && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
          {error ?? 'Could not load top prices.'}
        </div>
      )}

      {data && state !== 'error' && shown.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-slate-300">We are not longest on anything right now.</p>
          <p className="max-w-md text-xs text-slate-600">
            {c
              ? `${c.comparable} selections were comparable across ${c.withOurs} fixtures, and the field was at least as long on all of them.`
              : ''}
          </p>
        </div>
      )}

      {data && state !== 'error' && shown.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-raised text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-[5.5rem] px-3 py-2 text-left font-medium">Brand</th>
                <th className="w-[5rem] px-2 py-2 text-right font-medium" title="How much longer our price is than the best of the field.">
                  Longer by
                </th>
                <th className="w-[5rem] px-2 py-2 text-center font-medium">Ours</th>
                <th className="w-[7rem] px-2 py-2 text-center font-medium" title="The best price any other book offers on the same market, line and side.">
                  Field best
                </th>
                <th className="px-2 py-2 text-left font-medium">Market</th>
                <th className="px-2 py-2 text-left font-medium">Selection</th>
                <th className="px-2 py-2 text-left font-medium">Event</th>
                <th className="w-[7rem] px-2 py-2 text-left font-medium">Starts</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r: TopPriceRow, i) => {
                const mine = brandById(r.brand);
                const theirs = brandById(r.bestBook);
                return (
                  <tr
                    key={`${r.fixtureId}:${r.brand}:${r.market}:${r.selection}:${i}`}
                    className="border-t border-surface-border/60 hover:bg-white/[0.02]"
                  >
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5">
                        {mine ? <BookmakerLogo brand={mine} size={15} /> : null}
                        <span className="text-xs text-slate-400">{mine?.name ?? r.brand}</span>
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-amber-300">
                      {pct(r.edge)}
                    </td>
                    <td className="px-2 py-1.5 text-center font-semibold tabular-nums text-slate-100">
                      {odds(r.price)}
                    </td>
                    <td
                      className="px-2 py-1.5 text-center tabular-nums text-slate-400"
                      title={`${r.fieldBooks} other book${r.fieldBooks === 1 ? '' : 's'} priced this selection`}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {odds(r.best)}
                        {theirs ? (
                          <BookmakerLogo brand={theirs} size={13} />
                        ) : (
                          <span className="text-[10px] uppercase text-slate-600">{r.bestBook}</span>
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-slate-400">
                      {marketLabel(r.market, r.line)}
                    </td>
                    <td className="px-2 py-1.5 text-slate-200">{r.selection}</td>
                    <td className="px-2 py-1.5">
                      {/* Built from the slug rather than eventPath, which wants a
                          whole SportEvent — this row has an id and a name, and
                          casting one into the other would be a lie that
                          compiles. */}
                      <Link
                        to={`/event/${eventSlug(r.event)}/${encodeURIComponent(r.fixtureId)}`}
                        className="text-slate-300 underline-offset-2 transition hover:text-sky-300 hover:underline"
                      >
                        {r.event}
                      </Link>
                      <span className="ml-2 text-[11px] text-slate-600">{r.sport}</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-slate-500">
                      {startLabel(r.startsAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
