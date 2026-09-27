import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app is served from / by nginx and talks to the API on another origin.
// In dev everything is same-origin through the proxy below, so relative URLs
// ('/api') work in both environments.
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
        // Three chunks that only change when a dependency changes, so a normal
        // deploy leaves them byte-identical and the browser reuses the cache.
        manualChunks: {
          vendor: ['react', 'react-dom', 'zustand'],
          query: ['@tanstack/react-query'],
          flow: ['reactflow', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/modifiers'],
        },
      },
    },
  },
});
