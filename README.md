# Senior Civil Servant Earnings

An interactive explorer of **UK Senior Civil Service pay over time** — by department,
profession, grade, and the digital-vs-policy split. Built on gov.uk **organogram of
staff roles & salaries** transparency data (senior posts), 2010 → 2026.

Live: `https://strangeramblings.com/projects/scs-earnings/`

## What it does

- **Explore** — plot any measure (median / mean / quartiles / headcount / pay bill / FTE)
  over time, broken down by department, profession, grade, or DDaT-vs-policy, with a full
  cross-filtering rail, real-terms (CPIH) toggle, table view, and shareable-URL permalinks.
- **Professions** — profession mix over time (100% stacked area), DDaT-vs-policy pay,
  occupational pay-premium heatmap, profession growth leaderboard, rise of digital.
- **Pay structure** — grade-mix drift, the pay ladder by grade, grade compression,
  pay-bill decomposition (price vs volume), pay-distribution fan.
- **Top earners** — "more than the PM" tracker, £150k+ watch, searchable/sortable
  post-level explorer, fastest-rising departments.
- **Compare** — shared-scale department small multiples.
- **Method** — full glass-box methodology, coverage matrix, classifier audit, caveats.

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
node scripts/smoke.mjs   # headless smoke test across all tabs
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
above £150,000, where only 105 of 2,602 rows are an exact figure. **No midpoint is
computed anywhere**: the cube carries the two band edges, and a figure derived from it is
a range. Around two thirds of published senior posts have their pay withheld, and
withholding is grade-dependent, so every published row is kept and the disclosure rate
travels with any pay figure. Snapshots are keyed on the publisher's own reference date,
never bucketed into half-years. Tier A is the ministerial-department spine; Tier B is the
wider senior public sector and is never summed into an "SCS" figure. See the **Method**
tab for the full caveats. Not a government publication.
