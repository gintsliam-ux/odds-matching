import { useCallback, useEffect, useRef, useState } from 'react';
import { MarketsSkeleton, PricesSkeleton } from '../components/Skeleton';
import { useParam } from '../lib/urlState';
import { useAuth } from '../lib/useAuth';
import { SignOut } from '../components/SignOut';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, Radio, Search as SearchIcon, X } from 'lucide-react';
import { EventDetail } from '../components/EventDetail';
import { LeagueBadge } from '../components/LeagueBadge';
import { fetchEventById, fetchOdds, searchEvents, SEARCH_MIN_CHARS } from '../lib/db';
import { buildMarkets, type Bookmaker, type MarketGroup } from '../lib/markets';
import type { SportEvent } from '../lib/types';

/**
 * Find a team or a player, and see only their prices.
 *
 * This is the whole surface for the `trading` role — no board, no rail, nothing
 * that lists the market at large. You ask for a name and you get that name's
 * fixtures, and the grid underneath is the same markets-by-bookmaker table the
 * event page draws, because it is literally the same component.
 *
 * Everyone else can reach it too; it is a quicker way to one team than scrolling
 * the rail.
 */

/** Long enough that typing a name is one request, short enough to feel live. */
const DEBOUNCE_MS = 250;

function startsIn(iso: string, now: number): string {
  const m = Math.round((new Date(iso).getTime() - now) / 60000);
  if (!Number.isFinite(m)) return '';
  if (m < 0) return 'started';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
}

export default function SearchPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [term, setTerm] = useParam('q', '');
  const [hits, setHits] = useState<SportEvent[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SportEvent | null>(null);
  const [markets, setMarkets] = useState<MarketGroup[]>([]);
  const [books, setBooks] = useState<Bookmaker[]>([]);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The grid shows a countdown and a clock; without this they freeze.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /*
   * One search per pause in typing, and the LAST one wins.
   *
   * Without the sequence check a slow early request can land after a fast later
   * one and put the results for "ma" under the word "manchester".
   */
  const seq = useRef(0);
  useEffect(() => {
    const q = term.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setHits([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      searchEvents(q)
        .then((rows) => {
          if (mine !== seq.current) return;
          setHits(rows);
          setError(null);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setHits([]);
          setError('Search failed. Try again.');
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [term]);

  const open = useCallback((event: SportEvent) => {
    setSelected(event);
    setOddsLoading(true);
    setMarkets([]);
    setBooks([]);
    fetchOdds(event)
      .then((rows) => {
        const built = buildMarkets(rows, event.home, event.away, event.league.id);
        setMarkets(built.groups);
        setBooks(built.books);
      })
      .catch(() => setError('Could not load prices for that fixture.'))
      .finally(() => setOddsLoading(false));
  }, []);

  // Land straight on the one result, so a full name is one keystroke from prices.
  useEffect(() => {
    if (hits.length === 1 && hits[0].id !== selected?.id) open(hits[0]);
    if (hits.length === 0 && !params.get('fixture')) setSelected(null);
  }, [hits, selected?.id, open, params]);

  /*
   * `?fixture=<id>` opens straight onto one fixture's prices.
   *
   * This is where a trading account arrives from the ticker: the bet rows link
   * to the event page, which that role cannot open, so for them the link comes
   * here instead and this is what makes it land somewhere useful rather than on
   * an empty search box.
   *
   * Honoured ONCE per id, which the ref is for. Keying the effect on whether
   * the id matches the open fixture instead would yank the page back the moment
   * someone clicked a different result, since the parameter is still in the URL.
   */
  const honoured = useRef<string | null>(null);
  useEffect(() => {
    const id = params.get('fixture');
    if (!id || honoured.current === id) return;
    honoured.current = id;
    fetchEventById(id)
      .then((e) => {
        if (!e) {
          setError('That fixture is no longer on the board.');
          return;
        }
        open(e);
        // Seed the search with one side, so the list has their other fixtures
        // in it rather than sitting empty beside a populated grid.
        setTerm(e.home || e.name);
      })
      .catch(() => setError('Could not open that fixture.'));
  }, [params, open, setTerm]);

  return (
    <div className="flex h-dvh flex-col bg-surface-base text-slate-200">
      <header className="shrink-0 border-b border-surface-border bg-surface px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[15px] font-semibold tracking-tight text-slate-100">Prices</span>
          <Link
            to="/ticker"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
          >
            <Radio size={12} /> Ticker
          </Link>
          {/* Not offered to a trading account: it cannot open the board. */}
          {user?.role !== 'trading' && (
            <Link
              to="/"
              className="rounded-md px-2 py-1 text-[11px] text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
            >
              Board
            </Link>
          )}
          <span className="ml-auto">
            <SignOut />
          </span>
        </div>

        <div className="relative mt-2.5">
          <SearchIcon
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-600"
          />
          <input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search a team or player…"
            aria-label="Search a team or player"
            className="w-full rounded-lg border border-surface-border bg-surface-raised/40 py-2 pl-9 pr-9 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-500/40"
          />
          {term && (
            <button
              type="button"
              onClick={() => setTerm('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-600 transition hover:text-slate-300"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </header>

      {/* Arriving on a ?fixture= link: both panes at once, since neither the
          list nor the grid has anything in it yet. */}
      {params.get('fixture') && !selected && !error ? (
        <PricesSkeleton />
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* The hits. Only ever what was asked for. */}
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-surface-border">
          {term.trim().length > 0 && term.trim().length < SEARCH_MIN_CHARS && (
            <p className="p-4 text-xs text-slate-600">
              Keep typing — {SEARCH_MIN_CHARS} characters minimum.
            </p>
          )}
          {searching && hits.length === 0 && (
            <p className="flex items-center gap-2 p-4 text-xs text-slate-600">
              <Loader2 size={13} className="animate-spin" /> Searching…
            </p>
          )}
          {!searching && term.trim().length >= SEARCH_MIN_CHARS && hits.length === 0 && (
            <p className="p-4 text-xs text-slate-600">
              Nothing matches “{term.trim()}”.
            </p>
          )}
          {hits.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => open(e)}
              className={`block w-full border-b border-surface-border/60 px-3 py-2 text-left transition ${
                selected?.id === e.id ? 'bg-emerald-500/[0.07]' : 'hover:bg-white/[0.03]'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <LeagueBadge league={e.league} size={13} />
                <span className="truncate text-xs text-slate-500">{e.league.name}</span>
              </span>
              <span className="mt-0.5 block truncate text-sm text-slate-200">{e.name}</span>
              <span className="mt-0.5 block text-[11px] tabular-nums text-slate-600">
                {e.status === 'live'
                  ? 'live'
                  : e.status === 'final'
                    ? 'final'
                    : startsIn(e.startsAt, now)}
              </span>
            </button>
          ))}
        </aside>

        {/* And their prices — the same grid the event page draws. */}
        <main className="min-w-0 flex-1 overflow-hidden">
          {error && <p className="p-4 text-sm text-rose-300">{error}</p>}
          {oddsLoading && !markets.length && selected ? (
            // Just the grid: the pane on the left is already drawn beside it.
            <MarketsSkeleton groups={3} />
          ) : !selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm text-slate-500">Search a team or player.</p>
              <p className="max-w-sm text-xs text-slate-600">
                Their fixtures appear on the left, and the prices every bookmaker is
                showing on them appear here.
              </p>
            </div>
          ) : (
            <EventDetail
              event={selected}
              now={now}
              markets={markets}
              books={books}
              loading={oddsLoading}
            />
          )}
        </main>
      </div>
      )}
    </div>
  );
}
