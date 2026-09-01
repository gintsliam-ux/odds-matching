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
import { canonSport, sim, prettyOpticLeague, aliasExpand, EXCLUDE_LEAGUES, eventPairSim, gradeKey } from './build-mapping.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = parseEnv(join(HERE, '..', '.env'))
const SUP_URL = env.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUP_KEY = env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const MONGO_URI = env.MONGO_URI ?? process.env.MONGO_URI
const MONGO_DB = env.MONGO_DB ?? process.env.MONGO_DB ?? 'gutsy'
const MYBET_COLL = env.MONGO_MYBET_COLL ?? process.env.MONGO_MYBET_COLL ?? 'mybet_events'
/** How far back a fixture is still worth loading for matching. Comfortably
 *  clears the event window while keeping the query near the old table's size. */
const MATCH_HORIZON_D = 45

const PROVIDER = 'mybet'

const REST = `${SUP_URL}/rest/v1`
const HDR = { apikey: SUP_KEY, Authorization: `Bearer ${SUP_KEY}` }

// Both name-similarity and start-time gates must pass, same as SwiftBet's event
// matcher. mybet's `suspendAt` sits at/near kickoff, so a 2 h skew tolerates the
// spread across sports without letting a different day's rematch through.
/** Sports whose competitors are individuals — the grade gate does not apply. */
const GRADE_EXEMPT_SPORTS = new Set(['mma', 'boxing'])

const MIN_EVENT_SIM = 0.4
const MAX_START_SKEW_MS = 120 * 60 * 1000
// Beyond the tight window, out to WIDE, only a near-exact name is accepted.
// Same joint gate as the SwiftBet matcher: boxing undercards, UFC prelims and
// tennis "not before" slots drift hours, and a flat gate discards exact-name
// candidates outright.
const MAX_START_SKEW_WIDE_MS = 6 * 60 * 60 * 1000

/** How far back and forward a fixture's mapping is still worth re-deriving. */
const WINDOW_BACK_MS = 3 * 86_400_000
const WINDOW_FWD_MS = 21 * 86_400_000

/** A fixture still inside the re-derivation window. Unparseable or missing
 *  start times are kept — better to do redundant work than silently stop
 *  mapping a fixture whose start the feed has not published yet. */
function withinMappingWindow(scheduledStart, now = Date.now()) {
  if (!scheduledStart) return true
  const t = Date.parse(scheduledStart)
  if (!Number.isFinite(t)) return true
  return t >= now - WINDOW_BACK_MS && t <= now + WINDOW_FWD_MS
}
const MIN_EVENT_SIM_WIDE = 0.9
const MIN_COMP_SIM = 0.4
// Event-evidence competition derivation (Stage 3): this many mapped events must
// land on the same mybet league before we trust it as the tournament mapping.
// mybet's event pool is sparse, so 2 is enough signal.
const MIN_VERIFY = 2

const IS_CLI = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (IS_CLI)
  main({ writeSnapshot: true }).catch((e) => {
    console.error('error:', e instanceof Error ? e.stack : e)
    process.exit(1)
  })

/** Cron entry — skips the /public snapshot (no writable fs on Vercel). */
export async function runMybetMapping(opts = {}) {
  return main({ writeSnapshot: false, ...opts })
}

async function main(opts = { writeSnapshot: true }) {
  if (!SUP_URL || !SUP_KEY) bail('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  if (!MONGO_URI) bail('Missing MONGO_URI')

  console.log('• Loading OpticOdds fixtures…')
  // `fixtures`, not `live_fixtures`. The old table was retired on 2026-08-24
  // (its four live-tracker crons removed); nothing writes it now. By then 424
  // of the next week's 804 upcoming fixtures existed only here, none of which
  // this matcher could see, so none could be paired to a book.
  //
  // Bounded twice, because `fixtures` is much larger than what it replaces:
  //   · source=optic — the rest is the archive migration, carrying synthetic
  //     `syn_...` ids no book has ever listed, and none has ever appeared in
  //     event_mapping.
  //   · last MATCH_HORIZON_D days — older fixtures are settled and their
  //     mapping cannot change.
  //
  // Ordered by the PRIMARY KEY. A paged PostgREST read without ORDER BY is not
  // a stable slice: rows shift between requests, so pages repeat and drop
  // records. `fixtures` has no `id` column — its key is `fixture_id`.
  //
  // Column names differ, so both are aliased back to what the matcher already
  // calls them and nothing downstream changes.
  // Filtered server-side: fixtures now has an index covering
  // (source, scheduled_start), so this no longer statement-timeouts.
  const horizon = new Date(Date.now() - MATCH_HORIZON_D * 86_400_000).toISOString()
  const opticRows = (
    await getAllSupabase(
      'fixtures?select=fixture_id,optic_fixture_id:fixture_id,sport,league:optic_league,season_type,home_team,away_team,scheduled_start' +
        `&source=eq.optic&scheduled_start=gte.${horizon}`,
      // Seek on the REAL column — `order=`/`gt.` resolve against the table, so
      // the aliased name 400s with "column does not exist".
      'fixture_id',
    )
  ).filter((r) => r.optic_fixture_id)
  console.log(`  ${opticRows.length} fixtures.`)

  console.log('• Loading gutsy.mybet_events from Mongo…')
  // Small pool + finally-close: one sequential read needs one connection, and
  // Atlas is shared with the scrapers — a client leaked by a mid-run throw on a
  // warm instance must not accumulate.
  const mongo = new MongoClient(MONGO_URI, { maxPoolSize: 5 })
  let raw
  try {
    await mongo.connect()
    raw = await mongo
      .db(MONGO_DB)
      .collection(MYBET_COLL)
      .find(
        {},
        { projection: { _id: 1, sport: 1, league: 1, leagueId: 1, description: 1, match: 1, suspendAt: 1, outcomeAt: 1, lastSeenAt: 1, feedLastUpdated: 1 } },
      )
      .toArray()
  } finally {
    await mongo.close().catch(() => {})
  }
  // Same futures exclusion as the SwiftBet matcher — mybet files the
  // competition in `league`. None match today, but a season-outright market
  // arriving later would otherwise join the candidate pool silently.
  const events = raw
    .map(normMybet)
    .filter((e) => e.home && e.away && !/\bfutures?\b/i.test(e.league ?? ''))
  console.log(`  ${raw.length} mybet events (${events.length} with both teams).`)

  if (opts.writeSnapshot) writeMybetSnapshots(events)

  // Preserve manual/verified rows exactly like the SwiftBet matcher.
  const compStatus = new Map() // optic key → { hasSticky }
  // Competitions held by a verified/manual mapping — off-limits to AUTO matches
  // (1:1: a competition attaches to only one tournament).
  const stickyCompIds = new Set()
  for (const r of await getAllSupabase(
    'competition_mapping?provider=eq.mybet&select=id,optic_sport,optic_league,optic_tournament,gutsy_competition_id,source,verified',
  )) {
    const k = `${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`
    if (r.source === 'manual' || r.verified) {
      compStatus.set(k, true)
      if (r.gutsy_competition_id) stickyCompIds.add(String(r.gutsy_competition_id))
    }
  }
  const existingEvent = new Map(
    (await getAllSupabase('event_mapping?provider=eq.mybet&select=id,optic_fixture_id,source')).map((r) => [
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
  // Window is generous on both sides: back far enough to cover a fixture that
  // settles late or has its start corrected, forward far enough to cover every
  // fixture mybet has listed. A fixture outside it is finished and its mapping
  // is fixed, so re-deriving it every pass bought nothing.
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

  // Candidate pairs first, assignment second. A fixture used to take its best
  // event independently of every other fixture, so nothing stopped two fixtures
  // claiming the SAME mybet event — 74 events were double-claimed, including
  // cross-division pairs (Saudi League against Division 1) and cross-grade ones
  // (WNBL1 against NBL1). One event is one game; at least one of each pair was
  // wrong, and a wrong pairing attributes real bets to the wrong fixture.
  //
  // The 1:1 rule that stage 1 applies to competitions now applies here too:
  // collect every (fixture, event) pair that clears the gates, then assign
  // greedily by score so the strongest claim wins and each side is used once.
  const pairs = []
  const reached = []
  const eventResults = []
  let inWindow = 0
  let skippedOld = 0
  for (const r of opticRows) {
    if (!r.optic_fixture_id) continue
    if (r.league && EXCLUDE_LEAGUES.has(r.league)) continue
    // Only fixtures whose mapping can still change. live_fixtures keeps its
    // whole back-catalogue — 12,900 of 14,241 rows are more than two days old
    // — and re-pairing all of them against 60k+ mybet events every ten minutes
    // was the bulk of this pass.
    //
    // SKIP rather than record a null result. A fixture that reaches the loop
    // and finds no candidate is written as `gutsy_event_id: null`, and the
    // upsert merges on (provider, optic_fixture_id) — so emitting a null for
    // an old fixture would overwrite a mapping it already has. Skipping leaves
    // the existing row untouched, which is safe precisely because
    // `event_mapping` is never deleted from, only upserted into.
    if (!withinMappingWindow(r.scheduled_start)) {
      skippedOld++
      continue
    }
    const opticStart = r.scheduled_start ? Date.parse(r.scheduled_start) : NaN
    const cands = Number.isFinite(opticStart) ? candidates(canonSport(r.sport ?? ''), opticStart) : []
    if (!cands.length) {
      eventResults.push({ optic_fixture_id: r.optic_fixture_id, gutsy_event_id: null, confidence: 0, source: 'auto', provider: PROVIDER })
      continue
    }
    inWindow++
    for (const e of cands) {
      const estart = e.start ? Date.parse(e.start) : NaN
      if (!Number.isFinite(estart)) continue
      const skew = Math.abs(opticStart - estart)
      if (skew > MAX_START_SKEW_WIDE_MS) continue
      // Same clubs, different grade. Candidates here are pooled by sport+day
      // with no competition gate, so the women's match and the men's — or the
      // U23s and the seniors — are both in the pool, hours apart, with team
      // names that score 1.00 because teamScore drops the very tokens that
      // separate them. Reject outright rather than let the 1:1 claim rule
      // decide by ordering. See gradeKey.
      //
      // Skipped for combat sports: the participants are PEOPLE, so two bouts
      // never share a name and there is no collision to prevent — while OPTIC
      // files every bout under one `ufc` league with no gender split, so the
      // gate would reject correct women's bouts against mybet's "UFC - Women".
      if (!GRADE_EXEMPT_SPORTS.has(canonSport(r.sport ?? '')) &&
          gradeKey(r.home_team, r.away_team, r.league) !== gradeKey(e.home, e.away, e.league)) continue
      // Per-team match, not pooled tokens: score home↔home/away↔away and the
      // crossed orientation, and require BOTH teams to clear the bar. Pooled
      // token overlap let "Brewers v NY Mets" match "Pirates v NY Yankees" on
      // the shared "New York"; requiring the weaker team to match too kills it.
      const s = teamScore(r.home_team, r.away_team, e.home, e.away)
      const floor = skew <= MAX_START_SKEW_MS ? MIN_EVENT_SIM : MIN_EVENT_SIM_WIDE
      if (s < floor) continue
      pairs.push({ fixture: r.optic_fixture_id, event: e, score: s, skew })
    }
    reached.push(r.optic_fixture_id)
  }

  // Strongest claim first; ties go to the nearer start time, which is what the
  // per-fixture tie-break used to do.
  pairs.sort((a, b) => b.score - a.score || a.skew - b.skew)
  const claimedFixture = new Map()
  const claimedEvent = new Set()
  for (const p of pairs) {
    if (claimedFixture.has(p.fixture) || claimedEvent.has(String(p.event._id))) continue
    claimedFixture.set(p.fixture, p)
    claimedEvent.add(String(p.event._id))
  }
  for (const id of reached) {
    const win = claimedFixture.get(id)
    eventResults.push({
      optic_fixture_id: id,
      gutsy_event_id: win ? win.event._id : null,
      confidence: win ? +win.score.toFixed(3) : 0,
      source: 'auto',
      provider: PROVIDER,
    })
  }
  const eventUpserts = eventResults.filter((r) => existingEvent.get(r.optic_fixture_id) !== 'manual')
  const paired = eventResults.filter((r) => r.gutsy_event_id).length
  await upsertAll('event_mapping?on_conflict=provider,optic_fixture_id', eventUpserts)
  console.log(`• Stage 2: ${inWindow}/${eventResults.length} fixtures had a same-sport/day candidate, paired ${paired} events (skipped ${skippedOld} outside the window).`)

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
  // Scores each participant with participantSim, NOT sim(). sim() carries the
  // country and tier gates, which exist for COMPETITION names and misfire on
  // team names — the tier gate is a hard reject, so "Sydney FC 2" vs "Sydney FC
  // Youth" would score 0 outright. participantSim also brings the acronym rule
  // (GWS ↔ Greater Western Sydney) that pure token overlap scores at zero.
  return +eventPairSim(oHome ?? '', oAway ?? '', eHome ?? '', eAway ?? '').toFixed(3)
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

/**
 * Page a table, seeking on a unique key rather than OFFSET.
 *
 * Mirrors build-mapping.mjs. OFFSET pagination times out on this database once
 * the offset is deep — Postgres walks every skipped row — and `fixtures` is
 * ~97k rows, so the walk exceeded the statement timeout partway through every
 * run. Seeking reads an index range at any depth.
 *
 * `keyCol` must be UNIQUE and present in the select, or rows are skipped,
 * repeated, or the loop spins on one page.
 */
async function getAllSupabase(pathAndQuery, keyCol = 'id') {
  const rows = []
  const size = 1000
  let after = null
  for (;;) {
    const sep = pathAndQuery.includes('?') ? '&' : '?'
    const seek = after == null ? '' : `&${keyCol}=gt.${encodeURIComponent(after)}`
    const r = await fetchRetry(`${REST}/${pathAndQuery}${sep}order=${keyCol}.asc&limit=${size}${seek}`, {
      headers: HDR,
    })
    if (!r.ok) bail(`GET ${pathAndQuery} → ${r.status}: ${await r.text()}`)
    const batch = await r.json()
    rows.push(...batch)
    if (batch.length < size) break
    const next = batch[batch.length - 1]?.[keyCol]
    if (next == null) bail(`getAllSupabase: '${keyCol}' missing from ${pathAndQuery} — add it to the select`)
    after = next
  }
  return rows
}

/** Wipe every auto+non-verified mybet competition row before re-upserting. */
/** See the note in build-mapping.mjs — the matcher must not delete mappings
 *  for sports it cannot rebuild. */
const UNMANAGED_SPORTS = ['golf']

async function deleteAllAutoUnverified() {
  const qs = `provider=eq.mybet&source=eq.auto&verified=eq.false&optic_sport=not.in.(${UNMANAGED_SPORTS.join(',')})`
  const r = await fetchRetry(`${REST}/competition_mapping?${qs}`, {
    method: 'DELETE',
    headers: { ...HDR, Prefer: 'return=minimal' },
  })
  if (!r.ok) bail(`delete auto unverified → ${r.status}: ${await r.text()}`)
}

/** Drop rows repeating a conflict key within one batch. Postgres refuses an
 *  ON CONFLICT DO UPDATE that would touch a row twice — and fails the whole
 *  statement, not the row. Keeps the last occurrence, which is what a second
 *  upsert would have left anyway. */
function dedupeOnConflict(pathAndQuery, items) {
  const m = /on_conflict=([^&]+)/.exec(pathAndQuery)
  if (!m) return items
  const cols = decodeURIComponent(m[1]).split(',')
  const byKey = new Map()
  for (const it of items) byKey.set(cols.map((c) => String(it[c] ?? '')).join('\u0000'), it)
  return [...byKey.values()]
}

async function upsertAll(pathAndQuery, itemsRaw) {
  const items = dedupeOnConflict(pathAndQuery, itemsRaw)
  const CHUNK = 500
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK)
    const r = await fetchRetry(`${REST}/${pathAndQuery}`, {
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

// Always THROW — never process.exit(). /api/cron/build-mapping runs this inside
// its own try/catch precisely so a mybet failure can't sink an already-succeeded
// SwiftBet run; an exit() kills the instance and defeats that isolation.
function bail(msg) {
  throw msg instanceof Error ? msg : new Error(String(msg))
}

/** fetch + bounded retry on transient network / Supabase 5xx-429 failures.
 *  Every caller is idempotent (paginated read, filtered delete, merge-duplicates
 *  upsert), so replaying is safe. 4xx returns as-is — that's a real bug. */
async function fetchRetry(url, init, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)))
    try {
      const r = await fetch(url, init)
      if (r.status < 500 && r.status !== 429) return r
      lastErr = new Error(`${r.status}: ${await r.text()}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}
