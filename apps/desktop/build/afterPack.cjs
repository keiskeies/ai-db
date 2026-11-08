'use strict';

/**
 * afterPack：按目标架构裁剪 DuckDB 原生绑定。
 *
 * 背景：@duckdb/node-bindings 通过 optionalDependencies 只安装宿主匹配的
 * `@duckdb/node-bindings-<platform>-<arch>`，而 electron-builder.yml 把
 * `node_modules/@duckdb` 整目录原样拷进 gateway 资源目录。跨架构打包
 * （例如在 Apple Silicon runner 上同时构建 x64 与 arm64 dmg）时，两份绑定
 * 必须同时存在于源码树，各自约 60 MB；如果不裁剪，每个安装包都会同时带上
 * 另一个架构的 duckdb.node。
 *
 * 这里只做「删除多余架构」，不动当前架构的绑定；找不到目录时告警跳过，
 * 绝不让打包因为裁剪失败而中断。
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

// 目标架构允许保留的绑定目录名（linux 需要同时保留 glibc 与 musl 变体）
function allowedBindings(platform, arch) {
  if (platform === 'darwin') return [`node-bindings-darwin-${arch}`];
  if (platform === 'linux') return [`node-bindings-linux-${arch}`, `node-bindings-linux-${arch}-musl`];
  if (platform === 'win32') return [`node-bindings-win32-${arch}`];
  return [];
}

module.exports = async function afterPack(context) {
  try {
    const platform = context.electronPlatformName;
    const arch = ARCH_NAME[context.arch];
    const keep = allowedBindings(platform, arch);
    if (!arch || keep.length === 0) return;

    const duckdbDir = path.join(resourcesDir(context, context.appOutDir), 'gateway', 'node_modules', '@duckdb');
    if (!fs.existsSync(duckdbDir)) {
      console.warn(`[afterPack] 未找到 ${duckdbDir}，跳过 DuckDB 绑定裁剪`);
      return;
    }

    const removed = [];
    for (const entry of fs.readdirSync(duckdbDir)) {
      if (!entry.startsWith('node-bindings-')) continue;
      if (keep.includes(entry)) continue;
      fs.rmSync(path.join(duckdbDir, entry), { recursive: true, force: true });
      removed.push(entry);
    }

    for (const name of keep) {
      const target = path.join(duckdbDir, name, 'duckdb.node');
      if (!fs.existsSync(target)) {
        console.warn(`[afterPack] 目标架构 ${platform}-${arch} 缺少 ${name}，该安装包将无法使用 DuckDB`);
      }
    }

    console.log(
      `[afterPack] ${platform}-${arch} 保留 ${keep.join(', ')}${removed.length ? `，移除 ${removed.join(', ')}` : ''}`,
    );
  } catch (error) {
    console.warn(`[afterPack] DuckDB 绑定裁剪失败（不中断打包）：${error?.message ?? error}`);
  }
};
