// In-app catalogue of SWIFT (Mongo gutsy.events) competitions + events,
// loaded once from JSON snapshots in /public/ that `npm run build-mapping`
// writes. Used by the EditMappingModal to let the user pick a manual mapping.

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
  const [cRes, eRes] = await Promise.all([
    fetch('/swift-competitions.json'),
    fetch('/swift-events.json'),
  ])
  if (!cRes.ok || !eRes.ok) {
    throw new Error(
      `SWIFT catalogue missing — run "npm run build-mapping" to generate /swift-competitions.json + /swift-events.json`,
    )
  }
  const competitions: SwiftCompetition[] = await cRes.json()
  const events: SwiftEvent[] = await eRes.json()
  const byCompId = new Map(competitions.map((c) => [c.id, c]))
  const eventById = new Map(events.map((e) => [e.id, e]))
  const eventsByCompId = new Map<string, SwiftEvent[]>()
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

export async function getSwiftCatalog(): Promise<Catalog> {
  if (cache) return cache
  if (!inflight) inflight = load().then((r) => (cache = r))
  return inflight
}
