import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import test, { after, beforeEach } from 'node:test';

const require = createRequire(import.meta.url);

function stubModule(id: string, exports: unknown) {
  const filename = require.resolve(id);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const platform = { OS: 'web' };
const secureValues = new Map<string, string>();
const secureCalls: string[] = [];
stubModule('react-native', { Platform: platform });
stubModule('expo-secure-store', {
  async getItemAsync(key: string) { secureCalls.push(`get:${key}`); return secureValues.get(key) ?? null; },
  async setItemAsync(key: string, value: string) { secureCalls.push(`set:${key}`); secureValues.set(key, value); },
  async deleteItemAsync(key: string) { secureCalls.push(`delete:${key}`); secureValues.delete(key); },
});

const bridgePath = require.resolve('../src/bridge.ts');
const freshBridge = () => {
  delete require.cache[bridgePath];
  return require(bridgePath) as typeof import('../src/bridge');
};
const storageValues = new Map<string, string>();
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key: string) { return storageValues.get(key) ?? null; },
    setItem(key: string, value: string) { storageValues.set(key, value); },
    removeItem(key: string) { storageValues.delete(key); },
  },
});

beforeEach(() => {
  platform.OS = 'web';
  storageValues.clear();
  secureValues.clear();
  secureCalls.length = 0;
  delete require.cache[bridgePath];
});

after(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as any).localStorage;
});

test('Web bearer 配置只存在模块内存，刷新后不可恢复，也不会写入 localStorage/sessionStorage', async () => {
  const bridge = freshBridge();
  const config = { baseUrl: 'http://127.0.0.1:8787', token: 'reusable-bearer-secret', deviceId: 'device-1' };
  await bridge.saveBridgeConfig(config);

  assert.deepEqual(await bridge.loadBridgeConfig(), config);
  assert.equal(storageValues.size, 0);
  assert.deepEqual(secureCalls, []);

  const reloaded = freshBridge();
  assert.equal(await reloaded.loadBridgeConfig(), null);
  assert.equal(storageValues.size, 0);
});

test('Web 启动会删除并忽略旧版 localStorage 中的 bearer 凭据', async () => {
  storageValues.set('aidb.bridge.v1', JSON.stringify({ baseUrl: 'http://bridge.test', token: 'legacy-secret' }));
  const bridge = freshBridge();

  assert.equal(await bridge.loadBridgeConfig(), null);
  assert.equal(storageValues.has('aidb.bridge.v1'), false);
});

test('断开连接会清除 Web 内存凭据和旧版 localStorage 残留', async () => {
  const bridge = freshBridge();
  await bridge.saveBridgeConfig({ baseUrl: 'http://bridge.test', token: 'secret' });
  storageValues.set('aidb.bridge.v1', JSON.stringify({ token: 'legacy-secret' }));

  await bridge.clearBridgeConfig();
  assert.equal(await bridge.loadBridgeConfig(), null);
  assert.equal(storageValues.size, 0);
});

test('原生平台继续使用 SecureStore 保存、读取和删除完整配对配置', async () => {
  platform.OS = 'ios';
  const bridge = freshBridge();
  const config = { baseUrl: 'http://127.0.0.1:8787', token: 'native-secret', deviceId: 'device-2' };

  await bridge.saveBridgeConfig(config);
  assert.deepEqual(await bridge.loadBridgeConfig(), config);
  assert.deepEqual(JSON.parse(secureValues.get('aidb.bridge.v1')!), config);
  assert.equal(storageValues.size, 0);

  await bridge.clearBridgeConfig();
  assert.equal(await bridge.loadBridgeConfig(), null);
  assert.equal(secureValues.has('aidb.bridge.v1'), false);
  assert.deepEqual(secureCalls, ['set:aidb.bridge.v1', 'get:aidb.bridge.v1', 'delete:aidb.bridge.v1', 'get:aidb.bridge.v1']);
});

test('bridge 持久化实现不保留 Web Storage 写入通道', () => {
  const source = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage\s*\.\s*setItem|localStorage\?\.setItem|sessionStorage/);
  assert.match(source, /let webBridgeConfig: BridgeConfig \| null = null/);
  assert.match(source, /await SecureStore\.setItemAsync\(KEY, JSON\.stringify\(config\)\)/);
});
