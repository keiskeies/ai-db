# AiDB Studio — 多引擎架构与接入矩阵

> 版本：v0.4-dev · 日期：2026-10-28 · 关联：[产品总览](./00-product-overview.md) · [功能规格](./02-feature-spec.md) · [Agent](./04-ai-agent-design.md)

## 1. 目标

v0.3 的 8 个关系型引擎已经覆盖 DB-Engines 前四（Oracle / MySQL / SQL Server / PostgreSQL）。v0.4 增加三类缺口：

- 开发者最常用的非关系型：MongoDB（文档）、Redis（键值）。
- 信创/国产数据库：达梦 DM8、金仓、openGauss、GaussDB、OceanBase、TiDB、PolarDB、TDSQL、GBase 8a、Doris、StarRocks、瀚高、Vastbase、IvorySQL、GreatSQL、GoldenDB。
- 为后续向量库、图数据库预留统一的 Transport / Capability 扩展点。

## 2. 四层模型

```ts
type Engine = 'mongodb' | 'redis' | 'kingbase' | /* ... */;
type DataModel = 'relational' | 'document' | 'keyvalue' | 'vector' | 'graph' | 'widecolumn' | 'search' | 'timeseries';
type Transport = 'sqlite-file' | 'mysql' | 'postgres' | 'tds' | 'oracle' | 'clickhouse-http'
               | 'mongodb' | 'redis' | 'bolt' | 'cassandra' | 'dm' | 'qdrant-http' | 'milvus-http' | 'weaviate-http' | 'duckdb-file' | 'elasticsearch-http' | 'tdengine-http' | 'falkordb' | 'influxdb-http' | 'arangodb-http';
type DialectId = 'sqlite' | 'mysql' | 'postgres' | 'mssql' | 'oracle' | 'clickhouse' | 'dm' | 'tdengine' | 'influxdb';
```

| 层 | 作用 | 扩展方式 |
|---|---|---|
| 数据模型 `DataModel` | 决定对象树、编辑器语言、结果渲染 | 新增模型时加渲染器，不复制驱动 |
| 传输 `Transport` | 决定使用哪个驱动实现 | 同一协议可挂多个产品（协议别名） |
| 方言 `DialectId` | 决定 SQL 生成规则 | 新方言只加 `DialectProfile`，别名自动复用 |
| 能力 `Capabilities` | 决定 UI/Agent 哪些功能可用 | 在 `EngineMeta.capabilities` 声明，不散落 `if` |

核心定义在 [`packages/core/src/engines.ts`](../packages/core/src/engines.ts)、[`packages/core/src/types.ts`](../packages/core/src/types.ts)。SQL 方言函数统一通过 `dialectOf(engine)` 归一化，因此金仓、TiDB 等别名不需要复制 `ddl.ts` / `ident.ts`。

## 3. 接入矩阵（41 种）

| 分组 | 引擎 | Transport | Dialect | 能力 |
|---|---|---|---|---|
| 关系型 | SQLite | sqlite-file | sqlite | 全功能；无用户管理 |
| 关系型 | MySQL / MariaDB | mysql | mysql | 全功能 |
| 关系型 | PostgreSQL / CockroachDB | postgres | postgres | 全功能 |
| 关系型 | TimescaleDB | postgres | postgres | 全功能；对象树标注超表与 chunk 数 |
| 关系型 | SQL Server | tds | mssql | 无自动 EXPLAIN |
| 关系型 | Oracle | oracle | oracle | thin 模式；无 SSL |
| 关系型 | 达梦 DM8 | dm | dm | 浏览 + 查询 + DDL；DES-CFB 登录加密需 legacy OpenSSL |
| 关系型 | DuckDB | duckdb-file | sqlite | 浏览 + SQL + 数据编辑；DDL 设计器关闭 |
| 分析型 | ClickHouse | clickhouse-http | clickhouse | 无结构同步/数据对比 |
| 时序 | TDengine | tdengine-http | tdengine | taosAdapter REST（6041）；超级表/子表浏览 + SQL；无网格编辑 |
| 时序 | InfluxDB | influxdb-http | influxdb | InfluxDB 3 `/api/v3/query_sql`（DataFusion SQL）；measurement 浏览 + SQL + EXPLAIN；DDL 关闭 |
| 文档 | MongoDB | mongodb | —（MQL） | 浏览 + 查询 + 结果；无 DDL/备份 |
| 键值 | Redis | redis | —（命令） | 浏览 + 命令 + 结果；识别 Redis Stack 模块与 RediSearch 索引；键可删除（UNLINK）、索引可删除（FT.DROPINDEX）；无 DDL/备份 |
| 宽列 | Cassandra | cassandra | —（CQL） | keyspace/table 浏览 + CQL；无 JOIN/DDL 设计器 |
| 宽列 | ScyllaDB | cassandra | —（CQL） | 复用 Cassandra 驱动与 CQL |
| 图 | Neo4j | bolt | —（Cypher） | 标签/关系浏览 + Cypher + 计划 + 交互式图视图 |
| 图 | Memgraph | bolt | —（Cypher） | 复用 Neo4j Bolt 驱动；标签/关系浏览 + Cypher + 交互式图视图 |
| 图 | FalkorDB | falkordb | —（Cypher） | Redis 模块（GRAPH.QUERY）；图/标签浏览 + Cypher + 交互式图视图；参数内联为 `CYPHER k=v` 前缀 |
| 图 | ArangoDB | arangodb-http | —（AQL） | HTTP `/_api/cursor` 执行 AQL；文档集合/边集合浏览 + AQL + 交互式图视图；`@bindVar` / `@@collection` 绑定参数 |
| 向量 | Qdrant | qdrant-http | —（JSON） | 集合/维度/payload 浏览 + scroll/向量检索 |
| 向量 | Milvus | milvus-http | —（JSON） | collection/schema 浏览 + query/向量检索 |
| 向量 | Weaviate | weaviate-http | —（JSON） | class/properties 浏览 + scroll/nearVector |
| 搜索 | Elasticsearch | elasticsearch-http | —（DSL） | 索引/mapping 浏览 + `_search` DSL |
| 搜索 | OpenSearch | elasticsearch-http | —（DSL） | 兼容 Elasticsearch `_search` DSL |
| 国产 PG 系 | 金仓 KingbaseES | postgres | postgres | 全功能；默认端口 54321 |
| 国产 PG 系 | openGauss / GaussDB | postgres | postgres | 全功能；注意 sha256 认证 |
| 国产 PG 系 | 瀚高 / Vastbase / IvorySQL | postgres | postgres | 全功能 |
| 国产 MySQL 系 | OceanBase / TiDB / PolarDB / TDSQL / GreatSQL / GoldenDB | mysql | mysql | 全功能；行为差异见 notes |
| 国产分析型 | GBase 8a / Doris / StarRocks | mysql | mysql | 查询可用；DDL/结构同步关闭 |

`EngineMeta.notes` 会展示在连接表单里，例如 openGauss 的认证限制、Redis 的 SCAN 采样说明。

### TimescaleDB（关系型补充）

- 复用 PostgreSQL 驱动与方言，因此建表/改表、数据网格编辑、结构同步、备份等关系型能力全部可用。
- 额外读取 `timescaledb_information.hypertables`，在对象树注释里标注 `超表 · N chunks`；实例未安装扩展时自动退回普通 PG 展示。
- 时间分桶用 `time_bucket()`；月度聚合仍走 postgres 方言的 `date_trunc('month', …)`，图表与预测工具无需特化。

## 4. 非关系型能力边界

### MongoDB

- 对象树：database → collection / view。
- 结构：采样 30 条文档推断字段，嵌套对象展开一层（如 `meta.city`）；`_id` 标为主键；不保证覆盖所有文档。索引通过 `$listIndexes` 读取，右键「对象信息」列出 `_id_`（主键）、唯一索引、TTL（`expireAfterSeconds` 归入说明列）等，方法列取 `type`（text / 2dsphere…）否则按 unique 判定；同一面板可直接新建索引（字段 + 唯一 / 稀疏 / TTL）与删除索引（手输索引名确认，`_id_` 拒删），走 `POST /indexes/create` 与 `POST /indexes/drop`，只读连接返回 403。
- 查询：结构化 JSON MQL，`op` = `find | aggregate | count | distinct`；支持 `filter / pipeline / projection / sort / limit / skip / field`。
- 结果：文档行；嵌套值 JSON 序列化，`ResultField.kind = 'json'`；`resultKind = 'documents'`。
- 安全：只读连接拦截 `$out`、`$merge`、`$where`、`$function`、`$accumulator` 及系统诊断管道；聚合管道默认追加 `$limit`。
- 写入：`upsert_document`（有 `_id` 则覆盖，24 位十六进制自动转 ObjectId）、`import_documents` CSV 批量导入、`delete_documents` 按 `_id` 删除；只读连接一律拒绝。
- 不支持：DDL 设计器、结构同步、数据对比、SQL dump、用户权限、SQL 体检/图表工具。

### Redis

- 对象树：DB 索引 → `keys` 伪对象（`rowEstimate = DBSIZE`）；安装 RediSearch 时追加每个 `FT._LIST` 索引为“搜索索引”节点，点击即执行 `FT.SEARCH <index> * LIMIT 0 20`。
- 模块：连接测试读取 `MODULE LIST`，版本串显示为 `Redis 7.4 · JSON/RediSearch/TimeSeries/Bloom`。
- 浏览：`SCAN` 采样，不执行 `KEYS *`；双击键行打开键详情（TYPE / TTL / 规模 / 编码 + 按类型展开的取值，覆盖 string/hash/list/set/zset/stream/JSON/TimeSeries），详情窗口内可删除该键（UNLINK，手输键名确认，只返回真实删除数）；「搜索索引」节点右键可删除索引（FT.DROPINDEX 只移除索引定义，文档保留）。
- 查询：单条命令；支持 String / Hash / List / Set / ZSet / Stream 的常用读取命令。
- 结果：`SCAN` 返回 key 列表；`HGETALL` 返回 field/value；`ZRANGE WITHSCORES` 返回 member/score；`INFO` 解析为 field/value；`FT.SEARCH` 兼容 RESP2 与 RESP3 map 两种回复，统一输出 key/score/字段列。
- 安全：只读连接拦截写命令；`FLUSHALL` / `FLUSHDB` / `CONFIG SET` / `EVAL` / `FCALL` / `SHUTDOWN` / `DEBUG` / `MODULE` 等判为 destructive；未知命令按 write 处理。
- 不支持：DDL、备份、SQL 工具、事务型多命令。

### Neo4j

- 对象树：database → 节点标签 / 关系类型；采样 30 个节点/关系推断属性。
- 查询：Cypher 控制台，支持 `$params`；`EXPLAIN` / `PROFILE` 的计划以 JSON 行返回。
- 结果：节点/关系/路径序列化为 JSON 单元格，`resultKind = 'graph'`；标量查询仍为普通表格。
- 安全：只读连接拦截 `CREATE` / `MERGE` / `SET` / `DELETE` / `DETACH DELETE` / `REMOVE` / `LOAD CSV` / `FOREACH` 及写型 `CALL`（APOC/GDS/非只读 DB 过程）。
- 不支持：DDL、备份、SQL 工具。图视图支持力导向布局、缩放平移、拖动节点、属性面板与搜索高亮；超过 140 个节点自动退回环形布局以保证渲染性能。

### Qdrant / Milvus / Weaviate

- 对象树：collection/class（Qdrant 采样 payload 字段；Milvus 读取 field schema；Weaviate 读取 properties）。
- 查询：JSON，`op = scroll` 浏览；提供 `vector` 或 `text` 时执行相似度检索；Qdrant 支持命名向量 `field`。
- 结果：id、score 与 payload/entity/properties 字段，`resultKind = 'vectors'`。
- 文本检索：`text` 由网关调用 Embedding Provider 转成向量；未配置时可直接传 `vector`。
- 写入：`upsert_document` 单条/批量、`import_documents` CSV 批量导入（id/vector 列可指定）、`delete_documents` 按 id 列表删除。
- 建对象：对象树右键菜单「新建集合…／新建索引…」与 `create_collection` / `POST /objects/create` 支持 Qdrant 集合（维度+距离）、Elasticsearch/OpenSearch 索引（mapping 字段）、Weaviate class（属性）、MongoDB 集合、ArangoDB 文档集合或边集合（`edge=true`）；Milvus 需要完整字段与索引定义，明确拒绝。删对象走对象树右键「删除集合…／删除索引…」与 `delete_collection` / `POST /objects/drop`，覆盖同一批引擎，需要手输名字确认，只读连接返回 403。Qdrant 的 payload 索引通过 `GET /collections/{c}` 的 `payload_schema` 显示在「对象信息」里，建索引走 `PUT /collections/{c}/index?wait=true` + `field_schema`（老版的路径写法已被拒绝），删除走 `DELETE /collections/{c}/index/{field}`。不支持 SQL DDL 设计器与备份。
- 导出：查询结果可导出 CSV/JSON/XML（INSERT 脚本仅 SQL 引擎）。

### Cassandra / ScyllaDB

- 对象树：keyspace → table；列、主键/分区键/clustering key。
- 查询：CQL 控制台，支持 `?` 参数；无 JOIN。
- 结果：普通行结果；`resultKind` 缺省为表格。
- 不支持：SQL 工具、DDL 设计器、备份、JOIN、网格编辑（CQL 写入通过控制台语句执行）。

### TDengine

- 连接：taosAdapter REST，默认端口 6041，Basic 认证（root / taosdata）。
- 对象树：database → 超级表（stable）与子表；`DESCRIBE` 读取列与 `TAG` 标记。
- 查询：SQL 控制台（单语句）；支持 `SHOW` / `DESCRIBE` / `SELECT` / `INSERT` / `CREATE STABLE` 等。
- 结果：普通行结果；`resultKind` 缺省为表格。
- 不支持：参数化查询（REST 无预处理）、网格编辑、结构同步、备份。

### Elasticsearch / OpenSearch

- 对象树：索引 → mapping 字段，展示文档数/health。
- 查询：JSON `_search` DSL（`{index, query, body, size}`），默认 `match_all`。
- 结果：`_id`、`_score`、`_source` 字段，`resultKind = 'documents'`。
- 写入：`upsert_document` 批量索引、`import_documents` CSV 导入（id 列映射为 `_id`）、`delete_documents` 按 `_id` 删除；不支持 DDL 与备份。
- 导出：结果可导出 CSV/JSON/XML（INSERT 脚本仅 SQL 引擎）。

## 5. 安全模型

只读在网关侧强制执行，不依赖 UI：

- SQL：沿用 `readonlyViolation` 静态分类。
- MQL：`classifyMql` 递归扫描 filter/pipeline/projection/sort，按 `$where` / `$function` / `$out` / `$merge` 等提升风险。
- Redis：`classifyRedis` 按命令表与子命令（CONFIG / ACL / CLUSTER / MEMORY / FUNCTION）分类。
- Cypher：`classifyCypher` 先屏蔽字符串/注释/反引号，再识别写子句与写型过程；`EXPLAIN` 为只读，`PROFILE` 按内部语句定级。
- 向量：`classifyVector` 校验 collection/topK/向量数值，只读检索走 `<=>` 相似度查询或各自 REST；写入通过 `upsert_document`（需 `write` 权限，只读连接拒绝）。
- Agent：`resolveRisk` 对 `run_mql` / `run_redis` 动态取风险；审批弹窗展示结构化查询。
- SQL 专属工具在非 SQL 连接上返回 `UNSUPPORTED_ENGINE`；HTTP 的 DDL / 数据编辑 / 结构同步 / 监控 / 用户 / 备份等路由同样拒绝。例外：`manage_index` 在 MongoDB / Qdrant / ArangoDB 上走 `POST /indexes/*` 的结构化通道（与对象信息面板同一实现），`create_collection` / `delete_collection` / `upsert_document` / `delete_documents` / `import_documents` 也按能力位开放。

## 6. Agent 工具

工具总数 35：

| 工具 | 作用 |
|---|---|
| `run_mql` | MongoDB 结构化查询（find/aggregate/count/distinct） |
| `run_redis` | 单条 Redis 命令 |
| `run_cypher` | Neo4j / Memgraph / FalkorDB Cypher 查询（支持 `$params`） |
| `run_aql` | ArangoDB AQL 查询（支持 `@bindVar` 与 `@@collection`） |
| `upsert_document` | 批量写入文档/向量点（MongoDB / ArangoDB / Qdrant / Weaviate / Milvus / ES / OpenSearch） |
| `delete_documents` | 按 id 列表删除文档/向量点/搜索文档（ArangoDB 用 `_key`） |
| `import_documents` | CSV 批量导入文档/向量点（含 ArangoDB，id 列映射为 `_key`） |
| `create_collection` | 创建向量集合 / 搜索索引 / Weaviate class / MongoDB 集合 |
| `delete_collection` | 删除向量集合 / 搜索索引 / Weaviate class / MongoDB 集合（需 `confirm` 原样重复名字） |
| `run_cql` | Cassandra / ScyllaDB CQL（支持 `?` 参数） |
| `vector_search` | pgvector / Qdrant / Milvus / Weaviate 向量检索（text 走 Embedding） |
| `search_index` | Elasticsearch / OpenSearch `_search` JSON DSL |

系统提示会注入 `model=` 与 `queryLanguage=`，并按连接语言切换规则：SQL 连接保留审计/图表/EXPLAIN 等规则；MongoDB/Redis/Neo4j 连接改为对应查询规则，并明确禁止输出 SQL。

## 7. UI 行为

- 连接表单由 `EngineMeta` 驱动默认端口、默认用户名、默认数据库与限制；MongoDB/Redis/Neo4j 显示“数据库 / DB 索引”字段。
- 对象树按查询语言渲染：SQL 连接（含 TDengine）显示表/视图与完整右键菜单；MongoDB 显示“集合”；Redis 显示“键空间”（安装 RediSearch 时追加“搜索索引”）；Cassandra/ScyllaDB 显示“表”；Neo4j/Memgraph/FalkorDB 显示“标签”、ArangoDB 显示“集合”；Qdrant/Milvus/Weaviate 显示“向量集合”；Elasticsearch/OpenSearch 显示“索引”。非关系型保留打开、查询、导出结果、AI 解释、刷新、复制；支持对象生命周期的引擎（Qdrant、Elasticsearch/OpenSearch、Weaviate、MongoDB、ArangoDB）在集合文件夹上多一项「新建集合…／新建索引…」，在集合节点上多一项「删除集合…／删除索引…」；Redis 的「搜索索引」节点同样提供「删除索引…」；已读到索引的集合（MongoDB、Qdrant、ArangoDB）多一项「对象信息」，可在面板里建删索引。
- 查询窗口按语言切换：SQL 连接保留美化、EXPLAIN、查询构建器、图表、SQL 文件；MongoDB/Redis/Neo4j/向量库/搜索索引显示 JSON/命令/Cypher 提示并隐藏 SQL 专属按钮。
- 图查询结果为 `resultKind=graph` 时，结果区提供“表格 / 图”切换；图视图为基础环形布局，悬停节点可查看属性。
- PostgreSQL / Qdrant / Milvus 的查询工具栏提供“向量检索”面板：选择表/集合与向量字段，输入文本（走 Embedding）或向量 JSON、TopK，结果直接进入 DataGrid。
- `openData` 对非关系型自动改为打开查询标签：MongoDB 预填 `{collection, op:'find', filter:{}, limit:100}`，Redis 预填 `SCAN 0 COUNT 100`，Cassandra/ScyllaDB 预填 `SELECT * FROM "ks"."table" LIMIT 100;`，Neo4j 预填 `MATCH (n) RETURN n LIMIT 100`，Qdrant/Milvus/Weaviate 预填 `{collection, op:'scroll', topK:20}`，搜索索引预填 `{index, query:{match_all:{}}, size:100}`。

## 8. 测试

```bash
npm run typecheck --workspaces --if-present
npm --workspace @aidb/core run test
npm --workspace @aidb/gateway run test
npm run build
```

真实实例契约测试通过环境变量启用，未设置时自动跳过：

```bash
# 临时容器（示例）
docker run -d --rm --name aidb-test-mongo -p 27018:27017 mongo:7
docker run -d --rm --name aidb-test-redis -p 6380:6379 redis:7-alpine
# Redis Stack（含 JSON/RediSearch/TimeSeries）：docker run -d --rm --name aidb-test-redis-stack -p 6380:6379 redis/redis-stack-server:latest
docker run -d --rm --name aidb-test-neo4j -p 7688:7687 -e NEO4J_AUTH=neo4j/testpass neo4j:5
docker run -d --rm --name aidb-test-memgraph -p 7689:7687 memgraph/memgraph:latest
docker run -d --rm --name aidb-test-cassandra -p 9043:9042 -e CASSANDRA_CLUSTER_NAME=aidb -e MAX_HEAP_SIZE=512M -e HEAP_NEWSIZE=128M cassandra:4.1
docker run -d --rm --name aidb-test-pgvector -p 5434:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=aidb pgvector/pgvector:pg16
docker run -d --rm --name aidb-test-qdrant -p 6335:6333 qdrant/qdrant
docker run -d --rm --name aidb-test-weaviate -p 8081:8080 -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true -e PERSISTENCE_DATA_PATH=/var/lib/weaviate -e DEFAULT_VECTORIZER_MODULE=none -e CLUSTER_HOSTNAME=node1 semitechnologies/weaviate:1.26.4
docker run -d --rm --name aidb-test-es -p 9203:9200 -e discovery.type=single-node -e xpack.security.enabled=false -e ES_JAVA_OPTS='-Xms512m -Xmx512m' docker.elastic.co/elasticsearch/elasticsearch:8.15.0
docker run -d --rm --name aidb-test-tdengine -p 6042:6041 tdengine/tdengine:3.2.3.0
docker run -d --rm --name aidb-test-falkor -p 6382:6379 falkordb/falkordb:latest
docker run -d --rm --name aidb-test-influx -p 8184:8181 influxdb:3-core influxdb3 serve --node-id=aidb --object-store=memory --without-auth
docker run -d --rm --name aidb-test-arango -p 8530:8529 -e ARANGO_ROOT_PASSWORD=testpass arangodb:3.12
docker run -d --rm --name aidb-test-timescale -p 5445:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=aidb timescale/timescaledb:latest-pg16
# Milvus standalone 需要 etcd + minio，参考官方 docker compose；示例映射 19531:19530

# 达梦 DM8：官方未提供轻量镜像，可用社区镜像初始化后运行（示例）
# docker run ... sizx/dm8，dminit + dmserver，映射 5237:5236

AIDB_TEST_MONGO_PORT=27018 AIDB_TEST_REDIS_PORT=6380 AIDB_TEST_NEO4J_PORT=7688 AIDB_TEST_NEO4J_PASSWORD=testpass AIDB_TEST_MEMGRAPH_PORT=7689 AIDB_TEST_CASSANDRA_PORT=9043 AIDB_TEST_PGVECTOR_PORT=5434 AIDB_TEST_QDRANT_PORT=6335 AIDB_TEST_WEAVIATE_PORT=8081 AIDB_TEST_ELASTICSEARCH_PORT=9203 AIDB_TEST_MILVUS_PORT=19531 AIDB_TEST_TDENGINE_PORT=6042 AIDB_TEST_FALKORDB_PORT=6382 AIDB_TEST_INFLUXDB_PORT=8184 AIDB_TEST_ARANGO_PORT=8530 AIDB_TEST_REDIS_STACK_PORT=6380 AIDB_TEST_TIMESCALE_PORT=5445 npm --workspace @aidb/gateway run test
NODE_OPTIONS=--openssl-legacy-provider AIDB_TEST_DM_PORT=5237 AIDB_TEST_DM_PASSWORD=SYSDBA npm --workspace @aidb/gateway run test
```

覆盖：驱动工厂协议别名路由、MongoDB、Redis（含 Redis Stack 模块与 RediSearch）、Neo4j/Memgraph/FalkorDB、ArangoDB、Cassandra/ScyllaDB、达梦、DuckDB、TDengine、InfluxDB、TimescaleDB 超表标注（均含本地 stub 或联机协议测试）、Qdrant/Milvus/Weaviate、pgvector + Embedding、Elasticsearch/OpenSearch，HTTP `/schema`、`/query`、`/vector/search` 管线、对象创建与删除（Qdrant / Elasticsearch / OpenSearch / Weaviate / MongoDB / ArangoDB）、Redis 键与 RediSearch 索引删除、非 SQL 连接的功能禁用。

## 9. 已知限制

- MongoDB 结构是采样推断，不能替代模型校验；authSource / replicaSet 可通过在 Host 字段填完整 `mongodb://` URI 传入。
- Redis 键浏览基于 SCAN 采样，超大键空间只展示当前批次；`SELECT` 被拒绝，请用数据库下拉切换 DB。
- Neo4j 结果为 JSON 单元格，尚未做图布局/可视化；属性推断基于 30 个样本，复杂图模型请用 `CALL db.labels()` / `db.schema.visualization()` 核对。
- openGauss/GaussDB 的 sha256 认证与标准 `pg` 驱动不兼容；当前要求实例改用 md5 或使用兼容认证，后续可补 SASL/侧车。
- 国产分析型（Doris/StarRocks/GBase 8a）只保证查询与浏览，DDL 设计器按能力位关闭。
- 达梦 dmdb 使用 DES-CFB 登录加密，Node 18+ 需要 `--openssl-legacy-provider`；桌面端 Bridge 与 `npm start` 已内置该参数，独立部署请自行添加。DM 方言沿用 Oracle 兼容类型与 `LIMIT` 分页，复杂 PL/SQL、系统表差异仍需按实例验证。
- DuckDB 使用 sqlite 方言的引号/占位符/LIMIT，DDL 设计器关闭；DuckDB 原生模块已随 gateway 打包，但桌面端优先使用系统 Node，回退到 Electron Node 时需按 ABI 验证二进制。
- Qdrant/Milvus/Weaviate 文本检索依赖 Embedding Provider；Qdrant 的 API Key、Milvus/Weaviate 的 Token/API Key 填在密码字段。当前只支持浏览/检索，不支持写入与删除。
- pgvector 只支持 PostgreSQL 方言；相似度分数按 `1 - cosine_distance` 返回，metric 以索引定义为准。
- Elasticsearch/OpenSearch 支持 `_search` DSL 与按 ID 写入文档；OpenSearch 复用 Elasticsearch 驱动，个别 API/字段差异需按实例验证。
- Memgraph 复用 Bolt 驱动；不支持 `CALL db.labels()`，标签/关系通过 Cypher 扫描推断；多数据库与系统表能力有限。
- Cassandra/ScyllaDB 只支持 CQL 控制台与 keyspace/table 浏览；无 JOIN、无 DDL 设计器、无写入网格；默认本地数据中心按 `datacenter1` 配置，非默认拓扑需调整。
- Weaviate 检索使用 GraphQL `nearVector`；文本检索需先经 Embedding，未配置时请传向量。
- TDengine 走 taosAdapter REST：无参数化查询、无网格编辑；对象树最多列出 500 个表，超大库请用 SQL 过滤。
- FalkorDB 通过 Redis 协议执行 `GRAPH.QUERY`：参数以 `CYPHER k=v` 前缀内联（驱动已做字面量转义），属性/统计信息来自 `GRAPH.QUERY` 的第二、三段返回；无多图事务与索引管理 UI。
- InfluxDB 3 的 SQL 接口只读，且只有 `iox`/`system`/`information_schema` 三个 schema；建库写数据需用 `influxdb3` CLI 或行协议 API。InfluxDB 1.x/2.x 的 Flux/InfluxQL 端点不同，当前只保证 3.x。
- ArangoDB 走 HTTP `/_api/cursor`：AQL 无 DDL 设计器，文档集合与边集合通过 `/_api/collection` 在对象树里新建/删除（边集合靠请求体 `type: 3`，查询参数会被忽略）；`_` 前缀的系统集合既不能创建也不能删除。索引通过 `GET /_api/index?collection=` 显示在「对象信息」里，建索引必须用 `POST /_api/index?collection=<集合>` + body `{type:'inverted', fields:[...]}`（这一版拒绝路径写法与 `unique` / 数字类型，TTL 要求 `expireAfter` 属性），删除按 `collection/编号` 两段路径走；主键索引拒删。写入走 `/_api/document/{collection}?overwriteMode=replace`（带 `_key` 覆盖、不带则插入，`_id`/`_rev` 会被剔除），删除用 `REMOVE … FILTER d._key IN @ids`；批量接口按条目返回错误，遇到非法 `_key` 会抛错而不是静默跳过。文档集合与边集合都按对象树展示，带 `_from`/`_to` 或 path 的结果自动切换图视图；单批上限 1000 行，超出自动 follow-up 并截断。
- 向量/搜索写入已支持单条文档写入；批量导入与删除仍待补。

## 10. 后续路线

| 阶段 | 内容 |
|---|---|
| P1 | 已完成：Neo4j、达梦 DM8、DuckDB、Qdrant、Milvus、pgvector + Embedding |
| P2 | 已完成：Memgraph、Cassandra/ScyllaDB、Weaviate、Elasticsearch/OpenSearch、TDengine、FalkorDB、InfluxDB、ArangoDB、交互式图视图、Redis Stack 模块与 RediSearch 浏览、向量/搜索/文档的批量写入与按 id 删除、CSV 导入、非 SQL 结果导出、集合/索引创建与删除 |
| P3 | 已完成：TimescaleDB（复用 PG 驱动 + 超表标注）；待接：云数仓（Snowflake / BigQuery / Redshift / Databricks）、Db2 / SAP HANA、无 Node 驱动的国产库（神通 / GBase 8s / 崖山 / 虚谷） |

## 11. 关键文件

- 类型与注册：[`packages/core/src/types.ts`](../packages/core/src/types.ts)、[`packages/core/src/engines.ts`](../packages/core/src/engines.ts)
- 结构化查询与安全：[`packages/core/src/query.ts`](../packages/core/src/query.ts)
- 驱动接口：[`apps/gateway/src/drivers/types.ts`](../apps/gateway/src/drivers/types.ts)、[`apps/gateway/src/drivers/index.ts`](../apps/gateway/src/drivers/index.ts)
- 宽列/时序/向量/图/嵌入式/搜索：[`apps/gateway/src/drivers/tdengine.ts`](../apps/gateway/src/drivers/tdengine.ts)、[`cassandra.ts`](../apps/gateway/src/drivers/cassandra.ts)、[`qdrant.ts`](../apps/gateway/src/drivers/qdrant.ts)、[`milvus.ts`](../apps/gateway/src/drivers/milvus.ts)、[`weaviate.ts`](../apps/gateway/src/drivers/weaviate.ts)、[`duckdb.ts`](../apps/gateway/src/drivers/duckdb.ts)、[`elasticsearch.ts`](../apps/gateway/src/drivers/elasticsearch.ts)、[`embeddings.ts`](../apps/gateway/src/embeddings.ts)
- 向量 UI：[`apps/desktop/src/components/VectorSearchPanel.tsx`](../apps/desktop/src/components/VectorSearchPanel.tsx)
- MongoDB / Redis / Neo4j / 达梦：[`mongodb.ts`](../apps/gateway/src/drivers/mongodb.ts)、[`redis.ts`](../apps/gateway/src/drivers/redis.ts)、[`neo4j.ts`](../apps/gateway/src/drivers/neo4j.ts)、[`dm.ts`](../apps/gateway/src/drivers/dm.ts)
- 网关执行管线：[`apps/gateway/src/manager.ts`](../apps/gateway/src/manager.ts)
- Agent 工具：[`packages/core/src/agent/tools.ts`](../packages/core/src/agent/tools.ts)、[`apps/gateway/src/executor.ts`](../apps/gateway/src/executor.ts)
- UI：[`apps/desktop/src/components/ConnectionModal.tsx`](../apps/desktop/src/components/ConnectionModal.tsx)、[`Sidebar.tsx`](../apps/desktop/src/components/Sidebar.tsx)、[`QueryView.tsx`](../apps/desktop/src/components/QueryView.tsx)
