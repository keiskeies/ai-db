import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import test, { after } from 'node:test';

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
const nativeOpened: string[] = [];
stubModule('react-native', { Platform: platform, ScrollView() {}, View() {} });
stubModule('expo-linking', {
  async openURL(url: string) { nativeOpened.push(url); },
});
stubModule('../src/theme.ts', { colors: {} });
stubModule('../src/styles.ts', { styles: {} });
stubModule('../src/components/base.tsx', { Text() {} });

const { getSafeMarkdownUrl, openMarkdownLink } = require('../src/components/markdown.tsx') as typeof import('../src/components/markdown');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

after(() => {
  platform.OS = 'web';
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as any).window;
});

test('Markdown 仅接受显式 http/https 绝对 URL，并返回规范化结果', () => {
  assert.equal(getSafeMarkdownUrl('https://example.com/docs?q=1#section'), 'https://example.com/docs?q=1#section');
  assert.equal(getSafeMarkdownUrl('HTTPS://Example.com'), 'https://example.com/');
  assert.equal(getSafeMarkdownUrl('http://127.0.0.1:8787/status'), 'http://127.0.0.1:8787/status');
  assert.equal(getSafeMarkdownUrl('https://[::1]/docs'), 'https://[::1]/docs');
});

test('Markdown 对抗样本拒绝脚本、文件、Intent、自定义 scheme、相对地址和歧义 URL', () => {
  const hostile = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert%281%29',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'intent://scan/#Intent;scheme=zxing;package=com.test;end',
    'aidb://pair?code=123456',
    'mailto:attacker@example.com',
    'tel:+123456789',
    'blob:https://example.com/id',
    'about:blank',
    '//attacker.example/path',
    '\\\\attacker.example\\path',
    '/relative/path',
    'relative/path',
    'example.com',
    'https:example.com',
    'https://',
    'https://example.com:bad',
    'https://user:password@example.com/',
    'https://exa mple.com/',
    'https://example.com\\@attacker.example/',
    '\u0000javascript:alert(1)',
    'java\nscript:alert(1)',
    '\thttps://example.com/',
  ];
  for (const value of hostile) assert.equal(getSafeMarkdownUrl(value), null, value);
});

test('原生 Markdown 链接只把校验后的 http/https URL 交给 Linking.openURL', () => {
  platform.OS = 'android';
  nativeOpened.length = 0;
  openMarkdownLink('HTTPS://Example.com/docs');
  assert.deepEqual(nativeOpened, ['https://example.com/docs']);

  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//attacker.example', 'intent://evil']) {
    openMarkdownLink(value);
  }
  assert.deepEqual(nativeOpened, ['https://example.com/docs']);
});

test('Web Markdown 链接使用 noopener 新标签，危险链接不触发 opener 或顶层导航', () => {
  platform.OS = 'web';
  nativeOpened.length = 0;
  const webOpened: unknown[][] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      open(...args: unknown[]) { webOpened.push(args); },
      get location() { throw new Error('top-level navigation must not be used'); },
    },
  });

  openMarkdownLink('https://example.com/docs');
  assert.deepEqual(webOpened, [['https://example.com/docs', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(nativeOpened, []);

  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', '//attacker.example', 'intent://evil', 'aidb://pair']) {
    openMarkdownLink(value);
  }
  assert.equal(webOpened.length, 1);
  assert.deepEqual(nativeOpened, []);
});

test('Markdown 渲染不把原始链接直接交给平台 opener，也不使用脚本或顶层导航 API', () => {
  const source = readFileSync(new URL('../src/components/markdown.tsx', import.meta.url), 'utf8');
  assert.match(source, /onPress=\{\(\) => openMarkdownLink\(link\[2\]\)\}/);
  assert.doesNotMatch(source, /Linking\.openURL\(link\[2\]\)/);
  assert.doesNotMatch(source, /window\.location|document\.write|\beval\s*\(/);
});
