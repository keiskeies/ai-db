import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config';
import { SecretBox, SecretDecryptionError } from '../src/crypto';
import { Store } from '../src/store';

const MASTER = 'a'.repeat(64);

type SqliteStatement = ReturnType<DatabaseSync['prepare']> & { close?: () => void };

function closeStatement(statement: SqliteStatement): void {
  statement.close?.();
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'aidb-secret-boundary-'));
}

async function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('SecretBox emits v2, reads legacy v1 and fails closed on wrong keys or tampering', () => {
  const box = new SecretBox(MASTER);
  const encrypted = box.encrypt({ token: 'sensitive' });
  assert.match(encrypted, /^v2\./);
  assert.deepEqual(box.decrypt(encrypted), { token: 'sensitive' });
  assert.equal(box.decrypt(null), null);
  assert.equal(box.verifyCanary(box.canary()), true);

  const legacyKey = createHash('sha256').update(MASTER).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
  const encryptedLegacy = Buffer.concat([cipher.update(Buffer.from('{"legacy":true}')), cipher.final()]);
  const legacy = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encryptedLegacy.toString('base64')].join('.');
  assert.deepEqual(box.decrypt(legacy), { legacy: true });

  assert.throws(() => new SecretBox('b'.repeat(64)).decrypt(encrypted), SecretDecryptionError);
  const parts = encrypted.split('.');
  parts[3] = `${parts[3].slice(0, -4)}AAAA`;
  assert.throws(() => box.decrypt(parts.join('.')), SecretDecryptionError);
  for (const malformed of ['garbage', 'v3.a.b.c', 'v2.not-base64.a.b']) {
    assert.throws(() => box.decrypt(malformed), SecretDecryptionError);
  }
});

test('development key creation is atomic, versioned and protected', async () => {
  const home = tempHome();
  try {
    await withEnv({ AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined, NODE_ENV: 'development' }, () => {
      const config = loadConfig({ home });
      const file = join(home, 'secret');
      assert.equal(existsSync(file), true);
      assert.deepEqual(readdirSync(home).filter((name) => name.endsWith('.tmp')), []);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(saved.version, 1);
      assert.equal(saved.secret, config.secret);
      assert.equal(new SecretBox(config.secret).verifyCanary(saved.canary), true);
      assert.equal(config.secretVersion, 2);
      assert.deepEqual(loadConfig({ home }).secret, config.secret);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('production rejects missing keys, wrong inline keys and mismatched local canaries', async () => {
  const home = tempHome();
  try {
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => {
      assert.throws(() => loadConfig({ home }), (err: any) => err.code === 'AIDB_MASTER_KEY_INVALID');
    });
    const box = new SecretBox(MASTER);
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: MASTER, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: box.canary() }, () => {
      assert.equal(loadConfig({ home }).secret, MASTER);
    });
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: 'b'.repeat(64), AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: box.canary() }, () => {
      assert.throws(() => loadConfig({ home }), (err: any) => err.code === 'AIDB_MASTER_KEY_INVALID');
    });
    await withEnv({ NODE_ENV: 'development', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => { loadConfig({ home }); });
    const keyFile = join(home, 'secret');
    const saved = JSON.parse(readFileSync(keyFile, 'utf8'));
    saved.canary = box.canary();
    writeFileSync(keyFile, JSON.stringify(saved));
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => {
      assert.throws(() => loadConfig({ home }), (err: any) => err.code === 'AIDB_MASTER_KEY_INVALID');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('production desktop opt-in creates a protected local key and reuses it on restart', async () => {
  const home = tempHome();
  try {
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: '1', AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => {
      const config = loadConfig({ home });
      const saved = JSON.parse(readFileSync(join(home, 'secret'), 'utf8'));
      assert.equal(saved.secret, config.secret);
      assert.equal(new SecretBox(config.secret).verifyCanary(saved.canary), true);
      assert.equal(loadConfig({ home }).secret, config.secret);
      assert.deepEqual(readdirSync(home).filter((name) => name.endsWith('.tmp')), []);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('production local-key migration preserves the master key and existing ciphertext', async () => {
  const home = tempHome();
  const dbPath = join(home, 'aidb.db');
  let legacySecret = '';
  try {
    await withEnv({ NODE_ENV: 'development', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => {
      const config = loadConfig({ home });
      const store = new Store(dbPath, config.secret);
      try {
        const settings = store.getSettings();
        settings.agent.apiKey = 'sk-preserve-through-migration';
        store.saveSettings(settings);
      } finally {
        store.close();
      }
      legacySecret = config.secret;
      writeFileSync(join(home, 'secret'), `${legacySecret}\n`);
    });
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => {
      assert.throws(() => loadConfig({ home }), (error: any) => error.code === 'AIDB_MASTER_KEY_INVALID');
      assert.equal(readFileSync(join(home, 'secret'), 'utf8').trim(), legacySecret);
    });
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: '1', AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => {
      const config = loadConfig({ home });
      const saved = JSON.parse(readFileSync(join(home, 'secret'), 'utf8'));
      assert.equal(saved.version, 1);
      assert.equal(saved.secret, legacySecret);
      assert.equal(config.secret, legacySecret);
      assert.equal(new SecretBox(config.secret).verifyCanary(saved.canary), true);
      const store = new Store(dbPath, config.secret);
      try {
        assert.equal(store.getModelApiKey('default'), 'sk-preserve-through-migration');
      } finally {
        store.close();
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secret-manager key file can supply its own production canary', async () => {
  const home = tempHome();
  const mounted = tempHome();
  try {
    await withEnv({ NODE_ENV: 'development', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: undefined, AIDB_SECRET_FILE: undefined, AIDB_SECRET_CANARY: undefined }, () => {
      // 用本地安全发布路径生成等效的 secret-manager 挂载文件，避免测试绕过 ACL 校验。
      loadConfig({ home: mounted });
      const file = join(mounted, 'secret');
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      saved.secret = MASTER;
      saved.canary = new SecretBox(MASTER).canary();
      writeFileSync(file, JSON.stringify(saved));
    });
    await withEnv({ NODE_ENV: 'production', AIDB_ALLOW_LOCAL_KEY: undefined, AIDB_SECRET: undefined, AIDB_SECRET_FILE: join(mounted, 'secret'), AIDB_SECRET_CANARY: undefined }, () => {
      assert.equal(loadConfig({ home }).secret, MASTER);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(mounted, { recursive: true, force: true });
  }
});

test('wrong-key reads throw without overwriting existing ciphertext', () => {
  const home = tempHome();
  const dbPath = join(home, 'aidb.db');
  const store = new Store(dbPath, MASTER);
  try {
    const settings = store.getSettings();
    settings.agent.apiKey = 'sk-do-not-overwrite';
    store.saveSettings(settings);
    const raw = new DatabaseSync(dbPath);
    const beforeStatement = raw.prepare("SELECT value FROM settings WHERE key = 'agentApiKey'") as SqliteStatement;
    const before = beforeStatement.get() as { value: string };
    closeStatement(beforeStatement);
    raw.close();
    assert.throws(() => new Store(dbPath, 'b'.repeat(64)), SecretDecryptionError);
    const after = new DatabaseSync(dbPath);
    const afterStatement = after.prepare("SELECT value FROM settings WHERE key = 'agentApiKey'") as SqliteStatement;
    const ciphertext = afterStatement.get() as { value: string };
    closeStatement(afterStatement);
    after.close();
    assert.equal(ciphertext.value, before.value);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
