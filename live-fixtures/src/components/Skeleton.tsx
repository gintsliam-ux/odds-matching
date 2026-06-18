// Shimmer placeholders shown while the first feed load is in flight.

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

/** Two-column skeleton for OPTIC / SWIFT panels in the detail page DETAILS tab. */
export function PanelSkeleton({ fields = 8 }: { fields?: number }) {
  return (
    <div className="rounded-md border border-[var(--line)] px-4 py-3">
      <div className="mb-3 flex items-center justify-between">
        <Bar className="h-3 w-12" />
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

export function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Bar className="mb-5 h-3 w-36" />
      <div className="rounded-md border border-[var(--line)] bg-[var(--panel)]">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <Bar className="h-3 w-32" />
          <Bar className="h-3 w-16" />
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="flex items-center justify-between">
            <Bar className="h-6 w-48" />
            <Bar className="h-6 w-6" />
          </div>
          <div className="flex items-center justify-between">
            <Bar className="h-6 w-40" />
            <Bar className="h-6 w-6" />
          </div>
        </div>
        {[0, 1, 2].map((s) => (
          <div key={s} className="border-t border-white/10 px-5 py-4">
            <Bar className="mb-3 h-2.5 w-28" />
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              {[0, 1, 2, 3].map((i) => (
                <Bar key={i} className="h-7 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
