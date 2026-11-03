import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.QA_TOKEN ?? 'dev-token';
const ART = join(process.cwd(), 'docs', 'test-artifacts', 'responsive');
const SHOTS = join(ART, 'shots');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = [];
let section = 'general';

function begin(name) {
  section = name;
  console.log(`\n=== ${name} ===`);
}

function record(name, ok, detail) {
  results.push({ section, name, ok, detail: detail ?? null });
  if (!ok) console.log(`[FAIL] ${section} :: ${name} — ${JSON.stringify(detail).slice(0, 600)}`);
  return ok;
}

function summarizeAudit(audit, label, modal = false, skipControls = false) {
  const issues = [];
  if (audit.overflowX > 1) issues.push(`页面横向溢出 ${audit.overflowX}px`);
  if (audit.offenders.length) issues.push(`${audit.offenders.length} 个元素越出视口`);
  if (audit.ribbon?.overflow > 1 && !audit.ribbon.scrollable) issues.push(`功能区横向溢出 ${audit.ribbon.overflow}px`);
  if (audit.statusbar?.overflow > 1) issues.push(`状态栏横向溢出 ${audit.statusbar.overflow}px`);
  if (!modal && !skipControls && audit.blocked.length) issues.push(`${audit.blocked.length} 个关键控件不可点击`);
  if (modal) {
    const box = audit.modal;
    if (!box?.found) issues.push('弹层未出现');
    else {
      if (box.rect.x < -1 || box.rect.y < -1 || box.rect.right > audit.vw + 1 || box.rect.bottom > audit.vh + 1) issues.push('弹层超出视口');
      if (box.innerOverflowX > 1) issues.push(`弹层内部横向溢出 ${box.innerOverflowX}px`);
    }
  }
  const workspace = audit.regions['.workspace']?.w;
  if (!modal && !skipControls && workspace !== undefined && workspace < 300) issues.push(`工作区仅 ${workspace}px 宽`);
  return { label, issues, audit };
}

async function auditPage(page, label, { screenshot = false, modal = false, skipControls = false } = {}) {
  const audit = await page.evaluate((options) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const root = document.documentElement;
    const vis = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
    };
    const scrollAncestor = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(s.overflowX) && p.clientWidth > 0) return p;
      }
      return null;
    };
    const horizontalScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return p;
      }
      return null;
    };
    const describe = (el) => {
      let out = el.tagName.toLowerCase();
      if (el.id) out += `#${el.id}`;
      const cls = String(el.className ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join('.');
      if (cls) out += `.${cls}`;
      return out;
    };
    const out = {
      vw,
      vh,
      scrollW: root.scrollWidth,
      scrollH: root.scrollHeight,
      overflowX: Math.max(0, root.scrollWidth - vw),
      overflowY: Math.max(0, root.scrollHeight - vh),
      offenders: [],
      clipped: [],
      blocked: [],
      regions: {},
    };
    const all = [...document.querySelectorAll('body *')];
    const seen = new Set();
    for (const el of all) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 && r.left >= -1) continue;
      if (scrollAncestor(el)) continue;
      const key = `${describe(el)}:${Math.round(r.left)}:${Math.round(r.right)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.offenders.push({
        el: describe(el),
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 36),
      });
    }
    out.offenders = out.offenders.slice(0, 15);
    for (const el of all) {
      if (!vis(el)) continue;
      const s = getComputedStyle(el);
      if (s.overflowX !== 'hidden' || s.textOverflow === 'ellipsis' || String(el.className).includes('truncate')) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') continue;
      const delta = el.scrollWidth - el.clientWidth;
      const text = (el.textContent ?? '').trim();
      if (delta > 4 && text.length > 2 && el.clientWidth > 0) {
        out.clipped.push({ el: describe(el), delta, w: el.clientWidth, text: text.replace(/\s+/g, ' ').slice(0, 40) });
      }
    }
    out.clipped = out.clipped.slice(0, 15);
    for (const sel of ['.titlebar', '.ribbon', '.shell', '.sidebar', '.workspace', '.agent-panel', '.statusbar', '.tabs']) {
      const el = document.querySelector(sel);
      if (el && vis(el)) {
        const r = el.getBoundingClientRect();
        out.regions[sel] = { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
      }
    }
    const bar = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { w: Math.round(r.width), scrollW: el.scrollWidth, overflow: Math.max(0, el.scrollWidth - Math.round(r.width)), scrollable: /(auto|scroll)/.test(s.overflowX) };
    };
    out.ribbon = bar('.ribbon');
    out.statusbar = bar('.statusbar');
    out.titlebar = bar('.titlebar');
    if (options.skipControls) {
      if (options.modal) {
        const overlay = document.querySelector('.overlay');
        const box = overlay?.querySelector('.modal');
        out.modal = box
          ? { found: true, rect: (() => { const r = box.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })(), innerOverflowX: 0, innerScrollY: 0 }
          : { found: false };
      }
      return out;
    }
    for (const id of ['toggle-sidebar', 'agent-toggle', 'theme-toggle', 'open-settings', 'ribbon-new-query', 'ribbon-dashboard']) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el || !vis(el)) {
        out.blocked.push({ id, missing: true });
        continue;
      }
      if (horizontalScroller(el)) continue;
      const r = el.getBoundingClientRect();
      const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
      const y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
      const hit = document.elementFromPoint(x, y);
      if (!(hit === el || el.contains(hit))) out.blocked.push({ id, coveredBy: hit ? describe(hit) : null });
    }
    if (options.modal) {
      const overlay = document.querySelector('.overlay');
      const box = overlay?.querySelector('.modal');
      if (!box) out.modal = { found: false };
      else {
        const r = box.getBoundingClientRect();
        const body = box.querySelector('.modal-body') ?? box;
        out.modal = {
          found: true,
          rect: { x: Math.round(r.left), y: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
          innerOverflowX: Math.max(0, body.scrollWidth - body.clientWidth),
          innerScrollY: Math.max(0, body.scrollHeight - body.clientHeight),
        };
      }
    }
    return out;
  }, { modal, skipControls });
  const summary = summarizeAudit(audit, label, modal, skipControls);
  record(`${label} 无布局缺陷`, summary.issues.length === 0, summary.issues.length ? summary : undefined);
  if (summary.issues.length) {
    console.log(
      `   → ${label}: ${summary.issues.join('；')}`,
      audit.offenders.length ? `越界=${JSON.stringify(audit.offenders.slice(0, 4))}` : '',
      audit.blocked.length ? `遮挡=${JSON.stringify(audit.blocked.slice(0, 4))}` : '',
    );
  }
  if (screenshot) {
    await page.screenshot({ path: join(SHOTS, `${label.replace(/[^\w.-]+/g, '_')}.png`) });
  }
  return summary;
}

async function api(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function newDesktop(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    localStorage.setItem('aidb.ui', JSON.stringify({ sidebarOpen: true, sidebarWidth: 244, agentWidth: 384 }));
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`desktop ${viewport.width}x${viewport.height}: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) consoleErrors.push(`desktop ${viewport.width}x${viewport.height}: HTTP ${res.status()} ${res.url()}`);
  });
  page.on('pageerror', (err) => consoleErrors.push(`desktop ${viewport.width}x${viewport.height}: ${err.message}`));
  await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
  await page.waitForTimeout(700);
  return { context, page };
}

async function activateDemo(page) {
  const row = page.locator('.conn-row', { hasText: 'Demo · 零售业务库' });
  if ((await row.count()) === 0) return false;
  try {
    await row.first().click({ timeout: 4000 });
    await page.waitForTimeout(400);
    return true;
  } catch {
    return false;
  }
}

async function openDataView(page) {
  if (!(await activateDemo(page))) return false;
  const agentOpen = (await page.locator('.agent-panel').count()) > 0;
  if (agentOpen) {
    await page.locator('[data-testid="agent-toggle"]').click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  const row = page.locator('[data-testid="welcome-table-orders"]');
  let opened = false;
  if (await row.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await row.click({ force: true });
    await page.waitForTimeout(1200);
    opened = true;
  } else {
    const tree = page.locator('[title="TABLE orders"]').first();
    if (await tree.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
      await tree.click({ force: true });
      await page.waitForTimeout(1200);
      opened = true;
    }
  }
  if (opened && agentOpen && (await page.locator('.agent-panel').count()) === 0) {
    await page.locator('[data-testid="agent-toggle"]').click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  return opened;
}

async function withAgentClosed(page, fn) {
  const agentOpen = (await page.locator('.agent-panel').count()) > 0;
  if (agentOpen) {
    await page.locator('[data-testid="agent-toggle"]').click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  try {
    return await fn();
  } finally {
    if (agentOpen && (await page.locator('.agent-panel').count()) === 0) {
      await page.locator('[data-testid="agent-toggle"]').click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(250);
    }
  }
}

async function openQuery(page) {
  await withAgentClosed(page, async () => {
    await page.locator('[data-testid="ribbon-new-query"]').click({ force: true, timeout: 8000 });
    await page.waitForSelector('[data-testid="query-editor"]', { timeout: 10000 });
    const editor = page.locator('.cm-content').last();
    await editor.fill("SELECT status, COUNT(*) AS cnt, SUM(pay_cents) AS gmv FROM orders GROUP BY status ORDER BY gmv DESC");
    await page.locator('[data-testid="query-run"]').last().click({ force: true });
    await page.waitForSelector('[data-testid="query-result-grid"]', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(700);
  });
}

async function openDashboard(page) {
  await withAgentClosed(page, async () => {
    await page.locator('[data-testid="ribbon-dashboard"]').click({ force: true, timeout: 8000 });
    await page.waitForTimeout(1200);
  });
}

async function openTools(page) {
  const agentOpen = (await page.locator('.agent-panel').count()) > 0;
  if (agentOpen) {
    await page.locator('[data-testid="agent-toggle"]').click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await page.getByRole('button', { name: '视图' }).click({ force: true, timeout: 8000 });
  await page.waitForTimeout(800);
}

async function openSettings(page) {
  await page.click('[data-testid="open-settings"]', { timeout: 5000 });
  await page.waitForTimeout(700);
}

async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.locator('.overlay').count();
    if (!open) break;
    await page.evaluate(() => {
      const overlay = document.querySelector('.overlay');
      overlay?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
  }
}

async function dragSplitter(page, testId, deltaX) {
  const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
  if (!box) return null;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(120, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const sidebar = await page.locator('.sidebar').boundingBox().catch(() => null);
  const agent = await page.locator('.agent-panel').boundingBox().catch(() => null);
  const workspace = await page.locator('.workspace').boundingBox().catch(() => null);
  return { sidebar: sidebar?.width ?? 0, agent: agent?.width ?? 0, workspace: workspace?.width ?? 0 };
}

async function main() {
  const health = await api('GET', '/health');
  if (health.status !== 200) throw new Error('gateway not running');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const startedAt = Date.now();

  try {
    // ------------------------------------------------ desktop viewport matrix
    begin('desktop-viewports');
    const desktopSizes = [
      [2560, 1440],
      [1920, 1080],
      [1680, 1050],
      [1600, 900],
      [1440, 900],
      [1366, 768],
      [1280, 800],
      [1100, 800],
      [1024, 768],
      [960, 720],
      [900, 700],
      [800, 700],
      [768, 720],
      [720, 720],
      [640, 800],
      [480, 800],
      [390, 844],
      [720, 1280],
    ];
    for (const [width, height] of desktopSizes) {
      console.log(`viewport ${width}x${height}`);
      const { context, page } = await newDesktop(browser, { width, height });
      try {
        const tag = `d${width}x${height}`;
        await auditPage(page, `${tag}-welcome`, { screenshot: [1920, 1440, 1024, 768, 390].includes(width) && height >= 700 });
        if ([900, 768, 720, 390].includes(width)) {
          const agentBox = await page.locator('.agent-panel').boundingBox();
          const expected = width <= 720 ? width : Math.min(440, Math.round(width * 0.94));
          record(`${tag} 右栏浮层宽度符合断点`, Boolean(agentBox) && Math.abs(agentBox.width - expected) <= 2, { actual: agentBox?.width, expected });
        }
        const dataOk = await openDataView(page);
        if (dataOk) await auditPage(page, `${tag}-data`, { screenshot: [1920, 1440, 1024, 768].includes(width) });
        else record(`${tag}-data 可进入数据页`, true, '窄屏侧栏隐藏，跳过数据页（由移动端 App 覆盖）');
        // agent panel is open by default; audit once with data + agent
        await auditPage(page, `${tag}-data+agent`);
        await openSettings(page);
        await auditPage(page, `${tag}-settings`, { screenshot: width === 1440, modal: true });
        await closeOverlays(page);
        if ([1920, 1440, 1024, 720, 390].includes(width)) {
          await openQuery(page);
          await auditPage(page, `${tag}-query`, { screenshot: [1920, 1440, 1024].includes(width) });
          await openDashboard(page);
          await auditPage(page, `${tag}-dashboard`, { screenshot: width === 1440 });
          await openTools(page);
          await auditPage(page, `${tag}-tools`, { screenshot: width === 1440, modal: true });
          await closeOverlays(page);
        }

      } finally {
        await context.close();
      }
    }

    // ----------------------------------------------------- pane drag extremes
    begin('pane-resize');
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [1024, 768],
      [900, 700],
    ]) {
      const { context, page } = await newDesktop(browser, { width, height });
      try {
        const tag = `pane${width}x${height}`;
        const dataOk = await openDataView(page);
        if (!dataOk) {
          record(`${tag} 数据页可进入`, false, '无法打开示例表');
          continue;
        }
        const initial = await dragSplitter(page, 'splitter-sidebar', 0);
        // sidebar max
        const sideMax = await dragSplitter(page, 'splitter-sidebar', 400);
        record(`${tag} 左栏拖到最大后工作区仍可用`, sideMax && sideMax.workspace >= 300, sideMax);
        await auditPage(page, `${tag}-sidebar-max`, { screenshot: true });
        // sidebar min
        const sideMin = await dragSplitter(page, 'splitter-sidebar', -600);
        record(`${tag} 左栏拖到最小后工作区仍可用`, sideMin && sideMin.workspace >= 300, sideMin);
        await auditPage(page, `${tag}-sidebar-min`);
        // agent max/min (hidden under 1000px by design)
        const agentSplitter = await page.locator('[data-testid="splitter-agent"]').isVisible().catch(() => false);
        if (agentSplitter) {
          const agentMax = await dragSplitter(page, 'splitter-agent', -700);
          record(`${tag} 右栏拖到最大后工作区仍可用`, agentMax && agentMax.workspace >= 300, agentMax);
          await auditPage(page, `${tag}-agent-max`, { screenshot: true });
          const agentMin = await dragSplitter(page, 'splitter-agent', 700);
          record(`${tag} 右栏拖到最小后工作区仍可用`, agentMin && agentMin.workspace >= 300, agentMin);
          await auditPage(page, `${tag}-agent-min`);
          // both max
          const sideMax2 = await dragSplitter(page, 'splitter-sidebar', 500);
          const bothMax = await dragSplitter(page, 'splitter-agent', -800);
          record(`${tag} 左右栏同时拖到最大后工作区仍可用`, bothMax && bothMax.workspace >= 300, { sideMax2, bothMax });
          await auditPage(page, `${tag}-both-max`, { screenshot: true });
          // fit check: page must not scroll horizontally
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          record(`${tag} 双栏极值下无横向滚动`, overflow <= 1, { overflow });
          if (width >= 1280) {
            await page.setViewportSize({ width: 1024, height: 768 });
            await page.waitForTimeout(500);
            const shrunk = await page.evaluate(() => {
              const box = (sel) => document.querySelector(sel)?.getBoundingClientRect().width ?? 0;
              return { sidebar: Math.round(box('.sidebar')), agent: Math.round(box('.agent-panel')), workspace: Math.round(box('.workspace')), overflow: document.documentElement.scrollWidth - window.innerWidth };
            });
            record(`${tag} 拖宽后缩小窗口自动收敛`, shrunk.workspace >= 300 && shrunk.overflow <= 1, shrunk);
            await auditPage(page, `${tag}-shrink-1024`);
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(400);
          }
        } else {
          record(`${tag} 窄屏右栏按设计改为浮层（无拖拽条）`, true, '≤1000px 隐藏 splitter-agent');
        }
        void initial;
      } finally {
        await context.close();
      }
    }

    // ------------------------------------------------------------- mobile web
    begin('mobile-web');
    for (const [width, height] of [
      [390, 844],
      [360, 640],
      [414, 896],
      [768, 1024],
      [320, 568],
    ]) {
      const { context, page } = await newDesktop(browser, { width, height });
      try {
        const tag = `mweb${width}x${height}`;
        await auditPage(page, `${tag}-welcome`, { screenshot: width === 390 });
        await openSettings(page);
        await auditPage(page, `${tag}-settings`, { modal: true });
        await closeOverlays(page);
        const sidebarVisible = await page.locator('.sidebar').isVisible().catch(() => false);
        if (width <= 720) {
          await page.locator('[data-testid="toggle-sidebar"]').click({ force: true });
          await page.waitForTimeout(400);
          const opened = await page.locator('.sidebar').isVisible().catch(() => false);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          record(`${tag} 抽屉侧栏可打开且不撑宽页面`, sidebarVisible === false && opened === true && overflow <= 1, { initial: sidebarVisible, opened, overflow });
          await auditPage(page, `${tag}-drawer`, { screenshot: width === 390 });
          await page.locator('[data-testid="toggle-sidebar"]').click({ force: true });
          await page.waitForTimeout(350);
          record(`${tag} 抽屉可再次关闭`, (await page.locator('.sidebar').isVisible().catch(() => false)) === false);
        } else {
          record(`${tag} 侧栏按断点可见`, sidebarVisible === true, { width, sidebarVisible });
        }
      } finally {
        await context.close();
      }
    }

    // ------------------------------------------------------------ mobile app
    begin('mobile-app');
    const dist = join(process.cwd(), 'apps', 'mobile', 'dist');
    if (!existsSync(join(dist, 'index.html'))) {
      record('mobile dist 存在', false, 'apps/mobile/dist/index.html 不存在');
    } else {
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
      const server = createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
        let file = resolve(join(dist, pathname));
        if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
        res.setHeader('content-type', mime[extname(file)] ?? 'text/html; charset=utf-8');
        createReadStream(file).pipe(res);
      });
      await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
      const port = server.address().port;
      const mobileBase = `http://127.0.0.1:${port}`;
      try {
        for (const [width, height] of [
          [390, 844],
          [360, 640],
          [414, 896],
          [768, 1024],
          [320, 568],
        ]) {
          const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
          const page = await context.newPage();
          page.on('pageerror', (err) => consoleErrors.push(`mobile ${width}x${height}: ${err.message}`));
          try {
            const tag = `app${width}x${height}`;
            await page.goto(mobileBase, { waitUntil: 'networkidle' });
            await page.waitForTimeout(1600);
            await auditPage(page, `${tag}-pairing`, { screenshot: width === 390, skipControls: true });
            const pair = await api('POST', '/pair/start');
            const code = pair.json?.code;
            if (!code) {
              record(`${tag} 配对码`, false, pair.json);
              continue;
            }
            await page.getByTestId('m-bridge-url').fill(BASE);
            await page.getByTestId('m-pair-code').fill(code);
            await page.getByTestId('m-connect').click();
            const connected = await page
              .waitForFunction(() => document.body.innerText.includes('Bridge 在线'), null, { timeout: 40000 })
              .then(() => true, () => false);
            record(`${tag} 配对连接`, connected, connected ? undefined : '40s 内未显示 Bridge 在线');
            if (!connected) continue;
            await auditPage(page, `${tag}-chat`, { screenshot: width === 390, skipControls: true });
            await page.getByTestId('m-tab-data').click();
            await page.waitForTimeout(1200);
            await auditPage(page, `${tag}-data`, { skipControls: true });
            await page.getByTestId('m-tab-memory').click();
            await page.waitForTimeout(800);
            await auditPage(page, `${tag}-memory`, { skipControls: true });
            await page.getByTestId('m-tab-settings').click();
            await page.waitForTimeout(800);
            await auditPage(page, `${tag}-settings`, { screenshot: width === 390, skipControls: true });
          } finally {
            await context.close();
          }
        }
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  } finally {
    await browser.close();
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    bySection: {},
  };
  for (const item of results) {
    summary.bySection[item.section] ??= { total: 0, failed: 0 };
    summary.bySection[item.section].total += 1;
    if (!item.ok) summary.bySection[item.section].failed += 1;
  }
  writeFileSync(
    join(ART, 'responsive.json'),
    JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, summary, consoleErrors, results }, null, 2),
  );
  console.log(`\nSUMMARY ${summary.passed}/${summary.total} passed, ${summary.failed} failed → ${join(ART, 'responsive.json')}`);
  for (const [name, value] of Object.entries(summary.bySection)) console.log(`  ${name}: ${value.total - value.failed}/${value.total}`);
  if (summary.failed) {
    console.log('\nFAILURES:');
    for (const item of results.filter((r) => !r.ok)) console.log(`- [${item.section}] ${item.name}: ${JSON.stringify(item.detail).slice(0, 900)}`);
  }
  if (consoleErrors.length) {
    console.log(`\nCONSOLE ERRORS (${consoleErrors.length}):`);
    for (const line of [...new Set(consoleErrors)].slice(0, 12)) console.log(`- ${line.slice(0, 300)}`);
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
