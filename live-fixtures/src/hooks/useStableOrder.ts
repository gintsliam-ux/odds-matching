import { useMemo } from 'react'
import type { Fixture } from '../lib/types'

// Status priority on the all-statuses board: upcoming events surface at the
// top (you want to see what's coming), then live (in-play), then completed
// (most recently finished first within the bucket).
const STATUS_PRIORITY: Record<Fixture['status'], number> = {
  upcoming: 0,
  live: 1,
  completed: 2,
}

/**
 * Deterministic display order for the live board: upcoming → live →
 * completed; within each bucket sorted by start time (ascending for
 * upcoming/live so soonest is first; descending for completed so the most
 * recently finished is first). Fully derived from the fixture data, so the
 * order is stable across polls without needing a session-local seq map.
 */
export function useStableOrder(fixtures: Fixture[]): Fixture[] {
  return useMemo(() => {
    return [...fixtures].sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 99
      const pb = STATUS_PRIORITY[b.status] ?? 99
      if (pa !== pb) return pa - pb
      const ta = Date.parse(a.startTime)
      const tb = Date.parse(b.startTime)
      if (a.status === 'completed') return tb - ta // most recent first
      return ta - tb // soonest first for upcoming + live
    })
  }, [fixtures])
}
