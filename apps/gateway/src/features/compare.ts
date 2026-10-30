import { buildCount, classifySql, engineMeta, type ConnectionConfig } from '@aidb/core';
import type { CommandSourceInput, ReportMetric, ReportSourceRef, ReportSpec } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';
import { connectionSchema } from './common';

export interface CompareInput {
  sources: CommandSourceInput[];
  metric: string;
  leftLabel: string;
  rightLabel: string;
  queryA?: string;
  queryB?: string;
}

interface SideResult {
  label: string;
  value: number;
  definition: string;
  source: ReportSourceRef;
}

function numericValue(row: unknown[] | undefined): number | undefined {
  if (!row) return undefined;
  for (const cell of row) {
    if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
    if (typeof cell === 'string' && cell.trim() && Number.isFinite(Number(cell))) return Number(cell);
  }
  return undefined;
}

async function runSide(
  store: Store,
  manager: ConnectionManager,
  source: CommandSourceInput,
  label: string,
  query: string | undefined,
): Promise<SideResult> {
  const conn = store.getConnection(source.connectionId);
  if (!conn) throw Object.assign(new Error(`连接不存在：${source.connectionId}`), { code: 'SOURCE_UNAVAILABLE', status: 404 });
  if (!engineMeta(conn.engine).languages.includes('sql')) {
    throw Object.assign(new Error(`${engineMeta(conn.engine).label} 暂不支持分析对比`), { code: 'UNSUPPORTED_ENGINE', status: 400 });
  }
  let sql = query?.trim();
  let definition = '';
  if (sql) {
    if (classifySql(sql).risk !== 'read') {
      throw Object.assign(new Error('对比 SQL 必须是只读查询'), { code: 'INVALID_INPUT', status: 400, field: 'queryA' });
    }
    definition = sql;
  } else {
    const schemas = await manager.schema(conn.id, source.database, true);
    const tables = schemas.flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
    const table = [...tables].sort((a, b) => (b.rowEstimate ?? 0) - (a.rowEstimate ?? 0) || a.name.localeCompare(b.name))[0];
    if (!table) throw Object.assign(new Error('该源没有可对比的表'), { code: 'COMPARE_NO_TABLE', status: 400 });
    sql = buildCount(conn.engine, table.name, connectionSchema(conn, table));
    definition = `行数：${table.name}`;
  }
  const batch = await manager.query(conn.id, sql, {
    database: source.database,
    maxRows: 1,
    allowMulti: false,
    autoLimit: false,
    actor: 'user',
  });
  const value = numericValue(batch.sets[0]?.rows[0]);
  if (value === undefined) throw Object.assign(new Error('对比查询没有返回数值'), { code: 'COMPARE_NO_VALUE', status: 400 });
  return {
    label,
    value,
    definition,
    source: {
      key: source.connectionId,
      connectionId: conn.id,
      connectionName: conn.name,
      database: source.database ?? conn.database,
      engine: conn.engine,
      label: source.label?.trim() || conn.name,
    },
  };
}

export async function compareValues(
  store: Store,
  manager: ConnectionManager,
  input: CompareInput,
): Promise<ReportSpec> {
  const [leftSource, rightSource] = input.sources;
  if (!leftSource) throw Object.assign(new Error('至少需要一个源'), { code: 'INVALID_INPUT', status: 400 });
  const right = rightSource ?? leftSource;
  const left = await runSide(store, manager, leftSource, input.leftLabel, input.queryA);
  const rightSide = await runSide(store, manager, right, input.rightLabel, input.queryB);
  const absolute = rightSide.value - left.value;
  const percent = left.value === 0 ? null : (absolute / left.value) * 100;
  const sources = new Map<string, ReportSourceRef>();
  sources.set(left.source.connectionId, left.source);
  sources.set(rightSide.source.connectionId, rightSide.source);
  const leftMetric: ReportMetric = { label: left.label, value: left.value, source: left.source.key };
  const rightMetric: ReportMetric = { label: rightSide.label, value: rightSide.value, source: rightSide.source.key };

  return {
    version: 1,
    title: `${input.metric}对比`,
    layout: 'comparison',
    sources: [...sources.values()],
    sections: [
      {
        id: 'comparison',
        title: `${left.label} vs ${rightSide.label}`,
        blocks: [
          {
            kind: 'comparison',
            title: input.metric,
            left: leftMetric,
            right: rightMetric,
            delta: { absolute, percent },
          },
          { kind: 'metric', metrics: [leftMetric, rightMetric] },
          {
            kind: 'narrative',
            text: `${left.label}为 ${left.value.toLocaleString()}，${rightSide.label}为 ${rightSide.value.toLocaleString()}；差值为 ${absolute.toLocaleString()}${
              percent === null ? '' : `（${percent > 0 ? '+' : ''}${percent.toFixed(1)}%）`
            }。`,
          },
          {
            kind: 'callout',
            tone: 'info',
            text: `口径：${left.definition} ↔ ${rightSide.definition}。如需保证统计口径一致，请两侧传入结构相同的聚合 SQL。`,
          },
        ],
      },
    ],
    meta: {
      intent: input.metric,
      createdAt: new Date().toISOString(),
      notes: ['对比由网关计算，不使用模型估算。'],
    },
  };
}
