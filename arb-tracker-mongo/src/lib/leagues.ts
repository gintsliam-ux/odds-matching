/**
 * The sports and leagues the filter offers, and how to tell which one a bet is.
 *
 * A fixed list rather than whatever the feed happens to be carrying. The chips
 * used to be derived from the 200 bets on screen, which meant they moved every
 * time the feed turned over — the sport you were reaching for was in a
 * different place each refresh, because the order was by bet count. These eight
 * sit in alphabetical order and stay where they are whether anything has been
 * struck on them or not.
 *
 * Everything else on the feed — cricket, MMA, volleyball, esports, darts — is
 * still offered after them, derived as before. Narrowing the list to eight
 * sports would have removed the only way to isolate the ninth.
 */

/** The eight, alphabetically. These are `sportLabel` outputs — see ticker.mjs. */
export const MAIN_SPORTS = [
  'American Football',
  'Aussie Rules',
  'Baseball',
  'Basketball',
  'Ice Hockey',
  'Rugby League',
  'Soccer',
  'Tennis',
] as const;

export type MainSport = (typeof MAIN_SPORTS)[number];

/**
 * One league, and the values that identify it.
 *
 * `tournament` and `category` are both lists, and both are matched against the
 * bet when present, which is not over-engineering — it is what the real labels
 * demand, and each part of it was something that went wrong first:
 *
 *   category is REQUIRED for soccer. "Premier League" is not England. It is
 *   Ukraine (330 fixtures), Belarus (320) and South Africa (318); the English
 *   one is labelled "English Premier League". A chip matching the obvious
 *   string would have shown the Belarusian top flight under a crest everyone
 *   would read as the EPL. "Serie A" is Italy AND Ecuador AND Brazil,
 *   "Championship" is England and Scotland, "League 1" is England and Tunisia.
 *
 *   category IS the league for tennis. The tournament is the city — "Basel,
 *   Switzerland", "Sioux Falls, USA" — and the tour is in the category: ATP,
 *   WTA, ATP Challenger. Nobody filters tennis by city.
 *
 *   tournament takes a LIST because the two sides spell leagues differently.
 *   The fixture rows say "Chinese Basketball Association"; the bets say "CBA".
 *   Same league, and a single string would have found half of it.
 */
export type League = {
  label: string;
  tournament?: string[];
  category?: string[];
};

/** Does this bet belong to that league? Both halves must agree when both are set. */
export function inLeague(
  bet: { tournament?: string | null; category?: string | null },
  league: League,
): boolean {
  if (league.tournament && !league.tournament.includes(bet.tournament ?? '')) return false;
  if (league.category && !league.category.includes(bet.category ?? '')) return false;
  return true;
}

/**
 * The main leagues of each of the eight.
 *
 * Every string here was read off the live data rather than recalled — the
 * fixture table's own tournament and category values, cross-checked against
 * what the bets on the feed carry. A label that is almost right matches
 * nothing and looks exactly like a league nobody bet on, so there is no way to
 * spot a typo here from the screen.
 *
 * Ordered as the sport is actually read: the big domestic competition first,
 * then down. Not alphabetical — alphabetical would open gridiron on the CFL.
 */
export const MAIN_LEAGUES: Record<MainSport, League[]> = {
  'American Football': [
    { label: 'NFL', tournament: ['NFL'] },
    { label: 'NFL Preseason', tournament: ['NFL Preseason'] },
    { label: 'NCAAF', tournament: ['NCAAF'] },
    { label: 'CFL', tournament: ['CFL'] },
    { label: 'UFL', tournament: ['UFL'] },
  ],
  'Aussie Rules': [
    { label: 'AFL', tournament: ['AFL'] },
    { label: 'AFLW', tournament: ['AFL Women'] },
    { label: 'WAFL', tournament: ['WAFL'] },
    { label: 'SANFL', tournament: ['SANFL'] },
  ],
  Baseball: [
    { label: 'MLB', tournament: ['MLB'] },
    { label: 'MLB Preseason', tournament: ['MLB Preseason'] },
    { label: 'NPB', tournament: ['NPB'] },
    { label: 'KBO', tournament: ['KBO'] },
    { label: 'CPBL', tournament: ['CPBL'] },
    { label: 'LMB', tournament: ['Mexican Baseball League'] },
    { label: 'LMP', tournament: ['Mexican Pacific League', 'Mexico - LMP'] },
    { label: 'LVBP', tournament: ['Venezuela - LVBP'] },
    { label: 'LIDOM', tournament: ['Dominican Republic - LIDOM'] },
    { label: 'NCAA', tournament: ['NCAA Baseball'] },
  ],
  Basketball: [
    { label: 'NBA', tournament: ['NBA'] },
    { label: 'NBA Summer League', tournament: ['NBA Summer League'] },
    { label: 'NCAAB', tournament: ['NCAAB'] },
    { label: 'NCAAW', tournament: ['NCAAW'] },
    { label: 'WNBA', tournament: ['WNBA'] },
    { label: 'EuroLeague', tournament: ['Euroleague'] },
    { label: 'EuroCup', tournament: ['Eurocup'] },
    // Basketball has a Champions League of its own; soccer's is a different
    // sport's entry, and the pills are scoped by sport so the two never meet.
    { label: 'BCL', tournament: ['Champions League'], category: ['International'] },
    { label: 'FIBA Europe Cup', tournament: ['FIBA - Europe Cup', 'FIBA Europe Cup'] },
    { label: 'FIBA World Cup Qual.', tournament: ['FIBA - World Cup Qualifiers', 'FIBA World Cup Qualifiers'] },
    // Dashed and undashed spellings of one competition — see the note on List.
    { label: 'EuroBasket Qual.', tournament: ['FIBA - EuroBasket Qualifiers', 'FIBA EuroBasket Qualifiers'] },
    // NBL and NBL1 are different competitions, as are WNBL and WNBL1: the
    // numbered ones are the semi-pro tiers below the national leagues.
    { label: 'NBL', tournament: ['NBL'] },
    { label: 'NBL1', tournament: ['NBL1'] },
    { label: 'WNBL', tournament: ['WNBL'] },
    { label: 'WNBL1', tournament: ['WNBL1'] },
    { label: 'NZ NBL', tournament: ['New Zealand NBL'] },
    { label: 'CBA', tournament: ['CBA', 'Chinese Basketball Association'] },
    { label: 'KBL', tournament: ['KBL'] },
    { label: 'B1', tournament: ['B1 League'] },
    { label: 'B2', tournament: ['B2 League'] },
    { label: 'ACB', tournament: ['Liga ACB'] },
    { label: 'BSL', tournament: ['Turkish BSL'] },
    { label: 'LNB Argentina', tournament: ['Argentina Lnb'] },
    { label: 'LNB Chile', tournament: ['Chile LNB'] },
    { label: 'NBB', tournament: ['Brazil NBB'] },
    { label: 'BSN', tournament: ['BSN'] },
    { label: 'LNBP', tournament: ['LNBP'] },
    { label: 'CIBACOPA', tournament: ['CIBACOPA'] },
    { label: 'IBL', tournament: ['Indonesia Ibl'] },
    { label: 'NBA Preseason', tournament: ['NBA Preseason'] },
    { label: 'BBL', tournament: ['BBL'], category: ['Germany'] },
    { label: 'Pro A', tournament: ['Pro A'], category: ['Germany'] },
    { label: 'Serie A2', tournament: ['Serie A2'], category: ['Italy'] },
    { label: 'ABA League', tournament: ['ABA League'] },
    { label: 'LNB Pro B', tournament: ['LNB Pro B'], category: ['France'] },
    { label: 'LNB National 1', tournament: ['LNB National 1'], category: ['France'] },
    { label: 'EuroCup Women', tournament: ['Eurocup Women'] },
    { label: 'TBL', tournament: ['TBL'], category: ['Turkey'] },
    { label: 'BSNF', tournament: ['BSNF'], category: ['Puerto Rico'] },
    { label: 'PBA', tournament: ['Pba Commissioners', 'PBA Philippine Cup'], category: ['Philippines'] },
    { label: 'Friendlies', tournament: ['BB Club Friendlies'], category: ['International'] },
  ],
  'Ice Hockey': [
    { label: 'NHL', tournament: ['NHL'] },
    { label: 'AHL', tournament: ['AHL'] },
    { label: 'KHL', tournament: ['KHL'] },
    { label: 'VHL', tournament: ['VHL'] },
    { label: 'MHL', tournament: ['MHL'] },
    { label: 'SHL', tournament: ['SHL'] },
    // One league, two spellings in the source — 615 rows against 99.
    { label: 'Allsvenskan', tournament: ['HockeyAllsvenskan', 'Hockey Allsvenskan'] },
    { label: 'Hockeyettan', tournament: ['Hockeyettan'] },
    // Likewise: "Finnish Liiga" and "SM Liiga" are the same competition.
    { label: 'Liiga', tournament: ['Finnish Liiga', 'SM Liiga'] },
    // Same league twice again, like Allsvenskan above.
    { label: 'Mestis', tournament: ['Finnish Mestis', 'Mestis'] },
    // Extraliga is Czech AND Belarusian, so both are named by country.
    // Extraliga is Czech, Belarusian AND Slovak — three leagues, one name.
    { label: 'Czech Extraliga', tournament: ['Extraliga'], category: ['Czech Republic'] },
    { label: 'Belarus Extraliga', tournament: ['Extraliga'], category: ['Belarus'] },
    { label: 'Slovak Extraliga', tournament: ['Extraliga'], category: ['Slovakia'] },
    { label: 'Czech 2. Liga', tournament: ['2. Liga'], category: ['Czech Republic'] },
    { label: 'Chance Liga', tournament: ['Chance Liga'] },
    { label: 'Swiss NL', tournament: ['National League'], category: ['Switzerland'] },
    { label: 'DEL', tournament: ['DEL'] },
    { label: 'DEL 2', tournament: ['DEL 2'] },
    { label: 'ICE', tournament: ['Ice Hockey League'], category: ['Austria'] },
    { label: 'WHL', tournament: ['WHL'] },
    { label: 'OHL', tournament: ['OHL'] },
    { label: 'QMJHL', tournament: ['QMJHL'] },
    { label: 'NCAAH', tournament: ['NCAAH'] },
    { label: 'ECHL', tournament: ['USA - ECHL'] },
    { label: 'CHL', tournament: ['Champions Hockey League'] },
    { label: 'Alps League', tournament: ['Alps League'] },
    { label: 'Ligue Magnus', tournament: ['Ligue Magnus'], category: ['France'] },
    { label: 'PHL', tournament: ['Polska Hokej Liga'], category: ['Poland'] },
    { label: 'Swiss League', tournament: ['Swiss League'], category: ['Switzerland'] },
    { label: 'Superisligaen', tournament: ['Superisligaen'], category: ['Denmark'] },
    { label: 'Elitehockeyligaen', tournament: ['Elitehockeyligaen'], category: ['Norway'] },
    { label: 'SDHL', tournament: ['SDHL'], category: ['Sweden'] },
    { label: 'Oberliga', tournament: ['Oberliga'], category: ['Germany'] },
  ],
  'Rugby League': [
    { label: 'NRL', tournament: ['NRL'] },
    { label: 'NRLW', tournament: ['NRLW'] },
    { label: 'Super League', tournament: ['Super League'], category: ['England'] },
    { label: 'Origin', tournament: ['NRL State of Origin'] },
    { label: 'World Cup', tournament: ['International - Rugby League World Cup', 'Rugby League World Cup'] },
    {
      label: 'World Cup Women',
      tournament: ['International - Rugby League World Cup Women', 'Rugby League World Cup Women'],
    },
  ],
  Soccer: [
    // Every soccer entry names its country. The name alone is never enough —
    // see the warning on League — and it costs one field to be certain.
    { label: 'EPL', tournament: ['English Premier League'], category: ['England'] },
    { label: 'Championship', tournament: ['Championship'], category: ['England'] },
    { label: 'League One', tournament: ['League 1'], category: ['England'] },
    { label: 'League Two', tournament: ['League 2'], category: ['England'] },
    { label: 'FA Cup', tournament: ['FA Cup'], category: ['England'] },
    { label: 'EFL Cup', tournament: ['EFL Cup'], category: ['England'] },
    { label: 'La Liga', tournament: ['La Liga'], category: ['Spain'] },
    { label: 'La Liga 2', tournament: ['La Liga 2'], category: ['Spain'] },
    { label: 'Serie A', tournament: ['Serie A'], category: ['Italy'] },
    { label: 'Serie B', tournament: ['Serie B'], category: ['Italy'] },
    { label: 'Bundesliga', tournament: ['Bundesliga'], category: ['Germany'] },
    { label: 'Bundesliga 2', tournament: ['Bundesliga 2'], category: ['Germany'] },
    { label: '3. Liga', tournament: ['3. Liga'], category: ['Germany'] },
    { label: 'Ligue 1', tournament: ['Ligue 1'], category: ['France'] },
    { label: 'Ligue 2', tournament: ['Ligue 2'], category: ['France'] },
    { label: 'Eredivisie', tournament: ['Eredivisie'], category: ['Netherlands'] },
    { label: 'Eerste Divisie', tournament: ['Netherlands Eerste Divisie'], category: ['Netherlands'] },
    { label: 'Primeira', tournament: ['Primeira Liga'], category: ['Portugal'] },
    { label: 'Scottish Prem', tournament: ['Scottish Premiership'], category: ['Scotland'] },
    { label: 'Jupiler Pro', tournament: ['Jupiler Pro League'], category: ['Belgium'] },
    { label: 'Süper Lig', tournament: ['Süper Lig'], category: ['Turkey'] },
    { label: 'Ekstraklasa', tournament: ['Ekstraklasa'], category: ['Poland'] },
    { label: 'Greek Super League', tournament: ['Greek Super League'], category: ['Greece'] },
    { label: 'Austrian Bundesliga', tournament: ['Austrian Bundesliga'], category: ['Austria'] },
    { label: 'Swiss Super League', tournament: ['Super League'], category: ['Switzerland'] },
    { label: 'Eliteserien', tournament: ['Eliteserien'], category: ['Norway'] },
    { label: 'Allsvenskan', tournament: ['Allsvenskan'], category: ['Sweden'] },
    { label: 'Superettan', tournament: ['Superettan'], category: ['Sweden'] },
    { label: 'Superliga', tournament: ['Superliga'], category: ['Denmark'] },
    { label: 'Veikkausliiga', tournament: ['Veikkausliiga'], category: ['Finland'] },
    { label: 'Parva Liga', tournament: ['Parva Liga'], category: ['Bulgaria'] },
    { label: 'Liga I', tournament: ['Romanian Liga I'], category: ['Romania'] },
    { label: 'Serbian Super Liga', tournament: ['Serbian Super Liga'], category: ['Serbia'] },
    { label: 'Virsliga', tournament: ['Latvia Virsliga'], category: ['Latvia'] },
    { label: 'League of Ireland', tournament: ['League of Ireland'], category: ['Ireland'] },
    { label: 'Russian Prem', tournament: ['Russian Premier League'], category: ['Russia'] },
    { label: 'Ukrainian Prem', tournament: ['Premier League'], category: ['Ukraine'] },
    { label: 'Belarus Prem', tournament: ['Premier League'], category: ['Belarus'] },
    // Continental and international, filed under International not a country.
    { label: 'UCL', tournament: ['UEFA Champions League'], category: ['International'] },
    { label: 'Europa', tournament: ['UEFA - Europa League'], category: ['International'] },
    { label: 'Conference', tournament: ['UEFA - Europa Conference League'], category: ['International'] },
    { label: 'Libertadores', tournament: ['Copa Libertadores'], category: ['International'] },
    { label: 'Sudamericana', tournament: ['Copa Sudamericana'], category: ['International'] },
    { label: 'World Cup Qual.', tournament: ['World Cup Qualifiers'], category: ['International'] },
    { label: 'Friendlies', tournament: ['Club Friendlies', 'International Friendlies'], category: ['International'] },
    // The Americas, Asia, Africa.
    { label: 'MLS', tournament: ['Major League Soccer'], category: ['USA'] },
    { label: 'MLS Next Pro', tournament: ['MLS Next Pro'], category: ['USA'] },
    { label: 'Liga MX', tournament: ['Liga MX'], category: ['Mexico'] },
    { label: 'Brasileirão', tournament: ['Brasileirao Serie A'], category: ['Brazil'] },
    { label: 'Brasileirão B', tournament: ['Brasileirao Serie B'], category: ['Brazil'] },
    { label: 'Argentina', tournament: ['Primera División'], category: ['Argentina'] },
    { label: 'Chile', tournament: ['Primera División'], category: ['Chile'] },
    { label: 'Colombia', tournament: ['Primera A'], category: ['Colombia'] },
    { label: 'Peru', tournament: ['Liga 1 Peru'], category: ['Peru'] },
    { label: 'Uruguay', tournament: ['Uruguayan Primera'], category: ['Uruguay'] },
    { label: 'Ecuador', tournament: ['Serie A'], category: ['Ecuador'] },
    { label: 'Guatemala', tournament: ['Guatemala Liga Nacional'], category: ['Guatemala'] },
    { label: 'J1', tournament: ['J1 League'], category: ['Japan'] },
    { label: 'J2', tournament: ['J2 League'], category: ['Japan'] },
    { label: 'K1', tournament: ['K1 League'], category: ['South Korea'] },
    { label: 'K2', tournament: ['K2 League'], category: ['South Korea'] },
    { label: 'CSL', tournament: ['Super League'], category: ['China'] },
    { label: 'A-League', tournament: ['A-League'], category: ['Australia'] },
    { label: 'Saudi Pro', tournament: ['Saudi Pro League'], category: ['Saudi Arabia'] },
    { label: 'Egyptian Prem', tournament: ['Egyptian Premier League'], category: ['Egypt'] },
    { label: 'South Africa Prem', tournament: ['Premier League'], category: ['South Africa'] },
    { label: 'Tercera', tournament: ['Tercera Division'], category: ['Spain'] },
    { label: 'Segunda Fed.', tournament: ['Segunda Federacion'], category: ['Spain'] },
    { label: 'Serie D', tournament: ['Serie D'], category: ['Italy'] },
    { label: 'Regionalliga', tournament: ['Regionalliga'], category: ['Germany'] },
    { label: 'Norway 3. Div', tournament: ['3. Division'], category: ['Norway'] },
    { label: 'Israeli Prem', tournament: ['Israeli Premier League'], category: ['Israel'] },
    { label: 'Czech First', tournament: ['Czech First League'], category: ['Czech Republic'] },
    { label: 'Slovak Super Liga', tournament: ['Slovak Super Liga'], category: ['Slovakia'] },
    { label: 'NPL NSW', tournament: ['NPL NSW'], category: ['Australia'] },
    { label: 'Venezuela', tournament: ['Primera División'], category: ['Venezuela'] },
    { label: 'Bolivia', tournament: ['División Profesional'], category: ['Bolivia'] },
    { label: 'Costa Rica', tournament: ['Primera Division'], category: ['Costa Rica'] },
    { label: 'Paraguay', tournament: ['Paraguayan Primera'], category: ['Paraguay'] },
    { label: 'Indonesia', tournament: ['Indonesia Liga 1'], category: ['Indonesia'] },
  ],
  Tennis: [
    { label: 'ATP', category: ['ATP', 'ATP Doubles'] },
    { label: 'WTA', category: ['WTA', 'WTA Doubles'] },
    { label: 'Challenger', category: ['ATP Challenger'] },
    { label: 'Davis Cup', category: ['Davis Cup'] },
    { label: 'Laver Cup', category: ['Laver Cup'] },
  ],
};

/** The main sports, as a set, for "is this one of the eight". */
export const IS_MAIN_SPORT = new Set<string>(MAIN_SPORTS);
