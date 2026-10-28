/**
 * Loading states shaped like the thing that is coming.
 *
 * The board used to say "Loading events…" in the middle of an empty rail, which
 * tells you nothing about how much is on its way and makes the layout jump when
 * it lands. These stand in at the real dimensions, so the page arrives in place
 * instead of assembling itself in front of you.
 */

/** A single shimmering block. Everything below is built out of these. */
export function Bone({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded bg-white/[0.06] ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/10 to-transparent motion-reduce:hidden" />
    </div>
  );
}

/** Deterministic width variation — real names aren't all the same length. */
const widths = ['w-3/5', 'w-4/5', 'w-2/3', 'w-3/4', 'w-1/2', 'w-5/6'];

/** Rail rows: league badge, two lines of text, a countdown pill. */
export function RailSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading events" className="space-y-0.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex w-full items-center gap-2.5 py-2 pl-2 pr-2">
          <Bone className="h-[30px] w-[30px] shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Bone className={`h-3.5 ${widths[i % widths.length]}`} />
            <Bone className="h-2.5 w-2/5" />
          </div>
          <Bone className="h-5 w-11 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** Ticker cells at the real 132px width, so the strip doesn't resize on load. */
export function TickerSkeleton({ cells = 10 }: { cells?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading fixtures"
      className="flex shrink-0 overflow-hidden border-b border-surface-border bg-surface"
    >
      {Array.from({ length: cells }, (_, i) => (
        <div
          key={i}
          className="flex w-[132px] shrink-0 flex-col gap-1.5 border-r border-surface-border px-3 py-2"
        >
          <div className="flex items-center justify-between">
            <Bone className="h-3.5 w-3.5 rounded-full" />
            <Bone className="h-2.5 w-8" />
          </div>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Bone className="h-3.5 w-3.5 shrink-0 rounded-full" />
                <Bone className="h-2.5 w-7" />
              </div>
              <Bone className="h-2.5 w-6" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The pinned info bar: crest, name, score, crest. */
export function DetailHeaderSkeleton() {
  return (
    <div className="shrink-0 border-b border-surface-border px-4 py-3">
      <Bone className="h-2.5 w-40" />
      <div className="mt-3 flex items-center gap-3">
        <Bone className="h-10 w-10 shrink-0 rounded-full" />
        <Bone className="h-4 w-32" />
        <Bone className="mx-2 h-6 w-14 shrink-0" />
        <Bone className="h-4 w-32" />
        <Bone className="h-10 w-10 shrink-0 rounded-full" />
      </div>
    </div>
  );
}

/**
 * The price grid: a header strip, then market blocks of a couple of rows each.
 * Sized to a typical card so the scroll container doesn't jump when odds land.
 */
export function MarketsSkeleton({ groups = 4 }: { groups?: number }) {
  return (
    <div role="status" aria-label="Loading odds" className="min-h-0 flex-1 overflow-hidden">
      <div className="flex h-14 items-center gap-4 border-b border-surface-border bg-surface-raised px-3">
        <Bone className="h-2.5 w-20" />
        <div className="ml-auto flex gap-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Bone key={i} className="h-6 w-10" />
          ))}
        </div>
      </div>
      {Array.from({ length: groups }, (_, g) => (
        <div key={g}>
          <div className="border-b border-surface-border bg-surface px-3 py-2">
            <Bone className="h-3 w-28" />
          </div>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-4 border-b border-surface-border px-3 py-2.5">
              <Bone className={`h-3 ${row ? 'w-28' : 'w-36'}`} />
              <div className="ml-auto flex gap-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Bone key={i} className="h-4 w-10" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The whole right-hand pane, for a fixture we don't hold yet (a deep link). */
export function EventPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeaderSkeleton />
      <MarketsSkeleton />
    </div>
  );
}

/**
 * A list page's rows, at the dimensions the real ones take.
 *
 * Movers, Settlement and Late Bets all draw the same shape — a leading figure,
 * a name, some trailing numbers — and all three used to say "Reading the price
 * ladder…" in the middle of an empty page. A sentence tells you nothing about
 * how much is coming and the layout jumps when it lands.
 *
 * `lead` is the width of the figure each page puts first: the move, the wait,
 * how late the bet was.
 */
export function RowsSkeleton({ rows = 12, lead = 'w-16' }: { rows?: number; lead?: string }) {
  return (
    <div role="status" aria-label="Loading" className="min-h-0 flex-1 overflow-hidden">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-surface-border px-3 py-2.5">
          <Bone className={`h-4 shrink-0 ${lead}`} />
          <Bone className="h-3.5 w-14 shrink-0" />
          <Bone className={`h-3.5 ${widths[i % widths.length]}`} />
          <Bone className="ml-auto h-3.5 w-20 shrink-0" />
          <Bone className="h-3.5 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** The filter bar under a page header, so the chips do not pop in. */
export function ChipsSkeleton({ chips = 5 }: { chips?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border/60 px-4 py-2">
      {Array.from({ length: chips }, (_, i) => (
        <Bone key={i} className={`h-6 rounded-md ${i === 0 ? 'w-24' : 'w-16'}`} />
      ))}
    </div>
  );
}

/**
 * The prices page: a list of hits on the left, a market grid on the right.
 *
 * Reuses MarketsSkeleton for the grid, so the two pages that draw that table
 * stand in for it identically.
 */
export function PricesSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading prices" className="flex min-h-0 flex-1">
      <aside className="w-72 shrink-0 border-r border-surface-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="border-b border-surface-border/60 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Bone className="h-[13px] w-[13px] shrink-0 rounded" />
              <Bone className="h-2.5 w-20" />
            </div>
            <Bone className={`mt-1 h-3.5 ${widths[i % widths.length]}`} />
            <Bone className="mt-1 h-2.5 w-10" />
          </div>
        ))}
      </aside>
      <main className="min-w-0 flex-1">
        <MarketsSkeleton groups={3} />
      </main>
    </div>
  );
}

/** The bet feed: a header row and then the table, at the real column widths. */
export function BetsTableSkeleton({ rows = 14, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading bets" className="min-h-0 flex-1 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-surface-border px-3 py-2">
        <Bone className="h-2.5 w-10 shrink-0" />
        <Bone className="h-2.5 w-14 shrink-0" />
        <Bone className="h-2.5 w-28" />
        {Array.from({ length: cols }, (_, i) => (
          <Bone key={i} className="h-2.5 w-12 shrink-0" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-surface-border/40 px-3 py-2">
          <Bone className="h-3 w-10 shrink-0" />
          <Bone className="h-3 w-14 shrink-0" />
          <Bone className={`h-3.5 ${widths[i % widths.length]}`} />
          {Array.from({ length: cols }, (_, j) => (
            <Bone key={j} className="h-3 w-12 shrink-0" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The box score: the status line, then a table per team at the real widths.
 *
 * Both of the Stats tab's states used to be a bare `h-40` block with the
 * default pulse on it — the one animation this file exists to replace, and a
 * shape that tells you nothing about what is landing. A box score is two
 * tables of a dozen rows with a crest and a name on the left and six numeric
 * columns after, so that is what stands in for it.
 */
export function StatsSkeleton({ teams = 2, rows = 10, cols = 6 }: { teams?: number; rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading player stats" className="min-h-0 flex-1 overflow-hidden">
      {/* The "Final box score · updated 3m ago" line. */}
      <div className="flex items-center gap-2 border-b border-surface-border px-4 py-2">
        <Bone className="h-3 w-28" />
        <Bone className="h-3 w-20" />
      </div>
      <div className="space-y-4 p-4">
        {Array.from({ length: teams }, (_, t) => (
          <div key={t} className="overflow-hidden rounded-xl bg-surface-raised/40">
            {/* Crest, team name, side, and the player count on the right. */}
            <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2">
              <Bone className="h-[18px] w-[18px] shrink-0 rounded-full" />
              <Bone className="h-3.5 w-36" />
              <Bone className="h-2.5 w-10" />
              <Bone className="ml-auto h-2.5 w-16" />
            </div>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-3 border-t border-surface-border/40 px-3 py-1.5">
                <Bone className={`h-3.5 ${widths[(t + i) % widths.length]} max-w-[11rem]`} />
                {Array.from({ length: cols }, (_, j) => (
                  <Bone key={j} className="h-3 w-8 shrink-0" />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The stat-bets tab: a stat heading, then a card per line under it.
 *
 * Shaped like what arrives — "Points", then 15+, 20+, 25+ — rather than one
 * block, because the heights differ a lot between a market with eight bets on
 * it and one with a single bet, and a stand-in that ignores that makes the
 * page jump twice: once when it lands and once when it settles.
 */
export function StatBetsSkeleton({ families = 2, lines = 2, rows = 3 }: { families?: number; lines?: number; rows?: number }) {
  return (
    <div role="status" aria-label="Loading bets" className="space-y-5">
      {Array.from({ length: families }, (_, f) => (
        <div key={f} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <Bone className="h-3.5 w-24" />
            <Bone className="h-2.5 w-20" />
          </div>
          {Array.from({ length: lines }, (_, l) => (
            <div key={l} className="overflow-hidden rounded-xl bg-surface-raised/40">
              <div className="flex items-center gap-2 border-b border-surface-border px-3 py-1.5">
                <Bone className="h-2.5 w-10" />
                <Bone className="ml-auto h-2.5 w-24" />
              </div>
              {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="flex items-center gap-2 border-t border-surface-border/60 px-3 py-1.5">
                  {/* brand badge, selection, the stat chip, stake, price, result */}
                  <Bone className="h-4 w-12 shrink-0 rounded" />
                  <Bone className={`h-3.5 ${widths[(f + i) % widths.length]} max-w-[13rem]`} />
                  <Bone className="h-4 w-12 shrink-0 rounded" />
                  <Bone className="ml-auto h-3 w-10 shrink-0" />
                  <Bone className="h-3 w-8 shrink-0" />
                  <Bone className="h-4 w-12 shrink-0 rounded" />
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The Details tab: the Optic block, then a card per brand.
 *
 * Each card carries a heading, an id you can copy and a start time under it,
 * so the stand-in is a heading and two short lines rather than one tall
 * rectangle. The three brands are different heights in reality — a brand with
 * no mapping is a single line — and the skeleton shows the fullest case,
 * which is the one that would otherwise push the page down when it lands.
 */
export function DetailsSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div role="status" aria-label="Loading details" className="flex-1 space-y-4 p-4">
      <div className="space-y-2 rounded-xl bg-surface-raised/40 p-3">
        <Bone className="h-3 w-16" />
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2].map((i) => (
            <Bone key={i} className="h-6 w-40 rounded" />
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="space-y-2 rounded-xl bg-surface-raised/40 p-3">
            <Bone className="h-3.5 w-24" />
            <Bone className="h-6 w-full rounded" />
            <Bone className={`h-3 ${widths[i % widths.length]}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
