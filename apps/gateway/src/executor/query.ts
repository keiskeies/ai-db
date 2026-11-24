import {
  aqlQueryFromArgs,
  buildExplain,
  buildSelectTable,
  classifySql,
  cqlQueryFromArgs,
  cypherQueryFromArgs,
  engineMeta,
  isSqlEngine,
  mqlQueryFromArgs,
  quoteIdent,
  redisQueryFromArgs,
  resolveRisk,
  searchQueryFromArgs,
  vectorQueryFromArgs,
  type MqlQuery,
  type QueryResult,
} from '@aidb/core';
import { DbError } from '../drivers';
import { QUALITY_CHECK_TIMEOUT_MS } from '../manager';
import { defineTool, ok, agentTxKey } from './types';

const SENSITIVE = /pass|secret|token|api[_-]?key|phone|mobile|email|ssn|card|身份证|手机|邮箱/i;

export const runSqlTool = defineTool('run_sql', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const sql = String(a.sql ?? '').trim();
  if (!sql) throw new DbError('SQL 不能为空', { code: 'EMPTY_SQL' });
  if (a.dryRun === true) {
    const classification = classifySql(sql, conn.engine);
    return ok(started, '仅编译，未执行', {
      statements: classification.statements.map((s) => s.sql),
      risk: classification.risk,
    });
  }
  const settings = s.getSettings();
  const maxRows = Math.min(5000, Math.max(1, Number(a.maxRows) || settings.defaultLimit));
  const batch = await s.manager.query(conn.id, sql, {
    database: s.databaseOf(call, conn),
    maxRows,
    timeoutMs: settings.queryTimeoutMs,
    // 与用户全局开关取或：参数不覆盖「允许多语句」，也不额外否决它。
    // 放行多语句不等于放宽权限——挡破坏性操作的是 resolveRisk/evaluatePermission，
    // 它们对整段脚本取最高风险，批量和逐条调用得到的判定完全相同。
    allowMulti: settings.allowMultiStatement || a.allowMulti === true,
    autoLimit: settings.autoLimit,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
    // 事务已开启时让语句走被固定的那条连接，否则提交/回滚作用不到。
    sessionId: s.manager.transactionOf(agentTxKey(ctx))?.connectionId === conn.id ? agentTxKey(ctx) : undefined,
  });
  const last = batch.sets[batch.sets.length - 1];
  const summary = last
    ? last.columns.length
      ? `返回 ${last.rowCount} 行${last.truncated ? '（已截断）' : ''}`
      : `影响 ${last.affected ?? 0} 行`
    : '执行完成';
  return ok(started, summary, {
    ...last,
    sets: batch.sets.length > 1 ? batch.sets : undefined,
    messages: batch.messages,
    durationMs: batch.durationMs,
    // 让 UI 工具卡与审计能看出这是一次批量执行，而不是一条语句。
    ...(batch.sets.length > 1 ? { multiStatement: true } : {}),
  });
});

export const runMqlTool = defineTool('run_mql', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  if (conn.engine !== 'mongodb') {
    throw new DbError('run_mql 仅用于 MongoDB 连接', { code: 'UNSUPPORTED_ENGINE', hint: 'SQL 连接请使用 run_sql' });
  }
  const query = mqlQueryFromArgs(a);
  if (!query.collection) throw new DbError('collection 不能为空', { code: 'MQL_COLLECTION' });
  const settings = s.getSettings();
  const maxRows = Math.min(1000, Math.max(1, Number(a.maxRows) || settings.defaultLimit));
  const batch = await s.manager.queryStructured(conn.id, query, {
    database: s.databaseOf(call, conn),
    maxRows,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  const last = batch.sets[0];
  return ok(started, `返回 ${last?.rowCount ?? 0} 条文档`, {
    ...last,
    messages: batch.messages,
    durationMs: batch.durationMs,
  });
});

export const runRedisTool = defineTool('run_redis', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  if (conn.engine !== 'redis') {
    throw new DbError('run_redis 仅用于 Redis 连接', { code: 'UNSUPPORTED_ENGINE', hint: 'SQL 连接请使用 run_sql' });
  }
  const query = redisQueryFromArgs(a);
  if (!query.command.trim()) throw new DbError('command 不能为空', { code: 'REDIS_EMPTY' });
  const settings = s.getSettings();
  const maxRows = Math.min(5000, Math.max(1, Number(a.maxRows) || settings.defaultLimit));
  const batch = await s.manager.queryStructured(conn.id, query, {
    database: s.databaseOf(call, conn),
    maxRows,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  const last = batch.sets[0];
  return ok(started, `返回 ${last?.rowCount ?? 0} 行`, {
    ...last,
    messages: batch.messages,
    durationMs: batch.durationMs,
  });
});

export const runCypherTool = defineTool('run_cypher', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  if (!engineMeta(conn.engine).languages.includes('cypher')) {
    throw new DbError('run_cypher 仅用于 Neo4j/Memgraph/FalkorDB 连接', { code: 'UNSUPPORTED_ENGINE', hint: 'SQL 连接请使用 run_sql' });
  }
  const query = cypherQueryFromArgs(a);
  if (!query.text.trim()) throw new DbError('Cypher 不能为空', { code: 'CYPHER_EMPTY' });
  const settings = s.getSettings();
  const maxRows = Math.min(1000, Math.max(1, Number(a.maxRows) || settings.defaultLimit));
  const batch = await s.manager.queryStructured(conn.id, query, {
    database: s.databaseOf(call, conn),
    maxRows,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  const last = batch.sets[0];
  return ok(started, `返回 ${last?.rowCount ?? 0} 行`, {
    ...last,
    messages: batch.messages,
    durationMs: batch.durationMs,
  });
});

export const runCqlTool = defineTool('run_cql', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  if (conn.engine !== 'cassandra' && conn.engine !== 'scylla') {
    throw new DbError('run_cql 仅用于 Cassandra/ScyllaDB 连接', { code: 'UNSUPPORTED_ENGINE', hint: 'SQL 连接请使用 run_sql' });
  }
  const query = cqlQueryFromArgs(a);
  if (!query.text.trim()) throw new DbError('CQL 不能为空', { code: 'CQL_EMPTY' });
  const settings = s.getSettings();
  const batch = await s.manager.queryStructured(conn.id, query, {
    database: s.databaseOf(call, conn),
    maxRows: Math.min(5000, Math.max(1, Number(a.maxRows) || settings.defaultLimit)),
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  const last = batch.sets[0];
  return ok(started, `返回 ${last?.rowCount ?? 0} 行`, {
    ...last,
    messages: batch.messages,
    durationMs: batch.durationMs,
  });
});

export const runAqlTool = defineTool('run_aql', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  if (!engineMeta(conn.engine).languages.includes('aql')) {
    throw new DbError('run_aql 仅用于 ArangoDB 连接', { code: 'UNSUPPORTED_ENGINE', hint: 'SQL 连接请使用 run_sql' });
  }
  const query = aqlQueryFromArgs(a);
  if (!query.text.trim()) throw new DbError('AQL 不能为空', { code: 'AQL_EMPTY' });
  const settings = s.getSettings();
  const batch = await s.manager.queryStructured(conn.id, query, {
    database: s.databaseOf(call, conn),
    maxRows: Math.min(5000, Math.max(1, Number(a.maxRows) || settings.defaultLimit)),
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  const last = batch.sets[0];
  return ok(started, `返回 ${last?.rowCount ?? 0} 行`, {
    ...last,
    messages: batch.messages,
    durationMs: batch.durationMs,
  });
});

export const vectorSearchTool = defineTool('vector_search', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const query = vectorQueryFromArgs(a);
  if (!query.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
  const settings = s.getSettings();
  const result = await s.manager.vectorSearch(conn.id, query, {
    database: s.databaseOf(call, conn),
    maxRows: query.topK,
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  return ok(started, `返回 ${result.rowCount} 个向量结果`, { ...result });
});

export const searchIndexTool = defineTool('search_index', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const index = String(a.index ?? '').trim();
  if (!index) throw new DbError('index 不能为空', { code: 'SEARCH_INDEX' });
  const query = searchQueryFromArgs({ ...a, index });
  const settings = s.getSettings();
  const batch = await s.manager.queryStructured(conn.id, query, {
    database: s.databaseOf(call, conn),
    maxRows: Math.min(10000, Math.max(1, Number(a.size) || settings.defaultLimit)),
    timeoutMs: settings.queryTimeoutMs,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  const last = batch.sets[0];
  return ok(started, `返回 ${last?.rowCount ?? 0} 条命中`, {
    ...last,
    messages: batch.messages,
    durationMs: batch.durationMs,
  });
});

export const explainSqlTool = defineTool('explain_sql', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const sql = String(a.sql ?? '').trim();
  if (!sql) throw new DbError('SQL 不能为空');
  if (conn.engine === 'sqlserver') {
    throw new DbError('SQL Server 暂不支持自动 EXPLAIN，请在 SSMS 中查看实际执行计划', {
      code: 'EXPLAIN_UNSUPPORTED',
      hint: '可以改用 audit_database / 索引检查，或粘贴执行计划 XML 让 AI 解读',
    });
  }
  const explain = buildExplain(conn.engine, sql);
  const script =
    conn.engine === 'oracle'
      ? `${explain};
SELECT PLAN_TABLE_OUTPUT AS plan FROM TABLE(DBMS_XPLAN.DISPLAY())`
      : explain;
  const batch = await s.manager.query(conn.id, script, {
    database: s.databaseOf(call, conn),
    maxRows: 200,
    allowMulti: conn.engine === 'oracle',
    autoLimit: false,
    actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
  });
  const last = batch.sets[batch.sets.length - 1];
  return ok(started, '执行计划已生成', { sql: explain, plan: last?.rows ?? [], columns: last?.columns ?? [] });
});

export const sampleRowsTool = defineTool('sample_rows', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const tableName = String(a.table ?? '');
  if (!tableName) throw new DbError('table 不能为空');
  const { table } = await s.manager.findTable(conn.id, database, tableName);
  const limit = Math.min(100, Math.max(1, Number(a.limit) || 10));
  if (engineMeta(conn.engine).languages.includes('cypher')) {
    const label = table.name.replace(/`/g, '``');
    const text =
      table.kind === 'edge_label'
        ? `MATCH ()-[r:\`${label}\`]->() RETURN r LIMIT ${limit}`
        : `MATCH (n:\`${label}\`) RETURN n LIMIT ${limit}`;
    const batch = await s.manager.queryStructured(conn.id, { language: 'cypher', text }, {
      database,
      maxRows: limit,
      timeoutMs: s.getSettings().queryTimeoutMs,
      actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
    });
    const result = batch.sets[0];
    if (result && a.maskSensitive !== false) {
      const sensitive = result.columns.map((c) => SENSITIVE.test(c.name));
      result.rows = result.rows.map((row) => row.map((v, i) => (sensitive[i] && v !== null ? '••••' : v)));
    }
    return ok(started, `读取 ${result?.rowCount ?? 0} 行样例`, { object: table.name, ...result });
  }
  if (engineMeta(conn.engine).languages.includes('aql')) {
    const text = `FOR d IN @@collection LIMIT ${limit} RETURN d`;
    const batch = await s.manager.queryStructured(conn.id, { language: 'aql', text, params: { '@collection': table.name } }, {
      database,
      maxRows: limit,
      timeoutMs: s.getSettings().queryTimeoutMs,
      actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
    });
    const result = batch.sets[0];
    if (result && a.maskSensitive !== false) {
      const sensitive = result.columns.map((c) => SENSITIVE.test(c.name));
      result.rows = result.rows.map((row) => row.map((v, i) => (sensitive[i] && v !== null ? '••••' : v)));
    }
    return ok(started, `读取 ${result?.rowCount ?? 0} 行样例`, { object: table.name, ...result });
  }
  if (conn.engine === 'mongodb') {
    const query: MqlQuery = { language: 'mql', collection: table.name, op: 'find', limit };
    const batch = await s.manager.queryStructured(conn.id, query, {
      database,
      maxRows: limit,
      timeoutMs: s.getSettings().queryTimeoutMs,
      actor: 'agent',
    executionId: ctx.executionId,
    signal: ctx.signal,
    });
    const result = batch.sets[0];
    if (result && a.maskSensitive !== false) {
      const sensitive = result.columns.map((c) => SENSITIVE.test(c.name));
      result.rows = result.rows.map((row) => row.map((v, i) => (sensitive[i] && v !== null ? '••••' : v)));
    }
    return ok(started, `读取 ${result?.rowCount ?? 0} 条文档样例`, { collection: table.name, ...result });
  }
  if (!isSqlEngine(conn.engine)) {
    const hint =
      ['qdrant', 'milvus', 'weaviate'].includes(conn.engine)
        ? '请使用 vector_search 或 run_sql（JSON）查看向量点'
        : ['elasticsearch', 'opensearch'].includes(conn.engine)
          ? '请使用 search_index 或 run_sql（JSON DSL）查看文档'
          : ['redis', 'falkordb'].includes(conn.engine)
            ? '请使用 run_redis 查看键值'
            : ['neo4j', 'memgraph'].includes(conn.engine)
              ? '请使用 run_cypher 查看图数据'
              : ['cassandra', 'scylla'].includes(conn.engine)
                ? '请使用 run_cql 查看表数据'
                : conn.engine === 'arangodb'
                  ? '请使用 run_aql 查看集合数据'
                  : '请使用该引擎对应的查询工具查看数据';
    throw new DbError(`${engineMeta(conn.engine).label} ${hint}`, { code: 'UNSUPPORTED_ENGINE' });
  }
  const sql = buildSelectTable(conn.engine, table.name, { schema: s.schemaFor(conn, table), limit });
  // G2：样例查询此前漏传 timeoutMs，走驱动默认值不受设置约束；普通查询用现有默认口径。
  const batch = await s.manager.query(conn.id, sql, { database, maxRows: limit, allowMulti: false, autoLimit: false, actor: 'agent', timeoutMs: s.getSettings().queryTimeoutMs, executionId: ctx.executionId });
  const result = batch.sets[0];
  if (result && a.maskSensitive !== false) {
    const sensitive = result.columns.map((c) => SENSITIVE.test(c.name));
    result.rows = result.rows.map((row) => row.map((v, i) => (sensitive[i] && v !== null ? '••••' : v)));
  }
  return ok(started, `读取 ${result?.rowCount ?? 0} 行样例`, { table: table.name, ...result });
});

export const profileColumnTool = defineTool('profile_column', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const tableName = String(a.table ?? '');
  const column = String(a.column ?? '');
  const { table } = await s.manager.findTable(conn.id, database, tableName);
  if (!(table.columns ?? []).some((c) => c.name === column)) throw new DbError(`列不存在：${column}`);
  const ref = s.ref(conn.engine, table);
  const col = quoteIdent(column, conn.engine);
  const run = async (sql: string): Promise<QueryResult> => {
    // G2：画像含 COUNT DISTINCT 全表聚合，此前漏传超时；质检口径 120s。
    const batch = await s.manager.query(conn.id, sql, { database, maxRows: 20, allowMulti: false, autoLimit: false, actor: 'agent', timeoutMs: QUALITY_CHECK_TIMEOUT_MS, executionId: ctx.executionId });
    return batch.sets[0];
  };
  const overview = await run(`SELECT COUNT(*) AS total, SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS nulls FROM ${ref}`);
  const distinct = await run(`SELECT COUNT(DISTINCT ${col}) AS distinct_count FROM ${ref}`);
  const top = await run(`SELECT ${col} AS value, COUNT(*) AS count FROM ${ref} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC LIMIT 5`);
  const range = await run(`SELECT MIN(${col}) AS min_value, MAX(${col}) AS max_value FROM ${ref}`);
  const total = Number(overview.rows[0]?.[0] ?? 0);
  const nulls = Number(overview.rows[0]?.[1] ?? 0);
  return ok(started, `${table.name}.${column} 画像完成`, {
    table: table.name,
    column,
    total,
    nulls,
    nullRatio: total ? Number((nulls / total).toFixed(4)) : 0,
    distinct: Number(distinct.rows[0]?.[0] ?? 0),
    top: top.rows.map((r) => ({ value: r[0], count: r[1] })),
    min: range.rows[0]?.[0] ?? null,
    max: range.rows[0]?.[1] ?? null,
  });
});
