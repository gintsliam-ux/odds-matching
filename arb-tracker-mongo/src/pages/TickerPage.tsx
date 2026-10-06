import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Gift, Loader2, Radio } from 'lucide-react';
import { fetchTicker, subscribeTicker, type TickerBet } from '../lib/db';
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

/**
 * Always dated, never just a time.
 *
 * It used to drop the date for anything starting today, which read as a
 * difference between the brands rather than between the fixtures: swiftbet
 * carries its own event time and often has one days out, while mybet and
 * multis only ever get a start from the mapped fixture — usually today's. The
 * same column was showing "11 Oct, 08:00" on one row and "13:00" on the next.
 */
const startLabel = (v: string | null) => {
  if (!v) return '–';
  const d = new Date(v);
  return d.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmt = (n: number | null | undefined) => (n != null ? n.toFixed(2) : '–');

/** Matches the server's own cap, so the table holds what the feed holds. */
const LIMIT = 150;

/** Stakes are money, not odds: whole dollars unless the cents matter. */
const money = (n: number | null | undefined) =>
  n == null ? '–' : `$${n.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

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
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const load = () =>
      fetchTicker()
        .then((d) => {
          if (cancelled) return;
          setBets(d.bets ?? []);
          setState('ready');
        })
        .catch(() => !cancelled && setState('error'));

    // Polling is the floor, not the plan: it covers the first paint and any
    // stretch where the stream is not up. In place, with no loading toggle, so
    // the table never flashes while someone is reading it.
    const startPolling = () => {
      if (!poll) poll = setInterval(load, 30_000);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    load();

    let opened = false;
    const unsubscribe = subscribeTicker(
      (incoming) => {
        if (cancelled) return;
        setBets((prev) => {
          // Keyed on the document id, because a bet can arrive pushed and then
          // again in a poll, and the two are the same bet.
          const seen = new Set(incoming.map((b) => b.id));
          return [...incoming, ...prev.filter((b) => !seen.has(b.id))].slice(0, LIMIT);
        });
        setState('ready');
      },
      () => {
        if (cancelled) return;
        setLive(false);
        startPolling();
      },
      () => {
        if (cancelled) return;
        setLive(true);
        stopPolling();
        // A reopen means the previous connection ended — a serverless host
        // closes it at the duration cap — so anything struck in the gap was
        // never pushed. One refetch closes it.
        if (opened) load();
        opened = true;
      },
    );

    return () => {
      cancelled = true;
      stopPolling();
      unsubscribe();
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
            <Radio
              size={15}
              className={live ? 'animate-pulse text-emerald-400' : 'text-slate-600'}
            />
            Ticker
          </span>
          <span className="text-xs text-slate-600">
            {live ? 'Live — bets appear as they are struck' : 'Latest single bets, every brand, every sport'}
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
                <th className="border-l border-surface-border px-2 py-2 text-right font-medium">
                  Stake
                </th>
                <th className="px-2 py-2 text-center font-medium">Price</th>
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
              {shown.map((b) => {
                // The bet's own price, against the best of everyone else's, so a
                // standout is visible without reading every column.
                const others = b.prices ? Object.values(b.prices) : [];
                const best = others.length ? Math.max(...others) : null;
                const beatsField = b.price != null && best != null && b.price > best;
                return (
                  <tr
                    key={b.id}
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
                    <td className="whitespace-nowrap border-l border-surface-border px-2 py-1.5 text-right tabular-nums text-slate-300">
                      <span className="inline-flex items-center justify-end gap-1">
                        {b.bonus && (
                          <span title="Bonus bet" aria-label="Bonus bet" className="flex">
                            <Gift size={11} className="shrink-0 text-amber-400" />
                          </span>
                        )}
                        {money(b.stake)}
                      </span>
                    </td>
                    <td
                      className={`px-2 py-1.5 text-center font-semibold tabular-nums ${
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
