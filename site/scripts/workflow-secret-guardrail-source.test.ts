import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findWorkflowSecretViolations,
  workflowTriggers,
  REMEDIATION,
} from "../src/lib/workflow-secret-guardrail";

// Source-tree guardrail for issues #312 and #661: no repository secret may be
// reachable from code a pull request author controls. Runs via npm run guardrails,
// globbed by
// vitest.guardrails.config.ts alongside the metered-API scan.
//
// Like that scan this reads hand-written source, not built dist -- the risk lives in
// workflow YAML, which the site build never emits. Unlike it, the whole scope is one
// directory: .github/workflows at the repo root. That is every workflow GitHub will
// run, so there is no per-tree allowlist to keep in sync and no way to add a workflow
// that escapes the scan by living somewhere new.
//
// See src/lib/workflow-secret-guardrail.ts for why the two PR triggers get different
// rules. In short: `pull_request` runs the author's steps, so it holds neither named
// repository secrets nor reusable-workflow `secrets: inherit`; `pull_request_target`
// runs trusted steps, so it never touches the author's code. Trigger and job shapes
// that cannot be classified fail required CI instead of quietly disabling a rule.

const workflowsDir = fileURLToPath(new URL("../../.github/workflows", import.meta.url));

interface Scanned {
  file: string;
  triggers: string[];
  source: string;
}

// Read inside the tests, not in the describe body: a throw during vitest collection
// takes the file down before any test registers, so the run reports zero tests
// instead of a failure and the check that would name the problem never speaks.
// (Same reasoning as scripts/metered-api-guardrail-source.test.ts.)
function scanWorkflows(): Scanned[] {
  if (!existsSync(workflowsDir)) {
    throw new Error(
      `${workflowsDir} is missing. This guardrail's entire scope is that directory, ` +
        `so an absent path means the scan silently checks nothing rather than passing.`,
    );
  }
  const files = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `No workflow files found in ${workflowsDir}. The repo runs CI from this directory, ` +
        `so an empty scan means the guardrail lost its target, not that the tree is clean.`,
    );
  }
  return files.map((file) => {
    const source = readFileSync(join(workflowsDir, file), "utf8");
    return { file, triggers: workflowTriggers(source), source };
  });
}

function describeViolation(file: string, rule: string, match: string): string {
  return `${file}: ${rule} -> ${match}\n    ${REMEDIATION[rule as keyof typeof REMEDIATION]}`;
}

describe("workflow secret guardrail (#312)", () => {

  it("keeps repository secrets out of pull-request-triggered workflows", () => {
    const findings = scanWorkflows().flatMap(({ file, triggers, source }) =>
      findWorkflowSecretViolations(triggers, source).map((v) =>
        describeViolation(file, v.rule, v.match),
      ),
    );

    expect(
      findings,
      findings.length
        ? `Repository secrets are reachable from PR-authored code:\n  ${findings.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  it("still parses a trigger out of every workflow it scans", () => {
    // A workflow whose triggers come back empty is scanned but never rule-checked,
    // which reads as a pass. That would be the quiet way for this guardrail to die:
    // swap the YAML parser, get `on` under a different key, and every file looks
    // clean forever. Assert the parse actually produced something instead.
    const untriggered = scanWorkflows()
      .filter(({ triggers }) => triggers.length === 0)
      .map(({ file }) => file);

    expect(
      untriggered,
      `No trigger parsed from: ${untriggered.join(", ")}. Every GitHub workflow has an ` +
        `\`on:\` block, so an empty result means the parse broke, not that the file is exempt.`,
    ).toEqual([]);
  });
});
