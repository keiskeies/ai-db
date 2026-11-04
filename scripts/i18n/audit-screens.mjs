import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const collect = async (label, selector = 'body') => {
  const data = await page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector) ?? document.body;
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
      const cls = parent.className?.toString().slice(0, 50) ?? '';
      texts.push(`[${parent.tagName.toLowerCase()}${cls ? '.' + cls.split(' ')[0] : ''}] ${value.slice(0, 180)}`);
    }
    const attrs = [];
    for (const element of root.querySelectorAll('[placeholder],[title],[aria-label]')) {
      if (!visible(element)) continue;
      for (const name of ['placeholder', 'title', 'aria-label']) {
        const value = element.getAttribute(name);
        if (value && cjk.test(value)) attrs.push(`${name}: ${value.slice(0, 180)}`);
      }
    }
    return { texts: [...new Set(texts)], attrs: [...new Set(attrs)] };
  }, selector);
  console.log(`\n=== ${label} (${data.texts.length} texts, ${data.attrs.length} attrs) ===`);
  console.log(data.texts.join('\n'));
  if (data.attrs.length) console.log('ATTRS:\n' + data.attrs.join('\n'));
  await page.screenshot({ path: `scripts/i18n/data/screen-${label}.png` });
};

const click = async (locator) => { await locator.click().catch(() => undefined); await page.waitForTimeout(900); };

await click(page.locator('[data-testid="agent-new-session"]').first());
await collect('home-empty-agent', '.workspace');

const orders = page.locator('text=orders').first();
if (await orders.count()) {
  await click(orders);
  await collect('data-view', '.workspace');
}

const newQuery = page.getByText('New query', { exact: true }).first();
if (await newQuery.count()) {
  await click(newQuery);
  await collect('query-view', '.workspace');
}

const viewRibbon = page.getByText('View', { exact: true }).first();
if (await viewRibbon.count()) {
  await click(viewRibbon);
  await collect('tools-hub', '.tools-modal, .modal');
}
console.log('\nerrors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
