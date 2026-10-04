import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Link2, Link2Off, Loader2, Pencil, Plus, Search, Users } from 'lucide-react';
import { CompetitionPicker } from '../components/CompetitionPicker';
import {
  clearTournamentMapping,
  fetchTournamentMapping,
  saveTournamentMapping,
  saveTournamentMappings,
  type MappingCandidate,
  type MappingCell,
  type MappingLeague,
  type MappingOption,
  type TournamentMapping,
} from '../lib/db';
import { useCapabilities } from '../lib/capabilitiesContext';

type Provider = 'swift' | 'mybet';
const PROVIDERS: { key: Provider; label: string }[] = [
  { key: 'swift', label: 'Swiftbet' },
  { key: 'mybet', label: 'Mybet' },
];

type Filter = 'all' | 'auto' | 'review' | 'unmatched' | 'mapped';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'auto', label: 'Ready to apply' },
  { key: 'review', label: 'Needs a look' },
  { key: 'unmatched', label: 'No candidate' },
  { key: 'mapped', label: 'Mapped' },
  { key: 'all', label: 'All' },
];

/** Which bucket a single provider cell falls in. */
function bucketOf(cell: MappingCell, auto: number): Filter {
  if (cell.currents.length > 0) return 'mapped';
  if (cell.suggestion && cell.suggestion.score >= auto && !cell.suggestion.contested) return 'auto';
  if (cell.suggestion) return 'review';
  return 'unmatched';
}

/**
 * A row's bucket is its most actionable cell across both providers, since the
 * page is a work queue: a league with a ready Swiftbet suggestion is something
 * to do, whatever its Mybet side happens to be.
 */
function rowBucket(l: MappingLeague, auto: number): Filter {
  const cells = PROVIDERS.map((p) => bucketOf(l.providers[p.key], auto));
  if (cells.includes('auto')) return 'auto';
  if (cells.includes('review')) return 'review';
  if (cells.includes('unmatched')) return 'unmatched';
  return 'mapped';
}

/**
 * The two independent reasons to believe a match: how well the names agree,
 * and how much of the squad the two competitions share. They are shown
 * separately on purpose — a perfect name with no shared players is exactly the
 * case that used to map England's FA Cup onto China's.
 */
function Evidence({ c }: { c: MappingCandidate }) {
  return (
    <span className="flex flex-wrap items-center gap-1 text-[10px]">
      <span
        className={`rounded px-1.5 py-[3px] font-medium tabular-nums ${
          c.score >= 0.9 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/[0.06] text-slate-400'
        }`}
        title="Name similarity"
      >
        {Math.round(c.score * 100)}% name
      </span>
      {c.overlap != null && (
        <span
          className={`flex items-center gap-1 rounded px-1.5 py-[3px] font-medium tabular-nums ${
            c.overlap >= 0.3 ? 'bg-sky-500/10 text-sky-300' : 'bg-white/[0.06] text-slate-500'
          }`}
          title="Share of the smaller squad the two competitions have in common"
        >
          <Users size={9} />
          {Math.round(c.overlap * 100)}% squad
        </span>
      )}
      {c.contested && (
        <span
          className="rounded bg-amber-500/10 px-1.5 py-[3px] font-medium text-amber-400"
          title={`${c.contestedWith} other league also proposes this competition`}
        >
          contested
        </span>
      )}
    </span>
  );
}

function Cell({
  league,
  provider,
  cell,
  auto,
  options,
  onChanged,
}: {
  league: MappingLeague;
  provider: Provider;
  cell: MappingCell;
  auto: number;
  options: MappingOption[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Every control below writes. On a mirror-backed instance the route refuses
  // the write, so the whole cell is read-only rather than quietly inert.
  const { mappingWrite } = useCapabilities();

  const save = async (o: { id: string; name: string; sport: string | null }, confidence: number) => {
    setBusy(true);
    setEditing(false);
    try {
      await saveTournamentMapping({
        opticLeague: league.opticLeague,
        provider,
        competitionId: o.id,
        competitionName: o.name,
        sport: o.sport,
        confidence,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const apply = (c: MappingCandidate) => save(c, c.score);

  // A hand-picked competition is stated, not inferred, so it is recorded at
  // full confidence however the scorer rated it.
  const pick = (o: MappingOption) => save(o, 1);

  const picker = editing ? (
    <CompetitionPicker
      options={options}
      current={cell.currents[0]?.name ?? null}
      sportKey={league.sportKey}
      onPick={pick}
      onCancel={() => setEditing(false)}
    />
  ) : null;

  /** Remove one mapped competition; the others stay. */
  const unmap = async (competitionId: string | null) => {
    setBusy(true);
    try {
      await clearTournamentMapping({ opticLeague: league.opticLeague, provider, competitionId });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <div className="flex h-full items-center px-3 py-2 text-slate-500">
        <Loader2 size={13} className="animate-spin" />
      </div>
    );
  }

  if (cell.currents.length > 0) {
    // A tennis league maps to 87 individual tournaments. Showing them all turns
    // one row into a page, so the cell leads with a few and opens on demand.
    const COLLAPSED = 3;
    const shown = showAll ? cell.currents : cell.currents.slice(0, COLLAPSED);
    const hidden = cell.currents.length - shown.length;
    return (
      <div className="group relative px-4 py-3">
        {cell.currents.length > COLLAPSED && (
          <div className="mb-1.5 text-[10px] text-slate-600">
            {cell.currents.length} competitions
          </div>
        )}
        <ul className="space-y-1.5">
          {shown.map((c) => (
            <li key={`${c.id ?? ''}|${c.name}`} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/15">
                  <Check size={11} className="text-emerald-400" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-slate-100" title={c.name}>
                    {c.name}
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] text-slate-600">
                    {c.source}
                    {c.rows > 1 && (
                      <span
                        className="rounded bg-amber-500/10 px-1 text-amber-500/80"
                        title={`Stored ${c.rows} times — redundant rows in competition_mapping`}
                      >
                        {c.rows}× duplicated
                      </span>
                    )}
                  </span>
                </span>
              </span>
              {mappingWrite && (
                <button
                  type="button"
                  onClick={() => unmap(c.id)}
                  title="Remove just this one"
                  className="shrink-0 rounded p-1 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-white/5 hover:text-rose-400"
                >
                  <Link2Off size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-2 ml-7 flex items-center gap-3">
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-[11px] text-slate-500 hover:text-slate-300"
            >
              +{hidden} more
            </button>
          )}
          {showAll && cell.currents.length > COLLAPSED && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="text-[11px] text-slate-500 hover:text-slate-300"
            >
              show fewer
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="flex items-center gap-1 rounded text-[11px] text-slate-600 opacity-0 transition hover:text-slate-300 group-hover:opacity-100"
          >
            <Plus size={11} /> add another
          </button>
        </div>
        {picker}
      </div>
    );
  }

  if (!cell.suggestion) {
    return (
      <div className="group relative flex h-full items-center justify-between gap-2 px-4 py-3">
        <span className="flex items-center gap-2 text-[13px] text-slate-600">
          <span className="h-5 w-5 shrink-0 rounded-full border border-dashed border-surface-border" />
          no candidate
        </span>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="shrink-0 rounded-md border border-surface-border px-2.5 py-1 text-[11px] text-slate-500 opacity-0 transition hover:border-emerald-500/40 hover:text-slate-200 group-hover:opacity-100"
        >
          Choose…
        </button>
        {picker}
      </div>
    );
  }

  const s = cell.suggestion;
  const ready = s.score >= auto && !s.contested;

  return (
    <div className="group relative px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={`h-5 w-5 shrink-0 rounded-full border ${
              ready ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-surface-border'
            }`}
          />
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-slate-300" title={s.alt ?? s.name}>
              {s.name}
            </span>
            {s.alt && s.alt !== s.name && (
              <span className="block truncate text-[10px] text-slate-600">{s.alt}</span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {mappingWrite && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              title="Pick a different competition"
              className="rounded p-1 text-slate-600 opacity-0 transition hover:bg-white/5 hover:text-slate-200 group-hover:opacity-100"
            >
              <Pencil size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => apply(s)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              ready
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : 'border border-surface-border text-slate-400 hover:border-emerald-500/40 hover:text-slate-200'
            }`}
            disabled={!mappingWrite}
            title={mappingWrite ? undefined : 'Read-only here — saving needs a direct connection to gutsys_sport'}
          >
            {ready ? 'Apply' : 'Use'}
          </button>
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 pl-7">
        <Evidence c={s} />
        {cell.alternatives.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-[10px] text-slate-600 hover:text-slate-400"
          >
            {open ? 'hide' : `${cell.alternatives.length} more`}
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-1.5 space-y-1 border-l border-surface-border pl-2">
          {cell.alternatives.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[12px] text-slate-400" title={a.alt ?? a.name}>
                {a.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Evidence c={a} />
                <button
                  type="button"
                  onClick={() => apply(a)}
                  className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/10 hover:text-slate-200"
                >
                  Use
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {picker}
    </div>
  );
}

/**
 * Tournament mapping: every optic league beside its Swiftbet and Mybet
 * counterpart.
 *
 * The three feeds spell the same competition differently — NPB / Nippon
 * Professional Baseball / Japanese NPB — so candidates are proposed by name
 * similarity and then corroborated against the squads each competition
 * actually fields. Squad overlap is what separates Italy's Serie A from
 * Brazil's, and nothing is written until it's applied here.
 */
export default function MappingPage() {
  const [data, setData] = useState<TournamentMapping | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filter, setFilter] = useState<Filter>('auto');
  const [sport, setSport] = useState('all');
  const [query, setQuery] = useState('');
  const [applyingAll, setApplyingAll] = useState(false);
  const { mappingWrite } = useCapabilities();

  const load = () => {
    setState('loading');
    fetchTournamentMapping()
      .then((d) => {
        setData(d);
        setState('ready');
      })
      .catch(() => setState('error'));
  };
  useEffect(load, []);

  const auto = data?.thresholds?.auto ?? 0.88;

  /** Sports present in the table, ordered by how much work each holds. */
  const sports = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const l of data.leagues) {
      const done = rowBucket(l, auto) === 'mapped';
      counts.set(l.sport, (counts.get(l.sport) ?? 0) + (done ? 0 : 1));
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data, auto]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.leagues.filter((l) => {
      if (sport !== 'all' && l.sport !== sport) return false;
      if (q && !`${l.category} ${l.tournament} ${l.sport}`.toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      return rowBucket(l, auto) === filter;
    });
  }, [data, filter, sport, query, auto]);

  /**
   * Every uncontested high-confidence suggestion, across BOTH providers.
   *
   * A league's Swiftbet and Mybet counterparts are two separate facts, and
   * having to switch the filter and press the button twice to record them was
   * busywork — the bulk action covers the whole table.
   */
  const ready = useMemo(() => {
    if (!data) return [] as { opticLeague: string; provider: Provider; suggestion: MappingCandidate }[];
    const out = [];
    for (const l of data.leagues) {
      for (const p of PROVIDERS) {
        const cell = l.providers[p.key];
        if (bucketOf(cell, auto) === 'auto' && cell.suggestion) {
          out.push({ opticLeague: l.opticLeague, provider: p.key, suggestion: cell.suggestion });
        }
      }
    }
    return out;
  }, [data, auto]);

  const readyBy = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of ready) counts[r.provider] = (counts[r.provider] ?? 0) + 1;
    return counts;
  }, [ready]);

  const applyAll = async () => {
    setApplyingAll(true);
    try {
      await saveTournamentMappings(
        ready.map((r) => ({
          opticLeague: r.opticLeague,
          provider: r.provider,
          competitionId: r.suggestion.id,
          competitionName: r.suggestion.name,
          sport: r.suggestion.sport,
          confidence: r.suggestion.score,
        })),
      );
      load();
    } finally {
      setApplyingAll(false);
    }
  };

  /** Bucket counts for the current sport, across both providers. */
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: 0, auto: 0, review: 0, unmatched: 0, mapped: 0 };
    if (!data) return out;
    for (const l of data.leagues) {
      if (sport !== 'all' && l.sport !== sport) continue;
      out.all++;
      out[rowBucket(l, auto)]++;
    }
    return out;
  }, [data, sport, auto]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-surface-border bg-surface-raised">
        <div className="flex flex-wrap items-center gap-4 px-5 pb-3 pt-4">
          <Link
            to="/"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
          >
            <ArrowLeft size={14} /> Board
          </Link>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-slate-100">
              <Link2 size={16} className="text-emerald-400" />
              Tournament mapping
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Optic leagues matched to their Swiftbet and Mybet counterparts
            </p>
          </div>

          {/* Coverage per provider — the single number that says how much of
              this job is left, and the reason to keep going. */}
          {data?.configured && (
            <div className="flex items-center gap-5">
              {PROVIDERS.map((p) => {
                const c = data.providers?.[p.key];
                if (!c) return null;
                const pct = Math.round((c.mapped / Math.max(c.total, 1)) * 100);
                return (
                  <div key={p.key} className="min-w-[124px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] font-medium text-slate-400">{p.label}</span>
                      <span className="text-[11px] tabular-nums text-slate-500">
                        <b className="text-slate-300">{c.mapped}</b>
                        <span className="opacity-50">/{c.total}</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-emerald-500/60 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a tournament"
                className="w-56 rounded-md border border-surface-border bg-surface py-1.5 pl-7 pr-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/40 focus:outline-none"
              />
            </div>
            {ready.length > 0 && !mappingWrite && (
              /* The mirror is a copy: a save against it would be reverted by the
                 next sync and never reach the NAS, so the route refuses it. Say
                 so, rather than offer a button that quietly does nothing. */
              <span
                className="rounded-md border border-dashed border-surface-border px-3 py-1.5 text-xs text-slate-500"
                title="This instance reads a mirror of the mapping tables. Saving needs a direct connection to gutsys_sport, which is only reachable on the tailnet."
              >
                {ready.length} ready — read-only here
              </span>
            )}
            {ready.length > 0 && mappingWrite && (
              <button
                type="button"
                onClick={applyAll}
                disabled={applyingAll}
                className="flex items-center gap-2 rounded-md bg-emerald-500/15 px-3.5 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {applyingAll ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Apply {ready.length}
                <span className="font-normal opacity-60">
                  {PROVIDERS.map((p) => `${readyBy[p.key] ?? 0} ${p.label}`).join(' · ')}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Sports first: the coarsest useful cut, and the one that makes a
            415-row table feel finite. */}
        {data?.configured && sports.length > 1 && (
          <div className="flex flex-wrap items-center gap-1 border-t border-surface-border/60 px-5 py-2">
            <button
              type="button"
              onClick={() => setSport('all')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                sport === 'all'
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              All sports
            </button>
            <span className="mx-1 h-4 w-px bg-surface-border" />
            {sports.map(([name, outstanding]) => (
              <button
                key={name}
                type="button"
                onClick={() => setSport(name)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition ${
                  sport === name
                    ? 'bg-white/10 font-medium text-slate-100'
                    : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                }`}
              >
                {name}
                {outstanding > 0 && (
                  <span
                    className={`rounded px-1 text-[10px] tabular-nums ${
                      sport === name ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-slate-600'
                    }`}
                  >
                    {outstanding}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {data?.configured && (
          <div className="flex flex-wrap items-center gap-1 border-t border-surface-border/60 px-5 py-2">
            {FILTERS.map((f) => {
              const n = counts[f.key];
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition ${
                    active
                      ? 'bg-emerald-500/15 font-medium text-emerald-300'
                      : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                  }`}
                >
                  {f.label}
                  <span className="tabular-nums opacity-60">{n}</span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {state === 'loading' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500">
          <Loader2 size={15} className="animate-spin" />
          Reading squads from all three feeds…
        </div>
      )}

      {state === 'error' && (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          Couldn't load the mapping table.
        </div>
      )}

      {state === 'ready' && data && !data.configured && (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-slate-500">
          No bets cluster is configured, so there is nothing to map against. Set{' '}
          <code className="mx-1">BETS_URI</code> and reload.
        </div>
      )}

      {state === 'ready' && data?.configured && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                <th className="sticky top-0 z-20 w-[30%] border-b border-surface-border bg-surface px-4 py-2.5 text-left font-medium">
                  Optic league
                </th>
                {PROVIDERS.map((p) => (
                  <th
                    key={p.key}
                    className="sticky top-0 z-20 w-[35%] border-b border-l border-surface-border bg-surface px-4 py-2.5 text-left font-medium"
                  >
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr
                  key={l.opticLeague}
                  className="border-b border-surface-border/50 align-top transition-colors hover:bg-white/[0.015]"
                >
                  <td className="px-4 py-3">
                    {/* A league spanning many tournaments is a tour, and
                        `leagues.tournament` holds one arbitrary event from it —
                        naming the whole ATP Challenger circuit "Sion,
                        Switzerland" is just wrong. Lead with the category when
                        that is the case. */}
                    <div className="text-[13px] font-medium text-slate-100">
                      {l.tournamentCount > 1 ? l.category || l.opticLeague : l.tournament || l.opticLeague}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                      {l.tournamentCount > 1 ? (
                        <span className="text-slate-500">{l.tournamentCount} tournaments</span>
                      ) : (
                        l.category && <span>{l.category}</span>
                      )}
                      <span className="text-slate-600">{l.sport}</span>
                      {l.fixtures > 0 && (
                        <span className="text-slate-600">{l.fixtures.toLocaleString()} fixtures</span>
                      )}
                    </div>
                  </td>
                  {PROVIDERS.map((p) => (
                    <td key={p.key} className="border-l border-surface-border/60">
                      <Cell
                        league={l}
                        provider={p.key}
                        cell={l.providers[p.key]}
                        auto={auto}
                        options={data.candidates?.[p.key] ?? []}
                        onChanged={load}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-8 text-center text-sm text-slate-600">
                    Nothing in this bucket.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
