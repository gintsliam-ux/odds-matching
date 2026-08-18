import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { swiftApiPlugin } from './scripts/vite-swift-api'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Make MONGO_*, VITE_SUPABASE_* and AUTH_SECRET visible to the dev middleware.
  // Mongo for SWIFT reads; Supabase for the actual-start side-effect write;
  // AUTH_SECRET signs the session cookie in api/auth.ts. loadEnv filters by
  // PREFIX, so a bare name has to be listed as its own (complete) prefix.
  const env = loadEnv(mode, process.cwd(), ['MONGO_', 'VITE_SUPABASE_', 'AUTH_SECRET'])
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
  return {
    plugins: [react(), swiftApiPlugin()],
  }
})
