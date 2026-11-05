import { pipelineStepKind, type PipelineSpec, type PipelineStep } from './spec';

/**
 * 起步模板：把「空白两步 + 全靠自己想」换成「选一个接近的场景再改两处」。
 *
 * 模板里的 `your_table` / `https://…` 这类占位值通过了必填校验（它们不是空的），
 * 所以必须由 `review` 显式告诉界面「哪几处还要确认」，否则用户会以为已经能跑。
 */

export interface PipelineTemplateReview {
  /** 步骤 id */
  step: string;
  /** 需要确认的配置项 */
  field: string;
  note: { zh: string; en: string };
}

export interface PipelineTemplate {
  id: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  review: PipelineTemplateReview[];
  spec: PipelineSpec;
}

function step(id: string, type: PipelineStep['type'], label: string, withValues: Record<string, unknown>): PipelineStep {
  return { id, type, label, with: withValues };
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: 'api-into-db',
    label: { zh: '接口数据入库', en: 'API into database' },
    description: {
      zh: '翻页拉取接口，按主键先删后插写进表，之后每次只取新增',
      en: 'Paginate an API, merge rows into a table by key, then pull only what is new',
    },
    review: [
      { step: 'pull', field: 'url', note: { zh: '接口地址', en: 'API URL' } },
      { step: 'pull', field: 'extract', note: { zh: '行数据在响应里的路径', en: 'Row path in the response' } },
      { step: 'pull', field: 'stateField', note: { zh: '增量字段（时间或自增 id）', en: 'Incremental field (time or id)' } },
      { step: 'land', field: 'table', note: { zh: '目标表名', en: 'Target table' } },
      { step: 'land', field: 'keyColumns', note: { zh: '去重主键列', en: 'Key columns' } },
    ],
    spec: {
      version: 1,
      steps: [
        step('pull', 'http.fetch', '拉接口', {
          url: 'https://your-api.example.com/records?page=1',
          method: 'GET',
          auth: 'none',
          extract: '$.data.items',
          paginate: 'page',
          pageParam: 'page',
          sizeParam: 'page_size',
          pageSize: 200,
          maxPages: 50,
          stateField: 'updated_at',
          stateParam: 'since',
        }),
        step('land', 'db.write', '写入表', {
          connectionId: '',
          table: 'your_table',
          mode: 'delete_insert',
          keyColumns: ['id'],
          createMissing: true,
          batchRows: 200,
        }),
      ],
    },
  },
  {
    id: 'db-to-db',
    label: { zh: '库到库增量搬运', en: 'Database to database (incremental)' },
    description: {
      zh: '按时间字段取上次之后的数据，先删后插同步到另一张表或另一个库',
      en: 'Read rows after the last bookmark and merge them into another table or database',
    },
    review: [
      { step: 'fetch', field: 'sql', note: { zh: '源表与增量字段', en: 'Source table and incremental column' } },
      { step: 'fetch', field: 'connectionId', note: { zh: '源连接（默认连接不对就换）', en: 'Source connection' } },
      { step: 'land', field: 'connectionId', note: { zh: '目标连接', en: 'Target connection' } },
      { step: 'land', field: 'table', note: { zh: '目标表名', en: 'Target table' } },
      { step: 'land', field: 'keyColumns', note: { zh: '去重主键列', en: 'Key columns' } },
    ],
    spec: {
      version: 1,
      steps: [
        step('fetch', 'db.query', '取增量', {
          connectionId: '',
          sql: "SELECT * FROM source_table WHERE updated_at > '{{ state.max }}' ORDER BY updated_at",
          maxRows: 20000,
          stateField: 'updated_at',
        }),
        step('land', 'db.write', '写入目标', {
          connectionId: '',
          table: 'target_table',
          mode: 'delete_insert',
          keyColumns: ['id'],
          createMissing: true,
          batchRows: 200,
        }),
      ],
    },
  },
  {
    id: 'daily-rollup',
    label: { zh: '每日汇总统计', en: 'Daily rollup' },
    description: {
      zh: '查明细 → 内置 DuckDB 聚合 → 写进统计表，报表直接读统计表',
      en: 'Query details, aggregate in embedded DuckDB, write a stats table for reports',
    },
    review: [
      { step: 'fetch', field: 'sql', note: { zh: '明细表与时间列', en: 'Detail table and date column' } },
      { step: 'calc', field: 'sql', note: { zh: '聚合口径（分组列与度量）', en: 'Aggregation (groups and measures)' } },
      { step: 'land', field: 'table', note: { zh: '统计表名', en: 'Stats table' } },
      { step: 'land', field: 'keyColumns', note: { zh: '统计表主键（重跑不重复）', en: 'Stats table key (reruns stay idempotent)' } },
    ],
    spec: {
      version: 1,
      steps: [
        step('fetch', 'db.query', '取明细', {
          connectionId: '',
          sql: "SELECT substr(created_at, 1, 10) AS dt, status, total_cents AS amount_cents FROM orders",
          maxRows: 50000,
        }),
        step('calc', 'sql', '汇总', {
          sql: 'SELECT dt, status, COUNT(*) AS orders, SUM(amount_cents) AS total_cents\nFROM input\nGROUP BY dt, status',
          maxRows: 20000,
        }),
        step('land', 'db.write', '写统计表', {
          connectionId: '',
          table: 'daily_rollup',
          mode: 'delete_insert',
          keyColumns: ['dt', 'status'],
          createMissing: true,
        }),
      ],
    },
  },
  {
    id: 'db-to-api',
    label: { zh: '查库推送接口', en: 'Query and push to API' },
    description: {
      zh: '把查询结果按批 POST 给下游接口（回推、通知、第三方系统）',
      en: 'POST query results downstream in batches (callback, notify, third-party sync)',
    },
    review: [
      { step: 'fetch', field: 'sql', note: { zh: '要推送的数据', en: 'Rows to push' } },
      { step: 'send', field: 'url', note: { zh: '下游接口地址', en: 'Downstream URL' } },
      { step: 'send', field: 'auth', note: { zh: '如需密钥，先建凭证再选', en: 'Create a credential if the API needs a key' } },
    ],
    spec: {
      version: 1,
      steps: [
        step('fetch', 'db.query', '取数', {
          connectionId: '',
          sql: 'SELECT id, status, total_cents FROM orders LIMIT 500',
          maxRows: 5000,
        }),
        step('send', 'http.push', '推送', {
          url: 'https://your-api.example.com/import',
          method: 'POST',
          auth: 'none',
          bodyMode: 'array',
          batchRows: 50,
          concurrency: 2,
          stopOnError: true,
        }),
      ],
    },
  },
  {
    id: 'api-clean-relay',
    label: { zh: '接口清洗后转发', en: 'Reshape and relay' },
    description: {
      zh: '接口取数 → 字段映射改名/过滤 → 转发给另一个接口，不入库',
      en: 'Fetch an API, rename and filter fields, relay to another API without landing in a database',
    },
    review: [
      { step: 'pull', field: 'url', note: { zh: '源接口地址', en: 'Source URL' } },
      { step: 'shape', field: 'project', note: { zh: '目标字段名与表达式', en: 'Target columns and expressions' } },
      { step: 'send', field: 'url', note: { zh: '转发地址', en: 'Relay URL' } },
    ],
    spec: {
      version: 1,
      steps: [
        step('pull', 'http.fetch', '拉接口', {
          url: 'https://your-api.example.com/orders',
          method: 'GET',
          auth: 'none',
          extract: '$.data.items',
          paginate: 'none',
        }),
        step('shape', 'map', '改名与过滤', {
          filter: "@.amount > 0 && @.status == 'paid'",
          project: { order_id: '@.id', amount: '@.amount', customer: '@.customer_name' },
        }),
        step('send', 'http.push', '转发', {
          url: 'https://downstream.example.com/hook',
          method: 'POST',
          auth: 'none',
          bodyMode: 'array',
          batchRows: 50,
        }),
      ],
    },
  },
];

const TEMPLATES_BY_ID = new Map(PIPELINE_TEMPLATES.map((template) => [template.id, template]));

export function pipelineTemplate(id: string): PipelineTemplate | undefined {
  return TEMPLATES_BY_ID.get(id);
}

/**
 * 套模板时把默认连接/库填进还没指定的步骤；占位值（your_table 等）保留，
 * 由 `review` 清单提醒用户改掉。只填该步骤类型真实存在的配置项——
 * HTTP 步骤没有 connectionId，硬塞进去会被契约当成未知字段而保存失败。
 */
export function applyPipelineTemplate(
  template: PipelineTemplate,
  defaults: { connectionId?: string; database?: string },
): PipelineSpec {
  const spec = structuredClone(template.spec);
  spec.steps = spec.steps.map((item) => {
    const values = { ...item.with };
    const fields = new Set((pipelineStepKind(item.type)?.fields ?? []).map((field) => field.key));
    if (defaults.connectionId && fields.has('connectionId') && !String(values.connectionId ?? '')) values.connectionId = defaults.connectionId;
    if (defaults.database && fields.has('database') && !String(values.database ?? '')) values.database = defaults.database;
    return { ...item, with: values };
  });
  return spec;
}
