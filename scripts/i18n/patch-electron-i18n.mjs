import fs from 'node:fs';

function patch(file, pairs) {
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.split('\r\n').join('\n');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.log('MISS', file, from.slice(0, 70));
      continue;
    }
    text = text.replace(from, to);
  }
  fs.writeFileSync(file, text.split('\n').join(eol));
}

patch('apps/desktop/src/lib/desktop.ts', [
  [
    "export interface TableShortcutPayload {",
    "import { t as tr } from '../i18n';\n\n/** 原生对话框文案由渲染层给出：主进程只负责展示，语言跟随界面设置。 */\nexport interface DesktopDialogUi {\n  saveTitle: string;\n  pdfTitle: string;\n  save: string;\n  allFiles: string;\n  filters: Record<string, string>;\n  errors: Record<string, string>;\n}\n\nexport interface TableShortcutPayload {",
  ],
  [
    "  createTableShortcut: (payload: TableShortcutPayload) => Promise<{ ok: boolean; path?: string; error?: string }>;",
    "  createTableShortcut: (payload: TableShortcutPayload & { ui?: DesktopDialogUi }) => Promise<{ ok: boolean; path?: string; error?: string }>;",
  ],
  [
    "  saveExportedFile?: (payload: { sourcePath: string }) => Promise<SaveExportedFileResult>;",
    "  saveExportedFile?: (payload: { sourcePath: string; ui?: DesktopDialogUi }) => Promise<SaveExportedFileResult>;",
  ],
  [
    "  exportPdf?: (payload: { html: string; name?: string }) => Promise<SaveExportedFileResult>;",
    "  exportPdf?: (payload: { html: string; name?: string; ui?: DesktopDialogUi }) => Promise<SaveExportedFileResult>;",
  ],
  [
    "export const desktopBridge: DesktopBridge | undefined = (window as unknown as { aidbDesktop?: DesktopBridge }).aidbDesktop;",
    "export const desktopBridge: DesktopBridge | undefined = (window as unknown as { aidbDesktop?: DesktopBridge }).aidbDesktop;\n\nexport function desktopDialogUi(): DesktopDialogUi {\n  return {\n    saveTitle: tr('保存导出文件'),\n    pdfTitle: tr('导出 PDF'),\n    save: tr('保存'),\n    allFiles: tr('所有文件'),\n    filters: {\n      png: tr('PNG 图片'),\n      svg: tr('SVG 矢量图'),\n      csv: tr('CSV 文件'),\n      sql: tr('SQL 脚本'),\n      json: tr('JSON 文件'),\n      xml: tr('XML 文件'),\n      xlsx: tr('Excel 工作簿'),\n      pptx: tr('PowerPoint 演示文稿'),\n      md: tr('Markdown 文档'),\n      pdf: tr('PDF 文档'),\n    },\n    errors: {\n      outside: tr('只允许保存导出目录或 Skill 产物目录中的文件'),\n      missing: tr('导出文件不存在，请重试'),\n      emptyPdf: tr('导出内容为空'),\n      shortcutWindows: tr('仅 Windows 支持 .lnk 快捷方式'),\n      shortcutArgs: tr('缺少连接或表名'),\n      shortcutWrite: tr('写入快捷方式失败'),\n    },\n  };\n}",
  ],
  [
    "    return await desktopBridge.saveExportedFile({ sourcePath });",
    "    return await desktopBridge.saveExportedFile({ sourcePath, ui: desktopDialogUi() });",
  ],
]);

patch('apps/desktop/src/components/AgentPanel.tsx', [
  [
    "import { desktopBridge } from '../lib/desktop';",
    "import { desktopBridge, desktopDialogUi } from '../lib/desktop';",
  ],
  [
    "const result = await desktopBridge.exportPdf({ html, name: stampName('pdf') });",
    "const result = await desktopBridge.exportPdf({ html, name: stampName('pdf'), ui: desktopDialogUi() });",
  ],
]);

patch('apps/desktop/src/components/Sidebar.tsx', [
  [
    "import { desktopBridge } from '../lib/desktop';",
    "import { desktopBridge, desktopDialogUi } from '../lib/desktop';",
  ],
  [
    "    const result = await desktopBridge.createTableShortcut({",
    "    const result = await desktopBridge.createTableShortcut({\n      ui: desktopDialogUi(),",
  ],
]);
