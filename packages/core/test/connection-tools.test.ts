import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCall, getTool, redactToolSecrets, toolSignature } from '../src/index';

test('connection tools expose the intended risk and never accept a password field', () => {
  const probe = getTool('probe_engine')!;
  const create = getTool('create_connection')!;
  assert.equal(probe.risk, 'read');
  assert.equal(create.risk, 'write');
  assert.equal(probe.inputSchema.additionalProperties, false);
  assert.equal(create.inputSchema.additionalProperties, false);
  assert.ok(!('password' in probe.inputSchema.properties));
  assert.ok(!('password' in create.inputSchema.properties));
  assert.ok('passwordRef' in create.inputSchema.properties);
});

test('connection approvals describe the endpoint and signatures are scoped to it', () => {
  const call = { id: '1', name: 'create_connection', args: { name: 'same-name', engine: 'mysql', host: '192.168.1.7', port: 3306 } };
  assert.match(describeCall(call).summary, /192\.168\.1\.7:3306/);
  assert.match(toolSignature(call), /^create_connection:<unscoped>:<unscoped>:[a-f0-9]{64}$/);
  assert.notEqual(toolSignature(call), toolSignature({ ...call, args: { ...call.args, host: '192.168.1.8' } }));
  assert.notEqual(toolSignature(call), toolSignature({ ...call, args: { ...call.args, username: 'admin' } }));
  assert.notEqual(toolSignature(call), toolSignature({ ...call, args: { ...call.args, skipProbe: true } }));
  assert.notEqual(toolSignature(call), toolSignature({ ...call, args: { ...call.args, sslInsecure: true } }));
});

test('secret redaction is recursive and leaves non-secret arguments intact', () => {
  assert.deepEqual(redactToolSecrets({ password: 'p', Password: 'P', nested: { passphrase: 'q', ssh_password: 's', value: 1 }, list: [{ SSH_PRIVATE_KEY: 'k' }] }), {
    password: '***', Password: '***', nested: { passphrase: '***', ssh_password: '***', value: 1 }, list: [{ SSH_PRIVATE_KEY: '***' }],
  });
});
