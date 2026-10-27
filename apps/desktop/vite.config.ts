import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const bridgeUrl = process.env.AIDB_BRIDGE_URL ?? 'http://127.0.0.1:8787';
const bridgeWsUrl = bridgeUrl.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@aidb/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: bridgeUrl,
        changeOrigin: false,
      },
      '/ws': {
        target: bridgeWsUrl,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'chrome110',
    sourcemap: false,
  },
});
