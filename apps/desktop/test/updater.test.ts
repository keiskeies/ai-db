import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// 纯逻辑模块是 CommonJS（主进程直接用），这里用 require 加载，避免为测试再拆一份 TS。
const require = createRequire(import.meta.url);
const {
  MODE,
  REASON,
  compareVersions,
  parseVersion,
  resolveMode,
  pickAsset,
  flattenNotes,
  versionFromRelease,
} = require('../electron/updateLogic.cjs') as {
  MODE: { AUTO: string; MANUAL: string };
  REASON: Record<string, string>;
  compareVersions: (a: string, b: string) => number;
  parseVersion: (v: string) => { major: number; minor: number; patch: number; pre: string } | null;
  resolveMode: (input: { isPackaged: boolean; platform: string; appImagePath?: string | null }) => {
    mode: string;
    reason: string | null;
  };
  pickAsset: (
    assets: Array<{ name: string; browser_download_url?: string; size?: number }>,
    target: { platform: string; arch: string },
  ) => { name: string; url: string | null; size: number | null } | null;
  flattenNotes: (notes: unknown) => string;
  versionFromRelease: (release: unknown) => string;
};

test('版本比较：补丁号、预发布、前缀与非法输入', () => {
  assert.equal(compareVersions('0.0.5', '0.0.4'), 1);
  assert.equal(compareVersions('0.0.4', '0.0.4'), 0);
  assert.equal(compareVersions('v0.0.4', '0.0.4'), 0);
  assert.equal(compareVersions('0.1.0', '0.0.9'), 1);
  assert.equal(compareVersions('0.0.4', '0.0.10'), -1);
  // 预发布低于同号正式版
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  // 解析不了时返回 0，界面按「不比当前新」处理，不会误报有新版本
  assert.equal(compareVersions('nightly', '0.0.4'), 0);
  assert.equal(parseVersion('not-a-version'), null);
  assert.deepEqual(parseVersion('v1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, pre: 'rc.1' });
});

test('更新通道：只有已打包且平台支持时才自动安装', () => {
  assert.deepEqual(resolveMode({ isPackaged: false, platform: 'win32' }), { mode: MODE.MANUAL, reason: REASON.DEV });
  // macOS 未签名：Squirrel.Mac 会拒绝替换，明确退化成手动
  assert.deepEqual(resolveMode({ isPackaged: true, platform: 'darwin' }), { mode: MODE.MANUAL, reason: REASON.UNSIGNED });
  // 只有 AppImage 运行时会带 APPIMAGE 变量；deb / rpm 归包管理器管
  assert.deepEqual(resolveMode({ isPackaged: true, platform: 'linux' }), { mode: MODE.MANUAL, reason: REASON.PACKAGE });
  assert.deepEqual(resolveMode({ isPackaged: true, platform: 'linux', appImagePath: '/tmp/AiDB.AppImage' }), {
    mode: MODE.AUTO,
    reason: null,
  });
  assert.deepEqual(resolveMode({ isPackaged: true, platform: 'win32' }), { mode: MODE.AUTO, reason: null });
});

test('资产选择：按平台与架构挑安装包，不会被 blockmap 或另一架构干扰', () => {
  const assets = [
    { name: 'AiDB.Studio-0.0.5-x64-setup.exe', browser_download_url: 'https://x/win-x64.exe', size: 100 },
    { name: 'AiDB.Studio-0.0.5-x64-setup.exe.blockmap', browser_download_url: 'https://x/win-x64.blockmap' },
    { name: 'AiDB.Studio-0.0.5-arm64-setup.exe', browser_download_url: 'https://x/win-arm64.exe' },
    { name: 'AiDB.Studio-0.0.5-arm64.dmg', browser_download_url: 'https://x/mac-arm64.dmg' },
    { name: 'AiDB.Studio-0.0.5-x64.dmg', browser_download_url: 'https://x/mac-x64.dmg' },
    { name: 'AiDB.Studio-0.0.5-arm64.AppImage', browser_download_url: 'https://x/linux-arm64.AppImage' },
    { name: 'AiDB.Studio-0.0.5-x86_64.AppImage', browser_download_url: 'https://x/linux-x64.AppImage' },
  ];

  assert.equal(pickAsset(assets, { platform: 'win32', arch: 'x64' })?.name, 'AiDB.Studio-0.0.5-x64-setup.exe');
  assert.equal(pickAsset(assets, { platform: 'win32', arch: 'arm64' })?.name, 'AiDB.Studio-0.0.5-arm64-setup.exe');
  assert.equal(pickAsset(assets, { platform: 'darwin', arch: 'arm64' })?.name, 'AiDB.Studio-0.0.5-arm64.dmg');
  assert.equal(pickAsset(assets, { platform: 'darwin', arch: 'x64' })?.name, 'AiDB.Studio-0.0.5-x64.dmg');
  // Linux 的 x64 产物叫 x86_64，必须映射，否则手动下载会 404
  assert.equal(pickAsset(assets, { platform: 'linux', arch: 'x64' })?.name, 'AiDB.Studio-0.0.5-x86_64.AppImage');
  assert.equal(pickAsset(assets, { platform: 'linux', arch: 'arm64' })?.name, 'AiDB.Studio-0.0.5-arm64.AppImage');

  // 没有匹配项时返回 null，调用方退到 release 页面
  assert.equal(pickAsset([], { platform: 'win32', arch: 'x64' }), null);
  assert.equal(pickAsset(assets, { platform: 'freebsd', arch: 'x64' }), null);
});

test('发布说明与 tag 归一化', () => {
  assert.equal(flattenNotes('- 修复 A\n- 修复 B'), '- 修复 A\n- 修复 B');
  assert.equal(flattenNotes([{ note: 'A' }, { note: 'B' }]), 'A\n\nB');
  assert.equal(flattenNotes(null), '');
  assert.equal(versionFromRelease({ tag_name: 'v0.0.5' }), '0.0.5');
  assert.equal(versionFromRelease({ name: '0.0.6' }), '0.0.6');
  assert.equal(versionFromRelease({}), '');
});
