#!/usr/bin/env node
// Data-visualisation palette validator: the checks that can be COMPUTED from
// colour alone, so a palette is measured rather than eyeballed.
//
// Why this exists. The seven-slot palette this bundle shipped failed three of
// them against the card surface: #5b8a2a and #b8820a sit 2.0 ΔE apart under
// simulated protanopia — the same colour to a red-blind reader — #cf5aa0 and
// #b83c6b are 9.9 apart under ordinary vision, and #b8820a clears only 2.84:1
// against #f3ebdd. None of that is visible by looking, which is the whole
// point: a palette is a measurable object and it was being chosen by eye.
//
// And why it lives HERE. The validator was only ever available at
// /tmp/claude-1000/bundled-skills/<version>/.../dataviz/scripts/validate_palette.js
// — a version-pinned temporary path that disappears with the next release. CI
// and the monthly refresh both have to be able to run it, and a build gate that
// lives in /tmp is not a build gate. Ported verbatim on the maths; the browser
// auto-run block of the original is dropped, and a repository mode is added so
// the check runs against the palettes the code actually declares rather than
// against a copy of them that can drift.
//
// Node 22 built-ins only (node:fs, node:path, node:url — no colour library:
// every conversion below is arithmetic).
//
//   node scripts/validate-palette.mjs
//        every palette declared in src/, plus the two sanctioned sets, against
//        the card surface read out of src/style.css.
//   node scripts/validate-palette.mjs "#c4570a,#12988a,#8a2d3a,#7d5bd0" \
//        --mode light --surface "#f3ebdd" --pairs all
//   node scripts/validate-palette.mjs "#dd9a5e,#c4570a,#8a3a08,#4d1f02" --ordinal
//
// Exit: 0 everything passes · 1 a gating check failed · 2 bad usage, or the
// extraction stopped matching (a broken check must never report OK).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

// ---- thresholds ------------------------------------------------------------
// ΔE is Euclidean distance in OKLab x100. The CVD thresholds are calibrated to
// the Machado-Oliveira-Fernandes (2009) severity-1.0 simulation below; the sim
// model is part of the standard, not an implementation detail, so swapping in
// e.g. Vienot-1999 would move borderline pairs and require recalibrating them.
const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] }; // OKLCH L
const CHROMA_FLOOR = 0.10;                                // OKLCH C; below it a hue reads grey
const CVD_TARGET = 8.0, CVD_FLOOR = 6.0;                  // min(protan, deutan) over the pairlist
const NORMAL_FLOOR = 15.0;                                // worst pair, unsimulated vision. Hard gate
const CONTRAST_MIN = 3.0;                                 // WCAG, mark against surface
const DEFAULT_SURFACE = { light: '#fcfcfb', dark: '#1a1a19' };
const ORDINAL_MIN_DL = 0.06;                              // min OKLCH ΔL between adjacent steps
const ORDINAL_LIGHT_FLOOR = 2.0;                          // lightest step vs surface

// The surface every chart in this bundle is drawn on. Read from src/style.css
// at run time; this is the fallback and the value the plan validated against.
const CARD_SURFACE = '#f3ebdd';

// If the extraction below silently stops matching, repo mode goes green for the
// wrong reason. Failing loudly is the point.
const MIN_DECLARED = 2;

// Machado, Oliveira & Fernandes (2009) CVD transforms at severity 1.0 (linear RGB).
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868],
           [0.114503, 0.786281, 0.099216],
           [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968],
           [0.280085, 0.672501, 0.047413],
           [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779],
           [-0.078411, 0.930809, 0.147602],
           [0.004733, 0.691367, 0.303900]],
};

// ---- colour conversions ----------------------------------------------------
const hex2srgb = (h) => { h = h.trim().replace(/^#/, ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };

// Input boundary: every user-supplied colour passes these before any maths.
// Unguarded, parseInt propagates NaN through every check and the run fails OPEN
// — which is the worst possible failure for a validator.
const WS_RUN = '[ \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+';
const stripWs = (v) => v.replace(new RegExp(`^${WS_RUN}|${WS_RUN}$`, 'g'), '');
const splitColors = (raw) => (raw || '').split(',').map(stripWs).filter(Boolean);
const isHexColor = (v) => /^#?[0-9a-fA-F]{6}$/.test(v);

const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin = (h) => hex2srgb(h).map(s2lin);
const relLum = (h) => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, // L
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, // a
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s, // b
  ];
}
const oklab = (h) => oklabFromLin(lin(h));
const oklch = (h) => { const [L, a, b] = oklab(h); return [L, Math.hypot(a, b)]; };
const okhue = (h) => { const [, a, b] = oklab(h); return ((Math.atan2(b, a) * 180 / Math.PI) % 360 + 360) % 360; };

function simulate(h, kind) {
  const [r, g, b] = lin(h), M = MACHADO[kind];
  const clamp = (c) => Math.max(0, Math.min(1, c));
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
  ];
}
// Euclidean distance in OKLab, x100. No kind means unsimulated (normal) vision.
function deltaE(h1, h2, kind) {
  const a = oklabFromLin(kind ? simulate(h1, kind) : lin(h1));
  const b = oklabFromLin(kind ? simulate(h2, kind) : lin(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---- categorical checks ----------------------------------------------------
export function validate(palette, { mode = 'light', surface, pairs = 'adjacent' } = {}) {
  surface ??= DEFAULT_SURFACE[mode];
  const [lo, hi] = BAND[mode];
  const report = [];
  let ok = true;

  // 1. lightness band
  const offband = palette.filter(c => { const L = oklch(c)[0]; return L < lo || L > hi; })
    .map(c => [c, +oklch(c)[0].toFixed(3)]);
  if (offband.length) ok = false;
  report.push(['Lightness band', !offband.length,
    offband.length ? `outside band: ${JSON.stringify(offband)}` : `all ${palette.length} inside L ${lo}-${hi}`]);

  // 2. chroma floor
  const lowc = palette.filter(c => oklch(c)[1] < CHROMA_FLOOR).map(c => [c, +oklch(c)[1].toFixed(3)]);
  if (lowc.length) ok = false;
  report.push(['Chroma floor', !lowc.length,
    lowc.length ? `below floor (reads grey): ${JSON.stringify(lowc)}` : `all ${palette.length} >= ${CHROMA_FLOOR}`]);

  // 3. CVD separation — adjacent pairs for stacks/bars/lines; ALL pairs for
  //    scatter, small multiples and anything where any two marks can meet.
  const n = palette.length;
  const pairlist = pairs === 'all'
    ? Array.from({ length: n }, (_, i) => Array.from({ length: n - i - 1 }, (_, k) => [i, i + 1 + k])).flat()
    : Array.from({ length: n - 1 }, (_, i) => [i, i + 1]);
  const label = pairs === 'all' ? 'all-pairs' : 'adjacent';
  let worst = null;
  for (const kind of ['protan', 'deutan']) {
    for (const [i, j] of pairlist) {
      const d = deltaE(palette[i], palette[j], kind);
      if (worst === null || d < worst[0]) worst = [d, kind, palette[i], palette[j]];
    }
  }
  const tri = pairlist.length ? Math.min(...pairlist.map(([i, j]) => deltaE(palette[i], palette[j], 'tritan'))) : 99;
  const wd = worst ? worst[0] : 99;
  const cvdState = wd >= CVD_TARGET ? 'pass' : wd >= CVD_FLOOR ? 'floor' : 'fail';
  if (cvdState === 'fail') ok = false;
  report.push(['CVD separation', cvdState,
    worst ? `worst ${label} ${worst[3]} vs ${worst[2]} ΔE ${wd.toFixed(1)} (${worst[1]}) · tritan ${tri.toFixed(1)}` : 'n/a']);

  // 4. Normal-vision floor. The CVD gate protects dichromat readers; this one
  //    protects everyone else. It is a hard gate: secondary encoding does not
  //    excuse two marks that a full-colour reader cannot tell apart either.
  let nworst = null;
  for (const [i, j] of pairlist) {
    const d = deltaE(palette[i], palette[j]);
    if (nworst === null || d < nworst[0]) nworst = [d, palette[i], palette[j]];
  }
  const nd = nworst ? nworst[0] : 99;
  const norState = nd >= NORMAL_FLOOR ? 'pass' : 'fail';
  if (norState === 'fail') ok = false;
  report.push(['Normal-vision floor', norState,
    nworst ? `worst ${label} ${nworst[2]} vs ${nworst[1]} ΔE ${nd.toFixed(1)} (normal)`
      + (nd >= NORMAL_FLOOR ? '' : ` — below ${NORMAL_FLOOR.toFixed(0)}, hard to tell apart even with full colour vision`) : 'n/a']);

  // 5. contrast vs surface — sub-3:1 is a documented conditional relax (visible
  //    labels or a table twin), not a hard fail. This bundle owes every chart a
  //    table twin anyway, so the relief is already being paid for.
  const low = palette.filter(c => contrast(c, surface) < CONTRAST_MIN).map(c => [c, +contrast(c, surface).toFixed(2)]);
  report.push(['Contrast vs surface', low.length ? 'relief' : 'pass',
    low.length ? `below ${CONTRAST_MIN}:1 — relief required (visible labels or table view): ${JSON.stringify(low)}`
      : `all ${palette.length} >= ${CONTRAST_MIN}:1`]);

  return { report, ok };
}

// ---- ordinal checks --------------------------------------------------------
// Ordered categories (SCS1 -> SCS4, size tiers, time buckets drawn as discrete
// marks) take a one-hue ramp, not categorical hues. The categorical checks FAIL
// a correct ramp by design — it spans the lightness band and its light steps
// drop below the chroma floor — so a ramp is checked for reading AS a ramp:
// one hue, monotone lightness, visible gaps, and a light end that still clears
// the surface.
export function validateOrdinal(palette, { mode = 'light', surface } = {}) {
  surface ??= DEFAULT_SURFACE[mode];
  const report = [];
  let ok = true;
  const Ls = palette.map(c => oklch(c)[0]);

  const order = [...Ls.keys()].sort((a, b) => Ls[a] - Ls[b]);
  const fwd = order.every((v, i) => v === i);
  const rev = order.every((v, i) => v === Ls.length - 1 - i);
  const mono = fwd || rev;
  if (!mono) ok = false;
  report.push(['Lightness monotone', mono,
    mono ? 'steps read light to dark' : `out of order — L values ${JSON.stringify(Ls.map(l => +l.toFixed(3)))}`]);

  // Filter on the RAW gap, then round for display: filtering the rounded value
  // passes raw gaps in [0.0595, 0.06).
  const gaps = Ls.slice(1).map((l, i) => Math.abs(l - Ls[i]));
  const thin = gaps.map((g, i) => [palette[i], palette[i + 1], g])
    .filter(([, , g]) => g < ORDINAL_MIN_DL).map(([a, b, g]) => [a, b, +g.toFixed(3)]);
  if (thin.length) ok = false;
  report.push(['Adjacent ΔL', !thin.length,
    thin.length ? `steps too close: ${JSON.stringify(thin)}` : `all gaps >= ${ORDINAL_MIN_DL}`]);

  const byL = [...palette].sort((a, b) => oklch(a)[0] - oklch(b)[0]);
  const lightest = mode === 'light' ? byL[byL.length - 1] : byL[0];
  const cr = contrast(lightest, surface);
  if (cr < ORDINAL_LIGHT_FLOOR) ok = false;
  report.push(['Light-end contrast', cr >= ORDINAL_LIGHT_FLOOR,
    `${lightest} at ${cr.toFixed(2)}:1 vs surface` + (cr >= ORDINAL_LIGHT_FLOOR ? '' : ` — below ${ORDINAL_LIGHT_FLOOR}:1 floor`)]);

  const hues = palette.map(okhue);
  let spread = hues.length ? Math.max(...hues) - Math.min(...hues) : 0;
  if (spread > 180) spread = 360 - spread;
  const oneHue = spread <= 40;
  if (!oneHue) ok = false;
  report.push(['Single hue', oneHue,
    `hue spread ${spread.toFixed(0)} deg` + (oneHue ? '' : ' — over 40 deg, not a one-hue ramp')]);

  return { report, ok };
}

// ---- reporting -------------------------------------------------------------
const GLYPH = { true: 'PASS', false: 'FAIL', pass: 'PASS', floor: 'WARN', fail: 'FAIL', relief: 'WARN' };

function printReport({ report, ok }, { mode, surface, ordinal, n, title }) {
  const kind = ordinal ? 'ordinal ramp' : 'categorical';
  console.log(`\n${title || 'Palette'} (${mode}, surface ${surface}, ${kind}): ${n} slots`);
  for (const [name, state, detail] of report) {
    console.log(`  [${(GLYPH[state] ?? state).padEnd(4)}] ${name.padEnd(22)} ${detail}`);
  }
  const tail = ordinal
    ? '(ordinal: one hue, monotone L, visible step gaps, light end clears the surface)'
    : '(CVD in the 6-8 floor band is legal ONLY with secondary encoding: direct labels, gaps or texture)';
  console.log(`  -> ${ok ? 'ALL CHECKS PASS' : 'FAILED — fix the marked checks'}  ${tail}`);
}

// ---- repository mode -------------------------------------------------------
// Validates what the code declares, not a copy of it. A palette pasted into
// this file would pass forever while src/ drifted underneath it.

// The two sets the build plan sanctions (section 3.2), both verified against
// the card surface. They are checked on every run so that a regression in the
// source is reported as a difference from something, not just as a failure.
const SANCTIONED = [
  { name: 'CATEGORICAL (plan 3.2)', kind: 'categorical', colors: ['#c4570a', '#12988a', '#8a2d3a', '#7d5bd0'] },
  { name: 'ORDINAL grade ramp (plan 3.2)', kind: 'ordinal', colors: ['#dd9a5e', '#c4570a', '#8a3a08', '#4d1f02'] },
];

// Imported verbatim from the site's Field Study System, used in a legend only.
// It fails CVD separation (#b4632e vs #2f7d4f, 4.0 protan) and cannot be fixed
// here — the fix belongs in the design repository. Reported, never gated on:
// blocking this bundle's build on a token it does not own would only teach
// someone to delete the check.
const ADVISORY = [
  { name: 'FIELD STUDY --fs-cat-* (design system, legend only)', kind: 'categorical',
    colors: ['#7a5aa6', '#2f7d4f', '#b4632e', '#8a2d3a'] },
];

function readSurface() {
  try {
    const css = readFileSync(path.join(SRC, 'style.css'), 'utf8');
    const m = /--surface-card:\s*(#[0-9a-fA-F]{6})/.exec(css);
    return m ? m[1] : CARD_SURFACE;
  } catch { return CARD_SURFACE; }
}

// A palette is any group of three or more hex literals declared together — an
// array or an object map. Name decides the kind: anything ordinal-sounding gets
// the ramp checks, everything else is categorical. A grade ramp declared as
// categorical hues is a real defect (an ordinal dimension dressed in unordered
// colour), so it is deliberately NOT special-cased into passing.
function declaredPalettes() {
  const out = [];
  const files = readdirSync(SRC).filter(f => /\.ts$/.test(f)).sort();
  for (const file of files) {
    const src = readFileSync(path.join(SRC, file), 'utf8');
    const decls = [
      ...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\[([^\]]*)\]/g),
      ...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{([^}]*)\}/g),
    ];
    for (const m of decls) {
      const colors = [...m[2].matchAll(/['"](#[0-9a-fA-F]{6})['"]/g)].map(x => x[1]);
      if (colors.length < 3) continue;
      const line = src.slice(0, m.index).split('\n').length;
      out.push({
        name: `src/${file}:${line} ${m[1]}`,
        kind: /ORDINAL|RAMP|SEQUENTIAL/i.test(m[1]) ? 'ordinal' : 'categorical',
        colors,
      });
    }
  }
  return out;
}

function runRepoMode() {
  const surface = readSurface();
  const declared = declaredPalettes();
  if (declared.length < MIN_DECLARED) {
    console.error(
      `validate-palette: found only ${declared.length} declared palette(s) in src/, expected at ` +
      `least ${MIN_DECLARED}. The extraction has stopped matching — fix this script rather than ` +
      'lowering the threshold, or the check goes green for the wrong reason.'
    );
    process.exit(2);
  }

  console.log(`validate-palette: surface ${surface} (src/style.css --surface-card), mode light, pairs all`);
  const failures = [];
  const sets = [
    ...SANCTIONED.map(s => ({ ...s, gating: true })),
    ...declared.map(s => ({ ...s, gating: true })),
    ...ADVISORY.map(s => ({ ...s, gating: false })),
  ];
  for (const set of sets) {
    const ordinal = set.kind === 'ordinal';
    const res = ordinal
      ? validateOrdinal(set.colors, { mode: 'light', surface })
      : validate(set.colors, { mode: 'light', surface, pairs: 'all' });
    printReport(res, {
      mode: 'light', surface, ordinal, n: set.colors.length,
      title: (set.gating ? '' : 'ADVISORY ') + set.name,
    });
    if (!res.ok && set.gating) failures.push(set.name);
    if (!res.ok && !set.gating) console.log('  -> advisory only: owned by the design repository, not gated here');
  }

  const gating = sets.filter(s => s.gating).length;
  if (failures.length) {
    console.error(`\nvalidate-palette: ${failures.length} of ${gating} gating palette(s) FAILED — ${failures.join('; ')}`);
    console.error('Replace the failing hues with the sanctioned sets:');
    console.error(`  categorical  ${SANCTIONED[0].colors.join(' ')}   (4 slots maximum; rank 5+ goes to --text-ghost)`);
    console.error(`  ordinal ramp ${SANCTIONED[1].colors.join(' ')}   (SCS1 -> SCS4 is ordered, so it takes a ramp)`);
    process.exit(1);
  }
  console.log(`\nvalidate-palette: OK — ${gating} gating palette(s) pass against ${surface}, ${ADVISORY.length} advisory reported.`);
  process.exit(0);
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('validate-palette.mjs')) {
  const args = process.argv.slice(2);
  const VALUE_FLAGS = new Set(['--mode', '--surface', '--pairs']);
  const CHOICES = { mode: ['light', 'dark'], pairs: ['adjacent', 'all'] };
  const opts = {}; let positional = null;
  for (let i = 0; i < args.length; i++) {
    let a = args[i], val;
    const eq = a.indexOf('='); if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (VALUE_FLAGS.has(a)) { opts[a.slice(2)] = val ?? args[++i]; }
    else if (a === '--ordinal') { opts.ordinal = true; }
    else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else if (positional === null) { positional = a; }
    else { console.error(`unexpected extra positional: ${a}`); process.exit(2); }
  }
  for (const [k, allowed] of Object.entries(CHOICES)) {
    if (opts[k] != null && !allowed.includes(opts[k])) {
      console.error(`--${k} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(opts[k])})`); process.exit(2);
    }
  }

  if (positional === null) runRepoMode();

  const palette = splitColors(positional);
  const mode = opts.mode || 'light';
  // An empty or whitespace-only surface counts as absent.
  const rawSurface = opts.surface != null ? stripWs(opts.surface) : '';
  const surface = rawSurface || DEFAULT_SURFACE[mode];
  const badHex = [...palette, surface].filter(c => !isHexColor(c));
  if (!palette.length || badHex.length) {
    console.error(badHex.length ? `invalid hex value(s): ${badHex.join(', ')} — expected #rrggbb` : 'empty palette');
    console.error('usage: node scripts/validate-palette.mjs "#hex,#hex,..." [--mode light|dark] [--surface #hex] [--pairs adjacent|all] [--ordinal]');
    console.error('       node scripts/validate-palette.mjs        (validate everything src/ declares)');
    process.exit(2);
  }
  const pairs = opts.pairs || 'adjacent';
  const result = opts.ordinal ? validateOrdinal(palette, { mode, surface }) : validate(palette, { mode, surface, pairs });
  printReport(result, { mode, surface, ordinal: !!opts.ordinal, n: palette.length });
  process.exit(result.ok ? 0 : 1);
}
