// In-app catalogue of SWIFT (Mongo gutsy.events) COMPETITIONS, read live from
// /api/swift-search.
//
// This used to load two JSON snapshots from /public that only a local
// `npm run build-mapping` rebuilt. That was the single root cause behind four
// separate mapping bugs — the editor picker couldn't find new competitions, and
// both auto-map buttons silently matched against a week-old world (237
// competitions where Mongo had 313; ZERO events for leagues Mongo had). It also
// meant downloading a 2.3 MB swift-events.json on every page load.
//
// Events are NOT bulk-loaded any more: nothing needs all of them at once, and
// fetching them was what made the file huge. Callers ask for the slice they
// need — listSwiftEventsByCompetition() for a competition, fetchSwiftStatuses()
// for specific ids. `events`/`eventById`/`eventsByCompId` stay on the shape as
// empty collections so existing lookups degrade to a miss rather than a crash;
// every one of them already has a live path or an id fallback.

import { listSwiftCompetitions } from './swiftStatus'

export interface SwiftCompetition {
  id: string
  sport: string | null
  name: string
  n: number // # of events in the snapshot — for sorting popular first
}

export interface SwiftEvent {
  id: string
  cid: string | null
  sport: string | null
  competition: string | null
  name: string | null
  home: string | null
  away: string | null
  start: string | null
  status: string | null
  /**
   * First time we observed the event in `inprogress` — written by
   * /api/swift-status the first time it sees the flip, then preserved. Only
   * present on the live API responses; the static /public snapshot omits it.
   */
  actualStart?: string | null
}

interface Catalog {
  competitions: SwiftCompetition[]
  events: SwiftEvent[]
  byCompId: Map<string, SwiftCompetition>
  eventById: Map<string, SwiftEvent>
  eventsByCompId: Map<string, SwiftEvent[]>
}

let cache: Catalog | null = null
let inflight: Promise<Catalog> | null = null

async function load(): Promise<Catalog> {
  const competitions = await listSwiftCompetitions()
  const byCompId = new Map(competitions.map((c) => [c.id, c]))
  return {
    competitions,
    events: [],
    byCompId,
    eventById: new Map(),
    eventsByCompId: new Map(),
  }
}

export async function getSwiftCatalog(): Promise<Catalog> {
  if (cache) return cache
  if (!inflight) inflight = load().then((r) => (cache = r))
  return inflight
}
