# Public Post and Page reading audit

Seven published pages were checked in Chromium on November 22, 2026. The samples cover news stories, long references, embedded media, election updates and time-sensitive service information.

## Published samples

Lengths are approximate visible word counts inside the article or main content at 1280 CSS px. Counts include headings, labels and controls. Embedded content is outside the count.

| Format | Structure and media | Desktop and phone observations |
| --- | --- | --- |
| Report with practical instructions | About 1,100 words, a lead photo and two story sections. [Property tax relief](https://njpbs.org/posts/application-deadline-for-nj-property-tax-relief-is-days-away-dont-miss-out/) | The first desktop prose block was 960 CSS px wide at 20 px text. At 390 px, magnified prose wrapped in one column. The two authored headings already provide scanning points. |
| Interactive map brief | About 110 words, a lead figure and two titled iframe embeds. [Municipal data center maps](https://njpbs.org/posts/map-over-100-nj-municipalities-have-passed-local-bans-on-data-centers/) | The desktop and phone page shells fit their viewports. The iframes have separate reading orders. The printed copy had a page with no extractable text between the cover and final page. Put the finding and source beside the map so readers can use them independently of the embeds. |
| Video-led news brief | About 100 words, one titled player iframe and a short description. [Newscast](https://njpbs.org/posts/beach-erosion-ballots-bailouts/) | The first prose block was 400 CSS px wide on desktop and 358 px at a 390 px phone width. The player stayed present in the print layout. The headline and published description name different topics. Verify that the text path describes the program served by the player. |
| Rolling coverage | About 1,100 words, one updates section with individual headings, inline photos and per-update actions. [Election updates](https://njpbs.org/posts/live-updates-blog-election-results-new-jersey-nj-decides-2026/) | Update headings were exposed inside named articles in the accessibility tree. On a phone, reaching an older item takes scrolling or an individual update link. Keep each update's heading, time and correction with its text. |
| Policy and help references | About 340 and 550 words, six and four named sections respectively, and no embeds. [Privacy policy](https://njpbs.org/privacy/) and [Accessibility statement](https://njpbs.org/accessibility/) | The first prose block could occupy 1232 CSS px on desktop at about 16 px text. On the phone, readers scroll through several topics to get to choices or contacts. A narrower text column would help desktop readers follow long lines. A short section index would help readers reach a specific topic. |
| Time-sensitive service | About 940 words, with Now, Next and the full broadcast day, plus per-program controls. [TV schedule](https://njpbs.org/schedule/) | The schedule has task-specific navigation. Its button names include the program and time. The print capture retained the full broadcast day across four pages. |

These observations are advisory. The wide text columns and section navigation concern reading comfort. Print output and the newscast's title and description concern access to editorial information. Use the separate accessibility review to assign success criteria and severity to confirmed barriers. [Accessibility plan](accessibility-plan.md).

## Rendered studies

Open [the two HTML studies](public-reading-studies.html) in a browser. They use sample copy and can be viewed offline.

1. **Reference page with section links.** A short index follows the introduction. Each native fragment link focuses the matching heading. The page limits desktop line length and stacks at phone widths. Print keeps the headings and text in sequence and removes the index.
2. **Video-first Post with a text path.** A reader can jump past the video slot to the on-page summary. Both links lead to headings in the study. A production layout can place an approved transcript with the summary when one is available. Print keeps the summary and omits the video slot and actions.

Use a section index where meaningful headings support scanning. Offer an adjacent text path where video or an interactive embed carries the story. Keep the existing Schedule controls with the schedule.

## Reading and print checks

- **Reflow and text enlargement.** At 1280, 640, 390 and 320 CSS px, each sampled document stayed within its viewport. The 640 and 320 px desktop widths approximate the CSS layout space available at 200% and 400% zoom from 1280 px. A separate 390 px mobile text adjustment doubled the measured prose from 20 to 40 px on the relief report and the election coverage. The same adjustment did not double every measured paragraph. Keep browser zoom available alongside the reader size chooser. [W3C Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) and [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
- **Order and controls.** Keyboard activation of Skip to content focused the main landmark on all seven samples. Browser accessibility snapshots exposed section headings, schedule program controls and the named update region. The studies kept controls in document order and moved keyboard focus to the intended heading at widths from 320 to 1280 px. Screen-reader speech and third-party embed controls still need separate checks before adopting a production layout. [W3C Meaningful Sequence](https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence.html).
- **Print.** Chromium generated tagged Letter PDFs. Text extraction found the later story section, contact section, privacy choices, live updates and full-day schedule. The studies printed the text in order on one page and omitted the section links and playback actions. The map and video samples show why captions, summaries and sources need to survive separately from players and embeds.
