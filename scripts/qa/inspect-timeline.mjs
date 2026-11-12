#!/usr/bin/env node
/**
 * QA：复现 e2e 里「展开工具卡看结果」那一步，并把 DOM 现场打出来。
 *
 * 起因是 e2e 在那一步超时：`[data-testid="tool-card"] … .tool-head` 解析到了元素却始终
 * not visible = 它在一个没打开的 <details> 里。交错渲染之后一条消息里可能有多个
 * execution-section（每步一个），光读组件猜不出是哪个没开，所以按 e2e 的顺序重演一遍：
 * 发一轮 → 等状态条消失 → 把所有 execution-section 手动打开 → 点第一张 run_sql 卡的头部。
 *
 * 跑法（需要 dev gateway + vite 起着）：
 *   node scripts/qa/inspect-timeline.mjs                       # 两轮：图表 + 纯 SQL（同 e2e）
 *   node scripts/qa/inspect-timeline.mjs --prompt "SELECT 1"   # 只发一轮
 *   node scripts/qa/inspect-timeline.mjs --session <id>        # 只看已有会话（不花额度）
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AIDB_QA_URL ?? 'http://localhost:5180';
const TOKEN = process.env.AIDB_QA_TOKEN ?? 'dev-token';
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? process.argv[at + 1] : undefined;
};
const SESSION = arg('session');
const PROMPT = arg('prompt');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[console error]', msg.text().slice(0, 200));
});
await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="agent-input"]', { timeout: 30000 });
await page.click('[data-testid="agent-new-session"]');
await page.waitForTimeout(600);

const ask = async (text) => {
  await page.fill('[data-testid="agent-input"]', text);
  await page.click('[data-testid="agent-send"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-activity"]'), null, { timeout: 180_000 });
  await page.waitForTimeout(1_200);
};

if (PROMPT) {
  await ask(PROMPT);
} else if (!SESSION) {
  // 与 e2e 同序：先一轮带图表的，再来一轮纯 SQL —— 现场必须有「上一条的卡 + 这一条的卡」
  await ask('按 status 统计 orders 并画柱状图');
  await ask('SELECT * FROM orders LIMIT 5');
}

const snapshot = async (label) => {
  const report = await page.evaluate(() => {
    const foldChain = (el) => {
      const chain = [];
      let node = el.parentElement;
      while (node) {
        if (node.tagName === 'DETAILS') chain.push(`${node.getAttribute('data-testid') ?? '(anon)'}.${node.className}${node.hasAttribute('open') ? '[open]' : '[closed]'}`);
        node = node.parentElement;
      }
      return chain;
    };
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? `${Math.round(r.width)}x${Math.round(r.height)}` : 'none';
    };
    return {
      sections: [...document.querySelectorAll('[data-testid="execution-section"], [data-testid="execution-section-live"]')].map((el) => ({
        testid: el.getAttribute('data-testid'),
        open: el.hasAttribute('open'),
        summary: (el.querySelector('summary')?.textContent ?? '').trim().slice(0, 34),
        cardsInside: el.querySelectorAll('[data-testid="tool-card"]').length,
      })),
      sqlCards: [...document.querySelectorAll('[data-testid="tool-card"]')]
        .filter((el) => el.textContent?.includes('run_sql'))
        .map((el) => ({ headBox: box(el.querySelector('.tool-head')), folds: foldChain(el) })),
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(report, null, 2));
  return report;
};

await snapshot('回合结束后（默认状态）');
// 这就是 e2e 的那行：手动给每个执行段挂 open
await page.locator('[data-testid="execution-section"]').evaluateAll((els) => els.forEach((el) => el.setAttribute('open', '')));
await snapshot('手动打开所有 execution-section 之后');
const firstHead = page.locator('[data-testid="tool-card"]').filter({ hasText: 'run_sql' }).first().locator('.tool-head');
try {
  await firstHead.click({ timeout: 5_000 });
  console.log('\nclick 第一张 run_sql 卡：成功');
} catch (err) {
  console.log('\nclick 第一张 run_sql 卡：失败 →', String(err).split('\n')[0]);
  await snapshot('点击失败时的现场');
}
await page.screenshot({ path: '/tmp/qa-timeline.png', fullPage: false });
console.log('screenshot → /tmp/qa-timeline.png');
await browser.close();
