// In-app catalogue of mybet (Mongo gutsy.mybet_events) COMPETITIONS, read live
// from /api/mybet-search. Mirror of swiftCatalog.ts — see the note there for why
// the /public snapshots were dropped (they carried 83 competitions where Mongo
// has 166, so half were invisible to auto-map, and their basketball events were
// a week stale).
//
// Events are not bulk-loaded; callers ask for the slice they need via
// listMybetEventsBySport() or fetchMybetStatuses().

import { listMybetCompetitions } from './mybetStatus'

export interface MybetCompetition {
  id: string
  sport: string | null
  name: string
  n: number
  /** Disambiguator when the league name alone is ambiguous — mybet has six
   *  different "Primera Division". Taken from the event description, e.g.
   *  "Chilean Primera Division". */
  hint?: string | null
}

export interface MybetEvent {
  id: string
  cid: string | null
  sport: string | null
  competition: string | null
  name: string | null
  home: string | null
  away: string | null
  /** Market-close time (== suspendAt); used as the event's effective start. */
  start: string | null
  suspendAt: string | null
  /** mybet has no live status field in the snapshot — always null here; the
   *  live /api/mybet-status computes an open/closed flag from suspendAt. */
  status: string | null
}

interface Catalog {
  competitions: MybetCompetition[]
  events: MybetEvent[]
  byCompId: Map<string, MybetCompetition>
  eventById: Map<string, MybetEvent>
  eventsByCompId: Map<string, MybetEvent[]>
}

let cache: Catalog | null = null
let inflight: Promise<Catalog> | null = null

async function load(): Promise<Catalog> {
  const competitions = await listMybetCompetitions()
  const byCompId = new Map(competitions.map((c) => [c.id, c]))
  return {
    competitions,
    events: [],
    byCompId,
    eventById: new Map(),
    eventsByCompId: new Map(),
  }
}

export async function getMybetCatalog(): Promise<Catalog> {
  if (cache) return cache
  if (!inflight) inflight = load().then((r) => (cache = r))
  return inflight
}
