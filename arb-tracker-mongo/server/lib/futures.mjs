import { betsConfigured, betsDb } from './betsMongo.mjs';
import { apiFutureOdds, apiFutures } from './sportApi.mjs';

/**
 * The futures tab: Optic's catalogue of futures, each joined to the mybet
 * future that is the same proposition, and one future's prices from the
 * books beside mybet's own.
 *
 * Optic lists a future per league with a name ("Championship Winner",
 * "Stanley Cup Winner", "Eastern Conference Winner"); mybet keeps one
 * document per future in `mybet_events` with a `comps` map of selections and
 * a description that reads "<competition> <season> - <market>" ("NBA 2026/27
 * - Outright Winner", "English Premier League 2026/27 - Winner"). The join is
 * on sport, competition and market, with an alias table for the competitions
 * the two spell differently and a token match for the rest. Nothing is
 * invented: an Optic future with no mybet twin shows the books alone, and a
 * mybet future Optic does not list (AFL, Supercars) is kept as its own row so
 * the tab still shows what mybet is offering.
 */

const MYBET_SPORT = {
  'australian rules': 'aussierules', basketball: 'basketball', cricket: 'cricket', golf: 'golf',
  gridiron: 'amfootball', 'ice hockey': 'icehockey', 'rugby league': 'rugbyleague',
  'rugby union': 'rugbyunion', soccer: 'soccer', tennis: 'tennis', baseball: 'baseball',
  'motor racing': 'motorsport', darts: 'darts', 'mixed martial arts': 'mma', boxing: 'boxing',
};
const SPORT_LABEL = {
  soccer: 'Soccer', basketball: 'Basketball', baseball: 'Baseball', icehockey: 'Ice Hockey',
  amfootball: 'American Football', tennis: 'Tennis', aussierules: 'Aussie Rules',
  rugbyleague: 'Rugby League', rugbyunion: 'Rugby Union', cricket: 'Cricket', golf: 'Golf',
  esports: 'Esports', motorsport: 'Motor Racing', darts: 'Darts', mma: 'MMA', boxing: 'Boxing',
};

/** mybet's competition, as written at the front of a description -> Optic league id. */
const COMP_ALIASES = [
  [/^english premier league/, 'england_-_premier_league'],
  [/^english championship/, 'england_-_championship'],
  [/^english league (one|1)/, 'england_-_league_1'],
  [/^english league (two|2)/, 'england_-_league_2'],
  [/^german bundesliga/, 'germany_-_bundesliga'],
  [/^french ligue (one|1)/, 'france_-_ligue_1'],
  [/^italian serie a/, 'italy_-_serie_a'],
  [/^spanish la liga/, 'spain_-_la_liga'],
  [/^dutch eredivisie/, 'netherlands_-_eredivisie'],
  [/^portuguese primeira/, 'portugal_-_primeira_liga'],
  [/^scottish premiership/, 'scotland_-_premiership'],
  [/^australian a-league/, 'australia_-_a-league'],
  [/^uefa champions league/, 'uefa_-_champions_league'],
  [/^uefa europa league/, 'uefa_-_europa_league'],
  [/^uefa (europa )?conference league/, 'uefa_-_europa_conference_league'],
  [/^(usa )?major league soccer|^mls\b/, 'usa_-_major_league_soccer'],
  [/^fifa world cup/, 'fifa_-_world_cup'],
  [/^nba\b/, 'nba'], [/^wnba\b/, 'wnba'], [/^nbl\b/, 'australia_-_nbl'], [/^euroleague/, 'euroleague'],
  [/^nfl\b/, 'nfl'], [/^nhl\b/, 'nhl'], [/^mlb\b/, 'mlb'],
  [/^big bash/, 'australia_-_big_bash_league'], [/^wbbl|^womens big bash/, 'australia_-_big_bash_league_women'],
  [/^ipl\b|^indian premier league/, 'india_-_ipl'], [/^sa20/, 'south_africa_-_sa20'],
  [/^(the )?ashes/, 'international_-_the_ashes'],
  [/^nrl\b/, 'australia_-_nrl'],
];

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const NOISE = new Set(['futures', 'future', 'outright', 'the', 'of', 'and', '-', 'tour', 'mens', 'womens', 'men', 'women', 'championship', 'winner', 'dpw', 'pga', 'uspga']);
const tokens = (s) => new Set(
  norm(s).replace(/\b\d{4}(?:\/\d{2,4})?\b/g, ' ').split(/[^a-z0-9]+/).filter((t) => t && !NOISE.has(t)),
);
const yearOf = (s) => (String(s ?? '').match(/\b(20\d{2})(?:\/\d{2,4})?\b/) ?? [])[1] ?? null;

/** "Outright Winner", "Super Bowl LXI Winner", "Premiership Winner", "Champion" -> the outright. */
const OUTRIGHT_MARKET = /^((outright|championship|premiership|grand final|tournament|series|super bowl( [ivxl]+)?|stanley cup|world series) )?(winner|champion)$/i;

/** description -> { comp, market, outright } */
function parseDescription(desc) {
  const d = String(desc ?? '').trim();
  const i = d.lastIndexOf(' - ');
  const comp = i > 0 ? d.slice(0, i).trim() : d;
  const market = i > 0 ? d.slice(i + 3).trim() : 'Winner';
  return { comp, market, outright: OUTRIGHT_MARKET.test(market) };
}

/**
 * The Optic league for a mybet competition. `exact` says the alias table
 * named it, so the competition is settled and only the market is left to
 * match; a tour (ATP, PGA) is only where to look, and the competition's own
 * words still have to be found in the future's name.
 */
function mybetLeagueId(comp, sport) {
  const c = norm(comp);
  for (const [re, id] of COMP_ALIASES) if (re.test(c)) return { id, exact: true };
  if (sport === 'tennis') return { id: /womens|women|ladies/.test(c) ? 'wta' : 'atp', exact: false };
  if (sport === 'golf') return { id: /dpw|dp world|european/.test(c) ? 'dp_world_tour' : /lpga/.test(c) ? 'lpga' : 'pga', exact: false };
  return null;
}

/**
 * The Optic future a mybet future is, or null.
 *
 * Within the league the alias names (or, failing that, the league whose name
 * shares the most words with the competition), the outright is the row
 * flagged outright; any other market is matched word for word on its name,
 * with the year required to agree where both carry one (tennis and golf
 * name the event and the year in the future itself).
 */
function matchOptic(m, optic) {
  const sport = MYBET_SPORT[norm(m.sport)];
  if (!sport) return null;
  const { comp, market, outright } = parseDescription(m.description);
  const compT = tokens(comp);
  const year = yearOf(comp);
  let pool = optic.filter((f) => f.sport === sport);
  if (!pool.length) return null;
  const alias = mybetLeagueId(comp, sport);
  const leagueId = alias?.id ?? null;
  let inLeague = leagueId ? pool.filter((f) => f.league_id === leagueId) : [];
  if (!inLeague.length) {
    // Best league by shared words, and only if it is a clear best.
    const scored = new Map();
    for (const f of pool) {
      const lt = tokens(f.league_name);
      let hit = 0;
      for (const t of compT) if (lt.has(t)) hit++;
      if (hit) scored.set(f.league_id, Math.max(scored.get(f.league_id) ?? 0, hit / Math.max(1, compT.size)));
    }
    const best = [...scored.entries()].sort((a, b) => b[1] - a[1]);
    if (best.length && best[0][1] >= 0.5 && (best.length === 1 || best[0][1] > best[1][1])) {
      inLeague = pool.filter((f) => f.league_id === best[0][0]);
    }
  }
  if (!inLeague.length) return null;
  /*
   * Every word of the competition that the league's own name does not
   * already carry must be in the future's tournament and name, and the year
   * must agree where both have one. "NBA 2026/27" against league "NBA" asks
   * nothing more of "Championship Winner"; "Australian Open 2027 Mens"
   * against league "ATP" asks for "australian" and "open", which picks the
   * Australian Open out of the four slams; "PGA Austin Championship 2026"
   * asks for "austin" out of the tour's fifty.
   */
  const leagueT = tokens(inLeague[0].league_name);
  const compOnly = alias?.exact ? [] : [...compT].filter((t) => !leagueT.has(t));
  const nameT = (f) => tokens(`${f.tournament ?? ''} ${f.name}`);
  const compFits = (f) => {
    const nt = nameT(f);
    for (const t of compOnly) if (!nt.has(t)) return false;
    const fy = yearOf(`${f.tournament ?? ''} ${f.name}`);
    return !(year && fy && year !== fy);
  };
  if (outright) {
    const outs = inLeague.filter((f) => f.outright && compFits(f));
    return outs.length === 1 ? outs[0] : null;
  }
  // Any other market is matched on its own words against the future's name
  // with the competition's words taken out: the same words, in which case
  // "Eastern Conference Winner" is not "Eastern Conference #1 Seed", or as
  // the only future containing them.
  const marketT = tokens(market);
  const sameWords = (a, b) => a.size === b.size && [...a].every((t) => b.has(t));
  const rest = inLeague.filter((f) => !f.outright && compFits(f));
  const exact = rest.filter((f) => {
    const nt = nameT(f);
    for (const t of compOnly) nt.delete(t);
    for (const t of leagueT) nt.delete(t);
    return sameWords(marketT, nt);
  });
  if (exact.length === 1) return exact[0];
  const loose = rest.filter((f) => { const nt = nameT(f); return [...marketT].every((t) => nt.has(t)); });
  return loose.length === 1 ? loose[0] : null;
}

const asDate = (v) => (v instanceof Date ? v : v ? new Date(v) : null);
const iso = (v) => { const d = asDate(v); return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

/** mybet's current futures: the documents with a `comps` map, still open, seen this week. */
async function mybetFutures() {
  if (!betsConfigured) return [];
  const db = await betsDb();
  if (!db) return [];
  const now = new Date();
  const since = new Date(Date.now() - 7 * 864e5);
  return db.collection('mybet_events')
    .find({
      comps: { $exists: true },
      description: { $not: /\bv\b|\bvs\b/i },
      $and: [
        { $or: [{ outcomeAt: { $gte: now } }, { outcomeAt: { $gte: now.toISOString() } }] },
        { $or: [{ lastSeenAt: { $gte: since } }, { lastSeenAt: { $gte: since.toISOString() } }] },
      ],
    })
    .project({ _id: 1, description: 1, sport: 1, outcomeAt: 1, lastSeenAt: 1, lastChangedAt: 1 })
    .limit(2000)
    .toArray()
    .catch(() => []);
}

const PROP_LIKE = /\bplayer\b|\bto have\b|\bto score\b|\bhi bat\b|partnership|\bdouble\b|margin|race to|first team|tryscorer|fastest lap|qualifying|jockey/i;

/** The catalogue: Optic's futures with their mybet twin attached, plus mybet's own that Optic lacks. */
export async function futuresList() {
  const [optic, mybet] = await Promise.all([
    apiFutures().catch(() => []),
    mybetFutures(),
  ]);
  const rows = optic.map((f) => ({
    id: f.id, source: 'optic', sport: f.sport, sportLabel: SPORT_LABEL[f.sport] ?? f.sport,
    leagueId: f.league_id, leagueName: f.league_name, tournament: f.tournament ?? null,
    name: f.name, type: f.type ?? null, outright: !!f.outright, startsAt: f.start_date ?? null,
    mybetId: null, mybetName: null,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let matched = 0;
  for (const m of mybet) {
    const { comp, market, outright } = parseDescription(m.description);
    // Props filed under a match are in the same collection; they are not futures.
    if (PROP_LIKE.test(m.description ?? '') && !outright) continue;
    const hit = matchOptic(m, optic);
    if (hit && byId.get(hit.id) && !byId.get(hit.id).mybetId) {
      const r = byId.get(hit.id);
      r.mybetId = String(m._id);
      r.mybetName = m.description ?? null;
      matched++;
      continue;
    }
    const sport = MYBET_SPORT[norm(m.sport)];
    // A sport the board does not carry (racing's jockey challenges) is not a
    // future for this tab.
    if (!sport) continue;
    rows.push({
      id: `mybet:${m._id}`, source: 'mybet', sport, sportLabel: SPORT_LABEL[sport] ?? m.sport,
      leagueId: `mybet:${norm(comp).replace(/\b\d{4}(?:\/\d{2,4})?\b/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      leagueName: comp, tournament: null, name: market, type: null, outright,
      startsAt: iso(m.outcomeAt), mybetId: String(m._id), mybetName: m.description ?? null,
    });
  }
  rows.sort((a, b) => a.sportLabel.localeCompare(b.sportLabel) || a.leagueName.localeCompare(b.leagueName) || Number(b.outright) - Number(a.outright) || a.name.localeCompare(b.name));
  return { count: rows.length, matched, mybet: mybet.length, data: rows };
}

/** mybet's selections on one future, as odds rows. */
async function mybetRows(mybetId, futureId) {
  if (!betsConfigured || !mybetId) return [];
  const db = await betsDb();
  if (!db) return [];
  const doc = await db.collection('mybet_events').findOne({ _id: Number(mybetId) }).catch(() => null);
  if (!doc?.comps) return [];
  const at = iso(doc.lastChangedAt ?? doc.lastSeenAt);
  const out = [];
  for (const c of Object.values(doc.comps)) {
    if (!c?.team) continue;
    const price = Number(c.win);
    const ladder = (c.flucs?.Win ?? [])
      .map((h) => ({ p: Number(h?.v), t: iso(h?.at) }))
      .filter((h) => Number.isFinite(h.p) && h.p > 1 && h.t);
    // 0 is how mybet writes "not offering"; an eliminated runner is shown
    // suspended at its last price rather than dropped, which is what the
    // grid does with a book that pulls a market.
    const live = Number.isFinite(price) && price > 1;
    const last = ladder.length ? ladder[ladder.length - 1].p : null;
    if (!live && last == null) continue;
    out.push({
      fixture_id: futureId, market_id: 'outright', market_name: 'Outright',
      selection: c.team, normalized_selection: null, line: null, line_group: null, pair_key: null,
      outcome_no: null, is_main: true, sportsbook: 'mybet', is_lay: false, is_live: false,
      current_price: live ? price : last, open_price: Number(c.openingWin) > 1 ? Number(c.openingWin) : ladder[0]?.p ?? null,
      open_at: ladder[0]?.t ?? null, close_price: null, closed_at: null, current_at: at,
      status: live && !c.eliminated ? 'active' : 'suspended', flucs: ladder, daily_prices: {},
      price_6h: null, price_3h: null, price_1h: null, price_30m: null, price_10m: null,
    });
  }
  return out;
}

/** One future's prices: the books through the surface, and mybet's own beside them. */
export async function futureOdds(id) {
  if (!id) return [];
  if (id.startsWith('mybet:')) return mybetRows(id.slice(6), id);
  const list = await futuresList().catch(() => ({ data: [] }));
  const row = list.data.find((r) => r.id === id);
  const [books, ours] = await Promise.all([
    apiFutureOdds(id).catch(() => []),
    row?.mybetId ? mybetRows(row.mybetId, id) : [],
  ]);
  return [...ours, ...books];
}
