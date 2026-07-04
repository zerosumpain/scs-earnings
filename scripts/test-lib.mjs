// Lightweight assertions for the ingestion helpers (no test framework needed).
import assert from 'node:assert';
import { parseCSV, findCol, parseMoney, parseFTE, extractDate, normGrade, normProfession, isDDaT, isPolicy, payBin } from './lib.mjs';

let n = 0; const ok = (m) => { n++; };

// CSV: quoted fields, embedded commas + newlines, escaped quotes
const rows = parseCSV('a,b,c\n"1","x,y","line1\nline2"\n"q""q",2,3\n');
assert.equal(rows.length, 3); ok();
assert.deepEqual(rows[0], ['a', 'b', 'c']); ok();
assert.equal(rows[1][1], 'x,y'); ok();
assert.equal(rows[1][2], 'line1\nline2'); ok();
assert.equal(rows[2][0], 'q"q'); ok();

// header matching
const H = ['Grade (or equivalent)', 'Job Title', 'Actual Pay Floor (£)', 'Actual Pay Ceiling (£)', 'Professional/Occupational Group', 'FTE'];
assert.equal(findCol(H, ['actual pay floor', 'pay floor']), 2); ok();
assert.equal(findCol(H, ['professional occupational group', 'profession']), 4); ok();
assert.equal(findCol(H, ['payscale minimum', 'pay floor']), 2); ok(); // fallback phrase

// money + fte
assert.equal(parseMoney('£120,000'), 120000); ok();
assert.equal(parseMoney('75000'), 75000); ok();
assert.ok(Number.isNaN(parseMoney('N/A'))); ok();
assert.equal(parseFTE('0.80'), 0.8); ok();
assert.equal(parseFTE(''), 1.0); ok();

// date extraction across all URL patterns
assert.equal(extractDate('.../organogram-cabinet-office/resources/2025-08-13T11-08-22Z-2025-06-30-organogram-senior.csv'), '2025-06-30'); ok();
assert.equal(extractDate('.../legacy/organogram/cabinet-office/30/9/2011/cabinet_office-2011-09-30-organogram-senior.csv'), '2011-09-30'); ok();
assert.equal(extractDate('.../cabinet-office__31-03-2012__foo-senior.csv'), '2012-03-31'); ok();
assert.equal(extractDate('.../dfe_20senior_20staff_20data_20september_202010.csv'), '2010-09-30'); ok();

// grade normalisation (substring traps)
assert.equal(normGrade('Permanent Secretary'), 'SCS4 / Perm Sec'); ok();
assert.equal(normGrade('Director General'), 'SCS3 (Dir Gen)'); ok();
assert.equal(normGrade('Deputy Director'), 'SCS1 (Dep Dir)'); ok();
assert.equal(normGrade('Director'), 'SCS2 (Dir)'); ok();
assert.equal(normGrade('SCS2'), 'SCS2 (Dir)'); ok();

// profession + flags
assert.equal(normProfession('Policy', 'Deputy Director, Schools Policy'), 'Policy'); ok();
assert.equal(normProfession('Information Technology', 'CIO'), 'Digital, Data & Technology'); ok();
assert.equal(isDDaT('Digital, Data & Technology', ''), true); ok();
assert.equal(isDDaT('Finance', 'Head of Data Science'), true); ok();
assert.equal(isPolicy('Other / Not stated', 'Director of Policy'), true); ok();
assert.equal(isPolicy('Operational Delivery', 'Head of Policing Standards'), false); ok(); // "policing" != policy

// bins
assert.equal(payBin(72500), 14); ok();

console.log(`lib.mjs: ${n} assertions passed`);
