// UK Government Web Archive recovery for the 2010-2012 organogram era.
//
// The main ingest fails on roughly 6% of its fetches. Most of those failures
// are not transient: the origin host is gone. hm-treasury.gov.uk redirects the
// whole 2010-2012 transparency release to a GOV.UK landing page, dmo.gov.uk
// answers with a CAPTCHA, and the CKAN records that point at
// webarchive.nationalarchives.gov.uk do so through the "/+/" replay prefix,
// which returns a framed HTML page rather than the file. All three land in the
// cache as HTML, which parses as a CSV with no pay columns, so the manifest
// records them as `no-pay-columns` and the earliest years of the corpus are
// simply absent.
//
// This script asks the archive's CDX index which captures of each dead URL
// exist, replays the chosen capture through `/ukgwa/<timestamp>id_/<url>` —
// the `id_` suffix returns the raw archived bytes rather than a rewritten
// page — and writes the result into the ingest's own cache under the same key
// the ingest hashes, so the next `npm run ingest` picks it up with no change to
// the pipeline.
//
// Two things make the earliest release harder than a download:
//
//   1. It is a TWO-FILE format. hmt_seniorstaffposts_jun2010.csv carries the
//      post structure and no pay at all; hmt_seniorstaffpay_jun2010.csv
//      carries the pay for the subset of posts whose holder was disclosed.
//      parsePosts rejects the posts file outright as `no-pay-columns`. This
//      script finds the pay sibling in the archive and joins them, then emits
//      one file in the single-file shape the parser expects. The join key is
//      resolved rather than assumed: the post reference where both sides carry
//      one, otherwise the published name, otherwise job title plus unit.
//   2. Those files use lone-CR line endings. lib.mjs `parseCSV` normalises
//      /\r\n?/ up front and is used here verbatim rather than reimplemented —
//      a private parser is how the "1 row x 290 columns" bug gets re-created.
//      A canary reports any file that still parses as a single wide row.
//
// The true earliest reference date in this corpus is 30 JUNE 2010, not
// 30 September. It only became visible once quarterEnd() snapped month names
// to all four quarter ends.
//
// One-off backfill plus a re-runnable top-up: CDX answers are cached for 30
// days, archived bodies are cached forever, and a URL whose emitted bytes are
// already in place is skipped without touching the network.
//
//   node scripts/ukgwa.mjs                     # every recoverable manifest failure
//   node scripts/ukgwa.mjs --only HMT,DFE      # limit to organisations
//   node scripts/ukgwa.mjs --from 2010-01-01 --to 2012-12-31
//   node scripts/ukgwa.mjs --url <u>[,<u>]     # ad hoc, outside the manifest
//   node scripts/ukgwa.mjs --urls-from list.txt
//   node scripts/ukgwa.mjs --limit 10          # cap the work list (cheap test)
//   node scripts/ukgwa.mjs --dry-run           # probe and join, write nothing
//   node scripts/ukgwa.mjs --force             # redo the work: ignore the skip
//                                              # and both caches (the state is
//                                              # still read, see main())
//   node scripts/ukgwa.mjs --report-only       # rebuild the reports from state
//
import { mkdir, writeFile, readFile, stat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import {
  parseCSV, parsePosts, decodeBody, sniffBinary, findCol, normHeader,
  resolveReferenceDate,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');            // the ingest's cache: <sha1(url)>.csv
const WORK = path.join(CACHE, 'ukgwa');             // this script's own scratch cache
const CDX_CACHE = path.join(WORK, 'cdx');
const MANIFEST = path.join(ROOT, 'data', 'manifest.json');
const STATE = path.join(ROOT, 'data', 'ukgwa.json');
const REPORT = path.join(ROOT, 'public', 'data', 'ukgwa.json');

const ARCHIVE = 'https://webarchive.nationalarchives.gov.uk';
const ARCHIVE_HOST = 'webarchive.nationalarchives.gov.uk';
const UA = 'scs-earnings-ukgwa/1.0 (+https://strangeramblings.com)';
const CONCURRENCY = 3;          // the archive is a public service, not a CDN
const THROTTLE_MS = 250;
const FETCH_TIMEOUT = 45000;
const CDX_TTL_DAYS = 30;
const CDX_LIMIT = 40;
const MAX_HOPS = 3;             // archived redirect chain, see resolveArchived
const JOIN_MIN_MATCH = 0.5;     // half the pay rows must find a post
const JOIN_MAX_GAP_DAYS = 120;  // posts and pay captured further apart than this is suspect
const SCHEMA = 1;

// Failure reasons the archive cannot help with. The file was found, read and
// deliberately refused: junior organograms are role-group aggregates, a
// different unit of analysis, and re-fetching them from 2011 changes nothing.
const OUT_OF_SCOPE = new Map([
  ['junior-schema', 'junior organogram schema — a different unit of analysis, deliberately out of scope'],
  ['junior-content', 'file carries no senior post — deliberately out of scope'],
  ['junior-content-fte', 'FTE column is a post count — a junior aggregate, deliberately out of scope'],
]);

const REASON_TEXT = {
  'no-capture': 'the archive holds no successful capture of this URL',
  'only-redirects': 'every archived capture is a redirect, and nothing sits behind it',
  'replay-failed': 'the archive indexed a capture but would not replay its bytes',
  'archived-body-is-html': 'the archived capture replays as a web page, not the published file',
  'archived-body-is-binary': 'the archived capture is a binary (PDF, XLS or ZIP) served under a .csv name',
  'parse-failed': 'the archived bytes were recovered but the parser still refuses them',
  'no-pay-file-found': 'a two-file posts export with no pay file anywhere in the archive',
  'pay-join-too-sparse': 'a pay file was found but too few of its rows matched a post',
  'pay-file-already-ingested': 'the pay file is already ingested in its own right — joining it would double count',
  'lone-cr-not-normalised': 'parsed as one very wide row: parseCSV is not normalising lone CR',
  'cdx-unreachable': 'the CDX index did not answer',
  'no-post-columns': 'the archived file has no grade and no job title — it is not a post export',
  'no-pay-columns': 'no pay columns and no pay file to join to',
  'empty': 'the archived file has no rows',
  'all-rows-blank': 'every row in the archived file is blank padding',
  'no-rows-survived': 'no row in the archived file survived the parser',
  'live-file-already-parses': 'the current publication is fine — there is nothing to recover',
  'out-of-scope': 'not a recovery target',
};

// ---- CLI -------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const opt = (n, d = null) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const ONLY = (opt('--only') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const FROM = opt('--from');
const TO = opt('--to');
const LIMIT = Number(opt('--limit', '0')) || 0;
const DRY_RUN = flag('--dry-run');
const FORCE = flag('--force');
const REPORT_ONLY = flag('--report-only');
const EXTRA_URLS = (opt('--url') || '').split(',').map(s => s.trim()).filter(Boolean);
const URLS_FROM = opt('--urls-from');

const log = (...a) => console.log(...a);
const warnings = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function fatal(msg) {
  console.error(`\nFATAL: ${msg}`);
  console.error('nothing was written; the ingest cache is untouched.');
  process.exit(2);
}

// ---- URL handling ----------------------------------------------------------
// CKAN records several of these resources through the archive's own replay
// prefix, e.g. ".../webarchive.nationalarchives.gov.uk/+/http://www.hm-treasury
// .gov.uk/d/...csv". "+" means "the closest capture, rewritten for a browser",
// which is an HTML frame. The origin URL is what CDX is indexed on, so strip
// the wrapper before asking — but keep the ORIGINAL string as the cache key,
// because that is what the ingest hashes.
const WRAPPER = /^https?:\/\/webarchive\.nationalarchives\.gov\.uk\/(?:ukgwa\/)?(?:\+|\*|\d{4,14}[a-z_]*)?\/(https?:\/\/.+)$/i;

function originUrl(url) {
  let u = String(url || '');
  for (let i = 0; i < 4; i++) {
    const m = u.match(WRAPPER);
    if (!m) break;
    u = m[1];
  }
  return u;
}

const replayUrl = (ts, url) => `${ARCHIVE}/ukgwa/${ts}id_/${String(url).replace(/ /g, '%20')}`;
const fileName = (url) => decodeURIComponent(String(url).split('?')[0].split('/').pop() || '');

// ---- HTTP ------------------------------------------------------------------
let lastRequest = 0;
async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastRequest);
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
}

// Every request this script makes goes to the archive and nowhere else.
// `redirect: 'manual'` is not a nicety: replaying a 3xx capture hands back the
// Location the department served in 2011, which points at a live third-party
// host. Letting fetch follow it would take this script off the archive and on
// to whatever answers that name today — verified, it tried to connect to the
// OBR's current web site.
function archiveFetch(url, init = {}) {
  if (new URL(url).host !== ARCHIVE_HOST) throw new Error(`refusing to fetch off-archive host: ${url}`);
  return fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { 'user-agent': UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
}

async function getText(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    await throttle();
    try {
      const res = await archiveFetch(url);
      if (res.ok) return await res.text();
      if (res.status === 404) return '';
    } catch (e) {
      if (/refusing to fetch/.test(e.message)) throw e;
    }
    await sleep(800 * (t + 1));
  }
  return null;
}

// Returns the archived response as it was served: `status`, the `location` it
// redirected to (unfollowed), and the body when there is one.
async function getArchived(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    await throttle();
    try {
      const res = await archiveFetch(url);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400) return { status: res.status, location, buf: null };
      if (res.ok) return { status: res.status, location: null, buf: Buffer.from(await res.arrayBuffer()) };
      if (res.status === 404) return { status: 404, location: null, buf: null };
    } catch (e) {
      if (/refusing to fetch/.test(e.message)) throw e;
    }
    await sleep(800 * (t + 1));
  }
  return { status: 0, location: null, buf: null };
}

// ---- CDX -------------------------------------------------------------------
// The index answers NDJSON (one object per line) despite output=json; older
// deployments answer the classic array-of-arrays with a header row. Handle
// both. `filter=status:200` is honoured and is worth sending: several of these
// URLs have a dozen captures and every one of them is a 301 to GOV.UK.
async function cdxLookup(url, { statusFilter = true } = {}) {
  const key = sha1(url + (statusFilter ? '|200' : '|all'));
  const file = path.join(CDX_CACHE, key + '.json');
  if (!FORCE) {
    const hit = await readJSON(file);
    if (hit && ageDays(hit.fetchedAt) < CDX_TTL_DAYS) return hit.rows;
  }
  const q = `${ARCHIVE}/ukgwa/cdx?url=${encodeURIComponent(url)}&output=json&limit=${CDX_LIMIT}`
    + (statusFilter ? '&filter=status:200' : '');
  const body = await getText(q);
  if (body == null) return null;
  const rows = parseCdx(body);
  await writeJSON(file, { fetchedAt: new Date().toISOString(), url, rows });
  return rows;
}

function parseCdx(body) {
  const lines = String(body).trim().split('\n').filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  if (lines[0].trim().startsWith('{')) {
    for (const l of lines) { try { rows.push(JSON.parse(l)); } catch { /* skip */ } }
    return rows;
  }
  // classic form: [["urlkey","timestamp",...],[...]]
  try {
    const arr = JSON.parse(lines.join('\n'));
    if (!Array.isArray(arr) || arr.length < 2) return [];
    const cols = arr[0];
    for (const r of arr.slice(1)) rows.push(Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  } catch { /* not JSON */ }
  return rows;
}

const isHtmlMime = (m) => /text\/html|application\/xhtml/i.test(String(m || ''));

// Earliest successful capture that is not an HTML page. Earliest because these
// files were replaced in place: a 2012 capture of a 2010 URL is usually the
// redirect that killed it, and the first crawl after publication is the one
// closest to what the department actually released.
function pickCapture(rows, near = null) {
  const good = (rows || [])
    .filter(r => String(r.status || r.statuscode || '') === '200')
    .filter(r => !isHtmlMime(r.mime || r.mimetype))
    .filter(r => /^\d{8,14}$/.test(String(r.timestamp || '')))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  if (!good.length) return null;
  if (!near) return good[0];
  let best = good[0], bestGap = Infinity;
  for (const r of good) {
    const gap = Math.abs(tsToMs(r.timestamp) - tsToMs(near));
    if (gap < bestGap) { best = r; bestGap = gap; }
  }
  return best;
}

// The earliest archived redirect. Departments moved these files behind
// download handlers rather than deleting them: the OBR's March 2011 return is
// two 302s deep and is otherwise reported as permanently lost.
function pickRedirect(rows) {
  return (rows || [])
    .filter(r => /^3\d\d$/.test(String(r.status || r.statuscode || '')))
    .filter(r => /^\d{8,14}$/.test(String(r.timestamp || '')))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))[0] || null;
}

function tsToMs(ts) {
  const s = String(ts).padEnd(14, '0');
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
}

const tsToIso = (ts) => new Date(tsToMs(ts)).toISOString();

// ---- archived bodies -------------------------------------------------------
// Cached forever under this script's own key space, never under the ingest's:
// a pay-side file must never end up where the ingest would read it as a
// standalone posts file. That double counts every disclosed row it holds.
async function archivedBody(url, ts) {
  const file = path.join(WORK, sha1(url + '@' + ts) + '.body');
  if (!FORCE) {
    try { const s = await stat(file); if (s.size > 0) return { buf: await readFile(file), mode: 'cache' }; }
    catch { /* miss */ }
  }
  const res = await getArchived(replayUrl(ts, url));
  if (!res.buf || !res.buf.length) return { buf: null, location: res.location, mode: 'fail' };
  await writeFile(file, res.buf).catch(() => {});
  return { buf: res.buf, location: null, mode: 'download' };
}

// Find the archived bytes for a URL, following the redirects the origin host
// itself served at crawl time. Each hop is re-indexed through CDX rather than
// requested off the archive, so the chain can never leave it. `near` biases
// the capture choice towards a given timestamp, which is how the pay half of a
// two-file export is matched to the same crawl as its posts half.
async function resolveArchived(url, { near = null, maxHops = MAX_HOPS } = {}) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    chain.push(current);
    const rows = await cdxLookup(current);
    if (rows == null) return { reason: 'cdx-unreachable', chain };

    const cap = pickCapture(rows, near);
    if (cap) {
      const got = await archivedBody(current, String(cap.timestamp));
      if (got.buf) {
        return { origin: current, ts: String(cap.timestamp), buf: got.buf, chain, captures: rows.length };
      }
      return { reason: 'replay-failed', chain, origin: current, ts: String(cap.timestamp) };
    }

    const any = await cdxLookup(current, { statusFilter: false });
    if (!any || !any.length) {
      return { reason: hop === 0 ? 'no-capture' : 'only-redirects', chain, detail: hop === 0 ? null : 'redirect target was never captured' };
    }
    const red = pickRedirect(any);
    const stop = (detail) => ({ reason: 'only-redirects', chain, detail: detail || `${any.length} capture(s), none returning the file` });
    if (!red) return stop(`${any.length} capture(s), all pages rather than the file`);

    const hopRes = await getArchived(replayUrl(String(red.timestamp), current));
    if (!hopRes.location) return stop();
    const next = originUrl(hopRes.location);
    // A redirect back into the archive means the origin was already pointing
    // at its own archived copy — there is nothing further behind it.
    if (!/^https?:\/\//i.test(next) || next.includes(ARCHIVE_HOST) || chain.includes(next)) {
      return stop('the origin redirected to its own archived copy — nothing sits behind it');
    }
    current = next;
  }
  return { reason: 'only-redirects', chain, detail: `redirect chain longer than ${maxHops} hops` };
}

// What came back: the file, a web page, or something binary. gzip is unwrapped
// because a WARC payload can still be stored compressed when the origin's
// Content-Encoding header did not survive replay.
function classifyBody(buf) {
  let body = buf;
  let kind = sniffBinary(body);
  if (kind === 'gzip') {
    try { body = gunzipSync(body); kind = sniffBinary(body); } catch { return { ok: false, reason: 'archived-body-is-binary', detail: 'gzip' }; }
  }
  if (kind) return { ok: false, reason: 'archived-body-is-binary', detail: kind };
  const text = decodeBody(body);
  const head = text.slice(0, 1024).toLowerCase();
  if (/<!doctype html|<html[\s>]|<head[\s>]/.test(head)) return { ok: false, reason: 'archived-body-is-html', detail: null };
  return { ok: true, buf: body, text };
}

// ---- header shape ----------------------------------------------------------
const FLOOR_PHRASES = ['actual pay floor', 'pay floor', 'payscale minimum', 'salary min'];
const CEIL_PHRASES = ['actual pay ceiling', 'pay ceiling', 'payscale maximum', 'salary max'];
const PUR_PHRASES = ['post unique reference', 'post reference', 'unique reference'];
const TITLE_PHRASES = ['job title', 'post title', 'title'];
const UNIT_PHRASES = ['unit', 'directorate', 'group'];

function shapeOf(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { rows, empty: true };
  const h = rows[0];
  const wide = rows.length === 1 && h.length > 50;   // the lone-CR canary
  return {
    rows, headers: h, wide,
    floor: findCol(h, FLOOR_PHRASES),
    ceil: findCol(h, CEIL_PHRASES),
    pur: findCol(h, PUR_PHRASES),
    title: findCol(h, TITLE_PHRASES),
    grade: findCol(h, ['grade equivalent', 'grade', 'scs grade']),
    unit: findCol(h, UNIT_PHRASES),
    fte: findCol(h, ['fte']),
    first: h.findIndex(x => normHeader(x) === 'first name'),
    surname: h.findIndex(x => normHeader(x) === 'surname'),
    name: h.findIndex(x => normHeader(x) === 'name'),
  };
}

const hasPay = (s) => s && (s.floor >= 0 || s.ceil >= 0);
const hasPosts = (s) => s && (s.grade >= 0 || s.title >= 0);

// ---- the two-file join -----------------------------------------------------
// Candidate names for the pay half of a posts export. Verified live:
// hmt_seniorstaffposts_jun2010.csv -> hmt_seniorstaffpay_jun2010.csv.
function paySiblingUrls(url) {
  const name = fileName(url);
  const base = String(url).slice(0, String(url).length - name.length);
  const out = new Set();
  for (const word of ['pay', 'salary', 'salaries', 'paydata', 'pay-data', 'pay_data']) {
    for (const re of [/posts/gi, /post/gi]) {
      if (!re.test(name)) continue;
      out.add(base + name.replace(re, (m) => (m[0] === m[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word)));
    }
  }
  out.delete(url);
  return [...out];
}

const normKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "N/D", "Not disclosed", "Vacant" and friends are the publisher declining to
// name a post holder, not a name. Eight posts and eight pay rows in the Audit
// Commission's 30 June 2010 pair are all called "Not disclosed": keyed
// naively, that hands eight salaries to eight arbitrary posts. They are not
// keys, they are absences, and a post that cannot be identified keeps no pay.
const NON_KEY = /^(n ?d|n ?a|not disclosed|non disclosed|not disclosed name|vacant|vacancy|vacant post|withheld|redacted|unknown|not known|tbc|none|nil|not applicable|not stated|not published|not provided|not in post|xx+)$/;

// A composite key is only a key when every component is present and real.
function keyOf(...parts) {
  const out = [];
  for (const p of parts) {
    const k = normKey(p);
    if (!k || NON_KEY.test(k)) return '';
    out.push(k);
  }
  return out.join('|');
}

// A key is usable only where it is unique on BOTH sides. Two posts sharing a
// job title and unit, or two people sharing a name, would otherwise be handed
// each other's salary: the join would fabricate a figure rather than leave the
// post withheld, which is the one thing this pipeline must never do. Ambiguous
// keys are counted and reported, and the posts behind them keep no pay.
function buildIndex(shape, fn) {
  const counts = new Map();
  let keyed = 0;
  for (const r of shape.rows.slice(1)) {
    const k = fn(r, shape);
    if (!k) continue;
    keyed++;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const index = new Map();
  for (const r of shape.rows.slice(1)) {
    const k = fn(r, shape);
    if (!k || counts.get(k) > 1) continue;
    index.set(k, r);
  }
  return { index, counts, keyed, ambiguous: [...counts.values()].filter(v => v > 1).length };
}

// Resolve the key rather than assume it. The 2010 pay files carry no post
// reference at all — Defra's pay half heads its reference column "Unique Post
// ID" and leaves it blank — so a hard-coded "join on post reference" matches
// nothing and reports a clean, wrong zero. Candidates are tried strongest
// first and a weaker key only wins if it is clearly better, never on noise.
const KEY_PREFERENCE_MARGIN = 0.1;

function chooseJoinKey(ps, ys) {
  const cands = [];
  if (ps.pur >= 0 && ys.pur >= 0) cands.push(['post-reference', (r, s) => keyOf(r[s.pur])]);
  if (ps.first >= 0 && ps.surname >= 0 && ys.first >= 0 && ys.surname >= 0) {
    cands.push(['name', (r, s) => keyOf(r[s.first], r[s.surname])]);
  }
  if (ps.name >= 0 && ys.name >= 0) cands.push(['name', (r, s) => keyOf(r[s.name])]);
  if (ps.title >= 0 && ys.title >= 0 && ps.unit >= 0 && ys.unit >= 0) {
    cands.push(['title-unit', (r, s) => keyOf(r[s.title], r[s.unit])]);
  }

  let best = null;
  for (const [name, fn] of cands) {
    const P = buildIndex(ps, fn);
    const Y = buildIndex(ys, fn);
    let matched = 0;
    for (const k of Y.index.keys()) if (P.index.has(k)) matched++;
    const c = {
      key: name, fn, P, Y, matched,
      payRowsKeyed: Y.keyed,
      payKeysUsable: Y.index.size,
      ambiguousPosts: P.ambiguous,
      ambiguousPay: Y.ambiguous,
      rate: Y.keyed ? matched / Y.keyed : 0,
    };
    if (!best || c.rate > best.rate + KEY_PREFERENCE_MARGIN) best = c;
    if (best.rate === 1) break;
  }
  return best;
}

// The posts file, verbatim, with the pay half's columns appended under the
// names the 2011+ template uses. Published headers are never rewritten and no
// published value is dropped: the only thing added is pay, FTE, and nothing
// else. Names already sit in the posts file; they are read by the join and by
// lib.mjs to derive a post status, and neither stores them.
function joinPosts(ps, ys, join) {
  const add = [];
  if (ps.floor < 0 && ys.floor >= 0) add.push(['Actual Pay Floor (£)', ys.floor]);
  if (ps.ceil < 0 && ys.ceil >= 0) add.push(['Actual Pay Ceiling (£)', ys.ceil]);
  if (ps.fte < 0 && ys.fte >= 0) add.push(['FTE', ys.fte]);
  if (!add.length) return null;

  const out = [[...ps.headers, ...add.map(a => a[0])]];
  let filled = 0;
  const used = new Set();
  for (const r of ps.rows.slice(1)) {
    const k = join.fn(r, ps);
    // join.P.index holds only keys unique on the posts side; join.Y.index only
    // keys unique on the pay side. A row keyed ambiguously on either simply
    // gets no pay and stays in the withheld population.
    const m = k && join.P.index.has(k) ? join.Y.index.get(k) : null;
    if (m) { filled++; used.add(k); }
    out.push([...r, ...add.map(([, i]) => (m ? String(m[i] ?? '') : ''))]);
  }
  return {
    csv: toCSV(out), filled, added: add.map(a => a[0]),
    payRows: ys.rows.length - 1,
    payRowsKeyed: join.payRowsKeyed,
    payRowsUnmatched: join.payRowsKeyed - filled,
    ambiguousPosts: join.ambiguousPosts,
    ambiguousPay: join.ambiguousPay,
  };
}

function toCSV(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

// ---- work list -------------------------------------------------------------
async function buildWorkList(manifest, prior) {
  const items = [];
  const seen = new Set();
  const push = (it) => { if (!seen.has(it.url)) { seen.add(it.url); items.push(it); } };

  for (const f of manifest?.failures || []) {
    push({ org: f.org, date: f.date || null, url: f.url, manifestReason: f.reason });
  }
  // Once a URL is recovered it stops being a manifest failure, so the failure
  // list alone would make this a one-shot script. Carry every URL this script
  // has ever touched: recovered ones are verified against the cache and re-
  // emitted if something clobbered them (`ingest --no-cache` re-downloads the
  // dead origin and overwrites the recovered bytes with its HTML), and
  // unrecovered ones are re-checked at the CDX cache's own pace, because the
  // archive does gain captures.
  for (const [url, e] of prior) {
    if (e.kind === 'pay-side') continue;
    push({ org: e.org, date: e.date || null, url, manifestReason: e.manifestReason || 'previously-attempted' });
  }
  const adHoc = [...EXTRA_URLS];
  if (URLS_FROM) {
    const body = await readFile(path.resolve(URLS_FROM), 'utf8').catch(() => null);
    if (body == null) fatal(`--urls-from: cannot read ${URLS_FROM}`);
    for (const l of body.split('\n').map(s => s.trim())) if (l && !l.startsWith('#')) adHoc.push(l);
  }
  for (const u of adHoc) {
    const r = resolveReferenceDate(u, '', '', null, '');
    push({ org: 'ADHOC', date: r.referenceDate, url: u, manifestReason: 'ad-hoc' });
  }

  // Organisation and reference date are DERIVED from the manifest every run,
  // never inherited from the state file. A URL first recovered ad hoc is
  // attributed to ADHOC only until an ingest files it under a department, and
  // the ingest's resolved reference date beats anything guessed from the URL.
  const attribution = new Map();
  for (const [org, list] of Object.entries(manifest?.resources || {})) {
    for (const r of list) attribution.set(r.url, { org, date: r.referenceDate });
  }
  for (const r of manifest?.rejectedSiblings || []) attribution.set(r.url, { org: r.org, date: r.date });
  for (const r of manifest?.failures || []) attribution.set(r.url, { org: r.org, date: r.date });

  return items.map(it => {
    const a = attribution.get(it.url);
    return a ? { ...it, org: a.org, date: a.date || it.date } : it;
  }).filter(it => {
    if (ONLY.length && !ONLY.includes(String(it.org).toUpperCase())) return false;
    if (FROM && it.date && it.date < FROM) return false;
    if (TO && it.date && it.date > TO) return false;
    return true;
  }).sort((a, b) => (a.org + (a.date || '') + a.url).localeCompare(b.org + (b.date || '') + b.url));
}

// URLs the ingest already parses successfully. A pay file that is itself an
// ingested resource must not be joined into anything: it is already counted.
function ingestedUrls(manifest) {
  const s = new Set();
  for (const list of Object.values(manifest?.resources || {})) for (const r of list) s.add(r.url);
  return s;
}

// ---- main ------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  await mkdir(CDX_CACHE, { recursive: true });

  const manifest = await readJSON(MANIFEST);
  // The state file is read even under --force. --force means "redo the work",
  // not "forget what you emitted": without the previous emittedSha256 the
  // never-replace-a-working-file guard cannot tell this script's own output
  // from a live publication, and refuses to overwrite itself.
  const state = await readJSON(STATE);
  const prior = new Map(Object.entries(state?.entries || {}));

  if (REPORT_ONLY) {
    if (!state) fatal('--report-only: no data/ukgwa.json to rebuild from');
    await writeReports([...prior.values()], manifest, t0);
    return;
  }
  if (!manifest && !EXTRA_URLS.length && !URLS_FROM) {
    fatal('no data/manifest.json and no --url / --urls-from: nothing to recover.\n'
      + '  Run scripts/ingest.mjs first — its failures[] list is this script\'s work list.');
  }

  let work = await buildWorkList(manifest, prior);
  const already = ingestedUrls(manifest);
  log('== UKGWA recovery ==');
  log(`work list: ${work.length} failed URL(s)`
    + `${ONLY.length ? '  only: ' + ONLY.join(',') : ''}`
    + `${FROM || TO ? `  window: ${FROM || '-'} .. ${TO || '-'}` : ''}`
    + `${DRY_RUN ? '  DRY RUN' : ''}${FORCE ? '  FORCE' : ''}`);
  if (LIMIT && work.length > LIMIT) { log(`  capping at --limit ${LIMIT}`); work = work.slice(0, LIMIT); }
  if (!work.length) { log('  nothing to do'); await writeReports([...prior.values()], manifest, t0); return; }

  // 1. skip anything already delivered. Cheap re-run: no CDX, no fetch.
  log('\n[1/4] checking what is already recovered ...');
  const todo = [];
  const done = [];
  const priorConsumed = new Set();
  for (const e of prior.values()) if (e.join?.payFile) priorConsumed.add(e.join.payFile);
  for (const it of work) {
    const key = sha1(it.url);
    // A pay half already folded into a join is never a file in its own right,
    // whatever it looks like on its own. Withdraw it if an earlier run emitted
    // it before the join was found.
    if (priorConsumed.has(it.url)) {
      if (!DRY_RUN) await unemit(key);
      done.push({
        ...(prior.get(it.url) || {}), url: it.url, file: fileName(it.url),
        org: it.org, date: it.date || null, kind: 'pay-side',
        cacheKey: null, emittedSha256: null,
        detail: 'consumed as the pay half of a two-file join',
      });
      continue;
    }
    const mine = FORCE ? null : await readJSON(sidecarPath(key));
    if (mine && await fileSha256(path.join(CACHE, key + '.csv')) === mine.emittedSha256) {
      // The sidecar proves delivery; the state file adds the row counts and
      // join diagnostics for the report. Take the organisation and reference
      // date from the current work item — a URL first recovered ad hoc is
      // attributed to ADHOC until an ingest names its organisation.
      const p = prior.get(it.url);
      done.push({
        ...(p || {}),
        url: it.url, origin: mine.origin, kind: mine.kind, cacheKey: key,
        cdxTimestamp: mine.cdxTimestamp, emittedSha256: mine.emittedSha256, bytes: mine.bytes,
        file: fileName(it.url), org: it.org, date: it.date ?? p?.date ?? null,
        manifestReason: it.manifestReason,
      });
      continue;
    }
    todo.push(it);
  }
  log(`  already in the ingest cache: ${done.length}   to attempt: ${todo.length}`);

  // 2. probe the archive for every URL still outstanding.
  log('\n[2/4] querying CDX and replaying captures ...');
  const probes = await mapLimit(todo, CONCURRENCY, probe);
  const byUrl = new Map(probes.map(p => [p.url, p]));
  const counts = tally(probes.map(p => p.probeStatus));
  for (const [k, v] of counts) log(`  ${String(k).padEnd(26)} ${v}`);

  // 3. the two-file join, before anything is emitted — a pay file consumed
  //    here must never also be emitted in its own right.
  log('\n[3/4] joining two-file posts/pay exports ...');
  // Seed from the state, not just from this run's joins. Once a posts half is
  // delivered it is skipped in step 1, so its join never re-runs — and its pay
  // half, still on the work list, parses perfectly well on its own and would
  // be emitted as a posts file. Every disclosed row in it would then be
  // counted twice: once inside the join and once standalone.
  const consumed = new Set(priorConsumed);
  let joins = 0;
  for (const p of probes) {
    if (p.probeStatus !== 'no-pay-columns') continue;
    await joinTwoFile(p, byUrl, consumed, already);
    if (p.kind === 'joined') joins++;
  }
  log(`  joined: ${joins}   pay files consumed: ${consumed.size}`);

  // 4. emit.
  log('\n[4/4] writing recovered files into the ingest cache ...');
  const results = [];
  for (const p of probes) {
    if (consumed.has(p.url)) {
      // If an earlier run emitted this URL in its own right, withdraw it.
      if (!DRY_RUN) await unemit(sha1(p.url));
      results.push(record(p, 'pay-side', null, 'consumed as the pay half of a two-file join'));
      continue;
    }
    if (p.kind === 'joined' || p.probeStatus === 'ok') {
      const key = sha1(p.url);
      const buf = p.kind === 'joined' ? Buffer.from(p.joined.csv, 'utf8') : p.buf;
      if (await cacheHoldsAWorkingFile(key)) {
        p.probeStatus = 'live-file-already-parses';
        results.push(record(p, 'not-needed', null, 'the ingest cache already holds a file that parses; refusing to replace it'));
        continue;
      }
      if (!DRY_RUN) await emit(key, buf, p);
      results.push(record(p, p.kind === 'joined' ? 'joined' : 'verbatim',
        { cacheKey: key, emittedSha256: sha256(buf), bytes: buf.length }));
      continue;
    }
    results.push(record(p, 'unrecovered', null, p.detail));
  }
  // A pay-side file is only on the work list when it happens to be a failure in
  // its own right, so its record has to be carried forward from the state or
  // the report silently forgets which file the join was built from. Kept only
  // while something still points at it.
  const all = [...done, ...results];
  const stillReferenced = new Set(all.map(r => r.join?.payFile).filter(Boolean));
  const seenUrls = new Set(all.map(r => r.url));
  for (const [url, e] of prior) {
    if (e.kind === 'pay-side' && stillReferenced.has(url) && !seenUrls.has(url)) all.push(e);
  }
  const recovered = all.filter(r => r.kind === 'verbatim' || r.kind === 'joined');

  log(`  recovered ${recovered.length} of ${work.length}`
    + ` (${recovered.filter(r => r.kind === 'verbatim').length} verbatim,`
    + ` ${recovered.filter(r => r.kind === 'joined').length} joined)`);

  if (DRY_RUN) { log('\ndry run — nothing written'); summarise(all, t0); return; }
  await writeReports(all, manifest, t0);
  summarise(all, t0);
}

// ---- one URL ---------------------------------------------------------------
async function probe(it) {
  const p = { ...it, origin: originUrl(it.url), kind: null, probeStatus: null, detail: null };

  if (OUT_OF_SCOPE.has(it.manifestReason)) {
    p.probeStatus = 'out-of-scope';
    p.detail = OUT_OF_SCOPE.get(it.manifestReason);
    return p;
  }

  const found = await resolveArchived(p.origin);
  if (found.chain && found.chain.length > 1) p.via = found.chain;
  if (!found.buf) {
    p.probeStatus = found.reason;
    p.detail = found.detail || null;
    return p;
  }
  p.origin = found.origin;
  p.cdxTimestamp = found.ts;
  p.captured = tsToIso(found.ts);
  p.captures = found.captures;

  const cls = classifyBody(found.buf);
  if (!cls.ok) { p.probeStatus = cls.reason; p.detail = cls.detail; return p; }

  p.buf = cls.buf;
  p.text = cls.text;
  p.archiveSha256 = sha256(cls.buf);
  p.shape = shapeOf(cls.text);

  if (p.shape.wide) {
    p.probeStatus = 'lone-cr-not-normalised';
    p.detail = `1 row x ${p.shape.headers.length} columns — lib.mjs parseCSV is not normalising lone CR`;
    warnings.push(`${fileName(p.url)}: ${p.detail}`);
    return p;
  }

  const res = parsePosts(cls.text);
  if (res.ok) {
    p.probeStatus = 'ok';
    p.rows = res.stats.dataRows;
    p.posts = res.posts.length;
    p.disclosed = res.stats.disclosed;
    return p;
  }
  p.probeStatus = res.reason;
  p.detail = res.reason === 'no-pay-columns' ? 'no pay columns — candidate for the two-file join' : null;
  return p;
}

// ---- two-file join for one posts file --------------------------------------
async function joinTwoFile(p, byUrl, consumed, ingested) {
  if (!hasPosts(p.shape)) { p.detail = 'no pay columns and no post columns — not an organogram export'; return; }

  // Prefer a pay file that is already on the work list for the same
  // organisation and reference date: it is a real published resource, and if
  // it is on the failure list it is not being counted anywhere else.
  const local = [...byUrl.values()].filter(q =>
    q.url !== p.url && !consumed.has(q.url) && q.org === p.org && q.date === p.date
    && q.shape && hasPay(q.shape) && /pay|salar/i.test(fileName(q.url)));

  const candidates = [];
  for (const q of local) {
    candidates.push({ url: q.url, origin: q.origin, ts: q.cdxTimestamp, shape: q.shape, sha: q.archiveSha256, local: q });
  }

  if (!candidates.length) {
    for (const u of paySiblingUrls(p.origin)) {
      if (ingested.has(u)) { p.detail = `pay sibling ${fileName(u)} is already ingested in its own right`; p.payBlocked = 'pay-file-already-ingested'; continue; }
      const found = await resolveArchived(u, { near: p.cdxTimestamp });
      if (!found.buf) continue;
      const cls = classifyBody(found.buf);
      if (!cls.ok) continue;
      const shape = shapeOf(cls.text);
      if (!hasPay(shape)) continue;
      candidates.push({ url: u, origin: found.origin, ts: found.ts, shape, sha: sha256(cls.buf) });
      break;
    }
  }

  if (!candidates.length) {
    p.probeStatus = p.payBlocked || 'no-pay-file-found';
    if (!p.payBlocked) p.detail = `no pay file for ${fileName(p.url)} in the archive`;
    return;
  }

  // Try every candidate and keep the best match rate rather than the first.
  // Two departments filed a posts half and a pay half on the same date under
  // names with nothing in common ("...Senior Staff Posts Dataset as at 30 June
  // 2010(FINAL).csv" beside "Senior staff pay dataset 30 June 2010
  // (FINAL).csv"), so candidate selection cannot lean on the filename — the
  // match rate is the only honest test of whether two files belong together.
  let pay = null, join = null;
  for (const c of candidates) {
    const j = chooseJoinKey(p.shape, c.shape);
    if (j && (!join || j.rate > join.rate)) { pay = c; join = j; }
  }
  if (!join || join.rate < JOIN_MIN_MATCH) {
    p.probeStatus = 'pay-join-too-sparse';
    p.detail = pay
      ? `${fileName(pay.url)}: ${join.matched}/${join.payRowsKeyed} pay rows matched on ${join.key}`
      : `${candidates.length} candidate pay file(s), none sharing a key column`;
    warnings.push(`${fileName(p.url)}: ${p.detail}`);
    return;
  }

  const joined = joinPosts(p.shape, pay.shape, join);
  if (!joined) { p.probeStatus = 'no-pay-file-found'; p.detail = 'pay file adds no column the posts file lacks'; return; }

  const res = parsePosts(joined.csv);
  if (!res.ok) {
    p.probeStatus = 'parse-failed';
    p.detail = `joined file still rejected: ${res.reason}`;
    return;
  }

  const gapDays = p.cdxTimestamp && pay.ts ? Math.abs(tsToMs(p.cdxTimestamp) - tsToMs(pay.ts)) / 86400000 : null;
  if (gapDays != null && gapDays > JOIN_MAX_GAP_DAYS) {
    warnings.push(`${fileName(p.url)}: posts and pay captured ${Math.round(gapDays)} days apart`);
  }

  p.kind = 'joined';
  p.joined = joined;
  p.rows = res.stats.dataRows;
  p.posts = res.posts.length;
  p.disclosed = res.stats.disclosed;
  p.join = {
    key: join.key,
    payFile: pay.url,
    payCdxTimestamp: pay.ts,
    payCaptured: pay.ts ? tsToIso(pay.ts) : null,
    payArchiveSha256: pay.sha || null,
    payRows: joined.payRows,
    payRowsKeyed: joined.payRowsKeyed,
    matchedPosts: joined.filled,
    payRowsUnmatched: joined.payRowsUnmatched,
    ambiguousPostKeys: joined.ambiguousPosts,
    ambiguousPayKeys: joined.ambiguousPay,
    captureGapDays: gapDays == null ? null : Math.round(gapDays),
    columnsAdded: joined.added,
  };
  if (joined.ambiguousPosts || joined.ambiguousPay) {
    warnings.push(`${fileName(p.url)}: ${joined.ambiguousPosts + joined.ambiguousPay} ambiguous ${join.key} key(s) left unjoined rather than guessed`);
  }
  if (pay.local) consumed.add(pay.url);
}

// ---- emitting --------------------------------------------------------------
// Written under sha1(the original CKAN URL) because that is the key
// scripts/ingest.mjs hashes. Anything older than eighteen months is served
// straight from cache without a network call, so the recovered bytes are what
// the next run parses. The stale validator sidecar is removed: the dead origin
// host's ETag has nothing to say about an archived body.
// Every emitted body gets a sidecar naming what it is and where it came from.
// The sidecar, not data/ukgwa.json, is what tells a later run that a cache
// entry is this script's own work: the state file can be deleted or rewritten,
// and a guard that cannot recognise its own output refuses to overwrite itself.
const sidecarPath = (key) => path.join(CACHE, key + '.ukgwa.json');

async function emit(key, buf, p) {
  const target = path.join(CACHE, key + '.csv');
  const tmp = target + '.ukgwa.tmp';
  await writeFile(tmp, buf);
  await rename(tmp, target);
  // The dead origin host's ETag has nothing to say about an archived body.
  await rm(path.join(CACHE, key + '.meta.json'), { force: true });
  await writeJSON(sidecarPath(key), {
    url: p.url, origin: p.origin, kind: p.kind === 'joined' ? 'joined' : 'verbatim',
    cdxTimestamp: p.cdxTimestamp || null,
    payFile: p.join?.payFile || null,
    emittedSha256: sha256(buf), bytes: buf.length,
  });
}

// Withdraw a body this script emitted. Only ever removes a cache entry whose
// sidecar proves this script wrote it; a file the ingest downloaded is left
// exactly where it is.
async function unemit(key) {
  if (!await readJSON(sidecarPath(key))) return false;
  await rm(path.join(CACHE, key + '.csv'), { force: true });
  await rm(sidecarPath(key), { force: true });
  return true;
}

// Never replace a working file with a museum piece. The work list is built
// from failures so this should not fire, but --url takes any URL, and a 2011
// archive copy silently overwriting a current publication is the worst thing
// this script could do.
async function cacheHoldsAWorkingFile(key) {
  const body = await readFile(path.join(CACHE, key + '.csv')).catch(() => null);
  if (!body || !body.length) return false;
  const mine = await readJSON(sidecarPath(key));
  if (mine && mine.emittedSha256 === sha256(body)) return false;   // this script wrote it
  if (sniffBinary(body)) return false;
  return parsePosts(decodeBody(body)).ok;
}

function record(p, kind, extra, detail) {
  return {
    url: p.url, origin: p.origin, org: p.org, date: p.date || null,
    file: fileName(p.url),
    manifestReason: p.manifestReason || null,
    kind,
    reason: kind === 'unrecovered' ? p.probeStatus : null,
    detail: detail ?? p.detail ?? null,
    cdxTimestamp: p.cdxTimestamp || null,
    captured: p.captured || null,
    captures: p.captures ?? null,
    via: p.via || null,
    archiveSha256: p.archiveSha256 || null,
    rows: p.rows ?? null, posts: p.posts ?? null, disclosed: p.disclosed ?? null,
    join: p.join || null,
    ...(extra || {}),
  };
}

// ---- reports ---------------------------------------------------------------
async function writeReports(all, manifest, t0) {
  const sorted = all.slice().sort((a, b) =>
    (a.org + (a.date || '') + a.url).localeCompare(b.org + (b.date || '') + b.url));
  const recovered = sorted.filter(r => r.kind === 'verbatim' || r.kind === 'joined');
  const paySide = sorted.filter(r => r.kind === 'pay-side');
  const notNeeded = sorted.filter(r => r.kind === 'not-needed');
  const lost = sorted.filter(r => r.kind === 'unrecovered');

  // Recovering a file is not the same as the corpus using it, and the report
  // must not claim otherwise. Cross-reference the manifest written by the LAST
  // ingest: a recovered URL that the ingest kept is in `resources`, one it
  // dropped is in `rejectedSiblings`, and anything in neither has not been
  // through an ingest yet. Verified live: HM Treasury filed the OBR, the Asset
  // Protection Agency and the Debt Management Office as four separate CSVs for
  // 31 March 2011 under one CKAN package with one bulk-import timestamp, so
  // the ingest's within-package "latest upload wins" rule keeps one of the four.
  const inCorpus = ingestedUrls(manifest);
  const dropped = new Map((manifest?.rejectedSiblings || []).map(r => [r.url, r.reason]));
  for (const r of recovered) {
    r.downstream = inCorpus.has(r.url) ? 'in-corpus'
      : dropped.has(r.url) ? 'dropped-by-ingest'
        : 'not-yet-ingested';
    r.downstreamReason = dropped.get(r.url) || null;
  }
  const discarded = recovered.filter(r => r.downstream === 'dropped-by-ingest');

  // Deterministic stamp: the newest archive capture this recovery rests on,
  // never the wall clock, so a re-run that changes nothing rewrites nothing.
  let newest = null;
  for (const r of recovered) if (r.captured && (!newest || r.captured > newest)) newest = r.captured;

  const dates = recovered.map(r => r.date).filter(Boolean).sort();
  const state = {
    schema: SCHEMA,
    generated: newest,
    entries: Object.fromEntries(sorted.map(r => [r.url, r])),
  };
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeJSON(STATE, state, 1);

  const report = {
    schema: SCHEMA,
    generated: newest,
    purpose: 'Recovery of published organogram files whose origin host is gone, from the UK Government Web Archive.',
    source: {
      name: 'UK Government Web Archive',
      operator: 'The National Archives',
      index: `${ARCHIVE}/ukgwa/cdx`,
      replay: `${ARCHIVE}/ukgwa/<timestamp>id_/<original-url>`,
      note: 'The id_ suffix returns the archived bytes as published. Without it the archive returns a rewritten page, which parses as a CSV with no pay columns and is how these files came to be recorded as data errors rather than as dead links.',
      licence: 'Crown copyright material under the Open Government Licence; the archive republishes the original publication unchanged.',
    },
    summary: {
      attempted: sorted.length,
      recovered: recovered.length,
      verbatim: recovered.filter(r => r.kind === 'verbatim').length,
      joined: recovered.filter(r => r.kind === 'joined').length,
      paySideConsumed: paySide.length,
      notNeeded: notNeeded.length,
      unrecovered: lost.length,
      postRowsRecovered: recovered.reduce((a, r) => a + (r.posts || 0), 0),
      disclosedRecovered: recovered.reduce((a, r) => a + (r.disclosed || 0), 0),
      earliestRecoveredDate: dates[0] || null,
      latestRecoveredDate: dates[dates.length - 1] || null,
      inCorpus: recovered.filter(r => r.downstream === 'in-corpus').length,
      droppedByIngest: discarded.length,
      notYetIngested: recovered.filter(r => r.downstream === 'not-yet-ingested').length,
    },
    droppedByIngest: {
      note: discarded.length
        ? 'Recovered, in the ingest cache, and then discarded downstream. The ingest keeps one resource per (CKAN package, reference date) and treats the rest as re-uploads. In 2011 several arm\'s-length bodies filed a CSV each under one departmental package, all carrying the same bulk-import timestamp, so genuinely distinct organisations are dropped as if they were older copies of one another. Recovering these files does not put them in the corpus; that needs the ingest to sum distinct resources within a package rather than race them.'
        : 'Every recovered file reached the corpus.',
      files: discarded.map(r => ({
        org: r.org, date: r.date, file: r.file, url: r.url,
        posts: r.posts, disclosed: r.disclosed, reason: r.downstreamReason,
      })),
    },
    twoFileFormat: {
      note: 'The earliest release, 30 June 2010, was published as two files: a posts export with no pay columns at all, and a separate pay export covering only the posts whose holder was named. The main parser refuses the posts half outright. Each pair below was rejoined here; the join key was resolved from the columns both halves actually carry, not assumed.',
      pairs: recovered.filter(r => r.kind === 'joined').map(r => ({
        org: r.org, date: r.date, postsFile: r.file, payFile: fileName(r.join.payFile),
        joinKey: r.join.key, postsRows: r.rows,
        payRows: r.join.payRows, payRowsKeyed: r.join.payRowsKeyed,
        matchedPosts: r.join.matchedPosts, payRowsUnmatched: r.join.payRowsUnmatched,
        ambiguousPostKeys: r.join.ambiguousPostKeys, ambiguousPayKeys: r.join.ambiguousPayKeys,
        disclosed: r.disclosed, columnsAdded: r.join.columnsAdded,
        capturedPosts: r.captured, capturedPay: r.join.payCaptured,
      })),
    },
    recovered: recovered.map(r => ({
      org: r.org, date: r.date, file: r.file, url: r.url, kind: r.kind,
      captured: r.captured, rows: r.rows, posts: r.posts, disclosed: r.disclosed,
      via: r.via, downstream: r.downstream,
    })),
    unrecovered: lost.map(r => ({
      org: r.org, date: r.date, file: r.file, url: r.url,
      reason: r.reason, why: REASON_TEXT[String(r.reason).split(':')[0]] || null, detail: r.detail,
    })),
    reasons: REASON_TEXT,
    caveat: 'A recovered file enters the pipeline through the ingest cache, so data/manifest.json records the sha256 of the bytes that were parsed. For a joined file that is the sha256 of the join, not of any single published file. data/ukgwa.json holds the archive capture timestamp and the sha256 of each archived half.',
    warnings: [...new Set(warnings)].sort(),
  };
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeJSON(REPORT, report);

  log(`\n  state:  ${path.relative(ROOT, STATE)}`);
  log(`  report: ${path.relative(ROOT, REPORT)}  (${(JSON.stringify(report).length / 1024).toFixed(1)}KB)`);
  return report;
}

function summarise(all, t0) {
  const recovered = all.filter(r => r.kind === 'verbatim' || r.kind === 'joined');
  const lost = all.filter(r => r.kind === 'unrecovered');
  log('\n== done ==');
  log(`  attempted           : ${all.length}`);
  log(`  recovered           : ${recovered.length}  (${recovered.filter(r => r.kind === 'joined').length} by two-file join)`);
  log(`  post rows recovered : ${recovered.reduce((a, r) => a + (r.posts || 0), 0)}`
    + `  (disclosed ${recovered.reduce((a, r) => a + (r.disclosed || 0), 0)})`);
  const dates = recovered.map(r => r.date).filter(Boolean).sort();
  if (dates.length) log(`  earliest recovered  : ${dates[0]}`);
  const dropped = recovered.filter(r => r.downstream === 'dropped-by-ingest');
  if (dropped.length) {
    log(`  dropped by ingest   : ${dropped.length}  (recovered, then discarded as a within-package sibling)`);
    for (const r of dropped) log(`      ${r.date}  ${r.file}`);
  }
  for (const [reason, n] of tally(lost.map(r => r.reason))) {
    log(`  unrecovered         : ${String(reason).padEnd(26)} ${n}`);
  }
  for (const w of [...new Set(warnings)].sort()) log(`  WARNING             : ${w}`);
  log(`  elapsed             : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (recovered.length) log('\n  next: npm run ingest  (the recovered bytes are read straight from the cache)');
}

// ---- small helpers ---------------------------------------------------------
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function tally(list) {
  const m = new Map();
  for (const v of list) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function ageDays(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity;
}

async function fileSha256(p) {
  try { return sha256(await readFile(p)); } catch { return null; }
}

async function readJSON(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

async function writeJSON(p, value, indent = 0) {
  const body = JSON.stringify(value, null, indent);
  JSON.parse(body);
  const tmp = p + '.tmp';
  await writeFile(tmp, body);
  await rename(tmp, p);
}

main().catch(e => { console.error(e); process.exit(1); });
