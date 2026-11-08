'use strict';

const { app, BrowserWindow, Menu, shell } = require('electron');
const { toTemplate } = require('./menuTemplate.cjs');

let installed = false;

/** 菜单命令只发给当前窗口；没有窗口时静默丢弃（例如 macOS 关窗后菜单仍然可点）。 */
function sendCommand(id) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send('menu:command', id);
}

/**
 * 安装应用菜单。spec 由渲染层按当前语言生成，见 apps/desktop/src/lib/appMenu.ts。
 * 返回 false 表示 spec 无效（调用方仍可保留系统默认菜单）。
 */
function installMenu(spec) {
  const template = toTemplate(spec, {
    platform: process.platform,
    send: sendCommand,
    openExternal: (url) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => undefined);
    },
  });
  if (template.length === 0) return false;
  // 开发态与打包态都显式设置，避免 Windows 上出现 Electron 默认的英文调试菜单
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  installed = true;
  return true;
}

function hasInstalledMenu() {
  return installed;
}

/** 「关于」面板：打包后系统会带上图标与版本，这里补齐版权与项目地址。 */
function configureAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: 'AiDB Studio',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: 'MIT License',
    credits: 'AI-native database workbench',
  });
}

module.exports = { installMenu, hasInstalledMenu, configureAboutPanel };
