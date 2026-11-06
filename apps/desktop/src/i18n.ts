import { APP_LOCALES, isRtlLocale, normalizeLocale, type AppLocale } from '@aidb/core';
import { en as legacyEn, zh as legacyZh } from './i18n/legacy';
import en from './i18n/locales/en.json';

export type Locale = AppLocale;
export type I18nKey = keyof typeof legacyZh;
export type I18nVars = Record<string, string | number | null | undefined> | Array<string | number | null | undefined>;

export const LOCALES = APP_LOCALES;

const catalogModule = (value: unknown): Record<string, string> => ((value as { default?: Record<string, string> })?.default ?? value) as Record<string, string>;

/**
 * 除英文外的 18 套目录各自 ~270KB，全部静态引入会让首屏 JS 膨胀到 7MB。
 * 目录按语言切分后只在启动时取当前语言那一份；未加载完成时 translate
 * 自动退到英文目录，再退到中文源文，不会白屏。
 */
const localeLoaders: Partial<Record<Exclude<AppLocale, 'zh-CN' | 'en'>, () => Promise<Record<string, string>>>> = {
  'zh-TW': async () => catalogModule(await import('./i18n/locales/zh-TW.json')),
  ja: async () => catalogModule(await import('./i18n/locales/ja.json')),
  ko: async () => catalogModule(await import('./i18n/locales/ko.json')),
  de: async () => catalogModule(await import('./i18n/locales/de.json')),
  fr: async () => catalogModule(await import('./i18n/locales/fr.json')),
  es: async () => catalogModule(await import('./i18n/locales/es.json')),
  'pt-BR': async () => catalogModule(await import('./i18n/locales/pt-BR.json')),
  it: async () => catalogModule(await import('./i18n/locales/it.json')),
  ru: async () => catalogModule(await import('./i18n/locales/ru.json')),
  ar: async () => catalogModule(await import('./i18n/locales/ar.json')),
  hi: async () => catalogModule(await import('./i18n/locales/hi.json')),
  id: async () => catalogModule(await import('./i18n/locales/id.json')),
  vi: async () => catalogModule(await import('./i18n/locales/vi.json')),
  th: async () => catalogModule(await import('./i18n/locales/th.json')),
  tr: async () => catalogModule(await import('./i18n/locales/tr.json')),
  nl: async () => catalogModule(await import('./i18n/locales/nl.json')),
  pl: async () => catalogModule(await import('./i18n/locales/pl.json')),
  uk: async () => catalogModule(await import('./i18n/locales/uk.json')),
};

const catalogs: Partial<Record<Exclude<AppLocale, 'zh-CN'>, Record<string, string>>> = {
  en: en as Record<string, string>,
};
const catalogLoads = new Map<AppLocale, Promise<void>>();

/** 装载当前界面语言的翻译目录；重复调用共享同一份 Promise。 */
export function ensureLocaleCatalog(locale: unknown): Promise<void> {
  const active = normalizeLocale(locale);
  if (active === 'zh-CN' || catalogs[active as Exclude<AppLocale, 'zh-CN'>]) return Promise.resolve();
  const pending = catalogLoads.get(active);
  if (pending) return pending;
  const load = localeLoaders[active as keyof typeof localeLoaders]?.()
    .then((catalog) => {
      catalogs[active as Exclude<AppLocale, 'zh-CN'>] = catalog;
    })
    .catch(() => {
      // 取不到就先用英文兜底，但留下一次重试机会（网络抖动不该把语言永久钉死）。
      catalogLoads.delete(active);
    });
  if (!load) return Promise.resolve();
  catalogLoads.set(active, load);
  return load;
}

const legacyZhMap = legacyZh as Record<string, string>;
const legacyEnMap = legacyEn as Record<string, string>;
const CJK = /[\u4e00-\u9fff]/;

const LOCALE_CACHE_KEY = 'aidb.locale';

function readCachedLocale(): AppLocale {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_CACHE_KEY) ?? 'en');
  } catch {
    return 'en';
  }
}

/**
 * 模块级常量（图表类型、引擎分组、工具卡片）在 import 时就会翻译一次，
 * 所以语言要先于设置到达：用 localStorage 缓存上次的选择。
 */
let currentLocale: AppLocale = readCachedLocale();

export function getI18nLocale(): AppLocale {
  return currentLocale;
}

export function setI18nLocale(next: unknown): AppLocale {
  currentLocale = normalizeLocale(next);
  void ensureLocaleCatalog(currentLocale);
  try {
    localStorage.setItem(LOCALE_CACHE_KEY, currentLocale);
  } catch {
    /* 隐私模式写不进去也不影响使用 */
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = currentLocale;
    document.documentElement.dir = isRtlLocale(currentLocale) ? 'rtl' : 'ltr';
  }
  return currentLocale;
}

setI18nLocale(currentLocale);

function lookupRaw(locale: AppLocale, message: string): string | undefined {
  if (locale !== 'zh-CN') {
    const catalog = catalogs[locale];
    const hit = catalog?.[message];
    if (hit !== undefined) return hit;
  }
  if (message in legacyZhMap) {
    if (locale === 'zh-CN' || locale === 'zh-TW') return legacyZhMap[message];
    if (locale === 'en') return legacyEnMap[message];
  }
  return undefined;
}

function lookupWhitespace(locale: AppLocale, message: string): string | undefined {
  const direct = lookupRaw(locale, message);
  if (direct !== undefined) return direct;
  const core = message.trim();
  if (!core || core === message) return undefined;
  const hit = lookupRaw(locale, core);
  if (hit === undefined) return undefined;
  const lead = message.slice(0, message.indexOf(core));
  const trail = message.slice(message.indexOf(core) + core.length);
  return lead + hit + trail;
}

function interpolate(text: string, vars?: I18nVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = Array.isArray(vars) ? vars[Number(key)] : vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
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
  '条配置',
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

function phraseFallback(locale: AppLocale, message: string): string | undefined {
  if (!CJK.test(message)) return undefined;
  let out = message;
  for (const unit of COUNT_UNITS) {
    const re = new RegExp(`(\\d[\\d,.]*)\\s*${escapeRe(unit)}`, 'g');
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const unitText =
      lookupWhitespace(locale, unit) ??
      (locale !== 'zh-CN' ? lookupWhitespace('en', unit) : undefined) ??
      unit;
    out = out.replace(re, (_whole, count: string) => `${count} ${unitText.trim()}`);
  }
  return out === message ? undefined : out;
}

export function translate(locale: AppLocale | string, message: string, vars?: I18nVars): string {
  const active = normalizeLocale(locale);
  if (!message) return message;
  if (active === 'zh-CN') return interpolate(lookupWhitespace(active, message) ?? message, vars);

  let out = lookupWhitespace(active, message);
  if (out === undefined && active !== 'zh-TW') {
    out = lookupWhitespace('en', message);
  }
  if (out === undefined && active === 'zh-TW') {
    out = message;
  }
  if (out === undefined) {
    out = phraseFallback(active, message);
  }
  return interpolate(out ?? message, vars);
}

/** 当前界面语言的翻译入口。语言切换后需重新渲染或重新加载以刷新模块级文案。 */
export function t(message: string, vars?: I18nVars): string {
  return translate(currentLocale, message, vars);
}
