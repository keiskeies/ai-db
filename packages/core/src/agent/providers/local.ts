import type { ColumnDef, IndexDef } from '../../sql/ddl';
import { buildCount, buildMonthlySeriesExpr, buildSelectTable, defaultIndexName } from '../../sql/ddl';
import { isSqlEngine } from '../../engines';
import { quoteIdent, quoteLiteral } from '../../sql/ident';
import type { ColumnInfo, ConnectionConfig, DatabaseSchema, Engine, TableInfo } from '../../types';
import { expandTerms } from '../context';
import { groundedColumns, groundedTables, hiddenTableMention, matchColumn, matchTable, numericColumns, pickDimension, pickMeasure, pickTimeColumn, rankTables } from '../local/schema';
import type { GroundingOptions } from '../local/schema';
import type { PlanOutcome, PlanProbe } from '../local/parse';
import { chartKindOf, isFollowUp, planQuery, splitClauses } from '../local/parse';
import type { QuerySpec } from '../local/query';
import type { Forbidden } from '../local/business';
import { forbiddenFromGlossary, forbiddenTableReason, matchSqlExample } from '../local/business';
import { estimateTokens } from '../prompt';
import { columnLabel, tableLabel } from '../suggest';
import type {
  AgentContextData,
  LlmProvider,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ToolCall,
  ToolResult,
} from '../types';

export type LocalIntent =
  | 'list_tables'
  | 'describe'
  | 'sample'
  | 'count'
  | 'group'
  | 'create'
  | 'drop'
  | 'index'
  | 'insert'
  | 'backup'
  | 'export'
  | 'explain'
  | 'audit'
  | 'quality'
  | 'chart'
  | 'analyze'
  | 'raw_sql'
  | 'memory_write'
  | 'memory_search'
  | 'help';

interface ToolOutcome {
  name: string;
  result: ToolResult;
  /**
   * 发起这次调用时的参数。多问一句要按调用回看结果（三步查询返回三份数据，
   * 只按工具名取「最后一个」会把答案配错行），所以这里带上原始 args。
   */
  args?: Record<string, unknown>;
}

interface Analysis {
  prompt: string;
  outcomes: ToolOutcome[];
  /** 本轮之前的用户原话（旧→新）：追问的口径从这里继承。 */
  priorUser: string[];
}

const CN_COLUMNS: Record<string, string> = {
  标题: 'title',
  名称: 'name',
  名字: 'name',
  描述: 'description',
  内容: 'content',
  备注: 'note',
  状态: 'status',
  类型: 'type',
  金额: 'amount',
  价格: 'price',
  数量: 'quantity',
  年龄: 'age',
  邮箱: 'email',
  邮件: 'email',
  手机: 'phone',
  电话: 'phone',
  创建时间: 'created_at',
  更新时间: 'updated_at',
  完成: 'done',
  是否完成: 'done',
  用户: 'user',
  用户名: 'username',
};

const CN_TABLES: Record<string, string> = {
  用户: 'users',
  用户表: 'users',
  订单: 'orders',
  订单表: 'orders',
  产品: 'products',
  产品表: 'products',
  任务: 'tasks',
  任务表: 'tasks',
  事件: 'events',
  日志: 'logs',
};

export function detectIntent(prompt: string): LocalIntent {
  const p = prompt.trim().toLowerCase();
  if (!p) return 'help';
  if (/(记住|记一下|remember)/.test(p)) return 'memory_write';
  if (/(记忆|还记得|之前.*(说|记|提)|memory|回忆)/.test(p)) return 'memory_search';
  if (/^\s*(select|insert|update|delete|with|alter|create|drop)\b/i.test(stripCodeFence(prompt)) && !/(创建|新建|建).{0,4}表/.test(p)) return 'raw_sql';
  if (/^(select|insert|update|delete|with)\b/i.test(stripCodeFence(prompt))) return 'raw_sql';
  if (/(巡检|体检|健康检查|数据库健康|审计数据库|audit\b)/.test(p)) return 'audit';
  if (/(空值|null值|重复|数据质量|quality|一致性|异常值|脏数据|duplicate)/.test(p)) return 'quality';
  // 必须排在 chart 之前：「预测未来三个月的趋势」既要趋势更要外推，走 analyze 才有权威数字
  if (/(预测|forecast|外推|接下来.*(多少|会)|未来)/.test(p)) return 'analyze';
  // 点名要图就按图走：「统计金额合计并画柱状图」里「合计」也命中 analyze，
  // 但用户要的是那几根柱子，回一张统计表等于没回答。
  if (/(画图|画个|画张|画一|绘|图表|可视化|趋势|走势|折线|柱状|饼图|热力|雷达|堆叠|chart|plot|heatmap|radar|stacked)/.test(p)) return 'chart';
  if (/(合计|总和|求和|平均值|均值|环比|占比多少|最大.*最小|\bsum\b|\bavg\b)/.test(p)) return 'analyze';
  // 「金额最高的 10 笔订单」「订单明细前 5 条」要的是行不是分组数字：以前没人认领，落到 help 甩清单。
  // 量词紧跟数字才算行数，否则「前 3 个月」会被当成条数。
  if (/(明细|清单|逐条|详情|detail)|(?:最(?:高|大|多|低|小|便宜|贵)的|前)\s*\d{1,3}\s*(?:笔|条|行|单)/.test(p)) return 'group';
  if (/(备份|backup)/.test(p)) return 'backup';
  if (/(导出|export)/.test(p)) return 'export';
  if (/(创建|新建|建立|建)\s*(一个|一张)?\s*(表|table)|create\s+table/.test(p)) return 'create';
  if (/(删除|drop|移除).{0,8}(表|table)|drop\s+table/.test(p)) return 'drop';
  if (/(索引|index)/.test(p)) return 'index';
  if (/(执行计划|explain|解释)/.test(p)) return 'explain';
  if (/(优化|optimize|慢查询|索引失效)/.test(p)) return 'explain';
  if (/(插入|生成|造|seed).{0,8}(数据|记录|sample|data)/.test(p)) return 'insert';
  if (/(多少(行|条|个)|行数|条数|count|总数)/.test(p)) return 'count';
  if (/(分组|group\s+by|按.{0,10}(统计|汇总|分布))/.test(p)) return 'group';
  if (/(看|来|show|sample|预览|检查).{0,10}(几|样例|数据|rows?)/.test(p)) return 'sample';
  if (/(结构|字段|schema|列信息|columns?)/.test(p)) return 'describe';
  if (/(有哪些表|哪些表|所有表|列出.*表|表列表|list.*tables?|show\s+tables)/.test(p)) return 'list_tables';
  if (/(帮助|能做什么|help|怎么用)/.test(p)) return 'help';
  return 'help';
}

function stripCodeFence(text: string): string {
  const m = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

function analyzeMessages(messages: ProviderMessage[]): Analysis {
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userIndex = i;
      break;
    }
  }
  const prompt = userIndex >= 0 ? (messages[userIndex] as { content: string }).content : '';
  // toolCallId → args：工具结果消息只带名字和数据，多问一句要按调用回看它查的是哪条 SQL。
  const argsById = new Map<string, Record<string, unknown>>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const call of m.toolCalls) argsById.set(call.id, call.args);
  }
  const outcomes: ToolOutcome[] = [];
  for (let i = userIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    try {
      outcomes.push({ name: m.name, result: JSON.parse(m.content) as ToolResult, ...(argsById.get(m.toolCallId) ? { args: argsById.get(m.toolCallId) } : {}) });
    } catch {
      /* ignore malformed */
    }
  }
  // 上一问的原话：追问（「那按城市呢」「只看已支付的」）不带主语，口径只能从这里继承。
  const priorUser: string[] = [];
  for (let i = 0; i < userIndex; i++) {
    const m = messages[i];
    if (m.role === 'user') priorUser.push(m.content);
  }
  return { prompt, outcomes, priorUser };
}

function getOutcome(outcomes: ToolOutcome[], name: string): ToolOutcome | undefined {
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i].name === name) return outcomes[i];
  }
  return undefined;
}

function extractConnections(outcome: ToolOutcome | undefined): ConnectionConfig[] {
  const data = outcome?.result.data as { connections?: ConnectionConfig[] } | ConnectionConfig[] | undefined;
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.connections ?? [];
}

function tablesFromContext(ctx: AgentContextData, conn?: ConnectionConfig): TableInfo[] {
  if (!ctx.databases?.length) return [];
  return conn?.database
    ? ctx.databases.find((d) => d.name === conn.database || d.name === 'main')?.tables ?? ctx.databases.flatMap((d) => d.tables)
    : ctx.databases.flatMap((d) => d.tables);
}

function tablesFromInspect(outcome: ToolOutcome | undefined): TableInfo[] {
  const data = outcome?.result.data as { tables?: TableInfo[]; databases?: DatabaseSchema[] } | undefined;
  if (!data) return [];
  if (Array.isArray(data.tables)) return data.tables;
  if (Array.isArray(data.databases)) return data.databases.flatMap((d) => d.tables);
  return [];
}

function pickConnection(prompt: string, conns: ConnectionConfig[]): ConnectionConfig {
  const p = prompt.toLowerCase();
  return conns.find((c) => p.includes(c.name.toLowerCase())) ?? conns[0];
}

function mkCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name, args };
}

function typeFor(kind: 'text' | 'integer' | 'boolean' | 'timestamp' | 'decimal', engine: Engine): string {
  switch (kind) {
    case 'integer':
      return 'INTEGER';
    case 'boolean':
      return engine === 'postgresql' ? 'BOOLEAN' : engine === 'mysql' ? 'TINYINT(1)' : 'INTEGER';
    case 'timestamp':
      return engine === 'sqlite' ? 'TEXT' : engine === 'mysql' ? 'DATETIME' : 'TIMESTAMP';
    case 'decimal':
      return engine === 'postgresql' ? 'NUMERIC(12,2)' : 'DECIMAL(12,2)';
    default:
      return 'TEXT';
  }
}

export function parseCreateSpec(prompt: string, engine: Engine): { table: string; columns: ColumnDef[]; indexes?: IndexDef[] } | { error: string } {
  const nameMatch = prompt.match(/(?:创建|新建|建立|建|create)\s*(?:一个|一张|名为|一个名为|table|表)?\s*[`"']?([A-Za-z_][A-Za-z0-9_]*|[一-龥]{1,10})[`"']?/i);
  if (!nameMatch) return { error: '请告诉我表名，例如：创建表 tasks，包含 id 自增主键, title 文本' };
  let table = nameMatch[1];
  if (!/^[A-Za-z_]/.test(table)) table = CN_TABLES[table] ?? 'agent_table';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) table = 'agent_table';

  const rest = prompt.slice((nameMatch.index ?? 0) + nameMatch[0].length);
  const parts = rest.split(/(?:包含|字段(?:为|是)?|列(?:为|是)?|with|columns?[:：]?)/i);
  const segment = (parts.length > 1 ? parts.slice(1).join(' ') : rest).replace(/^[\s:：,，。]+/, '');
  const items = segment
    .split(/[,，;；、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /[A-Za-z\u4e00-\u9fff]/.test(s));

  const columns: ColumnDef[] = [];
  let index = 0;
  for (const item of items) {
    const m = item.match(/^[`"']?([A-Za-z_][A-Za-z0-9_]*|[一-龥]{1,10})[`"']?\s+(.+)$/);
    if (!m) continue;
    const rawName = m[1];
    const def = m[2].toLowerCase();
    let name = /^[A-Za-z_]/.test(rawName) ? rawName : CN_COLUMNS[rawName] ?? `col_${index + 1}`;
    if (columns.some((c) => c.name === name)) name = `${name}_${index + 1}`;
    index++;
    const autoIncrement = /(自增|auto.?increment|identity)/.test(def);
    const primaryKey = /(主键|primary)/.test(def) || autoIncrement;
    let kind: 'text' | 'integer' | 'boolean' | 'timestamp' | 'decimal' = 'text';
    if (autoIncrement || /(整数|integer|\bint\b|数字|number)/.test(def)) kind = 'integer';
    if (/(布尔|bool|boolean)/.test(def)) kind = 'boolean';
    if (/(时间|日期|timestamp|datetime|date)/.test(def)) kind = 'timestamp';
    if (/(金额|价格|小数|decimal|numeric)|(?:numeric|decimal)\s*\(/.test(def)) kind = 'decimal';
    const defaultMatch = def.match(/默认\s*[=:：]?\s*([^\s,，;；]+)/);
    const nullable = !/(非空|not null|必填|required)/.test(def);
    const unique = /(唯一|unique)/.test(def);
    columns.push({
      name,
      type: kind === 'integer' && autoIncrement && engine === 'mysql' ? 'INT' : typeFor(kind, engine),
      nullable,
      primaryKey,
      autoIncrement,
      unique,
      defaultValue: defaultMatch ? mapDefault(defaultMatch[1]) : undefined,
    });
  }

  if (!columns.length) {
    columns.push(
      { name: 'id', type: typeFor('integer', engine), nullable: false, primaryKey: true, autoIncrement: true },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'created_at', type: typeFor('timestamp', engine), defaultValue: 'CURRENT_TIMESTAMP' },
    );
  }
  const indexes: IndexDef[] = [];
  const uniqueIdx = prompt.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:字段|列)?\s*(?:上)?\s*(?:的)?\s*(?:唯一|unique)\s*索引/i);
  if (uniqueIdx && columns.some((c) => c.name === uniqueIdx[1])) {
    indexes.push({ name: defaultIndexName(table, [uniqueIdx[1]], true), columns: [uniqueIdx[1]], unique: true });
  }
  return { table, columns, indexes: indexes.length ? indexes : undefined };
}

function mapDefault(raw: string): string {
  const cleaned = raw.replace(/[，,。；;]$/, '');
  if (/(当前时间|现在|now|current_timestamp)/i.test(cleaned)) return 'CURRENT_TIMESTAMP';
  return cleaned.replace(/^["']|["']$/g, '');
}

function groundingOf(ctx: AgentContextData, database?: string): GroundingOptions {
  return {
    bundle: ctx.agentContext,
    glossary: ctx.glossary,
    sqlExamples: ctx.sqlExamples,
    memories: ctx.memories,
    database,
    attachments: ctx.attachmentTables,
  };
}

/** 追问时列候选表：与当前问题相关的排前面，而不是按字母序甩一堆无关表名。 */
function tableCandidates(question: string, tables: TableInfo[], grounding: GroundingOptions, limit = 20): string {
  const ranked = rankTables(question, tables, grounding);
  const rest = tables.filter((table) => !ranked.some((item) => item.name === table.name));
  return [...ranked, ...rest].slice(0, limit).map((table) => `\`${table.name}\``).join('、');
}

/** 用户点名的列优先（哪怕是时间列），没点名才退回最合适的维度列。 */
function groupColumnOf(question: string, table: TableInfo, grounding: GroundingOptions): ColumnInfo | undefined {
  return matchColumn(question, table, grounding) ?? pickDimension(table, question, grounding);
}

/** 这几个意图交给规划器：它们本质是「一句聚合查询」，规则模板覆盖不住组合。 */
const PLANNED_INTENTS: LocalIntent[] = ['count', 'group', 'analyze', 'chart'];

/** 高级图与预测有自己的取数口径（模板 / 确定性外推），不走聚合规划器。 */
function usePlanner(intent: LocalIntent, prompt: string, engine: Engine): boolean {
  if (!PLANNED_INTENTS.includes(intent)) return false;
  if (!isSqlEngine(engine)) return false;
  if (/(预测|forecast|外推)/.test(prompt)) return false;
  // 散点要逐行数值对，不是聚合；热力/雷达/堆叠都由规划器取数（两根轴 / 多列度量）。
  return !/(散点|scatter|相关系数|correlation)/i.test(prompt);
}

function profiledValues(outcomes: ToolOutcome[]): { table: string; column: string; values: Array<string | number> } | undefined {
  const action = getOutcome(outcomes, 'profile_column');
  const data = action?.result.data as { table?: string; column?: string; top?: Array<{ value: unknown }> } | undefined;
  if (!data?.column || !Array.isArray(data.top)) return undefined;
  const values = data.top.map((item) => item.value).filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
  return { table: data.table ?? '', column: data.column, values };
}

/**
 * 已登记的示例 SQL 走的是用户自己的口径：列名是他写的、聚合是他定的，
 * 这里只负责把它跑起来并念出数字，不再套规划器的结论模板（模板按固定别名取数，会念空）。
 */
function examplePreamble(title: string): string {
  return `你在「Agent 上下文 → 术语与示例 → 示例 SQL」里登记过这类问题，我按那条口径查：**${title.trim()}**。`;
}

function exampleAnswer(intent: LocalIntent, action: ToolOutcome): string {
  if (!action.result.ok) return errText(action.result);
  if (intent === 'chart') {
    const chart = (action.result.data as { chart?: { title?: string; series?: Array<{ label: string; value: number }> } } | undefined)?.chart;
    const top = [...(chart?.series ?? [])].sort((a, b) => b.value - a.value).slice(0, 3);
    return `图表已生成：**${chart?.title ?? '分析图'}**。\n\n${top.length ? top.map((point) => `- ${point.label}：${formatNumber(point.value)}`).join('\n') : '没有可绘制的数据。'}`;
  }
  if (intent === 'analyze') {
    const d = action.result.data as { x?: string; y?: string; rowCount?: number; sum?: number; avg?: number; max?: number; min?: number; argmax?: string; argmin?: string } | undefined;
    if (d?.rowCount === undefined) return `统计结果：\n\n${renderRows(action.result.data, 12) || '（没有行）'}`;
    return (
      `按 \`${d.x ?? '标签'}\` 统计 \`${d.y ?? '数值'}\`：共 ${d.rowCount} 组，合计 **${formatNumber(d.sum)}**，均值 ${formatNumber(d.avg)}，` +
      `最高 ${d.argmax ?? '—'}（${formatNumber(d.max)}），最低 ${d.argmin ?? '—'}（${formatNumber(d.min)}）。数字由 Bridge 计算，不是估算。`
    );
  }
  const rows = renderRows(action.result.data, 12);
  return rows ? `查询结果：\n\n${rows}` : '查询返回 0 行：条件可能过紧，或这段时间确实没有数据。';
}

function planOf(input: { question: string; engine: Engine; tables: TableInfo[]; grounding: GroundingOptions; outcomes: ToolOutcome[]; forbidden: Forbidden; focus?: QuerySpec }): PlanOutcome {
  return planQuery({
    question: input.question,
    engine: input.engine,
    tables: input.tables,
    grounding: input.grounding,
    forbidden: input.forbidden,
    focus: input.focus,
    probe: profiledValues(input.outcomes),
    probeDone: Boolean(getOutcome(input.outcomes, 'profile_column')),
  });
}

/** 一句话里的每一问：要么给出待发的查询，要么给出已经跑完的答案，要么说清为什么没查。 */
interface CompoundStep {
  text: string;
  call?: ToolCall;
  answer?: string;
  gap?: string;
  probe?: PlanProbe;
  done: boolean;
}

/**
 * 多问一句逐步规划。
 *
 * 每一问单独走一遍规划器，所以「先算总数再按城市拆分」的第二半句和直接问同一句话给出同一条 SQL、
 * 同一张图。结果按工具名顺序回看而不是取「最后一个」：三步里有两步都用 run_sql 时，
 * 取最后一个会把同一个数字念两遍。
 */
function compoundSteps(input: {
  question: string;
  engine: Engine;
  tables: TableInfo[];
  grounding: GroundingOptions;
  forbidden: Forbidden;
  outcomes: ToolOutcome[];
  connectionId: string;
  database?: string;
  bundle?: AgentContextData['agentContext'];
}): CompoundStep[] {
  const clauses = splitClauses(input.question);
  if (clauses.length < 2) return [];
  const steps: CompoundStep[] = [];
  const next = takeOutcome(input.outcomes);
  for (const clause of clauses) {
    // 半句常常只有「再算金额合计」这种动词短语：识别不出聚合意图时按统计处理，
    // 落到 help 会让计划卡冒出一句「这一问我没听懂」。
    const detected = detectIntent(clause);
    const kind: LocalIntent = PLANNED_INTENTS.includes(detected) ? detected : 'analyze';
    const plan = planOf({ question: clause, engine: input.engine, tables: input.tables, grounding: input.grounding, outcomes: input.outcomes, forbidden: input.forbidden });
    const label = clause.length > 26 ? `${clause.slice(0, 26)}…` : clause;
    if (plan.status === 'probe' && plan.probe) {
      steps.push({ text: label, probe: plan.probe, done: false });
      continue;
    }
    if (plan.status !== 'ready' || !plan.compiled) {
      steps.push({ text: label, gap: plan.gap ?? '这一问的口径我没能解析出来，请换个说法或拆开问。', done: false });
      continue;
    }
    const step = planStepCall({ intent: kind, plan, prompt: clause, connectionId: input.connectionId, database: input.database, bundle: input.bundle, titleTable: matchTable(clause, input.tables, input.grounding) });
    if (!step) {
      steps.push({ text: label, gap: '这一问缺一个可统计的数值列，请说明要统计哪一列。', done: false });
      continue;
    }
    // 跑过就念结果，没跑过才发调用。带得上调用参数时核对 SQL，换过口径的旧结果不复用；
    // 参数缺失（更早留下的上下文）退回按工具名顺序对齐——宁可少核对一层，
    // 也不能认不出自己的上一轮，把同样的查询再发一遍。
    const prior = next(step.tool, plan.compiled.sql);
    if (prior) {
      const probeNote = plan.dropped?.length ? `\n\n> ${plan.dropped.join('；')}。` : '';
      steps.push({ text: label, answer: planStepAnswer({ intent: kind, plan, result: prior.result, probeNote }), done: true });
      continue;
    }
    steps.push({ text: label, call: mkCall(step.tool, step.args), done: false });
  }
  return steps;
}

/**
 * 按工具名把已有结果依次分给各步：返回的游标每调用一次消费该工具的下一次结果，
 * 用过的不会再给后面的步骤。
 */
function takeOutcome(outcomes: ToolOutcome[]): (tool: string, sql: string) => ToolOutcome | undefined {
  const queues = new Map<string, ToolOutcome[]>();
  for (const outcome of outcomes) {
    const queue = queues.get(outcome.name) ?? [];
    queue.push(outcome);
    queues.set(outcome.name, queue);
  }
  return (tool, sql) => {
    const queue = queues.get(tool);
    if (!queue?.length) return undefined;
    const index = queue.findIndex((outcome) => outcome.args?.sql === undefined || String(outcome.args.sql) === sql);
    if (index < 0) return undefined;
    const [hit] = queue.splice(index, 1);
    return hit;
  };
}

/**
 * 追问的口径从上一问来。
 *
 * 依据是上一问的原话，不是它留下的 SQL：规划器是确定性的，重跑一次就拿到同一份 spec，
 * 而去解析历史里那段 SQL 等于再写一个解析器，只会比真的解析器更差。
 *
 * 按时间顺序把历史问题依次重放，每句都带着上一句的结果当焦点：连续追问（先「按城市」再
 * 「只看已退款的」）时口径是层层叠加的，只看最近一句会把中间那次修改丢掉。
 */
function focusOf(input: { priorUser: string[]; engine: Engine; tables: TableInfo[]; grounding: GroundingOptions; forbidden: Forbidden }): QuerySpec | undefined {
  let spec: QuerySpec | undefined;
  for (const text of input.priorUser.slice(-6)) {
    const prior = text.trim();
    if (!prior) continue;
    const question = expandTerms(prior, input.grounding.glossary);
    const kind = detectIntent(prior);
    // 上一问是「表结构」「备份」这种库操作时没有口径可留；但它之前那句的焦点还得带着走。
    if (!usePlanner(kind, prior, input.engine) && !isFollowUp(prior)) continue;
    const plan = planQuery({ question, engine: input.engine, tables: input.tables, grounding: input.grounding, forbidden: input.forbidden, focus: spec, replay: true });
    if (plan.spec) spec = plan.spec;
  }
  return spec;
}

/**
 * 追问句没有聚合动词时继承上一问的意图。
 *
 * 「那按城市呢」「只看已退款的」既不含「统计」也不含「合计」，detectIntent 只能给 help，
 * 于是离线模式在追问处直接甩清单——话题还在，只是换了个说法。
 * 意图必须从**最近一句能识别的话**继承，不能从紧邻的那句继承：连续追问时紧邻那句自己也是 help。
 */
function followUpIntent(intent: LocalIntent, prompt: string, priorUser: string[]): LocalIntent {
  if (intent !== 'help' || !isFollowUp(prompt) || !priorUser.length) return intent;
  for (let i = priorUser.length - 1; i >= 0; i--) {
    const prior = priorUser[i].trim();
    if (!prior) continue;
    const detected = detectIntent(prior);
    // 只继承聚合类意图：上一问是「表结构」「备份」这种库操作时，接话也没法当统计来做。
    return PLANNED_INTENTS.includes(detected) ? detected : intent;
  }
  return intent;
}

/** 口径说明：把规划器实际做了什么摊在执行过程里，用户才知道数字是怎么来的。 */
function planNotes(plan: PlanOutcome): string {
  const notes = plan.compiled?.notes ?? [];
  const filters = (plan.spec?.filters ?? []).filter((filter) => filter.source);
  const conditions = filters.map((filter) => `${filter.source}`).filter((text, index, all) => all.indexOf(text) === index);
  return [...notes, ...(conditions.length ? [`条件：${conditions.join('；')}`] : [])].join('；');
}

function planPreamble(intent: LocalIntent, plan: PlanOutcome, table: string, axisLabel?: string): string {
  const notes = planNotes(plan);
  if (intent === 'chart') return `我把 \`${table}\` 汇总后渲染图表${axisLabel ? `（横轴 ${axisLabel}）` : ''}${notes ? `：${notes}` : ''}。`;
  if (intent === 'analyze') return `我在 Bridge 侧算好 \`${table}\` 的统计量，不自己估数${notes ? `：${notes}` : ''}。`;
  if (plan.spec?.groupBy.length || plan.spec?.timeBucket) return `我按${axisLabel ? ` \`${axisLabel}\`` : '分组'}统计 \`${table}\`${notes ? `：${notes}` : ''}。`;
  return `我在 \`${table}\` 上按条件计数${notes ? `：${notes}` : ''}。`;
}

/** 结论：数字直接摆在第一句，口径跟在后面，明细表格压到最后。 */
function planConclusion(plan: PlanOutcome, data: unknown, maxRows = 12): string {
  const d = data as { columns?: Array<{ name: string } | string>; rows?: unknown[][] } | undefined;
  if (!d?.columns || !Array.isArray(d.rows)) return '查询没有返回行。';
  const names = d.columns.map((c) => (typeof c === 'string' ? c : c.name));
  const valueIndex = names.findIndex((name) => /^value$/i.test(name));
  const axisIndex = names.findIndex((name) => /^(label|period)$/i.test(name));
  const rows = d.rows;
  if (!rows.length) return '查询返回 0 行：条件可能过紧，或这段时间确实没有数据。';

  const single = valueIndex >= 0 && axisIndex < 0 && rows.length === 1;
  if (single) {
    const value = rows[0]?.[valueIndex];
    const measure = plan.measureLabel ? `${plan.measureLabel}` : '结果';
    return `**${formatNumber(value)}** —— 这是${measure}${windowText(plan)}。`;
  }

  const axisName = plan.axisLabel ?? (axisIndex >= 0 ? names[axisIndex] : '分组');
  const sorted = [...rows].sort((a, b) => (valueIndex >= 0 ? Number(b[valueIndex] ?? 0) - Number(a[valueIndex] ?? 0) : 0));
  const top = sorted[0];
  const head = sorted.slice(0, 3).map((row) => `- ${formatValue(row[axisIndex >= 0 ? axisIndex : 0])}：**${valueIndex >= 0 ? formatNumber(row[valueIndex]) : formatValue(row[1] ?? '')}**`);
  const total = valueIndex >= 0 ? rows.reduce((sum, row) => sum + Number(row[valueIndex] ?? 0), 0) : rows.length;
  return (
    `按 ${axisName} 分成 ${rows.length} 组${valueIndex >= 0 ? `，合计 **${formatNumber(total)}**` : ''}${windowText(plan)}。最高的是 ${formatValue(top?.[axisIndex >= 0 ? axisIndex : 0])}${valueIndex >= 0 ? `（${formatNumber(top?.[valueIndex])}）` : ''}。\n\n` +
    (head.length ? `前 ${head.length}：\n${head.join('\n')}\n\n` : '') +
    renderRows(data, maxRows, plan.labels)
  );
}

function windowText(plan: PlanOutcome): string {
  const period = (plan.spec?.filters ?? []).find((filter) => filter.window && filter.source);
  return period?.source ? `（${period.source}）` : '';
}

/**
 * 规划器就绪之后要发的那条只读调用。
 *
 * 单问和多问共用它：一句话拆成几按时，每一步的口径、别名和图表类型都得跟单独问时一模一样，
 * 否则「先算总额再按城市拆分」的第二半句会比直接问同一句话给出不同的图。
 * 返回 undefined 表示这张图/这份统计缺一个可用的数值列，调用方该定点追问。
 */
function planStepCall(input: {
  intent: LocalIntent;
  plan: PlanOutcome;
  prompt: string;
  connectionId: string;
  database?: string;
  bundle?: AgentContextData['agentContext'];
  titleTable?: TableInfo;
}): { tool: string; args: Record<string, unknown> } | undefined {
  const compiled = input.plan.compiled!;
  if (input.intent !== 'chart' && input.intent !== 'analyze') {
    return { tool: 'run_sql', args: { connectionId: input.connectionId, database: input.database, sql: compiled.sql, maxRows: 200 } };
  }
  const yField = compiled.valueAliases[0];
  if (!yField) return undefined;
  const args: Record<string, unknown> = { connectionId: input.connectionId, database: input.database, sql: compiled.sql, x: compiled.axisAlias, y: yField };
  if (input.intent === 'chart') {
    const spec = input.plan.spec;
    const kind = input.plan.chart ?? chartKindOf(input.prompt);
    if (kind === 'heatmap') {
      // 热力图的两根轴都是分类列：x 是横轴，y 是纵轴，数值列走 value 而不是 y。
      // 有一根是时间桶时编译结果依次是 period / label，否则是 label / label2。
      if (spec?.timeBucket) {
        args.x = 'period';
        args.y = 'label';
      } else if (spec?.groupBy.length === 2) {
        args.x = 'label';
        args.y = 'label2';
      } else {
        return undefined;
      }
      args.type = 'heatmap';
      args.value = yField;
    } else {
      args.type = kind ?? (spec?.timeBucket ? 'line' : /(饼|占比|pie|构成)/i.test(input.prompt) ? 'pie' : 'bar');
      if (kind === 'stacked' || kind === 'radar') {
        // 堆叠/雷达的其余度量列按 value2… 依次传入。
        const extra = compiled.valueAliases.slice(1);
        if (extra.length) args.ys = extra;
      }
    }
    if (input.titleTable) args.title = `${tableLabel(input.bundle, input.titleTable)} · ${input.plan.axisLabel ?? input.plan.measureLabel ?? '统计'}`;
  }
  return { tool: input.intent === 'chart' ? 'render_chart' : 'analyze_chart', args };
}

/** 把一条已经跑完的查询念成结论：数字在前，SQL 在后，抽取不了的口径另起一行交代。 */
function planStepAnswer(input: { intent: LocalIntent; plan: PlanOutcome; result: ToolResult; probeNote: string }): string {
  if (!input.result.ok) return errText(input.result);
  const { intent, plan } = input;
  const sql = plan.compiled!.sql;
  if (intent === 'chart') {
    const data = input.result.data as {
      chart?: {
        title?: string;
        note?: string;
        series?: Array<{ label: string; value: number }>;
        heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][]; valueLabel?: string };
      };
    } | undefined;
    const chart = data?.chart;
    const note = chart?.note ? `\n\n> ${chart.note}` : '';
    if (chart?.heatmap) {
      const grid = chart.heatmap;
      const flat = grid.values.flat().filter((value) => Number.isFinite(value));
      const max = flat.length ? Math.max(...flat) : 0;
      return (
        `热力图已生成并显示在上方工具卡中：**${chart.title ?? '热力图'}**（${grid.xLabels.length} × ${grid.yLabels.length} 个格子）。\n\n` +
        (flat.length ? `最高一格 **${formatNumber(max)}**（${grid.valueLabel ?? '数值'}）。` : '没有可绘制的数据。') +
        note +
        input.probeNote
      );
    }
    const series = chart?.series ?? [];
    const top = [...series].sort((a, b) => b.value - a.value).slice(0, 3);
    return (
      `图表已生成并显示在上方工具卡中：**${chart?.title ?? '分析图'}**。\n\n` +
      (top.length ? top.map((point) => `- ${point.label}: ${formatNumber(point.value)}`).join('\n') : '没有可绘制的数据。') +
      note +
      input.probeNote
    );
  }
  if (intent === 'analyze') {
    const d = input.result.data as {
      x: string; y: string; rowCount: number; sum: number; avg: number; min: number; max: number; argmin: string; argmax: string;
      topShare?: Array<{ label: string; value: number; share: number }>;
      deltas?: Array<{ label: string; delta: number; ratio: number | null }>;
    };
    const what = plan.measureLabel ? `**${plan.measureLabel}**` : '结果';
    const top = (d.topShare ?? []).map((s) => `- ${s.label}：${formatNumber(s.value)}（${(s.share * 100).toFixed(1)}%）`);
    const recent = (d.deltas ?? []).slice(-3).map((item) => `- ${item.label}：${item.delta >= 0 ? '+' : ''}${formatNumber(item.delta)}${item.ratio === null ? '' : `（${(item.ratio * 100).toFixed(1)}%）`}`);
    return (
      `${what}按 \`${plan.axisLabel ?? d.x}\` 统计：合计 **${formatNumber(d.sum)}**，均值 ${formatNumber(d.avg)}，最高 ${d.argmax}（${formatNumber(d.max)}），最低 ${d.argmin}（${formatNumber(d.min)}）。数字由 Bridge 计算，不是估算。\n\n` +
      (top.length ? `占比前 ${top.length}：\n${top.join('\n')}\n\n` : '') +
      (recent.length ? `最近环比：\n${recent.join('\n')}\n\n` : '') +
      `\`\`\`sql\n${sql}\n\`\`\`${input.probeNote}`
    );
  }
  return `${planConclusion(plan, input.result.data)}${input.probeNote}\n\n\`\`\`sql\n${sql}\n\`\`\``;
}

function formatNumber(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n.toLocaleString() : formatValue(value);
}

/** 解析不出来时定点追问，而不是把 help 清单甩回去。 */
function clarifier(intent: LocalIntent, question: string, tables: TableInfo[], grounding: GroundingOptions): string {
  const examples = {
    count: '「orders 有多少行」「上月已支付的订单有多少」',
    group: '「按 status 统计订单」「各城市上月的订单金额合计」',
    analyze: '「统计 orders 按月的金额合计并分析趋势」「各渠道的客单价」',
    chart: '「按 status 统计 orders 并画柱状图」「近 12 个月订单量趋势图」',
    default: '「看看 orders 表结构」「数据库体检」「按 status 统计订单」',
  } as Record<string, string>;
  const names = tableCandidates(question, tables, grounding, 8);
  return [
    `这个问法我还没把握直接执行，宁可问你一句也不想猜一个数字给你。`,
    ``,
    `可以说得更具体些，例如：${examples[intent] ?? examples.default}。`,
    names ? `\n当前可用的表：${names}。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value).replace(/\|/g, '\\|').slice(0, 120);
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderRows(data: unknown, maxRows = 10, labels?: string[]): string {
  const d = data as { columns?: Array<{ name: string } | string>; rows?: unknown[][] } | undefined;
  if (!d?.columns || !Array.isArray(d.rows)) return '';
  const names = d.columns.map((c, index) => labels?.[index] || (typeof c === 'string' ? c : c.name));
  const rows = d.rows.slice(0, maxRows);
  const header = `| ${names.join(' | ')} |`;
  const sep = `| ${names.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(formatValue).join(' | ')} |`).join('\n');
  const more = d.rows.length > maxRows ? `\n\n_仅展示前 ${maxRows} 行，共 ${d.rows.length} 行。_` : '';
  return `${header}\n${sep}\n${body}${more}`;
}

function errText(result: ToolResult): string {
  if (result.error?.code === 'APPROVAL_DENIED') {
    return '你拒绝了这次操作，我没有执行它。如果是有意为之，可以调整需求或切换到更高权限模式后重试。';
  }
  return `操作未完成：${result.error?.message ?? result.summary ?? '未知错误'}${result.error?.hint ? `\n\n提示：${result.error.hint}` : ''}`;
}

function buildInsertSql(engine: Engine, table: TableInfo, rows = 3): string {
  const cols = (table.columns ?? []).filter((c) => !c.autoIncrement && !/(created_at|updated_at)$/i.test(c.name));
  const q = quoteIdent(table.name, engine);
  if (!cols.length) {
    return engine === 'mysql' ? `INSERT INTO ${q} () VALUES ()` : `INSERT INTO ${q} DEFAULT VALUES`;
  }
  const values: string[] = [];
  for (let r = 1; r <= rows; r++) {
    const row = cols.map((c) => {
      const n = c.name.toLowerCase();
      const t = c.type.toLowerCase();
      if (/bool/.test(t)) return engine === 'postgresql' ? 'true' : '1';
      if (/int|serial/.test(t)) return String(10 + r);
      if (/decimal|numeric|real|double|float/.test(t)) return `${(r * 19.9).toFixed(2)}`;
      if (/timestamp|date/.test(t)) return 'CURRENT_TIMESTAMP';
      if (n === 'status' || n === 'state') return quoteLiteral('active');
      if (n === 'email' || n === 'mail') return quoteLiteral(`demo${r}@example.com`);
      if (n === 'phone' || n === 'mobile') return quoteLiteral(`1380000000${r}`);
      if (n === 'name' || n === 'title') return quoteLiteral(`示例数据 ${r}`);
      return quoteLiteral(`demo_${r}`);
    });
    values.push(`(${row.join(', ')})`);
  }
  return `INSERT INTO ${q} (${cols.map((c) => quoteIdent(c.name, engine)).join(', ')}) VALUES ${values.join(', ')}`;
}

export class LocalProvider implements LlmProvider {
  id = 'local';
  label = 'Local Reasoner (offline)';

  async *stream(req: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (signal?.aborted) return;
    const { prompt, outcomes, priorUser } = analyzeMessages(req.messages);
    const ctx = req.context ?? {};
    // 追问不带聚合动词：「那按城市呢」既不是统计也不是画图，但它接的是上一问那句话。
    // 没有这一层，离线模式收到「只看已退款的」只会甩 help 清单。
    const intent = followUpIntent(detectIntent(prompt), prompt, priorUser);
    // 术语词典先把简称展开成业务全称，「JS 的资产数」才对得上 sys_asset。
    const question = expandTerms(prompt, ctx.glossary);
    const tokensIn = estimateTokens(prompt + req.system);
    let out = '';

    const finish = async function* (text: string): AsyncGenerator<ProviderEvent> {
      if (text) {
        out += text;
        yield { type: 'text', text };
      }
      yield { type: 'usage', tokensIn, tokensOut: Math.max(8, Math.ceil(out.length / 4)) };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const callTool = async function* (call: ToolCall, preamble: string): AsyncGenerator<ProviderEvent> {
      if (preamble) {
        out += preamble;
        yield { type: 'text', text: preamble };
      }
      yield { type: 'tool_call', call };
      yield { type: 'usage', tokensIn, tokensOut: Math.max(8, Math.ceil(out.length / 4)) };
      yield { type: 'done', stopReason: 'tool_use' };
    };
    /**
     * 一次发多条只读查询。
     *
     * 合在一起发而不是逐个回合发，是因为 runtime 会把这一回合产出的调用全部执行完再回到这里：
     * 「先算总数再算合计」因此只需两次模型往返（发问、收数）而不是 2×N 次。
     */
    const callMany = async function* (calls: ToolCall[], preamble: string): AsyncGenerator<ProviderEvent> {
      if (preamble) {
        out += preamble;
        yield { type: 'text', text: preamble };
      }
      for (const call of calls) yield { type: 'tool_call', call };
      yield { type: 'usage', tokensIn, tokensOut: Math.max(8, Math.ceil(out.length / 4)) };
      yield { type: 'done', stopReason: 'tool_use' };
    };

    if (intent === 'help') {
      const tables = tablesFromContext(ctx, ctx.connection);
      const tableHint = tables.length ? `\n\n当前库可用表：${tables.slice(0, 12).map((t) => `\`${t.name}\``).join('、')}${tables.length > 12 ? ' 等' : ''}。` : '';
      yield* finish(
        `我是 AiDB 的本地离线助手。无需 API Key 即可完成这些操作：\n\n- 列出表 / 查看表结构与样例数据\n- 计数、分组统计、直接执行 SELECT\n- 创建表（含列定义）、建索引、删除表（需审批）\n- 生成示例数据、备份、导出 CSV/JSON\n- 解释执行计划、记住偏好与检索记忆\n\n直接说需求即可，例如：\n- “看看 orders 表结构”\n- “按 status 统计订单”\n- “创建表 tasks，包含 id 自增主键, title 文本, done 布尔, created_at 时间”\n- “记住：订单金额单位是分”${tableHint}\n\n> 本地模式只覆盖规则明确的指令；配置 Claude / OpenAI 兼容模型可获得完整推理能力。`,
      );
      return;
    }

    // Resolve a connection for database-related intents.
    const needsConnection = !['memory_write', 'memory_search'].includes(intent);
    let conn: ConnectionConfig | undefined = ctx.connection;
    if (needsConnection && !conn) {
      const listOutcome = getOutcome(outcomes, 'list_connections');
      if (!listOutcome) {
        yield { type: 'thinking', text: `本地模式：识别为 ${intent}，先获取连接列表` };
        yield* callTool(mkCall('list_connections', { includeOffline: true }), '我先看一下已配置的数据库连接。');
        return;
      }
      const conns = extractConnections(listOutcome);
      if (!conns.length) {
        yield* finish('还没有配置数据库连接。请先在左侧新建一个连接（或使用内置 Demo 数据库），然后我们再继续。');
        return;
      }
      conn = pickConnection(prompt, conns);
    }

    const engine: Engine = conn?.engine ?? 'sqlite';
    const database = conn?.database;
    const connectionId = conn?.id ?? '';
    const inspectOutcome = getOutcome(outcomes, 'inspect_schema');

    // Memory intents do not need schema.
    if (intent === 'memory_write') {
      const action = getOutcome(outcomes, 'memory_write');
      if (action) {
        yield* finish(action.result.ok ? `已记住：${action.result.summary.replace(/^已记住[:：]?\s*/, '')}\n\n后续会话中我会在相关话题下自动召回它。` : errText(action.result));
        return;
      }
      const content = prompt.replace(/^.*?(?:请?记住|记一下|remember)[:：,，\s]*/i, '').trim() || prompt;
      const kind = /(偏好|喜欢|习惯|以后都|默认)/.test(content) ? 'preference' : 'fact';
      const title = content.length > 28 ? `${content.slice(0, 28)}…` : content;
      yield* callTool(
        mkCall('memory_write', {
          kind,
          title,
          content,
          scopeType: conn ? 'connection' : 'global',
          scopeKey: conn?.id ?? '*',
          importance: kind === 'preference' ? 0.75 : 0.65,
        }),
        '我把这条信息写入长期记忆。',
      );
      return;
    }

    if (intent === 'memory_search') {
      const action = getOutcome(outcomes, 'memory_search');
      if (action) {
        const data = action.result.data as { memories?: Array<{ title: string; content: string; kind: string }> } | undefined;
        const mems = data?.memories ?? [];
        if (!mems.length) yield* finish('没有检索到相关记忆。可以明确说“记住：…”来添加一条。');
        else yield* finish(`检索到 ${mems.length} 条相关记忆：\n\n${mems.map((m) => `- **${m.title}**（${m.kind}）— ${m.content}`).join('\n')}`);
        return;
      }
      const query = prompt.replace(/(记忆|回忆|还记得|之前|memory|search|检索|查找)/gi, ' ').trim() || prompt;
      yield* callTool(mkCall('memory_search', { query, limit: 8 }), '我在长期记忆里检索一下。');
      return;
    }

    let allTables = tablesFromContext(ctx, conn);
    if (inspectOutcome) {
      const fromInspect = tablesFromInspect(inspectOutcome);
      if (fromInspect.length) allTables = fromInspect;
    }
    const grounding = groundingOf(ctx, database);
    // 用户禁用的表对离线推理器同样不可见，否则「表管理」在本地模式下形同虚设。
    // 必须在两个来源合并之后过滤：inspect_schema 的返回里带着完整表清单。
    const tables = groundedTables(allTables, grounding);

    // Fresh schema for listing / describe so the trace shows a real tool call.
    if (!inspectOutcome && ['list_tables', 'describe'].includes(intent)) {
      yield { type: 'thinking', text: '本地模式：读取当前库的表结构' };
      yield* callTool(mkCall('inspect_schema', { connectionId, database }), '我先读取当前库的表结构。');
      return;
    }

    if (!tables.length && !['create', 'backup', 'memory_write'].includes(intent) && intent !== 'raw_sql') {
      if (!inspectOutcome) {
        yield* callTool(mkCall('inspect_schema', { connectionId, database }), '我先读取表结构，确认可用对象。');
        return;
      }
      if (allTables.length) {
        yield* finish(`当前库的 ${allTables.length} 张表都被「Agent 上下文」设置隐藏了，我看不到任何可用对象。请到 工具箱 → Agent 上下文 启用需要的表。`);
        return;
      }
      if (intent === 'list_tables') {
        yield* finish('当前库没有表。可以让我创建一个，例如：“创建表 tasks，包含 id 自增主键, title 文本”。');
        return;
      }
    }

    const table = matchTable(question, allTables, grounding);
    const hiddenTable = table ? undefined : hiddenTableMention(question, allTables, grounding);
    if (hiddenTable) {
      yield* finish(`\`${hiddenTable.name}\` 被「Agent 上下文」设置隐藏了，我不会绕过它去查别的表。请到 工具箱 → Agent 上下文 启用这张表，或换一张已启用的表提问。`);
      return;
    }

    // 反例是硬约束，不是建议：云端有模型兜底，离线只有真的不查才算生效。
    // 走规划器的那几条路径由 planQuery 自己拦；这里补的是预测/高级图——它们出的是同一个口径的数字，
    // 只是绕开了规划器。看结构、备份这类库操作不算「用错口径」，不该被业务反例挡住。
    const forbidden = forbiddenFromGlossary(ctx.glossary, allTables, grounding);
    if (PLANNED_INTENTS.includes(intent) && !usePlanner(intent, prompt, engine) && table) {
      const blockedTable = forbiddenTableReason(forbidden, table.name);
      if (blockedTable) {
        yield* finish(`按你登记的业务口径，我不该用 \`${table.name}\` 回答这个问题。\n\n> ${blockedTable}\n\n要我换一张表直接说名字；这条反例本身可以在 工具箱 → Agent 上下文 → 术语与示例 里改。`);
        return;
      }
    }

    if (intent === 'list_tables') {
      if (!tables.length) {
        yield* finish('当前库没有表。可以让我创建一个，例如：“创建表 tasks，包含 id 自增主键, title 文本”。');
        return;
      }
      const list = tables
        .slice(0, 40)
        .map((t) => {
          const alias = ctx.agentContext?.tableMeta[t.name.toLowerCase()]?.alias?.trim();
          const columns = groundedColumns(t, grounding).length;
          return `- \`${t.name}\`${alias ? `（${alias}）` : ''}${t.type === 'view' ? '（视图）' : ''}${columns ? ` · ${columns} 列` : ''}${t.rowEstimate !== undefined ? ` · ~${t.rowEstimate} 行` : ''}`;
        })
        .join('\n');
      yield* finish(`当前库（${database ?? conn?.name ?? ''}）共有 **${tables.length}** 张表：\n\n${list}${tables.length > 40 ? '\n- …（其余省略）' : ''}\n\n需要看哪张表的结构或数据，直接说表名即可。`);
      return;
    }

    if (intent === 'describe') {
      if (!table) {
        const names = tableCandidates(question, tables, grounding);
        yield* finish(`请指定要查看的表名。当前可用：${names || '（无）'}。`);
        return;
      }
      const columns = groundedColumns(table, grounding);
      const hidden = (table.columns?.length ?? 0) - columns.length;
      const meta = ctx.agentContext?.columnMeta[table.name.toLowerCase()] ?? {};
      const cols = columns
        .map((c) => {
          const label = meta[c.name]?.alias?.trim() || meta[c.name.toLowerCase()]?.alias?.trim() || c.comment?.trim() || '';
          return `| \`${c.name}\` | ${label} | ${c.type} | ${c.primaryKey ? 'PK' : ''} | ${c.nullable ? 'YES' : 'NO'} | ${c.defaultValue ?? ''} |`;
        })
        .join('\n');
      const idx = (table.indexes ?? []).map((i) => `- ${i.name}（${i.unique ? 'UNIQUE ' : ''}${i.columns.join(', ')}）`).join('\n');
      const fks = (table.foreignKeys ?? []).map((f) => `- ${f.columns.join(',')} → ${f.refTable}(${f.refColumns.join(',')})`).join('\n');
      const alias = ctx.agentContext?.tableMeta[table.name.toLowerCase()]?.alias?.trim();
      const note = ctx.agentContext?.tableMeta[table.name.toLowerCase()]?.description?.trim() || table.comment;
      yield* finish(
        `**${table.name}**${alias ? `（${alias}）` : ''}${note ? ` — ${note}` : ''}\n\n| 列 | 业务名 | 类型 | 键 | 可空 | 默认值 |\n| --- | --- | --- | --- | --- | --- |\n${cols || '| （未读取到列） |  |  |  |  |  |'}` +
          `${hidden > 0 ? `\n\n_另有 ${hidden} 列被「Agent 上下文」设置隐藏。_` : ''}` +
          `${idx ? `\n\n**索引**\n${idx}` : ''}${fks ? `\n\n**外键**\n${fks}` : ''}`,
      );
      return;
    }

    if (intent === 'create') {
      const action = getOutcome(outcomes, 'create_table');
      if (action) {
        if (!action.result.ok) {
          yield* finish(errText(action.result));
          return;
        }
        const data = action.result.data as { ddl?: string } | undefined;
        const specAgain = parseCreateSpec(prompt, engine);
        const createdName = 'table' in specAgain ? specAgain.table : '新表';
        yield* finish(`已创建表 **${createdName}**。${action.result.summary}${data?.ddl ? `\n\n\`\`\`sql\n${data.ddl}\n\`\`\`` : ''}\n\n接下来可以让我插入示例数据或查询它。`);
        return;
      }
      const spec = parseCreateSpec(prompt, engine);
      if (!('table' in spec)) {
        yield* finish(spec.error);
        return;
      }
      const colText = spec.columns.map((c) => `\`${c.name} ${c.type}\`${c.primaryKey ? ' PK' : ''}${c.autoIncrement ? ' 自增' : ''}`).join('、');
      yield* callTool(
        mkCall('create_table', { connectionId, database, table: spec.table, columns: spec.columns, indexes: spec.indexes }),
        `我准备创建表 \`${spec.table}\`，共 ${spec.columns.length} 列：${colText}。${engine === 'sqlite' ? '' : ''}`,
      );
      return;
    }

    if (intent === 'raw_sql') {
      const sql = stripCodeFence(prompt);
      const action = getOutcome(outcomes, 'run_sql');
      if (action) {
        if (!action.result.ok) yield* finish(errText(action.result));
        else {
          const data = action.result.data as { affected?: number; rowCount?: number } | undefined;
          const rows = renderRows(action.result.data);
          yield* finish(`执行完成。${action.result.summary}${rows ? `\n\n${rows}` : data?.affected !== undefined ? `\n\n影响 ${data.affected} 行。` : ''}`);
        }
        return;
      }
      yield* callTool(mkCall('run_sql', { connectionId, database, sql, maxRows: 200 }), '我直接执行这段 SQL。');
      return;
    }

    if (intent === 'audit') {
      const action = getOutcome(outcomes, 'audit_database');
      if (action) {
        if (!action.result.ok) {
          yield* finish(errText(action.result));
          return;
        }
        const data = action.result.data as {
          findings?: Array<{ severity: string; title: string; table?: string; detail: string; suggestedSql?: string }>;
          summary?: { tablesChecked: number; high: number; medium: number; low: number; info: number };
        };
        const findings = data.findings ?? [];
        if (!findings.length) {
          yield* finish(`体检完成：共检查 ${data.summary?.tablesChecked ?? 0} 张表，没有发现结构性问题。`);
          return;
        }
        const top = findings
          .slice(0, 6)
          .map((f, i) => `${i + 1}. ${f.severity.toUpperCase()} · ${f.table ? '`' + f.table + '` · ' : ''}${f.title} — ${f.detail}`)
          .join('\n');
        const sql = findings.find((f) => f.suggestedSql)?.suggestedSql;
        yield* finish(
          `体检完成：${data.summary?.tablesChecked ?? 0} 张表，${data.summary?.high ?? 0} 高 / ${data.summary?.medium ?? 0} 中 / ${data.summary?.low ?? 0} 低风险。\n\n${top}` +
            (sql ? `\n\n首个建议修复：\n\n\`\`\`sql\n${sql}\n\`\`\`` : ''),
        );
        return;
      }
      yield* callTool(
        mkCall('audit_database', { connectionId, database }),
        '我开始做数据库体检：检查主键、外键索引、重复索引与空表，并给出可执行的修复 SQL。',
      );
      return;
    }

    // 追问不点名表也不含统计动词（「那按城市呢」）：意图、表、口径都来自上一问。
    // 焦点只给规划器路径用——非 SQL 引擎走不到 planQuery，那里连方言都没有。
    const isFollowUpTurn = !table || isFollowUp(prompt);
    const planned = usePlanner(intent, prompt, engine);
    const focus = planned && isFollowUpTurn ? focusOf({ priorUser, engine, tables: allTables, grounding, forbidden }) : undefined;

    // 「先算订单总数，再算金额合计」：一句话里的几个问题各规划一次，一次全部发出。
    const compound = isSqlEngine(engine) && !focus ? compoundSteps({ question, engine, tables: allTables, grounding, forbidden, outcomes, connectionId, database, bundle: ctx.agentContext }) : [];
    if (compound.length > 1) {
      const pending = compound.filter((step) => !step.done);
      const gaps = compound.filter((step) => step.gap);
      if (pending.length) {
        yield { type: 'plan', items: compound.map((step, index) => ({ id: `s${index + 1}`, text: step.text, status: step.done ? ('done' as const) : step.gap ? ('todo' as const) : ('doing' as const) })) };
        if (pending.some((step) => step.probe)) {
          const probe = pending.find((step) => step.probe)!.probe!;
          yield { type: 'thinking', text: `本地模式：先确认 \`${probe.table}.${probe.column}\` 的实际取值` };
          yield* callTool(
            mkCall('profile_column', { connectionId, database, table: probe.table, column: probe.column }),
            `「${probe.raw}」我还没在这张表里见过对应的取值，先读一次 \`${probe.column}\` 最常见的几个值（只读），再把这几问一起统计。`,
          );
          return;
        }
        yield* callMany(
          pending.filter((step) => step.call).map((step) => step.call!),
          `这句话里有 ${compound.length} 个问题，我按顺序逐个查（每问一条只读查询）。`,
        );
        return;
      }
      const answers = compound.map((step, index) => {
        if (step.gap) return `${index + 1}. ${step.text} — ${step.gap}`;
        return `${index + 1}. ${step.text}\n\n${step.answer!}`;
      });
      yield { type: 'plan', items: compound.map((step, index) => ({ id: `s${index + 1}`, text: step.text, status: gaps.length && !step.answer ? ('todo' as const) : ('done' as const) })) };
      yield* finish(answers.join('\n\n') + (gaps.length ? `\n\n> ${gaps.length} 问没有查成：口径没说明白的我宁可问，也不猜一个看起来合理的数字。` : ''));
      return;
    }

    // Remaining intents need a table.
    if (!table && !focus && ['sample', 'count', 'group', 'index', 'insert', 'drop', 'export', 'quality', 'chart'].includes(intent)) {
      const names = tableCandidates(question, tables, grounding);
      yield* finish(`请指定表名。当前可用：${names || '（无表）'}。`);
      return;
    }

    // 这几条路径在本地拼 SQL：非 SQL 引擎（Mongo/Redis/图/向量…）连方言都没有，
    // 交给原生 run_* 工具之前先把话说清楚，别抛「不使用 SQL 方言」这种内部错误。
    const SQL_BUILT_INTENTS = ['count', 'group', 'analyze', 'chart'];
    if (!isSqlEngine(engine) && SQL_BUILT_INTENTS.includes(intent)) {
      yield* finish(`\`${engine}\` 不走 SQL，本地模式还没有为它准备原生查询模板。可以让我列出集合/键（“有哪些表”）、看结构（“xxx 表结构”），或者配置模型后用原生查询语言执行。`);
      return;
    }

    if (planned) {
      // 用户登记过标准问答 SQL 时口径以它为准：同一句话在离线与在线模式下必须给出同一个数字。
      // 追问是在改上一问的口径，不是重新问了一遍标准问题：这时套示例 SQL 会把用户刚改的条件冲掉。
      const example = focus ? undefined : matchSqlExample(question, allTables, grounding, forbidden);
      if (example) {
        const toolName = intent === 'count' || intent === 'group' ? 'run_sql' : intent === 'chart' ? 'render_chart' : 'analyze_chart';
        const action = getOutcome(outcomes, toolName);
        if (action) {
          // 发起调用那句话已经说过口径来自哪里，收尾不再重复一遍。
          yield* finish(`${exampleAnswer(intent, action)}\n\n\`\`\`sql\n${example.sql}\n\`\`\``);
          return;
        }
        const args: Record<string, unknown> = { connectionId, database, sql: example.sql };
        if (toolName === 'run_sql') args.maxRows = 200;
        if (toolName === 'render_chart') args.type = /(饼|占比|pie)/i.test(prompt) ? 'pie' : /(折线|趋势|line)/i.test(prompt) ? 'line' : 'bar';
        yield* callTool(mkCall(toolName, args), `${examplePreamble(example.title)}列名与聚合都沿用这条 SQL，我不另拼口径。`);
        return;
      }

      const plan = planOf({ question, engine, tables: allTables, grounding, outcomes, forbidden, focus });
      if (plan.status === 'gap') {
        yield* finish(plan.gap ?? clarifier(intent, question, tables, grounding));
        return;
      }
      if (plan.status === 'probe' && plan.probe) {
        yield { type: 'thinking', text: `本地模式：先确认 \`${plan.probe.table}.${plan.probe.column}\` 的实际取值` };
        yield* callTool(
          mkCall('profile_column', { connectionId, database, table: plan.probe.table, column: plan.probe.column }),
          `「${plan.probe.raw}」我还没在这张表里见过对应的取值，先读一次 \`${plan.probe.column}\` 最常见的几个值（只读），再按真实取值统计。`,
        );
        return;
      }

      const preamble = planPreamble(intent, plan, plan.spec!.table, plan.axisLabel);
      const probeNote = plan.dropped?.length ? `\n\n> ${plan.dropped.join('；')}。` : '';
      const toolName = intent === 'chart' ? 'render_chart' : intent === 'analyze' ? 'analyze_chart' : 'run_sql';
      const action = getOutcome(outcomes, toolName);
      if (action) {
        // 结果已经在上下文里（图表卡或 Bridge 统计量），照旧念数字；缺数值列的图早就发不出调用，这里不会空转。
        yield* finish(planStepAnswer({ intent, plan, result: action.result, probeNote }));
        return;
      }
      const step = planStepCall({ intent, plan, prompt, connectionId, database, bundle: ctx.agentContext, titleTable: table });
      if (!step) {
        yield* finish(clarifier(intent, question, tables, grounding));
        return;
      }
      yield* callTool(mkCall(step.tool, step.args), preamble);
      return;
    }

    if (intent === 'sample' || intent === 'count' || intent === 'group' || intent === 'insert' || intent === 'explain') {
      const toolName = intent === 'sample' ? 'sample_rows' : intent === 'explain' ? 'explain_sql' : intent === 'insert' ? 'generate_data' : 'run_sql';
      const action = getOutcome(outcomes, toolName);
      if (action) {
        if (!action.result.ok) {
          yield* finish(errText(action.result));
          return;
        }
        if (intent === 'sample') {
          yield* finish(`\`${table!.name}\` 的样例数据：\n\n${renderRows(action.result.data, 8) || '（没有行）'}`);
        } else if (intent === 'count') {
          const d = action.result.data as { rows?: unknown[][] } | undefined;
          yield* finish(`\`${table!.name}\` 共 **${d?.rows?.[0]?.[0] ?? '?'}** 行。`);
        } else if (intent === 'group') {
          yield* finish(`分组统计结果：\n\n${renderRows(action.result.data, 12)}`);
        } else if (intent === 'explain') {
          const d = action.result.data as { plan?: unknown } | undefined;
          yield* finish(`执行计划（${engine}）：\n\n\`\`\`json\n${JSON.stringify(d?.plan ?? action.result.data, null, 2).slice(0, 3000)}\n\`\`\`\n\n建议关注全表扫描、临时表与缺失索引；需要我添加索引可以直接说。`);
        } else {
          yield* finish(`已插入示例数据。${action.result.summary}${table ? `\n\n可以继续问：“看看 ${table.name} 的数据”。` : ''}`);
        }
        return;
      }

      if (!table) {
        yield* finish('没有找到目标表，请确认表名。');
        return;
      }
      if (intent === 'sample') {
        yield* callTool(mkCall('sample_rows', { connectionId, database, table: table.name, limit: 8 }), `我读取 \`${table.name}\` 的少量样例数据。`);
        return;
      }
      if (intent === 'count') {
        yield* callTool(mkCall('run_sql', { connectionId, database, sql: buildCount(engine, table.name), maxRows: 1 }), `我统计 \`${table.name}\` 的行数。`);
        return;
      }
      if (intent === 'insert') {
        yield* callTool(
          mkCall('generate_data', { connectionId, database, table: table.name, rows: 5 }),
          `我会向 \`${table.name}\` 生成 5 行贴近业务的示例数据（写入操作需要授权）。`,
        );
        return;
      }
      // group
      const col = groupColumnOf(question, table, grounding)?.name;
      if (!col) {
        yield* finish(`\`${table.name}\` 没有可用分组列。请指定列名，例如：“按 status 分组统计”。`);
        return;
      }
      const sql = `SELECT ${quoteIdent(col, engine)}, COUNT(*) AS ${quoteIdent('count', engine)} FROM ${quoteIdent(table.name, engine)} GROUP BY ${quoteIdent(col, engine)} ORDER BY ${quoteIdent('count', engine)} DESC LIMIT 20`;
      yield* callTool(mkCall('run_sql', { connectionId, database, sql, maxRows: 20 }), `我按 \`${col}\` 对 \`${table.name}\` 分组统计。`);
      return;
    }

    if (intent === 'quality') {
      const action = getOutcome(outcomes, 'check_data_quality');
      if (action) {
        if (!action.result.ok) {
          yield* finish(errText(action.result));
          return;
        }
        const data = action.result.data as {
          table?: string;
          total?: number;
          findings?: Array<{ severity: string; title: string; detail: string; suggestedSql?: string }>;
          columnStats?: Array<{ name: string; nullRatio: number; nulls: number; distinct: number }>;
        };
        const findings = data.findings ?? [];
        if (!findings.length) {
          yield* finish(`数据质量检查完成：\`${data.table}\` 共 ${(data.total ?? 0).toLocaleString()} 行，没有发现空值、空串或重复主键。`);
          return;
        }
        const top = findings
          .slice(0, 6)
          .map((f, i) => `${i + 1}. ${f.severity.toUpperCase()} · ${f.title} — ${f.detail}`)
          .join('\n');
        const sql = findings.find((f) => f.suggestedSql)?.suggestedSql;
        yield* finish(
          `数据质量检查完成：\`${data.table}\` 共 ${(data.total ?? 0).toLocaleString()} 行，发现 ${findings.length} 项问题。\n\n${top}` +
            (sql ? `\n\n示例排查 SQL：\n\n\`\`\`sql\n${sql}\n\`\`\`` : ''),
        );
        return;
      }
      yield* callTool(
        mkCall('check_data_quality', { connectionId, database, table: table!.name }),
        `我检查 \`${table!.name}\` 的空值率、空字符串、区分度与重复主键。`,
      );
      return;
    }

    if (intent === 'analyze') {
      const wantForecast = /(预测|forecast|外推|未来)/.test(prompt);
      const toolName = wantForecast ? 'forecast_chart' : 'analyze_chart';
      const action = getOutcome(outcomes, toolName);
      if (action) {
        if (!action.result.ok) {
          yield* finish(errText(action.result));
          return;
        }
        if (wantForecast) {
          const d = action.result.data as { method?: string; note?: string; forecast?: Array<{ label: string; value: number; lower: number; upper: number }> };
          const lines = (d.forecast ?? []).map((p) => `- ${p.label}：**${p.value.toLocaleString()}**（区间 ${p.lower.toLocaleString()} ~ ${p.upper.toLocaleString()}）`);
          yield* finish(`按**${d.method === 'linear' ? '线性回归' : '移动平均'}**外推：\n\n${lines.join('\n') || '（没有可外推的数据）'}\n\n> ${d.note ?? ''}`);
          return;
        }
        const d = action.result.data as {
          x: string; y: string; rowCount: number; sum: number; avg: number; min: number; max: number; argmin: string; argmax: string;
          topShare?: Array<{ label: string; value: number; share: number }>;
          deltas?: Array<{ label: string; delta: number; ratio: number | null }>;
        };
        const top = (d.topShare ?? []).map((s) => `- ${s.label}：${s.value.toLocaleString()}（${(s.share * 100).toFixed(1)}%）`);
        const recent = (d.deltas ?? []).slice(-3).map((item) => `- ${item.label}：${item.delta >= 0 ? '+' : ''}${item.delta.toLocaleString()}${item.ratio === null ? '' : `（${(item.ratio * 100).toFixed(1)}%）`}`);
        yield* finish(
          `\`${d.y}\` 按 \`${d.x}\` 的统计（${d.rowCount} 组，数字由 Bridge 计算，不是估算）：\n\n` +
            `- 合计 **${d.sum.toLocaleString()}**，均值 ${d.avg.toLocaleString()}\n` +
            `- 最大 ${d.argmax} = ${d.max.toLocaleString()}，最小 ${d.argmin} = ${d.min.toLocaleString()}` +
            (top.length ? `\n\n占比前 ${top.length}：\n${top.join('\n')}` : '') +
            (recent.length ? `\n\n最近环比：\n${recent.join('\n')}` : ''),
        );
        return;
      }
      if (!table) {
        yield* finish('请指定要分析的表，例如：“统计 orders 的金额合计与占比”。');
        return;
      }
      const q = (name: string) => quoteIdent(name, engine);
      let sql: string;
      let xField: string;
      if (wantForecast) {
        const timeColumn = pickTimeColumn(table, question, grounding);
        if (!timeColumn) {
          yield* finish(`\`${table.name}\` 没有时间列，无法做趋势预测。请换一张带时间字段的表。`);
          return;
        }
        const expr = buildMonthlySeriesExpr(engine, timeColumn.name);
        sql = `SELECT ${expr} AS ${q('period')}, COUNT(*) AS ${q('value')} FROM ${q(table.name)} GROUP BY ${expr} ORDER BY ${q('period')} LIMIT 24`;
        xField = 'period';
      } else {
        const groupColumn = groupColumnOf(question, table, grounding)?.name;
        if (!groupColumn) {
          yield* finish(`\`${table.name}\` 没有适合分组的列，请指定列名。`);
          return;
        }
        const metric = pickMeasure(table, question, grounding);
        sql = `SELECT ${q(groupColumn)} AS ${q('label')}, ${metric ? `SUM(${q(metric.name)})` : 'COUNT(*)'} AS ${q('value')} FROM ${q(table.name)} GROUP BY ${q(groupColumn)} ORDER BY ${q('value')} DESC LIMIT 50`;
        xField = 'label';
      }
      yield* callTool(
        mkCall(toolName, { connectionId, database, sql, x: xField, y: 'value', ...(wantForecast ? { periods: 3 } : {}) }),
        wantForecast ? `我对 \`${table.name}\` 的月度序列做确定性外推（不调模型算数）。` : `我在 Bridge 侧算好 \`${table.name}\` 的统计量，避免自己估算数字。`,
      );
      return;
    }

    if (intent === 'chart') {
      const action = getOutcome(outcomes, 'render_chart');
      if (action) {
        if (!action.result.ok) {
          yield* finish(errText(action.result));
          return;
        }
        const data = action.result.data as { chart?: { title?: string; series?: Array<{ label: string; value: number }> } } | undefined;
        const series = data?.chart?.series ?? [];
        const top = [...series].sort((a, b) => b.value - a.value).slice(0, 3);
        yield* finish(
          `图表已生成并显示在上方工具卡中：**${data?.chart?.title ?? '分析图'}**。\n\n` +
            (top.length ? top.map((point) => `- ${point.label}: ${point.value.toLocaleString()}`).join('\n') : '没有可绘制的数据。'),
        );
        return;
      }
      if (!table) {
        yield* finish('请指定要分析的表，例如：“按 status 统计 orders 并画柱状图”。');
        return;
      }
      const q = (name: string) => quoteIdent(name, engine);
      const numerics = numericColumns(table, grounding);
      if (/(散点|相关|scatter|correlation)/i.test(prompt) && numerics.length < 2) {
        yield* finish(`\`${table.name}\` 需要至少两个数值列才能画散点图（当前：${numerics.map((c) => c.name).join('、') || '无'}）。`);
        return;
      }
      if (/(散点|相关|scatter|correlation)/i.test(prompt) && numerics.length >= 2) {
        const mentioned = numerics.filter((c) => prompt.toLowerCase().includes(c.name.toLowerCase()));
        const xColumn = mentioned[0] ?? numerics[0];
        const yColumn = mentioned[1] ?? numerics.find((c) => c.name !== xColumn.name)!;
        yield* callTool(
          mkCall('render_chart', {
            connectionId,
            database,
            sql: `SELECT ${q(xColumn.name)} AS ${q('x')}, ${q(yColumn.name)} AS ${q('y')} FROM ${q(table.name)} LIMIT 200`,
            type: 'scatter',
            title: `${yColumn.name} vs ${xColumn.name}`,
            x: 'x',
            y: 'y',
          }),
          `我把 \`${xColumn.name}\` 和 \`${yColumn.name}\` 的原始数值画成散点图，观察相关性（不先聚合）。`,
        );
        return;
      }
      const type: 'bar' | 'line' | 'pie' = /(折线|趋势|line)/.test(prompt) ? 'line' : /(饼|占比|pie)/.test(prompt) ? 'pie' : 'bar';
      let sql: string;
      let xField: string;
      let chartTitle: string;
      const timeColumn = pickTimeColumn(table, question, grounding);
      const groupCol = groupColumnOf(question, table, grounding) ?? groundedColumns(table, grounding).find((c) => !c.primaryKey);
      const groupColumn = groupCol?.name;
      if (type === 'line' && timeColumn) {
        const expr = buildMonthlySeriesExpr(engine, timeColumn.name);
        sql = `SELECT ${expr} AS ${q('period')}, COUNT(*) AS ${q('value')} FROM ${q(table.name)} GROUP BY ${expr} ORDER BY ${q('period')} LIMIT 24`;
        xField = 'period';
        chartTitle = `${tableLabel(ctx.agentContext, table)} 月度趋势`;
      } else if (groupColumn) {
        const metric = /(金额|gmv|销售|收入|amount|total|price)/i.test(prompt) ? pickMeasure(table, question, grounding) : undefined;
        const aggregate = metric ? `SUM(${q(metric.name)})` : 'COUNT(*)';
        sql = `SELECT ${q(groupColumn)} AS ${q('label')}, ${aggregate} AS ${q('value')} FROM ${q(table.name)} GROUP BY ${q(groupColumn)} ORDER BY ${q('value')} DESC LIMIT 16`;
        xField = 'label';
        chartTitle = `${tableLabel(ctx.agentContext, table)} · ${groupCol ? columnLabel(ctx.agentContext, table, groupCol) : groupColumn} 分布`;
      } else {
        yield* finish(`\`${table.name}\` 没有适合分组的列，请指定列名或提供 SQL。`);
        return;
      }
      yield* callTool(
        mkCall('render_chart', {
          connectionId,
          database,
          sql,
          type,
          title: chartTitle,
          x: xField,
          y: 'value',
        }),
        `我按 \`${xField}\` 汇总 \`${table.name}\` 并渲染${type === 'line' ? '折线' : type === 'pie' ? '饼' : '柱状'}图。`,
      );
      return;
    }

    if (intent === 'index') {
      const action = getOutcome(outcomes, 'manage_index');
      if (action) {
        yield* finish(action.result.ok ? `索引操作完成。${action.result.summary}` : errText(action.result));
        return;
      }
      if (!table) {
        yield* finish('请指定要建索引的表。');
        return;
      }
      if (/(删除|移除|drop)/.test(prompt.toLowerCase()) && /(索引|index)/.test(prompt.toLowerCase())) {
        const idxName = (table.indexes ?? []).map((i) => i.name).find((n) => prompt.toLowerCase().includes(n.toLowerCase()));
        if (!idxName) {
          yield* finish(`请指定要删除的索引名。\`${table.name}\` 现有索引：${(table.indexes ?? []).map((i) => i.name).join('、') || '（无）'}。`);
          return;
        }
        yield* callTool(mkCall('manage_index', { connectionId, database, table: table.name, action: 'drop', name: idxName }), `我删除索引 \`${idxName}\`。`);
        return;
      }
      const col = matchColumn(question, table, grounding)?.name ?? groundedColumns(table, grounding).find((c) => !c.primaryKey)?.name;
      if (!col) {
        yield* finish(`请指定要建索引的列。\`${table.name}\` 可用列：${groundedColumns(table, grounding).map((c) => `\`${c.name}\``).join('、') || '（无）'}。`);
        return;
      }
      const unique = /(唯一|unique)/.test(prompt);
      const index: IndexDef = { name: defaultIndexName(table.name, [col], unique), columns: [col], unique };
      yield* callTool(mkCall('manage_index', { connectionId, database, table: table.name, action: 'create', index }), `我将在 \`${table.name}.${col}\` 上创建${unique ? '唯一' : ''}索引。`);
      return;
    }

    if (intent === 'drop') {
      const action = getOutcome(outcomes, 'drop_object');
      if (action) {
        yield* finish(action.result.ok ? `已删除。${action.result.summary}` : errText(action.result));
        return;
      }
      if (!table) {
        yield* finish('请指定要删除的表名。删除是危险操作，会先请求确认。');
        return;
      }
      yield* callTool(mkCall('drop_object', { connectionId, database, kind: 'table', name: table.name }), `⚠️ 我将删除表 \`${table.name}\`，这会永久移除数据。将先进行备份并请求你的确认。`);
      return;
    }

    if (intent === 'backup') {
      const action = getOutcome(outcomes, 'backup_database');
      if (action) {
        const data = action.result.data as { path?: string } | undefined;
        yield* finish(action.result.ok ? `备份完成。${action.result.summary}${data?.path ? `\n\n文件：\`${data.path}\`` : ''}` : errText(action.result));
        return;
      }
      yield* callTool(mkCall('backup_database', { connectionId, database }), '我正在为数据库创建逻辑备份。');
      return;
    }

    if (intent === 'export') {
      const action = getOutcome(outcomes, 'export_result');
      if (action) {
        const data = action.result.data as { path?: string; bytes?: number; rows?: number } | undefined;
        yield* finish(action.result.ok ? `导出完成。${action.result.summary}${data?.path ? `\n\n文件：\`${data.path}\`（${data.rows ?? '?'} 行）` : ''}` : errText(action.result));
        return;
      }
      const format = /json/i.test(prompt) ? 'json' : /sql/i.test(prompt) ? 'sql' : 'csv';
      yield* callTool(
        mkCall('export_result', { connectionId, database, table: table?.name, format, limit: 5000 }),
        `我导出${table ? ` \`${table.name}\`` : '查询结果'}为 ${format.toUpperCase()}。`,
      );
      return;
    }

    yield* finish('我还不能完全理解这个请求。可以换成：数据库体检、数据质量检查、画图分析、查看表结构、统计行数、创建表、备份，或直接贴 SQL。');
  }
}
