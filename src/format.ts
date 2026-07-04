// Number / currency / delta formatting helpers.

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

export function num(n: number | null, dp = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(n: number | null, dp = 1, sign = true): string {
  if (n == null || Number.isNaN(n)) return '—';
  const s = n >= 0 && sign ? '+' : '';
  return `${s}${n.toFixed(dp)}%`;
}

// value formatter chosen by measure
export function measureFormat(measure: string): (n: number | null) => string {
  if (measure === 'headcount' || measure === 'fte') return (n) => num(n, measure === 'fte' ? 1 : 0);
  if (measure === 'paybill') return (n) => gbp(n, { compact: true });
  return (n) => gbp(n);
}

export function measureLabel(measure: string): string {
  return ({
    medianPost: 'Median pay', meanPost: 'Mean pay', p25: 'Lower-quartile pay',
    p75: 'Upper-quartile pay', meanFTE: 'Mean pay (per FTE)', headcount: 'Senior posts',
    fte: 'Senior FTE', paybill: 'Senior pay bill',
  } as Record<string, string>)[measure] || measure;
}
