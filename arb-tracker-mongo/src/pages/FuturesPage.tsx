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
    name: f.groupName,
    subtitle: f.variantLabel && f.variantLabel !== 'Main' ? `${f.tabLabel} · ${f.variantLabel}` : f.tabLabel,
    home: '',
    away: '',
    // A future has one date, the feed's; shown once, not as a one-day range.
    startsAt: starts,
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

/** A competition and its futures, one rail row. */
interface Competition {
  id: string;
  name: string;
  sportLabel: string;
  items: FutureItem[];
  /** The outright, or the first market, for the badge, date and default tab. */
  lead: FutureItem;
}

/** Outright first, then the rest by name. */
const byTab = (a: FutureItem, b: FutureItem) =>
  Number(b.outright) - Number(a.outright) ||
  Number(!!(b.mybetId || b.swiftId)) - Number(!!(a.mybetId || a.swiftId)) ||
  a.marketLabel.localeCompare(b.marketLabel);

/** One competition in the rail, drawn like a board row: badge, name, market count, a date chip. */
function CompetitionRow({ c, selected, onSelect }: { c: Competition; selected: boolean; onSelect: (id: string) => void }) {
  const brands = [c.items.some((f) => f.mybetId) && 'mybet', c.items.some((f) => f.swiftId) && 'Swiftbet'].filter(Boolean).join(' + ');
  const opticHas = c.items.some((f) => f.source === 'optic');
  const sub = [`${c.items.length} market${c.items.length === 1 ? '' : 's'}`, brands && (opticHas ? brands : `${brands} only`)].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={() => onSelect(c.lead.id)}
      className={`flex w-full items-center gap-2.5 rounded-lg border-l-2 py-2 pl-2 pr-2 text-left transition-colors ${
        selected ? 'border-emerald-400 bg-emerald-500/10' : 'border-transparent hover:bg-white/5'
      }`}
    >
      <LeagueBadge league={c.lead.league} size={30} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">{c.name}</div>
        <div className="truncate text-xs text-slate-500">{sub}</div>
      </div>
      <span
        className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold tabular-nums ${
          !opticHas ? 'bg-amber-500/15 text-amber-300' : brands ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-slate-400'
        }`}
        title={c.lead.startsAt ? `Feed date ${new Date(c.lead.startsAt).toLocaleDateString()}` : undefined}
      >
        {settleLabel(c.lead.startsAt)}
      </span>
    </button>
  );
}

const Brands = ({ items }: { items: FutureItem[] }) => (
  <>
    {items.some((f) => f.mybetId) && <span className="rounded bg-emerald-500/20 px-1 text-[9px] font-semibold text-emerald-300">MB</span>}
    {items.some((f) => f.swiftId) && <span className="rounded bg-sky-500/20 px-1 text-[9px] font-semibold text-sky-300">SB</span>}
  </>
);

/**
 * The competition's markets as tabs across the top, the brands' ones marked;
 * a tab that holds several pieces of one market (the seeds, the divisions, a
 * Yes/No version) shows them as a second row of buttons.
 */
function MarketTabs({ items, selected, onSelect }: { items: FutureItem[]; selected: FutureItem; onSelect: (id: string) => void }) {
  const tabs: { label: string; items: FutureItem[] }[] = [];
  for (const f of items) {
    const t = tabs.find((x) => x.label === f.tabLabel);
    if (t) t.items.push(f); else tabs.push({ label: f.tabLabel, items: [f] });
  }
  const current = tabs.find((t) => t.label === selected.tabLabel);
  const variants = (current?.items ?? []).slice().sort((a, b) =>
    a.variantLabel.localeCompare(b.variantLabel, undefined, { numeric: true }));
  if (tabs.length < 2 && variants.length < 2) return null;
  return (
    <div className="shrink-0 space-y-1.5 border-b border-surface-border bg-surface px-3 py-2">
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {tabs.map((t) => {
          const active = t.label === selected.tabLabel;
          // A tab opens on its brand-priced piece if it has one, else the main one.
          const open = t.items.find((f) => f.mybetId || f.swiftId) ?? t.items.find((f) => f.variantLabel === 'Main') ?? t.items[0];
          return (
            <button
              key={t.label}
              type="button"
              onClick={() => onSelect(open.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                active
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100'
                  : 'border-surface-border bg-surface-raised text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
              {t.items.length > 1 && <span className="text-[10px] text-slate-500">{t.items.length}</span>}
              <Brands items={t.items} />
            </button>
          );
        })}
      </div>
      {variants.length > 1 && (
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {variants.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onSelect(f.id)}
              className={`flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] transition ${
                f.id === selected.id ? 'bg-white/10 text-slate-100' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {f.variantLabel === 'Main' ? 'Winner' : f.variantLabel}
              <Brands items={[f]} />
            </button>
          ))}
        </div>
      )}
    </div>
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
  const [oursOnly, setOursOnly] = useFlagParam('ours', false);

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
        (!q || `${f.groupName} ${f.leagueName} ${f.tournament ?? ''} ${f.name} ${f.mybetName ?? ''} ${f.swiftName ?? ''}`.toLowerCase().includes(q)),
    );
  }, [all, sport, query]);

  // Competitions, then grouped by sport for the rail. The brand filter keeps
  // a competition when any of its markets is priced by mybet or Swiftbet.
  const competitions = useMemo(() => {
    const byId = new Map<string, FutureItem[]>();
    for (const f of visible) (byId.get(f.groupId) ?? byId.set(f.groupId, []).get(f.groupId)!).push(f);
    const out: Competition[] = [];
    for (const [id, items] of byId) {
      if (oursOnly && !items.some((f) => f.mybetId || f.swiftId)) continue;
      items.sort(byTab);
      out.push({ id, name: items[0].groupName, sportLabel: items[0].sportLabel, items, lead: items[0] });
    }
    // Ours first within a sport, then by name.
    return out.sort((a, b) =>
      a.sportLabel.localeCompare(b.sportLabel) ||
      Number(b.items.some((f) => f.mybetId || f.swiftId)) - Number(a.items.some((f) => f.mybetId || f.swiftId)) ||
      a.name.localeCompare(b.name));
  }, [visible, oursOnly]);
  const grouped = useMemo(() => {
    const out: { sport: string; items: Competition[] }[] = [];
    for (const c of competitions) {
      let s = out[out.length - 1];
      if (!s || s.sport !== c.sportLabel) {
        s = { sport: c.sportLabel, items: [] };
        out.push(s);
      }
      s.items.push(c);
    }
    return out;
  }, [competitions]);

  const selected = useMemo(() => all.find((f) => f.id === selectedId) ?? null, [all, selectedId]);
  // Every market of the selected competition, unfiltered, for the tabs.
  const tabs = useMemo(
    () => (selected ? all.filter((f) => f.groupId === selected.groupId).sort(byTab) : []),
    [all, selected],
  );

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
                <b className="text-emerald-300 tabular-nums">{list.matched}</b> of {list.mybet} mybet and{' '}
                <b className="text-emerald-300 tabular-nums">{list.swiftMatched}</b> of {list.swift} Swiftbet matched
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
              <Toggle on={oursOnly} onChange={setOursOnly}>Priced by mybet or Swiftbet</Toggle>
            </div>
          </div>

          <div className="shrink-0 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            {list ? `${competitions.length} competitions` : 'Futures'}
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
            {!list && !listError && <RowsSkeleton rows={10} lead="w-12" />}
            {listError && (
              <div className="px-2 py-8 text-center text-sm text-red-400">{listError}</div>
            )}
            {list && competitions.length === 0 && (
              <div className="px-2 py-8 text-center text-sm text-slate-600">No futures match these filters.</div>
            )}
            {grouped.map((s) => (
              <div key={s.sport}>
                <div className="sticky top-0 z-10 bg-surface px-2 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  {s.sport}
                </div>
                {s.items.map((c) => (
                  <CompetitionRow key={c.id} c={c} selected={c.id === selected?.groupId} onSelect={setSelectedId} />
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* the grid */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {selected && <MarketTabs items={tabs} selected={selected} onSelect={setSelectedId} />}
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
