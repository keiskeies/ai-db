import { queryJsonPath } from './jsonpath';
import { evaluateExpression, truthy } from './expr';

/**
 * map 步骤的纯数据变换：选取 → 展开 → 过滤 → 投影 → 去重 → 排序 → 截断。
 *
 * 放在 core 里是因为三端要用同一套语义：gateway 执行、desktop 单步预览、
 * 以及 Agent 生成 spec 时的自检。任何一处口径不一致都会让「预览看到的」和
 * 「实际写库的」对不上。
 */

export interface MapRule {
  /** 对上一步原始响应做 JSONPath 选取；省略时用上一步的行集。 */
  select?: string;
  /** 把每行里的嵌套数组展开成多行，例如 `$.items`。 */
  explode?: string;
  /** 行过滤表达式，`@` 与裸字段名都指向当前行。 */
  filter?: string;
  /** 字段投影：目标列名 → 表达式。 */
  project?: Record<string, string>;
  /** 投影时是否保留未声明的原字段。 */
  keepUnmapped?: boolean;
  distinct?: boolean;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
}

export type PipelineRow = Record<string, unknown>;

export function toRows(value: unknown): PipelineRow[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    // JSONPath 的 `$.data.items` 命中的是数组这个节点，摊平一层才是行集。
    const out: PipelineRow[] = [];
    for (const item of value) {
      if (Array.isArray(item)) out.push(...toRows(item));
      else out.push(normalizeRow(item));
    }
    return out;
  }
  if (value instanceof Map) return [...value.entries()].map(([key, item]) => ({ key, value: item }));
  if (typeof value === 'object') return [value as PipelineRow];
  return [{ value }];
}

function normalizeRow(item: unknown): PipelineRow {
  if (item && typeof item === 'object' && !Array.isArray(item)) return item as PipelineRow;
  if (Array.isArray(item)) return { value: item };
  return { value: item };
}

export function columnsOf(rows: PipelineRow[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

function rowScope(row: PipelineRow): { current: unknown; root: Record<string, unknown> } {
  // 同时支持 `@.status == 'paid'` 和 `status == 'paid'` 两种写法。
  return { current: row, root: row };
}

function describe(rule: MapRule): string {
  if (rule.select) return `select=${rule.select}`;
  if (rule.explode) return `explode=${rule.explode}`;
  return 'map';
}

export interface MapResult {
  rows: PipelineRow[];
  columns: string[];
  /** 被过滤/截断掉的行数，用于界面上的「N → M 行」。 */
  dropped: number;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value);
}

/**
 * 把步骤配置里的 `with` 解释成 MapRule。
 *
 * gateway 执行与界面「按样本试算」必须走同一个解释器，否则预览看到的和实际写的
 * 会对不上——这类漂移最难查。
 */
export function mapRuleFromValues(values: Record<string, unknown>): MapRule {
  const project = values.project && typeof values.project === 'object' && !Array.isArray(values.project)
    ? Object.fromEntries(Object.entries(values.project as Record<string, unknown>).map(([key, item]) => [key, textOf(item)]))
    : undefined;
  return {
    select: textOf(values.select) || undefined,
    explode: textOf(values.explode) || undefined,
    filter: textOf(values.filter) || undefined,
    project,
    keepUnmapped: values.keepUnmapped === true,
    distinct: values.distinct === true,
    sortBy: textOf(values.sortBy) || undefined,
    sortDir: textOf(values.sortDir) === 'desc' ? 'desc' : 'asc',
    limit: values.limit === undefined || values.limit === '' ? undefined : Math.max(0, Number(values.limit) || 0) || undefined,
  };
}

export function applyMapRule(input: unknown, rule: MapRule): MapResult {
  let rows: PipelineRow[];
  try {
    rows = rule.select?.trim() ? toRows(queryJsonPath(input ?? [], rule.select.trim())) : toRows(input ?? []);
  } catch (err: any) {
    throw new Error(`${describe(rule)} 选取失败：${err?.message ?? err}`);
  }
  const before = rows.length;

  if (rule.explode?.trim()) {
    const exploded: PipelineRow[] = [];
    for (const row of rows) {
      let matches: unknown[];
      try {
        matches = queryJsonPath(row, rule.explode.trim());
      } catch (err: any) {
        throw new Error(`explode=${rule.explode} 解析失败：${err?.message ?? err}`);
      }
      for (const match of matches) {
        const items = Array.isArray(match) ? match : [match];
        for (const item of items) exploded.push({ ...row, ...normalizeRow(item) });
        if (!items.length) exploded.push(row);
      }
    }
    rows = exploded;
  }

  if (rule.filter?.trim()) {
    const expression = rule.filter.trim();
    try {
      rows = rows.filter((row) => truthy(evaluateExpression(expression, rowScope(row))));
    } catch (err: any) {
      throw new Error(`filter 表达式错误：${err?.message ?? err}`);
    }
  }

  const project = rule.project && Object.keys(rule.project).length ? rule.project : null;
  if (project) {
    const keepUnmapped = rule.keepUnmapped === true;
    rows = rows.map((row, index) => {
      const next: PipelineRow = keepUnmapped ? { ...row } : {};
      for (const [column, expression] of Object.entries(project)) {
        try {
          next[column] = evaluateExpression(expression, rowScope(row));
        } catch (err: any) {
          throw new Error(`字段 ${column} 的表达式错误：${err?.message ?? err}（第 ${index + 1} 行）`);
        }
      }
      return next;
    });
  }

  if (rule.distinct) {
    const seen = new Set<string>();
    rows = rows.filter((row) => {
      const key = JSON.stringify(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (rule.sortBy?.trim()) {
    const expression = rule.sortBy.trim();
    const keyed = rows.map((row, index) => {
      let value: unknown;
      try {
        value = evaluateExpression(expression, rowScope(row));
      } catch {
        value = row[expression.replace(/^@?\./, '')];
      }
      return { row, index, value };
    });
    const direction = rule.sortDir === 'desc' ? -1 : 1;
    keyed.sort((a, b) => {
      const order = compareValues(a.value, b.value);
      return order ? order * direction : a.index - b.index;
    });
    rows = keyed.map((item) => item.row);
  }

  if (rule.limit && rule.limit > 0) rows = rows.slice(0, rule.limit);

  return { rows, columns: columnsOf(rows), dropped: Math.max(0, before - rows.length) };
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left === right ? 0 : left < right ? -1 : 1;
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (leftText !== '' && rightText !== '' && !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}
