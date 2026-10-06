import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Radio } from 'lucide-react';
import { fetchTicker, type TickerBet } from '../lib/db';
import { BookmakerLogo } from '../components/BookmakerLogo';
import { brandById, BOOKMAKERS } from '../lib/markets';
import { eventSlug } from '../lib/routing';

/**
 * The bet ticker: every brand's single bets, newest first, across all sports.
 *
 * One table rather than a card per bet, because the question it answers is
 * comparative — what is being backed, at what price, and what everyone else was
 * showing on the same outcome. A price only means something next to the others.
 */

const BRAND_TONE: Record<string, string> = {
  swiftbet: 'bg-emerald-500/15 text-emerald-300',
  mybet: 'bg-sky-500/15 text-sky-300',
  multis: 'bg-violet-500/15 text-violet-300',
};

const BRAND_LABEL: Record<string, string> = {
  swiftbet: 'Swiftbet',
  mybet: 'Mybet',
  multis: 'Multis',
};

const time = (v: string | null) =>
  v ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–';

const startLabel = (v: string | null) => {
  if (!v) return '–';
  const d = new Date(v);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const fmt = (n: number | null | undefined) => (n != null ? n.toFixed(2) : '–');

/**
 * The book columns, in the board's own order so the eye carries across from one
 * page to the other — plus whichever others actually appear in the feed. The
 * six core brands alone dropped Betfair, FanDuel and Fanatics, which price a
 * third of these outcomes between them.
 */
function bookColumns(bets: TickerBet[]): string[] {
  const core = BOOKMAKERS.map((b) => b.id);
  const seen = new Set<string>();
  for (const b of bets) for (const k of Object.keys(b.prices ?? {})) seen.add(k);
  const extra = [...seen].filter((id) => !core.includes(id)).sort();
  return [...core, ...extra];
}

export default function TickerPage() {
  const [bets, setBets] = useState<TickerBet[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [brand, setBrand] = useState<'all' | 'swiftbet' | 'mybet' | 'multis'>('all');
  const [sport, setSport] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTicker()
        .then((d) => {
          if (cancelled) return;
          setBets(d.bets ?? []);
          setState('ready');
        })
        .catch(() => !cancelled && setState('error'));
    load();
    // The feed is the point of the page, so it refreshes itself. In place, with
    // no loading toggle, so the table never flashes while someone is reading it.
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const sports = useMemo(() => {
    const c = new Map<string, number>();
    for (const b of bets) if (b.sport) c.set(b.sport, (c.get(b.sport) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [bets]);

  const shown = useMemo(
    () =>
      bets.filter(
        (b) => (brand === 'all' || b.brand === brand) && (sport === 'all' || b.sport === sport),
      ),
    [bets, brand, sport],
  );

  const columns = useMemo(() => bookColumns(bets), [bets]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: bets.length };
    for (const b of bets) c[b.brand] = (c[b.brand] ?? 0) + 1;
    return c;
  }, [bets]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="shrink-0 border-b border-surface-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
          >
            <ArrowLeft size={12} /> Board
          </Link>
          <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-100">
            <Radio size={15} className="text-emerald-400" />
            Ticker
          </span>
          <span className="text-xs text-slate-600">
            Latest single bets, every brand, every sport
          </span>
          {state === 'loading' && <Loader2 size={13} className="animate-spin text-slate-600" />}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {(['all', 'swiftbet', 'mybet', 'multis'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBrand(b)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                brand === b
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {b === 'all' ? 'All brands' : BRAND_LABEL[b]}
              <span className="ml-1.5 tabular-nums opacity-60">{counts[b] ?? 0}</span>
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-surface-border" />
          <button
            type="button"
            onClick={() => setSport('all')}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              sport === 'all'
                ? 'bg-white/10 text-slate-100'
                : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
            }`}
          >
            All sports
          </button>
          {sports.map(([s, n]) => (
            <button
              key={s}
              type="button"
              onClick={() => setSport(s)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                sport === s
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {s}
              <span className="ml-1.5 tabular-nums opacity-60">{n}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {state === 'error' ? (
          <p className="px-5 py-8 text-sm text-rose-300">The bet feed could not be loaded.</p>
        ) : shown.length === 0 && state === 'ready' ? (
          <p className="px-5 py-8 text-sm text-slate-500">No single bets in the last few days.</p>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-surface-raised text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Brand</th>
                <th className="px-2 py-2 text-left font-medium">Time</th>
                <th className="px-2 py-2 text-left font-medium">Start</th>
                <th className="px-2 py-2 text-left font-medium">Sport</th>
                <th className="px-2 py-2 text-left font-medium">Category</th>
                <th className="px-2 py-2 text-left font-medium">Tournament</th>
                <th className="px-2 py-2 text-left font-medium">Event</th>
                <th className="px-2 py-2 text-left font-medium">Market</th>
                <th className="px-2 py-2 text-left font-medium">Outcome</th>
                <th className="border-l border-surface-border px-2 py-2 text-center font-medium">
                  Price
                </th>
                {columns.map((id) => {
                  const brandInfo = brandById(id);
                  return (
                    <th key={id} className="border-l border-surface-border px-1.5 py-2">
                      <div className="flex justify-center">
                        {brandInfo ? <BookmakerLogo brand={brandInfo} size={15} /> : id}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((b, i) => {
                // The bet's own price, against the best of everyone else's, so a
                // standout is visible without reading every column.
                const others = b.prices ? Object.values(b.prices) : [];
                const best = others.length ? Math.max(...others) : null;
                const beatsField = b.price != null && best != null && b.price > best;
                return (
                  <tr
                    key={`${b.brand}-${b.placedAt}-${i}`}
                    className="border-b border-surface-border/40 hover:bg-white/[0.02]"
                  >
                    <td className="px-3 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          BRAND_TONE[b.brand] ?? 'bg-white/10 text-slate-300'
                        }`}
                      >
                        {BRAND_LABEL[b.brand] ?? b.brand}
                      </span>
                      {b.bonus && (
                        <span className="ml-1 text-[9px] uppercase text-amber-400/80">bonus</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-300">
                      {time(b.placedAt)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-500">
                      {startLabel(b.startsAt)}
                    </td>
                    <td className="px-2 py-1.5 text-slate-400">{b.sport ?? '–'}</td>
                    <td className="px-2 py-1.5 text-slate-500">{b.category ?? '–'}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5 text-slate-400" title={b.tournament ?? ''}>
                      {b.tournament ?? '–'}
                    </td>
                    <td className="max-w-[16rem] truncate px-2 py-1.5 text-slate-200" title={b.event ?? ''}>
                      {b.fixtureId && b.event ? (
                        <Link
                          to={`/event/${eventSlug(b.event)}/${b.fixtureId}`}
                          className="hover:text-emerald-300"
                        >
                          {b.event}
                        </Link>
                      ) : (
                        b.event ?? '–'
                      )}
                    </td>
                    <td className="max-w-[10rem] truncate px-2 py-1.5 text-slate-400" title={b.market ?? ''}>
                      {b.market ?? '–'}
                    </td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5 text-slate-200" title={b.outcome ?? ''}>
                      {b.outcome ?? '–'}
                    </td>
                    <td
                      className={`border-l border-surface-border px-2 py-1.5 text-center font-semibold tabular-nums ${
                        beatsField ? 'text-amber-300' : 'text-slate-100'
                      }`}
                      title={beatsField ? 'Longer than any book we hold on this outcome' : undefined}
                    >
                      {fmt(b.price)}
                    </td>
                    {columns.map((id) => {
                      const p = b.prices?.[id] ?? null;
                      return (
                        <td
                          key={id}
                          className={`border-l border-surface-border px-1.5 py-1.5 text-center tabular-nums ${
                            p != null && p === best ? 'text-emerald-300' : 'text-slate-400'
                          }`}
                        >
                          {p != null ? fmt(p) : <span className="text-slate-700">–</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
