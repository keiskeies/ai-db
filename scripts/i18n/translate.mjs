import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DATA = path.join(ROOT, 'scripts/i18n/data');
const PROXY = process.env.I18N_PROXY || 'http://127.0.0.1:7890';
const MARKER = '\n@@AIDB@@\n';
const CONCURRENCY = Number(process.env.I18N_CONCURRENCY || 2);

const locales = process.argv.includes('--all')
  ? ['en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt-BR', 'it', 'ru', 'ar', 'hi', 'id', 'vi', 'th', 'tr', 'nl', 'pl', 'uk']
  : (process.argv.find((arg) => arg.startsWith('--locales='))?.slice('--locales='.length).split(',') ?? ['en']);

const sources = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/i18n/overrides-en.json'), 'utf8'));
const senseMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/i18n/sense-en.json'), 'utf8'));
/** 裸英文单词在小语种里歧义很大（Run→走る），翻译目标语言时先注入语境，再剥掉括号注释。 */
const plainToAnnotated = {};
for (const annotated of Object.values(senseMap)) {
  const plain = annotated.replace(/\s*\([^()]*\)\s*$/, '');
  if (plain !== annotated && !plainToAnnotated[plain]) plainToAnnotated[plain] = annotated;
}
const stripSense = (value) => value.replace(/\s*[（(][^（）()]*[)）]\s*$/, '').trim();
const mobileEnglish = sources.mobileEnglish;
const legacyZh = sources.legacyZh;
const legacyEn = sources.legacyEn;

const jsxKeys = new Set(sources.jsx);
const desktopKeys = [...new Set([...sources.desktop, ...Object.keys(legacyZh)])];
const mobileKeys = [...new Set([...sources.mobile, ...Object.keys(mobileEnglish)])];

const legacyZhToEn = {};
for (const [key, zh] of Object.entries(legacyZh)) {
  if (legacyEn[key]) legacyZhToEn[zh] = legacyEn[key];
}

const trimEdges = (text) => {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return { lead: match[1], core: match[2], trail: match[3] };
};

const CJK = /[\u4e00-\u9fff]/;
const KEEP_AS_IS = new Set([
  'AI', 'Agent', 'AiDB', 'Bridge', 'SQL', 'MCP', 'API', 'URL', 'CSV', 'JSON', 'DDL', 'PNG', 'SVG', 'SSH',
  'HTTP', 'HTTPS', 'PDF', 'Excel', 'PPT', 'Redis', 'MongoDB', 'MySQL', 'PostgreSQL', 'SQLite', 'Oracle',
  'DuckDB', 'ClickHouse', 'Elasticsearch', 'Neo4j', 'Qdrant', 'Milvus', 'Weaviate', 'ArangoDB', 'Cassandra',
  'FalkorDB', 'InfluxDB', 'MariaDB', 'OpenAI', 'Anthropic', 'Claude', 'GPT', 'Webhook', 'Token', 'Skill',
]);

function protectBrands(text) {
  const tokens = [];
  let out = text;
  const brands = [...KEEP_AS_IS].sort((a, b) => b.length - a.length);
  for (const brand of brands) {
    const re = new RegExp(`(^|[^A-Za-z0-9])(${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[^A-Za-z0-9]|$)`, 'g');
    out = out.replace(re, (_whole, prefix) => {
      const token = `AIDBTOKEN${tokens.length}AIDB`;
      tokens.push({ token, brand });
      return prefix + token;
    });
  }
  return { text: out, tokens };
}

function restoreBrands(text, tokens) {
  let out = text;
  for (const { token, brand } of tokens) out = out.split(token).join(brand);
  return out;
}

function cacheFile(locale) {
  return path.join(DATA, `cache-${locale}.json`);
}

function loadCache(locale) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(locale), 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(locale, cache) {
  fs.writeFileSync(cacheFile(locale), JSON.stringify(cache, null, 0));
}

const BING_LANG = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'pt-BR': 'pt',
};

let bingSession = null;
let googleBlocked = false;

async function getBingSession(force = false) {
  if (!force && bingSession && Date.now() - bingSession.at < 45 * 60_000) return bingSession;
  const args = ['-sL', ...(PROXY ? ['-x', PROXY] : []), 'https://www.bing.com/translator', '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'];
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  const ig = /IG:"([^"]+)"/.exec(stdout)?.[1];
  const helper = /params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",\d+\]/.exec(stdout);
  const iid = /data-iid="(translator\.\d+)"/.exec(stdout)?.[1] ?? 'translator.5023';
  if (!ig || !helper) throw new Error('bing session tokens missing');
  bingSession = { ig, key: helper[1], token: helper[2], iid, at: Date.now() };
  return bingSession;
}

async function requestBing(text, from, to) {
  const source = BING_LANG[from] ?? from;
  const target = BING_LANG[to] ?? to;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await getBingSession(attempt > 0);
    const url = `https://cn.bing.com/ttranslatev3?isVertical=1&&IG=${session.ig}&IID=${session.iid}.1`;
    const args = [
      '-s',
      ...(PROXY ? ['-x', PROXY] : []),
      '-X',
      'POST',
      url,
      '-H',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '--data-urlencode',
      `fromLang=${source}`,
      '--data-urlencode',
      `to=${target}`,
      '--data-urlencode',
      `text=${text}`,
      '--data-urlencode',
      `token=${session.token}`,
      '--data-urlencode',
      `key=${session.key}`,
    ];
    try {
      const { stdout } = await execFileAsync('curl', args, { maxBuffer: 32 * 1024 * 1024, timeout: 90000 });
      const data = JSON.parse(stdout);
      const translated = data?.[0]?.translations?.[0]?.text;
      if (typeof translated !== 'string' || !translated) throw new Error('bing empty translation');
      return translated;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw lastError ?? new Error('bing translation failed');
}

async function requestTranslate(text, from, to) {
  if (process.env.I18N_PROVIDER === 'bing' || googleBlocked) return requestBing(text, from, to);
  try {
    return await requestGoogle(text, from, to);
  } catch (error) {
    googleBlocked = true;
    console.log('google unavailable, switching to bing');
    return requestBing(text, from, to);
  }
}

async function requestGoogle(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single';
  const base = ['-s', '--get', url, '--data-urlencode', 'client=gtx', '--data-urlencode', `sl=${from}`, '--data-urlencode', `tl=${to}`, '--data-urlencode', 'dt=t', '--data-urlencode', `q=${text}`, '-H', 'User-Agent: Mozilla/5.0'];
  const attempts = [PROXY ? ['-x', PROXY, ...base] : base, base];
  let lastError;
  for (const args of attempts) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { stdout } = await execFileAsync('curl', args, { maxBuffer: 32 * 1024 * 1024, timeout: 90000 });
        const data = JSON.parse(stdout);
        return data[0].map((segment) => segment[0]).join('');
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error('translation request failed');
}

function chunkTexts(texts, maxChars = Number(process.env.I18N_BATCH_CHARS || 2600), maxItems = Number(process.env.I18N_BATCH_ITEMS || 28)) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const text of texts) {
    if (current.length && (chars + text.length > maxChars || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function placeholderSet(text) {
  return new Set([...text.matchAll(/\{\w+\}/g)].map((match) => match[0]));
}

function validTranslation(source, translated) {
  if (!translated || !translated.trim()) return false;
  const sourcePlaceholders = placeholderSet(source);
  const targetPlaceholders = placeholderSet(translated);
  if (sourcePlaceholders.size !== targetPlaceholders.size) return false;
  for (const placeholder of sourcePlaceholders) if (!targetPlaceholders.has(placeholder)) return false;
  return true;
}

async function translateOne(text, from, to) {
  const { text: protectedText, tokens } = protectBrands(text);
  let translated;
  try {
    translated = await requestTranslate(protectedText, from, to);
  } catch (error) {
    if (tokens.length) {
      try {
        translated = await requestTranslate(text, from, to);
        tokens.length = 0;
      } catch {
        throw error;
      }
    } else {
      throw error;
    }
  }
  if (tokens.length && /AIDBTOKEN\d+AIDB/.test(translated)) {
    translated = restoreBrands(translated, tokens);
  }
  return translated.replace(/\u00a0/g, ' ').trim();
}

async function translateBatch(texts, from, to, cache, label, cacheName) {
  const unique = [...new Set(texts)].filter((text) => text && text.trim());
  const missing = unique.filter((text) => cache[text] === undefined);
  const chunks = chunkTexts(missing);
  let done = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (chunks.length) {
      const chunk = chunks.shift();
      try {
        const parts = chunk.map((item) => protectBrands(item));
        const payload = parts.map((part) => part.text).join(MARKER);
        let translated = await requestTranslate(payload, from, to);
        let pieces = translated.split(MARKER);
        if (pieces.length !== chunk.length) {
          pieces = [];
          for (const item of chunk) pieces.push(await translateOne(item, from, to));
          pieces = parts.map((part, index) => restoreBrands(pieces[index] ?? '', part.tokens));
        } else {
          pieces = parts.map((part, index) => restoreBrands(pieces[index] ?? '', part.tokens));
        }
        pieces = pieces.map((piece) => piece.replace(/\u00a0/g, ' ').replace(/^\n+|\n+$/g, '').trim());
        chunk.forEach((source, index) => {
          const target = pieces[index];
          cache[source] = validTranslation(source, target) ? target : undefined;
          if (cache[source] === undefined) delete cache[source];
        });
      } catch (error) {
        for (const source of chunk) {
          try {
            const target = await translateOne(source, from, to);
            cache[source] = validTranslation(source, target) ? target : undefined;
            if (cache[source] === undefined) delete cache[source];
          } catch {
            /* keep missing for a later run */
          }
        }
      }
      done += chunk.length;
      saveCache(cacheName, cache);
      if (done % 140 < chunk.length) console.log(`  ${label}: ${done}/${missing.length}`);
    }
  });
  await Promise.all(workers);
  const failed = missing.filter((text) => cache[text] === undefined);
  if (failed.length) console.log(`  ${label}: ${failed.length} untranslated`);
  return cache;
}

function capitalizeEnglish(text) {
  if (!text) return text;
  if (/^[a-z]/.test(text)) return text[0].toUpperCase() + text.slice(1);
  return text;
}

const LOWER_AFTER_PLACEHOLDER = new Set([
  'minutes', 'hours', 'days', 'seconds', 'rows', 'items', 'files', 'tables', 'objects', 'sessions',
  'accounts', 'tools', 'models', 'cards', 'statements', 'entries', 'views', 'messages', 'results',
  'records', 'selected', 'file', 'row', 'table',
]);

function adjustEnglishSentence(key, value) {
  const { core } = trimEdges(key);
  if (!/^\{\w+\}/.test(core) || !value) return value;
  return value.replace(/^(\{\w+\}[\s:：·()\-]*)([A-Za-z][a-z]+)/, (whole, prefix, word) =>
    LOWER_AFTER_PLACEHOLDER.has(word.toLowerCase()) ? prefix + word.toLowerCase() : whole,
  );
}

function buildEnglish() {
  const cache = loadCache('en');
  const pending = [];
  const values = {};
  const keys = [...new Set([...desktopKeys, ...mobileKeys])];
  for (const key of keys) {
    if (legacyEn[key]) {
      values[key] = legacyEn[key];
      continue;
    }
    const { core } = trimEdges(key);
    const preset = overrides[core] ?? mobileEnglish[core] ?? legacyZhToEn[core];
    if (preset !== undefined) values[key] = preset;
    else if (core) pending.push(core);
  }
  return { values, pending: [...new Set(pending)], cache, keys };
}

function applyWhitespace(key, coreTranslation) {
  const { lead, trail } = trimEdges(key);
  if (!coreTranslation) return coreTranslation;
  return lead + coreTranslation.replace(/^\s+|\s+$/g, '') + trail;
}

/** 中文源码里的全角标点会跟着进入译文；除中日文外统一换成半角标点。 */
const FULLWIDTH = [
  ['（', ' ('],
  ['）', ') '],
  ['：', ': '],
  ['，', ', '],
  ['；', '; '],
  ['、', ', '],
  ['！', '!'],
  ['？', '?'],
  ['。', '. '],
];
const KEEP_FULLWIDTH = new Set(['zh-CN', 'zh-TW', 'ja']);

function normalizePunctuation(locale, value) {
  if (!value || KEEP_FULLWIDTH.has(locale)) return value;
  let out = value;
  for (const [from, to] of FULLWIDTH) out = out.split(from).join(to);
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

function writeJson(file, object) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = {};
  for (const key of Object.keys(object).sort()) sorted[key] = object[key];
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
}

/** 目标语言的翻译源：中文直译（zh-TW）或带语境的英文，避免裸词歧义。 */
function mtSource(key, englishValues, fromZh) {
  if (fromZh) return { text: legacyZh[key] ?? key, annotated: false };
  const edges = trimEdges(key);
  const annotated = senseMap[edges.core];
  if (annotated) return { text: edges.lead + annotated + edges.trail, annotated: true };
  const base = englishValues[key] ?? key;
  const plain = base.trim();
  if (plainToAnnotated[plain]) {
    const baseEdges = trimEdges(base);
    return { text: baseEdges.lead + plainToAnnotated[plain] + baseEdges.trail, annotated: true };
  }
  return { text: base, annotated: false };
}

async function buildLocale(locale, englishValues) {
  const isEnglish = locale === 'en';
  const fromZh = locale === 'zh-TW';
  const cache = isEnglish ? loadCache('en') : loadCache(locale);
  if (!isEnglish) {
    const pending = [];
    for (const key of [...desktopKeys, ...mobileKeys]) {
      const { text: source } = mtSource(key, englishValues, fromZh);
      const { core } = trimEdges(source);
      if (!core || cache[core] !== undefined) continue;
      if (!fromZh && KEEP_AS_IS.has(core)) {
        cache[core] = core;
        continue;
      }
      if (!fromZh && !/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0900-\u097F]/.test(core)) {
        cache[core] = core;
        continue;
      }
      pending.push(core);
    }
    await translateBatch(pending, fromZh ? 'zh-CN' : 'en', locale === 'pt-BR' ? 'pt' : locale, cache, locale, locale);
  }

  const resolve = (key, source, annotated, fallback) => {
    const { core } = trimEdges(source);
    let value = cache[core];
    if (!value) return fallback;
    if (annotated) value = stripSense(value);
    // 机翻偶尔会把汉字混进非汉字语言（如印地语），这类条目退回英文而不是留下脏译文。
    if (!KEEP_FULLWIDTH.has(locale) && /[一-鿿]/.test(value)) return fallback;
    return applyWhitespace(key, normalizePunctuation(locale, value));
  };

  const desktopCatalog = {};
  for (const key of desktopKeys) {
    if (isEnglish) {
      desktopCatalog[key] = normalizePunctuation('en', legacyEn[key] ?? englishValues[key] ?? key);
      continue;
    }
    const { text: source, annotated } = mtSource(key, englishValues, fromZh);
    desktopCatalog[key] = resolve(key, source, annotated, fromZh ? key : source);
  }
  writeJson(path.join(ROOT, 'apps/desktop/src/i18n/locales', `${locale}.json`), desktopCatalog);

  const mobileCatalog = {};
  for (const key of mobileKeys) {
    if (isEnglish) {
      mobileCatalog[key] = normalizePunctuation('en', englishValues[key] ?? mobileEnglish[key] ?? legacyZhToEn[key] ?? key);
      continue;
    }
    const { text: source, annotated } = mtSource(key, englishValues, fromZh);
    mobileCatalog[key] = resolve(key, source, annotated, fromZh ? key : source);
  }
  writeJson(path.join(ROOT, 'apps/mobile/src/i18n', `${locale}.json`), mobileCatalog);
  console.log(`wrote ${locale}`);
}

const english = buildEnglish();
if (english.pending.length) {
  console.log(`english pending ${english.pending.length}`);
  await translateBatch(english.pending, 'zh-CN', 'en', english.cache, 'en', 'en');
}
for (const key of english.keys) {
  if (legacyEn[key]) continue;
  const { core, lead, trail } = trimEdges(key);
  let value = english.values[key] ?? english.cache[core] ?? key;
  if (!lead && !trail && !jsxKeys.has(key)) value = capitalizeEnglish(value);
  value = adjustEnglishSentence(key, value);
  english.values[key] = applyWhitespace(key, value);
}

for (const locale of locales) {
  if (locale === 'en') {
    await buildLocale('en', english.values);
    continue;
  }
  const base = {};
  for (const key of [...desktopKeys, ...mobileKeys]) base[key] = english.values[key] ?? key;
  await buildLocale(locale, base);
}
console.log('done');
