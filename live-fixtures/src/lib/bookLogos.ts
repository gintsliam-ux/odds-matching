/**
 * Bookmaker marks for the odds grid.
 *
 * Files live in public/books/, downloaded once by scripts/fetch-book-logos.mjs
 * rather than hotlinked — a grid can render a dozen of them per fixture and a
 * book's own CDN has no business in the board's render path.
 *
 * Which books we HAVE is baked in below rather than probed at runtime: a bare
 * <img> onError fallback would still fire a request per missing book on every
 * render, and the set only changes when the script is re-run.
 */

/** Brand key: parentheticals dropped, so "Betano (Greece)", "Ladbrokes
 *  (Australia)" and "Betfair Exchange (Australia) (Lay)" share one mark. */
export function bookKey(name: string): string {
  return name.replace(/\([^)]*\)/g, '').trim().toLowerCase()
}

function bookSlug(name: string): string {
  return bookKey(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Slugs present in public/books/. Keep in step with the fetch script's output. */
const HAVE = new Set([
  '1xbet', '888sport', 'batery', 'bc-game', 'bet105', 'bet365', 'betano', 'betdex', 'betfair',
  'betfair-exchange', 'betmgm', 'betonline', 'betplay', 'betrivers', 'betsafe', 'betsson',
  'betway', 'bodog', 'bovada', 'bwin', 'caesars', 'casumo', 'coolbet', 'dafabet', 'danske-spil',
  'desert-diamond', 'draftkings', 'duel', 'fanatics', 'fanduel', 'fonbet', 'four-winds',
  'galera-bet', 'heritage', 'jazz-sports', 'jugabet', 'kalshi', 'ladbrokes', 'midnite', 'neds',
  'ninja-casino', 'opticodds-ai', 'ozoon', 'parimatch', 'pinnacle', 'polymarket', 'proline',
  'rivalry', 'rizk', 'rushbet', 'saba-sports', 'sbobet', 'sportingbet', 'sports-interaction',
  'sportsbet', 'sportsbetting-ag', 'sportzino', 'stake', 'sugarhouse', 'superbet', 'tabtouch',
  'thescore', 'twinspires', 'unibet', 'william-hill', 'world-sports-betting',
])

/** URL of the book's mark, or null when we don't have one (caller shows text). */
export function bookLogo(name: string | null | undefined): string | null {
  if (!name) return null
  const slug = bookSlug(name)
  return HAVE.has(slug) ? `/books/${slug}.png` : null
}
