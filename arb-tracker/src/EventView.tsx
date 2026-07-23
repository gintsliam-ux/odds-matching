import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { EventDetail } from './components/EventDetail';
import { fetchOdds } from './lib/db';
import { buildMarkets, type MarketGroup } from './lib/markets';
import { eventPath, eventSlug } from './lib/routing';
import type { SportEvent } from './lib/types';

export interface LayoutContext {
  events: SportEvent[];
  now: number;
  eventsLoading: boolean;
  oddsNonce: number;
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="grid h-full min-h-[320px] place-items-center rounded-xl border border-dashed border-surface-border bg-surface-raised/30 text-sm text-slate-600">
      {text}
    </div>
  );
}

export default function EventView() {
  const { fixtureId, slug } = useParams();
  const { events, now, eventsLoading, oddsNonce } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();

  const selected = events.find((e) => e.id === fixtureId) ?? null;

  const [markets, setMarkets] = useState<MarketGroup[]>([]);
  const [oddsLoading, setOddsLoading] = useState(false);

  useEffect(() => {
    if (!selected) {
      setMarkets([]);
      return;
    }
    let cancelled = false;
    setOddsLoading(true);
    fetchOdds(selected)
      .then((rows) => {
        if (!cancelled) setMarkets(buildMarkets(rows, selected.home, selected.away));
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
  }, [selected?.id, oddsNonce]);

  // Normalise the URL to the canonical name slug for the fixture.
  useEffect(() => {
    if (selected && slug !== eventSlug(selected.name)) {
      navigate(eventPath(selected), { replace: true });
    }
  }, [selected, slug, navigate]);

  if (selected) {
    return <EventDetail event={selected} now={now} markets={markets} loading={oddsLoading} />;
  }
  if (!fixtureId) return <Placeholder text={eventsLoading ? 'Loading…' : 'Select an event'} />;
  if (eventsLoading) return <Placeholder text="Loading…" />;
  return <Placeholder text="Event not found." />;
}
