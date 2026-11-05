import { APP_LOCALES, isRtlLocale, normalizeLocale, type AppLocale } from '@aidb/core';
import ar from './i18n/ar.json';
import de from './i18n/de.json';
import en from './i18n/en.json';
import es from './i18n/es.json';
import fr from './i18n/fr.json';
import hi from './i18n/hi.json';
import id from './i18n/id.json';
import it from './i18n/it.json';
import ja from './i18n/ja.json';
import ko from './i18n/ko.json';
import nl from './i18n/nl.json';
import pl from './i18n/pl.json';
import ptBR from './i18n/pt-BR.json';
import ru from './i18n/ru.json';
import th from './i18n/th.json';
import tr from './i18n/tr.json';
import uk from './i18n/uk.json';
import vi from './i18n/vi.json';
import zhTW from './i18n/zh-TW.json';

export type Locale = AppLocale;
export const LOCALES = APP_LOCALES;

const catalogs: Record<Exclude<AppLocale, 'zh-CN'>, Record<string, string>> = {
  en: en as Record<string, string>,
  'zh-TW': zhTW as Record<string, string>,
  ja: ja as Record<string, string>,
  ko: ko as Record<string, string>,
  de: de as Record<string, string>,
  fr: fr as Record<string, string>,
  es: es as Record<string, string>,
  'pt-BR': ptBR as Record<string, string>,
  it: it as Record<string, string>,
  ru: ru as Record<string, string>,
  ar: ar as Record<string, string>,
  hi: hi as Record<string, string>,
  id: id as Record<string, string>,
  vi: vi as Record<string, string>,
  th: th as Record<string, string>,
  tr: tr as Record<string, string>,
  nl: nl as Record<string, string>,
  pl: pl as Record<string, string>,
  uk: uk as Record<string, string>,
};

let locale: AppLocale = 'en';

export function setLocale(next: unknown): AppLocale {
  locale = normalizeLocale(next);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
  }
  return locale;
}

/** 取当前语言：有些文案来自运行时的双语目录（不是源码字面量），只能就地二选一。 */
export function currentLocale(): AppLocale {
  return locale;
}

function lookup(language: AppLocale, text: string): string | undefined {
  if (language === 'zh-CN') return text;
  const catalog = catalogs[language];
  const direct = catalog?.[text];
  if (direct !== undefined) return direct;
  const core = text.trim();
  if (!core || core === text) return undefined;
  const hit = catalog?.[core];
  if (hit === undefined) return undefined;
  const lead = text.slice(0, text.indexOf(core));
  const trail = text.slice(text.indexOf(core) + core.length);
  return lead + hit + trail;
}

const COUNT_UNITS = [
  '个对象',
  '个数据库',
  '个库',
  '个会话',
  '个账户',
  '张有行数估算',
  '张无主键',
  '张卡片',
  '张视图',
  '张表',
  '条记忆',
  '次工具',
  '个文件',
  '个模型',
  '条语句',
  '行已写入',
  '分钟前',
  '小时前',
  '天前',
  '行',
  '列',
  '条',
  '个',
  '次',
  '张',
  '项',
];
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function phraseFallback(language: AppLocale, text: string): string | undefined {
  let out = text;
  for (const unit of COUNT_UNITS) {
    const re = new RegExp(`(\\d[\\d,.]*)\\s*${escapeRe(unit)}`, 'g');
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const unitText = lookup(language, unit) ?? lookup('en', unit) ?? unit;
    out = out.replace(re, (_whole, count: string) => `${count} ${unitText.trim()}`);
  }
  return out === text ? undefined : out;
}

/** 整句查表优先；命中不到时按数字+量词替换，最后回退英文或原文。 */
export function translate(text: string, vars?: Array<string | number | null | undefined>): string {
  if (!text) return text;
  if (locale === 'zh-CN') return interpolate(text, vars);
  let out = lookup(locale, text);
  if (out === undefined && locale !== 'zh-TW') out = lookup('en', text);
  if (out === undefined) out = phraseFallback(locale, text);
  return interpolate(out ?? text, vars);
}

function interpolate(text: string, vars?: Array<string | number | null | undefined>): string {
  if (!vars) return text;
  return text.replace(/\{(\d+)\}/g, (_whole, index: string) => {
    const value = vars[Number(index)];
    return value === undefined || value === null ? '' : String(value);
  });
}
