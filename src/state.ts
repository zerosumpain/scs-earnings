// App state + URL-shareable encoding. State is compact-serialised into the URL
// hash with lz-string so any view can be copied as a link.
import LZString from 'lz-string';
import type { Measure, Dimension } from './data';

export interface AppState {
  tab: string;
  measure: Measure;
  dimension: Dimension;
  depts: number[];        // selected dept indices (empty = all)
  profs: number[];        // selected profession indices (empty = all)
  grades: number[];       // selected grade indices (empty = all)
  ddat: 0 | 1 | 2;        // 0 = both, 1 = DDaT only, 2 = non-DDaT
  policy: 0 | 1 | 2;
  realTerms: boolean;
  showTable: boolean;
}

export function defaultState(): AppState {
  return {
    tab: 'explore', measure: 'medianPost', dimension: 'department',
    depts: [], profs: [], grades: [], ddat: 0, policy: 0, realTerms: false, showTable: false,
  };
}

// pack to a short object then compress
export function encodeState(s: AppState): string {
  const packed = {
    t: s.tab, m: s.measure, d: s.dimension, dp: s.depts, pf: s.profs, g: s.grades,
    dd: s.ddat, po: s.policy, r: s.realTerms ? 1 : 0, tb: s.showTable ? 1 : 0,
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
