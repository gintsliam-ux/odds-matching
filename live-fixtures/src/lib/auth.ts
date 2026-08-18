// Client half of /api/auth.
//
// The session is an httpOnly cookie, so nothing here reads or stores a token —
// the browser attaches it and the server decides. `me()` on mount is what tells
// the app whether anyone is signed in.

export interface UserPrefs {
  /** Silence the notification chime. */
  muteSound?: boolean
  /** Stop alert toasts appearing over the board. */
  hideToasts?: boolean
}

export interface User {
  id: string
  username: string
  role: string
  prefs: UserPrefs
  /** Role decides the alert switches, so they are shown but not offered. */
  alertsLocked?: boolean
  /** What the role forces them to: true = on, false = off, null = free choice. */
  alertsForcedOn?: boolean | null
  createdAt: string | null
  updatedAt: string | null
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Same origin, but explicit: without it a future cross-origin deploy would
    // silently stop sending the session cookie.
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json?.error || `auth ${res.status}`)
  return json
}

export const auth = {
  me: () => post<{ user: User | null }>({ action: 'me' }).then((r) => r.user),
  login: (username: string, password: string) =>
    post<{ user: User }>({ action: 'login', username, password }).then((r) => r.user),
  logout: () => post<{ ok: boolean }>({ action: 'logout' }),
  savePrefs: (prefs: UserPrefs) =>
    post<{ user: User }>({ action: 'prefs', prefs }).then((r) => r.user),

  listUsers: () => post<{ users: User[] }>({ action: 'users' }).then((r) => r.users),
  createUser: (username: string, password: string, role: string) =>
    post<{ user: User }>({ action: 'create-user', username, password, role }).then((r) => r.user),
  updateUser: (id: string, patch: { username?: string; password?: string; role?: string }) =>
    post<{ user: User }>({ action: 'update-user', id, ...patch }).then((r) => r.user),
  deleteUser: (id: string) => post<{ ok: boolean }>({ action: 'delete-user', id }),
}
