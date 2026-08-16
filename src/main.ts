// Field Study No 6 — Senior Civil Service pay.
//
// The page is a field study, not a dashboard: seven beats in the fixed order,
// each with one question, one claim, a confidence, a "so what" and an open
// question with a falsifier. The content lives in src/study.ts; this file is
// the renderer — one function per template (T0 front matter, T1 argument,
// T2 survey, T3 position, T4 ledger, T5 instrument).
//
// Three rules that are enforced here rather than hoped for:
//   1. Categorical hues are capped at MAX_CATEGORICAL and everything else is
//      merged into ONE labelled "Other". Seven adjacent ghost-grey bands with
//      seven identical swatches is not a legend, it is a shrug.
//   2. Every chart offers its table twin, from the shared card() helper.
//   3. No pay figure is ever a single number. Banded measures come back as
//      bounds and are drawn and printed as bounds.

import './style.css';
import {
  loadData, ensureFor, series, countAbove, periodIndex, isBandedMeasure,
  lastPopulatedIdx, firstPopulatedIdx, pctChange, N_FLOOR, loadChangelog,
  loadHighEarners, loadSsrbGap, NON_SCS_GRADES,
  type SsrbGap,
  type DataSet, type Filter, type Measure, type Dimension, type SeriesResult,
  type SeriesGroup, type ChangelogEntry, type Grain, type HighEarners,
} from './data';
import {
  lineChart, barChart, stackedArea, fanChart, legend, seriesTable,
  matrixTable, colorFor, ordinalColor, MAX_CATEGORICAL, OTHER_COLOR, INK2,
  type Series, type ChartHandle, type LegendItem,
} from './charts';
import {
  gbp, num, pct, share, shareRough, band, pctBand, dateLabel,
  roundedBand, roundedFigure, countRange, measureFormat, measureLabel, measureUnit,
} from './format';
import { h, clear, append, esc, rich } from './dom';
import { type AppState, type Basis, defaultState, readHash, writeHash } from './state';
import { stateToFilter, pmPayEntry, pmPayFor, PM_PAY_SOURCE, PM_PAY_VERIFIED_TO } from './query';
import {
  loadPosts, groupPosts, searchPosts, orgStructure, structureSeriesDetailed,
  type PostRow, type PostGroup, type PostSort,
} from './posts';
import {
  loadBenchmarks, contestedQuantities, honestyRules, excludedSources, staleSources,
  type Benchmarks,
} from './benchmarks';
import {
  study, type Beat, type Claim, type Depth, type Figure as StudyFigure, type Source,
} from './study';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * The study's own opening view, over the top of `defaultState()`.
 *
 * Two deliberate departures from the data layer's defaults, both of them about
 * what the reader meets first rather than about what the layer can compute.
 *
 *   dimension: 'none' — the instrument used to open on median pay BY
 *     ORGANISATION at quarter grain. Per-organisation medians at that grain are
 *     genuinely sparse: most bodies file once or twice a year, so the shopfront
 *     chart was a field of disconnected fragments. It opens on the total fan,
 *     which is a trend, and the reader breaks it down from there.
 *   grain: 'year' — filing cadence went from twice-yearly to near-monthly in
 *     2022. At quarter grain that makes the right-hand half of every series
 *     denser than the left, which reads as volatility and is publication
 *     frequency. A year holds one filing per body at both ends of the series.
 *
 * study.ts states both as the instrument's baseline, so the two cannot drift.
 */
const BASELINE = { dimension: 'none' as Dimension, grain: 'year' as Grain };

let ds: DataSet;
let state: AppState = { ...defaultState(), ...BASELINE };
let facts: Record<string, string> = {};
let depth: Depth = 'research';
let renderToken = 0;

/**
 * How the capped chart chooses its four hues.
 *
 * buildDisplay ranked by the LAST VALUE, so on a pay measure the four hued
 * groups were the four highest-PAID and DWP, HMRC and MOD — the three largest
 * bodies in the corpus — sat inside "Other". Defensible for a pay study and
 * surprising for everyone else, because a reader meeting a breakdown assumes
 * it is a breakdown of the population. It is now a stated choice, defaulting
 * to size.
 */
type RankBy = 'size' | 'pay';
let rankBy: RankBy = 'size';

/** Series hidden by a legend toggle on the instrument. */
const hiddenSeries = new Set<string>();
/** Lever HUD open/closed. Collapsed by default on a phone. */
let leversOpen = true;
/** Which scope list the Scope lever has expanded. */
let scopePanel: 'orgs' | 'profs' | 'grades' | null = null;
/** T4 lens — re-ranks, never filters. */
let lens = study.beats.find((b) => b.ledger)?.ledger?.activeLens ?? '';
/** Organisation whose shard beat 05 decomposes. */
let agencyOrg: string | null = null;

const isNarrow = () => (typeof window !== 'undefined' ? window.innerWidth <= 1000 : false);

// ---------------------------------------------------------------------------
// Facts — every {token} the study copy can interpolate.
//
// Nothing in study.ts hard-codes a corpus number. They are resolved here from
// the loaded meta.json, so a sentence cannot drift away from the chart next to
// it after an ingest.
// ---------------------------------------------------------------------------

function computeFacts(): Record<string, string> {
  const s = ds.meta.stats;
  const pi = periodIndex(ds, state.grain);
  const withheldShare = s.headcount > 0 ? s.withheld / s.headcount : null;
  const failRate = s.filesOk + s.filesFail > 0 ? s.filesFail / (s.filesOk + s.filesFail) : null;

  // Disclosure spread across the SCS grades at the most recent filing.
  let discLowGrade = 'the most junior SCS grade', discHighGrade = 'the most senior grades';
  let discLowRate = '—', discHighRate = '—';
  try {
    const res = series(ds, { tier: 'A', scsOnly: true, constantScope: false, grain: state.grain }, 'disclosureRate', 'grade');
    const li = lastPopulatedIdx(res);
    if (li >= 0) {
      const rows = res.groups
        .map((g) => ({ label: g.label, v: g.values[li], hc: g.headcount[li] }))
        .filter((r) => r.v != null && r.hc >= N_FLOOR)
        .sort((a, b) => (a.v as number) - (b.v as number));
      if (rows.length >= 2) {
        discLowGrade = rows[0].label; discLowRate = shareRough(rows[0].v);
        const top = rows[rows.length - 1];
        discHighGrade = top.label; discHighRate = shareRough(top.v);
      }
    }
  } catch { /* core cube only — this cannot throw, but never break the page for a fact */ }

  return {
    orgs: num(s.orgs),
    orgsA: num(ds.meta.orgs.filter((o) => o.tier === 'A').length),
    orgsB: num(ds.meta.orgs.filter((o) => o.tier === 'B').length),
    snapshots: num(s.snapshots),
    files: num(s.files),
    posts: num(s.posts),
    headcount: num(s.headcount),
    disclosed: num(s.disclosed),
    withheld: num(s.withheld),
    openBand: num(s.openBand),
    eliminated: num(s.eliminated),
    vacant: num(s.vacant),
    disclosureRate: share(s.disclosureRate),
    withheldRate: share(withheldShare),
    withheldShare: withheldShare == null ? '—' : `${shareRough(withheldShare)} (${num(s.withheld)} of ${num(s.headcount)})`,
    dateFrom: dateLabel(s.dateRange[0]),
    dateTo: dateLabel(s.dateRange[1]),
    yearFrom: s.dateRange[0].slice(0, 4),
    yearTo: s.dateRange[1].slice(0, 4),
    dates: num(s.dates),
    filesOk: num(s.filesOk),
    filesFail: num(s.filesFail),
    failRate: failRate == null ? '—' : shareRough(failRate),
    undated: num(s.undatedSkipped),
    rejectedSiblings: num(s.rejectedSiblings),
    droppedSnapshots: num(pi.droppedSnapshots.length),
    generated: ds.meta.generated.slice(0, 10),
    cpihSource: ds.meta.cpih.source,
    binWidth: gbp(ds.binWidth),
    discLowGrade, discLowRate, discHighGrade, discHighRate,
  };
}

/** Resolve {tokens} in study copy. An unknown token is left visible, not blanked. */
function fill(text: string): string {
  return text.replace(/\{(\w+)\}/g, (whole, key) => facts[key] ?? whole);
}

// ---------------------------------------------------------------------------
// Filters and series
// ---------------------------------------------------------------------------

/**
 * Constant scope needs a period range, or it is a lever that can only fail.
 *
 * Over the full 2010-2026 span NO organisation filed in every period at any
 * grain — 2020 is missing for almost everyone — so `constantScope: true` on
 * the whole range correctly returns nothing. Rather than ask the reader to
 * guess a window, derive the widest one in which a constant scope actually
 * exists: the longest run of consecutive periods any scoped body filed
 * without a gap. The window is then printed on the limits strip, so the
 * narrowing is a stated fact rather than a silent re-base.
 */
const scopeWindowCache = new Map<string, [number, number] | null>();

function constantScopeWindow(f: Filter): [number, number] | null {
  const grain = f.grain ?? BASELINE.grain;
  const orgs = f.orgs && f.orgs.size ? [...f.orgs].sort((a, b) => a - b) : null;
  const key = `${grain}|${f.tier ?? 'A'}|${orgs ? orgs.join(',') : '*'}`;
  const hit = scopeWindowCache.get(key);
  if (hit !== undefined) return hit;

  const pi = periodIndex(ds, grain);
  const nP = pi.periods.length;
  const cand: number[] = [];
  ds.meta.orgs.forEach((o, oi) => {
    if ((f.tier ?? 'A') !== 'AB' && o.tier !== 'A') return;
    if (orgs && !orgs.includes(oi)) return;
    cand.push(oi);
  });

  // Maximise bodies x periods rather than raw length: a five-year window
  // covering one department is a worse constant scope than a three-year one
  // covering six.
  let best: [number, number] | null = null;
  let bestScore = 0;
  for (let a = 0; a < nP; a++) {
    let alive = cand.filter((oi) => pi.chosen[oi][a] >= 0);
    for (let b = a; b < nP && alive.length; b++) {
      if (b > a) alive = alive.filter((oi) => pi.chosen[oi][b] >= 0);
      if (!alive.length) break;
      const score = alive.length * (b - a + 1);
      if (score > bestScore) { bestScore = score; best = [a, b]; }
    }
  }
  scopeWindowCache.set(key, best);
  return best;
}

function toFilter(extra: Partial<Filter> = {}): Filter {
  const f = stateToFilter(state, extra);
  // Only where constant scope actually applies: a beat figure that opted out
  // with `constantScope: false` must keep the full range.
  if (f.constantScope === true && !f.periodRange) {
    const win = constantScopeWindow(f);
    if (win) f.periodRange = win;
  }
  return f;
}

function update(partial: Partial<AppState>): void {
  state = { ...state, ...partial };
  writeHash(state);
  render();
}

function go(slug: string): void {
  hiddenSeries.clear();
  update({ tab: slug });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

const toggleIn = (arr: number[], v: number): number[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

const currentBeat = (): Beat => study.beats.find((b) => b.slug === state.tab) ?? study.beats[0];

/** The dimension a beat needs loaded before it can call series(). */
function beatDimension(beat: Beat): Dimension {
  if (beat.slug === 'finding') return state.dimension;
  if (beat.slug === 'who-wins') return 'ddatPolicy';
  if (beat.slug === 'trust') return 'profession';
  if (beat.slug === 'reading') return 'grade';
  return 'none';
}

const OTHER_NOUN: Partial<Record<Dimension, string>> = {
  department: 'organisations', organisation: 'organisations', profession: 'professions',
  grade: 'grades', ddatPolicy: 'role types', family: 'families',
};

const values = (g: SeriesGroup, banded: boolean): (number | null)[] => (banded ? g.lo : g.values);
const lastOf = (a: (number | null)[]): number | null => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
/** The most recent period in which this group actually had posts. */
const latestHeadcount = (g: SeriesGroup): number => {
  for (let i = g.headcount.length - 1; i >= 0; i--) if (g.headcount[i] > 0) return g.headcount[i];
  return 0;
};

function splitKey(key: string): { base: string; tier: string | null } {
  const i = key.lastIndexOf('|');
  if (i > 0) {
    const t = key.slice(i + 1);
    if (t === 'A' || t === 'B') return { base: key.slice(0, i), tier: t };
  }
  return { base: key, tier: null };
}

/**
 * A filter restricted to a set of group keys, so the "Other" bucket can be
 * RE-QUERIED rather than summed. Summing is wrong for every banded measure —
 * you cannot add two medians — so the rest of the ranking is asked for as its
 * own aggregate, on the same basis as the groups above it.
 *
 * Returns null when the rest cannot be expressed as a filter (mixed tiers),
 * in which case the caller omits the bucket and says so rather than drawing a
 * number it cannot stand behind.
 */
function restrictFilter(base: Filter, dimension: Dimension, keys: string[], constantScope: boolean): Filter | null {
  const parts = keys.map(splitKey);
  const tiers = new Set(parts.map((p) => p.tier).filter(Boolean));
  if (tiers.size > 1) return null;
  const f: Filter = { ...base, constantScope };
  if (tiers.size === 1) f.tier = tiers.has('B') ? 'AB' : 'A';
  const bases = parts.map((p) => p.base);

  switch (dimension) {
    case 'department': case 'organisation': {
      const idx = bases.map((id) => ds.orgIdx.get(id)).filter((i): i is number => i != null);
      if (!idx.length) return null;
      f.orgs = new Set(idx); f.depts = f.orgs;
      return f;
    }
    case 'profession': {
      const idx = bases.map((k) => Number(k.slice(1))).filter((n) => Number.isFinite(n));
      if (!idx.length) return null;
      f.profs = new Set(idx);
      return f;
    }
    case 'grade': {
      const idx = bases.map((k) => Number(k.slice(1))).filter((n) => Number.isFinite(n));
      if (!idx.length) return null;
      f.grades = new Set(idx);
      return f;
    }
    case 'family': {
      const fams = new Set(bases.map((k) => k.slice(1)));
      const idx: number[] = [];
      ds.meta.orgs.forEach((o, i) => { if (fams.has(o.family)) idx.push(i); });
      if (!idx.length) return null;
      f.orgs = new Set(idx); f.depts = f.orgs;
      return f;
    }
    default:
      return null;
  }
}

interface Display {
  drawn: Series[];
  /** every group, capped or not — the table twin and the ranked bar use this */
  all: SeriesGroup[];
  result: SeriesResult;
  banded: boolean;
  otherKeys: string[];
  omitted: string[];
  /** pay points not drawn because they rest on fewer than nFloor bands */
  thinPoints: number;
  /** a ranked dimension has no ranking choice to offer — the ladder is the order */
  ordinal: boolean;
}

/**
 * Rank, cap at four hues, merge the rest into one labelled "Other".
 *
 * The profession chart used to draw eleven and fifteen series: seven adjacent
 * bands in identical ghost grey with seven identical legend swatches. Four is
 * the number the palette validates for; the fifth slot is "Other", drawn in
 * the ghost ink, and the table twin still carries every group.
 */
function buildDisplay(result: SeriesResult, filter: Filter, dimension: Dimension, measure: Measure): Display {
  const banded = isBandedMeasure(measure);
  const ordinal = dimension === 'grade';
  const groups = [...result.groups];

  // Beat 03 promises, in prose, that "below thirty posts the instrument stops
  // drawing a trend and says so". It did not: charts.ts takes one sampleSize
  // for the whole chart, so a group resting on four disclosed bands in one
  // quarter was drawn at full weight — and because the ranking reads the LAST
  // value, a single thin point could also set the y-domain and decide which
  // four groups get a hue. A pay point under the floor is now simply not
  // drawn, and the ranking reads the floored series. Counts are exempt: for a
  // census n IS the population.
  const floor = result.notes.nFloor ?? N_FLOOR;
  const mask = (g: SeriesGroup): (number | null)[] => {
    const v = values(g, banded);
    if (!banded) return v;
    return v.map((x, i) => (x == null || (g.n[i] ?? 0) >= floor ? x : null));
  };
  let thinPoints = 0;
  const drawable = (g: SeriesGroup): (number | null)[] => {
    const v = values(g, banded), m = mask(g);
    if (banded) for (let i = 0; i < v.length; i++) if (v[i] != null && m[i] == null) thinPoints += 1;
    return m;
  };

  if (ordinal) {
    // A grade ladder has an order of its own; ranking it by value would be a
    // category error. Senior first, and the ramp follows the ladder.
    groups.sort((a, b) => Number(splitKey(a.key).base.slice(1)) - Number(splitKey(b.key).base.slice(1)));
  } else if (rankBy === 'size') {
    // By SIZE: the most recent non-empty headcount, which is the population a
    // reader assumes a breakdown is a breakdown of. Headcount is carried on
    // every group whatever the measure, so the four hues do not jump about
    // when the measure lever moves.
    groups.sort((a, b) => latestHeadcount(b) - latestHeadcount(a));
  } else {
    groups.sort((a, b) => (lastOf(mask(b)) ?? -Infinity) - (lastOf(mask(a)) ?? -Infinity));
  }

  const top = groups.slice(0, MAX_CATEGORICAL);
  const rest = groups.slice(MAX_CATEGORICAL);
  const drawn: Series[] = top.map((g, i) => ({
    key: g.key,
    label: g.label,
    color: ordinal ? ordinalColor(i, Math.min(groups.length, MAX_CATEGORICAL)) : colorFor(i, g.key),
    values: drawable(g),
  }));

  const omitted: string[] = [];
  const otherKeys = rest.map((g) => g.key);
  if (rest.length) {
    const rf = restrictFilter(filter, dimension, otherKeys, result.notes.constantScope);
    let merged: SeriesGroup | null = null;
    if (rf) {
      try { merged = series(ds, rf, measure, 'none').groups[0] ?? null; } catch { merged = null; }
    }
    const names = rest.map((g) => g.label);
    // Name the residual after its dimension. "Professional group: Other" is a
    // real published value, so a pooled bucket also called "Other" put two
    // different meanings of the word in one legend.
    const noun = OTHER_NOUN[dimension] ?? 'groups';
    const label = rest.length <= 2
      ? `Other ${noun} (${rest.length}): ${names.join(', ')}`
      : `Other ${noun} (${rest.length})`;
    if (merged) {
      drawn.push({ key: '__other', label, color: OTHER_COLOR, values: drawable(merged) });
    } else {
      omitted.push(...names);
    }
  }

  return { drawn, all: groups, result, banded, otherKeys, omitted, thinPoints, ordinal };
}

/**
 * The ranking control: which four groups get a hue, and on what grounds.
 *
 * Rendered only where the cap actually bites. With four or fewer groups every
 * one of them is drawn and there is no decision to expose; on an ordinal
 * dimension the ladder IS the order and re-ranking it would be a category
 * error.
 */
function rankControl(disp: Display): HTMLElement | null {
  if (disp.ordinal || disp.all.length <= MAX_CATEGORICAL) return null;
  const opts: [RankBy, string][] = [['size', 'Largest'], ['pay', 'Highest on this measure']];
  return h('div', { class: 'fs-lens', role: 'group', 'aria-label': 'Which groups get a hue' }, [
    h('span', { class: 'label' }, ['Four hues go to the:']),
    ...opts.map(([v, label]) => h('button', {
      class: 'chip' + (rankBy === v ? ' on' : ''), type: 'button', 'aria-pressed': String(rankBy === v),
      onClick: () => { rankBy = v; render(); },
    }, [label])),
  ]);
}

/**
 * What the control just did, in words.
 *
 * Kept OUT of the stage. The instrument is a fixed-height surface with
 * `overflow: hidden`, so three lines of explanation added to the stage push the
 * Table button off the bottom and get themselves clipped mid-sentence — the
 * exact defect the limits prose was moved into normal flow to escape. This
 * string goes to the notes block below the instrument, where nothing can cut it.
 */
function rankNote(disp: Display): string | null {
  if (disp.ordinal || disp.all.length <= MAX_CATEGORICAL) return null;
  const named = disp.drawn.filter((s) => s.key !== '__other').map((s) => s.label).join(', ');
  return rankBy === 'size'
    ? `Ranked by size: the four hued groups are the four largest at the latest filing — ${named}. `
      + 'Everything else is pooled into one labelled band, re-queried rather than summed, and every group is in the table.'
    : `Ranked by ${measureLabel(disp.result.notes.measure).toLowerCase()}: the four hued groups are the four highest, not the four largest — ${named}. `
      + 'The biggest bodies can sit inside the pooled band on this ranking; switch to Largest to see them.';
}

/**
 * Cut a result down to its period range.
 *
 * series() returns every period with nulls outside the range, which is right
 * for a caller reading values but wrong for a chart: a constant-scope window
 * of four years drawn on a sixteen-year axis is three quarters empty space.
 */
function sliceResult(res: SeriesResult, range?: [number, number]): SeriesResult {
  if (!range) return res;
  const [a, b] = range;
  if (a <= 0 && b >= res.periods.length - 1) return res;
  const cut = <T,>(arr: T[]): T[] => arr.slice(a, b + 1);
  return {
    periods: cut(res.periods), periodKeys: cut(res.periodKeys), periodEnds: cut(res.periodEnds),
    groups: res.groups.map((g) => ({
      ...g,
      values: cut(g.values), lo: cut(g.lo), hi: cut(g.hi), n: cut(g.n),
      headcount: cut(g.headcount), disclosureRate: cut(g.disclosureRate),
      thin: cut(g.thin), orgsFiled: cut(g.orgsFiled),
    })),
    notes: res.notes,
  };
}

/** Table twin that keeps BOTH edges of a band, for every group. */
function bandTable(result: SeriesResult, groups: SeriesGroup[], fmt: (n: number | null) => string): HTMLElement {
  const wrap = h('div', { class: 'table-scroll' });
  const t = h('table', { class: 'data-table' });
  t.innerHTML =
    `<thead><tr><th scope="col">Period</th>${groups.map((g) => `<th scope="col">${esc(g.label)}</th>`).join('')}</tr></thead>` +
    `<tbody>${result.periods.map((p, i) =>
      `<tr><td class="tperiod">${esc(p)}</td>${groups.map((g) =>
        `<td>${esc(band(g.lo[i], g.hi[i], fmt))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  wrap.append(t);
  return wrap;
}

/** Table twin for point measures, over every group rather than the drawn four. */
function pointTable(result: SeriesResult, groups: SeriesGroup[], fmt: (n: number | null) => string): HTMLElement {
  const wrap = h('div', { class: 'table-scroll' });
  const t = h('table', { class: 'data-table' });
  t.innerHTML =
    `<thead><tr><th scope="col">Period</th>${groups.map((g) => `<th scope="col">${esc(g.label)}</th>`).join('')}</tr></thead>` +
    `<tbody>${result.periods.map((p, i) =>
      `<tr><td class="tperiod">${esc(p)}</td>${groups.map((g) =>
        `<td>${esc(fmt(g.values[i] ?? null))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  wrap.append(t);
  return wrap;
}

// ---------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------

function confidenceChip(c: Claim['confidence']): HTMLElement {
  return h('span', { class: `fs-chip fs-chip--${c}` }, [c]);
}

interface CardOpts {
  title: string;
  sub?: string;
  variant?: 'card' | 'figure';
  figNo?: string;
  caption?: string;
  build: (host: HTMLElement) => ChartHandle | null;
  /** overrides handle.table — used wherever the twin must carry more than the
   *  drawn series (both band edges, or every group behind a capped chart) */
  table?: HTMLElement;
  legendItems?: LegendItem[];
  onToggleSeries?: (key: string, off: boolean, hidden: string[]) => void;
  hidden?: Iterable<string>;
  foot?: (Node | string)[];
}

/**
 * One card, one chart, one table twin.
 *
 * The Chart/Table toggle lives HERE rather than on the Explore tab, because
 * the warm palette's contrast warnings obligate the tabular relief and it is
 * not dismissable: fourteen of the fifteen charts used to have no twin at all.
 */
function card(o: CardOpts): HTMLElement {
  const figure = o.variant === 'figure';
  const root = figure ? h('figure', { class: 'fs-figure', style: { margin: '26px 0 0' } }) : h('div', { class: 'card' });

  const host = h('div', { class: 'chart-host' });
  const tableSlot = h('div', { class: 'hidden' });
  const toggle = h('button', {
    class: 'chip', type: 'button', 'aria-pressed': 'false',
    onClick: () => {
      const showTable = tableSlot.classList.contains('hidden');
      tableSlot.classList.toggle('hidden', !showTable);
      host.classList.toggle('hidden', showTable);
      toggle.textContent = showTable ? 'Chart' : 'Table';
      toggle.setAttribute('aria-pressed', String(showTable));
    },
  }, ['Table']);

  root.append(h('div', { class: 'card-head' }, [
    append(h('div', {}), [
      h('h3', {}, [o.title]),
      o.sub ? h('div', { class: 'card-sub' }, [o.sub]) : null,
    ]),
    h('div', { class: 'card-tools' }, [toggle]),
  ]));
  root.append(host, tableSlot);

  const handle = o.build(host);
  const twin = o.table ?? handle?.table ?? null;
  if (twin) tableSlot.append(twin);
  else toggle.classList.add('hidden');

  // The legend carries every series the chart draws AND every direct label the
  // collision pass had to drop; without it those labels are simply missing.
  if (o.legendItems && o.legendItems.length) {
    root.append(legend(o.legendItems, { onToggle: o.onToggleSeries, hidden: o.hidden }));
  } else if (handle?.legend) {
    root.append(handle.legend);
  }
  if (handle && handle.droppedLabels.length && !o.legendItems) {
    root.append(h('div', { class: 'rank-note' }, [`Not labelled on the chart for want of room: ${handle.droppedLabels.join(', ')}.`]));
  }
  // Each bare string in `foot` is its own note. Appending them as adjacent text
  // nodes runs them together into one paragraph with no space at the join —
  // "…already happened.The Review Body notes…".
  if (o.foot) {
    append(root, o.foot.map((f) => (typeof f === 'string' ? h('p', { class: 'rank-note' }, [f]) : f)));
  }

  if (figure) {
    root.append(h('figcaption', { class: 'fs-figcaption' }, [
      h('span', { class: 'fs-figno' }, [`Fig. ${o.figNo ?? ''}`]),
      rich('p', {}, o.caption ?? ''),
    ]));
  }
  return root;
}

/** Any table wide enough to overflow scrolls inside its own box. A page that
 *  scrolls sideways on a phone has lost the argument before it starts. */
function scrollTable(table: HTMLElement): HTMLElement {
  return h('div', { class: 'fs-table-wrap' }, [table]);
}

/** A ranked bar chart never draws fewer than three rows: two bars is a
 *  comparison written the long way, and one bar is a number. */
function rankedOrValue(o: {
  title: string; sub: string; rows: { key: string; label: string; value: number | null; color?: string }[];
  fmt: (n: number | null) => string; note?: string;
}): HTMLElement {
  const rows = o.rows.filter((r) => r.value != null);
  if (rows.length < 3) {
    const wrap = h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [append(h('div', {}), [h('h3', {}, [o.title]), h('div', { class: 'card-sub' }, [o.sub])])]),
    ]);
    append(wrap, rows.map((r) => append(h('div', { style: { marginTop: '10px' } }), [
      h('div', { class: 'metric-label' }, [r.label]),
      h('div', { class: 'metric-val' }, [o.fmt(r.value)]),
    ])));
    if (!rows.length) wrap.append(h('div', { class: 'rank-note' }, ['Nothing in range under the current filter.']));
    if (o.note) wrap.append(h('div', { class: 'rank-note' }, [o.note]));
    return wrap;
  }
  // A2: ink for the series, accent for the row the claim is about. Rank is
  // already carried by position, so a hue per row would encode nothing —
  // and recolouring rows as the filter changes is the classic anti-pattern.
  const inked = rows.map((r, i) => ({ ...r, color: r.color ?? (i === 0 ? 'var(--accent)' : INK2) }));
  return card({
    title: o.title, sub: o.sub,
    build: (host) => barChart(host, {
      rows: inked, valueFormat: o.fmt,
      title: `${o.title}. ${o.sub}`,
      desc: `${rows.length} rows, ${rows[0].label} highest at ${o.fmt(rows[0].value)}.`,
    }),
    foot: o.note ? [h('div', { class: 'rank-note' }, [o.note])] : undefined,
  });
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function topbar(): HTMLElement {
  return h('header', { class: 'topbar' }, [
    h('div', { class: 'wrap' }, [
      h('div', { class: 'topbar-inner' }, [
        h('a', { class: 'brand', href: 'https://strangeramblings.com/projects' }, ['scs pay']),
        h('span', { class: 'title' }, [`Field study no ${study.number} · ${study.subject}`]),
        h('div', { class: 'spacer' }),
        depthControl('depth-top'),
        h('button', { class: 'share-btn', type: 'button', onClick: copyLink }, ['Copy view link']),
      ]),
    ]),
  ]);
}

/**
 * B5 depth control: a lever on the prose, not on the model. Persisted.
 *
 * Rendered twice and switched by CSS rather than by a breakpoint listener:
 * in the masthead on a wide screen, and inside the beat below 620px, where a
 * third item in the sticky bar turns it into three lines of broken words.
 */
function depthControl(cls: string): HTMLElement {
  const opts: [Depth, string][] = [['plain', 'Plain'], ['research', 'Research'], ['technical', 'Technical']];
  return h('div', { class: `seg ${cls}`, role: 'group', 'aria-label': 'Reading depth' },
    opts.map(([d, label]) => h('button', {
      class: depth === d ? 'on' : '', type: 'button', 'aria-pressed': String(depth === d),
      onClick: () => {
        depth = d;
        try { localStorage.setItem('scs-depth', d); } catch { /* private mode */ }
        render();
      },
    }, [label])));
}

async function copyLink(): Promise<void> {
  try { await navigator.clipboard.writeText(location.href); toast('View link copied'); }
  catch { toast('Copy failed — use the URL bar'); }
}

function toast(msg: string): void {
  const t = h('div', { class: 'toast', role: 'status' }, [msg]);
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

/**
 * The filter summary, above the tabs, on every beat.
 *
 * The controls only render on the instrument but they scope five other beats,
 * and until now that was announced in body copy alone. Each chip removes its
 * own filter; "clear all" resets every one of them.
 */
function filterChips(): HTMLElement | null {
  const chips: HTMLElement[] = [];
  const chip = (label: string, clear: () => void) => h('span', { class: 'filter-chip' }, [
    label,
    h('button', { class: 'x', type: 'button', 'aria-label': `Remove filter: ${label}`, onClick: clear }, ['×']),
  ]);

  state.depts.forEach((i) => {
    const o = ds.meta.orgs[i];
    if (o) chips.push(chip(o.id, () => update({ depts: state.depts.filter((x) => x !== i) })));
  });
  state.profs.forEach((i) => {
    const p = ds.meta.profs[i];
    if (p) chips.push(chip(p, () => update({ profs: state.profs.filter((x) => x !== i) })));
  });
  state.grades.forEach((i) => {
    const g = ds.meta.grades[i];
    if (g) chips.push(chip(g, () => update({ grades: state.grades.filter((x) => x !== i) })));
  });
  if (state.ddat === 1) chips.push(chip('DDaT roles only', () => update({ ddat: 0 })));
  if (state.policy === 1) chips.push(chip('Policy roles only', () => update({ policy: 0 })));
  if (state.realTerms) chips.push(chip(`Real terms (${facts.yearTo} £)`, () => update({ realTerms: false })));
  if (state.tierB) chips.push(chip('Tier B included', () => update({ tierB: false })));
  if (state.basis !== 'raw') chips.push(chip(basisLabel(state.basis), () => update({ basis: 'raw' })));
  if (state.disclosure !== 'all') chips.push(chip(`${state.disclosure} pay only`, () => update({ disclosure: 'all' })));
  if (state.grain !== BASELINE.grain) chips.push(chip(`${GRAIN_LABEL[state.grain]} periods`, () => update({ grain: BASELINE.grain })));

  if (!chips.length) return null;
  return h('div', { class: 'wrap' }, [
    append(h('div', { class: 'filter-chips', role: 'region', 'aria-label': 'Active filters' }), [
      h('span', { class: 'label' }, ['Filtered:']),
      ...chips,
      h('button', {
        class: 'mini-link', type: 'button',
        onClick: () => update({ depts: [], profs: [], grades: [], ddat: 0, policy: 0, realTerms: false, tierB: false, basis: 'raw', disclosure: 'all', grain: BASELINE.grain }),
      }, ['clear all']),
    ]),
  ]);
}

function tabsNav(): HTMLElement {
  const tabs = study.beats.map((b) => h('button', {
    class: 'tab' + (state.tab === b.slug ? ' active' : ''),
    type: 'button', role: 'tab', id: `tab-${b.slug}`,
    'aria-selected': String(state.tab === b.slug),
    'aria-controls': 'beat-panel',
    tabindex: state.tab === b.slug ? '0' : '-1',
    onClick: () => go(b.slug),
    onKeydown: (e: KeyboardEvent) => {
      const i = study.beats.findIndex((x) => x.slug === state.tab);
      if (e.key === 'ArrowRight') { e.preventDefault(); go(study.beats[(i + 1) % study.beats.length].slug); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(study.beats[(i - 1 + study.beats.length) % study.beats.length].slug); }
      else if (e.key === 'Home') { e.preventDefault(); go(study.beats[0].slug); }
      else if (e.key === 'End') { e.preventDefault(); go(study.beats[study.beats.length - 1].slug); }
    },
  }, [b.no === '00' ? b.name : `${b.no} ${b.name}`]));

  return h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Beats' }, [h('div', { class: 'wrap' }, tabs)]);
}

function footer(): HTMLElement {
  const s = ds.meta.stats;
  return h('footer', { class: 'footer' }, [
    h('div', { class: 'wrap' }, [
      h('h2', { class: 'fs-subhead', id: 'sources' }, ['Sources']),
      h('ol', { class: 'fs-sources' }, study.sources.map((src) => h('li', {}, [
        h('span', { class: 'n' }, [`[${src.n}]`]),
        append(h('span', {}), [
          h('b', {}, [src.org]), ' — ', fill(src.what), ' ',
          h('a', { href: src.url, rel: 'noopener', target: '_blank' }, ['link']),
          src.asOf ? h('span', { class: 'metric-label', style: { display: 'block', marginTop: '4px' } }, [`as of ${fill(src.asOf)} · ${src.kind}`]) : null,
          src.caveat ? h('span', { style: { display: 'block', color: 'var(--text-muted)' } }, [src.caveat]) : null,
        ]),
      ]))),
      h('p', { class: 'fs-disclaimer' }, [study.disclaimer]),
      h('p', { class: 'fs-disclaimer' }, [
        `Source: ${ds.meta.source.name} via ${ds.meta.source.via}, under the ${ds.meta.source.licence}. ` +
        `${facts.posts} published senior post rows across ${facts.orgs} organisations and ${facts.snapshots} filings, ` +
        `${facts.dateFrom} to ${facts.dateTo}. Data generated ${facts.generated}. ` +
        `Pay is a ${gbp(ds.binWidth)} band throughout: no figure here is a salary.`,
      ]),
      s.orgs === 0 ? h('p', { class: 'fs-disclaimer' }, ['This build is empty.']) : null,
    ].filter(Boolean) as Node[]),
  ]);
}

// ---------------------------------------------------------------------------
// Beat furniture — shared by every template
// ---------------------------------------------------------------------------

function beatHeader(beat: Beat): HTMLElement {
  const i = study.beats.findIndex((b) => b.slug === beat.slug);
  return append(h('div', {}), [
    depthControl('depth-inline'),
    h('div', { class: 'fs-beat-rule' }, [
      h('span', { class: 'fs-kicker' }, [beat.no === '00' ? `Field study no ${study.number} · Abstract` : `Beat ${beat.no}`]),
      h('span', { class: 'fill' }),
      h('span', { class: 'beat-progress' }, [
        beat.no === '00'
          ? `${study.beats.length - 1} beats · ${study.beats.reduce((a, b) => a + (b.minutes ?? 0), 0)} min`
          : `${i} of ${study.beats.length - 1}${beat.minutes ? ` · ${beat.minutes} min` : ''}`,
      ]),
    ]),
    h('h1', { class: 'fs-h1' + (beat.no === '00' ? ' fs-h1--display' : '') }, [beat.no === '00' ? study.title : beat.name]),
  ]);
}

function questionClaim(beat: Beat): HTMLElement | null {
  if (!beat.question || !beat.claim) return null;
  const dl = h('dl', { class: 'fs-qc' });
  dl.append(
    h('dt', {}, ['Question']),
    h('dd', {}, [h('p', { class: 'fs-question' }, [fill(beat.question)])]),
    h('dt', { class: 'claim' }, ['Claim']),
    append(h('dd', {}), [
      rich('p', { class: 'fs-claim' }, fill(beat.claim.text)),
      h('div', { style: { marginTop: '10px' } }, [confidenceChip(beat.claim.confidence)]),
    ]),
  );
  return dl;
}

function proseBlock(beat: Beat): HTMLElement {
  const wrap = h('div', {});
  for (const p of beat.prose ?? []) {
    const text = depth === 'plain' ? (p.plain ?? p.research)
      : depth === 'technical' ? (p.technical ?? p.research)
        : p.research;
    wrap.append(rich('p', { class: 'fs-body' + (p.dropCap && depth !== 'plain' ? ' fs-dropcap' : ''), style: { marginTop: '18px' } }, fill(text)));
  }
  return wrap;
}

function marginColumn(beat: Beat): HTMLElement {
  const col = h('div', { class: 'fs-numeral-col' });
  col.append(h('div', { class: 'fs-numeral' }, [beat.no]));
  if (beat.marginNotes?.length) {
    const notes = h('div', { class: 'fs-margin' });
    for (const n of beat.marginNotes) {
      append(notes, [
        n.label ? h('div', { class: 'fs-margin-label' }, [n.label]) : null,
        rich('p', { class: 'fs-aside' }, fill(n.text)),
      ]);
    }
    col.append(notes);
  }
  return col;
}

function citedHere(beat: Beat): HTMLElement | null {
  const ns = new Set<number>();
  const add = (c?: number[]) => c?.forEach((n) => ns.add(n));
  add(beat.claim?.cites);
  beat.figures?.forEach((f) => add(f.cites));
  beat.ledger?.benefits.forEach((b) => add(b.cites));
  beat.ledger?.risks.forEach((b) => add(b.cites));
  if (!ns.size) return null;
  const list = study.sources.filter((s) => ns.has(s.n));
  return append(h('div', {}), [
    h('h3', { class: 'fs-subhead' }, ['Sources cited on this beat']),
    h('ol', { class: 'fs-sources' }, list.map((s: Source) => h('li', {}, [
      h('span', { class: 'n' }, [`[${s.n}]`]),
      append(h('span', {}), [h('b', {}, [s.org]), ' — ', fill(s.what), ' ', h('a', { href: s.url, rel: 'noopener', target: '_blank' }, ['link'])]),
    ]))),
  ]);
}

function closeBlock(beat: Beat): HTMLElement {
  const wrap = h('div', {});
  if (beat.soWhat || beat.openQuestion) {
    wrap.append(h('div', { class: 'fs-close' }, [
      append(h('div', {}), [
        h('div', { class: 'fs-margin-label' }, ['So what']),
        beat.soWhat ? rich('p', { class: 'fs-sowhat' }, fill(beat.soWhat)) : null,
      ]),
      beat.openQuestion ? h('div', { class: 'fs-open' }, [
        h('div', { class: 'fs-margin-label' }, ['Open question']),
        rich('p', { class: 'fs-body', style: { margin: '0' } }, fill(beat.openQuestion.text)),
        rich('div', { class: 'fs-falsifier' }, `Falsifier — ${fill(beat.openQuestion.falsifier)}`),
      ]) : h('div', {}),
    ]));
  }
  const i = study.beats.findIndex((b) => b.slug === beat.slug);
  const prev = study.beats[i - 1], next = study.beats[i + 1];
  wrap.append(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginTop: '26px', flexWrap: 'wrap' } }, [
    prev ? h('button', { class: 'fs-prev', type: 'button', style: { background: 'none', border: '0', cursor: 'pointer' }, onClick: () => go(prev.slug) }, [`← ${prev.no === '00' ? prev.name : `${prev.no} ${prev.name}`}`]) : h('span', {}),
    next ? h('button', { class: 'fs-next', type: 'button', style: { border: '0', cursor: 'pointer' }, onClick: () => go(next.slug) }, [`${next.no} ${next.name} →`]) : h('span', {}),
  ]));
  return wrap;
}

// ---------------------------------------------------------------------------
// Figures — one renderer per `figure.data` key in study.ts
// ---------------------------------------------------------------------------

function figureFor(fig: StudyFigure): HTMLElement {
  const commonSub = `${measureUnitFor(fig)} · source: gov.uk organograms, as at ${facts.dateTo}`;
  switch (fig.data) {
    case 'medianBandTotal': return figMedianBand(fig, commonSub);
    case 'headcountTotal': return figHeadcount(fig, commonSub);
    case 'coverageMatrix': return figCoverage(fig);
    case 'disclosureByGrade': return figDisclosureByGrade(fig, commonSub);
    case 'abovePm': return figAbovePm(fig, commonSub);
    case 'ddatVsPolicy': return figDdatVsPolicy(fig, commonSub);
    case 'gradeMix': return figGradeMix(fig, commonSub);
    case 'payLadder': return figPayLadder(fig, commonSub);
    case 'agencyDecomposition': return figAgency(fig);
    case 'highEarners': return figHighEarners(fig);
    case 'unclassifiedShare': return figUnclassified(fig, commonSub);
    case 'cpihTable': return figCpih(fig);
    case 'comparators': return figComparators(fig);
    case 'ssrbRestatement': return figSsrbRestatement(fig);
    default: return h('div', { class: 'rank-note' }, [`No renderer for figure ${fig.no}.`]);
  }
}

const measureUnitFor = (fig: StudyFigure): string => fig.unit ?? '';

function figMedianBand(fig: StudyFigure, sub: string): HTMLElement {
  const filter = toFilter({ constantScope: false });
  const res = series(ds, filter, 'medianPay', 'none');
  const g = res.groups[0];
  const fmt = measureFormat('medianPay');
  if (!g) return h('div', { class: 'rank-note' }, ['No published bands under the current filter.']);
  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'The median band for all published senior pay',
    sub,
    build: (host) => fanChart(host, {
      labels: res.periods, lo: g.lo, mid: new Array(res.periods.length).fill(null), hi: g.hi,
      color: colorFor(0), yFormat: fmt, height: 320,
      title: 'The median published pay band over time',
      desc: `A channel between the lower and upper bound of the median band, ${res.periods[0]} to ${res.periods[res.periods.length - 1]}. The middle post sits inside the channel and the data cannot say where.`,
    }),
    table: bandTable(res, [g], fmt),
    legendItems: [{ key: 'band', label: `Median band — lower to upper bound (${gbp(ds.binWidth)} wide)`, color: colorFor(0) }],
    foot: [limitsLine(res, g)],
  });
}

function figHeadcount(fig: StudyFigure, sub: string): HTMLElement {
  const res = series(ds, toFilter({ constantScope: false }), 'headcount', 'none');
  const g = res.groups[0];
  const fmt = measureFormat('headcount');
  if (!g) return h('div', { class: 'rank-note' }, ['Nothing filed under the current filter.']);
  const s: Series = { key: 'all', label: 'Published senior posts', color: colorFor(0), values: g.values };
  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Published senior posts per period', sub,
    build: (host) => lineChart(host, {
      labels: res.periods, series: [s], yFormat: fmt, yZero: true, height: 260,
      title: 'Published senior posts per period',
      desc: 'A census of filed posts, not an estimate of posts in existence.',
    }),
    legendItems: [{ key: s.key, label: s.label, color: s.color }],
    foot: [limitsLine(res, g)],
  });
}

function figCoverage(fig: StudyFigure): HTMLElement {
  // Years across, organisations down. Three countable states: no filing, a
  // filing, more than one — never a continuous ramp, in which "did not file"
  // and "filed a handful" look identical.
  const years: string[] = [];
  for (const iso of ds.meta.dates) { const y = iso.slice(0, 4); if (!years.includes(y)) years.push(y); }
  years.sort();
  const counts = new Map<string, number[]>();
  for (const o of ds.meta.orgs) counts.set(o.id, new Array(years.length).fill(0));
  for (const snap of ds.meta.snapshots) {
    const row = counts.get(snap.org);
    if (!row) continue;
    const yi = years.indexOf(ds.meta.dates[snap.d].slice(0, 4));
    if (yi >= 0) row[yi] += 1;
  }
  const allRows = ds.meta.orgs
    .map((o) => ({ key: o.id, label: `${o.id} — ${o.name}`, tier: o.tier, total: (counts.get(o.id) ?? []).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const shown = allRows.filter((r) => r.tier === 'A').slice(0, 22);

  const value = (key: string, col: number): number | null => {
    const n = counts.get(key)?.[col] ?? 0;
    return n === 0 ? null : n === 1 ? 1 : 2;
  };
  // Drawn as a DOM grid rather than through heatmap(), deliberately. The
  // sequential ramp normalises its own minimum to seqColor(0) = #f0e6d6, which
  // composites to within a rounding error of the null cell over this surface:
  // with only two live states, "filed once" and "did not file" came out the
  // same colour — the single thing this matrix exists to show. Three states
  // need three flat swatches, not a ramp with two stops.
  const LIGHT = ordinalColor(0, 4);
  const HEAVY = ordinalColor(2, 4);

  const key = legend([
    { key: 'empty', label: 'Did not file', color: 'var(--surface-sunken)' },
    { key: 'one', label: 'Filed once in the year', color: LIGHT },
    { key: 'many', label: 'Filed twice or more', color: HEAVY },
  ]);
  const emptySwatch = key.querySelector('.sw') as HTMLElement | null;
  if (emptySwatch) emptySwatch.style.border = '1px solid var(--line-hair)';

  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Who filed, and when',
    sub: `${shown.length} Tier A organisations by filings; the table twin carries all ${facts.orgs}`,
    build: (host) => {
      const grid = h('div', {
        class: 'covmatrix',
        role: 'img',
        'aria-label': `Coverage matrix: ${shown.length} organisations down, ${years.length} years across. `
          + 'Three states — did not file, filed once in the year, filed twice or more. '
          + 'Empty cells are gaps in publication, not falls in headcount.',
        style: { gridTemplateColumns: `132px repeat(${years.length}, minmax(14px, 1fr))` },
      });
      grid.append(h('div', { class: 'cov-name' }, ['']));
      for (const y of years) grid.append(h('div', { class: 'cov-head' }, [y.slice(2)]));
      for (const r of shown) {
        grid.append(h('div', { class: 'cov-name', title: r.label }, [r.key]));
        for (let c = 0; c < years.length; c++) {
          const v = value(r.key, c);
          const n = counts.get(r.key)?.[c] ?? 0;
          if (v == null) {
            grid.append(h('div', { class: 'cov-cell empty', title: `${r.key} · ${years[c]} — did not file` }));
          } else {
            grid.append(h('div', {
              class: 'cov-cell',
              title: `${r.key} · ${years[c]} — ${num(n)} ${n === 1 ? 'filing' : 'filings'}`,
              style: { background: v === 1 ? LIGHT : HEAVY },
            }));
          }
        }
      }
      host.style.overflowX = 'auto';
      host.style.padding = '8px 0';
      host.append(grid);
      return null;
    },
    table: matrixTable(years, allRows.map((r) => ({ key: r.key, label: r.label })), (k, c) => counts.get(k)?.[c] ?? 0, (n) => num(n)),
    legendItems: undefined,
    foot: [
      key,
      h('div', { class: 'rank-note' }, [
        `${facts.filesFail} of ${facts.files} source files could not be read at all (${facts.failRate}); ${facts.undated} more carried no resolvable reference date and ${facts.rejectedSiblings} were older uploads of a filing already held.`,
      ]),
    ],
  });
}

function figDisclosureByGrade(fig: StudyFigure, sub: string): HTMLElement {
  const filter = toFilter({ constantScope: false });
  const res = series(ds, filter, 'disclosureRate', 'grade');
  const disp = buildDisplay(res, filter, 'grade', 'disclosureRate');
  const fmt = measureFormat('disclosureRate');
  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Disclosure rate by grade', sub,
    build: (host) => lineChart(host, {
      labels: res.periods, series: disp.drawn, yFormat: fmt, yZero: true, height: 300,
      title: 'Share of published senior posts that also publish a pay band, by grade',
      desc: disp.drawn.map((s) => `${s.label} ${fmt(lastOf(s.values))} at the latest filing`).join('; '),
    }),
    table: pointTable(res, disp.all, fmt),
    legendItems: disp.drawn.map((s) => ({ key: s.key, label: s.label, color: s.color })),
    foot: omittedNote(disp),
  });
}

/**
 * Fig 3.2 — the two threshold trackers, both drawn as ribbons.
 *
 * Two panels rather than one chart with four lines, and one shared y-domain
 * rather than two: a £5,000 band means neither count is a number, and drawing
 * each panel to its own scale would make two different counts look identical.
 * There is no line through the middle of either ribbon, because a line through
 * the middle would be a midpoint and this data has none.
 */
function figAbovePm(fig: StudyFigure, sub: string): HTMLElement {
  const filter = toFilter({ constantScope: false });
  const pm = countAbove(ds, filter, (p, res) => pmPayFor(res.periodEnds[p]));
  const k150 = countAbove(ds, filter, () => 150000);
  const fmt = (n: number | null) => num(n);

  // A period nobody filed into is a null, not a zero: "no filing" and "nobody
  // was paid that much" are different facts and only one of them is knowable.
  const nulled = (a: number[], total: number[]): (number | null)[] =>
    a.map((v, i) => (total[i] > 0 ? v : null));
  const pmLo = nulled(pm.certain, pm.total), pmHi = nulled(pm.possible, pm.total);
  const kLo = nulled(k150.certain, k150.total), kHi = nulled(k150.possible, k150.total);

  let dmax = 0;
  for (const a of [pmHi, kHi]) for (const v of a) if (v != null) dmax = Math.max(dmax, v);
  const domain: [number, number] = [0, dmax || 1];

  let li = -1;
  for (let i = pm.total.length - 1; i >= 0; i--) if (pm.total[i] > 0) { li = i; break; }
  const period = li >= 0 ? pm.periods[li] : '—';
  const pmEntry = pmPayEntry(li >= 0 ? pm.periods[li] : Number(facts.yearTo));
  const openNote = openPeriodNoteFor(pm.periods, filter.grain ?? BASELINE.grain);

  const pmColor = colorFor(0), kColor = colorFor(1);
  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Above the line — as a range, because the line cannot be resolved', sub,
    build: (host) => {
      const grid = h('div', {
        class: 'cellgrid panelgrid',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' },
      });
      const pmHost = h('div', {});
      const kHost = h('div', {});
      grid.append(
        h('div', {}, [h('div', { class: 'metric-label' }, ['Paid more than the Prime Minister']), pmHost]),
        h('div', {}, [h('div', { class: 'metric-label' }, ['Paid £150,000 or more']), kHost]),
      );
      host.append(grid);
      // The DRAWN LINE is the certainly-above count and the shaded head-room
      // above it is the rest of what the band allows. It is not a midpoint —
      // it is a published bound, the one a reader can stand behind — and it has
      // to be drawn, because in most periods the two counts are equal and a
      // ribbon between two equal numbers has no height and renders as nothing.
      fanChart(pmHost, {
        labels: pm.periods, lo: pmLo, mid: pmLo, hi: pmHi,
        color: pmColor, yFormat: fmt, height: 220, yDomain: domain,
        title: 'Senior posts paid more than the Prime Minister',
        desc: 'The line counts the posts whose published pay floor is already above the Prime Minister\'s entitlement; '
          + 'the shaded head-room above it counts the posts whose published ceiling could be. Both panels share one axis.',
      });
      fanChart(kHost, {
        labels: k150.periods, lo: kLo, mid: kLo, hi: kHi,
        color: kColor, yFormat: fmt, height: 220, yDomain: domain,
        title: 'Senior posts paid £150,000 or more',
        desc: 'The line counts the posts whose published pay floor is already at or above £150,000; '
          + 'the shaded head-room above it counts the posts whose published ceiling could be. Both panels share one axis.',
      });
      return null;
    },
    // The fan's own twin is labelled p25/median/p75, which these bounds are
    // not. One correctly-named twin for both panels instead.
    table: seriesTable(pm.periods, [
      { key: 'pmc', label: 'More than the PM — certainly', color: pmColor, values: pmLo },
      { key: 'pmp', label: 'More than the PM — possibly', color: pmColor, values: pmHi },
      { key: 'kc', label: '£150,000+ — certainly', color: kColor, values: kLo },
      { key: 'kp', label: '£150,000+ — possibly', color: kColor, values: kHi },
      { key: 'tot', label: 'Posts with a published band', color: OTHER_COLOR, values: nulled(pm.total, pm.total) },
    ], fmt),
    legendItems: [
      { key: 'pm', label: 'Against the Prime Minister’s entitlement — line: certainly above, shading: possibly above', color: pmColor },
      { key: 'k150', label: 'Against £150,000 — line: certainly above, shading: possibly above', color: kColor },
    ],
    foot: [
      h('div', { class: 'rank-note' }, [
        `At ${period}: ${countRange(pm.certain[li] ?? null, pm.possible[li] ?? null)} posts out-earned the Prime Minister and `
        + `${countRange(k150.certain[li] ?? null, k150.possible[li] ?? null)} were at or above £150,000, out of `
        + `${num(li >= 0 ? pm.total[li] : null)} with a published band. Each pair is one answer, not two: the width between them is the width of the band.`,
      ]),
      h('div', { class: 'rank-note' }, [
        `Threshold: the Prime Minister's total pay entitlement for the year — ${gbp(pmEntry.value)} in ${pmEntry.year}`
        + `${pmEntry.published ? '' : `, carried forward from ${pmEntry.carriedForwardFrom} and drawn as an absence rather than a figure`}. `
        + `${PM_PAY_SOURCE.publisher}, “${PM_PAY_SOURCE.title}”, verified to ${PM_PAY_VERIFIED_TO}. `
        + `Entitlement, not receipt: prime ministers have repeatedly declined part of the ministerial element. `
        + `Posts published with one edge of the band only cannot be tested against a threshold and are in neither count.`,
      ]),
      ...(openNote ? [h('div', { class: 'rank-note' }, [openNote])] : []),
    ],
  });
}

function figDdatVsPolicy(fig: StudyFigure, sub: string): HTMLElement {
  const filter = toFilter({ constantScope: false });
  const res = series(ds, filter, 'medianPay', 'ddatPolicy');
  const disp = buildDisplay(res, filter, 'ddatPolicy', 'medianPay');
  const fmt = measureFormat('medianPay');
  const highlight = lens === 'Digital & data' ? 'ddat' : lens === 'Policy' ? 'policy' : null;
  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Digital and data against policy', sub,
    build: (host) => lineChart(host, {
      labels: res.periods, series: disp.drawn, yFormat: fmt, height: 300, highlightKey: highlight,
      title: 'Lower bound of the median published pay band, digital and data against policy',
      desc: 'Each line is the lower bound of that group\'s median band. The upper bound is in the table twin; the band is never narrower than the £5,000 the publisher used.',
    }),
    table: bandTable(res, disp.all, fmt),
    legendItems: disp.drawn.map((s) => ({ key: s.key, label: s.label, color: s.color })),
    foot: [
      h('div', { class: 'rank-note' }, ['Lines are lower bounds. Switch to Table for both edges of every band.']),
      ...(omittedNote(disp) ?? []),
      ...((t) => t ? [t] : [])(thinNote(disp, res)),
      disclosureLine(res, disp.all),
    ],
  });
}

function figGradeMix(fig: StudyFigure, sub: string): HTMLElement {
  const filter = toFilter({ constantScope: false });
  const res = series(ds, filter, 'headcount', 'grade');
  const disp = buildDisplay(res, filter, 'grade', 'headcount');
  // Stack least senior at the base, so the ramp runs light at the bottom to
  // dark at the top and the SCS4 sliver is not buried under a mustard band.
  const stacked = [...disp.drawn].reverse();
  const fmt = measureFormat('headcount');
  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Grade mix of published senior posts', sub,
    build: (host) => stackedArea(host, {
      labels: res.periods, series: stacked, percent: true, valueFormat: fmt, height: 300,
      title: 'Grade mix of published senior posts, as a share',
      desc: stacked.map((s) => s.label).join(', '),
    }),
    table: pointTable(res, disp.all, fmt),
    legendItems: disp.drawn.map((s) => ({ key: s.key, label: s.label, color: s.color })),
    foot: omittedNote(disp),
  });
}

/** Header spec for the small tables the ported blocks build. */
interface TableHead { label: string; num?: boolean }

/** A plain study table. Cells may be nodes, so a pill or a sparkline can sit in one. */
function fsTable(
  head: TableHead[],
  rows: { cells: (string | Node)[]; cls?: string }[],
  opts: { sigma?: (string | Node)[]; maxHeight?: string } = {},
): HTMLElement {
  const table = h('table', { class: 'fs-table' });
  table.append(h('thead', {}, [h('tr', {}, head.map((c) =>
    h('th', { class: c.num ? 'num' : '', scope: 'col' }, [c.label])))]));
  const body = h('tbody', {});
  const row = (cells: (string | Node)[], cls = '') => h('tr', { class: cls }, cells.map((v, i) =>
    h('td', { class: head[i]?.num ? 'num' : '' }, [v])));
  for (const r of rows) body.append(row(r.cells, r.cls));
  if (opts.sigma) body.append(row(opts.sigma, 'sigma'));
  table.append(body);
  if (!opts.maxHeight) return scrollTable(table);
  return h('div', { class: 'table-scroll', style: { marginTop: '20px', maxHeight: opts.maxHeight, background: 'transparent' } }, [table]);
}

/** The bordered "what this cannot tell you" block. */
function warnBlock(label: string, lines: (string | Node)[]): HTMLElement {
  return h('div', { class: 'fs-warn', style: { marginTop: '24px' } }, [
    h('div', { class: 'label' }, [label]),
    ...lines.map((l) => (typeof l === 'string' ? rich('p', { class: 'fs-body', style: { marginTop: '8px' } }, l) : l)),
  ]);
}

/**
 * Fig 5.4 — the four SCS rungs, each drawn as the range it actually is.
 *
 * One shared y-domain across all four panels, without which each rung rescales
 * to its own data and a £20,000 window is drawn beside a £90,000 one looking
 * identical. There is no median line in any panel, because there is no median:
 * the ribbon runs from the median of every published floor at that grade to the
 * median of every published ceiling, and the truth is somewhere inside it.
 */
function figPayLadder(fig: StudyFigure, sub: string): HTMLElement {
  const filter = toFilter({ constantScope: false, grades: null });
  const res = series(ds, filter, 'medianPay', 'grade');
  const isRanked = (label: string) => /^SCS[1-4]\b/.test(label);
  const ladder = ds.meta.grades.filter(isRanked).slice().reverse();   // junior first: the ramp direction
  const colorOf = (label: string) => {
    const at = ladder.indexOf(label);
    return at < 0 ? OTHER_COLOR : ordinalColor(at, ladder.length);
  };
  const rungs = ladder
    .map((label) => ({ label, g: res.groups.find((x) => x.label === label) }))
    .filter((r): r is { label: string; g: SeriesGroup } => !!r.g)
    .reverse();                                                       // senior panel first

  if (!rungs.length) return h('div', { class: 'rank-note' }, ['No SCS grade carries a published band under the current filter.']);

  let dmin = Infinity, dmax = -Infinity;
  for (const r of rungs) {
    for (const v of r.g.lo) if (v != null) dmin = Math.min(dmin, v);
    for (const v of r.g.hi) if (v != null) dmax = Math.max(dmax, v);
  }
  const domain: [number, number] | undefined =
    Number.isFinite(dmin) && Number.isFinite(dmax) ? [dmin, dmax] : undefined;
  const blank: (number | null)[] = new Array(res.periods.length).fill(null);

  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'The rungs, each drawn as the range it actually is', sub,
    build: (host) => {
      const grid = h('div', {
        class: 'cellgrid panelgrid',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' },
      });
      host.append(grid);
      for (const r of rungs) {
        const chart = h('div', {});
        let peak = 0;
        for (const n of r.g.n) peak = Math.max(peak, n);
        let lp = -1;
        for (let i = r.g.lo.length - 1; i >= 0; i--) if (r.g.lo[i] != null) { lp = i; break; }
        grid.append(h('div', {}, [
          h('div', { class: 'metric-label' }, [r.label]),
          // The ribbon is £5,000 tall on a £150,000 axis, so it reads as a
          // line. The number goes beside it rather than being left to the eye.
          h('div', { class: 'metric-val', style: { fontSize: 'var(--fs-body)' } }, [
            lp >= 0 ? roundedBand(r.g.lo[lp], r.g.hi[lp]) : '—',
          ]),
          h('div', { class: 'metric-delta' }, [
            lp >= 0 ? `${res.periods[lp]} · n = ${num(r.g.n[lp])} · peak n = ${num(peak)}` : 'no published pay',
          ]),
          chart,
        ]));
        fanChart(chart, {
          labels: res.periods, lo: r.g.lo, mid: blank, hi: r.g.hi,
          color: colorOf(r.label), yFormat: (n) => gbp(n, { compact: true }),
          height: 190, yDomain: domain,
          title: `${r.label} median pay band`,
          desc: `Median published pay floor to median published ceiling for ${r.label}, `
            + `${res.periods[0]} to ${res.periods[res.periods.length - 1]}, on the axis shared by every rung.`,
        });
      }
      return null;
    },
    table: seriesTable(res.periods, rungs.flatMap((r) => [
      { key: `${r.label}-lo`, label: `${r.label} — median floor`, color: colorOf(r.label), values: r.g.lo },
      { key: `${r.label}-hi`, label: `${r.label} — median ceiling`, color: colorOf(r.label), values: r.g.hi },
    ]), (n) => gbp(n)),
    legendItems: rungs.map((r) => ({ key: r.label, label: r.label, color: colorOf(r.label) })),
    foot: [
      h('div', { class: 'rank-note' }, [
        'One axis for all four panels, so the distance between the rungs is the distance on the page. '
        + 'The single-hue ramp runs junior-light to senior-dark: the grades are ordered, and unordered colour would say otherwise.',
      ]),
      disclosureLine(res, rungs.map((r) => r.g)),
    ],
  });
}

function figUnclassified(fig: StudyFigure, sub: string): HTMLElement {
  const filter = toFilter({ constantScope: false });
  const res = series(ds, filter, 'headcount', 'profession');
  const soft = new Set(['Other', 'Not stated']);
  const softIdx = ds.meta.profs.map((p, i) => (soft.has(p) ? i : -1)).filter((i) => i >= 0);
  const vals: (number | null)[] = res.periods.map((_p, i) => {
    let total = 0, unclassified = 0;
    for (const g of res.groups) {
      const v = g.headcount[i] ?? 0;
      total += v;
      const pi = Number(splitKey(g.key).base.slice(1));
      if (softIdx.includes(pi)) unclassified += v;
    }
    return total > 0 ? unclassified / total : null;
  });
  const fmt = (n: number | null) => share(n);
  const s: Series = { key: 'soft', label: 'Other or Not stated', color: colorFor(2), values: vals };
  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Posts with no usable professional group', sub,
    build: (host) => lineChart(host, {
      labels: res.periods, series: [s], yFormat: fmt, yZero: true, height: 260,
      title: 'Share of published senior posts whose professional group is Other or Not stated',
      desc: 'The soft floor under every profession chart in this study.',
    }),
    legendItems: [{ key: s.key, label: s.label, color: s.color }],
  });
}

function figAgency(fig: StudyFigure): HTMLElement {
  const wrap = h('div', { class: 'fs-figure', style: { margin: '26px 0 0' } });
  const tierA = ds.meta.orgs.filter((o) => o.tier === 'A');
  const ranked = [...ds.meta.coverage]
    .filter((c) => tierA.some((o) => o.id === c.org))
    .sort((a, b) => b.posts - a.posts);
  // Default to a body that actually decomposes. The number of CKAN packages
  // summed into one filing is the cheapest signal of that, and it is in
  // meta.json — so the default is chosen without fetching a single shard.
  const parts = new Map<string, number>();
  for (const s of ds.meta.snapshots) parts.set(s.org, Math.max(parts.get(s.org) ?? 0, s.parts.length));
  const decomposes = [...ranked].sort((a, b) =>
    (parts.get(b.org) ?? 0) - (parts.get(a.org) ?? 0) || b.posts - a.posts);
  const chosen = agencyOrg
    ?? (state.depts.length ? ds.meta.orgs[state.depts[0]]?.id : null)
    ?? decomposes[0]?.org ?? null;

  const picker = h('select', {
    'aria-label': 'Organisation to decompose',
    // A select sizes to its widest option, and a full department name inside a
    // 390px viewport took the whole page sideways. Cap it and truncate.
    style: { maxWidth: 'min(100%, 250px)' },
    onChange: (e: Event) => { agencyOrg = (e.target as HTMLSelectElement).value; render(); },
  }, ranked.map((c) => {
    const org = ds.meta.orgs.find((o) => o.id === c.org);
    const name = org?.name ?? c.org;
    const opt = h('option', { value: c.org }, [`${c.org} — ${name.length > 30 ? name.slice(0, 29) + '…' : name}`]);
    if (c.org === chosen) opt.setAttribute('selected', '');
    return opt;
  }));

  wrap.append(h('div', { class: 'card-head' }, [
    append(h('div', {}), [
      h('h3', {}, ['Inside one department']),
      h('div', { class: 'card-sub' }, ['The Organisation column of the published CSV, which most readings of this data discard']),
    ]),
    h('div', { class: 'card-tools' }, [picker]),
  ]));

  const slot = h('div', {}, [h('div', { class: 'rank-note' }, ['Loading the post shard…'])]);
  wrap.append(slot);
  wrap.append(h('figcaption', { class: 'fs-figcaption' }, [
    h('span', { class: 'fs-figno' }, [`Fig. ${fig.no}`]),
    rich('p', {}, fig.caption),
  ]));

  if (chosen) {
    const token = renderToken;
    loadPosts(ds, chosen).then((rows) => {
      if (token !== renderToken) return;
      clear(slot).append(agencyChart(chosen, rows));
    }).catch((err) => {
      if (token !== renderToken) return;
      clear(slot).append(h('div', { class: 'rank-note' }, [`No post shard for ${chosen}: ${String(err)}`]));
    });
  } else {
    clear(slot).append(h('div', { class: 'rank-note' }, ['No organisation in scope.']));
  }
  return wrap;
}

function agencyChart(orgId: string, rows: PostRow[]): HTMLElement {
  const latest = rows.reduce((a, r) => (r.date > a ? r.date : a), '');
  const at = rows.filter((r) => r.date === latest && r.status !== 'eliminated');
  const byUnit = new Map<string, { posts: number; disclosed: number }>();
  for (const r of at) {
    const key = r.suborg ?? r.pkg ?? orgId;
    const cur = byUnit.get(key) ?? { posts: 0, disclosed: 0 };
    cur.posts += 1;
    if (r.disclosed) cur.disclosed += 1;
    byUnit.set(key, cur);
  }
  const allBars = [...byUnit.entries()]
    .map(([label, v]) => ({ key: label, label, value: v.posts, disclosed: v.disclosed }))
    .sort((a, b) => b.value - a.value);
  const bars = allBars.slice(0, 12);
  const groups = groupPosts(at);
  const withPur = groups.filter((g) => g.identity === 'pur').length;

  // ROWS and POSTS are different counts and the caption used to print one under
  // the other's name: 1,074 rows across five bodies, then "1,071 of 1,071 posts
  // carry a Post Unique Reference", which reads as an arithmetic slip. It is
  // not one — some filings repeat a reference inside the same file (MOD files
  // four rows as reference "0", titled "Not in Post") and those collapse into a
  // single post. The difference is now named rather than left to be spotted.
  const collapsed = at.length - groups.length;
  const worst = groups.reduce((a, g) => (g.points.length > (a?.points.length ?? 1) ? g : a), groups[0]);
  const collapseNote = collapsed > 0
    ? `${num(at.length)} published rows group into ${num(groups.length)} distinct posts: ${num(collapsed)} row${collapsed === 1 ? '' : 's'} `
      + `repeat a post reference already used in the same file`
      + `${worst && worst.points.length > 1 ? ` — “${worst.title || 'untitled'}” is filed ${num(worst.points.length)} times under one reference` : ''}, `
      + `and one reference filed twice is one post, not two. `
    : `${num(at.length)} published rows are ${num(groups.length)} distinct posts — no reference is repeated inside the file. `;
  const purNote = `${num(withPur)} of ${num(groups.length)} carry a Post Unique Reference, which is what makes a pay trajectory possible.`;
  const truncNote = allBars.length > bars.length
    ? ` Only the ${bars.length} largest of ${allBars.length} bodies inside the file are drawn, so the bars do not sum to the row count above.`
    : '';

  const note = byUnit.size < 3
    ? `${orgId} files as a single body: the Organisation column inside its own CSV names only itself, so there is nothing to decompose. `
      + `Pick a department that files under several bodies — the picker is ordered by how many published packages each one sums. `
      + collapseNote + purNote
    : `Disclosure inside this filing: ${bars.map((b) => `${b.label} ${shareRough(b.value ? b.disclosed / b.value : null)}`).slice(0, 4).join(' · ')}.${truncNote} `
      + collapseNote + purNote;

  return append(h('div', {}), [
    rankedOrValue({
      title: `${orgId} at ${dateLabel(latest)}`,
      sub: `${num(at.length)} published senior post rows across ${num(byUnit.size)} ${byUnit.size === 1 ? 'body' : 'bodies'} inside the file`,
      rows: bars,
      fmt: (n) => num(n),
      note,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Fig 5.5 — the Cabinet Office high-earner lists: two publications, one hole
//
// The only exact-figure accounting of the highest paid that government
// publishes, and the only layer in this study that is not a £5,000 band. It is
// NOT one series: the disclosure threshold moved from £150,000 to £174,000, and
// between the two publications there are two reference dates for which no list
// exists at all. The hole is left as a hole and the break is drawn as a break.
// highearners.json ships names and job functions; they are read for the leak
// check in the pipeline and nothing below ever touches them.
// ---------------------------------------------------------------------------

interface HePoint {
  editionId: string; editionIdx: number; year: number; refDate: string | null;
  listed: number; certain: number; possible: number; payNotPublished: number;
}
interface HeSeries {
  id: string; label?: string; era: string; scope: string; basis: string;
  thresholdGBP: number; note?: string; points: HePoint[];
}
interface HeEdition {
  idx: number; id: string; era: string; year: number; refDate: string | null;
  refConfidence: string; thresholdGBP: number; orgTypeAvailable: boolean;
  rows: number; civilService: number; payPublished: number; payNotPublished: number;
}
interface HeGap { afterEdition: string; beforeEdition: string; missing: string[]; interpolated: boolean; reason: string }
interface HeBreak { at: string; kind: string; from?: number; to?: number; note: string }

function figHighEarners(fig: StudyFigure): HTMLElement {
  const wrap = h('div', {});
  const slot = h('div', {}, [h('div', { class: 'rank-note' }, ['Loading the high-earner lists…'])]);
  wrap.append(slot);
  const token = renderToken;
  loadHighEarners(ds)
    .then((he) => { if (token !== renderToken) return; clear(slot).append(highEarnerBlock(fig, he)); })
    .catch((err) => {
      if (token !== renderToken) return;
      clear(slot).append(h('div', { class: 'rank-note' }, [`The high-earner lists could not be loaded: ${String(err)}`]));
    });
  return wrap;
}

function highEarnerBlock(fig: StudyFigure, he: HighEarners): HTMLElement {
  const allSeries = he.series as unknown as HeSeries[];
  const editions = he.editions as unknown as HeEdition[];
  const gaps = he.gaps as unknown as HeGap[];
  const breaks = he.breaks as unknown as HeBreak[];

  const cs = allSeries.filter((s) => s.scope === 'civil-service');
  const pub150 = cs.find((s) => s.id === 'published-150k-civil-service');
  const pub174 = cs.find((s) => s.id === 'published-174k-civil-service');
  const recomputed = cs.find((s) => s.id === 'recomputed-174k-civil-service');

  const years: number[] = [];
  for (const s of cs) for (const p of s.points) years.push(p.year);
  const gapYears = new Set<number>();
  for (const g of gaps) for (const d of g.missing) gapYears.add(Number(d.slice(0, 4)));
  const lo = Math.min(...years, ...gapYears), hi = Math.max(...years, ...gapYears);
  const labels: string[] = [];
  for (let y = lo; y <= hi; y++) labels.push(String(y));

  const toValues = (s: HeSeries | undefined): (number | null)[] => {
    const out: (number | null)[] = new Array(labels.length).fill(null);
    if (!s) return out;
    for (const p of s.points) {
      const at = labels.indexOf(String(p.year));
      if (at >= 0) out[at] = p.certain;
    }
    return out;
  };

  const drawn: Series[] = [
    { key: 'p150', label: 'As published, £150,000 threshold', color: colorFor(0), values: toValues(pub150) },
    { key: 'p174', label: 'As published, £174,000 threshold', color: colorFor(1), values: toValues(pub174) },
    { key: 'r174', label: 'Recomputed at £174,000 (derived)', color: colorFor(2), values: toValues(recomputed) },
  ];
  const thresholdBreak = breaks.find((b) => b.kind === 'threshold');
  const gap = gaps[0];

  const wrap = h('div', {});

  wrap.append(card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'The high-earner lists are two publications, not one line',
    sub: 'Civil Service entries certainly at or above each publication’s own threshold · source [7]',
    build: (host) => {
      const chart = h('div', {});
      host.append(chart);
      lineChart(chart, {
        labels, series: drawn, yFormat: (n) => num(n), yZero: true, height: 300,
        title: 'Civil Service high earners by publication era',
        desc: `Civil Service entries at or above each publication's threshold, ${labels[0]} to ${labels[labels.length - 1]}, `
          + 'with no value at all for the years in which no list was published. Nothing is drawn across those years.',
      });

      // A line cannot draw a single point, and the £174,000 era has exactly one
      // edition — so the presence strip below carries what the line cannot: one
      // cell per publication per year, empty where no list exists. The two
      // empty columns ARE the hole, and the two rows ARE the threshold break.
      const strip = h('div', {
        class: 'covmatrix',
        role: 'img',
        'aria-label': `Which high-earner list exists in which year, ${labels[0]} to ${labels[labels.length - 1]}. `
          + 'The £150,000 publication runs to 2022 and the £174,000 publication begins in 2025; '
          + 'no list at all was published for 2023 or 2024.',
        style: { gridTemplateColumns: `172px repeat(${labels.length}, minmax(26px, 1fr))`, marginTop: '18px' },
      });
      strip.append(h('div', { class: 'cov-name' }, ['']));
      for (const y of labels) strip.append(h('div', { class: 'cov-head' }, [y.slice(2)]));
      const eras: { label: string; s: HeSeries | undefined; color: string }[] = [
        { label: '£150,000 threshold', s: pub150, color: colorFor(0) },
        { label: '£174,000 threshold', s: pub174, color: colorFor(1) },
      ];
      for (const era of eras) {
        strip.append(h('div', { class: 'cov-name', title: era.label }, [era.label]));
        for (const y of labels) {
          const p = era.s?.points.find((pt) => String(pt.year) === y);
          if (!p) {
            strip.append(h('div', { class: 'cov-cell empty', title: `${era.label} · ${y} — no list published at this threshold` }));
          } else {
            strip.append(h('div', {
              class: 'cov-cell',
              title: `${era.label} · ${y} — ${num(p.listed)} Civil Service entries, ${countRange(p.certain, p.possible)} certainly to possibly at or above the threshold`,
              style: { background: era.color },
            }));
          }
        }
      }
      // A third row carries the count itself, because a line cannot draw a
      // single point and the £174,000 era has exactly one edition: without this
      // the 2025 figure exists on the chart only as a label in the margin.
      strip.append(h('div', { class: 'cov-name' }, ['Certainly above']));
      for (const y of labels) {
        const p = eras.map((e) => e.s?.points.find((pt) => String(pt.year) === y)).find(Boolean);
        strip.append(h('div', {
          class: 'cov-head',
          title: p ? `${y} — ${countRange(p.certain, p.possible)} certainly to possibly at or above that year's threshold` : `${y} — no list published`,
        }, [p ? num(p.certain) : '—']));
      }
      host.style.overflowX = 'auto';
      host.append(strip);
      return null;
    },
    table: seriesTable(labels, drawn, (n) => num(n)),
    legendItems: [
      ...drawn.map((s) => ({ key: s.key, label: s.label, color: s.color })),
      { key: 'none', label: 'No list published that year', color: 'var(--surface-sunken)' },
    ],
    foot: [
      h('div', { class: 'rank-note' }, [
        'The presence strip under the chart is the same data as the line, drawn as existence rather than as level: '
        + 'a filled cell is an edition, an empty cell is a year with no publication.',
      ]),
      h('div', { class: 'rank-note' }, [
        `Cabinet Office high-earner publications [7], ${he.licence ?? 'Open Government Licence'}. `
        + 'The claret line is the only like-for-like comparison available — the earlier editions recounted at the later '
        + '£174,000 cutoff, which the published per-row floor and ceiling make possible. It is derived, not published, and says so.',
      ]),
    ],
  }));

  if (gap) {
    wrap.append(warnBlock('The hole is real and stays open', [
      `${gap.reason} Missing reference dates: ${gap.missing.join(', ')}. Interpolated: ${gap.interpolated ? 'yes' : 'no'}.`,
      ...(thresholdBreak ? [thresholdBreak.note] : []),
    ]));
  }

  // Editions ledger, with the gap years present as rows rather than as silence.
  type Row = { year: number; cells: (string | Node)[]; gap?: boolean };
  const rows: Row[] = editions.map((e) => {
    const point = cs.flatMap((s) => s.points).find((p) => p.editionId === e.id);
    return {
      year: e.year,
      cells: [
        e.refDate ? dateLabel(e.refDate) : `${e.year} (year only)`,
        e.era === '150k' ? '£150,000' : '£174,000',
        e.orgTypeAvailable ? num(e.civilService) : 'not published',
        num(e.rows),
        point ? countRange(point.certain, point.possible) : (e.orgTypeAvailable ? '—' : 'no civil-service split'),
        e.refConfidence === 'declared' ? 'declared' : 'year only',
      ],
    };
  });
  for (const y of [...gapYears].sort((a, b) => a - b)) {
    rows.push({ year: y, gap: true, cells: [`${y} — no list published`, '—', '—', '—', '—', '—'] });
  }
  rows.sort((a, b) => a.year - b.year);

  wrap.append(h('h3', { class: 'fs-subhead' }, ['Every edition, including the ones that do not exist']));
  wrap.append(fsTable(
    [{ label: 'Reference date' }, { label: 'Threshold' }, { label: 'Civil Service rows', num: true },
      { label: 'All rows', num: true }, { label: 'Above threshold (range)', num: true }, { label: 'Date confidence' }],
    rows.map((r) => ({ cells: r.cells, cls: r.gap ? 'estimate' : '' })),
    { maxHeight: '340px' },
  ));
  wrap.append(h('p', { class: 'rank-note' }, [
    'The 2010–2014 editions have no "Type of organisation" column, so no civil-service figure exists for them and none is '
    + 'estimated. "All rows" is not a civil-service count: the 2025 list carries 565 rows of which 157 are Civil Service, '
    + 'the rest being other central government and commercial enterprises in the public sector. Entries are also not all '
    + 'above the threshold — part-time and fee-paid roles appear on both lists at published bands well below it.',
  ]));

  wrap.append(highEarnerRoll(he));
  return wrap;
}

// The named roll. Unlike the organograms, these publications give an exact
// figure rather than a £5,000 band for most rows, so this is the one place in
// the study where an individual's pay is a number rather than a range — which
// is exactly why it is worth showing as itself rather than as a total.
function highEarnerRoll(he: HighEarners): HTMLElement {
  const wrap = h('div', { style: { marginTop: '30px' } });
  const cols = he.rows.cols;
  const col = (n: string) => he.rows.data[n] ?? [];
  const d = (name: string, v: number | null): string | null =>
    (v == null || v < 0 ? null : (he.dict[name]?.[v] ?? null));
  const editions = he.editions as unknown as HeEdition[];

  if (!cols.includes('holder')) return wrap;

  const holder = col('holder'), title = col('title'), org = col('org'), parent = col('parent');
  const grade = col('rawGrade'), floor = col('floor'), ceil = col('ceil');
  const edition = col('edition'), orgType = col('orgType'), payKind = col('payKind');

  interface Entry {
    name: string; title: string; org: string; grade: string;
    lo: number | null; hi: number | null; exact: boolean;
    year: number; civil: boolean;
  }
  const all: Entry[] = [];
  for (let i = 0; i < he.rows.n; i++) {
    const name = d('holder', holder[i]);
    if (!name) continue;                       // the publisher withheld it
    const ed = editions[edition[i] ?? -1];
    all.push({
      name,
      title: d('title', title[i]) ?? '—',
      org: d('org', org[i]) ?? d('parent', parent[i]) ?? '—',
      grade: d('rawGrade', grade[i]) ?? '—',
      lo: floor[i], hi: ceil[i],
      exact: floor[i] != null && floor[i] === ceil[i],
      year: ed?.year ?? 0,
      civil: (he.orgTypes ?? [])[orgType[i] ?? -1] === 'Civil Service',
    });
  }
  all.sort((a, b) => (b.hi ?? b.lo ?? 0) - (a.hi ?? a.lo ?? 0) || a.name.localeCompare(b.name));

  const withheldNames = he.rows.n - all.length;
  wrap.append(h('h3', { class: 'fs-subhead' }, ['The named roll']));
  wrap.append(rich('p', { class: 'fs-body' },
    `${num(all.length)} of ${num(he.rows.n)} rows across both publications name the post-holder; `
    + `${num(withheldNames)} do not, and a blank name here is the publisher declining to give one rather than an empty post. `
    + 'These lists are the only place in this study where pay is frequently an <b>exact figure</b> rather than a '
    + '£5,000 band — where it is, the row says so. Published by the Cabinet Office under the Open Government Licence.'));

  const controls = h('div', { class: 'beat-controls' });
  const search = h('input', {
    class: 'beat-field', type: 'search', placeholder: 'Search a name, job title or organisation…',
    'aria-label': 'Search the named high-earner roll', style: { flex: '1 1 240px' },
  }) as HTMLInputElement;
  const yearSel = h('select', { class: 'beat-field', 'aria-label': 'Edition year' }) as HTMLSelectElement;
  yearSel.append(new Option('All editions', ''));
  for (const y of [...new Set(all.map((e) => e.year))].sort((a, b) => b - a)) yearSel.append(new Option(String(y), String(y)));
  const csOnly = h('input', { type: 'checkbox', id: 'he-cs-only' }) as HTMLInputElement;
  csOnly.checked = false;
  controls.append(search, yearSel, h('label', { class: 'beat-check', for: 'he-cs-only' }, [csOnly, 'Civil Service only']));
  wrap.append(controls);

  const host = h('div', {});
  const foot = h('div', { class: 'rank-note' });
  wrap.append(host, foot);

  const PAGE = 60;
  let page = 0;
  const draw = () => {
    const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const yr = yearSel.value ? Number(yearSel.value) : null;
    const matched = all.filter((e) => {
      if (yr != null && e.year !== yr) return false;
      if (csOnly.checked && !e.civil) return false;
      if (!q.length) return true;
      const hay = `${e.name} ${e.title} ${e.org} ${e.grade}`.toLowerCase();
      return q.every((t) => hay.includes(t));
    });
    const shown = matched.slice(0, (page + 1) * PAGE);
    clear(host).append(fsTable(
      [{ label: 'Post-holder' }, { label: 'Job title' }, { label: 'Organisation' },
        { label: 'Grade' }, { label: 'Edition', num: true }, { label: 'Published pay', num: true }],
      shown.map((e) => ({
        cells: [
          e.name, e.title, e.org, e.grade, String(e.year),
          e.lo == null ? 'not published'
            : e.exact ? gbp(e.lo)
              : `${gbp(e.lo)}–${gbp(e.hi ?? e.lo)}`,
        ],
      })),
      { maxHeight: '560px' },
    ));
    clear(foot).append(h('span', {}, [
      `${num(shown.length)} of ${num(matched.length)} named rows`
      + `${matched.length !== all.length ? ` (filtered from ${num(all.length)})` : ''}. `
      + 'Sorted by the top of the published pay. An exact figure prints as one number; a band prints as two. '
      + 'A person appearing twice held a listed post in two editions — these are annual snapshots, not a career record.',
    ]));
    if (shown.length < matched.length) {
      const more = h('button', { class: 'chip', type: 'button', style: { marginTop: '10px' } }, ['Show more']);
      more.addEventListener('click', () => { page++; draw(); });
      foot.append(more);
    }
  };
  search.addEventListener('input', () => { page = 0; draw(); });
  yearSel.addEventListener('change', () => { page = 0; draw(); });
  csOnly.addEventListener('change', () => { page = 0; draw(); });
  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Fig 6.2 — the deflator, in full, with the years it refuses to deflate
// ---------------------------------------------------------------------------

function figCpih(fig: StudyFigure): HTMLElement {
  const cpih = ds.meta.cpih;
  const years = Object.keys(cpih.index).map(Number).sort((a, b) => a - b);
  const baseYear = years.length ? years[years.length - 1] : null;
  const baseIdx = baseYear != null ? cpih.index[String(baseYear)] : null;
  const corpusYears = new Set<number>();
  for (const d of ds.meta.dates) corpusYears.add(Number(d.slice(0, 4)));
  const nominalOnly = [...corpusYears].filter((y) => cpih.index[String(y)] == null).sort((a, b) => a - b);

  const rows = years.map((y) => ({
    cells: [
      String(y),
      cpih.index[String(y)].toFixed(1),
      baseIdx != null ? `${(baseIdx / cpih.index[String(y)]).toFixed(3)}×` : '—',
      'published',
    ],
  }));
  for (const y of nominalOnly) {
    rows.push({ cells: [String(y), 'no published index', '1.000× — left nominal', 'nominal only'] });
  }
  rows.sort((a, b) => Number(a.cells[0]) - Number(b.cells[0]));

  return card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'The real-terms deflator, in full',
    sub: `ONS CPIH annual index (2015 = 100) · ${cpih.source}${cpih.live ? '' : ' · fallback table in use'} · source [3]`,
    build: (host) => {
      host.append(fsTable(
        [{ label: 'Year' }, { label: 'CPIH index (2015 = 100)', num: true },
          { label: `Deflator to ${baseYear ?? '—'}`, num: true }, { label: 'Basis' }],
        rows,
        { maxHeight: '320px' },
      ));
      return null;
    },
    foot: [
      h('div', { class: 'rank-note' }, [
        nominalOnly.length
          ? `${nominalOnly.join(', ')} ${nominalOnly.length === 1 ? 'has' : 'have'} no published annual CPIH row, so `
            + `${nominalOnly.length === 1 ? 'that year is' : 'those years are'} left NOMINAL even when the real-terms control is on, `
            + 'and every affected series says so in its own notes. Carrying the previous year forward would put a fabricated index behind a real number — '
            + 'the previous pipeline did exactly that, and it is the worst thing this repository has done.'
          : 'Every year in the corpus has a published annual CPIH row.',
      ]),
      ...(cpih.live ? [] : [h('div', { class: 'rank-note' }, [cpih.warning ?? 'The live ONS series could not be read; the built-in table was used.'])]),
      h('div', { class: 'rank-note' }, [
        'Transposed on purpose: one row per year. Seventeen columns of index values is a table nobody can read, and every reader wanted to scan down a year.',
      ]),
    ],
  });
}

// ---------------------------------------------------------------------------
// Fig 6.3 — the outside comparison, and what it is allowed to say
//
// The one place this study touches a number it did not compute. src/benchmarks.ts
// exists so that a comparator cannot leave the module without its provenance,
// its staleness verdict and its comparability flag, and the most useful thing
// in benchmarks.json is the `contested` list: quantities where two respectable
// sources disagree by tens of per cent because they are matching on different
// things. Both readings are printed. Picking one would be the whole error this
// beat is about.
// ---------------------------------------------------------------------------

function figComparators(fig: StudyFigure): HTMLElement {
  const wrap = h('div', {});
  const slot = h('div', {}, [h('div', { class: 'rank-note' }, ['Loading the external comparators…'])]);
  wrap.append(slot);
  const token = renderToken;
  loadBenchmarks(ds.base)
    .then((bm) => { if (token !== renderToken) return; clear(slot).append(comparatorBlock(fig, bm)); })
    .catch((err) => {
      if (token !== renderToken) return;
      clear(slot).append(h('div', { class: 'rank-note' }, [`The comparator layer could not be loaded: ${String(err)}`]));
    });
  return wrap;
}

function comparatorBlock(fig: StudyFigure, bm: Benchmarks): HTMLElement {
  const contested = contestedQuantities(bm);
  const rules = honestyRules(bm);
  const excluded = excludedSources(bm);
  const stale = staleSources(bm);
  const wrap = h('div', {});

  wrap.append(card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'Where the outside comparison is contested',
    sub: 'Two published readings of the same quantity, side by side · sources [4][5]',
    build: (host) => {
      host.append(fsTable(
        [{ label: 'Quantity' }, { label: 'Reading A', num: true }, { label: 'Reading B', num: true },
          { label: 'Spread', num: true }, { label: 'Why they disagree' }],
        contested.map((c) => {
          const a = c.readings[0], b = c.readings[1];
          const cell = (r: typeof a) => (r
            ? append(h('div', {}), [
              h('div', {}, [roundedFigure(r.value)]),
              h('div', { class: 'metric-delta' }, [r.basis]),
            ])
            : '—');
          return {
            cells: [
              append(h('div', {}), [
                h('div', {}, [c.quantity]),
                h('div', { style: { marginTop: '6px' } }, [confidenceChip(c.confidence)]),
              ]),
              cell(a), cell(b), pct(c.spreadPct, 1, false), c.why,
            ],
          };
        }),
      ));
      return null;
    },
    foot: [
      h('div', { class: 'rank-note' }, [
        'Both readings are printed because both are defensible and they are not measuring the same population. Figures are rounded '
        + 'to £1,000: they are external medians, and the arithmetic behind them does not support the pound. '
        + 'Neither can be compared with a figure from this corpus without holding the pension in view.',
      ]),
    ],
  }));

  wrap.append(h('h3', { class: 'fs-subhead' }, ['What a comparator is allowed to say']));
  wrap.append(h('ul', { class: 'fs-body' }, rules.map((r) => h('li', {}, [r]))));

  if (excluded.length) {
    wrap.append(warnBlock('Sources refused, and why', [
      // rich() escapes its argument itself and then re-admits only <b> and the
      // citation marks, so esc() here would escape twice: Adzuna's quoted terms
      // rendered as literal &quot; and the TaxPayers' Alliance as &#39;.
      ...excluded.map((e) => rich('p', { class: 'fs-body', style: { marginTop: '8px' } }, `<b>${e.source}</b> — ${e.reason}`)),
    ]));
  }
  wrap.append(h('div', { class: 'rank-note' }, [
    stale.length
      ? `${num(stale.length)} comparator source${stale.length === 1 ? ' has' : 's have'} not been re-checked inside 14 months and `
        + `${stale.length === 1 ? 'is' : 'are'} flagged stale by the loader: ${stale.map((s) => s.sourceId).join(', ')}.`
      : `Every comparator source has been re-checked inside 14 months. Comparators are built by scripts/benchmarks.mjs and carry `
        + `their own source date, window and last-reviewed stamp; there is no page-level "as at" covering for them.`,
  ]));
  return wrap;
}

/** Says how many pay points the n-floor removed from a chart. Never silent. */
function thinNote(disp: Display, res: SeriesResult): HTMLElement | null {
  if (!disp.thinPoints) return null;
  return h('div', { class: 'rank-note' }, [
    `${num(disp.thinPoints)} point${disp.thinPoints === 1 ? '' : 's'} rest on fewer than ${res.notes.nFloor} published bands and are not drawn — they are in the table twin.`,
  ]);
}

/** The note that says which groups could not be merged into "Other". */
function omittedNote(disp: Display): (Node | string)[] | undefined {
  if (!disp.omitted.length) return undefined;
  return [h('div', { class: 'rank-note' }, [
    `${disp.omitted.length} further group${disp.omitted.length === 1 ? '' : 's'} are in the table but not on the chart, because merging them would mix Tier A with Tier B: ${disp.omitted.join(', ')}.`,
  ])];
}

function disclosureLine(res: SeriesResult, groups: SeriesGroup[]): HTMLElement {
  const li = lastPopulatedIdx(res);
  if (li < 0) return h('div', {});
  const parts = groups.slice(0, 6).map((g) => `${g.label} ${share(g.disclosureRate[li])}`);
  return h('div', { class: 'rank-note' }, [`Disclosure rate at ${res.periods[li]}: ${parts.join(' · ')}.`]);
}

/**
 * The newest period is usually still filling up: at quarter grain a handful of
 * bodies have filed into it and the rest have not, so every count ends on a
 * cliff that is publication rather than government. The series is not truncated
 * — a census does not hide its newest row — but the cliff is named wherever it
 * is drawn.
 */
function openPeriodNote(res: SeriesResult, g?: SeriesGroup): string {
  const li = lastPopulatedIdx(res);
  if (li < 0) return '';
  const end = res.periodEnds[li];
  if (!end || end <= ds.meta.stats.dateRange[1]) return '';
  const filed = g ? (g.orgsFiled[li] ?? 0) : 0;
  const prev = g && li > 0 ? (g.orgsFiled[li - 1] ?? 0) : 0;
  const counts = filed && prev ? ` — ${num(filed)} bodies have filed into it against ${num(prev)} in the period before` : '';
  return `${res.periods[li]} is still open${counts}: read its fall as publication, not headcount.`;
}

/**
 * Filing cadence, named on the axis it distorts.
 *
 * Until 2022 bodies filed twice a year; from 2022 they file quarterly to
 * monthly. At a fine grain that makes the right-hand half of every series
 * denser than the left — more filings behind each point, and more points that
 * are populated at all — and density reads as volatility. The study opens at
 * the year grain for exactly this reason, and wherever a series is drawn the
 * arithmetic is printed rather than left to be inferred from the wiggle.
 */
const CADENCE_YEAR = 2022;

function cadenceFacts(): { before: number; after: number } {
  const byYear = new Map<number, { snaps: number; orgs: Set<string> }>();
  for (const s of ds.meta.snapshots) {
    const y = Number((ds.meta.dates[s.d] ?? '').slice(0, 4));
    if (!Number.isFinite(y)) continue;
    const cur = byYear.get(y) ?? { snaps: 0, orgs: new Set<string>() };
    cur.snaps += 1; cur.orgs.add(s.org);
    byYear.set(y, cur);
  }
  const mean = (pred: (y: number) => boolean) => {
    const vals = [...byYear.entries()].filter(([y]) => pred(y)).map(([, v]) => v.snaps / Math.max(1, v.orgs.size));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  return { before: mean((y) => y < CADENCE_YEAR), after: mean((y) => y >= CADENCE_YEAR) };
}

const GRAIN_LABEL: Record<Grain, string> = {
  date: 'Every filing', quarter: 'Quarter', half: 'Half-year', year: 'Year',
};

function cadenceNote(grain: Grain): string {
  const c = cadenceFacts();
  const per = grain === 'year' ? 1 : grain === 'half' ? 2 : grain === 'quarter' ? 4 : 0;
  const head = `Filing cadence is not constant: a body filed about ${c.before.toFixed(1)} times a year before ${CADENCE_YEAR} `
    + `and about ${c.after.toFixed(1)} times a year since. `;
  if (grain === 'year') {
    return head + `At the year grain that is one drawn point per body per period at both ends of the series, which is why it is the `
      + `baseline: the extra filings since ${CADENCE_YEAR} change how much is known about a year, not how much the year moved.`;
  }
  if (!per) {
    return head + 'At the every-filing grain each point is one filing, so the series is at its densest on the right for reasons that '
      + 'are publication rather than pay. Coarsen the period lever to Year to compare like with like.';
  }
  return head + `At the ${grain} grain a point before ${CADENCE_YEAR} rests on about ${(c.before / per).toFixed(1)} filings per body `
    + `and a point since on about ${(c.after / per).toFixed(1)}, so the right-hand half of every series is denser and spikier for a `
    + 'reason that is publication frequency, not pay volatility. Coarsen the period lever to Year to compare like with like.';
}

/** The same caveat for anything that does not come back as a SeriesResult. */
function openPeriodNoteFor(periods: string[], grain: Grain): string {
  if (!periods.length) return '';
  const pi = periodIndex(ds, grain);
  const p = pi.periods.find((x) => x.key === periods[periods.length - 1] || x.label === periods[periods.length - 1]);
  if (!p || p.end <= ds.meta.stats.dateRange[1]) return '';
  return `${periods[periods.length - 1]} is still open — most bodies have not filed into it yet, so its final point is publication, not a change in the estate.`;
}

function limitsLine(res: SeriesResult, g: SeriesGroup): HTMLElement {
  const li = lastPopulatedIdx(res);
  const n = li >= 0 ? g.n[li] : 0;
  const floor = res.notes.nFloor ?? N_FLOOR;
  const thin = n > 0 && n < floor;

  // The latest n is not the whole story: the early years of this series rest on
  // a handful of filings, and a fan drawn edge to edge does not say so. Count
  // the thin periods and name the last one, so the spiky left-hand end of every
  // one of these charts is accounted for rather than left to be squinted at.
  const thinIdx: number[] = [];
  for (let i = 0; i < g.n.length; i++) {
    const ni = g.n[i] ?? 0;
    if (ni > 0 && ni < floor) thinIdx.push(i);
  }
  const thinNote = thinIdx.length
    ? ` · ${num(thinIdx.length)} of ${num(res.periods.length)} periods rest on fewer than ${floor} — up to ${res.periods[thinIdx[thinIdx.length - 1]]}`
    : '';

  const open = openPeriodNote(res, g);
  return append(h('div', {}), [
    h('div', { class: 'rank-note' }, [
      `n = ${num(n)} at ${li >= 0 ? res.periods[li] : '—'}${thin ? ' — below the floor of 30, so this is a reading rather than a trend' : ''}` +
      `${li >= 0 ? ` · disclosure ${share(g.disclosureRate[li])}` : ''}${thinNote} · ${res.notes.realTerms ? `real terms, ${res.notes.baseYear} £` : 'cash terms'}.`,
    ]),
    open ? h('div', { class: 'rank-note' }, [open]) : null,
    h('div', { class: 'rank-note' }, [cadenceNote(res.notes.grain)]),
  ]);
}

// ---------------------------------------------------------------------------
// T0 — front matter
// ---------------------------------------------------------------------------

function renderFront(main: HTMLElement): HTMLElement {
  const beat = study.beats[0];
  const root = h('div', { class: 'beat fs-page' });

  root.append(h('div', { class: 'fs-frontmatter' }, [
    append(h('div', {}), [
      beatHeader(beat),
      rich('p', { class: 'fs-thesis' }, fill(study.thesis)),
    ]),
    h('aside', { class: 'fs-status' }, [
      h('div', { class: 'fs-margin-label' }, ['Status']),
      h('div', { class: 'metric-val' }, [fill(study.status.headline)]),
      rich('p', { class: 'fs-body', style: { margin: '0', fontSize: 'var(--fs-label)' } }, fill(study.status.detail)),
      h('div', {}, [confidenceChip(study.status.confidence)]),
      h('div', { class: 'metric-label' }, [study.statusStamp]),
    ]),
  ]));

  // Findings ledger — three findings, before beat 01. Never a teaser.
  const ledger = h('div', { class: 'fs-ledger' });
  ledger.append(h('div', { class: 'fs-margin-label', style: { padding: '12px 0 0' } }, ['Findings']));
  study.findings.forEach((f, i) => {
    ledger.append(h('div', { class: 'fs-ledger-row' }, [
      h('span', { class: 'metric-label' }, [`Finding ${String(i + 1).padStart(2, '0')}`]),
      rich('p', { class: 'fs-claim', style: { margin: '0' } }, fill(f.text)),
      confidenceChip(f.confidence),
    ]));
  });
  root.append(ledger);

  root.append(h('div', { class: 'fs-split' }, [
    append(h('div', {}), [
      h('h2', { class: 'fs-subhead', style: { marginTop: '0' } }, ['What this answers']),
      h('ol', { class: 'fs-numlist' }, study.asks.map((a) => h('li', {}, [h('span', {}, [fill(a)])]))),
    ]),
    append(h('div', {}), [
      h('h2', { class: 'fs-subhead', style: { marginTop: '0' } }, ['Contents']),
      append(h('nav', { 'aria-label': 'Beats' }), study.beats.slice(1).map((b) => h('button', {
        class: 'fs-contents-row', type: 'button', onClick: () => go(b.slug),
      }, [
        h('span', { class: 'no' }, [b.no]),
        h('span', { style: { flex: '1' } }, [b.name]),
        h('span', { class: 'mins' }, [`${b.minutes ?? 3} min`]),
      ]))),
    ]),
  ]));

  root.append(h('h2', { class: 'fs-subhead' }, ['Instruments']));
  root.append(append(h('div', { class: 'seg' }), study.instruments.map((ins) => h('button', {
    class: '', type: 'button', onClick: () => go('finding'),
  }, [`${ins.name} →`]))));
  root.append(rich('p', { class: 'fs-body', style: { marginTop: '10px' } }, study.instruments[0]?.limits ?? ''));

  root.append(h('div', { style: { marginTop: '30px' } }, [
    h('button', { class: 'fs-next', type: 'button', style: { border: '0', cursor: 'pointer' }, onClick: () => go(study.beats[1].slug) }, ['Start at beat 01 →']),
  ]));

  root.append(h('h2', { class: 'fs-subhead' }, ['Terms']));
  const gl = h('div', { class: 'cellgrid' });
  for (const g of study.glossary) {
    gl.append(append(h('div', {}), [
      h('div', { class: 'metric-label' }, [g.term]),
      h('p', { class: 'fs-body', style: { margin: '6px 0 0', fontSize: 'var(--fs-label)' } }, [g.plain]),
    ]));
  }
  root.append(gl);
  root.append(h('p', { class: 'fs-disclaimer', style: { textAlign: 'right' } }, [study.disclaimer]));
  main.append(root);
  return root;
}

// ---------------------------------------------------------------------------
// T1 — argument
// ---------------------------------------------------------------------------

function renderArgument(main: HTMLElement, beat: Beat): void {
  const root = h('div', { class: 'beat fs-page' });
  const spread = h('div', { class: 'fs-spread' });
  const body = h('div', {});

  spread.append(marginColumn(beat), body);
  body.append(beatHeader(beat));
  const qc = questionClaim(beat);
  if (qc) body.append(qc);
  body.append(proseBlock(beat));

  const figs = beat.figures ?? [];
  if (figs[0]) body.append(figureFor(figs[0]));
  if (beat.pullQuote) body.append(h('div', { class: 'fs-pull' }, [rich('p', {}, fill(beat.pullQuote))]));
  if (figs[1]) body.append(figureFor(figs[1]));
  if (beat.slug === 'next') body.append(changelogPanel());

  const cited = citedHere(beat);
  if (cited) body.append(cited);
  body.append(closeBlock(beat));
  root.append(spread);
  main.append(root);
}

// ---------------------------------------------------------------------------
// T2 — survey
// ---------------------------------------------------------------------------

function renderSurvey(main: HTMLElement, beat: Beat): void {
  const root = h('div', { class: 'beat fs-page' });
  root.append(beatHeader(beat));
  const qc = questionClaim(beat);
  if (qc) root.append(qc);
  if (beat.standfirst) root.append(rich('p', { class: 'fs-standfirst' }, fill(beat.standfirst)));

  const survey = beat.slug === 'estate' ? estateSurvey() : populationSurvey();

  // Totals band — four cells, .fs-cells.
  const cells = h('div', { class: 'fs-cells', style: { gridTemplateColumns: `repeat(${Math.min(survey.totals.length, 4)}, minmax(0,1fr))`, marginTop: '24px' } });
  for (const t of survey.totals) {
    cells.append(append(h('div', {}), [
      h('div', { class: 'metric-label' }, [t.label]),
      h('div', { class: 'metric-val' + (t.accent ? ' accent' : '') }, [t.value]),
      t.note ? h('div', { class: 'metric-delta' }, [t.note]) : null,
    ]));
  }
  root.append(cells);

  // Primary table with a sigma row that reconciles.
  // Only the columns that hold figures are right-aligned and tabular. A prose
  // column dragged into the numeric class reads as a column of ragged captions.
  const isNum = (i: number) => survey.numCols.includes(i);
  const table = h('table', { class: 'fs-table', style: { marginTop: '26px' } });
  table.innerHTML =
    `<thead><tr>${survey.columns.map((c, i) => `<th scope="col"${isNum(i) ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${survey.rows.map((r) =>
      `<tr${r.pick ? ' class="pick"' : ''}>${r.cells.map((c, i) => `<td${isNum(i) ? ' class="num"' : ''}>${esc(String(c))}</td>`).join('')}</tr>`).join('')}` +
    `<tr class="sigma">${survey.sigma.map((c, i) => `<td${isNum(i) ? ' class="num"' : ''}>${esc(String(c))}</td>`).join('')}</tr></tbody>`;
  root.append(scrollTable(table));
  root.append(h('p', { class: 'rank-note' }, [survey.arithmetic]));

  root.append(h('div', { class: 'fs-provenance' }, [
    h('span', { class: 'label' }, ['Source']),
    rich('p', {}, `${survey.provenance} As at ${survey.asOf}.`),
  ]));

  root.append(proseBlock(beat));
  for (const f of beat.figures ?? []) root.append(figureFor(f));

  root.append(append(h('div', { class: 'fs-warn', style: { marginTop: '26px' } }), [
    h('div', { class: 'label' }, ['What this survey cannot tell you']),
    h('ul', {}, survey.cannotTellYou.map((c) => rich('li', {}, fill(c)))),
  ]));

  const cited = citedHere(beat);
  if (cited) root.append(cited);
  root.append(closeBlock(beat));
  main.append(root);
}

interface BuiltSurvey {
  columns: string[];
  /** indices of the columns that hold figures */
  numCols: number[];
  rows: { cells: (string | number)[]; pick?: boolean }[];
  sigma: (string | number)[];
  totals: { label: string; value: string; note?: string; accent?: boolean }[];
  arithmetic: string;
  provenance: string;
  asOf: string;
  cannotTellYou: string[];
}

/** Beat 02: the estate, accounted for by organisation family. */
function estateSurvey(): BuiltSurvey {
  const byFamily = new Map<string, { tier: string; posts: number; orgs: number; snapshots: number; disclosed: number }>();
  for (const o of ds.meta.orgs) {
    const cov = ds.meta.coverage.find((c) => c.org === o.id);
    const key = `${o.family} · Tier ${o.tier}`;
    const cur = byFamily.get(key) ?? { tier: o.tier, posts: 0, orgs: 0, snapshots: 0, disclosed: 0 };
    cur.orgs += 1;
    cur.posts += cov?.posts ?? 0;
    cur.snapshots += cov?.snapshots ?? 0;
    cur.disclosed += cov?.disclosed ?? 0;
    byFamily.set(key, cur);
  }
  const rows = [...byFamily.entries()].sort((a, b) => b[1].posts - a[1].posts);
  const totalPosts = rows.reduce((a, r) => a + r[1].posts, 0);
  return {
    columns: ['Family', 'Population', 'Bodies', 'Filings', 'Post rows', 'Share'],
    numCols: [2, 3, 4, 5],
    rows: rows.map(([key, v]) => ({
      cells: [
        key.split(' · ')[0],
        v.tier === 'A' ? 'Senior Civil Service' : 'SCS-equivalent (Tier B)',
        num(v.orgs), num(v.snapshots), num(v.posts),
        share(totalPosts ? v.posts / totalPosts : null),
      ],
      pick: v.tier === 'A',
    })),
    sigma: ['Σ all published rows', '', num(ds.meta.orgs.length), num(ds.meta.stats.snapshots), num(totalPosts), '100.0%'],
    totals: [
      { label: 'Organisations', value: facts.orgs, note: `${facts.orgsA} Tier A · ${facts.orgsB} Tier B` },
      { label: 'Filings', value: facts.snapshots, note: `${facts.dates} distinct reference dates` },
      { label: 'Published post rows', value: facts.posts, note: `${facts.headcount} in headcount` },
      { label: 'Pay withheld', value: facts.withheldRate, note: `of posts in headcount · ${facts.disclosureRate} publish a band`, accent: true },
    ],
    arithmetic: `Σ reconciles: the family rows sum to ${num(totalPosts)} published post rows, which is meta.stats.posts (${facts.posts}). Every row is a census count of filed rows, never an estimate.`,
    provenance: `Counted from the published organogram files themselves [1], one row per (organisation, reference date), summed across the sibling packages that make up one body.`,
    asOf: facts.dateTo,
    cannotTellYou: [
      'The salary of the {withheldShare} of posts whose department withheld it. Not recoverable from anywhere. The post, its grade, title, unit and hours are counted and the withholding rate is reported per grade — that withholding, and not the pay level, is this study\'s most important finding.',
      `Any exact salary. The bands are ${gbp(ds.binWidth)} wide throughout. ${ds.meta.source.note.split('.')[0]}.`,
      'Total remuneration. Organograms are base pay only: no bonus, no allowance, no London weighting, no employer pension — and the civil service alpha employer contribution is worth roughly 23.6 to 28 per cent of salary against a typical private defined-contribution scheme\'s 3 to 8 per cent [8].',
      'Anyone below the Senior Civil Service, junior organogram files (a different unit of analysis), local government, NHS trusts or the devolved administrations.',
      'Names. Published lawfully upstream under the Open Government Licence [2], deliberately not republished here: the name column is read to derive a post status and then discarded.',
    ],
  };
}

/** Beat 06: the published population, accounted for by what it says about pay. */
function populationSurvey(): BuiltSurvey {
  const s = ds.meta.stats;
  const fullBand = Math.max(0, s.disclosed - s.openBand);
  const total = fullBand + s.openBand + s.withheld + s.eliminated;
  const rows = [
    { cells: ['Pay published as a full band', 'census', num(fullBand), share(s.posts ? fullBand / s.posts : null), 'both edges published; the only rows any pay figure reads'], pick: true },
    { cells: ['Pay published with one edge only', 'census', num(s.openBand), share(s.posts ? s.openBand / s.posts : null), 'counted in headcount, excluded from every money total'] },
    { cells: ['Pay withheld', 'census', num(s.withheld), share(s.posts ? s.withheld / s.posts : null), 'in headcount, in the grade mix, in no pay statistic'] },
    { cells: ['Post eliminated', 'census', num(s.eliminated), share(s.posts ? s.eliminated / s.posts : null), 'the post no longer exists; outside headcount'] },
  ];
  return {
    columns: ['Row kind', 'Basis', 'Rows', 'Share', 'What it can answer'],
    numCols: [2, 3],
    rows,
    sigma: ['Σ published post rows', '', num(total), '100.0%', ''],
    totals: [
      { label: 'Published post rows', value: facts.posts },
      { label: 'In headcount', value: facts.headcount, note: 'published rows minus eliminated posts' },
      { label: 'With a published band', value: facts.disclosed },
      { label: 'Vacant posts', value: facts.vacant, note: 'in headcount, never in the pay bill', accent: true },
    ],
    arithmetic: `Σ reconciles: ${num(fullBand)} + ${num(s.openBand)} + ${num(s.withheld)} + ${num(s.eliminated)} = ${num(total)}, which is meta.stats.posts (${facts.posts}). Vacant posts are a subset of headcount, not a fifth row, so they are stated above rather than added in.`,
    provenance: 'Every row is a count from the published files [1]. A withheld row carries the reason the publisher\'s own cell gave: blank, zero, "N/A", implausible, or other.',
    asOf: facts.dateTo,
    cannotTellYou: [
      'Whether the withheld posts are paid like the published ones. Nothing in this corpus can settle that, and it is the single assumption every median here rests on.',
      'Whether a body that stopped filing shrank or stopped publishing. A gap in the coverage matrix is a gap in publication, not a fall in headcount.',
      'Whether a professional group is a classification or a template default. A large share of rows read "Policy Profession" because that is what the template says by default.',
      'How this compares with the market without holding pension in view: the alpha employer contribution is worth more than most of the gaps being argued about [5][8].',
    ],
  };
}

// ---------------------------------------------------------------------------
// T3 — position, and the instrument that hangs off it
// ---------------------------------------------------------------------------

function renderPosition(main: HTMLElement, beat: Beat): void {
  const root = h('div', { class: 'beat fs-page' });
  const p = beat.position!;
  root.append(beatHeader(beat));
  // Every beat prints its question, T3 included: the position display is the
  // answer, and an answer with the question missing is a slogan.
  const qc = questionClaim(beat);
  if (qc) root.append(qc);
  root.append(h('p', { style: { margin: '14px 0 0' } }, [
    h('a', { href: '#explore', class: 'fs-prev', onClick: () => { setTimeout(() => document.getElementById('explore')?.scrollIntoView({ block: 'start' }), 0); } }, ['Skip to the instrument ↓']),
  ]));
  // The position statement is a 20ch serif display line and the elaboration is
  // held to a 66ch measure, so laid out in one column they left roughly a third
  // of the page empty for 450px — a dead channel on the beat that carries the
  // study's only argument. The whole block goes into .fs-spread, which is what
  // that channel is for: the numeral and this beat's margin notes fill it, and
  // the measure narrows to something readable at the same time.
  const spread = h('div', { class: 'fs-spread' });
  const body = h('div', {});
  spread.append(marginColumn(beat), body);
  body.append(h('h2', { class: 'fs-position', style: { marginTop: '0' } }, [fill(p.statement)]));
  if (p.elaboration) body.append(rich('p', { class: 'fs-body', style: { marginTop: '18px' } }, fill(p.elaboration)));
  body.append(proseBlock(beat));
  body.append(append(h('div', { class: 'fs-confidence-note' }), [
    confidenceChip(p.confidence ?? beat.claim?.confidence ?? 'hypothesis'), ' ',
    'This is a call, not a measurement. The evidence below is strong on the gap and weak on what filling it would show — which is exactly why the instrument sits underneath it.',
  ]));
  root.append(spread);

  const because = h('div', { class: 'fs-because' });
  for (const b of p.because) {
    because.append(append(h('div', {}), [
      h('div', { class: 'metric-label accent' }, [b.headline]),
      rich('p', { class: 'fs-body', style: { margin: '8px 0 0' } }, fill(b.detail)),
    ]));
  }
  root.append(because);

  root.append(h('h3', { class: 'fs-subhead' }, ['And not the others']));
  for (const r of p.rejected) {
    root.append(h('div', { class: 'fs-rejected' }, [
      h('div', { class: 'fs-claim' }, [r.name]),
      rich('p', { class: 'fs-body', style: { margin: '0' } }, fill(r.why)),
    ]));
  }

  root.append(h('div', { class: 'fs-split', style: { marginTop: '26px' } }, [
    append(h('div', { class: 'fs-panel' }), [
      h('div', { class: 'fs-margin-label' }, ['What it depends on']),
      h('ul', {}, p.conditions.map((c) => rich('li', {}, fill(c)))),
    ]),
    append(h('div', { class: 'fs-warn' }), [
      h('div', { class: 'label' }, ['What would sink it']),
      rich('p', { class: 'fs-body', style: { margin: '8px 0 0' } }, fill(p.sinkers)),
    ]),
  ]));

  if (p.phases?.length) {
    root.append(h('h3', { class: 'fs-subhead' }, ['Sequencing']));
    const grid = h('div', { class: 'cellgrid', style: { gridTemplateColumns: `repeat(${Math.min(p.phases.length, 4)}, minmax(0,1fr))` } });
    for (const ph of p.phases) {
      grid.append(append(h('div', {}), [
        h('div', { class: 'metric-label accent' }, [`Phase ${ph.label}`]),
        h('div', { class: 'fs-claim', style: { marginTop: '6px' } }, [ph.name]),
        h('p', { class: 'fs-body', style: { margin: '6px 0 0', fontSize: 'var(--fs-label)' } }, [ph.detail]),
      ]));
    }
    root.append(grid);
  }

  root.append(h('h3', { class: 'fs-subhead', id: 'explore' }, ['The instrument — test the call against the data']));
  root.append(instrument());

  const cited = citedHere(beat);
  if (cited) root.append(cited);
  root.append(closeBlock(beat));
  main.append(root);
}

// ---------------------------------------------------------------------------
// T4 — ledger
// ---------------------------------------------------------------------------

function renderLedger(main: HTMLElement, beat: Beat): void {
  const root = h('div', { class: 'beat fs-page' });
  const l = beat.ledger!;
  root.append(beatHeader(beat));
  const qc = questionClaim(beat);
  if (qc) root.append(qc);
  root.append(proseBlock(beat));

  // The lens RE-RANKS and never filters: nothing disappears when you change it.
  root.append(append(h('div', { class: 'fs-lens', role: 'group', 'aria-label': 'Lens' }), [
    h('span', { class: 'label' }, ['Lens — re-ranks, never filters:']),
    ...l.lenses.map((name) => h('button', {
      class: 'chip' + (lens === name ? ' on' : ''), type: 'button', 'aria-pressed': String(lens === name),
      onClick: () => { lens = name; render(); },
    }, [name])),
  ]));

  const rank = (items: Claim[]): Claim[] => {
    const key = lens.toLowerCase().replace(/^by /, '').split(' ')[0];
    return [...items].sort((a, b) => Number(b.text.toLowerCase().includes(key)) - Number(a.text.toLowerCase().includes(key)));
  };
  const column = (cls: string, title: string, items: Claim[]) => {
    const col = h('div', { class: cls });
    col.append(h('div', { class: 'metric-label' }, [title]));
    rank(items).forEach((c, i) => col.append(h('div', { class: 'fs-ledger-item' }, [
      h('span', { class: 'no' }, [String(i + 1).padStart(2, '0')]),
      append(h('div', {}), [rich('p', { class: 'fs-body', style: { margin: '0' } }, fill(c.text)), h('div', { style: { marginTop: '8px' } }, [confidenceChip(c.confidence)])]),
    ])));
    return col;
  };

  root.append(h('div', { class: 'fs-ledger-cols' }, [
    column('fs-col-benefit', `Gains (${l.benefits.length})`, l.benefits),
    column('fs-col-risk', `Risks (${l.risks.length})`, l.risks),
  ]));
  root.append(rich('p', { class: 'fs-balance' }, fill(l.balance)));

  if (l.byActor?.length) {
    const table = h('table', { class: 'fs-table', style: { marginTop: '24px' } });
    const ranked = [...l.byActor].sort((a, b) => Number(b.actor === lens) - Number(a.actor === lens));
    table.innerHTML =
      '<thead><tr><th scope="col">Actor</th><th scope="col" class="num">Gains</th><th scope="col" class="num">Loses</th><th scope="col">Net</th><th scope="col">In their own words</th></tr></thead>' +
      `<tbody>${ranked.map((a) =>
        `<tr${a.actor === lens ? ' class="pick"' : ''}><td>${esc(a.actor)}</td><td class="num">${a.gains}</td><td class="num">${a.loses}</td><td>${esc(a.net)}</td><td>${esc(a.quote ?? '')}</td></tr>`).join('')}</tbody>`;
    root.append(scrollTable(table));
  }

  for (const f of beat.figures ?? []) root.append(figureFor(f));
  // The ledger beat is where a reader asks "which post, though?", so the
  // post-level record hangs off the bottom of it rather than off a tab of its
  // own. It is opt-in: the shards are not first paint.
  if (beat.slug === 'who-wins') { root.append(orgStructureBlock()); root.append(postLedger()); }
  const cited = citedHere(beat);
  if (cited) root.append(cited);
  root.append(closeBlock(beat));
  main.append(root);
}

// ---------------------------------------------------------------------------
// T5 — the instrument
//
// DOM order is deliberate: command bar, readout, stage, limits, levers. On a
// wide screen everything but the stage is absolutely positioned so the order
// does not matter; below 1000px they all become flow, and that order is
// exactly the one a phone needs — state, then the numbers, then the chart,
// then what it does not show, then ONE collapsed Filters disclosure.
// ---------------------------------------------------------------------------

const basisLabel = (b: Basis): string =>
  b === 'reweighted' ? 'Grade-reweighted' : b === 'constant-scope' ? 'Constant scope' : 'As published';

const dimensionLabel = (d: Dimension): string => (({
  none: 'Total', department: 'Organisation', organisation: 'Organisation', profession: 'Profession',
  grade: 'Grade', ddatPolicy: 'DDaT vs Policy', family: 'Family', tier: 'Tier',
} as Record<string, string>)[d] ?? d);

function instrument(): HTMLElement {
  const ins = study.instruments[0];
  const filter = toFilter();
  const measure = state.measure;
  const banded = isBandedMeasure(measure);
  const fmt = measureFormat(measure);
  const res = sliceResult(series(ds, filter, measure, state.dimension), filter.periodRange);
  const disp = buildDisplay(res, filter, state.dimension, measure);
  const li = lastPopulatedIdx(res);

  const root = h('section', { class: 'fs-instrument', 'aria-label': ins.name });

  // ---- command bar
  root.append(h('div', { class: 'fs-cmdbar' }, [
    h('button', { class: 'fs-prev', type: 'button', style: { background: 'none', border: '0', cursor: 'pointer' }, onClick: () => window.scrollTo({ top: 0 }) }, ['← beat 04']),
    h('span', { class: 'fs-kicker' }, [ins.name]),
    h('span', { class: 'fs-live' }, [h('span', { class: 'dot' }), `${measureLabel(measure)} · by ${dimensionLabel(state.dimension).toLowerCase()} · ${state.realTerms ? `${facts.yearTo} £` : 'cash'} · ${basisLabel(state.basis).toLowerCase()}`]),
    h('span', { class: 'spacer' }),
    fullscreenButton(root),
    h('button', { class: 'share-btn', type: 'button', onClick: copyLink }, ['Share this state']),
  ]));

  // ---- readout HUD — three figures, never four
  root.append(readoutHud(res, disp, banded, fmt));

  // ---- stage
  const stage = h('div', { class: 'fs-stage' });
  const host = h('div', { class: 'chart-host' });
  stage.append(host);
  // The stage is a fixed-height surface inside `overflow: hidden`, so every
  // pixel of furniture under the chart has to come out of the chart's own
  // height or it pushes the Table button off the bottom and clips itself. The
  // opening height is a guess proportional to the window; it is CORRECTED by
  // measurement once the layout has landed, below, because the furniture's
  // real height depends on how many legend rows the labels wrap to and that
  // cannot be known in advance.
  let height = isNarrow() ? 300 : Math.max(260, Math.min(520, Math.round(window.innerHeight * 0.52)));
  const nAtLatest = li >= 0 ? disp.all.reduce((a, g) => a + (g.n[li] ?? 0), 0) : 0;

  const drawStage = (chartHeight: number) => {
    // An empty result is a finding, not a blank chart. Constant scope is the
    // usual cause: over the full range NO organisation filed in every period,
    // so the strict basis correctly returns nothing and says why.
    if (li < 0) {
      clear(host).append(append(h('div', { class: 'fs-warn' }), [
        h('div', { class: 'label' }, ['Nothing to draw under these levers']),
        h('p', { class: 'metric-label muted', style: { marginTop: '10px', textTransform: 'none', letterSpacing: '0' } }, [
          res.notes.caveats[0]
          ?? 'No organisation in scope filed anything in the selected periods.',
        ]),
        h('p', { class: 'metric-label muted', style: { marginTop: '10px', textTransform: 'none', letterSpacing: '0' } }, [
          state.basis === 'constant-scope'
            ? 'Constant scope is strict on purpose: it keeps only the bodies that filed in EVERY period, and no body has filed in every quarter since 2010. Coarsen the period to a year, narrow the scope to one or two bodies, or go back to “as published”.'
            : 'Widen the scope, or clear a filter.',
        ]),
      ]));
      return;
    }
    if (banded && state.dimension === 'none' && disp.all[0]) {
      const g = disp.all[0];
      fanChart(host, {
        labels: res.periods, lo: g.lo, mid: new Array(res.periods.length).fill(null), hi: g.hi,
        color: colorFor(0), yFormat: fmt, height: chartHeight,
        title: `${measureLabel(measure)} over time, as bounds`,
        desc: 'The channel is the whole of what the published bands support.',
      });
    } else {
      lineChart(host, {
        labels: res.periods,
        series: disp.drawn,
        yFormat: fmt,
        yZero: !banded,
        height: chartHeight,
        hiddenKeys: hiddenSeries,
        sampleSize: nAtLatest,
        nFloor: res.notes.nFloor,
        title: `${measureLabel(measure)} by ${dimensionLabel(state.dimension).toLowerCase()}`,
        desc: banded
          ? 'Each line is the lower bound of that group\'s band; the table twin carries both edges.'
          : `${disp.drawn.map((s) => s.label).join(', ')}.`,
      });
    }
  };
  drawStage(height);
  stage.append(h('div', { class: 'rank-note' }, [
    (banded && state.dimension !== 'none'
      ? 'Lines are the LOWER bound of each band. Switch to Table for both edges.'
      : `${measureLabel(measure)} · ${measureUnit(measure)}`)
    + (disp.thinPoints
      ? ` ${num(disp.thinPoints)} point${disp.thinPoints === 1 ? '' : 's'} rest on fewer than ${res.notes.nFloor} published bands and are not drawn — they are in the table.`
      : ''),
  ]));
  const twin = banded ? bandTable(res, disp.all, fmt) : pointTable(res, disp.all, fmt);
  const tableSlot = h('div', { class: 'hidden' }, [twin]);
  stage.append(tableSlot);
  stage.append(legend(disp.drawn.map((s) => ({ key: s.key, label: s.label, color: s.color })), {
    hidden: hiddenSeries,
    onToggle: (key, off) => { if (off) hiddenSeries.add(key); else hiddenSeries.delete(key); render(); },
  }));
  if (disp.omitted.length) {
    stage.append(h('div', { class: 'rank-note' }, [`Not drawn, and in the table: ${disp.omitted.join(', ')}.`]));
  }
  const rank = rankControl(disp);
  if (rank) stage.append(rank);
  stage.append(h('button', {
    class: 'chip', type: 'button', style: { marginTop: '8px', alignSelf: 'flex-start' },
    onClick: (e: Event) => {
      const showTable = tableSlot.classList.contains('hidden');
      tableSlot.classList.toggle('hidden', !showTable);
      host.classList.toggle('hidden', showTable);
      (e.currentTarget as HTMLElement).textContent = showTable ? 'Chart' : 'Table';
    },
  }, ['Table']));
  root.append(stage);

  // ---- limits strip — always visible, never a tooltip
  const lim = limitsStrip(res, disp, li, ins.limits);
  root.append(lim.strip);

  // ---- lever HUD — five levers, each showing its baseline
  root.append(leverHud());

  // ---- fit the chart to the stage it actually got
  //
  // One shot, after the first layout. The stage's furniture — the bound note,
  // the legend (one row or two, depending on how the labels wrap), the rank
  // control when the cap bites, the Table button — cannot be measured before it
  // is laid out, and the instrument clips whatever does not fit. Guessing the
  // chart height at a fraction of the window left the Table button cut off at
  // every common laptop height. Measure the overflow and give it back to the
  // chart instead. Guarded by the render token, floored so the chart can never
  // be squeezed to nothing, and never re-entrant: one correction, not a loop.
  if (typeof requestAnimationFrame === 'function' && !isNarrow()) {
    const token = renderToken;
    let passes = 0;
    const fit = () => {
      if (token !== renderToken || !stage.isConnected) return;
      // `.fs-stage` centres its column, so an overflowing stage spills BOTH
      // ways and scrollHeight only sees the half below the fold. The real
      // excess is twice what it reports.
      const over = stage.scrollHeight - stage.clientHeight;
      if (over <= 2 || passes >= 6) return;
      // A short window is a real constraint: the honest answer there is a smaller
      // chart, never a Table button hidden below the fold.
      const fitted = Math.max(160, height - over * 2 - 4);
      if (fitted >= height) return;
      passes += 1;
      height = fitted;
      drawStage(height);
    };
    // Measured, not scheduled. Taking the measurement once at the next frame
    // read the FALLBACK font and a chart that charts.ts had not yet re-rendered
    // at its observed width, so it saw no overflow and the Table button stayed
    // cut off. The observer sees every one of those settling steps; `fit` only
    // ever shrinks, and only while there is an overflow, so it converges and
    // the pass cap stops it dead if it ever does not.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        if (token !== renderToken || !stage.isConnected) { ro.disconnect(); return; }
        fit();
      });
      ro.observe(host);
      ro.observe(stage);
    } else {
      requestAnimationFrame(fit);
    }
  }

  return append(h('div', { class: 'fs-instrument-wrap' }), [root, lim.notes]);
}

// Expand the instrument to the whole viewport. The in-page instrument is
// clamped to the viewport minus the two sticky bars so the transport never
// hides behind the tab strip, which leaves the lever rail about 320px short of
// its own content at the commonest desktop heights. Full screen gives the rail
// the height it needs; the class does the rest in CSS.
//
// Uses the Fullscreen API where it exists and falls back to a fixed-position
// class, because the API is refused outside a user gesture in some browsers and
// the fallback is indistinguishable to the reader.
function fullscreenButton(root: HTMLElement): HTMLElement {
  const btn = h('button', {
    class: 'share-btn fs-expand',
    type: 'button',
    'aria-pressed': 'false',
    title: 'Expand the instrument to fill the screen (F, or Escape to leave)',
  }, ['Full screen']) as HTMLButtonElement;

  const isOpen = () => document.fullscreenElement === root || root.classList.contains('is-fullscreen');

  const paint = () => {
    const open = isOpen();
    btn.textContent = open ? 'Exit full screen' : 'Full screen';
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    // The charts are sized by a ResizeObserver on the SVG, so entering and
    // leaving full screen redraws them without any explicit call. Firing a
    // resize keeps browsers that batch the transition in step.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };

  const enter = async () => {
    root.classList.add('is-fullscreen');
    document.body.classList.add('has-fullscreen-instrument');
    try { if (root.requestFullscreen) await root.requestFullscreen(); } catch { /* class fallback stands */ }
    paint();
  };
  const leave = async () => {
    root.classList.remove('is-fullscreen');
    document.body.classList.remove('has-fullscreen-instrument');
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* already out */ }
    paint();
  };

  btn.addEventListener('click', () => { isOpen() ? leave() : enter(); });
  // Escape leaves the CSS fallback too — the browser only handles it for the
  // real Fullscreen API, and a reader who cannot get out is trapped.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('is-fullscreen')) leave();
    else if (e.key === 'f' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName || '')) {
      if (root.isConnected) { isOpen() ? leave() : enter(); }
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) root.classList.remove('is-fullscreen');
    document.body.classList.toggle('has-fullscreen-instrument', root.classList.contains('is-fullscreen'));
    paint();
  });
  return btn;
}

function readoutHud(res: SeriesResult, disp: Display, banded: boolean, fmt: (n: number | null) => string): HTMLElement {
  const total = disp.all.length === 1 ? disp.all[0] : null;
  // The headline figure is the whole selection, not the largest group.
  const totalFilter = toFilter();
  const totalRes = state.dimension === 'none' ? res
    : sliceResult(series(ds, totalFilter, state.measure, 'none'), totalFilter.periodRange);
  const g = totalRes.groups[0];
  const tli = lastPopulatedIdx(totalRes), tfi = firstPopulatedIdx(totalRes);

  const headline = g
    ? banded ? band(g.lo[tli], g.hi[tli], fmt) : fmt(g.values[tli] ?? null)
    : '—';
  const change = g
    ? banded
      ? pctBand(pctChange(g.lo[tfi], g.lo[tli]), pctChange(g.hi[tfi], g.hi[tli]))
      : pct(pctChange(g.values[tfi] ?? null, g.values[tli] ?? null))
    : '—';
  const changeDir = g && !banded ? pctChange(g.values[tfi] ?? null, g.values[tli] ?? null) : g ? pctChange(g.lo[tfi], g.lo[tli]) : null;

  // A pay bill that "grew 1,586%" grew because one body filed in 2010 and
  // eleven file now. The percentage is arithmetically right and materially
  // meaningless, so the tile never prints it without the membership beside it;
  // the constant-scope basis is the lever that actually removes the effect.
  const filedFrom = g && tfi >= 0 ? (g.orgsFiled[tfi] ?? 0) : 0;
  const filedTo = g && tli >= 0 ? (g.orgsFiled[tli] ?? 0) : 0;
  const changeNote = filedFrom > 0 && filedTo > 0 && filedFrom !== filedTo
    ? `${num(filedFrom)} → ${num(filedTo)} bodies filing: membership moved, not only pay`
    : null;

  // The third tile never repeats the first. It carries the accent, because the
  // disclosure rate is the argument this whole study makes.
  const thirdIsDisclosure = state.measure !== 'disclosureRate';
  const thirdLabel = thirdIsDisclosure ? 'Disclosure rate (latest)' : 'Senior posts (latest)';
  const thirdValue = thirdIsDisclosure
    ? share(g ? g.disclosureRate[tli] : null)
    : num(g ? g.headcount[tli] : null);

  const hud = h('div', { class: 'fs-hud fs-hud--readout' }, [
    h('div', { class: 'fs-hud-head' }, [h('span', {}, ['Readout']), h('span', {}, [tli >= 0 ? totalRes.periods[tli] : '—'])]),
  ]);
  const cells = h('div', { class: 'cellgrid fs-readout' });
  const tile = (label: string, value: string, extra?: { delta?: number | null; accent?: boolean; note?: string | null }) => append(h('div', {}), [
    h('div', { class: 'metric-label' }, [label]),
    h('div', { class: 'metric-val' + (extra?.accent ? ' accent' : '') }, [value]),
    extra?.delta != null ? h('div', { class: 'metric-delta ' + (extra.delta >= 0 ? 'up' : 'down') }, [extra.delta >= 0 ? 'rising' : 'falling']) : null,
    extra?.note ? h('div', { class: 'fs-baseline' }, [extra.note]) : null,
  ]);
  cells.append(
    tile(`${measureLabel(state.measure)} (latest)`, headline),
    tile(`Change since ${tfi >= 0 ? totalRes.periods[tfi] : '—'}`, change, { delta: changeDir, note: changeNote }),
    tile(thirdLabel, thirdValue, { accent: true }),
  );
  hud.append(cells);
  if (total && banded) hud.append(h('div', { class: 'fs-baseline', style: { padding: '0 12px 10px' } }, ['bounds, not a salary']));
  return hud;
}

function limitsStrip(res: SeriesResult, disp: Display, li: number, limits: string): { strip: HTMLElement; notes: HTMLElement } {
  const notes = res.notes;
  const n = li >= 0 ? disp.all.reduce((a, g) => a + (g.n[li] ?? 0), 0) : 0;
  const hc = li >= 0 ? disp.all.reduce((a, g) => a + (g.headcount[li] ?? 0), 0) : 0;
  const thin = n > 0 && n < notes.nFloor;

  // Disclosure is the share of the published population that published a band,
  // and it must not be read off `n`: for a point measure n IS the headcount,
  // which would print a confident 100% over a population two thirds of which
  // withheld its pay.
  const disclosed = li >= 0
    ? disp.all.reduce((a, g) => a + (g.disclosureRate[li] ?? 0) * (g.headcount[li] ?? 0), 0)
    : 0;
  const trueDisclosure = hc > 0 ? disclosed / hc : null;

  const strip = h('div', { class: 'fs-transport fs-limits', role: 'note', 'aria-label': 'Limits' });
  strip.append(h('div', { class: 'row' }, [
    h('span', {}, [h('b', {}, [`n = ${num(n)}`]), ` ${notes.banded ? 'posts with a published band' : 'posts'} under this filter${thin ? ' — below the floor of 30' : ''}`]),
    // NOT "± £2,500". A tolerance about a midpoint is precisely the invented
    // figure beat 03 refuses: there is no midpoint in this data, only edges.
    notes.banded ? h('span', {}, [`${gbp(ds.binWidth)} band, floor and ceiling — no midpoint`]) : h('span', {}, ['counts, not pay: no band uncertainty']),
    h('span', {}, [`disclosure ${share(trueDisclosure)}`]),
    h('span', {}, [notes.realTerms ? `real terms, ${notes.baseYear} £` : 'cash terms']),
    h('span', {}, [`${notes.tier === 'AB' ? 'Tier A + B' : 'Tier A'} · ${notes.scsOnly ? 'SCS grades only' : 'all published grades'}`]),
    h('span', {}, [`source: gov.uk organograms [1] · as at ${facts.dateTo} · built ${facts.generated}`]),
  ]));

  const extra: string[] = [];
  const openNote = openPeriodNote(res, disp.all.length === 1 ? disp.all[0] : undefined);
  if (openNote) extra.push(openNote);
  if (notes.reweighted) {
    const cov = notes.reweightCoverage[li];
    extra.push(`Grade-reweighted: the disclosed distribution projected onto the published grade mix, covering ${share(cov)} of published headcount at this period.`);
  }
  if (notes.constantScope) {
    if (state.basis === 'constant-scope' && res.periods.length) {
      extra.push(
        `Constant scope narrows the range to ${res.periods[0]}–${res.periods[res.periods.length - 1]}: the window that keeps the most bodies filing in every single period at this grain. Outside it no body files without a gap, so a total either changes composition or does not exist.`,
      );
    }
  }
  if (notes.tierSplit) extra.push('Tier B is grouped separately and never summed into an SCS figure.');
  if (notes.lineageDrops.length) extra.push(`${notes.lineageDrops.length} predecessor/successor overlaps were refused rather than double-counted.`);
  if (notes.nominalYears.length) extra.push(`No published CPIH for ${notes.nominalYears.join(', ')}, so ${notes.nominalYears.length === 1 ? 'that year is' : 'those years are'} left nominal rather than deflated against a fabricated index.`);
  if (notes.droppedSnapshots) extra.push(`${num(notes.droppedSnapshots)} filings sit behind the chosen one for their period at this grain; coarsen or refine the period lever to reach them.`);
  if (notes.cpihWarning) extra.push(notes.cpihWarning);
  const rn = rankNote(disp);
  if (rn) extra.push(rn);
  extra.push(cadenceNote(notes.grain));
  extra.push(...notes.caveats);

  // The prose does NOT live inside the strip. The strip is absolutely
  // positioned at a fixed 84px inside a fixed-height instrument, so every
  // caveat longer than two lines was ending mid-sentence behind an invisible
  // internal scroll — on the one surface whose whole point is that you cannot
  // avoid seeing the caveat. It goes in normal flow underneath instead, where
  // nothing can clip it.
  const notesBlock = h('div', { class: 'fs-instrument-notes' });
  notesBlock.append(h('div', { class: 'fs-margin-label' }, ['What this instrument does not show']));
  notesBlock.append(rich('p', { class: 'fs-body' }, limits));
  if (extra.length) notesBlock.append(h('p', { class: 'fs-body' }, [extra.join(' ')]));

  return { strip, notes: notesBlock };
}

function leverHud(): HTMLElement {
  const ins = study.instruments[0];
  const hud = h('div', { class: 'fs-hud fs-hud--levers' });
  const body = h('div', { class: 'fs-hud-body' });
  hud.append(h('div', { class: 'fs-hud-head' }, [
    h('span', {}, [`Levers · ${ins.levers?.length ?? 0}`]),
    h('button', {
      class: 'fs-hud-toggle', type: 'button', 'aria-expanded': String(leversOpen),
      onClick: () => { leversOpen = !leversOpen; render(); },
    }, [leversOpen ? 'hide' : 'filters']),
  ]));
  if (!leversOpen) return hud;
  hud.append(body);

  const lever = (id: string, label: string, current: string, control: HTMLElement) => {
    const spec = ins.levers?.find((l) => l.id === id);
    const moved = spec ? spec.baseline !== current : false;
    return append(h('div', {}), [
      h('div', { class: 'fs-lever-head' }, [
        h('span', { class: 'metric-label' }, [label]),
        moved ? h('span', { class: 'metric-label accent' }, ['moved']) : h('span', {}),
      ]),
      control,
      h('div', { class: 'fs-baseline' + (moved ? ' moved' : '') }, [`baseline · ${spec?.baseline ?? current}`]),
    ]);
  };

  const seg = <T extends string>(opts: [T, string][], active: T, on: (v: T) => void) =>
    h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', {
      class: active === v ? 'on' : '', type: 'button', 'aria-pressed': String(active === v), onClick: () => on(v),
    }, [l])));

  const MEASURES: [Measure, string][] = [
    ['medianPay', 'Median'], ['p75', 'Upper quartile'], ['p25', 'Lower quartile'],
    ['paybill', 'Pay bill'], ['headcount', 'Posts'], ['disclosureRate', 'Disclosure'],
  ];
  const DIMENSIONS: [Dimension, string][] = [
    ['department', 'Organisation'], ['profession', 'Profession'], ['grade', 'Grade'],
    ['ddatPolicy', 'DDaT vs Policy'], ['family', 'Family'], ['none', 'Total'],
  ];
  const BASES: [Basis, string][] = [['raw', 'As published'], ['reweighted', 'Grade-reweighted'], ['constant-scope', 'Constant scope']];

  body.append(lever('measure', 'Measure', measureLabel(state.measure), seg(MEASURES, state.measure, (m) => update({ measure: m }))));
  body.append(lever('dimension', 'Break down by', dimensionLabel(state.dimension), seg(DIMENSIONS, state.dimension, (d) => update({ dimension: d }))));
  body.append(lever('basis', 'Basis', basisLabel(state.basis), seg(BASES, state.basis, (b) => update({ basis: b }))));
  body.append(lever('realTerms', 'Money', state.realTerms ? `Real terms (${facts.yearTo} £)` : 'Nominal (cash)',
    seg<'cash' | 'real'>([['cash', 'Cash'], ['real', `Today's £`]], state.realTerms ? 'real' : 'cash', (v) => update({ realTerms: v === 'real' }))));

  // Lever 5 — scope. One lever, three lists and the period grain, so the cap of
  // five levers holds. The grain is part of this lever's "moved" state because
  // it is part of what the reader chose, and the baseline says so.
  const scopeCount = state.depts.length + state.profs.length + state.grades.length;
  const scopeCurrent = `${scopeCount ? `${scopeCount} selected` : 'All Tier A bodies'} · ${GRAIN_LABEL[state.grain]}`;
  const scope = h('div', {});
  scope.append(h('div', { class: 'seg' }, ([
    ['orgs', `Bodies${state.depts.length ? ` · ${state.depts.length}` : ''}`],
    ['profs', `Professions${state.profs.length ? ` · ${state.profs.length}` : ''}`],
    ['grades', `Grades${state.grades.length ? ` · ${state.grades.length}` : ''}`],
  ] as [typeof scopePanel, string][]).map(([id, label]) => h('button', {
    class: scopePanel === id ? 'on' : '', type: 'button', 'aria-expanded': String(scopePanel === id),
    onClick: () => { scopePanel = scopePanel === id ? null : id; render(); },
  }, [label]))));

  if (scopePanel === 'orgs') {
    scope.append(chipList(
      ds.meta.orgs.map((o, i) => ({ i, label: o.id, title: `${o.name} (Tier ${o.tier})` })),
      state.depts, (i) => update({ depts: toggleIn(state.depts, i) }), () => update({ depts: [] }), true,
    ));
  } else if (scopePanel === 'profs') {
    scope.append(chipList(
      ds.meta.profs.map((p, i) => ({ i, label: p, title: p })),
      state.profs, (i) => update({ profs: toggleIn(state.profs, i) }), () => update({ profs: [] }),
    ));
  } else if (scopePanel === 'grades') {
    scope.append(chipList(
      ds.meta.grades.map((g, i) => ({ i, label: g, title: g })),
      state.grades, (i) => update({ grades: toggleIn(state.grades, i) }), () => update({ grades: [] }),
    ));
  }

  scope.append(h('div', { class: 'seg', style: { marginTop: '8px' } }, [
    h('button', { class: state.tierB ? 'on' : '', type: 'button', 'aria-pressed': String(state.tierB), onClick: () => update({ tierB: !state.tierB }) }, ['Tier B']),
    h('button', { class: state.ddat === 1 ? 'on' : '', type: 'button', 'aria-pressed': String(state.ddat === 1), onClick: () => update({ ddat: state.ddat === 1 ? 0 : 1, policy: 0 }) }, ['DDaT']),
    h('button', { class: state.policy === 1 ? 'on' : '', type: 'button', 'aria-pressed': String(state.policy === 1), onClick: () => update({ policy: state.policy === 1 ? 0 : 1, ddat: 0 }) }, ['Policy']),
  ]));
  const GRAINS: [Grain, string][] = [
    ['date', GRAIN_LABEL.date], ['quarter', GRAIN_LABEL.quarter], ['half', GRAIN_LABEL.half], ['year', GRAIN_LABEL.year],
  ];
  scope.append(h('div', { class: 'seg', style: { marginTop: '6px' } },
    GRAINS.map(([g, label]) => h('button', {
      class: state.grain === g ? 'on' : '', type: 'button', 'aria-pressed': String(state.grain === g), onClick: () => update({ grain: g }),
    }, [label]))));

  body.append(lever('scope', 'Scope', scopeCurrent, scope));

  // Say so when levers remain below the fold. A scrollbar alone is not an
  // affordance: two of five levers used to sit under one, unnoticed.
  const markOverflow = () => {
    if (!body.isConnected) return;
    hud.dataset.overflowing = body.scrollHeight > body.clientHeight + 2 ? '1' : '0';
  };
  requestAnimationFrame(markOverflow);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (body.isConnected) markOverflow(); else ro.disconnect(); });
    ro.observe(body);
  }
  body.addEventListener('scroll', () => {
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
    hud.dataset.overflowing = atEnd ? '0' : '1';
  });
  return hud;
}

function chipList(
  items: { i: number; label: string; title: string }[],
  selected: number[], onToggle: (i: number) => void, onClear: () => void, compact = false,
): HTMLElement {
  return append(h('div', { style: { marginTop: '8px' } }), [
    selected.length ? h('button', { class: 'mini-link', type: 'button', onClick: onClear }, [`clear ${selected.length}`]) : null,
    h('div', { class: 'chip-list' }, items.map((it) => h('button', {
      class: 'chip' + (compact ? ' dept-chip' : '') + (selected.includes(it.i) ? ' on' : ''),
      type: 'button', title: it.title, 'aria-pressed': String(selected.includes(it.i)),
      onClick: () => onToggle(it.i),
    }, [it.label]))),
  ]);
}

// ---------------------------------------------------------------------------
// The post ledger — one row per post, not one row per snapshot
//
// The retired notable.json rendered one row per snapshot per post, so the
// Cabinet Secretary appeared about twenty times and read as twenty people.
// Everything here groups to a post identity first — (organisation, Post Unique
// Reference, job title), falling back to (organisation, title, unit) where the
// publisher gave no usable reference — so a post appears once, with a pay
// trajectory. It is behind a button because the shards are ~15 MB in total and
// none of it is first paint.
// ---------------------------------------------------------------------------

const LEDGER_PAGE = 40;

function postLedger(): HTMLElement {
  const wrap = h('div', { style: { marginTop: '34px' } });
  wrap.append(h('h3', { class: 'fs-subhead' }, ['The post ledger']));
  wrap.append(rich('p', { class: 'fs-body' },
    'One row per post, not one row per filing. Where no usable Post Unique Reference was published the identity falls '
    + 'back to organisation, title and unit and the row says so, because merging two posts that merely share a job title '
    + 'would invent a career. Ranking is on the published pay <b>floor</b> — "certainly at least this much" — so posts '
    + 'sharing a band are genuinely tied rather than ordered by an invented midpoint.'));

  const selected = state.depts.length
    ? state.depts.map((i) => ds.meta.orgs[i]).filter(Boolean).map((o) => o.id)
    : ds.meta.orgs.filter((o) => o.tier === 'A').map((o) => o.id);
  const rowsExpected = ds.meta.coverage
    .filter((c) => selected.includes(c.org))
    .reduce((a, c) => a + c.posts, 0);

  const controls = h('div', { class: 'beat-controls' });
  const status = h('div', { class: 'beat-status' });
  const body = h('div', {});
  wrap.append(controls, status, body);

  const loadBtn = h('button', { class: 'chip', type: 'button' }, [
    `Load post records — ${selected.length} organisation${selected.length === 1 ? '' : 's'}, about ${num(rowsExpected)} rows`,
  ]);
  controls.append(loadBtn);
  status.append(h('span', {}, [
    state.depts.length
      ? 'The ledger covers the organisations selected on the instrument.'
      : 'Nothing is selected on the instrument, so the ledger covers every Tier A organisation. '
        + 'Post records are fetched per organisation and are not part of first paint.',
  ]));

  loadBtn.addEventListener('click', async () => {
    const token = renderToken;
    loadBtn.remove();
    const rows: PostRow[] = [];
    const failed: string[] = [];
    let done = 0;
    const tick = () => {
      clear(status).append(
        h('span', { class: 'spin' }),
        h('span', {}, [`Loading post records… ${done} of ${selected.length} organisations`]),
      );
    };
    tick();
    const queue = [...selected];
    const worker = async () => {
      for (;;) {
        const id = queue.shift();
        if (!id) return;
        try { rows.push(...await loadPosts(ds, id)); } catch { failed.push(id); }
        done++; tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, worker));
    if (token !== renderToken) return;

    const groups = groupPosts(rows);
    const openEdge = rows.filter((r) => r.disclosed && ((r.floor == null) !== (r.ceil == null))).length;
    clear(status).append(h('span', {}, [
      `${num(groups.length)} distinct posts from ${num(rows.length)} published rows across `
      + `${selected.length - failed.length} organisation${selected.length - failed.length === 1 ? '' : 's'}`
      + `${failed.length ? `; ${failed.length} shard${failed.length === 1 ? '' : 's'} failed to load (${failed.join(', ')})` : ''}. `
      + `${num(openEdge)} rows publish one edge of their band only and carry no comparable pay figure.`,
    ]));
    clear(body).append(ledgerTable(groups));
  });

  return wrap;
}

function ledgerTable(groups: PostGroup[]): HTMLElement {
  const orgName = (id: string) => ds.meta.orgs.find((o) => o.id === id)?.name ?? id;
  const orgIds = [...new Set(groups.map((g) => g.org))].sort((a, b) => orgName(a).localeCompare(orgName(b)));
  const gradeNames = [...new Set(groups.map((g) => g.grade))]
    .sort((a, b) => ds.meta.grades.indexOf(a) - ds.meta.grades.indexOf(b));

  let text = '', org = '', grade = '', disclosedOnly = true, scsOnly = true;
  let sort: PostSort = 'latestFloor';
  let page = 0;

  const controls = h('div', { class: 'beat-controls' });
  const search = h('input', {
    class: 'beat-field', type: 'search', placeholder: 'Search a name, job title, unit or organisation…',
    'aria-label': 'Search by post-holder name, job title, unit or organisation', style: { flex: '1 1 220px' },
  }) as HTMLInputElement;
  const orgSel = h('select', { class: 'beat-field', 'aria-label': 'Organisation' }) as HTMLSelectElement;
  orgSel.append(new Option('All organisations', ''));
  for (const id of orgIds) orgSel.append(new Option(orgName(id), id));
  const gradeSel = h('select', { class: 'beat-field', 'aria-label': 'Grade' }) as HTMLSelectElement;
  gradeSel.append(new Option('All grades', ''));
  for (const g of gradeNames) gradeSel.append(new Option(g, g));
  const sortSel = h('select', { class: 'beat-field', 'aria-label': 'Sort by' }) as HTMLSelectElement;
  for (const [v, l] of [
    ['latestFloor', 'Sort: latest pay floor'],
    ['peakCeil', 'Sort: highest ceiling ever'],
    ['snapshots', 'Sort: most filings'],
    ['title', 'Sort: job title'],
  ] as [PostSort, string][]) sortSel.append(new Option(l, v));
  const discChip = h('button', { class: 'chip on', type: 'button', 'aria-pressed': 'true' }, ['Pay published only']);
  const scsChip = h('button', { class: 'chip on', type: 'button', 'aria-pressed': 'true' }, ['SCS grades only']);
  controls.append(search, orgSel, gradeSel, sortSel, discChip, scsChip);

  const host = h('div', {});
  const foot = h('div', { class: 'rank-note' });

  const draw = () => {
    const matched = searchPosts(groups, { text, orgs: org ? [org] : null, bands: null, disclosedOnly, scsOnly, sort })
      .filter((g) => !grade || g.grade === grade);
    const shown = matched.slice(0, (page + 1) * LEDGER_PAGE);

    // One scale for every sparkline on screen, so two rows can be compared.
    let smin = Infinity, smax = -Infinity;
    for (const g of shown) {
      for (const p of g.points) {
        if (p.floor != null) { smin = Math.min(smin, p.floor); smax = Math.max(smax, p.floor); }
        if (p.ceil != null) { smin = Math.min(smin, p.ceil); smax = Math.max(smax, p.ceil); }
      }
    }
    if (!Number.isFinite(smin)) { smin = 0; smax = 1; }

    const table = h('table', { class: 'records-table' });
    table.append(h('thead', {}, [h('tr', {}, [
      h('th', { scope: 'col' }, ['Job title']),
      h('th', { scope: 'col' }, ['Post-holder']),
      h('th', { scope: 'col' }, ['Organisation']),
      h('th', { scope: 'col' }, ['Grade']),
      h('th', { scope: 'col' }, ['Profession']),
      h('th', { scope: 'col' }, ['Filings']),
      h('th', { scope: 'col' }, ['Trajectory (shared scale)']),
      h('th', { scope: 'col', style: { textAlign: 'right' } }, ['Latest published band']),
    ])]));
    const tb = h('tbody', {});
    for (const g of shown) {
      const flags = h('span', {}, [
        ...(g.ddat ? [h('span', { class: 'pill ddat' }, ['DDaT'])] : []),
        ...(g.pol ? [h('span', { class: 'pill policy' }, ['Policy'])] : []),
        ...(g.identity === 'title-unit'
          ? [h('span', { class: 'pill', title: 'No usable Post Unique Reference was published; identity falls back to title and unit.' }, ['no PUR'])]
          : []),
      ]);
      tb.append(h('tr', {}, [
        h('td', {}, [
          h('div', {}, [g.title || '—', ' ', flags]),
          ...(g.unit ? [h('div', { class: 'metric-delta' }, [g.unit])] : []),
        ]),
        // A post outlives the people in it: show who holds it now, and say how
        // many held it before rather than implying the current holder is the
        // only one the record knows about.
        h('td', {}, [
          h('div', {}, [g.holder ?? h('span', { class: 'metric-delta' }, [
            g.last.status === 'vacant' ? 'vacant' : g.last.status === 'eliminated' ? 'post eliminated' : 'name not published',
          ])]),
          ...(g.holders.length > 1
            ? [h('div', { class: 'metric-delta', title: g.holders.join(' → ') }, [`${num(g.holders.length)} holders since ${g.first.date.slice(0, 4)}`])]
            : []),
        ]),
        h('td', {}, [g.suborg && g.suborg !== orgName(g.org) ? `${orgName(g.org)} — ${g.suborg}` : orgName(g.org)]),
        h('td', {}, [g.grade + (g.variant ? ` · ${g.variant}` : '')]),
        h('td', {}, [g.profession]),
        h('td', {}, [num(g.snapshots)]),
        h('td', {}, [sparkline(g, smin, smax)]),
        h('td', { class: 'money' }, [
          g.latest ? `${gbp(g.latest.lo)}–${gbp(g.latest.hi)}` : 'withheld',
          ...(g.latestDate ? [h('div', { class: 'metric-delta' }, [g.latestDate])] : []),
        ]),
      ]));
    }
    table.append(tb);
    clear(host).append(h('div', { class: 'table-scroll', style: { maxHeight: '620px' } }, [table]));

    clear(foot).append(h('span', {}, [
      `${num(shown.length)} of ${num(matched.length)} matching posts, from ${num(groups.length)} loaded. `
      + 'Bands print exactly as the department published them — nothing in this table is rounded. '
      + 'Posts sharing a floor are tied, not ranked. '
      + 'Post-holder names are published by the department in the same release as the pay band, '
      + 'under the Open Government Licence; about a quarter of senior posts are filed with one. '
      + 'A blank name is the department declining to publish it, not an empty post.',
    ]));
    if (shown.length < matched.length) {
      const more = h('button', { class: 'chip', type: 'button', style: { marginTop: '10px' } }, ['Show more']);
      more.addEventListener('click', () => { page++; draw(); });
      foot.append(more);
    }
  };

  search.addEventListener('input', () => { text = search.value.trim(); page = 0; draw(); });
  orgSel.addEventListener('change', () => { org = orgSel.value; page = 0; draw(); });
  gradeSel.addEventListener('change', () => { grade = gradeSel.value; page = 0; draw(); });
  sortSel.addEventListener('change', () => { sort = sortSel.value as PostSort; page = 0; draw(); });
  discChip.addEventListener('click', () => {
    disclosedOnly = !disclosedOnly;
    discChip.classList.toggle('on', disclosedOnly);
    discChip.setAttribute('aria-pressed', String(disclosedOnly));
    page = 0; draw();
  });
  scsChip.addEventListener('click', () => {
    scsOnly = !scsOnly;
    scsChip.classList.toggle('on', scsOnly);
    scsChip.setAttribute('aria-pressed', String(scsOnly));
    page = 0; draw();
  });
  draw();

  return h('div', {}, [
    controls, host, foot,
    h('p', { class: 'rank-note' }, [
      'Sparklines share one vertical scale across the rows on screen, so two posts can be compared; a flat line means the '
      + 'published band did not move. Where a filing withheld the pay there is a break in the ribbon, not a straight line '
      + `through it. "SCS grades only" drops ${NON_SCS_GRADES.join(', ')} — the four SCS bands and an unstated SCS band are `
      + 'what this study calls Senior Civil Service.',
    ]),
  ]);
}

/** Pay trajectory for one post: the published band over its filings. */
function sparkline(g: PostGroup, smin: number, smax: number): SVGSVGElement {
  const W = 104, H = 24, PAD = 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const first = g.points[0], last = g.points[g.points.length - 1];
  const filings = `${g.points.length} filing${g.points.length === 1 ? '' : 's'}`;
  svg.setAttribute('aria-label',
    g.latest
      ? `Pay trajectory over ${filings}, ${first.date} to ${last.date}, latest published band `
        + `${gbp(g.latest.lo)} to ${gbp(g.latest.hi)}.`
      : `No pay was published for this post in any of its ${filings}.`);

  const n = Math.max(1, g.points.length - 1);
  const x = (i: number) => PAD + (g.points.length <= 1 ? W / 2 : (i / n) * (W - PAD * 2));
  const span = smax - smin || 1;
  const y = (v: number) => H - PAD - ((v - smin) / span) * (H - PAD * 2);

  // Contiguous runs of disclosed filings: a gap in disclosure is a gap in the
  // ribbon, never a straight line drawn through it.
  let run: { i: number; floor: number; ceil: number }[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      const p = run[0];
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', String(x(p.i) - 1));
      r.setAttribute('y', String(Math.min(y(p.ceil), y(p.floor))));
      r.setAttribute('width', '2');
      r.setAttribute('height', String(Math.max(1.5, Math.abs(y(p.floor) - y(p.ceil)))));
      r.setAttribute('fill', 'var(--accent)');
      r.setAttribute('opacity', '0.55');
      svg.append(r);
    } else {
      const up = run.map((p) => `${x(p.i).toFixed(1)},${y(p.ceil).toFixed(1)}`);
      const dn = run.slice().reverse().map((p) => `${x(p.i).toFixed(1)},${y(p.floor).toFixed(1)}`);
      const ribbon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      ribbon.setAttribute('d', `M${up.join(' L')} L${dn.join(' L')} Z`);
      ribbon.setAttribute('fill', 'var(--accent)');
      ribbon.setAttribute('opacity', '0.22');
      svg.append(ribbon);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', `M${run.map((p) => `${x(p.i).toFixed(1)},${y(p.floor).toFixed(1)}`).join(' L')}`);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', 'var(--accent)');
      line.setAttribute('stroke-width', '1.5');
      svg.append(line);
    }
    run = [];
  };
  g.points.forEach((p, i) => {
    if (p.disclosed && p.floor != null && p.ceil != null) run.push({ i, floor: p.floor, ceil: p.ceil });
    else flush();
  });
  flush();
  return svg;
}

// ---------------------------------------------------------------------------
// Beat 07 — the changelog
// ---------------------------------------------------------------------------

function changelogPanel(): HTMLElement {
  const wrap = h('div', {});
  wrap.append(h('h3', { class: 'fs-subhead' }, ['The record of change']));
  const slot = h('div', {}, [h('div', { class: 'rank-note' }, ['Loading the changelog…'])]);
  wrap.append(slot);
  const token = renderToken;
  loadChangelog(ds).then((entries: ChangelogEntry[]) => {
    if (token !== renderToken) return;
    clear(slot);
    if (!entries.length) { slot.append(h('div', { class: 'rank-note' }, ['No run has changed anything yet.'])); return; }
    const table = h('table', { class: 'fs-table' });
    table.innerHTML =
      '<thead><tr><th scope="col">Run</th><th scope="col" class="num">Filings</th><th scope="col" class="num">Post rows</th><th scope="col" class="num">Bodies</th><th scope="col">Dates added</th><th scope="col">Deflator</th></tr></thead>' +
      `<tbody>${entries.slice(0, 12).map((e) => `<tr>` +
        `<td>${esc(e.run.slice(0, 10))}</td>` +
        `<td class="num">${esc(num(e.snapshotsBefore))} → ${esc(num(e.snapshotsAfter))}</td>` +
        `<td class="num">${esc(num(e.postsBefore))} → ${esc(num(e.postsAfter))}</td>` +
        `<td class="num">${esc(num(e.orgsBefore))} → ${esc(num(e.orgsAfter))}</td>` +
        `<td>${esc(e.datesAdded.length ? `${e.datesAdded.length}: ${e.datesAdded.slice(0, 3).join(', ')}${e.datesAdded.length > 3 ? '…' : ''}` : 'none')}</td>` +
        `<td>${esc(e.cpihSource)}</td></tr>`).join('')}</tbody>`;
    slot.append(scrollTable(table));
    slot.append(h('p', { class: 'rank-note' }, [
      'One entry per run that actually changed something: a run that finds nothing appends nothing, so this is a record of real change rather than a record of cron.',
    ]));
  }).catch(() => {
    if (token !== renderToken) return;
    clear(slot).append(h('div', { class: 'rank-note' }, ['No changelog has been published for this build yet.']));
  });
  return wrap;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  const app = document.getElementById('app')!;
  clear(app);
  app.append(topbar());
  const chips = filterChips();
  if (chips) app.append(chips);
  app.append(tabsNav());

  const main = h('main', {
    class: 'wrap', id: 'beat-panel', role: 'tabpanel',
    'aria-labelledby': `tab-${state.tab}`, tabindex: '-1',
  });
  app.append(main);
  app.append(footer());

  const beat = currentBeat();
  const token = ++renderToken;
  main.append(h('div', { class: 'beat' }, [h('div', { class: 'rank-note' }, ['Reading the cube…'])]));

  ensureFor(ds, toFilter(), beatDimension(beat))
    .then(() => {
      if (token !== renderToken) return;
      clear(main);
      try {
        switch (beat.template) {
          case 'T0': renderFront(main); break;
          case 'T2': renderSurvey(main, beat); break;
          case 'T3': renderPosition(main, beat); break;
          case 'T4': renderLedger(main, beat); break;
          default: renderArgument(main, beat); break;
        }
      } catch (err) {
        console.error(err);
        clear(main).append(h('div', { class: 'beat' }, [
          h('h1', { class: 'fs-h1' }, ['This beat could not be drawn']),
          h('p', { class: 'fs-body' }, [String(err)]),
        ]));
      }
    })
    .catch((err) => {
      if (token !== renderToken) return;
      clear(main).append(h('div', { class: 'beat' }, [
        h('h1', { class: 'fs-h1' }, ['Could not load that layer']),
        h('p', { class: 'fs-body' }, [String(err)]),
      ]));
    });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Links written against the six-tab version still resolve to a beat. */
const LEGACY_TAB: Record<string, string> = {
  explore: 'finding', compare: 'finding', professions: 'who-wins',
  structure: 'who-wins', records: 'who-wins', method: 'estate',
};

async function boot(): Promise<void> {
  ds = await loadData('./data/');
  facts = computeFacts();

  try {
    const saved = localStorage.getItem('scs-depth');
    if (saved === 'plain' || saved === 'research' || saved === 'technical') depth = saved;
  } catch { /* private mode */ }

  // A fresh visit opens on the front matter, because the findings are stated
  // there and nowhere else. Only a shared link carries a beat, and a link
  // written against the six-tab version still resolves to one.
  const fromHash = readHash();
  if (fromHash) {
    state = { ...state, ...fromHash };
    if (!study.beats.some((b) => b.slug === state.tab)) state.tab = LEGACY_TAB[state.tab] ?? study.beats[0].slug;
  } else {
    state.tab = study.beats[0].slug;
  }

  // One listener, registered once: the instrument is a fixed control surface
  // above 1000px and a flow of blocks below it, and the chart height differs.
  let wasNarrow = isNarrow();
  window.addEventListener('resize', () => {
    const now = isNarrow();
    if (now !== wasNarrow) { wasNarrow = now; leversOpen = !now; render(); }
  });
  leversOpen = !isNarrow();

  render();
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app')!.innerHTML =
    `<div class="wrap" style="padding:60px 20px"><h2 class="fs-h1">Could not load the data</h2>` +
    `<p class="fs-body">${esc(String(err))}</p></div>`;
});

// ---------------------------------------------------------------------------
// The reporting structure — the one thing in the corpus that describes SHAPE
// ---------------------------------------------------------------------------
//
// Every senior organogram carries the post above in a "Reports to" column, and
// where a department files completely the result is a real tree. That answers a
// question no pay figure can: how many layers of senior management a department
// runs, and whether the senior estate has been getting flatter or simply bigger.
//
// One organisation's shard at a time, because the answer is per-department and
// loading all 78 to show one tree would be indefensible.
function orgStructureBlock(): HTMLElement {
  const wrap = h('div', { style: { marginTop: '34px' } });
  wrap.append(h('h3', { class: 'fs-subhead' }, ['The shape of a department']));
  wrap.append(rich('p', { class: 'fs-body' },
    'Pay says how much; the reporting line says how the senior estate is <b>arranged</b>. Each filing names the post '
    + 'above, so a complete return reconstructs the hierarchy exactly as the department drew it. '
    + 'A span here counts only <b>senior</b> direct reports: the organogram stops at the SCS boundary, so a deputy '
    + 'director running a large junior team has a span of nought in this data. That is a property of the return, '
    + 'not of the job.'));

  const tierA = ds.meta.orgs.filter((o) => o.tier === 'A');
  const preferred = tierA.find((o) => o.id === 'DWP') ?? tierA[0];
  const controls = h('div', { class: 'beat-controls' });
  const sel = h('select', { class: 'beat-field', 'aria-label': 'Organisation' }) as HTMLSelectElement;
  for (const o of tierA) sel.append(new Option(o.name, o.id));
  if (preferred) sel.value = preferred.id;
  const loadBtn = h('button', { class: 'chip', type: 'button' }, ['Load the reporting tree']);
  controls.append(sel, loadBtn);
  const status = h('div', { class: 'beat-status' });
  const body = h('div', {});
  wrap.append(controls, status, body);

  const run = async () => {
    const id = sel.value;
    const token = renderToken;
    clear(status).append(h('span', { class: 'spin' }), h('span', {}, [`Loading ${orgLabel(id)}…`]));
    clear(body);
    let rows;
    try { rows = await loadPosts(ds, id); } catch (err) {
      if (token !== renderToken) return;
      clear(status).append(h('span', {}, [`Could not load ${orgLabel(id)}: ${String(err)}`]));
      return;
    }
    if (token !== renderToken) return;

    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const detail = structureSeriesDetailed(rows, dates);
    const seriesAll = detail.kept;
    if (!seriesAll.length) {
      clear(status).append(h('span', {}, [
        `${orgLabel(id)} has filed no return whose reporting lines fully resolve, so no tree can be drawn for it. `
        + 'That is a filing gap, not a flat organisation — the two look identical and are not the same thing.',
      ]));
      return;
    }
    const latest = seriesAll[seriesAll.length - 1];
    clear(status).append(h('span', {}, [
      `${num(seriesAll.length)} of ${num(dates.length)} filings resolve into a complete tree. `
      + 'The rest are left out, because a partial return looks exactly like a flatter organisation: '
      + Object.entries(detail.rejected.reduce((a: Record<string, number>, x) => {
        a[x.reason] = (a[x.reason] ?? 0) + 1; return a;
      }, {})).sort((a, b) => b[1] - a[1]).map(([why, n]) => `${num(n)} ${why}`).join('; ') + '.',
    ]));

    // ---- the latest tree, as a layer profile
    const gradeOrder = ds.meta.grades;
    const layerRows = latest.layers.map((L) => {
      const parts = Object.entries(L.byGrade).sort((a, b) => gradeOrder.indexOf(a[0]) - gradeOrder.indexOf(b[0]));
      return {
        cells: [
          `Layer ${L.depth}`,
          num(L.posts),
          pct((L.posts / latest.posts) * 100, 1, false),
          parts.map(([g, n]) => `${g} ${num(n)}`).join(' · ') || '—',
        ],
      };
    });
    body.append(card({
      variant: 'figure', figNo: '5.8',
      title: `${orgLabel(id)} — the senior hierarchy at ${dateLabel(latest.date)}`,
      sub: `${num(latest.posts)} senior posts · ${num(latest.edges)} reporting lines · `
        + `${latest.depth} layer${latest.depth === 1 ? '' : 's'} · median span ${num(latest.medianSpan)} · source [1]`,
      caption: `Layer 1 is the post nobody in the return reports to. Each layer counts the senior posts at that `
        + `distance below it. Grades are shown per layer because a layer is not a grade: `
        + `${orgLabel(id)} files senior posts of more than one grade at the same distance from the top.`,
      table: fsTable(
        [{ label: 'Layer' }, { label: 'Senior posts', num: true }, { label: 'Share', num: true }, { label: 'Grades present' }],
        layerRows,
      ),
      build: (host) => {
        const maxPosts = Math.max(...latest.layers.map((L) => L.posts), 1);
        const bars = h('div', { class: 'layer-profile' });
        for (const L of latest.layers) {
          bars.append(h('div', { class: 'layer-row' }, [
            h('span', { class: 'metric-label' }, [`Layer ${L.depth}`]),
            h('div', { class: 'layer-bar' }, [
              h('span', { style: { width: `${Math.max(2, (L.posts / maxPosts) * 100)}%` } }),
            ]),
            h('span', { class: 'num' }, [num(L.posts)]),
          ]));
        }
        host.append(bars);
        return null;
      },
      foot: [
        `${num(latest.managers)} of ${num(latest.posts)} senior posts have at least one senior post reporting to them; `
        + `${num(latest.leaves)} have none. Widest span ${num(latest.maxSpan)}. `
        + (latest.rootCount > 1 ? `${num(latest.rootCount)} posts report to nobody in this return, so the department filed more than one top. ` : '')
        + 'Counted over live posts only; posts recorded as eliminated are excluded.',
      ],
    }));

    // ---- has it flattened?
    if (seriesAll.length >= 4) {
      const labels = seriesAll.map((s) => s.date);
      body.append(card({
        variant: 'figure', figNo: '5.9',
        title: `${orgLabel(id)} — layers and span over time`,
        sub: `${num(seriesAll.length)} complete filings, ${dateLabel(seriesAll[0].date)} to ${dateLabel(latest.date)} · source [1]`,
        caption: 'Whether the senior estate has been flattening, or simply growing. Layers count the deepest chain in '
          + 'the return; median span is the middle number of senior direct reports among posts that have any. Only '
          + 'filings whose reporting lines fully resolve are plotted, so the line is not continuous in time.',
        build: (host) => {
          return lineChart(host, {
              labels,
              series: [
                { key: 'depth', label: 'Layers (deepest chain)', color: colorFor(0), values: seriesAll.map((s) => s.depth) },
                { key: 'span', label: 'Median senior span', color: colorFor(1), values: seriesAll.map((s) => s.medianSpan) },
              ],
              yFormat: (n) => (n == null ? '—' : String(Math.round(n))),
              yZero: true,
              height: 240,
              title: `${orgLabel(id)} layers and median span`,
              desc: 'Two flat-ish series: the number of management layers and the median number of senior direct reports.',
          });
        },
        foot: [
          `Senior posts in this department went from ${num(seriesAll[0].posts)} at ${dateLabel(seriesAll[0].date)} `
          + `to ${num(latest.posts)} at ${dateLabel(latest.date)}, while the median span moved from `
          + `${num(seriesAll[0].medianSpan)} to ${num(latest.medianSpan)} and the deepest chain from `
          + `${num(seriesAll[0].depth)} to ${num(latest.depth)} layers. `
          + 'A senior estate that grows without changing shape is being scaled, not restructured.',
        ],
      }));
    }

    // ---- who supervises the most
    const top = latest.spans.slice(0, 12);
    body.append(card({
      variant: 'figure', figNo: '5.10',
      title: `The widest spans at ${dateLabel(latest.date)}`,
      sub: `${orgLabel(id)} · senior direct reports only · source [1]`,
      caption: 'The posts with the most senior posts reporting directly to them. A wide span at the top of a '
        + 'department is a flat structure; a wide span in the middle is usually a directorate that has grown '
        + 'without adding a layer.',
      build: (host) => {
        return barChart(host, {
          rows: top.map((s) => ({
            key: s.pur,
            label: `${s.title.slice(0, 46)}${s.title.length > 46 ? '…' : ''}`,
            value: s.reports,
            color: 'var(--accent)',
          })),
          valueFormat: (n) => num(n) + (n === 1 ? ' report' : ' reports'),
          title: 'Widest senior spans of control',
        });
      },
      foot: [
        'Titles are as published. A post appearing here with a small span is not under-employed — the organogram '
        + 'records only senior reports, and most of a department reports to somebody below this boundary.',
      ],
    }));
  };

  loadBtn.addEventListener('click', run);
  sel.addEventListener('change', () => { if (body.childNodes.length) run(); });
  return wrap;
}

function orgLabel(id: string): string {
  return ds.meta.orgs.find((o) => o.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// Fig 6.4 — the same year, published twice, with different numbers
// ---------------------------------------------------------------------------
//
// This is the sharpest available answer to "how far behind the market is SCS
// pay", and the answer is that the published figure moved by 17 percentage
// points for an unchanged year between two consecutive reports by the same
// body. It belongs in the trust beat rather than the finding beat, because what
// it establishes is not a gap but the width of the uncertainty around one.
function figSsrbRestatement(fig: StudyFigure): HTMLElement {
  const wrap = h('div', {});
  const slot = h('div', {}, [h('div', { class: 'rank-note' }, ['Reading the Review Body’s reports…'])]);
  wrap.append(slot);
  const token = renderToken;
  loadSsrbGap(ds)
    .then((g) => { if (token === renderToken) clear(slot).append(ssrbRestatementBlock(fig, g)); })
    .catch((err) => {
      if (token !== renderToken) return;
      clear(slot).append(h('div', { class: 'rank-note' }, [`The SSRB series could not be loaded: ${String(err)}`]));
    });
  return wrap;
}

function ssrbRestatementBlock(fig: StudyFigure, g: SsrbGap): HTMLElement {
  const wrap = h('div', {});
  const rs = g.restatements.slice().sort((a, b) => b.spreadPoints - a.spreadPoints);
  const editions = [...new Set(g.figures.map((f) => f.edition))].sort();

  if (!rs.length) {
    wrap.append(h('div', { class: 'rank-note' }, [
      `No restatement found across the ${num(editions.length)} edition(s) whose market-gap chart could be read. `
      + 'That is a finding in itself and it may not survive the next edition.',
    ]));
    return wrap;
  }

  const worst = rs[0];
  const bandName = (b: string) => b.replace(/\b\w/g, (c) => c.toUpperCase());

  wrap.append(card({
    variant: 'figure', figNo: fig.no, caption: fig.caption,
    title: 'The gap, as published twice',
    sub: `Senior Salaries Review Body, ${editions.join(' and ')} reports · per cent below the comparator median · source [9]`,
    table: fsTable(
      [{ label: 'Pay band' }, { label: 'Against' }, { label: 'Year', num: true },
        { label: 'As published' }, { label: 'Edition' }, { label: 'Figure' }, { label: 'Page', num: true }],
      rs.flatMap((x) => x.readings.map((rd) => ({
        cells: [bandName(x.band), bandName(x.sector), String(x.year), `${rd.pct}%`,
          `${rd.edition} report`, `Figure ${rd.figureNo}`, String(rd.page)],
      }))),
    ),
    build: (host) => {
      // A dumbbell: one row per restated quantity, a rule between the two
      // published readings. The distance IS the finding, so it is what the mark
      // encodes — not the level, which is what a bar would say.
      const all = rs.flatMap((x) => x.readings.map((rd) => rd.pct));
      const lo = Math.min(...all, 0), hi = Math.max(...all, 0);
      const grid = h('div', { class: 'restate' });
      for (const x of rs) {
        const sorted = x.readings.slice().sort((a, b) => a.edition - b.edition);
        const first = sorted[0], last = sorted[sorted.length - 1];
        const at = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
        const a = Math.min(at(first.pct), at(last.pct));
        const b = Math.max(at(first.pct), at(last.pct));
        grid.append(h('div', { class: 'restate-row' }, [
          h('span', { class: 'metric-label' }, [`${bandName(x.band)} v ${x.sector} · ${x.year}`]),
          h('div', { class: 'restate-track' }, [
            h('span', { class: 'restate-link', style: { left: `${a}%`, width: `${Math.max(1, b - a)}%` } }),
            h('span', { class: 'restate-dot old', style: { left: `${at(first.pct)}%` }, title: `${first.pct}% — ${first.edition} report, Figure ${first.figureNo}, page ${first.page}` }),
            h('span', { class: 'restate-dot new', style: { left: `${at(last.pct)}%` }, title: `${last.pct}% — ${last.edition} report, Figure ${last.figureNo}, page ${last.page}` }),
          ]),
          h('span', { class: 'num' }, [`${first.pct}% → ${last.pct}%`]),
        ]));
      }
      grid.append(h('div', { class: 'restate-key' }, [
        h('span', {}, [h('span', { class: 'restate-dot old' }), ` as first published`]),
        h('span', {}, [h('span', { class: 'restate-dot new' }), ` as restated`]),
      ]));
      host.append(grid);
      return null;
    },
    foot: [
      `The largest restatement is ${bandName(worst.band)} against the ${worst.sector} sector for ${worst.year}: `
      + `${worst.readings[0].pct}% in the ${worst.readings[0].edition} report and `
      + `${worst.readings[worst.readings.length - 1].pct}% in the ${worst.readings[worst.readings.length - 1].edition} report, `
      + `a movement of ${num(worst.spreadPoints)} percentage points in a year that had already happened.`,
      'The Review Body notes that its benchmarking supplier changed its civil service reference levels in October 2023, '
      + 'which explains why a restatement occurred but not which reading is right — both remain published, and neither '
      + 'is withdrawn.',
      'The figure carrying this comparison is numbered differently in every edition, and the 2026 report drops it '
      + `entirely: ${g.editionsWithoutTheFigure.includes(2026) ? 'the Review Body says it intends to return to the analysis in a future report' : 'see the editions list'}. `
      + 'A series that ends is not a gap that closed.',
    ],
  }));
  return wrap;
}
