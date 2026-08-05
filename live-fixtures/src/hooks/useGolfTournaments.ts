import { useEffect, useState } from 'react'
import { fetchGolfTournaments, isGolfTournamentActive, type GolfTournament } from '../lib/golfOutrights'

/**
 * Golf tournaments, shared across the sidebar, the board and the mapping page.
 *
 * Module-level cache because three separate components want the same list on
 * first paint and the underlying table is a full scan of `golf_outrights` —
 * without it the sidebar and the board would each pay for it independently on
 * every navigation.
 */
let cache: GolfTournament[] | null = null
let inflight: Promise<GolfTournament[]> | null = null

function load(): Promise<GolfTournament[]> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchGolfTournaments()
      .then((rows) => {
        cache = rows
        return rows
      })
      .catch(() => {
        // Golf is additive everywhere it appears — a failure must degrade to
        // "no golf", never to a broken sidebar or an empty board for a sport
        // that does have fixtures.
        return []
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export function useGolfTournaments(): { tournaments: GolfTournament[]; active: GolfTournament[]; loading: boolean } {
  const [tournaments, setTournaments] = useState<GolfTournament[]>(cache ?? [])
  const [loading, setLoading] = useState(cache === null)
  useEffect(() => {
    let alive = true
    load().then((rows) => {
      if (!alive) return
      setTournaments(rows)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])
  return { tournaments, active: tournaments.filter((t) => isGolfTournamentActive(t)), loading }
}
