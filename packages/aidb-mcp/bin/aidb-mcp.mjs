#!/usr/bin/env node
const sub = process.argv[2];
if (sub === 'pair') {
  // 通过参数显式告知 pair.mjs 它是 CLI 入口（dispatcher 下 argv[1] 不是它自己）。
  const { runPair } = await import('./pair.mjs');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  const result = await runPair({ ask });
  rl.close();
  if (!result.ok) process.exit(1);
} else if (!sub || sub === 'serve' || sub === 'server') {
  await import('./server.mjs');
} else {
  process.stderr.write('用法: aidb-mcp [pair]\n  (无参数) 以 stdio MCP Server 运行\n  pair     一次性配对，写入本地只读凭据\n');
  process.exit(1);
}
