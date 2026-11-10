# Staff access contract

The Admin authentication shell is public. Access to CMS records requires a
verified, active, authorized Firebase identity. Deployment, reader activation
and account migration are separate operations with separate authorization.

## Account request and approval

1. Create an email/password identity and verify its email. Account-request
   endpoints require App Check and apply independent account/IP budgets.
2. Submit the access request. Before approval it has no `users/{uid}` CMS
   profile and no CMS authority. Verified status moves `email_verification` to
   `pending` only when the current Firebase token says the email is verified.
3. An authorized reviewer approves or denies through Staff access. Approval
   uses existing role choices; it does not silently migrate an account to tiers.
4. Verify the active profile, expected powers and refused higher powers with
   the actual session. Do not infer authorization from an email notification.

Direct browser access to requests, cooldowns, email and notification outboxes
is denied for every role, including the highest administrator. Password-reset
responses remain enumeration-safe. Never expose action links in issues or logs.

## Delivery and recovery

| State | Meaning | Action |
| --- | --- | --- |
| `pending` | Durable work awaiting claim or known-safe retry | Allow the existing worker to claim it. |
| `sending` | An in-flight delivery lease | Do not send a concurrent replacement. |
| `sent` / `delivered` | Provider result recorded | Do not repeat it. |
| `failed` / `terminal_failed` | Named permanent/configuration fault | Fix the fault before a separately authorized retry. |
| `unknown` | Ambiguous provider outcome or expired sending lease | Check actual delivery first; automatic retry could duplicate it. |
| `invalid_request` | Invalid notification | Never retry by editing it into valid work. |

Email retries cover known temporary provider errors, at most five times.
An unknown network result or expired lease becomes `unknown`. Notification
creation makes the first attempt; the scheduled delivery worker recovers
known-safe retries. Deterministic rows prevent repeated events/requests from
duplicating accepted delivery.

Resend does not replace pending, sending, unknown or recently sent rows. The
15-minute cooldown starts at `sentAt`, or legacy `createdAt` when no send time
exists. An active preparation reservation returns `preparing`, not sent.
After cooldown one new action link can replace a delivered row; transaction
reservations prevent concurrent link generation. Throttling preserves recovery.

A manual notification retry uses the exact request reference, in this order:
verify the approved private destination; search it for the exact reference;
stop if a message exists; find the one deterministic outbox row; retry only an
unknown confirmed-absent delivery or a repaired terminal failure. Preserve ID
and applicant fields. Set only `state=pending`, `attemptCount=0`, current
`nextAttemptAt`/`updatedAt`, null `leaseUntil` and null `lastError`. Let the
existing delivery worker claim it and require `delivered`. A repeated unknown
or terminal result stops further edits for investigation.

Normalized-email alert suppression lasts 24 hours. The review queue remains
authoritative for requests without another immediate alert. Hashed cooldown
keys expire through the existing two-day TTL; do not disable that retention.
Notification destination values and applicant mapping remain private configuration.

## Whole-site levels

| Level | Adds | Excludes |
| --- | --- | --- |
| Viewer | Read non-admin destinations/templates and all shared media, including images, documents, station audio and video; media comments | Content changes, shared transcript edits, upload, publication |
| Contributor | Own draft/create/preview/submit and media management | Editing another person's content, publication |
| Editor | Edit all content and review submissions | Publication, withdrawal, content deletion |
| Publisher | Publish, unpublish and delete content; approve datasets | Administrative controls |
| Admin | Settings, schedule, member/analytics reads, staff profiles/directory and audit reads | Granting access, deactivation |
| Owner | Access changes, deactivation, reactivation | Self-demotion, removal of last Owner |

Levels are cumulative and whole-site. Media membership, disabled sources,
read-only originals, lifecycle and record ownership checks still apply. They
do not introduce area grants, custom capabilities or expiry.
Compare account mappings with the actual closed capability lists in
[shared RBAC](../../packages/content-core/src/rbac.ts) and its
[server counterpart](../../functions/lib/rbac.js), not a legacy role name.

## Tier reader activation

Field protection must deploy before activating readers. Browser, Functions,
direct administrative checks and Firestore rules share the same resolver.
Without schema 1, `state: active`, `cleanScan: true` at
`system/staffAccessActivation`, a planted tier cannot change legacy authority.
An unavailable receipt read denies authorization; it does not fall back.
After activation, present valid `accessTier` wins, legacy grants add nothing,
unknown/malformed values and inactive/unverified sessions have no tier powers.
An absent field retains legacy behavior, including legacy Editor publication.
Clients cannot write the tier or activation receipt.

The operator is [activate-staff-tier-readers.mjs](../../scripts/activate-staff-tier-readers.mjs).
Run from the exact reviewed checkout in Bash with the approved service-account
JSON streamed to stdin, a clean credential environment, and explicit project.
The source supports `--check --project njpbs-site` before the separately
authorized `--activate --project njpbs-site`; both retain their rules checks.

The Rules API must show the exact protected reviewed rules before and after a
complete scan: pages of 200, only tier projection and document IDs, at most
10,000 users. Any present tier (including null), partial scan, changed rules
or existing activation receipt stops activation without editing users.
Check mode requires ready/complete, zero tier IDs and a full scanned count.
Read an existing receipt back and reconcile it; never delete it to rerun.

After separate activation authorization, the operator repeats these checks and
creates the receipt once. Read back schema/state/clean scan, activation time,
count, ruleset identity and digest; confirm the rules remain the approved
release. Existing Owners see legacy rows and level controls; Admins can read
the table without assignment controls. A deployed renderer alone proves none
of these boundaries. Keep the protected rules and receipt for rollback.

## Assignment, offboarding and reactivation

Review a fresh private per-account mapping before any migration, explicitly
including deletion, media and whole-site access increases. Deploying source
does not migrate accounts. `setStaffAccessLevel` requires a verified Owner,
an active verified target profile and the exact row state being confirmed.
Its transaction rechecks current authority/activation, replaces the tier,
clears legacy role/grants and records one before/after audit. A changed row,
self-assignment or last-Owner removal refuses.

`deactivateStaff` clears tier/roles/grants and CMS authority, audits, disables
Auth and revokes sessions. Submitting a new access request cannot reactivate
that identity. Reactivate requires an Owner, inactive profile, verified target,
active tier readers and Auth already disabled; finish Retry offboarding first.
Select one level (Viewer by default). Old roles, grants, public author profile
and shared navigation do not return automatically.

Reactivation revokes tokens before the transaction, rechecks authority, sets
active/tier with no role/grants and a forward-only token watermark, restores
the private staff/byline linkage, removes old navigation shares and writes one
audit. Both operations reread current stored state around Auth updates so a
delayed request cannot undo a newer opposite operation. Old sessions remain
refused after reactivation.

If reactivation's Auth step fails, retry the same level while its server-only
unfinished marker exists. It finishes Auth with no second audit and removes
only its own marker. An unrelated disabled active account is refused. After
reload an active row does not offer Reactivate; deactivate then reactivate if
needed. Stop assignments on any contradictory readback and preserve audits,
protected rules and activation evidence for recovery.

## Proof limits

Verify account creation, verification/resend/reset, approve/deny, Viewer reads,
Contributor own work/media, Editor without publishing, Publisher deletion and
Owner-only controls in approved sessions. Pending accounts seeing CMS data are
a security incident. Local state-machine tests cannot prove provider policy,
live email delivery, password policy or MFA; those require separate receipts.
