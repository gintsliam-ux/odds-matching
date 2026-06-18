// Real team logos from ESPN's CDN for the American leagues that appear in the
// feed. URL pattern: https://a.espncdn.com/i/teamlogos/{espnSport}/500/{abbr}.png
// Everything else (tennis, South-American soccer, KBO/NPB, minor leagues) has no
// reliable public logo source, so the Avatar falls back to a monogram. Logos in
// the table itself (home_team_logo etc.) always take precedence over these.

const MLB: Record<string, string> = {
  'Arizona Diamondbacks': 'ari', 'Atlanta Braves': 'atl', 'Baltimore Orioles': 'bal',
  'Boston Red Sox': 'bos', 'Chicago Cubs': 'chc', 'Chicago White Sox': 'chw',
  'Cincinnati Reds': 'cin', 'Cleveland Guardians': 'cle', 'Colorado Rockies': 'col',
  'Detroit Tigers': 'det', 'Houston Astros': 'hou', 'Kansas City Royals': 'kc',
  'Los Angeles Angels': 'laa', 'LA Angels': 'laa',
  'Los Angeles Dodgers': 'lad', 'LA Dodgers': 'lad',
  'Miami Marlins': 'mia', 'Milwaukee Brewers': 'mil', 'Minnesota Twins': 'min',
  'New York Mets': 'nym', 'New York Yankees': 'nyy', 'Oakland Athletics': 'oak',
  'Athletics': 'oak', 'Philadelphia Phillies': 'phi', 'Pittsburgh Pirates': 'pit',
  'San Diego Padres': 'sd', 'San Francisco Giants': 'sf', 'Seattle Mariners': 'sea',
  'St. Louis Cardinals': 'stl', 'St Louis Cardinals': 'stl', 'Tampa Bay Rays': 'tb',
  'Texas Rangers': 'tex', 'Toronto Blue Jays': 'tor', 'Washington Nationals': 'wsh',
}

const NFL: Record<string, string> = {
  'Arizona Cardinals': 'ari', 'Atlanta Falcons': 'atl', 'Baltimore Ravens': 'bal',
  'Buffalo Bills': 'buf', 'Carolina Panthers': 'car', 'Chicago Bears': 'chi',
  'Cincinnati Bengals': 'cin', 'Cleveland Browns': 'cle', 'Dallas Cowboys': 'dal',
  'Denver Broncos': 'den', 'Detroit Lions': 'det', 'Green Bay Packers': 'gb',
  'Houston Texans': 'hou', 'Indianapolis Colts': 'ind', 'Jacksonville Jaguars': 'jax',
  'Kansas City Chiefs': 'kc', 'Las Vegas Raiders': 'lv', 'Los Angeles Chargers': 'lac',
  'Los Angeles Rams': 'lar', 'Miami Dolphins': 'mia', 'Minnesota Vikings': 'min',
  'New England Patriots': 'ne', 'New Orleans Saints': 'no', 'New York Giants': 'nyg',
  'New York Jets': 'nyj', 'Philadelphia Eagles': 'phi', 'Pittsburgh Steelers': 'pit',
  'San Francisco 49ers': 'sf', 'Seattle Seahawks': 'sea', 'Tampa Bay Buccaneers': 'tb',
  'Tennessee Titans': 'ten', 'Washington Commanders': 'wsh',
}

const NHL: Record<string, string> = {
  'Anaheim Ducks': 'ana', 'Arizona Coyotes': 'ari', 'Boston Bruins': 'bos',
  'Buffalo Sabres': 'buf', 'Calgary Flames': 'cgy', 'Carolina Hurricanes': 'car',
  'Chicago Blackhawks': 'chi', 'Colorado Avalanche': 'col', 'Columbus Blue Jackets': 'cbj',
  'Dallas Stars': 'dal', 'Detroit Red Wings': 'det', 'Edmonton Oilers': 'edm',
  'Florida Panthers': 'fla', 'Los Angeles Kings': 'la', 'Minnesota Wild': 'min',
  'Montreal Canadiens': 'mtl', 'Nashville Predators': 'nsh', 'New Jersey Devils': 'nj',
  'New York Islanders': 'nyi', 'New York Rangers': 'nyr', 'Ottawa Senators': 'ott',
  'Philadelphia Flyers': 'phi', 'Pittsburgh Penguins': 'pit', 'San Jose Sharks': 'sj',
  'Seattle Kraken': 'sea', 'St. Louis Blues': 'stl', 'St Louis Blues': 'stl',
  'Tampa Bay Lightning': 'tb', 'Toronto Maple Leafs': 'tor', 'Utah Hockey Club': 'utah',
  'Utah Mammoth': 'utah', 'Vancouver Canucks': 'van', 'Vegas Golden Knights': 'vgk',
  'Washington Capitals': 'wsh', 'Winnipeg Jets': 'wpg',
}

const NBA: Record<string, string> = {
  'Atlanta Hawks': 'atl', 'Boston Celtics': 'bos', 'Brooklyn Nets': 'bkn',
  'Charlotte Hornets': 'cha', 'Chicago Bulls': 'chi', 'Cleveland Cavaliers': 'cle',
  'Dallas Mavericks': 'dal', 'Denver Nuggets': 'den', 'Detroit Pistons': 'det',
  'Golden State Warriors': 'gs', 'Houston Rockets': 'hou', 'Indiana Pacers': 'ind',
  'LA Clippers': 'lac', 'Los Angeles Clippers': 'lac', 'LA Lakers': 'lal',
  'Los Angeles Lakers': 'lal', 'Memphis Grizzlies': 'mem', 'Miami Heat': 'mia',
  'Milwaukee Bucks': 'mil', 'Minnesota Timberwolves': 'min', 'New Orleans Pelicans': 'no',
  'New York Knicks': 'ny', 'Oklahoma City Thunder': 'okc', 'Orlando Magic': 'orl',
  'Philadelphia 76ers': 'phi', 'Phoenix Suns': 'phx', 'Portland Trail Blazers': 'por',
  'Sacramento Kings': 'sac', 'San Antonio Spurs': 'sa', 'Toronto Raptors': 'tor',
  'Utah Jazz': 'utah', 'Washington Wizards': 'wsh',
}

// ESPN's AFL paths use the standard club codes (espncdn /i/teamlogos/afl/500/).
const AFL: Record<string, string> = {
  'Adelaide Crows': 'adel', 'Adelaide': 'adel',
  'Brisbane Lions': 'bl', 'Brisbane': 'bl',
  'Carlton Blues': 'carl', 'Carlton': 'carl',
  'Collingwood Magpies': 'coll', 'Collingwood': 'coll',
  'Essendon Bombers': 'ess', 'Essendon': 'ess',
  'Fremantle Dockers': 'frem', 'Fremantle': 'frem',
  'Geelong Cats': 'geel', 'Geelong': 'geel',
  'Gold Coast Suns': 'gcfc', 'Gold Coast': 'gcfc',
  'Greater Western Sydney Giants': 'gws', 'GWS Giants': 'gws', 'GWS': 'gws',
  'Hawthorn Hawks': 'haw', 'Hawthorn': 'haw',
  'Melbourne Demons': 'melb', 'Melbourne': 'melb',
  'North Melbourne Kangaroos': 'nm', 'North Melbourne': 'nm', 'Kangaroos': 'nm',
  'Port Adelaide Power': 'padl', 'Port Adelaide': 'padl',
  'Richmond Tigers': 'rich', 'Richmond': 'rich',
  'St Kilda Saints': 'stk', 'St Kilda': 'stk',
  'Sydney Swans': 'syd', 'Sydney': 'syd',
  'West Coast Eagles': 'wce', 'West Coast': 'wce',
  'Western Bulldogs': 'wb', 'Bulldogs': 'wb',
}

// (No NRL map here — ESPN doesn't host NRL crests. NRL logos come from the
// `entity_logos` Wikipedia cache via resolveLogo's fallback order.)

const WNBA: Record<string, string> = {
  'Atlanta Dream': 'atl', 'Chicago Sky': 'chi', 'Connecticut Sun': 'conn',
  'Dallas Wings': 'dal', 'Golden State Valkyries': 'gs', 'Indiana Fever': 'ind',
  'Las Vegas Aces': 'lv', 'Los Angeles Sparks': 'la', 'Minnesota Lynx': 'min',
  'New York Liberty': 'ny', 'Phoenix Mercury': 'phx', 'Seattle Storm': 'sea',
  'Washington Mystics': 'wsh',
}

interface LeagueMap {
  espnSport: string
  teams: Record<string, string>
}

/** Resolve which ESPN league applies from the feed's sport/league slugs. */
function leagueMap(sport: string, league: string): LeagueMap | null {
  const s = sport.toLowerCase()
  const l = league.toLowerCase()
  if (l === 'mlb' || s === 'mlb') return { espnSport: 'mlb', teams: MLB }
  if (l === 'nfl' || s === 'nfl' || s === 'americanfootball') return { espnSport: 'nfl', teams: NFL }
  if (l === 'nhl' && (s === 'icehockey' || s === 'hockey')) return { espnSport: 'nhl', teams: NHL }
  if (l === 'nba') return { espnSport: 'nba', teams: NBA }
  if (l === 'wnba') return { espnSport: 'wnba', teams: WNBA }
  if (l === 'afl' || s === 'afl') return { espnSport: 'afl', teams: AFL }
  return null
}

/** ESPN logo URL for a team, or null when we can't confidently resolve one. */
export function espnLogoUrl(sport: string, league: string, teamName: string): string | null {
  const m = leagueMap(sport, league)
  if (!m) return null
  const abbr = m.teams[teamName.trim()]
  return abbr ? `https://a.espncdn.com/i/teamlogos/${m.espnSport}/500/${abbr}.png` : null
}
