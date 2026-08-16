# SCS earnings — data contract

Everything `scripts/ingest.mjs` writes, and what a consumer may assume about it.
This document is the interface between the ingestion pipeline and the frontend:
the pipeline owns `public/data/**` and `data/manifest.json`, the frontend owns
`src/**`, and neither reads the other's source.

Schema version: **1** (every file carries `schema: 1`; a breaking change bumps it).
All monetary values are **pounds sterling, integer, nominal**. All dates are
`YYYY-MM-DD`. All timestamps are ISO 8601 UTC.

---

## 1. Files

| Path | Loaded | Budget (gz) | Contents |
|---|---|---|---|
| `public/data/meta.json` | first paint | 30 KB | dictionaries, organisation registry, snapshot registry, coverage, CPIH, stats |
| `public/data/cube-core.json` | first paint | 90 KB | Tier A cube: date x org x grade x pay band |
| `public/data/cube-core-b.json` | lazy | 90 KB | the same cube for Tier B organisations |
| `public/data/cube-prof.json` | lazy | 250 KB | Tier A cube with profession and the DDaT/policy flags |
| `public/data/cube-prof-b.json` | lazy | 250 KB | the same for Tier B |
| `public/data/posts/<orgId>.json` | lazy, per organisation | 250 KB each | every published post row for one organisation, columnar |
| `public/data/changelog.json` | lazy | 20 KB | append-only run record, newest first, capped at 60 |
| `public/data/highearners.json` | lazy | 250 KB | the two Cabinet Office high-earner publications — section 9 |
| `public/data/benchmarks.json` | lazy | 40 KB | external comparators (ASHE, ACSES, SSRB, SCS pay bands) — section 10 |
| `public/data/benchmarks-itjw.json` | lazy | 15 KB | advertised-salary layer. **CC BY-NC-SA 4.0, not OGL** — quarantined, never merged into any other file. Its field-level contract lives inside the JSON itself (`fieldGuide`, `licence`, `gate`, `measure`) |
| `public/data/ukgwa.json` | lazy | 40 KB | web-archive recovery report for the 2010-2012 era — section 11 |
| `data/manifest.json` | **never shipped** | — | ingest state and diff baseline; tracked in git, not in `public/` |
| `data/ukgwa.json` | **never shipped** | — | recovery state and idempotency baseline; tracked in git |
| `data/benchmarks-review.json` | **never shipped** | — | the approved reading of every figure extracted from a PDF; tracked in git |
| `data/baseline.json` | **never shipped** | — | `scripts/datadiff.mjs --promote` writes it; the regression guard compares against it |

`notable.json` and `cube.json` are **retired**. The ingest deletes them if it
finds them. Their replacement is `posts/<orgId>.json`, which covers every post
rather than 6% of them.

Index spaces are shared across all files. A `dateIdx` in a shard means the same
date as a `dateIdx` in `cube-prof-b.json`. Load `meta.json` first, always.

---

## 2. `meta.json`

```jsonc
{
  "schema": 1,
  "generated": "2026-07-31T14:42:48.990Z", // newest upstream CKAN timestamp in the corpus,
                                           // NOT the wall clock — two runs from cache are
                                           // byte-identical, so this is deterministic
  "scope": {
    "tier": "ALL" | "A" | "B",
    "only": ["DWP","HMT"] | null,          // --only filter, if any
    "maxFiles": 40 | null,
    "partial": false                       // true when any CLI filter was applied.
                                           // A partial build is NOT publishable.
  },
  "source": { "name": …, "via": …, "licence": …, "note": …, "cadence": … },
  "binWidth": 5000,

  "dates":  ["2010-06-30", …],             // ascending; index = dateIdx
  "orgs":   [ {…}, … ],                    // index = orgIdx
  "grades": ["SCS4 / Perm Sec", …],        // index = gradeIdx, ORDINAL (senior first)
  "profs":  ["Communications", …],         // index = profIdx. Civil Service Statistics
                                           // Table 36 order, with 'Other' and
                                           // 'Not stated' last. NOT alphabetical.
  "statuses": ["filled-named","filled-undisclosed","vacant","eliminated","redacted","blank"],
  "withheldReasons": ["blank","zero","N/A","implausible","other"],

  "coverage":  [ {…}, … ],
  "snapshots": [ {…}, … ],
  "cpih":      { … },
  "stats":     { … },
  "warnings":  ["…"]                       // sorted; empty on a clean run
}
```

`grades` and `profs` contain only the values actually present in this build, in
the canonical order defined in `scripts/lib.mjs` (`GRADE_BANDS`, `PROFESSIONS`).
Never hard-code an index; look it up by name.

### 2.1 `orgs[]`

```jsonc
{
  "id": "DBT",                    // stable key; also the post shard filename
  "name": "Department for Business & Trade",
  "tier": "A",                    // "A" = the SCS spine, "B" = wider senior public sector
  "family": "Business/Energy/Sci",
  "validFrom": "2023-02-07",      // null = no start bound
  "validTo": null,                // null = still current
  "predecessors": ["DIT","BEIS"],
  "successors": []
}
```

**Two rules a consumer must enforce, not assume:**

1. **Never sum an organisation with its own predecessor or successor in one
   total.** In 2023 the corpus legitimately holds BEIS, DESNZ, DSIT and DBT at
   the same time; adding them double-counts. For a cross-period series, offer a
   constant-scope basis: restrict to organisations present in every selected
   period.
2. **Never sum Tier B into an "SCS" figure.** Tier B bodies map internal bands
   onto SCS-*equivalents*. They are shipped, and they are interesting, but they
   are a different population. Keep the boundary visible in the UI.

### 2.2 `coverage[]`

One row per organisation in this build.

| Field | Type | Meaning |
|---|---|---|
| `org` | string | organisation id |
| `snapshots` | int | number of (org, reference date) snapshots |
| `dates` | int[] | `dateIdx` values present, ascending |
| `posts` | int | published post rows, including eliminated posts |
| `headcount` | int | `posts` minus eliminated posts |
| `disclosed` | int | posts in `headcount` with a published pay band |

### 2.3 `snapshots[]`

One row per (organisation, reference date). This is the unit of publication.

| Field | Type | Meaning |
|---|---|---|
| `org` | string | organisation id |
| `d` | int | `dateIdx` |
| `conf` | string | `declared` \| `inferred` \| `default` — the weakest confidence among the parts |
| `rows` | int | published post rows in the snapshot |
| `headcount` | int | `rows` minus eliminated |
| `disclosed` | int | rows in `headcount` with a published pay band |
| `parts[]` | array | one entry per CKAN **package** summed into this snapshot |
| `parts[].pkg` | string | CKAN package name — the sub-organisation identity |
| `parts[].rows` | int | rows contributed by that package |
| `parts[].conf`, `parts[].basis` | string | how that part's reference date was resolved |

A snapshot is the **sum of sibling packages** for one department and reference
date. MOD publishes under eight packages (the department, three museums, MSHQ,
DNE, NADG, Department of State); keying on date alone let a museum displace the
department, so MOD headcount read 290 → 5 → 155 → 7. `parts[]` is what lets a
consumer decompose a department back into its arms-length bodies.

**Reference-date confidence.**

* `declared` — the publisher wrote the reference date into the resource path.
* `inferred` — taken from a month named in the filename, resource name, package
  name or package title, snapped to that month's quarter end (31 Mar, 30 Jun,
  30 Sep, 31 Dec — all four).
* `default` — snapped from the upload timestamp to the preceding quarter end.
  Lowest confidence. Show it as such.

Upload stamps are never treated as reference dates: 119 of 653 resources
declare their upload stamp in the filename, and DEFRA's 2024-02-12 and
2024-02-13 "snapshots" were one snapshot shown twice.

### 2.4 `cpih`

```jsonc
{
  "index": { "2000": 73.4, …, "2025": 138.0 },  // annual CPIH, 2015 = 100, series L522 (MM23)
  "source": "ONS MM23/L522 (live)",
  "live": true,
  "url": "https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/l522/mm23/data",
  "warning": null                                // non-null when the built-in table was used
}
```

There is **no 2026 row and there will not be one** until ONS publishes an
annual figure. The previous pipeline invented `2026: 139.5`. Deflating an
incomplete year against a fabricated index on a page whose selling point is
provenance is the single worst thing this repository has done; do not restore
it. Render 2026 nominal-only, marked as such.

If `live` is `false` the run fell back to the built-in table: surface
`cpih.warning` in the UI, do not hide it.

### 2.5 `stats`

| Field | Meaning |
|---|---|
| `orgs`, `snapshots`, `files`, `dates` | corpus size |
| `dateRange` | `[earliest, latest]` reference date |
| `posts` | published post rows kept |
| `headcount` | `posts` minus eliminated posts |
| `seniorPosts` | rows whose grade band is neither `Below SCS` nor `Other / Not stated`. **This is wider than "SCS": it includes `Military (OF-6+)` and `Specialist (own scale)`, neither of which is a Senior Civil Service grade.** For an SCS figure, filter on the four `SCS*` bands — see rule 6 in section 7 |
| `disclosed` | rows in `headcount` with a published pay band |
| `withheld` | `headcount − disclosed` |
| `disclosureRate` | `disclosed / headcount`, 3 dp |
| `eliminated`, `vacant` | post-status counts |
| `coreCells`, `profCells` | cube sizes (both tiers) |
| `filesOk`, `filesFail` | download + parse outcomes. Expect a persistent ~6% failure rate; alert on a **change**, never on any failure |
| `undatedSkipped` | resources whose reference date could not be resolved. A jump here is the earliest signal of a gov.uk URL-scheme change |
| `rejectedSiblings` | older uploads of the same (package, reference date) |

---

## 3. The cubes

`cube-core.json`, `cube-core-b.json`, `cube-prof.json`, `cube-prof-b.json` all
share one shape:

```jsonc
{
  "schema": 1,
  "grain":  ["dateIdx","orgIdx","gradeIdx","binLow","binHigh"],
  "fields": ["n","withheld","vacant","eliminated","fteSum","fteKnown",
             "sumFloorRes","sumCeilRes","billLowRes","billHighRes"],
  "binWidth": 5000,
  "tier": "A",
  "rows": [ [ …grain…, …fields… ], … ]
}
```

All four files are always written, with `rows: []` when the run contained no
organisation of that tier. `tier` states which population the file holds.

`cube-prof*` has the wider grain
`["dateIdx","orgIdx","gradeIdx","profIdx","ddat","pol","binLow","binHigh"]`.
`ddat` and `pol` are 0/1 flags. Everything else is identical, and the two cubes
agree: aggregating `cube-prof` over profession, `ddat` and `pol` reproduces
`cube-core` exactly.

Rows are sorted ascending by the grain columns. Two runs from cache produce
byte-identical files.

### 3.1 Pay bands

`binLow` and `binHigh` are `floor(pay / 5000)`, taken from the published pay
floor and pay ceiling respectively. Two sentinel values replace a band index:

| Sentinel | Meaning | `n` | Money fields |
|---|---|---|---|
| `-1` | Pay **not disclosed**. The post exists and is counted; the department withheld the figure. | `0` (the row is in `withheld`) | all zero |
| `-2` | **Open band** — exactly ONE of the two edges was published. | counts in `n` | all zero |

The `-2` bucket exists because copying the published edge onto the missing one
states a floor the department never published. 110 rows in the corpus publish a
ceiling with no floor. They are real disclosures and are counted as such, but
**no money total may include them** — `sumFloor`, `sumCeil`, `billLow` and
`billHigh` are all zero in that bucket, and the exact published edge survives
verbatim in the post shard's `floor`/`ceil` columns. `meta.stats.openBand`
carries the corpus-wide count so a consumer can state it.

**Rule for consumers:** any statistic over pay bands must skip cells where
`binLow < 0`. Any statistic over headcount, FTE, grade mix or disclosure rate
must include them.

Published senior pay is a `(floor, ceiling)` band £5,000 wide — 41,917 of
44,489 pay rows span exactly £4,999, and even above £150,000 only 105 of 2,602
rows are exact. **There is no midpoint in this data and none is emitted.** A
band of £145,000–£149,999 and a band of £150,000–£154,999 sit either side of a
line the data cannot resolve, so "posts over £150k" is a **range**, not a count:
report `[certainly above, possibly above]`.

### 3.2 Measures

| Field | Definition |
|---|---|
| `n` | posts in this cell **with disclosed pay**, excluding eliminated posts |
| `withheld` | posts in this cell **without disclosed pay**, excluding eliminated posts |
| `vacant` | posts with status `vacant`. A subset of `n + withheld` — counted in headcount, never in the pay bill |
| `eliminated` | posts with status `eliminated`. In **neither** `n` nor `withheld`: the post no longer exists |
| `fteSum` | sum of FTE over `n + withheld` rows **whose FTE was parseable**, 2 dp |
| `fteKnown` | how many of those rows had a parseable FTE |
| `sumFloorRes` | residual — see decode below |
| `sumCeilRes` | residual |
| `billLowRes` | residual |
| `billHighRes` | residual |

Therefore:

```
headcount(cell)      = n + withheld            // eliminated posts excluded
disclosureRate(cell) = n / (n + withheld)
fteUnknown(cell)     = (n + withheld) − fteKnown
```

Headcount, FTE and grade mix are computed on the **full** population.
Pay statistics are computed on the **disclosed subset** (`n`). Never mix them,
and always show the disclosure rate beside any pay figure: it runs from about
20–25% at SCS1 to 93–96% at SCS2 and above, so an unweighted median over the
disclosed subset is a median of a different population. Offer a
grade-reweighted median — the disclosed distribution projected onto the
published grade mix — alongside the raw one.

### 3.3 Decoding the four money residuals

The bin edges already imply the band, and almost every post is exactly 1.0 FTE,
so the absolute sums are stored as differences from what the row already tells
you. In the overwhelming majority of cells all four are `0`. Reconstruct:

```js
const BIN = cube.binWidth;                  // 5000
const impliedFloor = binLow  < 0 ? 0 : n * binLow  * BIN;
const impliedCeil  = binHigh < 0 ? 0 : n * (binHigh * BIN + BIN - 1);

const sumFloor = sumFloorRes + impliedFloor;   // sum of published pay floors, £
const sumCeil  = sumCeilRes  + impliedCeil;    // sum of published pay ceilings, £
const billLow  = billLowRes  + sumFloor;       // FTE-weighted, vacant posts excluded
const billHigh = billHighRes + sumCeil;        // FTE-weighted, vacant posts excluded
```

`sumFloor` / `sumCeil` are headcount-weighted; `billLow` / `billHigh` are
FTE-weighted with vacant posts removed, which is the honest range for a pay
bill. There is deliberately no single `bill` number: producing one requires a
midpoint.

### 3.4 Worked example — one cube cell

Row from `cube-core.json` (Tier A):

```json
[0, 1, 0, 36, 36, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0]
```

Read against `grain` then `fields`:

| Position | Field | Value | Meaning |
|---|---|---|---|
| 0 | `dateIdx` | 0 | `meta.dates[0]` = `2011-03-31` |
| 1 | `orgIdx` | 1 | `meta.orgs[1].id` = `DWP` |
| 2 | `gradeIdx` | 0 | `meta.grades[0]` = `SCS4 / Perm Sec` |
| 3 | `binLow` | 36 | floor bin → £180,000 |
| 4 | `binHigh` | 36 | ceiling bin → £180,000–£184,999 |
| 5 | `n` | 1 | one post, pay disclosed |
| 6 | `withheld` | 0 | |
| 7 | `vacant` | 0 | |
| 8 | `eliminated` | 0 | |
| 9 | `fteSum` | 1 | |
| 10 | `fteKnown` | 1 | FTE known for that one post |
| 11–14 | residuals | 0,0,0,0 | band-aligned, 1.0 FTE |

Decoded: on 31 March 2011 DWP published one SCS4 / Permanent Secretary post,
pay disclosed, in the £180,000–£184,999 band, 1.0 FTE.
`sumFloor = 0 + 1×36×5000 = 180,000`;
`sumCeil = 0 + 1×(36×5000 + 4,999) = 184,999`;
`billLow = 0 + 180,000`; `billHigh = 0 + 184,999`.

A withheld cell from the same date and organisation:

```json
[0, 1, 2, -1, -1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0]
```

`gradeIdx` 2 = `SCS2 (Dir)`, `binLow`/`binHigh` = −1, `n` = 0, `withheld` = 1:
one SCS2 post published with its pay withheld. It is in the headcount and in
the grade mix; it is not in any pay statistic. Dropping rows like this one is
what inverted the shipped grade mix (SCS1 read 36.9% against a published
population of 61.4%) and lifted every median by roughly £15,000–£20,000.

---

## 4. Post shards — `public/data/posts/<orgId>.json`

One file per organisation, columnar and dictionary-encoded. Lazy-load only the
organisations the user has selected.

```jsonc
{
  "schema": 1,
  "org": "WO",
  "n": 20,                      // rows; every column array has exactly this length
  "cols": ["date","pkg","suborg","unit","title","rawGrade","band","variant",
           "rawProf","prof","ddat","pol","status","disclosed","withheld",
           "floor","ceil","fte","costOfReports","region","pur","ordinal","reportsTo"],
  "dict": {
    "pkg": ["organogram-wales-office"],
    "suborg": ["Wales Office"],
    "unit": ["Private Office", …],
    "title": ["Director", …],
    "rawGrade": ["SCS2", …],
    "variant": ["London", …],
    "rawProf": ["Policy Profession", …],
    "region": ["London", …],
    "pur": ["POSN000001", …]
  },
  "data": { "date": [0,0,…], "pkg": [0,0,…], … }
}
```

### 4.1 Columns

| Column | Type | Decode |
|---|---|---|
| `date` | int | index into `meta.dates` |
| `pkg` | int | index into `dict.pkg` — the CKAN package, i.e. the sub-organisation |
| `suborg` | int | index into `dict.suborg` — the `Organisation` column **inside** the CSV. This is where agency-level depth lives: MoJ 2026-03-31 decomposes into MoJ HQ, HMCTS, HMPPS, the Legal Aid Agency, OPG and CICA |
| `unit` | int | index into `dict.unit` |
| `title` | int | index into `dict.title` — the published job title, trimmed to 160 chars |
| `rawGrade` | int | index into `dict.rawGrade` — the grade string **exactly as published** |
| `band` | int | index into `meta.grades` — the normalised band |
| `variant` | int | index into `dict.variant`, or −1. Preserves `SCS Band 1 London` vs `National`, `OF-6`…`OF-9`, `SCS1A`, `Senior Commercial Specialist`, `Parliamentary Counsel`, `Medical Consultant`, `SLG (DE&S)`, the AFC and ESM scales |
| `rawProf` | int | index into `dict.rawProf` — the professional group **exactly as published** |
| `prof` | int | index into `meta.profs` — the normalised class |
| `ddat` | 0/1 | Digital, Data & Technology |
| `pol` | 0/1 | Policy |
| `status` | int | index into `meta.statuses` |
| `disclosed` | 0/1 | was a pay band published |
| `withheld` | int | index into `meta.withheldReasons`, or −1 when pay was disclosed |
| `floor` | int\|null | published pay floor, £ |
| `ceil` | int\|null | published pay ceiling, £ |
| `fte` | number\|null | **null means unknown, never 1.0** |
| `costOfReports` | int\|null | published salary cost of reports, £ |
| `region` | int | index into `dict.region`, or −1 |
| `pur` | int | index into `dict.pur` — the Post Unique Reference, or −1. `XX`, `N/A` and blank are treated as absent, never as an identifier |
| `ordinal` | int | 0-based disambiguator for a PUR repeated inside one file (2,284 rows across 252 files do this) |
| `reportsTo` | int | index into `dict.pur` — the PUR of the parent post, or −1. This is the org-chart edge; 492 of 493 files carry it |

The post identity is `(org, date, pur, ordinal)`. Use it to build pay
trajectories: 8,801 distinct `(org, PUR)` identities exist, 6,071 appear in more
than one snapshot and 1,441 in ten or more.

Dictionary index `−1` always means *absent*. It is never a valid dictionary
position.

### 4.2 What is deliberately absent

* **Names.** The `Name` column is read to derive `status` and is then discarded.
  It is never stored or emitted. gov.uk publishes names lawfully under OGL; the
  disclosure analysis needs the status, not the person, and a pay study should
  not read as a personal dossier.
* **Job/Team Function and Notes prose.** Roughly halves the shard and carries no
  analysis.
* **Contact phone and e-mail.** Published upstream, of no use here.

### 4.3 Worked example — one shard row

`posts/WO.json`, row 0, decoded with `meta.json`:

```js
const meta  = await (await fetch('data/meta.json')).json();
const shard = await (await fetch('data/posts/WO.json')).json();
const at = (i) => Object.fromEntries(shard.cols.map(c => [c, shard.data[c][i]]));
const D  = (name, v) => (v < 0 ? null : shard.dict[name][v]);

const r = at(0);
// { date:0, pkg:0, suborg:0, unit:0, title:0, rawGrade:0, band:2, variant:-1,
//   rawProf:0, prof:16, ddat:0, pol:1, status:0, disclosed:1, withheld:-1,
//   floor:80000, ceil:84999, fte:1, costOfReports:950000, region:-1,
//   pur:0, ordinal:0, reportsTo:-1 }

meta.dates[r.date]        // "2011-03-31"
D('title', r.title)       // the published job title
meta.grades[r.band]       // "SCS2 (Dir)"
D('rawGrade', r.rawGrade) // "SCS2"  — exactly as published
D('variant', r.variant)   // null
meta.profs[r.prof]        // "Policy"
meta.statuses[r.status]   // "filled-named"
r.disclosed === 1         // pay band published: £80,000–£84,999
D('region', r.region)     // null — this file has no Office Region column
D('pur', r.reportsTo)     // null — this is the root of the tree
```

Rendered honestly that row reads: *31 March 2011, Wales Office, one SCS2
(published as "SCS2") policy post, 1.0 FTE, paid somewhere in
£80,000–£84,999 — not £82,500.*

---

## 5. `changelog.json`

Array, newest first, capped at 60. **One entry per run that actually changed
something**: a no-op run appends nothing, so the file stays a record of real
change rather than a record of cron.

```jsonc
{
  "run": "2026-09-03T06:00:12Z",       // wall clock — the only non-deterministic value shipped
  "gitSha": "b16c0794bf6a",
  "scope": { … },                      // same shape as meta.scope
  "snapshotsBefore": 537, "snapshotsAfter": 549,
  "postsBefore": 139291, "postsAfter": 144902,
  "orgsBefore": 25, "orgsAfter": 25,
  "datesAdded": ["2026-06-30","2026-07-31"],
  "filesOk": 545, "filesFail": 8, "undatedSkipped": 17,
  "cpihSource": "ONS MM23/L522 (live)",
  "cacheMode": "revalidate-18m",
  "cubeCells": 13402,
  "warnings": []
}
```

Zero new data is **not** the normal month: a live probe six weeks after the last
ingest found ten absent snapshot dates plus four MOD back-fills. Back-fills
mutate history, so a consumer should treat a changed date as newsworthy as an
added one.

---

## 6. `data/manifest.json` — ingest state, never shipped

Tracked in git because `git show HEAD:data/manifest.json` **is** the diff
baseline. Not in `public/`: it is state, not payload.

```jsonc
{
  "schema": 1,
  "digest": "<sha256 of every emitted payload>",   // drives "did anything change"
  "scope":  { … },
  "stats":  { … },                                  // identical to meta.stats
  "dates":  ["2010-06-30", …],
  "resources": {
    "DWP": [
      { "pkg": "organogram-department-for-work-and-pensions",
        "url": "https://…-2026-08-03-organogram-senior.csv",
        "created": "2026-08-05T09:12:44.101",
        "lastModified": "2026-08-05T09:12:44.101",
        "referenceDate": "2026-08-03",
        "confidence": "declared", "basis": "url",
        "sha256": "…", "bytes": 412233, "rows": 341, "posts": 340,
        "disclosed": 291, "blankRows": 1, "validApplied": true, "juniorRows": 0 }
    ]
  },
  "failures":         [ { "org","date","url","reason" } ],
  "undated":          [ { "org","pkg","url" } ],
  "rejectedSiblings": [ { "org","pkg","date","url","reason" } ],
  "emptySlugs":       [ { "org","slug","known","note" } ],
  "outOfWindow":      [ { "org","date","url" } ]
}
```

Incremental change detection keys on the **resource URL set plus the resolved
reference date**, diffed against this file. It must never key on a CKAN package's
`metadata_modified`: 95 of 370 packages were touched in a single bulk reindex
month against a normal rate of 1–4.

`failures[].reason` is one of `download-failed`, `binary:pdf`, `binary:xls`,
`binary:zip/xlsx`, `junior-schema`, `junior-content`, `junior-content-fte`,
`no-pay-columns`, `no-post-columns`, `empty`, `all-rows-blank`,
`no-rows-survived`.

---

## 7. Rules the pipeline enforces, so a consumer can rely on them

1. **Every published post row is kept.** Disclosure is a field, not a filter.
2. **No midpoints anywhere, and no fabricated edges.** Pay is `(floor, ceiling)`,
   an open band (`-2`), or withheld (`-1`). The pipeline never supplies a number
   the department did not publish.
2a. **A sibling package never double-counts.** Within one `(organisation, date)`
   the sibling packages are summed, then deduplicated on the publisher's own
   Post Unique Reference, largest file winning. MOD files both a department-wide
   return and a Head Office return for the same date and 166 of 168 HO&CS posts
   for 2012-03-31 appear in both; 1,289 duplicate rows are dropped corpus-wide.
   Placeholder references (`XX`, `N/A`, `0`, `Deleted`, blank) are never treated
   as identifiers.
2b. **A CKAN organisation is not always one body.** MOD's slug also carries the
   National Army Museum, the RAF Museum and the National Museum of the Royal
   Navy. They are excluded from MOD via `excludePackages` and registered as
   Tier B organisations (`NAM`, `RAFM`, `NMRN`), so the data is kept and simply
   stops being counted as a ministerial department.
3. **FTE is `null` when unknown**, never an invented 1.0. `fteKnown` states the
   imputed share.
4. **Names never leave the parser.**
5. **A CSV that is really a PDF, an XLS or an XLSX is rejected by magic bytes**,
   not by content-type and not by extension.
6. **Junior organogram files are rejected by schema**, not by filename. A senior
   file containing junior rows keeps them, banded `Below SCS` — DHSC publishes
   ~3,500 such rows alongside ~330 real SCS posts, and rejecting the file would
   lose the Permanent Secretary and the Chief Medical Officer. **Exclude
   `Below SCS` from any SCS figure — and `Military (OF-6+)`, `Specialist (own
   scale)` and `Other / Not stated` with it.** Only the four `SCS*` bands are
   Senior Civil Service. On the departmental Tier A corpus the military band is
   not a rounding error: MoD alone contributes several thousand OF-6+ officers,
   so an "SCS" chart that filters on `seniorPosts` rather than on the `SCS*`
   bands is wrong by a visible margin.
7. **A `Valid?` column is honoured only when the column is literally headed
   `Valid?` and the majority of pay-bearing rows are the ones flagged valid.**
   FCO 2019-03-31 has it inverted — 132 real posts flagged 0, 1,866 blank
   padding rows flagged 1 — and used to yield a single post.
8. **Fully blank padding rows are dropped before every other filter.**
9. **Sibling packages are summed, not raced.** Within a package the latest
   CKAN `created` wins, and if that file will not parse the next-newest is
   tried rather than the date being lost.
10. **`success:true, count:0` from CKAN is fatal**, with one documented
    exception (`department-for-business-and-trade`, the empty post-MoG shell).
    It is the signature of a rename, and it has already silently deleted a
    department once.
11. **Output is promoted atomically** after floor assertions
    (≥500 snapshots, ≥40,000 disclosed posts, ≥24 organisations, ≥160 dates on a
    full-scope run). A failed floor leaves the previous build untouched and
    exits 2.
12. **Two runs from cache are byte-identical.**

---

## 8. What this data cannot answer

State this on the Method beat; the pipeline cannot enforce honesty in the copy.

* **The pay of the ~66% of posts whose department withheld it.** Not
  recoverable. The post, its grade, title, unit and FTE are counted and the
  withholding rate is reported per grade. This is the study's most important
  finding, not a caveat.
* **Any exact salary.** The bands are £5,000 wide throughout, including above
  £150,000. Never print an SCS median to the pound: round to £1,000, three
  significant figures at most, and say why.
* **Total remuneration.** Organograms are base pay only — no bonus, allowance,
  London weighting or employer pension. The civil service `alpha` employer
  contribution is worth roughly 23.6–28% of salary against a typical private DC
  scheme's 3–8%.
* **Anyone below the SCS**, junior organogram files (a different unit of
  analysis), local government, NHS trusts and the devolved administrations.
* **Names.** Published lawfully upstream, deliberately not republished here.

---

## 9. `public/data/highearners.json` — the exact-figure layer

Written by `scripts/highearners.mjs`, not by `ingest.mjs`. Lazy-load it; it is
not needed for first paint. Budget 250 KB gz (measured 53 KB at full scope).

It carries the two Cabinet Office high-earner publications, which are the only
place central government publishes a named, exact-figure accounting of its
highest earners. Everything below exists because those two publications are
**not one series**.

| Fact | Consequence for the UI |
|---|---|
| The disclosure threshold moved £150,000 → £174,000 between the 2022 and 2025 editions | Two eras, kept structurally separate. Any fall in the headline count across that boundary is the threshold moving, not pay falling |
| No list exists for 30 September 2023 or 30 September 2024 | `gaps[]`. **Never interpolate it.** The script exits 2 if any series point lands on a gap date |
| The 2010–2014 editions have no `Type of organisation` column | No civil-service figure exists for those years, and none is estimated. The civil-service series simply starts in 2015 and lists the editions it had to omit |
| In the 2025 list only 157 of 565 published rows are Civil Service | An unfiltered count of this list is **not** a civil-service figure |
| £174,000 falls inside the published £170,000–£174,999 band | Every threshold count is a range `[certain, possible]`, never a number |
| Names are published upstream under OGL | They are **not** republished. `Job/Team Function` and `Notes` are never read either: both are prose written about a named individual |

### 9.1 Shape

```jsonc
{
  "schema": 1,
  "generated": "2026-04-14T10:17:15+01:00",  // newest upstream public_updated_at,
                                             // NOT the wall clock — deterministic
  "scope": { "only": null, "maxFiles": null, "partial": false },
  "sources": [ { "id":"list-150k", "era":"150k", "thresholdGBP":150000,
                 "publicUpdatedAt": …, "frozen": true, … }, … ],
  "thresholdChange": { "from":150000, "to":174000, … },
  "orgTypes":  ["Civil Service","Other central government",
                "Commercial enterprise in the public sector"],
  "grades":    [ … ],        // ordinal, senior first; index space for rows.band
  "payKinds":  ["band","exact","floor-only","not-published"],
  "dict":      { "org":[…], "parent":[…], "title":[…], "rawGrade":[…] },
  "editions":  [ … ],
  "series":    [ … ],
  "gaps":      [ … ],
  "breaks":    [ … ],
  "attachments": [ … ],       // change-detection state: url + sha256 per file
  "rows":      { "n":5813, "cols":[…], "data":{…} },
  "stats":     { … },
  "warnings":  [ … ]
}
```

`grades` is the organogram ladder from `scripts/lib.mjs` plus two bands this
publication has and the organograms do not: `NHS very senior manager` and
`Non-executive / chair`. Without the second, 280 board fees would be filed as
SCS2 directors, because "Non-Executive Director" matches a `/director/` rule.
Senior military officers appear here by rank name rather than as `OF-n` codes
and are mapped into `Military (OF-6+)` with the rank kept as the variant.

### 9.2 `editions[]`

One per (publication, reference date). This is the unit of publication.

| Field | Meaning |
|---|---|
| `id` | `<era>-<refDate or year>`, e.g. `150k-2019-09-30`, `174k-2025-09-30` |
| `era` | `150k` or `174k` — **the two are different populations** |
| `parser` | `A` 2010 · `B` 2011–2022 · `C` 2025– . Three published schemas |
| `year` | always present |
| `refDate` | `YYYY-MM-DD`, or **null** for 2010–2012 |
| `refConfidence` | `declared` (the publisher wrote the date in the attachment title) or `year-only`. Nothing is inferred: plot a `year-only` edition by year and draw it as such |
| `thresholdGBP` | the threshold this edition was published at |
| `orgTypeAvailable` | false before the 2015 edition |
| `rows`, `civilService`, `payPublished`, `payNotPublished`, `byOrgType` | counts |

The reference date moves from 31 March (2013, 2014) to 30 September (2015
onwards), so those consecutive editions are 18 months apart, not 12. It is in
`breaks[]`.

### 9.3 `series[]`

Six series: `{published-150k, published-174k, recomputed-174k}` × `{civil-service,
all-published}`. Every one states its `scope`, `basis`, `thresholdGBP` and
`note` on the object, so a number cannot be lifted off it without knowing which
population it counts.

* `published-150k-*` and `published-174k-*` — **as published**. Draw them as two
  series with a break, never one line.
* `recomputed-174k-*` — **derived**. The 2010–2022 files recounted at the
  £174,000 cutoff, which the per-row floor and ceiling make possible. This is
  the only like-for-like line against 2025. Label it as derived and never merge
  it into a published series.

Each point:

```jsonc
{ "editionId":"150k-2022-09-30", "editionIdx":12, "year":2022,
  "refDate":"2022-09-30",
  "listed":251,        // entries on the list under this scope
  "certain":88,        // pay floor   >= threshold
  "possible":106,      // pay ceiling >= threshold
  "payNotPublished":0 }
```

`listed` is **not** a count above the threshold: both publications carry
part-time and fee-paid roles whose actual pay is below it (a chair at
£85,000–£89,999 sits in the 2025 £174,000 list). Render `certain`–`possible` as
a range, and say that the range exists because the bands straddle the cutoff.

### 9.4 `rows` — columnar, dictionary-encoded

| Column | Decode |
|---|---|
| `edition` | index into `editions[]` |
| `org` | index into `dict.org` — the `Organisation` column as published |
| `parent` | index into `dict.parent`, or −1 (the 2010 edition has no parent department) |
| `orgType` | index into `orgTypes`, or **−1 = not published in that edition** |
| `title` | index into `dict.title` — the published job title, trimmed to 160 chars |
| `rawGrade` | index into `dict.rawGrade` — the grade string exactly as published |
| `band` | index into `grades` |
| `payKind` | index into `payKinds` |
| `floor` | int \| null, £ |
| `ceil` | int \| null, £. **Null with a non-null floor means open-ended**, not floor + 4,999 |

`payKind` is `band` when floor < ceiling (5,799 of 5,813 rows), `exact` when the
publisher named one figure (7), `floor-only` when a floor was published with no
ceiling (4), and `not-published` when neither was (3). −1 always means absent.

### 9.5 What is deliberately absent

* **Names.** The name columns are read for exactly one purpose — to build the
  set of forbidden strings the emitted payload is then checked against — and are
  never stored. The check is a hard assertion by name adjacency over the
  serialised payload; it exits 2 and writes nothing. `SCS_HE_LEAK_TEST=1` walks
  a real published name into the payload so the guard can be watched failing.
* **`Job/Team Function` and `Notes`.** Prose written about a named individual
  ("Vanessa Lawrence was the Director General and Chief Executive of Ordnance
  Survey"). Carrying them would walk names in through the back door.
* **Contact e-mail.** 279 addresses appear in the source files; none reaches the
  payload, and the assertion fails on any `@`-shaped token.

---

## 10. `public/data/benchmarks.json` — external comparators

Written by `scripts/benchmarks.mjs`, which owns this file and nothing else. It
answers the question the organograms cannot: is that a lot? Lazy-loaded, never
first paint. Roughly 70 KB raw, 16 KB gzipped.

`data/benchmarks-review.json` is its companion state file — tracked in git, never
shipped — and holds the approved reading of every figure extracted from a PDF.

### 10.1 Shape

```jsonc
{
  "schema": 1,
  "generated": "2026-07-29",     // newest upstream publication date in the file.
                                 // Deterministic: two runs from cache are identical
  "contentDigest": "…",          // sha256 over the payload with lastReviewed and
                                 // generated removed, so a cron job can tell a real
                                 // change from the calendar moving
  "purpose": "…",
  "honestyRules": ["…"],         // the fifteen rules, shipped so the page can render them
  "socBreaks":  [ {from,to,classification,note} ],
  "crosswalk":  [ {scsRole,soc2020,marketTitle,confidence,note} ],
  "sources":    { "<sourceId>": {…} },
  "ashe":       { editions, derived, occupations, sector, region },
  "acses":      { edition, asOf, tables:{…} },
  "ssrb":       { medianByPayband, marketComparison, caveats },
  "ssrbReport": { bandMedians },
  "scsPayBands":{ editions, parsed },
  "curated":    [ {…} ],
  "excluded":   [ {source,verdict,reason} ],
  "contested":  [ {…} ],
  "warnings":   ["…"]
}
```

### 10.2 Provenance is by reference, not repetition

Every block that carries a figure holds a `src` string that keys into
`sources`. A source carries `name`, `publisher`, `url`, `table`, `sheet`,
`edition`, `provisional`, `sourceDate` (when the publisher released it),
`windowEnd` (the last period it describes), `lastReviewed` (when this pipeline
last checked), `licence`, `extraction`, `note` and `correctionNotice`.

**Render the source's date on the mark, never a page-level stamp.** A monthly
job re-running everything must not imply an annual figure is a month old.

### 10.3 The one rule a consumer must not get wrong

`ashe.occupations[].annualGross` is ASHE Table 14.7a: **annual gross pay,
including incentive pay**. SCS organogram pay is base only. Comparing the two is
the mistake this whole file exists to prevent.

Use `basicAnnualised` instead. It is `weeklyBasic` (Table 14.3a) multiplied by
52, because ASHE publishes basic pay weekly and never annually. It is derived,
it is marked `derived: "weeklyBasicX52"`, its confidence is `hypothesis`, and
`ashe.derived` states the caveat in full — the annual and weekly ASHE tables
cover different samples, so the two series will not reconcile exactly.

### 10.4 Suppression

A suppressed figure is `null` with the reason recorded in the block's
`suppressed` map: `cv-above-20-per-cent` (ASHE `x`), `not-applicable` (`:` and
ACSES `[n]`), `disclosive` (`..`), `nil-or-negligible` (`-`),
`confidential-small-numbers` (ACSES `[c]`). It is never `0`, and the build fails
if any pay field is exactly `0`.

`nKnown: false` means the publisher gave no sample size for that cell, so the
n = 30 floor could not be applied. Neither absence means "no such jobs".

`p90` is suppressed for fourteen of the eighteen crosswalk occupations —
including every 11xx director code — so an instrument that needs the top decile
of the market has to say it cannot have it.

### 10.5 The review gate

Everything read out of a PDF passes through it. Each gated block carries
`state`, `live`, `pending`, `blockSha` and `approvedOn`:

| `state` | Meaning |
|---|---|
| `verified` | The checksum matches the approved one. `live` is this run's reading. |
| `changed` | The published table moved. `live` is still the last approved reading; the new one sits in `pending` and a warning is raised. **Render `live`, and surface that a review is outstanding.** |
| `unreviewed` | Nothing approved yet. `live` is a curated fallback or `null`; `pending` holds the extraction. Do not render `pending` as fact. |
| `skipped-no-pdftotext` | `pdftotext` was absent on the build machine. `live` is the curated fallback. |
| `parse-empty` | The extractor found nothing. Approving a null was refused. |

A layout change must never silently rewrite a number, so `live` only moves when
a person runs `npm run benchmarks -- --approve`.

### 10.6 Tables are found by title, never by sheet number

ACSES renumbers between editions. In the 2026 edition the profession quartiles
the brief calls "Table 36" are `table_35`, and the salary bands it calls
"Table 26" are `table_6`. Each ACSES block therefore ships the `sheet` it
actually read and the `title` it matched. Check them before trusting a diff.

### 10.7 Columnar blocks

`ashe.region` is `{regions, cols, rows}` — `rows[i][1]` indexes `regions`.
`acses.tables.scsMedianByOrg` is `{parents, cols, rows}` — `rows[i][0]` indexes
`parents`. Both are arrays of arrays to keep the file inside its budget.

### 10.8 `excluded`

Ten sources that were deliberately not contacted, each with the reason. This is
data for the Method beat, not commentary: Glassdoor's `robots.txt` names
ClaudeBot, Adzuna's terms forbid publishing aggregates, Nomis has no occupation
dimension. No request is made to any of them. ITJobsWatch, if it is ever
included, lives in `benchmarks-itjw.json` under its own CC BY-NC-SA notice and
is never merged into this file.

---

## 11. `public/data/ukgwa.json` — the web-archive recovery report

Written by `scripts/ukgwa.mjs`, not by `ingest.mjs`. Lazy-loaded; it is Method
material, not a measure. Roughly 10 KB at the 2010-2012 scope.

The pipeline fails on about 6% of its fetches and most of those failures are
permanent: the origin host is gone. `www.hm-treasury.gov.uk` redirects the whole
2010-2012 transparency release to a GOV.UK landing page, `www.dmo.gov.uk`
answers with a CAPTCHA, and the CKAN records pointing at the UK Government Web
Archive do so through its `/+/` replay prefix, which returns a browser frame
rather than the file. All three arrive as HTML and parse as a CSV with no pay
columns, so they were recorded as data errors rather than as dead links.

`scripts/ukgwa.mjs` re-fetches them from the archive and writes the result into
the **ingest cache** under the key `ingest.mjs` already hashes, so nothing in
the pipeline changes. Run it **before** the ingest:

```
node scripts/ukgwa.mjs      # then: npm run ingest
```

### 11.1 What a consumer must know

1. **A recovered file is indistinguishable from a live one downstream.**
   `meta.json`, the cubes and the shards say nothing about provenance. This file
   is the only place that records which snapshots exist because of the archive.
   If the Method beat claims coverage back to 2010, it should say how.
2. **`manifest.resources[].sha256` is the sha256 of the bytes that were
   parsed.** For a joined file that is the sha256 of the join, not of any single
   published file. The archive capture timestamp and the sha256 of each
   published half are in `data/ukgwa.json`.
3. **`recovered[].downstream` is not a promise.** `in-corpus` means the last
   ingest kept the file, `dropped-by-ingest` means it was recovered and then
   discarded as a within-package sibling, `not-yet-ingested` means no ingest has
   seen it. Only `in-corpus` files are in the cubes.
4. **`org: "ADHOC"`** means the URL was recovered outside the manifest, so no
   ingest has yet filed it under an organisation. Its `date` is resolved from
   the URL alone and is provisional.

### 11.2 Shape

```jsonc
{
  "schema": 1,
  "generated": "2011-08-05T18:45:21.000Z",  // newest archive capture the recovery
                                            // rests on, NOT the wall clock
  "purpose": "…",
  "source":  { name, operator, index, replay, note, licence },
  "summary": {
    "attempted": 14, "recovered": 10, "verbatim": 7, "joined": 3,
    "paySideConsumed": 2, "notNeeded": 0, "unrecovered": 2,
    "postRowsRecovered": 618, "disclosedRecovered": 142,
    "earliestRecoveredDate": "2010-06-30", "latestRecoveredDate": "2012-03-31",
    "inCorpus": 2, "droppedByIngest": 3, "notYetIngested": 5
  },
  "twoFileFormat":  { "note": …, "pairs": [ … ] },
  "droppedByIngest":{ "note": …, "files": [ … ] },
  "recovered":      [ { org, date, file, url, kind, captured, rows, posts,
                        disclosed, via, downstream } ],
  "unrecovered":    [ { org, date, file, url, reason, why, detail } ],
  "reasons":        { "<reason>": "one sentence, renderable as-is" },
  "caveat":         "…",
  "warnings":       [ … ]
}
```

`kind` is `verbatim` (the archived bytes as published) or `joined` (a two-file
export rejoined — see 11.3). `via` is the redirect chain when one was followed:
the OBR's March 2011 return sits two 302s behind a WordPress download handler.

### 11.3 The two-file format, and why the join is conservative

The earliest release — **30 June 2010**, not 30 September — was published as
two files: a posts export carrying the structure and **no pay columns at all**,
and a separate pay export covering only the posts whose holder was named.
`parsePosts` refuses the posts half outright as `no-pay-columns`. Three such
pairs exist in the corpus (HM Treasury and the Audit Commission at 30 June 2010,
Defra in October 2010).

Each `twoFileFormat.pairs[]` entry states exactly how much of the pay actually
attached:

| Field | Meaning |
|---|---|
| `joinKey` | `post-reference`, `name` or `title-unit` — **resolved, not assumed**. Defra's pay half heads its reference column "Unique Post ID" and leaves every cell blank, so a hard-coded post-reference join returns a clean, wrong zero |
| `payRows` | rows in the pay file |
| `payRowsKeyed` | rows carrying a usable key. The Audit Commission names 14 of its 27 pay rows; the other 13 read "Not disclosed" |
| `matchedPosts` | posts that received pay |
| `payRowsUnmatched` | keyed pay rows with no matching post — a real asymmetry, not an error. HM Treasury's pay file includes a director on maternity leave who has no post row |
| `ambiguousPostKeys` / `ambiguousPayKeys` | keys appearing more than once on that side. **These rows are left unjoined, never guessed** |

The rules the join enforces, so a consumer can rely on them:

* **A key must be unique on both sides.** Nineteen Defra posts share a job title
  and unit with another post; joined on first-match they would each have been
  handed a colleague's salary. They stay in the withheld population instead.
* **Non-answers are absences, not keys.** `N/D`, `Not disclosed`, `Vacant`,
  `N/A` and `XX` never key a join. Eight Audit Commission posts and eight of its
  pay rows are all named "Not disclosed"; keyed naively that attaches eight
  salaries to eight arbitrary posts.
* **At least half the keyed pay rows must match**, or the pair is reported
  unjoined rather than half-joined.
* **Published headers are never rewritten.** The join appends
  `Actual Pay Floor (£)`, `Actual Pay Ceiling (£)` and `FTE` to the posts file
  and changes nothing else.
* **A pay half is never emitted in its own right.** It parses perfectly well
  alone — it has pay and a job title — so emitting it would count every
  disclosed row twice. It is recorded as `paySideConsumed`.

Consequence for the copy: the 30 June 2010 snapshots are *less* complete than
the raw row counts suggest, and the report says by how much. Do not present a
joined snapshot's disclosure rate as comparable with a single-file one without
saying that some pay could not be attributed to a post.

### 11.4 `data/ukgwa.json` — state, never shipped

Tracked in git for the same reason as `data/manifest.json`: it is the
idempotency baseline. Keyed by URL, one record per URL ever attempted, carrying
`kind`, `cdxTimestamp`, `archiveSha256`, `emittedSha256`, `cacheKey`, the full
join diagnostics and the failure reason.

Delivery is also self-describing on disk: every emitted body gets a
`.cache/<sha1(url)>.ukgwa.json` sidecar. That sidecar, not the state file, is
what stops a later run replacing a live publication with a museum piece, and it
survives the state file being deleted.

Re-running is cheap and safe. CDX answers are cached for 30 days and archived
bodies forever, so a top-up run that finds nothing new costs no network at all.
It is also self-healing: `npm run ingest -- --no-cache` re-downloads the dead
origins and overwrites the recovered bytes with their HTML, and the next
`node scripts/ukgwa.mjs` puts them back without a single request.
