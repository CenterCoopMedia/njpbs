# Production branch promotion

Status: **App route untested.** This document describes the proposed switch;
committing these files applies no GitHub configuration. Activation requires
separate approval. The promotion workflow must stay undispatched until then.
Track the remaining activation work and live probes in
[issue #57](https://github.com/CenterCoopMedia/njpbs/issues/57).
The [deploy admission prerequisite](https://github.com/CenterCoopMedia/njpbs/issues/29)
merged in [PR #54](https://github.com/CenterCoopMedia/njpbs/pull/54), and the
promotion workflow merged in [PR #30](https://github.com/CenterCoopMedia/njpbs/pull/30).
Admission accepts the promotion App's `push` to `refs/heads/production` and
deploys the immutable event SHA, matching this workflow's fast-forward push.
Deploy admission is unchanged here.

The `production` branch selects a release by fast-forwarding to a green commit
already on `main`. The only trigger for `promote.yml` is `workflow_dispatch`,
with a required `sha` input of 40 lowercase hexadecimal characters. The dispatch
ref stays `main`; the input selects an immutable commit already on main. It
keeps policy scripts at the immutable main workflow revision, verifies the
selected SHA's main
ancestry and successful main-push `CI / ci` through the existing release checks,
and pushes without force. It refuses to bootstrap a missing production branch.
Later main commits cannot change the selected SHA. The run title is
`Promote production <sha>`, so API readback can verify the selected input.
The workflow run's `head_sha` identifies the main workflow revision, which can
differ from the selected source. A stale dispatch that would
move production backward fails the ancestry check or the push.

The GitHub App `ccm-njpbs-promote` (numeric App ID `5705771`) has a
selected-repository installation. On November 12, 2026, the GitHub App and
organization installation APIs confirmed exactly **Contents: Read and write**,
**Workflows: Read and write**, and **Metadata: Read**. The Workflows approval
step is complete; it permits promoting ranges that change workflow files.
The production environment, App secret, and production rulesets still need
configuration under separate activation authorization.

Keep the installation restricted to this repository. Its token may bypass
only the update lock below. Keep
history and CI protections in a second ruleset with no bypass actors: bypass
applies to a whole ruleset, so combining these payloads would let the App
bypass every protection.

## Production rulesets

Apply both payloads through the repository rulesets API or equivalent settings
at the approved switch. Both target exactly `refs/heads/production`.

The exact API payloads are [the App-only update lock](production-updates.ruleset.json)
and [the no-bypass CI/history guards](production-checks.ruleset.json). The
precheck compares the live rulesets to these files, including exact ref scope,
enforcement, bypass actors and rule parameters. Rule ordering is immaterial.

`15368` binds `ci` to GitHub Actions. CI and history rules alone do not prove
that a commit belongs to main; the environment admission and workflow source
check supply that boundary. No administrator, role, team or other App belongs
in either bypass list.

## Production environment

For the `production` environment, use
[this deployment branch policy](production-environment.json): custom branch
policies enabled and protected branch admission disabled.

Its only deployment branch policy entry must be:

```json
{"name": "main", "type": "branch"}
```

Remove other branch and tag entries. Selecting all protected branches would
also admit `production`, so it does not implement this policy.

Provision `CCM_PROMOTE_APP_PRIVATE_KEY` only as a secret of this environment,
never at repository or organization scope. Set the environment variable
`CCM_PROMOTE_APP_CLIENT_ID` to the App's public client ID; this differs from its
numeric App ID. Existing canonical repository name and numeric ID variables
must identify this repository. The workflow refuses a different repository or
workflow ref before entering its job. `CMS_DEPLOY_OWNER` must identify the owner
authorized to dispatch or rerun promotion; an ordinary repository writer cannot
use this workflow to obtain the App token.

An environment reference does not prove that the environment was configured:
GitHub can create an empty environment for a job. With no configured environment
and no App secret, a main dispatch fails closed at token creation; it cannot
push production. A missing client ID, missing secret, insufficient App
permissions, unavailable CI proof or missing production branch also stops the
promotion. There is no fallback to a personal token or a writable job token.

This route selects the production branch. Reverting a live release requires a
separately reviewed forward commit on main; promotion never rewinds production.

## Read-only precheck

Run from the repository root in a Bash session with Python 3 and authenticated
`gh`. Choose a full SHA already on main; the script accepts no default repository
or App slug. For the November 12 staging observation, the named SHA was:

```sh
python3 scripts/check-production-promotion.py --repo CenterCoopMedia/njpbs --sha cf3ac408c12afc73c3e3f355f6dd70db58ea1af7 --app-slug ccm-njpbs-promote --workflow-sha cf3ac408c12afc73c3e3f355f6dd70db58ea1af7 --admission-sha 13650ac1d8fd4e42d60afc7a859b55305ae2e52c
```

The script makes only GET requests. It prints every configuration check even
when another fails, and exits 1 for any failed or unreadable condition. It checks
exact-SHA main-push `CI / ci`, main ancestry and inclusion of both reviewed merge
commits, the slug variable, exact environment
policy and public App client ID, both documented rulesets, key metadata and
absence of repository/accessible organization key suppliers, exact App and
installation permissions, selected repository scope, and the production
fast-forward baseline. A missing environment or branch is a failure, not proof
of readiness. It never reads a key or creates an installation token.

Expected values come from #57, the payloads above and the App/merged PR APIs.
PR #30's merge SHA is `cf3ac408c12afc73c3e3f355f6dd70db58ea1af7`; PR #54's is
`13650ac1d8fd4e42d60afc7a859b55305ae2e52c`.
The App API returned public client ID `Iv23lieue1kCmSfTYl5b` on November 12, 2026.
The organization installation API returned installation `180720324`, selected
repositories, and exactly Contents write, Workflows write and Metadata read.
The precheck's current output is an observation, not a source of expected values.
The selected-repository listing may require `read:user` on the operator's
existing authentication; a 403 remains FAIL. Do not fetch the App key or expand
authentication merely to make the staging check pass.

A passing configuration check cannot grant approval, prove key provenance or
replace the live acceptance, refusal and deployment evidence required by #57.
Rerun at the intended SHA during the supervised activation; retain the full
output and CI run URL with the authorization record.

## Switch-on order — dry-run commands

**Do not execute these writes during staging.** Use a supervised Bash session
from the reviewed repository root. Each GitHub command below is a separate
invocation. Stop on a failed write or unexpected readback; do not continue to
the next step. The public switch remains Joe's decision.

| Order | Authorization |
| --- | --- |
| 1, 3, 4a, 4c | Coordinator's named technical setup authorization: variable, environment policy/client ID, rulesets. |
| 2 | Read-only exact main SHA and green main-push CI proof. |
| 4b | Joe: production bootstrap, which can trigger deployment. |
| 5 | Joe: key provisioning, the credential activation point. |
| 6–8 | Joe: first promotion/public switch, live probes and deployment verification. Destructive probes need a separately authorized lab. |

Before writes, read the App and installation APIs and compare their identity and
permissions to #57 and the payloads. Installation permissions must already be
approved; this runbook changes none.

```sh
gh api --method GET /apps/ccm-njpbs-promote
gh api --method GET /orgs/CenterCoopMedia/installations
gh api --method GET /user/installations/180720324/repositories
```

Require App ID `5705771`, the public client ID above, installation `180720324`
unsuspended, exactly the three permissions, and only this selected repository.
An unreadable prerequisite stops activation until the coordinator supplies the
missing read evidence. Check canonical repository name/ID and `CMS_DEPLOY_OWNER`
against the independently approved repository and dispatcher before proceeding.

1. Technical setup: set the App-push deployment variable, then read it back.

   ```sh
   gh variable set CCM_PROMOTE_APP_SLUG --repo CenterCoopMedia/njpbs --body ccm-njpbs-promote
   gh api --method GET /repos/CenterCoopMedia/njpbs/actions/variables/CCM_PROMOTE_APP_SLUG
   ```

2. Read-only: record the selected bootstrap SHA and its successful main-push
   CI run. Replace `BOOTSTRAP_SHA` below with that reviewed 40-character SHA;
   never select a PR head. Run the precheck at that SHA and keep failures from
   still-unconfigured later steps in the record. Before bootstrap, the main
   ref readback must still equal the selected SHA; if it moved, stop and select
   a newly approved green main SHA.

   ```sh
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/main
   ```

   Set operator inputs in the same Bash session (replace the placeholders):

   ```sh
   BOOTSTRAP_SHA='REPLACE_WITH_RECORDED_GREEN_MAIN_SHA'
   PROMOTE_SHA='REPLACE_WITH_LATER_GREEN_MAIN_SHA'
   python3 scripts/check-production-promotion.py --repo CenterCoopMedia/njpbs --sha "$BOOTSTRAP_SHA" --app-slug ccm-njpbs-promote --workflow-sha cf3ac408c12afc73c3e3f355f6dd70db58ea1af7 --admission-sha 13650ac1d8fd4e42d60afc7a859b55305ae2e52c
   ```

3. Technical setup: require the environment to be absent or reconcile its
   existing reviewers, wait timer and protection settings with the coordinator
   before PUT. The payload establishes branch policy; it does not authorize
   removal of another protection. Create/configure the environment and read it
   back, then establish its sole branch entry and read back the complete list.

   ```sh
   gh api --method PUT /repos/CenterCoopMedia/njpbs/environments/production --input docs/release/production-environment.json
   gh api --method GET /repos/CenterCoopMedia/njpbs/environments/production
   gh api --method POST /repos/CenterCoopMedia/njpbs/environments/production/deployment-branch-policies -f name=main -f type=branch
   gh api --method GET '/repos/CenterCoopMedia/njpbs/environments/production/deployment-branch-policies?per_page=100'
   ```

   Create the entry only when it is absent. If other entries exist, delete each
   separately using its observed ID, with a full list readback after each
   deletion; retain only `{name: main, type: branch}`. `POLICY_ID` is the
   individually approved extra entry's ID, never the desired main branch entry.

   ```sh
   POLICY_ID='REPLACE_WITH_EXTRA_POLICY_ID'
   gh api --method DELETE "/repos/CenterCoopMedia/njpbs/environments/production/deployment-branch-policies/$POLICY_ID"
   gh api --method GET '/repos/CenterCoopMedia/njpbs/environments/production/deployment-branch-policies?per_page=100'
   gh variable set CCM_PROMOTE_APP_CLIENT_ID --repo CenterCoopMedia/njpbs --env production --body Iv23lieue1kCmSfTYl5b
   gh api --method GET /repos/CenterCoopMedia/njpbs/environments/production/variables/CCM_PROMOTE_APP_CLIENT_ID
   ```

   Require the exact policy object above, only branch main and no tag entries,
   and a client ID equal to the independently read public App API value. Keep
   the private key unprovisioned.

4. Apply the branch protections around the authorized bootstrap, in this order.
   List existing rulesets first. These POST commands are for the observed
   absent rulesets; do not duplicate an existing ruleset or overwrite drift.

   ```sh
   gh api --method GET '/repos/CenterCoopMedia/njpbs/rulesets?includes_parents=true&per_page=100'
   ```

   4a. Technical setup: install the no-bypass CI/history ruleset, then get its
   full payload using the ID returned by POST.

   ```sh
   gh api --method POST /repos/CenterCoopMedia/njpbs/rulesets --input docs/release/production-checks.ruleset.json
   CHECKS_RULESET_ID='REPLACE_WITH_CREATED_RULESET_ID'
   gh api --method GET "/repos/CenterCoopMedia/njpbs/rulesets/$CHECKS_RULESET_ID"
   ```

   4b. Joe's production authorization: require production to be absent; if it
   exists, stop and reconcile it without force. Recheck main and exact-SHA CI,
   then create production at the approved green main SHA and read it back.

   ```sh
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/production
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/main
   gh api --method POST /repos/CenterCoopMedia/njpbs/git/refs -f ref=refs/heads/production -f sha="$BOOTSTRAP_SHA"
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/production
   ```

   The initial production GET must be a confirmed 404, rather than an auth or
   transport failure. Both ref SHAs after creation must equal `BOOTSTRAP_SHA`.

   4c. Technical setup: install the App-only update lock after bootstrap, then
   read back its complete payload, both rulesets and both refs. Require exact
   payloads and SHAs before provisioning a credential.

   ```sh
   gh api --method POST /repos/CenterCoopMedia/njpbs/rulesets --input docs/release/production-updates.ruleset.json
   UPDATES_RULESET_ID='REPLACE_WITH_CREATED_RULESET_ID'
   gh api --method GET "/repos/CenterCoopMedia/njpbs/rulesets/$UPDATES_RULESET_ID"
   gh api --method GET "/repos/CenterCoopMedia/njpbs/rulesets/$CHECKS_RULESET_ID"
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/main
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/production
   ```

5. Joe's credential activation authorization: in the landofjawn credential
   Bash session, confirm the approved `pass` entry by name without reading its
   value. Set `PROMOTION_KEY_ENTRY` to that approved pointer. The coordinator
   authorized this stdin pipeline for the supervised activation only; never
   place the value in argv, a file, terminal output or the report.

   ```sh
   PROMOTION_KEY_ENTRY='REPLACE_WITH_APPROVED_ENTRY_POINTER'
   set -o pipefail
   pass show "$PROMOTION_KEY_ENTRY" | gh secret set CCM_PROMOTE_APP_PRIVATE_KEY --env production --repo CenterCoopMedia/njpbs
   gh secret list --env production --repo CenterCoopMedia/njpbs
   gh api --method GET '/repos/CenterCoopMedia/njpbs/actions/secrets?per_page=100'
   gh api --method GET '/repos/CenterCoopMedia/njpbs/actions/organization-secrets?per_page=100'
   ```

   The setter must receive the approved store stream, never manually pasted
   text. Readbacks expose metadata only. Require key metadata only in production
   and no repository or accessible organization supplier of this name. Follow
   all pages on list readbacks; the precheck does this automatically. Record
   store provenance separately because GitHub cannot return a secret's value.

6. Joe's first promotion/public switch authorization: select a later green main
   `PROMOTE_SHA` that fast-forwards production and whose range includes a
   reviewed workflow-file change. Rerun the precheck at it and require every
   check to pass. Inspect that range before dispatch; a successful run without
   a workflow-file change does not prove Workflows write.

   ```sh
   python3 scripts/check-production-promotion.py --repo CenterCoopMedia/njpbs --sha "$PROMOTE_SHA" --app-slug ccm-njpbs-promote --workflow-sha cf3ac408c12afc73c3e3f355f6dd70db58ea1af7 --admission-sha 13650ac1d8fd4e42d60afc7a859b55305ae2e52c
   gh api --method GET "/repos/CenterCoopMedia/njpbs/compare/$BOOTSTRAP_SHA...$PROMOTE_SHA"
   gh workflow run promote.yml --repo CenterCoopMedia/njpbs --ref main -f sha="$PROMOTE_SHA"
   gh api --method GET '/repos/CenterCoopMedia/njpbs/actions/workflows/promote.yml/runs?event=workflow_dispatch&branch=main&per_page=10'
   ```

   Identify the new run by its dispatch time, authorized actor and exact title
   `Promote production <PROMOTE_SHA>`; its `head_sha` is the main workflow
   revision, not necessarily the selected SHA. Use that observed run ID for
   subsequent reads, once the run can have completed.

   ```sh
   PROMOTION_RUN_ID='REPLACE_WITH_OBSERVED_RUN_ID'
   gh api --method GET "/repos/CenterCoopMedia/njpbs/actions/runs/$PROMOTION_RUN_ID"
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/production
   ```

   Require a successful promotion and production exactly at `PROMOTE_SHA`.
   Preserve the run URL, previous/selected/ref SHAs and changed workflow path.

7. With Joe's probe authorization, run the applicable refusal probes below.
   Read production immediately before and after each and require the same SHA.
   A successful mutation is a failed probe; stop the switch. Preserve the
   specific refusal, input SHA, actor/ref and any run URL.

8. Verify the resulting Pages deployment and live source SHA using the existing
   deployment workflow's exact-source checks. Require the production push run
   to identify the promotion App and `PROMOTE_SHA`, successful deployment and
   live source equality before calling the route proved. Record that evidence
   in #57; leave it open until the work is live and verified by the coordinator.
   Retire the manual production-ref update route only after promotion and the
   existing deployment checks have been proved together.

   ```sh
   gh api --method GET "/repos/CenterCoopMedia/njpbs/actions/workflows/pages.yml/runs?event=push&branch=production&head_sha=$PROMOTE_SHA&per_page=10"
   gh api --method GET /repos/CenterCoopMedia/njpbs/git/ref/heads/production
   ```

## Refusal probes without a destructive lab

These are future, authorized probes; staging runs none. Reuse existing branch
and tag refs and existing candidate commits. Do not create/delete a ref, remove
CI proof, weaken a ruleset or clear a credential to manufacture a probe.

| Probe | Expected result and limits |
| --- | --- |
| Dispatch promote.yml on an existing non-main branch | The promote job skips before entering production or requesting a token. If that ref lacks the dispatch workflow, GitHub rejects dispatch earlier; record which boundary was tested. |
| Dispatch on an existing tag | Same refusal before token creation; environment policy must also admit no tags. |
| Ordinary writer dispatch on main | The configured owner condition skips the job; no App token or production change. |
| Owner dispatch selecting an existing main SHA with missing/failed main-push CI | The exact-SHA CI check fails before push. Choose a forward candidate so an earlier ancestry refusal does not substitute for CI evidence. If none exists, defer this probe to the lab. |
| Owner dispatch selecting an existing older main SHA | The production ancestry check fails before push; production stays unchanged. This proves workflow refusal, not the server's App-token force-push protection. |
| Ordinary writer update using Git push --dry-run | Safe as a local preview, but **insufficient evidence**: it does not ask the server to accept a ref update or evaluate every rule. Actual ordinary-writer update refusal belongs in the lab unless Joe separately authorizes the production attempt. |

Deletion and direct backward/ordinary-writer update probes can mutate production
if a protection is wrong. Prove those server rules in a separately authorized
lab with the same payloads and actors. A no-op push or dry-run is not deletion,
backward-update or writer-lock evidence. Confirm every rejected probe leaves
the lab branch unchanged. Keep the App route marked untested until #57's full
authorized promotion, server refusal and live deployment evidence exists.

## References

- [App token action and permissions](https://github.com/actions/create-github-app-token/tree/64ab729a6294000f5aa4a4bc0b73d1f32bc45510)
- [Ruleset behavior and bypass actors](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies)
- [GitHub App metadata and installation permissions](https://docs.github.com/en/rest/apps/apps)
- [Repository rulesets API](https://docs.github.com/en/rest/repos/rules)
