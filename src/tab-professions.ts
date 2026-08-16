// Professions tab: profession mix over time, DDaT-vs-Policy premium,
// occupational pay-premium heatmap, growth leaderboard, digital emergence.
import { series, cagr, type DataSet, type Filter, type Measure } from './data';
import { stackedArea, heatmap, lineChart, barChart, colorFor, OTHER_COLOR, type Series } from './charts';
import { gbp, num, pct, measureFormat } from './format';
import { h } from './dom';
import { stateToFilter } from './query';
import type { AppState } from './state';

interface Ctx { series: typeof series; toFilter: (extra?: Partial<Filter>) => Filter; state: AppState; }

function card(title: string, sub: string, body: HTMLElement, tools?: HTMLElement): HTMLElement {
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      h('div', {}, [h('h3', {}, [title]), h('div', { class: 'card-sub' }, [sub])]),
      tools || h('div', {}),
    ]), body,
  ]);
}
function lastIdx(vals: (number | null)[]) { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i; return -1; }
function firstIdx(vals: (number | null)[]) { return vals.findIndex(v => v != null); }

export function renderProfessions(main: HTMLElement, ds: DataSet, ctx: Ctx) {
  const filter = stateToFilter(ctx.state);
  main.append(h('div', { class: 'hero' }, [
    h('div', { class: 'label' }, ['Professions & functions']),
    h('h1', {}, ['The changing shape', document.createElement('br'), 'of senior talent']),
    h('p', { class: 'sub' }, ['How the mix of professional groups at the top of the Civil Service has shifted — and how the pay of digital and policy roles compares. Filters from the Explore tab (departments, grades, real-terms) apply here too.']),
  ]));
  const canvas = h('div', { class: 'canvas', style: { paddingBottom: '50px' } });
  main.append(canvas);

  // ---- 1. Profession mix over time (100% stacked area, headcount) ----
  const mixRes = series(ds, { ...filter, profs: null }, 'headcount', 'profession');
  const mixSeries: Series[] = orderByLatest(mixRes.groups).map((g, i) => ({ key: g.key, label: g.label, color: colorFor(i, g.key), values: g.values }));
  const mixHost = h('div', {});
  const mixToggle = h('div', { class: 'card-tools' }, []);
  let mixPercent = true;
  const drawMix = () => stackedArea(mixHost, { labels: mixRes.periods, series: mixSeries, percent: mixPercent, valueFormat: (n) => num(n), height: 340 });
  const pctBtn = h('button', { class: 'chip on' }, ['Share %']);
  const cntBtn = h('button', { class: 'chip' }, ['Headcount']);
  pctBtn.onclick = () => { mixPercent = true; pctBtn.classList.add('on'); cntBtn.classList.remove('on'); drawMix(); };
  cntBtn.onclick = () => { mixPercent = false; cntBtn.classList.add('on'); pctBtn.classList.remove('on'); drawMix(); };
  mixToggle.append(pctBtn, cntBtn);
  canvas.append(card('Profession mix over time', 'Share of senior posts by professional group — the rise of DDaT, the shape of policy', mixHost, mixToggle));
  drawMix();

  // ---- 2. DDaT vs Policy premium (grade-controlled option) ----
  const dpRes = series(ds, { ...filter, ddat: null, policy: null }, ctx.state.measure === 'headcount' || ctx.state.measure === 'fte' || ctx.state.measure === 'paybill' ? 'medianPost' : ctx.state.measure, 'ddatPolicy');
  const dpSeries: Series[] = dpRes.groups.map((g) => ({
    key: g.key, label: g.label,
    color: g.key === 'ddat' ? '#12988a' : g.key === 'policy' ? '#c4570a' : OTHER_COLOR, values: g.values,
  }));
  const dpHost = h('div', {});
  canvas.append(card('DDaT vs Policy pay', 'Median senior pay: digital/data/technology roles against policy roles and the rest', dpHost));
  lineChart(dpHost, { labels: dpRes.periods, series: dpSeries, yFormat: gbp, height: 300 });
  // premium readout
  const ddatV = dpSeries.find(s => s.key === 'ddat')?.values ?? [];
  const polV = dpSeries.find(s => s.key === 'policy')?.values ?? [];
  const li = Math.max(lastIdx(ddatV), lastIdx(polV));
  if (li >= 0 && ddatV[li] != null && polV[li] != null) {
    const prem = (ddatV[li]! - polV[li]!);
    const premPct = polV[li] ? prem / polV[li]! * 100 : 0;
    dpHost.parentElement!.append(h('div', { class: 'callout' }, [
      `In ${dpRes.periods[li]}, median DDaT senior pay is ${gbp(ddatV[li])} vs ${gbp(polV[li])} for policy — a ${prem >= 0 ? 'premium' : 'discount'} of ${gbp(Math.abs(prem))} (${pct(premPct)}).`,
    ]));
  }

  // ---- 3. Occupational pay-premium heatmap (profession median vs all-professions median, by period) ----
  const allMed = series(ds, { ...filter, profs: null }, 'medianPost', 'none').groups[0]?.values ?? [];
  const profMed = series(ds, { ...filter, profs: null }, 'medianPost', 'profession');
  const heatHost = h('div', {});
  const heatRows = orderByLatest(profMed.groups).map(g => ({ key: g.key, label: g.label }));
  heatmap(heatHost, {
    cols: profMed.periods, rows: heatRows,
    value: (rowKey, col) => {
      const g = profMed.groups.find(x => x.key === rowKey); const v = g?.values[col]; const base = allMed[col];
      if (v == null || base == null || !base) return null;
      return (v - base) / base * 100;
    },
    format: (n) => n == null ? '—' : pct(n),
    diverging: true, midpoint: 0,
  });
  canvas.append(card('Occupational pay premium', 'Each profession’s median pay vs the all-profession median, over time (teal = below, orange = above)', heatHost));

  // ---- 4. Profession growth leaderboard (CAGR of median pay) ----
  const lbHost = h('div', {});
  const lbRows = profMed.groups.map(g => {
    const fi = firstIdx(g.values), la = lastIdx(g.values);
    if (fi < 0 || la <= fi) return null;
    const gr = cagr(g.values[fi], g.values[la], la - fi);
    return gr == null ? null : { key: g.key, label: g.label, value: gr };
  }).filter(Boolean) as { key: string; label: string; value: number }[];
  lbRows.sort((a, b) => b.value - a.value);
  // See tab-records.ts: diverging so bar length agrees with the sign, and the
  // warm-family down tint rather than a red/green pair that fails CVD.
  barChart(lbHost, { diverging: true, rows: lbRows.map((r) => ({ ...r, color: r.value >= 0 ? 'var(--accent)' : 'var(--trend-down)' })), valueFormat: (n) => pct(n, 1) + '/yr' });
  canvas.append(card('Profession pay growth', `Compound annual growth in median senior pay, first to latest snapshot (${ctx.state.realTerms ? 'real terms' : 'nominal'})`, lbHost));

  // ---- 5. Digital job-title emergence timeline ----
  const digHost = h('div', {});
  const digCount = series(ds, { ...filter, ddat: true, profs: null, policy: null }, 'headcount', 'none').groups[0]?.values ?? [];
  const digShareBase = series(ds, { ...filter, profs: null, ddat: null, policy: null }, 'headcount', 'none').groups[0]?.values ?? [];
  const digSeries: Series[] = [
    { key: 'ddat', label: 'DDaT senior posts', color: '#12988a', values: digCount },
    { key: 'share', label: 'Share of all senior (%)', color: '#c4570a', values: digCount.map((v, i) => v != null && digShareBase[i] ? v / digShareBase[i]! * 100 : null) },
  ];
  // two different scales -> show count only as the primary; share as its own small line chart below
  lineChart(digHost, { labels: profMed.periods, series: [digSeries[0]], yFormat: (n) => num(n), height: 220, yZero: true });
  const shareHost = h('div', { style: { marginTop: '10px' } });
  lineChart(shareHost, { labels: profMed.periods, series: [digSeries[1]], yFormat: (n) => (n == null ? '—' : n.toFixed(1) + '%'), height: 180, yZero: true });
  const digWrap = h('div', {}, [digHost, shareHost]);
  canvas.append(card('The rise of digital at the top', 'Count of senior DDaT posts, and their share of all senior posts, over time', digWrap));
}

function orderByLatest<T extends { values: (number | null)[] }>(groups: T[]): T[] {
  const lv = (v: (number | null)[]) => { for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i]!; return -Infinity; };
  return [...groups].sort((a, b) => lv(b.values) - lv(a.values));
}
