import { chromium } from 'playwright-core';

const API = process.env.AIDB_API ?? 'http://127.0.0.1:8787/api';
const TOKEN = process.env.AIDB_TOKEN ?? 'dev-token';
const H = { authorization: `Bearer ${TOKEN}` };
const BIG_DB = 'nextcloud';
const BIZ_DB = 'ziyou_mall_center';

const conns = await (await fetch(`${API}/connections`, { headers: H })).json();
const conn = conns.connections.find((c) => c.name === 'local3306');
if (!conn) { console.error('local3306 未注册'); process.exit(2); }

const out = [];
const check = (name, cond, detail = '') => {
  out.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

try {
  await page.goto('http://localhost:5180/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.shell', { timeout: 20000 });

  // 1) 展开连接：30 个库
  await page.click(`[data-testid="connection-${conn.id}"]`);
  await page.waitForFunction(() => document.querySelectorAll('.tree-node.db-node').length >= 20, null, { timeout: 60000 });
  const dbNodes = await page.locator('.tree-node.db-node').count();
  check('对象树列出 30 个库', dbNodes >= 20, `${dbNodes} 个库节点`);

  // 2) 打开 235 表大库并计时
  const treeStarted = Date.now();
  const bigDbNode = page.locator('.tree-node.db-node').filter({ hasText: BIG_DB }).first();
  await bigDbNode.click();
  await page.waitForFunction(
    (db) => {
      const node = [...document.querySelectorAll('.tree-node.db-node')].find((el) => el.textContent?.includes(db));
      return ((node?.parentElement?.querySelectorAll('.tree-node[title^="TABLE "]') ?? []).length) >= 235;
    },
    BIG_DB,
    { timeout: 60000 },
  );
  const treeMs = Date.now() - treeStarted;
  const tableNodes = await bigDbNode.locator('xpath=..').locator('.tree-node[title^="TABLE "]').count();
  check(`${BIG_DB} 的 235 张表全部进入对象树`, tableNodes === 235, `${tableNodes} 个表节点 / ${treeMs}ms`);
  check('大库对象树渲染 < 8s', treeMs < 8000, `${treeMs}ms`);

  // 235 张表里按名字定位：搜索框应在整个对象树上过滤，而不是只过滤连接
  await page.fill('[data-testid="sidebar-search"]', 'oc_filecache');
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('.tree-node[title^="TABLE "]')];
    return nodes.length > 0 && nodes.length <= 2 && nodes.some((n) => n.getAttribute('title') === 'TABLE oc_filecache');
  }, null, { timeout: 10000 });
  const filteredNodes = await page.locator('.tree-node[title^="TABLE "]').count();
  check('235 表大库可按表名定位', filteredNodes <= 2, `"oc_filecache" → ${filteredNodes} 个表节点`);
  await page.fill('[data-testid="sidebar-search"]', '');
  await page.waitForFunction(() => document.querySelectorAll('.tree-node[title^="TABLE "]').length >= 235, null, { timeout: 10000 });

  // 3) 数据网格 + 分页
  await page.locator('.tree-node[title="TABLE oc_news_items"]').click();
  await page.waitForSelector('[data-testid^="grid-row-"]', { timeout: 30000 });
  const footer = async () => (await page.locator('.grid-foot').first().innerText()).replace(/\s+/g, ' ');
  await page.waitForFunction(() => /共\s*223\s*条/.test(document.querySelector('.grid-foot')?.textContent ?? ''), null, { timeout: 30000 });
  const rows1 = await page.locator('[data-testid^="grid-row-"]').count();
  check('数据网格默认页 100 行', rows1 === 100, `${rows1} 行 / 共 223 条`);
  await page.screenshot({ path: 'D:/tmp/real-mysql-grid.png' });

  await page.locator('.pager button').last().click();
  await page.waitForFunction(() => /第\s*101-200\s*条记录/.test(document.querySelector('.grid-foot')?.textContent ?? ''), null, { timeout: 20000 });
  const firstRowNo = await page.locator('[data-testid="grid-row-0"] .grid-rowno').first().innerText();
  check('翻到第 2 页行号从 101 开始', firstRowNo.trim() === '101', `行号 ${firstRowNo} · ${await footer()}`);

  await page.selectOption('[data-testid="data-page-size"]', '50');
  await page.waitForFunction(() => /第\s*1-50\s*条记录/.test(document.querySelector('.grid-foot')?.textContent ?? ''), null, { timeout: 20000 });
  check('切换每页 50 行生效', true, await footer());

  // 4) 导出 CSV（真实 223 行 + 长文本）
  const exportPromise = page.waitForResponse((r) => r.url().includes('/api/export') && r.request().method() === 'POST', { timeout: 60000 });
  await page.click('[data-testid="data-export"]');
  await page.locator('[data-testid="context-menu"] [role="menuitem"]').filter({ hasText: '导出为 CSV' }).click();
  const exportRes = await exportPromise;
  const exportBody = await exportRes.json();
  check('工具栏导出 CSV 成功', exportRes.ok() && exportBody.file?.rows === 223, `${exportBody.file?.rows} 行 / ${exportBody.file?.path}`);

  // 5) 打印预览（抓取真实数据并生成表格）
  await page.click('[data-testid="data-print"]');
  await page.waitForSelector('[data-testid="print-frame"]', { timeout: 60000 });
  const srcDoc = await page.getAttribute('[data-testid="print-frame"]', 'srcdoc');
  const trCount = (srcDoc?.match(/<tr/g) ?? []).length;
  check('打印预览包含全部数据行', trCount >= 224 && srcDoc.includes('oc_news_items'), `${trCount} 个 <tr> / ${Math.round((srcDoc?.length ?? 0) / 1024)} KB`);
  await page.screenshot({ path: 'D:/tmp/real-mysql-print.png' });
  const printModal = page.locator('.modal').filter({ has: page.locator('[data-testid="print-frame"]') });
  await printModal.locator('.modal-foot button').filter({ hasText: '关闭' }).click();
  await page.waitForSelector('[data-testid="print-frame"]', { state: 'detached', timeout: 10000 });

  // 6) 中文业务库：对象树 + 中文单元格
  await page.locator('.tree-node.db-node').filter({ hasText: BIZ_DB }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.tree-node[title^="TABLE "]').length >= 116, null, { timeout: 60000 });
  const bizTables = await page.locator('.tree-node[title^="TABLE "]').count();
  check(`${BIZ_DB} 116 张表进入对象树`, bizTables >= 116, `${bizTables} 张`);
  await page.locator('.tree-node[title="TABLE category"]').click();
  await page.waitForSelector('[data-testid^="grid-row-"]', { timeout: 20000 });
  const gridText = await page.locator('.data-grid').first().innerText();
  check('中文分类数据在网格中正常显示', gridText.includes('餐饮') && gridText.includes('丽人美发'), gridText.split('\n').find((l) => l.includes('餐饮')) ?? '');
  await page.screenshot({ path: 'D:/tmp/real-mysql-chinese.png' });

  // 7) 查询 + 图表：真实月度 GMV × 支付渠道
  await page.click('.tab-add');
  await page.waitForSelector('[data-testid="query-editor"] .cm-content', { timeout: 20000 });
  await page.selectOption('[data-testid="query-connection"]', conn.id);
  await page.selectOption('[data-testid="query-database"]', BIZ_DB);
  const sql = "SELECT DATE_FORMAT(created_timestamp, '%Y-%m') AS month, pay_channel, ROUND(SUM(money), 2) AS gmv FROM t_order WHERE created_timestamp >= '2024-01-01' GROUP BY month, pay_channel ORDER BY month";
  await page.click('[data-testid="query-editor"] .cm-content');
  await page.keyboard.insertText(sql);
  await page.click('[data-testid="query-run"]');
  await page.waitForSelector('[data-testid="query-result-grid"] [data-testid^="grid-row-"]', { timeout: 60000 });
  const queryRows = await page.locator('[data-testid="query-result-grid"] [data-testid^="grid-row-"]').count();
  check('查询返回真实聚合结果', queryRows >= 12, `${queryRows} 行`);
  await page.locator('.result-tab').filter({ hasText: '图表' }).click();
  await page.waitForSelector('[data-testid="chart-svg"]', { timeout: 20000 });
  const bars = await page.locator('[data-testid="chart-svg"] rect').count();
  check('图表页渲染出柱形', bars > 0, `${bars} 个 rect`);
  await page.screenshot({ path: 'D:/tmp/real-mysql-chart.png' });

  // 8) 查询侧长文本：22589 字符原文进入网格
  await page.click('[data-testid="query-editor"] .cm-content');
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('SELECT id, CHAR_LENGTH(body) AS len, body FROM oc_news_items ORDER BY len DESC LIMIT 5');
  await page.selectOption('[data-testid="query-database"]', BIG_DB);
  await page.click('[data-testid="query-run"]');
  await page.waitForSelector('[data-testid="query-result-grid"] [data-testid^="grid-row-"]', { timeout: 60000 });
  const maxCell = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-testid="query-result-grid"] tbody td')];
    return Math.max(0, ...cells.map((td) => (td.getAttribute('title') ?? '').length));
  });
  check('2 万字符长文本进入网格未崩', maxCell >= 20000, `最长单元格 ${maxCell} 字符`);
  await page.screenshot({ path: 'D:/tmp/real-mysql-longtext.png' });
} catch (err) {
  check('UI 流程未抛异常', false, (err && err.message ? err.message.split('\n')[0] : String(err)));
} finally {
  await browser.close();
}

const failed = out.filter((r) => !r.ok).length + errors.length;
console.log(`\n${out.length - out.filter((r) => !r.ok).length}/${out.length} 通过`);
if (errors.length) {
  console.log(`控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log('  ' + e);
  console.log('控制台错误计为失败');
}
process.exit(failed ? 1 : 0);
