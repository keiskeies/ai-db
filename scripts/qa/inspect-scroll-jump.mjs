#!/usr/bin/env node
/**
 * QA：点「回到底部」之后，滚动到底这件事到底收敛不收敛。
 *
 * 起因：e2e 的 `jump button returns to the latest output` 时好时坏（实测 2px / 2px / 3px / 5px，
 * 断言要求 ≤4px）。这有两种可能：平滑滚动还没滚完就被测（时机问题），
 * 或者平滑滚动**永远**停在离底几像素的地方（真 bug，fractional scroll 取整）。
 * 两者修法完全不同，所以这里把 gap 随时间的变化采样出来。
 *
 * 跑法（需要 dev gateway + vite 起着）：
 *   node scripts/qa/inspect-scroll-jump.mjs
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AIDB_QA_URL ?? 'http://localhost:5180';
const TOKEN = process.env.AIDB_QA_TOKEN ?? 'dev-token';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="agent-input"]', { timeout: 30000 });
// 先跑一轮，让对话流长到能滚
await page.fill('[data-testid="agent-input"]', '把 orders 表的结构、每一列的类型与用途详细讲一遍');
await page.click('[data-testid="agent-send"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="agent-activity"]'), null, { timeout: 180_000 });
await page.waitForTimeout(1_000);

const gap = () => page.locator('.agent-transcript').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
console.log('贴底时的 gap（跟随状态基线）:', await gap());

await page.locator('.agent-transcript').evaluate((el) => { el.scrollTop = 0; });
await page.waitForTimeout(300);
const visible = await page.locator('[data-testid="agent-scroll-bottom"]').isVisible();
console.log('上滑后按钮可见:', visible);
await page.locator('[data-testid="agent-scroll-bottom"]').click();

const samples = [];
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(100);
  samples.push(Math.round(await gap()));
}
console.log('点击后每 100ms 的 gap:', samples.join(' '));
const tail = samples.slice(-10);
console.log('最后 1 秒的 gap:', tail.join(' '), '| 是否收敛到 0:', tail.every((v) => v <= 1));
await browser.close();
