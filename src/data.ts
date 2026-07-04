// Data layer: loads the histogram cube + metadata and answers aggregate
// queries entirely client-side. The cube is an additive histogram at grain
// (period-date x dept x profession x grade x ddat-flag x policy-flag), so any
// filter is answered by summing the matching cells and reading percentiles off
// the merged pay histogram (bins match the £5k transparency banding).

export interface Dept { id: string; name: string; family: string; slugs: string[]; }
export interface Meta {
  generated: string;
  source: { name: string; via: string; note: string };
  binWidth: number;
  dates: string[];
  depts: Dept[];
  profs: string[];
  grades: string[];
  coverage: Record<string, number[]>;
  cpih: { index: Record<string, number>; source: string };
  stats: {
    departments: number; snapshots: number; cells: number; posts: number;
    dateRange: [string, string]; filesOk: number; filesFail: number;
  };
}

// cube row tuple: [dateIdx, deptIdx, profIdx, gradeIdx, ddat, pol, n, fteSum, sumMid, bill, histFlat]
export type Row = [number, number, number, number, number, number, number, number, number, number, number[]];

export interface DataSet {
  meta: Meta;
  rows: Row[];
  notable: NotablePost[];
  periods: string[];          // e.g. "2011 H1", "2011 H2", ...
  periodOfDate: number[];     // dateIdx -> periodIdx
  // chosen[deptIdx][periodIdx] = dateIdx to use (latest snapshot in that period), or -1
  chosen: Int16Array[];
  binWidth: number;
}

export interface NotablePost {
  dept: string; date: string; grade: string; prof: string;
  ddat: number; pol: number; title: string; floor: number | null; ceil: number | null; mid: number;
}

export async function loadData(base = './data/'): Promise<DataSet> {
  const [meta, cube, notable] = await Promise.all([
    fetch(base + 'meta.json').then(r => r.json()) as Promise<Meta>,
    fetch(base + 'cube.json').then(r => r.json()) as Promise<{ rows: Row[] }>,
    fetch(base + 'notable.json').then(r => r.json()) as Promise<{ posts: NotablePost[] }>,
  ]);

  // half-year period per date: month <=6 => H1 (spring "31 March" release), else H2
  const periodKey = (iso: string) => {
    const [y, m] = iso.split('-').map(Number);
    return `${y} ${m <= 6 ? 'H1' : 'H2'}`;
  };
  const periodSet = new Map<string, number>();
  const periodOrder = (k: string) => { const [y, h] = k.split(' '); return Number(y) * 2 + (h === 'H2' ? 1 : 0); };
  for (const d of meta.dates) if (!periodSet.has(periodKey(d))) periodSet.set(periodKey(d), 0);
  const periods = [...periodSet.keys()].sort((a, b) => periodOrder(a) - periodOrder(b));
  const periodIdx = new Map(periods.map((p, i) => [p, i]));
  const periodOfDate = meta.dates.map(d => periodIdx.get(periodKey(d))!);

  // chosen date per (dept, period): the latest snapshot date that dept has in
  // that period — collapses quarterly reporters to a clean twice-yearly series
  // aligned across all departments.
  const chosen: Int16Array[] = meta.depts.map(() => new Int16Array(periods.length).fill(-1));
  meta.depts.forEach((dept, deptIdx) => {
    for (const dateIdx of (meta.coverage[dept.id] || [])) {
      const p = periodOfDate[dateIdx];
      const cur = chosen[deptIdx][p];
      if (cur < 0 || dateIdx > cur) chosen[deptIdx][p] = dateIdx; // later dateIdx == later date (dates sorted)
    }
  });

  return { meta, rows: cube.rows, notable: notable.posts, periods, periodOfDate, chosen, binWidth: meta.binWidth };
}

// ---- query types ----
export type Measure =
  | 'medianPost'   // median individual pay (post-weighted)
  | 'meanPost'     // mean individual pay
  | 'p25' | 'p75'  // pay quartiles
  | 'meanFTE'      // FTE-weighted mean pay
  | 'headcount'    // number of senior posts
  | 'fte'          // full-time-equivalent count
  | 'paybill';     // total pay bill (£, sum of mid*fte)

export type Dimension = 'none' | 'department' | 'profession' | 'grade' | 'ddatPolicy';

export interface Filter {
  depts?: Set<number> | null;      // dept indices; null/empty = all
  profs?: Set<number> | null;
  grades?: Set<number> | null;
  ddat?: boolean | null;           // true = only DDaT, false = only non-DDaT, null = both
  policy?: boolean | null;
  realTerms?: boolean;             // deflate pay by CPIH
  baseYear?: number;               // real-terms base year (default latest)
}

interface Cell { n: number; fte: number; sumMid: number; bill: number; hist: Map<number, number>; }

function emptyCell(): Cell { return { n: 0, fte: 0, sumMid: 0, bill: 0, hist: new Map() }; }
function addRow(c: Cell, r: Row) {
  c.n += r[6]; c.fte += r[7]; c.sumMid += r[8]; c.bill += r[9];
  const h = r[10];
  for (let i = 0; i < h.length; i += 2) c.hist.set(h[i], (c.hist.get(h[i]) || 0) + h[i + 1]);
}

function percentile(hist: Map<number, number>, total: number, q: number, binWidth: number): number {
  if (total === 0) return NaN;
  const bins = [...hist.keys()].sort((a, b) => a - b);
  const target = q * total;
  let cum = 0;
  for (const b of bins) {
    cum += hist.get(b)!;
    if (cum >= target) return b * binWidth + binWidth / 2;
  }
  return NaN;
}

function measureOf(c: Cell, m: Measure, binWidth: number): number {
  switch (m) {
    case 'headcount': return c.n;
    case 'fte': return Math.round(c.fte * 10) / 10;
    case 'paybill': return c.bill;
    case 'meanPost': return c.n ? c.sumMid / c.n : NaN;
    case 'meanFTE': return c.fte ? c.bill / c.fte : NaN;
    case 'medianPost': return percentile(c.hist, c.n, 0.5, binWidth);
    case 'p25': return percentile(c.hist, c.n, 0.25, binWidth);
    case 'p75': return percentile(c.hist, c.n, 0.75, binWidth);
  }
}

const isPayMeasure = (m: Measure) => m !== 'headcount' && m !== 'fte' && m !== 'paybill';

export interface SeriesResult {
  periods: string[];
  groups: { key: string; label: string; values: (number | null)[] }[];
}

// core query: a value per period, optionally split into groups by `dimension`.
export function series(ds: DataSet, filter: Filter, measure: Measure, dimension: Dimension): SeriesResult {
  const { rows, meta, periods, periodOfDate, chosen, binWidth } = ds;
  const nP = periods.length;
  const depFilter = filter.depts && filter.depts.size ? filter.depts : null;
  const profFilter = filter.profs && filter.profs.size ? filter.profs : null;
  const gradeFilter = filter.grades && filter.grades.size ? filter.grades : null;

  // group registry
  const groupIdx = new Map<string, number>();
  const groupMeta: { key: string; label: string }[] = [];
  const cells: Cell[][] = []; // [group][period]
  const ensureGroup = (key: string, label: string) => {
    let gi = groupIdx.get(key);
    if (gi === undefined) {
      gi = groupMeta.length; groupIdx.set(key, gi); groupMeta.push({ key, label });
      cells.push(Array.from({ length: nP }, emptyCell));
    }
    return gi;
  };

  const groupFor = (r: Row): { key: string; label: string } => {
    switch (dimension) {
      case 'department': { const d = meta.depts[r[1]]; return { key: d.id, label: d.name }; }
      case 'profession': return { key: String(r[2]), label: meta.profs[r[2]] };
      case 'grade': return { key: String(r[3]), label: meta.grades[r[3]] };
      case 'ddatPolicy': {
        if (r[4]) return { key: 'ddat', label: 'DDaT' };
        if (r[5]) return { key: 'policy', label: 'Policy' };
        return { key: 'other', label: 'Other roles' };
      }
      default: return { key: 'all', label: 'All' };
    }
  };

  for (const r of rows) {
    const deptIdx = r[1], dateIdx = r[0];
    if (depFilter && !depFilter.has(deptIdx)) continue;
    if (profFilter && !profFilter.has(r[2])) continue;
    if (gradeFilter && !gradeFilter.has(r[3])) continue;
    if (filter.ddat === true && !r[4]) continue;
    if (filter.ddat === false && r[4]) continue;
    if (filter.policy === true && !r[5]) continue;
    if (filter.policy === false && r[5]) continue;
    const p = periodOfDate[dateIdx];
    // alignment: only count the chosen (latest) snapshot for this dept+period
    if (chosen[deptIdx][p] !== dateIdx) continue;
    const g = groupFor(r);
    const gi = ensureGroup(g.key, g.label);
    addRow(cells[gi][p], r);
  }

  // CPIH deflator per period (by the period's year)
  const idx = meta.cpih.index;
  const years = Object.keys(idx).map(Number);
  const baseYear = filter.baseYear ?? Math.max(...years);
  const baseIdx = idx[baseYear] ?? 100;
  const deflator = (periodKey: string) => {
    const y = Number(periodKey.split(' ')[0]);
    const yi = idx[y] ?? idx[Math.max(...years.filter(z => z <= y))] ?? baseIdx;
    return baseIdx / yi;
  };
  const monetary = measure !== 'headcount' && measure !== 'fte'; // everything else is £

  const groups = groupMeta.map((gm, gi) => ({
    key: gm.key, label: gm.label,
    values: cells[gi].map((c, p) => {
      if (c.n === 0) return null;
      let v = measureOf(c, measure, binWidth);
      if (Number.isNaN(v)) return null;
      if (filter.realTerms && monetary) v = v * deflator(periods[p]);
      return v;
    }),
  }));

  return { periods, groups };
}

// Per-period count of posts whose pay exceeds a (possibly period-varying)
// threshold — reads the pay histograms directly. Same filter + chosen-snapshot
// alignment as series(). Used for "more than the PM" / "£150k+" trackers.
export function countAbove(ds: DataSet, filter: Filter, threshold: (periodIdx: number) => number): { periods: string[]; above: number[]; total: number[] } {
  const { rows, periods, periodOfDate, chosen, binWidth } = ds;
  const nP = periods.length;
  const above = new Array(nP).fill(0), total = new Array(nP).fill(0);
  const depF = filter.depts && filter.depts.size ? filter.depts : null;
  const profF = filter.profs && filter.profs.size ? filter.profs : null;
  const gradeF = filter.grades && filter.grades.size ? filter.grades : null;
  for (const r of rows) {
    const deptIdx = r[1], dateIdx = r[0];
    if (depF && !depF.has(deptIdx)) continue;
    if (profF && !profF.has(r[2])) continue;
    if (gradeF && !gradeF.has(r[3])) continue;
    if (filter.ddat === true && !r[4]) continue;
    if (filter.ddat === false && r[4]) continue;
    if (filter.policy === true && !r[5]) continue;
    if (filter.policy === false && r[5]) continue;
    const p = periodOfDate[dateIdx];
    if (chosen[deptIdx][p] !== dateIdx) continue;
    const thr = threshold(p);
    const hist = r[10];
    for (let i = 0; i < hist.length; i += 2) {
      const mid = hist[i] * binWidth + binWidth / 2;
      const cnt = hist[i + 1];
      total[p] += cnt;
      if (mid > thr) above[p] += cnt;
    }
  }
  return { periods, above, total };
}

// A single aggregate over ALL matching cells for one period (or latest) — used
// for KPI tiles and rankings.
export function snapshot(ds: DataSet, filter: Filter, measure: Measure, periodIdx: number): number | null {
  const r = series(ds, filter, measure, 'none');
  const g = r.groups[0];
  if (!g) return null;
  return g.values[periodIdx];
}

export const latestPeriodIdx = (ds: DataSet) => ds.periods.length - 1;

// percentage change between two period values
export function pctChange(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return (to - from) / from * 100;
}

// compound annual growth rate between two periods (periods are half-years)
export function cagr(from: number | null, to: number | null, periodsApart: number): number | null {
  if (from == null || to == null || from <= 0 || to <= 0 || periodsApart <= 0) return null;
  const years = periodsApart / 2;
  return (Math.pow(to / from, 1 / years) - 1) * 100;
}
