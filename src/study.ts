// The study, authored as DATA.
//
// Conforms to field-study-system/content.schema.json (v1). Change what the
// study SAYS here; change how a beat LOOKS in its template in main.ts.
//
// Two rules run through this file:
//
//  1. No corpus number is hard-coded. Anything the ingest can change is written
//     as a {token} and resolved at render time against the loaded meta.json, so
//     a prose sentence cannot drift away from the chart beside it. The only
//     literals here are constants of the SOURCE (a £5,000 band, the alpha
//     employer contribution) or of the LAW (the transparency requirement).
//  2. Every claim carries fact | hypothesis | contested, and every beat ends
//     with an open question AND a falsifier. Both are enforced by the types.

export type Confidence = 'fact' | 'hypothesis' | 'contested';
export type TemplateId = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
export type ChartId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6';
export type Depth = 'plain' | 'research' | 'technical';

export interface Claim {
  /** Inline <b> permitted on the load-bearing noun only. */
  text: string;
  confidence: Confidence;
  cites?: number[];
}

export interface Prose {
  plain?: string;
  research: string;
  technical?: string;
  dropCap?: boolean;
}

export interface MarginNote { label?: string; text: string }

export interface Figure {
  /** `n.m` */
  no: string;
  caption: string;
  chart: ChartId;
  unit?: string;
  cites?: number[];
  /** which renderer in main.ts draws it */
  data: string;
}

export interface OpenQuestion { text: string; falsifier: string }

export interface Source {
  n: number;
  org: string;
  what: string;
  url: string;
  kind: 'white paper' | 'hansard' | 'regulator' | 'market data' | 'technical' | 'press' | 'legislation' | 'research';
  asOf?: string;
  caveat?: string;
}

export interface SurveyRow { cells: (string | number)[]; basis: 'census' | 'estimate' | 'reported' | 'derived'; pick?: boolean }

export interface Survey {
  columns: string[];
  rows: SurveyRow[];
  total: { label: string; value: string | number; reconciles: true };
  provenance: string;
  asOf: string;
  cannotTellYou: string[];
}

export interface Position {
  statement: string;
  elaboration?: string;
  confidence?: Confidence;
  because: { headline: string; detail: string }[];
  rejected: { name: string; why: string }[];
  conditions: string[];
  sinkers: string;
  phases?: { label: string; name: string; detail: string }[];
}

export interface Ledger {
  lenses: string[];
  activeLens?: string;
  benefits: Claim[];
  /** must be at least as long as benefits[] */
  risks: Claim[];
  balance: string;
  byActor?: { actor: string; gains: number; loses: number; net: 'positive' | 'negative' | 'even'; quote?: string }[];
}

export interface Lever {
  id: string;
  label: string;
  kind: 'B1' | 'B2' | 'B3' | 'B4';
  baseline: string;
  unit?: string;
}

export interface Instrument {
  id: string;
  name: string;
  href: string;
  kind: '2d-staged' | '3d-network' | 'matrix' | 'model';
  reachedFrom?: string[];
  levers?: Lever[];
  /** What it does not show and where its numbers came from. Mandatory. */
  limits: string;
}

export interface Beat {
  no: string;
  slug: string;
  name: string;
  template: TemplateId;
  minutes?: number;
  question?: string;
  claim?: Claim;
  standfirst?: string;
  marginNotes?: MarginNote[];
  prose?: Prose[];
  figures?: Figure[];
  pullQuote?: string;
  survey?: Survey;
  position?: Position;
  ledger?: Ledger;
  soWhat?: string;
  openQuestion?: OpenQuestion;
}

export interface Study {
  slug: string;
  number: number;
  title: string;
  subject: string;
  statusStamp: string;
  thesis: string;
  updated: string;
  status: { headline: string; detail: string; confidence: Confidence };
  findings: Claim[];
  asks: string[];
  glossary: { term: string; plain: string }[];
  sources: Source[];
  instruments: Instrument[];
  beats: Beat[];
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Sources — every one reachable, every one named on the beat that cites it
// ---------------------------------------------------------------------------

const SOURCES: Source[] = [
  {
    n: 1,
    org: 'Cabinet Office / departments, via data.gov.uk',
    what: 'Organogram of staff roles & salaries — the senior file, one CSV per organisation per reference date. The corpus this study is built from.',
    url: 'https://www.data.gov.uk/',
    kind: 'technical',
    asOf: '{dateTo}',
    caveat: 'Published under the OGL. Departments file to their own calendar; a reference date can be any month from 2022 onwards.',
  },
  {
    n: 2,
    org: 'The National Archives',
    what: 'Open Government Licence v3.0 — the licence every figure in this study inherits.',
    url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    kind: 'legislation',
    asOf: 'v3.0',
  },
  {
    n: 3,
    org: 'Office for National Statistics',
    what: 'CPIH annual index, series L522 (MM23) — the deflator behind every real-terms figure.',
    url: 'https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/l522/mm23',
    kind: 'regulator',
    asOf: '{cpihSource}',
    caveat: 'There is no annual CPIH for the current year until ONS publishes one, so the newest year is shown nominal and labelled as such.',
  },
  {
    n: 4,
    org: 'Review Body on Senior Salaries',
    what: 'Government evidence to the SSRB — official SCS headcount, FTE, median and mean base salary by pay band. The control total this study checks itself against.',
    url: 'https://www.gov.uk/government/organisations/review-body-on-senior-salaries',
    kind: 'white paper',
    asOf: 'annual, October to February',
    caveat: 'Published as a PDF with no data annex; figures are read behind a checksum gate and a human approval step.',
  },
  {
    n: 5,
    org: 'Office for National Statistics',
    what: 'Annual Survey of Hours and Earnings, Table 14 — occupational pay by four-digit SOC 2020, the whole-economy comparator.',
    url: 'https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/earningsandworkinghours/datasets/occupation4digitsoc2020ashetable14',
    kind: 'market data',
    asOf: 'annual, provisional in late October',
    caveat: 'Basic pay (Table 14.3a) only. Gross annual pay includes incentive pay and is not comparable with an organogram base salary.',
  },
  {
    n: 6,
    org: 'Cabinet Office',
    what: 'Civil Service Statistics — profession quartiles, median by responsibility level, counts above £100k / £150k / £200k.',
    url: 'https://www.gov.uk/government/collections/civil-service-statistics',
    kind: 'regulator',
    asOf: 'annual, late July to October',
  },
  {
    n: 7,
    org: 'Cabinet Office',
    what: 'Senior officials high earners — the only named, exact-figure accounting of the highest paid. Two publications, two thresholds, a two-year hole.',
    url: 'https://www.gov.uk/government/collections/senior-officials-high-earners-salaries',
    kind: 'regulator',
    asOf: 'annual',
    caveat: 'The disclosure threshold moved from £150,000 to £174,000 between the 2022 and 2025 editions, so the two are not one series.',
  },
  {
    n: 8,
    org: 'Civil Service Pension Scheme',
    what: 'alpha — the career-average scheme every comparison in this study has to hold in mind, worth roughly 23.6 to 28 per cent of salary in employer contribution.',
    url: 'https://www.civilservicepensionscheme.org.uk/',
    kind: 'technical',
    asOf: 'scheme year 2025/26',
  },
  {
    n: 9,
    org: 'Senior Salaries Review Body',
    what: 'the annual reports, 1994 to 2026. The market-gap figures are read from the published charts by scripts/ssrb-corpus.mjs rather than transcribed, so each value carries the edition and page it came from.',
    url: 'https://www.gov.uk/government/collections/ssrb-annual-reports',
    kind: 'regulator',
    asOf: 'annual, published May to July',
    caveat: 'The underlying series is described by the publisher as unpublished Cabinet Office data, so the percentages can be cited but the numbers behind them cannot be checked. The figure number moves between editions and the same year has been restated between them.',
  },
];

// ---------------------------------------------------------------------------
// The study
// ---------------------------------------------------------------------------

export const study: Study = {
  slug: 'scs-earnings',
  number: 6,
  title: 'Who earns what across Whitehall',
  subject: 'Senior Civil Service pay',
  statusStamp: 'LIVE · REBUILT MONTHLY FROM SOURCE',
  updated: '{generated}',
  thesis:
    'Every central government body has published a senior pay organogram since 2010. Assembled, they answer one question well — how many senior posts there are, and at what grade — and a second question only partly, because most departments file the post and withhold the pay. This study reads the whole published estate, states the pay as the band it actually is, and puts the withholding on the front page rather than in a footnote.',

  status: {
    headline: 'Built from {snapshots} filings, rebuilt monthly',
    detail:
      '{orgs} organisations, {posts} published senior post rows, {dateFrom} to {dateTo}. Pay statistics rest on the {disclosed} rows where a band was published; headcount and grade mix use all of them.',
    confidence: 'fact',
  },

  findings: [
    {
      text:
        'Most published senior posts carry <b>no published salary</b>. {withheldShare} of the senior post rows in this corpus name the post, the grade, the unit and the hours, and withhold the pay.',
      confidence: 'fact',
      cites: [1],
    },
    {
      text:
        'Withholding is <b>grade-dependent</b>, so the disclosed subset is not a small copy of the whole. At the latest filing the disclosure rate runs from {discLowRate} at {discLowGrade} to {discHighRate} at {discHighGrade} — a median taken over the disclosed rows alone is a median of a more senior population.',
      confidence: 'fact',
      cites: [1],
    },
    {
      text:
        'On the published bands senior pay has risen in cash and <b>roughly held still against CPIH</b> — but the bands are £5,000 wide, so neither movement can be stated to the pound, and no honest version of this study will ever be able to.',
      confidence: 'hypothesis',
      cites: [1, 3],
    },
  ],

  asks: [
    'Is senior civil service pay actually rising, in cash and after inflation?',
    'How much of the senior pay estate is published at all, and by whom?',
    'Which parts of the senior structure have gained — digital, policy, or the top of the ladder?',
    'What would have to be true for any of this to be wrong?',
  ],

  glossary: [
    { term: 'SCS', plain: 'The Senior Civil Service: the four grades from Deputy Director (SCS1) up to Permanent Secretary (SCS4).' },
    { term: 'Organogram', plain: 'The staff structure chart every department must publish, listing each senior post, its grade and its pay band.' },
    { term: 'Pay band', plain: 'A £5,000-wide range — a floor and a ceiling — rather than a salary. There is no midpoint in the data.' },
    { term: 'Disclosure rate', plain: 'The share of published posts that also publish a pay band. The rest are counted but their pay is withheld.' },
    { term: 'Tier B', plain: 'Wider public bodies that map their own grades onto SCS equivalents. Interesting, shipped, and never summed into an SCS figure.' },
    { term: 'CPIH', plain: 'The ONS inflation measure used to restate old pay in today\'s money.' },
    { term: 'Constant scope', plain: 'Restricting a trend to bodies that filed in every period, so the total does not move because the membership moved.' },
  ],

  sources: SOURCES,

  instruments: [
    {
      id: 'explore',
      name: 'The pay explorer',
      href: '#explore',
      kind: 'matrix',
      reachedFrom: ['04'],
      levers: [
        { id: 'measure', label: 'Measure', kind: 'B2', baseline: 'Median pay band' },
        // Opens on the total, not on a breakdown. Per-organisation medians are
        // sparse at any fine grain — most bodies file once or twice a year — so
        // opening on Organisation drew fragments rather than a trend. The
        // breakdown is one click away and the reader chooses it knowing why.
        { id: 'dimension', label: 'Break down by', kind: 'B3', baseline: 'Total' },
        { id: 'basis', label: 'Basis', kind: 'B2', baseline: 'As published' },
        { id: 'realTerms', label: 'Money', kind: 'B2', baseline: 'Nominal (cash)' },
        // The period grain is part of this lever, and Year is the baseline
        // because filing cadence changed in 2022. See `limits`.
        { id: 'scope', label: 'Scope', kind: 'B4', baseline: 'All Tier A bodies · Year' },
      ],
      limits:
        'It does not show a salary. Every pay figure is the pair of bounds a £5,000 band allows, computed on the disclosed rows only, over a population whose disclosure rate is printed beneath the chart. It does not show total reward, anyone below the SCS, or any body that never filed. It opens on the total at the <b>year</b> grain, and both of those are deliberate: a median for one organisation in one quarter usually rests on no filing at all, and filing cadence went from twice-yearly to near-monthly in 2022, so a finer grain makes the right-hand half of every series denser than the left for reasons that are publication rather than pay. Break it down and refine the period as much as you like — the cadence arithmetic is printed under the chart at whatever grain you choose. Numbers come from the published organograms [1]; the deflator is ONS CPIH [3].',
    },
  ],

  disclaimer:
    'Written in a personal capacity. Nothing here is the view of any employer, past or present, and no non-public information was used: every figure traces to a published file listed in the sources.',

  beats: [
    // ---------------------------------------------------------------- T0
    {
      no: '00',
      slug: 'front',
      name: 'Abstract',
      template: 'T0',
      minutes: 2,
    },

    // ---------------------------------------------------------------- 01 T1
    {
      no: '01',
      slug: 'problem',
      name: 'The problem',
      template: 'T1',
      minutes: 4,
      question: 'Is senior pay actually rising?',
      claim: {
        text:
          'In cash, yes — the published bands drift upwards across the series. Against CPIH the movement is <b>much smaller than the cash figure suggests</b>, and the £5,000 banding means neither can be stated exactly.',
        confidence: 'hypothesis',
        cites: [1, 3],
      },
      marginNotes: [
        { label: 'Why it is argued about', text: 'Senior pay is the one part of the public payroll that is published post by post. It is therefore the part that gets argued about, whether or not it is the part that matters.' },
        { label: 'Cited here', text: 'Organograms [1]; CPIH series L522 [3].' },
        { label: 'Terms', text: 'A band is a floor and a ceiling £5,000 apart. A median band is the pair of bounds the middle post could sit between.' },
      ],
      prose: [
        {
          dropCap: true,
          plain:
            'Every year somebody says senior civil servants are paid too much, and somebody else says they are paid too little to keep anyone good. Both sides quote numbers. Almost none of those numbers come from the one place government actually publishes senior pay: the organogram every department has filed since 2010.',
          research:
            'The senior pay argument is conducted almost entirely in aggregate: a headline median, a count of officials above the Prime Minister, a recruitment consultant\'s gap estimate. All three exist. None of them is the published record. Since 2010 every central government organisation has had to file an organogram of staff roles and salaries, post by post, and those files — {snapshots} of them in this corpus — are the primary source that the argument keeps not using [1].',
          technical:
            'The corpus is the senior organogram file only: one row per senior post per reference date, carrying grade, unit, professional group, FTE, a reports-to edge and a pay band where one was published. Junior files are a different unit of analysis — role-group aggregates rather than posts — and are excluded. The unit of publication is (organisation, reference date), summed across the sibling CKAN packages that make up one body [1].',
        },
        {
          plain:
            'The reason the published record is not used is that it is awkward. It does not give salaries; it gives £5,000 bands. Most posts do not even give that. And the files are scattered across hundreds of downloads, several of which are not really the file they claim to be.',
          research:
            'The published record resists the question in three ways. Pay is banded at £5,000 throughout, so no median can be exact. Disclosure is optional in practice and is exercised unevenly, so the rows that carry a band are not a random sample of the rows that do not. And the files themselves are inconsistent: a reference date can be a filename, a package title, or an upload stamp masquerading as one, and a handful of "CSVs" are PDFs.',
          technical:
            'Reference dates are resolved to declared / inferred / default confidence and every snapshot carries which it was. Within a period the most complete filing wins — most published headcount, ties to the later date — and every filing that was not chosen is counted, so "unreachable" is a number rather than a silence: {droppedSnapshots} filings sit behind the chosen ones at the current grain.',
        },
        {
          plain:
            'So this study does the awkward thing. It reads every file, keeps every post whether or not the pay was published, and shows pay as the range it really is.',
          research:
            'The approach here is to refuse all three shortcuts. Every published post row is kept, with a disclosure status and a reason. Pay is carried as (floor, ceiling) and never collapsed to a midpoint. And the disclosure rate is printed beside every pay figure rather than assumed away. What that produces is a weaker headline and a much stronger account of what is knowable.',
          technical:
            'Percentile bounds are provable rather than approximate: order statistics are monotone under pointwise domination, so the q-quantile of the published floors is a true lower bound on the q-quantile of the unobserved salaries and the q-quantile of the ceilings is a true upper bound. Both land on published band edges. Nothing between them is asserted.',
        },
      ],
      figures: [
        {
          no: '1.1',
          caption: 'The median band for all Senior Civil Service posts that published one. The shaded channel is the whole of what the data supports: the middle post sits somewhere inside it, and the data cannot say where. Switch the money lever on beat 04 to read it in today\'s pounds.',
          chart: 'A1',
          unit: '£ per year, base pay',
          cites: [1, 3],
          data: 'medianBandTotal',
        },
        {
          no: '1.2',
          caption: 'Senior posts published per period, on the same scope. The count is a census of what was filed, not an estimate of what exists: a body that skipped a quarter reads as a fall.',
          chart: 'A1',
          unit: 'posts',
          cites: [1],
          data: 'headcountTotal',
        },
      ],
      pullQuote: 'The published record does not resist the question because it is secret. It resists because it is banded, partial and honest about both.',
      soWhat:
        'If the cash line and the real line tell different stories, then most of the public argument is about the cash line, and most of the pay comparison the Civil Service itself runs is about the real one. That gap is worth a beat of its own.',
      openQuestion: {
        text: 'Does the movement in the published bands track the movement in actual senior salaries, or only the movement in the pay ranges departments choose to publish?',
        falsifier:
          'Compare the median of this corpus against the SSRB control total for the same year and grade. If the two diverge by more than a band width in the same direction across several years, the corpus is measuring publication behaviour rather than pay.',
      },
    },

    // ---------------------------------------------------------------- 02 T2
    {
      no: '02',
      slug: 'estate',
      name: 'The estate & evidence',
      template: 'T2',
      minutes: 6,
      question: 'What has actually been published, and what is missing from it?',
      claim: {
        text:
          '{orgs} organisations have filed {snapshots} senior organograms covering {posts} post rows since {dateFrom}. About {failRate} of source files still cannot be read — <b>and every one of them is named</b> rather than quietly dropped.',
        confidence: 'fact',
        cites: [1],
      },
      standfirst:
        'The corpus, counted. Everything below is a census of published files, not a sample of them: if a body filed, it is here; if it did not, it is empty rather than estimated.',
      prose: [
        {
          plain:
            'This is what the study includes, and — more importantly — what it does not.',
          research:
            'The survey below accounts for every organisation in the corpus. Two rules govern it. A body is never summed with its own predecessor or successor, because in 2023 the corpus legitimately holds a department and the three departments it was split into at the same time. And a wider public body is never summed into a Senior Civil Service figure, because those bodies map their own grades onto SCS equivalents and are a different population.',
          technical:
            'Lineage is enforced structurally: each organisation carries validFrom / validTo and predecessor / successor edges, and any cross-period pooling drops whichever side of an overlap was not live at the period end. Tier B becomes part of the group key when it is switched on, so a Tier B number cannot land inside an SCS total even by accident.',
        },
        {
          plain:
            'The honest version of what this study is: it includes every senior post row published, whether or not the pay was published with it. It does not include the salary of the posts whose department withheld it — and that withholding, not the pay level, is the most important thing here.',
          research:
            'Stated plainly, because it is the study\'s central claim about itself. IT INCLUDES every senior post row in every senior organogram for every covered organisation, whether or not pay was disclosed, each with a disclosure status and a reason; the published band as a (floor, ceiling) pair; and the structure the files carry — job title, unit, sub-organisation, professional group, FTE, reports-to. IT DOES NOT INCLUDE the actual salary of the {withheldShare} of posts whose department withheld it. That withholding, and not the pay level, is this study\'s most important finding.',
          technical:
            'Withholding is recorded, not inferred: the withheld sentinel carries a reason drawn from the published cell — blank, zero, "N/A", implausible or other. A withheld row is in headcount, in the grade mix and in the disclosure rate, and in no pay statistic. Dropping those rows is what inverted the shipped grade mix in the previous version of this pipeline and lifted every median by roughly £15,000 to £20,000.',
        },
        {
          plain:
            'It also does not include exact salaries, total pay, junior staff, or names.',
          research:
            'Four more exclusions, each deliberate. Exact salaries: the bands are £5,000 wide throughout, including at the top — the source note for this build states how few rows above £150,000 are exact. Total remuneration: organograms are base pay only, with no bonus, allowance, London weighting or employer pension, and the civil service alpha employer contribution is worth roughly 23.6 to 28 per cent of salary against a typical private defined-contribution scheme\'s 3 to 8 per cent [8]. Junior staff: a different unit of analysis. Names: published lawfully upstream, deliberately not republished here.',
          technical:
            'The name column is read for exactly one purpose — to derive a post status of filled / vacant / eliminated / redacted — and is then discarded before anything is written. It is never stored or emitted. Job and team function prose and contact details are dropped at parse for the same reason.',
        },
      ],
      figures: [
        {
          no: '2.1',
          caption: 'Who filed, and when. Two tint steps and empty: a cell is either no filing, a filing, or a heavy filing period, so the filled cells can be counted rather than shaded. Gaps are gaps — 2020 is missing for almost every department.',
          chart: 'A4',
          unit: 'filings per year',
          cites: [1],
          data: 'coverageMatrix',
        },
      ],
      soWhat:
        'A census with named holes is worth more than a sample with clean edges. Every number in the rest of this study can be traced to a row of the table above, and every hole in it is countable.',
      openQuestion: {
        text: 'How much of the 2010–2012 record is permanently gone, rather than merely unread? Several origin hosts no longer exist and answer with a redirect or a CAPTCHA instead of a file.',
        falsifier:
          'Recover the failed downloads from the UK Government Web Archive and re-run. If the recovered files move the early-period headcount by more than a few per cent, the early series was measuring survivorship, not government.',
      },
    },

    // ---------------------------------------------------------------- 03 T1
    {
      no: '03',
      slug: 'reading',
      name: 'Ways to read it',
      template: 'T1',
      minutes: 5,
      question: 'What do these numbers actually measure?',
      claim: {
        text:
          'Every pay figure here is a <b>£5,000 band computed on the disclosed rows only</b>. A median without its disclosure rate beside it is a median of a different population, and a count above a threshold is a range, not a number.',
        confidence: 'fact',
        cites: [1],
      },
      marginNotes: [
        { label: 'The band', text: 'Published senior pay is a floor and a ceiling £5,000 apart. Take the midpoint and you have invented a figure with a precision of about plus or minus £2,500 that nobody published.' },
        { label: 'The rate', text: 'Disclosure runs low at SCS1 and high at SCS2 and above. Sort the chart by disclosure rate before believing any grade comparison.' },
        { label: 'Cited here', text: 'Organograms [1]; CPIH [3]; SSRB control totals [4].' },
      ],
      prose: [
        {
          dropCap: true,
          plain:
            'Three things change what a number here means: which measure you pick, whether you are in cash or today\'s money, and how many posts were behind it.',
          research:
            'Three levers change the meaning of every figure on this page, and all three are visible on the instrument in beat 04. The measure decides the population — a pay statistic reads the disclosed subset, a headcount reads everything published. Real terms decides whether you are comparing cash or purchasing power. And the sample size decides whether a line is a finding or a rumour: below thirty posts the instrument stops drawing a trend and says so.',
          technical:
            'Banded measures return bounds with the point value null throughout, by design: a caller who wants one line for a median is asking for a number nobody published. Point measures — headcount, FTE, disclosure rate, vacancies, eliminated posts — return values and no bounds. The two are never mixed on one axis.',
        },
        {
          plain:
            'The disclosure rate is the one to watch. Roughly a third of senior posts publish a band; the rest do not. And it is not spread evenly — the more senior the post, the more likely the pay is published.',
          research:
            'Disclosure is the study\'s dominant source of bias and its most interesting finding. At the latest filing, {discLowGrade} publishes a band for about {discLowRate} of its posts while {discHighGrade} publishes about {discHighRate}. The disclosed subset is therefore tilted towards the senior end, and an unweighted median over it will read high. The instrument offers a grade-reweighted basis — the disclosed distribution projected back onto the published grade mix — which is the honest correction, and it prints the share of headcount that correction could cover.',
          technical:
            'Reweighting normalises each grade\'s disclosed band histogram and rescales it to that grade\'s share of published headcount. Where a grade has published headcount but no disclosed band, it cannot be projected, so coverage is below one and is reported per period. Reweighting a period whose coverage is low is not more accurate than not reweighting it; it is differently wrong, and the coverage figure is what lets you tell.',
        },
        {
          plain:
            'And because pay is banded, questions like "how many earn more than the Prime Minister" have two answers: how many certainly do, and how many might.',
          research:
            'A £145,000–£149,999 band and a £150,000–£154,999 band sit either side of a line the data cannot resolve. So a threshold count is reported as a pair: the posts whose published floor is already above the line, and the posts whose ceiling could be. The gap between the two lines below is not noise — it is the width of what banding hides, drawn to scale.',
          technical:
            'Certain counts posts with floor ≥ threshold; possible counts posts with ceiling ≥ threshold. Open-band rows, where only one edge was published, are counted in headcount and excluded from every money total: copying the published edge onto the missing one would state a floor the department never published.',
        },
      ],
      figures: [
        {
          no: '3.1',
          caption: 'Disclosure rate by grade. The seniority gradient is the whole reason a raw median reads high — and the reason the reweighted basis exists.',
          chart: 'A1',
          unit: 'share of published posts with a pay band',
          cites: [1],
          data: 'disclosureByGrade',
        },
        {
          no: '3.2',
          caption: 'Two thresholds, both drawn as ranges. The solid line in each panel counts the posts <b>certainly</b> above — those whose published pay floor already clears the threshold — and the shading above it counts the posts that <b>possibly</b> are, where the published ceiling reaches it. The line is a published bound and not a midpoint: no line is drawn through the middle of the shading, because the middle is the one place this data cannot put anything. Both panels share one axis, so the two counts are comparable by eye.',
          chart: 'A1',
          unit: 'posts with a published band',
          cites: [1],
          data: 'abovePm',
        },
      ],
      pullQuote: 'A median with no disclosure rate beside it is not a median of senior pay. It is a median of the pay somebody chose to publish.',
      soWhat:
        'Read every chart on this page as two numbers and a caveat rather than one number. The instrument is built so you cannot avoid seeing the caveat.',
      openQuestion: {
        text: 'Does grade-reweighting actually recover the population median, or does it merely move the bias from disclosure to grade classification?',
        falsifier:
          'Compare the reweighted median against the SSRB\'s published median by pay band for the same year [4]. If the reweighted figure is not closer to the control total than the raw figure, the correction is not working.',
      },
    },

    // ---------------------------------------------------------------- 04 T3
    {
      no: '04',
      slug: 'finding',
      name: 'The finding',
      template: 'T3',
      minutes: 5,
      question: 'What is the one call this study makes?',
      claim: {
        text:
          'The senior pay debate is unarguable in its current form because <b>the pay is missing from most of the record</b>. Publishing the band already held would settle more than any new survey.',
        confidence: 'hypothesis',
        cites: [1, 4],
      },
      marginNotes: [
        { label: 'A position', text: 'One call, stated at full strength, with the alternatives named and what would sink it printed beside it.' },
        { label: 'Why the record', text: 'Every other beat measures pay. This one argues about the record, because that is the part anyone can change without first deciding what anybody should be paid.' },
        { label: 'Cited here', text: 'Organograms [1]; SSRB control totals [4].' },
      ],
      prose: [
        {
          plain:
            'Everything up to here has been description. This is the one thing the study actually argues for.',
          research:
            'Everything before this beat is description; this is the one call the study makes, and it is a call about publication rather than about pay. The instrument below exists so the call can be tested rather than believed: set the levers against it and watch what survives.',
          technical:
            'The call is falsifiable in the specific way stated in the open question below: take the bodies already disclosing above 90 per cent, recompute their median with and without their low-disclosure grades, and see whether the two agree inside a band width.',
        },
      ],
      position: {
        statement: 'Publish the band for every senior post, or the pay argument stays unarguable.',
        elaboration:
          'The band is already known to the department, already published for a minority of posts, and already coarse enough that nobody\'s salary is revealed by it. What is missing is not data collection — it is the decision to fill a column that already exists in a file the department is already required to file.',
        confidence: 'hypothesis',
        because: [
          {
            headline: 'The gap is structural, not random',
            detail:
              'Disclosure is grade-dependent: {discLowGrade} publishes about {discLowRate} of its bands, {discHighGrade} about {discHighRate}. Every median drawn on the disclosed rows is therefore a median of a more senior population than the one it names.',
          },
          {
            headline: 'The cost of publishing is already paid',
            detail:
              'The post, its grade, its unit, its hours and its reporting line are already published for {posts} rows. The only column withheld is the one the argument is about.',
          },
          {
            headline: 'Nothing else fills it',
            detail:
              'The aggregate sources — the SSRB evidence, Civil Service Statistics — give control totals, not departmental structure. They cannot answer which body, which profession or which unit, and they were never meant to.',
          },
        ],
        rejected: [
          {
            name: 'Publish exact salaries for every senior post',
            why:
              'A stronger version of the same argument, and it should be stated at full strength: exact figures would end the banding problem outright. It is rejected here because the £5,000 band is already sufficient for every question this study asks, and the marginal disclosure buys precision at a real cost in individual identifiability at the thin top of the ladder.',
          },
          {
            name: 'Rely on the SSRB control totals and drop the post-level record',
            why:
              'Genuinely attractive: the SSRB series is official, grade-matched and already quality-assured, and it does not have a disclosure problem at all [4]. It is rejected because it carries no departmental, professional or unit dimension, so it can say what the Civil Service pays and never who pays it.',
          },
          {
            name: 'Leave the current voluntary practice alone',
            why:
              'The honest case for it is that publishing a band beside a job title in a small unit can identify a person, and departments withholding are often the ones with the thinnest structures. The reason to reject it is that the resulting sample is biased in a known direction and is being read as if it were not.',
          },
        ],
        conditions: [
          'The band stays £5,000 wide. A narrower band starts to identify individuals in small units and would justify the current withholding.',
          'The disclosure status stays a published field, with its reason. "Withheld because the unit is too small" and "withheld because the template default was left in place" are different facts and are currently indistinguishable.',
          'The reference date stays declared in the file rather than inferred from an upload stamp. Roughly one in five resources currently declares an upload date as if it were a reference date.',
        ],
        sinkers:
          'If the withheld posts turn out to be systematically different in pay as well as in grade — for example concentrated in the specialist scales that sit outside the SCS pay ranges — then filling the column would not correct the bias, it would replace it with a different one. Nothing in this corpus can currently rule that out.',
        phases: [
          { label: 'A', name: 'Fill the column', detail: 'Publish the band for every senior post, including vacant ones, in the file already being filed.' },
          { label: 'B', name: 'Say why, when not', detail: 'Where a band is genuinely withheld, publish the reason as a coded value rather than an empty cell.' },
          { label: 'C', name: 'Declare the date', detail: 'Put the reference date in the resource path, so a snapshot is never inferred from when somebody uploaded it.' },
          { label: 'D', name: 'Reconcile publicly', detail: 'Publish the residual between the organogram total and the SSRB control total each year, rather than leaving both to be discovered separately [4].' },
        ],
      },
      soWhat:
        'Everything after this beat is either evidence for that call or a test of it. The instrument above is the test: set the levers against it and see whether the finding survives its own assumptions.',
      openQuestion: {
        text: 'Would filling the column change the answer, or only its confidence interval?',
        falsifier:
          'Take the bodies that already disclose above 90 per cent and compute their median with and without their low-disclosure grades. If the two agree inside a band width, withholding is costing precision rather than truth, and the call above is weaker than it sounds.',
      },
    },

    // ---------------------------------------------------------------- 05 T4
    {
      no: '05',
      slug: 'who-wins',
      name: 'What it does & who wins',
      template: 'T4',
      minutes: 10,
      question: 'Who has gained inside the senior structure, and who has not?',
      claim: {
        text:
          'The visible gains sit with <b>digital and data roles and with the top of the ladder</b>, and both readings are weaker than they look: the professional group is a template default as often as it is a classification.',
        confidence: 'hypothesis',
        cites: [1, 6],
      },
      prose: [
        {
          plain:
            'Some parts of the senior structure have done better than others. The lens below re-orders the ledger; it never hides a row, so you can always see whose view you have left.',
          research:
            'Read this beat as a ledger rather than a ranking. The lens re-orders both columns and the actor table so the reading you asked for comes to the top, and it never removes a row: a gains column with the risks filtered out is a brochure. The risk column is longer than the gains column on purpose — if it were not, the study would not have looked hard enough.',
          technical:
            'Both columns are claims with their own confidence, and the actor table\'s gains and loses counts are the number of ledger rows that bear on that actor, not a score. The figures beneath are the evidence: a DDaT-against-policy comparison on the published floors, a grade mix on the published headcount, and one department decomposed from its own file.',
        },
      ],
      ledger: {
        lenses: ['Digital & data', 'Policy', 'By grade', 'By organisation'],
        activeLens: 'Digital & data',
        benefits: [
          { text: 'Digital, data and technology roles hold a visible pay premium over policy roles at the same grade, and the gap has not closed across the series.', confidence: 'hypothesis', cites: [1] },
          { text: 'The senior estate has grown: more senior posts are published now than at the start of the series, across most organisations that file consistently.', confidence: 'fact', cites: [1] },
          { text: 'Departmental structure is recoverable at agency level. A ministry decomposes into its executive agencies from the published file, at no extra cost.', confidence: 'fact', cites: [1] },
        ],
        risks: [
          { text: 'The professional group is unreliable as a classification: a large share of rows are "Policy Profession" because that is the template default, and another large share are blank or "Other".', confidence: 'contested', cites: [1, 6] },
          { text: 'The digital premium may be a grade-mix effect. Digital roles cluster at particular grades, and a premium measured across grades is partly a seniority difference.', confidence: 'hypothesis', cites: [1] },
          { text: 'Growth in published posts is partly growth in publishing. A body that files more completely this year than last reads as a body that grew.', confidence: 'hypothesis', cites: [1] },
          { text: 'Machinery-of-government churn moves whole populations between organisations. A department that "shrank" in 2023 may simply have been split into three.', confidence: 'fact', cites: [1] },
        ],
        balance:
          'On the published record digital roles are ahead and the ladder is longer at the top, but every one of those readings survives only while you hold the grade mix and the publication behaviour still — and neither of them holds still.',
        byActor: [
          { actor: 'Digital & data roles', gains: 2, loses: 1, net: 'positive', quote: 'Ahead on the published bands, at a grade mix that is not the same as everyone else\'s.' },
          { actor: 'Policy roles', gains: 1, loses: 2, net: 'negative', quote: 'The largest group in the corpus, and the least reliably classified.' },
          { actor: 'The top of the ladder', gains: 2, loses: 1, net: 'positive', quote: 'Discloses most, so is measured best, so is argued about most.' },
          { actor: 'Deputy Directors', gains: 1, loses: 2, net: 'negative', quote: 'The largest grade by headcount and the least disclosed: the biggest hole in the record.' },
          { actor: 'The reader', gains: 1, loses: 1, net: 'even', quote: 'Gets the whole published estate, and a permanent asterisk on two thirds of it.' },
        ],
      },
      figures: [
        {
          no: '5.1',
          caption: 'Published pay floors for digital and data roles against policy roles and everything else. Lines are the lower bound of each group\'s median band — the table twin carries both edges. Read the disclosure rates in the limits strip before reading the gap.',
          chart: 'A1',
          unit: '£ per year, lower bound of the median band',
          cites: [1],
          data: 'ddatVsPolicy',
        },
        {
          no: '5.2',
          caption: 'Grade mix of published senior posts. An ordinal ramp, not categorical hues: the grades have an order, and "Other / Not stated" sits at the base in ghost rather than wearing a colour it has not earned.',
          chart: 'A1',
          unit: 'share of published senior posts',
          cites: [1],
          data: 'gradeMix',
        },
        {
          no: '5.3',
          caption: 'One department decomposed into the bodies inside its own file. This is the Organisation column of the published CSV, which most readings of this data throw away.',
          chart: 'A2',
          unit: 'published senior posts at the latest filing',
          cites: [1],
          data: 'agencyDecomposition',
        },
        {
          no: '5.4',
          caption: 'Median pay at each SCS grade, one panel per rung. There is no line in any panel because there is no median: the ribbon runs from the median of every published floor at that grade to the median of every published ceiling, and the true middle is somewhere inside it. All four panels share one axis, so the distance between the rungs is the distance on the page.',
          chart: 'A1',
          unit: '£ per year, base pay, as bounds',
          cites: [1],
          data: 'payLadder',
        },
        {
          no: '5.5',
          caption: 'The one exact-figure accounting of the highest paid that government publishes — and it is two publications, not one series. The threshold moved from £150,000 to £174,000, and no list at all exists for 2023 or 2024. Nothing is drawn across those years and nothing is interpolated through them: any apparent fall between the two eras is the threshold moving, not pay falling.',
          chart: 'A1',
          unit: 'Civil Service entries at or above the threshold',
          cites: [7],
          data: 'highEarners',
        },
      ],
      soWhat:
        'The gains are real on the published record and fragile off it. If you take one number away from this beat, take the disclosure rate beside it.',
      openQuestion: {
        text: 'Is the digital premium a pay decision or a classification artefact — are digital roles paid more, or are better-paid roles more likely to be labelled digital?',
        falsifier:
          'Hold the grade constant and re-run the comparison inside a single grade with a disclosure rate above 90 per cent. If the premium disappears, it was grade mix; if it survives, it is pay.',
      },
    },

    // ---------------------------------------------------------------- 06 T2
    {
      no: '06',
      slug: 'trust',
      name: 'Trust & safeguards',
      template: 'T2',
      minutes: 6,
      question: 'What could be wrong with all this, and what would show it?',
      claim: {
        text:
          'The largest uncertainty is not sampling error, it is the <b>withheld majority</b>. Everything else — banding, classification, machinery-of-government churn — is bounded, counted and printed here.',
        confidence: 'hypothesis',
        cites: [1, 4],
      },
      standfirst:
        'The published population, accounted for by what it tells you about pay. Every row is a census count from the files; the total is the published post rows and it reconciles.',
      prose: [
        {
          plain:
            'Four things could make this study wrong, and each has a number attached.',
          research:
            'Four failure modes, each with a measurement rather than a reassurance. Banding: every pay figure is a range, and the range is drawn. Classification: professional group and grade are normalised from free text, and the share that could not be classified is published rather than hidden inside "Other". Machinery of government: departments split and merge, and the study refuses to sum a predecessor with its own successor. And the control total: the SSRB publishes an official SCS median by pay band, and the residual against it is the honest check on all of the above [4].',
          technical:
            'Grade normalisation keeps the raw published string alongside the mapped band, so a mapping can be audited rather than trusted. Military ranks, own-scale specialists and unclassifiable rows are dropped from any figure described as SCS — on the departmental corpus the military band alone is thousands of officers, so an "SCS" chart that filters on senior posts rather than on the four SCS bands is wrong by a visible margin.',
        },
        {
          plain:
            'The comparison with the outside world is the weakest part, and it is weak in a specific way: the Civil Service pension is worth far more than a typical private one, and base salary comparisons ignore it.',
          research:
            'Any comparison against market pay has to hold three things: base against base, range against range, and pension in view. Organogram pay is base only. The ONS occupational series publishes basic pay weekly and gross pay annually, and the two are not interchangeable — comparing an SCS base salary against gross annual pay including incentive pay is the single most common way to overstate the gap [5]. And the alpha employer contribution of roughly 23.6 to 28 per cent, against a typical private defined-contribution scheme\'s 3 to 8 per cent, is worth more than most of the gaps being argued about [8].',
          technical:
            'Comparators arrive as figures that carry their own provenance, sample size, confidence and comparability flag, and a figure below the n = 30 floor or suppressed by the publisher is rendered as its reason rather than as a mark. Occupational codes break between SOC 2000, 2010 and 2020, and a break is drawn as a break rather than interpolated through.',
        },
      ],
      figures: [
        {
          no: '6.1',
          caption: 'Where the classification is soft: the share of published senior posts whose professional group is "Other" or "Not stated". A profession chart is only as good as the line at the bottom of this one.',
          chart: 'A1',
          unit: 'share of published senior posts',
          cites: [1],
          data: 'unclassifiedShare',
        },
        {
          no: '6.2',
          caption: 'The deflator, in full, including the years it refuses to deflate. Every money figure on the real-terms basis is restated through this table; a year with no published annual CPIH row is left nominal and says so, because carrying the previous year forward would put a fabricated index behind a real number.',
          chart: 'A4',
          unit: 'CPIH annual index, 2015 = 100',
          cites: [3],
          data: 'cpihTable',
        },
        {
          no: '6.3',
          caption: 'The outside comparison, where it is contested. Two published readings of the same quantity, tens of per cent apart, because one matches on job level and the other on occupation code — and a four-digit occupation code pools a two-person firm\'s director with a FTSE one. Both are printed. Picking one and calling it the market rate is the error this beat exists to prevent, and neither is comparable with a figure from this corpus without holding the pension in view [8].',
          chart: 'A4',
          unit: '£ per year, base pay, rounded to £1,000',
          cites: [4, 5, 8],
          data: 'comparators',
        },
        {
          no: '6.4',
          caption: 'The same quantity, published twice by the same body, two years apart. The Review Body\'s own chart put the director gap against the private sector at 65 per cent in its 2024 report and 48 per cent in its 2025 report — for the identical year. The restatement is larger than any year-on-year movement the series is used to describe, which means the number you quote depends mostly on which report you happened to open [9].',
          chart: 'A1',
          unit: 'per cent difference from the comparator median',
          cites: [9],
          data: 'ssrbRestatement',
        },
      ],
      soWhat:
        'None of the four failure modes is hidden and none is fixed. What has changed is that each one now has a number you can hold the study to.',
      openQuestion: {
        text: 'How large is the residual between this corpus and the official SCS control total, and is it stable?',
        falsifier:
          'Publish the residual against the SSRB Table 1 headcount every year [4]. A stable residual is a scope difference and can be explained; a growing one means the corpus is losing bodies it used to catch.',
      },
    },

    // ---------------------------------------------------------------- 07 T1
    {
      no: '07',
      slug: 'next',
      name: 'What happens next',
      template: 'T1',
      minutes: 3,
      question: 'What would change this answer, and when would you see it?',
      claim: {
        text:
          'The corpus is rebuilt monthly from source and <b>every run that changes something is recorded</b>, so the next answer is auditable against this one rather than replacing it silently.',
        confidence: 'fact',
        cites: [1],
      },
      marginNotes: [
        { label: 'Cadence', text: 'Pre-2022 the series was twice-yearly. From 2022 bodies file quarterly to monthly, across all twelve months.' },
        { label: 'Back-fills', text: 'A changed date matters as much as an added one: departments re-file old snapshots, and a back-fill mutates history.' },
      ],
      prose: [
        {
          dropCap: true,
          plain:
            'This page is rebuilt from the source files once a month. When something changes, the change is written down.',
          research:
            'The pipeline re-reads the published files monthly. A run that finds nothing new writes nothing at all, so the changelog is a record of real change rather than a record of cron. A run that finds something writes what it found: snapshots before and after, post rows before and after, which reference dates were added, how many source files failed, and which deflator was used.',
          technical:
            'Change detection keys on the resource URL set plus the resolved reference date, never on a package\'s metadata_modified — a bulk reindex touched a quarter of packages in a single month against a normal rate of a handful. Output is promoted atomically after floor assertions on snapshots, disclosed posts, organisations and dates, so a failed run leaves the previous build untouched.',
        },
        {
          plain:
            'Three things would change the answer rather than just update it.',
          research:
            'First, a change in disclosure behaviour: if the departments that currently withhold start publishing, the headline median will move for reasons that have nothing to do with pay, and this study will say so on the day it happens. Second, recovery of the 2010–2012 files whose origin hosts have gone: that would extend the series backwards and make the early comparison honest. Third, the annual control totals — a new SSRB round or a new Civil Service Statistics edition — which is when the residual gets re-measured [4][6].',
        },
      ],
      soWhat:
        'A study that is rebuilt is a study that can be wrong in public. The record of change above is the mechanism: if a number on this page moves, the run that moved it is named.',
      openQuestion: {
        text: 'Will the disclosure rate rise on its own, now that the withholding is the finding rather than the footnote?',
        falsifier:
          'Watch the disclosure rate by organisation over the next four filings. If it moves, the argument moved it; if it does not, publishing the gap is not enough on its own.',
      },
    },
  ],
};

export const beatBySlug = (slug: string): Beat | undefined => study.beats.find((b) => b.slug === slug);
export const beatIndex = (slug: string): number => study.beats.findIndex((b) => b.slug === slug);
export const DEFAULT_BEAT = study.beats[0].slug;
