// App state + URL-shareable encoding. State is compact-serialised into the URL
// hash with lz-string so any view can be copied as a link.
import LZString from 'lz-string';
import type { Measure, Dimension, Disclosure, Grain } from './data';

/**
 * How a figure is computed.
 *
 *  raw            — as published. No reweighting. Cross-period totals still
 *                   get the constant-scope guard where one can be applied,
 *                   and say loudly when it cannot.
 *  reweighted     — the disclosed pay distribution projected onto the
 *                   published grade mix, because disclosure runs from about
 *                   20-25% at SCS1 to 93-96% at SCS2 and above.
 *  constant-scope — restrict the series to organisations present in every
 *                   period of the range. Strict: if no organisation qualifies
 *                   the series is empty rather than quietly re-based.
 */
export type Basis = 'raw' | 'reweighted' | 'constant-scope';

/** Small multiples: one axis for every panel, or one axis per panel. */
export type Scale = 'shared' | 'own';

export interface AppState {
  tab: string;
  measure: Measure;
  dimension: Dimension;
  depts: number[];        // selected organisation indices (empty = all)
  profs: number[];        // selected profession indices (empty = all)
  grades: number[];       // selected grade indices (empty = all)
  ddat: 0 | 1 | 2;        // 0 = both, 1 = DDaT only, 2 = non-DDaT
  policy: 0 | 1 | 2;
  realTerms: boolean;
  showTable: boolean;
  /** include Tier B bodies. They are never summed into an SCS figure. */
  tierB: boolean;
  basis: Basis;
  scale: Scale;
  disclosure: Disclosure;
  grain: Grain;
}

export function defaultState(): AppState {
  return {
    tab: 'explore', measure: 'medianPay', dimension: 'department',
    depts: [], profs: [], grades: [], ddat: 0, policy: 0, realTerms: false, showTable: false,
    tierB: false, basis: 'raw', scale: 'shared', disclosure: 'all', grain: 'quarter',
  };
}

const BASES: Basis[] = ['raw', 'reweighted', 'constant-scope'];
const SCALES: Scale[] = ['shared', 'own'];
const DISCLOSURES: Disclosure[] = ['all', 'disclosed', 'withheld'];
const GRAINS: Grain[] = ['date', 'quarter', 'half', 'year'];
const oneOf = <T,>(list: T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

// pack to a short object then compress
export function encodeState(s: AppState): string {
  const packed = {
    t: s.tab, m: s.measure, d: s.dimension, dp: s.depts, pf: s.profs, g: s.grades,
    dd: s.ddat, po: s.policy, r: s.realTerms ? 1 : 0, tb: s.showTable ? 1 : 0,
    tr: s.tierB ? 1 : 0, bs: s.basis, sl: s.scale, ds: s.disclosure, gr: s.grain,
  };
  return LZString.compressToEncodedURIComponent(JSON.stringify(packed));
}

export function decodeState(hash: string): Partial<AppState> | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(hash);
    if (!json) return null;
    const p = JSON.parse(json);
    return {
      tab: p.t, measure: p.m, dimension: p.d, depts: p.dp ?? [], profs: p.pf ?? [], grades: p.g ?? [],
      ddat: p.dd ?? 0, policy: p.po ?? 0, realTerms: !!p.r, showTable: !!p.tb,
      // links written before these controls existed decode to the defaults
      tierB: !!p.tr,
      basis: oneOf(BASES, p.bs, 'raw'),
      scale: oneOf(SCALES, p.sl, 'shared'),
      disclosure: oneOf(DISCLOSURES, p.ds, 'all'),
      grain: oneOf(GRAINS, p.gr, 'quarter'),
    };
  } catch { return null; }
}

export function readHash(): Partial<AppState> | null {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  return decodeState(hash);
}

let writeTimer: number | undefined;
export function writeHash(s: AppState): void {
  clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    history.replaceState(null, '', '#' + encodeState(s));
  }, 200);
}
