import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Copy, Gift, Loader2, Radio } from 'lucide-react';
import { fetchTicker, subscribeTicker, type TickerBet } from '../lib/db';
import { useAuth } from '../lib/useAuth';
import { BookmakerLogo } from '../components/BookmakerLogo';
import { brandById, BOOKMAKERS } from '../lib/markets';
import { eventSlug } from '../lib/routing';
import { BRAND_LABEL, BRAND_TONE } from '../lib/brands';
import { marketLabel } from '../lib/marketLabel';
import { bookmakerUrl } from '../lib/bookmakerUrl';

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
/** Must match LIMIT in server/lib/ticker.mjs, or a pushed bet trims the
 *  fetched feed back down to this. */
const LIMIT = 200;

/**
 * How long ago, short enough to sit in a header.
 *
 * "never" rather than a dash when it has not happened: on a quiet night the
 * stream can be perfectly healthy with nothing yet pushed, and that is worth
 * saying plainly rather than leaving blank for the reader to interpret.
 */
function ago(at: number | null): string {
  if (at == null) return 'never';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
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
 * The bet's price against the best anyone else is showing.
 *
 * `out` means we were over the odds: the customer took a price no other book
 * was offering. That is the whole of what a trading desk wants off this feed,
 * and the one thing the columns make you read across the row to see — so it is
 * computed once here and used both to tint the cell and to filter the page.
 *
 * The exchange is shown but excluded from the comparison; see NOT_BEST. `best`
 * is null when nobody else priced the selection, and a row with nothing to
 * compare against is NOT out of line — it is unjudged, which is a different
 * thing and must not be filtered in as though it were evidence.
 */
function priceStandout(b: TickerBet): { best: number | null; out: boolean; byPct: number } {
  const others = Object.entries(b.prices ?? {})
    .filter(([book]) => !NOT_BEST.has(book))
    .map(([, p]) => p);
  const best = others.length ? Math.max(...others) : null;
  const out = b.price != null && best != null && b.price > best;
  return { best, out, byPct: out && best ? (b.price! / best - 1) * 100 : 0 };
}

/**
 * How far over the odds is worth looking at. Measured across a live feed: of
 * 200 bets, 140 had something to compare against and 21 were out — a median of
 * 4.9% over, the worst 18.3% ($1,500 at 1.76 against a field best of 1.488).
 */
const OUT_MARGINS = [0, 2, 5];

/** Out of line by at least `margin` percent of the odds. */
function overTheOdds(b: TickerBet, margin: number): boolean {
  const { out, byPct } = priceStandout(b);
  return out && byPct >= margin;
}

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

/**
 * The book's own risk tag on this bettor, beside their id.
 *
 * Several are common on the swiftbet side ("Good client|Tier 4"), so the first
 * one shows and the rest are counted, with all of them on hover. The ones that
 * mean trouble get a colour; everything else stays quiet, because most rows
 * carry a tag and a table where every row shouts says nothing.
 */
const LOUD = /monitor|sharp|bonus hunter|barring|arb|bowler|not eligible|duplicate|test account/i;

function TagChip({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  const [first, ...rest] = tags;
  const loud = tags.some((t) => LOUD.test(t));
  return (
    <span
      title={tags.join(' · ')}
      className={`inline-flex max-w-[7rem] items-center gap-0.5 truncate rounded px-1 py-0.5 text-[9px] leading-none ${
        loud ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-slate-500'
      }`}
    >
      <span className="truncate">{first}</span>
      {rest.length > 0 && <span className="opacity-60">+{rest.length}</span>}
    </span>
  );
}

/**
 * Stake thresholds for the filter.
 *
 * Taken from the real spread over a 3-day window rather than round numbers for
 * their own sake: median stake $71, p75 $240, p90 $676, p99 $6,148. So $100 is
 * roughly the halfway mark, $500 is the top sixth and $1,000 the top twelfth.
 *
 * Filtered HERE and not in the query, which is the one design choice in this.
 * Bets also arrive on a change stream, and a server-side filter would govern
 * the fetched batch while every pushed bet walked straight past it. Doing it on
 * the client covers both paths with one rule, needs no second cache key per
 * threshold, and costs nothing on 200 rows. It only works because the stakes
 * are not long-tailed: at $1,000 there are still ~16 rows of 200 to look at.
 */
const STAKES = [0, 100, 500, 1000];

export default function TickerPage() {
  const { user } = useAuth();
  const [bets, setBets] = useState<TickerBet[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [brand, setBrand] = useState<'all' | 'swiftbet' | 'mybet' | 'multis'>('all');
  const [sport, setSport] = useState<string>('all');
  const [minStake, setMinStake] = useState(0);
  /*
   * A trading account sees only the bets we were over the odds on — that is
   * what the feed is for from that desk. Forced rather than defaulted, so it
   * cannot be switched off and leave someone reading the whole feed believing
   * they are reading the exceptions.
   */
  const tradingOnlyOut = user?.role === 'trading';
  const [outOnly, setOutOnly] = useState(false);
  const [outMargin, setOutMargin] = useState(0);
  const onlyOut = tradingOnlyOut || outOnly;
  const [live, setLive] = useState(false);
  // Ids that arrived on the stream in the last few seconds. The table is
  // newest-first already, so without this a bet landing at the top is
  // indistinguishable from the one it pushed down.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // When the feed last did each of its two things. Worth showing side by side:
  // a long gap since a push is normal on a quiet night, but a long gap while
  // bets are visibly arriving means the stream has gone and nobody noticed.
  const [lastPush, setLastPush] = useState<number | null>(null);
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  // Re-renders the two relative times once a second. Nothing else depends on
  // it, so it costs one render of the header row.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const load = () =>
      fetchTicker()
        .then((d) => {
          if (cancelled) return;
          setBets(d.bets ?? []);
          setLastPoll(Date.now());
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
        setLastPush(Date.now());
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
        (b) =>
          (brand === 'all' || b.brand === brand) &&
          (sport === 'all' || b.sport === sport) &&
          // A missing stake is not a small stake — it fails the filter rather
          // than being counted as zero and silently dropped at every threshold.
          (minStake === 0 || (typeof b.stake === 'number' && b.stake >= minStake)) &&
          (!onlyOut || overTheOdds(b, outMargin)),
      ),
    [bets, brand, sport, minStake, onlyOut, outMargin],
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

  // What each threshold would leave, under the brand and sport filters already
  // on — a chip that promises 16 rows and delivers 2 is worse than no count.
  const stakeCounts = useMemo(() => {
    const base = bets.filter(
      (b) => (brand === 'all' || b.brand === brand) && (sport === 'all' || b.sport === sport),
    );
    return STAKES.map(
      (t) => base.filter((b) => t === 0 || (typeof b.stake === 'number' && b.stake >= t)).length,
    );
  }, [bets, brand, sport]);

  // How many are out of line at each margin, and how many could be judged at
  // all — the second number is what stops the first being read as a rate.
  const outCounts = useMemo(() => {
    const base = bets.filter(
      (b) => (brand === 'all' || b.brand === brand) && (sport === 'all' || b.sport === sport),
    );
    return {
      comparable: base.filter((b) => priceStandout(b).best != null).length,
      byMargin: OUT_MARGINS.map((m) => base.filter((b) => overTheOdds(b, m)).length),
    };
  }, [bets, brand, sport]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="shrink-0 border-b border-surface-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            // A trading account cannot open the board, so do not offer it one.
            to={user?.role === 'trading' ? '/search' : '/'}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
          >
            <ArrowLeft size={12} /> {user?.role === 'trading' ? 'Prices' : 'Board'}
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
          {/*
            * Both times, but labelled by what is actually carrying the feed.
            *
            * The first paint is a FETCH, not a push, so the rows on screen are
            * always the fetch's until something is struck — and once the stream
            * connects the 30s poll is stopped on purpose, so its timestamp just
            * ages. Calling that "polled 1h ago" reads as broken when it is the
            * healthy state. While the stream is up it is the load; only when
            * the stream is down is polling the thing keeping the table current.
            */}
          <span className="flex items-center gap-2 text-[11px] tabular-nums text-slate-600">
            <span title={lastPush ? new Date(lastPush).toLocaleString() : 'no bet struck since this page opened'}>
              pushed <span className="text-slate-400">{ago(lastPush)}</span>
            </span>
            <span className="text-slate-700">·</span>
            <span
              title={
                lastPoll
                  ? `${new Date(lastPoll).toLocaleString()}${live ? ' — polling is off while the stream is up' : ''}`
                  : 'not fetched yet'
              }
            >
              {live ? 'loaded' : 'polled'} <span className="text-slate-400">{ago(lastPoll)}</span>
            </span>
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
          <span className="mx-1 h-4 w-px bg-surface-border" />
          {/* Over the odds: we were the only book showing that price. */}
          <button
            type="button"
            onClick={() => !tradingOnlyOut && setOutOnly((v) => !v)}
            disabled={tradingOnlyOut}
            title={
              tradingOnlyOut
                ? 'Your account shows only the bets we were over the odds on.'
                : 'Only bets struck at a price no other book was showing. Betfair is excluded from the comparison.'
            }
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              onlyOut
                ? 'bg-rose-500/15 text-rose-300'
                : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
            } ${tradingOnlyOut ? 'cursor-default' : ''}`}
          >
            Over the odds
            <span className="ml-1.5 tabular-nums opacity-60">{outCounts.byMargin[0]}</span>
          </button>
          {onlyOut && (
            <>
              {OUT_MARGINS.map((m, i) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setOutMargin(m)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium tabular-nums transition ${
                    outMargin === m
                      ? 'bg-white/10 text-slate-100'
                      : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                  }`}
                >
                  {m === 0 ? 'any' : `≥${m}%`}
                  <span className="ml-1 tabular-nums opacity-60">{outCounts.byMargin[i]}</span>
                </button>
              ))}
              <span
                className="text-[11px] text-slate-600"
                title="Bets with at least one other book priced on the same selection. The rest cannot be judged either way."
              >
                of {outCounts.comparable} comparable
              </span>
            </>
          )}
          <span className="mx-1 h-4 w-px bg-surface-border" />
          <span className="text-[11px] text-slate-600" title="Stake on the bet, before any bonus">
            stake ≥
          </span>
          {STAKES.map((t, i) => (
            <button
              key={t}
              type="button"
              onClick={() => setMinStake(t)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium tabular-nums transition ${
                minStake === t
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {t === 0 ? 'Any' : money(t)}
              <span className="ml-1.5 tabular-nums opacity-60">{stakeCounts[i]}</span>
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
                const { best, out: beatsField } = priceStandout(b);
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
                        {(() => {
                          // The badge opens the book's own page for this event
                          // where we can build the URL, and is inert where we
                          // cannot — see bookmakerUrl.
                          const href = bookmakerUrl(b.brand, b.sport, b.eventId);
                          const tone = `rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            BRAND_TONE[b.brand] ?? 'bg-white/10 text-slate-300'
                          }`;
                          const label = BRAND_LABEL[b.brand] ?? b.brand;
                          return href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title={`Open on ${label}`}
                              className={`${tone} transition hover:brightness-125`}
                            >
                              {label}
                            </a>
                          ) : (
                            <span className={tone}>{label}</span>
                          );
                        })()}
                        <IdChip value={b.userId} title="User" />
                        <TagChip tags={b.tags ?? []} />
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
