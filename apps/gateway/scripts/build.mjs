import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  sourcemap: true,
  external: ['ssh2', 'pg-native', 'cpu-features', 'bufferutil', 'utf-8-validate', '@duckdb/node-bindings', '@duckdb/node-bindings-*'],
  banner: {
    js: "import { createRequire as __aidbCreateRequire } from 'node:module';\nconst require = __aidbCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
writeFileSync('dist/package.json', JSON.stringify({ type: 'module' }, null, 2));
console.log('gateway bundle written to dist/index.js');
