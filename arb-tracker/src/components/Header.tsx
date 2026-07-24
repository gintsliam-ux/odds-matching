import { Activity } from 'lucide-react';
import { hasSupabaseCredentials } from '../lib/supabase';

/**
 * Rail brand block — logo + title above the filters. The board auto-polls, so
 * there's no manual refresh; the connection pill shows the live/mock state.
 */
export function Header() {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
          <Activity size={20} />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight">
            Arb Tracker
          </h1>
          <p className="text-xs text-slate-500">Next to jump</p>
        </div>
      </div>
      <ConnectionPill />
    </div>
  );
}

function ConnectionPill() {
  const live = hasSupabaseCredentials;
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        live
          ? 'bg-emerald-500/10 text-emerald-400'
          : 'bg-amber-500/10 text-amber-400'
      }`}
      title={
        live
          ? 'Connected to Supabase'
          : 'No Supabase key — showing mock data. Set VITE_SUPABASE_ANON_KEY.'
      }
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          live ? 'bg-emerald-400' : 'bg-amber-400'
        }`}
      />
      {live ? 'Live' : 'Mock data'}
    </span>
  );
}
