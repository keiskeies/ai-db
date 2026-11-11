import type { TableInfo } from '../types';

/**
 * 表用途分档：决定 prompt 里 Schema 段的「展开形状」，而不是简单的「展开/不展开」。
 *
 * 设计原则（与 docs/20 一致）：
 * - 分类信号必须可解释：每张表带一句 reason，用户能看懂、能覆盖。
 * - 字典/配置表不是「不重要」：它决定枚举值怎么解释，模型不知道 status=3 是
 *   「已退款」还是「已取消」时会算出一个看起来正确的错数字。因此它单独成档，
 *   给「表名 + 取值含义」这种形状，而不是列明细，也不是只列名。
 * - 分类落盘（brief frontmatter），低频重算（跟 /init），保证 system 前缀在轮间
 *   逐字节稳定，吃服务商 prompt caching；每轮重算会把缓存打穿。
 */
export type TableTier = 'active' | 'config' | 'bridge' | 'cold' | 'system';

export interface TableTierInfo {
  tier: TableTier;
  /** 一句可解释的理由，直接进 prompt 与 brief 附录。 */
  reason: string;
  /** 查询历史里的出现次数（行为信号），0/缺省表示没查到。 */
  hits?: number;
}

export type TableTiers = Record<string, TableTierInfo>;

/** 活跃业务表的特征列：时间列/金额列出现即说明这张表在被写入业务事件。 */
const ACTIVE_COLUMN = /(^|_)(created|updated|paid|deleted|occurred|event)_?(at|time|date)\b|amount|price|money|qty|quantity|num_/i;
/** 冷数据：日志/审计/历史快照/按日期分区的备份表。 */
const COLD_NAME = /(^|_)(log|logs|audit|history|hist|archive|archived|backup|bak|snapshot|trail|temp|tmp)(_|$)|_\d{4}(_?\d{2}){1,2}/i;
/** 字典/配置：命名直说自己是 dict/config 等。 */
const CONFIG_NAME = /(^|_)(dict|config|configs|conf|setting|settings|option|options|enum|constant|constants|level|region|area|city|country|category|categories|type|types|status|state|channel|currency|unit|dept|department|nation|language|menu|permission|role|title|grade|stage|source|reason|carrier|payment_method)(_|$)/i;
/** 系统/内部表：information_schema、pg_、sqlite_、mysql 内部表、Flyway/Liquibase 迁移记录等。 */
const SYSTEM_NAME = /^(pg_|sqlite_|mysql\.|information_schema|sys\.|oracle\.|flyway_|sp_?ddl|qrtz_|act_|gen_|_)/i;
/** 业务核心命名：和 selectCoreTables 的 KEY_TABLE 同源，命中即业务实体。 */
const BUSINESS_NAME = /(order|user|customer|product|item|payment|pay|refund|account|transaction|invoice|inventory|stock|shipment|delivery|cart|member|tenant|org|company)/i;

/** 枚举感知的列：小整数或短字符串，才可能承载字典取值。 */
function isEnumish(type: string): boolean {
  const t = (type || '').toLowerCase();
  if (/tinyint|smallint|(^|[^a-z])int($|[^a-z])|integer|mediumint/.test(t)) return true;
  const varchar = /(?:var)?char\s*\((\d+)\)|varchar2\s*\((\d+)\)/.exec(t);
  if (varchar) return Number(varchar[1] ?? varchar[2]) <= 64;
  return /(^|[^a-z])(char|text|enum)([^a-z]|$)/.test(t);
}

/**
 * 从注释里抽取枚举含义：`状态 0-待支付 1-已支付` / `状态: 0=待支付, 1=已支付` /
 * `0:待支付 1:已支付`。返回 "0=待支付, 1=已支付" 这种紧凑形式；抽不到返回 undefined。
 * 只认注释，不做采样——采样要查库，属于 init 的执行器扩展（见 docs/20 §5）。
 *
 * 标签必须以字母/汉字开头：允许数字开头会把 `2024-01-05` 这类日期切成 `024=01`，
 * 也正因为如此标签内不能含空格（否则 `0-待支付 1-已支付` 会吞成一条）。
 */
export function extractEnumGloss(comment: string | undefined): string | undefined {
  const text = (comment ?? '').trim();
  if (!text) return undefined;
  const pairs: string[] = [];
  const pattern = /(?<![\w])(\d{1,3})\s*[:：=为\-—]\s*([一-鿿A-Za-z][一-鿿A-Za-z0-9_]{0,13})/g;
  for (const match of text.matchAll(pattern)) {
    const label = (match[2] ?? '').trim().replace(/[，,。.、;；]+$/, '');
    if (label) pairs.push(`${match[1]}=${label}`);
    if (pairs.length >= 12) break;
  }
  return pairs.length >= 2 ? pairs.join(', ') : undefined;
}

interface ClassifyInput {
  table: TableInfo;
  /** 查询历史命中次数（行为信号）；没有历史时传 0/undefined。 */
  hits?: number;
  /** 用户在该库维护过别名/描述的表，永不降档。 */
  curated?: boolean;
  /** 引用这张表的其它表数量（结构信号）：小体量 + 高入向 = 被引用的字典/维度表。 */
  incoming?: number;
}

/**
 * 纯结构 + 行为信号的分档（无采样）。规则顺序即优先级，命中即带理由返回。
 * 导出供单测与 /init 分类器共用。
 */
export function classifyTable(input: ClassifyInput): TableTierInfo {
  const { table, hits = 0, curated = false, incoming = 0 } = input;
  const name = table.name.toLowerCase();
  const columns = table.columns ?? [];
  const outFks = table.foreignKeys?.length ?? 0;
  const hasTime = columns.some((c) => ACTIVE_COLUMN.test(c.name.toLowerCase()));
  const rows = table.rowEstimate ?? 0;

  if (SYSTEM_NAME.test(name)) return { tier: 'system', reason: '系统/迁移内部表，通常与业务查询无关', hits };
  // 人工标注过别名/描述的表紧跟系统表：用户既然为它写过语义，就是要模型看明细，
  // 命名像日志/字典也不该被规则降档（「永不降档」承诺在这里兑现）。
  if (curated) {
    return { tier: 'active', reason: '用户在业务上下文里维护过该表，保持完整明细', hits };
  }
  if (COLD_NAME.test(name)) return { tier: 'cold', reason: '日志/历史/备份命名，一般不是查询目标', hits };
  if (CONFIG_NAME.test(name) && rows <= 5_000 && outFks <= 1) {
    return { tier: 'config', reason: '命名与体量都像字典/配置表，枚举含义必须让模型看到', hits };
  }
  if (hits >= 2) {
    return { tier: 'active', reason: `近期查询历史出现 ${hits} 次，属团队高频表`, hits };
  }
  if (incoming >= 3 && rows <= 5_000 && !hasTime) {
    return { tier: 'config', reason: `${incoming} 张表引用它且体量小，属被引用的字典/维度表`, hits };
  }
  const fkColumns = new Set((table.foreignKeys ?? []).flatMap((fk) => fk.columns.map((c) => c.toLowerCase())));
  const extraColumns = columns.filter((c) => !fkColumns.has(c.name.toLowerCase()) && !c.primaryKey);
  if (outFks >= 1 && columns.length > 0 && extraColumns.length <= 1 && rows <= 100_000 && !hasTime) {
    return { tier: 'bridge', reason: '列几乎全是外键、无业务时间列，典型多对多桥接表', hits };
  }
  // 小体量 + 大量入向引用的表（行数小、被别人引用）在这里没有入向计数，交给调用方
  // 的 incoming 引用补充；本函数只做本地可判的部分。
  if (BUSINESS_NAME.test(name) || hasTime || hits === 1) {
    return { tier: 'active', reason: hasTime ? '含业务时间列，属活跃业务表' : '命名/用法像业务实体，保留完整明细', hits };
  }
  if (rows <= 1_000 && columns.length <= 8 && outFks <= 1) {
    return { tier: 'cold', reason: '体量小、无时间列、无历史引用，暂按低频表掠过', hits };
  }
  return { tier: 'active', reason: '默认保留明细；若属误判可在业务上下文中标注，或在 brief 里覆盖', hits };
}

/** 分档在 prompt 里的形状说明（写进 schema 段头部，模型据此选择行为）。 */
export const TIER_GUIDE = '- Tier legend: tables listed with columns are the active business tables (full detail). Marked ones behave differently — [dict]=lookup/config table, values glossed where known (read the gloss before filtering on status/type columns); [bridge]=join-only, names suffice; [low]=low-frequency, names only (ask before querying, and inspect_schema for columns); [sys]=internal, do not query unless asked. A table absent from the brief still exists — never conclude otherwise.';
