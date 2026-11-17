import { useApp } from '../store';
import { deliverExportedFile } from './desktop';
import { authToken } from './api';
import { t as tr } from '../i18n';

/**
 * 导出结果的统一形状。K5 之后服务端 inline 导出优先返回 downloadUrl
 * （GET /api/export/file?path=…），旧形态仍可能带 base64 content；
 * 桌面端非 inline 时只有网关落盘的 file.path。三种都要能交付。
 */
export interface ExportDelivery {
  path?: string;
  rows?: number;
  bytes?: number;
  format?: string;
  downloadUrl?: string;
  content?: string;
  encoding?: string;
}

function baseName(source?: string): string {
  if (!source) return '';
  const clean = source.split(/[?#]/)[0];
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function mimeForFormat(format?: string): string {
  switch (format) {
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'xml': return 'application/xml';
    case 'sql': return 'application/sql';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    default: return 'application/octet-stream';
  }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立即 revoke 会让部分浏览器来不及发起下载；留一段窗口再回收。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 移动端优先系统分享（可直接发到其它 App），不支持或用户取消时退回浏览器下载。 */
async function shareOrDownload(blob: Blob, filename: string): Promise<void> {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> };
  try {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (nav.share && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: filename });
      return;
    }
  } catch {
    /* 分享被取消/不支持都退回下载 */
  }
  triggerDownload(blob, filename);
}

async function blobFromDownloadUrl(downloadUrl: string): Promise<Blob> {
  const res = await fetch(downloadUrl, { headers: { authorization: `Bearer ${authToken()}` } });
  if (!res.ok) throw new Error(tr("下载导出文件失败（{0}）", [res.status]));
  return await res.blob();
}

function blobFromBase64(content: string, mime: string): Blob {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 导出统一出口：优先 downloadUrl 下载/分享，兼容旧 base64，桌面端落盘文件走系统「另存为」。 */
export async function deliverExport(result: ExportDelivery, message = tr("导出")): Promise<void> {
  const { notify } = useApp.getState();
  const rows = result.rows ?? 0;
  const filename = baseName(result.path) || baseName(result.downloadUrl) || `export${result.format ? `.${result.format}` : ''}`;

  if (result.downloadUrl) {
    const blob = await blobFromDownloadUrl(result.downloadUrl);
    await shareOrDownload(blob, filename);
    notify('success', message, tr("{0} 行", [rows]));
    return;
  }
  if (result.content && result.encoding === 'base64') {
    const blob = blobFromBase64(result.content, mimeForFormat(result.format));
    await shareOrDownload(blob, filename);
    notify('success', message, tr("{0} 行", [rows]));
    return;
  }

  if (!result.path) {
    notify('error', tr("保存导出文件失败"), tr("导出结果缺少文件路径"));
    return;
  }
  const saved = await deliverExportedFile(result.path);
  if (!saved) {
    notify('success', message, tr("{0} 行 · {1}", [rows, result.path]));
    return;
  }
  if (saved.ok) {
    notify('success', message, tr("{0} 行 · {1}", [rows, saved.path ?? result.path]));
    return;
  }
  if (saved.canceled) {
    notify('info', message, tr("{0} 行 · 未选择位置，文件仍在 {1}", [rows, result.path]));
    return;
  }
  notify('error', tr("保存导出文件失败"), tr("{0}（文件在 {1}）", [saved.error ?? tr("未知错误"), result.path]));
}