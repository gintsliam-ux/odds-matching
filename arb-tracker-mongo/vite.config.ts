import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.API_PORT || 5174);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    // The app talks to Mongo through our own API (server/index.mjs). Proxying it
    // here means the browser only ever sees one origin, so there is no CORS to
    // configure and `VITE_API_BASE` can stay empty in dev.
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
