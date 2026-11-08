import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 依赖原生二进制、且该二进制按平台-架构预编译的引擎，在缺绑定的机器上不可用。
 * 由 /bootstrap 下发给客户端，界面据此把该引擎置灰，避免用户配完连接才发现连不上。
 */
export interface UnavailableEngine {
  engine: 'oracle';
  code: 'ORACLE_BINDING_MISSING';
  /** 形如 darwin-x64 */
  platform: string;
  detail: string;
}

/**
 * node-oracledb 的绑定是 `<版本>-<平台>-<架构>.node` 命名的预编译产物：上游 26.0.0 只提供
 * darwin-arm64 / linux-arm64 / linux-x64 / win32-x64，没有 macOS Intel。缺了它这个引擎在本机
 * 一定连不上（thick 模式同样要加载这份绑定，装 Instant Client 也救不了）。
 *
 * 打包后绑定在 resources/gateway/node_modules/oracledb/build/Release；dev 下则来自仓库根
 * node_modules，所以两个相对位置都要探。
 */
export function oracleBindingDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, 'node_modules', 'oracledb', 'build', 'Release'),
    path.join(here, '..', 'node_modules', 'oracledb', 'build', 'Release'),
    path.join(here, '..', '..', '..', 'node_modules', 'oracledb', 'build', 'Release'),
  ];
}

export function hasBinding(dirs: string[], platform: string, arch: string): boolean {
  const suffix = `-${platform}-${arch}.node`;
  return dirs.some((dir) => {
    try {
      if (!existsSync(dir)) return false;
      return readdirSync(dir).some((file) => file.endsWith(suffix));
    } catch {
      return false;
    }
  });
}

export function unavailableEngines(
  platform: string = process.platform,
  arch: string = process.arch,
  dirs: string[] = oracleBindingDirs(),
): UnavailableEngine[] {
  const out: UnavailableEngine[] = [];
  if (!hasBinding(dirs, platform, arch)) {
    out.push({
      engine: 'oracle',
      code: 'ORACLE_BINDING_MISSING',
      platform: `${platform}-${arch}`,
      detail: `node-oracledb 没有 ${platform}-${arch} 的预编译绑定`,
    });
  }
  return out;
}
