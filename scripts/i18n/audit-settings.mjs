import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const button = page.locator('[data-testid="open-settings"]');
console.log('settings button count', await button.count());
await button.click();
await page.waitForTimeout(1200);
console.log('modal count', await page.locator('.settings-modal').count());
const collect = async (label) => {
  const data = await page.evaluate(() => {
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
      texts.push(value.slice(0, 160));
    }
    return [...new Set(texts)];
  });
  console.log(`\n=== ${label} ===`);
  console.log(data.join('\n'));
  await page.screenshot({ path: `scripts/i18n/data/audit-${label}.png` });
};
await collect('settings-appearance');
const tabs = await page.locator('.settings-nav button').allTextContents();
console.log('tabs:', tabs.join(' | '));
for (let index = 0; index < await page.locator('.settings-nav button').count(); index += 1) {
  const tab = page.locator('.settings-nav button').nth(index);
  const text = (await tab.textContent())?.trim();
  if (!text || text.length > 30) continue;
  await tab.click().catch(() => undefined);
  await page.waitForTimeout(500);
  await collect(`settings-${index}`);
}
console.log('errors', errors.slice(0, 10));
await browser.close();
