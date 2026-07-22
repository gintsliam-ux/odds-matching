// mybet matcher: OpticOdds `live_fixtures` (source) ↔ gutsy.mybet_events (target).
// Sibling to build-mapping.mjs (SwiftBet); both write the same Supabase tables,
// distinguished by `provider` ('mybet' here). Reuses the SwiftBet matcher's pure
// scoring helpers so name/sport logic stays in one place.
//
//   stage 1: competition_mapping  (optic_sport, optic_league) → mybet league
//   stage 2: event_mapping        optic_fixture_id            → mybet event _id
//
// mybet's data shape differs from SwiftBet's in two ways that drive the design:
//   • Most events carry NO league — so competition mapping covers only the
//     subset that does, and event matching does NOT gate on a paired
//     competition. Instead every sport matches by team names + time across the
//     whole sport (the approach build-mapping.mjs uses for tennis).
//   • There is no status field. `suspendAt` (== `outcomeAt`) is the market
//     CLOSING time; we use it as the event's start for time-window matching.
//
// Run with:  node scripts/build-mybet-mapping.mjs
// Imported by the Vercel cron (api/cron/build-mybet-mapping.ts) via runMybetMapping().

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { canonSport, sim, prettyOpticLeague, aliasExpand, EXCLUDE_LEAGUES } from './build-mapping.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = parseEnv(join(HERE, '..', '.env'))
const SUP_URL = env.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUP_KEY = env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const MONGO_URI = env.MONGO_URI ?? process.env.MONGO_URI
const MONGO_DB = env.MONGO_DB ?? process.env.MONGO_DB ?? 'gutsy'
const MYBET_COLL = env.MONGO_MYBET_COLL ?? process.env.MONGO_MYBET_COLL ?? 'mybet_events'
const PROVIDER = 'mybet'

const REST = `${SUP_URL}/rest/v1`
const HDR = { apikey: SUP_KEY, Authorization: `Bearer ${SUP_KEY}` }

// Both name-similarity and start-time gates must pass, same as SwiftBet's event
// matcher. mybet's `suspendAt` sits at/near kickoff, so a 2 h skew tolerates the
// spread across sports without letting a different day's rematch through.
const MIN_EVENT_SIM = 0.4
const MAX_START_SKEW_MS = 120 * 60 * 1000
const MIN_COMP_SIM = 0.4
// Event-evidence competition derivation (Stage 3): this many mapped events must
// land on the same mybet league before we trust it as the tournament mapping.
// mybet's event pool is sparse, so 2 is enough signal.
const MIN_VERIFY = 2

const IS_CLI = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (IS_CLI) main({ writeSnapshot: true }).catch((e) => bail(e))

/** Cron entry — skips the /public snapshot (no writable fs on Vercel). */
export async function runMybetMapping(opts = {}) {
  return main({ writeSnapshot: false, ...opts })
}

async function main(opts = { writeSnapshot: true }) {
  if (!SUP_URL || !SUP_KEY) bail('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  if (!MONGO_URI) bail('Missing MONGO_URI')

  console.log('• Loading OpticOdds live_fixtures…')
  const opticRows = await getAllSupabase(
    'live_fixtures?select=optic_fixture_id,sport,league,season_type,home_team,away_team,scheduled_start',
  )
  console.log(`  ${opticRows.length} fixtures.`)

  console.log('• Loading gutsy.mybet_events from Mongo…')
  const mongo = new MongoClient(MONGO_URI)
  await mongo.connect()
  const raw = await mongo
    .db(MONGO_DB)
    .collection(MYBET_COLL)
    .find(
      {},
      { projection: { _id: 1, sport: 1, league: 1, leagueId: 1, description: 1, match: 1, suspendAt: 1, outcomeAt: 1, lastSeenAt: 1, feedLastUpdated: 1 } },
    )
    .toArray()
  await mongo.close()
  const events = raw.map(normMybet).filter((e) => e.home && e.away)
  console.log(`  ${raw.length} mybet events (${events.length} with both teams).`)

  if (opts.writeSnapshot) writeMybetSnapshots(events)

  // Preserve manual/verified rows exactly like the SwiftBet matcher.
  const compStatus = new Map() // optic key → { hasSticky }
  // Competitions held by a verified/manual mapping — off-limits to AUTO matches
  // (1:1: a competition attaches to only one tournament).
  const stickyCompIds = new Set()
  for (const r of await getAllSupabase(
    'competition_mapping?provider=eq.mybet&select=optic_sport,optic_league,optic_tournament,gutsy_competition_id,source,verified',
  )) {
    const k = `${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`
    if (r.source === 'manual' || r.verified) {
      compStatus.set(k, true)
      if (r.gutsy_competition_id) stickyCompIds.add(String(r.gutsy_competition_id))
    }
  }
  const existingEvent = new Map(
    (await getAllSupabase('event_mapping?provider=eq.mybet&select=optic_fixture_id,source')).map((r) => [
      r.optic_fixture_id,
      r.source,
    ]),
  )

  // ---- Stage 1: competitions (only the mybet events that carry a league) ----
  // Distinct mybet (canonSport → [{name, id}]). id is the numeric leagueId as a
  // string, or the league name when leagueId is absent.
  const mybetCompsBySport = new Map()
  for (const e of events) {
    if (!e.league) continue
    const cs = canonSport(e.sport ?? '')
    const list = mybetCompsBySport.get(cs) ?? []
    const id = e.leagueId ?? e.league
    if (!list.some((x) => x.id === id)) list.push({ sport: e.sport, name: e.league, id })
    mybetCompsBySport.set(cs, list)
  }

  // Group OPTIC by (sport, league) — tennis by season_type like the SwiftBet run.
  const opticTournaments = new Map()
  for (const r of opticRows) {
    if (!r.sport || !r.league) continue
    if (EXCLUDE_LEAGUES.has(r.league)) continue
    const isTennis = r.sport.toLowerCase() === 'tennis'
    const tournament = isTennis ? (r.season_type ?? '') : ''
    if (isTennis && !tournament) continue
    const k = `${r.sport}|${r.league}|${tournament}`
    if (!opticTournaments.has(k)) opticTournaments.set(k, { optic_sport: r.sport, optic_league: r.league, optic_tournament: tournament })
  }

  const compResults = []
  for (const t of opticTournaments.values()) {
    // Tennis NEVER name-matches: OPTIC labels a league just "wta"/"atp", which
    // scores a perfect fuzzy-coverage against EVERY "WTA …"/"ATP …" competition,
    // so the first candidate wins for all of them (every WTA tournament → the
    // same comp). Tennis competitions come solely from Stage 3 event evidence
    // (the player's matched event's league), which is unambiguous.
    if (canonSport(t.optic_sport) === 'tennis') continue
    const cands = mybetCompsBySport.get(canonSport(t.optic_sport)) ?? []
    const raw = prettyOpticLeague(t.optic_league)
    const aliased = aliasExpand(t.optic_league) || aliasExpand(raw)
    let best = null
    let bestScore = 0
    for (const c of cands) {
      const s = Math.max(sim(raw, c.name), sim(aliased, c.name))
      if (s > bestScore) { bestScore = s; best = c }
    }
    const accept = best && bestScore >= MIN_COMP_SIM
    compResults.push({
      optic_sport: t.optic_sport,
      optic_league: t.optic_league,
      optic_tournament: t.optic_tournament,
      gutsy_sport: accept ? best.sport : null,
      gutsy_competition: accept ? best.name : null,
      gutsy_competition_id: accept ? String(best.id) : '',
      confidence: +bestScore.toFixed(3),
      source: 'auto',
      provider: PROVIDER,
    })
  }
  // 1:1 for AUTO matches — a competition attaches to only ONE tournament.
  {
    const claimed = new Set()
    const winners = new Set()
    for (const r of [...compResults].sort((a, b) => b.confidence - a.confidence)) {
      const id = r.gutsy_competition_id
      if (!id || stickyCompIds.has(String(id))) continue
      if (claimed.has(String(id))) continue
      claimed.add(String(id))
      winners.add(r)
    }
    for (const r of compResults) {
      if (r.gutsy_competition_id && !winners.has(r)) {
        r.gutsy_sport = null
        r.gutsy_competition = null
        r.gutsy_competition_id = ''
      }
    }
  }
  const compUpserts = compResults.filter(
    (r) => !compStatus.get(`${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`),
  )
  await deleteAllAutoUnverified()
  await upsertAll(
    'competition_mapping?on_conflict=provider,optic_sport,optic_league,optic_tournament,gutsy_competition_id',
    compUpserts,
  )
  console.log(`• Stage 1: paired ${compResults.filter((r) => r.gutsy_competition).length}/${compResults.length} competitions (mybet has leagues for a subset).`)

  // ---- Stage 2: events by team names + time across the whole sport ----
  // Bucket mybet events by `${canonSport}|${YYYY-MM-DD}` so a candidate pool is
  // "same sport, same day (±1)". No competition gate — mybet competitions are
  // too sparse to rely on.
  const byKey = new Map()
  for (const e of events) {
    if (!e.start) continue
    const key = `${canonSport(e.sport ?? '')}|${String(e.start).slice(0, 10)}`
    const list = byKey.get(key) ?? []
    list.push(e)
    byKey.set(key, list)
  }
  const candidates = (cs, startMs) => {
    const out = []
    for (let off = -1; off <= 1; off++) {
      const day = new Date(startMs + off * 86_400_000).toISOString().slice(0, 10)
      const list = byKey.get(`${cs}|${day}`)
      if (list) out.push(...list)
    }
    return out
  }

  const eventResults = []
  let inWindow = 0
  for (const r of opticRows) {
    if (!r.optic_fixture_id) continue
    if (r.league && EXCLUDE_LEAGUES.has(r.league)) continue
    const opticStart = r.scheduled_start ? Date.parse(r.scheduled_start) : NaN
    const cands = Number.isFinite(opticStart) ? candidates(canonSport(r.sport ?? ''), opticStart) : []
    if (!cands.length) {
      eventResults.push({ optic_fixture_id: r.optic_fixture_id, gutsy_event_id: null, confidence: 0, source: 'auto', provider: PROVIDER })
      continue
    }
    inWindow++
    let best = null
    let bestScore = 0
    for (const e of cands) {
      const estart = e.start ? Date.parse(e.start) : NaN
      if (!Number.isFinite(estart)) continue
      if (Math.abs(opticStart - estart) > MAX_START_SKEW_MS) continue
      // Per-team match, not pooled tokens: score home↔home/away↔away and the
      // crossed orientation, and require BOTH teams to clear the bar. Pooled
      // token overlap let "Brewers v NY Mets" match "Pirates v NY Yankees" on
      // the shared "New York"; requiring the weaker team to match too kills it.
      const s = teamScore(r.home_team, r.away_team, e.home, e.away)
      if (s < MIN_EVENT_SIM) continue
      if (s > bestScore) { bestScore = s; best = e }
    }
    eventResults.push({
      optic_fixture_id: r.optic_fixture_id,
      gutsy_event_id: best ? best._id : null,
      confidence: +bestScore.toFixed(3),
      source: 'auto',
      provider: PROVIDER,
    })
  }
  const eventUpserts = eventResults.filter((r) => existingEvent.get(r.optic_fixture_id) !== 'manual')
  const paired = eventResults.filter((r) => r.gutsy_event_id).length
  await upsertAll('event_mapping?on_conflict=provider,optic_fixture_id', eventUpserts)
  console.log(`• Stage 2: ${inWindow}/${eventResults.length} fixtures had a same-sport/day candidate, paired ${paired} events.`)

  // ---- Stage 3: derive competitions from where mapped events land ----
  // On mybet the event's `league` IS the tournament, so a name-similarity match
  // (Stage 1) is unnecessary and often fails ("Australian Football League" shares
  // no distinctive token with OPTIC "afl"). Instead: for each OPTIC tournament,
  // take the dominant `league` of its already-mapped mybet events and map to
  // that — verified, since matched events are ground truth. Mirrors the SwiftBet
  // matcher's Stage 3.
  const mybetById = new Map(events.map((e) => [e._id, e]))
  const opticByFixture = new Map(opticRows.map((r) => [r.optic_fixture_id, r]))
  // opticKey → leagueId → { name, id, sport, n }
  const evidence = new Map()
  for (const res of eventResults) {
    if (!res.gutsy_event_id) continue
    const ev = mybetById.get(res.gutsy_event_id)
    if (!ev?.league) continue // player-prop events carry no league — skip
    const r = opticByFixture.get(res.optic_fixture_id)
    if (!r?.sport || !r.league) continue
    const isTennis = r.sport.toLowerCase() === 'tennis'
    const tournament = isTennis ? (r.season_type ?? '') : ''
    const key = `${r.sport}|${r.league}|${tournament}`
    const id = ev.leagueId ?? ev.league
    let byLeague = evidence.get(key)
    if (!byLeague) evidence.set(key, (byLeague = new Map()))
    const cur = byLeague.get(id) ?? { name: ev.league, id: String(id), sport: ev.sport, n: 0 }
    cur.n++
    byLeague.set(id, cur)
  }

  let derived = 0
  const stamp = new Date().toISOString()
  for (const [key, byLeague] of evidence) {
    const [optic_sport, optic_league, optic_tournament] = key.split('|')
    if (compStatus.get(key)) continue // manual/verified — leave alone
    // Dominant landing league, needs at least this many hits to trust it. Tennis
    // gets 1 (player+date+tournament is unambiguous, and it's the ONLY signal
    // since Stage 1 skips tennis); other sports need 2.
    const need = optic_sport.toLowerCase() === 'tennis' ? 1 : MIN_VERIFY
    let dom = null
    for (const info of byLeague.values()) if (!dom || info.n > dom.n) dom = info
    if (!dom || dom.n < need) continue
    await upsertAll('competition_mapping?on_conflict=provider,optic_sport,optic_league,optic_tournament,gutsy_competition_id', [{
      provider: PROVIDER, optic_sport, optic_league, optic_tournament,
      gutsy_sport: dom.sport, gutsy_competition: dom.name, gutsy_competition_id: String(dom.id),
      confidence: 1, source: 'auto', verified: true, verified_at: stamp,
    }])
    // Drop any other auto rows for this tournament (Stage 1's guesses / NULLs).
    const del = new URLSearchParams({
      provider: 'eq.mybet', optic_sport: `eq.${optic_sport}`, optic_league: `eq.${optic_league}`,
      optic_tournament: `eq.${optic_tournament}`, source: 'eq.auto', gutsy_competition_id: `neq.${String(dom.id)}`,
    })
    await fetch(`${REST}/competition_mapping?${del}`, { method: 'DELETE', headers: { ...HDR, Prefer: 'return=minimal' } })
    derived++
  }
  console.log(`• Stage 3: derived ${derived} competitions from event evidence.`)
  console.log('Done.')
}

/**
 * Similarity of two "A vs B" fixtures, gated on BOTH teams matching. Tries the
 * straight (home↔home, away↔away) and crossed orientations — mybet flips home/
 * away vs OPTIC sometimes — and returns the better orientation's WEAKER-team
 * score, so one strong side can't carry a mismatched other side. Callers gate
 * on this being ≥ MIN_EVENT_SIM.
 */
function teamScore(oHome, oAway, eHome, eAway) {
  const straight = Math.min(sim(oHome ?? '', eHome ?? ''), sim(oAway ?? '', eAway ?? ''))
  const crossed = Math.min(sim(oHome ?? '', eAway ?? ''), sim(oAway ?? '', eHome ?? ''))
  return +Math.max(straight, crossed).toFixed(3)
}

/** Mongo hands back BSON Date objects for the time fields; coerce to an ISO
 *  string so day-bucketing (String(start).slice(0,10)) and JSON snapshots
 *  behave the same as SwiftBet's already-string start_date. */
function iso(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** mybet doc → common event shape. `start` = suspendAt (market close ≈ kickoff). */
function normMybet(m) {
  const home = m.match?.teamA ?? null
  const away = m.match?.teamB ?? null
  const suspendAt = iso(m.suspendAt)
  return {
    _id: String(m._id),
    sport: m.sport ?? null,
    league: m.league ?? null,
    leagueId: m.leagueId != null ? String(m.leagueId) : null,
    home,
    away,
    start: suspendAt ?? iso(m.outcomeAt),
    suspendAt,
    lastSeenAt: iso(m.lastSeenAt),
    feedLastUpdated: iso(m.feedLastUpdated),
  }
}

/** Snapshot mybet competitions + events as JSON in public/ for the in-app picker. */
function writeMybetSnapshots(events) {
  const compMap = new Map() // id → {id, sport, name, n}
  for (const e of events) {
    if (!e.league) continue
    const id = e.leagueId ?? e.league
    const cur = compMap.get(id) ?? { id: String(id), sport: e.sport, name: e.league, n: 0 }
    cur.n++
    compMap.set(id, cur)
  }
  const comps = [...compMap.values()].sort((a, b) => b.n - a.n)
  const evs = events.map((e) => ({
    id: e._id,
    cid: e.leagueId ?? (e.league ? e.league : null),
    sport: e.sport,
    competition: e.league,
    name: e.home && e.away ? `${e.home} vs ${e.away}` : null,
    home: e.home,
    away: e.away,
    start: e.start,
    suspendAt: e.suspendAt,
    status: null,
  }))
  const pub = join(HERE, '..', 'public')
  mkdirSync(pub, { recursive: true })
  writeFileSync(join(pub, 'mybet-competitions.json'), JSON.stringify(comps))
  writeFileSync(join(pub, 'mybet-events.json'), JSON.stringify(evs))
  console.log(`  wrote public/mybet-competitions.json (${comps.length}) + mybet-events.json (${evs.length}).`)
}

async function getAllSupabase(pathAndQuery) {
  const rows = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const r = await fetch(`${REST}/${pathAndQuery}`, {
      headers: { ...HDR, Range: `${from}-${from + size - 1}`, 'Range-Unit': 'items' },
    })
    if (!r.ok) bail(`GET ${pathAndQuery} → ${r.status}: ${await r.text()}`)
    const batch = await r.json()
    rows.push(...batch)
    if (batch.length < size) break
  }
  return rows
}

/** Wipe every auto+non-verified mybet competition row before re-upserting. */
async function deleteAllAutoUnverified() {
  const r = await fetch(`${REST}/competition_mapping?provider=eq.mybet&source=eq.auto&verified=eq.false`, {
    method: 'DELETE',
    headers: { ...HDR, Prefer: 'return=minimal' },
  })
  if (!r.ok) bail(`delete auto unverified → ${r.status}: ${await r.text()}`)
}

async function upsertAll(pathAndQuery, items) {
  const CHUNK = 500
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK)
    const r = await fetch(`${REST}/${pathAndQuery}`, {
      method: 'POST',
      headers: { ...HDR, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(slice),
    })
    if (!r.ok) bail(`upsert ${pathAndQuery} → ${r.status}: ${await r.text()}`)
  }
}

function parseEnv(path) {
  try {
    const out = {}
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].trim()
    }
    return out
  } catch {
    return {}
  }
}

function bail(msg) {
  console.error(typeof msg === 'string' ? msg : msg?.stack ?? msg)
  process.exit(1)
}
