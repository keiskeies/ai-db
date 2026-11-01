import type { Risk } from '../types';
import type { Capability, CapabilityField, CapabilityFieldType } from './types';

/**
 * 契约自检 + 入参校验。
 *
 * `assertCapabilities()` 在启动时跑一次，任何一条不合格就抛错——与
 * `assertCommandDefinitions()` 同风格。其中「tools 必须存在于 TOOLS」与
 * 「tools 的风险不得高于 maxRisk」是防漂移的关键：契约写了 transfer_data，
 * 哪天这个工具被删或改风险，启动即失败。
 */

const RISK_RANK: Record<Risk, number> = { read: 0, write: 1, ddl: 2, destructive: 3 };

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

const FIELD_TYPES: CapabilityFieldType[] = [
  'connection',
  'database',
  'table',
  'tables',
  'text',
  'code',
  'number',
  'boolean',
  'enum',
  'json',
];

/**
 * phrase 里允许出现、但不来自 fields 的占位符。
 *
 * 状态话术描述的是**执行结果**，所以除了表单字段，还需要一组约定的结果 token：
 * 进度（current/total/label）、错误（error）、结果摘要（message）、
 * 以及各功能自己的计数（tables/rows/count/...）。这些值由执行器在返回
 * `ToolResult` 时提供，契约层只负责声明它会被用到。
 */
const PHRASE_RESULT_TOKENS = new Set([
  // 进度
  'current',
  'total',
  'label',
  // 错误与摘要
  'error',
  'message',
  // 各功能结果计数
  'tables',
  'rows',
  'count',
  'sections',
  'sessions',
  'matches',
  'nextRunAt',
]);

export function riskRank(risk: Risk): number {
  return RISK_RANK[risk];
}

/**
 * 把契约里声明的默认值填进一份取值对象（不修改入参）。
 *
 * **渲染器与服务端必须用同一套「有效取值」判断 `showWhen`**，否则会出现
 * 「必填字段不显示、但提交报错」的错位：
 * - 服务端 `validateCapabilityInput` 会先补默认值再判断可见性；
 * - UI 渲染器若只看原始输入，`showWhen` 依赖默认值时会判成隐藏。
 *
 * 调用方在初始化表单状态时应当使用本函数，而不是各自手写一遍默认值循环。
 */
export function applyCapabilityDefaults(capability: Capability, values: Record<string, unknown> = {}): Record<string, unknown> {
  const next: Record<string, unknown> = { ...values };
  for (const field of capability.fields) {
    if (next[field.key] === undefined && field.default !== undefined) next[field.key] = field.default;
  }
  return next;
}

function fail(message: string): never {
  throw new Error(`能力契约校验失败：${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 默认值必须与字段类型相容。 */
function defaultMatchesType(field: CapabilityField): boolean {
  if (field.default === undefined) return true;
  const value = field.default;
  switch (field.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && (field.options ?? []).some((option) => option.value === value);
    case 'tables':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'json':
      return isPlainObject(value);
    default:
      return typeof value === 'string';
  }
}

function phrasePlaceholders(phrase: string): string[] {
  return [...phrase.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]);
}

/** 字段在当前表单取值下是否可见（`showWhen` 未满足时既不渲染也不校验）。 */
export function fieldVisible(field: CapabilityField, values: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  return values[field.showWhen.field] === field.showWhen.equals;
}

/**
 * 静态校验：结构、唯一性、与工具注册表的一致性。
 *
 * `tools` 必须显式传入（不在这里 import `TOOLS`）：契约模块要保持对 agent 工具表
 * 的零运行时依赖，才能被 `scripts/verify-docs.mjs` 用纯 Node 直接加载校验。
 */
export function assertCapabilities(
  capabilities: Capability[],
  tools: Array<{ name: string; risk: string }>,
): void {
  const toolRisk = new Map(tools.map((tool) => [tool.name, tool.risk]));
  const ids = new Set<string>();
  const routes = new Set<string>();

  for (const capability of capabilities) {
    if (!KEBAB.test(capability.id)) fail(`id 必须是 kebab-case：${capability.id}`);
    if (ids.has(capability.id)) fail(`id 重复：${capability.id}`);
    ids.add(capability.id);

    if (!capability.title?.zh?.trim() || !capability.title?.en?.trim()) fail(`${capability.id} 缺少 title.zh / title.en`);
    if (!capability.description?.trim()) fail(`${capability.id} 缺少 description`);
    if (!capability.whenToUse?.trim()) fail(`${capability.id} 缺少 whenToUse`);
    if (!Array.isArray(capability.flow) || !capability.flow.length) fail(`${capability.id} 缺少 flow`);
    if (!(capability.maxRisk in RISK_RANK)) fail(`${capability.id} 的 maxRisk 非法：${capability.maxRisk}`);

    // 字段
    if (!Array.isArray(capability.fields) || !capability.fields.length) fail(`${capability.id} 没有字段`);
    const keys = new Set<string>();
    for (const field of capability.fields) {
      if (!CAMEL.test(field.key)) fail(`${capability.id} 的字段 key 必须是 camelCase：${field.key}`);
      if (keys.has(field.key)) fail(`${capability.id} 的字段 key 重复：${field.key}`);
      keys.add(field.key);
      if (!FIELD_TYPES.includes(field.type)) fail(`${capability.id}.${field.key} 的 type 非法：${field.type}`);
      if (!field.label?.zh?.trim() || !field.label?.en?.trim()) fail(`${capability.id}.${field.key} 缺少 label`);
      if (field.type === 'enum') {
        if (!field.options?.length) fail(`${capability.id}.${field.key} 是 enum 但没有 options`);
        const values = new Set<string>();
        for (const option of field.options) {
          if (values.has(option.value)) fail(`${capability.id}.${field.key} 的枚举值重复：${option.value}`);
          values.add(option.value);
          if (option.risk && !(option.risk in RISK_RANK)) fail(`${capability.id}.${field.key} 的枚举风险非法：${option.risk}`);
        }
      }
      if (field.type === 'code' && !field.language?.trim()) fail(`${capability.id}.${field.key} 是 code 但没有 language`);
      if (field.type === 'number' && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        fail(`${capability.id}.${field.key} 的 min > max`);
      }
      if (!defaultMatchesType(field)) fail(`${capability.id}.${field.key} 的 default 与 type 不匹配`);
      // allowAll 只对 database 有意义，写错类型说明契约作者误解了该字段
      if (field.allowAll !== undefined) {
        if (field.type !== 'database') fail(`${capability.id}.${field.key} 的 allowAll 只用于 database 字段`);
        if (field.allowAll && field.required) fail(`${capability.id}.${field.key} 不能同时是 required 与 allowAll（允许空就不该必填）`);
      }
      if (field.legacyKey) {
        if (!CAMEL.test(field.legacyKey)) fail(`${capability.id}.${field.key} 的 legacyKey 必须是 camelCase：${field.legacyKey}`);
        if (keys.has(field.legacyKey)) fail(`${capability.id}.${field.key} 的 legacyKey 与其它字段撞名：${field.legacyKey}`);
      }
    }
    for (const field of capability.fields) {
      if (!field.showWhen) continue;
      if (!keys.has(field.showWhen.field)) fail(`${capability.id}.${field.key} 的 showWhen 指向不存在的字段：${field.showWhen.field}`);
      if (field.showWhen.field === field.key) fail(`${capability.id}.${field.key} 的 showWhen 不能指向自己`);
    }

    // 状态
    if (!Array.isArray(capability.states) || !capability.states.length) fail(`${capability.id} 没有 states`);
    const stateIds = new Set<string>();
    for (const state of capability.states) {
      if (!state.id?.trim()) fail(`${capability.id} 有空状态 id`);
      if (stateIds.has(state.id)) fail(`${capability.id} 的状态 id 重复：${state.id}`);
      stateIds.add(state.id);
      if (!state.phrase?.trim()) fail(`${capability.id}.${state.id} 缺少 phrase`);
      for (const token of phrasePlaceholders(state.phrase)) {
        if (!keys.has(token) && !PHRASE_RESULT_TOKENS.has(token)) {
          fail(`${capability.id}.${state.id} 的 phrase 占位符 {${token}} 既不是字段也不是约定的结果 token`);
        }
      }
    }
    if (!capability.states.some((state) => state.terminal === true)) fail(`${capability.id} 没有任何终态（terminal: true）`);

    // 工具
    if (!Array.isArray(capability.tools)) fail(`${capability.id} 的 tools 必须是数组（可为空）`);
    for (const name of capability.tools) {
      const risk = toolRisk.get(name);
      if (!risk) fail(`${capability.id} 声明了不存在的工具：${name}`);
      if (risk !== 'dynamic' && RISK_RANK[risk as Risk] > RISK_RANK[capability.maxRisk]) {
        fail(`${capability.id} 的 maxRisk=${capability.maxRisk} 低于工具 ${name} 的风险 ${risk}`);
      }
    }

    // 路由
    if (capability.route) {
      const key = `${capability.route.method} ${capability.route.path}`;
      if (routes.has(key)) fail(`路由重复：${key}`);
      routes.add(key);
    }
  }
}

export interface CapabilityValidationIssue {
  field: string;
  message: string;
}

export interface CapabilityValidation {
  ok: boolean;
  /** 归一化后的参数（含默认值）；校验失败时不存在。 */
  value?: Record<string, unknown>;
  errors?: CapabilityValidationIssue[];
}

/**
 * 运行时入参校验与默认值归一化。
 *
 * - 未声明的字段被忽略（保持与旧调用方兼容）；
 * - `showWhen` 未满足的字段既不校验也不填默认值；
 * - 未知的 `default` 之外的缺失必填会报错；
 * - 不做连接存在性、代码语法等业务校验（那是 gateway / 执行器的事）。
 */
export function validateCapabilityInput(capability: Capability, body: unknown): CapabilityValidation {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: '$', message: 'body 必须是对象' }] };
  }
  const raw = body;
  const errors: CapabilityValidationIssue[] = [];
  const value: Record<string, unknown> = {};
  // showWhen 必须针对「归一化后的取值」判断，否则依赖默认值的条件显示永远不成立
  // （例如 /jobs 不传 type 时默认 query，但 sql 字段依赖 type === 'query'）。
  // visibility 只用于可见性判断，用字段默认值补齐，因此与被依赖字段的声明顺序无关。
  const visibility: Record<string, unknown> = { ...raw };
  for (const field of capability.fields) {
    if (visibility[field.key] === undefined && field.default !== undefined) visibility[field.key] = field.default;
  }

  for (const field of capability.fields) {
    if (!fieldVisible(field, visibility)) continue;
    // 迁移期：先认契约里的规范名，再回退到旧字段名（如 sourceId → sourceConnectionId）。
    const present = Object.prototype.hasOwnProperty.call(raw, field.key);
    const legacyPresent = field.legacyKey ? Object.prototype.hasOwnProperty.call(raw, field.legacyKey) : false;
    const input = present ? raw[field.key] : legacyPresent ? raw[field.legacyKey as string] : undefined;
    const empty = input === undefined || input === null || (typeof input === 'string' && !input.trim());

    if (empty) {
      if (field.default !== undefined) {
        value[field.key] = field.default;
      } else if (field.required) {
        errors.push({ field: field.key, message: `${field.label.zh}必填` });
      }
      continue;
    }

    switch (field.type) {
      case 'connection':
      case 'database':
      case 'table':
      case 'text': {
        if (typeof input !== 'string') {
          errors.push({ field: field.key, message: `${field.label.zh}必须是字符串` });
          break;
        }
        value[field.key] = input.trim();
        break;
      }
      case 'code': {
        if (typeof input !== 'string') {
          errors.push({ field: field.key, message: `${field.label.zh}必须是字符串` });
          break;
        }
        value[field.key] = input;
        break;
      }
      case 'tables': {
        if (!Array.isArray(input) || !input.every((item) => typeof item === 'string' && item.trim())) {
          errors.push({ field: field.key, message: `${field.label.zh}必须是字符串数组` });
          break;
        }
        value[field.key] = (input as string[]).map((item) => item.trim());
        break;
      }
      case 'number': {
        const numeric = typeof input === 'number' ? input : Number(input);
        if (!Number.isFinite(numeric)) {
          errors.push({ field: field.key, message: `${field.label.zh}必须是数字` });
          break;
        }
        if (field.min !== undefined && numeric < field.min) {
          errors.push({ field: field.key, message: `${field.label.zh}不能小于 ${field.min}` });
          break;
        }
        if (field.max !== undefined && numeric > field.max) {
          errors.push({ field: field.key, message: `${field.label.zh}不能大于 ${field.max}` });
          break;
        }
        value[field.key] = numeric;
        break;
      }
      case 'boolean': {
        if (typeof input !== 'boolean') {
          errors.push({ field: field.key, message: `${field.label.zh}必须是布尔值` });
          break;
        }
        value[field.key] = input;
        break;
      }
      case 'enum': {
        const text = String(input);
        if (!(field.options ?? []).some((option) => option.value === text)) {
          errors.push({ field: field.key, message: `${field.label.zh}只能是 ${(field.options ?? []).map((o) => o.value).join(' / ')}` });
          break;
        }
        value[field.key] = text;
        break;
      }
      case 'json': {
        if (!isPlainObject(input)) {
          errors.push({ field: field.key, message: `${field.label.zh}必须是对象` });
          break;
        }
        value[field.key] = input;
        break;
      }
      default: {
        errors.push({ field: field.key, message: `未知字段类型：${field.type}` });
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}
