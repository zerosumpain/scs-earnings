// Drives the built app through a headless browser: every tab, capturing
// console errors, verifying charts render, and screenshotting each view.
import pkg from '/home/john/marble-run/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const EXEC = '/home/john/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:4319/';
const TABS = ['explore', 'professions', 'structure', 'records', 'compare', 'method'];

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

let fail = 0;
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('h1', { timeout: 8000 });
const h1 = await page.textContent('h1');
console.log('loaded, h1 =', JSON.stringify(h1));

for (const tab of TABS) {
  // click the tab by matching data via label; tabs are buttons in .tabs
  const clicked = await page.evaluate((t) => {
    const map = { explore: 'Explore', professions: 'Professions', structure: 'Pay structure', records: 'Top earners', compare: 'Compare', method: 'Method' };
    const btns = [...document.querySelectorAll('.tab')];
    const b = btns.find(x => x.textContent.trim() === map[t]);
    if (b) { b.click(); return true; } return false;
  }, tab);
  if (!clicked) { console.log(`  [FAIL] tab ${tab}: button not found`); fail++; continue; }
  await page.waitForTimeout(700);
  const stat = await page.evaluate(() => ({
    svgs: document.querySelectorAll('svg').length,
    cards: document.querySelectorAll('.card').length,
    h1: document.querySelector('h1')?.textContent?.trim() || '',
    paths: document.querySelectorAll('svg path').length,
    rects: document.querySelectorAll('svg rect').length,
  }));
  const ok = stat.svgs > 0 && stat.cards > 0;
  console.log(`  [${ok ? 'ok' : 'FAIL'}] tab ${tab}: ${stat.svgs} svg, ${stat.cards} cards, ${stat.paths} paths, ${stat.rects} rects  h1="${stat.h1}"`);
  if (!ok) fail++;
  await page.screenshot({ path: `/home/john/scs-earnings/shot-${tab}.png`, fullPage: false });
}

// interaction smoke on Explore: switch measure + breakdown, toggle real terms, select a dept
await page.evaluate(() => { const b = [...document.querySelectorAll('.tab')].find(x => x.textContent.trim() === 'Explore'); b?.click(); });
await page.waitForTimeout(400);
const interact = await page.evaluate(async () => {
  const results = {};
  const clickText = (sel, txt) => { const e = [...document.querySelectorAll(sel)].find(x => x.textContent.trim() === txt); if (e) { e.click(); return true; } return false; };
  results.profession = clickText('.seg button', 'Profession');
  await new Promise(r => setTimeout(r, 300));
  results.paybill = clickText('.seg button', 'Pay bill');
  await new Promise(r => setTimeout(r, 300));
  results.ddat = clickText('.seg button', 'DDaT only');
  await new Promise(r => setTimeout(r, 300));
  const rt = document.querySelector('.toggle-row input'); if (rt) { rt.click(); results.realTerms = true; }
  await new Promise(r => setTimeout(r, 300));
  const chip = document.querySelector('.chip.dept-chip'); if (chip) { chip.click(); results.deptChip = true; }
  await new Promise(r => setTimeout(r, 300));
  results.svgs = document.querySelectorAll('svg').length;
  results.hash = location.hash.length;
  return results;
});
console.log('interaction:', JSON.stringify(interact));
await page.screenshot({ path: '/home/john/scs-earnings/shot-interact.png', fullPage: false });

await browser.close();
console.log('\nconsole/page errors:', errors.length);
errors.slice(0, 20).forEach(e => console.log('  ' + e));
console.log(fail === 0 && errors.length === 0 ? '\nSMOKE PASS' : `\nSMOKE ISSUES: ${fail} tab failures, ${errors.length} errors`);
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
