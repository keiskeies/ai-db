const { contextBridge, ipcRenderer } = require('electron');

let pendingOpen = null;
const listeners = new Set();

ipcRenderer.on('open-table', (_event, payload) => {
  pendingOpen = payload;
  for (const listener of listeners) listener(payload);
});

contextBridge.exposeInMainWorld('aidbDesktop', {
  platform: process.platform,
  createTableShortcut: (payload) => ipcRenderer.invoke('create-table-shortcut', payload),
  saveExportedFile: (payload) => ipcRenderer.invoke('save-export-file', payload),
  onOpenTable: (callback) => {
    listeners.add(callback);
    if (pendingOpen) callback(pendingOpen);
    return () => listeners.delete(callback);
  },
});
