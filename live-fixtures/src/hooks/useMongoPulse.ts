import { useEffect, useRef, useState } from 'react'

export interface MongoPulse {
  ok: boolean
  serverNow: string
  newestScrapedAt: string | null
  ageSec: number | null
  live: number
  prematch: number
  postmatch: number
  total: number
  sports: Array<{ name: string; total: number; live: number }>
}

export type MongoFeedState = 'connecting' | 'fresh' | 'stale' | 'down'

interface UseMongoPulse {
  pulse: MongoPulse | null
  state: MongoFeedState
  /** ms since we last successfully read the endpoint — client-side, so it keeps
   *  ticking between polls (the page re-renders every second via useNow). */
  lastOkAt: number | null
}

const POLL_MS = 15_000
// The SWIFT scraper writes in batched runs; a healthy feed lands a fresh
// scraped_at every few minutes. Past these the data is going stale even if
// Mongo itself is still answering.
const FRESH_MAX_SEC = 6 * 60
const STALE_MAX_SEC = 30 * 60

function classify(p: MongoPulse | null): MongoFeedState {
  if (!p || !p.ok) return 'down'
  if (p.ageSec == null) return 'stale'
  if (p.ageSec <= FRESH_MAX_SEC) return 'fresh'
  if (p.ageSec <= STALE_MAX_SEC) return 'stale'
  return 'stale'
}

/** Polls /api/mongo-pulse so the header can show whether the upstream SwiftBet
 *  (Mongo) feed is alive and still receiving new events. Independent of the
 *  Supabase board feed — the two can fail separately. */
export function useMongoPulse(): UseMongoPulse {
  const [pulse, setPulse] = useState<MongoPulse | null>(null)
  const [state, setState] = useState<MongoFeedState>('connecting')
  const [lastOkAt, setLastOkAt] = useState<number | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const load = async () => {
      try {
        const r = await fetch('/api/mongo-pulse')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = (await r.json()) as MongoPulse
        if (!alive.current) return
        if (!data.ok) {
          setState('down')
          return
        }
        setPulse(data)
        setState(classify(data))
        setLastOkAt(Date.now())
      } catch {
        if (!alive.current) return
        setState('down')
      }
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [])

  return { pulse, state, lastOkAt }
}
