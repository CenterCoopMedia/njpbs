# Municipal election trends

The Town election lookup covers a decade of November general elections for 564 municipalities. All figures are in the browse table before JavaScript runs. The town search adds a chart and a town-specific table with links to the exact reports. The lookup also shows the existing map and the 2024 U.S. Senate and House comparisons.

## Sources and reuse

- The New Jersey Division of Elections publishes the official election returns. Use the municipality breakdowns in each county's president reports for 2016, 2020 and 2024 and governor reports for 2017, 2021 and 2025. Use the county tables for 2016 through 2025 for registration and ballots cast. [Official election results archive](https://www.nj.gov/state/elections/election-information-results.shtml) · [Registered voters and ballots cast archive](https://www.nj.gov/state/elections/election-information-ballots-cast.shtml)
- The snapshot contains transcribed numerical facts and derived totals. The U.S. Copyright Office identifies facts as outside copyright protection. New Jersey allows copying state information subject to any specific restrictions and disclaims a warranty against copyright and trademark claims. The original PDF layouts, graphics and text are available at the source links. The repository's MIT grant excludes externally sourced election data. [U.S. Copyright Office Compendium § 313.3(C)](https://www.copyright.gov/comp3/chap300/ch300-copyrightable-authorship.pdf#page=24) · [New Jersey website legal statement](https://www.nj.gov/nj/legal.shtml) · [Repository notice](../../NOTICE)

## Geography and denominators

- Match each county-qualified municipality from the source reports to the lookup's NJ municipality code. The state consolidated Pine Valley Borough into Pine Hill Borough on January 1, 2022. For 2016–2021, add the two source rows' counts before calculating percentages for Pine Hill. From 2022 onward, use the published Pine Hill row. Other values use the municipality as reported in the applicable election. The map uses the lookup's present-day boundaries. [New Jersey Assessors Handbook, page 42](https://nj.gov/treasury/taxation/pdf/assessorshandbook.pdf) · [NJ Office of GIS boundaries](https://www.nj.gov/njgin/edata/boundaries/)
- Each party's vote share is its candidate's votes divided by the sum of the published candidate counts in the municipality's row. This includes third-party and independent candidates. The denominator excludes write-ins that the municipality table does not report and separate countywide rows, such as overseas totals and hand counts, that the report leaves unassigned to a municipality.
- Turnout is the reported number of ballots cast divided by the reported number of registered voters in that municipality's row. Countywide rows stay unassigned. The chart and table use the same ratios and display table values rounded to one decimal point. They distinguish a year without either selected office, an unavailable value, and a reported zero. Tavistock in 2019 has zero ballots cast and six registered voters. [2019 Camden County turnout](https://www.nj.gov/state/elections/assets/pdf/election-results/2019/2019-general-election-ballotscast-results-camden.pdf)

## Snapshot and verification

`nj-town-election-trends.json` has ten entries per municipality in ascending year order. Each entry contains `[Democratic votes, Republican votes, total candidate votes]` or `null`, then `[registered voters, ballots cast]` or `null`. An optional third pair lists the county clerk report URLs when those records supply a corrected value. The default source map uses the first two digits of the municipality code and the same year order. It lists the state race and turnout PDF filenames in that order. [Election trends snapshot](../../packages/content-core/data/nj-town-election-trends.json)

We matched the 336 state county PDFs to the lookup roster, including the pre-2022 Pine Valley rows. Candidate columns reconcile to the printed county totals when unassigned countywide rows are included. The major-party totals match the statewide official returns by county. We compared registration across years and checked that ballots cast covered candidate votes. These checks caught errors that leave county totals unchanged. The snapshot uses independently confirmed county figures where available and labels unresolved values unavailable.

| Report | Municipal data correction |
| --- | --- |
| 2021 Atlantic | The county clerk's public-count table gives Hamilton Township 8,255 ballots and Hammonton 5,145. [County canvass, page 5](https://www.atlanticcountyclerk.org/wp-content/uploads/2021/12/2021-General-Election-Official-Results.pdf#page=5) |
| 2025 Burlington | Summing district totals and municipal provisional totals verifies turnout and all four governor candidates for Medford Township and Medford Lakes. The state report transposes turnout rows and minor-party votes. [County canvass, pages 33–37, 70, 683–764 and 1387–1404](https://www.burlingtoncountynj.gov/DocumentCenter/View/22857/2025-Statement-of-Votes-Cast-Report-PDF#page=33) |
| 2025 Camden | County governor totals identify the correct rows for Haddon Township, Haddonfield and Haddon Heights. [County canvass, PDF page 211](https://www.camdencounty.com/wp-content/elections/general2025/2025_General_Election_Canvasser.pdf#page=211) |
| 2023 Morris | The county clerk's summary gives turnout denominators of 3,681 for Mountain Lakes and 4,888 for Mount Arlington. [County canvass, pages 46 and 50](https://www.morriscountyclerk.org/files/sharedassets/clerk/v/5/elections/past-results/2023-general-municipality-report-official.pdf#page=46) |
| Unavailable governor vote shares | Neptune Township and Neptune City in 2017. Woodbury, Woodbury Heights, Shiloh, Far Hills, Green Brook and Millstone in 2021. Those records conflict with published registration or ballots cast. [State election returns](https://www.nj.gov/state/elections/election-information-results.shtml) |
| Unavailable turnout | Saddle Brook and Saddle River in 2019. Woodbury and Woodbury Heights in 2021 and 2022. Shiloh, Far Hills, Green Brook and Millstone in 2021. Little Silver, Loch Arbour, Lake Como, Ocean Township in Ocean County, Ocean Gate, Point Pleasant and Point Pleasant Beach in 2023. [State turnout archive](https://www.nj.gov/state/elections/election-information-ballots-cast.shtml) |

The state reports below have turnout totals that differ between the printed rows, the printed county totals or the statewide summary. Countywide differences stay unassigned.

| Report | Ballot count difference |
| --- | --- |
| 2016 Middlesex | County total is 88 below the sum of the printed rows, including its countywide row. |
| 2017 Monmouth | County total is 239 below the sum of the printed rows, including its countywide row. |
| 2018 Sussex, 2023 Passaic and Sussex, 2024 Camden | Printed county count is 33, 74, 11 and 482 above the municipality rows respectively. |
| 2019 Monmouth | The statewide summary lists 133,646 ballots; the county table totals 132,869. |
| 2022 Somerset | The statewide summary lists 118,909 ballots; the county table totals 119,329. |

Source spellings sometimes differ from the lookup. For example, the 2016–2019 Ocean County turnout reports label Stafford Township “Stratford Twp.” Stafford is the only roster entry missing from those tables, and the reported row falls between South Toms River and Surf City. The named Stratford Borough is in Camden County. [2016 Ocean County turnout](https://www.nj.gov/state/elections/assets/pdf/election-results/2016/2016-gen-elect-ballotscast-results-ocean.pdf) · [New Jersey municipality codes](https://www.nj.gov/treasury/omb/pdf/forms/municodes.pdf)
