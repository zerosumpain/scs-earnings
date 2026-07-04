// Shared: turn AppState into a data-layer Filter. Kept separate so every tab
// builds filters identically.
import type { Filter } from './data';
import type { AppState } from './state';

export function stateToFilter(s: AppState, extra: Partial<Filter> = {}): Filter {
  return {
    depts: s.depts.length ? new Set(s.depts) : null,
    profs: s.profs.length ? new Set(s.profs) : null,
    grades: s.grades.length ? new Set(s.grades) : null,
    ddat: s.ddat === 1 ? true : s.ddat === 2 ? false : null,
    policy: s.policy === 1 ? true : s.policy === 2 ? false : null,
    realTerms: s.realTerms,
    ...extra,
  };
}

// UK Prime Minister's total pay (salary entitlement) by year — used for the
// "more than the PM" benchmark. Source: gov.uk ministerial salary data; the PM
// entitlement has been broadly flat in nominal terms. Value used as the
// reference line (£ total: parliamentary + ministerial entitlement).
export const PM_PAY: Record<number, number> = {
  2010: 142500, 2011: 142500, 2012: 142500, 2013: 142500, 2014: 142500,
  2015: 149440, 2016: 150402, 2017: 152819, 2018: 155602, 2019: 158754,
  2020: 161401, 2021: 161866, 2022: 164080, 2023: 167391, 2024: 172153,
  2025: 172153, 2026: 172153,
};
export function pmPayFor(periodOrYear: string | number): number {
  const y = typeof periodOrYear === 'number' ? periodOrYear : Number(String(periodOrYear).slice(0, 4));
  const years = Object.keys(PM_PAY).map(Number);
  return PM_PAY[y] ?? PM_PAY[Math.max(...years.filter(z => z <= y))] ?? 172153;
}
