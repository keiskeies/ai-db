import type { Memory, TableInfo } from '../../types';
import { classifySql, isReadOnlyStatement } from '../../sql/classify';
import { ANTI_PATTERN_TITLE } from '../prompt';
import { tokenize } from '../memory';
import { groundedTables } from './schema';
import type { GroundingOptions } from './schema';

/**
 * 把用户登记的业务上下文变成硬约束，而不是只塞进提示词的建议。
 *
 * 云端有模型兜底：反例写在 prompt 里它多半会听。离线没有第二次机会，
 * 「订单数不要用支付流水」这种约束只有真的挡住那条 SQL 才算生效——
 * 否则用户维护的反例在本地模式下等于零，同一个库两种模式给出两个口径。
 */

export interface Forbidden {
  /** 整表不可用（反例点名了这张表）。 */
  tables: Set<string>;
  /** 表限定到列的禁用项，key 为 `table.column`（小写）。 */
  columns: Set<string>;
  /** 原文，用于把「为什么没用」讲清楚。 */
  reasons: string[];
}

export const NO_FORBIDDEN: Forbidden = { tables: new Set(), columns: new Set(), reasons: [] };

/** 子句里出现这些字样才认定是负向指令：反例正文常常同时写出该用的表。 */
const NEGATIVE = /(不要|不许|不准|不该|不能用|不可用|别用|误用|错用|不是|不等于|不含|避免|禁止|慎用|never|don'?t|do not|not\b|wrong)/i;

/** 切句用：否定只在小句内作用，跨 `；。` 的主语不算同一个小句。 */
const CLAUSE_SPLIT = /[；;。\n]/;
const COMMA_SPLIT = /[，,]/;

/**
 * 挑出真正表达否定的分句。
 *
 * 只在 `；;。` 与换行处切句，不在逗号处切：`t_trade_pay_flow 是支付流水，一行不等于一笔订单`
 * 的否定落在后半句，主语在前半句，切开会什么都禁不到。反过来，整句当一个单位又会把
 * 「必须用 t_order，t_trade_pay_flow 不是一笔订单」里的 t_order 一起禁掉。所以按逗号切成
 * 小句，命中否定词的小句若自己没有标识符，就往前找第一个带标识符的小句当主语。
 */
function negativeClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(CLAUSE_SPLIT)) {
    const parts = sentence.split(COMMA_SPLIT).map((part) => part.trim()).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      if (!NEGATIVE.test(part)) continue;
      if (identifiers(part).length) {
        out.push(part);
        continue;
      }
      const subject = parts.slice(0, index).reverse().find((prev) => identifiers(prev).length);
      if (subject) out.push(subject);
    }
  }
  return out;
}

/**
 * 反例里会点到的对象名。
 *
 * 不按长度过滤：`id`、`sn` 正是需要被禁的那种短列名，而真正的噪声（SQL 关键字、英文虚词）
 * 用一张小黑名单挡掉就够——反正只有能对上现有表/列的 token 才会落地成约束。
 */
const NOT_A_NAME = /^(no|to|by|on|in|at|as|is|it|of|or|so|if|and|not|the|use|for|with|select|from|where|group|order|limit|join|sum|avg|count|min|max|distinct|total|value|date|time)$/i;

function identifiers(text: string): string[] {
  return (text.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g) ?? []).filter((token) => !NOT_A_NAME.test(token));
}

/**
 * 从反例正文里抽出被禁的表与列。
 *
 * 判定只看**含否定词的分句**：`统计订单笔数必须用 t_order；t_trade_pay_flow 是支付流水，
 * 一行不等于一笔订单` 里该禁的是后半句点名的 t_trade_pay_flow，前半句是被推荐的那张。
 */
export function forbiddenFromGlossary(glossary: Memory[] | undefined, tables: TableInfo[], grounding: GroundingOptions): Forbidden {
  const visible = groundedTables(tables, grounding);
  const byName = new Map(visible.map((table) => [table.name.toLowerCase(), table]));
  const result: Forbidden = { tables: new Set(), columns: new Set(), reasons: [] };
  for (const memory of glossary ?? []) {
    if (memory.kind !== 'glossary' || !ANTI_PATTERN_TITLE.test(memory.title.trim())) continue;
    for (const clause of negativeClauses(`${memory.title}\n${memory.content}`)) {
      for (const token of identifiers(clause)) {
        const dotted = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/i.exec(token);
        if (dotted) {
          const table = byName.get(dotted[1].toLowerCase());
          if (!table) continue;
          const column = (table.columns ?? []).find((item) => item.name.toLowerCase() === dotted[2].toLowerCase());
          if (column) result.columns.add(`${table.name.toLowerCase()}.${column.name.toLowerCase()}`);
          continue;
        }
        const hit = byName.get(token.toLowerCase());
        if (hit) {
          result.tables.add(hit.name.toLowerCase());
          continue;
        }
        // 裸列名：只有在全库唯一命中时才敢禁，否则宁可不禁。
        const matches = visible.flatMap((table) => (table.columns ?? []).filter((column) => column.name.toLowerCase() === token.toLowerCase()).map((column) => `${table.name.toLowerCase()}.${column.name.toLowerCase()}`));
        if (matches.length === 1) result.columns.add(matches[0]);
      }
    }
    result.reasons.push(`${memory.title.trim().replace(/^反例[:：]\s*/, '')}：${memory.content.replace(/\s+/g, ' ').trim()}`);
  }
  return result;
}

export function isTableForbidden(forbidden: Forbidden, table: string): boolean {
  return forbidden.tables.has(table.toLowerCase());
}

export function isColumnForbidden(forbidden: Forbidden, table: string, column: string): boolean {
  return forbidden.columns.has(`${table.toLowerCase()}.${column.toLowerCase()}`);
}

/** 反例点名了用户要的表：这句话要能直接回答「为什么我不能查」。 */
export function forbiddenTableReason(forbidden: Forbidden, table: string): string | undefined {
  if (!isTableForbidden(forbidden, table)) return undefined;
  return forbidden.reasons.find((reason) => reason.toLowerCase().includes(table.toLowerCase()));
}

export interface ExampleMatch {
  title: string;
  sql: string;
  /** 与问题的重合度：调试时用来解释为什么套用了这一条。 */
  score: number;
}
/** 示例 SQL 与问题至少要有这么高的重合才敢直接套用。 */
const EXAMPLE_THRESHOLD = 0.4;

/**
 * 已登记的示例 SQL 是权威口径：能对上就原样执行。
 *
 * 校验只放行「单条只读 + 点名的表都还可见 + 没撞上反例」的示例；示例记忆按连接作用域
 * 召回，方言天然与当前连接一致，真正的语法错误交给执行器报出来，比在这里猜方言函数可靠。
 */
export function matchSqlExample(question: string, tables: TableInfo[], grounding: GroundingOptions, forbidden: Forbidden = NO_FORBIDDEN): ExampleMatch | undefined {
  const examples = (grounding.sqlExamples ?? []).filter((memory) => memory.kind === 'sql_example' && memory.content.trim());
  if (!examples.length) return undefined;
  const visible = new Map(groundedTables(tables, grounding).map((table) => [table.name.toLowerCase(), table]));
  let best: ExampleMatch | undefined;
  for (const memory of examples) {
    const sql = memory.content.trim().replace(/^```(?:sql)?\s*|\s*```$/gi, '');
    if (!isReadOnlyStatement(sql)) continue;
    if (classifySql(sql).statements.length !== 1) continue;
    const referenced = referencedTables(sql);
    if (!referenced.length) continue;
    if (referenced.some((name) => !visible.has(name) || isTableForbidden(forbidden, name))) continue;
    const score = similarity(question, `${memory.title} ${referenced.join(' ')}`);
    if (score < EXAMPLE_THRESHOLD) continue;
    if (!best || score > best.score) best = { title: memory.title, sql, score };
  }
  return best;
}

/** FROM / JOIN 后面的第一个标识符：只认表位，避免把字符串常量或别名当成表。 */
function referencedTables(sql: string): string[] {
  const masked = sql.replace(/'[^']*'|"[^"]*"/g, ' ');
  const out = new Set<string>();
  for (const match of masked.matchAll(/\b(?:from|join)\s+([`"\[]?[A-Za-z_][A-Za-z0-9_.]*[`"\]]?)/gi)) {
    const raw = match[1].replace(/[`"\[\]]/g, '');
    const name = raw.includes('.') ? raw.split('.').pop() ?? raw : raw;
    out.add(name.toLowerCase());
  }
  return [...out];
}

function similarity(question: string, target: string): number {
  const a = new Set(tokenize(question));
  const b = new Set(tokenize(target));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
}
