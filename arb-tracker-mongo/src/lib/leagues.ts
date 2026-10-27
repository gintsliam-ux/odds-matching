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
    { label: 'NPB', tournament: ['NPB'] },
    { label: 'KBO', tournament: ['KBO'] },
    { label: 'CPBL', tournament: ['CPBL'] },
    { label: 'LMB', tournament: ['Mexican Baseball League'] },
    { label: 'NCAA', tournament: ['NCAA Baseball'] },
  ],
  Basketball: [
    { label: 'NBA', tournament: ['NBA'] },
    { label: 'NCAAB', tournament: ['NCAAB'] },
    { label: 'WNBA', tournament: ['WNBA'] },
    { label: 'EuroLeague', tournament: ['Euroleague'] },
    { label: 'EuroCup', tournament: ['Eurocup'] },
    { label: 'NBL', tournament: ['NBL'] },
    { label: 'NBL1', tournament: ['NBL1'] },
    { label: 'WNBL', tournament: ['WNBL1'] },
    // The fixture table and the bets disagree on this one's name.
    { label: 'CBA', tournament: ['CBA', 'Chinese Basketball Association'] },
    { label: 'KBL', tournament: ['KBL'] },
    { label: 'B1', tournament: ['B1 League'] },
    { label: 'ACB', tournament: ['Liga ACB'] },
  ],
  'Ice Hockey': [
    { label: 'NHL', tournament: ['NHL'] },
    { label: 'AHL', tournament: ['AHL'] },
    { label: 'KHL', tournament: ['KHL'] },
    { label: 'SHL', tournament: ['SHL'] },
    { label: 'Liiga', tournament: ['Finnish Liiga'] },
    { label: 'Allsvenskan', tournament: ['HockeyAllsvenskan'] },
    { label: 'NCAAH', tournament: ['NCAAH'] },
  ],
  'Rugby League': [
    { label: 'NRL', tournament: ['NRL'] },
    { label: 'NRLW', tournament: ['NRLW'] },
    // England's, not China's or Switzerland's — both of those are soccer, but
    // the category costs nothing and says which one this is.
    { label: 'Super League', tournament: ['Super League'], category: ['England'] },
    { label: 'Origin', tournament: ['NRL State of Origin'] },
  ],
  Soccer: [
    // England. "English Premier League" is the EPL's actual label here; see
    // the warning on League above.
    { label: 'EPL', tournament: ['English Premier League'], category: ['England'] },
    { label: 'Championship', tournament: ['Championship'], category: ['England'] },
    { label: 'League One', tournament: ['League 1'], category: ['England'] },
    { label: 'League Two', tournament: ['League 2'], category: ['England'] },
    { label: 'FA Cup', tournament: ['FA Cup'], category: ['England'] },
    { label: 'EFL Cup', tournament: ['EFL Cup'], category: ['England'] },
    // The rest of the big five.
    { label: 'La Liga', tournament: ['La Liga'], category: ['Spain'] },
    { label: 'Serie A', tournament: ['Serie A'], category: ['Italy'] },
    { label: 'Bundesliga', tournament: ['Bundesliga'], category: ['Germany'] },
    { label: 'Ligue 1', tournament: ['Ligue 1'], category: ['France'] },
    { label: 'Eredivisie', tournament: ['Eredivisie'], category: ['Netherlands'] },
    { label: 'Primeira', tournament: ['Primeira Liga'], category: ['Portugal'] },
    { label: 'Scottish Prem', tournament: ['Scottish Premiership'], category: ['Scotland'] },
    /*
     * Continental, which the feed files under International rather than a
     * country — and which is not consistently punctuated: the Champions
     * League has no dash, both Europa competitions do. "UEFA Europa League"
     * was the obvious guess and matched nothing at all.
     */
    { label: 'UCL', tournament: ['UEFA Champions League'], category: ['International'] },
    { label: 'Europa', tournament: ['UEFA - Europa League'], category: ['International'] },
    { label: 'Conference', tournament: ['UEFA - Europa Conference League'], category: ['International'] },
    // Elsewhere.
    { label: 'MLS', tournament: ['Major League Soccer'], category: ['USA'] },
    { label: 'Liga MX', tournament: ['Liga MX'], category: ['Mexico'] },
    { label: 'Brasileirão', tournament: ['Brasileirao Serie A'], category: ['Brazil'] },
    { label: 'Argentina', tournament: ['Primera División'], category: ['Argentina'] },
    { label: 'A-League', tournament: ['A-League'], category: ['Australia'] },
  ],
  Tennis: [
    // The tour, which is the category. Doubles ride with the tour that runs
    // them rather than being two more chips.
    { label: 'ATP', category: ['ATP', 'ATP Doubles'] },
    { label: 'WTA', category: ['WTA', 'WTA Doubles'] },
    { label: 'Challenger', category: ['ATP Challenger'] },
    { label: 'Davis Cup', category: ['Davis Cup'] },
    { label: 'Laver Cup', category: ['Laver Cup'] },
  ],
};

/** The main sports, as a set, for "is this one of the eight". */
export const IS_MAIN_SPORT = new Set<string>(MAIN_SPORTS);
