import { evaluateExpression, truthy } from './expr';

/**
 * JSONPath（RFC 9535 的可执行子集）。
 *
 * 支持：`$`、`.name`、`['a','b']` 并集、`[0]`、`[1:9:2]` 切片、`[*]`、`..name`
 * 递归下降、`[?<expr>]` 过滤器（`@` 指向当前节点）。刻意不做 RFC 的扩展函数
 * 注册表：过滤里需要的字符串/长度判断由 expr.ts 统一提供，避免两套语言。
 */

export type JsonPathSegment =
  | { kind: 'name'; names: string[] }
  | { kind: 'wildcard' }
  | { kind: 'index'; indices: number[] }
  | { kind: 'slice'; start: number | null; end: number | null; step: number }
  | { kind: 'filter'; expression: string }
  | { kind: 'descendant' };

const DEFAULT_MAX_MATCHES = 50000;

export function parseJsonPath(path: string): JsonPathSegment[] {
  const source = path.trim();
  if (!source) throw new Error('JSONPath 不能为空');
  let text = source;
  // 容忍 `data.items` 这种省略根前缀的写法，界面里更好填。
  if (text !== '$' && !text.startsWith('$') && !text.startsWith('@')) text = `$.${text}`;
  if (text.startsWith('@')) text = `$${text.slice(1)}`;
  const segments: JsonPathSegment[] = [];
  let index = 1; // 跳过根
  while (index < text.length) {
    const char = text[index];
    if (char === '.') {
      if (text[index + 1] === '.') {
        segments.push({ kind: 'descendant' });
        index += 2;
        if (text[index] === '[') continue;
        const name = readName(text, index);
        index += name.length;
        if (!name || name === '*') segments.push({ kind: 'wildcard' });
        else segments.push({ kind: 'name', names: [name] });
        continue;
      }
      index += 1;
      if (text[index] === '[') continue;
      const name = readName(text, index);
      if (name === '*') {
        index += 1;
        segments.push({ kind: 'wildcard' });
        continue;
      }
      if (!name) throw new Error(`JSONPath 在位置 ${index} 缺少成员名`);
      index += name.length;
      segments.push({ kind: 'name', names: [name] });
      continue;
    }
    if (char === '[') {
      const close = findBracket(text, index);
      const body = text.slice(index + 1, close).trim();
      index = close + 1;
      if (body.startsWith('?')) {
        segments.push({ kind: 'filter', expression: body.replace(/^\?\s*/, '') });
        continue;
      }
      if (body === '*') {
        segments.push({ kind: 'wildcard' });
        continue;
      }
      if (body.includes(':')) {
        const [rawStart, rawEnd, rawStep] = body.split(':');
        segments.push({
          kind: 'slice',
          start: rawStart?.trim() ? Number(rawStart) : null,
          end: rawEnd?.trim() ? Number(rawEnd) : null,
          step: rawStep?.trim() ? Number(rawStep) : 1,
        });
        continue;
      }
      const parts = splitUnion(body);
      if (parts.every(isNumericIndex)) {
        segments.push({ kind: 'index', indices: parts.map((part) => Number(part)) });
        continue;
      }
      if (parts.every(isQuoted)) {
        segments.push({ kind: 'name', names: parts.map(unquote) });
        continue;
      }
      throw new Error(`不支持的 JSONPath 选择器：[${body}]`);
    }
    throw new Error(`JSONPath 在位置 ${index} 无法解析`);
  }
  return segments;
}

function readName(text: string, from: number): string {
  let end = from;
  while (end < text.length && /[A-Za-z0-9_$\u4e00-\u9fff-]/.test(text[end])) end += 1;
  return text.slice(from, end);
}

function findBracket(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\') { i += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('JSONPath 的 [ 缺少配对的 ]');
}

function splitUnion(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ',') { parts.push(current.trim()); current = ''; continue; }
    current += char;
    continue;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function isNumericIndex(part: string): boolean {
  return /^-?\d+$/.test(part);
}

function isQuoted(part: string): boolean {
  return (part.startsWith("'") && part.endsWith("'") && part.length >= 2) || (part.startsWith('"') && part.endsWith('"') && part.length >= 2);
}

function unquote(part: string): string {
  return part.slice(1, -1).replace(/\\(['"])/g, '$1');
}

function childrenOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
}

function descendantSelf(value: unknown, out: unknown[] = []): unknown[] {
  out.push(value);
  for (const child of childrenOf(value)) descendantSelf(child, out);
  return out;
}

function normalizeSliceIndex(raw: number | null, length: number, step: number, isStart: boolean): number {
  if (raw === null) return isStart ? (step > 0 ? 0 : length - 1) : step > 0 ? length : -1;
  const value = raw < 0 ? raw + length : raw;
  if (step > 0) return Math.min(Math.max(value, 0), length);
  return Math.min(Math.max(value, -1), length - 1);
}

function applySegment(nodes: unknown[], segment: JsonPathSegment, maxMatches: number): unknown[] {
  const out: unknown[] = [];
  const push = (value: unknown) => {
    if (out.length >= maxMatches) return;
    out.push(value);
  };
  for (const node of nodes) {
    switch (segment.kind) {
      case 'wildcard':
        for (const child of childrenOf(node)) push(child);
        break;
      case 'name':
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          const record = node as Record<string, unknown>;
          for (const name of segment.names) if (Object.prototype.hasOwnProperty.call(record, name)) push(record[name]);
        }
        break;
      case 'index':
        if (Array.isArray(node)) {
          for (const raw of segment.indices) {
            const position = raw < 0 ? node.length + raw : raw;
            if (position >= 0 && position < node.length) push(node[position]);
          }
        }
        break;
      case 'slice': {
        if (!Array.isArray(node)) break;
        const length = node.length;
        const step = segment.step === 0 ? 1 : segment.step;
        const start = normalizeSliceIndex(segment.start, length, step, true);
        const end = normalizeSliceIndex(segment.end, length, step, false);
        if (step > 0) for (let i = start; i < end; i += step) push(node[i]);
        else for (let i = start; i > end; i += step) push(node[i]);
        break;
      }
      case 'filter': {
        for (const candidate of childrenOf(node)) {
          try {
            // 除了 RFC 的 `@`，裸字段名也按当前节点解析，`[?status == 'ok']` 直接可用。
            const root = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? (candidate as Record<string, unknown>) : {};
            if (truthy(evaluateExpression(segment.expression, { current: candidate, root }))) push(candidate);
          } catch {
            // 单行求值失败（例如缺字段做算术）只跳过这一行，不让整批数据中断。
          }
        }
        break;
      }
      case 'descendant':
        for (const itself of descendantSelf(node)) push(itself);
        break;
      default:
        break;
    }
  }
  return out;
}

export function queryJsonPath(value: unknown, path: string, options?: { maxMatches?: number }): unknown[] {
  const segments = parseJsonPath(path);
  const maxMatches = options?.maxMatches ?? DEFAULT_MAX_MATCHES;
  let current: unknown[] = [value];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind === 'descendant') {
      // `..a` 是 descendant-or-self 后接选择器，两者必须一起展开。
      current = applySegment(current, segment, maxMatches);
      const next = segments[index + 1];
      if (next && next.kind !== 'descendant') {
        current = applySegment(current, next, maxMatches);
        index += 1;
      } else {
        current = current.filter((item) => typeof item === 'object' && item !== null);
      }
      continue;
    }
    current = applySegment(current, segment, maxMatches);
  }
  return current;
}

export function firstJsonPath(value: unknown, path: string): unknown {
  const matches = queryJsonPath(value, path, { maxMatches: 1 });
  return matches.length ? matches[0] : undefined;
}

export function checkJsonPath(path: string): string | null {
  try {
    parseJsonPath(path);
    return null;
  } catch (err: any) {
    return err?.message ?? 'JSONPath 语法错误';
  }
}
