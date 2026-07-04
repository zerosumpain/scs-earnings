// SCS earnings ingestion pipeline.
//
// Gathers every published "senior" organogram CSV (gov.uk transparency data)
// for the main UK government departments, 2011 -> present, normalises each
// senior post, and emits a compact additive histogram cube + metadata that the
// static frontend loads. Node 22 built-ins only (global fetch). Fail-soft per
// file so one bad download never sinks the run.
//
//   node scripts/ingest.mjs            # full run (uses ./.cache)
//   node scripts/ingest.mjs --no-cache # force re-download
//
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  parseCSV, findCol, parseMoney, parseFTE, extractDate,
  normGrade, normProfession, isDDaT, isPolicy, payBin, BIN,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const CKAN = 'https://ckan.publishing.service.gov.uk/api/3/action/package_search';
const USE_CACHE = !process.argv.includes('--no-cache');
const CONCURRENCY = 8;

// Canonical departments and their data.gov.uk organisation slug lineage.
// Renames (clean successions) share one entity; genuine splits stay separate
// and are grouped by `family` so the UI can show them together honestly.
const DEPARTMENTS = [
  { id: 'CO',    name: 'Cabinet Office',                                   family: 'Centre',            slugs: ['cabinet-office'] },
  { id: 'HMT',   name: 'HM Treasury',                                      family: 'Economy',           slugs: ['hm-treasury'] },
  { id: 'HMRC',  name: 'HM Revenue & Customs',                             family: 'Economy',           slugs: ['hm-revenue-and-customs'] },
  { id: 'DFE',   name: 'Department for Education',                         family: 'Domestic',          slugs: ['department-for-education', 'department-of-education'] },
  { id: 'DHSC',  name: 'Department of Health & Social Care',               family: 'Domestic',          slugs: ['department-of-health'] },
  { id: 'DWP',   name: 'Department for Work & Pensions',                   family: 'Domestic',          slugs: ['department-for-work-and-pensions'] },
  { id: 'MOD',   name: 'Ministry of Defence',                             family: 'Security',          slugs: ['ministry-of-defence'] },
  { id: 'MOJ',   name: 'Ministry of Justice',                             family: 'Security',          slugs: ['ministry-of-justice'] },
  { id: 'HO',    name: 'Home Office',                                     family: 'Security',          slugs: ['home-office'] },
  { id: 'FCDO',  name: 'Foreign, Commonwealth & Development Office',       family: 'International',      slugs: ['foreign-commonwealth-and-development-office'] },
  { id: 'FCO',   name: 'Foreign & Commonwealth Office (pre-2020)',         family: 'International',      slugs: ['foreign-and-commonwealth-office'] },
  { id: 'DFID',  name: 'Dept for International Development (pre-2020)',     family: 'International',      slugs: ['department-for-international-development'] },
  { id: 'DFT',   name: 'Department for Transport',                         family: 'Domestic',          slugs: ['department-for-transport'] },
  { id: 'DEFRA', name: 'Dept for Environment, Food & Rural Affairs',       family: 'Domestic',          slugs: ['department-for-environment-food-and-rural-affairs'] },
  { id: 'DBT',   name: 'Department for Business & Trade',                  family: 'Business/Energy/Sci',slugs: ['department-for-business-and-trade'] },
  { id: 'BEIS',  name: 'Dept for Business, Energy & Ind. Strategy (2016-23)', family: 'Business/Energy/Sci', slugs: ['department-for-business-energy-and-industrial-strategy'] },
  { id: 'BIS',   name: 'Dept for Business, Innovation & Skills (2009-16)', family: 'Business/Energy/Sci',slugs: ['department-for-business-innovation-and-skills'] },
  { id: 'DIT',   name: 'Dept for International Trade (2016-23)',           family: 'Business/Energy/Sci',slugs: ['department-for-international-trade'] },
  { id: 'DECC',  name: 'Dept of Energy & Climate Change (2008-16)',        family: 'Business/Energy/Sci',slugs: ['department-of-energy-and-climate-change'] },
  { id: 'DESNZ', name: 'Dept for Energy Security & Net Zero',             family: 'Business/Energy/Sci',slugs: ['department-for-energy-security-and-net-zero'] },
  { id: 'DSIT',  name: 'Dept for Science, Innovation & Technology',        family: 'Business/Energy/Sci',slugs: ['department-for-science-innovation-and-technology'] },
  { id: 'DCMS',  name: 'Department for Culture, Media & Sport',            family: 'Domestic',          slugs: ['department-for-culture-media-and-sport'] },
  { id: 'DCLG',  name: 'Communities & Local Govt / MHCLG',                 family: 'Domestic',          slugs: ['department-for-communities-and-local-government'] },
  { id: 'AGO',   name: "Attorney General's Office",                        family: 'Security',          slugs: ['attorney-generals-office'] },
  { id: 'WO',    name: 'Office of the Secretary of State for Wales',       family: 'Territorial',       slugs: ['wales-office'] },
  { id: 'SO',    name: 'Office of the Secretary of State for Scotland',    family: 'Territorial',       slugs: ['scotland-office'] },
];

// ONS CPIH annual index (2015 = 100), series L522 (dataset MM23), used to put
// pay in constant 2015 prices for the real-terms view. Fetched live with this
// documented fallback if the ONS API is unreachable during a build.
const CPIH_FALLBACK = {
  2010: 88.6, 2011: 92.6, 2012: 95.0, 2013: 97.1, 2014: 98.5, 2015: 100.0,
  2016: 101.0, 2017: 103.6, 2018: 106.0, 2019: 107.8, 2020: 108.9, 2021: 111.6,
  2022: 120.5, 2023: 128.9, 2024: 132.5, 2025: 136.4, 2026: 139.5,
};

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'scs-earnings-ingest/1.0' } });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(500 * (t + 1));
  }
  return null;
}

async function fetchText(url, tries = 3) {
  const key = createHash('sha1').update(url).digest('hex') + '.csv';
  const cachePath = path.join(CACHE, key);
  if (USE_CACHE) {
    try { const s = await stat(cachePath); if (s.size > 0) return await readFile(cachePath, 'utf8'); } catch {}
  }
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'scs-earnings-ingest/1.0' } });
      if (res.ok) {
        const txt = await res.text();
        await writeFile(cachePath, txt).catch(() => {});
        return txt;
      }
    } catch { /* retry */ }
    await sleep(500 * (t + 1));
  }
  return null;
}

// discover senior CSV resources for one dept (across all its org slugs/packages)
async function discoverSenior(dept) {
  const found = [];
  for (const slug of dept.slugs) {
    const url = `${CKAN}?q=organogram&fq=organization:${encodeURIComponent(slug)}&rows=50`;
    const j = await getJSON(url);
    const pkgs = j?.result?.results || [];
    for (const pkg of pkgs) {
      for (const r of (pkg.resources || [])) {
        const u = r.url || '';
        if (!/\.csv(\?|$)/i.test(u)) continue;
        if (!/senior/i.test(u) && !/senior/i.test(r.name || '')) continue;
        if (/junior/i.test(u)) continue;
        const date = extractDate(u);
        if (!date) continue;
        found.push({ url: u, date });
      }
    }
  }
  // dedupe by snapshot date, keep first (we re-check row counts after parse)
  const byDate = new Map();
  for (const f of found) if (!byDate.has(f.date)) byDate.set(f.date, f);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// parse one senior CSV -> array of normalised posts
function parsePosts(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const cGrade = findCol(headers, ['grade equivalent', 'grade', 'scs grade']);
  const cTitle = findCol(headers, ['job title', 'post title', 'title']);
  const cGroup = findCol(headers, ['professional occupational group', 'profession', 'occupational group']);
  const cFloor = findCol(headers, ['actual pay floor', 'pay floor', 'payscale minimum', 'salary min']);
  const cCeil = findCol(headers, ['actual pay ceiling', 'pay ceiling', 'payscale maximum', 'salary max']);
  const cFTE = findCol(headers, ['fte']);
  const cValid = findCol(headers, ['valid']);
  if (cFloor < 0 && cCeil < 0) return []; // not a recognisable senior sheet
  const posts = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 3) continue;
    // skip rows explicitly flagged invalid
    if (cValid >= 0) {
      const v = String(row[cValid] || '').trim().toLowerCase();
      if (v === '0' || v === 'no' || v === 'n' || v === 'false') continue;
    }
    const floor = parseMoney(cFloor >= 0 ? row[cFloor] : '');
    const ceil = parseMoney(cCeil >= 0 ? row[cCeil] : '');
    let mid;
    if (Number.isFinite(floor) && Number.isFinite(ceil) && floor > 0 && ceil > 0) mid = (floor + ceil) / 2;
    else if (Number.isFinite(ceil) && ceil > 0) mid = ceil;
    else if (Number.isFinite(floor) && floor > 0) mid = floor;
    else continue;
    if (mid < 30000 || mid > 800000) continue; // implausible / non-salary rows
    const title = cTitle >= 0 ? row[cTitle] : '';
    const grade = normGrade(cGrade >= 0 ? row[cGrade] : '');
    const prof = normProfession(cGroup >= 0 ? row[cGroup] : '', title);
    posts.push({
      grade, prof,
      ddat: isDDaT(prof, title) ? 1 : 0,
      pol: isPolicy(prof, title) ? 1 : 0,
      mid, floor: Number.isFinite(floor) ? floor : null, ceil: Number.isFinite(ceil) ? ceil : null,
      fte: parseFTE(cFTE >= 0 ? row[cFTE] : ''),
      title: String(title || '').slice(0, 160),
    });
  }
  return posts;
}

// simple concurrency-limited map
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchCPIH() {
  // ONS timeseries API: L522 = CPIH INDEX 00: ALL ITEMS 2015=100
  const j = await getJSON('https://api.ons.gov.uk/timeseries/L522/dataset/MM23/data');
  const years = j?.years;
  if (Array.isArray(years) && years.length) {
    const idx = {};
    for (const y of years) { const yr = +y.year; const v = +y.value; if (yr && Number.isFinite(v)) idx[yr] = v; }
    if (Object.keys(idx).length > 5) { log(`  CPIH: fetched ${Object.keys(idx).length} annual points from ONS`); return { index: idx, source: 'ONS MM23/L522 (live)' }; }
  }
  log('  CPIH: using documented fallback table');
  return { index: { ...CPIH_FALLBACK }, source: 'ONS MM23/L522 (fallback table)' };
}

async function main() {
  const t0 = Date.now();
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });

  log('== SCS earnings ingestion ==');
  log(`departments: ${DEPARTMENTS.length}  cache: ${USE_CACHE ? 'on' : 'off'}`);

  // 1. discover
  log('\n[1/4] discovering senior resources ...');
  const discovered = [];
  for (const dept of DEPARTMENTS) {
    const res = await discoverSenior(dept);
    log(`  ${dept.id.padEnd(6)} ${String(res.length).padStart(3)} snapshots  ${res.length ? res[0].date + ' -> ' + res[res.length - 1].date : '(none)'}`);
    for (const r of res) discovered.push({ dept, ...r });
  }
  log(`  total senior files: ${discovered.length}`);

  // 2. fetch + parse (concurrency limited)
  log('\n[2/4] downloading + parsing ...');
  let ok = 0, fail = 0, totalPosts = 0;
  const parsed = await mapLimit(discovered, CONCURRENCY, async (d) => {
    const txt = await fetchText(d.url);
    if (!txt) { fail++; return null; }
    const posts = parsePosts(txt);
    if (!posts.length) { fail++; return null; }
    ok++; totalPosts += posts.length;
    return { deptId: d.dept.id, date: d.date, posts };
  });
  log(`  parsed ok=${ok} fail=${fail}  posts=${totalPosts}`);

  // dedupe (deptId,date) keeping the version with the most posts
  const best = new Map();
  for (const p of parsed) {
    if (!p) continue;
    const k = p.deptId + '|' + p.date;
    const cur = best.get(k);
    if (!cur || p.posts.length > cur.posts.length) best.set(k, p);
  }
  const snapshots = [...best.values()];

  // 3. build dictionaries + cube
  log('\n[3/4] aggregating cube ...');
  const dates = [...new Set(snapshots.map(s => s.date))].sort();
  const usedDeptIds = [...new Set(snapshots.map(s => s.deptId))];
  const depts = DEPARTMENTS.filter(d => usedDeptIds.includes(d.id));
  const profSet = new Set(), gradeSet = new Set();
  for (const s of snapshots) for (const p of s.posts) { profSet.add(p.prof); gradeSet.add(p.grade); }
  const profs = [...profSet].sort();
  const grades = ['SCS4 / Perm Sec', 'SCS3 (Dir Gen)', 'SCS2 (Dir)', 'SCS1 (Dep Dir)', 'SCS (band n/s)', 'Other / Not stated'].filter(g => gradeSet.has(g));

  const di = new Map(dates.map((d, i) => [d, i]));
  const depi = new Map(depts.map((d, i) => [d.id, i]));
  const pri = new Map(profs.map((p, i) => [p, i]));
  const gri = new Map(grades.map((g, i) => [g, i]));

  // cell key -> {n, fte, sumMid, bill, hist:Map<bin,count>}
  const cells = new Map();
  const notable = []; // perm secs + >=150k individual posts, for narrative features
  for (const s of snapshots) {
    const dIdx = di.get(s.date), deptIdx = depi.get(s.deptId);
    for (const p of s.posts) {
      const key = `${dIdx}|${deptIdx}|${pri.get(p.prof)}|${gri.get(p.grade)}|${p.ddat}|${p.pol}`;
      let c = cells.get(key);
      if (!c) { c = { n: 0, fte: 0, sumMid: 0, bill: 0, hist: new Map() }; cells.set(key, c); }
      c.n++; c.fte += p.fte; c.sumMid += p.mid; c.bill += p.mid * p.fte;
      const b = payBin(p.mid); c.hist.set(b, (c.hist.get(b) || 0) + 1);
      if (p.grade === 'SCS4 / Perm Sec' || p.mid >= 150000) {
        notable.push({ dept: s.deptId, date: s.date, grade: p.grade, prof: p.prof,
          ddat: p.ddat, pol: p.pol, title: p.title, floor: p.floor, ceil: p.ceil, mid: Math.round(p.mid) });
      }
    }
  }

  // serialise cube cells as compact arrays
  const cubeRows = [];
  for (const [key, c] of cells) {
    const [dIdx, deptIdx, prIdx, grIdx, ddat, pol] = key.split('|').map(Number);
    const hist = [...c.hist.entries()].sort((a, b) => a[0] - b[0]);
    cubeRows.push([dIdx, deptIdx, prIdx, grIdx, ddat, pol, c.n, Math.round(c.fte * 10) / 10, Math.round(c.sumMid), Math.round(c.bill), hist.flat()]);
  }

  const cpih = await fetchCPIH();

  // coverage: per dept, list of date indices present
  const coverage = {};
  for (const d of depts) coverage[d.id] = [];
  for (const s of snapshots) coverage[s.deptId].push(di.get(s.date));
  for (const k of Object.keys(coverage)) coverage[k].sort((a, b) => a - b);

  const meta = {
    generated: new Date().toISOString(),
    source: {
      name: 'gov.uk organogram of staff roles & salaries (senior posts)',
      via: 'data.gov.uk CKAN',
      note: 'Pay shown as £5,000 bands below £150k and individually at/above £150k; figures are the band midpoint. Snapshots are twice-yearly transparency releases (nominally 31 March / 30 September, plus later ad-hoc dates).',
    },
    binWidth: BIN,
    dates, depts, profs, grades,
    coverage,
    cpih,
    stats: {
      departments: depts.length, snapshots: snapshots.length, cells: cubeRows.length,
      posts: snapshots.reduce((a, s) => a + s.posts.length, 0),
      dateRange: [dates[0], dates[dates.length - 1]],
      filesOk: ok, filesFail: fail,
    },
  };

  // 4. write
  log('\n[4/4] writing data ...');
  await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta));
  await writeFile(path.join(OUT, 'cube.json'), JSON.stringify({ rows: cubeRows }));
  await writeFile(path.join(OUT, 'notable.json'), JSON.stringify({ posts: notable }));
  const sizes = {};
  for (const f of ['meta.json', 'cube.json', 'notable.json']) sizes[f] = (await stat(path.join(OUT, f))).size;

  log('\n== done ==');
  log(`  departments covered : ${depts.length}`);
  log(`  snapshots           : ${snapshots.length}`);
  log(`  date range          : ${dates[0]} -> ${dates[dates.length - 1]}`);
  log(`  professions          : ${profs.length}  grades: ${grades.length}`);
  log(`  cube cells          : ${cubeRows.length}`);
  log(`  posts (total)       : ${meta.stats.posts}`);
  log(`  notable records     : ${notable.length}`);
  log(`  output sizes (KB)   : ${Object.entries(sizes).map(([k, v]) => k + '=' + Math.round(v / 1024)).join('  ')}`);
  log(`  elapsed             : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
