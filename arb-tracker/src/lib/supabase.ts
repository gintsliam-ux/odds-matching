import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Layout-first build: the board renders off mock data, so a missing key is a
// warning, not a hard crash. Wire VITE_SUPABASE_ANON_KEY when connecting live.
export const hasSupabaseCredentials = Boolean(supabaseUrl && supabaseAnonKey);

if (!hasSupabaseCredentials) {
  // eslint-disable-next-line no-console
  console.warn(
    '[arb-tracker] Supabase credentials missing — running on mock data. ' +
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env to go live.',
  );
}

export const supabase: SupabaseClient | null = hasSupabaseCredentials
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;
