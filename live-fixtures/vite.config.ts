import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { swiftApiPlugin } from './scripts/vite-swift-api'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Make MONGO_* and VITE_SUPABASE_* visible to the dev middleware.
  // Mongo for SWIFT reads; Supabase for the actual-start side-effect write.
  const env = loadEnv(mode, process.cwd(), ['MONGO_', 'VITE_SUPABASE_'])
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
  return {
    plugins: [react(), swiftApiPlugin()],
  }
})
