import { checkExpression, describeExpressionFunctions } from './expr';
import { checkJsonPath } from './jsonpath';
import type { Risk } from '../types';

/**
 * 数据流（pipeline）的步骤目录与契约。
 *
 * 目录是单一事实源：gateway 用它校验与执行、UI 用它渲染字段表单、
 * 能力契约与 Agent 提示用它描述「这条流水线能做什么」。加一类步骤只改这里，
 * 三端跟着长出来。
 */

export type PipelineStepType =
  | 'http.fetch'
  | 'db.query'
  | 'map'
  | 'sql'
  | 'script.js'
  | 'script.py'
  | 'db.write'
  | 'http.push';

export type PipelineStepRole = 'source' | 'transform' | 'sink';

export type PipelineFieldKind =
  | 'text'
  | 'code'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'keymap'
  | 'columns'
  | 'expression'
  | 'jsonpath'
  | 'connection'
  | 'database'
  | 'table'
  | 'credential';

export interface PipelineField {
  key: string;
  type: PipelineFieldKind;
  label: { zh: string; en: string };
  hint?: { zh: string; en: string };
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  options?: { value: string; label: { zh: string; en: string }; risk?: Risk }[];
  /** `code` 字段的语言，用于界面高亮与校验。 */
  language?: 'sql' | 'json' | 'javascript' | 'python';
  /** 仅当同一步骤的某字段等于指定值时才出现（也才要求必填）。 */
  showWhen?: { field: string; equals: string | string[] };
}

export interface PipelineStepKind {
  type: PipelineStepType;
  role: PipelineStepRole;
  /** 界面上的短标签，例如 HTTP → DB。 */
  badge: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  risk: Risk;
  /** 该步骤是否消费上一步的行集。 */
  needsInput: boolean;
  fields: PipelineField[];
}

export interface PipelineParam {
  key: string;
  label?: { zh: string; en: string };
  type?: 'text' | 'number' | 'boolean';
  default?: string | number | boolean;
}

export interface PipelineStep {
  id: string;
  type: PipelineStepType;
  label?: string;
  with: Record<string, unknown>;
}

export interface PipelineSpec {
  version: 1;
  params?: PipelineParam[];
  steps: PipelineStep[];
}

const AUTH_OPTIONS = [
  { value: 'none', label: { zh: '无', en: 'None' } },
  { value: 'bearer', label: { zh: 'Bearer 令牌', en: 'Bearer' } },
  { value: 'basic', label: { zh: 'Basic 用户密码', en: 'Basic' } },
  { value: 'apikey', label: { zh: 'API Key', en: 'API key' } },
];

function authFields(): PipelineField[] {
  return [
    {
      key: 'auth',
      type: 'enum',
      label: { zh: '认证', en: 'Auth' },
      default: 'none',
      options: AUTH_OPTIONS,
    },
    {
      key: 'credential',
      type: 'credential',
      label: { zh: '凭证', en: 'Credential' },
      hint: { zh: '密钥存在 Gateway 本地加密库里，流水线定义里只记 id', en: 'Secrets stay in the gateway vault; the spec stores only an id' },
      showWhen: { field: 'auth', equals: ['bearer', 'basic', 'apikey'] },
    },
    {
      key: 'authField',
      type: 'text',
      label: { zh: 'API Key 头名', en: 'API key header' },
      default: 'Authorization',
      showWhen: { field: 'auth', equals: 'apikey' },
    },
  ];
}

export const PIPELINE_STEP_KINDS: PipelineStepKind[] = [
  {
    type: 'http.fetch',
    role: 'source',
    badge: 'HTTP',
    label: { zh: 'HTTP 接口取数', en: 'Fetch from HTTP API' },
    description: { zh: '调用外部接口，用 JSONPath 从响应里取出行集，支持翻页与增量断点', en: 'Call an external API, select rows with JSONPath, with paging and an incremental bookmark' },
    risk: 'read',
    needsInput: false,
    fields: [
      { key: 'url', type: 'text', label: { zh: '请求地址', en: 'URL' }, required: true, placeholder: 'https://api.example.com/orders?status=paid' },
      {
        key: 'method',
        type: 'enum',
        label: { zh: '方法', en: 'Method' },
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH'].map((value) => ({ value, label: { zh: value, en: value } })),
      },
      { key: 'headers', type: 'keymap', label: { zh: '请求头', en: 'Headers' }, hint: { zh: '值里可用 {{ params.x }}；密钥请选凭证', en: 'Values may use {{ params.x }}; put secrets in a credential' } },
      {
        key: 'body',
        type: 'code',
        language: 'json',
        label: { zh: '请求体', en: 'Body' },
        showWhen: { field: 'method', equals: ['POST', 'PUT', 'PATCH'] },
      },
      ...authFields(),
      { key: 'extract', type: 'jsonpath', label: { zh: '数据路径', en: 'Extract path' }, default: '$', placeholder: '$.data.items' },
      {
        key: 'paginate',
        type: 'enum',
        label: { zh: '翻页', en: 'Pagination' },
        default: 'none',
        options: [
          { value: 'none', label: { zh: '不翻页', en: 'None' } },
          { value: 'page', label: { zh: '页码递增', en: 'By page number' } },
          { value: 'cursor', label: { zh: '游标续传', en: 'By cursor' } },
        ],
      },
      { key: 'pageParam', type: 'text', label: { zh: '页码参数', en: 'Page param' }, default: 'page', showWhen: { field: 'paginate', equals: 'page' } },
      { key: 'sizeParam', type: 'text', label: { zh: '页大小参数', en: 'Page size param' }, default: 'page_size', showWhen: { field: 'paginate', equals: 'page' } },
      { key: 'pageSize', type: 'number', label: { zh: '每页行数', en: 'Page size' }, default: 200, min: 1, max: 5000, showWhen: { field: 'paginate', equals: 'page' } },
      { key: 'cursorParam', type: 'text', label: { zh: '游标参数', en: 'Cursor param' }, default: 'cursor', showWhen: { field: 'paginate', equals: 'cursor' } },
      { key: 'cursorPath', type: 'jsonpath', label: { zh: '游标路径', en: 'Cursor path' }, default: '$.next_cursor', showWhen: { field: 'paginate', equals: 'cursor' } },
      { key: 'maxPages', type: 'number', label: { zh: '最多翻页', en: 'Max pages' }, default: 20, min: 1, max: 200, showWhen: { field: 'paginate', equals: ['page', 'cursor'] } },
      { key: 'stateField', type: 'text', label: { zh: '增量字段', en: 'Incremental field' }, placeholder: 'created_at', hint: { zh: '取该字段最大值存为断点 state.max', en: 'Store the max value as state.max' } },
      { key: 'stateParam', type: 'text', label: { zh: '断点参数', en: 'Bookmark param' }, placeholder: 'since', hint: { zh: '下次请求把 state.max 作为该查询参数发送', en: 'Send state.max as this query param next time' } },
      { key: 'timeoutMs', type: 'number', label: { zh: '超时（毫秒）', en: 'Timeout (ms)' }, default: 15000, min: 1000, max: 120000 },
      { key: 'maxRows', type: 'number', label: { zh: '最多取回行数', en: 'Max rows' }, default: 20000, min: 1, max: 200000 },
    ],
  },
  {
    type: 'db.query',
    role: 'source',
    badge: 'SQL',
    label: { zh: '数据库查询取数', en: 'Query a database' },
    description: { zh: '在已连接的库上执行 SQL，结果集转成行集', en: 'Run SQL on a connected database and turn the result set into rows' },
    risk: 'read',
    needsInput: false,
    fields: [
      { key: 'connectionId', type: 'connection', label: { zh: '连接', en: 'Connection' }, required: true },
      { key: 'database', type: 'database', label: { zh: '数据库', en: 'Database' } },
      {
        key: 'sql',
        type: 'code',
        language: 'sql',
        label: { zh: 'SQL', en: 'SQL' },
        required: true,
        placeholder: "SELECT id, amount FROM orders WHERE updated_at >= '{{ state.max }}'",
        hint: { zh: '可用 {{ params.x }}、{{ state.max }}、{{ run.batchAt }}', en: 'Supports {{ params.x }}, {{ state.max }}, {{ run.batchAt }}' },
      },
      { key: 'maxRows', type: 'number', label: { zh: '最多取回行数', en: 'Max rows' }, default: 5000, min: 1, max: 200000 },
      {
        key: 'stateField',
        type: 'text',
        label: { zh: '增量字段', en: 'Incremental field' },
        placeholder: 'updated_at',
        hint: { zh: '取结果里该字段的最大值存为断点 state.max，下次 SQL 里用 {{ state.max }}', en: 'Store the max value as state.max for the next run' },
      },
    ],
  },
  {
    type: 'map',
    role: 'transform',
    badge: 'MAP',
    label: { zh: '字段映射与清洗', en: 'Map & clean fields' },
    description: { zh: 'JSONPath 选取、展开嵌套数组、表达式过滤与投影、去重排序', en: 'JSONPath select, explode nested arrays, expression filter and projection, distinct and sort' },
    risk: 'read',
    needsInput: true,
    fields: [
      { key: 'select', type: 'jsonpath', label: { zh: '重新选取', en: 'Select' }, placeholder: '$.data.items', hint: { zh: '留空即取上一步行集', en: 'Empty means the previous step rows' } },
      { key: 'explode', type: 'jsonpath', label: { zh: '展开嵌套', en: 'Explode' }, placeholder: '$.items' },
      { key: 'filter', type: 'expression', label: { zh: '过滤条件', en: 'Filter' }, placeholder: "@.amount > 0 && @.status in ('paid','new')", hint: { zh: '表达式语言，@ 指向当前行', en: 'Expression language; @ is the current row' } },
      { key: 'project', type: 'keymap', label: { zh: '字段投影', en: 'Projection' }, placeholder: 'total = @.price * @.qty', hint: { zh: '左列名，右表达式', en: 'Column name = expression' } },
      { key: 'keepUnmapped', type: 'boolean', label: { zh: '保留未映射字段', en: 'Keep unmapped fields' }, default: false },
      { key: 'distinct', type: 'boolean', label: { zh: '去重', en: 'Distinct' }, default: false },
      { key: 'sortBy', type: 'expression', label: { zh: '排序键', en: 'Sort by' }, placeholder: '@.created_at' },
      {
        key: 'sortDir',
        type: 'enum',
        label: { zh: '排序方向', en: 'Sort direction' },
        default: 'asc',
        options: [
          { value: 'asc', label: { zh: '升序', en: 'Asc' } },
          { value: 'desc', label: { zh: '降序', en: 'Desc' } },
        ],
        showWhen: { field: 'sortBy', equals: '__any' },
      },
      { key: 'limit', type: 'number', label: { zh: '最多行数', en: 'Limit' }, min: 1, max: 200000 },
    ],
  },
  {
    type: 'sql',
    role: 'transform',
    badge: 'DUCK',
    label: { zh: 'SQL 计算（内置 DuckDB）', en: 'SQL transform (embedded DuckDB)' },
    description: { zh: '把上一步行集注册成表 input，直接跑 SQL 做聚合、join、窗口', en: 'Register the previous rows as table `input` and run SQL for aggregates, joins, windows' },
    risk: 'read',
    needsInput: true,
    fields: [
      {
        key: 'sql',
        type: 'code',
        language: 'sql',
        label: { zh: 'SQL', en: 'SQL' },
        required: true,
        placeholder: 'SELECT customer_id, SUM(amount) AS total, COUNT(*) AS n\nFROM input\nGROUP BY 1\nHAVING SUM(amount) > 100',
        hint: { zh: '表名固定为 input（DuckDB 方言）', en: 'Table name is `input` (DuckDB dialect)' },
      },
      { key: 'maxRows', type: 'number', label: { zh: '最多输出行数', en: 'Max rows' }, default: 20000, min: 1, max: 200000 },
    ],
  },
  {
    type: 'script.js',
    role: 'transform',
    badge: 'JS',
    label: { zh: 'JavaScript 脚本', en: 'JavaScript script' },
    description: { zh: '子进程里跑 transform(rows, ctx)，只做数据进出，没有文件与网络', en: 'Run transform(rows, ctx) in a child process; data in, data out, no fs or network' },
    risk: 'read',
    needsInput: true,
    fields: [
      {
        key: 'code',
        type: 'code',
        language: 'javascript',
        label: { zh: '脚本', en: 'Script' },
        required: true,
        placeholder: 'function transform(rows, ctx) {\n  return rows.map((row) => ({ ...row, batch: ctx.run.batchAt }));\n}',
      },
      { key: 'timeoutMs', type: 'number', label: { zh: '超时（毫秒）', en: 'Timeout (ms)' }, default: 30000, min: 1000, max: 120000 },
      { key: 'maxRows', type: 'number', label: { zh: '最多输出行数', en: 'Max rows' }, default: 50000, min: 1, max: 200000 },
    ],
  },
  {
    type: 'script.py',
    role: 'transform',
    badge: 'PY',
    label: { zh: 'Python 脚本', en: 'Python script' },
    description: { zh: '子进程里跑 transform(rows, ctx)，需要本机可用 python3', en: 'Run transform(rows, ctx) in a child process; requires a local python3' },
    risk: 'read',
    needsInput: true,
    fields: [
      {
        key: 'code',
        type: 'code',
        language: 'python',
        label: { zh: '脚本', en: 'Script' },
        required: true,
        placeholder: 'def transform(rows, ctx):\n    return [{**row, "batch": ctx["run"]["batchAt"]} for row in rows]',
      },
      { key: 'timeoutMs', type: 'number', label: { zh: '超时（毫秒）', en: 'Timeout (ms)' }, default: 30000, min: 1000, max: 120000 },
      { key: 'maxRows', type: 'number', label: { zh: '最多输出行数', en: 'Max rows' }, default: 50000, min: 1, max: 200000 },
    ],
  },
  {
    type: 'db.write',
    role: 'sink',
    badge: 'INSERT',
    label: { zh: '写入数据库', en: 'Write to database' },
    description: { zh: '追加、清空重写或按主键先删后插；目标表可自动创建', en: 'Append, replace, or delete-then-insert on declared keys; target table can be auto-created' },
    risk: 'write',
    needsInput: true,
    fields: [
      { key: 'connectionId', type: 'connection', label: { zh: '连接', en: 'Connection' }, required: true },
      { key: 'database', type: 'database', label: { zh: '数据库', en: 'Database' } },
      { key: 'table', type: 'table', label: { zh: '目标表', en: 'Target table' }, required: true },
      {
        key: 'mode',
        type: 'enum',
        label: { zh: '写入方式', en: 'Write mode' },
        default: 'append',
        options: [
          { value: 'append', label: { zh: '追加', en: 'Append' } },
          { value: 'replace', label: { zh: '清空后重写', en: 'Replace' }, risk: 'write' },
          { value: 'delete_insert', label: { zh: '按主键先删后插', en: 'Delete + insert' } },
        ],
      },
      { key: 'keyColumns', type: 'columns', label: { zh: '主键列', en: 'Key columns' }, required: true, showWhen: { field: 'mode', equals: 'delete_insert' } },
      { key: 'columns', type: 'keymap', label: { zh: '列映射', en: 'Column mapping' }, hint: { zh: '左目标列，右源字段名；留空按同名写入', en: 'Target column = source field; empty means same name' } },
      { key: 'types', type: 'keymap', label: { zh: '建表类型', en: 'Column types' }, hint: { zh: '仅自动建表时用，留空按值推断', en: 'Used only when auto-creating the table' } },
      { key: 'createMissing', type: 'boolean', label: { zh: '缺表自动创建', en: 'Create missing table' }, default: true },
      { key: 'batchRows', type: 'number', label: { zh: '每批行数', en: 'Batch rows' }, default: 200, min: 1, max: 1000 },
      { key: 'dryRun', type: 'boolean', label: { zh: '只预览不写入', en: 'Preview only' }, default: false },
    ],
  },
  {
    type: 'http.push',
    role: 'sink',
    badge: 'PUSH',
    label: { zh: '推送到接口', en: 'Push to HTTP API' },
    description: { zh: '按批把行集 POST 到下游接口，可自定义请求体模板', en: 'POST rows downstream in batches, with an optional body template' },
    risk: 'write',
    needsInput: true,
    fields: [
      { key: 'url', type: 'text', label: { zh: '请求地址', en: 'URL' }, required: true, placeholder: 'https://hook.example.com/sync' },
      {
        key: 'method',
        type: 'enum',
        label: { zh: '方法', en: 'Method' },
        default: 'POST',
        options: ['POST', 'PATCH', 'PUT'].map((value) => ({ value, label: { zh: value, en: value } })),
      },
      { key: 'headers', type: 'keymap', label: { zh: '请求头', en: 'Headers' } },
      ...authFields(),
      {
        key: 'bodyMode',
        type: 'enum',
        label: { zh: '请求体', en: 'Body' },
        default: 'array',
        options: [
          { value: 'array', label: { zh: '整批数组', en: 'Row array' } },
          { value: 'template', label: { zh: '自定义模板', en: 'Template' } },
        ],
      },
      {
        key: 'body',
        type: 'code',
        language: 'json',
        label: { zh: '模板', en: 'Template' },
        required: true,
        placeholder: '{ "records": {{ rows }} }',
        showWhen: { field: 'bodyMode', equals: 'template' },
      },
      { key: 'batchRows', type: 'number', label: { zh: '每批行数', en: 'Batch rows' }, default: 50, min: 1, max: 2000 },
      { key: 'concurrency', type: 'number', label: { zh: '并发请求', en: 'Concurrency' }, default: 2, min: 1, max: 8 },
      { key: 'timeoutMs', type: 'number', label: { zh: '超时（毫秒）', en: 'Timeout (ms)' }, default: 15000, min: 1000, max: 120000 },
      { key: 'stopOnError', type: 'boolean', label: { zh: '失败即中断', en: 'Stop on error' }, default: true },
      { key: 'dryRun', type: 'boolean', label: { zh: '只预览不发送', en: 'Preview only' }, default: false },
    ],
  },
];

const BY_TYPE = new Map<PipelineStepType, PipelineStepKind>(PIPELINE_STEP_KINDS.map((kind) => [kind.type, kind]));

export function pipelineStepKind(type: string): PipelineStepKind | undefined {
  return BY_TYPE.get(type as PipelineStepType);
}

export function pipelineStepTypes(): PipelineStepType[] {
  return PIPELINE_STEP_KINDS.map((kind) => kind.type);
}

export function isPipelineStepType(type: unknown): type is PipelineStepType {
  return typeof type === 'string' && BY_TYPE.has(type as PipelineStepType);
}

export interface PipelineIssue {
  /** 出错步骤的 id；整体性问题时省略。 */
  step?: string;
  field?: string;
  message: string;
}

function visible(field: PipelineField, values: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  const actual = String(values[field.showWhen.field] ?? field.default ?? '');
  if (field.showWhen.equals === '__any') return String(values[field.showWhen.field] ?? '').trim().length > 0;
  const expected = Array.isArray(field.showWhen.equals) ? field.showWhen.equals : [field.showWhen.equals];
  return expected.includes(actual);
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function checkTemplated(text: string, kind: 'expression' | 'jsonpath'): string | null {
  // 带 {{ }} 的表达式要在运行期先做绑定再求值，契约层只能校验占位符内部。
  if (text.includes('{{')) {
    for (const match of text.matchAll(/\{\{([\s\S]+?)\}\}/g)) {
      const inner = (match[1] ?? '').trim();
      if (kind === 'expression') {
        const problem = checkExpression(inner);
        if (problem) return problem;
      } else {
        const problem = checkJsonPath(inner);
        if (problem) return problem;
      }
    }
    return null;
  }
  return kind === 'expression' ? checkExpression(text) : checkJsonPath(text);
}

function checkValue(field: PipelineField, raw: unknown): string | null {
  if (field.type === 'number') {
    const value = Number(raw);
    if (Number.isNaN(value)) return `${field.label.zh} 必须是数字`;
    if (field.min !== undefined && value < field.min) return `${field.label.zh} 不能小于 ${field.min}`;
    if (field.max !== undefined && value > field.max) return `${field.label.zh} 不能大于 ${field.max}`;
    return null;
  }
  if (field.type === 'enum') {
    const allowed = (field.options ?? []).map((option) => option.value);
    if (!allowed.includes(String(raw))) return `${field.label.zh} 只能取 ${allowed.join(' / ')}`;
    return null;
  }
  if (field.type === 'expression' || field.type === 'jsonpath') {
    const text = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
    if (!text || (field.type === 'jsonpath' && text === '$')) return null;
    return checkTemplated(text, field.type);
  }
  if (field.type === 'code') {
    if (field.language === 'json' && typeof raw === 'string' && raw.trim()) {
      try {
        JSON.parse(withoutBindings(raw));
      } catch {
        return `${field.label.zh} 不是合法 JSON`;
      }
    }
    return null;
  }
  return null;
}

/** 请求体模板里允许写 `{"records": {{ rows }}}`：校验 JSON 前先把占位符换成字符串值。 */
function withoutBindings(value: string): string {
  return value.replace(/"[^{}]*\{\{[\s\S]*?\}\}[^{}]*"|\{\{[\s\S]*?\}\}/g, '"__binding__"');
}

export interface ValidatePipelineOptions {
  /** 已声明的参数名；绑定了未声明的 params.x 时报错。 */
  strictParams?: boolean;
}

/** 结构 + 字段级校验；返回问题清单而不是抛异常，好让界面逐条标注。 */
export function validatePipelineSpec(input: unknown, options: ValidatePipelineOptions = {}): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const spec = input as PipelineSpec;
  if (!spec || typeof spec !== 'object') return [{ message: '流水线定义必须是对象' }];
  if (spec.version !== 1) issues.push({ message: `暂不支持的流水线版本：${String(spec.version ?? '未填写')}（当前为 1）` });
  if (!Array.isArray(spec.steps) || !spec.steps.length) {
    issues.push({ field: 'steps', message: '至少需要一个步骤' });
    return issues;
  }
  const declaredParams = new Set((spec.params ?? []).map((param) => String(param?.key ?? '').trim()).filter(Boolean));
  const seen = new Set<string>();
  let hasSource = false;

  spec.steps.forEach((step, index) => {
    const at = step && step.id ? `步骤 ${step.id}` : `第 ${index + 1} 步`;
    if (!step || typeof step !== 'object') {
      issues.push({ message: `${at} 不是对象` });
      return;
    }
    if (!step.id || !/^[A-Za-z0-9_-]{1,40}$/.test(step.id)) {
      issues.push({ step: step.id, message: `${at}：id 只能用小写字母、数字、下划线或短横线，长度不超过 40` });
    } else if (seen.has(step.id)) {
      issues.push({ step: step.id, message: `步骤 id 重复：${step.id}` });
    }
    seen.add(String(step.id));

    const kind = pipelineStepKind(String(step.type));
    if (!kind) {
      issues.push({ step: step.id, message: `${at}：未知步骤类型 ${String(step.type)}` });
      return;
    }
    if (kind.role === 'source') hasSource = true;
    if (index === 0 && kind.role !== 'source') {
      issues.push({ step: step.id, message: `${at}：第一步必须取数（HTTP 接口取数或数据库查询取数）` });
    }
    const values = (step.with && typeof step.with === 'object' ? step.with : {}) as Record<string, unknown>;
    if (!step.with || typeof step.with !== 'object') {
      issues.push({ step: step.id, message: `${at}：缺少 with 配置` });
    }
    const known = new Set(kind.fields.map((field) => field.key));
    for (const key of Object.keys(values)) {
      if (!known.has(key)) issues.push({ step: step.id, field: key, message: `${at}：不认识的配置项 ${key}` });
    }
    for (const field of kind.fields) {
      if (!visible(field, values)) continue;
      const raw = values[field.key];
      if (field.required && isBlank(raw)) {
        issues.push({ step: step.id, field: field.key, message: `${at}：${field.label.zh}必填` });
        continue;
      }
      if (isBlank(raw)) continue;
      const problem = checkValue(field, raw);
      if (problem) issues.push({ step: step.id, field: field.key, message: `${at}：${problem}` });
    }

    if (kind.type === 'db.write') {
      // 先删后插的键必须在真正写入的列里，否则运行到一半才报「主键列不在目标表里」。
      // 只有列映射非空时目标列集合才是确定的（留空时按源列名走，运行期才知道）。
      const mapping = values.columns as Record<string, unknown> | undefined;
      const writeMode = String(values.mode ?? 'append');
      const keyList = Array.isArray(values.keyColumns)
        ? values.keyColumns.map((item) => String(item)).filter(Boolean)
        : typeof values.keyColumns === 'string'
          ? String(values.keyColumns).split(',').map((item) => item.trim()).filter(Boolean)
          : [];
      if (writeMode === 'delete_insert' && mapping && Object.keys(mapping).length) {
        const targets = new Set(Object.keys(mapping).map((name) => name.toLowerCase()));
        for (const key of keyList) {
          if (!targets.has(key.toLowerCase())) {
            issues.push({
              step: step.id,
              field: 'keyColumns',
              message: `${at}：主键列 ${key} 不在要写入的列里（可写：${Object.keys(mapping).join('、')}）`,
            });
          }
        }
      }
    }
    if (kind.type === 'map') {
      const project = values.project as Record<string, string> | undefined;
      if (project && typeof project === 'object') {
        for (const [column, expression] of Object.entries(project)) {
          if (!column.trim()) issues.push({ step: step.id, field: 'project', message: `${at}：投影列名不能为空` });
          if (typeof expression !== 'string' || !expression.trim()) {
            issues.push({ step: step.id, field: 'project', message: `${at}：投影 ${column} 缺少表达式` });
            continue;
          }
          const problem = checkTemplated(expression, 'expression');
          if (problem) issues.push({ step: step.id, field: 'project', message: `${at}：投影 ${column} ${problem}` });
        }
      }
    }
    if (options.strictParams) {
      for (const expression of collectBindingExpressions(values)) {
        const match = /^params\.([A-Za-z0-9_]+)$/.exec(expression);
        if (match && !declaredParams.has(match[1])) {
          issues.push({ step: step.id, message: `${at}：绑定了未声明的参数 {{ params.${match[1]} }}` });
        }
      }
    }
  });

  if (!hasSource) issues.push({ message: '流水线至少要有一步取数' });
  return issues;
}

function collectBindingExpressions(values: unknown, out: string[] = []): string[] {
  if (typeof values === 'string') {
    for (const match of values.matchAll(/\{\{([\s\S]+?)\}\}/g)) out.push(match[1].trim());
    return out;
  }
  if (Array.isArray(values)) {
    for (const item of values) collectBindingExpressions(item, out);
    return out;
  }
  if (values && typeof values === 'object') {
    for (const item of Object.values(values as Record<string, unknown>)) collectBindingExpressions(item, out);
  }
  return out;
}

/** 界面「添加步骤」用的默认配置。 */
export function defaultPipelineStep(type: PipelineStepType, id: string): PipelineStep {
  const kind = pipelineStepKind(type);
  const values: Record<string, unknown> = {};
  for (const field of kind?.fields ?? []) {
    if (field.default === undefined) continue;
    values[field.key] = field.default;
  }
  if (kind?.type === 'db.query') values.sql = 'SELECT 1 AS ok';
  if (kind?.type === 'sql') values.sql = 'SELECT * FROM input LIMIT 100';
  if (kind?.type === 'script.js') values.code = 'function transform(rows, ctx) {\n  return rows;\n}';
  if (kind?.type === 'script.py') values.code = 'def transform(rows, ctx):\n    return rows';
  return { id, type, label: kind ? kind.label.zh : type, with: values };
}

export function newPipelineSpec(): PipelineSpec {
  return {
    version: 1,
    params: [],
    steps: [defaultPipelineStep('db.query', 'fetch'), defaultPipelineStep('db.write', 'output')],
  };
}

/** 供能力契约与 Agent 提示复用的一段说明书。 */
export function describePipelineLanguage(locale: 'zh' | 'en' = 'zh'): string {
  const steps = PIPELINE_STEP_KINDS.map((kind) => {
    const fields = kind.fields.map((field) => `${field.key}${field.required ? '*' : ''}:${field.type}`).join(', ');
    return `${kind.type}(${kind.role}) {${fields}}`;
  }).join(' | ');
  const helper = describeExpressionFunctions(locale);
  return locale === 'zh'
    ? `流水线 spec = {version:1, params:[{key,default}], steps:[{id,type,with}]}。步骤：${steps}。表达式（过滤/投影/绑定通用，@ 指当前行）：${helper}`
    : `Pipeline spec = {version:1, params:[{key,default}], steps:[{id,type,with}]}. Steps: ${steps}. Expressions (@ is the current row): ${helper}`;
}

export interface PipelineRowOutput {
  rows: Record<string, unknown>[];
  columns: string[];
  count: number;
}

export interface PipelineStepResult extends PipelineRowOutput {
  /** sink 步骤渲染出的 SQL/body，试运行与运行历史都要展示。 */
  preview?: string;
  /** 步骤自己产生的运行元数据（HTTP 状态、批次数、翻页数等）。 */
  meta?: Record<string, unknown>;
  /** 回写到流水线 state 的增量断点。 */
  state?: Record<string, unknown>;
  skipped?: boolean;
}

export interface PipelineStepRun {
  id: string;
  type: PipelineStepType;
  label: string;
  role: PipelineStepRole;
  status: 'pending' | 'running' | 'ok' | 'error' | 'skipped';
  durationMs?: number;
  inRows?: number;
  outRows?: number;
  columns?: string[];
  sample?: Record<string, unknown>[];
  preview?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface PipelineRunInfo {
  id: string;
  pipelineId: string;
  pipelineName?: string;
  trigger: 'manual' | 'scheduled' | 'trial';
  status: 'running' | 'ok' | 'error';
  /** 批次时刻：定时任务取调度时间，手动取当前时间，用于幂等的增量窗口。 */
  batchAt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  rowsIn?: number;
  rowsOut?: number;
  message?: string;
  error?: string;
  steps: PipelineStepRun[];
}

export interface PipelineInfo {
  id: string;
  name: string;
  description?: string;
  connectionId?: string;
  database?: string;
  spec: PipelineSpec;
  /** 上一次成功运行留下的增量断点，例如 {max: '2026-11-04 10:00:00'}。 */
  state: Record<string, unknown>;
  enabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error' | 'running';
  lastError?: string;
}

export interface PipelineCredentialInfo {
  id: string;
  name: string;
  kind: 'bearer' | 'basic' | 'apikey' | 'header';
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export type PipelineEvent =
  | { type: 'run-start'; runId: string; pipelineId: string; batchAt: string; steps: { id: string; label: string; type: PipelineStepType }[] }
  | { type: 'step-start'; stepId: string; index: number; total: number; label: string }
  | { type: 'step-done'; stepId: string; index: number; total: number; run: PipelineStepRun }
  | { type: 'step-error'; stepId: string; index: number; total: number; run: PipelineStepRun }
  | { type: 'done'; run: PipelineRunInfo; durationMs: number }
  | { type: 'error'; code: string; message: string };
