/**
 * 数据流（pipeline）使用的表达式语言。
 *
 * 它是刻意「总量安全」的子集：只有字面量、成员访问、算术/比较/逻辑运算、
 * 三元、数组/对象字面量与白名单函数。没有赋值、循环、函数定义，也拿不到
 * 原型链，所以单条表达式的耗时可预期——它会按行执行，不能成为流水线的瓶颈
 * 或逃逸入口。同一套求值器同时服务三处：JSONPath 的 ` filter`、map 步骤的
 * 过滤与投影，以及 `{{ ... }}` 参数绑定。
 */

export type ExprValue = unknown;

export interface ExprScope {
  /** `@` 指向的当前值：map 步骤里是行，JSONPath 过滤器里是候选节点。 */
  current: ExprValue;
  /** 裸标识符的查找表；`$` 直接指向它。 */
  root: Record<string, ExprValue>;
}

type ExprNode =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'current' }
  | { kind: 'root' }
  | { kind: 'name'; name: string }
  | { kind: 'member'; target: ExprNode; key: string }
  | { kind: 'index'; target: ExprNode; index: ExprNode }
  | { kind: 'call'; name: string; args: ExprNode[] }
  | { kind: 'unary'; op: '!' | '-'; operand: ExprNode }
  | { kind: 'binary'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'ternary'; cond: ExprNode; yes: ExprNode; no: ExprNode }
  | { kind: 'array'; items: ExprNode[] }
  | { kind: 'object'; entries: { key: string; value: ExprNode }[] };

interface Token {
  kind: 'num' | 'str' | 'ident' | 'op';
  text: string;
  value?: string | number;
}

/** 属性访问黑名单：表达式只能读数据，不能碰任何宿主对象的结构。 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'valueOf', 'toString', 'hasOwnProperty']);

const MULTI_OPERATORS = ['===', '!==', '==', '!=', '>=', '<=', '&&', '||', '??'];
const SINGLE_OPERATORS = ['+', '-', '*', '/', '%', '<', '>', '!', '(', ')', '[', ']', '{', '}', ',', '.', ':', '?'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '@' || char === '$') {
      tokens.push({ kind: 'ident', text: char });
      index += 1;
      continue;
    }
    if (char >= '0' && char <= '9') {
      let end = index;
      while (end < source.length && (source[end] >= '0' && source[end] <= '9' || (source[end] === '.' && source[end + 1] >= '0' && source[end + 1] <= '9'))) end += 1;
      // 科学计数法：数据里粘过来的 1e3、2.5e-4 要能直接写。
      if (source[end] === 'e' || source[end] === 'E') {
        let probe = end + 1;
        if (source[probe] === '+' || source[probe] === '-') probe += 1;
        if (/[0-9]/.test(source[probe] ?? '')) {
          while (/[0-9]/.test(source[probe] ?? '')) probe += 1;
          end = probe;
        }
      }
      const raw = source.slice(index, end);
      tokens.push({ kind: 'num', text: raw, value: Number(raw) });
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      let end = index + 1;
      while (end < source.length && source[end] !== quote) {
        if (source[end] === '\\' && end + 1 < source.length) {
          const next = source[end + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          end += 2;
          continue;
        }
        value += source[end];
        end += 1;
      }
      if (source[end] !== quote) throw new Error('字符串缺少结尾引号');
      tokens.push({ kind: 'str', text: quote + value + quote, value });
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_$\u4e00-\u9fff]/.test(char)) {
      // 允许中文列名：数据流里 `@.金额 > 100` 是真实写法，不是测试特例。
      let end = index;
      while (end < source.length && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(source[end])) end += 1;
      tokens.push({ kind: 'ident', text: source.slice(index, end) });
      index = end;
      continue;
    }
    const multi = MULTI_OPERATORS.find((op) => source.startsWith(op, index));
    if (multi) {
      tokens.push({ kind: 'op', text: multi });
      index += multi.length;
      continue;
    }
    const single = SINGLE_OPERATORS.find((op) => source[index] === op);
    if (single) {
      tokens.push({ kind: 'op', text: single });
      index += 1;
      continue;
    }
    throw new Error(char === '=' ? '表达式不支持赋值，比较请用 ==' : `无法识别的字符：${char}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  parse(): ExprNode {
    const node = this.parseBinary(0);
    if (this.pos < this.tokens.length) throw new Error(`多余的内容：${this.peek().text}`);
    return node;
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? { kind: 'op', text: '' };
  }

  private take(text: string): boolean {
    if (this.peek().kind === 'op' && this.peek().text === text) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.take(text)) throw new Error(`缺少 ${text}`);
  }

  /** 优先级表：值越小越先结合。 */
  private binaryPrecedence(): number {
    const token = this.peek();
    // `in` 走标识符路径（不是运算符字符），但要参与结合。
    if (token.kind === 'ident' && token.text === 'in') return 4;
    if (token.kind !== 'op') return 0;
    switch (token.text) {
      case '??':
        return 1;
      case '||':
        return 2;
      case '&&':
        return 3;
      case '==':
      case '!=':
      case '===':
      case '!==':
        return 4;
      case 'in':
        return 4;
      case '<':
      case '>':
      case '<=':
      case '>=':
        return 5;
      case '+':
      case '-':
        return 6;
      case '*':
      case '/':
      case '%':
        return 7;
      default:
        return 0;
    }
  }

  private parseBinary(minPrecedence: number): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      if (this.peek().kind === 'op' && this.peek().text === '?' && minPrecedence === 0) {
        this.pos += 1;
        const yes = this.parseBinary(0);
        this.expect(':');
        const no = this.parseBinary(0);
        left = { kind: 'ternary', cond: left, yes, no };
        continue;
      }
      const precedence = this.binaryPrecedence();
      if (!precedence || precedence < minPrecedence) return left;
      const token = this.peek();
      const op = token.kind === 'op' ? token.text : 'in';
      this.pos += 1;
      const right = this.parseBinary(precedence + 1);
      left = { kind: 'binary', op, left, right };
    }
  }

  private parseUnary(): ExprNode {
    const token = this.peek();
    if (token.kind === 'op' && (token.text === '!' || token.text === '-')) {
      this.pos += 1;
      return { kind: 'unary', op: token.text as '!' | '-', operand: this.parseUnary() };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(node: ExprNode): ExprNode {
    for (;;) {
      if (this.take('.')) {
        const name = this.peek();
        if (name.kind !== 'ident' && name.kind !== 'num' && name.kind !== 'str') throw new Error('属性名缺失');
        this.pos += 1;
        node = { kind: 'member', target: node, key: String(name.value ?? name.text) };
        continue;
      }
      if (this.take('[')) {
        const index = this.parseBinary(0);
        this.expect(']');
        node = { kind: 'index', target: node, index };
        continue;
      }
      break;
    }
    return node;
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    if (token.kind === 'num') {
      this.pos += 1;
      return { kind: 'literal', value: token.value as number };
    }
    if (token.kind === 'str') {
      this.pos += 1;
      return { kind: 'literal', value: token.value as string };
    }
    if (this.take('(')) {
      if (this.take(')')) return { kind: 'array', items: [] };
      const first = this.parseBinary(0);
      if (this.peek().kind === 'op' && this.peek().text === ',') {
        const items = [first];
        for (;;) {
          if (!this.take(',')) break;
          if (this.take(')')) return { kind: 'array', items };
          items.push(this.parseBinary(0));
        }
        this.expect(')');
        return { kind: 'array', items };
      }
      this.expect(')');
      return first;
    }
    if (this.take('[')) {
      const items: ExprNode[] = [];
      while (!(this.peek().kind === 'op' && this.peek().text === ']')) {
        items.push(this.parseBinary(0));
        if (!this.take(',')) break;
      }
      this.expect(']');
      return { kind: 'array', items };
    }
    if (this.take('{')) {
      const entries: { key: string; value: ExprNode }[] = [];
      while (!(this.peek().kind === 'op' && this.peek().text === '}')) {
        const keyToken = this.peek();
        let key: string;
        if (keyToken.kind === 'str' || keyToken.kind === 'num') key = String(keyToken.value);
        else if (keyToken.kind === 'ident') key = keyToken.text;
        else throw new Error('对象键名必须是标识符或字符串');
        this.pos += 1;
        this.expect(':');
        entries.push({ key, value: this.parseBinary(0) });
        if (!this.take(',')) break;
      }
      this.expect('}');
      return { kind: 'object', entries };
    }
    if (token.kind === 'ident') {
      this.pos += 1;
      if (token.text === '@') return { kind: 'current' };
      if (token.text === '$') return { kind: 'root' };
      if (token.text === 'true') return { kind: 'literal', value: true };
      if (token.text === 'false') return { kind: 'literal', value: false };
      if (token.text === 'null') return { kind: 'literal', value: null };
      if (this.peek().kind === 'op' && this.peek().text === '(') {
        this.pos += 1;
        const args: ExprNode[] = [];
        while (!(this.peek().kind === 'op' && this.peek().text === ')')) {
          args.push(this.parseBinary(0));
          if (!this.take(',')) break;
        }
        this.expect(')');
        const fn = FUNCTIONS[token.text];
        if (!fn) throw new Error(`未知函数：${token.text}()`);
        if (args.length < fn.min || (fn.max !== undefined && args.length > fn.max)) {
          throw new Error(`${token.text}() 参数数量不对，应为 ${fn.signature}`);
        }
        return { kind: 'call', name: token.text, args };
      }
      if (token.text === 'in') throw new Error('in 需要左侧操作数');
      return { kind: 'name', name: token.text };
    }
    throw new Error(`意外的符号：${token.text || '表达式结尾'}`);
  }
}

function asString(value: ExprValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function asNumber(value: ExprValue): number {
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  if (!text.length) return Number.NaN;
  const parsed = Number(text);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function asBoolean(value: ExprValue): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value !== '' && value.toLowerCase() !== 'false';
  return true;
}

function readProperty(target: ExprValue, key: string): ExprValue {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  if (target === null || target === undefined) return undefined;
  if (typeof target !== 'object') {
    if (key === 'length' && typeof target === 'string') return target.length;
    return undefined;
  }
  if (Array.isArray(target)) {
    const index = Number(key);
    if (Number.isInteger(index)) return index < 0 ? target[target.length + index] : target[index];
    if (key === 'length') return target.length;
    return undefined;
  }
  if (target instanceof Date) {
    const accessors: Record<string, () => number> = {
      year: () => target.getFullYear(),
      month: () => target.getMonth() + 1,
      day: () => target.getDate(),
      hours: () => target.getHours(),
      minutes: () => target.getMinutes(),
      timestamp: () => Math.floor(target.getTime() / 1000),
    };
    return accessors[key]?.();
  }
  const record = target as Record<string, ExprValue>;
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'function' ? undefined : value;
}

function looseEqual(left: ExprValue, right: ExprValue): boolean {
  if (left === right) return true;
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  if (typeof left === 'number' || typeof right === 'number') {
    const a = asNumber(left);
    const b = asNumber(right);
    return !Number.isNaN(a) && a === b;
  }
  if (typeof left === 'object' || typeof right === 'object') return JSON.stringify(left) === JSON.stringify(right);
  return asString(left) === asString(right);
}

function compare(left: ExprValue, right: ExprValue): number | null {
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  const a = asNumber(left);
  const b = asNumber(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectKeys(value: ExprValue): string[] {
  if (Array.isArray(value)) {
    const keys = new Set<string>();
    for (const item of value) if (item && typeof item === 'object') for (const key of Object.keys(item as object)) keys.add(key);
    return [...keys];
  }
  if (value && typeof value === 'object') return Object.keys(value as object);
  return [];
}

function dropKeys(value: ExprValue, keys: string[]): ExprValue {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => dropKeys(item, keys));
  const drop = new Set(keys);
  const result: Record<string, ExprValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, ExprValue>)) if (!drop.has(key)) result[key] = item;
  return result;
}

function asDate(value: ExprValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text.includes('T') || text.includes(' ') ? text.replace(' ', 'T') : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface ExprFunction {
  min: number;
  max?: number;
  apply: (args: ExprValue[], scope: ExprScope) => ExprValue;
  /** 注入给 Agent / 界面的一句话签名说明。 */
  signature: string;
  zh: string;
}

export const EXPRESSION_FUNCTIONS: Record<string, ExprFunction> = {
  length: { min: 1, max: 1, signature: 'length(v)', zh: '字符串/数组长度，对象键数', apply: ([v]) => (Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : typeof v === 'object' && v ? Object.keys(v as object).length : 0) },
  upper: { min: 1, max: 1, signature: 'upper(s)', zh: '转大写', apply: ([v]) => asString(v).toUpperCase() },
  lower: { min: 1, max: 1, signature: 'lower(s)', zh: '转小写', apply: ([v]) => asString(v).toLowerCase() },
  trim: { min: 1, max: 1, signature: 'trim(s)', zh: '去首尾空白', apply: ([v]) => asString(v).trim() },
  concat: { min: 0, signature: 'concat(...)', zh: '拼接为字符串', apply: (args) => args.map(asString).join('') },
  contains: { min: 2, max: 2, signature: 'contains(s, sub)', zh: '是否包含子串', apply: ([a, b]) => asString(a).includes(asString(b)) },
  startswith: { min: 2, max: 2, signature: 'startswith(s, sub)', zh: '前缀判断', apply: ([a, b]) => asString(a).startsWith(asString(b)) },
  endswith: { min: 2, max: 2, signature: 'endswith(s, sub)', zh: '后缀判断', apply: ([a, b]) => asString(a).endsWith(asString(b)) },
  matches: { min: 2, max: 2, signature: 'matches(s, regex)', zh: '正则匹配', apply: ([a, b]) => { try { return new RegExp(asString(b)).test(asString(a)); } catch { return false; } } },
  replace: { min: 3, max: 3, signature: 'replace(s, from, to)', zh: '全量替换', apply: ([s, from, to]) => asString(s).split(asString(from)).join(asString(to)) },
  substr: { min: 2, max: 3, signature: 'substr(s, start, len?)', zh: '截取子串', apply: ([s, start, len]) => { const text = asString(s); const from = asNumber(start); return len === undefined ? text.slice(from) : text.slice(from, from + asNumber(len)); } },
  split: { min: 1, max: 2, signature: 'split(s, sep=",")', zh: '切分为数组', apply: ([s, sep]) => asString(s).split(asString(sep ?? ',')) },
  join: { min: 1, max: 2, signature: 'join(arr, sep=",")', zh: '数组拼接', apply: ([arr, sep]) => (Array.isArray(arr) ? arr.map(asString).join(asString(sep ?? ',')) : asString(arr)) },
  number: { min: 1, max: 1, signature: 'number(v)', zh: '转数字，失败为 null', apply: ([v]) => (Number.isNaN(asNumber(v)) ? null : asNumber(v)) },
  string: { min: 1, max: 1, signature: 'string(v)', zh: '转字符串', apply: ([v]) => asString(v) },
  bool: { min: 1, max: 1, signature: 'bool(v)', zh: '转布尔', apply: ([v]) => asBoolean(v) },
  json: { min: 1, max: 1, signature: 'json(v)', zh: '序列化为 JSON 文本', apply: ([v]) => JSON.stringify(v ?? null) },
  parse_json: { min: 1, max: 1, signature: 'parse_json(s)', zh: '解析 JSON 文本，失败为 null', apply: ([v]) => { try { return JSON.parse(asString(v)); } catch { return null; } } },
  if: { min: 3, max: 3, signature: 'if(cond, yes, no)', zh: '三元取值', apply: ([c, y, n], scope) => (asBoolean(c) ? y : n) },
  coalesce: { min: 1, signature: 'coalesce(...)', zh: '第一个非空值', apply: (args) => args.find((v) => v !== null && v !== undefined && v !== '') ?? null },
  abs: { min: 1, max: 1, signature: 'abs(n)', zh: '绝对值', apply: ([v]) => Math.abs(asNumber(v)) },
  round: { min: 1, max: 2, signature: 'round(n, digits=0)', zh: '四舍五入', apply: ([v, d]) => { const factor = 10 ** Math.trunc(asNumber(d ?? 0)); return Math.round(asNumber(v) * factor) / factor; } },
  floor: { min: 1, max: 1, signature: 'floor(n)', zh: '向下取整', apply: ([v]) => Math.floor(asNumber(v)) },
  ceil: { min: 1, max: 1, signature: 'ceil(n)', zh: '向上取整', apply: ([v]) => Math.ceil(asNumber(v)) },
  min: { min: 1, signature: 'min(...|arr)', zh: '最小值', apply: (args) => numericFlat(args).reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY) },
  max: { min: 1, signature: 'max(...|arr)', zh: '最大值', apply: (args) => numericFlat(args).reduce((a, b) => (b > a ? b : a), Number.NEGATIVE_INFINITY) },
  sum: { min: 1, signature: 'sum(...|arr)', zh: '求和', apply: (args) => numericFlat(args).reduce((a, b) => a + b, 0) },
  avg: { min: 1, signature: 'avg(...|arr)', zh: '平均值', apply: (args) => { const list = numericFlat(args); return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null; } },
  keys: { min: 1, max: 1, signature: 'keys(obj|rows)', zh: '键名数组', apply: ([v]) => collectKeys(v) },
  values: { min: 1, max: 1, signature: 'values(obj)', zh: '值数组', apply: ([v]) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v as Record<string, ExprValue>) : Array.isArray(v) ? v : []) },
  pick: { min: 1, max: 2, signature: "pick(obj, 'a,b')", zh: '只保留这些列', apply: ([obj, list]) => keepKeys(obj, toKeyList(list)) },
  omit: { min: 1, max: 2, signature: "omit(obj, 'a,b')", zh: '去掉这些列', apply: ([obj, list]) => dropKeys(obj, toKeyList(list)) },
  type_of: { min: 1, max: 1, signature: 'type_of(v)', zh: '值类型名', apply: ([v]) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v) },
  to_array: { min: 1, max: 1, signature: 'to_array(v)', zh: '非数组包装成单元素数组', apply: ([v]) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]) },
  now: { min: 0, max: 0, signature: 'now()', zh: '当前时间 ISO 文本', apply: () => new Date().toISOString() },
  date: { min: 1, max: 1, signature: 'date(v)', zh: '转日期，失败为 null', apply: ([v]) => { const d = asDate(v); return d ? d.toISOString() : null; } },
  date_part: { min: 2, max: 2, signature: "date_part(v, 'year|month|day|hour')", zh: '取日期分量', apply: ([v, part]) => { const d = asDate(v); if (!d) return null; switch (asString(part)) { case 'year': return d.getFullYear(); case 'month': return d.getMonth() + 1; case 'day': return d.getDate(); case 'hour': return d.getHours(); case 'minute': return d.getMinutes(); default: return null; } } },
  date_format: { min: 1, max: 2, signature: "date_format(v, 'date'|'iso'|'time')", zh: '格式化日期', apply: ([v, kind]) => { const d = asDate(v); if (!d) return null; switch (asString(kind ?? 'date')) { case 'iso': return d.toISOString(); case 'time': return d.toISOString().slice(11, 19); default: return d.toISOString().slice(0, 10); } } },
  days_between: { min: 2, max: 2, signature: 'days_between(a, b)', zh: '相差天数（b-a）', apply: ([a, b]) => { const x = asDate(a); const y = asDate(b); if (!x || !y) return null; return Math.round((y.getTime() - x.getTime()) / 86400000); } },
};

function toKeyList(list: ExprValue): string[] {
  if (Array.isArray(list)) return list.map(asString).filter(Boolean);
  return asString(list).split(',').map((item) => item.trim()).filter(Boolean);
}

function keepKeys(value: ExprValue, keys: string[]): ExprValue {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => keepKeys(item, keys));
  const keep = keys.length ? keys : collectKeys(value);
  const source = value as Record<string, ExprValue>;
  const result: Record<string, ExprValue> = {};
  for (const key of keep) if (key in source) result[key] = source[key];
  return result;
}

function numericFlat(args: ExprValue[]): number[] {
  const out: number[] = [];
  const push = (value: ExprValue) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const n = asNumber(value);
    if (!Number.isNaN(n)) out.push(n);
  };
  for (const arg of args) push(arg);
  return out;
}

function evaluate(node: ExprNode, scope: ExprScope): ExprValue {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'current':
      return scope.current;
    case 'root':
      return scope.root;
    case 'name':
      return readProperty(scope.root, node.name);
    case 'member':
      return readProperty(evaluate(node.target, scope), node.key);
    case 'index': {
      const target = evaluate(node.target, scope);
      const index = evaluate(node.index, scope);
      if (Array.isArray(target)) {
        const n = asNumber(index);
        return target[n < 0 ? target.length + n : n];
      }
      return readProperty(target, asString(index));
    }
    case 'unary':
      return node.op === '!' ? !asBoolean(evaluate(node.operand, scope)) : -asNumber(evaluate(node.operand, scope));
    case 'ternary':
      return asBoolean(evaluate(node.cond, scope)) ? evaluate(node.yes, scope) : evaluate(node.no, scope);
    case 'array':
      return node.items.map((item) => evaluate(item, scope));
    case 'object': {
      const result: Record<string, ExprValue> = {};
      for (const entry of node.entries) result[entry.key] = evaluate(entry.value, scope);
      return result;
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`未知函数：${node.name}()`);
      if (node.args.length < fn.min || (fn.max !== undefined && node.args.length > fn.max)) {
        throw new Error(`${node.name}() 参数数量不对，应为 ${fn.signature}`);
      }
      return fn.apply(node.args.map((arg) => evaluate(arg, scope)), scope);
    }
    case 'binary':
      return evaluateBinary(node.op, node.left, node.right, scope);
    default:
      throw new Error('无法求值的表达式节点');
  }
}

function evaluateBinary(op: string, leftNode: ExprNode, rightNode: ExprNode, scope: ExprScope): ExprValue {
  if (op === '&&') return asBoolean(evaluate(leftNode, scope)) ? evaluate(rightNode, scope) : false;
  if (op === '||') {
    const left = evaluate(leftNode, scope);
    return asBoolean(left) ? left : evaluate(rightNode, scope);
  }
  if (op === '??') {
    const left = evaluate(leftNode, scope);
    return left === null || left === undefined ? evaluate(rightNode, scope) : left;
  }
  const left = evaluate(leftNode, scope);
  const right = evaluate(rightNode, scope);
  switch (op) {
    case '==':
      return looseEqual(left, right);
    case '!=':
      return !looseEqual(left, right);
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const order = compare(left, right);
      if (order === null) return false;
      return op === '<' ? order < 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : order >= 0;
    }
    case 'in': {
      if (Array.isArray(right)) return right.some((item) => looseEqual(left, item));
      if (typeof right === 'string') return asString(left) !== '' && right.includes(asString(left));
      if (right && typeof right === 'object') return readProperty(right, asString(left)) !== undefined;
      return false;
    }
    case '+': {
      if (typeof left === 'string' || typeof right === 'string') return asString(left) + asString(right);
      if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
      return asNumber(left) + asNumber(right);
    }
    case '-':
      return asNumber(left) - asNumber(right);
    case '*':
      return asNumber(left) * asNumber(right);
    case '/': {
      const divisor = asNumber(right);
      return divisor === 0 ? null : asNumber(left) / divisor;
    }
    case '%': {
      const divisor = asNumber(right);
      return divisor === 0 ? null : asNumber(left) % divisor;
    }
    default:
      throw new Error(`不支持的运算符：${op}`);
  }
}

const FUNCTIONS = EXPRESSION_FUNCTIONS;

const compiled = new Map<string, ExprNode>();

/** 解析并缓存；语法错误在这里抛出，调用方负责转成用户可读提示。 */
export function compileExpression(source: string): ExprNode {
  const hit = compiled.get(source);
  if (hit) return hit;
  const node = new Parser(tokenize(source)).parse();
  if (compiled.size > 4000) compiled.clear();
  compiled.set(source, node);
  return node;
}

export function evaluateExpression(source: string, scope: ExprScope): ExprValue {
  return evaluate(compileExpression(source), scope);
}

export function checkExpression(source: string): string | null {
  try {
    compileExpression(source);
    return null;
  } catch (err: any) {
    return err?.message ?? '表达式语法错误';
  }
}

/** 给契约与 Agent 提示用的一行函数清单。 */
export function describeExpressionFunctions(locale: 'zh' | 'en' = 'zh'): string {
  return Object.values(EXPRESSION_FUNCTIONS)
    .map((fn) => (locale === 'zh' ? `${fn.signature} ${fn.zh}` : fn.signature))
    .join('; ');
}

export function truthy(value: ExprValue): boolean {
  return asBoolean(value);
}
