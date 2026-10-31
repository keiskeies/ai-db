import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  AtSign,
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock,
  Copy,
  Database,
  Download,
  Expand,
  History,
  ImagePlus,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Minimize2,
  PanelRightClose,
  Pencil,
  Plus,
  Plug,
  Search,
  ShieldAlert,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Wand2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type { AgentMessageBlock, PermissionMode, QuestionSuggestion, Risk, TableInfo, ToolResult } from '@aidb/core';
import { COMMANDS, engineMeta, suggestionLabel } from '@aidb/core';
import { getModelProfile, supportsInput } from '@aidb/core';
import { api, attachmentObjectUrl, type StoredAttachment } from '../lib/api';
import { deliverExport } from '../lib/exportDelivery';
import { desktopBridge } from '../lib/desktop';
import { formatBytes, formatCell, formatDuration, formatRelative } from '../lib/format';
import { useApp, type LiveTool, type LiveTurn } from '../store';
import { ChartView, type ChartSpec } from './ChartView';
import { DatabaseSelect } from './DatabaseSelect';
import { CopyButton, Markdown, RiskBadge } from './ui';

const MODE_OPTIONS: Array<{ value: PermissionMode; zh: string; en: string }> = [
  { value: 'readonly', zh: '只读', en: 'Read-only' },
  { value: 'ask', zh: '询问', en: 'Ask' },
  { value: 'auto', zh: '自动', en: 'Auto' },
  { value: 'full', zh: '全自动', en: 'Full auto' },
];

/** 与 Bridge 每轮最多 4 张的限制保持一致。 */
const MAX_IMAGES = 4;

/** AI 回答里的图表统一高度：切换图表类型时卡片不跳动。 */
const CHART_BODY_HEIGHT = 300;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

type SlashOption = { key: string; label: string; kind: 'command' | 'preset'; commandId?: string };

const SLASH: Array<{ key: string; label: string; prompt: string | ((tables: TableInfo[]) => string) }> = [
  { key: '/init', label: '初始化库文档（生成 AI_DB.md）', prompt: '' },
  { key: '/schema', label: '梳理库结构', prompt: '生成当前库的结构摘要：主要表、关系、字段含义与可疑点。' },
  { key: '/audit', label: '数据库体检', prompt: '对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。' },
  { key: '/quality', label: '数据质量', prompt: (tables) => (tables[0] ? `检查 ${tables[0].name} 的空值、空串和重复主键，并给出排查 SQL。` : '检查当前表的空值、空串和重复主键，并给出排查 SQL。') },
  { key: '/chart', label: '画图分析', prompt: (tables) => {
      const target = tables.find((t) => (t.columns ?? []).some((c) => /(status|state|type|category|level)/i.test(c.name))) ?? tables[0];
      if (!target) return '按第一个分组列统计并画柱状图。';
      const dimension = (target.columns ?? []).find((c) => /(status|state|type|category|level)/i.test(c.name));
      return dimension
        ? `按 ${dimension.name} 统计 ${target.name} 的记录数并画柱状图。`
        : `统计 ${target.name} 近 12 个月的记录数趋势并画折线图。`;
    } },
  { key: '/explain', label: '解释执行计划', prompt: '解释最近一次查询的执行计划，指出瓶颈并给出优化建议。' },
  { key: '/optimize', label: '优化 SQL', prompt: '优化当前 SQL，并给出索引建议和改写后的语句。' },
  { key: '/backup', label: '备份数据库', prompt: '备份当前数据库。' },
  { key: '/memory', label: '打开记忆', prompt: '' },
  { key: '/clear', label: '清空上下文（新会话）', prompt: '' },
];

function statusIcon(status: LiveTool['status']) {
  if (status === 'running') return <Loader2 size={11} className="spin" style={{ animation: 'spin .8s linear infinite' }} />;
  if (status === 'ok') return <Check size={11} style={{ color: 'var(--success)' }} />;
  if (status === 'awaiting') return <Clock size={11} style={{ color: 'var(--warning)' }} />;
  return <X size={11} style={{ color: 'var(--danger)' }} />;
}

/** 工具名的中文短标签，只在状态条和授权提示里用。 */
const TOOL_LABELS: Record<string, string> = {
  run_sql: 'SQL 执行',
  run_mql: 'MongoDB 查询',
  run_redis: 'Redis 命令',
  run_cypher: 'Cypher 查询',
  run_cql: 'CQL 查询',
  run_aql: 'AQL 查询',
  inspect_schema: '查看表结构',
  search_objects: '搜索对象',
  sample_rows: '抽样数据',
  profile_column: '字段画像',
  create_table: '新建表',
  alter_table: '修改表结构',
  drop_object: '删除对象',
  manage_index: '索引调整',
  export_result: '导出结果',
  import_csv: '导入 CSV',
  backup_database: '数据库备份',
  audit_database: '数据库巡检',
  check_data_quality: '数据质量检查',
  generate_data: '生成测试数据',
  transfer_data: '数据迁移',
  render_chart: '绘制图表',
  analyze_chart: '统计分析',
  forecast_chart: '趋势预测',
  schema_diff: '结构对比',
  recon_data: '数据核对',
  memory_search: '检索记忆',
  memory_write: '写入记忆',
  skill_run: '运行技能',
  skill_worker_run: '技能进程',
  mcp_call: 'MCP 调用',
  mcp_list_tools: 'MCP 工具列表',
  update_plan: '更新计划',
};

function toolLabel(name?: string) {
  if (!name) return '操作';
  return TOOL_LABELS[name] ?? name;
}

/** 从 SQL 里粗略取表名，仅用于状态文案，不参与任何执行逻辑。 */
function sqlTable(sql: string): string | undefined {
  const match = /\b(?:from|join|into|update|table)\s+[`"[\]]?([\w.$-]+)/i.exec(sql);
  if (!match) return undefined;
  return match[1].replace(/[`"[\]]/g, '').split('.').pop();
}

type ActivityTone = 'think' | 'tool' | 'answer' | 'wait';
interface ActivityState {
  icon: ReactNode;
  label: string;
  tone: ActivityTone;
}

function describeTool(tool: LiveTool): ActivityState {
  const args = (tool.args ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const sql = text(args.sql);
  const table = text(args.table) ?? (sql ? sqlTable(sql) : undefined);
  const collection = text(args.collection);
  const mention = (label: string, icon: ReactNode = <Wrench size={11} />): ActivityState => ({ icon, label, tone: 'tool' });

  switch (tool.tool) {
    case 'run_sql': {
      const verb = sql?.trim().split(/\s+/)[0]?.toLowerCase();
      if (!verb) return mention('正在准备 SQL');
      if (['select', 'with', 'show', 'describe', 'desc', 'explain'].includes(verb)) {
        return mention(table ? `正在查询 ${table} 的数据` : '正在执行查询', <Search size={11} />);
      }
      if (['insert', 'update', 'delete', 'merge', 'replace'].includes(verb)) {
        return mention(table ? `正在更新 ${table} 的数据` : '正在写入数据');
      }
      if (['create', 'alter', 'drop', 'truncate', 'rename'].includes(verb)) {
        return mention(table ? `正在调整 ${table} 的结构` : '正在调整数据库结构');
      }
      return mention('正在执行 SQL', <Search size={11} />);
    }
    case 'run_mql':
      return mention(collection ? `正在查询集合 ${collection}` : '正在执行 MongoDB 查询', <Search size={11} />);
    case 'run_redis':
      return mention('正在执行 Redis 命令', <Search size={11} />);
    case 'inspect_schema':
      return mention(table ? `正在查看 ${table} 的表结构` : '正在查看数据库结构', <Database size={11} />);
    case 'search_objects':
      return mention(text(args.query) ? `正在搜索「${text(args.query)}」` : '正在搜索数据库对象', <Search size={11} />);
    case 'sample_rows':
      return mention(table ? `正在抽取 ${table} 的样例数据` : '正在抽样查看数据', <Database size={11} />);
    case 'profile_column':
      return mention(table && text(args.column) ? `正在分析 ${table}.${text(args.column)} 的分布` : '正在分析字段分布', <Search size={11} />);
    case 'explain_sql':
      return mention('正在解读执行计划', <Search size={11} />);
    case 'render_chart':
      return {
        icon: <BarChart3 size={11} />,
        label: text(args.title) ? `正在绘制「${text(args.title)}」图表` : '正在绘制图表',
        tone: 'tool',
      };
    case 'analyze_chart':
      return mention('正在计算统计指标', <BarChart3 size={11} />);
    case 'forecast_chart':
      return mention('正在预测趋势走向', <BarChart3 size={11} />);
    case 'audit_database':
      return mention('正在巡检数据库健康度', <ShieldAlert size={11} />);
    case 'check_data_quality':
      return mention(table ? `正在检查 ${table} 的数据质量` : '正在检查数据质量', <ShieldAlert size={11} />);
    case 'backup_database':
      return mention('正在备份数据库');
    case 'export_result':
      return mention('正在导出查询结果', <Download size={11} />);
    case 'import_csv':
      return mention(table ? `正在导入 ${table} 的数据` : '正在导入数据');
    case 'transfer_data':
      return mention('正在迁移数据');
    case 'memory_search':
      return mention('正在检索相关记忆', <Brain size={11} />);
    case 'memory_write':
      return mention('正在记录长期记忆', <Brain size={11} />);
    case 'skill_run':
    case 'skill_worker_run':
      return mention(text(args.skill) ? `正在运行技能 ${text(args.skill)}` : '正在运行技能', <Zap size={11} />);
    case 'mcp_list_tools':
    case 'mcp_call':
      return mention(text(args.server) ? `正在调用 MCP · ${text(args.server)}` : '正在调用 MCP 工具', <Zap size={11} />);
    case 'update_plan':
      return mention('正在调整执行计划');
    case 'begin_transaction':
    case 'commit_transaction':
    case 'rollback_transaction':
      return mention('正在处理事务');
    case 'generate_data':
      return mention('正在生成测试数据');
    case 'schema_diff':
      return mention('正在对比数据库结构');
    case 'recon_data':
      return mention('正在核对数据一致性');
    case 'list_connections':
      return mention('正在读取连接信息');
    case 'get_query_history':
      return mention('正在查看查询历史');
    case 'create_table':
      return mention('正在创建数据表');
    case 'alter_table':
      return mention(table ? `正在修改 ${table} 的表结构` : '正在修改表结构');
    case 'drop_object':
      return mention('正在删除数据库对象');
    case 'manage_index':
      return mention(table ? `正在调整 ${table} 的索引` : '正在调整索引');
    case 'vector_search':
      return mention('正在执行向量检索');
    case 'search_index':
      return mention('正在检索索引');
    case 'upsert_document':
    case 'delete_documents':
    case 'import_documents':
      return mention('正在写入文档数据');
    default:
      return mention(`正在执行 ${toolLabel(tool.tool)}`);
  }
}

/** 当前这一秒 AI 正在做什么：运行中工具优先，其次思考/写作阶段。 */
function agentActivity(live: LiveTurn): ActivityState {
  if (live.status === 'done') {
    return { icon: <Check size={11} />, label: '已完成，正在整理结果', tone: 'answer' };
  }
  if (live.status === 'awaiting') {
    const waiting = live.tools.find((tool) => tool.status === 'awaiting');
    return { icon: <ShieldAlert size={11} />, label: `等待你确认「${toolLabel(waiting?.tool)}」操作`, tone: 'wait' };
  }
  const running = [...live.tools].reverse().find((tool) => tool.status === 'running');
  if (running) return describeTool(running);
  if (live.text) {
    return {
      icon: <Sparkles size={11} />,
      label: live.tools.length ? '正在梳理查询结果，撰写回答' : '正在组织语言，撰写回答',
      tone: 'answer',
    };
  }
  if (live.thinking) {
    return {
      icon: <Brain size={11} />,
      label: live.tools.length ? '正在阅读执行结果，思考下一步' : '正在理解你的问题，梳理思路',
      tone: 'think',
    };
  }
  if (live.plan.length) return { icon: <ListChecks size={11} />, label: '正在拆解任务，规划步骤', tone: 'think' };
  if (live.tools.length) return { icon: <Sparkles size={11} />, label: '正在核对执行结果，准备下一步', tone: 'think' };
  return { icon: <Brain size={11} />, label: '正在理解你的问题', tone: 'think' };
}

function LiveActivity({ live }: { live: LiveTurn }) {
  const activity = agentActivity(live);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live.startedAt]);
  const seconds = Math.max(0, Math.floor((now - live.startedAt) / 1000));
  return (
    <div className={`agent-activity tone-${activity.tone}`} data-testid="agent-activity" role="status" aria-live="polite">
      <span className="activity-orb" aria-hidden="true">{activity.icon}</span>
      <span className="activity-label" key={activity.label}>{activity.label}</span>
      <span className="activity-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="spacer" />
      {seconds >= 1 ? <span className="activity-elapsed">{seconds}s</span> : null}
    </div>
  );
}

function MiniTable({ data, max = 8 }: { data: { columns?: Array<{ name: string } | string>; rows?: unknown[][] }; max?: number }) {
  if (!data?.columns || !Array.isArray(data.rows)) return null;
  const names = data.columns.map((c) => (typeof c === 'string' ? c : c.name));
  const rows = data.rows.slice(0, max);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tool-table">
        <thead>
          <tr>{names.map((n) => <th key={n}>{n}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j} title={formatCell(v).text}>{formatCell(v).text}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > max ? <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>… 共 {data.rows.length} 行</div> : null}
    </div>
  );
}

function ResultView({ result, onOpenEditor, showChart = true, chartHeight }: { result: ToolResult; onOpenEditor?: (sql: string) => void; showChart?: boolean; chartHeight?: number }) {
  const data = result.data as Record<string, any> | undefined;
  const sql = typeof data?.sql === 'string' ? data.sql : undefined;
  const chartData = data?.chart as ChartSpec | undefined;
  // 图表已经提到结论区时，执行步骤里不再重复渲染
  const chart = showChart ? chartData : undefined;
  const connectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const detail = data?.columns && Array.isArray(data?.rows) ? data : undefined;
  const chartSql = typeof data?.chartSql === 'string' ? data.chartSql : chart?.sql;
  // render_chart / forecast_chart 的返回值里本来就同时带 chart 与明细，早期用 !chart 把明细挡掉了
  const [tab, setTab] = useState<'chart' | 'rows' | 'sql'>('chart');
  const tabs: Array<'chart' | 'rows' | 'sql'> = [];
  if (chart) {
    tabs.push('chart');
    if (detail) tabs.push('rows');
    if (chartSql) tabs.push('sql');
  }
  const active = tabs.includes(tab) ? tab : 'chart';
  const exportCsv = async () => {
    if (!connectionId || !chartSql) return;
    try {
      const res = await api.exportData({ connectionId, sql: chartSql, format: 'csv' });
      await deliverExport(res.file, '已导出 CSV');
    } catch (err) {
      notify('error', '导出失败', (err as Error)?.message ?? String(err));
    }
  };
  return (
    <div>
      {/* 图表已提升到结论区，工具摘要和耗时留在执行过程里，不再压在图表上方 */}
      {!chart ? (
        <div className="tool-result-line">
          <span className={result.ok ? 'ok' : 'err'}>{result.ok ? '✓' : '✗'}</span>
          <span>{result.summary}</span>
          <span className="muted">· {formatDuration(result.meta.durationMs)}</span>
        </div>
      ) : null}
      {result.error ? (
        <div style={{ color: 'var(--danger)', marginTop: 6 }}>
          {result.error.message}
          {result.error.hint ? <div className="muted" style={{ marginTop: 3 }}>{result.error.hint}</div> : null}
        </div>
      ) : null}
      {sql ? (
        <div className="sql-block" style={{ marginTop: 7 }}>
          {sql}
          <span style={{ position: 'absolute', top: 4, right: 4 }}>
            <CopyButton text={sql} />
          </span>
        </div>
      ) : null}
      {sql && onOpenEditor ? (
        <button className="btn ghost small" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => onOpenEditor(sql)}>
          <ArrowUpRight size={11} /> 打开到编辑器
        </button>
      ) : null}
      {chart ? (
        <div style={{ marginTop: 8 }}>
          {tabs.length > 1 ? (
            <div className="chart-result-tabs" data-testid="chart-tabs">
              {tabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`chart-result-tab${active === id ? ' active' : ''}`}
                  data-testid={`chart-tab-${id}`}
                  onClick={() => setTab(id)}
                >
                  {id === 'chart' ? '图表' : id === 'rows' ? `明细 ${detail?.rows.length ?? 0}` : 'SQL'}
                </button>
              ))}
            </div>
          ) : null}
          {active === 'chart' ? (
            <ChartView
              chart={chart}
              onOpenEditor={onOpenEditor}
              height={chartHeight}
              enforceSuitability
              onExportCsv={chartSql && connectionId ? () => void exportCsv() : undefined}
            />
          ) : null}
          {active === 'rows' && detail ? <MiniTable data={detail} max={50} /> : null}
          {active === 'sql' && chartSql ? (
            <div className="sql-block">
              {chartSql}
              <span style={{ position: 'absolute', top: 4, right: 4 }}><CopyButton text={chartSql} /></span>
            </div>
          ) : null}
        </div>
      ) : null}
      {!chart && data?.ddl ? <div className="sql-block" style={{ marginTop: 7 }}>{data.ddl}</div> : null}
      {!chart && detail ? (
        <div style={{ marginTop: 7 }}>
          <MiniTable data={detail} />
        </div>
      ) : null}
      {!chart && !data?.columns && data?.tables ? (
        <div style={{ marginTop: 6 }}>
          {(data.tables as Array<{ name: string; columns?: unknown[] }>).slice(0, 30).map((tbl) => (
            <div key={tbl.name} className="mono" style={{ fontSize: 10.5 }}>
              {tbl.name} {tbl.columns?.length ? <span className="muted">· {tbl.columns.length} cols</span> : null}
            </div>
          ))}
          {(data.tables as unknown[]).length > 30 ? <div className="muted">…</div> : null}
        </div>
      ) : null}
      {data?.memories ? (
        <div style={{ marginTop: 6 }}>
          {(data.memories as Array<{ title: string; content: string; kind: string }>).slice(0, 6).map((m, i) => (
            <div key={i} style={{ fontSize: 10.5, marginTop: 3 }}>
              <span style={{ color: 'var(--agent)' }}>[{m.kind}]</span> {m.title} — <span className="muted">{m.content}</span>
            </div>
          ))}
        </div>
      ) : null}
      {data?.path ? <div className="mono" style={{ marginTop: 6, fontSize: 10.5, overflowWrap: 'anywhere' }}>{data.path}</div> : null}
      {data?.backupPath ? <div className="mono" style={{ marginTop: 6, fontSize: 10.5, overflowWrap: 'anywhere' }}>backup: {data.backupPath}</div> : null}
      {Array.isArray(data?.findings) && data.findings.length ? (
        <div className="findings">
          {data.findings.slice(0, 8).map((finding: any, index: number) => (
            <div key={index} className="finding">
              <div className="finding-head">
                <span className={`badge ${finding.severity === 'high' ? 'destructive' : finding.severity === 'medium' ? 'write' : finding.severity === 'low' ? 'ddl' : 'read'}`}>
                  {String(finding.severity).toUpperCase()}
                </span>
                <strong>{finding.title}</strong>
                {finding.table ? <span className="mono muted">{finding.table}</span> : null}
              </div>
              <div className="finding-detail">{finding.detail}</div>
              {finding.suggestedSql ? (
                <div className="sql-block finding-sql">
                  {finding.suggestedSql}
                  <span style={{ position: 'absolute', top: 4, right: 4 }}><CopyButton text={finding.suggestedSql} /></span>
                </div>
              ) : null}
              {finding.suggestedSql && onOpenEditor ? (
                <button className="btn ghost small" onClick={() => onOpenEditor(finding.suggestedSql)}>
                  <ArrowUpRight size={11} /> 打开到编辑器
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {!chart && Array.isArray(data?.columnStats) ? (
        <table className="tool-table stats-table">
          <thead>
            <tr><th>列</th><th>NULL</th><th>空串</th><th>不同值</th></tr>
          </thead>
          <tbody>
            {data.columnStats.slice(0, 12).map((stat: any) => (
              <tr key={stat.name}>
                <td>{stat.name}</td>
                <td>{stat.nulls} · {(Number(stat.nullRatio) * 100).toFixed(1)}%</td>
                <td>{stat.blanks ?? 0}</td>
                <td>{stat.distinct}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {data && !data.columns && !data.tables && !data.memories && !data.path && !data.ddl && !sql && !chart && !data.findings && !data.columnStats ? (
        <pre style={{ marginTop: 6, maxHeight: 160, overflow: 'auto' }}>{JSON.stringify(data, null, 2).slice(0, 2400)}</pre>
      ) : null}
    </div>
  );
}

function ToolCard({
  tool,
  args,
  risk,
  status,
  result,
  summary,
  live,
  onOpenEditor,
  chartMoved,
}: {
  tool: string;
  args: unknown;
  risk?: Risk;
  status: LiveTool['status'];
  result?: ToolResult;
  summary?: string;
  live?: boolean;
  onOpenEditor?: (sql: string) => void;
  chartMoved?: boolean;
}) {
  const artifact = result?.data as Record<string, any> | undefined;
  const hasArtifact = Boolean((artifact?.chart && !chartMoved) || (Array.isArray(artifact?.findings) && artifact.findings.length));
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const setMcpPathHint = useApp((s) => s.setMcpPathHint);
  const needsMcpRoot = result?.error?.code === 'MCP_FS_NO_ROOTS' || result?.error?.code === 'MCP_PATH_DENIED';
  const mcpArgs = args && typeof args === 'object' ? ((args as Record<string, unknown>).arguments as Record<string, unknown> | undefined) : undefined;
  const requestedPath = typeof mcpArgs?.path === 'string' ? mcpArgs.path : undefined;
  const suggestedRoot = requestedPath ? requestedPath.replace(/[\\/][^\\/]*$/, '') || requestedPath : undefined;
  const [open, setOpen] = useState(status === 'error' || status === 'awaiting' || hasArtifact);
  useEffect(() => {
    if (hasArtifact) setOpen(true);
  }, [hasArtifact]);
  const sqlArg = args && typeof args === 'object' ? (args as Record<string, unknown>).sql : undefined;
  return (
    <div className={`tool-card status-${status}`} data-testid="tool-card">
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        {statusIcon(status)}
        <span className="tool-name">{tool}</span>
        <span className="tool-summary">{summary ?? (typeof sqlArg === 'string' ? sqlArg.replace(/\s+/g, ' ').slice(0, 70) : '')}</span>
        <RiskBadge risk={risk} />
        {result ? <span className="muted" style={{ fontSize: 10 }}>{formatDuration(result.meta.durationMs)}</span> : null}
        {status === 'awaiting' ? <span className="badge write">等待授权</span> : null}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </div>
      {open ? (
        <div className="tool-body">
          <div className="tool-section-label">参数</div>
          {typeof sqlArg === 'string' ? <pre>{String(sqlArg)}</pre> : <pre>{JSON.stringify(args, null, 2).slice(0, 4000)}</pre>}
          {result ? (
            <>
              <div className="tool-section-label">结果</div>
              <ResultView result={result} onOpenEditor={onOpenEditor} showChart={!chartMoved} />
              {needsMcpRoot ? (
                <button
                  className="btn ghost small"
                  style={{ marginTop: 6, paddingLeft: 0 }}
                  onClick={() => {
                    setMcpPathHint(suggestedRoot);
                    setSettingsOpen(true, 'mcp');
                  }}
                >
                  <Plug size={11} /> 配置允许目录
                </button>
              ) : null}
            </>
          ) : (
            <div className="tool-section-label">{live ? '执行中…' : '无结果'}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PlanCard({ items, running }: { items: Array<{ id: string; text: string; status: string }>; running?: boolean }) {
  if (!items.length) return null;
  const done = items.filter((item) => item.status === 'done').length;
  const active = items.findIndex((item) => item.status === 'doing');
  return (
    <div className="plan-card" data-testid="plan-card">
      <div className="plan-title" data-testid="plan-progress">
        <Check size={11} /> 计划 · {done}/{items.length}
        {running && active >= 0 ? <span className="plan-stage">第 {active + 1} 步进行中</span> : null}
      </div>
      {items.map((item) => (
        <div key={item.id} className={`plan-item ${item.status}`}>
          <span className="plan-icon">{item.status === 'done' ? '✓' : ''}</span>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

function AssistantBlocks({ blocks, messageId }: { blocks: AgentMessageBlock[]; messageId: string }) {
  const openQuery = useApp((s) => s.openQuery);
  const results = new Map<string, ToolResult>();
  for (const block of blocks) if (block.type === 'tool_result' && block.callId) results.set(block.callId, block.result as ToolResult);
  const thinking = blocks.find((b) => b.type === 'thinking')?.text;
  // 模型每更新一次计划都会追加一个 plan block；只渲染最后一份，避免多张旧计划卡堆叠。
  const latestPlan = [...blocks].reverse().find((block) => block.type === 'plan');
  return (
    <>
      {thinking ? (
        <details className="thinking">
          <summary><Brain size={11} /> 思考过程</summary>
          <div className="thinking-body">{thinking}</div>
        </details>
      ) : null}
      {blocks.map((block, index) => {
        if (block.type === 'tool_call') {
          const result = block.callId ? results.get(block.callId) : undefined;
          const chartMoved = Boolean((result?.data as Record<string, any> | undefined)?.chart);
          return (
            <ToolCard
              key={`${messageId}_${block.callId ?? index}`}
              tool={block.tool ?? 'tool'}
              args={block.args}
              risk={block.risk}
              status={result ? (result.ok ? 'ok' : 'error') : 'error'}
              result={result}
              chartMoved={chartMoved}
              onOpenEditor={(sql) => openQuery(undefined, sql)}
            />
          );
        }
        if (block.type === 'plan') {
          return block === latestPlan ? <PlanCard key={`${messageId}_plan_${index}`} items={block.items ?? []} /> : null;
        }
        return null;
      })}
    </>
  );
}

/** 图表类工具的结果会被提到结论区，这里按调用顺序收集。 */
function chartBlocks(blocks: AgentMessageBlock[]): Array<{ key: string; result: ToolResult }> {
  const out: Array<{ key: string; result: ToolResult }> = [];
  for (const block of blocks) {
    if (block.type !== 'tool_result' || !block.callId) continue;
    const result = block.result as ToolResult;
    if ((result?.data as Record<string, any> | undefined)?.chart) out.push({ key: block.callId, result });
  }
  return out;
}

/**
 * 执行过程单独折叠：步骤再多也不挤占结论，展开才看细节。
 * 运行中强制展开，结束后默认收起。
 */
function ExecutionSection({ count, running, testId, children }: { count: number; running?: boolean; testId?: string; children: ReactNode }) {
  return (
    <details className={`execution${running ? ' running' : ''}`} data-testid={testId} open={running ? true : undefined}>
      <summary>
        <ChevronRight size={11} className="execution-chevron" />
        执行过程
        {count ? <span className="muted">· {count} 步</span> : null}
        {running ? <span className="muted">· 执行中…</span> : null}
      </summary>
      <div className="execution-body">{children}</div>
    </details>
  );
}

/** 附件图片要走带令牌的 fetch，这里把 object URL 的获取收敛到一个组件里。 */
function ChatImage({ attachmentId, size = 96 }: { attachmentId: string; size?: number }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    attachmentObjectUrl(attachmentId)
      .then((value) => {
        if (alive) setUrl(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [attachmentId]);
  if (!url) return <span className="chat-image skeleton" style={{ width: size, height: size }} />;
  return <img className="chat-image" src={url} alt={attachmentId} style={{ maxWidth: size * 2, maxHeight: size * 2 }} loading="lazy" />;
}

function UserMessage({ text, images }: { text: string; images?: string[] }) {
  return (
    <div className="msg-user">
      <span className="prompt-mark">❯</span>
      <div className="bubble">
        {images?.length ? (
          <div className="chat-images">
            {images.map((id) => (
              <ChatImage key={id} attachmentId={id} />
            ))}
          </div>
        ) : null}
        {text}
      </div>
    </div>
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}

function AnswerActions({ text }: { text: string }) {
  const notify = useApp((s) => s.notify);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 导出文档用这一轮的用户提问做标题；找不到时才退回“AiDB 回答”。 */
  const findQuestion = (): string => {
    let node = rootRef.current?.closest('.msg-assistant')?.previousElementSibling ?? null;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('msg-user')) {
        return (node.querySelector('.bubble')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
      node = node.previousElementSibling;
    }
    return '';
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      notify('success', '已复制', '回答内容已复制到剪贴板');
    } catch (err: any) {
      notify('error', '复制失败', err?.message ?? '剪贴板不可用');
    }
  };
  const stampName = (extension: string) => {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    return `aidb-answer-${stamp}.${extension}`;
  };
  const buildHtml = () => {
    const root = rootRef.current?.closest('.msg-assistant') as HTMLElement | null;
    const content = root?.querySelector('.content');
    const question = findQuestion();
    const docTitle = question ? (question.length > 120 ? `${question.slice(0, 120)}…` : question) : 'AiDB 回答';
    let body = '';
    const charts: string[] = [];
    if (content) {
      const chartRoots = [...content.querySelectorAll('.agent-chart')];
      if (!chartRoots.length) chartRoots.push(...content.querySelectorAll('[data-testid="chart-card"]'));
      for (const chart of chartRoots) charts.push(chart.outerHTML);
      const clone = content.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.answer-actions, .agent-chart, [data-testid="chart-card"], .turn-end, .execution-section, .risk-banner, .tool-card, details').forEach((node) => node.remove());
      body = clone.innerHTML;
    }
    const css = Array.from(document.styleSheets)
      .map((sheet) => {
        try {
          return Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
        } catch {
          return '';
        }
      })
      .join('\n');
    // 打印固定浅色主题：导出文档没有 html[data-theme]，不钉住就会沿用 :root 的深色令牌。
    // print-color-adjust: exact 是必须的——Chrome 打印默认丢弃背景色，饼图的 conic-gradient
    // 和图例色块都是背景，网页打印回退或旧主进程未开 printBackground 时会整块变白。
    return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title><style>
${css}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{height:auto}
body{background:#fff;color:#111;font:14px/1.7 "Microsoft YaHei",Arial,sans-serif;margin:24px;padding:0}
article{max-width:960px;margin:0 auto}.agent-chart{margin:20px 0}.answer-actions{display:none}
.answer-question{font-size:18px;line-height:1.5;font-weight:650;color:#111;margin:0 0 18px;padding:0 0 12px;border-bottom:1px solid #dfe7e4}
@media print{body{background:#fff;color:#111;margin:0}.chart-card,.agent-chart{break-inside:avoid}}
</style></head><body><article>${question ? `<h1 class="answer-question">${escapeHtml(question)}</h1>` : ''}${body}${charts.map((chart) => `<section class="chart">${chart}</section>`).join('')}</article></body></html>`;
  };
  const exportPdf = async () => {
    const html = buildHtml();
    if (desktopBridge?.exportPdf) {
      const result = await desktopBridge.exportPdf({ html, name: stampName('pdf') });
      if (result.ok) notify('success', '已导出 PDF', result.path);
      else if (!result.canceled) notify('error', '导出 PDF 失败', result.error);
      return;
    }
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    frame.srcdoc = html;
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 1000);
    };
    notify('info', '打开打印对话框', '选择“另存为 PDF”即可导出');
  };
  return (
    <div className="answer-actions" ref={rootRef}>
      <button className="btn small" onClick={() => void copy()}><Copy size={11} /> 复制</button>
      <button className="btn small" onClick={() => void exportPdf()}><Download size={11} /> 导出 PDF</button>
    </div>
  );
}

function AssistantShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="msg-assistant">
      <span className="avatar"><Sparkles size={11} /></span>
      <div className="content">{children}</div>
    </div>
  );
}

export function AgentPanel() {
  const t = useApp((s) => s.t);
  const agentOpen = useApp((s) => s.agentOpen);
  const expanded = useApp((s) => s.agentExpanded);
  const messages = useApp((s) => s.agentMessages);
  const followUps = useApp((s) => s.agentFollowUps);
  const live = useApp((s) => s.live);
  const approval = useApp((s) => s.approval);
  const sessions = useApp((s) => s.sessions);
  const sessionsOpen = useApp((s) => s.sessionsOpen);
  const agentSessionId = useApp((s) => s.agentSessionId);
  const sessionMeta = useApp((s) => s.agentSessionMeta);
  const settings = useApp((s) => s.settings);
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const schemas = useApp((s) => activeConnectionId ? s.schemas[activeConnectionId] : undefined);
  const agentMode = useApp((s) => s.agentMode);
  const agentDatabase = useApp((s) => s.agentDatabase);
  const prefill = useApp((s) => s.agentPrefill);

  const setAgentOpen = useApp((s) => s.setAgentOpen);
  const setAgentExpanded = useApp((s) => s.setAgentExpanded);
  const setAgentMode = useApp((s) => s.setAgentMode);
  const setAgentDatabase = useApp((s) => s.setAgentDatabase);
  const setSessionsOpen = useApp((s) => s.setSessionsOpen);
  const newAgentSession = useApp((s) => s.newAgentSession);
  const loadAgentSession = useApp((s) => s.loadAgentSession);
  const deleteAgentSession = useApp((s) => s.deleteAgentSession);
  const sendAgent = useApp((s) => s.sendAgent);
  const abortAgent = useApp((s) => s.abortAgent);
  const resolveApproval = useApp((s) => s.resolveApproval);
  const openMemory = useApp((s) => s.openMemory);
  const clearPrefill = useApp((s) => s.clearPrefill);
  const setActiveConnection = useApp((s) => s.setActiveConnection);
  const openQuery = useApp((s) => s.openQuery);
  const saveSettings = useApp((s) => s.saveSettings);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const notify = useApp((s) => s.notify);

  const [input, setInput] = useState('');
  const [popover, setPopover] = useState<'none' | 'mention' | 'slash'>('none');
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionQuery, setMentionQuery] = useState('');
  const [suggestions, setSuggestions] = useState<QuestionSuggestion[]>([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameSession = useApp((s) => s.renameAgentSession);

  const startRename = (id: string, title: string) => {
    setRenamingId(id);
    setRenameDraft(title);
  };
  const commitRename = async (id: string) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title) {
      notify('warning', t('rename'), t('renameEmpty'));
      return;
    }
    await renameSession(id, title);
  };
  const [pending, setPending] = useState<StoredAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 是否跟随最新输出；用户手动上滑后置为 false，滑回底部再恢复。 */
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const tables = useMemo(() => (schemas ?? []).flatMap((s) => s.tables), [schemas]);
  const slashOptions = useMemo<SlashOption[]>(() => {
    const query = input.trim().replace(/^\//, '').toLowerCase();
    const commands = COMMANDS.filter((command) => command.id !== 'ask')
      .filter((command) => !query || command.id.toLowerCase().startsWith(query) || command.aliases.some((alias) => alias.replace(/^\//, '').toLowerCase().startsWith(query)) || command.title.zh.includes(query))
      .map((command) => ({ key: `/${command.id}`, label: command.title.zh, kind: 'command' as const, commandId: command.id }));
    const presets = SLASH
      .filter((item) => !query || item.key.replace(/^\//, '').toLowerCase().startsWith(query) || item.label.includes(query))
      .map((item) => ({ key: item.key, label: item.label, kind: 'preset' as const }));
    return [...commands, ...presets];
  }, [input]);
  const busy = live?.status === 'streaming' || live?.status === 'awaiting';
  const profile = getModelProfile(settings.agent);
  const tierLevels = profile?.reasoning ? [...new Set((profile.reasoningTiers ?? []).map((tier) => tier.level))] : [];
  const canAttachImage = supportsInput(profile, 'image');
  const modelConfigs = settings.agent.modelConfigs ?? [];
  const modelOptions = useMemo(() => {
    const base = modelConfigs.flatMap((config) =>
      config.models.map((entry) => ({
        configId: config.id,
        model: entry.id,
        label: entry.name || entry.id,
        provider: config.name || config.baseUrl || config.id,
      })),
    );
    // 不同服务商可能有同名模型：只在重名时补上服务商，避免下拉里分不清。
    const counts = new Map<string, number>();
    for (const item of base) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    return base.map((item) => (counts.get(item.label)! > 1 ? { ...item, label: `${item.label} · ${item.provider}` } : item));
  }, [modelConfigs]);
  const activeModelIndex = modelOptions.findIndex(
    (item) => item.configId === (settings.agent.activeModelId ?? modelConfigs[0]?.id) && item.model === settings.agent.model,
  );

  /** 切换当前模型：连接信息由 Bridge 物化，推理档位跟随时校验。 */
  const switchModel = (index: number) => {
    const target = modelOptions[index];
    if (!target) return;
    if (target.configId === settings.agent.activeModelId && target.model === settings.agent.model) return;
    const tiers = settings.agent.modelProfiles?.[target.model]?.reasoningTiers ?? [];
    const keepTier = settings.agent.reasoningTier && tiers.some((tier) => tier.level === settings.agent.reasoningTier);
    void saveSettings({
      ...settings,
      agent: {
        ...settings.agent,
        activeModelId: target.configId,
        model: target.model,
        reasoningTier: keepTier ? settings.agent.reasoningTier : undefined,
      },
    });
  };

  const uploadImages = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/')).slice(0, MAX_IMAGES - pending.length);
    if (!images.length) return;
    if (!canAttachImage) {
      notify('warning', '当前模型不支持图片', '在 设置 → 模型能力 里勾选「图片」后再试。');
      return;
    }
    setUploading(true);
    try {
      for (const file of images) {
        const base64 = await readAsBase64(file);
        if (!base64) continue;
        const { attachment } = await api.uploadAttachment({ mime: file.type, base64 });
        setPending((prev) => (prev.some((item) => item.id === attachment.id) ? prev : [...prev, attachment]));
      }
    } catch (err: any) {
      notify('error', '图片上传失败', err?.message ?? String(err));
    } finally {
      setUploading(false);
    }
  };

  // 猜你想问：服务端用本地规则从已加载 schema 推导，不查库、不调模型，离线模式同样可用
  const suggestionsSupported = activeConnection ? engineMeta(activeConnection.engine).languages.includes('sql') : true;
  useEffect(() => {
    if (!activeConnectionId || !suggestionsSupported) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    api
      .suggest({ connectionId: activeConnectionId, database: agentDatabase || activeConnection?.database, limit: 6 })
      .then((res) => {
        if (!cancelled) setSuggestions(res.suggestions);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConnectionId, activeConnection?.database, agentDatabase, tables.length, suggestionsSupported]);

  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      clearPrefill();
      setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [prefill, clearPrefill]);

  // 内容长高时（流式输出、工具卡展开、图表渲染）只在跟随状态下贴底。
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!stickRef.current) return;
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, live?.startedAt, live?.text, live?.thinking, live?.tools, live?.plan, live?.status, live?.memories, followUps.length]);

  // 新的一轮开始或切换会话时，无论此前停在哪里都回到最新输出。
  const lastTurnStart = useRef(0);
  useEffect(() => {
    if (!live || live.startedAt === lastTurnStart.current) return;
    lastTurnStart.current = live.startedAt;
    stickRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live?.startedAt]);

  useEffect(() => {
    stickRef.current = true;
    setShowJump(false);
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      lastTopRef.current = el.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [agentSessionId]);

  const onTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const distance = el.scrollHeight - top - el.clientHeight;
    // 只有真正向上滚动（滚轮/拖滚动条/键盘）才停止跟随；
    // 程序化贴底和图表延后测量造成的滚动条位置变化不算。
    const scrolledUp = top < lastTopRef.current - 2;
    lastTopRef.current = top;
    if (scrolledUp) stickRef.current = false;
    else if (distance <= 48) stickRef.current = true;
    setShowJump((prev) => (distance <= 48 ? false : scrolledUp || distance > 120 ? true : prev));
  };

  const jumpToLatest = () => {
    stickRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`;
  }, [input]);

  if (!agentOpen) return null;

  const activeModelLabel =
    modelOptions.find((item) => item.configId === settings.agent.activeModelId && item.model === settings.agent.model)?.label ??
    settings.agent.model;
  const providerLabel = settings.agent.provider === 'local' ? 'Local' : activeModelLabel;
  const modeLabel = MODE_OPTIONS.find((m) => m.value === agentMode);
  // 纯前端过滤：listSessions 已经返回全量，不需要新接口
  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(query));
  }, [sessions, sessionQuery]);

  const send = () => {
    const value = input.trim();
    if (!value || busy) return;
    const token = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(value);
    // /init 直接在当前会话执行；参数是可选的目录/文件路径，不弹命令表单。
    if (token && token[1].toLowerCase() === 'init') {
      const images = pending.map((item) => item.id);
      setInput('');
      setPending([]);
      setPopover('none');
      void sendAgent(value, undefined, images);
      return;
    }
    const command = token
      ? COMMANDS.find((item) => item.id === token[1] || item.aliases.some((alias) => alias.replace(/^\//, '').toLowerCase() === token[1].toLowerCase()))
      : undefined;
    if (command) {
      // 所有命令都在 Agent 内联执行：命令只表达目的，参数由 Agent 从语义和上下文推断。
      if (command.id === 'report' && !token?.[2]?.trim()) {
        setInput('/report ');
        setPopover('none');
        notify('info', '/report 需要报告主题', '例如：/report 总结一下三年来的订单增长情况');
        textareaRef.current?.focus();
        return;
      }
      const images = pending.map((item) => item.id);
      setInput('');
      setPending([]);
      setPopover('none');
      void sendAgent(value, undefined, images);
      return;
    }
    const preset = token ? SLASH.find((item) => item.key === `/${token[1]}`) : undefined;
    if (preset?.key === '/memory' || preset?.key === '/clear') {
      runSlash(preset.key);
      return;
    }
    let text = value;
    if (preset) {
      const base = typeof preset.prompt === 'function' ? preset.prompt(tables) : preset.prompt;
      const extra = token?.[2]?.trim();
      text = extra ? `${base}\n\n补充要求：${extra}` : base;
    }
    const images = pending.map((item) => item.id);
    setInput('');
    setPending([]);
    setPopover('none');
    void sendAgent(text, undefined, images);
  };

  const onInput = (value: string) => {
    setInput(value);
    setSlashIndex(0);
    const mention = value.match(/@([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (mention) {
      setMentionQuery(mention[1] ?? '');
      setPopover('mention');
      return;
    }
    if (/^\/[A-Za-z]*$/.test(value)) {
      setPopover('slash');
      return;
    }
    if (popover !== 'mention' && popover !== 'slash') setPopover('none');
    if (popover === 'mention' && !mention) setPopover('none');
    if (popover === 'slash' && !value.startsWith('/')) setPopover('none');
  };

  const insertMention = (name: string) => {
    setInput((prev) => prev.replace(/@([A-Za-z_][A-Za-z0-9_]*)?$/, `@${name} `));
    setPopover('none');
    textareaRef.current?.focus();
  };

  const runSlash = (key: string) => {
    if (key === '/memory') {
      openMemory();
      setInput('');
      setPopover('none');
      return;
    }
    if (key === '/clear') {
      void newAgentSession();
      setInput('');
      setPopover('none');
      return;
    }
    if (SLASH.some((item) => item.key === key)) {
      setInput(`${key} `);
      setPopover('none');
      textareaRef.current?.focus();
    }
  };

  const selectSlash = (option: SlashOption) => {
    if (option.kind === 'command' && option.commandId) {
      // 只补全命令 token，让用户用一句话补充目的；不打开任何参数表单。
      setInput(`/${option.commandId} `);
      setPopover('none');
      textareaRef.current?.focus();
      return;
    }
    runSlash(option.key);
  };

  const renderPersisted = (message: (typeof messages)[number]) => {
    if (message.role === 'user') {
      const images = message.blocks
        .map((block) => (block.type === 'image' ? block.attachmentId : undefined))
        .filter((id): id is string => Boolean(id));
      return <UserMessage key={message.id} text={message.content} images={images.length ? images : undefined} />;
    }
    const toolCount = message.blocks.filter((b) => b.type === 'tool_call').length;
    const artifacts = chartBlocks(message.blocks);
    const hasExecution = toolCount > 0 || message.blocks.some((b) => b.type === 'thinking' || b.type === 'plan');
    return (
      <AssistantShell key={message.id}>
        {hasExecution ? (
          <ExecutionSection count={toolCount} testId="execution-section">
            <AssistantBlocks blocks={message.blocks} messageId={message.id} />
          </ExecutionSection>
        ) : null}
        {message.content ? <Markdown>{message.content}</Markdown> : null}
        {artifacts.map((artifact) => (
          <div className="agent-chart" data-testid="agent-chart" key={artifact.key}>
            <ResultView result={artifact.result} chartHeight={CHART_BODY_HEIGHT} onOpenEditor={(sql) => openQuery(undefined, sql)} />
          </div>
        ))}
        {message.content ? <AnswerActions text={message.content} /> : null}
        {toolCount ? (
          <div className="turn-end">
            {toolCount} 次工具调用
            {message.tokens ? ` · ↓${message.tokens.toLocaleString()} tokens` : ''}
          </div>
        ) : null}
      </AssistantShell>
    );
  };

  return (
    <aside className={`agent-panel ${expanded ? 'expanded' : ''}`} data-testid="agent-panel">
      <div className="agent-head">
        <div className="agent-title">
          <span className="agent-dot">AI</span>
          <span>AI 助手</span>
        </div>
        <span className="badge agent" style={{ fontSize: 9 }}>{providerLabel}</span>
        <div className="spacer" />
        <button className="icon-btn" title={t('sessions')} onClick={() => setSessionsOpen(!sessionsOpen)} data-testid="agent-sessions">
          <History size={14} />
        </button>
        <button className="icon-btn" title={t('memory')} onClick={openMemory} data-testid="agent-memory">
          <Brain size={14} />
        </button>
        <button className="icon-btn" title={t('newSession')} onClick={() => void newAgentSession()} data-testid="agent-new-session">
          <MessageSquarePlus size={14} />
        </button>
        <button className="icon-btn" title={expanded ? 'collapse' : 'expand'} onClick={() => setAgentExpanded(!expanded)}>
          {expanded ? <Minimize2 size={14} /> : <Expand size={14} />}
        </button>
        <button className="icon-btn" title={t('close')} onClick={() => setAgentOpen(false)}>
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className="agent-sub">
        <Database size={11} />
        <select
          className="mode-select"
          style={{ border: 'none', background: 'transparent', maxWidth: 150 }}
          value={activeConnectionId ?? ''}
          onChange={(e) => setActiveConnection(e.target.value || undefined)}
          title={t('connections')}
        >
          <option value="">未选择连接</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <DatabaseSelect
          connectionId={activeConnectionId}
          value={agentDatabase}
          onChange={setAgentDatabase}
          testId="agent-db"
          className="mode-select"
          style={{ border: 'none', background: 'transparent', maxWidth: 130 }}
        />
        <span>·</span>
        <span>{sessionMeta?.title ?? t('emptyAgentTitle')}</span>
        <div className="spacer" />
        <span title={settings.agent.hasApiKey ? 'API key configured' : t('noApiKey')} style={{ color: settings.agent.provider !== 'local' && !settings.agent.hasApiKey ? 'var(--warning)' : undefined }}>
          {settings.agent.provider === 'local' ? 'offline' : activeModelLabel}
        </span>
      </div>

      <div className="agent-transcript-wrap">
        <div className="agent-transcript" ref={scrollRef} onScroll={onTranscriptScroll} data-testid="agent-transcript">
          <div className="agent-transcript-inner" ref={contentRef}>
            {!messages.length && !live ? (
              <div className="agent-empty">
                <div className="hero"><Sparkles size={22} /></div>
                <h3>{t('emptyAgentTitle')}</h3>
                <p>{t('emptyAgentHint')}</p>
                {suggestions.length ? (
                  <div className="suggest-block" data-testid="agent-suggestions">
                    <div className="plan-title" style={{ padding: '0 2px' }}>猜你想问</div>
                    <div className="suggest-list">
                      {suggestions.map((s) => {
                        const label = suggestionLabel(s.kind);
                        return (
                          <button key={s.id} className="suggest-chip" title={s.reason} onClick={() => setInput(s.prompt)} data-testid={`suggest-${s.kind}`}>
                            <Sparkles size={10} />
                            <span className="truncate">{s.prompt}</span>
                            {/* 问题里已经写了「趋势」就不再重复挂同一个标签 */}
                            {s.prompt.includes(label) ? null : <em>{label}</em>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="cap-grid">
                  {[
                    { icon: <ShieldAlert size={13} />, label: '数据库体检', prompt: '对当前数据库做一次体检：缺少主键、外键缺索引、重复索引与空表，并给出修复 SQL。' },
                    { icon: <Database size={13} />, label: '备份数据库', prompt: '备份当前数据库。' },
                  ].map((cap) => (
                    <button key={cap.label} className="cap-card" onClick={() => setInput(cap.prompt)}>
                      {cap.icon}
                      {cap.label}
                    </button>
                  ))}
                </div>
                {sessions.length ? (
                  <div style={{ marginTop: 18, textAlign: 'left' }}>
                    <div className="plan-title" style={{ padding: '0 2px' }}>{t('recent')}</div>
                    {sessions.slice(0, 3).map((session) => (
                      <button key={session.id} className="recent-item" onClick={() => void loadAgentSession(session.id)}>
                        <TerminalSquare size={12} style={{ color: 'var(--agent)' }} />
                        <span className="truncate" style={{ flex: 1 }}>{session.title}</span>
                        <span className="muted" style={{ fontSize: 9.5 }}>{formatRelative(session.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {messages.map(renderPersisted)}

            {live ? (
              <>
                <UserMessage text={live.userText} images={live.userImages} />
                <AssistantShell>
                  {live.thinking || live.tools.length || live.plan.length ? (
                    <ExecutionSection count={live.tools.length} running={busy} testId="execution-section-live">
                      {live.thinking ? (
                        <details className="thinking" open={!live.text && !live.tools.length}>
                          <summary><Brain size={11} /> {t('thinking')}</summary>
                          <div className="thinking-body">{live.thinking}</div>
                        </details>
                      ) : null}
                      {live.tools.map((tool) => (
                        <ToolCard
                          key={tool.callId}
                          tool={tool.tool}
                          args={tool.args}
                          risk={tool.risk}
                          status={tool.status}
                          result={tool.result}
                          summary={tool.summary}
                          live
                          chartMoved={Boolean((tool.result?.data as Record<string, any> | undefined)?.chart)}
                          onOpenEditor={(sql) => openQuery(undefined, sql)}
                        />
                      ))}
                      <PlanCard items={live.plan} running={busy} />
                    </ExecutionSection>
                  ) : null}
                  {live.text ? (
                    <div className="prose">
                      <Markdown>{live.text}</Markdown>
                      {busy ? <span className="typing-caret" /> : null}
                    </div>
                  ) : null}
                  {live.tools
                    .filter((tool) => (tool.result?.data as Record<string, any> | undefined)?.chart)
                    .map((tool) => (
                      <div className="agent-chart" data-testid="agent-chart" key={`art_${tool.callId}`}>
                        <ResultView result={tool.result!} chartHeight={CHART_BODY_HEIGHT} onOpenEditor={(sql) => openQuery(undefined, sql)} />
                      </div>
                    ))}
                  {live.error ? <div className="risk-banner">{live.error}</div> : null}
                  {!busy && live.text ? <AnswerActions text={live.text} /> : null}
                  {live.memories.length ? (
                    <details className="memory-refs" data-testid="live-memories">
                      <summary>
                        <Brain size={10} /> 参考 {live.memories.length} 条记忆
                      </summary>
                      <div className="memory-refs-list">
                        {live.memories.map((m) => (
                          <span key={m.id} className="memory-pill"><Brain size={9} /> {m.title}</span>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {!busy ? (
                    <div className="turn-end">
                      {live.status === 'aborted' ? t('aborted') : live.status === 'error' ? t('failed') : t('completed')} · {live.tools.length} 次工具 · {formatDuration(Date.now() - live.startedAt)}
                      {live.tokensIn || live.tokensOut ? ` · ↑${live.tokensIn} ↓${live.tokensOut}` : ''}
                    </div>
                  ) : null}
                </AssistantShell>
              </>
            ) : null}

            {!busy && followUps.length ? (
              <div className="followups" data-testid="agent-followups">
                <span className="muted">继续问：</span>
                {followUps.map((s) => (
                  <button key={s.id} className="suggest-chip small" title={s.reason} onClick={() => setInput(s.prompt)}>
                    <span className="truncate">{s.prompt}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {showJump ? (
          <button type="button" className="scroll-bottom-btn" onClick={jumpToLatest} data-testid="agent-scroll-bottom" aria-label="回到最新输出">
            <ArrowDown size={12} />
            回到底部
          </button>
        ) : null}
      </div>

      {live && (busy || live.status === 'done') ? <LiveActivity live={live} /> : null}

      {popover === 'mention' ? (
        <div className="popover mention-popover">
          {tables
            .filter((tbl) => tbl.name.toLowerCase().includes(mentionQuery.toLowerCase()))
            .slice(0, 8)
            .map((tbl) => (
              <button key={tbl.name} className="popover-item" onClick={() => insertMention(tbl.name)}>
                <Database size={12} />
                <span>{tbl.name}</span>
                <span className="k">{tbl.columns?.length ?? 0} cols</span>
              </button>
            ))}
          {!tables.length ? <div className="popover-item muted">当前连接没有可引用表</div> : null}
        </div>
      ) : null}
      {popover === 'slash' ? (
        <div className="popover mention-popover">
          {slashOptions.map((option, index) => (
            <button
              key={`${option.kind}:${option.key}`}
              className={`popover-item ${index === slashIndex ? 'active' : ''}`}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => selectSlash(option)}
            >
              <TerminalSquare size={12} />
              <span>{option.key}</span>
              <span className="k">{option.label}</span>
            </button>
          ))}
          {!slashOptions.length ? <div className="popover-item muted">没有匹配的命令</div> : null}
          <div className="popover-hint">↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭</div>
        </div>
      ) : null}

      <div className="composer">
        <div
          className="composer-box"
          onDragOver={(e) => {
            if (canAttachImage) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files);
            if (!files.length) return;
            e.preventDefault();
            void uploadImages(files);
          }}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            placeholder={t('composerHint')}
            onChange={(e) => onInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (!files.length) return;
              e.preventDefault();
              void uploadImages(files);
            }}
            onKeyDown={(e) => {
              // 无必填参数的命令：输入完整 token 后 Enter 直接执行，不再让菜单吞掉第一次回车。
              if (popover === 'slash' && e.key === 'Enter' && !e.shiftKey && /^\/(?:init|compare|diff|recon|fix)$/i.test(input.trim())) {
                e.preventDefault();
                setPopover('none');
                send();
                return;
              }
              if (popover === 'slash' && slashOptions.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashIndex((index) => (index + 1) % slashOptions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashIndex((index) => (index - 1 + slashOptions.length) % slashOptions.length);
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  selectSlash(slashOptions[slashIndex] ?? slashOptions[0]);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  selectSlash(slashOptions[slashIndex] ?? slashOptions[0]);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              if (e.key === 'Escape') setPopover('none');
            }}
            data-testid="agent-input"
          />
          {pending.length || uploading ? (
            <div className="composer-images" data-testid="composer-images">
              {pending.map((item) => (
                <span key={item.id} className="composer-image" title={`${item.mime} · ${formatBytes(item.bytes)}`}>
                  <ChatImage attachmentId={item.id} size={54} />
                  <button
                    className="icon-btn image-remove"
                    title="移除这张图"
                    onClick={() => setPending((prev) => prev.filter((x) => x.id !== item.id))}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {uploading ? (
                <span className="composer-image uploading">
                  <Loader2 size={16} className="spin" />
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="composer-tools">
            <button
              className="icon-btn"
              title={t('attachTable')}
              onClick={() => {
                setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@`);
                setPopover('mention');
                textareaRef.current?.focus();
              }}
            >
              <AtSign size={13} />
            </button>
            <button
              className="icon-btn"
              title={canAttachImage ? `添加图片（最多 ${MAX_IMAGES} 张，也可直接粘贴或拖入）` : '当前模型未开启图片输入，请到 设置 → 模型能力 勾选'}
              onClick={() => fileInputRef.current?.click()}
              disabled={!canAttachImage || uploading || pending.length >= MAX_IMAGES}
              data-testid="agent-attach-image"
            >
              <ImagePlus size={13} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                void uploadImages(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
              data-testid="agent-image-input"
            />
            <button
              className="icon-btn"
              title={t('slashCommands')}
              onClick={() => {
                setInput('/');
                setPopover('slash');
                textareaRef.current?.focus();
              }}
            >
              <Zap size={13} />
            </button>
            <button className="icon-btn" title={t('memory')} onClick={openMemory}>
              <Brain size={13} />
            </button>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <div className="composer-foot">
            <span className="composer-perm-label">权限</span>
            <select
              className="mode-select"
              value={agentMode}
              onChange={(e) => setAgentMode(e.target.value as PermissionMode)}
              title={t('permission')}
              data-testid="agent-mode"
            >
              {MODE_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{settings.locale === 'en' ? m.en : m.zh}</option>
              ))}
            </select>
            {tierLevels.length ? (
              <>
                <span className="composer-perm-label">推理</span>
                <select
                  className="mode-select"
                  value={settings.agent.reasoningTier ?? 'default'}
                  onChange={(e) =>
                    void saveSettings({
                      ...settings,
                      agent: { ...settings.agent, reasoningTier: e.target.value === 'default' ? undefined : e.target.value },
                    })
                  }
                  title="思考档位：按模型档案里的映射下发给服务商"
                  data-testid="agent-reasoning-tier"
                >
                  <option value="default">跟随服务商</option>
                  {tierLevels.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </>
            ) : null}
            <div className="spacer" />
            {modelOptions.length ? (
              <select
                className="mode-select model-select"
                value={activeModelIndex >= 0 ? String(activeModelIndex) : ''}
                onChange={(e) => {
                  if (e.target.value === '__manage') {
                    setSettingsOpen(true, 'agent');
                    return;
                  }
                  switchModel(Number(e.target.value));
                }}
                title="切换模型（在 设置 → 模型 里管理模型源和模型）"
                data-testid="agent-model-select"
              >
                {activeModelIndex < 0 ? <option value="">选择模型…</option> : null}
                {modelOptions.map((item, index) => (
                  <option key={`${item.configId}::${item.model}`} value={index}>
                    {item.label}
                  </option>
                ))}
                <option value="__manage">管理模型…</option>
              </select>
            ) : (
              <button className="mode-select model-manage-btn" onClick={() => setSettingsOpen(true, 'agent')} title="去设置里添加模型" data-testid="agent-model-manage">
                配置模型
              </button>
            )}
            {busy ? (
              <button className="send-btn stop" onClick={() => void abortAgent()} title={t('stop')} data-testid="agent-stop">
                <Square size={12} />
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!input.trim()} title={t('send')} data-testid="agent-send">
                <Sparkles size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">
          <ShieldAlert size={9} /> {t('transactionNote')}
        </div>
      </div>

      {sessionsOpen ? (
        <div className="sessions-drawer">
          <div className="sessions-head">
            <span style={{ fontWeight: 600, flex: 1 }}>{t('sessions')}</span>
            <button className="btn small primary" onClick={() => void newAgentSession()}>
              <Plus size={12} /> {t('newSession')}
            </button>
            <button className="icon-btn" onClick={() => setSessionsOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="sessions-search">
            <Search size={12} />
            <input
              className="sessions-search-input"
              value={sessionQuery}
              placeholder={t('searchSessions')}
              data-testid="session-search"
              onChange={(e) => setSessionQuery(e.target.value)}
            />
            {sessionQuery ? (
              <button type="button" className="icon-btn" title={t('close')} data-testid="session-search-clear" onClick={() => setSessionQuery('')}>
                <X size={11} />
              </button>
            ) : null}
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {filteredSessions.length ? (
              filteredSessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-item ${session.id === agentSessionId ? 'active' : ''}`}
                  onClick={() => { if (renamingId !== session.id) void loadAgentSession(session.id); }}
                >
                  <TerminalSquare size={13} style={{ color: 'var(--agent)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {renamingId === session.id ? (
                      <input
                        className="s-rename"
                        value={renameDraft}
                        autoFocus
                        title={t('renameHint')}
                        data-testid="session-rename-input"
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => void commitRename(session.id)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') void commitRename(session.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    ) : (
                      <div className="s-title">{session.title}</div>
                    )}
                    <div className="s-meta">
                      {formatRelative(session.updatedAt)} · {session.permissionMode} · {session.tokensIn + session.tokensOut} tokens
                    </div>
                  </div>
                  <button
                    className="icon-btn"
                    title={t('rename')}
                    data-testid="session-rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(session.id, session.title);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm('删除该会话？')) void deleteAgentSession(session.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            ) : (
              <div className="muted" style={{ padding: 16, fontSize: 11.5 }}>还没有会话</div>
            )}
          </div>
        </div>
      ) : null}

      {approval ? (
        <div className="overlay" style={{ zIndex: 70 }}>
          <div className="modal approval-modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>
                <ShieldAlert size={15} style={{ color: 'var(--warning)' }} />
                {t('approval')}
              </h2>
            </div>
            <div className="modal-body">
              <div className="approval-risk">
                <RiskBadge risk={approval.risk} />
                <span className="mono" style={{ fontSize: 12 }}>{approval.tool}</span>
                <div className="spacer" />
                <span className="muted" style={{ fontSize: 10.5 }}>{t('permission')}：{agentMode}</span>
              </div>
              <div className="approval-summary">{approval.summary}</div>
              {approval.sql ? (
                <div className="sql-block approval-sql">
                  {approval.sql}
                  <span style={{ position: 'absolute', top: 4, right: 4 }}><CopyButton text={approval.sql} /></span>
                </div>
              ) : (
                <pre className="code-block-small" style={{ maxHeight: 180, overflow: 'auto' }}>{JSON.stringify(approval.args, null, 2)}</pre>
              )}
              {approval.risk === 'destructive' ? (
                <div className="risk-banner" style={{ marginTop: 10 }}>
                  这是破坏性操作，可能永久删除数据。确认前 Agent 已按设置尝试创建备份。
                </div>
              ) : null}
              <p className="hint" style={{ marginTop: 10 }}>{t('transactionNote')}</p>
              {approval.tool === 'mcp_call' ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  「始终允许」只影响工具调用审批，本次运行内有效；文件系统还需要在 设置 → MCP 与工具 单独配置允许目录。
                </p>
              ) : null}
            </div>
            <div className="modal-foot" style={{ flexWrap: 'wrap' }}>
              <button className="btn ghost" onClick={() => void resolveApproval('deny', 'once')} data-testid="approval-deny">
                {t('deny')}
              </button>
              <div className="spacer" />
              <button className="btn" onClick={() => void resolveApproval('deny', 'once')} style={{ display: 'none' }} />
              <button className="btn" onClick={() => void resolveApproval('allow', 'once')} data-testid="approval-allow-once">
                {t('allowOnce')}
              </button>
              <button className="btn" onClick={() => void resolveApproval('allow', 'session')}>
                {t('allowSession')}
              </button>
              <button className="btn primary" onClick={() => void resolveApproval('allow', 'always')}>
                {t('allowAlways')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
