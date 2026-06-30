// Sport → emoji glyph for the card header, plus display prettifiers for the
// slug-style sport/league strings the feed uses ("rugby_union", "france_-_ligue_1").

const EMOJI: Record<string, string> = {
  // soccer family
  soccer: '⚽',
  ucl: '⚽',
  // american football family
  football: '🏈',
  americanfootball: '🏈',
  amfootball: '🏈',
  nfl: '🏈',
  cfl: '🏈',
  // basketball family
  basketball: '🏀',
  wnba: '🏀',
  nba: '🏀',
  // baseball family
  baseball: '⚾',
  mlb: '⚾',
  kbo: '⚾',
  npb: '⚾',
  // ice hockey family
  hockey: '🏒',
  icehockey: '🏒',
  nhl: '🏒',
  // rugby / afl
  rugby: '🏉',
  rugbyunion: '🏉',
  rugbyleague: '🏉',
  nrl: '🏉',
  afl: '🏉',
  // racket / striking / target
  tennis: '🎾',
  badminton: '🏸',
  tabletennis: '🏓',
  cricket: '🏏',
  mma: '🥊',
  ufc: '🥊',
  boxing: '🥊',
  darts: '🎯',
  // others
  golf: '⛳',
  volleyball: '🏐',
  handball: '🤾',
  snooker: '🎱',
  pool: '🎱',
  esports: '🎮',
  motorsport: '🏎️',
  formula1: '🏎️',
  cycling: '🚴',
  swimming: '🏊',
  athletics: '🏃',
}

/** Catch-all fallback so a missing sport never renders as a stray dot. */
const DEFAULT_EMOJI = '🏆'

/** lowercase, strip everything non-alphabetic so "Rugby Union"/"rugby_union" match. */
function canon(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * The OPTIC feed has a generic `rugby` sport bucket that mixes Super Rugby
 * (Union) and Super League (League) fixtures. We reclassify each row by its
 * league so the sidebar shows two rugby entries (Union + League) instead of
 * three (Union, League, generic Rugby). All fixtures stay in the system —
 * only their effective sport slug shifts.
 *
 * The four known Rugby League competitions per the OPTIC feed:
 *   australia_-_nrl, australia_-_nrlw, australia_-_state_of_origin,
 *   england_-_super_league
 * Everything else (Premiership Rugby, Top 14, Pro D2, Six Nations, Rugby
 * Championship, URC, Challenge Cup, Super Rugby, Olympics 7s, MLR, Scotland
 * Premier Division …) is Rugby Union.
 */
const RUGBY_LEAGUE_LEAGUES = new Set([
  'australia_-_nrl',
  'australia_-_nrlw',
  'australia_-_state_of_origin',
  'england_-_super_league',
])

export function reclassifyRugbySport(rawSport: string, rawLeague: string): string {
  if (canon(rawSport) !== 'rugby') return rawSport
  return RUGBY_LEAGUE_LEAGUES.has((rawLeague ?? '').toLowerCase())
    ? 'rugby_league'
    : 'rugby_union'
}

export function sportEmoji(sport: string): string {
  return EMOJI[canon(sport)] ?? DEFAULT_EMOJI
}

/** Short column label for a period, by sport: tennis sets, basketball quarters,
 *  baseball innings, hockey periods, soccer halves, etc. */
export function periodAbbrev(sport: string, index: number): string {
  switch (canon(sport)) {
    case 'tennis':
      return `S${index}`
    case 'basketball':
      return `Q${index}`
    case 'icehockey':
    case 'hockey':
      return `P${index}`
    case 'baseball':
    case 'mlb':
    case 'cricket':
      return `${index}`
    case 'soccer':
      return index <= 2 ? `${index}H` : `ET${index - 2}`
    default:
      return `P${index}`
  }
}

/** What the period columns represent, for the line-score header. */
export function periodNoun(sport: string): string {
  switch (canon(sport)) {
    case 'tennis':
      return 'SETS'
    case 'basketball':
      return 'QUARTERS'
    case 'baseball':
    case 'mlb':
      return 'INNINGS'
    case 'icehockey':
    case 'hockey':
      return 'PERIODS'
    case 'soccer':
      return 'HALVES'
    case 'cricket':
      return 'INNINGS'
    default:
      return 'PERIODS'
  }
}

/**
 * Current game state derived from how many periods have scores, e.g. "Q4",
 * "SET 2", "6TH", "P3", "2ND HALF". The feed has no clock/time-remaining, so
 * this is the period only. Returns null when there's nothing to show.
 */
export function periodState(sport: string, periods: { index: number }[]): string | null {
  if (periods.length === 0) return null
  const n = periods[periods.length - 1].index
  switch (canon(sport)) {
    case 'tennis':
      return `SET ${n}`
    case 'basketball':
      return n <= 4 ? `Q${n}` : n === 5 ? 'OT' : `OT${n - 4}`
    case 'icehockey':
    case 'hockey':
      return n <= 3 ? `P${n}` : 'OT'
    case 'soccer':
      return n <= 1 ? '1ST HALF' : n === 2 ? '2ND HALF' : `ET${n - 2 > 1 ? n - 2 : ''}`
    case 'baseball':
    case 'mlb':
      return ordinal(n)
    case 'cricket':
      return `INN ${n}`
    default:
      return `P${n}`
  }
}

function ordinal(n: number): string {
  const s = ['TH', 'ST', 'ND', 'RD']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

/** "rugby_union" -> "rugby union" (the header uppercases it for display). */
export function prettySport(raw: string): string {
  return (raw ?? '').replace(/_/g, ' ').trim() || 'Unknown'
}

/**
 * Parent / display sport name for cases where OPTIC uses the league as the
 * sport (mlb/nba/nhl/nfl/afl/nrl/ucl). e.g. "mlb" → "Baseball". For everything
 * else returns the prettified raw sport.
 */
const PARENT_SPORT: Record<string, string> = {
  mlb: 'Baseball',
  nba: 'Basketball',
  wnba: 'Basketball',
  nhl: 'Ice Hockey',
  nfl: 'American Football',
  amfootball: 'American Football',
  afl: 'Australian Rules',
  nrl: 'Rugby League',
  ucl: 'Soccer',
  kbo: 'Baseball',
  npb: 'Baseball',
  rugbyunion: 'Rugby Union',
  rugbyleague: 'Rugby League',
  icehockey: 'Ice Hockey',
  mma: 'Mixed Martial Arts',
  ufc: 'Mixed Martial Arts',
}

export function displaySport(raw: string): string {
  const k = canon(raw)
  return PARENT_SPORT[k] ?? (prettySport(raw).slice(0, 1).toUpperCase() + prettySport(raw).slice(1))
}

/** Merge key for display-grouping sports: `mlb`/`baseball` both → "baseball". */
export function sportGroupKey(raw: string): string {
  return displaySport(raw).toLowerCase()
}

/**
 * Sidebar / chip-friendly sport label. Handles raw slugs (`icehockey`,
 * `rugby_union`) and prettified forms (`Rugby union`) alike, with explicit
 * overrides for acronyms and multi-word names that titleCase mangles.
 */
const SPORT_DISPLAY_OVERRIDES: Record<string, string> = {
  nrl: 'NRL',
  afl: 'AFL',
  nba: 'NBA',
  nhl: 'NHL',
  nfl: 'NFL',
  mlb: 'MLB',
  ufc: 'UFC',
  cfl: 'CFL',
  ipl: 'IPL',
  mls: 'MLS',
  mma: 'MMA',
  ucl: 'UCL',
  uel: 'UEL',
  kbo: 'KBO',
  npb: 'NPB',
  wnba: 'WNBA',
  icehockey: 'Ice Hockey',
  amfootball: 'American Football',
  americanfootball: 'American Football',
  rugbyunion: 'Rugby Union',
  rugbyleague: 'Rugby League',
  australianrules: 'Australian Rules',
  mixedmartialarts: 'Mixed Martial Arts',
  motorsport: 'Motor Sport',
  formula1: 'Formula 1',
  tabletennis: 'Table Tennis',
}

/** Tennis tournament (season_type) condensed to its city + a short qualifier:
 *  "Halle, Germany" → "Halle"; "Berlin, Germany, Qualifying" → "Berlin (Qual)";
 *  "S-Hertogenbosch, Netherlands, Doubles" → "S-Hertogenbosch (Doubles)". */
function tennisTournamentShort(seasonType: string): string {
  const city = seasonType.split(',')[0].trim()
  const tags: string[] = []
  if (/qualif/i.test(seasonType)) tags.push('Qual')
  if (/doubles/i.test(seasonType)) tags.push('Doubles')
  return tags.length ? `${city} (${tags.join(', ')})` : city
}

/** League label for display. Tennis appends the tournament — "ATP" alone is
 *  uninformative — e.g. "ATP · Halle". Other sports' leagues are already
 *  specific ("Brazil - Serie A"), so they're returned as-is. */
export function leagueLabel(sport: string, league: string, seasonType: string | null): string {
  if (canon(sport) === 'tennis' && seasonType) return `${league} · ${tennisTournamentShort(seasonType)}`
  return league
}

export function sportLabel(raw: string): string {
  const k = canon(raw)
  if (SPORT_DISPLAY_OVERRIDES[k]) return SPORT_DISPLAY_OVERRIDES[k]
  // Fall back to title case of the prettified form.
  return prettySport(raw)
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''))
    .join(' ')
}

/**
 * Canonical SWIFT (gutsy) sport name for a given OPTIC sport slug. Mirrors
 * `SPORT_MAP` in scripts/build-mapping.mjs — most names match the display label
 * but a couple differ ("soccer" → "Football", "mma" → "Mixed Martial Arts").
 * Used by the editor to filter the picker to the right sport.
 */
const OPTIC_TO_SWIFT_SPORT: Record<string, string> = {
  soccer: 'Football',
  ucl: 'Football',
  football: 'American Football',
  americanfootball: 'American Football',
  amfootball: 'American Football',
  nfl: 'American Football',
  cfl: 'American Football',
  basketball: 'Basketball',
  nba: 'Basketball',
  wnba: 'Basketball',
  baseball: 'Baseball',
  mlb: 'Baseball',
  kbo: 'Baseball',
  npb: 'Baseball',
  icehockey: 'Ice Hockey',
  hockey: 'Ice Hockey',
  nhl: 'Ice Hockey',
  cricket: 'Cricket',
  tennis: 'Tennis',
  mma: 'Mixed Martial Arts',
  ufc: 'Mixed Martial Arts',
  boxing: 'Boxing',
  darts: 'Darts',
  rugby: 'Rugby Union',
  rugbyunion: 'Rugby Union',
  rugbyleague: 'Rugby League',
  nrl: 'Rugby League',
  afl: 'Australian Rules',
  golf: 'Golf',
  motorsport: 'Motor Sport',
  // Sports that exist on the SwiftBet side; without an entry here the
  // MappingEditor's sport filter would return null and show every sport.
  volleyball: 'Volleyball',
  snooker: 'Snooker',
  handball: 'Handball',
  esports: 'Esports',
  tabletennis: 'Table Tennis',
  badminton: 'Badminton',
}

export function swiftSportOf(opticRawSport: string): string | null {
  return OPTIC_TO_SWIFT_SPORT[canon(opticRawSport)] ?? null
}

/**
 * "france_-_ligue_1" → "France - Ligue 1",
 * "australia_-_a-league_women" → "Australia - A-League Women",
 * "international_-_t20_matches" → "International - T20 Matches".
 *
 * The "_-_" separator splits region/tier from the actual competition, so we
 * keep both parts. Acronyms (NRL, AFL, EFL, FA, UEFA, …) are preserved via
 * an explicit set; everything else gets title-cased.
 */
const LEAGUE_ACRONYMS = new Set([
  'nrl', 'nrlw', 'afl', 'vfl', 'wafl', 'sanfl', 'nba', 'nhl', 'mlb', 'nfl', 'wnba', 'cfl',
  'ufc', 'pfl', 'ipl', 'mls', 'mma', 'efl', 'fa', 'uefa', 'fifa', 'caf', 'afc', 'conmebol',
  'concacaf', 'icc', 'pdc', 'wsl', 'usa', 'uk', 'atp', 'wta', 'urc', 'mlr', 'kbo', 'npb',
  'epl', 'ucl', 'uel', 'odi', 't20', 'd2', 'k1', 'j1', 'nb', 'ii', 'iii',
])

function titleCaseWord(w: string): string {
  if (!w) return ''
  const low = w.toLowerCase()
  if (LEAGUE_ACRONYMS.has(low)) return low.toUpperCase()
  // Preserve internal punctuation (e.g. "a-league" → "A-League").
  return low
    .split('-')
    .map((part) => (LEAGUE_ACRONYMS.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
}

function titleCasePhrase(s: string): string {
  return s.replace(/_/g, ' ').trim().split(/\s+/).map(titleCaseWord).join(' ')
}

export function prettyLeague(raw: string): string {
  if (!raw) return ''
  if (!raw.includes('_-_')) return titleCasePhrase(raw)
  const [head, ...rest] = raw.split('_-_')
  return `${titleCasePhrase(head)} - ${titleCasePhrase(rest.join('_-_'))}`
}
