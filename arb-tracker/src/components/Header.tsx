import { Activity, RefreshCw } from 'lucide-react';
import { hasSupabaseCredentials } from '../lib/supabase';

interface HeaderProps {
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Header({ onRefresh, refreshing }: HeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-surface-border bg-surface/80 backdrop-blur">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <Activity size={20} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight tracking-tight">
              Arb Tracker
            </h1>
            <p className="text-xs text-slate-500">Next to jump</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <ConnectionPill />
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:text-white disabled:opacity-60"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>
    </header>
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
