// Offline logo resolver. Reads distinct team/player names from `live_fixtures`,
// resolves a logo/headshot URL for each (Wikipedia, then TheSportsDB for player
// sports), and upserts them into `entity_logos`. Majors (MLB/NFL/NHL/NBA/WNBA)
// are skipped — the app resolves those from ESPN's CDN directly.
//
// Usage:  node scripts/resolve-logos.mjs            (only unresolved names)
//         node scripts/resolve-logos.mjs --force    (re-resolve everything)
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from env or ../.env.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = parseEnv(join(HERE, '..', '.env'))
const URL = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
const FORCE = process.argv.includes('--force')
// Re-resolve only rows whose previous attempt produced no logo. Useful when
// the resolver itself has been improved (e.g. added the REST summary fallback)
// without paying the cost of redoing every working row.
const RETRY_NULL = process.argv.includes('--retry-null')

if (!URL || !KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (env or .env).')
  process.exit(1)
}

const REST = `${URL}/rest/v1`
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// Wikimedia asks for a descriptive User-Agent with contact info; non-compliant
// UAs get throttled/blocked under load.
const WIKI_UA = 'live-fixtures-logo-resolver/1.0 (logo cache for sports board; contact: gintsliam@gmail.com)'

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

// Images that are almost never a team logo/headshot — usually a wrong match on a
// geographic/civic page (e.g. "Alabama" → flag of the state).
const REJECT = /Flag_of|Coat_of_arms|Map_of|Locator|Seal_of|_map[._]|Orthographic/i

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

async function main() {
  console.log('Loading fixtures…')
  const rows = await getAll('live_fixtures?select=sport,league,home_team,away_team')
  console.log(`${rows.length} fixture rows.`)

  // distinct (sport, name), skipping majors
  const wanted = new Map() // key -> {sport, name}
  for (const r of rows) {
    for (const name of [r.home_team, r.away_team]) {
      if (!name) continue
      const sport = (r.sport || '').toLowerCase()
      const league = (r.league || '').toLowerCase()
      if (MAJOR_LEAGUES.has(league) || MAJOR_LEAGUES.has(sport)) continue
      wanted.set(`${sport}|${name}`, { sport, name })
    }
  }
  console.log(`${wanted.size} distinct non-major names.`)

  if (!FORCE) {
    const existing = await getAll('entity_logos?select=sport,name,logo_url').catch((e) => {
      console.error('Could not read entity_logos — did you run scripts/entity_logos.sql?')
      throw e
    })
    // In --retry-null mode, only skip rows that ALREADY have a logo (the null
    // ones get re-resolved). Default mode skips every existing row.
    const skip = existing.filter((e) => !RETRY_NULL || e.logo_url)
    for (const e of skip) wanted.delete(`${e.sport.toLowerCase()}|${e.name}`)
    console.log(
      `${wanted.size} need resolving (${skip.length} already cached${RETRY_NULL ? `, ${existing.length - skip.length} nulls being retried` : ''}).`,
    )
  }

  const items = [...wanted.values()]
  let done = 0
  let hits = 0
  let failed = 0
  const batch = []
  // concurrency 2 + politeness delay keeps us within Wikimedia's limits
  await pool(items, 2, async ({ sport, name }) => {
    const res = await resolve(sport, name)
    done++
    if (res === undefined) {
      failed++ // request failed — don't cache, retry on a later run
    } else {
      if (res) hits++
      batch.push({ sport, name, logo_url: res, source: res ? 'wikipedia' : null })
      if (batch.length >= 50) await flush(batch)
    }
    if (done % 50 === 0) console.log(`  ${done}/${items.length} (${hits} logos, ${failed} failed)`)
  })
  await flush(batch)
  console.log(`Done. Resolved ${hits} logos, ${failed} request failures (will retry next run).`)
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
    `&generator=search&gsrsearch=${q}&gsrlimit=1&redirects=1` +
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
      for (const k of Object.keys(pages)) {
        const page = pages[k]
        const title = page.title || ''
        if (!relevant(name, title)) return null
        const t = page?.thumbnail?.source
        if (t) {
          if (REJECT.test(t)) return null
          return t
        }
        // Wikipedia search returned the right page but it has no pageimage
        // (common for AFL/NRL clubs). Fall through to the REST summary which
        // returns originalimage / thumbnail more reliably.
        const summary = await wikipediaSummary(title)
        if (summary === undefined) return undefined // request failure
        if (summary && !REJECT.test(summary)) return summary
        return null
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

/** true if the page title shares a meaningful token with the searched name. */
function relevant(name, title) {
  const n = tokens(name)
  if (n.size === 0) return true // nothing distinctive to check — trust the search
  const t = tokens(title)
  for (const tok of n) if (t.has(tok)) return true
  return false
}

async function flush(batch) {
  if (batch.length === 0) return
  const rows = batch.splice(0, batch.length)
  const res = await fetch(`${REST}/entity_logos?on_conflict=sport,name`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  })
  if (!res.ok) throw new Error(`upsert ${res.status}: ${await res.text()}`)
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

// bounded-concurrency map with a small politeness delay
async function pool(items, n, fn) {
  let i = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
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
