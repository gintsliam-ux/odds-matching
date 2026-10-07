import { useState, type FormEvent } from 'react';
import { Activity, LogIn } from 'lucide-react';
import { useAuth } from '../lib/useAuth';

/**
 * The whole desk sits behind this. Same sign-in as next-to-go, against the same
 * `gutsy.app_users`, so one set of credentials works across both.
 */
export default function LoginPage() {
  const { signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Read the fields off the FORM rather than React state. A password manager
   * filling them does not always fire onChange, which leaves state empty while
   * the inputs visibly hold a login — and the sign-in fails with the boxes
   * looking correct.
   */
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    if (!username || !password) {
      setError('Enter a username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  /*
   * Enter submits, explicitly.
   *
   * A form with a submit button is supposed to do this on its own, and the
   * markup here is the ordinary shape, so this should be redundant. It is here
   * because the behaviour was reported missing and implicit submission has a
   * surprising number of ways to not happen — a password manager swallowing
   * the key, an extension, a browser that does not treat the field as part of
   * the form. Asking the form to submit outright depends on none of that.
   *
   * `preventDefault` first, so where implicit submission DOES fire this does
   * not post twice. `busy` in submit() guards the rest.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const el = e.target as HTMLElement;
    if (el.tagName !== 'INPUT') return;
    e.preventDefault();
    e.currentTarget.requestSubmit();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15">
            <Activity size={18} className="text-emerald-400" />
          </span>
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-slate-100">
              Sports Odds Desk
            </h1>
            <p className="text-xs text-slate-500">Sign in to continue</p>
          </div>
        </div>

        <form onSubmit={submit} onKeyDown={onKeyDown} className="space-y-3 rounded-xl border border-surface-border bg-surface-raised/60 p-5">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Username</span>
            <input
              name="username"
              autoComplete="username"
              autoFocus
              className="w-full rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-500/50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              className="w-full rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-500/50"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
          >
            <LogIn size={14} />
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
