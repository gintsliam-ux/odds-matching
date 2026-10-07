import { useEffect, useState } from 'react'
import { KeyRound, Plus, Trash2, X } from 'lucide-react'
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  type ManagedUser,
  type Role,
} from '../lib/authApi'
import { useAuth } from '../lib/useAuth'
import { Bone } from '../components/Skeleton'

/** This app's skeleton takes no stagger; the shape is all the page wants. */
const Skeleton = ({ className }: { className?: string; delay?: number }) => (
  <Bone className={className} />
)

const ROLES: Role[] = ['admin', 'support']

const ROLE_PILL: Record<Role, string> = {
  admin: 'bg-emerald-500/15 text-emerald-300',
  support: 'bg-sky-500/15 text-sky-300',
}

function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

export default function Users() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPass, setNewPass] = useState('')
  const [newRole, setNewRole] = useState<Role>('support')

  const [resetting, setResetting] = useState<ManagedUser | null>(null)
  const [resetPass, setResetPass] = useState('')

  // Bumped to refetch. Keeps the fetch inside the effect so nothing sets state
  // synchronously during render.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    listUsers()
      .then((u) => {
        if (cancelled) return
        setUsers(u)
        setError(null)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(ok)
      setReloadKey((k) => k + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (me?.role !== 'admin') {
    return (
      <div>
        <h1 className="text-2xl font-semibold text-white mb-1">Users</h1>
        <p className="text-sm text-slate-400">
          Only admins can manage users. You're signed in as{' '}
          <span className="text-slate-200 font-medium">{me?.username}</span> ({me?.role}).
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white mb-1">Users</h1>
          <p className="text-sm text-slate-400">
            Shared with the other tools on this database — changes here apply everywhere.
          </p>
        </div>
        <button
          onClick={() => {
            setAdding((v) => !v)
            setNewName('')
            setNewPass('')
            setNewRole('support')
          }}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
        >
          {adding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {adding ? 'Cancel' : 'Add user'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      {adding && (
        <div className="bg-surface-raised border border-surface-border rounded-xl p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="block text-[11px] uppercase tracking-wider text-slate-400">Username</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="px-3 py-1.5 rounded-lg bg-surface border border-surface-border focus:border-emerald-500/60 focus:outline-none text-sm text-slate-100"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11px] uppercase tracking-wider text-slate-400">Password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="min 8 characters"
              className="px-3 py-1.5 rounded-lg bg-surface border border-surface-border focus:border-emerald-500/60 focus:outline-none text-sm text-slate-100 placeholder:text-slate-600"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11px] uppercase tracking-wider text-slate-400">Role</label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as Role)}
              className="px-3 py-1.5 rounded-lg bg-surface border border-surface-border focus:border-emerald-500/60 focus:outline-none text-sm text-slate-100"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <button
            disabled={busy || !newName.trim() || newPass.length < 8}
            onClick={() =>
              run(async () => {
                await createUser(newName.trim(), newPass, newRole)
                setAdding(false)
              }, `Created ${newName.trim()}.`)
            }
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            Create
          </button>
        </div>
      )}

      <div className="bg-surface-raised border border-surface-border rounded-xl overflow-hidden">
        {loading ? (
          // User, role, created, actions — the columns it becomes.
          <div>
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-surface-border">
              <Skeleton className="h-2.5 w-10" />
            </div>
            <div className="divide-y divide-gray-800">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <Skeleton delay={i} className="h-4 w-28 shrink-0" />
                  <Skeleton delay={i} className="h-3.5 w-14 shrink-0" />
                  <Skeleton delay={i} className="h-3 w-24 shrink-0 hidden sm:block" />
                  <Skeleton delay={i} className="h-4 w-16 ml-auto shrink-0" />
                </div>
              ))}
            </div>
          </div>
        ) : users.length === 0 ? (
          <p className="px-4 py-6 text-sm text-center text-slate-500">No users.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-surface-border">
                <th className="text-left font-medium px-4 py-2.5">User</th>
                <th className="text-left font-medium px-3 py-2.5">Role</th>
                <th className="text-left font-medium px-3 py-2.5 hidden sm:table-cell">Created</th>
                <th className="text-right font-medium px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {users.map((u) => {
                const isMe = u.id === me?.id
                return (
                  <tr key={u.id} className="hover:bg-white/5/40 transition-colors">
                    <td className="px-4 py-2.5">
                      <span className="text-white font-medium">{u.username}</span>
                      {isMe && <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-500">you</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <select
                        value={u.role}
                        disabled={busy}
                        onChange={(e) =>
                          run(
                            () => updateUser(u.id, { role: e.target.value as Role }).then(() => undefined),
                            `${u.username} is now ${e.target.value}.`,
                          )
                        }
                        className={`px-2 py-1 rounded text-[11px] font-semibold uppercase tracking-wider border-0 focus:outline-none ${ROLE_PILL[u.role]}`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r} className="bg-surface-raised text-slate-100">
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 hidden sm:table-cell">{when(u.createdAt)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => {
                            setResetting(u)
                            setResetPass('')
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
                          title="Set a new password"
                        >
                          <KeyRound className="w-3.5 h-3.5" /> Password
                        </button>
                        <button
                          disabled={busy || isMe}
                          onClick={() => {
                            if (!confirmDelete(u.username)) return
                            run(() => deleteUser(u.id), `Deleted ${u.username}.`)
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          title={isMe ? "You can't delete your own account" : 'Delete user'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {resetting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setResetting(null)} />
          <div className="relative w-full max-w-sm bg-surface-raised border border-surface-border rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-white font-semibold">New password for {resetting.username}</h2>
              <button onClick={() => setResetting(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="password"
              autoComplete="new-password"
              autoFocus
              value={resetPass}
              onChange={(e) => setResetPass(e.target.value)}
              placeholder="min 8 characters"
              className="w-full px-3 py-2 rounded-lg bg-surface border border-surface-border focus:border-emerald-500/60 focus:outline-none text-sm text-slate-100 placeholder:text-slate-600"
            />
            <button
              disabled={busy || resetPass.length < 8}
              onClick={() => {
                const name = resetting.username
                const id = resetting.id
                setResetting(null)
                run(() => updateUser(id, { password: resetPass }).then(() => undefined), `Password updated for ${name}.`)
              }}
              className="w-full px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
            >
              Update password
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Kept out of the JSX so the confirm text stays readable and testable.
function confirmDelete(username: string): boolean {
  return window.confirm(
    `Delete ${username}?\n\nThis account is shared with the other tools on this database — they will lose access too.`,
  )
}
