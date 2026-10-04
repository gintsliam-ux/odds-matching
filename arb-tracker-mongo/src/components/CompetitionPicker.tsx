import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { MappingOption } from '../lib/db';

/**
 * Pick any of a provider's competitions by hand.
 *
 * The matcher gets most rows right and is wrong often enough to need
 * overriding — a league it mapped to the wrong tier, or one it found no
 * candidate for at all. Every competition the provider knows is searchable
 * here, so no row is a dead end just because the scorer couldn't place it.
 */
export function CompetitionPicker({
  options,
  current,
  sportKey,
  onPick,
  onCancel,
}: {
  options: MappingOption[];
  current: string | null;
  /** The optic league's sport — the list is scoped to it by default. */
  sportKey: string | null;
  onPick: (o: MappingOption) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [allSports, setAllSports] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes; a click outside does too, so the picker never strands the row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onCancel]);

  /** How many options this sport actually has, for the widen-the-net hint. */
  const inSport = useMemo(
    () => (sportKey ? options.filter((o) => o.sportKey === sportKey).length : options.length),
    [options, sportKey],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options
      .filter((o) => {
        // A soccer league is never a snooker competition, and wading through
        // every sport to find that out is the slow way to map anything.
        if (!allSports && sportKey && o.sportKey && o.sportKey !== sportKey) return false;
        return !q || `${o.name} ${o.alt ?? ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Free competitions first: one already mapped to another league is
        // rarely the one being looked for, and picking it would quietly leave
        // two leagues pointing at the same place.
        if (a.used !== b.used) return a.used ? 1 : -1;
        // Then the busiest — the one you want is rarely the one with three
        // events to its name.
        return b.events - a.events;
      })
      .slice(0, 60);
  }, [options, query, allSports, sportKey]);

  return (
    <div
      ref={boxRef}
      className="absolute right-2 top-full z-30 mt-1 w-[320px] rounded-lg border border-surface-border bg-surface shadow-2xl"
    >
      <div className="flex items-center gap-1.5 border-b border-surface-border px-2.5 py-2">
        <Search size={12} className="shrink-0 text-slate-600" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${allSports || !sportKey ? options.length : inSport} competitions`}
          className="min-w-0 flex-1 bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded p-0.5 text-slate-600 hover:bg-white/5 hover:text-slate-300"
        >
          <X size={12} />
        </button>
      </div>
      {sportKey && (
        <div className="flex items-center justify-between gap-2 border-b border-surface-border/60 px-2.5 py-1.5">
          <span className="text-[10px] text-slate-600">
            {allSports ? 'every sport' : `${sportKey.replace(/_/g, ' ')} only`}
          </span>
          <button
            type="button"
            onClick={() => setAllSports((v) => !v)}
            className="text-[10px] text-slate-500 hover:text-slate-300"
          >
            {allSports ? 'scope to sport' : 'show all sports'}
          </button>
        </div>
      )}
      <ul className="max-h-64 overflow-y-auto py-1">
        {matches.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onPick(o)}
              className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition hover:bg-white/5 ${
                o.name === current ? 'bg-emerald-500/10' : ''
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-[12px] text-slate-200">{o.name}</span>
                {o.alt && o.alt !== o.name && (
                  <span className="block truncate text-[10px] text-slate-600">{o.alt}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {o.used && (
                  <span
                    className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-500/80"
                    title="Already mapped to another league"
                  >
                    taken
                  </span>
                )}
                <span className="text-[10px] tabular-nums text-slate-600">{o.events}</span>
              </span>
            </button>
          </li>
        ))}
        {matches.length === 0 && (
          <li className="px-2.5 py-3 text-center text-[11px] text-slate-600">No match</li>
        )}
      </ul>
    </div>
  );
}
