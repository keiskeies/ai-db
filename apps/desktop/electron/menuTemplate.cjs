'use strict';

/**
 * 把渲染层给出的菜单描述转成 Electron 的 MenuItem 模板。
 *
 * 单独拆成纯函数（不 require electron）有两个原因：
 * 1. 菜单文案跟随界面语言，而语言设置存在渲染层，主进程不应该再维护一份词典；
 *    渲染层把整棵树序列化下发，主进程只做「翻译」，与 desktopDialogUi 的做法一致。
 * 2. 可以在 Node 里直接断言结构，不必起一个 Electron 窗口。
 *
 * 描述项支持四种形态：
 *   { type: 'separator' }
 *   { type: 'role', role, label?, accelerator? }
 *   { type: 'submenu', label, items }
 *   { type: 'command', id, label, accelerator? }   → 点击时把 id 发回渲染层执行
 *   { type: 'open', label, url }                   → 用系统浏览器打开外链
 */

/** 只接受 Electron 认得的 role，避免下发的拼写错误让整棵树静默失效。 */
const ROLES = new Set([
  'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll',
  'reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut',
  'togglefullscreen', 'window', 'minimize', 'close', 'help', 'about', 'services',
  'hide', 'hideOthers', 'unhide', 'quit', 'startSpeaking', 'stopSpeaking', 'front', 'zoom',
]);

function toTemplate(items, ctx) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'separator') {
      // 连续分隔符或首尾分隔符只是视觉噪音，直接吞掉
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue;
      out.push({ type: 'separator' });
      continue;
    }

    if (item.type === 'role') {
      if (!ROLES.has(item.role)) continue;
      const entry = { role: item.role };
      if (item.label) entry.label = item.label;
      // 不传 accelerator 时沿用 Electron 对该 role 的默认绑定
      if (item.accelerator) entry.accelerator = item.accelerator;
      out.push(entry);
      continue;
    }

    if (item.type === 'submenu') {
      const submenu = toTemplate(item.items, ctx);
      if (submenu.length === 0) continue;
      // 去掉尾部分隔符
      while (submenu[submenu.length - 1].type === 'separator') submenu.pop();
      out.push({ label: String(item.label ?? ''), submenu });
      continue;
    }

    if (item.type === 'command' && item.id) {
      const entry = { label: String(item.label ?? item.id), click: () => ctx.send(item.id) };
      if (item.accelerator) {
        entry.accelerator = item.accelerator;
        // macOS 的菜单快捷键由系统菜单接管，按键不会再派发给网页，因此直接注册；
        // Windows / Linux 上若也注册，就会和渲染层自带的 keydown 处理撞成双触发，
        // 这里改成只显示不注册（registerAccelerator 仅在这两个平台有效）。
        if (ctx.platform !== 'darwin') entry.registerAccelerator = false;
      }
      out.push(entry);
      continue;
    }

    if (item.type === 'open' && item.url) {
      out.push({
        label: String(item.label ?? item.url),
        click: () => ctx.openExternal(String(item.url)),
      });
    }
  }

  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

module.exports = { toTemplate, ROLES };
