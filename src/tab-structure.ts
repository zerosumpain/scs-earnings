// Pay structure tab: grade pyramid & grade-mix drift, grade band anatomy &
// compression, pay-bill decomposition (price vs volume), pay distribution fan.
import { series, pctChange, type DataSet, type Filter } from './data';
import { stackedArea, lineChart, fanChart, barChart, colorFor, legend, type Series } from './charts';
import { gbp, num, pct } from './format';
import { h } from './dom';
import { stateToFilter } from './query';
import type { AppState } from './state';

interface Ctx { series: typeof series; toFilter: (extra?: Partial<Filter>) => Filter; state: AppState; }
const GRADE_COLORS: Record<string, string> = {
  'SCS4 / Perm Sec': '#c4570a', 'SCS3 (Dir Gen)': '#b83c6b', 'SCS2 (Dir)': '#7d5bd0',
  'SCS1 (Dep Dir)': '#12988a', 'SCS (band n/s)': '#8a7a63', 'Other / Not stated': '#b8820a',
};
function card(title: string, sub: string, body: HTMLElement, tools?: HTMLElement): HTMLElement {
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [h('div', {}, [h('h3', {}, [title]), h('div', { class: 'card-sub' }, [sub])]), tools || h('div', {})]), body,
  ]);
}
function lastIdx(v: (number | null)[]) { for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return i; return -1; }
function firstIdx(v: (number | null)[]) { return v.findIndex(x => x != null); }

export function renderStructure(main: HTMLElement, ds: DataSet, ctx: Ctx) {
  const filter = stateToFilter(ctx.state);
  main.append(h('div', { class: 'hero' }, [
    h('div', { class: 'label' }, ['Pay structure & grades']),
    h('h1', {}, ['How the pay', document.createElement('br'), 'ladder is built']),
    h('p', { class: 'sub' }, ['The anatomy of senior pay: how many sit at each grade, how the bands overlap, whether the ladder is compressing, and what drives the pay bill. Explore-tab filters apply.']),
  ]));
  const canvas = h('div', { class: 'canvas', style: { paddingBottom: '50px' } });
  main.append(canvas);

  const gradeOrder = ds.meta.grades;

  // ---- 1. Grade mix drift (100% stacked area, headcount by grade) ----
  const gRes = series(ds, { ...filter, grades: null }, 'headcount', 'grade');
  const gSeries: Series[] = gradeOrder.map((gname, i) => {
    const g = gRes.groups.find(x => x.label === gname);
    return g ? { key: g.key, label: g.label, color: GRADE_COLORS[gname] || colorFor(i), values: g.values } : null;
  }).filter(Boolean) as Series[];
  const gmHost = h('div', {});
  let gmPct = true;
  const gmTools = h('div', { class: 'card-tools' });
  const b1 = h('button', { class: 'chip on' }, ['Share %']); const b2 = h('button', { class: 'chip' }, ['Headcount']);
  const drawGm = () => stackedArea(gmHost, { labels: gRes.periods, series: gSeries, percent: gmPct, valueFormat: num, height: 320 });
  b1.onclick = () => { gmPct = true; b1.classList.add('on'); b2.classList.remove('on'); drawGm(); };
  b2.onclick = () => { gmPct = false; b2.classList.add('on'); b1.classList.remove('on'); drawGm(); };
  gmTools.append(b1, b2);
  canvas.append(card('Grade-mix drift ("grade inflation")', 'Composition of senior posts by grade over time — is the top of the office getting more top-heavy?', gmHost, gmTools));
  drawGm();

  // ---- 2. Grade band anatomy: median pay by grade over time + compression ratio ----
  const gmedRes = series(ds, { ...filter, grades: null }, 'medianPost', 'grade');
  const gmedSeries: Series[] = gradeOrder.map((gname, i) => {
    const g = gmedRes.groups.find(x => x.label === gname);
    return g ? { key: g.key, label: g.label, color: GRADE_COLORS[gname] || colorFor(i), values: g.values } : null;
  }).filter(Boolean) as Series[];
  const banHost = h('div', {});
  const banWrap = h('div', {}, [banHost, legend(gmedSeries)]);
  canvas.append(card('The pay ladder by grade', 'Median pay at each SCS grade over time — the rungs of the senior pay ladder', banWrap));
  lineChart(banHost, { labels: gmedRes.periods, series: gmedSeries, yFormat: gbp, height: 320 });

  // compression ratio = top grade median / SCS1 median
  const top = gmedSeries.find(s => s.label === 'SCS4 / Perm Sec')?.values
    || gmedSeries.find(s => s.label === 'SCS3 (Dir Gen)')?.values;
  const bot = gmedSeries.find(s => s.label === 'SCS1 (Dep Dir)')?.values;
  if (top && bot) {
    const ratio = top.map((v, i) => v != null && bot[i] != null && bot[i]! > 0 ? v / bot[i]! : null);
    const crHost = h('div', {});
    lineChart(crHost, { labels: gmedRes.periods, series: [{ key: 'cr', label: 'Top ÷ SCS1 pay', color: '#c4570a', values: ratio }], yFormat: (n) => n == null ? '—' : n.toFixed(2) + '×', height: 220 });
    const li = lastIdx(ratio), fi = firstIdx(ratio);
    const note = (fi >= 0 && li > fi) ? `The senior pay ladder ${ratio[li]! < ratio[fi]! ? 'compressed' : 'widened'} from ${ratio[fi]!.toFixed(2)}× to ${ratio[li]!.toFixed(2)}× between ${gmedRes.periods[fi]} and ${gmedRes.periods[li]}.` : '';
    canvas.append(card('Grade compression', 'Ratio of the top grade’s median pay to SCS1 (Deputy Director) — pay compression at the top', h('div', {}, [crHost, note ? h('div', { class: 'callout' }, [note]) : h('div', {})])));
  }

  // ---- 3. Pay-bill decomposition: price (mean pay) vs volume (headcount) ----
  const billRes = series(ds, filter, 'paybill', 'none').groups[0]?.values ?? [];
  const headRes = series(ds, filter, 'headcount', 'none').groups[0]?.values ?? [];
  const meanRes = series(ds, filter, 'meanFTE', 'none').groups[0]?.values ?? [];
  const fi = firstIdx(billRes), li = lastIdx(billRes);
  const decompHost = h('div', {});
  if (fi >= 0 && li > fi) {
    const dPrice = pctChange(meanRes[fi], meanRes[li]);
    const dVol = pctChange(headRes[fi], headRes[li]);
    const dBill = pctChange(billRes[fi], billRes[li]);
    decompHost.append(h('div', { class: 'tiles' }, [
      tile('Pay bill change', pct(dBill), gbp(billRes[fi], { compact: true }) + ' → ' + gbp(billRes[li], { compact: true })),
      tile('↳ Price effect (mean pay)', pct(dPrice), gbp(meanRes[fi], { compact: true }) + ' → ' + gbp(meanRes[li], { compact: true })),
      tile('↳ Volume effect (headcount)', pct(dVol), num(headRes[fi]) + ' → ' + num(headRes[li])),
    ]));
  }
  const billLineHost = h('div', { style: { marginTop: '10px' } });
  lineChart(billLineHost, { labels: series(ds, filter, 'paybill', 'none').periods, series: [{ key: 'bill', label: 'Senior pay bill', color: '#c4570a', values: billRes }], yFormat: (n) => gbp(n, { compact: true }), height: 240, yZero: true });
  decompHost.append(billLineHost);
  canvas.append(card('Pay-bill decomposition: price vs volume', 'Did the senior pay bill grow because pay rose (price) or because there are more senior posts (volume)?', decompHost));

  // ---- 4. Distribution fan: p25 / median / p75 over time ----
  const p25 = series(ds, filter, 'p25', 'none').groups[0]?.values ?? [];
  const med = series(ds, filter, 'medianPost', 'none').groups[0]?.values ?? [];
  const p75 = series(ds, filter, 'p75', 'none').groups[0]?.values ?? [];
  const fanHost = h('div', {});
  fanChart(fanHost, { labels: series(ds, filter, 'medianPost', 'none').periods, lo: p25, mid: med, hi: p75, color: '#c4570a', yFormat: gbp, height: 300 });
  canvas.append(card('Pay distribution over time', 'Median senior pay (line) with the inter-quartile band (25th–75th percentile). Pay is banded in £5k steps — see Method', fanHost));
}

function tile(label: string, value: string, sub: string): HTMLElement {
  return h('div', { class: 'tile' }, [
    h('div', { class: 't-label' }, [label]),
    h('div', { class: 't-val tabular' }, [value]),
    h('div', { class: 't-delta' }, [sub]),
  ]);
}
