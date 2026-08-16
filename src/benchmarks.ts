// External comparators — public/data/benchmarks.json (section 10) and the
// quarantined advertised-salary layer public/data/benchmarks-itjw.json.
//
// The honesty rules of section 2.5 of the build plan are enforced HERE, in
// code, rather than left to the copy:
//
//   * n < 30 returns "insufficient data — n = X" and no value. A caller
//     cannot accidentally draw a mark it was refused.
//   * A suppressed figure is null with a reason. It is never zero, and an
//     exact zero in a pay field is treated as a suppression fault, not a
//     number.
//   * Every figure carries its own sourceDate / windowEnd / lastReviewed and
//     its own staleness verdict at 14 months. There is no page-level stamp.
//   * ASHE comparisons default to annualised BASIC pay. Annual gross includes
//     incentive pay and is not comparable with SCS base pay; asking for it
//     returns a figure explicitly marked as not comparable.
//   * Confidence is exactly fact | hypothesis | contested.
//   * The IT Jobs Watch layer is structurally separate and every figure it
//     yields carries its CC BY-NC-SA attribution. There is no accessor that
//     returns one of its numbers without one.

import { fetchJson } from './data';

// ---------------------------------------------------------------------------
// Types — the shapes benchmarks.json actually ships
// ---------------------------------------------------------------------------

export type Confidence = 'fact' | 'hypothesis' | 'contested';
export const CONFIDENCES: Confidence[] = ['fact', 'hypothesis', 'contested'];

export interface Source {
  name: string; publisher: string; url: string;
  table?: string; sheet?: string; edition?: string;
  provisional?: boolean;
  sourceDate: string; windowEnd?: string; lastReviewed: string;
  licence: string; extraction?: string; note?: string;
  correctionNotice?: string | null;
}

export interface StatBlock {
  src: string;
  jobs?: number;
  derived?: string;
  median: number | null;
  mean?: number | null;
  p25?: number | null;
  p75?: number | null;
  p90?: number | null;
  nKnown: boolean;
  suppressed?: Record<string, string>;
}

export interface Occupation {
  soc: string;
  description: string;
  classification: string;
  edition: string;
  provisional: boolean;
  correctionAffected: boolean;
  annualGross: StatBlock;
  weeklyBasic: StatBlock;
  basicAnnualised: StatBlock;
  annualIncentive?: StatBlock;
}

export interface CrosswalkRow {
  scsRole: string; soc2020: string; marketTitle: string; confidence: Confidence; note: string;
}

export interface GatedBlock<T> {
  id: string; docUrl: string; blockSha: string; blockLine: number;
  state: 'verified' | 'changed' | 'unreviewed' | 'skipped-no-pdftotext' | 'parse-empty';
  live: T | null;
  pending: unknown;
  approvedOn: string | null;
}

export interface CuratedRow {
  id: string; label: string; publisher: string; sourceUrl: string;
  sourceDate: string; windowEnd?: string; lastReviewed: string;
  confidence: Confidence; verified: boolean; extraction: string; licence: string;
  values: Record<string, Record<string, number | null>>;
  unit: string; caveats: string[];
}

export interface Benchmarks {
  schema: number;
  generated: string;
  contentDigest: string;
  purpose: string;
  honestyRules: string[];
  socBreaks: { from: number | null; to: number | null; classification: string; note: string }[];
  crosswalk: CrosswalkRow[];
  sources: Record<string, Source>;
  ashe: {
    editions: unknown[];
    derived: { basis: string; confidence: Confidence; caveat: string; useFor: string };
    occupations: Occupation[];
    sector: { edition: string; sectors: Record<string, Record<string, StatBlock>>; note: string };
    region: { edition: string; src: string; regions: string[]; cols: string[]; note: string; rows: (string | number | null)[][] };
  };
  acses: {
    edition: string; asOf: string;
    tables: Record<string, { src: string; sheet: string; title: string; rows: unknown[]; parents?: string[]; cols?: string[]; note?: string }>;
  };
  ssrb: {
    src: string;
    document: { title: string; url: string; publicUpdatedAt: string };
    medianByPayband: GatedBlock<{ year: number; deputyDirector: number | null; deputyDirector1A: number | null; director: number | null; directorGeneral: number | null }[]>;
    marketComparison: GatedBlock<Record<string, Record<string, number | null>>>;
    caveats: string[];
  };
  ssrbReport: { src: string; document: { title: string; url: string }; bandMedians: GatedBlock<Record<string, number | string | null>> };
  scsPayBands: {
    editions: { year: number; title: string; page: string; pdf: string; publicUpdatedAt: string }[];
    parsed: (GatedBlock<{ effectiveFrom: string; payYear: string; bands: { band: string; min: number; max: number }[] }> & { year: number; src: string })[];
  };
  curated: CuratedRow[];
  excluded: { source: string; verdict: string; reason: string }[];
  contested: { quantity: string; confidence: Confidence; readings: { source: string; basis: string; value: number }[]; spreadPct: number; why: string }[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// The figure envelope — the only way a number leaves this module
// ---------------------------------------------------------------------------

export const N_FLOOR = 30;
/** A figure whose provenance has not been re-checked in 14 months is stale. */
export const STALE_MONTHS = 14;

export interface Provenance extends Source {
  sourceId: string;
  /** whole months since `lastReviewed` */
  reviewAgeMonths: number | null;
  /** whole months since the publisher released it */
  sourceAgeMonths: number | null;
  stale: boolean;
}

export interface FigureOk {
  ok: true;
  label: string;
  value: number;
  unit: string;
  n: number | null;
  /** false when the publisher gave no sample size, so the n floor could not run */
  nApplied: boolean;
  confidence: Confidence;
  /** false for anything that is not base pay measured the same way as SCS pay */
  comparableToScsBase: boolean;
  provenance: Provenance;
  caveats: string[];
  /** true when the review gate says the published table moved since approval */
  reviewOutstanding?: boolean;
}

export interface FigureUnavailable {
  ok: false;
  label: string;
  reason: 'insufficient' | 'suppressed' | 'unavailable' | 'unreviewed' | 'not-published';
  /** renderable as-is, in place of the mark */
  message: string;
  n: number | null;
  provenance: Provenance | null;
}

export type Figure = FigureOk | FigureUnavailable;

const SUPPRESSION_TEXT: Record<string, string> = {
  'cv-above-20-per-cent': 'suppressed by ONS: coefficient of variation above 20 per cent',
  'not-applicable': 'not applicable in this table',
  'disclosive': 'suppressed as disclosive',
  'nil-or-negligible': 'nil or negligible',
  'confidential-small-numbers': 'suppressed: confidential, small numbers',
  'zero-invalid': 'published as zero, which this pipeline treats as a suppression fault rather than a pay figure',
};
export const suppressionText = (code: string) => SUPPRESSION_TEXT[code] ?? code;

const MONTH = 30.436875 * 86400000;
function monthsSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / MONTH);
}

export function provenanceOf(bm: Benchmarks, sourceId: string, now = Date.now()): Provenance | null {
  const s = bm.sources[sourceId];
  if (!s) return null;
  const reviewAgeMonths = monthsSince(s.lastReviewed, now);
  return {
    ...s,
    sourceId,
    reviewAgeMonths,
    sourceAgeMonths: monthsSince(s.sourceDate, now),
    stale: reviewAgeMonths != null && reviewAgeMonths > STALE_MONTHS,
  };
}

function curatedProvenance(row: CuratedRow, now = Date.now()): Provenance {
  const reviewAgeMonths = monthsSince(row.lastReviewed, now);
  return {
    sourceId: row.id, name: row.label, publisher: row.publisher, url: row.sourceUrl,
    sourceDate: row.sourceDate, windowEnd: row.windowEnd, lastReviewed: row.lastReviewed,
    licence: row.licence, extraction: row.extraction,
    reviewAgeMonths, sourceAgeMonths: monthsSince(row.sourceDate, now),
    stale: reviewAgeMonths != null && reviewAgeMonths > STALE_MONTHS,
  };
}

export function validConfidence(c: unknown): Confidence {
  return CONFIDENCES.includes(c as Confidence) ? (c as Confidence) : 'contested';
}

/**
 * Build a figure, applying every gate in one place.
 *
 * `n` is the publisher's own sample size where there is one. Below the floor
 * the value never leaves this function.
 */
function makeFigure(args: {
  label: string;
  value: number | null | undefined;
  unit: string;
  n: number | null;
  nKnown: boolean;
  confidence: Confidence;
  comparableToScsBase: boolean;
  provenance: Provenance | null;
  suppressedReason?: string | null;
  caveats?: string[];
  reviewOutstanding?: boolean;
  nFloor?: number;
}): Figure {
  const { label, unit, n, nKnown, provenance } = args;
  const nFloor = args.nFloor ?? N_FLOOR;
  const caveats = [...(args.caveats ?? [])];

  if (args.suppressedReason) {
    return { ok: false, label, reason: 'suppressed', message: `no figure — ${suppressionText(args.suppressedReason)}`, n, provenance };
  }
  if (args.value == null) {
    return { ok: false, label, reason: 'not-published', message: 'not published for this cell — null is an absence, not a zero', n, provenance };
  }
  if (args.value === 0) {
    // The build fails on an exact zero in a pay field upstream; if one ever
    // reaches here it is a suppression that lost its reason, not £0.
    return { ok: false, label, reason: 'suppressed', message: `no figure — ${suppressionText('zero-invalid')}`, n, provenance };
  }
  if (nKnown && n != null && n < nFloor) {
    return { ok: false, label, reason: 'insufficient', message: `insufficient data — n = ${n}`, n, provenance };
  }
  if (!nKnown) {
    caveats.push(`the publisher gives no sample size for this cell, so the n = ${nFloor} floor could not be applied`);
  }
  if (provenance?.stale) {
    caveats.push(`provenance last reviewed ${provenance.lastReviewed} — over ${STALE_MONTHS} months ago`);
  }
  if (provenance?.correctionNotice) {
    caveats.push('the publisher has issued a correction notice against this edition');
  }
  return {
    ok: true, label, value: args.value, unit, n, nApplied: nKnown,
    confidence: args.confidence, comparableToScsBase: args.comparableToScsBase,
    provenance: provenance!, caveats,
    ...(args.reviewOutstanding ? { reviewOutstanding: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export const loadBenchmarks = (base = './data/') => fetchJson<Benchmarks>(base + 'benchmarks.json');
export const loadItjwLayer = (base = './data/') => fetchJson<ItjwFile>(base + 'benchmarks-itjw.json');

// ---------------------------------------------------------------------------
// ASHE
// ---------------------------------------------------------------------------

export type PayStat = 'median' | 'mean' | 'p25' | 'p75' | 'p90';
export type AsheBasis = 'basicAnnualised' | 'annualGross' | 'weeklyBasic';

export const occupationBySoc = (bm: Benchmarks, soc: string): Occupation | null =>
  bm.ashe.occupations.find((o) => o.soc === soc) ?? null;

/**
 * Market pay for a SOC code.
 *
 * Defaults to `basicAnnualised` — ASHE weekly basic pay times 52 — which is
 * the only base-against-base comparator for SCS organogram pay. `annualGross`
 * is Table 14.7a and includes incentive pay; it comes back marked as not
 * comparable, with the caveat attached, so a chart cannot quietly pit it
 * against a civil service base salary.
 */
export function marketPay(bm: Benchmarks, soc: string, stat: PayStat = 'median', basis: AsheBasis = 'basicAnnualised', now = Date.now()): Figure {
  const occ = occupationBySoc(bm, soc);
  const label = `${occ ? occ.description : 'SOC ' + soc} — ${stat}`;
  if (!occ) return { ok: false, label, reason: 'unavailable', message: `SOC ${soc} is not in this benchmark file`, n: null, provenance: null };

  const block = occ[basis] as StatBlock | undefined;
  if (!block) return { ok: false, label, reason: 'unavailable', message: `no ${basis} block for SOC ${soc}`, n: null, provenance: null };

  const value = (block as unknown as Record<string, number | null | undefined>)[stat];
  const prov = provenanceOf(bm, block.src, now);
  const caveats: string[] = [];
  let confidence: Confidence = 'fact';
  let comparable = true;

  if (basis === 'basicAnnualised') {
    confidence = validConfidence(bm.ashe.derived.confidence);
    caveats.push(bm.ashe.derived.caveat);
  } else if (basis === 'annualGross') {
    comparable = false;
    confidence = 'contested';
    caveats.push('ASHE Table 14.7a is annual gross pay INCLUDING incentive pay. SCS organogram pay is base only. Do not compare the two.');
  } else {
    comparable = false;
    caveats.push('weekly basic pay, not annualised');
  }
  if (occ.provisional) caveats.push(`${occ.edition} — provisional, revised about twelve months later`);
  if (occ.correctionAffected) caveats.push('this occupation is affected by a live ONS correction notice');
  if (stat === 'mean') caveats.push('SOC 1111 has a long right tail; the mean sits far above the median. Use p75 against SCS3, never the mean.');
  caveats.push('Occupation is not seniority: a four-digit SOC pools a two-person firm\'s director with a FTSE director.');
  caveats.push('Base salary only on both sides. The civil service alpha employer pension contribution is worth roughly 23.6 to 28 per cent of salary against a typical private defined-contribution 3 to 8 per cent.');

  // ASHE publishes a jobs count in thousands, not a raw sample size.
  const n = block.jobs != null ? Math.round(block.jobs * 1000) : null;
  return makeFigure({
    label, value, unit: basis === 'weeklyBasic' ? 'GBP per week' : 'GBP per year',
    n, nKnown: block.nKnown !== false && n != null,
    confidence, comparableToScsBase: comparable, provenance: prov,
    suppressedReason: block.suppressed?.[stat] ?? null,
    caveats,
  });
}

/** Public / private / non-profit pay from ASHE Table 13. */
export function sectorPay(bm: Benchmarks, sector: 'public' | 'private' | 'nonProfit', stat: PayStat = 'median', basis: AsheBasis = 'basicAnnualised', now = Date.now()): Figure {
  const block = bm.ashe.sector?.sectors?.[sector]?.[basis];
  const label = `${sector} sector — ${stat}`;
  if (!block) return { ok: false, label, reason: 'unavailable', message: `no ${basis} block for the ${sector} sector`, n: null, provenance: null };
  const value = (block as unknown as Record<string, number | null | undefined>)[stat];
  return makeFigure({
    label, value, unit: basis === 'weeklyBasic' ? 'GBP per week' : 'GBP per year',
    n: block.jobs != null ? Math.round(block.jobs * 1000) : null,
    nKnown: block.nKnown !== false,
    confidence: basis === 'basicAnnualised' ? validConfidence(bm.ashe.derived.confidence) : 'fact',
    comparableToScsBase: basis === 'basicAnnualised',
    provenance: provenanceOf(bm, block.src, now),
    suppressedReason: block.suppressed?.[stat] ?? null,
    caveats: [
      bm.ashe.sector.note,
      'Headline public-versus-private pay is not the story for the SCS: public hourly pay is lower in London, the South East and the East, and the SCS is London-concentrated. Use the regional figures.',
    ],
  });
}

export interface RegionRow { soc: string; region: string; jobsThousands: number | null; median: number | null; p75: number | null }

/** ASHE Table 15 — the London adjustment, which the geography caveat needs. */
export function regionRows(bm: Benchmarks, soc?: string): RegionRow[] {
  const r = bm.ashe.region;
  if (!r) return [];
  const ci = (name: string) => r.cols.indexOf(name);
  const iSoc = ci('soc'), iReg = ci('regionIdx'), iJobs = ci('jobsThousands'), iMed = ci('median'), iP75 = ci('p75');
  return r.rows
    .filter((row) => (soc ? row[iSoc] === soc : true))
    .map((row) => ({
      soc: String(row[iSoc]),
      region: r.regions[Number(row[iReg])] ?? '—',
      jobsThousands: (row[iJobs] as number | null) ?? null,
      median: (row[iMed] as number | null) ?? null,
      p75: (row[iP75] as number | null) ?? null,
    }));
}

// ---------------------------------------------------------------------------
// The SOC crosswalk join
// ---------------------------------------------------------------------------

const normKey = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/** Look a crosswalk row up by SCS role name, profession name or SOC code. */
export function crosswalkFor(bm: Benchmarks, key: string): CrosswalkRow | null {
  if (/^\d{4}$/.test(key)) return bm.crosswalk.find((c) => c.soc2020 === key) ?? null;
  const k = normKey(key);
  return bm.crosswalk.find((c) => normKey(c.scsRole) === k)
    ?? bm.crosswalk.find((c) => normKey(c.scsRole).startsWith(k) || k.startsWith(normKey(c.scsRole)))
    ?? bm.crosswalk.find((c) => normKey(c.marketTitle) === k)
    ?? null;
}

/**
 * Join an SCS role or profession straight to a market figure.
 * `soc` may be a code from `ROLE_SOC` in query.ts or a profession name.
 */
export function marketPayForRole(bm: Benchmarks, roleOrSoc: string, stat: PayStat = 'median', now = Date.now()): Figure {
  const cw = crosswalkFor(bm, roleOrSoc);
  if (!cw) {
    return { ok: false, label: roleOrSoc, reason: 'unavailable', message: `no SOC crosswalk entry for "${roleOrSoc}"`, n: null, provenance: null };
  }
  const fig = marketPay(bm, cw.soc2020, stat, 'basicAnnualised', now);
  if (fig.ok) {
    fig.label = `${cw.scsRole} vs ${cw.marketTitle} (SOC ${cw.soc2020}) — ${stat}`;
    // the crosswalk's own confidence caps the figure's
    if (cw.confidence !== 'fact') fig.confidence = validConfidence(cw.confidence);
    if (cw.note) fig.caveats.unshift(cw.note);
  }
  return fig;
}

// ---------------------------------------------------------------------------
// Review-gated blocks (SSRB, SCS pay bands)
// ---------------------------------------------------------------------------

export interface Gated<T> { value: T | null; state: GatedBlock<T>['state']; reviewOutstanding: boolean; approvedOn: string | null; message: string | null }

/**
 * Read a gated block. `live` is always the approved reading; `pending` is
 * never returned as fact. A `changed` state means the published table moved
 * and a review is outstanding — render live, and say so.
 */
export function gated<T>(block: GatedBlock<T> | undefined): Gated<T> {
  if (!block) return { value: null, state: 'parse-empty', reviewOutstanding: false, approvedOn: null, message: 'not present in this build' };
  const msg =
    block.state === 'changed' ? 'the published table has moved since this reading was approved — a review is outstanding'
      : block.state === 'unreviewed' ? 'nothing approved yet; showing the curated fallback, not the new extraction'
        : block.state === 'skipped-no-pdftotext' ? 'pdftotext was unavailable on the build machine; showing the curated fallback'
          : block.state === 'parse-empty' ? 'the extractor found nothing and approving a null was refused'
            : null;
  return { value: block.live ?? null, state: block.state, reviewOutstanding: block.state === 'changed', approvedOn: block.approvedOn, message: msg };
}

/** Official SCS median base salary by pay band, 2010 onwards (SSRB evidence). */
export function ssrbMedianByPayband(bm: Benchmarks) {
  return { ...gated(bm.ssrb?.medianByPayband), src: bm.ssrb?.src, caveats: bm.ssrb?.caveats ?? [] };
}

/** The grade-matched market comparison — one year, two grades. Not a trend. */
export function ssrbMarketComparison(bm: Benchmarks) {
  const g = gated(bm.ssrb?.marketComparison);
  return {
    ...g,
    src: bm.ssrb?.src,
    caveats: [
      ...(bm.ssrb?.caveats ?? []),
      'One year, two grades. Director General has no comparator and pay band 1A is suppressed. It is an anchor, not a trend line.',
      'Korn Ferry updated its civil service reference levels in October 2023, so 2022 is not comparable with 2023 or 2024.',
    ],
  };
}

/** Published SCS pay band minima and maxima — the scaffold every chart sits on. */
export function scsPayBands(bm: Benchmarks, year?: number) {
  const list = (bm.scsPayBands?.parsed ?? []).map((p) => ({ year: p.year, ...gated(p), src: p.src }));
  return year == null ? list : list.filter((p) => p.year === year);
}

// ---------------------------------------------------------------------------
// Curated figures (hand-transcribed, dated, staleness-checked)
// ---------------------------------------------------------------------------

export function curatedFigure(bm: Benchmarks, id: string, path: [string, string], now = Date.now()): Figure {
  const row = bm.curated.find((c) => c.id === id);
  const label = `${id} ${path.join(' ')}`;
  if (!row) return { ok: false, label, reason: 'unavailable', message: `no curated figure "${id}"`, n: null, provenance: null };
  const value = row.values?.[path[0]]?.[path[1]] ?? null;
  return makeFigure({
    label: `${row.label} — ${path.join(' ')}`,
    value, unit: row.unit, n: null, nKnown: false,
    confidence: validConfidence(row.confidence),
    comparableToScsBase: false,
    provenance: curatedProvenance(row, now),
    caveats: row.caveats ?? [],
  });
}

/** Every curated row with its staleness verdict — the Method beat wants this. */
export function curatedProvenanceTable(bm: Benchmarks, now = Date.now()) {
  return bm.curated.map((row) => ({ id: row.id, label: row.label, confidence: validConfidence(row.confidence), provenance: curatedProvenance(row, now) }));
}

/** Anything whose review is older than the staleness threshold. */
export function staleSources(bm: Benchmarks, now = Date.now()): Provenance[] {
  return Object.keys(bm.sources)
    .map((id) => provenanceOf(bm, id, now)!)
    .filter((p) => p && p.stale);
}

export const honestyRules = (bm: Benchmarks) => bm.honestyRules ?? [];
export const socBreaks = (bm: Benchmarks) => bm.socBreaks ?? [];
export const contestedQuantities = (bm: Benchmarks) => (bm.contested ?? []).map((c) => ({ ...c, confidence: validConfidence(c.confidence) }));
export const excludedSources = (bm: Benchmarks) => bm.excluded ?? [];

// ---------------------------------------------------------------------------
// IT Jobs Watch — quarantined, CC BY-NC-SA 4.0, attribution welded on
// ---------------------------------------------------------------------------

export interface ItjwLicence {
  id: string; name: string; url: string; policyUrl: string;
  attribution: string; attributionUrl: string; notice: string;
  conditions: string[]; quarantine: string; policyChecked: string; policySha256: string;
}

export interface ItjwRole {
  id: string; title: string; group: string; soc: string | null; scs: string;
  status: 'ok' | 'insufficient' | 'absent' | 'error';
  n: number | null; median: number | null; ads?: number;
  pct?: (number | null)[];
  london?: (number | null)[];
  exLondon?: (number | null)[];
  prior?: (string | number | null)[][];
  note?: string;
  slug?: string;
}

export interface ItjwFile {
  schema: number; generated: string; quarantined: boolean; doNotMerge: string; purpose: string;
  source: { name: string; publisher: string; url: string; urlTemplate: string; retrieved: string; updateFrequency: string; robots: unknown; requestPolicy: unknown };
  licence: ItjwLicence;
  measure: Record<string, string>;
  gate: { nFloor: number; rule: string };
  comparability: string[];
  fieldGuide: string;
  period: { label: string; months: number; windowEnd: string; priorLabels: string[] };
  marketBaseline: { label: string; n: number; median: number; pct: number[]; vacancies: number; exLondonMedian: number };
  roles: ItjwRole[];
  coverage: Record<string, unknown>;
  warnings: string[];
  digest: string;
}

/**
 * An IT Jobs Watch figure. Attribution and licence are fields of the figure
 * itself, not of the page, so a renderer cannot show the number and forget
 * the notice.
 */
export interface ItjwFigure {
  ok: boolean;
  roleId: string;
  title: string;
  scs: string;
  soc: string | null;
  /** median advertised salary, GBP per year. Null whenever `ok` is false. */
  median: number | null;
  pct: (number | null)[] | null;
  n: number | null;
  ads: number | null;
  /** renderable in place of the mark when ok is false */
  message: string | null;
  measure: string;
  attribution: string;
  attributionUrl: string;
  licence: string;
  licenceUrl: string;
  notice: string;
  windowEnd: string;
  caveats: string[];
}

function itjwFigureOf(file: ItjwFile, role: ItjwRole): ItjwFigure {
  const floor = file.gate?.nFloor ?? N_FLOOR;
  const base = {
    roleId: role.id, title: role.title, scs: role.scs, soc: role.soc ?? null,
    n: role.n ?? null, ads: role.ads ?? null,
    measure: file.measure?.statement ?? 'median advertised salary',
    attribution: file.licence.attribution,
    attributionUrl: file.licence.attributionUrl,
    licence: file.licence.name,
    licenceUrl: file.licence.url,
    notice: file.licence.notice,
    windowEnd: file.period?.windowEnd ?? file.generated,
    caveats: [
      file.measure?.vsScs ?? '',
      file.measure?.vsAshe ?? '',
      file.measure?.pension ?? '',
      file.measure?.sample ?? '',
    ].filter(Boolean),
  };
  if (role.status !== 'ok' || role.median == null) {
    const message = role.status === 'absent'
      ? role.note ?? 'no advertised benchmark exists under this title'
      : role.note ?? `insufficient market data — n = ${role.n ?? 0}`;
    return { ...base, ok: false, median: null, pct: null, message };
  }
  if (role.n != null && role.n < floor) {
    return { ...base, ok: false, median: null, pct: null, message: `insufficient market data — n = ${role.n}` };
  }
  return { ...base, ok: true, median: role.median, pct: role.pct ?? null, message: null };
}

/**
 * Every probed role, including the ones under the gate and the ones that do
 * not exist. Dropping them silently would bias the visible set towards the
 * best-covered technology roles, which is itself the finding.
 */
export function itjwFigures(file: ItjwFile): ItjwFigure[] {
  return file.roles.map((r) => itjwFigureOf(file, r));
}

export function itjwFigure(file: ItjwFile, roleId: string): ItjwFigure | null {
  const role = file.roles.find((r) => r.id === roleId || r.title.toLowerCase() === roleId.toLowerCase());
  return role ? itjwFigureOf(file, role) : null;
}

/** Figures for a SOC code — the only join between this layer and the OGL one. */
export function itjwFiguresForSoc(file: ItjwFile, soc: string): ItjwFigure[] {
  return file.roles.filter((r) => r.soc === soc).map((r) => itjwFigureOf(file, r));
}

/** The string that must appear beside any rendered IT Jobs Watch figure. */
export const itjwCaption = (fig: ItjwFigure) =>
  `${fig.attribution} (${fig.attributionUrl}) — ${fig.licence}. Advertised salaries, six months to ${fig.windowEnd}.`;

/** Coverage of the layer: what it could and could not answer. */
export const itjwCoverage = (file: ItjwFile) => ({ ...file.coverage, gate: file.gate, comparability: file.comparability });
