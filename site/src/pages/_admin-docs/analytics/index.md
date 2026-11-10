---
title: Analytics
description: "Assess story reach, reader attention, referrals, and website delivery."
---

## Start with a newsroom question

<figure class="admin-docs-video">
<video controls preload="none" playsinline width="1280" height="720" poster="/guide-content/videos/analytics.jpg" aria-label="Read site analytics" src="/guide-content/videos/analytics.mp4">
<track kind="chapters" src="/guide-content/videos/analytics.vtt" srclang="en" label="Chapters" default></track>
</video>
<figcaption>Read site analytics. <a href="/guide/video-tutorials#read-site-analytics">Open this video in the tutorial list</a>.</figcaption>
</figure>

<details><summary>Transcript: Read site analytics</summary>
<p>Descriptive guide. The video has interface sounds, optional instrumental music, and no spoken narration.</p>
<p><strong>Title</strong></p>
<p>The NJ PBS logo and &quot;Read site analytics&quot;. The opening includes a screen preview, duration and step count.</p>
<p>Outcome: &quot;You read audience, trend and delivery reports for a chosen period, then export them.&quot;</p>
<p><strong>Overview: Open Analytics from the rail</strong></p>
<p>Analytics sits under Administration and appears only for admins and super admins.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Analytics, under Administration&quot; and &quot;Opens audience, newsletter and website delivery reports on one page.&quot; The pointer clicks it, and the next page opens.</li>
</ul>
<p><strong>Step 1 of 6: Choose a reporting period</strong></p>
<p>Every report on the page uses the same complete days, so today never skews totals.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Reporting period&quot; and &quot;Pick 7, 30 or 90 complete days.&quot; The pointer opens the list and chooses &quot;Last 30 complete days&quot;. The result callout says &quot;Dates and time zone for this source&quot; and &quot;GA4 uses its property time zone; Cloudflare uses UTC.&quot;</li>
</ul>
<p><strong>Step 2 of 6: Read the audience summary</strong></p>
<p>Four totals show reach and attention, each compared with the period before.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Info button explains each metric&quot; and &quot;Hover, focus or tap it.&quot; The pointer rests on it. The result callout says &quot;What counts as an engaged visit&quot; and &quot;Over 10 seconds, a key event, or two page views.&quot;</li>
</ul>
<p><strong>Step 3 of 6: Switch the trend metric</strong></p>
<p>The trend chart can show active users, visits or page views for each day.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Visits&quot; and &quot;Redraws the daily chart for visits instead of active users.&quot; The pointer clicks it.</li>
</ul>
<p><strong>Step 4 of 6: Open the daily figures</strong></p>
<p>The table lists every day's value, readable with a keyboard or screen reader.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;View daily figures&quot; and &quot;Opens a table of dates and values under the chart.&quot; The pointer clicks it. The result callout says &quot;One row per day&quot;.</li>
</ul>
<p><strong>Step 5 of 6: Check website delivery</strong></p>
<p>Cloudflare counts requests, including bots and files, so never add them to GA4 readers.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Jump to one report&quot; and &quot;Skips to site audience, newsletters or website delivery.&quot; The pointer clicks it. The result callout says &quot;Watch server errors for spikes&quot; and &quot;A rise in errors is the signal to investigate.&quot;</li>
</ul>
<p><strong>Step 6 of 6: Refresh or export the report</strong></p>
<p>Refresh checks for newer numbers; the export keeps a copy with its reporting dates.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Refresh&quot; and &quot;Checks the sources again after a connection fix.&quot; The pointer clicks it. The result callout says &quot;Reused for up to 10 minutes&quot;.</li>
<li>A callout says &quot;Export summary CSV&quot; and &quot;Downloads the totals with their dates.&quot; The pointer clicks it.</li>
</ul>
<p><strong>Tip: Unavailable is not zero</strong></p>
<p>Each source reports on its own, so one missing source does not mean the others failed.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;GA4 shows its status, not zeros&quot; and &quot;The other reports still load.&quot;</li>
</ul>
<p><strong>Recap</strong></p>
<p>&quot;Analytics basics&quot;. Result pictures and confirmation marks accompany these points:</p>
<ol>
<li>Pick complete days</li>
<li>Read the audience summary</li>
<li>Switch the trend metric</li>
<li>Open the daily figures</li>
<li>Check website delivery</li>
<li>Refresh or export</li>
</ol>
<p><strong>End</strong></p>
<p>The NJ PBS logo and &quot;More help: open the Boardwalk guide from Home.&quot;</p>
</details>

Open **Analytics** in the navigation rail. This workspace is for Managers and super
Managers. Use Overview, Content performance, Audience, Newsletters, and Website
delivery to follow one report without another provider request. Choose 7, 30, or
90 complete days. Each source shows its actual dates and time zone. **Refresh**
checks the report again; the server can reuse a recent report for ten minutes.
**Export report** downloads available source data with dates and coverage. Content
performance also exports the filtered page rows.

Each source reports its own connection state. An unavailable source displays its
status, not a zero audience. Other available sources remain usable. The GA4
comparison control changes supported aggregate totals only; it does not create
a previous-period chart. Report scheduling is not available in this workspace.

<details>
  <summary>View a dashboard example</summary>
  <figure class="admin-docs-screenshot">
    <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
    <figcaption><strong>Synthetic local example.</strong> All figures are sample data. The gallery fixes this example at 30 days; the connected workspace supports 7, 30, and 90 days. <span class="admin-docs-image-note">Select the image to enlarge it in a new tab.</span></figcaption>
  </figure>
</details>

| Question | Use | What to check before acting |
| --- | --- | --- |
| Which stories reach people? | Page views and active users by page | Compare similar publication windows. Repeated views are not additional people. Service pages appear alongside stories. |
| Which reporting holds attention? | Engagement time per active user | GA4 measures time with the page in focus. This is not a full-read or video-completion measure. |
| Which distribution work brings engaged readers? | Channels, source/medium, and landing pages | Compare engaged visits as well as visit volume. Consistent campaign tags improve newsletter and partner attribution. |
| Is site reach changing? | Daily active users and previous-period comparison | Daily users cannot be added to get unique people for the period. News cycles, tracking consent, and publication volume affect changes. |
| Is the site serving readers reliably? | Cloudflare server errors, response status, and cache performance | Requests include bots and files. An error count alone does not establish how many people were affected. |

## Interpret GA4 carefully

**Active users** is GA4's active-user measure. **Engaged visits** are sessions that
meet GA4's engagement rule: a duration above the property's threshold, a key event,
or at least two page/screen views. The usual time threshold is 10 seconds, but a
property can change it. **Engagement rate** is the share of sessions that qualify.

Page engagement per user divides the page's reported engagement seconds by its
active users. The page list is ranked by views, not by public-service value.
The event list shows actual recorded event names. A click on Donate is not proof
of a completed donation. A visit to Live is not proof of watching the stream.

Consent choices, blockers, processing delays, and GA4 privacy thresholds can affect
the report. GA4 uses its property time zone. The current report includes only
`njpbs.org` and `www.njpbs.org`; off-site video and partner websites are outside
that scope. Country data does not measure New Jersey broadcast coverage.

## Interpret Cloudflare separately

Cloudflare reports requests reaching the public website hosts, including bots,
images, scripts, and other files. These are not readers or broadcast viewers.
Cloudflare uses UTC dates and may estimate counts through sampling. The dashboard
shows the available date range if the selected period exceeds retained history.

Use server-error and response-status counts to investigate website delivery. Cache
hit rate helps explain delivery behavior. Data delivered is not a billing total.
Do not add Cloudflare requests to GA4 users or page views.

## Measurement still needed

Broadcast ratings, verified video completion, newsletter conversion, completed
donations, and returning-reader loyalty need their own confirmed source and
measurement definitions. They are not inferred from traffic. Use the relevant
source system until a verified measurement is available in Boardwalk.

## If data is missing

Read each source's message. One unavailable source does not mean the other failed.
Use **Refresh** after a connection issue is fixed. If the problem remains, report
the source, selected period, and visible message. Do not send credentials.

## Read the charts

The audience trend shows active users, visits, and page views together. Hover,
tap, or focus the chart and use arrow keys to inspect a date. Open **View daily
figures** for the complete numeric table.

Channel bars show total visits in blue and engaged visits in green. Both counts
are labeled. The regional list ranks reported U.S. states and regions from
approximate GA4 location; no geographic map is connected. Delivery charts use
blue. GA4 changes have signed labels as well as color.

The small info button beside a metric opens its definition by keyboard or touch.
Press Escape to close it. Reporting
dates, connection errors, and shortened data ranges remain visible.

## Follow the newsletter audience

Use **Newsletters** to see reports for the configured newsletter audience.

**Subscribed audience** is the current total. The audience-growth chart shows
month-end subscriber totals for completed months, separate from the chosen
campaign period. It does not count new signups for that period.

Campaign results cover emails sent within the selected complete UTC days.
Delivered means sent minus hard and soft bounces. Click rate uses unique clicking
subscribers within each campaign and delivered emails. A person can be counted
in several campaigns; totals are not deduplicated across sends. The report shows
at most the 20 latest campaigns and warns if that limit omits more campaigns.

Use click activity to compare similar newsletter segments and send schedules.
**Opens (est.)** can be inflated by Apple privacy features. Bots and security
scanners can also affect clicks. Neither measure proves a full story read.
Subscriber names, email addresses, and individual activity are not shown.
