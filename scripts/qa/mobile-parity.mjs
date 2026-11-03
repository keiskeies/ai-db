import { chromium } from 'playwright-core';

const MOBILE = process.env.MOBILE_BASE ?? 'http://127.0.0.1:8790';
const BRIDGE = process.env.QA_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.QA_TOKEN ?? 'dev-token';
const API = `${BRIDGE}/api`;
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
}

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const original = await api('/settings');
const originalAgent = original.body?.settings?.agent;
const sessionsBefore = await api('/agent/sessions');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await context.addInitScript(({ bridge, token }) => localStorage.setItem('aidb.bridge.v1', JSON.stringify({ baseUrl: bridge, token })), { bridge: BRIDGE, token: TOKEN });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('dialog', (dialog) => dialog.accept());
page.setDefaultTimeout(8000);

try {
  await page.goto(MOBILE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  const modelPill = await page.getByTestId('m-model-select').innerText();
  check('模型胶囊显示当前模型与档位', modelPill.includes(originalAgent.model), modelPill);

  await page.getByTestId('m-model-select').click();
  await page.waitForTimeout(600);
  check('模型弹层包含模型与思考程度', (await page.getByText('模型与思考程度').count()) === 1 && (await page.getByText('思考程度').count()) >= 1);
  await page.getByText('Default', { exact: true }).first().click({ force: true });
  await page.waitForTimeout(600);
  check('切换到 Default 档位', (await page.getByTestId('m-model-select').innerText()).includes('Default'));
  await page.getByTestId('m-model-select').click({ force: true });
  await page.waitForTimeout(500);
  await page.getByText('high', { exact: true }).first().click({ force: true });
  await page.waitForTimeout(600);
  check('切回 high 档位', (await page.getByTestId('m-model-select').innerText()).includes('high'));

  await page.getByTestId('m-mode-select').click();
  await page.waitForTimeout(500);
  check('权限模式为下拉弹层', (await page.getByText('权限模式').count()) === 1);
  await page.getByTestId('m-mode-auto').click({ force: true });
  await page.waitForTimeout(400);
  check('权限切到自动', (await page.getByTestId('m-mode-select').innerText()).includes('自动'));
  await page.getByTestId('m-mode-select').click({ force: true });
  await page.waitForTimeout(400);
  await page.getByTestId('m-mode-readonly').click({ force: true });
  await page.waitForTimeout(300);
  check('权限切回只读', (await page.getByTestId('m-mode-select').innerText()).includes('只读'));

  await page.getByTestId('m-tab-me').click({ force: true });
  await page.getByTestId('m-me-memory').click({ force: true });
  await page.waitForTimeout(800);
  await page.getByTestId('m-memory-new').click({ force: true });
  await page.waitForTimeout(400);
  await page.getByTestId('m-memory-title').fill('QA 移动端记忆');
  await page.getByTestId('m-memory-content').fill('这是移动端新增的记忆内容');
  await page.getByTestId('m-memory-save').click({ force: true });
  await page.waitForTimeout(1000);
  check('移动端可新建记忆', (await page.getByText('QA 移动端记忆').count()) >= 1);

  await page.getByTestId('m-tab-chat').click({ force: true });
  await page.waitForTimeout(500);
  await page.getByTestId('m-new-session').click({ force: true });
  await page.waitForTimeout(900);
  await page.getByTestId('m-sessions').click({ force: true });
  await page.waitForTimeout(600);
  check('会话弹层支持搜索', (await page.getByPlaceholder('搜索会话…').count()) === 1);
  await page.locator('[data-testid^="m-session-rename-"]').first().click({ force: true });
  await page.waitForTimeout(400);
  check('会话弹层提供改名入口', (await page.getByTestId('m-rename-input').count()) === 1);
  await page.getByTestId('m-rename-input').fill('QA 移动端会话改名');
  await page.getByTestId('m-rename-save').click({ force: true });
  await page.waitForTimeout(800);
  check('会话改名生效', (await page.getByText('QA 移动端会话改名').count()) >= 1);
  await page.getByTestId('m-sessions-close').click({ force: true });
  await page.waitForTimeout(400);

  await page.getByTestId('m-tab-me').click({ force: true });
  await page.getByTestId('m-me-settings').click({ force: true });
  await page.waitForTimeout(600);
  await page.getByTestId('m-unpair').click({ force: true });
  await page.waitForTimeout(1400);
  check('解除配对返回配对页', (await page.getByTestId('m-bridge-url').count()) === 1);

  check('移动端无页面异常', pageErrors.length === 0, pageErrors.slice(0, 3));
} finally {
  // 恢复 Agent 设置并清理本次创建的测试数据（含失败路径）。
  if (originalAgent) {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ agent: { activeModelId: originalAgent.activeModelId, model: originalAgent.model, reasoningTier: originalAgent.reasoningTier ?? null } }),
    });
  }
  const memories = await api('/agent/memories?q=' + encodeURIComponent('QA 移动端记忆'));
  for (const memory of memories.body?.memories ?? []) await api(`/agent/memories/${memory.id}`, { method: 'DELETE' });
  const sessions = await api('/agent/sessions');
  const known = new Set((sessionsBefore.body?.sessions ?? []).map((session) => session.id));
  for (const session of sessions.body?.sessions ?? []) {
    if (!known.has(session.id) || session.title === 'QA 移动端会话改名') await api(`/agent/sessions/${session.id}`, { method: 'DELETE' });
  }
  await context.close();
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
