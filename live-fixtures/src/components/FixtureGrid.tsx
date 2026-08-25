import { useState } from 'react'
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

/**
 * How many cards a section renders before asking.
 *
 * The board re-renders every second — `now` drives the live clocks — and it
 * renders a component per fixture. That was fine at ~660 fixtures. It is not
 * at 10,622, which is what the board carries now it holds every upcoming
 * fixture plus 30 days of completed: 10,622 components rebuilding once a
 * second pins the main thread hard enough that the page stops responding to
 * input at all.
 *
 * Completed is the section that grew — thousands of finished games nobody
 * scrolls to — so capping costs nothing and the count in the header still
 * tells the truth about how many there are.
 */
const SECTION_CAP = 60

export function FixtureGrid({ fixtures, now, onSelect }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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
        const showAll = expanded[key] === true
        const shown = showAll ? group : group.slice(0, SECTION_CAP)
        const hidden = group.length - shown.length
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
              {shown.map((f) => (
                <FixtureCard key={f.id} fixture={f} now={now} onSelect={onSelect} />
              ))}
            </div>
            {hidden > 0 && (
              <div className="flex justify-center pt-4">
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [key]: true }))}
                  className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-2 text-[12px] font-medium text-gray-300 transition-colors hover:bg-white/[0.04]"
                >
                  Show {hidden.toLocaleString()} more
                </button>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
