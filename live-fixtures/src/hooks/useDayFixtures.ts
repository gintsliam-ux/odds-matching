import { useEffect, useState } from 'react'
import { fetchFixturesByDate } from '../lib/dataSource'
import type { Fixture } from '../lib/types'

interface DayState {
  fixtures: Fixture[]
  loading: boolean
  error: string | null
}

// Fetches one Melbourne day's UPCOMING/COMPLETED fixtures. Re-fetches when the
// date or status changes. Pass date=null to disable (non-date views).
export function useDayFixtures(
  date: string | null,
  status: 'upcoming' | 'completed',
): DayState {
  const [state, setState] = useState<DayState>({ fixtures: [], loading: !!date, error: null })

  useEffect(() => {
    if (!date) {
      setState({ fixtures: [], loading: false, error: null })
      return
    }
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fetchFixturesByDate(date, status)
      .then((fx) => alive && setState({ fixtures: fx, loading: false, error: null }))
      .catch((e) => alive && setState({ fixtures: [], loading: false, error: String(e) }))
    return () => {
      alive = false
    }
  }, [date, status])

  return state
}
