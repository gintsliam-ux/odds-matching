import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff, Check, Loader2, Plus, Trash2, Volume2, VolumeX, X } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { auth, type User } from '../lib/auth'
import { ListSkeleton } from '../components/Skeleton'

const ROLES = ['admin', 'support', 'user'] as const

/**
 * Account settings, and — for admins — user management.
 *
 * Everyone gets the notification switches for their own account. The user table
 * only renders for admins, because /api/auth refuses the underlying actions for
 * anyone else; hiding it is presentation, not the control.
 */
export default function UsersPage() {
  const { user, setPrefs } = useAuth()
  useDocumentTitle('Users')
  const isAdmin = (user?.role ?? '') === 'admin'

  const [users, setUsers] = useState<User[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!isAdmin) return
    auth
      .listUsers()
      .then(setUsers)
      .catch((e) => setError((e as Error).message))
  }, [isAdmin])

  useEffect(() => reload(), [reload])

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const prefs = user?.prefs ?? {}
  // Alerts are decided by role — support on, admin off — and the server refuses
  // a write from either. Showing the switches disabled rather than hiding them
  // says why they are the way they are, instead of leaving someone to wonder.
  const locked = !!user?.alertsLocked
  const forcedOn = user?.alertsForcedOn

  return (
    <div className="mx-auto max-w-[900px] px-5 py-6">
      <h1 className="mb-1 text-[17px] font-semibold text-gray-100">Users</h1>
      <p className="mb-6 text-[12.5px] text-[color:var(--muted)]">
        Signed in as <span className="text-gray-200">{user?.username}</span>
        {user?.role && <span className="text-[color:var(--muted-2)]"> · {user.role}</span>}
      </p>

      {/* --- own notification preferences ----------------------------------- */}
      <section className="mb-8 rounded-lg bg-[color:var(--panel)] px-5 py-4">
        <h2 className="mb-3 text-[13px] font-semibold text-gray-100">Notifications</h2>
        {locked && (
          <p className="mb-3 rounded border border-[var(--line)] bg-black/[0.2] px-3 py-2 text-[11.5px] text-[color:var(--muted)]">
            Alerts are always {forcedOn ? 'on' : 'off'} for{' '}
            <span className="text-gray-200">{user?.role}</span> accounts.
          </p>
        )}
        <div className="space-y-2">
          <Toggle
            disabled={locked}
            on={!prefs.muteSound}
            onChange={(on) => setPrefs({ ...prefs, muteSound: !on })}
            onIcon={<Volume2 className="h-4 w-4" />}
            offIcon={<VolumeX className="h-4 w-4" />}
            title="Alert sound"
            hint="A short chime when a new alert fires."
          />
          <Toggle
            disabled={locked}
            on={!prefs.hideToasts}
            onChange={(on) => setPrefs({ ...prefs, hideToasts: !on })}
            onIcon={<Bell className="h-4 w-4" />}
            offIcon={<BellOff className="h-4 w-4" />}
            title="Pop-up alerts"
            hint="Toasts over the board. The Notifications page still lists everything either way."
          />
        </div>
      </section>

      {error && (
        <div className="mb-4 rounded border border-[var(--live)]/40 bg-[var(--live)]/[0.07] px-3 py-2 text-[12px] text-gray-200">
          {error}
        </div>
      )}

      {!isAdmin ? (
        <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-6 text-center text-[12.5px] text-[color:var(--muted-2)]">
          Only admins can manage users.
        </div>
      ) : (
        <section className="rounded-lg bg-[color:var(--panel)]">
          <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
            <h2 className="text-[13px] font-semibold text-gray-100">
              Accounts {users && <span className="text-[color:var(--muted-2)]">· {users.length}</span>}
            </h2>
          </div>

          {users === null ? (
            <ListSkeleton rows={3} />
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {users.map((u) => (
                <UserRow
                  key={u.id}
                  u={u}
                  isSelf={u.id === user?.id}
                  busy={busy === u.id}
                  onSave={(patch) => run(u.id, () => auth.updateUser(u.id, patch))}
                  onDelete={() => run(u.id, () => auth.deleteUser(u.id))}
                />
              ))}
              <NewUserRow busy={busy === 'new'} onCreate={(n, p, r) => run('new', () => auth.createUser(n, p, r))} />
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function Toggle({
  on,
  onChange,
  onIcon,
  offIcon,
  title,
  hint,
  disabled = false,
}: {
  on: boolean
  onChange: (on: boolean) => void
  onIcon: React.ReactNode
  offIcon: React.ReactNode
  title: string
  hint: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-white/[0.03] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <span className={on ? 'text-[color:var(--total)]' : 'text-[color:var(--muted-2)]'}>
        {on ? onIcon : offIcon}
      </span>
      <span className="flex-1">
        <span className="block text-[12.5px] text-gray-100">{title}</span>
        <span className="block text-[11px] text-[color:var(--muted-2)]">{hint}</span>
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          on ? 'bg-[color:var(--total)]/40' : 'bg-white/10'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-gray-200 transition-all ${
            on ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}

function UserRow({
  u,
  isSelf,
  busy,
  onSave,
  onDelete,
}: {
  u: User
  isSelf: boolean
  busy: boolean
  onSave: (patch: { username?: string; password?: string; role?: string }) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [username, setUsername] = useState(u.username)
  const [password, setPassword] = useState('')
  const [role, setRole] = useState(u.role)

  if (!editing) {
    return (
      <div className="flex items-center gap-3 px-5 py-3">
        <span className="flex-1 text-[13px] text-gray-100">
          {u.username}
          {isSelf && <span className="ml-2 text-[10.5px] text-[color:var(--muted-2)]">you</span>}
        </span>
        <span className="rounded border border-[var(--line)] px-1.5 py-0.5 text-[10.5px] text-[color:var(--muted)]">
          {u.role}
        </span>
        <button
          onClick={() => setEditing(true)}
          className="rounded px-2 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-gray-200"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          disabled={isSelf || busy}
          title={isSelf ? 'You cannot delete the account you are signed in as' : 'Delete'}
          className="rounded px-2 py-1 text-[color:var(--muted-2)] hover:text-[color:var(--live)] disabled:opacity-30 disabled:hover:text-[color:var(--muted-2)]"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 bg-black/[0.15] px-5 py-3">
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-40 rounded border border-[var(--line)] bg-black/[0.3] px-2 py-1 text-[12.5px] text-gray-100 outline-none"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="new password (optional)"
        autoComplete="new-password"
        className="w-52 rounded border border-[var(--line)] bg-black/[0.3] px-2 py-1 text-[12.5px] text-gray-100 outline-none"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="rounded border border-[var(--line)] bg-black/[0.3] px-2 py-1 text-[12.5px] text-gray-100 outline-none"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          onSave({
            username: username.trim() || undefined,
            password: password || undefined,
            role,
          })
          setEditing(false)
          setPassword('')
        }}
        className="inline-flex items-center gap-1 rounded bg-[color:var(--total)]/15 px-2 py-1 text-[11.5px] font-medium text-[color:var(--total)]"
      >
        <Check className="h-3.5 w-3.5" /> Save
      </button>
      <button
        onClick={() => {
          setEditing(false)
          setUsername(u.username)
          setPassword('')
          setRole(u.role)
        }}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-gray-200"
      >
        <X className="h-3.5 w-3.5" /> Cancel
      </button>
    </div>
  )
}

function NewUserRow({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (username: string, password: string, role: string) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<string>('user')

  return (
    <div className="flex flex-wrap items-center gap-2 px-5 py-3">
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="username"
        className="w-40 rounded border border-[var(--line)] bg-black/[0.3] px-2 py-1 text-[12.5px] text-gray-100 outline-none"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="password (6+ characters)"
        autoComplete="new-password"
        className="w-52 rounded border border-[var(--line)] bg-black/[0.3] px-2 py-1 text-[12.5px] text-gray-100 outline-none"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="rounded border border-[var(--line)] bg-black/[0.3] px-2 py-1 text-[12.5px] text-gray-100 outline-none"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          onCreate(username.trim(), password, role)
          setUsername('')
          setPassword('')
        }}
        disabled={busy || !username.trim() || password.length < 6}
        className="inline-flex items-center gap-1 rounded bg-[color:var(--total)]/15 px-2 py-1 text-[11.5px] font-medium text-[color:var(--total)] disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        Add user
      </button>
    </div>
  )
}
