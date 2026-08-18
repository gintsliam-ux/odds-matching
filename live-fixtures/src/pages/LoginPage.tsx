import { useState } from 'react'
import { Activity, Loader2 } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/**
 * Sign-in gate. Rendered instead of the whole app — including the sidebar and
 * the polling — so nothing fetches until there is a session.
 */
export default function LoginPage() {
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useDocumentTitle('Sign in')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await signIn(username.trim(), password)
      // No navigate() — the app re-renders past the gate once `user` is set.
    } catch (err) {
      setError((err as Error).message || 'Could not sign in')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-6">
      <form onSubmit={submit} className="w-full max-w-[340px]">
        <div className="mb-7 flex items-center gap-2">
          <Activity className="h-5 w-5 text-[color:var(--total)]" />
          <span className="text-[15px] font-semibold text-gray-100">Live Events Terminal</span>
        </div>

        <label className="mb-1.5 block text-[11px] font-medium text-[color:var(--muted-2)]">
          Username
        </label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="mb-4 w-full rounded border border-[var(--line)] bg-black/[0.25] px-3 py-2 text-[13px] text-gray-100 outline-none focus:border-[color:var(--total)]/50"
        />

        <label className="mb-1.5 block text-[11px] font-medium text-[color:var(--muted-2)]">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mb-5 w-full rounded border border-[var(--line)] bg-black/[0.25] px-3 py-2 text-[13px] text-gray-100 outline-none focus:border-[color:var(--total)]/50"
        />

        {error && (
          <div className="mb-4 rounded border border-[var(--live)]/40 bg-[var(--live)]/[0.07] px-3 py-2 text-[12px] text-gray-200">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="inline-flex w-full items-center justify-center gap-2 rounded bg-[color:var(--total)]/15 px-3 py-2 text-[13px] font-semibold text-[color:var(--total)] hover:bg-[color:var(--total)]/25 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
