import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Clock, Hourglass, Link2, LogOut, Radio, TrendingDown, Users as UsersIcon } from 'lucide-react';
import { Link, Outlet, useMatch, useNavigate } from 'react-router-dom';
import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { EventRow } from './components/EventRow';
import { ScoreboardBar } from './components/ScoreboardBar';
import { PulseBar } from './components/PulseBar';
import { RailSkeleton, TickerSkeleton } from './components/Skeleton';
import {
  fetchAllEvents,
  fetchEventsForDay,
  fetchH2HPrices,
  fetchEventById,
  fetchPulse,
  searchEvents,
  SEARCH_MIN_CHARS,
  type H2HPrices,
  type Pulse,
} from './lib/db';
import { effectiveStatus } from './lib/countdown';
import { useCapabilities } from './lib/capabilitiesContext';
import { useAuth } from './lib/useAuth';
import { eventPath } from './lib/routing';
import type { EventStatus, SportEvent } from './lib/types';
import type { LayoutContext } from './EventView';

/**
 * Who is signed in, pinned to the very bottom of the rail.
 *
 * Users sits here rather than in the nav above because it is administration,
 * not part of the desk — and it only appears for the admins who can use it.
 */
function SignedInAs() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <div className="shrink-0 border-t border-surface-border p-2">
      {user.role === 'admin' && (
        <Link
          to="/users"
          className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
        >
          <UsersIcon size={14} />
          Users
        </Link>
      )}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[11px] font-semibold uppercase text-emerald-300">
          {user.username.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-slate-200">{user.username}</span>
          <span className="block text-[10px] uppercase tracking-wide text-slate-600">{user.role}</span>
        </span>
        <button
          type="button"
          onClick={signOut}
          title="Sign out"
          className="shrink-0 rounded-md p-1.5 text-slate-600 transition hover:bg-white/5 hover:text-slate-300"
        >
          <LogOut size={14} />
        </button>
      </div>
    </div>
  );
}

const STATUS_ORDER: Record<EventStatus, number> = {
  live: 0,
  upcoming: 1,
  final: 2,
  cancelled: 3,
};

/**
 * `effectiveStatus` takes a clock and ignores it — status comes from the feed's
 * own signals (`status`, `is_live`, a stamped `actualStart`), never from whether
 * a start time has passed. Passing this instead of `now` says so at the call
 * site, and keeps the 1s tick out of dependency arrays that do not need it.
 */
const NO_CLOCK = 0;

/** Status rank, for sorting. Clock-independent — see NO_CLOCK. */
const rankOf = (e: SportEvent) => STATUS_ORDER[effectiveStatus(e, NO_CLOCK)];

const MIN_MS = 60_000;

// The ticker is a next-to-jump strip: live now plus anything starting within a
// day. Live games always qualify (they started in the past); this only bounds
// how far ahead upcoming fixtures reach.
const TICKER_HORIZON_MS = 24 * 60 * 60 * 1000;
/** Cards in the top strip. Soonest first, so the cap only ever trims the far end. */
const TICKER_UPCOMING_MAX = 80;
/** How many finished games the ticker falls back to when nothing is due. */
const TICKER_RESULTS_MAX = 40;

/**
 * The league filter option/key. Keyed on the (category, name) PAIR, not name
 * alone — "Hamburg" is both an ATP and a WTA tournament, so they must stay
 * distinct ("ATP · Hamburg" / "WTA · Hamburg").
 */
function leagueLabel(e: SportEvent): string {
  const { category, name } = e.league;
  return category && category !== name ? `${category} · ${name}` : name;
}

/** Local YYYY-MM-DD for date-filter comparison. */
function localDay(value: string | number | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** True if the event falls on `date` (multi-day events match any day in range). */
function onDate(e: SportEvent, date: string): boolean {
  if (!date) return true;
  const start = localDay(e.startsAt);
  const end = e.endsAt ? localDay(e.endsAt) : start;
  return date >= start && date <= end;
}

/** Does this event name a team/player matching the (lowercased) search term? */
function matchesQuery(e: SportEvent, q: string): boolean {
  return (
    e.home.toLowerCase().includes(q) ||
    e.away.toLowerCase().includes(q) ||
    e.name.toLowerCase().includes(q) ||
    (e.subtitle ?? '').toLowerCase().includes(q)
  );
}

// Filters survive a page refresh via localStorage. `dateTouched` distinguishes
// "still on the auto-today default" (rolls forward to today on a new day) from
// a date the user actually picked or cleared (restored exactly).
// Namespaced to this app: every Vite dev server shares the `localhost:5173`
// origin, so an unqualified key is read and written by whichever project last
// ran on that port — which is how a stale date from a sibling app ends up
// deciding what this board opens on.
const FILTERS_KEY = 'sports-odds-desk.filters.v1';
/** The key this app used before it was renamed; read once, then retired. */
const LEGACY_FILTERS_KEY = 'arb-tracker-mongo.filters.v1';
interface StoredFilters {
  sport: string[];
  league: string[];
  date: string;
  dateTouched: boolean;
}

let cachedFilters: StoredFilters | null = null;
function initialFilters(): StoredFilters {
  if (cachedFilters) return cachedFilters;
  const today = localDay(Date.now());
  const fallback: StoredFilters = { sport: [], league: [], date: today, dateTouched: false };
  try {
    // Fall back to the pre-rename key so a rename doesn't silently reset
    // whatever filters someone had set.
    const raw = localStorage.getItem(FILTERS_KEY) ?? localStorage.getItem(LEGACY_FILTERS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<StoredFilters>;
      cachedFilters = {
        sport: Array.isArray(s.sport) ? s.sport : [],
        league: Array.isArray(s.league) ? s.league : [],
        date: s.dateTouched ? (s.date ?? '') : today,
        dateTouched: !!s.dateTouched,
      };
      return cachedFilters;
    }
  } catch {
    // corrupt/unavailable storage — fall through to defaults
  }
  cachedFilters = fallback;
  return fallback;
}

export default function App() {
  const navigate = useNavigate();
  // The mapping page reads tables the public odds surface does not publish.
  const caps = useCapabilities();
  /*
   * A trading account is refused the movers page and the mapping tables by the
   * server, so those two links are not offered to it — a link that 403s is
   * worse than no link. Everything else in the rail is within its reach.
   */
  const { user } = useAuth();
  const deskOnly = user?.role !== 'trading';
  const match = useMatch('/event/:slug/:fixtureId');
  const activeId = match?.params.fixtureId ?? null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  /*
   * The same clock, to the NEAREST minute.
   *
   * Most of this page counts in minutes, hours or days; only the mm:ss
   * countdown on a fixture inside half an hour needs the second. A derived
   * value rather than a second timer: it is a new number only sixty times an
   * hour, so anything keyed on it recomputes then and not in between.
   *
   * Nearest, not floor, and that is not a detail. `relativeLabel` renders
   * `Math.round(ms / MIN)`, so rounding the clock the same way lands on the
   * same minute it would have: checked across a minute of offsets on all 1,834
   * upcoming rows, every label is identical. Flooring instead drifts 413 of
   * them by a minute for the back half of every minute — reading "1h 2m" where
   * the second-accurate clock says "1h 1m".
   */
  const minute = Math.round(now / MIN_MS) * MIN_MS;

  // --- events ---
  const [events, setEvents] = useState<SportEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  // Past days (older than the live window) are fetched on demand when picked and
  // merged in. Kept separate so the 60s live poll (which replaces `events`)
  // doesn't wipe them.
  const [pastEvents, setPastEvents] = useState<SportEvent[]>([]);
  const [loadedDays, setLoadedDays] = useState<Set<string>>(new Set());
  const [pastLoading, setPastLoading] = useState(false);
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

  // --- feed pulse ---
  // Freshness of the sources behind the board, refreshed on the same 60s beat
  // as the events themselves. Failures leave the last reading in place rather
  // than blanking the bar — a blip shouldn't read as an outage.
  const [pulses, setPulses] = useState<Pulse[]>([]);
  useEffect(() => {
    // An instance reading the public odds surface has no write timestamps to
    // report, so there is nothing to poll for.
    if (!caps.pulse) {
      setPulses([]);
      return;
    }
    let cancelled = false;
    const read = () =>
      fetchPulse()
        .then((p) => !cancelled && setPulses(p))
        .catch(() => {});
    read();
    const id = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [caps.pulse]);

  // --- filters (restored from localStorage so they survive a refresh) ---
  const [sportSel, setSportSel] = useState<string[]>(() => initialFilters().sport);
  const [leagueSel, setLeagueSel] = useState<string[]>(() => initialFilters().league);
  // The rail is a single day's board — default to today. Clearing the pill
  // widens it back to every fixture we hold.
  const [date, setDate] = useState(() => initialFilters().date);
  const [dateTouched, setDateTouched] = useState(() => initialFilters().dateTouched);

  // Persist filters whenever they change.
  useEffect(() => {
    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({ sport: sportSel, league: leagueSel, date, dateTouched }),
      );
    } catch {
      // storage unavailable — filters just won't persist
    }
  }, [sportSel, leagueSel, date, dateTouched]);

  // Browsing a past day: the live window only holds ~48h, so fetch older days on
  // demand and merge them in (deduped, cached per day).
  useEffect(() => {
    const today = localDay(Date.now());
    if (!date || date >= today || loadedDays.has(date)) return;
    let cancelled = false;
    setPastLoading(true);
    fetchEventsForDay(date)
      .then((evs) => {
        if (cancelled) return;
        setPastEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...evs.filter((e) => !seen.has(e.id))];
        });
        setLoadedDays((prev) => new Set(prev).add(date));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPastLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, loadedDays]);

  // --- team/player search ---
  // Search is not a filter: it runs against the whole archive and ignores the
  // sport/league/date pills entirely, so a competitor can be found from
  // wherever the rail happens to be pointing.
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SportEvent[]>([]);
  const [searching, setSearching] = useState(false);
  const searchActive = query.trim().length >= SEARCH_MIN_CHARS;

  useEffect(() => {
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    // Debounced so a fast typist fires one query, not one per keystroke.
    const timer = setTimeout(() => {
      searchEvents(q)
        .then((r) => !cancelled && setSearchResults(r))
        .catch(() => {})
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // A link can name an event the board isn't holding — one older than the
  // rolling window, or simply not matching the current filters. The URL wins:
  // fetch it by id and keep it, so the page opens what it says it opens.
  const [linked, setLinked] = useState<SportEvent[]>([]);
  // Ids we've already been to the database for. "Event not found" is only
  // honest once the lookup has had its turn — until then the page is loading.
  const [linkTried, setLinkTried] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!activeId) return;
    if (events.some((e) => e.id === activeId)) return;
    if (pastEvents.some((e) => e.id === activeId)) return;
    if (linked.some((e) => e.id === activeId)) return;
    if (linkTried.has(activeId)) return;
    let cancelled = false;
    fetchEventById(activeId)
      .then((e) => {
        if (!cancelled && e) setLinked((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLinkTried((prev) => new Set(prev).add(activeId));
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, events, pastEvents, linked, linkTried]);

  // Live window + any on-demand past days, deduped by id.
  const allEvents = useMemo(() => {
    if (pastEvents.length === 0) return events;
    const seen = new Set(events.map((e) => e.id));
    return [...events, ...pastEvents.filter((e) => !seen.has(e.id))];
  }, [events, pastEvents]);

  // Everything we hold — the board plus search hits from outside its window.
  // The detail route resolves the open fixture from this, so an event found by
  // search can be opened even though the board never loaded it.
  const knownEvents = useMemo(() => {
    const extra = [...searchResults, ...linked];
    if (extra.length === 0) return allEvents;
    const seen = new Set(allEvents.map((e) => e.id));
    const merged = [...allEvents];
    for (const e of extra) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    return merged;
  }, [allEvents, searchResults, linked]);

  function handleDate(v: string) {
    setDate(v);
    setDateTouched(true);
  }

  // Below md the rail is a drawer, hidden until the logo opens it; from md up
  // it's always in-flow and this flag is inert (md: styles override it).
  const [railOpen, setRailOpen] = useState(false);

  const sportOptions = useMemo(
    () => Array.from(new Set(allEvents.map((e) => e.sport))).sort(),
    [allEvents],
  );

  // Leagues shown in the filter are scoped to the selected sport(s) AND date —
  // so the dropdown only lists competitions that actually have events that day.
  const leagueOptions = useMemo(() => {
    const inScope = allEvents.filter(
      (e) => (sportSel.length === 0 || sportSel.includes(e.sport)) && onDate(e, date),
    );
    return Array.from(new Set(inScope.map(leagueLabel))).sort();
  }, [allEvents, sportSel, date]);

  function handleSport(next: string[]) {
    setSportSel(next);
    const allowed = new Set(
      allEvents
        .filter((e) => (next.length === 0 || next.includes(e.sport)) && onDate(e, date))
        .map(leagueLabel),
    );
    setLeagueSel((prev) => prev.filter((l) => allowed.has(l)));
  }

  // The filtered slate (no clock dependency), then sorted next-to-jump. Keeping
  // these separate means the H2H fetch keys off filters, not the 1s tick.
  const filtered = useMemo(
    () =>
      allEvents.filter((e) => {
        if (sportSel.length && !sportSel.includes(e.sport)) return false;
        if (leagueSel.length && !leagueSel.includes(leagueLabel(e))) return false;
        if (!onDate(e, date)) return false;
        return true;
      }),
    [allEvents, sportSel, leagueSel, date],
  );

  // Search hits: everything on the board that names the competitor (instant,
  // always current) plus the archive rows the query returned (which can reach
  // outside the board window, and cover golf fields whose player names live in
  // the odds rather than the fixture).
  const searchHits = useMemo(() => {
    if (!searchActive) return [];
    const q = query.trim().toLowerCase();
    const local = allEvents.filter((e) => matchesQuery(e, q));
    const seen = new Set(local.map((e) => e.id));
    return [...local, ...searchResults.filter((e) => !seen.has(e.id))];
  }, [searchActive, query, allEvents, searchResults]);

  // Next to jump: live first, then soonest upcoming, finals last. Search results
  // sort the same way, except finished events run most-recent-first — looking a
  // team up, last week's result matters more than one from a year ago.
  /*
   * No `now` in the dependencies, deliberately.
   *
   * It was there, and it did nothing: `effectiveStatus` takes the clock as
   * `_now` and never reads it — status comes from the feed's own signals, not
   * from whether a start time has passed. So this re-sorted the whole slate
   * once a second to produce a provably identical array, and handed back a new
   * array IDENTITY each time, which is the part that cost something: every
   * memo downstream of `visible` was invalidated every second, and the rail's
   * rows could never be skipped by React no matter what else was done.
   *
   * The sort itself is only ~1.6ms on 2,527 events, so this is not about the
   * sort. It is about `visible` being a stable value between polls.
   */
  const visible = useMemo(() => {
    const rows = searchActive ? searchHits : filtered;
    /*
     * Keyed, then sorted on the keys.
     *
     * `new Date(...)` used to be called inside the comparator, which is two
     * parses per comparison — about 5,000 of them per sort, where there are
     * only as many distinct timestamps as there are events.
     */
    const keyed = rows.map((e) => ({
      e,
      rank: rankOf(e),
      // `actualStart` where there is one: scheduled_start is Optic's
      // not-before slot and tennis never replaces it, so a match already in
      // play can carry a start time hours out and sorted among the live rows as
      // though it had not begun.
      t: new Date(e.actualStart ?? e.startsAt).getTime(),
    }));
    keyed.sort((a, b) =>
      a.rank !== b.rank
        ? a.rank - b.rank
        : searchActive && a.rank >= STATUS_ORDER.final
          ? b.t - a.t
          : a.t - b.t,
    );
    const sorted = keyed.map((k) => k.e);
    // Whatever is open stays in the rail even when the filters exclude it —
    // otherwise the page shows an event the list says isn't there, and the
    // highlighted row has nowhere to be.
    if (!activeId || sorted.some((e) => e.id === activeId)) return sorted;
    const open = knownEvents.find((e) => e.id === activeId);
    return open ? [open, ...sorted] : sorted;
  }, [searchActive, searchHits, filtered, activeId, knownEvents]);

  // The top ticker ignores the rail's filters — live now plus everything within
  // the next 24h, finals dropped, live first then soonest to jump.
  //
  // When nothing is live or upcoming it falls back to the most recent results
  // instead of rendering an empty strip. That is the normal state of a
  // deployment reading the public odds surface, which publishes closing prices
  // and therefore carries no future fixtures at all — but it is just as useful
  // on a quiet morning on the full build.
  /*
   * On the MINUTE clock, not the second one.
   *
   * The only real use of the clock here is the horizon — "starting within the
   * next 24 hours" — and a 24-hour boundary does not need resolving to the
   * second. Everything else asked `effectiveStatus`, which ignores the clock.
   * So this filtered, sorted and sliced 2,527 events sixty times a minute to
   * produce the same strip; now it does it once, and the cards below keep their
   * own 1s countdowns either way.
   */
  const tickerEvents = useMemo(() => {
    const playable = events.filter(
      (e) => rankOf(e) !== STATUS_ORDER.cancelled && !e.outright,
    );

    const upcoming = playable
      .filter(
        (e) =>
          rankOf(e) !== STATUS_ORDER.final &&
          new Date(e.startsAt).getTime() < minute + TICKER_HORIZON_MS,
      )
      .map((e) => ({ e, rank: rankOf(e), t: new Date(e.startsAt).getTime() }))
      .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.t - b.t))
      .map((k) => k.e)
      /*
       * Capped, like the results branch below always was.
       *
       * This strip is live-and-next-up, not the whole day, and it scrolls
       * horizontally — nobody reaches card four hundred. It was unbounded
       * because the deployed board only ever had a few hundred upcoming
       * fixtures to give it; once the board started carrying the real schedule
       * that became 1,988 cards, each with crests, a badge and two price lines,
       * and the page stopped reaching idle at all.
       */
      .slice(0, TICKER_UPCOMING_MAX);

    if (upcoming.length > 0) return upcoming;

    // Most recently finished first, capped — a results strip, not the archive.
    return playable
      .filter((e) => rankOf(e) === STATUS_ORDER.final)
      .map((e) => ({ e, t: new Date(e.startsAt).getTime() }))
      .sort((a, b) => b.t - a.t)
      .map((k) => k.e)
      .slice(0, TICKER_RESULTS_MAX);
  }, [events, minute]);

  /*
   * Best H2H price for the ticker's upcoming fixtures.
   *
   * This does NOT wait for the board. /api/h2h takes no parameters and returns
   * the whole board's map, which the ticker looks up by id, so keying the
   * effect on the loaded events only made two independent requests run one
   * after the other -- the board's own second, and then this one's. It goes out
   * on mount alongside them, and refreshes on the same 60s nonce the board
   * does.
   */
  const [prices, setPrices] = useState<Map<string, H2HPrices>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetchH2HPrices()
      .then((m) => !cancelled && setPrices(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [oddsNonce]);

  // Land on the first event when none is selected in the URL.
  useEffect(() => {
    if (activeId) return;
    if (visible.length > 0) navigate(eventPath(visible[0]), { replace: true });
  }, [activeId, visible, navigate]);

  // Heading tracks whatever the list is showing — the search term while a
  // search is running, otherwise the filtered day.
  const dateHeading = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'All dates';
  const listHeading = searchActive
    ? `${visible.length} match${visible.length === 1 ? '' : 'es'} for “${query.trim()}”`
    : dateHeading;

  const outletContext: LayoutContext = {
    events: knownEvents,
    now,
    eventsLoading,
    oddsNonce,
    linkResolving: !!activeId && !knownEvents.some((e) => e.id === activeId) && !linkTried.has(activeId),
  };

  /*
   * Opening an event from the rail also closes the mobile drawer.
   *
   * Takes an id and is wrapped, so the rail's rows get the SAME function on
   * every render. It used to be an inline `onSelect={() => openEvent(event)}`,
   * a fresh closure per row per render, which is enough on its own to stop
   * `memo` ever skipping a row.
   */
  const selectEvent = useCallback(
    (id: string) => {
      const event = knownEvents.find((e) => e.id === id);
      if (!event) return;
      navigate(eventPath(event));
      setRailOpen(false);
    },
    [knownEvents, navigate],
  );

  /*
   * The clock each row actually needs, which for almost all of them is not the
   * one that ticks every second.
   *
   * `countdownFor` returns a constant for live, final and cancelled rows, mm:ss
   * for a fixture inside half an hour, and minutes-or-coarser beyond that. So a
   * row gets the second only while it is genuinely counting seconds; everything
   * else gets the minute clock, and the rows whose label cannot change get a
   * fixed number and never re-render at all.
   *
   * Start times are parsed once per slate rather than once per row per second.
   */
  const startMs = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of visible) m.set(e.id, new Date(e.startsAt).getTime());
    return m;
  }, [visible]);

  const clockFor = (event: SportEvent): number => {
    if (rankOf(event) !== STATUS_ORDER.upcoming) return NO_CLOCK;
    const ms = (startMs.get(event.id) ?? 0) - now;
    return ms > 0 && ms <= 30 * MIN_MS ? now : minute;
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Pulse check on the feeds — above everything, including the ticker. */}
      {/* Nothing to report is not the same as everything being stale — an
          instance without write timestamps hides the bar rather than showing a
          row of blanks. */}
      {caps.pulse && <PulseBar pulses={pulses} now={now} />}

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
          <span className="text-[15px] font-semibold tracking-tight">Sports Odds Desk</span>
        </button>
      </div>

      {/* Top ticker: live + upcoming across everything, ignoring the filters. */}
      {eventsLoading && events.length === 0 ? (
        <TickerSkeleton />
      ) : (
      <ScoreboardBar
        events={tickerEvents}
        now={now}
        prices={prices}
        activeId={activeId}
        onSelect={(event) => navigate(eventPath(event))}
      />
      )}

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
              onDate={handleDate}
              sportSel={sportSel}
              sportOptions={sportOptions}
              onSport={handleSport}
              leagueSel={leagueSel}
              leagueOptions={leagueOptions}
              onLeague={setLeagueSel}
              query={query}
              onQuery={setQuery}
              searching={searching}
            />
          </div>

          <div className="shrink-0 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            {listHeading}
          </div>

          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
            {eventsError ? (
              <div className="px-2 py-8 text-center text-sm text-red-400">
                {eventsError}
              </div>
            ) : (eventsLoading && events.length === 0) ||
              (pastLoading && visible.length === 0) ||
              (searching && visible.length === 0) ? (
              // Fewer bones while searching: a query usually returns a handful,
              // and eight would promise more than is coming.
              <RailSkeleton rows={searching ? 4 : 8} />
            ) : visible.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-slate-600">
                {searchActive
                  ? `No teams or players match “${query.trim()}”.`
                  : 'No events match these filters.'}
              </div>
            ) : (
              visible.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  now={clockFor(event)}
                  selected={event.id === activeId}
                  onSelect={selectEvent}
                />
              ))
            )}
          </nav>
          {/* Pinned to the bottom of the rail, below the scrolling event list. */}
          <div className="shrink-0 border-t border-surface-border p-2">
            {/* Movers reads the same price ladder the board already holds, so
                it works on either source — no mapping tables involved. */}
            {deskOnly && (
              <Link
                to="/movers"
                className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
              >
                <TrendingDown size={14} />
                Movers
              </Link>
            )}
            {/* Both read the bets cluster, so both are shown wherever the
                ticker is — and to every role, trading included. */}
            {caps.bets && (
              <>
                <Link
                  to="/settlement"
                  className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                >
                  <Clock size={14} />
                  Settlement
                </Link>
                <Link
                  to="/late-bets"
                  className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                >
                  <AlertTriangle size={14} />
                  Late Bets
                </Link>
                {/* Admin only, matching ADMIN_ONLY on the server. */}
                {user?.role === 'admin' && (
                  <Link
                    to="/pending"
                    className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                  >
                    <Hourglass size={14} />
                    Pending Bets
                  </Link>
                )}
              </>
            )}
          </div>
          {/*
            Gated per link, not per block.
            The Ticker sat inside `caps.mapping` and so was switched by the
            tournament mapping tables, which it has nothing to do with — it
            reads the bets cluster, exactly like Settlement and Late Bets above.
            It showed anyway because the mirror makes `caps.mapping` true, so
            the two were only ever accidentally equal; the board is the admin
            landing page and the Ticker is the tab you leave it by, which is not
            a thing to leave resting on a coincidence.
          */}
          {(caps.bets || caps.mapping) && (
            <div className="shrink-0 border-t border-surface-border p-2">
              {caps.bets && (
                <Link
                  to="/ticker"
                  className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                >
                  <Radio size={14} />
                  Ticker
                </Link>
              )}
              {caps.mapping && deskOnly && (
                <Link
                  to="/mapping"
                  className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                >
                  <Link2 size={14} />
                  Mapping
                </Link>
              )}
            </div>
          )}
          <SignedInAs />
        </aside>

        {/* Main: routed event detail — pinned info bar + scrolling grid */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet context={outletContext} />
        </main>
      </div>
    </div>
  );
}
