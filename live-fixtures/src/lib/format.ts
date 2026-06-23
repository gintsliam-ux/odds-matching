import type { Fixture } from './types'

/** "13:38" — kickoff time in UTC, HH:MM. */
export function kickoffLabel(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** "15:07 UTC" — current wall clock. */
export function utcClock(now: Date): string {
  return `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`
}

const MELB_TZ = 'Australia/Melbourne'

function melbParts(iso: string | null): Record<string, string> | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: MELB_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value
      return acc
    }, {})
}

/** Melbourne kickoff time, "09:30" (auto AEST/AEDT). Used on the card. */
export function melbTime(iso: string | null): string {
  const p = melbParts(iso)
  return p ? `${p.hour}:${p.minute}` : '—'
}

/** Full Melbourne datetime, "2026-05-27 09:30 MEL". Used in the detail view. */
export function melbDateTime(iso: string | null): string {
  const p = melbParts(iso)
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} MEL` : '—'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Jun 7 15:00" in Melbourne. Compact form for cramped table cells. */
export function melbDateTimeShort(iso: string | null): string {
  const p = melbParts(iso)
  if (!p) return '—'
  const mon = MONTHS[Number(p.month) - 1]
  return `${mon} ${Number(p.day)} ${p.hour}:${p.minute}`
}

/** "Jun 7 05:00" in UTC. */
export function utcDateTimeShort(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const mon = MONTHS[d.getUTCMonth()]
  return `${mon} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/**
 * Live game clock. If the feed provided one, trust it. Otherwise show elapsed
 * MM:SS since kickoff — this re-renders every second so all live cards share
 * the same ticking seconds (matching the terminal feel).
 */
export function liveClock(f: Fixture, now: Date): string {
  if (f.clock) return f.clock
  const elapsedSec = Math.max(0, Math.floor((now.getTime() - new Date(f.startTime).getTime()) / 1000))
  const m = Math.floor(elapsedSec / 60)
  const s = elapsedSec % 60
  return `${pad(m)}:${pad(s)}`
}

/** Countdown to kickoff for upcoming fixtures, e.g. "in 12m" / "in 2h 05m". */
/** How overdue (minutes) a still-upcoming fixture is past its scheduled start —
 *  > a few minutes suggests a possible delay (OPTIC hasn't flipped it live). */
export function overdueMinutes(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000)
}

export function startsInLabel(iso: string, now: Date): string {
  const diffSec = Math.floor((new Date(iso).getTime() - now.getTime()) / 1000)
  if (diffSec <= 0) return 'starting'
  const d = Math.floor(diffSec / 86_400)
  const h = Math.floor((diffSec % 86_400) / 3600)
  const m = Math.floor((diffSec % 3600) / 60)
  // ≥1d: drop minute precision (noise at this distance), show "in 3d 4h".
  if (d > 0) return h > 0 ? `in ${d}d ${h}h` : `in ${d}d`
  if (h > 0) return `in ${h}h ${pad(m)}m`
  if (m > 0) return `in ${m}m`
  return `in ${diffSec}s`
}

/** Decimal odds → "2.56". Em dash when missing. */
export function fmtOdds(v: number | null): string {
  return v == null ? '—' : v.toFixed(2)
}

/** "—" tolerant generic number. */
export function fmtNum(v: number | null): string {
  return v == null ? '—' : String(v)
}

/** Signed handicap line, e.g. "-2.5" / "+1.5". */
export function fmtLine(v: number | null): string {
  if (v == null) return '—'
  return v > 0 ? `+${v}` : String(v)
}

/** "2026-05-28 09:30 UTC" — full datetime for the detail view. */
export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** "12s ago" / "3m ago" / "2h ago" relative to now. */
export function agoLabel(iso: string | null, now: Date): string {
  if (!iso) return '—'
  const sec = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
