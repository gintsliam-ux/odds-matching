import { betsConfigured, betsDb } from './betsMongo.mjs';
import { multiBetsFor, swiftbetFor } from './bets.mjs';
import { leagueFor, teamLogos } from './events.mjs';
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
const OUTRIGHT_MARKET = /^((outright|championship|premiership|grand final|tournament|series|race|super bowl( [ivxl]+)?|stanley cup|world series) )?(winner|champions?)$/i;

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
function matchOptic({ sport, comp, market, outright }, optic) {
  if (!sport) return null;
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
  const [optic, mybet, swift] = await Promise.all([
    apiFutures().catch(() => []),
    mybetFutures(),
    swiftFutures(),
  ]);
  const rows = optic.map((f) => ({
    id: f.id, source: 'optic', sport: f.sport, sportLabel: SPORT_LABEL[f.sport] ?? f.sport,
    leagueId: f.league_id, leagueName: f.league_name, tournament: f.tournament ?? null,
    name: f.name, type: f.type ?? null, outright: !!f.outright, startsAt: f.start_date ?? null,
    mybetId: null, mybetName: null, swiftId: null, swiftMarket: null, swiftName: null,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let matched = 0;
  for (const m of mybet) {
    const { comp, market, outright } = parseDescription(m.description);
    // Props filed under a match are in the same collection; they are not futures.
    if (PROP_LIKE.test(m.description ?? '') && !outright) continue;
    const hit = matchOptic({ sport: MYBET_SPORT[norm(m.sport)], comp, market, outright }, optic);
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
      swiftId: null, swiftMarket: null, swiftName: null,
    });
  }
  // Swiftbet's futures, joined the same way; one Swiftbet does not list on
  // Optic is its own row, as mybet's are.
  let swiftMatched = 0;
  for (const sf of swift) {
    const hit = matchOptic(sf, optic);
    if (hit && byId.get(hit.id) && !byId.get(hit.id).swiftId) {
      const r = byId.get(hit.id);
      r.swiftId = sf.swiftId;
      r.swiftMarket = sf.swiftMarket;
      r.swiftName = sf.swiftName;
      swiftMatched++;
      continue;
    }
    rows.push({
      id: `swift:${sf.swiftId}:${sf.marketIndex}`, source: 'swiftbet', sport: sf.sport, sportLabel: SPORT_LABEL[sf.sport] ?? sf.sport,
      leagueId: `swift:${norm(sf.comp).replace(/\b\d{4}(?:\/\d{2,4})?\b/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      // The event names the proposition where it is not the competition's
      // own ("United States Las Vegas Grand Prix Race", not "Winner").
      leagueName: sf.comp, tournament: null, type: null, outright: sf.outright,
      name: sf.outright && norm(sf.eventName) !== norm(sf.comp) ? sf.eventName : sf.market,
      startsAt: sf.startsAt, mybetId: null, mybetName: null,
      swiftId: sf.swiftId, swiftMarket: sf.swiftMarket, swiftName: sf.swiftName,
    });
  }
  rows.sort((a, b) => a.sportLabel.localeCompare(b.sportLabel) || a.leagueName.localeCompare(b.leagueName) || Number(b.outright) - Number(a.outright) || a.name.localeCompare(b.name));
  await attachLeagues(rows);
  return { count: rows.length, matched, mybet: mybet.length, swift: swift.length, swiftMatched, data: rows };
}

/*
 * Swiftbet's futures: the open events whose name is not a match, each
 * market a proposition. "NBA 2026/27 Champions" is one event with one market
 * of the same name; "2026 Austin Championship" is one event with "outright
 * winner", "top 5" and "top 10". Read as competition + market so they join
 * the way mybet's descriptions do.
 */
const SWIFT_SPORT = {
  'american football': 'amfootball', basketball: 'basketball', golf: 'golf', 'rugby league': 'rugbyleague',
  'rugby union': 'rugbyunion', soccer: 'soccer', tennis: 'tennis', cricket: 'cricket', baseball: 'baseball',
  'ice hockey': 'icehockey', 'motor sport': 'motorsport', 'australian rules': 'aussierules',
};
const SWIFT_MARKET_LABEL = { 'outright winner': 'Winner', 'race winner': 'Winner', winner: 'Winner', 'top 5': 'Top 5 Finish', 'top 10': 'Top 10 Finish', 'top 20': 'Top 20 Finish' };
async function swiftFutures() {
  if (!betsConfigured) return [];
  const db = await betsDb();
  if (!db) return [];
  const since = new Date(Date.now() - 7 * 864e5);
  const docs = await db.collection('events')
    .find({
      finished: { $ne: true },
      name: { $not: /\bvs?\b/i },
      'markets.0': { $exists: true },
      $or: [{ scraped_at: { $gte: since } }, { scraped_at: { $gte: since.toISOString() } }],
    })
    .project({ name: 1, start_date: 1, 'sport.name': 1, 'competition.name': 1, markets: { name: 1, id: 1, selections: { name: 1 } } })
    .limit(500)
    .toArray()
    .catch(() => []);
  const out = [];
  for (const e of docs) {
    const sport = SWIFT_SPORT[norm(e.sport?.name)];
    if (!sport) continue;
    const compName = String(e.competition?.name ?? '').replace(/\bfutures?\b/gi, '').trim();
    const eventName = String(e.name ?? '').trim();
    // The event carries the year on a golf tournament; the competition on a
    // league future. Both words go in, the matcher reads them as one phrase.
    const comp = /\b20\d{2}\b/.test(eventName) && !/\b20\d{2}\b/.test(compName) ? eventName : compName || eventName;
    (e.markets ?? []).forEach((m, i) => {
      if (!(m.selections ?? []).length) return;
      const raw = String(m.name ?? '').trim();
      // A market named after its event IS the event's proposition.
      let market = SWIFT_MARKET_LABEL[norm(raw)] ?? (norm(raw) === norm(eventName) ? eventName.replace(/^.*\b(20\d{2}(?:\/\d{2})?)\s*/, '') : raw);
      // NFL's conference title is its "championship" on Swiftbet.
      market = market.replace(/\b(AFC|NFC) Championship\b/i, '$1 Conference');
      out.push({
        sport, comp, market, outright: OUTRIGHT_MARKET.test(market),
        swiftId: String(e._id), marketIndex: i, swiftMarket: raw, swiftName: `${eventName} · ${raw}`,
        eventName, startsAt: iso(e.start_date),
      });
    });
  }
  return out;
}

/** Swiftbet's selections on one future's market, as odds rows. */
async function swiftRows(swiftId, marketName, futureId) {
  if (!betsConfigured || !swiftId) return [];
  const db = await betsDb();
  if (!db) return [];
  const ev = await db.collection('events').findOne({ _id: swiftId }).catch(() => null);
  const m = (ev?.markets ?? []).find((x) => norm(x?.name) === norm(marketName));
  if (!m) return [];
  const at = iso(ev.scraped_at);
  const out = [];
  for (const sel of m.selections ?? []) {
    if (!sel?.name) continue;
    const price = Number(sel.odds);
    const ladder = (sel.price_history ?? [])
      .map((h) => ({ p: Number(h?.odds), t: iso(h?.ts) }))
      .filter((h) => Number.isFinite(h.p) && h.p > 1 && h.t)
      .sort((a, b) => new Date(a.t) - new Date(b.t));
    const live = Number.isFinite(price) && price > 1;
    const last = ladder.length ? ladder[ladder.length - 1].p : null;
    if (!live && last == null) continue;
    out.push({
      fixture_id: futureId, market_id: 'outright', market_name: 'Outright',
      selection: sel.name, normalized_selection: null, line: null, line_group: null, pair_key: null,
      outcome_no: null, is_main: true, sportsbook: 'swiftbet', is_lay: false, is_live: false,
      current_price: live ? price : last, open_price: ladder[0]?.p ?? null, open_at: ladder[0]?.t ?? null,
      close_price: null, closed_at: null, current_at: at,
      status: live ? 'active' : 'suspended', flucs: ladder, daily_prices: {},
      price_6h: null, price_3h: null, price_1h: null, price_30m: null, price_10m: null,
    });
  }
  return out;
}

/**
 * The badge each row draws, derived the way the board derives a fixture's:
 * Optic names a league "England - Premier League", which is the board's
 * category and tournament; a bare "NBA" is a tournament with no category; a
 * mybet competition "AFL 2027 Futures" is the tournament with the season
 * words taken off. One derivation per distinct league, not per row.
 */
async function attachLeagues(rows) {
  const cache = new Map();
  for (const r of rows) {
    const key = `${r.sport}|${r.leagueName}`;
    if (!cache.has(key)) {
      let category = null;
      let tournament = r.leagueName;
      const dash = r.leagueName.indexOf(' - ');
      if (r.source === 'optic' && dash > 0) {
        category = r.leagueName.slice(0, dash).trim();
        tournament = r.leagueName.slice(dash + 3).trim();
      }
      if (r.source === 'mybet') {
        tournament = r.leagueName.replace(/\b\d{4}(?:\/\d{2,4})?\b/g, ' ').replace(/\bfutures?\b/gi, ' ').replace(/\s+/g, ' ').trim() || r.leagueName;
      }
      if (r.sport === 'tennis' && /^(atp|wta)$/i.test(tournament)) category = tournament.toUpperCase();
      cache.set(key, leagueFor(r.sport, category, tournament).catch(() => null));
    }
    const league = await cache.get(key);
    r.league = league ?? { id: r.sport, name: r.leagueName, code: r.leagueName.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase(), sport: r.sportLabel };
  }
}

export const isFutureId = (id) => /^type_/.test(String(id ?? '')) || String(id ?? '').startsWith('mybet:') || String(id ?? '').startsWith('swift:');

/** The bets tab for a future: mybet's singles and multis on its mybet event, when it has one. */
export async function betsForFuture(id) {
  const empty = (reason) => ({ bets: [], reason });
  const result = { configured: betsConfigured, swiftbet: empty('unmapped'), mybet: empty('unmapped'), multis: empty('unmapped') };
  if (!betsConfigured) {
    result.swiftbet = result.mybet = result.multis = empty('not-configured');
    return result;
  }
  const list = await futuresList().catch(() => ({ data: [] }));
  const row = list.data.find((r) => r.id === id);
  if (!row?.mybetId && !row?.swiftId) return result;
  const db = await betsDb();
  if (!db) return result;
  const jobs = [];
  if (row.mybetId) {
    jobs.push(multiBetsFor(db, Number(row.mybetId), id).then(({ mybet, multis }) => {
      result.mybet = { bets: mybet, reason: mybet.length ? null : 'none' };
      result.multis = { bets: multis, reason: multis.length ? null : 'none' };
    }));
  }
  if (row.swiftId) {
    jobs.push(swiftbetFor(db, row.swiftId).then((bets) => {
      result.swiftbet = { bets, reason: bets.length ? null : 'none' };
    }));
  }
  await Promise.all(jobs);
  return result;
}

/** The details tab for a future, in the fixture's shape: what it is, when it settles, and how mybet sees it. */
export async function futureDetails(id) {
  const [list, rows] = await Promise.all([
    futuresList().catch(() => ({ data: [] })),
    futureOdds(id).catch(() => []),
  ]);
  const row = list.data.find((r) => r.id === id);
  if (!row) return null;
  const books = new Set();
  let firstSeen = null;
  let lastSeen = null;
  for (const r of rows) {
    if (r.sportsbook) books.add(r.sportsbook);
    const o = r.open_at ? Date.parse(r.open_at) : NaN;
    const c = r.current_at ? Date.parse(r.current_at) : NaN;
    if (Number.isFinite(o) && (!firstSeen || o < firstSeen)) firstSeen = o;
    if (Number.isFinite(c) && (!lastSeen || c > lastSeen)) lastSeen = c;
  }
  let mybetEvent = null;
  if (row.mybetId && betsConfigured) {
    const db = await betsDb();
    const doc = db ? await db.collection('mybet_events').findOne({ _id: Number(row.mybetId) }, { projection: { comps: 0 } }).catch(() => null) : null;
    if (doc) {
      mybetEvent = {
        id: String(doc._id), name: doc.description ?? row.mybetName, competition: null, competitionId: null,
        sport: doc.sport ?? null, feedId: doc.feedId ?? null, firstSeenAt: iso(doc.firstSeenAt), lastSeenAt: iso(doc.lastSeenAt),
        lastChangedAt: iso(doc.lastChangedAt), feedLastUpdated: iso(doc.feedLastUpdated), outcomeAt: iso(doc.outcomeAt),
        suspendAt: iso(doc.suspendAt), teams: [],
      };
    }
  }
  let swiftEvent = null;
  if (row.swiftId && betsConfigured) {
    const db = await betsDb();
    const doc = db ? await db.collection('events').findOne({ _id: row.swiftId }, { projection: { markets: 0, teams: 0 } }).catch(() => null) : null;
    if (doc) {
      swiftEvent = {
        id: String(doc._id), name: doc.name ?? row.swiftName, competition: doc.competition?.name ?? null, competitionId: doc.competition?.id ?? null,
        sport: doc.sport?.name ?? null, status: doc.status ?? null, viewStatus: doc.event_view_status ?? null, feedStatus: doc.feed_status ?? null,
        finished: doc.finished ?? null, startsAt: iso(doc.start_date), finishedAt: iso(doc.finished_at), marketCount: doc.market_count ?? null, teams: [],
      };
    }
  }
  const none = { mapped: false, link: null, event: null };
  return {
    fixtureId: id, venue: null, location: null, country: null, season: null, seasonType: null, tier: null, broadcast: null,
    status: 'upcoming', opticStatus: null, isLive: false, source: row.source,
    category: row.sportLabel, tournament: row.leagueName, tournamentStage: row.tournament,
    opticLeague: row.source === 'optic' ? row.leagueId : null, opticLeagueId: null, currentRound: row.name,
    hasOdds: rows.length > 0, hasSp: false, competitors: [],
    mapping: {
      configured: betsConfigured,
      competitions: { swift: [], mybet: [] },
      swift: row.swiftId
        ? { mapped: true, link: { eventId: row.swiftId, confidence: null, source: 'futures name match', resolvedAt: null, actualStart: null }, event: swiftEvent ?? { id: row.swiftId, name: row.swiftName, competition: null, competitionId: null, sport: null, teams: [] } }
        : none,
      mybet: row.mybetId
        ? { mapped: true, link: { eventId: row.mybetId, confidence: null, source: 'futures name match', resolvedAt: null, actualStart: null }, event: mybetEvent ?? { id: row.mybetId, name: row.mybetName, competition: null, competitionId: null, sport: null, teams: [] } }
        : none,
    },
    times: { scheduledStart: row.startsAt, actualStart: null, endDate: row.startsAt, oddsOpenAt: firstSeen ? new Date(firstSeen).toISOString() : null, oddsCloseAt: null, settledAt: null, createdAt: null, updatedAt: lastSeen ? new Date(lastSeen).toISOString() : null },
    coverage: { rows: rows.length, liveRows: 0, books: [...books].sort(), markets: rows.length ? ['outright'] : [], firstSeen: firstSeen ? new Date(firstSeen).toISOString() : null, lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null },
  };
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
  const list = await futuresList().catch(() => ({ data: [] }));
  const row = list.data.find((r) => r.id === id);
  const [books, ours, theirs] = await Promise.all([
    id.startsWith('mybet:') || id.startsWith('swift:') ? [] : apiFutureOdds(id).catch(() => []),
    row?.mybetId ? mybetRows(row.mybetId, id) : [],
    row?.swiftId ? swiftRows(row.swiftId, row.swiftMarket, id) : [],
  ]);
  const rows = [...theirs, ...ours, ...books];
  // The crest beside each team, from the same entities the board draws from,
  // and one key per team across the books' spellings so the grid merges
  // "Philadelphia Phillies", "Philadephia Phillies" and "Phillies" into a
  // row. A player market has none of this and draws as before.
  if (row && row.type !== 'PLAYER' && rows.length) {
    const names = [...new Set(rows.map((r) => r.selection).filter(Boolean))];
    const logos = await teamLogos(row.sport, names).catch(() => new Map());
    const keyed = mergeSpellings(names, logos);
    for (const r of rows) {
      const k = keyed.get(r.selection);
      const hit = k ? logos.get(k.canonical) : null;
      r.selection_key = k?.key ?? null;
      r.selection_logo = hit?.logoUrl ?? null;
      r.selection_country = hit?.country ?? null;
    }
  }
  return rows;
}

/*
 * One key per team across the books' spellings.
 *
 * The entities table settles most of it: every spelling it knows resolves to
 * the entity's own key, so "Manchester City FC" and "Manchester City" meet.
 * The short forms the futures lists use — "Man City", "Penrith", "Souths",
 * "Nottm Forest", a TAB "Philadephia" — are then matched by their words
 * against the names the table did resolve: each word must equal a word of
 * the candidate, abbreviate it (a prefix of three letters or more, or one
 * of the usual contractions), or be one letter off a long one. Only a match
 * that is unique among the candidates is taken; anything ambiguous stays its
 * own row rather than being guessed onto a team.
 */
const NAME_NOISE = new Set(['fc', 'afc', 'sc', 'cf', 'cd', 'ac', 'as', 'fk', 'sk', 'bk', 'hc', 'kv', 'osc', 'if', 'the', 'club', 'spor', 'kulubu', 'kulup', 'de', 'ssc', 'us', 'rc']);
const SHORT_FORMS = { man: 'manchester', syd: 'sydney', utd: 'united', nottm: 'nottingham', souths: 'south sydney', st: 'saint', bris: 'brisbane', wolves: 'wolverhampton', spurs: 'tottenham', sharks: 'cronulla', nth: 'north', sth: 'south', qld: 'queensland', nsw: 'new south wales', ill: 'illawarra', nz: 'new zealand', la: 'los angeles', ny: 'new york', sf: 'san francisco', praha: 'prague', muenchen: 'munich', munchen: 'munich', torino: 'turin', milano: 'milan', napoli: 'naples', lisboa: 'lisbon' };
const nameTokens = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9]+/).filter((t) => t && !NAME_NOISE.has(t));
const editOne = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};
const wordFits = (w, candTokens) => candTokens.some((c) => c === w || (w.length >= 3 && c.startsWith(w)) || (w.length >= 6 && editOne(w, c)));
// The word as written first ("St George" is "St George", not "Saint"), then its expansion.
const tokenFits = (t, candTokens) => wordFits(t, candTokens) || (!!SHORT_FORMS[t] && SHORT_FORMS[t].split(' ').every((w) => wordFits(w, candTokens)));
// The key a spelling's entity gives it, without the club nouns: "arsenal_fc"
// and "arsenal" are one entity whichever of them the table filed it under.
const bareKey = (key) => nameTokens(String(key ?? '').replace(/_/g, ' ')).join('_');
function mergeSpellings(names, logos) {
  const out = new Map(); // spelling -> { key, canonical }
  const canon = []; // { name, key, tokens }
  // Two spellings with the same crest are one team whatever the table keyed
  // them as; the first key seen for a crest stands for all of them.
  const keyByLogo = new Map();
  for (const n of names) {
    const e = logos.get(n);
    // A name the table knows but has no crest for ("Brighton" beside
    // "Brighton & Hove Albion FC") is matched by its words like an unknown
    // one, so it joins the crested spelling rather than standing alone.
    if (!e?.key || !e.logoUrl) continue;
    let key = bareKey(e.key) || e.key;
    if (keyByLogo.has(e.logoUrl)) key = keyByLogo.get(e.logoUrl); else keyByLogo.set(e.logoUrl, key);
    out.set(n, { key, canonical: n });
    canon.push({ name: n, key, tokens: nameTokens(n) });
  }
  // The longest known spelling of each key is its canonical, for the crest.
  const canonicalOf = new Map();
  for (const c of canon) if (!canonicalOf.has(c.key) || c.name.length > canonicalOf.get(c.key).length) canonicalOf.set(c.key, c.name);
  for (const [n, v] of out) v.canonical = canonicalOf.get(v.key) ?? v.canonical;
  for (const n of names) {
    if (out.has(n)) continue;
    const toks = nameTokens(n);
    if (!toks.length) continue;
    const hits = new Set();
    for (const c of canon) if (toks.every((t) => tokenFits(t, c.tokens))) hits.add(c.key);
    if (hits.size === 1) { const key = [...hits][0]; out.set(n, { key, canonical: canonicalOf.get(key) }); }
    else {
      // Its own key, the entity's where the table knows it, so two uncrested
      // spellings the table files together still meet.
      const e = logos.get(n);
      out.set(n, { key: (e?.key && bareKey(e.key)) || nameTokens(n).join('_'), canonical: n });
    }
  }
  /*
   * Last, a name that is a strict part of exactly one other: "Athletics"
   * inside "Oakland Athletics" (the table files the renamed club twice,
   * with two crests), "Brighton" inside "Brighton & Hove Albion", "Lens"
   * inside "Racing de Lens". Ambiguous parts — "Sporting" inside both
   * "Sporting Lisbon" and "Sporting Clube de Portugal" — stay their own row.
   */
  const tokensOfKey = new Map();
  for (const v of out.values()) {
    const t = new Set(nameTokens(v.canonical.replace(/_/g, ' ')));
    const have = tokensOfKey.get(v.key);
    if (!have || t.size > have.size) tokensOfKey.set(v.key, t);
  }
  const remap = new Map();
  for (const [k, t] of tokensOfKey) {
    if (!t.size) continue;
    const supers = [...tokensOfKey.entries()].filter(([k2, t2]) => k2 !== k && t2.size > t.size && [...t].every((w) => t2.has(w)));
    if (supers.length === 1) remap.set(k, supers[0][0]);
  }
  if (remap.size) {
    const canonicalByKey = new Map();
    for (const v of out.values()) if (!canonicalByKey.has(v.key) || v.canonical.length > canonicalByKey.get(v.key).length) canonicalByKey.set(v.key, v.canonical);
    for (const v of out.values()) {
      let k = v.key;
      for (let i = 0; i < 3 && remap.has(k); i++) k = remap.get(k);
      if (k !== v.key) { v.key = k; v.canonical = canonicalByKey.get(k) ?? v.canonical; }
    }
  }
  return out;
}
