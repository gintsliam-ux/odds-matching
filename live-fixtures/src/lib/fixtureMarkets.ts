/**
 * A fixture's markets, read from the Odds Library (`odds` + `odds_sp`).
 *
 * This replaces reading `live_fixtures.pregame_odds` / `.flucs`, which packed
 * every book and every line into nested jsonb that had to be unpicked by shape
 * (see marketOdds.ts). `odds` is already one row per
 * (market, selection, line, book, live) — so grouping replaces parsing, and the
 * heuristics that guessed which line was the main one, or paired a spread's two
 * sides across opposite keys, become a `pair_key` groupBy and an `is_main` flag.
 *
 * It also carries markets the old jsonb never had. `pregame_odds` held exactly
 * three blocks — h2h, spread, total — while `odds` carries the period markets
 * too (1st half, 1st quarter, 1st innings, 1st set) plus BTTS, draw-no-bet,
 * double chance and Asian lines. That is why a fixture could show "2 markets"
 * on a page whose feed held twenty-odd.
 */

import { getSupabase } from './supabase'
import type { BookLine, BookOdds, SidePrices } from './marketOdds'

/** `pair_key` for a market with no line at all (moneyline). Not a real line. */
const NO_LINE = -99999

/** PostgREST caps a response at 1000 rows; a big AFL fixture carries 2000+. */
const PAGE = 1000

/** Stop paging runaway fixtures. 8k rows is far beyond any real market set. */
const MAX_ROWS = 8000

export type MarketKind = 'moneyline' | 'spread' | 'total'

/** Columns we actually read. `flucs` (the raw array) is deliberately NOT
 *  selected — the stage columns below cover the movement view, and the array is
 *  by far the heaviest field on a table where one fixture can return 2000 rows. */
const COLUMNS = [
  'market_id',
  'market_name',
  'selection',
  'normalized_selection',
  'outcome_no',
  'line',
  'pair_key',
  'is_main',
  'is_live',
  'sportsbook',
  'status',
  'open_price',
  'open_at',
  'current_price',
  'current_at',
  'close_price',
  'closed_at',
  'price_6h',
  'price_3h',
  'price_1h',
  'price_30m',
  'price_10m',
  'daily_prices',
].join(',')

interface OddsRow {
  market_id: string
  market_name: string | null
  selection: string | null
  normalized_selection: string | null
  outcome_no: number | null
  line: number | null
  pair_key: number | null
  is_main: boolean | null
  is_live: boolean | null
  sportsbook: string
  status: string | null
  open_price: number | null
  open_at: string | null
  current_price: number | null
  current_at: string | null
  close_price: number | null
  closed_at: string | null
  price_6h: number | null
  price_3h: number | null
  price_1h: number | null
  price_30m: number | null
  price_10m: number | null
  /** Written `{}` rather than null — zero nulls across all 1.2M rows. */
  daily_prices: Record<string, number>
}

export interface FlucSnap extends SidePrices {
  at?: string | null
  line?: number | null
}

export interface MarketGroup {
  /** Canonical id — `spread`, `1h_total`. Unique per fixture. */
  marketId: string
  /** Sport-specific label from the feed: "Total Points", "Total Goals". */
  title: string
  /** Which slice of the game: "Full game", "1st half", … */
  period: string
  kind: MarketKind
  /** Outcome keys in display order, with the labels to show. */
  outcomes: Array<{ key: string; label: string }>
  /** Pregame prices, one entry per book. */
  pregame: BookOdds[]
  /** In-play prices, one entry per book. Usually far fewer books. */
  live: BookOdds[]
  /** The line the live market sits on, if any. */
  liveLine: number | null
  /** Live price per outcome key, best across books quoting in-play. */
  livePrices: Record<string, number | null>
  /** book → stage → snapshot, for the movement view. */
  flucs: Record<string, Record<string, FlucSnap>>
  /** Newest price timestamp anywhere in this market. */
  lastPriced: string | null
  /** Books that have suspended this market rather than priced it. */
  suspended: string[]
  /**
   * Vig-stripped fair price, keyed `outcome|line` (line `null` when the market
   * has none) — see fairKey. Comes from `odds_sp.fair_blend`, so it is a real
   * cross-book consensus rather than one book's price with its own margin
   * divided out.
   */
  fair: Record<string, number>
}

/** Key into MarketGroup.fair. `line` is the market's `pair_key` — the value
 *  both sides of a handicap share — so a lookup names one market and not one
 *  side of it. */
export function fairKey(outcome: string, line: number | null): string {
  return `${outcome}|${line ?? 'none'}`
}

/* ------------------------------------------------------------------ *
 * Market vocabulary
 * ------------------------------------------------------------------ */

/** Period prefix → label. Order here is the order cards render in. */
const PERIODS: Array<[string, string]> = [
  ['', 'Full game'],
  ['1h_', '1st half'],
  ['1q_', '1st quarter'],
  ['1s_', '1st set'],
  ['1inn_', '1st innings'],
]

/**
 * Which of the three table layouts a market uses.
 *
 * Everything two-or-three-sided without a line reads as a moneyline grid; a
 * handicap reads as a spread ladder; an over/under as a total ladder. BTTS,
 * draw-no-bet and double chance are moneyline-shaped — named outcomes, no line
 * — so they reuse that layout rather than needing one of their own.
 */
function kindOf(marketId: string): MarketKind {
  const base = marketId.replace(/^(1h|1q|1s|1inn)_/, '')
  if (base.includes('spread')) return 'spread'
  if (base.includes('total')) return 'total'
  return 'moneyline'
}

function periodOf(marketId: string): string {
  for (const [prefix, label] of PERIODS) {
    if (prefix && marketId.startsWith(prefix)) return label
  }
  return 'Full game'
}

/** Rank for card ordering: full game first, then by period, then by market. */
const MARKET_RANK: Record<string, number> = {
  moneyline: 0,
  spread: 1,
  total: 2,
  asian_total: 3,
  dnb: 4,
  double_chance: 5,
  btts: 6,
  total_sets: 7,
  set_spread: 8,
}

function rankOf(marketId: string): number {
  const periodIdx = PERIODS.findIndex(
    ([prefix]) => prefix && marketId.startsWith(prefix),
  )
  const base = marketId.replace(/^(1h|1q|1s|1inn)_/, '')
  // Unknown markets sort after known ones rather than colliding at 0.
  return (periodIdx < 0 ? 0 : periodIdx) * 100 + (MARKET_RANK[base] ?? 50)
}

/**
 * Fallback title when the feed leaves `market_name` null.
 *
 * `market_name` is populated on most rows but not all, and a card headed
 * "1h_asian_total" is not something to ship.
 */
const FALLBACK_TITLE: Record<string, string> = {
  moneyline: 'Head to Head',
  spread: 'Spread',
  total: 'Total',
  asian_total: 'Asian Total',
  dnb: 'Draw No Bet',
  double_chance: 'Double Chance',
  btts: 'Both Teams to Score',
  total_sets: 'Total Sets',
  set_spread: 'Set Spread',
  outright: 'Outright',
}

/** Words that make a string look like a market label rather than something
 *  else that leaked into the column. */
const MARKET_WORDS =
  /(spread|total|handicap|moneyline|line|chance|bet|score|sets?|games?|goals?|points?|runs?|innings?)/i

/**
 * A market's display title.
 *
 * `market_name` is worth using where it exists because it carries the sport's
 * own noun — "Total Goals" for soccer against "Total Runs" for baseball, which
 * the canonical id cannot express. But it arrives in three formats: Title Case
 * ("1st Half Point Spread"), snake_case ("1st_half_point_spread"), and
 * occasionally a value that is not a market name at all ("tab" — a bookmaker
 * in the wrong column). So it is normalised and then sanity-checked, falling
 * back to the canonical label when it does not look like a market.
 */
function titleOf(marketId: string, marketName: string | null): string {
  const base = marketId.replace(/^(1h|1q|1s|1inn)_/, '')
  const fallback = FALLBACK_TITLE[base] ?? base.replace(/_/g, ' ')

  if (!marketName || !marketName.trim()) return fallback
  const titled = marketName
    .trim()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  // The feed already qualifies the period ("1st Half Point Spread") and the
  // card sits under a period heading, so drop the redundant prefix.
  const stripped = titled.replace(/^1st (Half|Quarter|Set|Innings?|Inning) /i, '').trim()
  return MARKET_WORDS.test(stripped) ? stripped : fallback
}

/* ------------------------------------------------------------------ *
 * Outcome naming
 * ------------------------------------------------------------------ */

/**
 * Which SidePrices key a row's selection maps to.
 *
 * `normalized_selection` is the canonical one — home/away/draw for a two- or
 * three-way, over/under for a line, yes/no for BTTS. Double chance uses
 * compound keys (home_draw), which have no SidePrices slot; those markets are
 * handled by naming their outcomes directly off the distinct keys present.
 */
const isDoubleChance = (marketId: string) =>
  marketId.replace(/^(1h|1q|1s|1inn)_/, '') === 'double_chance'

/**
 * Double chance's three outcomes onto the three price slots.
 *
 * They are combinations rather than sides, so there is no natural slot for
 * them; the mapping just has to be consistent between the price grid and the
 * outcome labels, which both read it from here.
 */
const DOUBLE_CHANCE_SLOT: Record<string, keyof SidePrices> = {
  home_draw: 'home',
  draw_away: 'away',
  home_away: 'draw',
}

/** Loose slug for comparing a selection against a team name: "Fremantle" and
 *  "fremantle_dockers" should match. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/**
 * Work out which side of the market a row prices.
 *
 * `normalized_selection` is canonical on `odds` (98%) but not on `odds_sp`,
 * where it is frequently null, wrongly cased ("Over"), or the raw team name
 * ("San Francisco 49ers", "fremantle_dockers"). So it is tried first, then
 * `outcome_no` (1 = home/over, 2 = away/under, 3 = draw), then the team names.
 * Without this the fair column resolved on a minority of rows, and the markets
 * whose selections are team slugs were dropped from the grid entirely.
 */
function sideOf(
  normalized: string | null,
  selection: string | null,
  outcomeNo: number | null,
  kind: MarketKind,
  homeName: string,
  awayName: string,
  marketId = '',
): keyof SidePrices | null {
  const lower = (normalized ?? '').toLowerCase()

  // Double chance numbers its outcomes 1 = home-or-draw, 2 = draw-or-away,
  // 3 = home-or-away — NOT the home/away/draw the other markets use. Reading
  // it with the general rule would file "draw or away" under `away` and quote
  // a double chance price as if it were the outright away price.
  if (isDoubleChance(marketId)) {
    const byName = DOUBLE_CHANCE_SLOT[lower]
    if (byName) return byName
    return outcomeNo === 1 ? 'home' : outcomeNo === 2 ? 'away' : outcomeNo === 3 ? 'draw' : null
  }

  const direct = SIDE_OF[lower]
  if (direct) return direct

  // Some totals bake the line into the selection — `over_2_5`, `under_3` — and
  // those rows are exactly the ones that carry no outcome_no, so the numeric
  // fallback below cannot catch them.
  if (/^over(_|$)/.test(lower)) return 'over'
  if (/^under(_|$)/.test(lower)) return 'under'

  if (outcomeNo === 1) return kind === 'total' ? 'over' : 'home'
  if (outcomeNo === 2) return kind === 'total' ? 'under' : 'away'
  if (outcomeNo === 3) return 'draw'

  const cand = slug(normalized || selection || '')
  if (!cand) return null
  const h = slug(homeName)
  const a = slug(awayName)
  // Longest-match first so "Manchester United" cannot claim a row that names
  // "Manchester City" merely by sharing a prefix.
  const hHit = h && (cand === h || cand.startsWith(`${h}_`) || h.startsWith(`${cand}_`))
  const aHit = a && (cand === a || cand.startsWith(`${a}_`) || a.startsWith(`${cand}_`))
  if (hHit && !aHit) return 'home'
  if (aHit && !hHit) return 'away'
  return null
}

const SIDE_OF: Record<string, keyof SidePrices> = {
  home: 'home',
  away: 'away',
  draw: 'draw',
  over: 'over',
  under: 'under',
  // BTTS and other binaries reuse the two-sided slots so the grid, the best
  // price and the overround all work with no special-casing downstream.
  yes: 'home',
  no: 'away',
}

/**
 * Outcome keys and labels for a market, in display order.
 *
 * Anything outside the canonical vocabulary (double chance's compound keys, a
 * cricket team name) is passed through as its own outcome, labelled from the
 * feed's `selection` text so it reads properly.
 */
function outcomesFor(
  marketId: string,
  rows: OddsRow[],
  homeName: string,
  awayName: string,
): Array<{ key: string; label: string }> {
  const kind = kindOf(marketId)
  const present = new Set(
    rows.map((r) => r.normalized_selection).filter((s): s is string => !!s),
  )

  // Double chance shares the home/away/draw slots but means combinations, so
  // it names them itself rather than falling through to the team names.
  if (isDoubleChance(marketId)) {
    return [
      { key: 'home', label: `${homeName} or Draw` },
      { key: 'away', label: `Draw or ${awayName}` },
      { key: 'draw', label: `${homeName} or ${awayName}` },
    ]
  }

  if (kind === 'total') {
    return [
      { key: 'over', label: 'Over' },
      { key: 'under', label: 'Under' },
    ]
  }
  if (kind === 'spread') {
    return [
      { key: 'home', label: homeName },
      { key: 'away', label: awayName },
    ]
  }
  if (present.has('yes') || present.has('no')) {
    return [
      { key: 'home', label: 'Yes' },
      { key: 'away', label: 'No' },
    ]
  }
  if (present.has('home') || present.has('away')) {
    return [
      { key: 'home', label: homeName },
      ...(present.has('draw') ? [{ key: 'draw', label: 'Draw' }] : []),
      { key: 'away', label: awayName },
    ]
  }

  // Double chance and anything else named: one outcome per distinct selection,
  // labelled from the raw text the feed shipped.
  const labels = new Map<string, string>()
  for (const r of rows) {
    const k = r.normalized_selection
    if (k && !labels.has(k)) labels.set(k, r.selection?.trim() || k.replace(/_/g, ' / '))
  }
  return [...labels.entries()].map(([key, label]) => ({ key, label }))
}

/* ------------------------------------------------------------------ *
 * Stages
 * ------------------------------------------------------------------ */

/**
 * Capture points, oldest first, as (stage key, column, offset before start).
 *
 * The offsets matter because only open/close/current carry their own
 * timestamp. Without one, every countdown stage would sort together and the
 * movement columns would come out in arbitrary order. Deriving `at` from the
 * fixture's scheduled start puts them in the right order AND makes the column's
 * reported time honest.
 */
const STAGES: Array<{ key: string; col: keyof OddsRow; beforeMs: number | null }> = [
  { key: '6h', col: 'price_6h', beforeMs: 6 * 3_600_000 },
  { key: '3h', col: 'price_3h', beforeMs: 3 * 3_600_000 },
  { key: '1h', col: 'price_1h', beforeMs: 3_600_000 },
  { key: '30m', col: 'price_30m', beforeMs: 30 * 60_000 },
  { key: '10m', col: 'price_10m', beforeMs: 10 * 60_000 },
]

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

/** A line's total implied probability. ~1.02–1.10 for a real two-sided
 *  market; a line quoting both sides at 1.01 comes out near 1.98. */
function impliedSum(l: BookLine): number {
  const vals = Object.values(l.prices).filter((p): p is number => p != null && p > 0)
  return vals.length ? vals.reduce((s, p) => s + 1 / p, 0) : Infinity
}

/**
 * The book's headline line.
 *
 * `is_main` from the feed is the answer almost always, but not on the
 * exchanges: Betfair flags ±64.5 at 1.01/1.01 as its main AFL spread, which
 * implies 198% and is the far end of the ladder rather than the market anyone
 * is betting. So a flagged line is accepted only if it prices like a real
 * market, and otherwise the most balanced two-sided line stands in.
 */
function pickMain(lines: BookLine[]): BookLine | null {
  const twoSided = lines.filter(
    (l) => Object.values(l.prices).filter((p) => p != null).length >= 2,
  )
  const balanced =
    twoSided.length > 0
      ? twoSided.reduce((best, l) =>
          Math.abs(impliedSum(l) - 1) < Math.abs(impliedSum(best) - 1) ? l : best,
        )
      : null

  const flagged = lines.find((l) => l.main)
  if (flagged) {
    // The sanity bound only makes sense for a straight two-way market, where
    // the prices should imply a little over 100%. Markets whose outcomes
    // overlap sum higher by construction — double chance covers two of three
    // results per outcome and lands near 200% — so judging them by the same
    // number would reject every correctly-flagged line they have.
    const priced = Object.values(flagged.prices).filter((p) => p != null).length
    if (priced !== 2 || impliedSum(flagged) <= 1.5) return flagged
  }
  if (balanced) return balanced
  return flagged ?? (lines.length === 1 ? lines[0] : null)
}

/** Group rows into one BookOdds per book, lines keyed on `pair_key`. */
function toBookOdds(
  rows: OddsRow[],
  kind: MarketKind,
  home: string,
  away: string,
  marketId: string,
): BookOdds[] {
  const byBook = new Map<string, Map<number, BookLine>>()

  for (const r of rows) {
    const price = num(r.current_price)
    if (price == null) continue
    const side = sideOf(r.normalized_selection, r.selection, r.outcome_no, kind, home, away, marketId)
    // A selection that resolves to no side (double chance's compound keys)
    // has no SidePrices slot; those markets render from `outcomes` instead,
    // so skip rather than mis-file the price under `home`.
    if (!side) continue

    const pk = r.pair_key ?? NO_LINE
    let lines = byBook.get(r.sportsbook)
    if (!lines) byBook.set(r.sportsbook, (lines = new Map()))

    const existing = lines.get(pk)
    if (existing) {
      existing.prices[side] = price
      if (r.is_main) existing.main = true
    } else {
      lines.set(pk, {
        // The sentinel is "no line", not a line of -99999.
        line: pk === NO_LINE ? null : pk,
        prices: { [side]: price },
        main: r.is_main === true,
      })
    }
  }

  const out: BookOdds[] = []
  for (const [book, lineMap] of byBook) {
    const lines = [...lineMap.values()].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    if (!lines.length) continue
    const main = pickMain(lines)
    for (const l of lines) l.main = l === main
    out.push({
      book,
      lines,
      mainLine: main?.line ?? null,
      mainPrices: main?.prices ?? {},
    })
  }
  return out.sort((a, b) => a.book.localeCompare(b.book))
}

/**
 * Build the movement series: book → stage → prices.
 *
 * Only the MAIN line is tracked. A book quoting 169 rungs would otherwise
 * produce an unreadable table, and the main line is the one worth following —
 * a book that moves its line shows up as the line column changing.
 */
function toFlucs(
  rows: OddsRow[],
  startMs: number | null,
  kind: MarketKind,
  home: string,
  away: string,
  marketId: string,
): Record<string, Record<string, FlucSnap>> {
  const out: Record<string, Record<string, FlucSnap>> = {}

  for (const r of rows) {
    if (!r.is_main) continue
    const side = sideOf(r.normalized_selection, r.selection, r.outcome_no, kind, home, away, marketId)
    if (!side) continue
    const book = (out[r.sportsbook] ??= {})
    const line = r.pair_key === NO_LINE ? null : r.pair_key

    const put = (stage: string, price: number | null, at: string | null) => {
      if (price == null) return
      const snap = (book[stage] ??= { at, line })
      snap[side] = price
      // Prefer a real timestamp over a derived one if any row carries it.
      if (at && !snap.at) snap.at = at
    }

    put('open', num(r.open_price), r.open_at)

    // A daily capture per day the market was open, before the countdown stages.
    for (const [date, price] of Object.entries(r.daily_prices)) {
      put(`9am ${date.slice(5)}`, num(price), `${date}T09:00:00Z`)
    }

    for (const s of STAGES) {
      const at =
        startMs != null && s.beforeMs != null
          ? new Date(startMs - s.beforeMs).toISOString()
          : null
      put(s.key, num(r[s.col] as number | null), at)
    }

    put('close', num(r.close_price), r.closed_at)
    put('current', num(r.current_price), r.current_at)
  }

  // Drop books whose series has a single point — there is no movement to show
  // and they only widen the table.
  for (const [book, stages] of Object.entries(out)) {
    if (Object.keys(stages).length < 2) delete out[book]
  }
  return out
}

/** Best (highest) price per outcome across the books quoting in-play. */
function bestLive(
  live: BookOdds[],
  outcomes: Array<{ key: string }>,
): { prices: Record<string, number | null>; line: number | null } {
  const prices: Record<string, number | null> = {}
  let line: number | null = null
  for (const o of outcomes) {
    let best: number | null = null
    for (const b of live) {
      const p = b.mainPrices[o.key as keyof SidePrices]
      if (p != null && (best == null || p > best)) {
        best = p
        line = b.mainLine
      }
    }
    prices[o.key] = best
  }
  return { prices, line }
}

/* ------------------------------------------------------------------ *
 * Fetch
 * ------------------------------------------------------------------ */

const FAIR_COLUMNS = 'market_id,selection,normalized_selection,outcome_no,line,pair_key,fair_blend'

interface FairRow {
  market_id: string
  selection: string | null
  normalized_selection: string | null
  outcome_no: number | null
  line: number | null
  pair_key: number | null
  fair_blend: number | null
}

/**
 * Read every row for a fixture, a page at a time.
 *
 * PostgREST caps a response at 1000 rows and says so only in `content-range`,
 * not as an error — so a single request on a fixture carrying 2099 rows would
 * quietly return half the ladder, and drop whichever markets happened to sort
 * last. Ordered by `id` so the pages tile without overlap or gap.
 */
async function pageAll<T>(
  sb: ReturnType<typeof getSupabase>,
  table: string,
  columns: string,
  fixtureId: string,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .eq('fixture_id', fixtureId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    // `odds_sp` is an overlay: a fixture with no settled prices is normal, and
    // a failure to read it should not take the whole Markets tab down.
    if (error) {
      if (table === 'odds_sp') return out
      throw new Error(error.message)
    }
    const page = (data ?? []) as unknown as T[]
    out.push(...page)
    if (page.length < PAGE) break
  }
  return out
}

/**
 * Resolve `odds_sp` rows into one fair price per (market, line, outcome).
 *
 * Two things make this more than a lookup.
 *
 * First, `pair_key` is populated on only about a fifth of rows, so the market a
 * row belongs to is re-derived: a spread's away side at +H belongs to the
 * home-signed market -H, which is how `odds` keys it too.
 *
 * Second, the table carries duplicates. Fremantle v Adelaide has two rows for
 * away at +23.5 — same selection, same outcome_no, same pair_key, same
 * computed_at — one priced ~1.85 (correct) and one ~1.05 (not). No column
 * separates them, so they are separated by the one property a fair set must
 * have: with the vig removed, the outcomes' probabilities sum to 1. Taking the
 * first row put a 90% and a 49% side in the same market — 139% — and printed
 * it as the "fair" price.
 */
/** A vig-stripped set's probabilities sum to 1. Tolerance covers rounding in
 *  the stored blend, not a genuinely mispriced set. */
function coherent(fairs: number[]): boolean {
  return Math.abs(fairs.reduce((s, p) => s + 1 / p, 0) - 1) <= 0.05
}

function resolveFair(
  fairRows: FairRow[],
  home: string,
  away: string,
): Map<string, Record<string, number>> {
  // market → pairKey → outcome → candidate fair prices
  const cand = new Map<string, Map<string, Map<string, number[]>>>()

  for (const r of fairRows) {
    const fair = num(r.fair_blend)
    if (fair == null || !r.market_id) continue
    const kind = kindOf(r.market_id)
    const side = sideOf(
      r.normalized_selection,
      r.selection,
      r.outcome_no,
      kind,
      home,
      away,
      r.market_id,
    )
    if (!side) continue
    // Group on `pair_key`, the same key `odds` uses, rather than re-deriving a
    // home-signed line from `line` + side. Deriving worked but keyed on the
    // wrong thing conceptually, and a fixture can carry two genuine handicaps
    // that share a `line`: Fremantle -23.5 / Adelaide +23.5 is one market
    // (pair_key -23.5) and Fremantle +23.5 / Adelaide -23.5 another
    // (pair_key +23.5), and both have rows at line 23.5. Keyed on the line
    // those collapse together and look like contradictory duplicates.
    const pk = r.pair_key == null || r.pair_key === NO_LINE ? null : r.pair_key
    const byPair = cand.get(r.market_id) ?? new Map()
    const key = pk == null ? 'none' : String(pk)
    const byOutcome = byPair.get(key) ?? new Map()
    byOutcome.set(side, [...(byOutcome.get(side) ?? []), fair])
    byPair.set(key, byOutcome)
    cand.set(r.market_id, byPair)
  }

  const out = new Map<string, Record<string, number>>()
  for (const [marketId, byPair] of cand) {
    const resolved: Record<string, number> = {}
    for (const [key, byOutcome] of byPair) {
      const sides = [...byOutcome.entries()]
      const line = key === 'none' ? null : Number(key)

      // The common case: one candidate per side, nothing to choose. Still
      // checked for coherence where there is more than one side to check
      // against — a handful of rows carry fair prices summing to 87%, which
      // is not a vig-stripped market and should not be printed as one. A lone
      // side is kept: there is nothing to validate it against, and dropping it
      // would lose coverage rather than prevent a wrong number.
      if (sides.every(([, v]) => v.length === 1)) {
        const flat = sides.map(([side, [fair]]) => [side, fair] as const)
        if (flat.length >= 2 && !coherent(flat.map(([, f]) => f))) continue
        for (const [side, fair] of flat) resolved[fairKey(side, line)] = fair
        continue
      }
      // Ambiguous: pick the combination whose implied probabilities sum
      // closest to 1. Bounded so a pathological row count cannot blow up.
      const combos = sides.reduce<number[][]>(
        (acc, [, vals]) =>
          acc.length * vals.length > 256
            ? acc
            : acc.flatMap((prefix) => vals.map((v) => [...prefix, v])),
        [[]],
      )
      let best: number[] | null = null
      let bestErr = Infinity
      for (const c of combos) {
        if (c.length !== sides.length) continue
        const err = Math.abs(c.reduce((s, p) => s + 1 / p, 0) - 1)
        if (err < bestErr) {
          bestErr = err
          best = c
        }
      }
      // A set that cannot be made to sum near 1 is not a coherent market;
      // showing no fair price beats showing a wrong one.
      if (!best || !coherent(best)) continue
      sides.forEach(([side], i) => {
        resolved[fairKey(side, line)] = best![i]
      })
    }
    out.set(marketId, resolved)
  }
  return out
}

/**
 * Every market this fixture has prices for.
 *
 * Paged, because one AFL fixture returns 2099 rows against PostgREST's 1000-row
 * cap — reading a single page would silently drop half the ladder and, worse,
 * whichever markets happened to sort last.
 */
export async function fetchFixtureMarkets(
  fixtureId: string,
  opts: { homeName: string; awayName: string; scheduledStart?: string | null },
): Promise<MarketGroup[]> {
  const sb = getSupabase()

  const [rows, fairRows] = await Promise.all([
    pageAll<OddsRow>(sb, 'odds', COLUMNS, fixtureId),
    pageAll<FairRow>(sb, 'odds_sp', FAIR_COLUMNS, fixtureId),
  ])

  if (!rows.length) return []

  const fairByMarket = resolveFair(fairRows, opts.homeName, opts.awayName)

  const startMs = opts.scheduledStart ? Date.parse(opts.scheduledStart) : NaN

  const byMarket = new Map<string, OddsRow[]>()
  for (const r of rows) {
    if (!r.market_id) continue
    const list = byMarket.get(r.market_id)
    if (list) list.push(r)
    else byMarket.set(r.market_id, [r])
  }

  const groups: MarketGroup[] = []
  for (const [marketId, marketRows] of byMarket) {
    // Outrights are a different shape entirely — dozens of named runners, no
    // two-sided grid — and golf already has a dedicated page for them.
    if (marketId === 'outright') continue

    const pregameRows = marketRows.filter((r) => !r.is_live)
    const liveRows = marketRows.filter((r) => r.is_live)

    const kind = kindOf(marketId)
    const outcomes = outcomesFor(marketId, marketRows, opts.homeName, opts.awayName)
    const pregame = toBookOdds(pregameRows, kind, opts.homeName, opts.awayName, marketId)
    const live = toBookOdds(liveRows, kind, opts.homeName, opts.awayName, marketId)
    if (!pregame.length && !live.length) continue

    const { prices: livePrices, line: liveLine } = bestLive(live, outcomes)

    const lastPriced =
      marketRows
        .map((r) => r.current_at ?? r.closed_at ?? r.open_at)
        .filter((t): t is string => typeof t === 'string' && Number.isFinite(Date.parse(t)))
        .sort()
        .at(-1) ?? null

    groups.push({
      marketId,
      title: titleOf(marketId, marketRows.find((r) => r.market_name)?.market_name ?? null),
      period: periodOf(marketId),
      kind,
      outcomes,
      pregame,
      live,
      liveLine,
      livePrices,
      flucs: toFlucs(
        pregameRows,
        Number.isFinite(startMs) ? startMs : null,
        kind,
        opts.homeName,
        opts.awayName,
        marketId,
      ),
      lastPriced,
      fair: fairByMarket.get(marketId) ?? {},
      // Only genuine suspension. `status` also carries `closed`, which every
      // row on a finished fixture holds — treating that as suspended would
      // badge every book on every completed event.
      suspended: [
        ...new Set(
          marketRows.filter((r) => r.status === 'suspended').map((r) => r.sportsbook),
        ),
      ],
    })
  }

  return groups.sort((a, b) => rankOf(a.marketId) - rankOf(b.marketId))
}

/** The periods present, in display order — used to head the card groups. */
export function periodsOf(groups: MarketGroup[]): string[] {
  const seen = new Set(groups.map((g) => g.period))
  return PERIODS.map(([, label]) => label).filter((p) => seen.has(p))
}
