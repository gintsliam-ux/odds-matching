import { createContext, useContext } from 'react'
import type { User, UserPrefs } from './auth'

// Context and hook live apart from <AuthProvider> so that file exports only a
// component — mixing the two breaks React Fast Refresh for everything that
// imports it.

export interface AuthState {
  user: User | null
  /** True until the first `me()` resolves — the app shows nothing rather than
   *  flashing the login page at someone who is already signed in. */
  loading: boolean
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  setPrefs: (prefs: UserPrefs) => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>')
  return v
}
