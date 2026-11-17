import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// 只取 drivers/types 的 DbError：走 drivers/index 会把整条原生驱动链拉进来，
// store 启动清扫动态引入本模块时不该为此付出加载代价。
import { DbError } from './drivers/types';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const EXT_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]));

/** 单张图上限，超过后 base64 也会顶到 express 的 25mb body 限制。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp)$/;

export interface StoredAttachment {
  id: string;
  mime: string;
  bytes: number;
}

/** 把 base64 图片落到 Bridge 本地，返回可被会话消息引用的附件 id。 */
export function saveAttachment(dir: string, input: { mime?: string; base64?: string }): StoredAttachment {
  const mime = (input.mime ?? '').toLowerCase().trim();
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new DbError('只支持 JPEG / PNG / GIF / WebP 图片', { code: 'UNSUPPORTED_IMAGE', status: 400 });
  const raw = (input.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new DbError('图片内容为空', { code: 'EMPTY_ATTACHMENT', status: 400 });
  if (buffer.length > MAX_IMAGE_BYTES) throw new DbError(`单张图片不能超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB`, { code: 'ATTACHMENT_TOO_LARGE', status: 400 });
  const id = `${randomUUID()}.${ext}`;
  writeFileSync(join(dir, id), buffer);
  return { id, mime, bytes: buffer.length };
}

/** id 必须命中白名单格式，避免拼路径读到 attachments 目录之外。 */
export function readAttachment(dir: string, id: string): { mime: string; buffer: Buffer } | undefined {
  if (!ID_PATTERN.test(id)) return undefined;
  const path = join(dir, id);
  if (!existsSync(path)) return undefined;
  return { mime: MIME_BY_EXT[id.slice(id.lastIndexOf('.') + 1)], buffer: readFileSync(path) };
}

/** 附件 / 导出 / skill 产物只写不删会吃满磁盘：7 天前的文件按 mtime 清掉。 */
const SWEEP_MAX_AGE_MS = 7 * 86_400_000;
/** 单目录总量上限，超出按最旧删。 */
const SWEEP_MAX_BYTES = 500 * 1024 * 1024;
/** 最近 1 小时内改过的文件视为「正在使用」，容量回收也跳过，避免删掉正在写入的导出 / skill 产物。 */
const SWEEP_IN_USE_MS = 60 * 60_000;

interface SweepFile {
  path: string;
  mtimeMs: number;
  size: number;
}

async function collectFiles(dir: string, out: SweepFile[]): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) await collectFiles(full, out);
      else if (entry.isFile()) {
        const stat = await fsp.stat(full);
        out.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      /* 单文件读取失败跳过，不影响整体清扫 */
    }
  }
}

/** skill-runs 按 run 分子目录：文件清完后收掉空壳目录；rmdir 只删空目录，不会误删内容。根目录保留。 */
async function removeEmptySubdirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    await removeEmptySubdirs(sub);
    try {
      await fsp.rmdir(sub);
    } catch {
      /* 非空或占用中，保留 */
    }
  }
}

/**
 * 启动清扫（E7）：逐目录删除超龄文件，再按容量上限从最旧回收。
 * 任何失败都静默——清扫是后台治理，绝不能阻塞或毁掉启动。opts.now/maxAgeMs/maxBytes 供测试注入。
 */
export async function sweepDataDirs(
  dirs: string[],
  opts: { maxAgeMs?: number; maxBytes?: number; now?: number } = {},
): Promise<void> {
  const maxAge = opts.maxAgeMs ?? SWEEP_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? SWEEP_MAX_BYTES;
  const now = opts.now ?? Date.now();
  for (const dir of dirs) {
    try {
      const files: SweepFile[] = [];
      await collectFiles(dir, files);
      const kept: SweepFile[] = [];
      for (const file of files) {
        if (now - file.mtimeMs > maxAge) {
          try {
            await fsp.unlink(file.path);
          } catch {
            /* 单文件删除失败忽略 */
          }
        } else {
          kept.push(file);
        }
      }
      let total = kept.reduce((sum, file) => sum + file.size, 0);
      if (total > maxBytes) {
        const oldest = [...kept].sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const file of oldest) {
          if (total <= maxBytes) break;
          if (now - file.mtimeMs < SWEEP_IN_USE_MS) continue;
          try {
            await fsp.unlink(file.path);
            total -= file.size;
          } catch {
            /* 单文件删除失败忽略 */
          }
        }
      }
      await removeEmptySubdirs(dir);
    } catch {
      /* 单目录失败不影响其它目录 */
    }
  }
}
