// Bespoke SVG charts — warm-brutalist, dependency-free. Built as real SVG DOM
// so hover crosshair + tooltips work. Follows the dataviz method: thin 2px
// marks, recessive grid, legend for >=2 series, direct labels for <=4, table
// view for the contrast-relief requirement.

const SVGNS = 'http://www.w3.org/2000/svg';

// locked warm categorical palette (validated: lightness/chroma/CVD pass)
export const PALETTE = ['#c4570a', '#12988a', '#b8820a', '#b83c6b', '#5b8a2a', '#7d5bd0', '#cf5aa0'];
export const OTHER_COLOR = '#8a7a63';
export const INK = '#1a1008';
export const INK2 = '#3d2e1a';
export const MUTED = 'rgba(26,16,8,0.55)';
export const GRID = 'rgba(26,16,8,0.09)';
export const AXIS = 'rgba(26,16,8,0.22)';

export function colorFor(index: number, key?: string): string {
  if (key === 'other' || key === '__other') return OTHER_COLOR;
  return PALETTE[index % PALETTE.length];
}

function el(name: string, attrs: Record<string, string | number> = {}, parent?: SVGElement): SVGElement {
  const e = document.createElementNS(SVGNS, name) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

export interface Series { key: string; label: string; color: string; values: (number | null)[]; }

export interface LineChartOpts {
  labels: string[];                 // x categories (periods)
  series: Series[];
  yFormat: (n: number | null) => string;
  height?: number;
  yZero?: boolean;                  // force y-axis start at 0
  highlightKey?: string | null;
  onHoverIndex?: (i: number | null) => void;
}

// nice y-axis ticks
function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const raw = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export function lineChart(container: HTMLElement, opts: LineChartOpts): void {
  container.innerHTML = '';
  const H = opts.height ?? 340;
  const W = Math.max(container.clientWidth || 640, 320);
  const m = { top: 16, right: 66, bottom: 34, left: 58 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img',
    style: 'display:block;overflow:visible' }) as SVGSVGElement;
  container.appendChild(svg);

  // y-domain
  let lo = Infinity, hi = -Infinity;
  for (const s of opts.series) for (const v of s.values) if (v != null && !Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (opts.yZero) lo = Math.min(lo, 0);
  else lo = lo - (hi - lo) * 0.08;
  const ticks = niceTicks(lo, hi, 5);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const n = opts.labels.length;
  const x = (i: number) => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => m.top + ih - ((v - lo) / (hi - lo)) * ih;

  // gridlines + y labels
  for (const t of ticks) {
    const yy = y(t);
    el('line', { x1: m.left, y1: yy, x2: m.left + iw, y2: yy, stroke: GRID, 'stroke-width': 1 }, svg);
    const lab = el('text', { x: m.left - 8, y: yy + 3, 'text-anchor': 'end', fill: MUTED,
      'font-size': 10, 'font-family': 'JetBrains Mono, monospace' }, svg);
    lab.textContent = opts.yFormat(t);
  }
  // x labels (thin out to avoid collisions)
  const every = Math.ceil(n / 9);
  for (let i = 0; i < n; i++) {
    if (i % every !== 0 && i !== n - 1) continue;
    const t = el('text', { x: x(i), y: H - 12, 'text-anchor': 'middle', fill: MUTED,
      'font-size': 10, 'font-family': 'JetBrains Mono, monospace' }, svg);
    t.textContent = opts.labels[i];
  }
  // baseline
  el('line', { x1: m.left, y1: m.top + ih, x2: m.left + iw, y2: m.top + ih, stroke: AXIS, 'stroke-width': 1 }, svg);

  // lines
  const dim = (k: string) => opts.highlightKey && opts.highlightKey !== k;
  for (const s of opts.series) {
    // build path across non-null runs
    let d = '';
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v == null || Number.isNaN(v)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': dim(s.key) ? 1 : 2.2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: dim(s.key) ? 0.28 : 1 }, svg);
  }

  // direct labels at last valid point when <=4 series
  if (opts.series.length <= 4) {
    for (const s of opts.series) {
      let li = -1; for (let i = n - 1; i >= 0; i--) if (s.values[i] != null) { li = i; break; }
      if (li < 0) continue;
      const t = el('text', { x: x(li) + 6, y: y(s.values[li]!) + 3, fill: s.color, 'font-size': 10.5,
        'font-weight': 700, 'font-family': 'DM Sans, sans-serif' }, svg);
      t.textContent = s.label.length > 16 ? s.label.slice(0, 15) + '…' : s.label;
    }
  }

  // hover layer: crosshair + focus dots + tooltip
  const focus = el('line', { x1: 0, y1: m.top, x2: 0, y2: m.top + ih, stroke: AXIS, 'stroke-width': 1,
    opacity: 0, 'stroke-dasharray': '3 3' }, svg);
  const dots = opts.series.map(s => el('circle', { r: 4, fill: s.color, stroke: '#ede4d4', 'stroke-width': 1.5, opacity: 0 }, svg));
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.cssText = 'position:absolute;pointer-events:none;opacity:0;transition:opacity .08s;z-index:20';
  container.style.position = 'relative';
  container.appendChild(tip);

  const overlay = el('rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent',
    style: 'cursor:crosshair' }, svg);
  const nearest = (px: number) => {
    if (n <= 1) return 0;
    const i = Math.round(((px - m.left) / iw) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };
  const move = (evt: MouseEvent | Touch) => {
    const rect = svg.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (W / rect.width);
    const i = nearest(px);
    focus.setAttribute('x1', String(x(i))); focus.setAttribute('x2', String(x(i))); focus.setAttribute('opacity', '1');
    let rows = '';
    opts.series.forEach((s, si) => {
      const v = s.values[i];
      if (v == null || Number.isNaN(v)) { dots[si].setAttribute('opacity', '0'); return; }
      dots[si].setAttribute('cx', String(x(i))); dots[si].setAttribute('cy', String(y(v))); dots[si].setAttribute('opacity', '1');
      rows += `<div class="tip-row"><span class="tip-dot" style="background:${s.color}"></span><span class="tip-lab">${s.label}</span><span class="tip-val">${opts.yFormat(v)}</span></div>`;
    });
    tip.innerHTML = `<div class="tip-head">${opts.labels[i]}</div>${rows}`;
    const rx = x(i) / W * (container.clientWidth);
    tip.style.left = Math.min(container.clientWidth - 180, Math.max(0, rx + 12)) + 'px';
    tip.style.top = m.top + 'px';
    tip.style.opacity = '1';
    opts.onHoverIndex?.(i);
  };
  const leave = () => { focus.setAttribute('opacity', '0'); dots.forEach(d => d.setAttribute('opacity', '0')); tip.style.opacity = '0'; opts.onHoverIndex?.(null); };
  overlay.addEventListener('mousemove', (e) => move(e as MouseEvent));
  overlay.addEventListener('mouseleave', leave);
  overlay.addEventListener('touchmove', (e) => { const t = (e as TouchEvent).touches[0]; if (t) move(t); }, { passive: true });
  overlay.addEventListener('touchend', leave);
}

export interface BarChartOpts {
  rows: { key: string; label: string; value: number | null; color?: string }[];
  valueFormat: (n: number | null) => string;
  height?: number;
  highlightKey?: string | null;
}

// horizontal ranked bar chart
export function barChart(container: HTMLElement, opts: BarChartOpts): void {
  container.innerHTML = '';
  const rows = opts.rows.filter(r => r.value != null && !Number.isNaN(r.value as number));
  const W = Math.max(container.clientWidth || 640, 320);
  const rowH = 26, gap = 6, top = 6;
  const H = opts.height ?? (rows.length * (rowH + gap) + top + 10);
  const labelW = Math.min(190, Math.max(...rows.map(r => r.label.length)) * 6.5 + 12);
  const m = { left: labelW, right: 72 };
  const iw = W - m.left - m.right;
  const max = Math.max(1, ...rows.map(r => Math.abs(r.value as number)));

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, style: 'display:block' }) as SVGSVGElement;
  container.appendChild(svg);
  container.style.position = 'relative';

  rows.forEach((r, i) => {
    const yy = top + i * (rowH + gap);
    const w = (Math.abs(r.value as number) / max) * iw;
    const color = r.color || colorFor(i, r.key);
    const dim = opts.highlightKey && opts.highlightKey !== r.key;
    // label
    const lab = el('text', { x: m.left - 10, y: yy + rowH / 2 + 4, 'text-anchor': 'end', fill: INK2,
      'font-size': 11.5, 'font-family': 'DM Sans, sans-serif' }, svg);
    lab.textContent = r.label.length > 30 ? r.label.slice(0, 29) + '…' : r.label;
    // bar with rounded data-end
    el('rect', { x: m.left, y: yy, width: Math.max(2, w), height: rowH, rx: 3, fill: color, opacity: dim ? 0.3 : 0.92 }, svg);
    // value
    const val = el('text', { x: m.left + Math.max(2, w) + 8, y: yy + rowH / 2 + 4, fill: INK,
      'font-size': 11, 'font-weight': 600, 'font-family': 'JetBrains Mono, monospace' }, svg);
    val.textContent = opts.valueFormat(r.value);
  });
}

// ---- 100% stacked area (profession/grade mix over time) ----
export interface StackOpts { labels: string[]; series: Series[]; percent?: boolean; valueFormat: (n: number | null) => string; height?: number; }
export function stackedArea(container: HTMLElement, opts: StackOpts): void {
  container.innerHTML = '';
  const H = opts.height ?? 320;
  const W = Math.max(container.clientWidth || 640, 320);
  const m = { top: 12, right: 120, bottom: 34, left: 46 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const n = opts.labels.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, style: 'display:block;overflow:visible' }) as SVGSVGElement;
  container.appendChild(svg);
  container.style.position = 'relative';

  // column totals
  const totals = new Array(n).fill(0);
  for (const s of opts.series) for (let i = 0; i < n; i++) totals[i] += (s.values[i] ?? 0);
  const maxTotal = opts.percent ? 1 : Math.max(1, ...totals);
  const x = (i: number) => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yTop = m.top, yBot = m.top + ih;
  const val = (v: number, i: number) => opts.percent ? (totals[i] ? v / totals[i] : 0) : v;

  // cumulative baselines
  const base = new Array(n).fill(0);
  for (const s of opts.series) {
    const upper: [number, number][] = [], lower: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const b = base[i];
      const t = b + val(s.values[i] ?? 0, i);
      const y0 = yBot - (b / maxTotal) * ih, y1 = yBot - (t / maxTotal) * ih;
      lower.push([x(i), y0]); upper.push([x(i), y1]);
      base[i] = t;
    }
    let d = 'M' + upper.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
    d += ' L' + lower.reverse().map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L') + ' Z';
    el('path', { d, fill: s.color, opacity: 0.88, stroke: '#ede4d4', 'stroke-width': 0.75 }, svg);
    // direct label at right — only when the final segment is tall enough to
    // avoid label collisions on thin slivers
    const lastSeg = val(s.values[n - 1] ?? 0, n - 1) / maxTotal * ih;
    if (lastSeg >= 12) {
      const lyRaw = yBot - ((base[n - 1] - val(s.values[n - 1] ?? 0, n - 1) / 2) / maxTotal) * ih;
      const t = el('text', { x: m.left + iw + 6, y: lyRaw + 3, fill: s.color, 'font-size': 10.5, 'font-weight': 700, 'font-family': 'DM Sans, sans-serif' }, svg);
      t.textContent = s.label.length > 18 ? s.label.slice(0, 17) + '…' : s.label;
    }
  }
  // y gridlines (0/50/100 for percent)
  const yticks = opts.percent ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, maxTotal, 4);
  for (const yt of yticks) {
    const yy = yBot - (yt / maxTotal) * ih;
    el('line', { x1: m.left, y1: yy, x2: m.left + iw, y2: yy, stroke: GRID, 'stroke-width': 1 }, svg);
    const lab = el('text', { x: m.left - 8, y: yy + 3, 'text-anchor': 'end', fill: MUTED, 'font-size': 10, 'font-family': 'JetBrains Mono, monospace' }, svg);
    lab.textContent = opts.percent ? Math.round(yt * 100) + '%' : opts.valueFormat(yt);
  }
  const every = Math.ceil(n / 9);
  for (let i = 0; i < n; i++) { if (i % every !== 0 && i !== n - 1) continue;
    const t = el('text', { x: x(i), y: H - 12, 'text-anchor': 'middle', fill: MUTED, 'font-size': 10, 'font-family': 'JetBrains Mono, monospace' }, svg); t.textContent = opts.labels[i]; }

  // hover tooltip
  const tip = document.createElement('div'); tip.className = 'chart-tip'; tip.style.cssText = 'position:absolute;pointer-events:none;opacity:0;z-index:20';
  container.appendChild(tip);
  const focus = el('line', { x1: 0, y1: yTop, x2: 0, y2: yBot, stroke: AXIS, 'stroke-width': 1, opacity: 0, 'stroke-dasharray': '3 3' }, svg);
  const ov = el('rect', { x: m.left, y: yTop, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair' }, svg);
  ov.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect(); const px = ((e as MouseEvent).clientX - rect.left) * (W / rect.width);
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.left) / iw) * (n - 1))));
    focus.setAttribute('x1', String(x(i))); focus.setAttribute('x2', String(x(i))); focus.setAttribute('opacity', '1');
    const rows = [...opts.series].map(s => ({ s, v: s.values[i] ?? 0 })).filter(r => r.v > 0).sort((a, b) => b.v - a.v)
      .map(r => `<div class="tip-row"><span class="tip-dot" style="background:${r.s.color}"></span><span class="tip-lab">${r.s.label}</span><span class="tip-val">${opts.percent ? ((totals[i] ? r.v / totals[i] * 100 : 0).toFixed(1) + '%') : opts.valueFormat(r.v)}</span></div>`).join('');
    tip.innerHTML = `<div class="tip-head">${opts.labels[i]}</div>${rows}`;
    tip.style.left = Math.min(container.clientWidth - 190, Math.max(0, x(i) / W * container.clientWidth + 12)) + 'px';
    tip.style.top = '8px'; tip.style.opacity = '1';
  });
  ov.addEventListener('mouseleave', () => { tip.style.opacity = '0'; focus.setAttribute('opacity', '0'); });
}

// ---- sequential/diverging heatmap ----
export interface HeatOpts {
  cols: string[]; rows: { key: string; label: string }[];
  value: (rowKey: string, col: number) => number | null;
  format: (n: number | null) => string;
  diverging?: boolean;   // true = premium (two-hue), false = magnitude (one-hue)
  midpoint?: number;     // diverging midpoint (default 0)
  cellH?: number;
}
// warm sequential ramp cream->orange->coffee; diverging teal<->cream->orange
function lerp(a: number[], b: number[], t: number) { return a.map((x, i) => Math.round(x + (b[i] - x) * t)); }
function rgb(c: number[]) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
const SEQ = [[240, 230, 214], [230, 160, 90], [196, 87, 10], [120, 52, 8]]; // cream->orange->coffee
const DIV_LO = [18, 152, 138], DIV_MID = [237, 228, 212], DIV_HI = [196, 87, 10];
function seqColor(t: number) { t = Math.max(0, Math.min(1, t)); const seg = t * (SEQ.length - 1); const i = Math.min(SEQ.length - 2, Math.floor(seg)); return rgb(lerp(SEQ[i], SEQ[i + 1], seg - i)); }
function divColor(t: number) { t = Math.max(-1, Math.min(1, t)); return t < 0 ? rgb(lerp(DIV_MID, DIV_LO, -t)) : rgb(lerp(DIV_MID, DIV_HI, t)); }

export function heatmap(container: HTMLElement, opts: HeatOpts): void {
  container.innerHTML = ''; container.style.position = 'relative';
  const rows = opts.rows, cols = opts.cols;
  const labelW = Math.min(200, Math.max(...rows.map(r => r.label.length)) * 6.4 + 10);
  const cellH = opts.cellH ?? 22;
  const W = Math.max(container.clientWidth || 700, 360);
  const gridW = W - labelW - 8;
  const cw = gridW / cols.length;
  const H = rows.length * cellH + 46;
  // value range
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) for (let c = 0; c < cols.length; c++) { const v = opts.value(r.key, c); if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const mid = opts.midpoint ?? 0;
  const absMax = Math.max(Math.abs(hi - mid), Math.abs(lo - mid)) || 1;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, style: 'display:block' }) as SVGSVGElement;
  container.appendChild(svg);
  const tip = document.createElement('div'); tip.className = 'chart-tip'; tip.style.cssText = 'position:absolute;pointer-events:none;opacity:0;z-index:20'; container.appendChild(tip);

  const every = Math.ceil(cols.length / 8);
  cols.forEach((c, ci) => { if (ci % every !== 0 && ci !== cols.length - 1) return;
    const t = el('text', { x: labelW + ci * cw + cw / 2, y: 12, 'text-anchor': 'middle', fill: MUTED, 'font-size': 9.5, 'font-family': 'JetBrains Mono, monospace' }, svg); t.textContent = c; });

  rows.forEach((r, ri) => {
    const yy = 22 + ri * cellH;
    const lab = el('text', { x: labelW - 6, y: yy + cellH / 2 + 3, 'text-anchor': 'end', fill: INK2, 'font-size': 11, 'font-family': 'DM Sans, sans-serif' }, svg);
    lab.textContent = r.label.length > 30 ? r.label.slice(0, 29) + '…' : r.label;
    cols.forEach((c, ci) => {
      const v = opts.value(r.key, ci);
      const fill = v == null ? 'rgba(26,16,8,0.04)' : opts.diverging ? divColor((v - mid) / absMax) : seqColor((v - lo) / (hi - lo || 1));
      const cell = el('rect', { x: labelW + ci * cw, y: yy, width: Math.max(1, cw - 1), height: cellH - 1, fill, rx: 1 }, svg);
      cell.addEventListener('mousemove', (e) => {
        tip.innerHTML = `<div class="tip-head">${r.label}</div><div class="tip-row"><span class="tip-lab">${c}</span><span class="tip-val">${opts.format(v)}</span></div>`;
        const rect = container.getBoundingClientRect();
        tip.style.left = Math.min(container.clientWidth - 170, (e as MouseEvent).clientX - rect.left + 10) + 'px';
        tip.style.top = ((e as MouseEvent).clientY - rect.top + 10) + 'px'; tip.style.opacity = '1';
      });
      cell.addEventListener('mouseleave', () => tip.style.opacity = '0');
    });
  });
}

// ---- distribution fan (median with p25-p75 band) ----
export function fanChart(container: HTMLElement, opts: { labels: string[]; lo: (number | null)[]; mid: (number | null)[]; hi: (number | null)[]; color: string; yFormat: (n: number | null) => string; height?: number }): void {
  container.innerHTML = '';
  const H = opts.height ?? 300, W = Math.max(container.clientWidth || 640, 320);
  const m = { top: 14, right: 20, bottom: 34, left: 58 }, iw = W - m.left - m.right, ih = H - m.top - m.bottom, n = opts.labels.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, style: 'display:block' }) as SVGSVGElement; container.appendChild(svg);
  let lo = Infinity, hi = -Infinity;
  for (const a of [opts.lo, opts.hi]) for (const v of a) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  lo -= (hi - lo) * 0.08;
  const ticks = niceTicks(lo, hi, 5); lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = (i: number) => m.left + (n <= 1 ? iw / 2 : i / (n - 1) * iw);
  const y = (v: number) => m.top + ih - (v - lo) / (hi - lo) * ih;
  for (const t of ticks) { const yy = y(t); el('line', { x1: m.left, y1: yy, x2: m.left + iw, y2: yy, stroke: GRID, 'stroke-width': 1 }, svg);
    const l = el('text', { x: m.left - 8, y: yy + 3, 'text-anchor': 'end', fill: MUTED, 'font-size': 10, 'font-family': 'JetBrains Mono, monospace' }, svg); l.textContent = opts.yFormat(t); }
  const every = Math.ceil(n / 9);
  for (let i = 0; i < n; i++) { if (i % every !== 0 && i !== n - 1) continue; const t = el('text', { x: x(i), y: H - 12, 'text-anchor': 'middle', fill: MUTED, 'font-size': 10, 'font-family': 'JetBrains Mono, monospace' }, svg); t.textContent = opts.labels[i]; }
  // band polygon
  const up: string[] = [], dn: string[] = [];
  for (let i = 0; i < n; i++) { if (opts.hi[i] == null) continue; up.push(`${x(i).toFixed(1)},${y(opts.hi[i]!).toFixed(1)}`); }
  for (let i = n - 1; i >= 0; i--) { if (opts.lo[i] == null) continue; dn.push(`${x(i).toFixed(1)},${y(opts.lo[i]!).toFixed(1)}`); }
  el('path', { d: 'M' + up.join(' L') + ' L' + dn.join(' L') + ' Z', fill: opts.color, opacity: 0.16 }, svg);
  // median line
  let d = '', pen = false;
  for (let i = 0; i < n; i++) { const v = opts.mid[i]; if (v == null) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true; }
  el('path', { d, fill: 'none', stroke: opts.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, svg);
  el('line', { x1: m.left, y1: m.top + ih, x2: m.left + iw, y2: m.top + ih, stroke: AXIS, 'stroke-width': 1 }, svg);
}

// shared legend row (identity is never colour-alone: legend + tooltip + labels)
export function legend(series: { label: string; color: string }[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  for (const s of series) {
    const lg = document.createElement('span'); lg.className = 'lg';
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = s.color;
    lg.append(sw, document.createTextNode(s.label));
    wrap.append(lg);
  }
  return wrap;
}

// accessible table view for a set of series (contrast-relief requirement)
export function seriesTable(labels: string[], series: Series[], fmt: (n: number | null) => string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  const t = document.createElement('table');
  t.className = 'data-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Period</th>${series.map(s => `<th>${s.label}</th>`).join('')}</tr>`;
  t.appendChild(thead);
  const tb = document.createElement('tbody');
  labels.forEach((lab, i) => {
    tb.innerHTML += `<tr><td class="tperiod">${lab}</td>${series.map(s => `<td>${fmt(s.values[i])}</td>`).join('')}</tr>`;
  });
  t.appendChild(tb);
  wrap.appendChild(t);
  return wrap;
}
