import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

// Lazily created so the app still boots on mock data with no env configured.
let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!url || !key) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
  }
  if (!client) client = createClient(url, key)
  return client
}
