import type { Risk } from '../types';

/**
 * 功能能力契约（Capability Contract）。
 *
 * 一份声明描述一个软件自带功能的「表单契约」：有哪些字段、什么类型、什么约束、
 * 什么状态、什么流程。它同时服务三个消费方：
 *
 * 1. Agent —— 注入系统提示的能力目录，让模型知道功能存在、怎么填、返回什么状态；
 * 2. REST 端点 —— 参数校验与默认值归一化；
 * 3. UI —— 表单渲染（渐进迁移）。
 *
 * 契约层不认识「执行」。若某字段是一段脚本（`type: 'code'`），契约只声明
 * 「这里填一段代码、什么语言、入参出参是什么」，脚本的解析、沙箱、超时与
 * 资源限制全部由该功能的执行器自己负责。
 */

export type CapabilityFieldType =
  /** 连接 id；连接是否存在由 gateway 补检（core 不认识 store）。 */
  | 'connection'
  /** 库名；通常依赖同一表单里的 connection 字段。 */
  | 'database'
  /** 表名。 */
  | 'table'
  /** 表名数组。 */
  | 'tables'
  /** 自由文本。 */
  | 'text'
  /** 代码片段（SQL / JS / 正则）。契约只声明语言与入参出参，不承诺执行。 */
  | 'code'
  /** 数字，可带 min / max / default。 */
  | 'number'
  /** 布尔。 */
  | 'boolean'
  /** 枚举，必须给 options。 */
  | 'enum'
  /** 结构化对象。 */
  | 'json';

export interface CapabilityFieldOption {
  value: string;
  label: { zh: string; en: string };
  /** 选择该值时是否升级风险（例如 replace 模式会清空目标表）。 */
  risk?: Risk;
}

export interface CapabilityField {
  key: string;
  type: CapabilityFieldType;
  label: { zh: string; en: string };
  required?: boolean;
  /** 默认值；不写表示无默认。 */
  default?: unknown;
  /**
   * REST 请求体里的旧字段名。
   *
   * 契约统一用 Agent 工具的命名（`sourceConnectionId`），但历史端点用 `sourceId`。
   * 迁移期靠这个别名让两侧同时可用：校验时先读 `key`，再读 `aliases`。
   * 全部端点迁移完成后删除该字段。
   */
  legacyKey?: string;
  /** 当 type=number 时生效。 */
  min?: number;
  max?: number;
  /**
   * 当 type=database 时生效：是否提供「全部库」选项。
   *
   * **不要从 `required` 推导**——`required: true` 只表示必须有值，
   * 与「允不允许空」是两件事。省略该字段时：
   * - `type=database` 默认 `false`（下拉会自动选中连接默认库）；
   * - 只有明确写 `allowAll: true` 的字段才会多一个「全部库」空选项。
   */
  allowAll?: boolean;
  /** 当 type=enum 时生效，必须非空。 */
  options?: CapabilityFieldOption[];
  /** 当 type=code 时生效：语言标识，如 'sql' | 'javascript' | 'regex'。 */
  language?: string;
  /** 当 type=code 时生效：给填写者的入参/出参说明（纯文字，契约不校验）。 */
  signature?: { input?: string; output?: string };
  /** 给 Agent 的补充说明：什么时候该填、有什么坑。 */
  hint?: string;
  /** 高级字段，UI 默认折叠。 */
  advanced?: boolean;
  /** 字段可见性依赖：只在同表单内 field === equals 时显示与校验。 */
  showWhen?: { field: string; equals: unknown };
}

export interface CapabilityState {
  /** 状态机里的状态 id。 */
  id: string;
  label: { zh: string; en: string };
  /** 终态：不再变化。至少一个状态必须是终态。 */
  terminal?: boolean;
  /** 给 Agent 的汇报话术模板，可含 {field} 占位符。 */
  phrase: string;
}

export interface CapabilityProgress {
  /** 是否支持进度上报。false 时 Agent 不应期待 progress。 */
  supported: boolean;
  /** 进度单位，如 'table' / 'row' / 'batch'。 */
  unit?: string;
}

export interface CapabilityRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
}

export interface Capability {
  /** 唯一 id，kebab-case。 */
  id: string;
  /** 与 REST 路由的对应关系，仅作说明；空表示纯前端功能。 */
  route?: CapabilityRoute;
  title: { zh: string; en: string };
  /** 一句话说明，会进 Agent 提示。 */
  description: string;
  /** 什么时候该用；会进 Agent 提示。 */
  whenToUse: string;
  /** 流程步骤，会进 Agent 提示；纯文字，不是可执行计划。 */
  flow: string[];
  fields: CapabilityField[];
  states: CapabilityState[];
  progress?: CapabilityProgress;
  /** 对应的 Agent 工具名；空数组表示当前无工具（Agent 只能告知用户去 UI 操作）。 */
  tools: string[];
  /** 本功能的声明风险上限，供 Agent 判断是否需要审批提示。 */
  maxRisk: Risk;
  /** 引擎/权限限制说明，会进 Agent 提示。 */
  constraints?: string[];
}

/** 契约文件里的 id 清单，用于注册表与覆盖检查。 */
export type CapabilityId =
  | 'transfer'
  | 'compare-data'
  | 'schema-sync'
  | 'jobs'
  | 'pipelines'
  | 'generate'
  | 'monitor'
  | 'users'
  | 'dictionary'
  | 'advanced-objects'
  | 'search'
  | 'query-builder'
  | 'agent-context'
  | 'reports';
