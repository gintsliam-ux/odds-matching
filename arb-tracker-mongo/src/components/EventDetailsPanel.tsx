import { useEffect, useState } from 'react';
import { Check, Copy, Database, Info, Link2, Link2Off } from 'lucide-react';
import { fetchEventDetails, type EventDetails, type ProviderEventMapping } from '../lib/db';
import { useCapabilities } from '../lib/capabilitiesContext';
import { PanelNotice } from './EventTabs';
import { DetailsSkeleton } from './Skeleton';

function stamp(iso: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A market id as the odds table stores it — "1h_asian_total" reads better spaced. */
const prettyMarket = (id: string) => id.replace(/_/g, ' ');

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  // A field with nothing in it still holds its place: on a data page, "we have
  // no venue for this fixture" is information, not noise to be hidden.
  const empty = value == null || value === '' || value === '–';
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">{label}</dt>
      <dd className={`mt-0.5 truncate text-[13px] ${empty ? 'text-slate-600' : 'text-slate-200'}`}>
        {empty ? '–' : value}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-surface-border bg-surface-raised/40 p-4">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

const Grid = ({ children }: { children: React.ReactNode }) => (
  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">{children}</dl>
);

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-slate-300">{children}</span>
);

/** A copyable identifier — an id you can\'t select is half an id. */
/**
 * An id you can take away with you.
 *
 * These are the values you quote when asking why something mapped the way it
 * did — a fixture id, a brand's event id, a league id — and they were
 * `select-all` text, which means a careful triple-click and hoping the
 * selection did not run into the next field. Clicking copies, and the tick
 * says so; the full value stays visible because this panel is where you read
 * it, not just carry it.
 */
function Id({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-slate-600">–</span>;
  return (
    <button
      type="button"
      title={`${value} — click to copy`}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      className="group inline-flex max-w-full items-center gap-1 rounded text-left transition hover:bg-white/5"
    >
      <code className="break-all text-[11px] text-slate-300 group-hover:text-slate-100">{value}</code>
      {copied ? (
        <Check size={10} className="shrink-0 text-emerald-400" />
      ) : (
        <Copy size={10} className="shrink-0 opacity-0 transition group-hover:opacity-50" />
      )}
    </button>
  );
}

/** Minutes between two instants, signed and readable, or null. */
function drift(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a || !b) return null;
  const mins = Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins === 0) return null;
  return `${mins > 0 ? '+' : ''}${mins}m`;
}

/**
 * One provider's record of this fixture.
 *
 * Every system keeps its own id, start time and notion of "finished", and they
 * disagree often enough that the disagreement is the useful part — a bet that
 * won't match or a price that looks stale usually traces back to one of these
 * three rows saying something different. The start time is shown against
 * Optic's so the drift is visible rather than something to work out by hand.
 */
function ProviderMapping({
  label,
  data,
  startsAt,
  competitions,
}: {
  label: string;
  data: ProviderEventMapping;
  startsAt: string | null;
  competitions: { id: string | null; name: string; confidence: number | null; source: string | null }[];
}) {
  const e = data.event;
  const skew = drift(e?.startsAt ?? e?.outcomeAt, startsAt);

  return (
    <div className="rounded-lg border border-surface-border bg-surface/40 p-3.5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
          {data.mapped ? (
            <Link2 size={12} className="text-emerald-400" />
          ) : (
            <Link2Off size={12} className="text-slate-600" />
          )}
          {label}
        </h4>
        {data.link && (
          <span className="flex items-center gap-1.5 text-[10px] text-slate-600">
            {data.link.source}
            {data.link.confidence != null && (
              <span className="rounded bg-white/5 px-1 py-0.5 tabular-nums">
                conf {data.link.confidence}
              </span>
            )}
          </span>
        )}
      </div>

      {!data.mapped ? (
        <p className="text-[12px] text-slate-600">
          This fixture is not mapped to {label}. Nothing on the Bets tab can match it, and no
          {' '}
          {label} price will line up with it.
        </p>
      ) : (
        <>
          <Grid>
            <Field label="Event ID" value={<Id value={data.link?.eventId} />} />
            {/*
              This provider's own start time, directly under its id, because
              comparing it against Optic's is the reason anyone opens this card
              — a bet that will not match or a price that looks stale usually
              traces back to one of them saying something different. The amber
              number is the drift from Optic's scheduled start.

              swiftbet keeps a start; mybet keeps `outcomeAt`, which is when it
              settles the market and which it sets to kickoff. Labelled as what
              each one is rather than both relabelled "Starts".
            */}
            {e?.startsAt !== undefined && (
              <Field
                label="Starts"
                value={
                  <span>
                    {stamp(e?.startsAt ?? null)}
                    {skew && <span className="ml-1.5 text-amber-500/80">{skew}</span>}
                  </span>
                }
              />
            )}
            {/*
              The kickoff we WATCHED, against the one it published. swiftbet
              never says when its status changed, so this is observed by
              watch-swift-starts.mjs catching prematch -> inprogress, and is
              absent when nobody was watching — which is honest, and better than
              a confident guess sitting next to Optic's.
            */}
            {e?.actualStart && (
              <Field
                label="Actual start"
                value={
                  <span>
                    {stamp(e.actualStart)}
                    {drift(e.actualStart, e.startsAt) && (
                      <span className="ml-1.5 text-amber-500/80">{drift(e.actualStart, e.startsAt)}</span>
                    )}
                  </span>
                }
              />
            )}
            {e?.outcomeAt !== undefined && (
              <Field
                label="Outcome at"
                value={
                  <span>
                    {stamp(e?.outcomeAt ?? null)}
                    {skew && <span className="ml-1.5 text-amber-500/80">{skew}</span>}
                  </span>
                }
              />
            )}
            <Field label="Mapped" value={stamp(data.link?.resolvedAt ?? null)} />
            {data.link?.actualStart && (
              <Field label="Observed jump" value={stamp(data.link.actualStart)} />
            )}
            <Field label="Competition" value={e?.competition} />
            <Field label="Competition ID" value={<Id value={e?.competitionId} />} />
            <Field label="Sport" value={e?.sport} />
            {e?.status !== undefined && <Field label="Status" value={e?.status} />}
            {e?.viewStatus !== undefined && <Field label="View status" value={e?.viewStatus} />}
            {e?.finished != null && <Field label="Finished" value={String(e.finished)} />}
            {e?.finishedAt !== undefined && <Field label="Finished at" value={stamp(e?.finishedAt ?? null)} />}
            {e?.marketCount != null && <Field label="Markets" value={e.marketCount} />}
            {e?.feedId !== undefined && <Field label="Feed ID" value={<Id value={e?.feedId} />} />}
            {e?.suspendAt !== undefined && <Field label="Suspends" value={stamp(e?.suspendAt ?? null)} />}
            {e?.firstSeenAt !== undefined && <Field label="First seen" value={stamp(e?.firstSeenAt ?? null)} />}
            {e?.lastSeenAt !== undefined && <Field label="Last seen" value={stamp(e?.lastSeenAt ?? null)} />}
            {e?.lastChangedAt !== undefined && (
              <Field label="Last changed" value={stamp(e?.lastChangedAt ?? null)} />
            )}
            {e?.feedLastUpdated !== undefined && (
              <Field label="Feed updated" value={stamp(e?.feedLastUpdated ?? null)} />
            )}
          </Grid>

          {e?.name && (
            <p className="mt-3 truncate text-[12px] text-slate-400" title={e.name}>
              {e.name}
            </p>
          )}
          {e?.teams && e.teams.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {e.teams.map((t, i) => (
                <Chip key={`${t.name}-${i}`}>
                  {t.name}
                  {t.side && <span className="ml-1 text-slate-500">{t.side}</span>}
                </Chip>
              ))}
            </div>
          )}
        </>
      )}

      {competitions.length > 0 && (
        <div className="mt-3 border-t border-surface-border/60 pt-2.5">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
            League mapped to
          </div>
          <div className="flex flex-wrap gap-1.5">
            {competitions.map((c) => (
              <Chip key={c.id ?? c.name}>
                {c.name}
                {c.source && <span className="ml-1 text-slate-500">{c.source}</span>}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Optic, Swiftbet and Mybet side by side for this one fixture. */
function MappingSection({
  mapping,
  startsAt,
}: {
  mapping: NonNullable<EventDetails['mapping']>;
  startsAt: string | null;
}) {
  return (
    <Section title="Mapping">
      {!mapping.configured ? (
        <p className="text-[12px] text-slate-600">
          No bets cluster is configured, so there is nothing to map against.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ProviderMapping
            label="Swiftbet"
            data={mapping.swift}
            startsAt={startsAt}
            competitions={mapping.competitions.swift ?? []}
          />
          <ProviderMapping
            label="Mybet"
            data={mapping.mybet}
            startsAt={startsAt}
            competitions={mapping.competitions.mybet ?? []}
          />
        </div>
      )}
    </Section>
  );
}

/**
 * The fixture behind the board: where it's played, which season it belongs to,
 * where the row came from, and what odds we actually hold for it. Loaded on
 * demand — these fields are deliberately absent from the board payload.
 */
export function EventDetailsPanel({ fixtureId, sport }: { fixtureId: string; sport: string }) {
  const { source } = useCapabilities();
  const [details, setDetails] = useState<EventDetails | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchEventDetails(fixtureId, sport)
      .then((d) => {
        if (cancelled) return;
        setDetails(d);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [fixtureId, sport]);

  if (state === 'loading') return <DetailsSkeleton />;
  if (state === 'error' || !details) {
    return (
      <PanelNotice icon={Info} title="Couldn't load details">
        The fixture record didn't come back. It may have been removed since the board last
        refreshed.
      </PanelNotice>
    );
  }

  const { times: t, coverage: c } = details;
  const place = [details.venue, details.location].filter(Boolean).join(' · ');

  return (
    <div className="flex-1 space-y-4 overflow-auto p-4">
      {/*
        Everything Optic says, in one place at the top.
        It was spread over three sections — "Event" here, the ids under
        "Source" at the bottom, and the start times under "Timeline" between
        them — so reading one fixture's record meant scrolling past the two
        brands to collect it. The brands each carry their own start time in
        their own card, which is where a disagreement is actually read.
      */}
      <Section title="Optic">
        <Grid>
          <Field label="Fixture ID" value={<Id value={details.fixtureId} />} />
          <Field label="Optic league" value={details.opticLeague} />
          <Field label="Optic league ID" value={<Id value={details.opticLeagueId} />} />
          <Field label="Competition" value={details.tournament} />
          <Field label="Category" value={details.category} />
          <Field label="Stage" value={details.tournamentStage} />
          <Field label="Round" value={details.currentRound} />
          <Field label="Status" value={details.status} />
          <Field label="Feed status" value={details.opticStatus} />
          {/* Optic's own start times sit with the rest of its record. Its
              ACTUAL start is the one that moves: a suspended or resumed
              fixture is exactly where the two part company. */}
          <Field label="Scheduled" value={stamp(t.scheduledStart)} />
          <Field label="Actual start" value={stamp(t.actualStart)} />
          <Field label="Ends" value={stamp(t.endDate)} />
          <Field label="Settled" value={stamp(t.settledAt)} />
          <Field label="Venue" value={details.venue} />
          <Field label="Location" value={details.location} />
          <Field label="Season" value={details.season} />
          <Field label="Season type" value={details.seasonType} />
          <Field label="Tier" value={details.tier} />
          <Field label="Broadcast" value={details.broadcast} />
          <Field label="has_odds" value={String(details.hasOdds)} />
          <Field label="has_sp" value={String(details.hasSp)} />
          <Field label="Created" value={stamp(t.createdAt)} />
          <Field label="Updated" value={stamp(t.updatedAt)} />
        </Grid>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-600">
          <Database size={12} />
          {/* Where this panel's numbers actually came from. On a deployed
              instance there is no `fixtures` document and `odds` cannot be
              aggregated, so it is assembled from the board, the mirrored
              mapping tables and the rows this page already loaded — saying
              gutsys_sport there would be untrue. */}
          {source === 'mongo'
            ? 'gutsys_sport · fixtures + odds'
            : 'sport.gutsysapi.com · board + odds, mapping from the mirror'}
        </p>
        {place && <p className="sr-only">{place}</p>}
      </Section>

      {details.competitors.length > 0 && (
        <Section title="Competitors">
          <ul className="space-y-2">
            {details.competitors.map((comp, i) => (
              <li
                key={`${comp.id ?? comp.name}-${i}`}
                className="flex items-center justify-between gap-3 text-[13px]"
              >
                <span className="min-w-0 truncate text-slate-200">{comp.name ?? '–'}</span>
                <span className="flex shrink-0 items-center gap-2 text-slate-500">
                  {comp.country && <Chip>{comp.country}</Chip>}
                  {comp.side && <Chip>{comp.side}</Chip>}
                  {comp.id && <code className="text-[10px] text-slate-600">{comp.id}</code>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {details.mapping && <MappingSection mapping={details.mapping} startsAt={t.scheduledStart} />}

      <Section title="Odds held">
        <Grid>
          <Field label="Price rows" value={c.rows.toLocaleString()} />
          <Field label="Books" value={c.books.length || '–'} />
          <Field label="Markets" value={c.markets.length || '–'} />
          <Field label="In-play rows" value={c.liveRows ? c.liveRows.toLocaleString() : '–'} />
          <Field label="First price" value={stamp(c.firstSeen)} />
          <Field label="Last price" value={stamp(c.lastSeen)} />
          <Field label="Odds open" value={stamp(t.oddsOpenAt)} />
          <Field label="Odds close" value={stamp(t.oddsCloseAt)} />
        </Grid>
        {c.books.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {c.books.map((b) => (
              <Chip key={b}>{b}</Chip>
            ))}
          </div>
        )}
        {c.markets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {c.markets.map((m) => (
              <span
                key={m}
                className="rounded-md bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-500"
              >
                {prettyMarket(m)}
              </span>
            ))}
          </div>
        )}
        {c.rows === 0 && (
          <p className="mt-3 text-xs text-slate-500">No odds rows are stored for this fixture.</p>
        )}
      </Section>

    </div>
  );
}
