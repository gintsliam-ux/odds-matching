import type { Fixture, FixtureStatus } from '../lib/types'
import { FixtureCard } from './FixtureCard'

interface Props {
  fixtures: Fixture[]
  now: Date
  onSelect: (f: Fixture) => void
}

const SECTIONS: { key: FixtureStatus; label: string; dot: string; text: string }[] = [
  { key: 'live', label: 'Live', dot: 'bg-[color:var(--live)]', text: 'text-[color:var(--live)]' },
  { key: 'upcoming', label: 'Upcoming', dot: 'bg-[color:var(--up)]', text: 'text-[color:var(--up)]' },
  { key: 'completed', label: 'Completed', dot: 'bg-[color:var(--muted-2)]', text: 'text-[color:var(--muted)]' },
]

export function FixtureGrid({ fixtures, now, onSelect }: Props) {
  if (fixtures.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[13px] text-[color:var(--muted)]">
        No fixtures match the current filters.
      </div>
    )
  }

  return (
    <div className="space-y-8 px-5 py-6">
      {SECTIONS.map(({ key, label, dot, text }) => {
        const group = fixtures.filter((f) => f.status === key)
        if (group.length === 0) return null
        return (
          <section key={key}>
            <div className="mb-3 flex items-baseline gap-2.5">
              <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
              <h2 className={`text-[13px] font-semibold ${text}`}>{label}</h2>
              <span className="text-[12px] tabular-nums text-[color:var(--muted-2)]">
                {group.length}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {group.map((f) => (
                <FixtureCard key={f.id} fixture={f} now={now} onSelect={onSelect} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
