import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Copy, Gift, Loader2, Radio } from 'lucide-react';
import { fetchTicker, subscribeTicker, type TickerBet } from '../lib/db';
import { BookmakerLogo } from '../components/BookmakerLogo';
import { brandById, BOOKMAKERS } from '../lib/markets';
import { eventSlug } from '../lib/routing';
import { BRAND_LABEL, BRAND_TONE } from '../lib/brands';

/**
 * The bet ticker: every brand's single bets, newest first, across all sports.
 *
 * One table rather than a card per bet, because the question it answers is
 * comparative — what is being backed, at what price, and what everyone else was
 * showing on the same outcome. A price only means something next to the others.
 */


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

/** Lowercase inside a title, capitalised at the start of one. */
const SMALL_WORDS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'vs', 'v', 'inc', 'by']);

/** Already an abbreviation — "MLB", "K.", "2026" — so leave it alone. */
const ALREADY_SHOUTING = /^[A-Z0-9.+\-/]{2,}$/;

const capitalise = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

const titleCase = (s: string) =>
  s
    .split(/\s+/)
    .map((w, i) => {
      if (ALREADY_SHOUTING.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      // Split on the slash too, or "half time/full time" keeps a lowercase
      // "full" in the middle of an otherwise capitalised title.
      return lower.split('/').map(capitalise).join('/');
    })
    .join(' ');

/** Words that only describe the market itself, carrying no further detail. */
const MARKET_VOCAB = /^(alternate|alt|total|totals|line|lines|over|under|handicap|spread|points?|goals?|runs?|games?|sets?)$/;

/** A segment made of nothing but market words adds nothing once shortened. */
const allMarketWords = (seg: string) =>
  seg.split(/\s+/).filter(Boolean).every((w) => MARKET_VOCAB.test(w.toLowerCase()));

/**
 * How a market reads in the table.
 *
 * Each book writes the same market its own way — "head to head", "win match
 * inc overtime" — so the common ones collapse to one short label, and the rest
 * are title-cased rather than left in whatever case they arrived in.
 *
 * Alternate markets shed their line and side, which the Outcome column already
 * carries ("Total Over 22.5 games"), but keep anything that says WHOSE market
 * it is. "Alternate Total Over - Denver Nuggets" is that team's total, not the
 * match's — a different market, priced differently, and the surface carries no
 * team totals at all, so the blank row of books only makes sense once the
 * column says which it was.
 */
function marketLabel(market: string | null): string {
  if (!market) return '–';
  const k = market.toLowerCase();
  if (k.includes('alternate')) {
    const base = k.includes('total') ? 'Alt Total' : 'Alt Line';
    const rest = market
      .split(/\s+-\s+/)
      .map((seg) => seg.trim())
      .filter((seg) => seg && !allMarketWords(seg))
      .map(titleCase);
    return [base, ...rest].join(' - ');
  }
  if (/win[- ]draw[- ]win/.test(k)) return 'W-D-W';
  if (/^(head to head|h2h|moneyline|money line|match result)$/.test(k.trim())) return 'H2H';
  if (/\bwin match inc overtime\b/.test(k)) return 'H2H';
  return titleCase(market);
}


/** Stakes are money, not odds: whole dollars unless the cents matter. */
const money = (n: number | null | undefined) =>
  n == null ? '–' : `$${n.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * Books that do not compete for "best price".
 *
 * An exchange quotes a back price that is not comparable with a bookmaker's:
 * it moves with whatever is on offer, and on a thin market it sits far above
 * every book without being a price anyone could have taken for a real stake.
 * The column still shows, it just does not win.
 */
const NOT_BEST = new Set(['betfair', 'betfair_lay']);

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

/**
 * The head of an id, with the whole thing a click away.
 *
 * Three characters is not an identifier, it is a glance — enough to see that
 * two rows are the same punter without the column carrying a UUID. The copy is
 * the part that is actually useful, so the whole chip is the button.
 */
function IdChip({ value, title }: { value: string | null; title: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      title={`${title}: ${value} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      className="group inline-flex items-center gap-0.5 rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] leading-none text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
    >
      {value.slice(0, 3)}
      {copied ? (
        <Check size={8} className="text-emerald-400" />
      ) : (
        <Copy size={8} className="opacity-0 transition group-hover:opacity-60" />
      )}
    </button>
  );
}

export default function TickerPage() {
  const [bets, setBets] = useState<TickerBet[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [brand, setBrand] = useState<'all' | 'swiftbet' | 'mybet' | 'multis'>('all');
  const [sport, setSport] = useState<string>('all');
  const [live, setLive] = useState(false);
  // Ids that arrived on the stream in the last few seconds. The table is
  // newest-first already, so without this a bet landing at the top is
  // indistinguishable from the one it pushed down.
  const [fresh, setFresh] = useState<Set<string>>(new Set());

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
        const ids = incoming.map((b) => b.id);
        setFresh((prev) => new Set([...prev, ...ids]));
        setTimeout(() => {
          if (cancelled) return;
          setFresh((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.delete(id);
            return next;
          });
        }, 6000);
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

  // The top of the feed, under whatever filters are on — so it still answers
  // "what just came through" when the view is narrowed to one brand or sport.
  const latest = shown[0] ?? null;

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

      {latest && (
        <div className="shrink-0 border-b border-surface-border bg-surface-raised/60 px-5 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Latest</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                BRAND_TONE[latest.brand] ?? 'bg-white/10 text-slate-300'
              }`}
            >
              {BRAND_LABEL[latest.brand] ?? latest.brand}
            </span>
            <span className="tabular-nums text-slate-400">{time(latest.placedAt)}</span>
            <span className="text-slate-200">{latest.event ?? '–'}</span>
            <span className="text-slate-500" title={latest.market ?? ''}>{marketLabel(latest.market)}</span>
            <span className="font-medium text-slate-100">{latest.outcome ?? '–'}</span>
            <span className="inline-flex items-center gap-1 tabular-nums text-slate-300">
              {latest.bonus && <Gift size={11} className="text-amber-400" />}
              {money(latest.stake)}
            </span>
            <span className="font-semibold tabular-nums text-emerald-300">@ {fmt(latest.price)}</span>
          </div>
        </div>
      )}

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
                // The exchange is shown but excluded from the comparison —
                // see NOT_BEST.
                const others = Object.entries(b.prices ?? {})
                  .filter(([book]) => !NOT_BEST.has(book))
                  .map(([, p]) => p);
                const best = others.length ? Math.max(...others) : null;
                const beatsField = b.price != null && best != null && b.price > best;
                return (
                  <tr
                    key={b.id}
                    // A refused bet is tinted rather than removed — it is worth
                    // seeing that the book turned it down.
                    className={`border-b border-surface-border/40 hover:bg-white/[0.02] ${
                      b.rejected
                        ? 'bg-rose-500/[0.09]'
                        : fresh.has(b.id)
                          ? 'bg-emerald-500/[0.07]'
                          : ''
                    }`}
                    title={b.rejected ? 'Rejected by the book' : undefined}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span className="inline-flex items-center gap-1">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            BRAND_TONE[b.brand] ?? 'bg-white/10 text-slate-300'
                          }`}
                        >
                          {BRAND_LABEL[b.brand] ?? b.brand}
                        </span>
                        <IdChip value={b.userId} title="User" />
                        <IdChip value={b.betId} title="Bet" />
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
                      {marketLabel(b.market)}
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
                            p != null && p === best && !NOT_BEST.has(id)
                              ? 'text-emerald-300'
                              : 'text-slate-400'
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
