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
npm run ingest      # gather all senior organogram CSVs -> public/data/*.json
npm test            # unit assertions for the parser/classifier
npm run dev         # local dev server
npm run build       # typecheck + production bundle
node scripts/smoke.mjs   # headless smoke test across all tabs
```

`scripts/ingest.mjs` queries the data.gov.uk CKAN API for each department's organogram
dataset, downloads every senior CSV (cached in `.cache/`), normalises each post, and
aggregates into a compact **additive histogram cube** at grain
`(period × department × profession × grade × ddat-flag × policy-flag)` — which supports
any client-side filter plus approximate medians/percentiles, in ~900 KB of JSON.

## Data source & honesty

Pay is disclosed as a **band** (£5k bands below £150k, individual figures above); every
figure is the band midpoint unless switched. Snapshots are bucketed to half-year periods
for cross-department alignment. Scope is the main ministerial departments (not ALBs). See
the **Method** tab for the full caveats. Not a government publication.
