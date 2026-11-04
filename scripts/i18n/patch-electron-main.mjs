import fs from 'node:fs';

const file = 'apps/desktop/electron/main.cjs';
const original = fs.readFileSync(file, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
let text = original.split('\r\n').join('\n');

const pairs = [
  [
    "ipcMain.handle('create-table-shortcut', async (_event, payload) => {\n  if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 支持 .lnk 快捷方式' };\n  const connectionId = String(payload?.connectionId ?? '');\n  const table = String(payload?.table ?? '');\n  if (!connectionId || !table) return { ok: false, error: '缺少连接或表名' };",
    "ipcMain.handle('create-table-shortcut', async (_event, payload) => {\n  const errors = payload?.ui?.errors ?? {};\n  if (process.platform !== 'win32') return { ok: false, error: errors.shortcutWindows ?? '仅 Windows 支持 .lnk 快捷方式' };\n  const connectionId = String(payload?.connectionId ?? '');\n  const table = String(payload?.table ?? '');\n  if (!connectionId || !table) return { ok: false, error: errors.shortcutArgs ?? '缺少连接或表名' };",
  ],
  [
    "    return ok ? { ok: true, path: file } : { ok: false, error: '写入快捷方式失败' };",
    "    return ok ? { ok: true, path: file } : { ok: false, error: errors.shortcutWrite ?? '写入快捷方式失败' };",
  ],
  [
    "ipcMain.handle('save-export-file', async (_event, payload) => {\n  const source = path.resolve(String(payload?.sourcePath ?? ''));",
    "ipcMain.handle('save-export-file', async (_event, payload) => {\n  const ui = payload?.ui ?? {};\n  const errors = ui.errors ?? {};\n  const labels = ui.filters ?? {};\n  const allFiles = ui.allFiles ?? '所有文件';\n  const source = path.resolve(String(payload?.sourcePath ?? ''));",
  ],
  [
    "    return { ok: false, error: '只允许保存导出目录或 Skill 产物目录中的文件' };",
    "    return { ok: false, error: errors.outside ?? '只允许保存导出目录或 Skill 产物目录中的文件' };",
  ],
  [
    "    return { ok: false, error: '导出文件不存在，请重试' };",
    "    return { ok: false, error: errors.missing ?? '导出文件不存在，请重试' };",
  ],
  [
    "  const name = path.basename(source);\n  const filter = EXPORT_FILTERS[path.extname(name).slice(1).toLowerCase()];\n  const options = {\n    title: '保存导出文件',\n    buttonLabel: '保存',\n    defaultPath: path.join(app.getPath('downloads'), name),\n    filters: filter ? [filter, { name: '所有文件', extensions: ['*'] }] : [{ name: '所有文件', extensions: ['*'] }],\n  };",
    "  const name = path.basename(source);\n  const kind = path.extname(name).slice(1).toLowerCase();\n  const base = EXPORT_FILTERS[kind];\n  const filter = base ? { ...base, name: labels[kind] ?? base.name } : undefined;\n  const options = {\n    title: ui.saveTitle ?? '保存导出文件',\n    buttonLabel: ui.save ?? '保存',\n    defaultPath: path.join(app.getPath('downloads'), name),\n    filters: filter ? [filter, { name: allFiles, extensions: ['*'] }] : [{ name: allFiles, extensions: ['*'] }],\n  };",
  ],
  [
    "  const html = String(payload?.html ?? '');\n  if (!html) return { ok: false, error: '导出内容为空' };",
    "  const ui = payload?.ui ?? {};\n  const errors = ui.errors ?? {};\n  const labels = ui.filters ?? {};\n  const html = String(payload?.html ?? '');\n  if (!html) return { ok: false, error: errors.emptyPdf ?? '导出内容为空' };",
  ],
  [
    "  const options = {\n    title: '导出 PDF',\n    buttonLabel: '保存',\n    defaultPath: path.join(app.getPath('downloads'), safeName),\n    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],\n  };",
    "  const options = {\n    title: ui.pdfTitle ?? '导出 PDF',\n    buttonLabel: ui.save ?? '保存',\n    defaultPath: path.join(app.getPath('downloads'), safeName),\n    filters: [{ name: labels.pdf ?? 'PDF 文档', extensions: ['pdf'] }],\n  };",
  ],
];

for (const [from, to] of pairs) {
  if (!text.includes(from)) {
    console.log('MISS:', from.slice(0, 90));
    continue;
  }
  text = text.replace(from, to);
}

fs.writeFileSync(file, text.split('\n').join(eol));
console.log('electron main patched');
