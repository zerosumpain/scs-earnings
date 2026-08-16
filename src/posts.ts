// Post shards — public/data/posts/<orgId>.json, section 4 of the contract.
//
// One columnar, dictionary-encoded file per organisation, loaded lazily and
// only for the organisations actually asked for (the full set is ~15 MB raw).
//
// The retired notable.json rendered one row per snapshot per post, so the
// Cabinet Secretary appeared about twenty times and looked like twenty people.
// Everything here is grouped to a post identity first: a post appears once,
// with a pay trajectory.

import { fetchJson, NON_SCS_GRADES, type DataSet, type Band } from './data';

export interface PostShardFile {
  schema: number;
  org: string;
  n: number;
  cols: string[];
  dict: Record<string, string[]>;
  data: Record<string, (number | null)[]>;
}

export interface PostRow {
  org: string;
  dateIdx: number;
  date: string;
  pkg: string | null;
  /** the `Organisation` column INSIDE the CSV — where agency-level depth lives */
  suborg: string | null;
  unit: string | null;
  title: string;
  /** the grade string exactly as published */
  rawGrade: string | null;
  /** index into meta.grades */
  band: number;
  grade: string;
  /** SCS Band 1 London vs National, OF-6..OF-9, Parliamentary Counsel, ... */
  variant: string | null;
  rawProf: string | null;
  prof: number;
  profession: string;
  ddat: boolean;
  pol: boolean;
  status: string;
  disclosed: boolean;
  withheldReason: string | null;
  floor: number | null;
  ceil: number | null;
  /** null means unknown. Never 1.0 by assumption. */
  fte: number | null;
  costOfReports: number | null;
  region: string | null;
  /** Post Unique Reference, or null. XX / N/A / blank are absences, not ids. */
  pur: string | null;
  ordinal: number;
  reportsTo: string | null;
}

const shardCache = new Map<string, Promise<PostRow[]>>();

/** Decode one shard against meta. Dictionary index -1 always means absent. */
export function decodeShard(ds: DataSet, shard: PostShardFile): PostRow[] {
  const { meta } = ds;
  const col = (name: string) => shard.data[name] ?? [];
  const d = (name: string, v: number | null): string | null => {
    if (v == null || v < 0) return null;
    return shard.dict[name]?.[v] ?? null;
  };
  const date = col('date'), pkg = col('pkg'), suborg = col('suborg'), unit = col('unit');
  const title = col('title'), rawGrade = col('rawGrade'), band = col('band'), variant = col('variant');
  const rawProf = col('rawProf'), prof = col('prof'), ddat = col('ddat'), pol = col('pol');
  const status = col('status'), disclosed = col('disclosed'), withheld = col('withheld');
  const floor = col('floor'), ceil = col('ceil'), fte = col('fte'), cor = col('costOfReports');
  const region = col('region'), pur = col('pur'), ordinal = col('ordinal'), reportsTo = col('reportsTo');

  const out: PostRow[] = new Array(shard.n);
  for (let i = 0; i < shard.n; i++) {
    const di = date[i] ?? 0;
    const bi = band[i] ?? -1;
    const pi = prof[i] ?? -1;
    out[i] = {
      org: shard.org,
      dateIdx: di,
      date: meta.dates[di] ?? '',
      pkg: d('pkg', pkg[i]),
      suborg: d('suborg', suborg[i]),
      unit: d('unit', unit[i]),
      title: d('title', title[i]) ?? '',
      rawGrade: d('rawGrade', rawGrade[i]),
      band: bi,
      grade: meta.grades[bi] ?? 'Other / Not stated',
      variant: d('variant', variant[i]),
      rawProf: d('rawProf', rawProf[i]),
      prof: pi,
      profession: meta.profs[pi] ?? 'Not stated',
      ddat: ddat[i] === 1,
      pol: pol[i] === 1,
      status: meta.statuses[status[i] ?? -1] ?? 'blank',
      disclosed: disclosed[i] === 1,
      withheldReason: (withheld[i] ?? -1) >= 0 ? (meta.withheldReasons[withheld[i]!] ?? null) : null,
      floor: floor[i] ?? null,
      ceil: ceil[i] ?? null,
      fte: fte[i] ?? null,
      costOfReports: cor[i] ?? null,
      region: d('region', region[i]),
      pur: d('pur', pur[i]),
      ordinal: ordinal[i] ?? 0,
      reportsTo: d('pur', reportsTo[i]),
    };
  }
  return out;
}

/** Lazy, cached, one in-flight request per organisation. */
export function loadPosts(ds: DataSet, orgId: string): Promise<PostRow[]> {
  const hit = shardCache.get(orgId);
  if (hit) return hit;
  const p = fetchJson<PostShardFile>(`${ds.base}posts/${orgId}.json`)
    .then((shard) => decodeShard(ds, shard))
    .catch((e) => { shardCache.delete(orgId); throw e; });
  shardCache.set(orgId, p);
  return p;
}

/** Load several shards at a bounded concurrency; failures are reported, not swallowed. */
export async function loadPostsMany(ds: DataSet, orgIds: string[], concurrency = 4): Promise<{ rows: PostRow[]; failed: string[] }> {
  const rows: PostRow[] = [];
  const failed: string[] = [];
  const queue = [...new Set(orgIds)];
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try { rows.push(...await loadPosts(ds, id)); }
      catch { failed.push(id); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
  return { rows, failed };
}

export function isPostsLoaded(orgId: string): boolean { return shardCache.has(orgId); }
/** Test hook. */
export function resetPostsCache(): void { shardCache.clear(); }

// ---------------------------------------------------------------------------
// Grouping: one row per post, not one row per snapshot
// ---------------------------------------------------------------------------

export interface PostPoint {
  dateIdx: number;
  date: string;
  floor: number | null;
  ceil: number | null;
  disclosed: boolean;
  withheldReason: string | null;
  status: string;
  fte: number | null;
  band: number;
  grade: string;
  title: string;
  unit: string | null;
}

export interface PostGroup {
  key: string;
  org: string;
  /** 'pur' where the publisher gave a Post Unique Reference, 'title-unit' otherwise */
  identity: 'pur' | 'title-unit';
  pur: string | null;
  title: string;
  unit: string | null;
  suborg: string | null;
  band: number;
  grade: string;
  variant: string | null;
  prof: number;
  profession: string;
  ddat: boolean;
  pol: boolean;
  region: string | null;
  /** every snapshot this post appears in, ascending by reference date */
  points: PostPoint[];
  snapshots: number;
  first: PostPoint;
  last: PostPoint;
  /** points where a pay band was published */
  disclosedPoints: number;
  /** the most recent published band, or null if pay was never disclosed */
  latest: Band | null;
  latestDate: string | null;
  /** highest published ceiling and the floor beside it */
  peak: Band | null;
  peakDate: string | null;
}

/**
 * Group rows into posts.
 *
 * Identity is `(org, pur, title)` as briefed. Where the publisher gave no
 * usable PUR the key falls back to `(org, title, unit)` and says so, because
 * merging two posts that merely share a job title would invent a career.
 */
export function groupPosts(rows: PostRow[]): PostGroup[] {
  const byKey = new Map<string, PostRow[]>();
  for (const r of rows) {
    const key = r.pur
      ? `${r.org}|${r.pur}|${r.title}`
      : `${r.org}|~${r.title}|${r.unit ?? ''}`;
    const list = byKey.get(key);
    if (list) list.push(r); else byKey.set(key, [r]);
  }

  const out: PostGroup[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.dateIdx - b.dateIdx || a.ordinal - b.ordinal);
    const points: PostPoint[] = list.map((r) => ({
      dateIdx: r.dateIdx, date: r.date, floor: r.floor, ceil: r.ceil,
      disclosed: r.disclosed, withheldReason: r.withheldReason, status: r.status,
      fte: r.fte, band: r.band, grade: r.grade, title: r.title, unit: r.unit,
    }));
    const last = list[list.length - 1];
    const disclosedPts = points.filter((p) => p.disclosed && p.floor != null && p.ceil != null);
    const latestDisclosed = disclosedPts.length ? disclosedPts[disclosedPts.length - 1] : null;
    let peak: PostPoint | null = null;
    for (const p of disclosedPts) if (!peak || (p.ceil ?? 0) > (peak.ceil ?? 0)) peak = p;

    out.push({
      key,
      org: last.org,
      identity: last.pur ? 'pur' : 'title-unit',
      pur: last.pur,
      title: last.title,
      unit: last.unit,
      suborg: last.suborg,
      band: last.band,
      grade: last.grade,
      variant: last.variant,
      prof: last.prof,
      profession: last.profession,
      ddat: last.ddat,
      pol: last.pol,
      region: last.region,
      points,
      snapshots: points.length,
      first: points[0],
      last: points[points.length - 1],
      disclosedPoints: disclosedPts.length,
      latest: latestDisclosed ? { lo: latestDisclosed.floor!, hi: latestDisclosed.ceil! } : null,
      latestDate: latestDisclosed ? latestDisclosed.date : null,
      peak: peak ? { lo: peak.floor!, hi: peak.ceil! } : null,
      peakDate: peak ? peak.date : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search / filter — what the Top earners beat drives
// ---------------------------------------------------------------------------

export type PostSort = 'latestFloor' | 'latestCeil' | 'peakCeil' | 'snapshots' | 'title';

export interface PostQuery {
  /** free text over title, unit, sub-organisation and raw grade */
  text?: string;
  orgs?: string[] | null;
  bands?: number[] | null;
  profs?: number[] | null;
  ddat?: boolean | null;
  policy?: boolean | null;
  /** only posts whose pay was published at least once */
  disclosedOnly?: boolean;
  /** certainly at or above this floor */
  minFloor?: number;
  /** possibly at or above this ceiling */
  minCeil?: number;
  /** ISO reference dates, inclusive */
  from?: string;
  to?: string;
  /** drop Below SCS, military, own-scale specialists and unclassified rows */
  scsOnly?: boolean;
  /** exclude posts whose latest status is `eliminated` */
  liveOnly?: boolean;
  sort?: PostSort;
  limit?: number;
}

const norm = (s: string) => s.toLowerCase();

export function searchPosts(groups: PostGroup[], q: PostQuery = {}): PostGroup[] {
  const text = q.text ? norm(q.text).split(/\s+/).filter(Boolean) : [];
  const orgs = q.orgs && q.orgs.length ? new Set(q.orgs) : null;
  const bands = q.bands && q.bands.length ? new Set(q.bands) : null;
  const profs = q.profs && q.profs.length ? new Set(q.profs) : null;

  let out = groups.filter((g) => {
    if (orgs && !orgs.has(g.org)) return false;
    if (bands && !bands.has(g.band)) return false;
    if (profs && !profs.has(g.prof)) return false;
    if (q.ddat === true && !g.ddat) return false;
    if (q.ddat === false && g.ddat) return false;
    if (q.policy === true && !g.pol) return false;
    if (q.policy === false && g.pol) return false;
    if (q.scsOnly === true && NON_SCS_GRADES.includes(g.grade)) return false;
    if (q.disclosedOnly && !g.latest) return false;
    if (q.liveOnly && g.last.status === 'eliminated') return false;
    if (q.minFloor != null && !(g.latest && g.latest.lo >= q.minFloor)) return false;
    if (q.minCeil != null && !(g.latest && g.latest.hi >= q.minCeil)) return false;
    if (q.from && g.last.date < q.from) return false;
    if (q.to && g.first.date > q.to) return false;
    if (text.length) {
      const hay = norm([g.title, g.unit ?? '', g.suborg ?? '', g.grade, g.profession, g.org].join(' '));
      if (!text.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  const sort = q.sort ?? 'latestFloor';
  out = out.slice().sort((a, b) => {
    switch (sort) {
      case 'title': return a.title.localeCompare(b.title);
      case 'snapshots': return b.snapshots - a.snapshots;
      case 'peakCeil': return (b.peak?.hi ?? -1) - (a.peak?.hi ?? -1) || (b.peak?.lo ?? -1) - (a.peak?.lo ?? -1);
      case 'latestCeil': return (b.latest?.hi ?? -1) - (a.latest?.hi ?? -1) || (b.latest?.lo ?? -1) - (a.latest?.lo ?? -1);
      default: return (b.latest?.lo ?? -1) - (a.latest?.lo ?? -1) || (b.latest?.hi ?? -1) - (a.latest?.hi ?? -1);
    }
  });
  return q.limit != null ? out.slice(0, q.limit) : out;
}

/**
 * Highest-paid posts.
 *
 * Ranked on the published FLOOR — "certainly at least this much" — because
 * ranking on a midpoint would order posts by a number nobody published. Posts
 * sharing a band are genuinely tied and the caller should say so rather than
 * implying a first and a second.
 */
export function topEarners(groups: PostGroup[], opts: { limit?: number; at?: string; scsOnly?: boolean } = {}): PostGroup[] {
  return searchPosts(groups, {
    disclosedOnly: true,
    scsOnly: opts.scsOnly ?? true,
    from: opts.at,
    to: opts.at,
    sort: 'latestFloor',
    limit: opts.limit ?? 50,
  });
}

/** Posts that appear in enough snapshots to read a pay trajectory from. */
export function withTrajectory(groups: PostGroup[], minPoints = 3): PostGroup[] {
  return groups.filter((g) => g.disclosedPoints >= minPoints);
}

/**
 * The reports-to edges for one organisation and reference date, as an org
 * chart. 492 of 493 files carry the edge; the root is the post with no parent.
 */
export function orgChart(rows: PostRow[], date: string): { nodes: PostRow[]; edges: { from: string; to: string }[]; roots: PostRow[] } {
  const nodes = rows.filter((r) => r.date === date);
  const byPur = new Map<string, PostRow>();
  for (const r of nodes) if (r.pur) byPur.set(r.pur, r);
  const edges: { from: string; to: string }[] = [];
  const roots: PostRow[] = [];
  for (const r of nodes) {
    if (r.reportsTo && byPur.has(r.reportsTo) && r.pur) edges.push({ from: r.reportsTo, to: r.pur });
    else roots.push(r);
  }
  return { nodes, edges, roots };
}
