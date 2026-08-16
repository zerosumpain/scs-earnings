// Bespoke SVG charts — warm-brutalist, dependency-free. Built as real SVG DOM
// so hover crosshair + tooltips work. Follows the dataviz method: thin 2px
// marks, recessive grid, legend for >=2 series, direct labels for <=4, table
// view for the contrast-relief requirement.
//
// SIZING CONTRACT (read this before changing anything about width or height).
// Every chart is drawn into a host that is frequently DETACHED at call time —
// the tab modules build their card off-document and append it afterwards. A
// detached host reports clientWidth 0, so a measure-once chart silently fell
// back to 640 user units inside a 1100px card and `preserveAspectRatio=meet`
// letterboxed it: up to 460px of dead gutter, and on a 390px phone the whole
// drawing scaled to 0.48x, rendering 10px axis text at 4.8 CSS px.
//
// The fix is a ResizeObserver attached to the produced <svg> itself. The first
// observation fires with the real box once the node lands in the document,
// even though it was detached when the chart was constructed, so call sites
// need no ordering discipline at all. Every box change redraws, debounced to
// an animation frame.
//
// Consequence, and the reason it matters: the SVG carries no fixed height
// attribute and the viewBox always equals the measured CSS box, so 1 viewBox
// unit == 1 CSS px. That is what lets font-size come from the design tokens
// (a `var(--fs-label-xs)` renders at a true 12px, the hard floor) and what
// makes tooltip coordinates line up with the pointer without a scale factor.

const SVGNS = 'http://www.w3.org/2000/svg';

/** Width used only for the very first paint of a chart built off-document.
 *  The ResizeObserver corrects it before the frame is presented. */
const FALLBACK_W = 640;
/** Never scale the drawing below 1:1 — shrinking is what pushed axis text
 *  under the 12px floor. Below this the chart lays out tighter instead. */
const MIN_W = 200;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

// Categorical hues, validated against the card surface #f3ebdd on all pairs:
// lightness band PASS, chroma floor PASS, CVD separation worst dE 13.8
// (#12988a vs #c4570a, deutan), normal-vision floor worst dE 16.8, contrast
// all four >= 3:1. Four is the ceiling — the previous seven-slot set failed
// CVD separation at dE 2.0 and the normal-vision floor at dE 9.9, i.e. two
// pairs of series were indistinguishable to somebody and one pair was
// indistinguishable to everybody.
export const PALETTE = ['#c4570a', '#12988a', '#8a2d3a', '#7d5bd0'];

/** Hard ceiling on categorical slots. Rank 5+ is not a fifth hue, it is
 *  "everything else" — see colorFor. */
export const MAX_CATEGORICAL = PALETTE.length;

// Ordinal ramp for a ranked dimension (SCS1 -> SCS4). Single hue, spread 16
// degrees, monotone lightness, adjacent dL >= 0.06, light end 2.00:1.
// An ordinal dimension dressed in categorical hues is a lie about the data.
export const ORDINAL_PALETTE = ['#dd9a5e', '#c4570a', '#8a3a08', '#4d1f02'];

// "Other" is not a colour, it is the absence of emphasis. --text-ghost. The
// old #8a7a63 had chroma 0.039: it failed the 0.1 floor and read as grey, in
// a system whose founding rule is that there are no greys.
export const OTHER_COLOR = 'rgba(26,16,8,0.45)';

export const INK = '#1a1008';
export const INK2 = '#3d2e1a';
export const MUTED = 'rgba(26,16,8,0.55)';
export const GRID = 'rgba(26,16,8,0.09)';
export const AXIS = 'rgba(26,16,8,0.22)';
/** Card surface, for knock-out rings and the gaps between stacked fills. */
export const SURFACE = 'var(--surface-card, #f3ebdd)';

/** Categorical colour by rank. Beyond the fourth slot the answer is not a
 *  fifth hue — wrapping the palette would hand two different series the same
 *  colour and make the legend a lie — it is the ghost, which reads as
 *  "not the point". */
export function colorFor(index: number, key?: string): string {
  if (key === 'other' || key === '__other') return OTHER_COLOR;
  if (index < 0 || index >= PALETTE.length) return OTHER_COLOR;
  return PALETTE[index];
}

/** Ordinal colour for step `index` of `count` on a ranked scale. */
export function ordinalColor(index: number, count = ORDINAL_PALETTE.length): string {
  if (count <= 1) return ORDINAL_PALETTE[ORDINAL_PALETTE.length - 1];
  const t = Math.max(0, Math.min(1, index / (count - 1)));
  const slot = Math.round(t * (ORDINAL_PALETTE.length - 1));
  return ORDINAL_PALETTE[slot];
}

// ---------------------------------------------------------------------------
// Type tokens. SVG text honours CSS custom properties through the style
// property (a presentation *attribute* does not resolve var()), so every size
// below comes from the scale and nothing is a literal. 12px is the floor.
// ---------------------------------------------------------------------------

const T_MONO = "font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace)";
const T_SANS = "font-family:var(--font-body,'DM Sans',system-ui,sans-serif)";
const T_XS = 'font-size:var(--fs-label-xs,0.75rem)';

const AXIS_TEXT = `${T_XS};${T_MONO};fill:var(--text-muted,rgba(26,16,8,0.65))`;
const SERIES_TEXT = `${T_XS};${T_SANS};fill:var(--text-secondary,#3d2e1a)`;
const ROW_TEXT = `${T_XS};${T_SANS};fill:var(--text-secondary,#3d2e1a)`;
const VALUE_TEXT = `${T_XS};${T_MONO};fill:var(--text-primary,#1a1008);font-variant-numeric:tabular-nums`;
// The n-floor note is a caveat, not chrome: --text-ghost measures 2.93:1 on the
// card, below the 4.5:1 a 12px string needs. --text-muted is 5.47:1. The ghost
// tint stays where the system uses it — eyebrows, figure numbers, "Other".
const NOTE_TEXT = `${T_XS};${T_MONO};fill:var(--text-muted,rgba(26,16,8,0.65))`;

// Advance-width estimates at 12px, used only when getComputedTextLength is
// unavailable (a detached first paint). The observer redraws once attached and
// the real measurement takes over.
const EST_MONO = 7.25;
const EST_SANS = 6.2;

// Line height for wrapped two-line row labels, in CSS px.
const LINE_H = 13;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(name: string, attrs: Record<string, string | number> = {}, parent?: SVGElement): SVGElement {
  const e = document.createElementNS(SVGNS, name) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

function clearNode(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

let uidSeq = 0;
function uid(prefix: string): string { return `${prefix}-${(++uidSeq).toString(36)}`; }

// ---------------------------------------------------------------------------
// Text measurement and truncation
// ---------------------------------------------------------------------------

/** Measure a candidate string in a live <text> node. Falls back to an advance
 *  estimate when the node is not rendered (getComputedTextLength returns 0 for
 *  a detached element). */
function measurer(node: SVGElement, estPerChar: number): (s: string) => number {
  const t = node as unknown as { textContent: string | null; getComputedTextLength?: () => number };
  return (s: string) => {
    t.textContent = s;
    if (typeof t.getComputedTextLength === 'function') {
      const v = t.getComputedTextLength();
      if (typeof v === 'number' && v > 0) return v;
    }
    return s.length * estPerChar;
  };
}

/** The trailing words of a label, up to `maxChars`. This is what distinguishes
 *  "Office of the Secretary of State for Scotland" from the identical first
 *  thirty characters of the Wales one — a head-only slice() rendered both as
 *  "Office of the Secretary of St…". */
function tailOf(text: string, maxChars: number): string {
  const words = text.trim().split(/\s+/);
  let tail = '';
  for (let i = words.length - 1; i >= 0; i--) {
    const cand = tail ? `${words[i]} ${tail}` : words[i];
    if (tail && cand.length > maxChars) break;
    tail = cand;
    if (tail.length >= maxChars) break;
  }
  return tail || text.slice(-maxChars);
}

/** Set `text` on `node`, truncated to fit `maxW` by measurement rather than by
 *  character count, keeping the distinguishing tail. Returns what was drawn. */
function fitText(node: SVGElement, text: string, maxW: number, estPerChar = EST_SANS): string {
  const measure = measurer(node, estPerChar);
  const full = text.trim();
  if (maxW <= 0) { node.textContent = ''; return ''; }
  if (measure(full) <= maxW) { node.textContent = full; return full; }

  const tail = tailOf(full, Math.min(16, Math.max(4, Math.floor(full.length / 3))));
  const headMax = Math.max(0, full.length - tail.length);
  let best = '';
  let lo = 1, hi = headMax;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = `${full.slice(0, mid).trimEnd()}…${tail}`;
    if (measure(cand) <= maxW) { best = cand; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) {
    // Not even the tail fits; shave it down rather than emit an empty label.
    let k = tail.length;
    best = `…${tail}`;
    while (k > 1 && measure(`…${tail.slice(-k)}`) > maxW) k--;
    best = `…${tail.slice(-k)}`;
  }
  node.textContent = best;
  return best;
}

/** The left margin an axis needs, measured from its widest formatted tick.
 *  A fixed margin cannot know that "£105,000" is wider than "40%": at 390px
 *  every y label on the pay charts hung 12-20px off the left edge of the SVG
 *  and rendered as "5,000". Clamped so a pathological format cannot eat the
 *  plot area. */
function axisLeftFor(svg: SVGElement, labels: string[], base: number, W: number): number {
  const probe = el('text', { style: AXIS_TEXT, x: -9999, y: -9999 }, svg);
  const measure = measurer(probe, EST_MONO);
  let w = 0;
  for (const s of labels) w = Math.max(w, measure(s));
  svg.removeChild(probe);
  return Math.max(base, Math.min(Math.round(W * 0.42), Math.ceil(w) + 12));
}

/** Draw the thinned x-axis tick labels for a time chart.
 *
 *  Two things a plain `text-anchor: middle` at every nth index gets wrong, both
 *  seen on screen: the final tick sits at the right edge of the plot, so half
 *  of it hangs outside the SVG; and because the last index is always forced in
 *  regardless of spacing, it overprints its neighbour ("2023 H2024 H1"). Ends
 *  are therefore anchored inwards, and the last label wins any collision. */
function drawXLabels(
  svg: SVGElement,
  opts: { n: number; labels: string[]; x: (i: number) => number; y: number; iw: number },
): void {
  const { n, labels, x, y, iw } = opts;
  if (n <= 0) return;
  const probe = el('text', { style: AXIS_TEXT, x: -9999, y: -9999 }, svg);
  const measure = measurer(probe, EST_MONO);
  const slot = Math.max(1, Math.floor(iw / 64));
  const every = Math.max(1, Math.ceil(n / slot));
  const picks: number[] = [];
  for (let i = 0; i < n; i++) if (i % every === 0) picks.push(i);
  if (picks[picks.length - 1] !== n - 1) picks.push(n - 1);

  const box = (i: number) => {
    const w = measure(labels[i] ?? '');
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const cx = x(i);
    const l = anchor === 'start' ? cx : anchor === 'end' ? cx - w : cx - w / 2;
    return { i, cx, l, r: l + w, anchor };
  };
  const boxes = picks.map(box);
  const last = boxes[boxes.length - 1];
  const kept = [] as typeof boxes;
  let prevR = -Infinity;
  for (let k = 0; k < boxes.length - 1; k++) {
    const b = boxes[k];
    if (b.l < prevR + 6) continue;          // would touch the previous kept label
    if (b.r + 6 > last.l) continue;         // would touch the final label
    kept.push(b);
    prevR = b.r;
  }
  kept.push(last);
  svg.removeChild(probe);
  for (const b of kept) {
    const t = el('text', { x: b.cx, y, 'text-anchor': b.anchor, style: AXIS_TEXT }, svg);
    t.textContent = labels[b.i] ?? '';
  }
}

/** Split a label across at most two lines at a word boundary, balancing the
 *  lines. Row labels wrap; they do not truncate. */
function splitTwoLines(text: string, maxW: number, measure: (s: string) => number): string[] {
  const full = text.trim();
  if (measure(full) <= maxW) return [full];
  const words = full.split(/\s+/);
  if (words.length < 2) return [full];
  let best: [string, string] | null = null;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.max(measure(a), measure(b));
    if (score < bestScore) { bestScore = score; best = [a, b]; }
  }
  return best ? [best[0], best[1]] : [full];
}

// ---------------------------------------------------------------------------
// Responsive plumbing
// ---------------------------------------------------------------------------

/** Nearest ancestor width that is actually laid out. Returns 0 while the whole
 *  subtree is detached, which is the normal state at construction time. */
function measureWidth(host: HTMLElement | null): number {
  let node: HTMLElement | null = host;
  let hops = 0;
  while (node && hops++ < 6) {
    const w = node.clientWidth;
    if (w > 0) return w;
    node = node.parentElement;
  }
  return 0;
}

const raf: (fn: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (fn) => { requestAnimationFrame(() => fn()); }
    : (fn) => { setTimeout(fn, 16); };

interface Resizer { destroy(): void; }

/** Watch `target`'s inline size and call `cb` on every change, coalesced to one
 *  animation frame. `host` is only consulted when the observer reports nothing
 *  useful. */
function observeWidth(target: Element, host: HTMLElement, cb: (w: number) => void): Resizer {
  let last = -1;
  let queued = false;
  let dead = false;

  const run = (raw: number) => {
    if (dead) return;
    const w = Math.round(raw);
    if (w <= 0 || Math.abs(w - last) < 1) return;
    last = w;
    if (queued) return;
    queued = true;
    raf(() => { queued = false; if (!dead) cb(last); });
  };

  let ro: ResizeObserver | null = null;
  let onWinResize: (() => void) | null = null;

  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver((entries) => {
      let w = 0;
      for (const e of entries) {
        const boxes = e.contentBoxSize as unknown;
        const box = Array.isArray(boxes) ? boxes[0] : (boxes as ResizeObserverSize | undefined);
        const size = box && typeof box.inlineSize === 'number' ? box.inlineSize : e.contentRect.width;
        if (size > w) w = size;
      }
      run(w || measureWidth(host));
    });
    ro.observe(target);
  } else if (typeof window !== 'undefined') {
    onWinResize = () => run(measureWidth(host));
    window.addEventListener('resize', onWinResize);
  }

  return {
    destroy() {
      dead = true;
      if (ro) ro.disconnect();
      if (onWinResize && typeof window !== 'undefined') window.removeEventListener('resize', onWinResize);
    },
  };
}

/** What every chart returns. `table` is the accessible twin — the contrast
 *  warnings on a warm palette obligate that relief and it is not dismissable,
 *  so it is built for every chart rather than only for Explore. */
export interface ChartHandle {
  svg: SVGSVGElement;
  /** Detached table twin of the same numbers. Append it where you want it. */
  table: HTMLElement;
  /** Scale or category key, where the chart has one to offer. */
  legend?: HTMLElement;
  /** Direct labels the collision pass had to drop — the legend must carry
   *  these or they are simply missing. Mutated in place on every redraw. */
  droppedLabels: string[];
  /** Last measured width, in CSS px. */
  width(): number;
  redraw(): void;
  destroy(): void;
}

const CHART_KEY = '__scsChart';

interface Attachable { table: HTMLElement; legend?: HTMLElement; dropped: string[]; }

/** Clear a host, tearing down whatever chart was there. Charts re-render on
 *  every state change, so leaving observers attached leaks one per keystroke. */
function reset(container: HTMLElement): void {
  const prev = (container as unknown as Record<string, unknown>)[CHART_KEY] as ChartHandle | undefined;
  if (prev) prev.destroy();
  container.innerHTML = '';
  container.style.position = 'relative';
}

function attach(
  container: HTMLElement,
  svg: SVGSVGElement,
  render: (w: number) => void,
  parts: Attachable,
): ChartHandle {
  container.appendChild(svg);
  let w = Math.max(measureWidth(container) || FALLBACK_W, MIN_W);
  const draw = (width: number) => { w = width; render(width); };
  draw(w);
  // The first observation lands with the real box even though the host was
  // detached a moment ago, and it re-runs the measured truncation now that
  // getComputedTextLength has something to measure.
  const rz = observeWidth(svg, container, (nw) => draw(Math.max(nw, MIN_W)));
  const handle: ChartHandle = {
    svg,
    table: parts.table,
    legend: parts.legend,
    droppedLabels: parts.dropped,
    width: () => w,
    redraw: () => draw(w),
    destroy() {
      rz.destroy();
      delete (container as unknown as Record<string, unknown>)[CHART_KEY];
    },
  };
  (container as unknown as Record<string, unknown>)[CHART_KEY] = handle;
  return handle;
}

/**
 * Width-driven mount for anything drawing its own SVG. `drawFn` runs once
 * immediately with the best width available and again on every box change.
 *
 * The observer-on-the-svg path inside each chart already makes existing call
 * sites correct as they stand; this is the explicit version for new ones.
 */
export function mount(container: HTMLElement, drawFn: (width: number) => void): { redraw(): void; destroy(): void } {
  let w = Math.max(measureWidth(container) || FALLBACK_W, MIN_W);
  drawFn(w);
  const rz = observeWidth(container, container, (nw) => { w = Math.max(nw, MIN_W); drawFn(w); });
  return { redraw: () => drawFn(w), destroy: () => rz.destroy() };
}

/** Create the root SVG. No height attribute: the viewBox supplies the aspect
 *  ratio and the CSS box is 100% of the host, so the scale is exactly 1 and a
 *  12px token renders at 12 CSS px. */
function rootSvg(): SVGSVGElement {
  return el('svg', {
    style: 'display:block;width:100%;height:auto;overflow:hidden',
    preserveAspectRatio: 'xMidYMid meet',
  }) as SVGSVGElement;
}

function frameSvg(svg: SVGSVGElement, W: number, H: number, opts: { title: string; desc: string; interactive: boolean }): void {
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('style', `display:block;width:100%;height:auto;overflow:hidden;aspect-ratio:${W} / ${H}`);
  // role="img" with no accessible name is worse than no role at all: it
  // collapses the drawing to a nameless graphic and hides the tick text.
  // Where the chart owns a focusable crosshair it must not be role="img"
  // either, because that makes every descendant presentational.
  const tId = uid('ct');
  const dId = uid('cd');
  svg.setAttribute('role', opts.interactive ? 'group' : 'img');
  svg.setAttribute('aria-labelledby', `${tId} ${dId}`);
  const t = el('title', { id: tId }, svg);
  t.textContent = opts.title;
  const d = el('desc', { id: dId }, svg);
  d.textContent = opts.desc;
}

/** Visually hidden polite announcer for keyboard crosshair movement. */
function liveRegion(container: HTMLElement): HTMLElement {
  const live = document.createElement('div');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';
  container.appendChild(live);
  return live;
}

function tipNode(container: HTMLElement): HTMLElement {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.setAttribute('aria-hidden', 'true');
  tip.style.cssText = 'position:absolute;pointer-events:none;opacity:0;transition:opacity .08s;z-index:20';
  container.appendChild(tip);
  return tip;
}

/** Place the tooltip relative to the container, measuring the SVG's real
 *  offset. With viewBox units == CSS px there is no scale factor to apply —
 *  the old `x(i)/W*clientWidth` drifted whenever the two disagreed. */
function placeTip(tip: HTMLElement, container: HTMLElement, svg: SVGSVGElement, xUnits: number, topPx: number): void {
  let offset = 0;
  if (typeof svg.getBoundingClientRect === 'function' && typeof container.getBoundingClientRect === 'function') {
    offset = svg.getBoundingClientRect().left - container.getBoundingClientRect().left;
  }
  const cw = container.clientWidth || 0;
  const tw = tip.offsetWidth || 180;
  const left = offset + xUnits + 12;
  tip.style.left = `${Math.max(0, cw ? Math.min(cw - tw - 4, left) : left)}px`;
  tip.style.top = `${topPx}px`;
  tip.style.opacity = '1';
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export interface Series { key: string; label: string; color: string; values: (number | null)[]; }

export interface LineChartOpts {
  labels: string[];                 // x categories (periods)
  series: Series[];
  yFormat: (n: number | null) => string;
  height?: number;
  yZero?: boolean;                  // include zero WHEN THE DATA COMES NEAR IT
  /** Shared scale. Pass this and the chart stops inventing a private domain —
   *  which is what let eight Compare panels claim "the same axis everywhere"
   *  while showing a GBP20k window beside a GBP160k one. */
  yDomain?: [number, number];
  highlightKey?: string | null;
  /** Series keys hidden by the legend toggle. */
  hiddenKeys?: Iterable<string>;
  /** Sample size behind the series, for the n-floor guard. */
  sampleSize?: number;
  /** Below this n the chart refuses to draw a confident trend. Default 30. */
  nFloor?: number;
  title?: string;
  desc?: string;
  onHoverIndex?: (i: number | null) => void;
}

// nice y-axis ticks
function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const raw = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Does the data come within 20% of zero? That, and not a boolean preference,
 *  is what decides whether a zero baseline is honest or 75% dead space. */
function nearZero(dmin: number, dmax: number): boolean {
  if (dmin <= 0 && dmax >= 0) return true;
  const nearest = dmin > 0 ? dmin : Math.abs(dmax);
  const furthest = dmin > 0 ? Math.abs(dmax) : Math.abs(dmin);
  return furthest > 0 && nearest <= 0.2 * furthest;
}

export interface Domain { lo: number; hi: number; ticks: number[]; }

/**
 * Y domain for a data range.
 *  - `yDomain` wins outright (shared-scale small multiples).
 *  - `yZero` means "include zero if the data comes within 20% of it", not
 *    "always start at zero". A pay series that never dips below GBP80,000 does
 *    not get a GBP0 baseline.
 *  - Nice-tick expansion is clamped to one tick step past the data at each end,
 *    so the axis can never run to GBP5.0m over data topping GBP1.2m.
 */
export function computeDomain(dmin: number, dmax: number, o: { yZero?: boolean; yDomain?: [number, number]; count?: number } = {}): Domain {
  const count = o.count ?? 5;

  if (o.yDomain && Number.isFinite(o.yDomain[0]) && Number.isFinite(o.yDomain[1])) {
    let [lo, hi] = o.yDomain;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    if (lo === hi) { const p = Math.abs(lo) * 0.05 || 1; lo -= p; hi += p; }
    const ticks = niceTicks(lo, hi, count).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
    return { lo, hi, ticks: ticks.length >= 2 ? ticks : [lo, hi] };
  }

  if (!Number.isFinite(dmin) || !Number.isFinite(dmax)) { dmin = 0; dmax = 1; }
  if (dmin === dmax) { const p = Math.abs(dmin) * 0.05 || 1; dmin -= p; dmax += p; }

  const span = dmax - dmin;
  const zero = o.yZero === true && nearZero(dmin, dmax);
  let lo = zero ? Math.min(0, dmin) : dmin - span * 0.08;
  let hi = zero ? Math.max(0, dmax) : dmax;

  const t0 = niceTicks(lo, hi, count);
  const step = t0.length > 1 ? t0[1] - t0[0] : Math.abs(hi - lo) || 1;

  lo = zero && dmin >= 0 ? 0 : Math.max(t0[0], dmin - step);
  hi = zero && dmax <= 0 ? 0 : Math.min(t0[t0.length - 1], dmax + step);
  if (hi <= lo) hi = lo + (step || 1);

  const ticks = t0.filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
  return { lo, hi, ticks: ticks.length >= 2 ? ticks : [lo, hi] };
}

/** Label candidates, thinned so nothing overprints. Anything closer than 14px
 *  to a kept label is dropped and handed back for the legend to carry —
 *  "DDaT roles" over "Other" rendered as "DDaTroles". */
function thinLabels<T extends { y: number }>(cands: T[], minGap = 14): { kept: T[]; dropped: T[] } {
  const sorted = [...cands].sort((a, b) => a.y - b.y);
  const kept: T[] = [];
  const dropped: T[] = [];
  let lastY = -Infinity;
  for (const c of sorted) {
    if (c.y - lastY >= minGap) { kept.push(c); lastY = c.y; } else dropped.push(c);
  }
  return { kept, dropped };
}

/** A 10x2 rule in the series colour. The hue belongs on the mark, never on the
 *  text — a light categorical fill is illegible as type on cream. */
function lineKey(svg: SVGSVGElement, x: number, y: number, color: string, dim = false): void {
  el('rect', { x, y: y - 1, width: 10, height: 2, fill: color, opacity: dim ? 0.35 : 1 }, svg);
}

// ---------------------------------------------------------------------------
// Line chart
// ---------------------------------------------------------------------------

export function lineChart(container: HTMLElement, opts: LineChartOpts): ChartHandle {
  reset(container);
  const svg = rootSvg();
  const tip = tipNode(container);
  const live = liveRegion(container);
  const dropped: string[] = [];

  const hidden = new Set<string>(opts.hiddenKeys ? Array.from(opts.hiddenKeys) : []);
  const vis = opts.series.filter((s) => !hidden.has(s.key));
  const nFloor = opts.nFloor ?? 30;
  const thin = opts.sampleSize != null && Number.isFinite(opts.sampleSize) && opts.sampleSize < nFloor;
  const nNote = thin ? `n = ${opts.sampleSize} — too few posts to read a trend` : '';

  const n = opts.labels.length;
  let dmin = Infinity, dmax = -Infinity;
  for (const s of vis) for (const v of s.values) if (v != null && !Number.isNaN(v)) { dmin = Math.min(dmin, v); dmax = Math.max(dmax, v); }

  const title = opts.title ?? `Line chart, ${vis.length} series over ${n} periods`;
  const desc = opts.desc ?? (Number.isFinite(dmin)
    ? `${vis.map((s) => s.label).join(', ')}. ${opts.labels[0] ?? ''} to ${opts.labels[n - 1] ?? ''}, ${opts.yFormat(dmin)} to ${opts.yFormat(dmax)}.${thin ? ` ${nNote}.` : ''}`
    : 'No data in range.');

  const render = (W: number) => {
    clearNode(svg);
    const H = opts.height ?? 340;
    frameSvg(svg, W, H, { title, desc, interactive: true });

    const compact = W < 520;
    const direct = vis.length > 0 && vis.length <= MAX_CATEGORICAL;
    const m = {
      top: 16 + (nNote ? 16 : 0),
      right: direct ? Math.round(Math.min(160, Math.max(compact ? 64 : 84, W * 0.2))) : (compact ? 14 : 24),
      bottom: 34,
      left: compact ? 46 : 58,
    };
    const ih = Math.max(40, H - m.top - m.bottom);

    const dom = computeDomain(dmin, dmax, { yZero: opts.yZero, yDomain: opts.yDomain, count: ih < 190 ? 4 : 5 });
    const { lo, hi, ticks } = dom;
    // The left margin has to know how wide the formatted ticks actually are.
    m.left = axisLeftFor(svg, ticks.map((t) => opts.yFormat(t)), m.left, W);
    const iw = Math.max(40, W - m.left - m.right);
    const x = (i: number) => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v: number) => m.top + ih - ((v - lo) / (hi - lo || 1)) * ih;

    if (nNote) {
      const note = el('text', { x: m.left, y: 12, style: NOTE_TEXT }, svg);
      note.textContent = nNote;
    }

    // gridlines + y labels
    for (const t of ticks) {
      const yy = y(t);
      el('line', { x1: m.left, y1: yy, x2: m.left + iw, y2: yy, stroke: GRID, 'stroke-width': 1 }, svg);
      const lab = el('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', style: AXIS_TEXT }, svg);
      lab.textContent = opts.yFormat(t);
    }

    // x labels, thinned to the room actually available
    drawXLabels(svg, { n, labels: opts.labels, x, y: H - 12, iw });

    el('line', { x1: m.left, y1: m.top + ih, x2: m.left + iw, y2: m.top + ih, stroke: AXIS, 'stroke-width': 1 }, svg);

    // lines. Below the n-floor the series goes ghost and dashed: the shape is
    // still there, but it stops looking like a finding.
    const dim = (k: string) => Boolean(opts.highlightKey && opts.highlightKey !== k);
    for (const s of vis) {
      let d = '';
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null || Number.isNaN(v)) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
      }
      const attrs: Record<string, string | number> = {
        d, fill: 'none',
        stroke: thin ? OTHER_COLOR : s.color,
        'stroke-width': dim(s.key) ? 1 : 2.2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        opacity: dim(s.key) ? 0.28 : 1,
      };
      if (thin) attrs['stroke-dasharray'] = '4 4';
      el('path', attrs, svg);
    }

    // direct labels at the last valid point, colour on the key and not on the
    // type, thinned for collisions
    dropped.length = 0;
    if (direct) {
      const cands: { y: number; s: Series }[] = [];
      for (const s of vis) {
        let li = -1;
        for (let i = n - 1; i >= 0; i--) if (s.values[i] != null && !Number.isNaN(s.values[i] as number)) { li = i; break; }
        if (li < 0) continue;
        cands.push({ y: Math.max(m.top + 6, Math.min(m.top + ih - 2, y(s.values[li] as number) + 4)), s });
      }
      const { kept, dropped: lost } = thinLabels(cands, 14);
      for (const c of lost) dropped.push(c.s.label);
      const textX = m.left + iw + 20;
      const room = Math.max(0, W - textX - 4);
      for (const c of kept) {
        lineKey(svg, m.left + iw + 6, c.y - 4, thin ? OTHER_COLOR : c.s.color, dim(c.s.key));
        const t = el('text', { x: textX, y: c.y, style: SERIES_TEXT, opacity: dim(c.s.key) ? 0.5 : 1 }, svg);
        fitText(t, c.s.label, room, EST_SANS);
      }
    }

    // hover + keyboard crosshair
    const focus = el('line', {
      x1: 0, y1: m.top, x2: 0, y2: m.top + ih, stroke: AXIS, 'stroke-width': 1,
      opacity: 0, 'stroke-dasharray': '3 3',
    }, svg);
    const dots = vis.map((s) => el('circle', {
      r: 4, fill: s.color, 'stroke-width': 2, opacity: 0,
      style: `stroke:${SURFACE}`,
    }, svg));

    const overlay = el('rect', {
      x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent',
      tabindex: 0, 'aria-label': `${title}. Use the left and right arrow keys to read each period.`,
      style: 'cursor:crosshair;outline:none',
    }, svg);

    const nearest = (px: number) => {
      if (n <= 1) return 0;
      const i = Math.round(((px - m.left) / iw) * (n - 1));
      return Math.max(0, Math.min(n - 1, i));
    };

    let cursor = -1;
    const show = (i: number, announce: boolean) => {
      cursor = i;
      focus.setAttribute('x1', String(x(i)));
      focus.setAttribute('x2', String(x(i)));
      focus.setAttribute('opacity', '1');
      let rows = '';
      const spoken: string[] = [];
      vis.forEach((s, si) => {
        const v = s.values[i];
        if (v == null || Number.isNaN(v)) { dots[si].setAttribute('opacity', '0'); return; }
        dots[si].setAttribute('cx', String(x(i)));
        dots[si].setAttribute('cy', String(y(v)));
        dots[si].setAttribute('opacity', '1');
        rows += `<div class="tip-row"><span class="tip-dot" style="background:${esc(s.color)}"></span><span class="tip-lab">${esc(s.label)}</span><span class="tip-val">${esc(opts.yFormat(v))}</span></div>`;
        spoken.push(`${s.label} ${opts.yFormat(v)}`);
      });
      tip.innerHTML = `<div class="tip-head">${esc(opts.labels[i])}</div>${rows}`;
      placeTip(tip, container, svg, x(i), m.top);
      if (announce) live.textContent = `${opts.labels[i]}: ${spoken.join(', ') || 'no data'}`;
      opts.onHoverIndex?.(i);
    };

    const move = (evt: MouseEvent | Touch) => {
      const rect = svg.getBoundingClientRect();
      // viewBox units are CSS px, so the only correction left is any residual
      // scale from a host narrower than MIN_W.
      const px = (evt.clientX - rect.left) * (rect.width ? W / rect.width : 1);
      show(nearest(px), false);
    };
    const leave = () => {
      cursor = -1;
      focus.setAttribute('opacity', '0');
      dots.forEach((d) => d.setAttribute('opacity', '0'));
      tip.style.opacity = '0';
      opts.onHoverIndex?.(null);
    };

    overlay.addEventListener('mousemove', (e) => move(e as MouseEvent));
    overlay.addEventListener('mouseleave', leave);
    overlay.addEventListener('touchmove', (e) => { const t = (e as TouchEvent).touches[0]; if (t) move(t); }, { passive: true });
    overlay.addEventListener('touchend', leave);
    overlay.addEventListener('focus', () => {
      overlay.setAttribute('style', `cursor:crosshair;outline:2px solid var(--accent,#c4570a);outline-offset:2px`);
      show(cursor < 0 ? n - 1 : cursor, true);
    });
    overlay.addEventListener('blur', () => {
      overlay.setAttribute('style', 'cursor:crosshair;outline:none');
      leave();
    });
    overlay.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      const at = cursor < 0 ? n - 1 : cursor;
      let next = at;
      if (ev.key === 'ArrowRight') next = Math.min(n - 1, at + 1);
      else if (ev.key === 'ArrowLeft') next = Math.max(0, at - 1);
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = n - 1;
      else if (ev.key === 'Escape') { leave(); return; }
      else return;
      ev.preventDefault();
      show(next, true);
    });
  };

  return attach(container, svg, render, {
    table: seriesTable(opts.labels, opts.series, opts.yFormat),
    legend: undefined,
    dropped,
  });
}

// ---------------------------------------------------------------------------
// Ranked bars
// ---------------------------------------------------------------------------

export interface BarChartOpts {
  rows: { key: string; label: string; value: number | null; color?: string }[];
  valueFormat: (n: number | null) => string;
  height?: number;
  highlightKey?: string | null;
  /** Anchor the bars at zero and let negatives run left. Without this a -3%
   *  and a +3% draw the same length and only colour tells them apart. */
  diverging?: boolean;
  title?: string;
  desc?: string;
}

const BAR_H = 24;      // cap: a taller bar reads as a block, not a measure
const BAR_GAP = 8;
const BAR_R = 4;       // rounded data-end only

/** Bar with a square baseline and a rounded data-end. `dir` +1 grows right. */
function barPath(x0: number, y: number, w: number, h: number, dir: 1 | -1): string {
  const r = Math.max(0, Math.min(BAR_R, w, h / 2));
  const end = x0 + dir * w;
  if (r <= 0) return `M${x0},${y} H${end} V${y + h} H${x0} Z`;
  const sweep = dir === 1 ? 1 : 0;
  const preX = end - dir * r;
  const backX = end - dir * r;
  return `M${x0},${y} H${preX} A${r},${r} 0 0 ${sweep} ${end},${y + r} V${y + h - r} A${r},${r} 0 0 ${sweep} ${backX},${y + h} H${x0} Z`;
}

// horizontal ranked bar chart
export function barChart(container: HTMLElement, opts: BarChartOpts): ChartHandle {
  reset(container);
  const svg = rootSvg();
  const dropped: string[] = [];
  const rows = opts.rows.filter((r) => r.value != null && !Number.isNaN(r.value as number));
  const anyNegative = rows.some((r) => (r.value as number) < 0);
  const diverging = opts.diverging ?? false;

  const title = opts.title ?? `Ranked bar chart, ${rows.length} rows`;
  const desc = opts.desc ?? (rows.length
    ? `${rows[0].label} ${opts.valueFormat(rows[0].value)} at the top, ${rows[rows.length - 1].label} ${opts.valueFormat(rows[rows.length - 1].value)} at the bottom.`
    : 'No rows in range.');

  const render = (W: number) => {
    clearNode(svg);
    const compact = W < 520;
    const labelW = Math.round(Math.max(96, Math.min(compact ? W * 0.4 : 210, W * 0.34)));
    const valueW = compact ? 60 : 76;
    const iw = Math.max(30, W - labelW - valueW - 12);

    // Measure labels first: rows wrap to two lines rather than truncate, so
    // the row height is not known until the wrapping is.
    const probe = el('text', { style: ROW_TEXT, visibility: 'hidden' }, svg);
    const measure = measurer(probe, EST_SANS);
    const lines = rows.map((r) => splitTwoLines(r.label, labelW - 12, measure));
    svg.removeChild(probe);

    const heights = lines.map((ls) => Math.max(BAR_H, ls.length * LINE_H + 6));
    const top = 8;
    const H = opts.height ?? (heights.reduce((a, b) => a + b + BAR_GAP, 0) + top + 8);
    frameSvg(svg, W, H, { title, desc, interactive: false });

    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value as number)));
    // Zero anchor: centred when the bars really do diverge, hard left otherwise.
    const useDiverging = diverging && anyNegative;
    const zeroX = useDiverging ? labelW + iw / 2 : labelW;
    const half = useDiverging ? iw / 2 : iw;

    if (useDiverging) {
      el('line', { x1: zeroX, y1: top - 2, x2: zeroX, y2: H - 6, stroke: AXIS, 'stroke-width': 1 }, svg);
    }

    let yy = top;
    rows.forEach((r, i) => {
      const rowH = heights[i];
      const value = r.value as number;
      const w = (Math.abs(value) / maxAbs) * half;
      const color = r.color || colorFor(i, r.key);
      const dim = Boolean(opts.highlightKey && opts.highlightKey !== r.key);
      const barTop = yy + (rowH - BAR_H) / 2;
      const dir: 1 | -1 = useDiverging && value < 0 ? -1 : 1;

      // label: wrapped, never coloured by the data
      const ls = lines[i];
      const firstBaseline = yy + rowH / 2 - (ls.length - 1) * LINE_H / 2 + 4;
      const lab = el('text', { x: labelW - 10, y: firstBaseline, 'text-anchor': 'end', style: ROW_TEXT, opacity: dim ? 0.5 : 1 }, svg);
      ls.forEach((line, li) => {
        const span = el('tspan', { x: labelW - 10, dy: li === 0 ? 0 : LINE_H }, lab);
        fitText(span, line, labelW - 12, EST_SANS);
      });

      el('path', {
        d: barPath(zeroX, barTop, Math.max(2, w), BAR_H, dir),
        fill: color, opacity: dim ? 0.3 : 0.92,
      }, svg);

      const vx = dir === 1 ? zeroX + Math.max(2, w) + 8 : zeroX - Math.max(2, w) - 8;
      const val = el('text', {
        x: vx, y: yy + rowH / 2 + 4, 'text-anchor': dir === 1 ? 'start' : 'end',
        style: VALUE_TEXT, opacity: dim ? 0.5 : 1,
      }, svg);
      val.textContent = opts.valueFormat(r.value);

      yy += rowH + BAR_GAP;
    });
  };

  return attach(container, svg, render, {
    table: rowsTable(rows, opts.valueFormat),
    dropped,
  });
}

// ---------------------------------------------------------------------------
// 100% stacked area (profession/grade mix over time)
// ---------------------------------------------------------------------------

export interface StackOpts {
  labels: string[];
  series: Series[];
  percent?: boolean;
  valueFormat: (n: number | null) => string;
  height?: number;
  hiddenKeys?: Iterable<string>;
  title?: string;
  desc?: string;
}

export function stackedArea(container: HTMLElement, opts: StackOpts): ChartHandle {
  reset(container);
  const svg = rootSvg();
  const tip = tipNode(container);
  const dropped: string[] = [];
  const hidden = new Set<string>(opts.hiddenKeys ? Array.from(opts.hiddenKeys) : []);
  const vis = opts.series.filter((s) => !hidden.has(s.key));
  const n = opts.labels.length;

  const title = opts.title ?? `Stacked ${opts.percent ? 'share' : 'total'} chart, ${vis.length} bands over ${n} periods`;
  const desc = opts.desc ?? `${vis.map((s) => s.label).join(', ')}, ${opts.labels[0] ?? ''} to ${opts.labels[n - 1] ?? ''}.`;

  const render = (W: number) => {
    clearNode(svg);
    const H = opts.height ?? 320;
    frameSvg(svg, W, H, { title, desc, interactive: true });

    const compact = W < 520;
    const m = {
      top: 12,
      right: Math.round(Math.min(170, Math.max(compact ? 70 : 96, W * 0.2))),
      bottom: 34,
      left: compact ? 40 : 52,
    };
    const ih = Math.max(40, H - m.top - m.bottom);

    const totals = new Array(n).fill(0);
    for (const s of vis) for (let i = 0; i < n; i++) totals[i] += (s.values[i] ?? 0);
    const maxTotal = opts.percent ? 1 : Math.max(1, ...totals);
    const yticks = opts.percent ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, maxTotal, 4);
    const ytickText = (yt: number) => (opts.percent ? `${Math.round(yt * 100)}%` : opts.valueFormat(yt));
    m.left = axisLeftFor(svg, yticks.map(ytickText), m.left, W);
    const iw = Math.max(40, W - m.left - m.right);
    const x = (i: number) => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const yTop = m.top, yBot = m.top + ih;
    const val = (v: number, i: number) => (opts.percent ? (totals[i] ? v / totals[i] : 0) : v);

    // Bands. Touching fills get a 2px surface gap (1px inset each side of the
    // shared boundary), never a stroke — a stroke on a fill is a border, and
    // it darkens the join instead of separating it.
    const base = new Array(n).fill(0);
    const cands: { y: number; s: Series }[] = [];
    for (const s of vis) {
      const upper: [number, number][] = [];
      const lower: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const b = base[i];
        const t = b + val(s.values[i] ?? 0, i);
        const y0 = yBot - (b / maxTotal) * ih;
        const y1 = yBot - (t / maxTotal) * ih;
        const gap = y0 - y1 >= 5 ? 1 : 0;
        lower.push([x(i), y0 - gap]);
        upper.push([x(i), y1 + gap]);
        base[i] = t;
      }
      let d = `M${upper.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')}`;
      d += ` L${lower.reverse().map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')} Z`;
      el('path', { d, fill: s.color, opacity: 0.88 }, svg);

      const lastSeg = (val(s.values[n - 1] ?? 0, n - 1) / maxTotal) * ih;
      if (lastSeg >= 12) {
        cands.push({
          y: yBot - ((base[n - 1] - val(s.values[n - 1] ?? 0, n - 1) / 2) / maxTotal) * ih + 4,
          s,
        });
      }
    }

    dropped.length = 0;
    const { kept, dropped: lost } = thinLabels(cands, 14);
    for (const c of lost) dropped.push(c.s.label);
    const textX = m.left + iw + 20;
    const room = Math.max(0, W - textX - 4);
    for (const c of kept) {
      lineKey(svg, m.left + iw + 6, c.y - 4, c.s.color);
      const t = el('text', { x: textX, y: c.y, style: SERIES_TEXT }, svg);
      fitText(t, c.s.label, room, EST_SANS);
    }

    for (const yt of yticks) {
      const yy = yBot - (yt / maxTotal) * ih;
      el('line', { x1: m.left, y1: yy, x2: m.left + iw, y2: yy, stroke: GRID, 'stroke-width': 1 }, svg);
      const lab = el('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', style: AXIS_TEXT }, svg);
      lab.textContent = ytickText(yt);
    }

    drawXLabels(svg, { n, labels: opts.labels, x, y: H - 12, iw });

    const focus = el('line', { x1: 0, y1: yTop, x2: 0, y2: yBot, stroke: AXIS, 'stroke-width': 1, opacity: 0, 'stroke-dasharray': '3 3' }, svg);
    const ov = el('rect', {
      x: m.left, y: yTop, width: iw, height: ih, fill: 'transparent',
      tabindex: 0, 'aria-label': `${title}. Use the left and right arrow keys to read each period.`,
      style: 'cursor:crosshair;outline:none',
    }, svg);
    const live = container.querySelector('[aria-live]') as HTMLElement | null ?? liveRegion(container);

    let cursor = -1;
    const show = (i: number, announce: boolean) => {
      cursor = i;
      focus.setAttribute('x1', String(x(i)));
      focus.setAttribute('x2', String(x(i)));
      focus.setAttribute('opacity', '1');
      const ranked = vis.map((s) => ({ s, v: s.values[i] ?? 0 })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
      const fmt = (v: number) => (opts.percent ? `${(totals[i] ? (v / totals[i]) * 100 : 0).toFixed(1)}%` : opts.valueFormat(v));
      tip.innerHTML = `<div class="tip-head">${esc(opts.labels[i])}</div>${ranked
        .map((r) => `<div class="tip-row"><span class="tip-dot" style="background:${esc(r.s.color)}"></span><span class="tip-lab">${esc(r.s.label)}</span><span class="tip-val">${esc(fmt(r.v))}</span></div>`)
        .join('')}`;
      placeTip(tip, container, svg, x(i), 8);
      if (announce) live.textContent = `${opts.labels[i]}: ${ranked.map((r) => `${r.s.label} ${fmt(r.v)}`).join(', ') || 'no data'}`;
    };
    const leave = () => { tip.style.opacity = '0'; focus.setAttribute('opacity', '0'); };

    ov.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e as MouseEvent).clientX - rect.left) * (rect.width ? W / rect.width : 1);
      show(Math.max(0, Math.min(n - 1, Math.round(((px - m.left) / iw) * (n - 1)))), false);
    });
    ov.addEventListener('mouseleave', leave);
    ov.addEventListener('focus', () => {
      ov.setAttribute('style', 'cursor:crosshair;outline:2px solid var(--accent,#c4570a);outline-offset:2px');
      show(cursor < 0 ? n - 1 : cursor, true);
    });
    ov.addEventListener('blur', () => { ov.setAttribute('style', 'cursor:crosshair;outline:none'); leave(); });
    ov.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      const at = cursor < 0 ? n - 1 : cursor;
      let next = at;
      if (ev.key === 'ArrowRight') next = Math.min(n - 1, at + 1);
      else if (ev.key === 'ArrowLeft') next = Math.max(0, at - 1);
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = n - 1;
      else if (ev.key === 'Escape') { leave(); return; }
      else return;
      ev.preventDefault();
      show(next, true);
    });
  };

  return attach(container, svg, render, {
    table: seriesTable(opts.labels, opts.series, opts.valueFormat),
    legend: legend(opts.series),
    dropped,
  });
}

// ---------------------------------------------------------------------------
// Sequential / diverging heatmap
// ---------------------------------------------------------------------------

export interface HeatOpts {
  cols: string[];
  rows: { key: string; label: string }[];
  value: (rowKey: string, col: number) => number | null;
  format: (n: number | null) => string;
  diverging?: boolean;   // true = premium (two-hue), false = magnitude (one-hue)
  midpoint?: number;     // diverging midpoint (default 0)
  cellH?: number;
  title?: string;
  desc?: string;
  /** Legend caption, e.g. "Pay premium vs all-profession median". */
  scaleLabel?: string;
}

// warm sequential ramp cream->orange->coffee; diverging teal<->cream->orange
function lerp(a: number[], b: number[], t: number) { return a.map((x, i) => Math.round(x + (b[i] - x) * t)); }
function rgb(c: number[]) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
const SEQ = [[240, 230, 214], [230, 160, 90], [196, 87, 10], [120, 52, 8]]; // cream->orange->coffee
const DIV_LO = [18, 152, 138], DIV_MID = [237, 228, 212], DIV_HI = [196, 87, 10];

export function seqColor(t: number): string {
  t = Math.max(0, Math.min(1, t));
  const seg = t * (SEQ.length - 1);
  const i = Math.min(SEQ.length - 2, Math.floor(seg));
  return rgb(lerp(SEQ[i], SEQ[i + 1], seg - i));
}
export function divColor(t: number): string {
  t = Math.max(-1, Math.min(1, t));
  return t < 0 ? rgb(lerp(DIV_MID, DIV_LO, -t)) : rgb(lerp(DIV_MID, DIV_HI, t));
}

/** No filing is not a light value on the ramp — it is a different state. */
export const NULL_CELL = 'rgba(26,16,8,0.035)';

export function heatmap(container: HTMLElement, opts: HeatOpts): ChartHandle {
  reset(container);
  const svg = rootSvg();
  const tip = tipNode(container);
  const dropped: string[] = [];
  const rows = opts.rows, cols = opts.cols;

  let lo = Infinity, hi = -Infinity;
  for (const r of rows) {
    for (let c = 0; c < cols.length; c++) {
      const v = opts.value(r.key, c);
      if (v != null && !Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const mid = opts.midpoint ?? 0;
  const absMax = Math.max(Math.abs(hi - mid), Math.abs(lo - mid)) || 1;

  const title = opts.title ?? `Heatmap, ${rows.length} rows by ${cols.length} periods`;
  const desc = opts.desc ?? `Values from ${opts.format(lo)} to ${opts.format(hi)}${opts.diverging ? `, diverging about ${opts.format(mid)}` : ''}. Empty cells did not file.`;

  const render = (W: number) => {
    clearNode(svg);
    const compact = W < 560;
    const labelW = Math.round(Math.max(90, Math.min(compact ? W * 0.4 : 220, W * 0.32)));
    const cellH = opts.cellH ?? 22;
    const gridW = Math.max(40, W - labelW - 8);
    const cw = gridW / Math.max(1, cols.length);
    const H = rows.length * cellH + 46;
    frameSvg(svg, W, H, { title, desc, interactive: false });

    // Column labels sit over cell centres. Same edge rule as the time charts:
    // the final label was anchored middle over the last cell and hung off the
    // right edge of the SVG, and at some widths it overprinted its neighbour.
    drawXLabels(svg, { n: cols.length, labels: cols, x: (i) => labelW + i * cw + cw / 2, y: 13, iw: gridW });

    rows.forEach((r, ri) => {
      const yy = 22 + ri * cellH;
      const lab = el('text', { x: labelW - 8, y: yy + cellH / 2 + 4, 'text-anchor': 'end', style: ROW_TEXT }, svg);
      fitText(lab, r.label, labelW - 12, EST_SANS);
      cols.forEach((c, ci) => {
        const v = opts.value(r.key, ci);
        const empty = v == null || Number.isNaN(v);
        const fill = empty
          ? NULL_CELL
          : opts.diverging ? divColor((v - mid) / absMax) : seqColor((v - lo) / (hi - lo || 1));
        const cell = el('rect', {
          x: labelW + ci * cw, y: yy, width: Math.max(1, cw - 1), height: cellH - 1, fill,
        }, svg);
        if (empty) cell.setAttribute('style', 'stroke:rgba(26,16,8,0.10);stroke-width:1');
        cell.addEventListener('mousemove', (e) => {
          tip.innerHTML = `<div class="tip-head">${esc(r.label)}</div><div class="tip-row"><span class="tip-lab">${esc(c)}</span><span class="tip-val">${esc(empty ? 'no filing' : opts.format(v))}</span></div>`;
          const rect = container.getBoundingClientRect();
          const tw = tip.offsetWidth || 170;
          const left = (e as MouseEvent).clientX - rect.left + 10;
          tip.style.left = `${Math.max(0, Math.min((container.clientWidth || 0) - tw - 4, left))}px`;
          tip.style.top = `${(e as MouseEvent).clientY - rect.top + 10}px`;
          tip.style.opacity = '1';
        });
        cell.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
      });
    });
  };

  return attach(container, svg, render, {
    table: matrixTable(cols, rows, opts.value, opts.format),
    legend: colorScaleLegend({
      kind: opts.diverging ? 'diverging' : 'sequential',
      lo, hi, midpoint: mid, format: opts.format,
      label: opts.scaleLabel,
      nullLabel: 'no filing',
    }),
    dropped,
  });
}

// ---------------------------------------------------------------------------
// Distribution fan (median with p25-p75 band)
// ---------------------------------------------------------------------------

export interface FanOpts {
  labels: string[];
  lo: (number | null)[];
  mid: (number | null)[];
  hi: (number | null)[];
  color: string;
  yFormat: (n: number | null) => string;
  height?: number;
  yZero?: boolean;
  yDomain?: [number, number];
  title?: string;
  desc?: string;
}

export function fanChart(container: HTMLElement, opts: FanOpts): ChartHandle {
  reset(container);
  const svg = rootSvg();
  const dropped: string[] = [];
  const n = opts.labels.length;

  let dmin = Infinity, dmax = -Infinity;
  for (const a of [opts.lo, opts.hi, opts.mid]) {
    for (const v of a) if (v != null && !Number.isNaN(v)) { dmin = Math.min(dmin, v); dmax = Math.max(dmax, v); }
  }

  const title = opts.title ?? 'Distribution fan: median with the 25th to 75th percentile band';
  const desc = opts.desc ?? (Number.isFinite(dmin)
    ? `${opts.labels[0] ?? ''} to ${opts.labels[n - 1] ?? ''}, ${opts.yFormat(dmin)} to ${opts.yFormat(dmax)} across the band.`
    : 'No data in range.');

  const render = (W: number) => {
    clearNode(svg);
    const H = opts.height ?? 300;
    frameSvg(svg, W, H, { title, desc, interactive: false });
    const compact = W < 520;
    const m = { top: 14, right: compact ? 14 : 20, bottom: 34, left: compact ? 46 : 58 };
    const ih = Math.max(40, H - m.top - m.bottom);

    const { lo, hi, ticks } = computeDomain(dmin, dmax, { yZero: opts.yZero, yDomain: opts.yDomain, count: ih < 190 ? 4 : 5 });
    m.left = axisLeftFor(svg, ticks.map((t) => opts.yFormat(t)), m.left, W);
    const iw = Math.max(40, W - m.left - m.right);
    const x = (i: number) => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v: number) => m.top + ih - ((v - lo) / (hi - lo || 1)) * ih;

    for (const t of ticks) {
      const yy = y(t);
      el('line', { x1: m.left, y1: yy, x2: m.left + iw, y2: yy, stroke: GRID, 'stroke-width': 1 }, svg);
      const l = el('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', style: AXIS_TEXT }, svg);
      l.textContent = opts.yFormat(t);
    }
    drawXLabels(svg, { n, labels: opts.labels, x, y: H - 12, iw });

    const up: string[] = [], dn: string[] = [];
    for (let i = 0; i < n; i++) { const v = opts.hi[i]; if (v == null) continue; up.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); }
    for (let i = n - 1; i >= 0; i--) { const v = opts.lo[i]; if (v == null) continue; dn.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); }
    if (up.length && dn.length) {
      el('path', { d: `M${up.join(' L')} L${dn.join(' L')} Z`, fill: opts.color, opacity: 0.16 }, svg);
    }

    let d = '', pen = false;
    for (let i = 0; i < n; i++) {
      const v = opts.mid[i];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    el('path', { d, fill: 'none', stroke: opts.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, svg);
    el('line', { x1: m.left, y1: m.top + ih, x2: m.left + iw, y2: m.top + ih, stroke: AXIS, 'stroke-width': 1 }, svg);
  };

  return attach(container, svg, render, {
    table: seriesTable(opts.labels, [
      { key: 'p25', label: '25th percentile', color: opts.color, values: opts.lo },
      { key: 'p50', label: 'Median', color: opts.color, values: opts.mid },
      { key: 'p75', label: '75th percentile', color: opts.color, values: opts.hi },
    ], opts.yFormat),
    dropped,
  });
}

// ---------------------------------------------------------------------------
// Legends
// ---------------------------------------------------------------------------

export interface LegendOpts {
  /** Wire the toggle. Without it the legend stays inert markup, which is what
   *  it has been: style.css ships the full `.off` state and cursor:pointer and
   *  nothing ever attached a handler. */
  onToggle?: (key: string, off: boolean, hidden: string[]) => void;
  /** Series keys already hidden, so the legend can render its own state. */
  hidden?: Iterable<string>;
}

export interface LegendItem { key?: string; label: string; color: string; }

// shared legend row (identity is never colour-alone: legend + tooltip + labels)
export function legend(series: LegendItem[], opts: LegendOpts = {}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  const hidden = new Set<string>(opts.hidden ? Array.from(opts.hidden) : []);
  const interactive = typeof opts.onToggle === 'function';
  if (interactive) wrap.setAttribute('role', 'group');

  for (const s of series) {
    const key = s.key ?? s.label;
    const off = hidden.has(key);
    // A span when nothing happens on click; a real button when something does.
    const lg = document.createElement(interactive ? 'button' : 'span');
    lg.className = off ? 'lg off' : 'lg';
    if (interactive) {
      (lg as HTMLButtonElement).type = 'button';
      lg.style.cssText = 'background:none;border:0;padding:0;cursor:pointer';
      lg.setAttribute('aria-pressed', String(!off));
      lg.setAttribute('title', `Show only this series, or hide it: ${s.label}`);
      lg.addEventListener('click', () => {
        const nowOff = !lg.classList.contains('off');
        lg.classList.toggle('off', nowOff);
        lg.setAttribute('aria-pressed', String(!nowOff));
        if (nowOff) hidden.add(key); else hidden.delete(key);
        opts.onToggle?.(key, nowOff, Array.from(hidden));
      });
    }
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = s.color;
    lg.append(sw, document.createTextNode(s.label));
    wrap.append(lg);
  }
  return wrap;
}

export interface ScaleLegendOpts {
  kind?: 'sequential' | 'diverging';
  lo: number;
  hi: number;
  midpoint?: number;
  format: (n: number | null) => string;
  label?: string;
  /** Discrete steps. Countable beats a continuous ramp: a reader can tell two
   *  steps apart, they cannot tell two points on a gradient apart. */
  steps?: number;
  /** Render an "empty" chip, for matrices where nothing filed. */
  nullLabel?: string;
}

/** Key for a continuous colour scale. The diverging profession heatmap had no
 *  legend at all — the key was prose in a subtitle ("teal = below, orange =
 *  above"), which is not a legend, it is an apology for not having one. */
export function colorScaleLegend(o: ScaleLegendOpts): HTMLElement {
  const kind = o.kind ?? 'sequential';
  const steps = o.steps ?? (kind === 'diverging' ? 7 : 5);
  const mid = o.midpoint ?? 0;

  const wrap = document.createElement('div');
  wrap.className = 'legend scale-legend';
  wrap.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap';

  if (o.label) {
    const cap = document.createElement('span');
    cap.className = 'lg';
    cap.textContent = o.label;
    wrap.append(cap);
  }

  const lowText = document.createElement('span');
  lowText.className = 'lg';
  lowText.style.fontVariantNumeric = 'tabular-nums';
  lowText.textContent = o.format(kind === 'diverging' ? mid - Math.max(Math.abs(o.hi - mid), Math.abs(o.lo - mid)) : o.lo);
  wrap.append(lowText);

  const ramp = document.createElement('span');
  ramp.style.cssText = 'display:inline-flex;align-items:center';
  const absMax = Math.max(Math.abs(o.hi - mid), Math.abs(o.lo - mid)) || 1;
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const sw = document.createElement('span');
    sw.style.cssText = `display:block;width:22px;height:12px;background:${kind === 'diverging' ? divColor(t * 2 - 1) : seqColor(t)};border:1px solid var(--line-hair,rgba(26,16,8,0.10));border-left-width:${i === 0 ? '1px' : '0'}`;
    const value = kind === 'diverging' ? mid + (t * 2 - 1) * absMax : o.lo + t * (o.hi - o.lo);
    sw.title = o.format(value);
    ramp.append(sw);
  }
  wrap.append(ramp);

  const hiText = document.createElement('span');
  hiText.className = 'lg';
  hiText.style.fontVariantNumeric = 'tabular-nums';
  hiText.textContent = o.format(kind === 'diverging' ? mid + absMax : o.hi);
  wrap.append(hiText);

  if (kind === 'diverging') {
    const midText = document.createElement('span');
    midText.className = 'lg';
    midText.textContent = `${o.format(mid)} = no difference`;
    wrap.append(midText);
  }

  if (o.nullLabel) {
    const nul = document.createElement('span');
    nul.className = 'lg';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.cssText = `background:${NULL_CELL};border:1px solid var(--line-hair,rgba(26,16,8,0.10))`;
    nul.append(sw, document.createTextNode(o.nullLabel));
    wrap.append(nul);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Table twins — the contrast relief, built for every chart
// ---------------------------------------------------------------------------

function tableShell(): { wrap: HTMLElement; table: HTMLTableElement } {
  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  const table = document.createElement('table');
  table.className = 'data-table';
  wrap.appendChild(table);
  return { wrap, table };
}

// accessible table view for a set of series (contrast-relief requirement)
export function seriesTable(labels: string[], series: Series[], fmt: (n: number | null) => string): HTMLElement {
  const { wrap, table } = tableShell();
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th scope="col">Period</th>${series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join('')}</tr>`;
  table.appendChild(thead);
  const tb = document.createElement('tbody');
  tb.innerHTML = labels
    .map((lab, i) => `<tr><td class="tperiod">${esc(lab)}</td>${series.map((s) => `<td>${esc(fmt(s.values[i] ?? null))}</td>`).join('')}</tr>`)
    .join('');
  table.appendChild(tb);
  return wrap;
}

/** Table twin for a ranked bar chart. */
export function rowsTable(rows: { key: string; label: string; value: number | null }[], fmt: (n: number | null) => string): HTMLElement {
  const { wrap, table } = tableShell();
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th scope="col">Rank</th><th scope="col">Name</th><th scope="col">Value</th></tr>';
  table.appendChild(thead);
  const tb = document.createElement('tbody');
  tb.innerHTML = rows
    .map((r, i) => `<tr><td class="tperiod">${i + 1}</td><td>${esc(r.label)}</td><td>${esc(fmt(r.value))}</td></tr>`)
    .join('');
  table.appendChild(tb);
  return wrap;
}

/** Table twin for a heatmap. */
export function matrixTable(
  cols: string[],
  rows: { key: string; label: string }[],
  value: (rowKey: string, col: number) => number | null,
  fmt: (n: number | null) => string,
): HTMLElement {
  const { wrap, table } = tableShell();
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th scope="col">Row</th>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr>`;
  table.appendChild(thead);
  const tb = document.createElement('tbody');
  tb.innerHTML = rows
    .map((r) => `<tr><td class="tperiod">${esc(r.label)}</td>${cols
      .map((_c, ci) => { const v = value(r.key, ci); return `<td>${v == null ? '—' : esc(fmt(v))}</td>`; })
      .join('')}</tr>`)
    .join('');
  table.appendChild(tb);
  return wrap;
}
