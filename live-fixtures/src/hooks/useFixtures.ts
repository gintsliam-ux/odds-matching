import { useCallback, useEffect, useRef, useState } from 'react'
import { pollWithVisibility } from '../lib/poll'
import type { Fixture } from '../lib/types'
import { fetchFixtures } from '../lib/dataSource'

export type FeedState = 'connecting' | 'live' | 'error'

interface UseFixtures {
  fixtures: Fixture[]
  feed: FeedState
  lastUpdated: Date | null
  nextPollAt: number
  error: string | null
  refresh: () => void
}

const POLL_MS = 15_000
/**
 * Cadence while the tab is hidden.
 *
 * The board window is a day either side, which is ~490 fixtures and ~560 KB a
 * poll against ~115 KB before. At 15s that is fine while someone is watching
 * and pure waste when nobody is — same trade already made for the bet passes.
 */
const HIDDEN_POLL_MS = 5 * 60_000

export function useFixtures(): UseFixtures {
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [feed, setFeed] = useState<FeedState>('connecting')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [nextPollAt, setNextPollAt] = useState<number>(() => Date.now() + POLL_MS)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const data = await fetchFixtures()
      if (!alive.current) return
      setFixtures(data)
      setFeed('live')
      setError(null)
      setLastUpdated(new Date())
    } catch (e) {
      if (!alive.current) return
      setFeed('error')
      setError(e instanceof Error ? e.message : 'Feed error')
    } finally {
      // Report the delay actually in force, or the header's countdown hits 0
      // and sits there for the rest of a hidden-tab interval.
      if (alive.current) {
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        setNextPollAt(Date.now() + (hidden ? HIDDEN_POLL_MS : POLL_MS))
      }
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

  return { fixtures, feed, lastUpdated, nextPollAt, error, refresh: load }
}
