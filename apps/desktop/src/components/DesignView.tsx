import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Code2,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wand2,
  Wrench,
} from 'lucide-react';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '@aidb/core';
import { api } from '../lib/api';
import { tableSignature } from '../lib/schemaSignature';
import { useApp, type Tab } from '../store';
import { askConfirm } from './AskDialog';
import { Select, Option } from './ui';
import { t as tr } from '../i18n';

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
  { id: 'fields', label: tr("字段") },
  { id: 'indexes', label: tr("索引") },
  { id: 'foreignKeys', label: tr("外键") },
  { id: 'triggers', label: tr("触发器") },
  { id: 'options', label: tr("选项") },
  { id: 'comments', label: tr("注释") },
  { id: 'sql', label: tr("SQL 预览") },
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
    <button className={`designer-btn ${primary ? 'primary' : ''}`} onClick={onClick} disabled={disabled} title={label} data-testid={testId}>
      {icon}
      <span className="btn-text">{label}</span>
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
  // 必须按 tab 自己的库/模式取表：跨全部库取首个同名表时，MySQL 两库的同名 orders
  // 会取到另一张，接下来的"签名变了就静默重置"会用错结构覆盖编辑器内容，
  // apply() 还会对着错对象生成 DDL。
  const tableInfo: TableInfo | undefined = useMemo(() => {
    const all = schemas ?? [];
    if (!tab.database) return all.flatMap((item) => item.tables).find((tbl) => tbl.name === tab.table);
    // 有库名却只在别的库里找到同名表，宁可当作不存在，也不要拿错表覆盖编辑态。
    return all
      .filter((item) => item.name === tab.database)
      .flatMap((item) => item.tables)
      .find((tbl) => tbl.name === tab.table);
  }, [schemas, tab.database, tab.table]);

  const [designerTab, setDesignerTab] = useState<DesignerTab>('fields');
  const [tableName, setTableName] = useState(tab.table ?? '');
  const [tableComment, setTableComment] = useState('');
  const [originalComment, setOriginalComment] = useState('');
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [originalIndexes, setOriginalIndexes] = useState<EditableIndex[]>([]);
  const [originalForeignKeys, setOriginalForeignKeys] = useState<EditableFk[]>([]);
  const [pendingReload, setPendingReload] = useState(false);
  const [conflictSig, setConflictSig] = useState('');
  const baselineSig = useRef<string>('');
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

  // 把结构与基线一起落下。首次载入与"静默跟随外部变更"共用同一个函数，
  // 保证两处一致的基线，否则 dirty 会误判。
  const applyTableInfo = (info: TableInfo) => {
    setTableName(info.name);
    setColumns((info.columns ?? []).map(toColumn));
    setIndexes((info.indexes ?? []).map(toIndex));
    setForeignKeys((info.foreignKeys ?? []).map(toFk));
    setOriginalColumns((info.columns ?? []).map(toColumn));
    setOriginalIndexes((info.indexes ?? []).map(toIndex));
    setOriginalForeignKeys((info.foreignKeys ?? []).map(toFk));
    setTableComment(info.comment ?? '');
    setOriginalComment(info.comment ?? '');
    setSelColumn(0);
    setSelIndex(0);
    setSelFk(0);
    loadedAux.current = {};
  };

  // 编辑态是否偏离了基线。与下面那个 dirty（是否有待执行的 DDL 操作）语义不同：
  // 这个只关心"用户改没改过"，用于决定外部变更到来时能不能静默重置。
  const baselineDirty = useMemo(() => {
    if (!tab.table || !baselineSig.current) return false;
    const shape = (items: EditableColumn[]) =>
      items.map((column) => [
        column.name,
        composeType(column),
        String(column.nullable),
        column.defaultValue,
        column.comment,
        String(column.primaryKey),
        String(column.autoIncrement),
        column.removed ? 'x' : '',
      ]);
    const shapeIndex = (items: EditableIndex[]) =>
      items.map((index) => [index.name, index.columns, String(index.unique), index.comment, index.removed ? 'x' : '']);
    const shapeFk = (items: EditableFk[]) =>
      items.map((fk) => [fk.name, fk.columns, fk.refTable, fk.refColumns, fk.onDelete, fk.onUpdate, fk.removed ? 'x' : '']);
    return (
      JSON.stringify([shape(columns), shapeIndex(indexes), shapeFk(foreignKeys), tableComment]) !==
      JSON.stringify([shape(originalColumns), shapeIndex(originalIndexes), shapeFk(originalForeignKeys), originalComment])
    );
  }, [columns, indexes, foreignKeys, tableComment, originalColumns, originalIndexes, originalForeignKeys, originalComment]);

  useEffect(() => {
    if (!tab.table) {
      if (initializedFor.current !== `new:${tab.id}`) {
        initializedFor.current = `new:${tab.id}`;
        setTableName('');
        setColumns(defaultColumns(engine));
        setIndexes([]);
        setForeignKeys([]);
        setOriginalColumns([]);
        setOriginalIndexes([]);
        setOriginalForeignKeys([]);
        setTableComment('');
        setOriginalComment('');
        baselineSig.current = '';
        setPendingReload(false);
      }
      return;
    }
    if (!tableInfo) {
      if (!schemas) void loadSchema(tab.connectionId);
      return;
    }

    const nextSig = tableSignature(tableInfo);

    // 首次载入：直接以库里的结构建基线。
    if (initializedFor.current !== `table:${tab.table}`) {
      initializedFor.current = `table:${tab.table}`;
      baselineSig.current = nextSig;
      applyTableInfo(tableInfo);
      setPendingReload(false);
      return;
    }

    // 之后每次 tableInfo 变化（loadSchema 会替换整个数组）都比一次签名。
    if (nextSig === baselineSig.current) return;
    if (!baselineDirty) {
      // 没改过东西：静默跟随新结构，用户看不到闪烁。
      baselineSig.current = nextSig;
      applyTableInfo(tableInfo);
      return;
    }
    // 改过但没保存：不动编辑态，只挂横幅等用户决定。
    setConflictSig(nextSig);
    setPendingReload(true);
  }, [tab.table, tab.connectionId, tab.id, tableInfo, schemas, engine, loadSchema, baselineDirty]);

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
      if (which === 'options') setOptionsNote(tr("新建表还没有表级选项"));
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
        setOptionsNote(result.supported ? '' : result.note ?? tr("该引擎暂不提供表级选项读取"));
      }
    } catch (err: any) {
      delete loadedAux.current[key];
      setError(err?.message ?? tr("读取失败"));
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
      setError(tr("请填写表名"));
      return null;
    }
    if (!activeColumns.length) {
      setError(tr("至少需要一列"));
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
      setError(err?.message ?? tr("生成 DDL 失败"));
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
        notify('info', tr("保存"), tr("没有需要执行的变更"));
        return;
      }
      const destructive = preview.some((sql) => /\b(drop|alter)\b/i.test(sql));
      if (destructive) {
        const ok = await askConfirm({
          message: tr("即将执行包含 DROP / ALTER 的结构变更。"),
          detail: tr("已被删除的列与索引及其数据无法恢复。"),
          danger: true,
          confirmLabel: tr("继续执行"),
        });
        if (!ok) {
          setBusy(false);
          return;
        }
      }
      await api.ddlExecute({ connectionId: tab.connectionId, database: tab.database, statements: preview });
      notify('success', tab.table ? tr("表结构已更新") : tr("表 {0} 已创建", [tableName]));
      await loadSchema(tab.connectionId, true, tab.database);
      if (!tab.table) openData(tab.connectionId, tableName.trim(), tab.database);
      closeTab(tab.id);
    } catch (err: any) {
      setError(err?.message ?? tr("执行失败"));
      notify('error', t('error'), err?.message);
    } finally {
      setBusy(false);
    }
  };

  const patchColumn = (id: string, patch: Partial<EditableColumn>) => setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const openTypeMenu = (event: React.MouseEvent<HTMLButtonElement>, col: EditableColumn) => {
    const cell = event.currentTarget.closest('td')?.getBoundingClientRect();
    if (!cell) return;
    useApp.getState().openContextMenu(
      cell.left,
      cell.bottom + 2,
      typeListFor(engine).map((type) => ({ label: type, onClick: () => patchColumn(col.id, { base: type }) })),
    );
  };

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
      notify('info', tr("主键"), tr("已有列的主键需要重建表才能调整"));
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

  const saveButton = <ToolButton icon={<Save size={14} />} label={tr("保存")} onClick={() => void apply()} disabled={busy || isView} primary testId="design-apply" />;

  const toolbar = () => {
    if (designerTab === 'fields') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Plus size={14} />} label={tr("添加字段")} onClick={() => addColumn()} testId="design-add-column" />
          <ToolButton icon={<ArrowLeftToLine size={14} />} label={tr("插入字段")} onClick={() => addColumn(selColumn)} disabled={!selectedColumn} />
          <ToolButton icon={<Trash2 size={14} />} label={tr("删除字段")} onClick={() => removeColumn(selectedColumn!.id)} disabled={!selectedColumn} />
          <span className="designer-sep" />
          <ToolButton icon={<KeyRound size={14} />} label={tr("主键")} onClick={togglePrimaryKey} disabled={!selectedColumn} />
          <span className="designer-sep" />
          <ToolButton icon={<ArrowUp size={14} />} label={tr("上移")} onClick={() => moveColumn(-1)} disabled={selColumn <= 0} />
          <ToolButton icon={<ArrowDown size={14} />} label={tr("下移")} onClick={() => moveColumn(1)} disabled={selColumn >= columns.length - 1} />
        </>
      );
    }
    if (designerTab === 'indexes') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Plus size={14} />} label={tr("添加索引")} onClick={addIndex} />
          <ToolButton icon={<Trash2 size={14} />} label={tr("删除索引")} onClick={removeIndex} disabled={!selectedIndex || selectedIndex.primary} />
        </>
      );
    }
    if (designerTab === 'foreignKeys') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Plus size={14} />} label={tr("添加外键")} onClick={addFk} />
          <ToolButton icon={<Trash2 size={14} />} label={tr("删除外键")} onClick={removeFk} disabled={!selectedFk} />
        </>
      );
    }
    if (designerTab === 'triggers') {
      return (
        <>
          {saveButton}
          <span className="designer-sep" />
          <ToolButton icon={<Wand2 size={14} />} label={tr("在查询窗口编写触发器")} onClick={() => openQuery(tab.connectionId, 'CREATE TRIGGER ')} />
          <ToolButton
            icon={<RefreshCw size={14} />}
            label={tr("刷新")}
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
            label={tr("刷新")}
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
          <ToolButton icon={<RefreshCw size={14} />} label={tr("刷新预览")} onClick={() => void buildPreview()} testId="design-preview" />
        </>
      );
    }
    return saveButton;
  };

  const detailPanel = () => {
    if (designerTab === 'fields' && selectedColumn) {
      return (
        <div className="designer-detail">
          <div className="designer-detail-title">{selectedColumn.name || tr("(新字段)")}</div>
          <div className="designer-detail-body">
            <label className="designer-form-row">
              <span>{tr("默认:")}</span>
              <input className="input" value={selectedColumn.defaultValue} placeholder={tr("（无）")} onChange={(e) => patchColumn(selectedColumn.id, { defaultValue: e.target.value })} />
            </label>
            <label className="designer-check">
              <input
                type="checkbox"
                checked={selectedColumn.autoIncrement}
                disabled={Boolean(selectedColumn.originalName)}
                onChange={(e) => patchColumn(selectedColumn.id, { autoIncrement: e.target.checked })}
              />
              {tr(" 自动递增 ")}</label>
            <label className="designer-check">
              <input type="checkbox" checked={selectedColumn.unsigned} onChange={(e) => patchColumn(selectedColumn.id, { unsigned: e.target.checked })} />
              {tr(" 无符号 ")}</label>
            <label className="designer-check">
              <input type="checkbox" checked={selectedColumn.zerofill} onChange={(e) => patchColumn(selectedColumn.id, { zerofill: e.target.checked })} />
              {tr(" 填充零 ")}</label>
            <span className="designer-summary">
              <span>{tr("完整类型")}</span>
              <code>{composeType(selectedColumn) || '—'}</code>
            </span>
          </div>
        </div>
      );
    }
    if (designerTab === 'indexes' && selectedIndex) {
      const kind = selectedIndex.method === 'FULLTEXT' ? 'FULLTEXT ' : selectedIndex.unique ? 'UNIQUE ' : '';
      return (
        <div className="designer-detail">
          <div className="designer-detail-title">{selectedIndex.name || tr("(自动命名)")}</div>
          <div className="designer-detail-body">
            <pre className="ddl-box inline">
              {`CREATE ${kind}INDEX ${selectedIndex.name || tr('(自动命名)')} ON ${tableName} (${toList(selectedIndex.columns).join(', ') || '...'})${
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
          <div className="designer-detail-title">{selectedFk.name || tr("(自动命名)")}</div>
          <div className="designer-detail-body">
            <pre className="ddl-box inline">
              {`CONSTRAINT ${selectedFk.name || tr('(自动命名)')} FOREIGN KEY (${toList(selectedFk.columns).join(', ') || '...'}) REFERENCES ${
                [selectedFk.refSchema, selectedFk.refTable].filter(Boolean).join('.') || tr('(未选择)')
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
    const parts = [tr("字段数: {0}", [activeColumns.length])];
    if (designerTab === 'indexes' || designerTab === 'sql' || designerTab === 'comments') parts.push(tr("索引数: {0}", [activeIndexes.length]));
    if (designerTab === 'foreignKeys' || designerTab === 'sql') parts.push(tr("外键数: {0}", [activeFks.length]));
    if (designerTab === 'triggers') parts.push(tr("触发器数: {0}", [triggers.length]));
    return parts;
  };

  return (
    <div className="view designer">
      <div className="designer-toolbar">
        {toolbar()}
        <div className="spacer" />
        {isView ? <span className="designer-hint">{tr("视图不可编辑结构")}</span> : null}
        <label className="designer-tabname">
          <span>{t('name')}</span>
          <input
            className="input"
            style={{ width: 210 }}
            value={tableName}
            placeholder={tr("表名")}
            disabled={Boolean(tab.table)}
            onChange={(e) => setTableName(e.target.value)}
            data-testid="design-table-name"
          />
        </label>
        <button className="btn small" title={t('preview')} onClick={() => void buildPreview()}>
          <Code2 size={12} /> <span className="btn-text">{t('preview')}</span>
        </button>
      </div>

      <div className="designer-tabs">
        {TABS.map((item) => (
          <button key={item.id} className={designerTab === item.id ? 'active' : ''} onClick={() => switchTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      {pendingReload ? (
        <div className="risk-banner designer-conflict" data-testid="designer-conflict">
          <span>{tr("此表已在别处被修改。")}</span>
          <button
            className="btn small"
            data-testid="designer-conflict-reload"
            onClick={() => {
              if (tableInfo) applyTableInfo(tableInfo);
              baselineSig.current = conflictSig;
              setPendingReload(false);
            }}
          >
            {tr(" 重新加载 ")}</button>
          <button
            className="btn small"
            data-testid="designer-conflict-keep"
            onClick={() => {
              // 把基线推进到对方的版本：同一次变更不再反复提示。
              // 代价是继续基于旧结构编辑，apply() 可能与新结构冲突——由数据库报错兜底，
              // 好过静默丢掉用户填了一半的内容。
              baselineSig.current = conflictSig;
              setPendingReload(false);
            }}
          >
            {tr(" 保留我的修改 ")}</button>
        </div>
      ) : null}

      {error ? <div className="risk-banner designer-error">{error}</div> : null}

      <div className="designer-grid-wrap">
        {designerTab === 'fields' ? (
          <table className="designer-grid">
            <thead>
              <tr>
                <th className="col-mark" style={{ width: 26 }} />
                <th style={{ minWidth: 150 }}>{t('name')}</th>
                <th style={{ minWidth: 190 }}>{t('type')}</th>
                <th style={{ width: 64 }}>{tr("长度")}</th>
                <th style={{ width: 64 }}>{tr("小数")}</th>
                <th style={{ width: 64 }}>{tr("非空")}</th>
                <th style={{ width: 56 }}>{tr("虚拟")}</th>
                <th style={{ width: 52 }}>{tr("键")}</th>
                <th style={{ minWidth: 160 }}>{tr("注释")}</th>
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
                    <div className="type-cell">
                      <input value={col.base} title={composeType(col)} onChange={(e) => patchColumn(col.id, { base: e.target.value })} />
                      <button className="icon-btn type-pick" title={tr("选择类型")} onClick={(event) => openTypeMenu(event, col)}>
                        <ChevronDown size={11} />
                      </button>
                    </div>
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
                      title={col.generated ? tr("生成列（{0}）", [col.generated]) : tr("生成列请通过 SQL 维护")}
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
                <th style={{ minWidth: 200 }}>{tr("字段")}</th>
                <th style={{ width: 130 }}>{tr("索引类型")}</th>
                <th style={{ width: 130 }}>{tr("索引方法")}</th>
                <th style={{ minWidth: 160 }}>{tr("注释")}</th>
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
                      placeholder={tr("自动命名")}
                      onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, name: e.target.value } : i)))}
                    />
                  </td>
                  <td>
                    <input value={idx.columns} disabled={idx.primary} onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, columns: e.target.value } : i)))} />
                  </td>
                  <td>
                    <Select
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
                      <Option value="NORMAL">NORMAL</Option>
                      <Option value="UNIQUE">UNIQUE</Option>
                      <Option value="PRIMARY">PRIMARY</Option>
                      <Option value="FULLTEXT">FULLTEXT</Option>
                    </Select>
                  </td>
                  <td>
                    <Select value={idx.method} disabled={idx.primary} onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, method: e.target.value } : i)))}>
                      <Option value="">{tr("（默认）")}</Option>
                      {INDEX_METHODS.map((method) => (
                        <Option key={method} value={method}>
                          {method}
                        </Option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <input value={idx.comment} disabled={idx.primary} onChange={(e) => setIndexes((prev) => prev.map((i) => (i.id === idx.id ? { ...i, comment: e.target.value } : i)))} />
                  </td>
                </tr>
              ))}
              {!indexes.length ? (
                <tr>
                  <td className="designer-empty" colSpan={6}>
                    {tr(" 该表没有索引。 ")}</td>
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
                <th style={{ minWidth: 130 }}>{tr("字段")}</th>
                <th style={{ minWidth: 110 }}>{tr("被引用的模式")}</th>
                <th style={{ minWidth: 150 }}>{tr("被引用的表（父）")}</th>
                <th style={{ minWidth: 120 }}>{tr("被引用的字段")}</th>
                <th style={{ minWidth: 120 }}>{tr("删除时")}</th>
                <th style={{ minWidth: 120 }}>{tr("更新时")}</th>
              </tr>
            </thead>
            <tbody>
              {foreignKeys.map((fk, index) => (
                <tr key={fk.id} className={`${selFk === index ? 'selected' : ''} ${fk.removed ? 'removed' : ''}`} onClick={() => setSelFk(index)}>
                  <td className="col-mark">{selFk === index ? <ChevronRight size={12} className="open" /> : null}</td>
                  <td>
                    <input value={fk.name} placeholder={tr("自动命名")} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, name: e.target.value } : f)))} />
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
                    <Select value={fk.onDelete} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, onDelete: e.target.value } : f)))}>
                      <Option value="">{tr("（默认）")}</Option>
                      {FK_ACTIONS.map((action) => (
                        <Option key={action} value={action}>
                          {action}
                        </Option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Select value={fk.onUpdate} onChange={(e) => setForeignKeys((prev) => prev.map((f) => (f.id === fk.id ? { ...f, onUpdate: e.target.value } : f)))}>
                      <Option value="">{tr("（默认）")}</Option>
                      {FK_ACTIONS.map((action) => (
                        <Option key={action} value={action}>
                          {action}
                        </Option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
              {!foreignKeys.length ? (
                <tr>
                  <td className="designer-empty" colSpan={8}>
                    {tr(" 该表没有外键。 ")}</td>
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
                <th style={{ width: 120 }}>{tr("触发")}</th>
                <th style={{ width: 80 }}>{tr("插入")}</th>
                <th style={{ width: 80 }}>{tr("更新")}</th>
                <th style={{ width: 80 }}>{tr("删除")}</th>
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
                    {tr(" 该表没有触发器。触发器的创建与删除请在查询窗口执行 SQL。 ")}</td>
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
                    {optionsNote || tr("没有可读取的表选项。")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {designerTab === 'comments' ? (
          <div className="designer-comments">
            <label className="designer-form-row wide">
              <span>{tr("表注释:")}</span>
              <textarea className="input" rows={2} value={tableComment} onChange={(e) => setTableComment(e.target.value)} placeholder={tr("为该表填写业务含义说明")} />
            </label>
            <table className="designer-grid">
              <thead>
                <tr>
                  <th className="col-mark" style={{ width: 26 }} />
                  <th style={{ minWidth: 180 }}>{t('name')}</th>
                  <th style={{ minWidth: 320 }}>{tr("注释")}</th>
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
              <div className="designer-empty-inline">{tr("没有待执行的变更。修改字段、索引、外键或注释后，这里会生成 DDL。")}</div>
            )}
          </div>
        ) : null}
      </div>

      {detailPanel()}

      <div className="designer-status">
        {statusText().map((text) => (
          <span key={text}>{text}</span>
        ))}
        <div className="spacer" />
        <span className={dirty ? 'changed' : ''}>{dirty ? tr("有未保存的变更") : tr("无变更")}</span>
        <span>
          <Wrench size={11} /> {tab.table ? tr("设计 · {0}", [tab.table]) : t('newTable')}
        </span>
      </div>
    </div>
  );
}
