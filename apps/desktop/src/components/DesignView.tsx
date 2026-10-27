import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Code2,
  Database,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  Wand2,
  Wrench,
} from 'lucide-react';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '@aidb/core';
import { api } from '../lib/api';
import { useApp, type Tab } from '../store';

type DesignTab = Extract<Tab, { kind: 'design' }>;
type DesignerTab = 'fields' | 'indexes' | 'foreignKeys' | 'triggers' | 'options' | 'comments' | 'sql';

interface EditableColumn {
  id: string;
  name: string;
  base: string;
  length: string;
  decimals: string;
  unsigned: boolean;
  zerofill: boolean;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string;
  comment: string;
  generated?: 'virtual' | 'stored';
  originalName?: string;
  removed?: boolean;
}

interface EditableIndex {
  id: string;
  name: string;
  columns: string;
  unique: boolean;
  primary: boolean;
  method: string;
  comment: string;
  originalName?: string;
  removed?: boolean;
}

interface EditableFk {
  id: string;
  name: string;
  columns: string;
  refSchema: string;
  refTable: string;
  refColumns: string;
  onDelete: string;
  onUpdate: string;
  originalName?: string;
  removed?: boolean;
}

interface TriggerRow {
  name: string;
  timing: string;
  event: string;
  definition: string;
}

const TYPE_LISTS: Record<string, string[]> = {
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'DATETIME', 'DATE', 'TIME', 'TIMESTAMP'],
  mysql: [
    'bigint', 'int', 'mediumint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'double', 'bit',
    'varchar', 'char', 'tinytext', 'text', 'mediumtext', 'longtext', 'json', 'date', 'datetime', 'timestamp', 'time', 'year',
    'binary', 'varbinary', 'blob', 'enum', 'set',
  ],
  postgresql: [
    'bigint', 'integer', 'smallint', 'serial', 'bigserial', 'numeric', 'decimal', 'real', 'double precision', 'boolean',
    'character varying', 'character', 'text', 'json', 'jsonb', 'uuid', 'date', 'timestamp', 'timestamptz', 'time', 'bytea', 'interval',
  ],
  generic: ['INTEGER', 'TEXT', 'VARCHAR', 'DECIMAL', 'BOOLEAN', 'TIMESTAMP', 'DATE', 'BLOB', 'JSON'],
};

const FK_ACTIONS = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];
const INDEX_METHODS = ['BTREE', 'HASH', 'FULLTEXT', 'RTREE'];

const TABS: Array<{ id: DesignerTab; label: string }> = [
  { id: 'fields', label: '字段' },
  { id: 'indexes', label: '索引' },
  { id: 'foreignKeys', label: '外键' },
  { id: 'triggers', label: '触发器' },
  { id: 'options', label: '选项' },
  { id: 'comments', label: '注释' },
  { id: 'sql', label: 'SQL 预览' },
];

let rowSeq = 0;
const nextId = () => `r_${Date.now().toString(36)}_${rowSeq++}`;

function typeListFor(engine: string): string[] {
  if (engine === 'mysql' || engine === 'mariadb') return TYPE_LISTS.mysql;
  if (engine === 'postgresql' || engine === 'cockroachdb') return TYPE_LISTS.postgresql;
  if (engine === 'sqlite') return TYPE_LISTS.sqlite;
  return TYPE_LISTS.generic;
}

/** 把 `decimal(12,2) unsigned zerofill` 拆成网格可编辑的四段；enum/set 的括号内容整体留在类型名里。 */
function splitType(raw: string) {
  let text = (raw || '').trim();
  const unsigned = /\bunsigned\b/i.test(text);
  const zerofill = /\bzerofill\b/i.test(text);
  text = text
    .replace(/\b(unsigned|zerofill)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const open = text.indexOf('(');
  if (open > 0 && text.endsWith(')')) {
    const base = text.slice(0, open).trim();
    const inner = text.slice(open + 1, -1).trim();
    if (!/['"]/.test(inner)) {
      const [length = '', decimals = ''] = inner.split(',').map((part) => part.trim());
      return { base, length, decimals, unsigned, zerofill };
    }
    return { base: `${base}(${inner})`, length: '', decimals: '', unsigned, zerofill };
  }
  return { base: text, length: '', decimals: '', unsigned, zerofill };
}

function composeType(col: Pick<EditableColumn, 'base' | 'length' | 'decimals' | 'unsigned' | 'zerofill'>): string {
  const args = col.decimals ? `${col.length},${col.decimals}` : col.length;
  return `${col.base}${args ? `(${args})` : ''}${col.unsigned ? ' unsigned' : ''}${col.zerofill ? ' zerofill' : ''}`.trim();
}

function toColumn(col: ColumnInfo): EditableColumn {
  return {
    id: nextId(),
    name: col.name,
    ...splitType(col.type),
    nullable: col.nullable,
    primaryKey: col.primaryKey,
    autoIncrement: Boolean(col.autoIncrement),
    defaultValue: col.defaultValue ?? '',
    comment: col.comment ?? '',
    generated: col.generated,
    originalName: col.name,
  };
}

function toIndex(idx: IndexInfo): EditableIndex {
  return {
    id: nextId(),
    name: idx.name,
    columns: idx.columns.join(', '),
    unique: idx.unique,
    primary: Boolean(idx.primary),
    method: idx.method ?? '',
    comment: idx.comment ?? '',
    originalName: idx.name,
  };
}

function toFk(fk: ForeignKeyInfo): EditableFk {
  return {
    id: nextId(),
    name: fk.name ?? '',
    columns: fk.columns.join(', '),
    refSchema: fk.refSchema ?? '',
    refTable: fk.refTable,
    refColumns: fk.refColumns.join(', '),
    onDelete: fk.onDelete ?? '',
    onUpdate: fk.onUpdate ?? '',
    originalName: fk.name,
  };
}

const toList = (value: string) => value.split(',').map((part) => part.trim()).filter(Boolean);

function blankColumn(engine: string): EditableColumn {
  return {
    id: nextId(),
    name: '',
    base: engine === 'postgresql' || engine === 'cockroachdb' ? 'text' : 'TEXT',
    length: '',
    decimals: '',
    unsigned: false,
    zerofill: false,
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    defaultValue: '',
    comment: '',
  };
}

function defaultColumns(engine: string): EditableColumn[] {
  const serial = engine === 'postgresql' || engine === 'cockroachdb';
  return [
    { ...blankColumn(engine), name: 'id', base: serial ? 'bigserial' : 'INTEGER', nullable: false, primaryKey: true, autoIncrement: !serial },
    { ...blankColumn(engine), name: 'name', base: serial ? 'text' : 'TEXT', nullable: false },
    {
      ...blankColumn(engine),
      name: 'created_at',
      base: engine === 'mysql' || engine === 'mariadb' ? 'datetime' : serial ? 'timestamp' : 'TEXT',
      defaultValue: 'CURRENT_TIMESTAMP',
    },
  ];
}

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  testId?: string;
}) {
  return (
    <button className={`designer-btn ${primary ? 'primary' : ''}`} onClick={onClick} disabled={disabled} data-testid={testId}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function DesignView({ tab }: { tab: DesignTab }) {
  const t = useApp((s) => s.t);
  const connections = useApp((s) => s.connections);
  const schemas = useApp((s) => s.schemas[tab.connectionId]);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const closeTab = useApp((s) => s.closeTab);
  const openData = useApp((s) => s.openData);
  const openQuery = useApp((s) => s.openQuery);

  const conn = connections.find((c) => c.id === tab.connectionId);
  const engine = conn?.engine ?? 'sqlite';
  const tableInfo: TableInfo | undefined = (schemas ?? []).flatMap((s) => s.tables).find((tbl) => tbl.name === tab.table);

  const [designerTab, setDesignerTab] = useState<DesignerTab>('fields');
  const [tableName, setTableName] = useState(tab.table ?? '');
  const [tableComment, setTableComment] = useState('');
  const [originalComment, setOriginalComment] = useState('');
  const [columns, setColumns] = useState<EditableColumn[]>(() => (tab.table ? [] : defaultColumns(engine)));
  const [indexes, setIndexes] = useState<EditableIndex[]>([]);
  const [foreignKeys, setForeignKeys] = useState<EditableFk[]>([]);
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [options, setOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [optionsNote, setOptionsNote] = useState('');
  const [selColumn, setSelColumn] = useState(0);
  const [selIndex, setSelIndex] = useState(0);
  const [selFk, setSelFk] = useState(0);
  const [selTrigger, setSelTrigger] = useState(0);
  const [statements, setStatements] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const initializedFor = useRef<string>('');
  const loadedAux = useRef<Record<string, boolean>>({});

  useEffect(() => {
    if (!tab.table) {
      if (initializedFor.current !== `new:${tab.id}`) {
        initializedFor.current = `new:${tab.id}`;
        setTableName('');
        setColumns(defaultColumns(engine));
        setIndexes([]);
        setForeignKeys([]);
        setTableComment('');
        setOriginalComment('');
      }
      return;
    }
    if (!tableInfo) {
      if (!schemas) void loadSchema(tab.connectionId);
      return;
    }
    if (initializedFor.current === `table:${tab.table}`) return;
    initializedFor.current = `table:${tab.table}`;
    setTableName(tableInfo.name);
    setColumns((tableInfo.columns ?? []).map(toColumn));
    setIndexes((tableInfo.indexes ?? []).map(toIndex));
    setForeignKeys((tableInfo.foreignKeys ?? []).map(toFk));
    setTableComment(tableInfo.comment ?? '');
    setOriginalComment(tableInfo.comment ?? '');
    setSelColumn(0);
    setSelIndex(0);
    setSelFk(0);
    loadedAux.current = {};
  }, [tab.table, tab.connectionId, tab.id, tableInfo, schemas, engine, loadSchema]);

  const activeColumns = useMemo(() => columns.filter((c) => !c.removed && c.name.trim()), [columns]);
  const activeIndexes = useMemo(() => indexes.filter((i) => !i.removed && i.name.trim() && toList(i.columns).length), [indexes]);
  const activeFks = useMemo(() => foreignKeys.filter((f) => !f.removed && f.refTable.trim() && toList(f.columns).length), [foreignKeys]);
  const selectedColumn = columns[selColumn];
  const selectedIndex = indexes[selIndex];
  const selectedFk = foreignKeys[selFk];
  const selectedTrigger = triggers[selTrigger];
  const isView = tableInfo?.type === 'view';

  const auxKey = (which: string) => `${which}:${tab.connectionId}:${tab.database ?? ''}:${tableName}`;

  const loadAux = async (which: 'triggers' | 'options') => {
    if (!tab.table) {
      if (which === 'options') setOptionsNote('新建表还没有表级选项');
      return;
    }
    const key = auxKey(which);
    if (loadedAux.current[key]) return;
    loadedAux.current[key] = true;
    try {
      if (which === 'triggers') {
        const { objects } = await api.objects(tab.connectionId, tab.database);
        const rows: TriggerRow[] = (objects?.triggers ?? [])
          .filter((item: any) => !item.table || String(item.table).toLowerCase() === tab.table?.toLowerCase())
          .map((item: any) => {
            const detail = String(item.detail ?? '');
            const head = detail.split(/\s+/)[0] ?? '';
            return {
              name: String(item.name ?? ''),
              timing: /^(before|after)$/i.test(head) ? head.toUpperCase() : '',
              event: (detail.match(/insert|update|delete/i)?.[0] ?? '').toUpperCase(),
              definition: String(item.definition ?? ''),
            };
          });
        setTriggers(rows);
        setSelTrigger(0);
      } else {
        const result = await api.tableOptions(tab.connectionId, tableName, tab.database);
        setOptions(result.options ?? []);
        setOptionsNote(result.supported ? '' : result.note ?? '该引擎暂不提供表级选项读取');
      }
    } catch (err: any) {
      delete loadedAux.current[key];
      setError(err?.message ?? '读取失败');
    }
  };

  const buildOperations = (): Record<string, unknown>[] => {
    const ops: Record<string, unknown>[] = [];
    for (const fk of foreignKeys) if (fk.removed && fk.originalName) ops.push({ op: 'drop_foreign_key', name: fk.originalName });
    for (const idx of indexes) if (idx.removed && idx.originalName) ops.push({ op: 'drop_index', name: idx.originalName });
    for (const col of columns) if (col.removed && col.originalName) ops.push({ op: 'drop_column', name: col.originalName });
    for (const col of columns) {
      if (col.removed || !col.name.trim()) continue;
      const type = composeType(col);
      if (!col.originalName) {
        ops.push({
          op: 'add_column',
          column: {
            name: col.name,
            type,
            nullable: col.nullable,
            defaultValue: col.defaultValue || null,
            primaryKey: col.primaryKey,
            autoIncrement: col.autoIncrement,
            comment: col.comment || undefined,
          },
        });
        continue;
      }
      const before = tableInfo?.columns?.find((c) => c.name === col.originalName);
      if (!before) continue;
      if (col.name !== col.originalName) ops.push({ op: 'rename_column', from: col.originalName, to: col.name });
      const changed =
        before.type.toLowerCase() !== type.toLowerCase() ||
        before.nullable !== col.nullable ||
        (before.defaultValue ?? '') !== col.defaultValue ||
        (before.comment ?? '') !== col.comment;
      if (changed) {
        ops.push({ op: 'alter_column', name: col.name, type, nullable: col.nullable, defaultValue: col.defaultValue || null, comment: col.comment || undefined });
      }
    }
    for (const idx of activeIndexes) {
      if (idx.originalName) continue;
      ops.push({ op: 'add_index', index: { name: idx.name || undefined, columns: toList(idx.columns), unique: idx.unique, method: idx.method || undefined } });
    }
    for (const fk of activeFks) {
      if (fk.originalName) continue;
      ops.push({
        op: 'add_foreign_key',
        fk: {
          name: fk.name || undefined,
          columns: toList(fk.columns),
          refTable: fk.refTable,
          refColumns: toList(fk.refColumns),
          refSchema: fk.refSchema || undefined,
          onDelete: fk.onDelete || undefined,
          onUpdate: fk.onUpdate || undefined,
        },
      });
    }
    if (tableComment !== originalComment) ops.push({ op: 'set_comment', comment: tableComment });
    return ops;
  };

  async function buildPreview(): Promise<string[] | null> {
    setError(null);
    const target = (tableName || tab.table || '').trim();
    if (!target) {
      setError('请填写表名');
      return null;
    }
    if (!activeColumns.length) {
      setError('至少需要一列');
      return null;
    }
    try {
      if (!tab.table) {
        const { statements: result } = await api.ddlPreview({
          connectionId: tab.connectionId,
          database: tab.database,
          table: target,
          columns: activeColumns.map((col) => ({
            name: col.name,
            type: composeType(col),
            nullable: col.nullable,
            defaultValue: col.defaultValue || undefined,
            primaryKey: col.primaryKey,
            autoIncrement: col.autoIncrement,
            comment: col.comment || undefined,
          })),
          indexes: activeIndexes.map((idx) => ({ name: idx.name || undefined, columns: toList(idx.columns), unique: idx.unique, method: idx.method || undefined })),
          foreignKeys: activeFks.map((fk) => ({
            name: fk.name || undefined,
            columns: toList(fk.columns),
            refTable: fk.refTable,
            refColumns: toList(fk.refColumns),
            refSchema: fk.refSchema || undefined,
            onDelete: fk.onDelete || undefined,
            onUpdate: fk.onUpdate || undefined,
          })),
          comment: tableComment || undefined,
        });
        setStatements(result);
        return result;
      }
      const operations = buildOperations();
      if (!operations.length) {
        setStatements([]);
        return [];
      }
      const { statements: result } = await api.ddlPreview({
        connectionId: tab.connectionId,
        mode: 'alter',
        table: tab.table,
        schema: tableInfo?.schema ?? tab.database,
        operations,
      });
      setStatements(result);
      return result;
    } catch (err: any) {
      setError(err?.message ?? '生成 DDL 失败');
      return null;
    }
  }

  const switchTab = (next: DesignerTab) => {
    setDesignerTab(next);
    if (next === 'triggers') void loadAux('triggers');
    if (next === 'options') void loadAux('options');
    if (next === 'sql') void buildPreview();
  };

  const apply = async () => {
    setBusy(true);
    try {
      const preview = await buildPreview();
      if (!preview) return;
      if (!preview.length) {
        notify('info', '保存', '没有需要执行的变更');
        return;
      }
      if (preview.some((sql) => /\b(drop|alter)\b/i.test(sql)) && !window.confirm('即将执行包含 DROP / ALTER 的结构变更，是否继续？')) return;
      await api.ddlExecute({ connectionId: tab.connectionId, database: tab.database, statements: preview });
      notify('success', tab.table ? '表结构已更新' : `表 ${tableName} 已创建`);
      await loadSchema(tab.connectionId, true, tab.database);
      if (!tab.table) openData(tab.connectionId, tableName.trim(), tab.database);
      closeTab(tab.id);
    } catch (err: any) {
      setError(err?.message ?? '执行失败');
      notify('error', t('error'), err?.message);
    } finally {
      setBusy(false);
    }
  };

  const patchColumn = (id: string, patch: Partial<EditableColumn>) => setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addColumn = (at?: number) => {
    setColumns((prev) => {
      const next = [...prev];
      next.splice(at === undefined ? next.length : at + 1, 0, blankColumn(engine));
      setSelColumn(at === undefined ? next.length - 1 : at + 1);
      return next;
    });
    setDesignerTab('fields');
  };

  const removeColumn = (id: string) => {
    setColumns((prev) => {
      const target = prev.find((c) => c.id === id);
      const next = target?.originalName ? prev.map((c) => (c.id === id ? { ...c, removed: true } : c)) : prev.filter((c) => c.id !== id);
      setSelColumn((index) => Math.max(0, Math.min(index, next.length - 1)));
      return next;
    });
  };

  const moveColumn = (offset: -1 | 1) => {
    const target = selColumn + offset;
    if (target < 0 || target >= columns.length) return;
    setColumns((prev) => {
      const next = [...prev];
      [next[selColumn], next[target]] = [next[target], next[selColumn]];
      return next;
    });
    setSelColumn(target);
  };

  const togglePrimaryKey = () => {
    if (!selectedColumn) return;
    if (selectedColumn.originalName) {
      notify('info', '主键', '已有列的主键需要重建表才能调整');
      return;
    }
    const turnOn = !selectedColumn.primaryKey;
    setColumns((prev) => prev.map((c, i) => (i === selColumn ? { ...c, primaryKey: turnOn } : turnOn ? { ...c, primaryKey: false } : c)));
  };

  const addIndex = () => {
    setIndexes((prev) => {
      const next = [...prev, { id: nextId(), name: '', columns: selectedColumn?.name ?? '', unique: false, primary: false, method: 'BTREE', comment: '' }];
      setSelIndex(next.length - 1);
      return next;
    });
  };

  const removeIndex = () => {
    if (!selectedIndex) return;
    setIndexes((prev) => {
      const next = selectedIndex.originalName ? prev.map((i) => (i.id === selectedIndex.id ? { ...i, removed: true } : i)) : prev.filter((i) => i.id !== selectedIndex.id);
      setSelIndex((index) => Math.max(0, Math.min(index, next.length - 1)));
      return next;
    });
  };

  const addFk = () => {
    setForeignKeys((prev) => {
      const next = [
        ...prev,
        {
          id: nextId(),
          name: '',
          columns: selectedColumn?.name ?? '',
          refSchema: tab.database ?? '',
          refTable: '',
          refColumns: 'id',
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
      ];
      setSelFk(next.length - 1);
      return next;
    });
  };

  const removeFk = () => {
    if (!selectedFk) return;
    setForeignKeys((prev) => {
      const next = selectedFk.originalName ? prev.map((f) => (f.id === selectedFk.id ? { ...f, removed: true } : f)) : prev.filter((f) => f.id !== selectedFk.id);
      setSelFk((index) => Math.max(0, Math.min(index, next.length - 1)));
      return next;
    });
  };

  const dirty = useMemo(
    () => (tab.table ? buildOperations().length > 0 : activeColumns.some((col) => col.name.trim())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, indexes, foreignKeys, tableComment, originalComment, activeColumns, tab.table],
  );

  const saveButton = <ToolButton icon={<Database size={14} />} label="保存" onClick={() => void apply()} disabled={busy || isView} primary testId="design-apply" />;

  const toolbar = () => {
    if (designerTab === 'fields') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Plus size={14} />} label="添加字段" onClick={() => addColumn()} testId="design-add-column" />
          <ToolButton icon={<Plus size={14} />} label="插入字段" onClick={() => addColumn(selColumn)} disabled={!selectedColumn} />
          <ToolButton icon={<Trash2 size={14} />} label="删除字段" onClick={() => removeColumn(selectedColumn!.id)} disabled={!selectedColumn} />
          <span className="designer-sep" />
          <ToolButton icon={<KeyRound size={14} />} label="主键" onClick={togglePrimaryKey} disabled={!selectedColumn} />
          <span className="designer-sep" />
          <ToolButton icon={<ArrowUp size={14} />} label="上移" onClick={() => moveColumn(-1)} disabled={selColumn <= 0} />
          <ToolButton icon={<ArrowDown size={14} />} label="下移" onClick={() => moveColumn(1)} disabled={selColumn >= columns.length - 1} />
        </>
      );
    }
    if (designerTab === 'indexes') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Plus size={14} />} label="添加索引" onClick={addIndex} />
          <ToolButton icon={<Trash2 size={14} />} label="删除索引" onClick={removeIndex} disabled={!selectedIndex || selectedIndex.primary} />
        </>
      );
    }
    if (designerTab === 'foreignKeys') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Plus size={14} />} label="添加外键" onClick={addFk} />
          <ToolButton icon={<Trash2 size={14} />} label="删除外键" onClick={removeFk} disabled={!selectedFk} />
        </>
      );
    }
    if (designerTab === 'triggers') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Wand2 size={14} />} label="在查询窗口编写触发器" onClick={() => openQuery(tab.connectionId, 'CREATE TRIGGER ')} />
          <ToolButton
            icon={<RefreshCw size={14} />}
            label="刷新"
            onClick={() => {
              delete loadedAux.current[auxKey('triggers')];
              void loadAux('triggers');
            }}
          />
        </>
      );
    }
    if (designerTab === 'options') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton
            icon={<RefreshCw size={14} />}
            label="刷新"
            onClick={() => {
              delete loadedAux.current[auxKey('options')];
              void loadAux('options');
            }}
          />
        </>
      );
    }
    if (designerTab === 'sql') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<RefreshCw size={14} />} label="刷新预览" onClick={() => void buildPreview()} testId="design-preview" />
        </>
      );
    }
    return saveButton;
  };

  const detailPanel = () => {
    if (designerTab === 'fields' && selectedColumn) {
      return (
        <div className="designer-detail">
          <div className="designer-detail-title">{selectedColumn.name || '(新字段)'}</div>
          <div className="designer-detail-body">
            <label className="designer-form-row">
              <span>默认:</span>
              <input className="input" value={selectedColumn.defaultValue} placeholder="（无）" onChange={(e) => patchColumn(selectedColumn.id, { defaultValue: e.target.value })} />
            </label>
            <label className="designer-check">
              <input
                type="checkbox"
                checked={selectedColumn.autoIncrement}
                disabled={Boolean(selectedColumn.originalName)}
                onChange={(e) => patchColumn(selectedColumn.id, { autoIncrement: e.target.checked })}
              />
              自动递增
            </label>
            <label className="designer-check">
              <input type="checkbox" checked={selectedColumn.unsigned} onChange={(e) => patchColumn(selectedColumn.id, { unsigned: e.target.checked })} />
              无符号
            </label>
            <label className="designer-check">
              <input type="checkbox" checked={selectedColumn.zerofill} onChange={(e) => patchColumn(selectedColumn.id, { zerofill: e.target.checked })} />
              填充零
            </label>
            <span className="designer-summary">
              完整类型 <code>{composeType(selectedColumn) || '—'}</code>
            </span>
          </div>
        </div>
      );
    }
    if (designerTab === 'indexes' && selectedIndex) {
      const kind = selectedIndex.method === 'FULLTEXT' ? 'FULLTEXT ' : selectedIndex.unique ? 'UNIQUE ' : '';
      return (
        <div className="designer-detail">
          <div className="designer-detail-title">{selectedIndex.name || '(自动命名)'}</div>
          <div className="designer-detail-body">
            <pre className="ddl-box inline">
              {`CREATE ${kind}INDEX ${selectedIndex.name || '(自动命名)'} ON ${tableName} (${toList(selectedIndex.columns).join(', ') || '...'})${
                selectedIndex.method && selectedIndex.method !== 'FULLTEXT' ? ` USING ${selectedIndex.method}` : ''
              }`}
            </pre>
          </div>
        </div>
      );
    }
    if (designerTab === 'foreignKeys' && selectedFk) {
      return (
        <div className="designer-detail">
          <div className="designer-detail-title">{selectedFk.name || '(自动命名)'}</div>
          <div className="designer-detail-body">
            <pre className="ddl-box inline">
              {`CONSTRAINT ${selectedFk.name || '(自动命名)'} FOREIGN KEY (${toList(selectedFk.columns).join(', ') || '...'}) REFERENCES ${
                [selectedFk.refSchema, selectedFk.refTable].filter(Boolean).join('.') || '(未选择)'
              } (${toList(selectedFk.refColumns).join(', ') || '...'})${selectedFk.onDelete ? ` ON DELETE ${selectedFk.onDelete}` : ''}${
                selectedFk.onUpdate ? ` ON UPDATE ${selectedFk.onUpdate}` : ''
              }`}
            </pre>
          </div>
        </div>
      );
    }
    if (designerTab === 'triggers' && selectedTrigger?.definition) {
      return (
        <div className="designer-detail">
          <div className="designer-detail-title">{selectedTrigger.name}</div>
          <div className="designer-detail-body">
            <pre className="ddl-box inline">{selectedTrigger.definition}</pre>
          </div>
        </div>
      );
    }
    return null;
  };

  const statusText = () => {
    const parts = [`字段数: ${activeColumns.length}`];
    if (designerTab === 'indexes' || designerTab === 'sql' || designerTab === 'comments') parts.push(`索引数: ${activeIndexes.length}`);
    if (designerTab === 'foreignKeys' || designerTab === 'sql') parts.push(`外键数: ${activeFks.length}`);
    if (designerTab === 'triggers') parts.push(`触发器数: ${triggers.length}`);
    return parts;
  };

  return (
    <div className="view designer">
      <div className="designer-toolbar">
        {toolbar()}
        <div className="spacer" />
        {isView ? <span className="designer-hint">视图不可编辑结构</span> : null}
        <label className="designer-tabname">
          <span>{t('name')}</span>
          <input
            className="input"
            style={{ width: 210 }}
            value={tableName}
            placeholder="表名"
            disabled={Boolean(tab.table)}
            onChange={(e) => setTableName(e.target.value)}
            data-testid="design-table-name"
          />
        </label>
        <button className="btn small" onClick={() => void buildPreview()}>
          <Code2 size={12} /> {t('preview')}
        </button>
      </div>

      <div className="designer-tabs">
        {TABS.map((item) => (
          <button key={item.id} className={designerTab === item.id ? 'active' : ''} onClick={() => switchTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      {error ? <div className="risk-banner designer-error">{error}</div> : null}

      <div className="designer-grid-wrap">
        {designerTab === 'fields' ? (
          <table className="designer-grid">
            <thead>
              <tr>
                <th className="col-mark" style={{ width: 26 }} />
                <th style={{ minWidth: 150 }}>{t('name')}</th>
                <th style={{ minWidth: 130 }}>{t('type')}</th>
                <th style={{ width: 78 }}>长度</th>
                <th style={{ width: 78 }}>小数点</th>
                <th style={{ width: 84 }}>不是 null</th>
                <th style={{ width: 62 }}>虚拟</th>
                <th style={{ width: 62 }}>键</th>
                <th style={{ minWidth: 160 }}>注释</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((col, index) => (
                <tr key={col.id} className={`${selColumn === index ? 'selected' : ''} ${col.removed ? 'removed' : ''}`} onClick={() => setSelColumn(index)}>
                  <td className="col-mark">{selColumn === index ? <ChevronRight size={12} className="open" /> : null}</td>
                  <td>
                    <input value={col.name} disabled={Boolean(col.originalName)} placeholder="column" onChange={(e) => patchColumn(col.id, { name: e.target.value })} />
                  </td>
                  <td>
                    <input list="designer-types" value={col.base} onChange={(e) => patchColumn(col.id, { base: e.target.value })} />
                  </td>
                  <td>
                    <input value={col.length} disabled={Boolean(col.generated)} onChange={(e) => patchColumn(col.id, { length: e.target.value.replace(/[^\d]/g, '') })} />
                  </td>
                  <td>
                    <input
                      value={col.decimals}
                      disabled={Boolean(col.generated) || !col.length}
                      onChange={(e) => patchColumn(col.id, { decimals: e.target.value.replace(/[^\d]/g, '') })}
                    />
                  </td>
                  <td className="cell-center">
                    <input type="checkbox" checked={!col.nullable} disabled={col.primaryKey} onChange={(e) => patchColumn(col.id, { nullable: !e.target.checked })} />
                  </td>
                  <td className="cell-center">
                    <input
                      type="checkbox"
                      checked={col.generated === 'virtual' || col.generated === 'stored'}
                      disabled
                      title={col.generated ? `生成列（${col.generated}）` : '生成列请通过 SQL 维护'}
                    />
                  </td>
                  <td className="cell-center">
                    {col.primaryKey ? (
                      <span className="designer-key">
                        <KeyRound size={12} />
                        {columns.filter((c, i) => c.primaryKey && i <= index).length}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <input value={col.comment} onChange={(e) => patchColumn(col.id, { comment: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {designerTab === 'indexes' ? (
          <table className="designer-grid">
            <thead>
              <tr>
                <th className="col-mark" style={{ width: 26 }} />
                <th style={{ minWidth: 190 }}>{t('name')}</th>
                <th style={{ minWidth: 200 }}>字段</th>
                <th style={{ width: 130 }}>索引类型</th>
                <th style={{ width: 130 }}>索引方法</th>
                <th style={{ minWidth: 160 }}>注释</th>
              </tr>
            </thead>
            <tbody>
              {indexes.map((idx, index) => (
                <tr key={idx.id} className={`${selIndex === index ? 'selected' : ''} ${idx.removed ? 'removed' : ''}`} onClick={() => setSelIndex(index)}>
                  <td className="col-mark">{selIndex === index ? <ChevronRight size={12} className="open" /> : null}</td>
                  <td>
                    <input
                      value={idx.name}
                      disabled={idx.primary}
                      placeholder="自动命名"
                      onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, name: e.target.value } : i)))}
                    />
                  </td>
                  <td>
                    <input value={idx.columns} disabled={idx.primary} onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, columns: e.target.value } : i)))} />
                  </td>
                  <td>
                    <select
                      value={idx.primary ? 'PRIMARY' : idx.unique ? 'UNIQUE' : idx.method === 'FULLTEXT' ? 'FULLTEXT' : 'NORMAL'}
                      disabled={idx.primary}
                      onChange={(e) => {
                        const value = e.target.value;
                        setIndexes((prev) =>
                          prev.map((i) =>
                            i.id === idx.id
                              ? {
                                  ...i,
                                  unique: value === 'UNIQUE',
                                  method: value === 'FULLTEXT' ? 'FULLTEXT' : i.method === 'FULLTEXT' ? 'BTREE' : i.method,
                                }
                              : i,
                          ),
                        );
                      }}
                    >
                      <option value="NORMAL">NORMAL</option>
                      <option value="UNIQUE">UNIQUE</option>
                      <option value="PRIMARY">PRIMARY</option>
                      <option value="FULLTEXT">FULLTEXT</option>
                    </select>
                  </td>
                  <td>
                    <select value={idx.method} disabled={idx.primary} onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, method: e.target.value } : i)))}>
                      <option value="">（默认）</option>
                      {INDEX_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {method}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={idx.comment} disabled={idx.primary} onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, comment: e.target.value } : i)))} />
                  </td>
                </tr>
              ))}
              {!indexes.length ? (
                <tr>
                  <td className="designer-empty" colSpan={6}>
                    该表没有索引。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {designerTab === 'foreignKeys' ? (
          <table className="designer-grid fks-grid">
            <thead>
              <tr>
                <th className="col-mark" style={{ width: 26 }} />
                <th style={{ minWidth: 170 }}>{t('name')}</th>
                <th style={{ minWidth: 130 }}>字段</th>
                <th style={{ minWidth: 110 }}>被引用的模式</th>
                <th style={{ minWidth: 150 }}>被引用的表（父）</th>
                <th style={{ minWidth: 120 }}>被引用的字段</th>
                <th style={{ minWidth: 120 }}>删除时</th>
                <th style={{ minWidth: 120 }}>更新时</th>
              </tr>
            </thead>
            <tbody>
              {foreignKeys.map((fk, index) => (
                <tr key={fk.id} className={`${selFk === index ? 'selected' : ''} ${fk.removed ? 'removed' : ''}`} onClick={() => setSelFk(index)}>
                  <td className="col-mark">{selFk === index ? <ChevronRight size={12} className="open" /> : null}</td>
                  <td>
                    <input value={fk.name} placeholder="自动命名" onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, name: e.target.value } : f)))} />
                  </td>
                  <td>
                    <input value={fk.columns} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, columns: e.target.value } : f)))} />
                  </td>
                  <td>
                    <input value={fk.refSchema} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, refSchema: e.target.value } : f)))} />
                  </td>
                  <td>
                    <input value={fk.refTable} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, refTable: e.target.value } : f)))} />
                  </td>
                  <td>
                    <input value={fk.refColumns} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, refColumns: e.target.value } : f)))} />
                  </td>
                  <td>
                    <select value={fk.onDelete} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, onDelete: e.target.value } : f)))}>
                      <option value="">（默认）</option>
                      {FK_ACTIONS.map((action) => (
                        <option key={action} value={action}>
                          {action}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={fk.onUpdate} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, onUpdate: e.target.value } : f)))}>
                      <option value="">（默认）</option>
                      {FK_ACTIONS.map((action) => (
                        <option key={action} value={action}>
                          {action}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {!foreignKeys.length ? (
                <tr>
                  <td className="designer-empty" colSpan={8}>
                    该表没有外键。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {designerTab === 'triggers' ? (
          <table className="designer-grid">
            <thead>
              <tr>
                <th className="col-mark" style={{ width: 26 }} />
                <th style={{ minWidth: 200 }}>{t('name')}</th>
                <th style={{ width: 120 }}>触发</th>
                <th style={{ width: 80 }}>插入</th>
                <th style={{ width: 80 }}>更新</th>
                <th style={{ width: 80 }}>删除</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((item, index) => (
                <tr key={item.name} className={`${selTrigger === index ? 'selected' : ''}`} onClick={() => setSelTrigger(index)}>
                  <td className="col-mark">{selTrigger === index ? <ChevronRight size={12} className="open" /> : null}</td>
                  <td>
                    <input value={item.name} readOnly />
                  </td>
                  <td>
                    <input value={item.timing} readOnly />
                  </td>
                  <td className="cell-center">
                    <input type="checkbox" checked={/INSERT/.test(item.event)} readOnly />
                  </td>
                  <td className="cell-center">
                    <input type="checkbox" checked={/UPDATE/.test(item.event)} readOnly />
                  </td>
                  <td className="cell-center">
                    <input type="checkbox" checked={/DELETE/.test(item.event)} readOnly />
                  </td>
                </tr>
              ))}
              {!triggers.length ? (
                <tr>
                  <td className="designer-empty" colSpan={6}>
                    该表没有触发器。触发器的创建与删除请在查询窗口执行 SQL。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {designerTab === 'options' ? (
          <table className="designer-grid options-grid">
            <tbody>
              {options.map((item) => (
                <tr key={item.label}>
                  <td className="option-label">{item.label}:</td>
                  <td>
                    <input value={item.value} readOnly />
                  </td>
                </tr>
              ))}
              {!options.length ? (
                <tr>
                  <td className="designer-empty" colSpan={2}>
                    {optionsNote || '没有可读取的表选项。'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {designerTab === 'comments' ? (
          <div className="designer-comments">
            <label className="designer-form-row wide">
              <span>表注释:</span>
              <textarea className="input" rows={2} value={tableComment} onChange={(e) => setTableComment(e.target.value)} placeholder="为该表填写业务含义说明" />
            </label>
            <table className="designer-grid">
              <thead>
                <tr>
                  <th className="col-mark" style={{ width: 26 }} />
                  <th style={{ minWidth: 180 }}>{t('name')}</th>
                  <th style={{ minWidth: 320 }}>注释</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((col, index) =>
                  col.removed ? null : (
                    <tr key={col.id} className={selColumn === index ? 'selected' : ''} onClick={() => setSelColumn(index)}>
                      <td className="col-mark">{selColumn === index ? <ChevronRight size={12} className="open" /> : null}</td>
                      <td>
                        <input value={col.name} readOnly />
                      </td>
                      <td>
                        <input value={col.comment} onChange={(e) => patchColumn(col.id, { comment: e.target.value })} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ) : null}

        {designerTab === 'sql' ? (
          <div className="designer-sql">
            {statements.length ? (
              <pre className="ddl-box">{statements.join('\n\n')}</pre>
            ) : (
              <div className="designer-empty-inline">没有待执行的变更。修改字段、索引、外键或注释后，这里会生成 DDL。</div>
            )}
          </div>
        ) : null}
      </div>

      {detailPanel()}

      <datalist id="designer-types">
        {typeListFor(engine).map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>

      <div className="designer-status">
        {statusText().map((text) => (
          <span key={text}>{text}</span>
        ))}
        <div className="spacer" />
        <span className={dirty ? 'changed' : ''}>{dirty ? '有未保存的变更' : '无变更'}</span>
        <span>
          <Wrench size={11} /> {tab.table ? `设计 · ${tab.table}` : t('newTable')}
        </span>
      </div>
    </div>
  );
}
