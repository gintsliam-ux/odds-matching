// Client-side port of the competition matcher in scripts/build-mapping.mjs.
// Used by the "AUTO-MAP" toolbar button on the Mapping page so users can
// auto-pair tournaments without dropping to a shell.
//
// Kept deliberately simple: token Jaccard + sport-aware aliasing + tennis
// city/gender/doubles bonuses. Same thresholds as the offline script.

import { swiftSportOf } from './sports'
import type { SwiftCompetition, SwiftEvent } from './swiftCatalog'

// Match offline script thresholds in scripts/build-mapping.mjs.
const MIN_COMP_SIM = 0.4
// Soccer is uniquely promiscuous — universal words like "premier", "league",
// "division", "primera" appear in dozens of country-specific competitions.
// A higher floor + country-mismatch penalty stops e.g. "Ireland - Premier
// League" being auto-paired with South Africa's promotion play-off.
const MIN_COMP_SIM_SOCCER = 0.55
const MIN_TENNIS_SIM = 0.35

/**
 * Country / region tokens that should match exactly. If both sides have a
 * country mention and they don't overlap, the matcher applies a heavy penalty.
 * Multi-word countries ("south africa", "new zealand", "saudi arabia",
 * "costa rica") are matched as bigrams below.
 */
const COUNTRY_TOKENS = new Set([
  'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia', 'australia',
  'austria', 'azerbaijan', 'bahrain', 'belarus', 'belgium', 'bolivia', 'bosnia',
  'botswana', 'brazil', 'bulgaria', 'cambodia', 'cameroon', 'canada', 'chile',
  'china', 'colombia', 'croatia', 'cyprus', 'czech', 'denmark', 'dominican',
  'ecuador', 'egypt', 'england', 'estonia', 'ethiopia', 'faroe', 'fiji', 'finland',
  'france', 'gabon', 'gambia', 'georgia', 'germany', 'ghana', 'greece', 'guatemala',
  'haiti', 'honduras', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq',
  'ireland', 'israel', 'italy', 'jamaica', 'japan', 'jordan', 'kazakhstan', 'kenya',
  'korea', 'kosovo', 'kuwait', 'kyrgyzstan', 'latvia', 'lebanon', 'libya',
  'liechtenstein', 'lithuania', 'luxembourg', 'malaysia', 'maldives', 'mali',
  'malta', 'mauritius', 'mexico', 'moldova', 'monaco', 'mongolia', 'montenegro',
  'morocco', 'mozambique', 'myanmar', 'namibia', 'nepal', 'netherlands',
  'nicaragua', 'nigeria', 'norway', 'oman', 'pakistan', 'palestine', 'panama',
  'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania',
  'rwanda', 'russia', 'scotland', 'senegal', 'serbia', 'singapore', 'slovakia',
  'slovenia', 'somalia', 'spain', 'sudan', 'suriname', 'sweden', 'switzerland',
  'syria', 'taiwan', 'tanzania', 'thailand', 'togo', 'tunisia', 'turkey',
  'turkmenistan', 'uganda', 'ukraine', 'uruguay', 'usa', 'uzbekistan',
  'venezuela', 'vietnam', 'wales', 'yemen', 'zambia', 'zimbabwe',
])
const COUNTRY_BIGRAMS = new Set([
  'south africa', 'south korea', 'new zealand', 'saudi arabia', 'costa rica',
  'sierra leone', 'north macedonia', 'ivory coast',
])

/**
 * Country adjectives → canonical country, so "French Open" extracts as
 * "france" and gets caught by the country gate against "Netherlands" etc.
 * Without this, SwiftBet tennis competitions named after a country adjective
 * ("French Open Women's Doubles") matched OPTIC tournaments in entirely
 * different countries.
 */
const COUNTRY_ADJECTIVES: Record<string, string> = {
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

function extractCountries(s: string): Set<string> {
  const lc = (s ?? '').toLowerCase()
  const out = new Set<string>()
  for (const big of COUNTRY_BIGRAMS) if (lc.includes(big)) out.add(big)
  const words = lc.split(/[^a-z]+/).filter(Boolean)
  for (const w of words) {
    if (COUNTRY_TOKENS.has(w)) out.add(w)
    const adj = COUNTRY_ADJECTIVES[w]
    if (adj) out.add(adj)
  }
  return out
}

/**
 * Pull tier markers — standalone digits, roman numerals II/III, and number
 * words "two"/"three". Used to penalise "Premier League" vs "League Two" or
 * "K-League 2" vs "K3 League" mismatches that share a country.
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  i: 1, ii: 2, iii: 3, iv: 4,
  primera: 1, segunda: 2, tercera: 3,
  premier: 1, premiere: 1, super: 1, championship: 2,
}
function extractTiers(s: string): Set<number> {
  const out = new Set<number>()
  // Normalise underscores/hyphens to spaces — `\b` doesn't fire between `_`
  // and letters because underscore is a word char, so "league_two" wouldn't
  // split on its own. Standalone digits and digit-suffix tokens ("k2", "d2",
  // "u20" → 20) and number words both feed `out`.
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
// Event matcher: hard gates on BOTH name similarity AND start-time skew.
// A tennis player or cricket fixture across multiple days has near-identical
// names — without the time gate, day 1 collides with day 2. Keep the window
// generous enough to absorb feed clock drift (~30 min observed) but well
// short of a day so consecutive-day matchups never collide.
const MIN_EVENT_SIM = 0.4
const MAX_START_SKEW_MS = 90 * 60 * 1000

// OPTIC abbreviations → expanded names that match SWIFT's full names.
// Mirrors LEAGUE_ALIASES in build-mapping.mjs.
const LEAGUE_ALIASES: Record<string, string> = {
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
}

const STOP = new Set([
  'the', 'of', 'and', 'a', 'an', 'de', 'del', 'la', 'le', 'les', 'el', 'en', 'y', 'd', 'dell', 'di',
  'club', 'clube', 'fc', 'cf', 'sc', 'ac', 'bc', 'cd', 'ca', 'cr', 'fr', 'afc', 'football',
  'futbol', 'futebol', 'cup', 'league', 'liga', 'serie', 'division', 'div', 'ii', 'iii', 'jr', 'sr',
  'women', 'men', 'international', 'national', 'professional', 'tournament', 'championship',
  'open', 'presented', 'workday', 'team', 'base',
])

function tokens(s: string): Set<string> {
  return new Set(
    (s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP.has(t)),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
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
function fuzzyCoverage(a: Set<string>, b: Set<string>): number {
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

function sim(aName: string, bName: string): number {
  const a = tokens(aName)
  const b = tokens(bName)
  let s = Math.max(jaccard(a, b), fuzzyCoverage(a, b))
  const al = (aName ?? '').toLowerCase()
  const bl = (bName ?? '').toLowerCase()
  if (al && bl && (al === bl || al.includes(bl) || bl.includes(al))) s = Math.max(s, 0.9)
  // Collapsed-punctuation containment — rescues "la liga" being stopworded to
  // nothing when matched against "LaLiga", or "brazil serie b" against
  // "Série B". NFD strips accents (so `é` becomes `e`), then we drop every
  // non-alphanum so "Série B" → "serieb" and "brazil serie b" → "brazilserieb"
  // (substring match). Length floor (5) keeps tiny shared substrings from
  // triggering false matches.
  const ac = al.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')
  const bc = bl.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')
  if (ac && bc && ac !== bc && Math.min(ac.length, bc.length) >= 5) {
    if (ac.includes(bc) || bc.includes(ac)) s = Math.max(s, 0.9)
  }
  // Country gate: if both sides carry a country name AND none overlap, the
  // shared league terminology is misleading. Apply a heavy penalty so
  // "Ireland - Premier League" doesn't pair with South Africa's "Premier
  // Soccer League". A one-sided country (only OPTIC has it) gets a softer
  // penalty since SWIFT names sometimes omit the country.
  const ca = extractCountries(aName)
  const cb = extractCountries(bName)
  if (ca.size > 0 && cb.size > 0) {
    let overlap = false
    for (const c of ca) if (cb.has(c)) { overlap = true; break }
    if (!overlap) s -= 0.5
  } else if ((ca.size > 0) !== (cb.size > 0)) {
    s -= 0.15
  }
  // Tier gate: if both sides mention a tier number (digit or word) and they
  // don't intersect, the leagues are different divisions despite shared names.
  const ta = extractTiers(aName)
  const tb = extractTiers(bName)
  if (ta.size > 0 && tb.size > 0) {
    let overlap = false
    for (const n of ta) if (tb.has(n)) { overlap = true; break }
    if (!overlap) s -= 0.35
  }
  return Math.max(0, s)
}

/**
 * Full prettified league for matcher input — keeps the country/region prefix
 * ("france ligue 1" instead of just "ligue 1") so SWIFT competitions named
 * "France - Ligue 1" score higher token overlap. The STOP set filters out
 * generic words ("international", "national", …) so common-region rows don't
 * over-match each other.
 */
function prettyOpticLeague(raw: string): string {
  if (!raw) return ''
  return raw.replace(/_-_/g, ' ').replace(/_/g, ' ').trim().toLowerCase()
}

function aliasExpand(s: string): string {
  if (!s) return ''
  const k = s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  return LEAGUE_ALIASES[k] ?? s
}

// --- tennis-specific (mirrors build-mapping.mjs) -------------------------

function parseTennisTournament(league: string, seasonType: string) {
  const l = (league ?? '').toLowerCase()
  const s = seasonType ?? ''
  const isDoubles = /_doubles|, doubles$| doubles\b/i.test(`${l} ${s}`)
  let gender: 'men' | 'women' | null = null
  if (l.startsWith('wta')) gender = 'women'
  else if (l.startsWith('atp')) gender = 'men'
  else if (l.includes('_women') || / women\b/i.test(s)) gender = 'women'
  else if (l.includes('_men') || / men\b/i.test(s)) gender = 'men'
  const firstPiece = s.split(',')[0].trim()
  return { league: l, seasonType: s, isDoubles, gender, city: firstPiece, full: s }
}

function scoreTennis(ot: ReturnType<typeof parseTennisTournament>, gutsyComp: string): number {
  const gc = (gutsyComp ?? '').toLowerCase()
  const baseA = sim(ot.city, gutsyComp)
  const baseB = sim(ot.full, gutsyComp)
  let s = Math.max(baseA, baseB)
  const cityLower = ot.city.toLowerCase()
  if (cityLower.length >= 3 && gc.includes(cityLower)) s = Math.max(s, 0.7)
  const gcDoubles = / doubles\b/.test(gc)
  if (ot.isDoubles && !gcDoubles) s -= 0.4
  if (!ot.isDoubles && gcDoubles) s -= 0.4
  if (ot.gender === 'women' && /\bwomen|women's\b/.test(gc)) s += 0.15
  if (ot.gender === 'men' && /\bmen|men's\b/.test(gc) && !/women/.test(gc)) s += 0.15
  if (ot.gender === 'women' && /\bmen's\b/.test(gc) && !/women/.test(gc)) s -= 0.3
  if (ot.gender === 'men' && /\bwomen|women's\b/.test(gc)) s -= 0.3
  return Math.max(0, Math.min(1, s))
}

// -----------------------------------------------------------------------

export interface AutoMatchResult {
  competition: SwiftCompetition
  confidence: number
}

/** Compute the best SWIFT competition for an OPTIC tournament. Returns null
 *  when no candidate clears the (sport-dependent) confidence threshold. */
export function bestSwiftMatch(args: {
  opticSportRaw: string
  opticLeagueRaw: string
  opticTournamentRaw: string // tennis season_type, '' otherwise
  catalog: SwiftCompetition[]
}): AutoMatchResult | null {
  const swiftSport = swiftSportOf(args.opticSportRaw)
  if (!swiftSport) return null
  const cands = args.catalog.filter(
    (c) => (c.sport ?? '').toLowerCase() === swiftSport.toLowerCase(),
  )
  if (cands.length === 0) return null

  const isTennis = args.opticSportRaw.toLowerCase() === 'tennis'
  const isSoccer = args.opticSportRaw.toLowerCase() === 'soccer'
  const threshold = isTennis ? MIN_TENNIS_SIM : isSoccer ? MIN_COMP_SIM_SOCCER : MIN_COMP_SIM
  let best: SwiftCompetition | null = null
  let bestScore = 0

  if (isTennis) {
    const ot = parseTennisTournament(args.opticLeagueRaw, args.opticTournamentRaw)
    for (const c of cands) {
      const s = scoreTennis(ot, c.name)
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
  } else {
    const raw = prettyOpticLeague(args.opticLeagueRaw)
    const aliased = aliasExpand(args.opticLeagueRaw) || aliasExpand(raw)
    for (const c of cands) {
      const s = Math.max(sim(raw, c.name), sim(aliased, c.name))
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
  }

  return best && bestScore >= threshold ? { competition: best, confidence: +bestScore.toFixed(3) } : null
}

export interface EventMatchResult {
  event: SwiftEvent
  confidence: number
}

/**
 * Best SWIFT event match for a single OPTIC fixture among the supplied
 * candidates. Mirrors stage 2 in scripts/build-mapping.mjs.
 *
 * Both gates must pass before a candidate can win:
 *   1. Name similarity ≥ MIN_EVENT_SIM (team tokens or event-name fallback).
 *   2. |start_time skew| ≤ MAX_START_SKEW_MS (and both sides must have a start).
 *
 * The final score is name similarity alone, so among in-window candidates the
 * closest name wins. Without the time gate, multi-day fixtures (cricket tests,
 * back-to-back tennis rounds) collide on identical team names.
 */
export function bestSwiftEventMatch(args: {
  opticHome: string
  opticAway: string
  opticStartIso: string | null
  candidates: SwiftEvent[]
}): EventMatchResult | null {
  if (args.candidates.length === 0) return null
  const opticTeams = `${args.opticHome ?? ''} ${args.opticAway ?? ''}`
  const opticStart = args.opticStartIso ? Date.parse(args.opticStartIso) : NaN
  if (!Number.isFinite(opticStart)) return null // no start → can't confirm day
  let best: SwiftEvent | null = null
  let bestScore = 0
  for (const e of args.candidates) {
    const estart = e.start ? Date.parse(e.start) : NaN
    if (!Number.isFinite(estart)) continue
    if (Math.abs(opticStart - estart) > MAX_START_SKEW_MS) continue
    // Mirror the matcher: prefer real Home/Away team names; otherwise parse
    // the SWIFT event name ("Fighter A vs Fighter B") for placeholder-team rows.
    let eteams = ''
    if (e.home && e.away) eteams = `${e.home} ${e.away}`
    else if (e.name) eteams = e.name.replace(/\s+vs\.?\s+/i, ' ')
    const tsim = sim(opticTeams, eteams)
    if (tsim < MIN_EVENT_SIM) continue
    if (tsim > bestScore) {
      bestScore = tsim
      best = e
    }
  }
  return best ? { event: best, confidence: +bestScore.toFixed(3) } : null
}
