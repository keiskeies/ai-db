import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const API = 'http://127.0.0.1:8787/api/settings';
const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await fetch(API, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ locale: 'es' }) });
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3200);
await page.screenshot({ path: 'scripts/i18n/data/final-es-home.png' });

await page.locator('[data-testid="open-settings"]').click();
await page.waitForTimeout(1000);
await page.screenshot({ path: 'scripts/i18n/data/final-es-settings.png' });

const languageField = page.locator('.settings-content .field').nth(1);
await languageField.locator('button').first().click();
await page.waitForTimeout(400);
const items = await page.locator('.select-menu-item').allTextContents();
console.log('language options in picker:', items.length, '|', items.slice(0, 5).join(' / '), '...', items.at(-1));

await page.locator('.select-menu-item').filter({ hasText: '繁體中文' }).first().click();
await page.waitForTimeout(4000);
const sidebar = await page.locator('.sidebar').innerText();
console.log('after switching to zh-TW:', sidebar.replace(/\s+/g, ' ').slice(0, 70));
await page.screenshot({ path: 'scripts/i18n/data/final-zhtw.png' });

await fetch(API, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ locale: 'en' }) });
await browser.close();
