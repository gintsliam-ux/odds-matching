import { memo } from 'react'
import type { Fixture } from '../lib/types'
import { leagueLabel, periodState } from '../lib/sports'
import { fmtOdds, melbTime, overdueMinutes, startsInLabel } from '../lib/format'
import { Avatar } from './Avatar'
import { LeagueBadge } from './LeagueBadge'

interface Props {
  fixture: Fixture
  now: Date
  onSelect?: (f: Fixture) => void
}

export const FixtureCard = memo(function FixtureCard({ fixture: f, now, onSelect }: Props) {
  const isLive = f.status === 'live'
  const isDone = f.status === 'completed'

  // Flat cards: no outline — separation comes from the panel background. Live
  // still glows; completed dims.
  const border = isLive ? 'glow-live' : isDone ? 'opacity-80' : ''

  return (
    <article
      onClick={() => onSelect?.(f)}
      className={`cursor-pointer overflow-hidden rounded-lg bg-[color:var(--panel)] transition-all hover:bg-[color:var(--panel-2)] ${border}`}
    >
      {/* header */}
      <div className="flex items-center justify-between border-b border-white/[0.04] px-4 py-2.5">
        <div className="flex items-center gap-2 truncate">
          <LeagueBadge sport={f.sport} league={f.league} size={16} />
          <span className="truncate text-[12.5px] font-semibold text-gray-100">
            {leagueLabel(f.sport, f.league, f.seasonType)}
          </span>
        </div>
        <StatusBadge fixture={f} now={now} />
      </div>

      {/* teams (with per-period line score when it fits) */}
      <div className="px-4 pt-3">
        <TeamRow
          name={f.homeName}
          logo={f.homeLogo}
          score={f.homeScore}
          leads={leads(f.homeScore, f.awayScore)}
          periods={cardPeriods(f, 'home')}
        />
        <TeamRow
          name={f.awayName}
          logo={f.awayLogo}
          score={f.awayScore}
          leads={leads(f.awayScore, f.homeScore)}
          periods={cardPeriods(f, 'away')}
        />
      </div>

      {/* odds
          A GRID, not a flex row. The cells were `flex-1` without `min-w-0`, so
          they could not shrink below their own content: two fit a card, three
          did not, and a win-draw-win market pushed its prices out through the
          side of the card. Grid tracks are minmax(0,1fr), so three share the
          width and stay inside it however narrow the column gets. */}
      <div className="flex items-center gap-1.5 px-4 pb-3 pt-3">
        <span
          className={`shrink-0 text-[10px] font-medium tracking-wide ${
            isLive ? 'text-[color:var(--live)]' : 'text-[color:var(--muted-2)]'
          }`}
        >
          {isLive ? 'LIVE' : 'H2H'}
        </span>
        <div
          className={`grid min-w-0 flex-1 gap-1.5 ${
            f.oddsDraw != null ? 'grid-cols-3' : 'grid-cols-2'
          }`}
        >
          <OddsCell label="H" value={f.oddsHome} live={isLive} />
          {f.oddsDraw != null && <OddsCell label="D" value={f.oddsDraw} live={isLive} />}
          <OddsCell label="A" value={f.oddsAway} live={isLive} />
        </div>
      </div>

      {/* footer */}
      <div className="flex items-center justify-between border-t border-white/[0.04] px-4 py-2 text-[11.5px]">
        <span className="text-[color:var(--muted-2)] tabular-nums">
          {melbTime(f.startTime)} <span className="text-[color:var(--muted-2)]/60">MEL</span>
        </span>
        <Footer fixture={f} now={now} />
      </div>
    </article>
  )
})

function StatusBadge({ fixture: f, now }: Props) {
  if (f.status === 'live') {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[color:var(--live)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />
        Live
      </span>
    )
  }
  if (f.status === 'completed') {
    return <span className="text-[11.5px] font-medium text-[color:var(--muted)]">Final</span>
  }
  const overdue = overdueMinutes(f.startTime, now) >= 3
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-[color:var(--up)]">
      {startsInLabel(f.startTime, now)}
      {overdue && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-[color:var(--live)]/10 px-1.5 py-0.5 text-[9px] font-semibold text-[color:var(--live)]"
          title="Scheduled start has passed but it hasn't gone live — possibly delayed"
        >
          <span className="h-1 w-1 rounded-full bg-[color:var(--live)] pulse-dot" />
          delay?
        </span>
      )}
    </span>
  )
}

function TeamRow({
  name,
  logo,
  score,
  leads,
  periods,
}: {
  name: string
  logo: string | null
  score: number | null
  leads: boolean
  periods: (number | null)[] | null
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <Avatar name={name} logoUrl={logo} size={20} />
      <span className="flex-1 truncate text-[14.5px] text-gray-100">{name}</span>
      {periods?.map((v, i) => (
        <span key={i} className="w-5 text-right text-[11px] tabular-nums text-[color:var(--muted-2)]">
          {v ?? '·'}
        </span>
      ))}
      <span
        className={`w-7 text-right text-[15.5px] font-semibold tabular-nums ${
          score == null
            ? 'text-[color:var(--muted-2)]/50'
            : leads
              ? 'text-[color:var(--total)]'
              : 'text-gray-100'
        }`}
      >
        {score == null ? '–' : score}
      </span>
    </div>
  )
}

/** Per-period values for a team, but only when a compact line score fits the
 *  card (2–5 periods, game in/after play). Baseball's 9 innings stay off-card. */
function cardPeriods(f: Fixture, side: 'home' | 'away'): (number | null)[] | null {
  if (f.status === 'upcoming' || f.periods.length < 2 || f.periods.length > 5) return null
  return f.periods.map((p) => (side === 'home' ? p.home : p.away))
}

function OddsCell({ label, value, live }: { label: string; value: number | null; live: boolean }) {
  return (
    <div
      className={`flex min-w-0 items-center justify-between gap-1 rounded-md border px-1.5 py-1.5 ${
        live
          ? 'border-[color:var(--live)]/25 bg-[color:var(--live)]/[0.06]'
          : 'border-[color:var(--line-soft)] bg-black/20'
      }`}
    >
      <span className="shrink-0 text-[10px] font-medium text-[color:var(--muted-2)]">{label}</span>
      {/* A three-figure price ("101.00") is the widest thing here — truncate
          rather than let it widen the track and reintroduce the overflow. */}
      <span className="truncate text-[12.5px] font-semibold tabular-nums text-gray-100">
        {fmtOdds(value)}
      </span>
    </div>
  )
}

function Footer({ fixture: f, now }: Props) {
  if (f.status === 'live') {
    return (
      <span className="flex items-center gap-1.5 font-semibold text-[color:var(--live)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />
        {periodState(f.sport, f.periods) ?? 'Live'}
      </span>
    )
  }
  if (f.status === 'completed') {
    return <span className="font-medium text-[color:var(--muted-2)]">FT</span>
  }
  return (
    <span className="text-[color:var(--muted-2)]">
      {startsInLabel(f.startTime, now)}
      {overdueMinutes(f.startTime, now) >= 3 && <span className="ml-1 text-[color:var(--live)]">· delay?</span>}
    </span>
  )
}

function leads(a: number | null, b: number | null): boolean {
  return a != null && b != null && a > b
}
