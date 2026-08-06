import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import {
  fetchGolfPrices,
  fetchGolfTournaments,
  golferKey,
  type GolfPrice,
  type GolfTournament,
} from '../lib/golfOutrights'
import { fetchCompetitionMappings, type CompetitionMapping } from '../lib/mappingData'
import { prettyLeague } from '../lib/sports'
import { BRAND_PILL } from '../lib/brand'
import { fmtDateTime, melbDateTime, melbDayTime } from '../lib/format'
import { swiftEventUrl } from '../lib/swiftStatus'
import { mybetEventUrl } from '../lib/mybetStatus'
import { Field, Grid, SourcePanel } from '../components/SourcePanel'
import { betSettlement, fetchSwiftBets, type SwiftBetRow } from '../lib/swiftBets'
import { fetchMybetBets, mybetSettlement, type MybetBetRow } from '../lib/mybetBets'


/**
 * Golf tournament page — the event page's layout, for something that is not an
 * event.
 *
 * Golf has no fixture: no kickoff, no home vs away, no score, no clock. What it
 * has is a field of priced golfers. So the hero shows the tournament and the
 * size of the field where a fixture shows two teams and a scoreline, and the
 * Markets tab shows the outright rather than h2h/spread/total.
 */

/** How many favourites the Markets tab lists. */
const TOP_N = 10

interface SwiftSelection {
  name: string | null
  odds: number | null
  status: string | null
}
interface MybetOutright {
  event: {
    id: string
    description: string | null
    market: string
    suspendAt: string | null
    outcomeAt: string | null
    lastSeenAt: string | null
    open: boolean | null
    runners: number
  } | null
  selections: Array<{ name: string | null; odds: number | null }>
  markets: string[]
}

/**
 * OPTIC's own status, with `is_live` taking precedence. golf_tournaments now
 * carries status/is_live/is_active directly, so nothing is derived from dates.
 */
function opticStatus(t: GolfTournament): string {
  if (t.isLive) return 'LIVE'
  return (t.status ?? '—').toUpperCase()
}

interface SwiftOutright {
  event: { id: string; name: string | null; competition: string | null; start: string | null; status: string | null } | null
  markets: Array<{ name: string | null; selections: SwiftSelection[] }>
}

export default function GolfDetailPage() {
  const { tournamentId = '' } = useParams()
  const [tournament, setTournament] = useState<GolfTournament | null>(null)
  const [prices, setPrices] = useState<GolfPrice[] | null>(null)
  const [swift, setSwift] = useState<SwiftOutright | null>(null)
  const [mybet, setMybet] = useState<MybetOutright | null>(null)
  const [swiftBets, setSwiftBets] = useState<SwiftBetRow[] | null>(null)
  const [mybetBets, setMybetBets] = useState<MybetBetRow[] | null>(null)
  const [mapping, setMapping] = useState<CompetitionMapping | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'details' | 'markets' | 'bets'>('details')

  useDocumentTitle(tournament?.tournament ?? 'Golf')

  // OPTIC side: the tournament and its prices.
  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([fetchGolfTournaments(), fetchGolfPrices(tournamentId)])
      .then(([ts, ps]) => {
        if (!alive) return
        setTournament(ts.find((t) => t.tournamentId === tournamentId) ?? null)
        setPrices(ps)
      })
      .catch(() => alive && setPrices([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [tournamentId])

  // mybet's outright. It carries no competition id to join on, so it's found by
  // the tournament name embedded in the description — see api/mybet-outright.
  useEffect(() => {
    if (!tournament) return
    let alive = true
    fetch('/api/mybet-outright', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tournament: tournament.tournament, market: 'Winner' }),
    })
      .then((r) => r.json())
      .then((j) => alive && setMybet(j))
      .catch(() => {/* additive — OPTIC prices still render */})
    return () => {
      alive = false
    }
  }, [tournament])

  // Book side: follow the competition mapping to SwiftBet's outright event.
  useEffect(() => {
    if (!tournament) return
    let alive = true
    fetchCompetitionMappings()
      .then(async (comps) => {
        const league = prettyLeague(tournament.league)
        const m =
          comps.find(
            (c) =>
              c.optic_sport === 'golf' &&
              c.optic_league === league &&
              c.optic_tournament === tournament.tournament &&
              c.swift_competition_id,
          ) ?? null
        if (!alive) return
        setMapping(m)
        if (!m?.swift_competition_id) return
        // The competition holds the field event plus that week's matchups;
        // `outright: true` returns only the field.
        const found = await fetch('/api/swift-search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            q: '',
            kind: 'events',
            sport: 'Golf',
            competitionId: m.swift_competition_id,
            outright: true,
            limit: 10,
          }),
        }).then((r) => r.json())
        const ev = found.events?.[0]
        if (!ev || !alive) return
        const out = await fetch('/api/swift-outright', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: ev.id, market: 'outright winner' }),
        }).then((r) => r.json())
        if (alive) setSwift(out)
      })
      .catch(() => {/* book side is additive — the OPTIC prices still render */})
    return () => {
      alive = false
    }
  }, [tournament])

  // Bets on the two brands' outright events. Both join on the book's own event
  // id — golf has no teams, so the usual name+date join has nothing to work
  // with (see the outright mode in api/swift-bets.ts).
  const swiftOutrightId = swift?.event?.id ?? null
  useEffect(() => {
    if (!swiftOutrightId || !tournament?.startDate) return
    let alive = true
    fetchSwiftBets({
      date: tournament.startDate.slice(0, 10),
      home: '',
      away: '',
      swiftEventId: swiftOutrightId,
      swiftActualStart: null,
      scheduledStart: tournament.startDate,
    })
      .then((rows) => alive && setSwiftBets(rows))
      .catch(() => alive && setSwiftBets([]))
    return () => {
      alive = false
    }
  }, [swiftOutrightId, tournament?.startDate])

  const mybetOutrightId = mybet?.event?.id ?? null
  useEffect(() => {
    if (!mybetOutrightId) return
    let alive = true
    fetchMybetBets({ eventId: mybetOutrightId, suspendAt: mybet?.event?.suspendAt ?? null })
      .then((rows) => alive && setMybetBets(rows))
      .catch(() => alive && setMybetBets([]))
    return () => {
      alive = false
    }
  }, [mybetOutrightId, mybet?.event?.suspendAt])

  // Markets lists the bookmakers we hold prices from — the book's own outright
  // is reported on the SWIFT panel in Details rather than mixed into this table.
  const rows = useMemo(() => (prices ?? []).slice(0, TOP_N), [prices])

  const books = useMemo(() => {
    const set = new Set<string>()
    for (const p of prices ?? []) for (const b of Object.keys(p.byBook)) set.add(b)
    return [...set].sort()
  }, [prices])

  if (loading) {
    return <div className="px-5 py-8 text-sm text-[color:var(--muted-2)]">Loading…</div>
  }
  if (!tournament) {
    return (
      <div className="px-5 py-8">
        <div className="text-sm text-white">Tournament not found</div>
        <Link to="/mapping/golf" className="mt-2 inline-block text-[12px] text-[color:var(--muted)] hover:text-gray-200">
          ← Back to golf mapping
        </Link>
      </div>
    )
  }

  const swiftEventId = swift?.event?.id ?? null

  return (
    <div className="px-5 py-5">
      <Link
        to="/mapping/golf"
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] text-[color:var(--muted)] transition-colors hover:text-gray-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to golf
      </Link>

      <div className="rounded-lg bg-[color:var(--panel)]">
        {/* HERO — the tournament, where a fixture page shows the match-up. */}
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="text-[18px]">⛳</span>
            <span className="text-[14px] font-semibold text-gray-100">
              {prettyLeague(tournament.league)}
            </span>
          </div>
          <span className="inline-flex items-center rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-gray-300">
            {tournament.market}
          </span>
        </div>

        <div className="px-5 py-5">
          <div className="text-[20px] font-semibold tracking-tight text-gray-100">{tournament.tournament}</div>
          <div className="mt-1 text-[13px] text-[color:var(--muted)]">
            {tournament.venueName ?? '—'}
            {tournament.venueLocation ? ` · ${tournament.venueLocation}` : ''}
            {tournament.golfers ? ` · ${tournament.golfers} priced` : ' · no prices yet'}
          </div>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-white/[0.05] bg-black/[0.15] px-5 py-3 text-[12px] text-[color:var(--muted)]">
          <span>
            STARTS <span className="ml-1 tabular-nums text-gray-200">{fmtDateTime(tournament.startDate)}</span>
          </span>
          <span>
            MEL <span className="ml-1 tabular-nums text-gray-200">{melbDateTime(tournament.startDate)}</span>
          </span>
          <span>
            ENDS <span className="ml-1 tabular-nums text-gray-200">{fmtDateTime(tournament.endDate)}</span>
          </span>
        </div>

        {/* TAB STRIP — same shape as the event page. No Bets tab: bets sit on
            the book's outright event, not on an OPTIC fixture. */}
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

        {tab === 'bets' ? (
          <BetsTab swiftBets={swiftBets} mybetBets={mybetBets} />
        ) : tab === 'markets' ? (
          <MarketsTab rows={rows} books={books} total={prices?.length ?? 0} />
        ) : (
          <DetailsTab
            tournament={tournament}
            mapping={mapping}
            swift={swift}
            swiftEventId={swiftEventId}
            prices={prices}
            mybet={mybet}
          />
        )}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
        active ? 'bg-white/10 text-white' : 'text-[color:var(--muted)] hover:bg-white/5 hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  )
}

/** Outright, top N favourites, priced by each bookmaker we hold. */
function MarketsTab({ rows, books, total }: { rows: GolfPrice[]; books: string[]; total: number }) {
  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--muted-2)]">
          Outright · Winner
        </span>
        <span className="text-[11px] text-[color:var(--muted-2)]">
          top {rows.length} of {total} by price
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg bg-black/[0.15] px-4 py-6 text-[13px] text-[color:var(--muted-2)]">
          No outright prices for this tournament.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-black/[0.15]">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-[color:var(--line-soft)] text-left text-[11px] uppercase tracking-wide text-[color:var(--muted-2)]">
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Golfer</th>
                {books.map((b) => (
                  <th key={b} className="px-4 py-2.5 text-right font-medium">
                    {b}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.golfer} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="px-4 py-2.5 tabular-nums text-[color:var(--muted-2)]">{i + 1}</td>
                  <td className="px-4 py-2.5 text-gray-100">{r.golfer}</td>
                  {books.map((b) => (
                    <td key={b} className="px-4 py-2.5 text-right tabular-nums text-gray-300">
                      {r.byBook[b] != null ? r.byBook[b].toFixed(2) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * OPTIC + SWIFT + mybet side by side, exactly as the fixture page lays them
 * out — same SourcePanel/Grid/Field components, same breakpoints.
 */
function DetailsTab({
  tournament,
  mapping,
  swift,
  swiftEventId,
  prices,
  mybet,
}: {
  tournament: GolfTournament
  mapping: CompetitionMapping | null
  swift: SwiftOutright | null
  swiftEventId: string | null
  prices: GolfPrice[] | null
  mybet: MybetOutright | null
}) {
  const swiftSels = swift?.markets?.[0]?.selections ?? []
  // How much of the field we can line up name-for-name. Reported rather than
  // hidden: the two feeds disagree on short forms (Zach/Zachary), so a partial
  // join is expected and worth seeing.
  const matched = (() => {
    if (!prices?.length || !swiftSels.length) return null
    const keys = new Set(swiftSels.filter((x) => x.name).map((x) => golferKey(x.name as string)))
    return prices.filter((p) => keys.has(golferKey(p.golfer))).length
  })()

  return (
    <div className="grid grid-cols-1 gap-4 border-t border-white/10 px-5 py-4 md:grid-cols-2 lg:grid-cols-3">
      <SourcePanel kind="OPTIC" subtitle="golf_tournaments + golf_outrights">
        <Grid>
          <Field label="TOURNAMENT" value={tournament.tournament} />
          <Field label="STATUS" value={opticStatus(tournament)} />
          <Field label="TOUR" value={prettyLeague(tournament.league)} />
          <Field label="MARKET" value={tournament.market} />
          <Field label="VENUE" value={tournament.venueName ?? '—'} />
          <Field label="LOCATION" value={tournament.venueLocation ?? '—'} />
          <Field label="STARTS (UTC)" value={fmtDateTime(tournament.startDate)} />
          <Field label="ENDS (UTC)" value={fmtDateTime(tournament.endDate)} />
          <Field label="START (MEL)" value={melbDateTime(tournament.startDate)} />
          {/* Two different numbers: how many books OPTIC sees listing this
              tournament, versus the ones we actually hold prices from. */}
          <Field label="FIELD PRICED" value={tournament.golfers ? `${tournament.golfers} golfers` : 'none yet'} />
          <Field
            label="PRICE STATUS"
            value={(tournament.priceStatus ?? '—').replace(/_/g, ' ').toUpperCase()}
          />
          <Field label="BOOKS LISTING" value={String(tournament.bookCount)} />
          <Field label="PRICES FROM" value={tournament.books.join(', ') || '—'} />
          <Field label="UPDATED" value={fmtDateTime(tournament.updatedAt)} />
          <Field label="TOURNAMENT ID" value={tournament.tournamentId} mono copyable />
        </Grid>
      </SourcePanel>

      <SourcePanel
        kind="SWIFT"
        subtitle="gutsy.events"
        action={
          swiftEventId && (
            <a
              href={swiftEventUrl(swiftEventId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-[color:var(--swift)]/30 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--swift)] hover:bg-[color:var(--swift)]/10"
            >
              Open Swift <ExternalLink className="h-3 w-3" />
            </a>
          )
        }
      >
        {mapping ? (
          <Grid>
            <Field label="COMPETITION" value={mapping.swift_competition ?? '—'} />
            <Field label="STATUS" value={(swift?.event?.status ?? '—').toUpperCase()} />
            <Field label="OUTRIGHT EVENT" value={swift?.event?.name ?? '—'} />
            <Field label="MARKET" value={swift?.markets?.[0]?.name ?? '—'} />
            <Field label="RUNNERS PRICED" value={swiftSels.length ? String(swiftSels.length) : '—'} />
            <Field
              label="FAVOURITE"
              value={swiftSels[0]?.name ? `${swiftSels[0].name} @ ${swiftSels[0].odds?.toFixed(2)}` : '—'}
            />
            <Field
              label="NAMES MATCHED"
              value={matched == null ? '—' : `${matched} of ${tournament.golfers}`}
            />
            <Field label="CONFIDENCE" value={`${Math.round((mapping.confidence ?? 0) * 100)}%`} />
            <Field label="SOURCE" value={(mapping.source ?? 'auto').toUpperCase()} />
            <Field label="COMPETITION ID" value={mapping.swift_competition_id ?? '—'} mono copyable />
            <Field label="EVENT ID" value={swiftEventId ?? '—'} mono copyable />
          </Grid>
        ) : (
          <div className="text-[12px] leading-relaxed text-gray-400">
            <span className="font-bold text-gray-200">No SwiftBet mapping yet.</span> Pair this
            tournament on the{' '}
            <Link to="/mapping/golf" className="text-[color:var(--swift)] underline">
              Mapping
            </Link>{' '}
            tab to pull its outright prices in.
          </div>
        )}
      </SourcePanel>

      <SourcePanel
        kind="MYBET"
        subtitle="gutsy.mybet_events"
        action={
          mybet?.event?.id && (
            <a
              href={mybetEventUrl(mybet.event.id, 'golf')}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-[color:var(--mybet)]/30 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--mybet)] hover:bg-[color:var(--mybet)]/10"
            >
              Open mybet <ExternalLink className="h-3 w-3" />
            </a>
          )
        }
      >
        {mybet?.event ? (
          <Grid>
            <Field label="EVENT" value={mybet.event.description ?? '—'} />
            <Field
              label="STATUS"
              value={mybet.event.open == null ? '—' : mybet.event.open ? 'OPEN' : 'CLOSED'}
            />
            <Field label="MARKET" value={mybet.event.market || '—'} />
            <Field label="RUNNERS PRICED" value={`${mybet.selections.length} of ${mybet.event.runners}`} />
            <Field
              label="FAVOURITE"
              value={
                mybet.selections[0]?.name
                  ? `${mybet.selections[0].name} @ ${mybet.selections[0].odds?.toFixed(2)}`
                  : '—'
              }
            />
            <Field label="OTHER MARKETS" value={mybet.markets.filter((m) => m !== 'Winner').join(', ') || '—'} />
            <Field label="CLOSES (UTC)" value={fmtDateTime(mybet.event.suspendAt)} />
            <Field label="CLOSES (MEL)" value={melbDateTime(mybet.event.suspendAt)} />
            <Field label="LAST SEEN (UTC)" value={fmtDateTime(mybet.event.lastSeenAt)} />
            <Field label="EVENT ID" value={mybet.event.id} mono copyable />
          </Grid>
        ) : (
          <div className="text-[12px] leading-relaxed text-gray-400">
            <span className="font-bold text-gray-200">No mybet outright for this tournament.</span>{' '}
            mybet keeps outrights as a `comps` map rather than the A-vs-B `match`
            its head-to-heads use, and this one has none.
          </div>
        )}
      </SourcePanel>
    </div>
  )
}

/**
 * Bets on the two brands' outright markets.
 *
 * One table per brand rather than the fixture page's sub-tab strip: a golf
 * outright carries a handful of bets, not the hundreds a busy fixture does, so
 * splitting them behind tabs hides more than it organises.
 */
function BetsTab({
  swiftBets,
  mybetBets,
}: {
  swiftBets: SwiftBetRow[] | null
  mybetBets: MybetBetRow[] | null
}) {
  const sw = swiftBets ?? []
  const mb = mybetBets ?? []
  // Each brand resolves on its own chain — the tournament's competition
  // mapping, then the book's outright event, then its bets — so one can be
  // ready while the other is still going. `null` means still resolving; showing
  // it as "0 bets" reads as "none exist", which is a different claim.
  return (
    <div className="space-y-5 px-5 py-4">
      <BetBlock
        kind="SWIFT"
        loading={swiftBets === null}
        empty="No SwiftBet bets on this outright."
        total={sw.length}
        stake={sw.reduce((s, b) => s + (b.bet_amount ?? 0), 0)}
        pending={sw.filter((b) => betSettlement(b.bet_status) === 'pending').length}
        rows={sw.map((b) => ({
          key: b.id,
          placed: b.bet_time,
          user: b.user_id?.slice(0, 8) ?? '—',
          betId: b.bet_id ?? b.id,
          pick: b.matched_leg?.outcome ?? b.bet_type ?? '—',
          odds: b.matched_leg?.odds ?? b.odd,
          stake: b.bet_amount,
          legs: b.leg_count,
          state: betSettlement(b.bet_status),
        }))}
      />
      <BetBlock
        kind="MYBET"
        loading={mybetBets === null}
        empty="No mybet bets on this outright."
        total={mb.length}
        stake={mb.reduce((s, b) => s + (b.amount_bet ?? 0), 0)}
        pending={mb.filter((b) => mybetSettlement(b.bet_status) === 'pending').length}
        rows={mb.map((b) => ({
          key: b.id,
          placed: b.transaction_date,
          user: b.user_accountID != null ? String(b.user_accountID) : '—',
          betId: b.transaction_id != null ? String(b.transaction_id) : b.id,
          pick: b.selections ?? b.bet_type ?? '—',
          odds: b.price,
          stake: b.amount_bet,
          legs: b.leg_count,
          state: mybetSettlement(b.bet_status),
        }))}
      />
    </div>
  )
}

interface BetLine {
  key: string
  placed: string | null
  user: string
  betId: string
  pick: string
  odds: number | null
  stake: number | null
  legs: number
  state: 'pending' | 'settled' | 'void' | 'unknown'
}

function BetBlock({
  kind,
  rows,
  total,
  stake,
  pending,
  empty,
  loading,
}: {
  kind: 'SWIFT' | 'MYBET'
  rows: BetLine[]
  total: number
  stake: number
  pending: number
  empty: string
  loading: boolean
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${
            kind === 'SWIFT' ? BRAND_PILL.swift : BRAND_PILL.mybet
          }`}
        >
          {kind}
        </span>
        <span className="text-[11px] text-[color:var(--muted-2)]">
          {loading ? 'loading…' : `${total} ${total === 1 ? 'bet' : 'bets'} · $${stake.toFixed(2)} staked`}
        </span>
        {pending > 0 && (
          <span className="inline-flex items-center gap-1 rounded bg-[color:var(--up)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--up)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--up)] pulse-dot" />
            {pending} pending
          </span>
        )}
      </div>
      {loading ? (
        <div className="rounded-lg bg-black/[0.15] px-4 py-4 text-[12px] text-[color:var(--muted-2)]">
          Resolving this tournament's {kind === 'SWIFT' ? 'SwiftBet' : 'mybet'} outright…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg bg-black/[0.15] px-4 py-4 text-[12px] text-[color:var(--muted-2)]">{empty}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-black/[0.15]">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-[color:var(--line-soft)] text-left text-[11px] uppercase tracking-wide text-[color:var(--muted-2)]">
                <th className="px-3 py-2 font-medium">Placed</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Bet ID</th>
                <th className="px-3 py-2 font-medium">Selection</th>
                <th className="px-3 py-2 text-right font-medium">Odds</th>
                <th className="px-3 py-2 text-right font-medium">Stake</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="px-3 py-2 tabular-nums text-[11px] text-gray-200">
                    {r.placed ? melbDayTime(r.placed) : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10.5px] text-[color:var(--muted-2)]">{r.user}</td>
                  <td className="px-3 py-2 font-mono text-[10.5px] text-[color:var(--muted-2)]">
                    {r.betId.slice(0, 5)}
                    {r.betId.length > 5 ? '…' : ''}
                  </td>
                  <td className="px-3 py-2 text-gray-100">
                    {r.pick}
                    {r.legs > 1 && (
                      <span className="ml-1.5 rounded bg-white/5 px-1 py-px text-[9px] uppercase tracking-wide text-gray-400">
                        {r.legs} legs
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-300">
                    {r.odds != null ? r.odds.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-200">
                    {r.stake != null ? `$${r.stake.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {r.state === 'pending' ? (
                      <span className="text-[10px] font-semibold text-[color:var(--up)]">PENDING</span>
                    ) : r.state === 'settled' ? (
                      <span className="text-[10px] font-semibold text-[color:var(--total)]">SETTLED</span>
                    ) : r.state === 'void' ? (
                      <span className="text-[10px] font-semibold text-[color:var(--muted)]">VOID</span>
                    ) : (
                      <span className="text-[10px] text-[color:var(--muted-2)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
