import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const CONSUMER_GATES = ["docs", "site", "admin", "firebase"];

const ALL_GATES = Object.freeze({
  docs: true,
  site: true,
  admin: true,
  firebase: true,
});

const NO_GATES = Object.freeze({
  docs: false,
  site: false,
  admin: false,
  firebase: false,
});

const DOC_EXTENSIONS = /\.(?:md|mdx)$/i;
const SOURCE_POLICY_PATHS = new Set([
  "config/configuration-inputs.json",
  "scripts/check-configuration-inputs.py",
  "tests/scripts/configuration-inputs.test.py",
  "tests/repository-identity.test.mjs",
  "tests/scripts/render-wrangler-config.test.mjs",
  ".github/scripts/evidence-image-policy.mjs",
  ".github/scripts/evidence-image-policy.test.mjs",
  ".github/scripts/ci-tree-reuse.mjs",
  ".github/scripts/ci-tree-reuse.test.mjs",
  ".github/scripts/workflow-policy.test.mjs",
  ".github/scripts/pages-fallback-safety.mjs",
  ".github/scripts/pages-fallback-safety.test.mjs",
  ".github/scripts/pages-reviewed-source.test.mjs",
  ".github/scripts/site-resource-reporter.test.mjs",
  "tests/scripts/check-dev-machine-receipt.test.mjs",
  "tests/scripts/dev-access-guards.test.mjs",
  "tests/scripts/ugc-r2-policy.test.mjs",
  "tests/scripts/write-ugc-consent-config.test.mjs",

  ".github/scripts/ci-classifier.d.mts",
  ".github/scripts/ci-classifier.mjs",
  ".github/scripts/ci-classifier.test.mjs",
  ".github/scripts/identity-boundary-guard.d.mts",
  ".github/scripts/identity-boundary-guard.mjs",
  "site/scripts/workflow-concurrency-guardrail-source.test.ts",
  "site/scripts/workflow-runner-context-guardrail-source.test.ts",
  "site/scripts/workflow-secret-guardrail-source.test.ts",
  "site/src/lib/workflow-secret-guardrail.ts",
  "site/tests/identity-boundary-ci-wiring.test.ts",
  "site/tests/identity-boundary.test.ts",
  "site/tests/public-only-dist-wiring.test.ts",
  "site/tests/workflow-secret-guardrail.test.ts",
  "site/tests/workflow-secret-inherit-guardrail.test.ts",
]);

const SITE_SOURCE_POLICY_PATHS = new Set([
  ".github/scripts/site-resource-reporter.mjs",
  ".github/scripts/metered-api-scan.d.mts",
  ".github/scripts/metered-api-scan.mjs",
]);

const SITE_TESTED_DOCUMENTATION_PATHS = new Set([
  "site/README.md",
  "site/snippets/legacy-redirects/README.md",
]);

const SITE_CONSUMED_ADMIN_FILES = new Set([
  "admin/tests/fixtures/resources/nj-politics.json",
  "admin/tests/fixtures/resources/nj-election-2026.json",
  "admin/src/routes/ShellContext.tsx",
  "admin/src/lib/politics-resource.ts",
  "admin/src/lib/election-directory.ts",
  "admin/src/lib/guide-preview-source.ts",
  "admin/src/styles.css",
]);

// Schedule automation is checked by Site workflow and Python monitor tests.
const SITE_TESTED_MONITOR_PATHS = new Set([
  "scripts/check-schedule-jobs.py",
  ".github/scripts/wait-schedule-ci.sh",
  ".github/scripts/merge-schedule-pr.sh",
  ".github/scripts/admit-schedule-ci.sh",
  "deploy/systemd/njpbs-schedule-monitor.service",
  "deploy/systemd/njpbs-schedule-monitor.timer",
]);

const POLICY_ONLY_WORKFLOWS = new Set([
  ".github/workflows/probe-media-manager.yml",
]);

const SITE_WORKFLOWS = new Set([
  ".github/workflows/pages.yml",
  ".github/workflows/preview.yml",
  ".github/workflows/schedule-bake.yml",
]);

// These workflow contracts span Site and Firebase.
const SITE_FIREBASE_WORKFLOWS = new Set([
  ".github/workflows/dev-anonymous-refusal.yml",
  ".github/workflows/dev-machine-receipt-proof.yml",
  ".github/workflows/dev-staff-gateway-deploy.yml",
  ".github/workflows/pages-fallback-safety.yml",

  ".github/workflows/cms-dev-deploy.yml",
  ".github/workflows/shadow-posts-dev-deploy.yml",
  ".github/workflows/cms-dev-publish.yml",
  ".github/workflows/cms-publish.yml",
]);

const ADMIN_FIREBASE_PATHS = new Set([
  "scripts/benchmark-cms-readonly.cjs",
  "scripts/lib/cms-network-capture.cjs",
  "scripts/lib/cms-network-capture.d.cts",
  "tests/preflight/admin-env-boundary.test.js",
  "tests/preflight/admin-status-manifest.test.js",
  "firebase.json",
  "scripts/admin-e2e-local.mjs",
  "scripts/firebase-emulator-config.d.mts",
  "scripts/firebase-emulator-config.mjs",
  "tests/preflight/admin-e2e-local.test.js",
]);

const ADMIN_PATHS = new Set([
  "scripts/admin-status-manifest.mjs",
  "scripts/deploy-admin.sh",
]);

const SITE_FIREBASE_PATHS = new Set([
  // Site workflow policy tests read the Firestore indexes.
  "firestore.indexes.json",
  "scripts/public-worker-artifact-runtime-v1.txt",
  "scripts/cms-publish-artifact-runtime-v1.txt",
  "scripts/pages-public-artifact-runtime-v1.txt",
  "scripts/prepare-cms-publish-artifact.cjs",
  "scripts/prepare-public-artifact.cjs",
  "site/public/_headers",
  "tests/preflight/cms-publish-artifact-contract.test.js",
  "tests/preflight/cms-publish-deploy-contract.test.js",
  "tests/preflight/pages-public-artifact-contract.test.js",
]);

const FIREBASE_SITE_LOADER_PATHS = new Set([
  "site/package-lock.json",
  "site/package.json",
  "site/src/content.config.ts",
  "site/src/lib/cms-authors-loader.ts",
  "site/src/lib/cms-loader.ts",
  "site/src/lib/cms-posts-loader.ts",
  "site/src/lib/cms-programs-loader.ts",
  "site/src/lib/public-artifact-inventory.ts",
  "site/src/lib/public-worker-artifact.ts",
  "site/src/lib/workflow-projection.ts",
  "site/scripts/upload-public-worker-candidate.ts",
  "site/vitest.e2e.config.ts",
]);

function selected(...names) {
  const result = { ...NO_GATES };
  for (const name of names) result[name] = true;
  return result;
}

function mergeSelections(target, source) {
  for (const gate of CONSUMER_GATES) target[gate] ||= source[gate];
  return target;
}

export function normalizeRepoPath(value) {
  if (typeof value !== "string") return null;
  if (
    !value ||
    value.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("\ufffd") ||
    value.includes("\\")
  ) {
    return null;
  }
  if (value.trim() !== value) return null;
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return value;
}

function isDocsOnlyPath(path) {
  if (path.startsWith("premiere-boardwalk-panel/") && DOC_EXTENSIONS.test(path)) return true;
  const isSiteRuntimeInput = [
    "site/public/",
    "site/src/content/",
    "site/src/data/",
    "site/src/pages/",
  ].some((prefix) => path.startsWith(prefix));
  if (
    path.startsWith("site/") &&
    DOC_EXTENSIONS.test(path) &&
    !isSiteRuntimeInput
  ) {
    return true;
  }
  if (path.startsWith("docs/")) return true;
  if (/^(?:AGENTS|README|SUPPORT)\.md$/i.test(path)) return true;
  if (
    /^(?:admin|cms-api|functions|packages|qa|scripts|tests)\/.*\.(?:md|mdx)$/i.test(
      path,
    )
  ) {
    return true;
  }
  return false;
}

function isDocsGatePath(path) {
  return (
    DOC_EXTENSIONS.test(path) ||
    path === ".lychee.toml" ||
    path === "lychee.toml" ||
    path === "qa/adr_guard.py" ||
    /(^|\/)\.markdownlint(?:-cli2)?(?:\.|$)/.test(path)
  );
}

function isSiteConsumedAdminPath(path) {
  return (
    SITE_CONSUMED_ADMIN_FILES.has(path) ||
    path.startsWith("admin/dev-preview/") ||
    /^admin\/src\/routes\/(?:PoliticsResourceRoute|ElectionsPanel)\.[^/]*$/.test(
      path,
    ) ||
    path.startsWith("admin/src/design-system/")
  );
}

function classifyWorkflow(path) {
  if (POLICY_ONLY_WORKFLOWS.has(path)) return selected();
  if (path === ".github/workflows/ci.yml") return { ...ALL_GATES };
  if (path === ".github/workflows/admin-ci.yml") return selected("admin");
  if (path === ".github/workflows/firebase-ci.yml") return selected("firebase");
  if (path === ".github/workflows/cms-staging-deploy.yml") {
    return selected("admin", "firebase");
  }
  if (SITE_WORKFLOWS.has(path)) return selected("site");
  if (SITE_FIREBASE_WORKFLOWS.has(path)) return selected("site", "firebase");
  return null;
}

/**
 * Classify one normalized repository path. A null result means that no narrow
 * classification is proven and every consumer must run.
 */
export function classifyPath(value) {
  const path = normalizeRepoPath(value);
  if (!path) return null;

  if (path.startsWith(".github/workflows/")) return classifyWorkflow(path);
  if (SITE_SOURCE_POLICY_PATHS.has(path)) return selected("site");
  if (SITE_TESTED_MONITOR_PATHS.has(path)) return selected("site");
  if (SOURCE_POLICY_PATHS.has(path)) {
    return path.startsWith("site/") ? selected("site") : selected();
  }

  // These trees are exercised by the Policy job, before all consumers.
  if (path.startsWith("ops/spotlight-most-read/")) {
    return isDocsGatePath(path) ? selected("docs") : selected();
  }

  if (path.startsWith("crawl-worker/")) {
    return DOC_EXTENSIONS.test(path) ? selected("docs") : selected("firebase");
  }
  if (path.startsWith("premiere-boardwalk-panel/")) {
    return DOC_EXTENSIONS.test(path) ? selected("docs") : selected("firebase");
  }
  if (path === "site/src/styles/design-tokens.css") return selected("site", "admin", "firebase");
  if (path === "admin/public/brand/njpbs-horizontal-white.svg") return selected("admin", "firebase");
  if (SITE_TESTED_DOCUMENTATION_PATHS.has(path)) {
    return selected("docs", "site");
  }
  if (isSiteConsumedAdminPath(path)) {
    const result = selected("site", "admin");
    if (isDocsGatePath(path)) result.docs = true;
    return result;
  }
  if (isDocsOnlyPath(path)) return selected("docs");

  const result = selected();
  if (isDocsGatePath(path)) result.docs = true;

  if (path.startsWith("wiki/")) {
    result.site = true;
    return result;
  }

  if (path.startsWith("packages/"))
    return mergeSelections(result, selected("site", "admin", "firebase"));
  if (path.startsWith("branding/"))
    return mergeSelections(result, selected("site"));
  if (path.startsWith("admin/"))
    return mergeSelections(result, selected("admin"));
  if (path.startsWith("functions/")) {
    return mergeSelections(result, selected("site", "firebase"));
  }
  if (path.startsWith("cms-api/")) {
    return mergeSelections(result, selected("firebase"));
  }
  // Worker/container packages are exercised by Firebase's publisher and preview
  // suites. Site also checks the preview deployment manifests.
  if (/^preview-renderer\/wrangler(?:\.dev)?\.jsonc$/.test(path)) {
    return mergeSelections(result, selected("site", "firebase"));
  }
  // These formerly root-level configs retain their conservative full fallback.
  if (path === "publisher/vitest.config.mts" || path === "preview-renderer/vitest.config.mts") {
    return null;
  }
  if (path.startsWith("publisher/") || path.startsWith("preview-renderer/")) {
    return mergeSelections(result, selected("firebase"));
  }

  if (
    FIREBASE_SITE_LOADER_PATHS.has(path) ||
    path.startsWith("site/tests-e2e/")
  ) {
    return mergeSelections(result, selected("site", "firebase"));
  }
  if (SITE_FIREBASE_PATHS.has(path)) {
    return mergeSelections(result, selected("site", "firebase"));
  }
  if (path.startsWith("site/") || path.startsWith("tests/public-post-runtime/"))
    return mergeSelections(result, selected("site"));
  if (
    ADMIN_FIREBASE_PATHS.has(path) ||
    path.startsWith("scripts/lib/admin-e2e-")
  ) {
    return mergeSelections(result, selected("admin", "firebase"));
  }
  if (ADMIN_PATHS.has(path)) return mergeSelections(result, selected("admin"));
  if (
    path === "scripts/run-firebase-emulators.mjs" ||
    path === "scripts/test-build-free-restore.mjs" ||
    path === "tests/fixtures/build-free-restore.mjs" ||
    path === "scripts/smoke-cms-functions.mjs" ||
    path === "scripts/assert-r2-lifecycle.mjs" ||
    path === "config/functions-configuration.json" ||
    path === "config/functions-deployment.json" ||
    path === "scripts/configure-cms-functions.mjs" ||
    path === "scripts/lib/functions-configuration.mjs" ||
    path === "scripts/lib/functions-secret-versions.mjs" ||
    path === "scripts/backfill-page-seed-media.mjs" ||
    path === "scripts/backfill-media-thumbnails.mjs" ||
    path === "scripts/backfill-byline-projections.mjs" ||
    path === "scripts/inventory-article-posts-read-only.mjs" ||
    path === "scripts/convert-retired-article-to-post.mjs" ||
    path === "scripts/update-publish-status.cjs" ||
    path.startsWith("tests/preflight/") ||
    path.startsWith("tests/functions/") ||
    path.startsWith("tests/rules/") ||
    path.startsWith("tests/helpers/") ||
    path.startsWith("tests/setup/") ||
    path === "tests/public-worker.test.ts" ||
    path === "tests/preview-worker.test.ts"
  ) {
    return mergeSelections(result, selected("firebase"));
  }

  if (
    path === "storage.rules" ||
    path === "workers/src/public-worker.ts" ||
    path === "workers/src/public-worker-configuration.d.ts" ||
    path === "workers/vitest.public-worker.config.mts" ||
    path === "workers/src/preview-worker.ts" ||
    path === "workers/src/preview-worker-configuration.d.ts" ||
    path === "workers/tsconfig.preview-worker.json" ||
    path === "workers/vitest.preview-worker.config.mts" ||
    path === "workers/wrangler.preview.jsonc"
  ) {
    return mergeSelections(result, selected("firebase"));
  }
  if (path === "firebase.json")
    return mergeSelections(result, selected("admin", "firebase"));
  if (path === "workers/wrangler.jsonc")
    return mergeSelections(result, selected("site", "firebase"));
  if (["workers/src/no-build-page-worker.ts", "workers/src/public-page-response-cache.ts", "workers/src/public-no-build-entry.ts"].includes(path)) {
    return mergeSelections(result, selected("site", "firebase"));
  }
  if (path === "package.json" || path === "package-lock.json") {
    return mergeSelections(
      result,
      selected("docs", "site", "admin", "firebase"),
    );
  }
  if (path.startsWith("qa/")) return mergeSelections(result, selected("site"));

  // Site deployment and Admin navigation contracts both read Firestore rules.
  if (
    path === "firestore.rules" ||
    path === ".github/cms-deploy-compatibility.json" ||
    path === ".github/scripts/cms-deploy-compatibility.mjs" ||
    path === ".github/scripts/cms-deploy-compatibility.d.mts"
  ) {
    return mergeSelections(result, selected("site", "admin", "firebase"));
  }

  if (
    path === ".gitignore" ||
    path === ".gitattributes" ||
    path === ".node-version" ||
    path === ".firebaserc.example" ||
    path === ".github/CODEOWNERS" ||
    path === ".github/dependabot.yml" ||
    path === ".github/pull_request_template.md" ||
    path.startsWith(".github/ISSUE_TEMPLATE/") ||
    path.startsWith(".github/DISCUSSION_TEMPLATE/")
  ) {
    return result;
  }

  if (result.docs) return result;

  return null;
}

export function classifyChangedPaths(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return {
      gates: { ...ALL_GATES },
      classification: "fallback",
      reason: "The exact diff did not contain a classifiable path.",
    };
  }

  const gates = { ...ALL_GATES };
  const required = selected();
  for (const value of changedPaths) {
    const path = normalizeRepoPath(value);
    if (!path) {
      return {
        gates: { ...ALL_GATES },
        classification: "fallback",
        reason: "The diff contained an invalid or suspicious path.",
      };
    }
    // Changes to CI or dependency inputs invalidate every narrow selection.
    const pathGates = /^\.github\/(?:workflows|scripts)\//.test(path) ||
      /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)
      ? { ...ALL_GATES }
      : classifyPath(path);
    if (!pathGates) {
      return {
        gates: { ...ALL_GATES },
        classification: "fallback",
        reason: `No narrow classification is proven for ${path}.`,
      };
    }
    mergeSelections(required, pathGates);
  }

  for (const gate of CONSUMER_GATES) {
    if (!required[gate]) gates[gate] = false;
  }

  return { gates, classification: "exact", reason: null };
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function readExactChangedPaths({
  baseSha,
  headRef = "HEAD",
  pullRequestHeadSha,
  pullRequestBaseRef,
  cwd = process.cwd(),
} = {}) {
  if (
    typeof baseSha !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(baseSha) ||
    /^0+$/.test(baseSha)
  ) {
    throw new Error("The event base SHA is missing or invalid.");
  }
  if (git(["rev-parse", "--is-shallow-repository"], cwd).trim() !== "false") {
    throw new Error(
      "The checkout is shallow, so the base diff is not proven complete.",
    );
  }

  const resolvedBase = git(
    ["rev-parse", "--verify", `${baseSha}^{commit}`],
    cwd,
  ).trim();
  const resolvedHead = git(
    ["rev-parse", "--verify", `${headRef}^{commit}`],
    cwd,
  ).trim();
  if (resolvedBase.toLowerCase() !== baseSha.toLowerCase()) {
    throw new Error("The requested base SHA did not resolve exactly.");
  }
  git(["merge-base", "--is-ancestor", resolvedBase, resolvedHead], cwd);

  let diffBase = resolvedBase;
  if (pullRequestHeadSha !== undefined) {
    if (!/^[0-9a-f]{40,64}$/i.test(pullRequestHeadSha)) {
      throw new Error("The event pull request head SHA is missing or invalid.");
    }
    const parents = git(["show", "-s", "--format=%P", resolvedHead], cwd).trim().split(" ");
    if (parents.length !== 2 || parents[1].toLowerCase() !== pullRequestHeadSha.toLowerCase()) {
      throw new Error("The tested merge does not match the event pull request head.");
    }
    // GitHub can rebuild the merge on a newer base without refreshing the
    // event's base SHA. Exclude those base changes only after proving lineage.
    git(["merge-base", "--is-ancestor", resolvedBase, parents[0]], cwd);
    if (typeof pullRequestBaseRef !== "string" || !pullRequestBaseRef) {
      throw new Error("The event pull request base ref is missing.");
    }
    const targetRef = `refs/remotes/origin/${pullRequestBaseRef}`;
    git(["check-ref-format", targetRef], cwd);
    const targetTip = git(["rev-parse", "--verify", `${targetRef}^{commit}`], cwd).trim();
    // Stacked PRs can use the preceding PR's synthetic merge as their base.
    // Equal trees prove the same diff; still bind that base to the target ref
    // so a stale merge after retargeting cannot hide another layer's changes.
    const testedBaseTree = git(["rev-parse", `${parents[0]}^{tree}`], cwd).trim();
    const eventBaseTree = git(["rev-parse", `${resolvedBase}^{tree}`], cwd).trim();
    const targetAncestor = testedBaseTree === eventBaseTree ? resolvedBase : parents[0];
    git(["merge-base", "--is-ancestor", targetAncestor, targetTip], cwd);
    diffBase = parents[0];
  }

  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${diffBase}..${resolvedHead}`,
      "--",
    ],
    {
      cwd,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const fields = new TextDecoder("utf-8", { fatal: true })
    .decode(output)
    .split("\0");
  if (fields.at(-1) !== "")
    throw new Error("The NUL-delimited diff was incomplete.");
  fields.pop();
  const paths = fields.map(normalizeRepoPath);
  if (paths.length === 0 || paths.some((path) => path === null)) {
    throw new Error("The exact diff did not contain a valid changed path.");
  }
  return [...new Set(paths)];
}

function parseSelection(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

export function evaluateFinalAggregation({
  classifierResult,
  selectedGates,
  results,
} = {}) {
  if (!results || results.policy !== "success") {
    throw new Error(
      `The policy gate did not pass (${results?.policy || "missing"}).`,
    );
  }

  const parsed = Object.fromEntries(
    CONSUMER_GATES.map((gate) => [gate, parseSelection(selectedGates?.[gate])]),
  );
  const useFallback =
    classifierResult !== "success" ||
    Object.values(parsed).some((value) => value === null);

  for (const gate of CONSUMER_GATES) {
    const required = useFallback ? true : parsed[gate];
    const result = results[gate];
    if (required && result !== "success") {
      throw new Error(
        `The selected ${gate} gate did not pass (${result || "missing"}).`,
      );
    }
    if (!required && result !== "success" && result !== "skipped") {
      throw new Error(
        `The unselected ${gate} gate ended unexpectedly (${result || "missing"}).`,
      );
    }
  }

  return { ok: true, fallback: useFallback };
}

function writeClassification(result, outputPath) {
  const lines = [
    ...CONSUMER_GATES.map((gate) => `${gate}=${String(result.gates[gate])}`),
    `classification=${result.classification}`,
  ];
  if (outputPath) appendFileSync(outputPath, `${lines.join("\n")}\n`);
  else process.stdout.write(`${JSON.stringify(result)}\n`);
}

function classifyFromEnvironment() {
  try {
    const changedPaths = readExactChangedPaths({
      baseSha: process.env.BASE_SHA,
      headRef: process.env.HEAD_REF || "HEAD",
      pullRequestHeadSha: process.env.GITHUB_EVENT_NAME === "pull_request"
        ? process.env.PR_HEAD_SHA || ""
        : undefined,
      pullRequestBaseRef: process.env.PR_BASE_REF,
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    });
    const result = classifyChangedPaths(changedPaths);
    if (result.classification === "fallback") {
      console.warn(
        `::warning title=CI classification fallback::${result.reason}`,
      );
    }
    writeClassification(result, process.env.GITHUB_OUTPUT);
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error);
    const reason = rawReason.replace(/[\r\n]+/g, " ");
    const result = {
      gates: { ...ALL_GATES },
      classification: "fallback",
      reason,
    };
    console.warn(
      `::warning title=CI classification failure::${reason} Running all consumers.`,
    );
    writeClassification(result, process.env.GITHUB_OUTPUT);
  }
}

function aggregateFromEnvironment() {
  const selectedGates = Object.fromEntries(
    CONSUMER_GATES.map((gate) => [
      gate,
      // config-input: ADMIN_RESULT, ADMIN_SELECTED, DOCS_RESULT, DOCS_SELECTED, FIREBASE_RESULT, FIREBASE_SELECTED, SITE_RESULT
      // config-input: SITE_SELECTED
      process.env[`${gate.toUpperCase()}_SELECTED`],
    ]),
  );
  const results = {
    policy: process.env.POLICY_RESULT,
    ...Object.fromEntries(
      CONSUMER_GATES.map((gate) => [
        gate,
        // config-input: ADMIN_RESULT, ADMIN_SELECTED, DOCS_RESULT, DOCS_SELECTED, FIREBASE_RESULT, FIREBASE_SELECTED, SITE_RESULT
        // config-input: SITE_SELECTED
        process.env[`${gate.toUpperCase()}_RESULT`],
      ]),
    ),
  };
  const result = evaluateFinalAggregation({
    classifierResult: process.env.CLASSIFIER_RESULT,
    selectedGates,
    results,
  });
  console.log(
    result.fallback
      ? "All CI consumers passed after classifier fallback."
      : "All selected CI consumers passed.",
  );
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "classify";
  if (command === "classify") return classifyFromEnvironment();
  if (command === "aggregate") return aggregateFromEnvironment();
  throw new Error(`Unknown ci-classifier command: ${command}`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
