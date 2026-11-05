#!/usr/bin/env node
/** One-time pairing: exchange a 6-digit desktop code for a read-only device token. */
import { stdout as output } from 'node:process';
import { writeCredentials } from './credentials.mjs';

/**
 * 把用户输入与 claim 响应合成要落盘的凭据。
 * 只使用「用户刚输入且刚刚成功连通」的 URL，不采用响应里的 bridge.url：
 * 反代 / AIDB_PUBLIC_URL 场景下那是公网地址，本机 MCP server 未必可达。
 */
export function credentialsFromClaim(url, body) {
  if (typeof body?.token !== 'string' || !body.token) {
    throw new Error('配对响应缺少设备令牌，请确认 Bridge 版本后重试');
  }
  return {
    url,
    token: body.token,
    deviceId: body.device?.id ?? '',
    pairedAt: new Date().toISOString(),
  };
}

export async function runPair(io = {}) {
  const ask = io.ask;
  const log = io.log ?? ((text) => output.write(text + '\n'));
  const write = io.writeCredentials ?? writeCredentials;
  const fetchImpl = io.fetch ?? fetch;

  const code = (await ask('输入 AiDB 桌面端 设置 → Bridge → 为移动端配对 显示的 6 位配对码: ')).trim();
  if (!/^\d{6}$/.test(code)) {
    log('配对码必须是 6 位数字');
    return { ok: false };
  }
  const urlRaw = (await ask('Bridge 地址 [http://127.0.0.1:8787]: ')).trim();
  const url = (urlRaw || process.env.AIDB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

  let response;
  try {
    response = await fetchImpl(`${url}/api/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Claude Code', platform: 'claude-code', scope: 'mcp:readonly' }),
    });
  } catch (err) {
    log(`无法连接 Bridge（${url}）：${err.message}`);
    return { ok: false };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    log(`配对失败：${body?.error?.message ?? `HTTP ${response.status}`}`);
    return { ok: false };
  }
  let credentials;
  try {
    credentials = credentialsFromClaim(url, body);
  } catch (err) {
    log(err.message);
    return { ok: false };
  }
  const file = write(credentials);
  log(`配对成功，设备 ${body.device?.name ?? 'Claude Code'}（${body.device?.id ?? ''}）`);
  log(`凭据已写入 ${file}`);
  log('现在可以在 Claude Code 中使用：npx -y @aidb/mcp');
  log('如需撤销：AiDB 桌面端 设置 → 设备 → 吊销');
  return { ok: true, file, credentials };
}

