import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { fetchMovers, type Mover, type Movers } from '../lib/db';
import { BookmakerLogo } from '../components/BookmakerLogo';
import { brandById } from '../lib/markets';
import { eventSlug } from '../lib/routing';

/** The brand record the logo wants, or just the id when we do not know it. */
function Book({ id, size = 14 }: { id: string; size?: number }) {
  const brand = brandById(id);
  if (!brand) return <span className="text-slate-400">{id}</span>;
  return <BookmakerLogo brand={brand} size={size} />;
}

/**
 * Head-to-head prices that have moved, and who has not moved with them.
 *
 * The board already answers "what is the best price". This answers the other
 * question: this market moved, is anyone still at the old number. So the move
 * leads each row, and the price still takeable is measured against both where
 * the market sits NOW and where it sat BEFORE — the second being the one that
 * says a book has not followed.
 *
 * Lagging rows come first because they are the actionable half.
 */

const WINDOWS = [
  { key: 'open', label: 'Since open' },
  { key: '6h', label: '6h' },
  { key: '3h', label: '3h' },
  { key: '1h', label: '1h' },
];

/* In implied-probability points. 2 is a real move; 5 is enormous. */
const MOVES = [1, 2, 3, 5];

const CHIP = 'rounded-md px-2.5 py-1 text-xs font-medium transition';

/** Points of implied probability, signed, never a percentage of the odds. */
function ptsText(v: number | null): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** Countdown-ish, matching the board's phrasing without its colour. */
function startsIn(iso: string): string {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(m)) return '';
  if (m < 0) return 'started';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
}

function Row({ m }: { m: Mover }) {
  const [open, setOpen] = useState(false);
  const shortened = m.movePts < 0;

  return (
    <div
      className={`border-t border-surface-border px-3 py-2.5 ${
        m.lagging ? 'bg-emerald-500/[0.04]' : ''
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The move, first, because it is the subject. */}
        <span
          className={`flex shrink-0 items-center gap-1 text-sm font-semibold tabular-nums ${
            shortened ? 'text-rose-300' : 'text-emerald-300'
          }`}
        >
          {shortened ? <TrendingDown size={14} /> : <TrendingUp size={14} />}
          {ptsText(m.movePts)}
          <span className="text-[10px] font-normal text-slate-600">pts</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-slate-500">
          {m.then} <span className="text-slate-600">→</span>{' '}
          <span className="text-slate-300">{m.now}</span>
        </span>

        <Link
          to={`/event/${eventSlug(m.name)}/${encodeURIComponent(m.fixtureId)}`}
          className="min-w-0 truncate text-sm text-slate-200 hover:text-emerald-300"
        >
          {m.name}
        </Link>
        <span className="truncate text-xs text-slate-500">
          {m.sport}
          {m.league ? ` · ${m.league}` : ''} · {startsIn(m.startsAt)}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-2">
          {m.market === 'moneyline_3way' && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">3-way</span>
          )}
          <span className="text-xs text-slate-400">{m.selection}</span>
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {/* The price still on the table, and how it compares both ways. */}
        <span className="flex items-center gap-1.5">
          <Book id={m.best.book} />
          <span className="font-semibold tabular-nums text-slate-100">{m.best.price}</span>
          <span className="text-slate-600">best</span>
        </span>
        <span className="tabular-nums text-slate-500">
          {ptsText(m.bestVsNowPts)} <span className="text-slate-600">pts vs market now</span>
        </span>
        <span className="tabular-nums text-slate-500">
          {ptsText(m.bestVsThenPts)} <span className="text-slate-600">vs before</span>
        </span>
        {m.best.movePts != null && (
          <span className="tabular-nums text-slate-500">
            {ptsText(m.best.movePts)} <span className="text-slate-600">its own move</span>
          </span>
        )}
        {m.lagging && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
            has not followed
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-[11px] text-slate-500 hover:text-slate-300"
        >
          {open ? 'hide' : `all ${m.books.length} books`}
        </button>
      </div>

      {open && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded border border-surface-border bg-surface/60 p-2">
          {m.books.map((b) => (
            <span key={b.book} className="flex items-center gap-1.5 text-xs">
              <Book id={b.book} size={13} />
              <span className="tabular-nums text-slate-200">{b.price}</span>
              {b.then != null && <span className="tabular-nums text-slate-600">from {b.then}</span>}
              <span
                className={`tabular-nums ${
                  b.movePts == null
                    ? 'text-slate-600'
                    : Math.abs(b.movePts) < 0.5
                      ? 'text-slate-500'
                      : b.movePts < 0
                        ? 'text-rose-300/80'
                        : 'text-emerald-300/80'
                }`}
              >
                {ptsText(b.movePts)}
              </span>
              <span className="text-slate-600">{b.ageMins}m</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function MoversPage() {
  const [data, setData] = useState<Movers | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState('open');
  const [minMove, setMinMove] = useState(2);
  const [sport, setSport] = useState('all');
  const [onlyLagging, setOnlyLagging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchMovers({ window: win, minMove })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setState('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'could not load');
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [win, minMove]);

  const sports = useMemo(
    () => Array.from(new Set((data?.movers ?? []).map((m) => m.sport))).sort(),
    [data],
  );

  const visible = useMemo(() => {
    let rows = data?.movers ?? [];
    if (sport !== 'all') rows = rows.filter((m) => m.sport === sport);
    if (onlyLagging) rows = rows.filter((m) => m.lagging);
    return rows;
  }, [data, sport, onlyLagging]);

  const c = data?.counts;

  return (
    <div className="flex h-dvh flex-col bg-surface-base text-slate-200">
      <header className="shrink-0 border-b border-surface-border bg-surface">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500 transition hover:text-slate-300"
          >
            <ArrowLeft size={14} /> Board
          </Link>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-slate-100">
              <TrendingDown size={16} className="text-emerald-400" />
              Movers
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Head-to-head markets that have moved, and who has not moved with them —
              measured in implied-probability points
            </p>
          </div>

          {c && (
            <div className="ml-auto flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
              <span>
                <b className="text-slate-300 tabular-nums">{c.movers}</b> movers
              </span>
              <span>
                <b className="text-emerald-300 tabular-nums">{c.lagging}</b> not followed
              </span>
              <span title="Markets with enough live books publishing a price at this window to be judged">
                <b className="text-slate-400 tabular-nums">{c.comparable}</b> of {c.markets}{' '}
                comparable
              </span>
              <span
                title={`Prices untouched for over ${data?.thresholds.freshMins}m are ignored entirely — a book whose capture has frozen keeps its last number, and that number is often the biggest on the row.`}
              >
                <b className="text-slate-400 tabular-nums">{c.staleRowsIgnored}</b> stale ignored
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border/60 px-4 py-2">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWin(w.key)}
              className={`${CHIP} ${
                win === w.key
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {w.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-surface-border" />
          <span className="text-[11px] text-slate-600" title="Implied-probability points: (1/before − 1/now) × 100">
            move ≥
          </span>
          {MOVES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setMinMove(v)}
              className={`${CHIP} ${
                minMove === v
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {v}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-surface-border" />
          <button
            type="button"
            onClick={() => setOnlyLagging((v) => !v)}
            className={`${CHIP} ${
              onlyLagging
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
            }`}
          >
            Not followed only
          </button>
          <select
            value={sport}
            onChange={(e) => setSport(e.target.value)}
            className="rounded-md border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 outline-none"
          >
            <option value="all">All sports</option>
            {sports.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="ml-auto text-[11px] text-slate-600">{visible.length} shown</span>
        </div>
      </header>

      {state === 'loading' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500">
          <Loader2 size={15} className="animate-spin" />
          Reading the price ladder across every head-to-head market…
        </div>
      )}

      {state === 'error' && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
          {error ?? 'Could not load movers.'}
        </div>
      )}

      {state === 'ready' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm text-slate-400">Nothing has moved that far.</p>
              <p className="max-w-md text-xs text-slate-600">
                {win !== 'open'
                  ? `Few books publish a ${win} price — ${c?.comparable ?? 0} of ${c?.markets ?? 0} markets could be judged at this window. "Since open" is the only rung the surface fills in reliably.`
                  : 'Try a smaller move threshold.'}
              </p>
            </div>
          ) : (
            visible.map((m) => <Row key={`${m.fixtureId}|${m.market}|${m.selection}`} m={m} />)
          )}
        </div>
      )}
    </div>
  );
}

export default MoversPage;
