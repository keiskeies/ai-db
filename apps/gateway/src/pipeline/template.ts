import { evaluateExpression } from '@aidb/core';

/**
 * JSON 模板渲染：把带 `{{ }}` 的文本变成一个有类型的值。
 *
 * 难点在于占位符可能出现在引号内（`"token": "{{ params.t }}"`），也可能裸在
 * 结构位置上（`"records": {{ rows }}`）。这里先给两种位置都换上字符串哨兵，
 * 解析完 JSON 再把哨兵换回带类型的值——这样数组和对象不会被当成文本塞进引号。
 */

const SENTINEL = (index: number) => `@@aidb${index}@@`;

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function substitute(value: unknown, tokens: Map<string, unknown>): unknown {
  if (typeof value !== 'string') return value;
  const exact = tokens.get(value);
  if (exact !== undefined) return exact;
  if (!value.includes('@@aidb')) return value;
  let text = value;
  for (const [sentinel, resolved] of tokens) text = text.split(sentinel).join(stringify(resolved));
  return text;
}

function walk(value: unknown, tokens: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, tokens));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[String(substitute(key, tokens))] = walk(item, tokens);
    return out;
  }
  return substitute(value, tokens);
}

/** 计算所有占位符并返回渲染结果；scope 里可以同时放 rows/params/state。 */
export function renderJsonTemplate(source: string, scope: Record<string, unknown>): unknown {
  const tokens = new Map<string, unknown>();
  let index = 0;
  const masked = source
    .replace(/"[ \t]*\{\{([\s\S]+?)\}\}[ \t]*"/g, (_match, expression: string) => {
      const sentinel = SENTINEL(index++);
      tokens.set(sentinel, evaluateExpression(expression.trim(), { current: scope, root: scope }));
      return `"${sentinel}"`;
    })
    .replace(/\{\{([\s\S]+?)\}\}/g, (_match, expression: string) => {
      const sentinel = SENTINEL(index++);
      tokens.set(sentinel, evaluateExpression(expression.trim(), { current: scope, root: scope }));
      return `"${sentinel}"`;
    });

  let parsed: unknown;
  try {
    parsed = JSON.parse(masked);
  } catch {
    // 模板本身不是 JSON（例如纯文本 body），退化为字符串替换。
    let text = masked;
    for (const [sentinel, resolved] of tokens) text = text.split(`"${sentinel}"`).join(typeof resolved === 'object' && resolved !== null ? JSON.stringify(resolved) : stringify(resolved));
    return text;
  }
  return walk(parsed, tokens);
}
