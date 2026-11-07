import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Database,
  Eye,
  FileSearch,
  FolderOpen,
  MoreHorizontal,
  Network,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Sparkles,
  Table2,
  TerminalSquare,
  Wrench,
  Download,
  Pencil,
  Copy,
  Trash2,
  Radio,
  FileCode2,
  Eraser,
  Hammer,
  Archive,
  Code2,
  Info,
  KeyRound,
  Upload,
  PanelLeftClose,
  LayoutDashboard,
} from 'lucide-react';
import type { ConnectionConfig, DatabaseSchema, Engine, TableInfo } from '@aidb/core';
import { addField, engineMeta, managesIndexes, managesObjects } from '@aidb/core';
import { api } from '../lib/api';
import { useApp, type ContextMenuItem } from '../store';
import { desktopBridge, desktopDialogUi } from '../lib/desktop';
import { groupFromLabel, groupLabel, groupOfConnection } from '../lib/groups';
import { deliverExport } from '../lib/exportDelivery';
import { EngineIcon } from './EngineIcon';
import type { TableDialogKind } from './TableOpsDialog';
import type { DatabaseDialogKind } from './DatabaseOpsDialog';
import { askConfirm, askPrompt } from './AskDialog';
import { t as tr } from '../i18n';

// 右键菜单才用到的弹窗不占首屏：打开哪一个就取哪一个。
const TableOpsDialog = lazy(() => import('./TableOpsDialog').then((m) => ({ default: m.TableOpsDialog })));
const DatabaseOpsDialog = lazy(() => import('./DatabaseOpsDialog').then((m) => ({ default: m.DatabaseOpsDialog })));
const CreateObjectDialog = lazy(() => import('./CreateObjectDialog').then((m) => ({ default: m.CreateObjectDialog })));
const DropObjectDialog = lazy(() => import('./DropObjectDialog').then((m) => ({ default: m.DropObjectDialog })));
const TableInfoDialog = lazy(() => import('./TableInfoDialog').then((m) => ({ default: m.TableInfoDialog })));

const COLORS: Record<string, string> = {
  blue: '#5b93ff',
  green: '#46c46b',
  orange: '#e0a155',
  red: '#f16b62',
  purple: '#a78bfa',
  cyan: '#38bdf8',
  gray: '#7d8b9a',
};

const ENV_LABEL: Record<string, string> = { dev: 'DEV', staging: 'STG', prod: 'PROD' };

/** 每级缩进 12px；叶子行没有展开箭头，需多让出一个箭头位才能与同级文件夹的图标/文字对齐。 */
const INDENT = { database: 22, folder: 34, folderLeaf: 55, tableLeaf: 67 };

export function quoteName(name: string, engine: string): string {
  if (engine === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function Sidebar() {
  const connections = useApp((s) => s.connections);
  const schemas = useApp((s) => s.schemas);
  const loadedDatabases = useApp((s) => s.loadedDatabases);
  const schemaLoading = useApp((s) => s.schemaLoading);
  const expanded = useApp((s) => s.expandedConnections);
  const expandedSchemas = useApp((s) => s.expandedSchemas);
  const collapsedGroupList = useApp((s) => s.collapsedGroups);
  const setCollapsedGroupList = useApp((s) => s.setCollapsedGroups);
  const collapsedGroups = useMemo(() => new Set(collapsedGroupList), [collapsedGroupList]);
  const groupOrder = useApp((s) => s.groupOrder);
  const setGroupOrder = useApp((s) => s.setGroupOrder);
  const connectionOrder = useApp((s) => s.connectionOrder);
  const setConnectionOrder = useApp((s) => s.setConnectionOrder);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const t = useApp((s) => s.t);
  const toggleConnection = useApp((s) => s.toggleConnection);
  const selectConnection = useApp((s) => s.selectConnection);
  const toggleSchema = useApp((s) => s.toggleSchema);
  const homeDatabase = useApp((s) => s.homeDatabase);
  const setHomeDatabase = useApp((s) => s.setHomeDatabase);
  const openData = useApp((s) => s.openData);
  const openQuery = useApp((s) => s.openQuery);
  const openDesign = useApp((s) => s.openDesign);
  const openRelations = useApp((s) => s.openRelations);
  const openDashboard = useApp((s) => s.openDashboard);
  const openConnectionEditor = useApp((s) => s.openConnectionEditor);
  const deleteConnection = useApp((s) => s.deleteConnection);
  const loadSchema = useApp((s) => s.loadSchema);
  const prefillAgent = useApp((s) => s.prefillAgent);
  const notify = useApp((s) => s.notify);
  const refreshAll = useApp((s) => s.refreshAllSchemas);
  const openTools = useApp((s) => s.openTools);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const openContextMenu = useApp((s) => s.openContextMenu);
  const toggleSidebar = useApp((s) => s.toggleSidebar);

  const [query, setQuery] = useState('');
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [tableDialog, setTableDialog] = useState<{ kind: TableDialogKind; conn: ConnectionConfig; schema: DatabaseSchema; table: TableInfo; withData?: boolean } | null>(null);
  const [dbDialog, setDbDialog] = useState<{ kind: DatabaseDialogKind; conn: ConnectionConfig; database: string } | null>(null);
  const [objectDialog, setObjectDialog] = useState<{ conn: ConnectionConfig; database?: string } | null>(null);
  const [dropDialog, setDropDialog] = useState<{ conn: ConnectionConfig; database?: string; name: string } | null>(null);
  const [infoTable, setInfoTable] = useState<{
    table: TableInfo;
    database?: string;
    objectLabel?: string;
    relational?: boolean;
    connectionId?: string;
    manageIndexes?: boolean;
    canAddField?: boolean;
    engine?: Engine;
  } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (schemas[c.id] ?? []).some((schema) => schema.tables.some((table) => table.name.toLowerCase().includes(q))),
    );
  }, [connections, query, schemas]);

  const grouped = useMemo(() => {
    const orderIndex = new Map(connectionOrder.map((id, index) => [id, index]));
    const ordered = [...filtered].sort((a, b) => {
      const left = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const right = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return left === right ? 0 : left - right;
    });
    const map = new Map<string, ConnectionConfig[]>();
    for (const conn of ordered) {
      const key = groupOfConnection(conn.groupName);
      map.set(key, [...(map.get(key) ?? []), conn]);
    }
    const indexOf = new Map(groupOrder.map((name, index) => [name, index]));
    return [...map.entries()].sort((a, b) => {
      const left = indexOf.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const right = indexOf.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      return left === right ? 0 : left - right;
    });
  }, [filtered, groupOrder, connectionOrder]);

  useEffect(() => {
    // 重启后只恢复了展开状态，schema 是内存态；不给展开的连接补一次加载会一直停在 Loading…
    const pending = connections.filter((conn) => expanded[conn.id] && !schemas[conn.id]);
    if (!pending.length) return;
    let cancelled = false;
    // 展开状态可能一次恢复十几个连接，并发上限 2，避免启动瞬间同时打十几个库。
    const queue = [...pending];
    const worker = async () => {
      for (;;) {
        const conn = queue.shift();
        if (!conn || cancelled) return;
        await loadSchema(conn.id);
      }
    };
    void Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
    return () => {
      cancelled = true;
    };
  }, [connections, expanded, schemas, loadSchema]);

  const openMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, items);
  };

  const renameGroup = async (group: string) => {
    const next = await askPrompt({ title: tr("重命名分组"), message: tr("分组「{0}」重命名为：", [groupLabel(group)]), value: groupLabel(group), confirmLabel: tr("重命名") });
    const renamed = groupFromLabel((next ?? '').trim());
    if (!renamed || renamed === group) return;
    try {
      await api.renameGroup(group, renamed);
      await useApp.getState().boot();
      notify('success', tr("分组已重命名"), groupLabel(renamed));
    } catch (err: any) {
      notify('error', tr("重命名失败"), err?.message);
    }
  };

  const createShortcut = async (conn: ConnectionConfig, schema: DatabaseSchema, table: TableInfo) => {
    if (!desktopBridge) return;
    const result = await desktopBridge.createTableShortcut({
      ui: desktopDialogUi(),
      connectionId: conn.id,
      database: schema.name,
      table: table.name,
      name: `${conn.name}-${table.name}`,
    });
    if (result.ok) notify('success', tr("快捷方式已创建"), result.path ?? '');
    else notify('error', tr("创建失败"), result.error ?? tr("未知错误"));
  };

  const moveConnectionToGroup = async (connectionId: string, group: string) => {
    const conn = connections.find((item) => item.id === connectionId);
    if (!conn || groupOfConnection(conn.groupName) === group) return;
    try {
      await api.updateConnection(connectionId, { groupName: group });
      await useApp.getState().boot();
      notify('success', tr("连接已移动"), `${conn.name} → ${group}`);
    } catch (err: any) {
      notify('error', tr("移动失败"), err?.message);
    }
  };

  const removeGroup = async (group: string) => {
    if (!(await askConfirm({ message: tr("删除分组「{0}」？", [groupLabel(group)]), detail: tr("组内连接会移动到「默认」，不会删除连接本身。"), danger: true, confirmLabel: tr("删除") }))) return;
    try {
      await api.deleteGroup(group);
      await useApp.getState().boot();
      notify('success', tr("分组已删除"), group);
    } catch (err: any) {
      notify('error', tr("删除失败"), err?.message);
    }
  };

  const testConnection = async (conn: ConnectionConfig) => {
    try {
      const { result } = await api.testConnection(conn.id);
      if (result.ok) notify('success', t('connectionTestPassed'), result.version ?? `${result.latencyMs}ms`);
      else notify('error', t('connectionTestFailed'), result.message);
    } catch (err: any) {
      notify('error', t('connectionTestFailed'), err?.message);
    }
  };

  const exportTable = async (conn: ConnectionConfig, table: TableInfo, database?: string) => {
    try {
      const { file } = await api.exportData({ connectionId: conn.id, database, table: table.name, format: 'csv' });
      await deliverExport(file, t('export'));
    } catch (err: any) {
      notify('error', t('error'), err?.message);
    }
  };

  const quickTableOp = async (kind: 'truncate' | 'empty' | 'drop', conn: ConnectionConfig, schema: DatabaseSchema, table: TableInfo) => {
    const isDrop = kind === 'drop';
    const isTruncate = kind === 'truncate';
    const label = table.type === 'view' ? tr("视图") : tr("表");
    const message = isDrop
      ? tr("删除{0}「{1}」？此操作不可恢复。", [label, table.name])
      : isTruncate
        ? tr("截断表「{0}」并重置自增计数？此操作不可恢复。", [table.name])
        : tr("清空表「{0}」中的全部数据？自增计数不会重置。", [table.name]);
    if (!(await askConfirm({ message, danger: true, confirmLabel: isDrop ? tr("删除") : isTruncate ? tr("截断") : tr("清空") }))) return;
    try {
      await api.tableOps({ connectionId: conn.id, database: schema.name, table: table.name, op: kind });
      notify('success', isDrop ? tr("{0}已删除", [label]) : isTruncate ? tr("表已截断") : tr("表已清空"), table.name);
      await loadSchema(conn.id, true);
    } catch (err: any) {
      notify('error', isDrop ? tr("删除失败") : tr("清空失败"), err?.message);
    }
  };

  const renderNonRelationalObject = (conn: ConnectionConfig, schema: DatabaseSchema, table: TableInfo, padding: number) => {
    const meta = engineMeta(conn.engine);
    const isMongo = meta.model === 'document';
    const isGraph = meta.model === 'graph';
    const isVector = meta.model === 'vector';
    const isSearch = meta.model === 'search';
    const isWide = meta.model === 'widecolumn';
    const isAql = meta.languages.includes('aql');
    const isEdge = table.kind === 'edge_label';
    const isRedisIndex = meta.model === 'keyvalue' && table.kind === 'index';
    const objectLabel = isRedisIndex ? tr("搜索索引") : isAql ? (isEdge ? tr("边集合") : tr("文档集合")) : isMongo ? tr("集合") : isGraph ? (isEdge ? tr("关系类型") : tr("节点标签")) : isVector ? tr("向量集合") : isSearch ? tr("索引") : isWide ? tr("表") : tr("键空间");
    const openLabel = isRedisIndex ? tr("打开索引") : isAql ? (isEdge ? tr("打开边集合") : tr("打开集合")) : isMongo ? tr("打开集合") : isGraph ? (isEdge ? tr("打开关系类型") : tr("打开节点标签")) : isVector ? tr("浏览集合") : isSearch ? tr("打开索引") : isWide ? tr("打开表") : tr("浏览键");
    const newQueryLabel = isRedisIndex ? tr("新建 RediSearch 查询") : isAql ? tr("新建 AQL 查询") : isMongo ? tr("新建 MQL 查询") : isGraph ? tr("新建 Cypher 查询") : isVector ? tr("新建向量查询") : isSearch ? tr("新建搜索查询") : isWide ? tr("新建 CQL 查询") : tr("命令列");
    const vectorQuery = JSON.stringify({ collection: table.name, op: 'scroll', topK: 20 }, null, 2);
    const searchQuery = JSON.stringify({ index: table.name, query: { match_all: {} }, size: 100 }, null, 2);
    const cqlQuery = `SELECT * FROM "${schema.name}"."${table.name}" LIMIT 100;`;
    const aqlQuery = `FOR d IN \`${table.name.replace(/`/g, '')}\` LIMIT 100 RETURN d`;
    const redisSearch = `FT.SEARCH ${table.name} * LIMIT 0 20`;
    const newQueryText = isRedisIndex ? redisSearch : isAql ? aqlQuery : isMongo ? '' : isGraph ? 'MATCH (n) RETURN n LIMIT 100' : isVector ? vectorQuery : isSearch ? searchQuery : isWide ? cqlQuery : 'SCAN 0 COUNT 100';
    const open = () => {
      if (isRedisIndex) {
        openQuery(conn.id, redisSearch, table.name, schema.name);
      } else if (isAql) {
        openQuery(conn.id, aqlQuery, table.name, schema.name);
      } else if (isMongo) {
        openQuery(
          conn.id,
          JSON.stringify({ collection: table.name, op: 'find', filter: {}, limit: 100 }, null, 2),
          table.name,
          schema.name,
        );
      } else if (isGraph) {
        const label = table.name.replace(/`/g, '``');
        const text = isEdge
          ? `MATCH ()-[r:\`${label}\`]->() RETURN r LIMIT 100`
          : `MATCH (n:\`${label}\`) RETURN n LIMIT 100`;
        openQuery(conn.id, text, table.name, schema.name);
      } else if (isVector) {
        openQuery(conn.id, vectorQuery, table.name, schema.name);
      } else if (isSearch) {
        openQuery(conn.id, searchQuery, table.name, schema.name);
      } else if (isWide) {
        openQuery(conn.id, cqlQuery, table.name, schema.name);
      } else {
        openQuery(conn.id, 'SCAN 0 COUNT 100', `${meta.label} · ${schema.name}`, schema.name);
      }
    };
    const items: ContextMenuItem[] = [
      { label: openLabel, icon: <Database size={13} />, onClick: open },
      {
        label: newQueryLabel,
        icon: <TerminalSquare size={13} />,
        onClick: () => openQuery(conn.id, newQueryText, undefined, schema.name),
      },
      {
        label: tr("AI 解释此对象"),
        icon: <Sparkles size={13} />,
        onClick: () =>
          prefillAgent(
            isRedisIndex
              ? tr("解释 RediSearch 索引 {0} 的字段定义与查询语法，并给出 3 个 FT.SEARCH 示例。", [table.name])
              : isMongo
              ? tr("解释集合 {0} 的字段、索引与典型用途，并给出 3 个 MQL 查询示例。", [table.name])
              : isAql
                ? tr("解释{0} {1} 的属性和关系，并给出 3 个 AQL 查询示例。", [objectLabel, table.name])
                : isGraph
                ? tr("解释{0} {1} 的属性和关系，并给出 3 个 Cypher 查询示例。", [objectLabel, table.name])
                : isVector
                  ? tr("解释向量集合 {0} 的维度、距离与 payload 字段，并给出向量检索示例。", [table.name])
                  : isSearch
                    ? tr("解释索引 {0} 的 mapping 与字段用途，并给出 3 个 _search DSL 示例。", [table.name])
                    : isWide
                      ? tr("解释 Cassandra 表 {0} 的主键、分区键与查询限制，并给出 3 个 CQL 示例。", [table.name])
                      : tr("总结 Redis 键空间 {0} 的键类型与常见前缀，并给出浏览与排查命令。", [schema.name]),
          ),
      },
      { label: '', icon: null, sep: true, onClick: () => undefined },
      ...(table.indexes?.length || managesIndexes(conn.engine) || addField(conn.engine)
        ? [{
            label: tr("对象信息"),
            icon: <Info size={13} />,
            onClick: () =>
              setInfoTable({
                table,
                database: schema.name,
                objectLabel,
                relational: false,
                connectionId: conn.id,
                manageIndexes: managesIndexes(conn.engine) && !conn.readonly,
                canAddField: addField(conn.engine) && !conn.readonly,
                engine: conn.engine,
              }),
          }]
        : []),
      { label: t('refresh'), icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, true) },
      {
        label: t('copy'),
        icon: <Copy size={13} />,
        onClick: () => void navigator.clipboard.writeText(table.name).then(() => notify('success', t('copied'))),
      },
    ];
    if (managesObjects(conn.engine) || isRedisIndex) {
      items.push({ label: '', icon: null, sep: true, onClick: () => undefined });
      items.push({
        label: isRedisIndex || meta.model === 'search' ? tr("删除索引…") : isEdge ? tr("删除边集合…") : tr("删除集合…"),
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => setDropDialog({ conn, database: schema.name, name: table.name }),
      });
    }
    return (
      <div
        key={`${schema.name}.${table.name}`}
        className="tree-node"
        style={{ paddingLeft: padding }}
        onClick={open}
        onContextMenu={(e) => openMenu(e, items)}
        title={`${objectLabel} ${table.name}`}
      >
        {isGraph ? <Network size={13} style={{ color: 'var(--accent)' }} /> : <Database size={13} style={{ color: 'var(--accent)' }} />}        <span className="node-label">{table.name}</span>
        <span className="node-tail">
          {table.rowEstimate !== undefined ? <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{table.rowEstimate}</span> : null}
          <span className="node-actions">
            <button
              className="icon-btn"
              title={openLabel}
              onClick={(e) => {
                e.stopPropagation();
                open();
              }}
            >
              <TerminalSquare size={12} />
            </button>
          </span>
        </span>
      </div>
    );
  };

  const renderTable = (conn: ConnectionConfig, schema: DatabaseSchema, table: TableInfo, padding: number) => {
    const q = query.trim().toLowerCase();
    if (q && !table.name.toLowerCase().includes(q)) return null;
    if (!engineMeta(conn.engine).languages.includes('sql')) return renderNonRelationalObject(conn, schema, table, padding);
    return (
      <div
        key={`${schema.name}.${table.name}`}
        className="tree-node"
        style={{ paddingLeft: padding }}
        onClick={() => openData(conn.id, table.name, schema.name)}
        onContextMenu={(e) => {
          const items: ContextMenuItem[] =
            table.type === 'view'
              ? [
                  { label: t('data'), icon: <Table2 size={13} />, onClick: () => openData(conn.id, table.name, schema.name) },
                  {
                    label: t('newQuery'),
                    icon: <TerminalSquare size={13} />,
                    onClick: () => openQuery(conn.id, `SELECT * FROM ${quoteName(table.name, conn.engine)} LIMIT 100;`, undefined, schema.name),
                  },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: tr("查看 DDL"), icon: <FileCode2 size={13} />, onClick: () => setTableDialog({ kind: 'ddl', conn, schema, table }) },
                  ...(desktopBridge?.platform === 'win32' ? [{ label: tr("创建快捷方式"), icon: <Archive size={13} />, onClick: () => void createShortcut(conn, schema, table) } as ContextMenuItem] : []),
                  { label: tr("打印表"), icon: <Printer size={13} />, onClick: () => { openData(conn.id, table.name, schema.name); useApp.getState().requestPrint(); } },
                  { label: tr("删除视图"), icon: <Trash2 size={13} />, danger: true, onClick: () => void quickTableOp('drop', conn, schema, table) },
                  {
                    label: tr("AI 解释此视图"),
                    icon: <Sparkles size={13} />,
                    onClick: () => prefillAgent(tr("解释视图 {0} 的字段、来源表与用途，并给出常用查询示例。", [table.name])),
                  },
                  {
                    label: t('copy'),
                    icon: <Copy size={13} />,
                    onClick: () => void navigator.clipboard.writeText(table.name).then(() => notify('success', t('copied'))),
                  },
                ]
              : [
                  { label: t('data'), icon: <Table2 size={13} />, onClick: () => openData(conn.id, table.name, schema.name) },
                  {
                    label: t('newQuery'),
                    icon: <TerminalSquare size={13} />,
                    onClick: () => openQuery(conn.id, `SELECT * FROM ${quoteName(table.name, conn.engine)} LIMIT 100;`, undefined, schema.name),
                  },
                  {
                    label: t('design'),
                    icon: <Wrench size={13} />,
                    onClick: () => openDesign(conn.id, table.name, schema.name),
                  },
                  { label: tr("新建表"), icon: <Plus size={13} />, onClick: () => openDesign(conn.id, undefined, schema.name) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: tr("重命名表…"), icon: <Pencil size={13} />, onClick: () => setTableDialog({ kind: 'rename', conn, schema, table }) },
                  { label: tr("复制表（结构 + 数据）…"), icon: <Copy size={13} />, onClick: () => setTableDialog({ kind: 'duplicate', conn, schema, table, withData: true }) },
                  { label: tr("复制表（仅结构）…"), icon: <Copy size={13} />, onClick: () => setTableDialog({ kind: 'duplicate', conn, schema, table, withData: false }) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: tr("查看 DDL"), icon: <FileCode2 size={13} />, onClick: () => setTableDialog({ kind: 'ddl', conn, schema, table }) },
                  ...(desktopBridge?.platform === 'win32' ? [{ label: tr("创建快捷方式"), icon: <Archive size={13} />, onClick: () => void createShortcut(conn, schema, table) } as ContextMenuItem] : []),
                  { label: tr("打印表"), icon: <Printer size={13} />, onClick: () => { openData(conn.id, table.name, schema.name); useApp.getState().requestPrint(); } },
                  { label: tr("维护表…"), icon: <Hammer size={13} />, onClick: () => setTableDialog({ kind: 'maintenance', conn, schema, table }) },
                  { label: tr("对象信息"), icon: <Info size={13} />, onClick: () => setInfoTable({ table, database: schema.name }) },
                  { label: tr("设置权限…"), icon: <KeyRound size={13} />, onClick: () => openTools('users') },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: tr("导入向导…"), icon: <Upload size={13} />, onClick: () => openData(conn.id, table.name, schema.name) },
                  { label: tr("导出向导…"), icon: <Download size={13} />, onClick: () => void exportTable(conn, table, schema.name) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: tr("清空表"), icon: <Eraser size={13} />, danger: true, onClick: () => void quickTableOp('empty', conn, schema, table) },
                  { label: tr("截断表"), icon: <Hammer size={13} />, danger: true, onClick: () => void quickTableOp('truncate', conn, schema, table) },
                  { label: tr("删除表"), icon: <Trash2 size={13} />, danger: true, onClick: () => void quickTableOp('drop', conn, schema, table) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: tr("逆向表到模型…"), icon: <Network size={13} />, onClick: () => openRelations(conn.id, schema.name) },
                  { label: t('refresh'), icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, true) },
                  {
                    label: tr("AI 解释此表"),
                    icon: <Sparkles size={13} />,
                    onClick: () => prefillAgent(tr("解释表 {0} 的结构、索引与用途，并给出常用查询示例。", [table.name])),
                  },
                  {
                    label: tr("AI 数据质量"),
                    icon: <Sparkles size={13} />,
                    onClick: () => prefillAgent(tr("检查 {0} 的空值、空串和重复主键，并给出排查 SQL。", [table.name])),
                  },
                  {
                    label: t('copy'),
                    icon: <Copy size={13} />,
                    onClick: () => void navigator.clipboard.writeText(table.name).then(() => notify('success', t('copied'))),
                  },
                ];
          openMenu(e, items);
        }}
        title={`${table.type === 'view' ? 'VIEW' : 'TABLE'} ${table.name}`}
      >
        {table.type === 'view' ? <Eye size={13} style={{ color: 'var(--text-muted)' }} /> : <Table2 size={13} style={{ color: 'var(--accent)' }} />}
        <span className="node-label">{table.name}</span>
        <span className="node-tail">
          {table.rowEstimate !== undefined ? <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{table.rowEstimate}</span> : null}
          <span className="node-actions">
            <button
              className="icon-btn"
              title={t('newQuery')}
              onClick={(e) => {
                e.stopPropagation();
                openQuery(conn.id, `SELECT * FROM ${quoteName(table.name, conn.engine)} LIMIT 100;`, undefined, schema.name);
              }}
            >
              <TerminalSquare size={12} />
            </button>
            <button
              className="icon-btn"
              title={t('design')}
              onClick={(e) => {
                e.stopPropagation();
                openDesign(conn.id, table.name, schema.name);
              }}
            >
              <Wrench size={12} />
            </button>
          </span>
        </span>
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <span>{t('connections')}</span>
          <div className="row gap-4">
            <button className="icon-btn" title={t('newConnection')} onClick={() => openConnectionEditor('new')}>
              <Plus size={14} />
            </button>
            <button className="icon-btn" title={tr("隐藏连接栏 (⌘B)")} data-testid="sidebar-collapse" onClick={toggleSidebar}>
              <PanelLeftClose size={14} />
            </button>
          </div>
        </div>
        <div className="search-box">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchConnections')} data-testid="sidebar-search" />
        </div>
      </div>
      <div className="sidebar-body">
        <div className="sidebar-tree">
        {!connections.length ? (
          <div className="empty-state" style={{ padding: 24 }}>
            <div>
              <div className="icon">
                <Database size={20} />
              </div>
              <h3>{t('noConnections')}</h3>
              <button className="btn primary" style={{ marginTop: 10 }} onClick={() => openConnectionEditor('new')}>
                <Plus size={13} /> {t('newConnection')}
              </button>
            </div>
          </div>
        ) : null}
        {grouped.map(([group, list]) => {
          const collapsed = collapsedGroups.has(group) && !query.trim();
          return (
          <div key={group}>
            <div
              role="button"
              tabIndex={0}
              className="group-label"
              onClick={() => {
                const next = new Set(collapsedGroups);
                if (next.has(group)) next.delete(group);
                else next.add(group);
                setCollapsedGroupList([...next]);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                const next = new Set(collapsedGroups);
                if (next.has(group)) next.delete(group);
                else next.add(group);
                setCollapsedGroupList([...next]);
              }}
              data-testid={`group-toggle-${group}`}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(event, [
                  { label: tr("重命名分组"), icon: <Pencil size={13} />, onClick: () => void renameGroup(group) },
                  { label: tr("删除分组"), icon: <Trash2 size={13} />, danger: true, onClick: () => void removeGroup(group) },
                ]);
              }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('text/aidb-group', group);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                const connectionId = event.dataTransfer.getData('text/aidb-connection');
                if (connectionId) {
                  void moveConnectionToGroup(connectionId, group);
                  return;
                }
                const dragged = event.dataTransfer.getData('text/aidb-group');
                if (!dragged || dragged === group) return;
                const names = grouped.map(([name]) => name);
                const target = names.indexOf(group);
                const next = names.filter((name) => name !== dragged);
                next.splice(Math.min(target, next.length), 0, dragged);
                setGroupOrder(next);
              }}
            >
              <ChevronRight size={11} className={`conn-toggle ${collapsed ? '' : 'open'}`} />
              {groupLabel(group)}
              <span className="group-count">{list.length}</span>
            </div>
            {list.map((conn) => {
              if (collapsed) return null;
              const isOpen = expanded[conn.id] || Boolean(query.trim());
              const connSchemas = schemas[conn.id];
              return (
                <div key={conn.id}>
                  <div
                    className={`conn-row ${activeConnectionId === conn.id ? 'active' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/aidb-connection', conn.id);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes('text/aidb-connection')) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(event) => {
                      const draggedId = event.dataTransfer.getData('text/aidb-connection');
                      if (!draggedId || draggedId === conn.id) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const source = connections.find((item) => item.id === draggedId);
                      if (!source) return;
                      if (groupOfConnection(source.groupName) !== groupOfConnection(conn.groupName)) {
                        void moveConnectionToGroup(draggedId, groupOfConnection(conn.groupName));
                        return;
                      }
                      const ids = [...connections]
                        .sort((a, b) => {
                          const orderIndex = new Map(connectionOrder.map((id, index) => [id, index]));
                          return (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER);
                        })
                        .map((item) => item.id);
                      const target = ids.indexOf(conn.id);
                      const next = ids.filter((id) => id !== draggedId);
                      next.splice(Math.min(target, next.length), 0, draggedId);
                      setConnectionOrder(next);
                    }}
                    onClick={() => {
                      selectConnection(conn.id);
                      toggleConnection(conn.id);
                    }}
                    onContextMenu={(e) =>
                      openMenu(e, [
                        { label: t('editConnection'), icon: <Pencil size={13} />, onClick: () => openConnectionEditor('edit', conn) },
                        { label: t('test'), icon: <Radio size={13} />, onClick: () => void testConnection(conn) },
                        { label: t('refresh'), icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, true) },
                        { label: '', icon: null, sep: true, onClick: () => undefined },
                        { label: t('newQuery'), icon: <TerminalSquare size={13} />, onClick: () => openQuery(conn.id) },
                        { label: tr("新建表"), icon: <Plus size={13} />, onClick: () => openDesign(conn.id) },
                        { label: t('design'), icon: <Wrench size={13} />, onClick: () => openDesign(conn.id) },
                        { label: tr("关系图"), icon: <Network size={13} />, onClick: () => openRelations(conn.id) },
                        { label: tr("AI 数据库体检"), icon: <Sparkles size={13} />, onClick: () => prefillAgent(tr("对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。")) },
                        { label: t('copy'), icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(conn.name) },
                        { label: '', icon: null, sep: true, onClick: () => undefined },
                        {
                          label: t('delete'),
                          icon: <Trash2 size={13} />,
                          danger: true,
                          onClick: async () => {
                            if (await askConfirm({ message: tr("删除连接「{0}」？", [conn.name]), detail: tr("仅移除配置，不会删除数据库。"), danger: true, confirmLabel: t('delete') })) void deleteConnection(conn.id);
                          },
                        },
                      ])
                    }
                    data-testid={`connection-${conn.id}`}
                  >
                    <ChevronRight size={13} className={`conn-toggle ${isOpen ? 'open' : ''}`} onClick={(e) => { e.stopPropagation(); toggleConnection(conn.id); }} />
                    <EngineIcon engine={conn.engine} />
                    <span className="conn-color" style={{ background: COLORS[conn.color] ?? COLORS.blue }} />
                    <span className="conn-name">{conn.name}</span>
                    {conn.environment === 'prod' ? <span className="env-pill prod" style={{ fontSize: 8, padding: '0 4px' }}>PROD</span> : null}
                    {conn.readonly ? <span title={t('readonly')} style={{ color: 'var(--warning)' }}>🔒</span> : null}
                    <button
                      className="icon-btn"
                      style={{ width: 20, height: 20 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openMenu(e, [
                          { label: t('editConnection'), icon: <Pencil size={13} />, onClick: () => openConnectionEditor('edit', conn) },
                          { label: t('test'), icon: <Radio size={13} />, onClick: () => void testConnection(conn) },
                          { label: t('refresh'), icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, true) },
                          { label: t('newQuery'), icon: <TerminalSquare size={13} />, onClick: () => openQuery(conn.id) },
                          { label: tr("新建表"), icon: <Plus size={13} />, onClick: () => openDesign(conn.id) },
                          { label: t('design'), icon: <Wrench size={13} />, onClick: () => openDesign(conn.id) },
                          { label: tr("关系图"), icon: <Network size={13} />, onClick: () => openRelations(conn.id) },
                          { label: tr("AI 数据库体检"), icon: <Sparkles size={13} />, onClick: () => prefillAgent(tr("对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。")) },
                          {
                            label: t('delete'),
                            icon: <Trash2 size={13} />,
                            danger: true,
                            onClick: async () => {
                              if (await askConfirm({ message: tr("删除连接「{0}」？", [conn.name]), detail: tr("仅移除配置，不会删除数据库。"), danger: true, confirmLabel: t('delete') })) void deleteConnection(conn.id);
                            },
                          },
                        ]);
                      }}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </div>
                  {isOpen ? (
                    connSchemas ? (
                      connSchemas.map((schema) => {
                        const schemaKey = `${conn.id}:${schema.name}`;
                        const single = connSchemas.length === 1;
                        const schemaOpen = expandedSchemas[schemaKey] ?? single;
                        const loaded = (loadedDatabases[conn.id] ?? []).includes(schema.name);
                        const loading = Boolean(schemaLoading[schemaKey]);
                        const tables = [...schema.tables].sort((a, b) => a.name.localeCompare(b.name));
                        return (
                          <div key={schemaKey}>
                            <div
                              className={`tree-node db-node${conn.id === activeConnectionId && schema.name === homeDatabase ? ' current' : ''}`}
                              style={{ paddingLeft: INDENT.database }}
                              onClick={() => {
                                // 点库 = 只把首页切到这个库；Agent 的目标库不动（已解耦）
                                if (conn.id !== activeConnectionId) selectConnection(conn.id);
                                setHomeDatabase(schema.name);
                                // 未加载时第一次点击就加载，不再要求“先收起再展开”点两次。
                                if (!loaded && !loading) {
                                  if (!schemaOpen) toggleSchema(schemaKey);
                                  void loadSchema(conn.id, false, schema.name);
                                  return;
                                }
                                toggleSchema(schemaKey);
                              }}
                              onContextMenu={(e) =>
                                !engineMeta(conn.engine).languages.includes('sql')
                                  ? openMenu(e, [
                                      { label: tr("关闭数据库"), icon: <FolderOpen size={13} />, onClick: () => toggleSchema(schemaKey) },
                                      {
                                        label: tr("新建查询"),
                                        icon: <TerminalSquare size={13} />,
                                        onClick: () =>
                                          openQuery(
                                            conn.id,
                                            engineMeta(conn.engine).languages.includes('mql')
                                              ? '{\n  "collection": "",\n  "op": "find",\n  "filter": {}\n}'
                                              : engineMeta(conn.engine).languages.includes('aql')
                                                ? 'FOR d IN @@collection LIMIT 100 RETURN d'
                                                : engineMeta(conn.engine).languages.includes('cypher')
                                                ? 'MATCH (n) RETURN n LIMIT 100'
                                                : engineMeta(conn.engine).model === 'vector'
                                                  ? '{\n  "collection": "",\n  "op": "scroll",\n  "topK": 20\n}'
                                                  : engineMeta(conn.engine).model === 'search'
                                                    ? '{\n  "index": "",\n  "query": { "match_all": {} },\n  "size": 100\n}'
                                                    : engineMeta(conn.engine).model === 'widecolumn'
                                                      ? `SELECT * FROM "${schema.name}"."<table>" LIMIT 100;`
                                                      : 'SCAN 0 COUNT 100',
                                            undefined,
                                            schema.name,
                                          ),
                                      },
                                      { label: t('refresh'), icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, true) },
                                      {
                                        label: tr("复制名称"),
                                        icon: <Copy size={13} />,
                                        onClick: () => void navigator.clipboard.writeText(schema.name).then(() => notify('success', t('copied'))),
                                      },
                                    ])
                                  : openMenu(e, [
                                  { label: tr("关闭数据库"), icon: <FolderOpen size={13} />, onClick: () => toggleSchema(schemaKey) },
                                  { label: tr("编辑数据库…"), icon: <Pencil size={13} />, onClick: () => setDbDialog({ kind: 'rename', conn, database: schema.name }) },
                                  { label: tr("新建数据库…"), icon: <Plus size={13} />, onClick: () => setDbDialog({ kind: 'create', conn, database: '' }) },
                                  { label: tr("删除数据库…"), icon: <Trash2 size={13} />, danger: true, onClick: () => setDbDialog({ kind: 'drop', conn, database: schema.name }) },
                                  { label: '', icon: null, sep: true, onClick: () => undefined },
                                  { label: tr("新建表"), icon: <Table2 size={13} />, onClick: () => openDesign(conn.id, undefined, schema.name) },
                                  { label: tr("新建查询"), icon: <TerminalSquare size={13} />, onClick: () => openQuery(conn.id, undefined, undefined, schema.name) },
                                  { label: tr("命令列界面…"), icon: <FileCode2 size={13} />, onClick: () => openQuery(conn.id, undefined, undefined, schema.name) },
                                  { label: tr("运行 SQL 文件…"), icon: <FileCode2 size={13} />, onClick: () => openQuery(conn.id, undefined, undefined, schema.name) },
                                  { label: tr("转储 SQL 文件…"), icon: <Archive size={13} />, onClick: () => setDbDialog({ kind: 'dump', conn, database: schema.name }) },
                                  { label: '', icon: null, sep: true, onClick: () => undefined },
                                  { label: tr("逆向数据库到模型…"), icon: <Network size={13} />, onClick: () => openRelations(conn.id, schema.name) },
                                  { label: tr("打开仪表板"), icon: <LayoutDashboard size={13} />, onClick: () => openDashboard(conn.id, schema.name) },
                                  { label: tr("在数据库中查找…"), icon: <FileSearch size={13} />, onClick: () => openTools('search') },
                                  { label: '', icon: null, sep: true, onClick: () => undefined },
                                  {
                                    label: t('refresh'),
                                    icon: <RefreshCw size={13} />,
                                    onClick: () => void loadSchema(conn.id, true),
                                  },
                                  {
                                    label: tr("复制名称"),
                                    icon: <Copy size={13} />,
                                    onClick: () => void navigator.clipboard.writeText(schema.name).then(() => notify('success', t('copied'))),
                                  },
                                ])
                              }
                            >
                              <ChevronRight size={12} className={`conn-toggle ${schemaOpen ? 'open' : ''}`} />
                              <Database size={13} style={{ color: 'var(--text-muted)' }} />
                              <span className="node-label">{single ? (conn.engine === 'sqlite' ? 'main' : conn.database ?? schema.name) : schema.name}</span>
                              {loading ? (
                                <span className="spinner" style={{ width: 10, height: 10, margin: 0, borderWidth: 1.5 }} />
                              ) : loaded ? (
                                <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{tables.length}</span>
                              ) : null}
                            </div>
                            {schemaOpen ? (
                              <div>
                                {loading ? (
                                  <div className="loading-inline" style={{ paddingLeft: INDENT.tableLeaf, height: 26 }}>
                                    <span className="spinner" style={{ width: 10, height: 10, margin: 0, borderWidth: 1.5 }} /> {t('loading')}
                                  </div>
                                ) : !loaded ? (
                                  <div className="muted" style={{ paddingLeft: INDENT.tableLeaf, fontSize: 11, lineHeight: '24px' }}>{tr("未加载表 · 点击库名重试")}</div>
                                ) : query.trim() ? (
                                  tables.map((table) => renderTable(conn, schema, table, INDENT.folderLeaf))
                                ) : (
                                  <>
                                    {(() => {
                                      const tableList = tables.filter((table) => table.type !== 'view');
                                      const viewList = tables.filter((table) => table.type === 'view');
                                      const tableKey = `${schemaKey}:tables`;
                                      const viewKey = `${schemaKey}:views`;
                                      const tablesOpen = groupOpen[tableKey] ?? true;
                                      const viewsOpen = groupOpen[viewKey] ?? false;
                                      const model = engineMeta(conn.engine).model;
                                      if (!engineMeta(conn.engine).languages.includes('sql')) {
                                        return (
                                          <>
                                            <div
                                              className="tree-node folder-node"
                                              data-engine={conn.engine}
                                              style={{ paddingLeft: INDENT.folder }}
                                              onClick={() => setGroupOpen((prev) => ({ ...prev, [tableKey]: !tablesOpen }))}
                                              onContextMenu={(event) => {
                                                if (!managesObjects(conn.engine)) return;
                                                openMenu(event, [
                                                  {
                                                    label: model === 'search' ? tr("新建索引…") : tr("新建集合…"),
                                                    icon: <Plus size={13} />,
                                                    onClick: () => setObjectDialog({ conn, database: schema.name }),
                                                  },
                                                  { label: t('refresh'), icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, true, schema.name) },
                                                ]);
                                              }}
                                            >
                                              <ChevronRight size={12} className={`conn-toggle ${tablesOpen ? 'open' : ''}`} />
                                              {model === 'graph' ? (
                                                <Network size={13} style={{ color: 'var(--accent)' }} />
                                              ) : (
                                                <Database size={13} style={{ color: 'var(--accent)' }} />
                                              )}
                                              <span className="node-label">{engineMeta(conn.engine).languages.includes('aql') ? tr("集合") : model === 'document' ? tr("集合") : model === 'graph' ? tr("标签") : model === 'vector' ? tr("向量集合") : model === 'search' ? tr("索引") : model === 'widecolumn' ? tr("表") : tr("键空间")}</span>
                                              <span className="tree-count">{tables.length}</span>
                                            </div>
                                            {tablesOpen ? tables.map((table) => renderTable(conn, schema, table, INDENT.tableLeaf)) : null}
                                            <div
                                              className="tree-node obj-node"
                                              style={{ paddingLeft: INDENT.folderLeaf }}
                                              onClick={() =>
                                                openQuery(
                                                  conn.id,
                                                  model === 'document'
                                                    ? '{\n  "collection": "",\n  "op": "find",\n  "filter": {}\n}'
                                                    : engineMeta(conn.engine).languages.includes('aql')
                                                      ? 'FOR d IN @@collection LIMIT 100 RETURN d'
                                                      : model === 'graph'
                                                      ? 'MATCH (n) RETURN n LIMIT 100'
                                                      : model === 'vector'
                                                        ? '{\n  "collection": "",\n  "op": "scroll",\n  "topK": 20\n}'
                                                        : model === 'search'
                                                          ? '{\n  "index": "",\n  "query": { "match_all": {} },\n  "size": 100\n}'
                                                          : model === 'widecolumn'
                                                            ? `SELECT * FROM "${schema.name}"."<table>" LIMIT 100;`
                                                            : 'SCAN 0 COUNT 100',
                                                  undefined,
                                                  schema.name,
                                                )
                                              }
                                            >
                                              <TerminalSquare size={13} style={{ color: 'var(--text-muted)' }} />
                                              <span className="node-label">{tr("查询")}</span>
                                            </div>
                                          </>
                                        );
                                      }
                                      return (
                                        <>
                                          <div className="tree-node folder-node" style={{ paddingLeft: INDENT.folder }} onClick={() => setGroupOpen((prev) => ({ ...prev, [tableKey]: !tablesOpen }))}>
                                            <ChevronRight size={12} className={`conn-toggle ${tablesOpen ? 'open' : ''}`} />
                                            <Table2 size={13} style={{ color: 'var(--accent)' }} />
                                            <span className="node-label">{tr("表")}</span>
                                            <span className="tree-count">{tableList.length}</span>
                                          </div>
                                          {tablesOpen ? tableList.map((table) => renderTable(conn, schema, table, INDENT.tableLeaf)) : null}
                                          <div className="tree-node folder-node" style={{ paddingLeft: INDENT.folder }} onClick={() => setGroupOpen((prev) => ({ ...prev, [viewKey]: !viewsOpen }))}>
                                            <ChevronRight size={12} className={`conn-toggle ${viewsOpen ? 'open' : ''}`} />
                                            <Eye size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">{tr("视图")}</span>
                                            <span className="tree-count">{viewList.length}</span>
                                          </div>
                                          {viewsOpen ? viewList.map((table) => renderTable(conn, schema, table, INDENT.tableLeaf)) : null}
                                          <div className="tree-node obj-node" style={{ paddingLeft: INDENT.folderLeaf }} onClick={() => openTools('objects')}>
                                            <Code2 size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">{tr("函数 / 存储过程")}</span>
                                          </div>
                                          <div className="tree-node obj-node" style={{ paddingLeft: INDENT.folderLeaf }} onClick={() => openQuery(conn.id, undefined, undefined, schema.name)}>
                                            <TerminalSquare size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">{tr("查询")}</span>
                                          </div>
                                          <div className="tree-node obj-node" style={{ paddingLeft: INDENT.folderLeaf }} onClick={() => setSettingsOpen(true)}>
                                            <Archive size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">{tr("备份")}</span>
                                          </div>
                                        </>
                                      );
                                    })()}
                                  </>
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <div className="loading-inline" style={{ paddingLeft: INDENT.database, height: 26 }}>
                        <span className="spinner" style={{ width: 10, height: 10, margin: 0, borderWidth: 1.5 }} /> {t('loading')}
                      </div>
                    )
                  ) : null}
                </div>
              );
            })}
          </div>
          );
        })}
        {connections.length && !filtered.length ? <div className="muted" style={{ padding: 14, fontSize: 11.5 }}>{tr("没有匹配的连接或表")}</div> : null}
        </div>
      </div>
      <div className="sidebar-foot">
        <button className="btn" data-testid="sidebar-new-connection" style={{ flex: 1 }} onClick={() => openConnectionEditor('new')}>
          <Plus size={13} /> {t('newConnection')}
        </button>
        <button className="icon-btn" title={tr("关系图")} data-testid="open-relations" onClick={() => openRelations()} disabled={!activeConnectionId}>
          <Network size={14} />
        </button>
        <button className="icon-btn" title={tr("仪表板")} data-testid="open-dashboard" onClick={() => openDashboard()} disabled={!activeConnectionId}>
          <LayoutDashboard size={14} />
        </button>
        <button className="icon-btn" title={t('refresh')} onClick={() => void refreshAll()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <Suspense fallback={null}>
        {tableDialog ? (
          <TableOpsDialog
            kind={tableDialog.kind}
            connectionId={tableDialog.conn.id}
            database={tableDialog.schema.name}
            schema={tableDialog.table.schema}
            table={tableDialog.table.name}
            initialWithData={tableDialog.withData}
            onClose={() => setTableDialog(null)}
          />
        ) : null}
        {infoTable ? (
          <TableInfoDialog
            table={infoTable.table}
            database={infoTable.database}
            objectLabel={infoTable.objectLabel}
            relational={infoTable.relational ?? true}
            connectionId={infoTable.connectionId}
            manageIndexes={infoTable.manageIndexes}
            canAddField={infoTable.canAddField}
            engine={infoTable.engine}
            onClose={() => setInfoTable(null)}
          />
        ) : null}
        {dropDialog ? (
          <DropObjectDialog
            connection={dropDialog.conn}
            database={dropDialog.database}
            name={dropDialog.name}
            onClose={() => setDropDialog(null)}
          />
        ) : null}
        {objectDialog ? (
          <CreateObjectDialog
            connection={objectDialog.conn}
            database={objectDialog.database}
            onClose={() => setObjectDialog(null)}
          />
        ) : null}
        {dbDialog ? (
          <DatabaseOpsDialog
            kind={dbDialog.kind}
            connectionId={dbDialog.conn.id}
            database={dbDialog.database}
            onClose={() => setDbDialog(null)}
          />
        ) : null}
      </Suspense>
    </aside>
  );
}
