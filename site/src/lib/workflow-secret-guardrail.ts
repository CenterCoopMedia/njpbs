import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";

// Reject repository secrets reachable from PR-authored code.
// A pull_request workflow can execute code controlled by its author; a trusted
// pull_request_target job can expose its secrets if it checks out that same code.
// The scan rejects secret-bearing PR builds and PR-head execution in trusted jobs.
//
// The two triggers are not equally dangerous, so the rules differ:
//
//   pull_request        runs the workflow file FROM THE PR BRANCH. The PR author
//                       controls every step, so any secret in scope is already
//                       readable. Rule: hold no named secrets and never pass the
//                       repository store through reusable-workflow inheritance.
//
//   pull_request_target runs the workflow file from the BASE branch, so the steps
//                       themselves are trusted and secrets are safe -- until the job
//                       checks out the PR head, at which point PR-authored build
//                       scripts, hooks and dependencies execute inside that trusted,
//                       secret-bearing context. Rule: never reference PR head code.
//
// Both rules are about reachability, not about whether a secret exists: a secret in
// a push-triggered or manually dispatched workflow runs trusted base-branch code and
// is out of scope here.

export interface WorkflowSecretViolation {
  rule:
    | "pr-trigger-secret"
    | "pr-trigger-inherited-secrets"
    | "pr-trigger-workflow-structure"
    | "pr-target-head-checkout";
  /** The offending expression, as written, for the failure message. */
  match: string;
}

// `secrets.GITHUB_TOKEN` is exempt: Actions mints it per run rather than reading it
// from the repository secret store, it is bounded by the workflow's `permissions:`
// block, and it is read-only by default on a pull request from a fork. Excluding it
// keeps the rule aimed at long-lived repository credentials. The `github.token`
// spelling is exempt for the same reason.
const SECRET_REFERENCE = /\bsecrets\.([A-Za-z_][A-Za-z0-9_-]*)/g;
const EXEMPT_SECRETS = new Set(["GITHUB_TOKEN"]);

// `toJSON(secrets)` serialises the whole secret store into one value, so it names no
// individual secret and SECRET_REFERENCE cannot see it. It is the highest-yield
// spelling of whole-store exfiltration -- every secret at once, in one
// log line -- so it gets its own match rather than being missed for lack of a dot.
const SECRET_BULK_REFERENCE = /\btoJSON\s*\(\s*secrets\s*\)/g;

// Ways a job reaches the code a PR author wrote. All four spell the same checkout;
// a rule that knew only some of them would be bypassed by typing another.
//
//   github.event.pull_request.head.sha|.ref         the commit to check out
//   github.event.pull_request.head.repo.*_url       the fork to clone
//   github.event.pull_request.merge_commit_sha      the merge result, same code
//   github.head_ref / GITHUB_HEAD_REF               the short form, set on PR events
//   refs/pull/N/head|merge                          the raw ref, naming no context
//
// `github.head_ref` earns its place first among equals: it is the shortest to type
// and the spelling GitHub Security Lab's pwn-request writeup leads with, so it is
// the likeliest way a head checkout in a pull_request_target workflow would
// actually get written. GITHUB_HEAD_REF is the same
// value read from the environment instead of an expression.
//
// Deliberately NOT every `head.*` field. Reading head metadata to make a decision --
// `head.repo.fork`, `head.repo.full_name`, `head.label` -- is normal and safe in a
// pull_request_target job, because none of it executes the author's code. Flagging
// those would make the scan cry wolf on legitimate workflows, and a guardrail people
// learn to work around stops protecting anything. Only the fields that name code to
// run are listed: a commit to check out, or a repository to clone.
const PR_HEAD_REFERENCE =
  /github\.event\.pull_request\.head\.(?:sha|ref|repo\.(?:clone_url|ssh_url|git_url|html_url))|github\.event\.pull_request\.merge_commit_sha|github\.head_ref|GITHUB_HEAD_REF|refs\/pull\/[^\s"']+\/(?:head|merge)/g;

/**
 * Rewrite Actions index syntax to the equivalent dot syntax, for matching only.
 *
 * `secrets['CLOUDFLARE_API_TOKEN']` and `github.event['pull_request'].head.sha` are
 * exactly as valid, and as dangerous, as the dotted spellings -- so a rule that
 * matched only dots would pass a tree that is not safe. Normalising once here beats
 * teaching every rule both spellings: the rules stay readable, and a mixed
 * expression (`github['event'].pull_request['head']`) folds down to the same dotted
 * form without any rule knowing that syntax exists.
 *
 * The result is fed to the matchers and never written back to disk, so rewriting an
 * unrelated quoted index (`branches: ['main']`) does not matter. Only a bare
 * identifier is folded, which leaves globs such as `paths: ["site/**"]` alone.
 */
function normalizeIndexAccess(source: string): string {
  return source.replace(/\[\s*(['"])([A-Za-z_][A-Za-z0-9_-]*)\1\s*\]/g, ".$2");
}

const TRIGGER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JOB_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function scalarKey(node: unknown): string | null {
  return isScalar(node) && typeof node.value === "string" ? node.value : null;
}

/**
 * Inspect the job-level reusable-workflow shape that can pass every secret without
 * naming one. This must use the parsed YAML tree: a loose `secrets: inherit` text
 * search would flag comments, shell strings, and ordinary environment values.
 *
 * The companion source scan already fails when a complete workflow has malformed
 * YAML or an unreadable trigger block. Here, a successfully parsed `jobs:` block
 * fails closed when its shape, whole-job aliases, or top-level merges prevent
 * reliable classification.
 * Partial strings used by the expression-level unit tests have neither `on:` nor
 * `jobs:` and therefore remain outside this structural check.
 */
function findInheritedSecretViolations(source: string): WorkflowSecretViolation[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) return [];

  const root = document.contents;
  const hasWorkflowTrigger = root.items.some(
    (pair) =>
      isScalar(pair.key) && (pair.key.value === "on" || pair.key.value === true),
  );
  const jobsPairs = root.items.filter((pair) => scalarKey(pair.key) === "jobs");

  if (jobsPairs.length === 0) {
    return hasWorkflowTrigger
      ? [{ rule: "pr-trigger-workflow-structure", match: "jobs must be a mapping" }]
      : [];
  }
  if (jobsPairs.length !== 1 || !isMap(jobsPairs[0].value)) {
    return [{ rule: "pr-trigger-workflow-structure", match: "jobs must be a mapping" }];
  }

  if (jobsPairs[0].value.items.length === 0) {
    return [
      {
        rule: "pr-trigger-workflow-structure",
        match: "jobs must contain at least one job",
      },
    ];
  }

  const violations: WorkflowSecretViolation[] = [];
  for (const jobPair of jobsPairs[0].value.items) {
    const jobName = scalarKey(jobPair.key);
    if (!jobName || !JOB_NAME.test(jobName)) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: "jobs contains an unsupported job identifier",
      });
      continue;
    }

    const jobNode = jobPair.value;
    if (jobNode == null) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: `jobs.${jobName} must be a mapping`,
      });
      continue;
    }

    if (isAlias(jobNode)) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: `jobs.${jobName} uses an alias or top-level merge`,
      });
      continue;
    }

    if (!isMap(jobNode)) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: `jobs.${jobName} must be a mapping`,
      });
      continue;
    }

    // A whole-job alias or `<<` merge can inject `uses:` and `secrets:` keys that
    // are not present in this mapping's explicit pairs, so those shapes fail closed.
    // Aliases nested under unrelated values such as `env:` or `steps:` cannot alter
    // the job-level reusable-workflow boundary and remain valid, low-noise controls.
    if (
      jobNode.items.some(
        (pair) => isAlias(pair.key) || scalarKey(pair.key) === "<<",
      )
    ) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: `jobs.${jobName} uses an alias or top-level merge`,
      });
      continue;
    }

    const usesPairs = jobNode.items.filter((pair) => scalarKey(pair.key) === "uses");
    const secretsPairs = jobNode.items.filter(
      (pair) => scalarKey(pair.key) === "secrets",
    );
    if (usesPairs.length > 1 || secretsPairs.length > 1) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: `jobs.${jobName} has duplicate reusable-workflow keys`,
      });
      continue;
    }

    const usesNode = usesPairs[0]?.value;
    const secretsNode = secretsPairs[0]?.value;
    if (usesNode != null && (!isScalar(usesNode) || typeof usesNode.value !== "string")) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: `jobs.${jobName}.uses has an unsupported shape`,
      });
      continue;
    }

    if (secretsNode == null) continue;
    if (usesNode == null) {
      violations.push({
        rule: "pr-trigger-workflow-structure",
        match: `jobs.${jobName}.secrets appears without a reusable-workflow call`,
      });
      continue;
    }

    if (isMap(secretsNode)) continue;
    if (isScalar(secretsNode) && secretsNode.value === "inherit") {
      violations.push({
        rule: "pr-trigger-inherited-secrets",
        match: `jobs.${jobName}.secrets: inherit`,
      });
      continue;
    }

    violations.push({
      rule: "pr-trigger-workflow-structure",
      match: `jobs.${jobName}.secrets has an unsupported shape`,
    });
  }

  return violations;
}

/** Strip a trailing YAML comment while preserving quoted text and shell expansion. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Read a workflow's trigger names out of its raw YAML.
 *
 * Use the declared YAML parser because GitHub Actions accepts anchors, aliases,
 * implicit-null mapping keys, and multiline flow collections. A partial hand parser
 * can retain a harmless trigger while silently dropping `pull_request`, which makes
 * the secret scan report a false pass. Malformed documents, references inside the
 * trigger value, and unsupported trigger shapes return no triggers so the companion
 * source scan fails closed.
 *
 *   on: push                     scalar
 *   on: [push, pull_request]     flow sequence
 *   on:                          block mapping (the common case) or block sequence
 *     pull_request:                `pull_request:` / `- pull_request`
 *     pull_request: { paths: [...] } inline trigger config
 *       types: [closed]
 *
 * The `true` spelling is supported because YAML 1.1 tooling can rewrite `on:` as
 * `true:`. The companion test in scripts/ asserts that every scanned workflow yields
 * at least one trigger.
 */
export function workflowTriggers(source: string): string[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) return [];

  const triggerPairs = document.contents.items.filter(
    (pair) =>
      isScalar(pair.key) && (pair.key.value === "on" || pair.key.value === true),
  );
  if (triggerPairs.length !== 1 || triggerPairs[0].value == null) return [];

  const triggerNode = triggerPairs[0].value;
  let hasReference = false;
  visit(triggerNode, (_key, node) => {
    const nestedAnchor =
      node !== null &&
      typeof node === "object" &&
      node !== triggerNode &&
      "anchor" in node &&
      node.anchor;
    if (isAlias(node) || nestedAnchor) {
      hasReference = true;
      return visit.BREAK;
    }
  });
  if (hasReference) return [];

  const triggerName = (node: unknown): string | null => {
    if (!isScalar(node) || typeof node.value !== "string") return null;
    return TRIGGER_NAME.test(node.value) ? node.value : null;
  };

  if (isScalar(triggerNode)) {
    const name = triggerName(triggerNode);
    return name ? [name] : [];
  }

  if (isSeq(triggerNode)) {
    const names = triggerNode.items.map(triggerName);
    return names.every((name): name is string => name !== null) ? names : [];
  }

  if (isMap(triggerNode)) {
    const names = triggerNode.items.map((pair) => triggerName(pair.key));
    return names.every((name): name is string => name !== null) ? names : [];
  }

  return [];
}

/**
 * Find every way `source` lets PR-authored code reach a repository secret.
 *
 * `triggers` comes from {@link workflowTriggers}; `source` is the raw workflow text.
 * Named secret and PR-head expressions are scanned as text on purpose: they may
 * appear in a `run:` script, a `with:` input, an `env:` value, or a job-level `if:`.
 * Reusable-workflow inheritance is different because `secrets: inherit` is dangerous
 * only at the job level beside `uses:`; that shape is inspected through the YAML tree
 * so comments, shell text, and unrelated scalar values remain safe controls.
 *
 * Comments are removed before matching, because a workflow that documents this very
 * rule quotes the expressions it forbids. The retired preview cleanup header
 * warned editors not to check out `github.event.pull_request.head`. Reading that
 * prose as code would flag the sentence explaining why the workflow was safe. A guardrail that punishes its own
 * documentation teaches people to delete the documentation.
 */
export function findWorkflowSecretViolations(
  triggers: string[],
  source: string,
): WorkflowSecretViolation[] {
  const violations: WorkflowSecretViolation[] = [];
  const code = normalizeIndexAccess(source.split(/\r?\n/).map(stripComment).join("\n"));

  if (triggers.includes("pull_request")) {
    violations.push(...findInheritedSecretViolations(source));
    for (const match of code.matchAll(SECRET_REFERENCE)) {
      if (EXEMPT_SECRETS.has(match[1])) continue;
      violations.push({ rule: "pr-trigger-secret", match: match[0] });
    }
    for (const match of code.matchAll(SECRET_BULK_REFERENCE)) {
      violations.push({ rule: "pr-trigger-secret", match: match[0] });
    }
  }

  if (triggers.includes("pull_request_target")) {
    for (const match of code.matchAll(PR_HEAD_REFERENCE)) {
      violations.push({ rule: "pr-target-head-checkout", match: match[0] });
    }
  }

  return violations;
}

/** How to fix each rule, shown on the failing build so the message is actionable. */
export const REMEDIATION: Record<WorkflowSecretViolation["rule"], string> = {
  "pr-trigger-secret":
    "A `pull_request` workflow runs steps the PR author wrote, so any secret here is readable by them. " +
    "Split the job: keep the `pull_request` build secretless and upload an artifact, then do the " +
    "secret-bearing work in a `workflow_run` job that runs base-branch code and consumes that artifact.",
  "pr-trigger-inherited-secrets":
    "A reusable workflow called from `pull_request` cannot use `secrets: inherit`: that passes the " +
    "entire repository secret store to code selected by the PR. Keep the call secretless, pass only " +
    "the per-run GitHub token where needed, or move secret-bearing work to trusted base-branch code.",
  "pr-trigger-workflow-structure":
    "The guardrail could not safely classify this pull-request workflow's jobs. Use explicit job " +
    "mappings without whole-job aliases or top-level merges, and express reusable-workflow " +
    "secrets as a mapping so the scan can prove the job does not inherit the repository secret store.",
  "pr-target-head-checkout":
    "A `pull_request_target` workflow holds full repository secrets. Checking out the PR head runs the " +
    "author's build scripts, hooks and dependencies inside that context. Act on the PR by number or " +
    "metadata alone, or move the work that needs the head commit into a secretless `pull_request` job.",
};
