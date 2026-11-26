import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const permissionTags = [...manifest.matchAll(/<uses-permission\b[^>]*\/>/g)].map((match) => match[0]);
const permissionName = (tag: string) => tag.match(/android:name="([^"]+)"/)?.[1];
const activePermissions = permissionTags
  .filter((tag) => !tag.includes('tools:node="remove"'))
  .map(permissionName)
  .filter((name): name is string => Boolean(name))
  .sort();
const removedPermissions = new Set(permissionTags
  .filter((tag) => tag.includes('tools:node="remove"'))
  .map(permissionName)
  .filter((name): name is string => Boolean(name)));

test('Android 仅声明实际使用的网络、局域网发现和相机权限', () => {
  assert.deepEqual(activePermissions, [
    'android.permission.ACCESS_WIFI_STATE',
    'android.permission.CAMERA',
    'android.permission.CHANGE_WIFI_MULTICAST_STATE',
    'android.permission.INTERNET',
  ]);
});

test('Android 显式移除录音、悬浮窗、振动和旧外部存储权限的依赖合并', () => {
  for (const name of [
    'android.permission.RECORD_AUDIO',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.VIBRATE',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]) {
    assert.equal(removedPermissions.has(name), true, name);
  }
});

test('相机、图片选择、SAF 导入和应用缓存导出功能均有实现且不依赖旧存储权限', () => {
  const app = read('App.tsx');
  const pairScreen = read('src/screens/PairScreen.tsx');
  const importExport = read('src/screens/ImportExportScreen.tsx');
  const utils = read('src/lib/utils.ts');

  assert.match(app, /ImagePicker\.launchImageLibraryAsync\(/);
  assert.match(pairScreen, /CameraView/);
  assert.match(pairScreen, /useCameraPermissions\(/);
  assert.match(importExport, /DocumentPicker\.getDocumentAsync\(\{[^}]*copyToCacheDirectory:\s*true/s);
  assert.match(importExport, /FileSystem\.readAsStringAsync\(asset\.uri\)/);
  assert.match(utils, /new File\(Paths\.cache,/);
  assert.match(utils, /Sharing\.shareAsync\(file\.uri\)/);
});
