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
  /** The published post-holder's name, or null when the post is vacant,
   *  eliminated, redacted, or filed without one. */
  holder: string | null;
}

const shardCache = new Map<string, Promise<PostRow[]>>();

/** Decode one shard against meta. Dictionary index -1 always means absent. */
export function decodeShard(ds: DataSet, shard: PostShardFile): PostRow[] {
  const { meta } = ds;
  const col = (name: string) => shard.data[name] ?? [];
  const d = (name: string, v: number | null): string | null => {
    if (v == null || v < 0) return null;
    const dict = shard.dict[name];
    // A column with no dictionary keeps its interned integer: that is how `pur`
    // and `reportsTo` ship, because their strings are join keys nobody renders.
    // Identity and edges only need the values to be distinct, and they are.
    if (!dict) return String(v);
    return dict[v] ?? null;
  };
  const date = col('date'), pkg = col('pkg'), suborg = col('suborg'), unit = col('unit');
  const title = col('title'), rawGrade = col('rawGrade'), band = col('band'), variant = col('variant');
  const rawProf = col('rawProf'), prof = col('prof'), ddat = col('ddat'), pol = col('pol');
  const status = col('status'), disclosed = col('disclosed'), withheld = col('withheld');
  const floor = col('floor'), ceil = col('ceil'), fte = col('fte'), cor = col('costOfReports');
  const region = col('region'), pur = col('pur'), ordinal = col('ordinal'), reportsTo = col('reportsTo');
  const holder = col('holder');

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
      holder: d('holder', holder[i]),
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
  /** who held it at this filing, where published */
  holder: string | null;
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
  /** Every distinct published post-holder, oldest first — a post outlives the
   *  people in it, so this is a succession, not a single name. */
  holders: string[];
  /** The most recent published holder, or null. */
  holder: string | null;
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
      fte: r.fte, band: r.band, grade: r.grade, title: r.title, unit: r.unit, holder: r.holder,
    }));
    const last = list[list.length - 1];
    const disclosedPts = points.filter((p) => p.disclosed && p.floor != null && p.ceil != null);
    const latestDisclosed = disclosedPts.length ? disclosedPts[disclosedPts.length - 1] : null;
    let peak: PostPoint | null = null;
    for (const p of disclosedPts) if (!peak || (p.ceil ?? 0) > (peak.ceil ?? 0)) peak = p;

    // A succession, in publication order: who held the post when.
    //
    // Departments are not consistent about case or spacing between filings —
    // DWP filed the same Director General as "Kenny Robertson" and
    // "KENNY ROBERTSON" — so identity is compared case-insensitively while the
    // most recent published spelling is the one shown. Counting those as two
    // people would invent a succession that never happened.
    const holders: string[] = [];
    const holderSeen = new Map<string, number>();
    for (const r2 of list) {
      if (!r2.holder) continue;
      const k = r2.holder.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
      const at = holderSeen.get(k);
      if (at == null) { holderSeen.set(k, holders.length); holders.push(r2.holder); }
      else holders[at] = r2.holder;   // keep the latest published spelling
    }

    out.push({
      key,
      holders,
      holder: last.holder ?? (holders.length ? holders[holders.length - 1] : null),
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
      // Names are searchable: the holder history joins the haystack, so
      // "jane smith" finds her posts and "director digital" still finds the post.
      const hay = norm([g.title, g.unit ?? '', g.suborg ?? '', g.grade, g.profession, g.org, ...g.holders].join(' '));
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

// ---------------------------------------------------------------------------
// Organisation structure — the reporting tree, and what it says about layering
// ---------------------------------------------------------------------------
//
// Every senior organogram carries a "Reports to" column holding the Post Unique
// Reference of the post above. 492 of 493 files have it, and where a department
// files a complete return the result is a genuine tree: DWP's August 2026
// filing is 341 posts, 340 edges, one root and nothing dangling.
//
// This is the only part of the corpus that describes SHAPE rather than level,
// and it answers a question no pay figure can: how many layers of senior
// management a department runs, and how many people each of them supervises.
//
// Two honesty rules are built in rather than left to the caller:
//   - A snapshot whose edges do not resolve is not a shallow organisation, it
//     is a partial filing. `dangling` and `rootCount` are reported so a reader
//     can tell the difference, and `complete` is false when they are not.
//   - "Span" counts only DIRECT reports that are themselves senior posts. The
//     organogram stops at the SCS boundary, so a Deputy Director with forty
//     junior staff and no senior reports has a span of zero here. That is a
//     property of the data, not of the job, and the instrument must say so.

export interface OrgLayer {
  depth: number;
  posts: number;
  byGrade: Record<string, number>;
}

export interface OrgSpan {
  pur: string;
  title: string;
  grade: string;
  unit: string | null;
  holder: string | null;
  reports: number;
  depth: number;
}

export interface OrgStructure {
  org: string;
  date: string;
  posts: number;
  edges: number;
  rootCount: number;
  dangling: number;
  /** true when every non-root post resolves to a parent in the same filing */
  complete: boolean;
  layers: OrgLayer[];
  /** deepest chain, counted in posts, root = 1 */
  depth: number;
  managers: number;
  /** senior posts with no senior post reporting to them */
  leaves: number;
  medianSpan: number;
  maxSpan: number;
  spans: OrgSpan[];
}

/** Build the reporting tree for one organisation at one reference date. */
export function orgStructure(rows: PostRow[], date: string): OrgStructure | null {
  // Every post filed at this date takes part in RESOLVING the tree, including
  // ones recorded as eliminated: a live post frequently reports to a post the
  // department has marked for deletion, and dropping those first orphans its
  // children and makes a complete return look like a partial one. They are
  // excluded from the counts below, not from the lookup.
  const all = rows.filter((r) => r.date === date);
  const nodes = all.filter((r) => r.status !== 'eliminated');
  if (!nodes.length) return null;

  const byPur = new Map<string, PostRow>();
  for (const r of all) if (r.pur) byPur.set(r.pur, r);

  const parent = new Map<string, string>();
  const kids = new Map<string, string[]>();
  let dangling = 0;
  // Counted separately from `parent.size`: 2,284 rows across 252 files repeat a
  // Post Unique Reference inside one filing, and a Map keyed on the PUR
  // silently collapses them. Using its size as "how many posts have a parent"
  // makes a complete return look like a partial one — which is how 33 of DWP's
  // 37 filings were being discarded as unreadable.
  let parented = 0;
  const rootPurs: string[] = [];
  for (const r of nodes) {
    if (!r.pur) { dangling++; continue; }
    if (r.reportsTo && byPur.has(r.reportsTo) && r.reportsTo !== r.pur) {
      parented++;
      parent.set(r.pur, r.reportsTo);
      const list = kids.get(r.reportsTo);
      if (list) list.push(r.pur); else kids.set(r.reportsTo, [r.pur]);
    } else if (r.reportsTo && !byPur.has(r.reportsTo)) {
      dangling++;
    } else {
      rootPurs.push(r.pur);
    }
  }

  // Depth by walking up. A cycle would loop forever, and departments do
  // occasionally file one, so the walk is bounded and a post caught in one is
  // reported at the depth it was found rather than dropped.
  const depthOf = new Map<string, number>();
  const depth = (pur: string): number => {
    const seen = new Set<string>();
    let d = 1, cur = pur;
    for (;;) {
      // d counts 1 + the steps taken so far, so a memoised ancestor contributes
      // its own depth plus the steps, not plus d — adding d double-counts the
      // first rung and puts a third of the department three layers too deep.
      if (depthOf.has(cur)) { d = (d - 1) + depthOf.get(cur)!; break; }
      const p = parent.get(cur);
      if (!p || seen.has(p)) break;
      seen.add(p); cur = p; d++;
      if (d > 40) break;
    }
    depthOf.set(pur, d);
    return d;
  };
  for (const r of nodes) if (r.pur) depth(r.pur);

  const layerMap = new Map<number, OrgLayer>();
  for (const r of nodes) {
    if (!r.pur) continue;
    const d = depthOf.get(r.pur) ?? 1;
    let L = layerMap.get(d);
    if (!L) { L = { depth: d, posts: 0, byGrade: {} }; layerMap.set(d, L); }
    L.posts++;
    L.byGrade[r.grade] = (L.byGrade[r.grade] ?? 0) + 1;
  }
  const layers = [...layerMap.values()].sort((a, b) => a.depth - b.depth);

  const spans: OrgSpan[] = [];
  for (const [pur, list] of kids) {
    const r = byPur.get(pur);
    if (!r) continue;
    spans.push({
      pur, title: r.title, grade: r.grade, unit: r.unit, holder: r.holder,
      reports: list.length, depth: depthOf.get(pur) ?? 1,
    });
  }
  spans.sort((a, b) => b.reports - a.reports || a.title.localeCompare(b.title));
  const counts = spans.map((s) => s.reports).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;

  return {
    org: nodes[0].org,
    date,
    posts: nodes.length,
    edges: parented,
    rootCount: rootPurs.length,
    dangling,
    complete: dangling === 0 && rootPurs.length <= 2 && parented >= nodes.length - 3,
    layers,
    depth: layers.length ? layers[layers.length - 1].depth : 1,
    managers: kids.size,
    leaves: nodes.length - kids.size,
    medianSpan: median,
    maxSpan: counts.length ? counts[counts.length - 1] : 0,
    spans,
  };
}

/**
 * The structure of one organisation over time.
 *
 * Only filings whose tree actually resolves are returned. A partial filing
 * looks exactly like a flatter organisation, and plotting the two together
 * would show a delayering that never happened.
 */
export function structureSeries(rows: PostRow[], dates: string[]): OrgStructure[] {
  return structureSeriesDetailed(rows, dates).kept;
}

/** The same, plus why each rejected filing was rejected. */
export function structureSeriesDetailed(rows: PostRow[], dates: string[]): {
  kept: OrgStructure[];
  rejected: { date: string; reason: string; posts: number; dangling: number; roots: number }[];
} {
  const kept: OrgStructure[] = [];
  const rejected: { date: string; reason: string; posts: number; dangling: number; roots: number }[] = [];
  for (const d of dates) {
    const s = orgStructure(rows, d);
    if (!s) { rejected.push({ date: d, reason: 'no posts', posts: 0, dangling: 0, roots: 0 }); continue; }
    const base = { date: d, posts: s.posts, dangling: s.dangling, roots: s.rootCount };
    if (s.posts < 30) rejected.push({ ...base, reason: 'too few posts to read a shape' });
    else if (s.dangling > 0) rejected.push({ ...base, reason: 'reporting lines point outside the filing' });
    else if (s.rootCount > 2) rejected.push({ ...base, reason: 'more than two posts report to nobody' });
    else if (!s.complete) rejected.push({ ...base, reason: 'too few posts have a parent' });
    else kept.push(s);
  }
  return { kept, rejected };
}
