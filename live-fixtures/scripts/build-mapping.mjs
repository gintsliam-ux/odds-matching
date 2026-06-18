// Two-stage matcher: OpticOdds `live_fixtures` (source) ↔ gutsy.events (target).
//
//   stage 1: competition_mapping  (optic_sport, optic_league) → (gutsy_sport, gutsy_competition)
//   stage 2: event_mapping        optic_fixture_id            → gutsy_event_id
//
// Run with:  npm run build-mapping
// Env: MONGO_URI / MONGO_DB / MONGO_COLL plus VITE_SUPABASE_URL/KEY in ../.env.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = parseEnv(join(HERE, '..', '.env'))
const SUP_URL = env.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUP_KEY = env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const MONGO_URI = env.MONGO_URI ?? process.env.MONGO_URI
const MONGO_DB = env.MONGO_DB ?? process.env.MONGO_DB ?? 'gutsy'
const MONGO_COLL = env.MONGO_COLL ?? process.env.MONGO_COLL ?? 'events'

if (!SUP_URL || !SUP_KEY) bail('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
if (!MONGO_URI) bail('Missing MONGO_URI')

const REST = `${SUP_URL}/rest/v1`
const HDR = { apikey: SUP_KEY, Authorization: `Bearer ${SUP_KEY}` }

// OpticOdds sport slug → canonical name(s) for the target side. The
// canonical name is matched (case-insensitive) against gutsy `sport.name`.
// OPTIC leagues we never map — ITF / UTR tennis tiers don't appear in gutsy
// and would just clutter the mapping table with permanently-unmapped rows.
const EXCLUDE_LEAGUES = new Set(['itf_men', 'itf_women', 'utr_men', 'utr_women'])

const SPORT_MAP = {
  soccer: 'football',
  // The OpticOdds feed treats these soccer leagues as their own "sport". Mark
  // them as football so the matcher finds candidates in gutsy.events.
  laliga: 'football',
  epl: 'football',
  seriea: 'football',
  serieb: 'football',
  bundesliga: 'football',
  ligue1: 'football',
  ucl: 'football',
  uel: 'football',
  football: 'american football', // OpticOdds rare use; usually `amfootball`
  americanfootball: 'american football',
  amfootball: 'american football',
  nfl: 'american football',
  cfl: 'american football',
  basketball: 'basketball',
  nba: 'basketball',
  wnba: 'basketball',
  baseball: 'baseball',
  mlb: 'baseball',
  kbo: 'baseball',
  npb: 'baseball',
  icehockey: 'ice hockey',
  hockey: 'ice hockey',
  nhl: 'ice hockey',
  cricket: 'cricket',
  tennis: 'tennis',
  mma: 'mixed martial arts',
  ufc: 'mixed martial arts',
  boxing: 'boxing',
  darts: 'darts',
  rugby: 'rugby',
  rugbyunion: 'rugby union',
  rugby_union: 'rugby union',
  rugbyleague: 'rugby league',
  rugby_league: 'rugby league',
  nrl: 'rugby league',
  afl: 'australian rules',
  aussierules: 'australian rules',
  golf: 'golf',
  motorsport: 'motor sport',
  formula1: 'motor sport',
  // Sports SwiftBet also covers — same canonical name on both sides.
  volleyball: 'volleyball',
  snooker: 'snooker',
  handball: 'handball',
  badminton: 'badminton',
  tabletennis: 'table tennis',
  table_tennis: 'table tennis',
}

function canonSport(s) {
  if (!s) return ''
  const k = s.toLowerCase().replace(/[^a-z]/g, '')
  return SPORT_MAP[k] ?? s.toLowerCase().replace(/_/g, ' ').trim()
}

// "france_-_ligue_1" → "france ligue 1"; keeps the country/region prefix so
// SWIFT competitions named "France - Ligue 1" score higher token overlap.
function prettyOpticLeague(raw) {
  if (!raw) return ''
  return raw.replace(/_-_/g, ' ').replace(/_/g, ' ').trim().toLowerCase()
}

// OpticOdds abbreviations → expanded names used on the gutsy side. Without
// this, "mlb" vs "Major League Baseball" scores 0 (no token overlap).
const LEAGUE_ALIASES = {
  mlb: 'major league baseball',
  nba: 'national basketball association',
  nfl: 'national football league',
  nhl: 'national hockey league',
  mls: 'major league soccer',
  ufc: 'ultimate fighting championship',
  pfl: 'professional fighters league',
  nrl: 'telstra premiership',
  afl: 'toyota afl premiership',
  kbo: 'kbo league',
  npb: 'nippon professional baseball',
  cebl: 'canadian elite basketball league',
  cfl: 'canadian football league',
  ipl: 'indian premier league',
  pbr: 'professional bull riders',
  epl: 'premier league',
  laliga: 'la liga',
  serie_a: 'serie a',
  serie_b: 'serie b',
  bundesliga: 'bundesliga',
  ligue_1: 'ligue 1',
  ucl: 'champions league',
  uel: 'europa league',
  ues: 'europa conference league',
}

function aliasExpand(s) {
  if (!s) return ''
  const k = s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  return LEAGUE_ALIASES[k] ?? s
}

// --- text similarity (token Jaccard + small bonuses) ---------------------

const STOP = new Set([
  'the','of','and','a','an','de','del','la','le','les','el','en','y','d','dell','di',
  'club','clube','fc','cf','sc','ac','bc','cd','ca','cr','fr','afc','football','futbol','futebol',
  'cup','league','liga','serie','division','div','ii','iii','jr','sr','women','men','women’s','men’s',
  'international','national','professional','tournament','championship','open','presented','workday',
  'team','base',
])

function tokens(s) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const t of a) if (b.has(t)) hit++
  return hit / (a.size + b.size - hit)
}

// Directional coverage: how much of the SHORTER side's tokens are covered by
// the longer side, allowing ≥3-char prefix matches ("man" ↔ "manchester").
// "Boston Red Sox" vs "Red Sox" → 2/2 = 1.0. Lets long-form ↔ short-form pairs
// score high without dragging Jaccard's denominator through unmatched tokens
// on the bigger side.
function fuzzyCoverage(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let hits = 0
  for (const t of small) {
    if (big.has(t)) { hits++; continue }
    for (const u of big) {
      const minLen = Math.min(t.length, u.length)
      if (minLen >= 3 && (t.startsWith(u) || u.startsWith(t))) { hits++; break }
    }
  }
  return hits / small.size
}

// See src/lib/autoMatch.ts for the rationale — keep these two lists in sync.
const COUNTRY_TOKENS = new Set([
  'albania','algeria','andorra','angola','argentina','armenia','australia',
  'austria','azerbaijan','bahrain','belarus','belgium','bolivia','bosnia',
  'botswana','brazil','bulgaria','cambodia','cameroon','canada','chile',
  'china','colombia','croatia','cyprus','czech','denmark','dominican',
  'ecuador','egypt','england','estonia','ethiopia','faroe','fiji','finland',
  'france','gabon','gambia','georgia','germany','ghana','greece','guatemala',
  'haiti','honduras','hungary','iceland','india','indonesia','iran','iraq',
  'ireland','israel','italy','jamaica','japan','jordan','kazakhstan','kenya',
  'korea','kosovo','kuwait','kyrgyzstan','latvia','lebanon','libya',
  'liechtenstein','lithuania','luxembourg','malaysia','maldives','mali',
  'malta','mauritius','mexico','moldova','monaco','mongolia','montenegro',
  'morocco','mozambique','myanmar','namibia','nepal','netherlands',
  'nicaragua','nigeria','norway','oman','pakistan','palestine','panama',
  'paraguay','peru','philippines','poland','portugal','qatar','romania',
  'rwanda','russia','scotland','senegal','serbia','singapore','slovakia',
  'slovenia','somalia','spain','sudan','suriname','sweden','switzerland',
  'syria','taiwan','tanzania','thailand','togo','tunisia','turkey',
  'turkmenistan','uganda','ukraine','uruguay','usa','uzbekistan',
  'venezuela','vietnam','wales','yemen','zambia','zimbabwe',
])
const COUNTRY_BIGRAMS = new Set([
  'south africa','south korea','new zealand','saudi arabia','costa rica',
  'sierra leone','north macedonia','ivory coast',
])
const COUNTRY_ADJECTIVES = {
  french: 'france', spanish: 'spain', italian: 'italy', german: 'germany',
  dutch: 'netherlands', portuguese: 'portugal', english: 'england',
  scottish: 'scotland', welsh: 'wales', irish: 'ireland', brazilian: 'brazil',
  argentinian: 'argentina', argentine: 'argentina', mexican: 'mexico',
  japanese: 'japan', chinese: 'china', korean: 'korea', australian: 'australia',
  american: 'usa', canadian: 'canada', swiss: 'switzerland', swedish: 'sweden',
  norwegian: 'norway', danish: 'denmark', finnish: 'finland', belgian: 'belgium',
  austrian: 'austria', polish: 'poland', russian: 'russia', greek: 'greece',
  turkish: 'turkey', croatian: 'croatia', serbian: 'serbia', romanian: 'romania',
  ukrainian: 'ukraine', israeli: 'israel', egyptian: 'egypt', moroccan: 'morocco',
  saudi: 'saudi arabia', emirati: 'uae', qatari: 'qatar',
}

function extractCountries(s) {
  const lc = (s ?? '').toLowerCase()
  const out = new Set()
  for (const big of COUNTRY_BIGRAMS) if (lc.includes(big)) out.add(big)
  const words = lc.split(/[^a-z]+/).filter(Boolean)
  for (const w of words) {
    if (COUNTRY_TOKENS.has(w)) out.add(w)
    const adj = COUNTRY_ADJECTIVES[w]
    if (adj) out.add(adj)
  }
  return out
}

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  i: 1, ii: 2, iii: 3, iv: 4,
  primera: 1, segunda: 2, tercera: 3,
  premier: 1, premiere: 1, super: 1, championship: 2,
}
function extractTiers(s) {
  const out = new Set()
  // Normalise punctuation (underscores, hyphens) to spaces so \b-style word
  // boundaries fire correctly — `\b` doesn't trigger between `_` and letters
  // because underscore is a word character.
  const lc = (s ?? '').toLowerCase().replace(/[_\-./]+/g, ' ')
  for (const m of lc.matchAll(/(?:^|[^a-z0-9])([a-z]?(\d{1,2}))(?![a-z])/gi)) {
    const n = parseInt(m[2], 10)
    if (Number.isFinite(n) && n >= 1 && n <= 30) out.add(n)
  }
  for (const m of lc.matchAll(/[a-z]+/g)) {
    const n = NUMBER_WORDS[m[0]]
    if (n) out.add(n)
  }
  return out
}

function sim(aName, bName) {
  const a = new Set(tokens(aName))
  const b = new Set(tokens(bName))
  let s = Math.max(jaccard(a, b), fuzzyCoverage(a, b))
  // bonus when one is fully contained in the other ("NBA" ⊂ "NBA Summer League")
  const al = (aName ?? '').toLowerCase()
  const bl = (bName ?? '').toLowerCase()
  if (al && bl && (al === bl || al.includes(bl) || bl.includes(al))) s = Math.max(s, 0.9)
  // Collapsed-punctuation containment — rescues "la liga" vs "LaLiga" and
  // "brazil serie b" vs "Série B" when stop words filter the tokens out. NFD
  // strips accents (é → e) so the comparison sees "serieb" on both sides.
  // Min length 5 keeps tiny substrings from over-matching.
  const ac = al.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')
  const bc = bl.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')
  if (ac && bc && ac !== bc && Math.min(ac.length, bc.length) >= 5) {
    if (ac.includes(bc) || bc.includes(ac)) s = Math.max(s, 0.9)
  }
  // Country gate — heavy penalty when both sides mention distinct countries.
  const ca = extractCountries(aName)
  const cb = extractCountries(bName)
  if (ca.size > 0 && cb.size > 0) {
    let overlap = false
    for (const c of ca) if (cb.has(c)) { overlap = true; break }
    if (!overlap) s -= 0.5
  } else if ((ca.size > 0) !== (cb.size > 0)) {
    s -= 0.15
  }
  const ta = extractTiers(aName)
  const tb = extractTiers(bName)
  if (ta.size > 0 && tb.size > 0) {
    let overlap = false
    for (const n of ta) if (tb.has(n)) { overlap = true; break }
    if (!overlap) s -= 0.35
  }
  return Math.max(0, s)
}

// --- tennis tournament parsing ------------------------------------------
//
// OPTIC season_type shapes:
//   "Birmingham, Great Britain"             ATP/WTA singles
//   "Birmingham, Great Britain, Doubles"    doubles
//   "ITF M15 Monastir 20 Men"               ITF / UTR full string
//   "UTR PTT Newport Beach Men 13, Group D" UTR with group
//
// SWIFT competition names:
//   "Lexus Birmingham Open Women", "Lexus Birmingham Open Women Doubles"
//   "French Open Men's Singles" / "French Open Men's Doubles" / "...Women's..."
//   "Makarska Open 125"

function parseTennisTournament(league, seasonType) {
  const l = (league ?? '').toLowerCase()
  const s = seasonType ?? ''

  const isDoubles = /_doubles|, doubles$| doubles\b/i.test(`${l} ${s}`)

  // gender from league first (most reliable), fall back to season_type words
  let gender = null
  if (l.startsWith('wta')) gender = 'women'
  else if (l.startsWith('atp')) gender = 'men'
  else if (l.includes('_women') || / women\b/i.test(s)) gender = 'women'
  else if (l.includes('_men') || / men\b/i.test(s)) gender = 'men'

  // City / key tokens: take the first comma-piece for ATP/WTA, full string otherwise.
  // Strip ", Doubles" and trailing ", Group X".
  const firstPiece = s.split(',')[0].trim() // "Birmingham" / "ITF M15 Monastir 20 Men"
  return { league: l, seasonType: s, isDoubles, gender, city: firstPiece, full: s }
}

function scoreTennis(ot, gutsyComp) {
  const gc = (gutsyComp ?? '').toLowerCase()

  // base similarity on the city / key tokens vs the gutsy competition name
  const baseA = sim(ot.city, gutsyComp)
  const baseB = sim(ot.full, gutsyComp)
  let s = Math.max(baseA, baseB)

  // strong city-contains bonus ("Birmingham" ⊂ "Lexus Birmingham Open Women")
  const cityLower = ot.city.toLowerCase()
  if (cityLower.length >= 3 && gc.includes(cityLower)) s = Math.max(s, 0.7)

  // doubles must match — penalize a mismatch heavily
  const gcDoubles = / doubles\b/.test(gc)
  if (ot.isDoubles && !gcDoubles) s -= 0.4
  if (!ot.isDoubles && gcDoubles) s -= 0.4

  // gender alignment (best-effort; many gutsy names omit gender for ATP/men)
  if (ot.gender === 'women' && /\bwomen|women's\b/.test(gc)) s += 0.15
  if (ot.gender === 'men' && /\bmen|men's\b/.test(gc) && !/women/.test(gc)) s += 0.15
  if (ot.gender === 'women' && /\bmen's\b/.test(gc) && !/women/.test(gc)) s -= 0.3
  if (ot.gender === 'men' && /\bwomen|women's\b/.test(gc)) s -= 0.3

  return Math.max(0, Math.min(1, s))
}

// --- main ----------------------------------------------------------------

// When invoked directly (`node scripts/build-mapping.mjs`) run the full job
// including writing /public snapshots. When imported by the Vercel cron, the
// caller flips snapshot off (the function bundle can't write to /public).
const IS_CLI = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (IS_CLI) main({ writeSnapshot: true }).catch((e) => bail(e))

export async function runMapping(opts = {}) {
  return main({ writeSnapshot: false, ...opts })
}

async function main(opts = { writeSnapshot: true }) {
  console.log('• Loading OpticOdds live_fixtures…')
  const opticRows = await getAllSupabase(
    'live_fixtures?select=optic_fixture_id,sport,league,season_type,home_team,away_team,scheduled_start',
  )
  console.log(`  ${opticRows.length} fixtures.`)

  console.log('• Loading gutsy.events from Mongo…')
  const mongo = new MongoClient(MONGO_URI)
  await mongo.connect()
  const gutsy = await mongo
    .db(MONGO_DB)
    .collection(MONGO_COLL)
    .find(
      {},
      { projection: { _id: 1, name: 1, sport: 1, competition: 1, teams: 1, start_date: 1, status: 1 } },
    )
    .toArray()
  await mongo.close()
  console.log(`  ${gutsy.length} mongo events.`)

  // Drop a small JSON snapshot of SWIFT competitions + events into public/ so
  // the EditMappingModal can let the user browse/pick candidates without
  // touching Mongo from the browser. Skipped when called from the Vercel cron
  // — that runtime has no writable /public.
  if (opts.writeSnapshot) writeSwiftSnapshots(gutsy)

  // Existing rows from previous runs. Multi-mapping: an OPTIC tournament can
  // have many rows. We preserve the WHOLE tournament if ANY of its rows is
  // manual or verified — auto matcher leaves it untouched.
  const compStatus = new Map() // optic key → { hasSticky: bool, hasAuto: bool }
  for (const r of await getAllSupabase(
    'competition_mapping?select=optic_sport,optic_league,optic_tournament,gutsy_competition_id,source,verified',
  )) {
    const k = `${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`
    const cur = compStatus.get(k) ?? { hasSticky: false, hasAuto: false }
    if (r.source === 'manual' || r.verified) cur.hasSticky = true
    else cur.hasAuto = true
    compStatus.set(k, cur)
  }
  const existingEvent = new Map(
    (await getAllSupabase('event_mapping?select=optic_fixture_id,source')).map((r) => [r.optic_fixture_id, r.source]),
  )

  // -- Stage 1: competitions
  // Group OpticOdds by (sport, league) — except tennis, which groups by
  // (sport, league, season_type) because a single OPTIC tennis league spans
  // dozens of distinct gutsy tournaments per season_type.
  const opticTournaments = new Map() // key → {optic_sport, optic_league, optic_tournament}
  for (const r of opticRows) {
    if (!r.sport || !r.league) continue
    if (EXCLUDE_LEAGUES.has(r.league)) continue
    const isTennis = r.sport.toLowerCase() === 'tennis'
    const tournament = isTennis ? (r.season_type ?? '') : ''
    if (isTennis && !tournament) continue // tennis row with no season_type — can't map
    const k = `${r.sport}|${r.league}|${tournament}`
    if (!opticTournaments.has(k)) {
      opticTournaments.set(k, {
        optic_sport: r.sport,
        optic_league: r.league,
        optic_tournament: tournament,
      })
    }
  }

  // Index gutsy competitions by canonical sport name.
  const gutsyByCanonSport = new Map() // canon → [{sport, competition, competition_id}]
  for (const e of gutsy) {
    const sn = e.sport?.name
    const cn = e.competition?.name
    const cid = e.competition?.id ?? e.competition?.base_competition_id ?? null
    if (!sn || !cn) continue
    const c = sn.toLowerCase()
    const list = gutsyByCanonSport.get(c) ?? []
    if (!list.some((x) => x.competition === cn)) list.push({ sport: sn, competition: cn, competition_id: cid })
    gutsyByCanonSport.set(c, list)
  }

  const MIN_COMP_SIM = 0.4
  const MIN_COMP_SIM_SOCCER = 0.55
  const MIN_TENNIS_SIM = 0.35
  const compResults = []
  for (const t of opticTournaments.values()) {
    const canon = canonSport(t.optic_sport)
    const cands = gutsyByCanonSport.get(canon) ?? []
    const isTennis = canon === 'tennis'
    const isSoccer = canon === 'soccer'
    let best = null
    let bestScore = 0
    if (isTennis) {
      const ot = parseTennisTournament(t.optic_league, t.optic_tournament)
      for (const c of cands) {
        const s = scoreTennis(ot, c.competition)
        if (s > bestScore) {
          bestScore = s
          best = c
        }
      }
    } else {
      const raw = prettyOpticLeague(t.optic_league)
      const aliased = aliasExpand(t.optic_league) || aliasExpand(raw)
      for (const c of cands) {
        const s = Math.max(sim(raw, c.competition), sim(aliased, c.competition))
        if (s > bestScore) {
          bestScore = s
          best = c
        }
      }
    }
    const accept =
      best && bestScore >= (isTennis ? MIN_TENNIS_SIM : isSoccer ? MIN_COMP_SIM_SOCCER : MIN_COMP_SIM)
    compResults.push({
      optic_sport: t.optic_sport,
      optic_league: t.optic_league,
      optic_tournament: t.optic_tournament,
      gutsy_sport: accept ? best.sport : null,
      gutsy_competition: accept ? best.competition : null,
      gutsy_competition_id: accept ? best.competition_id : null,
      confidence: +bestScore.toFixed(3),
      source: 'auto',
    })
  }

  const compPaired = compResults.filter((r) => r.gutsy_competition).length
  const compHigh = compResults.filter((r) => r.confidence >= 0.6).length
  const tennisRows = compResults.filter((r) => canonSport(r.optic_sport) === 'tennis')
  const tennisPaired = tennisRows.filter((r) => r.gutsy_competition).length
  // Preserve any OPTIC tournament that already has at least one manual or
  // verified row — leaves the user's hand-curated set alone.
  const compAutoUpserts = compResults
    .filter((r) => !compStatus.get(`${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`)?.hasSticky)
    // The new schema uses '' as the unmapped sentinel; treat null swift ids as ''.
    .map((r) => ({ ...r, gutsy_competition_id: r.gutsy_competition_id ?? '' }))
  const compKept = compResults.length - compAutoUpserts.length
  console.log(
    `• Stage 1: paired ${compPaired}/${compResults.length} competitions  (high-conf ≥0.6: ${compHigh}, tennis ${tennisPaired}/${tennisRows.length}, sticky kept: ${compKept}).`,
  )
  // Idempotent rewrite: drop every auto+non-verified row before the upsert
  // so stale ghost matches (lower-conf alternatives, vanished tournaments
  // whose feeds no longer fire, old matcher heuristics) don't survive. The
  // per-tournament cleanup we tried first only covered tournaments with
  // active fixtures this run — Ethiopia Premier League with no live rows
  // still had its June-4 ghost. This wipe covers them all.
  await deleteAllAutoUnverified()
  await upsertAll(
    'competition_mapping?on_conflict=optic_sport,optic_league,optic_tournament,gutsy_competition_id',
    compAutoUpserts,
  )

  // -- Stage 2: events, scoped to each paired competition
  // Index gutsy events by competition_id for quick lookup.
  const gutsyByComp = new Map() // competition_id → events[]
  for (const e of gutsy) {
    const cid = e.competition?.id ?? e.competition?.base_competition_id
    if (!cid) continue
    const list = gutsyByComp.get(cid) ?? []
    list.push(e)
    gutsyByComp.set(cid, list)
  }

  // Map (optic_sport, optic_league, optic_tournament) → list of mapped SWIFT
  // competition ids. With 1-to-N a tournament may pair with multiple comps;
  // events get to choose from any of them. Include results from THIS run plus
  // sticky (manual/verified) rows already in the DB.
  const compIdsByOptic = new Map()
  for (const r of compResults) {
    if (r.gutsy_competition_id) {
      const k = `${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`
      const list = compIdsByOptic.get(k) ?? []
      list.push(r.gutsy_competition_id)
      compIdsByOptic.set(k, list)
    }
  }
  for (const r of await getAllSupabase(
    'competition_mapping?select=optic_sport,optic_league,optic_tournament,gutsy_competition_id',
  )) {
    if (!r.gutsy_competition_id) continue
    const k = `${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`
    const list = compIdsByOptic.get(k) ?? []
    if (!list.includes(r.gutsy_competition_id)) {
      list.push(r.gutsy_competition_id)
      compIdsByOptic.set(k, list)
    }
  }

  // Event matcher: hard gates on BOTH name similarity AND start-time skew.
  // A tennis player or cricket fixture across multiple days has near-identical
  // names — without the time gate, day 1 collides with day 2.
  const MIN_EVENT_SIM = 0.4
  const MAX_START_SKEW_MS = 90 * 60 * 1000
  const eventResults = []
  let opticPairedComp = 0
  for (const r of opticRows) {
    if (!r.optic_fixture_id) continue
    if (r.league && EXCLUDE_LEAGUES.has(r.league)) continue
    const isTennis = (r.sport ?? '').toLowerCase() === 'tennis'
    const tournament = isTennis ? (r.season_type ?? '') : ''
    const cids = compIdsByOptic.get(`${r.sport}|${r.league}|${tournament}`)
    if (!cids || cids.length === 0) {
      eventResults.push({
        optic_fixture_id: r.optic_fixture_id,
        gutsy_event_id: null,
        confidence: 0,
        source: 'auto',
      })
      continue
    }
    opticPairedComp++
    // Pool candidates from every mapped SWIFT competition for this OPTIC tournament.
    const cands = cids.flatMap((cid) => gutsyByComp.get(cid) ?? [])
    const opticTeams = `${r.home_team ?? ''} ${r.away_team ?? ''}`
    const opticStart = r.scheduled_start ? Date.parse(r.scheduled_start) : NaN
    let best = null
    let bestScore = 0
    // Both gates must pass: name similarity ≥ MIN_EVENT_SIM AND start-time skew
    // ≤ MAX_START_SKEW_MS (with both sides having a real start). Final score
    // is name similarity alone, so the closest-name in-window candidate wins.
    if (Number.isFinite(opticStart)) {
      for (const e of cands) {
        const estart = e.start_date ? Date.parse(e.start_date) : NaN
        if (!Number.isFinite(estart)) continue
        if (Math.abs(opticStart - estart) > MAX_START_SKEW_MS) continue
        // Build the candidate participant string. Prefer named Home/Away teams;
        // otherwise fall back to parsing the event name ("Fighter A vs Fighter B").
        // UFC and similar individual-combatant sports leave a single placeholder
        // entry in teams[] (`{name:"Competitors"}`), so checking length alone
        // wasn't enough.
        const named = (e.teams ?? []).filter(
          (t) => t.name && (t.team_position === 'Home' || t.team_position === 'Away'),
        )
        const eteams =
          named.length > 0
            ? named.map((t) => t.name).join(' ')
            : (e.name ?? '').replace(/\s+vs\.?\s+/i, ' ')
        const tsim = sim(opticTeams, eteams)
        if (tsim < MIN_EVENT_SIM) continue
        if (tsim > bestScore) {
          bestScore = tsim
          best = e
        }
      }
    }
    eventResults.push({
      optic_fixture_id: r.optic_fixture_id,
      gutsy_event_id: best ? best._id : null,
      confidence: +bestScore.toFixed(3),
      source: 'auto',
    })
  }
  const eventPaired = eventResults.filter((r) => r.gutsy_event_id).length
  const eventAutoUpserts = eventResults.filter((r) => existingEvent.get(r.optic_fixture_id) !== 'manual')
  const eventManualKept = eventResults.length - eventAutoUpserts.length
  console.log(
    `• Stage 2: ${opticPairedComp}/${eventResults.length} fixtures in mapped competitions, paired ${eventPaired} events (manual kept: ${eventManualKept}).`,
  )
  await upsertAll('event_mapping?on_conflict=optic_fixture_id', eventAutoUpserts)

  console.log('✓ done.')
}

// --- supabase helpers ----------------------------------------------------

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

/**
 * Wipe every auto+non-verified competition_mapping row. Run BEFORE the
 * upsert so the matcher's fresh decisions are the only auto rows in the
 * table. Sticky-manual rows (source='manual') and verified rows are left
 * alone. PostgREST returns 204 on success.
 */
async function deleteAllAutoUnverified() {
  const qs = 'source=eq.auto&verified=eq.false'
  const r = await fetch(`${REST}/competition_mapping?${qs}`, {
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
      headers: {
        ...HDR,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(slice),
    })
    if (!r.ok) bail(`upsert ${pathAndQuery} → ${r.status}: ${await r.text()}`)
  }
}

/** Snapshot SWIFT competitions + events as JSON in public/ for the in-app picker. */
function writeSwiftSnapshots(gutsy) {
  const compMap = new Map() // competition_id → {id, sport, name, n}
  const events = []
  for (const e of gutsy) {
    const cid = e.competition?.id ?? e.competition?.base_competition_id
    const cname = e.competition?.name
    const sname = e.sport?.name
    if (cid && cname) {
      const cur = compMap.get(cid) ?? { id: cid, sport: sname, name: cname, n: 0 }
      cur.n++
      compMap.set(cid, cur)
    }
    if (e._id) {
      let home = (e.teams ?? []).find((t) => t.team_position === 'Home')?.name ?? null
      let away = (e.teams ?? []).find((t) => t.team_position === 'Away')?.name ?? null
      // Some sports (MMA/UFC especially) either leave teams[] empty OR put a
      // single placeholder entry ({name:'Competitors'}) and store the matchup
      // only in the event name as "Fighter A vs Fighter B".
      if (!home && !away && e.name) {
        const m = String(e.name).split(/\s+vs\.?\s+/i)
        if (m.length === 2) {
          home = m[0].trim()
          away = m[1].trim()
        }
      }
      events.push({
        id: e._id,
        cid: cid ?? null,
        competition: cname ?? null,
        sport: sname ?? null,
        name: e.name ?? null,
        home,
        away,
        start: e.start_date ?? null,
        status: e.status ?? null,
      })
    }
  }
  const competitions = [...compMap.values()].sort(
    (a, b) => b.n - a.n || (a.sport ?? '').localeCompare(b.sport ?? '') || a.name.localeCompare(b.name),
  )
  const dir = join(HERE, '..', 'public')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'swift-competitions.json'), JSON.stringify(competitions))
  writeFileSync(join(dir, 'swift-events.json'), JSON.stringify(events))
  console.log(`  wrote ${competitions.length} competitions + ${events.length} events to public/`)
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
  console.error('error:', msg instanceof Error ? msg.stack : msg)
  process.exit(1)
}
