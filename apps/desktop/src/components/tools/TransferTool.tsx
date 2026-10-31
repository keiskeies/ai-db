import { useEffect, useReducer, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleSlash,
  Copy,
  Loader2,
  Square,
  Table2,
} from 'lucide-react';
import { api, streamTransfer, type TransferEvent, type TransferPhase } from '../../lib/api';
import { useApp } from '../../store';
import { DatabaseSelect } from '../DatabaseSelect';

const PHASE_LABEL: Record<TransferPhase, string> = {
  create: '创建目标表',
  read: '读取源表',
  truncate: '清空目标表',
  write: '写入数据',
};

const RUN_LABEL = {
  running: '传输中',
  done: '已完成',
  partial: '部分失败',
  canceled: '已取消',
  failed: '传输中断',
} as const;

interface PhaseLog {
  phase: TransferPhase;
  state: 'running' | 'done' | 'error' | 'canceled';
  durationMs?: number;
  rows?: number;
  columns?: number;
  skippedColumns?: number;
  batches?: number;
  limitReached?: boolean;
  ddl?: string;
}

interface TableRun {
  name: string;
  status: 'pending' | 'running' | 'ok' | 'error' | 'canceled' | 'skipped';
  phase?: TransferPhase;
  phases: PhaseLog[];
  rows: number;
  totalRows?: number;
  startedAt?: number;
  created?: boolean;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
  columns?: number;
  skippedColumns?: number;
  batches?: number;
  limitReached?: boolean;
}

interface TransferRun {
  status: 'running' | 'done' | 'partial' | 'canceled' | 'failed';
  mode: 'append' | 'replace';
  tables: TableRun[];
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  source: string;
  target: string;
  error?: string;
}

type RunAction =
  | { type: 'start'; tables: string[]; mode: 'append' | 'replace'; source: string; target: string }
  | { type: 'event'; event: TransferEvent }
  | { type: 'canceled' }
  | { type: 'failed'; message: string };

function updateTable(state: TransferRun, name: string, fn: (table: TableRun) => TableRun): TransferRun {
  return { ...state, tables: state.tables.map((table) => (table.name === name ? fn(table) : table)) };
}

function reducer(state: TransferRun | null, action: RunAction): TransferRun | null {
  if (action.type === 'start') {
    return {
      status: 'running',
      mode: action.mode,
      startedAt: Date.now(),
      source: action.source,
      target: action.target,
      tables: action.tables.map((name) => ({ name, status: 'pending', phases: [], rows: 0 })),
    };
  }
  if (!state) return state;
  if (action.type === 'canceled') {
    return {
      ...state,
      status: 'canceled',
      finishedAt: Date.now(),
      tables: state.tables.map((table) => {
        if (table.status === 'running') {
          return { ...table, status: 'canceled', phases: table.phases.map((phase) => (phase.state === 'running' ? { ...phase, state: 'canceled' } : phase)) };
        }
        if (table.status === 'pending') return { ...table, status: 'skipped' };
        return table;
      }),
    };
  }
  if (action.type === 'failed') {
    return {
      ...state,
      status: 'failed',
      error: action.message,
      finishedAt: Date.now(),
      tables: state.tables.map((table) => {
        if (table.status === 'running') {
          return {
            ...table,
            status: 'error',
            error: action.message,
            phases: table.phases.map((phase) => (phase.state === 'running' ? { ...phase, state: 'error' } : phase)),
          };
        }
        if (table.status === 'pending') return { ...table, status: 'skipped' };
        return table;
      }),
    };
  }
  const event = action.event;
  switch (event.type) {
    case 'start':
      return { ...state, mode: event.mode };
    case 'table-start':
      return updateTable(state, event.table, (table) => ({
        ...table,
        status: 'running',
        phase: undefined,
        rows: 0,
        totalRows: undefined,
        startedAt: Date.now(),
      }));
    case 'phase-start':
      return updateTable(state, event.table, (table) => ({
        ...table,
        phase: event.phase,
        phases: [...table.phases, { phase: event.phase, state: 'running' }],
      }));
    case 'phase-done':
      return updateTable(state, event.table, (table) => ({
        ...table,
        phase: event.phase,
        rows: event.phase === 'write' && event.rows != null ? event.rows : table.rows,
        totalRows: event.phase === 'read' && event.rows != null ? event.rows : table.totalRows,
        created: table.created || event.phase === 'create',
        truncated: table.truncated || event.phase === 'truncate',
        limitReached: table.limitReached || Boolean(event.limitReached),
        phases: table.phases.map((phase) =>
          phase.phase === event.phase && phase.state === 'running'
            ? {
                ...phase,
                state: 'done',
                durationMs: event.durationMs,
                rows: event.rows,
                columns: event.columns,
                skippedColumns: event.skippedColumns,
                batches: event.batches,
                limitReached: event.limitReached,
                ddl: event.ddl,
              }
            : phase,
        ),
      }));
    case 'progress':
      return updateTable(state, event.table, (table) => ({ ...table, rows: event.rows, totalRows: event.totalRows }));
    case 'table-done':
      return updateTable(state, event.table, (table) => ({
        ...table,
        status: 'ok',
        phase: undefined,
        rows: event.result.rows,
        created: event.result.created,
        truncated: event.result.truncated,
        durationMs: event.durationMs,
        columns: event.columns,
        skippedColumns: event.skippedColumns,
        batches: event.batches,
        limitReached: event.limitReached,
        phases: table.phases.map((phase) => (phase.state === 'running' ? { ...phase, state: 'done' } : phase)),
      }));
    case 'table-error':
      return updateTable(state, event.table, (table) => ({
        ...table,
        status: 'error',
        phase: undefined,
        rows: event.rows,
        error: event.error,
        durationMs: event.durationMs,
        phases: table.phases.map((phase) => (phase.state === 'running' ? { ...phase, state: 'error' } : phase)),
      }));
    case 'done':
      return {
        ...state,
        status: event.result.results.some((item) => item.status === 'error') ? 'partial' : 'done',
        finishedAt: Date.now(),
        durationMs: event.durationMs,
      };
    case 'error':
      return {
        ...state,
        status: 'failed',
        error: event.message,
        finishedAt: Date.now(),
        tables: state.tables.map((table) => {
          if (table.status === 'running') {
            return {
              ...table,
              status: 'error',
              error: event.message,
              phases: table.phases.map((phase) => (phase.state === 'running' ? { ...phase, state: 'error' } : phase)),
            };
          }
          if (table.status === 'pending') return { ...table, status: 'skipped' };
          return table;
        }),
      };
    default:
      return state;
  }
}

function fmtRows(value: number): string {
  return value.toLocaleString();
}

function shortDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 1000).toFixed(0)}s`;
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function phaseMeta(phase: PhaseLog): string {
  const parts: string[] = [];
  if (phase.phase === 'read' && phase.rows != null) parts.push(`${fmtRows(phase.rows)} 行`);
  if (phase.phase === 'create' && phase.columns != null) parts.push(`${phase.columns} 列`);
  if (phase.phase === 'write') {
    if (phase.rows != null) parts.push(`${fmtRows(phase.rows)} 行`);
    if (phase.batches != null) parts.push(`${phase.batches} 批`);
  }
  if (phase.durationMs != null) parts.push(shortDuration(phase.durationMs));
  return parts.join(' · ');
}

function livePhase(table: TableRun): string {
  if (table.status === 'pending') return '等待';
  if (table.status === 'skipped') return '未执行';
  if (table.status === 'canceled') return table.rows ? `已取消 · ${fmtRows(table.rows)} 行` : '已取消';
  if (table.status === 'error') return '失败';
  if (table.status === 'ok') return `${fmtRows(table.rows)} 行${table.durationMs != null ? ` · ${shortDuration(table.durationMs)}` : ''}`;
  const label = table.phase ? PHASE_LABEL[table.phase] : '准备中';
  if (table.phase === 'write' && table.totalRows) return `${label} ${fmtRows(table.rows)}/${fmtRows(table.totalRows)}`;
  return label;
}

function clockTime(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildLog(run: TransferRun): string {
  const lines: string[] = [];
  const rows = run.tables.reduce((sum, table) => sum + table.rows, 0);
  const ok = run.tables.filter((table) => table.status === 'ok').length;
  const failed = run.tables.filter((table) => table.status === 'error').length;
  const canceled = run.tables.filter((table) => table.status === 'canceled').length;
  const skipped = run.tables.filter((table) => table.status === 'skipped').length;
  const elapsed = run.durationMs ?? ((run.finishedAt ?? Date.now()) - run.startedAt);
  lines.push(`AI DB 数据传输 · ${new Date(run.startedAt).toLocaleString()}`);
  lines.push(`${run.source} → ${run.target} · ${run.mode === 'replace' ? '清空后写入' : '追加写入'}`);
  lines.push('');
  for (const table of run.tables) {
    if (table.status === 'pending') continue;
    const stamp = table.startedAt ? `[${clockTime(table.startedAt)}] ` : '';
    if (table.status === 'skipped') {
      lines.push(`${stamp}${table.name} · 未执行`);
      continue;
    }
    const flags = [table.created ? '新建' : '', table.truncated ? '清空' : ''].filter(Boolean).join(' · ');
    if (table.status === 'running') lines.push(`${stamp}${table.name} · 进行中 · ${livePhase(table)}`);
    else if (table.status === 'canceled') lines.push(`${stamp}${table.name} · 已取消 · 已写入 ${fmtRows(table.rows)} 行`);
    else if (table.status === 'error') lines.push(`${stamp}${table.name} · 失败${table.rows ? ` · 已写入 ${fmtRows(table.rows)} 行` : ''} · ${table.error ?? '未知错误'}`);
    else lines.push(`${stamp}${table.name} · ${fmtRows(table.rows)} 行${flags ? ` · ${flags}` : ''}${table.durationMs != null ? ` · ${shortDuration(table.durationMs)}` : ''}`);
    for (const phase of table.phases) {
      if (phase.state === 'running') continue;
      lines.push(
        `  - ${PHASE_LABEL[phase.phase]} · ${phase.state === 'error' ? '失败' : phase.state === 'canceled' ? '已取消' : phaseMeta(phase)}`,
      );
    }
    if (table.skippedColumns) lines.push(`  - 列映射：${table.skippedColumns} 列在目标表不存在，已跳过`);
    if (table.limitReached) lines.push('  - 注意：达到单表 100,000 行上限，可能未完整复制');
  }
  lines.push('');
  lines.push(
    `汇总：${RUN_LABEL[run.status]} · 成功 ${ok} · 失败 ${failed}${canceled ? ` · 取消 ${canceled}` : ''}${skipped ? ` · 未执行 ${skipped}` : ''} · ${fmtRows(rows)} 行 · 用时 ${clock(elapsed)}`,
  );
  if (run.error) lines.push(`错误：${run.error}`);
  return lines.join('\n');
}

export function TransferTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const [sourceId, setSourceId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [targetId, setTargetId] = useState(connections.find((c) => c.id !== activeConnectionId)?.id ?? connections[0]?.id ?? '');
  const [sourceDb, setSourceDb] = useState('');
  const [targetDb, setTargetDb] = useState('');
  const [tables, setTables] = useState<Array<{ name: string; columns?: number; rows?: number }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [run, dispatch] = useReducer(reducer, null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const controllerRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    api
      .getTables(sourceId, sourceDb || undefined)
      .then((result) => {
        const list = result.tables
          .filter((table) => table.type === 'table')
          .map((table) => ({ name: table.name, columns: table.columns?.length ?? 0, rows: table.rowEstimate }));
        setTables(list);
        setSelected(new Set(list.slice(0, 3).map((table) => table.name)));
      })
      .catch(() => setTables([]));
  }, [sourceId, sourceDb]);

  useEffect(() => {
    if (run?.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [run?.status]);

  const currentIndex = run ? run.tables.findIndex((table) => table.status === 'running') : -1;
  useEffect(() => {
    if (currentIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-xfer-index="${currentIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [currentIndex]);

  const label = (id: string, database: string) => {
    const connection = connections.find((c) => c.id === id);
    return `${connection?.name ?? id}${database ? ` / ${database}` : ''}`;
  };
  const targetReadonly = connections.find((c) => c.id === targetId)?.readonly === true;
  const estimatedRows = tables.reduce((sum, table) => sum + (selected.has(table.name) && table.rows != null ? table.rows : 0), 0);
  const hasEstimate = tables.some((table) => selected.has(table.name) && table.rows != null);

  const startTransfer = async () => {
    if (!sourceId || !targetId || !selected.size || targetReadonly) return;
    if (sourceId === targetId && sourceDb === targetDb && mode === 'replace') {
      if (!window.confirm('源与目标是同一库，替换模式会清空目标表后再从自身复制。继续？')) return;
    }
    const names = tables.filter((table) => selected.has(table.name)).map((table) => table.name);
    const controller = new AbortController();
    controllerRef.current = controller;
    setExpanded(new Set());
    setNow(Date.now());
    dispatch({
      type: 'start',
      tables: names,
      mode,
      source: label(sourceId, sourceDb),
      target: label(targetId, targetDb),
    });
    let done = false;
    let sawError = false;
    try {
      await streamTransfer(
        {
          sourceId,
          sourceDatabase: sourceDb || undefined,
          targetId,
          targetDatabase: targetDb || undefined,
          tables: names,
          mode,
          createMissing: true,
        },
        (event) => {
          dispatch({ type: 'event', event });
          if (event.type === 'done') {
            done = true;
            const failed = event.result.results.filter((item) => item.status === 'error').length;
            if (failed) notify('warning', '传输完成，但有失败', `${failed} 张表失败 · ${fmtRows(event.result.totalRows)} 行已写入`);
            else notify('success', '数据传输完成', `${fmtRows(event.result.totalRows)} 行`);
          }
          if (event.type === 'error') {
            sawError = true;
            notify('error', '数据传输中断', event.message);
          }
          if (event.type === 'table-error') {
            setExpanded((prev) => new Set(prev).add(event.table));
          }
        },
        controller.signal,
      );
      if (!done && !sawError && !controller.signal.aborted) {
        dispatch({ type: 'failed', message: '连接已中断，传输结果可能不完整' });
      }
    } catch (err: any) {
      if (controller.signal.aborted && !done) {
        dispatch({ type: 'canceled' });
        notify('warning', '已取消数据传输', '已写入的数据保留，未执行的表不再开始');
      } else if (!done) {
        dispatch({ type: 'failed', message: err?.message ?? '数据传输失败' });
        notify('error', '数据传输失败', err?.message);
      }
    } finally {
      controllerRef.current = null;
      await loadSchema(targetId, true, targetDb || undefined);
    }
  };

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const copyLog = async () => {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(buildLog(run));
      notify('success', '过程日志已复制', `${run.tables.length} 张表`);
    } catch (err: any) {
      notify('error', '复制失败', err?.message);
    }
  };

  const total = run?.tables.length ?? 0;
  const okCount = run?.tables.filter((table) => table.status === 'ok').length ?? 0;
  const failedCount = run?.tables.filter((table) => table.status === 'error').length ?? 0;
  const canceledCount = run?.tables.filter((table) => table.status === 'canceled').length ?? 0;
  const skippedCount = run?.tables.filter((table) => table.status === 'skipped').length ?? 0;
  const completed = okCount + failedCount;
  const writtenRows = run?.tables.reduce((sum, table) => sum + table.rows, 0) ?? 0;
  const createdCount = run?.tables.filter((table) => table.created).length ?? 0;
  const current = run && currentIndex >= 0 ? run.tables[currentIndex] : undefined;
  const currentFraction = current?.totalRows ? Math.min(1, current.rows / current.totalRows) : 0;
  const canceledFraction =
    run?.tables.reduce(
      (sum, table) => sum + (table.status === 'canceled' && table.totalRows ? Math.min(1, table.rows / table.totalRows) : 0),
      0,
    ) ?? 0;
  const percent = total ? Math.min(100, Math.round(((completed + currentFraction + canceledFraction) / total) * 100)) : 0;
  const elapsedMs = run ? (run.durationMs ?? ((run.finishedAt ?? now) - run.startedAt)) : 0;
  const running = run?.status === 'running';
  const statusTone = run?.status === 'partial' ? 'warning' : run?.status === 'failed' ? 'failed' : run?.status ?? '';

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Table2 size={15} /> 数据传输
        <span className="muted">跨连接复制表结构与数据，目标缺失表自动创建</span>
      </div>
      <div className="tool-row" style={{ flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 240 }}>
          <label>源连接 / 数据库</label>
          <div className="row gap-6">
            <select className="select" style={{ flex: 1 }} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name} · {conn.engine}</option>)}
            </select>
            <DatabaseSelect connectionId={sourceId} value={sourceDb} onChange={setSourceDb} testId="transfer-source-db" />
          </div>
        </div>
        <ArrowRight size={15} className="muted" style={{ alignSelf: 'flex-end', marginBottom: 6 }} />
        <div className="field" style={{ flex: 1, minWidth: 240 }}>
          <label>目标连接 / 数据库</label>
          <div className="row gap-6">
            <select className="select" style={{ flex: 1 }} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name} · {conn.engine}{conn.readonly ? '（只读）' : ''}</option>)}
            </select>
            <DatabaseSelect connectionId={targetId} value={targetDb} onChange={setTargetDb} testId="transfer-target-db" />
          </div>
        </div>
        <div className="field" style={{ width: 140 }}>
          <label>写入模式</label>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'append' | 'replace')}>
            <option value="append">追加</option>
            <option value="replace">清空后写入</option>
          </select>
        </div>
      </div>

      <div className="transfer-grid">
        <div className="panel">
          <div className="panel-head">
            源表 <span className="badge">{selected.size}/{tables.length}</span>
            <div className="spacer" />
            <button className="btn ghost small" onClick={() => setSelected(new Set(tables.map((table) => table.name)))}>全选</button>
            <button className="btn ghost small" onClick={() => setSelected(new Set())}>清空</button>
          </div>
          <div className="transfer-list">
            {tables.map((table) => (
              <label key={table.name} className="transfer-row">
                <input
                  type="checkbox"
                  checked={selected.has(table.name)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(table.name);
                    else next.delete(table.name);
                    setSelected(next);
                  }}
                />
                <span className="mono">{table.name}</span>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 10, whiteSpace: 'nowrap' }}>
                  {table.rows != null ? `≈${fmtRows(table.rows)} 行 · ` : ''}{table.columns ?? 0} 列
                </span>
              </label>
            ))}
            {!tables.length ? <div className="dash-empty">源连接没有表。</div> : null}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            结果
            <div className="spacer" />
            {run ? (
              <button className="icon-btn" title="复制过程日志" aria-label="复制过程日志" data-testid="transfer-copy-log" onClick={() => void copyLog()}>
                <Copy size={13} />
              </button>
            ) : null}
            {running ? (
              <button className="btn ghost small" data-testid="transfer-cancel" onClick={() => controllerRef.current?.abort()}>
                <Square size={10} /> 取消
              </button>
            ) : null}
            <button
              className="btn primary small"
              data-testid="transfer-start"
              onClick={() => void startTransfer()}
              disabled={running || !selected.size || targetReadonly}
            >
              {running ? <Loader2 size={12} className="spin" /> : <ArrowRight size={12} />}
              {running ? '传输中' : '开始传输'}
            </button>
          </div>
          {run ? (
            <div className={`xfer-summary ${statusTone}`} data-testid="transfer-summary">
              <div className="xfer-summary-top">
                <span className={`xfer-state ${statusTone}`}>
                  {run.status === 'running' ? <Loader2 size={12} className="spin" /> : null}
                  {run.status === 'done' ? <CheckCircle2 size={12} /> : null}
                  {run.status === 'partial' || run.status === 'failed' ? <AlertCircle size={12} /> : null}
                  {run.status === 'canceled' ? <CircleSlash size={12} /> : null}
                  {RUN_LABEL[run.status]}
                </span>
                <span className="xfer-percent">{percent}%</span>
                <span className="xfer-clock">{clock(elapsedMs)}</span>
              </div>
              <div
                className={`xfer-bar${run.tables.length > 80 ? ' dense' : ''}`}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label="传输进度"
              >
                {run.tables.map((table) => {
                  const fraction =
                    (table.status === 'running' || table.status === 'canceled') && table.totalRows
                      ? Math.min(1, table.rows / table.totalRows)
                      : 0;
                  return (
                    <span key={table.name} className={`xfer-seg ${table.status}`} title={`${table.name} · ${livePhase(table)}`}>
                      <i style={{ width: `${Math.round(fraction * 100)}%` }} />
                    </span>
                  );
                })}
              </div>
              <div className="xfer-stats">
                <span><b>{completed}</b>/{total} 表</span>
                <span><b>{fmtRows(writtenRows)}</b> 行</span>
                {createdCount ? <span><b>{createdCount}</b> 新建</span> : null}
                {failedCount ? <span className="is-danger"><b>{failedCount}</b> 失败</span> : null}
                {canceledCount ? <span><b>{canceledCount}</b> 取消</span> : null}
                {skippedCount ? <span><b>{skippedCount}</b> 未执行</span> : null}
              </div>
              <div className="xfer-route" title={`${run.source} → ${run.target}`}>
                {run.source} → {run.target} · {run.mode === 'replace' ? '清空后写入' : '追加写入'}
              </div>
              {run.status === 'failed' && run.error ? <div className="xfer-error">{run.error}</div> : null}
            </div>
          ) : (
            <div className="xfer-plan">
              <div className="xfer-plan-route">
                <span className="mono">{label(sourceId, sourceDb)}</span>
                <ArrowRight size={11} className="muted" />
                <span className="mono">{label(targetId, targetDb)}</span>
              </div>
              <div className="xfer-plan-meta">
                <span className="badge">{selected.size} 张表</span>
                <span className="badge ddl">{mode === 'replace' ? '清空后写入' : '追加写入'}</span>
                <span className="muted">目标缺失表自动创建</span>
              </div>
              {hasEstimate ? <div className="xfer-plan-hint">源表估算约 {fmtRows(estimatedRows)} 行</div> : null}
              {targetReadonly ? <div className="xfer-note warn">目标连接为只读，无法写入</div> : null}
              <div className="xfer-plan-hint">开始后这里会实时显示每张表的建表、读取、清空与写入进度，以及逐阶段耗时。</div>
            </div>
          )}
          <div className="xfer-list" ref={listRef}>
            {run?.tables.map((table, index) => {
              const open = expanded.has(table.name);
              const ddl = table.phases.find((phase) => phase.ddl)?.ddl;
              const canExpand = table.phases.length > 0 || Boolean(table.error) || Boolean(table.limitReached) || Boolean(table.skippedColumns);
              return (
                <div key={table.name} className="xfer-item">
                  <button
                    type="button"
                    data-xfer-index={index}
                    className={`xfer-row ${table.status}${canExpand ? ' expandable' : ''}${open ? ' expanded' : ''}`}
                    aria-expanded={canExpand ? open : undefined}
                    title={table.error ?? table.name}
                    onClick={canExpand ? () => toggle(table.name) : undefined}
                  >
                    <span className={`xfer-row-icon ${table.status}`}>
                      {table.status === 'running' ? <Loader2 size={12} className="spin" /> : null}
                      {table.status === 'ok' ? <CheckCircle2 size={12} /> : null}
                      {table.status === 'error' ? <AlertCircle size={12} /> : null}
                      {table.status === 'canceled' ? <CircleSlash size={12} /> : null}
                      {table.status === 'pending' || table.status === 'skipped' ? <Circle size={10} /> : null}
                    </span>
                    <span className="xfer-row-main">
                      <span className="mono xfer-table">{table.name}</span>
                      {table.created ? <span className="badge ddl">新建</span> : table.truncated ? <span className="badge write">清空</span> : null}
                      {table.limitReached && table.status === 'ok' ? <span className="badge destructive" title="达到单表 100,000 行上限">上限</span> : null}
                    </span>
                    <span className={`xfer-row-side${table.status === 'error' ? ' is-danger' : ''}`}>{livePhase(table)}</span>
                    <span className="xfer-chev">{canExpand ? <ChevronRight size={11} className={open ? 'xfer-chev-open' : ''} /> : null}</span>
                  </button>
                  {open && canExpand ? (
                    <div className="xfer-detail">
                      {table.phases.map((phase, phaseIndex) => (
                        <div key={`${phase.phase}-${phaseIndex}`} className={`xfer-phase ${phase.state}`}>
                          <span className="xfer-dot" />
                          <span>{PHASE_LABEL[phase.phase]}</span>
                          <span className="xfer-phase-meta">
                            {phase.state === 'running' ? '进行中' : phase.state === 'error' ? '失败' : phase.state === 'canceled' ? '已取消' : phaseMeta(phase)}
                          </span>
                        </div>
                      ))}
                      {table.skippedColumns ? (
                        <div className="xfer-note">
                          列映射：{table.columns ?? 0} 列写入，{table.skippedColumns} 列在目标表不存在，已跳过
                        </div>
                      ) : null}
                      {table.limitReached ? <div className="xfer-note warn">达到单表 100,000 行上限，源表可能还有未复制的数据</div> : null}
                      {table.error ? <div className="xfer-error">{table.error}</div> : null}
                      {ddl ? (
                        <details className="xfer-ddl">
                          <summary>建表语句</summary>
                          <pre>{ddl}</pre>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!run ? <div className="dash-empty">选择源表并开始传输。目标表不存在时会按目标方言创建；自增序列在跨库复制后可能需要重置。</div> : null}
            {run && !run.tables.length ? <div className="dash-empty">这次传输没有可用的表。</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
