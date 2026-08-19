// Competition logos for the Odds Library sidebar.
//
// Enumerates every tournament each sport has ever run, merges the spellings the
// same way index.html does, resolves a badge for each, and caches it in
// `entity_logos` under sport='competition'. The page then reads that one table
// at load instead of touching Wikipedia at runtime.
//
// It reuses live-fixtures' entity_logos table and its Wikipedia approach —
// search, then rank candidates, then fall back to the REST summary — because
// that resolver already learned which results lie (flags, maps, town halls).
//
// Usage:  node scripts/resolve-tournament-logos.mjs
//         node scripts/resolve-tournament-logos.mjs --force        re-resolve all
//         node scripts/resolve-tournament-logos.mjs --retry-null   re-try misses
//         node scripts/resolve-tournament-logos.mjs --month-only
//              skip the all-time walk (one request per distinct label, and the
//              first thing to fall over when the database is busy) and cover
//              just what the sidebar is showing for the current month

const SB_URL = 'https://aucplqygawlpijzbfvjb.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1Y3BscXlnYXdscGlqemJmdmpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNDMxNTIsImV4cCI6MjA5MTcxOTE1Mn0.gnvr0biTrgDC1KSjxlPpktdQX1hj0kMECmDZz1WmSf0';
const REST = `${SB_URL}/rest/v1`;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// Wikimedia throttles anonymous User-Agents under load.
const WIKI_UA = 'odds-library-competition-logos/1.0 (league badge cache; contact: gintsliam@gmail.com)';

const LOGO_SPORT = 'competition';   // namespace inside entity_logos

const SPORTS = {
  soccer:      { table: 'soccer_odds',      hint: 'association football league' },
  basketball:  { table: 'basketball_odds',  hint: 'basketball league' },
  amfootball:  { table: 'amfootball_odds',  hint: 'american football league' },
  baseball:    { table: 'baseball_odds',    hint: 'baseball league' },
  icehockey:   { table: 'icehockey_odds',   hint: 'ice hockey league' },
  tennis:      { table: 'tennis_odds',      hint: 'tennis tournament' },
  cricket:     { table: 'cricket_odds',     hint: 'cricket competition' },
  aussierules: { table: 'aussierules_odds', hint: 'australian rules football league' },
  rugbyleague: { table: 'rugbyleague_odds', hint: 'rugby league competition' },
  rugbyunion:  { table: 'rugbyunion_odds',  hint: 'rugby union competition' },
  mma:         { table: 'mma_odds',         hint: 'mixed martial arts promotion' },
  boxing:      { table: 'boxing_odds',      hint: 'boxing' },
  darts:       { table: 'darts_odds',       hint: 'darts tournament' },
  esports:     { table: 'esports_odds',     hint: 'esports league' },
  volleyball:  { table: 'volleyball_odds',  hint: 'volleyball league' },
};

// Same rule as the page: a key with a handful of labels is one competition that
// was renamed; more than that and the key is a bucket holding distinct events.
const MERGE_MAX_LABELS = 3;

/* Competitions are mostly known by acronyms, and an acronym shares no words
   with the article that describes it — searching "NRL" and demanding token
   overlap threw away "National Rugby League" and settled on the Holden Cup,
   whose page merely mentions the NRL. Spelling the majors out is both more
   accurate and cheaper than trying to out-guess the search ranking. */
const ALIAS = {
  NRL: 'National Rugby League', NRLW: "NRL Women's Premiership",
  AFL: 'Australian Football League', AFLW: "AFL Women's",
  WAFL: 'West Australian Football League',
  NFL: 'National Football League', CFL: 'Canadian Football League',
  NCAAF: 'NCAA Division I Football Bowl Subdivision', UFL: 'United Football League 2024',
  'NFL Preseason': 'National Football League preseason',
  NBA: 'National Basketball Association', WNBA: "Women's National Basketball Association",
  NBL: 'National Basketball League Australia', CBA: 'Chinese Basketball Association',
  KBL: 'Korean Basketball League', BBL: 'Basketball Bundesliga',
  MLB: 'Major League Baseball', NPB: 'Nippon Professional Baseball',
  KBO: 'KBO League', CPBL: 'Chinese Professional Baseball League',
  'MLB Preseason': 'Major League Baseball spring training',
  NHL: 'National Hockey League', AHL: 'American Hockey League',
  SHL: 'Swedish Hockey League', 'NHL Preseason': 'National Hockey League preseason',
  IPL: 'Indian Premier League', WBBL: "Women's Big Bash League",
  WPL: "Women's Premier League cricket", 'Women Premier League': "Women's Premier League cricket",
  'ODI Matches': 'One Day International', 'One Day Internationals': 'One Day International',
  'T20 Internationals': 'Twenty20 International',
  'T20 Internationals Women': "Women's Twenty20 International",
  'Test Matches': 'Test cricket',
  // Competitions whose article sits under a different title than the feed's label.
  'AFC Champions League': 'AFC Champions League Elite',
  'CONCACAF Leagues Cup': 'Leagues Cup',
  'UEFA Womens Champions League': "UEFA Women's Champions League",
  'UEFA Super CUP': 'UEFA Super Cup',
  'English Premier League': 'Premier League',
  'Germany Bundesliga': 'Bundesliga', 'Bundesliga - Germany': 'Bundesliga',
  'Germany Bundesliga Women': 'Frauen-Bundesliga',
  'ATP Tour': 'ATP Tour', 'WTA Tour': 'WTA Tour',
  UFC: 'Ultimate Fighting Championship', PFL: 'Professional Fighters League',
  MMA: 'Mixed martial arts', 'Mixed Martial Arts': 'Mixed martial arts',
};

/* Labels that name a SPORT rather than a competition. There is no badge for
   "Mixed Martial Arts", so every attempt lands on whichever promotion the
   article happens to illustrate — Strikeforce, in practice. Resolve them to
   nothing and let the sidebar show the text. */
const NO_LOGO = new Set(['Mixed Martial Arts', 'MMA', 'Boxing', 'Esports', 'Volleyball']);

const REJECT = /Flag_of|Coat_of_arms|Map_of|Locator|Seal_of|_map[._]|Orthographic/i;
const REJECT_PLACE = /Town_Hall|City_Hall|Skyline|_CBD|Street|Railway_station|Post_Office|Courthouse|Library|Bridge|Beach|Aerial|Panorama|Church|Cathedral|Museum/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* ------------------------------------------------------------------ Supabase */
async function getJSON(pathAndQuery, tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(600 * i);
    try {
      const r = await fetch(`${REST}/${pathAndQuery}`, { headers: H });
      if (r.ok) return r.json();
      if (r.status < 500 && r.status !== 429) throw new Error(`API ${r.status}: ${pathAndQuery}`);
    } catch (e) {
      if (i === tries - 1) throw e;
    }
  }
  throw new Error(`API failed: ${pathAndQuery}`);
}

async function upsert(rows) {
  if (!rows.length) return;
  const r = await fetch(`${REST}/entity_logos?on_conflict=sport,name`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/* -------------------------------------------------- tournaments, as the page sees them */

// Distinct (tournament, sport_key) pairs. One request per distinct label —
// PostgREST has aggregates disabled, so there is no GROUP BY to lean on.
async function distinctPairs(table) {
  const out = [];
  let last = null;
  for (let i = 0; i < 800; i++) {
    let q = `${table}?select=tournament,sport_key&order=tournament.asc&limit=1`;
    if (last != null) q += `&tournament=gt.${encodeURIComponent(last)}`;
    const rows = await getJSON(q);
    if (!rows.length || rows[0].tournament == null) break;
    last = rows[0].tournament;
    out.push({ label: last, sportKey: rows[0].sport_key || '' });
  }
  return out;
}

const isDerived = (label, sportKey) => slugify(label) === slugify(sportKey);

function labelFromSportKey(sportKey) {
  const parts = String(sportKey || '').split('_').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(1)
    .map((w) => (w.length <= 4 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

const upperCount = (s) => (s.match(/[A-Z]/g) || []).length;

function pickLabel(labels, sportKey) {
  const real = labels.filter((l) => !l.derived);
  if (!real.length) {
    const built = labelFromSportKey(sportKey);
    if (built) return built;
  }
  return (real.length ? real : labels).slice().sort(
    (a, b) =>
      b.label.length - a.label.length ||
      upperCount(b.label) - upperCount(a.label) ||
      a.label.localeCompare(b.label),
  )[0].label;
}

/* The page builds its list from the all-time walk AND the month it is showing.
   Walking alone missed spellings the month scan has — the sidebar was showing
   "EFL Cup" while this script had only ever seen "England Efl Cup" — so scan the
   current month too and let the union decide. */
async function monthPairs(table) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const end = `${ny}-${String(nm).padStart(2, '0')}-01`;
  const filter = `date=gte.${start}&date=lt.${end}`;

  const seen = new Map();
  for (let page = 0; page < 60; page++) {
    const rows = await getJSON(
      `${table}?select=tournament,sport_key&${filter}&order=date.asc,id.asc&limit=1000&offset=${page * 1000}`);
    for (const r of rows) {
      if (!r.tournament) continue;
      seen.set(`${r.sport_key || ''}\u0000${r.tournament}`, { label: r.tournament, sportKey: r.sport_key || '' });
    }
    if (rows.length < 1000) break;
  }
  return [...seen.values()];
}

function entriesFor(pairs) {
  const byKey = new Map();
  for (const p of pairs) {
    if (!byKey.has(p.sportKey)) byKey.set(p.sportKey, new Map());
    const m = byKey.get(p.sportKey);
    if (!m.has(p.label)) m.set(p.label, { label: p.label, derived: isDerived(p.label, p.sportKey) });
  }
  const out = [];
  for (const [sportKey, labelMap] of byKey) {
    const labels = [...labelMap.values()];
    if (labels.length <= MERGE_MAX_LABELS) {
      // Resolve once for the canonical name, but record every spelling against
      // the same badge — the page may well be showing one of the others.
      out.push({ name: pickLabel(labels, sportKey), aliases: labels.map((l) => l.label) });
    } else {
      for (const l of labels) out.push({ name: l.label, aliases: [l.label] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ Wikipedia */
const STOP = new Set(['the', 'of', 'and', 'league', 'cup', 'championship', 'tournament', 'series', 'trophy', 'division']);
const tokenSet = (s) =>
  new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t)));

// An acronym is its own thing: nothing in "National Rugby League" echoes "NRL",
// so demanding overlap would reject the right page. For those, lean on the
// search ranking and the sport hint instead.
const isAcronym = (s) => /^[A-Z0-9]{2,6}$/.test(String(s).trim());

// Otherwise require some overlap, so "Big Bash League" cannot come back a bat.
function relevant(name, title) {
  if (isAcronym(name)) return true;
  const n = tokenSet(name);
  if (!n.size) return true;
  const t = tokenSet(title);
  let hit = 0;
  for (const tok of n) if (t.has(tok)) hit++;
  return hit / n.size >= 0.5;
}

/* The lead image of a league article is usually a PHOTOGRAPH — "National Rugby
   League" leads with a player mid-tackle, "UFC" with a fight poster. Those are
   what `pageimages` returns, which is why the first pass produced a picture of
   Matt King where the NRL badge belongs.

   So go after the file the article actually carries: list its images, keep the
   ones whose names read like a mark, and take the best. A competition with no
   logo-looking file returns nothing rather than a photograph — a missing badge
   is honest, a wrong one is not. */
const FILE_OK = /\.(png|svg|jpe?g)$/i;
// Portal furniture that rides along on most articles and is not the subject's
// mark: People_icon.svg and Global_thinking.svg were being picked for UFC and
// MMA precisely because they are on every page of those portals.
const FILE_JUNK = /commons-logo|wikimedia|wiki(pedia|media|_letter)|edit[-_]|ambox|padlock|question|disambig|stub|symbol|arrow|star|red[_-]?x|green[_-]?check|blank|placeholder|sound|speaker|folder|magnify|increase|decrease|steady|people[_-]?icon|global[_-]?thinking|portal|nuvola|crystal|oojs|gnome|[_-]icon\.|icon[_-]|olympic[_-]rings|soccer[_-]?ball|sports?[_-]icon|open[_-]access|lock[_-]|scale[_-]of[_-]justice/i;
const FILE_GEO = /flag[_ ]of|map|locator|orthographic|globe|coat[_ ]of[_ ]arms/i;

function scoreFile(fileName, name) {
  // Wikipedia file titles are spaced ("File:Global thinking.svg") while these
  // patterns are written with underscores, as URLs render them. Normalise, or
  // the junk list silently matches nothing.
  const f = fileName.toLowerCase().replace(/\s+/g, '_');
  if (!FILE_OK.test(f) || FILE_JUNK.test(f) || FILE_GEO.test(f)) return -1;
  const markWord = /logo/.test(f) ? 10 : /badge|crest|emblem|shield/.test(f) ? 8 : 0;
  let tokenHits = 0;
  for (const tok of tokenSet(name)) if (f.includes(tok)) tokenHits++;

  // Something has to tie the file to this competition. Being a vector is not
  // enough on its own: the MMA article carries a yin-and-yang SVG, and that is
  // exactly what "any .svg will do" picked.
  if (!markWord && !tokenHits) return -1;

  let score = markWord + tokenHits * 3;
  if (/\.svg\./.test(f) || f.endsWith('.svg')) score += 2;   // vector ⇒ usually a mark
  if (/\.jpe?g$/.test(f)) score -= 4;                         // photographs
  return score;
}

/** The best logo-looking file on an article, as a 320px thumbnail. */
async function wikiLogoFile(title, name) {
  const list = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&titles=${encodeURIComponent(title)}&prop=images&imlimit=100`;
  let files;
  try {
    const r = await fetch(list, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA } });
    if (r.status === 429 || r.status >= 500) return undefined;
    if (!r.ok) return null;
    const pages = (await r.json())?.query?.pages;
    files = Object.values(pages || {})[0]?.images || [];
  } catch { return undefined; }

  const ranked = files
    .map((f) => ({ title: f.title, score: scoreFile(f.title, name) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;

  const info = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&titles=${encodeURIComponent(ranked[0].title)}&prop=imageinfo&iiprop=url&iiurlwidth=320`;
  try {
    const r = await fetch(info, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA } });
    if (!r.ok) return null;
    const pages = (await r.json())?.query?.pages;
    const ii = Object.values(pages || {})[0]?.imageinfo?.[0];
    return ii?.thumburl || ii?.url || null;
  } catch { return undefined; }
}

/* A competition article's lead image usually IS its logo — "UEFA Champions
   League" leads with UEFA_Champions_League.svg, which never appears in the
   file list under a name containing "logo". It still has to pass scoreFile, so
   the NRL's lead photograph of a player is rejected on the same path. */
async function wikiLeadImage(title) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&titles=${encodeURIComponent(title)}&prop=pageimages&piprop=thumbnail&pithumbsize=320`;
  try {
    const r = await fetch(u, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA } });
    if (r.status === 429 || r.status >= 500) return undefined;
    if (!r.ok) return null;
    const pages = (await r.json())?.query?.pages;
    return Object.values(pages || {})[0]?.thumbnail?.source || null;
  } catch { return undefined; }
}

async function wikiSummary(title) {
  const u = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  try {
    const r = await fetch(u, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA } });
    if (r.status === 429 || r.status >= 500) return undefined;
    if (!r.ok) return null;
    const d = await r.json();
    return d?.originalimage?.source ?? d?.thumbnail?.source ?? null;
  } catch {
    return undefined;
  }
}

/** url | null (resolved, nothing found) | undefined (request failed) */
// Wikimedia hands back whatever width the page happened to use — sometimes a
// 40px SVG render. Ask for a size the sidebar can actually show, and drop the
// analytics query it appends.
function normaliseThumb(url) {
  if (!url) return url;
  return url
    .replace(/\?utm_[^]*$/, '')
    .replace(/\/(\d{1,3})px-/, (m, w) => (Number(w) < 160 ? '/160px-' : m));
}

async function wikipedia(name, hint) {
  if (NO_LOGO.has(name)) return null;
  const term = ALIAS[name] || name;

  /* Try the article of that exact name FIRST, always — not just for aliases.
     Competition names usually are Wikipedia titles, and going direct avoids the
     failure mode search keeps producing: landing on an adjacent article and
     lifting its crest. Search gave "Caribbean Premier League" the Women's
     Premier League mark and "Bundesliga" the Frauen-Bundesliga one. */
  const direct = await wikiLogoFile(term, term);
  if (direct === undefined) return undefined;
  if (direct && !REJECT.test(direct) && !REJECT_PLACE.test(direct)) return normaliseThumb(direct);

  const lead = await wikiLeadImage(term);
  if (lead === undefined) return undefined;
  if (lead && scoreFile(lead, term) > 0 && !REJECT.test(lead) && !REJECT_PLACE.test(lead)) {
    return normaliseThumb(lead);
  }

  const q = encodeURIComponent(`${term} ${hint}`.trim());
  const u =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${q}&gsrlimit=5&redirects=1` +
    `&prop=pageimages|info&piprop=thumbnail&pithumbsize=320`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA } });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
      if (!r.ok) return undefined;
      const pages = (await r.json())?.query?.pages;
      if (!pages) return null;

      // Prefer the title that says least beyond the competition's own name.
      const ranked = Object.values(pages)
        .map((page) => {
          const title = page.title || '';
          const extras = [...tokenSet(title)].filter((tok) => !tokenSet(term).has(tok)).length;
          return { page, title, extras, index: page.index ?? 99 };
        })
        .filter((c) => relevant(isAcronym(name) ? name : term, c.title))
        .sort((a, b) => a.extras - b.extras || a.index - b.index);

      for (const c of ranked) {
        const logo = await wikiLogoFile(c.title, term);
        if (logo === undefined) return undefined;
        if (logo && !REJECT.test(logo) && !REJECT_PLACE.test(logo)) return normaliseThumb(logo);

        // No mark on the article. A lead image is only worth taking when it
        // reads like one too — otherwise leave it unresolved.
        const thumb = c.page?.thumbnail?.source;
        if (thumb && scoreFile(thumb, term) > 0 && !REJECT.test(thumb) && !REJECT_PLACE.test(thumb)) {
          return normaliseThumb(thumb);
        }
      }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return undefined;
}

/* ----------------------------------------------------------------------- run */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      await fn(items[i++]);
      await sleep(450);   // Wikimedia 429s in bulk; this run is offline, so pace it
    }
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const retryNull = argv.includes('--retry-null');
  const monthOnly = argv.includes('--month-only');
  const only = (argv.find((a) => a.startsWith('--sport=')) ?? '')
    .replace('--sport=', '').split(',').map((s) => s.trim()).filter(Boolean);

  const cached = new Map();
  for (const row of await getJSON(`entity_logos?select=name,logo_url&sport=eq.${LOGO_SPORT}&limit=5000`)) {
    cached.set(row.name, row.logo_url);
  }
  console.log(`cache: ${cached.size} competitions already resolved`);

  const keys = Object.keys(SPORTS).filter((k) => !only.length || only.includes(k));
  const todo = [];

  /* Tennis files each event as its own competition — 300 of them, most being
     challengers with no badge anywhere. The tour they belong to does have one,
     and the page falls back to it, so resolve those two by hand. */
  if (!only.length || only.includes('tennis')) {
    for (const name of ['ATP Tour', 'WTA Tour']) {
      if (force || !cached.has(name) || (retryNull && cached.get(name) == null)) {
        todo.push({ name, hint: 'tennis', sport: 'tennis' });
      }
    }
  }

  for (const key of keys) {
    const { table, hint } = SPORTS[key];
    try {
    process.stdout.write(`  ${key}: enumerating… `);
    const pairs = monthOnly
      ? await monthPairs(table)
      : [...await distinctPairs(table), ...await monthPairs(table)];
    const entries = entriesFor(pairs);
    const missing = entries.filter(
      (e) => force || !cached.has(e.name) || (retryNull && cached.get(e.name) == null) ||
             e.aliases.some((a) => !cached.has(a)));
    console.log(`${pairs.length} labels → ${entries.length} competitions, ${missing.length} to resolve`);
    for (const e of missing) todo.push({ ...e, hint, sport: key });
    } catch (err) {
      // A busy database shouldn't cost the other fourteen sports their badges.
      console.log(`skipped (${err.message.slice(0, 60)})`);
    }
  }

  if (!todo.length) { console.log('nothing to do'); return; }

  let done = 0, hit = 0, miss = 0, failed = 0;
  const batch = [];
  await pool(todo, 2, async (item) => {
    // A cached canonical with only its aliases missing needs no lookup.
    const known = cached.has(item.name) && cached.get(item.name) != null && !argv.includes('--force');
    const url = known ? cached.get(item.name) : await wikipedia(item.name, item.hint);
    done++;
    if (url === undefined) { failed++; return; }        // don't cache a failure as "none"
    if (url) hit++; else miss++;
    for (const alias of new Set([item.name, ...item.aliases])) {
      batch.push({ sport: LOGO_SPORT, name: alias, logo_url: url, source: url ? 'wikipedia' : null });
    }
    if (batch.length >= 40) { await upsert(batch.splice(0, batch.length)); }
    if (done % 25 === 0) console.log(`  ${done}/${todo.length}  found ${hit}, none ${miss}, failed ${failed}`);
  });
  await upsert(batch);

  console.log(`\ndone: ${done} resolved — ${hit} with a badge, ${miss} without, ${failed} request failures`);
}

main().catch((e) => { console.error(e); process.exit(1); });
