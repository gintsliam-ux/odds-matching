import { useEffect } from 'react'

// How often the open terminal pings the self-trigger. The SERVER throttles the
// actual rebuild to once per ~10 min, so this just needs to be frequent enough
// that a new fixture gets picked up promptly — but not so frequent it spams.
const PING_MS = 3 * 60 * 1000

/**
 * Drives the OPTIC ↔ SWIFT matcher on a ~10-min cadence without a paid cron.
 * Vercel Hobby caps native cron at once/day, so instead the running app pings
 * /api/mapping-tick; the endpoint rebuilds mappings at most once per throttle
 * window (server-side), however many tabs are open. Fire-and-forget — the UI
 * never blocks on it and failures are ignored (the daily cron is the backstop).
 */
export function useMappingTick(): void {
  useEffect(() => {
    let alive = true
    const ping = () => {
      // Don't bother when the tab is hidden — no point triggering work nobody's
      // watching; the next visible tick (or the daily cron) covers it.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      fetch('/api/mapping-tick').catch(() => {})
    }
    // Kick once on mount so a freshly-opened terminal refreshes promptly if the
    // last run is already stale, then settle into the interval.
    if (alive) ping()
    const id = setInterval(ping, PING_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
}
