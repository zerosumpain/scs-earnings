// Data layer for the SCS earnings study.
//
// Built against docs/DATA-CONTRACT.md (schema 2). The pipeline owns
// public/data/**; this file owns reading it. Nothing here may invent a number
// the publisher did not publish.
//
// Three rules run through everything below:
//
//   1. Pay is a (floor, ceiling) band £5,000 wide. There is no midpoint in the
//      data and none is manufactured here. Every pay statistic is returned as
//      a pair of bounds.
//   2. Disclosure is a field, not a filter. Headcount, FTE, grade mix and the
//      disclosure rate are computed on the FULL published population — which
//      includes the withheld sentinel (binLow === -1) and the open-band
//      sentinel (binLow === -2). Pay statistics are computed on the disclosed,
//      band-resolvable subset (binLow >= 0) only.
//   3. Organisations have lineage. A predecessor is never summed with its own
//      successor in one period, and cross-period totals default to a scope
//      that does not churn underneath the reader.

// ---------------------------------------------------------------------------
// meta.json — section 2 of the contract
// ---------------------------------------------------------------------------

export type Tier = 'A' | 'B';
export type RefConfidence = 'declared' | 'inferred' | 'default';

export interface Org {
  id: string;
  name: string;
  tier: Tier;
  family: string;
  validFrom: string | null;
  validTo: string | null;
  predecessors: string[];
  successors: string[];
}

export interface CoverageRow {
  org: string;
  snapshots: number;
  dates: number[];
  posts: number;
  headcount: number;
  disclosed: number;
}

export interface SnapshotPart { pkg: string; rows: number; conf: RefConfidence; basis: string }

export interface Snapshot {
  org: string;
  d: number;
  conf: RefConfidence;
  rows: number;
  headcount: number;
  disclosed: number;
  parts: SnapshotPart[];
}

export interface Cpih {
  index: Record<string, number>;
  source: string;
  live: boolean;
  url: string;
  warning: string | null;
}

export interface Stats {
  orgs: number;
  snapshots: number;
  files: number;
  dates: number;
  dateRange: [string, string];
  posts: number;
  headcount: number;
  seniorPosts: number;
  disclosed: number;
  openBand: number;
  withheld: number;
  disclosureRate: number;
  eliminated: number;
  vacant: number;
  coreCells: number;
  profCells: number;
  filesOk: number;
  filesFail: number;
  undatedSkipped: number;
  rejectedSiblings: number;
  /** @deprecated legacy alias for `orgs`, filled in by the loader. */
  departments: number;
}

export interface Scope { tier: 'ALL' | 'A' | 'B'; only: string[] | null; maxFiles: number | null; partial: boolean }

export interface Meta {
  schema: number;
  /**
   * When this build was made: the run that last CHANGED the payload. A rebuild
   * that changes nothing inherits the previous stamp, so it stays deterministic.
   * This is the date to print beside the word "built".
   */
  generated: string;
  /**
   * How current the DATA is: the newest upstream CKAN timestamp in the corpus.
   * Under schema 1 this value was in `generated`, which is why the page could
   * say "built" over a date five days older than the build.
   */
  dataAsOf: string | null;
  scope: Scope;
  source: { name: string; via: string; licence: string; note: string; cadence: string };
  binWidth: number;
  dates: string[];
  orgs: Org[];
  grades: string[];
  profs: string[];
  statuses: string[];
  withheldReasons: string[];
  /** dictionary for `Snapshot.conf`: declared, inferred, default */
  confidences: RefConfidence[];
  coverage: CoverageRow[];
  snapshots: Snapshot[];
  cpih: Cpih;
  stats: Stats;
  warnings: string[];
  /** @deprecated legacy alias for `orgs`; index space is identical. */
  depts: Dept[];
}

/**
 * `meta.snapshots` on the wire — contract 2.3. Columnar with two local
 * dictionaries, because 1,483 snapshots as one object each cost 19.1 KB gz of a
 * 70 KB first paint, three quarters of it the same 127 CKAN package names
 * written out 1,496 times. `loadData()` decodes it straight back into
 * `Snapshot[]`; nothing above this file sees the encoding.
 */
export interface SnapshotBlock {
  n: number;
  /** dictionary for `parts.pkg` */
  pkgs: string[];
  /** dictionary for `parts.basis` */
  bases: string[];
  /** index into meta.orgs */
  org: number[];
  /** index into meta.dates */
  d: number[];
  /** index into meta.confidences */
  conf: number[];
  rows: number[];
  headcount: number[];
  disclosed: number[];
  partCount: number[];
  /** flat, in snapshot order: snapshot i owns the next partCount[i] entries */
  parts: { pkg: number[]; rows: number[]; conf: number[]; basis: number[] };
}

/** meta.json exactly as it arrives, before the snapshot block is decoded. */
export type MetaFile = Omit<Meta, 'snapshots' | 'depts'> & { snapshots: SnapshotBlock };

/** @deprecated legacy shape kept so the pre-rebuild tabs still typecheck. */
export interface Dept { id: string; name: string; family: string; slugs: string[] }

// ---------------------------------------------------------------------------
// The cubes — section 3 of the contract
// ---------------------------------------------------------------------------

export interface CubeFile {
  schema: number;
  /** schema 2 ships one array per column. Schema 1 shipped one array per cell. */
  layout: 'columnar';
  grain: string[];
  fields: string[];
  /** the three second-order residuals, as formulas — see `CUBE_ENCODING` */
  encoding: Record<string, string>;
  binWidth: number;
  tier: Tier;
  /** cells; every column array has exactly this length */
  n: number;
  cols: Record<string, number[]>;
}

/**
 * Three cube columns are stored as differences from what the row already
 * states, because the difference is zero in the great majority of cells and
 * gzip is very good at that. The ingest ships these same strings in
 * `cube.encoding`, and `decodeCube` refuses a file whose formulas do not match:
 * a decoder that silently disagrees with its encoder produces plausible wrong
 * numbers, which is the worst failure this repository has.
 */
export const CUBE_ENCODING: Record<string, string> = {
  binHigh: 'binLow + v',
  fteKnown: 'n + withheld + v',
  fteSum: '(fteKnown * 100 + v) / 100',
};

/**
 * A cube decoded into parallel typed arrays. The four money residuals are
 * resolved into absolute pounds at load (contract 3.3) so no consumer has to
 * remember the reconstruction.
 */
export interface CubeView {
  tier: Tier;
  hasProf: boolean;
  n: number;
  binWidth: number;
  date: Int32Array;
  org: Int32Array;
  grade: Int32Array;
  prof: Int32Array;
  ddat: Uint8Array;
  pol: Uint8Array;
  binLow: Int32Array;
  binHigh: Int32Array;
  /** disclosed posts, excluding eliminated. Zero in a withheld (-1) cell. */
  nDisc: Int32Array;
  withheld: Int32Array;
  vacant: Int32Array;
  elim: Int32Array;
  fteSum: Float64Array;
  fteKnown: Int32Array;
  sumFloor: Float64Array;
  sumCeil: Float64Array;
  billLow: Float64Array;
  billHigh: Float64Array;
}

/** Pay is never disclosed for this post. In headcount, in no pay statistic. */
export const BIN_WITHHELD = -1;
/** Exactly one band edge was published. Counted, but carries no money. */
export const BIN_OPEN = -2;

export function decodeCube(file: CubeFile): CubeView {
  if (file.layout !== 'columnar') {
    throw new Error(`cube: expected a columnar payload, got layout "${String(file.layout)}" — `
      + 'the build and public/data are from different schemas. See docs/DATA-CONTRACT.md section 3.');
  }
  for (const [name, formula] of Object.entries(CUBE_ENCODING)) {
    if (file.encoding?.[name] !== formula) {
      throw new Error(`cube: column "${name}" arrived encoded as "${file.encoding?.[name] ?? 'nothing'}", `
        + `this build decodes "${formula}". Refusing to decode rather than return plausible wrong numbers.`);
    }
  }

  const cols = file.cols;
  const req = (name: string): number[] => {
    const a = cols[name];
    if (!a) throw new Error(`cube: missing column "${name}" — has ${Object.keys(cols).join(',')}`);
    return a;
  };
  const opt = (name: string): number[] | null => cols[name] ?? null;

  const cDate = req('dateIdx'), cOrg = req('orgIdx'), cGrade = req('gradeIdx');
  const cLow = req('binLow'), cHighRes = req('binHigh');
  const cProf = opt('profIdx'), cDdat = opt('ddat'), cPol = opt('pol');
  const cN = req('n'), cW = req('withheld'), cV = req('vacant'), cE = req('eliminated');
  const cFteRes = req('fteSum'), cFteKnownRes = req('fteKnown');
  const cSF = req('sumFloorRes'), cSC = req('sumCeilRes');
  const cBL = req('billLowRes'), cBH = req('billHighRes');

  const n = file.n;
  if (cDate.length !== n) {
    throw new Error(`cube: declares n=${n} but dateIdx carries ${cDate.length} values`);
  }
  const BIN = file.binWidth;
  const v: CubeView = {
    tier: file.tier, hasProf: cProf != null, n, binWidth: BIN,
    date: new Int32Array(n), org: new Int32Array(n), grade: new Int32Array(n),
    prof: new Int32Array(n), ddat: new Uint8Array(n), pol: new Uint8Array(n),
    binLow: new Int32Array(n), binHigh: new Int32Array(n),
    nDisc: new Int32Array(n), withheld: new Int32Array(n), vacant: new Int32Array(n), elim: new Int32Array(n),
    fteSum: new Float64Array(n), fteKnown: new Int32Array(n),
    sumFloor: new Float64Array(n), sumCeil: new Float64Array(n),
    billLow: new Float64Array(n), billHigh: new Float64Array(n),
  };

  for (let i = 0; i < n; i++) {
    const lo = cLow[i];
    // contract 3.3 — binHigh, fteKnown and fteSum are stored as differences
    // from what the cell already states. Zero in most cells, which is the point.
    const hi = lo + cHighRes[i];
    const nd = cN[i], w = cW[i];
    const fteKnown = nd + w + cFteKnownRes[i];

    v.date[i] = cDate[i]; v.org[i] = cOrg[i]; v.grade[i] = cGrade[i];
    v.prof[i] = cProf ? cProf[i] : -1;
    v.ddat[i] = cDdat ? cDdat[i] : 0;
    v.pol[i] = cPol ? cPol[i] : 0;
    v.binLow[i] = lo; v.binHigh[i] = hi;
    v.nDisc[i] = nd;
    v.withheld[i] = w;
    v.vacant[i] = cV[i];
    v.elim[i] = cE[i];
    v.fteKnown[i] = fteKnown;
    v.fteSum[i] = (fteKnown * 100 + cFteRes[i]) / 100;

    // contract 3.4 — the four money residuals are differences from what the bin
    // edges already imply. In the great majority of cells they are all zero.
    const impliedFloor = lo < 0 ? 0 : nd * lo * BIN;
    const impliedCeil = hi < 0 ? 0 : nd * (hi * BIN + BIN - 1);
    const sumFloor = cSF[i] + impliedFloor;
    const sumCeil = cSC[i] + impliedCeil;
    v.sumFloor[i] = sumFloor;
    v.sumCeil[i] = sumCeil;
    v.billLow[i] = cBL[i] + sumFloor;
    v.billHigh[i] = cBH[i] + sumCeil;
  }
  return v;
}

/**
 * The snapshot registry, back into the `Snapshot[]` every consumer above this
 * file expects. Contract 2.3. Nothing outside `loadData()` sees `SnapshotBlock`.
 */
export function decodeSnapshots(block: SnapshotBlock, orgs: Org[], confidences: RefConfidence[]): Snapshot[] {
  const out: Snapshot[] = new Array(block.n);
  let k = 0;
  for (let i = 0; i < block.n; i++) {
    const count = block.partCount[i];
    const parts: SnapshotPart[] = new Array(count);
    for (let j = 0; j < count; j++, k++) {
      parts[j] = {
        pkg: block.pkgs[block.parts.pkg[k]],
        rows: block.parts.rows[k],
        conf: confidences[block.parts.conf[k]],
        basis: block.bases[block.parts.basis[k]],
      };
    }
    out[i] = {
      org: orgs[block.org[i]].id,
      d: block.d[i],
      conf: confidences[block.conf[i]],
      rows: block.rows[i],
      headcount: block.headcount[i],
      disclosed: block.disclosed[i],
      parts,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading — first paint is meta.json + cube-core.json and nothing else
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

/**
 * Fetch + parse JSON once per URL. The promise itself is cached, so a
 * double-click cannot start a second request; a rejection is evicted so a
 * retry is still possible.
 */
export function fetchJson<T>(url: string): Promise<T> {
  const hit = inflight.get(url);
  if (hit) return hit as Promise<T>;
  const p = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
      return r.json() as Promise<T>;
    })
    .catch((e) => { inflight.delete(url); throw e; });
  inflight.set(url, p);
  return p as Promise<T>;
}

/** Test hook. Never called by the app. */
export function resetFetchCache(): void { inflight.clear(); }

export type LayerName = 'coreB' | 'prof' | 'profB';

const LAYER_FILE: Record<LayerName, string> = {
  coreB: 'cube-core-b.json',
  prof: 'cube-prof.json',
  profB: 'cube-prof-b.json',
};

export interface DataSet {
  base: string;
  meta: Meta;
  binWidth: number;
  /** Tier A core cube — the only cube fetched at first paint. */
  core: CubeView;
  layers: { coreB: CubeView | null; prof: CubeView | null; profB: CubeView | null };
  orgIdx: Map<string, number>;
  /** transitive successors of each org index, used to refuse double counting */
  descendants: Set<number>[];
  ancestors: Set<number>[];
  /** grade indices that count as Senior Civil Service (contract rule 6) */
  scsGrades: number[];
  snapshotAt: Map<string, Snapshot>;
  periodCache: Map<Grain, PeriodIndex>;

  /** @deprecated legacy: period labels at the default grain. */
  periods: string[];
  /** @deprecated notable.json is retired; use src/posts.ts. Always empty. */
  notable: NotablePost[];
}

/** @deprecated notable.json is retired. Kept so the old tabs still typecheck. */
export interface NotablePost {
  dept: string; date: string; grade: string; prof: string;
  ddat: number; pol: number; title: string; floor: number | null; ceil: number | null; mid: number;
}

/**
 * Grades that are excluded from any figure described as "SCS".
 * Contract rule 6: `Below SCS` is real published data and is kept in the
 * corpus, but military ranks, own-scale specialists and unclassifiable rows
 * are not Senior Civil Service and must not be counted as such.
 */
export const NON_SCS_GRADES = ['Below SCS', 'Military (OF-6+)', 'Specialist (own scale)', 'Other / Not stated'];

export async function loadData(base = './data/'): Promise<DataSet> {
  // FIRST PAINT: exactly two files.
  const [file, core] = await Promise.all([
    fetchJson<MetaFile>(base + 'meta.json'),
    fetchJson<CubeFile>(base + 'cube-core.json'),
  ]);

  // Built, not mutated in place: `fetchJson` caches the parsed body, so a second
  // loadData() would otherwise be handed a meta whose snapshot block had already
  // been replaced by the decoded array and decode it a second time.
  const meta: Meta = {
    ...file,
    snapshots: decodeSnapshots(file.snapshots, file.orgs, file.confidences),
    // legacy aliases so the pre-rebuild tabs keep compiling
    stats: { ...file.stats, departments: file.stats.orgs },
    depts: file.orgs.map((o) => ({ id: o.id, name: o.name, family: o.family, slugs: [] })),
  };

  const orgIdx = new Map(meta.orgs.map((o, i) => [o.id, i]));
  const { descendants, ancestors } = lineageClosure(meta.orgs, orgIdx);
  const scsGrades = meta.grades.map((g, i) => [g, i] as const)
    .filter(([g]) => !NON_SCS_GRADES.includes(g))
    .map(([, i]) => i);

  const snapshotAt = new Map<string, Snapshot>();
  for (const s of meta.snapshots) snapshotAt.set(s.org + '|' + s.d, s);

  const ds: DataSet = {
    base, meta, binWidth: meta.binWidth,
    core: decodeCube(core),
    layers: { coreB: null, prof: null, profB: null },
    orgIdx, descendants, ancestors, scsGrades, snapshotAt,
    periodCache: new Map(),
    periods: [],
    notable: [],
  };
  ds.periods = periodIndex(ds, DEFAULT_GRAIN).periods.map((p) => p.label);
  return ds;
}

/** Load one lazy cube layer. Cached; concurrent callers share one request. */
export async function ensureLayer(ds: DataSet, layer: LayerName): Promise<CubeView> {
  const have = ds.layers[layer];
  if (have) return have;
  const file = await fetchJson<CubeFile>(ds.base + LAYER_FILE[layer]);
  const view = decodeCube(file);
  ds.layers[layer] = view;
  return view;
}

/** Load whatever `filter`/`dimension` needs before calling `series()`. */
export async function ensureFor(ds: DataSet, filter: Filter, dimension: Dimension = 'none'): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const wantB = (filter.tier ?? 'A') === 'AB';
  const wantProf = needsProf(filter, dimension);
  if (wantProf) jobs.push(ensureLayer(ds, 'prof'));
  if (wantB) jobs.push(ensureLayer(ds, wantProf ? 'profB' : 'coreB'));
  await Promise.all(jobs);
}

/** True when the profession cube is required — prof/DDaT/policy are not in core. */
export function needsProf(filter: Filter, dimension: Dimension): boolean {
  return dimension === 'profession' || dimension === 'ddatPolicy'
    || !!(filter.profs && filter.profs.size)
    || filter.ddat != null || filter.policy != null;
}

export const loadChangelog = (ds: DataSet) => fetchJson<ChangelogEntry[]>(ds.base + 'changelog.json');
export const loadHighEarners = (ds: DataSet) => fetchJson<HighEarners>(ds.base + 'highearners.json');
export const loadUkgwa = (ds: DataSet) => fetchJson<Ukgwa>(ds.base + 'ukgwa.json');
export const loadSsrbGap = (ds: DataSet) => fetchJson<SsrbGap>(ds.base + 'ssrb-gap.json');

export interface ChangelogEntry {
  run: string; gitSha: string; scope: Scope;
  snapshotsBefore: number; snapshotsAfter: number;
  postsBefore: number; postsAfter: number;
  orgsBefore: number; orgsAfter: number;
  datesAdded: string[];
  filesOk: number; filesFail: number; undatedSkipped: number;
  cpihSource: string; cacheMode: string; cubeCells: number; warnings: string[];
}

/** Loose shapes: section 9 and 11 are consumed by the Method beats, not here. */
export interface HighEarners {
  schema: number; generated: string; scope: unknown;
  /** the publication's own licence string — render it on the mark, per 10.2 */
  licence: string;
  note: string;
  orgTypeNote: string;
  sources: unknown[]; thresholdChange: unknown; orgTypes: string[]; grades: string[];
  payKinds: string[]; dict: Record<string, string[]>; editions: unknown[];
  series: unknown[]; gaps: unknown[]; breaks: unknown[]; attachments: unknown[];
  rows: { n: number; cols: string[]; data: Record<string, (number | null)[]> };
  stats: unknown; warnings: string[];
}
/** scripts/ssrb-corpus.mjs — the market-gap charts, parsed from the PDFs. */
export interface SsrbGapReading { edition: number; page: number; figureNo: string; pct: number }
export interface SsrbRestatement {
  band: string; sector: string; year: number;
  readings: SsrbGapReading[];
  spreadPoints: number;
}
export interface SsrbGap {
  schema: number; purpose: string; licence: string; caveats: string[];
  editions: { year: number; title: string; page: string; pdf: string; pages: number }[];
  editionsWithoutTheFigure: number[];
  restatements: SsrbRestatement[];
  figures: {
    edition: number; page: number; figureNo: string; caption: string;
    source: string | null; note: string | null; breakAt: number;
    points: { series: string; year: number; pct: number }[];
    unattributed: unknown[]; complete: boolean;
    provenance: { pdf: string | null; publicUpdatedAt: string | null; extraction: string; blockSha: string };
  }[];
}
export interface Ukgwa {
  schema: number; generated: string; purpose: string; source: unknown;
  summary: Record<string, unknown>; recovered: unknown[]; unrecovered: unknown[];
  reasons: Record<string, string>; caveat: string; warnings: string[];
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

function lineageClosure(orgs: Org[], idx: Map<string, number>) {
  const n = orgs.length;
  const succ: number[][] = orgs.map((o) => o.successors.map((s) => idx.get(s)).filter((i): i is number => i != null));
  const pred: number[][] = orgs.map((o) => o.predecessors.map((s) => idx.get(s)).filter((i): i is number => i != null));
  const close = (edges: number[][]) => {
    const out: Set<number>[] = [];
    for (let i = 0; i < n; i++) {
      const seen = new Set<number>();
      const stack = [...edges[i]];
      while (stack.length) {
        const j = stack.pop()!;
        if (seen.has(j)) continue;
        seen.add(j);
        for (const k of edges[j]) if (!seen.has(k)) stack.push(k);
      }
      out.push(seen);
    }
    return out;
  };
  return { descendants: close(succ), ancestors: close(pred) };
}

// ---------------------------------------------------------------------------
// Periods
//
// The retired H1/H2 bucket is gone. It made 143 of 537 snapshots unreachable
// by any query and, because it kept the LATEST filing in a bucket rather than
// the most complete one, in 42 department-periods the smaller file won.
//
// Replacement: a selectable grain (quarter by default), and within a period
// the most complete filing wins — most published headcount, ties to the later
// date. Every snapshot that was not chosen is counted and reported, so
// "unreachable" is a number on the page rather than a silence.
// ---------------------------------------------------------------------------

export type Grain = 'date' | 'quarter' | 'half' | 'year';
export const DEFAULT_GRAIN: Grain = 'quarter';

export interface Period { key: string; label: string; end: string; year: number; dates: number[] }

export interface PeriodIndex {
  grain: Grain;
  periods: Period[];
  /** dateIdx -> periodIdx */
  periodOfDate: Int32Array;
  /** [orgIdx][periodIdx] -> chosen dateIdx, or -1 */
  chosen: Int32Array[];
  /** snapshots that exist but are not the chosen filing for their period */
  droppedSnapshots: { org: string; date: string; chosen: string }[];
}

const QEND = ['03-31', '06-30', '09-30', '12-31'];

function periodOf(iso: string, grain: Grain): { key: string; label: string; end: string; year: number } {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  switch (grain) {
    case 'date':
      return { key: iso, label: iso, end: iso, year };
    case 'year':
      return { key: String(year), label: String(year), end: `${year}-12-31`, year };
    case 'half': {
      const h = month <= 6 ? 1 : 2;
      return { key: `${year}-H${h}`, label: `${year} H${h}`, end: `${year}-${h === 1 ? '06-30' : '12-31'}`, year };
    }
    default: {
      const q = Math.ceil(month / 3);
      return { key: `${year}-Q${q}`, label: `${year} Q${q}`, end: `${year}-${QEND[q - 1]}`, year };
    }
  }
}

export function periodIndex(ds: DataSet, grain: Grain = DEFAULT_GRAIN): PeriodIndex {
  const hit = ds.periodCache.get(grain);
  if (hit) return hit;

  const { meta } = ds;
  const byKey = new Map<string, Period>();
  const order: string[] = [];
  const dateKey: string[] = [];
  meta.dates.forEach((iso, i) => {
    const p = periodOf(iso, grain);
    dateKey[i] = p.key;
    let rec = byKey.get(p.key);
    if (!rec) {
      rec = { key: p.key, label: p.label, end: p.end, year: p.year, dates: [] };
      byKey.set(p.key, rec);
      order.push(p.key);
    }
    rec.dates.push(i);
  });
  const periods = order.map((k) => byKey.get(k)!).sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  const pIdx = new Map(periods.map((p, i) => [p.key, i]));
  const periodOfDate = new Int32Array(meta.dates.length);
  meta.dates.forEach((_, i) => { periodOfDate[i] = pIdx.get(dateKey[i])!; });

  // choose one filing per (org, period): most complete wins, ties to the later
  // date. Choosing "latest" alone is what let a 9-post partial filing displace
  // a 37-post one.
  const chosen: Int32Array[] = meta.orgs.map(() => new Int32Array(periods.length).fill(-1));
  const best: (Snapshot | null)[][] = meta.orgs.map(() => new Array(periods.length).fill(null));
  const contenders: Snapshot[][] = meta.orgs.map(() => []);
  for (const s of meta.snapshots) {
    const oi = ds.orgIdx.get(s.org);
    if (oi == null) continue;
    const p = periodOfDate[s.d];
    contenders[oi].push(s);
    const cur = best[oi][p];
    if (!cur || s.headcount > cur.headcount || (s.headcount === cur.headcount && s.d > cur.d)) {
      best[oi][p] = s;
      chosen[oi][p] = s.d;
    }
  }
  const droppedSnapshots: PeriodIndex['droppedSnapshots'] = [];
  meta.orgs.forEach((o, oi) => {
    for (const s of contenders[oi]) {
      const p = periodOfDate[s.d];
      if (chosen[oi][p] !== s.d) {
        droppedSnapshots.push({ org: o.id, date: meta.dates[s.d], chosen: meta.dates[chosen[oi][p]] });
      }
    }
  });

  const out: PeriodIndex = { grain, periods, periodOfDate, chosen, droppedSnapshots };
  ds.periodCache.set(grain, out);
  return out;
}

/** Was this organisation in existence on that date? `null` bounds are open. */
export function orgLiveAt(org: Org, iso: string): boolean {
  if (org.validFrom && iso < org.validFrom) return false;
  if (org.validTo && iso > org.validTo) return false;
  return true;
}

/**
 * Snapshots filed outside their organisation's own validity window — a
 * department filing after it was abolished, or before it existed. These are
 * real publications, not errors, and they are exactly where a predecessor and
 * a successor overlap. Method material.
 */
export function outOfWindowSnapshots(ds: DataSet): { org: string; date: string; validFrom: string | null; validTo: string | null }[] {
  const out: { org: string; date: string; validFrom: string | null; validTo: string | null }[] = [];
  for (const s of ds.meta.snapshots) {
    const oi = ds.orgIdx.get(s.org);
    if (oi == null) continue;
    const org = ds.meta.orgs[oi];
    const iso = ds.meta.dates[s.d];
    if (!orgLiveAt(org, iso)) out.push({ org: org.id, date: iso, validFrom: org.validFrom, validTo: org.validTo });
  }
  return out;
}

/** Organisations in existence across a whole date range. */
export function orgsLiveBetween(ds: DataSet, from: string, to: string): Org[] {
  return ds.meta.orgs.filter((o) => orgLiveAt(o, from) && orgLiveAt(o, to));
}

/** The snapshot record behind a drawn point — reference date, confidence, packages. */
export function snapshotFor(ds: DataSet, orgIdx: number, dateIdx: number): Snapshot | null {
  const org = ds.meta.orgs[orgIdx];
  if (!org || dateIdx < 0) return null;
  return ds.snapshotAt.get(org.id + '|' + dateIdx) ?? null;
}

// ---------------------------------------------------------------------------
// Query surface
// ---------------------------------------------------------------------------

export type Measure =
  // banded pay statistics — these return BOUNDS, never a point
  | 'medianPay' | 'p10' | 'p25' | 'p75' | 'p90' | 'meanPay' | 'paybill'
  // counts and rates, computed on the full published population
  | 'headcount' | 'fte' | 'disclosureRate' | 'disclosed' | 'withheld'
  | 'vacant' | 'eliminated' | 'openBand' | 'posts' | 'fteKnownRate'
  // legacy names kept so the pre-rebuild tabs still compile
  | 'medianPost' | 'meanPost' | 'meanFTE';

export type Dimension =
  | 'none' | 'department' | 'organisation' | 'profession' | 'grade'
  | 'ddatPolicy' | 'family' | 'tier';

export type Disclosure = 'all' | 'disclosed' | 'withheld';

export interface Filter {
  /** organisation indices into meta.orgs; null/empty = every org in the tier */
  orgs?: Set<number> | null;
  profs?: Set<number> | null;
  grades?: Set<number> | null;
  ddat?: boolean | null;
  policy?: boolean | null;
  /** 'A' = the SCS spine (default). 'AB' also loads Tier B, kept in its own groups. */
  tier?: 'A' | 'AB';
  /** default true: drop Below SCS, military, own-scale specialists, unclassified */
  scsOnly?: boolean;
  disclosure?: Disclosure;
  /** project the disclosed pay distribution onto the published grade mix */
  reweight?: boolean;
  /** restrict to organisations present in every period of the range.
   *  undefined = apply automatically to cross-period, org-pooling aggregates. */
  constantScope?: boolean;
  grain?: Grain;
  /** inclusive [from, to] period indices at the active grain */
  periodRange?: [number, number];
  realTerms?: boolean;
  baseYear?: number;
  nFloor?: number;
  /** @deprecated legacy alias for `orgs` */
  depts?: Set<number> | null;
}

/** A pay figure. The truth is somewhere in [lo, hi]; the data cannot say where. */
export interface Band { lo: number; hi: number }

export const N_FLOOR = 30;
/** Below the floor a series must not be drawn as a trend. */
export const isThin = (n: number, floor = N_FLOOR) => n < floor;

/**
 * "Is this too thin to draw?" — the whole-series answer. True when every
 * period that has any data is below the floor, i.e. the chart would be a
 * confident line over a handful of posts.
 */
export function tooThinToDraw(g: { n: number[]; headcount: number[]; thin: boolean[] }): boolean {
  let any = false;
  for (let i = 0; i < g.n.length; i++) {
    if (g.headcount[i] === 0) continue;
    any = true;
    if (!g.thin[i]) return false;
  }
  return any;
}

/** The largest sample the series ever rests on — good copy for a limits strip. */
export const peakN = (g: { n: number[] }) => g.n.reduce((a, b) => Math.max(a, b), 0);

export interface SeriesGroup {
  key: string;
  label: string;
  /** point values for count/rate measures; all null when `banded` is true */
  values: (number | null)[];
  /** lower bound per period — banded measures only */
  lo: (number | null)[];
  /** upper bound per period — banded measures only */
  hi: (number | null)[];
  /** the sample the measure actually rests on (banded posts for pay, headcount for counts) */
  n: number[];
  headcount: number[];
  disclosureRate: (number | null)[];
  /** true where n is below the floor: do not draw a trend through it */
  thin: boolean[];
  /** organisations that actually filed in this period for this group */
  orgsFiled: number[];
}

export interface SeriesNotes {
  grain: Grain;
  measure: Measure;
  banded: boolean;
  nFloor: number;
  tier: 'A' | 'AB';
  tierSplit: boolean;
  scsOnly: boolean;
  disclosure: Disclosure;
  reweighted: boolean;
  /** share of published headcount the reweighting could cover, per period */
  reweightCoverage: (number | null)[];
  constantScope: boolean;
  constantScopeRequested: boolean;
  constantScopeFellBack: boolean;
  scopeOrgs: string[];
  excludedForScope: string[];
  lineageDrops: { period: string; dropped: string; keptWith: string[] }[];
  droppedSnapshots: number;
  realTerms: boolean;
  baseYear: number | null;
  /** years with no published CPIH row — left nominal, never extrapolated */
  nominalYears: number[];
  cpihWarning: string | null;
  caveats: string[];
}

export interface SeriesResult {
  periods: string[];
  periodKeys: string[];
  periodEnds: string[];
  groups: SeriesGroup[];
  notes: SeriesNotes;
}

const BANDED: Measure[] = ['medianPay', 'p10', 'p25', 'p75', 'p90', 'meanPay', 'paybill', 'medianPost', 'meanPost', 'meanFTE'];
export const isBandedMeasure = (m: Measure) => BANDED.includes(m);

const QUANTILE: Partial<Record<Measure, number>> = {
  medianPay: 0.5, medianPost: 0.5, p10: 0.1, p25: 0.25, p75: 0.75, p90: 0.9,
};

/** Money measures are deflated when real terms is on; counts and rates are not. */
const MONETARY: Measure[] = ['medianPay', 'p10', 'p25', 'p75', 'p90', 'meanPay', 'paybill', 'medianPost', 'meanPost', 'meanFTE'];

interface GradeAcc { headcount: number; nBanded: number; floor: Map<number, number>; ceil: Map<number, number> }

interface Acc {
  nDisc: number; nBanded: number; withheld: number; vacant: number; elim: number; openBand: number;
  fteSum: number; fteKnown: number; fteBanded: number;
  sumFloor: number; sumCeil: number; billLow: number; billHigh: number;
  floor: Map<number, number>; ceil: Map<number, number>;
  byGrade: Map<number, GradeAcc> | null;
  orgs: Set<number>;
}

function emptyAcc(withGrade: boolean): Acc {
  return {
    nDisc: 0, nBanded: 0, withheld: 0, vacant: 0, elim: 0, openBand: 0,
    fteSum: 0, fteKnown: 0, fteBanded: 0,
    sumFloor: 0, sumCeil: 0, billLow: 0, billHigh: 0,
    floor: new Map(), ceil: new Map(),
    byGrade: withGrade ? new Map() : null,
    orgs: new Set(),
  };
}

const bump = (m: Map<number, number>, k: number, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** q-quantile of a weighted bin histogram. Returns the bin, not a value. */
function quantileBin(hist: Map<number, number>, total: number, q: number): number | null {
  if (!(total > 0) || hist.size === 0) return null;
  const bins = [...hist.keys()].sort((a, b) => a - b);
  const target = q * total;
  let cum = 0;
  for (const b of bins) {
    cum += hist.get(b)!;
    if (cum >= target) return b;
  }
  return bins[bins.length - 1];
}

/**
 * The q-th percentile as bounds.
 *
 * Every disclosed post sits in [floor, ceiling]. Order statistics are monotone
 * under pointwise domination, so the q-quantile of the floors is a true lower
 * bound on the q-quantile of the unobserved salaries, and the q-quantile of
 * the ceilings is a true upper bound. Anything narrower would be invention.
 */
function percentileBand(floor: Map<number, number>, ceil: Map<number, number>, total: number, q: number, BIN: number): Band | null {
  const lo = quantileBin(floor, total, q);
  const hi = quantileBin(ceil, total, q);
  if (lo == null || hi == null) return null;
  return { lo: lo * BIN, hi: hi * BIN + BIN - 1 };
}

/**
 * Grade-reweighted histograms: each grade's disclosed band distribution
 * normalised and rescaled to that grade's share of the PUBLISHED headcount.
 *
 * Disclosure runs from about 20-25% at SCS1 to 93-96% at SCS2 and above, so an
 * unweighted median over the disclosed subset is a median of a different,
 * more senior population. `coverage` is the share of published headcount whose
 * grade had at least one disclosed band; below 1 the projection is partial and
 * must be said so.
 */
function reweight(acc: Acc): { floor: Map<number, number>; ceil: Map<number, number>; total: number; coverage: number } {
  const floor = new Map<number, number>();
  const ceil = new Map<number, number>();
  if (!acc.byGrade) return { floor, ceil, total: 0, coverage: 0 };
  let published = 0, covered = 0;
  for (const g of acc.byGrade.values()) published += g.headcount;
  if (!(published > 0)) return { floor, ceil, total: 0, coverage: 0 };
  for (const g of acc.byGrade.values()) {
    if (!(g.nBanded > 0) || !(g.headcount > 0)) continue;
    covered += g.headcount;
    const w = g.headcount / g.nBanded;
    for (const [b, c] of g.floor) bump(floor, b, c * w);
    for (const [b, c] of g.ceil) bump(ceil, b, c * w);
  }
  return { floor, ceil, total: covered, coverage: covered / published };
}

function dimensionPoolsOrgs(d: Dimension): boolean {
  return d !== 'department' && d !== 'organisation';
}

function cubesFor(ds: DataSet, filter: Filter, dimension: Dimension): CubeView[] {
  const wantProf = needsProf(filter, dimension);
  const wantB = (filter.tier ?? 'A') === 'AB';
  const out: CubeView[] = [];
  if (wantProf) {
    const p = ds.layers.prof;
    if (!p) throw new Error('cube-prof.json is not loaded — await ensureFor(ds, filter, dimension) first');
    out.push(p);
    if (wantB) {
      const pb = ds.layers.profB;
      if (!pb) throw new Error('cube-prof-b.json is not loaded — await ensureFor(ds, filter, dimension) first');
      out.push(pb);
    }
  } else {
    out.push(ds.core);
    if (wantB) {
      const cb = ds.layers.coreB;
      if (!cb) throw new Error('cube-core-b.json is not loaded — await ensureFor(ds, filter, dimension) first');
      out.push(cb);
    }
  }
  return out;
}

/**
 * The core query: one value per period, optionally split into groups.
 *
 * Pay measures come back as bounds in `lo`/`hi` with `values` null throughout —
 * there is no midpoint in this data, so a caller that wants a single line is
 * asking for a number nobody published.
 */
export function series(ds: DataSet, filter: Filter, measure: Measure, dimension: Dimension = 'none'): SeriesResult {
  const grain = filter.grain ?? DEFAULT_GRAIN;
  const pi = periodIndex(ds, grain);
  const nP = pi.periods.length;
  const BIN = ds.binWidth;
  const banded = isBandedMeasure(measure);
  const nFloor = filter.nFloor ?? N_FLOOR;
  const tier = filter.tier ?? 'A';
  const scsOnly = filter.scsOnly !== false;
  const disclosure: Disclosure = filter.disclosure ?? 'all';
  const wantReweight = !!filter.reweight && banded;
  const caveats: string[] = [];

  const range: [number, number] = filter.periodRange ?? [0, nP - 1];
  const inRange = (p: number) => p >= range[0] && p <= range[1];

  // ---- organisation scope -------------------------------------------------
  const selected = (filter.orgs && filter.orgs.size ? filter.orgs : null)
    ?? (filter.depts && filter.depts.size ? filter.depts : null);
  const tierOk = (o: Org) => (tier === 'AB' ? true : o.tier === 'A');
  let scope: number[] = [];
  ds.meta.orgs.forEach((o, i) => {
    if (!tierOk(o)) return;
    if (selected && !selected.has(i)) return;
    scope.push(i);
  });

  const pooling = dimensionPoolsOrgs(dimension);
  const crossPeriod = range[1] > range[0];
  const constantScopeRequested = filter.constantScope === true;
  let constantScope = filter.constantScope ?? (pooling && crossPeriod);
  let constantScopeFellBack = false;
  let excludedForScope: string[] = [];

  if (constantScope) {
    const kept = scope.filter((oi) => {
      for (let p = range[0]; p <= range[1]; p++) if (pi.chosen[oi][p] < 0) return false;
      return true;
    });
    if (kept.length === 0 && !constantScopeRequested) {
      // Auto-applied only. Falling back silently would be a lie; falling back
      // loudly keeps the default view drawable and puts the fact on the page.
      constantScope = false;
      constantScopeFellBack = true;
      caveats.push('No organisation filed in every period of this range, so the constant-scope basis was not applied. The composition of any total therefore changes between periods.');
    } else {
      excludedForScope = scope.filter((oi) => !kept.includes(oi)).map((oi) => ds.meta.orgs[oi].id);
      scope = kept;
      if (kept.length === 0) {
        caveats.push('No organisation filed in every period of this range, so a constant scope does not exist for it. Narrow the range or coarsen the period before reading a total.');
      } else if (excludedForScope.length) {
        caveats.push(`Constant scope: ${kept.length} organisation${kept.length === 1 ? '' : 's'} filed in every period of this range; ${excludedForScope.length} others are excluded from every period so the composition cannot change underneath the series.`);
      }
    }
  }
  const inScope = new Set(scope);

  // ---- lineage: never sum a predecessor with its own successor -------------
  const lineageDrops: SeriesNotes['lineageDrops'] = [];
  const excludedAt: (Set<number> | null)[] = new Array(nP).fill(null);
  if (pooling) {
    for (let p = 0; p < nP; p++) {
      if (!inRange(p)) continue;
      const filed = scope.filter((oi) => pi.chosen[oi][p] >= 0);
      if (filed.length < 2) continue;
      const filedSet = new Set(filed);
      const end = pi.periods[p].end;
      for (const oi of filed) {
        const kids = [...ds.descendants[oi]].filter((k) => filedSet.has(k));
        if (!kids.length) continue;
        // Which of the two existed at the end of this period decides which one
        // is the double count. Normally the successor: a department's final
        // filing overlaps its successors' first. Where the successors are not
        // yet in existence it is the other way round.
        const parentLive = orgLiveAt(ds.meta.orgs[oi], end);
        const kidsLive = kids.filter((k) => orgLiveAt(ds.meta.orgs[k], end));
        const drop = parentLive && kidsLive.length === 0 ? kids : [oi];
        const keptWith = parentLive && kidsLive.length === 0 ? [ds.meta.orgs[oi].id] : kids.map((k) => ds.meta.orgs[k].id);
        for (const dropIdx of drop) {
          (excludedAt[p] ??= new Set()).add(dropIdx);
          lineageDrops.push({ period: pi.periods[p].label, dropped: ds.meta.orgs[dropIdx].id, keptWith });
        }
      }
    }
  }

  // ---- accumulate ---------------------------------------------------------
  const groupIdx = new Map<string, number>();
  const groupMeta: { key: string; label: string }[] = [];
  const cells: Acc[][] = [];
  const ensureGroup = (key: string, label: string) => {
    let gi = groupIdx.get(key);
    if (gi === undefined) {
      gi = groupMeta.length;
      groupIdx.set(key, gi);
      groupMeta.push({ key, label });
      cells.push(Array.from({ length: nP }, () => emptyAcc(wantReweight)));
    }
    return gi;
  };

  const tierSplit = tier === 'AB' && pooling;
  const profFilter = filter.profs && filter.profs.size ? filter.profs : null;
  const gradeFilter = filter.grades && filter.grades.size ? filter.grades : null;
  const scsSet = new Set(ds.scsGrades);

  for (const cube of cubesFor(ds, filter, dimension)) {
    const isB = cube.tier === 'B';
    for (let i = 0; i < cube.n; i++) {
      const oi = cube.org[i];
      if (!inScope.has(oi)) continue;
      const d = cube.date[i];
      const p = pi.periodOfDate[d];
      if (!inRange(p)) continue;
      if (pi.chosen[oi][p] !== d) continue;               // one filing per org per period
      if (excludedAt[p]?.has(oi)) continue;               // predecessor + successor refusal

      const grade = cube.grade[i];
      if (scsOnly && !scsSet.has(grade)) continue;
      if (gradeFilter && !gradeFilter.has(grade)) continue;
      if (profFilter && !profFilter.has(cube.prof[i])) continue;
      if (filter.ddat === true && !cube.ddat[i]) continue;
      if (filter.ddat === false && cube.ddat[i]) continue;
      if (filter.policy === true && !cube.pol[i]) continue;
      if (filter.policy === false && cube.pol[i]) continue;

      const lo = cube.binLow[i];
      if (disclosure === 'disclosed' && lo < 0) continue;
      if (disclosure === 'withheld' && lo !== BIN_WITHHELD) continue;

      let key: string, label: string;
      switch (dimension) {
        case 'department': case 'organisation': {
          const o = ds.meta.orgs[oi]; key = o.id; label = o.name; break;
        }
        case 'profession': {
          const pf = cube.prof[i]; key = 'p' + pf; label = ds.meta.profs[pf] ?? 'Not stated'; break;
        }
        case 'grade': key = 'g' + grade; label = ds.meta.grades[grade] ?? '—'; break;
        case 'ddatPolicy':
          if (cube.ddat[i]) { key = 'ddat'; label = 'DDaT roles'; }
          else if (cube.pol[i]) { key = 'policy'; label = 'Policy roles'; }
          else { key = 'other'; label = 'Other roles'; }
          break;
        case 'family': { const o = ds.meta.orgs[oi]; key = 'f' + o.family; label = o.family; break; }
        case 'tier': key = 't' + cube.tier; label = cube.tier === 'A' ? 'Tier A (SCS)' : 'Tier B (SCS-equivalent)'; break;
        default: key = 'all'; label = 'All'; break;
      }
      if (tierSplit && dimension !== 'tier') {
        key += '|' + cube.tier;
        if (isB) label += ' (Tier B)';
      }

      const acc = cells[ensureGroup(key, label)][p];
      acc.orgs.add(oi);

      const nd = cube.nDisc[i], w = cube.withheld[i];
      acc.nDisc += nd;
      acc.withheld += w;
      acc.vacant += cube.vacant[i];
      acc.elim += cube.elim[i];
      acc.fteSum += cube.fteSum[i];
      acc.fteKnown += cube.fteKnown[i];

      if (lo === BIN_OPEN) acc.openBand += nd;

      let gacc: GradeAcc | undefined;
      if (acc.byGrade) {
        gacc = acc.byGrade.get(grade);
        if (!gacc) { gacc = { headcount: 0, nBanded: 0, floor: new Map(), ceil: new Map() }; acc.byGrade.set(grade, gacc); }
        gacc.headcount += nd + w;
      }

      if (lo >= 0) {
        // banded, disclosed — the only cells a pay statistic may read
        acc.nBanded += nd;
        acc.fteBanded += cube.fteSum[i];
        acc.sumFloor += cube.sumFloor[i];
        acc.sumCeil += cube.sumCeil[i];
        acc.billLow += cube.billLow[i];
        acc.billHigh += cube.billHigh[i];
        bump(acc.floor, lo, nd);
        bump(acc.ceil, cube.binHigh[i], nd);
        if (gacc) {
          gacc.nBanded += nd;
          bump(gacc.floor, lo, nd);
          bump(gacc.ceil, cube.binHigh[i], nd);
        }
      }
    }
  }

  // ---- CPIH ---------------------------------------------------------------
  const cpih = ds.meta.cpih.index;
  const cpihYears = Object.keys(cpih).map(Number).sort((a, b) => a - b);
  const baseYear = filter.baseYear ?? (cpihYears.length ? cpihYears[cpihYears.length - 1] : null);
  const baseIdx = baseYear != null ? cpih[String(baseYear)] : undefined;
  const nominalYears = new Set<number>();
  const deflatorFor = (year: number): number => {
    if (!filter.realTerms || baseIdx == null) return 1;
    const v = cpih[String(year)];
    if (v == null) {
      // There is no 2026 annual CPIH and there will not be one until ONS
      // publishes it. Carrying the previous year forward would be a fabricated
      // index on a page whose whole claim is provenance. Leave it nominal.
      nominalYears.add(year);
      return 1;
    }
    return baseIdx / v;
  };
  if (filter.realTerms && ds.meta.cpih.live === false && ds.meta.cpih.warning) caveats.push(ds.meta.cpih.warning);

  // ---- read the measure off each cell -------------------------------------
  const q = QUANTILE[measure];
  const monetary = MONETARY.includes(measure);
  const reweightCoverage: (number | null)[] = new Array(nP).fill(null);
  if (measure === 'meanFTE') {
    caveats.push('Mean pay per FTE divides an FTE-weighted pay bill (vacant posts removed) by the FTE of every banded post including vacancies; the cube carries no FTE for the non-vacant disclosed subset alone. Treat it as indicative.');
  }

  const groups: SeriesGroup[] = groupMeta.map((gm, gi) => {
    const values: (number | null)[] = new Array(nP).fill(null);
    const lo: (number | null)[] = new Array(nP).fill(null);
    const hi: (number | null)[] = new Array(nP).fill(null);
    const n: number[] = new Array(nP).fill(0);
    const headcount: number[] = new Array(nP).fill(0);
    const disclosureRate: (number | null)[] = new Array(nP).fill(null);
    const thin: boolean[] = new Array(nP).fill(true);
    const orgsFiled: number[] = new Array(nP).fill(0);

    for (let p = 0; p < nP; p++) {
      const a = cells[gi][p];
      const hc = a.nDisc + a.withheld;
      headcount[p] = hc;
      orgsFiled[p] = a.orgs.size;
      disclosureRate[p] = hc > 0 ? a.nDisc / hc : null;
      if (hc === 0 && a.elim === 0) continue;

      let payFloor = a.floor, payCeil = a.ceil, payTotal = a.nBanded;
      if (wantReweight) {
        const rw = reweight(a);
        reweightCoverage[p] = rw.coverage || null;
        if (rw.total > 0) { payFloor = rw.floor; payCeil = rw.ceil; payTotal = rw.total; }
      }

      const sample = banded ? a.nBanded : hc;
      n[p] = sample;
      thin[p] = isThin(sample, nFloor);

      const defl = deflatorFor(pi.periods[p].year);
      const money = (x: number) => (monetary ? x * defl : x);

      if (q != null) {
        const b = percentileBand(payFloor, payCeil, payTotal, q, BIN);
        if (b) { lo[p] = money(b.lo); hi[p] = money(b.hi); }
      } else switch (measure) {
        case 'meanPay': case 'meanPost':
          if (a.nBanded > 0) { lo[p] = money(a.sumFloor / a.nBanded); hi[p] = money(a.sumCeil / a.nBanded); }
          break;
        case 'meanFTE':
          if (a.fteBanded > 0) { lo[p] = money(a.billLow / a.fteBanded); hi[p] = money(a.billHigh / a.fteBanded); }
          break;
        case 'paybill':
          if (a.nBanded > 0) { lo[p] = money(a.billLow); hi[p] = money(a.billHigh); }
          break;
        case 'headcount': values[p] = hc; break;
        case 'posts': values[p] = hc + a.elim; break;
        case 'fte': values[p] = Math.round(a.fteSum * 10) / 10; break;
        case 'fteKnownRate': values[p] = hc > 0 ? a.fteKnown / hc : null; break;
        case 'disclosureRate': values[p] = disclosureRate[p]; break;
        case 'disclosed': values[p] = a.nDisc; break;
        case 'withheld': values[p] = a.withheld; break;
        case 'vacant': values[p] = a.vacant; break;
        case 'eliminated': values[p] = a.elim; break;
        case 'openBand': values[p] = a.openBand; break;
      }
    }
    return { key: gm.key, label: gm.label, values, lo, hi, n, headcount, disclosureRate, thin, orgsFiled };
  });

  const notes: SeriesNotes = {
    grain, measure, banded, nFloor, tier, tierSplit, scsOnly, disclosure,
    reweighted: wantReweight, reweightCoverage,
    constantScope, constantScopeRequested, constantScopeFellBack,
    scopeOrgs: scope.map((i) => ds.meta.orgs[i].id),
    excludedForScope,
    lineageDrops,
    droppedSnapshots: pi.droppedSnapshots.length,
    realTerms: !!filter.realTerms,
    baseYear: filter.realTerms ? baseYear : null,
    nominalYears: [...nominalYears].sort((a, b) => a - b),
    cpihWarning: ds.meta.cpih.warning,
    caveats,
  };

  return {
    periods: pi.periods.map((p) => p.label),
    periodKeys: pi.periods.map((p) => p.key),
    periodEnds: pi.periods.map((p) => p.end),
    groups,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Threshold counts — a range, never a number
// ---------------------------------------------------------------------------

export interface AboveResult {
  periods: string[];
  /** pay floor at or above the threshold: certainly above */
  certain: number[];
  /** pay ceiling at or above the threshold: possibly above */
  possible: number[];
  /** banded disclosed posts in scope */
  total: number[];
  notes: SeriesNotes;
  /** @deprecated alias of `certain`, kept for the pre-rebuild tabs */
  above: number[];
}

/**
 * Posts paid above a threshold, as [certain, possible].
 *
 * A £145,000-£149,999 band and a £150,000-£154,999 band sit either side of a
 * line the data cannot resolve, so "posts over £150k" is a range. Anything
 * else needs a midpoint, and there is no midpoint in this data.
 */
export function countAbove(ds: DataSet, filter: Filter, threshold: (periodIdx: number, res: SeriesResult) => number): AboveResult {
  const grain = filter.grain ?? DEFAULT_GRAIN;
  const pi = periodIndex(ds, grain);
  const BIN = ds.binWidth;

  // Reuse series() for scope, lineage, snapshot choice and notes, then walk the
  // cube again for the histogram — the accumulated bins are private to series().
  const base = series(ds, { ...filter, disclosure: 'disclosed' }, 'headcount', 'none');
  const nP = pi.periods.length;
  const certain = new Array(nP).fill(0);
  const possible = new Array(nP).fill(0);
  const total = new Array(nP).fill(0);

  const scope = new Set(base.notes.scopeOrgs.map((id) => ds.orgIdx.get(id)!).filter((i) => i != null));
  const scsSet = new Set(ds.scsGrades);
  const scsOnly = filter.scsOnly !== false;
  const profFilter = filter.profs && filter.profs.size ? filter.profs : null;
  const gradeFilter = filter.grades && filter.grades.size ? filter.grades : null;
  const range: [number, number] = filter.periodRange ?? [0, nP - 1];

  for (const cube of cubesFor(ds, filter, 'none')) {
    for (let i = 0; i < cube.n; i++) {
      const oi = cube.org[i];
      if (!scope.has(oi)) continue;
      const d = cube.date[i];
      const p = pi.periodOfDate[d];
      if (p < range[0] || p > range[1]) continue;
      if (pi.chosen[oi][p] !== d) continue;
      const lo = cube.binLow[i];
      if (lo < 0) continue;                                // no band, no threshold test
      const grade = cube.grade[i];
      if (scsOnly && !scsSet.has(grade)) continue;
      if (gradeFilter && !gradeFilter.has(grade)) continue;
      if (profFilter && !profFilter.has(cube.prof[i])) continue;
      if (filter.ddat === true && !cube.ddat[i]) continue;
      if (filter.ddat === false && cube.ddat[i]) continue;
      if (filter.policy === true && !cube.pol[i]) continue;
      if (filter.policy === false && cube.pol[i]) continue;

      const thr = threshold(p, base);
      const n = cube.nDisc[i];
      total[p] += n;
      if (lo * BIN >= thr) certain[p] += n;
      if (cube.binHigh[i] * BIN + BIN - 1 >= thr) possible[p] += n;
    }
  }
  return { periods: base.periods, certain, possible, total, notes: base.notes, above: certain };
}

// ---------------------------------------------------------------------------
// Small helpers the charts and KPI tiles want
// ---------------------------------------------------------------------------

/** The value of a non-banded measure in one period. Null for banded measures. */
export function snapshot(ds: DataSet, filter: Filter, measure: Measure, periodIdx: number): number | null {
  const r = series(ds, filter, measure, 'none');
  return r.groups[0]?.values[periodIdx] ?? null;
}

/** The bounds of a banded measure in one period. */
export function snapshotBand(ds: DataSet, filter: Filter, measure: Measure, periodIdx: number): Band | null {
  const r = series(ds, filter, measure, 'none');
  const g = r.groups[0];
  if (!g) return null;
  const lo = g.lo[periodIdx], hi = g.hi[periodIdx];
  return lo == null || hi == null ? null : { lo, hi };
}

/** The last period with data for any group. -1 when the result is empty. */
export function lastPopulatedIdx(res: SeriesResult): number {
  for (let p = res.periods.length - 1; p >= 0; p--) {
    for (const g of res.groups) if (g.headcount[p] > 0) return p;
  }
  return -1;
}
export function firstPopulatedIdx(res: SeriesResult): number {
  for (let p = 0; p < res.periods.length; p++) {
    for (const g of res.groups) if (g.headcount[p] > 0) return p;
  }
  return -1;
}

export const latestPeriodIdx = (ds: DataSet) => ds.periods.length - 1;

export function pctChange(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return (to - from) / from * 100;
}

/** Years between two periods of a result, from their end dates. */
export function yearsBetween(res: SeriesResult, i: number, j: number): number {
  const a = Date.parse(res.periodEnds[i]), b = Date.parse(res.periodEnds[j]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (b - a) / (365.2425 * 86400000);
}

/** Compound annual growth. `periodsPerYear` defaults to 2 for the old callers. */
export function cagr(from: number | null, to: number | null, periodsApart: number, periodsPerYear = 2): number | null {
  if (from == null || to == null || from <= 0 || to <= 0 || periodsApart <= 0) return null;
  const years = periodsApart / periodsPerYear;
  if (years <= 0) return null;
  return (Math.pow(to / from, 1 / years) - 1) * 100;
}

export function cagrOver(from: number | null, to: number | null, years: number): number | null {
  if (from == null || to == null || from <= 0 || to <= 0 || years <= 0) return null;
  return (Math.pow(to / from, 1 / years) - 1) * 100;
}

/** Format a band the way the study is allowed to state pay: as a range. */
export function bandText(b: Band | null, fmt: (n: number) => string): string {
  return b ? `${fmt(b.lo)}–${fmt(b.hi)}` : '—';
}
