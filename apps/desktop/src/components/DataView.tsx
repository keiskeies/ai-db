import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  ClipboardCopy,
  ClipboardPaste,
  Columns3,
  CopyPlus,
  Download,
  Filter,
  ListFilter,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Table2,
  Trash2,
  Type,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { quoteIdent, quoteLiteral, writesLineProtocol, type TableInfo } from '@aidb/core';
import { api, type DataPage } from '../lib/api';
import { useApp, type Tab } from '../store';
import { DataGrid } from './DataGrid';
import { LineProtocolPanel } from './LineProtocolPanel';
import { EmptyState, Modal } from './ui';
import { formatDuration } from '../lib/format';

type DataTab = Extract<Tab, { kind: 'data' }>;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function jsonToCsv(text: string): string {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { rows?: unknown[] })?.rows)
      ? (parsed as { rows: unknown[] }).rows
      : [parsed];
  if (!list.length) throw new Error('JSON 没有记录');
  if (Array.isArray(list[0])) return rowsToCsv(list as unknown[][]);
  const records = list as Array<Record<string, unknown>>;
  const headers = [...new Set(records.flatMap((row) => Object.keys(row ?? {})))];
  if (!headers.length) throw new Error('JSON 记录没有字段');
  return rowsToCsv([headers, ...records.map((row) => headers.map((key) => row?.[key]))]);
}

function xmlToCsv(text: string): string {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML 解析失败');
  let records: Element[] = [];
  for (const tag of ['row', 'record', 'item']) {
    const found = [...doc.getElementsByTagName(tag)].filter((element) => element.children.length);
    if (found.length > records.length) records = found;
  }
  if (!records.length) throw new Error('XML 里没有 <row>/<record>/<item> 记录');
  const headers = [...new Set(records.flatMap((record) => [...record.children].map((child) => child.tagName)))];
  const rows = records.map((record) => headers.map((tag) => [...record.children].find((child) => child.tagName === tag)?.textContent ?? ''));
  return rowsToCsv([headers, ...rows]);
}

function parseCsvPreview(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= 60) break;
    } else if (char !== '\r') field += char;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

interface ImportDraft {
  name: string;
  csv: string;
  delimiter: string;
  hasHeader: boolean;
  rows: string[][];
  mapping: Record<string, number>;
}

export function DataView({ tab }: { tab: DataTab }) {
  const t = useApp((s) => s.t);
  const schemas = useApp((s) => s.schemas[tab.connectionId]);
  const connections = useApp((s) => s.connections);
  const notify = useApp((s) => s.notify);
  const openDesign = useApp((s) => s.openDesign);
  const loadSchema = useApp((s) => s.loadSchema);

  const conn = connections.find((c) => c.id === tab.connectionId);
  const tableInfo: TableInfo | undefined = useMemo(() => {
    for (const schema of schemas ?? []) {
      if (tab.database && schema.name !== tab.database && conn?.engine !== 'postgresql') continue;
      const found = schema.tables.find((tbl) => tbl.name === tab.table);
      if (found) return found;
    }
    return (schemas ?? []).flatMap((s) => s.tables).find((tbl) => tbl.name === tab.table);
  }, [schemas, tab.database, tab.table]);

  const pkColumns = useMemo(() => (tableInfo?.columns ?? []).filter((c) => c.primaryKey), [tableInfo]);
  const writable = !conn?.readonly;
  const canEdit = pkColumns.length > 0 && writable;
  const canLineProtocol = conn ? writesLineProtocol(conn.engine) : false;
  const [lineOpen, setLineOpen] = useState(false);

  const [page, setPage] = useState<DataPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [sorts, setSorts] = useState<Array<{ column: string; dir: 'asc' | 'desc' }>>([]);
  const [whereInput, setWhereInput] = useState('');
  const [where, setWhere] = useState('');
  const [newRow, setNewRow] = useState<Record<number, string> | null>(null);
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [exportFormat, setExportFormat] = useState<'csv' | 'json' | 'sql' | 'xml'>('csv');
  const [importing, setImporting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceDraft, setReplaceDraft] = useState({ column: '', find: '', replace: '', scoped: true });
  const [replacePreview, setReplacePreview] = useState<number | null>(null);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const [formMode, setFormMode] = useState(false);
  const [formRow, setFormRow] = useState(0);
  const [formDraft, setFormDraft] = useState<Record<string, string> | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [sortDraft, setSortDraft] = useState<Array<{ column: string; dir: 'asc' | 'desc' }>>([{ column: '', dir: 'asc' }]);
  const [conditions, setConditions] = useState<Array<{ column: string; op: string; value: string; connector: 'AND' | 'OR' }>>([
    { column: '', op: '=', value: '', connector: 'AND' },
  ]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.data({
        connectionId: tab.connectionId,
        table: tab.table,
        database: tab.database,
        limit,
        offset,
        orderBy: sorts.length ? sorts.map((sort) => sort.column).join(',') : undefined,
        orderDir: sorts.length ? sorts.map((sort) => sort.dir).join(',') : undefined,
        where: where || undefined,
      });
      setPage(result);
    } catch (err: any) {
      setError(err?.message ?? '加载失败');
      setPage(null);
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.table, tab.database, limit, offset, sorts, where]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const columns = page?.batch.sets[0]?.columns ?? [];
  const orderBy = sorts[0]?.column;
  const orderDir = sorts[0]?.dir ?? 'asc';
  const rows = page?.batch.sets[0]?.rows ?? [];
  const total = page?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;

  useEffect(() => {
    setSelected(new Set());
  }, [tab.connectionId, tab.table, tab.database, limit, offset, sorts, where, refreshKey]);

  useEffect(() => {
    setHiddenColumns([]);
    setFormMode(false);
    setFormRow(0);
    setFormDraft(null);
  }, [tab.connectionId, tab.table, tab.database]);

  const draftOfRow = (index: number): Record<string, string> => {
    const row = rows[index] ?? [];
    const draft: Record<string, string> = {};
    columns.forEach((column, i) => {
      const value = row[i];
      draft[column.name] = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
    return draft;
  };

  useEffect(() => {
    if (!formMode || !rows.length) {
      setFormDraft(null);
      return;
    }
    if (formRow > rows.length - 1) {
      setFormRow(rows.length - 1);
      return;
    }
    setFormDraft(draftOfRow(formRow));
  }, [formMode, formRow, rows, columns]);

  useEffect(() => {
    if (!replaceDraft.column && columns.length) {
      setReplaceDraft((prev) => ({ ...prev, column: columns[0].name }));
    }
  }, [columns, replaceDraft.column]);

  const toggleSort = (column: string) => {
    setSorts((prev) => {
      if (prev.length === 1 && prev[0].column === column) {
        return prev[0].dir === 'asc' ? [{ column, dir: 'desc' }] : [];
      }
      return [{ column, dir: 'asc' }];
    });
    setOffset(0);
  };

  const rowKey = (rowIndex: number): Record<string, unknown> | null => {
    if (!canEdit || !page) return null;
    const values = page.batch.sets[0]?.rows[rowIndex];
    if (!values) return null;
    const names = page.batch.sets[0].columns.map((c) => c.name);
    const key: Record<string, unknown> = {};
    for (const pk of pkColumns) {
      const idx = names.indexOf(pk.name);
      if (idx === -1) return null;
      key[pk.name] = values[idx];
    }
    return key;
  };

  const selectedIndices = useMemo(
    () => [...selected].filter((index) => index >= 0 && index < rows.length).sort((a, b) => a - b),
    [selected, rows.length],
  );

  const toggleRow = (rowIndex: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((_, index) => index))));
  };

  const clipboardValue = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const copySelected = async () => {
    const indices = selectedIndices.length ? selectedIndices : rows.map((_, index) => index);
    if (!indices.length) {
      notify('warning', '没有可复制的行');
      return;
    }
    const text = [
      columns.map((column) => column.name).join('\t'),
      ...indices.map((index) => rows[index].map(clipboardValue).join('\t')),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      notify('success', `已复制 ${indices.length} 行`, 'TSV 格式，可直接粘贴到表格或 Excel');
    } catch (err: any) {
      notify('error', '复制失败', err?.message);
    }
  };

  const duplicateSelected = async () => {
    if (!selectedIndices.length) {
      notify('warning', '请先勾选要复制的行');
      return;
    }
    const auto = new Set((tableInfo?.columns ?? []).filter((column) => column.autoIncrement).map((column) => column.name));
    const records = selectedIndices.map((index) => {
      const values: Record<string, unknown> = {};
      columns.forEach((column, columnIndex) => {
        if (!auto.has(column.name)) values[column.name] = rows[index][columnIndex];
      });
      return values;
    });
    try {
      const { result } = await api.rows({ connectionId: tab.connectionId, database: tab.database, table: tab.table, op: 'insertMany', rows: records });
      notify('success', `已复制 ${records.length} 行`, `影响 ${result.affected ?? records.length} 行`);
      setSelected(new Set());
      setRefreshKey((key) => key + 1);
    } catch (err: any) {
      notify('error', '复制行失败', err?.message);
    }
  };

  const deleteSelected = async () => {
    if (!selectedIndices.length) {
      notify('warning', '请先勾选要删除的行');
      return;
    }
    const keys = selectedIndices.map((index) => rowKey(index));
    if (keys.some((key) => !key)) {
      notify('warning', '所选行缺少主键，无法安全批量删除');
      return;
    }
    if (!window.confirm(`删除所选 ${keys.length} 行？此操作不可恢复。`)) return;
    try {
      const { result } = await api.rows({ connectionId: tab.connectionId, database: tab.database, table: tab.table, op: 'deleteMany', keys });
      notify('success', `已删除 ${result.affected ?? keys.length} 行`);
      setSelected(new Set());
      setRefreshKey((key) => key + 1);
    } catch (err: any) {
      notify('error', '批量删除失败', err?.message);
    }
  };

  const confirmPaste = async () => {
    const lines = pasteText.replace(/\r/g, '').split('\n').filter((line) => line.trim().length);
    if (!lines.length) {
      notify('warning', '粘贴内容为空');
      return;
    }
    const matrix = lines.map((line) => line.split('\t'));
    const header = matrix[0].map((item) => item.trim());
    const hasHeader = header.some((item) => columns.some((column) => column.name.toLowerCase() === item.toLowerCase()));
    const source = hasHeader ? matrix.slice(1) : matrix;
    const mapping = columns.map((column) => (hasHeader ? header.findIndex((item) => item.toLowerCase() === column.name.toLowerCase()) : columns.findIndex((item) => item.name === column.name)));
    const records = source
      .map((cells) => {
        const values: Record<string, unknown> = {};
        columns.forEach((column, index) => {
          const sourceIndex = mapping[index];
          if (sourceIndex !== undefined && sourceIndex >= 0) values[column.name] = cells[sourceIndex] ?? null;
        });
        return values;
      })
      .filter((record) => Object.keys(record).length);
    if (!records.length) {
      notify('warning', '没有可导入的行');
      return;
    }
    try {
      const { result } = await api.rows({ connectionId: tab.connectionId, database: tab.database, table: tab.table, op: 'insertMany', rows: records });
      notify('success', `已粘贴 ${result.affected ?? records.length} 行`);
      setPasteOpen(false);
      setPasteText('');
      setRefreshKey((key) => key + 1);
    } catch (err: any) {
      notify('error', '粘贴失败', err?.message);
    }
  };

  const runReplace = async (preview: boolean) => {
    if (!replaceDraft.column || !replaceDraft.find) {
      notify('warning', '请选择列并填写查找内容');
      return;
    }
    setReplaceBusy(true);
    try {
      const result = await api.replaceData({
        connectionId: tab.connectionId,
        database: tab.database,
        table: tab.table,
        column: replaceDraft.column,
        find: replaceDraft.find,
        replace: replaceDraft.replace,
        where: replaceDraft.scoped && where ? where : undefined,
        preview,
      });
      if (preview) {
        setReplacePreview(result.affected);
        notify('info', `匹配 ${result.affected} 行`, result.sql);
      } else {
        if (!window.confirm(`将修改 ${replacePreview ?? '匹配'} 行，继续？`)) return;
        notify('success', `已替换 ${result.affected} 行`);
        setReplaceOpen(false);
        setReplacePreview(null);
        setRefreshKey((key) => key + 1);
      }
    } catch (err: any) {
      notify('error', preview ? '预览失败' : '替换失败', err?.message);
    } finally {
      setReplaceBusy(false);
    }
  };

  const applyFilterBuilder = () => {
    const engine = conn?.engine ?? 'sqlite';
    const parts = conditions
      .filter((condition) => condition.column && (condition.op === 'IS NULL' || condition.op === 'IS NOT NULL' || condition.value.trim()))
      .map((condition, index) => {
        const column = quoteIdent(condition.column, engine);
        const value = condition.value.trim();
        let expression: string;
        if (condition.op === 'IS NULL' || condition.op === 'IS NOT NULL') expression = `${column} ${condition.op}`;
        else if (condition.op === 'IN') expression = `${column} IN (${value.split(',').map((item) => quoteLiteral(item.trim())).join(', ')})`;
        else if (condition.op === 'LIKE' || condition.op === 'NOT LIKE') expression = `${column} ${condition.op} ${quoteLiteral(`%${value}%`)}`;
        else expression = `${column} ${condition.op} ${quoteLiteral(value)}`;
        return index === 0 ? expression : `${condition.connector} ${expression}`;
      });
    const sql = parts.join(' ');
    setWhereInput(sql);
    setWhere(sql);
    setOffset(0);
    setFilterOpen(false);
  };

  const updateCell = async (rowIndex: number, colIndex: number, value: string) => {
    const key = rowKey(rowIndex);
    if (!key) {
      notify('warning', '该表没有主键，无法安全更新');
      return;
    }
    const column = columns[colIndex]?.name;
    if (!column) return;
    try {
      await api.rows({
        connectionId: tab.connectionId,
        database: tab.database,
        table: tab.table,
        op: 'update',
        values: { [column]: value === '' ? null : value },
        key,
      });
      notify('success', '已更新 1 行', column);
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      notify('error', '更新失败', err?.message);
    }
  };

  const saveForm = async () => {
    if (!formDraft) return;
    const key = rowKey(formRow);
    if (!key) {
      notify('warning', '该表没有主键，无法安全更新');
      return;
    }
    const original = draftOfRow(formRow);
    const changes: Record<string, unknown> = {};
    columns.forEach((column) => {
      if (pkColumns.some((pk) => pk.name === column.name)) return;
      const next = formDraft[column.name] ?? '';
      if (next !== (original[column.name] ?? '')) changes[column.name] = next === '' ? null : next;
    });
    if (!Object.keys(changes).length) {
      notify('info', '没有改动');
      return;
    }
    setFormSaving(true);
    try {
      await api.rows({
        connectionId: tab.connectionId,
        database: tab.database,
        table: tab.table,
        op: 'update',
        values: changes,
        key,
      });
      notify('success', '已更新 1 行', Object.keys(changes).join(', '));
      setRefreshKey((value) => value + 1);
    } catch (err: any) {
      notify('error', '更新失败', err?.message);
    } finally {
      setFormSaving(false);
    }
  };

  const deleteRow = async (rowIndex: number) => {
    const key = rowKey(rowIndex);
    if (!key) {
      notify('warning', '该表没有主键，无法安全删除');
      return;
    }
    if (!window.confirm(`删除这一行？\n${JSON.stringify(key)}`)) return;
    try {
      await api.rows({ connectionId: tab.connectionId, database: tab.database, table: tab.table, op: 'delete', key });
      notify('success', '已删除 1 行');
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      notify('error', '删除失败', err?.message);
    }
  };

  const saveNewRow = async () => {
    if (!newRow || !columns.length) return;
    const autoInc = new Set((tableInfo?.columns ?? []).filter((c) => c.autoIncrement).map((c) => c.name));
    const values: Record<string, unknown> = {};
    columns.forEach((col, index) => {
      if (autoInc.has(col.name)) return;
      const raw = newRow[index];
      if (raw === undefined || raw === '') return;
      values[col.name] = raw;
    });
    if (!Object.keys(values).length) {
      notify('warning', '请至少填写一列');
      return;
    }
    try {
      await api.rows({ connectionId: tab.connectionId, database: tab.database, table: tab.table, op: 'insert', values });
      setNewRow(null);
      setRefreshKey((k) => k + 1);
      notify('success', '已插入 1 行');
    } catch (err: any) {
      notify('error', '插入失败', err?.message);
    }
  };

  const exportData = async () => {
    try {
      const { file } = await api.exportData({ connectionId: tab.connectionId, database: tab.database, table: tab.table, format: exportFormat, limit: 200000 });
      notify('success', t('export'), `${file.rows} 行 · ${file.path}`);
    } catch (err: any) {
      notify('error', t('error'), err?.message);
    }
  };

  const importFile = async (file: File) => {
    try {
      const name = file.name.toLowerCase();
      let csv = await file.text();
      const delimiter = file.name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
      if (name.endsWith('.json')) csv = jsonToCsv(csv);
      else if (name.endsWith('.xml')) csv = xmlToCsv(csv);
      const rows = parseCsvPreview(csv, delimiter);
      if (!rows.length) {
        notify('warning', 'CSV 没有内容');
        return;
      }
      const header = rows[0];
      const targetColumns = (tableInfo?.columns ?? columns).map((column) => column.name);
      const mapping: Record<string, number> = {};
      for (const column of targetColumns) {
        const index = header.findIndex((value) => value.trim().toLowerCase() === column.toLowerCase());
        mapping[column] = index;
      }
      setImportDraft({ name: file.name, csv, delimiter, hasHeader: true, rows, mapping });
    } catch (err: any) {
      notify('error', t('error'), err?.message);
    }
  };

  const confirmImport = async () => {
    if (!importDraft) return;
    const mapping = Object.entries(importDraft.mapping)
      .filter(([, index]) => index >= 0)
      .map(([column, sourceIndex]) => ({ column, sourceIndex }));
    if (!mapping.length) {
      notify('warning', '请至少映射一列');
      return;
    }
    setImporting(true);
    try {
      const { result } = await api.importCsv({
        connectionId: tab.connectionId,
        database: tab.database,
        table: tab.table,
        csv: importDraft.csv,
        hasHeader: importDraft.hasHeader,
        delimiter: importDraft.delimiter,
        mapping,
      });
      notify('success', t('import'), `${result.inserted} 行 → ${tab.table}`);
      setImportDraft(null);
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      notify('error', t('error'), err?.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="view">
      <div className="toolbar data-toolbar">
        <span className="title">
          <Table2 size={14} style={{ color: 'var(--accent)' }} />
          {tab.database && conn?.engine !== 'sqlite' ? `${tab.database}.` : ''}
          {tab.table}
        </span>
        <button className="icon-btn" title={t('refresh')} onClick={() => { setRefreshKey((k) => k + 1); void loadSchema(tab.connectionId, true, tab.database); }} data-testid="data-refresh">
          <RefreshCw size={14} />
        </button>
        {canLineProtocol && conn && !conn.readonly ? (
          <button className="btn small ai" onClick={() => setLineOpen(true)} data-testid="open-line-protocol">
            <Upload size={12} /> 写入行协议
          </button>
        ) : null}
        <div className="sep" />
        <div className="row gap-4">
          <Filter size={12} className="muted" />
          <input
            className="inline-input mono"
            style={{ width: 230 }}
            placeholder="WHERE id > 10 AND status = 'completed'"
            value={whereInput}
            onChange={(e) => setWhereInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setOffset(0);
                setWhere(whereInput.trim());
              }
            }}
            data-testid="data-filter"
          />
          {whereInput ? (
            <button
              className="icon-btn"
              title={t('cancel')}
              onClick={() => {
                setWhereInput('');
                setWhere('');
                setOffset(0);
              }}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <div className="sep" />
        <button className="btn small" title="筛选构建器" onClick={() => setFilterOpen(true)} data-testid="data-filter-builder">
          <ListFilter size={12} /> 筛选
        </button>
        <button className="btn small" title="排序" onClick={() => { setSortDraft(sorts.length ? sorts : [{ column: columns[0]?.name ?? '', dir: 'asc' }]); setSortOpen(true); }} data-testid="data-sort">
          <ArrowUpDown size={12} /> 排序
        </button>
        <button className={`btn small ${textMode ? 'active' : ''}`} title="文本视图" onClick={() => setTextMode((value) => !value)} data-testid="data-text-mode">
          <Type size={12} /> 文本
        </button>
        <button className={`btn small ${formMode ? 'active' : ''}`} title="表单视图（逐行编辑）" onClick={() => { setFormMode((value) => !value); setFormRow(0); }} data-testid="data-form-mode">
          <Rows3 size={12} /> 表单
        </button>
        <button className={`btn small ${hiddenColumns.length ? 'active' : ''}`} title="列显示管理" onClick={() => setColumnsOpen(true)} data-testid="data-columns">
          <Columns3 size={12} /> 列{hiddenColumns.length ? ` ${hiddenColumns.length}` : ''}
        </button>
        <button className="btn small" title="查找替换" onClick={() => setReplaceOpen(true)} disabled={!writable} data-testid="data-find-replace">
          <Search size={12} /> 查找
        </button>
      </div>

      <div className="toolbar data-toolbar-2">
        <button className="btn small" title="复制所选行（TSV）" onClick={() => void copySelected()} data-testid="data-copy-rows">
          <ClipboardCopy size={12} /> 复制
        </button>
        <button className="btn small" title="粘贴行" onClick={() => setPasteOpen(true)} disabled={!writable} data-testid="data-paste-rows">
          <ClipboardPaste size={12} /> 粘贴
        </button>
        <button className="btn small" title="复制所选行到表尾" onClick={() => void duplicateSelected()} disabled={!selectedIndices.length || !canEdit} data-testid="data-duplicate-rows">
          <CopyPlus size={12} /> 复制行
        </button>
        <button className="btn small danger" title="删除所选行" onClick={() => void deleteSelected()} disabled={!selectedIndices.length || !canEdit} data-testid="data-delete-rows">
          <Trash2 size={12} /> 删除所选
        </button>
        {selectedIndices.length ? <span className="badge write">已选 {selectedIndices.length}</span> : null}
        <div className="spacer" />
        <button className="btn small" onClick={() => setNewRow(newRow ? null : {})} disabled={!columns.length || !writable} data-testid="data-add-row">
          <Plus size={12} /> {t('addRow')}
        </button>
        {newRow ? (
          <button className="btn primary small" onClick={() => void saveNewRow()} data-testid="data-save-new-row">
            保存新行
          </button>
        ) : null}
        <button className="btn small" onClick={() => fileRef.current?.click()} disabled={!writable} data-testid="data-import">
          <Upload size={12} /> {t('import')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,.json,.xml"
          style={{ display: 'none' }}
          data-testid="data-import-file" 
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = '';
          }}
        />
        <select className="select" style={{ height: 23, width: 72, fontSize: 10 }} value={exportFormat} onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
          <option value="sql">SQL</option>
          <option value="xml">XML</option>
        </select>
        <button className="btn small" onClick={() => void exportData()} data-testid="data-export">
          <Download size={12} /> {t('export')}
        </button>
        <button className="btn small" onClick={() => openDesign(tab.connectionId, tab.table, tab.database)}>
          <Wrench size={12} /> {t('design')}
        </button>
      </div>

      {error ? (
        <div className="empty-state">
          <div>
            <h3>{t('error')}</h3>
            <p className="mono" style={{ color: 'var(--danger)' }}>{error}</p>
            <button className="btn" style={{ marginTop: 10 }} onClick={() => void load()}>
              <RefreshCw size={12} /> {t('retry')}
            </button>
          </div>
        </div>
      ) : page && rows.length ? (
        formMode ? (
          <div style={{ padding: 12, overflow: 'auto' }} data-testid="data-form-view">
            <div className="row gap-8" style={{ marginBottom: 10, alignItems: 'center' }}>
              <button className="btn small" disabled={formRow <= 0} onClick={() => setFormRow((value) => Math.max(0, value - 1))} data-testid="form-prev">‹</button>
              <span className="muted">第 {Math.min(formRow, rows.length - 1) + 1} / {rows.length} 行（当前页）</span>
              <button className="btn small" disabled={formRow >= rows.length - 1} onClick={() => setFormRow((value) => Math.min(rows.length - 1, value + 1))} data-testid="form-next">›</button>
              <div className="spacer" />
              <button className="btn small" onClick={() => setFormDraft(draftOfRow(formRow))} data-testid="form-reset">重置</button>
              <button className="btn primary small" onClick={() => void saveForm()} disabled={!canEdit || formSaving} data-testid="form-save">
                {formSaving ? '保存中…' : '保存'}
              </button>
            </div>
            <div className="form-grid">
              {columns.map((column) => {
                const isPk = pkColumns.some((pk) => pk.name === column.name);
                return (
                  <label className="field" key={column.name}>
                    <span>{column.name}{isPk ? ' · 主键' : ''}{column.type ? <span className="muted" style={{ fontSize: 11 }}> · {column.type}</span> : null}</span>
                    <input
                      className="input mono"
                      value={formDraft?.[column.name] ?? ''}
                      disabled={!canEdit || isPk}
                      onChange={(event) => setFormDraft((prev) => ({ ...(prev ?? {}), [column.name]: event.target.value }))}
                      data-testid={`form-field-${column.name}`}
                    />
                  </label>
                );
              })}
            </div>
            {!writable ? <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>只读连接，表单不可保存。</div> : !canEdit ? <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>该表没有主键，表单只读。</div> : null}
          </div>
        ) : (
        <DataGrid
          columns={columns}
          rows={rows}
          orderBy={orderBy}
          orderDir={orderDir}
          onSort={toggleSort}
          editable={canEdit}
          onCellEdit={updateCell}
          onRowDelete={deleteRow}
          newRowValues={newRow ?? undefined}
          onNewRowChange={(index, value) => setNewRow((prev) => ({ ...(prev ?? {}), [index]: value }))}
          selectedRows={selected}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
          rowNumberStart={offset}
          textMode={textMode}
          hiddenColumns={hiddenColumns}
        />
        )
      ) : loading ? (
        <div className="empty-state">
          <div className="loading-inline">
            <span className="spinner" /> {t('loading')}
          </div>
        </div>
      ) : (
        <EmptyState icon={<Table2 size={20} />} title={t('noResults')}>
          {!writable ? '只读连接，当前以只读方式展示。' : canEdit ? '这张表还没有数据，点击“新增行”开始。' : '该表没有主键，当前以只读方式展示。'}
        </EmptyState>
      )}

      <div className="grid-foot">
        <span>
          第 {total ? offset + 1 : 0}-{Math.min(offset + rows.length, total)} 条记录（共 {total.toLocaleString()} 条）· 第 {currentPage}/{totalPages} 页
          {page?.batch.sets[0] ? ` · ${formatDuration(page.batch.durationMs)}` : ''}
          {selectedIndices.length ? ` · 已选 ${selectedIndices.length} 行` : ''}
          {!writable ? ' · 只读连接' : !canEdit ? ' · 只读（无主键）' : ''}
        </span>
        {page?.batch.sets[0]?.truncated ? <span className="badge write">结果已截断</span> : null}
        <div className="pager">
          <select className="select" style={{ height: 24, fontSize: 11 }} value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }}>
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n} / 页
              </option>
            ))}
          </select>
          <button className="btn ghost" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            ‹
          </button>
          <span style={{ minWidth: 54, textAlign: 'center' }}>
            {currentPage} / {totalPages}
          </span>
          <button className="btn ghost" disabled={currentPage >= totalPages} onClick={() => setOffset(offset + limit)}>
            ›
          </button>
        </div>
      </div>

      {importDraft ? (
        <Modal
          title={`导入数据 · ${importDraft.name}`}
          onClose={() => setImportDraft(null)}
          footer={
            <>
              <span className="hint" style={{ marginRight: 'auto' }}>
                预览 {Math.max(0, importDraft.rows.length - (importDraft.hasHeader ? 1 : 0))} 行 · 目标 {tab.table}
              </span>
              <button className="btn" onClick={() => setImportDraft(null)}>{t('cancel')}</button>
              <button className="btn primary" onClick={() => void confirmImport()} disabled={importing} data-testid="import-confirm">
                {importing ? '导入中…' : t('import')}
              </button>
            </>
          }
        >
          <div className="col gap-10">
            <div className="row gap-10">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={importDraft.hasHeader}
                  onChange={(e) => setImportDraft({ ...importDraft, hasHeader: e.target.checked })}
                /> 首行为表头
              </label>
              <div className="field" style={{ width: 150 }}>
                <select
                  className="select"
                  value={importDraft.delimiter === '\t' ? '\t' : importDraft.delimiter}
                  onChange={(e) => {
                    const delimiter = e.target.value;
                    setImportDraft({ ...importDraft, delimiter, rows: parseCsvPreview(importDraft.csv, delimiter) });
                  }}
                >
                  <option value=",">逗号 ,</option>
                  <option value=";">分号 ;</option>
                  <option value="\t">Tab</option>
                </select>
              </div>
            </div>
            <div className="mini-table-wrap" style={{ maxHeight: 160 }}>
              <table className="tool-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {(importDraft.hasHeader ? importDraft.rows[0] : importDraft.rows[0]?.map((_, index) => `列 ${index + 1}`))?.map((header, index) => (
                      <th key={index}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {importDraft.rows.slice(importDraft.hasHeader ? 1 : 0, importDraft.hasHeader ? 6 : 5).map((row, index) => (
                    <tr key={index}>
                      <td className="muted">{index + 1}</td>
                      {row.map((value, valueIndex) => <td key={valueIndex}>{value.slice(0, 60)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="tool-section-title">列映射</div>
              <div className="mapping-grid">
                {(tableInfo?.columns ?? columns).map((column) => (
                  <div key={column.name} className="mapping-row">
                    <span className="mono">{column.name}</span>
                    <span className="muted">←</span>
                    <select
                      className="select"
                      value={importDraft.mapping[column.name] ?? -1}
                      onChange={(e) => setImportDraft({ ...importDraft, mapping: { ...importDraft.mapping, [column.name]: Number(e.target.value) } })}
                    >
                      <option value={-1}>不导入</option>
                      {(importDraft.hasHeader ? importDraft.rows[0] : importDraft.rows[0]?.map((_, index) => `列 ${index + 1}`) ?? []).map((header, index) => (
                        <option key={index} value={index}>{header} (#{index + 1})</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
      {columnsOpen ? (
        <Modal
          title={`列显示 · ${tab.table}`}
          onClose={() => setColumnsOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setHiddenColumns([])} data-testid="columns-reset">全部显示</button>
              <button className="btn primary" onClick={() => setColumnsOpen(false)}>完成</button>
            </>
          }
        >
          <div className="column-picker" data-testid="columns-panel">
            {columns.map((column) => {
              const visible = !hiddenColumns.includes(column.name);
              return (
                <label key={column.name} className="checkbox">
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => setHiddenColumns((prev) => {
                      if (visible) {
                        // 至少保留一列，否则表格只剩行号
                        if (columns.length - prev.length <= 1) return prev;
                        return [...prev, column.name];
                      }
                      return prev.filter((name) => name !== column.name);
                    })}
                    data-testid={`column-toggle-${column.name}`}
                  />
                  {column.name}
                  {column.type ? <span className="muted" style={{ fontSize: 11 }}>{column.type}</span> : null}
                </label>
              );
            })}
          </div>
        </Modal>
      ) : null}

      {sortOpen ? (
        <Modal
          title={`排序 · ${tab.table}`}
          onClose={() => setSortOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => { setSorts([]); setOffset(0); setSortOpen(false); }} data-testid="sort-clear">不排序</button>
              <button className="btn" onClick={() => setSortOpen(false)}>{t('cancel')}</button>
              <button
                className="btn primary"
                onClick={() => { setSorts(sortDraft.filter((rule) => rule.column).slice(0, 3)); setOffset(0); setSortOpen(false); }}
                data-testid="sort-apply"
              >
                应用
              </button>
            </>
          }
        >
          <div className="sort-rules">
            {sortDraft.map((rule, index) => (
              <div className="row gap-8" key={index} data-testid={`sort-row-${index}`}>
                <select
                  className="select"
                  value={rule.column}
                  onChange={(e) => setSortDraft((prev) => prev.map((item, i) => (i === index ? { ...item, column: e.target.value } : item)))}
                  data-testid={`sort-column-${index}`}
                >
                  <option value="">选择排序列</option>
                  {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                </select>
                <select
                  className="select"
                  value={rule.dir}
                  onChange={(e) => setSortDraft((prev) => prev.map((item, i) => (i === index ? { ...item, dir: e.target.value as 'asc' | 'desc' } : item)))}
                  data-testid={`sort-dir-${index}`}
                >
                  <option value="asc">升序 ASC</option>
                  <option value="desc">降序 DESC</option>
                </select>
                {sortDraft.length > 1 ? (
                  <button className="icon-btn" title="移除该排序条件" onClick={() => setSortDraft((prev) => prev.filter((_, i) => i !== index))} data-testid={`sort-remove-${index}`}>
                    <X size={12} />
                  </button>
                ) : null}
              </div>
            ))}
            {sortDraft.length < 3 ? (
              <button className="btn small" onClick={() => setSortDraft((prev) => [...prev, { column: '', dir: 'asc' }])} data-testid="sort-add">
                <Plus size={12} /> 添加排序条件
              </button>
            ) : null}
            <div className="muted" style={{ fontSize: 11 }}>先按第一列排序，值相同的行再按后续列排序（最多 3 列）。</div>
          </div>
        </Modal>
      ) : null}

      {filterOpen ? (
        <Modal
          title="筛选构建器"
          onClose={() => setFilterOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConditions([{ column: columns[0]?.name ?? '', op: '=', value: '', connector: 'AND' }])}>重置</button>
              <button className="btn" onClick={() => setFilterOpen(false)}>{t('cancel')}</button>
              <button className="btn primary" onClick={applyFilterBuilder} data-testid="filter-apply">应用筛选</button>
            </>
          }
        >
          <div className="col gap-8">
            {conditions.map((condition, index) => (
              <div key={index} className="filter-rule">
                {index === 0 ? (
                  <span className="filter-kw">WHERE</span>
                ) : (
                  <select
                    className="select"
                    value={condition.connector}
                    onChange={(e) => setConditions((prev) => prev.map((item, i) => (i === index ? { ...item, connector: e.target.value as 'AND' | 'OR' } : item)))}
                  >
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>
                )}
                <select
                  className="select"
                  value={condition.column}
                  onChange={(e) => setConditions((prev) => prev.map((item, i) => (i === index ? { ...item, column: e.target.value } : item)))}
                >
                  <option value="">选择列</option>
                  {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                </select>
                <select
                  className="select"
                  value={condition.op}
                  onChange={(e) => setConditions((prev) => prev.map((item, i) => (i === index ? { ...item, op: e.target.value } : item)))}
                >
                  {['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE', 'IN', 'IS NULL', 'IS NOT NULL'].map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
                <input
                  className="input mono"
                  placeholder={condition.op === 'IN' ? 'a, b, c' : condition.op.includes('NULL') ? '—' : '值'}
                  value={condition.value}
                  disabled={condition.op.includes('NULL')}
                  onChange={(e) => setConditions((prev) => prev.map((item, i) => (i === index ? { ...item, value: e.target.value } : item)))}
                />
                <button className="icon-btn" title="移除条件" onClick={() => setConditions((prev) => prev.filter((_, i) => i !== index))}>
                  <X size={12} />
                </button>
              </div>
            ))}
            <button
              className="btn small"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setConditions((prev) => [...prev, { column: columns[0]?.name ?? '', op: '=', value: '', connector: 'AND' }])}
            >
              <Plus size={12} /> 添加条件
            </button>
          </div>
        </Modal>
      ) : null}

      {replaceOpen ? (
        <Modal
          title={`查找替换 · ${tab.table}`}
          onClose={() => { setReplaceOpen(false); setReplacePreview(null); }}
          footer={
            <>
              <button className="btn" onClick={() => { setReplaceOpen(false); setReplacePreview(null); }}>{t('cancel')}</button>
              <button className="btn" onClick={() => void runReplace(true)} disabled={replaceBusy} data-testid="replace-preview">预览匹配</button>
              <button className="btn primary" onClick={() => void runReplace(false)} disabled={replaceBusy} data-testid="replace-apply">替换</button>
            </>
          }
        >
          <div className="col gap-10">
            <div className="row gap-8">
              <select
                className="select"
                value={replaceDraft.column}
                onChange={(e) => { setReplaceDraft({ ...replaceDraft, column: e.target.value }); setReplacePreview(null); }}
              >
                {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
              </select>
              <input
                className="input mono"
                placeholder="查找内容"
                value={replaceDraft.find}
                onChange={(e) => { setReplaceDraft({ ...replaceDraft, find: e.target.value }); setReplacePreview(null); }}
                data-testid="replace-find"
              />
              <input
                className="input mono"
                placeholder="替换为"
                value={replaceDraft.replace}
                onChange={(e) => setReplaceDraft({ ...replaceDraft, replace: e.target.value })}
                data-testid="replace-with"
              />
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={replaceDraft.scoped} onChange={(e) => setReplaceDraft({ ...replaceDraft, scoped: e.target.checked })} /> 仅作用于当前筛选条件
            </label>
            <p className="hint" style={{ margin: 0 }}>按文本匹配；建议先预览匹配行数，再执行替换。</p>
            {replacePreview !== null ? <div className="badge write">当前条件匹配 {replacePreview} 行</div> : null}
          </div>
        </Modal>
      ) : null}

      {pasteOpen ? (
        <Modal
          title="粘贴行（TSV）"
          onClose={() => setPasteOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setPasteOpen(false)}>{t('cancel')}</button>
              <button
                className="btn"
                onClick={async () => {
                  try {
                    setPasteText(await navigator.clipboard.readText());
                  } catch {
                    notify('warning', '无法读取剪贴板，请手动粘贴');
                  }
                }}
              >
                从剪贴板读取
              </button>
              <button className="btn primary" onClick={() => void confirmPaste()} data-testid="paste-confirm">插入数据</button>
            </>
          }
        >
          <div className="col gap-10">
            <p className="hint" style={{ margin: 0 }}>
              支持从 Excel / Navicat 复制的制表符分隔文本；首行若为列名会自动映射，否则按列顺序写入。
            </p>
            <textarea
              className="input mono"
              style={{ minHeight: 180, resize: 'vertical' }}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'id\tname\n1\tAlpha\n2\tBeta'}
              data-testid="paste-text"
            />
          </div>
        </Modal>
      ) : null}
      {lineOpen && conn ? (
        <LineProtocolPanel
          connection={conn}
          database={tab.database}
          onDone={() => setRefreshKey((k) => k + 1)}
          onClose={() => setLineOpen(false)}
        />
      ) : null}
    </div>
  );
}
