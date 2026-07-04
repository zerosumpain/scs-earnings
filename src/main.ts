import './style.css';
import { loadData, series, pctChange, type DataSet, type Filter, type Measure, type Dimension, type SeriesResult } from './data';
import { lineChart, barChart, seriesTable, colorFor, PALETTE, OTHER_COLOR, type Series } from './charts';
import { gbp, num, pct, measureFormat, measureLabel } from './format';
import { h, clear } from './dom';
import { type AppState, defaultState, readHash, writeHash } from './state';
import { stateToFilter } from './query';
import { renderRecords } from './tab-records';
import { renderProfessions } from './tab-professions';
import { renderStructure } from './tab-structure';
import { renderMethod } from './tab-method';

const TOP_N = 7;

let ds: DataSet;
let state: AppState = defaultState();

// ---------- state -> Filter ----------
const toFilter = stateToFilter;

// restrict a filter to a subset of the given dimension's keys (for the "Other" bucket)
function restrict(base: Filter, dimension: Dimension, keys: string[]): Filter {
  const f = { ...base };
  if (dimension === 'department') {
    const idxs = keys.map(k => ds.meta.depts.findIndex(d => d.id === k)).filter(i => i >= 0);
    f.depts = new Set(idxs);
  } else if (dimension === 'profession') {
    f.profs = new Set(keys.map(Number));
  } else if (dimension === 'grade') {
    f.grades = new Set(keys.map(Number));
  }
  return f;
}

// build display series: top-N by latest value + a correctly-merged "Other"
function displaySeries(s: AppState): { series: Series[]; total: number; result: SeriesResult } {
  const filter = toFilter(s);
  const result = series(ds, filter, s.measure, s.dimension);
  const latest = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return vals[i]!; return -Infinity; };
  const sorted = [...result.groups].sort((a, b) => latest(b.values) - latest(a.values));
  const top = sorted.slice(0, TOP_N);
  const rest = sorted.slice(TOP_N);
  const out: Series[] = top.map((g, i) => ({ key: g.key, label: g.label, color: colorFor(i, g.key), values: g.values }));
  if (rest.length) {
    const otherFilter = restrict(filter, s.dimension, rest.map(g => g.key));
    const otherRes = series(ds, otherFilter, s.measure, 'none');
    if (otherRes.groups[0]) out.push({ key: '__other', label: `Other (${rest.length})`, color: OTHER_COLOR, values: otherRes.groups[0].values });
  }
  return { series: out, total: result.groups.length, result };
}

// ---------- update ----------
function update(partial: Partial<AppState>) {
  state = { ...state, ...partial };
  writeHash(state);
  render();
}
// toggle a value in one of the multiselect arrays
function toggleIn(arr: number[], v: number): number[] {
  return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
}

// ---------- shell ----------
function render() {
  const app = document.getElementById('app')!;
  clear(app);
  app.append(topbar(), tabsNav());
  const main = h('div', { class: 'wrap' });
  app.append(main);
  if (state.tab === 'explore') renderExplore(main);
  else if (state.tab === 'compare') renderCompare(main);
  else if (state.tab === 'professions') renderProfessions(main, ds, { series, toFilter: (extra?: Partial<Filter>) => toFilter(state, extra), state });
  else if (state.tab === 'structure') renderStructure(main, ds, { series, toFilter: (extra?: Partial<Filter>) => toFilter(state, extra), state });
  else if (state.tab === 'records') renderRecords(main, ds, state);
  else if (state.tab === 'method') renderMethod(main, ds);
  app.append(footer());
}

function topbar(): HTMLElement {
  return h('div', { class: 'topbar' }, [
    h('div', { class: 'wrap' }, [
      h('div', { class: 'topbar-inner' }, [
        h('a', { class: 'brand', href: 'https://strangeramblings.com/projects' }, ['scs pay']),
        h('span', { class: 'title' }, ['Senior Civil Service Earnings']),
        h('div', { class: 'spacer' }),
        h('button', { class: 'share-btn', onClick: copyLink }, ['⧉ Copy view link']),
      ]),
    ]),
  ]);
}

async function copyLink() {
  try { await navigator.clipboard.writeText(location.href); toast('View link copied'); }
  catch { toast('Copy failed — use the URL bar'); }
}
function toast(msg: string) {
  const t = h('div', { style: { position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
    background: '#1a1008', color: '#ede4d4', padding: '10px 16px', borderRadius: '4px', fontFamily: 'JetBrains Mono, monospace',
    fontSize: '12px', zIndex: '100', boxShadow: '0 6px 24px rgba(26,16,8,.3)' } }, [msg]);
  document.body.append(t); setTimeout(() => t.remove(), 1800);
}

const TABS: [string, string][] = [
  ['explore', 'Explore'], ['professions', 'Professions'], ['structure', 'Pay structure'],
  ['records', 'Top earners'], ['compare', 'Compare'], ['method', 'Method'],
];
function tabsNav(): HTMLElement {
  return h('div', { class: 'tabs' }, [
    h('div', { class: 'wrap', style: { display: 'flex', gap: '4px' } },
      TABS.map(([id, label]) => h('button', { class: 'tab' + (state.tab === id ? ' active' : ''), onClick: () => update({ tab: id }) }, [label]))),
  ]);
}

function footer(): HTMLElement {
  const s = ds.meta.stats;
  return h('div', { class: 'footer' }, [
    h('div', { class: 'wrap' }, [
      h('div', { html: `<span class="brand" style="font-size:14px">scs pay</span> &nbsp; Source: ${ds.meta.source.name} via ${ds.meta.source.via}. ` +
        `${num(s.posts)} senior posts across ${s.departments} departments, ${s.snapshots} snapshots (${s.dateRange[0]} → ${s.dateRange[1]}). ` +
        `Data generated ${ds.meta.generated.slice(0, 10)}. Pay is band-midpoint; see Method.` }),
    ]),
  ]);
}

// ---------- Explore tab ----------
function renderExplore(main: HTMLElement) {
  main.append(hero());
  const layout = h('div', { class: 'layout' });
  layout.append(controls(), exploreCanvas());
  main.append(layout);
}

function hero(): HTMLElement {
  const s = ds.meta.stats;
  return h('div', { class: 'hero' }, [
    h('div', { class: 'label' }, ['Field study · UK Senior Civil Service pay']),
    h('h1', {}, ['Who earns what', document.createElement('br'), 'across Whitehall']),
    h('p', { class: 'sub' }, [
      `Fifteen years of published pay for the ${num(s.posts)} most senior posts in ${s.departments} government departments — ` +
      `plot it over time by department, profession, grade, or the digital-vs-policy split. All from gov.uk transparency data.`,
    ]),
    h('div', { class: 'meta-row' }, [
      h('div', { class: 'm', html: `<b>${s.dateRange[0].slice(0, 4)}–${s.dateRange[1].slice(0, 4)}</b> coverage` }),
      h('div', { class: 'm', html: `<b>${s.departments}</b> departments` }),
      h('div', { class: 'm', html: `<b>${num(s.posts)}</b> senior posts` }),
      h('div', { class: 'm', html: `<b>${s.snapshots}</b> data releases` }),
    ]),
  ]);
}

const MEASURES: [Measure, string][] = [
  ['medianPost', 'Median'], ['meanPost', 'Mean'], ['p75', 'Top quartile'], ['p25', 'Lower quartile'],
  ['headcount', 'Headcount'], ['paybill', 'Pay bill'], ['fte', 'FTE'],
];
const DIMENSIONS: [Dimension, string][] = [
  ['department', 'Department'], ['profession', 'Profession'], ['grade', 'Grade'],
  ['ddatPolicy', 'DDaT vs Policy'], ['none', 'Total'],
];

function controls(): HTMLElement {
  const box = h('div', { class: 'controls' });

  // measure
  box.append(h('div', { class: 'ctl-group' }, [
    h('span', { class: 'label' }, ['Measure']),
    h('div', { class: 'seg' }, MEASURES.map(([m, l]) =>
      h('button', { class: state.measure === m ? 'on' : '', onClick: () => update({ measure: m }) }, [l]))),
  ]));

  // breakdown
  box.append(h('div', { class: 'ctl-group' }, [
    h('span', { class: 'label' }, ['Break down by']),
    h('div', { class: 'seg' }, DIMENSIONS.map(([d, l]) =>
      h('button', { class: state.dimension === d ? 'on' : '', onClick: () => update({ dimension: d }) }, [l]))),
  ]));

  // quick role toggles
  box.append(h('div', { class: 'ctl-group' }, [
    h('span', { class: 'label' }, ['Role lens']),
    h('div', { class: 'seg' }, [
      h('button', { class: state.ddat === 1 ? 'on' : '', onClick: () => update({ ddat: state.ddat === 1 ? 0 : 1, policy: 0 }) }, ['DDaT only']),
      h('button', { class: state.policy === 1 ? 'on' : '', onClick: () => update({ policy: state.policy === 1 ? 0 : 1, ddat: 0 }) }, ['Policy only']),
    ]),
    h('label', { class: 'toggle-row', style: { marginTop: '10px' } }, [
      Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.realTerms, onchange: (e: any) => update({ realTerms: e.target.checked }) }),
      `Real terms (today's £, CPIH)`,
    ]),
  ]));

  // department multiselect
  box.append(chipGroup('Departments', ds.meta.depts.map((d, i) => ({ i, label: d.id, title: d.name })), state.depts,
    (i) => update({ depts: toggleIn(state.depts, i) }), () => update({ depts: [] }), true));

  // profession multiselect
  box.append(chipGroup('Professions', ds.meta.profs.map((p, i) => ({ i, label: p, title: p })), state.profs,
    (i) => update({ profs: toggleIn(state.profs, i) }), () => update({ profs: [] })));

  // grade multiselect
  box.append(chipGroup('Grades', ds.meta.grades.map((g, i) => ({ i, label: g, title: g })), state.grades,
    (i) => update({ grades: toggleIn(state.grades, i) }), () => update({ grades: [] })));

  return box;
}

function chipGroup(label: string, items: { i: number; label: string; title: string }[], selected: number[],
  onToggle: (i: number) => void, onClear: () => void, deptStyle = false): HTMLElement {
  return h('div', { class: 'ctl-group' }, [
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } }, [
      h('span', { class: 'label' }, [`${label}${selected.length ? ` · ${selected.length}` : ''}`]),
      selected.length ? h('button', { class: 'mini-link', onClick: onClear }, ['clear']) : h('span', {}, ['']),
    ]),
    h('div', { class: 'chip-list' }, items.map(it =>
      h('button', { class: 'chip' + (deptStyle ? ' dept-chip' : '') + (selected.includes(it.i) ? ' on' : ''), title: it.title, onClick: () => onToggle(it.i) }, [it.label]))),
  ]);
}

function exploreCanvas(): HTMLElement {
  const canvas = h('div', { class: 'canvas' });
  const { series: disp, total, result } = displaySeries(state);
  const fmt = measureFormat(state.measure);

  // KPI tiles (dimension = none over the current filter)
  const totalRes = series(ds, toFilter(state), state.measure, 'none').groups[0];
  const vals = totalRes?.values ?? [];
  const firstIdx = vals.findIndex(v => v != null);
  let lastIdx = -1; for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) { lastIdx = i; break; }
  const latestVal = lastIdx >= 0 ? vals[lastIdx] : null;
  const firstVal = firstIdx >= 0 ? vals[firstIdx] : null;
  const change = pctChange(firstVal, latestVal);
  const headRes = series(ds, toFilter(state), 'headcount', 'none').groups[0]?.values ?? [];
  const billRes = series(ds, toFilter(state), 'paybill', 'none').groups[0]?.values ?? [];
  const lastHead = lastVal(headRes), lastBill = lastVal(billRes);

  canvas.append(h('div', { class: 'tiles' }, [
    tile(measureLabel(state.measure) + ' (latest)', fmt(latestVal), null),
    tile('Change since ' + (ds.periods[firstIdx] || '—'), pct(change), change),
    tile('Senior posts (latest)', num(lastHead), null),
    tile('Pay bill (latest)', gbp(lastBill, { compact: true }), null),
  ]));

  // main line chart
  const chartCard = h('div', { class: 'card' });
  const host = h('div', { class: 'chart-host' });
  const tableHost = h('div', {});
  chartCard.append(
    h('div', { class: 'card-head' }, [
      h('div', {}, [
        h('h3', {}, [measureLabel(state.measure) + ' over time']),
        h('div', { class: 'card-sub' }, [subtitleFor(state, total)]),
      ]),
      h('div', { class: 'card-tools' }, [
        h('button', { class: 'chip' + (state.showTable ? ' on' : ''), onClick: () => update({ showTable: !state.showTable }) }, [state.showTable ? 'Chart' : 'Table']),
      ]),
    ]),
    host, tableHost,
  );
  canvas.append(chartCard);

  const yZero = state.measure === 'headcount' || state.measure === 'fte' || state.measure === 'paybill';
  const draw = () => {
    if (state.showTable) { host.classList.add('hidden'); clear(tableHost).append(seriesTable(result.periods, disp, fmt)); }
    else {
      host.classList.remove('hidden'); clear(tableHost);
      lineChart(host, { labels: result.periods, series: disp, yFormat: (n) => fmt(n), yZero, height: 360 });
    }
  };
  draw();
  chartCard.append(legend(disp));

  // ranked bar at latest period (magnitude view) — only when a real breakdown is active
  if (state.dimension !== 'none' && result.groups.length > 1) {
    const li = lastIdxOf(result);
    const dispColor = new Map(disp.map(s => [s.key, s.color]));
    const rows = result.groups.map((g) => ({ key: g.key, label: g.label, value: g.values[li], color: dispColor.get(g.key) || OTHER_COLOR }))
      .filter(r => r.value != null)
      .sort((a, b) => (b.value as number) - (a.value as number));
    const barCard = h('div', { class: 'card' });
    const barHost = h('div', { class: 'chart-host' });
    barCard.append(
      h('div', { class: 'card-head' }, [
        h('div', {}, [h('h3', {}, [`${measureLabel(state.measure)} by ${dimLabel(state.dimension).toLowerCase()}`]),
          h('div', { class: 'card-sub' }, [`Ranked · ${result.periods[li]}`])]),
      ]), barHost);
    canvas.append(barCard);
    barChart(barHost, { rows, valueFormat: fmt });
  }

  // redraw on resize
  let rt: number | undefined;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = window.setTimeout(draw, 150); }, { once: true });

  return canvas;
}

function indexOfDisplayed(disp: Series[], key: string): number { const i = disp.findIndex(s => s.key === key); return i >= 0 ? i : 0; }
function lastVal(a: (number | null)[]): number | null { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; }
function lastIdxOf(r: SeriesResult): number {
  let li = 0; r.groups.forEach(g => g.values.forEach((v, i) => { if (v != null && i > li) li = i; })); return li;
}
function dimLabel(d: Dimension): string { return (DIMENSIONS.find(x => x[0] === d)?.[1]) || 'total'; }

function subtitleFor(s: AppState, total: number): string {
  const bits: string[] = [];
  if (s.dimension !== 'none') bits.push(`by ${dimLabel(s.dimension).toLowerCase()}${total > TOP_N ? ` · top ${TOP_N} of ${total}` : ''}`);
  if (s.ddat === 1) bits.push('DDaT roles only');
  if (s.policy === 1) bits.push('policy roles only');
  if (s.depts.length) bits.push(`${s.depts.length} dept${s.depts.length > 1 ? 's' : ''}`);
  if (s.realTerms) bits.push("real terms (today's £)");
  return bits.length ? bits.join(' · ') : 'all senior posts';
}

function tile(label: string, value: string, delta: number | null): HTMLElement {
  const cls = delta == null ? '' : delta >= 0 ? ' up' : ' down';
  return h('div', { class: 'tile' }, [
    h('div', { class: 't-label' }, [label]),
    h('div', { class: 't-val tabular' }, [value]),
    delta != null ? h('div', { class: 't-delta' + cls }, [delta >= 0 ? '▲ rising' : '▼ falling']) : h('div', { class: 't-delta' }, [' ']),
  ]);
}

function legend(disp: Series[]): HTMLElement {
  return h('div', { class: 'legend' }, disp.map(s =>
    h('span', { class: 'lg' }, [h('span', { class: 'sw', style: { background: s.color } }), s.label])));
}

// ---------- Compare tab (small multiples) ----------
function renderCompare(main: HTMLElement) {
  main.append(h('div', { class: 'hero' }, [
    h('div', { class: 'label' }, ['Compare · small multiples']),
    h('h1', {}, ['Department by department']),
    h('p', { class: 'sub' }, [`Median senior pay in each department on a shared scale — the same ${state.realTerms ? 'real-terms ' : ''}axis everywhere, so the panels are directly comparable. Use the Explore tab's Measure & Real-terms controls; they apply here too.`]),
  ]));
  // shared-scale small multiples of median pay per department
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '14px', paddingBottom: '50px' } });
  const measure: Measure = (state.measure === 'headcount' || state.measure === 'fte' || state.measure === 'paybill') ? state.measure : state.measure;
  const all = series(ds, toFilter(state, { depts: null }), measure, 'department');
  // global y-range across all depts for shared scale
  let hi = -Infinity, lo = Infinity;
  all.groups.forEach(g => g.values.forEach(v => { if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }));
  const fmt = measureFormat(measure);
  const sorted = [...all.groups].sort((a, b) => (lastVal(b.values) ?? 0) - (lastVal(a.values) ?? 0));
  sorted.forEach((g, i) => {
    const card = h('div', { class: 'card', style: { padding: '12px' } }, [
      h('div', { class: 'card-head', style: { marginBottom: '2px' } }, [h('h3', { style: { fontSize: '13px' } }, [g.label])]),
    ]);
    const host = h('div', {});
    card.append(host);
    grid.append(card);
    setTimeout(() => lineChart(host, { labels: all.periods, series: [{ key: g.key, label: g.label, color: colorFor(i % PALETTE.length), values: g.values }], yFormat: fmt, height: 130 }), 0);
  });
  main.append(grid);
}

// ---------- boot ----------
async function boot() {
  ds = await loadData('./data/');
  const fromHash = readHash();
  if (fromHash) state = { ...state, ...fromHash };
  render();
}
boot().catch(err => {
  document.getElementById('app')!.innerHTML = `<div class="wrap" style="padding:60px 20px"><h2>Couldn't load the data</h2><p class="body">${String(err)}</p></div>`;
  console.error(err);
});
