// Backfill `entities.normalized`.
//
// `fixture_entities` joins a fixture's team/player name to `entities` on
// (sport, normalized) — that column is the ONLY join key. But both resolvers
// upsert on (sport, name) and never write `normalized`, so every row they
// create is invisible to the view: the logo is in the table and the app cannot
// see it. 9.3k rows were in that state, 4.7k of them carrying a resolved logo
// or country.
//
// Collisions are the reason this is a script and not one UPDATE. `entities`
// carries a unique index on (sport, normalized), and distinct names normalise
// to the same key ("Real Madrid CF" / "Real Madrid"). Where a key is already
// owned, we do not fight for it — we fill whatever the owner is missing from
// the row that would have collided, which is the outcome we actually want.
//
// Usage:  node scripts/backfill-entity-normalized.mjs             dry run
//         node scripts/backfill-entity-normalized.mjs --apply     write
//         node scripts/backfill-entity-normalized.mjs --apply --max=2500
//
// Re-running is safe and resumes: it reads live state and only queues rows
// whose `normalized` is still NULL.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
function credentials() {
  const env = Object.fromEntries(
    readFileSync(join(HERE, '..', '.env'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )
  const url = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  return { REST: `${url}/rest/v1`, H: { apikey: key, Authorization: `Bearer ${key}` } }
}

const { REST, H } = credentials()
const JSON_H = { ...H, 'Content-Type': 'application/json' }
const APPLY = process.argv.includes('--apply')
const MAX = Number((process.argv.find((a) => a.startsWith('--max=')) ?? '').split('=')[1]) || Infinity

/** The view's key: lowercase, accents folded, non-alphanumerics to underscore. */
const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

async function allEntities() {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${REST}/entities?select=*&order=id.asc`, {
      headers: { ...H, Range: `${from}-${from + 999}` },
    })
    const page = await r.json()
    rows.push(...page)
    if (page.length < 1000) return rows
  }
}

/** One PATCH per row — each row takes a different value, so no batching. */
async function patch({ id, ...body }) {
  const r = await fetch(`${REST}/entities?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...JSON_H, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  return r.ok ? null : `${r.status}: ${(await r.text()).slice(0, 140)}`
}

async function flush(list, label) {
  let ok = 0
  let failed = 0
  let next = 0
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (next < list.length) {
        const row = list[next++]
        const err = await patch(row)
        if (err) {
          failed++
          if (failed < 6) console.log(`   skip ${row.id}: ${err}`)
        } else {
          ok++
          if (ok % 1000 === 0) console.log(`   ${label}: ${ok}/${list.length}`)
        }
      }
    }),
  )
  console.log(`${label}: wrote ${ok}, failed ${failed}`)
}

const MARKS = ['logo_url', 'source', 'country', 'country_name', 'country_src', 'entity_type']

const rows = await allEntities()
const owner = new Map() // `${sport}|${normalized}` -> row
for (const r of rows) if (r.normalized) owner.set(`${r.sport}|${r.normalized}`, r)

const claims = []
const merges = []
let noop = 0
let blank = 0
for (const r of rows) {
  if (r.normalized) continue
  const key = norm(r.name)
  if (!key) {
    blank++
    continue
  }
  const k = `${r.sport}|${key}`
  const own = owner.get(k)
  if (!own) {
    owner.set(k, { ...r, normalized: key })
    claims.push({ id: r.id, normalized: key })
    continue
  }
  // Key taken: hand the owner anything it is missing rather than collide.
  const fill = {}
  for (const f of MARKS) if (!own[f] && r[f]) fill[f] = r[f]
  if (Object.keys(fill).length) {
    merges.push({ id: own.id, ...fill })
    Object.assign(own, fill)
  } else noop++
}

const dark = claims.filter((c) => {
  const r = rows.find((x) => x.id === c.id)
  return r.logo_url || r.country
}).length

console.log(`entities: ${rows.length}, already normalized: ${rows.length - claims.length - merges.length - noop - blank}`)
console.log(`  claim a free key : ${claims.length}  (${dark} carry a mark the app cannot currently see)`)
console.log(`  merge into owner : ${merges.length}`)
console.log(`  nothing to add   : ${noop}`)
console.log(`  unnormalisable   : ${blank}`)

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to write')
  process.exit(0)
}

await flush(claims.slice(0, MAX), 'claims')
if (claims.length <= MAX) await flush(merges, 'merges')
else console.log(`remaining: ${claims.length - MAX} (re-run to continue)`)
