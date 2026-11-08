import { t as tr } from '../i18n';

/** 原生对话框文案由渲染层给出：主进程只负责展示，语言跟随界面设置。 */
export interface DesktopDialogUi {
  saveTitle: string;
  pdfTitle: string;
  save: string;
  allFiles: string;
  filters: Record<string, string>;
  errors: Record<string, string>;
}

export interface TableShortcutPayload {
  connectionId: string;
  database?: string;
  table: string;
  name?: string;
}

export interface OpenTablePayload {
  connectionId?: string;
  database?: string;
  table: string;
}

export interface SaveExportedFileResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

/** 原生菜单描述项：由渲染层按当前语言生成，主进程负责安装（见 electron/menuTemplate.cjs）。 */
export type AppMenuItem =
  | { type: 'separator' }
  | { type: 'role'; role: string; label?: string; accelerator?: string }
  | { type: 'submenu'; label: string; items: AppMenuItem[] }
  | { type: 'command'; id: string; label: string; accelerator?: string }
  | { type: 'open'; label: string; url: string };

/** 更新通道：auto 能自己下载安装；manual 只能提示去发布页。 */
export type UpdateChannel = 'auto' | 'manual';

/** 退化成 manual 的原因，渲染层据此给出不同说明。 */
export type UpdateFallbackReason = 'dev' | 'unsigned' | 'package' | 'platform' | 'fallback' | null;

export interface UpdateStatusInfo {
  mode: UpdateChannel;
  reason: UpdateFallbackReason;
  currentVersion: string;
  platform: string;
  arch: string;
}

export interface UpdateCheckResult {
  status: 'available' | 'latest' | 'error';
  mode: UpdateChannel;
  reason: UpdateFallbackReason;
  currentVersion: string;
  latestVersion?: string | null;
  notes?: string;
  publishedAt?: string | null;
  downloadUrl?: string | null;
  pageUrl?: string | null;
  assetName?: string | null;
  assetSize?: number | null;
  code?: string;
  detail?: string;
}

export interface UpdateEvent {
  type: 'checking' | 'available' | 'latest' | 'progress' | 'downloaded' | 'error';
  mode?: UpdateChannel;
  reason?: UpdateFallbackReason;
  currentVersion?: string;
  latestVersion?: string | null;
  notes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  code?: string;
  detail?: string;
}

export interface DesktopUpdaterBridge {
  status: () => Promise<UpdateStatusInfo>;
  check: () => Promise<UpdateCheckResult>;
  download: () => Promise<{ ok: boolean; code?: string }>;
  install: () => Promise<{ ok: boolean; code?: string }>;
  openDownload: (url?: string | null) => Promise<{ ok: boolean; url?: string }>;
  onEvent: (callback: (event: UpdateEvent) => void) => () => void;
}

export interface DesktopBridge {
  platform: string;
  createTableShortcut: (payload: TableShortcutPayload & { ui?: DesktopDialogUi }) => Promise<{ ok: boolean; path?: string; error?: string }>;
  saveExportedFile?: (payload: { sourcePath: string; ui?: DesktopDialogUi }) => Promise<SaveExportedFileResult>;
  exportPdf?: (payload: { html: string; name?: string; ui?: DesktopDialogUi }) => Promise<SaveExportedFileResult>;
  setApplicationMenu?: (spec: AppMenuItem[]) => Promise<boolean>;
  onMenuCommand?: (callback: (id: string) => void) => () => void;
  updater?: DesktopUpdaterBridge;
  onOpenTable: (callback: (payload: OpenTablePayload) => void) => () => void;
}

export const desktopBridge: DesktopBridge | undefined = (window as unknown as { aidbDesktop?: DesktopBridge }).aidbDesktop;

export function desktopDialogUi(): DesktopDialogUi {
  return {
    saveTitle: tr('保存导出文件'),
    pdfTitle: tr('导出 PDF'),
    save: tr('保存'),
    allFiles: tr('所有文件'),
    filters: {
      png: tr('PNG 图片'),
      svg: tr('SVG 矢量图'),
      csv: tr('CSV 文件'),
      sql: tr('SQL 脚本'),
      json: tr('JSON 文件'),
      xml: tr('XML 文件'),
      xlsx: tr('Excel 工作簿'),
      pptx: tr('PowerPoint 演示文稿'),
      md: tr('Markdown 文档'),
      pdf: tr('PDF 文档'),
    },
    errors: {
      outside: tr('只允许保存导出目录或 Skill 产物目录中的文件'),
      missing: tr('导出文件不存在，请重试'),
      emptyPdf: tr('导出内容为空'),
      shortcutWindows: tr('仅 Windows 支持 .lnk 快捷方式'),
      shortcutArgs: tr('缺少连接或表名'),
      shortcutWrite: tr('写入快捷方式失败'),
    },
  };
}

/** 桌面端把网关写好的文件交给系统「另存为」；网页端返回 null，由调用方沿用默认导出目录。 */
export async function deliverExportedFile(sourcePath: string): Promise<SaveExportedFileResult | null> {
  if (!desktopBridge?.saveExportedFile) return null;
  try {
    return await desktopBridge.saveExportedFile({ sourcePath, ui: desktopDialogUi() });
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
