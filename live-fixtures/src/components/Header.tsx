import { Activity } from 'lucide-react'
import type { FeedState } from '../hooks/useFixtures'
import type { MongoFeedState, MongoPulse } from '../hooks/useMongoPulse'
import { melbTime, utcClock } from '../lib/format'

interface Counts {
  total: number
  live: number
  upcoming: number
  completed: number
}

interface Props {
  counts: Counts
  now: Date
  nextPollAt: number
  feed: FeedState
  lastUpdated: Date | null
  mongoState: MongoFeedState
  mongoPulse: MongoPulse | null
}

/** "42s" / "3m" / "1h12m" — compact age for the freshness label. */
function shortAge(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

// Both feed indicators share these three states so OPTIC and Mongo read the
// same way: green = healthy & fresh, amber = stale (no fresh data for a while
// or still connecting), red = broken/unreachable.
type Health = 'ok' | 'stale' | 'down'

// Literal Tailwind classes (no runtime string-building) so the JIT emits them.
const HEALTH_CLASS: Record<Health, { dot: string; text: string }> = {
  ok: { dot: 'bg-[color:var(--total)]', text: 'text-[color:var(--total)]' },
  stale: { dot: 'bg-[color:var(--up)]', text: 'text-[color:var(--up)]' },
  down: { dot: 'bg-[color:var(--live)]', text: 'text-[color:var(--live)]' },
}

/** A labelled health dot. Pulses while healthy or stale; goes solid when down
 *  (a frozen red dot reads as "stopped" better than a blinking one). */
function StatusPulse({
  label,
  health,
  detail,
  title,
}: {
  label: string
  health: Health
  detail?: string | null
  title?: string
}) {
  const c = HEALTH_CLASS[health]
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${c.dot} ${health === 'down' ? '' : 'pulse-dot'}`}
      />
      <span className={`font-semibold ${c.text}`}>{label}</span>
      {detail ? <span className="tabular-nums text-[color:var(--muted-2)]">{detail}</span> : null}
    </span>
  )
}

/** OpticOdds board feed (Supabase) health from the poll loop. Green when the
 *  last successful poll is recent; amber while connecting or when polls have
 *  gone quiet; red once the fetch is erroring. */
function boardHealth(feed: FeedState, lastUpdated: Date | null, now: Date): Health {
  if (feed === 'error') return 'down'
  if (feed === 'connecting' || !lastUpdated) return 'stale'
  // The loop polls every 15s; allow a couple of missed beats before amber.
  return now.getTime() - lastUpdated.getTime() < 45_000 ? 'ok' : 'stale'
}

function mongoHealth(state: MongoFeedState): Health {
  if (state === 'down') return 'down'
  if (state === 'fresh') return 'ok'
  return 'stale' // 'connecting' | 'stale'
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[11px] text-[color:var(--muted)]">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${color}`}>{value}</span>
    </span>
  )
}

export function Header({ counts, now, nextPollAt, feed, lastUpdated, mongoState, mongoPulse }: Props) {
  const secs = Math.max(0, Math.round((nextPollAt - now.getTime()) / 1000))

  const board = boardHealth(feed, lastUpdated, now)
  const boardDetail =
    feed === 'error' ? 'down' : lastUpdated ? shortAge(Math.round((now.getTime() - lastUpdated.getTime()) / 1000)) : null
  const boardTitle =
    feed === 'error'
      ? 'OpticOdds board feed (Supabase) — fetch failing'
      : `OpticOdds board feed (Supabase)\n${counts.live} live · ${counts.upcoming} upcoming · ${counts.total} shown`

  const mongo = mongoHealth(mongoState)
  const mAge = mongoPulse?.ageSec ?? null
  // Show last-write age, not a live count — Mongo's `inprogress` status is
  // unreliable (events flip to in-progress and never clear), so a "live" tally
  // would be wildly wrong. Freshness of the newest write is the real signal.
  const mongoDetail = mongoState === 'down' ? 'down' : mAge != null ? shortAge(mAge) : null
  const mongoTitle =
    mongoPulse && mongoPulse.ok
      ? `SwiftBet feed (Mongo)\n${mongoPulse.total} events · ${mongoPulse.prematch} upcoming` +
        (mAge != null ? `\nLast write ${shortAge(mAge)} ago` : '')
      : 'SwiftBet feed (Mongo) — unreachable'

  return (
    <header className="sticky top-0 z-20 border-b border-[color:var(--line-soft)] bg-[color:var(--bg)]/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-8 px-5">
        {/* brand */}
        <div className="flex items-center gap-2.5">
          <Activity className="h-4 w-4 text-[color:var(--total)]" strokeWidth={2.5} />
          <span className="text-[14px] font-semibold tracking-tight text-white">
            Live Events Terminal
          </span>
        </div>

        {/* counts */}
        <div className="hidden items-center gap-5 md:flex">
          <Stat label="Total" value={counts.total} color="text-[color:var(--total)]" />
          <Stat label="Live" value={counts.live} color="text-[color:var(--live)]" />
          <Stat label="Upcoming" value={counts.upcoming} color="text-[color:var(--up)]" />
          <Stat label="Completed" value={counts.completed} color="text-[color:var(--muted)]" />
        </div>

        {/* feed status — two health pulses: OpticOdds board + SwiftBet (Mongo) */}
        <div className="ml-auto flex items-center gap-4 text-[12px] text-[color:var(--muted)]">
          <StatusPulse label="Live feed" health={board} detail={boardDetail} title={boardTitle} />
          <StatusPulse label="Mongo" health={mongo} detail={mongoDetail} title={mongoTitle} />
          <span className="hidden sm:inline">
            Next poll <span className="font-semibold tabular-nums text-gray-300">{secs}s</span>
          </span>
          <span className="font-semibold tabular-nums text-gray-300">{utcClock(now)}</span>
          <span className="font-semibold tabular-nums text-gray-300">
            {melbTime(now.toISOString())} <span className="text-[color:var(--muted-2)]">MEL</span>
          </span>
        </div>
      </div>
    </header>
  )
}
