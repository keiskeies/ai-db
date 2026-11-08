import { t as tr } from '../i18n';
import { useApp } from '../store';
import { desktopBridge, type AppMenuItem } from './desktop';

const REPO = 'https://github.com/keiskeies/ai-db';

/**
 * 生成原生应用菜单树（结构与 Navicat / VS Code 同形）。
 *
 * 文案在这里用 tr() 取，所以菜单语言天然跟随界面设置：语言一变，App 会重新下发整棵树。
 * 这里不引入任何主进程逻辑，主进程只负责把描述安装成 Menu，见 electron/menuTemplate.cjs。
 */
export function buildAppMenu(platform: string): AppMenuItem[] {
  const mac = platform === 'darwin';

  const appMenu: AppMenuItem[] = [
    { type: 'role', role: 'about', label: tr('关于 AiDB Studio') },
    { type: 'separator' },
    { type: 'command', id: 'tools.settings', label: tr('设置…'), accelerator: 'CmdOrCtrl+,' },
    { type: 'separator' },
    { type: 'role', role: 'services', label: tr('服务') },
    { type: 'separator' },
    { type: 'role', role: 'hide', label: tr('隐藏 AiDB Studio') },
    { type: 'role', role: 'hideOthers', label: tr('隐藏其他') },
    { type: 'role', role: 'unhide', label: tr('全部显示') },
    { type: 'separator' },
    { type: 'role', role: 'quit', label: tr('退出 AiDB Studio') },
  ];

  const fileMenu: AppMenuItem[] = [
    { type: 'command', id: 'file.newConnection', label: tr('新建连接'), accelerator: 'CmdOrCtrl+N' },
    { type: 'command', id: 'file.newQuery', label: tr('新建查询'), accelerator: 'CmdOrCtrl+T' },
    { type: 'separator' },
    { type: 'command', id: 'file.refresh', label: tr('刷新对象树'), accelerator: 'CmdOrCtrl+R' },
    { type: 'separator' },
    { type: 'command', id: 'file.closeTab', label: tr('关闭标签页'), accelerator: 'CmdOrCtrl+W' },
    { type: 'role', role: 'close', label: tr('关闭窗口'), accelerator: 'Shift+CmdOrCtrl+W' },
    ...(mac
      ? []
      : ([{ type: 'separator' }, { type: 'role', role: 'quit', label: tr('退出') }] as AppMenuItem[])),
  ];

  const editMenu: AppMenuItem[] = [
    { type: 'role', role: 'undo', label: tr('撤销'), accelerator: 'CmdOrCtrl+Z' },
    { type: 'role', role: 'redo', label: tr('重做'), accelerator: 'Shift+CmdOrCtrl+Z' },
    { type: 'separator' },
    { type: 'role', role: 'cut', label: tr('剪切'), accelerator: 'CmdOrCtrl+X' },
    { type: 'role', role: 'copy', label: tr('复制'), accelerator: 'CmdOrCtrl+C' },
    { type: 'role', role: 'paste', label: tr('粘贴'), accelerator: 'CmdOrCtrl+V' },
    { type: 'role', role: 'delete', label: tr('删除') },
    { type: 'separator' },
    { type: 'role', role: 'selectAll', label: tr('全选'), accelerator: 'CmdOrCtrl+A' },
  ];

  const viewMenu: AppMenuItem[] = [
    { type: 'command', id: 'view.palette', label: tr('命令面板'), accelerator: 'CmdOrCtrl+K' },
    { type: 'command', id: 'view.agent', label: tr('AI 助手'), accelerator: 'Shift+CmdOrCtrl+A' },
    { type: 'command', id: 'view.sidebar', label: tr('连接栏'), accelerator: 'CmdOrCtrl+B' },
    { type: 'command', id: 'view.theme', label: tr('切换明暗主题') },
    { type: 'separator' },
    { type: 'role', role: 'zoomIn', label: tr('放大') },
    { type: 'role', role: 'zoomOut', label: tr('缩小') },
    { type: 'role', role: 'resetZoom', label: tr('实际大小') },
    { type: 'separator' },
    { type: 'role', role: 'togglefullscreen', label: tr('全屏') },
  ];

  const toolsMenu: AppMenuItem[] = [
    { type: 'command', id: 'tools.hub', label: tr('工具箱') },
    { type: 'command', id: 'tools.backup', label: tr('数据备份') },
    { type: 'command', id: 'tools.memory', label: tr('记忆') },
    ...(mac ? [] : ([{ type: 'separator' }, { type: 'command', id: 'tools.settings', label: tr('设置…'), accelerator: 'CmdOrCtrl+,' }] as AppMenuItem[])),
  ];

  // role zoom / front 是 macOS 专有语义，Windows / Linux 上放了也点不动，
  // 这里按平台分开，避免出现「有菜单项、点了没反应」。
  const windowMenu: AppMenuItem[] = mac
    ? [
        { type: 'role', role: 'minimize', label: tr('最小化') },
        { type: 'role', role: 'zoom', label: tr('缩放') },
        { type: 'separator' },
        { type: 'role', role: 'front', label: tr('前置全部窗口') },
      ]
    : [
        { type: 'role', role: 'minimize', label: tr('最小化') },
        { type: 'role', role: 'close', label: tr('关闭窗口') },
      ];

  const helpMenu: AppMenuItem[] = [
    { type: 'open', label: tr('使用文档'), url: `${REPO}#readme` },
    { type: 'open', label: tr('反馈问题'), url: `${REPO}/issues/new` },
    ...(mac ? [] : ([{ type: 'separator' }, { type: 'role', role: 'about', label: tr('关于 AiDB Studio') }] as AppMenuItem[])),
  ];

  return [
    ...(mac ? [{ type: 'submenu' as const, label: 'AiDB Studio', items: appMenu }] : []),
    { type: 'submenu', label: tr('文件'), items: fileMenu },
    { type: 'submenu', label: tr('编辑'), items: editMenu },
    { type: 'submenu', label: tr('查看'), items: viewMenu },
    { type: 'submenu', label: tr('工具'), items: toolsMenu },
    { type: 'submenu', label: tr('窗口'), items: windowMenu },
    { type: 'submenu', label: tr('帮助'), items: helpMenu },
  ];
}

/**
 * 菜单命令的统一入口。菜单只发 id，动作仍然走 store，和命令面板共用同一批行为，
 * 避免出现「菜单能点、快捷键不做」这种两套实现。
 */
export function runMenuCommand(id: string): void {
  const s = useApp.getState();
  switch (id) {
    case 'file.newConnection':
      s.openConnectionEditor('new');
      return;
    case 'file.newQuery':
      s.openQuery();
      return;
    case 'file.refresh':
      // 与 F5 / Ctrl+R 同一条路径：优先刷新当前连接的对象树
      if (s.activeConnectionId) void s.loadSchema(s.activeConnectionId, true);
      else void s.refreshAllSchemas();
      return;
    case 'file.closeTab': {
      const tab = s.activeTabId;
      if (tab && tab !== 'welcome') s.closeTab(tab);
      return;
    }
    case 'view.palette':
      s.setPaletteOpen(true);
      return;
    case 'view.agent':
      s.setAgentOpen(!s.agentOpen);
      return;
    case 'view.sidebar':
      s.toggleSidebar();
      return;
    case 'view.theme':
      void s.saveSettings({ theme: s.settings.theme === 'dark' ? 'light' : 'dark' });
      return;
    case 'tools.hub':
      s.openTools();
      return;
    case 'tools.backup':
      void s.openBackup();
      return;
    case 'tools.memory':
      s.openMemory();
      return;
    case 'tools.settings':
      s.setSettingsOpen(true);
      return;
    default:
      // 未知 id（旧菜单树与新前端错位时）静默忽略，避免弹错
      return;
  }
}

/** 桌面端才装菜单；网页预览没有主进程。 */
export async function installAppMenu(): Promise<void> {
  if (!desktopBridge?.setApplicationMenu) return;
  try {
    await desktopBridge.setApplicationMenu(buildAppMenu(desktopBridge.platform));
  } catch {
    // 菜单装不上不应影响应用启动，快捷键与 ribbon 仍然可用
  }
}
