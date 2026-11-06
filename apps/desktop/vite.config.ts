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
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](codemirror|@codemirror|@lezer)[\\/]/.test(id)) return 'vendor-codemirror';
          if (/[\\/]node_modules[\\/](react-markdown|remark-|micromark|mdast-|unist-|decode-named|character-entities|devlop|hast-|property-information|space-separated|html-url-|trim-|zwitch|bail|vfile|is-plain-obj|ccount|escape-string-regexp|markdown-table|parse-entities)/.test(id)) return 'vendor-markdown';
          if (/[\\/]node_modules[\\/]qrcode[\\/]/.test(id)) return 'vendor-qrcode';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
});
