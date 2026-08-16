// External benchmark ingestion for the SCS earnings study.
//
// The organograms tell you what the Senior Civil Service is paid. They cannot
// tell you whether that is a lot. This script gathers the outside comparators
// that can, from the only sources that are both openly licensed and honestly
// constructed: ONS ASHE, the Civil Service Statistics ODS, the Cabinet Office
// evidence to the Senior Salaries Review Body, the SSRB's own report, and the
// SCS pay practitioner guidance that sets the band edges every chart is drawn
// against. Node 22 built-ins only (global fetch, node:zlib, node:crypto), so a
// zip is unpacked by hand and a sheet is parsed by hand.
//
//   node scripts/benchmarks.mjs                    # everything
//   node scripts/benchmarks.mjs --only ashe,acses  # named sources
//   node scripts/benchmarks.mjs --skip-table15     # skip the 84 MB region zip
//   node scripts/benchmarks.mjs --dry-run          # fetch and parse, write nothing
//   node scripts/benchmarks.mjs --approve          # move pending PDF figures to live
//   node scripts/benchmarks.mjs --no-cache         # force re-download
//
// Six rules this file exists to enforce. They are the difference between a
// comparison and a lie, and every one of them is code, not copy.
//
//   1. Base against base. ASHE 14.7a is ANNUAL GROSS and includes incentive
//      pay; SCS organogram pay is base only. 14.3a is basic pay but it is a
//      WEEKLY series, so an annual basic figure has to be annualised and said
//      to be annualised. Both are emitted, both are labelled, neither is
//      quietly substituted for the other.
//   2. Suppression is null, never zero. ASHE 'x' (CV above 20 per cent), ':'
//      (not applicable), '..' (disclosive), '-' (nil); ACSES '[c]'
//      (confidential) and '[n]' (not applicable). A suppressed cell carries the
//      reason it was suppressed and no number at all.
//   3. Nothing is parsed blind. Sheet numbers move between editions: what the
//      brief calls ACSES "Table 36 profession quartiles" is table_35 in the
//      2026 edition, and its "Table 26 salary bands" is table_6. Tables are
//      found by their printed title, and the sheet actually read is recorded.
//   4. PDF figures sit behind a checksum and review gate. Extract, checksum the
//      table block, and if the checksum moved, write the new reading to
//      `pending` and leave the live figure exactly where the last human review
//      left it. A layout change must never silently rewrite a number.
//   5. Every figure carries provenance. Each block names a `src` into
//      `sources`, which holds url, table, sheet, edition, sourceDate,
//      windowEnd, lastReviewed and licence. There is no page-level date stamp.
//   6. Two sources that materially disagree about the same quantity for the
//      same role are `contested`, and the disagreement is shipped, not resolved.
//
// Sources deliberately never contacted: Glassdoor (robots.txt disallows
// ClaudeBot by name), Indeed, Adzuna, Payscale, Levels.fyi, Nomis,
// TaxPayers' Alliance, Spencer Stuart. They are listed in `excluded` with the
// reason so the page can state the exclusion, and not one request is made to
// any of them. ITJobsWatch is a separate quarantined file and not this script's
// business.
//
import { mkdir, writeFile, readFile, stat, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync, gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache', 'bench');
const OUT = path.join(ROOT, 'public', 'data', 'benchmarks.json');
const REVIEW = path.join(ROOT, 'data', 'benchmarks-review.json');
const UA = 'scs-earnings-benchmarks/1.0 (+https://strangeramblings.com; static research site, one pass per month)';
const FETCH_TIMEOUT = 180000;
// Size gate. The build plan set a single 40 KB line for this file, written
// before it was known that ACSES publishes an SCS median for 149 separate
// organisations (the control total that would have caught the SCS1/SCS2
// inversion), that ASHE Table 15 yields 134 unsuppressed regional cells, and
// that the review gate has to carry a live and a pending reading side by side
// while a change waits for sign-off. Dropping any of those to hit 40 KB would
// remove the parts that make the file worth loading. The file is lazy-loaded,
// so the transfer cost is the gzip figure; both are gated, and both are printed
// against the plan's original line every run.
const BUDGET_BYTES = 96 * 1024;
const BUDGET_GZIP = 24 * 1024;
const PLAN_BUDGET_BYTES = 40 * 1024;
const N_FLOOR = 30;
const STALE_MONTHS = 14;
const SCHEMA = 1;

// ---- CLI ------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const opt = (n, d = null) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const USE_CACHE = !flag('--no-cache');
const DRY_RUN = flag('--dry-run');
const APPROVE = flag('--approve');
const SKIP_T15 = flag('--skip-table15');
const ONLY = (opt('--only') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const EDITIONS = Math.max(1, Number(opt('--editions', '1')) || 1);
const wanted = (id) => ONLY.length === 0 || ONLY.includes(id);

const log = (...a) => console.log(...a);
const warnings = [];
const warn = (m) => { warnings.push(m); log(`  WARNING: ${m}`); };
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);

function fatal(msg) {
  console.error(`\nFATAL: ${msg}`);
  console.error('nothing was written; the previous benchmarks.json is untouched.');
  process.exit(2);
}

// ---- HTTP, throttled per host ----------------------------------------------
// ONS returns 429 on rapid probes, so every host gets its own minimum gap and
// every response is cached on disk with its ETag / Last-Modified beside it.
// assets.publishing.service.gov.uk URLs embed a content hash in the path, so a
// body once fetched from there is immutable and never revalidated.
const HOST_GAP = { 'www.ons.gov.uk': 1100, 'www.gov.uk': 300, 'assets.publishing.service.gov.uk': 300 };
const lastHit = new Map();

async function throttle(url) {
  const host = new URL(url).host;
  const gap = HOST_GAP[host] ?? 500;
  const prev = lastHit.get(host) || 0;
  const wait = prev + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

const isImmutable = (url) => url.includes('assets.publishing.service.gov.uk/media/');

async function fetchBytes(url, { tries = 3, label = '' } = {}) {
  const key = sha1(url);
  const bodyPath = path.join(CACHE, key + '.bin');
  const metaPath = path.join(CACHE, key + '.meta.json');
  let cached = null, validators = null;
  if (USE_CACHE) {
    try { const s = await stat(bodyPath); if (s.size > 0) cached = await readFile(bodyPath); } catch { /* none */ }
    try { validators = JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* none */ }
  }
  if (cached && isImmutable(url)) return { buf: cached, mode: 'cache-immutable', url };

  const headers = { 'user-agent': UA };
  if (cached && validators?.etag) headers['if-none-match'] = validators.etag;
  if (cached && validators?.lastModified) headers['if-modified-since'] = validators.lastModified;

  for (let t = 0; t < tries; t++) {
    await throttle(url);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT), redirect: 'follow' });
      if (res.status === 304 && cached) return { buf: cached, mode: 'revalidated', url };
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(bodyPath, buf).catch(() => {});
        await writeFile(metaPath, JSON.stringify({
          etag: res.headers.get('etag') || null,
          lastModified: res.headers.get('last-modified') || null,
          url, fetched: new Date().toISOString(),
        })).catch(() => {});
        return { buf, mode: 'download', url };
      }
      if (res.status === 429) { await sleep(5000 * (t + 1)); continue; }
      if (res.status === 404 || res.status === 403) break;
    } catch { /* retry */ }
    await sleep(800 * (t + 1));
  }
  if (cached) return { buf: cached, mode: 'cache-stale', url };
  warn(`fetch failed: ${label || url}`);
  return { buf: null, mode: 'fail', url };
}

async function fetchJSON(url, label = '') {
  const { buf, mode } = await fetchBytes(url, { label });
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { warn(`not JSON: ${label || url} (${mode})`); return null; }
}

// ---- ZIP, by hand ----------------------------------------------------------
// Both ASHE and ODS ship as zip. The ASHE outer archive stores its members
// uncompressed (method 0) and the inner xlsx deflates them (method 8), so both
// paths are needed. Walk the central directory rather than scanning for local
// headers: a local header does not carry a reliable compressed size when the
// data-descriptor bit is set, and the central directory always does.
function unzip(buf) {
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('ZIP64 archive: not supported (no source in this pipeline needs it)');

  const files = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) throw new Error(`central directory entry ${n} has a bad signature`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOff === 0xffffffff) {
      throw new Error(`ZIP64 sizes on "${name}": not supported`);
    }
    // The local header repeats the name but its own extra-field length can
    // differ from the central one, so read it from the local header itself.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const slice = buf.subarray(start, start + compSize);
    files.set(name, () => (method === 0 ? Buffer.from(slice) : inflateRawSync(slice)));
  }
  return files;
}

const unzipEntry = (files, name) => {
  const f = files.get(name);
  if (!f) throw new Error(`zip member not found: ${name}`);
  return f();
};

// ---- XML helpers -----------------------------------------------------------
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10));
    return XML_ENT[e] ?? m;
  });
}
const stripTags = (s) => unescapeXml(String(s).replace(/<[^>]*>/g, ''));

// ---- XLSX ------------------------------------------------------------------
// Enough of SpreadsheetML to read an ONS statistical table: shared strings, the
// workbook's sheet-name-to-relationship map, and the cells of one sheet keyed
// by column letter. Styles, formats and formulas are all irrelevant here -
// every ONS value is either a number or a suppression marker.
function xlsxSharedStrings(files) {
  if (!files.has('xl/sharedStrings.xml')) return [];
  const xml = unzipEntry(files, 'xl/sharedStrings.xml').toString('utf8');
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const body = m[1] || '';
    // drop phonetic runs before collecting text, or Japanese furigana would be
    // concatenated into the string on files that carry it
    const clean = body.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
    let text = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(clean))) text += unescapeXml(t[1]);
    out.push(text);
  }
  return out;
}

function xlsxSheetTarget(files, sheetName) {
  const wb = unzipEntry(files, 'xl/workbook.xml').toString('utf8');
  const rels = unzipEntry(files, 'xl/_rels/workbook.xml.rels').toString('utf8');
  const sheets = [];
  const sRe = /<sheet\s([^>]*)\/>/g;
  let m;
  while ((m = sRe.exec(wb))) {
    const attrs = m[1];
    const name = unescapeXml((attrs.match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (attrs.match(/r:id="([^"]*)"/) || [])[1] || '';
    sheets.push({ name, rid });
  }
  const hit = sheets.find(s => s.name === sheetName);
  if (!hit) throw new Error(`sheet "${sheetName}" not in workbook (has: ${sheets.map(s => s.name).join(', ')})`);
  const relRe = /<Relationship\s([^>]*)\/>/g;
  let r;
  while ((r = relRe.exec(rels))) {
    const a = r[1];
    if ((a.match(/Id="([^"]*)"/) || [])[1] === hit.rid) {
      const target = (a.match(/Target="([^"]*)"/) || [])[1] || '';
      return { target: 'xl/' + target.replace(/^\/?xl\//, ''), sheetNames: sheets.map(s => s.name) };
    }
  }
  throw new Error(`no relationship for sheet "${sheetName}"`);
}

// Returns rows as objects keyed by column letter. maxCol caps the width read;
// ONS tables never use more than column Y and the key block sits off to the
// right, so 'Q' is the whole of every statistical table here.
function xlsxRows(files, sheetName, maxCol = 'Q') {
  const shared = xlsxSharedStrings(files);
  const { target } = xlsxSheetTarget(files, sheetName);
  const xml = unzipEntry(files, target).toString('utf8');
  const limit = colIndex(maxCol);
  const rows = [];
  const rowRe = /<row\s([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const body = rm[2];
    if (!body) { rows.push({}); continue; }
    const cells = {};
    const cRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(body))) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      if (!ref || colIndex(ref) > limit) continue;
      const type = (attrs.match(/t="([^"]*)"/) || [])[1] || 'n';
      let val = null;
      if (type === 'inlineStr') {
        val = stripTags((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
      } else {
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v != null) val = type === 's' ? (shared[Number(v)] ?? null) : unescapeXml(v);
      }
      if (val != null && val !== '') cells[ref] = val;
    }
    rows.push(cells);
  }
  return rows;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// ---- ODS -------------------------------------------------------------------
// An ODS is a zip whose content.xml holds every sheet. Cells repeat via
// table:number-columns-repeated, and a trailing repeat can claim 16,384
// columns, so the expansion is capped.
function odsSheets(buf) {
  const files = unzip(buf);
  const xml = unzipEntry(files, 'content.xml').toString('utf8');
  const sheets = [];
  let i = 0;
  while (true) {
    const s = xml.indexOf('<table:table ', i);
    if (s < 0) break;
    const e = xml.indexOf('</table:table>', s);
    if (e < 0) break;
    const block = xml.slice(s, e);
    sheets.push({
      name: unescapeXml((block.match(/table:name="([^"]*)"/) || [])[1] || ''),
      block,
    });
    i = e + 14;
  }
  return sheets;
}

function odsRows(block, maxCols = 40) {
  const rows = [];
  const rowRe = /<table:table-row\s?([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
  let rm;
  while ((rm = rowRe.exec(block))) {
    const attrs = rm[1] || '', body = rm[2] || '';
    let rep = Number((attrs.match(/table:number-rows-repeated="(\d+)"/) || [])[1] || 1);
    if (rep > 20) rep = 1; // trailing filler rows
    const cells = [];
    const cRe = /<table:(table-cell|covered-table-cell)\s?([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g;
    let cm;
    while ((cm = cRe.exec(body)) && cells.length < maxCols) {
      const a = cm[2] || '', inner = cm[3] || '';
      let crep = Number((a.match(/table:number-columns-repeated="(\d+)"/) || [])[1] || 1);
      if (crep > maxCols) crep = 1;
      const num = (a.match(/office:value="([^"]*)"/) || [])[1];
      let val;
      if (num != null) val = num;
      else {
        const texts = [...inner.matchAll(/<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>/g)].map(t => stripTags(t[1]));
        val = texts.join(' ').trim() || null;
      }
      for (let k = 0; k < crep && cells.length < maxCols; k++) cells.push(val);
    }
    for (let k = 0; k < rep; k++) rows.push(cells.slice());
  }
  return rows;
}

// Find a sheet by the title printed in its first cells, never by sheet name.
// ACSES renumbers between editions: the profession quartiles the brief calls
// "Table 36" are table_35 in the 2026 edition and the salary bands it calls
// "Table 26" are table_6.
function odsFindByTitle(sheets, re) {
  for (const sh of sheets) {
    const rows = odsRows(sh.block.slice(0, 40000), 12);
    for (const r of rows.slice(0, 6)) {
      for (const c of r) {
        if (c && re.test(c)) return { name: sh.name, title: c.trim(), rows: odsRows(sh.block) };
      }
    }
  }
  return null;
}

// ---- PDF -------------------------------------------------------------------
let PDFTOTEXT = null;
async function havePdftotext() {
  if (PDFTOTEXT !== null) return PDFTOTEXT;
  try {
    const { stdout, stderr } = await execFileAsync('pdftotext', ['-v'], { maxBuffer: 1 << 20 });
    PDFTOTEXT = { ok: true, version: String(stderr || stdout).split('\n')[0].trim() };
  } catch {
    PDFTOTEXT = { ok: false, version: null };
  }
  return PDFTOTEXT;
}

async function pdfText(buf, tag) {
  const p = await havePdftotext();
  if (!p.ok) return null;
  const tmp = path.join(tmpdir(), `scs-bench-${sha1(tag).slice(0, 12)}.pdf`);
  await writeFile(tmp, buf);
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', tmp, '-'], { maxBuffer: 64 << 20 });
    return stdout;
  } catch (e) {
    warn(`pdftotext failed on ${tag}: ${e.message}`);
    return null;
  }
}

// ---- suppression and number handling ---------------------------------------
// Rule 2. Every published marker means something different and none of them
// mean zero. parseFloat('x') is NaN and NaN coerced anywhere downstream becomes
// a plausible-looking zero, which is how a suppressed cell turns into a claim.
const SUPPRESSION = {
  x: 'cv-above-20-per-cent',
  ':': 'not-applicable',
  '..': 'disclosive',
  '-': 'nil-or-negligible',
  '[c]': 'confidential-small-numbers',
  '[n]': 'not-applicable-zero-in-cell',
  '[z]': 'not-applicable',
  '[w]': 'not-available',
};

// -> { v: number|null, sup: string|null }. Never returns 0 for a marker.
function cell(raw) {
  if (raw == null) return { v: null, sup: 'absent' };
  const s = String(raw).trim();
  if (s === '') return { v: null, sup: 'absent' };
  const key = s.toLowerCase();
  if (SUPPRESSION[key]) return { v: null, sup: SUPPRESSION[key] };
  const n = Number(s.replace(/[£,\s]/g, ''));
  if (!Number.isFinite(n)) return { v: null, sup: `unparsed:${s.slice(0, 12)}` };
  return { v: n, sup: null };
}

const round0 = (n) => (n == null ? null : Math.round(n));
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Rule: below n = 30 there is no figure, only a count. Where the source does
// not publish an n at all the figure is kept and flagged nKnown:false rather
// than silently treated as adequate.
function nGate(value, n) {
  if (value == null) return { v: null, nKnown: n != null, n };
  if (n == null) return { v: value, nKnown: false, n: null };
  if (n < N_FLOOR) return { v: null, nKnown: true, n, belowFloor: true };
  return { v: value, nKnown: true, n };
}

function monthsBetween(iso, from = TODAY) {
  const a = Date.parse(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  const b = Date.parse(from + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 999;
  return (b - a) / (1000 * 60 * 60 * 24 * 30.44);
}

// ---- provenance ------------------------------------------------------------
// Rule 5. Sources are a dictionary; every figure block names one. Nothing in
// this file is dated by the run, only by the publication it came from.
const sources = {};
function addSource(id, s) {
  sources[id] = {
    name: s.name,
    publisher: s.publisher,
    url: s.url,
    table: s.table ?? null,
    sheet: s.sheet ?? null,
    edition: s.edition ?? null,
    provisional: s.provisional ?? null,
    sourceDate: s.sourceDate ?? null,      // when the publisher released it
    windowEnd: s.windowEnd ?? null,        // the last period the figures describe
    lastReviewed: s.lastReviewed ?? TODAY, // when this pipeline last checked it
    licence: s.licence ?? 'Open Government Licence v3.0',
    extraction: s.extraction ?? null,
    note: s.note ?? null,
    correctionNotice: s.correctionNotice ?? null,
  };
  return id;
}

// ============================================================================
// 1. ONS ASHE
// ============================================================================
const ASHE_BASE = 'https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/earningsandworkinghours/datasets';
// The URL slug still says soc2010; the files have carried SOC 2020 since the
// 2021 edition. Renaming the slug would 404, so it is left alone and the
// classification in force is recorded on the figures instead.
const ASHE_DATASETS = {
  t14: { slug: 'occupation4digitsoc2010ashetable14', label: 'ASHE Table 14 - occupation (4-digit SOC)' },
  t13: { slug: 'publicandprivatesectorashetable13', label: 'ASHE Table 13 - public and private sector' },
  t15: { slug: 'regionbyoccupation4digitsoc2010ashetable15', label: 'ASHE Table 15 - region by occupation' },
};
const ASHE_SHEET = 'Full-Time';
// Column letters are stable across every ASHE "a" table and every sheet.
const ASHE_COLS = { desc: 'A', code: 'B', jobs: 'C', median: 'D', mean: 'F', p10: 'H', p20: 'I', p25: 'J', p30: 'K', p40: 'L', p60: 'M', p70: 'N', p75: 'O', p80: 'P', p90: 'Q' };
const ASHE_REGIONS = ['North East', 'North West', 'Yorkshire and The Humber', 'East Midlands', 'West Midlands', 'South West', 'East', 'London', 'South East', 'Wales', 'Scotland', 'Northern Ireland'];

// Rule 9. Recorded so a series is drawn as three segments, never one line.
const SOC_BREAKS = [
  { from: 2021, to: null, classification: 'SOC 2020', note: 'ASHE has used SOC 2020 since the 2021 edition, although the dataset URL slug still reads soc2010.' },
  { from: 2011, to: 2020, classification: 'SOC 2010', note: 'Codes are not comparable across the 2020/2021 boundary; several 11xx director codes were re-cut.' },
  { from: null, to: 2010, classification: 'SOC 2000', note: 'Earliest ASHE editions. Not joined to anything later without an explicit break.' },
];

function parseAsheEditionUri(uri) {
  const ed = uri.split('/').pop();
  const m = ed.match(/^(\d{4})(provisional|revised)$/);
  return m ? { uri, edition: ed, year: Number(m[1]), kind: m[2] } : null;
}

// Prefer revised over provisional for the same year, and additionally keep the
// newest settled (revised) edition so the page can show a provisional figure
// beside one that will not move.
async function asheEditions(slug) {
  const j = await fetchJSON(`${ASHE_BASE}/${slug}/data`, `ASHE ${slug} landing`);
  if (!j?.datasets?.length) return [];
  const eds = j.datasets.map(d => parseAsheEditionUri(d.uri)).filter(Boolean);
  if (!eds.length) return [];
  const byYear = new Map();
  for (const e of eds) {
    const prev = byYear.get(e.year);
    if (!prev || (prev.kind === 'provisional' && e.kind === 'revised')) byYear.set(e.year, e);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  const newest = byYear.get(years[0]);
  const settled = eds.filter(e => e.kind === 'revised').sort((a, b) => b.year - a.year)[0] || null;
  const out = [newest];
  // A second, settled edition is useful next to a provisional one but doubles
  // the ASHE payload, and this file has a 40 KB budget. Opt in with --editions 2.
  if (EDITIONS > 1 && settled && settled.edition !== newest.edition) out.push(settled);
  return out;
}

function correctionOccupationCodes(text) {
  const codes = new Set();
  for (const m of text.matchAll(/occupations?\s+([0-9,\s]+(?:and\s+[0-9]+)?)/gi)) {
    for (const d of m[1].match(/\d{2,4}/g) || []) codes.add(d);
  }
  return [...codes];
}

async function asheEdition(slug, ed) {
  const j = await fetchJSON(`https://www.ons.gov.uk${ed.uri}/data`, `ASHE ${slug} ${ed.edition}`);
  if (!j) return null;
  const file = j.downloads?.[0]?.file;
  if (!file) { warn(`ASHE ${slug} ${ed.edition}: edition JSON carries no download`); return null; }
  // Rule: re-read the correction notice EVERY run, not only on a new edition.
  // The 2025 provisional edition carries a live correction suppressing SOC 3312
  // for London, the South East, the East and the UK.
  const notices = (j.versions || []).map(v => v.correctionNotice).filter(Boolean);
  return {
    ...ed,
    file,
    downloadUrl: `https://www.ons.gov.uk/file?uri=${ed.uri}/${encodeURIComponent(file)}`,
    releaseDate: (j.description?.releaseDate || '').slice(0, 10) || null,
    editionLabel: j.description?.edition || ed.edition,
    correctionNotice: notices.length ? notices.join(' | ') : null,
    // Only codes introduced by the word "occupation". A correction notice also
    // lists the TABLES it affects ("suppressed in Tables 2, 3, 14, 15 and 20"),
    // and scooping those up as occupation codes would flag the wrong rows.
    // The verbatim notice is shipped regardless and is the authority.
    correctionCodes: notices.length ? correctionOccupationCodes(notices.join(' ')) : [],
  };
}

// Pull one "a" sub-table (e.g. "14.7a") out of the edition zip and index its
// Full-Time sheet by SOC code.
function asheSubTable(zipFiles, needle) {
  const name = [...zipFiles.keys()].find(n => n.includes(needle) && n.toLowerCase().endsWith('.xlsx'));
  if (!name) throw new Error(`sub-table ${needle} not in the edition zip`);
  const inner = unzip(unzipEntry(zipFiles, name));
  const rows = xlsxRows(inner, ASHE_SHEET);
  return { file: name.split('/').pop(), rows };
}

function asheRowByCode(rows, code) {
  for (const r of rows) if (String(r[ASHE_COLS.code] || '').trim() === code) return r;
  return null;
}

// A whole row of an ASHE table, with every suppression preserved as a reason.
function asheStats(row, { keep = ['jobs', 'median', 'mean', 'p25', 'p75', 'p90'], weekly = false } = {}) {
  if (!row) return null;
  const out = {}, sup = {};
  for (const k of keep) {
    const c = cell(row[ASHE_COLS[k]]);
    // Weekly figures are published to one decimal place and are multiplied by
    // 52 downstream, so rounding them to whole pounds first would move the
    // annualised median by up to about £26.
    out[k] = k === 'jobs' || weekly ? round1(c.v) : round0(c.v);
    if (c.sup) sup[k] = c.sup;
  }
  // Rule 6, applied where an n exists. ASHE publishes job counts in thousands
  // and warns they are indicative, so the binding sample gate here is in fact
  // ONS's own CV suppression; the floor is still checked and its verdict shown.
  const n = out.jobs == null ? null : Math.round(out.jobs * 1000);
  const gated = nGate(out.median, n);
  // n is jobs x 1000 and is not stored twice; nKnown records whether ONS
  // published a job count at all for this cell.
  out.nKnown = gated.nKnown;
  if (gated.belowFloor) { for (const k of keep) if (k !== 'jobs') out[k] = null; sup.nFloor = `below-n-floor-${N_FLOOR}`; }
  if (Object.keys(sup).length) out.suppressed = sup;
  return out;
}

async function ingestAshe(result) {
  log('\n== ONS ASHE ==');
  const editions = await asheEditions(ASHE_DATASETS.t14.slug);
  if (!editions.length) { warn('ASHE Table 14: no editions resolved; skipping ASHE entirely'); return; }
  log(`  Table 14 editions selected: ${editions.map(e => e.edition).join(', ')}`);

  const occupations = [];
  const editionMeta = [];
  for (const e0 of editions) {
    const ed = await asheEdition(ASHE_DATASETS.t14.slug, e0);
    if (!ed) continue;
    log(`  ${ed.edition}: ${ed.file} (released ${ed.releaseDate})`);
    if (ed.correctionNotice) log(`    correction notice present, affects codes ${ed.correctionCodes.join(', ') || 'unparsed'}`);
    const { buf, mode } = await fetchBytes(ed.downloadUrl, { label: `ASHE t14 ${ed.edition}` });
    if (!buf) continue;
    log(`    ${(buf.length / 1048576).toFixed(1)} MB (${mode})`);
    let zipFiles;
    try { zipFiles = unzip(buf); } catch (err) { warn(`ASHE t14 ${ed.edition}: ${err.message}`); continue; }

    let gross, basic, incentive;
    try {
      gross = asheSubTable(zipFiles, '14.7a');
      basic = asheSubTable(zipFiles, '14.3a');
      incentive = asheSubTable(zipFiles, '14.8a');
    } catch (err) { warn(`ASHE t14 ${ed.edition}: ${err.message}`); continue; }

    const provenance = {
      publisher: 'Office for National Statistics',
      url: `https://www.ons.gov.uk${ed.uri}`,
      edition: ed.editionLabel,
      provisional: ed.kind === 'provisional',
      sourceDate: ed.releaseDate,
      windowEnd: `${ed.year}-04-30`,
      correctionNotice: ed.correctionNotice,
      note: `Sheet "${ASHE_SHEET}". ONS suppresses any estimate whose coefficient of variation exceeds 20 per cent as "x"; those cells arrive here as null with a reason, never as zero.`,
    };
    const srcGross = addSource(`ashe-t14-7a-${ed.edition}`, { ...provenance, name: 'ASHE Table 14.7a - Annual pay, gross', table: gross.file, sheet: ASHE_SHEET, extraction: 'xlsx parsed from the edition zip' });
    const srcBasic = addSource(`ashe-t14-3a-${ed.edition}`, { ...provenance, name: 'ASHE Table 14.3a - Basic pay including other pay (weekly)', table: basic.file, sheet: ASHE_SHEET, extraction: 'xlsx parsed from the edition zip' });
    const srcInc = addSource(`ashe-t14-8a-${ed.edition}`, { ...provenance, name: 'ASHE Table 14.8a - Annual pay, incentive', table: incentive.file, sheet: ASHE_SHEET, extraction: 'xlsx parsed from the edition zip' });
    editionMeta.push({ table: 'Table 14', edition: ed.editionLabel, provisional: ed.kind === 'provisional', releaseDate: ed.releaseDate, url: `https://www.ons.gov.uk${ed.uri}`, correctionNotice: ed.correctionNotice, correctionCodes: ed.correctionCodes });

    for (const role of CROSSWALK) {
      const soc = role.soc2020;
      if (occupations.some(o => o.soc === soc && o.edition === ed.editionLabel)) continue;
      const gRow = asheRowByCode(gross.rows, soc);
      const bRow = asheRowByCode(basic.rows, soc);
      const iRow = asheRowByCode(incentive.rows, soc);
      if (!gRow && !bRow) { warn(`ASHE ${ed.edition}: SOC ${soc} not found in 14.7a or 14.3a`); continue; }
      const g = asheStats(gRow);
      const b = asheStats(bRow, { keep: ['jobs', 'median', 'p25', 'p75', 'p90'], weekly: true });
      const inc = asheStats(iRow, { keep: ['jobs', 'median'] });
      occupations.push({
        soc,
        description: String((gRow || bRow)[ASHE_COLS.desc] || '').trim(),
        classification: 'SOC 2020',
        edition: ed.editionLabel,
        provisional: ed.kind === 'provisional',
        correctionAffected: ed.correctionCodes.includes(soc),
        // Annual gross. The most quoted ASHE figure and the WRONG one for a
        // base-pay comparison: it includes incentive pay.
        annualGross: g ? { src: srcGross, ...g } : null,
        // Basic pay. ASHE publishes it weekly only.
        weeklyBasic: b ? { src: srcBasic, ...b } : null,
        // The base-against-base figure, annualised and said to be annualised.
        basicAnnualised: b ? annualiseWeekly(b, srcBasic) : null,
        annualIncentive: inc ? { src: srcInc, ...inc } : null,
      });
    }
  }
  result.ashe.editions = editionMeta;
  result.ashe.occupations = occupations;
  log(`  occupations read: ${occupations.length} rows across ${editionMeta.length} editions`);

  // ---- Table 13, public against private -----------------------------------
  const t13eds = await asheEditions(ASHE_DATASETS.t13.slug);
  if (t13eds.length) {
    const ed = await asheEdition(ASHE_DATASETS.t13.slug, t13eds[0]);
    if (ed) {
      const { buf } = await fetchBytes(ed.downloadUrl, { label: `ASHE t13 ${ed.edition}` });
      if (buf) {
        try {
          const zipFiles = unzip(buf);
          const gross = asheSubTable(zipFiles, '13.7a');
          const basic = asheSubTable(zipFiles, '13.3a');
          const rowFor = (rows, label) => rows.find(r => String(r.A || '').trim().toLowerCase() === label) || null;
          const prov = {
            publisher: 'Office for National Statistics',
            url: `https://www.ons.gov.uk${ed.uri}`,
            edition: ed.editionLabel,
            provisional: ed.kind === 'provisional',
            sourceDate: ed.releaseDate,
            windowEnd: `${ed.year}-04-30`,
            correctionNotice: ed.correctionNotice,
          };
          const sG = addSource(`ashe-t13-7a-${ed.edition}`, { ...prov, name: 'ASHE Table 13.7a - Annual pay, gross, by sector', table: gross.file, sheet: ASHE_SHEET });
          const sB = addSource(`ashe-t13-3a-${ed.edition}`, { ...prov, name: 'ASHE Table 13.3a - Basic pay including other pay (weekly), by sector', table: basic.file, sheet: ASHE_SHEET });
          const sectors = {};
          for (const [key, label] of [['public', 'public sector'], ['private', 'private sector'], ['nonProfit', 'non-profit body or mutual association']]) {
            const g = asheStats(rowFor(gross.rows, label));
            const b = asheStats(rowFor(basic.rows, label), { keep: ['jobs', 'median', 'p25', 'p75', 'p90'], weekly: true });
            sectors[key] = {
              annualGross: g ? { src: sG, ...g } : null,
              weeklyBasic: b ? { src: sB, ...b } : null,
              basicAnnualised: b ? annualiseWeekly(b, sB) : null,
            };
          }
          result.ashe.sector = {
            edition: ed.editionLabel,
            sectors,
            note: 'Whole-economy, not occupation-specific. The headline public-sector premium at the median coexists with a public-sector deficit at the mean, because the private sector has the longer right tail. Neither figure describes senior roles.',
          };
          if (sectors.public?.annualGross?.median && sectors.private?.annualGross?.median) {
            log(`  Table 13 full-time annual gross: public £${sectors.public.annualGross.median.toLocaleString('en-GB')} vs private £${sectors.private.annualGross.median.toLocaleString('en-GB')}`);
          }
        } catch (err) { warn(`ASHE t13: ${err.message}`); }
      }
    }
  }

  // ---- Table 15, the London adjustment ------------------------------------
  // Rule 13. The national public-sector premium is the wrong framing device for
  // a London-concentrated workforce, so the regional split is not optional.
  if (SKIP_T15) {
    warn('ASHE Table 15 skipped by --skip-table15; the London adjustment is absent from this build');
  } else {
    const t15eds = await asheEditions(ASHE_DATASETS.t15.slug);
    if (t15eds.length) {
      const ed = await asheEdition(ASHE_DATASETS.t15.slug, t15eds[0]);
      if (ed) {
        log(`  Table 15 ${ed.edition}: ${ed.file} (large, cached hard)`);
        const { buf, mode } = await fetchBytes(ed.downloadUrl, { label: `ASHE t15 ${ed.edition}` });
        if (buf) {
          log(`    ${(buf.length / 1048576).toFixed(1)} MB (${mode})`);
          try {
            const zipFiles = unzip(buf);
            // The four-digit variant sits in its own folder inside the zip.
            const gross = asheSubTable(zipFiles, '15 (4).7a');
            const prov = {
              publisher: 'Office for National Statistics',
              url: `https://www.ons.gov.uk${ed.uri}`,
              edition: ed.editionLabel,
              provisional: ed.kind === 'provisional',
              sourceDate: ed.releaseDate,
              windowEnd: `${ed.year}-04-30`,
              correctionNotice: ed.correctionNotice,
              note: 'Description column carries "Region, Occupation"; the region is taken from a fixed list, never by splitting on the first comma, because several occupation names contain commas.',
            };
            const src = addSource(`ashe-t15-7a-${ed.edition}`, { ...prov, name: 'ASHE Table 15 (4).7a - Annual pay, gross, by work region and occupation', table: gross.file, sheet: ASHE_SHEET });
            // Columnar: one row per surviving cell would otherwise repeat the
            // region name and six field names 130-odd times inside a 40 KB file.
            const wantedSocs = new Set(CROSSWALK.map(r => r.soc2020));
            const region = [];
            for (const r of gross.rows) {
              const code = String(r[ASHE_COLS.code] || '').trim();
              if (!wantedSocs.has(code)) continue;
              const desc = String(r[ASHE_COLS.desc] || '').trim();
              const regIdx = ASHE_REGIONS.findIndex(x => desc.startsWith(x + ','));
              if (regIdx < 0) continue;
              const st = asheStats(r, { keep: ['jobs', 'median', 'p75'] });
              if (st.median == null && st.p75 == null) continue; // wholly suppressed
              region.push([code, regIdx, st.jobs, st.median, st.p75]);
            }
            result.ashe.region = {
              edition: ed.editionLabel, src,
              regions: ASHE_REGIONS,
              cols: ['soc', 'regionIdx', 'jobsThousands', 'median', 'p75'],
              note: 'Annual gross pay. Most regional cells for the 11xx director codes are suppressed by ONS for quality, so absence here means "not published", never "no such jobs". A null jobsThousands means ONS did not publish a job count for that cell, so the n floor could not be applied to it.',
              rows: region,
            };
            const lon = region.find(r => r[0] === '1111' && ASHE_REGIONS[r[1]] === 'London');
            if (lon) log(`    SOC 1111 London median £${(lon[3] || 0).toLocaleString('en-GB')}`);
            log(`    regional cells kept (unsuppressed): ${region.length}`);
          } catch (err) { warn(`ASHE t15: ${err.message}`); }
        }
      }
    }
  }
}

// Rule 1, stated in data. ASHE publishes no annual basic-pay series. Weekly
// basic times 52 is the only route to one, and the two ASHE samples are not the
// same people: annual figures cover employees in the same job for over a year,
// weekly figures cover employees whose pay was unaffected by absence. The
// annualisation is therefore derived, and labelled derived.
// The caveat, the basis and the confidence are identical for every one of
// these blocks, so they are stated once at `ashe.derived` rather than repeated
// on each of a hundred-odd occupations.
function annualiseWeekly(b, src) {
  const mul = (v) => (v == null ? null : Math.round(v * 52));
  return {
    src, derived: 'weeklyBasicX52',
    median: mul(b.median), p25: mul(b.p25), p75: mul(b.p75), p90: mul(b.p90),
    nKnown: b.nKnown,
    suppressed: b.suppressed || undefined,
  };
}

const ASHE_DERIVED_NOTE = {
  basis: 'ASHE weekly basic pay (Table 14.3a / 13.3a) multiplied by 52.',
  confidence: 'hypothesis',
  caveat: 'ASHE publishes no annual basic-pay series. Weekly basic times 52 is this pipeline\'s own arithmetic. The two ASHE samples are also different people: the annual tables cover employees in the same job for over a year, the weekly tables cover employees whose pay was unaffected by absence. The annualised figure will not reconcile exactly with the annual gross series and must never be presented as an ONS publication.',
  useFor: 'This, not annualGross, is the base-against-base comparator for SCS organogram pay. annualGross includes incentive pay.',
};

// ============================================================================
// 2. Civil Service Statistics (ACSES) ODS
// ============================================================================
async function ingestAcses(result) {
  log('\n== Civil Service Statistics (ACSES) ==');
  const coll = await fetchJSON('https://www.gov.uk/api/content/government/collections/civil-service-statistics', 'ACSES collection');
  const docs = (coll?.links?.documents || []).map(d => d.base_path).filter(p => /civil-service-statistics-\d{4}$/.test(p));
  if (!docs.length) { warn('ACSES: collection listed no editions'); return; }
  const newest = docs.map(p => ({ p, y: Number(p.match(/(\d{4})$/)[1]) })).sort((a, b) => b.y - a.y)[0];
  const page = await fetchJSON(`https://www.gov.uk/api/content${newest.p}`, `ACSES ${newest.y}`);
  if (!page) return;
  const att = (page.details?.attachments || []).find(a => /^Statistical tables/i.test(a.title || '') && String(a.url).endsWith('.ods'));
  if (!att) { warn(`ACSES ${newest.y}: no "Statistical tables" ODS attachment`); return; }
  log(`  ${page.title} -> ${att.url.split('/').pop()}`);
  const { buf } = await fetchBytes(att.url, { label: `ACSES ${newest.y} ODS` });
  if (!buf) return;

  let sheets;
  try { sheets = odsSheets(buf); } catch (err) { warn(`ACSES: ${err.message}`); return; }
  log(`  ${sheets.length} sheets in content.xml`);

  const asOf = `${newest.y}-03-31`;
  const base = {
    name: `Civil Service Statistics ${newest.y}`,
    publisher: 'Cabinet Office',
    url: `https://www.gov.uk${newest.p}`,
    edition: String(newest.y),
    sourceDate: (page.public_updated_at || '').slice(0, 10) || null,
    windowEnd: asOf,
    extraction: 'ODS content.xml parsed with built-ins; sheets located by printed title, not by sheet name',
  };

  // Tables are located by title. The sheet actually read is recorded so a
  // renumbering between editions is visible rather than silent.
  const find = (label, re) => {
    const t = odsFindByTitle(sheets, re);
    if (!t) { warn(`ACSES ${newest.y}: no sheet titled like ${label}`); return null; }
    log(`  ${label} -> sheet ${t.name}`);
    return t;
  };

  const out = { edition: String(newest.y), asOf, tables: {} };

  // Profession quartiles. Validates the study's own profession classifier and
  // gives the official 18-name profession list.
  const prof = find('profession quartiles', /quartile[\s\S]*salary by profession/i);
  if (prof) {
    const src = addSource(`acses-${newest.y}-profession-quartiles`, { ...base, table: prof.title, sheet: prof.name });
    const hdr = prof.rows.findIndex(r => /profession of post/i.test(String(r[0] || '')));
    const rows = [];
    for (const r of prof.rows.slice(hdr + 1)) {
      const name = String(r[0] || '').trim();
      if (!name || /^note|^source/i.test(name)) continue;
      const q1 = cell(r[1]), md = cell(r[2]), q3 = cell(r[3]);
      if (q1.v == null && md.v == null && q3.v == null) continue;
      rows.push({ profession: name, p25: round0(q1.v), median: round0(md.v), p75: round0(q3.v), suppressed: [q1.sup, md.sup, q3.sup].some(Boolean) ? { p25: q1.sup, median: md.sup, p75: q3.sup } : undefined });
    }
    out.tables.professionQuartiles = { src, sheet: prof.name, title: prof.title, rows };
    log(`    professions: ${rows.length}`);
  }

  // Median salary by responsibility level. The SCS control total.
  const lvl = find('median by responsibility level', /Median salary for employees by responsibility level/i);
  if (lvl) {
    const src = addSource(`acses-${newest.y}-level-medians`, { ...base, table: lvl.title, sheet: lvl.name });
    const hdr = lvl.rows.findIndex(r => /responsibility level/i.test(String(r[0] || '')) && r.length > 3);
    const header = lvl.rows[hdr] || [];
    const allIdx = header.findIndex(h => /^Median salary of all civil servants$/i.test(String(h || '').trim()));
    const rows = [];
    for (const r of lvl.rows.slice(hdr + 1)) {
      const name = String(r[0] || '').trim();
      if (!name || /^note|^source/i.test(name)) continue;
      const c = cell(allIdx >= 0 ? r[allIdx] : null);
      rows.push({ level: name, median: round0(c.v), suppressed: c.sup || undefined });
    }
    out.tables.levelMedians = { src, sheet: lvl.name, title: lvl.title, rows };
    const scs = rows.find(r => /senior civil service/i.test(r.level));
    if (scs) log(`    SCS median (all civil servants) £${(scs.median || 0).toLocaleString('en-GB')}`);
  }

  // Counts by gross salary band, including the 100k / 150k / 200k lines.
  const bands = find('salary bands', /employment by gross salary band/i);
  if (bands) {
    const src = addSource(`acses-${newest.y}-salary-bands`, { ...base, table: bands.title, sheet: bands.name });
    const hdr = bands.rows.findIndex(r => /^salary band$/i.test(String(r[0] || '').trim()));
    const header = bands.rows[hdr] || [];
    const ftIdx = header.findIndex(h => /Total headcount of all civil servants working in a full-time role/i.test(String(h || '')));
    const ptIdx = header.findIndex(h => /Total headcount of all civil servants working in a part-time role/i.test(String(h || '')));
    const rows = [];
    for (const r of bands.rows.slice(hdr + 1)) {
      const band = String(r[0] || '').trim();
      if (!band || /^note|^source/i.test(band)) continue;
      const ft = cell(ftIdx >= 0 ? r[ftIdx] : null), pt = cell(ptIdx >= 0 ? r[ptIdx] : null);
      rows.push({ band, fullTime: round0(ft.v), partTime: round0(pt.v), suppressed: (ft.sup || pt.sup) ? { fullTime: ft.sup, partTime: pt.sup } : undefined });
    }
    out.tables.salaryBands = { src, sheet: bands.name, title: bands.title, rows };
    log(`    salary bands: ${rows.length}`);
  }

  // Median salary by responsibility level and department, SCS column only.
  // The whole table is 155 organisations wide and would eat the size budget;
  // the SCS column is the only one this study can be checked against.
  const dept = find('median by level and department', /median salary by responsibility level and government department/i);
  if (dept) {
    const src = addSource(`acses-${newest.y}-scs-median-by-dept`, { ...base, table: dept.title, sheet: dept.name, note: 'Only the Senior Civil Service column is shipped; the source table also carries Grade 6/7, SEO/HEO, EO and AA/AO columns.' });
    const hdr = dept.rows.findIndex(r => /civil service parent department/i.test(String(r[0] || '')));
    const header = dept.rows[hdr] || [];
    const scsIdx = header.findIndex(h => /Senior Civil Service level/i.test(String(h || '')));
    // Parent-department names repeat across 149 rows, so they are dictionary
    // encoded rather than written out each time.
    const parents = [];
    const rows = [];
    for (const r of dept.rows.slice(hdr + 1)) {
      const parent = String(r[0] || '').trim(), org = String(r[1] || '').trim();
      if (!parent || !org || /^note|^source/i.test(parent)) continue;
      const c = cell(scsIdx >= 0 ? r[scsIdx] : null);
      if (c.v == null && !c.sup) continue;
      let pi = parents.indexOf(parent);
      if (pi < 0) { parents.push(parent); pi = parents.length - 1; }
      rows.push([pi, org, round0(c.v), c.sup]);
    }
    out.tables.scsMedianByOrg = {
      src, sheet: dept.name, title: dept.title,
      parents,
      cols: ['parentIdx', 'organisation', 'scsMedian', 'suppressedReason'],
      note: 'suppressedReason "confidential-small-numbers" means fewer than ten SCS in that organisation, not zero. It is the control total to check this study\'s own department medians against.',
      rows,
    };
    log(`    organisations with an SCS median: ${rows.filter(r => r[2] != null).length} of ${rows.length}`);
  }

  result.acses = out;
}

// ============================================================================
// 3. Cabinet Office evidence to the SSRB, and the SSRB's own report (PDF)
// ============================================================================
// Rule 4. Everything below is extracted, checksummed, and compared against the
// last approved reading. A changed checksum parks the new value in `pending`.

// Take the lines from a heading to the first "Source:" (or a line cap). This is
// the block that is checksummed: a layout change anywhere inside it trips the
// gate, which is the whole point.
function pdfBlock(text, headingRe, maxLines = 60) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => headingRe.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < Math.min(lines.length, start + maxLines); i++) {
    out.push(lines[i]);
    if (i > start + 2 && /^\s*Source:/.test(lines[i])) break;
  }
  return { text: out.join('\n'), startLine: start + 1 };
}

const blockSha = (s) => sha256(Buffer.from(s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), 'utf8'));

// Apply the review gate to one extracted table.
//   verified  - checksum matches the approved one, extraction promoted to live
//   changed   - checksum moved, live stays put, extraction parked in pending
//   unreviewed- nothing approved yet, live falls back to the curated value
function reviewGate(id, { docUrl, block, parsed, fallback, review, approvals }) {
  if (!block) return { id, state: 'not-found', live: fallback ?? null, pending: null, note: 'the table heading was not found in the extracted text' };
  const sha = blockSha(block.text);
  const prev = review?.approved?.[id] || null;
  const entry = { id, docUrl, blockSha: sha, blockLine: block.startLine };
  if (APPROVE && parsed == null) {
    warn(`${id}: --approve refused, the extraction produced nothing. Approving a null would bless a broken parser.`);
    return { ...entry, state: 'parse-empty', live: fallback ?? null, pending: null };
  }
  if (APPROVE) {
    approvals[id] = {
      docUrl, blockSha: sha, approvedOn: TODAY,
      approvedBy: 'scripts/benchmarks.mjs --approve',
      approvalMeans: 'A person compared this extraction against the published table before running --approve. It is not a claim that the extraction is self-validating.',
      values: parsed,
    };
    return { ...entry, state: 'approved-this-run', live: parsed, pending: null };
  }
  if (!prev) {
    warn(`${id}: no approved baseline; the extracted figures are parked in pending and are NOT live. Run --approve after checking them against the published table.`);
    return { ...entry, state: 'unreviewed', live: fallback ?? null, pending: parsed, approvedOn: null };
  }
  if (prev.docUrl !== docUrl || prev.blockSha !== sha) {
    warn(`${id}: the published table changed (${prev.docUrl !== docUrl ? 'new document' : 'new layout or values'}). Live figures are unchanged; the new reading is in pending and needs review.`);
    return { ...entry, state: 'changed', live: prev.values, pending: parsed, approvedOn: prev.approvedOn, previousSha: prev.blockSha };
  }
  return { ...entry, state: 'verified', live: parsed, pending: null, approvedOn: prev.approvedOn };
}

const SSRB_CAVEATS = [
  'Table 6 is a single year and two grades. Director General has no comparator and pay band 1A is suppressed. It is an anchor, not a trend.',
  'Korn Ferry updated its civil service reference levels in October 2023, so the 2022 gap is not comparable with 2023 or 2024. Draw the break.',
  'Civil service figures are base pay on a full-time-equivalent basis for those in scope of the SSRB remit as at 1 April.',
];

// Cabinet Office evidence, Annex F Table 3 (SCS median by payband and year) and
// Table 6 (median base salary against Korn Ferry public and private).
function parseSsrbEvidenceTables(text) {
  const money = (s) => { const c = cell(String(s).replace(/[£,]/g, '')); return c.v == null ? null : Math.round(c.v); };
  const out = {};

  const t3 = pdfBlock(text, /^\s*Table 3: SCS median salary by payband and year/, 40);
  if (t3) {
    const rows = [];
    for (const line of t3.text.split('\n')) {
      const m = line.match(/^\s*(\d{4})\s+(£[\d,]+|\.\.)\s+(£[\d,]+|\.\.)\s+(£[\d,]+|\.\.)\s+(£[\d,]+|\.\.)\s*$/);
      if (m) rows.push({ year: Number(m[1]), deputyDirector: money(m[2]), deputyDirector1A: money(m[3]), director: money(m[4]), directorGeneral: money(m[5]) });
    }
    if (rows.length) out.medianByPayband = rows;
  }

  const t6 = pdfBlock(text, /^\s*Table 6: Median base salary for SCS and public and private sector equivalents/, 30);
  if (t6) {
    const grades = ['deputyDirector', 'deputyDirector1A', 'director', 'directorGeneral'];
    const cmp = {};
    for (const [key, re] of [['civilService', /^\s*Civil Service\s+(.+)$/], ['public', /^\s*Public\s+(.+)$/], ['private', /^\s*Private\s+(.+)$/]]) {
      const line = t6.text.split('\n').find(l => re.test(l));
      if (!line) continue;
      const cells = line.match(re)[1].trim().split(/\s{2,}/).map(s => s.trim());
      const row = {};
      grades.forEach((g, i) => { row[g] = cells[i] === '-' || cells[i] == null ? null : money(cells[i]); });
      cmp[key] = row;
    }
    if (Object.keys(cmp).length) out.marketComparison = cmp;
  }
  return { out, blocks: { medianByPayband: t3, marketComparison: t6 } };
}

async function ingestSsrbEvidence(result, review, approvals) {
  log('\n== Cabinet Office evidence to the SSRB ==');
  const p = await havePdftotext();
  if (!p.ok) {
    warn('pdftotext is not installed: no SSRB PDF is parsed this run and the curated figures below are shipped instead');
    // Same shape as a parsed run, so a consumer never has to branch on whether
    // the build machine happened to have poppler on it.
    const src = addSource('ssrb-evidence', {
      name: 'Government evidence to the Senior Salaries Review Body on the pay of the Senior Civil Service',
      publisher: 'Cabinet Office',
      url: 'https://www.gov.uk/government/publications/government-evidence-to-the-senior-salaries-review-body-on-the-pay-of-the-senior-civil-service',
      table: 'Annex F Table 6',
      sourceDate: '2025-10-30',
      extraction: 'curated fallback: pdftotext was not available on the build machine',
    });
    result.ssrb = {
      pdftotext: null, src,
      document: null,
      medianByPayband: { id: 'ssrb-evidence-median-by-payband', state: 'skipped-no-pdftotext', live: SSRB_EVIDENCE_CURATED.medianByPayband, pending: null },
      marketComparison: { id: 'ssrb-evidence-market-comparison', state: 'skipped-no-pdftotext', live: SSRB_EVIDENCE_CURATED.marketComparison, pending: null },
      caveats: SSRB_CAVEATS,
    };
    return;
  }
  log(`  ${p.version}`);
  const page = await fetchJSON('https://www.gov.uk/api/content/government/publications/government-evidence-to-the-senior-salaries-review-body-on-the-pay-of-the-senior-civil-service', 'SSRB evidence page');
  if (!page) return;
  const pdfs = (page.details?.attachments || []).filter(a => a.content_type === 'application/pdf' && /Government evidence/i.test(a.title || ''));
  if (!pdfs.length) { warn('SSRB evidence: no PDF attachment found'); return; }
  const latest = pdfs[0];
  log(`  ${latest.title}`);
  const { buf } = await fetchBytes(latest.url, { label: 'SSRB evidence PDF' });
  if (!buf) return;
  const text = await pdfText(buf, latest.url);
  if (!text) return;

  const { out, blocks } = parseSsrbEvidenceTables(text);
  const src = addSource('ssrb-evidence', {
    name: latest.title,
    publisher: 'Cabinet Office',
    url: latest.url,
    table: 'Annex F Tables 3 and 6',
    sourceDate: (page.public_updated_at || '').slice(0, 10) || null,
    windowEnd: null,
    extraction: 'pdftotext -layout, behind a checksum and review gate',
    note: 'Table 6 public and private comparators come from the Korn Ferry reward benchmarking report commissioned by the Cabinet Office. Korn Ferry updated its civil service reference levels in October 2023, so 2022 is not comparable with later years.',
  });

  const gateMedian = reviewGate('ssrb-evidence-median-by-payband', {
    docUrl: latest.url, block: blocks.medianByPayband, parsed: out.medianByPayband || null,
    fallback: SSRB_EVIDENCE_CURATED.medianByPayband, review, approvals,
  });
  const gateMarket = reviewGate('ssrb-evidence-market-comparison', {
    docUrl: latest.url, block: blocks.marketComparison, parsed: out.marketComparison || null,
    fallback: SSRB_EVIDENCE_CURATED.marketComparison, review, approvals,
  });

  result.ssrb = {
    pdftotext: p.version,
    src,
    document: { title: latest.title, url: latest.url, publicUpdatedAt: page.public_updated_at || null },
    medianByPayband: gateMedian,
    marketComparison: gateMarket,
    caveats: SSRB_CAVEATS,
  };
  if (gateMedian.live?.length) log(`  median by payband: ${gateMedian.live.length} years (${gateMedian.state})`);
  if (gateMarket.live) log(`  market comparison: ${gateMarket.state}`);
}

// SSRB annual report: Figure 3.5 salary medians by band, and the total
// remuneration gap figure whose number moves between editions.
async function ingestSsrbReport(result, review, approvals) {
  log('\n== SSRB annual report ==');
  const p = await havePdftotext();
  if (!p.ok) { result.ssrbReport = { src: null, document: null, bandMedians: { id: 'ssrb-report-band-medians', state: 'skipped-no-pdftotext', live: null, pending: null } }; return; }
  // Report slugs are predictable; the practitioner guidance slugs are not.
  const year = new Date().getUTCFullYear();
  let page = null, slug = null;
  for (let y = year; y >= year - 2 && !page; y--) {
    slug = `government/publications/senior-salaries-review-body-report-${y}`;
    page = await fetchJSON(`https://www.gov.uk/api/content/${slug}`, `SSRB report ${y}`);
  }
  if (!page) { warn('SSRB report: no recent edition resolved'); return; }
  const pdf = (page.details?.attachments || []).find(a => a.content_type === 'application/pdf');
  if (!pdf) { warn('SSRB report: no PDF attachment'); return; }
  log(`  ${page.title}`);
  const { buf } = await fetchBytes(pdf.url, { label: 'SSRB report PDF' });
  if (!buf) return;
  const text = await pdfText(buf, pdf.url);
  if (!text) return;

  // Figures are images. Their data labels survive pdftotext but their position
  // does not, so only the salary-medians figure is parsed, and only by reading
  // the labels in the order the chart prints them. Anything less certain than
  // that is left to the curated tier.
  const block = pdfBlock(text, /^\s*Figure [\d.]+: Salary medians for each pay band/, 30);
  let parsed = null;
  if (block) {
    // The chart labels only its final points. Axis ticks and data labels are
    // both "£nnn,nnn", and their VALUES cannot be told apart (£175,000 and
    // £125,000 are ticks; £156,500 is data), but their POSITIONS can:
    // pdftotext -layout keeps axis labels in the left gutter and data labels
    // out at the right-hand end of the plot. Anything less certain than three
    // gutter-free labels is not parsed at all.
    const AXIS_GUTTER = 20;
    const labels = [];
    for (const line of block.text.split('\n')) {
      for (const m of line.matchAll(/£([\d,]{5,9})\b/g)) {
        if (m.index < AXIS_GUTTER) continue;         // axis tick
        const v = Number(m[1].replace(/,/g, ''));
        if (v > 40000 && v < 400000) labels.push(v);
      }
    }
    const uniq = [...new Set(labels)].sort((a, b) => b - a);
    // Exactly three bands are plotted. Four or two means the chart changed and
    // the reading is abandoned rather than guessed.
    if (uniq.length === 3) {
      parsed = {
        scs3: uniq[0], scs2: uniq[1], scs1: uniq[2],
        asOfYear: (block.text.match(/to\s+(20\d\d)/) || [])[1] || null,
        note: 'Bands are assigned by rank: SCS 3 above SCS 2 above SCS 1. The chart prints the values but not which series each belongs to.',
      };
    } else {
      warn(`SSRB report: the salary-medians figure yielded ${uniq.length} data labels, not 3; nothing was read from it`);
    }
  }
  const src = addSource('ssrb-report', {
    name: page.title,
    publisher: 'Office of Manpower Economics (Senior Salaries Review Body)',
    url: pdf.url,
    table: 'Figure: salary medians for each pay band',
    sourceDate: (page.public_updated_at || '').slice(0, 10) || null,
    extraction: 'pdftotext -layout data labels, behind a checksum and review gate',
    note: 'The figure is an image. Its data labels extract but its axis does not, and the underlying series is marked "Cabinet Office (unpublished)" in the report. Figure numbers move between editions, so the figure is found by its caption text.',
  });
  const gate = reviewGate('ssrb-report-band-medians', {
    docUrl: pdf.url, block, parsed, fallback: null, review, approvals,
  });
  result.ssrbReport = { src, document: { title: page.title, url: pdf.url }, bandMedians: gate };
  if (gate.live) log(`  band medians: SCS1 £${gate.live.scs1?.toLocaleString('en-GB')} SCS2 £${gate.live.scs2?.toLocaleString('en-GB')} SCS3 £${gate.live.scs3?.toLocaleString('en-GB')} (${gate.state})`);
}

// ============================================================================
// 4. SCS pay practitioner guidance - the band scaffold
// ============================================================================
// Slugs are unpredictable ("Senior Civil Service Pay Award 2022/23 -
// practitioner guidance" one year, "Guidance on the Senior Civil Service Pay
// Award 2026/27" the next), so discovery goes through the Search API and a
// title regex rather than a constructed path.
const SCS_GUIDANCE_RE = /senior civil service pay (award|framework)/i;

async function ingestScsBands(result, review, approvals) {
  log('\n== SCS pay practitioner guidance ==');
  // Two queries, merged. The titles alternate between "... Pay Award 2022/23 -
  // practitioner guidance" and "Guidance on the ... Pay Award 2026/27", and
  // relevance ranking drops one form or the other depending on the wording.
  const queries = [
    'https://www.gov.uk/api/search.json?q=senior+civil+service+pay+award+practitioner+guidance&count=40&fields=title,link,public_timestamp,format',
    'https://www.gov.uk/api/search.json?q=guidance+on+the+senior+civil+service+pay+award&count=40&fields=title,link,public_timestamp,format',
  ];
  const seen = new Map();
  for (const url of queries) {
    const j = await fetchJSON(url, 'SCS guidance search');
    for (const r of j?.results || []) if (r.link && !seen.has(r.link)) seen.set(r.link, r);
  }
  if (!seen.size) { warn('SCS guidance: search returned nothing'); return; }
  const hits = [...seen.values()]
    .filter(r => SCS_GUIDANCE_RE.test(r.title || ''))
    .map(r => ({ ...r, year: Number((String(r.title).match(/(20\d\d)\s*\/\s*\d\d/) || [])[1] || 0) }))
    .filter(r => r.year > 0)
    .sort((a, b) => b.year - a.year);
  if (!hits.length) { warn('SCS guidance: no result matched the title regex'); return; }
  log(`  ${hits.length} editions discovered, newest ${hits[0].year}/${String(hits[0].year + 1).slice(2)}`);

  const p = await havePdftotext();
  const bands = [];
  const editions = [];
  // Only the newest two editions are parsed: the band scaffold only needs to be
  // current, and every extra edition is another PDF through the review gate.
  for (const hit of hits.slice(0, 2)) {
    const page = await fetchJSON(`https://www.gov.uk/api/content${hit.link}`, `SCS guidance ${hit.year}`);
    if (!page) continue;
    const pdf = (page.details?.attachments || []).find(a => a.content_type === 'application/pdf');
    editions.push({ year: hit.year, title: page.title, page: `https://www.gov.uk${hit.link}`, pdf: pdf?.url || null, publicUpdatedAt: page.public_updated_at || null });
    if (!pdf || !p.ok) continue;
    const { buf } = await fetchBytes(pdf.url, { label: `SCS guidance ${hit.year} PDF` });
    if (!buf) continue;
    const text = await pdfText(buf, pdf.url);
    if (!text) continue;
    const block = pdfBlock(text, /Pay Band\s+Minimum\s*\(£\)\s+Maximum\s*\(£\)/, 30);
    let parsed = null;
    if (block) {
      const rows = [];
      for (const line of block.text.split('\n')) {
        const m = line.match(/^\s*(1A\*?|1|2|3)\s+£\s?([\d,]+)\s+£\s?([\d,]+)\s*$/);
        if (m) rows.push({ band: m[1].replace('*', ''), min: Number(m[2].replace(/,/g, '')), max: Number(m[3].replace(/,/g, '')) });
      }
      if (rows.length) parsed = { effectiveFrom: `${hit.year}-04-01`, payYear: `${hit.year}/${String(hit.year + 1).slice(2)}`, bands: rows };
    }
    const src = addSource(`scs-pay-bands-${hit.year}`, {
      name: page.title,
      publisher: 'Cabinet Office',
      url: pdf.url,
      table: 'Revised SCS pay ranges',
      sourceDate: (page.public_updated_at || '').slice(0, 10) || null,
      windowEnd: `${hit.year + 1}-03-31`,
      extraction: 'pdftotext -layout, behind a checksum and review gate',
      note: 'Pay band 1A is closed to recruitment; existing staff remain on it.',
    });
    const gate = reviewGate(`scs-pay-bands-${hit.year}`, { docUrl: pdf.url, block, parsed, fallback: null, review, approvals });
    bands.push({ year: hit.year, src, ...gate });
    if (gate.live?.bands) log(`    ${gate.live.payYear}: ${gate.live.bands.map(b => `${b.band} £${b.min.toLocaleString('en-GB')}-£${b.max.toLocaleString('en-GB')}`).join('; ')} (${gate.state})`);
  }
  result.scsPayBands = { editions, parsed: bands };
}

// ============================================================================
// 5. The role crosswalk - SCS role to SOC 2020 to market title
// ============================================================================
// Explicit and editable. Codes are SOC 2020. The mapping is a judgement, so
// every row carries its own confidence and the weak ones say why they are weak.
const CROSSWALK = [
  { scsRole: 'Permanent Secretary / Director General (SCS3-4)', soc2020: '1111', marketTitle: 'Chief executives and senior officials', confidence: 'hypothesis', note: 'Primary SCS comparator and the most abused one. Long right tail: the mean sits far above the median and p90 is suppressed. Use p75 against SCS3, never the mean, and never the median against a Permanent Secretary.' },
  { scsRole: 'Director / Deputy Director, generic', soc2020: '1139', marketTitle: 'Functional managers and directors n.e.c.', confidence: 'hypothesis', note: 'The residual director code. Broad by construction.' },
  { scsRole: 'Digital, Data and Technology', soc2020: '1137', marketTitle: 'Information technology directors', confidence: 'fact', note: 'Not 1136.' },
  { scsRole: 'Finance', soc2020: '1131', marketTitle: 'Financial managers and directors', confidence: 'fact' },
  { scsRole: 'Commercial', soc2020: '1134', marketTitle: 'Purchasing managers and directors', confidence: 'fact' },
  { scsRole: 'Communications', soc2020: '1133', marketTitle: 'Public relations and communications directors', confidence: 'fact' },
  { scsRole: 'Human Resources', soc2020: '1136', marketTitle: 'Human resource managers and directors', confidence: 'fact', note: 'Not 1132 or 1135. SOC 1135 is charitable-organisation managers.' },
  { scsRole: 'Medical and Health', soc2020: '1171', marketTitle: 'Health services and public health managers and directors', confidence: 'fact' },
  { scsRole: 'Education', soc2020: '2321', marketTitle: 'Head teachers and principals', confidence: 'hypothesis', note: 'SOC 2010\'s 2317 has no direct SOC 2020 equivalent, so this arm of the series carries a classification break.' },
  { scsRole: 'Legal', soc2020: '2412', marketTitle: 'Solicitors and lawyers', confidence: 'hypothesis', note: 'Depressed by junior and part-time staff. Use p75 or p90 against SCS grades.' },
  { scsRole: 'Economics and Statistics', soc2020: '2433', marketTitle: 'Actuaries, economists and statisticians', confidence: 'fact' },
  { scsRole: 'Project Delivery', soc2020: '2440', marketTitle: 'Business and financial project management professionals', confidence: 'fact' },
  { scsRole: 'Policy and analysis', soc2020: '2431', marketTitle: 'Management consultants and business analysts', confidence: 'hypothesis', note: 'The weakest match in the table. There is no market equivalent of a policy profession, and this code is a stand-in, not a comparator.' },
  { scsRole: 'DDaT - project management', soc2020: '2131', marketTitle: 'IT project managers', confidence: 'hypothesis' },
  { scsRole: 'DDaT - business analysis and architecture', soc2020: '2133', marketTitle: 'IT business analysts, architects and systems designers', confidence: 'hypothesis' },
  { scsRole: 'DDaT - cyber security', soc2020: '2135', marketTitle: 'Cyber security professionals', confidence: 'hypothesis' },
  { scsRole: 'Regulation and inspection', soc2020: '2482', marketTitle: 'Quality assurance and regulatory professionals', confidence: 'hypothesis' },
  { scsRole: 'Baseline, non-SCS context anchor', soc2020: '4111', marketTitle: 'National government administrative occupations', confidence: 'fact', note: 'Not a comparator. It is the floor the SCS sits above, included so the scale of the ladder is visible.' },
];

// ============================================================================
// 6. Curated tier - hand-entered, cited, staleness-checked
// ============================================================================
// Every row must carry sourceUrl, sourceDate, lastReviewed and confidence. A
// lastReviewed older than 14 months fails the build. Figures whose value could
// not be verified in this run carry value: null and say so, rather than
// carrying a number nobody checked.
const CURATED = [
  {
    id: 'ssrb-total-remuneration-gap',
    label: 'SCS total remuneration against private and public sector equivalents, by pay band',
    publisher: 'Senior Salaries Review Body (47th report, 2025), Figure 3.7',
    sourceUrl: 'https://assets.publishing.service.gov.uk/media/682f20dec054883884bff424/SSRB_47th_Report_2025_Web_Accessible.pdf',
    sourceDate: '2025-05-22',
    windowEnd: '2024-12-31',
    lastReviewed: '2026-08-15',
    confidence: 'fact',
    verified: true,
    extraction: 'manual transcription of a chart image, verified against the pdftotext data labels in this run',
    licence: 'Open Government Licence v3.0',
    values: {
      deputyDirectorPrivate: { 2022: -40, 2023: -34, 2024: -31 },
      deputyDirectorPublic: { 2022: -19, 2023: -11, 2024: -7 },
      directorPrivate: { 2022: -54, 2023: -48, 2024: -46 },
      directorPublic: { 2022: -37, 2023: -28, 2024: -25 },
    },
    unit: 'per cent difference',
    caveats: [
      'The figure caption says "total remuneration" while its own note says the percentages are the difference between median salaries. The report is internally inconsistent; both readings are carried here rather than one being chosen.',
      'Korn Ferry updated its civil service reference levels in October 2023, so 2022 is not directly comparable with 2023 or 2024. Render 2022 detached or annotate the break.',
      'Source is Cabinet Office data marked unpublished, using the Korn Ferry reward benchmarking report commissioned by the Cabinet Office.',
      'The 2026 SSRB report contains no equivalent figure, so this series has not been extended past 2024.',
    ],
  },
  {
    id: 'nhs-vsm-chief-executive',
    label: 'NHS very senior manager chief executive pay, mean per person',
    publisher: 'Senior Salaries Review Body report 2026, Figure 5.2 (source: NHS England, unpublished)',
    sourceUrl: 'https://assets.publishing.service.gov.uk/media/6a0f2a5a0a1a96d9418d2799/Senior_Salaries_Review_Body_Report_2026.pdf',
    sourceDate: '2026-05-21',
    windowEnd: '2025-06-30',
    lastReviewed: '2026-08-15',
    confidence: 'fact',
    verified: true,
    extraction: 'manual transcription of a chart image, read from the pdftotext data labels in this run',
    licence: 'Open Government Licence v3.0',
    values: { meanAnnualEarnings: 233767, meanAnnualBasicPay: 221615 },
    unit: 'GBP per year',
    caveats: [
      'Board-level roles only, and the SSRB notes the underlying identification of VSMs may misclassify some individuals.',
      'The adjacent-public-sector comparison this supports is a Director General median of about £152,600 against an NHS trust chief executive mean of about £222,000 basic. A mean against a median is not a like-for-like comparison and must be labelled as such.',
    ],
  },
  {
    id: 'nash-squared-dlr-2025',
    label: 'UK CIO and CTO average salary, Nash Squared Digital Leadership Report 2025',
    publisher: 'Nash Squared',
    sourceUrl: null,
    sourceDate: '2025-11-01',
    windowEnd: '2025-12-31',
    lastReviewed: '2026-08-15',
    confidence: 'hypothesis',
    verified: false,
    extraction: 'recruiter survey; self-selected respondent base, no sampling frame',
    licence: 'not open; cited, not redistributed',
    values: { cioAverage: 198610, ctoAverage: 175800 },
    unit: 'GBP per year',
    resolved: false,
    caveats: [
      'The source URL was not resolved in this run, so the figures are carried as reported by the build scout and not re-verified. Treat as an order-of-magnitude marker, never as a benchmark.',
      'Recruiter surveys have no sampling frame and skew toward larger employers and toward respondents willing to disclose. Never presented as equivalent to ASHE.',
    ],
  },
  {
    id: 'ons-adhoc-11690-sector-by-occupation',
    label: 'ASHE four-digit occupation by public and private sector (ONS ad hoc 11690)',
    publisher: 'Office for National Statistics',
    sourceUrl: null,
    sourceDate: null,
    windowEnd: '2021-04-30',
    lastReviewed: '2026-08-15',
    confidence: 'hypothesis',
    verified: false,
    extraction: null,
    licence: 'Open Government Licence v3.0',
    values: null,
    resolved: false,
    caveats: [
      'The only official source that splits occupation by sector, and the slug was not resolvable in this run, so no sector-by-occupation adjustment is applied and none is invented.',
      'Frozen at 2016 to 2021 in any case, and must never be presented as current.',
      'In its absence the sector split available here is ASHE Table 13, which is whole-economy and NOT occupation-specific. Do not use it as an occupation adjustment.',
    ],
  },
  {
    id: 'geography-caveat-ifs',
    label: 'Public sector pay is lower than private in London, the South East and the East',
    publisher: 'Institute for Fiscal Studies / House of Commons Library',
    sourceUrl: 'https://commonslibrary.parliament.uk/research-briefings/sn08037/',
    sourceDate: null,
    windowEnd: null,
    lastReviewed: '2026-08-15',
    confidence: 'hypothesis',
    verified: false,
    extraction: 'qualitative finding, no figure transcribed',
    licence: 'Open Parliament Licence',
    values: null,
    caveats: [
      'Carried as a mandatory framing caveat, not as a number. The national public-sector premium at the median is the wrong instrument for a London-concentrated workforce; use the ASHE Table 15 London figures in this file instead.',
      'The briefing URL was not fetched in this run and is recorded as a pointer for the reader, not as an extracted source.',
    ],
  },
];

// Fallback used only when pdftotext is unavailable or nothing has been approved
// yet. Read off the published Cabinet Office evidence of October 2025.
const SSRB_EVIDENCE_CURATED = {
  medianByPayband: null,
  marketComparison: {
    civilService: { deputyDirector: 88500, deputyDirector1A: null, director: 114200, directorGeneral: 152600 },
    public: { deputyDirector: 99900, deputyDirector1A: null, director: 160400, directorGeneral: null },
    private: { deputyDirector: 133200, deputyDirector1A: null, director: 222900, directorGeneral: null },
  },
};

// ============================================================================
// 7. Sources deliberately not contacted
// ============================================================================
const EXCLUDED = [
  { source: 'Glassdoor', verdict: 'out', reason: 'robots.txt sets Disallow: / for anthropic-ai, ClaudeBot and Claude-Web by name; salary pages reject automated clients; terms of service prohibit scraping. Three independent bars. No request is made, not even to check.' },
  { source: 'Indeed', verdict: 'out', reason: 'Terms of service prohibit automated collection.' },
  { source: 'Adzuna', verdict: 'out', reason: 'The API works and has a free tier, but the terms forbid use "in aggregation (including average salaries)" without written consent. Publishing medians is precisely the prohibited use, and a free tier is not implied permission.' },
  { source: 'Payscale', verdict: 'out', reason: 'Self-reported with no sampling frame and thin UK senior samples. Adds noise and a weak provenance line beside ONS.' },
  { source: 'Levels.fyi', verdict: 'out', reason: 'Out on relevance, not legality. United States big-technology total compensation: wrong market, wrong shape.' },
  { source: 'Nomis ASHE API', verdict: 'out', reason: 'NM_99_1 has no occupation dimension at all. The ONS spreadsheet route is the only way to four-digit SOC. Recorded so nobody scouts it again.' },
  { source: "TaxPayers' Alliance Town Hall Rich List", verdict: 'out', reason: 'Not open-licensed, individual-level named data on thousands of people, and local government rather than the Senior Civil Service.' },
  { source: 'Spencer Stuart UK Board Index', verdict: 'out', reason: 'FTSE 150 non-executive and main-board pay including equity and long-term incentives. Wrong comparator; it would overstate the gap.' },
  { source: 'Civil Service Statistics data browser', verdict: 'link-only', reason: 'No API. Kept as a link for the reader, never as a source.' },
  { source: 'ITJobsWatch', verdict: 'quarantined-elsewhere', reason: 'Legally clean but CC BY-NC-SA, information-technology roles only, and advertised rather than paid salary. It lives in benchmarks-itjw.json with its own licence notice; it is never merged into this file.' },
];

// ============================================================================
// Honesty checks over the assembled file
// ============================================================================
// Rule 6, rule 7 and rule 15 as assertions rather than intentions. A figure
// that fails one of these is not shipped with a caveat, it is not shipped.
function auditHonesty(result) {
  const problems = [];
  // Provenance is inherited: a table names its source once and its rows sit
  // inside it. What the audit forbids is a figure with no source anywhere up
  // the chain.
  const walk = (node, trail, sourced) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${trail}[${i}]`, sourced)); return; }
    const here = sourced || 'src' in node || 'id' in node || 'sourceUrl' in node;
    // Suppression must never have been coerced to zero.
    for (const k of ['median', 'mean', 'p25', 'p75', 'p90', 'min', 'max']) {
      if (node[k] === 0) problems.push(`${trail}.${k} is exactly 0, which for a pay figure means a suppression was coerced`);
    }
    if (('median' in node || 'marketComparison' in node) && !here) {
      problems.push(`${trail} carries figures with no src, id or sourceUrl anywhere above it`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${trail}.${k}`, here);
  };
  walk(result.ashe, 'ashe', false);
  walk(result.acses, 'acses', false);

  // Curated staleness. A build check fails anything reviewed over 14 months ago.
  for (const c of result.curated) {
    if (!c.lastReviewed) { problems.push(`curated:${c.id} has no lastReviewed`); continue; }
    const age = monthsBetween(c.lastReviewed);
    if (age > STALE_MONTHS) problems.push(`curated:${c.id} was last reviewed ${age.toFixed(1)} months ago (limit ${STALE_MONTHS})`);
    if (typeof c.verified !== 'boolean') problems.push(`curated:${c.id} has no boolean verified flag`);
    // A figure nobody re-read this run may still ship, but it must say so, so a
    // renderer can mark it rather than presenting it like an ONS reading.
    if (c.values && c.verified === false && c.resolved !== false) {
      problems.push(`curated:${c.id} carries unverified values without resolved:false`);
    }
    if (!c.sourceUrl && c.values && c.resolved !== false) {
      problems.push(`curated:${c.id} carries values with no sourceUrl and is not flagged resolved:false`);
    }
    if (!['fact', 'hypothesis', 'contested'].includes(c.confidence)) problems.push(`curated:${c.id} confidence "${c.confidence}" is not fact|hypothesis|contested`);
  }
  for (const r of result.crosswalk) {
    if (!['fact', 'hypothesis', 'contested'].includes(r.confidence)) problems.push(`crosswalk:${r.soc2020} confidence "${r.confidence}" is not fact|hypothesis|contested`);
  }
  return problems;
}

// Rule 15. Two sources materially disagreeing about the same quantity for the
// same role is a finding, not an error to be averaged away. The threshold is
// 20 per cent, and both readings are shipped.
function findContested(result) {
  const out = [];
  const ashe = (soc) => result.ashe.occupations.find(o => o.soc === soc && !o.provisional) || result.ashe.occupations.find(o => o.soc === soc);

  const market = result.ssrb?.marketComparison?.live;
  if (market?.private) {
    // Rule 8: occupation is not seniority. A Director is compared against the
    // upper quartile of the occupation, not its median, because a four-digit
    // SOC pools every rank that answers to the same job title.
    const pairs = [
      { role: 'Deputy Director', soc: '1139', stat: 'median', korn: market.private.deputyDirector },
      { role: 'Director', soc: '1139', stat: 'p75', korn: market.private.director },
    ];
    for (const p of pairs) {
      const o = ashe(p.soc);
      const a = o?.basicAnnualised?.[p.stat] ?? o?.annualGross?.[p.stat] ?? null;
      if (a == null || p.korn == null) continue;
      const diff = Math.abs(p.korn - a) / ((p.korn + a) / 2);
      if (diff > 0.2) {
        out.push({
          quantity: `private sector base pay for the ${p.role} grade`,
          confidence: 'contested',
          readings: [
            { source: 'ssrb-evidence', basis: 'Korn Ferry grade-matched private sector median', value: p.korn },
            { source: `ashe SOC ${p.soc}`, basis: `ASHE annualised basic pay, ${p.stat}, whole economy`, value: a },
          ],
          spreadPct: Math.round(diff * 1000) / 10,
          why: 'Korn Ferry matches on job level; ASHE matches on occupation code. A four-digit SOC pools a two-person firm\'s director with a FTSE director, so the two are measuring different populations and neither is wrong. Show both.',
        });
      }
    }
  }

  // The SCS's own two published medians for the same grade in the same year.
  const evid = result.ssrb?.medianByPayband?.live;
  const rep = result.ssrbReport?.bandMedians?.live;
  // Same grade, same year, two Cabinet Office publications. Different years are
  // not a disagreement, they are a pay rise, so the comparison is only made when
  // the two readings describe the same year.
  if (Array.isArray(evid) && rep?.scs1 && rep.asOfYear) {
    const sameYear = evid.find(r => String(r.year) === String(rep.asOfYear));
    if (sameYear?.deputyDirector) {
      const diff = Math.abs(rep.scs1 - sameYear.deputyDirector) / ((rep.scs1 + sameYear.deputyDirector) / 2);
      if (diff > 0.02) {
        out.push({
          quantity: `SCS pay band 1 median salary, ${rep.asOfYear}`,
          confidence: 'contested',
          readings: [
            { source: 'ssrb-evidence', basis: `Cabinet Office evidence to the SSRB, ${sameYear.year}`, value: sameYear.deputyDirector },
            { source: 'ssrb-report', basis: `SSRB report figure, ${rep.asOfYear}`, value: rep.scs1 },
          ],
          spreadPct: Math.round(diff * 1000) / 10,
          why: 'Two Cabinet Office publications, one year, two numbers. The SSRB figure is read off a chart image, so this is a reminder that neither is precise to the pound rather than a contradiction.',
        });
      }
    }
  }
  return out;
}

// ============================================================================
// main
// ============================================================================
async function main() {
  const t0 = Date.now();
  await mkdir(CACHE, { recursive: true });
  await mkdir(path.dirname(REVIEW), { recursive: true });

  // A typo in --only would otherwise select nothing and overwrite a good
  // benchmarks.json with an empty one.
  const SOURCE_IDS = ['ashe', 'acses', 'ssrb', 'scsbands'];
  const unknown = ONLY.filter(id => !SOURCE_IDS.includes(id));
  if (unknown.length) fatal(`unknown --only source(s): ${unknown.join(', ')} (known: ${SOURCE_IDS.join(', ')})`);

  const review = await readJSON(REVIEW);
  const approvals = { ...(review?.approved || {}) };

  const result = {
    schema: SCHEMA,
    generated: null,        // newest upstream publication date in the file, set below
    contentDigest: null,    // sha256 over the payload with the date stamps removed
    purpose: 'External comparators for UK Senior Civil Service pay. Every figure is base pay unless it says otherwise, every figure names its source, and a suppressed figure is null with a reason.',
    honestyRules: HONESTY_RULES,
    socBreaks: SOC_BREAKS,
    crosswalk: CROSSWALK,
    sources: {},
    ashe: { editions: [], derived: ASHE_DERIVED_NOTE, occupations: [], sector: null, region: null },
    acses: null,
    ssrb: null,
    ssrbReport: null,
    scsPayBands: null,
    curated: CURATED,
    excluded: EXCLUDED,
    contested: [],
    warnings: [],
  };

  if (wanted('ashe')) await ingestAshe(result);
  if (wanted('acses')) await ingestAcses(result);
  if (wanted('ssrb')) await ingestSsrbEvidence(result, review, approvals);
  if (wanted('ssrb')) await ingestSsrbReport(result, review, approvals);
  if (wanted('scsbands')) await ingestScsBands(result, review, approvals);

  result.sources = sources;
  result.contested = findContested(result);
  result.warnings = [...warnings].sort();
  // Deterministic stamp: the newest thing a publisher released, not the moment
  // this script ran. Two runs from cache then differ only in lastReviewed.
  result.generated = [...Object.values(sources)].map(s => s.sourceDate).filter(Boolean).sort().pop() || null;
  // The digest deliberately drops lastReviewed and generated so a monthly cron
  // can tell "ONS published something" from "the calendar moved".
  result.contentDigest = sha256(Buffer.from(JSON.stringify(result, (k, v) => (k === 'lastReviewed' || k === 'generated' || k === 'contentDigest' ? undefined : v))));

  const problems = auditHonesty(result);
  if (problems.length) {
    console.error('\nHONESTY CHECK FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    fatal(`${problems.length} honesty check failure(s)`);
  }

  const json = JSON.stringify(result) + '\n';
  const bytes = Buffer.byteLength(json);
  const gz = gzipSync(Buffer.from(json)).length;

  if (DRY_RUN) {
    log(`\n-- dry run: nothing written (${(bytes / 1024).toFixed(1)}KB raw, ${(gz / 1024).toFixed(1)}KB gz)`);
  } else {
    if (bytes > BUDGET_BYTES) fatal(`benchmarks.json is ${(bytes / 1024).toFixed(1)}KB raw against a ${BUDGET_BYTES / 1024}KB budget; trim before shipping`);
    if (gz > BUDGET_GZIP) fatal(`benchmarks.json is ${(gz / 1024).toFixed(1)}KB gzipped against a ${BUDGET_GZIP / 1024}KB budget; trim before shipping`);
    await mkdir(path.dirname(OUT), { recursive: true });
    const tmp = OUT + '.tmp';
    await writeFile(tmp, json);
    await rename(tmp, OUT);
    if (APPROVE) {
      await writeFile(REVIEW, JSON.stringify({ schema: SCHEMA, note: 'Approved readings for every PDF-derived figure. A changed checksum parks the new reading in pending and leaves these alone until a human re-approves with --approve.', approved: approvals }, null, 1) + '\n');
      log(`  wrote ${REVIEW} (${Object.keys(approvals).length} approved tables)`);
    }
  }

  summarise(result, bytes, gz, t0);
}

async function readJSON(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

const HONESTY_RULES = [
  'Base against base. ASHE 14.7a is annual gross and includes incentive pay; 14.3a is basic pay but weekly. The annualised basic figure is derived and labelled derived.',
  'Pension is stated on every comparison. The civil service alpha employer contribution is worth roughly 23.6 to 28 per cent of salary against a typical private defined-contribution 3 to 8 per cent, so a bare salary gap overstates the difference by roughly a quarter of the salary.',
  'Never print an SCS median to the pound. Published bands are £5,000 wide, so there is at least £2,500 of imprecision before any aggregation. Round to £1,000 and say why.',
  'Every pay instrument shows its disclosure rate. Two thirds of SCS posts have their pay withheld and the withholding is grade-dependent.',
  'Ranges against ranges. p25 to p75 against p25 to p75, with n and sourceDate on the mark. Never a point against a point.',
  `Below n = ${N_FLOOR} there is no figure, only a count.`,
  'Suppression is null, never zero. ASHE x, :, .. and -, and ACSES [c] and [n], each arrive with the reason recorded.',
  'Occupation is not seniority. SOC 1111 pools a two-person firm\'s chief executive with a FTSE chief executive. Against SCS2 and above use p75 or p90, and say on the instrument that you have.',
  'SOC classification breaks are drawn as breaks: SOC 2020 from 2021, SOC 2010 from 2011 to 2020, SOC 2000 before that.',
  'The Korn Ferry gap series is not continuous. Reference levels changed in October 2023, so 2022 is detached.',
  'The Korn Ferry table is one year and two grades. It is an anchor, not a trend.',
  'Per-figure dates, not a page stamp. Every block names a source carrying its own sourceDate, windowEnd and lastReviewed.',
  'The geography caveat is mandatory. Public pay sits below private in London, the South East and the East, and the SCS is London-concentrated, so the national premium is the wrong framing device.',
  'The high-earner threshold moved from £150,000 to £174,000 between 2022 and 2025 and there is a genuine two-year hole. Never interpolate it.',
  'Confidence is exactly fact, hypothesis or contested. Two sources materially disagreeing about the same quantity for the same role is contested, and both readings ship.',
];

function summarise(r, bytes, gz, t0) {
  log('\n== done ==');
  const socLine = (soc) => {
    const o = r.ashe.occupations.find(x => x.soc === soc);
    if (!o) return `  SOC ${soc}            : not read`;
    const g = o.annualGross, b = o.weeklyBasic, a = o.basicAnnualised;
    return `  SOC ${soc} ${String(o.description).slice(0, 34).padEnd(34)}: 14.7a annual gross median ${g?.median ? '£' + g.median.toLocaleString('en-GB') : 'suppressed'}  |  14.3a weekly basic median ${b?.median ? '£' + b.median.toLocaleString('en-GB') : 'suppressed'}  (x52 = ${a?.median ? '£' + a.median.toLocaleString('en-GB') : 'n/a'})`;
  };
  log(`  ASHE editions       : ${r.ashe.editions.map(e => e.edition).join(', ') || 'none'}  sheet ${ASHE_SHEET}`);
  for (const soc of ['1111', '1137', '1131', '4111']) log(socLine(soc));
  log(`  ASHE occupations    : ${r.ashe.occupations.length} rows`);
  log(`  ASHE regional cells : ${r.ashe.region?.rows?.length ?? 0}`);
  log(`  ACSES               : ${r.acses ? `${r.acses.edition}, tables ${Object.keys(r.acses.tables).join(', ')}` : 'not read'}`);
  log(`  SSRB evidence       : ${r.ssrb?.marketComparison?.state ?? 'not read'} / median-by-payband ${r.ssrb?.medianByPayband?.state ?? '-'}`);
  log(`  SSRB report         : ${r.ssrbReport?.bandMedians?.state ?? 'not read'}`);
  log(`  SCS pay bands       : ${(r.scsPayBands?.parsed || []).map(b => `${b.year}:${b.state}`).join(' ') || (r.scsPayBands ? `${r.scsPayBands.editions.length} editions listed, none parsed` : 'not read')}`);
  log(`  curated rows        : ${r.curated.length}  (oldest review ${r.curated.map(c => c.lastReviewed).sort()[0]})`);
  log(`  contested figures   : ${r.contested.length}`);
  log(`  sources cited       : ${Object.keys(r.sources).length}`);
  log(`  size                : ${(bytes / 1024).toFixed(1)}KB raw / ${(gz / 1024).toFixed(1)}KB gz  (gate ${BUDGET_BYTES / 1024}KB raw, ${BUDGET_GZIP / 1024}KB gz; build plan said ${PLAN_BUDGET_BYTES / 1024}KB raw)`);
  if (r.warnings.length) for (const w of r.warnings) log(`  WARNING             : ${w}`);
  log(`  elapsed             : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
