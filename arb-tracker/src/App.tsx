import { useEffect, useMemo, useState } from 'react';
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

const STATUS_ORDER: Record<EventStatus, number> = { live: 0, upcoming: 1, final: 2 };

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

  // Best H2H price for the scoreboard's upcoming (not-yet-played) fixtures.
  // Keyed on the fixture set + oddsNonce, so it refetches on the 60s poll but
  // not every render.
  const [prices, setPrices] = useState<Map<string, H2HPrices>>(new Map());
  const upcomingKey = useMemo(
    () =>
      filtered
        .filter((e) => e.homeScore == null || e.awayScore == null)
        .map((e) => e.id)
        .sort()
        .join(','),
    [filtered],
  );
  useEffect(() => {
    const ids = new Set(upcomingKey ? upcomingKey.split(',') : []);
    if (ids.size === 0) {
      setPrices(new Map());
      return;
    }
    let cancelled = false;
    fetchH2HPrices(filtered.filter((e) => ids.has(e.id)))
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

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Top ticker: the whole slate at a glance */}
      <ScoreboardBar
        events={visible}
        now={now}
        prices={prices}
        activeId={activeId}
        onSelect={(event) => navigate(eventPath(event))}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left rail: brand, filters, then the next-to-jump list */}
        <aside className="flex w-[320px] shrink-0 flex-col overflow-hidden border-r border-surface-border">
          <Header />
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
                  onSelect={() => navigate(eventPath(event))}
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
