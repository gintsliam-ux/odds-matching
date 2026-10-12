import { useEffect, useMemo, useState } from 'react';
import {
  addTabCompetition,
  fetchTabMapping,
  saveTabMapping,
  type TabCompetitionRow,
  type TabMapping,
} from '../lib/db';
import { Bone } from './Skeleton';

/**
 * The TAB competition list, and which optic league each one feeds.
 *
 * This exists so a competition TAB has started offering can be pointed at a
 * league here rather than by editing the scraper. It works because the scraper
 * already reads the field: `compsFromTable` in tab-arb.mjs selects
 * `active: true` AND `optic_league` not null and fetches exactly those, so
 * filling it in is the whole job and the next pass picks it up.
 *
 * Unmapped first, because that is the worklist. A row with no `optic_league`
 * is a market TAB is pricing and nobody is capturing.
 */

type Filter = 'unmapped' | 'mapped' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'unmapped', label: 'Needs a league' },
  { key: 'mapped', label: 'Mapped' },
  { key: 'all', label: 'All' },
];

/** Compact age, matching the pulse bar's. */
function ago(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const CHIP = 'rounded-md px-2 py-1 text-xs font-medium transition-colors';

/**
 * Add a competition the scrape has never listed.
 *
 * The table below edits what the scraper has already found. A brand new cup,
 * or a sport path it does not walk, has no row to edit — which was the one
 * case still worth opening the scraper for.
 */
function AddCompetition({
  sports,
  onAdded,
}: {
  sports: string[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [sport, setSport] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await addTabCompetition({ url: url.trim(), sport: sport || undefined });
      setMsg({
        kind: 'ok',
        text: r.existed ? 'Already on the list — find it below.' : 'Added. Give it a league below.',
      });
      setUrl('');
      onAdded();
    } catch (e) {
      setMsg({ kind: 'bad', text: e instanceof Error ? e.message : 'could not add it' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${CHIP} bg-white/5 text-slate-300 hover:bg-white/10`}
      >
        + Add a competition
      </button>
    );
  }

  return (
    <div className="w-full space-y-1.5 rounded-lg border border-surface-border p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && submit()}
          placeholder="Paste the TAB competition url"
          className="min-w-[280px] flex-1 rounded border border-surface-border bg-surface px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-emerald-500/50"
        />
        <select
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          className="rounded border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 outline-none"
          title="Only needed when the sport cannot be read from the url"
        >
          <option value="">sport from url</option>
          {sports.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !url.trim()}
          onClick={submit}
          className={`${CHIP} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40`}
        >
          {busy ? '…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setMsg(null);
          }}
          className={`${CHIP} bg-white/5 text-slate-400 hover:bg-white/10`}
        >
          Close
        </button>
      </div>
      <p className="text-[11px] text-slate-600">
        The sport and competition come out of the url path — …/
        <span className="text-slate-500">Soccer</span>/competitions/
        <span className="text-slate-500">Brazil Serie B</span>. Nothing here can check it exists;
        if the name is wrong the row simply stays at 0 fixtures, never seen.
      </p>
      {msg && (
        <p className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** One row: what TAB calls it, and the league it feeds. */
function Row({
  row,
  leagues,
  auto,
  onSaved,
  canWrite,
}: {
  row: TabCompetitionRow;
  leagues: TabMapping['leagues'];
  auto: number;
  onSaved: (id: number | string, opticLeague: string | null) => void;
  canWrite: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Only leagues of this competition's sport — a soccer competition has no
  // business being offered a basketball league.
  const options = useMemo(() => {
    const mine = leagues.filter((l) => !row.sport || l.sport === row.sport);
    const q = query.trim().toLowerCase();
    const scope = q
      ? mine.filter((l) =>
          `${l.category} ${l.tournament} ${l.opticLeague}`.toLowerCase().includes(q),
        )
      : mine;
    return scope.slice(0, 40);
  }, [leagues, row.sport, query]);

  const save = async (opticLeague: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await saveTabMapping({ id: row.id, opticLeague });
      onSaved(row.id, opticLeague);
      setEditing(false);
      setQuery('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save');
    } finally {
      setBusy(false);
    }
  };

  const confident = row.suggestion != null && row.suggestion.score >= auto;

  return (
    <tr className="border-t border-surface-border align-top">
      <td className="py-2 pl-3 pr-2">
        <div className="text-sm text-slate-100">{row.tabComp}</div>
        <div className="text-xs text-slate-500">
          {row.tabSport}
          {row.fixtures ? ` · ${row.fixtures} fx` : ''}
          {!row.active && <span className="ml-1 text-slate-600">· inactive</span>}
        </div>
      </td>

      <td className="py-2 pr-2 text-xs tabular-nums text-slate-500">{ago(row.lastSeen)}</td>

      <td className="py-2 pr-3">
        {row.opticLeague ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-emerald-300">{row.opticLeague}</span>
            {row.confirmed && <span className="text-[10px] text-slate-600">confirmed</span>}
          </div>
        ) : row.suggestion && !editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">suggested</span>
            <span className="font-mono text-xs text-slate-300">{row.suggestion.opticLeague}</span>
            <span
              className={`text-[10px] tabular-nums ${confident ? 'text-emerald-400' : 'text-amber-400'}`}
            >
              {row.suggestion.score.toFixed(2)}
            </span>
          </div>
        ) : (
          !editing && <span className="text-xs text-slate-600">no suggestion</span>
        )}

        {editing && (
          <div className="mt-1 space-y-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search leagues…"
              className="w-full rounded border border-surface-border bg-surface px-2 py-1 text-xs text-slate-200 outline-none focus:border-emerald-500/50"
            />
            <div className="max-h-44 overflow-y-auto rounded border border-surface-border">
              {options.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-slate-600">nothing matches</div>
              )}
              {options.map((l) => (
                <button
                  key={l.opticLeague}
                  type="button"
                  disabled={busy}
                  onClick={() => save(l.opticLeague)}
                  className="block w-full px-2 py-1.5 text-left text-xs hover:bg-white/5 disabled:opacity-50"
                >
                  <span className="text-slate-200">
                    {l.category ? `${l.category} · ` : ''}
                    {l.tournament}
                  </span>
                  <span className="ml-1 font-mono text-[10px] text-slate-500">{l.opticLeague}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {error && <div className="mt-1 text-xs text-red-300">{error}</div>}
      </td>

      <td className="py-2 pr-3 text-right">
        {!canWrite ? (
          <span className="text-[10px] text-slate-600">read-only</span>
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            {row.suggestion && !row.opticLeague && !editing && (
              <button
                type="button"
                disabled={busy}
                onClick={() => save(row.suggestion!.opticLeague)}
                className={`${CHIP} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50`}
              >
                {busy ? '…' : 'Accept'}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing((v) => !v)}
              className={`${CHIP} bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-50`}
            >
              {editing ? 'Cancel' : row.opticLeague ? 'Change' : 'Pick'}
            </button>
            {row.opticLeague && !editing && (
              <button
                type="button"
                disabled={busy}
                onClick={() => save(null)}
                className={`${CHIP} bg-white/5 text-slate-500 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-50`}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

export function TabCompetitions({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<TabMapping | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filter, setFilter] = useState<Filter>('unmapped');
  const [sport, setSport] = useState('all');
  const [query, setQuery] = useState('');

  const [nonce, setNonce] = useState(0);
  /* An add changes the row set, so that one does refetch — unlike a save,
     which is patched in place below. */
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    fetchTabMapping()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setState('ready');
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  /* Patch in place rather than refetching. The read is a 5-minute cached
     aggregate, so a refetch would either serve the pre-save copy or make the
     next visitor pay for a rebuild. */
  const onSaved = (id: number | string, opticLeague: string | null) =>
    setData((prev) =>
      prev
        ? {
            ...prev,
            counts: {
              ...prev.counts,
              mapped: prev.counts.mapped + (opticLeague ? 1 : -1),
              unmapped: prev.counts.unmapped + (opticLeague ? -1 : 1),
            },
            rows: prev.rows.map((r) =>
              r.id === id ? { ...r, opticLeague, confirmed: !!opticLeague } : r,
            ),
          }
        : prev,
    );

  const sports = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map((r) => r.sport).filter(Boolean))).sort(),
    [data],
  );

  const visible = useMemo(() => {
    const rows = data?.rows ?? [];
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (filter === 'unmapped' && r.opticLeague) return false;
        if (filter === 'mapped' && !r.opticLeague) return false;
        if (sport !== 'all' && r.sport !== sport) return false;
        if (q && !`${r.tabComp} ${r.tabSport} ${r.opticLeague ?? ''}`.toLowerCase().includes(q)) {
          return false;
        }
        return true;
      })
      // Best suggestion first inside the worklist — the ones safe to accept at
      // a glance come to the top.
      .sort((a, b) => (b.suggestion?.score ?? -1) - (a.suggestion?.score ?? -1));
  }, [data, filter, sport, query]);

  if (state === 'loading') {
    return (
      <div className="space-y-2 p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Bone key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (state === 'error' || !data) {
    return (
      <div className="p-4 text-sm text-slate-500">
        The TAB competition list is not available on this instance.
      </div>
    );
  }

  const c = data.counts;

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-slate-400">
          <span className="font-semibold text-slate-200 tabular-nums">{c.mapped}</span>
          <span className="text-slate-600">/{c.total}</span> mapped
        </span>
        <span className="text-slate-500">
          {c.unmapped} need a league · {c.suggested} have a suggestion · {c.auto} of those are
          confident
        </span>
        <span className="ml-auto text-slate-600">
          TAB reads `optic_league` off these rows — filling it is the whole job
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`${CHIP} ${
              filter === f.key
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-white/5 text-slate-400 hover:bg-white/10'
            }`}
          >
            {f.label}
          </button>
        ))}
        <select
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          className="rounded-md border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 outline-none"
        >
          <option value="all">All sports</option>
          {sports.map((s) => (
            <option key={s} value={s!}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search…"
          className="rounded-md border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 outline-none focus:border-emerald-500/50"
        />
        <span className="text-xs text-slate-600">{visible.length} shown</span>
        {canWrite && <AddCompetition sports={sports as string[]} onAdded={reload} />}
      </div>

      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full min-w-[620px] text-left">
          <thead className="text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1.5 pl-3 pr-2 font-medium">TAB competition</th>
              <th className="py-1.5 pr-2 font-medium">Seen</th>
              <th className="py-1.5 pr-3 font-medium">Optic league</th>
              <th className="py-1.5 pr-3" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <Row
                key={r.id}
                row={r}
                leagues={data.leagues}
                auto={data.thresholds.auto}
                onSaved={onSaved}
                canWrite={canWrite}
              />
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-sm text-slate-600">
                  Nothing here — every TAB competition in this filter has a league.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
