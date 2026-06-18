// Live SWIFT status fetcher. The /public snapshot is built once and goes stale
// almost immediately for the `status` field — this calls /api/swift-status
// (Vercel function in prod, dev middleware locally) to read fresh data
// straight from Mongo. Endpoint returns the full SwiftEvent shape so the
// detail page can use it as a fallback when the snapshot is missing an event.

import type { SwiftEvent } from './swiftCatalog'

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
