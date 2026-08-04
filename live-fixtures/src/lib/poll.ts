/**
 * Repeating timer that backs off while the browser tab is hidden.
 *
 * The heavy polls here read bets out of Mongo, and that cluster is shared with
 * the scrapers. A terminal parked in a background tab was making ~1.5 requests
 * a second all night for a page nobody was looking at. Backing off rather than
 * stopping keeps the alerts working — a market left open is still caught while
 * you are in another tab, just within minutes instead of seconds.
 *
 * Coming back to the tab runs `tick` immediately, so returning to the terminal
 * never means staring at data that is minutes stale while a long hidden-tab
 * delay finishes counting down.
 *
 * Chrome already throttles background timers to roughly once a minute, but only
 * after a few minutes backgrounded, and never to zero — this makes the
 * behaviour explicit and immediate instead of leaving it to the browser.
 *
 * @param tick      called on each fire; must be safe to call concurrently with
 *                  itself (the callers hold their own in-flight guard)
 * @param visibleMs interval while the tab is in the foreground
 * @param hiddenMs  interval while it is hidden
 * @returns cleanup — clears the timer and drops the listener
 */
export function pollWithVisibility(tick: () => void, visibleMs: number, hiddenMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const delay = () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden' ? hiddenMs : visibleMs

  const schedule = () => {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(run, delay())
  }

  // setTimeout rather than setInterval: the delay has to be re-read each time,
  // because it changes when the tab is shown or hidden.
  const run = () => {
    if (stopped) return
    tick()
    schedule()
  }

  const onVisibilityChange = () => {
    if (stopped) return
    if (document.visibilityState === 'visible') run()
    else schedule() // re-arm at the slower cadence
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  schedule()

  return () => {
    stopped = true
    clearTimeout(timer)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}
