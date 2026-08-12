// Shimmer placeholders shown while the first feed load is in flight.
//
// The rule these follow: a skeleton is the shape of the thing arriving, at the
// size it will arrive. Anything else swaps one layout for another and the page
// jumps — which is what the detail page did, showing a narrow card where a
// full-width three-panel layout was about to land.

import { BRAND_TONE } from '../lib/brand'

const PANEL_TONES = [BRAND_TONE.optic, BRAND_TONE.swift, BRAND_TONE.mybet]

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
      <div className="flex items-center gap-2 px-4 pb-3">
        <Bar className="h-7 w-14" />
        <Bar className="h-7 flex-1" />
        <Bar className="h-7 flex-1" />
      </div>
      <div className="flex items-center justify-between border-t border-white/5 px-4 py-2">
        <Bar className="h-3 w-16" />
        <Bar className="h-3 w-12" />
      </div>
    </div>
  )
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="px-4 py-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-3.5 w-1 bg-[var(--line)]" />
        <Bar className="h-3 w-24" />
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
 * Mirrors the real page's frame — full width, hero, four stat cards, tab bar,
 * three source panels. The previous version was a single `max-w-2xl` card, so
 * every detail page visibly jumped from a narrow column to a 1700px layout the
 * moment it resolved.
 */
export function DetailSkeleton({
  panels = 3,
  fullWidth = false,
}: {
  panels?: number
  /** The golf page is full-bleed where the fixture page caps at 1700px; match
   *  whichever is about to render, or the swap still shifts the layout. */
  fullWidth?: boolean
}) {
  return (
    <div className={`px-5 py-5 ${fullWidth ? '' : 'mx-auto max-w-[1700px]'}`}>
      <Bar className="mb-5 h-3 w-32" />

      <div className="rounded-lg bg-[var(--panel)]">
        {/* league strip */}
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Bar className="h-4 w-4 rounded-full" />
            <Bar className="h-3.5 w-40" />
          </div>
          <Bar className="h-3 w-16" />
        </div>

        {/* hero: two competitors and their scores */}
        <div className="space-y-3 px-5 py-5">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Bar className="h-5 w-5 rounded-full" />
                <Bar className="h-5 w-52" />
              </div>
              <Bar className="h-6 w-6" />
            </div>
          ))}
        </div>

        {/* kickoff strip */}
        <div className="flex items-center gap-6 border-t border-white/[0.05] bg-black/[0.15] px-5 py-3">
          <Bar className="h-3 w-44" />
          <Bar className="h-3 w-44" />
          <Bar className="ml-auto h-3 w-20" />
        </div>

        {/* stat cards */}
        <div className="grid grid-cols-2 gap-2 px-5 py-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 rounded-md bg-black/[0.18] px-4 py-3">
              <Bar className="h-2 w-14" />
              <Bar className="h-5 w-20" />
              <Bar className="h-2 w-24" />
            </div>
          ))}
        </div>

        {/* tab bar */}
        <div className="flex gap-2 px-5 pb-4">
          <Bar className="h-7 w-16" />
          <Bar className="h-7 w-20" />
          <Bar className="h-7 w-14" />
        </div>

        {/* the three source panels the DETAILS tab opens on, each already
            wearing its source's accent */}
        <div className="grid grid-cols-1 gap-4 px-5 pb-5 lg:grid-cols-3">
          {Array.from({ length: panels }).map((_, i) => (
            <PanelSkeleton key={i} fields={10} tone={PANEL_TONES[i % PANEL_TONES.length]} />
          ))}
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
