// Cabinet Office high-earner lists -> public/data/highearners.json
//
// The organograms band every senior salary in £5,000 steps, so the study can
// never say what anyone is paid. These two publications are the only place
// central government publishes an exact-figure accounting of its highest
// earners, which is why they are worth a pipeline of their own.
//
// They are also a trap. The disclosure threshold moved from £150,000 to
// £174,000 between the 2022 and 2025 editions, the file schema changed three
// times, and there is a genuine two-year hole: no list exists for
// 30 September 2023 or 30 September 2024. A single line drawn through all of
// that would invent a level shift AND two years of data.
//
// Five rules this script exists to enforce:
//   1. The two eras stay STRUCTURALLY separate in the output. They are
//      different populations measured against different thresholds.
//   2. The hole is emitted as an explicit gap and is never interpolated. The
//      script asserts that no series point falls on a gap date.
//   3. A like-for-like line is produced by RECOMPUTING the 2010-2022 files at
//      the £174,000 cutoff — possible because floor and ceiling are per row —
//      and it ships as a separate, labelled series. It is never merged into
//      the published series.
//   4. "Civil Service" is a filter, not an assumption. Only 157 of the 659
//      rows in the 2025 list are Civil Service; 231 are commercial enterprises
//      in the public sector and 177 are other central government. The column
//      does not exist before the 2015 edition, so a civil-service series
//      simply does not start until then and says so.
//   5. NAMES NEVER REACH public/data/. The name columns are read for exactly
//      one purpose — to build the set of forbidden strings the emitted payload
//      is then checked against — and are never stored. The check is a hard
//      assertion: it exits 2 and writes nothing.
//
// Counts against a banded threshold are a RANGE, not a number. £174,000 falls
// inside the published £170,000-£174,999 band, so every threshold count ships
// as [certain, possible]: certain = pay floor at or above the threshold,
// possible = pay ceiling at or above it. Reporting one number would decide a
// line the data cannot resolve.
//
// Node 22 built-ins only (global fetch). Fail-soft per attachment; hard-fail on
// the signatures that mean the corpus itself is wrong, because a silent partial
// run is indistinguishable from success.
//
//   node scripts/highearners.mjs                  # full run, both publications
//   node scripts/highearners.mjs --check          # change-detect only, writes nothing
//   node scripts/highearners.mjs --only 2010,2025 # named editions (cheap test)
//   node scripts/highearners.mjs --max-files 4    # cap downloads (cheap test)
//   node scripts/highearners.mjs --dry-run        # parse everything, write nothing
//   node scripts/highearners.mjs --no-cache       # force re-download
//
import { mkdir, writeFile, readFile, stat, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { parseCSV, sniffBinary, decodeBody, normHeader, findCol, normGrade, GRADE_BANDS } from './lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const TARGET = path.join(OUT, 'highearners.json');
const CONTENT_API = 'https://www.gov.uk/api/content/';
const UA = 'scs-earnings-highearners/1.0 (+https://strangeramblings.com)';
const FETCH_TIMEOUT = 60000;
const REVALIDATE_MONTHS = 18;
const GZ_BUDGET = 250 * 1024;
const SCHEMA = 1;

// ---- CLI ------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(name);
const opt = (name, dflt = null) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};
const USE_CACHE = !flag('--no-cache');
const DRY_RUN = flag('--dry-run');
const CHECK_ONLY = flag('--check');
const ONLY = (opt('--only') || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_FILES = Number(opt('--max-files', '0')) || 0;
const PARTIAL = ONLY.length > 0 || MAX_FILES > 0;

// ---- the two publications --------------------------------------------------
// Do NOT use CKAN for these. The `uk-civil-service-high-earners` package is
// frozen at 2012 with dead URLs. The gov.uk Content API returns
// public_updated_at plus details.attachments[], which is everything change
// detection needs; the per-page .atom feeds 404 and there is no push channel.
//
// The 2010-2022 page was frozen on 2023-07-20 and replaced, not continued: the
// successor is a different publication with a different threshold, a different
// schema and a different title. Treating them as one series is the single
// biggest mistake available here.
const SOURCES = [
  {
    id: 'list-150k',
    era: '150k',
    path: 'government/publications/senior-officials-high-earners-salaries',
    thresholdGBP: 150000,
    thresholdWording: 'earning £150,000 and above',
    expectFrozen: true,
    minEditions: 13,
  },
  {
    id: 'list-174k',
    era: '174k',
    path: 'government/publications/cabinet-office-senior-officials-high-earners-list',
    thresholdGBP: 174000,
    thresholdWording: 'earning more than £174,000',
    expectFrozen: false,
    minEditions: 1,
  },
];

// Floor assertions for a full run. Below any of these the corpus is broken,
// not small: refuse to promote the output. Measured 2026-08: 14 editions,
// 5,813 rows kept, 1,765 of them Civil Service.
const FLOORS = { editions: 14, rows: 5000, civilService: 1500 };

// The published `Type of organisation` values. Only the first is the civil
// service; the other two are why an unfiltered count of this list is not a
// civil-service figure. Case varies between editions ("Other Central
// Government", "commercial enterprise in the public sector"), so match folded.
const ORG_TYPES = [
  'Civil Service',
  'Other central government',
  'Commercial enterprise in the public sector',
];

// Grade bands. The organogram ladder from lib.mjs, plus the two bands this
// publication has and the organograms do not: board members paid a fee rather
// than a salary, and the NHS very senior manager scale. Without them
// "Non-Executive Director" falls through lib's /director/ rule and 200-odd
// board fees are counted as SCS2 directors.
const NON_EXEC_BAND = 'Non-executive / chair';
const VSM_BAND = 'NHS very senior manager';

// Senior military officers are published here by RANK NAME, where the
// organograms publish them as OF-6..OF-9 codes. lib's normGrade only knows the
// codes, so without this table ~250 four- and three-star officers — Chief of
// the Defence Staff among them — fall into "Other / Not stated". Mapped by
// exact normalised rank so "General" and "Lieutenant General" cannot collide.
const MILITARY_RANKS = new Map(Object.entries({
  'brigadier': 'OF-6', 'commodore': 'OF-6', 'air commodore': 'OF-6',
  'major general': 'OF-7', 'rear admiral': 'OF-7', 'air vice marshal': 'OF-7',
  'lieutenant general': 'OF-8', 'lt general': 'OF-8', 'vice admiral': 'OF-8', 'air marshal': 'OF-8',
  'general': 'OF-9', 'admiral': 'OF-9', 'air chief marshal': 'OF-9',
  'field marshal': 'OF-10', 'admiral of the fleet': 'OF-10', 'marshal of the raf': 'OF-10',
}));
const HE_GRADE_BANDS = (() => {
  const out = [];
  for (const b of GRADE_BANDS) {
    if (b === 'Below SCS') { out.push(VSM_BAND, NON_EXEC_BAND); }
    out.push(b);
  }
  return out;
})();

const PAY_KINDS = ['band', 'exact', 'floor-only', 'not-published'];

const log = (...a) => console.log(...a);
const warn = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function fatal(msg) {
  console.error(`\nFATAL: ${msg}`);
  console.error('nothing was written; the previous output is untouched.');
  process.exit(2);
}

// ---- HTTP ------------------------------------------------------------------
async function getJSON(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (res.ok) return await res.json();
      if (res.status === 404) return { __status: 404 };
    } catch { /* retry */ }
    await sleep(500 * (t + 1));
  }
  return null;
}

// Fetch one attachment as bytes. gov.uk asset URLs are content-addressed, so a
// new edition arrives at a new URL — but a correction can be republished over
// the same one, which is what the ETag revalidation window catches. Anything
// on a page not touched for 18 months is treated as immutable.
async function fetchBody(url, pageUpdatedAt, tries = 3) {
  const key = sha1(url);
  const bodyPath = path.join(CACHE, key + '.bin');
  const metaPath = path.join(CACHE, key + '.meta.json');
  let cached = null, validators = null;
  if (USE_CACHE) {
    try {
      const s = await stat(bodyPath);
      if (s.size > 0) cached = await readFile(bodyPath);
    } catch { /* no cache */ }
    try { validators = JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* none */ }
  }
  const fresh = monthsSince(pageUpdatedAt) < REVALIDATE_MONTHS;
  if (cached && !fresh) return { buf: cached, mode: 'cache' };

  const headers = { 'user-agent': UA };
  if (cached && validators?.etag) headers['if-none-match'] = validators.etag;
  if (cached && validators?.lastModified) headers['if-modified-since'] = validators.lastModified;

  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (res.status === 304 && cached) return { buf: cached, mode: 'revalidated' };
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(bodyPath, buf).catch(() => {});
        await writeFile(metaPath, JSON.stringify({
          etag: res.headers.get('etag') || null,
          lastModified: res.headers.get('last-modified') || null,
        })).catch(() => {});
        return { buf, mode: 'download' };
      }
      if (res.status === 404 || res.status === 403) break;
    } catch { /* retry */ }
    await sleep(500 * (t + 1));
  }
  if (cached) return { buf: cached, mode: 'cache-stale' };
  return { buf: null, mode: 'fail' };
}

function monthsSince(when) {
  const then = Date.parse(when);
  if (!Number.isFinite(then)) return 999;
  return (Date.now() - then) / (1000 * 60 * 60 * 24 * 30.44);
}

// ---- edition identity from the attachment title ----------------------------
// The publisher states the reference date in the attachment title and nowhere
// else. Three shapes exist and the difference matters: the 2013 and 2014
// editions report 31 March while every edition from 2015 reports 30 September,
// and the first three editions give a year only. Inferring a date for those
// would be inventing one, so they carry the year and say the date is unknown.
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

function editionFromTitle(title) {
  const t = String(title || '');
  const m = t.match(/as at\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) {
      const refDate = `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
      return { key: refDate, year: +m[3], refDate, refConfidence: 'declared' };
    }
  }
  const y = t.match(/\b(20\d{2})\b/);
  if (y) return { key: y[1], year: +y[1], refDate: null, refConfidence: 'year-only' };
  return null;
}

// ---- money -----------------------------------------------------------------
// The 2010 file writes six Ministry of Defence board fees as "£40k" / "£30k",
// a bare figure rather than a band. parseMoney() strips the suffix and returns
// 40, so the k multiplier is handled here before anything else touches it.
function parseAmount(s) {
  const raw = String(s ?? '').trim();
  if (raw === '') return NaN;
  const mult = /[0-9]\s*k$/i.test(raw) ? 1000 : 1;
  const cleaned = raw.replace(/[£$,\s]/g, '').replace(/[^0-9.]/g, '');
  if (cleaned === '') return NaN;
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v * mult : NaN;
}

// A combined "floor - ceiling" cell, as used by the 2010 edition
// ("£150,000 - £154,999") and by the 2025 schema ("174000 - 179999"). A cell
// naming ONE figure ("£40k") is an exact salary, not an open-ended floor —
// unlike a two-column row with a floor and a blank ceiling, which is.
function splitRange(s) {
  const raw = String(s ?? '').trim();
  if (raw === '') return [NaN, NaN];
  const parts = raw.split(/\s*(?:-|–|—|to)\s*/i).filter(p => p.trim() !== '');
  if (parts.length >= 2) return [parseAmount(parts[0]), parseAmount(parts[1])];
  const v = parseAmount(raw);
  return [v, v];
}

// (floor, ceiling) -> the honest pay shape. Nothing is ever imputed: a row
// with a floor and no ceiling stays open-ended rather than gaining a £4,999
// span it was never published with.
function payShape(floorRaw, ceilRaw) {
  const lo = Number.isFinite(floorRaw) && floorRaw > 0 ? Math.round(floorRaw) : null;
  const hi = Number.isFinite(ceilRaw) && ceilRaw > 0 ? Math.round(ceilRaw) : null;
  if (lo == null && hi == null) return { floor: null, ceil: null, kind: 'not-published' };
  if (lo != null && hi == null) return { floor: lo, ceil: null, kind: 'floor-only' };
  if (lo == null && hi != null) return { floor: hi, ceil: hi, kind: 'exact' };
  if (lo === hi) return { floor: lo, ceil: hi, kind: 'exact' };
  return { floor: Math.min(lo, hi), ceil: Math.max(lo, hi), kind: 'band' };
}

// ---- grade -----------------------------------------------------------------
// Board members and the NHS scale are tested BEFORE lib's normGrade, because
// "Non-Executive Director" matches its /director/ rule and would be filed as
// an SCS2. The raw string is kept verbatim either way: classification is a
// presentation layer, never a lossy ingest step.
function heGrade(raw) {
  const rawStr = String(raw ?? '').trim();
  const n = normHeader(rawStr);
  if (/^(non exec|nonexec|ned$|chair|chairman|chairwoman|deputy chair|vice chair|president of)/.test(n)
    || /non executive/.test(n)) {
    return { raw: rawStr, band: NON_EXEC_BAND, variant: null };
  }
  if (/very senior manager|\bvsm\b/.test(n)) {
    return { raw: rawStr, band: VSM_BAND, variant: null };
  }
  if (MILITARY_RANKS.has(n)) {
    return { raw: rawStr, band: 'Military (OF-6+)', variant: MILITARY_RANKS.get(n) };
  }
  const g = normGrade(rawStr);
  return { raw: rawStr, band: g.band, variant: g.variant };
}

// ---- three parsers, three published schemas --------------------------------
// Detection is by header shape, not by year, so a 2026 edition that keeps the
// current schema parses without a code change — and one that does not is
// rejected loudly instead of being silently misread.
//
//   A  2010            Name | Job Title | Grade | Organisation |
//                      Annual pay rate ... | Notes
//                      One combined pay cell. NO Parent Department and NO
//                      Type of organisation column at all.
//   B  2011-2022       Post Unique Reference | Name or Surname+Forename(s) |
//                      Grade [Equivalent] | Job Title | Job/Team Function |
//                      Parent Department | Organisation |
//                      [Type of organisation, 2015 onwards] |
//                      Total Pay Floor (£) | Total Pay Ceiling (£) | ...
//                      Two separate pay columns.
//   C  2025-           Surname | Forename(s) | Grade Equivalent | Job Title |
//                      Job/Team Function | Parent Department | Organisation |
//                      Type of organisation |
//                      Total pay floor and ceiling range (£) | Notes
//                      Back to one combined pay cell; no post reference.
//
// Job/Team Function and Notes are deliberately never read into a row: both are
// prose written about a named individual ("Vanessa Lawrence was the Director
// General and Chief Executive of Ordnance Survey"), so carrying them would
// walk names into the payload through the back door.
function detectParser(headers) {
  const cRange = findColExact(headers, ['total pay floor and ceiling range', 'pay floor and ceiling range']);
  const cAnnual = findColExact(headers, ['annual pay rate']);
  const cFloor = findColExact(headers, ['total pay floor', 'pay floor']);
  const cCeil = findColExact(headers, ['total pay ceiling', 'pay ceiling']);
  if (cRange >= 0) return 'C';
  if (cFloor >= 0 && cCeil >= 0 && cFloor !== cCeil) return 'B';
  if (cAnnual >= 0) return 'A';
  return null;
}

// findCol()'s loose substring fallback matches "Total pay floor and ceiling
// range (£)" for the phrase "total pay floor", which would read the 2025
// combined column as a floor-only file. Word-prefix matching only, no
// fallback: these headers are stable enough not to need one, and a wrong
// column here is silent.
function findColExact(headers, phrases) {
  const norm = (headers || []).map(normHeader);
  for (const phrase of phrases) {
    const p = normHeader(phrase);
    for (let i = 0; i < norm.length; i++) if (norm[i] === p || norm[i].startsWith(p + ' ')) return i;
  }
  return -1;
}

function columnsA(h) {
  return {
    parser: 'A',
    org: findColExact(h, ['organisation', 'organization']),
    parent: -1,
    orgType: -1,
    title: findColExact(h, ['job title', 'post title']),
    grade: findColExact(h, ['grade']),
    range: findColExact(h, ['annual pay rate']),
    floor: -1,
    ceil: -1,
    names: nameColumns(h),
  };
}

function columnsB(h) {
  return {
    parser: 'B',
    org: findColExact(h, ['organisation', 'organization']),
    parent: findColExact(h, ['parent department']),
    orgType: findColExact(h, ['type of organisation', 'type of organization']),
    title: findColExact(h, ['job title', 'post title']),
    grade: findColExact(h, ['grade equivalent', 'grade']),
    range: -1,
    floor: findColExact(h, ['total pay floor', 'pay floor']),
    ceil: findColExact(h, ['total pay ceiling', 'pay ceiling']),
    names: nameColumns(h),
  };
}

function columnsC(h) {
  return {
    parser: 'C',
    org: findColExact(h, ['organisation', 'organization']),
    parent: findColExact(h, ['parent department']),
    orgType: findColExact(h, ['type of organisation', 'type of organization']),
    title: findColExact(h, ['job title', 'post title']),
    grade: findColExact(h, ['grade equivalent', 'grade']),
    range: findColExact(h, ['total pay floor and ceiling range', 'pay floor and ceiling range']),
    floor: -1,
    ceil: -1,
    names: nameColumns(h),
  };
}

// Every column that carries, or can carry, a personal identifier. Read for one
// purpose only — to build the forbidden-string set the emitted payload is
// checked against — and never stored.
function nameColumns(headers) {
  const out = { surname: -1, forename: -1, whole: -1, email: [] };
  const norm = (headers || []).map(normHeader);
  for (let i = 0; i < norm.length; i++) {
    const n = norm[i];
    if (n === 'surname') out.surname = i;
    else if (n === 'forename' || n === 'forename s' || n.startsWith('forename')) { if (out.forename < 0) out.forename = i; }
    else if (n === 'name') { if (out.whole < 0) out.whole = i; }
    else if (n.includes('e mail') || n.includes('email')) out.email.push(i);
  }
  return out;
}

// The published name for one row, or null.
//
// A placeholder is not a person: these files use "Not disclosed", "Vacant",
// "N/D" and a bare "-" in the name cell exactly as the organograms do, and a
// row whose name is withheld must read as withheld rather than as somebody
// called "Not Disclosed". Senior military officers are published by RANK rather
// than by name in some editions, which is a published fact about the post and
// is kept as-is.
function heName(sur, fore, whole) {
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  let name = clean(whole);
  if (!name) {
    const s = clean(sur), f = clean(fore);
    // Files vary: some give "Surname, Forename", some two plain columns.
    name = s && f ? `${f} ${s}` : (s || f);
  }
  if (!name) return null;
  if (/^[-—–.]+$/.test(name)) return null;
  if (/^(n[\/. ]?[ad]|not\s*(disclosed|published|provided|applicable)|non[- ]?disclos|withheld|undisclosed|vacan\w*|redact\w*|unknown|tbc|blank)$/i.test(name)) return null;
  return name.length > 80 ? name.slice(0, 80) : name;
}

// One high-earner CSV -> normalised rows + the names it contained.
// Rejection reasons are returned, never thrown: one bad attachment must never
// sink the run.
function parseHighEarners(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { ok: false, reason: 'empty', rows: [], names: [] };
  const headers = rows[0];
  const parser = detectParser(headers);
  if (!parser) return { ok: false, reason: 'no-pay-columns', rows: [], names: [] };
  const col = parser === 'A' ? columnsA(headers) : parser === 'B' ? columnsB(headers) : columnsC(headers);
  if (col.org < 0 && col.title < 0) return { ok: false, reason: 'no-post-columns', rows: [], names: [] };

  const cell = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const out = [];
  const names = [];
  let blankRows = 0, notPublished = 0, civilService = 0;
  const unknownTypes = new Set();

  for (const r of rows.slice(1)) {
    if (!r || r.length === 0) { blankRows++; continue; }
    const org = cell(r, col.org);
    const title = cell(r, col.title);
    const gradeRaw = cell(r, col.grade);
    const payRaw = col.range >= 0
      ? cell(r, col.range)
      : (cell(r, col.floor) + cell(r, col.ceil));
    if (org === '' && title === '' && gradeRaw === '' && payRaw === '') { blankRows++; continue; }

    // Names are collected for the guard's bigram set AND carried onto the row
    // (John's decision, 2026-08-16). Era B publishes either a whole "Name" or
    // Surname + Forename(s); era C always splits them.
    const sur = cell(r, col.names.surname);
    const fore = cell(r, col.names.forename);
    const whole = cell(r, col.names.whole);
    if (sur || fore || whole) names.push({ sur, fore, whole });
    const holder = heName(sur, fore, whole);

    const [lo, hi] = col.range >= 0
      ? splitRange(cell(r, col.range))
      : [parseAmount(cell(r, col.floor)), parseAmount(cell(r, col.ceil))];
    const pay = payShape(lo, hi);
    if (pay.kind === 'not-published') notPublished++;

    const grade = heGrade(gradeRaw);

    let orgType = null;
    if (col.orgType >= 0) {
      const t = cell(r, col.orgType);
      if (t !== '') {
        const canon = ORG_TYPES.find(v => v.toLowerCase() === t.toLowerCase());
        orgType = canon || t;
        if (!canon) unknownTypes.add(t);
      }
    }
    if (orgType === 'Civil Service') civilService++;

    out.push({
      org: org.slice(0, 120),
      parent: cell(r, col.parent).slice(0, 120),
      orgType,
      title: title.slice(0, 160),
      rawGrade: grade.raw.slice(0, 80),
      band: grade.band,
      payKind: pay.kind,
      floor: pay.floor,
      ceil: pay.ceil,
      holder,
    });
  }

  if (!out.length) return { ok: false, reason: 'no-rows-survived', rows: [], names: [] };

  return {
    ok: true, reason: null, parser, rows: out, names,
    stats: {
      dataRows: rows.length - 1, blankRows, notPublished, civilService,
      orgTypeAvailable: col.orgType >= 0,
      unknownTypes: [...unknownTypes].sort(cmp),
    },
  };
}

// ---- name-leak assertion ---------------------------------------------------
// The primary guard is structural: rows are built from a fixed literal shape
// that has no name field, and Job/Team Function and Notes are never read. This
// is the backstop, and it runs over the SERIALISED payload rather than over the
// fields the author believes they emitted.
//
// Detection is by name ADJACENCY, not by token. A token test is unusable here:
// 267 published job titles contain a word that is also somebody's surname —
// "Head of Airworthiness", "First Sea Lord", "Regional Director of Public
// Health South West" — and greying those out would be noise, not safety. What
// it cannot catch is a bare surname that is also an ordinary English word,
// which is precisely why the column allow-list is the primary guard.
function forbiddenPairs(names) {
  const toks = (s) => normHeader(s).split(' ').filter(Boolean);
  const pairs = new Set();
  for (const { sur, fore, whole } of names) {
    const s = toks(sur), f = toks(fore), w = toks(whole);
    if (s.length && f.length) {
      pairs.add(f[f.length - 1] + ' ' + s[0]);   // "John Larkinson"
      pairs.add(s[s.length - 1] + ' ' + f[0]);   // "Larkinson John"
    }
    for (let i = 0; i + 1 < w.length; i++) pairs.add(w[i] + ' ' + w[i + 1]);
  }
  return pairs;
}

const NAME_KEY_RE = /(^|[^a-z])(name|surname|forename|email)/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// The payload now carries post-holder names DELIBERATELY, in exactly one place:
// `rows.holder` and its dictionary (John's decision, 2026-08-16). Everything
// else about the guard stands, because the reasons for the other two rules were
// never the same as the reason for the first.
//
// What is still forbidden, and why:
//   - E-MAIL ADDRESSES. Published in some source attachments; they are contact
//     details, not the salary disclosure, and nothing here needs them.
//   - A name reaching any OTHER field. A name in `title` or `org` means the
//     parser mismatched its columns, which is a correctness fault whichever way
//     the naming policy falls — it silently shifts pay onto the wrong post.
const ALLOWED_NAME_PATH = 'dict.holder';

function assertNoNames(payload, pairs) {
  // 1. no e-mail address anywhere
  const mail = JSON.stringify(payload).match(EMAIL_RE);
  if (mail) return `an e-mail address reached the payload: ${mail[0]}`;

  // 2. no name-like KEY other than the intended one — a future edit that adds
  //    `surname` or `forename` is still caught
  const badKeys = new Set();
  (function walk(v, path) {
    if (Array.isArray(v)) { for (const x of v) walk(x, path); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const p = path ? `${path}.${k}` : k;
        if (NAME_KEY_RE.test(k) && p !== ALLOWED_NAME_PATH && !p.endsWith('.holder') && k !== 'holder') badKeys.add(p);
        walk(v[k], p);
      }
    }
  })(payload, '');
  if (badKeys.size) return `unexpected name-like field(s): ${[...badKeys].sort(cmp).join(', ')}`;

  // 3. no published name may appear anywhere EXCEPT the holder dictionary.
  //    A name in a job title or an organisation name means the parser has
  //    mismatched its columns and the pay is on the wrong row.
  const withoutHolders = JSON.parse(JSON.stringify(payload));
  // Blank the holder dictionary wherever it sits, so the bigram sweep below is
  // asking only about the OTHER fields.
  (function blank(v) {
    if (Array.isArray(v)) { for (const x of v) blank(x); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (k === 'holder') v[k] = Array.isArray(v[k]) ? [] : null;
        else blank(v[k]);
      }
    }
  })(withoutHolders);
  const toks = normHeader(JSON.stringify(withoutHolders)).split(' ').filter(Boolean);
  const bigrams = new Set();
  for (let i = 0; i + 1 < toks.length; i++) bigrams.add(toks[i] + ' ' + toks[i + 1]);
  const hits = [];
  for (const p of pairs) if (bigrams.has(p)) hits.push(p);
  if (hits.length) {
    return `${hits.length} published name(s) reached a field other than the holder `
      + `dictionary, e.g. "${hits.slice(0, 3).join('", "')}" — the parser has probably `
      + `mismatched its columns, so the pay is on the wrong post`;
  }
  return null;
}

// ---- dictionary helper -----------------------------------------------------
function dictionary(values) {
  const list = [...new Set(values.filter(v => v !== '' && v != null))].sort(cmp);
  const index = new Map(list.map((v, i) => [v, i]));
  return { list, idx: (v) => (v === '' || v == null ? -1 : index.get(v) ?? -1) };
}

// ---- threshold counting ----------------------------------------------------
// £174,000 sits inside the published £170,000-£174,999 band, so a count at that
// cutoff is a range. `certain` counts rows whose floor is at or above the
// threshold; `possible` counts rows whose ceiling is, which is every row that
// might qualify. Rows with no published pay are in neither.
function countAtThreshold(rows, threshold) {
  let certain = 0, possible = 0;
  for (const r of rows) {
    if (r.floor == null) continue;
    const hi = r.ceil == null ? r.floor : r.ceil;
    if (r.floor >= threshold) certain++;
    if (hi >= threshold) possible++;
  }
  return { certain, possible };
}

// ---- main ------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  await mkdir(CACHE, { recursive: true });

  let previous = null;
  try { previous = JSON.parse(await readFile(TARGET, 'utf8')); } catch { /* first run */ }

  // 1. resolve both publications through the Content API
  log('[1/4] resolving publications ...');
  const resolved = [];
  for (const src of SOURCES) {
    const j = await getJSON(CONTENT_API + src.path);
    if (!j || j.__status === 404) fatal(`${src.id}: ${CONTENT_API}${src.path} did not resolve — the publication has moved or been withdrawn`);
    const attachments = (j.details?.attachments || []).filter(a => a.url);
    // The count:0 signature, in Content API form: a 200 with no attachments
    // means the publication was restructured, not that it is empty. It is
    // fatal for the same reason the CKAN case is.
    if (!attachments.length) fatal(`${src.id}: resolved 200 with zero attachments — the publication has been restructured`);
    resolved.push({ ...src, api: j, attachments, title: j.title, publicUpdatedAt: j.public_updated_at, firstPublishedAt: j.first_published_at });
    log(`  ${src.id.padEnd(10)} ${attachments.length} attachments  updated ${j.public_updated_at}`);
  }

  // change detection against the last build, before anything is downloaded
  const changes = detectChanges(previous, resolved);
  if (CHECK_ONLY) {
    log('\n[--check] ' + (changes.changed ? 'CHANGED' : 'no change'));
    for (const line of changes.lines) log('  ' + line);
    log(`\n  elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // 2. group attachments into editions and download
  log('\n[2/4] downloading attachments ...');
  const editions = [];
  const attachmentRecords = [];
  const allNames = [];
  let downloaded = 0;

  for (const src of resolved) {
    const groups = new Map();
    for (const a of src.attachments) {
      const ed = editionFromTitle(a.title);
      if (!ed) { warn.push(`${src.id}: attachment "${a.title}" carries no year and was skipped`); continue; }
      if (!groups.has(ed.key)) groups.set(ed.key, { ...ed, attachments: [] });
      groups.get(ed.key).attachments.push(a);
    }

    for (const key of [...groups.keys()].sort(cmp)) {
      if (MAX_FILES && downloaded >= MAX_FILES) break;
      const g = groups.get(key);
      if (ONLY.length && !ONLY.includes(String(g.year)) && !ONLY.includes(key)) continue;

      // hash every attachment so a correction republished over the same URL is
      // visible, then parse the CSV. Only a URL ending .csv is parsed: the 2015
      // and 2014 CSVs are served as application/vnd.ms-excel, so content-type
      // decides nothing here.
      const parsedFor = { id: `${src.era}-${key}`, sourceId: src.id, era: src.era, ...g, rows: null, parser: null, stats: null };
      for (const a of g.attachments) {
        if (MAX_FILES && downloaded >= MAX_FILES) break;
        const isCsv = /\.csv(\?|$)/i.test(a.url);
        const { buf, mode } = await fetchBody(a.url, src.publicUpdatedAt);
        downloaded++;
        const rec = {
          editionId: parsedFor.id, sourceId: src.id, title: a.title, url: a.url,
          contentType: a.content_type || null, bytes: buf ? buf.length : null,
          sha256: buf ? sha256(buf) : null, parsed: false, status: buf ? 'ok' : 'download-failed',
        };
        attachmentRecords.push(rec);
        if (!buf) { warn.push(`${src.id} ${key}: download failed for ${a.url}`); continue; }
        if (!isCsv || parsedFor.rows) continue;

        const binary = sniffBinary(buf);
        if (binary) { rec.status = `binary:${binary}`; warn.push(`${src.id} ${key}: .csv URL is really ${binary}`); continue; }

        const res = parseHighEarners(decodeBody(buf));
        if (!res.ok) { rec.status = res.reason; warn.push(`${src.id} ${key}: ${res.reason}`); continue; }
        rec.parsed = true;
        rec.status = 'ok';
        parsedFor.rows = res.rows;
        parsedFor.parser = res.parser;
        parsedFor.stats = res.stats;
        allNames.push(...res.names);
        for (const t of res.stats.unknownTypes) warn.push(`${src.id} ${key}: unrecognised Type of organisation "${t}"`);
        log(`  ${parsedFor.id.padEnd(16)} parser ${res.parser}  ${String(res.rows.length).padStart(4)} rows  ${String(res.stats.civilService).padStart(4)} civil service  (${mode})`);
      }
      if (!parsedFor.rows) {
        warn.push(`${src.id} ${key}: no usable CSV attachment`);
        continue;
      }
      editions.push(parsedFor);
    }
  }

  if (!editions.length) fatal('no edition parsed — both publications resolved but produced nothing');

  // 3. build the payload
  log('\n[3/4] building ...');
  editions.sort((a, b) => cmp(a.era, b.era) || cmp(String(a.refDate || a.year), String(b.refDate || b.year)));

  const orgTypes = [...ORG_TYPES];
  for (const e of editions) for (const r of e.rows) {
    if (r.orgType && !orgTypes.includes(r.orgType)) orgTypes.push(r.orgType);
  }

  const dOrg = dictionary(editions.flatMap(e => e.rows.map(r => r.org)));
  const dParent = dictionary(editions.flatMap(e => e.rows.map(r => r.parent)));
  const dTitle = dictionary(editions.flatMap(e => e.rows.map(r => r.title)));
  const dGrade = dictionary(editions.flatMap(e => e.rows.map(r => r.rawGrade)));
  const dHolder = dictionary(editions.flatMap(e => e.rows.map(r => r.holder)));

  const editionRecords = editions.map((e, i) => {
    const src = resolved.find(s => s.id === e.sourceId);
    const byOrgType = {};
    for (const r of e.rows) {
      const k = r.orgType || '(not published)';
      byOrgType[k] = (byOrgType[k] || 0) + 1;
    }
    return {
      idx: i,
      id: e.id,
      sourceId: e.sourceId,
      era: e.era,
      parser: e.parser,
      year: e.year,
      refDate: e.refDate,
      refConfidence: e.refConfidence,
      refLabel: e.attachments[0]?.title || null,
      thresholdGBP: src.thresholdGBP,
      orgTypeAvailable: e.stats.orgTypeAvailable,
      rows: e.rows.length,
      civilService: e.stats.civilService,
      payPublished: e.rows.length - e.stats.notPublished,
      payNotPublished: e.stats.notPublished,
      blankRows: e.stats.blankRows,
      byOrgType: Object.fromEntries(Object.entries(byOrgType).sort((a, b) => cmp(a[0], b[0]))),
    };
  });

  // columnar rows, dictionary-encoded, sorted so two runs are byte-identical
  const flat = [];
  editions.forEach((e, i) => {
    for (const r of e.rows) flat.push({ edition: i, ...r });
  });
  flat.sort((a, b) => a.edition - b.edition
    || cmp(a.org, b.org) || cmp(a.rawGrade, b.rawGrade)
    || (a.floor ?? -1) - (b.floor ?? -1) || cmp(a.title, b.title));

  const ROW_COLS = ['edition', 'org', 'parent', 'orgType', 'title', 'rawGrade', 'band', 'payKind', 'floor', 'ceil', 'holder'];
  const data = Object.fromEntries(ROW_COLS.map(c => [c, []]));
  for (const r of flat) {
    data.edition.push(r.edition);
    data.org.push(dOrg.idx(r.org));
    data.parent.push(dParent.idx(r.parent));
    data.orgType.push(r.orgType ? orgTypes.indexOf(r.orgType) : -1);
    data.title.push(dTitle.idx(r.title));
    data.rawGrade.push(dGrade.idx(r.rawGrade));
    data.holder.push(dHolder.idx(r.holder));
    data.band.push(HE_GRADE_BANDS.indexOf(r.band));
    data.payKind.push(PAY_KINDS.indexOf(r.payKind));
    data.floor.push(r.floor);
    data.ceil.push(r.ceil);
  }
  // -1 means "absent" for a dictionary column and nothing at all for an
  // enumerated one, so an unlisted band or pay kind would decode to undefined
  // in the frontend rather than fail here.
  for (const c of ['band', 'payKind']) {
    const bad = data[c].indexOf(-1);
    if (bad >= 0) fatal(`row ${bad} has a ${c} value outside the published list: ${JSON.stringify(flat[bad])}`);
  }

  // series. Scope and basis are both explicit on every one of them: a reader
  // who takes a number off this file cannot avoid knowing which population it
  // counts and against which threshold.
  const series = [];
  for (const scope of ['civil-service', 'all-published']) {
    for (const src of resolved) {
      series.push(buildSeries({
        id: `published-${src.era}-${scope}`,
        label: `${src.title} — ${scope === 'civil-service' ? 'Civil Service only' : 'all published organisations'}`,
        sourceId: src.id, era: src.era, scope, basis: 'as published',
        thresholdGBP: src.thresholdGBP,
        note: `Counted against the threshold this publication was published at (${src.thresholdWording}).`,
      }, editions, editionRecords, scope, src.thresholdGBP, e => e.era === src.era));
    }
    // the like-for-like line: the £150k-era files recounted at the £174k
    // cutoff, which the per-row floor and ceiling make possible. Kept as its
    // own series and never merged into the published ones.
    const legacy = resolved.find(s => s.era === '150k');
    const current = resolved.find(s => s.era === '174k');
    series.push(buildSeries({
      id: `recomputed-174k-${scope}`,
      label: `2010-2022 recounted at the £174,000 cutoff — ${scope === 'civil-service' ? 'Civil Service only' : 'all published organisations'}`,
      sourceId: legacy.id, era: '150k', scope, basis: 'recomputed',
      thresholdGBP: current.thresholdGBP,
      note: 'Derived, not published. The 2010-2022 files list everyone at or above £150,000, so recounting them at £174,000 gives a like-for-like line against the 2025 list. It is a range because £174,000 falls inside the published £170,000-£174,999 band. It is NOT a published statistic and must never be drawn as one line with the published series.',
    }, editions, editionRecords, scope, current.thresholdGBP, e => e.era === '150k'));
  }

  // the hole. Derived from the editions actually found, not hardcoded, so it
  // closes by itself the moment a missing year is published.
  const gaps = buildGaps(editions);

  const breaks = buildBreaks(resolved, editionRecords);

  const stats = {
    editions: editionRecords.length,
    rows: flat.length,
    civilService: flat.filter(r => r.orgType === 'Civil Service').length,
    payPublished: flat.filter(r => r.payKind !== 'not-published').length,
    payNotPublished: flat.filter(r => r.payKind === 'not-published').length,
    exactFigures: flat.filter(r => r.payKind === 'exact').length,
    attachments: attachmentRecords.length,
    attachmentsParsed: attachmentRecords.filter(a => a.parsed).length,
    attachmentsFailed: attachmentRecords.filter(a => a.status !== 'ok').length,
    yearRange: [editionRecords[0]?.year ?? null, editionRecords[editionRecords.length - 1]?.year ?? null],
  };

  const payload = {
    schema: SCHEMA,
    // deterministic: the newest upstream publication stamp, not the wall clock
    generated: resolved.map(s => s.publicUpdatedAt).filter(Boolean).sort(cmp).pop() || null,
    scope: { only: ONLY.length ? ONLY : null, maxFiles: MAX_FILES || null, partial: PARTIAL },
    licence: 'UK Open Government Licence (OGL)',
    note: 'Two publications, two thresholds, one deliberate hole. The eras are kept separate on purpose: the disclosure threshold moved from £150,000 to £174,000 between the 2022 and 2025 editions, and no list was published for 30 September 2023 or 30 September 2024. Nothing here is interpolated across that hole. Individual names are published upstream under OGL and are carried here in rows.dict.holder, so a named post-holder can be searched for; a row whose name the publisher withheld carries none. E-mail addresses are never republished.',
    sources: resolved.map(s => ({
      id: s.id,
      era: s.era,
      title: s.title,
      page: 'https://www.gov.uk/' + s.path,
      contentApi: CONTENT_API + s.path,
      publicUpdatedAt: s.publicUpdatedAt,
      firstPublishedAt: s.firstPublishedAt,
      frozen: s.expectFrozen,
      thresholdGBP: s.thresholdGBP,
      thresholdWording: s.thresholdWording,
      thresholdTest: 'pay floor >= threshold is certain; pay ceiling >= threshold is possible',
      attachments: s.attachments.length,
      editions: editionRecords.filter(e => e.sourceId === s.id).length,
    })),
    thresholdChange: {
      from: 150000, to: 174000,
      lastEditionAtOldThreshold: editionRecords.filter(e => e.era === '150k').slice(-1)[0]?.id ?? null,
      firstEditionAtNewThreshold: editionRecords.filter(e => e.era === '174k')[0]?.id ?? null,
      note: 'A 16% rise in the threshold cuts the list. Any fall in the headline count across this boundary is the threshold moving, not pay falling.',
    },
    orgTypes,
    orgTypeNote: 'Published from the 2015 edition onwards. Only "Civil Service" is the civil service: in the 2025 list 157 of 565 published rows are Civil Service, 231 are commercial enterprises in the public sector and 177 are other central government. The 2010-2014 editions have no such column, so no civil-service figure exists for those years and none is estimated.',
    grades: HE_GRADE_BANDS,
    payKinds: PAY_KINDS,
    dict: { org: dOrg.list, parent: dParent.list, title: dTitle.list, rawGrade: dGrade.list, holder: dHolder.list },
    editions: editionRecords,
    series,
    gaps,
    breaks,
    attachments: attachmentRecords,
    rows: { n: flat.length, cols: ROW_COLS, data },
    stats,
    warnings: warn.slice().sort(cmp),
  };

  // 4. assertions, then write
  log('\n[4/4] checking ...');

  const pairs = forbiddenPairs(allNames);
  // A guard nobody has watched fail is a guard nobody knows works.
  // SCS_HE_LEAK_TEST=1 walks a real published name into the JOB TITLE dictionary
  // — which is what a column mismatch looks like — so the assertion below can be
  // seen to fire. It must exit 2 and write nothing. Names in `rows.dict.holder`
  // are intended and must NOT fire.
  if (process.env.SCS_HE_LEAK_TEST === '1') {
    const victim = allNames.find(n => n.sur && n.fore) || allNames[0];
    const injected = victim.whole || `${victim.fore} ${victim.sur}`.trim();
    payload.dict.title = payload.dict.title.concat(injected);
    log('  SCS_HE_LEAK_TEST=1 — a published name was injected into the title dictionary; the assertion must now fire');
  }
  const leak = assertNoNames(payload, pairs);
  if (leak) fatal(`NAME LEAK — ${leak}`);
  const named = payload.dict.holder.length;
  log(`  columns check out  (${pairs.size} published names checked; ${named} named post-holders carried deliberately, no names in any other field, no e-mail addresses)`);

  // the hole is a gap, not a data point
  const gapDates = new Set(gaps.flatMap(g => g.missing));
  for (const s of series) {
    for (const p of s.points) {
      if (p.refDate && gapDates.has(p.refDate)) fatal(`series ${s.id} has a point on ${p.refDate}, which is a published gap`);
    }
  }
  log(`  ${gaps.length} gap(s), ${gapDates.size} missing date(s), none interpolated`);

  if (!PARTIAL) {
    const f = [];
    if (stats.editions < FLOORS.editions) f.push(`editions ${stats.editions} < ${FLOORS.editions}`);
    if (stats.rows < FLOORS.rows) f.push(`rows ${stats.rows} < ${FLOORS.rows}`);
    if (stats.civilService < FLOORS.civilService) f.push(`civil service rows ${stats.civilService} < ${FLOORS.civilService}`);
    for (const s of resolved) {
      const n = editionRecords.filter(e => e.sourceId === s.id).length;
      if (n < s.minEditions) f.push(`${s.id} ${n} editions < ${s.minEditions}`);
    }
    if (f.length) fatal(`floor assertion failed — ${f.join('; ')}`);
    log('  floor assertions passed');
  } else {
    log('  partial run — floor assertions skipped; this build is NOT publishable');
  }

  // measure, then re-stamp warnings so a budget breach is IN the file it
  // describes rather than only on stdout
  let body = JSON.stringify(payload);
  const gz = gzipSync(Buffer.from(body)).length;
  if (gz > GZ_BUDGET) {
    warn.push(`highearners.json is ${kb(gz)} gz, over the ${kb(GZ_BUDGET)} budget`);
    payload.warnings = warn.slice().sort(cmp);
    body = JSON.stringify(payload);
  }
  log(`  size: ${kb(body.length)} raw / ${kb(gz)} gz  (budget ${kb(GZ_BUDGET)} gz)`);

  if (DRY_RUN) {
    log('\ndry run — nothing written');
    summarise(payload, changes, t0);
    return;
  }

  await mkdir(OUT, { recursive: true });
  const tmp = TARGET + '.tmp';
  JSON.parse(body);                       // parses before it can replace anything
  await writeFile(tmp, body);
  await rename(tmp, TARGET);
  log(`  wrote ${path.relative(ROOT, TARGET)}`);

  summarise(payload, changes, t0);
}

// One series: one scope, one threshold, one basis. Points carry `listed` (how
// many entries the published list holds under this scope) separately from the
// threshold counts, because the two are not the same number — both lists carry
// part-time and fee-paid roles whose actual pay is below the threshold.
function buildSeries(spec, editions, editionRecords, scope, threshold, filter) {
  const points = [];
  const omitted = [];
  for (let i = 0; i < editions.length; i++) {
    const e = editions[i];
    const rec = editionRecords[i];
    if (!filter(e)) continue;
    if (scope === 'civil-service' && !rec.orgTypeAvailable) { omitted.push(rec.id); continue; }
    const rows = scope === 'civil-service' ? e.rows.filter(r => r.orgType === 'Civil Service') : e.rows;
    if (!rows.length) continue;
    const { certain, possible } = countAtThreshold(rows, threshold);
    points.push({
      editionId: rec.id, editionIdx: i, year: rec.year, refDate: rec.refDate,
      listed: rows.length, certain, possible,
      payNotPublished: rows.filter(r => r.payKind === 'not-published').length,
    });
  }
  const first = points[0];
  return {
    ...spec,
    startsAt: first ? (first.refDate || String(first.year)) : null,
    // Editions this series cannot cover because the filter column does not
    // exist in them. A civil-service series does not start in 2010 because
    // "Type of organisation" was not published until 2015, and estimating the
    // split for the earlier editions would be inventing it.
    omittedForMissingColumn: omitted,
    points,
  };
}

// The hole, derived. Both publications report at a quarter end, and every
// edition from 2015 reports 30 September, so the missing editions between the
// last old-threshold list and the first new-threshold one are the intervening
// 30 Septembers. Four candidate slugs for 2023 and 2024 were probed and all
// 404: the lists do not exist, they are not merely unindexed.
function buildGaps(editions) {
  const byEra = (era) => editions.filter(e => e.era === era);
  const last150 = byEra('150k').slice(-1)[0];
  const first174 = byEra('174k')[0];
  if (!last150 || !first174) return [];
  const from = last150.year, to = first174.year;
  const missing = [];
  for (let y = from + 1; y < to; y++) missing.push(`${y}-09-30`);
  if (!missing.length) return [];
  return [{
    afterEdition: last150.id,
    beforeEdition: first174.id,
    missing,
    interpolated: false,
    // A --only or --max-files build holds fewer editions than gov.uk publishes,
    // so its gap is wider than the real one. Such a build is marked partial and
    // is not publishable; the flag is repeated here so the gap cannot be read
    // out of context.
    partialBuild: PARTIAL,
    reason: 'No high-earner list was published for these dates. The 2010-2022 publication was frozen and the replacement publication begins at 30 September 2025. The threshold also changed across this gap, so the two ends are not the same measurement.',
  }];
}

// Every discontinuity a reader could mistake for a change in pay.
function buildBreaks(resolved, editionRecords) {
  const out = [];
  const first174 = editionRecords.find(e => e.era === '174k');
  if (first174) {
    out.push({
      at: first174.refDate || String(first174.year),
      kind: 'threshold',
      from: 150000, to: 174000,
      note: 'Disclosure threshold raised from £150,000 to £174,000, matching HM Treasury senior pay approval guidance. The list gets shorter for that reason alone.',
    });
  }
  const firstTyped = editionRecords.find(e => e.orgTypeAvailable);
  if (firstTyped) {
    out.push({
      at: firstTyped.refDate || String(firstTyped.year),
      kind: 'column',
      note: 'First edition to publish "Type of organisation". Before it, civil service and public-sector-commercial rows cannot be told apart, so no civil-service series exists for the earlier editions.',
    });
  }
  const sep = editionRecords.find(e => e.refDate && e.refDate.endsWith('-09-30'));
  const mar = editionRecords.filter(e => e.refDate && e.refDate.endsWith('-03-31')).slice(-1)[0];
  if (sep && mar && mar.refDate < sep.refDate) {
    out.push({
      at: sep.refDate,
      kind: 'reference-date',
      note: `Reference date moved from 31 March (${mar.id}) to 30 September (${sep.id}). Consecutive editions across that move are 18 months apart, not 12.`,
    });
  }
  const yearOnly = editionRecords.filter(e => e.refConfidence === 'year-only').map(e => e.id);
  if (yearOnly.length) {
    out.push({
      at: yearOnly[0],
      kind: 'reference-date-unknown',
      editions: yearOnly,
      note: 'These editions state a year and no reference date. None is inferred: they are plotted by year and should be drawn as such.',
    });
  }
  return out;
}

// Change detection. The URL set plus each attachment's sha256 answers the two
// questions a monthly run needs to tell apart: did a new edition land, and was
// an existing one corrected in place. public_updated_at alone cannot — gov.uk
// touches it for editorial changes that leave the data untouched.
function detectChanges(previous, resolved) {
  const lines = [];
  if (!previous) return { changed: true, lines: ['no previous build on disk — everything is new'] };

  for (const src of resolved) {
    const prev = (previous.sources || []).find(s => s.id === src.id);
    if (!prev) { lines.push(`${src.id}: new publication`); continue; }
    if (prev.publicUpdatedAt !== src.publicUpdatedAt) {
      lines.push(`${src.id}: public_updated_at ${prev.publicUpdatedAt} -> ${src.publicUpdatedAt}`);
    }
    const prevUrls = new Set((previous.attachments || []).filter(a => a.sourceId === src.id).map(a => a.url));
    const nowUrls = new Set(src.attachments.map(a => a.url));
    for (const u of nowUrls) if (!prevUrls.has(u)) lines.push(`${src.id}: NEW attachment ${u}`);
    for (const u of prevUrls) if (!nowUrls.has(u)) lines.push(`${src.id}: attachment withdrawn ${u}`);
  }
  return { changed: lines.length > 0, lines: lines.length ? lines : ['no new or withdrawn attachment; no publication stamp moved'] };
}

function summarise(p, changes, t0) {
  const s = p.stats;
  log('\n== done ==');
  log(`  editions            : ${s.editions}  (${s.yearRange[0]} -> ${s.yearRange[1]})`);
  for (const src of p.sources) {
    log(`    ${src.id.padEnd(10)} threshold £${src.thresholdGBP.toLocaleString('en-GB')}  ${String(src.editions).padStart(2)} editions  ${src.frozen ? 'frozen' : 'live'}`);
  }
  log(`  rows kept           : ${s.rows}  (civil service ${s.civilService})`);
  log(`  pay published       : ${s.payPublished}  (not published ${s.payNotPublished}, exact figures ${s.exactFigures})`);
  log(`  attachments         : ${s.attachments} listed, ${s.attachmentsParsed} parsed, ${s.attachmentsFailed} not usable`);
  for (const g of p.gaps) log(`  GAP                 : ${g.missing.join(', ')}  (between ${g.afterEdition} and ${g.beforeEdition}, not interpolated)`);
  log(`  upstream vs last run: ${changes.changed ? 'CHANGED' : 'unchanged'}`);
  for (const line of changes.lines) log(`    ${line}`);
  if (p.warnings.length) for (const w of p.warnings) log(`  WARNING             : ${w}`);
  log(`  elapsed             : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('\nCRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
