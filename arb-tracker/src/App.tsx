import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router-dom';
import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { EventRow } from './components/EventRow';
import { fetchAllEvents } from './lib/db';
import { effectiveStatus } from './lib/countdown';
import { eventPath } from './lib/routing';
import type { EventStatus, SportEvent } from './lib/types';
import type { LayoutContext } from './EventView';

const STATUS_ORDER: Record<EventStatus, number> = { live: 0, upcoming: 1, final: 2 };

/** Local YYYY-MM-DD for date-filter comparison. */
function localDay(iso: string): string {
  const d = new Date(iso);
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
  const [oddsNonce, setOddsNonce] = useState(0);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      setEvents(await fetchAllEvents());
      setEventsError(null);
    } catch (e) {
      setEventsError((e as Error).message);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // --- filters ---
  const [sportSel, setSportSel] = useState<string[]>([]);
  const [leagueSel, setLeagueSel] = useState<string[]>([]);
  const [date, setDate] = useState('');

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

  // Next to jump: live first, then soonest upcoming, finals last.
  const visible = useMemo(() => {
    return events
      .filter((e) => {
        if (sportSel.length && !sportSel.includes(e.sport)) return false;
        if (leagueSel.length && !leagueSel.includes(e.league.name)) return false;
        if (date && localDay(e.startsAt) !== date) return false;
        return true;
      })
      .sort((a, b) => {
        const sa = STATUS_ORDER[effectiveStatus(a, now)];
        const sb = STATUS_ORDER[effectiveStatus(b, now)];
        if (sa !== sb) return sa - sb;
        return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
      });
  }, [events, sportSel, leagueSel, date, now]);

  // Land on the first event when none is selected in the URL.
  useEffect(() => {
    if (activeId) return;
    if (visible.length > 0) navigate(eventPath(visible[0]), { replace: true });
  }, [activeId, visible, navigate]);

  const refresh = useCallback(() => {
    loadEvents();
    setOddsNonce((n) => n + 1);
  }, [loadEvents]);

  const dateHeading = new Date(now).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const outletContext: LayoutContext = { events, now, eventsLoading, oddsNonce };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header onRefresh={refresh} refreshing={eventsLoading} />

      <div className="flex min-h-0 flex-1">
        {/* Left rail: next to jump events — scrolls within itself */}
        <aside className="flex w-[320px] shrink-0 flex-col overflow-hidden border-r border-surface-border">
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
