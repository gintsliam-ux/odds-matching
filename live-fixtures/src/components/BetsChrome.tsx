import { BRAND_PILL } from '../lib/brand'

// Shared chrome for a Bets panel: the per-brand sub-tab strip and the stat
// cards above the table.
//
// Lifted out of FixtureDetailPage so the golf tournament page renders the SAME
// controls rather than a lookalike. The bet TABLES stay separate — a fixture's
// rows carry "vs Start", a score-derived result and a projected P/L, none of
// which a tournament outright has.

export function BrandSubTab({
  active,
  onClick,
  brand,
  count,
}: {
  active: boolean
  onClick: () => void
  brand: 'swift' | 'mybet'
  count: number
}) {
  const pill =
    brand === 'swift' ? BRAND_PILL.swift : BRAND_PILL.mybet
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
        active ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:bg-white/[0.04]'
      }`}
    >
      <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-medium ${pill}`}>
        {brand === 'swift' ? 'SWIFT' : 'MYBET'}
      </span>
      <span>Bets</span>
      <span className="tabular-nums text-[color:var(--muted-2)]">{count}</span>
    </button>
  )
}

export function StatCard({
  label,
  value,
  tone,
  badge,
  live,
  sub,
}: {
  label: string
  value: string | number
  tone?: string
  badge?: string
  live?: boolean
  sub?: string
}) {
  return (
    <div className="rounded-md bg-[color:var(--panel-2)] px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--muted-2)]">{label}</span>
        {badge && (
          <span
            className={`inline-flex items-center gap-1 text-[9px] font-bold tracking-wide ${
              live ? 'text-[color:var(--live)]' : 'text-[color:var(--muted-2)]'
            }`}
          >
            {live && <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--live)] pulse-dot" />}
            {badge}
          </span>
        )}
      </div>
      <div className={`mt-0.5 text-[15px] font-semibold tabular-nums ${tone ?? 'text-gray-100'}`}>{value}</div>
      {sub && <div className="text-[10px] text-[color:var(--muted-2)]">{sub}</div>}
    </div>
  )
}
