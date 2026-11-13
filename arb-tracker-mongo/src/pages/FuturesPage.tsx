import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Search, Trophy } from 'lucide-react';
import { LeagueBadge } from '../components/LeagueBadge';
import { SignOut } from '../components/SignOut';
import { EventDetail } from '../components/EventDetail';
import { RowsSkeleton } from '../components/Skeleton';
import { fetchFutureOdds, fetchFutures, type FutureItem, type FuturesList } from '../lib/db';
import { buildMarkets, FUTURES_LEAGUE, type Bookmaker, type MarketGroup } from '../lib/markets';
import { useFlagParam, useParam } from '../lib/urlState';
import type { SportEvent } from '../lib/types';

/**
 * Futures: the competition outrights, drawn the way a golf tournament is —
 * one row per team or player, a column per book, mybet's own price leftmost.
 *
 * The rail on the left is the catalogue with its filters; the URL carries the
 * selection (`f`), the sport, the search and the two toggles, so a future can
 * be sent as a link. Outright winners only by default: the conference,
 * division and award markets are there behind the toggle.
 */

const ODDS_POLL_MS = 60_000;
const LIST_POLL_MS = 5 * 60_000;

/** A future as the event page draws it: a single-sided fixture with one outright market. */
function toEvent(f: FutureItem): SportEvent {
  const starts = f.startsAt ?? new Date(Date.now() + 365 * 864e5).toISOString();
  return {
    id: f.id,
    sport: f.sportLabel,
    // The board's badge for the league, under the futures market set.
    league: { ...f.league, id: FUTURES_LEAGUE },
    name: f.tournament && !f.name.includes(f.tournament) ? `${f.tournament} · ${f.name}` : f.name,
    subtitle: f.source === 'mybet' ? 'mybet only' : f.mybetName ? `mybet: ${f.mybetName}` : undefined,
    home: '',
    away: '',
    startsAt: starts,
    endsAt: f.startsAt ?? undefined,
    outright: true,
    status: 'upcoming',
  };
}

/** "Jun 27" / "Feb 2027": when the future settles, for the rail's right-hand chip. */
function settleLabel(iso: string | null): string {
  if (!iso) return 'open';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'open';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' });
}

/** One future in the rail, drawn like a board row: badge, name, league line, a chip on the right. */
function FutureRow({ f, selected, onSelect }: { f: FutureItem; selected: boolean; onSelect: (id: string) => void }) {
  const name = f.tournament && !f.name.includes(f.tournament) ? `${f.tournament} · ${f.name}` : f.name;
  const sub = f.source === 'mybet' ? `${f.leagueName} · mybet only` : f.mybetId ? `${f.leagueName} · mybet` : f.leagueName;
  return (
    <button
      type="button"
      onClick={() => onSelect(f.id)}
      className={`flex w-full items-center gap-2.5 rounded-lg border-l-2 py-2 pl-2 pr-2 text-left transition-colors ${
        selected ? 'border-emerald-400 bg-emerald-500/10' : 'border-transparent hover:bg-white/5'
      }`}
    >
      <LeagueBadge league={f.league} size={30} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">{name}</div>
        <div className="truncate text-xs text-slate-500">{sub}</div>
      </div>
      <span
        className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold tabular-nums ${
          f.source === 'mybet' ? 'bg-amber-500/15 text-amber-300' : f.mybetId ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-slate-400'
        }`}
        title={f.startsAt ? `Feed date ${new Date(f.startsAt).toLocaleDateString()}` : undefined}
      >
        {settleLabel(f.startsAt)}
      </span>
    </button>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="p-4">
      <div className="grid min-h-[320px] place-items-center rounded-xl border border-dashed border-surface-border bg-surface-raised/30 text-sm text-slate-600">
        {text}
      </div>
    </div>
  );
}

/** A labelled switch: the setting's name, then a track whose knob sits right when it is on. */
function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left text-xs text-slate-300 transition hover:bg-white/5"
    >
      <span>{children}</span>
      <span
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          on ? 'bg-emerald-500' : 'bg-slate-700'
        }`}
      >
        <span
          className={`absolute left-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${
            on ? 'translate-x-3' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}

export default function FuturesPage() {
  const [list, setList] = useState<FuturesList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useParam('f', '');
  const [sport, setSport] = useParam('sport', 'all');
  const [query, setQuery] = useParam('q', '');
  const [outrightOnly, setOutrightOnly] = useFlagParam('outright', true);
  const [mybetOnly, setMybetOnly] = useFlagParam('mybet', false);

  // The clock the countdown reads — the same one-second beat the board uses.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The catalogue, refreshed every five minutes; a failure keeps the last copy.
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      fetchFutures()
        .then((l) => {
          if (cancelled) return;
          setList(l);
          setListError(null);
        })
        .catch((e) => {
          if (!cancelled && !list) setListError((e as Error).message);
        });
    read();
    const id = setInterval(read, LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all = useMemo(() => list?.data ?? [], [list]);
  const sports = useMemo(
    () => [...new Set(all.map((f) => f.sportLabel))].sort(),
    [all],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (f) =>
        (sport === 'all' || f.sportLabel === sport) &&
        (!outrightOnly || f.outright) &&
        (!mybetOnly || !!f.mybetId) &&
        (!q || `${f.leagueName} ${f.tournament ?? ''} ${f.name} ${f.mybetName ?? ''}`.toLowerCase().includes(q)),
    );
  }, [all, sport, outrightOnly, mybetOnly, query]);

  // Grouped for the rail by sport; each row carries its own league badge.
  const grouped = useMemo(() => {
    const out: { sport: string; items: FutureItem[] }[] = [];
    for (const f of visible) {
      let s = out[out.length - 1];
      if (!s || s.sport !== f.sportLabel) {
        s = { sport: f.sportLabel, items: [] };
        out.push(s);
      }
      s.items.push(f);
    }
    return out;
  }, [visible]);

  const selected = useMemo(() => all.find((f) => f.id === selectedId) ?? null, [all, selectedId]);

  // The selected future's prices, refreshed every minute while it is open.
  const [odds, setOdds] = useState<{ id: string; markets: MarketGroup[]; books: Bookmaker[] } | null>(null);
  useEffect(() => {
    if (!selected) return;
    const id = selected.id;
    let cancelled = false;
    const read = () =>
      fetchFutureOdds(id)
        .then((rows) => {
          if (cancelled) return;
          const built = buildMarkets(rows, '', '', FUTURES_LEAGUE);
          setOdds({ id, markets: built.groups, books: built.books });
        })
        .catch(() => {
          if (!cancelled) setOdds((o) => (o?.id === id ? o : { id, markets: [], books: [] }));
        });
    read();
    const timer = setInterval(read, ODDS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!selected && odds?.id === selected.id;

  return (
    <div className="flex h-dvh flex-col bg-surface text-slate-200">
      <header className="shrink-0 border-b border-surface-border bg-surface">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500 transition hover:text-slate-300"
          >
            <ArrowLeft size={14} /> Board
          </Link>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-100">
              <Trophy size={16} className="text-amber-300" />
              Futures
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Outright winners from the books that price futures, beside mybet&apos;s own
            </p>
          </div>
          {list && (
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
              <span>
                <b className="text-slate-300 tabular-nums">{list.count}</b> futures
              </span>
              <span title="mybet futures joined to the same proposition on the odds surface">
                <b className="text-emerald-300 tabular-nums">{list.matched}</b> of {list.mybet} mybet matched
              </span>
            </div>
          )}
          <span className="ml-auto">
            <SignOut />
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* the catalogue */}
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-surface-border bg-surface">
          <div className="shrink-0 space-y-2 border-b border-surface-border p-3">
            <label className="flex items-center gap-2 rounded-md border border-surface-border bg-surface px-2 py-1.5">
              <Search size={13} className="shrink-0 text-slate-600" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search league or market"
                className="min-w-0 flex-1 bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
              />
            </label>
            <select
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              className="w-full rounded-md border border-surface-border bg-surface px-2 py-1.5 text-xs text-slate-300 outline-none"
            >
              <option value="all">All sports</option>
              {sports.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="space-y-0.5">
              <Toggle on={outrightOnly} onChange={setOutrightOnly}>Outright only</Toggle>
              <Toggle on={mybetOnly} onChange={setMybetOnly}>Priced by mybet</Toggle>
            </div>
          </div>

          <div className="shrink-0 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            {list ? `${visible.length} futures` : 'Futures'}
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
            {!list && !listError && <RowsSkeleton rows={10} lead="w-12" />}
            {listError && (
              <div className="px-2 py-8 text-center text-sm text-red-400">{listError}</div>
            )}
            {list && grouped.length === 0 && (
              <div className="px-2 py-8 text-center text-sm text-slate-600">No futures match these filters.</div>
            )}
            {grouped.map((s) => (
              <div key={s.sport}>
                <div className="sticky top-0 z-10 bg-surface px-2 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  {s.sport}
                </div>
                {s.items.map((f) => (
                  <FutureRow key={f.id} f={f} selected={f.id === selectedId} onSelect={setSelectedId} />
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* the grid */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {selected ? (
            <EventDetail
              event={toEvent(selected)}
              now={now}
              markets={odds?.id === selected.id ? odds.markets : []}
              books={odds?.id === selected.id ? odds.books : []}
              loading={!ready}
              oddsView="pre"
              onOddsView={() => {}}
              future
            />
          ) : (
            <Placeholder text={list ? 'Select a future' : 'Loading futures…'} />
          )}
        </main>
      </div>
    </div>
  );
}
