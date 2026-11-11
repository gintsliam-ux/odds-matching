import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { EventDetail } from './components/EventDetail';
import { fetchEventById, fetchOdds, type OddsView } from './lib/db';
import { buildMarkets, type Bookmaker, type MarketGroup } from './lib/markets';
import { effectiveStatus } from './lib/countdown';
import { eventPath, eventSlug } from './lib/routing';
import { useParam } from './lib/urlState';
import { EventPageSkeleton } from './components/Skeleton';
import type { SportEvent } from './lib/types';

export interface LayoutContext {
  events: SportEvent[];
  now: number;
  eventsLoading: boolean;
  oddsNonce: number;
  /** True while the URL's fixture is still being looked up by id. */
  linkResolving: boolean;
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

export default function EventView() {
  const { fixtureId, slug } = useParams();
  const { events, now, eventsLoading, linkResolving } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();

  const boardRow = events.find((e) => e.id === fixtureId) ?? null;

  /*
   * In play, the page re-reads its own event every five seconds.
   *
   * The score and clock used to arrive only with the board, which is polled
   * every fifteen seconds and cached for longer at each hop behind it, so a
   * basket could take a minute to show on the page that was open on the
   * game. The single-event read is cached three seconds end to end. The
   * board row stays underneath for everything the re-read does not carry.
   */
  const [liveRow, setLiveRow] = useState<SportEvent | null>(null);
  const selected = useMemo<SportEvent | null>(
    () => (boardRow && liveRow && liveRow.id === boardRow.id ? { ...boardRow, ...liveRow } : boardRow),
    [boardRow, liveRow],
  );
  const boardInPlay = !!boardRow && effectiveStatus(boardRow, now) === 'live';
  useEffect(() => {
    if (!boardRow || !boardInPlay) {
      setLiveRow(null);
      return;
    }
    const id = boardRow.id;
    let cancelled = false;
    const read = () =>
      fetchEventById(id, true)
        .then((row) => {
          if (!cancelled && row && row.id === id) setLiveRow(row);
        })
        .catch(() => {});
    read();
    const timer = setInterval(read, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRow?.id, boardInPlay]);

  /*
   * Pre-match or in-play prices, in the URL like the tab is.
   *
   * The default follows the game: a fixture in play opens on its in-play
   * prices, anything else on pre-match. `useParam` drops a value equal to the
   * default, so the query only carries a choice someone actually made — and
   * when a game kicks off under an untouched page, the default moves with it.
   */
  const inPlay = !!selected && effectiveStatus(selected, now) === 'live';
  const [oddsParam, setOddsParam] = useParam('odds', inPlay ? 'live' : 'pre');
  const oddsView: OddsView = oddsParam === 'live' ? 'live' : 'pre';

  /*
   * The query travels with you between events, so `odds=live` chosen on one
   * game arrived on the next — and a finished or upcoming game opened on an
   * in-play view that is empty or stale. Landing on a game that is not in
   * play puts the view back to pre-match; choosing In-play on THAT page
   * still sticks, because this runs only when the fixture changes.
   */
  useEffect(() => {
    if (selected && !inPlay && oddsParam === 'live') setOddsParam('pre');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  /*
   * The odds are stored WITH the fixture they belong to, and "loading" is
   * derived from that rather than tracked alongside it.
   *
   * It was three pieces of state — markets, books and an oddsLoading flag set
   * inside the effect — and an effect runs after the render that schedules it.
   * So the first frame in which `selected` appeared still had empty markets and
   * a loading flag of false, which is exactly the "No odds available for this
   * event." branch: it flashed on every hard load of an event URL before the
   * skeleton even started. The same frame on a navigation showed the PREVIOUS
   * event's grid, for the same reason.
   *
   * Keyed state cannot be out of step with the render: either what we hold is
   * for the fixture being shown or it isn't, and if it isn't, we are loading.
   */
  const [odds, setOdds] = useState<{
    id: string;
    view: OddsView;
    markets: MarketGroup[];
    books: Bookmaker[];
  } | null>(null);
  // Keyed on the view too: flipping to in-play must not show pre-match rows
  // under an in-play label while the fetch is away.
  const ready = !!selected && odds?.id === selected.id && odds.view === oddsView;
  const markets = ready ? odds!.markets : [];
  const books = ready ? odds!.books : [];

  // Initial load for a newly selected event — the only time we show the loading
  // state (keyed on the fixture id, so it fires on navigation, not on a poll).
  useEffect(() => {
    if (!selected) return;
    const id = selected.id;
    let cancelled = false;
    /*
     * One retry before giving up.
     *
     * A single failed fetch used to empty the grid, and the silent refresh that
     * would have repaired it is 30 seconds away — so one blip showed an event
     * with no prices for half a minute, which reads as the page being broken
     * rather than a request having failed. The retry costs one request on the
     * rare path and nothing on the normal one.
     */
    const view = oddsView;
    const load = (attempt = 0): Promise<void> =>
      fetchOdds(selected, view)
        .then((rows) => {
          if (cancelled) return;
          const built = buildMarkets(rows, selected.home, selected.away, selected.league.id);
          setOdds({ id, view, markets: built.groups, books: built.books });
        })
        .catch((e) => {
          if (cancelled) return;
          if (attempt === 0) {
            return new Promise<void>((r) => setTimeout(r, 1200)).then(() => load(1));
          }
          console.error(e);
          // Stamped with the id so the page stops loading and says so, rather
          // than showing a skeleton for a request that is not coming back.
          setOdds({ id, view, markets: [], books: [] });
        });

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, oddsView]);

  // Silently refresh odds in place — no loading toggle, so the grid never
  // flashes. Every 30s for pre-match; every 10s for in-play, where the stream
  // rewrites the rows within five seconds and the API serves them on a
  // five-second cache.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const view = oddsView;
    const id = setInterval(() => {
      fetchOdds(selected, view)
        .then((rows) => {
          if (cancelled) return;
          const built = buildMarkets(rows, selected.home, selected.away, selected.league.id);
          // Same id and view, so this updates in place and `ready` never
          // drops — which is what keeps a refresh from flashing the grid.
          setOdds({ id: selected.id, view, markets: built.groups, books: built.books });
        })
        .catch(() => {});
    }, view === 'live' ? 5_000 : 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, oddsView]);

  // Normalise the URL to the canonical name slug for the fixture.
  useEffect(() => {
    if (selected && slug !== eventSlug(selected.name)) {
      navigate(eventPath(selected), { replace: true });
    }
  }, [selected, slug, navigate]);

  if (selected) {
    return (
      <EventDetail
        event={selected}
        now={now}
        markets={markets}
        books={books}
        loading={!ready}
        oddsView={oddsView}
        onOddsView={setOddsParam}
      />
    );
  }
  if (!fixtureId) return eventsLoading ? <EventPageSkeleton /> : <Placeholder text="Select an event" />;
  // A URL naming a fixture the board isn't holding is fetched by id, so "not
  // found" is only true once that has had its turn — until then this is still
  // loading, and a skeleton says so without claiming the event doesn't exist.
  if (eventsLoading || linkResolving) return <EventPageSkeleton />;
  return <Placeholder text="Event not found." />;
}
