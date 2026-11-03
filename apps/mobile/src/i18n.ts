import en from './i18n.en.json';

export type Locale = 'zh' | 'en';

let locale: Locale = 'zh';
const dictionary = en as Record<string, string>;

export function setLocale(next: Locale): void {
  locale = next;
}

export function getLocale(): Locale {
  return locale;
}

/** 精确词条优先，其次处理带数量的动态文案；未命中时保持中文。 */
export function translate(text: string): string {
  if (locale !== 'en') return text;
  const hit = dictionary[text];
  if (hit) return hit;
  let out = text;
  const rules: Array<[RegExp, string]> = [
    [/^\s*个对象$/, ' objects'],
    [/^\s*个库$/, ' databases'],
    [/^\s*个会话$/, ' sessions'],
    [/^\s*个账户$/, ' accounts'],
    [/^\s*张表$/, ' tables'],
    [/^\s*条记忆$/, ' memories'],
    [/^\s*次工具$/, ' tool calls'],
    [/^\s*行$/, ' rows'],
    [/^\s*列$/, ' columns'],
    [/^\s*条$/, ' items'],
    [/(\d[\d,]*)\s*个对象/g, '$1 objects'],
    [/(\d[\d,]*)\s*个库/g, '$1 databases'],
    [/(\d[\d,]*)\s*个会话/g, '$1 sessions'],
    [/(\d[\d,]*)\s*个账户/g, '$1 accounts'],
    [/(\d[\d,]*)\s*张表/g, '$1 tables'],
    [/(\d[\d,]*)\s*条记忆/g, '$1 memories'],
    [/(\d[\d,]*)\s*次工具/g, '$1 tool calls'],
    [/(\d[\d,]*)\s*行/g, '$1 rows'],
    [/(\d[\d,]*)\s*列/g, '$1 columns'],
    [/(\d[\d,]*)\s*条/g, '$1 items'],
    [/个对象/g, ' objects'],
    [/条记忆/g, ' memories'],
  ];
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}
