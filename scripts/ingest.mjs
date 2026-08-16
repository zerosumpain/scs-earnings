// SCS earnings ingestion pipeline.
//
// Gathers every published "senior" organogram CSV (gov.uk transparency data)
// for the UK government departments and the wider senior public sector,
// 2010 -> present, normalises every published post row, and emits the additive
// cubes + per-organisation post shards the static frontend loads. Node 22
// built-ins only (global fetch). Fail-soft per file so one bad download never
// sinks a run — but hard-fail on the signatures that mean the corpus itself is
// wrong, because a silent partial run is indistinguishable from success.
//
// Four rules this pipeline exists to enforce:
//   1. The discovery unit is (package, resolved reference date), never
//      (department, date). MOD publishes under eight sibling packages; keying
//      on date alone let the Royal Navy Museums displace the department.
//   2. Every published post row is kept, disclosed pay or not. Two thirds of
//      senior posts have their pay withheld and withholding is grade-dependent,
//      so dropping them inverts the grade mix and lifts every median.
//   3. success:true + count:0 from CKAN means a rename, not an absence. It is
//      fatal. It has already cost DBT a full department once.
//   4. Two runs from cache must produce byte-identical output.
//
//   node scripts/ingest.mjs                       # Tier A + Tier B
//   node scripts/ingest.mjs --tier A              # departments only
//   node scripts/ingest.mjs --only DWP,HMT,WO     # named organisations
//   node scripts/ingest.mjs --max-files 40        # cap downloads (cheap test)
//   node scripts/ingest.mjs --dry-run             # discover + parse, write nothing
//   node scripts/ingest.mjs --no-cache            # force re-download
//
import { mkdir, writeFile, readFile, stat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  parsePosts, sniffBinary, decodeBody, resolveReferenceDate,
  GRADE_BANDS, PROFESSIONS, POST_STATUSES, BIN,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const SHARD_DIR = path.join(OUT, 'posts');
const MANIFEST = path.join(ROOT, 'data', 'manifest.json');
const CKAN_ROOT = 'https://ckan.publishing.service.gov.uk/api/3/action';
const UA = 'scs-earnings-ingest/2.0 (+https://strangeramblings.com)';
const CONCURRENCY = 8;
const FETCH_TIMEOUT = 30000;
const REVALIDATE_MONTHS = 18;
const CHANGELOG_CAP = 60;
// Schema 2: the cubes and the snapshot registry are columnar. Schema 1 shipped
// the cubes as one array per cell and the registry as one object per snapshot,
// which put 92.1 KB gz into a 70 KB first paint once the corpus reached 185,926
// post rows. See docs/DATA-CONTRACT.md sections 2.3 and 3.
const SCHEMA = 2;

// The three ways a snapshot's reference date can be resolved, weakest last.
// Shipped as a dictionary because the snapshot registry indexes into it.
const REF_CONFIDENCES = ['declared', 'inferred', 'default'];

// ---- CLI ------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(name);
const opt = (name, dflt = null) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};
const USE_CACHE = !flag('--no-cache');
const DRY_RUN = flag('--dry-run');
const ONLY = (opt('--only') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const TIER = (opt('--tier', 'all') || 'all').toUpperCase();
const MAX_FILES = Number(opt('--max-files', '0')) || 0;
const PARTIAL = ONLY.length > 0 || TIER !== 'ALL' || MAX_FILES > 0;

// ---- organisation registry -------------------------------------------------
// Tier A: the SCS spine — ministerial departments and their agencies.
// Tier B: the wider senior public sector. Ingested and shipped, but it maps
//   internal bands onto SCS-EQUIVALENTS, so it is never summed into an "SCS"
//   figure. Kept behind a hard tier boundary rather than dropped: these bodies
//   are actually cleaner on grade than the departments, so the objection is
//   employer identity, not data quality. The 77-organisation long tail of
//   fewer than ten paid posts each is excluded entirely.
//
// validFrom/validTo + predecessors/successors exist so a predecessor is never
// summed with its successor: in 2023 the corpus holds BEIS, DESNZ, DSIT and
// DBT simultaneously, and an all-departments total double-counts unless the
// lineage is honoured.
//
// TRAP: never trust a CKAN organisation title. `department-of-education` is
// titled "Department of Education (Northern Ireland)" but its files are
// England's DfE (verified via "Secretary of State", the 0370 000 2288 contact
// number and CYPFD directorates). Check `Parent Department` inside the CSV.
const ORGS = [
  // --- Tier A -------------------------------------------------------------
  org('CO',    'Cabinet Office',                                    'A', 'Centre',        ['cabinet-office']),
  org('HMT',   'HM Treasury',                                       'A', 'Economy',       ['hm-treasury']),
  org('HMRC',  'HM Revenue & Customs',                              'A', 'Economy',       ['hm-revenue-and-customs']),
  org('DFE',   'Department for Education',                          'A', 'Domestic',      ['department-for-education', 'department-of-education']),
  org('DHSC',  'Department of Health & Social Care',                'A', 'Domestic',      ['department-of-health']),
  org('DWP',   'Department for Work & Pensions',                    'A', 'Domestic',      ['department-for-work-and-pensions']),
  // MOD's CKAN slug carries eight sibling packages, and three of them are
  // national museums — NDPBs whose staff are not Senior Civil Service. Summed
  // in, they put 354 rows across 40 of 46 MOD snapshots under the label
  // "Ministry of Defence". They are excluded here and re-registered as Tier B
  // bodies below, so the data is kept and simply stops being counted as MOD.
  org('MOD',   'Ministry of Defence',                               'A', 'Security',      ['ministry-of-defence'], {
    excludePackages: [
      'organogram-national-army-museum',
      'organogram-royal-air-force-museum',
      'organogram-the-royal-navy-museums',
    ],
  }),
  org('MOJ',   'Ministry of Justice',                               'A', 'Security',      ['ministry-of-justice']),
  org('HO',    'Home Office',                                       'A', 'Security',      ['home-office']),
  org('FCDO',  'Foreign, Commonwealth & Development Office',        'A', 'International', ['foreign-commonwealth-and-development-office'], { validFrom: '2020-09-02', predecessors: ['FCO', 'DFID'] }),
  org('FCO',   'Foreign & Commonwealth Office (pre-2020)',          'A', 'International', ['foreign-and-commonwealth-office'], { validTo: '2020-09-01', successors: ['FCDO'] }),
  org('DFID',  'Dept for International Development (pre-2020)',     'A', 'International', ['department-for-international-development'], { validTo: '2020-09-01', successors: ['FCDO'] }),
  org('DFT',   'Department for Transport',                          'A', 'Domestic',      ['department-for-transport']),
  org('DEFRA', 'Dept for Environment, Food & Rural Affairs',        'A', 'Domestic',      ['department-for-environment-food-and-rural-affairs']),
  // DBT's own CKAN organisation is an empty post-machinery-of-government
  // shell: `department-for-business-and-trade` answers success:true, count:0.
  // The data lives in the DIT package, which moved under the
  // business-innovation-science-and-trade organisation. Both eras share one
  // package, so the validFrom/validTo windows split it between DIT and DBT.
  org('DBT',   'Department for Business & Trade',                   'A', 'Business/Energy/Sci', ['department-for-business-and-trade', 'department-for-business-innovation-science-and-trade'], { validFrom: '2023-02-07', predecessors: ['DIT', 'BEIS'], packages: ['organogram-department-for-international-trade'] }),
  org('DIT',   'Dept for International Trade (2016-23)',            'A', 'Business/Energy/Sci', ['department-for-business-innovation-science-and-trade'], { validFrom: '2016-07-14', validTo: '2023-02-06', successors: ['DBT'], packages: ['organogram-department-for-international-trade'] }),
  org('BEIS',  'Dept for Business, Energy & Ind. Strategy (2016-23)', 'A', 'Business/Energy/Sci', ['department-for-business-energy-and-industrial-strategy'], { validFrom: '2016-07-14', validTo: '2023-02-06', predecessors: ['BIS', 'DECC'], successors: ['DBT', 'DESNZ', 'DSIT'] }),
  org('BIS',   'Dept for Business, Innovation & Skills (2009-16)',  'A', 'Business/Energy/Sci', ['department-for-business-innovation-and-skills'], { validTo: '2016-07-13', successors: ['BEIS'] }),
  org('DECC',  'Dept of Energy & Climate Change (2008-16)',         'A', 'Business/Energy/Sci', ['department-of-energy-and-climate-change'], { validTo: '2016-07-13', successors: ['BEIS'] }),
  org('DESNZ', 'Dept for Energy Security & Net Zero',               'A', 'Business/Energy/Sci', ['department-for-energy-security-and-net-zero'], { validFrom: '2023-02-07', predecessors: ['BEIS'] }),
  org('DSIT',  'Dept for Science, Innovation & Technology',         'A', 'Business/Energy/Sci', ['department-for-science-innovation-and-technology'], { validFrom: '2023-02-07', predecessors: ['BEIS'] }),
  org('DCMS',  'Department for Culture, Media & Sport',             'A', 'Domestic',      ['department-for-culture-media-and-sport']),
  org('DCLG',  'Communities & Local Govt / MHCLG',                  'A', 'Domestic',      ['department-for-communities-and-local-government']),
  org('AGO',   "Attorney General's Office",                         'A', 'Security',      ['attorney-generals-office']),
  org('WO',    'Office of the Secretary of State for Wales',        'A', 'Territorial',   ['wales-office']),
  org('SO',    'Office of the Secretary of State for Scotland',     'A', 'Territorial',   ['scotland-office']),

  // --- Tier B1: wider senior public sector, still publishing ---------------
  org('NHSBT', 'NHS Blood & Transplant',                            'B', 'Health',        ['nhs-blood-and-transplant']),
  org('UKSA',  'UK Statistics Authority',                           'B', 'Analysis',      ['uk-statistics-authority']),
  org('EA',    'Environment Agency',                                'B', 'Environment',   ['environment-agency']),
  org('HS2',   'High Speed 2',                                      'B', 'Transport',     ['high-speed-2']),
  org('ORR',   'Office of Rail & Road',                             'B', 'Transport',     ['office-of-rail-and-road']),
  org('HCA',   'Homes England (Homes & Communities Agency)',        'B', 'Housing',       ['homes-and-communities-agency']),
  org('DVSA',  'Driver & Vehicle Standards Agency',                 'B', 'Transport',     ['driver-and-vehicle-standards-agency']),
  org('IFATE', 'Institute for Apprenticeships & Technical Education', 'B', 'Education',   ['institute-for-apprenticeships-and-technical-education']),
  org('IPO',   'Intellectual Property Office',                      'B', 'Business',      ['intellectual-property-office']),
  org('UKAEA', 'UK Atomic Energy Authority',                        'B', 'Science',       ['united-kingdom-atomic-energy-authority']),
  org('VOA',   'Valuation Office Agency',                           'B', 'Economy',       ['valuation-office-agency']),
  org('TF',    'Transport Focus',                                   'B', 'Transport',     ['transport-focus']),
  org('MCA',   'Maritime & Coastguard Agency',                      'B', 'Transport',     ['maritime-and-coastguard-agency']),
  org('TH',    'Trinity House Lighthouse Service',                  'B', 'Transport',     ['trinity-house-lighthouse-service']),
  org('CPS',   'Crown Prosecution Service',                         'B', 'Justice',       ['crown-prosecution-service']),
  org('LR',    'HM Land Registry',                                  'B', 'Economy',       ['land-registry']),
  org('CCRC',  'Criminal Cases Review Commission',                  'B', 'Justice',       ['criminal-cases-review-commission']),
  org('BTPA',  'British Transport Police Authority',                'B', 'Transport',     ['british-transport-police-authority']),
  org('NLB',   'Northern Lighthouse Board',                         'B', 'Transport',     ['the-northern-lighthouse-board']),
  org('DVLA',  'Driver & Vehicle Licensing Agency',                 'B', 'Transport',     ['driver-and-vehicle-licensing-agency']),
  org('VCA',   'Vehicle Certification Agency',                      'B', 'Transport',     ['vehicle-certification-agency']),
  org('RSH',   'Regulator of Social Housing',                       'B', 'Housing',       ['regulator-of-social-housing']),
  org('ATE',   'Active Travel England',                             'B', 'Transport',     ['active-travel-england']),
  org('ACAS',  'Advisory, Conciliation & Arbitration Service',      'B', 'Business',      ['advisory-conciliation-and-arbitration-service']),
  org('PINS',  'Planning Inspectorate',                             'B', 'Housing',       ['planning-inspectorate']),
  org('CH',    'Companies House',                                   'B', 'Business',      ['companies-house']),

  // --- Tier B2: defunct bodies, historical depth only ---------------------
  org('BL',      'The British Library',                             'B', 'Culture',       ['the-british-library'], { validTo: '2099-12-31' }),
  org('NHSE',    'NHS England',                                     'B', 'Health',        ['nhs-england']),
  org('HEE',     'Health Education England',                        'B', 'Health',        ['health-education-england']),
  org('GLD',     'Government Legal Department',                     'B', 'Justice',       ['government-legal-department']),
  org('MRC',     'Medical Research Council',                        'B', 'Science',       ['medical-research-council']),
  org('MODCTLB', 'MOD Central Top Level Budget',                    'B', 'Security',      ['central-top-level-budget']),
  org('UKHSA',   'UK Health Security Agency',                       'B', 'Health',        ['uk-health-security-agency']),
  org('UKRI',    'UK Research & Innovation',                        'B', 'Science',       ['uk-research-and-innovation']),
  org('SFA',     'Skills Funding Agency',                           'B', 'Education',     ['skills-funding-agency']),
  org('CQC',     'Care Quality Commission',                         'B', 'Health',        ['care-quality-commission']),
  org('OFSTED',  'Ofsted',                                          'B', 'Education',     ['office-for-standards-in-education-childrens-services-and-skills']),
  org('NE',      'Natural England',                                 'B', 'Environment',   ['natural-england']),
  org('NOMS',    'National Offender Management Service',            'B', 'Justice',       ['national-offender-management-service']),
  org('IPCC',    'Independent Police Complaints Commission',        'B', 'Justice',       ['independent-police-complaints-commission']),
  org('SMG',     'Science Museum Group',                            'B', 'Culture',       ['science-museum-group']),
  // The three MOD-slug museums, kept as the arm's-length bodies they are.
  org('NAM',     'National Army Museum',                            'B', 'Culture',       [], { packages: ['organogram-national-army-museum'] }),
  org('RAFM',    'Royal Air Force Museum',                          'B', 'Culture',       [], { packages: ['organogram-royal-air-force-museum'] }),
  org('NMRN',    'National Museum of the Royal Navy',                'B', 'Culture',       [], { packages: ['organogram-the-royal-navy-museums'] }),
  org('NERC',    'Natural Environment Research Council',            'B', 'Science',       ['natural-environment-research-council']),
  org('HMIC',    'HM Inspectorate of Constabulary',                 'B', 'Justice',       ['hm-inspectorate-of-constabulary']),
  org('CMA',     'Competition & Markets Authority',                 'B', 'Business',      ['competition-and-markets-authority']),
  org('AC',      'Audit Commission',                                'B', 'Local',         ['audit-commission']),
  org('STA',     'Standards & Testing Agency',                      'B', 'Education',     ['standards-and-testing-agency']),
  org('FC',      'Forestry Commission',                             'B', 'Environment',   ['forestry-commission']),
  org('MONITOR', 'Monitor',                                         'B', 'Health',        ['monitor']),
  org('SLC',     'Student Loans Company',                           'B', 'Education',     ['student-loans-company-limited']),
];

function org(id, name, tier, family, ckanOrgs, extra = {}) {
  return {
    id, name, tier, family, ckanOrgs,
    packages: extra.packages || [],
    // Packages that sit under this organisation's CKAN slug but are NOT part of
    // it. Claiming a whole CKAN organisation is right for most departments and
    // wrong for MOD, whose slug also carries three national museums.
    excludePackages: extra.excludePackages || [],
    validFrom: extra.validFrom || null,
    validTo: extra.validTo || null,
    predecessors: extra.predecessors || [],
    successors: extra.successors || [],
  };
}

// CKAN organisations that legitimately hold zero packages. Every other
// success:true + count:0 is a rename and is fatal.
const KNOWN_EMPTY_SLUGS = new Map([
  ['department-for-business-and-trade',
   'post-2023 MoG shell; the data stayed in organogram-department-for-international-trade'],
]);

// ONS CPIH annual index (2015 = 100), series L522 (dataset MM23). Regenerated
// 2026-08 from the live series. There is deliberately NO 2026 row: ONS
// publishes no 2026 annual figure, and the previous table invented one, so
// every real-terms figure on a page whose selling point is provenance was
// deflated by a partly fabricated index. A run that falls back to this table
// says so in meta.json, in the changelog and on stdout.
const CPIH_FALLBACK = {
  2010: 90.1, 2011: 93.6, 2012: 96.0, 2013: 98.2, 2014: 99.6, 2015: 100.0,
  2016: 101.0, 2017: 103.6, 2018: 106.0, 2019: 107.8, 2020: 108.9, 2021: 111.6,
  2022: 120.5, 2023: 128.6, 2024: 132.9, 2025: 138.0,
};

const CPIH_URL = 'https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/l522/mm23/data';

// Floor assertions for a full-scope run. Below any of these the corpus is
// broken, not small: refuse to promote the output. Current values are
// 1,483 snapshots / 62,846 disclosed posts / 78 organisations / 251 dates, so
// these are a catastrophe guard and nothing finer. Relative movement — a
// department halving between two runs — is scripts/datadiff.mjs's job.
const FLOORS = { snapshots: 500, posts: 40000, orgs: 24, dates: 160 };

const log = (...a) => console.log(...a);
const warn = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

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

// Fetch one resource body as bytes, with an 18-month revalidation window:
// anything older than that is immutable in practice, anything newer is
// revalidated against the stored ETag / Last-Modified so a corrected
// re-publication at the same URL is picked up.
async function fetchBody(url, refDate, tries = 3) {
  const key = sha1(url);
  const bodyPath = path.join(CACHE, key + '.csv');
  const metaPath = path.join(CACHE, key + '.meta.json');
  let cached = null, validators = null;
  if (USE_CACHE) {
    try {
      const s = await stat(bodyPath);
      if (s.size > 0) cached = await readFile(bodyPath);
    } catch { /* no cache */ }
    try { validators = JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* none */ }
  }
  const fresh = refDate ? monthsSince(refDate) < REVALIDATE_MONTHS : true;
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

function monthsSince(isoDate) {
  const then = Date.parse(isoDate + 'T00:00:00Z');
  if (!Number.isFinite(then)) return 999;
  return (Date.now() - then) / (1000 * 60 * 60 * 24 * 30.44);
}

// ---- CKAN discovery --------------------------------------------------------
// rows=50 with no paging silently truncated discovery. Page properly and
// assert the retrieved count matches the reported one.
async function searchOrgPackages(slug) {
  const results = [];
  let start = 0, count = null;
  while (true) {
    const url = `${CKAN_ROOT}/package_search?q=organogram&fq=organization:${encodeURIComponent(slug)}&rows=100&start=${start}`;
    const j = await getJSON(url);
    if (!j || j.__status === 404) return { ok: false, count: 0, results: [], status: j?.__status ?? 'error' };
    if (!j.success) return { ok: false, count: 0, results: [], status: 'not-success' };
    count = j.result.count;
    const page = j.result.results || [];
    results.push(...page);
    start += page.length;
    if (page.length === 0 || results.length >= count) break;
    await sleep(120);
  }
  return { ok: true, count, results, status: 'ok' };
}

async function packageShow(name) {
  const j = await getJSON(`${CKAN_ROOT}/package_show?id=${encodeURIComponent(name)}`);
  if (!j || j.__status === 404 || !j.success) return null;
  return j.result;
}

const isCsvResource = (r) => /\.csv(\?|$)/i.test(r.url || '') || String(r.format || '').toUpperCase() === 'CSV';
const looksSenior = (r) => {
  const hay = decodeURIComponent(String(r.url || '')) + ' ' + String(r.name || '');
  if (/junior/i.test(hay)) return false;
  return /senior/i.test(hay);
};

// Which registry organisations claim a given CKAN organisation or package.
// Only when more than one claims it does the validFrom/validTo window decide;
// that is the DIT/DBT case, where one package carries both eras.
function buildClaims(orgs) {
  const byOrgSlug = new Map(), byPackage = new Map();
  for (const o of orgs) {
    for (const s of o.ckanOrgs) push(byOrgSlug, s, o.id);
    for (const p of o.packages) push(byPackage, p, o.id);
  }
  return { byOrgSlug, byPackage };
  function push(m, k, v) { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(v)) m.get(k).push(v); }
}

function inWindow(o, date) {
  if (o.validFrom && date < o.validFrom) return false;
  if (o.validTo && date > o.validTo) return false;
  return true;
}

async function discover(orgs, ctx, previous) {
  const claims = buildClaims(orgs);
  const out = [];
  for (const o of orgs) {
    const packages = new Map();
    for (const slug of o.ckanOrgs) {
      const res = await searchOrgPackages(slug);
      await sleep(120);
      if (!res.ok) {
        ctx.slugErrors.push({ org: o.id, slug, status: res.status });
        continue;
      }
      if (res.count === 0) {
        const known = KNOWN_EMPTY_SLUGS.get(slug);
        ctx.emptySlugs.push({ org: o.id, slug, known: !!known, note: known || null });
        continue;
      }
      if (res.results.length !== res.count) {
        fatal(`CKAN paging mismatch for ${slug}: reported ${res.count}, retrieved ${res.results.length}`);
      }
      for (const p of res.results) {
        // A package this organisation explicitly disowns (see excludePackages)
        // belongs to somebody else in the registry; claiming it here is how
        // three museums ended up inside MOD's headcount.
        if (o.excludePackages.includes(p.name)) {
          ctx.disowned.push({ org: o.id, pkg: p.name, viaSlug: slug });
          continue;
        }
        packages.set(p.name, p);
      }
    }
    for (const name of o.packages) {
      if (packages.has(name)) continue;
      const p = await packageShow(name);
      await sleep(120);
      if (!p) { ctx.slugErrors.push({ org: o.id, slug: name, status: 'package-show-failed' }); continue; }
      packages.set(p.name, p);
    }

    const resources = [];
    for (const p of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const shared = (claims.byPackage.get(p.name) || []).length > 1
        || (claims.byOrgSlug.get(p.organization?.name) || []).length > 1;
      for (const r of (p.resources || [])) {
        if (!isCsvResource(r) || !looksSenior(r)) continue;
        const resolved = resolveReferenceDate(r.url, p.name, p.title, r.created, r.name);
        if (!resolved.referenceDate) { ctx.undated.push({ org: o.id, pkg: p.name, url: r.url }); continue; }
        if (shared && !inWindow(o, resolved.referenceDate)) continue;
        if (!shared && !inWindow(o, resolved.referenceDate)) {
          ctx.outOfWindow.push({ org: o.id, date: resolved.referenceDate, url: r.url });
        }
        resources.push({
          orgId: o.id, pkg: p.name, pkgTitle: p.title || '', url: r.url,
          resourceName: r.name || '', created: r.created || '', lastModified: r.last_modified || '',
          referenceDate: resolved.referenceDate, confidence: resolved.confidence, basis: resolved.basis,
        });
      }
    }

    // Within a package, one reference date can carry several uploads (47
    // department-date pairs do, and 117 resources used to be discarded at
    // random by CKAN result order). The latest `created` wins. The losers are
    // kept as ranked alternates, not deleted: if the winner turns out to be
    // unparseable the next one is tried, which is what the old "keep the
    // version with most posts" re-check was meant to do before the
    // alternatives were thrown away ahead of it.
    const byKey = new Map();
    for (const r of resources) {
      const k = r.pkg + '|' + r.referenceDate;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    const picked = [];
    for (const list of byKey.values()) {
      list.sort((a, b) => (b.created + b.url).localeCompare(a.created + a.url));
      const [winner, ...alternates] = list;
      for (const a of alternates) {
        ctx.rejectedSiblings.push({ org: o.id, pkg: a.pkg, date: a.referenceDate, url: a.url, reason: 'older-upload' });
      }
      picked.push({ ...winner, alternates });
    }
    picked.sort(cmpResource);
    if (picked.length === 0) {
      // Zero resources for an organisation that had them is the signature of a
      // CKAN rename, not of an absence, and it is fatal. Tier B bodies with no
      // baseline in the manifest have never been proven to publish anything,
      // so on a first run they are a warning and are dropped.
      const hadBefore = (previous?.resources?.[o.id] || []).length > 0;
      if (o.tier === 'A' || hadBefore) {
        fatal(`${o.id}: discovery found no senior resources${hadBefore ? ` (the last run found ${previous.resources[o.id].length})` : ''}.\n`
          + `  A CKAN organisation rename presents exactly like this — success:true, count:0.\n`
          + `  Check organization_show for ${o.ckanOrgs.join(', ')} and add the successor slug,\n`
          + '  or declare the package name directly in the registry.');
      }
      warn.push(`${o.id}: no senior resources found (tier B, no baseline) — organisation dropped from this run`);
      log(`  ${o.id.padEnd(8)}   0 files  (dropped: no senior resources, no baseline)`);
      continue;
    }
    const dates = picked.map(r => r.referenceDate);
    log(`  ${o.id.padEnd(8)} ${String(picked.length).padStart(3)} files  ${packages.size} pkg  ${dates[0]} -> ${dates[dates.length - 1]}`);
    out.push(...picked);
  }
  return out.sort(cmpResource);
}

const cmpResource = (a, b) =>
  a.orgId.localeCompare(b.orgId) || a.referenceDate.localeCompare(b.referenceDate)
  || a.pkg.localeCompare(b.pkg) || a.url.localeCompare(b.url);

// ---- concurrency -----------------------------------------------------------
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

// ---- CPIH ------------------------------------------------------------------
async function fetchCPIH() {
  const j = await getJSON(CPIH_URL);
  const years = j?.years;
  if (Array.isArray(years) && years.length) {
    const index = {};
    for (const y of years) {
      const yr = +y.year, v = +y.value;
      if (yr >= 2000 && Number.isFinite(v)) index[yr] = v;
    }
    if (Object.keys(index).length > 5) {
      log(`  CPIH: ${Object.keys(index).length} annual points from ONS (live)`);
      return { index, source: 'ONS MM23/L522 (live)', live: true, url: CPIH_URL, warning: null };
    }
  }
  const msg = 'CPIH fell back to the built-in table — real-terms figures are not from a live ONS read';
  warn.push(msg);
  log(`  CPIH: ${msg}`);
  return {
    index: { ...CPIH_FALLBACK },
    source: 'ONS MM23/L522 (built-in fallback table, regenerated 2026-08)',
    live: false, url: CPIH_URL, warning: msg,
  };
}

// ---- dictionary helper -----------------------------------------------------
function dictionary() {
  const map = new Map();
  return {
    id(v) {
      const s = v == null || v === '' ? null : String(v);
      if (s === null) return -1;
      if (!map.has(s)) map.set(s, map.size);
      return map.get(s);
    },
    values() { return [...map.keys()]; },
    size() { return map.size; },
  };
}

// ---- main ------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  // One wall clock for the whole run, so the changelog entry and the build
  // stamp in meta.json cannot disagree by a few milliseconds.
  const runAt = new Date().toISOString();
  await mkdir(CACHE, { recursive: true });

  if (ONLY.length) {
    const missing = ONLY.filter(id => !ORGS.some(o => o.id === id));
    if (missing.length) fatal(`unknown organisation id(s): ${missing.join(', ')}`);
  }
  const selected = ORGS.filter(o =>
    (TIER === 'ALL' || o.tier === TIER) && (ONLY.length === 0 || ONLY.includes(o.id)));
  if (!selected.length) fatal(`no organisations selected (tier=${TIER} only=${ONLY.join(',') || '-'})`);

  log('== SCS earnings ingestion ==');
  log(`organisations: ${selected.length}  tier: ${TIER}  cache: ${USE_CACHE ? 'on' : 'off'}`
    + `${ONLY.length ? '  only: ' + ONLY.join(',') : ''}${MAX_FILES ? '  max-files: ' + MAX_FILES : ''}`
    + `${DRY_RUN ? '  DRY RUN' : ''}`);

  // 1. discover
  log('\n[1/5] discovering senior resources ...');
  const previousManifest = await readJSON(MANIFEST);
  const ctx = { emptySlugs: [], slugErrors: [], undated: [], rejectedSiblings: [], outOfWindow: [], disowned: [], crossPartDupes: [] };
  let discovered = await discover(selected, ctx, previousManifest);
  log(`  resources: ${discovered.length}  undated skipped: ${ctx.undated.length}`
    + `  rejected siblings: ${ctx.rejectedSiblings.length}`);
  for (const e of ctx.emptySlugs) {
    log(`  NOTE  empty CKAN slug ${e.slug} (${e.org})${e.known ? ' — known: ' + e.note : ''}`);
    if (!e.known) warn.push(`CKAN slug ${e.slug} returned count:0 for ${e.org}`);
  }
  for (const e of ctx.slugErrors) warn.push(`CKAN lookup failed: ${e.slug} (${e.org}) ${e.status}`);
  if (MAX_FILES && discovered.length > MAX_FILES) {
    log(`  capping at --max-files ${MAX_FILES}`);
    discovered = discovered.slice(0, MAX_FILES);
  }

  // 2. fetch + parse
  log('\n[2/5] downloading + parsing ...');
  let ok = 0, fail = 0, binary = 0;
  const failures = [];
  const parsed = await mapLimit(discovered, CONCURRENCY, async (d) => {
    for (const candidate of [d, ...(d.alternates || [])]) {
      const { buf, mode } = await fetchBody(candidate.url, candidate.referenceDate);
      if (!buf) { fail++; failures.push({ ...candidate, reason: 'download-failed' }); continue; }
      const kind = sniffBinary(buf);
      if (kind) {
        // A binary served under a .csv URL. Verified live: a DfE 2012 "csv"
        // is a PDF, and two S3 resources are OOXML.
        fail++; binary++;
        failures.push({ ...candidate, reason: 'binary:' + kind });
        continue;
      }
      const res = parsePosts(decodeBody(buf));
      if (!res.ok) { fail++; failures.push({ ...candidate, reason: res.reason }); continue; }
      ok++;
      return {
        ...candidate, mode, bytes: buf.length, sha: sha256(buf),
        rows: res.stats.dataRows, stats: res.stats, posts: res.posts,
      };
    }
    return null;
  });
  const files = parsed.filter(Boolean).sort(cmpResource);
  const totalPosts = files.reduce((a, f) => a + f.posts.length, 0);
  log(`  files ok=${ok} fail=${fail} (binary=${binary})  post rows=${totalPosts}`);
  const byReason = new Map();
  for (const f of failures) byReason.set(f.reason, (byReason.get(f.reason) || 0) + 1);
  for (const [r, c] of [...byReason.entries()].sort()) log(`    reject ${r}: ${c}`);

  // 3. snapshots: (org, reference date), summing sibling packages
  log('\n[3/5] assembling snapshots ...');
  const snapMap = new Map();
  for (const f of files) {
    const k = f.orgId + '|' + f.referenceDate;
    if (!snapMap.has(k)) snapMap.set(k, { orgId: f.orgId, date: f.referenceDate, parts: [] });
    snapMap.get(k).parts.push(f);
  }
  const snapshots = [...snapMap.values()].sort((a, b) =>
    a.orgId.localeCompare(b.orgId) || a.date.localeCompare(b.date));
  for (const s of snapshots) s.parts.sort((a, b) => a.pkg.localeCompare(b.pkg));

  // Summing sibling packages fixes the displacement bug (one package's file
  // silently winning a date over another's) but creates a double-count wherever
  // two siblings describe the same posts. MOD files both a department-wide
  // return and a Head Office & Corporate Services return for the same date:
  // 166 of 168 HO&CS posts for 2012-03-31 also appear in the department file,
  // 1,286 duplicate rows across 2012-2016, inflating MOD headcount by ~20% in
  // those years. Nothing else in the corpus does this.
  //
  // Dedupe on the publisher's own Post Unique Reference, across parts, within
  // one (org, date). The larger part wins, which is the department-wide return.
  // A PUR is only an identifier when the publisher supplied a real one — "0",
  // "XX", "N/A", "Deleted" and blanks are placeholders that repeat legitimately
  // inside a single file, so they are never treated as duplicates.
  for (const s of snapshots) {
    if (s.parts.length < 2) continue;
    const order = [...s.parts].sort((a, b) => b.posts.length - a.posts.length || a.pkg.localeCompare(b.pkg));
    const seen = new Map();
    for (const part of order) {
      const keep = [];
      for (const p of part.posts) {
        let pur = p.pur == null ? '' : String(p.pur).trim();
        // lib.mjs already blanks XX / N/A / none / dashes. "0" and "Deleted"
        // are the other two placeholders departments reuse on many rows.
        if (/^(0+|deleted|vacant|tbc)$/i.test(pur)) pur = '';
        if (pur && seen.has(pur)) {
          ctx.crossPartDupes.push({ org: s.orgId, date: s.date, pkg: part.pkg, keptIn: seen.get(pur), pur });
          continue;
        }
        if (pur) seen.set(pur, part.pkg);
        keep.push(p);
      }
      part.posts = keep;
    }
    s.parts = s.parts.filter(p => p.posts.length > 0);
  }
  const dupeCount = ctx.crossPartDupes.length;
  log(`  snapshots: ${snapshots.length}  (${files.length} files summed across sibling packages`
    + `${dupeCount ? `, ${dupeCount} cross-package duplicate posts dropped` : ''})`);

  const usedOrgIds = new Set(snapshots.map(s => s.orgId));
  const orgs = selected.filter(o => usedOrgIds.has(o.id));
  const dates = [...new Set(snapshots.map(s => s.date))].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const orgIdx = new Map(orgs.map((o, i) => [o.id, i]));

  const gradesUsed = new Set(), profsUsed = new Set();
  for (const s of snapshots) for (const p of s.parts) for (const post of p.posts) {
    gradesUsed.add(post.gradeBand); profsUsed.add(post.prof);
  }
  const grades = GRADE_BANDS.filter(g => gradesUsed.has(g));
  const profs = PROFESSIONS.filter(p => profsUsed.has(p));
  const gradeIdx = new Map(grades.map((g, i) => [g, i]));
  const profIdx = new Map(profs.map((p, i) => [p, i]));

  // 4. cubes + shards
  log('\n[4/5] aggregating cubes + post shards ...');
  const core = new Map(), prof = new Map();
  const shards = new Map();
  const withheldReasons = ['blank', 'zero', 'N/A', 'implausible', 'other'];
  let kept = 0, disclosed = 0, eliminatedTotal = 0, vacantTotal = 0, seniorPosts = 0, openBandTotal = 0;

  for (const s of snapshots) {
    const di = dateIdx.get(s.date), oi = orgIdx.get(s.orgId);
    for (const part of s.parts) {
      part.headcount = 0; part.disclosedInHeadcount = 0;
      for (const p of part.posts) {
        kept++;
        if (p.status !== 'eliminated') {
          part.headcount++;
          if (p.payDisclosed) {
            disclosed++; part.disclosedInHeadcount++;
            // One published edge only: counted as a disclosure, but the band is
            // open and no money total may use it. Surfaced so the Method beat
            // can state it rather than leaving it to be discovered.
            if (p.floor == null || p.ceil == null) openBandTotal++;
          }
        }
        if (p.gradeBand !== 'Below SCS' && p.gradeBand !== 'Other / Not stated') seniorPosts++;
        const gi = gradeIdx.get(p.gradeBand);
        accumulate(core, `${di}|${oi}|${gi}|${p.binLow}|${p.binHigh}`, p);
        accumulate(prof, `${di}|${oi}|${gi}|${profIdx.get(p.prof)}|${p.ddat}|${p.pol}|${p.binLow}|${p.binHigh}`, p);
        if (p.status === 'eliminated') eliminatedTotal++;
        if (p.status === 'vacant') vacantTotal++;

        if (!shards.has(s.orgId)) shards.set(s.orgId, newShard(s.orgId));
        pushShardRow(shards.get(s.orgId), p, di, part.pkg, gradeIdx, profIdx, withheldReasons);
      }
    }
  }

  // Tier A and Tier B are separate files over one shared index space. Tier B
  // is never summed into an SCS figure, so it must never be in the first
  // paint; splitting the file is what makes "default off" cost nothing.
  const tierOfIdx = orgs.map(o => o.tier);
  const isA = (k) => tierOfIdx[k[1]] === 'A';
  const isB = (k) => tierOfIdx[k[1]] === 'B';
  const coreRows = serialiseCube(core, 5, isA);
  const coreRowsB = serialiseCube(core, 5, isB);
  const profRows = serialiseCube(prof, 8, isA);
  const profRowsB = serialiseCube(prof, 8, isB);
  log(`  cube-core cells: ${coreRows.length} (tier B ${coreRowsB.length})`
    + `  cube-prof cells: ${profRows.length} (tier B ${profRowsB.length})`
    + `  post rows: ${kept} (disclosed ${disclosed}, ${(100 * disclosed / Math.max(kept, 1)).toFixed(1)}%)`);

  const cpih = await fetchCPIH();

  // coverage + snapshot registry
  const coverage = orgs.map(o => {
    const mine = snapshots.filter(s => s.orgId === o.id);
    return {
      org: o.id,
      snapshots: mine.length,
      dates: mine.map(s => dateIdx.get(s.date)),
      posts: mine.reduce((a, s) => a + s.parts.reduce((b, p) => b + p.posts.length, 0), 0),
      headcount: mine.reduce((a, s) => a + s.parts.reduce((b, p) => b + p.headcount, 0), 0),
      disclosed: mine.reduce((a, s) => a + s.parts.reduce((b, p) => b + p.disclosedInHeadcount, 0), 0),
    };
  });

  const snapshotRegistry = snapshots.map(s => ({
    org: s.orgId,
    d: dateIdx.get(s.date),
    conf: leastConfidence(s.parts.map(p => p.confidence)),
    rows: s.parts.reduce((a, p) => a + p.posts.length, 0),
    headcount: s.parts.reduce((a, p) => a + p.headcount, 0),
    disclosed: s.parts.reduce((a, p) => a + p.disclosedInHeadcount, 0),
    // The resource URL and its sha256 live in data/manifest.json, which is the
    // diff baseline. Repeating them here would put ~14 KB of incompressible
    // hex into the first paint for no frontend purpose.
    parts: s.parts.map(p => ({
      pkg: p.pkg, rows: p.posts.length, conf: p.confidence, basis: p.basis,
    })),
  }));

  const meta = {
    schema: SCHEMA,
    // WHEN THIS BUILD WAS MADE. Filled in below, after the content digest and
    // deliberately outside it: the run that last CHANGED the payload, not the
    // wall clock of this run. A re-run that changes nothing leaves it alone, so
    // two runs from cache stay byte-identical AND the page can honestly say
    // "built <date>" instead of printing the age of the newest upstream file.
    generated: null,
    // HOW CURRENT THE DATA IS: the newest upstream CKAN timestamp in the
    // corpus. This is what `generated` held under schema 1, and conflating the
    // two is what made every limits strip read "built 2026-08-11" on a build
    // written today.
    dataAsOf: dataAsOf(files),
    scope: { tier: TIER, only: ONLY.length ? ONLY : null, maxFiles: MAX_FILES || null, partial: PARTIAL },
    source: {
      name: 'gov.uk organogram of staff roles & salaries (senior posts)',
      via: 'data.gov.uk CKAN',
      licence: 'UK Open Government Licence (OGL)',
      note: 'Senior pay is published as a (floor, ceiling) band £5,000 wide throughout — including above £150,000, where only 131 of 4,621 rows are exact. Nothing here is an individual salary. Around two thirds of published senior posts have their pay withheld, and withholding is grade-dependent, so pay statistics are computed on the disclosed subset while headcount, FTE and grade mix use the full published population.',
      cadence: 'Pre-2022 the series was twice-yearly (31 March and 30 September). From 2022 departments publish quarterly to monthly across all twelve months, so a snapshot date can be any month.',
    },
    binWidth: BIN,
    dates,
    orgs: orgs.map(o => ({
      id: o.id, name: o.name, tier: o.tier, family: o.family,
      validFrom: o.validFrom, validTo: o.validTo,
      predecessors: o.predecessors, successors: o.successors,
    })),
    grades, profs, statuses: POST_STATUSES, withheldReasons,
    confidences: REF_CONFIDENCES,
    coverage,
    snapshots: columnarSnapshots(snapshotRegistry, orgIdx),
    cpih,
    stats: {
      orgs: orgs.length,
      snapshots: snapshots.length,
      files: files.length,
      dates: dates.length,
      dateRange: [dates[0] || null, dates[dates.length - 1] || null],
      posts: kept,
      headcount: kept - eliminatedTotal,
      seniorPosts,
      disclosed,
      // Disclosed, but with only one of the two band edges published, so the
      // band is open and no money total counts them. Stated rather than hidden.
      openBand: openBandTotal,
      withheld: kept - eliminatedTotal - disclosed,
      disclosureRate: kept - eliminatedTotal > 0 ? Math.round(1000 * disclosed / (kept - eliminatedTotal)) / 1000 : 0,
      eliminated: eliminatedTotal,
      vacant: vacantTotal,
      coreCells: coreRows.length + coreRowsB.length,
      profCells: profRows.length + profRowsB.length,
      filesOk: ok,
      filesFail: fail,
      undatedSkipped: ctx.undated.length,
      rejectedSiblings: ctx.rejectedSiblings.length,
    },
    warnings: warn.slice().sort(),
  };

  // floor assertions — before anything is promoted
  if (!PARTIAL) {
    const f = [];
    if (snapshots.length < FLOORS.snapshots) f.push(`snapshots ${snapshots.length} < ${FLOORS.snapshots}`);
    if (disclosed < FLOORS.posts) f.push(`disclosed posts ${disclosed} < ${FLOORS.posts}`);
    if (orgs.length < FLOORS.orgs) f.push(`organisations ${orgs.length} < ${FLOORS.orgs}`);
    if (dates.length < FLOORS.dates) f.push(`dates ${dates.length} < ${FLOORS.dates}`);
    if (f.length) fatal(`floor assertion failed — ${f.join('; ')}`);
  } else {
    if (!snapshots.length || !kept) fatal('partial run produced no snapshots or no post rows');
    // --max-files deliberately drops organisations, so the per-organisation
    // assertion only applies when the run was not capped.
    if (!MAX_FILES) {
      for (const id of ONLY) {
        if (!usedOrgIds.has(id)) fatal(`${id} was requested with --only but produced no snapshot`);
      }
    }
  }

  if (DRY_RUN) {
    log('\n[5/5] dry run — nothing written');
    meta.generated = runAt;
    summarise(meta, t0);
    return;
  }

  // 5. write, atomically
  log('\n[5/5] writing data ...');
  await mkdir(OUT, { recursive: true });
  await mkdir(SHARD_DIR, { recursive: true });
  await mkdir(path.dirname(MANIFEST), { recursive: true });

  const CORE_GRAIN = ['dateIdx', 'orgIdx', 'gradeIdx', 'binLow', 'binHigh'];
  const PROF_GRAIN = ['dateIdx', 'orgIdx', 'gradeIdx', 'profIdx', 'ddat', 'pol', 'binLow', 'binHigh'];
  const payloads = [
    ['meta.json', meta],
    ['cube-core.json', columnarCube(CORE_GRAIN, 'A', coreRows)],
    ['cube-core-b.json', columnarCube(CORE_GRAIN, 'B', coreRowsB)],
    ['cube-prof.json', columnarCube(PROF_GRAIN, 'A', profRows)],
    ['cube-prof-b.json', columnarCube(PROF_GRAIN, 'B', profRowsB)],
  ];
  for (const [id, shard] of [...shards.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    payloads.push([path.join('posts', id + '.json'), finaliseShard(shard)]);
  }

  // The digest is taken with meta.generated still null, so the build stamp can
  // never be the reason a run reports itself as changed.
  const digest = sha256(payloads.map(([n, v]) => n + ':' + JSON.stringify(v)).join('\n'));
  const changed = !previousManifest || previousManifest.digest !== digest;

  const changelog = await buildChangelog(meta, previousManifest, digest, changed, meta.stats.coreCells, runAt);
  if (changelog) payloads.push(['changelog.json', changelog]);

  // Stamp the build. A run that changed something is stamped now; a run that
  // changed nothing inherits the stamp of the run that did, which is the newest
  // changelog entry (falling back to the meta.json already on disk if the
  // changelog was deleted). That is what keeps rule 12 — two runs from cache
  // are byte-identical — true of a wall-clock field.
  meta.generated = changed
    ? runAt
    : (changelog?.[0]?.run ?? (await readJSON(path.join(OUT, 'meta.json')))?.generated ?? runAt);

  const written = [];
  for (const [name, value] of payloads) {
    const target = path.join(OUT, name);
    const tmp = target + '.tmp';
    const body = JSON.stringify(value);
    if (body.length < 32) fatal(`refusing to write an empty payload: ${name}`);
    JSON.parse(body); // parses as JSON before it can replace anything
    await writeFile(tmp, body);
    written.push([tmp, target, body.length]);
  }
  for (const [tmp, target] of written) await rename(tmp, target);

  // notable.json is retired: 58% of the old payload for 6% of the information,
  // one row per snapshot per post, and it carried MOD-museum rows labelled
  // "Ministry of Defence". cube.json is superseded by cube-core/cube-prof.
  for (const stale of ['notable.json', 'cube.json']) {
    await rm(path.join(OUT, stale), { force: true });
  }

  await writeFile(MANIFEST, JSON.stringify(buildManifest(meta, files, ctx, failures, digest), null, 1));

  const sizes = {};
  for (const [, target, len] of written) sizes[path.relative(OUT, target)] = len;
  const shardBytes = Object.entries(sizes).filter(([k]) => k.startsWith('posts')).reduce((a, [, v]) => a + v, 0);
  for (const f of ['meta.json', 'cube-core.json', 'cube-core-b.json', 'cube-prof.json', 'cube-prof-b.json']) {
    log(`  ${f.padEnd(18)} ${kb(sizes[f])}`);
  }
  log(`  posts shards       ${kb(shardBytes)} across ${shards.size} files`);
  log(`  manifest: ${path.relative(ROOT, MANIFEST)}  content ${changed ? 'CHANGED' : 'unchanged'}`);

  summarise(meta, t0);
}

// ---- cube accumulation -----------------------------------------------------
// n counts the DISCLOSED posts in a cell and `withheld` the undisclosed ones,
// so headcount is n + withheld. Eliminated posts are counted separately and
// are in neither: the post no longer exists. Vacant posts are in the headcount
// and in the band sums but never in the pay bill — nobody is being paid.
// The four money fields are stored as RESIDUALS against what the bin edges
// already imply, which is zero for the overwhelming majority of cells — the
// published bands are £5,000 wide and aligned, and almost every post is 1.0
// FTE. That is what keeps the first paint inside its budget. The decode is
// four lines and is written out in docs/DATA-CONTRACT.md.
const CUBE_FIELDS = [
  'n', 'withheld', 'vacant', 'eliminated', 'fteSum', 'fteKnown',
  'sumFloorRes', 'sumCeilRes', 'billLowRes', 'billHighRes',
];

// Everything accumulates in integers — pounds, and FTE in hundredths — so a
// cell sums identically whatever grain it is computed at. cube-prof must
// aggregate to cube-core exactly, not to within a rounding error.
function accumulate(map, key, p) {
  let c = map.get(key);
  if (!c) {
    c = { n: 0, withheld: 0, vacant: 0, eliminated: 0, fte100: 0, fteKnown: 0, sumFloor: 0, sumCeil: 0, billLow: 0, billHigh: 0, openBand: 0 };
    map.set(key, c);
  }
  if (p.status === 'eliminated') { c.eliminated++; return; }
  if (p.status === 'vacant') c.vacant++;
  if (p.payDisclosed) c.n++; else c.withheld++;
  if (p.fte != null) { c.fte100 += Math.round(p.fte * 100); c.fteKnown++; }
  if (p.payDisclosed) {
    // Only a row with BOTH published edges contributes to a money total.
    // Copying the one published edge onto the missing one (which is what this
    // did) turns "we know the ceiling" into "we know the salary", and it does
    // so silently, inside the totals a reader trusts most.
    if (p.floor != null && p.ceil != null) {
      const lo = Math.round(p.floor), hi = Math.round(p.ceil);
      c.sumFloor += lo; c.sumCeil += hi;
      if (p.status !== 'vacant') {
        const fte = p.fte != null ? p.fte : 1;
        c.billLow += Math.round(lo * fte); c.billHigh += Math.round(hi * fte);
      }
    } else {
      c.openBand++;
    }
  }
}

function serialiseCube(map, keyLen, keep) {
  const rows = [];
  for (const [key, c] of map) {
    const k = key.split('|').map(Number);
    if (keep && !keep(k)) continue;
    const binLow = k[keyLen - 2], binHigh = k[keyLen - 1];
    const impliedFloor = binLow < 0 ? 0 : c.n * binLow * BIN;
    const impliedCeil = binHigh < 0 ? 0 : c.n * (binHigh * BIN + BIN - 1);
    rows.push([
      ...k,
      c.n, c.withheld, c.vacant, c.eliminated,
      c.fte100 / 100, c.fteKnown,
      c.sumFloor - impliedFloor, c.sumCeil - impliedCeil,
      c.billLow - c.sumFloor, c.billHigh - c.sumCeil,
    ]);
  }
  rows.sort((a, b) => {
    for (let i = 0; i < keyLen; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  return rows;
}

// ---- columnar cube encoding ------------------------------------------------
// The cube ships as one array per column rather than one array per cell. The
// key columns are sorted and the measure columns are mostly zeros, so gzip sees
// long runs of the same token instead of fifteen different tokens repeating
// every row. Measured on cube-core.json at full scope (11,936 cells):
//
//   one array per cell                  464 KB raw   68.1 KB gz
//   one array per column                440 KB raw   52.9 KB gz
//   + the three residuals below         424 KB raw   37.6 KB gz
//
// Delta-encoding the leading sorted key column was measured too: dateIdx is
// already 426 bytes gzipped and the delta saved 184 bytes across the whole
// file, so it is NOT done — a decode step is not worth a rounding error.
//
// Three columns are stored as differences from what the row already states,
// which is the same idea as the four money residuals and for the same reason:
// the difference is zero in the overwhelming majority of cells. Zero in 11,766
// of 11,936 for binHigh, 11,909 for fteKnown, 9,070 for fteSum. Every column is
// an integer — under schema 1 fteSum was the one float in the file.
//
// The formulas ship in the file as `encoding` and the frontend asserts them on
// load, so a change here fails loudly rather than decoding into wrong numbers.
const CUBE_ENCODING = {
  binHigh: 'binLow + v',
  fteKnown: 'n + withheld + v',
  fteSum: '(fteKnown * 100 + v) / 100',
};

function columnarCube(grain, tier, rows) {
  const names = [...grain, ...CUBE_FIELDS];
  const at = Object.fromEntries(names.map((nm, i) => [nm, i]));
  const cols = Object.fromEntries(names.map(nm => [nm, new Array(rows.length)]));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let j = 0; j < names.length; j++) cols[names[j]][i] = r[j];
    cols.binHigh[i] = r[at.binHigh] - r[at.binLow];
    cols.fteKnown[i] = r[at.fteKnown] - (r[at.n] + r[at.withheld]);
    // fte100 is an integer sum in the accumulator; serialiseCube divided it by
    // 100, so multiplying back and rounding is exact, not a re-derivation.
    cols.fteSum[i] = Math.round(r[at.fteSum] * 100) - 100 * r[at.fteKnown];
  }
  return {
    schema: SCHEMA, layout: 'columnar',
    grain, fields: CUBE_FIELDS, encoding: CUBE_ENCODING,
    binWidth: BIN, tier, n: rows.length, cols,
  };
}

// ---- columnar snapshot registry --------------------------------------------
// 1,483 snapshots shipped as one object each cost 269 KB raw and 19.1 KB gz —
// 73% of meta.json's gzip, in a file that is half the first paint. Columnar
// with a package dictionary it is 49 KB raw and 7.0 KB gz, because the 127
// distinct CKAN package names were being written out 1,496 times.
//
// It stays in meta.json rather than moving to a lazy file: the frontend's
// period index reads (org, dateIdx, headcount) to pick one filing per
// organisation per period, and every chart on the page is drawn through it. A
// lazy registry means an empty page until it lands. See the note in section 2.3
// of the contract.
//
// `org` indexes meta.orgs and `d` indexes meta.dates — the same index spaces
// the cubes use. `conf` indexes meta.confidences. Only `pkg` and `basis` need
// dictionaries of their own; both are local to this block.
function columnarSnapshots(registry, orgIdx) {
  const pkgs = [], pkgIdx = new Map();
  const bases = [], basisIdx = new Map();
  const intern = (list, idx, v) => {
    if (!idx.has(v)) { idx.set(v, list.length); list.push(v); }
    return idx.get(v);
  };
  const out = {
    n: registry.length,
    pkgs, bases,
    org: [], d: [], conf: [], rows: [], headcount: [], disclosed: [], partCount: [],
    // Flat, in snapshot order: snapshot i owns the next partCount[i] entries.
    parts: { pkg: [], rows: [], conf: [], basis: [] },
  };
  for (const s of registry) {
    out.org.push(orgIdx.get(s.org));
    out.d.push(s.d);
    out.conf.push(REF_CONFIDENCES.indexOf(s.conf));
    out.rows.push(s.rows);
    out.headcount.push(s.headcount);
    out.disclosed.push(s.disclosed);
    out.partCount.push(s.parts.length);
    for (const p of s.parts) {
      out.parts.pkg.push(intern(pkgs, pkgIdx, p.pkg));
      out.parts.rows.push(p.rows);
      out.parts.conf.push(REF_CONFIDENCES.indexOf(p.conf));
      out.parts.basis.push(intern(bases, basisIdx, p.basis));
    }
  }
  return out;
}

// ---- post shards -----------------------------------------------------------
// Columnar and dictionary-encoded. Job/Team Function and Notes prose are
// dropped (they roughly double the size and carry no analysis).
//
// The published post-holder's NAME is carried (John's decision, 2026-08-16) so
// an individual can be searched for. gov.uk publishes it under OGL in the same
// release as the pay band. It is dictionary-encoded like every other string, and
// `holder` is null for every post that is vacant, eliminated, redacted or filed
// without a name — lib.postName() only returns a name when the status machine
// agrees the cell holds one, so a placeholder can never be indexed as a person.
const SHARD_COLS = [
  'date', 'pkg', 'suborg', 'unit', 'title', 'rawGrade', 'band', 'variant',
  'rawProf', 'prof', 'ddat', 'pol', 'status', 'disclosed', 'withheld',
  'floor', 'ceil', 'fte', 'costOfReports', 'region', 'pur', 'ordinal', 'reportsTo',
  'holder',
];

function newShard(orgId) {
  return {
    orgId,
    dicts: {
      pkg: dictionary(), suborg: dictionary(), unit: dictionary(), title: dictionary(),
      rawGrade: dictionary(), variant: dictionary(), rawProf: dictionary(),
      region: dictionary(), pur: dictionary(), holder: dictionary(),
    },
    cols: Object.fromEntries(SHARD_COLS.map(c => [c, []])),
    n: 0,
  };
}

function pushShardRow(shard, p, di, pkg, gradeIdx, profIdx, withheldReasons) {
  const d = shard.dicts, c = shard.cols;
  c.date.push(di);
  c.pkg.push(d.pkg.id(pkg));
  c.suborg.push(d.suborg.id(p.organisation));
  c.unit.push(d.unit.id(p.unit));
  c.title.push(d.title.id(p.title));
  c.rawGrade.push(d.rawGrade.id(p.gradeRaw));
  c.band.push(gradeIdx.get(p.gradeBand));
  c.variant.push(d.variant.id(p.gradeVariant));
  c.rawProf.push(d.rawProf.id(p.profRaw));
  c.prof.push(profIdx.get(p.prof));
  c.ddat.push(p.ddat);
  c.pol.push(p.pol);
  c.status.push(POST_STATUSES.indexOf(p.status));
  c.disclosed.push(p.payDisclosed ? 1 : 0);
  c.withheld.push(p.withheldReason ? withheldReasons.indexOf(p.withheldReason) : -1);
  c.floor.push(p.floor == null ? null : Math.round(p.floor));
  c.ceil.push(p.ceil == null ? null : Math.round(p.ceil));
  c.fte.push(p.fte == null ? null : p.fte);
  c.costOfReports.push(p.salaryCostOfReports);
  c.region.push(d.region.id(p.region));
  c.pur.push(d.pur.id(p.pur));
  c.ordinal.push(p.ordinal);
  c.reportsTo.push(d.pur.id(p.reportsTo));
  c.holder.push(d.holder.id(p.holder));
  shard.n++;
}

// Post Unique References are join keys, never rendered — the frontend uses them
// to give a post an identity across snapshots and to join reports-to edges, and
// prints only how MANY posts carry one. Publishing the strings cost 90 KB gz in
// the largest shard (60 for `pur`, 30 for `reportsTo`, which shares its
// dictionary) for text no reader ever sees. The columns keep the interned dense
// integer and the string dictionary is dropped: identity and edges are exactly
// preserved, because both only need the values to be distinct.
const DROPPED_DICTS = new Set(['pur']);

function finaliseShard(shard) {
  return {
    schema: SCHEMA,
    org: shard.orgId,
    n: shard.n,
    cols: SHARD_COLS,
    dict: Object.fromEntries(Object.entries(shard.dicts)
      .filter(([k]) => !DROPPED_DICTS.has(k))
      .map(([k, v]) => [k, v.values()])),
    data: Object.fromEntries(SHARD_COLS.map(c => [c, shard.cols[c]])),
  };
}

// ---- manifest + changelog --------------------------------------------------
function buildManifest(meta, files, ctx, failures, digest) {
  const byOrg = {};
  for (const f of files) {
    (byOrg[f.orgId] ||= []).push({
      pkg: f.pkg, url: f.url, created: f.created, lastModified: f.lastModified,
      referenceDate: f.referenceDate, confidence: f.confidence, basis: f.basis,
      sha256: f.sha, bytes: f.bytes, rows: f.rows, posts: f.posts.length,
      disclosed: f.stats.disclosed, blankRows: f.stats.blankRows,
      validApplied: f.stats.validApplied, juniorRows: f.stats.juniorRows,
    });
  }
  for (const k of Object.keys(byOrg)) byOrg[k].sort((a, b) => a.referenceDate.localeCompare(b.referenceDate) || a.pkg.localeCompare(b.pkg));
  return {
    schema: SCHEMA,
    digest,
    scope: meta.scope,
    stats: meta.stats,
    dates: meta.dates,
    resources: byOrg,
    failures: failures.map(f => ({ org: f.orgId, date: f.referenceDate, url: f.url, reason: f.reason }))
      .sort((a, b) => (a.org + a.url).localeCompare(b.org + b.url)),
    undated: ctx.undated.sort((a, b) => (a.org + a.url).localeCompare(b.org + b.url)),
    rejectedSiblings: ctx.rejectedSiblings.sort((a, b) => (a.org + a.url).localeCompare(b.org + b.url)),
    emptySlugs: ctx.emptySlugs,
    outOfWindow: ctx.outOfWindow,
  };
}

async function buildChangelog(meta, previous, digest, changed, cubeCells, runAt) {
  const existing = (await readJSON(path.join(OUT, 'changelog.json'))) || [];
  if (!changed) return existing.length ? existing : null;
  const prev = previous?.stats || null;
  const prevDates = new Set(previous?.dates || []);
  const entry = {
    run: runAt,
    gitSha: await headSha(),
    scope: meta.scope,
    snapshotsBefore: prev?.snapshots ?? null, snapshotsAfter: meta.stats.snapshots,
    postsBefore: prev?.posts ?? null, postsAfter: meta.stats.posts,
    orgsBefore: prev?.orgs ?? null, orgsAfter: meta.stats.orgs,
    datesAdded: prevDates.size ? meta.dates.filter(d => !prevDates.has(d)) : [],
    filesOk: meta.stats.filesOk, filesFail: meta.stats.filesFail,
    undatedSkipped: meta.stats.undatedSkipped,
    cpihSource: meta.cpih.source,
    cacheMode: USE_CACHE ? `revalidate-${REVALIDATE_MONTHS}m` : 'no-cache',
    cubeCells,
    warnings: meta.warnings,
  };
  return [entry, ...existing].slice(0, CHANGELOG_CAP);
}

async function headSha() {
  try {
    const head = (await readFile(path.join(ROOT, '.git', 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref: ')) {
      return (await readFile(path.join(ROOT, '.git', head.slice(5)), 'utf8')).trim().slice(0, 12);
    }
    return head.slice(0, 12);
  } catch { return null; }
}

async function readJSON(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

// ---- reporting -------------------------------------------------------------
function leastConfidence(list) {
  if (list.includes('default')) return 'default';
  if (list.includes('inferred')) return 'inferred';
  return 'declared';
}

// A deterministic build stamp: the newest upstream timestamp in the corpus,
// not the wall clock, so two runs from cache are byte-identical.
function dataAsOf(files) {
  let best = '';
  for (const f of files) {
    for (const t of [f.created, f.lastModified]) if (t && t > best) best = t;
  }
  return best ? new Date(best.endsWith('Z') ? best : best + 'Z').toISOString() : null;
}

const kb = (n) => (n == null ? '-' : Math.round(n / 1024) + 'KB');

function summarise(meta, t0) {
  const s = meta.stats;
  log('\n== done ==');
  log(`  organisations       : ${s.orgs}`);
  log(`  snapshots           : ${s.snapshots}  from ${s.files} files`);
  log(`  date range          : ${s.dateRange[0]} -> ${s.dateRange[1]}  (${s.dates} dates)`);
  log(`  post rows kept      : ${s.posts}  (senior ${s.seniorPosts}, eliminated ${s.eliminated}, vacant ${s.vacant})`);
  log(`  pay disclosed       : ${s.disclosed}  (${(100 * s.disclosureRate).toFixed(1)}%)`);
  log(`  cube cells          : core ${s.coreCells}  prof ${s.profCells}`);
  log(`  files ok/fail       : ${s.filesOk}/${s.filesFail}  undated skipped ${s.undatedSkipped}`);
  log(`  CPIH                : ${meta.cpih.source}`);
  if (meta.warnings.length) for (const w of meta.warnings) log(`  WARNING             : ${w}`);
  log(`  elapsed             : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
