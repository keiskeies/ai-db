import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { test } from 'node:test';
import { FalkorDriver } from '../src/drivers/falkordb';
import { RedisDriver } from '../src/drivers/redis';
import { withQueryTimeout } from '../src/drivers/timeout';

/**
 * 假 Redis：只回应握手类命令，数据命令一律不回包。
 * 这样 ioredis 能完成连接，真正卡住的是 GET / GRAPH.QUERY。
 */
async function blackhole(): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (!buffer.startsWith('*')) break;
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) break;
        const count = Number(buffer.slice(1, eol));
        let cursor = eol + 2;
        const args: string[] = [];
        let complete = true;
        for (let i = 0; i < count; i += 1) {
          if (buffer[cursor] !== '$') { complete = false; break; }
          const lineEnd = buffer.indexOf('\r\n', cursor);
          if (lineEnd < 0) { complete = false; break; }
          const length = Number(buffer.slice(cursor + 1, lineEnd));
          const start = lineEnd + 2;
          if (buffer.length < start + length + 2) { complete = false; break; }
          args.push(buffer.slice(start, start + length));
          cursor = start + length + 2;
        }
        if (!complete) break;
        buffer = buffer.slice(cursor);
        const command = (args[0] ?? '').toUpperCase();
        if (command === 'PING') socket.write('+PONG\r\n');
        else if (command === 'INFO') socket.write('$0\r\n\r\n');
        else if (['CLIENT', 'SELECT', 'AUTH', 'COMMAND', 'CONFIG', 'HELLO'].includes(command)) socket.write('+OK\r\n');
        // GET / GRAPH.QUERY 故意不回复
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test('Redis command times out and drops the stalled connection', async () => {
  const { port, close } = await blackhole();
  const driver = new RedisDriver({ host: '127.0.0.1', port });
  try {
    const started = Date.now();
    await assert.rejects(
      driver.executeQuery({ language: 'redis', command: 'GET', args: ['slow'] }, { database: '0', timeoutMs: 80 }),
      (err: any) => err.code === 'REDIS_TIMEOUT' && err.status === 504,
    );
    assert.ok(Date.now() - started < 3000, '应在超时后立即返回，而不是等服务器回包');
  } finally {
    await driver.close();
    close();
  }
});

test('FalkorDB query times out instead of hanging forever', async () => {
  const { port, close } = await blackhole();
  const driver = new FalkorDriver({ host: '127.0.0.1', port, database: 'g' });
  try {
    await assert.rejects(
      driver.executeQuery({ language: 'cypher', text: 'MATCH (n) RETURN n' }, { database: 'g', timeoutMs: 80 }),
      (err: any) => err.code === 'FALKOR_TIMEOUT' && err.status === 504,
    );
  } finally {
    await driver.close();
    close();
  }
});

test('DM timeout helper returns 504 and runs the cleanup hook', async () => {
  let cleaned = false;
  await assert.rejects(
    withQueryTimeout(new Promise(() => undefined), 40, {
      code: 'DM_TIMEOUT',
      label: '达梦查询',
      onTimeout: () => { cleaned = true; },
    }),
    (err: any) => err.code === 'DM_TIMEOUT' && err.status === 504,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cleaned, true);
});

test('DM timeout helper leaves fast queries untouched', async () => {
  const value = await withQueryTimeout(Promise.resolve(42), 1000, { code: 'DM_TIMEOUT', label: '达梦查询' });
  assert.equal(value, 42);
});
