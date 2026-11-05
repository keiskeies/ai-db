#!/usr/bin/env node
/** One-time pairing: exchange a 6-digit desktop code for a read-only device token. */
import { createInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { writeCredentials } from './credentials.mjs';

const rl = createInterface({ input, output });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

const code = (await ask('输入 AiDB 桌面端 设置 → Bridge → 为移动端配对 显示的 6 位配对码: ')).trim();
if (!/^\d{6}$/.test(code)) {
  output.write('配对码必须是 6 位数字\n');
  rl.close();
  process.exit(1);
}
const urlRaw = (await ask('Bridge 地址 [http://127.0.0.1:8787]: ')).trim();
const url = (urlRaw || process.env.AIDB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
rl.close();

let response;
try {
  response = await fetch(`${url}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Claude Code', platform: 'claude-code', scope: 'mcp:readonly' }),
  });
} catch (err) {
  output.write(`无法连接 Bridge（${url}）：${err.message}\n`);
  process.exit(1);
}
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  output.write(`配对失败：${body?.error?.message ?? `HTTP ${response.status}`}\n`);
  process.exit(1);
}

const file = writeCredentials({
  url: body.bridge?.url || url,
  token: body.token,
  deviceId: body.device?.id ?? '',
  pairedAt: new Date().toISOString(),
});
output.write(`配对成功，设备 ${body.device?.name ?? 'Claude Code'}（${body.device?.id ?? ''}）\n`);
output.write(`凭据已写入 ${file}\n`);
output.write('现在可以在 Claude Code 中使用：npx -y @aidb/mcp\n');
output.write('如需撤销：AiDB 桌面端 设置 → 设备 → 吊销\n');
