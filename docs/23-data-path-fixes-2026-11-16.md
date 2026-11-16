# 数据操作路径修复规范（2026-11-16 数据操作代码审查产出）

本文档是数据基本操作路径（CRUD / 表设计 / 数据传输 / 备份恢复 / SQL 执行）代码审查的落地产物，覆盖 11 处发现。所有 `file:line` 均为审查时点核对过的锚点，**修改前请重新确认**。

## 发现总览

| 编号 | 严重度 | 标题 | 依赖 |
|---|---|---|---|
| P1-1 | 高 | `/rows` insertMany 无行数上限，单条巨型 INSERT | 独立 |
| P1-2 | 高 | transferData 固定 200 行/批，不按引擎参数上限 | 依赖 P1-3 的处理顺序（先并发改造后原子化） |
| P1-3 | 高 | transfer replace 模式 truncate 后无事务，中途失败丢半张表 | 独立（与 P1-2 同文件，合并落地） |
| M4 | 中 | `readSqlStatements` 按「行尾分号」切语句，内嵌换行值被拆坏 | 独立 |
| M5 | 中 | 备份不落视图；`restoreDropStatements` 仅 4 种方言 | 独立 |
| M6 | 中 | 空字符串被 coerce 成 NULL（服务端 × 前端 4 处调用） | 服务端+前端配套 |
| L7 | 低 | dump 对非 OFFSET 方言整表读入内存 | 独立 |
| L8 | 低 | 备份默认值被 `/[()]|::/` 正则一律丢弃 | 独立 |
| L9 | 低 | SQL Server 绑定参数无类型声明，长文本可能 4000 截断 | 独立 |
| L10 | 低 | tableOps 重置 sqlite 自增序列用裸字符串拼接 | 独立 |

验证基线：`npm run typecheck`、`npm run test`（core/gateway/desktop 单测）。改动后至少过 typecheck + 受影响 workspace 的单测。

---

## P1-1（高）`/rows` insertMany 无行数上限，单条巨型 INSERT【独立】

### 现象与根因
[routes.ts:1953-1960](apps/gateway/src/routes.ts#L1953)：
```ts
const records = Array.isArray(body.rows) ? body.rows.filter(...) : [];
...
sql = buildInsert(conn.engine, table.name, columns, records.length, schema);
params = records.flatMap((row) => columns.map((c) => coerceValue(row[c], typeOf.get(c) ?? 'text')));
```
`records.length` 无上限，一次性展开成一条巨型 INSERT 与平铺参数：
- SQL Server 参数上限 2100、Oracle bind 上限 65535 → 宽表大行必失败；
- PG bind message 上限 ~1GB、MySQL `max_allowed_packet` 默认 64MB → 大表必炸；
- `flatMap` 平铺 + 网络包序列化内存峰值翻倍。

与导入路径的批量语义不一致：`importCsv`（[services.ts:330](../apps/gateway/src/services.ts#L330)）上限 5000 行、200 行分批。

调用方（DataView）：
- `duplicateSelected` 复制选中行（通常小批量）；
- `confirmPaste` 粘贴 TSV——粘 10 万行即送 10 万行单 INSERT。

### 改造
在 `op === 'insertMany'` 分支改为分批执行：

```ts
} else if (op === 'insertMany') {
  const records = ...
  if (!records.length) throw ...('没有可插入的行');
  if (records.length > 5000) throw Object.assign(new Error('单次插入最多 5000 行，请分页粘贴或分多次复制'), { code: 'TOO_MANY_ROWS', status: 400 });
  rejectUnknown([...new Set(records.flatMap((row) => Object.keys(row)))]);
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))].filter((c) => known.has(c));
  if (!columns.length) throw ...('没有可插入的列');
  const batchSql = buildInsert(conn.engine, table.name, columns, 200, schema);
  const started = Date.now();
  try {
    let affected = 0;
    for (let start = 0; start < records.length; start += 200) {
      const chunk = records.slice(start, start + 200);
      const params = chunk.flatMap((row) => columns.map((c) => coerceValue(row[c], typeOf.get(c) ?? 'text')));
      const result = await manager.runParams(connectionId, batchSql, params, { database, actor: 'user' });
      affected += result.affected ?? chunk.length;
    }
    store.addAudit({ ..., tool: `rows.${op}`, sql: `INSERT ... ×${records.length} 行`, risk: 'write', status: 'ok', durationMs: Date.now() - started, meta: { table: table.name, rows: records.length } });
    res.json({ result: { affected, rowCount: affected } });
  } catch (err: any) {
    store.addAudit({ ..., status: 'error', meta: { error: err.message } });
    throw err;
  }
}
```

要点：
- `sql` 改为按 200 行重构参数，减少字符串/参数体积；`buildInsert` 的 `rows` 参数固定传 200；
- 审计里的 `sql` 用摘要（如 `INSERT ... ×N 行`），避免把十万行参数全量塞进审计表；
- 返回体保持 `{ result: QueryResult }` 形状（`affected` 为各批之和，前端用 `result.affected ?? records.length` 兜底，[api.ts:788](../apps/desktop/src/lib/api.ts#L788) 契约不变）。

### 验收
1. 单测：mock `manager.runParams`，10 500 行×3 列 → 断言被调用 2 次（197 行批 + 最后 3 行批）、两次 SQL 相同、affected 正确聚合；
2. 单测：records > 5000 → 断言抛 `TOO_MANY_ROWS`，未发任何 SQL；
3. 前端 DataView `duplicateSelected` / `confirmPaste` 两种流程手测通过；粘贴含换行的多行文本正常。

---

## P1-2（高）transferData 固定 200 行/批，不按引擎参数上限【与 P1-3 合并落地】

### 现象与根因
[transfer.ts:205-211](../apps/gateway/src/features/transfer.ts#L205)：
```ts
for (let offset = 0; offset < set.rows.length; offset += 200) {
  const chunk = set.rows.slice(offset, offset + 200);
  const params: unknown[] = [];
  for (const row of chunk) for (const index of indexes) params.push(row[index]);
  const insertSql = buildInsert(target.engine, targetTable.name, columns, chunk.length, connectionSchema(target, targetTable));
  await manager.runParams(opts.targetId, insertSql, params, ...);
```
单批参数数 = `200 × columns`。SQL Server 每值一个 `request.input`（[sqlserver.ts:194](../apps/gateway/src/drivers/sqlserver.ts#L194)），**参数总量 ≤ 2100**——12 列以上的表转 SQL Server 必失败（200×12=2400 > 2100），宽表直接整表失败。

### 改造
1. 按引擎计算批次行数，函数放 `features/common.ts` 或 transfer 文件内：
```ts
function insertBatchSize(engine: Engine, columnCount: number): number {
  const perRow = Math.max(1, columnCount);
  if (engine === 'sqlserver') return Math.min(200, Math.max(1, Math.floor(2000 / perRow)));   // 预留余量 < 2100
  if (engine === 'oracle') return Math.min(200, Math.max(1, Math.floor(60000 / perRow)));    // 预留 < 65535
  return 200;
}
```
2. `transferData` 写循环改用 `batchSize`，批大小作为变量参与进度判定（消除 `batchSize === 0` 死循环风险）。

### 验收
1. 单测：构造 15 列表 + mssql → 断言批大小为 133（2000/15）；oracle → 4000；
2. 单测：1 列表 → 批大小 200；
3. 回归：无批次下钻时行为不变。

---

## P1-3（高）transfer replace 模式 truncate 后无事务，中途失败丢半张表【与 P1-2 合并落地】

### 现象与根因
[transfer.ts:177-190 + 205-219](../apps/gateway/src/features/transfer.ts#L177)：
```
replace 模式（目标表已存在）：TRUNCATE 目标表 → 分批 INSERT
```
任一批失败（唯一冲突、类型不匹配、驱动限制）→ 表被清空一半，无回滚；错误被 `catch` 记为 `status:'error'` 后继续下一张表——**静默数据丢失**。支持事务的连接（PG/MySQL/MSSQL/SQLite）也未使用跨事务 API。

### 改造（两处配合）

#### 1）transferData 事务化（replace 且支持事务时）
```ts
const canTx = supportsTransaction(driverFor(targetId));
// 对每个表 replace 场景：
//   begin → TRUNCATE → 分批 INSERT → COMMIT；任一批失败 → ROLLBACK
// 该表状态按失败前是否 commit 判定：有事务时失败应为 status:'error' 且 truncated:false（回滚后保留原表）；
// 不可事务的连接维持现状（TRUNCATE 后插入，失败保留截断状态），但错误消息明示「无事务保护」。
```
实现上用 `manager.runParams(..., { sessionId })` 走事务连接（[manager.ts:1193-1195](../apps/gateway/src/manager.ts#L1193) 已支持 sessionId 归属校验），在事务内完成 TRUNCATE 语句 + 批量 INSERT。

事务内调 `buildTruncate` 产物：直接 `INSERT` 进事务连接。注意 transfer 现有代码用 `manager.query(opts.targetId, truncateSql, ...)`（[transfer.ts:182](../apps/gateway/src/features/transfer.ts#L182)）——`query()` 的多语句 `sessionId` 分支会走 `runInTransaction`（[manager.ts:1208](../apps/gateway/src/manager.ts#L1208)），但 `TRUNCATE` 是单条语句仍可走该路径。**改造时把 truncate 与 insert 统一显式带 `sessionId`**，commit/rollback 在 try/finally 中与 `SET IDENTITY_INSERT OFF` 配对。

#### 2）SQL Server 隐式提交语义确认
SQL Server 的 TRUNCATE 与建索引是固定提交操作，事务内 `SET IDENTITY_INSERT ON` 同样在事务内生效；`SET IDENTITY_INSERT ON → 插入 → OFF` 需在同一连接（同数据库会话）内执行，事务连接满足此要求。此语义已在文档记录，实现时按「同一 sessionId 内」执行即可。

### 验收
1. 单测：mssql/mysql 各 1 个签名级测试，断言打点事务流程；（执行级单测需真实库，若仓库无引擎集成测试则仅签名测试 + 人工说明）
2. 手工：把目标表设为含唯一索引，源表含冲突行 → replace 传输后目标表保持原数据（回滚），错误块含「无事务保护」之外的明确回滚提示；
3. append 模式、不可事务连接（如 Mongo/Influx）行为不变。

---

## M4（中）`readSqlStatements` 状态化切分，内嵌换行值被拆坏【独立】

### 现象与根因
[services.ts:678-691](../apps/gateway/src/services.ts#L678)：
```ts
for await (const line of lines) {
  ...
  if (trimmed.endsWith(';')) { yield buffer.trim(); buffer = ''; }
```
`toSqlInserts`（[services.ts:132-153](../apps/gateway/src/services.ts#L132)）一条 INSERT 一行；但**值包含真实换行的 JSON/多行文本**时，`readline` 在字符串内部断开 → 语句被拆成两半 → 恢复中途失败（走 `execScript` 的 SQLite/DuckDB 整段事务回滚，其余引擎部分写入）。

### 改造
用带引号状态的分号切分器替代「行尾分号」判定：

```ts
export async function* readSqlStatements(path: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let buffer = '';
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    buffer = buffer ? `${buffer}\n${line}` : line;
    if (lineIsCompleteStatement(buffer)) {   // 引号状态感知
      yield buffer.trim();
      buffer = '';
    }
  }
  if (buffer.trim()) yield buffer.trim();    // 无分号 EOF 兜底
}

function lineIsCompleteStatement(sql: string): boolean {
  let quote: "'" | '"' | '`' | '' = '';
  let lineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { lineComment = true; i++; continue; }
    if (quote) {
      if (c === quote) {
        if (sql[i + 1] === quote) { i++; continue; }   // '' 转义
        quote = '';
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === ';') return true;
  }
  return false;
}
```

恢复路径 `restoreBackupFile` 的读取循环（[services.ts:729-733](../apps/gateway/src/services.ts#L729)）无需改动——它消费同一个 generator；第一遍扫表头的 `headers` 循环（[services.ts:706](../apps/gateway/src/services.ts#L706)）只取首行，不受影响。

### 验收
1. 单测：构造含 `'{"a":"x\ny"}'` 多行字符串的 INSERT 文本 → 断言切成一整条；
2. 单测：多语句、`--` 行注释、`''` 转义引号各场景；
3. 回归：`readSqlStatements` 单测全绿。

---

## M5（中）备份不落视图；`restoreDropStatements` 仅 4 种方言【独立】

### 现象与根因
- [services.ts:633](../apps/gateway/src/services.ts#L633) `if (table.type !== 'table') continue;`——视图跳过，备份后视图永久消失；
- [services.ts:504-506](../apps/gateway/src/services.ts#L504) `if (!['sqlite','mysql','postgres','mssql'].includes(dialect)) return [];`——Oracle/达梦/ClickHouse/TDengine/Influx 恢复时无前置 DROP，目标库同名表必失败。

### 改造
1. `dumpDatabase` 内，视图分支（`table.type === 'view'`）落 `CREATE VIEW`（用 `buildCreateObject` 或 `CREATE OR REPLACE VIEW ... AS` + `manager` 的 dialect 处理）。注意：视图 DDL 的选取需与 `describe` 返回的 `sql` 字段对齐（describe 已返回视图定义时直接复用）；
2. `restoreDropStatements` 增加方言分支：
   - oracle / dm：`DROP TABLE` / `DROP VIEW`（复用 `buildDropObject`，支持 `CASCADE CONSTRAINTS`）；
   - clickhouse：`DROP TABLE IF EXISTS` / `DROP VIEW IF EXISTS`（或按数据目录安全策略仅 `DROP TABLE IF EXISTS`）；
   - tdengine 等前端不支持先不扩展（文档注明保持原行为）。

### 验收
1. 单测：`restoreDropStatements` 对 oracle/dm/clickhouse 的 CREATE TABLE/VIEW 表头生成 DROP；
2. 手工：含视图的库备份→新库恢复，视图存在；无视图的库行为不变。

---

## M6（中）空字符串被 coerce 成 NULL（服务端 × 前端 4 处调用）【服务端+前端配套】

### 现象与根因
- [services.ts:271](../apps/gateway/src/services.ts#L271)（`coerceValue`）与 [services.ts:293](../apps/gateway/src/services.ts#L293)（`coerce`）：`value === ''` 时对非字符类型返回 `null`；
- 前端 [DataView.tsx:463](../apps/desktop/src/components/DataView.tsx#L463)（`updateCell`）：`values: { [column]: value === '' ? null : value }`——**清空单元格即送 NULL**；
- [DataView.tsx:485](../apps/desktop/src/components/DataView.tsx#L485)（`saveForm`）：改动对比后空串→null，同问题；
- [DataView.tsx:534](../apps/desktop/src/components/DataView.tsx#L534)（`saveNewRow`）：空串字段直接跳过——**语义不一致**（一个置 NULL、一个跳过）；
- [DataView.tsx:374](../apps/desktop/src/components/DataView.tsx#L374)（`confirmPaste`）：空 cell → `null` 送后端。

### 改造
统一语义为「**空输入框 = 不改/留空，不主动写 NULL**」，仅用户显式表示清空（如 `IS NULL` 过滤器/删除操作）才写 NULL：
- 服务端 `coerceValue`/`coerce` 保留空串→按类型转换（字符→`''`，其余→`null`）不变——服务端是纯数据转换函数，**语义由调用方决定**，不在此层加业务逻辑；
- 前端 4 处统一改：
  - `updateCell`：空串时不提交该字段（`values` 为空对象则视为无改动，`saveForm` 已有 `没有改动` 提示）；
  - `saveForm`：`changes[column.name] = next === '' ? null : next` 改为不进入 changes（保持「未编辑不提交」+ 空框算未改）；
  - `saveNewRow`：保持跳过，与上面一致；
  - `confirmPaste`：空 cell 保持 `null`（粘贴空 cell 语义是「空值」而非「跳过」，与 Excel 粘贴一致）。
- 数据网格「清空」操作的显式表达：监听空串提交且列类型为日期/数字时，弹一次确认「置为 NULL」的计数（可选增强，若实现成本高则文档注明降级方案）。

### 验收
1. 前端手测：清空 DATE/NUMERIC 单元格保存 → 不请求、提示无改动；原样双击修改其他字段 → 只提交改动列；
2. 粘贴含空 cell 的 TSV → 空 cell 以 NULL 入库（保持现状）；
3. 单测：`coerceValue` 对空串按类型转换逻辑不变。

---

## L7（低）dump 对非 OFFSET 方言整表读入内存【独立】

### 现象与根因
[services.ts:527](../apps/gateway/src/services.ts#L527)：
```ts
const OFFSET_DIALECTS = new Set(['sqlite','mysql','postgres','mssql','clickhouse','tdengine']);
const KEYSET_DIALECTS = new Set(['sqlite','mysql','postgres','mssql','clickhouse']);
```
oracle/dm/duckdb/influxdb 走 `single` 模式 `SELECT *` 全量入内存（[services.ts:578-581](../apps/gateway/src/services.ts#L578)）。

### 改造
- `OFFSET_DIALECTS` 增加 oracle/dm（`dumpPageSql` 的 `LIMIT ${limit} OFFSET ${offset}` 分支不生效？——**oracle 需走 `OFFSET n ROWS FETCH NEXT m ROWS ONLY`**，现有 `dumpPageSql` 是 `LIMIT/OFFSET` 语法，需为 oracle/dm 补 `OFFSET x ROWS FETCH NEXT y ROWS ONLY` 分支；或 oracle/dm 直接归入 `single`+分页：keyset 对 oracle 也合法且无 OFFSET 问题——实现时先按「oracle/dm 并入 keyset（单列主键时）+ 其余保持」处理）；
- tdengine 无 OFFSET，保持现状；
- 无主键表维持 `single`（数据量上限由 `dumpReadPlan` 的思考注明）。

### 验收
1. 单测：`dumpPageSql`/`dumpKeysetSql` 对 oracle/dm 生成正确 OFFSET/FETCH（或 keyset）语句；
2. 回归：sqlite/mysql 的 keyset 行为不变。

---

## L8（低）备份默认值被 `/[()]|::/` 正则一律丢弃【独立】

### 现象与根因
[services.ts:642](../apps/gateway/src/services.ts#L642)：
```ts
defaultValue: c.defaultValue !== undefined && c.defaultValue !== null && !/[()]|::/.test(String(c.defaultValue)) ? String(c.defaultValue) : undefined,
```
`DEFAULT nextval('seq')`、`DEFAULT strftime('%s','now')` 等含括号/`::` 的默认值在备份里静默丢失。

### 改造
- 白名单化：`sanitizeDefaultLiteral`（[ident.ts](../packages/core/src/sql/ident.ts)）本身已做字面量安全化；dump 侧改为：默认值字符串通过「函数白名单 + 参数白名单（数字/字面量/引号串）”」校验后落盘，否则丢弃——
```ts
const SAFE_DEFAULT_FN = new Set(['nextval','strftime','now','current_timestamp','current_date','current_time','getutcdate','getdate','uuid_generate_v4','gen_random_uuid','random']);
function safeDefaultToDump(value: string): string | undefined {
  const s = value.trim();
  const m = s.match(/^(\w+)\(([^()]*)\)$/);
  if (m && SAFE_DEFAULT_FN.has(m[1].toLowerCase())) {
    const inner = m[2].trim();
    if (!inner || /^\d+(\.\d+)?$/.test(inner) || /^'[^']*'$/.test(inner)) return s;
  }
  return undefined;
}
```
- 其余（`::` 强转等无法证明安全的）维持丢弃，并在备份头部注明「该库有 N 个默认值未能随备份保留」。

### 验收
1. 单测：`safeDefaultToDump('nextval(\'seq\')')` → 保留；`CURRENT_TIMESTAMP` → 保留；`now()` → 保留；`a + b` → 丢弃；
2. 回归：普通字面量/数字默认值行为不变。

---

## L9（低）SQL Server 绑定参数无类型声明【独立】

### 现象与根因
[sqlserver.ts:194](../apps/gateway/src/drivers/sqlserver.ts#L194)（普通路径）与 [sqlserver.ts:246](../apps/gateway/src/drivers/sqlserver.ts#L246)（事务路径）：
```ts
params.forEach((value, index) => request.input(`p${index + 1}`, value as any));
```
node-mssql 对未标注类型的长文本会推断为 `NVARCHAR(4000)`（超过随即报错或被截断）；二进制同样可能被讹传。

### 改造
统一走一个私有辅助：
```ts
private bindParams(request: Request, params: unknown[]): void {
  params.forEach((value, index) => {
    const name = `p${index + 1}`;
    if (typeof value === 'string' && value.length > 4000) request.input(name, mssql.NVarChar(mssql.Max), value);
    else if (value instanceof Uint8Array || Buffer.isBuffer(value)) request.input(name, mssql.VarBinary(mssql.Max), value);
    else request.input(name, value as any);
  });
}
```
两条路径（[sqlserver.ts:192-195](../apps/gateway/src/drivers/sqlserver.ts#L192) 与 [sqlserver.ts:244-246](../apps/gateway/src/drivers/sqlserver.ts#L244)）都改。

### 验收
1. 单测（或签名级）：4001+ 字符字符串走 `NVarChar(Max)` 分支；
2. 手工：数据网格编辑 5000 字文本列保存成功。

---

## L10（低）tableOps 重置 sqlite 自增序列用裸字符串拼接【独立】

### 现象与根因
[tableOps.ts:148-150](../apps/gateway/src/features/tableOps.ts#L148)：
```ts
if (conn.engine === 'sqlite' && (table.columns ?? []).some((column) => column.autoIncrement)) {
  statements.push(`DELETE FROM sqlite_sequence WHERE name = '${target.replace(/'/g, "''")}'`);
}
```
引号已转义、无注入；但绕过 `quoteLiteral` 手拼字面量，后续扩展方言时易漏转义。另：目标表从未插入过数据时 `sqlite_sequence` 无该行，TRUNCATE 后自增不归零——SQLite 固有语义，UI 文案说明即可。

### 改造
```ts
import { quoteLiteral } from '@aidb/core';
statements.push(`DELETE FROM sqlite_sequence WHERE name = ${quoteLiteral(target, conn.engine)}`);
```

### 验收
1. 单测：表名含 `'` 时生成的 DELETE 语句引号正确；
2. 回归：普通表名 truncate 行为不变。

---

## 落地顺序建议

1. **第一轮（P1 三件）**：P1-1（routes.ts）→ P1-2 + P1-3（transfer.ts 合并改，同一批循环内）→ 前端 DataView 通知文案；
2. **第二轮（M 两件）**：M4（services.ts）→ M5（services.ts）；
3. **第三轮（L 四件）**：M6（前端+服务端配套）→ L7 → L8 → L9 → L10；
4. 每轮后跑 `npm run typecheck` + 受影响 workspace 单测，最后一轮结束后全套 `npm run test`。

## 明确不做（文档记录，供后续决策）

- `insertMany` 的事务化（多 target 连接批量）——成本高收益低，±5000 行内分批已消除内存/协议风险；
- `INSERT ... SELECT * FROM (VALUES ...)` 改写（避免大改动、且不影响现有粘贴/复制流程）；
- 非 SQL 引擎（Mongo/Influx/Qdrant 等）的 replace 原子性——模型不同，后续单独评估；
- `resolveImportFile` 的 realpath 反链（当前目录为应用自管目录，现实可接受）。
