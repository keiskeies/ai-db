import {
  applyMapRule,
  buildCreateTable,
  buildDeleteMany,
  buildInsert,
  buildTruncate,
  columnsOf,
  evaluateExpression,
  mapRuleFromValues,
  normalizeColumnType,
  pipelineStepKind,
  queryJsonPath,
  resolveBinding,
  type ConnectionConfig,
  type PipelineRow,
  type PipelineStep,
  type TableInfo,
} from '@aidb/core';
import path from 'node:path';
import { asStringMap, emptyOutput, PipelineError, text, toInteger, type StepContext, type StepOutput } from './types';
import { httpRequest, responseValue } from './http';
import { renderJsonTemplate } from './template';
import { checkPython, runScript } from './script';

/**
 * 八类步骤的执行体。统一签名「已绑定的配置 + 上一步输出 + 上下文」→
 * {rows, columns, raw, meta, state, preview}。编排器只按类型分发，不认识细节。
 */

type Values = Record<string, unknown>;

/** 脚本正文不做绑定：JS/Python 源码里出现 `{{` 是合法的，不能被当成占位符。 */
export function resolveStepValues(step: PipelineStep, scope: Record<string, unknown>): Values {
  const kind = pipelineStepKind(step.type);
  const out: Values = {};
  for (const [key, value] of Object.entries(step.with ?? {})) {
    const raw = value ?? kind?.fields.find((field) => field.key === key)?.default;
    if (raw === undefined) continue;
    if (key === 'code' && (step.type === 'script.js' || step.type === 'script.py')) {
      out[key] = raw;
      continue;
    }
    try {
      out[key] = resolveBinding(raw, scope);
    } catch (err: any) {
      throw new PipelineError(`${step.id} 的 ${key} 绑定失败：${err?.message ?? err}`, 'PIPELINE_BINDING', '检查 {{ }} 里的名字是否存在于 params/state/run/steps');
    }
  }
  return out;
}

export type StepHandler = (values: Values, input: StepOutput, ctx: StepContext, step: PipelineStep) => Promise<StepOutput>;

function selectValue(value: unknown, selector?: string): unknown {
  const expression = (selector ?? '$').trim();
  if (!expression || expression === '$') return value;
  try {
    const matches = queryJsonPath(value, expression);
    if (matches.length === 1) return matches[0];
    return matches;
  } catch (err: any) {
    throw new PipelineError(`JSONPath ${expression} 无法解析：${err?.message ?? err}`, 'PIPELINE_JSONPATH');
  }
}

function rowsOf(value: unknown): PipelineRow[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    const out: PipelineRow[] = [];
    for (const item of value) {
      if (Array.isArray(item)) out.push(...rowsOf(item));
      else if (item && typeof item === 'object') out.push(item as PipelineRow);
      else out.push({ value: item });
    }
    return out;
  }
  if (typeof value === 'object') return [value as PipelineRow];
  return [{ value }];
}

function output(rows: PipelineRow[], extra?: Partial<StepOutput>): StepOutput {
  return { rows, columns: columnsOf(rows), ...extra };
}

function connectionOf(ctx: StepContext, id: unknown, purpose: string): ConnectionConfig {
  const connectionId = text(id);
  if (!connectionId) throw new PipelineError(`${purpose}没有选择连接`, 'PIPELINE_NO_CONNECTION');
  const conn = ctx.store.getConnection(connectionId);
  if (!conn) throw new PipelineError(`${purpose}的连接不存在（${connectionId}）`, 'PIPELINE_CONNECTION_MISSING', '连接可能已被删除，请在步骤里重新选择');
  return conn;
}

// ---------- 源：HTTP 接口 ----------

async function httpFetch(values: Values, _input: StepOutput, ctx: StepContext): Promise<StepOutput> {
  const url = text(values.url);
  if (!url) throw new PipelineError('HTTP 取数缺少请求地址', 'PIPELINE_NO_URL');
  const method = text(values.method, 'GET').toUpperCase();
  const headers = asStringMap(values.headers);
  const maxRows = toInteger(values.maxRows, 20000, 1, 200000);
  const maxPages = toInteger(values.maxPages, 20, 1, 200);
  const timeoutMs = toInteger(values.timeoutMs, 15000, 1000, 120000);
  const paginate = text(values.paginate, 'none');
  const extract = text(values.extract, '$');
  const pageSize = toInteger(values.pageSize, 200, 1, 5000);
  const credentialId = text(values.credential);
  const auth = {
    mode: text(values.auth, 'none'),
    credential: credentialId ? ctx.credential(credentialId) : null,
    field: text(values.authField, 'Authorization'),
  };
  const bodyValue = typeof values.body === 'string' && values.body.trim() ? renderJsonTemplate(values.body, ctx.scope) : undefined;

  const baseQuery: Record<string, unknown> = {};
  const stateParam = text(values.stateParam);
  const bookmark = ctx.state.max ?? ctx.state.bookmark;
  if (stateParam && bookmark !== undefined && bookmark !== '') baseQuery[stateParam] = bookmark;

  const collected: PipelineRow[] = [];
  let cursor: unknown;
  let pages = 0;
  let bytes = 0;
  let status = 0;
  // 不翻页时只发一次请求；maxPages 只对 page/cursor 两种模式有意义。
  const totalPages = paginate === 'page' || paginate === 'cursor' ? maxPages : 1;

  for (let page = 1; page <= totalPages; page += 1) {
    if (ctx.shouldAbort()) throw new PipelineError('数据流已取消', 'PIPELINE_ABORTED');
    const query: Record<string, unknown> = { ...baseQuery };
    if (paginate === 'page') {
      query[text(values.pageParam, 'page')] = page;
      query[text(values.sizeParam, 'page_size')] = pageSize;
    } else if (paginate === 'cursor' && cursor !== undefined && cursor !== null && cursor !== '') {
      query[text(values.cursorParam, 'cursor')] = cursor;
    }
    const response = await httpRequest({ url, method, headers, query, body: bodyValue, timeoutMs, auth });
    pages += 1;
    bytes += response.bytes;
    status = response.status;
    const value = responseValue(response);
    const rows = rowsOf(selectValue(value, extract));
    collected.push(...rows);
    if (paginate === 'cursor') {
      cursor = selectValue(value, text(values.cursorPath, '$.next_cursor'));
      if (cursor === undefined || cursor === null || cursor === '') break;
    }
    if (!rows.length || (paginate === 'page' && rows.length < pageSize) || collected.length >= maxRows) break;
  }

  const rows = collected.slice(0, maxRows);
  const stateField = text(values.stateField);
  const state = stateField ? { max: maxValue(rows, stateField) ?? bookmark } : undefined;
  return output(rows, {
    raw: rows,
    state,
    meta: { status, pages, bytes, truncated: collected.length > rows.length },
  });
}

/** 增量断点：数字取数值最大，日期/文本按字典序最大（ISO 串天然可比）。 */
function maxValue(rows: PipelineRow[], field: string): string | number | undefined {
  let best: string | number | undefined;
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = typeof raw === 'number' ? raw : String(raw);
    if (best === undefined) {
      best = value;
      continue;
    }
    if (typeof value === 'number' && typeof best === 'number') {
      if (value > best) best = value;
      continue;
    }
    if (String(value) > String(best)) best = value;
  }
  return best;
}

// ---------- 源：数据库查询 ----------

async function dbQuery(values: Values, _input: StepOutput, ctx: StepContext): Promise<StepOutput> {
  const conn = connectionOf(ctx, values.connectionId, '取数');
  const sql = text(values.sql);
  if (!sql.trim()) throw new PipelineError('查询步骤缺少 SQL', 'PIPELINE_NO_SQL');
  const batch = await ctx.manager.query(conn.id, sql, {
    database: text(values.database) || undefined,
    maxRows: toInteger(values.maxRows, 5000, 1, 200000),
    allowMulti: false,
    autoLimit: false,
    timeoutMs: ctx.settings.queryTimeoutMs,
    actor: 'user',
  });
  const set = batch.sets[batch.sets.length - 1];
  if (!set) return emptyOutput();
  const columns = set.columns.map((column) => column.name);
  const rows = set.rows.map((row) => {
    const record: PipelineRow = {};
    columns.forEach((name, index) => {
      record[name] = row[index];
    });
    return record;
  });
  // 增量字段可以来自 SQL：取本次结果的最大值作为断点，下次 SQL 里的 {{ state.max }} 就有了。
  const stateField = text(values.stateField);
  const state = stateField ? { max: maxValue(rows, stateField) ?? ctx.state.max } : undefined;
  return output(rows, { raw: rows, state, meta: { sets: batch.sets.length, affected: set.affected, durationMs: batch.durationMs } });
}

// ---------- 变换 ----------

async function mapStep(values: Values, input: StepOutput): Promise<StepOutput> {
  try {
    const result = applyMapRule(input.rows, mapRuleFromValues(values));
    return { rows: result.rows, columns: result.columns, raw: result.rows, meta: { inRows: input.rows.length, dropped: result.dropped } };
  } catch (err: any) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(err?.message ?? String(err), 'PIPELINE_MAP', 'map 的过滤与投影使用表达式语言，@ 指向当前行');
  }
}

async function sqlStep(values: Values, input: StepOutput, ctx: StepContext): Promise<StepOutput> {
  if (!input.rows.length) {
    return { rows: [], columns: [], raw: [], meta: { note: '上一步没有数据，SQL 步骤跳过' } };
  }
  const session = await ctx.duckdb();
  if (!(await session.loadRows(input.rows))) return emptyOutput();
  const result = await session.query(text(values.sql), toInteger(values.maxRows, 20000, 1, 200000));
  return { rows: result.rows, columns: result.columns, raw: result.rows, meta: { engine: 'duckdb' } };
}

async function scriptStep(runtime: 'node' | 'python', values: Values, input: StepOutput, ctx: StepContext, step: PipelineStep): Promise<StepOutput> {
  if (ctx.settings.features.pipelineScripts !== true) {
    throw new PipelineError('脚本步骤未开启', 'PIPELINE_SCRIPTS_DISABLED', '在 工具箱 → 数据流处理 顶部打开「允许脚本步骤」后再运行');
  }
  if (runtime === 'python') {
    const probe = await checkPython();
    if (!probe.ok) throw new PipelineError('本机没有可用的 Python 解释器', 'PIPELINE_PYTHON_MISSING', `检测命令：${probe.command}；可用 AIDB_PYTHON 指定路径`);
  }
  const code = text(values.code);
  if (!code.trim()) throw new PipelineError('脚本步骤没有内容', 'PIPELINE_NO_CODE');
  const result = await runScript({
    runtime,
    code,
    dir: path.join(ctx.workDir, `script-${step.id}`),
    payload: { rows: input.rows, columns: input.columns, params: ctx.params, state: ctx.state, run: { ...ctx.run } },
    timeoutMs: toInteger(values.timeoutMs, 30000, 1000, 120000),
    maxRows: toInteger(values.maxRows, 50000, 1, 200000),
  });
  return output(result.rows, {
    raw: result.rows,
    state: result.state,
    meta: { runtime, durationMs: result.durationMs, truncated: result.truncated, stderrBytes: result.stderr.length },
  });
}

// ---------- 目标：数据库写入 ----------

function cellValue(expression: string, row: PipelineRow): unknown {
  try {
    return evaluateExpression(expression, { current: row, root: row });
  } catch {
    return row[expression];
  }
}

/** 驱动只吃标量：嵌套结构按 JSON 文本落库，比静默丢失或报类型错误更可预期。 */
function dbValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function inferType(values: unknown[]): string {
  const sample = values.filter((value) => value !== null && value !== undefined).slice(0, 200);
  if (!sample.length) return 'TEXT';
  if (sample.every((value) => typeof value === 'boolean')) return 'BOOLEAN';
  if (sample.every((value) => typeof value === 'number')) return sample.every((value) => Number.isInteger(value)) ? 'BIGINT' : 'DOUBLE';
  if (sample.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value))) return 'TIMESTAMP';
  return 'TEXT';
}

function defaultSchema(conn: ConnectionConfig): string | undefined {
  if (conn.engine === 'sqlserver') return 'dbo';
  if (conn.engine === 'postgresql' || conn.engine === 'cockroachdb') return 'public';
  return undefined;
}

function schemaFor(conn: ConnectionConfig, table?: TableInfo, fallback?: string): string | undefined {
  return table?.schema || fallback || defaultSchema(conn);
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  if (value && typeof value === 'object') return Object.keys(value as object);
  return [];
}

async function findTable(ctx: StepContext, conn: ConnectionConfig, database: string | undefined, name: string): Promise<TableInfo | undefined> {
  const schemas = await ctx.manager.schema(conn.id, database, false);
  return schemas.flatMap((schema) => schema.tables).find((table) => table.name.toLowerCase() === name.toLowerCase());
}

async function dbWrite(values: Values, input: StepOutput, ctx: StepContext): Promise<StepOutput> {
  const conn = connectionOf(ctx, values.connectionId, '写入');
  if (conn.readonly) throw new PipelineError(`连接「${conn.name}」是只读的`, 'PIPELINE_READONLY_CONNECTION', '在连接设置里关闭只读后才能写入');
  const table = text(values.table).trim();
  if (!table) throw new PipelineError('写入步骤没有指定目标表', 'PIPELINE_NO_TABLE');
  const mode = text(values.mode, 'append');
  const database = text(values.database) || conn.database || undefined;
  const batchRows = toInteger(values.batchRows, 200, 1, 1000);
  const mapping = asStringMap(values.columns);
  const overrides = asStringMap(values.types);

  let rows = input.rows;
  let columns: string[];
  if (Object.keys(mapping).length) {
    columns = Object.keys(mapping);
    rows = rows.map((row) => {
      const record: PipelineRow = {};
      for (const [target, expression] of Object.entries(mapping)) record[target] = cellValue(expression, row);
      return record;
    });
  } else {
    columns = columnsOf(rows);
  }
  if (!columns.length) {
    return { rows: [], columns: [], raw: [], meta: { note: '没有可写入的列', mode } };
  }

  const target = await findTable(ctx, conn, database, table);
  const willCreate = !target && values.createMissing !== false;
  if (!target && !willCreate) throw new PipelineError(`目标库里没有表 ${table}`, 'PIPELINE_TABLE_MISSING', '打开「缺表自动创建」或先建表');

  const targetColumns = new Set((target?.columns ?? []).map((column) => column.name.toLowerCase()));
  if (targetColumns.size) {
    const missing = columns.filter((column) => !targetColumns.has(column.toLowerCase()));
    if (missing.length) throw new PipelineError(`目标表 ${table} 缺少列：${missing.join('、')}`, 'PIPELINE_COLUMN_MISSING', '在列映射里把源字段改成目标表已有的列名');
  }

  const keys = asStringList(values.keyColumns).filter(Boolean);
  if (mode === 'delete_insert' && !keys.length) throw new PipelineError('先删后插需要指定主键列', 'PIPELINE_NO_KEYS');
  if (mode === 'delete_insert' && keys.length) {
    // 建表前就要挡住：否则第一次运行静默建出一张没有该主键的表，第二次才报错，最难查。
    const writable = new Set(columns.map((column) => column.toLowerCase()));
    const outside = keys.filter((key) => !writable.has(key.toLowerCase()));
    if (outside.length) {
      throw new PipelineError(
        target ? `目标表 ${table} 里没有主键列：${outside.join('、')}` : `主键列不在要写入的数据里：${outside.join('、')}`,
        'PIPELINE_KEY_UNKNOWN',
        `可写的列：${columns.slice(0, 12).join('、')}`,
      );
    }
  }

  const schema = schemaFor(conn, target);
  const tableName = target?.name ?? table;
  const createDdl = willCreate
    ? buildCreateTable(conn.engine, {
        table,
        columns: columns.map((column) => ({
          name: column,
          type: normalizeColumnType(conn.engine, overrides[column] ?? inferType(rows.map((row) => row[column]))),
          nullable: !(mode === 'delete_insert' && keys.includes(column)),
          primaryKey: keys.includes(column),
          autoIncrement: false,
        })),
        schema,
      })
    : '';
  const preview = [
    createDdl,
    mode === 'delete_insert' && target && keys.length ? buildDeleteMany(conn.engine, tableName, keys, Math.min(2, rows.length), schema) : '',
    mode === 'replace' && target ? buildTruncate(conn.engine, tableName, schema) : '',
    buildInsert(conn.engine, tableName, columns, Math.min(batchRows, Math.max(1, rows.length)), schema),
  ].join('\n');

  if (ctx.previewOnly || values.dryRun === true) {
    return { rows, columns, raw: rows, preview, meta: { mode, table: tableName, batches: Math.ceil(rows.length / batchRows), dryRun: true } };
  }

  if (willCreate) {
    await ctx.manager.query(conn.id, createDdl, { database, allowMulti: false, autoLimit: false, actor: 'user' });
  }
  if (mode === 'replace' && target) {
    await ctx.manager.query(conn.id, buildTruncate(conn.engine, tableName, schema), { database, allowMulti: false, autoLimit: false, actor: 'user' });
  }

  let written = 0;
  let batches = 0;
  for (let offset = 0; offset < rows.length; offset += batchRows) {
    if (ctx.shouldAbort()) throw new PipelineError('数据流已取消', 'PIPELINE_ABORTED');
    const chunk = rows.slice(offset, offset + batchRows);
    if (mode === 'delete_insert' && keys.length && target) {
      const deleteParams: unknown[] = [];
      for (const row of chunk) for (const key of keys) deleteParams.push(dbValue(row[key] ?? keySource(row, key, mapping)));
      await ctx.manager.runParams(conn.id, buildDeleteMany(conn.engine, tableName, keys, chunk.length, schema), deleteParams, { database, actor: 'user' });
    }
    const params: unknown[] = [];
    for (const row of chunk) for (const column of columns) params.push(dbValue(row[column]));
    await ctx.manager.runParams(conn.id, buildInsert(conn.engine, tableName, columns, chunk.length, schema), params, { database, actor: 'user' });
    written += chunk.length;
    batches += 1;
  }

  return output(rows, { preview, meta: { mode, table: tableName, written, batches, created: willCreate, columns } });
}

function keySource(row: PipelineRow, key: string, mapping: Record<string, string>): unknown {
  const source = Object.entries(mapping).find(([target]) => target.toLowerCase() === key.toLowerCase())?.[1];
  return source ? row[source] : row[key];
}

// ---------- 目标：HTTP 推送 ----------

async function httpPush(values: Values, input: StepOutput, ctx: StepContext): Promise<StepOutput> {
  const url = text(values.url);
  if (!url) throw new PipelineError('推送步骤缺少请求地址', 'PIPELINE_NO_URL');
  const method = text(values.method, 'POST').toUpperCase();
  const headers = asStringMap(values.headers);
  const credentialId = text(values.credential);
  const auth = {
    mode: text(values.auth, 'none'),
    credential: credentialId ? ctx.credential(credentialId) : null,
    field: text(values.authField, 'Authorization'),
  };
  const batchRows = toInteger(values.batchRows, 50, 1, 2000);
  const timeoutMs = toInteger(values.timeoutMs, 15000, 1000, 120000);
  const concurrency = toInteger(values.concurrency, 2, 1, 8);
  const stopOnError = values.stopOnError !== false;
  const template = text(values.bodyMode, 'array') === 'template' && typeof values.body === 'string' ? values.body : undefined;

  const batches: PipelineRow[][] = [];
  for (let offset = 0; offset < input.rows.length; offset += batchRows) batches.push(input.rows.slice(offset, offset + batchRows));

  const renderBody = (batch: PipelineRow[]): unknown => {
    if (!template) return batch;
    return renderJsonTemplate(template, { ...ctx.scope, rows: batch, count: batch.length });
  };
  const previews = batches.slice(0, 2).map((batch) => JSON.stringify(renderBody(batch))).join('\n');

  if (ctx.previewOnly || values.dryRun === true) {
    return { rows: input.rows, columns: input.columns, raw: input.rows, preview: previews, meta: { batches: batches.length, dryRun: true } };
  }

  let posted = 0;
  let failed = 0;
  let firstError: PipelineError | undefined;
  const statuses: number[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= batches.length) return;
      if (failed && stopOnError) return;
      if (ctx.shouldAbort()) throw new PipelineError('数据流已取消', 'PIPELINE_ABORTED');
      const batch = batches[index];
      try {
        const response = await httpRequest({ url, method, headers, body: renderBody(batch), timeoutMs, auth });
        statuses.push(response.status);
        posted += batch.length;
      } catch (err: any) {
        failed += batch.length;
        const error = err instanceof PipelineError ? err : new PipelineError(err?.message ?? String(err), 'PIPELINE_PUSH_FAILED');
        firstError = firstError ?? error;
        if (stopOnError) throw error;
      }
    }
  });
  await Promise.allSettled(workers);
  if (stopOnError && firstError) throw firstError;

  return output(input.rows, {
    raw: input.rows,
    preview: previews,
    meta: { batches: batches.length, posted, failed, statuses: statuses.slice(0, 5), error: failed && !stopOnError ? firstError?.message : undefined },
  });
}

const HANDLERS: Record<string, StepHandler> = {
  'http.fetch': httpFetch,
  'db.query': dbQuery,
  map: (values, input) => mapStep(values, input),
  sql: (values, input, ctx) => sqlStep(values, input, ctx),
  'script.js': (values, input, ctx, step) => scriptStep('node', values, input, ctx, step),
  'script.py': (values, input, ctx, step) => scriptStep('python', values, input, ctx, step),
  'db.write': (values, input, ctx) => dbWrite(values, input, ctx),
  'http.push': (values, input, ctx) => httpPush(values, input, ctx),
};

export async function executeStep(step: PipelineStep, input: StepOutput, ctx: StepContext): Promise<StepOutput> {
  const handler = HANDLERS[step.type];
  if (!handler) throw new PipelineError(`不支持的步骤类型：${step.type}`, 'PIPELINE_STEP_UNKNOWN');
  return handler(resolveStepValues(step, ctx.scope), input, ctx, step);
}
