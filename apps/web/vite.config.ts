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
  // GitHub Pages serves the demo under /IntegrAI/; production (Vercel/nginx)
  // keeps the root base. Set VITE_BASE_PATH at build time for subpath hosting.
  base: process.env.VITE_BASE_PATH ?? '/',
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
    // The production bundle calls a same-origin `/api/v1`; previewing it
    // locally against the real backend needs the same proxy as dev.
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
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: a product deploy only invalidates the app
        // chunk, so repeat visitors keep React/DS/icons cached. The DS and the
        // icon set are the heaviest dependencies of the main bundle.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          convergencia: ['@xploryng/convergencia'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
