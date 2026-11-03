import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePairingPayload } from '../src/pairing';

test('解析带公网地址的配对二维码', () => {
  const payload = JSON.stringify({ v: 1, url: 'https://db.keiskei.top', host: 'db.keiskei.top', port: 443, code: '123456' });
  assert.deepEqual(parsePairingPayload(payload), { url: 'https://db.keiskei.top', code: '123456', host: 'db.keiskei.top', port: 443 });
});

test('旧版载荷缺 url 时按 host/port 组装', () => {
  const payload = JSON.stringify({ v: 1, host: '192.168.1.10', port: 8787, code: '654321' });
  assert.deepEqual(parsePairingPayload(payload), { url: 'http://192.168.1.10:8787', code: '654321', host: '192.168.1.10', port: 8787 });
});

test('https 未写端口时补 443', () => {
  const parsed = parsePairingPayload(JSON.stringify({ url: 'https://db.example.com', code: '111111' }));
  assert.equal(parsed.port, 443);
});

test('拒绝非 6 位配对码', () => {
  assert.throws(() => parsePairingPayload(JSON.stringify({ url: 'http://127.0.0.1:8787', code: '12ab' })), /6 位配对码/);
});

test('拒绝非 http(s) 地址', () => {
  assert.throws(() => parsePairingPayload(JSON.stringify({ url: 'ftp://127.0.0.1', code: '123456' })), /http\/https/);
});

test('拒绝非 JSON 内容', () => {
  assert.throws(() => parsePairingPayload('hello'), /有效的配对信息/);
});
