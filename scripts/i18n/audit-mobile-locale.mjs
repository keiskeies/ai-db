import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath, headless: true });

async function run(locale, tag) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript((value) => {
    localStorage.setItem('aidb.bridge.v1', JSON.stringify({ baseUrl: 'http://127.0.0.1:8787', token: 'dev-token' }));
    localStorage.setItem('aidb.mobile.locale', value);
    localStorage.setItem('aidb.mobile.theme', 'dark');
  }, locale);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('http://localhost:8090', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  await page.locator('[data-testid="m-tab-me"]').click().catch(() => undefined);
  await page.waitForTimeout(800);
  await page.locator('[data-testid="m-me-settings"]').click().catch(() => undefined);
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const cjk = /[\u4e00-\u9fff]/;
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const value = (walker.currentNode.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!value || !cjk.test(value)) continue;
      const parent = walker.currentNode.parentElement;
      if (!parent || !visible(parent) || parent.closest('script,style')) continue;
      texts.push(value.slice(0, 120));
    }
    return { lang: document.documentElement.lang, dir: document.documentElement.dir, texts: [...new Set(texts)] };
  });
  console.log(`\n=== mobile ${tag} lang=${info.lang} dir=${info.dir} · ${info.texts.length} CJK ===`);
  console.log(info.texts.slice(0, 10).join('\n'));
  await page.screenshot({ path: `scripts/i18n/data/mobile-${tag}.png` });
  if (errors.length) console.log('errors:', errors.slice(0, 3).join(' | '));
  await context.close();
}

await run('ja', 'ja');
await run('ar', 'ar');
await run('de', 'de');
await browser.close();
