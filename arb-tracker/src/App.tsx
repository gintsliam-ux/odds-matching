import { useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { Outlet, useMatch, useNavigate } from 'react-router-dom';
import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { EventRow } from './components/EventRow';
import { ScoreboardBar } from './components/ScoreboardBar';
import { fetchAllEvents, fetchH2HPrices, type H2HPrices } from './lib/db';
import { effectiveStatus } from './lib/countdown';
import { eventPath } from './lib/routing';
import type { EventStatus, SportEvent } from './lib/types';
import type { LayoutContext } from './EventView';

const STATUS_ORDER: Record<EventStatus, number> = {
  live: 0,
  upcoming: 1,
  final: 2,
  cancelled: 3,
};

// The ticker is a next-to-jump strip: live now plus anything starting within a
// day. Live games always qualify (they started in the past); this only bounds
// how far ahead upcoming fixtures reach.
const TICKER_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Local YYYY-MM-DD for date-filter comparison. */
function localDay(value: string | number | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export default function App() {
  const navigate = useNavigate();
  const match = useMatch('/event/:slug/:fixtureId');
  const activeId = match?.params.fixtureId ?? null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // --- events ---
  const [events, setEvents] = useState<SportEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  // Bumped by the background poll so the open event's odds refresh in step.
  const [oddsNonce, setOddsNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchAllEvents()
      .then((e) => {
        if (cancelled) return;
        setEvents(e);
        setEventsError(null);
      })
      .catch((e) => {
        if (!cancelled) setEventsError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The board auto-polls — no manual refresh. Pull fresh events (statuses, new
  // fixtures) every 60s and nudge the open event's odds to reload with them.
  useEffect(() => {
    const id = setInterval(() => {
      fetchAllEvents()
        .then((e) => {
          setEvents(e);
          setOddsNonce((n) => n + 1);
        })
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // --- filters ---
  const [sportSel, setSportSel] = useState<string[]>([]);
  const [leagueSel, setLeagueSel] = useState<string[]>([]);
  // The rail is a single day's board — default to today. Clearing the pill
  // widens it back to every fixture we hold.
  const [date, setDate] = useState(() => localDay(Date.now()));

  // Below md the rail is a drawer, hidden until the logo opens it; from md up
  // it's always in-flow and this flag is inert (md: styles override it).
  const [railOpen, setRailOpen] = useState(false);

  const sportOptions = useMemo(
    () => Array.from(new Set(events.map((e) => e.sport))).sort(),
    [events],
  );

  const leagueOptions = useMemo(() => {
    const inSport = events.filter(
      (e) => sportSel.length === 0 || sportSel.includes(e.sport),
    );
    return Array.from(new Set(inSport.map((e) => e.league.name))).sort();
  }, [events, sportSel]);

  function handleSport(next: string[]) {
    setSportSel(next);
    const allowed = new Set(
      events
        .filter((e) => next.length === 0 || next.includes(e.sport))
        .map((e) => e.league.name),
    );
    setLeagueSel((prev) => prev.filter((l) => allowed.has(l)));
  }

  // The filtered slate (no clock dependency), then sorted next-to-jump. Keeping
  // these separate means the H2H fetch keys off filters, not the 1s tick.
  const filtered = useMemo(
    () =>
      events.filter((e) => {
        if (sportSel.length && !sportSel.includes(e.sport)) return false;
        if (leagueSel.length && !leagueSel.includes(e.league.name)) return false;
        if (date && localDay(e.startsAt) !== date) return false;
        return true;
      }),
    [events, sportSel, leagueSel, date],
  );

  // Next to jump: live first, then soonest upcoming, finals last.
  const visible = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const sa = STATUS_ORDER[effectiveStatus(a, now)];
        const sb = STATUS_ORDER[effectiveStatus(b, now)];
        if (sa !== sb) return sa - sb;
        return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
      }),
    [filtered, now],
  );

  // The top ticker ignores the rail's filters — live now plus everything within
  // the next 24h, finals dropped, live first then soonest to jump.
  const tickerEvents = useMemo(
    () =>
      events
        .filter((e) => {
          const s = effectiveStatus(e, now);
          // Only live/upcoming belong on the ticker — no finals, no cancelled.
          return (
            s !== 'final' &&
            s !== 'cancelled' &&
            new Date(e.startsAt).getTime() < now + TICKER_HORIZON_MS
          );
        })
        .sort((a, b) => {
          const sa = STATUS_ORDER[effectiveStatus(a, now)];
          const sb = STATUS_ORDER[effectiveStatus(b, now)];
          if (sa !== sb) return sa - sb;
          return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
        }),
    [events, now],
  );

  // Best H2H price for the ticker's upcoming (not-yet-played) fixtures. Keyed on
  // all unplayed events — not the filtered set — since the ticker is filter-
  // independent; refetches on the 60s poll, not every render.
  const [prices, setPrices] = useState<Map<string, H2HPrices>>(new Map());
  const upcomingKey = useMemo(
    () =>
      events
        .filter((e) => e.homeScore == null || e.awayScore == null)
        .map((e) => e.id)
        .sort()
        .join(','),
    [events],
  );
  useEffect(() => {
    const ids = new Set(upcomingKey ? upcomingKey.split(',') : []);
    // Only the fixtures the ticker can actually show — unplayed and within the
    // horizon. Date.now() here (not `now`) keeps the effect off the 1s tick.
    const horizon = Date.now() + TICKER_HORIZON_MS;
    const windowed = events.filter(
      (e) => ids.has(e.id) && new Date(e.startsAt).getTime() < horizon,
    );
    if (windowed.length === 0) {
      setPrices(new Map());
      return;
    }
    let cancelled = false;
    fetchH2HPrices(windowed)
      .then((m) => !cancelled && setPrices(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingKey, oddsNonce]);

  // Land on the first event when none is selected in the URL.
  useEffect(() => {
    if (activeId) return;
    if (visible.length > 0) navigate(eventPath(visible[0]), { replace: true });
  }, [activeId, visible, navigate]);

  // Heading tracks the filtered day, so it can never disagree with the list.
  const dateHeading = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'All dates';

  const outletContext: LayoutContext = { events, now, eventsLoading, oddsNonce };

  // Opening an event from the rail also closes the mobile drawer.
  const openEvent = (event: SportEvent) => {
    navigate(eventPath(event));
    setRailOpen(false);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Mobile-only top bar: the logo opens the rail drawer. */}
      <div className="flex items-center gap-2.5 border-b border-surface-border px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setRailOpen(true)}
          aria-label="Open events menu"
          className="flex min-w-0 items-center gap-2.5"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <Activity size={18} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Arb Tracker</span>
        </button>
      </div>

      {/* Top ticker: live + upcoming across everything, ignoring the filters. */}
      <ScoreboardBar
        events={tickerEvents}
        now={now}
        prices={prices}
        activeId={activeId}
        onSelect={(event) => navigate(eventPath(event))}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* Backdrop behind the open drawer (mobile only). */}
        {railOpen && (
          <button
            type="button"
            aria-label="Close events menu"
            onClick={() => setRailOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
          />
        )}

        {/* Left rail: an in-flow column from md up; a slide-in drawer below it.
            On mobile the brand logo doubles as the close control. */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-[300px] flex-col overflow-hidden border-r border-surface-border bg-surface shadow-2xl transition-transform duration-200 md:static md:z-auto md:w-[320px] md:shrink-0 md:translate-x-0 md:shadow-none ${
            railOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <Header onLogoClick={() => setRailOpen(false)} />
          <div className="shrink-0 border-b border-surface-border p-3">
            <FilterBar
              date={date}
              onDate={setDate}
              sportSel={sportSel}
              sportOptions={sportOptions}
              onSport={handleSport}
              leagueSel={leagueSel}
              leagueOptions={leagueOptions}
              onLeague={setLeagueSel}
            />
          </div>

          <div className="shrink-0 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            {dateHeading}
          </div>

          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
            {eventsError ? (
              <div className="px-2 py-8 text-center text-sm text-red-400">
                {eventsError}
              </div>
            ) : eventsLoading && events.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-slate-600">
                Loading events…
              </div>
            ) : visible.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-slate-600">
                No events match these filters.
              </div>
            ) : (
              visible.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  now={now}
                  selected={event.id === activeId}
                  onSelect={() => openEvent(event)}
                />
              ))
            )}
          </nav>
        </aside>

        {/* Main: routed event detail — pinned info bar + scrolling grid */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet context={outletContext} />
        </main>
      </div>
    </div>
  );
}
