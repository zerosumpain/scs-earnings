// Method tab: methodology & definitions, coverage-completeness matrix,
// banded-pay uncertainty, classifier audit, provenance/reproducibility,
// CPIH deflator transparency, caveats.
import { series, type DataSet } from './data';
import { heatmap } from './charts';
import { gbp, num } from './format';
import { h } from './dom';

function card(title: string, sub: string, body: HTMLElement): HTMLElement {
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [h('div', {}, [h('h3', {}, [title]), h('div', { class: 'card-sub' }, [sub])])]), body,
  ]);
}

export function renderMethod(main: HTMLElement, ds: DataSet) {
  const s = ds.meta.stats;
  main.append(h('div', { class: 'hero' }, [
    h('div', { class: 'label' }, ['Method, sources & honesty']),
    h('h1', {}, ['How this', document.createElement('br'), 'was built']),
    h('p', { class: 'sub' }, ['Every figure here traces back to published gov.uk transparency data. This page documents exactly what the numbers are, what they are not, and where the uncertainty lives — so you can check the tool rather than trust it.']),
  ]));
  const canvas = h('div', { class: 'canvas', style: { paddingBottom: '50px' } });
  main.append(canvas);

  // provenance tiles
  canvas.append(h('div', { class: 'tiles' }, [
    tile('Departments', num(s.departments)),
    tile('Data releases', num(s.snapshots)),
    tile('Senior posts', num(s.posts)),
    tile('Coverage', `${s.dateRange[0].slice(0, 4)}–${s.dateRange[1].slice(0, 4)}`),
  ]));

  // methodology prose
  const prose = h('div', { class: 'prose' });
  prose.innerHTML = `
    <h3>What the data is</h3>
    <p>Since 2010, every central government department must publish an <b>organogram of staff roles and salaries</b> twice a year as a transparency requirement. The "senior" file lists every post in the <b>Senior Civil Service</b> (SCS) — grades SCS1 (Deputy Director) through SCS4 / Permanent Secretary — with its job title, professional group, full-time-equivalent, and a <b>pay band</b> (a floor and a ceiling). This tool gathers those senior files for ${s.departments} main departments, ${s.snapshots} releases in all, straight from <b>data.gov.uk</b>.</p>

    <h3>How pay is measured</h3>
    <p>Pay is disclosed as a <b>band</b>, not an exact figure: posts below £150k are shown in £5,000 bands, and posts at or above £150k are shown individually. Unless you switch it, every pay figure here is the <b>midpoint</b> of the band. Medians and percentiles are read off an additive £5,000-bin histogram, so they are accurate to within about ±£2,500 — the same granularity as the source banding. "Mean (per FTE)" and the pay bill weight each post by its FTE; the plain median and mean weight each post equally.</p>

    <h3>Aligning snapshots over time</h3>
    <p>Departments file on slightly different dates (nominally 31 March and 30 September, but often a few weeks later, and some file quarterly). To make departments comparable, snapshots are bucketed into <b>half-year periods</b> (H1 / H2); where a department filed more than once in a period, the latest filing is used. Machinery-of-government changes mean departments are created, merged and renamed — clean renames are stitched into one series (e.g. the Department of Health becoming DHSC), but genuine splits (e.g. BEIS into DBT / DESNZ / DSIT in 2023) are kept as separate entities and grouped by family.</p>

    <h3>Role classification (the glass box)</h3>
    <p>Each post is tagged with a canonical <b>profession</b> from its "Professional/Occupational Group" field (falling back to keywords in the job title when that field is blank). A post is flagged <b>DDaT</b> (Digital, Data &amp; Technology) if its profession is DDaT <i>or</i> its title mentions digital, data, technology, IT, cyber, software, CIO/CDO/CTO. It is flagged <b>Policy</b> if its profession is Policy or its title contains "policy". These rules are deterministic and listed below — nothing is hand-curated.</p>
  `;
  canvas.append(card('Methodology & definitions', 'What the numbers are, and what they are not', prose));

  // coverage matrix
  const covRes = series(ds, { depts: null }, 'headcount', 'department');
  const covHost = h('div', {});
  heatmap(covHost, {
    cols: covRes.periods,
    rows: [...covRes.groups].sort((a, b) => a.label.localeCompare(b.label)).map(g => ({ key: g.key, label: g.label })),
    value: (rowKey, col) => { const g = covRes.groups.find(x => x.key === rowKey); return g?.values[col] ?? null; },
    format: (n) => n == null ? 'no data' : num(n) + ' posts',
    diverging: false,
  });
  canvas.append(card('Coverage completeness matrix', 'Senior-post count for each department in each half-year period — blanks are periods a department did not file (or did not yet exist)', covHost));

  // banded-pay uncertainty
  const widths = ds.notable.filter(p => p.floor != null && p.ceil != null && p.ceil! > p.floor!).map(p => p.ceil! - p.floor!);
  const avgW = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
  const band = h('div', { class: 'prose' });
  band.innerHTML = `<p>Among the ${num(ds.notable.length)} individually-disclosed senior posts (£150k+ or Permanent Secretary), the average pay band spans <b>${gbp(Math.round(avgW))}</b> from floor to ceiling. Because the true salary sits somewhere in that band, every aggregate carries that uncertainty. The Top-earners explorer shows the full floor-to-ceiling band for each post so you can see it directly rather than trusting a single midpoint.</p>`;
  canvas.append(card('Banded-pay uncertainty', 'Pay is a range, not a point — here is how wide', band));

  // classifier audit — profession list + flags
  const profTable = h('div', { class: 'table-scroll' });
  const t = document.createElement('table'); t.className = 'records-table';
  t.innerHTML = `<thead><tr><th>Profession (canonical)</th><th>Senior posts, latest</th><th>Flags it can carry</th></tr></thead>`;
  const latest = series(ds, { profs: null }, 'headcount', 'profession');
  const li = latest.periods.length - 1;
  const tb = document.createElement('tbody');
  [...latest.groups].sort((a, b) => (b.values[li] ?? 0) - (a.values[li] ?? 0)).forEach(g => {
    const isDDaT = g.label === 'Digital, Data & Technology';
    const isPol = g.label === 'Policy';
    const flags = [isDDaT ? '<span class="pill ddat">DDaT</span>' : '', isPol ? '<span class="pill policy">Policy</span>' : '', '<span class="pill">+ title keywords</span>'].filter(Boolean).join(' ');
    tb.innerHTML += `<tr><td>${g.label}</td><td class="money">${num(g.values[li] ?? 0)}</td><td>${flags}</td></tr>`;
  });
  t.append(tb); profTable.append(t);
  canvas.append(card('Classifier audit', 'The deterministic profession taxonomy and how DDaT / Policy flags are assigned', profTable));

  // deflator transparency
  const cpihWrap = h('div', { class: 'prose' });
  const idx = ds.meta.cpih.index;
  const yrs = Object.keys(idx).map(Number).sort();
  cpihWrap.innerHTML = `<p>The real-terms toggle expresses every pay figure in <b>constant present-day (latest-year) pounds</b> — i.e. "today's money" — by deflating with the ONS <b>CPIH</b> index (itself based at 2015 = 100), source: <i>${ds.meta.cpih.source}</i>. The most recent snapshot is therefore unchanged; earlier pay is scaled up to today's prices. The index used:</p>` +
    `<div class="table-scroll"><table class="data-table"><thead><tr><th>Year</th>${yrs.map(y => `<th>${y}</th>`).join('')}</tr></thead><tbody><tr><td class="tperiod">CPIH</td>${yrs.map(y => `<td>${idx[y].toFixed(1)}</td>`).join('')}</tr></tbody></table></div>`;
  canvas.append(card('Real-terms deflator transparency', 'The exact CPIH series behind the real-terms toggle', cpihWrap));

  // caveats + provenance ledger
  const cav = h('div', { class: 'prose' });
  cav.innerHTML = `
    <h3>Caveats</h3>
    <ul>
      <li><b>Bands, not salaries.</b> Midpoints approximate; individuals may sit anywhere in the band.</li>
      <li><b>Scope is the main departments.</b> Arm's-length bodies and agencies are excluded, so this is not the whole SCS pay bill — it is the core departmental picture.</li>
      <li><b>Vacant posts and £0/nil rows are dropped</b>, as are rows with implausible pay (&lt;£30k or &gt;£800k) that indicate data-entry errors.</li>
      <li><b>Profession fields are self-reported</b> by departments and their quality varies; "Other / Not stated" absorbs the unclassifiable.</li>
      <li><b>"More than the PM"</b> compares post pay-band midpoints to the PM's salary entitlement; it is a recognisable benchmark, not a statement about any named individual.</li>
    </ul>
    <h3>Provenance &amp; reproducibility</h3>
    <p>Source: <b>${ds.meta.source.name}</b> via ${ds.meta.source.via}. Data generated <b>${ds.meta.generated.slice(0, 10)}</b> from ${num(s.filesOk)} senior files (${num(s.filesFail)} unreadable files skipped). The full ingestion pipeline is deterministic and re-runnable; each figure can be traced to a department, a snapshot date, and a source CSV.</p>
    <div class="callout">This is an independent analytical tool built on open data. It is not a government publication and carries no official status.</div>
  `;
  canvas.append(card('Caveats & provenance', 'The honest limits of what this shows', cav));
}

function tile(label: string, value: string): HTMLElement {
  return h('div', { class: 'tile' }, [h('div', { class: 't-label' }, [label]), h('div', { class: 't-val tabular' }, [value])]);
}
