// In-app catalogue of mybet (Mongo gutsy.mybet_events) competitions + events,
// loaded once from JSON snapshots in /public/ that build-mybet-mapping writes.
// Mirror of swiftCatalog.ts; used by the mapping editor's mybet picker and as a
// static fallback on the detail page before the live /api/mybet-status responds.

export interface MybetCompetition {
  id: string
  sport: string | null
  name: string
  n: number
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
  const [cRes, eRes] = await Promise.all([
    fetch('/mybet-competitions.json'),
    fetch('/mybet-events.json'),
  ])
  if (!cRes.ok || !eRes.ok) {
    throw new Error(
      'mybet catalogue missing — run "node scripts/build-mybet-mapping.mjs" to generate /mybet-competitions.json + /mybet-events.json',
    )
  }
  const competitions: MybetCompetition[] = await cRes.json()
  const events: MybetEvent[] = await eRes.json()
  const byCompId = new Map(competitions.map((c) => [c.id, c]))
  const eventById = new Map(events.map((e) => [e.id, e]))
  const eventsByCompId = new Map<string, MybetEvent[]>()
  for (const e of events) {
    if (!e.cid) continue
    let list = eventsByCompId.get(e.cid)
    if (!list) eventsByCompId.set(e.cid, (list = []))
    list.push(e)
  }
  for (const list of eventsByCompId.values()) {
    list.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
  }
  return { competitions, events, byCompId, eventById, eventsByCompId }
}

export async function getMybetCatalog(): Promise<Catalog> {
  if (cache) return cache
  if (!inflight) inflight = load().then((r) => (cache = r))
  return inflight
}
