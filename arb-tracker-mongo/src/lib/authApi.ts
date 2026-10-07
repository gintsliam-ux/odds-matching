/*
 * Ported from next-to-go so the two desks sign in the same way against the
 * same `gutsy.app_users`. The one change: this app can point at a separate API
 * origin (the local node server on :5174), so every call goes through API.
 */
const API = import.meta.env.VITE_API_BASE ?? ''

export type Role = 'admin' | 'support'

export interface SessionUser {
  id: string
  username: string
  role: Role
}

export interface ManagedUser extends SessionUser {
  createdAt: string | null
  updatedAt: string | null
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${url}`, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  })
  const text = await r.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`Unexpected response (${r.status})`)
  }
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error || `Request failed (${r.status})`)
  return body as T
}

/** The session check couldn't be completed. Not an answer, and not a logout. */
export class SessionCheckFailed extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The signed-in user, or null when the server actually says 401.
 *
 * A network failure or a 5xx is not an answer, so it retries and then throws
 * rather than reporting null: treating a blip as a logout is what used to
 * bounce people to the login page with a perfectly good cookie.
 */
export async function fetchMe(): Promise<SessionUser | null> {
  let last: unknown = null
  for (const delay of [0, 400, 1200]) {
    if (delay) await sleep(delay)
    try {
      const r = await fetch(`${API}/api/auth`, { credentials: 'include', cache: 'no-store' })
      if (r.status === 401) return null
      if (!r.ok) {
        last = new Error(`Session check failed (${r.status})`)
        continue
      }
      const { user } = (await r.json()) as { user: SessionUser }
      return user
    } catch (e) {
      last = e
    }
  }
  throw new SessionCheckFailed(String((last as { message?: unknown } | null)?.message ?? last))
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const { user } = await call<{ user: SessionUser }>('/api/auth', {
    method: 'POST',
    body: JSON.stringify({ action: 'login', username, password }),
  })
  return user
}

export async function logout(): Promise<void> {
  await call('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })
}

export async function listUsers(): Promise<ManagedUser[]> {
  const { users } = await call<{ users: ManagedUser[] }>('/api/users')
  return users
}

export async function createUser(username: string, password: string, role: Role): Promise<ManagedUser> {
  const { user } = await call<{ user: ManagedUser }>('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, role }),
  })
  return user
}

export async function updateUser(
  id: string,
  patch: { username?: string; password?: string; role?: Role },
): Promise<ManagedUser> {
  const { user } = await call<{ user: ManagedUser }>('/api/users', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
  return user
}

export async function deleteUser(id: string): Promise<void> {
  await call('/api/users', { method: 'DELETE', body: JSON.stringify({ id }) })
}
