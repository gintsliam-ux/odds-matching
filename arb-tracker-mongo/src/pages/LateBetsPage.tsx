import { useEffect, useState } from 'react';
import { RowsSkeleton } from '../components/Skeleton';
import { useNumParam } from '../lib/urlState';
import { SignOut } from '../components/SignOut';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { fetchLateBets, type LateBets } from '../lib/db';
import { eventSlug } from '../lib/routing';

/**
 * Bets taken after the game had started.
 *
 * These books do not offer online in-play betting, so a bet accepted twenty
 * minutes after kick-off is a market that should have been suspended and was
 * not. The start is Optic's — `actual_start` where it has one, which is the real
 * jump rather than the not-before slot the schedule carries.
 *
 * Sorted by how late, because that is the severity: a minute is two clocks
 * disagreeing, three hours is a market left open.
 */

const AFTER = [1, 5, 15, 60];
const HOURS = [6, 24, 48];
const CHIP = 'rounded-md px-2.5 py-1 text-xs font-medium transition';

const money = (n: number | null) => (n == null ? '—' : `$${Math.round(n).toLocaleString()}`);

function late(mins: number): string {
  if (mins < 60) return `+${mins}m`;
  const h = Math.floor(mins / 60);
  return `+${h}h ${mins % 60}m`;
}

/** A minute late is noise; an hour late is a market that stayed open. */
const tone = (mins: number) =>
  mins >= 60 ? 'text-rose-300' : mins >= 15 ? 'text-amber-300' : 'text-slate-300';

export default function LateBetsPage() {
  const [data, setData] = useState<LateBets | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [after, setAfter] = useNumParam('after', 1);
  const [hours, setHours] = useNumParam('hours', 24);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const load = () =>
      fetchLateBets({ after, hours })
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
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [after, hours]);

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
              <AlertTriangle size={16} className="text-rose-400" />
              Late Bets
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Bets accepted after Optic had the game under way
            </p>
          </div>

          {c && (
            <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
              <span>
                <b className="text-rose-300 tabular-nums">{c.late}</b> late
              </span>
              <span title="Bets whose event start could be established at all. The rest carry no start time and cannot be judged either way.">
                of <b className="text-slate-400 tabular-nums">{c.comparable}</b> checked
              </span>
              <span>
                <b className="text-slate-300 tabular-nums">{c.events}</b> events
              </span>
              <span>
                <b className="text-amber-300 tabular-nums">{money(c.stake)}</b> staked
              </span>
              {c.stillLive > 0 && (
                <span
                  className="rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-300"
                  title="Optic still has these games in play, so the market may be open right now."
                >
                  {c.stillLive} still in play
                </span>
              )}
            </div>
          )}
          <span className="ml-auto">
            <SignOut />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border/60 px-4 py-2">
          <span className="text-[11px] text-slate-600">later than</span>
          {AFTER.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setAfter(m)}
              className={`${CHIP} ${
                after === m
                  ? 'bg-rose-500/15 text-rose-300'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {m}m
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-surface-border" />
          <span className="text-[11px] text-slate-600">last</span>
          {HOURS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHours(h)}
              className={`${CHIP} ${
                hours === h
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {h}h
            </button>
          ))}
          {state === 'loading' && <Loader2 size={13} className="ml-2 animate-spin text-slate-600" />}
        </div>
      </header>

      {state === 'loading' && !data && <RowsSkeleton rows={12} lead="w-20" />}

      {state === 'error' && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
          {error ?? 'Could not load late bets.'}
        </div>
      )}

      {state !== 'error' && data && data.bets.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <CheckCircle2 size={22} className="text-emerald-400" />
          <p className="text-sm text-slate-300">Nothing taken late.</p>
          <p className="max-w-md text-xs text-slate-600">
            {c?.comparable
              ? `${c.comparable} bets had a start time to check against, and none was struck more than ${after}m after it.`
              : 'No bets in the window carried a start time to check against.'}
          </p>
        </div>
      )}

      {state !== 'error' && data && data.bets.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {data.bets.map((b) => (
            <div
              key={`${b.source}:${b.betId}`}
              className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-surface-border px-3 py-2 ${
                b.stillLive ? 'bg-rose-500/[0.05]' : ''
              }`}
            >
              <span className={`w-20 shrink-0 text-sm font-semibold tabular-nums ${tone(b.afterMins)}`}>
                {late(b.afterMins)}
              </span>
              <span className="w-16 shrink-0 text-xs text-slate-500">{b.source}</span>
              <span className="w-20 shrink-0 text-sm font-semibold tabular-nums text-slate-100">
                {money(b.stake)}
              </span>
              <span className="w-12 shrink-0 text-xs tabular-nums text-slate-400">{b.price ?? '—'}</span>

              {b.fixtureId ? (
                <Link
                  to={`/event/${eventSlug(b.event ?? '')}/${encodeURIComponent(b.fixtureId)}`}
                  className="min-w-0 truncate text-sm text-slate-200 hover:text-emerald-300"
                >
                  {b.event ?? '(unnamed)'}
                </Link>
              ) : (
                <span className="min-w-0 truncate text-sm text-slate-200">{b.event ?? '(unnamed)'}</span>
              )}

              <span className="min-w-0 truncate text-xs text-slate-500">
                {b.sport}
                {b.market ? ` · ${b.market}` : ''}
                {b.outcome ? ` · ${b.outcome}` : ''}
              </span>

              <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-slate-600">
                {b.stillLive && (
                  <span className="rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-300">
                    in play now
                  </span>
                )}
                {!b.settled && (
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-300/80">unsettled</span>
                )}
                bet {b.betId} · user {b.userId}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
