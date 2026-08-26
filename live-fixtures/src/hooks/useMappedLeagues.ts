import { useEffect, useState } from 'react'
import { fetchCompetitionMappings } from '../lib/mappingData'

/**
 * Set of RAW league slugs that have a competition mapping on at least one
 * brand (SwiftBet or mybet). Used to restrict the board and sidebar to mapped
 * leagues only. Keyed by league name — auto-mapped rows store the feed's raw
 * sport ("rugby") while the UI shows the reclassified one ("rugby league"), so a
 * sport-qualified key would miss the split rugby buckets; league slugs are
 * region-prefixed and effectively unique.
 */
export function useMappedLeagues(): Set<string> {
  const [leagues, setLeagues] = useState<Set<string>>(new Set())
  useEffect(() => {
    let alive = true
    Promise.all([fetchCompetitionMappings(), fetchCompetitionMappings('mybet')])
      .then(([sw, mb]) => {
        if (!alive) return
        const s = new Set<string>()
        // RAW slugs. `optic_league` is prettified on read for display —
        // "Aussierules Afl" — and Fixture.rawLeague holds "aussierules_afl",
        // so joining on the prettified form matched nothing and the board
        // filtered every fixture away.
        for (const c of [...sw, ...mb]) if (c.swift_competition) s.add(c.optic_league_raw)
        setLeagues(s)
      })
      .catch(() => {/* leave empty; callers fall back to showing everything */})
    return () => {
      alive = false
    }
  }, [])
  return leagues
}
