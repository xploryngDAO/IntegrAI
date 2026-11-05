import { defineConfig } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

// SAC Hub web app. The API client falls back to the in-memory mock dataset when
// `/api` is unreachable, so `npm run dev` alone gives a complete demo.
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
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
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
