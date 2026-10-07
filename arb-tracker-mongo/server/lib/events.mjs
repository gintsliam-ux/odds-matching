import { coll, mirrorConfigured, mongoConfigured } from './mongo.mjs';

// Mongo `fixtures` documents -> the board's SportEvent shape. This is the same
// derivation the Supabase build did client-side; it lives on the server here so
// the browser never has to pull the 747-row competition-logo table or do a
// per-fixture entity join of its own.

const SPORT_LABEL = {
  soccer: 'Soccer',
  tennis: 'Tennis',
  baseball: 'Baseball',
  basketball: 'Basketball',
  aussierules: 'Aussie Rules',
  amfootball: 'American Football',
  rugbyleague: 'Rugby League',
  rugbyunion: 'Rugby Union',
  mma: 'MMA',
  golf: 'Golf',
  darts: 'Darts',
  boxing: 'Boxing',
  cricket: 'Cricket',
  icehockey: 'Ice Hockey',
};

/** Sports carried by the schema that we don't surface yet. */
export const SKIP_SPORTS = new Set(['esports']);

/** Competitors who are individuals: they fly a flag, never a headshot. */
const PERSON_SPORTS = new Set(['tennis', 'mma', 'boxing', 'golf', 'darts']);

const ACRONYMS = new Set([
  'usa', 'uae', 'uk', 'uefa', 'conmebol', 'efl', 'mls', 'dc', 'fc', 'afl', 'aflw',
  'nrl', 'nfl', 'ncaaf', 'mlb', 'wnba', 'ufc', 'atp', 'wta', 'liv', 'pga', 'dp',
  'nrlw', 'cfl', 'kbo', 'npb', 'cpbl', 'bsn', 'lnb', 'lnbp', 'big3',
]);
const capWord = (w) =>
  !w ? w : ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1);
const capWords = (s) => s.split('_').map(capWord).join(' ');
const sportLabel = (s) => SPORT_LABEL[s] ?? capWords(s);

/** Entity-table normalized key: lowercase, accents folded, non-alnum -> `_`. */
export function normEntity(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Does this competition belong to a women's division?
 *
 * The same test the league wordmark uses below, including the trailing-W
 * competitions where that letter is the only thing telling them apart.
 */
export function isWomensCompetition(fixture) {
  return [fixture.optic_league, fixture.tournament, fixture.category]
    .map((v) => normEntity(v ?? ''))
    .some((k) => k.includes('women') || k.includes('ladies') || /(^|_)(afl|nrl)w(_|$)/.test(k));
}

/**
 * Does this name already mark itself as the women's side?
 *
 * The vocabulary is taken from the data, not guessed: across the 934 distinct
 * team names in women's competitions, 52 carry a marker -- WFC (24), Women (9),
 * Ladies (7), Femenino (4), Feminin/Féminin (3), W.F.C. (2), Frauen, Lady --
 * and the other 882 are the bare club name.
 *
 * A bare trailing "W" is deliberately NOT one of them. No name in the data
 * uses it, and testing for it matched the last letter of every Polish club
 * ending in -ow: `\bw\b` finds a word boundary before the "w" of "Krakow"
 * because the preceding accented character is not a word character, so
 * "Wisla Krakow" and "KS Ruch Chorzow" both read as already-qualified.
 */
const SAYS_WOMENS =
  /\b(womens?|women's|ladies|lady|wfc|w\.f\.c\.?|f[eé]minin(?:es?)?|f[ee]menin[oa]|feminin[oa]|frauen|damen|dames)\b/i;

/**
 * Name a women's side so it cannot be read as the men's one.
 *
 * The feed stores them under the bare national name -- Zimbabwe's women's T20
 * side is "Zimbabwe", the same string as the men's -- and `entities` holds one
 * crest per country, so the fixture rendered with the men's name AND the men's
 * badge. The only thing marking it was the competition line underneath.
 */
const qualifyWomens = (name) =>
  !name || SAYS_WOMENS.test(name) ? name : `${name} Women`;

function localLeagueLogo(sport, cat, name) {
  const k = normEntity(name);
  const c = normEntity(cat);
  const is = (t) => k === t || c === t || k.includes(t);
  // The women's competitions are "NRLW" and "AFLW", where the trailing W is the
  // ONLY thing that distinguishes them — and `is()` matches on substring, so
  // "nrlw" satisfies is('nrl') while failing is('women'). NRLW was handed the
  // men's NRL wordmark on both counts.
  const womens = is('women') || /^(afl|nrl)w$/.test(k);
  if (sport === 'aussierules') return womens ? '/logos/leagues/aflw.png' : '/logos/leagues/afl.png';
  if (sport === 'rugbyleague' && is('nrl')) {
    // Supplied by hand. Wikipedia has no NRLW competition mark — the URL the
    // resolver had found 404'd, and the only image on the article is a
    // photograph of players, which is never a badge here.
    return womens ? '/logos/leagues/nrlw.png' : '/logos/leagues/nrl.png';
  }
  if (sport === 'baseball' && is('mlb')) return '/logos/leagues/mlb.png';
  if (sport === 'basketball' && is('wnba')) return '/logos/leagues/wnba.png';
  if (sport === 'mma' && is('ufc')) return '/logos/leagues/ufc.png';
  if (sport === 'amfootball' && is('ncaaf')) return '/logos/leagues/ncaaf.png';
  if (sport === 'amfootball' && is('nfl')) return '/logos/leagues/nfl.png';
  if (sport === 'darts' && is('modus')) return '/logos/leagues/modus.png';
  return undefined;
}

/**
 * The badge for a fixture, from `category` + `tournament` (never `optic_league`,
 * a join key that leads with the sport). `league.id` stays the sport slug so the
 * market definitions resolve; `league.name` is the competition and
 * `league.category` its group — filters key on the PAIR, since a tournament name
 * alone isn't unique (Hamburg is both an ATP and a WTA event).
 */
function deriveLeague(sport, category, tournament, stage, compLogos) {
  const id = sport;
  const label = sportLabel(sport);
  const cat = (category ?? '').trim();
  let tourn = (tournament ?? '').trim();
  // Tournaments often embed the country ("Australia - NRL") — drop the leading
  // category so the badge reads "NRL", the country carried separately.
  if (tourn && cat && tourn.toLowerCase().startsWith(`${cat.toLowerCase()} - `)) {
    tourn = tourn.slice(cat.length + 3).trim();
  }
  const name = tourn || cat || label;
  const context = cat && cat !== name ? cat : undefined;
  const compLogo = (n) => compLogos.get(normEntity(n));
  // Three letters, unless the competition IS a short acronym — truncating
  // "NRLW" to "NRL" relabels the women's competition as the men's, which is the
  // same confusion the badge lookup used to cause.
  const code = (n) => {
    const raw = (n || sport).replace(/[^A-Za-z0-9]/g, '');
    const acronym = raw.length <= 4 && raw === raw.toUpperCase();
    return (acronym ? raw : raw.slice(0, 3)).toUpperCase();
  };

  if (sport === 'tennis') {
    const TOUR_LOGO = { ATP: 'atp', WTA: 'wta', 'ATP Challenger': 'atp-challenger' };
    const slug = TOUR_LOGO[cat];
    return {
      league: {
        id, name, category: context, code: code(name), sport: label,
        logoUrl: slug ? `/logos/leagues/${slug}.png` : compLogo(name),
        wordmark: !!slug,
      },
      subtitle: stage || undefined,
    };
  }

  if (sport === 'golf') {
    const tour = cat || 'Golf';
    const t = tour.toLowerCase();
    const logoUrl = t.includes('liv')
      ? '/logos/leagues/golf-liv.png'
      : t.includes('pga')
        ? '/logos/leagues/golf-pga.png'
        : '/logos/leagues/golf.png';
    return { league: { id, name: tour, code: code(tour), sport: label, logoUrl } };
  }

  return {
    league: {
      id, name, category: context, code: code(name), sport: label,
      logoUrl:
        localLeagueLogo(sport, cat, name) ??
        compLogo(name) ??
        (context ? compLogo(`${cat} ${name}`) : undefined),
    },
    subtitle: stage || undefined,
  };
}

const FINAL = new Set(['final', 'completed', 'complete', 'ended', 'finished', 'result']);
const LIVE = new Set(['live', 'in_play', 'inplay', 'playing', 'started']);
const CANCELLED = new Set(['cancelled', 'canceled', 'postponed', 'abandoned', 'walkover']);

function mapStatus(raw) {
  const t = String(raw ?? '').toLowerCase();
  if (FINAL.has(t)) return 'final';
  if (LIVE.has(t)) return 'live';
  if (CANCELLED.has(t)) return 'cancelled';
  return 'upcoming';
}

/** Dates arrive as BSON Date; the client contract is an ISO string. */
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/**
 * `scores` comes in two shapes: the Optic feed writes
 * `{home:{total,periods},away:{…}}`, while archived fixtures carry a flat
 * `{home:1,away:1}`. Read both, and treat a flat number as a total with no
 * period breakdown.
 */
function sideScore(scores, side) {
  const s = scores?.[side];
  if (s == null) return { total: null, periods: {} };
  if (typeof s === 'number') return { total: s, periods: {} };
  return { total: s.total ?? null, periods: s.periods ?? {} };
}

function periodScoresFrom(scores) {
  const hp = sideScore(scores, 'home').periods ?? {};
  const ap = sideScore(scores, 'away').periods ?? {};
  const nums = new Set();
  for (const k of [...Object.keys(hp), ...Object.keys(ap)]) {
    const m = /period_(\d+)/.exec(k);
    if (m) nums.add(Number(m[1]));
  }
  return [...nums]
    .sort((a, b) => a - b)
    .map((n) => ({ period: n, home: hp[`period_${n}`] ?? 0, away: ap[`period_${n}`] ?? 0 }));
}

/** Only the fixture fields the board renders — keeps the wire payload small. */
export const FIXTURE_PROJECTION = {
  _id: 0,
  fixture_id: 1, sport: 1, category: 1, optic_league: 1, tournament: 1,
  tournament_stage: 1, event_name: 1, home_team: 1, away_team: 1,
  scheduled_start: 1, actual_start: 1, is_live: 1, status: 1, end_date: 1,
  current_round: 1, scores: 1, in_play_data: 1,
  // Read by keepPriceable(); not part of the SportEvent the client sees.
  has_odds: 1,
};

/* --------------------------------------------------------------- lookups */

// The competition badge table barely changes; cache it for the process rather
// than re-reading 747 rows on every board refresh.
let compLogoCache = { at: 0, map: new Map() };
const COMP_TTL_MS = 10 * 60 * 1000;

async function competitionLogos() {
  // Crests come from `entities` — the NAS copy, or its Atlas mirror on a
  // deployed instance. An empty map is already the "no badge" path, so an
  // instance with neither just gets the code badges it falls back to.
  if (!mongoConfigured && !mirrorConfigured) return new Map();
  if (Date.now() - compLogoCache.at < COMP_TTL_MS) return compLogoCache.map;
  const rows = await (await coll('entities'))
    .find({ sport: 'competition', logo_url: { $ne: null } })
    .project({ _id: 0, normalized: 1, logo_url: 1 })
    .toArray();
  const map = new Map();
  for (const r of rows) if (r.normalized && r.logo_url) map.set(r.normalized, r.logo_url);
  compLogoCache = { at: Date.now(), map };
  return map;
}

/**
 * Home/away crest + flag per fixture. Supabase had a `fixture_entities` view do
 * this join; Mongo has no views, so resolve it here.
 *
 * The obvious query — an `$or` of {sport, normalized} pairs — costs ~10s for a
 * full board, because a 500-clause `$or` stops being a single index range and
 * becomes 500 of them. Asking instead for every entity in the sports we care
 * about whose `normalized` is in the name set is one index scan and ~800ms. It
 * over-fetches slightly (a name that exists in two sports matches both), which
 * costs nothing: the result map is keyed on `sport|normalized`, so a row for the
 * wrong sport is simply never looked up.
 */
async function fixtureEntities(fixtures) {
  const out = new Map();
  // Same as competitionLogos: the NAS copy, or the Atlas mirror when deployed.
  if (!mongoConfigured && !mirrorConfigured) return out;
  const sports = new Set();
  const norms = new Set();
  for (const f of fixtures) {
    for (const name of [f.home_team, f.away_team]) {
      if (!name) continue;
      const n = normEntity(name);
      if (!n) continue;
      sports.add(f.sport);
      norms.add(n);
    }
  }
  if (norms.size === 0) return out;

  const rows = await (await coll('entities'))
    .find({ sport: { $in: [...sports] }, normalized: { $in: [...norms] } })
    .project({ _id: 0, sport: 1, normalized: 1, logo_url: 1, country: 1 })
    .toArray();

  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.sport}|${r.normalized}`, r);

  for (const f of fixtures) {
    const rec = {};
    const look = (name) => (name ? byKey.get(`${f.sport}|${normEntity(name)}`) : undefined);
    const h = look(f.home_team);
    const a = look(f.away_team);
    if (h) rec.home = { logoUrl: h.logo_url ?? null, country: h.country ?? null };
    if (a) rec.away = { logoUrl: a.logo_url ?? null, country: a.country ?? null };
    out.set(f.fixture_id, rec);
  }
  return out;
}

/* -------------------------------------------------------------- mapping */

/**
 * Some events exist under both an Optic id and a `syn_` archive id, splitting
 * their odds. Keep one per (sport, name, start), preferring the Optic id.
 */
function dedupeFixtures(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.sport}|${r.event_name}|${iso(r.scheduled_start)}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, r);
    else if (String(existing.fixture_id).startsWith('syn_') && !String(r.fixture_id).startsWith('syn_')) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

function toSportEvent(f, compLogos, entities) {
  const { league, subtitle } = deriveLeague(
    f.sport, f.category, f.tournament, f.tournament_stage, compLogos,
  );
  const ip = f.in_play_data ?? {};
  const rawPeriod = ip.period_number ?? (ip.period != null ? Number(ip.period) : null);
  const period = Number.isFinite(rawPeriod) ? rawPeriod : null;
  const ent = entities.get(f.fixture_id);
  // Outright = a field with no two sides (a golf tournament). Golf also has
  // 2-player matchups, which DO have home/away and read as a normal H2H event.
  const outright = !f.home_team && !f.away_team;

  if (outright) {
    const name = f.event_name ?? league.name;
    return {
      id: f.fixture_id,
      sport: league.sport,
      league,
      name,
      subtitle,
      home: name,
      away: '',
      startsAt: iso(f.scheduled_start),
      actualStart: iso(f.actual_start),
      isLive: !!f.is_live,
      endsAt: iso(f.end_date) ?? undefined,
      outright: true,
      round: f.current_round ?? null,
      status: mapStatus(f.status),
    };
  }

  const womens = isWomensCompetition(f);
  const home = womens ? qualifyWomens(f.home_team ?? '') : f.home_team ?? '';
  const away = womens ? qualifyWomens(f.away_team ?? '') : f.away_team ?? '';
  const person = PERSON_SPORTS.has(f.sport);
  return {
    id: f.fixture_id,
    sport: league.sport,
    league,
    // `event_name` carries the bare names too, so a women's fixture is titled
    // from the qualified ones rather than from the feed's string.
    name: womens ? `${home} vs ${away}` : f.event_name ?? `${home} vs ${away}`,
    subtitle,
    home,
    away,
    homeLogo: person ? undefined : (ent?.home?.logoUrl ?? undefined),
    awayLogo: person ? undefined : (ent?.away?.logoUrl ?? undefined),
    homeCountry: ent?.home?.country ?? null,
    awayCountry: ent?.away?.country ?? null,
    homeScore: sideScore(f.scores, 'home').total,
    awayScore: sideScore(f.scores, 'away').total,
    period,
    clock: ip.clock ?? null,
    clockStopped: ip.is_clock_stopped ?? false,
    periodScores: periodScoresFrom(f.scores),
    startsAt: iso(f.scheduled_start),
    actualStart: iso(f.actual_start),
    isLive: !!f.is_live,
    status: mapStatus(f.status),
  };
}

/** Enrich raw fixture documents into board events (dedupe, logos, flags). */
export async function toEvents(fixtures) {
  const deduped = dedupeFixtures(fixtures).filter((f) => !SKIP_SPORTS.has(f.sport));
  if (deduped.length === 0) return [];
  const [compLogos, entities] = await Promise.all([
    competitionLogos(),
    fixtureEntities(deduped),
  ]);
  return deduped.map((f) => toSportEvent(f, compLogos, entities));
}
