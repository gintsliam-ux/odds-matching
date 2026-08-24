/**
 * Head-to-head prices for the board's odds column.
 *
 * `live_fixtures` carried the display price on the fixture row itself
 * (`live_h2h_*`, and a consensus derived from `pregame_odds`). The Odds Library
 * splits them: `fixtures` holds no prices at all, and every quote lives in
 * `odds`, one row per (market, selection, line, book, live). So the board now
 * fetches its prices alongside the fixtures rather than getting them free.
 *
 * Only the moneyline main line is read — that is all a card shows.
 */

import { getSupabase } from './supabase'

export interface CardPrice {
  home: number | null
  draw: number | null
  away: number | null
  /** True when these came from in-play rows rather than pregame. */
  live: boolean
}

/** PostgREST caps a response at 1000 rows however many ids we ask for, so the
 *  work is bounded by rows, not by fixtures. Keep chunks small enough that one
 *  chunk rarely exceeds a page: ~8 books x 3 outcomes ≈ 24 rows per fixture. */
const IDS_PER_CHUNK = 40
const PAGE = 1000
/** Chunks in flight at once. Enough to hide latency, few enough to stay a
 *  polite neighbour to the same PostgREST instance the board is using. */
const CONCURRENCY = 6

interface Row {
  fixture_id: string
  normalized_selection: string | null
  outcome_no: number | null
  current_price: number | null
  is_live: boolean | null
}

const SELECT = 'fixture_id,normalized_selection,outcome_no,current_price,is_live'

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 1 ? v : null

/** home/away/draw from the canonical selection, falling back to outcome_no
 *  (1 home, 2 away, 3 draw) for the ~1% of rows carrying a team name. */
function sideOf(r: Row): 'home' | 'away' | 'draw' | null {
  const s = (r.normalized_selection ?? '').toLowerCase()
  if (s === 'home' || s === 'away' || s === 'draw') return s
  if (r.outcome_no === 1) return 'home'
  if (r.outcome_no === 2) return 'away'
  if (r.outcome_no === 3) return 'draw'
  return null
}

async function fetchChunk(ids: string[]): Promise<Row[]> {
  const sb = getSupabase()
  const out: Row[] = []
  for (let from = 0; from < 4000; from += PAGE) {
    const { data, error } = await sb
      .from('odds')
      .select(SELECT)
      .in('fixture_id', ids)
      .eq('market_id', 'moneyline')
      .eq('is_main', true)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    // The board must still render if prices are unavailable — a missing odds
    // column is a degraded card, an exception is a blank screen.
    if (error) return out
    const page = (data ?? []) as unknown as Row[]
    out.push(...page)
    if (page.length < PAGE) break
  }
  return out
}

/**
 * Best available h2h price per fixture.
 *
 * In-play rows win outright where a fixture has them — that is the price that
 * matters while a game is running, and mixing a live price for one side with a
 * pregame price for the other would quote a market nobody can take. Within a
 * stage the best (highest) price across books is used, matching what the
 * detail page's Best column shows.
 */
export async function fetchCardOdds(fixtureIds: string[]): Promise<Map<string, CardPrice>> {
  const ids = [...new Set(fixtureIds.filter(Boolean))]
  if (!ids.length) return new Map()

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += IDS_PER_CHUNK) chunks.push(ids.slice(i, i + IDS_PER_CHUNK))

  const rows: Row[] = []
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = await Promise.all(chunks.slice(i, i + CONCURRENCY).map(fetchChunk))
    for (const r of batch) rows.push(...r)
  }

  // fixture → stage → side → best price
  const byFixture = new Map<string, { live: CardPrice; pre: CardPrice }>()
  for (const r of rows) {
    const price = num(r.current_price)
    const side = sideOf(r)
    if (price == null || !side) continue
    let e = byFixture.get(r.fixture_id)
    if (!e) {
      e = {
        live: { home: null, draw: null, away: null, live: true },
        pre: { home: null, draw: null, away: null, live: false },
      }
      byFixture.set(r.fixture_id, e)
    }
    const target = r.is_live ? e.live : e.pre
    if (target[side] == null || price > (target[side] as number)) target[side] = price
  }

  const out = new Map<string, CardPrice>()
  for (const [id, e] of byFixture) {
    const hasLive = e.live.home != null || e.live.away != null || e.live.draw != null
    out.set(id, hasLive ? e.live : e.pre)
  }
  return out
}
