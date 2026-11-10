import { describe, it, expect } from "vitest";
import {
  findWorkflowSecretViolations,
  workflowTriggers,
  REMEDIATION,
} from "../src/lib/workflow-secret-guardrail";

// Unit spec for the #312 guardrail's logic. The scan that walks .github/workflows
// lives in scripts/workflow-secret-guardrail.test.ts and runs under npm run
// guardrails; this file pins the rules themselves, including the shapes that would
// let a real exposure read as clean.

describe("workflowTriggers", () => {
  it("reads the block mapping form", () => {
    expect(
      workflowTriggers("name: x\non:\n  pull_request:\n    types: [closed]\njobs: {}\n"),
    ).toEqual(["pull_request"]);
  });

  it("reads block mapping triggers with inline configuration", () => {
    expect(
      workflowTriggers(
        "name: x\non:\n  push:\n  pull_request: { paths: [site/**] }\njobs: {}\n",
      ),
    ).toEqual(["push", "pull_request"]);
  });

  it("reads anchored block and flow trigger forms", () => {
    expect(
      workflowTriggers("on: &events\n  pull_request:\n    paths: [site/**]\njobs: {}\n"),
    ).toEqual(["pull_request"]);
    expect(
      workflowTriggers("on: &events [push, pull_request]\njobs: {}\n"),
    ).toEqual(["push", "pull_request"]);
    expect(
      workflowTriggers(
        "on: &events { pull_request: { paths: [site/**] }, workflow_dispatch: {} }\njobs: {}\n",
      ),
    ).toEqual(["pull_request", "workflow_dispatch"]);
  });

  it("fails closed on an unresolved trigger alias", () => {
    expect(workflowTriggers("on: *events\njobs: {}\n")).toEqual([]);
    expect(
      workflowTriggers("events: &events [push, pull_request]\non: [push, *events]\n"),
    ).toEqual([]);
    expect(workflowTriggers("events: &events pull_request\non: [*events]\n")).toEqual([]);
    expect(workflowTriggers("on: [&event pull_request]\n")).toEqual([]);
    expect(
      workflowTriggers("events: &events pull_request\non:\n  - push\n  - *events\n"),
    ).toEqual([]);
    expect(
      workflowTriggers("events: &events pull_request\non: { push: {}, *events: {} }\n"),
    ).toEqual([]);
    expect(
      workflowTriggers("events: &events pull_request\non: { push: {}, *events }\n"),
    ).toEqual([]);
    expect(
      workflowTriggers("events: &events pull_request\non: { *events, push: {} }\n"),
    ).toEqual([]);
  });

  it("reads valid implicit-null mapping keys", () => {
    expect(workflowTriggers("on: { push: {}, pull_request }\n")).toEqual([
      "push",
      "pull_request",
    ]);
  });

  it("reads multiline flow collections without dropping triggers", () => {
    expect(workflowTriggers("on: [push,\n  pull_request]\n")).toEqual([
      "push",
      "pull_request",
    ]);
    expect(
      workflowTriggers("on: { workflow_dispatch: {},\n  pull_request: {} }\n"),
    ).toEqual(["workflow_dispatch", "pull_request"]);
  });

  it("reads the scalar and flow-sequence forms", () => {
    expect(workflowTriggers("on: push\n")).toEqual(["push"]);
    expect(workflowTriggers("on: [push, pull_request]\n")).toEqual(["push", "pull_request"]);
  });

  it("reads the block sequence form", () => {
    expect(workflowTriggers("on:\n  - push\n  - pull_request_target\n")).toEqual([
      "push",
      "pull_request_target",
    ]);
  });

  it("fails closed on configured sequence items", () => {
    expect(
      workflowTriggers("on:\n  - push\n  - pull_request_target: { types: [closed] }\njobs: {}\n"),
    ).toEqual([]);
  });

  it("accepts the YAML 1.1 `true` spelling of the `on` key", () => {
    // A round-trip through YAML 1.1 tooling rewrites `on:` as `true:`. Reading it
    // keeps the scan seeing triggers instead of silently finding none.
    expect(workflowTriggers("true:\n  pull_request:\n")).toEqual(["pull_request"]);
  });

  it("does not mistake a trigger's nested config for another trigger", () => {
    // `branches`/`paths`/`types` sit one level deeper. Counting them would be
    // harmless noise, but a trigger's config keyed `push:` would not be.
    expect(
      workflowTriggers(
        "on:\n  pull_request_target:\n    types: [closed]\n    branches: [main]\n    paths:\n      - site/**\njobs: {}\n",
      ),
    ).toEqual(["pull_request_target"]);
  });

  it("ignores triggers named only in comments", () => {
    // The retired preview cleanup header explained why it used
    // pull_request_target rather than pull_request. Reading prose as a trigger
    // would flag it under the stricter rule and make the guardrail cry wolf.
    expect(
      workflowTriggers("# Runs on pull_request_target, not pull_request, because...\non:\n  push:\n"),
    ).toEqual(["push"]);
  });

  it("reads the flow mapping form", () => {
    // Returning the whole brace blob as one trigger name would be the worst failure
    // available: it matches neither rule, so both switch off for that file while the
    // scan still reports a pass.
    expect(workflowTriggers("on: { pull_request: {}, workflow_dispatch: {} }\n")).toEqual([
      "pull_request",
      "workflow_dispatch",
    ]);
  });

  it("skips nested keys inside a flow mapping's values", () => {
    expect(
      workflowTriggers("on: { pull_request_target: { types: [closed], branches: [main] } }\n"),
    ).toEqual(["pull_request_target"]);
  });

  it("returns nothing when there is no `on:` block at all", () => {
    expect(workflowTriggers("name: broken\njobs: {}\n")).toEqual([]);
  });
});

describe("findWorkflowSecretViolations", () => {
  it("flags a repository secret in a pull_request workflow", () => {
    const found = findWorkflowSecretViolations(
      ["pull_request"],
      "        env:\n          CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
    );
    expect(found).toEqual([{ rule: "pr-trigger-secret", match: "secrets.CLOUDFLARE_API_TOKEN" }]);
  });

  it("exempts GITHUB_TOKEN, which Actions mints per run and `permissions:` bounds", () => {
    expect(
      findWorkflowSecretViolations(["pull_request"], "token: ${{ secrets.GITHUB_TOKEN }}"),
    ).toEqual([]);
  });

  it("flags bracket-index secret syntax, which is as valid as the dotted form", () => {
    // Actions expressions accept secrets['NAME'] and secrets["NAME"]. A rule that
    // read only dots would call an exposed tree clean.
    expect(
      findWorkflowSecretViolations(["pull_request"], "${{ secrets['CLOUDFLARE_API_TOKEN'] }}"),
    ).toEqual([{ rule: "pr-trigger-secret", match: "secrets.CLOUDFLARE_API_TOKEN" }]);
    expect(
      findWorkflowSecretViolations(["pull_request"], '${{ secrets["TEST_DEPLOY_TOKEN"] }}'),
    ).toEqual([{ rule: "pr-trigger-secret", match: "secrets.TEST_DEPLOY_TOKEN" }]);
  });

  it("flags toJSON(secrets), which dumps every secret at once and names none", () => {
    expect(
      findWorkflowSecretViolations(["pull_request"], "        run: echo '${{ toJSON(secrets) }}'"),
    ).toEqual([{ rule: "pr-trigger-secret", match: "toJSON(secrets)" }]);
  });

  it("keeps exempting GITHUB_TOKEN when it is written in bracket syntax", () => {
    expect(
      findWorkflowSecretViolations(["pull_request"], "${{ secrets['GITHUB_TOKEN'] }}"),
    ).toEqual([]);
  });

  it("allows the same secret on a push trigger, which runs trusted base-branch code", () => {
    expect(
      findWorkflowSecretViolations(["push", "workflow_dispatch"], "${{ secrets.TEST_DEPLOY_TOKEN }}"),
    ).toEqual([]);
  });

  it("allows secrets on pull_request_target while no PR head code is checked out", () => {
    // This models the retired preview cleanup job: it holds a Cloudflare token but acts on the PR
    // by number alone, which is what makes it safe.
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        "env:\n  CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n  PR_BRANCH: pr-${{ github.event.number }}\n",
      ),
    ).toEqual([]);
  });

  it("does not flag a forbidden expression that appears only in a comment", () => {
    // The real regression this caught: the retired preview cleanup header warned the next
    // editor not to add a checkout of github.event.pull_request.head. Matching prose
    // flagged the file for the sentence explaining why it is safe -- a guardrail
    // that punishes its own documentation teaches people to delete it.
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        "# Do not add a checkout of the PR head (github.event.pull_request.head).\njobs:\n  cleanup:\n",
      ),
    ).toEqual([]);
  });

  it("still flags a real expression on a line that also carries a comment", () => {
    // Stripping comments must not become a way to hide a violation behind one.
    expect(
      findWorkflowSecretViolations(
        ["pull_request"],
        "  token: ${{ secrets.TEST_DEPLOY_TOKEN }} # trusted deploy only\n",
      ),
    ).toEqual([{ rule: "pr-trigger-secret", match: "secrets.TEST_DEPLOY_TOKEN" }]);
  });

  it("does not read shell parameter expansion as a comment", () => {
    // `${base#prefix}` is valid shell inside a run: block. Treating that `#` as a
    // comment would silently truncate the rest of the line from the scan.
    expect(
      findWorkflowSecretViolations(
        ["pull_request"],
        '  run: echo "${base#https://}" ${{ secrets.CLOUDFLARE_API_TOKEN }}\n',
      ),
    ).toEqual([{ rule: "pr-trigger-secret", match: "secrets.CLOUDFLARE_API_TOKEN" }]);
  });

  it("flags a PR head checkout in a pull_request_target workflow", () => {
    const found = findWorkflowSecretViolations(
      ["pull_request_target"],
      "      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n",
    );
    expect(found).toEqual([
      { rule: "pr-target-head-checkout", match: "github.event.pull_request.head.sha" },
    ]);
  });

  it("flags a PR head checkout written in bracket-index syntax", () => {
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        "          ref: ${{ github.event['pull_request'].head.sha }}\n",
      ),
    ).toEqual([
      { rule: "pr-target-head-checkout", match: "github.event.pull_request.head.sha" },
    ]);
  });

  it("flags a PR head checkout that mixes dot and bracket accessors", () => {
    // Normalising once, rather than teaching each rule both spellings, is what makes
    // a mixed expression fold to the same dotted form the rule already knows.
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        "          ref: ${{ github['event'].pull_request['head'].ref }}\n",
      ),
    ).toEqual([
      { rule: "pr-target-head-checkout", match: "github.event.pull_request.head.ref" },
    ]);
  });

  it("leaves a quoted glob alone when normalising index syntax", () => {
    // paths: ["site/**"] must not be folded into an accessor; if it were, the
    // rewrite could corrupt the very lines the scan then reads.
    expect(
      findWorkflowSecretViolations(
        ["pull_request"],
        '    paths: ["site/**"]\n    token: ${{ secrets.TEST_DEPLOY_TOKEN }}\n',
      ),
    ).toEqual([{ rule: "pr-trigger-secret", match: "secrets.TEST_DEPLOY_TOKEN" }]);
  });

  it("allows reading head metadata that names no code to run", () => {
    // Deciding on head.repo.fork / head.repo.full_name is normal and safe in a
    // pull_request_target job. Flagging it would make the scan cry wolf, and a
    // guardrail people learn to work around stops protecting anything.
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        "        if: ${{ github.event.pull_request.head.repo.fork == false }}\n" +
          "        run: echo ${{ github.event.pull_request.head.repo.full_name }}\n",
      ),
    ).toEqual([]);
  });

  it("still flags the fork clone URL, which does name code to run", () => {
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        "        run: git clone ${{ github.event.pull_request.head.repo.clone_url }}\n",
      ),
    ).toEqual([
      { rule: "pr-target-head-checkout", match: "github.event.pull_request.head.repo.clone_url" },
    ]);
  });

  it("flags github.head_ref, the short spelling the pwn-request pattern usually uses", () => {
    // The likeliest way the forbidden edit actually gets typed: shorter than the
    // event-payload form and what the well-known writeups lead with.
    expect(
      findWorkflowSecretViolations(["pull_request_target"], "          ref: ${{ github.head_ref }}\n"),
    ).toEqual([{ rule: "pr-target-head-checkout", match: "github.head_ref" }]);
  });

  it("flags GITHUB_HEAD_REF, the same value read from the environment", () => {
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        '        run: git fetch origin "$GITHUB_HEAD_REF"\n',
      ),
    ).toEqual([{ rule: "pr-target-head-checkout", match: "GITHUB_HEAD_REF" }]);
  });

  it("flags the raw refs/pull ref, which reaches PR code without naming the payload", () => {
    expect(
      findWorkflowSecretViolations(["pull_request_target"], "          ref: refs/pull/12/merge\n"),
    ).toEqual([{ rule: "pr-target-head-checkout", match: "refs/pull/12/merge" }]);
  });

  it("reports every violation in a file, not just the first", () => {
    const found = findWorkflowSecretViolations(
      ["pull_request"],
      "${{ secrets.MEDIA_MANAGER_API_KEY }} ${{ secrets.MEDIA_MANAGER_API_SECRET }}",
    );
    expect(found.map((v) => v.match)).toEqual([
      "secrets.MEDIA_MANAGER_API_KEY",
      "secrets.MEDIA_MANAGER_API_SECRET",
    ]);
  });

  it("carries remediation text for every rule it can emit", () => {
    // The failing build prints REMEDIATION[rule]; a rule added without one would
    // print `undefined` at exactly the moment someone needs the instruction.
    const rules = findWorkflowSecretViolations(
      ["pull_request", "pull_request_target"],
      "${{ secrets.TEST_DEPLOY_TOKEN }} ${{ github.event.pull_request.head.ref }}",
    ).map((v) => v.rule);
    expect(new Set(rules)).toEqual(new Set(["pr-trigger-secret", "pr-target-head-checkout"]));
    for (const rule of rules) expect(REMEDIATION[rule]).toBeTruthy();
  });
});
