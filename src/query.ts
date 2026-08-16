// Shared: turn AppState into a data-layer Filter, and hold the two small
// reference tables the study joins against — the Prime Minister's pay and the
// SCS role -> SOC 2020 crosswalk key.
import type { Filter } from './data';
import type { AppState } from './state';

export function stateToFilter(s: AppState, extra: Partial<Filter> = {}): Filter {
  const orgs = s.depts.length ? new Set(s.depts) : null;
  return {
    orgs,
    depts: orgs,                                   // legacy alias, same set
    profs: s.profs.length ? new Set(s.profs) : null,
    grades: s.grades.length ? new Set(s.grades) : null,
    ddat: s.ddat === 1 ? true : s.ddat === 2 ? false : null,
    policy: s.policy === 1 ? true : s.policy === 2 ? false : null,
    tier: s.tierB ? 'AB' : 'A',
    disclosure: s.disclosure,
    grain: s.grain,
    realTerms: s.realTerms,
    // 'raw' leaves constantScope undefined so the automatic guard still runs
    // on cross-period totals and reports when it cannot be applied.
    reweight: s.basis === 'reweighted',
    constantScope: s.basis === 'constant-scope' ? true : undefined,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The Prime Minister's pay — the "more than the PM" reference line
// ---------------------------------------------------------------------------

/**
 * Total pay entitlement (parliamentary salary plus ministerial salary), £,
 * nominal. Entitlement, not receipt: prime ministers have repeatedly declined
 * part of the ministerial element, so the line is what the post is entitled to.
 */
export const PM_PAY: Record<number, number> = {
  2010: 142500, 2011: 142500, 2012: 142500, 2013: 142500, 2014: 142500,
  2015: 149440, 2016: 150402, 2017: 152819, 2018: 155602, 2019: 158754,
  2020: 161401, 2021: 161866, 2022: 164080, 2023: 167391, 2024: 172153,
  2025: 172153, 2026: 172153,
};

/** Years at or below this are transcribed from a published table. */
export const PM_PAY_VERIFIED_TO = 2024;

export const PM_PAY_SOURCE = {
  publisher: 'Cabinet Office',
  title: 'Salaries of members of His Majesty\'s Government',
  url: 'https://www.gov.uk/government/publications/salaries-of-members-of-his-majestys-government',
  ipsaUrl: 'https://www.theipsa.org.uk/mp-staffing-business-costs/your-mp-costs/mps-pay-and-pensions',
  licence: 'Open Government Licence v3.0',
  basis: 'parliamentary salary plus ministerial salary entitlement',
  sourceDate: '2024-04-01',
  lastReviewed: '2026-08-16',
  verifiedTo: PM_PAY_VERIFIED_TO,
  /**
   * Update path: the Cabinet Office publishes ministerial salaries each April
   * and IPSA publishes the parliamentary salary alongside it. Add the new year
   * to PM_PAY, move PM_PAY_VERIFIED_TO to it, set lastReviewed, and re-run the
   * build. Years past PM_PAY_VERIFIED_TO are carried forward and must be drawn
   * as such — a flat line that is really an absence.
   */
  updatePath: 'Add the published year to PM_PAY, advance PM_PAY_VERIFIED_TO and lastReviewed, then rebuild.',
} as const;

export interface PmPayEntry {
  year: number;
  value: number;
  /** false when the figure is the last published year carried forward */
  published: boolean;
  carriedForwardFrom: number | null;
  source: typeof PM_PAY_SOURCE;
}

export function pmPayEntry(periodOrYear: string | number): PmPayEntry {
  const y = typeof periodOrYear === 'number' ? periodOrYear : Number(String(periodOrYear).slice(0, 4));
  const years = Object.keys(PM_PAY).map(Number).sort((a, b) => a - b);
  const exact = PM_PAY[y];
  const fallbackYear = years.filter((z) => z <= y).pop() ?? years[years.length - 1];
  const value = exact ?? PM_PAY[fallbackYear];
  const published = y <= PM_PAY_VERIFIED_TO && exact != null;
  return {
    year: y,
    value,
    published,
    carriedForwardFrom: published ? null : Math.min(PM_PAY_VERIFIED_TO, fallbackYear),
    source: PM_PAY_SOURCE,
  };
}

export const pmPayFor = (periodOrYear: string | number): number => pmPayEntry(periodOrYear).value;

/** True when the table has not been re-checked inside 14 months. */
export function pmPayStale(now = Date.now()): boolean {
  const t = Date.parse(PM_PAY_SOURCE.lastReviewed);
  return Number.isFinite(t) && (now - t) / (30.436875 * 86400000) > 14;
}

// ---------------------------------------------------------------------------
// Role -> SOC 2020 join key
//
// The crosswalk itself, with its market titles, notes and per-row confidence,
// lives in benchmarks.json. This table is only the JOIN KEY: it maps the names
// this corpus uses — meta.profs entries and meta.grades entries — onto the SOC
// code the crosswalk is filed under. Where there is no defensible comparator
// the answer is null, which is a finding, not a gap to be papered over.
// ---------------------------------------------------------------------------

export interface SocJoin {
  soc2020: string;
  /** the `scsRole` key in benchmarks.json crosswalk[] */
  scsRole: string;
  confidence: 'fact' | 'hypothesis';
  note?: string;
}

/** Keyed by the profession name as published in meta.profs. */
export const PROFESSION_SOC: Record<string, SocJoin> = {
  'Communications': { soc2020: '1133', scsRole: 'Communications', confidence: 'fact' },
  'Commercial': { soc2020: '1134', scsRole: 'Commercial', confidence: 'fact' },
  'Digital, Data & Technology': { soc2020: '1137', scsRole: 'Digital, Data and Technology', confidence: 'fact' },
  'Economics': { soc2020: '2433', scsRole: 'Economics and Statistics', confidence: 'fact' },
  'Statistics': { soc2020: '2433', scsRole: 'Economics and Statistics', confidence: 'fact' },
  'Finance': { soc2020: '1131', scsRole: 'Finance', confidence: 'fact' },
  'Human Resources': { soc2020: '1136', scsRole: 'Human Resources', confidence: 'fact', note: 'Not 1135 — that is charitable-organisation managers.' },
  'Legal': { soc2020: '2412', scsRole: 'Legal', confidence: 'hypothesis', note: 'Depressed by junior and part-time staff; use p75 against SCS grades.' },
  'Medical & Health': { soc2020: '1171', scsRole: 'Medical and Health', confidence: 'fact' },
  'Project Delivery': { soc2020: '2440', scsRole: 'Project Delivery', confidence: 'fact' },
  'Policy': { soc2020: '2431', scsRole: 'Policy and analysis', confidence: 'hypothesis', note: 'The weakest match in the crosswalk. Policy also reads high in this corpus because "Policy Profession" is the template default.' },
  'Planning Inspectors': { soc2020: '2482', scsRole: 'Regulation and inspection', confidence: 'hypothesis' },
  'Inspector of Education and Training': { soc2020: '2482', scsRole: 'Regulation and inspection', confidence: 'hypothesis' },
};

/** Keyed by the grade band name as published in meta.grades. */
export const GRADE_SOC: Record<string, SocJoin> = {
  'SCS4 / Perm Sec': { soc2020: '1111', scsRole: 'Permanent Secretary / Director General (SCS3-4)', confidence: 'hypothesis', note: 'SOC 1111 has a long right tail; use p75, never the mean or the median.' },
  'SCS3 (Dir Gen)': { soc2020: '1111', scsRole: 'Permanent Secretary / Director General (SCS3-4)', confidence: 'hypothesis' },
  'SCS2 (Dir)': { soc2020: '1139', scsRole: 'Director / Deputy Director, generic', confidence: 'hypothesis' },
  'SCS1 (Dep Dir)': { soc2020: '1139', scsRole: 'Director / Deputy Director, generic', confidence: 'hypothesis' },
};

export const socForProfession = (name: string): SocJoin | null => PROFESSION_SOC[name] ?? null;
export const socForGrade = (name: string): SocJoin | null => GRADE_SOC[name] ?? null;

/**
 * The join key for a selection. Profession wins over grade when both are
 * given: an SCS2 finance director is better compared with finance directors
 * than with all directors.
 */
export function socJoin(sel: { profession?: string | null; grade?: string | null }): SocJoin | null {
  return (sel.profession ? socForProfession(sel.profession) : null)
    ?? (sel.grade ? socForGrade(sel.grade) : null);
}

/** Professions this study will not offer a market comparator for. */
export const professionsWithoutComparator = (profs: string[]): string[] =>
  profs.filter((p) => !PROFESSION_SOC[p]);
