---
title: Boardwalk usage analytics and privacy
description: "What Boardwalk records, why it helps and how staff can read usage reports."
---

## Usage analytics starts Nov. 8, 2026

Boardwalk usage analytics collection begins Nov. 8, 2026, following the staff notice.
No one needs to enable anything in their account.

## Why measure usage

Usage helps us improve the destinations and tools staff rely on and reconsider
features with few collected uses. It is not a productivity score.

Usage analytics includes the destination you open, approximate
time the tab stays visible, your account ID and role, about when each event
happened, and these named actions:

- Content publish, schedule and saved Preview attempts. These include only the
  object type and saved ID.
- Failed content saves, including failed publish and schedule saves.
- Upload starts, finishes and failures.
- Transcript and clip requests.
- Searches. When you start typing in a search box, Boardwalk records that a
  search happened, never what you typed.

Destinations separate the Posts and Pages lists from their editors, and the
Media landing from favorites, collections and public submissions. Counts from
before this split appear on their own combined rows.

A publish count does not confirm that a public release finished, and a Preview
request does not prove that someone viewed it.

Boardwalk records no keystrokes, field values, draft text, file contents, full
addresses or search terms. There is no session replay or third-party product
analytics. Agent and test accounts are excluded.

## Read the report

Open **Reports** in the rail, then **Boardwalk usage analytics**. Choose the last 7, 30 or
90 days. Existing activity logs supply aggregate counts of accepted sign-ins,
publish requests, Preview jobs, media items added and problem reports. These
totals are available before new collection starts and do not contain content
or person details. They cover retained staff accounts and exclude marked agent
and test accounts, unknown accounts and system activity. Media additions include
approved submissions. Problem reports can include automatic tool reports.
Requests and jobs do not prove completion or a view. This history is retained
under the existing activity-log policy; the 180-day limit below applies to
new analytics events and temporary distinct-account markers.

Usage analytics adds aggregate counts for staff with Reports access. Each
count is split between the newsroom and the product team (owner-level
accounts):

- Active staff this week, last week and today, and average visible minutes per
  session.
- Active newsroom staff per day as a chart with a daily table, and distinct
  people per calendar week by role.
- Activity by role: roster, active people, sessions and visible minutes.
- Newsroom visible minutes by Eastern hour and weekday.
- Destinations and features: views, uses, visible time and person-days. A
  person-day counts one person once per destination or feature per day.
- Friction compared with the previous period: repeated publish or Preview
  attempts on the same item within 10 minutes, failed and expired Preview jobs,
  moves straight back to the previous screen, and uploads left active over a
  day.
- Content flow: posts first published per week, the median time from creating a
  post to first publishing it, and open post drafts by age.
- Problem reports: open reports, the median time to resolve and the pages
  reports come from.

The report shows counts only. It does not display anyone's individual
activity, names, content titles or report text. To count distinct people,
Boardwalk keeps a temporary marker for each account with a scrambled account
ID, its access level and the last day it was active.

The tables include only the instrumented destinations and actions. A zero
means no collected use in the selected period; time before usage analytics began is
not evidence that a tool is unused. Dates use Eastern time and today is
incomplete. Days collected before the switch to Eastern time stay keyed by UTC
date, so work after 7 or 8 PM on those days appears on the next day. The report
marks those rows UTC and shows the switch date. Weekly counts cover Monday to Sunday; a person counts
once in each week.

Visible time can include idle time. Hidden tabs do not add time. Browser closure,
an interrupted connection or a dropped background delivery can lose events.
These reports alone cannot establish that someone stalled, retried or gave up.

## Storage and retention

Raw events and temporary distinct-account markers stay in our own Firestore
storage and expire after 180 days. Automatic deletion can take additional time
to finish. Only aggregate counts remain after deletion; those counts contain no
account or content IDs. Browser accounts cannot read raw events directly.

Use **Report a problem** for a specific workflow or privacy concern.
