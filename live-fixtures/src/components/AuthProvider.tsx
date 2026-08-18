import { useCallback, useEffect, useState } from 'react'
import { auth, type User, type UserPrefs } from '../lib/auth'
import { AuthContext } from '../lib/authContext'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    auth
      .me()
      .then((u) => alive && setUser(u))
      // A failure here means "not signed in" as far as the UI is concerned;
      // the login page will surface the real error when they try.
      .catch(() => alive && setUser(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const signIn = useCallback(async (username: string, password: string) => {
    setUser(await auth.login(username, password))
  }, [])

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {})
    setUser(null)
  }, [])

  // Optimistic: the switches should feel instant, and a failed write only means
  // the preference doesn't follow you to another browser.
  const setPrefs = useCallback(async (prefs: UserPrefs) => {
    setUser((u) => (u ? { ...u, prefs } : u))
    const saved = await auth.savePrefs(prefs).catch(() => null)
    if (saved) setUser(saved)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, setPrefs }}>
      {children}
    </AuthContext.Provider>
  )
}
