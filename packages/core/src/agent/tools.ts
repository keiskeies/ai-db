import type { JsonSchema, ToolDefinition } from './types';

const columnSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', description: 'Column name' },
    type: { type: 'string', description: 'SQL type, e.g. INTEGER, VARCHAR(255), TIMESTAMP' },
    nullable: { type: 'boolean' },
    defaultValue: { type: ['string', 'null'] },
    primaryKey: { type: 'boolean' },
    autoIncrement: { type: 'boolean' },
    unique: { type: 'boolean' },
    comment: { type: 'string' },
  },
};

const indexSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['columns'],
  properties: {
    name: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    unique: { type: 'boolean' },
  },
};

const connectionProp = { connectionId: { type: 'string', description: 'Connection id from list_connections' } };
const databaseProp = { database: { type: 'string', description: 'Database/schema name; defaults to the connection database' } };

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_connections',
    description: 'List configured database connections with id, engine, environment and readonly flag. Call this first when the connection is unknown.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { includeOffline: { type: 'boolean' } },
    },
    summarize: () => '列出数据库连接',
  },
  {
    name: 'inspect_schema',
    description: 'Inspect database or table structure: columns, types, primary keys, indexes, foreign keys and comments. Use before writing SQL when unsure.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        tables: { type: 'array', items: { type: 'string' }, description: 'Optional table names to inspect in detail' },
      },
    },
    summarize: (a) => `查看结构 ${Array.isArray(a.tables) && a.tables.length ? a.tables.join(', ') : (a.database ?? '')}`.trim(),
  },
  {
    name: 'search_objects',
    description: 'Search tables and columns by name or comment. Useful for large schemas.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'query'],
      properties: { ...connectionProp, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
    summarize: (a) => `搜索 ${a.query}`,
  },
  {
    name: 'run_sql',
    description: 'Execute SQL on a connection. SELECT is read-only; writes/DDL are classified and may require approval. Keep result sets small and add LIMIT to exploratory SELECTs.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'sql'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        sql: { type: 'string' },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000 },
        dryRun: { type: 'boolean', description: 'Return the SQL that would run without executing' },
      },
    },
    summarize: (a) => String(a.sql ?? '').replace(/\s+/g, ' ').slice(0, 80),
  },
  {
    name: 'run_mql',
    description:
      'Run a structured MongoDB query on a MongoDB connection. Use find/aggregate/count/distinct; never pass SQL. Filters and pipelines are JSON objects. Results are capped by maxRows.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'collection', 'op'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        collection: { type: 'string', description: 'Collection name' },
        op: { type: 'string', enum: ['find', 'aggregate', 'count', 'distinct'], description: 'Operation; defaults to find' },
        filter: { type: 'object', description: 'MongoDB filter document, e.g. {"status":"paid"}' },
        pipeline: { type: 'array', items: { type: 'object' }, description: 'Aggregation pipeline stages' },
        projection: { type: 'object', description: 'Projection document' },
        sort: { type: 'object', description: 'Sort document, e.g. {"createdAt":-1}' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        skip: { type: 'integer', minimum: 0 },
        field: { type: 'string', description: 'Field for distinct' },
        maxRows: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    summarize: (a) => `MongoDB ${a.op ?? 'find'} ${a.collection ?? ''}`.trim(),
  },
  {
    name: 'run_redis',
    description:
      'Execute one Redis command on a Redis connection. Prefer SCAN over KEYS. Dangerous commands (FLUSHALL, CONFIG, EVAL, SHUTDOWN) are classified and may require approval.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'command'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        command: { type: 'string', description: 'Redis command, e.g. GET or HGETALL' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000 },
      },
    },
    summarize: (a) => `Redis ${a.command ?? ''} ${String((a.args as string[] | undefined)?.[0] ?? '')}`.trim(),
  },
  {
    name: 'run_cypher',
    description:
      'Run a Cypher query on a Neo4j graph connection. Use $params for values. Read-only connections reject CREATE/MERGE/SET/DELETE/REMOVE/LOAD CSV and write procedures.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'query'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        query: { type: 'string', description: 'Cypher statement, e.g. MATCH (n:Person) RETURN n LIMIT 10' },
        params: { type: 'object', description: 'Cypher parameters' },
        maxRows: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    summarize: (a) => `Cypher ${String(a.query ?? '').replace(/\s+/g, ' ').slice(0, 60)}`,
  },
  {
    name: 'vector_search',
    description:
      'Search a vector collection/table by vector or text. For PostgreSQL/pgvector specify field (vector column). For Qdrant/Milvus field selects a named vector. Text requires an embedding provider; otherwise pass vector.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'collection'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        collection: { type: 'string', description: 'Collection or table name' },
        field: { type: 'string', description: 'Vector column/field (required for pgvector)' },
        vector: { type: 'array', items: { type: 'number' }, description: 'Query vector' },
        text: { type: 'string', description: 'Text to embed and search' },
        topK: { type: 'integer', minimum: 1, maximum: 1000 },
        filter: { type: 'object', description: 'Backend-specific filter' },
      },
    },
    summarize: (a) => `向量检索 ${a.collection ?? ''}${a.field ? ` · ${a.field}` : ''}`.trim(),
  },
  {
    name: 'search_index',
    description:
      'Run an Elasticsearch/OpenSearch _search JSON DSL against an index. Pass the DSL body as query (e.g. {"match":{"message":"error"}}), or omit it for match_all. size is capped at 10000.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'index'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        index: { type: 'string', description: 'Index name, e.g. logs-*' },
        query: { type: 'object', description: 'Elasticsearch query DSL (the query object)' },
        body: { type: 'object', description: 'Full search body; overrides query' },
        size: { type: 'integer', minimum: 1, maximum: 10000 },
      },
    },
    summarize: (a) => `搜索 ${a.index ?? ''}`.trim(),
  },
  {
    name: 'run_cql',
    description:
      'Run a CQL statement on a Cassandra/ScyllaDB connection. Use ? placeholders and params for values. CQL has no JOINs; prefer bounded SELECTs with partition keys.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'query'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        query: { type: 'string', description: 'CQL statement, e.g. SELECT * FROM ks.tbl LIMIT 10' },
        params: { type: 'array', items: {}, description: 'Positional bind values for ? placeholders' },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000 },
      },
    },
    summarize: (a) => `CQL ${String(a.query ?? '').replace(/\s+/g, ' ').slice(0, 60)}`,
  },
  {
    name: 'run_aql',
    description:
      'Run an AQL (ArangoDB Query Language) statement on an ArangoDB connection. Use @bindVar names with the params object for values, and @@collection for collection names. Bound FOR ... LIMIT queries return documents as JSON cells; traversals with edges render as a graph.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'query'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        query: { type: 'string', description: 'AQL statement, e.g. FOR d IN person LIMIT 10 RETURN d' },
        params: { type: 'object', description: 'Bind variables, e.g. {"@collection":"person","minAge":18}' },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000 },
      },
    },
    summarize: (a) => `AQL ${String(a.query ?? '').replace(/\s+/g, ' ').slice(0, 60)}`,
  },
  {
    name: 'explain_sql',
    description: 'Get the query execution plan (EXPLAIN) for a SQL statement.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'sql'],
      properties: { ...connectionProp, ...databaseProp, sql: { type: 'string' } },
    },
    summarize: (a) => `执行计划：${String(a.sql ?? '').slice(0, 60)}`,
  },
  {
    name: 'sample_rows',
    description: 'Fetch a small sample of rows from a table. Sensitive-looking columns are masked by default.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table'],
      properties: { ...connectionProp, ...databaseProp, table: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, maskSensitive: { type: 'boolean' } },
    },
    summarize: (a) => `样例数据 ${a.table}`,
  },
  {
    name: 'profile_column',
    description: 'Profile a column: null ratio, distinct count, top values, min/max. Use for data quality questions.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table', 'column'],
      properties: { ...connectionProp, ...databaseProp, table: { type: 'string' }, column: { type: 'string' } },
    },
    summarize: (a) => `列画像 ${a.table}.${a.column}`,
  },
  {
    name: 'create_table',
    description: 'Create a table from structured columns. Also supports indexes. Requires ddl permission.',
    risk: 'ddl',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table', 'columns'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        table: { type: 'string' },
        columns: { type: 'array', items: columnSchema },
        indexes: { type: 'array', items: indexSchema },
        comment: { type: 'string' },
      },
    },
    summarize: (a) => `创建表 ${a.table}`,
  },
  {
    name: 'alter_table',
    description: 'Alter a table: add/drop/rename columns, change column type, add/drop indexes. Dropping columns is destructive.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table', 'operations'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        table: { type: 'string' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['op'],
            properties: {
              op: { type: 'string', enum: ['add_column', 'drop_column', 'rename_column', 'alter_column', 'add_index', 'drop_index'] },
              column: columnSchema,
              name: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              type: { type: 'string' },
              nullable: { type: 'boolean' },
              defaultValue: { type: ['string', 'null'] },
              index: indexSchema,
            },
          },
        },
      },
    },
    summarize: (a) => `修改表 ${a.table}`,
  },
  {
    name: 'drop_object',
    description: 'Drop a table or view. Destructive: requires explicit approval, a backup is taken when enabled.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'kind', 'name'],
      properties: { ...connectionProp, ...databaseProp, kind: { type: 'string', enum: ['table', 'view'] }, name: { type: 'string' }, cascade: { type: 'boolean' } },
    },
    summarize: (a) => `删除 ${a.kind} ${a.name}`,
  },
  {
    name: 'manage_index',
    description: 'Create or drop an index on a table.',
    risk: 'ddl',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table', 'action'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        table: { type: 'string' },
        action: { type: 'string', enum: ['create', 'drop'] },
        index: indexSchema,
        name: { type: 'string', description: 'Index name for drop' },
      },
    },
    summarize: (a) => `${a.action === 'drop' ? '删除' : '创建'}索引 ${a.table}`,
  },
  {
    name: 'export_result',
    description: 'Export a query result or a whole table to CSV, JSON or SQL INSERT file in the exports directory.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'format'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        sql: { type: 'string' },
        table: { type: 'string' },
        format: { type: 'string', enum: ['csv', 'json', 'sql', 'xml'] },
        limit: { type: 'integer', minimum: 1, maximum: 200000 },
      },
    },
    summarize: (a) => `导出 ${a.table ?? '查询结果'} 为 ${a.format}`,
  },
  {
    name: 'import_csv',
    description: 'Import a CSV file into an existing table inside a transaction. Path must be inside the imports directory.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table', 'path'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        table: { type: 'string' },
        path: { type: 'string' },
        hasHeader: { type: 'boolean' },
        delimiter: { type: 'string' },
        mapping: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['column'],
            properties: { column: { type: 'string' }, sourceIndex: { type: 'integer', minimum: 0 } },
          },
        },
      },
    },
    summarize: (a) => `导入 ${a.path} → ${a.table}`,
  },
  {
    name: 'backup_database',
    description: 'Create a logical SQL dump backup of a database (or SQLite file snapshot).',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: { ...connectionProp, ...databaseProp, label: { type: 'string' } },
    },
    summarize: (a) => `备份数据库${a.label ? ` ${a.label}` : ''}`,
  },
  {
    name: 'get_query_history',
    description: 'Read recent query history, optionally filtered by connection or text.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { connectionId: { type: 'string' }, search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
    summarize: () => '读取查询历史',
  },
  {
    name: 'update_plan',
    description: 'Maintain the visible task plan. Use for multi-step tasks: set the steps first, then update statuses as you progress.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'status'],
            properties: { text: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] } },
          },
        },
      },
    },
    summarize: (a) => `更新计划（${Array.isArray(a.items) ? a.items.length : 0} 项）`,
  },
  {
    name: 'memory_write',
    description: 'Persist a durable fact, preference, schema note or playbook to long-term memory. Never store secrets or one-off query results.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'content'],
      properties: {
        kind: { type: 'string', enum: ['fact', 'preference', 'schema', 'procedural'] },
        title: { type: 'string' },
        content: { type: 'string' },
        scopeType: { type: 'string', enum: ['global', 'connection', 'database', 'table'] },
        scopeKey: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        importance: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    summarize: (a) => `记住「${a.title}」`,
  },
  {
    name: 'memory_search',
    description: 'Search long-term memory for facts, preferences and past investigations.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, scope: { type: 'string' } },
    },
    summarize: (a) => `检索记忆「${a.query}」`,
  },
  {
    name: 'audit_database',
    description:
      'Run a concrete database audit: detect tables without primary keys, foreign keys without supporting indexes, duplicate indexes and empty tables. Returns prioritized findings with executable repair SQL. Use for health checks / 巡检.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: { ...connectionProp, ...databaseProp },
    },
    summarize: () => '数据库体检',
  },
  {
    name: 'check_data_quality',
    description:
      'Check a table for concrete data-quality issues: null ratios, blank values, low cardinality, duplicate primary keys and duplicate rows. Returns counts and suggested SQL. Use when asked about 空值/重复/数据质量.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        table: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Optional subset of columns to profile' },
      },
    },
    summarize: (a) => `数据质量检查 ${a.table}`,
  },
  {
    name: 'generate_data',
    description:
      'Generate realistic mock rows for a table (names, emails, statuses, amounts, dates, foreign keys) and insert them. Requires write permission. Use dryRun to preview without writing.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'table'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        table: { type: 'string' },
        rows: { type: 'integer', minimum: 1, maximum: 5000 },
        dryRun: { type: 'boolean' },
      },
    },
    summarize: (a) => `生成 ${a.rows ?? 10} 行测试数据 → ${a.table}`,
  },
  {
    name: 'render_chart',
    description:
      'Execute a SELECT and render the result as a chart in the agent transcript. Use for trends (line), distributions (bar) and proportions (pie). x/y refer to result column names.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'sql', 'type'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        sql: { type: 'string' },
        type: { type: 'string', enum: ['bar', 'line', 'pie'] },
        title: { type: 'string' },
        x: { type: 'string', description: 'Category / x-axis column name' },
        y: { type: 'string', description: 'Numeric / y-axis column name' },
      },
    },
    summarize: (a) => `${a.title ?? '生成图表'}（${a.type}）`,
  },
  {
    name: 'analyze_chart',
    description:
      'Execute a SELECT and return authoritative statistics (count/sum/avg/min/max/argmin/argmax, top-N share, period-over-period deltas) computed on the Bridge. Use this instead of eyeballing rows when the user asks how much / which is biggest / how it changed. The numbers in the result are ground truth — quote them, never recompute or estimate them yourself.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'sql'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        sql: { type: 'string', description: 'Aggregate SELECT; at most 500 rows are read' },
        x: { type: 'string', description: 'Label column; defaults to the first non-numeric column' },
        y: { type: 'string', description: 'Measure column; defaults to the first numeric column' },
        topN: { type: 'number', description: 'How many top shares to return (1-20, default 5)' },
      },
    },
    summarize: (a) => `统计分析（${String(a.sql).slice(0, 40)}…）`,
  },
  {
    name: 'forecast_chart',
    description:
      'Execute a time-series SELECT and extrapolate the next N periods with a deterministic local algorithm (least-squares linear or moving average, auto-selected by |r|). Returns the method, slope/window, fit r, an approximate ±1.28σ band, and the original series. Requires at least 4 valid points; SQL NULLs are dropped, never treated as 0. Report the returned numbers verbatim and always pass along the note.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'sql'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        sql: { type: 'string', description: 'SELECT ordered by time, one row per period' },
        x: { type: 'string', description: 'Time/label column' },
        y: { type: 'string', description: 'Measure column' },
        periods: { type: 'number', description: 'Periods to extrapolate (1-12, default 3)' },
        method: { type: 'string', enum: ['auto', 'linear', 'moving_average'], description: 'Default auto' },
      },
    },
    summarize: (a) => `预测未来 ${a.periods ?? 3} 期`,
  },
];


export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function providerTools(): { name: string; description: string; inputSchema: JsonSchema }[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
