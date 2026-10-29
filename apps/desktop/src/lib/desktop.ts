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

export interface DesktopBridge {
  platform: string;
  createTableShortcut: (payload: TableShortcutPayload) => Promise<{ ok: boolean; path?: string; error?: string }>;
  saveExportedFile?: (payload: { sourcePath: string }) => Promise<SaveExportedFileResult>;
  onOpenTable: (callback: (payload: OpenTablePayload) => void) => () => void;
}

export const desktopBridge: DesktopBridge | undefined = (window as unknown as { aidbDesktop?: DesktopBridge }).aidbDesktop;

/** 桌面端把网关写好的文件交给系统「另存为」；网页端返回 null，由调用方沿用默认导出目录。 */
export async function deliverExportedFile(sourcePath: string): Promise<SaveExportedFileResult | null> {
  if (!desktopBridge?.saveExportedFile) return null;
  try {
    return await desktopBridge.saveExportedFile({ sourcePath });
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
