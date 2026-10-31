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
    name: 'create_collection',
    description:
      'Create a vector collection (Qdrant: needs dimension, optional distance Cosine/Euclid/Dot/Manhattan), an Elasticsearch/OpenSearch index (optional field list with mapping types), a Weaviate class (property list), a MongoDB collection or an ArangoDB document/edge collection (edge=true). Milvus and SQL engines are refused: use their DDL paths.',
    risk: 'ddl',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'name'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        name: { type: 'string', description: 'Collection, index or class name' },
        dimension: { type: 'integer', minimum: 1, maximum: 65536, description: 'Vector dimension (Qdrant only)' },
        distance: { type: 'string', enum: ['Cosine', 'Euclid', 'Dot', 'Manhattan'] },
        fields: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'type'],
            properties: { name: { type: 'string' }, type: { type: 'string' } },
          },
        },
        edge: { type: 'boolean', description: 'ArangoDB only: create an edge collection instead of a document collection' },
      },
    },
    summarize: (a) => `创建集合 ${a.name ?? ''}`.trim(),
  },
  {
    name: 'delete_collection',
    description:
      'Drop a whole vector collection (Qdrant), search index (Elasticsearch/OpenSearch), Weaviate class, MongoDB collection or ArangoDB collection. This destroys every document inside it: require an explicit user confirmation and pass confirm identical to name.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'name', 'confirm'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        name: { type: 'string', description: 'Collection, index or class to drop' },
        confirm: { type: 'string', description: 'Must equal name, proving the caller repeated it' },
      },
    },
    summarize: (a) => `删除集合 ${a.name ?? ''}`.trim(),
  },
  {
    name: 'upsert_document',
    description:
      'Create or replace documents in a MongoDB collection, an ArangoDB collection, a Qdrant/Weaviate/Milvus collection or an Elasticsearch/OpenSearch index. Pass one document or a documents array (max 500). Vector engines need a vector field; ids live inside each document (_id for MongoDB and Elasticsearch, _key for ArangoDB).',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'collection'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        collection: { type: 'string', description: 'Collection, class or index name' },
        document: { type: 'object', description: 'A single JSON document' },
        documents: { type: 'array', items: { type: 'object' }, maxItems: 500, description: 'Batch of JSON documents' },
      },
    },
    summarize: (a) => `写入 ${a.collection ?? ''}${Array.isArray(a.documents) ? ` ×${(a.documents as unknown[]).length}` : ''}`.trim(),
  },
  {
    name: 'write_line_protocol',
    description:
      'Write time-series samples to InfluxDB using line protocol, because the InfluxDB SQL API is read-only. Pass lines as a string (one sample per line) or an array. Format: measurement,tag=v field=value timestamp (timestamp in nanoseconds). Duplicate timestamps and tags overwrite by design.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        lines: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 5000 }],
          description: 'Line-protocol samples, as one multi-line string or an array of lines',
        },
      },
    },
    summarize: (a) => {
      const lines = typeof a.lines === 'string' ? a.lines.split(/\r?\n/).filter((line) => line.trim()) : Array.isArray(a.lines) ? a.lines : [];
      return `行协议写入 ${lines.length} 行`;
    },
  },
  {
    name: 'import_documents',
    description:
      'Bulk-import a CSV into a MongoDB collection, an ArangoDB collection, a Qdrant/Weaviate/Milvus collection or an Elasticsearch/OpenSearch index (max 5000 rows). Header names become fields; idColumn maps the id field (_id / _key / id) and vectorColumn parses arrays like "[0.1,0.2]" for vector collections.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'collection'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        collection: { type: 'string' },
        csv: { type: 'string', description: 'CSV text' },
        path: { type: 'string', description: 'Local CSV path inside the import directory' },
        hasHeader: { type: 'boolean' },
        delimiter: { type: 'string' },
        idColumn: { type: 'string' },
        vectorColumn: { type: 'string' },
      },
    },
    summarize: (a) => `CSV 导入 ${a.collection ?? ''}`.trim(),
  },
  {
    name: 'delete_documents',
    description:
      'Delete documents by an explicit id list from a MongoDB collection, an ArangoDB collection (_key values), a Qdrant/Weaviate/Milvus collection or an Elasticsearch/OpenSearch index. Always confirm the ids with a read query first.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'collection', 'ids'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        collection: { type: 'string', description: 'Collection, class or index name' },
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500, description: 'Document ids to delete' },
      },
    },
    summarize: (a) => `删除 ${a.collection ?? ''} ×${Array.isArray(a.ids) ? (a.ids as unknown[]).length : 0}`.trim(),
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
    description:
      'Alter a table: add/drop/rename columns, change column type, add/drop indexes. Dropping columns is destructive. On Elasticsearch/OpenSearch (mapping) and Weaviate (property) only add_column is supported.',
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
    description:
      'Create or drop an index. On SQL connections `table` is a table/view; on MongoDB connections it is a collection and sparse / expireAfterSeconds (TTL) are supported; on Qdrant it creates a payload index on a single field, where `type` selects keyword / integer / float / text / bool / geo; on ArangoDB it builds an inverted index over the given fields. The _id_ / primary index cannot be dropped.',
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
        sparse: { type: 'boolean', description: 'MongoDB only: build a sparse index' },
        expireAfterSeconds: { type: 'integer', minimum: 1, description: 'MongoDB only: TTL in seconds' },
        type: { type: 'string', enum: ['keyword', 'integer', 'float', 'text', 'bool', 'geo'], description: 'Qdrant only: payload index type' },
      },
    },
    summarize: (a) => `${a.action === 'drop' ? '删除' : '创建'}索引 ${a.table}`,
  },
  {
    name: 'export_result',
    description:
      'Export a query result to a CSV, JSON, XML, XLSX or SQL INSERT file in the exports directory. SQL connections may pass table; non-SQL connections (MongoDB, Redis, graph, vector, search) must pass the same statement text used in the query window, and SQL INSERT output is refused there.',
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
        format: { type: 'string', enum: ['csv', 'json', 'sql', 'xml', 'xlsx'] },
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
    name: 'begin_transaction',
    description:
      'Begin a cross-statement transaction on a relational connection (MySQL, PostgreSQL, Oracle, SQL Server, SQLite, DM8). After this, run_sql calls on the same connection join the transaction until commit_transaction or rollback_transaction. Always finish with one of them; an open transaction holds a database connection.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: {
        ...connectionProp,
        ...databaseProp,
      },
    },
    summarize: () => '开启事务',
  },
  {
    name: 'commit_transaction',
    description: 'Commit the transaction opened by begin_transaction on this session. Fails if there is no open transaction.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: {
        ...connectionProp,
      },
    },
    summarize: () => '提交事务',
  },
  {
    name: 'rollback_transaction',
    description: 'Roll back (discard) everything written since begin_transaction on this session. Fails if there is no open transaction.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId'],
      properties: {
        ...connectionProp,
      },
    },
    summarize: () => '回滚事务',
  },
  {
    name: 'render_chart',
    description:
      `Execute a SELECT and render the result as a chart in the agent transcript. Pick the type from the data shape and the question — never default to bar out of habit:
- bar: compare magnitudes across a small set of categories (≤12); x is the category, y/ys are numeric measures.
- stacked: show how parts compose each category total (or a time series); every measure must share one unit and be non-negative; pass ys and set type=stacked.
- line: change over an ordered axis (time, sequence); x must be ordered, not an unordered category list.
- pie: parts of one whole; a single measure with 3–8 non-negative slices. Never use pie for time series, comparisons across periods, or more than 8 categories.
- scatter: relationship/correlation between two numeric columns; x and y are both numeric, ideally ≥10 points; optional label names each point. Not for categories or time buckets.
- heatmap: one numeric measure across two categorical dimensions (e.g. weekday × hour, region × category); pass the two category columns as x and y and the measure as value. Best for spotting density/hot spots; avoid >20×16 cells.
- radar: compare 3–8 same-unit measures for one or a few records; x is the record/category axis, y plus ys are the measures. Never mix units (count with amount) or use fewer than 3 axes.
x/y/ys/value/label are result column names, not SQL expressions.`,
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectionId', 'sql', 'type'],
      properties: {
        ...connectionProp,
        ...databaseProp,
        sql: { type: 'string' },
        type: { type: 'string', enum: ['bar', 'stacked', 'line', 'pie', 'scatter', 'heatmap', 'radar'] },
        title: { type: 'string' },
        x: { type: 'string', description: 'Column name: category axis (bar/line/pie/radar), numeric x (scatter), horizontal category (heatmap)' },
        y: { type: 'string', description: 'Column name: numeric measure (bar/line/pie/scatter/radar), row category (heatmap)' },
        ys: { type: 'array', items: { type: 'string' }, description: 'Additional numeric measure columns (bar/stacked/line/radar), at most 4' },
        value: { type: 'string', description: 'Heatmap only: numeric measure column' },
        label: { type: 'string', description: 'Scatter only: optional column used to label each point in the tooltip' },
        stacked: { type: 'boolean', description: 'Legacy alias for type=stacked; ignored by other types' },
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
  {
    name: 'schema_diff',
    description: 'Compare schemas between two connections and return changed tables, destructive changes and target-dialect DDL. Read-only.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceConnectionId', 'targetConnectionId'],
      properties: {
        sourceConnectionId: { type: 'string', description: 'Source connection id' },
        sourceDatabase: { type: 'string' },
        targetConnectionId: { type: 'string', description: 'Target connection id' },
        targetDatabase: { type: 'string' },
        tables: { type: 'array', items: { type: 'string' }, description: 'Optional table names to limit the diff' },
        includeDrops: { type: 'boolean', description: 'Include drops (default true)' },
      },
    },
    summarize: (a) => `结构对比 ${a.sourceConnectionId} → ${a.targetConnectionId}`,
  },
  {
    name: 'recon_data',
    description: 'Reconcile data between two sources (SQL table or Redis keyspace). Returns counts, key-level differences and repair commands; read-only.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['left', 'right'],
      properties: {
        left: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'connectionId'],
          properties: {
            kind: { type: 'string', enum: ['table', 'keyspace', 'documents'] },
            connectionId: { type: 'string' },
            database: { type: 'string' },
            table: { type: 'string' },
            collection: { type: 'string', description: 'MongoDB collection / Elasticsearch index' },
            idField: { type: 'string', description: 'Document id field, default _id' },
            keyColumns: { type: 'array', items: { type: 'string' } },
            keyPattern: { type: 'string' },
            keyExtract: { type: 'string' },
            valueType: { type: 'string', enum: ['string', 'hash', 'json'] },
            fields: { type: 'array', items: { type: 'string' } },
          },
        },
        right: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'connectionId'],
          properties: {
            kind: { type: 'string', enum: ['table', 'keyspace', 'documents'] },
            connectionId: { type: 'string' },
            database: { type: 'string' },
            table: { type: 'string' },
            collection: { type: 'string', description: 'MongoDB collection / Elasticsearch index' },
            idField: { type: 'string', description: 'Document id field, default _id' },
            keyColumns: { type: 'array', items: { type: 'string' } },
            keyPattern: { type: 'string' },
            keyExtract: { type: 'string' },
            valueType: { type: 'string', enum: ['string', 'hash', 'json'] },
            fields: { type: 'array', items: { type: 'string' } },
          },
        },
        fieldMap: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['left', 'right'],
            properties: { left: { type: 'string' }, right: { type: 'string' } },
          },
        },
        level: { type: 'string', enum: ['counts', 'keys', 'fields'], description: 'Default keys' },
        baseSide: { type: 'string', enum: ['left', 'right', 'none'] },
        maxKeys: { type: 'number', description: 'Default 200000' },
      },
    },
    summarize: (a) => `数据对账 ${JSON.stringify(a.left)} ↔ ${JSON.stringify(a.right)}`,
  },
  {
    name: 'skill_list',
    description: 'List installed AI skills with id, name, description, version and enabled state. Skills are instruction packages that may include references, scripts and templates.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { includeDisabled: { type: 'boolean' } },
    },
    summarize: (a) => `列出 Skills${a.includeDisabled ? '（含禁用）' : ''}`,
  },
  {
    name: 'skill_read',
    description: 'Read a text file from an installed skill, such as SKILL.md, references/* or workflows/*. Use this for progressive skill loading instead of assuming its contents.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['skill'],
      properties: {
        skill: { type: 'string', description: 'Skill id' },
        path: { type: 'string', description: 'Relative path inside the skill, default SKILL.md' },
        maxChars: { type: 'number', description: 'Max characters to return (default 120000)' },
        offset: { type: 'number', description: 'Character offset for reading a large document in chunks; use nextOffset from the previous result' },
      },
    },
    summarize: (a) => `读取 Skill ${a.skill}/${a.path ?? 'SKILL.md'}`,
  },
  {
    name: 'skill_write',
    description: 'Write a text file into a skill run workspace or output directory. Requires aidb.skill.json fs permission. Returns the run id.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['skill', 'path', 'content'],
      properties: {
        skill: { type: 'string' },
        runId: { type: 'string', description: 'Existing skill run id; omit to create one' },
        area: { type: 'string', enum: ['workspace', 'output'], description: 'Default workspace' },
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
    summarize: (a) => `写入 Skill ${a.skill}/${a.path}`,
  },
  {
    name: 'skill_run',
    description: 'Run a declared entrypoint from a skill aidb.skill.json in its sandbox workspace. Only python/node commands declared by the skill are allowed, and fixed entrypoints reject arbitrary args.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['skill', 'entrypoint'],
      properties: {
        skill: { type: 'string' },
        entrypoint: { type: 'string' },
        runId: { type: 'string', description: 'Existing skill run id; omit to reuse the run of this session' },
        args: { type: 'array', items: { type: 'string' }, description: 'Only for entrypoints declared with allowArgs' },
      },
    },
    summarize: (a) => `运行 Skill ${a.skill}#${a.entrypoint}`,
  },
  {
    name: 'skill_list_files',
    description: 'List files in a skill run workspace, input and output directories.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skill: { type: 'string', description: 'Skill id; omit when runId identifies it' },
        runId: { type: 'string', description: 'Skill run id; omit to reuse this session’s run' },
      },
    },
    summarize: (a) => `列出 Skill 运行文件 ${a.runId ?? a.skill}`,
  },
  {
    name: 'skill_worker_run',
    description:
      'Run an installed skill in an isolated Skill Worker (own context, own tool whitelist) and return its final text plus output files. Use this for long skills such as PPT Master deck generation; the main conversation only receives the final answer and artifact paths.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['skill', 'prompt'],
      properties: {
        skill: { type: 'string', description: 'Skill id, e.g. ppt-master' },
        prompt: { type: 'string', description: 'Task for the worker: audience, page count, required numbers/tables, language' },
        timeoutSeconds: { type: 'number', description: 'Max wait, 30–900 seconds (default 600)' },
      },
    },
    summarize: (a) => `Skill Worker ${a.skill}: ${String(a.prompt ?? '').slice(0, 80)}`,
  },
  {
    name: 'mcp_list_servers',
    description:
      'List configured MCP servers (built-in and external) with their exact id, enabled state, configured paths/hosts and built-in tool names. Call this before mcp_list_tools and never guess a server name.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeDisabled: { type: 'boolean', description: 'Include disabled servers (default false)' },
      },
    },
    summarize: () => '列出 MCP Server',
  },
  {
    name: 'mcp_list_tools',
    description: 'List tools exposed by a configured MCP server (stdio transport). Use this before mcp_call when the tool name is unknown.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'MCP server id or configured name' },
      },
    },
    summarize: (a) => `列出 MCP 工具 ${a.server}`,
  },
  {
    name: 'mcp_call',
    description:
      'Call a tool on a configured MCP server. Arguments are passed through as JSON. Built-in read-only tools run directly; writes and external servers require approval in ask mode.',
    risk: 'dynamic',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['server', 'tool'],
      properties: {
        server: { type: 'string', description: 'MCP server id or configured name' },
        tool: { type: 'string', description: 'Tool name from mcp_list_tools' },
        arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments' },
      },
    },
    summarize: (a) => `MCP ${a.server}.${a.tool}`,
  },
  {
    name: 'transfer_data',
    description: 'Copy tables and rows between two connections. Target missing tables are created; replace mode clears the target table first. Write operation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceConnectionId', 'targetConnectionId'],
      properties: {
        sourceConnectionId: { type: 'string' },
        sourceDatabase: { type: 'string' },
        targetConnectionId: { type: 'string' },
        targetDatabase: { type: 'string' },
        tables: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Default append' },
        createMissing: { type: 'boolean', description: 'Default true' },
      },
    },
    summarize: (a) => `传输数据 ${a.sourceConnectionId} → ${a.targetConnectionId}`,
  },
];


export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function providerTools(): { name: string; description: string; inputSchema: JsonSchema }[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
