import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DbError } from './drivers';

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
