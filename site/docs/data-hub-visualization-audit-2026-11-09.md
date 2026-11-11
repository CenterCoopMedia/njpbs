# NJ PBS Data Hub — 18-figure visualization audit and consolidation

**Audit date:** November 9, 2026 (America/New_York)  
**Reader:** `site/src/data/njpbs-data-hub-v16.html`  
**Styles:** `site/src/styles/data-hub.css`  
**Regression tests:** `site/tests/data-hub-reader.test.ts`  
**Consolidation:** draft PR [#5052](https://github.com/CenterCoopMedia/njpbs-site/pull/5052), branch `data-hub/release-audit-nov-2026`.

## Release assessment

**Needs revision before all 18 can be marked launch-ready.** All 18 editorial choices have been recorded; 10 are represented in the merged reader, 5 more are implemented for review in this integration branch, 2 are partly satisfied with missing supporting visual/data work, and 1 is deliberately source-gated. No approval for an automatic production merge, publication, or removal of caveats is implied. Eight prior PRs have been independently observed merged into `main`; branch integration uses that merged reader, not the original October snapshot.

“Integrated in main” means repository state only. It is **not evidence that `njpbs.org/data-hub/` is deployed at the latest commit**, or that browser/mobile/rendered screenshots have been checked. This report is not a claim of completed visual QA.

## Editorial choice and status for every figure

| # | Figure | Approved default and optional view | Repository status in this audit | Source / boundary and remaining action |
|---:|---|---|---|---|
| 1 | Unemployment rate | Monthly NJ vs. U.S. line chart, with clear five-year trend | **Partial** — historical NJ line and a national current comparison exist; the matching national monthly overlay is not yet implemented | Preserve BLS reporting grain and program differences. Do **not** splice independently defined national and NJ unemployment sources into one comparable dataset just to fulfill the design. Confirm a valid same-method series or retain separated context |
| 2 | Jobs gained/lost by industry | Diverging monthly sector change bars plus a separate matching 12-month comparison table | **Partial** — signed ten-industry bars exist; 12-month sector context not fully audited/implemented | NJDOL employer payroll/industry series, same adjustment and sector definitions; industry is not an occupation |
| 3 | Minimum hourly wage | Annual historical zero-based bars, 2020–2026; 2027 announcement shown separately | **Staged in #5052** | NJDOL effective January 1 rates ($11, $12, $13, $14.13, $15.13, $15.49, $15.92). Announced 2027 $16.48 is **not** yet an effective rate |
| 4 | Median household income | 2025 NJ vs. U.S. bars; regional NJ/NY/PA/U.S. toggle | **Merged** — #5003 | 2025 ACS one-year household income; 90% survey uncertainty, year-dollar basis and source table preserved |
| 5 | Average property tax bill | 2020–2025 historical bars, zero-based; annual difference highlighted | **In merged reader** | DCA historical statewide average methodology only; do **not** combine with the Division of Taxation's differently calculated 2025 average; avoid unjustified CPI overlays |
| 6 | Residential electricity price | Two-year August 2025/2026 grouped NJ and U.S. comparison | **Merged** — #5010 | EIA Electric Power Monthly Table 5.6.A residential sector for all four prices, cents/kWh **not** household bills |
| 7 | Median gross monthly rent | 2025 NJ vs. U.S. bars; NY/PA regional toggle | **Staged in #5052** | Census ACS one-year Table B25064 **only**; NJ $1,885 ±$19, U.S. $1,557 ±$4, NY $1,704 ±$14, PA $1,329 ±$13; 90% MOE; no ACS five-year/private asking rents mixed in |
| 8 | Housing units authorized by permits | Paired Jan.–Sep. 2025/2026 monthly bars with year-to-date total | **Merged** — #5016 | Census BPS monthly unadjusted NJBPPRIV; 22,517 in 2026 vs. 23,695 in 2025 through September; authorization is not construction starts/completions; no mixed annual/counties vintage |
| 9 | NY–Newark metro CPI-U inflation | September 2026 metro vs. U.S. bars; separate Jan.–Sep. 2026 metro history toggle | **Staged in #5052** | BLS CPI-U all-items 12-month rates, metro 4.5% vs U.S. 3.7% with matched September period. The metro spans NJ, NY and PA, **not NJ statewide**. Nov. 10 freshness check: October national CPI is published, but the required annual all-items rates are unavailable because October 2025 indexes are missing; retain the matched September comparison |
| 10 | Statewide precipitation | Jan.–Oct. 2026 monthly signed departure from 1991–2020 normal | **Merged** — #5019 | Rutgers/NOAA nClimDiv statewide table, revised to Oct. 2026; 36.98 in. 2026 vs. 33.81 in. 2025 vs. 39.93 in. normal for same months; no incomplete-year/full-year mixing |
| 11 | Statewide temperature | Jan.–Oct. 2026 monthly signed departure from 1991–2020 normal | **Merged** — #5022 | One Rutgers/NOAA nClimDiv statewide temperature table; October 57.3°F vs. 55.4°F normal; no 2026 annual average extrapolation |
| 12 | Registered voters | Full visible 21-county table, count and percent changes, statewide totals above | **In merged reader; November update ON HOLD** | Oct. 1, 2026 total 6,725,177 reconciles to source. The Nov. 1 2026 report's printed statewide 6,746,886 differs by **87** from its county/party sums 6,746,799. [Issue #5025](https://github.com/CenterCoopMedia/njpbs-site/issues/5025); no silent November substitution; not turnout |
| 13 | FY2027 enacted state government budget | Proportional treemap of 5 spending types with 22-department/account alternate and exact-value table | **Merged** — #5030 | Same OLS FY2027 Appropriations Act Scoresheet for both views. Total $60,743,569,000; source in **thousands of dollars**; spending-type and department classifications each separately reconcile. No federal funds, double counting or conflating appropriations with expenditures |
| 14 | NJ FamilyCare enrollment | Jan.–Oct. 2026 change since January with optional three-category eligibility composition | **Merged** — #5035 | Official NJ DMAHS monthly administrative enrollment reports only; October 1,786,101, change since January −23,363. Five published eligibility components reconcile; don't mix Census uninsured rates |
| 15 | Residents without health insurance | 2025 ACS NJ vs. U.S. rate bars with 2025 NJ age-group toggle | **Merged** — #5038 | Census 2025 ACS one-year ACSBR-027 Appendix A-2; NJ 7.7% ±0.3 pp, U.S. 8.4% ±0.1 pp, NJ adults 11.1%, children 4.2%; no direct 2024–25 trend due to 2025 ACS methodology change |
| 16 | NJ SNAP participation | Jan.–Jul. 2026 **year-over-year** percentage bars versus same 2025 months; 14 exact monthly counts in table; separate legal context | **Staged in #5052**; originating #5041 remains draft | NJ DFD July 2026 Current Program Statistics **Table 5 only** for chart: July 737,447 vs. 793,116 (−55,669; −7.0%). DFD federal-law timeline is separately sourced and is **not** a causal attribution or an input into percent calculations |
| 17 | Chronic absenteeism in schools | 2024–25 grade-by-grade K–12 bar chart with 14.4% statewide reference | **SOURCE-GATED; NOT PUBLISHABLE YET** — [issue #5044](https://github.com/CenterCoopMedia/njpbs-site/issues/5044) | Verify actual **2024–25** NJDOE state grade rows before drawing bars. PDFs circulating as 2024–25 actually display 2023–24 data. Preserve statewide 14.4% only. Beginning 2024–25, membership inclusion rule changed from 45 to 90 days and qualifying inactive student handling changed; no seamless historical trend |
| 18 | Four-year high school graduation rate | NJDOE state-version four-year adjusted cohort **percentage-point changes from 2022** through 2025; 2025 subgroup toggle | **Staged in #5052** | State-cohort 2022 90.9%, 2023 91.1%, 2024 91.3%, 2025 91.8% (2022–25 +0.9 pp). 2025 statewide 91.8%, economically disadvantaged 88.9%, students with disabilities 82.4% (not additive). Class of **2021 is 90.6%** in the state calculation (the May 2026 press summary's 90.9% “four years earlier” conflicts and matches **2022**, not 2021). No federal calculation or five/six-year mixing |

### Cohort graduation rate source reconciliation

- NJDOE state-calculation multi-cohort workbook: [2022–2025 rates](https://www.nj.gov/education/spr/adddata/doc/acgrdocs/AdjustedCohort4-YearGraduationRates_2022_2023_2024_2025.xlsx).
- NJDOE class-of-2025 student groups: [state four-year rates](https://www.nj.gov/education/spr/adddata/doc/acgrdocs/Cohort2025_4YearAdjustedCohortGraduationRatesbyStudentGroup.xlsx).
- NJDOE [April 2025 state-version historical chart](https://www.nj.gov/education/sboe/meetings/agenda/2025/April/public/4_2023-2024_School_Performance_Reports_and_Graduation_Data.pdf) shows 2021 **90.6%**, 2022 **90.9%**, 2023 **91.1%**, 2024 **91.3%**.
- [May 2026 press release](https://www.nj.gov/education/news/2026/SchoolPerformanceDataShowsGainsInKeyMetricsOfCollegeAndCareerReadiness.pdf) shows 2025 91.8% and the reported 2025 student-group rates but contains the contradictory earlier-cohort characterization.
- Approved default intentionally begins **2022**, so the 2021 conflict is documented without silently inventing a 2021 rate.

## Prior PR consolidation status

These PRs were observed **merged** in the connected repository on Nov. 9:
[#5003 income](https://github.com/CenterCoopMedia/njpbs-site/pull/5003), [#5010 electricity](https://github.com/CenterCoopMedia/njpbs-site/pull/5010), [#5016 housing](https://github.com/CenterCoopMedia/njpbs-site/pull/5016), [#5019 precipitation](https://github.com/CenterCoopMedia/njpbs-site/pull/5019), [#5022 temperature](https://github.com/CenterCoopMedia/njpbs-site/pull/5022), [#5030 budget](https://github.com/CenterCoopMedia/njpbs-site/pull/5030), [#5035 FamilyCare](https://github.com/CenterCoopMedia/njpbs-site/pull/5035), [#5038 uninsured](https://github.com/CenterCoopMedia/njpbs-site/pull/5038).

[#5041 SNAP](https://github.com/CenterCoopMedia/njpbs-site/pull/5041) is a separate **draft**, left unmerged. Its reviewed design was incorporated atop current `main` as part of draft [#5052 consolidated audit](https://github.com/CenterCoopMedia/njpbs-site/pull/5052) along with graduation, rent, minimum wage and metro inflation. **Do not merge #5041 as well without reconciled diff review**, to prevent duplicate or overwritten reader changes.

### SNAP household metadata scope

The approved SNAP chart, exact-value table, CSV and SVG describe matched monthly **people** receiving issuances. The July household context remains supplemental JSON metadata (`comparisonsPublic`), because households are a different unit and are not an input to that person-based series. It is intentionally excluded from the visible chart and chart exports; do not combine the two units or imply a household year-over-year series.

## Source and display integrity checks

1. **Definitions:** Each metric has an explicit population/unit, geography, reporting period, original agency series, checked date and scope. Avoid comparing differently defined data as if one denominator. Source examples: distinct state-administered FamilyCare/SNAP data must not be merged with ACS population survey data, and DCA property tax averages must not be merged with differently calculated Treasury averages.
2. **Time:** No 2026 partial-year total is compared with full-year 2025; no 2024/2025 uninsured trend; no unadjusted chronic absenteeism 2023–24/2024–25 trend across the rule break. Historical zero means actual observed zero where applicable; missing is not zero.
3. **Charts:** Absolute-magnitude bars start at zero. Signed precipitation, temperature and SNAP changes use explicit zero/reference. Graduation plots **percentage-point change** since 2022, with the 90.9% absolute baseline printed, rather than a misleading cropped 90–92% absolute rate axis. Budget treemap areas encode exactly reconciled appropriations, not arbitrary visual card sizes.
4. **Uncertainty:** Current ACS income/rent/uninsured estimates carry **90%** sampling margins in data tables/graphics, and no uncomputed statistical-significance conclusion is claimed.
5. **Export lineage:** CSV/JSON/HTML/SVG/PNG must preserve the same source-row units, dates and selected view. The source metadata `seed.asOf` is advanced to **2026-11-09** on the integration branch, while each figure retains its own latest checked date (older dates correctly remain older).
6. **No misleading causality:** Federal SNAP policy changes are shown only in a separately sourced contextual timeline; their dates do not prove the changes caused observed participation movement.
7. **Source holds:** No November voter registrations until published totals reconcile; no grade absenteeism rate until complete 2024–25 NJDOE grade records are verified.
8. **Historical freshness:** The [October 2026 BLS CPI release](https://www.bls.gov/news.release/cpi.nr0.htm) was verified after its Nov. 10, 8:30 a.m. ET publication. Table A reports no October all-items annual rate because October 2025 indexes are unavailable. The [BLS metro chart notice](https://www.bls.gov/charts/consumer-price-index/consumer-price-index-by-metro-area.htm) confirms that most October annual comparisons cannot be produced. Retain the labeled September metro/U.S. annual comparison; do not substitute monthly changes or estimate a missing annual rate. Check all figure dates during final deployment review.
9. **Accessibility:** Validate default/toggle controls with keyboard, accessible labels, adequate focus styles, readable source values, scrollable mobile data tables, and source attribution in exports.
10. **Rendering:** A passing typecheck/reader test does not replace headed desktop, mobile and export visual inspection. Confirm non-overlapping labels, marks and tooltips and all 18 navigable/visible metric cards after final integration.

## November 10 review follow-up

- Baseline head `0f6b3314` passed hosted CI run 42760228466: Policy, Docs, Site and required `ci`; the Site unit stage reports 6,206 passing tests in 421 files.
- The three standalone HTML owners for SNAP, graduation and metro CPI now reuse the shared screen-reader-only style. Three new regression cases failed before the fix and pass afterward; all 31 focused reader tests pass.
- Compared 72 default CSV/JSON/HTML/SVG exports before and after: only those three HTML outputs changed. Source JSON and every CSV/JSON/SVG output are unchanged.
- These are focused reader/export checks. The downloaded CI preview omits `/data-hub/`; local reader fixtures do not prove the full public route or replace the outstanding editorial, headed desktop/mobile, keyboard, PNG and selected-view export matrix.
- This follow-up changes the PR head and requires fresh hosted CI and an independent review of the new head. The PR remains draft; no merge, deployment or source-hold clearance is implied.

### Additional image-export verification

Headed QA found malformed nested SVG attributes in both graduation and metro CPI image exports, which also prevented PNG conversion. The export owners now preserve the required attribute separator. Two additional regression cases parse both default and alternate SVG views with a strict XML parser; all **39 focused reader tests pass**. Actual browser downloads of the metro history and graduation student-group PNGs succeeded after the repair. These checks do not complete the full-route or all-figure visual matrix.

### Final review repairs in the stacked follow-up

The follow-up also addresses the review on parent head `e277583e1`: the 2025 rent JSON uncertainty note now agrees with the verified **±$19** margin, regional rent axis labels fit within the SVG viewport, and graduation/rent source links use the shared HTTPS-only guard. The comparison-URL regression now exercises the industry comparison renderer and proves that its valid link exists before testing an unsafe replacement.

A shared chart palette preserves readable text on white standalone HTML and on dark reader/image surfaces for SNAP, graduation, rent and metro CPI. Regression checks enforce at least 4.5:1 text contrast in both export contexts. Rent uncertainty marks use contrasting inner and outer strokes, tested at 3:1 against both the bars and chart background. Browser downloads of graduation groups and regional rent PNGs were inspected after repair; regional rent HTML also downloaded successfully. The 72 default-export comparison permits only the intended HTML/SVG changes and rent JSON metadata correction; every CSV and all other JSON downloads remain unchanged. The only source-payload change is the rent uncertainty note. Absenteeism, voter-registration holds, values, source series and reporting periods remain unchanged.

Keep both PRs draft. This stack contains a blocking metadata repair for the parent and must be reviewed and incorporated into the consolidation before #5052 can be considered for merge; do not land the parent first with the known mismatch. The resulting consolidated head needs fresh CI and independent review, followed by explicit merge/deployment authorization.

## Reader navigation follow-up

A labeled **Back to top** button appears after readers scroll beyond the first
screen. It stays at the lower right, returns immediately without animation, and
moves keyboard focus to the page heading. Custom CMS compositions without a
visible introduction use the main landmark as the focus destination. The control
uses the existing button and focus styles, a 44 px target, and mobile safe-area
spacing. It stays outside the composable content and is hidden without JavaScript.

Desktop and 390 px viewport checks confirmed visibility while scrolling and
immediate return with Enter and Space. All 39 focused reader tests pass. Source
and editorial JSON remain byte-for-byte unchanged. This local preview check does
not replace final CMS route QA, hosted CI, independent review or release approval.

## Pre-publication release gates

- [ ] PR #5052 has green Policy and Site CI, and the branch is mergeable against current `main`.
- [ ] Run full data-hub-reader tests and visually check all default/optional views plus PDF-free static exports (SVG/PNG/HTML/CSV/JSON) on desktop and narrow viewport. Review any pending/failed checks.
- [ ] Verify 2024–25 *grade-by-grade* NJDOE chronic absenteeism data from the authoritative school performance database (issue #5044); don't claim all 18 fully ready until addressed.
- [ ] Resolve November 2026 registration discrepancy or explicitly retain reconciled October values and mark delayed November update (issue #5025).
- [x] Recheck the Nov. 10 October BLS publication: the needed annual comparison is unavailable because October 2025 indexes are missing. Retain the labeled September metro/U.S. annual rates; no fabricated or mixed-window October update.
- [ ] Finish optional 12-month industry table and determine whether unemployment NJ and U.S. can be displayed as a **same-method** time series; avoid cross-program blending.
- [ ] Recheck property-tax DCA source provenance and preserve its definition.
- [ ] Confirm deployment target and authorize merge/deploy only after independent release approval; **this audit is not authorization to deploy**.
