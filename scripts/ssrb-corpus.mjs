// The SSRB corpus: every Senior Salaries Review Body report gov.uk publishes,
// turned into searchable text with page-level provenance, plus a parser for the
// market-gap figure that was previously hand-transcribed off a chart.
//
// Why this exists. The single most quotable number in this study — how far SCS
// pay sits below its private-sector comparator — came from a figure in a PDF,
// typed in by hand and labelled `hypothesis`. That is the weakest provenance on
// a page whose entire argument is provenance. It is also the number a reader is
// most likely to repeat.
//
// Three things this discovered that a hand-transcription hides:
//
//   1. THE FIGURE NUMBER MOVES BETWEEN EDITIONS. "Figure 3.7" is the market gap
//      in the 47th report (2025) and "external vs internal recruits" in the 2026
//      report. A citation of the form "SSRB Figure 3.7" is meaningless without
//      the edition, and following it in the wrong year lands on a different
//      chart entirely. Figures are matched by CAPTION here, never by number.
//   2. THE SERIES STOPS. The 2026 report contains no market comparison at all —
//      paragraph 3.54 says the Review Body "intend to explore this issue in
//      further detail in our next Report". A chart that silently ends in 2024
//      reads as data ending; it is the analysis that ended.
//   3. THE CAPTION AND THE NOTE DISAGREE. The caption says "total remuneration";
//      the note beneath the same figure says the percentages are "the difference
//      between SCS median salaries, and the private and public sector
//      benchmarks". Those are not the same quantity — total remuneration would
//      include the pension, which is the largest single component of the civil
//      service offer. Both readings are carried; neither is chosen.
//
//   node scripts/ssrb-corpus.mjs                 # fetch, extract, emit
//   node scripts/ssrb-corpus.mjs --search "..."  # retrieve passages, with pages
//   node scripts/ssrb-corpus.mjs --no-fetch      # work from the cache only
//
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache', 'ssrb');
const OUT = path.join(ROOT, 'public', 'data');
const STATE = path.join(ROOT, 'data', 'ssrb-corpus.json');
const SEARCH_API = 'https://www.gov.uk/api/search.json';
const CONTENT_API = 'https://www.gov.uk/api/content/';
const UA = 'scs-earnings-ssrb/1.0 (+https://strangeramblings.com)';
const SCHEMA = 1;

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const opt = (n) => { const i = ARGV.indexOf(n); return i >= 0 ? ARGV[i + 1] : null; };
const NO_FETCH = flag('--no-fetch');
const SEARCH = opt('--search');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  WARN', ...a);
const fatal = (m) => { console.error(`\nFATAL: ${m}`); process.exit(2); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const cmp = (a, b) => String(a).localeCompare(String(b));

async function getJSON(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 600 * (t + 1)));
  }
  return null;
}

// The cache key is the URL, never the edition year. Keying on the year meant a
// corrected attachment choice kept serving the previously cached document while
// the manifest recorded the new URL — the run reports one PDF and reads another,
// and nothing anywhere disagrees.
async function getPDF(url, name) {
  const f = path.join(CACHE, `${name.replace(/\.pdf$/, '')}-${sha(url).slice(0, 10)}.pdf`);
  try { const s = await stat(f); if (s.size > 10000) return f; } catch { /* fetch it */ }
  if (NO_FETCH) return null;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(180000) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        // A gov.uk error page served as a PDF is a real failure mode.
        if (buf.subarray(0, 4).toString() !== '%PDF') { warn(`${name}: not a PDF`); return null; }
        await writeFile(f, buf);
        return f;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1200 * (t + 1)));
  }
  return null;
}

// ---- pages -----------------------------------------------------------------
// -layout preserves the column geometry, which is the whole reason the figure
// below can be read at all: the data labels of a chart are positioned text, and
// their x offset is what says which series and which year they belong to.
// pdftotext separates pages with a form feed.
async function pages(pdfPath) {
  const { stdout } = await execFileAsync(
    'pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'],
    { maxBuffer: 256 << 20 },
  );
  return stdout.split('\f');
}

// ---- the market-gap figure -------------------------------------------------
// Matched by CAPTION, never by figure number — see the header.
const GAP_CAPTION = /Figure\s+(\d+\.\d+)\s*:\s*(.*?(?:difference|comparison).*?(?:remuneration|pay|salar).*?(?:private|public).*)/i;
const PCT = /(-?\d{1,3})\s*%/g;

// A percentage token and where it sits on the line.
//
// x is taken at the '%' sign, not at the start of the match. An axis column is
// RIGHT-aligned, so "  0%" and "-10%" begin in different columns and end in the
// same one; keying on the start splits one axis into two and lets its top tick
// through as a data label. That is how a 0% became a published figure for
// Deputy Director in the 2024 report.
function pctTokens(line) {
  const out = [];
  let m;
  PCT.lastIndex = 0;
  while ((m = PCT.exec(line)) !== null) out.push({ v: Number(m[1]), x: m.index + m[0].length });
  return out;
}

/**
 * Parse one market-gap figure out of a page.
 *
 * The chart is two panels (pay bands) x two series (private, public) x N years.
 * Axis ticks and data labels are both percentages, so the axis column has to be
 * removed first: it is the one x position that repeats on almost every line with
 * a regular arithmetic sequence of values.
 *
 * Every value is then assigned to the nearest YEAR label by x distance, and
 * within a year the values are ordered left to right and handed to the series in
 * legend order. That is the geometry the chart is drawn with, and it is checked
 * against the caption's own series count before anything is emitted.
 */
function parseGapFigure(pageText) {
  const lines = pageText.split('\n');
  const capIdx = lines.findIndex((l) => GAP_CAPTION.test(l));
  if (capIdx < 0) return null;
  const capM = lines[capIdx].match(GAP_CAPTION);
  // Captions wrap; take the continuation line when it is not blank and not a
  // legend or an axis.
  let caption = capM[2].trim();
  const next = (lines[capIdx + 1] || '').trim();
  if (next && !/%/.test(next) && !/^Source/i.test(next) && next.length < 120) caption += ' ' + next;

  const block = lines.slice(capIdx, capIdx + 60);

  // The legend is the first line carrying TWO OR MORE "<band> <sector>" pairs.
  //
  // Looser tests match the caption itself, which says "SCS ... private and
  // public" and so satisfies any "mentions a band and a sector" rule. Requiring
  // two complete pairs is what separates a legend from a sentence about one.
  const SERIES_RE = /((?:deputy\s+director|director|permanent\s+secretary|scs\s*\d?)\s+(?:private|public))/gi;
  let series = [];
  for (const l of block) {
    if (/^\s*Figure\s+\d/.test(l) || /%/.test(l)) continue;
    const found = [...l.matchAll(SERIES_RE)].map((m) => ({ label: m[1].replace(/\s+/g, ' ').trim(), x: m.index }));
    if (found.length >= 2) { series = found; break; }
  }
  if (series.length < 2) return null;

  // year axis: the line carrying the most 4-digit years
  let yearLine = null, best = 0;
  for (const l of block) {
    const ys = [...l.matchAll(/\b(20\d{2})\b/g)];
    if (ys.length > best) { best = ys.length; yearLine = l; }
  }
  if (!yearLine || best < 2) return null;
  const years = [...yearLine.matchAll(/\b(20\d{2})\b/g)].map((m) => ({ year: Number(m[1]), x: m.index }));

  // Collect every percentage, then drop the axis columns: an axis tick repeats
  // at one x on many lines. Data labels do not.
  const raw = [];
  for (const l of block) {
    if (l === yearLine) continue;
    for (const t of pctTokens(l)) raw.push(t);
  }
  const byX = new Map();
  for (const t of raw) {
    const k = Math.round(t.x / 3) * 3;      // tolerate a character of drift
    if (!byX.has(k)) byX.set(k, []);
    byX.get(k).push(t);
  }
  const axisX = new Set();
  for (const [k, list] of byX) {
    // an axis: 4+ values at one x, evenly spaced, spanning the plot
    if (list.length < 4) continue;
    const vs = [...new Set(list.map((t) => t.v))].sort((a, b) => a - b);
    if (vs.length < 4) continue;
    const gaps = vs.slice(1).map((v, i) => v - vs[i]);
    if (new Set(gaps).size === 1) axisX.add(k);
  }
  const data = raw.filter((t) => !axisX.has(Math.round(t.x / 3) * 3));
  if (!data.length) return null;

  // group by nearest year, then order within the year and hand to the series
  const perPanel = Math.max(1, Math.round(series.length / new Set(years.map((y) => y.year)).size ? 2 : 2));
  const groups = new Map();
  for (const t of data) {
    let bestY = years[0], bd = Infinity;
    for (const y of years) { const d = Math.abs(y.x - t.x); if (d < bd) { bd = d; bestY = y; } }
    const key = `${bestY.x}`;
    if (!groups.has(key)) groups.set(key, { year: bestY.year, x: bestY.x, vals: [] });
    groups.get(key).vals.push(t);
  }
  // panels: year labels repeat across panels, so the x order of the year groups
  // splits them — first half is panel 1, second half panel 2.
  const ordered = [...groups.values()].sort((a, b) => a.x - b.x);
  const distinctYears = [...new Set(ordered.map((g) => g.year))];
  const panels = Math.max(1, Math.round(ordered.length / distinctYears.length));
  const perPanelSeries = series.length / panels;

  const out = [];
  const unattributed = [];
  ordered.forEach((g, i) => {
    const panel = Math.floor(i / distinctYears.length);
    const mine = series.slice(panel * perPanelSeries, (panel + 1) * perPanelSeries);
    let vals = g.vals.slice().sort((a, b) => a.x - b.x);
    // A stray axis tick that survived removal lands in whichever year group is
    // nearest and makes the count disagree with the legend. Keep the labels
    // closest to the year's own x, and RECORD what was dropped rather than
    // quietly emitting a partial year — a missing 2022 that nobody counted is
    // how a chart loses its first data point without anyone noticing.
    if (vals.length > mine.length) {
      const keep = vals.slice().sort((a, b) => Math.abs(a.x - g.x) - Math.abs(b.x - g.x)).slice(0, mine.length);
      for (const v of vals) if (!keep.includes(v)) unattributed.push({ year: g.year, pct: v.v, x: v.x });
      vals = keep.sort((a, b) => a.x - b.x);
    }
    if (vals.length !== mine.length) {
      for (const v of vals) unattributed.push({ year: g.year, pct: v.v, x: v.x });
      return;
    }
    vals.forEach((v, j) => out.push({ series: mine[j].label, year: g.year, pct: v.v }));
  });
  if (!out.length) return null;

  const sourceLine = block.find((l) => /^\s*Source:/i.test(l)) || null;
  const noteIdx = block.findIndex((l) => /^\s*Note:/i.test(l));
  const note = noteIdx >= 0 ? block.slice(noteIdx, noteIdx + 5).join(' ').replace(/\s+/g, ' ').trim() : null;

  return {
    figureNo: capM[1],
    caption,
    unattributed,
    series: out.sort((a, b) => cmp(a.series, b.series) || a.year - b.year),
    source: sourceLine ? sourceLine.replace(/\s+/g, ' ').trim() : null,
    note,
  };
}

/**
 * The other shape this figure comes in.
 *
 * The 2024 report draws the same comparison with PAY BANDS on the x axis, one
 * year (from the caption) and a single sector. Same question, different chart,
 * and the year-axis parser correctly refuses it rather than guessing — which is
 * why this exists as its own reader instead of a looser version of the first.
 */
function parseGapFigureByBand(pageText) {
  const lines = pageText.split('\n');
  const capIdx = lines.findIndex((l) => GAP_CAPTION.test(l));
  if (capIdx < 0) return null;
  const capM = lines[capIdx].match(GAP_CAPTION);
  let caption = capM[2].trim();
  const cont = (lines[capIdx + 1] || '').trim();
  if (cont && !/%/.test(cont) && !/^Source/i.test(cont)) caption += ' ' + cont;

  const block = lines.slice(capIdx, capIdx + 40);
  const year = Number((caption.match(/\b(20\d{2})\b/) || [])[1]);
  if (!year) return null;
  const sector = /private/i.test(caption) && /public/i.test(caption) ? null
    : /private/i.test(caption) ? 'Private' : /public/i.test(caption) ? 'Public' : null;
  if (!sector) return null;                       // two sectors: the other reader owns it

  // the category line: band names, no percentages
  const BAND_RE = /(deputy\s+director\s*1a|deputy\s+director|permanent\s+secretary|director)/gi;
  let cats = [];
  for (const l of block) {
    if (/^\s*Figure\s+\d/.test(l) || /%/.test(l)) continue;
    const found = [...l.matchAll(BAND_RE)].map((m) => ({ label: m[1].replace(/\s+/g, ' ').trim(), x: m.index }));
    if (found.length >= 2) { cats = found; break; }
  }
  if (cats.length < 2) return null;

  // data labels: percentages that are not on the axis column
  const raw = [];
  for (const l of block) for (const t of pctTokens(l)) raw.push(t);
  const byX = new Map();
  for (const t of raw) {
    const k = Math.round(t.x / 3) * 3;
    if (!byX.has(k)) byX.set(k, []);
    byX.get(k).push(t);
  }
  const axisX = new Set();
  for (const [k, list] of byX) {
    const vs = [...new Set(list.map((t) => t.v))].sort((a, b) => a - b);
    if (vs.length < 4) continue;
    const gaps = vs.slice(1).map((v, i) => v - vs[i]);
    if (new Set(gaps).size === 1) axisX.add(k);
  }
  // The value axis of this chart shape sits to the LEFT of every category
  // label, which is a far more reliable test than looking for an evenly spaced
  // run: the run test misses an axis whose top tick is "0%" where the rest are
  // negative, because the minus sign shifts the column.
  const leftEdge = Math.min(...cats.map((c) => c.x)) - 2;
  const data = raw.filter((t) => !axisX.has(Math.round(t.x / 3) * 3) && t.x >= leftEdge);
  if (!data.length) return null;

  const out = [];
  const unattributed = [];
  for (const t of data) {
    let best = null, bd = Infinity;
    for (const c of cats) { const d = Math.abs(c.x - t.x); if (d < bd) { bd = d; best = c; } }
    // A label more than a category-width away belongs to nothing we can name.
    if (!best || bd > 22) { unattributed.push({ year, pct: t.v, x: t.x }); continue; }
    out.push({ series: `${best.label} ${sector}`, year, pct: t.v });
  }
  if (!out.length) return null;

  const sourceLine = block.find((l) => /^\s*Source:/i.test(l)) || null;
  const noteIdx = block.findIndex((l) => /^\s*Note:/i.test(l));
  return {
    figureNo: capM[1],
    caption,
    shape: 'band-axis',
    unattributed,
    series: out.sort((a, b) => cmp(a.series, b.series) || a.year - b.year),
    source: sourceLine ? sourceLine.replace(/\s+/g, ' ').trim() : null,
    note: noteIdx >= 0 ? block.slice(noteIdx, noteIdx + 5).join(' ').replace(/\s+/g, ' ').trim() : null,
  };
}

// ---- retrieval -------------------------------------------------------------
// A small BM25 over page-level chunks. No dependencies, and page-level is the
// right grain because a citation a reader can check is "edition, page".
const STOP = new Set('the a an and or of to in for on is are was were be been by with as at from that this it its'.split(' '));
const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9£%.\- ]+/g, ' ').split(/\s+/)
  .filter((t) => t.length > 1 && !STOP.has(t));

function buildIndex(docs) {
  const df = new Map();
  const items = docs.map((d) => {
    const t = toks(d.text);
    const tf = new Map();
    for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return { ...d, tf, len: t.length };
  });
  const avg = items.reduce((a, i) => a + i.len, 0) / Math.max(1, items.length);
  return { items, df, avg, N: items.length };
}

function search(idx, query, k = 8) {
  const q = toks(query);
  const K1 = 1.5, B = 0.75;
  const scored = idx.items.map((it) => {
    let s = 0;
    for (const w of q) {
      const f = it.tf.get(w);
      if (!f) continue;
      const n = idx.df.get(w) || 0;
      const inv = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
      s += inv * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (it.len / idx.avg)));
    }
    return { ...it, score: s };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

// ---- main ------------------------------------------------------------------
async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(path.dirname(STATE), { recursive: true });

  log('[1/4] discovering editions ...');
  const found = new Map();
  for (const q of ['Senior Salaries Review Body Report', 'Review Body on Senior Salaries report on senior salaries']) {
    const r = await getJSON(`${SEARCH_API}?q=${encodeURIComponent(q)}&count=50&fields=title,link,public_timestamp`);
    for (const it of (r?.results || [])) {
      const link = it.link || '';
      if (!/senior-salaries|senior salaries/i.test(link + it.title)) continue;
      if (/collection/i.test(link)) continue;
      const yr = Number((it.title.match(/\b(19|20)\d{2}\b/) || [])[0] || (it.public_timestamp || '').slice(0, 4));
      if (!yr) continue;
      // Several SSRB publications exist per year — the annual report, a
      // supplementary report, remit letters, police and prison supplements.
      // Keeping the most recently published one picks a supplement, which is a
      // real document with none of the main chapters in it. Score the SLUG.
      const slug = link.toLowerCase();
      let ps = 0;
      if (/supplement|letter|remit|police|prison|armed|military|evidence|triennial|annex/.test(slug)) ps -= 100;
      if (new RegExp(`senior-salaries-review-body-report-${yr}$`).test(slug)) ps += 40;
      if (/report/.test(slug)) ps += 10;
      const prev = found.get(yr);
      if (!prev || ps > prev.score || (ps === prev.score && (it.public_timestamp || '') > (prev.ts || ''))) {
        found.set(yr, { year: yr, title: it.title, path: link.replace(/^\//, ''), ts: it.public_timestamp, score: ps });
      }
    }
  }
  const editions = [...found.values()].sort((a, b) => b.year - a.year);
  log(`  ${editions.length} candidate editions, ${editions[editions.length - 1]?.year} to ${editions[0]?.year}`);

  log('\n[2/4] fetching + extracting ...');
  const docs = [];
  const records = [];
  for (const e of editions) {
    const c = await getJSON(CONTENT_API + e.path);
    const atts = (c?.details?.attachments || []).filter((a) => /\.pdf($|\?)/i.test(a.url || ''));
    if (!atts.length) { warn(`${e.year}: no PDF attachment`); continue; }
    // Editions ship several PDFs and the first is not the report. 2025 leads
    // with "Supplement to the 47th Report" and 2026 with a Supplementary
    // Report; both are real documents and neither carries the main chapters.
    // Prefer a main annual report, and say which was chosen.
    const score = (a) => {
      const t = `${a.title || ''} ${a.url || ''}`.toLowerCase();
      let s = 0;
      if (/supplement|letter|police|prison|military|armed forces|triennial|annex|evidence|summary|remit/.test(t)) s -= 100;
      // The main report is invariably the largest attachment on its page.
      s += Math.min(20, Math.round((a.file_size || 0) / (500 * 1024)));
      if (/\b(annual\s+)?report\b/.test(t)) s += 10;
      if (/\b\d{2}(st|nd|rd|th)\s+report\b/.test(t)) s += 15;
      if (/accessible|web/.test(t)) s += 2;
      return s;
    };
    const att = atts.slice().sort((a, b) => score(b) - score(a))[0];
    if (atts.length > 1) log(`  ${e.year}  chose "${(att.title || att.url).slice(0, 56)}" of ${atts.length} attachments`);
    const f = await getPDF(att.url, `ssrb-${e.year}.pdf`);
    if (!f) { warn(`${e.year}: PDF unavailable`); continue; }
    let ps;
    try { ps = await pages(f); } catch (err) { warn(`${e.year}: pdftotext failed — ${err.message}`); continue; }
    ps.forEach((text, i) => { if (text.trim().length > 200) docs.push({ year: e.year, page: i + 1, text }); });
    records.push({
      year: e.year, title: e.title, page: 'https://www.gov.uk/' + e.path,
      pdf: att.url, publicUpdatedAt: c?.public_updated_at || null, pages: ps.length,
    });
    log(`  ${e.year}  ${String(ps.length).padStart(3)} pages  ${att.url.split('/').pop().slice(0, 52)}`);
  }
  if (!records.length) fatal('no SSRB report could be fetched or parsed');

  log('\n[3/4] parsing the market-gap figure ...');
  const gaps = [];
  for (const d of docs) {
    const g = parseGapFigure(d.text) || parseGapFigureByBand(d.text);
    if (!g) continue;
    gaps.push({ ...g, year: d.year, page: d.page, edition: records.find((r) => r.year === d.year) });
  }
  for (const g of gaps) {
    log(`  ${g.year} p.${g.page}  Figure ${g.figureNo}  ${g.series.length} points  ${[...new Set(g.series.map((s) => s.series))].join(' / ')}`);
  }
  const editionsWithout = records.filter((r) => !gaps.some((g) => g.year === r.year)).map((r) => r.year).sort();

  // Cross-edition restatements. The same year, published twice, with different
  // numbers. This is the finding a single-edition transcription cannot see, and
  // it is larger than most of the movements the series is used to argue about.
  const byKey = new Map();
  for (const g of gaps) {
    for (const pt of g.series) {
      const band = pt.series.replace(/\s+(private|public)$/i, '').toLowerCase().replace(/\s+/g, ' ');
      const sector = (pt.series.match(/(private|public)$/i) || [])[1]?.toLowerCase() ?? '';
      const k = `${band}|${sector}|${pt.year}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ edition: g.year, page: g.page, figureNo: g.figureNo, pct: pt.pct });
    }
  }
  const restatements = [];
  for (const [k, list] of byKey) {
    const vals = [...new Set(list.map((x) => x.pct))];
    if (list.length < 2 || vals.length < 2) continue;
    const [band, sector, year] = k.split('|');
    const sorted = list.slice().sort((a, b) => a.edition - b.edition);
    restatements.push({
      band, sector, year: Number(year),
      readings: sorted,
      spreadPoints: Math.max(...vals) - Math.min(...vals),
    });
  }
  restatements.sort((a, b) => b.spreadPoints - a.spreadPoints);
  if (restatements.length) {
    log(`\n  ${restatements.length} restatement(s) — the same year published with different numbers:`);
    for (const rs of restatements.slice(0, 6)) {
      log(`    ${rs.band} ${rs.sector} ${rs.year}: ` + rs.readings.map((x) => `${x.pct}% (${x.edition} ed., Fig ${x.figureNo})`).join('  vs  ')
        + `   spread ${rs.spreadPoints} pts`);
    }
  }

  // Anchors. A layout change in a future edition must not silently reshape a
  // series that is already published — the failure mode of every PDF parser is
  // that it keeps returning plausible numbers after the document moves.
  const ANCHORS = [
    { edition: 2025, series: 'Deputy director Private', year: 2022, pct: -40 },
    { edition: 2025, series: 'Deputy director Private', year: 2024, pct: -31 },
    { edition: 2025, series: 'Director Private', year: 2022, pct: -54 },
    { edition: 2025, series: 'Director Public', year: 2024, pct: -25 },
    { edition: 2024, series: 'Director Private', year: 2023, pct: -65 },
  ];
  const failedAnchors = [];
  for (const a of ANCHORS) {
    const fig = gaps.find((g) => g.year === a.edition);
    const pt = fig?.series.find((s) => s.series === a.series && s.year === a.year);
    if (!pt || pt.pct !== a.pct) {
      failedAnchors.push(`${a.edition} ed. ${a.series} ${a.year}: expected ${a.pct}%, got ${pt ? pt.pct + '%' : 'nothing'}`);
    }
  }
  if (failedAnchors.length) {
    fatal(`the published charts no longer parse as they did:\n  ${failedAnchors.join('\n  ')}\n`
      + '  Re-read the figure in the PDF before trusting anything this script emits.');
  }
  log(`  ${ANCHORS.length} anchor values still parse as published`);

  log('\n[4/4] writing ...');
  const payload = {
    schema: SCHEMA,
    purpose: 'The SSRB market-gap series, parsed from the published charts rather than transcribed by hand, with the page it came from.',
    licence: 'UK Open Government Licence (OGL)',
    caveats: [
      'Figure numbers move between editions: the market gap is Figure 3.7 in the 47th report (2025) and Figure 3.7 is a different chart entirely in the 2026 report. Figures here are matched by caption, never by number.',
      'The caption says "total remuneration" while the note beneath the same figure says the percentages are the difference between median SALARIES. Those are not the same quantity — total remuneration would include the employer pension contribution, which is the largest component of the civil service offer. Both readings are recorded; neither is chosen.',
      'Korn Ferry updated their civil service reference levels in October 2023, so the 2022 percentages are not comparable with 2023 and later. The break is carried on every series.',
      'The underlying data is described by the publisher as "Cabinet Office data (unpublished)". This is a published chart of an unpublished series: the percentages can be cited, the series behind them cannot be checked.',
      'The same year has been published with different numbers in consecutive editions — see restatements. The gap you quote depends on which report you read, which is a bigger source of variation than most of the year-on-year movement the series is used to describe.',
      'The series stops after the 2024 data point. The 2026 report contains no market comparison and says the Review Body intends to return to it. That is the analysis ending, not the gap closing.',
    ],
    editions: records.sort((a, b) => b.year - a.year),
    editionsWithoutTheFigure: editionsWithout,
    restatements,
    figures: gaps.map((g) => ({
      edition: g.year,
      page: g.page,
      figureNo: g.figureNo,
      caption: g.caption,
      source: g.source,
      note: g.note,
      breakAt: 2023,
      points: g.series,
      // Values the parser could see but could not attribute to a series with
      // confidence. Published rather than dropped: a silently incomplete series
      // is the failure this whole script exists to remove.
      unattributed: g.unattributed || [],
      complete: (g.unattributed || []).length === 0,
      provenance: {
        pdf: g.edition?.pdf ?? null,
        publicUpdatedAt: g.edition?.publicUpdatedAt ?? null,
        extraction: 'pdftotext -layout, data labels assigned to year groups by x position',
        blockSha: sha(JSON.stringify(g.series)),
      },
    })),
  };
  await writeFile(path.join(OUT, 'ssrb-gap.json'), JSON.stringify(payload));

  // The corpus itself stays out of public/: it is ~500 KB of text per edition
  // and nothing renders it. It is the retrieval index for --search.
  await writeFile(STATE, JSON.stringify({
    schema: SCHEMA,
    editions: records,
    pages: docs.map((d) => ({ year: d.year, page: d.page, text: d.text })),
  }));

  const kb = (JSON.stringify(payload).length / 1024).toFixed(1);
  log(`  public/data/ssrb-gap.json   ${kb} KB   ${payload.figures.length} figure(s) across ${records.length} editions`);
  log(`  data/ssrb-corpus.json       ${docs.length} pages indexed for --search`);
  if (editionsWithout.length) log(`  editions with no market-gap figure: ${editionsWithout.join(', ')}`);
}

if (SEARCH) {
  const raw = await readFile(STATE, 'utf8').catch(() => null);
  if (!raw) fatal('no corpus yet — run without --search first');
  const st = JSON.parse(raw);
  const idx = buildIndex(st.pages);
  const hits = search(idx, SEARCH, Number(opt('--k') || 6));
  log(`\n"${SEARCH}" — ${hits.length} passage(s) from ${st.editions.length} editions\n`);
  for (const hitItem of hits) {
    const ed = st.editions.find((e) => e.year === hitItem.year);
    log(`── SSRB ${hitItem.year}, page ${hitItem.page}  (score ${hitItem.score.toFixed(2)})`);
    log(`   ${ed?.pdf || ''}`);
    const q = toks(SEARCH);
    const best = hitItem.text.split('\n')
      .map((l) => ({ l, n: q.filter((t) => l.toLowerCase().includes(t)).length }))
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 4);
    for (const b of best) log(`   | ${b.l.trim().replace(/\s+/g, ' ').slice(0, 150)}`);
    log('');
  }
} else {
  await main();
}
