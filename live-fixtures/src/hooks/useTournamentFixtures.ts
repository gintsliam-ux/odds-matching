import { useEffect, useState } from 'react'
import { fetchFixturesByTournament } from '../lib/dataSource'
import type { Fixture } from '../lib/types'

interface State {
  fixtures: Fixture[]
  loading: boolean
  error: string | null
}

// Loads every fixture for a tournament (raw sport+league, optionally raw
// season_type for tennis). Used by the Mapping drill-down so it can show LIVE /
// UPCOMING / COMPLETED tabs over the full set, not just the live polling window.
export function useTournamentFixtures(
  rawSport: string | null,
  rawLeague: string | null,
  rawSeasonType: string | null,
): State {
  const [state, setState] = useState<State>({ fixtures: [], loading: !!(rawSport && rawLeague), error: null })

  useEffect(() => {
    if (!rawSport || !rawLeague) {
      setState({ fixtures: [], loading: false, error: null })
      return
    }
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fetchFixturesByTournament(rawSport, rawLeague, rawSeasonType || null)
      .then((fx) => alive && setState({ fixtures: fx, loading: false, error: null }))
      .catch((e) => alive && setState({ fixtures: [], loading: false, error: String(e) }))
    return () => {
      alive = false
    }
  }, [rawSport, rawLeague, rawSeasonType])

  return state
}
