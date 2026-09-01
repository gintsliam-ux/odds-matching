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

/** How far back a fixture is still worth loading for matching. Comfortably
 *  clears the event window while keeping the query near the old table's size. */
const MATCH_HORIZON_D = 45

const REST = `${SUP_URL}/rest/v1`
const HDR = { apikey: SUP_KEY, Authorization: `Bearer ${SUP_KEY}` }

// OpticOdds sport slug → canonical name(s) for the target side. The
// canonical name is matched (case-insensitive) against gutsy `sport.name`.
// OPTIC leagues we never map — ITF / UTR tennis tiers don't appear in gutsy
// and would just clutter the mapping table with permanently-unmapped rows.
export const EXCLUDE_LEAGUES = new Set(['itf_men', 'itf_women', 'utr_men', 'utr_women'])

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
  // "Football" is SOCCER here, not gridiron. SwiftBet labels its second-biggest
  // sport that way — 3,620 events — while OPTIC has never once emitted
  // `sport=football` (0 rows in live_fixtures and fixtures alike; it uses
  // `soccer`, `ucl`, `laliga`, `epl`, `seriea`). Canonicalising it to american
  // football meant SwiftBet's entire soccer catalogue could not match OPTIC
  // soccer at all, which is why that pairing sat at 3%. Gridiron is covered by
  // the four aliases below.
  football: 'football',
  americanfootball: 'american football',
  amfootball: 'american football',
  nfl: 'american football',
  cfl: 'american football',
  // mybet's label for the sport. Without it `gridiron` canonicalised to
  // itself, never equalled `american football`, and every one of mybet's
  // Gridiron events sat unmatchable against OPTIC's amfootball/nfl fixtures —
  // the sport read 0% mapped on both providers while 376 candidates were
  // sitting in the feed.
  gridiron: 'american football',
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

export function canonSport(s) {
  if (!s) return ''
  const k = s.toLowerCase().replace(/[^a-z]/g, '')
  return SPORT_MAP[k] ?? s.toLowerCase().replace(/_/g, ' ').trim()
}

// "france_-_ligue_1" → "france ligue 1"; keeps the country/region prefix so
// SWIFT competitions named "France - Ligue 1" score higher token overlap.
export function prettyOpticLeague(raw) {
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

export function aliasExpand(s) {
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

export function tokens(s) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

export function jaccard(a, b) {
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
export function fuzzyCoverage(a, b) {
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
  // Trailing (?![a-z0-9]) — not just (?![a-z]) — so a YEAR can't masquerade as
  // a tier. "Serena Wines 1881" used to yield 18 from the leading "18", which
  // now that the gate is a hard reject would wrongly kill real matches.
  for (const m of lc.matchAll(/(?:^|[^a-z0-9])([a-z]?(\d{1,2}))(?![a-z0-9])/gi)) {
    const n = parseInt(m[2], 10)
    if (Number.isFinite(n) && n >= 1 && n <= 30) out.add(n)
  }
  for (const m of lc.matchAll(/[a-z]+/g)) {
    const n = NUMBER_WORDS[m[0]]
    if (n) out.add(n)
  }
  return out
}

export function sim(aName, bName) {
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
  // Tier gate — HARD reject, not a penalty. tokens() drops tokens shorter than
  // 2 chars and "league" is a stop word, so "England League 2" and "England
  // League 3" both reduce to {england} and score a perfect 1.0 on name
  // similarity. A -0.35 nudge left that at 0.65, clearing the 0.55 soccer
  // threshold and mapping League 2 onto League 3. The tier is the ONLY thing
  // distinguishing two divisions of the same competition, so a mismatch has to
  // be decisive. One-sided tiers stay unpenalised: plenty of legitimate pairs
  // name the tier on one side only ("T20 Blast" ↔ "Vitality Blast").
  const ta = extractTiers(aName)
  const tb = extractTiers(bName)
  if (ta.size > 0 && tb.size > 0) {
    let overlap = false
    for (const n of ta) if (tb.has(n)) { overlap = true; break }
    if (!overlap) return 0
  }
  return Math.max(0, s)
}

// --- event (participant) matching ----------------------------------------
//
// Competition names and PARTICIPANT names need different scoring. sim() treats
// both sides as one bag of words, which for events throws away the pairing:
// "Tampa Bay Rays + New York Yankees" vs "Kansas City Royals + New York Mets"
// scores the same 0.333 as "Essendon + GWS GIANTS" vs "Essendon + Greater
// Western Sydney" — one shares an incidental "New York", the other is a real
// match. Scoring the two participants pairwise separates them.

/** True when a short token on one side is the initials of the other side —
 *  "GWS" ↔ Greater Western Sydney, "CRB" ↔ Clube de Regatas Brasil, "HB" ↔
 *  Havnar Bóltfelag. Pure token similarity scores these ZERO, and they were a
 *  large share of the misses that had to be mapped by hand. */
export function acronymMatch(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  for (const [x, y] of [
    [A, B],
    [B, A],
  ]) {
    if (y.length < 2) continue
    const ini = y.map((t) => t[0]).join('')
    for (const t of x) if (t.length >= 2 && t.length <= 5 && t === ini) return true
  }
  return false
}

/** Similarity for ONE participant name. Deliberately skips sim()'s country and
 *  tier gates: those exist for competitions and misfire on team names (a tier
 *  gate would hard-reject "Bayern II" vs "Bayern 2"). */
export function participantSim(a, b) {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  if (A.size === 0 || B.size === 0) return 0
  let s = Math.max(jaccard(A, B), fuzzyCoverage(A, B))
  const al = (a ?? '').toLowerCase()
  const bl = (b ?? '').toLowerCase()
  if (al && bl && (al === bl || al.includes(bl) || bl.includes(al))) s = Math.max(s, 0.95)
  if (acronymMatch(a, b)) s = Math.max(s, 0.9)
  return s
}

/** Pairwise score for a fixture: both participants must match, in either
 *  orientation (feeds disagree on home/away often enough). min() is the point —
 *  one strong side can't carry a mismatched other side. */
/**
 * The grade a fixture is played at: senior / women / an age group / reserves.
 *
 * Two clubs meet more than once on the same day — the women's match before the
 * men's, the U23s before the seniors — and the team names are otherwise
 * identical. mybet's event matcher pools candidates by sport+day with no
 * competition gate, so both are candidates for the same OPTIC fixture, and the
 * tokens that tell them apart ("W", "U23", "2") are exactly the ones team-name
 * similarity throws away: measured 30 same-day cross-division pairs scoring
 * 1.00, 25 of them 2-6h apart where the wide band is supposed to be strict.
 *
 * Read from the LEAGUE as well as the team names, because the two feeds put it
 * in different places. OPTIC writes the age group into the team ("Chapecoense
 * U20") but puts women in the league (`england_-_the_hundred_women`, teams
 * "Manchester Originals" v "Welsh Fire"); mybet writes it into the team
 * ("Southern Brave W"). Reading only one side would reject every correct
 * women's pairing.
 */
export function gradeKey(teamA, teamB, league) {
  // Fold diacritics FIRST. Stripping non-letters straight away turns "Wisła
  // Kraków" into "wis a krak w", and that stray "w" reads as a women's marker —
  // every Polish, Czech and Turkish club name became a women's fixture.
  const norm = (v) =>
    ' ' +
    String(v ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[øØ]/g, 'o')
      .replace(/[łŁ]/g, 'l')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() +
    ' '
  const all = norm([teamA, teamB, league].filter(Boolean).join(' '))
  // Competitions that are women's without saying so. Without these the gate
  // reads OPTIC's `wnba` as silent and mybet's "… - Womens" as women's, and
  // rejects 153 correct WNBA/NRLW/NWSL mappings. WAFL is deliberately absent —
  // it is men's Australian football.
  const womensComp = /\b(wnba|nrlw|nwsl|wbbl|wnbl|awsl)\b/.test(all)
  const women = womensComp || /\b(w|women|womens|ladies|femenino|feminino|feminine|damen)\b/.test(all)
  // Second string, however the feed spells it. The two sides label the same
  // side differently — OPTIC "Sydney FC Academy" and "Brisbane Roar Youth"
  // against mybet "Sydney FC U23" and "Brisbane Roar U23" — so an age number
  // and a word like Academy/Youth/Reserve collapse to ONE marker rather than
  // being compared to each other.
  const isSecond = (v) => {
    const t = norm(v).trim()
    return /\b(reserves?|ii|2)$/.test(t) || /\b(reserves?|academy|youth|dev)\b/.test(norm(v)) || /\bu\s?(1[5-9]|2[0-3])\b/.test(norm(v))
  }
  const second = isSecond(teamA) || isSecond(teamB) || /\b(reserves?|academy|youth)\b/.test(norm(league)) || /\bu\s?(1[5-9]|2[0-3])\b/.test(norm(league))
  return `${women ? 'w' : ''}|${second ? '2' : ''}`
}

export function eventPairSim(oHome, oAway, eHome, eAway) {
  const direct = Math.min(participantSim(oHome, eHome), participantSim(oAway, eAway))
  const swapped = Math.min(participantSim(oHome, eAway), participantSim(oAway, eHome))
  return Math.max(direct, swapped)
}

/** Split a candidate into its two participants. */
export function eventParticipants(e) {
  const named = (e.teams ?? []).filter(
    (t) => t.name && (t.team_position === 'Home' || t.team_position === 'Away'),
  )
  if (named.length >= 2) return [named[0].name, named[1].name]
  const all = (e.teams ?? []).map((t) => t.name).filter(Boolean)
  if (all.length >= 2) return [all[0], all[1]]
  const parts = String(e.name ?? '').split(/\s+vs\.?\s+/i)
  return parts.length >= 2 ? [parts[0], parts[1]] : [String(e.name ?? ''), '']
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

  // Doubles vs singles is a HARD gate, not a penalty: a doubles tournament must
  // never bind to a singles competition (or vice versa), even when the city name
  // matches. A −0.4 penalty still let same-city singles comps win on the city
  // bonus (e.g. "Palermo, Doubles" → "34 Palermo Ladies Open").
  const gcDoubles = / doubles\b/.test(gc)
  if (ot.isDoubles !== gcDoubles) return 0

  // qualifying vs main draw must match too — else a main-draw tournament
  // ("Berlin, Germany") wrongly binds to "…Qualification" (same city bonus).
  const optQual = /qualif/i.test(ot.full)
  const gcQual = /qualif/i.test(gc)
  if (optQual !== gcQual) s -= 0.4

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
if (IS_CLI)
  main({ writeSnapshot: true }).catch((e) => {
    console.error('error:', e instanceof Error ? e.stack : e)
    process.exit(1)
  })

export async function runMapping(opts = {}) {
  return main({ writeSnapshot: false, ...opts })
}

async function main(opts = { writeSnapshot: true }) {
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
  // Filtered server-side. `fixtures` now has an index covering
  // (source, scheduled_start), so the date filter no longer statement-timeouts
  // and this fetches ~5k rows instead of paging all ~18k — which is what kept
  // the matcher over its budget on Vercel even after the index landed.
  const horizon = new Date(Date.now() - MATCH_HORIZON_D * 86_400_000).toISOString()
  const opticRows = (
    await getAllSupabase(
      'fixtures?select=fixture_id,optic_fixture_id:fixture_id,sport,league:optic_league,season_type,home_team,away_team,scheduled_start' +
        `&source=eq.optic&scheduled_start=gte.${horizon}`,
      // Seek on the REAL column: `order=`/`gt.` resolve against the table, so
      // the aliased name 400s with "column does not exist".
      'fixture_id',
    )
  ).filter((r) => r.optic_fixture_id)
  console.log(`  ${opticRows.length} fixtures.`)

  console.log('• Loading gutsy.events from Mongo…')
  // Small pool + finally-close: this reads the collection once, sequentially, so
  // one connection is plenty — and Atlas is shared with the scrapers, so a
  // client leaked by a mid-run throw on a warm instance must not accumulate.
  const mongo = new MongoClient(MONGO_URI, { maxPoolSize: 5 })
  let gutsy
  try {
    await mongo.connect()
    gutsy = await mongo
      .db(MONGO_DB)
      .collection(MONGO_COLL)
      .find(
        {},
        { projection: { _id: 1, name: 1, sport: 1, competition: 1, teams: 1, start_date: 1, status: 1 } },
      )
      .toArray()
  } finally {
    await mongo.close().catch(() => {})
  }
  // Drop FUTURES competitions. "NBA 2025/26 Futures", "EPL 2026/27 Futures",
  // "Wimbledon 2026 Futures" are outright/antepost markets on a season, not
  // fixtures — there is no game for an OPTIC fixture to pair with, so they only
  // pollute the candidate pool. They also mis-pair: `icehockey_nhl` was mapped
  // to "NHL 2026 Futures" rather than the NHL competition itself.
  const beforeFutures = gutsy.length
  gutsy = gutsy.filter((e) => !IS_FUTURES.test(e?.competition?.name ?? ''))
  if (beforeFutures !== gutsy.length) {
    console.log(`  dropped ${beforeFutures - gutsy.length} futures/outright events.`)
  }
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
  // Competitions already held by a verified/manual mapping — off-limits to AUTO
  // matches so a competition attaches to only one OPTIC tournament (e.g. "Série
  // B", verified on Brazil, won't fuzzy-attach to Ecuador - Serie B).
  const stickyCompIds = new Set()
  for (const r of await getAllSupabase(
    'competition_mapping?provider=eq.swift&select=id,optic_sport,optic_league,optic_tournament,gutsy_competition_id,source,verified',
  )) {
    const k = `${r.optic_sport}|${r.optic_league}|${r.optic_tournament}`
    const cur = compStatus.get(k) ?? { hasSticky: false, hasAuto: false, hasManual: false }
    if (r.source === 'manual' || r.verified) cur.hasSticky = true
    if (r.source === 'manual') cur.hasManual = true
    if (r.source !== 'manual' && !r.verified) cur.hasAuto = true
    if ((r.source === 'manual' || r.verified) && r.gutsy_competition_id) stickyCompIds.add(r.gutsy_competition_id)
    compStatus.set(k, cur)
  }
  const existingEvent = new Map(
    (await getAllSupabase('event_mapping?provider=eq.swift&select=id,optic_fixture_id,source')).map((r) => [r.optic_fixture_id, r.source]),
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

  // 1:1 for AUTO matches — a competition attaches to only ONE tournament. Drop
  // it from an auto result if it's already held by a verified/manual mapping, or
  // if another auto tournament matched it more confidently (ties → first). This
  // kills fuzzy "already-mapped-elsewhere" matches (Ecuador→Série B, etc.).
  {
    const claimed = new Set()
    const winners = new Set()
    for (const r of [...compResults].sort((a, b) => b.confidence - a.confidence)) {
      if (!r.gutsy_competition_id || stickyCompIds.has(r.gutsy_competition_id)) continue
      if (claimed.has(r.gutsy_competition_id)) continue
      claimed.add(r.gutsy_competition_id)
      winners.add(r)
    }
    for (const r of compResults) {
      if (r.gutsy_competition_id && !winners.has(r)) {
        r.gutsy_sport = null
        r.gutsy_competition = null
        r.gutsy_competition_id = null
      }
    }
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
    .map((r) => ({ ...r, provider: 'swift', gutsy_competition_id: r.gutsy_competition_id ?? '' }))
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
    'competition_mapping?on_conflict=provider,optic_sport,optic_league,optic_tournament,gutsy_competition_id',
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

  // Tennis is matched by PLAYER NAMES + start time across the WHOLE sport, not
  // scoped to a paired competition: OPTIC labels tournaments by city
  // ("Berlin, Germany") while SWIFT uses sponsor names ("Berlin Tennis Open by
  // HYLO"), so competition mapping is too unreliable to gate events on. Index
  // all SWIFT tennis events by UTC day for a fast same-window candidate pool.
  const tennisByDay = new Map() // 'YYYY-MM-DD' → events[]
  for (const e of gutsy) {
    if ((e.sport?.name ?? '').toLowerCase() !== 'tennis' || !e.start_date) continue
    const day = String(e.start_date).slice(0, 10)
    const list = tennisByDay.get(day) ?? []
    list.push(e)
    tennisByDay.set(day, list)
  }
  const tennisCandidates = (startMs) => {
    const out = []
    for (let off = -1; off <= 1; off++) {
      const k = new Date(startMs + off * 86_400_000).toISOString().slice(0, 10)
      const list = tennisByDay.get(k)
      if (list) out.push(...list)
    }
    return out
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
    'competition_mapping?provider=eq.swift&select=id,optic_sport,optic_league,optic_tournament,gutsy_competition_id',
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
  // Beyond the tight window, out to WIDE, only a near-exact name is accepted.
  // Measured on live data: 68 additional correct matches, 2 pre-existing WRONG
  // mappings corrected, 0 regressions across ~3000 known-good pairs.
  const MAX_START_SKEW_WIDE_MS = 6 * 60 * 60 * 1000
  const MIN_EVENT_SIM_WIDE = 0.9
  // Candidate pairs first, assignment second — the same 1:1 rule stage 1 uses
  // for competitions. A fixture used to take its best event with no regard for
  // what any other fixture had taken, so two fixtures could claim the SAME
  // SwiftBet event. One event is one game, so at least one of each pair was
  // wrong, and a wrong pairing attributes real bets to the wrong fixture.
  const pairs = []
  const reached = []
  const eventResults = []
  let opticPairedComp = 0
  for (const r of opticRows) {
    if (!r.optic_fixture_id) continue
    if (r.league && EXCLUDE_LEAGUES.has(r.league)) continue
    const isTennis = (r.sport ?? '').toLowerCase() === 'tennis'
    const opticStart = r.scheduled_start ? Date.parse(r.scheduled_start) : NaN
    // Tennis: pool ALL same-window SWIFT tennis events (player+time match, no
    // competition gate). Everything else: pool the paired competitions' events.
    let cands
    if (isTennis) {
      cands = Number.isFinite(opticStart) ? tennisCandidates(opticStart) : []
    } else {
      const cids = compIdsByOptic.get(`${r.sport}|${r.league}|`)
      cands = cids && cids.length ? cids.flatMap((cid) => gutsyByComp.get(cid) ?? []) : []
    }
    if (!cands.length) {
      eventResults.push({
        optic_fixture_id: r.optic_fixture_id,
        gutsy_event_id: null,
        confidence: 0,
        source: 'auto',
      })
      continue
    }
    opticPairedComp++
    const opticTeams = `${r.home_team ?? ''} ${r.away_team ?? ''}`
    // Time and name are gated JOINTLY. A tight window needs only a loose name
    // match; beyond it the name must be near-exact. Scheduled times for boxing
    // undercards, UFC prelims and tennis "not before" slots routinely drift 2-4
    // hours, and a flat 90-min gate silently discarded exact-name candidates —
    // it even mapped "Mattia Bellucci v Zachary Svajda" onto "Pablo Llamas Ruiz
    // v Zachary Svajda" because the real event sat 130 min out.
    if (Number.isFinite(opticStart)) {
      for (const e of cands) {
        const estart = e.start_date ? Date.parse(e.start_date) : NaN
        if (!Number.isFinite(estart)) continue
        const skew = Math.abs(opticStart - estart)
        if (skew > MAX_START_SKEW_WIDE_MS) continue
        const [eHome, eAway] = eventParticipants(e)
        // Best of the old bag-of-words score and the pairwise one: the bag
        // still wins on some shapes, so take the max rather than replacing it.
        const tsim = Math.max(
          sim(opticTeams, `${eHome} ${eAway}`),
          eventPairSim(r.home_team, r.away_team, eHome, eAway),
        )
        const floor = skew <= MAX_START_SKEW_MS ? MIN_EVENT_SIM : MIN_EVENT_SIM_WIDE
        if (tsim < floor) continue
        pairs.push({ fixture: r.optic_fixture_id, event: e, score: tsim, skew })
      }
    }
    reached.push(r.optic_fixture_id)
  }

  // Strongest claim first; ties go to the nearer start time, which is what the
  // per-fixture tie-break did — identical names on a rescheduled slot should
  // still resolve to the closest candidate.
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
    })
  }
  const eventPaired = eventResults.filter((r) => r.gutsy_event_id).length
  const eventAutoUpserts = eventResults.filter((r) => existingEvent.get(r.optic_fixture_id) !== 'manual')
  const eventManualKept = eventResults.length - eventAutoUpserts.length
  console.log(
    `• Stage 2: ${opticPairedComp}/${eventResults.length} fixtures in mapped competitions, paired ${eventPaired} events (manual kept: ${eventManualKept}).`,
  )
  await upsertAll('event_mapping?on_conflict=provider,optic_fixture_id', eventAutoUpserts.map((r) => ({ ...r, provider: 'swift' })))

  // -- Stage 3: confirm competitions from where their events actually land.
  // High-confidence event matches are ground truth, so:
  //  • TENNIS — competition names never align (city vs sponsor), so DERIVE the
  //    competition from the dominant landing-spot of the events and fix+verify
  //    it (replacing a wrong/missing name-match like "Halle"→Tucuman).
  //  • Everything else — events are pooled from the mapped competition, so we
  //    just verify the pairing once enough events confirm it.
  // Manual rows are never touched.
  const VERIFY_CONF = 0.9
  const MIN_VERIFY = 3
  const stamp = new Date().toISOString()
  const eventById = new Map(eventResults.map((r) => [r.optic_fixture_id, r]))
  const evtComp = new Map() // gutsy_event_id → { cid, name, sport }
  for (const e of gutsy) {
    const cid = e.competition?.id
    if (cid) evtComp.set(String(e._id), { cid, name: e.competition?.name ?? null, sport: e.sport?.name ?? null })
  }

  // Tally, per OPTIC tournament, which SWIFT competition its high-conf events landed in.
  const tourTally = new Map() // key → Map(cid → { n, name, sport, sport_optic, league, tournament })
  for (const r of opticRows) {
    if (!r.sport || !r.league) continue
    const isTennis = r.sport.toLowerCase() === 'tennis'
    const tournament = isTennis ? (r.season_type ?? '') : ''
    if (isTennis && !tournament) continue
    const er = eventById.get(r.optic_fixture_id)
    if (!er?.gutsy_event_id || er.confidence < VERIFY_CONF) continue
    const ec = evtComp.get(String(er.gutsy_event_id))
    if (!ec) continue
    const key = `${r.sport}|${r.league}|${tournament}`
    let m = tourTally.get(key)
    if (!m) tourTally.set(key, (m = new Map()))
    const cur = m.get(ec.cid) ?? { n: 0, name: ec.name, sport: ec.sport, league: r.league, tournament }
    cur.n++
    m.set(ec.cid, cur)
  }

  let verified = 0
  let fixed = 0
  for (const [key, m] of tourTally) {
    const [optic_sport, optic_league, optic_tournament] = key.split('|')
    if (compStatus.get(key)?.hasManual) continue // never override a human mapping
    // dominant landing competition
    let domCid = null
    let dom = null
    for (const [cid, info] of m) if (!dom || info.n > dom.n) { dom = info; domCid = cid }
    if (!dom || dom.n < MIN_VERIFY) continue
    const isTennis = canonSport(optic_sport) === 'tennis'

    if (isTennis) {
      // Upsert the evidence-derived mapping (fixes wrong/missing), verified.
      await upsertAll('competition_mapping?on_conflict=provider,optic_sport,optic_league,optic_tournament,gutsy_competition_id', [{
        provider: 'swift', optic_sport, optic_league, optic_tournament,
        gutsy_sport: dom.sport, gutsy_competition: dom.name, gutsy_competition_id: domCid,
        confidence: 1, source: 'auto', verified: true, verified_at: stamp,
      }])
      // Remove any other AUTO rows for this tournament (stale/wrong guesses).
      const del = new URLSearchParams({
        provider: 'eq.swift', optic_sport: `eq.${optic_sport}`, optic_league: `eq.${optic_league}`,
        optic_tournament: `eq.${optic_tournament}`, source: 'eq.auto', gutsy_competition_id: `neq.${domCid}`,
      })
      await fetch(`${REST}/competition_mapping?${del}`, { method: 'DELETE', headers: { ...HDR, Prefer: 'return=minimal' } })
      fixed++
    } else {
      // Non-tennis: events only match when they're in the mapped competition
      // (Stage 2 pools candidates from it), so ≥3 high-conf hits prove the
      // pairing is right — verify the tournament's auto mapping(s).
      const q = new URLSearchParams({
        provider: 'eq.swift', optic_sport: `eq.${optic_sport}`, optic_league: `eq.${optic_league}`,
        optic_tournament: `eq.${optic_tournament}`, source: 'eq.auto',
      })
      await fetch(`${REST}/competition_mapping?${q}`, {
        method: 'PATCH', headers: { ...HDR, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ verified: true, verified_at: stamp }),
      })
    }
    verified++
  }
  console.log(`• Stage 3: confirmed ${verified} competitions from event evidence (tennis fixed/derived: ${fixed}).`)

  console.log('✓ done.')
}

// --- supabase helpers ----------------------------------------------------

/**
 * Page a table, seeking on a unique key rather than OFFSET.
 *
 * OFFSET pagination collapses on this database. Measured over 20 samples per
 * offset against `fixtures` (~97k rows):
 *
 *     offset      0    20/20 ok   0.10s
 *     offset 20,000     8/20 ok   2.06s
 *     offset 50,000     0/20 ok   3.21s   ← statement timeout, 57014
 *
 * Postgres has to walk every skipped row to honour an OFFSET, so the deeper
 * the page the longer the scan, until it exceeds the statement timeout. The
 * matcher pages the whole table, so it died partway through every run — which
 * is what had mapping-tick alerting.
 *
 * Seeking instead (`key > last-seen`) reads an index range whatever the depth,
 * so page 90 costs the same as page 1. `keyCol` must be UNIQUE and match the
 * sort, or rows are skipped or repeated.
 */
async function getAllSupabase(pathAndQuery, keyCol = 'id') {
  const rows = []
  const size = 1000
  let after = null
  for (;;) {
    const sep = pathAndQuery.includes('?') ? '&' : '?'
    const seek = after == null ? '' : `&${keyCol}=gt.${encodeURIComponent(after)}`
    const url = `${REST}/${pathAndQuery}${sep}order=${keyCol}.asc&limit=${size}${seek}`
    const r = await fetchRetry(url, { headers: HDR })
    if (!r.ok) bail(`GET ${pathAndQuery} → ${r.status}: ${await r.text()}`)
    const batch = await r.json()
    rows.push(...batch)
    if (batch.length < size) break
    const last = batch[batch.length - 1]
    // The key must be in the projection, or this loops on the same page.
    const next = last?.[keyCol]
    if (next == null) bail(`getAllSupabase: '${keyCol}' missing from ${pathAndQuery} — add it to the select`)
    after = next
  }
  return rows
}

/**
 * Wipe every auto+non-verified competition_mapping row. Run BEFORE the
 * upsert so the matcher's fresh decisions are the only auto rows in the
 * table. Sticky-manual rows (source='manual') and verified rows are left
 * alone. PostgREST returns 204 on success.
 */
/**
 * Sports the matcher does not process, and whose mappings it must therefore
 * never delete.
 *
 * The cleanup below clears every auto row so the upsert that follows is the
 * only source of auto mappings — correct, but only for sports this script
 * actually rebuilds. Golf is not one: it has no rows in `live_fixtures` at all
 * (its OPTIC side is the `golf_outrights` price table), so the matcher can
 * neither see it nor recreate it. Golf mappings made in the UI were being
 * wiped within five minutes by the next mapping-tick and silently reverting to
 * Unmapped.
 */
/** Season-long outright markets, not fixtures. Matched on the competition name
 *  because that is where both books put it: "AFL Futures", "NFL 2027 Futures". */
const IS_FUTURES = /\bfutures?\b/i

const UNMANAGED_SPORTS = ['golf']
const UNMANAGED_FILTER = `&optic_sport=not.in.(${UNMANAGED_SPORTS.join(',')})`

async function deleteAllAutoUnverified() {
  const qs = `provider=eq.swift&source=eq.auto&verified=eq.false${UNMANAGED_FILTER}`
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
    // Resolve the two competitors first: teams[] positions, else parse the event
    // name ("Fighter A vs Fighter B" for MMA/UFC where teams[] is empty or a
    // single {name:'Competitors'} placeholder).
    let home = (e.teams ?? []).find((t) => t.team_position === 'Home')?.name ?? null
    let away = (e.teams ?? []).find((t) => t.team_position === 'Away')?.name ?? null
    if (!home && !away && e.name) {
      const m = String(e.name).split(/\s+vs\.?\s+/i)
      if (m.length === 2) {
        home = m[0].trim()
        away = m[1].trim()
      }
    }
    // Outrights/futures ("2026 Brownlow Medal Winner", "NFL 2027 Season
    // Outrights") have no two competitors — never a valid target for an OPTIC
    // head-to-head fixture. Skip them so the picker and competition counts only
    // reflect matchable events; competitions that are purely futures drop out.
    if (!home || !away) continue

    const cid = e.competition?.id ?? e.competition?.base_competition_id
    const cname = e.competition?.name
    const sname = e.sport?.name
    if (cid && cname) {
      const cur = compMap.get(cid) ?? { id: cid, sport: sname, name: cname, n: 0 }
      cur.n++
      compMap.set(cid, cur)
    }
    if (e._id) {
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

// Always THROW — never process.exit(). This module is imported by the Vercel
// functions (/api/mapping-tick, /api/cron/build-mapping), where an exit() kills
// the whole instance: the caller's try/catch never runs, so the response is a
// bare FUNCTION_INVOCATION_FAILED 500 with the reason visible only in Vercel's
// runtime logs. Throwing lets the handler return the actual message.
function bail(msg) {
  throw msg instanceof Error ? msg : new Error(String(msg))
}

/** fetch + bounded retry on the transient failures that were 500-ing the tick:
 *  network resets and Supabase 5xx/429. Every caller here is idempotent
 *  (paginated reads, filtered delete, merge-duplicates upsert), so a replay is
 *  always safe. 4xx is returned as-is — that's a real bug, not a blip. */
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
