// Logo resolver. Reads distinct team/player names from `fixtures`, resolves a
// crest or flag for each, and upserts into `entities`.
// resolves a logo/headshot URL for each (Wikipedia search → REST summary), and
// upserts them into `entities`. Majors (MLB/NFL/NHL/NBA/WNBA) are skipped —
// the app resolves those from ESPN's CDN directly.
//
// Usage:  node scripts/resolve-logos.mjs              (only unresolved names)
//         node scripts/resolve-logos.mjs --force      (re-resolve everything)
//         node scripts/resolve-logos.mjs --retry-null (re-try cached misses)
//         node scripts/resolve-logos.mjs --sport=aussierules,ucl
//                                                (re-resolve just these sports)
//
// Also imported by api/cron/resolve-logos.ts, which calls `runResolver()` with a
// deadline so the daily run fits inside the function's maxDuration. Nothing may
// run at module scope: importing this must not touch the filesystem or exit.
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from env or ../.env.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Wikimedia asks for a descriptive User-Agent with contact info; non-compliant
// UAs get throttled/blocked under load.
const WIKI_UA = 'live-fixtures-logo-resolver/1.0 (logo cache for sports board; contact: gintsliam@gmail.com)'

/** Supabase REST base + auth headers. Resolved per-run: on Vercel there is no
 *  .env file, so this must not be evaluated at import time. */
function credentials() {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const env = parseEnv(join(HERE, '..', '.env'))
  const url = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (env or .env).')
  return { REST: `${url}/rest/v1`, H: { apikey: key, Authorization: `Bearer ${key}` } }
}

let REST = ''
let H = {}

// Leagues handled in-app via ESPN — no need to resolve here.
const MAJOR_LEAGUES = new Set(['mlb', 'nfl', 'nhl', 'nba', 'wnba'])

const SPORT_HINT = {
  soccer: 'football club',
  baseball: 'baseball team',
  basketball: 'basketball team',
  icehockey: 'ice hockey team',
  hockey: 'ice hockey team',
  cricket: 'cricket team',
  rugby_union: 'rugby union club',
  rugby_league: 'rugby league club',
  rugby: 'rugby club',
  tennis: 'tennis player',
  mma: 'mixed martial artist',
  boxing: 'boxer',
  darts: 'darts player',
  afl: 'australian football club',
  // The feed also files Australian football under `aussierules`, and buckets
  // several leagues as their own "sport". Any value missing here searches with
  // NO hint, which is how the WAFL's suburb-named clubs — Perth, Subiaco,
  // Claremont, East Fremantle — resolved to the suburbs themselves: a town
  // hall, a street, and a photo of the Perth skyline.
  aussierules: 'australian football club',
  ucl: 'football club',
  laliga: 'football club',
  nrl: 'rugby league club',
  motorsport: 'racing driver',
  amfootball: 'college football team',
  americanfootball: 'college football team',
  volleyball: 'volleyball team',
  handball: 'handball club',
  futsal: 'futsal club',
  esports: 'esports team',
  golf: 'golfer',
  snooker: 'snooker player',
  table_tennis: 'table tennis player',
  badminton: 'badminton player',
}

// Images that are almost never a team logo/headshot — usually a wrong match on
// a geographic/civic page (e.g. "Alabama" → flag of the state).
//
// The second group is for suburb-named clubs. The token guard below passes
// "East Fremantle Town Hall" for "East Fremantle" — they do share a token — so
// the picture has to be rejected on what it IS. These are the shapes Wikipedia
// leads a place article with: a civic building, a skyline, a street view.
const REJECT =
  /Flag_of|Coat_of_arms|Map_of|Locator|Seal_of|_map[._]|Orthographic/i
const REJECT_PLACE =
  /Town_Hall|City_Hall|Skyline|_CBD|Street|Railway_station|Post_Office|Courthouse|Library|Bridge|Beach|Aerial|Panorama|Church|Cathedral|Museum/i

// CLI entry — only when invoked directly, never on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runResolver({
    force: process.argv.includes('--force'),
    // --sport=aussierules,ucl : re-resolve just these sports, cached or not.
    // Fixing a hint should not mean re-running all 10k names through Wikipedia.
    sports: (process.argv.find((a) => a.startsWith('--sport=')) ?? '')
      .replace('--sport=', '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    // Re-resolve only rows whose previous attempt produced no logo. Useful when
    // the resolver itself has been improved (e.g. added the REST summary
    // fallback) without paying the cost of redoing every working row.
    retryNull: process.argv.includes('--retry-null'),
    log: console.log,
  }).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}

/**
 * Resolve missing logos into `entity_logos`.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.force]      re-resolve every name, cached or not
 * @param {boolean}  [opts.retryNull]  also re-try names cached as "no logo"
 * @param {number}   [opts.deadlineMs] wall-clock budget; stops cleanly when hit
 *                                     and reports what's left for the next run
 * @param {Function} [opts.log]        progress sink (defaults to silent)
 * @returns {Promise<{scanned:number, resolved:number, missed:number, failed:number, remaining:number, timedOut:boolean, ms:number}>}
 */
export async function runResolver(opts = {}) {
  const { force = false, retryNull = false, sports = [], deadlineMs = Infinity, log = () => {} } = opts
  const only = new Set(sports)
  const started = Date.now()
  const expired = () => Date.now() - started >= deadlineMs
  ;({ REST, H } = credentials())

  log('Loading fixtures…')
  // `fixtures`; live_fixtures was retired 2026-08-24. Ordered by the primary
  // key because a paged PostgREST read without ORDER BY is not a stable slice.
  const rows = await getAll(
    'fixtures?select=sport,league:optic_league,home_team,away_team&source=eq.optic&order=fixture_id.asc',
  )
  log(`${rows.length} fixture rows.`)

  // distinct (sport, name), skipping majors
  const wanted = new Map() // key -> {sport, name}
  for (const r of rows) {
    for (const name of [r.home_team, r.away_team]) {
      if (!name) continue
      const sport = (r.sport || '').toLowerCase()
      const league = (r.league || '').toLowerCase()
      if (MAJOR_LEAGUES.has(league) || MAJOR_LEAGUES.has(sport)) continue
      if (only.size && !only.has(sport)) continue
      wanted.set(`${sport}|${name}`, { sport, name })
    }
  }
  log(`${wanted.size} distinct non-major names.`)

  // A --sport run is a repair: whatever is cached for those sports was resolved
  // under the old hint and is exactly what needs replacing.
  if (!force && only.size === 0) {
    // `entities`, not `entity_logos`. The latter does not exist — PostgREST
    // answers 404 (PGRST205) — so this resolver has been reading nothing and
    // upserting into nowhere, which is why logo coverage stopped moving.
    const existing = await getAll('entities?select=sport,name,logo_url&order=id.asc').catch((e) => {
      log('Could not read entities')
      throw e
    })
    // In retryNull mode, only skip rows that ALREADY have a logo (the null ones
    // get re-resolved). Default mode skips every existing row.
    // Cheap win before the network work: youth and reserve sides take the
    // parent club's crest.
    await inheritFromParents(existing, log)
    const skip = existing.filter((e) => !retryNull || e.logo_url)
    for (const e of skip) wanted.delete(`${e.sport.toLowerCase()}|${e.name}`)
    log(
      `${wanted.size} need resolving (${skip.length} already cached${retryNull ? `, ${existing.length - skip.length} nulls being retried` : ''}).`,
    )
  }

  const items = [...wanted.values()]
  let done = 0
  let hits = 0
  let failed = 0
  let timedOut = false
  const batch = []
  // concurrency 2 + politeness delay keeps us within Wikimedia's limits
  await pool(
    items,
    2,
    async ({ sport, name }) => {
      const res = await resolve(sport, name)
      done++
      if (res === undefined) {
        failed++ // request failed — don't cache, retry on a later run
      } else {
        if (res) hits++
        batch.push({ sport, name, logo_url: res, source: res ? 'wikipedia' : null })
        if (batch.length >= 50) await flush(batch)
      }
      if (done % 50 === 0) log(`  ${done}/${items.length} (${hits} logos, ${failed} failed)`)
    },
    // Whatever is left when the budget runs out stays uncached, so the next
    // run picks it up exactly where this one stopped.
    () => (expired() ? ((timedOut = true), true) : false),
  )
  await flush(batch)

  const remaining = items.length - done
  log(
    timedOut
      ? `Deadline hit. Resolved ${hits} logos, ${remaining} names left for the next run.`
      : `Done. Resolved ${hits} logos, ${failed} request failures (will retry next run).`,
  )
  return {
    scanned: done,
    resolved: hits,
    missed: done - hits - failed,
    failed,
    remaining,
    timedOut,
    ms: Date.now() - started,
  }
}

/** string = logo URL, null = resolved but no image, undefined = request failed. */
async function resolve(sport, name) {
  const hint = SPORT_HINT[sport] || ''
  return wikipedia(name, hint)
}

// Wikipedia search → top page's thumbnail. The sport hint disambiguates
// (e.g. "Sun" → "Connecticut Sun basketball team"). Retries with backoff on
// throttling so transient 429s don't get cached as "no logo".
async function wikipedia(name, hint) {
  const q = encodeURIComponent(`${name} ${hint}`.trim())
  const u =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${q}&gsrlimit=5&redirects=1` +
    `&prop=pageimages|info&piprop=thumbnail&pithumbsize=200`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA } })
      if (r.status === 429 || r.status >= 500) {
        await sleep(800 * (attempt + 1))
        continue
      }
      if (!r.ok) return undefined
      const d = await r.json()
      const pages = d?.query?.pages
      if (!pages) return null
      // Rank the candidates rather than trusting the top hit.
      //
      // Searching "Perth australian football club" returns West Perth first,
      // East Perth second, Perth Glory (a soccer club, with a tempting logo)
      // third, and the actual Perth Football Club fourth. Taking result #1 gave
      // Perth the Falcons crest — West Perth's — and taking the first result
      // WITH an image would have given it Perth Glory's.
      //
      // So score by how much the title says beyond the name: strip the words
      // every club title carries, and prefer the candidate that adds nothing.
      const ranked = Object.values(pages)
        .map((page) => {
          const title = page.title || ''
          const extras = [...tokens(title)].filter(
            (tok) => !GENERIC_TITLE_WORDS.has(tok) && !tokens(name).has(tok),
          )
          return { page, title, extras: extras.length, index: page.index ?? 99 }
        })
        .filter((c) => relevant(name, c.title))
        .sort((a, b) => a.extras - b.extras || a.index - b.index)

      for (const c of ranked) {
        const t = c.page?.thumbnail?.source
        if (t) {
          if (REJECT.test(t) || REJECT_PLACE.test(t)) continue
          return t
        }
        // The search found the right page but it has no pageimage (common for
        // AFL/NRL clubs). The REST summary returns originalimage/thumbnail more
        // reliably.
        const summary = await wikipediaSummary(c.title)
        if (summary === undefined) return undefined // request failure
        if (summary && !REJECT.test(summary) && !REJECT_PLACE.test(summary)) return summary
      }
      return null
    } catch {
      await sleep(500 * (attempt + 1))
    }
  }
  return undefined // exhausted retries
}

/** Wikipedia REST summary fallback — gives originalimage when pageimages
 *  doesn't. Returns url, null (no image), or undefined (network failure). */
async function wikipediaSummary(title) {
  const u = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
  try {
    const r = await fetch(u, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA } })
    if (r.status === 429 || r.status >= 500) return undefined
    if (!r.ok) return null
    const d = await r.json()
    return d?.originalimage?.source ?? d?.thumbnail?.source ?? null
  } catch {
    return undefined
  }
}

const STOP = new Set([
  'fc', 'cf', 'sc', 'ac', 'bc', 'cd', 'ca', 'cr', 'fr', 'afc', 'club', 'clube', 'de', 'do', 'da',
  'dos', 'das', 'the', 'of', 'and', 'e', 'ii', 'jr', 'team', 'city', 'united', 'football', 'futebol',
])

function tokens(s) {
  return new Set(
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  )
}

/**
 * Directional qualifiers that DISTINGUISH clubs rather than decorate them.
 *
 * "Perth" and "West Perth" are different WAFL clubs, as are "Fremantle",
 * "East Fremantle" and "South Fremantle". A search for the bare name happily
 * returns the qualified club — "Perth" resolved to West Perth's Falcons crest,
 * the same image as West Perth's own row.
 */
/** Words every club title carries — they say nothing about WHICH club. */
const GENERIC_TITLE_WORDS = new Set([
  'football', 'club', 'fc', 'afc', 'sc', 'association', 'team', 'sports', 'sporting',
  'the', 'of', 'and',
])

const DIRECTIONAL = new Set([
  'north', 'south', 'east', 'west', 'central', 'northern', 'southern', 'eastern',
  'western', 'upper', 'lower',
])

/** true if the page title shares a meaningful token with the searched name. */
function relevant(name, title) {
  const n = tokens(name)
  if (n.size === 0) return true // nothing distinctive to check — trust the search
  const t = tokens(title)
  // A directional word in the title that the name does not have means the
  // search drifted to the neighbouring club, not this one.
  for (const tok of t) if (DIRECTIONAL.has(tok) && !n.has(tok)) return false
  for (const tok of n) if (t.has(tok)) return true
  return false
}

let skipped = 0

async function upsertRows(rows) {
  const res = await fetch(`${REST}/entities?on_conflict=sport,name`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  })
  return res.ok ? null : `${res.status}: ${(await res.text()).slice(0, 160)}`
}

/**
 * Upsert a batch, falling back to row-at-a-time when the batch is rejected.
 *
 * `entities` carries TWO unique indexes: (sport, name) and (sport, normalized).
 * The conflict target here is the first, so a row that satisfies it can still
 * violate the second — "Real Madrid CF" and "Real Madrid" normalise to the same
 * thing — and Postgres fails the WHOLE statement rather than that row. A
 * nightly job that loses 500 good rows to one collision, and reports success
 * because the batch was retried and the count logged, is how the other three
 * silent writers in this codebase behaved.
 *
 * So: try the batch, and on failure retry each row alone so the collision costs
 * one row and gets named in the log.
 */
/**
 * Youth, reserve and B sides inherit the parent club's crest.
 *
 * "Midtjylland U19", "Dundalk U20", "Arabe Unido B" have no crest of their own
 * and no search will ever find one — but the parent club is usually already
 * resolved. Stripping the suffix and inheriting covers a chunk of the gap for a
 * regex and a lookup, with no new source.
 *
 * Returns the parent name, or null when the name carries no such suffix.
 */
const AGE_SUFFIX = /\s+(?:U\s?1[5-9]|U\s?2[0-3]|B|II|A)$/i

function parentName(name) {
  const m = AGE_SUFFIX.exec(name)
  if (!m) return null
  const parent = name.slice(0, m.index).trim()
  // "FC B" would leave "FC"; anything this short is not a club.
  return parent.length >= 4 ? parent : null
}

/**
 * Fill youth/reserve sides from their parent's crest.
 *
 * Runs over what is ALREADY cached with a null logo — those names are skipped
 * by the resolver proper, so they would never be revisited otherwise.
 */
async function inheritFromParents(existing, log = () => {}) {
  // Club-type words are dropped before comparing: the youth side is filed as
  // "Silkeborg U19" while the senior club is "Silkeborg IF", so an exact-name
  // parent lookup finds nothing at all — measured, 0 of 263. Normalising the
  // suffix away finds 57.
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\b(fc|fk|if|sk|bk|cf|ac|as|sc|club|football)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  const byNorm = new Map()
  for (const e of existing) {
    if (!e.logo_url) continue
    const k = `${(e.sport || '').toLowerCase()}|${norm(e.name)}`
    if (!byNorm.has(k)) byNorm.set(k, e)
  }

  const batch = []
  let found = 0
  for (const e of existing) {
    if (e.logo_url) continue
    const parent = parentName(e.name)
    if (!parent) continue
    const p = byNorm.get(`${(e.sport || '').toLowerCase()}|${norm(parent)}`)
    if (!p?.logo_url) continue
    batch.push({ sport: e.sport, name: e.name, logo_url: p.logo_url, source: 'parent' })
    found++
    if (batch.length >= 50) await flush(batch)
  }
  await flush(batch)
  log(`Inherited ${found} crests from parent clubs.`)
  return found
}

async function flush(batch) {
  if (batch.length === 0) return
  const rows = batch.splice(0, batch.length)
  const err = await upsertRows(rows)
  if (!err) return
  log(`  batch of ${rows.length} rejected (${err}) — retrying row by row`)
  for (const row of rows) {
    const rowErr = await upsertRows([row])
    if (rowErr) {
      skipped++
      log(`  skipped ${row.sport}/${row.name}: ${rowErr}`)
    }
  }
}

async function getJSON(url) {
  const r = await fetch(url, { headers: H })
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}: ${await r.text()}`)
  return r.json()
}

// Paginate past PostgREST's default 1000-row cap using Range headers.
async function getAll(pathAndQuery) {
  const rows = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const r = await fetch(`${REST}/${pathAndQuery}`, {
      headers: { ...H, Range: `${from}-${from + size - 1}`, 'Range-Unit': 'items' },
    })
    if (!r.ok) throw new Error(`GET ${pathAndQuery} → ${r.status}: ${await r.text()}`)
    const batch = await r.json()
    rows.push(...batch)
    if (batch.length < size) break
  }
  return rows
}

// Bounded-concurrency map with a small politeness delay. `stop` is polled before
// each item so a caller with a deadline exits the loop outright — skipping the
// remaining `fn` calls but still paying the 200ms sleep on each would take
// minutes to drain a long backlog.
async function pool(items, n, fn, stop = () => false) {
  let i = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        if (stop()) break
        const item = items[i++]
        await fn(item)
        await sleep(200)
      }
    }),
  )
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseEnv(path) {
  try {
    const out = {}
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].trim()
    }
    return out
  } catch {
    return {}
  }
}
