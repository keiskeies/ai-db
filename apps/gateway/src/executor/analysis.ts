import {
  buildCount,
  buildCreateIndex,
  buildDropIndex,
  chartSuitability,
  CHART_KIND_LABELS,
  classifySql,
  deltas,
  forecastSeries,
  guessAxes,
  isTimeSeries,
  quoteIdent,
  recommendChartType,
  round,
  summarize,
  toSeries,
  topShare,
  type ConnectionConfig,
  type ForecastMethod,
  type StatPoint,
  type ToolResult,
} from '@aidb/core';
import { DbError } from '../drivers';
import { QUALITY_CHECK_TIMEOUT_MS } from '../manager';
import { generateData } from '../features/generate';
import { reconcileData, type ReconMapping } from '../features/reconcile';
import { compareSchemas } from '../features/schemaCompare';
import { defineTool, ok, ExecutorServices } from './types';

type RenderChartType = 'bar' | 'stacked' | 'line' | 'pie' | 'scatter' | 'heatmap' | 'radar';

async function auditDatabase(s: ExecutorServices, conn: ConnectionConfig, database: string | undefined, started: number, disabledTables: string[] = [], executionId?: string): Promise<ToolResult> {
  const schemas = await s.manager.schema(conn.id, database);
  const disabled = new Set(disabledTables.map((name) => name.toLowerCase()));
  const tables = schemas.flatMap((schema) => schema.tables).filter((table) => !disabled.has(table.name.toLowerCase()));
  const findings: Array<{ severity: 'high' | 'medium' | 'low' | 'info'; code: string; title: string; table?: string; detail: string; suggestedSql?: string }> = [];
  let counted = 0;
  for (const table of tables) {
    if (table.type !== 'table') continue;
    const ref = s.ref(conn.engine, table);
    const pkCols = (table.columns ?? []).filter((c) => c.primaryKey);
    if (!pkCols.length && conn.engine !== 'clickhouse') {
      const candidate = (table.columns ?? []).find((c) => /^id$/i.test(c.name)) ?? table.columns?.[0];
      findings.push({
        severity: 'high',
        code: 'NO_PRIMARY_KEY',
        title: '缺少主键',
        table: table.name,
        detail: `表 ${table.name} 没有主键，行定位/去重/增量同步缺少稳定依据。`,
        suggestedSql: candidate
          ? `-- 确认 ${candidate.name} 唯一后执行\nALTER TABLE ${ref} ADD CONSTRAINT ${quoteIdent('pk_' + table.name, conn.engine)} PRIMARY KEY (${quoteIdent(candidate.name, conn.engine)})`
          : undefined,
      });
    }
    if (conn.engine !== 'clickhouse') {
      for (const fk of table.foreignKeys ?? []) {
        const covered = (table.indexes ?? []).some(
          (idx) => idx.columns.length >= fk.columns.length && fk.columns.every((column, index) => idx.columns[index] === column),
        );
        if (!covered) {
          findings.push({
            severity: 'medium',
            code: 'FK_WITHOUT_INDEX',
            title: '外键缺少索引',
            table: table.name,
            detail: `外键 ${fk.columns.join(', ')} → ${fk.refTable} 没有前缀索引，关联/级联检查可能全表扫描。`,
            suggestedSql: buildCreateIndex(conn.engine, table.name, { columns: fk.columns }, s.schemaFor(conn, table)),
          });
        }
      }
      const seen = new Map<string, string>();
      for (const idx of table.indexes ?? []) {
        if (idx.primary) continue;
        const signature = idx.columns.join('|') + '|' + String(idx.unique);
        const previous = seen.get(signature);
        if (previous) {
          findings.push({
            severity: 'low',
            code: 'DUPLICATE_INDEX',
            title: '重复索引',
            table: table.name,
            detail: `索引 ${idx.name} 与 ${previous} 列组合相同。`,
            suggestedSql: buildDropIndex(conn.engine, table.name, idx.name, s.schemaFor(conn, table)),
          });
        } else {
          seen.set(signature, idx.name);
        }
      }
    }
    if (counted < 30) {
      counted++;
      try {
        const countBatch = await s.manager.query(conn.id, buildCount(conn.engine, table.name, s.schemaFor(conn, table)), {
          database,
          maxRows: 1,
          allowMulti: false,
          autoLimit: false,
          actor: 'agent',
          executionId,
        });
        const count = Number(countBatch.sets[0]?.rows?.[0]?.[0] ?? 0);
        if (count === 0) {
          findings.push({ severity: 'info', code: 'EMPTY_TABLE', title: '空表', table: table.name, detail: `表 ${table.name} 当前 0 行。` });
        } else if (count > 500000) {
          findings.push({ severity: 'info', code: 'LARGE_TABLE', title: '大表', table: table.name, detail: `表 ${table.name} 约 ${count.toLocaleString()} 行，请确认索引与分页策略。` });
        }
      } catch {
        /* best effort */
      }
    }
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const summary = {
    tablesChecked: tables.filter((t) => t.type === 'table').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  return ok(started, `体检完成：${summary.tablesChecked} 张表，${summary.high} 高 / ${summary.medium} 中 / ${summary.low} 低风险`, {
    connectionId: conn.id,
    database,
    engine: conn.engine,
    findings,
    summary,
  });
}

async function checkDataQuality(s: ExecutorServices,
  conn: ConnectionConfig,
  database: string | undefined,
  tableName: string,
  requestedColumns: string[] | undefined,
  started: number,
  executionId?: string,
): Promise<ToolResult> {
  if (!tableName) throw new DbError('table 不能为空');
  const { table } = await s.manager.findTable(conn.id, database, tableName);
  const ref = s.ref(conn.engine, table);
  const allColumns = table.columns ?? [];
  const columns = (requestedColumns?.length ? allColumns.filter((c) => requestedColumns.includes(c.name)) : allColumns).slice(0, 12);
  if (!columns.length) throw new DbError('没有可检查的列');
  const parts: string[] = [`COUNT(*) AS ${quoteIdent('total', conn.engine)}`];
  columns.forEach((column, index) => {
    const q = quoteIdent(column.name, conn.engine);
    parts.push(`SUM(CASE WHEN ${q} IS NULL THEN 1 ELSE 0 END) AS ${quoteIdent('n_' + index, conn.engine)}`);
    if (!/date|time|blob|binary|json/i.test(column.type) && conn.engine !== 'oracle' && conn.engine !== 'clickhouse') {
      parts.push(`SUM(CASE WHEN ${q} = '' THEN 1 ELSE 0 END) AS ${quoteIdent('b_' + index, conn.engine)}`);
    }
    parts.push(`COUNT(DISTINCT ${q}) AS ${quoteIdent('d_' + index, conn.engine)}`);
  });
  const sql = `SELECT ${parts.join(', ')} FROM ${ref}`;
  const batch = await s.manager.query(conn.id, sql, {
    database,
    maxRows: 1,
    allowMulti: false,
    autoLimit: false,
    actor: 'agent',
    executionId,
    // G2：质检 COUNT DISTINCT 全表聚合此前漏传超时；质检口径 120s。
    timeoutMs: QUALITY_CHECK_TIMEOUT_MS,
  });
  const set = batch.sets[0];
  if (!set) throw new DbError('质量检查没有返回结果');
  const names = set.columns.map((column) => column.name);
  const value = (row: unknown[], name: string) => row[names.indexOf(name)];
  const row = set.rows[0] ?? [];
  const total = Number(value(row, 'total') ?? 0);
  const stats = columns.map((column, index) => {
    const nulls = Number(value(row, 'n_' + index) ?? 0);
    const blanks = Number(value(row, 'b_' + index) ?? 0);
    const distinct = Number(value(row, 'd_' + index) ?? 0);
    return {
      name: column.name,
      type: column.type,
      nulls,
      nullRatio: total ? Number((nulls / total).toFixed(4)) : 0,
      blanks,
      distinct,
    };
  });
  const pkCols = allColumns.filter((c) => c.primaryKey);
  let duplicates: unknown[][] = [];
  if (pkCols.length) {
    const group = pkCols.map((c) => quoteIdent(c.name, conn.engine)).join(', ');
    const dupSql = `SELECT ${group}, COUNT(*) AS ${quoteIdent('duplicate_count', conn.engine)} FROM ${ref} GROUP BY ${group} HAVING COUNT(*) > 1`;
    const dupBatch = await s.manager.query(conn.id, dupSql, {
      database,
      maxRows: 5,
      allowMulti: false,
      // 重复主键组可能有几十万，必须让数据库只回 5 行，而不是全表分组后在内存里截。
      autoLimit: true,
      actor: 'agent',
      executionId,
      // G2：重复主键检查同样是全表分组，质检口径 120s。
      timeoutMs: QUALITY_CHECK_TIMEOUT_MS,
    });
    duplicates = dupBatch.sets[0]?.rows ?? [];
  }
  const findings: Array<{ severity: 'high' | 'medium' | 'low' | 'info'; code: string; title: string; detail: string; suggestedSql?: string }> = [];
  for (const stat of stats) {
    if (stat.nulls > 0) {
      const severity = stat.nullRatio >= 0.3 ? 'high' : stat.nullRatio >= 0.05 ? 'medium' : 'low';
      findings.push({
        severity,
        code: 'NULLS',
        title: `${stat.name} 存在空值`,
        detail: `${stat.nulls.toLocaleString()} / ${total.toLocaleString()} 行（${(stat.nullRatio * 100).toFixed(1)}%）为 NULL。`,
        suggestedSql: `SELECT * FROM ${ref} WHERE ${quoteIdent(stat.name, conn.engine)} IS NULL LIMIT 100`,
      });
    }
    if (stat.blanks > 0) {
      findings.push({
        severity: 'low',
        code: 'BLANKS',
        title: `${stat.name} 存在空字符串`,
        detail: `${stat.blanks.toLocaleString()} 行是空字符串，可能应存为 NULL。`,
        suggestedSql: `SELECT * FROM ${ref} WHERE ${quoteIdent(stat.name, conn.engine)} = '' LIMIT 100`,
      });
    }
    if (stat.distinct <= 1 && total > 1) {
      findings.push({ severity: 'info', code: 'LOW_CARDINALITY', title: `${stat.name} 只有 1 个不同值`, detail: '该列区分度极低，检查是否冗余或默认值填充。' });
    }
  }
  if (duplicates.length) {
    findings.push({ severity: 'high', code: 'DUPLICATE_KEYS', title: '主键存在重复', detail: `发现 ${duplicates.length} 组重复主键（显示前 5 组）。` });
  }
  return ok(started, `质量检查完成：${total.toLocaleString()} 行，${findings.length} 项发现`, {
    table: table.name,
    total,
    columnStats: stats,
    duplicates,
    findings,
  });
}

/**
 * 跑一次 SELECT 并把结果解析成 (x, y) 序列，render_chart / analyze_chart / forecast_chart 共用。
 * NULL 由 core 的 toSeries 丢弃：早期 render_chart 直接 Number(null) 会把空值画成 0 点。
 */
async function chartQuery(s: ExecutorServices, conn: ConnectionConfig, database: string | undefined, sqlText: string, executionId?: string) {
  const sql = sqlText.trim();
  if (!sql) throw new DbError('该工具需要 SQL');
  const classification = classifySql(sql, conn.engine);
  if (classification.statements.length !== 1 || classification.risk !== 'read') {
    throw new DbError('图表工具只允许单条只读查询', { code: 'CHART_SQL_NOT_READONLY' });
  }
  const batch = await s.manager.query(conn.id, sql, {
    database,
    maxRows: 500,
    allowMulti: false,
    autoLimit: true,
    actor: 'agent',
    executionId,
  });
  const set = batch.sets[0];
  if (!set || !set.columns.length) throw new DbError('SQL 没有返回结果集');
  const names = set.columns.map((column) => column.name);
  const objects = set.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
  return { sql, set, names, objects };
}

async function chartSeries(s: ExecutorServices, conn: ConnectionConfig, database: string | undefined, sqlText: string, xName?: string, yName?: string, executionId?: string) {
  const { sql, set, names, objects } = await chartQuery(s, conn, database, sqlText, executionId);
  const guessed = guessAxes(names, objects);
  const x = xName ?? guessed?.x ?? names[0];
  const y = yName ?? guessed?.y ?? names.find((name) => name !== x);
  if (!x || !y || x === y) throw new DbError('无法确定 x/y 列，请显式传入');
  if (!names.includes(x)) throw new DbError(`结果集中没有列 ${x}（可用列：${names.join(', ')}）`);
  if (!names.includes(y)) throw new DbError(`结果集中没有列 ${y}（可用列：${names.join(', ')}）`);
  return { sql, names, columns: set.columns, rows: set.rows, x, y, objects, points: toSeries(objects, x, y) };
}

async function renderChart(s: ExecutorServices,
  conn: ConnectionConfig,
  database: string | undefined,
  sqlText: string,
  type: RenderChartType,
  title: string | undefined,
  xName: string | undefined,
  yName: string | undefined,
  extraNames: string[] | undefined,
  stacked: boolean,
  labelName: string | undefined,
  started: number,
  executionId?: string,
): Promise<ToolResult> {
  const { sql, columns, rows, x, y, objects } = await chartSeries(s, conn, database, sqlText, xName, yName, executionId);

  if (type === 'scatter') {
    // 散点要保留每一行，不能走 toSeries 的 24 点截断；两个轴都必须是数值。
    const allPoints = objects
      .map((row) => {
        const rawX = row[x];
        const rawY = row[y];
        if (rawX === null || rawX === undefined || rawX === '' || rawY === null || rawY === undefined || rawY === '') return null;
        const xValue = Number(String(rawX).trim());
        const yValue = Number(String(rawY).trim());
        if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) return null;
        const label = labelName ? row[labelName] : undefined;
        return { x: xValue, y: yValue, ...(label === null || label === undefined || label === '' ? {} : { label: String(label) }) };
      })
      .filter((point): point is { x: number; y: number; label?: string } => point !== null);
    const points = allPoints.slice(0, 300);
    const scatterNote = allPoints.length > points.length ? `散点共 ${allPoints.length} 个，仅展示前 300 个；如需全量请聚合或加 LIMIT。` : undefined;
    if (allPoints.length < 2) {
      throw new DbError('散点图至少需要 2 个 x/y 同时为数值的数据点；请显式指定数值列 x、y', { code: 'EMPTY_SERIES' });
    }
    const chart = {
      type,
      title: title ?? `${y} vs ${x}`,
      xLabel: x,
      yLabel: y,
      sql,
      series: points.slice(0, 24).map((point) => ({ label: point.label ?? String(point.x), value: point.y })),
      scatter: points,
      ...(scatterNote ? { note: scatterNote } : {}),
    };
    return ok(started, `已生成散点图（${points.length} 个点）${scatterNote ? `；${scatterNote}` : ''}`, { chart, columns, rows, chartSql: sql });
  }

  const usableAll = objects.filter((row) => {
    const value = row[y];
    if (value === null || value === undefined || value === '') return false;
    return Number.isFinite(typeof value === 'number' ? value : Number(String(value).trim()));
  });
  // line 要看全趋势，上限放宽；其余类型以一屏可读为准。截断必须显式注记，不能静默丢数据。
  const cap = type === 'line' ? 200 : 24;
  const usable = usableAll.slice(0, cap);
  const series = toSeries(usable, x, y).map((point) => ({ label: point.label || '—', value: point.value }));
  if (!series.length) {
    throw new DbError('图表没有有效数据点：检查 x/y 列与 NULL 值', { code: 'EMPTY_SERIES' });
  }
  const extraSeries = (extraNames ?? [])
    .filter((name) => name !== y && name !== x && columns.some((column) => column.name === name))
    .map((name) => ({
      name,
      values: usable.map((row) => {
        const value = Number(String(row[name] ?? '').trim());
        return Number.isFinite(value) ? value : 0;
      }),
    }));
  if (type === 'radar' && series.length < 3) {
    throw new DbError('雷达图至少需要 3 个类别轴（结果行数不足）', { code: 'EMPTY_SERIES' });
  }
  // 数据形态是权威的：模型点错类型时在这里确定性降级，并把原因写进图表与工具记录，
  // 避免「工具记录说饼图、界面却画出柱状图」的两套事实。
  const fit = chartSuitability({ series, extraSeries });
  let selectedType = type;
  let correctionNote: string | undefined;
  if (!fit[type].ok && (type === 'pie' || type === 'radar' || type === 'stacked' || type === 'line')) {
    const recommended = recommendChartType(fit);
    selectedType = recommended && recommended !== 'scatter' && recommended !== 'heatmap' ? recommended : 'bar';
    correctionNote = `${CHART_KIND_LABELS[type]}不适配当前数据：${fit[type].reason ?? '形态不符'}；已改用${CHART_KIND_LABELS[selectedType]}。`;
  }
  const truncNote = usableAll.length > usable.length ? `数据共 ${usableAll.length} 行，按 SQL 顺序仅展示前 ${usable.length} 行；完整数据请先聚合/分桶或在 SQL 里 LIMIT。` : undefined;
  const note = [correctionNote, truncNote].filter(Boolean).join(' ') || undefined;
  const keepStacked = (selectedType === 'stacked' || (selectedType === 'bar' && stacked)) && extraSeries.length > 0;
  const chart = {
    type: selectedType,
    title: title ?? (selectedType === 'radar' ? `${y} 等 ${series.length} 项指标` : `${y} by ${x}`),
    xLabel: x,
    yLabel: y,
    sql,
    series,
    ...(extraSeries.length ? { extraSeries } : {}),
    ...(keepStacked ? { stacked: true } : {}),
    ...(note ? { note } : {}),
  };
  const summaryType = selectedType === 'pie' ? '饼' : selectedType === 'stacked' ? '堆叠柱' : CHART_KIND_LABELS[selectedType].replace(/图$/, '');
  return ok(started, `已生成${summaryType}图（${selectedType === 'radar' ? `${series.length} 个轴` : `${series.length} 个数据点`}）${note ? `；${note}` : ''}`, {
    chart,
    columns,
    rows,
    chartSql: sql,
  });
}

/**
 * 热力图不是 (x, y) 序列：需要两个分类轴 + 一个数值度量。
 * 同格多行按求和合并；轴数量封顶，避免把 500 行明细塞成不可读的细格子。
 */
async function renderHeatmap(s: ExecutorServices,
  conn: ConnectionConfig,
  database: string | undefined,
  sqlText: string,
  title: string | undefined,
  xName: string | undefined,
  yName: string | undefined,
  valueName: string | undefined,
  started: number,
  executionId?: string,
): Promise<ToolResult> {
  const { sql, set, names, objects } = await chartQuery(s, conn, database, sqlText, executionId);
  const isNumeric = (name: string) => objects.some((row) => {
    const value = row[name];
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(String(value).trim()));
  });
  const numeric = names.filter(isNumeric);
  const textColumns = names.filter((name) => !numeric.includes(name));
  const x = xName && names.includes(xName) ? xName : textColumns.find((name) => name !== valueName) ?? names[0];
  const y = yName && names.includes(yName) ? yName : names.find((name) => name !== x && name !== valueName && !numeric.includes(name)) ?? names.find((name) => name !== x);
  const value = valueName && names.includes(valueName) ? valueName : numeric.find((name) => name !== x && name !== y);
  if (!x || !y || !value || new Set([x, y, value]).size < 3) {
    throw new DbError('热力图需要 x、y 两个分类列和一个数值 value 列', { code: 'INVALID_CHART' });
  }
  const xLabels: string[] = [];
  const yLabels: string[] = [];
  const cells = new Map<string, number>();
  const XCAP = 20;
  const YCAP = 16;
  for (const row of objects) {
    const rawX = row[x];
    const rawY = row[y];
    const rawValue = row[value];
    if (rawX === null || rawX === undefined || rawX === '' || rawY === null || rawY === undefined || rawY === '') continue;
    const numericValue = Number(String(rawValue ?? '').trim());
    if (!Number.isFinite(numericValue) || rawValue === null || rawValue === '') continue;
    const xKey = String(rawX);
    const yKey = String(rawY);
    if (!xLabels.includes(xKey) && xLabels.length < XCAP) xLabels.push(xKey);
    if (!yLabels.includes(yKey) && yLabels.length < YCAP) yLabels.push(yKey);
    if (!xLabels.includes(xKey) || !yLabels.includes(yKey)) continue;
    const key = `${yKey}\u0000${xKey}`;
    cells.set(key, (cells.get(key) ?? 0) + numericValue);
  }
  if (!xLabels.length || !yLabels.length || !cells.size) {
    throw new DbError('热力图没有有效的数值格子（检查 x/y/value 列）', { code: 'EMPTY_SERIES' });
  }
  const values = yLabels.map((yKey) => xLabels.map((xKey) => cells.get(`${yKey}\u0000${xKey}`) ?? 0));
  const chart = {
    type: 'heatmap' as const,
    title: title ?? `${value} · ${y} × ${x}`,
    xLabel: x,
    yLabel: y,
    sql,
    // 行合计只用于用户切到柱/折/饼/雷达时的降级显示；热力图本身读 heatmap 矩阵。
    series: yLabels.map((label, row) => ({ label, value: values[row].reduce((sum, cell) => sum + cell, 0) })),
    heatmap: { xLabels, yLabels, values, valueLabel: value },
  };
  return ok(started, `已生成热力图（${yLabels.length} 行 × ${xLabels.length} 列）`, {
    chart,
    columns: set.columns,
    rows: set.rows,
    chartSql: sql,
  });
}

async function analyzeChart(s: ExecutorServices,
  conn: ConnectionConfig,
  database: string | undefined,
  sqlText: string,
  xName: string | undefined,
  yName: string | undefined,
  topN: number | undefined,
  started: number,
  executionId?: string,
): Promise<ToolResult> {
  const { sql, x, y, points } = await chartSeries(s, conn, database, sqlText, xName, yName, executionId);
  if (!points.length) throw new DbError('没有可统计的有效数据点（全为 NULL 或空结果）', { code: 'EMPTY_SERIES' });
  const stats = summarize(points)!;
  const limit = Math.min(20, Math.max(1, Math.trunc(topN ?? 5)));
  const timeSeries = isTimeSeries(points);
  // 环比只保留最近 12 期：500 行全量塞给模型既贵又没人看。
  const recent = timeSeries ? deltas(points).slice(-12) : [];
  const data = {
    x,
    y,
    rowCount: points.length,
    sum: round(stats.sum),
    avg: round(stats.avg),
    min: stats.min,
    max: stats.max,
    argmin: stats.argmin,
    argmax: stats.argmax,
    topShare: topShare(points, limit).map((item) => ({ ...item, value: round(item.value), share: round(item.share, 4) })),
    deltas: recent.map((item) => ({ ...item, value: round(item.value), delta: round(item.delta), ratio: item.ratio === null ? null : round(item.ratio, 4) })),
    isTimeSeries: timeSeries,
    sql,
  };
  return ok(
    started,
    `${points.length} 个数据点：合计 ${round(stats.sum)}，均值 ${round(stats.avg)}，最大 ${stats.argmax}=${stats.max}，最小 ${stats.argmin}=${stats.min}`,
    data,
  );
}

async function forecastChart(s: ExecutorServices,
  conn: ConnectionConfig,
  database: string | undefined,
  sqlText: string,
  xName: string | undefined,
  yName: string | undefined,
  periods: number | undefined,
  method: ForecastMethod | undefined,
  started: number,
  executionId?: string,
): Promise<ToolResult> {
  const { sql, x, y, points } = await chartSeries(s, conn, database, sqlText, xName, yName, executionId);
  const timeSeries = isTimeSeries(points);
  const result = forecastSeries(points, {
    periods,
    method,
    // 时间序列就用「第 N 期之后」，避免编造具体月份标签
    labelFor: (index, all) => (timeSeries ? `第 ${index - all.length + 1} 期后` : `+${index - all.length + 1}`),
  });
  if (!result.ok) {
    throw new DbError(result.message ?? '样本不足，无法预测', { code: result.code ?? 'FORECAST_FAILED' });
  }
  const chart = {
    type: 'line' as const,
    title: `${y} 预测（${result.method === 'linear' ? '线性回归' : '移动平均'}）`,
    xLabel: x,
    yLabel: y,
    sql,
    series: result.original.map((point: StatPoint) => ({ label: point.label || '—', value: point.value })),
    forecast: result.forecast,
    note: result.note,
  };
  return ok(
    started,
    `预测未来 ${result.forecast.length} 期（${result.method === 'linear' ? `线性回归，斜率 ${result.slope}` : `移动平均，窗口 ${result.window}`}，r=${result.r}）`,
    { ...result, chart, chartSql: sql },
  );
}

export const auditDatabaseTool = defineTool('audit_database', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  return auditDatabase(s, conn, s.databaseOf(call, conn), started, ctx.disabledTables, ctx.executionId);
});

export const checkDataQualityTool = defineTool('check_data_quality', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  return checkDataQuality(s, 
    conn,
    s.databaseOf(call, conn),
    String(a.table ?? ''),
    Array.isArray(a.columns) ? (a.columns as string[]) : undefined,
    started,
    ctx.executionId,
  );
});

export const generateDataTool = defineTool('generate_data', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const result = await generateData(s.store, s.manager, {
    connectionId: conn.id,
    database: s.databaseOf(call, conn),
    table: String(a.table ?? ''),
    rows: Math.min(5000, Number(a.rows) || 10),
    dryRun: a.dryRun === true,
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, result.dryRun ? `生成预览 ${result.rowsPreview.length} 行` : `已生成 ${result.inserted} 行数据`, result);
});

export const renderChartTool = defineTool('render_chart', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const chartTypes = ['bar', 'stacked', 'line', 'pie', 'scatter', 'heatmap', 'radar'];
  const type = (chartTypes.includes(String(a.type)) ? String(a.type) : 'bar') as RenderChartType;
  if (type === 'heatmap') {
    return renderHeatmap(s, 
      conn,
      s.databaseOf(call, conn),
      String(a.sql ?? ''),
      typeof a.title === 'string' ? a.title : undefined,
      typeof a.x === 'string' ? a.x : undefined,
      typeof a.y === 'string' ? a.y : undefined,
      typeof a.value === 'string' ? a.value : undefined,
      started,
      ctx.executionId,
    );
  }
  return renderChart(s, 
    conn,
    s.databaseOf(call, conn),
    String(a.sql ?? ''),
    type,
    typeof a.title === 'string' ? a.title : undefined,
    typeof a.x === 'string' ? a.x : undefined,
    typeof a.y === 'string' ? a.y : undefined,
    Array.isArray(a.ys) ? a.ys.filter((value: unknown): value is string => typeof value === 'string').slice(0, 4) : undefined,
    a.stacked === true,
    typeof a.label === 'string' ? a.label : undefined,
    started,
    ctx.executionId,
  );
});

export const analyzeChartTool = defineTool('analyze_chart', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  return analyzeChart(s, conn, s.databaseOf(call, conn), String(a.sql ?? ''), typeof a.x === 'string' ? a.x : undefined, typeof a.y === 'string' ? a.y : undefined, typeof a.topN === 'number' ? a.topN : undefined, started, ctx.executionId);
});

export const forecastChartTool = defineTool('forecast_chart', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  return forecastChart(s, 
    conn,
    s.databaseOf(call, conn),
    String(a.sql ?? ''),
    typeof a.x === 'string' ? a.x : undefined,
    typeof a.y === 'string' ? a.y : undefined,
    typeof a.periods === 'number' ? a.periods : undefined,
    a.method === 'linear' || a.method === 'moving_average' || a.method === 'auto' ? (a.method as ForecastMethod) : undefined,
    started,
    ctx.executionId,
  );
});

export const schemaDiffTool = defineTool('schema_diff', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const sourceId = String(a.sourceConnectionId ?? '');
  const targetId = String(a.targetConnectionId ?? '');
  const diff = await compareSchemas(
    s.store,
    s.manager,
    sourceId,
    typeof a.sourceDatabase === 'string' ? a.sourceDatabase : undefined,
    targetId,
    typeof a.targetDatabase === 'string' ? a.targetDatabase : undefined,
    {
      includeDrops: a.includeDrops !== false,
      tables: Array.isArray(a.tables) ? a.tables.filter((value): value is string => typeof value === 'string') : undefined,
    },
  );
  const destructive = diff.tables.some((table) => table.changes.some((change) => change.destructive));
  return ok(
    started,
    `${diff.tables.length} 张表 · ${diff.summary.statements} 条语句${destructive ? ' · 含破坏性变更' : ''}`,
    diff,
  );
});

export const reconDataTool = defineTool('recon_data', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const level = a.level === 'counts' || a.level === 'fields' ? a.level : 'keys';
  const mapping = {
    mode:
      (a.left as any)?.kind === 'table' && (a.right as any)?.kind === 'table'
        ? 'table-table'
        : (a.left as any)?.kind === 'keyspace' && (a.right as any)?.kind === 'keyspace'
          ? 'keyspace-keyspace'
          : 'table-keyspace',
    left: a.left,
    right: a.right,
    fieldMap: a.fieldMap,
    baseSide: a.baseSide,
    maxKeys: typeof a.maxKeys === 'number' ? a.maxKeys : undefined,
  } as ReconMapping;
  const result = await reconcileData(s.store, s.manager, mapping, level);
  return ok(
    started,
    `${result.summary.comparedKeys} 键 · ${result.summary.missingInRight} 缺失 · ${result.summary.extraInRight} 多余 · ${result.summary.valueChanged} 改值`,
    result,
  );
});
