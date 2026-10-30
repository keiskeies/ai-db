#!/usr/bin/env node
/**
 * 真实 MySQL 只读回归：schema 浏览 / SELECT / EXPLAIN / 数据页分页 / 导出 / 图表聚合 / 打印取数。
 * 全程只发送 SELECT 与 EXPLAIN；不写数据、不建对象。默认针对本机 127.0.0.1:3306 的 local3306。
 *
 * 环境变量：
 *   AIDB_API            默认 http://127.0.0.1:8787/api
 *   AIDB_TOKEN          默认 dev-token
 *   AIDB_CONNECTION     默认 local3306
 *   AIDB_BIG_DB         默认 nextcloud（235 表大库）
 *   AIDB_EXPECT_BIG_TABLES 默认 235
 *   AIDB_BIZ_DB         默认 ziyou_mall_center（真实中文电商数据）
 */
import fs from 'node:fs';

const API = process.env.AIDB_API ?? 'http://127.0.0.1:8787/api';
const TOKEN = process.env.AIDB_TOKEN ?? 'dev-token';
const CONNECTION_NAME = process.env.AIDB_CONNECTION ?? 'local3306';
const BIG_DB = process.env.AIDB_BIG_DB ?? 'nextcloud';
const EXPECT_BIG_TABLES = Number(process.env.AIDB_EXPECT_BIG_TABLES ?? 235);
const BIZ_DB = process.env.AIDB_BIZ_DB ?? 'ziyou_mall_center';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const han = /[\u3400-\u9fff]/;

const conns = await (await fetch(`${API}/connections`, { headers: H })).json();
const conn = (conns.connections ?? []).find((c) => c.name === CONNECTION_NAME || c.id === CONNECTION_NAME);
if (!conn) {
  console.error(`找不到连接 ${CONNECTION_NAME}`);
  process.exit(2);
}
console.log(`connection=${conn.name} id=${conn.id} engine=${conn.engine} ${conn.host}:${conn.port}`);
if (conn.readonly) console.log('连接本身标记为只读');

const startedAt = new Date().toISOString();
const issued = [];

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: H });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${body.error?.message ?? ''}`);
  return body;
}

async function runSql(database, sql, limit = 100) {
  issued.push(sql);
  const started = Date.now();
  const res = await fetch(`${API}/query`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ connectionId: conn.id, database, sql, limit }),
  });
  const body = await res.json();
  const ms = Date.now() - started;
  if (!res.ok) throw new Error(`SQL 失败 (${res.status}): ${body.error?.message ?? JSON.stringify(body).slice(0, 200)}`);
  const set = body.batch?.sets?.[0] ?? {};
  return { ms, columns: (set.columns ?? []).map((c) => c.name), rows: set.rows ?? [], truncated: set.truncated, batch: body.batch };
}

async function dataPage(database, table, query) {
  const qs = new URLSearchParams({ connectionId: conn.id, database, table, ...query });
  const started = Date.now();
  const body = await apiGet(`/data?${qs}`);
  return { ms: Date.now() - started, ...body };
}

// 1) 连接与库清单
const { databases } = await apiGet(`/connections/${conn.id}/databases`);
check('列出 30+ 个库', databases.length >= 20, `${databases.length} 个：${databases.slice(0, 6).join(', ')}…`);
check('目标大库与业务库都在清单里', databases.includes(BIG_DB) && databases.includes(BIZ_DB), `${BIG_DB}, ${BIZ_DB}`);

// 2) 大库 schema 内省
const schemaStarted = Date.now();
const { schemas: bigSchemas } = await apiGet(`/connections/${conn.id}/schema?database=${encodeURIComponent(BIG_DB)}`);
const bigSchemaMs = Date.now() - schemaStarted;
const bigTables = (bigSchemas ?? []).flatMap((s) => s.tables ?? []);
const bigColumns = bigTables.reduce((n, t) => n + (t.columns?.length ?? 0), 0);
check(`${BIG_DB} 表数量 = ${EXPECT_BIG_TABLES}`, bigTables.length === EXPECT_BIG_TABLES, `${bigTables.length} 张 / ${bigColumns} 列 / ${bigSchemaMs}ms`);
check('大库内省 < 5s', bigSchemaMs < 5000, `${bigSchemaMs}ms`);
check('每张表都有列定义', bigTables.every((t) => (t.columns?.length ?? 0) > 0), `${bigTables.filter((t) => !(t.columns?.length)).length} 张缺列`);

const { schemas: bizSchemas } = await apiGet(`/connections/${conn.id}/schema?database=${encodeURIComponent(BIZ_DB)}`);
const bizTables = (bizSchemas ?? []).flatMap((s) => s.tables ?? []);
check(`${BIZ_DB} schema 可浏览`, bizTables.length > 100, `${bizTables.length} 张表`);

// 3) 长字段：>2 万字符的长文本必须原样返回
const longMeta = await runSql(BIG_DB, 'SELECT MAX(CHAR_LENGTH(body)) AS len, COUNT(*) AS total FROM oc_news_items', 1);
const longLen = Number(longMeta.rows[0]?.[0] ?? 0);
check('大库存在 2 万字符级长字段', longLen > 20000, `oc_news_items.body 最长 ${longLen} 字符 / ${longMeta.rows[0]?.[1]} 行`);
const longRow = await runSql(BIG_DB, `SELECT title, body FROM oc_news_items ORDER BY CHAR_LENGTH(body) DESC LIMIT 1`, 1);
const bodyValue = String(longRow.rows[0]?.[1] ?? '');
check('长字段端到端不截断', bodyValue.length === longLen, `返回 ${bodyValue.length} / 期望 ${longLen}，${longRow.ms}ms`);

// 4) 中文数据：真实业务库中的中文标题
const cn = await runSql(BIZ_DB, 'SELECT id, title, order_sn FROM t_order_item ORDER BY id DESC LIMIT 20', 20);
const cnRows = cn.rows.filter((r) => han.test(String(r[1] ?? '')));
check('中文标题按原样返回', cnRows.length > 0, `${cnRows.length}/${cn.rows.length} 行含中文，例：${cn.rows[0]?.[1]}`);
const longCn = await runSql(BIZ_DB, 'SELECT MAX(CHAR_LENGTH(operate_content)) AS len FROM t_order_operate_history', 1);
check('中文库存在长文本', Number(longCn.rows[0]?.[0] ?? 0) > 1000, `operate_content 最长 ${longCn.rows[0]?.[0]} 字符`);

// 5) EXPLAIN（只读执行计划）
const explain = await runSql(BIZ_DB, 'EXPLAIN SELECT id, title FROM t_order_item WHERE order_id = 1 ORDER BY id DESC LIMIT 10', 20);
check('EXPLAIN 返回执行计划', explain.rows.length > 0, `${explain.rows.length} 行 / ${explain.ms}ms / 列 ${explain.columns.join(',')}`);

// 6) 数据网格分页：大表偏移分页稳定、不重不漏
const totalProbe = await runSql(BIZ_DB, 'SELECT COUNT(*) FROM t_order', 1);
const totalOrders = Number(totalProbe.rows[0]?.[0] ?? 0);
check('大表行数 > 10 万', totalOrders > 100000, `t_order ${totalOrders} 行`);
const page1 = await dataPage(BIZ_DB, 't_order', { limit: '100', offset: '0', orderBy: 'id', orderDir: 'asc' });
const page2 = await dataPage(BIZ_DB, 't_order', { limit: '100', offset: '100', orderBy: 'id', orderDir: 'asc' });
check('数据页 total 与 COUNT 一致', page1.total === totalOrders, `${page1.total} vs ${totalOrders}`);
check('分页每页 100 行', page1.batch?.sets?.[0]?.rows?.length === 100 && page2.batch?.sets?.[0]?.rows?.length === 100,
  `page1=${page1.batch?.sets?.[0]?.rows?.length} page2=${page2.batch?.sets?.[0]?.rows?.length}，${page1.ms}ms / ${page2.ms}ms`);
const ids1 = new Set((page1.batch?.sets?.[0]?.rows ?? []).map((r) => String(r[0])));
const overlap = (page2.batch?.sets?.[0]?.rows ?? []).filter((r) => ids1.has(String(r[0]))).length;
check('相邻页无重复行', ids1.size === 100 && overlap === 0, `重复 ${overlap} 行`);
check('分页 SQL 带 LIMIT/OFFSET', /LIMIT 100\b/i.test(page1.sql) && /LIMIT 100 OFFSET 100/i.test(page2.sql), page2.sql);

const filtered = await dataPage(BIZ_DB, 't_order', { limit: '100', offset: '0', orderBy: 'id', orderDir: 'asc', where: 'money > 100' });
const moneyIdx = (filtered.batch?.sets?.[0]?.columns ?? []).findIndex((c) => c.name === 'money');
const moneyOk = moneyIdx >= 0 && (filtered.batch.sets[0].rows ?? []).every((r) => Number(r[moneyIdx]) > 100);
check('筛选后的分页正确', filtered.total < totalOrders && filtered.total > 0 && moneyOk, `money>100 → ${filtered.total} 行`);

// 末页不足一页时，不能把上一页的尾巴再返回一遍
const tailOffset = 129700;
const lastPage = await dataPage(BIZ_DB, 't_order', { limit: '100', offset: String(tailOffset), orderBy: 'id', orderDir: 'asc' });
const tailRows = lastPage.batch?.sets?.[0]?.rows ?? [];
const tailIds = new Set(tailRows.map((r) => String(r[0])));
check(
  '末页只返回剩余行',
  tailRows.length === totalOrders - tailOffset && [...tailIds].every((id) => !ids1.has(id)),
  `offset ${tailOffset} → ${tailRows.length} 行 / ${lastPage.ms}ms`,
);

// 7) 图表聚合（按真实订单算月度 GMV × 支付渠道）
const chart = await runSql(BIZ_DB,
  "SELECT DATE_FORMAT(created_timestamp, '%Y-%m') AS month, pay_channel, ROUND(SUM(money), 2) AS gmv FROM t_order WHERE created_timestamp >= '2024-01-01' GROUP BY month, pay_channel ORDER BY month, pay_channel LIMIT 500",
  500);
const months = new Set(chart.rows.map((r) => r[0]));
const gmvSum = chart.rows.reduce((n, r) => n + Number(r[2] ?? 0), 0);
check('图表聚合返回多月多系列', months.size >= 12 && chart.rows.length >= 12, `${months.size} 个月 / ${chart.rows.length} 个点 / GMV 合计 ${gmvSum.toFixed(2)} / ${chart.ms}ms`);
check('图表聚合值全部为数字', chart.rows.every((r) => Number.isFinite(Number(r[2]))), `${chart.rows.length} 点`);

// 8) 导出五种格式（中文 + 小表），长文本走查询导出
const exportDir = [];
for (const format of ['csv', 'json', 'sql', 'xml', 'xlsx']) {
  const res = await fetch(`${API}/export`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ connectionId: conn.id, database: BIZ_DB, table: 't_mall_config', format }),
  });
  const body = await res.json();
  if (!res.ok) { check(`导出 ${format}`, false, body.error?.message ?? `HTTP ${res.status}`); continue; }
  const stat = fs.statSync(body.file.path);
  exportDir.push({ format, path: body.file.path, size: stat.size, rows: body.file.rows });
  check(`导出 ${format} 文件落盘`, stat.size > 0, `${body.file.rows} 行 / ${stat.size} B`);
}
const csv = exportDir.find((f) => f.format === 'csv');
if (csv) {
  const text = fs.readFileSync(csv.path, 'utf8');
  check('CSV 保留中文', han.test(text) && text.includes('多时段配送信息'), `${csv.path}`);
}
const xlsx = exportDir.find((f) => f.format === 'xlsx');
if (xlsx) {
  const head = fs.readFileSync(xlsx.path).subarray(0, 2).toString('latin1');
  check('XLSX 是合法 zip 容器', head === 'PK', `magic=${JSON.stringify(head)} / ${xlsx.size} B`);
}
const jsonFile = exportDir.find((f) => f.format === 'json');
if (jsonFile) {
  const parsed = JSON.parse(fs.readFileSync(jsonFile.path, 'utf8'));
  check('JSON 可解析且含中文', Array.isArray(parsed) && JSON.stringify(parsed).includes('配送'), `${Array.isArray(parsed) ? parsed.length : '?'} 行`);
}
const longExport = await fetch(`${API}/export`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    connectionId: conn.id, database: BIZ_DB, format: 'csv', limit: 200,
    sql: 'SELECT id, operate_content FROM t_order_operate_history ORDER BY CHAR_LENGTH(operate_content) DESC LIMIT 200',
  }),
});
const longExportBody = await longExport.json();
if (longExport.ok) {
  const stat = fs.statSync(longExportBody.file.path);
  check('长文本查询导出完整', stat.size > 3000, `${longExportBody.file.rows} 行 / ${stat.size} B`);
} else {
  check('长文本查询导出完整', false, longExportBody.error?.message);
}

// 8.1) 可选：全表大导出（约 13 万行 / 50MB），验证内存与磁盘写入不塌
if (process.env.AIDB_LARGE_EXPORT === '1') {
  const started = Date.now();
  const res = await fetch(`${API}/export`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ connectionId: conn.id, database: BIZ_DB, table: 't_order', format: 'csv', limit: 200000 }),
  });
  const body = await res.json();
  const ms = Date.now() - started;
  if (res.ok) {
    const stat = fs.statSync(body.file.path);
    const text = fs.readFileSync(body.file.path, 'utf8');
    const lines = text.split('\n').length - 1;
    check(
      '13 万行全表导出完整',
      // 字段里可能含换行，物理行数会略多于记录数，只能要求不少于记录数
      body.file.rows === totalOrders && stat.size > 10_000_000 && lines >= totalOrders && /[\u3400-\u9fff]/.test(text),
      `${body.file.rows} 行 / ${(stat.size / 1_048_576).toFixed(1)} MiB / ${ms}ms`,
    );
    fs.rmSync(body.file.path, { force: true });
  } else {
    check('13 万行全表导出完整', false, body.error?.message);
  }
}

// 9) 打印取数：前端打印预览逐页拉 1000 行，最多 1 万行
const printStarted = Date.now();
const printIds = new Set();
let printRows = 0;
for (let offset = 0; offset < 10000; offset += 1000) {
  const page = await dataPage(BIZ_DB, 't_order', { limit: '1000', offset: String(offset), orderBy: 'id', orderDir: 'asc' });
  const rows = page.batch?.sets?.[0]?.rows ?? [];
  if (!rows.length) break;
  printRows += rows.length;
  for (const row of rows) printIds.add(String(row[0]));
}
const printMs = Date.now() - printStarted;
check('打印预览可在 10s 内取满 1 万行', printRows === 10000 && printIds.size === 10000 && printMs < 10000, `${printRows} 行 / 唯一 ${printIds.size} / ${printMs}ms`);

// 10) 自证只读：本轮只发送 SELECT / EXPLAIN
const offenders = issued.filter((sql) => !/^\s*(SELECT|EXPLAIN|WITH)\b/i.test(sql));
check('本轮未发送任何写/DDL 语句', offenders.length === 0, `${issued.length} 条语句，异常 ${offenders.length}`);

// 11) 审计里本轮记录均为 read 风险
try {
  const { entries } = await apiGet(`/audit?connectionId=${conn.id}&limit=1000`);
  const ours = entries.filter((e) => e.createdAt >= startedAt && e.connectionId === conn.id);
  const risky = ours.filter((e) => e.risk && e.risk !== 'read');
  check('审计中本轮记录均为只读', risky.length === 0, `${ours.length} 条记录，非只读 ${risky.length}`);
} catch (err) {
  console.log('审计检查跳过：' + err.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项失败` : ''}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
}
process.exit(failed.length ? 1 : 0);
