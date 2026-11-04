import fs from 'node:fs';

const file = 'scripts/e2e.mjs';
const original = fs.readFileSync(file, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
let text = original.split('\r\n').join('\n');

const desktopAnchor = "await page.screenshot({ path: join(shots, 'desktop-welcome.png') });";
if (!text.includes(desktopAnchor)) throw new Error('desktop anchor missing');
const desktopInject = [
  desktopAnchor,
  '',
  '// 默认语言是英文；用例断言基于中文文案，先验证默认态再切回 zh-CN。',
  "check('fresh settings default to English UI', (await page.locator('.sidebar').innerText()).includes('Connections'));",
  "await api('/settings', { method: 'PUT', body: JSON.stringify({ locale: 'zh-CN' }) });",
  "await page.reload({ waitUntil: 'domcontentloaded' });",
  "await page.waitForSelector('[data-testid=\"app-root\"]', { timeout: 30000 });",
  'await page.waitForTimeout(900);',
  "check('switching to Chinese repaints the UI', (await page.locator('.sidebar').innerText()).includes('连接'));",
].join('\n');
text = text.replace(desktopAnchor, desktopInject);

const mobileAnchor = 'const mobile = await mobileContext.newPage();';
if (!text.includes(mobileAnchor)) throw new Error('mobile anchor missing');
text = text.replace(
  mobileAnchor,
  [mobileAnchor, "await mobileContext.addInitScript(() => { localStorage.setItem('aidb.mobile.locale', 'zh-CN'); });"].join('\n'),
);

fs.writeFileSync(file, text.split('\n').join(eol));
console.log('e2e patched');
