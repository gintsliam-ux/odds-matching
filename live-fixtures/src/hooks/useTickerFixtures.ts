import { useCallback, useEffect, useRef, useState } from 'react'
import { pollWithVisibility } from '../lib/poll'
import { fetchTickerFixtures } from '../lib/dataSource'
import type { Fixture } from '../lib/types'

/**
 * The ticker's own feed, independent of the board's.
 *
 * The strip shows ~100 events and the board carries ~18,000, so sharing one
 * fetch meant the ticker was blank for as long as the board took — the slowest
 * thing on the page gating the fastest. Two feeds cost one extra small query
 * and let the strip paint almost immediately.
 */
const POLL_MS = 15_000
const HIDDEN_POLL_MS = 5 * 60_000

export function useTickerFixtures(): { fixtures: Fixture[]; loading: boolean } {
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const rows = await fetchTickerFixtures()
      if (alive.current) setFixtures(rows)
    } catch {
      // Leave the last good strip up. A failed poll should not blank a ticker
      // that was correct fifteen seconds ago.
    } finally {
      inFlight.current = false
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    const stop = pollWithVisibility(load, POLL_MS, HIDDEN_POLL_MS)
    return () => {
      alive.current = false
      stop()
    }
  }, [load])

  return { fixtures, loading }
}
