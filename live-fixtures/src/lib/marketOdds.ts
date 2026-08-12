/**
 * Normalising `pregame_odds` / `flucs`, which carry a book's prices in two
 * different shapes.
 *
 * OLD — one line per book, flat:
 *     { "Pinnacle": { line: 7.5, over: 1.97, under: 1.85 } }
 *     { "Pinnacle": { home: 1.85, away: 1.97 } }            // h2h, no line
 *
 * NEW (written since 2026-08-11) — the full alternate-lines ladder, keyed by
 * the line itself, with the primary one flagged:
 *     { "Sportsbet": { "171.5": { main: true,  over: 1.90, under: 1.87 },
 *                      "120.5": { main: false, under: 34 }, … } }   // 108 lines
 *
 * Both are live in the table — h2h is always flat, while total and spread are
 * mixed — so the UI reads through here rather than either shape directly.
 * Reading the old shape's keys against the new one is what left the Spread and
 * Total cards showing a column per book and a dash in every cell.
 */

/** One side's prices at a single line. Which keys are set depends on market. */
export interface SidePrices {
  home?: number | null
  away?: number | null
  draw?: number | null
  over?: number | null
  under?: number | null
}

export interface BookLine {
  /** null for a market with no line at all (h2h). */
  line: number | null
  prices: SidePrices
  /** The book's primary line — the one it leads with. */
  main: boolean
}

export interface BookOdds {
  book: string
  /** Every line this book quotes, ascending. */
  lines: BookLine[]
  /** The primary line, or null when the market has none. */
  mainLine: number | null
  /** Prices at the primary line — what the headline grid shows. */
  mainPrices: SidePrices
}

const SIDE_KEYS = ['home', 'away', 'draw', 'over', 'under'] as const

const isLineKey = (k: string) => /^-?\d+(\.\d+)?$/.test(k)
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function sidesOf(v: Record<string, unknown>): SidePrices {
  const out: SidePrices = {}
  for (const k of SIDE_KEYS) {
    const n = num(v[k])
    if (n != null) out[k] = n
  }
  return out
}

const priced = (p: SidePrices) => SIDE_KEYS.some((k) => p[k] != null)

/**
 * Which line is the book's primary one when nothing is flagged `main`?
 *
 * 47 of 801 nested books carry no flag. The main line is the balanced one — the
 * two sides priced closest to each other — so pick the two-sided line with the
 * smallest gap. Falling back to "the first key" would have picked a 34.00
 * long-shot under as the headline price.
 */
function inferMain(lines: BookLine[]): BookLine | null {
  const twoSided = lines.filter((l) => {
    const p = l.prices
    return (p.over != null && p.under != null) || (p.home != null && p.away != null)
  })
  const pool = twoSided.length ? twoSided : lines
  if (!pool.length) return null
  return pool.reduce((best, l) => {
    const gap = (x: BookLine) => {
      const p = x.prices
      const a = p.over ?? p.home
      const b = p.under ?? p.away
      return a != null && b != null ? Math.abs(a - b) : Infinity
    }
    return gap(l) < gap(best) ? l : best
  })
}

/**
 * A spread's two sides live under OPPOSITE keys.
 *
 * The key is the handicap of whichever side it prices, so the single market
 * "Fremantle -22.5 / Adelaide +22.5" is written as
 *     "-22.5": { home: 1.91 }      ← home giving 22.5
 *      "22.5": { away: 1.91 }      ← away receiving 22.5
 * and one key can carry both sides, each belonging to a DIFFERENT market:
 *      "22.5": { away: 1.90, home: 1.06 }   ← away +22.5, and home +22.5
 *
 * So a spread line is indexed by the HOME handicap H: the home price comes from
 * key H and the away price from key -H. Treating each raw key as its own line
 * (which is what "group by key" does) shows one side of each market and calls
 * a 1.06 chalk price the headline.
 */
function pairSpreadLines(byKey: Map<number, { prices: SidePrices; main: boolean }>): BookLine[] {
  const homeHandicaps = new Set<number>()
  for (const [k, v] of byKey) {
    if (v.prices.home != null) homeHandicaps.add(k)
    if (v.prices.away != null) homeHandicaps.add(-k)
  }
  const out: BookLine[] = []
  for (const h of homeHandicaps) {
    const home = byKey.get(h)?.prices.home ?? null
    const away = byKey.get(-h)?.prices.away ?? null
    if (home == null && away == null) continue
    const prices: SidePrices = {}
    if (home != null) prices.home = home
    if (away != null) prices.away = away
    // Flagged if either contributing key was flagged for the side it gave us.
    const main =
      (home != null && byKey.get(h)?.main === true) || (away != null && byKey.get(-h)?.main === true)
    out.push({ line: h, prices, main })
  }
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

/**
 * Normalise one market block (`pregame_odds.total`, a fluc snapshot, …).
 *
 * `kind` matters only for the nested shape: a spread pairs its sides across
 * opposite keys, while a total keeps over and under on the one key.
 */
export function normaliseMarket(
  block: Record<string, unknown> | undefined | null,
  kind: 'h2h' | 'spread' | 'total' = 'total',
): BookOdds[] {
  if (!block) return []
  // A market-level `line` sits alongside the books in the old shape and is the
  // fallback for a book that doesn't carry its own.
  const marketLine = num((block as { line?: unknown }).line)
  const out: BookOdds[] = []

  for (const [book, raw] of Object.entries(block)) {
    // `at` is a fluc snapshot's timestamp, `line` the market-level fallback —
    // neither is a bookmaker.
    if (book === 'line' || book === 'at') continue
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const v = raw as Record<string, unknown>
    const keys = Object.keys(v)
    const nested = keys.length > 0 && keys.every(isLineKey)

    let lines: BookLine[]
    if (nested) {
      const byKey = new Map<number, { prices: SidePrices; main: boolean }>()
      for (const k of keys) {
        const at = v[k] as Record<string, unknown>
        const prices = sidesOf(at)
        if (priced(prices)) byKey.set(Number(k), { prices, main: at?.main === true })
      }
      lines =
        kind === 'spread'
          ? pairSpreadLines(byKey)
          : [...byKey.entries()]
              .map(([line, e]) => ({ line, prices: e.prices, main: e.main }))
              .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    } else {
      const prices = sidesOf(v)
      if (!priced(prices)) continue
      lines = [{ line: num(v.line) ?? marketLine, prices, main: true }]
    }
    if (!lines.length) continue

    // More than one line can end up flagged (a shared key contributes to two
    // markets), so choose among the flagged ones by balance — the real main
    // line is the one priced near even, not a 1.06 chalk.
    const flaggedAll = lines.filter((l) => l.main)
    const flagged =
      flaggedAll.length > 1 ? inferMain(flaggedAll) : (flaggedAll[0] ?? inferMain(lines))
    // Re-flag so `main` is meaningful downstream even when the feed omitted it.
    for (const l of lines) l.main = l === flagged
    out.push({
      book,
      lines,
      mainLine: flagged?.line ?? null,
      mainPrices: flagged?.prices ?? {},
    })
  }
  return out
}

/** Every distinct line across all books, ascending — the ladder's rows. */
export function allLines(books: BookOdds[]): number[] {
  const set = new Set<number>()
  for (const b of books) for (const l of b.lines) if (l.line != null) set.add(l.line)
  return [...set].sort((a, b) => a - b)
}

/** Prices a book quotes at a specific line, if it quotes that line at all. */
export function pricesAt(book: BookOdds, line: number | null): SidePrices | null {
  return book.lines.find((l) => l.line === line)?.prices ?? null
}

/**
 * Flatten a market's flucs to the main line at each stage, so the movement view
 * can plot one series per book.
 *
 * A nested snapshot holds the whole ladder — `{ at, "170.5": { over, under } }`
 * — and plotting every rung would be unreadable. The main line is the one worth
 * following, and it is re-derived per stage so a book that MOVES its line still
 * charts (its 170.5 becoming 171.5 shows up as the line column changing).
 */
export function normaliseFlucs(
  marketFlucs: Record<string, Record<string, unknown>> | undefined,
  kind: 'h2h' | 'spread' | 'total',
): Record<string, Record<string, SidePrices & { at?: string | null; line?: number | null }>> {
  const out: Record<string, Record<string, SidePrices & { at?: string | null; line?: number | null }>> = {}
  for (const [book, byStage] of Object.entries(marketFlucs ?? {})) {
    if (!byStage || typeof byStage !== 'object') continue
    for (const [stage, raw] of Object.entries(byStage as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      // The daily stage is an ARRAY of snapshots, one per day it was captured:
      //   "9am": [{ at, date: "2026-08-12", home, away }, …]
      // Expand each day into its own stage so a week of 9am captures becomes a
      // week of columns rather than collapsing to one.
      const entries: Array<[string, Record<string, unknown>]> = Array.isArray(raw)
        ? raw
            .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
            .map((e) => [
              typeof e.date === 'string' ? `${stage} ${String(e.date).slice(5)}` : stage,
              e,
            ])
        : [[stage, raw as Record<string, unknown>]]
      for (const [stageKey, s] of entries) {
      // Normalise the snapshot as a one-book market so both shapes flow through
      // the same pairing/main-line logic.
        const [norm] = normaliseMarket({ [book]: s }, kind)
        if (!norm) continue
        ;(out[book] ??= {})[stageKey] = {
          ...norm.mainPrices,
          line: norm.mainLine,
          at: typeof s.at === 'string' ? s.at : null,
        }
      }
    }
  }
  return out
}
