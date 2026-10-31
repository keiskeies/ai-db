import { classifySql, engineMeta, tablesFromSql, type AppSettings, type DashboardCard, type DashboardCardResult, type DashboardTimeRange, type ReportBlock, type ReportSpec } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

/** 仪表板的行上限：图表不需要比这更多的点，再多只是把库拖垮。 */
const DASHBOARD_MAX_ROWS = 2000;
/** 一次刷新的并发：数据库客户端不是报表服务器，串行两条已经够快。 */
const REFRESH_CONCURRENCY = 2;

/** 只有能跑 SQL 的引擎才有仪表板；Mongo/Redis/Neo4j/ES 的「图表」不是同一件事。 */
export function dashboardSupported(engine: string): boolean {
  return engineMeta(engine as never)?.languages?.includes('sql') === true;
}

/** 仪表板永不写库：非只读语句直接拒绝，这样只读连接也能正常用板子。 */
export function assertDashboardSql(sql: string): string | undefined {
  if (!sql.trim()) return 'SQL 为空';
  const classification = classifySql(sql);
  if (classification.statements.length > 1) return '仪表板卡片只允许单条语句';
  if (classification.kind !== 'read') return `仪表板卡片只能是查询语句，当前为 ${classification.kind}`;
  return undefined;
}

/** 引用了被禁用的表就等于绕过了用户在 Agent 上下文里做的取舍。 */
export function disabledTablesTouched(sql: string, disabledTables: string[]): string[] {
  if (!disabledTables.length) return [];
  const blocked = new Set(disabledTables.map((table) => table.toLowerCase()));
  return tablesFromSql(sql).filter((table) => blocked.has(table));
}

function quoteTime(value: string): string {
  // 时间边界来自下拉选项而非用户输入，仍要把引号与分号挡掉
  const safe = value.replace(/['"`;]/g, '');
  return `'${safe}'`;
}

/**
 * 时间筛选靠外层包裹，绝不改写卡片 SQL 内部：
 * 内层重写会撞上方言陷阱（例如 Oracle <12 把 ROWNUM 塞进 WHERE，聚合前先截断导致口径算错）。
 */
export function applyTimeRange(sql: string, timeColumn: string, range: DashboardTimeRange): string {
  const body = sql.trim().replace(/;\s*$/, '');
  const column = timeColumn.replace(/[^A-Za-z0-9_$.]/g, '');
  if (!column) return body;
  const conditions: string[] = [];
  if (range.from) conditions.push(`dash_t.${column} >= ${quoteTime(range.from)}`);
  if (range.to) conditions.push(`dash_t.${column} < ${quoteTime(range.to)}`);
  if (!conditions.length) return body;
  return `SELECT * FROM (${body}) dash_t WHERE ${conditions.join(' AND ')}`;
}

async function runOne(
  manager: ConnectionManager,
  settings: AppSettings,
  card: DashboardCard,
  sql: string,
): Promise<{ columns: Array<{ name: string }>; rows: unknown[][]; durationMs: number; error?: string }> {
  try {
    const batch = await manager.query(card.connectionId, sql, {
      database: card.database,
      maxRows: DASHBOARD_MAX_ROWS,
      timeoutMs: settings.queryTimeoutMs,
      allowMulti: false,
      autoLimit: settings.autoLimit,
      actor: 'user',
    });
    const set = batch.sets[0];
    if (!set) return { columns: [], rows: [], durationMs: batch.durationMs, error: '查询没有返回结果集' };
    return {
      columns: set.columns.map((column) => ({ name: column.name })),
      rows: set.rows,
      durationMs: batch.durationMs,
      error: set.rows.length ? undefined : '结果集为空',
    };
  } catch (err) {
    return { columns: [], rows: [], durationMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 刷新卡片：并发封顶、逐卡失败不影响其它卡，成功结果写回快照供下次秒渲染。
 */
export async function refreshDashboardCards(input: {
  store: Store;
  manager: ConnectionManager;
  settings: AppSettings;
  cards: DashboardCard[];
  range?: DashboardTimeRange;
}): Promise<DashboardCardResult[]> {
  const { store, manager, settings, cards, range } = input;
  const results: DashboardCardResult[] = [];
  const queue = [...cards];
  const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, queue.length) }, async () => {
    for (let card = queue.shift(); card; card = queue.shift()) {
      const guard = assertDashboardSql(card.sql);
      if (guard) {
        const rejected: DashboardCardResult = {
          cardId: card.id,
          status: 'error',
          columns: [],
          rows: [],
          durationMs: 0,
          error: guard,
        };
        results.push(rejected);
        store.updateDashboardCard(card.id, { lastStatus: 'error', lastError: guard });
        continue;
      }
      const filtered = range && card.timeColumn ? applyTimeRange(card.sql, card.timeColumn, range) : card.sql;
      let ran = await runOne(manager, settings, card, filtered);
      let filterSkipped = false;
      if (ran.error && filtered !== card.sql) {
        const plain = await runOne(manager, settings, card, card.sql);
        if (!plain.error) {
          ran = plain;
          filterSkipped = true;
        }
      }
      const message = ran.error ?? '查询失败';
      const ok = !ran.error;
      const snapshot = ok ? { columns: ran.columns, rows: ran.rows } : undefined;
      store.updateDashboardCard(card.id, {
        lastStatus: ok ? 'ok' : 'error',
        lastError: ok ? '' : message,
        ...(snapshot ? { lastResult: snapshot } : {}),
      });
      results.push({
        cardId: card.id,
        status: ok ? 'ok' : 'error',
        columns: ran.columns,
        rows: ran.rows,
        durationMs: ran.durationMs,
        error: ok ? undefined : message,
        filterSkipped: filterSkipped || undefined,
      });
    }
  });
  await Promise.all(workers);
  const order = new Map(cards.map((card, index) => [card.id, index]));
  return results.sort((a, b) => (order.get(a.cardId) ?? 0) - (order.get(b.cardId) ?? 0));
}

/** 分页 deck 只认三种图，其余类型按柱状出图，别在导出里发明新图形。 */
const DECK_CHARTS = new Set(['bar', 'line', 'pie']);

/**
 * 仪表板的一次结果 → ReportSpec：仪表板负责日常观察，报告负责一次性汇报。
 * 卡片快照为空就跳过，不硬凑空白页。
 */
export function buildDashboardReportSpec(input: {
  conn: { id: string; name: string; engine: string };
  database?: string;
  cards: DashboardCard[];
}): ReportSpec | undefined {
  const blocks: ReportBlock[] = [];
  for (const card of input.cards) {
    const result = card.lastResult;
    if (!result || !result.rows.length || !result.columns.length) continue;
    const names = result.columns.map((column) => column.name);
    const xIndex = card.x ? Math.max(0, names.indexOf(card.x)) : 0;
    let yIndex = card.y ? names.indexOf(card.y) : -1;
    if (yIndex < 0) yIndex = names.findIndex((_, index) => index !== xIndex && result.rows.some((row) => Number.isFinite(Number(row[index]))));
    if (yIndex < 0 || xIndex === yIndex) continue;
    const series = result.rows
      .slice(0, 40)
      .map((row) => ({ label: String(row[xIndex] ?? '—'), value: Number(row[yIndex]) }))
      .filter((point) => Number.isFinite(point.value));
    if (!series.length) continue;
    blocks.push({
      kind: 'chart',
      title: card.title,
      chartType: (DECK_CHARTS.has(card.chartType) ? card.chartType : 'bar') as 'bar' | 'line' | 'pie',
      series,
      note: card.sql.replace(/\s+/g, ' ').slice(0, 160),
    });
  }
  if (!blocks.length) return undefined;
  // 文件型连接的 database 是绝对路径，报告标题里露出临时目录很难看
  const boardLabel = input.database ? (/[\\/]/.test(input.database) ? input.database.split(/[\\/]+/).filter(Boolean).pop() : input.database) : input.conn.name;
  return {
    version: 1,
    title: `仪表板 · ${boardLabel ?? input.conn.name}`,
    layout: 'sections',
    sources: [
      {
        key: 'board',
        connectionId: input.conn.id,
        connectionName: input.conn.name,
        database: input.database,
        engine: input.conn.engine,
        label: `${input.conn.name} / ${input.database ?? '默认库'}`,
      },
    ],
    sections: [{ id: 'board', title: '仪表板快照', sourceKey: 'board', blocks }],
    meta: {
      intent: '把当前仪表板的一次结果整理成可汇报的分页报告',
      createdAt: new Date().toISOString(),
      notes: [`共 ${input.cards.length} 张卡片，其中 ${blocks.length} 张带可用结果`],
    },
  };
}
