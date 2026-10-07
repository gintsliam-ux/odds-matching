import { createContext } from 'react'
import type { SessionUser } from './authApi'

export interface AuthValue {
  user: SessionUser | null
  /** False until the initial session check finishes, so we don't flash the login page. */
  ready: boolean
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthValue | null>(null)
