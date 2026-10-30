# 真实 MySQL 只读回归（本机 30 库）

> 执行日期：2026-10-29 · 目标：`127.0.0.1:3306`（连接名 `local3306`）· 全程只读
> 结论：**API 32/32（开启大导出时 33/33）、UI 14/14 通过；发现并修复 1 个真实缺陷（筛选后分页 total 不跟随 WHERE）**

## 1. 为什么做这次回归

测试容器的 demo 数据（users 120 / products 24 / orders 900）过于规整，无法暴露真实库里的
235 张表、2 万字符长文本、中文业务数据、13 万行订单表与偏移分页问题。这次直接用本机
MySQL 的 29 个业务库（962 张表）做只读回归，不写数据、不建对象。

## 2. 环境与数据画像

| 项 | 值 |
|---|---|
| 连接 | `local3306` · MySQL · 127.0.0.1:3306 |
| 库 | 30 个（含 4 个系统库），29 个有表 |
| 最大库 | `nextcloud`：235 张表 / 1,873 列 / 170 个 text·blob·json 列 |
| 业务库 | `ziyou_mall_center`：116 张表；`t_order` 129,757 行；`t_order_item` 283,283 行 |
| 长文本 | `nextcloud.oc_news_items.body` 最长 22,589 字符（223 行） |
| 中文 | `t_order_item.title`、`category.name`、`t_mall_config.dict_value` 等 |
| 维度 | 700 个 `shop_id`、14 种订单状态、2 个支付渠道（AliPay / BaoFu） |

## 3. 一键回归

```bash
# API：schema / SELECT / EXPLAIN / 分页 / 导出 / 图表聚合 / 打印取数
node scripts/real-mysql-readonly.mjs

# UI：235 表对象树 / 数据网格 / 导出 / 打印预览 / 查询图表 / 长文本
node scripts/real-mysql-ui.mjs
```

两个脚本默认指向 `http://127.0.0.1:8787` 与 `http://localhost:5180`，可用 `AIDB_API` /
`AIDB_CONNECTION` / `AIDB_BIG_DB` / `AIDB_BIZ_DB` 覆盖。API 脚本会把本轮发出的所有 SQL
收集起来自证只以 `SELECT` / `EXPLAIN` 开头，并复查审计记录均为 `risk=read`。

## 4. API 回归结果（32/32；`AIDB_LARGE_EXPORT=1` 时 33/33）

| 检查 | 实测 |
|---|---|
| 库清单 | 30 个，含 `nextcloud` 与 `ziyou_mall_center` |
| 235 表内省 | 235 张 / 1,873 列 / **43ms**；每张表都有列定义 |
| 2 万字符长字段 | 最长 22,589；接口返回同样 22,589 字符，未截断 |
| 中文数据 | 20/20 中文标题原样返回（例：`嘎嘎香`） |
| EXPLAIN | 返回 12 列执行计划（`type/key/rows/Extra`） |
| 分页 | `total=129757` 与 `COUNT(*)` 一致；第 1/2 页各 100 行、无重复，22ms |
| 筛选分页 | `money > 100` → 6,571 行，每行都满足条件 |
| 末页 | `OFFSET 129700` 只返回剩余 57 行，且不与第 1 页重复 |
| 图表聚合 | 24 个月 × 支付渠道，45 个点，GMV 合计 6,338,632.76，111ms |
| 导出 | CSV / JSON / SQL / XML / XLSX 全部落盘；CSV 含中文，XLSX 是合法 zip |
| 长文本导出 | 200 条 `operate_content`，370,838 B |
| 全表大导出（可选） | `AIDB_LARGE_EXPORT=1`：`t_order` 129,757 行 / 50,331,998 B / **928ms**，中文与状态值完整 |
| 打印取数 | 10 × 1,000 行在 **323ms** 内取满 1 万行，无重复 |
| 只读自证 | 本轮 7 条 SQL 全为 SELECT/EXPLAIN；审计 13 条记录均为 read |

## 5. UI 回归结果（14/14）

| 检查 | 实测 |
|---|---|
| 对象树 | 30 个库节点；`nextcloud` 235 张表全部渲染，**113ms**；搜索 `oc_filecache` 后只剩 1 个表节点 |
| 数据网格 | 默认 100 行；第 2 页行号从 101 开始；切每页 50 行即时生效 |
| 导出 | 工具栏导出 CSV，223 行写入 `%USERPROFILE%\.aidb\exports` |
| 打印预览 | 223 行 + 表头（224 个 `<tr>`，794 KB），无截断 |
| 中文 | `category` 表正常显示 `餐饮` / `丽人美发` |
| 查询 + 图表 | 45 行聚合结果，图表页渲染 24 个柱 |
| 长文本 | 22,589 字符正文进入查询结果网格，未崩 |
| 控制台 | 0 条 error |

截图：`D:/tmp/real-mysql-grid.png`、`real-mysql-print.png`、`real-mysql-chinese.png`、
`real-mysql-chart.png`、`real-mysql-longtext.png`。

## 6. 发现并修复的缺陷

**筛选后分页的 total 不跟随 WHERE。**

`GET /data` 只把 `where` 拼进数据 SELECT，`COUNT(*)` 仍统计整表：

```sql
SELECT * FROM `t_order` WHERE money > 100 ... LIMIT 100 OFFSET 0   -- 数据正确
SELECT COUNT(*) FROM `t_order`                                      -- 错误：129757
```

在 `ziyou_mall_center.t_order` 上表现为筛选后仍显示 129,757 条、页数按全表计算，翻到
后面的页会得到空页。真实数据一测即现；demo 的 900 行不明显。

修复：`buildCount` 接受 `where`，`/data` 传入同一个条件；新增 core 单测与 gateway
集成断言（筛选后的 total 必须等于同条件的 `COUNT(*)`）。

- [packages/core/src/sql/ddl.ts:342](file:///D:/item/ai-db/packages/core/src/sql/ddl.ts#L342)
- [apps/gateway/src/routes.ts:1468](file:///D:/item/ai-db/apps/gateway/src/routes.ts#L1468)
- [packages/core/test/ddl.test.ts](file:///D:/item/ai-db/packages/core/test/ddl.test.ts)
- [apps/gateway/test/integration.test.ts](file:///D:/item/ai-db/apps/gateway/test/integration.test.ts)

## 7. 覆盖边界

- 只执行 SELECT / EXPLAIN；**没有**在真实库验证 INSERT / UPDATE / DDL / 导入 / 备份恢复，
  这是本轮有意的安全边界。
- 没有验证 MySQL 的 SSH 隧道、SSL、权限受限账号；这些仍由引擎集成测试覆盖。
- 9 月及更早的历史导出文件会留在 `%USERPROFILE%\.aidb\exports`，属正常副作用。
