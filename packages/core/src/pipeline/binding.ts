import { evaluateExpression } from './expr';

/**
 * `{{ ... }}` 参数绑定。
 *
 * 大括号里放一条表达式（见 expr.ts）。整串恰好只有一个占位符时返回原始类型，
 * 否则按字符串拼接——这样 `{{ params.limit }}` 仍是数字，而
 * `dt={{ run.batchDate }}` 是文本。
 *
 * 刻意不提供凭证占位符：HTTP 认证参数在 gateway 里按 credential id 解析，
 * 永不出现在可记录的字符串中，避免密钥被写进 SQL、日志或运行历史。
 */

export type BindingScope = Record<string, unknown>;

const PLACEHOLDER = /\{\{([\s\S]*?)\}\}/g;

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 求值一个占位符内容；语法错误向上抛，让步骤失败而不是静默替换成空串。 */
export function evalBinding(expression: string, scope: BindingScope): unknown {
  return evaluateExpression(expression.trim(), { current: scope, root: scope });
}

export function resolveBinding(value: unknown, scope: BindingScope): unknown {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    const single = /^\s*\{\{([\s\S]+?)\}\}\s*$/.exec(value);
    if (single) return evalBinding(single[1], scope);
    return value.replace(PLACEHOLDER, (_match, expression: string) => stringify(evalBinding(expression, scope)));
  }
  if (Array.isArray(value)) return value.map((item) => resolveBinding(item, scope));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 键名也允许绑定：`{{ params.column }}: "x"` 用于动态列映射。
      const resolvedKey = typeof key === 'string' && key.includes('{{') ? stringify(resolveBinding(key, scope)) : key;
      out[resolvedKey] = resolveBinding(item, scope);
    }
    return out;
  }
  return value;
}

