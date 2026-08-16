// Headless smoke test: builds nothing, serves what is already built, and drives
// every beat through a real browser.
//
// This exists because `tsc --noEmit` and `vite build` both pass on an app that
// throws on first paint. The monthly refresh gates its deploy on this script, so
// it is the last thing between a bad build and the site.
//
// Two things it deliberately does NOT do:
//   - It does not hard-code a Chromium build number. The previous version pinned
//     chromium-1223, which had not existed on this box for months; the failure
//     read as "playwright is broken" rather than "the pin is stale".
//   - It does not fail the run when no browser is installed. A missing browser
//     means the check could not run, which is a different thing from the check
//     failing, and conflating them would block a deploy on a missing dev
//     dependency. It exits 0 with a loud SKIP. A real smoke failure exits 1.
//
//   node scripts/smoke.mjs                 # serve ./dist and drive it
//   BASE=https://… node scripts/smoke.mjs  # drive something already served
//
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'shots');          // gitignored
const VIEWPORTS = [[1280, 1400], [390, 844]];

// The eight beats, by the label rendered in the tab strip. Kept as a list rather
// than scraped so that a beat silently disappearing is a FAILURE, not a smaller
// test that still passes.
const BEATS = [
  'Abstract',
  '01 The problem',
  '02 The estate & evidence',
  '03 Ways to read it',
  '04 The finding',
  '05 What it does & who wins',
  '06 Trust & safeguards',
  '07 What happens next',
];

// ---- locate playwright + chromium, or skip -------------------------------
function findPlaywright() {
  const candidates = [
    path.join(ROOT, 'node_modules/playwright-core/index.js'),
    path.join(ROOT, 'node_modules/playwright/index.js'),
    '/home/john/marble-run/node_modules/playwright-core/index.js',
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function findChromium() {
  const base = path.join(process.env.HOME || '/home/john', '.cache/ms-playwright');
  if (!existsSync(base)) return null;
  const builds = readdirSync(base)
    .filter((d) => d.startsWith('chromium-'))
    .map((d) => ({ d, n: Number(d.split('-')[1]) || 0 }))
    .sort((a, b) => b.n - a.n);
  for (const { d } of builds) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(base, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const pwPath = findPlaywright();
const execPath = findChromium();
if (!pwPath || !execPath) {
  console.log(`smoke: SKIP — ${!pwPath ? 'playwright-core not found' : 'no chromium build found'}.`);
  console.log('  Install with: npm i -D playwright-core && npx playwright install chromium');
  process.exit(0);
}
const { chromium } = await import(pwPath).then((m) => m.default || m);

// ---- serve dist, unless BASE points somewhere else -----------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

let server = null, base = process.env.BASE;
if (!base) {
  try {
    await stat(path.join(DIST, 'index.html'));
  } catch {
    console.error('smoke: FAIL — no dist/index.html. Run `npm run build` first.');
    process.exit(1);
  }
  server = createServer(async (req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(DIST, p);
    if (!f.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
}

console.log(`smoke: driving ${base}`);
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: execPath, args: ['--no-sandbox'] });
const problems = [];
let checks = 0;

for (const [w, h] of VIEWPORTS) {
  const tag = w >= 900 ? 'desktop' : 'mobile';
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('console', (m) => {
    // Google Fonts is a third party and its failures are not this app's health.
    if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(m.text())) {
      problems.push(`[${tag}] console: ${m.text().slice(0, 200)}`);
    }
  });
  // A bare "Failed to load resource: 404" tells an operator nothing at 06:00 on
  // the third of the month. Record which URL, and ignore third parties, whose
  // availability is not this app's health.
  page.on('response', (res) => {
    const u = res.url();
    if (res.status() >= 400 && u.startsWith(base)) {
      problems.push(`[${tag}] HTTP ${res.status()} ${u.slice(base.length) || '/'}`);
    }
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (u.startsWith(base)) problems.push(`[${tag}] request failed ${u.slice(base.length)} — ${req.failure()?.errorText}`);
  });
  page.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${String(e.message).slice(0, 200)}`));

  await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('h1', { timeout: 15000 });

  for (const label of BEATS) {
    const tab = await page.$(`text="${label}"`);
    if (!tab) { problems.push(`[${tag}] beat missing from the tab strip: ${label}`); continue; }
    await tab.click();
    await page.waitForTimeout(1200);
    checks++;

    const m = await page.evaluate(() => ({
      h1: document.querySelectorAll('h1').length,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      svgs: document.querySelectorAll('svg').length,
      stuck: [...document.querySelectorAll('svg')]
        .filter((s) => (s.getAttribute('viewBox') || '').split(' ')[2] === '640').length,
      text: (document.body.innerText || '').length,
    }));

    // Exactly one h1 per beat: two means a beat is printing its header twice,
    // which is what happens when two renderers both own the same beat.
    if (m.h1 !== 1) problems.push(`[${tag}] ${label}: ${m.h1} h1 elements, expected 1`);
    // Sideways scroll is the defect a phone shows and a desktop hides.
    if (m.docW > m.winW) problems.push(`[${tag}] ${label}: scrolls sideways (${m.docW} > ${m.winW})`);
    // 640 was the width every chart rendered at when it was drawn into a
    // detached host and could not measure its container. If it comes back, the
    // ResizeObserver has been lost again.
    if (m.stuck) problems.push(`[${tag}] ${label}: ${m.stuck} chart(s) stuck at the 640px fallback`);
    if (m.text < 400) problems.push(`[${tag}] ${label}: rendered almost no text (${m.text} chars)`);

    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${slug}.png`), fullPage: false });
  }
  await page.close();
}

await browser.close();
if (server) server.close();

if (problems.length) {
  console.error(`smoke: FAIL — ${problems.length} problem(s) across ${checks} beat renders:`);
  for (const p of problems.slice(0, 40)) console.error('  ' + p);
  process.exit(1);
}
console.log(`smoke: OK — ${checks} beat renders across ${VIEWPORTS.length} viewports, no console or layout faults.`);
console.log(`  screenshots in ${path.relative(ROOT, SHOTS)}/`);
