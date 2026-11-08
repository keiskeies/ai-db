const { contextBridge, ipcRenderer } = require('electron');

let pendingOpen = null;
const listeners = new Set();
const menuListeners = new Set();
const updateListeners = new Set();

ipcRenderer.on('update:event', (_event, payload) => {
  for (const listener of updateListeners) listener(payload);
});

ipcRenderer.on('open-table', (_event, payload) => {
  pendingOpen = payload;
  for (const listener of listeners) listener(payload);
});

ipcRenderer.on('menu:command', (_event, id) => {
  for (const listener of menuListeners) listener(id);
});

contextBridge.exposeInMainWorld('aidbDesktop', {
  platform: process.platform,
  createTableShortcut: (payload) => ipcRenderer.invoke('create-table-shortcut', payload),
  saveExportedFile: (payload) => ipcRenderer.invoke('save-export-file', payload),
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),
  // 菜单文案跟随界面语言：渲染层把整棵树下发，主进程只做安装
  setApplicationMenu: (spec) => ipcRenderer.invoke('menu:set', spec),
  onMenuCommand: (callback) => {
    menuListeners.add(callback);
    return () => menuListeners.delete(callback);
  },
  // 更新：渲染层只发命令、收事件，主进程负责网络与安装
  updater: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    openDownload: (url) => ipcRenderer.invoke('update:open-download', url),
    onEvent: (callback) => {
      updateListeners.add(callback);
      return () => updateListeners.delete(callback);
    },
  },
  onOpenTable: (callback) => {
    listeners.add(callback);
    if (pendingOpen) callback(pendingOpen);
    return () => listeners.delete(callback);
  },
});
