# Production branch promotion

Status: **App route untested.** This document describes the proposed switch;
committing these files applies no GitHub configuration. Activation requires
separate approval. The promotion workflow must stay undispatched until then.
The existing Pages workflow rejects App-bot pushes; complete
[the deploy admission prerequisite](https://github.com/CenterCoopMedia/njpbs/issues/29)
before activating this route. Until then, an App promotion would advance the
branch while Pages deployment jobs skip. Deploy admission is unchanged here.

The `production` branch selects a release by fast-forwarding to a green commit
already on `main`. The only trigger for `promote.yml` is `workflow_dispatch`,
with no commit input. It checks out the immutable dispatch SHA, verifies main
ancestry and successful main-push `CI / ci` through the existing release checks,
and pushes without force. It refuses to bootstrap a missing production branch.
Later main commits cannot change the selected SHA. A stale dispatch that would
move production backward fails the ancestry check or the push.

The GitHub App `ccm-njpbs-promote` (numeric App ID `5705771`) is installed only
on this repository. Its token may bypass only the update lock below. Keep
history and CI protections in a second ruleset with no bypass actors: bypass
applies to a whole ruleset, so combining these payloads would let the App
bypass every protection.

## Production rulesets

Apply both payloads through the repository rulesets API or equivalent settings
at the approved switch. Both target exactly `refs/heads/production`.

Update lock:

```json
{
  "name": "NJ PBS production updates",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    {
      "actor_id": 5705771,
      "actor_type": "Integration",
      "bypass_mode": "always"
    }
  ],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/production"],
      "exclude": []
    }
  },
  "rules": [{"type": "update"}]
}
```

CI and history guards:

```json
{
  "name": "NJ PBS production checks and history",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/production"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_linear_history"},
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {"context": "ci", "integration_id": 15368}
        ]
      }
    }
  ]
}
```

`15368` binds `ci` to GitHub Actions. CI and history rules alone do not prove
that a commit belongs to main; the environment admission and workflow source
check supply that boundary. No administrator, role, team or other App belongs
in either bypass list.

## Production environment

For the `production` environment, use this deployment branch policy:

```json
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
```

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

## Switch-on order

These are future operator steps, not commands executed by this PR. Creating or
advancing `production` can trigger existing deployment workflows, so branch
bootstrap and acceptance probes require explicit production authorization.

1. Add **Workflows: Read and write to App 5705771 (Joe approves the permission
   change)**. Keep Contents: Read and write and its installation restricted to
   this repository. The current Contents-only grant cannot promote ranges that
   change workflow files. Approve the installation's expanded permission before
   trying the route; do not change the App as part of preparing this PR.
2. Complete [App-push deploy admission](https://github.com/CenterCoopMedia/njpbs/issues/29).
   The current Pages authorization conditions and script accept only the
   configured owner. Keep deploy workflows off until this prerequisite is
   reviewed and tested; an App push alone currently does not deploy the site.
3. After the draft has been approved for release, merge the reviewed workflow
   and wait for the exact main SHA to pass the main-push `CI / ci` job. Record
   that bootstrap SHA and successful run. Do not select an arbitrary PR SHA.
4. Configure the production environment's exact main-only policy and client ID.
   Read them back, including the absence of tag policies. Keep the private key
   unprovisioned while setting up the branch protections.
5. Install the no-bypass CI/history ruleset. Under the authorized switch, create
   `production` at the recorded green main SHA, install the App-only update
   lock, then read back both rulesets and both branch SHAs. Stop if production
   differs from the recorded main commit. The workflow never creates this
   initial branch. Existing production state must be reconciled before this
   step rather than overwritten or force-pushed.
6. Stream the App key from its approved credential store directly into the
   environment secret setter, without displaying it or writing it to a file.
   Verify secret metadata only. Confirm no repository or organization secret
   supplies this name. This is the credential activation point.
7. In an explicitly authorized test, prove a main dispatch promotes a newer
   green main SHA as a fast-forward. Include a workflow-file change in the
   promoted range to prove the Workflows permission. Record the workflow run
   and production SHA; the App token must not bypass the CI/history ruleset.
8. Prove refusal for a non-main branch/tag dispatch, an ordinary writer's
   production update, missing or failed CI, a backward update, and deletion.
   Use a separately authorized lab for destructive refusal probes; this PR
   supplies no authority to perform them against production. Preserve the
   exact refusals and source SHAs. Confirm rejected probes leave the branch
   unchanged. Keep the route marked untested until these results exist.
9. Verify the deployment triggered by the production update and its live source
   SHA. Retire any superseded manual production-ref update route only after
   this App route and the existing deployment checks have been proved together.

This PR prepares the branch switch, not a second serving environment or a
rollback implementation. Existing deployment checks remain required during
activation. Reverting a live release must use a separately reviewed forward
commit on main; this promotion route never rewinds production.

## References

- [App token action and permissions](https://github.com/actions/create-github-app-token/tree/64ab729a6294000f5aa4a4bc0b73d1f32bc45510)
- [Ruleset behavior and bypass actors](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies)
