import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backOr } from '../lib/nav'
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { useTerminal } from '../components/Layout'
import { BetsSkeleton, DetailSkeleton, PanelSkeleton } from '../components/Skeleton'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { fetchFixtureById } from '../lib/dataSource'
import { fetchSwiftEvent, swiftEventUrl } from '../lib/swiftStatus'
import { betSettlement, fetchSwiftBets, type SwiftBetRow } from '../lib/swiftBets'
import { fetchMybetBets, mybetSettlement, type MybetBetRow } from '../lib/mybetBets'
import { CopyButton, Field, Grid, SourcePanel } from '../components/SourcePanel'
import { BrandSubTab, StatCard } from '../components/BetsChrome'
import { pollWithVisibility } from '../lib/poll'
import { settleFromScore, type ScoreCtx } from '../lib/settleBet'
import { leagueLabel, periodAbbrev, periodNoun, periodState } from '../lib/sports'
import { Avatar } from '../components/Avatar'
import { LeagueBadge } from '../components/LeagueBadge'
import type { Fixture, FlucSnapshot } from '../lib/types'
import { agoLabel, fmtDateTime, fmtLine, melbDateTime, melbDayTime, overdueMinutes, placementOffset, startsInLabel } from '../lib/format'
import { fetchEventMappingsFor, fetchCompetitionMappings, type EventMapping, type CompetitionMapping } from '../lib/mappingData'
import { getSwiftCatalog, type SwiftCompetition, type SwiftEvent } from '../lib/swiftCatalog'
import { getMybetCatalog, type MybetCompetition, type MybetEvent } from '../lib/mybetCatalog'
import { fetchMybetEvent, mybetEventUrl, type MybetLiveEvent } from '../lib/mybetStatus'
import { fixturePath, idFromParam } from '../lib/routes'
import { bookLogo } from '../lib/bookLogos'
import { BRAND_TONE } from '../lib/brand'
import {
  allLines,
  normaliseFlucs,
  normaliseMarket,
  pricesAt,
  withCurrent,
  type BookOdds,
  type SidePrices,
} from '../lib/marketOdds'
import {
  fairKey,
  fetchFixtureMarkets,
  periodsOf,
  type MarketGroup,
} from '../lib/fixtureMarkets'

export default function FixtureDetailPage() {
  const navigate = useNavigate()
  const params = useParams()
  // The param may be a bare OPTIC id or "home-v-away-<id>". Only the id is
  // trusted; the slug is never read back, so a renamed team can't 404 a link.
  const id = idFromParam(params.id)
  const urlTab = TAB_FROM_PATH[params.tab ?? ''] ?? 'details'
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

  // Rewrite a bare-id or stale-slug URL to the canonical one once the teams are
  // known, so what gets copied out of the address bar is the readable form.
  // replace(), not push() — the un-slugged URL should not become a back step
  // that immediately re-redirects.
  //
  // Read from `candidate`, not `f`: `f` falls back to the lastGood ref, and
  // deriving the path from a ref during render is exactly what that ref is not
  // for. `candidate` is the freshly-resolved fixture, which is all the URL
  // needs — it only has to be right once, when the fixture first loads.
  const homeName = candidate?.homeName ?? ''
  const awayName = candidate?.awayName ?? ''
  useEffect(() => {
    if (!id || !homeName) return
    const canonical = fixturePath(id, { home: homeName, away: awayName, tab: urlTab })
    if (decodeURIComponent(window.location.pathname) !== decodeURIComponent(canonical)) {
      navigate(canonical, { replace: true })
    }
  }, [id, homeName, awayName, urlTab, navigate])

  // DetailSkeleton carries the page frame itself (max width, padding), so it
  // replaces the whole return rather than sitting inside it.
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
        <div className="flex h-48 flex-col items-center justify-center gap-1 text-[13px] text-[color:var(--muted-2)]">
          <span>{id ? 'Fixture not found.' : 'That URL carries no fixture id.'}</span>
          {!id && (
            <span className="text-[11.5px]">
              A fixture link ends in its 16-character OPTIC id.
            </span>
          )}
        </div>
      ) : (
        <Detail fixture={f} now={now} mappingInfo={mappingInfo} tab={urlTab} />
      )}
    </div>
  )
}

type DetailTab = 'details' | 'markets' | 'bets'

/** URL segment → tab. Anything unrecognised falls back to Details rather than
 *  404ing, since the segment is cosmetic. */
const TAB_FROM_PATH: Record<string, DetailTab> = {
  '': 'details',
  details: 'details',
  markets: 'markets',
  bets: 'bets',
}

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
  tab,
  fixture: f,
  now,
  mappingInfo,
}: {
  fixture: Fixture
  now: Date
  mappingInfo: MappingInfo
  tab: DetailTab
}) {
  // The tab lives in the URL so it can be linked to and survives a reload.
  // Replace rather than push: flicking between tabs shouldn't fill the back
  // button with steps you have to click through to leave the fixture.
  const navigate = useNavigate()
  const setTab = (t: DetailTab) =>
    navigate(fixturePath(f.id, { home: f.homeName, away: f.awayName, tab: t }), { replace: true })
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
      {tab === 'markets' && <MarketsTab fixture={f} now={now} />}
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
    return <PanelSkeleton fields={10} tone={BRAND_TONE.swift} />
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
    return <PanelSkeleton fields={10} tone={BRAND_TONE.mybet} />
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

// Reserved keys on each market block in pregame_odds (not bookmakers).

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

/**
 * Markets, read from the Odds Library (`odds` + `odds_sp`).
 *
 * The old jsonb path is kept below as `LegacyMarketsTab` and used when the new
 * tables have nothing for this fixture. That is not belt-and-braces: `odds` is
 * a WORKING set, pruned once a fixture settles, so it covers the next few days
 * well (38/40 in the next 24h) and history barely at all (3/40 a week back),
 * while `live_fixtures.pregame_odds` still holds those older fixtures. Reading
 * only the new table would have blanked the tab on anything more than a few
 * days old.
 */
function MarketsTab({ fixture: f, now }: { fixture: Fixture; now: Date }) {
  const [groups, setGroups] = useState<MarketGroup[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setGroups(null)
    setFailed(false)
    fetchFixtureMarkets(f.id, {
      homeName: f.homeName,
      awayName: f.awayName,
      scheduledStart: f.scheduledStart ?? f.startTime,
    })
      .then((g) => alive && setGroups(g))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [f.id, f.homeName, f.awayName, f.scheduledStart, f.startTime])

  if (!failed && groups === null) return <PanelSkeleton fields={4} />
  // Nothing in the new tables (or they errored) — fall back to the jsonb the
  // page has always read, which still covers settled fixtures.
  if (failed || !groups?.length) return <LegacyMarketsTab fixture={f} now={now} />

  return <MarketsView fixture={f} now={now} groups={groups} />
}

function MarketsView({
  fixture: f,
  now,
  groups,
}: {
  fixture: Fixture
  now: Date
  groups: MarketGroup[]
}) {
  const periods = periodsOf(groups)
  const lastPriced =
    groups
      .map((g) => g.lastPriced)
      .filter((t): t is string => !!t && Number.isFinite(Date.parse(t)))
      .sort()
      .at(-1) ?? null
  const bookCount = new Set(
    groups.flatMap((g) => [...g.pregame, ...g.live].map((b) => b.book)),
  ).size
  const liveMarkets = groups.filter((g) => g.live.length > 0).length

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-white/[0.05] bg-black/[0.12] px-5 py-2.5 text-[12px] text-[color:var(--muted)]">
        <span className="flex items-center gap-2">
          Live odds
          <span
            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
              liveMarkets
                ? 'border-[color:var(--live)]/40 bg-[color:var(--live)]/[0.1] text-[color:var(--live)]'
                : 'border-[color:var(--line-soft)]/60 bg-black/[0.2] text-[color:var(--muted-2)]'
            }`}
          >
            {liveMarkets ? `${liveMarkets} in play` : 'none'}
          </span>
        </span>
        <span>
          Updated <span className="ml-1 text-gray-200 tabular-nums">{fmtDateTime(lastPriced)}</span>
          {lastPriced && (
            <span className="ml-1.5 text-[color:var(--muted-2)]">({agoLabel(lastPriced, now)})</span>
          )}
        </span>
        {(f.openAt || f.closeAt) && (
          <span className="flex items-center gap-4">
            {f.openAt && (
              <span>
                Opened <span className="ml-1 text-gray-200 tabular-nums">{fmtDateTime(f.openAt)}</span>
              </span>
            )}
            {f.closeAt && (
              <span>
                Closed <span className="ml-1 text-gray-200 tabular-nums">{fmtDateTime(f.closeAt)}</span>
              </span>
            )}
          </span>
        )}
        <span className="ml-auto text-[color:var(--muted-2)]">
          {groups.length} market{groups.length === 1 ? '' : 's'} · {bookCount} book
          {bookCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="space-y-4 px-5 py-4">
        {periods.map((period) => {
          const inPeriod = groups.filter((g) => g.period === period)
          return (
            <Fragment key={period}>
              {/* Only head the sections once there is more than one period —
                  a fixture with only full-game markets needs no divider. */}
              {periods.length > 1 && (
                <div className="flex items-center gap-3 pt-1">
                  <span className="text-[11px] font-semibold tracking-wide text-[color:var(--muted-2)] uppercase">
                    {period}
                  </span>
                  <span className="h-px flex-1 bg-white/[0.06]" />
                </div>
              )}
              {inPeriod.map((g) => (
                <MarketGroupCard key={g.marketId} group={g} />
              ))}
            </Fragment>
          )
        })}
      </div>
    </>
  )
}

/** One market's card, adapting a MarketGroup onto the existing MarketCard. */
function MarketGroupCard({ group: g }: { group: MarketGroup }) {
  const byBook = new Map(g.pregame.map((b) => [b.book, b]))
  const books = g.pregame.map((b) => b.book)

  return (
    <MarketCard
      title={g.title}
      kind={g.kind}
      books={books}
      outcomes={g.outcomes}
      getPrice={(book, k) => byBook.get(book)?.mainPrices[k as keyof SidePrices] ?? null}
      getLive={(k) => g.livePrices[k] ?? null}
      liveLine={g.liveLine}
      getLine={(book) => byBook.get(book)?.mainLine ?? null}
      lineSuffix={
        g.kind === 'spread'
          ? (k, line) => (line == null ? undefined : fmtLine(k === 'away' ? negate(line) : line))
          : g.kind === 'total'
            ? (k, line) => (line == null ? undefined : `${k === 'over' ? 'O' : 'U'} ${line}`)
            : undefined
      }
      odds={g.pregame}
      flucs={g.flucs}
      fair={g.fair}
      suspended={g.suspended}
    />
  )
}

function LegacyMarketsTab({ fixture: f, now }: { fixture: Fixture; now: Date }) {
  const po = f.pregameOdds
  // Both odds shapes flow through the normaliser: the old flat one and the
  // alternate-lines ladder the feed started writing on 2026-08-11. Reading the
  // raw block would show a column per book and a dash in every cell on any
  // fixture written since.
  const h2h = useMemo(() => normaliseMarket(po?.h2h, 'h2h'), [po?.h2h])
  const spread = useMemo(() => normaliseMarket(po?.spread, 'spread'), [po?.spread])
  const total = useMemo(() => normaliseMarket(po?.total, 'total'), [po?.total])
  const h2hBooks = h2h.map((b) => b.book)
  const spreadBooks = spread.map((b) => b.book)
  const totalBooks = total.map((b) => b.book)
  const hasDraw = h2h.some((b) => b.mainPrices.draw != null)
  const byBook = (odds: BookOdds[]) => new Map(odds.map((b) => [b.book, b]))
  const h2hMap = byBook(h2h)
  const spreadMap = byBook(spread)
  const totalMap = byBook(total)
  // Each series ends with the CURRENT price from pregame_odds, so every event
  // has a movement — open → current — rather than only those with two captures.
  const rowUpdatedAt = f.updatedAt
  const flucsH2h = useMemo(
    () => withCurrent(normaliseFlucs(f.flucs?.h2h, 'h2h'), h2h, rowUpdatedAt),
    [f.flucs?.h2h, h2h, rowUpdatedAt],
  )
  const flucsSpread = useMemo(
    () => withCurrent(normaliseFlucs(f.flucs?.spread, 'spread'), spread, rowUpdatedAt),
    [f.flucs?.spread, spread, rowUpdatedAt],
  )
  const flucsTotal = useMemo(
    () => withCurrent(normaliseFlucs(f.flucs?.total, 'total'), total, rowUpdatedAt),
    [f.flucs?.total, total, rowUpdatedAt],
  )

  // "Updated" has to survive an UPCOMING fixture, where live_updated_at is null
  // and the row would otherwise read "—" despite carrying fresh prices. Newest
  // fluc snapshot first, since that is literally when a price was last written.
  //
  // Read the stamps off the NORMALISED flucs, not the raw ones. The daily stage
  // is an array, so `snap.at` on the raw value resolved to Array.prototype.at —
  // a function, which is truthy — and sorted to the end, leaving the header
  // reading "Updated — (NaNm ago)".
  const lastPriced =
    [
      ...[flucsH2h, flucsSpread, flucsTotal].flatMap((m) =>
        Object.values(m).flatMap((byStage) => Object.values(byStage).map((snap) => snap.at ?? null)),
      ),
      f.liveUpdatedAt,
      f.updatedAt,
    ]
      .filter((t): t is string => typeof t === 'string' && Number.isFinite(Date.parse(t)))
      .sort()
      .at(-1) ?? null

  const hasLive = f.liveH2h.home != null || f.liveH2h.draw != null || f.liveH2h.away != null
  const h2hLive: Record<'home' | 'draw' | 'away', number | null> = {
    home: f.liveH2h.home,
    draw: f.liveH2h.draw,
    away: f.liveH2h.away,
  }

  return (
    <>
      {/* feed-level metadata strip */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-white/[0.05] bg-black/[0.12] px-5 py-2.5 text-[12px] text-[color:var(--muted)]">
        {/* Who the LIVE prices come from, replacing the old "Primary" chip.
            That chip read closing_bookmaker, a column since dropped from
            live_fixtures, so it had been showing a permanent "—".

            The feed does not currently name the live source either: there is no
            column for it, and the live price matches a book's pregame main
            price on only 45 of 997 fixtures — noise, not attribution. So say
            plainly that it is unattributed rather than implying a book. Add a
            `live_bookmaker` column and this names it with no further change. */}
        <span className="flex items-center gap-2">
          Live odds
          {hasLive ? (
            <span
              className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                f.liveBookmaker
                  ? 'border-[color:var(--line-soft)] bg-black/[0.3] text-gray-100'
                  : 'border-[color:var(--line-soft)]/60 bg-black/[0.2] text-[color:var(--muted-2)]'
              }`}
              title={
                f.liveBookmaker
                  ? undefined
                  : 'live_fixtures carries no column naming the live price source'
              }
            >
              {f.liveBookmaker ? titleCaseBook(f.liveBookmaker) : 'source not published'}
            </span>
          ) : (
            <span className="rounded border border-[color:var(--line-soft)]/60 bg-black/[0.2] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--muted-2)]">
              none
            </span>
          )}
        </span>
        <span>
          Updated{' '}
          <span className="ml-1 text-gray-200 tabular-nums">{fmtDateTime(lastPriced)}</span>
          {lastPriced && (
            <span className="ml-1.5 text-[color:var(--muted-2)]">({agoLabel(lastPriced, now)})</span>
          )}
        </span>
        {(f.openAt || f.closeAt) && (
          <span className="flex items-center gap-4">
            {f.openAt && (
              <span>
                Opened <span className="ml-1 text-gray-200 tabular-nums">{fmtDateTime(f.openAt)}</span>
              </span>
            )}
            {f.closeAt && (
              <span>
                Closed <span className="ml-1 text-gray-200 tabular-nums">{fmtDateTime(f.closeAt)}</span>
              </span>
            )}
          </span>
        )}
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
            outcomes={[
              { label: f.homeName, key: 'home' },
              ...(hasDraw ? [{ label: 'Draw', key: 'draw' }] : []),
              { label: f.awayName, key: 'away' },
            ]}
            getPrice={(book, k) => h2hMap.get(book)?.mainPrices[k as keyof SidePrices] ?? null}
            getLive={(k) => h2hLive[k as 'home' | 'draw' | 'away'] ?? null}
            getLine={() => null}
            odds={h2h}
            flucs={flucsH2h}
          />
        )}

        {/* Spread */}
        {(spreadBooks.length > 0 || f.liveSpread.home != null || f.liveSpread.away != null) && (
          <MarketCard
            title="Spread"
            kind="spread"
            books={spreadBooks}
            outcomes={[
              { label: f.homeName, key: 'home' },
              { label: f.awayName, key: 'away' },
            ]}
            getPrice={(book, k) => spreadMap.get(book)?.mainPrices[k as keyof SidePrices] ?? null}
            getLive={(k) => (k === 'home' ? f.liveSpread.home : f.liveSpread.away)}
            liveLine={f.liveSpread.line}
            getLine={(book) => spreadMap.get(book)?.mainLine ?? null}
            // The line is the HOME handicap, so the away side is its negation.
            lineSuffix={(k, line) => (line == null ? undefined : fmtLine(k === 'away' ? negate(line) : line))}
            odds={spread}
            flucs={flucsSpread}
          />
        )}

        {/* Total */}
        {(totalBooks.length > 0 || f.liveTotal.over != null || f.liveTotal.under != null) && (
          <MarketCard
            title="Total"
            kind="total"
            books={totalBooks}
            outcomes={[
              { label: 'Over', key: 'over' },
              { label: 'Under', key: 'under' },
            ]}
            getPrice={(book, k) => totalMap.get(book)?.mainPrices[k as keyof SidePrices] ?? null}
            getLive={(k) => (k === 'over' ? f.liveTotal.over : f.liveTotal.under)}
            liveLine={f.liveTotal.line}
            getLine={(book) => totalMap.get(book)?.mainLine ?? null}
            lineSuffix={(k, line) => (line == null ? undefined : `${k === 'over' ? 'O' : 'U'} ${line}`)}
            odds={total}
            flucs={flucsTotal}
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

/**
 * A book's column mark: its logo where we have one, its name where we don't.
 *
 * The name still renders alongside the logo rather than being replaced by it —
 * a 16px favicon is recognisable for bet365 or Pinnacle and completely opaque
 * for Ozoon or Four Winds, and the column has room.
 */
/**
 * The best price, marked with the book that is offering it.
 *
 * The mark is the book's logo where we have one, falling back to a three-letter
 * abbreviation — which is all this used to show, and which cannot separate
 * "Bet365" from "Betano", "Betway", "Betsafe" or "Betsson" at three characters.
 */
/**
 * The vig-stripped consensus price for a selection.
 *
 * This is `odds_sp.fair_blend` — a blend across books with each book's own
 * margin removed — so it is the closest thing on the page to a true price, and
 * what a quoted price should be compared against. It is computed at settlement,
 * so it is absent on fixtures that have not run yet.
 */
function FairCell({ value }: { value: number | null }) {
  return (
    <td className="px-2 py-2 text-right">
      {value != null ? (
        <span title={`${impliedPct(value)} implied · vig-stripped`} className="text-sky-300/90">
          {value.toFixed(2)}
        </span>
      ) : (
        <span className="text-gray-700">–</span>
      )}
    </td>
  )
}

function BestPrice({ price, book }: { price: number; book: string | null }) {
  const logo = bookLogo(book)
  return (
    <span
      title={`${americanOdds(price)} · ${impliedPct(price)} implied · ${book ?? ''}`}
      className="inline-flex items-center gap-1.5 rounded bg-[color:var(--total)]/15 px-1.5 py-0.5 font-semibold text-[color:var(--total)]"
    >
      {price.toFixed(2)}
      {logo ? (
        <img src={logo} alt={book ?? ''} loading="lazy" className="h-3.5 w-3.5 rounded-[2px] object-contain" />
      ) : (
        <span className="text-[10px] opacity-70">{titleCaseBook(book ?? '').slice(0, 3)}</span>
      )}
    </span>
  )
}

function BookBadge({ book }: { book: string }) {
  const t = bookTint(book)
  const logo = bookLogo(book)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${t.text} ${t.bg} ${t.border}`}
      title={book}
    >
      {logo && (
        <img
          src={logo}
          alt=""
          aria-hidden
          loading="lazy"
          className="h-3 w-3 shrink-0 rounded-[2px] object-contain"
        />
      )}
      {titleCaseBook(book)}
    </span>
  )
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
}

/** One market card (H2H / Spread / Total) — header + outcome rows with the
 *  best-price chip, the per-book grid, and the live consensus column. */
// ---------------------------------------------------------------------------
// Flucs: what a book's price did on the way to the jump.
//
// The capture schedule lives in the feed, not here — currently open / 6h / 30m
// / 10m / close, with a daily snapshot, 3h and 1h intended. So NOTHING below
// hard-codes the stage list: stages are whatever the data carries, ordered by
// the `at` timestamp each snapshot stamps itself with. A new stage shows up as
// a new column on its own.

/** Pretty label for a stage key. Unknown keys (a daily snapshot, say) fall back
 *  to the key itself, so a new capture point is readable before it is known. */
const FLUC_STAGE_LABEL: Record<string, string> = {
  open: 'Open',
  '6h': '6h out',
  '3h': '3h out',
  '1h': '1h out',
  '30m': '30m',
  '10m': '10m',
  close: 'Close',
  current: 'Current',
}

/** The daily stage arrives as "9am 12/08" — day-first — once the flucs have
 *  been split into one entry per captured day. Show it as "9am · 12/08". */
function stageLabel(stage: string): string {
  const known = FLUC_STAGE_LABEL[stage]
  if (known) return known
  const daily = /^(\S+)\s+(\d{2}\/\d{2})$/.exec(stage)
  return daily ? `${daily[1]} · ${daily[2]}` : stage
}

/** Open is always first and close always last regardless of clock: a book
 *  re-listed after a suspension can stamp an `open` later than its own 6h. */
function stageRank(stage: string): number {
  if (stage === 'open') return -2
  if (stage === 'close') return 1
  // `current` is the live price, so it always sits to the right of `close`.
  if (stage === 'current') return 2
  return 0
}

/** Every stage any book recorded for this market, oldest first. */
function stagesPresent(
  byBook: Record<string, Partial<Record<string, FlucSnapshot>>> | undefined,
): string[] {
  if (!byBook) return []
  const firstSeen = new Map<string, number>()
  for (const stages of Object.values(byBook)) {
    for (const [stage, snap] of Object.entries(stages ?? {})) {
      const t = snap?.at ? Date.parse(snap.at) : NaN
      const prev = firstSeen.get(stage)
      if (prev == null || (Number.isFinite(t) && t < prev)) firstSeen.set(stage, Number.isFinite(t) ? t : (prev ?? Infinity))
    }
  }
  return [...firstSeen.keys()].sort((a, b) => {
    const r = stageRank(a) - stageRank(b)
    if (r !== 0) return r
    return (firstSeen.get(a) ?? Infinity) - (firstSeen.get(b) ?? Infinity)
  })
}

/** Stable key for grouping — `null` (no line quoted) is its own group. */
function lineKey(line: number | null): string {
  return line == null ? 'none' : String(line)
}

/** Percentage move from the first recorded price to the last. */
function drift(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || from <= 0) return null
  return ((to - from) / from) * 100
}

/** A book's margin on a market: sum of implied probabilities, less 1. Negative
 *  across BEST prices is an arb — the whole reason to show it per book. */
function overround(prices: Array<number | null>): number | null {
  if (!prices.length || prices.some((p) => p == null || p <= 0)) return null
  return (prices as number[]).reduce((sum, p) => sum + 1 / p, 0) - 1
}

function MarketCard<K extends string>({
  title,
  kind,
  books,
  outcomes,
  getPrice,
  getLive,
  liveLine,
  getLine,
  odds,
  lineSuffix,
  flucs,
  fair,
  suspended,
}: {
  title: string
  kind: 'moneyline' | 'spread' | 'total'
  books: string[]
  outcomes: MarketOutcome<K>[]
  getPrice: (book: string, key: K) => number | null
  getLive: (key: K) => number | null
  /** The line the LIVE market is on. In-play spread/total move their line, so
   *  it often matches no pregame group — see liveOrphan below. */
  liveLine?: number | null
  /** The line this book quotes. Null for a market without one (h2h). */
  getLine: (book: string) => number | null
  /** Normalised odds, so the card can offer the full alternate-lines ladder. */
  odds: BookOdds[]
  /** How an outcome names the line — "+1.5" for a spread, "O 7.5" for a total. */
  lineSuffix?: (key: K, line: number | null) => string | undefined
  /** This market's price history, book → stage → snapshot. */
  flucs?: Record<string, Partial<Record<string, FlucSnapshot>>>
  /** Vig-stripped consensus price, keyed by fairKey(outcome, line). */
  fair?: Record<string, number>
  /** Books currently showing this market as suspended rather than priced. */
  suspended?: string[]
}) {
  const [view, setView] = useState<'prices' | 'movement'>('prices')

  // ONE TABLE PER LINE. Books do not agree on the handicap — Pinnacle quotes a
  // baseball spread at 1 while FanDuel quotes 1.5 on the same game — and laying
  // them side by side in one grid invites reading across two different bets.
  // It also produced a false arb: a "best" 1.93 from the 1 line against a
  // "best" 2.14 from the 1.5 line summed to a negative margin that no one
  // could have taken.
  const groups = (() => {
    const byLine = new Map<string, { line: number | null; books: string[] }>()
    for (const b of books) {
      const line = getLine(b)
      const k = lineKey(line)
      const g = byLine.get(k)
      if (g) g.books.push(b)
      else byLine.set(k, { line, books: [b] })
    }
    // Most-quoted line first — that is the market everyone means.
    return [...byLine.values()].sort(
      (a, z) => z.books.length - a.books.length || (a.line ?? 0) - (z.line ?? 0),
    )
  })()

  const hasLive = outcomes.some((o) => getLive(o.key) != null)
  // A ladder only exists when some book quotes more than its main line.
  const ladderLines = allLines(odds)
  const hasLadder = odds.some((b) => b.lines.length > 1)

  const stages = stagesPresent(flucs)
  const flucBooks = flucs ? Object.keys(flucs).filter((b) => Object.keys(flucs[b] ?? {}).length > 0) : []
  const hasFlucs = stages.length > 1 && flucBooks.length > 0
  const showing = hasFlucs ? view : 'prices'

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
          {groups.length > 1 && (
            <span className="rounded border border-[color:var(--line-soft)] bg-black/[0.2] px-2 py-0.5 text-[11px] font-medium text-gray-300">
              {groups.length} lines
            </span>
          )}
          {!!suspended?.length && (
            <span
              title={`Suspended by ${suspended.join(', ')}`}
              className="rounded border border-amber-400/30 bg-amber-400/[0.08] px-2 py-0.5 text-[11px] font-medium text-amber-300"
            >
              {suspended.length} suspended
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {hasFlucs && (
            <div className="flex items-center gap-0.5 rounded border border-[color:var(--line-soft)] bg-black/[0.25] p-0.5">
              {(['prices', 'movement'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded px-2 py-0.5 text-[10.5px] font-medium capitalize ${
                    showing === v ? 'bg-white/10 text-gray-100' : 'text-[color:var(--muted-2)] hover:text-gray-300'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          <span className="text-[11.5px] text-[color:var(--muted-2)]">
            {showing === 'movement'
              ? `${flucBooks.length} tracked · ${stages.length} stages`
              : `${books.length} books${hasLadder ? ` · ${ladderLines.length} lines` : ''}`}
          </span>
        </div>
      </div>

      {showing === 'movement' ? (
        <MovementTable outcomes={outcomes} stages={stages} books={flucBooks} flucs={flucs ?? {}} />
      ) : kind === 'moneyline' ? (
        groups.map((g) => (
          <PriceTable
            key={lineKey(g.line)}
            kind={kind}
            line={g.line}
            books={g.books}
            outcomes={outcomes}
            getPrice={getPrice}
            getLive={getLive}
            lineSuffix={lineSuffix}
            showLive={hasLive}
            showLineHeader={false}
            fair={fair}
          />
        ))
      ) : (
        // A handicap or total is one market quoted at many lines, so it reads
        // as a single grid of selections — "Marlins -1.5" above "Pirates +1.5",
        // every line stacked — rather than a separate table per line with its
        // own header and margin row.
        <LinesTable
          kind={kind}
          odds={odds}
          outcomes={outcomes}
          books={books}
          live={hasLive ? { line: liveLine ?? null, get: getLive } : null}
          fair={fair}
        />
      )}
    </div>
  )
}

/**
 * A handicap or total as one grid of selections, every line stacked.
 *
 * This is the shape an odds screen uses: a row per selection — "Marlins -1.5"
 * with "Pirates +1.5" beneath it — for each line the books quote, best price
 * badged, and a dash where a book isn't on that line. It replaces a table per
 * line, each with its own header and margin row, which cost a screen of
 * chrome to show three lines and buried the rest behind an expander.
 *
 * Order is deliberate: the LIVE line first while a game is in play (that is
 * the market you are actually watching), then the line the books lead with,
 * then whatever is priced closest to even. Five lines, then the rest on
 * request — a single book can quote 169 of them.
 */
function LinesTable<K extends string>({
  kind,
  odds,
  outcomes,
  books,
  live,
  fair,
}: {
  kind: 'moneyline' | 'spread' | 'total'
  odds: BookOdds[]
  outcomes: MarketOutcome<K>[]
  books: string[]
  fair?: Record<string, number>
  live: { line: number | null; get: (key: K) => number | null } | null
}) {
  const [shown, setShown] = useState(LADDER_PAGE)
  const byBook = useMemo(() => new Map(odds.map((o) => [o.book, o])), [odds])
  // Hoisted: an optional-chained value in a dependency list defeats the
  // compiler's memoization.
  const liveLine = live?.line ?? null

  const ordered = useMemo(() => {
    const all = allLines(odds)
    // The live line may be one no book quoted before the jump; it still leads.
    if (liveLine != null && !all.includes(liveLine)) all.push(liveLine)
    const mainTally = new Map<number, number>()
    for (const o of odds) if (o.mainLine != null) mainTally.set(o.mainLine, (mainTally.get(o.mainLine) ?? 0) + 1)
    const balance = (line: number) => {
      let best = Infinity
      for (const o of odds) {
        const p = pricesAt(o, line)
        const x = p?.over ?? p?.home
        const y = p?.under ?? p?.away
        if (x == null || y == null) continue
        best = Math.min(best, Math.abs(x - y))
      }
      return best
    }
    return all
      .map((line) => ({
        line,
        isLive: liveLine != null && line === liveLine,
        mains: mainTally.get(line) ?? 0,
        balance: balance(line),
      }))
      .sort(
        (a, b) =>
          Number(b.isLive) - Number(a.isLive) ||
          b.mains - a.mains ||
          a.balance - b.balance ||
          Math.abs(a.line) - Math.abs(b.line),
      )
  }, [odds, liveLine])

  const visible = ordered.slice(0, shown)
  const showLive = !!live
  // Only widen the table when this market actually has fair prices. `odds_sp`
  // is computed at settlement, so an upcoming fixture usually has none.
  const hasFair = !!fair && Object.keys(fair).length > 0
  // A handicap names the away side by the negated line; a total names both
  // sides by the same number.
  const sideLine = (key: K, line: number) => (kind === 'spread' && key !== outcomes[0]?.key ? -line : line)
  const label = (key: K, line: number) =>
    kind === 'spread' ? fmtLine(sideLine(key, line)) : `${key === 'over' ? 'O' : 'U'} ${line}`

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-[11px] text-[color:var(--muted)]">
            <th className="sticky left-0 z-10 bg-[color:var(--panel)] py-2.5 pl-4 pr-3 text-left font-medium">
              Selection
            </th>
            {showLive && (
              <th className="px-2 py-2.5 text-right font-medium text-[color:var(--live)]">Live</th>
            )}
            <th className="px-2 py-2.5 text-right font-medium text-[color:var(--total)]">Best</th>
            {hasFair && (
              <th
                title="Vig-stripped consensus price across books (odds_sp.fair_blend)"
                className="px-2 py-2.5 text-right font-medium text-sky-300/80"
              >
                Fair
              </th>
            )}
            {books.map((b) => {
              return (
                <th key={b} className="px-2 py-2.5 text-right font-normal">
                  <BookBadge book={b} />
                </th>
              )
            })}
            <th className="px-3 py-2.5 text-right font-medium">Margin</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {visible.map(({ line, isLive }, li) => {
            const priceOf = (book: string, key: K) =>
              pricesAt(byBook.get(book) ?? { book, lines: [], mainLine: null, mainPrices: {} }, line)?.[
                key as keyof SidePrices
              ] ?? null
            const best = outcomes.map((o) => {
              let price = 0
              let book: string | null = null
              for (const b of books) {
                const v = priceOf(b, o.key)
                if (v != null && v > price) {
                  price = v
                  book = b
                }
              }
              return { price, book }
            })
            const margin = overround(best.map((x) => (x.price > 0 ? x.price : null)))
            return (
              <Fragment key={line}>
                {outcomes.map((o, oi) => {
                  const bestThis = best[oi]
                  const liveV = isLive ? live?.get(o.key) ?? null : null
                  return (
                    <tr
                      key={`${line}-${o.key as string}`}
                      className={`${oi === 0 ? 'border-t border-white/[0.06]' : ''} ${
                        isLive ? 'bg-[color:var(--live)]/[0.04]' : li === 0 ? '' : 'hover:bg-white/[0.02]'
                      }`}
                    >
                      <td className="sticky left-0 z-10 bg-[color:var(--panel)] py-2 pl-4 pr-3">
                        <div className="flex items-center gap-2">
                          {isLive && oi === 0 && (
                            <span className="rounded bg-[color:var(--live)]/15 px-1 py-0.5 text-[9.5px] font-bold text-[color:var(--live)]">
                              LIVE
                            </span>
                          )}
                          <span className="text-gray-100">{o.label}</span>
                          <span className="rounded bg-black/[0.25] px-1.5 py-0.5 text-[10.5px] text-[color:var(--muted)]">
                            {label(o.key, line)}
                          </span>
                        </div>
                      </td>
                      {showLive && (
                        <td className="px-2 py-2 text-right">
                          {liveV != null ? (
                            <span className="font-semibold text-[color:var(--live)]">{liveV.toFixed(2)}</span>
                          ) : (
                            <span className="text-gray-700">–</span>
                          )}
                        </td>
                      )}
                      <td className="px-2 py-2 text-right">
                        {bestThis.price > 0 ? (
                          <BestPrice price={bestThis.price} book={bestThis.book} />
                        ) : (
                          <span className="text-gray-700">–</span>
                        )}
                      </td>
                      {/* Keyed on the group's home-signed line, which is how
                          both `odds.pair_key` and the fair map identify a
                          market — NOT the selection's own line, where a
                          spread's two sides would look up different markets. */}
                      {hasFair && <FairCell value={fair?.[fairKey(o.key, line)] ?? null} />}
                      {books.map((b) => {
                        const v = priceOf(b, o.key)
                        const isBest = bestThis.price > 0 && v === bestThis.price
                        return (
                          <td key={b} className="px-2 py-2 text-right">
                            {v == null ? (
                              <span className="text-gray-700">–</span>
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
                      {oi === 0 ? (
                        <td
                          rowSpan={outcomes.length}
                          className="px-3 py-2 text-right align-middle text-[11px] tabular-nums"
                        >
                          {margin == null ? (
                            <span className="text-gray-700">–</span>
                          ) : (
                            <span
                              className={
                                margin < 0
                                  ? 'rounded bg-[color:var(--total)]/15 px-1.5 py-0.5 font-bold text-[color:var(--total)]'
                                  : 'text-[color:var(--muted)]'
                              }
                              title={margin < 0 ? 'Negative across best prices on this line — arb' : undefined}
                            >
                              {(margin * 100).toFixed(1)}%
                            </span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {shown < ordered.length && (
        <button
          onClick={() => setShown((n) => n + LADDER_PAGE * 4)}
          className="w-full border-t border-white/[0.05] bg-black/[0.2] py-2 text-[11px] font-medium text-[color:var(--muted)] hover:text-gray-200"
        >
          Show more · {ordered.length - shown} further {ordered.length - shown === 1 ? 'line' : 'lines'}
        </button>
      )}
    </div>
  )
}

function PriceTable<K extends string>({
  kind,
  line,
  books,
  outcomes,
  getPrice,
  getLive,
  lineSuffix,
  showLive,
  showLineHeader,
  fair,
}: {
  kind: 'moneyline' | 'spread' | 'total'
  line: number | null
  books: string[]
  outcomes: MarketOutcome<K>[]
  getPrice: (book: string, key: K) => number | null
  getLive: (key: K) => number | null
  lineSuffix?: (key: K, line: number | null) => string | undefined
  showLive: boolean
  showLineHeader: boolean
  fair?: Record<string, number>
}) {
  const hasFair = !!fair && Object.keys(fair).length > 0
  // Best price per outcome, WITHIN this line — comparing across lines would be
  // comparing different bets.
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
  const bookMargin = new Map<string, number | null>()
  for (const b of books) bookMargin.set(b, overround(outcomes.map((o) => getPrice(b, o.key))))
  const bestMargin = overround(best.map((x) => (x.price > 0 ? x.price : null)))

  return (
    <>
      {showLineHeader && (
        <div className="flex items-center gap-2 border-t border-white/[0.05] bg-black/[0.15] px-4 py-1.5">
          <span className="rounded border border-[color:var(--line-soft)] bg-black/[0.25] px-2 py-0.5 text-[10.5px] font-medium text-gray-300">
            {line == null ? 'No line' : kind === 'spread' ? `Line ${fmtLine(line)}` : `Line ${line}`}
          </span>
          <span className="text-[10.5px] text-[color:var(--muted-2)]">
            {books.length} {books.length === 1 ? 'book' : 'books'}
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-[11px] text-[color:var(--muted)]">
              <th className="sticky left-0 z-10 bg-[color:var(--panel)] py-2.5 pl-4 pr-3 text-left font-medium">
                Outcome
              </th>
              {showLive && (
                <th className="px-2 py-2.5 text-right font-medium text-[color:var(--live)]">Live</th>
              )}
              <th className="px-2 py-2.5 text-right font-medium text-[color:var(--total)]">Best</th>
              {hasFair && (
                <th
                  title="Vig-stripped consensus price across books (odds_sp.fair_blend)"
                  className="px-2 py-2.5 text-right font-medium text-sky-300/80"
                >
                  Fair
                </th>
              )}
              {books.map((b) => {
                return (
                  <th key={b} className="px-2 py-2.5 text-right font-normal">
                    <BookBadge book={b} />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {outcomes.map((o, i) => {
              const liveV = getLive(o.key)
              const bestThis = best[i]
              const suffix = lineSuffix?.(o.key, line)
              return (
                <tr key={o.key as string} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="sticky left-0 z-10 bg-[color:var(--panel)] py-2.5 pl-4 pr-3">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-100">{o.label}</span>
                      {suffix && (
                        <span className="rounded bg-black/[0.2] px-1.5 py-0.5 text-[10.5px] text-[color:var(--muted)]">
                          {suffix}
                        </span>
                      )}
                    </div>
                  </td>
                  {showLive && (
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
                      <BestPrice price={bestThis.price} book={bestThis.book} />
                    ) : (
                      <span className="text-[color:var(--muted-2)]/60">—</span>
                    )}
                  </td>
                  {hasFair && <FairCell value={fair?.[fairKey(o.key, line)] ?? null} />}
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
          {/* Margin per book, and across the best prices on THIS line — where a
              negative number is a real arb rather than two different bets. */}
          <tfoot>
            <tr className="border-t border-white/[0.08] text-[11px]">
              <th className="sticky left-0 z-10 bg-[color:var(--panel)] py-2 pl-4 pr-3 text-left font-medium text-[color:var(--muted)]">
                Margin
              </th>
              {showLive && <td />}
              <td className="px-2 py-2 text-right tabular-nums">
                {bestMargin == null ? (
                  <span className="text-[color:var(--muted-2)]/60">—</span>
                ) : (
                  <span
                    className={
                      bestMargin < 0
                        ? 'rounded bg-[color:var(--total)]/15 px-1.5 py-0.5 font-bold text-[color:var(--total)]'
                        : 'text-[color:var(--muted)]'
                    }
                    title={bestMargin < 0 ? 'Negative across best prices on this line — arb' : undefined}
                  >
                    {(bestMargin * 100).toFixed(1)}%
                  </span>
                )}
              </td>
              {books.map((b) => {
                const m = bookMargin.get(b) ?? null
                return (
                  <td key={b} className="px-2 py-2 text-right tabular-nums text-[color:var(--muted)]">
                    {m == null ? <span className="text-gray-700">—</span> : `${(m * 100).toFixed(1)}%`}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

function MovementTable<K extends string>({
  outcomes,
  stages,
  books,
  flucs,
}: {
  outcomes: MarketOutcome<K>[]
  stages: string[]
  books: string[]
  flucs: Record<string, Partial<Record<string, FlucSnapshot>>>
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-[11px] text-[color:var(--muted)]">
            <th className="sticky left-0 z-10 bg-[color:var(--panel)] py-2.5 pl-4 pr-3 text-left font-medium">
              Book
            </th>
            <th className="px-2 py-2.5 text-left font-medium">Outcome</th>
            {stages.map((st) => (
              <th key={st} className="px-2 py-2.5 text-right font-medium">
                {stageLabel(st)}
              </th>
            ))}
            <th className="px-3 py-2.5 text-right font-medium">Drift</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {books.flatMap((b) => {
            const byStage = flucs[b] ?? {}
            return outcomes.map((o, oi) => {
              const prices = stages.map((st) => {
                const v = (byStage[st] as Record<string, number | null | undefined> | undefined)?.[o.key]
                return typeof v === 'number' ? v : null
              })
              // Drift runs first-recorded → last-recorded, which is not always
              // open → close: a book that only appeared at 30m still has a
              // meaningful move from there.
              const firstIdx = prices.findIndex((v) => v != null)
              const lastIdx = prices.length - 1 - [...prices].reverse().findIndex((v) => v != null)
              const d = firstIdx < 0 ? null : drift(prices[firstIdx], prices[lastIdx])
              return (
                <tr
                  key={`${b}-${o.key as string}`}
                  className={`hover:bg-white/[0.02] ${oi === 0 ? 'border-t border-white/[0.06]' : ''}`}
                >
                  <td className="sticky left-0 z-10 bg-[color:var(--panel)] py-2 pl-4 pr-3">
                    {oi === 0 && <BookBadge book={b} />}
                  </td>
                  <td className="px-2 py-2 text-gray-100">{o.label}</td>
                  {prices.map((v, i) => {
                    const prev = prices.slice(0, i).reverse().find((x) => x != null) ?? null
                    const moved = v != null && prev != null && v !== prev
                    return (
                      <td key={stages[i]} className="px-2 py-2 text-right">
                        {v == null ? (
                          <span className="text-gray-700">—</span>
                        ) : (
                          <span
                            title={byStage[stages[i]]?.at ? fmtDateTime(byStage[stages[i]]?.at ?? null) : undefined}
                            className={
                              moved
                                ? v > (prev as number)
                                  ? 'text-[color:var(--total)]'
                                  : 'text-[color:var(--live)]'
                                : 'text-gray-100'
                            }
                          >
                            {v.toFixed(2)}
                          </span>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 text-right">
                    {d == null ? (
                      <span className="text-gray-700">—</span>
                    ) : Math.abs(d) < 0.05 ? (
                      <span className="text-[color:var(--muted-2)]">flat</span>
                    ) : (
                      <span className={d > 0 ? 'text-[color:var(--total)]' : 'text-[color:var(--live)]'}>
                        {d > 0 ? '+' : ''}
                        {d.toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              )
            })
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Rungs of the alternate-lines ladder shown before "Load more" — enough to see
 *  where the market is without the wall of long shots behind it. */
const LADDER_PAGE = 5

/** How often an open fixture re-reads its bets from each book. */
const BETS_POLL_MS = 60_000
/** Same read, but the fixture is sitting in a tab you are not looking at. */
const BETS_POLL_HIDDEN_MS = 5 * 60_000

/**
 * Cheap change signature for a bet list. Polling replaces the array every
 * minute, and handing React a new array of identical rows re-renders the whole
 * table for nothing — on a busy fixture that is 40+ rows, each with a price
 * chart and an expandable leg breakdown. Only the fields that actually move
 * between polls are included.
 */
function betsSig(rows: Array<{ id: string; bet_status?: string | null; pl?: number | null; bet_result?: number | null }>): string {
  return rows.map((r) => `${r.id}:${r.bet_status ?? ''}:${r.pl ?? r.bet_result ?? ''}`).join('|')
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
    // In-flight guard kept local to this effect instance — a ref shared across
    // instances deadlocks under StrictMode's mount/cleanup/mount.
    let running = false
    // Only the first load for this fixture shows the spinner. A poll must never
    // blank the table it is refreshing, nor replace rows with an error panel.
    let first = true
    const load = async () => {
      if (running) return
      running = true
      if (first) {
        setLoading(true)
        setError(null)
      }
      try {
        // `swiftEventId` arrives a beat after the fixture (the mapping loads
        // async), so this refetches once it lands — picking up any bet the slug
        // join missed.
        const rows = await fetchSwiftBets({ date, home: f.homeName, away: f.awayName, swiftEventId, swiftActualStart, scheduledStart })
        if (!alive) return
        setBets((prev) => (prev && betsSig(prev) === betsSig(rows) ? prev : rows))
        setError(null)
      } catch (e) {
        // A failed poll keeps whatever is already on screen.
        if (alive && first) setError(String((e as { message?: unknown })?.message ?? e))
      } finally {
        if (alive && first) setLoading(false)
        first = false
        running = false
      }
    }
    load()
    const stop = pollWithVisibility(load, BETS_POLL_MS, BETS_POLL_HIDDEN_MS)
    return () => {
      alive = false
      stop()
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
    let running = false
    let first = true
    const load = async () => {
      if (running) return
      running = true
      if (first) {
        setLoading(true)
        setError(null)
      }
      try {
        const rows = await fetchMybetBets({ eventId, suspendAt, liveAt, home, away })
        if (!alive) return
        setBets((prev) => (prev && betsSig(prev) === betsSig(rows) ? prev : rows))
        setError(null)
      } catch (e) {
        if (alive && first) setError(String((e as { message?: unknown })?.message ?? e))
      } finally {
        if (alive && first) setLoading(false)
        first = false
        running = false
      }
    }
    load()
    const stop = pollWithVisibility(load, BETS_POLL_MS, BETS_POLL_HIDDEN_MS)
    return () => {
      alive = false
      stop()
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
  if (loading && !bets) return <BetsSkeleton cols={11} />
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
  return { label, tone: RES_TONE[label] }
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

/** One mybet bet row — mirrors SwiftBet's BetRow columns and styling. SGMs and
 *  cross-game multis both expand to a per-leg breakdown; singles stay one row. */
function MybetRow({ b, scheduledStart, actualStart, home, away }: { b: MybetBetRow; scheduledStart: string | null; actualStart: string | null; home: string; away: string }) {
  const [open, setOpen] = useState(false)
  const late = b.placed_after_live
  const isSgm = b.sgm && b.legs.length > 1
  const isMulti = b.is_multi && !isSgm
  const expandable = isSgm
  // A cross-game multi expands from its TYPE badge rather than over the
  // Market/Outcome cells: those still say what this game's leg was, which is
  // the thing you came to the fixture page to read.
  const multiExpandable = isMulti && b.legs.length > 1
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
        {/* mybet's bet id is the ticket number it prints on the slip. */}
        <BetIdCell id={b.transaction_id != null ? String(b.transaction_id) : b.id ?? null} />
        <td className="px-3 py-2 align-top text-gray-200">
          {typeBadge ? (
            multiExpandable ? (
              <button
                onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-200 hover:bg-white/10 hover:text-white"
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {typeBadge}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-200">{typeBadge}</span>
            )
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
      {(expandable || multiExpandable) && open && b.legs.map((lg, i) => {
        // Mark the leg that is THIS game, by identity with the leg the
        // collapsed row already resolved. Re-deriving it per leg with a
        // name test gets it wrong: mentionsTeam matches any word of 4+
        // chars, so in a multi holding both "Botev Vratsa vs Slavia Sofia"
        // and "Botev Plovdiv vs Spartak" the Plovdiv leg also answers to
        // "botev". relevantLeg prefers the leg naming BOTH teams, so it
        // picks the right one.
        const thisGame = leg != null && lg === leg
        return (
          <tr
            key={i}
            className={`border-t border-[color:var(--line-soft)]/40 ${thisGame ? 'bg-[color:var(--swift)]/[0.06]' : 'bg-black/[0.18]'}`}
          >
            {/* spacers: Placed, vs Start, User, Bet ID */}
            <td />
            <td />
            <td />
            <td />
            <td className="px-3 py-1.5 align-top text-[10px] text-[color:var(--muted-2)]">
              leg {i + 1}
              {thisGame && <span className="ml-1 font-semibold text-[color:var(--muted)]">· this game</span>}
            </td>
            <td className="px-3 py-1.5 align-top text-[11.5px] text-gray-200">{lg.event ?? '—'}</td>
            <td className="px-3 py-1.5 align-top text-[11.5px] text-gray-300">{lg.outcome ?? '—'}</td>
            <td />
            <td />
            <td className="px-3 py-1.5 text-right align-top tabular-nums text-[11.5px] text-gray-300">
              {lg.odds != null ? lg.odds.toFixed(2) : '—'}
            </td>
            <td />
          </tr>
        )
      })}
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

/** Users / Bets / Stake / P/L summary shown directly under the scoreboard. P/L
 *  is computed from the current score (so it ticks while live) and flips its
 *  badge LIVE → FINAL when the game ends. */
/**
 * The book's own id for a bet: first 5 characters, with the FULL value behind
 * the copy button. Five is enough to eyeball one row against another or against
 * a support ticket; the whole id is what you actually need to paste into a
 * query, and it is too long to sit in a table this wide.
 */
function BetIdCell({ id }: { id: string | null }) {
  if (!id) return <td className="px-3 py-2 align-top text-[color:var(--muted-2)]">—</td>
  const short = id.slice(0, 5)
  return (
    <td className="px-3 py-2 align-top">
      <div className="flex items-center gap-0.5">
        <span
          className="font-mono text-[10.5px] text-[color:var(--muted-2)]"
          title={id}
        >
          {short}
          {id.length > short.length ? '…' : ''}
        </span>
        <CopyButton value={id} />
      </div>
    </td>
  )
}

const BET_COLS = ['Placed', 'vs Start', 'User', 'Bet ID', 'Type', 'Market', 'Outcome', 'Result', 'Stake', 'Odds', 'P/L'] as const

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
  if (loading && !bets) return <BetsSkeleton cols={11} />
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

/**
 * Decided outcome of a multi, from its per-leg result labels: dead the moment
 * any leg loses, won when every leg won (pushes don't kill it).
 *
 * Returns null while it's still running. There used to be an 'Alive' badge for
 * that case, but it sat directly above the PENDING chip saying the same thing
 * in the same colour — and PENDING is the book's own bet_status rather than
 * something derived from leg results, so it's the one to keep. WON/LOST stay
 * because PENDING can't tell you which way a settled bet went.
 */
type MultiStatus = 'Won' | 'Lost'
function statusFromLabels(labels: Array<'Won' | 'Lost' | 'Open' | 'Push'>): MultiStatus | null {
  if (labels.length === 0) return null
  if (labels.some((l) => l === 'Lost')) return 'Lost'
  if (labels.every((l) => l === 'Won' || l === 'Push')) return 'Won'
  return null
}

const MULTI_STATUS_BADGE: Record<MultiStatus, string> = {
  Won: 'bg-[color:var(--total)]/10 text-[color:var(--total)]',
  Lost: 'bg-[color:var(--live)]/10 text-[color:var(--live)]',
}

type ResLabel = 'Won' | 'Lost' | 'Open' | 'Push'
interface ResolvedResult {
  label: ResLabel
  tone: string
  // Set when the book HAS settled this leg but the final score implies the
  // opposite — i.e. a possible mis-settlement to review. Holds what the score
  // says it should be. Reporting only: `label` is always the book's.
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
 * Resolve a selection's result.
 *
 * A result SHOWN to the user is always the book's. If the book hasn't resulted
 * a leg, it reads Open — we never label it from the score. Deriving used to be
 * the fallback, which is how a bet could show LOST beside the book's own
 * PENDING: the book plainly had not lost it, we had just read the scoreline
 * ourselves.
 *
 * `project` opts back into score-derivation, and exists for exactly one
 * caller: the live P/L projection, which needs a provisional outcome so in-play
 * exposure ticks. That number is labelled LIVE and is explicitly an estimate —
 * it never becomes a result label.
 *
 * The score is still used one other way, and only to REPORT: when the book HAS
 * settled a leg, `expected` flags a Won<->Lost contradiction against the final
 * score, i.e. a possible mis-settlement. That annotates the book's result, it
 * doesn't replace it.
 */
function resolveResult(
  officialRaw: string | null,
  sel: { market: string | null; mt: string | null; outcome: string | null },
  ctx: ScoreCtx,
  opts: { project?: boolean } = {},
): ResolvedResult {
  const off = normLabel(officialRaw)
  if (off !== 'Open') {
    // Cross-check against the FINAL score (never the live one — an in-play
    // scoreline contradicts plenty of correct settlements). A Push vs Won/Lost
    // is too noisy to flag.
    const check = settleFromScore(sel, ctx)
    const expected = (check === 'Won' || check === 'Lost') && check !== off ? check : null
    return { label: off, tone: RES_TONE[off], expected }
  }
  if (!opts.project) return { label: 'Open', tone: RES_TONE.Open }
  const d = settleFromScore(sel, ctx, { allowLive: true })
  if (d) return { label: d, tone: RES_TONE[d] }
  return { label: 'Open', tone: RES_TONE.Open }
}

/** Renders the book's result, plus a ⚠ + tooltip when that settled result
 *  contradicts the final score (a possible mis-settlement). There is no
 *  "inferred" state to render — an unresulted leg simply reads Open. */
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
  return <span className={r.tone}>{r.label}</span>
}

/** Does any leg/selection of this bet look mis-settled vs the final score? */
function betMismatch(b: SwiftBetRow, ctx: ScoreCtx): boolean {
  const sels = b.matched_leg?.selections ?? []
  if (sels.length) return sels.some((s) => !!resolveResult(s.status, s, ctx).expected)
  const ml = b.matched_leg
  return ml ? !!resolveResult(ml.status, ml, ctx).expected : false
}

/** Overall result of a bet w.r.t. THIS game: the granular selection status,
 *  else leg_breakdown; an SGM combines its selections (any lost → lost, all
 *  won → won). `project` is only ever set by the live P/L projection — see
 *  resolveResult. */
function resolveBet(b: SwiftBetRow, ctx: ScoreCtx, project = false): ResolvedResult {
  const isSgm = (b.type ?? '').toUpperCase() === 'SGM'
  const sels = b.matched_leg?.selections ?? []
  const leg =
    b.leg_breakdown && b.matched_leg_index >= 0 ? b.leg_breakdown[b.matched_leg_index] ?? null : null
  if (isSgm && sels.length) {
    const official = normLabel(leg?.result ?? null)
    if (official !== 'Open') return { label: official, tone: RES_TONE[official] }
    const sr = sels.map((s) => resolveResult(s.status, s, ctx, { project }))
    if (sr.some((r) => r.label === 'Lost')) return { label: 'Lost', tone: RES_TONE.Lost }
    if (sr.every((r) => r.label === 'Won' || r.label === 'Push'))
      return { label: 'Won', tone: RES_TONE.Won }
    return { label: 'Open', tone: RES_TONE.Open }
  }
  const selStatus = b.matched_leg?.status ?? null
  const best = normLabel(selStatus) !== 'Open' ? selStatus : leg?.result ?? null
  return resolveResult(best, b.matched_leg ?? { market: null, mt: null, outcome: null }, ctx, { project })
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
  // The ONE place score-derivation survives: a provisional outcome so the
  // liability ticks while the game is live. Shown as the LIVE P/L, never as a
  // bet's result label.
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
  // A cross-game multi expands from its TYPE badge, keeping Market/Outcome on
  // this game's leg — the reason you're on this fixture's page. Without this a
  // 4-leg multi showed one leg's price and a combined price, and said nothing
  // about the three other legs that decide whether it pays.
  const allLegs = b.all_legs ?? []
  const multiExpandable = isMulti && allLegs.length > 1
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
  const legStatusTone = (st: string | null) => {
    const t = (st ?? '').toLowerCase()
    if (t.includes('loss') || t.includes('lost')) return 'text-[color:var(--live)]'
    if (t.includes('win')) return 'text-[color:var(--total)]'
    return 'text-[color:var(--muted-2)]'
  }
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
  const legLabels = (b.leg_breakdown ?? []).map((l, i) =>
    i === b.matched_leg_index ? mainRes.label : normLabel(l.result),
  )
  const mStatus: MultiStatus | null = isSgm
    ? mainRes.label === 'Won'
      ? 'Won'
      : mainRes.label === 'Lost'
        ? 'Lost'
        : null
    : isMulti
      ? statusFromLabels(legLabels)
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
        <BetIdCell id={b.bet_id ?? b.id ?? null} />
        <td className="px-3 py-2 align-top text-gray-200">
          {typeBadge ? (
            multiExpandable ? (
              <button
                onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-200 hover:bg-white/10 hover:text-white"
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {typeBadge}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-200">
                {typeBadge}
              </span>
            )
          ) : (
            <span className="text-[11.5px]">{(b.type ?? 'SINGLE').toUpperCase()}</span>
          )}
          {mStatus && (
            <div className="mt-1">
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${MULTI_STATUS_BADGE[mStatus]}`}
              >
                {mStatus === 'Won' ? 'WON' : 'LOST'}
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
              {/* spacers: Placed, vs Start, User, Bet ID */}
              <td />
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
      {/* Expanded multi legs: every leg with its own game, pick and price. The
          leg that is THIS fixture is tinted and labelled. */}
      {multiExpandable &&
        open &&
        allLegs.map((lg, i) => (
          <tr
            key={i}
            className={`border-t border-[color:var(--line-soft)]/40 ${
              lg.is_this_game ? 'bg-[color:var(--swift)]/[0.06]' : 'bg-black/[0.18]'
            }`}
          >
            {/* spacers: Placed, vs Start, User, Bet ID */}
            <td />
            <td />
            <td />
            <td />
            <td className="px-3 py-1.5 align-top text-[10px] text-[color:var(--muted-2)]">
              leg {i + 1}
              {lg.is_this_game && (
                <span className="ml-1 font-semibold text-[color:var(--muted)]">· this game</span>
              )}
            </td>
            <td className="px-3 py-1.5 align-top text-[11.5px] text-gray-200">
              {lg.event_name ?? '—'}
              {lg.competition && (
                <div className="text-[10px] text-[color:var(--muted-2)]">{lg.competition}</div>
              )}
            </td>
            <td className="max-w-[320px] px-3 py-1.5 align-top text-[11.5px] text-gray-300">
              {lg.outcome ?? '—'}
              {lg.market && (
                <div className="text-[10px] text-[color:var(--muted-2)]">{lg.market}</div>
              )}
            </td>
            <td className={`px-3 py-1.5 align-top text-[10.5px] font-medium ${legStatusTone(lg.status)}`}>
              {lg.status ? prettyLegStatus(lg.status) : '—'}
            </td>
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

/** SwiftBet writes leg statuses as "ResultedLoss" / "Unresulted". Split the
 *  camel case so the column reads as words. */
function prettyLegStatus(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^Resulted /, '')
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

function negate(v: number | null): number | null {
  return v == null ? null : -v
}

function leads(a: number | null, b: number | null): boolean {
  return a != null && b != null && a > b
}
