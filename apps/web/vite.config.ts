import { defineConfig } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

// SAC Hub web app. In development both `/api` and the Socket.IO handshake are
// proxied to the real backend on :4000; production serves the built assets
// behind the same API origin.
//
// `react()` is typed against the hoisted Vite 5 copy of @vitejs/plugin-react
// while this workspace runs Vite 6; the cast keeps the config type-checking
// while staying runtime-compatible (the plugin API is stable across both).
export default defineConfig({
  plugins: [react() as unknown as PluginOption],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
