import type { AppLocale } from './types';

export interface LocaleInfo {
  id: AppLocale;
  /** 语言自身的名称，用于语言选择器。 */
  native: string;
  /** 英文名称，便于搜索。 */
  english: string;
  dir: 'ltr' | 'rtl';
}

/** 支持的界面语言。顺序即语言选择器的展示顺序，英语始终在前。 */
export const APP_LOCALES: LocaleInfo[] = [
  { id: 'en', native: 'English', english: 'English', dir: 'ltr' },
  { id: 'zh-CN', native: '简体中文', english: 'Chinese (Simplified)', dir: 'ltr' },
  { id: 'zh-TW', native: '繁體中文', english: 'Chinese (Traditional)', dir: 'ltr' },
  { id: 'ja', native: '日本語', english: 'Japanese', dir: 'ltr' },
  { id: 'ko', native: '한국어', english: 'Korean', dir: 'ltr' },
  { id: 'de', native: 'Deutsch', english: 'German', dir: 'ltr' },
  { id: 'fr', native: 'Français', english: 'French', dir: 'ltr' },
  { id: 'es', native: 'Español', english: 'Spanish', dir: 'ltr' },
  { id: 'pt-BR', native: 'Português (Brasil)', english: 'Portuguese (Brazil)', dir: 'ltr' },
  { id: 'it', native: 'Italiano', english: 'Italian', dir: 'ltr' },
  { id: 'ru', native: 'Русский', english: 'Russian', dir: 'ltr' },
  { id: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl' },
  { id: 'hi', native: 'हिन्दी', english: 'Hindi', dir: 'ltr' },
  { id: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', dir: 'ltr' },
  { id: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', dir: 'ltr' },
  { id: 'th', native: 'ไทย', english: 'Thai', dir: 'ltr' },
  { id: 'tr', native: 'Türkçe', english: 'Turkish', dir: 'ltr' },
  { id: 'nl', native: 'Nederlands', english: 'Dutch', dir: 'ltr' },
  { id: 'pl', native: 'Polski', english: 'Polish', dir: 'ltr' },
  { id: 'uk', native: 'Українська', english: 'Ukrainian', dir: 'ltr' },
];

const LOCALE_ALIASES: Record<string, AppLocale> = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-tw': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-hant': 'zh-TW',
  pt: 'pt-BR',
  'pt-br': 'pt-BR',
  in: 'id',
  iw: 'ar',
};

const LOCALE_IDS = new Set<string>(APP_LOCALES.map((item) => item.id));

/** 读取旧设置（zh/pt）或浏览器语言时统一到受支持的 locale，无法识别时回退英语。 */
export function normalizeLocale(value: unknown): AppLocale {
  if (typeof value !== 'string' || !value.trim()) return 'en';
  const raw = value.trim();
  if (LOCALE_IDS.has(raw)) return raw as AppLocale;
  const lower = raw.toLowerCase();
  if (LOCALE_ALIASES[lower]) return LOCALE_ALIASES[lower];
  const base = lower.split(/[-_]/)[0];
  if (base && LOCALE_IDS.has(base)) return base as AppLocale;
  if (base === 'zh') return 'zh-CN';
  if (base === 'pt') return 'pt-BR';
  return 'en';
}

export function localeInfo(id: AppLocale): LocaleInfo {
  return APP_LOCALES.find((item) => item.id === id) ?? APP_LOCALES[0];
}

export function isRtlLocale(id: AppLocale): boolean {
  return localeInfo(id).dir === 'rtl';
}
