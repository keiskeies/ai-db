import { listenRandom } from './helpers';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ClickHouseDriver } from '../src/drivers/clickhouse';

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const reply = () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ meta: [{ name: 'n', type: 'UInt8' }], data: [[1]] }));
    };
    if (body.includes('slow=1')) setTimeout(reply, 1500);
    else reply();
  });
});
await listenRandom(server);
after(() => server.close());
const port = (server.address() as any).port;

test('ClickHouse 查询超时返回 CLICKHOUSE_TIMEOUT', async () => {
  const driver = new ClickHouseDriver({ host: '127.0.0.1', port, user: 'default' });
  await assert.rejects(
    driver.runParams('SELECT sleep(1) /* slow=1 */', [], { timeoutMs: 150 }),
    (err: any) => err?.code === 'CLICKHOUSE_TIMEOUT',
  );
});

test('ClickHouse 正常响应不受超时影响', async () => {
  const driver = new ClickHouseDriver({ host: '127.0.0.1', port, user: 'default' });
  const result = await driver.runParams('SELECT 1', [], { timeoutMs: 2000 });
  assert.equal(result.rows[0][0], 1);
});
