import { useEffect, useState } from 'react'
import { fetchCompetitionMappings, type CompetitionMapping } from '../lib/mappingData'
import { getSwiftCatalog, type SwiftCompetition } from '../lib/swiftCatalog'
import { useSportUniverse } from './useSportUniverse'

export interface SwiftGap {
  /** SwiftBet competition that no OPTIC tournament points at. */
  id: string
  name: string
  sport: string | null
  /** Approximate event count from the snapshot. */
  n: number
}

export interface OpticGap {
  rawSport: string
  rawLeague: string
  rawTournament: string // tennis season_type; '' for everything else
  sport: string
  league: string
  /** OPTIC tournament whose competition_mapping row is missing entirely. */
  tournamentKey: string
}

interface Coverage {
  swiftUnmapped: SwiftGap[]
  opticUnmapped: OpticGap[]
  loading: boolean
}

const EXCLUDE_LEAGUES = new Set(['itf_men', 'itf_women', 'utr_men', 'utr_women'])

/**
 * Coverage gaps between OPTIC and SWIFT:
 *   - SwiftBet competitions with no matching `competition_mapping` row pointing
 *     at them — events on SwiftBet we can't surface on the OPTIC side.
 *   - OPTIC (sport, league, [tournament]) buckets with no `competition_mapping`
 *     row at all — fixtures we can't pair with a SwiftBet event.
 *
 * Refreshed every 5 min — these don't change in real time (manual edits go
 * through fetchCompetitionMappings cache invalidation elsewhere).
 */
export function useCoverageGaps(): Coverage {
  const universe = useSportUniverse()
  const [comps, setComps] = useState<SwiftCompetition[]>([])
  const [maps, setMaps] = useState<CompetitionMapping[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const load = () => {
      Promise.all([getSwiftCatalog(), fetchCompetitionMappings()])
        .then(([cat, m]) => {
          if (!alive) return
          setComps(cat.competitions)
          setMaps(m)
        })
        .catch(() => {/* keep previous */})
        .finally(() => alive && setLoading(false))
    }
    load()
    const id = setInterval(load, 5 * 60_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // SWIFT side: any competition whose id appears as a `gutsy_competition_id`
  // on some mapping row is mapped. Anything else is a gap.
  const mappedSwiftIds = new Set<string>()
  for (const m of maps) {
    if (m.swift_competition_id) mappedSwiftIds.add(m.swift_competition_id)
  }
  // SwiftBet's futures/outrights markets (NFL 2027 Futures, NBA 2025/26
  // Futures, World Cup 2026 Futures, 2026 State Of Origin Series Outrights,
  // …) never have an OPTIC equivalent — OPTIC tracks fixtures, not futures.
  // Hide them from the unmapped list so the count reflects real gaps.
  const FUTURES_RE = /\b(futures|outrights)\b/i
  const swiftUnmapped: SwiftGap[] = comps
    .filter((c) => !mappedSwiftIds.has(c.id))
    .filter((c) => !FUTURES_RE.test(c.name))
    .map((c) => ({ id: c.id, name: c.name, sport: c.sport, n: c.n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))

  // OPTIC side: derive every (sport, league) from the universe. A bucket is
  // covered when at least one mapping row exists for it (with or without a
  // SWIFT id — `''` is the sticky-unmapped sentinel and still counts as
  // "user has touched this"). Anything else is a gap.
  const touched = new Set<string>()
  for (const m of maps) {
    touched.add(`${m.optic_sport}|${m.optic_league}|${m.optic_tournament}`)
  }
  const opticUnmapped: OpticGap[] = []
  for (const [sport, leagues] of universe.leaguesBySport) {
    if (sport === 'tennis') continue // tennis is per-tournament, not per-league
    for (const league of leagues) {
      const rs = universe.rawSport.get(sport) ?? sport
      const rl = universe.rawLeague.get(`${sport}|${league}`) ?? league
      if (EXCLUDE_LEAGUES.has(rl)) continue
      const k = `${rs}|${rl}|`
      if (touched.has(k)) continue
      opticUnmapped.push({
        rawSport: rs,
        rawLeague: rl,
        rawTournament: '',
        sport,
        league,
        tournamentKey: `${sport}||${league}||`,
      })
    }
  }
  opticUnmapped.sort((a, b) => a.sport.localeCompare(b.sport) || a.league.localeCompare(b.league))

  return { swiftUnmapped, opticUnmapped, loading: loading && comps.length === 0 }
}
