// Number / currency / delta formatting.
//
// One rule governs everything below: a figure is printed at the precision the
// publisher actually published at, and no finer.
//   - Band edges (a published pay floor or ceiling) print exactly: £95,000.
//     They are published values, not estimates, and rounding them would state
//     an edge nobody filed.
//   - Anything DERIVED from them — a mean, a pay bill — rounds to £1,000,
//     because the underlying arithmetic runs over £5,000-wide bands and a
//     figure to the pound would claim a precision the source cannot support.

export function gbp(n: number | null, opts: { compact?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (opts.compact) {
    const a = Math.abs(n);
    if (a >= 1e9) return `£${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}bn`;
    if (a >= 1e6) return `£${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
    if (a >= 1e3) return `£${Math.round(n / 1e3)}k`;
    return `£${Math.round(n)}`;
  }
  return '£' + Math.round(n).toLocaleString('en-GB');
}

/** A derived money figure, rounded to the nearest £1,000. */
export function gbpRounded(n: number | null): string {
  if (n == null || Number.isNaN(n)) return '—';
  return '£' + (Math.round(n / 1000) * 1000).toLocaleString('en-GB');
}

export function num(n: number | null, dp = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(n: number | null, dp = 1, sign = true): string {
  if (n == null || Number.isNaN(n)) return '—';
  const s = n >= 0 && sign ? '+' : '';
  return `${s}${n.toFixed(dp)}%`;
}

/** A 0..1 fraction as a share: 0.349 -> "34.9%". */
export function share(n: number | null, dp = 1): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(dp)}%`;
}

/** A 0..1 fraction rounded to whole per cent, for prose. */
export const shareRough = (n: number | null): string => (n == null || Number.isNaN(n) ? '—' : `${Math.round(n * 100)}%`);

/** The only honest way to print a pay figure from this corpus. */
export function band(lo: number | null, hi: number | null, fmt: (n: number | null) => string = gbp): string {
  if (lo == null && hi == null) return '—';
  if (lo == null || hi == null) return fmt(lo ?? hi);
  if (lo === hi) return fmt(lo);
  return `${fmt(lo)}–${fmt(hi)}`;
}

/** A change expressed as the range the bounds allow: "+12% to +19%". */
export function pctBand(lo: number | null, hi: number | null, dp = 0): string {
  if (lo == null && hi == null) return '—';
  if (lo == null || hi == null) return pct(lo ?? hi, dp);
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const la = pct(a, dp), lb = pct(b, dp);
  // Collapse on the PRINTED figures, not the raw ones: a range whose two ends
  // round to the same string ("+1586% to +1586%") is a point wearing a range's
  // clothes, and reads as a rendering fault rather than as honesty.
  if (la === lb) return la;
  if (Math.abs(a - b) < 0.5) return pct((a + b) / 2, dp);
  return `${la} to ${lb}`;
}

/** Rounding step for a DERIVED figure: £1,000 floor, three significant figures. */
function sigStep(n: number): number {
  const a = Math.abs(n);
  if (!(a > 0) || !Number.isFinite(a)) return 1000;
  return Math.max(1000, Math.pow(10, Math.floor(Math.log10(a)) - 2));
}

/**
 * An aggregate pay figure as a range, rounded OUTWARDS so the printed range
 * always contains the true one. Never call this on a published post band — a
 * department's own £145,000–£149,999 prints verbatim through band().
 */
export function roundedBand(lo: number | null | undefined, hi: number | null | undefined): string {
  if (lo == null || hi == null || Number.isNaN(lo) || Number.isNaN(hi)) return '—';
  const step = sigStep(Math.max(Math.abs(lo), Math.abs(hi)));
  const l = Math.floor(lo / step) * step;
  const u = Math.ceil(hi / step) * step;
  return l === u ? gbp(l) : `${gbp(l)}–${gbp(u)}`;
}

/** A single derived aggregate, at the same precision as roundedBand. */
export function roundedFigure(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  const step = sigStep(n);
  return gbp(Math.round(n / step) * step);
}

/**
 * A count that is genuinely a range — posts either side of a threshold a
 * £5,000 band cannot resolve. Collapses when both ends agree, so a point does
 * not wear a range's clothes.
 */
export function countRange(certain: number | null, possible: number | null): string {
  if (certain == null || possible == null) return '—';
  return certain === possible ? num(certain) : `${num(certain)}–${num(possible)}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2011-03-31` -> `31 March 2011`. */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return iso || '—';
  const y = iso.slice(0, 4), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  return `${d} ${MONTHS[m - 1] ?? ''} ${y}`.trim();
}

/** Rate measures print as a share; money as money; counts as counts. */
const RATE_MEASURES = ['disclosureRate', 'fteKnownRate'];
const COUNT_MEASURES = ['headcount', 'fte', 'disclosed', 'withheld', 'vacant', 'eliminated', 'openBand', 'posts'];
const DERIVED_MONEY = ['meanPay', 'meanPost', 'meanFTE'];

export function measureFormat(measure: string): (n: number | null) => string {
  if (RATE_MEASURES.includes(measure)) return (n) => share(n);
  if (measure === 'fte') return (n) => num(n, 1);
  if (COUNT_MEASURES.includes(measure)) return (n) => num(n, 0);
  if (measure === 'paybill') return (n) => gbp(n, { compact: true });
  if (DERIVED_MONEY.includes(measure)) return (n) => gbpRounded(n);
  return (n) => gbp(n);
}

export function measureLabel(measure: string): string {
  return (({
    medianPay: 'Median pay band',
    meanPay: 'Mean pay',
    p10: 'Lowest decile',
    p25: 'Lower quartile',
    p75: 'Upper quartile',
    p90: 'Top decile',
    paybill: 'Senior pay bill',
    headcount: 'Senior posts',
    fte: 'Senior FTE',
    disclosureRate: 'Disclosure rate',
    disclosed: 'Posts with a published band',
    withheld: 'Posts with pay withheld',
    vacant: 'Vacant posts',
    eliminated: 'Eliminated posts',
    openBand: 'Posts with one band edge only',
    posts: 'Published post rows',
    fteKnownRate: 'Share with a published FTE',
    // legacy names, still resolvable
    medianPost: 'Median pay band',
    meanPost: 'Mean pay',
    meanFTE: 'Mean pay per FTE',
  } as Record<string, string>)[measure]) || measure;
}

/** The unit line under a figure. */
export function measureUnit(measure: string): string {
  if (RATE_MEASURES.includes(measure)) return 'share of published senior posts';
  if (measure === 'headcount' || measure === 'posts') return 'published senior posts';
  if (measure === 'fte') return 'full-time equivalent';
  if (measure === 'paybill') return '£ per year, base pay, FTE-weighted';
  if (COUNT_MEASURES.includes(measure)) return 'posts';
  return '£ per year, base pay';
}
