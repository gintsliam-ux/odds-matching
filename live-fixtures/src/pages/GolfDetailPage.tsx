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
import { fmtDateTime, melbDateTime } from '../lib/format'
import { swiftEventUrl } from '../lib/swiftStatus'

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
interface SwiftOutright {
  event: { id: string; name: string | null; competition: string | null; start: string | null; status: string | null } | null
  markets: Array<{ name: string | null; selections: SwiftSelection[] }>
}

export default function GolfDetailPage() {
  const { tournamentId = '' } = useParams()
  const [tournament, setTournament] = useState<GolfTournament | null>(null)
  const [prices, setPrices] = useState<GolfPrice[] | null>(null)
  const [swift, setSwift] = useState<SwiftOutright | null>(null)
  const [mapping, setMapping] = useState<CompetitionMapping | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'details' | 'markets'>('markets')

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

  // Join the two fields on a canonical name so each favourite carries both
  // sides' prices. See golferKey for what does and doesn't join.
  const rows = useMemo(() => {
    const swiftSels = swift?.markets?.[0]?.selections ?? []
    const byKey = new Map<string, SwiftSelection>()
    for (const s of swiftSels) if (s.name) byKey.set(golferKey(s.name), s)
    return (prices ?? []).slice(0, TOP_N).map((p) => {
      const s = byKey.get(golferKey(p.golfer)) ?? null
      return { ...p, swiftOdds: s?.odds ?? null, swiftName: s?.name ?? null }
    })
  }, [prices, swift])

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
            {tournament.markets.join(' · ') || 'Winner'}
          </span>
        </div>

        <div className="px-5 py-5">
          <div className="text-[20px] font-semibold tracking-tight text-gray-100">{tournament.tournament}</div>
          <div className="mt-1 text-[13px] text-[color:var(--muted)]">
            {tournament.golfers} in the field · priced by {books.join(' + ') || '—'}
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
        </div>

        {tab === 'markets' ? (
          <MarketsTab rows={rows} books={books} swift={swift} total={prices?.length ?? 0} />
        ) : (
          <DetailsTab tournament={tournament} mapping={mapping} swift={swift} swiftEventId={swiftEventId} />
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

/** Outright, top N favourites, with every price we hold for each. */
function MarketsTab({
  rows,
  books,
  swift,
  total,
}: {
  rows: Array<GolfPrice & { swiftOdds: number | null; swiftName: string | null }>
  books: string[]
  swift: SwiftOutright | null
  total: number
}) {
  const swiftCount = swift?.markets?.[0]?.selections?.length ?? 0
  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--muted-2)]">
          Outright · Winner
        </span>
        <span className="text-[11px] text-[color:var(--muted-2)]">
          top {rows.length} of {total} by price
        </span>
        {swiftCount > 0 && (
          <span className="ml-auto text-[11px] text-[color:var(--muted-2)]">
            SwiftBet pricing {swiftCount} runners
          </span>
        )}
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
                <th className="px-4 py-2.5 text-right font-medium text-[color:var(--swift)]">SwiftBet</th>
                <th className="px-4 py-2.5 text-right font-medium">Edge</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                // Positive = SwiftBet is the longer (better) price on the same
                // runner. Only meaningful when both sides priced them.
                const edge =
                  r.best != null && r.swiftOdds != null ? (r.swiftOdds / r.best - 1) * 100 : null
                return (
                  <tr key={r.golfer} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 tabular-nums text-[color:var(--muted-2)]">{i + 1}</td>
                    <td className="px-4 py-2.5 text-gray-100">{r.golfer}</td>
                    {books.map((b) => (
                      <td key={b} className="px-4 py-2.5 text-right tabular-nums text-gray-300">
                        {r.byBook[b] != null ? r.byBook[b].toFixed(2) : '—'}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium text-[color:var(--swift)]">
                      {r.swiftOdds != null ? r.swiftOdds.toFixed(2) : '—'}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right tabular-nums ${
                        edge == null
                          ? 'text-[color:var(--muted-2)]'
                          : edge > 0
                            ? 'text-[color:var(--total)]'
                            : 'text-[color:var(--live)]'
                      }`}
                      title={
                        edge == null
                          ? 'Not priced on both sides — the two feeds spell some names differently'
                          : 'SwiftBet price vs the best OPTIC price'
                      }
                    >
                      {edge == null ? '—' : `${edge > 0 ? '+' : ''}${edge.toFixed(1)}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DetailsTab({
  tournament,
  mapping,
  swift,
  swiftEventId,
}: {
  tournament: GolfTournament
  mapping: CompetitionMapping | null
  swift: SwiftOutright | null
  swiftEventId: string | null
}) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 md:grid-cols-3">
      <Field label="TOURNAMENT" value={tournament.tournament} />
      <Field label="TOUR" value={prettyLeague(tournament.league)} />
      <Field label="TOURNAMENT ID" value={tournament.tournamentId} mono />
      <Field label="FIELD" value={`${tournament.golfers} golfers`} />
      <Field label="MARKETS" value={tournament.markets.join(', ') || '—'} />
      <Field label="PRICED BY" value={tournament.books.join(', ') || '—'} />
      <Field label="STARTS (UTC)" value={fmtDateTime(tournament.startDate)} />
      <Field label="ENDS (UTC)" value={fmtDateTime(tournament.endDate)} />
      <Field label="PRICES UPDATED" value={fmtDateTime(tournament.updatedAt)} />
      <Field
        label="SWIFT COMPETITION"
        value={mapping?.swift_competition ?? 'Unmapped'}
        tone={mapping ? undefined : 'text-[color:var(--muted-2)]'}
      />
      <Field label="SWIFT OUTRIGHT EVENT" value={swift?.event?.name ?? '—'} />
      <div className="min-w-0">
        <div className="text-[11px] text-[color:var(--muted-2)]">OPEN</div>
        {swiftEventId ? (
          <a
            href={swiftEventUrl(swiftEventId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[13px] text-[color:var(--swift)] hover:underline"
          >
            SwiftBet <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <div className="text-[13px] text-[color:var(--muted-2)]">—</div>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[color:var(--muted-2)]">{label}</div>
      <div className={`truncate text-[13px] ${tone ?? 'text-gray-200'} ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </div>
    </div>
  )
}
