import { CalendarDays } from 'lucide-react'
import { addDays, dayLabel, melbToday } from '../lib/dates'

interface Props {
  status: 'upcoming' | 'completed'
  date: string // YYYY-MM-DD
  onChange: (date: string) => void
}

const SPAN = 7 // how many quick-day chips to show

export function DateBar({ status, date, onChange }: Props) {
  const today = melbToday()
  // completed looks back, upcoming looks forward
  const days = Array.from({ length: SPAN }, (_, i) =>
    status === 'completed' ? addDays(today, -i) : addDays(today, i),
  )

  return (
    <div className="flex items-center gap-1.5 border-b border-[var(--line)] px-4 py-2.5">
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
        {days.map((d) => {
          const active = d === date
          return (
            <button
              key={d}
              onClick={() => onChange(d)}
              className={[
                'shrink-0 rounded px-2.5 py-1 text-[11px] font-bold tracking-widest transition-colors',
                active
                  ? 'bg-[var(--total)] text-black'
                  : 'border border-[var(--line)] text-gray-400 hover:border-gray-600',
              ].join(' ')}
            >
              {dayLabel(d, today)}
            </button>
          )
        })}
      </div>

      <label className="relative ml-auto flex items-center" title="Pick a date">
        <CalendarDays className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-gray-500" />
        <input
          type="date"
          value={date}
          max={status === 'completed' ? today : undefined}
          min={status === 'upcoming' ? today : undefined}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="rounded-md border border-[var(--line)] bg-[var(--panel)] py-1.5 pl-8 pr-2 text-[12px] tracking-wider text-gray-200 [color-scheme:dark] focus:border-gray-600 focus:outline-none"
        />
      </label>
    </div>
  )
}
