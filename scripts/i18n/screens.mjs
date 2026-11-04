import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 950 } });
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3200);
const shot = async (name) => page.screenshot({ path: `scripts/i18n/data/view-${name}.png` });

await page.locator('[data-testid="agent-new-session"]').first().click().catch(() => undefined);
await page.waitForTimeout(600);
await shot('home');

await page.locator('text=orders').first().click().catch(() => undefined);
await page.waitForTimeout(1200);
await shot('data');

await page.locator('[data-testid="open-query"], .tab-add').first().click().catch(() => undefined);
await page.waitForTimeout(900);
await shot('query');

await page.locator('.ribbon-btn').filter({ hasText: /Objects|Table|View|Functions|User|Other/i }).first().click().catch(() => undefined);
await page.waitForTimeout(1200);
await shot('tools');

await page.locator('[data-testid="open-settings"]').click().catch(() => undefined);
await page.waitForTimeout(900);
await shot('settings');

await page.locator('.settings-nav button').filter({ hasText: /Capabilities|能力/i }).first().click().catch(() => undefined);
await page.waitForTimeout(900);
await shot('settings-capabilities');

console.log('screens done');
await browser.close();
