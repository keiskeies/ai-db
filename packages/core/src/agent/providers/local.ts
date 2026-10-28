import type { ColumnDef, IndexDef } from '../../sql/ddl';
import { buildCount, buildMonthlySeriesExpr, buildSelectTable, defaultIndexName } from '../../sql/ddl';
import { quoteIdent, quoteLiteral } from '../../sql/ident';
import type { ConnectionConfig, DatabaseSchema, Engine, TableInfo } from '../../types';
import { applyTableVisibility, expandTerms, findTableByAlias } from '../context';
import { estimateTokens } from '../prompt';
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
}

interface Analysis {
  prompt: string;
  outcomes: ToolOutcome[];
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
  if (/(合计|总和|求和|平均值|均值|环比|占比多少|最大.*最小|\bsum\b|\bavg\b)/.test(p)) return 'analyze';
  if (/(画图|图表|可视化|趋势|折线|柱状|饼图|chart|plot)/.test(p)) return 'chart';
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
  const outcomes: ToolOutcome[] = [];
  for (let i = userIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    try {
      outcomes.push({ name: m.name, result: JSON.parse(m.content) as ToolResult });
    } catch {
      /* ignore malformed */
    }
  }
  return { prompt, outcomes };
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findTable(prompt: string, tables: TableInfo[], ctx?: AgentContextData): TableInfo | undefined {
  // 先用术语词典展开简称，让「JS 的资产数」也能对上 sys_asset
  const expanded = expandTerms(prompt, ctx?.glossary).toLowerCase();
  const byName = tables
    .filter((t) => new RegExp(`(^|[^a-z0-9_])${escapeRegex(t.name.toLowerCase())}([^a-z0-9_]|$)`).test(expanded))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (byName) return byName;
  const byAlias = findTableByAlias(expanded, tables, ctx?.agentContext);
  if (byAlias) {
    const found = tables.find((t) => t.name === byAlias);
    if (found) return found;
  }
  const m = prompt.match(/(?:表|table)\s*[`"']?([A-Za-z_][A-Za-z0-9_]*)/i);
  if (m) {
    const found = tables.find((t) => t.name.toLowerCase() === m[1].toLowerCase());
    if (found) return found;
  }
  if (tables.length === 1) return tables[0];
  return undefined;
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

function findMentionedColumn(prompt: string, table: TableInfo | undefined): string | undefined {
  if (!table?.columns?.length) return undefined;
  const p = prompt.toLowerCase();
  return table.columns.map((c) => c.name).find((n) => new RegExp(`(^|[^a-z0-9_])${escapeRegex(n.toLowerCase())}([^a-z0-9_]|$)`).test(p));
}

function defaultGroupColumn(table: TableInfo | undefined): string | undefined {
  if (!table?.columns?.length) return undefined;
  const preferred = ['status', 'type', 'category', 'state', 'channel', 'kind'];
  return table.columns.map((c) => c.name).find((n) => preferred.includes(n.toLowerCase())) ?? table.columns.find((c) => !c.primaryKey)?.name;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value).replace(/\|/g, '\\|').slice(0, 120);
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderRows(data: unknown, maxRows = 10): string {
  const d = data as { columns?: Array<{ name: string } | string>; rows?: unknown[][] } | undefined;
  if (!d?.columns || !Array.isArray(d.rows)) return '';
  const names = d.columns.map((c) => (typeof c === 'string' ? c : c.name));
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
    const { prompt, outcomes } = analyzeMessages(req.messages);
    const ctx = req.context ?? {};
    const intent = detectIntent(prompt);
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

    let tables = tablesFromContext(ctx, conn);
    if (inspectOutcome) {
      const fromInspect = tablesFromInspect(inspectOutcome);
      if (fromInspect.length) tables = fromInspect;
    }
    // 用户禁用的表对离线推理器同样不可见，否则「表管理」在本地模式下形同虚设。
    // 必须在两个来源合并之后过滤：inspect_schema 的返回里带着完整表清单。
    tables = applyTableVisibility(tables, ctx.agentContext);

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
      if (intent === 'list_tables') {
        yield* finish('当前库没有表。可以让我创建一个，例如：“创建表 tasks，包含 id 自增主键, title 文本”。');
        return;
      }
    }

    const table = findTable(prompt, tables, ctx);

    if (intent === 'list_tables') {
      if (!tables.length) {
        yield* finish('当前库没有表。可以让我创建一个，例如：“创建表 tasks，包含 id 自增主键, title 文本”。');
        return;
      }
      const list = tables
        .slice(0, 40)
        .map((t) => `- \`${t.name}\`${t.type === 'view' ? '（视图）' : ''}${t.columns?.length ? ` · ${t.columns.length} 列` : ''}${t.rowEstimate !== undefined ? ` · ~${t.rowEstimate} 行` : ''}`)
        .join('\n');
      yield* finish(`当前库（${database ?? conn?.name ?? ''}）共有 **${tables.length}** 张表：\n\n${list}${tables.length > 40 ? '\n- …（其余省略）' : ''}\n\n需要看哪张表的结构或数据，直接说表名即可。`);
      return;
    }

    if (intent === 'describe') {
      if (!table) {
        const names = tables.slice(0, 20).map((t) => `\`${t.name}\``).join('、');
        yield* finish(`请指定要查看的表名。当前可用：${names || '（无）'}。`);
        return;
      }
      const cols = (table.columns ?? []).map((c) => `| \`${c.name}\` | ${c.type} | ${c.primaryKey ? 'PK' : ''} | ${c.nullable ? 'YES' : 'NO'} | ${c.defaultValue ?? ''} |`).join('\n');
      const idx = (table.indexes ?? []).map((i) => `- ${i.name}（${i.unique ? 'UNIQUE ' : ''}${i.columns.join(', ')}）`).join('\n');
      const fks = (table.foreignKeys ?? []).map((f) => `- ${f.columns.join(',')} → ${f.refTable}(${f.refColumns.join(',')})`).join('\n');
      yield* finish(
        `**${table.name}**${table.comment ? ` — ${table.comment}` : ''}\n\n| 列 | 类型 | 键 | 可空 | 默认值 |\n| --- | --- | --- | --- | --- |\n${cols || '| （未读取到列） |  |  |  |  |'}` +
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

    // Remaining intents need a table.
    if (!table && ['sample', 'count', 'group', 'index', 'insert', 'drop', 'export', 'quality', 'chart'].includes(intent)) {
      const names = tables.slice(0, 20).map((t) => `\`${t.name}\``).join('、');
      yield* finish(`请指定表名。当前可用：${names || '（无表）'}。`);
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
      const col = findMentionedColumn(prompt, table) ?? defaultGroupColumn(table);
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
        const timeColumn = (table.columns ?? []).find((c) => /(date|time)/i.test(c.type) || /(_at|date|time)/i.test(c.name));
        if (!timeColumn) {
          yield* finish(`\`${table.name}\` 没有时间列，无法做趋势预测。请换一张带时间字段的表。`);
          return;
        }
        const expr = buildMonthlySeriesExpr(engine, timeColumn.name);
        sql = `SELECT ${expr} AS ${q('period')}, COUNT(*) AS ${q('value')} FROM ${q(table.name)} GROUP BY ${expr} ORDER BY ${q('period')} LIMIT 24`;
        xField = 'period';
      } else {
        const groupColumn = findMentionedColumn(prompt, table) ?? defaultGroupColumn(table);
        if (!groupColumn) {
          yield* finish(`\`${table.name}\` 没有适合分组的列，请指定列名。`);
          return;
        }
        const metric = (table.columns ?? []).find((c) => /(cents|amount|total|price|qty)/i.test(c.name));
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
      const type: 'bar' | 'line' | 'pie' = /(折线|趋势|line)/.test(prompt) ? 'line' : /(饼|占比|pie)/.test(prompt) ? 'pie' : 'bar';
      const q = (name: string) => quoteIdent(name, engine);
      let sql: string;
      let xField: string;
      let chartTitle: string;
      const timeColumn = (table.columns ?? []).find((c) => /(date|time)/i.test(c.type) || /(_at|date|time)/i.test(c.name));
      const groupColumn = findMentionedColumn(prompt, table) ?? defaultGroupColumn(table) ?? table.columns?.find((c) => !c.primaryKey)?.name;
      if (type === 'line' && timeColumn) {
        const expr = buildMonthlySeriesExpr(engine, timeColumn.name);
        sql = `SELECT ${expr} AS ${q('period')}, COUNT(*) AS ${q('value')} FROM ${q(table.name)} GROUP BY ${expr} ORDER BY ${q('period')} LIMIT 24`;
        xField = 'period';
        chartTitle = `${table.name} 月度趋势`;
      } else if (groupColumn) {
        const metric = /(金额|gmv|销售|收入|amount|total|price)/i.test(prompt)
          ? (table.columns ?? []).find((c) => /(cents|amount|total|price)/i.test(c.name))
          : undefined;
        const aggregate = metric ? `SUM(${q(metric.name)})` : 'COUNT(*)';
        sql = `SELECT ${q(groupColumn)} AS ${q('label')}, ${aggregate} AS ${q('value')} FROM ${q(table.name)} GROUP BY ${q(groupColumn)} ORDER BY ${q('value')} DESC LIMIT 16`;
        xField = 'label';
        chartTitle = `${table.name} · ${groupColumn} 分布`;
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
      const col = findMentionedColumn(prompt, table) ?? table.columns?.find((c) => !c.primaryKey)?.name;
      if (!col) {
        yield* finish('请指定要建索引的列。');
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
