#!/usr/bin/env node
const sub = process.argv[2];
if (sub === 'pair') {
  await import('./pair.mjs');
} else if (!sub || sub === 'serve' || sub === 'server') {
  await import('./server.mjs');
} else {
  process.stderr.write('用法: aidb-mcp [pair]\n  (无参数) 以 stdio MCP Server 运行\n  pair     一次性配对，写入本地只读凭据\n');
  process.exit(1);
}
