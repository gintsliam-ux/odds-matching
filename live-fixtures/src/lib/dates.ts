// Date helpers for the COMPLETED / UPCOMING day browser. Days are Melbourne
// calendar days (the app's reference timezone), converted to UTC ranges for the
// scheduled_start query. DST (AEST/AEDT) handled via Intl.

const MELB_TZ = 'Australia/Melbourne'

/** YYYY-MM-DD of a Date in Melbourne (en-CA formats as ISO date). */
export function melbDateOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MELB_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export function melbToday(): string {
  return melbDateOf(new Date())
}

/** Shift a YYYY-MM-DD string by n days (calendar math, tz-independent). */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}

/** "TODAY" / "YESTERDAY" / "TOMORROW" / "WED 28" relative to today. */
export function dayLabel(dateStr: string, today: string): string {
  if (dateStr === today) return 'TODAY'
  if (dateStr === addDays(today, -1)) return 'YESTERDAY'
  if (dateStr === addDays(today, 1)) return 'TOMORROW'
  const [y, m, d] = dateStr.split('-').map(Number)
  const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${wd} ${d}`
}

/** Offset of Melbourne from UTC, in ms, at a given instant. */
function melbOffsetMs(at: Date): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: MELB_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {})
  let h = +p.hour
  if (h === 24) h = 0
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second)
  return asIfUtc - at.getTime()
}

/** A Melbourne calendar day → [startUtcISO, endUtcISO) for scheduled_start. */
export function melbDayRangeUtc(dateStr: string): [string, string] {
  const [y, m, d] = dateStr.split('-').map(Number)
  const startGuess = Date.UTC(y, m - 1, d, 0, 0, 0)
  const endGuess = Date.UTC(y, m - 1, d + 1, 0, 0, 0)
  const start = startGuess - melbOffsetMs(new Date(startGuess))
  const end = endGuess - melbOffsetMs(new Date(endGuess))
  return [new Date(start).toISOString(), new Date(end).toISOString()]
}
