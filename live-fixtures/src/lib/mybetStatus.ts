// Live mybet status fetcher — mirror of swiftStatus.ts. Reads fresh state from
// gutsy.mybet_events via /api/mybet-status (the snapshot goes stale for the
// open/closed flag). Returns each event with its `suspendAt` (market close) and
// an `open` flag (now < suspendAt).

export interface MybetLiveEvent {
  id: string
  sport: string | null
  competition: string | null
  name: string | null
  home: string | null
  away: string | null
  start: string | null
  suspendAt: string | null
  lastSeenAt: string | null
  open: boolean
  status: 'open' | 'closed'
}

// mybet's public event page is /odds/<sportAbbr>/<eventId>/. The abbreviation is
// mybet-specific per sport (not a simple truncation — "Rugby League"→rgle,
// "Australian Rules"→afl), so it's a lookup keyed by the mybet sport name.
// Every value below was confirmed against the live site (a wrong abbr 404s).
const MYBET_SPORT_ABBR: Record<string, string> = {
  'australian rules': 'afl',
  'rugby league': 'rgle',
  'rugby union': 'rgun', // inferred (parallels rgle); no data event to confirm
  soccer: 'socc',
  baseball: 'base',
  tennis: 'tenn',
  basketball: 'bask',
  cricket: 'cric',
  boxing: 'boxi',
  'mixed martial arts': 'mma',
  golf: 'golf',
  'motor racing': 'moto',
  snooker: 'snoo',
  cycling: 'cycl',
  gridiron: 'grid',
  esports: 'espo',
  // OPTIC sport slugs (notifications pass these prettified OPTIC sports, not the
  // mybet sport name) → same category abbreviation.
  afl: 'afl',
  nrl: 'rgle',
  mlb: 'base',
  kbo: 'base',
  npb: 'base',
  nba: 'bask',
  wnba: 'bask',
  ucl: 'socc',
  ufc: 'mma',
  motorsport: 'moto',
  amfootball: 'grid',
  'american football': 'grid',
}

/** Public mybet page for an event. Needs the mybet sport to pick the URL's
 *  category abbreviation; falls back to the site root when the sport is unknown
 *  (a guessed abbr would 404). */
export function mybetEventUrl(id: string, sport?: string | null): string {
  const abbr = sport ? MYBET_SPORT_ABBR[sport.trim().toLowerCase()] : null
  return abbr ? `https://www.mybet.com.au/odds/${abbr}/${id}/` : 'https://www.mybet.com.au/'
}

export async function fetchMybetStatuses(ids: string[]): Promise<MybetLiveEvent[]> {
  if (ids.length === 0) return []
  const res = await fetch('/api/mybet-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) throw new Error(`mybet-status ${res.status}`)
  const json = (await res.json()) as { events: MybetLiveEvent[] }
  return json.events ?? []
}

export async function fetchMybetEvent(id: string): Promise<MybetLiveEvent | null> {
  const list = await fetchMybetStatuses([id])
  return list[0] ?? null
}

import type { MybetCompetition, MybetEvent } from './mybetCatalog'

/** Live mybet picker search — mirror of searchSwiftEvents. Returns the same
 *  shape as the cached snapshot so the MappingEditor can merge results in. */
export async function searchMybetEvents(args: {
  q: string
  competitionId?: string | null
  limit?: number
  signal?: AbortSignal
}): Promise<MybetEvent[]> {
  if (args.q.trim().length < 2) return []
  const res = await fetch('/api/mybet-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: args.q, kind: 'events', competitionId: args.competitionId ?? null, limit: args.limit ?? 50 }),
    signal: args.signal,
  })
  if (!res.ok) throw new Error(`mybet-search ${res.status}`)
  const json = (await res.json()) as { events: MybetEvent[] }
  return json.events ?? []
}

export async function searchMybetCompetitions(args: {
  q: string
  limit?: number
  signal?: AbortSignal
}): Promise<MybetCompetition[]> {
  if (args.q.trim().length < 2) return []
  const res = await fetch('/api/mybet-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: args.q, kind: 'competitions', limit: args.limit ?? 50 }),
    signal: args.signal,
  })
  if (!res.ok) throw new Error(`mybet-search ${res.status}`)
  const json = (await res.json()) as { competitions: MybetCompetition[] }
  return json.competitions ?? []
}
