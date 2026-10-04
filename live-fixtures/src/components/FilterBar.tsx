import { useEffect, useRef, useState } from 'react'
import { Calendar, Check, ChevronDown, Search, X } from 'lucide-react'

/**
 * Board filters, in the shape Arb Tracker uses: a clearable date pill, two
 * multi-select pills, and a search box.
 *
 * Multi-select rather than the single-value dropdowns this board had before —
 * an empty selection means "all", so the pills read as "no filter" until you
 * pick something, and picking two sports no longer means picking one twice.
 *
 * Laid out in a row rather than Arb Tracker's stacked rail, because here the
 * bar runs across the top of a full-width board instead of down a 320px column.
 */

interface Option {
  value: string
  label: string
  /** Shown after the label, e.g. a fixture count. */
  hint?: number
}

const PILL =
  'flex items-center justify-between gap-1.5 rounded-md border border-[var(--line)] bg-[color:var(--panel)] px-2.5 py-1.5 text-[12px] transition-colors hover:border-gray-600'

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])
  return ref
}

/** Pill that opens the native calendar; shows the picked date or "Date". */
function DatePill({
  value,
  onChange,
  min,
  max,
}: {
  value: string
  onChange: (v: string) => void
  /** Bounds the day browser: /upcoming can't look back, /completed can't look forward. */
  min?: string
  max?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const label = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : 'Date'

  function openPicker() {
    const el = inputRef.current
    if (!el) return
    if (typeof el.showPicker === 'function') el.showPicker()
    else el.focus()
  }

  return (
    <div className="relative">
      <button type="button" onClick={openPicker} className={`${PILL} w-[130px]`}>
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <Calendar className="h-3.5 w-3.5 shrink-0 text-gray-500" />
          <span className={`truncate ${value ? 'text-gray-200' : 'text-gray-400'}`}>{label}</span>
        </span>
        {value ? (
          <X
            className="h-3.5 w-3.5 shrink-0 text-gray-500 hover:text-gray-200"
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
          />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        )}
      </button>
      <input
        ref={inputRef}
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0 [color-scheme:dark]"
        tabIndex={-1}
      />
    </div>
  )
}

/** Multi-select pill with a checkbox dropdown. Empty selection means "all". */
function MultiPill({
  label,
  selected,
  options,
  onChange,
  width = 'w-[168px]',
  single = false,
  locked,
}: {
  label: string
  selected: string[]
  options: Option[]
  onChange: (v: string[]) => void
  width?: string
  /** Radio-like: picking an option replaces the selection instead of adding. */
  single?: boolean
  /** Fixed by the route — render the value greyed out with no dropdown. */
  locked?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(() => setOpen(false))

  // A locked pill still occupies its slot, so the bar doesn't reflow when you
  // move between the All board and a status board.
  if (locked) {
    return (
      <span
        className={`${PILL} ${width} cursor-default opacity-60`}
        title={`${label} is set by the page you are on`}
      >
        <span className="truncate text-gray-300">{locked}</span>
      </span>
    )
  }

  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v
  const display =
    selected.length === 0 ? label : selected.length === 1 ? labelOf(selected[0]) : `${selected.length} selected`

  function toggle(v: string) {
    if (single) {
      onChange(selected.includes(v) ? [] : [v])
      setOpen(false)
      return
    }
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v])
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={options.length === 0 && selected.length === 0}
        className={`${PILL} ${width} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <span className={`truncate ${selected.length ? 'text-gray-200' : 'text-gray-400'}`}>{display}</span>
        {selected.length ? (
          <X
            className="h-3.5 w-3.5 shrink-0 text-gray-500 hover:text-gray-200"
            onClick={(e) => {
              e.stopPropagation()
              onChange([])
            }}
          />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        )}
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 max-h-72 w-[min(320px,calc(100vw-2rem))] overflow-auto rounded-md border border-[var(--line)] bg-[color:var(--panel-2)] p-1 shadow-xl">
          <button
            type="button"
            onClick={() => onChange([])}
            className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-white/5 ${
              selected.length ? 'font-medium text-gray-100' : 'text-gray-400'
            }`}
          >
            {selected.length ? `Clear (${selected.length})` : `All ${label.toLowerCase()}s`}
            {selected.length ? (
              <X className="h-3.5 w-3.5 text-gray-400" />
            ) : (
              <Check className="h-3.5 w-3.5 text-[color:var(--total)]" />
            )}
          </button>
          {selected.length > 0 && <div className="my-1 border-t border-[color:var(--line-soft)]" />}
          {options.length === 0 && <div className="px-2 py-1.5 text-[11px] text-gray-600">No options</div>}
          {options.map((o) => {
            const on = selected.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(o.value)}
                className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[12px] text-gray-200 hover:bg-white/5"
              >
                <span
                  className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                    on
                      ? 'border-[color:var(--total)] bg-[color:var(--total)] text-black'
                      : 'border-gray-600'
                  }`}
                >
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 break-words">{o.label}</span>
                {o.hint != null && (
                  <span className="shrink-0 tabular-nums text-[11px] text-gray-500">{o.hint}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search teams or players"
        aria-label="Search teams or players"
        className="w-56 rounded-md border border-[var(--line)] bg-[color:var(--panel)] py-1.5 pl-8 pr-8 text-[12px] text-gray-200 placeholder:text-gray-500 hover:border-gray-600 focus:border-[color:var(--total)]/50 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

interface Props {
  date: string
  onDate: (v: string) => void
  dateMin?: string
  dateMax?: string
  statusSel: string[]
  statusOptions: Option[]
  onStatus: (v: string[]) => void
  /** Set when the route fixes the status (/live, /upcoming, /completed). */
  statusLocked?: string
  /** Omitted when the route already pins a sport — then there is nothing to pick. */
  sportSel?: string[]
  sportOptions?: Option[]
  onSport?: (v: string[]) => void
  leagueSel: string[]
  leagueOptions: Option[]
  onLeague: (v: string[]) => void
  query: string
  onQuery: (v: string) => void
}

export function FilterBar({
  date,
  onDate,
  dateMin,
  dateMax,
  statusSel,
  statusOptions,
  onStatus,
  statusLocked,
  sportSel,
  sportOptions,
  onSport,
  leagueSel,
  leagueOptions,
  onLeague,
  query,
  onQuery,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DatePill value={date} onChange={onDate} min={dateMin} max={dateMax} />
      <MultiPill
        label="Status"
        selected={statusSel}
        options={statusOptions}
        onChange={onStatus}
        width="w-[140px]"
        single
        locked={statusLocked}
      />
      {sportSel && sportOptions && onSport && (
        <MultiPill label="Sport" selected={sportSel} options={sportOptions} onChange={onSport} />
      )}
      <MultiPill
        label="League"
        selected={leagueSel}
        options={leagueOptions}
        onChange={onLeague}
        width="w-[196px]"
      />
      <div className="ml-auto">
        <SearchBox value={query} onChange={onQuery} />
      </div>
    </div>
  )
}
