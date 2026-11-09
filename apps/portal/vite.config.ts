import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Only /v1 is proxied. The root .env (DB/passwords) is never loaded into the browser build.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/v1': { target: process.env.PORTAL_API_TARGET ?? 'http://127.0.0.1:8080' } },
  },
});
