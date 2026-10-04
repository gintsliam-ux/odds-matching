import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { EventDetail } from './components/EventDetail';
import { fetchOdds } from './lib/db';
import { buildMarkets, type Bookmaker, type MarketGroup } from './lib/markets';
import { eventPath, eventSlug } from './lib/routing';
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

  const selected = events.find((e) => e.id === fixtureId) ?? null;

  const [markets, setMarkets] = useState<MarketGroup[]>([]);
  const [books, setBooks] = useState<Bookmaker[]>([]);
  const [oddsLoading, setOddsLoading] = useState(false);

  // Initial load for a newly selected event — the only time we show the loading
  // state (keyed on the fixture id, so it fires on navigation, not on a poll).
  useEffect(() => {
    if (!selected) {
      setMarkets([]);
      setBooks([]);
      return;
    }
    let cancelled = false;
    setOddsLoading(true);
    fetchOdds(selected)
      .then((rows) => {
        if (cancelled) return;
        const built = buildMarkets(rows, selected.home, selected.away, selected.league.id);
        setMarkets(built.groups);
        setBooks(built.books);
      })
      .catch((e) => {
        if (!cancelled) {
          console.error(e);
          setMarkets([]);
        }
      })
      .finally(() => {
        if (!cancelled) setOddsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Silently refresh odds every 30s, updating markets in place — no loading
  // toggle, so the grid never flashes.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const id = setInterval(() => {
      fetchOdds(selected)
        .then((rows) => {
          if (cancelled) return;
          const built = buildMarkets(rows, selected.home, selected.away, selected.league.id);
          setMarkets(built.groups);
          setBooks(built.books);
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

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
        loading={oddsLoading}
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
