import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';

/**
 * Rail brand block — logo + title above the filters. The board auto-polls, so
 * there's no manual refresh; the connection pill shows the live/mock state.
 *
 * `onLogoClick` makes the brand a button — used on mobile so tapping the logo
 * closes the drawer (it opens from the same logo in the collapsed top bar).
 */
export function Header({ onLogoClick }: { onLogoClick?: () => void }) {
  const brand = (
    <>
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
        <Activity size={20} />
      </div>
      <div className="min-w-0 text-left">
        <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight">
          Sports Odds Desk
        </h1>
        <p className="text-xs text-slate-500">Next to jump</p>
      </div>
    </>
  );

  return (
    <div className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-3">
      {onLogoClick ? (
        <button
          type="button"
          onClick={onLogoClick}
          aria-label="Close events menu"
          className="flex min-w-0 items-center gap-2.5"
        >
          {brand}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5">{brand}</div>
      )}
      <ConnectionPill />
    </div>
  );
}

/**
 * Whether the API can reach Mongo. Unlike the Supabase build — where this was a
 * build-time check for a bundled key — the database now sits behind our own
 * server, so the only honest answer comes from asking it. Re-checked on the same
 * cadence as the board so a dropped tunnel shows up rather than going stale.
 */
function useApiHealth(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_BASE ?? ''}/api/health`);
        const body = await res.json();
        if (alive) setOk(res.ok && body?.ok === true);
      } catch {
        if (alive) setOk(false);
      }
    };
    check();
    const t = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return ok;
}

function ConnectionPill() {
  const health = useApiHealth();
  // Null is "haven't heard back yet" — neither green nor red, so a slow first
  // response doesn't flash a false alarm.
  const pending = health === null;
  const live = health === true;

  const tone = pending
    ? 'bg-slate-500/10 text-slate-400'
    : live
      ? 'bg-emerald-500/10 text-emerald-400'
      : 'bg-amber-500/10 text-amber-400';
  const dot = pending ? 'bg-slate-400' : live ? 'bg-emerald-400' : 'bg-amber-400';

  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}
      title={
        pending
          ? 'Checking the API\u2026'
          : live
            ? 'Connected to gutsys_sport'
            : 'API unreachable \u2014 is the server running, and is the Tailscale link to the NAS up?'
      }
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {pending ? 'Connecting' : live ? 'Live' : 'Offline'}
    </span>
  );
}
