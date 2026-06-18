import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { useTerminal } from '../components/Layout'
import { DetailSkeleton, PanelSkeleton } from '../components/Skeleton'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { fetchFixtureById } from '../lib/dataSource'
import { fetchSwiftEvent } from '../lib/swiftStatus'
import { fetchSwiftBets, type SwiftBetRow } from '../lib/swiftBets'
import { periodAbbrev, periodNoun, periodState, sportEmoji } from '../lib/sports'
import { Avatar } from '../components/Avatar'
import type { Fixture } from '../lib/types'
import { agoLabel, fmtDateTime, fmtLine, melbDateTime, startsInLabel } from '../lib/format'
import { fetchEventMappings, fetchCompetitionMappings, type EventMapping, type CompetitionMapping } from '../lib/mappingData'
import { getSwiftCatalog, type SwiftCompetition, type SwiftEvent } from '../lib/swiftCatalog'

export default function FixtureDetailPage() {
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
    Promise.all([fetchEventMappings(), fetchCompetitionMappings(), getSwiftCatalog()])
      .then(async ([events, comps, cat]) => {
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
        setMappingInfo({ loading: false, evMap, swiftEvent, compMaps, swiftComps })
      })
      .catch(() => alive && setMappingInfo((prev) => ({ ...prev, loading: false })))
    return () => {
      alive = false
    }
  }, [id, sport, league, seasonType])

  useDocumentTitle(f ? `${f.homeName} v ${f.awayName}` : null)

  if (!f && loading) return <DetailSkeleton />

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <Link
        to="/"
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--muted)] transition-colors hover:text-gray-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to terminal
      </Link>

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

  return (
    <div
      className={`rounded-lg border bg-[color:var(--panel)] ${
        isLive ? 'border-transparent glow-live' : 'border-[color:var(--line-soft)]'
      }`}
    >
      {/* HERO — everything you need to read the event at a glance. */}
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="cursor-help text-base leading-none" title={f.sport} aria-label={f.sport}>
            {sportEmoji(f.sport)}
          </span>
          <span className="text-[14px] font-semibold text-gray-100">{f.league}</span>
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
        <span className="ml-auto font-medium text-gray-200">
          {isLive
            ? (periodState(f.sport, f.periods) ?? 'Live')
            : f.status === 'upcoming'
              ? startsInLabel(f.startTime, now)
              : 'Full time'}
        </span>
      </div>

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

      {tab === 'details' && <DetailsTab fixture={f} now={now} mappingInfo={mappingInfo} />}
      {tab === 'markets' && <MarketsTab fixture={f} />}
      {tab === 'bets' && <BetsTab fixture={f} mappingInfo={mappingInfo} />}
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

function DetailsTab({
  fixture: f,
  now,
  mappingInfo,
}: {
  fixture: Fixture
  now: Date
  mappingInfo: MappingInfo
}) {
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

      {/* OPTIC + SWIFT side-by-side. Stacks vertically on narrow viewports. */}
      <div className="grid grid-cols-1 gap-4 border-t border-white/10 px-5 py-4 md:grid-cols-2">
        <OpticPanel fixture={f} now={now} />
        <SwiftPanel info={mappingInfo} />
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

function SwiftPanel({ info }: { info: MappingInfo }) {
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

  return (
    <SourcePanel kind="SWIFT" subtitle="gutsy.events">
      <Grid>
        {/* event-level */}
        <Field label="EVENT NAME" value={swiftEvent?.name ?? '—'} />
        <Field label="STATUS" value={(swiftEvent?.status ?? '—').toUpperCase()} />
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

function SourcePanel({
  kind,
  subtitle,
  children,
}: {
  kind: 'OPTIC' | 'SWIFT'
  subtitle: string
  children: React.ReactNode
}) {
  const tone =
    kind === 'OPTIC'
      ? 'border-[color:var(--total)]/25 bg-[color:var(--total)]/[0.025]'
      : 'border-[color:var(--up)]/25 bg-[color:var(--up)]/[0.025]'
  const pill =
    kind === 'OPTIC'
      ? 'border-[color:var(--total)]/30 text-[color:var(--total)] bg-[color:var(--total)]/10'
      : 'border-[color:var(--up)]/30 text-[color:var(--up)] bg-[color:var(--up)]/10'
  return (
    <div className={`rounded-lg border ${tone} px-4 py-3.5`}>
      <div className="mb-3 flex items-center justify-between">
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${pill}`}
        >
          {kind}
        </span>
        <span className="text-[11px] text-[color:var(--muted-2)]">{subtitle}</span>
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
    <div className={`overflow-hidden rounded-lg border bg-[color:var(--panel)] ${accent}`}>
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

function BetsTab({ fixture: f, mappingInfo }: { fixture: Fixture; mappingInfo: MappingInfo }) {
  // Bets from gutsy.bets joined to this game via the indexed
  // `derived.event_key` / `derived.legs_event_keys` slug. We highlight any
  // bet whose `bet_time` is after the SWIFT actual-start — those landed
  // after the market should have closed.
  const [bets, setBets] = useState<SwiftBetRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const date = (f.scheduledStart ?? f.startTime ?? '').slice(0, 10)
  const swiftActualStart = mappingInfo.swiftEvent?.actualStart ?? null

  useEffect(() => {
    if (!date || !f.homeName || !f.awayName) return
    let alive = true
    setLoading(true)
    setError(null)
    fetchSwiftBets({ date, home: f.homeName, away: f.awayName, swiftActualStart })
      .then((rows) => alive && setBets(rows))
      .catch((e) => alive && setError(String(e?.message ?? e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [date, f.homeName, f.awayName, swiftActualStart])

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
  const lateCount = list.filter((b) => b.placed_after_start).length
  // A multi's stake is shared across its legs, so attribute only this game's
  // share (stake ÷ legs) — both per row and in this total — so the figure
  // reflects exposure to THIS game, not the whole combo.
  const totalStake = list.reduce((sum, b) => sum + legStake(b), 0)
  const totalPnl = list.reduce((sum, b) => sum + (b.pl ?? 0), 0)

  return (
    <div className="px-5 py-5">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[12px] text-[color:var(--muted)]">
        <span>
          Bets:{' '}
          <span className="tabular-nums font-semibold text-gray-200">{list.length}</span>
        </span>
        <span>
          Stake:{' '}
          <span className="tabular-nums font-semibold text-gray-200">${totalStake.toFixed(2)}</span>
        </span>
        <span>
          P/L:{' '}
          <span
            className={`tabular-nums font-semibold ${
              totalPnl > 0 ? 'text-[color:var(--total)]' : totalPnl < 0 ? 'text-[color:var(--live)]' : 'text-gray-200'
            }`}
          >
            ${totalPnl.toFixed(2)}
          </span>
        </span>
        {swiftActualStart && (
          <span>
            SWIFT actual start:{' '}
            <span className="tabular-nums font-medium text-gray-300">{melbDateTime(swiftActualStart)}</span>{' '}
            MEL
          </span>
        )}
        {lateCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--live)]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--live)]">
            ⚠ {lateCount} placed after start
          </span>
        )}
      </div>

      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[color:var(--line-soft)] p-6 text-center text-[12.5px] text-[color:var(--muted)]">
          No bets matched on the SwiftBet side for this game on {date || '—'}. Linkage:{' '}
          <code className="text-gray-300">derived.event_key</code> /{' '}
          <code className="text-gray-300">legs_event_keys</code> regex.
        </div>
      ) : (
        // Horizontal scroll on narrow viewports so the leg/market column gets
        // enough room without crushing the others.
        <div className="overflow-x-auto rounded-lg border border-[color:var(--line-soft)]">
          <table className="w-full min-w-[1060px] text-[12px]">
            <thead>
              <tr className="border-b border-[color:var(--line-soft)] bg-black/[0.15] text-left text-[11px] uppercase tracking-wide text-[color:var(--muted-2)]">
                <th className="px-3 py-2 font-medium">Placed</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Market</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 text-right font-medium">Stake</th>
                <th className="px-3 py-2 text-right font-medium">Odds</th>
                <th className="px-3 py-2 text-right font-medium">P/L</th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <BetRow key={b.bet_id ?? b.id} bet={b} />
              ))}
            </tbody>
          </table>
        </div>
      )}
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

/** Overall multi status from the per-leg results: dead the moment any leg
 *  loses, won when every leg won, otherwise still alive (legs pending, none
 *  lost yet). Drives the live/settled badge so the whole-multi P/L is legible. */
type MultiStatus = 'Alive' | 'Won' | 'Lost'
function multiStatus(breakdown: SwiftBetRow['leg_breakdown']): MultiStatus | null {
  if (!breakdown || breakdown.length === 0) return null
  const r = (x: string | null) => (x ?? '').toLowerCase()
  if (breakdown.some((l) => r(l.result).includes('lost'))) return 'Lost'
  if (breakdown.every((l) => r(l.result) === 'won')) return 'Won'
  return 'Alive'
}

const MULTI_STATUS_BADGE: Record<MultiStatus, string> = {
  Alive: 'bg-[color:var(--up)]/10 text-[color:var(--up)]',
  Won: 'bg-[color:var(--total)]/10 text-[color:var(--total)]',
  Lost: 'bg-[color:var(--live)]/10 text-[color:var(--live)]',
}

function BetRow({ bet: b }: { bet: SwiftBetRow }) {
  const late = b.placed_after_start
  const stake = b.bet_amount ?? 0
  const pl = b.pl ?? 0
  const odd = b.odd ?? null
  const isMulti = (b.type ?? '').toUpperCase() === 'MULTI'
  // For multis, pull the breakdown row that corresponds to THIS game so the
  // panel shows the leg-specific market/outcome rather than the multi's
  // headline. matched_leg_index points into legs_event_keys, which mirrors
  // legs_breakdown order one-to-one.
  const leg =
    b.leg_breakdown && b.matched_leg_index >= 0 ? b.leg_breakdown[b.matched_leg_index] ?? null : null
  const marketLabel = isMulti
    ? leg?.market_category ?? b.market_category ?? '—'
    : b.market_category ?? '—'
  const resultLabel = (leg?.result ?? '').trim() || null
  const resultTone =
    resultLabel === 'Won'
      ? 'text-[color:var(--total)]'
      : resultLabel === 'Lost'
        ? 'text-[color:var(--live)]'
        : 'text-gray-300'
  // The leg that IS this game carries its own selection + price. Show those —
  // for a multi the Odds column shows the LEG price (the multi's combined odds
  // moves to a sub-label), so the row describes this game's actual bet.
  const outcome = (b.matched_leg?.outcome ?? '').trim() || null
  const legOdds = b.matched_leg?.odds ?? null
  const shownOdds = legOdds ?? odd
  const mStatus = isMulti ? multiStatus(b.leg_breakdown) : null
  const perLegStake = legStake(b)
  return (
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
      <td className="px-3 py-2 align-top font-mono text-[10.5px] text-[color:var(--muted-2)]">
        {b.user_id?.slice(0, 8) ?? '—'}
      </td>
      <td className="px-3 py-2 align-top text-gray-200">
        {isMulti ? (
          <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-200">
            MULTI · {b.leg_count}
          </span>
        ) : (
          <span className="text-[11.5px]">{b.bet_type ?? '—'}</span>
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
      </td>
      <td className="px-3 py-2 align-top text-gray-200">{marketLabel}</td>
      <td className="px-3 py-2 align-top text-gray-300">{outcome ?? '—'}</td>
      <td className={`px-3 py-2 align-top text-[11.5px] font-medium ${resultTone}`}>
        {resultLabel ?? '—'}
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
  return (
    <span className="text-[12.5px] font-medium text-[color:var(--up)]">
      {startsInLabel(f.startTime, now)}
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
}: {
  label: string
  value: string
  mono?: boolean
  copyable?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[color:var(--muted-2)]">{prettyLabel(label)}</div>
      <div className="flex items-center gap-1.5">
        <div className={`truncate text-[13px] text-gray-200 ${mono ? 'tabular-nums' : ''}`}>{value}</div>
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
