import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const API = 'http://127.0.0.1:8787/api/settings';
const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

async function setLocale(locale) {
  const res = await fetch(API, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ locale }) });
  const body = await res.json();
  return body.settings?.locale;
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const locale of ['ja', 'de', 'ar', 'ru', 'en']) {
  const saved = await setLocale(locale);
  await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3200);
  const info = await page.evaluate(() => {
    const cjk = /[\u4e00-\u9fff]/;
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const chrome = [];
    for (const selector of ['.ribbon-btn', '.sidebar', '.home-col-head', '.btn', '.tab', '.agent-panel .panel-title', '.statusbar']) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text && cjk.test(text)) chrome.push(`${selector}: ${text.slice(0, 90)}`);
      }
    }
    return { lang: document.documentElement.lang, dir: document.documentElement.dir, chrome: [...new Set(chrome)] };
  });
  console.log(`\n=== ${locale} (saved=${saved}) lang=${info.lang} dir=${info.dir} ===`);
  console.log(info.chrome.slice(0, 12).join('\n') || 'no CJK in chrome');
  await page.screenshot({ path: `scripts/i18n/data/locale-${locale}.png` });
}
await browser.close();
