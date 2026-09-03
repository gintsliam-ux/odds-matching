// Enforce what a competitor's mark is allowed to be: a proper crest, or nothing.
//
// The Wikipedia resolver takes the top-ranked article's thumbnail, and when the
// article is wrong the thumbnail is a photograph — Real Madrid CF was showing
// José Mourinho at Fenerbahçe, FC Luzern the Swissporarena, Puerto Montt
// Basquetbol a picture of a town in Argentina. A photo is worse than nothing:
// initials at least don't assert something false.
//
// Two rules:
//   teams   — a .jpg/.jpeg thumbnail is a photograph unless the filename says
//             otherwise (logo/crest/badge/escudo/emblem). Clear it.
//   players — the mark is the flag of the country they compete for, or nothing.
//             Never a headshot: it dates, it's missing for most of a field, and
//             at row height it reads as noise.
//
// Clearing is safe against the daily cron: that run skips any name that already
// has a row (it only resolves names it has never seen), so a cleared logo stays
// cleared until someone runs `resolve-logos.mjs --retry-null` with the tightened
// relevance rules.
//
// Usage:  node scripts/enforce-entity-marks.mjs            dry run
//         node scripts/enforce-entity-marks.mjs --apply

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

/** Sports whose competitors are people — they fly a flag, never a photo. */
const PLAYER_SPORTS = new Set(['tennis', 'golf', 'mma', 'boxing', 'darts'])

/** Filename words that mark a .jpg as an actual logo rather than a photograph. */
const LOGO_WORD = /logo|crest|badge|escudo|emblem|shield|scudetto|logotipo|wappen/i
const isPhoto = (u) => /\.(jpe?g)(\?|$)/i.test(u || '') && !LOGO_WORD.test(u || '')

const flagUrl = (iso) => `https://flagcdn.com/w160/${iso.toLowerCase()}.png`

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
          if (ok % 500 === 0) console.log(`   ${label}: ${ok}/${list.length}`)
        }
      }
    }),
  )
  console.log(`${label}: wrote ${ok}, failed ${failed}`)
}

const rows = await allEntities()
const photos = []
const players = []
for (const r of rows) {
  const isPlayer = PLAYER_SPORTS.has(r.sport) || r.entity_type === 'player'
  if (isPlayer) {
    const want = r.country ? flagUrl(r.country) : null
    if (r.logo_url !== want) {
      players.push({
        id: r.id,
        logo_url: want,
        source: want ? 'flagcdn' : null,
        _was: r.logo_url,
        _name: r.name,
      })
    }
    continue
  }
  if (isPhoto(r.logo_url)) {
    photos.push({ id: r.id, logo_url: null, source: null, _was: r.logo_url, _name: r.name })
  }
}

const show = (list, n = 8) =>
  list.slice(0, n).forEach((p) => {
    const file = decodeURIComponent((p._was || '').split('/').pop() || '').slice(0, 52)
    console.log(`   ${p._name.slice(0, 30).padEnd(30)} ${p.logo_url ? '-> flag' : 'x'} ${file}`)
  })

console.log(`entities: ${rows.length}`)
console.log(`\nteams — photographs to clear: ${photos.length}`)
show(photos)
const toFlag = players.filter((p) => p.logo_url).length
console.log(`\nplayers — marks to correct: ${players.length} (${toFlag} become a flag, ${players.length - toFlag} cleared)`)
show(players)

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to write')
  process.exit(0)
}

await flush(
  photos.map(({ _was, _name, ...row }) => row),
  'teams',
)
await flush(
  players.map(({ _was, _name, ...row }) => row),
  'players',
)
