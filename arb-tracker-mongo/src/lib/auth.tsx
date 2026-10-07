import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { fetchMe, login as apiLogin, logout as apiLogout, type SessionUser } from './authApi'
import { AuthContext } from './authContext'

const REVALIDATE_MS = 30 * 60 * 1000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchMe()
      .then((u) => {
        if (!cancelled) setUser(u)
      })
      // Couldn't reach the server at all — nothing better to do than ask for a
      // sign-in, but only after fetchMe has already retried.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Re-check while a tab is open: on focus, and on a slow timer for a tab left
  // sitting on the meetings list all day. Each check slides the cookie forward,
  // so an in-use desk never expires. Only a real 401 clears the user — a failed
  // check is left alone.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const check = () => {
      fetchMe()
        .then((u) => {
          if (!cancelled && u === null) setUser(null)
        })
        .catch(() => {})
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    const timer = window.setInterval(check, REVALIDATE_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user])

  const signIn = useCallback(async (username: string, password: string) => {
    setUser(await apiLogin(username, password))
  }, [])

  const signOut = useCallback(async () => {
    await apiLogout()
    setUser(null)
  }, [])

  return <AuthContext.Provider value={{ user, ready, signIn, signOut }}>{children}</AuthContext.Provider>
}
