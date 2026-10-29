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

export interface DesktopBridge {
  platform: string;
  createTableShortcut: (payload: TableShortcutPayload) => Promise<{ ok: boolean; path?: string; error?: string }>;
  onOpenTable: (callback: (payload: OpenTablePayload) => void) => () => void;
}

export const desktopBridge: DesktopBridge | undefined = (window as unknown as { aidbDesktop?: DesktopBridge }).aidbDesktop;
