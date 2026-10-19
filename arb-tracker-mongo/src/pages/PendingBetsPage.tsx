import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Hourglass, Loader2, TrendingDown } from 'lucide-react';
import { BetsTableSkeleton } from '../components/Skeleton';
import { SignOut } from '../components/SignOut';
import { useParam } from '../lib/urlState';
import { fetchPending, type Pending, type PendingBet } from '../lib/db';
import { BookmakerLogo } from '../components/BookmakerLogo';
import { IdChip } from '../components/IdChip';
import { TagChip } from '../components/TagChip';
import { brandById, BOOKMAKERS } from '../lib/markets';
import { BRAND_LABEL, BRAND_TONE } from '../lib/brands';
import { marketLabel } from '../lib/marketLabel';
import { eventSlug } from '../lib/routing';

/**
 * Bets still live, and what the market has done to them since.
 *
 * The ticker's question is "what is being backed". This one's is "what are we
 * holding, and is it still a price we would offer" — so the subject of every
 * row is the pair of numbers at its centre: what the customer took, and what we
 * show on the same selection now.
 *
 * A FIRMER is the second number being shorter than the first. That is the
 * market agreeing with the customer, and it is the only thing on this page that
 * is actionable while the bet is still open.
 *
 * Admin only, gated on the server as well — see ADMIN_ONLY in routes.mjs. A
 * hidden link is not a restriction.
 */

const fmt = (n: number | null | undefined) => (n != null ? n.toFixed(2) : '–');

const money = (n: number | null | undefined) =>
  n == null
    ? '–'
    : `$${n.toLocaleString(undefined, {
        minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
        maximumFractionDigits: 2,
      })}`;

const time = (v: string | null) =>
  v ? new Date(v).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';

/**
 * How long until the event starts, or how long since.
 *
 * On a page of open bets the absolute kick-off matters less than the distance
 * to it: a firmer on a game starting in nine minutes is a different problem
 * from the same firmer on one three days out, because only one of them can
 * still be traded out of. "Started" rather than a negative, because a bet open
 * on a game already under way is its own thing — see the Late Bets page.
 */
function untilStart(v: string | null): string {
  if (!v) return '';
  const ms = new Date(v).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) {
    const mins = Math.round(-ms / 60_000);
    return mins < 60 ? `started ${mins}m ago` : `started ${Math.floor(mins / 60)}h ago`;
  }
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  if (mins < 1440) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `in ${Math.floor(mins / 1440)}d`;
}

const SUB = 'text-xs text-slate-500';

/**
 * Signed percent of implied probability, as the movers page writes it.
 *
 * Negative is a firmer, and firmers are the bad news on this page, so they take
 * the warning colour. Positive means the market drifted away from the customer
 * and the bet has got better for us.
 */
function Move({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-700">–</span>;
  if (Math.abs(pct) < 0.01) return <span className="text-slate-500">level</span>;
  const firmed = pct < 0;
  return (
    <span className={firmed ? 'font-semibold text-rose-300' : 'text-emerald-300/80'}>
      {firmed ? '▼' : '▲'} {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

/** The book columns, in the board's order, plus whatever else the feed carries. */
function bookColumns(bets: PendingBet[]): string[] {
  const core = BOOKMAKERS.map((b) => b.id);
  const seen = new Set<string>();
  for (const b of bets) for (const k of Object.keys(b.prices ?? {})) seen.add(k);
  return [...core, ...[...seen].filter((id) => !core.includes(id)).sort()];
}

export default function PendingBetsPage() {
  const [data, setData] = useState<Pending | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  /*
   * Three views on one page, because they are three readings of the same book.
   *
   * `all` and `firmers` are open bets against our current price. `settled` is a
   * different question with a different answer: a bet that is over can only be
   * judged against the CLOSE, and the ones that beat it were mispriced whether
   * or not they won. All is the default — the page is the book, not the alarm.
   */
  const [view, setView] = useParam('view', 'all');
  const settled = view === 'settled';
  const firmersOnly = view === 'firmers';
  const [brand, setBrand] = useParam('brand', 'all');
  const [sport, setSport] = useParam('sport', 'all');

  useEffect(() => {
    let cancelled = false;
    /*
     * The other view's payload is DISCARDED, not left on screen.
     *
     * This effect re-runs only when the view changes, and it used to keep
     * whatever was already loaded until the new fetch returned — so clicking
     * Settled rendered the open book for a moment, and since `beatClose` is
     * undefined on an open bet every row filtered out. What showed was "Nobody
     * beat the close" above the OPEN view's own counts: "177 open singles, 13
     * of them with both our price and another book's". Both true of the data
     * on screen and neither true of the view asked for.
     *
     * `loading` unconditionally here for the same reason — the poll below still
     * refreshes in place, because it does not re-run this effect.
     */
    setData(null);
    setState('loading');
    const load = () =>
      fetchPending(settled ? 'settled' : 'open')
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
    // A minute, matching the server's own TTL: the brand stores are scraped on
    // that order and polling faster cannot return anything newer.
    // An hour for settled, which cannot change, against a minute for open.
    const id = setInterval(load, settled ? 10 * 60_000 : 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [settled]);

  // Memoised so the three lists below are not rebuilt on every render: `data?.bets
  // ?? []` is a new array each time, which is enough to invalidate all of them.
  const bets = useMemo(() => data?.bets ?? [], [data]);
  const sports = useMemo(
    () => [...new Set(bets.map((b) => b.sport).filter(Boolean))].sort() as string[],
    [bets],
  );

  const shown = useMemo(
    () =>
      bets.filter(
        (b) =>
          (!firmersOnly || b.firmed) &&
          (!settled || b.beatClose) &&
          (brand === 'all' || b.brand === brand) &&
          (sport === 'all' || b.sport === sport),
      ),
    [bets, firmersOnly, settled, brand, sport],
  );

  const columns = useMemo(() => bookColumns(bets), [bets]);
  const c = data?.counts;
  /*
   * The settled window, from the server, with ONE fallback for the render
   * before any payload has arrived.
   *
   * It was written out as "the last 7 days" in four separate strings, and the
   * day the server's constant went from 7 to 14 all four became wrong at once
   * with nothing to catch them. A single binding keeps the copy honest and
   * leaves exactly one literal to get stale instead of four.
   */
  const days = c?.days ?? 14;
  const CHIP = 'rounded-md px-2.5 py-1 text-xs font-medium transition';

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
              <Hourglass size={16} className="text-sky-400" />
              Pending Bets
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              {settled
                ? `Settled in the last ${days} days where the customer beat the closing price`
                : 'Open singles, with the price we show now beside the price the customer took'}
            </p>
          </div>

          {c && (
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
              <span>
                <b className="tabular-nums text-rose-300">{c.firmed}</b>{' '}
                {settled ? 'beat the close' : 'firmed'}
              </span>
              <span>
                <b className="tabular-nums text-amber-300">{money(c.firmedStake)}</b> on them
              </span>
              <span>
                <b className="tabular-nums text-slate-300">{c.judgeable}</b> judgeable ·{' '}
                {money(c.stake)}
              </span>
              <span
                title={
                  settled
                    ? `Of ${c.open} settled singles in the last ${days} days${c.from ? ` (back to ${c.from})` : ''}, ${c.noClose ?? 0} have no usable closing price to judge against — a market the close cannot be divided to 100% on, usually because a book closed only part of it.${c.dropped ? ` ${c.dropped} fixtures were left unpriced by the build's time budget.` : ''}`
                    : `Of ${c.open} open singles: ${c.noOurPrice} have no current price of our own on that selection, ${c.noFieldPrice} have no other book priced on it. A row missing either cannot be compared, so it is counted here rather than shown as a bet nobody has an opinion on.`
                }
              >
                of <b className="tabular-nums text-slate-400">{c.open}</b>{' '}
                {settled ? 'settled' : 'open'}
              </span>
              {state === 'loading' && <Loader2 size={13} className="animate-spin text-slate-600" />}
            </div>
          )}
          <span className="ml-auto">
            <SignOut />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border/60 px-4 py-2">
          {([
            ['all', 'All', 'Every open single we can compare.'],
            ['firmers', 'Firmers', 'Open bets whose price has shortened since they were struck — the market moving towards the customer.'],
            /*
              Named for the bet STATE, not for the filter. All and Firmers are
              open bets; this one is the settled book. What it shows within that
              is the ones that beat the close, which is the only question worth
              asking of a bet that is already over — so the filter lives in the
              tooltip and the heading says which half of the book you are in.
            */
            ['settled', 'Settled', `Settled in the last ${days} days where the customer took a longer price than the market closed at, de-vigged. A price we should not have offered, whether or not it won.`],
          ] as const).map(([key, label, title]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              title={title}
              className={`${CHIP} ${
                view === key
                  ? 'bg-rose-500/15 text-rose-300'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {key === 'all' ? (
                'All'
              ) : (
                <span className="inline-flex items-center gap-1">
                  <TrendingDown size={12} /> {label}
                </span>
              )}
              {view === key && (
                <span className="ml-1.5 tabular-nums opacity-60">{shown.length}</span>
              )}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-surface-border" />
          {(['all', 'swiftbet', 'mybet', 'multis'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBrand(b)}
              className={`${CHIP} ${
                brand === b
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {b === 'all' ? 'All brands' : BRAND_LABEL[b] ?? b}
            </button>
          ))}
          <select
            value={sport}
            onChange={(e) => setSport(e.target.value)}
            className="rounded-md border border-surface-border bg-surface-raised px-2 py-1 text-xs text-slate-300 outline-none"
          >
            <option value="all">All sports</option>
            {sports.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-slate-600">{shown.length} shown</span>
        </div>
      </header>

      {state === 'loading' && !data && (
        <div className="min-h-0 flex-1">
          {/*
            * Thirteen columns, because that is how many the table has.
            * A skeleton narrower than the thing it stands in for reflows the
            * whole page the moment the data lands, which reads as a glitch
            * rather than as loading.
            */}
          <BetsTableSkeleton rows={12} cols={13} />
          {/*
            * And the settled view SAYS why it is slow.
            *
            * Every settled fixture's closing price is one upstream request, a
            * thousand-odd of them for the window, so a cold build runs to a
            * minute or more where the open view answers in seconds. An
            * unexplained minute of skeleton reads as broken; the same minute
            * with a reason reads as work. No day count in this copy on purpose
            * — the number lives on the server and there are no counts to read
            * until the payload arrives.
            */}
          {settled && (
            <p className="px-4 pt-3 text-xs text-slate-600">
              Reading every settled single in the window and the market's closing price on each
              one. The first load after an hour takes a minute or so; after that it is instant.
            </p>
          )}
        </div>
      )}

      {state === 'error' && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
          {error ?? 'Could not load pending bets.'}
        </div>
      )}

      {data && state !== 'error' && shown.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-slate-300">
            {settled ? 'Nobody beat the close.' : firmersOnly ? 'Nothing has firmed.' : 'Nothing open to compare.'}
          </p>
          <p className="max-w-md text-xs text-slate-600">
            {!c
              ? ''
              : settled
                ? `${c.open} settled singles in the last ${days} days, ${c.judgeable} of them with a closing price to judge against. None was struck longer than the close.`
                : `${c.open} open singles, ${c.judgeable} of them with both our price and another book's on the same selection.`}
          </p>
        </div>
      )}

      {data && state !== 'error' && shown.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-raised text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-[5rem] px-3 py-2 text-left font-medium">Brand</th>
                {/* Both copyable: these are the two ids you quote when asking
                    about a bet, and reading a UUID off a screen is not a thing
                    anyone should be asked to do. */}
                {/* The client tag sits under the id: it describes the punter,
                    not the bet. */}
                <th className="w-[10rem] px-2 py-2 text-left font-medium">User</th>
                <th className="w-[7.5rem] px-2 py-2 text-left font-medium">Bet</th>
                <th className="w-[8rem] px-2 py-2 text-left font-medium">Placed</th>
                <th className="w-[8rem] px-2 py-2 text-left font-medium">Starts</th>
                <th className="px-2 py-2 text-left font-medium">Event</th>
                <th className="px-2 py-2 text-left font-medium">Selection</th>
                <th className="border-l border-surface-border px-2 py-2 text-right font-medium">
                  Stake
                </th>
                {/*
                  The three columns the page is for, in their own block: what
                  they took, what we show, and the distance between the two.
                */}
                <th className="border-l border-surface-border px-2 py-2 text-center font-medium">
                  Took
                </th>
                <th
                  className="px-2 py-2 text-center font-medium"
                  title={
                    settled
                      ? "Where the market closed on this selection, with the margin divided out — Pinnacle's de-vigged close where it has one, else the blend of every book that closed the whole market. Not any one book's quoted close: that still carries its margin, so beating it is a lower bar than beating the true price."
                      : "Our own current price on the same selection, from the book the bet was struck on. A multis bet reads mybet's price: the two are one platform behind two front ends and share a single event store."
                  }
                >
                  {settled ? 'Closed' : 'Ours now'}
                </th>
                <th className="px-2 py-2 text-center font-medium">
                  {settled ? 'vs close' : 'Move'}
                </th>
                {columns.map((id) => {
                  const b = brandById(id);
                  return (
                    <th key={id} className="border-l border-surface-border px-1.5 py-2">
                      <div className="flex justify-center">
                        {b ? <BookmakerLogo brand={b} size={15} /> : id}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr
                  key={`${b.brand}:${b.id}`}
                  className={`border-b border-surface-border/50 hover:bg-white/[0.02] ${
                    (settled ? b.beatClose : b.firmed) ? 'bg-rose-500/[0.05]' : ''
                  }`}
                >
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        BRAND_TONE[b.brand] ?? 'bg-white/10 text-slate-300'
                      }`}
                    >
                      {BRAND_LABEL[b.brand] ?? b.brand}
                    </span>
                  </td>
                  <td className="min-w-0 px-2 py-1.5">
                    <IdChip value={b.userId} title="User" />
                    {(b.tags ?? []).length > 0 && (
                      <div className="mt-0.5">
                        <TagChip tags={b.tags ?? []} />
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <IdChip value={b.betId} title="Bet" />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-200">
                    {time(b.placedAt)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums" title={b.startsAt ?? ''}>
                    <div className="text-slate-200">{time(b.startsAt)}</div>
                    <div className={SUB}>{untilStart(b.startsAt)}</div>
                  </td>
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
                    <div className={`truncate ${SUB}`}>
                      {[b.sport, b.tournament].filter(Boolean).join(' · ') || '–'}
                    </div>
                  </td>
                  <td className="max-w-[14rem] px-2 py-1.5" title={b.outcome ?? ''}>
                    <div className="truncate text-slate-200">{b.outcome ?? '–'}</div>
                    <div className={`truncate ${SUB}`}>{marketLabel(b.market) || '–'}</div>
                  </td>
                  <td className="whitespace-nowrap border-l border-surface-border px-2 py-1.5 text-right tabular-nums text-slate-300">
                    {money(b.stake)}
                  </td>
                  <td className="border-l border-surface-border px-2 py-1.5 text-center font-semibold tabular-nums text-slate-100">
                    {fmt(b.price)}
                  </td>
                  <td
                    className="px-2 py-1.5 text-center tabular-nums"
                    title={
                      settled
                        ? `closing fair from ${b.closeFrom ?? 'the market'}`
                        : b.ourAt
                          ? `${BRAND_LABEL[b.ourBook ?? ''] ?? b.ourBook ?? 'our book'}'s own price${
                              b.ourBook && b.ourBook !== b.brand
                                ? ' (one platform behind both front ends)'
                                : ''
                            }, last seen ${new Date(b.ourAt).toLocaleString()}${
                              b.ourOpen != null ? ` — opened ${fmt(b.ourOpen)}` : ''
                            }`
                          : undefined
                    }
                  >
                    {settled ? (
                      <span className="text-slate-200">{fmt(b.closeFair)}</span>
                    ) : (
                      <span className={b.ourSuspended ? 'text-slate-600 line-through' : 'text-slate-200'}>
                        {fmt(b.ourNow)}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-center tabular-nums">
                    <Move pct={b.movePct} />
                  </td>
                  {columns.map((id) => {
                    const p = (b.prices ?? {})[id];
                    return (
                      <td
                        key={id}
                        className={`border-l border-surface-border px-1.5 py-1.5 text-center tabular-nums ${
                          p != null ? 'text-slate-300' : 'text-slate-700'
                        }`}
                      >
                        {fmt(p)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
