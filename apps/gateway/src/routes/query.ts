import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { Router } from 'express';
import {
  engineUsesSchema,
  isSqlEngine,
  buildAlterTable,
  buildCount,
  buildCreateTable,
  buildDelete,
  buildDeleteMany,
  buildInsert,
  buildSelectTable,
  buildUpdate,
  quoteIdent,
  type ColumnDef,
  type ForeignKeyInfo,
  type IndexDef,
} from '@aidb/core';
import { EXPORT_QUERY_TIMEOUT_MS } from '../manager';
import { assertExportable, coerceValue, dumpDatabase, exportNeedsStatement, importCsv } from '../services';
import { writeExportFile } from '../xlsx';
import {
  ah,
  exportDownloadUrl,
  str,
  obj,
  num,
  defaultSchema,
  assertSqlEngine,
  classifyForAudit,
  type ApiDeps,
} from './shared';

export function createQueryRouter(deps: ApiDeps): Router {
  const { store, manager, config } = deps;
  const router = Router();

  // ---------- queries ----------
  router.post(
    '/query',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const sql = str(body.sql);
      if (!connectionId || !sql) throw Object.assign(new Error('connectionId 与 sql 必填'), { code: 'INVALID_INPUT', status: 400 });
      const settings = store.getSettings();
      const started = Date.now();
      // G1：客户端提前断开（关页面/主动取消）时必须终止服务端仍在跑的查询，
      // 否则慢查询白占连接与 CPU。注意监听的是 res 而不是 req：请求体读完时
      // req 就会 close（此时响应还没开始写），拿它判「客户端断开」会把正常请求
      // 误杀成提前离场、响应永远不发。res 的 close 才代表连接真的终止，
      // 再用 writableFinished 区分「响应已写完的正常收尾」与「中途断开」。
      const executionId = randomUUID();
      let clientGone = false;
      res.once('close', () => {
        if (res.writableFinished) return;
        clientGone = true;
        manager.cancelExecution(executionId);
      });
      try {
        const batch = await manager.query(connectionId, sql, {
          database: str(body.database),
          maxRows: num(body.limit, settings.defaultLimit, 1, 10000),
          timeoutMs: settings.queryTimeoutMs,
          allowMulti: body.allowMulti === undefined ? settings.allowMultiStatement : Boolean(body.allowMulti),
          autoLimit: settings.autoLimit,
          actor: 'user',
          sessionId: str(body.sessionId),
          executionId,
        });
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'query',
          sql,
          risk: classifyForAudit(sql),
          approval: 'manual',
          status: 'ok',
          durationMs: Date.now() - started,
        });
        if (!clientGone) res.json({ batch });
      } catch (err: any) {
        store.addAudit({
          actor: 'user',
          connectionId,
          database: str(body.database),
          tool: 'query',
          sql,
          risk: classifyForAudit(sql),
          approval: 'manual',
          status: 'error',
          durationMs: Date.now() - started,
          meta: { error: err.message, ...(clientGone ? { canceled: true } : {}) },
        });
        // 客户端已断开，错误响应没有接收方，不再走错误中间件写响应。
        if (clientGone) return;
        throw err;
      }
    }),
  );

  router.post(
    '/tx/begin',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const sessionId = str(body.sessionId);
      if (!connectionId || !sessionId) {
        throw Object.assign(new Error('connectionId 与 sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      }
      const database = str(body.database);
      const result = await manager.beginTransaction(sessionId, connectionId, { database, actor: 'user' });
      store.addAudit({
        actor: 'user',
        connectionId,
        database,
        tool: 'tx.begin',
        sql: 'BEGIN',
        risk: 'write',
        approval: 'manual',
        status: 'ok',
      });
      res.json({ result });
    }),
  );

  router.post(
    '/tx/commit',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const sessionId = str(body.sessionId);
      if (!sessionId) throw Object.assign(new Error('sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const result = await manager.commitTransaction(sessionId);
      store.addAudit({
        actor: 'user',
        tool: 'tx.commit',
        sql: 'COMMIT',
        risk: 'write',
        approval: 'manual',
        status: 'ok',
      });
      res.json({ result });
    }),
  );

  router.post(
    '/tx/rollback',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const sessionId = str(body.sessionId);
      if (!sessionId) throw Object.assign(new Error('sessionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const result = await manager.rollbackTransaction(sessionId);
      store.addAudit({
        actor: 'user',
        tool: 'tx.rollback',
        sql: 'ROLLBACK',
        risk: 'write',
        approval: 'manual',
        status: 'ok',
      });
      res.json({ result });
    }),
  );

  router.get(
    '/data',
    ah(async (req, res) => {
      const connectionId = str(req.query.connectionId);
      const tableName = str(req.query.table);
      if (!connectionId || !tableName) throw Object.assign(new Error('connectionId 与 table 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      assertSqlEngine(conn);
      const database = str(req.query.database);
      const { table } = await manager.findTable(connectionId, database, tableName);
      const limit = num(req.query.limit, 100, 1, 1000);
      const offset = num(req.query.offset, 0, 0, 10_000_000);
      // 多列排序：orderBy=status,total_cents&orderDir=asc,desc，最多 4 列
      const orderCols = (str(req.query.orderBy) ?? '').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 4);
      const directions = String(req.query.orderDir ?? 'asc').split(',').map((value) => value.trim().toLowerCase());
      const orderParts = orderCols
        .map((column, index) => ((table.columns ?? []).some((c) => c.name === column) ? `${quoteIdent(column, conn.engine)} ${directions[index] === 'desc' ? 'DESC' : 'ASC'}` : null))
        .filter((part): part is string => Boolean(part));
      // 未指定排序时按主键升序，确保 offset 分页稳定（否则不同引擎可能重复或漏行）
      const fallbackOrder = (table.columns ?? [])
        .filter((column) => column.primaryKey)
        .map((column) => `${quoteIdent(column.name, conn.engine)} ASC`);
      const orderBy = orderParts.length ? orderParts.join(', ') : fallbackOrder.length ? fallbackOrder.join(', ') : undefined;
      const sql = buildSelectTable(conn.engine, table.name, {
        schema: engineUsesSchema(conn.engine) ? table.schema : undefined,
        where: str(req.query.where),
        orderBy,
        limit,
        offset,
      });
      const batch = await manager.query(connectionId, sql, {
        database,
        maxRows: limit,
        allowMulti: false,
        autoLimit: false,
        actor: 'user',
        timeoutMs: store.getSettings().queryTimeoutMs,
      });
      const countSql = buildCount(conn.engine, table.name, engineUsesSchema(conn.engine) ? table.schema : undefined, str(req.query.where));
      const countBatch = await manager.query(connectionId, countSql, { database, maxRows: 1, allowMulti: false, autoLimit: false, actor: 'user' });
      res.json({
        batch,
        table: table.name,
        total: Number(countBatch.sets[0]?.rows?.[0]?.[0] ?? 0),
        limit,
        offset,
        sql,
      });
    }),
  );

  router.post(
    '/rows',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      const tableName = str(body.table);
      const op = str(body.op);
      if (!connectionId || !tableName || !op) throw Object.assign(new Error('connectionId/table/op 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      assertSqlEngine(conn);
      if (conn.readonly) throw Object.assign(new Error('只读连接禁止修改数据'), { code: 'READONLY', status: 403 });
      const database = str(body.database);
      const { table } = await manager.findTable(connectionId, database, tableName);
      const known = new Set((table.columns ?? []).map((c) => c.name));
      const typeOf = new Map((table.columns ?? []).map((c) => [c.name, c.type]));
      const rejectUnknown = (keys: string[]) => {
        const unknown = keys.filter((column) => !known.has(column));
        if (unknown.length) {
          throw Object.assign(new Error(`列不存在：${unknown.join(', ')}`), { code: 'UNKNOWN_COLUMN', status: 400 });
        }
      };
      const primaryKeys = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
      const requirePrimaryKey = (whereColumns: string[]) => {
        if (!primaryKeys.length) {
          throw Object.assign(new Error('该表没有主键，不能按行更新或删除'), { code: 'NO_PRIMARY_KEY', status: 400 });
        }
        if (whereColumns.length !== primaryKeys.length || primaryKeys.some((name) => !whereColumns.includes(name))) {
          throw Object.assign(new Error(`更新/删除必须使用完整主键：${primaryKeys.join(', ')}`), { code: 'KEY_NOT_PRIMARY', status: 400 });
        }
      };
      const schema = engineUsesSchema(conn.engine) ? table.schema : undefined;
      let sql: string;
      let params: unknown[] = [];
      let risk = 'write';
      if (op === 'insert') {
        const values = obj(body.values, 'values');
        rejectUnknown(Object.keys(values));
        const columns = Object.keys(values).filter((c) => known.has(c));
        if (!columns.length) throw Object.assign(new Error('没有可插入的列'), { code: 'INVALID_INPUT', status: 400 });
        sql = buildInsert(conn.engine, table.name, columns, 1, schema);
        params = columns.map((c) => coerceValue(values[c], typeOf.get(c) ?? 'text'));
      } else if (op === 'insertMany') {
        const records = Array.isArray(body.rows) ? body.rows.filter((row) => row && typeof row === 'object') as Record<string, unknown>[] : [];
        if (!records.length) throw Object.assign(new Error('没有可插入的行'), { code: 'INVALID_INPUT', status: 400 });
        // 与 importCsv 的 5000 行上限对齐，避免一次拼出巨型 INSERT：内存翻倍 + 驱动参数/报文上限（mssql 2100、oracle 65535、mysql max_allowed_packet）。
        if (records.length > 5000) {
          throw Object.assign(new Error('单次插入最多 5000 行，请分页粘贴或分多次复制'), { code: 'TOO_MANY_ROWS', status: 400 });
        }
        rejectUnknown([...new Set(records.flatMap((row) => Object.keys(row)))]);
        const columns = [...new Set(records.flatMap((row) => Object.keys(row)))].filter((c) => known.has(c));
        if (!columns.length) throw Object.assign(new Error('没有可插入的列'), { code: 'INVALID_INPUT', status: 400 });
        // 固定 200 行一批，压力与单行插入路径相当；审计只留摘要，不把整批参数塞进审计表。
        const startedMany = Date.now();
        try {
          let affected = 0;
          for (let start = 0; start < records.length; start += 200) {
            const chunk = records.slice(start, start + 200);
            const batchSql = buildInsert(conn.engine, table.name, columns, chunk.length, schema);
            const batchParams = chunk.flatMap((row) => columns.map((c) => coerceValue(row[c], typeOf.get(c) ?? 'text')));
            const result = await manager.runParams(connectionId, batchSql, batchParams, { database, actor: 'user' });
            affected += result.affected ?? chunk.length;
          }
          store.addAudit({ actor: 'user', connectionId, database, tool: `rows.${op}`, sql: `INSERT INTO ${table.name} ×${records.length} 行`, risk: 'write', approval: 'manual', status: 'ok', durationMs: Date.now() - startedMany, meta: { table: table.name, rows: records.length } });
          res.json({ result: { columns: [], rows: [], rowCount: affected, affected, durationMs: Date.now() - startedMany } });
          return;
        } catch (err: any) {
          store.addAudit({ actor: 'user', connectionId, database, tool: `rows.${op}`, sql: `INSERT INTO ${table.name} ×${records.length} 行`, risk: 'write', approval: 'manual', status: 'error', durationMs: Date.now() - startedMany, meta: { error: err.message, table: table.name, rows: records.length } });
          throw err;
        }
      } else if (op === 'update') {
        const values = obj(body.values, 'values');
        const key = obj(body.key, 'key');
        rejectUnknown(Object.keys(values));
        rejectUnknown(Object.keys(key));
        const setCols = Object.keys(values).filter((c) => known.has(c));
        const whereCols = Object.keys(key).filter((c) => known.has(c));
        if (!setCols.length || !whereCols.length) throw Object.assign(new Error('更新需要 values 与主键 key'), { code: 'INVALID_INPUT', status: 400 });
        requirePrimaryKey(whereCols);
        sql = buildUpdate(conn.engine, table.name, setCols, whereCols, schema);
        params = [...setCols.map((c) => coerceValue(values[c], typeOf.get(c) ?? 'text')), ...whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text'))];
      } else if (op === 'delete') {
        const key = obj(body.key, 'key');
        rejectUnknown(Object.keys(key));
        const whereCols = Object.keys(key).filter((c) => known.has(c));
        if (!whereCols.length) throw Object.assign(new Error('删除需要主键 key'), { code: 'INVALID_INPUT', status: 400 });
        requirePrimaryKey(whereCols);
        sql = buildDelete(conn.engine, table.name, whereCols, schema);
        params = whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text'));
        risk = 'destructive';
      } else if (op === 'deleteMany') {
        const keys = Array.isArray(body.keys) ? body.keys.filter((key) => key && typeof key === 'object') as Record<string, unknown>[] : [];
        if (!keys.length) throw Object.assign(new Error('删除需要主键列表'), { code: 'INVALID_INPUT', status: 400 });
        rejectUnknown(Object.keys(keys[0]));
        const whereCols = Object.keys(keys[0]).filter((c) => known.has(c));
        if (!whereCols.length) throw Object.assign(new Error('删除需要主键列'), { code: 'INVALID_INPUT', status: 400 });
        requirePrimaryKey(whereCols);
        if (keys.some((key) => whereCols.some((c) => key[c] === undefined))) {
          throw Object.assign(new Error('批量删除的主键列必须一致'), { code: 'INVALID_INPUT', status: 400 });
        }
        sql = buildDeleteMany(conn.engine, table.name, whereCols, keys.length, schema);
        params = keys.flatMap((key) => whereCols.map((c) => coerceValue(key[c], typeOf.get(c) ?? 'text')));
        risk = 'destructive';
      } else {
        throw Object.assign(new Error('未知操作'), { code: 'INVALID_INPUT', status: 400 });
      }
      const started = Date.now();
      try {
        const result = await manager.runParams(connectionId, sql, params, { database, actor: 'user' });
        store.addAudit({ actor: 'user', connectionId, database, tool: `rows.${op}`, sql, risk: risk as 'write' | 'destructive', approval: 'manual', status: 'ok', durationMs: Date.now() - started, meta: { table: table.name } });
        res.json({ result });
      } catch (err: any) {
        store.addAudit({ actor: 'user', connectionId, database, tool: `rows.${op}`, sql, risk: risk as 'write' | 'destructive', approval: 'manual', status: 'error', durationMs: Date.now() - started, meta: { error: err.message } });
        throw err;
      }
    }),
  );

  router.post(
    '/ddl/preview',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const conn = store.getConnection(String(body.connectionId));
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      assertSqlEngine(conn);
      const table = String(body.table ?? '');
      if (!table) throw Object.assign(new Error('表名必填'), { code: 'INVALID_INPUT', status: 400 });
      if (body.mode === 'alter') {
        const statements = buildAlterTable(
          conn.engine,
          table,
          (body.operations ?? []) as Parameters<typeof buildAlterTable>[2],
          engineUsesSchema(conn.engine) ? String(body.schema ?? defaultSchema(conn)) : undefined,
        );
        res.json({ statements });
        return;
      }
      const columns = (Array.isArray(body.columns) ? body.columns : []) as ColumnDef[];
      if (!columns.length) throw Object.assign(new Error('至少需要一列'), { code: 'INVALID_INPUT', status: 400 });
      const ddl = buildCreateTable(conn.engine, {
        table,
        columns,
        indexes: (Array.isArray(body.indexes) ? body.indexes : []) as IndexDef[],
        foreignKeys: (Array.isArray(body.foreignKeys) ? body.foreignKeys : []) as ForeignKeyInfo[],
        schema: engineUsesSchema(conn.engine) ? String(body.schema ?? defaultSchema(conn)) : undefined,
        comment: str(body.comment),
      });
      res.json({ statements: ddl.split(';\n').filter(Boolean).map((s) => s.trim() + ';').slice(0), ddl });
    }),
  );

  router.post(
    '/ddl/execute',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      assertSqlEngine(conn);
      const statements = Array.isArray(body.statements) ? (body.statements as string[]) : str(body.sql) ? [String(body.sql)] : [];
      const sql = statements.join(';\n');
      if (!sql.trim()) throw Object.assign(new Error('没有可执行的语句'), { code: 'INVALID_INPUT', status: 400 });
      const started = Date.now();
      const batch = await manager.query(connectionId, sql, {
        database: str(body.database),
        allowMulti: true,
        autoLimit: false,
        timeoutMs: store.getSettings().queryTimeoutMs,
        actor: 'user',
      });
      store.addAudit({
        actor: 'user',
        connectionId,
        database: str(body.database),
        tool: 'ddl.execute',
        sql,
        risk: classifyForAudit(sql),
        approval: 'manual',
        status: 'ok',
        durationMs: Date.now() - started,
      });
      res.json({ batch });
    }),
  );

  router.post(
    '/export',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      const database = str(body.database);
      const format = (['csv', 'json', 'sql', 'xml', 'xlsx'].includes(String(body.format)) ? String(body.format) : 'csv') as 'csv' | 'json' | 'sql' | 'xml' | 'xlsx';
      assertExportable(conn.engine, format);
      const limit = num(body.limit, 10000, 1, 200000);
      let sql: string;
      let tableName: string | undefined;
      if (str(body.sql)) sql = String(body.sql);
      else if (str(body.table)) {
        if (!isSqlEngine(conn.engine)) exportNeedsStatement(conn.engine);
        const { table } = await manager.findTable(connectionId, database, String(body.table));
        tableName = table.name;
        sql = buildSelectTable(conn.engine, table.name, { schema: engineUsesSchema(conn.engine) ? table.schema : undefined, limit });
      } else throw Object.assign(new Error('sql 或 table 必填'), { code: 'INVALID_INPUT', status: 400 });
      // 行数上限要下推进 SQL：否则「导出 1 万行」也会先把整表拉回内存再截断。
      // G2：导出此前漏传 timeoutMs，慢导出会永久占住连接；导出用 120s 口径。
      const batch = await manager.query(connectionId, sql, { database, maxRows: limit, allowMulti: false, autoLimit: true, actor: 'user', timeoutMs: EXPORT_QUERY_TIMEOUT_MS });
      const set = batch.sets[0];
      if (!set) throw Object.assign(new Error('没有可导出的结果'), { code: 'EMPTY_RESULT', status: 400 });
      // K4：WP5 将把 writeExportFile 异步化（xlsx 落盘耗时），这里先 await；
      // 对同步函数 await 同样合法，两侧可独立落地。
      const file = await writeExportFile({ dir: config.exportDir, format, columns: set.columns.map((c) => c.name), rows: set.rows, tableName, engine: conn.engine });
      store.addAudit({ actor: 'user', connectionId, database, tool: 'export', sql, risk: 'read', approval: 'manual', status: 'ok', meta: { path: file.path, format } });
      // K5：inline 不再把整个文件读进内存转 base64（大导出直接 OOM），改为返回
      // 下载 URL，客户端经 GET /export/file 流式取文件；file 元数据字段保持兼容。
      const inline = body.inline === true ? { downloadUrl: exportDownloadUrl(file.path) } : {};
      res.json({ file, format, ...inline });
    }),
  );

  // K5：导出文件下载端点。沿用 router 上的 Bearer 鉴权中间件；path 必须 resolve
  // 校验落在 exportDir 内部，否则拒绝——下载接口绝不能变成任意文件读取漏洞。
  router.get('/export/file', (req, res) => {
    const raw = str(req.query.path);
    if (!raw) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'path 必填' } });
      return;
    }
    const root = resolve(config.exportDir);
    const target = resolve(raw);
    const rel = relative(root, target);
    // rel 以 .. 开头或本身是绝对路径（Windows 跨盘符）都说明跳出了 exportDir。
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      res.status(403).json({ error: { code: 'FORBIDDEN_PATH', message: '只能下载导出目录内的文件' } });
      return;
    }
    let isFile = false;
    try {
      isFile = statSync(target).isFile();
    } catch {
      /* 不存在按 404 处理 */
    }
    if (!isFile) {
      res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
      return;
    }
    res.download(target);
  });

  router.post(
    '/import',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const conn = store.getConnection(connectionId);
      if (!conn) throw Object.assign(new Error('连接不存在'), { code: 'CONNECTION_NOT_FOUND', status: 404 });
      assertSqlEngine(conn);
      const result = await importCsv(store, manager, config, connectionId, {
        table: String(body.table ?? ''),
        csv: str(body.csv),
        path: str(body.path),
        hasHeader: body.hasHeader !== false,
        delimiter: str(body.delimiter),
        mapping: Array.isArray(body.mapping) ? (body.mapping as Array<{ column: string; sourceIndex?: number }>) : undefined,
      });
      // CSV 导入只写数据、不动结构（目标表必须已存在）：丢掉过期的 rowEstimate 即可，不广播。
      manager.invalidate(connectionId, 'user', false);
      store.addAudit({ actor: 'user', connectionId, tool: 'import', risk: 'write', approval: 'manual', status: 'ok', meta: { table: body.table, inserted: result.inserted } });
      res.json({ result });
    }),
  );

  router.get('/backups', (req, res) => {
    res.json({ backups: store.listBackups(str(req.query.connectionId)) });
  });

  router.post(
    '/backups',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const connectionId = str(body.connectionId);
      if (!connectionId) throw Object.assign(new Error('connectionId 必填'), { code: 'INVALID_INPUT', status: 400 });
      const backup = await dumpDatabase(store, manager, config, connectionId, str(body.database), str(body.label));
      res.status(201).json({ backup });
    }),
  );

  router.get('/history', (req, res) => {
    res.json({
      items: store.listHistory({
        connectionId: str(req.query.connectionId),
        search: str(req.query.search),
        limit: num(req.query.limit, 200, 1, 500),
      }),
    });
  });

  router.post(
    '/history/:id/favorite',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      const favorite = Boolean(body.favorite);
      if (!store.setHistoryFavorite(req.params.id, favorite)) {
        throw Object.assign(new Error('历史记录不存在'), { code: 'HISTORY_NOT_FOUND', status: 404 });
      }
      res.json({ id: req.params.id, favorite });
    }),
  );

  router.delete('/history', (_req, res) => {
    store.clearHistory();
    res.status(204).end();
  });

  router.get('/snippets', (_req, res) => res.json({ snippets: store.listSnippets() }));
  router.post(
    '/snippets',
    ah(async (req, res) => {
      const body = obj(req.body, 'body');
      if (!str(body.name) || !str(body.sql)) throw Object.assign(new Error('name 与 sql 必填'), { code: 'INVALID_INPUT', status: 400 });
      const created = store.createSnippet({ name: String(body.name), sql: String(body.sql), tags: Array.isArray(body.tags) ? (body.tags as string[]) : [] });
      res.status(201).json({ snippet: created });
    }),
  );
  router.delete('/snippets/:id', (req, res) => {
    store.deleteSnippet(req.params.id);
    res.status(204).end();
  });

  return router;
}
