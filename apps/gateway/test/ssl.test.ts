import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeTlsOptions, tlsDispatcher, trustServerCertificate } from '../src/drivers/ssl';

test('TLS flags map to each driver’s own verification knob', () => {
  assert.equal(nodeTlsOptions({}), undefined);
  assert.deepEqual(nodeTlsOptions({ ssl: true }), { rejectUnauthorized: true });
  assert.deepEqual(nodeTlsOptions({ ssl: true, sslInsecure: true }), { rejectUnauthorized: false });
  // 不校验只在真的开了加密时生效，否则等于悄悄放宽了明文连接。
  assert.equal(trustServerCertificate({ sslInsecure: true }), false);
  assert.equal(trustServerCertificate({ ssl: true }), false);
  assert.equal(trustServerCertificate({ ssl: true, sslInsecure: true }), true);
});

test('insecure dispatcher is only created for encrypted self-signed endpoints', async () => {
  assert.equal(tlsDispatcher({ ssl: true }), undefined);
  assert.equal(tlsDispatcher({ sslInsecure: true }), undefined);
  const agent = tlsDispatcher({ ssl: true, sslInsecure: true });
  assert.ok(agent);
  await agent.close();
});
