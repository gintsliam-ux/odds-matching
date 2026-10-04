import { useEffect, useRef, useState } from 'react';
import { Calendar, Check, ChevronDown, Search, X } from 'lucide-react';

interface Props {
  date: string;
  onDate: (v: string) => void;
  sportSel: string[];
  sportOptions: string[];
  onSport: (v: string[]) => void;
  leagueSel: string[];
  leagueOptions: string[];
  onLeague: (v: string[]) => void;
  query: string;
  onQuery: (v: string) => void;
  /** True while the search query is being fetched, for the inline spinner. */
  searching?: boolean;
}

const PILL =
  'flex w-full items-center justify-between gap-1 rounded-lg border border-surface-border bg-surface-raised px-2.5 py-1.5 text-sm hover:border-slate-600';

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onClose]);
  return ref;
}

/** Pill that opens the native calendar; shows the picked date or "Date". */
function DatePill({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const label = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : 'Date';

  function openPicker() {
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') el.showPicker();
    else el.focus();
  }

  return (
    <div className="relative">
      <button type="button" onClick={openPicker} className={PILL}>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-slate-200">
          <Calendar size={14} className="shrink-0 text-slate-500" />
          <span className="truncate">{label}</span>
        </span>
        {value ? (
          <X
            size={14}
            className="shrink-0 text-slate-500 hover:text-slate-200"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
          />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-slate-500" />
        )}
      </button>
      <input
        ref={inputRef}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0 [color-scheme:dark]"
        tabIndex={-1}
      />
    </div>
  );
}

/** Multi-select pill with a checkbox dropdown. Empty selection means "all". */
function MultiPill({
  label,
  selected,
  options,
  onChange,
  alignRight = false,
}: {
  label: string;
  selected: string[];
  options: string[];
  onChange: (v: string[]) => void;
  /** Anchor the menu to the right edge (grows leftward) — for the right column,
   * so a wide menu stays inside the rail instead of being clipped off-screen. */
  alignRight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));

  const display =
    selected.length === 0
      ? label
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  function toggle(opt: string) {
    onChange(
      selected.includes(opt)
        ? selected.filter((s) => s !== opt)
        : [...selected, opt],
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={PILL}>
        <span
          className={`truncate ${selected.length ? 'text-slate-200' : 'text-slate-400'}`}
        >
          {display}
        </span>
        {selected.length ? (
          // One-click clear, right on the pill (matches the Date pill).
          <X
            size={14}
            className="shrink-0 text-slate-500 hover:text-slate-200"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-slate-500" />
        )}
      </button>

      {open && (
        <div
          className={`absolute ${alignRight ? 'right-0' : 'left-0'} z-20 mt-1 max-h-64 w-[min(300px,calc(100vw-1.75rem))] overflow-auto rounded-lg border border-surface-border bg-surface-raised p-1 shadow-xl`}
        >
          <button
            type="button"
            onClick={() => onChange([])}
            className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5 ${
              selected.length ? 'font-medium text-slate-100' : 'text-slate-400'
            }`}
          >
            {selected.length ? `Clear (${selected.length})` : `All ${label.toLowerCase()}s`}
            {selected.length ? (
              <X size={14} className="text-slate-400" />
            ) : (
              <Check size={14} className="text-emerald-400" />
            )}
          </button>
          {selected.length > 0 && <div className="my-1 border-t border-surface-border" />}
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-slate-600">No options</div>
          )}
          {options.map((opt) => {
            const on = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/5"
              >
                <span
                  className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                    on
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : 'border-slate-600'
                  }`}
                >
                  {on && <Check size={12} />}
                </span>
                <span className="min-w-0 break-words">{opt}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Team/player search. Deliberately sits below the pills and ignores them — a
 * search is "find this competitor anywhere", not "narrow what's already shown",
 * so it answers with events from any sport, league or date.
 */
function SearchBox({
  value,
  onChange,
  searching,
}: {
  value: string;
  onChange: (v: string) => void;
  searching?: boolean;
}) {
  return (
    <div className="relative">
      <Search
        size={14}
        className={`pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 ${
          searching ? 'animate-pulse text-emerald-400' : 'text-slate-500'
        }`}
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search teams or players"
        aria-label="Search teams or players"
        className="w-full rounded-lg border border-surface-border bg-surface-raised py-1.5 pl-8 pr-8 text-sm text-slate-200 placeholder:text-slate-500 hover:border-slate-600 focus:border-emerald-500/60 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function FilterBar({
  date,
  onDate,
  sportSel,
  sportOptions,
  onSport,
  leagueSel,
  leagueOptions,
  onLeague,
  query,
  onQuery,
  searching,
}: Props) {
  // The date gets its own row — squeezed into a third of a 320px rail there is
  // no date format that survives the icon + clear button.
  return (
    <div className="space-y-2">
      <DatePill value={date} onChange={onDate} />
      <div className="grid grid-cols-2 gap-2">
        <MultiPill
          label="Sport"
          selected={sportSel}
          options={sportOptions}
          onChange={onSport}
        />
        <MultiPill
          label="League"
          selected={leagueSel}
          options={leagueOptions}
          onChange={onLeague}
          alignRight
        />
      </div>
      <SearchBox value={query} onChange={onQuery} searching={searching} />
      {query.trim().length > 0 && (
        <p className="px-0.5 text-[11px] leading-tight text-slate-500">
          Searching every sport, league and date — the filters above don't apply.
        </p>
      )}
    </div>
  );
}
