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
time the tab stays visible, your account ID and role, and two named actions:
a content publish attempt and a saved Preview attempt. An action includes only its
object type and saved ID. A publish count does not confirm that a public release
finished, and a Preview request does not prove that someone viewed it.

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

Usage analytics adds the same aggregate counts for staff with Reports access: active
staff per day and calendar week, destination views, visible time and named
actions. This first version does not display anyone's individual activity.

The tables include only the instrumented destinations and actions. A zero
means no collected use in the selected period; time before usage analytics began is
not evidence that a tool is unused. Dates use UTC and today is incomplete.
Weekly counts cover Monday to Sunday; a person counts once in each week.

Visible time can include idle time. Hidden tabs do not add time. Browser closure,
an interrupted connection or a dropped background delivery can lose events.
These reports cannot establish that someone stalled, retried or gave up.

## Storage and retention

Raw events and temporary distinct-account markers stay in our own Firestore
storage and expire after 180 days. Automatic deletion can take additional time
to finish. Only aggregate counts remain after deletion; those counts contain no
account or content IDs. Browser accounts cannot read raw events directly.

Use **Report a problem** for a specific workflow or privacy concern.
