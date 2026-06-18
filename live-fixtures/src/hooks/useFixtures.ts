import { useCallback, useEffect, useRef, useState } from 'react'
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
      if (alive.current) setNextPollAt(Date.now() + POLL_MS)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [load])

  return { fixtures, feed, lastUpdated, nextPollAt, error, refresh: load }
}
