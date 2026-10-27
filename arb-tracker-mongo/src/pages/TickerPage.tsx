import { useEffect, useMemo, useState } from 'react';
import { BetsTableSkeleton } from '../components/Skeleton';
import { useNumParam, useParam } from '../lib/urlState';
import { SignOut } from '../components/SignOut';
import { Link } from 'react-router-dom';
import { ArrowLeft, Gift, Loader2, Radio } from 'lucide-react';
import { fetchTicker, subscribeTicker, type TickerBet } from '../lib/db';
import { useAuth } from '../lib/useAuth';
import { BookmakerLogo } from '../components/BookmakerLogo';
import { IdChip } from '../components/IdChip';
import { TagChip } from '../components/TagChip';
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
 * The best price any other book is showing — for marking the winning column.
 *
 * This used to be the measure of "over the odds" as well, and is not any more:
 * see `overFair`. It still answers which book column holds the best number on
 * the row, which is a question about the field and nothing else.
 *
 * The exchange is shown but excluded; see NOT_BEST. `best` is null when nobody
 * else priced the selection.
 */
function priceStandout(b: TickerBet): { best: number | null } {
  const others = Object.entries(b.prices ?? {})
    .filter(([book]) => !NOT_BEST.has(book))
    .map(([, p]) => p);
  return { best: others.length ? Math.max(...others) : null };
}

/**
 * The bet's price against the TRUE price, which is the question worth asking.
 *
 * This was the best price any other book was showing, and that measure has a
 * floor built into it: every book's quote already includes its own margin, so
 * beating the field means beating a number that was never fair to begin with.
 * A bet can sit under every book on the row and still be a bad bet to have
 * taken. Judging against the 100% price asks the real thing — was this struck
 * at better than the market's own estimate of the chance — and it catches the
 * bets that the field comparison cannot see at all.
 *
 * Pinnacle first and the blend as the fallback. Pinnacle is the reference book,
 * so when it has priced the market its de-vigged number is the one to answer
 * to; when it has not, the blend of everyone who priced the whole market is a
 * better answer than none. Which one was used is reported, because a 4% edge
 * over Pinnacle and a 4% edge over a two-book blend are not the same claim.
 *
 * `fair` null means UNJUDGED, not fine — the market was not complete enough to
 * divide (see server/lib/fair.mjs) — and an unjudged bet must never filter in
 * as though it were evidence.
 */
function overFair(b: TickerBet): {
  fair: number | null;
  source: 'Pinnacle' | 'blend' | null;
  out: boolean;
  byPct: number;
} {
  const fair = b.fairPinnacle ?? b.fairBlend ?? null;
  const source = b.fairPinnacle != null ? 'Pinnacle' : b.fairBlend != null ? 'blend' : null;
  const out = b.price != null && fair != null && b.price > fair;
  return { fair, source, out, byPct: out && fair ? (b.price! / fair - 1) * 100 : 0 };
}

/**
 * Fold a freshly fetched batch into the feed already on screen.
 *
 * Keyed on the document id, because the same bet arrives by both routes — the
 * stream pushes it the moment it is written and the poll returns it enriched a
 * few seconds later. `authoritative` wins on the fields for any bet in both,
 * which is the poll: its rows have been through the comparison prices and the
 * fairs, and the pushed row has not.
 *
 * Then newest-first and capped, so the only way a row leaves the table is
 * another LIMIT bets arriving after it. A refresh can add and it can update,
 * but it cannot delete — which is what makes the feed monotonic, and a feed
 * that silently goes backwards is worse than a stale one, because the gap is
 * invisible.
 */
function mergeFeed(existing: TickerBet[], authoritative: TickerBet[]): TickerBet[] {
  const byId = new Map<string, TickerBet>();
  for (const b of existing) byId.set(b.id, b);
  for (const b of authoritative) byId.set(b.id, b);
  const at = (b: TickerBet) => (b.placedAt ? Date.parse(b.placedAt) : NaN);
  return [...byId.values()]
    .sort((a, b) => {
      const ta = at(a);
      const tb = at(b);
      // A row with no usable time sorts last rather than poisoning the order.
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    })
    .slice(0, LIMIT);
}

/**
 * The secondary line of a stacked cell.
 *
 * One class, used everywhere a cell has a line under its main one, so the
 * hierarchy is a single decision rather than a per-cell guess. `text-xs` is the
 * board's own secondary size — the ticker used to sit two points below the rest
 * of the site on the theory that a dense table needs it, which only made the
 * densest page the hardest to read.
 */
const SUB = 'text-xs text-slate-500';

/**
 * Where a fixture sits: sport, country or region, competition.
 *
 * Three columns' worth of context on one line under the event, de-duplicated
 * case-insensitively — the feed repeats itself often enough that without this
 * the line reads "Rugby League · International · International - Rugby League
 * World Cup". `tournamentLabel` has already taken the category off the front of
 * the tournament; this catches the rest.
 */
function contextLine(b: TickerBet): string {
  const parts = [b.sport, b.category, tournamentLabel(b.tournament, b.category)];
  const seen = new Set<string>();
  return parts
    .filter((x): x is string => !!x)
    .filter((x) => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(' · ');
}

/** The reference book, looked up once rather than per row. */
const pinnacle = brandById('pinnacle');

/**
 * A mark for the blend, where the other column has a bookmaker's logo.
 *
 * The blend has no logo because it is not a book — it is every book that
 * priced the whole market, averaged — but the two columns are the same kind of
 * number and belong in the same shape. So it gets a badge the size of a logo
 * and sits in the same stack above the same word.
 *
 * Deliberately NOT in a brand colour: those are reserved for actual brands
 * across this page and the board, and a coloured chip here would read as a
 * ninth bookmaker.
 */
function BlendBadge({ label = 'BLEND' }: { label?: string }) {
  return (
    <span
      className="rounded border border-surface-border bg-white/5 px-1 py-px text-[10px] font-semibold uppercase leading-[1.3] tracking-wide text-slate-400"
      style={{ minHeight: 15 }}
    >
      {label}
    </span>
  );
}

/**
 * The tournament, without the category repeated inside it.
 *
 * The two sit in adjacent columns and the feed sometimes puts the category in
 * both: bet 6616894 is category "International" and tournament "International
 * - Rugby League World Cup", so the row read "International · International -
 * Rugby League World Cup". Also "Chile LNB" under Chile and "Guatemala Liga
 * Nacional" under Guatemala — nine of 200 bets on one feed.
 *
 * Only a LEADING category on a word boundary is removed, which is what keeps
 * this from eating real names: "English Premier League" under England survives
 * because "English" is not "England", and "UEFA - Europa League" keeps its
 * prefix because UEFA is not the category. If stripping would leave nothing,
 * the original stands — a tournament that IS its category is still a label.
 */
function tournamentLabel(tournament: string | null, category: string | null): string | null {
  if (!tournament || !category) return tournament;
  const t = tournament.trim();
  const c = category.trim();
  if (!c || t.length <= c.length) return tournament;
  if (t.slice(0, c.length).toLowerCase() !== c.toLowerCase()) return tournament;
  const rest = t.slice(c.length);
  // The boundary matters: without it a category of "Chile" would also strip
  // the front of a tournament called "Chilean Cup".
  const trimmed = rest.replace(/^\s*[-–—·|]?\s*/, '');
  return trimmed && trimmed !== rest ? trimmed : tournament;
}

/**
 * A 100% price, and how the struck price compares to it.
 *
 * The number itself is the market with the book's margin divided out, so it is
 * always longer than anything quoted — which means the comparison that matters
 * is not "did we beat the field" but "did this bet get a price better than the
 * true one". That is the edge, and it goes in the title rather than on the face
 * of the cell: these two columns are a reference the eye checks against, and
 * tinting them would make the row shout twice about the same thing.
 *
 * An em-dash means the market could not be divided honestly — usually a book
 * that has pulled one side — and never that the fair is 0 or that the bet was
 * fine. See server/lib/fair.mjs.
 */
function FairCell({
  fair,
  price,
  what,
}: {
  fair: number | null | undefined;
  price: number | null;
  what: string;
}) {
  if (fair == null) {
    return (
      <span className="text-slate-700" title={`No 100% price from ${what} — the market was not complete enough to divide`}>
        –
      </span>
    );
  }
  const edge = price != null ? (price / fair - 1) * 100 : null;
  return (
    <span
      title={
        edge == null
          ? `${what} at 100%: ${fmt(fair)}`
          : `${what} at 100%: ${fmt(fair)} — struck at ${fmt(price)}, ${
              edge >= 0 ? `${edge.toFixed(1)}% over` : `${(-edge).toFixed(1)}% under`
            } the fair price`
      }
    >
      {fmt(fair)}
    </span>
  );
}

/**
 * How far over the fair price is worth looking at.
 *
 * The thresholds are unchanged but they now mean more: against the field, 0%
 * was already a strong claim because a book's quote carries its margin. Against
 * a 100% price, a couple of percent is ordinary variance between books and 5%
 * is a market we were plainly wrong on.
 */
const OUT_MARGINS = [0, 2, 5];

/** Struck at least `margin` percent above the fair price. */
function overTheOdds(b: TickerBet, margin: number): boolean {
  const { out, byPct } = overFair(b);
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



/*
 * The stake filter is a typed box rather than preset buttons, so any figure
 * can be asked for.
 *
 * Filtered on the CLIENT, which is the one design choice in it. Bets also
 * arrive on a change stream, and a server-side filter would govern the fetched
 * batch while every pushed bet walked straight past it. One rule here covers
 * both paths and costs nothing on 200 rows.
 */

export default function TickerPage() {
  const { user } = useAuth();
  const [bets, setBets] = useState<TickerBet[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [brandParam, setBrand] = useParam('brand', 'all');
  const brand = brandParam as 'all' | 'swiftbet' | 'mybet' | 'multis';
  const [sport, setSport] = useParam('sport', 'all');
  /*
   * Kept as the typed text, not a number. Parsing on every keystroke turns "1."
   * into 1 and then fights the caret when the next character arrives; the value
   * is read as a number only where it is used.
   */
  const [stakeText, setStakeText] = useParam('stake', '');
  const minStake = Number(stakeText) > 0 ? Number(stakeText) : 0;
  /*
   * Overs or All, defaulting to Overs for a trading account: the bets we were
   * over the odds on are what the feed is for from that desk, but it is a
   * choice now rather than a lock — being unable to see the rest meant being
   * unable to tell whether the exceptions were the whole story.
   *
   * The label says which it is at all times, so nobody reads the filtered feed
   * believing it is everything.
   */
  /*
   * `?view=overs` / `?view=all`, with the role deciding what an absent value
   * means — Overs for a trading account, All for everyone else. Written only
   * when it differs from that, so the URL carries a choice rather than a
   * restatement of the default.
   */
  const defaultView = user?.role === 'trading' ? 'overs' : 'all';
  const [view, setView] = useParam('view', defaultView);
  const onlyOut = view === 'overs';
  const setOnlyOut = (v: boolean) => setView(v ? 'overs' : 'all');
  const [outMargin, setOutMargin] = useNumParam('margin', 0);
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
          /*
           * MERGED, not replaced, and that is the whole point.
           *
           * This was `setBets(d.bets)`. A poll therefore deleted every bet the
           * stream had pushed that the poll's own payload did not happen to
           * contain — and the payload is built on the server a moment before it
           * is sent, so a bet arriving in that gap was shown by the stream and
           * then wiped by the next poll a few seconds later. Add a function
           * instance serving a cached feed (see maxStaleMs on the route) and it
           * wiped half an hour of them.
           *
           * The feed is the newest LIMIT bets this page has SEEN. Rows leave it
           * by being pushed off the bottom by newer ones, never by a refresh
           * disagreeing about what exists. The poll's copy of a bet wins on
           * the fields, because it is the enriched one — the stream's rows
           * carry no comparison prices.
           */
          setBets((prev) => mergeFeed(prev, d.bets ?? []));
          setLastPoll(Date.now());
          setState('ready');
        })
        .catch(() => !cancelled && setState('error'));

    /*
     * The poll runs ALONGSIDE the stream, not only in its absence.
     *
     * It used to stop the moment the stream opened, which is correct right up
     * until the stream dies quietly — and then the page sits there looking
     * live, with a connection that is open and delivering nothing. Nobody
     * watching a bet feed can afford to find that out late.
     *
     * 10s when the poll is the only thing arriving, 20s as a backstop while
     * the stream is up. Both are below the server's own 20s cache on this
     * route and its 5s browser window, so a poll can actually return something
     * newer — faster than either of those would just re-read the same payload.
     *
     * In place, with no loading toggle, so the table never flashes while
     * someone is reading it.
     */
    const startPolling = (ms = 10_000) => {
      if (poll) clearInterval(poll);
      poll = setInterval(load, ms);
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
        startPolling(20_000);
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


  // How many are out of line at each margin, and how many could be judged at
  // all — the second number is what stops the first being read as a rate.
  const outCounts = useMemo(() => {
    const base = bets.filter(
      (b) => (brand === 'all' || b.brand === brand) && (sport === 'all' || b.sport === sport),
    );
    return {
      // Judgeable means there IS a fair to answer to, not that a book priced
      // it — the two differ, and the gap is markets where a book had pulled a
      // side and the fair was refused rather than guessed.
      comparable: base.filter((b) => overFair(b).fair != null).length,
      byMargin: OUT_MARGINS.map((m) => base.filter((b) => overTheOdds(b, m)).length),
    };
  }, [bets, brand, sport]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="shrink-0 border-b border-surface-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
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
          <span className="flex items-center gap-2 text-xs tabular-nums text-slate-600">
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
          <span className="ml-auto">
            <SignOut />
          </span>
        </div>

        <div className="mt-3 flex items-start gap-2">
          {/*
            * "Filter" set on its side, reading downwards.
            *
            * The strip it labels is a dozen buttons that already wrap onto two
            * rows on a narrow window, so a horizontal label would cost a whole
            * button's width on every one of them to say something you only
            * need told once. Turned on its side the box is one character wide
            * instead of six, and it sits beside the first row rather than
            * pushing it along.
            *
            * `vertical-rl` rather than a rotate: a transform would move the
            * glyphs but leave the box the width of the word, so the row would
            * still be indented by "Filter" and the label would hang outside
            * its own space. Writing mode changes the box too, which is the
            * part that buys the room.
            */}
          <span
            aria-hidden="true"
            className="mt-0.5 shrink-0 select-none text-[10px] uppercase leading-none tracking-widest text-slate-600 [writing-mode:vertical-rl]"
          >
            Filter
          </span>

          <div role="group" aria-label="Filter" className="flex flex-wrap items-center gap-1.5">
            {(['all', 'swiftbet', 'mybet', 'multis'] as const).map((b) => (
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
                {b === 'all' ? 'All brands' : BRAND_LABEL[b]}
                <span className="ml-1.5 tabular-nums opacity-60">{counts[b] ?? 0}</span>
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-surface-border" />
            <button
              type="button"
              onClick={() => setSport('all')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
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
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
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
            {/* Over the odds, or everything. The one on the left is the default
                for a trading account. */}
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                type="button"
                onClick={() => setOnlyOut(v)}
                title={
                  v
                    ? 'Only bets struck ABOVE the fair price — the market with the margin divided out, Pinnacle where it priced the market and the blend otherwise. A bet can be under every book on the row and still be over the fair.'
                    : 'Every bet on the feed.'
                }
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  onlyOut === v
                    ? 'bg-rose-500/15 text-rose-300'
                    : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                }`}
              >
                {v ? 'Overs' : 'All'}
                <span className="ml-1.5 tabular-nums opacity-60">
                  {v ? outCounts.byMargin[0] : bets.length}
                </span>
              </button>
            ))}
            {onlyOut && (
              <>
                {OUT_MARGINS.map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setOutMargin(m)}
                    className={`rounded-md px-2 py-1 text-xs font-medium tabular-nums transition ${
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
                  className="text-xs text-slate-600"
                  title="Bets with a fair price to answer to. The rest are unjudged — the market was not complete enough to divide to 100%, usually a book having pulled one side."
                >
                  of {outCounts.comparable} judgeable
                </span>
              </>
            )}
            <span className="mx-1 h-4 w-px bg-surface-border" />
            <label
              className="flex items-center gap-1.5 text-xs text-slate-600"
              title="Stake on the bet, before any bonus. Blank shows everything."
            >
              stake ≥
              <span className="relative">
                <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-600">
                  $
                </span>
                <input
                  value={stakeText}
                  onChange={(e) => setStakeText(e.target.value.replace(/[^\d.]/g, ''))}
                  inputMode="decimal"
                  placeholder="0"
                  aria-label="Minimum stake"
                  className={`w-20 rounded-md border bg-surface-raised/40 py-1 pl-4 pr-1.5 text-xs tabular-nums text-slate-100 outline-none placeholder:text-slate-600 ${
                    minStake > 0 ? 'border-emerald-500/40' : 'border-surface-border'
                  }`}
                />
              </span>
              {minStake > 0 && (
                <span className="tabular-nums text-slate-500">{shown.length}</span>
              )}
            </label>
          </div>
        </div>
      </header>

      {latest && (
        <div className="shrink-0 border-b border-surface-border bg-surface-raised/60 px-5 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">Latest</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
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
        {state === 'loading' && bets.length === 0 ? (
          <BetsTableSkeleton rows={14} cols={columns.length || 6} />
        ) : state === 'error' ? (
          <p className="px-5 py-8 text-sm text-rose-300">The bet feed could not be loaded.</p>
        ) : shown.length === 0 && state === 'ready' ? (
          <p className="px-5 py-8 text-sm text-slate-500">No single bets in the last few days.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-raised text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                {/*
                  Brand, User, Tag and Bet were one cell under the single
                  heading "Brand" — so the header named one of the four things
                  in it, and the two id chips sat either side of the tag in the
                  same grey, at the same width, with nothing to say which was
                  the punter and which was the bet. Four columns, four headings,
                  and each one a fixed width so the eye can run down it.
                */}
                <th className="w-[5rem] px-3 py-2 text-left font-medium">Brand</th>
                {/*
                  The tag moved UNDER the id rather than beside it. It is a fact
                  about the punter, not about the bet, so it belongs with the
                  punter — and the column it used to occupy was the widest on the
                  row at 9.5rem, carrying tags up to 32 characters.
                */}
                <th className="w-[10rem] px-2 py-2 text-left font-medium">User</th>
                <th className="w-[7.5rem] px-2 py-2 text-left font-medium">Bet</th>
                {/*
                  Eight columns folded into three, each one two lines.
                  The table was wider than any screen and the text was set two
                  points smaller than the board to try to compensate, which
                  made it both hard to read AND still too wide. Stacking what
                  belongs together costs a line of height per row and buys back
                  five columns of width, so the type can come up to the size the
                  rest of the site uses. Primary above, context below.
                */}
                {/* Two lines, so the heading names both rather than only the first. */}
                <th
                  className="w-[7rem] px-2 py-2 text-left font-medium"
                  title="When the bet was struck, over when the event starts"
                >
                  Placed · Starts
                </th>
                <th className="px-2 py-2 text-left font-medium">Event</th>
                <th className="px-2 py-2 text-left font-medium">Selection</th>
                <th className="border-l border-surface-border px-2 py-2 text-right font-medium">
                  Stake
                </th>
                <th className="px-2 py-2 text-center font-medium">Price</th>
                {/*
                  The two 100% prices, between the struck price and the field.
                  They are a different KIND of number from the columns to the
                  right — nothing you could have bet, the market with the
                  book's margin divided out — so they sit in their own bordered
                  block rather than reading as two more bookmakers.
                */}
                {/*
                  Both stacked, mark above the word, so the two read as a pair
                  of the same thing from two sources rather than as a logo
                  column beside a text one.
                */}
                <th
                  className="border-l border-surface-border px-2 py-2 font-medium"
                  title="Pinnacle's price on this outcome with its margin divided out across the market — the market at 100%"
                >
                  <div className="flex flex-col items-center gap-1">
                    {pinnacle ? <BookmakerLogo brand={pinnacle} size={15} /> : <BlendBadge label="Pinn" />}
                    <span>Fair</span>
                  </div>
                </th>
                <th
                  className="px-2 py-2 font-medium"
                  title="Every book that prices the whole market, de-vigged individually and averaged — also 100%"
                >
                  <div className="flex flex-col items-center gap-1">
                    <BlendBadge />
                    <span>Fair</span>
                  </div>
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
              {shown.map((b) => {
                const { best } = priceStandout(b);
                // Over the FAIR price is what tints the cell now, not over the
                // field — see overFair. A row can beat every book and still be
                // under the fair, and that row is not the one to look at.
                const { out: overTrue, byPct: overPct, fair, source: fairFrom } = overFair(b);
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
                          const tone = `rounded px-1.5 py-0.5 text-xs font-medium ${
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
                      </span>
                    </td>
                    <td className="min-w-0 px-2 py-1.5">
                      <IdChip
                      value={b.userPin ?? b.userId}
                      title={b.userPin ? `Backoffice pin (account ${b.userId})` : 'User'}
                    />
                      {(b.tags ?? []).length > 0 && (
                        <div className="mt-0.5">
                          <TagChip tags={b.tags ?? []} />
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      <IdChip value={b.betId} title="Bet" />
                    </td>
                    {/* Placed above, kick-off below. */}
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                      <div className="text-slate-200">{time(b.placedAt)}</div>
                      <div className={SUB}>{startLabel(b.startsAt)}</div>
                    </td>
                    {/* The fixture, with the competition that places it under. */}
                    <td className="max-w-[15rem] px-2 py-1.5" title={b.event ?? ''}>
                      <div className="truncate text-slate-200">
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
                      </div>
                      <div className={`truncate ${SUB}`} title={contextLine(b)}>
                        {contextLine(b) || '–'}
                      </div>
                    </td>
                    {/*
                      What was backed, above what market it was backed in. The
                      outcome leads because it is the thing a person reads first
                      — "Papua New Guinea" tells you more at a glance than
                      "Win" does.
                    */}
                    <td className="max-w-[14rem] px-2 py-1.5" title={b.outcome ?? ''}>
                      <div className="truncate text-slate-200">{b.outcome ?? '–'}</div>
                      <div className={`truncate ${SUB}`} title={b.market ?? ''}>
                        {marketLabel(b.market) || '–'}
                      </div>
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
                        overTrue ? 'text-amber-300' : 'text-slate-100'
                      }`}
                      title={
                        overTrue
                          ? `${overPct.toFixed(1)}% above the fair price of ${fmt(fair)} (${fairFrom})`
                          : fair != null && b.price != null
                            ? `${((1 - b.price / fair) * 100).toFixed(1)}% under the fair price of ${fmt(fair)} (${fairFrom})`
                            : fair != null
                              ? `Fair price ${fmt(fair)} (${fairFrom}); this bet carries no price`
                              : 'No fair price for this market — unjudged'
                      }
                    >
                      {fmt(b.price)}
                    </td>
                    <td className="border-l border-surface-border px-2 py-1.5 text-center tabular-nums text-slate-400">
                      <FairCell fair={b.fairPinnacle} price={b.price} what="Pinnacle" />
                    </td>
                    <td className="px-2 py-1.5 text-center tabular-nums text-slate-400">
                      <FairCell
                        fair={b.fairBlend}
                        price={b.price}
                        what={b.fairBooks ? `a blend of ${b.fairBooks} books` : 'the blend'}
                      />
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
