#!/usr/bin/env node
// Minimum-text-size lockfile for the SCS earnings bundle.
//
// Mirrors ~/strange_rambling_svelte/scripts/check-font-sizes.mjs: same floor,
// same token names, same "fix the script, do not lower the threshold" canary.
// The gap it closes is the same one — there is no linter for "this text is too
// small". TypeScript and Vite are both perfectly happy with `font-size: 9`, and
// in a dense chart every one of those looks reasonable on its own. A floor that
// is not asserted erodes again one label at a time.
//
// The floor is 12px / 0.75rem, matching --fs-label-xs. WCAG 2.2 sets no
// explicit minimum, but text under it fails in practice on two counts: SC 1.4.4,
// because a px size ignores the reader's own browser font-size outright, and
// SC 1.4.10/1.4.12, because a sub-16px form field makes mobile Safari force-zoom
// the viewport on focus and strand the rest of the page off-screen. Both were
// live here: the Top-earners search box and department picker sat at 13px and
// 12px, and every chart label rendered at 4.8 CSS px on a 390px phone because
// the drawing was scaled to 0.48x inside a fixed 640-unit viewBox.
//
// WHY IT IS NOT THE SITE'S SCRIPT VERBATIM. Three differences, all forced by
// this bundle:
//   1. There is no Svelte and no Tailwind. Sizes live in src/style.css and in
//      inline style strings inside src/*.ts, and the charts are hand-built SVG.
//   2. Sizes are written as tokens, so a literal-hunting regex reports a clean
//      sweep over a `font-size: var(--fs-label)` on a text input. The token
//      table is therefore read out of src/style.css and RESOLVED to px, which
//      is what makes the 16px control floor enforceable at all.
//   3. Chart text is set through the style property rather than an SVG
//      presentation attribute (var() does not resolve in an attribute), and the
//      charts draw at 1 user unit == 1 CSS px. So an SVG font-size literal IS a
//      px size here and is checked as one — see the escape marker below.
//
// SVG USER-UNITS ESCAPE MARKER. If a chart is ever drawn into a viewBox that is
// deliberately not 1:1 with CSS pixels, a literal font-size is a user-unit
// value and the px floor does not apply to it. Mark that line with the comment
// `svg-user-units` and state the scale factor beside it. Exemptions are counted
// and printed on every run, passing or failing, so one can never hide: an
// unexplained marker is an invitation to audit, not a way to silence the check.
//
// Run:  node scripts/check-font-sizes.mjs
// Exit: 0 clean · 1 one or more declarations below a floor · 2 the check itself
//       is broken (token gone, extraction stopped matching) — never trust a 0
//       from a script that could not find anything to look at.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const FLOOR_PX = 12;
const FLOOR_REM = 0.75;
/** Anything a reader types into or picks from. Below this, mobile Safari zooms. */
const FIELD_FLOOR_PX = 16;

const SCOPE = ['src'];
const TOKENS_FILE = path.join(ROOT, 'src', 'style.css');

// If the extraction silently breaks — a reformat, a move to CSS modules, a
// helper that builds the style string — the inventory shrinks and this check
// goes green for the wrong reason. Measured at 73 across 12 files, 69 of them
// in src/style.css because the sizes are supposed to live there. The floor sits
// below that so ordinary editing does not trip it, but a regex that has stopped
// matching does.
const MIN_DECLARATIONS = 60;
const CANARY_TOKENS = ['--fs-label-xs', '--fs-body'];

const ESCAPE_MARKER = 'svg-user-units';

// ---- token table -----------------------------------------------------------
// Resolve --fs-* to px so a token can be checked, not just a literal. Only
// length-valued tokens land here: --fs-serif is a font family and --fs-fact a
// colour, which is exactly the namespace collision the stylesheet header warns
// about, so anything that is not a length is deliberately skipped rather than
// coerced to NaN.
function readTokens() {
  const css = readFileSync(TOKENS_FILE, 'utf8');
  const tokens = new Map();
  for (const m of css.matchAll(/(--fs-[\w-]+)\s*:\s*(\d+(?:\.\d+)?)(px|rem)\s*;/g)) {
    tokens.set(m[1], m[3] === 'rem' ? parseFloat(m[2]) * 16 : parseFloat(m[2]));
  }
  return tokens;
}

const TOKENS = readTokens();

/** px value of a font-size expression, or null when it cannot be resolved statically. */
function resolvePx(expr) {
  const lit = /^\s*(\d+(?:\.\d+)?)(px|rem)\s*$/.exec(expr);
  if (lit) return lit[2] === 'rem' ? parseFloat(lit[1]) * 16 : parseFloat(lit[1]);
  const v = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/.exec(expr);
  if (v) {
    if (TOKENS.has(v[1])) return TOKENS.get(v[1]);
    if (v[2]) return resolvePx(v[2]);
    return null;
  }
  return null;
}

// ---- the global control floor ----------------------------------------------
// src/style.css carries an `input, select, textarea { font-size: var(--fs-body)
// !important }` rule precisely because two controls are still styled inline
// from src/tab-records.ts, and an inline declaration beats a class. An author
// !important DOES beat an inline non-important declaration, so those two
// controls really do render at 16px. Reporting them as violations would be
// wrong; ignoring the situation entirely would be worse, because deleting that
// one rule silently reintroduces the zoom bug. So: detect the override, and
// report anything it is currently rescuing as a note rather than a failure.
function findControlOverride() {
  const css = readFileSync(TOKENS_FILE, 'utf8');
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1], body = m[2];
    if (!/\binput\b/.test(sel) || !/\bselect\b/.test(sel) || !/\btextarea\b/.test(sel)) continue;
    const fs = /font-size\s*:\s*([^;!]+)!important/.exec(body);
    if (!fs) continue;
    const px = resolvePx(fs[1].trim());
    if (px != null && px >= FIELD_FLOOR_PX) {
      return { px, line: css.slice(0, m.index).split('\n').length + 1, decl: fs[1].trim() };
    }
  }
  return null;
}

const OVERRIDE = findControlOverride();

// ---- scan ------------------------------------------------------------------
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|css)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const files = SCOPE.flatMap(p => walk(path.join(ROOT, p)));

let counted = 0;
const violations = [];
const notes = [];
const exemptions = [];

const lineAt = (src, i) => src.slice(0, i).split('\n').length;
const lineText = (src, i) => {
  const start = src.lastIndexOf('\n', i) + 1;
  const end = src.indexOf('\n', i);
  return src.slice(start, end === -1 ? undefined : end);
};
const context = (src, i) => lineText(src, i).trim().slice(0, 88);
const exempt = (src, i) => lineText(src, i).includes(ESCAPE_MARKER);

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const at = (i) => `${rel}:${lineAt(src, i)}`;

  // Count every size expression, token or literal — the canary needs the total.
  // A healthy file is almost all `font-size: var(--fs-*)`, so counting only the
  // numeric matches would shrink the canary as the sweep succeeds, which is
  // precisely backwards.
  counted += [...src.matchAll(/font-size'?\s*[:,]/g)].length;

  // 1. A literal with a unit: `font-size: 9px`, `'font-size': '0.6rem'`.
  for (const m of src.matchAll(/font-size'?\s*[:,]\s*'?(\d+(?:\.\d+)?)(px|rem)/g)) {
    const n = parseFloat(m[1]);
    const floor = m[2] === 'px' ? FLOOR_PX : FLOOR_REM;
    if (n >= floor) continue;
    if (exempt(src, m.index)) { exemptions.push(`  ${at(m.index)}  ${m[1]}${m[2]}  ${context(src, m.index)}`); continue; }
    violations.push(`  ${at(m.index)}  ${m[1]}${m[2]} (${m[2] === 'px' ? n : n * 16}px) below the ${FLOOR_PX}px floor  ${context(src, m.index)}`);
  }

  // 2. Unitless SVG presentation attribute, both spellings this bundle uses:
  //    el('text', { 'font-size': 11 })  and  .setAttribute('font-size', 11).
  //    A var() token does not resolve in an SVG attribute, so these have to be
  //    literals and therefore need their own check. Charts here draw at
  //    1 user unit == 1 CSS px, so the number IS a px size.
  for (const m of src.matchAll(/font-size'?\s*[:,]\s*'?(\d+(?:\.\d+)?)'?\s*[,;}\n)]/g)) {
    const n = parseFloat(m[1]);
    if (n >= FLOOR_PX) continue;
    if (exempt(src, m.index)) { exemptions.push(`  ${at(m.index)}  ${m[1]} user units  ${context(src, m.index)}`); continue; }
    violations.push(`  ${at(m.index)}  unitless SVG font-size ${m[1]} below the ${FLOOR_PX}px floor  ${context(src, m.index)}`);
  }

  // 3. A var() fallback under the floor. `var(--fs-label-xs, 0.6rem)` renders at
  //    0.6rem on any surface that has not loaded the stylesheet — and the whole
  //    reason the charts carry fallbacks is that they are drawn before it does.
  for (const m of src.matchAll(/font-size'?\s*[:,]\s*'?var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g)) {
    const [, token, fallback] = m;
    if (!TOKENS.has(token) && !fallback) {
      violations.push(`  ${at(m.index)}  var(${token}) is not a length token in src/style.css  ${context(src, m.index)}`);
      continue;
    }
    const tokenPx = TOKENS.get(token);
    if (tokenPx != null && tokenPx < FLOOR_PX) {
      violations.push(`  ${at(m.index)}  var(${token}) resolves to ${tokenPx}px, below the ${FLOOR_PX}px floor  ${context(src, m.index)}`);
    }
    if (fallback) {
      const fbPx = resolvePx(fallback.trim());
      if (fbPx != null && fbPx < FLOOR_PX) {
        violations.push(`  ${at(m.index)}  var(${token}, ${fallback.trim()}) falls back to ${fbPx}px, below the ${FLOOR_PX}px floor  ${context(src, m.index)}`);
      }
    }
  }

  // 4. A bare sub-1em size inherits whatever the parent happens to be, so it can
  //    land under the floor with no small number anywhere in the source.
  for (const m of src.matchAll(/font-size'?\s*[:,]\s*'?(0?\.\d+)em/g)) {
    violations.push(`  ${at(m.index)}  ${m[1]}em has no floor — use max(${m[1]}em, var(--fs-label-xs))  ${context(src, m.index)}`);
  }

  // 5. Form controls. Caught by proximity: the element and its size are
  //    separated by a style string or an Object.assign. Any font-size inside
  //    the 700 characters after the element is attributed to it.
  for (const m of src.matchAll(/createElement\(\s*'(input|textarea|select)'|<(input|textarea|select)\b/g)) {
    const tag = m[1] || m[2];
    const chunk = src.slice(m.index, m.index + 700);
    for (const s of chunk.matchAll(/font-size\s*:\s*([^;'"`,}]+)/g)) {
      const px = resolvePx(s[1].trim());
      if (px == null || px >= FIELD_FLOOR_PX) continue;
      const where = `${at(m.index)}  <${tag}> styled ${s[1].trim()} = ${px}px`;
      if (OVERRIDE) {
        notes.push(`  ${where} — rescued by the !important control floor at src/style.css:${OVERRIDE.line} ` +
          `(${OVERRIDE.decl} = ${OVERRIDE.px}px). Move it to a class and drop the !important.`);
      } else {
        violations.push(`  ${where}, below the ${FIELD_FLOOR_PX}px typed-field floor — mobile Safari zooms the viewport on focus`);
      }
    }
  }
}

// ---- canaries --------------------------------------------------------------
const css = readFileSync(TOKENS_FILE, 'utf8');
for (const tok of CANARY_TOKENS) {
  if (!css.includes(`${tok}:`)) {
    console.error(
      `check-font-sizes: token ${tok} is gone from src/style.css. The scale was renamed or removed ` +
      '— update this script rather than deleting the check.'
    );
    process.exit(2);
  }
}
if (TOKENS.get('--fs-body') !== 16 || TOKENS.get('--fs-label-xs') !== 12) {
  console.error(
    `check-font-sizes: --fs-body resolves to ${TOKENS.get('--fs-body')}px and --fs-label-xs to ` +
    `${TOKENS.get('--fs-label-xs')}px, expected 16 and 12. Either the scale moved or an --fs-* name ` +
    'has stopped being a length. That second case is the documented trap: a kit copy once defined ' +
    '--fs-body as a FONT FAMILY, which turns every font-size using it into invalid CSS the browser ' +
    'silently discards, form controls included.'
  );
  process.exit(2);
}
if (counted < MIN_DECLARATIONS) {
  console.error(
    `check-font-sizes: only found ${counted} font-size expressions, expected at least ` +
    `${MIN_DECLARATIONS}. The extraction has stopped matching — fix the regexes, do not lower the ` +
    'threshold.'
  );
  process.exit(2);
}

// ---- report ----------------------------------------------------------------
for (const n of notes) console.log(n.replace(/^ {2}/, '  NOTE  '));
if (exemptions.length) {
  console.log(`  ${exemptions.length} ${ESCAPE_MARKER} exemption(s):`);
  for (const e of exemptions) console.log(e);
}

if (!violations.length) {
  console.log(
    `check-font-sizes: OK — ${counted} font-size expressions across ${files.length} files, none ` +
    `below ${FLOOR_PX}px, no typed field below ${FIELD_FLOOR_PX}px` +
    (notes.length ? `, ${notes.length} rescued by the !important control floor` : '') +
    (exemptions.length ? `, ${exemptions.length} exempt` : '') + '.'
  );
  process.exit(0);
}

console.error(`\ncheck-font-sizes: ${violations.length} declaration(s) below a floor.\n`);
for (const v of violations) console.error(v);
console.error(
  '\nUse a token instead of a literal:\n' +
  '  --fs-label-xs 12px   --fs-label 13px   --fs-nav 14px\n' +
  '  --fs-body-sm  15px   --fs-body  16px   --fs-body-lg 18px\n' +
  'Anything a reader types into or picks from gets --fs-body. Chart text goes through the style\n' +
  'property, never an SVG presentation attribute, because var() does not resolve in an attribute.\n' +
  'If a design genuinely needs smaller text, it needs a different design — this one has to be\n' +
  'legible on a 390px phone.'
);
process.exit(1);
