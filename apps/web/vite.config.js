import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One origin in every environment: the bundle calls the relative '/api' (and
// '/api/ws'). In dev the proxy below forwards it to the API; in the container,
// nginx.conf does the same. Only a split deployment (API on another host) sets
// VITE_API_URL / VITE_WS_URL at build time — see .env.example.
const API_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    // Bind every interface so the dev server is reachable from outside the
    // container / from a phone on the same network (a whiteboard on a phone is
    // a real use case, not a hypothetical).
    host: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // ws: true is NOT optional. Without it the dev server accepts the TCP
        // connection and never forwards the HTTP Upgrade header, so the realtime
        // client silently fails to connect and live collaboration looks broken
        // in dev only — production through nginx works fine, which is what makes
        // this bug so annoying to find.
        ws: true,
      },
    },
  },

  preview: {
    port: 4173,
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Chunks that only change when a dependency changes, so a normal
        // deploy leaves them byte-identical and the browser reuses the cache.
        // `draw` is the hand-drawn renderer's two libraries.
        manualChunks: {
          vendor: ['react', 'react-dom', 'zustand'],
          query: ['@tanstack/react-query'],
          draw: ['roughjs', 'perfect-freehand'],
        },
      },
    },
  },
});
