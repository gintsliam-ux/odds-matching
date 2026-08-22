import { useSyncExternalStore } from 'react'
import { sportGroupKey } from './sports'

// Saved custom filters ("favourites") — a named union of sports and/or leagues,
// e.g. "US Sports" = leagues [MLB, NBA, NHL, NFL]. Persisted in localStorage
// (personal, per-browser — the app has no auth). A tiny external store keeps the
// sidebar, the editor, and the board view in sync.

export interface Favourite {
  id: string
  name: string
  sports: string[] // matches Fixture.sport
  leagues: string[] // matches Fixture.league
}

const KEY = 'lf:favourites:v1'
let favourites: Favourite[] = read()
const listeners = new Set<() => void>()

function read(): Favourite[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function commit(next: Favourite[]) {
  favourites = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage full / unavailable — keep in-memory */
  }
  listeners.forEach((l) => l())
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function getFavourites(): Favourite[] {
  return favourites
}

export function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function addFavourite(f: Omit<Favourite, 'id'>): Favourite {
  const created = { ...f, id: uid() }
  commit([...favourites, created])
  return created
}

export function updateFavourite(id: string, patch: Partial<Omit<Favourite, 'id'>>) {
  commit(favourites.map((f) => (f.id === id ? { ...f, ...patch } : f)))
}

export function removeFavourite(id: string) {
  commit(favourites.filter((f) => f.id !== id))
}

/** Does a fixture (by sport + league) belong to this favourite? Union semantics. */
/**
 * Does a fixture fall inside a saved favourite?
 *
 * Sports compare by GROUP, not by the exact stored string. OPTIC files some
 * competitions under a sport named after the league, so "Australian Rules" and
 * "afl" are the same sport — a favourite saved as one would otherwise miss
 * every fixture filed under the other. Comparing groups also keeps favourites
 * saved before this change working: the raw value they hold resolves to the
 * same group as the value the editor writes now.
 */
export function favouriteMatches(f: Favourite, sport: string, league: string): boolean {
  if (f.leagues.includes(league)) return true
  if (f.sports.includes(sport)) return true
  const group = sportGroupKey(sport)
  return f.sports.some((s) => sportGroupKey(s) === group)
}

export function useFavourites(): Favourite[] {
  return useSyncExternalStore(subscribe, getFavourites, getFavourites)
}
