// IT Jobs Watch — the quarantined market-rate layer for the SCS earnings study.
//
// The organograms say what the Senior Civil Service is paid. ONS ASHE says what
// the wider economy is paid. Neither says what an employer is currently
// offering for the same job, which is the number a departing deputy director
// actually sees. IT Jobs Watch is the one comparison site that is both legally
// clean and machine-readable: CC BY-NC-SA 4.0 stated on /copyright, a robots.txt
// that disallows only /ja/, server-rendered pages, rebuilt daily. Glassdoor,
// Indeed, Adzuna and Payscale are none of those things and are never contacted.
//
// It is quarantined for two reasons and this file exists to keep both honest.
//   1. Licence. ShareAlike would pull anything it is blended into under
//      CC BY-NC-SA, which would contaminate the OGL provenance of the main
//      dataset. So this is its own file, with its own notice, and the notice
//      travels INSIDE the JSON: the UI cannot render a figure without also
//      holding the attribution string it must print beside it.
//   2. Measurement. This is ADVERTISED salary — what a job advert offered —
//      not paid salary. ASHE measures paid earnings and an organogram records
//      an occupied post. Advertised rates lead paid rates, skew to the roles
//      employers are struggling to fill, and exclude pension entirely. Placing
//      the two on one axis without saying so would be the study's worst
//      possible own goal.
//
// Four rules enforced in code, not copy:
//   1. robots.txt is read FIRST, every run, and honoured. If it ever disallows
//      the pages this script reads, or /copyright stops carrying the CC licence,
//      the run STOPS and writes nothing. That is a correct outcome, not a fault.
//   2. One request every two seconds, a User-Agent that says who this is, and a
//      disk cache with a 25-day life, so a monthly re-run is one pass over the
//      role list and a repeat run the same week is zero requests.
//   3. Below n = 30 there is no figure, only a count. Roles under the gate are
//      emitted as "insufficient market data" WITH their n. Dropping them would
//      quietly bias the visible set towards the well-covered IT roles, which is
//      the opposite of what a coverage caveat is for.
//   4. Coverage is technology only, and the gaps are evidence. Chief digital
//      officer, chief data officer and head of data return 404 here; four
//      non-technology titles are probed as controls purely to keep that claim
//      true. Every probe is recorded, resolved or not.
//
//   node scripts/itjobswatch.mjs                     # full role list
//   node scripts/itjobswatch.mjs --only it-director,head-of-it
//   node scripts/itjobswatch.mjs --dry-run           # fetch and parse, write nothing
//   node scripts/itjobswatch.mjs --no-cache          # force re-download
//   node scripts/itjobswatch.mjs --max-age-days 1    # shorten the cache life
//   node scripts/itjobswatch.mjs --no-controls       # skip the non-technology probes
//
// Exit codes match the pipeline: 0 fine, 1 crash, 2 guard tripped or permission
// withdrawn — do not deploy. Two runs from cache produce byte-identical output
// apart from the `generated` stamp.
//
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache', 'itjw');
const OUT = path.join(ROOT, 'public', 'data', 'benchmarks-itjw.json');
const ORIGIN = 'https://www.itjobswatch.co.uk';
const ROBOTS_URL = `${ORIGIN}/robots.txt`;
const COPYRIGHT_URL = `${ORIGIN}/copyright`;
const PAGE_TEMPLATE = '/jobs/uk/{slug}.do';
const UA_TOKEN = 'scs-earnings-itjobswatch';
const UA = `${UA_TOKEN}/1.0 (+https://strangeramblings.com; non-commercial research, one pass per month, CC BY-NC-SA attribution retained)`;
const MIN_GAP_MS = 2000;
const FETCH_TIMEOUT = 30000;
const CACHE_DAYS = 25;
const N_FLOOR = 30;
// The build plan's 15KB line was written before the role list existed. Measured:
// roughly 7KB of licence, measurement and comparability prose that must travel
// with the data, plus about 250 bytes per role over 40 roles. 20KB raw is the
// honest ceiling for that shape; it is 5.4KB gzipped and loaded lazily, so it
// costs the first paint nothing. Trim the role list before raising it again.
const BUDGET_BYTES = 20 * 1024;
const MIN_RESOLVED = 25;
const MIN_REPORTED = 15;
const SCHEMA = 1;

// ---- CLI ------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const opt = (n, d = null) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const USE_CACHE = !flag('--no-cache');
const DRY_RUN = flag('--dry-run');
const CONTROLS = !flag('--no-controls');
const MAX_AGE_MS = Number(opt('--max-age-days', String(CACHE_DAYS))) * 86400000;
const ONLY = (opt('--only') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const log = (...a) => console.log(...a);
const warnings = [];
const warn = (m) => { warnings.push(m); log(`  WARNING: ${m}`); };
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);

// A stop is not a crash. The site's permission is a precondition, so when it is
// withdrawn the only correct behaviour is to write nothing and say why loudly.
function stop(reason, detail) {
  console.error('\nSTOPPED: ' + reason);
  for (const d of [].concat(detail || [])) console.error('  ' + d);
  console.error('nothing was written; any existing benchmarks-itjw.json is untouched.');
  process.exit(2);
}

// ---- robots.txt ------------------------------------------------------------
// A deliberately small parser: group by user-agent, longest matching rule wins,
// allow wins a tie, `*` and `$` are the only wildcards, and an empty Disallow
// means "allow everything". Anything it cannot understand is treated as a
// disallow, because guessing in our own favour is how a polite crawler stops
// being one.
function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of String(text).split(/\r\n?|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length || current.crawlDelay != null) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') current.rules.push({ allow: field === 'allow', pathPattern: value });
    else if (field === 'crawl-delay') { const n = Number(value); if (Number.isFinite(n)) current.crawlDelay = n; }
  }
  return groups;
}

function selectRobotsGroup(groups, uaToken) {
  const ua = uaToken.toLowerCase();
  let specific = null, wildcard = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === '*') { wildcard = wildcard || g; continue; }
      if (a && (ua.includes(a) || a.includes(ua))) specific = specific || g;
    }
  }
  return specific || wildcard || { agents: ['*'], rules: [], crawlDelay: null };
}

function robotsRuleMatches(pattern, urlPath) {
  if (pattern === '') return null;                       // empty Disallow: allow all
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = new RegExp('^' + body.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return rx.test(urlPath) ? body.length : null;
}

function robotsVerdict(group, urlPath) {
  let best = null;
  for (const r of group.rules) {
    const len = robotsRuleMatches(r.pathPattern, urlPath);
    if (len == null) continue;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow, pattern: r.pathPattern };
  }
  if (!best) return { allowed: true, rule: 'no matching rule' };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` };
}

// ---- HTTP ------------------------------------------------------------------
// Every response is cached on disk with the status beside it, 404s included, so
// re-probing the titles this source does not carry is free after the first run.
// The pages are served `cache-control: private` with no ETag, so revalidation is
// pointless here and the cache is a plain age check.
let robotsGroup = null;
let gapMs = MIN_GAP_MS;
let lastHit = 0;
const requestCounts = { network: 0, cache: 0, blocked: 0, failed: 0 };

async function politeFetch(url, { tries = 2, allowUncached = false } = {}) {
  const key = sha1(url);
  const bodyPath = path.join(CACHE, key + '.html');
  const metaPath = path.join(CACHE, key + '.meta.json');

  let stale = null;
  if (USE_CACHE && !allowUncached) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      const age = Date.now() - Date.parse(meta.fetched);
      if (meta.url === url) {
        const entry = { status: meta.status, body: meta.status === 200 ? await readFile(bodyPath, 'utf8') : '', finalUrl: meta.finalUrl || url, fetched: meta.fetched };
        if (age >= 0 && age < MAX_AGE_MS) { requestCounts.cache++; return { ...entry, mode: 'cache' }; }
        stale = entry;
      }
    } catch { /* no usable cache entry */ }
  }

  const urlPath = new URL(url).pathname;
  if (robotsGroup) {
    const v = robotsVerdict(robotsGroup, urlPath);
    if (!v.allowed) { requestCounts.blocked++; return { status: 0, body: '', finalUrl: url, mode: 'robots-blocked', rule: v.rule }; }
  }

  for (let t = 0; t < tries; t++) {
    const wait = lastHit + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit = Date.now();
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      // A redirect can land somewhere robots has not cleared. Check where we
      // actually ended up, not only where we asked to go.
      if (robotsGroup && res.url) {
        const finalPath = new URL(res.url).pathname;
        const v = robotsVerdict(robotsGroup, finalPath);
        if (!v.allowed) { requestCounts.blocked++; return { status: 0, body: '', finalUrl: res.url, mode: 'robots-blocked-after-redirect', rule: v.rule }; }
      }
      const body = res.status === 200 ? await res.text() : '';
      requestCounts.network++;
      await mkdir(CACHE, { recursive: true }).catch(() => {});
      await writeFile(metaPath, JSON.stringify({ url, finalUrl: res.url || url, status: res.status, fetched: new Date().toISOString() })).catch(() => {});
      if (res.status === 200) await writeFile(bodyPath, body).catch(() => {});
      return { status: res.status, body, finalUrl: res.url || url, mode: 'network' };
    } catch {
      if (t === tries - 1) break;
      await sleep(1500 * (t + 1));
    }
  }
  requestCounts.failed++;
  // Fail-soft: an expired cached copy beats dropping the role, because a role
  // that vanishes from the file quietly re-weights everything left in it. The
  // stale window label then trips the period check, so it cannot pass unnoticed.
  if (stale) {
    warn(`${url} could not be refetched; using the copy cached on ${String(stale.fetched).slice(0, 10)}`);
    return { ...stale, mode: 'cache-stale' };
  }
  return { status: 0, body: '', finalUrl: url, mode: 'error' };
}

// ---- HTML ------------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£' };
function unescapeHtml(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s) => unescapeHtml(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const norm = (s) => stripTags(s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

// Money and counts. A dash, a blank or anything non-numeric is a suppressed or
// absent cell and becomes null. It never becomes zero: a zero here would be read
// as "this role pays nothing", and n = 0 is a real, different statement.
function parseMoney(s) {
  const t = String(s ?? '').replace(/[£,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Math.round(Number(t));
  return v > 0 ? v : null;
}
function parseCount(s) {
  const t = String(s ?? '').replace(/[,\s]/g, '');
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

function tableRows(tableHtml) {
  const rows = [];
  for (const m of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function sectionHtml(html, id) {
  const start = html.indexOf(`<section id="${id}"`);
  if (start < 0) return null;
  const next = html.indexOf('<section', start + 8);
  return html.slice(start, next < 0 ? html.length : next);
}

function summaryTables(html) {
  const out = [];
  for (const m of html.matchAll(/<table class="summary"[^>]*>([\s\S]*?)<\/table>/gi)) out.push(m[1]);
  return out;
}

// ---- page parsing ----------------------------------------------------------
// The headline section carries two identically-shaped tables: the title's own
// statistics, then the same statistics for every permanent IT vacancy. Rows are
// found by their printed label, never by position, because the row order has no
// guarantee behind it.
const ROW_KEYS = [
  ['n', s => s === 'number of salaries quoted'],
  ['median', s => s.startsWith('median annual salary')],
  ['p10', s => s === '10 th percentile' || s === '10th percentile'],
  ['p25', s => s === '25 th percentile' || s === '25th percentile'],
  ['p75', s => s === '75 th percentile' || s === '75th percentile'],
  ['p90', s => s === '90 th percentile' || s === '90th percentile'],
  ['ads', s => s.startsWith('permanent jobs requiring')],
  ['vacancies', s => s.startsWith('permanent vacancies in the uk')],
  ['exLondonMedian', s => s.startsWith('uk excluding london median')],
];

function parseSummaryTable(tableHtml) {
  const rows = tableRows(tableHtml);
  if (!rows.length) return null;
  const header = rows.find(r => r.some(c => /months to|same period/i.test(c))) || [];
  const periods = header.slice(1).map(c => c.trim()).filter(Boolean);
  const found = {};
  for (const cells of rows) {
    const label = norm(cells[0] || '');
    if (!label) continue;
    for (const [key, test] of ROW_KEYS) {
      if (found[key] || !test(label)) continue;
      found[key] = cells.slice(1, 4);
    }
  }
  const col = (key, i, kind) => {
    const raw = found[key]?.[i];
    if (raw == null) return null;
    return kind === 'count' ? parseCount(raw) : parseMoney(raw);
  };
  return {
    periods,
    n: col('n', 0, 'count'),
    median: col('median', 0),
    pct: [col('p10', 0), col('p25', 0), col('p75', 0), col('p90', 0)],
    ads: col('ads', 0, 'count'),
    vacancies: col('vacancies', 0, 'count'),
    exLondonMedian: col('exLondonMedian', 0),
    prior: [1, 2].map(i => ({
      label: periods[i] || null,
      n: col('n', i, 'count'),
      median: col('median', i),
    })),
  };
}

function parseLocations(html) {
  const m = html.match(/<table class="tab tabLocations"[^>]*>([\s\S]*?)<\/table>/i);
  if (!m) return {};
  const out = {};
  for (const cells of tableRows(m[1])) {
    const name = norm(cells[0] || '');
    if (!name || name === 'location') continue;
    // Location | rank change | matching ads | median | median % change | live jobs
    out[name] = { ads: parseCount(cells[2]), median: parseMoney(cells[3]) };
  }
  return out;
}

// "6 months to 15 Aug 2026" -> { months: 6, windowEnd: '2026-08-15' }
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parsePeriod(label) {
  if (!label) return null;
  const months = Number((label.match(/(\d+)\s*months?/i) || [])[1]) || null;
  const d = label.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  let windowEnd = null;
  if (d) {
    const mo = MONTHS[d[2].slice(0, 3).toLowerCase()];
    if (mo) windowEnd = `${d[3]}-${String(mo).padStart(2, '0')}-${String(Number(d[1])).padStart(2, '0')}`;
  }
  return { label: label.replace(/\s+/g, ' ').trim(), months, windowEnd };
}

function parseTitlePage(html) {
  const head = sectionHtml(html, 'headline_statistics');
  if (!head) return { error: 'no headline_statistics section' };
  const tables = summaryTables(head);
  if (!tables.length) return { error: 'no summary table' };
  const title = parseSummaryTable(tables[0]);
  if (!title || title.n == null) return { error: 'summary table has no salary-count row' };
  const baseline = tables[1] ? parseSummaryTable(tables[1]) : null;
  // The prose sentence states the median independently of the table. If the two
  // disagree the page layout has moved under us and neither should be trusted.
  const prose = stripTags(head).match(/median[\s\S]{0,120}?salary in the UK is £([\d,]+)/i);
  const proseMedian = prose ? parseMoney(prose[1]) : null;
  return { title, baseline, locations: parseLocations(html), proseMedian };
}

// ---- the role list ---------------------------------------------------------
// Technology roles only. The senior titles are the comparison; the practitioner
// titles are the ladder underneath it, which is where the SCS DDaT pay problem
// actually shows up. `soc` is populated only where the study's own SOC 2020
// crosswalk has an entry — an invented code would be worse than none. `scs` is
// a judgement about grade equivalence and is labelled hypothesis throughout.
const ROLES = [
  // Senior technology leadership — the SCS comparison
  { id: 'chief-technology-officer', title: 'Chief Technology Officer', group: 'leadership', soc: '1137', scs: 'SCS2 to SCS3' },
  { id: 'chief-information-officer', title: 'Chief Information Officer', group: 'leadership', soc: '1137', scs: 'SCS2 to SCS3' },
  { id: 'chief-digital-officer', title: 'Chief Digital Officer', group: 'leadership', soc: '1137', scs: 'SCS2 to SCS3' },
  { id: 'chief-data-officer', title: 'Chief Data Officer', group: 'leadership', soc: '1137', scs: 'SCS2 to SCS3' },
  { id: 'chief-information-security-officer', title: 'Chief Information Security Officer', group: 'leadership', soc: '2135', scs: 'SCS1 to SCS2' },
  { id: 'it-director', title: 'IT Director', group: 'leadership', soc: '1137', scs: 'SCS1 to SCS2' },
  { id: 'programme-director', title: 'Programme Director', group: 'leadership', soc: '2131', scs: 'SCS1 to SCS2' },
  { id: 'head-of-it', title: 'Head of IT', group: 'leadership', soc: '1137', scs: 'SCS1' },
  { id: 'head-of-technology', title: 'Head of Technology', group: 'leadership', soc: '1137', scs: 'SCS1' },
  { id: 'head-of-digital', title: 'Head of Digital', group: 'leadership', soc: '1137', scs: 'SCS1' },
  { id: 'head-of-engineering', title: 'Head of Engineering', group: 'leadership', soc: '1137', scs: 'SCS1' },
  { id: 'head-of-software-engineering', title: 'Head of Software Engineering', group: 'leadership', soc: '1137', scs: 'SCS1' },
  { id: 'head-of-architecture', title: 'Head of Architecture', group: 'leadership', soc: '2133', scs: 'SCS1' },
  { id: 'head-of-infrastructure', title: 'Head of Infrastructure', group: 'leadership', soc: '1137', scs: 'SCS1' },
  { id: 'head-of-delivery', title: 'Head of Delivery', group: 'leadership', soc: '2131', scs: 'SCS1' },
  { id: 'head-of-data', title: 'Head of Data', group: 'leadership', soc: null, scs: 'SCS1' },
  { id: 'head-of-data-science', title: 'Head of Data Science', group: 'leadership', soc: null, scs: 'SCS1' },
  { id: 'head-of-information-security', title: 'Head of Information Security', group: 'leadership', soc: '2135', scs: 'SCS1' },
  { id: 'head-of-cyber-security', title: 'Head of Cyber Security', group: 'leadership', soc: '2135', scs: 'SCS1' },
  { id: 'it-programme-manager', title: 'IT Programme Manager', group: 'leadership', soc: '2131', scs: 'Grade 6 to SCS1' },
  // Practitioner titles — the ladder below the SCS, and the recruitment market
  // an SCS1 DDaT post is competing against
  { id: 'enterprise-architect', title: 'Enterprise Architect', group: 'practitioner', soc: '2133', scs: 'below SCS' },
  { id: 'technical-architect', title: 'Technical Architect', group: 'practitioner', soc: '2133', scs: 'below SCS' },
  { id: 'solutions-architect', title: 'Solutions Architect', group: 'practitioner', soc: '2133', scs: 'below SCS', slugs: ['solutions architect', 'solution architect'] },
  { id: 'data-architect', title: 'Data Architect', group: 'practitioner', soc: '2133', scs: 'below SCS' },
  { id: 'security-architect', title: 'Security Architect', group: 'practitioner', soc: '2135', scs: 'below SCS' },
  { id: 'information-security-manager', title: 'Information Security Manager', group: 'practitioner', soc: '2135', scs: 'below SCS' },
  { id: 'site-reliability-engineer', title: 'Site Reliability Engineer', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'lead-data-scientist', title: 'Lead Data Scientist', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'data-scientist', title: 'Data Scientist', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'data-engineer', title: 'Data Engineer', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'software-developer', title: 'Software Developer', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'business-analyst', title: 'Business Analyst', group: 'practitioner', soc: '2133', scs: 'below SCS' },
  { id: 'delivery-manager', title: 'Delivery Manager', group: 'practitioner', soc: '2131', scs: 'below SCS' },
  { id: 'service-delivery-manager', title: 'Service Delivery Manager', group: 'practitioner', soc: '2131', scs: 'below SCS' },
  { id: 'it-project-manager', title: 'IT Project Manager', group: 'practitioner', soc: '2131', scs: 'below SCS' },
  { id: 'product-manager', title: 'Product Manager', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'user-researcher', title: 'User Researcher', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'service-designer', title: 'Service Designer', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'interaction-designer', title: 'Interaction Designer', group: 'practitioner', soc: null, scs: 'below SCS' },
  { id: 'content-designer', title: 'Content Designer', group: 'practitioner', soc: null, scs: 'below SCS' },
];

// Non-technology titles, probed only to keep the "technology only" caveat true.
// They are never emitted as benchmarks. If one of them ever starts resolving
// with a usable sample, the caveat is wrong and the run says so.
const CONTROL_TITLES = ['finance director', 'chief economist', 'hr director', 'chief operating officer'];

const slugsFor = (role) => role.slugs || [role.title.toLowerCase()];
const pageUrl = (slug) => ORIGIN + PAGE_TEMPLATE.replace('{slug}', encodeURIComponent(slug));

// ---- fixed prose that must travel with the data ----------------------------
const LICENCE = {
  id: 'CC-BY-NC-SA-4.0',
  name: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International',
  url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  policyUrl: `${ORIGIN}/copyright`,
  attribution: 'Source: IT Jobs Watch',
  attributionUrl: `${ORIGIN}/`,
  notice: 'Job market statistics in this file are taken from IT Jobs Watch and are licensed under CC BY-NC-SA 4.0. Any interface rendering a figure from this file must display the attribution "Source: IT Jobs Watch", link to itjobswatch.co.uk, and name the licence.',
  conditions: [
    'BY: the attribution string above is shown wherever a figure from this file is shown.',
    'NC: non-commercial use only. This study is a non-commercial research page and carries no advertising, no paywall and no sale of derived data.',
    'SA: anything built on this data inherits CC BY-NC-SA 4.0, which is exactly why it is quarantined in its own file rather than merged into the Open Government Licence dataset.',
  ],
  quarantine: 'This file is never merged into benchmarks.json, meta.json or any cube. The main dataset stays Open Government Licence v3.0; this layer stays CC BY-NC-SA 4.0. Render them side by side, never combined into one derived figure.',
};

const MEASURE = {
  kind: 'advertised',
  statement: 'Median salary quoted in permanent job advertisements over a rolling six-month window. It is what employers offered, not what anyone was paid.',
  unit: 'GBP per year, nominal, before tax, excluding pension and any bonus not stated in the advert',
  vsAshe: 'ONS ASHE measures earnings actually paid to people in post, from employer payroll returns. Advertised rates lead paid rates, and they skew towards the roles employers are struggling to fill. The two are not interchangeable and must never be plotted as one series.',
  vsScs: 'An SCS organogram records the base salary of an occupied post, published as a five-thousand-pound band. Against that, an advertised median is a different measurement of a different population at a different moment. Use it to show what the market is offering, never to compute a gap to the pound.',
  pension: 'Advertised salaries carry no pension figure. The civil service alpha employer contribution is worth roughly 23.6 to 28 per cent of salary against a typical private defined-contribution 3 to 8 per cent, so a bare salary comparison overstates the difference.',
  sample: 'n is the number of advertisements quoting a salary in the window, not a number of people. One employer advertising the same post repeatedly counts more than once; a post filled without an advert does not count at all.',
};

const COMPARABILITY = [
  'Advertised, not paid. This is the one caveat that cannot be omitted from any instrument drawing on this file.',
  `Below n = ${N_FLOOR} no figure is shown, only the count. Roles under the gate are kept in this file with status "insufficient" so the gaps stay visible.`,
  'Coverage is technology roles only. Chief digital officer, chief data officer and head of data return 404 from this source, and non-technology senior titles are absent entirely, so this layer can say nothing about finance, legal, policy, commercial or medical senior pay.',
  'The population is the whole UK advertised technology market, overwhelmingly private sector and London-weighted. It is not a public-sector comparator.',
  'A suppressed or unpublished cell is null. It is never zero.',
  'Percentiles are advertised-salary percentiles over the same window, so a p25 to p75 range here compares to a p25 to p75 range elsewhere, never to a point estimate.',
  'London and UK-excluding-London figures come from the source\'s location table, whose sample column counts advertisements rather than quoted salaries, so their n is an upper bound and is labelled ads, not n.',
  'Titles are matched by name. A market "Head of IT" and an SCS deputy director leading a digital function are similar jobs in different institutions, not the same job. Every grade mapping in this file is a hypothesis.',
];

const FIELD_GUIDE = 'roles[]: id, title, group (leadership or practitioner), soc (study SOC 2020 crosswalk, null where none applies), scs (hypothesised grade equivalence), status (ok, insufficient, absent or error), n (advertisements quoting a salary), median, pct [p10, p25, p75, p90], ads (advertisements in the window), london and exLondon [median, ads] from the source\'s location table, whose median is null when its advertisement count is below the floor, prior [[period label, n, median], ...] for the same window one and two years earlier. slug is present only when it differs from the lower-cased title; the page URL is source.urlTemplate with {slug} substituted and percent-encoded. Any money value may be null, meaning unpublished or suppressed; null never means zero. Only status "ok" figures cleared the n gate and may be drawn.';

// ---- main ------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  await mkdir(CACHE, { recursive: true });

  // 1. robots.txt, first request of the run, live every time. If it cannot be
  //    read the run stops: an unreadable robots.txt is not permission.
  const robots = await politeFetch(ROBOTS_URL, { allowUncached: true });
  if (robots.status !== 200 || !robots.body.trim()) {
    stop('robots.txt could not be read', [`${ROBOTS_URL} returned ${robots.status || robots.mode}`, 'Without a readable robots.txt there is no permission to crawl, so nothing was fetched.']);
  }
  const robotsLines = robots.body.split(/\r\n?|\n/).map(l => l.trim()).filter(Boolean);
  robotsGroup = selectRobotsGroup(parseRobots(robots.body), UA_TOKEN);
  if (robotsGroup.crawlDelay != null && robotsGroup.crawlDelay * 1000 > gapMs) {
    gapMs = Math.ceil(robotsGroup.crawlDelay * 1000);
    log(`  robots.txt asks for a ${robotsGroup.crawlDelay}s crawl delay; honouring it`);
  }
  const samplePath = new URL(pageUrl('it director')).pathname;
  const pageVerdict = robotsVerdict(robotsGroup, samplePath);
  const copyrightVerdict = robotsVerdict(robotsGroup, new URL(COPYRIGHT_URL).pathname);
  if (!pageVerdict.allowed || !copyrightVerdict.allowed) {
    stop('robots.txt no longer permits the pages this script reads', [
      `${samplePath} -> ${pageVerdict.allowed ? 'allowed' : 'DISALLOWED'} (${pageVerdict.rule})`,
      `/copyright -> ${copyrightVerdict.allowed ? 'allowed' : 'DISALLOWED'} (${copyrightVerdict.rule})`,
      'robots.txt as read this run:', ...robotsLines.map(l => '  ' + l),
      'This is a correct outcome, not a fault. Remove the IT Jobs Watch layer or seek written permission.',
    ]);
  }
  log(`  robots.txt          : group [${robotsGroup.agents.join(', ')}], ${robotsGroup.rules.length} rule(s); ${samplePath} ${pageVerdict.rule}`);

  // 2. The licence itself. The whole justification for this file is that the
  //    statistics are CC BY-NC-SA. If the copyright page stops saying so, the
  //    permission is gone and so is the file.
  const cp = await politeFetch(COPYRIGHT_URL, { allowUncached: true });
  if (cp.status !== 200) stop('the copyright policy could not be read', [`${COPYRIGHT_URL} returned ${cp.status || cp.mode}`, 'The licence cannot be confirmed, so nothing was fetched or written.']);
  const cpText = stripTags(cp.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
  const licenceBlock = (cpText.match(/Creative Commons[\s\S]*?(?=Intellectual Property Rights|$)/i) || [''])[0].trim();
  const hasCC = /creative commons/i.test(cpText);
  const hasBYNCSA = /attribution[\s-]*non[\s-]*commercial[\s-]*share[\s-]*alike/i.test(cpText.replace(/‑|–|—/g, '-'));
  const hasVersion = /4\.0/.test(cpText);
  const hasAttribution = /source\s+it\s+jobs\s+watch/i.test(cpText);
  if (!hasCC || !hasBYNCSA || !hasVersion) {
    stop('the copyright policy no longer states a CC BY-NC-SA 4.0 licence', [
      `creative commons: ${hasCC}, attribution-noncommercial-sharealike: ${hasBYNCSA}, version 4.0: ${hasVersion}`,
      `read from ${COPYRIGHT_URL} on ${TODAY}`,
      'Reuse permission cannot be assumed, so no page was fetched and no file was written.',
    ]);
  }
  if (!hasAttribution) warn('the copyright policy no longer spells out the "Source IT Jobs Watch" attribution string; the notice in this file may need rewording');
  const policySha = sha256(licenceBlock || cpText);
  const previous = await readJSON(OUT);
  if (previous?.licence?.policySha256 && previous.licence.policySha256 !== policySha) {
    warn('the copyright policy text has changed since the last run; it still states CC BY-NC-SA 4.0 but the wording should be re-read before the next publish');
  }
  log(`  copyright policy    : CC BY-NC-SA 4.0 confirmed, sha256 ${policySha.slice(0, 12)}`);

  // 3. The role list.
  const selected = ONLY.length ? ROLES.filter(r => ONLY.includes(r.id)) : ROLES;
  if (ONLY.length && selected.length !== ONLY.length) {
    const missing = ONLY.filter(id => !ROLES.some(r => r.id === id));
    if (missing.length) stop(`unknown role id(s): ${missing.join(', ')}`, ['run without --only to see the full list']);
  }
  const partial = selected.length !== ROLES.length;

  let period = null;
  let baseline = null;
  const out = [];
  for (const role of selected) {
    const rec = { id: role.id, title: role.title, group: role.group, soc: role.soc, scs: role.scs, status: 'absent', n: null, median: null };
    const attempts = [];
    let page = null, usedSlug = null;
    for (const slug of slugsFor(role)) {
      const res = await politeFetch(pageUrl(slug));
      attempts.push({ slug, status: res.status || res.mode });
      if (res.status === 200) { page = res; usedSlug = slug; break; }
    }
    if (!page) {
      const errored = attempts.some(a => a.status === 0 || a.status === 'error');
      const tried = attempts.length > 1 ? ` (tried ${attempts.map(a => `${a.slug}: ${a.status}`).join('; ')})` : ` (${attempts[0].status})`;
      rec.status = errored ? 'error' : 'absent';
      rec.note = errored
        ? `could not be fetched this run${tried}; no figure is claimed`
        : `no page at this source${tried}: the market has no advertised benchmark under this name`;
      if (errored) warn(`${role.id}: fetch failed, kept as status "error"`);
      out.push(rec);
      continue;
    }
    if (usedSlug !== role.title.toLowerCase()) rec.slug = usedSlug;

    const parsed = parseTitlePage(page.body);
    if (parsed.error) {
      rec.status = 'error';
      rec.note = `page fetched but could not be parsed: ${parsed.error}`;
      warn(`${role.id}: ${parsed.error} — the page layout may have changed`);
      out.push(rec);
      continue;
    }
    const t = parsed.title;
    const thisPeriod = parsePeriod(t.periods[0]);
    if (!period && thisPeriod) period = { ...thisPeriod, priorLabels: t.periods.slice(1) };
    else if (thisPeriod && period && thisPeriod.label !== period.label) {
      rec.period = thisPeriod.label;
      warn(`${role.id}: window "${thisPeriod.label}" differs from "${period.label}"`);
    }
    if (!baseline && parsed.baseline?.n != null) {
      baseline = {
        label: 'All permanent UK IT job advertisements',
        n: parsed.baseline.n,
        median: parsed.baseline.median,
        pct: parsed.baseline.pct,
        vacancies: parsed.baseline.vacancies,
        exLondonMedian: parsed.baseline.exLondonMedian,
      };
    }
    if (t.median != null && parsed.proseMedian != null && parsed.proseMedian !== t.median) {
      warn(`${role.id}: the page prose says ${parsed.proseMedian} and the table says ${t.median}; the table figure is used`);
    }

    rec.n = t.n;
    rec.ads = t.ads;
    // The gate. n is always kept; the figures are only kept when n clears it.
    if (t.n != null && t.n >= N_FLOOR && t.median != null) {
      rec.status = 'ok';
      rec.median = t.median;
      rec.pct = t.pct;
      // The location table counts advertisements, not quoted salaries, so its
      // sample is an upper bound on n. Apply the same floor to it, and keep the
      // count visible when the figure is withheld.
      const locFig = (o) => (o ? [o.ads != null && o.ads >= N_FLOOR ? o.median : null, o.ads] : null);
      rec.london = locFig(parsed.locations['london']);
      rec.exLondon = locFig(parsed.locations['uk excluding london']);
      rec.prior = t.prior.filter(p => p.label).map(p => [String((p.label.match(/\d{4}/) || [p.label])[0]), p.n, p.median]);
    } else {
      rec.status = 'insufficient';
      rec.note = t.n == null
        ? 'insufficient market data — no salary count published for this window'
        : t.median == null
          ? `insufficient market data — n = ${t.n}, no median published`
          : `insufficient market data — n = ${t.n}, below the n = ${N_FLOOR} floor`;
    }
    out.push(rec);
  }

  // 4. Control probes. Not benchmarks: evidence for the coverage caveat.
  const controls = [];
  if (CONTROLS && !partial) {
    for (const title of CONTROL_TITLES) {
      const res = await politeFetch(pageUrl(title));
      const entry = { title, status: res.status === 200 ? 'resolved' : (res.status || res.mode), n: null };
      if (res.status === 200) {
        const p = parseTitlePage(res.body);
        entry.n = p.error ? null : p.title.n;
        if (entry.n != null && entry.n >= N_FLOOR) {
          warn(`the non-technology control title "${title}" now resolves with n = ${entry.n}; the "technology roles only" caveat needs revisiting`);
        }
      }
      controls.push(entry);
    }
  }

  // 5. Floor assertions. A run that quietly resolves almost nothing looks
  //    exactly like a successful run in the output, so it must not be one.
  const resolved = out.filter(r => r.status === 'ok' || r.status === 'insufficient').length;
  const reported = out.filter(r => r.status === 'ok').length;
  if (!partial) {
    if (resolved < MIN_RESOLVED || reported < MIN_REPORTED) {
      stop('too few roles resolved for this to be a healthy run', [
        `${resolved} of ${selected.length} titles resolved (floor ${MIN_RESOLVED}), ${reported} cleared n = ${N_FLOOR} (floor ${MIN_REPORTED})`,
        'Either the site changed shape or the network is failing. Nothing was written.',
      ]);
    }
  } else {
    log(`  partial run         : ${selected.length} of ${ROLES.length} roles, floor assertions skipped`);
  }
  if (!period) stop('no reporting period could be read from any page', ['the summary table header has changed shape; nothing was written']);

  const result = {
    schema: SCHEMA,
    generated: new Date().toISOString(),
    quarantined: true,
    doNotMerge: 'Structurally separate from benchmarks.json by design. See licence.quarantine.',
    purpose: 'Advertised market rates for technology roles, as a contrast to what the Senior Civil Service is paid. A secondary, non-Open-Government-Licence layer, shown beside the main dataset and never blended into it.',
    source: {
      name: 'IT Jobs Watch',
      publisher: 'IT Jobs Watch Ltd',
      url: `${ORIGIN}/`,
      urlTemplate: ORIGIN + PAGE_TEMPLATE,
      retrieved: TODAY,
      updateFrequency: 'daily',
      robots: {
        url: ROBOTS_URL,
        checked: TODAY,
        lines: robotsLines,
        appliedGroup: robotsGroup.agents,
        verdict: `${samplePath}: ${pageVerdict.rule}`,
      },
      requestPolicy: {
        userAgent: UA,
        minGapMs: gapMs,
        cacheDays: MAX_AGE_MS / 86400000,
        networkRequests: requestCounts.network,
        cacheHits: requestCounts.cache,
        failures: requestCounts.failed,
      },
    },
    licence: { ...LICENCE, policyChecked: TODAY, policySha256: policySha },
    measure: MEASURE,
    gate: {
      nFloor: N_FLOOR,
      rule: `Below n = ${N_FLOOR} there is no figure, only the count. Roles under the gate stay in this file with status "insufficient" and their n, because silently dropping them would bias the visible set towards the best-covered technology roles. The median itself is withheld below the gate so it cannot be drawn by accident.`,
    },
    comparability: COMPARABILITY,
    fieldGuide: FIELD_GUIDE,
    period,
    marketBaseline: baseline,
    roles: out,
    coverage: {
      probed: selected.length,
      resolved,
      reported,
      insufficient: out.filter(r => r.status === 'insufficient').length,
      absent: out.filter(r => r.status === 'absent').length,
      failed: out.filter(r => r.status === 'error').length,
      absentTitles: out.filter(r => r.status === 'absent').map(r => r.title),
      nonTechnologyProbes: controls,
      note: 'Every title probed appears in roles[], resolved or not. The absences are part of the finding: this source covers technology hiring and nothing else.',
    },
    partial: partial || undefined,
    warnings: [...warnings].sort(),
  };
  result.digest = sha256(JSON.stringify({ roles: result.roles, baseline: result.marketBaseline, period: result.period }));

  const json = JSON.stringify(result) + '\n';
  const bytes = Buffer.byteLength(json);
  const gz = gzipSync(Buffer.from(json)).length;

  if (DRY_RUN) {
    log(`\n-- dry run: nothing written (${(bytes / 1024).toFixed(1)}KB raw, ${(gz / 1024).toFixed(1)}KB gz)`);
  } else {
    if (bytes > BUDGET_BYTES) {
      stop(`benchmarks-itjw.json is ${(bytes / 1024).toFixed(1)}KB against a ${BUDGET_BYTES / 1024}KB budget`, ['trim the role list or the prose blocks before shipping']);
    }
    await mkdir(path.dirname(OUT), { recursive: true });
    const tmp = OUT + '.tmp';
    await writeFile(tmp, json);
    await rename(tmp, OUT);
  }

  summarise(result, bytes, gz, t0);
}

async function readJSON(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

function summarise(r, bytes, gz, t0) {
  const money = (v) => (v == null ? '        -' : ('£' + v.toLocaleString('en-GB')).padStart(9));
  log('\n== done ==');
  log(`  window              : ${r.period.label}  (${r.period.months} months to ${r.period.windowEnd})`);
  log(`  measures            : ADVERTISED salary, not paid`);
  log(`  licence             : ${r.licence.id} — "${r.licence.attribution}"`);
  log('\n  reported (n >= 30)');
  for (const x of r.roles.filter(x => x.status === 'ok')) {
    log(`    ${money(x.median)}  n=${String(x.n).padStart(5)}  ${x.title}${x.soc ? `  [SOC ${x.soc}]` : ''}`);
  }
  const under = r.roles.filter(x => x.status === 'insufficient');
  if (under.length) {
    log('\n  insufficient market data (kept, never dropped)');
    for (const x of under) log(`    n=${String(x.n ?? '-').padStart(5)}  ${x.title}`);
  }
  const gone = r.roles.filter(x => x.status === 'absent' || x.status === 'error');
  if (gone.length) {
    log('\n  no page at this source');
    for (const x of gone) log(`    ${x.status.padEnd(8)} ${x.title}`);
  }
  if (r.coverage.nonTechnologyProbes.length) {
    log('\n  non-technology control probes');
    for (const c of r.coverage.nonTechnologyProbes) log(`    ${String(c.status).padEnd(9)} n=${String(c.n ?? '-').padStart(5)}  ${c.title}`);
  }
  if (r.marketBaseline) log(`\n  all permanent UK IT ads: median ${money(r.marketBaseline.median).trim()}, n=${r.marketBaseline.n?.toLocaleString('en-GB')}`);
  log(`\n  requests            : ${requestCounts.network} network, ${requestCounts.cache} cached, ${requestCounts.failed} failed, ${requestCounts.blocked} blocked by robots (min gap ${gapMs}ms)`);
  log(`  size                : ${(bytes / 1024).toFixed(1)}KB raw / ${(gz / 1024).toFixed(1)}KB gz  (budget ${BUDGET_BYTES / 1024}KB raw)`);
  log(`  digest              : ${r.digest.slice(0, 16)}`);
  if (r.warnings.length) for (const w of r.warnings) log(`  WARNING             : ${w}`);
  log(`  elapsed             : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---- self-test -------------------------------------------------------------
// The three things that would silently ruin this file are a robots rule read in
// our own favour, a suppressed cell coerced to zero, and a table row matched by
// position. All three are checked here against fixed inputs, so the checks run
// without touching the site and can sit in the monthly job.
function selfTest() {
  let failed = 0;
  const eq = (name, got, want) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a === b) return;
    failed++;
    console.error(`  FAIL ${name}\n    got  ${a}\n    want ${b}`);
  };

  const live = 'User-agent: *\nDisallow: /ja/\n\nSitemap: https://www.itjobswatch.co.uk/sitemap_index.xml\n';
  const g1 = selectRobotsGroup(parseRobots(live), UA_TOKEN);
  eq('live robots allows a title page', robotsVerdict(g1, '/jobs/uk/it%20director.do').allowed, true);
  eq('live robots blocks /ja/', robotsVerdict(g1, '/ja/jobs/uk/it.do').allowed, false);

  const shut = 'User-agent: *\nDisallow: /\n';
  eq('a site-wide disallow stops us', robotsVerdict(selectRobotsGroup(parseRobots(shut), UA_TOKEN), '/jobs/uk/x.do').allowed, false);

  const named = 'User-agent: *\nDisallow: /ja/\n\nUser-agent: scs-earnings-itjobswatch\nDisallow: /\n';
  eq('a group naming us wins over the wildcard', robotsVerdict(selectRobotsGroup(parseRobots(named), UA_TOKEN), '/jobs/uk/x.do').allowed, false);

  const mixed = 'User-agent: *\nDisallow: /jobs/\nAllow: /jobs/uk/\nCrawl-delay: 5\n';
  const g2 = selectRobotsGroup(parseRobots(mixed), UA_TOKEN);
  eq('longest match wins', robotsVerdict(g2, '/jobs/uk/x.do').allowed, true);
  eq('the shorter disallow still applies elsewhere', robotsVerdict(g2, '/jobs/london/x.do').allowed, false);
  eq('crawl-delay is read', g2.crawlDelay, 5);
  eq('an empty disallow allows everything', robotsVerdict(selectRobotsGroup(parseRobots('User-agent: *\nDisallow:\n'), UA_TOKEN), '/anything').allowed, true);
  eq('a $ anchor is honoured', robotsVerdict(selectRobotsGroup(parseRobots('User-agent: *\nDisallow: /*.do$\n'), UA_TOKEN), '/jobs/uk/x.do').allowed, false);

  eq('a dash is null, not zero', parseMoney('-'), null);
  eq('an empty cell is null', parseMoney(''), null);
  eq('a pound figure parses', parseMoney('£113,750'), 113750);
  eq('n = 0 is a real zero', parseCount('0'), 0);
  eq('a thousands-separated n parses', parseCount('1,380'), 1380);
  eq('a dash is not a count', parseCount('-'), null);

  const fixture = `<section id="headline_statistics"><p>The median Test Role salary in the UK is &#163;100,000 per year</p>
<table class="summary">
<tr class="rowHdr"><th class="hdr">x</th><th class="hdrCol">6 months to<br>15 Aug 2026</th><th class="hdrCol">Same period 2025</th><th class="hdrCol">Same period 2024</th></tr>
<tr><td>Rank</td><td class="fig">711</td><td class="fig">680</td><td class="fig">764</td></tr>
<tr><td>Permanent jobs requiring a Test Role</td><td class="fig">74</td><td class="fig">12</td><td class="fig">53</td></tr>
<tr><td>Number of salaries quoted</td><td class="fig">62</td><td class="fig">10</td><td class="fig">47</td></tr>
<tr><td>25<sup>th</sup> Percentile</td><td class="fig">-</td><td class="fig">&#163;78,750</td><td class="fig">&#163;80,000</td></tr>
<tr><td>Median annual salary (50<sup>th</sup> Percentile)</td><td class="fig">&#163;100,000</td><td class="fig">&#163;92,500</td><td class="fig">&#163;85,000</td></tr>
<tr><td>Median % change year-on-year</td><td class="fig">+8.11%</td><td class="fig">+8.82%</td><td class="fig">-22.73%</td></tr>
<tr><td>75<sup>th</sup> Percentile</td><td class="fig">&#163;113,750</td><td class="fig">&#163;141,250</td><td class="fig">&#163;103,750</td></tr>
<tr class="rowMedium"><td>UK excluding London median annual salary</td><td class="fig">&#163;99,000</td><td class="fig">&#163;93,750</td><td class="fig">&#163;84,700</td></tr>
</table>
<table class="summary"><tr class="rowHdr"><th>x</th><th class="hdrCol">6 months to<br>15 Aug 2026</th></tr>
<tr><td>Number of salaries quoted</td><td class="fig">68,470</td></tr>
<tr><td>Median annual salary (50<sup>th</sup> Percentile)</td><td class="fig">&#163;56,076</td></tr></table></section>
<table class="tab tabLocations"><tr class="rowMedium"><th>Location</th><th>Rank Change</th><th>Matching Permanent IT Job Ads</th><th>Median Salary</th></tr>
<tr><td class="ld"><a href="#">London</a></td><td class="rc">-33</td><td class="fig">26</td><td class="fig">&#163;100,000</td></tr>
<tr class="alt"><td class="ld"><a href="#">UK excluding London</a></td><td class="rc">-50</td><td class="fig">42</td><td class="fig">&#163;99,000</td></tr></table>`;
  const p = parseTitlePage(fixture);
  eq('the page parses', p.error ?? null, null);
  eq('n comes from its label, not its row position', p.title.n, 62);
  eq('the median is the median row', p.title.median, 100000);
  eq('a suppressed percentile stays null beside a real one', p.title.pct, [null, null, 113750, null]);
  eq('the advert count is separate from n', p.title.ads, 74);
  eq('prior periods carry their own n', p.title.prior, [{ label: 'Same period 2025', n: 10, median: 92500 }, { label: 'Same period 2024', n: 47, median: 85000 }]);
  eq('the prose median cross-check reads', p.proseMedian, 100000);
  eq('the second summary table is the market baseline', [p.baseline.n, p.baseline.median], [68470, 56076]);
  eq('London comes from the location table', p.locations['london'], { ads: 26, median: 100000 });
  eq('UK excluding London comes from the location table', p.locations['uk excluding london'], { ads: 42, median: 99000 });
  eq('the period parses', parsePeriod('6 months to 15 Aug 2026'), { label: '6 months to 15 Aug 2026', months: 6, windowEnd: '2026-08-15' });

  if (failed) { console.error(`\n${failed} self-test failure(s)`); process.exit(1); }
  console.log('self-test: all checks passed');
}

if (flag('--self-test')) selfTest();
else main().catch(e => { console.error(e); process.exit(1); });
