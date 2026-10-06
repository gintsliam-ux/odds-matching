// Competitor logos for the Odds Library.
//
// Two jobs, split by how a sport is contested:
//
//   • Team sports get a crest, resolved from Wikipedia the same way
//     resolve-tournament-logos.mjs resolves competition badges.
//   • Individual sports — tennis, golf, MMA, boxing — get their COUNTRY, and
//     the flag is the logo. A headshot dates, is often missing, and tells you
//     nothing at a glance; a flag is the thing a person actually reads off a
//     player row. The country comes from Wikidata rather than the article text
//     because "country for sport" (P1532) is an explicit claim there, and it is
//     the right one: it is what a player competes under, which is not always
//     citizenship.
//
// Both write `entities` in Mongo `gutsys_sport`, keyed (sport, name) — the
// same collection and the same unique index the competition resolver uses.
// live-fixtures has its own resolver on its own Supabase table; this one feeds
// the Odds Library alone. See scripts/lib/entities.mjs.
//
// Usage:  node scripts/resolve-entity-logos.mjs                  everything missing
//         node scripts/resolve-entity-logos.mjs tennis golf       only these sports
//         node scripts/resolve-entity-logos.mjs --limit 50        stop after 50 lookups
//         node scripts/resolve-entity-logos.mjs --retry-null      re-try recorded misses
//         node scripts/resolve-entity-logos.mjs --dry-run          report, write nothing

import {
  allEntities, assertWritable, close, competitorNames, golferNames, isDryRun,
  setDryRun, upsertEntities,
} from './lib/entities.mjs';

const UA = 'odds-library-entity-logos/1.0 (team crests and player flags; contact: gintsliam@gmail.com)';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const optNum = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : Number(argv[i + 1]); };
const LIMIT = optNum('--limit', Infinity);
const RETRY_NULL = flag('--retry-null');
setDryRun(flag('--dry-run'));

/* A team sport's competitors are clubs; an individual sport's are people, and
   the two want completely different things resolved. */
const TEAM_SPORTS = {
  soccer: 'football club', basketball: 'basketball team', baseball: 'baseball team',
  icehockey: 'ice hockey team', amfootball: 'american football team', cricket: 'cricket team',
  aussierules: 'australian rules football club', rugbyleague: 'rugby league club',
  rugbyunion: 'rugby union club', volleyball: 'volleyball team', esports: 'esports team',
};
const PLAYER_SPORTS = {
  tennis: 'tennis player', golf: 'golfer',
  mma: 'mixed martial artist', boxing: 'boxer',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = argv.filter((a) => !a.startsWith('--') && (TEAM_SPORTS[a] || PLAYER_SPORTS[a]));

/* ------------------------------------------------------------------ wikipedia */
async function wiki(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (a + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(500 * (a + 1)); }
  }
  return undefined;                       // request failed — do not cache as a miss
}

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokens = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2));

/* A search result is only usable when it is actually about the thing asked for.
   Without this, "Sydney FC" happily returns the article on Sydney. */
function relevant(name, title) {
  const a = tokens(name), b = tokens(title);
  if (!a.size) return false;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size >= 0.5;
}

/* Match on the FILE NAME, never the whole URL: every Wikimedia thumb is served
   from upload.wikimedia.org, so testing the URL rejects literally every image. */
const REJECT = /(flag|map|location|stadium|estadio|stadion|stadio|stade|arena|ground|panorama|aerial|skyline|commons-logo|question|edit-)/i;
const fileNameOf = (url) => {
  try { return decodeURIComponent(String(url).split('?')[0].split('/').pop() || ''); }
  catch { return String(url); }
};
/* What a crest is, and what it is not.
   
   The filename saying "logo" / "crest" / "escudo" OVERRIDES everything else,
   because a club's own name routinely contains the words a place list bans:
   Crystal Palace, Newcastle Knights, Stade Toulousain, University College
   Dublin, Victoriano Arenas. Matching those on the whole filename condemned
   125 perfectly good crests.

   After that override the decisive rule is the picture's own shape: a .jpg
   whose name does not say logo is a photograph — of a town square, a
   cathedral, or the wrong person entirely. "Dijon" took a photo of the Puits
   de Moise and "Limoges" the town centre this way.

   Nothing beats a wrong mark: initials assert nothing false. */
const LOGO_WORD = /logo|crest|badge|escudo|emblem|shield|scudetto|logotipo|wappen|stemma/i;
/* Only shapes that never appear in a club's own name. `stade`, `arena`,
   `palace`, `castle`, `university` and `square` are deliberately absent. */
const NOT_A_CREST =
  /flag_of|coat_of_arms|map_of|locator|seal_of|orthographic|_map[._]|town[_ ]hall|city[_ ]hall|rathaus|ayuntamiento|centre-ville|skyline|_cbd|aerial|panorama|montage|nightlife|_views?[._]|stadium|estadio|est[aá]dio|stadion/i;
const fileOf = (url) => {
  try { return decodeURIComponent(String(url).split('?')[0].split('/').pop() || ''); }
  catch { return String(url); }
};
const badImage = (url) => {
  const f = fileOf(url);
  if (LOGO_WORD.test(f)) return false;
  return NOT_A_CREST.test(f) || /\.jpe?g$/i.test(f);
};
const rejected = (url) => badImage(url);
function normaliseThumb(url) {
  if (!url) return url;
  return url.replace(/\?utm_[^]*$/, '').replace(/\/(\d{1,3})px-/, (m, w) => (Number(w) < 160 ? '/160px-' : m));
}

/** url | null (looked, nothing) | undefined (request failed) */
async function teamLogo(name, hint) {
  const q = encodeURIComponent(`${name} ${hint}`);
  /* `pilicense=any` is load-bearing. A club crest is a non-free file and
     pageimages omits those by default, so without it every single team comes
     back with no image — 3,300 lookups found nothing before this was added. */
  const d = await wiki(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${q}&gsrlimit=4&redirects=1&pilicense=any` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=320`);
  if (d === undefined) return undefined;
  const pages = d?.query?.pages;
  if (!pages) return null;
  const ranked = Object.values(pages)
    .filter((p) => relevant(name, p.title || ''))
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  for (const p of ranked) {
    const thumb = p?.thumbnail?.source;
    if (thumb && !rejected(thumb)) return normaliseThumb(thumb);
  }
  return null;
}

/* ------------------------------------------------------------------- wikidata */
const isoCache = new Map();
async function isoOf(countryQid) {
  if (isoCache.has(countryQid)) return isoCache.get(countryQid);
  const d = await wiki(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&origin=*` +
    `&entity=${countryQid}&property=P297`);
  if (d === undefined) return undefined;
  const iso = d?.claims?.P297?.[0]?.mainsnak?.datavalue?.value || null;
  isoCache.set(countryQid, iso);
  return iso;
}

/** { iso, name } | null | undefined */
async function playerCountry(name, hint) {
  const q = encodeURIComponent(`${name} ${hint}`);
  const s = await wiki(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${q}&gsrlimit=3&redirects=1&prop=pageprops&ppprop=wikibase_item`);
  if (s === undefined) return undefined;
  const pages = Object.values(s?.query?.pages || {})
    .filter((p) => relevant(name, p.title || ''))
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  for (const p of pages) {
    const qid = p?.pageprops?.wikibase_item;
    if (!qid) continue;
    const d = await wiki(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&origin=*` +
      `&entity=${qid}`);
    if (d === undefined) return undefined;
    // P1532 is "country for sport" — what they compete under. Fall back to
    // citizenship, which is usually but not always the same.
    const claim = d?.claims?.P1532?.[0] || d?.claims?.P27?.[0];
    const cq = claim?.mainsnak?.datavalue?.value?.id;
    if (!cq) continue;
    const iso = await isoOf(cq);
    if (iso === undefined) return undefined;
    if (iso) return { iso, title: p.title };
  }
  return null;
}

const flagUrl = (iso) => `https://flagcdn.com/w160/${iso.toLowerCase()}.png`;

/* A national team IS its country, so the flag is the right badge — Honduras v
   Jamaica had no crest for either side and rendered as two sets of initials.
   The map comes from ICU rather than a hand-written list, plus the spellings
   the feeds actually use and the home nations, which flagcdn serves as
   gb-eng / gb-sct / gb-wls / gb-nir. */
const COUNTRY_CODE = (() => {
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const m = new Map();
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of A) for (const b of A) {
    const code = a + b;
    let name;
    try { name = dn.of(code); } catch { continue; }
    if (!name || name === code) continue;
    m.set(name.toLowerCase(), code.toLowerCase());
  }
  for (const [alias, code] of Object.entries({
    usa: 'us', 'united states of america': 'us', 'south korea': 'kr', 'north korea': 'kp',
    'republic of ireland': 'ie', ireland: 'ie', 'czech republic': 'cz', czechia: 'cz',
    'ivory coast': 'ci', 'cape verde': 'cv', 'east timor': 'tl', swaziland: 'sz',
    'bosnia and herzegovina': 'ba', bosnia: 'ba', macedonia: 'mk', 'north macedonia': 'mk',
    england: 'gb-eng', scotland: 'gb-sct', wales: 'gb-wls', 'northern ireland': 'gb-nir',
    uae: 'ae', 'united arab emirates': 'ae', russia: 'ru', iran: 'ir', syria: 'sy',
    tanzania: 'tz', laos: 'la', moldova: 'md', brunei: 'bn', palestine: 'ps',
    'hong kong': 'hk', 'chinese taipei': 'tw', taiwan: 'tw', curacao: 'cw',
    kosovo: 'xk', turkiye: 'tr', turkey: 'tr',
  })) m.set(alias, code);
  return m;
})();

/* Whole-name match only. "Club America" is a Mexico City club, not Mexico. */
const countryOfTeamName = (name) => COUNTRY_CODE.get(String(name || '').trim().toLowerCase()) ?? null;


/* ----------------------------------------------------------------------- run */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function competitorsOf(sport) {
  // Golf fixtures carry no competitors — the field lives in the outright market.
  return sport === 'golf' ? golferNames() : competitorNames(sport);
}

async function main() {
  await assertWritable();
  if (isDryRun()) console.log('DRY RUN — reads only, nothing is written\n');

  const sports = only.length ? only : [...Object.keys(TEAM_SPORTS), ...Object.keys(PLAYER_SPORTS)];
  const cached = new Map();                       // `${sport} ${name}` -> row
  for (const e of await allEntities()) {
    cached.set(`${e.sport} ${e.name}`, e);
  }
  console.log(`entities on file: ${cached.size}`);

  /* Players already on file often carry a Wikipedia headshot. Those go: a photo
     dates, is missing for most of the field, and reads as noise at row height,
     where a flag is legible. Anything with a country becomes a flag; a photo
     with no country becomes nothing rather than staying a stale headshot. */
  const swept = [];
  for (const e of cached.values()) {
    /* Read the sport off the row, never off the map key — the key joins sport
       and name with a separator, and player names contain spaces, so parsing it
       yields "tennis<sep>Lars" and every player silently fails the lookup. */
    const sport = e.sport;
    if (!PLAYER_SPORTS[sport] || (only.length && !only.includes(sport))) continue;
    const want = e.country ? flagUrl(e.country) : null;
    if (e.logo_url === want) continue;
    swept.push({ sport, name: e.name, entity_type: 'player', country: e.country,
                 logo_url: want, country_src: e.country ? 'wikidata' : null,
                 source: want ? 'flagcdn' : null });
  }
  if (swept.length) {
    console.log(`\nreplacing ${swept.length} player photos with flags…`);
    let swum = { inserted: 0, updated: 0, merged: 0 };
    for (let i = 0; i < swept.length; i += 40) {
      const r = await upsertEntities(swept.slice(i, i + 40));
      swum = { inserted: swum.inserted + r.inserted, updated: swum.updated + r.updated,
               merged: swum.merged + r.merged };
    }
    console.log(`  done — ${swum.updated} updated, ${swum.inserted} new, ${swum.merged} merged into an existing key`);
  }

  /* National teams: give them their flag. Only where there is no crest to
     override, and only on an exact whole-name match. upsertEntities fills a
     null country and never replaces one, so a real badge found later wins. */
  const flags = [];
  for (const e of cached.values()) {
    if (!TEAM_SPORTS[e.sport] || (only.length && !only.includes(e.sport))) continue;
    if (e.logo_url || e.country) continue;
    const iso = countryOfTeamName(e.name);
    if (iso) flags.push({ sport: e.sport, name: e.name, entity_type: 'team', country: iso,
                          country_src: 'name-is-country' });
  }
  if (flags.length) {
    console.log(`\nflagging ${flags.length} national teams…`);
    let n = { inserted: 0, updated: 0, merged: 0 };
    for (let i = 0; i < flags.length; i += 40) {
      const r = await upsertEntities(flags.slice(i, i + 40));
      n = { inserted: n.inserted + r.inserted, updated: n.updated + r.updated, merged: n.merged + r.merged };
    }
    console.log(`  done — ${n.updated} updated, ${n.inserted} new`);
  }

  const todo = [];
  for (const sport of sports) {
    const isPlayer = !!PLAYER_SPORTS[sport];
    const hint = PLAYER_SPORTS[sport] || TEAM_SPORTS[sport];
    const names = await competitorsOf(sport);
    const want = names.filter((name) => {
      const e = cached.get(`${sport} ${name}`);
      if (!e) return true;
      const done = isPlayer ? !!e.country : !!e.logo_url;
      if (done) return false;
      return RETRY_NULL;                          // recorded miss: only on demand
    });
    console.log(`  ${sport.padEnd(12)} ${String(names.length).padStart(5)} competitors, ${String(want.length).padStart(5)} to resolve`);
    for (const name of want) todo.push({ sport, name, hint, isPlayer });
  }
  if (!todo.length) { console.log('nothing to do'); return; }

  const work = todo.slice(0, LIMIT);
  console.log(`\nresolving ${work.length}${work.length < todo.length ? ` of ${todo.length}` : ''}…`);

  let done = 0, hit = 0, miss = 0, failed = 0;
  const batch = [];
  await pool(work, 3, async (item) => {
    const got = item.isPlayer
      ? await playerCountry(item.name, item.hint)
      : await teamLogo(item.name, item.hint);
    done++;
    if (got === undefined) { failed++; return; }   // never cache a request failure
    if (got) hit++; else miss++;

    /* Every row carries the same keys whether it is a player or a team. Mongo
       would not mind a ragged batch, but a team row that simply omitted
       `country` would leave a stale value behind when a name is re-resolved,
       so absent is written as null rather than left out. */
    batch.push(item.isPlayer
      ? { sport: item.sport, name: item.name, entity_type: 'player',
          country: got ? got.iso : null, logo_url: got ? flagUrl(got.iso) : null,
          country_src: got ? 'wikidata' : null, source: got ? 'flagcdn' : null }
      : { sport: item.sport, name: item.name, entity_type: 'team',
          country: null, logo_url: got || null,
          country_src: null, source: got ? 'wikipedia' : null });

    if (batch.length >= 40) await upsertEntities(batch.splice(0, batch.length));
    if (done % 100 === 0) {
      console.log(`  ${done}/${work.length}  found ${hit}, none ${miss}, failed ${failed}`);
    }
  });
  await upsertEntities(batch);
  console.log(`\ndone: ${done} — ${hit} resolved, ${miss} nothing found, ${failed} request failures`);
}

main()
  .catch((e) => { console.error(e.message || e); process.exitCode = 1; })
  .finally(close);
