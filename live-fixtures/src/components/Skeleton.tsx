// Shimmer placeholders shown while the first feed load is in flight.
//
// The rule these follow: a skeleton is the shape of the thing arriving, at the
// size it will arrive. Anything else swaps one layout for another and the page
// jumps — which is what the detail page did, showing a narrow card where a
// full-width three-panel layout was about to land.

function Bar({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} />
}

export function CardSkeleton() {
  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
        <Bar className="h-3 w-28" />
        <Bar className="h-3 w-10" />
      </div>
      <div className="space-y-3 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <Bar className="h-4 w-32" />
          <Bar className="h-4 w-5" />
        </div>
        <div className="flex items-center justify-between">
          <Bar className="h-4 w-24" />
          <Bar className="h-4 w-5" />
        </div>
      </div>
      <div className="flex items-center gap-1.5 px-4 pb-3">
        <Bar className="h-3 w-7 shrink-0" />
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-1.5">
          <Bar className="h-7" />
          <Bar className="h-7" />
          <Bar className="h-7" />
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-white/5 px-4 py-2">
        <Bar className="h-3 w-16" />
        <Bar className="h-3 w-12" />
      </div>
    </div>
  )
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  // Padding and section head copied from FixtureGrid — px-5 py-6 with a round
  // status dot — so the board doesn't nudge sideways when the cards land.
  return (
    <div className="px-5 py-6">
      <div className="mb-3 flex items-baseline gap-2.5">
        <span className="h-2 w-2 rounded-full bg-[var(--line)]" />
        <Bar className="h-3 w-24" />
        <Bar className="h-2.5 w-8" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: count }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

/** Shimmer rows for a generic table (mapping, drill events, etc.). */
export function TableSkeleton({
  rows = 10,
  cols = 5,
  showHeader = true,
}: {
  rows?: number
  cols?: number
  showHeader?: boolean
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[var(--line)]">
      {showHeader && (
        <div className="flex gap-3 border-b border-[var(--line)] bg-black/20 px-3 py-2">
          {Array.from({ length: cols }).map((_, i) => (
            <Bar key={i} className="h-2.5 flex-1" />
          ))}
        </div>
      )}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3 border-b border-white/5 px-3 py-3 last:border-b-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Bar key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Vertical list of shimmer rows for picker lists / dropdown candidates. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 px-2 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-1.5">
          <Bar className="h-3.5 w-3.5 rounded-sm" />
          <div className="flex-1 space-y-1.5">
            <Bar className="h-3 w-2/3" />
            <Bar className="h-2 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * An OPTIC / SWIFT / MYBET panel while its source resolves.
 *
 * Carries SourcePanel's own frame — same radius, padding and header row with a
 * label chip and a caption — so the panels beside an already-resolved one look
 * like panels rather than three bare shimmer blocks, and nothing shifts when
 * they fill in. `tone` paints the source's accent border when we know which
 * source is coming.
 */
export function PanelSkeleton({
  fields = 8,
  tone = 'bg-[var(--panel)]',
}: {
  fields?: number
  tone?: string
}) {
  return (
    <div className={`rounded-lg ${tone} px-4 py-3.5`}>
      <div className="mb-3 flex items-center justify-between">
        <Bar className="h-[18px] w-14 rounded" />
        <Bar className="h-2.5 w-20" />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Bar className="h-2 w-16" />
            <Bar className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The fixture/golf detail page while its row is in flight.
 *
 * Mirrors the page as it now stands: a centred scoreboard header, the tab strip
 * with Markets first, and the markets grid — which is what the page opens on.
 * It used to mirror the OLD layout (a league strip, two stacked competitor
 * rows, a kickoff strip, four stat cards and three source panels); the kickoff
 * strip and stat cards no longer exist and Details is no longer the default
 * tab, so every load swapped one layout for a different one.
 */
export function DetailSkeleton({ fullWidth = false }: {
  /** The golf page is full-bleed where the fixture page caps at 1700px; match
   *  whichever is about to render, or the swap still shifts the layout. */
  fullWidth?: boolean
}) {
  return (
    <div className={`flex h-full flex-col px-5 py-5 ${fullWidth ? '' : 'mx-auto max-w-[1700px]'}`}>
      <Bar className="mb-4 h-3 w-32 shrink-0" />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-[var(--panel)]">
        {/* scoreboard header: meta line, then home / score / away */}
        <div className="shrink-0 border-b border-white/[0.05] px-5 py-3">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Bar className="h-4 w-4 rounded-full" />
              <Bar className="h-3 w-44" />
            </span>
            <Bar className="h-3 w-32" />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex flex-1 items-center justify-end gap-2.5">
              <Bar className="h-4 w-40" />
              <Bar className="h-9 w-9 shrink-0 rounded-full" />
            </div>
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              <Bar className="h-7 w-20" />
              <Bar className="h-4 w-14 rounded-md" />
            </div>
            <div className="flex flex-1 items-center gap-2.5">
              <Bar className="h-9 w-9 shrink-0 rounded-full" />
              <Bar className="h-4 w-40" />
            </div>
          </div>
        </div>

        {/* tab strip — Markets, Bets, Details */}
        <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.05] bg-black/[0.1] px-3 py-2">
          <Bar className="h-7 w-20" />
          <Bar className="h-7 w-14" />
          <Bar className="h-7 w-16" />
        </div>

        {/* the markets grid the page opens on */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <MarketsSkeleton />
        </div>
      </div>
    </div>
  )
}

/**
 * A bets table while the join is running.
 *
 * The Bets tabs used PanelSkeleton — a two-column grid of label/value pairs —
 * for what resolves into a wide table of bet rows, so the placeholder looked
 * nothing like the thing arriving. `note` carries the reason a wait is long:
 * a golf outright has to resolve its mapping and its market before it can even
 * ask for bets, which takes tens of seconds.
 */
export function BetsSkeleton({
  rows = 6,
  cols = 8,
  note,
}: {
  rows?: number
  /** Column count of the table about to render: 11 on a fixture (it carries vs
   *  Start, Result and P/L), 8 on a golf outright. */
  cols?: number
  note?: string
}) {
  return (
    <div className="px-5 py-4">
      {/* the four stat cards above the table */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2 rounded-md bg-black/[0.18] px-3 py-2.5">
            <Bar className="h-2 w-12" />
            <Bar className="h-4 w-16" />
          </div>
        ))}
      </div>
      <TableSkeleton rows={rows} cols={cols} />
      {note && <div className="mt-3 text-[11.5px] text-[color:var(--muted-2)]">{note}</div>}
    </div>
  )
}

/** Notification cards while the first alert sweep runs. */
export function NotificationsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg bg-[color:var(--panel)]/40 px-4 py-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <Bar className="h-3 w-3 rounded-full" />
            <Bar className="h-2.5 w-28" />
          </div>
          <Bar className="mb-2 h-4 w-2/5" />
          <Bar className="h-2.5 w-3/5" />
        </div>
      ))}
    </div>
  )
}

/**
 * Ticker cells at the real 132px width, so the strip doesn't resize when the
 * fixtures land.
 *
 * The ticker has its own feed now, and until this it rendered nothing at all
 * while that feed was in flight — the strip simply appeared and pushed the
 * board down. Holding the row's height and its cells keeps the page still.
 */
export function TickerSkeleton({ cells = 12 }: { cells?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading fixtures"
      className="flex shrink-0 overflow-hidden border-b border-[color:var(--line-soft)] bg-[color:var(--panel)]"
    >
      {Array.from({ length: cells }).map((_, i) => (
        <div
          key={i}
          className="flex w-[132px] shrink-0 flex-col gap-1.5 border-r border-[color:var(--line-soft)] px-3 py-2"
        >
          <div className="flex items-center justify-between">
            <Bar className="h-3.5 w-3.5 rounded-full" />
            <Bar className="h-2.5 w-8" />
          </div>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <Bar className="h-3.5 w-3.5 shrink-0 rounded-full" />
                <Bar className="h-2.5 w-7" />
              </span>
              <Bar className="h-2.5 w-6" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The markets price grid while the odds are in flight.
 *
 * The Markets tab used PanelSkeleton — a two-column grid of label/value pairs —
 * for what resolves into a wide book-by-selection table, so the placeholder
 * looked nothing like the thing arriving. This carries the real shape: a 56px
 * header strip of book marks, then market bands of a couple of rows each.
 */
export function MarketsSkeleton({ groups = 4, books = 6 }: { groups?: number; books?: number }) {
  return (
    <div role="status" aria-label="Loading odds">
      <div className="flex h-14 items-center gap-4 border-b border-white/[0.08] bg-[color:var(--panel-2)] px-3">
        <Bar className="h-2.5 w-20" />
        <div className="ml-auto flex gap-4">
          {Array.from({ length: books }).map((_, i) => (
            <Bar key={i} className="h-6 w-6 rounded" />
          ))}
        </div>
      </div>
      {Array.from({ length: groups }).map((_, g) => (
        <div key={g}>
          <div className="border-b border-white/[0.06] bg-[color:var(--panel-2)] px-3 py-1.5">
            <Bar className="h-3 w-28" />
          </div>
          {[0, 1].map((row) => (
            <div
              key={row}
              className="flex items-center gap-4 border-b border-white/[0.03] px-3 py-2.5"
            >
              <Bar className="h-3.5 w-3.5 shrink-0 rounded-full" />
              <Bar className={`h-3 ${row ? 'w-28' : 'w-36'}`} />
              <div className="ml-auto flex gap-4">
                {Array.from({ length: books }).map((_, i) => (
                  <Bar key={i} className="h-4 w-10" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
