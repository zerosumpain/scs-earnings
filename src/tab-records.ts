// Top earners tab: "more than the PM" tracker, £150k+ watch, searchable
// sortable post-level explorer (perm secs + £150k+ posts), fastest-rising
// department league table.
import { series, countAbove, cagr, type DataSet, type NotablePost } from './data';
import { lineChart, barChart } from './charts';
import { gbp, num, pct } from './format';
import { h, clear } from './dom';
import { stateToFilter, pmPayFor } from './query';
import type { AppState } from './state';

function card(title: string, sub: string, body: HTMLElement, tools?: HTMLElement): HTMLElement {
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [h('div', {}, [h('h3', {}, [title]), h('div', { class: 'card-sub' }, [sub])]), tools || h('div', {})]), body,
  ]);
}
const deptName = (ds: DataSet, id: string) => ds.meta.depts.find(d => d.id === id)?.name || id;

export function renderRecords(main: HTMLElement, ds: DataSet, state?: AppState) {
  const s = state || ({ depts: [], profs: [], grades: [], ddat: 0, policy: 0, realTerms: false } as any);
  const filter = stateToFilter(s);
  main.append(h('div', { class: 'hero' }, [
    h('div', { class: 'label' }, ['Top earners & thresholds']),
    h('h1', {}, ['The people at', document.createElement('br'), 'the top of the pile']),
    h('p', { class: 'sub' }, ['How many senior civil servants out-earn the Prime Minister, who sits above the £150k approval threshold, and the individual highest-paid posts — searchable and sortable.']),
  ]));
  const canvas = h('div', { class: 'canvas', style: { paddingBottom: '50px' } });
  main.append(canvas);

  // ---- 1. "More than the PM" tracker ----
  const pm = countAbove(ds, filter, (p) => pmPayFor(ds.periods[p]));
  const k150 = countAbove(ds, filter, () => 150000);
  const pmHost = h('div', {});
  lineChart(pmHost, {
    labels: pm.periods,
    series: [
      { key: 'pm', label: 'Posts paid > PM', color: '#c4570a', values: pm.above.map((v, i) => pm.total[i] ? v : null) },
      { key: '150', label: 'Posts paid > £150k', color: '#7d5bd0', values: k150.above.map((v, i) => k150.total[i] ? v : null) },
    ],
    yFormat: (n) => num(n), height: 300, yZero: true,
  });
  const li = lastNonNull(pm.above, pm.total);
  const note = li >= 0 ? `In ${pm.periods[li]}, ${num(pm.above[li])} senior posts had a pay-band midpoint above the Prime Minister’s ${gbp(pmPayFor(ds.periods[li]))} — ${pct(pm.total[li] ? pm.above[li] / pm.total[li] * 100 : 0, 1, false)} of all senior posts.` : '';
  canvas.append(card('More than the Prime Minister', 'Senior posts whose pay-band midpoint exceeds the PM’s salary, and the £150k approval threshold, over time', h('div', {}, [pmHost, note ? h('div', { class: 'callout' }, [note]) : h('div', {})])));

  // ---- 2. Fastest-rising department league table (median pay CAGR) ----
  const depRes = series(ds, { ...filter, depts: null }, 'medianPost', 'department');
  const movers = depRes.groups.map(g => {
    const fi = g.values.findIndex(v => v != null); let la = -1; for (let i = g.values.length - 1; i >= 0; i--) if (g.values[i] != null) { la = i; break; }
    if (fi < 0 || la <= fi) return null;
    const gr = cagr(g.values[fi], g.values[la], la - fi);
    return gr == null ? null : { key: g.key, label: deptName(ds, g.label === g.key ? g.key : g.key), value: gr };
  }).filter(Boolean) as { key: string; label: string; value: number }[];
  movers.sort((a, b) => b.value - a.value);
  const moverHost = h('div', {});
  barChart(moverHost, { rows: movers.map(m => ({ key: m.key, label: deptName(ds, m.key), value: m.value, color: m.value >= 0 ? '#5b8a2a' : '#b23a2a' })), valueFormat: (n) => pct(n, 1) + '/yr' });
  canvas.append(card('Fastest-rising departments', `Compound annual growth in median senior pay, first to latest snapshot (${s.realTerms ? 'real terms' : 'nominal'})`, moverHost));

  // ---- 3. Searchable / sortable top-earners explorer ----
  canvas.append(recordsExplorer(ds));
}

function lastNonNull(above: number[], total: number[]): number { for (let i = total.length - 1; i >= 0; i--) if (total[i]) return i; return -1; }

function recordsExplorer(ds: DataSet): HTMLElement {
  const posts = ds.notable;
  const depts = [...new Set(posts.map(p => p.dept))].sort();
  const grades = [...new Set(posts.map(p => p.grade))];
  let q = '', deptF = '', gradeF = '', ddatOnly = false, sortKey: 'mid' | 'date' = 'mid', page = 0;
  const PAGE = 40;

  const controls = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '10px' } });
  const search = Object.assign(document.createElement('input'), { type: 'search', placeholder: 'Search job title…',
    style: 'font-family:var(--font-body);font-size:var(--fs-label);padding:7px 10px;border:1.5px solid var(--card-border);background:transparent;border-radius:2px;min-width:200px;flex:1' });
  const deptSel = select(['All departments', ...depts.map(d => deptName(ds, d))], depts);
  const gradeSel = select(['All grades', ...grades], grades);
  const ddatChip = h('button', { class: 'chip' }, ['DDaT only']);
  const sortChip = h('button', { class: 'chip' }, ['Sort: pay ▼']);
  controls.append(search, deptSel.el, gradeSel.el, ddatChip, sortChip);

  const tableHost = h('div', {});
  const draw = () => {
    let rows = posts.filter(p =>
      (!q || p.title.toLowerCase().includes(q)) &&
      (!deptF || p.dept === deptF) &&
      (!gradeF || p.grade === gradeF) &&
      (!ddatOnly || p.ddat));
    rows.sort((a, b) => sortKey === 'mid' ? b.mid - a.mid : b.date.localeCompare(a.date));
    const shown = rows.slice(0, (page + 1) * PAGE);
    clear(tableHost);
    const t = document.createElement('table'); t.className = 'records-table';
    t.innerHTML = `<thead><tr><th>Job title</th><th>Department</th><th>Grade</th><th>Profession</th><th>Snapshot</th><th style="text-align:right">Pay band</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const p of shown) {
      const band = p.floor != null && p.ceil != null && p.floor !== p.ceil ? `${gbp(p.floor)}–${gbp(p.ceil)}` : gbp(p.mid);
      const pill = p.ddat ? '<span class="pill ddat">DDaT</span>' : p.pol ? '<span class="pill policy">Policy</span>' : '';
      tb.innerHTML += `<tr><td>${escapeHtml(p.title || '—')} ${pill}</td><td>${escapeHtml(deptName(ds, p.dept))}</td><td>${p.grade}</td><td>${escapeHtml(p.prof)}</td><td>${p.date}</td><td class="money">${band}</td></tr>`;
    }
    t.append(tb); tableHost.append(t);
    const foot = h('div', { class: 'rank-note' }, [`${num(shown.length)} of ${num(rows.length)} matching records (of ${num(posts.length)} senior posts paid £150k+ or at Permanent Secretary grade, all snapshots)`]);
    tableHost.append(foot);
    if (shown.length < rows.length) {
      const more = h('button', { class: 'chip', style: { marginTop: '8px' }, onClick: () => { page++; draw(); } }, ['Show more']);
      tableHost.append(more);
    }
  };
  search.addEventListener('input', () => { q = search.value.toLowerCase().trim(); page = 0; draw(); });
  deptSel.el.addEventListener('change', () => { deptF = deptSel.value(); page = 0; draw(); });
  gradeSel.el.addEventListener('change', () => { gradeF = gradeSel.value(); page = 0; draw(); });
  ddatChip.onclick = () => { ddatOnly = !ddatOnly; ddatChip.classList.toggle('on', ddatOnly); page = 0; draw(); };
  sortChip.onclick = () => { sortKey = sortKey === 'mid' ? 'date' : 'mid'; sortChip.textContent = sortKey === 'mid' ? 'Sort: pay ▼' : 'Sort: date ▼'; page = 0; draw(); };
  draw();

  const wrap = h('div', {}, [controls, h('div', { class: 'table-scroll', style: { maxHeight: '520px' } }, [tableHost])]);
  return card('Top-earners explorer', 'Every senior post paid £150k+ or at Permanent Secretary grade — search, filter and sort', wrap);
}

function select(labels: string[], values: string[]): { el: HTMLSelectElement; value: () => string } {
  const el = document.createElement('select');
  el.style.cssText = 'font-family:var(--font-mono);font-size:var(--fs-label-xs);text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border:1.5px solid var(--card-border);background:transparent;border-radius:2px;color:var(--text-secondary)';
  el.append(new Option(labels[0], ''));
  values.forEach((v, i) => el.append(new Option(labels[i + 1], v)));
  return { el, value: () => el.value };
}
function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
