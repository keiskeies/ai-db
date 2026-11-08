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
    // ESM 输出里没有 CommonJS 的 __dirname/__filename，而被打进 bundle 的依赖仍在用它们：
    // node-oracledb 拼「找不到原生绑定」的诊断信息、tedious 的错误栈优化都会走 __dirname。
    // 不补这两个变量，出错时会变成 ReferenceError 覆盖掉真实原因。
    js: [
      "import { createRequire as __aidbCreateRequire } from 'node:module';",
      "import { fileURLToPath as __aidbFileURLToPath } from 'node:url';",
      "import { dirname as __aidbDirname } from 'node:path';",
      'const require = __aidbCreateRequire(import.meta.url);',
      'const __filename = __aidbFileURLToPath(import.meta.url);',
      'const __dirname = __aidbDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});
writeFileSync('dist/package.json', JSON.stringify({ type: 'module' }, null, 2));
console.log('gateway bundle written to dist/index.js');
