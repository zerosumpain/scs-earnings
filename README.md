# Senior Civil Servant Earnings

An interactive field study of **UK Senior Civil Service pay, 2010–2026** — who holds the
senior posts, at what grade, in which body, and how much of that pay is published at all.

Built from the gov.uk **organogram of staff roles & salaries** transparency releases:
**185,926 published senior post rows** across **78 organisations** and **1,483 filings**,
gathered straight from the data.gov.uk CKAN API and rebuilt monthly.

The study's central finding is not a pay level. It is that **most published senior posts
carry no published salary** — the post, its grade, its unit and its hours are filed, and
the pay column is left empty — and that the withholding is grade-dependent, so any median
taken over the disclosed rows alone is a median of a more senior population than the one
it claims to describe.

## The seven beats

The page is a field study, not a dashboard: seven beats in fixed order, each asking one
question and answering it with one claim carrying an explicit confidence of
`fact | hypothesis | contested`, a "so what", an open question and a falsifier.

| | Beat | What it does |
|---|---|---|
| — | **Abstract** | three findings, the status of the corpus, contents |
| 01 | **The problem** | is senior pay actually rising, in cash and after inflation |
| 02 | **The estate & evidence** | what has been published, by whom, and what is missing |
| 03 | **Ways to read it** | banded pay, real terms, and the disclosure rate |
| 04 | **The finding** | the one call the study makes, with the instrument beneath it |
| 05 | **What it does & who wins** | profession, grade, agency, and the top of the pile |
| 06 | **Trust & safeguards** | the classifier audit, control totals, benchmark caveats |
| 07 | **What happens next** | the monthly refresh and what would change the answer |

Beat 04 carries the flagship instrument: a lever HUD, a readout, and a permanently visible
limits strip stating `n` under the current filter, the band uncertainty, the disclosure
rate for the current selection, and the source.

## External comparison

Senior civil service pay is set beside published market and whole-economy benchmarks —
ONS ASHE (occupation, sector and region), Civil Service Statistics, the Senior Salaries
Review Body evidence, and the published SCS pay bands — mapped SCS role → SOC 2020 →
market title. Every comparison states that organogram pay is **base pay only**: no bonus,
no allowance, no London weighting and no employer pension, against a civil service `alpha`
employer contribution worth roughly 23.6–28% of salary.

An advertised-salary layer from IT Jobs Watch is included for digital roles under its own
CC BY-NC-SA licence, kept in a separate file so it never contaminates the OGL provenance of
the rest. Glassdoor, Indeed, Adzuna, Payscale and Levels.fyi are deliberately excluded — on
their terms of use, or on relevance — and the exclusions are stated on the page rather than
left as a silent gap.

## Data pipeline

```bash
npm run ukgwa       # recover the 2010-2012 files whose origin host is gone, from
                    # the UK Government Web Archive, into .cache/ — run BEFORE ingest.
                    # Cheap and idempotent; see docs/DATA-CONTRACT.md section 11.
npm run ingest      # gather all senior organogram CSVs -> public/data/*.json
npm test            # unit assertions for the parser/classifier

node scripts/highearners.mjs --check   # cheap; only do a full run when it says CHANGED
npm run benchmarks  # ASHE / ACSES / SSRB / SCS pay bands -> benchmarks.json
node scripts/itjobswatch.mjs           # advertised-salary layer, CC BY-NC-SA, quarantined

npm run datadiff -- --require-full     # regression guard. rc>=2 blocks; rc=1 is advisory
npm run check:budgets                  # payload size gate
npm run check:fonts                    # 12px floor / 16px typed-field floor
npm run validate:palette               # chart colour gate

npm run dev         # local dev server
npm run build       # typecheck + production bundle
npm run smoke       # headless smoke test: every beat at desktop and mobile
```

After a full-scope ingest, promote the diff baseline and commit it with the data:
`npm run datadiff -- --promote` writes `data/baseline.json`.

`scripts/ingest.mjs` queries the data.gov.uk CKAN API for each department's organogram
dataset, downloads every senior CSV (cached in `.cache/`), normalises each post, and
aggregates into a compact **additive histogram cube** at grain
`(reference date × organisation × grade × profession × ddat-flag × policy-flag × pay band)`
— which supports any client-side filter plus approximate medians and percentiles. Every
published post row is also emitted per organisation in `public/data/posts/<orgId>.json`.
The full field-by-field interface is `docs/DATA-CONTRACT.md`.

## Data source & honesty

Pay is disclosed as a **`(floor, ceiling)` band** £5,000 wide throughout — including
above £150,000, where only 131 of 4,621 rows are an exact figure. **No midpoint is
computed anywhere**: the cube carries the two band edges, and a figure derived from it is
a range. Around two thirds of published senior posts have their pay withheld, and
withholding is grade-dependent, so every published row is kept and the disclosure rate
travels with any pay figure. Snapshots are keyed on the publisher's own reference date,
never bucketed into half-years. Tier A is the ministerial-department spine; Tier B is the
wider senior public sector and is never summed into an "SCS" figure. See beats 02, 03 and 06 for the full caveats.

## Licence and status

Code: MIT. The underlying transparency data is Crown copyright, published under the
**Open Government Licence v3.0**; the IT Jobs Watch layer is CC BY-NC-SA 4.0 and is kept
in its own file for that reason.

**This is not a government publication**, and it is not affiliated with any department.

**Post-holder names are included.** Departments publish them under the Open Government
Licence in the same transparency release as the pay band, and about a quarter of senior
posts (44,272 of 185,926 rows) are filed with one. They are carried here so an individual
post-holder can be searched for and a post's succession read. A name is only ever recorded
where the department published one — every placeholder (`N/D`, `Vacant`, `Redacted`, `N/A`)
resolves to a status, never to a person — and a blank name in the ledger means the
department declined to publish it, not that the post is empty.

The high-earner figures in beat 05 remain aggregate counts and bands by organisation and
grade rather than a roll-call, and `scripts/highearners.mjs` still asserts and fails the
run if a name reaches that file.
