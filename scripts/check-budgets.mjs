#!/usr/bin/env node
// Payload size gate for public/data.
//
// Why it exists. The bundle that shipped fetched cube.json + notable.json +
// meta.json eagerly on boot: 895 KB raw, 99 KB gzipped, before a single pixel.
// The rewrite splits that into a small first paint and a set of lazy layers,
// and the corpus grows roughly tenfold at the same time — so without a gate the
// saving is spent within a month and nobody notices, because a payload gets
// slower one file at a time and never in a way that shows up in a screenshot.
//
// The number that governs transfer is the GZIPPED one, so that is what blocks.
// Raw sizes are reported and warned on, never blocked: at full Tier A scope
// cube-core lands near 500 KB raw against the plan's 400 KB line while its
// gzip sits around 79 KB against a 90 KB line, and failing a build over bytes
// that never cross the wire would only teach someone to delete the check. If
// the raw line matters again, the fix is a columnar rewrite of the cube rows.
//
// Sizes are measured with node:zlib at its default level, which is what a
// server does. `gzip -c` reports a few hundred bytes more on the same file (its
// header, and a different memLevel); the difference is under 4% and well inside
// every budget here.
//
//   node scripts/check-budgets.mjs                 # gate public/data
//   node scripts/check-budgets.mjs --dir dist/data # gate what was built
//   node scripts/check-budgets.mjs --soft          # report only, never block
//   node scripts/check-budgets.mjs --all           # list every post shard
//
// Exit: 0 inside budget · 1 advisory only (raw over the line, heavy session
// over its target, an unbudgeted or retired file present) · 2 a gzip budget was
// exceeded or a first-paint file is missing — do not deploy.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const KB = 1024;
// Budgets from the build plan section 1.4 and docs/DATA-CONTRACT.md section 1.
// `gz` blocks, `raw` warns. `paint` marks the two files fetched before the page
// can draw anything; their combined gzip is the number the whole split exists
// to protect.
const BUDGETS = [
  { file: 'meta.json',            gz: 30 * KB,  raw: 120 * KB,       paint: true,  load: 'first paint' },
  { file: 'cube-core.json',       gz: 90 * KB,  raw: 400 * KB,       paint: true,  load: 'first paint' },
  { file: 'cube-core-b.json',     gz: 90 * KB,  raw: 400 * KB,       paint: false, load: 'lazy, tier B' },
  { file: 'cube-prof.json',       gz: 250 * KB, raw: 1200 * KB,      paint: false, load: 'lazy, professions' },
  { file: 'cube-prof-b.json',     gz: 250 * KB, raw: 1200 * KB,      paint: false, load: 'lazy, tier B' },
  { file: 'highearners.json',     gz: 250 * KB, raw: 1500 * KB,      paint: false, load: 'lazy' },
  { file: 'benchmarks.json',      gz: 40 * KB,  raw: null,           paint: false, load: 'lazy' },
  { file: 'benchmarks-itjw.json', gz: 15 * KB,  raw: null,           paint: false, load: 'lazy, quarantined' },
  { file: 'changelog.json',       gz: 20 * KB,  raw: null,           paint: false, load: 'lazy' },
  // Written by scripts/ukgwa.mjs: what the web archive recovered for the
  // 2010-2012 era and, more usefully, what it could not. A provenance record
  // for the Method beat, not a data layer.
  { file: 'ukgwa.json',           gz: 40 * KB,  raw: null,           paint: false, load: 'lazy, provenance' },
  { glob: /^posts\/[^/]+\.json$/, gz: 250 * KB, raw: null,           paint: false, load: 'lazy, per org' },
];

const FIRST_PAINT_GZ = 70 * KB;
// A heavy session: first paint plus the professions cube, the three largest org
// shards and the benchmarks. Advisory — at full scope the shards alone can
// carry it past the line, and that is a shard-shape conversation, not a reason
// to block a deploy.
const HEAVY_SESSION_GZ = 400 * KB;

// Files the pipeline retired. They are 58% of the old payload for 6% of the
// information and nothing fetches them any more, so their reappearance means a
// stale build was promoted.
const RETIRED = ['notable.json', 'cube.json'];

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const opt = (n, d = null) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const SOFT = flag('--soft');
const SHOW_ALL = flag('--all');
const DIR = path.resolve(ROOT, opt('--dir', path.join('public', 'data')));

const kb = (n) => (n / KB).toFixed(1).padStart(7) + ' KB';
// Relative inside the repository, absolute outside it: "../../../tmp/..." in a
// build log helps nobody.
const show = (p) => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };
const pct = (n, of) => (of ? Math.round((100 * n) / of) + '%' : '-');

function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, acc);
    else if (entry.endsWith('.json')) acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

function budgetFor(rel) {
  return BUDGETS.find(b => (b.file ? b.file === rel : b.glob.test(rel))) || null;
}

if (!existsSync(DIR)) {
  console.error(`check-budgets: ${show(DIR)} does not exist. Run the ingest first.`);
  process.exit(2);
}

const rows = [];
const blocking = [];
const advisory = [];

for (const rel of walk(DIR)) {
  const buf = readFileSync(path.join(DIR, rel));
  const gz = gzipSync(buf).length;
  const b = budgetFor(rel);
  let state = 'ok';
  if (RETIRED.includes(rel)) {
    state = 'retired';
    advisory.push(`${rel} is retired and should not be in the build (${kb(gz).trim()} gz of dead payload)`);
  } else if (!b) {
    state = 'no budget';
    advisory.push(`${rel} has no budget — add one to scripts/check-budgets.mjs or it grows unwatched`);
  } else {
    if (gz > b.gz) { state = 'OVER'; blocking.push(`${rel} ${kb(gz).trim()} gz over its ${kb(b.gz).trim()} budget`); }
    else if (b.raw && buf.length > b.raw) { state = 'raw'; advisory.push(`${rel} ${kb(buf.length).trim()} raw over the ${kb(b.raw).trim()} line (gzip is fine at ${kb(gz).trim()})`); }
  }
  rows.push({ rel, raw: buf.length, gz, b, state, shard: rel.startsWith('posts/') });
}

// First paint: the two files the page cannot draw without.
const paintFiles = BUDGETS.filter(b => b.paint).map(b => b.file);
const missing = paintFiles.filter(f => !rows.some(r => r.rel === f));
const paintGz = rows.filter(r => paintFiles.includes(r.rel)).reduce((a, r) => a + r.gz, 0);
if (paintGz > FIRST_PAINT_GZ) {
  blocking.push(`first paint ${kb(paintGz).trim()} gz over the ${kb(FIRST_PAINT_GZ).trim()} budget`);
}

// Heavy session, advisory.
const shards = rows.filter(r => r.shard).sort((a, b) => b.gz - a.gz);
const byName = (n) => rows.find(r => r.rel === n)?.gz || 0;
const heavyGz = paintGz + byName('cube-prof.json') + byName('benchmarks.json')
  + shards.slice(0, 3).reduce((a, r) => a + r.gz, 0);
if (heavyGz > HEAVY_SESSION_GZ) {
  advisory.push(`heavy session ${kb(heavyGz).trim()} gz over the ${kb(HEAVY_SESSION_GZ).trim()} target (first paint + prof cube + 3 largest shards + benchmarks)`);
}

// ---- report ----------------------------------------------------------------
const GLYPH = { ok: '  ok ', OVER: 'OVER', raw: 'raw ', retired: 'DEAD', 'no budget': '  ? ' };
console.log(`check-budgets: ${show(DIR)} — ${rows.length} files, gzip measured with node:zlib\n`);
console.log(`  ${'file'.padEnd(24)} ${'raw'.padStart(10)} ${'gzip'.padStart(10)} ${'budget'.padStart(10)}  used  state`);
console.log(`  ${'-'.repeat(24)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)}  ----  -----`);

const line = (r) => console.log(
  `  ${r.rel.padEnd(24)} ${kb(r.raw)} ${kb(r.gz)} ${(r.b ? kb(r.b.gz) : '        - ')} ` +
  `${pct(r.gz, r.b?.gz).padStart(5)}  [${GLYPH[r.state] ?? r.state}]  ${r.b?.load ?? ''}`
);

for (const r of rows.filter(r => !r.shard)) line(r);
const shown = SHOW_ALL ? shards : shards.filter((r, i) => i < 8 || r.state !== 'ok');
for (const r of shown) line(r);
if (shown.length < shards.length) {
  const rest = shards.slice(shown.length);
  console.log(`  ${`... and ${rest.length} more shards`.padEnd(24)} ${kb(rest.reduce((a, r) => a + r.raw, 0))} ${kb(rest.reduce((a, r) => a + r.gz, 0))}` +
    `                        (--all to list)`);
}

const label = (s) => `  ${s.padEnd(44)}`;
console.log('');
console.log(label(`first paint (${paintFiles.join(' + ')})`) + `${kb(paintGz)} gz of ${kb(FIRST_PAINT_GZ).trim()}  (${pct(paintGz, FIRST_PAINT_GZ)})`);
console.log(label('heavy session (advisory)') + `${kb(heavyGz)} gz of ${kb(HEAVY_SESSION_GZ).trim()}  (${pct(heavyGz, HEAVY_SESSION_GZ)})`);
console.log(label(`everything in ${path.basename(DIR)}`) + `${kb(rows.reduce((a, r) => a + r.gz, 0))} gz across ${rows.length} files`);

// The app bundle is not budgeted here — it is reported so that "first paint"
// is not read as the whole story. Data is what grows every month; the bundle
// only changes when someone edits src/.
const assets = path.join(ROOT, 'dist', 'assets');
if (existsSync(assets)) {
  let js = 0, css = 0;
  for (const f of readdirSync(assets)) {
    const gz = gzipSync(readFileSync(path.join(assets, f))).length;
    if (f.endsWith('.js')) js += gz; else if (f.endsWith('.css')) css += gz;
  }
  console.log(label('app bundle (dist/assets, informational)') + `${kb(js + css)} gz  (js ${kb(js).trim()}, css ${kb(css).trim()})`);
}

if (missing.length) {
  blocking.push(`first-paint file(s) missing from the build: ${missing.join(', ')}`);
}

console.log('');
for (const a of advisory) console.log(`  WARN  ${a}`);
for (const b of blocking) console.log(`  FAIL  ${b}`);

if (blocking.length && !SOFT) {
  console.error(`\ncheck-budgets: BLOCKED — ${blocking.length} budget failure(s). Do not deploy.`);
  console.error('  A cube over budget is fixed by a columnar rewrite of its rows, a shard by');
  console.error('  dropping a column or splitting the organisation — never by raising the line.');
  process.exit(2);
}
if (advisory.length) {
  console.log(`\ncheck-budgets: OK with ${advisory.length} warning(s) — inside every gzip budget. ` +
    'Advisory only, rc=1, this does not block a deploy.');
  process.exit(SOFT ? 0 : 1);
}
console.log(`\ncheck-budgets: OK — first paint ${kb(paintGz).trim()} gz of ${kb(FIRST_PAINT_GZ).trim()}, every file inside budget.`);
process.exit(0);
