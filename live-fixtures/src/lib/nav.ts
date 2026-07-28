import type { NavigateFunction } from 'react-router-dom'

/**
 * Go back the way the BROWSER's back button would, falling back to a sensible
 * URL when there's nowhere to go back to.
 *
 * In-app "back" affordances used to `navigate(someUrl)`, which PUSHES a new
 * history entry. That looks like going back but isn't: the history stack keeps
 * growing, the browser can't restore anything it associates with the previous
 * entry, and any state that lived only in that entry (filters, scroll, the
 * board's date) is rebuilt from scratch or lost. Actually going back returns to
 * the exact entry you came from.
 *
 * The fallback matters for deep links and fresh tabs — react-router marks the
 * first entry it owns with `history.state.idx === 0`, and calling back there
 * would leave the site entirely.
 */
export function backOr(navigate: NavigateFunction, fallback: string): void {
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  if (idx > 0) navigate(-1)
  else navigate(fallback)
}
