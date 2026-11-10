import { describe, expect, it } from "vitest";
import {
  findWorkflowSecretViolations,
  REMEDIATION,
} from "../src/lib/workflow-secret-guardrail";

// Regression suite for #661. A pull_request job that calls a reusable workflow
// can pass the entire repository secret store with `secrets: inherit` without
// spelling any `secrets.NAME` expression the original #312 guard can match.

describe("reusable-workflow secret inheritance", () => {
  it("flags the actual #661 bypass in block form", () => {
    const source = `
name: reusable bypass
on: pull_request
jobs:
  publish:
    uses: ./.github/workflows/publish.yml
    secrets: inherit
`;

    expect(findWorkflowSecretViolations(["pull_request"], source)).toEqual([
      {
        rule: "pr-trigger-inherited-secrets",
        match: "jobs.publish.secrets: inherit",
      },
    ]);
  });

  it("flags the same reusable job in flow form", () => {
    const source =
      "on: pull_request\njobs: { call: { uses: ./.github/workflows/reusable.yml, secrets: inherit } }\n";

    expect(findWorkflowSecretViolations(["pull_request"], source)).toEqual([
      {
        rule: "pr-trigger-inherited-secrets",
        match: "jobs.call.secrets: inherit",
      },
    ]);
  });

  it("allows an explicit secret map in flow form", () => {
    const source =
      'on: pull_request\njobs: { call: { uses: ./.github/workflows/reusable.yml, secrets: { token: "${{ github.token }}" } } }\n';

    expect(findWorkflowSecretViolations(["pull_request"], source)).toEqual([]);
  });

  it("flags a quoted inherit scalar without treating arbitrary strings as inheritance", () => {
    const inherited = `
on: pull_request
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
    secrets: "inherit"
`;
    const unrelated = `
on: pull_request
jobs:
  ordinary:
    runs-on: ubuntu-latest
    env:
      NOTE: "inherit"
    steps:
      - run: echo safe
`;

    expect(findWorkflowSecretViolations(["pull_request"], inherited)).toEqual([
      {
        rule: "pr-trigger-inherited-secrets",
        match: "jobs.call.secrets: inherit",
      },
    ]);
    expect(findWorkflowSecretViolations(["pull_request"], unrelated)).toEqual([]);
  });

  it("checks every job while leaving safe controls alone", () => {
    const source = `
on: pull_request
jobs:
  ordinary:
    runs-on: ubuntu-latest
    steps:
      - run: 'echo "secrets: inherit"'
  dangerous:
    uses: owner/repo/.github/workflows/reusable.yml@main
    secrets: inherit
  explicit:
    uses: ./.github/workflows/reusable.yml
    secrets:
      token: \${{ github.token }}
  secretless:
    uses: ./.github/workflows/reusable.yml
`;

    expect(findWorkflowSecretViolations(["pull_request"], source)).toEqual([
      {
        rule: "pr-trigger-inherited-secrets",
        match: "jobs.dangerous.secrets: inherit",
      },
    ]);
  });

  it("does not treat comments or unrelated scalar text as inherited secrets", () => {
    const source = `
on: pull_request
# jobs.example.secrets: inherit
jobs:
  ordinary:
    runs-on: ubuntu-latest
    env:
      NOTE: "secrets: inherit"
    steps:
      - run: echo safe # secrets: inherit
`;

    expect(findWorkflowSecretViolations(["pull_request"], source)).toEqual([]);
  });

  it("allows aliases confined to ordinary job data", () => {
    const source = `
on: pull_request
jobs:
  ordinary:
    runs-on: ubuntu-latest
    env: &shared_env
      NOTE: safe
    steps:
      - run: echo safe
        env: *shared_env
`;

    expect(findWorkflowSecretViolations(["pull_request"], source)).toEqual([]);
  });

  it("allows inheritance on trusted triggers and preserves pull_request_target rules", () => {
    const reusable = `
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
`;

    expect(findWorkflowSecretViolations(["push"], reusable)).toEqual([]);
    expect(findWorkflowSecretViolations(["pull_request_target"], reusable)).toEqual([]);
    expect(
      findWorkflowSecretViolations(
        ["pull_request_target"],
        `${reusable}\n  checkout: \${{ github.event.pull_request.head.sha }}\n`,
      ),
    ).toEqual([
      {
        rule: "pr-target-head-checkout",
        match: "github.event.pull_request.head.sha",
      },
    ]);
  });

  it("fails closed when pull-request job structure cannot be classified", () => {
    expect(findWorkflowSecretViolations(["pull_request"], "jobs: []\n")).toEqual([
      { rule: "pr-trigger-workflow-structure", match: "jobs must be a mapping" },
    ]);

    expect(findWorkflowSecretViolations(["pull_request"], "jobs: {}\n")).toEqual([
      {
        rule: "pr-trigger-workflow-structure",
        match: "jobs must contain at least one job",
      },
    ]);

    expect(
      findWorkflowSecretViolations(
        ["pull_request"],
        "shared: &shared { uses: ./.github/workflows/reusable.yml, secrets: inherit }\njobs: { call: *shared }\n",
      ),
    ).toEqual([
      {
        rule: "pr-trigger-workflow-structure",
        match: "jobs.call uses an alias or top-level merge",
      },
    ]);

    expect(
      findWorkflowSecretViolations(
        ["pull_request"],
        "shared: &shared { uses: ./.github/workflows/reusable.yml, secrets: inherit }\njobs: { call: { <<: *shared } }\n",
      ),
    ).toEqual([
      {
        rule: "pr-trigger-workflow-structure",
        match: "jobs.call uses an alias or top-level merge",
      },
    ]);

    expect(
      findWorkflowSecretViolations(
        ["pull_request"],
        "jobs: { call: { uses: ./.github/workflows/reusable.yml, secrets: [inherit] } }\n",
      ),
    ).toEqual([
      {
        rule: "pr-trigger-workflow-structure",
        match: "jobs.call.secrets has an unsupported shape",
      },
    ]);
  });

  it("carries remediation text for every rule it emits", () => {
    const validWorkflow = `
on: [pull_request, pull_request_target]
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
    with:
      token: \${{ secrets.TEST_DEPLOY_TOKEN }}
      ref: \${{ github.event.pull_request.head.ref }}
`;
    const rules = [
      ...findWorkflowSecretViolations(
        ["pull_request", "pull_request_target"],
        validWorkflow,
      ),
      ...findWorkflowSecretViolations(["pull_request"], "jobs: []\n"),
    ].map((violation) => violation.rule);

    expect(new Set(rules)).toEqual(
      new Set([
        "pr-trigger-secret",
        "pr-trigger-inherited-secrets",
        "pr-trigger-workflow-structure",
        "pr-target-head-checkout",
      ]),
    );
    for (const rule of rules) expect(REMEDIATION[rule]).toBeTruthy();
  });
});
