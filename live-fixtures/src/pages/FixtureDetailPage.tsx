import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backOr } from '../lib/nav'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { useTerminal } from '../components/Layout'
import { DetailSkeleton, PanelSkeleton } from '../components/Skeleton'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { fetchFixtureById } from '../lib/dataSource'
import { fetchSwiftEvent, swiftEventUrl } from '../lib/swiftStatus'
import { betSettlement, fetchSwiftBets, type SwiftBetRow } from '../lib/swiftBets'
import { fetchMybetBets, mybetSettlement, type MybetBetRow } from '../lib/mybetBets'
import { BRAND_PILL, BRAND_TONE, type Brand } from '../lib/brand'
import { settleFromScore, type ScoreCtx } from '../lib/settleBet'
import { leagueLabel, periodAbbrev, periodNoun, periodState } from '../lib/sports'
import { Avatar } from '../components/Avatar'
import { LeagueBadge } from '../components/LeagueBadge'
import type { Fixture } from '../lib/types'
import { agoLabel, fmtDateTime, fmtLine, melbDateTime, melbDayTime, overdueMinutes, placementOffset, startsInLabel } from '../lib/format'
import { fetchEventMappingsFor, fetchCompetitionMappings, type EventMapping, type CompetitionMapping } from '../lib/mappingData'
import { getSwiftCatalog, type SwiftCompetition, type SwiftEvent } from '../lib/swiftCatalog'
import { getMybetCatalog, type MybetCompetition, type MybetEvent } from '../lib/mybetCatalog'
import { fetchMybetEvent, mybetEventUrl, type MybetLiveEvent } from '../lib/mybetStatus'

export default function FixtureDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { fixtures, now } = useTerminal()

  // Prefer the live list entry (keeps ticking on each poll); otherwise fetch
  // it directly so deep links to out-of-window fixtures still resolve.
  const fromList = fixtures.find((f) => f.id === id) ?? null
  const [fetched, setFetched] = useState<Fixture | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (fromList || !id) return
    let alive = true
    setLoading(true)
    fetchFixtureById(id)
      .then((f) => alive && setFetched(f))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [fromList, id])

  // Cache the last good fixture so the page doesn't flicker to "not found"
  // when the row temporarily leaves the ±6h board window (game completes →
  // ages out of fetchFixtures before the fetchFixtureById fallback resolves).
  // Once we've shown a fixture, we keep showing it until something better
  // comes along.
  const lastGood = useRef<Fixture | null>(null)
  const candidate = fromList ?? fetched
  if (candidate) lastGood.current = candidate
  const f = candidate ?? lastGood.current

  // OPTIC ↔ SWIFT mapping for this specific fixture, used by the DETAILS tab.
  // Depend on stable primitives — not the `f` reference, which gets a fresh
  // object every 15s poll and would otherwise flash the loading skeleton.
  const sport = f?.sport ?? ''
  const league = f?.league ?? ''
  const seasonType = f?.seasonType ?? ''
  const [mappingInfo, setMappingInfo] = useState<MappingInfo>({ loading: true })
  useEffect(() => {
    if (!id) return
    // Wait for the fixture itself to load — sport/league drive compMaps, and
    // running this effect with sport='' produces an empty compMaps list which
    // would briefly render the panel as "No SWIFT mapping yet" before the real
    // values come in. Keep the skeleton up until we have the fixture.
    if (!sport) return
    let alive = true
    // Only show the skeleton on the very first load. Subsequent re-runs (e.g.
    // sport/league actually changing) silently refresh without flashing.
    setMappingInfo((prev) =>
      prev.evMap === undefined && (prev.compMaps?.length ?? 0) === 0
        ? { loading: true }
        : prev,
    )
    // Scoped to THIS fixture. These were whole-table reads (13.9k + 8.1k rows,
    // ~22 sequential pages) whose result was immediately narrowed with
    // .find(e => e.optic_fixture_id === id) — one row out of twenty-two thousand.
    Promise.all([
      fetchEventMappingsFor([id], 'swift'),
      fetchCompetitionMappings(),
      getSwiftCatalog(),
      fetchEventMappingsFor([id], 'mybet'),
      fetchCompetitionMappings('mybet'),
      getMybetCatalog().catch(() => null),
    ])
      .then(async ([events, comps, cat, mybetEvents, mybetCompsAll, mybetCat]) => {
        if (!alive) return
        const evMap = events.find((e) => e.optic_fixture_id === id) ?? null
        // Snapshot lookup first — but always layer the live response on top
        // because only the live endpoint carries `actualStart` (the recorded
        // prematch→inprogress flip time) and a fresh status. Snapshot fields
        // remain a fallback for offline-ish loads.
        let swiftEvent = evMap?.swift_event_id ? (cat.eventById.get(evMap.swift_event_id) ?? null) : null
        if (evMap?.swift_event_id) {
          try {
            const live = await fetchSwiftEvent(evMap.swift_event_id)
            if (live) swiftEvent = swiftEvent ? { ...swiftEvent, ...live } : live
          } catch {
            /* network blip → use snapshot if we had one */
          }
          if (!alive) return
        }
        let compMaps: CompetitionMapping[] = []
        if (sport) {
          compMaps = comps.filter(
            (c) =>
              c.optic_sport === sport &&
              c.optic_league === league &&
              c.optic_tournament === (sport.toLowerCase() === 'tennis' ? seasonType : '') &&
              !!c.swift_competition_id,
          )
        }
        const swiftComps = compMaps
          .map((m) => (m.swift_competition_id ? cat.byCompId.get(m.swift_competition_id) ?? null : null))
          .filter((x): x is NonNullable<typeof x> => !!x)

        // --- mybet: same resolution path, second provider ---
        const mybetEvMap = mybetEvents.find((e) => e.optic_fixture_id === id) ?? null
        let mybetEvent: (MybetEvent & Partial<Omit<MybetLiveEvent, 'status'>>) | null =
          mybetEvMap?.swift_event_id ? mybetCat?.eventById.get(mybetEvMap.swift_event_id) ?? null : null
        if (mybetEvMap?.swift_event_id) {
          try {
            const live = await fetchMybetEvent(mybetEvMap.swift_event_id)
            if (live) mybetEvent = { ...(mybetEvent ?? ({} as MybetEvent)), ...live }
          } catch {
            /* network blip → snapshot fallback */
          }
          if (!alive) return
        }
        const mybetCompMaps = sport
          ? mybetCompsAll.filter(
              (c) =>
                c.optic_sport === sport &&
                c.optic_league === league &&
                c.optic_tournament === (sport.toLowerCase() === 'tennis' ? seasonType : '') &&
                !!c.swift_competition_id,
            )
          : []
        const mybetComps = mybetCompMaps
          .map((m) => (m.swift_competition_id ? mybetCat?.byCompId.get(m.swift_competition_id) ?? null : null))
          .filter((x): x is NonNullable<typeof x> => !!x)

        setMappingInfo({
          loading: false,
          evMap,
          swiftEvent,
          compMaps,
          swiftComps,
          mybetEvMap,
          mybetEvent,
          mybetCompMaps,
          mybetComps,
        })
      })
      .catch(() => alive && setMappingInfo((prev) => ({ ...prev, loading: false })))
    return () => {
      alive = false
    }
  }, [id, sport, league, seasonType])

  useDocumentTitle(f ? `${f.homeName} v ${f.awayName}` : null)

  if (!f && loading) return <DetailSkeleton />

  return (
    <div className="mx-auto max-w-[1700px] px-5 py-5">
      {/* History back, not a hard link to "/". Linking to the root threw away
          whichever sport/league/date/filter you were browsing and sent you to
          the top of the default board — going back restores the exact view,
          and useMainScrollMemory puts the scroll position back with it. Falls
          back to "/" when there's no in-app history (a deep link or a fresh
          tab), which react-router marks with history.state.idx === 0. */}
      <button
        onClick={() => backOr(navigate, '/')}
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--muted)] transition-colors hover:text-gray-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to terminal
      </button>

      {!f ? (
        <div className="flex h-48 items-center justify-center text-[13px] text-[color:var(--muted-2)]">
          Fixture not found.
        </div>
      ) : (
        <Detail fixture={f} now={now} mappingInfo={mappingInfo} />
      )}
    </div>
  )
}

type DetailTab = 'details' | 'markets' | 'bets'

interface MappingInfo {
  loading: boolean
  evMap?: EventMapping | null
  swiftEvent?: SwiftEvent | null
  compMaps?: CompetitionMapping[]
  swiftComps?: SwiftCompetition[]
  // mybet — same shape, second provider. `mybetEvent` merges the snapshot with
  // the live /api/mybet-status response (which carries the open/closed flag).
  mybetEvMap?: EventMapping | null
  mybetEvent?: (MybetEvent & Partial<Omit<MybetLiveEvent, 'status'>>) | null
  mybetCompMaps?: CompetitionMapping[]
  mybetComps?: MybetCompetition[]
}

function Detail({
  fixture: f,
  now,
  mappingInfo,
}: {
  fixture: Fixture
  now: Date
  mappingInfo: MappingInfo
}) {
  const [tab, setTab] = useState<DetailTab>('details')
  const isLive = f.status === 'live'
  // Bets are fetched here (not inside BetsTab) so the liability overview under
  // the scoreboard can read them on every tab.
  //
  // Late-bet cutoff = the LATER of OPTIC's actual_start and our SWIFT inprogress
  // observation — BUT only trusting stamps that aren't implausibly early. Two
  // real failure modes produced false "after start" flags: the SWIFT stamp can
  // fire ~an hour early on a brief false `inprogress`, and a stamp can come from
  // the wrong game in a same-teams series (a day off). So we drop any actual
  // that predates the scheduled start by more than a small tolerance, and only
  // flag when a trustworthy stamp remains.
  const schedMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
  const START_TOLERANCE_MS = 30 * 60_000
  const trustedStarts = [f.actualStart, mappingInfo.swiftEvent?.actualStart].filter(
    (x): x is string => !!x && (!Number.isFinite(schedMs) || Date.parse(x) >= schedMs - START_TOLERANCE_MS),
  )
  const actualStart = trustedStarts.length
    ? trustedStarts.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
    : null
  const swiftEventId = mappingInfo.swiftEvent?.id ?? mappingInfo.evMap?.swift_event_id ?? null
  const betsState = useSwiftBets(f, actualStart, swiftEventId)
  // mybet bets are fetched at this level (not inside the Bets tab) so the
  // combined exposure glance can stay visible on every tab.
  const mybetBetsState = useMybetBets({
    eventId: mappingInfo.mybetEvent?.id ?? mappingInfo.mybetEvMap?.swift_event_id ?? null,
    suspendAt: mappingInfo.mybetEvent?.suspendAt ?? null,
    liveAt: actualStart ?? f.scheduledStart,
    home: f.homeName,
    away: f.awayName,
  })
  const swiftBets = betsState.bets ?? []
  const mybetBets = mybetBetsState.bets ?? []

  return (
    <div
      className={`rounded-lg bg-[color:var(--panel)] ${isLive ? 'glow-live' : ''}`}
    >
      {/* HERO — everything you need to read the event at a glance. */}
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <LeagueBadge sport={f.sport} league={f.league} size={20} />
          <span className="text-[14px] font-semibold text-gray-100">
            {leagueLabel(f.sport, f.league, f.seasonType)}
          </span>
        </div>
        <StatusBadge fixture={f} now={now} />
      </div>

      <div className="px-5 py-5">
        <Score name={f.homeName} logo={f.homeLogo} score={f.homeScore} leads={leads(f.homeScore, f.awayScore)} />
        <Score name={f.awayName} logo={f.awayLogo} score={f.awayScore} leads={leads(f.awayScore, f.homeScore)} />
      </div>

      {/* compact times under the score so they're always visible above the tabs */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-white/[0.05] bg-black/[0.15] px-5 py-3 text-[12px] text-[color:var(--muted)]">
        <span>
          UTC <span className="ml-1 text-gray-200 tabular-nums">{fmtDateTime(f.startTime)}</span>
        </span>
        <span>
          MEL <span className="ml-1 text-gray-200 tabular-nums">{melbDateTime(f.startTime)}</span>
        </span>
        <span className="ml-auto flex items-center gap-2 font-medium text-gray-200">
          {isLive
            ? (periodState(f.sport, f.periods) ?? 'Live')
            : f.status === 'upcoming'
              ? startsInLabel(f.startTime, now)
              : 'Full time'}
          {f.status === 'upcoming' && overdueMinutes(f.startTime, now) >= 3 && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-[color:var(--live)]/10 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--live)]"
              title="Scheduled start has passed but it hasn't gone live — possibly delayed"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />
              possible delay
            </span>
          )}
        </span>
      </div>

      {/* COMBINED EXPOSURE — SwiftBet + mybet, always visible across tabs. */}
      {(swiftBets.length > 0 || mybetBets.length > 0) && (
        <CombinedExposure fixture={f} swiftBets={swiftBets} mybetBets={mybetBets} />
      )}

      {/* TAB STRIP */}
      <div className="flex items-center gap-1 border-b border-white/[0.05] bg-black/[0.1] px-3 py-2">
        <TabButton active={tab === 'details'} onClick={() => setTab('details')}>
          Details
        </TabButton>
        <TabButton active={tab === 'markets'} onClick={() => setTab('markets')}>
          Markets
        </TabButton>
        <TabButton active={tab === 'bets'} onClick={() => setTab('bets')}>
          Bets
        </TabButton>
      </div>

      {tab === 'details' && (
        <DetailsTab
          fixture={f}
          now={now}
          mappingInfo={mappingInfo}
          swiftBets={betsState.bets}
          mybetBets={mybetBetsState.bets}
          swiftBetsLoading={betsState.loading}
          mybetBetsLoading={mybetBetsState.loading}
        />
      )}
      {tab === 'markets' && <MarketsTab fixture={f} />}
      {tab === 'bets' && (
        <BetsPanel
          fixture={f}
          swiftBets={betsState.bets}
          swiftLoading={betsState.loading}
          swiftError={betsState.error}
          swiftActualStart={actualStart}
          mybetEventId={mappingInfo.mybetEvent?.id ?? mappingInfo.mybetEvMap?.swift_event_id ?? null}
          mybetBets={mybetBetsState.bets}
          mybetLoading={mybetBetsState.loading}
          mybetError={mybetBetsState.error}
        />
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        active ? 'bg-[var(--total)] text-black' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// --- tab panels ----------------------------------------------------------

type Verdict = { label: string; tone: string }

/** Bets not yet fetched: "…" while loading, "—" once we know there's nothing. */
function pendingVerdict(loading: boolean): Verdict {
  return { label: loading ? '…' : '—', tone: 'text-[color:var(--muted-2)]' }
}

/**
 * Event-level settlement verdict for one brand's bets: has the book resulted
 * this event yet, or is money still riding on it?
 *
 * `pending` is what decides it — as long as ONE bet is unresulted the event
 * isn't done. Bets we can't classify ('unknown': SwiftBet rows predating
 * bet_status, added 2026-07-31) are counted separately and never treated as
 * outstanding, so an old event reads "not reported" rather than a false verdict.
 */
function settlementVerdict(
  states: Array<'pending' | 'settled' | 'void' | 'unknown'>,
): Verdict {
  if (states.length === 0) return { label: '— no bets', tone: 'text-[color:var(--muted-2)]' }
  const pending = states.filter((x) => x === 'pending').length
  const settled = states.filter((x) => x === 'settled').length
  const voided = states.filter((x) => x === 'void').length
  const unknown = states.filter((x) => x === 'unknown').length
  // Bets we can't classify are called out rather than folded into the verdict.
  // Events straddling 2026-07-31 have a real mix — SwiftBet started writing
  // bet_status partway through that day (0% before, 100% since), so "PAID · 13"
  // on a day with 9 statusless bets would overclaim.
  const gap = unknown > 0 ? ` · ${unknown} unreported` : ''
  if (pending > 0) {
    return {
      label: `UNRESULTED · ${pending} of ${states.length} pending`,
      tone: 'text-[color:var(--up)]',
    }
  }
  if (settled > 0) {
    const extra = voided > 0 ? ` · ${voided} void` : ''
    return {
      label: `PAID · ${settled} bet${settled === 1 ? '' : 's'}${extra}${gap}`,
      tone: 'text-[color:var(--total)]',
    }
  }
  if (voided > 0) return { label: `VOID · ${voided}${gap}`, tone: 'text-[color:var(--muted)]' }
  // Everything unknown — pre-bet_status rows. Say nothing rather than guess.
  return { label: '— not reported', tone: 'text-[color:var(--muted-2)]' }
}

function DetailsTab({
  fixture: f,
  now,
  mappingInfo,
  swiftBets,
  mybetBets,
  swiftBetsLoading,
  mybetBetsLoading,
}: {
  fixture: Fixture
  now: Date
  mappingInfo: MappingInfo
  swiftBets: SwiftBetRow[] | null
  mybetBets: MybetBetRow[] | null
  swiftBetsLoading: boolean
  mybetBetsLoading: boolean
}) {
  // Per-brand settlement verdict, shown on each book's panel below. `null` bets
  // means the fetch hasn't resolved — don't render that as "no bets".
  const swiftVerdict = swiftBets
    ? settlementVerdict(swiftBets.map((b) => betSettlement(b.bet_status)))
    : pendingVerdict(swiftBetsLoading)
  const mybetVerdict = mybetBets
    ? settlementVerdict(mybetBets.map((b) => mybetSettlement(b.bet_status)))
    : pendingVerdict(mybetBetsLoading)
  return (
    <>
      {f.periods.length > 0 && (
        <Section title={`Score by period · ${periodNoun(f.sport).toLowerCase()}`}>
          <table className="w-full text-[12.5px] tabular-nums">
            <thead>
              <tr className="text-[11px] text-[color:var(--muted-2)]">
                <th className="pb-1.5 text-left font-normal" />
                {f.periods.map((p) => (
                  <th key={p.index} className="w-9 pb-1.5 text-right font-normal">
                    {periodAbbrev(f.sport, p.index)}
                  </th>
                ))}
                <th className="w-10 pb-1.5 text-right font-medium text-[color:var(--muted)]">Tot</th>
              </tr>
            </thead>
            <tbody>
              <PeriodRow
                name={f.homeName}
                per={f.periods.map((p) => p.home)}
                total={f.homeScore}
                leads={leads(f.homeScore, f.awayScore)}
              />
              <PeriodRow
                name={f.awayName}
                per={f.periods.map((p) => p.away)}
                total={f.awayScore}
                leads={leads(f.awayScore, f.homeScore)}
              />
            </tbody>
          </table>
        </Section>
      )}

      {/* OPTIC + SWIFT + mybet side-by-side. Stacks on narrow viewports. */}
      <div className="grid grid-cols-1 gap-4 border-t border-white/10 px-5 py-4 md:grid-cols-2 lg:grid-cols-3">
        <OpticPanel fixture={f} now={now} />
        <SwiftPanel info={mappingInfo} verdict={swiftVerdict} />
        <MybetPanel info={mappingInfo} verdict={mybetVerdict} />
      </div>
    </>
  )
}

function OpticPanel({ fixture: f, now }: { fixture: Fixture; now: Date }) {
  return (
    <SourcePanel kind="OPTIC" subtitle="live_fixtures">
      <Grid>
        <Field label="SPORT" value={f.sport.toUpperCase()} />
        <Field label="LEAGUE" value={f.league} />
        <Field label="SPORT (RAW)" value={f.rawSport} mono />
        <Field label="LEAGUE (RAW)" value={f.rawLeague} mono />
        <Field label="STATUS" value={f.status.toUpperCase()} />
        <Field
          label="PERIOD / CLOCK"
          value={
            f.status === 'live'
              ? (periodState(f.sport, f.periods) ?? 'LIVE')
              : f.status === 'upcoming'
                ? startsInLabel(f.startTime, now)
                : 'FULL TIME'
          }
        />
        <Field label="HOME" value={`${f.homeName}${f.homeScore != null ? ` · ${f.homeScore}` : ''}`} />
        <Field label="AWAY" value={`${f.awayName}${f.awayScore != null ? ` · ${f.awayScore}` : ''}`} />
        <Field label="SCHEDULED (UTC)" value={fmtDateTime(f.scheduledStart)} />
        <Field label="ACTUAL START (UTC)" value={fmtDateTime(f.actualStart)} />
        <Field label="START (MEL)" value={melbDateTime(f.startTime)} />
        <Field label="ODDS UPDATED" value={agoLabel(f.liveUpdatedAt, now)} />
        <Field label="VENUE" value={f.venue ?? '—'} />
        <Field label="BROADCAST" value={f.broadcast ?? '—'} />
        <Field label="SEASON" value={f.seasonType ?? '—'} />
        <Field label="FIXTURE ID" value={f.opticId ?? f.id} mono copyable />
      </Grid>
    </SourcePanel>
  )
}

function SwiftPanel({ info, verdict }: { info: MappingInfo; verdict: Verdict }) {
  if (info.loading) {
    return <PanelSkeleton fields={10} />
  }

  const { evMap, swiftEvent, compMaps = [], swiftComps = [] } = info
  const primaryComp = swiftComps[0] ?? null
  const mapped = !!swiftEvent || compMaps.length > 0

  if (!mapped) {
    return (
      <SourcePanel kind="SWIFT" subtitle="gutsy.events">
        <div className="text-[12px] leading-relaxed text-gray-400">
          <span className="font-bold text-gray-200">No SWIFT mapping yet.</span> Go to the{' '}
          <a href="/mapping" className="text-[var(--total)] underline">
            Mapping
          </a>{' '}
          tab to pair this fixture with a gutsy.events record. Once mapped, all SWIFT side details
          appear here.
        </div>
      </SourcePanel>
    )
  }

  const swiftId = swiftEvent?.id ?? evMap?.swift_event_id ?? null

  return (
    <SourcePanel
      kind="SWIFT"
      subtitle="gutsy.events"
      action={
        swiftId && (
          <a
            href={swiftEventUrl(swiftId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded border border-[color:var(--swift)]/30 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--swift)] hover:bg-[color:var(--swift)]/10"
          >
            Open Swift <ExternalLink className="h-3 w-3" />
          </a>
        )
      }
    >
      <Grid>
        {/* event-level */}
        <Field label="EVENT NAME" value={swiftEvent?.name ?? '—'} />
        <Field label="STATUS" value={(swiftEvent?.status ?? '—').toUpperCase()} />
        <Field label="BETS RESULTED" value={verdict.label} tone={verdict.tone} />
        <Field label="HOME" value={swiftEvent?.home ?? '—'} />
        <Field label="AWAY" value={swiftEvent?.away ?? '—'} />
        <Field label="SCHEDULED (UTC)" value={fmtDateTime(swiftEvent?.start ?? null)} />
        <Field label="ACTUAL START (UTC)" value={fmtDateTime(swiftEvent?.actualStart ?? null)} />
        <Field label="START (MEL)" value={melbDateTime(swiftEvent?.actualStart ?? swiftEvent?.start ?? null)} />
        {/* competition-level (uses primary; full list rendered below if many) */}
        <Field label="SPORT" value={(swiftEvent?.sport ?? primaryComp?.sport ?? '—').toUpperCase()} />
        <Field label="COMPETITION" value={swiftEvent?.competition ?? primaryComp?.name ?? '—'} />
        <Field label="COMPETITION ID" value={swiftEvent?.cid ?? primaryComp?.id ?? '—'} mono copyable />
        <Field label="EVENT ID" value={swiftEvent?.id ?? evMap?.swift_event_id ?? '—'} mono copyable />
        {/* mapping audit */}
        <Field
          label="EVENT MAPPING"
          value={
            evMap?.swift_event_id
              ? `${Math.round((evMap.confidence ?? 0) * 100)}% · ${(evMap.source ?? 'auto').toUpperCase()}`
              : 'UNMAPPED'
          }
        />
        <Field
          label={compMaps.length > 1 ? `COMPETITION MAPPINGS (${compMaps.length})` : 'COMPETITION MAPPING'}
          value={
            compMaps.length === 0
              ? 'UNMAPPED'
              : compMaps
                  .map(
                    (m) =>
                      `${m.swift_competition} · ${Math.round((m.confidence ?? 0) * 100)}% · ${(m.source ?? 'auto').toUpperCase()}${m.verified ? ' · ✓' : ''}`,
                  )
                  .join(' • ')
          }
        />
      </Grid>
    </SourcePanel>
  )
}

function MybetPanel({ info, verdict }: { info: MappingInfo; verdict: Verdict }) {
  if (info.loading) {
    return <PanelSkeleton fields={10} />
  }

  const { mybetEvMap, mybetEvent, mybetCompMaps = [], mybetComps = [] } = info
  const primaryComp = mybetComps[0] ?? null
  const mapped = !!mybetEvent || mybetCompMaps.length > 0

  if (!mapped) {
    return (
      <SourcePanel kind="MYBET" subtitle="gutsy.mybet_events">
        <div className="text-[12px] leading-relaxed text-gray-400">
          <span className="font-bold text-gray-200">No mybet mapping yet.</span> Most mybet events
          are player-prop markets with no teams; only head-to-head events map. Use the{' '}
          <a href="/mapping" className="text-[color:var(--mybet)] underline">Mapping</a>{' '}
          tab to pair one manually.
        </div>
      </SourcePanel>
    )
  }

  const mybetId = mybetEvent?.id ?? mybetEvMap?.swift_event_id ?? null
  // mybet closes on suspendAt; the live endpoint adds `open`. Render a clear
  // OPEN / CLOSED state plus the closing time, since that's mybet's core signal.
  const suspend = mybetEvent?.suspendAt ?? null
  const openFlag =
    typeof mybetEvent?.open === 'boolean'
      ? mybetEvent.open
      : suspend
        ? Date.parse(suspend) > Date.now()
        : null

  return (
    <SourcePanel
      kind="MYBET"
      subtitle="gutsy.mybet_events"
      action={
        mybetId && (
          <a
            href={mybetEventUrl(mybetId, mybetEvent?.sport ?? primaryComp?.sport)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded border border-[color:var(--mybet)]/30 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--mybet)] hover:bg-[color:var(--mybet)]/10"
          >
            Open mybet <ExternalLink className="h-3 w-3" />
          </a>
        )
      }
    >
      <Grid>
        {/* event-level */}
        <Field label="EVENT NAME" value={mybetEvent?.name ?? '—'} />
        <Field
          label="MARKET"
          value={openFlag == null ? '—' : openFlag ? 'OPEN' : 'CLOSED'}
        />
        <Field label="BETS RESULTED" value={verdict.label} tone={verdict.tone} />
        <Field label="HOME" value={mybetEvent?.home ?? '—'} />
        <Field label="AWAY" value={mybetEvent?.away ?? '—'} />
        <Field label="CLOSES / SUSPEND (UTC)" value={fmtDateTime(suspend)} />
        <Field label="CLOSES (MEL)" value={melbDateTime(suspend)} />
        <Field label="LAST SEEN (UTC)" value={fmtDateTime(mybetEvent?.lastSeenAt ?? null)} />
        {/* competition-level */}
        <Field label="SPORT" value={(mybetEvent?.sport ?? primaryComp?.sport ?? '—').toUpperCase()} />
        <Field label="COMPETITION" value={mybetEvent?.competition ?? primaryComp?.name ?? '—'} />
        <Field label="EVENT ID" value={mybetEvent?.id ?? mybetEvMap?.swift_event_id ?? '—'} mono copyable />
        {/* mapping audit */}
        <Field
          label="EVENT MAPPING"
          value={
            mybetEvMap?.swift_event_id
              ? `${Math.round((mybetEvMap.confidence ?? 0) * 100)}% · ${(mybetEvMap.source ?? 'auto').toUpperCase()}`
              : 'UNMAPPED'
          }
        />
        <Field
          label={mybetCompMaps.length > 1 ? `COMPETITION MAPPINGS (${mybetCompMaps.length})` : 'COMPETITION MAPPING'}
          value={
            mybetCompMaps.length === 0
              ? 'UNMAPPED'
              : mybetCompMaps
                  .map(
                    (m) =>
                      `${m.swift_competition} · ${Math.round((m.confidence ?? 0) * 100)}% · ${(m.source ?? 'auto').toUpperCase()}${m.verified ? ' · ✓' : ''}`,
                  )
                  .join(' • ')
          }
        />
      </Grid>
    </SourcePanel>
  )
}

function SourcePanel({
  kind,
  subtitle,
  action,
  children,
}: {
  kind: 'OPTIC' | 'SWIFT' | 'MYBET'
  subtitle: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  // One accent per source: OPTIC=blue, SWIFT=green, MYBET=amber/live. Literal
  // class strings — Tailwind extracts these statically, so no interpolation.
  const brand = kind.toLowerCase() as Brand
  const tone = BRAND_TONE[brand]
  const pill = BRAND_PILL[brand]
  return (
    <div className={`rounded-lg ${tone} px-4 py-3.5`}>
      <div className="mb-3 flex items-center justify-between">
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${pill}`}
        >
          {kind}
        </span>
        <div className="flex items-center gap-2">
          {action}
          <span className="text-[11px] text-[color:var(--muted-2)]">{subtitle}</span>
        </div>
      </div>
      {children}
    </div>
  )
}

// Reserved keys on each market block in pregame_odds (not bookmakers).
const PREGAME_NON_BOOK_KEYS = new Set(['line'])

// Field labels used to be ALL CAPS in the call sites ("FIXTURE ID", "START (UTC)").
// Normalise them at render time so the call sites stay readable.
function prettyLabel(s: string): string {
  if (!s) return s
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      // Keep parenthetical timezone codes uppercase ("(utc)" → "(UTC)")
      if (/^\(?(utc|mel|id|raw)\)?$/i.test(w.replace(/[()]/g, ''))) return w.toUpperCase()
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1)
      return w
    })
    .join(' ')
}

// Display book names with their actual casing — Pinnacle / DraftKings / FanDuel
// look better than BETMGM / DRAFTKINGS. Map key is the lowercased feed key,
// which is what the scraper writes into pregame_odds.
function titleCaseBook(b: string): string {
  const map: Record<string, string> = {
    pinnacle: 'Pinnacle',
    betmgm: 'BetMGM',
    caesars: 'Caesars',
    fanduel: 'FanDuel',
    draftkings: 'DraftKings',
    fanatics: 'Fanatics',
    sportsbet: 'Sportsbet',
    bet365: 'bet365',
    'ladbrokes (australia)': 'Ladbrokes',
    'ladbrokes_australia_': 'Ladbrokes',
    tab: 'TAB',
  }
  return map[b.toLowerCase()] ?? b
}

// Tint per bookmaker so their column headers feel like brand chips, not
// indistinguishable text. Falls back to a neutral grey for unknown books.
const BOOK_TINT: Record<string, { text: string; bg: string; border: string }> = {
  pinnacle: { text: 'text-amber-300', bg: 'bg-amber-300/10', border: 'border-amber-300/30' },
  betmgm: { text: 'text-yellow-300', bg: 'bg-yellow-300/10', border: 'border-yellow-300/30' },
  caesars: { text: 'text-yellow-200', bg: 'bg-yellow-200/10', border: 'border-yellow-200/30' },
  fanduel: { text: 'text-sky-300', bg: 'bg-sky-300/10', border: 'border-sky-300/30' },
  draftkings: { text: 'text-emerald-300', bg: 'bg-emerald-300/10', border: 'border-emerald-300/30' },
  fanatics: { text: 'text-rose-300', bg: 'bg-rose-300/10', border: 'border-rose-300/30' },
  sportsbet: { text: 'text-red-300', bg: 'bg-red-300/10', border: 'border-red-300/30' },
  bet365: { text: 'text-lime-300', bg: 'bg-lime-300/10', border: 'border-lime-300/30' },
  'ladbrokes (australia)': { text: 'text-fuchsia-300', bg: 'bg-fuchsia-300/10', border: 'border-fuchsia-300/30' },
  ladbrokes_australia_: { text: 'text-fuchsia-300', bg: 'bg-fuchsia-300/10', border: 'border-fuchsia-300/30' },
  tab: { text: 'text-cyan-300', bg: 'bg-cyan-300/10', border: 'border-cyan-300/30' },
}

function MarketsTab({ fixture: f }: { fixture: Fixture }) {
  const po = f.pregameOdds
  const h2hBooks = po?.h2h ? listBookmakers(po.h2h) : []
  const spreadBooks = po?.spread ? listBookmakers(po.spread) : []
  const totalBooks = po?.total ? listBookmakers(po.total) : []
  const hasDraw = po?.h2h && Object.values(po.h2h).some((b) => isBookH2h(b) && b?.draw != null)

  const h2hLive: Record<'home' | 'draw' | 'away', number | null> = {
    home: f.liveH2h.home,
    draw: f.liveH2h.draw,
    away: f.liveH2h.away,
  }

  return (
    <>
      {/* feed-level metadata strip */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-white/[0.05] bg-black/[0.12] px-5 py-2.5 text-[12px] text-[color:var(--muted)]">
        <span className="flex items-center gap-2">
          Primary
          <span className="rounded border border-[color:var(--line-soft)] bg-black/[0.3] px-1.5 py-0.5 text-[11px] font-medium text-gray-100">
            {titleCaseBook(f.bookmaker ?? '—')}
          </span>
        </span>
        <span>
          Updated{' '}
          <span className="ml-1 text-gray-200 tabular-nums">
            {f.liveUpdatedAt
              ? new Date(f.liveUpdatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
              : '—'}
          </span>
        </span>
        {po && (
          <span className="ml-auto text-[color:var(--muted-2)]">
            {h2hBooks.length + spreadBooks.length + totalBooks.length} book rows ·{' '}
            {[h2hBooks.length && 'H2H', spreadBooks.length && 'Spread', totalBooks.length && 'Total']
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* H2H card — combines LIVE + per-bookmaker closing + BEST. */}
        {(h2hBooks.length > 0 || f.liveH2h.home != null || f.liveH2h.away != null) && (
          <MarketCard
            title="Head to Head"
            kind="moneyline"
            books={h2hBooks}
            line={null}
            outcomes={[
              { label: f.homeName, key: 'home' },
              ...(hasDraw ? [{ label: 'Draw', key: 'draw' as const }] : []),
              { label: f.awayName, key: 'away' },
            ]}
            getPrice={(book, k) =>
              (po?.h2h?.[book] as { [k: string]: number | null | undefined })?.[k] ?? null
            }
            getLive={(k) => h2hLive[k]}
          />
        )}

        {/* Spread */}
        {spreadBooks.length > 0 && (
          <MarketCard
            title="Spread"
            kind="spread"
            books={spreadBooks}
            line={po?.spread?.line ?? null}
            outcomes={[
              { label: f.homeName, key: 'home', lineSuffix: fmtLine(po?.spread?.line ?? null) },
              { label: f.awayName, key: 'away', lineSuffix: fmtLine(negate(po?.spread?.line ?? null)) },
            ]}
            getPrice={(book, k) =>
              (po?.spread?.[book] as { [k: string]: number | null | undefined })?.[k] ?? null
            }
            getLive={() => null}
          />
        )}

        {/* Total */}
        {totalBooks.length > 0 && (
          <MarketCard
            title="Total"
            kind="total"
            books={totalBooks}
            line={po?.total?.line ?? null}
            outcomes={[
              { label: 'Over', key: 'over', lineSuffix: po?.total?.line != null ? `O ${po.total.line}` : undefined },
              { label: 'Under', key: 'under', lineSuffix: po?.total?.line != null ? `U ${po.total.line}` : undefined },
            ]}
            getPrice={(book, k) =>
              (po?.total?.[book] as { [k: string]: number | null | undefined })?.[k] ?? null
            }
            getLive={() => null}
          />
        )}

        {!po && h2hBooks.length === 0 && spreadBooks.length === 0 && totalBooks.length === 0 && (
          <div className="rounded-md border border-dashed border-[var(--line)] px-4 py-6 text-center text-[12px] text-gray-500">
            No pregame markets available for this fixture.
          </div>
        )}
      </div>
    </>
  )
}

function listBookmakers(block: Record<string, unknown>): string[] {
  return Object.keys(block).filter((k) => !PREGAME_NON_BOOK_KEYS.has(k))
}

function isBookH2h(v: unknown): v is { home?: number | null; away?: number | null; draw?: number | null } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bookTint(book: string) {
  return BOOK_TINT[book.toLowerCase()] ?? {
    text: 'text-gray-300',
    bg: 'bg-white/5',
    border: 'border-[var(--line)]',
  }
}

/** Decimal odds → implied probability "51.3%". */
function impliedPct(odds: number): string {
  return `${(100 / odds).toFixed(1)}%`
}

/** Decimal odds → American moneyline ("+135" / "-150"). For people who think in that. */
function americanOdds(decimal: number): string {
  if (decimal >= 2) return `+${Math.round((decimal - 1) * 100)}`
  return `${Math.round(-100 / (decimal - 1))}`
}

interface MarketOutcome<K extends string> {
  label: string
  key: K
  lineSuffix?: string
}

/** One market card (H2H / Spread / Total) — header + outcome rows with the
 *  best-price chip, the per-book grid, and the live consensus column. */
function MarketCard<K extends string>({
  title,
  kind,
  books,
  line,
  outcomes,
  getPrice,
  getLive,
}: {
  title: string
  kind: 'moneyline' | 'spread' | 'total'
  books: string[]
  line: number | null
  outcomes: MarketOutcome<K>[]
  getPrice: (book: string, key: K) => number | null
  getLive: (key: K) => number | null
}) {
  // Best (highest decimal) price + which book offered it, per outcome.
  const best = outcomes.map((o) => {
    let bestPrice = 0
    let bestBook: string | null = null
    for (const b of books) {
      const v = getPrice(b, o.key)
      if (v != null && v > bestPrice) {
        bestPrice = v
        bestBook = b
      }
    }
    return { price: bestPrice, book: bestBook }
  })
  const hasLive = outcomes.some((o) => getLive(o.key) != null)

  const accent =
    kind === 'moneyline'
      ? 'border-[var(--total)]/30'
      : kind === 'spread'
        ? 'border-sky-400/30'
        : 'border-amber-400/30'

  return (
    <div className={`overflow-hidden rounded-lg bg-[color:var(--panel)] ${accent}`}>
      <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-[14px] font-semibold text-gray-100">{title}</span>
          {line != null && (
            <span className="rounded border border-[color:var(--line-soft)] bg-black/[0.2] px-2 py-0.5 text-[11px] font-medium text-gray-300">
              Line {kind === 'spread' ? fmtLine(line) : line}
            </span>
          )}
        </div>
        <span className="text-[11.5px] text-[color:var(--muted-2)]">{books.length} books</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-[11px] text-[color:var(--muted)]">
              <th className="sticky left-0 z-10 bg-[color:var(--panel)] py-2.5 pl-4 pr-3 text-left font-medium">
                Outcome
              </th>
              {hasLive && (
                <th className="px-2 py-2.5 text-right font-medium text-[color:var(--live)]">Live</th>
              )}
              <th className="px-2 py-2.5 text-right font-medium text-[color:var(--total)]">Best</th>
              {books.map((b) => {
                const t = bookTint(b)
                return (
                  <th key={b} className="px-2 py-2.5 text-right font-normal">
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${t.text} ${t.bg} ${t.border}`}
                    >
                      {titleCaseBook(b)}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {outcomes.map((o, i) => {
              const liveV = getLive(o.key)
              const bestThis = best[i]
              return (
                <tr key={o.key as string} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="sticky left-0 z-10 bg-[color:var(--panel)] py-2.5 pl-4 pr-3">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-100">{o.label}</span>
                      {o.lineSuffix && (
                        <span className="rounded bg-black/[0.2] px-1.5 py-0.5 text-[10.5px] text-[color:var(--muted)]">
                          {o.lineSuffix}
                        </span>
                      )}
                    </div>
                  </td>
                  {hasLive && (
                    <td className="px-2 py-2.5 text-right">
                      {liveV != null ? (
                        <span className="font-semibold text-[color:var(--live)]">{liveV.toFixed(2)}</span>
                      ) : (
                        <span className="text-[color:var(--muted-2)]/60">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-2 py-2.5 text-right">
                    {bestThis.price > 0 ? (
                      <span
                        title={`${americanOdds(bestThis.price)} · ${impliedPct(bestThis.price)} implied · ${bestThis.book}`}
                        className="inline-flex items-baseline gap-1.5 rounded bg-[color:var(--total)]/15 px-1.5 py-0.5 font-semibold text-[color:var(--total)]"
                      >
                        {bestThis.price.toFixed(2)}
                        <span className="text-[10px] opacity-70">{titleCaseBook(bestThis.book ?? '').slice(0, 3)}</span>
                      </span>
                    ) : (
                      <span className="text-[color:var(--muted-2)]/60">—</span>
                    )}
                  </td>
                  {books.map((b) => {
                    const v = getPrice(b, o.key)
                    const isBest = bestThis.price > 0 && v === bestThis.price
                    return (
                      <td key={b} className="px-2 py-2 text-right">
                        {v == null ? (
                          <span className="text-gray-700">—</span>
                        ) : (
                          <span
                            title={`${americanOdds(v)} · ${impliedPct(v)} implied`}
                            className={
                              isBest
                                ? 'inline-block rounded bg-[var(--total)]/10 px-1.5 py-0.5 font-bold text-[var(--total)]'
                                : 'text-gray-100'
                            }
                          >
                            {v.toFixed(2)}
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Bets for a fixture, fetched once per (date, teams). Lifted out of BetsTab so
 *  the liability overview can read the same data above the tab strip. The score
 *  changing doesn't refetch — the deps are stable — so P/L just recomputes. */
function useSwiftBets(f: Fixture, swiftActualStart: string | null, swiftEventId: string | null) {
  const [bets, setBets] = useState<SwiftBetRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const date = (f.scheduledStart ?? f.startTime ?? '').slice(0, 10)
  const scheduledStart = f.scheduledStart ?? f.startTime ?? null
  useEffect(() => {
    if (!date || !f.homeName || !f.awayName) return
    let alive = true
    setLoading(true)
    setError(null)
    // `swiftEventId` arrives a beat after the fixture (the mapping loads
    // async), so this refetches once it lands — picking up any bet the slug
    // join missed.
    fetchSwiftBets({ date, home: f.homeName, away: f.awayName, swiftEventId, swiftActualStart, scheduledStart })
      .then((rows) => alive && setBets(rows))
      .catch((e) => alive && setError(String(e?.message ?? e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [date, f.homeName, f.awayName, swiftEventId, swiftActualStart, scheduledStart])
  return { bets, loading, error, date }
}

/**
 * Bets tab body: a per-brand sub-tab strip (SwiftBet · mybet) over two views
 * that share the same layout — a Users/Bets/Stake/P&L stat header, then bet
 * cards grouped (SwiftBet by market, mybet by bet type) each with an identical
 * table. Keeping both on the same structure is the point of the split.
 */
function BetsPanel({
  fixture: f,
  swiftBets,
  swiftLoading,
  swiftError,
  swiftActualStart,
  mybetEventId,
  mybetBets,
  mybetLoading,
  mybetError,
}: {
  fixture: Fixture
  swiftBets: SwiftBetRow[] | null
  swiftLoading: boolean
  swiftError: string | null
  swiftActualStart: string | null
  mybetEventId: string | null
  mybetBets: MybetBetRow[] | null
  mybetLoading: boolean
  mybetError: string | null
}) {
  const swiftCount = swiftBets?.length ?? 0
  const mybetCount = mybetBets?.length ?? 0
  const [sub, setSub] = useState<'swift' | 'mybet'>('swift')

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-white/[0.05] bg-black/[0.06] px-3 py-2">
        <BrandSubTab active={sub === 'swift'} onClick={() => setSub('swift')} brand="swift" count={swiftCount} />
        <BrandSubTab active={sub === 'mybet'} onClick={() => setSub('mybet')} brand="mybet" count={mybetCount} />
      </div>
      {sub === 'swift' ? (
        <BetsTab fixture={f} bets={swiftBets} loading={swiftLoading} error={swiftError} swiftActualStart={swiftActualStart} />
      ) : (
        <MybetBetsView fixture={f} eventId={mybetEventId} bets={mybetBets} loading={mybetLoading} error={mybetError} />
      )}
    </div>
  )
}

/**
 * Combined SwiftBet + mybet exposure — the always-visible glance above the tab
 * strip. Reuses the same stat tiles; each shows the total with a per-brand
 * split so you can see both books at once from any tab.
 */
function CombinedExposure({ fixture: f, swiftBets, mybetBets }: { fixture: Fixture; swiftBets: SwiftBetRow[]; mybetBets: MybetBetRow[] }) {
  const s = aggregateBets(swiftBets, scoreCtx(f))
  const mUsers = new Set(mybetBets.map((b) => b.user_accountID)).size
  const mStake = mybetBets.reduce((a, b) => a + (b.amount_bet ?? 0), 0)
  const mPl = mybetBets.reduce((a, b) => a + (b.bet_result ?? 0), 0)
  const mOpen = mybetBets.filter((b) => /accepted/i.test(b.bet_status ?? '')).length

  const users = s.users + mUsers
  const bets = s.count + mybetBets.length
  const stake = s.stake + mStake
  const pl = s.pl + mPl
  const open = s.open + mOpen
  const live = f.status === 'live'
  const mode = f.status === 'completed' ? 'FINAL' : live ? 'LIVE' : 'PENDING'
  const split = (a: number | string, b: number | string) => `SWIFT ${a} · mybet ${b}`

  return (
    <div className="grid grid-cols-2 gap-2 border-t border-white/[0.05] bg-black/[0.1] px-5 py-3 sm:grid-cols-4">
      <StatCard label="Users" value={users} sub={split(s.users, mUsers)} />
      <StatCard label="Bets" value={bets} sub={split(s.count, mybetBets.length)} />
      <StatCard label="Stake" value={`$${stake.toFixed(2)}`} sub={split(`$${s.stake.toFixed(0)}`, `$${mStake.toFixed(0)}`)} />
      <StatCard
        label="P/L"
        value={`${pl < 0 ? '-' : ''}$${Math.abs(pl).toFixed(2)}`}
        tone={plTone(pl)}
        badge={mode}
        live={live}
        sub={open > 0 ? `${open} open` : split(`$${s.pl.toFixed(0)}`, `$${mPl.toFixed(0)}`)}
      />
    </div>
  )
}

function BrandSubTab({
  active,
  onClick,
  brand,
  count,
}: {
  active: boolean
  onClick: () => void
  brand: 'swift' | 'mybet'
  count: number
}) {
  const pill =
    brand === 'swift' ? BRAND_PILL.swift : BRAND_PILL.mybet
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
        active ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:bg-white/[0.04]'
      }`}
    >
      <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-medium ${pill}`}>
        {brand === 'swift' ? 'SWIFT' : 'MYBET'}
      </span>
      <span>Bets</span>
      <span className="tabular-nums text-[color:var(--muted-2)]">{count}</span>
    </button>
  )
}

/** Fetch mybet bets for a game — lifted so the sub-tab count and the view share it. */
function useMybetBets(args: { eventId: string | null; suspendAt: string | null; liveAt: string | null; home: string; away: string }) {
  const { eventId, suspendAt, liveAt, home, away } = args
  const [bets, setBets] = useState<MybetBetRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!eventId) {
      setBets(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    fetchMybetBets({ eventId, suspendAt, liveAt, home, away })
      .then((rows) => alive && setBets(rows))
      .catch((e) => alive && setError(String(e?.message ?? e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [eventId, suspendAt, liveAt, home, away])
  return { bets, loading, error }
}

/** mybet bets view — same layout as the SwiftBet view (stat header + grouped
 *  cards), grouped by bet type instead of market. */
function MybetBetsView({
  fixture: _f,
  eventId,
  bets,
  loading,
  error,
}: {
  fixture: Fixture
  eventId: string | null
  bets: MybetBetRow[] | null
  loading: boolean
  error: string | null
}) {
  if (!eventId) {
    return (
      <div className="px-5 py-6">
        <div className="rounded-lg border border-dashed border-[color:var(--line-soft)] p-6 text-center text-[12.5px] text-[color:var(--muted)]">
          No mybet mapping for this fixture — nothing to show. Map it on the{' '}
          <a href="/mapping" className="text-[color:var(--mybet)] underline">Mapping</a> tab.
        </div>
      </div>
    )
  }
  if (loading && !bets) {
    return (
      <div className="px-5 py-6">
        <PanelSkeleton fields={6} />
      </div>
    )
  }
  if (error) {
    return (
      <div className="px-5 py-6">
        <div className="rounded-lg border border-[var(--live)]/40 bg-[var(--live)]/5 p-4 text-[12px] text-gray-300">
          Could not load mybet bets: {error}
        </div>
      </div>
    )
  }
  const list = bets ?? []
  if (list.length === 0) {
    return (
      <div className="px-5 py-6">
        <div className="rounded-lg border border-dashed border-[color:var(--line-soft)] p-6 text-center text-[12.5px] text-[color:var(--muted)]">
          No MyBet bets matched for this game (event {eventId}).
        </div>
      </div>
    )
  }

  // One flat "All bets" list, newest placement first — mirrors the SwiftBet
  // Bets layout (same columns + styling).
  const placedMs = (b: MybetBetRow) => Date.parse(b.transaction_date ?? '') || 0
  const sorted = [...list].sort((a, b) => placedMs(b) - placedMs(a))

  return (
    <div className="space-y-3 px-5 py-5">
      <MybetAllCard bets={sorted} scheduledStart={_f.scheduledStart} actualStart={_f.actualStart} home={_f.homeName} away={_f.awayName} />
    </div>
  )
}

/** All mybet bets for the game in one table — mirrors SwiftBet's MarketBetsCard
 *  (same columns, header, styling). */
function MybetAllCard({ bets, scheduledStart, actualStart, home, away }: { bets: MybetBetRow[]; scheduledStart: string | null; actualStart: string | null; home: string; away: string }) {
  const stake = bets.reduce((s, b) => s + (b.amount_bet ?? 0), 0)
  const pl = bets.reduce((s, b) => s + (b.bet_result ?? 0), 0)
  const users = new Set(bets.map((b) => b.user_accountID)).size
  const lateCount = bets.filter((b) => b.placed_after_live).length
  // mybet marks a bet resulted by stamping its status with the return ticket
  // ("Return @ Tkt N") or "No Return"; "Accepted" means still running.
  const pending = bets.filter((b) => mybetSettlement(b.bet_status) === 'pending')
  const pendingStake = pending.reduce((sum, b) => sum + (b.amount_bet ?? 0), 0)
  return (
    <div className={`overflow-hidden rounded-lg bg-[color:var(--panel)]/50 ${lateCount > 0 ? 'border-t-2 border-[color:var(--live)]/60' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[color:var(--line-soft)] bg-black/[0.2] px-4 py-2.5">
        <span className="text-[13px] font-semibold text-gray-100">All bets</span>
        {lateCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--live)]/10 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--live)]">
            ⚠ {lateCount} after live
          </span>
        )}
        {pending.length > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[color:var(--up)]/10 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--up)]"
            title="mybet has not returned or settled these yet (status still Accepted)"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--up)] pulse-dot" />
            {pending.length} pending · ${pendingStake.toFixed(2)}
          </span>
        )}
        <span className="text-[11px] text-[color:var(--muted-2)]">
          {bets.length} {bets.length === 1 ? 'bet' : 'bets'} · {users} {users === 1 ? 'user' : 'users'}
        </span>
        <span className="ml-auto text-[11px] text-[color:var(--muted)]">
          Stake <span className="tabular-nums font-semibold text-gray-200">${stake.toFixed(2)}</span>
        </span>
        <span className="text-[11px] text-[color:var(--muted)]">
          P/L <span className={`tabular-nums font-semibold ${plTone(pl)}`}>{pl < 0 ? '-' : ''}${Math.abs(pl).toFixed(2)}</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-[12px]">
          <thead>
            <tr className="border-b border-[color:var(--line-soft)] bg-black/[0.12] text-left text-[11px] uppercase tracking-wide text-[color:var(--muted-2)]">
              {BET_COLS.map((c) => (
                <th key={c} className={`px-3 py-2 font-medium ${c === 'Stake' || c === 'Odds' || c === 'P/L' ? 'text-right' : ''}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bets.map((b) => (
              <MybetRow key={b.id} b={b} scheduledStart={scheduledStart} actualStart={actualStart} home={home} away={away} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** mybet result badge from bet_status, styled like SwiftBet's ResultCell. */
function mybetResult(status: string | null): ResolvedResult {
  const s = (status ?? '').toLowerCase()
  let label: ResLabel = 'Open'
  if (/won|winner|\bpaid\b/.test(s)) label = 'Won'
  else if (/lost|no return|loser/.test(s)) label = 'Lost'
  else if (/push|refund|cancel|void|dead heat/.test(s)) label = 'Push'
  return { label, tone: RES_TONE[label], derived: false }
}

/** Does `text` mention this team (any of its significant words, len ≥ 4)? */
function mentionsTeam(text: string, team: string): boolean {
  return team.toLowerCase().split(/\s+/).filter((w) => w.length >= 4).some((w) => text.includes(w))
}

/** The leg of a cross-game multi that IS this fixture — prefer one naming both
 *  teams, else either. */
function relevantLeg(legs: MybetBetRow['legs'], home: string, away: string) {
  const both = legs.find((l) => { const e = (l.event ?? '').toLowerCase(); return mentionsTeam(e, home) && mentionsTeam(e, away) })
  if (both) return both
  return legs.find((l) => { const e = (l.event ?? '').toLowerCase(); return mentionsTeam(e, home) || mentionsTeam(e, away) }) ?? null
}

/** Guess a bet's market from its selection text (mybet legs carry no market):
 *  Over/Under → Total, ±line/points → Handicap, Draw → Draw, a team name → Head
 *  to Head. Returns null when nothing matches. */
function guessMarket(selection: string, home: string, away: string): string | null {
  const t = (selection ?? '').toLowerCase()
  if (!t) return null
  if (/\bover\b|\bunder\b/.test(t)) return 'Total'
  if (/[+-]\s*\d|\bline\b|handicap|spread|\bpoints?\b/.test(t)) return 'Handicap'
  if (/\bdraw\b/.test(t)) return 'Draw'
  if (mentionsTeam(t, home) || mentionsTeam(t, away)) return 'Head to Head'
  return null
}

/** One mybet bet row — mirrors SwiftBet's BetRow columns and styling. SGMs (and
 *  only SGMs) expand to a per-leg breakdown; singles/multis stay one row. */
function MybetRow({ b, scheduledStart, actualStart, home, away }: { b: MybetBetRow; scheduledStart: string | null; actualStart: string | null; home: string; away: string }) {
  const [open, setOpen] = useState(false)
  const late = b.placed_after_live
  const isSgm = b.sgm && b.legs.length > 1
  const isMulti = b.is_multi && !isSgm
  const expandable = isSgm
  const typeBadge = isSgm ? `SGM · ${b.leg_count}` : isMulti ? `MULTI · ${b.leg_count}` : null
  // Cross-game multi: show ONLY the leg that is this game, not the whole multi
  // string. Singles carry their selection directly.
  const leg = isMulti ? relevantLeg(b.legs, home, away) : null
  const selection = (isMulti ? leg?.outcome : b.selections) ?? b.selections ?? '—'
  // Market isn't stored per leg — guess it from the selection; fall back to the
  // single's bet_type (Win / Place / Total / …).
  const market = isSgm ? '—' : (guessMarket(isMulti ? leg?.outcome ?? '' : b.selections ?? '', home, away) ?? b.bet_type ?? '—')
  const outcome = selection
  const res = mybetResult(b.bet_status)
  const stake = b.amount_bet ?? 0
  const pl = b.bet_result ?? 0
  return (
    <>
      <tr className={`border-t border-[color:var(--line-soft)] ${late ? 'bg-[color:var(--live)]/[0.06]' : 'hover:bg-white/[0.02]'}`}>
        <td className="px-3 py-2 align-top text-[11px] tabular-nums text-gray-200">
          {b.transaction_date ? melbDayTime(b.transaction_date) : '—'}
          {late && (
            <div className="mt-0.5 inline-flex items-center gap-1 rounded bg-[color:var(--live)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--live)]">
              after live
            </div>
          )}
        </td>
        <td className="px-3 py-2 align-top text-[11px] tabular-nums">
          <OffsetLabel placed={b.transaction_date} scheduled={scheduledStart} actual={actualStart} />
        </td>
        <td className="px-3 py-2 align-top font-mono text-[10.5px] text-[color:var(--muted-2)]">{b.user_accountID ?? '—'}</td>
        <td className="px-3 py-2 align-top text-gray-200">
          {typeBadge ? (
            <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-200">{typeBadge}</span>
          ) : (
            <span className="text-[11.5px]">SINGLE</span>
          )}
          {b.is_bonus && (
            <div className="mt-1">
              <span className="rounded bg-[color:var(--up)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--up)]">BONUS</span>
            </div>
          )}
        </td>
        {expandable ? (
          <td className="px-3 py-2 align-top text-gray-200" colSpan={2}>
            <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-left text-gray-200 hover:text-white">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <span>Same Game Multi</span>
              <span className="text-[color:var(--muted-2)]">· {b.leg_count} legs</span>
            </button>
          </td>
        ) : (
          <>
            <td className="px-3 py-2 align-top text-gray-200">{market}</td>
            <td className="max-w-[320px] px-3 py-2 align-top text-gray-300">{outcome}</td>
          </>
        )}
        <td className="px-3 py-2 align-top text-[11.5px] font-medium">
          <ResultCell r={res} />
        </td>
        <td className="px-3 py-2 text-right align-top tabular-nums text-gray-200">${stake.toFixed(2)}</td>
        <td className="px-3 py-2 text-right align-top tabular-nums text-gray-200">{b.price != null ? b.price.toFixed(2) : '—'}</td>
        <td className={`px-3 py-2 text-right align-top tabular-nums ${pl > 0 ? 'text-[color:var(--total)]' : pl < 0 ? 'text-[color:var(--live)]' : 'text-gray-300'}`}>
          ${pl.toFixed(2)}
        </td>
      </tr>
      {expandable && open && b.legs.map((lg, i) => (
        <tr key={i} className="border-t border-[color:var(--line-soft)]/40 bg-black/[0.18]">
          <td />
          <td />
          <td />
          <td className="px-3 py-1.5 align-top text-[10px] text-[color:var(--muted-2)]">leg {i + 1}</td>
          <td className="px-3 py-1.5 align-top text-[11.5px] text-gray-200">{lg.event ?? '—'}</td>
          <td className="px-3 py-1.5 align-top text-[11.5px] text-gray-300">{lg.outcome ?? '—'}</td>
          <td />
          <td />
          <td className="px-3 py-1.5 text-right align-top tabular-nums text-[11.5px] text-gray-300">
            {lg.odds != null ? lg.odds.toFixed(2) : '—'}
          </td>
          <td />
        </tr>
      ))}
    </>
  )
}

/** "2h before" / "+5m after live" — bet placement offset vs the game start. */
function OffsetLabel({ placed, scheduled, actual }: { placed: string | null; scheduled: string | null; actual: string | null }) {
  const o = placementOffset(placed, scheduled, actual)
  if (!o) return <span className="text-[color:var(--muted-2)]">—</span>
  return <span className={o.afterLive ? 'font-semibold text-[color:var(--live)]' : 'text-[color:var(--muted)]'}>{o.label}</span>
}

function scoreCtx(f: Fixture): ScoreCtx {
  return {
    status: f.status,
    homeScore: f.homeScore,
    awayScore: f.awayScore,
    homeName: f.homeName,
    awayName: f.awayName,
  }
}

function plTone(pl: number): string {
  return pl > 0 ? 'text-[color:var(--total)]' : pl < 0 ? 'text-[color:var(--live)]' : 'text-gray-100'
}

function StatCard({
  label,
  value,
  tone,
  badge,
  live,
  sub,
}: {
  label: string
  value: string | number
  tone?: string
  badge?: string
  live?: boolean
  sub?: string
}) {
  return (
    <div className="rounded-md bg-[color:var(--panel-2)] px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--muted-2)]">{label}</span>
        {badge && (
          <span
            className={`inline-flex items-center gap-1 text-[9px] font-bold tracking-wide ${
              live ? 'text-[color:var(--live)]' : 'text-[color:var(--muted-2)]'
            }`}
          >
            {live && <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />}
            {badge}
          </span>
        )}
      </div>
      <div className={`mt-0.5 text-[15px] font-semibold tabular-nums ${tone ?? 'text-gray-100'}`}>{value}</div>
      {sub && <div className="text-[10px] text-[color:var(--muted-2)]">{sub}</div>}
    </div>
  )
}

/** Users / Bets / Stake / P/L summary shown directly under the scoreboard. P/L
 *  is computed from the current score (so it ticks while live) and flips its
 *  badge LIVE → FINAL when the game ends. */
const BET_COLS = ['Placed', 'vs Start', 'User', 'Type', 'Market', 'Outcome', 'Result', 'Stake', 'Odds', 'P/L'] as const

/** One market's bets, as a card with its own aggregate header + bet table. */
function MarketBetsCard({ title, bets, fixture: f }: { title: string; bets: SwiftBetRow[]; fixture: Fixture }) {
  const agg = aggregateBets(bets, scoreCtx(f))
  const lateCount = bets.filter((b) => b.placed_after_start).length
  return (
    <div
      className={`overflow-hidden rounded-lg bg-[color:var(--panel)]/50 ${
        lateCount > 0 ? 'border-t-2 border-[color:var(--live)]/60' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[color:var(--line-soft)] bg-black/[0.2] px-4 py-2.5">
        <span className="text-[13px] font-semibold text-gray-100">{title}</span>
        {lateCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--live)]/10 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--live)]">
            ⚠ {lateCount} after start
          </span>
        )}
        {agg.mismatch > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--up)]/10 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--up)]">
            ⚠ {agg.mismatch} check settle
          </span>
        )}
        <span className="text-[11px] text-[color:var(--muted-2)]">
          {agg.count} {agg.count === 1 ? 'bet' : 'bets'} · {agg.users} {agg.users === 1 ? 'user' : 'users'}
        </span>
        <span className="ml-auto text-[11px] text-[color:var(--muted)]">
          Stake <span className="tabular-nums font-semibold text-gray-200">${agg.stake.toFixed(2)}</span>
        </span>
        <span className="text-[11px] text-[color:var(--muted)]">
          P/L{' '}
          <span className={`tabular-nums font-semibold ${plTone(agg.pl)}`}>
            {agg.pl < 0 ? '-' : ''}${Math.abs(agg.pl).toFixed(2)}
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-[12px]">
          <thead>
            <tr className="border-b border-[color:var(--line-soft)] bg-black/[0.12] text-left text-[11px] uppercase tracking-wide text-[color:var(--muted-2)]">
              {BET_COLS.map((c) => (
                <th
                  key={c}
                  className={`px-3 py-2 font-medium ${c === 'Stake' || c === 'Odds' || c === 'P/L' ? 'text-right' : ''}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bets.map((b) => (
              <BetRow key={b.bet_id ?? b.id} bet={b} fixture={f} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BetsTab({
  fixture: f,
  bets,
  loading,
  error,
  swiftActualStart,
}: {
  fixture: Fixture
  bets: SwiftBetRow[] | null
  loading: boolean
  error: string | null
  swiftActualStart: string | null
}) {
  if (loading && !bets) {
    return (
      <div className="px-5 py-6">
        <PanelSkeleton fields={6} />
      </div>
    )
  }
  if (error) {
    return (
      <div className="px-5 py-6">
        <div className="rounded-lg border border-[var(--live)]/40 bg-[var(--live)]/5 p-4 text-[12px] text-gray-300">
          Could not load bets: {error}
        </div>
      </div>
    )
  }
  const list = bets ?? []
  const ctx = scoreCtx(f)
  const lateCount = list.filter((b) => b.placed_after_start).length
  const mismatchCount = list.filter((b) => betMismatch(b, ctx)).length
  // Bets SwiftBet hasn't resulted yet. Worth surfacing on its own because the
  // feed pre-books a pending bet's `pl` as MINUS THE FULL STAKE and only flips
  // it to the real figure once resulted — so any P/L shown alongside is
  // pessimistic by exactly this stake until the book settles.
  const pending = list.filter((b) => betSettlement(b.bet_status) === 'pending')
  const pendingStake = pending.reduce((sum, b) => sum + (b.bet_amount ?? 0), 0)

  if (list.length === 0) {
    return (
      <div className="px-5 py-6">
        <div className="rounded-lg border border-dashed border-[color:var(--line-soft)] p-6 text-center text-[12.5px] text-[color:var(--muted)]">
          No bets matched on the SwiftBet side for this game. Linkage:{' '}
          <code className="text-gray-300">derived.event_key</code> /{' '}
          <code className="text-gray-300">legs_event_keys</code> regex.
        </div>
      </div>
    )
  }

  // One flat list of every bet on this event, newest placement on top — no
  // market/type grouping.
  const placedMs = (b: SwiftBetRow) => Date.parse(b.placed_at_utc ?? '') || Date.parse(b.bet_time ?? '') || 0
  const sorted = [...list].sort((a, b) => placedMs(b) - placedMs(a))

  return (
    <div className="space-y-3 px-5 py-5">
      {(swiftActualStart || lateCount > 0 || mismatchCount > 0 || pending.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-[color:var(--muted)]">
          {swiftActualStart && (
            <span>
              Actual start:{' '}
              <span className="tabular-nums font-medium text-gray-300">{melbDateTime(swiftActualStart)}</span> MEL
            </span>
          )}
          {lateCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--live)]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--live)]">
              ⚠ {lateCount} placed after start
            </span>
          )}
          {pending.length > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--up)]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--up)]"
              title="SwiftBet has not resulted these yet. Their pl is booked as minus the full stake until it does, so P/L above understates by this amount."
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--up)] pulse-dot" />
              {pending.length} pending result · ${pendingStake.toFixed(2)} at stake
            </span>
          )}
          {mismatchCount > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--up)]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--up)]"
              title="Bets whose settled result contradicts the final score — worth a manual review"
            >
              ⚠ {mismatchCount} to review (settle vs score)
            </span>
          )}
        </div>
      )}
      <MarketBetsCard title="All bets" bets={sorted} fixture={f} />
    </div>
  )
}

/**
 * gutsy.bets `bet_time` is Melbourne wall-clock with a misleading `Z` suffix
 * (see server-side conversion). Display it as DD/MM HH:MM directly without
 * any timezone conversion — the wall-clock components are already correct.
 */
function melbWallClock(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw)
  if (!m) return raw
  const [, , mo, d, h, mi] = m
  return `${d}/${mo} ${h}:${mi}`
}

/** This game's share of a bet's stake: a multi spreads its stake across legs,
 *  so attribute stake ÷ legs; a single keeps its full stake. */
function legStake(b: SwiftBetRow): number {
  const stake = b.bet_amount ?? 0
  const isMulti = (b.type ?? '').toUpperCase() === 'MULTI'
  return isMulti && b.leg_count > 0 ? stake / b.leg_count : stake
}

/** Overall multi status from per-leg result labels: dead the moment any leg
 *  loses, won when every leg won (pushes don't kill it), otherwise still alive
 *  (legs pending, none lost). Drives the live/settled badge. */
type MultiStatus = 'Alive' | 'Won' | 'Lost'
function statusFromLabels(labels: Array<'Won' | 'Lost' | 'Open' | 'Push'>): MultiStatus | null {
  if (labels.length === 0) return null
  if (labels.some((l) => l === 'Lost')) return 'Lost'
  if (labels.every((l) => l === 'Won' || l === 'Push')) return 'Won'
  return 'Alive'
}

const MULTI_STATUS_BADGE: Record<MultiStatus, string> = {
  Alive: 'bg-[color:var(--up)]/10 text-[color:var(--up)]',
  Won: 'bg-[color:var(--total)]/10 text-[color:var(--total)]',
  Lost: 'bg-[color:var(--live)]/10 text-[color:var(--live)]',
}

type ResLabel = 'Won' | 'Lost' | 'Open' | 'Push'
interface ResolvedResult {
  label: ResLabel
  tone: string
  derived: boolean // true → we settled it from the final score, book hadn't
  // Set when the book HAS settled this leg but the final score implies the
  // opposite — i.e. a possible mis-settlement to review. Holds what the score
  // says it should be.
  expected?: 'Won' | 'Lost' | null
}

const RES_TONE: Record<ResLabel, string> = {
  Won: 'text-[color:var(--total)]',
  Lost: 'text-[color:var(--live)]',
  Push: 'text-gray-300',
  Open: 'text-gray-400',
}

/** Won/Lost/Open from a raw status (ResultedWin/Lost/Unresulted or Won/Lost/Pending). */
function normLabel(raw: string | null): 'Won' | 'Lost' | 'Open' {
  const s = (raw ?? '').toLowerCase()
  if (s.includes('win') || s === 'won') return 'Won'
  if (s.includes('los') || s === 'lost') return 'Lost'
  return 'Open'
}

/**
 * Resolve a selection's result: prefer the book's settlement; when it's still
 * Open, fall back to deriving it from the fixture's final score (full-match
 * markets only — see settleFromScore). `derived` flags the latter so the UI can
 * mark it as inferred.
 */
function resolveResult(
  officialRaw: string | null,
  sel: { market: string | null; mt: string | null; outcome: string | null },
  ctx: ScoreCtx,
  allowLive = false,
): ResolvedResult {
  const off = normLabel(officialRaw)
  if (off !== 'Open') {
    // Book settled it — cross-check against the FINAL score (completed only, no
    // allowLive) for a possible mis-settlement. A Won↔Lost contradiction is the
    // signal; a Push vs Won/Lost is too noisy to flag.
    const check = settleFromScore(sel, ctx)
    const expected = (check === 'Won' || check === 'Lost') && check !== off ? check : null
    return { label: off, tone: RES_TONE[off], derived: false, expected }
  }
  const d = settleFromScore(sel, ctx, { allowLive })
  if (d) return { label: d, tone: RES_TONE[d], derived: true }
  return { label: 'Open', tone: RES_TONE.Open, derived: false }
}

/** Renders a result: "~" + tooltip when derived from the score; a ⚠ + tooltip
 *  when the book's settled result contradicts the final score. */
function ResultCell({ r }: { r: ResolvedResult }) {
  if (r.expected) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[color:var(--up)]"
        title={`Possible mis-settlement: book settled ${r.label}, but the final score implies ${r.expected}`}
      >
        ⚠ {r.label}
        <span className="text-[10px] text-[color:var(--muted-2)]">→ {r.expected}?</span>
      </span>
    )
  }
  return (
    <span
      className={`${r.tone} ${r.derived ? 'italic' : ''}`}
      title={r.derived ? 'Derived from the final score — the book had not settled this leg' : undefined}
    >
      {r.derived ? '~' : ''}
      {r.label}
    </span>
  )
}

/** Does any leg/selection of this bet look mis-settled vs the final score? */
function betMismatch(b: SwiftBetRow, ctx: ScoreCtx): boolean {
  const sels = b.matched_leg?.selections ?? []
  if (sels.length) return sels.some((s) => !!resolveResult(s.status, s, ctx).expected)
  const ml = b.matched_leg
  return ml ? !!resolveResult(ml.status, ml, ctx).expected : false
}

/** Overall result of a bet w.r.t. THIS game: prefer the granular selection
 *  status, then leg_breakdown, then score-derivation; an SGM combines its
 *  selections (any lost → lost, all won → won). */
function resolveBet(b: SwiftBetRow, ctx: ScoreCtx, allowLive = false): ResolvedResult {
  const isSgm = (b.type ?? '').toUpperCase() === 'SGM'
  const sels = b.matched_leg?.selections ?? []
  const leg =
    b.leg_breakdown && b.matched_leg_index >= 0 ? b.leg_breakdown[b.matched_leg_index] ?? null : null
  if (isSgm && sels.length) {
    const official = normLabel(leg?.result ?? null)
    if (official !== 'Open') return { label: official, tone: RES_TONE[official], derived: false }
    const sr = sels.map((s) => resolveResult(s.status, s, ctx, allowLive))
    if (sr.some((r) => r.label === 'Lost'))
      return { label: 'Lost', tone: RES_TONE.Lost, derived: sr.some((r) => r.label === 'Lost' && r.derived) }
    if (sr.every((r) => r.label === 'Won' || r.label === 'Push'))
      return { label: 'Won', tone: RES_TONE.Won, derived: sr.some((r) => r.derived) }
    return { label: 'Open', tone: RES_TONE.Open, derived: false }
  }
  const selStatus = b.matched_leg?.status ?? null
  const best = normLabel(selStatus) !== 'Open' ? selStatus : leg?.result ?? null
  return resolveResult(best, b.matched_leg ?? { market: null, mt: null, outcome: null }, ctx, allowLive)
}

/**
 * Customer P/L for a bet at the CURRENT score (so it ticks live in-play and
 * lands on the final P/L once the game ends). A single/SGM resolves fully; a
 * multi only resolves to a loss when this game's leg loses (which kills it) or,
 * once the game is over, to the book's settled `pl` (its other legs are on games
 * we don't fetch). `decided=false` → still open at the current score.
 */
function projectBet(b: SwiftBetRow, ctx: ScoreCtx): { pl: number; decided: boolean } {
  const stake = b.bet_amount ?? 0
  const odd = b.odd ?? 1
  const isMulti = (b.type ?? '').toUpperCase() === 'MULTI'
  // allowLive: provisionally settle from the in-play score so the liability
  // ticks while the game is live.
  const res = resolveBet(b, ctx, true)
  if (res.label === 'Lost') return { pl: -stake, decided: true }
  if (res.label === 'Won') {
    if (isMulti) {
      if (ctx.status === 'completed') return { pl: b.pl ?? 0, decided: true }
      return { pl: 0, decided: false } // leg ahead, but the multi rides on other games
    }
    return { pl: stake * (odd - 1), decided: true }
  }
  return { pl: 0, decided: false }
}

export interface BetsAgg {
  users: number
  count: number
  stake: number
  pl: number
  open: number // bets not yet decided at the current score
  mismatch: number // bets whose settled result contradicts the final score
}
function aggregateBets(list: SwiftBetRow[], ctx: ScoreCtx): BetsAgg {
  const users = new Set<string>()
  let stake = 0
  let pl = 0
  let open = 0
  let mismatch = 0
  for (const b of list) {
    users.add(b.user_id)
    stake += legStake(b)
    const p = projectBet(b, ctx)
    pl += p.pl
    if (!p.decided) open++
    if (betMismatch(b, ctx)) mismatch++
  }
  return { users: users.size, count: list.length, stake, pl, open, mismatch }
}

function BetRow({ bet: b, fixture: f }: { bet: SwiftBetRow; fixture: Fixture }) {
  const [open, setOpen] = useState(false)
  const late = b.placed_after_start
  const stake = b.bet_amount ?? 0
  const pl = b.pl ?? 0
  const odd = b.odd ?? null
  const isMulti = (b.type ?? '').toUpperCase() === 'MULTI'
  const isSgm = (b.type ?? '').toUpperCase() === 'SGM'
  // Selections inside the leg that IS this game. An SGM has several (each a
  // market/outcome on the same game) and is expandable to show them all.
  const sels = b.matched_leg?.selections ?? []
  const expandable = sels.length > 1
  // For multis, pull the breakdown row that corresponds to THIS game so the
  // panel shows the leg-specific market/outcome rather than the multi's
  // headline. matched_leg_index points into legs_event_keys, which mirrors
  // legs_breakdown order one-to-one.
  const leg =
    b.leg_breakdown && b.matched_leg_index >= 0 ? b.leg_breakdown[b.matched_leg_index] ?? null : null
  const marketLabel = isMulti
    ? leg?.market_category ?? b.market_category ?? '—'
    : b.market_category ?? '—'
  // The leg that IS this game carries its own selection + price. Show those —
  // for a multi the Odds column shows the LEG price (the multi's combined odds
  // moves to a sub-label), so the row describes this game's actual bet.
  const outcome = (b.matched_leg?.outcome ?? '').trim() || null
  const legOdds = b.matched_leg?.odds ?? null
  // An SGM is one bet on this game, so its combined price IS the bet's total
  // odd (the per-leg `dividend` is often 0 for SGMs). A multi/single shows the
  // leg price, falling back to the bet odd.
  const shownOdds = isSgm ? odd : legOdds ?? odd
  const perLegStake = legStake(b)
  const typeBadge = isSgm ? `SGM · ${sels.length}` : isMulti ? `MULTI · ${b.leg_count}` : null
  // SwiftBet's OWN settlement state, distinct from the per-selection Won/Lost
  // we derive: a bet can have every leg decided and still not be resulted or
  // paid. 'unknown' means the bet predates the bet_status field (2026-07-31),
  // so we show nothing rather than implying it's outstanding.
  const settlement = betSettlement(b.bet_status)

  // Fill in unsettled legs from the fixture's final score (full-match markets).
  const ctx: ScoreCtx = {
    status: f.status,
    homeScore: f.homeScore,
    awayScore: f.awayScore,
    homeName: f.homeName,
    awayName: f.awayName,
  }
  const selResults = sels.map((s) => resolveResult(s.status, s, ctx))
  // Main-row result (prefers granular selection status, then leg_breakdown,
  // then score-derivation; SGMs combine their selections).
  const mainRes = resolveBet(b, ctx)
  // Badge. SGM reflects its (possibly derived) overall result. A multi combines
  // ALL legs: this game's leg uses the resolved result above; sibling legs
  // (other games, not fetched here) fall back to their leg_breakdown summary.
  const mStatus: MultiStatus | null = isSgm
    ? mainRes.label === 'Won'
      ? 'Won'
      : mainRes.label === 'Lost'
        ? 'Lost'
        : 'Alive'
    : isMulti
      ? statusFromLabels(
          (b.leg_breakdown ?? []).map((l, i) =>
            i === b.matched_leg_index ? mainRes.label : normLabel(l.result),
          ),
        )
      : null
  return (
    <>
      <tr
        className={`border-t border-[color:var(--line-soft)] ${
          late ? 'bg-[color:var(--live)]/[0.06]' : 'hover:bg-white/[0.02]'
        }`}
      >
        <td className="px-3 py-2 align-top text-[11px] tabular-nums text-gray-200">
          {b.bet_time ? `${melbWallClock(b.bet_time)} MEL` : '—'}
          {late && (
            <div className="mt-0.5 inline-flex items-center gap-1 rounded bg-[color:var(--live)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--live)]">
              after start
            </div>
          )}
        </td>
        <td className="px-3 py-2 align-top text-[11px] tabular-nums">
          <OffsetLabel placed={b.placed_at_utc} scheduled={f.scheduledStart} actual={f.actualStart} />
        </td>
        <td className="px-3 py-2 align-top font-mono text-[10.5px] text-[color:var(--muted-2)]">
          {b.user_id?.slice(0, 8) ?? '—'}
        </td>
        <td className="px-3 py-2 align-top text-gray-200">
          {typeBadge ? (
            <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-200">
              {typeBadge}
            </span>
          ) : (
            <span className="text-[11.5px]">{(b.type ?? 'SINGLE').toUpperCase()}</span>
          )}
          {mStatus && (
            <div className="mt-1">
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${MULTI_STATUS_BADGE[mStatus]}`}
              >
                {mStatus === 'Alive' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--up)] pulse-dot" />
                )}
                {mStatus === 'Alive' ? 'ALIVE' : mStatus === 'Won' ? 'WON' : 'LOST'}
              </span>
            </div>
          )}
          {b.scratched && (
            <div className="mt-0.5 text-[10px] text-[color:var(--muted-2)]">scratched</div>
          )}
          {/* SwiftBet's settlement state. Only shown when the book actually
              tells us — bets predating the bet_status field stay unlabelled
              rather than being implied to be outstanding. */}
          {settlement === 'pending' && (
            <div className="mt-1">
              <span className="inline-flex items-center gap-1 rounded bg-[color:var(--up)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--up)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--up)] pulse-dot" />
                PENDING
              </span>
            </div>
          )}
          {settlement === 'void' && (
            <div className="mt-1">
              <span
                className="inline-flex items-center rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--muted)]"
                title={b.bet_status ?? undefined}
              >
                {(b.bet_status ?? 'VOID').toUpperCase()}
              </span>
            </div>
          )}
        </td>
        {/* Market / Outcome — an expandable SGM collapses its legs behind a toggle. */}
        {expandable ? (
          <td className="px-3 py-2 align-top text-gray-200" colSpan={2}>
            <button
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-left text-gray-200 hover:text-white"
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <span>Same Game Multi</span>
              <span className="text-[color:var(--muted-2)]">· {sels.length} legs</span>
            </button>
          </td>
        ) : (
          <>
            <td className="px-3 py-2 align-top text-gray-200">{marketLabel}</td>
            <td className="px-3 py-2 align-top text-gray-300">{outcome ?? '—'}</td>
          </>
        )}
        <td className="px-3 py-2 align-top text-[11.5px] font-medium">
          <ResultCell r={mainRes} />
        </td>
        <td className="px-3 py-2 text-right align-top tabular-nums text-gray-200">
          ${perLegStake.toFixed(2)}
          {isMulti && (
            <div className="mt-0.5 text-[10px] text-[color:var(--muted-2)]">of ${stake.toFixed(2)}</div>
          )}
        </td>
        <td className="px-3 py-2 text-right align-top tabular-nums text-gray-200">
          {shownOdds != null ? shownOdds.toFixed(2) : '—'}
          {isMulti && odd != null && (
            <div className="mt-0.5 text-[10px] text-[color:var(--muted-2)]">multi {odd.toFixed(2)}</div>
          )}
        </td>
        <td
          className={`px-3 py-2 text-right align-top tabular-nums ${
            pl > 0 ? 'text-[color:var(--total)]' : pl < 0 ? 'text-[color:var(--live)]' : 'text-gray-300'
          }`}
        >
          ${pl.toFixed(2)}
        </td>
      </tr>
      {/* Expanded SGM legs: one sub-row per selection (market · outcome · price). */}
      {expandable &&
        open &&
        sels.map((s, i) => {
          const r = selResults[i]
          return (
            <tr key={i} className="border-t border-[color:var(--line-soft)]/40 bg-black/[0.18]">
              <td />
              <td />
              <td />
              <td className="px-3 py-1.5 align-top text-[10px] text-[color:var(--muted-2)]">
                leg {i + 1}
              </td>
              <td className="px-3 py-1.5 align-top text-[11.5px] text-gray-200">{s.market ?? '—'}</td>
              <td className="px-3 py-1.5 align-top text-[11.5px] text-gray-300">{s.outcome ?? '—'}</td>
              <td className="px-3 py-1.5 align-top text-[11px] font-medium">
                <ResultCell r={r} />
              </td>
              <td />
              <td className="px-3 py-1.5 text-right align-top tabular-nums text-[11.5px] text-gray-300">
                {s.odds != null ? s.odds.toFixed(2) : '—'}
              </td>
              <td />
            </tr>
          )
        })}
    </>
  )
}

function StatusBadge({ fixture: f, now }: { fixture: Fixture; now: Date }) {
  if (f.status === 'live') {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[color:var(--live)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />
        Live · {periodState(f.sport, f.periods) ?? 'Live'}
      </span>
    )
  }
  if (f.status === 'completed') {
    return <span className="text-[12.5px] font-medium text-[color:var(--muted)]">Final</span>
  }
  const overdue = overdueMinutes(f.startTime, now)
  return (
    <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-[color:var(--up)]">
      {startsInLabel(f.startTime, now)}
      {overdue >= 3 && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-[color:var(--live)]/10 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--live)]"
          title={`Scheduled start was ${overdue} min ago but it hasn't gone live — possibly delayed`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />
          possible delay
        </span>
      )}
    </span>
  )
}

function Score({
  name,
  logo,
  score,
  leads,
}: {
  name: string
  logo: string | null
  score: number | null
  leads: boolean
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="flex min-w-0 items-center gap-3 pr-3">
        <Avatar name={name} logoUrl={logo} size={28} />
        <span className="truncate text-lg text-gray-100">{name}</span>
      </span>
      <span
        className={`text-2xl font-bold tabular-nums ${
          score == null ? 'text-gray-700' : leads ? 'text-[var(--total)]' : 'text-gray-100'
        }`}
      >
        {score == null ? '–' : score}
      </span>
    </div>
  )
}

function PeriodRow({
  name,
  per,
  total,
  leads,
}: {
  name: string
  per: (number | null)[]
  total: number | null
  leads: boolean
}) {
  return (
    <tr className="border-t border-white/5">
      <td className="truncate py-1.5 pr-3 text-gray-200">{name}</td>
      {per.map((v, i) => (
        <td key={i} className="py-1.5 text-right text-gray-400">
          {v ?? '·'}
        </td>
      ))}
      <td className={`py-1.5 text-right font-bold ${leads ? 'text-[var(--total)]' : 'text-gray-100'}`}>
        {total ?? '–'}
      </td>
    </tr>
  )
}

function Section({
  title,
  children,
  last,
}: {
  title: string
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <div className={`px-5 py-4 ${last ? '' : 'border-t border-white/[0.05]'}`}>
      <div className="mb-3 text-[12px] font-medium text-[color:var(--muted)]">
        {prettySectionTitle(title)}
      </div>
      {children}
    </div>
  )
}

/** Convert "SCORE BY PERIOD · SETS" → "Score by period · Sets" (keep separators). */
function prettySectionTitle(t: string): string {
  return t
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      if (w === '·' || w === '·') return w
      // capitalise the first word; leave rest lowercase unless it's a special token
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1)
      // capitalise after a separator
      return w
    })
    .join(' ')
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-3">{children}</div>
}

function Field({
  label,
  value,
  mono,
  copyable,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  copyable?: boolean
  /** Optional text colour class, e.g. the settlement verdict's amber/green. */
  tone?: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[color:var(--muted-2)]">{prettyLabel(label)}</div>
      <div className="flex items-center gap-1.5">
        <div className={`truncate text-[13px] ${tone ?? 'text-gray-200'} ${mono ? 'tabular-nums' : ''}`}>{value}</div>
        {copyable && value && value !== '—' && <CopyButton value={value} />}
      </div>
    </div>
  )
}

/** Inline copy-to-clipboard button. Shows a brief ✓ check on success. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // clipboard unavailable (insecure context) — best-effort fallback
      const ta = document.createElement('textarea')
      ta.value = value
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }
  return (
    <button
      onClick={copy}
      className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-gray-200"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
      aria-label={`Copy ${value}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-[var(--total)]" strokeWidth={3} />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  )
}

function negate(v: number | null): number | null {
  return v == null ? null : -v
}

function leads(a: number | null, b: number | null): boolean {
  return a != null && b != null && a > b
}
