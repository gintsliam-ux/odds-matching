/**
 * Bookmaker display names, from the `books` table.
 *
 * The UI carried a hand-written map of ~11 books, so anything outside it
 * rendered its raw feed key ("tabtouch") and any new book would too. The table
 * is the source of truth and already knows the names worth showing — "Betfair
 * Exchange (AU)", "TABtouch (RWWA)", "Ladbrokes (Australia)" — plus which
 * books are exchanges, which is why a Betfair lay price implies under 100%.
 *
 * Loaded once per session and read synchronously afterwards, so the render path
 * stays sync: callers get the raw key until it lands, then the real name.
 */

import { getSupabase } from './supabase'

export interface Book {
  key: string
  name: string
  region: string | null
  isExchange: boolean
}

let books = new Map<string, Book>()
let inflight: Promise<void> | null = null

/** Fire-and-forget; the table is 12 rows and never needs paging. */
export function ensureBooks(): Promise<void> {
  if (books.size) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    const { data, error } = await getSupabase()
      .from('books')
      .select('book_key,display_name,region,is_exchange')
    if (error || !data) return
    const next = new Map<string, Book>()
    for (const r of data as Array<Record<string, unknown>>) {
      const key = String(r.book_key ?? '')
      if (!key) continue
      next.set(key.toLowerCase(), {
        key,
        name: String(r.display_name ?? key),
        region: (r.region as string) ?? null,
        isExchange: r.is_exchange === true,
      })
    }
    books = next
  })()
  return inflight
}

/** Display name for a feed key, or the key itself if the table has no row. */
export function bookName(key: string | null | undefined): string {
  if (!key) return ''
  return books.get(key.toLowerCase())?.name ?? key
}

/** Exchanges quote lay prices, so their book margin reads under 100%. */
export function isExchange(key: string | null | undefined): boolean {
  return !!key && books.get(key.toLowerCase())?.isExchange === true
}
