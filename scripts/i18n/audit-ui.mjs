import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

const collect = async (label) => {
  const data = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const cjk = /[\u4e00-\u9fff]/;
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!value || !cjk.test(value)) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent)) continue;
      if (parent.closest('script,style')) continue;
      texts.push({ text: value.slice(0, 200), tag: parent.tagName.toLowerCase(), cls: parent.className?.toString().slice(0, 60) });
    }
    const attrs = [];
    for (const element of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
      if (!visible(element)) continue;
      for (const name of ['placeholder', 'title', 'aria-label', 'alt']) {
        const value = element.getAttribute(name);
        if (value && cjk.test(value)) attrs.push({ attr: name, value: value.slice(0, 200), tag: element.tagName.toLowerCase() });
      }
    }
    return { texts, attrs };
  });
  const uniqueTexts = [...new Map(data.texts.map((item) => [item.text, item])).values()];
  const uniqueAttrs = [...new Map(data.attrs.map((item) => [`${item.attr}:${item.value}`, item])).values()];
  console.log(`\n=== ${label}: ${uniqueTexts.length} CJK texts, ${uniqueAttrs.length} CJK attrs ===`);
  for (const item of uniqueTexts) console.log(`TEXT [${item.tag}] ${item.text}`);
  for (const item of uniqueAttrs) console.log(`ATTR ${item.attr}=${item.value}`);
  await page.screenshot({ path: `scripts/i18n/data/audit-${label}.png`, fullPage: false });
};

await collect('home');

const clickTestId = async (id) => {
  const locator = page.locator(`[data-testid="${id}"]`).first();
  if (await locator.count()) {
    await locator.click().catch(() => undefined);
    await page.waitForTimeout(800);
    return true;
  }
  return false;
};

if (await clickTestId('open-settings')) {
  await collect('settings');
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(400);
}

await page.waitForTimeout(300);

const toolsButton = page.locator('button').filter({ hasText: /Tools|Toolbox|工具/ }).first();
if (await toolsButton.count()) {
  await toolsButton.click().catch(() => undefined);
  await page.waitForTimeout(1200);
  await collect('tools');
}

console.log('\n=== page errors ===');
console.log(errors.slice(0, 20).join('\n'));
await browser.close();
