import { useEffect, useState } from 'react'
import { fetchCompetitionMappings } from '../lib/mappingData'

/**
 * Set of prettified league names that have a competition mapping on at least one
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
        for (const c of [...sw, ...mb]) if (c.swift_competition) s.add(c.optic_league)
        setLeagues(s)
      })
      .catch(() => {/* leave empty; callers fall back to showing everything */})
    return () => {
      alive = false
    }
  }, [])
  return leagues
}
