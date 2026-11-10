---
title: API access and integrations
description: "Understand the CMS API connection boundary, supported work, authentication, and current integration limits."
---

## Connection status

Configure the Boardwalk HTTPS API origin as `CMS_API_ORIGIN`. Its health route
accepts `GET` and `HEAD`:

```bash
: "${CMS_API_ORIGIN:?Set the configured HTTPS API origin}"
curl --head "${CMS_API_ORIGIN%/}/health"
```

CMS operations use `POST`. Most accept and return JSON. Media uploads and
problem reports use multipart form data. The edge limits request sizes and
request rates. Each response includes an `X-NJPBS-Request-ID` value that can
connect a client error to the matching service event.

The current API supports the Boardwalk application. It is not a general
public content API. Production browser requests are accepted from
`https://admin.njpbs.org` and approved Admin preview origins. A browser
application on another origin cannot connect through cross-origin requests.

## Authentication and authorization

Protected operations require a current Firebase staff ID token in the
`Authorization: Bearer <token>` header. Some account flows also require a
Firebase App Check token. The server reads the staff account, role, area
grants, and active state for each request. A token does not give access beyond
the capabilities assigned to that account.

The API does not currently issue integration API keys, service accounts,
personal access tokens, or OAuth client credentials. Do not automate a client
by storing a staff password or copying a browser token. A long-running or
server-to-server integration needs a reviewed machine-identity and access
design before it connects.

Direct requests to the Firebase Function origins are refused. Clients use the
CMS API hostname so the edge can apply request validation, origin rules, rate
limits, and request receipts before the Function applies its authorization and
data rules.

## Current capabilities

Available actions still depend on the caller's permissions and the state of the
record.

| Area                    | API capabilities                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editorial content       | List and read authorized pages and posts; create or save drafts; assign work; inspect and restore revisions; move records through review and release states; archive records in bounded batches. |
| Preview and publication | Request an exact-draft preview, check preview status, publish approved content, and publish supported global settings. A `runtime_confirmed` response proves the exact version is public. A queued response confirms acceptance; it does not prove the fallback build started or finished. |
| Media                   | List authorized assets and categories; upload one image or document; edit metadata; maintain managed categories; check asset use before a lifecycle action.                                      |
| Settings                | Read, save, and publish supported Newsroom settings, including public homepage and Newsroom banner values.                                                                                       |
| Staff access       | Request staff access; administer approved roles and area grants; maintain author profiles and bylines.                                                                                          |
| Evidence and support    | Read authorized activity records; submit problem reports; manage the report queue; use request IDs, conflict responses, and rate-limit headers during support.                                   |

The public website receives released CMS content through controlled publication
artifacts and a private Cloudflare service binding. There is no unrestricted
REST route for reading all published CMS records.

Released Post items in the version 1 JSON and RSS feeds keep ordered categories
and tags as separate taxonomy. The first category is the main category shown on
the Post page. RSS uses a distinct `domain` value for content type, category,
and tag elements so a connector can keep those values separate.

After a queued publish request, check the release status and the public URL
before you describe the change as live. A `runtime_confirmed` response already
contains the exact public source-version receipt.

## Before adding an integration

Document these items before implementation:

1. The person or system that owns the integration.
2. The exact reads, writes, and lifecycle actions it needs.
3. The least-privilege identity and section scope.
4. The expected request frequency, payload size, and retry behavior.
5. The data that can leave NJ PBS systems and its retention period.
6. The version, conflict, duplicate-request, and audit behavior.
7. The test, monitoring, incident, credential-rotation, and shutdown plan.

An approved integration should use a documented and versioned contract. Keep
server authorization in place, add only the required browser origin if the
client must run in a browser, and preserve the API's request limits and audit
evidence.
