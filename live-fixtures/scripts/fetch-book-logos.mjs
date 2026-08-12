// Downloads a logo for each bookmaker that appears in `pregame_odds` /
// `live_bookmaker`, into public/books/<slug>.png.
//
// Committed as static assets rather than hotlinked: the odds grid renders one
// per column on every fixture, and a book's own CDN is not something to put in
// the render path of the board. It also keeps the app working offline and free
// of third-party requests at runtime.
//
// Two sources, tried in order. DuckDuckGo's icon service first: it serves the
// site's real favicon and has a mark for domains Google answers with a generic
// globe (Betfair among them). Google's is the fallback, at 128px. Books we have
// no domain for simply keep the text badge.
//
// Usage:  node scripts/fetch-book-logos.mjs           (only missing ones)
//         node scripts/fetch-book-logos.mjs --force   (re-download everything)

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'public', 'books')

/**
 * Book name → domain.
 *
 * Keys are the NORMALISED name (see slug()), so regional and Lay variants of
 * one brand share an entry: "Ladbrokes (Australia)", "Betfair Exchange
 * (Australia) (Lay)" and "Betfair Exchange" all collapse onto the parent.
 */
const DOMAINS = {
  pinnacle: 'pinnacle.com',
  bet365: 'bet365.com',
  sportsbet: 'sportsbet.com.au',
  ladbrokes: 'ladbrokes.com.au',
  fanduel: 'fanduel.com',
  draftkings: 'draftkings.com',
  fanatics: 'sportsbook.fanatics.com',
  betano: 'betano.com',
  '1xbet': '1xbet.com',
  unibet: 'unibet.com',
  tabtouch: 'tabtouch.com.au',
  'william hill': 'williamhill.com',
  betway: 'betway.com',
  polymarket: 'polymarket.com',
  kalshi: 'kalshi.com',
  sportingbet: 'sportingbet.com.au',
  sportzino: 'sportzino.com',
  betsafe: 'betsafe.com',
  'betfair exchange': 'betfair.com.au',
  betfair: 'betfair.com.au',
  dafabet: 'dafabet.com',
  'sports interaction': 'sportsinteraction.com',
  caesars: 'caesars.com',
  rizk: 'rizk.com',
  'bc.game': 'bc.game',
  twinspires: 'twinspires.com',
  bwin: 'bwin.com',
  betsson: 'betsson.com',
  rivalry: 'rivalry.com',
  sugarhouse: 'playsugarhouse.com',
  ibet: 'ibet.com.au',
  'saba sports': 'sabasports.com',
  neds: 'neds.com.au',
  '888sport': '888sport.com',
  casumo: 'casumo.com',
  bodog: 'bodog.eu',
  bovada: 'bovada.lv',
  betmgm: 'betmgm.com',
  parimatch: 'parimatch.com',
  'sportsbetting.ag': 'sportsbetting.ag',
  stake: 'stake.com',
  superbet: 'superbet.com',
  fonbet: 'fonbet.ru',
  betplay: 'betplay.com.co',
  coolbet: 'coolbet.com',
  'ninja casino': 'ninjacasino.com',
  lowvig: 'lowvig.ag',
  betonline: 'betonline.ag',
  thescore: 'thescore.bet',
  sbobet: 'sbobet.com',
  batery: 'batery.bet',
  midnite: 'midnite.com',
  betrivers: 'betrivers.com',
  'world sports betting': 'worldsportsbetting.co.za',
  'danske spil': 'danskespil.dk',
  'galera.bet': 'galera.bet',
  proline: 'proline.ca',
  rushbet: 'rushbet.co',
  heritage: 'heritagesports.eu',
  'jazz sports': 'jazzsports.ag',
  'desert diamond': 'ddcaz.com',
  'four winds': 'fourwindscasino.com',
  'opticodds ai': 'opticodds.com',
  bet105: 'bet105.com',
  betdex: 'betdex.com',
  jugabet: 'jugabet.cl',
  duel: 'duel.com',
  ozoon: 'ozoon.com',
}

/**
 * Normalise a feed book name to its brand key.
 *
 * The feed distinguishes regions and bet sides — "Betano (Greece)", "Betfair
 * Exchange (Australia) (Lay)" — which are the same brand wearing the same
 * logo, so every parenthetical is stripped.
 */
export function bookKey(name) {
  return String(name ?? '')
    .replace(/\([^)]*\)/g, '')
    .trim()
    .toLowerCase()
}

/** Filename-safe form of the brand key. */
export function bookSlug(name) {
  return bookKey(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** PNG / JPEG / GIF / WebP / ICO by signature, or null if it isn't an image. */
function imageKind(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01) return 'ico'
  return null
}

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
        }),
    )
  } catch {
    return {}
  }
}

async function booksInUse() {
  const env = parseEnv(join(HERE, '..', '.env'))
  const url = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  const H = { apikey: key, Authorization: `Bearer ${key}` }
  const seen = new Set()
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${url}/rest/v1/live_fixtures?select=pregame_odds,live_bookmaker&pregame_odds=not.is.null&order=scheduled_start.desc&offset=${from}&limit=1000`,
      { headers: H },
    )
    const rows = await res.json()
    if (!Array.isArray(rows) || !rows.length) break
    for (const r of rows) {
      for (const blk of Object.values(r.pregame_odds ?? {}))
        for (const k of Object.keys(blk ?? {})) if (k !== 'line') seen.add(k)
      if (r.live_bookmaker) seen.add(r.live_bookmaker)
    }
    if (rows.length < 1000) break
  }
  return [...seen]
}

async function main() {
  const force = process.argv.includes('--force')
  mkdirSync(OUT, { recursive: true })
  const books = await booksInUse()

  // Collapse regional variants: one file per brand, not per feed name.
  const brands = new Map()
  for (const b of books) {
    const key = bookKey(b)
    if (!brands.has(key)) brands.set(key, b)
  }

  let saved = 0
  let skipped = 0
  const missing = []
  for (const [key, example] of [...brands].sort()) {
    const domain = DOMAINS[key]
    if (!domain) {
      missing.push(example)
      continue
    }
    const file = join(OUT, `${bookSlug(example)}.png`)
    if (!force && existsSync(file)) {
      skipped++
      continue
    }
    const sources = [
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
    ]
    try {
      let buf = null
      let lastErr = 'no source answered'
      for (const url of sources) {
        try {
          const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const b = Buffer.from(await res.arrayBuffer())
          if (!imageKind(b)) throw new Error(`not an image (${b.length}b)`)
          // DuckDuckGo returns a 1x1 or tiny stub for domains it doesn't know.
          if (b.length < 200) throw new Error(`stub (${b.length}b)`)
          buf = b
          break
        } catch (e) {
          lastErr = e.message
        }
      }
      if (!buf) throw new Error(lastErr)
      // Magic bytes are checked per-source above, not by size: once this
      // script has made a few dozen requests Google starts answering with an
      // HTML error page about the size of a small icon, and a length-only
      // check writes that to disk as a .png.
      const kind = imageKind(buf)
      writeFileSync(file, buf)
      saved++
      console.log(`  ${String(buf.length).padStart(6)}b  ${kind.padEnd(4)} ${bookSlug(example)}.png  (${domain})`)
    } catch (e) {
      missing.push(`${example} — ${e.message}`)
    }
  }
  console.log(`\nsaved ${saved}, already had ${skipped}, no logo for ${missing.length}`)
  for (const m of missing) console.log(`   · ${m}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
