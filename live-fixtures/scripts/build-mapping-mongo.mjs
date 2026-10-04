// Run both matchers against NAS Mongo instead of Supabase.
//
// Same decisions, different destination. `build-mapping.mjs` and
// `build-mybet-mapping.mjs` keep writing Supabase for live-fixtures; this entry
// point hands them a Mongo store so `gutsys_sport.event_mapping` and
// `competition_mapping` — what Sports Odds Desk and the Odds Library read —
// get the identical result.
//
// It exists because they did not. The Supabase side has a daily Vercel cron and
// a client-pinged mapping-tick; the Mongo side had nothing at all, so its
// event_mapping froze on 2026-09-16 and every fixture created afterwards sat
// behind a placeholder row with a null gutsy_event_id. A mapped tournament with
// an unmapped fixture under it is exactly that gap.
//
// Mongo, twice over, and they are different machines:
//   SPORT_MONGO_URI   gutsys_sport on the NAS, over Tailscale — SOURCE fixtures
//                     and DESTINATION mapping tables.
//   MONGO_URI         gutsy on Atlas — the books' own events, the match TARGET.
//                     Unchanged; both matchers already read it directly.
//
// Usage:
//   node scripts/build-mapping-mongo.mjs             both providers
//   node scripts/build-mapping-mongo.mjs --dry-run   decide everything, write nothing
//   node scripts/build-mapping-mongo.mjs swift       one provider

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMongoStore } from './lib/mappingStore.mjs'
import { runMapping } from './build-mapping.mjs'
import { runMybetMapping } from './build-mybet-mapping.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = parseEnv(join(HERE, '..', '.env'))

const SPORT_URI = process.env.SPORT_MONGO_URI ?? env.SPORT_MONGO_URI
const SPORT_DB = process.env.SPORT_MONGO_DB ?? env.SPORT_MONGO_DB ?? 'gutsys_sport'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null
const only = argv.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1)
const providers = only.length ? only : ['swift', 'mybet']

if (!SPORT_URI) {
  console.error('Missing SPORT_MONGO_URI (gutsys_sport on the NAS) — set it in live-fixtures/.env')
  process.exit(1)
}

const RUNNERS = { swift: runMapping, mybet: runMybetMapping }

for (const p of providers) {
  if (!RUNNERS[p]) {
    console.error(`unknown provider "${p}" — expected swift or mybet`)
    process.exit(1)
  }
}

console.log(`=== mapping -> ${SPORT_DB} on the NAS${dryRun ? '  (DRY RUN — nothing is written)' : ''} ===\n`)

let failed = false
for (const provider of providers) {
  // A store per provider: each run closes the client it was given, and sharing
  // one would leave the second run holding a closed connection.
  const store = createMongoStore({ uri: SPORT_URI, db: SPORT_DB, dryRun })
  console.log(`--- ${provider} ---`)
  try {
    // writeSnapshot drops JSON into public/ for the live-fixtures picker. That
    // is a Supabase-side concern and this run is not it.
    const result = await RUNNERS[provider]({ store, writeSnapshot: false })
    if (dryRun) {
      const p = store.planned
      console.log(
        `  would write: ${p.competitions} competition rows, ${p.events} event rows; ` +
          `delete ${p.deletedAuto} stale auto competitions; verify ${p.verified}.`,
      )
    }
    if (result) console.log(`  ${JSON.stringify(result)}`)
    if (dryRun && outPath) {
      const f = outPath.replace(/(\.json)?$/, `.${provider}.json`)
      writeFileSync(f, JSON.stringify(store.pending, null, 1))
      console.log(`  proposed rows written to ${f}`)
    }
  } catch (e) {
    failed = true
    console.error(`  ${provider} FAILED:`, e instanceof Error ? e.stack : e)
  } finally {
    await store.close()
  }
  console.log()
}

process.exit(failed ? 1 : 0)

/** Minimal .env reader — the matchers use the same one rather than a dependency. */
function parseEnv(path) {
  try {
    const out = {}
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}
