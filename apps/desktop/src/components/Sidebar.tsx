import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Database,
  Eye,
  FileSearch,
  FolderOpen,
  MoreHorizontal,
  Network,
  Plus,
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
} from 'lucide-react';
import type { ConnectionConfig, DatabaseSchema, TableInfo } from '@aidb/core';
import { api } from '../lib/api';
import { useApp, type ContextMenuItem } from '../store';
import { TableOpsDialog, type TableDialogKind } from './TableOpsDialog';
import { DatabaseOpsDialog, type DatabaseDialogKind } from './DatabaseOpsDialog';
import { TableInfoDialog } from './TableInfoDialog';

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
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const t = useApp((s) => s.t);
  const toggleConnection = useApp((s) => s.toggleConnection);
  const selectConnection = useApp((s) => s.selectConnection);
  const toggleSchema = useApp((s) => s.toggleSchema);
  const openData = useApp((s) => s.openData);
  const openQuery = useApp((s) => s.openQuery);
  const openDesign = useApp((s) => s.openDesign);
  const openRelations = useApp((s) => s.openRelations);
  const openConnectionEditor = useApp((s) => s.openConnectionEditor);
  const deleteConnection = useApp((s) => s.deleteConnection);
  const loadSchema = useApp((s) => s.loadSchema);
  const prefillAgent = useApp((s) => s.prefillAgent);
  const notify = useApp((s) => s.notify);
  const refreshAll = useApp((s) => s.refreshAllSchemas);
  const openTools = useApp((s) => s.openTools);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const openContextMenu = useApp((s) => s.openContextMenu);

  const [query, setQuery] = useState('');
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [tableDialog, setTableDialog] = useState<{ kind: TableDialogKind; conn: ConnectionConfig; schema: DatabaseSchema; table: TableInfo; withData?: boolean } | null>(null);
  const [dbDialog, setDbDialog] = useState<{ kind: DatabaseDialogKind; conn: ConnectionConfig; database: string } | null>(null);
  const [infoTable, setInfoTable] = useState<{ table: TableInfo; database?: string } | null>(null);

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
    const map = new Map<string, ConnectionConfig[]>();
    for (const conn of filtered) {
      const key = conn.groupName || '默认';
      map.set(key, [...(map.get(key) ?? []), conn]);
    }
    return [...map.entries()];
  }, [filtered]);

  const openMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, items);
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
      notify('success', t('export'), `${file.rows} rows · ${file.path}`);
    } catch (err: any) {
      notify('error', t('error'), err?.message);
    }
  };

  const quickTableOp = async (kind: 'truncate' | 'empty' | 'drop', conn: ConnectionConfig, schema: DatabaseSchema, table: TableInfo) => {
    const isDrop = kind === 'drop';
    const isTruncate = kind === 'truncate';
    const label = table.type === 'view' ? '视图' : '表';
    const message = isDrop
      ? `删除${label}「${table.name}」？此操作不可恢复。`
      : isTruncate
        ? `截断表「${table.name}」并重置自增计数？此操作不可恢复。`
        : `清空表「${table.name}」中的全部数据？自增计数不会重置。`;
    if (!window.confirm(message)) return;
    try {
      await api.tableOps({ connectionId: conn.id, database: schema.name, table: table.name, op: kind });
      notify('success', isDrop ? `${label}已删除` : isTruncate ? '表已截断' : '表已清空', table.name);
      await loadSchema(conn.id, true);
    } catch (err: any) {
      notify('error', isDrop ? '删除失败' : '清空失败', err?.message);
    }
  };

  const renderTable = (conn: ConnectionConfig, schema: DatabaseSchema, table: TableInfo, padding: number) => {
    const q = query.trim().toLowerCase();
    if (q && !table.name.toLowerCase().includes(q)) return null;
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
                    onClick: () => openQuery(conn.id, `SELECT * FROM ${quoteName(table.name, conn.engine)} LIMIT 100;`),
                  },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: '查看 DDL', icon: <FileCode2 size={13} />, onClick: () => setTableDialog({ kind: 'ddl', conn, schema, table }) },
                  { label: '删除视图', icon: <Trash2 size={13} />, danger: true, onClick: () => void quickTableOp('drop', conn, schema, table) },
                  {
                    label: 'AI 解释此视图',
                    icon: <Sparkles size={13} />,
                    onClick: () => prefillAgent(`解释视图 ${table.name} 的字段、来源表与用途，并给出常用查询示例。`),
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
                    onClick: () => openQuery(conn.id, `SELECT * FROM ${quoteName(table.name, conn.engine)} LIMIT 100;`),
                  },
                  {
                    label: t('design'),
                    icon: <Wrench size={13} />,
                    onClick: () => openDesign(conn.id, table.name, schema.name),
                  },
                  { label: '新建表', icon: <Plus size={13} />, onClick: () => openDesign(conn.id, undefined, schema.name) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: '重命名表…', icon: <Pencil size={13} />, onClick: () => setTableDialog({ kind: 'rename', conn, schema, table }) },
                  { label: '复制表（结构 + 数据）…', icon: <Copy size={13} />, onClick: () => setTableDialog({ kind: 'duplicate', conn, schema, table, withData: true }) },
                  { label: '复制表（仅结构）…', icon: <Copy size={13} />, onClick: () => setTableDialog({ kind: 'duplicate', conn, schema, table, withData: false }) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: '查看 DDL', icon: <FileCode2 size={13} />, onClick: () => setTableDialog({ kind: 'ddl', conn, schema, table }) },
                  { label: '维护表…', icon: <Hammer size={13} />, onClick: () => setTableDialog({ kind: 'maintenance', conn, schema, table }) },
                  { label: '对象信息', icon: <Info size={13} />, onClick: () => setInfoTable({ table, database: schema.name }) },
                  { label: '设置权限…', icon: <KeyRound size={13} />, onClick: () => openTools('users') },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: '导入向导…', icon: <Upload size={13} />, onClick: () => openData(conn.id, table.name, schema.name) },
                  { label: '导出向导…', icon: <Download size={13} />, onClick: () => void exportTable(conn, table, schema.name) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: '清空表', icon: <Eraser size={13} />, danger: true, onClick: () => void quickTableOp('empty', conn, schema, table) },
                  { label: '截断表', icon: <Hammer size={13} />, danger: true, onClick: () => void quickTableOp('truncate', conn, schema, table) },
                  { label: '删除表', icon: <Trash2 size={13} />, danger: true, onClick: () => void quickTableOp('drop', conn, schema, table) },
                  { label: '', icon: null, sep: true, onClick: () => undefined },
                  { label: '逆向表到模型…', icon: <Network size={13} />, onClick: () => openRelations(conn.id, schema.name) },
                  { label: t('refresh'), icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, true) },
                  {
                    label: 'AI 解释此表',
                    icon: <Sparkles size={13} />,
                    onClick: () => prefillAgent(`解释表 ${table.name} 的结构、索引与用途，并给出常用查询示例。`),
                  },
                  {
                    label: 'AI 数据质量',
                    icon: <Sparkles size={13} />,
                    onClick: () => prefillAgent(`检查 ${table.name} 的空值、空串和重复主键，并给出排查 SQL。`),
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
        {table.rowEstimate !== undefined ? <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{table.rowEstimate}</span> : null}
        <span className="node-actions">
          <button
            className="icon-btn"
            title={t('newQuery')}
            onClick={(e) => {
              e.stopPropagation();
              openQuery(conn.id, `SELECT * FROM ${quoteName(table.name, conn.engine)} LIMIT 100;`);
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
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <span>{t('connections')}</span>
          <button className="icon-btn" title={t('newConnection')} onClick={() => openConnectionEditor('new')}>
            <Plus size={14} />
          </button>
        </div>
        <div className="search-box">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchConnections')} data-testid="sidebar-search" />
        </div>
      </div>
      <div className="sidebar-body">
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
        {grouped.map(([group, list]) => (
          <div key={group}>
            <div className="group-label">{group}</div>
            {list.map((conn) => {
              const isOpen = expanded[conn.id] || Boolean(query.trim());
              const connSchemas = schemas[conn.id];
              return (
                <div key={conn.id}>
                  <div
                    className={`conn-row ${activeConnectionId === conn.id ? 'active' : ''}`}
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
                        { label: '新建表', icon: <Plus size={13} />, onClick: () => openDesign(conn.id) },
                        { label: t('design'), icon: <Wrench size={13} />, onClick: () => openDesign(conn.id) },
                        { label: '关系图', icon: <Network size={13} />, onClick: () => openRelations(conn.id) },
                        { label: 'AI 数据库体检', icon: <Sparkles size={13} />, onClick: () => prefillAgent('对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。') },
                        { label: t('copy'), icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(conn.name) },
                        { label: '', icon: null, sep: true, onClick: () => undefined },
                        {
                          label: t('delete'),
                          icon: <Trash2 size={13} />,
                          danger: true,
                          onClick: () => {
                            if (window.confirm(`删除连接「${conn.name}」？仅移除配置，不会删除数据库。`)) void deleteConnection(conn.id);
                          },
                        },
                      ])
                    }
                    data-testid={`connection-${conn.id}`}
                  >
                    <ChevronRight size={13} className={`conn-toggle ${isOpen ? 'open' : ''}`} onClick={(e) => { e.stopPropagation(); toggleConnection(conn.id); }} />
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
                          { label: '新建表', icon: <Plus size={13} />, onClick: () => openDesign(conn.id) },
                          { label: t('design'), icon: <Wrench size={13} />, onClick: () => openDesign(conn.id) },
                          { label: '关系图', icon: <Network size={13} />, onClick: () => openRelations(conn.id) },
                          { label: 'AI 数据库体检', icon: <Sparkles size={13} />, onClick: () => prefillAgent('对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。') },
                          {
                            label: t('delete'),
                            icon: <Trash2 size={13} />,
                            danger: true,
                            onClick: () => {
                              if (window.confirm(`删除连接「${conn.name}」？`)) void deleteConnection(conn.id);
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
                              className="tree-node db-node"
                              style={{ paddingLeft: INDENT.database }}
                              onClick={() => {
                                const willOpen = !schemaOpen;
                                toggleSchema(schemaKey);
                                if (willOpen && !loaded && !loading) void loadSchema(conn.id, false, schema.name);
                              }}
                              onContextMenu={(e) =>
                                openMenu(e, [
                                  { label: '关闭数据库', icon: <FolderOpen size={13} />, onClick: () => toggleSchema(schemaKey) },
                                  { label: '编辑数据库…', icon: <Pencil size={13} />, onClick: () => setDbDialog({ kind: 'rename', conn, database: schema.name }) },
                                  { label: '新建数据库…', icon: <Plus size={13} />, onClick: () => setDbDialog({ kind: 'create', conn, database: '' }) },
                                  { label: '删除数据库…', icon: <Trash2 size={13} />, danger: true, onClick: () => setDbDialog({ kind: 'drop', conn, database: schema.name }) },
                                  { label: '', icon: null, sep: true, onClick: () => undefined },
                                  { label: '新建表', icon: <Table2 size={13} />, onClick: () => openDesign(conn.id, undefined, schema.name) },
                                  { label: '新建查询', icon: <TerminalSquare size={13} />, onClick: () => openQuery(conn.id) },
                                  { label: '命令列界面…', icon: <FileCode2 size={13} />, onClick: () => openQuery(conn.id) },
                                  { label: '运行 SQL 文件…', icon: <FileCode2 size={13} />, onClick: () => openQuery(conn.id) },
                                  { label: '转储 SQL 文件…', icon: <Archive size={13} />, onClick: () => setDbDialog({ kind: 'dump', conn, database: schema.name }) },
                                  { label: '', icon: null, sep: true, onClick: () => undefined },
                                  { label: '逆向数据库到模型…', icon: <Network size={13} />, onClick: () => openRelations(conn.id, schema.name) },
                                  { label: '在数据库中查找…', icon: <FileSearch size={13} />, onClick: () => openTools('search') },
                                  { label: '', icon: null, sep: true, onClick: () => undefined },
                                  {
                                    label: t('refresh'),
                                    icon: <RefreshCw size={13} />,
                                    onClick: () => void loadSchema(conn.id, true),
                                  },
                                  {
                                    label: '复制名称',
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
                                  <div className="muted" style={{ paddingLeft: INDENT.tableLeaf, fontSize: 11, lineHeight: '24px' }}>未加载表 · 点击库名重试</div>
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
                                      return (
                                        <>
                                          <div className="tree-node folder-node" style={{ paddingLeft: INDENT.folder }} onClick={() => setGroupOpen((prev) => ({ ...prev, [tableKey]: !tablesOpen }))}>
                                            <ChevronRight size={12} className={`conn-toggle ${tablesOpen ? 'open' : ''}`} />
                                            <Table2 size={13} style={{ color: 'var(--accent)' }} />
                                            <span className="node-label">表</span>
                                            <span className="tree-count">{tableList.length}</span>
                                          </div>
                                          {tablesOpen ? tableList.map((table) => renderTable(conn, schema, table, INDENT.tableLeaf)) : null}
                                          <div className="tree-node folder-node" style={{ paddingLeft: INDENT.folder }} onClick={() => setGroupOpen((prev) => ({ ...prev, [viewKey]: !viewsOpen }))}>
                                            <ChevronRight size={12} className={`conn-toggle ${viewsOpen ? 'open' : ''}`} />
                                            <Eye size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">视图</span>
                                            <span className="tree-count">{viewList.length}</span>
                                          </div>
                                          {viewsOpen ? viewList.map((table) => renderTable(conn, schema, table, INDENT.tableLeaf)) : null}
                                          <div className="tree-node obj-node" style={{ paddingLeft: INDENT.folderLeaf }} onClick={() => openTools('objects')}>
                                            <Code2 size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">函数 / 存储过程</span>
                                          </div>
                                          <div className="tree-node obj-node" style={{ paddingLeft: INDENT.folderLeaf }} onClick={() => openQuery(conn.id)}>
                                            <TerminalSquare size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">查询</span>
                                          </div>
                                          <div className="tree-node obj-node" style={{ paddingLeft: INDENT.folderLeaf }} onClick={() => setSettingsOpen(true)}>
                                            <Archive size={13} style={{ color: 'var(--text-muted)' }} />
                                            <span className="node-label">备份</span>
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
        ))}
        {connections.length && !filtered.length ? <div className="muted" style={{ padding: 14, fontSize: 11.5 }}>没有匹配的连接或表</div> : null}
      </div>
      <div className="sidebar-foot">
        <button className="btn" data-testid="sidebar-new-connection" style={{ flex: 1 }} onClick={() => openConnectionEditor('new')}>
          <Plus size={13} /> {t('newConnection')}
        </button>
        <button className="icon-btn" title="关系图" data-testid="open-relations" onClick={() => openRelations()} disabled={!activeConnectionId}>
          <Network size={14} />
        </button>
        <button className="icon-btn" title={t('refresh')} onClick={() => void refreshAll()}>
          <RefreshCw size={14} />
        </button>
      </div>
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
        <TableInfoDialog table={infoTable.table} database={infoTable.database} onClose={() => setInfoTable(null)} />
      ) : null}
      {dbDialog ? (
        <DatabaseOpsDialog
          kind={dbDialog.kind}
          connectionId={dbDialog.conn.id}
          database={dbDialog.database}
          onClose={() => setDbDialog(null)}
        />
      ) : null}
    </aside>
  );
}
