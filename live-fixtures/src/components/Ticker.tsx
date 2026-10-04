import { memo, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Fixture } from '../lib/types'
import { isPersonSport, periodState } from '../lib/sports'
import { fmtOdds, startsInShort, teamAbbr } from '../lib/format'
import { useTickerFixtures } from '../hooks/useTickerFixtures'
import { Avatar } from './Avatar'
import { TickerSkeleton } from './Skeleton'
import { LeagueBadge } from './LeagueBadge'

/**
 * Next-to-jump strip, pinned under the header: every live event plus whatever
 * jumps in the next few hours, as a compact cell — abbreviated names with the
 * score once a game is under way, or the best H2H price while it's still
 * upcoming.
 *
 * The prices are already on the board's fixtures (`fetchCardOdds` takes the max
 * per side across books), so the strip costs one more pass over data the page
 * has already loaded — no extra query.
 */

/** How far ahead the strip reaches. Live events always qualify. */
const HORIZON_MS = 6 * 60 * 60 * 1000
/** Cells rendered before the strip stops and offers the rest as a link. */
const MAX_CELLS = 60

interface Props {
  now: Date
  /** Raw league slugs mapped to a brand — the same gate the board applies. */
  mappedLeagues: Set<string>
}

/** Live first, then soonest, bounded by the horizon. */
function tickerFixtures(fixtures: Fixture[], nowMs: number): Fixture[] {
  const live: Fixture[] = []
  const soon: Fixture[] = []
  for (const f of fixtures) {
    if (f.status === 'live') {
      live.push(f)
    } else if (f.status === 'upcoming') {
      const t = Date.parse(f.startTime)
      if (Number.isFinite(t) && t - nowMs <= HORIZON_MS) soon.push(f)
    }
  }
  const byStart = (a: Fixture, b: Fixture) => Date.parse(a.startTime) - Date.parse(b.startTime)
  live.sort(byStart)
  soon.sort(byStart)
  return [...live, ...soon]
}

/** Where a live game is up to — the period if the feed reports one, else its clock. */
function liveLabel(f: Fixture): string {
  return periodState(f.sport, f.periods) ?? f.clock ?? 'LIVE'
}

const SideLine = memo(function SideLine({
  name,
  logo,
  score,
  otherScore,
  price,
  isPerson,
}: {
  name: string
  logo: string | null
  score: number | null
  otherScore: number | null
  price: number | null
  isPerson: boolean
}) {
  const played = score != null
  const leads = played && otherScore != null && score > otherScore

  return (
    <div className="flex items-center justify-between gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar name={name} logoUrl={logo} size={14} />
        <span className="truncate text-[11.5px] font-medium text-gray-200">
          {teamAbbr(name, isPerson)}
        </span>
      </span>
      <span
        className={`shrink-0 text-[11.5px] tabular-nums ${
          played
            ? leads
              ? 'font-bold text-gray-100'
              : 'text-[color:var(--muted)]'
            : 'text-[color:var(--total)]'
        }`}
      >
        {played ? score : fmtOdds(price)}
      </span>
    </div>
  )
})

const Cell = memo(function Cell({
  fixture: f,
  now,
  selected,
  onSelect,
}: {
  fixture: Fixture
  now: Date
  selected: boolean
  onSelect: (f: Fixture) => void
}) {
  const isLive = f.status === 'live'
  const isPerson = isPersonSport(f.sport)

  return (
    <button
      type="button"
      onClick={() => onSelect(f)}
      title={`${f.homeName} v ${f.awayName}`}
      className={`flex w-[132px] shrink-0 flex-col gap-1.5 border-r border-[color:var(--line-soft)] px-3 py-2 text-left transition-colors ${
        selected ? 'bg-[color:var(--panel-2)]' : 'hover:bg-white/5'
      }`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <LeagueBadge sport={f.sport} league={f.league} size={14} />
        <span
          className={`flex items-center gap-1 truncate text-[10px] font-semibold uppercase tracking-wide tabular-nums ${
            isLive ? 'text-[color:var(--live)]' : 'text-[color:var(--up)]'
          }`}
        >
          {isLive && <span className="h-1 w-1 shrink-0 rounded-full bg-[color:var(--live)] pulse-dot" />}
          {isLive ? liveLabel(f) : startsInShort(f.startTime, now)}
        </span>
      </div>
      <SideLine
        name={f.homeName}
        logo={f.homeLogo}
        score={f.homeScore}
        otherScore={f.awayScore}
        price={f.oddsHome}
        isPerson={isPerson}
      />
      <SideLine
        name={f.awayName}
        logo={f.awayLogo}
        score={f.awayScore}
        otherScore={f.homeScore}
        price={f.oddsAway}
        isPerson={isPerson}
      />
    </button>
  )
})

export function Ticker({ now, mappedLeagues }: Props) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // Its own feed — see useTickerFixtures. The board's load is ~180x the rows
  // this needs, and sharing it kept the strip blank for the whole nine seconds.
  const { fixtures: feed, loading } = useTickerFixtures()
  const fixtures = useMemo(
    () => (mappedLeagues.size === 0 ? feed : feed.filter((f) => mappedLeagues.has(f.rawLeague))),
    [feed, mappedLeagues],
  )

  // Re-select on the minute, not the second: the membership of the strip only
  // changes as fixtures cross the horizon, while `now` ticks for the countdowns.
  const nowMin = Math.floor(now.getTime() / 60_000)
  const shown = useMemo(
    () => tickerFixtures(fixtures, nowMin * 60_000),
    [fixtures, nowMin],
  )

  // Hold the strip's height while the first read is in flight. Rendering
  // nothing meant the ticker appeared from nowhere and shoved the board down
  // the moment its feed landed.
  if (loading && shown.length === 0) return <TickerSkeleton />
  if (shown.length === 0) return null
  const cells = shown.slice(0, MAX_CELLS)
  const overflow = shown.length - cells.length

  return (
    <div className="flex shrink-0 overflow-x-auto border-b border-[color:var(--line-soft)] bg-[color:var(--panel)]">
      {cells.map((f) => (
        <Cell
          key={f.id}
          fixture={f}
          now={now}
          selected={pathname.startsWith(`/fixture/${f.id}`)}
          onSelect={(x) => navigate(`/fixture/${x.id}`)}
        />
      ))}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => navigate('/upcoming')}
          className="flex w-[132px] shrink-0 items-center justify-center px-3 py-2 text-[11.5px] font-medium text-[color:var(--muted)] transition-colors hover:bg-white/5 hover:text-gray-200"
        >
          +{overflow} more
        </button>
      )}
    </div>
  )
}
