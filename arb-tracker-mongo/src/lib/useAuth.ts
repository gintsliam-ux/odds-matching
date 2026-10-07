import { useContext } from 'react'
import { AuthContext, type AuthValue } from './authContext'

export function useAuth(): AuthValue {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth must be used inside AuthProvider')
  return v
}
