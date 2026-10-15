import { useEffect, useState } from 'react';
import { SignOut } from '../components/SignOut';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { fetchSettlement, type Settlement } from '../lib/db';
import { eventSlug } from '../lib/routing';

/**
 * Markets the book has not resulted on a game that is over.
 *
 * The clock that matters is how long it has been FINISHED, not how long since
 * kick-off. Measuring from the start listed a football match forty-one minutes
 * in with nine unsettled bets, which is simply half time — so this waits for
 * Optic to call the game completed and counts from there.
 *
 * An empty page is the good outcome and says so, rather than looking broken.
 */

const MINS = [15, 30, 60, 120];
const CHIP = 'rounded-md px-2.5 py-1 text-xs font-medium transition';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

function waited(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

/** Past an hour overdue it is no longer a lag, it is something stuck. */
const tone = (mins: number) =>
  mins >= 120 ? 'text-rose-300' : mins >= 60 ? 'text-amber-300' : 'text-slate-300';

export default function SettlementPage() {
  const [data, setData] = useState<Settlement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [mins, setMins] = useState(30);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const load = () =>
      fetchSettlement(mins)
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
  }, [mins]);

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
              <Clock size={16} className="text-amber-400" />
              Settlement
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Games Optic has called finished whose bets the book has not resulted
            </p>
          </div>

          {c && (
            <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
              <span>
                <b className="text-slate-300 tabular-nums">{c.events}</b> events
              </span>
              <span>
                <b className="text-slate-300 tabular-nums">{c.bets}</b> bets
              </span>
              <span>
                <b className="text-amber-300 tabular-nums">{money(c.stake)}</b> staked
              </span>
              <span title="Every unsettled bet in the last three days, most of them on games that have not been played yet and are meant to be open.">
                <b className="text-slate-400 tabular-nums">{c.openTotal}</b> open in all
              </span>
              <span title="Unsettled bets that could not be tied to a fixture, so they cannot be judged either way — mostly golf outrights, which have no fixture and stay open for days.">
                <b className="text-slate-400 tabular-nums">{c.unjudgeable}</b> unjudgeable
              </span>
            </div>
          )}
          <span className="ml-auto">
            <SignOut />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border/60 px-4 py-2">
          <span className="text-[11px] text-slate-600">finished at least</span>
          {MINS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMins(m)}
              className={`${CHIP} ${
                mins === m
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
              }`}
            >
              {m}m ago
            </button>
          ))}
          {state === 'loading' && <Loader2 size={13} className="ml-2 animate-spin text-slate-600" />}
        </div>
      </header>

      {state === 'error' && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
          {error ?? 'Could not load settlement.'}
        </div>
      )}

      {state !== 'error' && data && data.events.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <CheckCircle2 size={22} className="text-emerald-400" />
          <p className="text-sm text-slate-300">Nothing is overdue.</p>
          <p className="max-w-md text-xs text-slate-600">
            {c?.openTotal
              ? `${c.openTotal} bets are unsettled, and every one of them is on a game that has not finished yet.`
              : 'No unsettled bets in the window at all.'}
          </p>
        </div>
      )}

      {state !== 'error' && data && data.events.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {data.events.map((e) => (
            <div key={e.key} className="border-t border-surface-border">
              <button
                type="button"
                onClick={() => setOpen(open === e.key ? null : e.key)}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-left transition hover:bg-white/[0.03]"
              >
                <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone(e.waitingMins)}`}>
                  {waited(e.waitingMins)}
                </span>
                {e.fixtureId ? (
                  <Link
                    to={`/event/${eventSlug(e.name ?? '')}/${encodeURIComponent(e.fixtureId)}`}
                    onClick={(ev) => ev.stopPropagation()}
                    className="min-w-0 truncate text-sm text-slate-200 hover:text-emerald-300"
                  >
                    {e.name ?? e.key}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-sm text-slate-200">{e.name ?? e.key}</span>
                )}
                <span className="truncate text-xs text-slate-500">
                  {e.sport}
                  {e.tournament ? ` · ${e.tournament}` : ''}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-3 text-xs">
                  <span className="tabular-nums text-slate-400">{e.bets.length} bets</span>
                  <span className="font-semibold tabular-nums text-amber-300">{money(e.stake)}</span>
                  <span className="text-[11px] text-slate-600">{open === e.key ? 'hide' : 'show'}</span>
                </span>
              </button>

              {open === e.key && (
                <div className="border-t border-surface-border/60 bg-surface/50 px-3 py-2">
                  {e.bets.map((b) => (
                    <div
                      key={`${b.source}:${b.betId}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1 text-xs"
                    >
                      <span className="w-16 shrink-0 text-slate-500">{b.source}</span>
                      <span className="w-20 shrink-0 font-semibold tabular-nums text-slate-200">
                        {money(b.stake ?? 0)}
                      </span>
                      <span className="w-14 shrink-0 tabular-nums text-slate-400">{b.price ?? '—'}</span>
                      <span className="min-w-0 truncate text-slate-400">
                        {b.market}
                        {b.outcome ? ` · ${b.outcome}` : ''}
                      </span>
                      <span className="ml-auto shrink-0 text-slate-600">
                        bet {b.betId} · user {b.userId}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
