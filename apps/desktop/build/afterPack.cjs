'use strict';

/**
 * afterPack：按目标架构裁剪随包分发的原生二进制。
 *
 * 背景：
 * 1) @duckdb/node-bindings 通过 optionalDependencies 只安装宿主匹配的那一份
 *    （`@duckdb/node-bindings-<platform>-<arch>`），而 electron-builder.yml 把
 *    `node_modules/@duckdb` 整目录原样拷进 gateway 资源目录。跨架构打包（例如在
 *    Apple Silicon runner 上同时构建 x64 与 arm64 dmg）时两份必须同时存在于源码树，
 *    各自约 60 MB；不裁剪的话每个安装包都会带上另一架构的 duckdb.node。
 * 2) node-oracledb 的 build/Release 里同时躺着多个平台的预编译绑定
 *    （`oracledb-<版本>-<platform>-<arch>.node`），同样只能保留目标平台那一份。
 *
 * 这里只做「删除多余架构」，找不到目录时告警跳过，绝不让打包因为裁剪失败而中断。
 */

const fs = require('node:fs');
const path = require('node:path');

const ARCH_NAME = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

function resourcesDir(context, appOutDir) {
  const platform = context.electronPlatformName;
  if (platform === 'darwin') {
    const productName = context.packager?.appInfo?.productFilename ?? 'AiDB Studio';
    return path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

// 目标架构允许保留的 DuckDB 绑定目录名（linux 需要同时保留 glibc 与 musl 变体）
function allowedDuckdbBindings(platform, arch) {
  if (platform === 'darwin') return [`node-bindings-darwin-${arch}`];
  if (platform === 'linux') return [`node-bindings-linux-${arch}`, `node-bindings-linux-${arch}-musl`];
  if (platform === 'win32') return [`node-bindings-win32-${arch}`];
  return [];
}

function pruneDuckdb(gatewayDir, platform, arch) {
  const duckdbDir = path.join(gatewayDir, 'node_modules', '@duckdb');
  if (!fs.existsSync(duckdbDir)) {
    console.warn(`[afterPack] 未找到 ${duckdbDir}，跳过 DuckDB 绑定裁剪`);
    return;
  }
  const keep = allowedDuckdbBindings(platform, arch);
  const removed = [];
  for (const entry of fs.readdirSync(duckdbDir)) {
    if (!entry.startsWith('node-bindings-')) continue;
    if (keep.includes(entry)) continue;
    fs.rmSync(path.join(duckdbDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  for (const name of keep) {
    if (!fs.existsSync(path.join(duckdbDir, name, 'duckdb.node'))) {
      console.warn(`[afterPack] 目标架构 ${platform}-${arch} 缺少 ${name}，该安装包将无法使用 DuckDB`);
    }
  }
  console.log(
    `[afterPack] DuckDB ${platform}-${arch} 保留 ${keep.join(', ')}${removed.length ? `，移除 ${removed.join(', ')}` : ''}`,
  );
}

function pruneOracle(gatewayDir, platform, arch) {
  const releaseDir = path.join(gatewayDir, 'node_modules', 'oracledb', 'build', 'Release');
  if (!fs.existsSync(releaseDir)) {
    // 不视为打包失败：只影响 Oracle 驱动，其余引擎照常
    console.warn(`[afterPack] 未找到 ${releaseDir}，跳过 node-oracledb 绑定裁剪`);
    return;
  }
  const suffix = `-${platform}-${arch}.node`;
  const removed = [];
  const kept = [];
  for (const entry of fs.readdirSync(releaseDir)) {
    if (!entry.endsWith('.node')) continue;
    if (entry.endsWith(suffix)) {
      kept.push(entry);
      continue;
    }
    fs.rmSync(path.join(releaseDir, entry), { force: true });
    removed.push(entry);
  }
  if (kept.length === 0) {
    console.warn(
      `[afterPack] node-oracledb 没有 ${platform}-${arch} 的预编译绑定（上游未提供），该安装包的 Oracle 驱动不可用`,
    );
  }
  console.log(
    `[afterPack] node-oracledb ${platform}-${arch} 保留 ${kept.join(', ') || '无'}${
      removed.length ? `，移除 ${removed.join(', ')}` : ''
    }`,
  );
}

module.exports = async function afterPack(context) {
  try {
    const platform = context.electronPlatformName;
    const arch = ARCH_NAME[context.arch];
    if (!arch) return;
    const gatewayDir = path.join(resourcesDir(context, context.appOutDir), 'gateway');
    if (!fs.existsSync(gatewayDir)) {
      console.warn(`[afterPack] 未找到 ${gatewayDir}，跳过原生二进制裁剪`);
      return;
    }
    pruneDuckdb(gatewayDir, platform, arch);
    pruneOracle(gatewayDir, platform, arch);
  } catch (error) {
    console.warn(`[afterPack] 原生二进制裁剪失败（不中断打包）：${error?.message ?? error}`);
  }
};
