import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from '../../apps/gateway/src/config';
import { Store } from '../../apps/gateway/src/store';

const SOURCES = ['apps/mobile/App.tsx', 'apps/mobile/src/theme.ts'];
const OUT = 'apps/mobile/src/i18n.en.json';

function extract(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  for (const match of text.matchAll(/"([^"\n]*[\u4e00-\u9fa5][^"\n]*)"/g)) out.push(match[1]);
  for (const match of text.matchAll(/'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'/g)) out.push(match[1]);
  for (const match of text.matchAll(/>([^<>{}\n]*[\u4e00-\u9fa5][^<>{}\n]*)</g)) out.push(match[1].trim());
  return out;
}

const strings = [...new Set(SOURCES.flatMap(extract).map((value) => value.trim()).filter(Boolean))].filter((value) => !value.includes('${') && value.length <= 180);
console.log(`translating ${strings.length} strings`);

const config = loadConfig();
const store = new Store(config.dbPath, config.secret);
const settings = store.getSettings();
store.close();
const apiKey = settings.agent.apiKey;
if (!apiKey) throw new Error('no model api key configured');
const endpoint = settings.agent.baseUrl.replace(/\/+$/, '') + '/chat/completions';
const model = settings.agent.model;

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const pending = strings.filter((value) => !existing[value]);
const dictionary = { ...existing };

for (let offset = 0; offset < pending.length; offset += 30) {
  const batch = pending.slice(offset, offset + 30);
  const prompt = [
    'Translate each Chinese UI string into concise natural English for a database app.',
    'Keep technical terms (SQL, Bridge, MCP, Skills, XLSX, JSON), numbers, punctuation and URLs unchanged.',
    'Return ONLY a JSON object mapping each original string exactly to its English translation.',
    JSON.stringify(batch, null, 1),
  ].join('\n');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a precise UI localization engine. Output strict JSON only, no markdown fences.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  const content = body?.choices?.[0]?.message?.content ?? '';
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) {
    console.warn(`batch ${offset}: invalid response`, content.slice(0, 200), body?.error);
    continue;
  }
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    let added = 0;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim() && strings.includes(key) && !dictionary[key]) {
        dictionary[key] = value;
        added += 1;
      }
    }
    console.log(`batch ${offset}: +${added}`);
  } catch (err) {
    console.warn(`batch ${offset}: JSON parse failed`, err.message, content.slice(0, 200));
  }
  writeFileSync(OUT, JSON.stringify(dictionary, null, 2));
}

console.log(`dictionary entries: ${Object.keys(dictionary).length}/${strings.length}`);
