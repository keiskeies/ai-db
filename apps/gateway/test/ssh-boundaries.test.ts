import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { utils: sshUtils } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2');
import { createKnownHostsVerifier, openTunnel } from '../src/drivers/ssh';

const keyPair = sshUtils.generateKeyPairSync('ed25519');
const otherKeyPair = sshUtils.generateKeyPairSync('ed25519');
const presented = sshUtils.parseKey(keyPair.public);
assert.ok(!(presented instanceof Error));
const publicKey = presented.getPublicSSH();

test('SSH rejects unknown hosts by default before opening a network connection', async () => {
  await assert.rejects(
    openTunnel({ enabled: true, host: '127.0.0.1', port: 22, user: 'root', authMethod: 'password' }, 'db.internal', 3306),
    (err: any) => err.code === 'SSH_HOST_KEY_UNKNOWN',
  );
});

test('known_hosts validates exact, wildcard, negated, port and hashed host patterns', () => {
  const exact = createKnownHostsVerifier(`db.example ${keyPair.public}`, 'db.example', 22);
  assert.equal(exact(publicKey), true);
  assert.equal(exact(sshUtils.parseKey(otherKeyPair.public) instanceof Error ? Buffer.alloc(0) : (sshUtils.parseKey(otherKeyPair.public) as Exclude<ReturnType<typeof sshUtils.parseKey>, Error>).getPublicSSH()), false);
  assert.equal(createKnownHostsVerifier(`*.example ${keyPair.public}`, 'db.example', 22)(publicKey), true);
  assert.equal(createKnownHostsVerifier(`*.example,!db.example ${keyPair.public}`, 'db.example', 22)(publicKey), false);
  assert.equal(createKnownHostsVerifier(`[db.example]:2222 ${keyPair.public}`, 'db.example', 2222)(publicKey), true);
  assert.equal(createKnownHostsVerifier(`[db.example]:2222 ${keyPair.public}`, 'db.example', 22)(publicKey), false);

  const salt = Buffer.from('test-salt');
  const hash = createHmac('sha1', salt).update('db.example').digest('base64');
  const hashed = createKnownHostsVerifier(`|1|${salt.toString('base64')}|${hash} ${keyPair.public}`, 'db.example', 22);
  assert.equal(hashed(publicKey), true);
});

test('SSH private-key files require explicit roots and symlinks are rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-ssh-keys-'));
  const allowed = join(dir, 'allowed');
  const outside = join(dir, 'outside.key');
  const inside = join(allowed, 'inside.key');
  const { mkdirSync, symlinkSync } = await import('node:fs');
  mkdirSync(allowed);
  writeFileSync(outside, keyPair.private);
  writeFileSync(inside, keyPair.private);
  const ssh = { enabled: true, host: '127.0.0.1', port: 22, user: 'root', authMethod: 'key' as const, privateKeyPath: outside };
  try {
    await assert.rejects(openTunnel(ssh, 'db.internal', 3306, {}, { privateKeyDirs: [allowed] }), (err: any) => err.code === 'SSH_KEY_PATH_DENIED');
    await assert.rejects(openTunnel({ ...ssh, privateKeyPath: inside }, 'db.internal', 3306, {}, { privateKeyDirs: [allowed] }), (err: any) => err.code === 'SSH_HOST_KEY_UNKNOWN');
    const link = join(allowed, 'linked.key');
    try {
      symlinkSync(outside, link);
    } catch (err: any) {
      if (err?.code !== 'EPERM') throw err;
      return;
    }
    await assert.rejects(openTunnel({ ...ssh, privateKeyPath: link }, 'db.internal', 3306, {}, { privateKeyDirs: [allowed] }), (err: any) => err.code === 'SSH_KEY_PATH_DENIED' || err.code === 'SSH_KEY_READ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
