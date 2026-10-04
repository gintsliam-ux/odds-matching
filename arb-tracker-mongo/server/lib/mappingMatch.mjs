/**
 * Matching competition names across three feeds that each spell them
 * differently.
 *
 *   optic      baseball / Japan / NPB
 *   swiftbet   Nippon Professional Baseball
 *   mybet      Japanese NPB   (league: NPB League)
 *
 * Nothing here talks to a database — it is pure scoring, so the thresholds can
 * be reasoned about and changed without touching the queries.
 */

/** Sport vocabularies differ per feed; these all mean the same thing. */
const SPORT_SYNONYMS = [
  ['soccer', 'football', 'association football'],
  ['amfootball', 'american football', 'gridiron', 'ncaa football'],
  ['aussierules', 'australian rules', 'australian football', 'afl'],
  ['rugbyleague', 'rugby league'],
  ['rugbyunion', 'rugby union', 'rugby'],
  ['icehockey', 'ice hockey', 'hockey'],
  ['mma', 'mixed martial arts', 'ufc'],
  ['basketball'],
  ['baseball'],
  ['tennis'],
  ['cricket'],
  ['golf'],
  ['darts'],
  ['boxing'],
  ['snooker'],
  ['volleyball'],
  ['handball'],
  ['esports', 'e sports'],
  ['motorsport', 'motor racing'],
  ['table_tennis', 'table tennis'],
];

/** Nationality adjective -> the country it implies, so "Japanese" ~ "Japan". */
const DEMONYMS = {
  japanese: 'japan', korean: 'korea', american: 'usa', english: 'england',
  australian: 'australia', mexican: 'mexico', spanish: 'spain', italian: 'italy',
  german: 'germany', french: 'france', dutch: 'netherlands', portuguese: 'portugal',
  brazilian: 'brazil', argentine: 'argentina', argentinian: 'argentina',
  chinese: 'china', indian: 'india', scottish: 'scotland', welsh: 'wales',
  irish: 'ireland', turkish: 'turkey', greek: 'greece', swedish: 'sweden',
  norwegian: 'norway', danish: 'denmark', finnish: 'finland', polish: 'poland',
  russian: 'russia', belgian: 'belgium', swiss: 'switzerland', austrian: 'austria',
  czech: 'czechia', croatian: 'croatia', serbian: 'serbia', romanian: 'romania',
  bulgarian: 'bulgaria', ukrainian: 'ukraine', canadian: 'canada',
  chilean: 'chile', colombian: 'colombia', peruvian: 'peru', uruguayan: 'uruguay',
  ecuadorian: 'ecuador', paraguayan: 'paraguay', bolivian: 'bolivia',
  nz: 'new zealand', kiwi: 'new zealand', qatari: 'qatar', saudi: 'saudi',
  emirati: 'uae', israeli: 'israel', egyptian: 'egypt', estonian: 'estonia',
  latvian: 'latvia', lithuanian: 'lithuania', slovak: 'slovakia',
  slovenian: 'slovenia', hungarian: 'hungary', moroccan: 'morocco',
  tunisian: 'tunisia', algerian: 'algeria', nigerian: 'nigeria',
  jamaican: 'jamaica', ecuadorean: 'ecuador', taiwanese: 'taiwan',
  thai: 'thailand', vietnamese: 'vietnam', indonesian: 'indonesia',
  filipino: 'philippines', philippine: 'philippines', icelandic: 'iceland',
  maltese: 'malta', cypriot: 'cyprus', british: 'uk', welsh: 'wales',
  scottish: 'scotland', norweigan: 'norway', brasileiro: 'brazil',
  venezuelan: 'venezuela', venezuela: 'venezuela', panamanian: 'panama',
  honduran: 'honduras', guatemalan: 'guatemala', salvadoran: 'el salvador',
  nicaraguan: 'nicaragua', dominican: 'dominican republic', cuban: 'cuba',
  puerto: 'puerto rico', haitian: 'haiti', trinidadian: 'trinidad',
};

/**
 * Words that carry no distinguishing information in a competition name. Note
 * what is NOT here: "cup", "women", "youth", "qualification", "preseason" and
 * the like all change which competition is meant, so they must survive.
 */
const FILLER = new Set([
  'the', 'of', 'and', 'a', 'an', 'league', 'professional', 'competition',
  'organization', 'organisation', 'association', 'club', 'clubs', 'tour',
]);

/** Distinguishing words — two names disagreeing on one of these are NOT a pair. */
const DISCRIMINATORS = new Set([
  'women', 'womens', 'ladies', 'w', 'youth', 'junior', 'juniors', 'u19', 'u20',
  'u21', 'u23', 'reserves', 'amateur', 'preseason', 'qualification',
  'qualifying', 'friendlies', 'friendly', 'cup', 'playoffs', 'challenger',
  'second', 'division2', 'b',
]);

/**
 * Words that name a sport or a generic container. A competition name made of
 * nothing else identifies no particular competition: mybet's `league` field is
 * often just "Basketball League" or "Cup", which would otherwise match every
 * basketball league and every cup in the world.
 */
const GENERIC = new Set([
  'basketball', 'football', 'baseball', 'soccer', 'hockey', 'cricket', 'tennis',
  'golf', 'rugby', 'darts', 'boxing', 'snooker', 'volleyball', 'handball',
  'mma', 'esports', 'motorsport', 'cup', 'division', 'tournament',
  'championship', 'championships', 'series', 'trophy', 'match', 'matches',
  'games', 'test', 'tests', 'friendlies', 'friendly', 'international',
  'open', 'classic', 'masters',
]);

const strip = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Tokens of a name, with demonyms folded to countries and filler dropped. */
export function tokens(name) {
  return strip(name)
    .split(' ')
    .filter(Boolean)
    .map((t) => DEMONYMS[t] ?? t)
    .flatMap((t) => t.split(' '))
    .filter((t) => !FILLER.has(t));
}

/** Canonical sport key, or the stripped name when we don't know it. */
export function sportKey(name) {
  const s = strip(name).replace(/\s+/g, ' ');
  for (const group of SPORT_SYNONYMS) {
    if (group.some((g) => g === s || g.replace(/[^a-z]/g, '') === s.replace(/[^a-z]/g, ''))) {
      return group[0];
    }
  }
  return s.replace(/\s+/g, '_');
}

/** Do two sport labels refer to the same sport? Unknown on either side = yes. */
export function sportsAgree(a, b) {
  if (!a || !b) return true;
  return sportKey(a) === sportKey(b);
}

/**
 * Every word of a name, normalised but NOT filtered.
 *
 * Abbreviations must be tested against these rather than against `tokens()`,
 * because the filler words are precisely the ones the acronym is built from:
 * strip "league" from Major League Baseball and MLB stops matching it.
 */
function rawTokens(name) {
  return strip(name).split(' ').filter(Boolean);
}

/** Country words, for spotting a leading qualifier that an acronym ignores. */
const COUNTRY_WORDS = new Set([
  ...Object.keys(DEMONYMS),
  ...Object.values(DEMONYMS).flatMap((v) => v.split(' ')),
  // Countries that appear in these feeds without a demonym form in the table.
  'egypt', 'estonia', 'croatia', 'slovakia', 'slovenia', 'hungary', 'morocco',
  'jamaica', 'jamaican', 'bolivia', 'bolivian', 'ecuador', 'ecuadorean',
  'ecuadorian', 'costa', 'rica', 'israel', 'israeli', 'egyptian', 'estonian',
  'moroccan', 'norweigan', 'iceland', 'icelandic', 'cyprus', 'malta', 'qatar',
  'saudi', 'iran', 'iraq', 'egypt', 'tunisia', 'algeria', 'nigeria', 'ghana',
  'kenya', 'uganda', 'zambia', 'thailand', 'vietnam', 'malaysia', 'singapore',
  'indonesia', 'philippines', 'philippine', 'taiwan', 'taiwanese', 'shanghai',
  'lithuania', 'latvia', 'estonia', 'georgia', 'armenia', 'azerbaijan',
  'kazakhstan', 'uzbekistan', 'belarus', 'moldova', 'albania', 'macedonia',
  'montenegro', 'bosnia', 'kosovo', 'scotland', 'scottish', 'wales', 'welsh',
]);

/** The country words a name carries, folded through the demonym table. */
function countryTokens(name) {
  const out = new Set();
  for (const raw of strip(name).split(' ')) {
    if (!raw) continue;
    const folded = DEMONYMS[raw] ?? raw;
    for (const part of folded.split(' ')) {
      if (COUNTRY_WORDS.has(part) || COUNTRY_WORDS.has(raw)) out.add(part);
    }
  }
  return out;
}

/**
 * Do two names disagree about which country they belong to?
 *
 * This is the single most valuable gate in the matcher. Competition names are
 * routinely reused across countries — Serie A is Italian, Brazilian AND
 * Ecuadorean; Primera Division belongs to half of South America; there is an
 * English FA Cup and a Chinese one. Matching on the name alone maps all of them
 * onto whichever the feed happens to list first. When both sides name a country
 * and the countries differ, it is not a match however well the words line up.
 */
export function countriesConflict(aName, bName) {
  const a = countryTokens(aName);
  const b = countryTokens(bName);
  if (!a.size || !b.size) return false;
  for (const t of a) if (b.has(t)) return false;
  return true;
}

/** Sport nouns that identify a sport, for catching a cross-sport match. */
const SPORT_NOUNS = new Map([
  ['basketball', 'basketball'], ['baseball', 'baseball'], ['football', null],
  ['soccer', 'soccer'], ['hockey', 'icehockey'], ['cricket', 'cricket'],
  ['tennis', 'tennis'], ['golf', 'golf'], ['rugby', 'rugbyunion'],
  ['darts', 'darts'], ['boxing', 'boxing'], ['snooker', 'snooker'],
  ['volleyball', 'volleyball'], ['handball', 'handball'],
  ['basket', 'basketball'], ['beisbol', 'baseball'], ['futsal', 'futsal'],
]);

/**
 * Does a name name a sport other than `sport`? Used where the feed gives us no
 * sport field of its own — mybet's league list has none, which is how Hungary's
 * NB I (soccer) came to match a "Basketball League". "Football" is deliberately
 * ambiguous (soccer or gridiron depending on the feed) and never conflicts.
 */
export function sportNameConflicts(sport, name) {
  if (!sport) return false;
  const mine = sportKey(sport);
  for (const t of strip(name).split(' ')) {
    const noun = SPORT_NOUNS.get(t);
    if (noun && noun !== mine) return true;
  }
  return false;
}

/**
 * The word lists an abbreviation may be tested against: the name as written,
 * and the name with a leading country word removed. "American NCAA Football"
 * is NCAAF, but only once "American" is set aside — the acronym names the
 * competition, not the country it is in. Only a *leading country* is dropped,
 * so this cannot turn MLB into Mexican Baseball League.
 */
function abbrevTargets(raw) {
  const out = [raw];
  if (raw.length > 2 && COUNTRY_WORDS.has(raw[0])) out.push(raw.slice(1));
  return out;
}

/**
 * Can `abbr` be read as an abbreviation of `words`?
 *
 *   npb   <- nippon professional baseball     (n + p + b)
 *   mlb   <- major league baseball            (m + l + b)
 *   ncaaf <- ncaa football                    (ncaa + f)
 *
 * Every word must contribute, and each contributes either its initial or the
 * whole of itself — nothing in between. That second rule is what separates a
 * real acronym from a coincidence: without it "NBA" reads as N(caa) + BA(seball)
 * and NCAA Baseball maps onto the National Basketball Association.
 */
// An acronym is short. Without a bound the walk below happily "abbreviates"
// basketball as Basketball + League by taking nine characters from the first.
const MAX_ABBR_LEN = 6;

function isAbbreviationOf(abbr, words) {
  if (abbr.length < 2 || abbr.length > MAX_ABBR_LEN || words.length < 2) return false;
  const walk = (i, w) => {
    if (w === words.length) return i === abbr.length;
    // Each remaining word still needs at least one character.
    const budget = abbr.length - (words.length - w - 1);
    for (let take = 1; i + take <= budget; take++) {
      const piece = abbr.slice(i, i + take);
      if (!words[w].startsWith(piece)) break;
      // Initial, or the entire word. Never a partial bite out of the middle.
      if ((take === 1 || piece === words[w]) && walk(i + take, w + 1)) return true;
    }
    return false;
  };
  return walk(0, 0);
}

/** Dice coefficient over token sets — forgiving about word order and extras. */
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Score how likely two competition names are the same competition, 0..1.
 *
 * The ladder matters more than the exact numbers: an exact normalised match
 * beats an acronym expansion, which beats token overlap. A disagreement on a
 * discriminating word (women's, youth, qualification) is disqualifying however
 * well the rest of the name matches — "Premier League" and "Premier League
 * Women" are different competitions, not a 0.9 match.
 */
export function scoreNames(aName, bName) {
  const a = tokens(aName);
  const b = tokens(bName);
  if (!a.length || !b.length) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  for (const d of DISCRIMINATORS) {
    if (setA.has(d) !== setB.has(d)) return 0;
  }

  const joinedA = a.join('');
  const joinedB = b.join('');
  if (joinedA === joinedB) return 1;

  // One side written as an acronym of the other: NPB / Nippon Professional
  // Baseball, MLB / Major League Baseball, NCAAF / NCAA Football.
  const rawA = rawTokens(aName);
  const rawB = rawTokens(bName);
  const hitsA = abbrevTargets(rawA);
  const hitsB = abbrevTargets(rawB);
  if (hitsB.some((w) => isAbbreviationOf(joinedA, w)) || hitsA.some((w) => isAbbreviationOf(joinedB, w))) {
    return 0.92;
  }
  // The acronym may sit beside other words: "Japanese NPB" against "Nippon
  // Professional Baseball".
  if (a.some((t) => hitsB.some((w) => isAbbreviationOf(t, w)))) return 0.88;
  if (b.some((t) => hitsA.some((w) => isAbbreviationOf(t, w)))) return 0.88;

  // A name of nothing but sport and container words ("Basketball League",
  // "Cup") picks out no competition, so beyond an exact or acronym match it can
  // only mislead. Checked here rather than earlier precisely because those two
  // are still trustworthy: NBA genuinely is the National Basketball
  // Association, however generic its words look.
  const generic = (t) => t.every((w) => GENERIC.has(w));
  if (generic(a) || generic(b)) return 0;

  const d = dice(setA, setB);
  // One name fully containing the other is stronger than Dice alone suggests —
  // but only when the shorter side says something specific. "NBA" sits inside
  // "NBA All Star" without being it.
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = smaller === setA ? setB : setA;
  const contained = [...smaller].every((t) => larger.has(t));
  const specificEnough = [...smaller].filter((t) => !GENERIC.has(t)).length >= 1 && smaller.size >= 1;
  return contained && specificEnough ? Math.max(d, 0.8) : d;
}

/**
 * Best candidate for an optic league among a provider's competitions.
 *
 * `optic` is { sport, category, tournament }; each candidate is
 * { id, sport, name }. The category (country / tour) is a tiebreaker rather
 * than a requirement — plenty of feeds fold it into the name instead.
 */
export function bestMatch(optic, candidates) {
  const scored = [];
  for (const c of candidates) {
    if (!sportsAgree(optic.sport, c.sport)) continue;

    const names = [c.name, c.alt].filter(Boolean);
    // Where the feed carries no sport of its own, the name has to answer for
    // it — otherwise a soccer league matches a "Basketball League".
    if (!c.sport && sportNameConflicts(optic.sport, names.join(' '))) continue;

    // Compare the tournament alone and with its category prefixed, and keep
    // whichever reads better: "NPB" scores nothing against "Japanese NPB",
    // but "Japan NPB" scores well.
    //
    // `alt` is the provider's other spelling — mybet stores a bare `league`
    // ("KBO League") beside a qualified `description` ("Korean KBO League"),
    // and which one identifies the competition varies by row, so both count.
    const qualified = optic.category ? `${optic.category} ${optic.tournament}` : null;
    const mine = `${optic.category ?? ''} ${optic.tournament ?? ''}`;

    // The country belongs to the candidate, not to one spelling of it. mybet
    // stores a bare `league` beside a qualified `description` — "Super League"
    // and "Swiss Super League" are the same row, so reading them separately
    // lets the unqualified half match a Chinese league the other half rules
    // out. Serie A is Italian, Brazilian AND Ecuadorean; there is an English
    // FA Cup and a Chinese one. A stated disagreement settles it.
    if (countriesConflict(mine, names.join(' '))) continue;

    let score = 0;
    for (const n of names) {
      score = Math.max(score, scoreNames(optic.tournament, n));
      if (qualified) score = Math.max(score, scoreNames(qualified, n));
    }
    if (score === 0) continue;

    // A stated, agreeing country is corroboration.
    if (names.some((n) => {
      const shared = countryTokens(n);
      return shared.size && [...countryTokens(mine)].some((t) => shared.has(t));
    })) {
      score = Math.min(1, score + 0.04);
    }
    scored.push({ ...c, score: Number(score.toFixed(3)) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored;
}

/**
 * Demote any auto-tier match that two different optic leagues both claim.
 *
 * "Serie A" with no country attached is an equally perfect match for Italy,
 * Brazil and Ecuador — at most one can be right, and the matcher has no way to
 * tell which, so none of them should be applied unattended.
 */
export function demoteCollisions(rows) {
  const claims = new Map();
  for (const r of rows) {
    const id = r.suggestion?.id;
    if (id && r.suggestion.score >= AUTO_THRESHOLD) {
      claims.set(id, (claims.get(id) ?? 0) + 1);
    }
  }
  for (const r of rows) {
    const id = r.suggestion?.id;
    if (id && claims.get(id) > 1) {
      r.suggestion.contested = true;
      r.suggestion.contestedWith = claims.get(id) - 1;
    }
  }
  return rows;
}

/** Normalised team name, for comparing squads across feeds. */
export function teamKey(name) {
  const t = strip(name)
    .split(' ')
    .filter((w) => w && !['fc', 'sc', 'cf', 'ac', 'afc', 'cd', 'ca', 'club', 'de', 'the'].includes(w));
  return t.join(' ');
}

/**
 * How much two squads overlap, 0..1 of the smaller side.
 *
 * This is the signal that settles what names cannot. "Serie A" is an equally
 * perfect string match for Italy, Brazil and Ecuador — but only one of them
 * fields Juventus. Where both sides list teams, an overlap is close to proof
 * and no overlap is close to disproof, regardless of how well the names read.
 */
export function teamOverlap(a, b) {
  if (!a?.length || !b?.length) return null;
  const setA = new Set(a.map(teamKey).filter(Boolean));
  const setB = new Set(b.map(teamKey).filter(Boolean));
  if (!setA.size || !setB.size) return null;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

/** Overlap at or above this corroborates a match outright. */
export const TEAM_CONFIRM = 0.3;
/** Both sides list teams and share none — treat the name match as a mirage. */
export const TEAM_REJECT = 0;

/** At or above this a suggestion is safe to apply without a human looking. */
export const AUTO_THRESHOLD = 0.88;
/** Below this we don't bother showing it as a candidate at all. */
export const SUGGEST_THRESHOLD = 0.45;
