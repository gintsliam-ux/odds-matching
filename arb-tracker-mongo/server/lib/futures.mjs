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

/** The brands' names for a market that Optic names differently. */
const MARKET_FOLDS = [
  [/^(afc|nfc) championship( winner)?$/i, (m) => `${m[1].toUpperCase()} Conference Winner`],
  [/^(regular season )?mvp$/i, () => 'MVP Winner'],
  [/^(1st|first) round leader$/i, () => 'End Of Round 1 Leader'],
  [/^to make (the )?playoffs$/i, () => 'To Make The Playoffs'],
];
export const foldMarket = (market) => {
  const m0 = String(market ?? '').trim();
  for (const [re, to] of MARKET_FOLDS) { const m = m0.match(re); if (m) return to(m); }
  return m0;
};

/** description -> { comp, market, outright } */
function parseDescription(desc) {
  const d = String(desc ?? '').trim();
  const i = d.lastIndexOf(' - ');
  const comp = i > 0 ? d.slice(0, i).trim() : d;
  const market = foldMarket(i > 0 ? d.slice(i + 3).trim() : 'Winner');
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
/** The Optic league a brand's competition belongs to, or null: { id, name, alias }. */
function opticLeagueOf(sport, comp, optic) {
  const pool = optic.filter((f) => f.sport === sport);
  if (!pool.length) return null;
  const alias = mybetLeagueId(comp, sport);
  if (alias) {
    const hit = pool.find((f) => f.league_id === alias.id);
    if (hit) return { id: hit.league_id, name: hit.league_name, alias };
  }
  const compT = tokens(comp);
  const scored = new Map();
  for (const f of pool) {
    const lt = tokens(f.league_name);
    let hit = 0;
    for (const t of compT) if (lt.has(t)) hit++;
    if (hit) scored.set(f.league_id, Math.max(scored.get(f.league_id) ?? 0, hit / Math.max(1, compT.size)));
  }
  const best = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  if (best.length && best[0][1] >= 0.5 && (best.length === 1 || best[0][1] > best[1][1])) {
    const hit = pool.find((f) => f.league_id === best[0][0]);
    return { id: hit.league_id, name: hit.league_name, alias: null };
  }
  return null;
}

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
  const marketBare = new Set([...marketT].filter((t) => !leagueT.has(t)));
  const exact = rest.filter((f) => {
    const nt = nameT(f);
    for (const t of compOnly) nt.delete(t);
    for (const t of leagueT) nt.delete(t);
    return sameWords(marketBare, nt);
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
  attachGroups(rows, optic);
  // mybet's and Swiftbet's own row for the same market in the same
  // competition, where Optic has neither, is one future with both prices.
  const brandOnly = new Map();
  for (const r of rows) {
    if (r.source === 'optic') continue;
    const k = `${r.groupId}|${norm(r.marketLabel)}`;
    const other = brandOnly.get(k);
    if (!other) { brandOnly.set(k, r); continue; }
    if (other.source === 'mybet' && r.source === 'swiftbet' && !other.swiftId) {
      Object.assign(other, { swiftId: r.swiftId, swiftMarket: r.swiftMarket, swiftName: r.swiftName });
      r.dropped = true;
    } else if (other.source === 'swiftbet' && r.source === 'mybet' && !other.mybetId) {
      Object.assign(other, { mybetId: r.mybetId, mybetName: r.mybetName });
      r.dropped = true;
    }
  }
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].dropped) rows.splice(i, 1);
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
      market = foldMarket(market.replace(/\b(AFC|NFC) Championship Winner\b/i, '$1 Championship'));
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
    // Swiftbet states each selection's status; anything but open is shown
    // suspended at its last price.
    const open = !sel.status || /^(active|open|trading)$/i.test(String(sel.status));
    const live = Number.isFinite(price) && price > 1 && open;
    const last = ladder.length ? ladder[ladder.length - 1].p : Number.isFinite(price) && price > 1 ? price : null;
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
    // Golf is badged per tournament (a major has its own mark), the rest per league.
    const key = `${r.sport}|${r.leagueName}|${r.sport === 'golf' ? `${r.tournament ?? ''} ${r.name}` : ''}`;
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
      if (r.sport === 'golf') { category = r.leagueName; tournament = `${r.tournament ?? ''} ${r.name}`.trim(); }
      cache.set(key, leagueFor(r.sport, category, tournament).catch(() => null));
    }
    const league = await cache.get(key);
    r.league = league ?? { id: r.sport, name: r.leagueName, code: r.leagueName.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase(), sport: r.sportLabel };
  }
}

/*
 * The competition each future belongs to, and the label its market takes as
 * a tab inside it. The rail lists competitions; a competition's futures —
 * the outright, the conference and division winners, the awards, a golf
 * event's top-N finishes — are tabs across the top of the page.
 *
 *   league futures   one competition per Optic league; a brand future Optic
 *                    does not list joins its league's competition when the
 *                    league can be told from its name ("NBA Cup Winner")
 *   golf             one per tournament, across tours and brands
 *   tennis           one per slam within the tour
 */
const GOLF_TOUR_PREFIX = /^(pga|dpw|dp world|lpga|liv|european)( tour)?\s+/i;
const titleCase = (s) => String(s).replace(/\b([a-z])([a-z]*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase());
function attachGroups(rows, optic) {
  for (const r of rows) {
    let groupId; let groupName; let label = r.outright ? 'Outright' : r.name;
    if (r.sport === 'golf') {
      const event = r.source === 'optic' ? (r.tournament ?? r.leagueName) : r.leagueName.replace(GOLF_TOUR_PREFIX, '');
      const ev = [...tokens(event)].sort().join('_');
      const yr = yearOf(event) ?? '';
      groupId = `golf|${ev}|${yr}`;
      groupName = /[a-z]/.test(event) ? event : titleCase(event);
      if (!r.outright) label = r.name.replace(new RegExp(`^${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '') || r.name;
    } else if (r.sport === 'motorsport' && /grand prix/i.test(`${r.leagueName} ${r.name}`)) {
      // A race: mybet files it under the race, Swiftbet under the series with
      // the race as the event. The place before "Grand Prix" is the race.
      const text = /grand prix/i.test(r.leagueName) ? r.leagueName : r.name;
      const place = norm(text).split(/\s*grand prix/)[0].split(/[^a-z0-9]+/).filter((w) => w && !['f1', 'fia', 'formula', 'one', 'united', 'states'].includes(w)).slice(-2);
      groupId = `motorsport|gp|${place.join('_')}`;
      groupName = `F1 · ${titleCase(place.join(' '))} Grand Prix`;
      label = r.outright ? 'Race Winner' : r.name;
    } else if (r.sport === 'tennis' && /^(atp|wta)$/i.test(r.leagueName)) {
      const slam = r.name.replace(/\s*winner\s*/i, ' ').replace(/\s+/g, ' ').trim();
      groupId = `tennis|${r.leagueName.toLowerCase()}|${slam.toLowerCase()}`;
      groupName = `${r.leagueName} · ${slam}`;
      label = 'Winner';
    } else {
      let leagueId = r.source === 'optic' ? r.leagueId : null;
      let leagueName = r.leagueName;
      if (!leagueId) {
        const hit = opticLeagueOf(r.sport, r.leagueName, optic);
        if (hit) { leagueId = hit.id; leagueName = hit.name; }
      }
      groupId = leagueId ? `${r.sport}|${leagueId}` : `${r.sport}|brand|${[...tokens(r.leagueName)].join('_')}`;
      groupName = leagueId ? leagueName : r.leagueName.replace(/\b20\d{2}(\/\d{2,4})?\b/g, '').replace(/\bfutures?\b/gi, '').replace(/\s+/g, ' ').trim() || r.leagueName;
      // A brand-only future in an Optic league now reads under that league.
      if (leagueId && r.source !== 'optic') r.leagueName = leagueName;
    }
    r.groupId = groupId;
    r.groupName = groupName;
    r.marketLabel = label;
    const fam = familyOf(label);
    r.tabLabel = fam.tab;
    r.variantLabel = fam.variant;
  }
}

/*
 * Markets that are one market in several pieces share a tab, each piece a
 * variant under it: a "Yes/No" version beside the winner market, an
 * over/under pair, the eight seeds, the divisions, the conferences, the
 * top-N finishes, a golf round's leader and top-N.
 */
function familyOf(label) {
  let base = String(label ?? '').trim();
  let yn = '';
  const ynm = base.match(/^(.*?)\s+yes\/no$/i);
  if (ynm) { base = ynm[1]; yn = 'Yes/No'; }
  const v = (variant) => [variant, yn].filter(Boolean).join(' · ') || 'Main';
  let m;
  if ((m = base.match(/^(.*?)\s+(over|under)\s+([\d.]+)$/i))) return { tab: `${m[1]} ${m[3]}`, variant: v(titleCase(m[2])) };
  if ((m = base.match(/^(.*?conference)\s+#(\d+)\s+seed$/i))) return { tab: 'Conference Seed', variant: v(`${m[1].replace(/\s*conference$/i, '')} #${m[2]}`) };
  if ((m = base.match(/^(afc|nfc|eastern|western)\s+conference\s+winner$/i))) return { tab: 'Conference Winner', variant: v(titleCase(m[1]).replace(/^(Afc|Nfc)$/, (x) => x.toUpperCase())) };
  if ((m = base.match(/^(afc|nfc)\s+(east|west|north|south)\s+winner$/i))) return { tab: 'Division Winner', variant: v(`${m[1].toUpperCase()} ${titleCase(m[2])}`) };
  if ((m = base.match(/^(\w+)\s+division\s+winner$/i))) return { tab: 'Division Winner', variant: v(titleCase(m[1])) };
  if ((m = base.match(/^(east|west)\s+group\s+(\w)\s+winner$/i))) return { tab: 'Group Winner', variant: v(`${titleCase(m[1])} ${m[2].toUpperCase()}`) };
  if ((m = base.match(/^top\s+(\d+(?:-\d+)?)\s+finish(er)?$/i))) return { tab: 'Top Finish', variant: v(`Top ${m[1]}`) };
  if ((m = base.match(/^end of round\s+(\d)\s+(.*)$/i))) return { tab: `Round ${m[1]}`, variant: v(titleCase(m[2])) };
  return { tab: base, variant: yn ? 'Yes/No' : 'Main' };
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
  if (row && rows.length) {
    const names = [...new Set(rows.map((r) => r.selection).filter(Boolean))];
    // Players are merged by their words alone; only teams have crests.
    const logos = row.type === 'PLAYER' ? new Map() : await teamLogos(row.sport, names).catch(() => new Map());
    const booksOf = new Map();
    for (const r of rows) (booksOf.get(r.selection) ?? booksOf.set(r.selection, new Set()).get(r.selection)).add(r.sportsbook);
    const keyed = mergeSpellings(names, logos, booksOf);
    // A player's crest is his team's: the team Optic gives on its rows, found
    // in the same entities the board draws from. The brands' rows for him
    // carry no team but share his key, and the grid takes the crest from
    // whichever row of the merged player has one.
    let teamCrests = new Map();
    if (row.type === 'PLAYER') {
      const teams = [...new Set(rows.map((r) => r.player_team).filter(Boolean))];
      if (teams.length) teamCrests = await teamLogos(row.sport, teams).catch(() => new Map());
    }
    for (const r of rows) {
      const k = keyed.get(r.selection);
      const hit = row.type === 'PLAYER' ? teamCrests.get(r.player_team) : k ? logos.get(k.canonical) : null;
      r.selection_key = k?.key ?? null;
      r.selection_logo = hit?.logoUrl ?? null;
      r.selection_country = row.type === 'PLAYER' ? null : hit?.country ?? null;
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
const NAME_NOISE = new Set(['fc', 'afc', 'sc', 'cf', 'cd', 'ac', 'as', 'fk', 'sk', 'bk', 'hc', 'kv', 'osc', 'if', 'bv', 'the', 'club', 'spor', 'kulubu', 'kulup', 'de', 'ssc', 'us', 'rc', 'balompie', '1893', '09', '1909', '1904']);
// One spelling per word on both sides, so the native and English names meet:
// "FC Bayern München" and "Bayern Munich", "SK Slavia Praha" and "Slavia Prague".
const TOKEN_CANON = { munchen: 'munich', muenchen: 'munich', milano: 'milan', praha: 'prague', lisboa: 'lisbon', internazionale: 'inter', rasenballsport: 'rb', st: 'saint', ste: 'saint', torino: 'turin', napoli: 'naples', roma: 'rome', sevilla: 'seville', wien: 'vienna', kobenhavn: 'copenhagen', bruxelles: 'brussels' };
// Whole names the words cannot reach.
const NAME_ALIASES = { psg: 'paris saint germain', 'paris saint g': 'paris saint germain', 'sporting lisbon': 'sporting clube portugal', 'sporting cp': 'sporting clube portugal', lask: 'linzer athletik sport klub', 'lask linz': 'linzer athletik sport klub', 'man city': 'manchester city', 'man utd': 'manchester united', spurs: 'tottenham hotspur', wolves: 'wolverhampton wanderers' };
const SHORT_FORMS = { man: 'manchester', syd: 'sydney', utd: 'united', nottm: 'nottingham', souths: 'south sydney', bris: 'brisbane', sharks: 'cronulla', nth: 'north', sth: 'south', qld: 'queensland', ill: 'illawarra', nz: 'new zealand', la: 'los angeles', ny: 'new york', sf: 'san francisco' };
const nameTokens = (s) => {
  // "Victor Wembanyama (SAS)", "Erling Haaland (Man City)": the team is not the name.
  const raw = String(s ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((t) => t && !NAME_NOISE.has(t)).map((t) => TOKEN_CANON[t] ?? t);
  const phrase = raw.join(' ');
  return NAME_ALIASES[phrase] ? NAME_ALIASES[phrase].split(' ') : raw;
};
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
const wordFits = (w, cand) => cand.some((c) => c === w || (w.length >= 3 && c.startsWith(w)) || (w.length >= 6 && editOne(w, c)));
const tokenFits = (t, cand) => wordFits(t, cand) || (!!SHORT_FORMS[t] && SHORT_FORMS[t].split(' ').every((w) => wordFits(w, cand)));
// A lone initial ("S Gilgeous Alexander") fits a word it starts, as long as
// the rest of the name carries a real word that fits.
const fitsInto = (small, big) => small.length > 0 && small.length <= big.length
  && small.some((t) => t.length > 1 && tokenFits(t, big))
  && small.every((t) => (t.length === 1 ? big.some((c) => c[0] === t) : tokenFits(t, big)));

/*
 * One key per team across the books' spellings, as a union of spellings:
 *   - two spellings the entities table gives the same crest are one team;
 *   - a spelling whose words all fit inside the words of exactly one team
 *     (equal, abbreviated, a contraction, one letter off; after native and
 *     English names are folded together) joins that team — "Dortmund" into
 *     "Borussia Dortmund", "Bayern Munich" into "FC Bayern München", "Man Utd"
 *     into "Manchester United FC". Repeated until nothing moves.
 * A spelling that fits more than one team stays its own row rather than
 * being guessed onto either.
 */
function mergeSpellings(names, logos, booksOf = new Map()) {
  const parent = new Map(names.map((n) => [n, n]));
  const find = (n) => { while (parent.get(n) !== n) { parent.set(n, parent.get(parent.get(n))); n = parent.get(n); } return n; };
  // The books each group's spellings come from. A book lists a team once, so
  // two groups that share a book are two teams and are never joined: that is
  // what keeps "Ohio" from carrying "Ohio State" into "Miami Ohio".
  const groupBooks = new Map(names.map((n) => [n, new Set(booksOf.get(n) ?? [])]));
  const clash = (ra, rb) => { const a = groupBooks.get(ra); for (const b of groupBooks.get(rb)) if (a.has(b)) return true; return false; };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if (ra === rb || clash(ra, rb)) return false;
    parent.set(ra, rb);
    for (const x of groupBooks.get(ra)) groupBooks.get(rb).add(x);
    return true;
  };
  const toks = new Map(names.map((n) => [n, nameTokens(n)]));
  const byLogo = new Map();
  for (const n of names) {
    const url = logos.get(n)?.logoUrl;
    if (!url) continue;
    if (byLogo.has(url)) union(n, byLogo.get(url)); else byLogo.set(url, n);
  }
  // Same words after folding: one team.
  const byPhrase = new Map();
  for (const n of names) {
    const k = toks.get(n).join(' ');
    if (!k) continue;
    if (byPhrase.has(k)) union(n, byPhrase.get(k)); else byPhrase.set(k, n);
  }
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const n of names) {
      const mine = find(n);
      const groups = new Set();
      for (const m of names) {
        const g = find(m);
        if (g === mine) continue;
        if (fitsInto(toks.get(n), toks.get(m)) && !clash(mine, g)) groups.add(g);
      }
      if (groups.size === 1 && union(n, [...groups][0])) moved = true;
    }
    if (!moved) break;
  }
  // The group's key and its crest-bearing name.
  const members = new Map();
  for (const n of names) (members.get(find(n)) ?? members.set(find(n), []).get(find(n))).push(n);
  const out = new Map();
  for (const list of members.values()) {
    const crested = list.filter((n) => logos.get(n)?.logoUrl).sort((a, b) => b.length - a.length);
    const canonical = crested[0] ?? list.slice().sort((a, b) => b.length - a.length)[0];
    const key = nameTokens(canonical).join('_') || canonical;
    for (const n of list) out.set(n, { key, canonical });
  }
  return out;
}
