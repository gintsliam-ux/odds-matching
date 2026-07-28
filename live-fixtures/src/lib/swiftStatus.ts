// Live SWIFT status fetcher. The /public snapshot is built once and goes stale
// almost immediately for the `status` field — this calls /api/swift-status
// (Vercel function in prod, dev middleware locally) to read fresh data
// straight from Mongo. Endpoint returns the full SwiftEvent shape so the
// detail page can use it as a fallback when the snapshot is missing an event.

import type { SwiftEvent } from './swiftCatalog'

/** Public swiftbet.com.au page for a sports event id. */
export function swiftEventUrl(id: string): string {
  return `https://swiftbet.com.au/sports/event/${id}`
}

/**
 * POST a batch of swift event ids; the server returns whatever it could find
 * in gutsy.events. Missing ids are simply absent from the result.
 */
export async function fetchSwiftStatuses(ids: string[]): Promise<SwiftEvent[]> {
  if (ids.length === 0) return []
  const res = await fetch('/api/swift-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) throw new Error(`swift-status ${res.status}`)
  const json = (await res.json()) as { events: SwiftEvent[] }
  return json.events ?? []
}

/** Convenience: live-fetch a single SWIFT event by id. */
export async function fetchSwiftEvent(id: string): Promise<SwiftEvent | null> {
  const list = await fetchSwiftStatuses([id])
  return list[0] ?? null
}

import type { SwiftCompetition } from './swiftCatalog'

/**
 * Live SWIFT picker search. Hits /api/swift-search and returns the same shape
 * as the cached snapshot (`SwiftEvent` / `SwiftCompetition`) so the
 * MappingEditor can merge live results in without translation.
 */
/**
 * Every SWIFT event in a competition, straight from Mongo.
 *
 * The drill's auto-map used to pool candidates from the /public catalogue
 * snapshot, which only a local `npm run build-mapping` rebuilds — it held ZERO
 * events for Argentina Liga Profesional while Mongo had 8, so auto-map reported
 * "No SwiftBet events available for this tournament" and matched nothing.
 */
export async function listSwiftEventsByCompetition(
  competitionId: string,
  limit = 200,
): Promise<SwiftEvent[]> {
  const res = await fetch('/api/swift-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Empty q + competitionId is the endpoint's list mode.
    body: JSON.stringify({ q: '', kind: 'events', competitionId, limit }),
  })
  if (!res.ok) throw new Error(`swift-search ${res.status}`)
  const json = (await res.json()) as { events: SwiftEvent[] }
  return json.events ?? []
}

export async function searchSwiftEvents(args: {
  q: string
  sport?: string | null // SWIFT-style ("Basketball")
  competitionId?: string | null
  limit?: number
  signal?: AbortSignal
}): Promise<SwiftEvent[]> {
  if (args.q.trim().length < 2) return []
  const res = await fetch('/api/swift-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: args.q,
      kind: 'events',
      sport: args.sport ?? null,
      competitionId: args.competitionId ?? null,
      limit: args.limit ?? 50,
    }),
    signal: args.signal,
  })
  if (!res.ok) throw new Error(`swift-search ${res.status}`)
  const json = (await res.json()) as { events: SwiftEvent[] }
  return json.events ?? []
}

/** Every SWIFT competition, live. The tournament-level auto-map matched against
 *  the /public snapshot (237 competitions) while Mongo has 313, so 76 were
 *  invisible to it and their tournaments could never be paired. */
export async function listSwiftCompetitions(limit = 500): Promise<SwiftCompetition[]> {
  const res = await fetch('/api/swift-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: '', kind: 'competitions', limit }),
  })
  if (!res.ok) throw new Error(`swift-search ${res.status}`)
  const json = (await res.json()) as { competitions: SwiftCompetition[] }
  return json.competitions ?? []
}

export async function searchSwiftCompetitions(args: {
  q: string
  sport?: string | null
  limit?: number
  signal?: AbortSignal
}): Promise<SwiftCompetition[]> {
  if (args.q.trim().length < 2) return []
  const res = await fetch('/api/swift-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: args.q,
      kind: 'competitions',
      sport: args.sport ?? null,
      limit: args.limit ?? 50,
    }),
    signal: args.signal,
  })
  if (!res.ok) throw new Error(`swift-search ${res.status}`)
  const json = (await res.json()) as { competitions: SwiftCompetition[] }
  return json.competitions ?? []
}
