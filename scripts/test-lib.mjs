// Lightweight assertions for the ingestion helpers (no test framework needed).
// Every case here is a defect that reached production at least once.
import assert from 'node:assert';
import {
  parseCSV, findCol, parseMoney, parseFTE, sniffBinary, decodeBody,
  isJuniorSchema, extractDeclaredDate, extractUploadDate, resolveReferenceDate,
  quarterEnd, precedingQuarterEnd, normGrade, normProfession, isDDaT, isPolicy,
  payBin, postStatusFromName, parsePosts,
} from './lib.mjs';

let n = 0; const ok = () => { n++; };

// ---- CSV: quoted fields, embedded commas + newlines, escaped quotes --------
const rows = parseCSV('a,b,c\n"1","x,y","line1\nline2"\n"q""q",2,3\n');
assert.equal(rows.length, 3); ok();
assert.deepEqual(rows[0], ['a', 'b', 'c']); ok();
assert.equal(rows[1][1], 'x,y'); ok();
assert.equal(rows[1][2], 'line1\nline2'); ok();
assert.equal(rows[2][0], 'q"q'); ok();

// lone CR as the line ending. Harmless on live CKAN, fatal the moment the
// 2010-2012 archive recovery lands: COI 2011 parses as 1 row x 290 columns
// without the normalisation.
const cr = parseCSV('a,b,c\r1,2,3\r4,5,6\r');
assert.equal(cr.length, 3); ok();
assert.deepEqual(cr[1], ['1', '2', '3']); ok();
assert.deepEqual(cr[2], ['4', '5', '6']); ok();
assert.equal(parseCSV('a,b\r\n1,2\r\n').length, 2); ok();       // CRLF still works
assert.equal(parseCSV('"x\ry",2\n').length, 1); ok();           // CR inside quotes

// ---- header matching -------------------------------------------------------
const H = ['Grade (or equivalent)', 'Job Title', 'Actual Pay Floor (£)', 'Actual Pay Ceiling (£)', 'Professional/Occupational Group', 'FTE'];
assert.equal(findCol(H, ['actual pay floor', 'pay floor']), 2); ok();
assert.equal(findCol(H, ['professional occupational group', 'profession']), 4); ok();
assert.equal(findCol(H, ['payscale minimum', 'pay floor']), 2); ok(); // fallback phrase

// ---- money + FTE -----------------------------------------------------------
assert.equal(parseMoney('£120,000'), 120000); ok();
assert.equal(parseMoney('75000'), 75000); ok();
assert.ok(Number.isNaN(parseMoney('N/A'))); ok();
assert.equal(parseFTE('0.80'), 0.8); ok();
// unparseable and out-of-range FTE are null, never an invented 1.0
assert.equal(parseFTE(''), null); ok();
assert.equal(parseFTE('N/A'), null); ok();
assert.equal(parseFTE('12'), null); ok();     // >5 FTE is a junior post count
assert.equal(parseFTE('1.00'), 1); ok();

// ---- magic bytes: never trust content-type ---------------------------------
assert.equal(sniffBinary(Buffer.from('%PDF-1.6\n%')), 'pdf'); ok();
assert.equal(sniffBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), 'zip/xlsx'); ok();
assert.equal(sniffBinary(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), 'xls'); ok();
assert.equal(sniffBinary(Buffer.from('"Post Unique Reference","Name"')), null); ok();
// a windows-1252 £ (0xA3) is not valid UTF-8 and must not decode to U+FFFD
assert.equal(decodeBody(Buffer.from([0x28, 0xa3, 0x29])), '(£)'); ok();
assert.equal(decodeBody(Buffer.from('(£)', 'utf8')), '(£)'); ok();

// ---- reference dates -------------------------------------------------------
assert.equal(extractDeclaredDate('.../2025-08-13T11-08-22Z-2025-06-30-organogram-senior.csv'), '2025-06-30'); ok();
assert.equal(extractDeclaredDate('.../legacy/organogram/cabinet-office/30/9/2011/co-organogram-senior.csv'), '2011-09-30'); ok();
assert.equal(extractDeclaredDate('.../cabinet-office__31-03-2012__foo-senior.csv'), '2012-03-31'); ok();
// an upload stamp is not a reference date: 119 of 653 resources declare theirs
assert.equal(extractUploadDate('.../2019-03-07t12-58-16z-organogram-senior.csv'), '2019-03-07'); ok();
assert.equal(extractDeclaredDate('.../2019-03-07t12-58-16z-organogram-senior.csv'), null); ok();

// all FOUR quarter ends. 30 June used to snap back to 31 March, which is why
// the true earliest release in the corpus was invisible.
assert.equal(quarterEnd(2010, 6), '2010-06-30'); ok();
assert.equal(quarterEnd(2010, 3), '2010-03-31'); ok();
assert.equal(quarterEnd(2010, 9), '2010-09-30'); ok();
assert.equal(quarterEnd(2010, 12), '2010-12-31'); ok();
assert.equal(precedingQuarterEnd('2019-03-07'), '2018-12-31'); ok();

let r = resolveReferenceDate('.../hmt_seniorstaffposts_jun2010.csv', 'organogram-hm-treasury', 'Organogram', '2016-09-30T21:56:08');
assert.equal(r.referenceDate, '2010-06-30'); ok();
assert.equal(r.confidence, 'inferred'); ok();
r = resolveReferenceDate('.../2025-08-13T11-08-22Z-2025-06-30-organogram-senior.csv', 'organogram-dwp', 'DWP', '2025-08-13T11:08:22');
assert.equal(r.referenceDate, '2025-06-30'); ok();
assert.equal(r.confidence, 'declared'); ok();
r = resolveReferenceDate('.../2019-03-07t12-58-16z-organogram-senior.csv', 'organogram-department-for-international-trade',
  'Organogram of Staff Roles & Salaries', '2020-09-03T12:14:00', 'Organogram - Senior CSV data March 2019');
assert.equal(r.referenceDate, '2019-03-31'); ok();
assert.equal(r.confidence, 'inferred'); ok();
r = resolveReferenceDate('.../senior.csv', 'organogram-x', 'X', '2019-03-07T09:00:00');
assert.equal(r.referenceDate, '2018-12-31'); ok();
assert.equal(r.confidence, 'default'); ok();

// ---- grade: normalised band, raw string and the preserved detail -----------
assert.equal(normGrade('Permanent Secretary').band, 'SCS4 / Perm Sec'); ok();
assert.equal(normGrade('Director General').band, 'SCS3 (Dir Gen)'); ok();
assert.equal(normGrade('Deputy Director').band, 'SCS1 (Dep Dir)'); ok();
assert.equal(normGrade('Director').band, 'SCS2 (Dir)'); ok();
assert.equal(normGrade('SCS2').band, 'SCS2 (Dir)'); ok();
assert.equal(normGrade('SCS2').raw, 'SCS2'); ok();
assert.equal(normGrade('SCS Band 1 London').band, 'SCS1 (Dep Dir)'); ok();
assert.equal(normGrade('SCS Band 1 London').variant, 'London'); ok();
assert.equal(normGrade('SCS Band 1 National').variant, 'National'); ok();
assert.equal(normGrade('SCS1A').variant, 'SCS1A'); ok();
assert.equal(normGrade('OF-6').band, 'Military (OF-6+)'); ok();
assert.equal(normGrade('OF-9').variant, 'OF-9'); ok();
assert.equal(normGrade('Senior Commercial Specialist').variant, 'Senior Commercial Specialist'); ok();
assert.equal(normGrade('Deputy Parliamentary Counsel').variant, 'Parliamentary Counsel'); ok();
assert.equal(normGrade('Medical Consultant').variant, 'Medical Consultant'); ok();
assert.equal(normGrade('GRADE 7').band, 'Below SCS'); ok();
assert.equal(normGrade('HEO').senior, false); ok();
assert.equal(normGrade('SCS1').senior, true); ok();

// ---- profession: raw kept, Table 36 classes, non-answers separated ---------
assert.equal(normProfession('Policy', 'Deputy Director, Schools Policy').prof, 'Policy'); ok();
assert.equal(normProfession('Information Technology', 'CIO').prof, 'Digital, Data & Technology'); ok();
assert.equal(normProfession('Undefined', '').prof, 'Not stated'); ok();
assert.equal(normProfession('Other', '').prof, 'Other'); ok();
assert.equal(normProfession('Policy Profession', '').raw, 'Policy Profession'); ok();
// rules the old classifier had no answer for
assert.equal(normProfession('Counter-fraud Standards and Profession', '').prof, 'Counter Fraud'); ok();
assert.equal(normProfession('Geography', '').prof, 'Geography'); ok();
assert.equal(normProfession('Knowledge and Information Management (KIM)', '').prof, 'Knowledge & Information Management'); ok();
assert.equal(normProfession('Occupational Psychology', '').prof, 'Occupational Psychology'); ok();
assert.equal(normProfession('Government Operational Research Service', '').prof, 'Operational Research'); ok();
assert.equal(normProfession('Planning Inspectors', '').prof, 'Planning Inspectors'); ok();
assert.equal(normProfession('Inspector of Education and Training', '').prof, 'Inspector of Education and Training'); ok();
// ordering traps
assert.equal(normProfession('Intelligence Analysis', '').prof, 'Intelligence & Security'); ok();
assert.equal(normProfession('Operational Delivery', '').prof, 'Operational Delivery'); ok();

// ---- DDaT: case-SENSITIVE \bIT\b, not the English word "it" ----------------
assert.equal(isDDaT('Digital, Data & Technology', ''), true); ok();
assert.equal(isDDaT('Finance', 'Head of Data Science'), true); ok();
assert.equal(isDDaT('Policy', 'Director of IT'), true); ok();
assert.equal(isDDaT('Policy', 'Deputy Director, Making it Happen'), false); ok();
assert.equal(isDDaT('Policy', 'Head of Benefits and how it works'), false); ok();
assert.equal(isPolicy('Other', 'Director of Policy'), true); ok();
assert.equal(isPolicy('Operational Delivery', 'Head of Policing Standards'), false); ok();

// ---- pay bins are (low, high), never a collapsed midpoint ------------------
assert.deepEqual(payBin(70000, 74999), [14, 14]); ok();
assert.deepEqual(payBin(145000, 149999), [29, 29]); ok();
assert.deepEqual(payBin(148000, 152000), [29, 30]); ok();   // straddles £150k
// One published edge is an OPEN band, not a known one. Copying the published
// edge onto the missing side (the old [20,20]) stated a floor the department
// never published — 110 rows in the corpus publish a ceiling alone.
assert.deepEqual(payBin(100000, null), [-2, -2]); ok();
assert.deepEqual(payBin(null, 100000), [-2, -2]); ok();
assert.deepEqual(payBin(null, null), [-1, -1]); ok();

// ---- post status from the Name column (never the name itself) -------------
assert.equal(postStatusFromName('Jane Smith'), 'filled-named'); ok();
assert.equal(postStatusFromName('N/D'), 'filled-undisclosed'); ok();
assert.equal(postStatusFromName('Not disclosed'), 'filled-undisclosed'); ok();
assert.equal(postStatusFromName('VACANT'), 'vacant'); ok();
assert.equal(postStatusFromName('Vacancy'), 'vacant'); ok();
assert.equal(postStatusFromName('Eliminated'), 'eliminated'); ok();
assert.equal(postStatusFromName('REDACTED'), 'redacted'); ok();
assert.equal(postStatusFromName(''), 'blank'); ok();
assert.equal(postStatusFromName('-'), 'blank'); ok();

// ---- file-level parsing ----------------------------------------------------
const SENIOR_HEADER = '"Post Unique Reference","Name","Grade (or equivalent)","Job Title","Job/Team Function",'
  + '"Parent Department","Organisation","Unit","Contact Phone","Contact E-mail","Reports to Senior Post",'
  + '"Salary Cost of Reports (£)","FTE","Actual Pay Floor (£)","Actual Pay Ceiling (£)","","Professional/Occupational Group","Notes","Valid?"';
const seniorRow = (pur, name, grade, title, floor, ceil, valid) =>
  `"${pur}","${name}","${grade}","${title}","fn","Dept","Dept","Unit","0","e","XX","0","1.00","${floor}","${ceil}","","Policy","","${valid}"`;

// The junior schema is rejected BY CONTENT. This is the DfE September 2010
// file that used to sit at date index 0 of the corpus and set the whole
// "2010 H2" period to 465 role-group aggregates of EO/HEO/SEO staff. The old
// test enshrined it as valid.
const JUNIOR = 'Parent Department,Organisation,Unit,Reporting Senior Post,Grade,Payscale Minimum (£),'
  + 'Payscale Maximum (£),Generic Job Title,Number of Posts in FTE,Professional/Occupational Group\n'
  + 'Department for Education,Department for Education,Finance and Commercial Group,DfE-4032,EA/AO,15266,24858,Commercial Support Officer,4,Procurement\n'
  + 'Department for Education,Department for Education,Finance and Commercial Group,DfE-4032,EO,21916,32232,Personal Assistant,1,Operational Delivery\n';
assert.equal(isJuniorSchema(parseCSV(JUNIOR)[0]), true); ok();
const juniorParse = parsePosts(JUNIOR);
assert.equal(juniorParse.ok, false); ok();
assert.equal(juniorParse.reason, 'junior-schema'); ok();
assert.equal(juniorParse.posts.length, 0); ok();

// Suppressed rows are RETAINED. Two thirds of senior posts have their pay
// withheld and withholding is grade-dependent, so dropping them inverted the
// published grade mix and lifted every median.
const SUPPRESSED = [SENIOR_HEADER,
  seniorRow('P1', 'Jane Smith', 'SCS2', 'Director, Strategy', '120000', '124999', '1'),
  seniorRow('P2', 'N/D', 'SCS1', 'Deputy Director, Policy', '0', '0', '1'),
  seniorRow('P3', 'N/D', 'SCS1', 'Deputy Director, Delivery', 'N/A', 'N/A', '1'),
  seniorRow('P4', 'Vacant', 'SCS1', 'Deputy Director, Vacant', '', '', '1'),
].join('\n');
const sup = parsePosts(SUPPRESSED);
assert.equal(sup.ok, true); ok();
assert.equal(sup.posts.length, 4); ok();                       // nothing dropped
assert.equal(sup.stats.disclosed, 1); ok();
assert.equal(sup.posts[1].payDisclosed, false); ok();
assert.equal(sup.posts[1].withheldReason, 'zero'); ok();
assert.equal(sup.posts[2].withheldReason, 'N/A'); ok();
assert.equal(sup.posts[3].status, 'vacant'); ok();
assert.equal(sup.posts[0].binLow, 24); ok();
assert.equal(sup.posts[1].binLow, -1); ok();
assert.equal(sup.posts[0].unit, 'Unit'); ok();                 // structure kept
assert.equal(sup.posts[0].organisation, 'Dept'); ok();
assert.ok(!('name' in sup.posts[0])); ok();                    // never the name

// The Valid? guard is only trustworthy when the majority of pay-bearing rows
// are the ones flagged valid. FCO 2019-03-31 flags its 132 real posts 0 and
// its 1,866 blank padding rows 1, and yielded exactly ONE post.
const fcoRows = [SENIOR_HEADER];
for (let i = 0; i < 8; i++) fcoRows.push(seniorRow('R' + i, 'N/D', 'SCS1', 'Deputy Director', '70000', '74999', '0'));
for (let i = 0; i < 40; i++) fcoRows.push(seniorRow('', '', '', '', '', '', '1'));
const fco = parsePosts(fcoRows.join('\n'));
assert.equal(fco.ok, true); ok();
assert.equal(fco.stats.validApplied, false); ok();             // inverted, so not applied
assert.equal(fco.posts.length, 8); ok();                       // the real posts survive
assert.equal(fco.stats.blankRows, 40); ok();                   // padding dropped first

// ... and when the flag IS the right way round it is honoured.
const normalRows = [SENIOR_HEADER];
for (let i = 0; i < 8; i++) normalRows.push(seniorRow('R' + i, 'N/D', 'SCS1', 'Deputy Director', '70000', '74999', '1'));
normalRows.push(seniorRow('BAD', 'N/D', 'SCS1', 'Superseded post', '70000', '74999', '0'));
const normal = parsePosts(normalRows.join('\n'));
assert.equal(normal.stats.validApplied, true); ok();
assert.equal(normal.posts.length, 8); ok();
assert.equal(normal.stats.invalidDropped, 1); ok();

// Duplicate post references inside one file get an ordinal, and XX is not an
// identifier: 2,284 rows across 252 files repeat a PUR.
const dupes = [SENIOR_HEADER,
  seniorRow('P1', 'A B', 'SCS1', 'Deputy Director', '70000', '74999', '1'),
  seniorRow('P1', 'C D', 'SCS1', 'Deputy Director', '70000', '74999', '1'),
  seniorRow('XX', 'E F', 'SCS1', 'Deputy Director', '70000', '74999', '1'),
].join('\n');
const dup = parsePosts(dupes);
assert.equal(dup.posts[0].ordinal, 0); ok();
assert.equal(dup.posts[1].ordinal, 1); ok();
assert.equal(dup.posts[2].pur, ''); ok();

console.log(`lib.mjs: ${n} assertions passed`);
