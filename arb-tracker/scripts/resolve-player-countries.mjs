#!/usr/bin/env node
/**
 * Resolve tennis player -> country from Wikidata, for the flag beside a name.
 *
 * The odds feed gives us bare player names, so this is a batch job, not a
 * runtime lookup: it writes a seed file that populates
 * `tennis_player_countries`, which the app then joins against.
 *
 *   node scripts/resolve-player-countries.mjs [--all] [--out DIR]
 *
 * By default it only resolves players missing from the table; --all re-resolves
 * everyone (federations change, so this is worth re-running occasionally).
 *
 * With SUPABASE_SERVICE_ROLE_KEY in .env it upserts straight into the table, so
 * this is safe to run on a schedule to keep flags current. Without that key it
 * still writes supabase/seed-player-countries.sql for you to run by hand (the
 * anon key can't write through RLS).
 *
 * Two things this gets right that a naive lookup doesn't:
 *  - It prefers P1532 "country for sport" over P27 citizenship. Players who
 *    switched federations (Bublik KZ-not-RU, Avanesyan AM, Oliynykova HR) would
 *    otherwise fly the wrong flag.
 *  - It picks the *current* federation from multi-valued claims using rank and
 *    the start/end-time qualifiers, rather than whichever came back first.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'arb-tracker/1.0 (player-country resolver)';
// Occupations we accept a match under — tennis player or MMA fighter, since the
// same table now carries both tennis players and UFC fighters.
const TENNIS_PLAYER = 'Q10833314';
const MMA_FIGHTER = 'Q11607585';
const OCCUPATIONS = [TENNIS_PLAYER, MMA_FIGHTER];
const OCC_VALUES = OCCUPATIONS.map((q) => `wd:${q}`).join(' ');
const SPARQL = 'https://query.wikidata.org/sparql';
const WD_API = 'https://www.wikidata.org/w/api.php';

const args = process.argv.slice(2);
const RESOLVE_ALL = args.includes('--all');
const OUT_DIR = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, 'supabase');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env() {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8');
  const get = (k) => raw.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
  const url = get('VITE_SUPABASE_URL');
  const anon = get('VITE_SUPABASE_ANON_KEY');
  if (!url || !anon) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing from .env');
  // Present => the resolver upserts straight into the table; absent => it falls
  // back to emitting seed SQL for you to run by hand. Reads only need the anon
  // key, so discovery works either way.
  const service =
    get('SUPABASE_SERVICE_ROLE_KEY') ?? get('SUPABASE_SERVICE_KEY') ?? get('SERVICE_ROLE_KEY');
  return { url, anon, service };
}

async function rest(path, init) {
  const { url, anon, service } = env();
  const key = init?.method && init.method !== 'GET' ? (service ?? anon) : anon;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...init?.headers },
  });
  if (r.status === 204) return null;
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${body.message ?? r.status}`);
  return body;
}

/**
 * Upsert resolved rows straight into tennis_player_countries. Needs the
 * service-role key (RLS blocks anon writes); returns false when it's absent so
 * the caller can fall back to the SQL seed file.
 */
async function upsert(rows) {
  const { service } = env();
  if (!service || !rows.length) return false;
  await rest('tennis_player_countries?on_conflict=player_name', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(
      rows.map((r) => ({ ...r, resolved_at: new Date().toISOString() })),
    ),
  });
  return true;
}

/**
 * Wikidata throttles hard (429) if you re-run this a few times in a row, so
 * every call backs off and retries rather than losing a half-finished batch.
 */
async function fetchRetry(url, headers, label) {
  let wait = 2000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r;
    if (r.status !== 429 && r.status < 500) {
      throw new Error(`${label} ${r.status}: ${(await r.text()).slice(0, 160)}`);
    }
    if (attempt === 5) throw new Error(`${label} ${r.status} after ${attempt} attempts`);
    const retryAfter = Number(r.headers.get('retry-after')) * 1000;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : wait);
    wait *= 2;
  }
  throw new Error(`${label}: unreachable`);
}

async function sparql(query) {
  const r = await fetchRetry(
    `${SPARQL}?format=json&query=${encodeURIComponent(query)}`,
    { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
    'SPARQL',
  );
  return (await r.json()).results.bindings;
}

async function wdApi(params) {
  const qs = new URLSearchParams({ format: 'json', origin: '*', ...params });
  const r = await fetchRetry(`${WD_API}?${qs}`, { 'User-Agent': UA }, 'wikidata api');
  return r.json();
}

/** Every distinct competitor on the tennis and UFC boards (both fly flags). */
async function boardPlayers() {
  const names = new Set();
  for (const table of ['tennis_events', 'ufc_events']) {
    const rows = await rest(`${table}?select=home_team,away_team&limit=5000`);
    for (const r of rows) {
      if (r.home_team) names.add(r.home_team);
      if (r.away_team) names.add(r.away_team);
    }
  }
  return [...names].sort();
}

async function alreadyResolved() {
  try {
    const rows = await rest('tennis_player_countries?select=player_name&limit=5000');
    return new Set(rows.map((r) => r.player_name));
  } catch {
    return new Set(); // table not created yet — resolve everything
  }
}

/** Stage 1: exact English label, restricted to tennis players. High precision. */
async function byExactLabel(names) {
  const found = new Map();
  const CHUNK = 60;
  for (let i = 0; i < names.length; i += CHUNK) {
    const values = names
      .slice(i, i + CHUNK)
      .map((n) => `"${n.replace(/["\\]/g, '')}"@en`)
      .join(' ');
    const rows = await sparql(
      `SELECT ?name ?p WHERE {
         VALUES ?name { ${values} }
         VALUES ?occ { ${OCC_VALUES} }
         ?p rdfs:label ?name ; wdt:P106 ?occ .
       }`,
    );
    for (const b of rows) found.set(b.name.value, b.p.value.split('/').pop());
    await sleep(300);
  }
  return found;
}

/**
 * Stage 2: Wikidata's search API for whatever stage 1 missed — it matches
 * without diacritics, which is how the feed spells names ("Bouzkova").
 * Every hit is verified to actually be a tennis player before it's accepted.
 */
async function bySearch(names) {
  const found = new Map();
  for (const name of names) {
    try {
      const s = await wdApi({
        action: 'wbsearchentities',
        search: name,
        language: 'en',
        uselang: 'en',
        type: 'item',
        limit: '5',
      });
      const ids = (s.search ?? []).map((x) => x.id);
      if (ids.length) {
        const rows = await sparql(
          `SELECT ?p WHERE {
             VALUES ?p { ${ids.map((i) => `wd:${i}`).join(' ')} }
             VALUES ?occ { ${OCC_VALUES} }
             ?p wdt:P106 ?occ .
           }`,
        );
        if (rows.length) found.set(name, rows[0].p.value.split('/').pop());
      }
    } catch (e) {
      console.warn(`  ! ${name}: ${e.message}`);
    }
    await sleep(350);
  }
  return found;
}

/** Non-deprecated claims for a property, best-first (see pickCurrent). */
function claimsFor(entity, prop) {
  return (entity.claims?.[prop] ?? []).filter((c) => c.rank !== 'deprecated');
}

const qidOf = (claim) => claim.mainsnak?.datavalue?.value?.id ?? null;
const timeOf = (claim, prop) =>
  claim.qualifiers?.[prop]?.[0]?.datavalue?.value?.time ?? null;

/**
 * The federation a player currently represents. Preferred rank wins; then the
 * claim with no end date; then the latest start date. Without this, a player
 * who switched federations resolves to the country they left.
 *
 * Returns `{ qid: null, ambiguous: true }` when the claims genuinely can't be
 * separated — Bublik, for instance, carries bare Russia and Kazakhstan claims
 * with no dates and no ranks. Guessing there flies the wrong flag half the
 * time, so those go to the review file for a manual override instead.
 */
function pickCurrent(claims) {
  if (!claims.length) return { qid: null, ambiguous: false };

  const distinct = new Set(claims.map(qidOf).filter(Boolean));
  if (distinct.size === 1) return { qid: [...distinct][0], ambiguous: false };

  const preferred = claims.filter((c) => c.rank === 'preferred');
  if (preferred.length === 1) return { qid: qidOf(preferred[0]), ambiguous: false };
  const pool = preferred.length ? preferred : claims;

  const open = pool.filter((c) => !timeOf(c, 'P582')); // no end time => current
  if (open.length === 1) return { qid: qidOf(open[0]), ambiguous: false };

  // Several still standing: only a start date can separate them now.
  const dated = (open.length ? open : pool).filter((c) => timeOf(c, 'P580'));
  if (dated.length) {
    const latest = dated
      .slice()
      .sort((a, b) => (timeOf(b, 'P580') ?? '').localeCompare(timeOf(a, 'P580') ?? ''));
    if (timeOf(latest[0], 'P580') !== timeOf(latest[1] ?? {}, 'P580')) {
      return { qid: qidOf(latest[0]), ambiguous: false };
    }
  }
  return { qid: null, ambiguous: true };
}

/** Hand-checked corrections for players Wikidata can't disambiguate. */
function overrides() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'supabase/player-country-overrides.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function entities(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const j = await wdApi({
      action: 'wbgetentities',
      ids: ids.slice(i, i + 50).join('|'),
      props: 'claims|labels',
      languages: 'en',
    });
    Object.assign(out, j.entities ?? {});
    await sleep(300);
  }
  return out;
}

async function main() {
  const players = await boardPlayers();
  const skip = RESOLVE_ALL ? new Set() : await alreadyResolved();
  const todo = players.filter((n) => !skip.has(n));
  console.log(`${players.length} players on the board; resolving ${todo.length}` +
    (skip.size ? ` (${skip.size} already stored)` : ''));
  if (!todo.length) return;

  const qids = await byExactLabel(todo);
  console.log(`  exact label:  ${qids.size}/${todo.length}`);

  const missing = todo.filter((n) => !qids.has(n));
  if (missing.length) {
    const extra = await bySearch(missing);
    for (const [k, v] of extra) qids.set(k, v);
    console.log(`  search API:   +${extra.size} (of ${missing.length} remaining)`);
  }

  const ents = await entities([...new Set(qids.values())]);

  // Resolve each player's country QID, then those QIDs to ISO-3166 alpha-2.
  const picked = new Map();
  const ambiguous = [];
  for (const [name, qid] of qids) {
    const e = ents[qid];
    if (!e) continue;
    const sport = pickCurrent(claimsFor(e, 'P1532'));
    const cit = pickCurrent(claimsFor(e, 'P27'));
    // An undecidable federation must NOT fall through to citizenship: Bublik's
    // sport claims are Russia/Kazakhstan with nothing to separate them, but his
    // citizenship is Russia alone — the fallback would confidently pick a flag
    // he hasn't played under since 2016.
    if (sport.ambiguous || (!sport.qid && cit.ambiguous)) {
      ambiguous.push({ player_name: name, player_qid: qid });
      continue;
    }
    const country = sport.qid ?? cit.qid;
    if (country) {
      picked.set(name, { qid, country, source: sport.qid ? 'sport' : 'citizenship' });
    }
  }

  const countryEnts = await entities([...new Set([...picked.values()].map((p) => p.country))]);
  const iso = (cq) =>
    countryEnts[cq]?.claims?.P297?.[0]?.mainsnak?.datavalue?.value ?? null;

  const manual = overrides();
  const rows = [];
  const unresolved = [];
  for (const name of todo) {
    if (manual[name]?.iso2) {
      rows.push({
        player_name: name,
        country_iso2: manual[name].iso2.toLowerCase(),
        country_qid: manual[name].country_qid ?? null,
        player_qid: qids.get(name) ?? null,
        source: 'override',
      });
      continue;
    }
    const p = picked.get(name);
    const code = p ? iso(p.country) : null;
    if (!p || !code) {
      unresolved.push(name);
      continue;
    }
    rows.push({
      player_name: name,
      country_iso2: code.toLowerCase(),
      country_qid: p.country,
      player_qid: p.qid,
      source: p.source,
    });
  }

  const bySource = rows.reduce((a, r) => ((a[r.source] = (a[r.source] ?? 0) + 1), a), {});
  console.log(
    `\nresolved ${rows.length}/${todo.length}  (${bySource.sport ?? 0} by sport country, ` +
      `${bySource.citizenship ?? 0} by citizenship)`,
  );
  if (unresolved.length) console.log(`unresolved: ${unresolved.join(', ')}`);

  // Ambiguous players get no flag until a human picks — surfaced, never guessed.
  const review = ambiguous.filter((a) => !manual[a.player_name]);
  if (review.length) {
    console.log(
      `\n${review.length} need a manual call (Wikidata lists several countries with ` +
        `nothing to separate them):`,
    );
    for (const a of review) {
      console.log(`   ${a.player_name}  https://www.wikidata.org/wiki/${a.player_qid}`);
    }
    console.log('   -> add them to supabase/player-country-overrides.json and re-run');
    writeFileSync(
      join(OUT_DIR, 'player-countries-review.json'),
      `${JSON.stringify(review, null, 2)}\n`,
    );
  }

  // Nothing new to write — don't clobber a good seed file with an empty INSERT
  // (an incremental run resolves only the players not already stored).
  if (!rows.length) {
    console.log('\nnothing new to write');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, 'player-countries.json');
  writeFileSync(jsonPath, `${JSON.stringify(rows, null, 2)}\n`);

  const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const seed = `-- Generated by scripts/resolve-player-countries.mjs — do not hand-edit.
-- Source: Wikidata (P1532 country for sport, falling back to P27 citizenship).
insert into public.tennis_player_countries
  (player_name, country_iso2, country_qid, player_qid, source)
values
${rows
  .map(
    (r) =>
      `  (${esc(r.player_name)}, ${esc(r.country_iso2)}, ${esc(r.country_qid)}, ` +
      `${esc(r.player_qid)}, ${esc(r.source)})`,
  )
  .join(',\n')}
on conflict (player_name) do update set
  country_iso2 = excluded.country_iso2,
  country_qid  = excluded.country_qid,
  player_qid   = excluded.player_qid,
  source       = excluded.source,
  resolved_at  = now();
`;
  const seedPath = join(OUT_DIR, 'seed-player-countries.sql');
  writeFileSync(seedPath, seed);

  // Write straight to the table when we hold the service-role key; otherwise
  // the seed file is the hand-run fallback.
  const wrote = await upsert(rows);
  console.log(`\nwrote ${jsonPath}\nwrote ${seedPath}`);
  if (wrote) {
    console.log(`upserted ${rows.length} rows into tennis_player_countries`);
  } else if (rows.length) {
    console.log('no service-role key — run supabase/seed-player-countries.sql to apply');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
