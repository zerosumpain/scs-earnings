#!/usr/bin/env node
// Regression guard: the thing that stands between a bad ingest and a deploy.
//
// Compares the build sitting in public/data against the last one that was
// accepted, and exits 2 when something looks wrong. It exists because of one
// measured near-miss: a discovery run yielded 533 unique (department, date)
// pairs against 537 the run before — under 1% — while a whole department had
// silently vanished underneath, because DBT's loss was covered by ten
// genuinely new snapshots elsewhere. A headline total cannot see that. The
// per-organisation and per-dictionary checks can, and they are the reason this
// file is not three lines long.
//
// Thresholds, never vibes. Every gate below is a stated number with a stated
// reason, and each one is printed on a passing run as well as a failing one:
// the table is the alert body, and a monitor that only speaks when it is
// unhappy trains you to distrust its silence.
//
// The baseline is read FROM DISK, never from git. Two reasons: the repository
// has no remote yet, so `git show HEAD:...` is the only copy of anything and a
// guard that depends on it fails in a fresh clone; and the guard has to be
// runnable against an arbitrary previous build directory when someone is
// investigating. data/baseline.json is tracked in git and must be committed
// together with public/data — it is the diff baseline in the same way
// data/manifest.json is the ingest state.
//
// Node 22 built-ins only.
//
//   node scripts/datadiff.mjs                    # check public/data
//   node scripts/datadiff.mjs --promote          # accept this build as the baseline
//   node scripts/datadiff.mjs --baseline <path>  # a baseline file, or a previous data dir
//   node scripts/datadiff.mjs --dir <path>       # the build to check
//   node scripts/datadiff.mjs --require-full     # a partial build is itself an error
//
// Exit: 0 clean · 1 warnings only, deploy may proceed · 2 blocked, do not
// deploy and do not commit. Callers gate on rc >= 2.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- thresholds ------------------------------------------------------------
// Baselines in the comments are the corpus as measured on 2026-08-15: 537
// snapshots, 139,291 published post rows, 26 tier A organisations, 164 dates,
// a persistent ~6% fetch failure rate and 17 undated resources.
const T = {
  // The corpus is append-only in practice: departments publish new snapshots
  // and only very rarely correct an old one in place. A fall in the total is
  // therefore a pipeline fault until proven otherwise.
  postsDropPct: 5,          // block: total published post rows
  warnPostsDropPct: 1,      // warn:  smaller falls are worth saying out loud

  orgSnapshotDropPct: 10,   // block: one organisation losing a tenth of its history
  warnOrgSnapshotDropPct: 2,

  // A median is a band edge here, so it moves in £5,000 steps. A tenth of a
  // median is four bands: nothing legitimate moves that far between builds.
  medianMovePct: 10,
  medianMinN: 50,           // below this, a single date's median is noise

  cubeBytesMovePct: 25,     // block: the cube changing size by a quarter

  // Around 6% of downloads fail persistently — dead S3 hosts, four DIT
  // resources that 500 from CKAN itself, the 2010-2012 two-file era. Alerting
  // on failures being non-zero would fire every single month and be muted
  // within two. Alert on the number CHANGING.
  filesFailRise: 5,         // block: absolute rise
  failRatePpChange: 2,      // warn:  the rate moving, in percentage points, either way

  // The earliest signal of a gov.uk URL-scheme change.
  undatedRise: 10,          // block
};

// Grade bands excluded from the median. `Below SCS` is a real band — DHSC
// publishes ~3,500 junior rows inside senior files and rejecting those files
// would lose the Permanent Secretary — but it is not an SCS figure and must
// never be summed into one. `Other / Not stated` is excluded for the same
// reason meta.stats.seniorPosts excludes it: it is an absence, not a grade.
const NON_SCS_BANDS = new Set(['Below SCS', 'Other / Not stated']);

const PAYLOADS = ['meta.json', 'cube-core.json', 'cube-core-b.json', 'cube-prof.json', 'cube-prof-b.json'];

// ---- CLI -------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const opt = (n, d = null) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const DIR = path.resolve(ROOT, opt('--dir', path.join('public', 'data')));
const BASELINE = path.resolve(ROOT, opt('--baseline', path.join('data', 'baseline.json')));
const PROMOTE = flag('--promote');
const REQUIRE_FULL = flag('--require-full');

const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
// Paths are shown relative to the repository when they are inside it, absolute
// when they are not: "../../../tmp/..." in an alert body helps nobody.
const show = (p) => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };
const n = (v) => (v == null ? '-' : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const signed = (v) => (v == null ? '-' : (v > 0 ? '+' : '') + n(v));
const pctChange = (from, to) => (from ? ((to - from) / from) * 100 : null);
const gbp = (v) => (v == null ? '-' : '£' + n(v));

// ---- build a comparable summary of one build -------------------------------
// Both sides of the diff go through this, so the comparison is always like for
// like. The baseline file is exactly this object, which is why it is a few
// kilobytes rather than a copy of a multi-megabyte build.
function summarise(dir) {
  const meta = readJSON(path.join(dir, 'meta.json'));
  if (!meta) return null;
  const core = readJSON(path.join(dir, 'cube-core.json'));

  const orgs = {};
  for (const c of meta.coverage || []) {
    orgs[c.org] = { snapshots: c.snapshots, posts: c.posts, headcount: c.headcount, disclosed: c.disclosed };
  }

  const bytes = {};
  for (const f of PAYLOADS) {
    const p = path.join(dir, f);
    if (existsSync(p)) bytes[f] = statSync(p).size;
  }

  // Manifest is optional and always the working tree's: it is repository state,
  // not payload, so a build directory handed over for investigation has none of
  // its own. Consequence, deliberately: with --baseline pointing at a directory
  // both sides carry the same failure list and the newly-failing report is
  // empty. It only ever enriches the report — every gate reads meta.stats.
  const manifest = readJSON(path.join(ROOT, 'data', 'manifest.json'));

  return {
    schema: 1,
    kind: 'scs-earnings-datadiff-baseline',
    promoted: new Date().toISOString(),
    generated: meta.generated,
    metaSchema: meta.schema,
    scope: meta.scope,
    stats: meta.stats,
    dicts: {
      orgs: (meta.orgs || []).map(o => o.id),
      grades: meta.grades || [],
      profs: meta.profs || [],
      statuses: meta.statuses || [],
      withheldReasons: meta.withheldReasons || [],
      dates: meta.dates || [],
    },
    orgs,
    medians: mediansByDate(meta, core),
    bytes,
    cpih: { live: !!meta.cpih?.live, source: meta.cpih?.source ?? null },
    warnings: meta.warnings || [],
    failureUrls: (manifest?.failures || []).map(f => f.url).sort(),
  };
}

// Weighted median band over the DISCLOSED subset of the tier A cube, per
// reference date. Pay is published as a (floor, ceiling) band £5,000 wide, so
// there is no midpoint to take a median of: what comes back is the band the
// median post falls in, and the comparison is made on its floor. That is
// deliberately coarse — it moves in £5,000 steps, which is exactly the
// resolution the data has.
function mediansByDate(meta, core) {
  const out = {};
  if (!core?.rows?.length) return out;
  const bin = core.binWidth || meta.binWidth || 5000;
  const skip = new Set((meta.grades || []).map((g, i) => (NON_SCS_BANDS.has(g) ? i : -1)).filter(i => i >= 0));
  const byDate = new Map();
  for (const r of core.rows) {
    const [dateIdx, , gradeIdx, binLow, binHigh, count] = r;
    if (binLow < 0 || !count || skip.has(gradeIdx)) continue;
    if (!byDate.has(dateIdx)) byDate.set(dateIdx, []);
    byDate.get(dateIdx).push([binLow, binHigh, count]);
  }
  for (const [dateIdx, cells] of byDate) {
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const total = cells.reduce((a, c) => a + c[2], 0);
    let seen = 0, hit = cells[cells.length - 1];
    for (const c of cells) { seen += c[2]; if (seen >= total / 2) { hit = c; break; } }
    out[meta.dates[dateIdx]] = { n: total, floor: hit[0] * bin, ceil: hit[1] * bin + bin - 1 };
  }
  return out;
}

// ---- diff ------------------------------------------------------------------
const blocks = [];
const warns = [];
const block = (m) => blocks.push(m);
const warn = (m) => warns.push(m);

function missingFrom(before, after) {
  const s = new Set(after);
  return before.filter(v => !s.has(v));
}

function compare(prev, now) {
  // Scope. A partial build (--only, --tier, --max-files) is not comparable with
  // a full one and is not publishable either. Running the thresholds across
  // that boundary would fire every gate at once and teach everyone to ignore
  // them, so the comparison is skipped and said out loud instead.
  const scopeKey = (s) => JSON.stringify([s?.tier ?? 'ALL', s?.only ?? null, s?.maxFiles ?? null]);
  if (scopeKey(prev.scope) !== scopeKey(now.scope)) {
    warn(`scope changed: baseline ${JSON.stringify(prev.scope)} vs now ${JSON.stringify(now.scope)} — ` +
      'thresholds are meaningless across that boundary, so no gate was applied');
    return false;
  }

  if (prev.metaSchema !== now.metaSchema) {
    block(`meta.json schema ${prev.metaSchema} -> ${now.metaSchema}: the data contract changed. ` +
      'Re-read docs/DATA-CONTRACT.md and promote a new baseline deliberately.');
  }

  const a = prev.stats, b = now.stats;

  // 1. Snapshots never fall. The dataset is append-only in practice.
  if (b.snapshots < a.snapshots) {
    block(`snapshots ${n(a.snapshots)} -> ${n(b.snapshots)} (${signed(b.snapshots - a.snapshots)}): ` +
      'the corpus is append-only, so a fall means discovery lost something');
  }

  // 2. Total published post rows.
  const postsPct = pctChange(a.posts, b.posts);
  if (postsPct != null && postsPct < -T.postsDropPct) {
    block(`published post rows ${n(a.posts)} -> ${n(b.posts)} (${postsPct.toFixed(1)}%), past the ${T.postsDropPct}% floor`);
  } else if (postsPct != null && postsPct < -T.warnPostsDropPct) {
    warn(`published post rows fell ${postsPct.toFixed(1)}% (${n(a.posts)} -> ${n(b.posts)})`);
  }

  // 3 and 4. Per organisation. This is the check that catches a rename: CKAN
  // answers success:true with count:0 and the department simply stops existing.
  for (const [id, was] of Object.entries(prev.orgs)) {
    const is = now.orgs[id];
    if (!was.snapshots) continue;
    if (!is || !is.snapshots) {
      block(`${id}: ${n(was.snapshots)} snapshots -> ${is ? 0 : 'absent'}. A department vanished. ` +
        'That is the signature of a CKAN organisation rename, not of an absence of data — ' +
        'check the slug in scripts/ingest.mjs before believing the corpus.');
      continue;
    }
    const pct = pctChange(was.snapshots, is.snapshots);
    if (pct < -T.orgSnapshotDropPct) {
      block(`${id}: snapshots ${n(was.snapshots)} -> ${n(is.snapshots)} (${pct.toFixed(1)}%), past the ${T.orgSnapshotDropPct}% floor`);
    } else if (pct < -T.warnOrgSnapshotDropPct) {
      warn(`${id}: snapshots ${n(was.snapshots)} -> ${n(is.snapshots)} (${pct.toFixed(1)}%)`);
    }
  }

  // 5. Dictionaries. Compared as sets, not counts: a rename that adds one entry
  // and drops another leaves the count identical and every index shifted.
  for (const key of ['orgs', 'grades', 'profs', 'statuses', 'withheldReasons', 'dates']) {
    const gone = missingFrom(prev.dicts[key] || [], now.dicts[key] || []);
    if (gone.length) {
      block(`dictionary "${key}" lost ${gone.length} entr${gone.length === 1 ? 'y' : 'ies'}: ` +
        gone.slice(0, 8).map(v => JSON.stringify(v)).join(', ') + (gone.length > 8 ? ', ...' : '') +
        '. Index spaces are shared across every emitted file, so a lost entry re-numbers the cubes.');
    }
  }

  // 6. Median pay per reference date.
  for (const [date, was] of Object.entries(prev.medians)) {
    const is = now.medians[date];
    if (!is) continue;                                        // the dates check owns disappearance
    if (was.n < T.medianMinN || is.n < T.medianMinN) continue; // too few posts to read a move
    const pct = pctChange(was.floor, is.floor);
    if (pct != null && Math.abs(pct) > T.medianMovePct) {
      block(`${date}: median band floor ${gbp(was.floor)} -> ${gbp(is.floor)} (${pct.toFixed(1)}%) ` +
        `on n ${n(was.n)} -> ${n(is.n)}, past the ${T.medianMovePct}% bound. A published median does ` +
        'not move that far in one build; the sample changed shape.');
    }
  }

  // 7. Cube size. A cube that changes size by a quarter has changed grain,
  //    scope or encoding, none of which happen by accident between two runs.
  for (const f of ['cube-core.json', 'cube-prof.json']) {
    const was = prev.bytes[f], is = now.bytes[f];
    if (!was || !is) continue;
    const pct = pctChange(was, is);
    if (Math.abs(pct) > T.cubeBytesMovePct) {
      block(`${f} ${n(was)} -> ${n(is)} bytes (${pct.toFixed(1)}%), past the ±${T.cubeBytesMovePct}% bound`);
    }
  }

  // 8. Fetch failures: the RATE changing, never the rate being non-zero.
  const rate = (s) => (s.filesOk + s.filesFail ? (100 * s.filesFail) / (s.filesOk + s.filesFail) : 0);
  const rose = b.filesFail - a.filesFail;
  if (rose > T.filesFailRise) {
    block(`failed downloads ${n(a.filesFail)} -> ${n(b.filesFail)} (${signed(rose)}), past a rise of ${T.filesFailRise}`);
  }
  const ppMove = rate(b) - rate(a);
  if (Math.abs(ppMove) > T.failRatePpChange) {
    warn(`fetch failure rate ${rate(a).toFixed(1)}% -> ${rate(b).toFixed(1)}% ` +
      `(${ppMove > 0 ? '+' : ''}${ppMove.toFixed(1)}pp). A persistent ~6% is normal; the change is the signal`);
  }
  const newlyFailing = missingFrom(now.failureUrls || [], prev.failureUrls || []);
  if (newlyFailing.length) {
    warn(`${newlyFailing.length} resource(s) started failing: ` +
      newlyFailing.slice(0, 3).map(u => u.replace(/^https?:\/\//, '').slice(0, 78)).join('; ') +
      (newlyFailing.length > 3 ? `; and ${newlyFailing.length - 3} more (see data/manifest.json)` : ''));
  }

  // 9. Undated resources: the earliest signal of a URL-scheme change upstream.
  const undatedRise = b.undatedSkipped - a.undatedSkipped;
  if (undatedRise > T.undatedRise) {
    block(`undated resources ${n(a.undatedSkipped)} -> ${n(b.undatedSkipped)} (${signed(undatedRise)}), ` +
      `past a rise of ${T.undatedRise}. A jump here usually means gov.uk changed its URL scheme`);
  } else if (undatedRise > 0) {
    warn(`undated resources ${n(a.undatedSkipped)} -> ${n(b.undatedSkipped)} (${signed(undatedRise)})`);
  }

  // 10. Provenance the page renders as a claim.
  if (prev.cpih.live && !now.cpih.live) {
    warn(`CPIH fell back to the built-in table (${now.cpih.source}). Every real-terms figure on the ` +
      'page is now deflated by a stored index — surface it, do not hide it');
  }
  const newWarnings = missingFrom(now.warnings, prev.warnings);
  for (const w of newWarnings) warn(`new build warning: ${w}`);

  return true;
}

// ---- report ----------------------------------------------------------------
function row(label, was, is) {
  const delta = (typeof was === 'number' && typeof is === 'number') ? signed(is - was) : '';
  const pct = (typeof was === 'number' && typeof is === 'number' && was)
    ? `${((is - was) / was * 100).toFixed(1)}%` : '';
  console.log(`  ${label.padEnd(26)} ${n(was).padStart(11)} ${n(is).padStart(11)} ${delta.padStart(9)} ${pct.padStart(8)}`);
}

function report(prev, now) {
  console.log(`datadiff: ${show(DIR)} against ${show(BASELINE)}`);
  console.log(`  baseline ${prev.fromDir ? `read from ${show(prev.fromDir)}, not a promoted baseline` : `promoted ${prev.promoted}`}  data as of ${prev.generated}`);
  console.log(`  current  data as of ${now.generated}  scope ${JSON.stringify(now.scope)}\n`);

  console.log(`  ${'measure'.padEnd(26)} ${'baseline'.padStart(11)} ${'now'.padStart(11)} ${'change'.padStart(9)} ${''.padStart(8)}`);
  console.log(`  ${'-'.repeat(26)} ${'-'.repeat(11)} ${'-'.repeat(11)} ${'-'.repeat(9)} ${'-'.repeat(8)}`);
  const a = prev.stats, b = now.stats;
  row('organisations', a.orgs, b.orgs);
  row('snapshots', a.snapshots, b.snapshots);
  row('reference dates', a.dates, b.dates);
  row('published post rows', a.posts, b.posts);
  row('headcount', a.headcount, b.headcount);
  row('pay disclosed', a.disclosed, b.disclosed);
  row('senior posts', a.seniorPosts, b.seniorPosts);
  row('cube cells (core)', a.coreCells, b.coreCells);
  row('files ok', a.filesOk, b.filesOk);
  row('files failed', a.filesFail, b.filesFail);
  row('undated skipped', a.undatedSkipped, b.undatedSkipped);
  row('rejected siblings', a.rejectedSiblings, b.rejectedSiblings);
  for (const f of ['meta.json', 'cube-core.json', 'cube-prof.json']) {
    if (prev.bytes[f] && now.bytes[f]) row(`${f} bytes`, prev.bytes[f], now.bytes[f]);
  }

  const dictLine = ['orgs', 'grades', 'profs', 'statuses', 'dates']
    .map(k => `${k} ${(prev.dicts[k] || []).length}->${(now.dicts[k] || []).length}`).join(', ');
  console.log(`\n  dictionaries: ${dictLine}`);
  const datesAdded = missingFrom(now.dicts.dates, prev.dicts.dates);
  const orgsAdded = missingFrom(now.dicts.orgs, prev.dicts.orgs);
  if (datesAdded.length) console.log(`  dates added: ${datesAdded.slice(0, 10).join(', ')}${datesAdded.length > 10 ? `, +${datesAdded.length - 10} more` : ''}`);
  if (orgsAdded.length) console.log(`  organisations added: ${orgsAdded.join(', ')}`);
  console.log(`  CPIH: ${now.cpih.source}${now.cpih.live ? '' : '  <- FALLBACK TABLE'}`);

  // Per organisation, every one of them: this text is the alert body, and the
  // whole point of the guard is that a departmental loss can hide inside a
  // healthy total.
  console.log(`\n  per organisation      ${'snapshots'.padStart(14)} ${'posts'.padStart(16)} ${'disclosed'.padStart(16)}`);
  const ids = [...new Set([...Object.keys(prev.orgs), ...Object.keys(now.orgs)])].sort();
  for (const id of ids) {
    const was = prev.orgs[id] || { snapshots: 0, posts: 0, disclosed: 0 };
    const is = now.orgs[id] || { snapshots: 0, posts: 0, disclosed: 0 };
    const same = was.snapshots === is.snapshots && was.posts === is.posts && was.disclosed === is.disclosed;
    const mark = !now.orgs[id] ? ' GONE' : !prev.orgs[id] ? ' NEW' : same ? '' : ' *';
    console.log(`  ${id.padEnd(20)} ${`${n(was.snapshots)} -> ${n(is.snapshots)}`.padStart(14)} ` +
      `${`${n(was.posts)} -> ${n(is.posts)}`.padStart(16)} ${`${n(was.disclosed)} -> ${n(is.disclosed)}`.padStart(16)}${mark}`);
  }

  // The largest median moves, whether or not they tripped anything.
  const moves = Object.entries(prev.medians)
    .filter(([d, w]) => now.medians[d] && w.n >= T.medianMinN && now.medians[d].n >= T.medianMinN)
    .map(([d, w]) => [d, w, now.medians[d], Math.abs(pctChange(w.floor, now.medians[d].floor) || 0)])
    .sort((x, y) => y[3] - x[3]).slice(0, 5);
  if (moves.length) {
    console.log(`\n  largest median-band moves (n >= ${T.medianMinN}, tier A, SCS bands only)`);
    for (const [d, w, i, m] of moves) {
      const band = (x) => `${gbp(x.floor)}-${gbp(x.ceil)}`;
      console.log(`  ${d}   ${band(w).padStart(19)} -> ${band(i).padStart(19)}   ${(m.toFixed(1) + '%').padStart(6)}   n ${n(w.n)} -> ${n(i.n)}`);
    }
  }
}

// ---- main ------------------------------------------------------------------
const now = summarise(DIR);
if (!now) {
  console.error(`datadiff: no readable meta.json in ${show(DIR)} — there is no build to check.`);
  process.exit(2);
}

if (PROMOTE) {
  mkdirSync(path.dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(now, null, 1));
  console.log(`datadiff: promoted ${show(DIR)} to ${show(BASELINE)} ` +
    `(${n(now.stats.snapshots)} snapshots, ${n(now.stats.posts)} post rows, ${Object.keys(now.orgs).length} organisations).`);
  console.log('  Commit it with public/data — it is the diff baseline, in the same way data/manifest.json is the ingest state.');
  process.exit(0);
}

if (now.scope?.partial) {
  const msg = `the build in ${show(DIR)} is PARTIAL (a CLI filter was applied) and is not publishable`;
  if (REQUIRE_FULL) {
    console.error(`datadiff: BLOCKED — ${msg}. Re-run scripts/ingest.mjs with no --only/--tier/--max-files.`);
    process.exit(2);
  }
  warn(`${msg} — reported, and blocked only under --require-full`);
}

// The baseline may be this script's own summary file, or a directory holding a
// previous public/data (a .prev copy, or a checkout put aside for comparison).
let prev = null;
if (existsSync(BASELINE)) {
  if (statSync(BASELINE).isDirectory()) {
    // A previous build directory: a .prev copy, or a checkout put aside for
    // comparison. Summarised on the spot so both sides go through one function.
    prev = summarise(BASELINE);
    if (prev) prev.fromDir = BASELINE;
  } else {
    prev = readJSON(BASELINE);
  }
}
if (!prev) {
  console.log(`datadiff: no baseline at ${show(BASELINE)} — nothing to compare against.`);
  console.log('  This is expected exactly once. Accept the current build with:');
  console.log('    node scripts/datadiff.mjs --promote');
  console.log(`  Current build: ${n(now.stats.snapshots)} snapshots, ${n(now.stats.posts)} post rows, ` +
    `${Object.keys(now.orgs).length} organisations, ${now.stats.dates} dates.`);
  for (const w of warns) console.log(`  WARN   ${w}`);
  process.exit(warns.length ? 1 : 0);
}
if (!prev.stats || !prev.dicts || !prev.orgs) {
  console.error(`datadiff: ${show(BASELINE)} is not a datadiff baseline and not a build ` +
    'directory. Point --baseline at data/baseline.json or at a previous public/data.');
  process.exit(2);
}

report(prev, now);
const compared = compare(prev, now);

console.log('');
for (const w of warns) console.log(`  WARN   ${w}`);
for (const b of blocks) console.log(`  BLOCK  ${b}`);

if (blocks.length) {
  console.error(`\ndatadiff: BLOCKED — ${blocks.length} regression(s). Do not deploy and do not commit this build.`);
  console.error('  Restore the previous data (git checkout -- public/data) and fix the cause, not the threshold.');
  process.exit(2);
}
if (warns.length) {
  console.log(`\ndatadiff: PASS with ${warns.length} warning(s)${compared ? '' : ' (no gate applied)'} — ` +
    'rc=1, advisory. Read them before deploying.');
  process.exit(1);
}
console.log(`\ndatadiff: PASS — ${n(now.stats.snapshots)} snapshots across ${Object.keys(now.orgs).length} ` +
  `organisations, no threshold tripped. Promote with --promote once the build is accepted.`);
process.exit(0);
