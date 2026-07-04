// Shared pure helpers for the SCS earnings ingestion pipeline.
// No external deps — Node 22 built-ins only. Kept dependency-free so the
// pipeline runs anywhere and the logic is unit-testable in isolation.

// ---- CSV parsing (RFC-4180-ish state machine, tolerant of stray CR/BOM) ----
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  // strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // flush trailing field/row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
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

export function parseFTE(s) {
  const v = parseFloat(String(s ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(v) || v <= 0 || v > 5) return 1.0; // default a sensible 1.0 FTE
  return v;
}

// ---- snapshot date extraction from a resource URL ----
const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7,
  august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

export function extractDate(url) {
  const u = decodeURIComponent(url);
  // Pattern B (new resources): "...-2025-03-31-organogram-senior.csv"
  let m = u.match(/(\d{4})-(\d{2})-(\d{2})-organogram/i);
  if (m) return iso(+m[1], +m[2], +m[3]);
  // Pattern A (legacy path): ".../organogram/<dept>/<D>/<M>/<YYYY>/..."
  m = u.match(/\/organogram\/[^/]+\/(\d{1,2})\/(\d{1,2})\/(\d{4})\//);
  if (m) return iso(+m[3], +m[2], +m[1]);
  // filename D-M-YYYY e.g. "__31-03-2012__"
  m = u.match(/(\d{1,2})-(\d{1,2})-(20\d{2})(?!\d)/);
  if (m && +m[1] <= 31 && +m[2] <= 12) return iso(+m[3], +m[2], +m[1]);
  // generic YYYY-MM-DD anywhere
  m = u.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m && +m[2] <= 12 && +m[3] <= 31) return iso(+m[1], +m[2], +m[3]);
  // month-name + year (older gov.uk files) -> snap to reporting date
  const low = u.toLowerCase();
  // trailing `20\d\d` not followed by another digit — handles gov.uk's `_20`
  // space-encoding where "september_202010" means "september 2010".
  const ym = low.match(/(january|february|march|april|may|june|july|august|september|october|november|december)[^0-9]{0,4}\d*?(20\d{2})(?!\d)/);
  if (ym) {
    const mo = MONTHS[ym[1]];
    const yr = +ym[2];
    // transparency snapshots are 31 Mar or 30 Sep; snap nearest
    if (mo <= 6) return iso(yr, 3, 31);
    return iso(yr, 9, 30);
  }
  return null;
}

function iso(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---- classification ----
export function normGrade(raw) {
  const s = String(raw || '').toLowerCase();
  if (/perm(anent)?\s*sec|cabinet secretary|scs\s*4|scs4|scs pay band 4|pay band 4|\bpb4\b|second permanent/.test(s)) return 'SCS4 / Perm Sec';
  if (/director general|\bdg\b|scs\s*3|scs3|scs pay band 3|pay band 3|\bpb3\b/.test(s)) return 'SCS3 (Dir Gen)';
  if (/deputy director|\bdd\b|scs\s*1|scs1|scs pay band 1|pay band 1|\bpb1\b/.test(s)) return 'SCS1 (Dep Dir)';
  if (/director|scs\s*2|scs2|scs pay band 2|pay band 2|\bpb2\b/.test(s)) return 'SCS2 (Dir)';
  if (/scs/.test(s)) return 'SCS (band n/s)';
  return 'Other / Not stated';
}

const PROF_RULES = [
  ['Policy', /policy/],
  ['Economics', /econom/],
  ['Finance', /financ|account/],
  ['Digital, Data & Technology', /digital|\bdata\b|technolog|\bit\b|\bict\b|cyber|software|\bcio\b|\bcdo\b|\bcto\b|information (technolog|management)|architect/],
  ['Legal', /legal|\blaw\b|solicitor|counsel|barrister/],
  ['Tax', /\btax\b|revenue/],
  ['Commercial', /commercial|procure|contract management/],
  ['Project Delivery', /project|programme|portfolio/],
  ['Human Resources', /human resource|\bhr\b|people|workforce|reward/],
  ['Communications', /communicat|\bcomms\b|media|press|marketing|external affairs/],
  ['Science & Engineering', /scien|engineer|\bstem\b/],
  ['Statistics', /statistic|\bstats?\b|analysis|analyst|data science/],
  ['Internal Audit & Risk', /audit|\brisk\b|assurance/],
  ['Operational Delivery', /operational|operations|op del|service delivery|casework/],
  ['Medical & Health', /medic|clinical|\bnurs|\bhealth\b|public health/],
  ['Intelligence & Security', /intelligence|national security|counter[- ]terror/],
  ['Property & Estates', /property|estates?|facilit|surveyor/],
  ['Tax', /customs/],
];

export function normProfession(rawGroup, jobTitle) {
  const g = String(rawGroup || '').toLowerCase();
  for (const [name, re] of PROF_RULES) if (re.test(g)) return name;
  // fall back to inferring from job title when the group is blank/other
  const jt = String(jobTitle || '').toLowerCase();
  if (g === '' || /other|not (stated|applicable)|n\/?a|unknown|general|corporate/.test(g)) {
    for (const [name, re] of PROF_RULES) if (re.test(jt)) return name;
  }
  return 'Other / Not stated';
}

export function isDDaT(prof, jobTitle) {
  if (prof === 'Digital, Data & Technology') return true;
  return /\bdigital\b|\bdata\b|technolog|\bit\b|\bict\b|\bcio\b|\bcdo\b|\bcto\b|cyber|software/i.test(String(jobTitle || ''));
}

export function isPolicy(prof, jobTitle) {
  if (prof === 'Policy') return true;
  return /\bpolicy\b/i.test(String(jobTitle || ''));
}

// bin width for the additive pay histogram (matches the £5k transparency banding)
export const BIN = 5000;
export function payBin(mid) { return Math.floor(mid / BIN); }
