import { LogOut } from 'lucide-react';
import { useAuth } from '../lib/useAuth';

/**
 * Who you are and the way out, for a page that has no rail.
 *
 * The rail carries this already (see SignedInAs in App), which was fine while
 * every full-width page was somewhere you visited briefly from the board. It
 * stopped being fine once a role existed that lived on the ticker and could not
 * reach the board at all: sign-out was only ever on the board, so a trading
 * account had no way out of the page it spends its day on. That role has the
 * board again, but the reasoning survives it — these pages still have no rail,
 * and a full-width page should not need a navigation to sign out of.
 *
 * Shared rather than repeated per page, so the way out cannot be present on
 * four of five and nobody notice which.
 */
export function SignOut() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="text-right leading-tight">
        <span className="block text-[11px] text-slate-400">{user.username}</span>
        <span className="block text-[9px] uppercase tracking-wide text-slate-600">{user.role}</span>
      </span>
      <button
        type="button"
        onClick={signOut}
        title="Sign out"
        aria-label="Sign out"
        className="rounded-md p-1.5 text-slate-600 transition hover:bg-white/5 hover:text-slate-300"
      >
        <LogOut size={14} />
      </button>
    </span>
  );
}
