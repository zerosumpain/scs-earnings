// Shared pure helpers for the SCS earnings ingestion pipeline.
// No external deps — Node 22 built-ins only. Kept dependency-free so the
// pipeline runs anywhere and the logic is unit-testable in isolation.
//
// Two rules govern everything below:
//   1. Never destroy a published value. Raw grade and raw profession strings
//      are carried alongside the normalised class; classification is a
//      presentation layer, not a lossy ingest step.
//   2. Never invent one. Unparseable FTE is null, not 1.0. Undisclosed pay is
//      a status with a reason, not a dropped row. A pay band is (low, high),
//      never a collapsed midpoint — 41,917 of 44,489 published pay rows span
//      exactly £4,999, so a midpoint is a fabricated certainty.

// ---- CSV parsing (RFC-4180-ish state machine, tolerant of stray CR/BOM) ----
// Line endings are normalised up front: the 2010-2012 archive era contains
// lone-CR files (verified: COI 2011 parses as 1 row x 290 cols without this).
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  // strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = String(text).replace(/\r\n?/g, '\n');
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // flush trailing field/row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---- byte sniffing: never trust content-type ----
// Binaries are served under .csv URLs (verified: a DfE 2012 "csv" is %PDF-1.6,
// two S3 files are OOXML). Returns a format id, or null when it looks textual.
export function sniffBinary(buf) {
  if (!buf || buf.length < 4) return null;
  const b = Uint8Array.prototype.slice.call(buf, 0, 8);
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'zip/xlsx';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  return null;
}

// Decode a downloaded body. gov.uk organogram CSVs are a mix of UTF-8 and
// windows-1252; a strict UTF-8 decode that throws tells us which.
export function decodeBody(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ---- header matching (name-based, tolerant of punctuation/case/£ symbols) ----
export function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// find the index of the first header whose normalised form includes ALL words
// of any of the provided keyword phrases (phrases tried in priority order).
export function findCol(headers, phrases) {
  const norm = headers.map(normHeader);
  for (const phrase of phrases) {
    const words = phrase.split(' ').filter(Boolean);
    for (let i = 0; i < norm.length; i++) {
      if (words.every(w => norm[i].split(' ').includes(w))) return i;
    }
  }
  // looser fallback: substring includes
  for (const phrase of phrases) {
    const p = normHeader(phrase);
    for (let i = 0; i < norm.length; i++) if (norm[i].includes(p)) return i;
  }
  return -1;
}

// ---- money parsing ----
export function parseMoney(s) {
  if (s == null) return NaN;
  const cleaned = String(s).replace(/[£$,\s]/g, '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-') return NaN;
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : NaN;
}

// FTE. Returns null — never a default 1.0 — when the cell is unparseable or
// out of range, so the pay bill can state its imputed share honestly. Values
// above 5 are junior post-counts (125 rows), and a file full of them is a
// junior schema, which isJuniorSchema() rejects outright.
export function parseFTE(s) {
  const raw = String(s ?? '').trim();
  if (raw === '') return null;
  const v = parseFloat(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(v) || v <= 0 || v > 5) return null;
  return v;
}

// ---- junior-schema rejection, by CONTENT not filename ----
// The junior organograms are role-group aggregates, not individuals: a
// different unit of analysis. One of them (DfE September 2010) sat at date
// index 0 of the shipped corpus and set the whole "2010 H2" period to 465
// role-group rows of EO/HEO/SEO staff.
export function isJuniorSchema(headers) {
  const norm = (headers || []).map(normHeader);
  for (const h of norm) {
    if (h.includes('reporting senior post')) return true;
    if (h.includes('number of posts')) return true;   // "Number of Posts in FTE"
    if (h.includes('generic job title')) return true;
  }
  return false;
}

// ---- snapshot reference dates ----
const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7,
  august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

const MONTH_RE = new RegExp(
  '(january|february|march|april|may|june|july|august|september|october|november|december' +
  '|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[^0-9a-z]{0,4}\\d*?(20\\d{2})(?!\\d)', 'i');

function iso(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The transparency series reports at quarter ends. ALL FOUR of them: the old
// two-way snap (<=June -> 31 Mar, else 30 Sep) pushed every June snapshot back
// three months, which is why the true earliest release — 30 June 2010 — was
// invisible in the shipped corpus.
export function quarterEnd(year, month) {
  if (month <= 3) return iso(year, 3, 31);
  if (month <= 6) return iso(year, 6, 30);
  if (month <= 9) return iso(year, 9, 30);
  return iso(year, 12, 31);
}

// The quarter end on or before a given ISO date.
export function precedingQuarterEnd(isoDate) {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const qe = quarterEnd(y, mo);
  if (qe && qe <= iso(y, mo, d)) return qe;
  // before this quarter's end: fall back to the previous quarter
  if (mo <= 3) return iso(y - 1, 12, 31);
  if (mo <= 6) return iso(y, 3, 31);
  if (mo <= 9) return iso(y, 6, 30);
  return iso(y, 9, 30);
}

// A CKAN upload stamp embedded in a URL, e.g.
// "...2025-08-13T11-08-22Z-2025-06-30-organogram-senior.csv". This is when the
// file was published, NOT what it reports: 119 of 653 resources declare their
// upload stamp as the snapshot date.
export function extractUploadDate(url) {
  const u = decodeURIComponent(String(url || ''));
  const m = u.match(/(20\d{2})-(\d{2})-(\d{2})[tT][\d:.-]{4,}[zZ]?/);
  if (m && +m[2] <= 12 && +m[3] <= 31) return iso(+m[1], +m[2], +m[3]);
  return null;
}

// A reference date the publisher actually declared in the resource path.
export function extractDeclaredDate(url) {
  const u = decodeURIComponent(String(url || ''));
  // Pattern B (current resources): "...-2025-03-31-organogram-senior.csv"
  let m = u.match(/(\d{4})-(\d{2})-(\d{2})-organogram/i);
  if (m) return iso(+m[1], +m[2], +m[3]);
  // Pattern A (legacy path): ".../organogram/<dept>/<D>/<M>/<YYYY>/..."
  m = u.match(/\/organogram\/[^/]+\/(\d{1,2})\/(\d{1,2})\/(\d{4})\//);
  if (m) return iso(+m[3], +m[2], +m[1]);
  // filename D-M-YYYY e.g. "__31-03-2012__"
  m = u.match(/(\d{1,2})-(\d{1,2})-(20\d{2})(?!\d)/);
  if (m && +m[1] <= 31 && +m[2] <= 12) return iso(+m[3], +m[2], +m[1]);
  // any bare YYYY-MM-DD that is not the head of an upload timestamp
  const re = /(20\d{2})-(\d{2})-(\d{2})(?![tT][\d:.-]{4,})/g;
  let g;
  while ((g = re.exec(u))) {
    if (+g[2] >= 1 && +g[2] <= 12 && +g[3] >= 1 && +g[3] <= 31) return iso(+g[1], +g[2], +g[3]);
  }
  return null;
}

// A month + year named anywhere in a string, snapped to its own quarter end.
export function monthYearToQuarterEnd(text) {
  const m = String(text || '').match(MONTH_RE);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  const yr = +m[2];
  if (!mo || !yr) return null;
  return quarterEnd(yr, mo);
}

// Resolve the date a snapshot REPORTS ON, and say how confident we are.
//   'declared' — the publisher wrote the reference date into the resource path
//   'inferred' — taken from a month named in the resource/package name/title
//   'default'  — snapped from the upload stamp, lowest confidence
// resourceName is optional and additive: CKAN resource names such as
// "Organogram - Senior CSV data March 2019" are the only thing standing
// between a 2019-03-07 upload stamp and the wrong quarter.
export function resolveReferenceDate(url, packageName, packageTitle, uploadDate, resourceName) {
  const declared = extractDeclaredDate(url);
  if (declared) return { referenceDate: declared, confidence: 'declared', basis: 'url' };

  // A month named in the filename. This is how the 2010-2012 archive era
  // dates itself ("hmt_seniorstaffposts_jun2010"), and it is the only reason
  // the true earliest release — 30 June 2010 — is visible at all.
  const fromUrl = monthYearToQuarterEnd(decodeURIComponent(String(url || '')));
  if (fromUrl) return { referenceDate: fromUrl, confidence: 'inferred', basis: 'url-month' };

  const fromResource = monthYearToQuarterEnd(resourceName);
  if (fromResource) return { referenceDate: fromResource, confidence: 'inferred', basis: 'resource-name' };

  const fromPkgName = monthYearToQuarterEnd(packageName);
  if (fromPkgName) return { referenceDate: fromPkgName, confidence: 'inferred', basis: 'package-name' };

  const fromPkgTitle = monthYearToQuarterEnd(packageTitle);
  if (fromPkgTitle) return { referenceDate: fromPkgTitle, confidence: 'inferred', basis: 'package-title' };

  const upload = extractUploadDate(url) || (uploadDate ? String(uploadDate).slice(0, 10) : null);
  const snapped = upload ? precedingQuarterEnd(upload) : null;
  if (snapped) return { referenceDate: snapped, confidence: 'default', basis: 'upload-stamp' };

  return { referenceDate: null, confidence: null, basis: 'none' };
}

// ---- post status, derived from the Name column ----
// The status drives the disclosure analysis. The name itself is ALSO carried
// now (John's decision, 2026-08-16) so a reader can search for an individual
// post-holder. gov.uk publishes these names lawfully under OGL as part of the
// same transparency release as the pay band.
//
// `postName()` returns the name ONLY when the cell is a real name — every
// placeholder the status machine recognises ("N/D", "Vacant", "Redacted",
// "N/A", "Eliminated") returns null, so a placeholder can never be rendered or
// indexed as if it were a person.
export const POST_STATUSES = [
  'filled-named', 'filled-undisclosed', 'vacant', 'eliminated', 'redacted', 'blank',
];

export function postStatusFromName(name) {
  const s = String(name ?? '').trim();
  if (s === '' || s === '-' || s === '--' || /^n[\/. ]?a$/i.test(s) || /^nan$/i.test(s)) {
    return /^n[\/. ]?a$/i.test(s) ? 'filled-undisclosed' : 'blank';
  }
  if (/redact/i.test(s)) return 'redacted';
  if (/vacan/i.test(s)) return 'vacant';
  if (/eliminat|abolish|deleted post/i.test(s)) return 'eliminated';
  if (/^n[\/. ]?d$/i.test(s) || /not\s*disclos|non[- ]?disclos|withheld|not\s*provided|not\s*published|undisclosed/i.test(s)) {
    return 'filled-undisclosed';
  }
  return 'filled-named';
}

// The published post-holder's name, or null. Only ever non-null when the status
// machine above agrees the cell holds a real name, so the two can never
// disagree. Whitespace is collapsed and the string is capped, because these
// cells occasionally carry a name plus a job title plus a phone number.
export function postName(name) {
  if (postStatusFromName(name) !== 'filled-named') return null;
  const s = String(name).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 80) : s;
}

// ---- grade classification ----
// Ordered worst-to-best is deliberate: the frontend draws grade as an ORDINAL
// ramp, so the array order is the ramp order.
export const GRADE_BANDS = [
  'SCS4 / Perm Sec',
  'SCS3 (Dir Gen)',
  'SCS2 (Dir)',
  'SCS1 (Dep Dir)',
  'SCS (band n/s)',
  'Military (OF-6+)',
  'Specialist (own scale)',
  'Below SCS',
  'Other / Not stated',
];

// Bands that represent a senior post of some description. Used by the
// junior-content check; military ranks and specialist scales are senior even
// though they are not SCS pay bands.
const SENIOR_BANDS = new Set([
  'SCS4 / Perm Sec', 'SCS3 (Dir Gen)', 'SCS2 (Dir)', 'SCS1 (Dep Dir)',
  'SCS (band n/s)', 'Military (OF-6+)', 'Specialist (own scale)',
]);

const JUNIOR_GRADES = new Set([
  'grade 7', 'grade7', 'g7', 'grade 6', 'grade6', 'g6', 'grade 6 7', 'seo', 'heo', 'eo',
  'ao', 'aa', 'ea ao', 'fast st', 'fast stream', 'faststream', 'fs', 'band a', 'band b',
  'band c', 'band d', 'band e', 'executive officer', 'higher executive officer',
  'senior executive officer', 'administrative officer', 'administrative assistant',
  'apprentice', 'industrial', 'non industrial',
]);

// Returns { raw, band, variant, senior }. `variant` preserves the detail the
// old single-string classifier destroyed: SCS Band 1 London vs National,
// OF-6..OF-9 (4,049 rows), Senior Commercial Specialist, Parliamentary
// Counsel, Medical Consultant (125 rows).
export function normGrade(raw) {
  const rawStr = String(raw ?? '').trim();
  const s = rawStr.toLowerCase();
  const n = normHeader(rawStr);           // punctuation-stripped, single-spaced
  const out = (band, variant = null) => ({ raw: rawStr, band, variant, senior: SENIOR_BANDS.has(band) });

  if (rawStr === '' || n === 'nan' || n === 'na' || n === 'n a') return out('Other / Not stated');

  // military ranks (OF-6 = 1-star through OF-9 = 4-star)
  let m = n.match(/^of\s*([6-9])$/);
  if (m) return out('Military (OF-6+)', `OF-${m[1]}`);

  // specialist scales that sit outside the SCS pay bands entirely
  if (/medical consultant|consultant psychiatrist|^consultant$/.test(n)) return out('Specialist (own scale)', 'Medical Consultant');
  if (/counsel/.test(n)) return out('Specialist (own scale)', 'Parliamentary Counsel');
  if (/senior commercial specialist/.test(n)) return out('Specialist (own scale)', 'Senior Commercial Specialist');
  if (/commercial specialist/.test(n)) return out('Specialist (own scale)', 'Commercial Specialist');
  if (/^slg/.test(n)) return out('Specialist (own scale)', 'SLG (DE&S)');
  if (/^afc/.test(n)) return out('Specialist (own scale)', rawStr.toUpperCase());
  if (/^esm/.test(n)) return out('Specialist (own scale)', rawStr.toUpperCase());

  // SCS pay bands, with the location qualifier kept when the file states one
  const SCS_BY_NUMBER = ['SCS1 (Dep Dir)', 'SCS2 (Dir)', 'SCS3 (Dir Gen)', 'SCS4 / Perm Sec'];
  m = n.match(/scs\s*(?:pay\s*)?band\s*([1-4])\s*(a?)\s*(london|national)?/);
  if (m) {
    const band = SCS_BY_NUMBER[+m[1] - 1];
    const variant = m[3] ? (m[3] === 'london' ? 'London' : 'National') : (m[2] === 'a' ? 'SCS1A' : null);
    return out(band, variant);
  }

  if (/perm(anent)? (under )?sec|permsec|cabinet secretary|second permanent|scs\s*4|pay band 4|\bpb4\b/.test(n)) return out('SCS4 / Perm Sec');
  if (/director general|\bdg\b|scs\s*3|pay band 3|\bpb3\b/.test(n)) return out('SCS3 (Dir Gen)');
  if (/scs\s*1a|scs1a|pay band 1a/.test(n)) return out('SCS1 (Dep Dir)', 'SCS1A');
  if (/deputy director|\bdd\b|scs\s*1|pay band 1|\bpb1\b/.test(n)) return out('SCS1 (Dep Dir)');
  if (/director|scs\s*2|pay band 2|\bpb2\b/.test(n)) return out('SCS2 (Dir)');
  if (/scs/.test(n)) return out('SCS (band n/s)');
  if (JUNIOR_GRADES.has(n)) return out('Below SCS');
  return out('Other / Not stated');
}

// ---- profession classification ----
// Aligned to the Civil Service Statistics Table 36 profession list, so the
// published quartiles in that table become a free validation set. Two classes
// are deliberate extensions: 'Military' (3,462 rows, no Table 36 equivalent)
// and 'Not stated', which is kept distinct from 'Other' because the two
// largest raw values in the corpus are non-answers — 'Undefined' (20,686) and
// blank (17,494) — and collapsing them into 'Other' hides that.
export const PROFESSIONS = [
  'Communications',
  'Commercial',
  'Counter Fraud',
  'Digital, Data & Technology',
  'Economics',
  'Finance',
  'Geography',
  'Human Resources',
  'Inspector of Education and Training',
  'Intelligence & Security',
  'Internal Audit & Risk',
  'Knowledge & Information Management',
  'Legal',
  'Medical & Health',
  'Military',
  'Occupational Psychology',
  'Operational Delivery',
  'Operational Research',
  'Planning',
  'Planning Inspectors',
  'Policy',
  'Project Delivery',
  'Property & Estates',
  'Science & Engineering',
  'Social Research',
  'Statistics',
  'Tax',
  'Veterinary',
  'Other',
  'Not stated',
];

// Order is load-bearing. Every rule that could be swallowed by a broader one
// sits above it: Operational Research before Operational Delivery, Knowledge &
// Information Management before Digital (which matches "information
// management"), Planning Inspectors before Planning, Intelligence before
// Statistics (which matches "analysis").
const PROF_RULES = [
  ['Counter Fraud', /counter[- ]?fraud|\bfraud\b/],
  ['Occupational Psychology', /occupational psycholog|psycholog/],
  ['Operational Research', /operational research|\bor\s*service\b/],
  ['Knowledge & Information Management', /knowledge (and|&) information|\bkim\b/],
  ['Inspector of Education and Training', /inspector of education|education and training inspect/],
  ['Planning Inspectors', /planning inspector/],
  ['Geography', /geograph/],
  ['Social Research', /social research/],
  ['Intelligence & Security', /intelligence|national security|counter[- ]terror|\bsecurity\b/],
  ['Veterinary', /veterinar|\bvets?\b/],
  ['Military', /\bmilitary\b|armed forces/],
  ['Internal Audit & Risk', /audit|\brisk\b|assurance/],
  ['Policy', /policy|polciy/],
  ['Economics', /econom/],
  ['Finance', /financ|account/],
  ['Digital, Data & Technology', /digital|\bdata\b|technolog|\bict\b|cyber|software|\bcio\b|\bcdo\b|\bcto\b|information technolog|architect|\bit\b/],
  ['Legal', /legal|\blaw\b|solicitor|counsel|barrister/],
  ['Tax', /\btax\b|revenue|customs/],
  ['Commercial', /commercial|procure|contract management|purchasing/],
  ['Project Delivery', /project|programme|portfolio|\bppm\b/],
  ['Human Resources', /human resource|\bhr\b|people|workforce|reward/],
  ['Communications', /communicat|\bcomms\b|media|press|marketing|external affairs/],
  ['Science & Engineering', /scien|engineer|\bstem\b/],
  ['Statistics', /statistic|\bstats?\b|analysis|analyst|data science/],
  ['Operational Delivery', /operational|operations|op del|service delivery|casework/],
  ['Medical & Health', /medic|clinical|\bnurs|\bhealth\b|public health|pharmac|dental/],
  ['Property & Estates', /property|estates?|facilit|surveyor|asset management/],
  ['Planning', /planning/],
];

const NON_ANSWER = /^(undefined|unspecified|unknown|missing data|not (stated|applicable|reported|recorded)|n\/?a|none|nil|nan|tbc|unassigned( profession)?)$/;

// Returns { raw, prof, source } where source is 'group' | 'title' | 'none'.
export function normProfession(rawGroup, jobTitle) {
  const rawStr = String(rawGroup ?? '').trim();
  const g = rawStr.toLowerCase();
  const isNonAnswer = g === '' || NON_ANSWER.test(g);
  if (!isNonAnswer) {
    for (const [name, re] of PROF_RULES) if (re.test(g)) return { raw: rawStr, prof: name, source: 'group' };
  }
  // fall back to inferring from the job title when the group is blank, a
  // non-answer, or the catch-all "Other"
  if (isNonAnswer || /^other/.test(g) || /other$/.test(g)) {
    const jt = String(jobTitle ?? '').toLowerCase();
    if (jt) for (const [name, re] of PROF_RULES) if (re.test(jt)) return { raw: rawStr, prof: name, source: 'title' };
  }
  if (isNonAnswer) return { raw: rawStr, prof: 'Not stated', source: 'none' };
  return { raw: rawStr, prof: 'Other', source: 'none' };
}

// DDaT detection. The old rule matched /\bit\b/ case-insensitively — i.e. the
// English word "it" — so "Director, Policy: how it works" was a digital post.
// The test is case-SENSITIVE against the original-case title.
export function isDDaT(prof, jobTitle) {
  if (prof === 'Digital, Data & Technology') return true;
  const t = String(jobTitle ?? '');
  if (/\bIT\b/.test(t)) return true;
  return /\bdigital\b|\bdata\b|technolog|\bict\b|\bcio\b|\bcdo\b|\bcto\b|cyber|software/i.test(t);
}

export function isPolicy(prof, jobTitle) {
  if (prof === 'Policy') return true;
  return /\bpolicy\b/i.test(String(jobTitle ?? ''));
}

// ---- pay banding ----
// The published band is (floor, ceiling) and it is £4,999 wide. Binning on a
// midpoint invents a certainty the data cannot support, which is how the
// "£150k+" and "more than the PM" counts came to treat a £145,000-£149,999
// band and a £150,000-£154,999 band as decided either side of a line.
export const BIN = 5000;

// Band index sentinels. -1 = no pay published at all (withheld). -2 = exactly
// ONE edge published, so the band is open on the other side.
//
// The old code copied the published edge onto the missing one, which stated a
// floor the department never published — 110 rows in the current corpus publish
// a ceiling alone and were being reported as if pinned to a single £5,000 band.
// A study whose whole claim is provenance cannot invent the number it is short
// of, so an open band gets its own bucket: the row still counts as a post and
// as a disclosure, the exact published edge survives verbatim in the post
// shard, and no pay statistic is allowed to treat it as bounded.
export const BAND_WITHHELD = -1;
export const BAND_OPEN = -2;

export function payBin(low, high) {
  const lo = Number.isFinite(low) && low > 0 ? low : null;
  const hi = Number.isFinite(high) && high > 0 ? high : null;
  if (lo == null && hi == null) return [BAND_WITHHELD, BAND_WITHHELD];
  if (lo == null || hi == null) return [BAND_OPEN, BAND_OPEN];
  const binLow = Math.floor(Math.min(lo, hi) / BIN);
  const binHigh = Math.floor(Math.max(lo, hi) / BIN);
  return [binLow, binHigh];
}

// ---- one senior organogram CSV -> normalised post rows ----
// File-level rejection reasons are returned, never thrown: one bad file must
// never sink a run. `ok:false` files are counted, reported and carried into
// the manifest so a jump in the failure rate is visible.
const PLAUSIBLE_MIN = 30000;
const PLAUSIBLE_MAX = 800000;

export function parsePosts(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return reject('empty', { rows: rows.length });
  const headers = rows[0];
  if (isJuniorSchema(headers)) return reject('junior-schema', { headers: headers.length });

  const cPUR = findCol(headers, ['post unique reference', 'post reference', 'unique reference']);
  const cName = findCol(headers, ['name']);
  const cGrade = findCol(headers, ['grade equivalent', 'grade', 'scs grade']);
  const cTitle = findCol(headers, ['job title', 'post title', 'title']);
  const cGroup = findCol(headers, ['professional occupational group', 'profession', 'occupational group']);
  const cFloor = findCol(headers, ['actual pay floor', 'pay floor', 'payscale minimum', 'salary min']);
  const cCeil = findCol(headers, ['actual pay ceiling', 'pay ceiling', 'payscale maximum', 'salary max']);
  const cFTE = findCol(headers, ['fte']);
  const cUnit = findCol(headers, ['unit', 'group']);
  const cOrg = findCol(headers, ['organisation', 'organization']);
  const cParent = findCol(headers, ['parent department']);
  const cReports = findCol(headers, ['reports to senior post', 'reports to']);
  const cCost = findCol(headers, ['salary cost of reports']);
  const cRegion = findCol(headers, ['office region', 'region']);
  // "Valid?" only counts when the column is literally headed that
  const cValid = headers.findIndex(h => normHeader(h) === 'valid');

  if (cFloor < 0 && cCeil < 0) return reject('no-pay-columns', {});
  if (cGrade < 0 && cTitle < 0) return reject('no-post-columns', {});

  const body = rows.slice(1);

  // 1. blank padding rows go first, before any other filter. 5,253 of them,
  //    concentrated in FCO 2019-03-31, BEIS 2019-12-06 and DCLG 2019-08-19.
  const cell = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const kept = [];
  let blankRows = 0;
  for (const r of body) {
    if (!r || r.length === 0) { blankRows++; continue; }
    const empty = cell(r, cGrade) === '' && cell(r, cTitle) === '' && cell(r, cName) === ''
      && cell(r, cFloor) === '' && cell(r, cCeil) === '' && cell(r, cPUR) === '';
    if (empty) { blankRows++; continue; }
    kept.push(r);
  }
  if (!kept.length) return reject('all-rows-blank', { blankRows });

  // 2. the Valid? guard. FCO 2019-03-31 flags its 132 real posts 0 and its
  //    1,866 blank padding rows 1, so the filter is only trustworthy when the
  //    majority of pay-bearing rows are the ones flagged valid.
  let validApplied = false;
  let invalidDropped = 0;
  if (cValid >= 0) {
    let payValid = 0, payInvalid = 0;
    for (const r of kept) {
      const p = parseMoney(cell(r, cFloor)), q = parseMoney(cell(r, cCeil));
      const hasPay = (Number.isFinite(p) && p > 0) || (Number.isFinite(q) && q > 0);
      if (!hasPay) continue;
      if (isFlaggedInvalid(cell(r, cValid))) payInvalid++; else payValid++;
    }
    validApplied = payValid > payInvalid && payValid > 0;
  }

  // 3. junior content check. Deliberately narrow: a file is rejected only when
  //    it carries NO senior post at all, or when its FTE column is plainly a
  //    post count. DHSC publishes ~3,500 junior rows inside its senior file
  //    alongside ~330 real SCS posts (Permanent Secretary, CMO); rejecting
  //    that file would lose more than it saves. Junior rows land in the
  //    'Below SCS' band instead, counted and visible, and the presentation
  //    layer excludes them from any SCS figure.
  let graded = 0, senior = 0, bigFTE = 0;
  for (const r of kept) {
    const g = normGrade(cell(r, cGrade));
    if (g.band !== 'Other / Not stated') { graded++; if (g.senior) senior++; }
    const f = parseFloat(cell(r, cFTE).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(f) && f > 5) bigFTE++;
  }
  if (graded >= 20 && senior === 0) return reject('junior-content', { graded, senior });
  if (kept.length >= 20 && bigFTE / kept.length > 0.5 && senior / Math.max(graded, 1) < 0.2) {
    return reject('junior-content-fte', { bigFTE, rows: kept.length });
  }

  const posts = [];
  const seenPUR = new Map();
  for (const r of kept) {
    if (validApplied && isFlaggedInvalid(cell(r, cValid))) { invalidDropped++; continue; }

    const status = postStatusFromName(cell(r, cName));
    const holder = postName(cell(r, cName));
    const title = cell(r, cTitle);
    const grade = normGrade(cell(r, cGrade));
    const prof = normProfession(cell(r, cGroup), title);

    const floorRaw = cell(r, cFloor);
    const ceilRaw = cell(r, cCeil);
    const floor = parseMoney(floorRaw);
    const ceil = parseMoney(ceilRaw);
    const hasFloor = Number.isFinite(floor) && floor > 0;
    const hasCeil = Number.isFinite(ceil) && ceil > 0;

    let payDisclosed = hasFloor || hasCeil;
    let withheldReason = null;
    if (!payDisclosed) {
      const t = (floorRaw + ' ' + ceilRaw).trim();
      if (t === '') withheldReason = 'blank';
      else if (/^0([.,]0+)?$/.test(floorRaw.trim()) || /^0([.,]0+)?$/.test(ceilRaw.trim())) withheldReason = 'zero';
      else if (/n\/?a|n\/?d|not disclosed|withheld|redact/i.test(t)) withheldReason = 'N/A';
      else withheldReason = 'other';
    } else {
      const lo = hasFloor ? floor : ceil;
      const hi = hasCeil ? ceil : floor;
      if (hi < PLAUSIBLE_MIN || lo > PLAUSIBLE_MAX) { payDisclosed = false; withheldReason = 'implausible'; }
    }

    const [binLow, binHigh] = payDisclosed
      ? payBin(hasFloor ? floor : null, hasCeil ? ceil : null)
      : [-1, -1];

    // Post keys are (organisation, referenceDate, PUR, ordinal): 2,284 rows
    // across 252 files repeat a PUR inside one file. XX / N/A / blank are not
    // identifiers.
    let pur = cell(r, cPUR);
    if (/^(xx+|n\/?a|none|-+)$/i.test(pur)) pur = '';
    const ordinal = pur ? (seenPUR.set(pur, (seenPUR.get(pur) || 0) + 1), seenPUR.get(pur) - 1) : 0;

    let reportsTo = cell(r, cReports);
    if (/^(xx+|n\/?a|none|-+)$/i.test(reportsTo)) reportsTo = '';

    const fte = parseFTE(cell(r, cFTE));
    const cost = parseMoney(cell(r, cCost));

    posts.push({
      pur, ordinal, status, holder,
      title: title.slice(0, 160),
      unit: cell(r, cUnit).slice(0, 120),
      organisation: cell(r, cOrg).slice(0, 120),
      parentDept: cell(r, cParent).slice(0, 120),
      reportsTo,
      salaryCostOfReports: Number.isFinite(cost) ? Math.round(cost) : null,
      region: cell(r, cRegion).slice(0, 60),
      gradeRaw: grade.raw, gradeBand: grade.band, gradeVariant: grade.variant,
      profRaw: prof.raw, prof: prof.prof, profSource: prof.source,
      ddat: isDDaT(prof.prof, title) ? 1 : 0,
      pol: isPolicy(prof.prof, title) ? 1 : 0,
      fte, fteKnown: fte != null ? 1 : 0,
      floor: hasFloor ? floor : null,
      ceil: hasCeil ? ceil : null,
      payDisclosed, withheldReason, binLow, binHigh,
    });
  }

  if (!posts.length) return reject('no-rows-survived', { blankRows, invalidDropped });

  return {
    ok: true, reason: null, posts,
    stats: {
      dataRows: body.length, blankRows, invalidDropped, validApplied,
      hasValidCol: cValid >= 0, graded, senior,
      juniorRows: posts.filter(p => p.gradeBand === 'Below SCS').length,
      disclosed: posts.filter(p => p.payDisclosed).length,
    },
  };
}

function reject(reason, detail) {
  return { ok: false, reason, posts: [], stats: { ...detail } };
}

function isFlaggedInvalid(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '0' || s === 'no' || s === 'n' || s === 'false';
}
