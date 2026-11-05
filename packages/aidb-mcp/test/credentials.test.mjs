import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credentialsPath, readCredentials, writeCredentials, atomicWriteCredentials } from '../bin/credentials.mjs';

const home = mkdtempSync(join(tmpdir(), 'aidb-mcp-creds-'));
test.after(() => rmSync(home, { recursive: true, force: true }));

test('writeCredentials/readCredentials round-trip and use a private file', () => {
  const file = join(home, 'sub', 'credentials.json');
  process.env.AIDB_MCP_CREDENTIALS = file;
  const input = { url: 'http://127.0.0.1:8787', token: 'test-token', deviceId: 'dev-1', pairedAt: '2026-11-05T00:00:00.000Z' };
  writeCredentials(input);
  assert.equal(credentialsPath(), file);
  assert.deepEqual(readCredentials(), input);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  delete process.env.AIDB_MCP_CREDENTIALS;
});

test('writeCredentials overwrites an existing credential file', () => {
  const file = join(home, 'overwrite.json');
  process.env.AIDB_MCP_CREDENTIALS = file;
  const first = { url: 'http://a', token: 'old', deviceId: 'd1', pairedAt: 'p1' };
  const second = { url: 'http://b', token: 'new', deviceId: 'd2', pairedAt: 'p2' };
  writeCredentials(first);
  writeCredentials(second);
  assert.deepEqual(readCredentials(), second);
  delete process.env.AIDB_MCP_CREDENTIALS;
});

test('a failed rename preserves the previous credential', () => {
  const file = join(home, 'atomic', 'credentials.json');
  mkdirSync(join(home, 'atomic'), { recursive: true });
  const first = { url: 'http://a', token: 'old-valid-token', deviceId: 'd1', pairedAt: 'p1' };
  writeFileSync(file, JSON.stringify(first, null, 2) + '\n');
  const failingIo = {
    writeFileSync,
    renameSync: () => { throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' }); },
    unlinkSync: () => {},
    chmodSync: () => {},
  };
  assert.throws(
    () => atomicWriteCredentials(file, { url: 'http://b', token: 'new', deviceId: 'd2', pairedAt: 'p2' }, failingIo),
    /EPERM/,
  );
  // 关键契约：旧凭据仍然原封不动，用户不需要重新配对。
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'old-valid-token');
});

test('readCredentials throws a clear error when no credential exists', () => {
  process.env.AIDB_MCP_CREDENTIALS = join(home, 'missing.json');
  assert.throws(() => readCredentials(), /npx -y @aidb\/mcp pair/);
  delete process.env.AIDB_MCP_CREDENTIALS;
});
