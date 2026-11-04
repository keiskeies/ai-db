import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
await context.addInitScript(() => {
  localStorage.setItem('aidb.bridge.v1', JSON.stringify({ baseUrl: 'http://127.0.0.1:8787', token: 'dev-token' }));
  localStorage.setItem('aidb.mobile.locale', 'en');
  localStorage.setItem('aidb.mobile.theme', 'dark');
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto('http://localhost:8090', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const collect = async (label) => {
  const data = await page.evaluate(() => {
    const root = document.querySelector('#root') ?? document.body;
    const cjk = /[\u4e00-\u9fff]/;
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const texts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const value = (walker.currentNode.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!value || !cjk.test(value)) continue;
      const parent = walker.currentNode.parentElement;
      if (!parent || !visible(parent) || parent.closest('script,style')) continue;
      texts.push(value.slice(0, 180));
    }
    const attrs = [];
    for (const element of root.querySelectorAll('[placeholder],[aria-label],[title]')) {
      if (!visible(element)) continue;
      for (const name of ['placeholder', 'aria-label', 'title']) {
        const value = element.getAttribute(name);
        if (value && cjk.test(value)) attrs.push(`${name}: ${value.slice(0, 180)}`);
      }
    }
    return { texts: [...new Set(texts)], attrs: [...new Set(attrs)] };
  });
  console.log(`\n=== mobile ${label} (${data.texts.length} texts, ${data.attrs.length} attrs) ===`);
  console.log(data.texts.join('\n'));
  if (data.attrs.length) console.log('ATTRS:\n' + data.attrs.join('\n'));
  await page.screenshot({ path: `scripts/i18n/data/mobile-${label}.png`, fullPage: false });
};

await collect('chat');
await page.locator('[data-testid="m-tab-data"]').click().catch(() => undefined);
await page.waitForTimeout(1200);
await collect('data');
await page.locator('[data-testid="m-tab-me"]').click().catch(() => undefined);
await page.waitForTimeout(900);
await collect('me');
await page.locator('[data-testid="m-me-settings"]').click().catch(() => undefined);
await page.waitForTimeout(900);
await collect('settings');
console.log('\nerrors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
