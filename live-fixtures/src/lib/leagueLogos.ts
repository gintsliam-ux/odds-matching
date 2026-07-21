// Real competition crests for the leagues in the feed, served from ESPN's CDN.
// Two URL shapes:
//   majors  → /i/teamlogos/leagues/500/{slug}.png   (mlb, nba, nrl, f1 …)
//   soccer  → /i/leaguelogos/soccer/500/{id}.png    (numeric ESPN league id)
// Every URL below was checked to return a real image — ESPN serves a generic
// placeholder crest for leagues it doesn't have art for (Norwegian Eliteserien,
// South African Premiership, all of rugby), so those are deliberately absent
// and fall back to the sport emoji rather than showing a grey shield.
//
// Not covered by ESPN at all, hence no entry: tennis (ATP/WTA/Challenger),
// cricket, darts, boxing, KBO/NPB/CPBL/LMB baseball, and the European domestic
// basketball leagues.

const ESPN_MAJOR = (slug: string) => `https://a.espncdn.com/i/teamlogos/leagues/500/${slug}.png`
const ESPN_SOCCER = (id: number) => `https://a.espncdn.com/i/leaguelogos/soccer/500/${id}.png`

/** Keyed by the feed's `league` slug. Checked before SPORT_LOGOS. */
const LEAGUE_LOGOS: Record<string, string> = {
  // soccer — domestic
  'england_-_premier_league': ESPN_SOCCER(23),
  'england_-_championship': ESPN_SOCCER(24),
  'spain_-_la_liga': ESPN_SOCCER(15),
  'spain_-_la_liga_2': ESPN_SOCCER(107),
  'italy_-_serie_a': ESPN_SOCCER(12),
  'italy_-_serie_b': ESPN_SOCCER(99),
  'germany_-_bundesliga': ESPN_SOCCER(10),
  'france_-_ligue_1': ESPN_SOCCER(9),
  'netherlands_-_eredivisie': ESPN_SOCCER(11),
  'portugal_-_primeira_liga': ESPN_SOCCER(14),
  'brazil_-_serie_a': ESPN_SOCCER(85),
  'brazil_-_serie_b': ESPN_SOCCER(2299),
  'argentina_-_primera_division': ESPN_SOCCER(1),
  'colombia_-_primera_a': ESPN_SOCCER(1543),
  'chile_-_primera_division': ESPN_SOCCER(86),
  'mexico_-_liga_mx': ESPN_SOCCER(22),
  'sweden_-_allsvenskan': ESPN_SOCCER(16),
  'china_-_super_league': ESPN_SOCCER(2350),
  'japan_-_j_league': ESPN_SOCCER(2199),
  'australia_-_a_league': ESPN_SOCCER(1308),
  'usa_-_major_league_soccer': ESPN_SOCCER(19),
  // soccer — continental & international
  'uefa_-_champions_league': ESPN_SOCCER(2),
  'uefa_-_europa_league': ESPN_SOCCER(2310),
  'uefa_-_conference_league': ESPN_SOCCER(20296),
  'conmebol_-_copa_libertadores': ESPN_SOCCER(58),
  'conmebol_-_copa_sudamericana': ESPN_SOCCER(1208),
  'fifa_-_world_cup': ESPN_SOCCER(4),
  'international_-_friendlies': ESPN_SOCCER(53),
  'international_-_friendlies_women': ESPN_SOCCER(70),
  // rugby league
  'australia_-_nrl': ESPN_MAJOR('nrl'),
}

/** Keyed by the feed's `sport` slug, for one-league sports. */
const SPORT_LOGOS: Record<string, string> = {
  mlb: ESPN_MAJOR('mlb'),
  nba: ESPN_MAJOR('nba'),
  nhl: ESPN_MAJOR('nhl'),
  nfl: ESPN_MAJOR('nfl'),
  wnba: ESPN_MAJOR('wnba'),
  afl: ESPN_MAJOR('afl'),
  nrl: ESPN_MAJOR('nrl'),
  ufc: ESPN_MAJOR('ufc'),
  ucl: ESPN_SOCCER(2),
}

/**
 * Strip to lowercase alphanumerics so a raw slug and its prettified label
 * collapse to the same key — callers hold `Fixture.league` ("England - Premier
 * League") in some places and `rawLeague` ("england_-_premier_league") in
 * others, and both must resolve.
 */
function canon(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const byLeague = index(LEAGUE_LOGOS)
const bySport = index(SPORT_LOGOS)
function index(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) out[canon(k)] = v
  return out
}

/**
 * Competition crest for a fixture's sport/league pair, or null when we have no
 * real artwork — callers fall back to `sportEmoji`.
 */
export function leagueLogoUrl(sport: string, league: string): string | null {
  const l = canon(league)
  if (byLeague[l]) return byLeague[l]

  const s = canon(sport)
  if (bySport[s]) return bySport[s]
  // The feed's `sport` for one-league sports sometimes lands in `league`
  // instead (e.g. sport=basketball, league=wnba).
  if (bySport[l]) return bySport[l]

  if (s === 'mma' && l.startsWith('ufc')) return ESPN_MAJOR('ufc')
  if (s === 'motorsport' && l.startsWith('formula1')) return ESPN_MAJOR('f1')
  return null
}
