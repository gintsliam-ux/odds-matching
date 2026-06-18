import { useSyncExternalStore } from 'react'

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
export function favouriteMatches(f: Favourite, sport: string, league: string): boolean {
  return f.sports.includes(sport) || f.leagues.includes(league)
}

export function useFavourites(): Favourite[] {
  return useSyncExternalStore(subscribe, getFavourites, getFavourites)
}
