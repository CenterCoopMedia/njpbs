import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  classifyChangedPaths,
  classifyPath,
  evaluateFinalAggregation,
  readExactChangedPaths,
} from "./ci-classifier.mjs";

const githubDirectory = new URL("../", import.meta.url);
const repositoryDirectory = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories = [];

function gates(docs, site, admin, firebase) {
  return { docs, site, admin, firebase };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function workflowPushPaths(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const pathsStart = lines.indexOf("    paths:");
  if (pathsStart === -1) return [];
  const paths = [];
  for (const line of lines.slice(pathsStart + 1)) {
    if (!line.startsWith("      ")) break;
    const match = /^\s{6}-\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    paths.push(match[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
  }
  return paths;
}

after(() => {
  for (const directory of temporaryDirectories)
    rmSync(directory, { recursive: true, force: true });
});

describe("CI path classifier", () => {
  it("keeps shared repository authorization dependencies on full consumer CI", () => {
    for (const path of ["scripts/lib/repository-identity.mjs", "scripts/lib/canonical-repo.sh"]) {
      assert.equal(classifyPath(path), null);
    }
  });
  it("requires every consumer for workflow, CI script and dependency changes", () => {
    for (const path of [
      ".github/workflows/ci.yml", ".github/workflows/admin-ci.yml",
      ".github/workflows/probe-media-manager.yml", ".github/workflows/new.yml",
      ".github/scripts/ci-classifier.mjs", ".github/scripts/ci-tree-reuse.mjs",
      ".github/scripts/new.mjs", "package.json", "package-lock.json",
      "admin/package.json", "site/package-lock.json", "functions/package.json",
      "publisher/pnpm-lock.yaml",
    ]) {
      assert.deepEqual(classifyChangedPaths(["docs/guide.md", path]).gates,
        gates(true, true, true, true), path);
    }
  });

  for (const path of [
    "config/configuration-inputs.json",
    "scripts/check-configuration-inputs.py",
    "tests/scripts/configuration-inputs.test.py",
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
    "ops/spotlight-most-read/rank_requests.py",
    "ops/spotlight-most-read/test_rank_requests.py",
  ]) {
    it(`routes ${path} to Policy`, () => {
      assert.deepEqual(classifyPath(path), gates(false, false, false, false));
      assert.equal(classifyChangedPaths([path]).classification, "exact");
    });
  }

  for (const path of [
    ".github/scripts/site-resource-reporter.mjs",
  ]) {
    it(`routes ${path} to Site`, () => {
      assert.deepEqual(classifyPath(path), gates(false, true, false, false));
      assert.equal(classifyChangedPaths([path]).classification, "exact");
    });
  }

  for (const path of [
    ".github/workflows/dev-anonymous-refusal.yml",
    ".github/workflows/dev-machine-receipt-proof.yml",
    ".github/workflows/dev-staff-gateway-deploy.yml",
    ".github/workflows/pages-fallback-safety.yml",
    ".github/workflows/cms-dev-deploy.yml",
    ".github/workflows/shadow-posts-dev-deploy.yml",
  ]) {
    it(`routes ${path} to Site and Firebase`, () => {
      assert.deepEqual(classifyPath(path), gates(false, true, false, true));
      assert.equal(classifyChangedPaths([path]).classification, "exact");
    });
  }

  for (const path of [
    "scripts/benchmark-cms-readonly.cjs",
    "scripts/lib/cms-network-capture.cjs",
    "scripts/lib/cms-network-capture.d.cts",
    "tests/preflight/admin-env-boundary.test.js",
    "tests/preflight/admin-status-manifest.test.js",
    "tests/preflight/admin-e2e-local.test.js",
  ]) {
    it(`routes ${path} to Admin and Firebase`, () => {
      assert.deepEqual(classifyPath(path), gates(false, false, true, true));
      assert.equal(classifyChangedPaths([path]).classification, "exact");
    });
  }

  for (const path of [
    "tests/preflight/admin-deploy-identity.test.js",
    "tests/preflight/cms-deploy-smoke.test.js",
    "tests/preflight/new-suite.test.js",
  ]) {
    it(`routes ${path} to Firebase preflight`, () => {
      assert.deepEqual(classifyPath(path), gates(false, false, false, true));
      assert.equal(classifyChangedPaths([path]).classification, "exact");
    });
  }

  it("keeps the compiled public Page response path in Site and Firebase", () => {
    for (const path of ["workers/src/no-build-page-worker.ts", "workers/src/public-page-response-cache.ts", "workers/src/public-no-build-entry.ts"]) {
      assert.deepEqual(classifyPath(path), gates(false, true, false, true));
      assert.equal(classifyChangedPaths([path]).classification, "exact");
    }
  });
  it("keeps policy operations documentation in Docs", () => {
    for (const path of ["ops/spotlight-most-read/HOST_CONTRACT.md"]) {
      assert.deepEqual(classifyPath(path), gates(true, false, false, false));
    }
  });
  it("runs the Worker package suites without unrelated Site or Admin consumers", () => {
    for (const path of ["publisher/worker.ts", "publisher/withdrawal-catalog.ts", "publisher/pending-work.test.ts",
      "publisher/package-lock.json", "publisher/Dockerfile", "preview-renderer/pending-work.ts",
      "preview-renderer/record-code-source.ts", "preview-renderer/package-lock.json"]) {
      assert.deepEqual(classifyPath(path), gates(false, false, false, true));
      assert.equal(classifyChangedPaths([path]).classification, "exact");
    }
    for (const path of ["preview-renderer/wrangler.jsonc", "preview-renderer/wrangler.dev.jsonc"]) {
      assert.deepEqual(classifyPath(path), gates(false, true, false, true));
    }
  });
  it("retains full fallback for the relocated root runtime test configs", () => {
    for (const path of ["publisher/vitest.config.mts", "preview-renderer/vitest.config.mts"]) {
      assert.equal(classifyPath(path), null);
      assert.equal(classifyChangedPaths([path]).classification, "fallback");
      assert.deepEqual(classifyChangedPaths([path]).gates, gates(true, true, true, true));
    }
  });
  it("runs only Site for the isolated public Post runtime package", () => {
    for (const path of ["tests/public-post-runtime/package.json", "tests/public-post-runtime/package-lock.json",
      "tests/public-post-runtime/tsconfig.json", "tests/public-post-runtime/public-post-runtime.test.ts"]) {
      assert.deepEqual(classifyPath(path), gates(false, true, false, false));
    }
  });
  it("keeps documentation on policy and docs only", () => {
    assert.deepEqual(
      classifyPath("docs/decisions/README.md"),
      gates(true, false, false, false),
    );
    assert.deepEqual(
      classifyPath("docs/collaboration/README.md"),
      gates(true, false, false, false),
    );
    assert.deepEqual(
      classifyPath("premiere-boardwalk-panel/README.md"),
      gates(true, false, false, false),
    );
    assert.deepEqual(
      classifyPath("admin/README.md"),
      gates(true, false, false, false),
    );
    assert.deepEqual(
      classifyPath("site/README.md"),
      gates(true, true, false, false),
    );
    assert.deepEqual(
      classifyPath("site/snippets/legacy-redirects/README.md"),
      gates(true, true, false, false),
    );
    assert.deepEqual(
      classifyPath("site/worker/README.md"),
      gates(true, false, false, false),
    );
    assert.deepEqual(
      classifyPath("site/src/content/pages/about.md"),
      gates(true, true, false, false),
    );
    assert.deepEqual(
      classifyPath("site/public/release-notes.md"),
      gates(true, true, false, false),
    );
  });

  it("routes own-site crawl source to Firebase and its documentation to Docs", () => {
    for (const path of ["src/index.mjs", "package.json", "package-lock.json", "wrangler.jsonc", "test/worker.test.mjs"]) {
      assert.deepEqual(classifyPath(`crawl-worker/${path}`), gates(false, false, false, true));
    }
    assert.deepEqual(classifyPath("crawl-worker/test/fixtures/README.md"), gates(true, false, false, false));
  });

  it("runs desktop panel contracts and build in the Firebase consumer", () => {
    for (const path of ["manifest.json", "index.js", "index.html", "package-lock.json", "tests/transfer.test.cjs"]) {
      assert.deepEqual(classifyPath(`premiere-boardwalk-panel/${path}`), gates(false, false, false, true));
    }
    assert.deepEqual(classifyPath("site/src/styles/design-tokens.css"), gates(false, true, true, true));
    assert.deepEqual(classifyPath("admin/public/brand/njpbs-horizontal-white.svg"), gates(false, false, true, true));
  });

  it("routes public wiki and site data through the site consumer", () => {
    assert.deepEqual(
      classifyPath("wiki/org/nj-pbs.md"),
      gates(true, true, false, false),
    );
    assert.deepEqual(
      classifyPath("site/src/data/schedule.json"),
      gates(false, true, false, false),
    );
    assert.deepEqual(
      classifyPath("site/public/logo.svg"),
      gates(false, true, false, false),
    );
  });

  it("runs both synthetic politics preview inputs through Site and Admin", () => {
    for (const path of ["admin/tests/fixtures/resources/nj-politics.json", "admin/tests/fixtures/resources/nj-election-2026.json"]) {
      assert.deepEqual(classifyPath(path), gates(false, true, true, false));
      assert.equal(classifyChangedPaths([path]).gates.site, true);
    }
  });

  it("runs every shared Admin input used by preview artifacts through both consumers", () => {
    const devWorkflow = readFileSync(
      new URL("workflows/preview.yml", githubDirectory),
      "utf8",
    );
    const patterns = workflowPushPaths(devWorkflow).filter((path) =>
      path.startsWith("admin/"),
    );
    assert.ok(patterns.length > 0, "Preview workflow has no shared Admin inputs");

    for (const pattern of patterns) {
      const paths = globSync(pattern, { cwd: repositoryDirectory }).filter(
        (path) => statSync(join(repositoryDirectory, path)).isFile(),
      );
      assert.ok(paths.length > 0, `${pattern} does not match a repository file`);
      for (const path of paths) {
        const selection = classifyPath(path);
        assert.equal(selection?.site, true, `${path} must run Site`);
        assert.equal(selection?.admin, true, `${path} must run Admin`);
      }
    }
  });

  it("checks site and Firebase contracts when dev publication changes", () => {
    assert.deepEqual(classifyPath(".github/workflows/cms-dev-publish.yml"), gates(false, true, false, true));
  });

  it("routes the schedule observer and its tests to Site, with its runbooks on Docs", () => {
    const sitePaths = [
      "scripts/check-schedule-jobs.py",
      ".github/scripts/wait-schedule-ci.sh",
      ".github/scripts/merge-schedule-pr.sh",
      ".github/scripts/admit-schedule-ci.sh",
      "deploy/systemd/njpbs-schedule-monitor.service",
      "deploy/systemd/njpbs-schedule-monitor.timer",
      ".github/workflows/schedule-bake.yml",
      "site/tests/schedule-bake-workflow.test.ts",
      "site/tests/schedule-job-monitor.test.py",
      "site/tests/schedule-job-monitor.test.ts",
    ];
    const docsPaths = [
      "docs/decisions/README.md",
      "docs/collaboration/README.md",
    ];
    for (const path of sitePaths) {
      assert.deepEqual(classifyPath(path), gates(false, true, false, false), path);
    }
    for (const path of docsPaths) {
      assert.deepEqual(classifyPath(path), gates(true, false, false, false), path);
    }
    assert.deepEqual(classifyChangedPaths([...sitePaths, ...docsPaths]), {
      gates: gates(true, true, true, true),
      classification: "exact",
      reason: null,
    });
  });

  it("routes shared packages to all code consumers", () => {
    assert.deepEqual(
      classifyPath("packages/content-core/src/content-model.ts"),
      gates(false, true, true, true),
    );
  });

  it("keeps cross-package Functions and root manifests on every consumer they can affect", () => {
    assert.deepEqual(
      classifyPath("functions/lib/publish.js"),
      gates(false, true, false, true),
    );
    assert.deepEqual(
      classifyPath("package.json"),
      gates(true, true, true, true),
    );
    assert.deepEqual(
      classifyPath("package-lock.json"),
      gates(true, true, true, true),
    );
  });

  it("routes loader and artifact contracts to both of their consumers", () => {
    for (const path of [
      "site/src/lib/cms-loader.ts",
      "site/src/lib/public-artifact-inventory.ts",
      "site/src/lib/public-worker-artifact.ts",
      "site/src/lib/workflow-projection.ts",
      "site/scripts/upload-public-worker-candidate.ts",
      "scripts/public-worker-artifact-runtime-v1.txt",
      "site/tests-e2e/loader.e2e.test.ts",
      "scripts/prepare-public-artifact.cjs",
      "tests/preflight/cms-publish-artifact-contract.test.js",
      "tests/preflight/cms-publish-deploy-contract.test.js",
    ]) {
      assert.deepEqual(
        classifyPath(path),
        gates(false, true, false, true),
        path,
      );
    }
  });

  it("routes storage rules, preview workers to Firebase", () => {
    for (const path of [
      "storage.rules",
      "workers/src/preview-worker.ts",
      "workers/src/preview-worker-configuration.d.ts",
      "tests/preview-worker.test.ts",
      "scripts/test-build-free-restore.mjs",
      "tests/fixtures/build-free-restore.mjs",
      "workers/tsconfig.preview-worker.json",
      "workers/vitest.preview-worker.config.mts",
      "workers/wrangler.preview.jsonc",
    ]) {
      assert.deepEqual(
        classifyPath(path),
        gates(false, false, false, true),
        path,
      );
    }
  });

  // Site compatibility tests read the rules, manifest and validator; workflow
  // policy tests also read the Firestore indexes.
  for (const [path, admin] of [
    ["firestore.rules", true],
    ["firestore.indexes.json", false],
    [".github/cms-deploy-compatibility.json", true],
    [".github/scripts/cms-deploy-compatibility.mjs", true],
    [".github/scripts/cms-deploy-compatibility.d.mts", true],
  ]) {
    it(`selects Site for a standalone change to ${path}`, () => {
      assert.deepEqual(
        classifyChangedPaths([path]),
        { gates: gates(path.startsWith(".github/scripts/"), true, admin, true), classification: "exact", reason: null },
      );
    });
  }

  it("requires Site for the rules-only change from #3007", () => {
    const selection = classifyChangedPaths([
      "firestore.rules",
      "tests/rules/firestore-rules.test.js",
    ]);
    assert.deepEqual(selection, {
      gates: gates(false, true, true, true), classification: "exact", reason: null,
    });
    assert.throws(() => evaluateFinalAggregation({
      classifierResult: "success",
      selectedGates: selection.gates,
      results: {
        policy: "success", docs: "skipped", site: "skipped",
        admin: "success", firebase: "success",
      },
    }), /selected site gate did not pass/);
  });

  it("routes directly tested infrastructure through the site consumer", () => {
    for (const path of [
      ".github/scripts/metered-api-scan.mjs",
      ".github/scripts/metered-api-scan.d.mts",
    ]) {
      assert.deepEqual(
        classifyPath(path),
        gates(false, true, false, false),
        path,
      );
    }
  });

  it("distinguishes policy-only workflows from build and deploy workflows", () => {
    for (const path of [
      ".github/workflows/probe-media-manager.yml",
    ]) {
      assert.deepEqual(
        classifyPath(path),
        gates(false, false, false, false),
        path,
      );
    }
    assert.deepEqual(
      classifyPath("site/tests/public-only-dist-wiring.test.ts"),
      gates(false, true, false, false),
    );
    assert.deepEqual(
      classifyPath("site/src/lib/workflow-secret-guardrail.ts"),
      gates(false, true, false, false),
    );
    for (const path of [
      ".github/workflows/pages.yml",
      ".github/workflows/preview.yml",
      ".github/workflows/schedule-bake.yml",
    ]) {
      assert.deepEqual(
        classifyPath(path),
        gates(false, true, false, false),
        path,
      );
    }
    assert.deepEqual(
      classifyPath(".github/workflows/admin-ci.yml"),
      gates(false, false, true, false),
    );
    assert.deepEqual(
      classifyPath(".github/workflows/firebase-ci.yml"),
      gates(false, false, false, true),
    );
    assert.deepEqual(
      classifyPath(".github/workflows/cms-staging-deploy.yml"),
      gates(false, false, true, true),
    );
    for (const path of [
      ".github/workflows/cms-publish.yml",
    ]) {
      assert.deepEqual(
        classifyPath(path),
        gates(false, true, false, true),
        path,
      );
    }
    assert.equal(classifyPath(".github/workflows/new-workflow.yml"), null);
  });

  it("unions mixed changes and sends an unknown path to every consumer", () => {
    assert.deepEqual(
      classifyChangedPaths(["docs/decisions/README.md", "admin/src/App.tsx"]),
      {
        gates: gates(true, false, true, false),
        classification: "exact",
        reason: null,
      },
    );
    assert.deepEqual(
      classifyChangedPaths(["new-unclassified-format.xyz"]).gates,
      gates(true, true, true, true),
    );
    assert.equal(
      classifyChangedPaths(["new-unclassified-format.xyz"]).classification,
      "fallback",
    );
    assert.deepEqual(
      classifyChangedPaths([]).gates,
      gates(true, true, true, true),
    );
    for (const path of [
      "LICENSE",
      "scripts/new-tool.mjs",
      "scripts/check-other-job.py",
      "scripts/refresh-spotlight-news.sh",
      "scripts/enqueue-cms-publication-baseline.sh",
      "scripts/report-cms-publication-healthcheck.sh",
      "deploy/systemd/new-monitor.service",
      "deploy/systemd/njpbs-cms-publisher.service",
      "deploy/systemd/njpbs-schedule-refresh.service",
      "tests/new-family/test.js",
      "some-unknown-plugin/manifest.json",
    ]) {
      assert.equal(classifyPath(path), null, path);
      assert.deepEqual(
        classifyChangedPaths([path]).gates,
        gates(true, true, true, true),
      );
    }
  });

  it("does not rewrite suspicious diff paths into a trusted classification", () => {
    for (const path of [
      " site/src/pages/index.astro",
      "site/src/pages/index.astro ",
      "site\\src\\pages\\index.astro",
      "site/src/pages/index.astro\n.github/workflows/ci.yml",
      "../site/index.astro",
      "site/worker/\ufffd.md",
    ]) {
      assert.equal(classifyPath(path), null, path);
      assert.equal(classifyChangedPaths([path]).classification, "fallback");
    }
  });

  it("reads an exact base diff with renames exposed as delete and add paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "njpbs-ci-classifier-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "-q");
    git(directory, "config", "user.name", "CI test");
    git(directory, "config", "user.email", "ci@example.org");
    writeFileSync(join(directory, "old.md"), "old\n");
    writeFileSync(join(directory, "delete.rules"), "old\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");
    const baseSha = git(directory, "rev-parse", "HEAD");
    git(directory, "mv", "old.md", "new.md");
    rmSync(join(directory, "delete.rules"));
    writeFileSync(join(directory, "site.ts"), "export {};\n");
    git(directory, "add", "-A");
    git(directory, "commit", "-qm", "head");

    assert.deepEqual(
      readExactChangedPaths({ baseSha, cwd: directory }).sort(),
      ["delete.rules", "new.md", "old.md", "site.ts"],
    );
    assert.throws(
      () => readExactChangedPaths({ baseSha: "0".repeat(40), cwd: directory }),
      /event base SHA is missing or invalid/,
    );
  });

  it("classifies the tested PR delta across stale base events and restacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "njpbs-ci-pr-base-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "-q");
    git(directory, "config", "user.name", "CI test");
    git(directory, "config", "user.email", "ci@example.invalid");
    writeFileSync(join(directory, "README.md"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "Event base");
    const eventBase = git(directory, "rev-parse", "HEAD");
    writeFileSync(join(directory, "README.md"), "docs change\n");
    git(directory, "commit", "-qam", "PR docs");
    let prHead = git(directory, "rev-parse", "HEAD");
    git(directory, "checkout", "-q", "--detach", eventBase);
    // Real run #42048265262 tested newer main code than its event base named.
    writeFileSync(join(directory, "unknown-runtime.js"), "new main code\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "Main advances");
    const currentBase = git(directory, "rev-parse", "HEAD");
    git(directory, "update-ref", "refs/remotes/origin/main", currentBase);
    git(directory, "merge", "-q", "--no-ff", prHead, "-m", "Tested PR merge");
    const testedMerge = git(directory, "rev-parse", "HEAD");
    assert.deepEqual(classifyChangedPaths(readExactChangedPaths({
      baseSha: eventBase, headRef: testedMerge, cwd: directory,
    })).gates, gates(true, true, true, true));

    const classify = (baseSha, headRef, pullRequestHeadSha, baseRef = "main") => {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("ci-classifier.mjs", import.meta.url)), "classify",
      ], { cwd: directory, encoding: "utf8", env: {
        ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "",
        GITHUB_WORKSPACE: directory, BASE_SHA: baseSha, HEAD_REF: headRef,
        PR_HEAD_SHA: pullRequestHeadSha,
        PR_BASE_REF: baseRef,
      } });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const expected = { gates: gates(true, false, false, false), classification: "exact", reason: null };
    for (const action of ["opened", "reopened", "synchronize", "edited"]) {
      // Exercise the workflow's PR head binding for each event type.
      const workflow = readFileSync(new URL("workflows/ci.yml", githubDirectory), "utf8");
      const expression = workflow.match(/PR_HEAD_SHA: \$\{\{ (.+) \}\}/)?.[1];
      assert.ok(expression);
      const head = runInNewContext(expression, { github: { event: {
        action, pull_request: { head: { sha: prHead } },
      } } });
      assert.deepEqual(classify(eventBase, testedMerge, head), expected, action);
    }
    // A restack creates a new PR head and a new exact tested merge.
    git(directory, "checkout", "-q", "--detach", currentBase);
    writeFileSync(join(directory, "README.md"), "restacked docs\n");
    git(directory, "commit", "-qam", "Restacked PR docs");
    prHead = git(directory, "rev-parse", "HEAD");
    git(directory, "checkout", "-q", "--detach", currentBase);
    git(directory, "merge", "-q", "--no-ff", prHead, "-m", "Restacked tested merge");
    assert.deepEqual(classify(currentBase, "HEAD", prHead), expected);

    // A stale merge into the previous stack base must not hide that layer
    // after the PR is retargeted to main, even when main is its ancestor.
    git(directory, "checkout", "-q", "--detach", currentBase);
    writeFileSync(join(directory, "stack-runtime.js"), "stack runtime\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "Stack base code");
    const stackBase = git(directory, "rev-parse", "HEAD");
    git(directory, "update-ref", "refs/remotes/origin/stack-a", stackBase);
    writeFileSync(join(directory, "README.md"), "stack docs\n");
    git(directory, "commit", "-qam", "Stack PR docs");
    const stackHead = git(directory, "rev-parse", "HEAD");
    git(directory, "checkout", "-q", "--detach", stackBase);
    git(directory, "merge", "-q", "--no-ff", stackHead, "-m", "Old stack merge");
    assert.deepEqual(classify(stackBase, "HEAD", stackHead, "stack-a"), expected);
    for (const baseRef of ["main", "missing-target", "../invalid", ""]) {
      const result = classify(currentBase, "HEAD", stackHead, baseRef);
      assert.equal(result.classification, "fallback", baseRef);
      assert.deepEqual(result.gates, gates(true, true, true, true));
    }

    for (const [base, merge, head] of [
      [eventBase, testedMerge, ""], [eventBase, testedMerge, prHead],
      [eventBase, prHead, prHead], [prHead, testedMerge, prHead],
    ]) {
      const result = classify(base, merge, head);
      assert.equal(result.classification, "fallback");
      assert.deepEqual(result.gates, gates(true, true, true, true));
    }
  });

  it("selects only Site for each layer merged onto an equivalent synthetic stack base", () => {
    // Runs #42725263178, #42725264134, #42725265217 and #42725752300
    // use the previous PR's merge commit as their first parent, while the
    // event base names that PR's branch head. Their trees are identical.
    const directory = mkdtempSync(join(tmpdir(), "njpbs-ci-stack-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "-q");
    git(directory, "config", "user.name", "CI test");
    git(directory, "config", "user.email", "ci@example.invalid");
    writeFileSync(join(directory, "README.md"), "main\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "Main");
    let testedBase = git(directory, "rev-parse", "HEAD");
    mkdirSync(join(directory, "site/src/data"), { recursive: true });
    mkdirSync(join(directory, "site/tests"), { recursive: true });
    const paths = ["site/src/data/njpbs-data-hub-v16.html", "site/tests/data-hub-reader.test.ts"];
    for (const path of paths) writeFileSync(join(directory, path), "base layer\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "Stack base");
    let eventBase = git(directory, "rev-parse", "HEAD");
    git(directory, "checkout", "-q", "--detach", testedBase);
    git(directory, "merge", "-q", "--no-ff", eventBase, "-m", "Synthetic stack base");
    testedBase = git(directory, "rev-parse", "HEAD");

    for (let layer = 1; layer <= 4; layer++) {
      git(directory, "update-ref", "refs/remotes/origin/stack-base", eventBase);
      git(directory, "checkout", "-q", "--detach", eventBase);
      for (const path of paths) writeFileSync(join(directory, path), `layer ${layer}\n`);
      git(directory, "commit", "-qam", `Stack layer ${layer}`);
      const prHead = git(directory, "rev-parse", "HEAD");
      git(directory, "checkout", "-q", "--detach", testedBase);
      git(directory, "merge", "-q", "--no-ff", prHead, "-m", `Synthetic merge ${layer}`);
      const testedMerge = git(directory, "rev-parse", "HEAD");
      assert.notEqual(testedBase, eventBase);
      assert.equal(git(directory, "rev-parse", `${testedBase}^{tree}`),
        git(directory, "rev-parse", `${eventBase}^{tree}`));

      const classify = () => {
        const result = spawnSync(process.execPath, [
          fileURLToPath(new URL("ci-classifier.mjs", import.meta.url)), "classify",
        ], { cwd: directory, encoding: "utf8", env: {
          ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "",
          GITHUB_WORKSPACE: directory, BASE_SHA: eventBase, HEAD_REF: testedMerge,
          PR_HEAD_SHA: prHead, PR_BASE_REF: "stack-base",
        } });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      };
      const expected = { gates: gates(false, true, false, false), classification: "exact", reason: null };
      assert.deepEqual(classify(), expected, `layer ${layer}`);
      assert.deepEqual(readExactChangedPaths({ baseSha: eventBase, headRef: testedMerge,
        pullRequestHeadSha: prHead, pullRequestBaseRef: "stack-base", cwd: directory }).sort(), paths);

      // A branch can advance after checkout without changing the tested layer.
      git(directory, "checkout", "-q", "--detach", eventBase);
      writeFileSync(join(directory, "unknown-runtime.js"), `later base ${layer}\n`);
      git(directory, "add", ".");
      git(directory, "commit", "-qm", "Base advances");
      git(directory, "update-ref", "refs/remotes/origin/stack-base", "HEAD");
      assert.deepEqual(classify(), expected, `advanced base ${layer}`);

      // A synthetic base with extra code must not hide that code from CI.
      git(directory, "checkout", "-q", "--detach", testedBase);
      writeFileSync(join(directory, "unknown-runtime.js"), "unproven merge-base code\n");
      git(directory, "add", ".");
      git(directory, "commit", "-qm", "Divergent synthetic base");
      git(directory, "merge", "-q", "--no-ff", prHead, "-m", "Unproven tested merge");
      assert.throws(() => readExactChangedPaths({ baseSha: eventBase,
        pullRequestHeadSha: prHead, pullRequestBaseRef: "stack-base", cwd: directory }),
      /Command failed: git merge-base --is-ancestor/);
      eventBase = prHead;
      testedBase = testedMerge;
    }
  });

  it("classifies the full push range and runs all consumers when before is unusable", () => {
    const directory = mkdtempSync(join(tmpdir(), "njpbs-ci-push-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "-q");
    git(directory, "config", "user.name", "CI test");
    git(directory, "config", "user.email", "ci@example.org");
    writeFileSync(join(directory, "README.md"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");
    const pushEvent = { before: git(directory, "rev-parse", "HEAD") };
    writeFileSync(join(directory, "README.md"), "updated\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "docs change");
    mkdirSync(join(directory, "admin"));
    writeFileSync(join(directory, "admin", "app.ts"), "export {};\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "admin change");

    const classifyPush = (before) => {
      const outputPath = join(directory, "classification.txt");
      writeFileSync(outputPath, "");
      execFileSync(process.execPath, [
        fileURLToPath(new URL("ci-classifier.mjs", import.meta.url)),
        "classify",
      ], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          BASE_SHA: before,
          HEAD_REF: "HEAD",
          GITHUB_WORKSPACE: directory,
          GITHUB_OUTPUT: outputPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return Object.fromEntries(
        readFileSync(outputPath, "utf8").trim().split("\n").map((line) => line.split("=")),
      );
    };

    assert.deepEqual(classifyPush(pushEvent.before), {
      docs: "true", site: "false", admin: "true", firebase: "false",
      classification: "exact",
    });
    // First pushes, unavailable bases and rewritten history must fail closed.
    git(directory, "checkout", "-q", "--orphan", "rewritten");
    git(directory, "commit", "-qm", "unrelated history");
    for (const before of ["", "0".repeat(40), "f".repeat(40), pushEvent.before]) {
      assert.deepEqual(classifyPush(before), {
        docs: "true", site: "true", admin: "true", firebase: "true",
        classification: "fallback",
      });
    }
  });
});

describe("Final CI aggregation", () => {
  const selected = {
    docs: "true",
    site: "false",
    admin: "true",
    firebase: "false",
  };

  it("passes when every selected gate passes and other gates skip", () => {
    assert.deepEqual(
      evaluateFinalAggregation({
        classifierResult: "success",
        selectedGates: selected,
        results: {
          policy: "success",
          docs: "success",
          site: "skipped",
          admin: "success",
          firebase: "skipped",
        },
      }),
      { ok: true, fallback: false },
    );
  });

  it("fails when policy or a selected gate does not pass", () => {
    assert.throws(
      () =>
        evaluateFinalAggregation({
          classifierResult: "success",
          selectedGates: selected,
          results: { policy: "failure" },
        }),
      /policy gate did not pass/,
    );
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.throws(
        () =>
          evaluateFinalAggregation({
            classifierResult: "success",
            selectedGates: selected,
            results: {
              policy: "success",
              docs: result,
              site: "skipped",
              admin: "success",
              firebase: "skipped",
            },
          }),
        /selected docs gate did not pass/,
      );
    }
  });

  it("requires every consumer after a classifier failure", () => {
    assert.deepEqual(
      evaluateFinalAggregation({
        classifierResult: "failure",
        selectedGates: {},
        results: {
          policy: "success",
          docs: "success",
          site: "success",
          admin: "success",
          firebase: "success",
        },
      }),
      { ok: true, fallback: true },
    );
    assert.throws(
      () =>
        evaluateFinalAggregation({
          classifierResult: "failure",
          selectedGates: {},
          results: {
            policy: "success",
            docs: "success",
            site: "skipped",
            admin: "success",
            firebase: "success",
          },
        }),
      /selected site gate did not pass/,
    );
  });

  it("runs release-gate contracts for Pages-only changes", () => {
    assert.equal(classifyChangedPaths([".github/workflows/pages.yml"]).gates.site, true);
    const ci = readFileSync(new URL("workflows/ci.yml", githubDirectory), "utf8");
    const policy = ci.split("\n  policy:\n", 2)[1].split("\n  docs:\n", 1)[0];
    const releaseTests = policy.split(/\n      - /).find(step =>
      step.includes("node --test") && step.includes(".github/scripts/require-main-ci.test.mjs"));
    assert.ok(releaseTests, "Pages-only changes must run release-gate contracts in Policy");
    assert.match(releaseTests, /if: steps\.reuse\.outputs\.reused != 'true'/);
    assert.doesNotMatch(releaseTests, /outputs\.(?:site|firebase|admin|docs)/);
    assert.ok(policy.indexOf("npm ci --ignore-scripts") < policy.indexOf(releaseTests),
      "The site install must supply yaml before release-gate contracts run");
  });

  it("keeps the primary PR workflow unfiltered with one final ci job", () => {
    const ci = readFileSync(
      new URL("workflows/ci.yml", githubDirectory),
      "utf8",
    );
    const admin = readFileSync(
      new URL("workflows/admin-ci.yml", githubDirectory),
      "utf8",
    );
    const firebase = readFileSync(
      new URL("workflows/firebase-ci.yml", githubDirectory),
      "utf8",
    );
    assert.match(ci, /on:\n  pull_request:\n    types:/);
    assert.match(ci, /\n  push:\n    branches: \[main\]/);
    assert.ok(ci.includes("BASE_SHA: ${{ (github.event_name == 'merge_group' && github.event.merge_group.base_sha) || github.event_name == 'push' && github.event.before || github.event.pull_request.base.sha }}"));
    for (const gate of ["docs", "site", "admin", "firebase"]) {
      assert.ok(ci.includes(
        `${gate}: \${{ (github.event_name == 'push' || github.event_name == 'merge_group') && 'true' || steps.changes.outputs.${gate} || steps.defaults.outputs.${gate} }}`,
      ), `Main pushes and merge groups must require ${gate}`);
    }
    assert.doesNotMatch(
      ci.split("permissions:", 1)[0],
      /\n\s+paths(?:-ignore)?:/,
    );
    assert.doesNotMatch(admin, /^\s*pull_request:/m);
    assert.doesNotMatch(firebase, /^\s*pull_request:/m);
    assert.match(admin, /^\s*workflow_call:/m);
    assert.match(firebase, /^\s*workflow_call:/m);

    const policyJob = ci
      .split("\n  policy:\n", 2)[1]
      ?.split("\n  docs:\n", 1)[0];
    assert.ok(policyJob, "Policy job is missing");
    assert.match(
      policyJob,
      /- name: Classify the exact base diff[\s\S]*?node "\$RUNNER_TEMP\/ci-classifier\.mjs" classify\n\s+- name: Metered-API source scan \(before any scanned code runs\)\n\s+run: node \.github\/scripts\/metered-api-scan\.mjs/,
    );
    assert.ok(
      policyJob.indexOf('node "$RUNNER_TEMP/ci-classifier.mjs" classify') <
        policyJob.indexOf("node .github/scripts/metered-api-scan.mjs"),
      "Trusted classification must run before PR code",
    );
    assert.ok(policyJob.includes('git show "$TRUSTED_SHA:.github/scripts/ci-classifier.mjs"'));
    assert.ok(policyJob.includes('node "$RUNNER_TEMP/ci-classifier.mjs" classify'));
    assert.ok(policyJob.includes("TRUSTED_SHA: ${{ (github.event_name == 'merge_group' && github.event.merge_group.base_sha) || github.event.pull_request.base.sha || (github.event_name == 'push' && github.sha) || format('origin/{0}', github.event.repository.default_branch) }}"));
    assert.ok(policyJob.includes('HEAD_REF: ${{ github.sha }}'));
    assert.ok(policyJob.includes('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}'));
    assert.ok(policyJob.includes('PR_BASE_REF: ${{ github.event.pull_request.base.ref }}'));
    assert.match(
      policyJob,
      /id: changes\n\s+continue-on-error: true/,
    );

    for (const gate of ["docs", "site", "admin", "firebase"]) {
      const consumerJob = ci
        .split(`\n  ${gate}:\n`, 2)[1]
        ?.split(/\n  [a-z]+:\n/, 1)[0];
      assert.ok(consumerJob, `${gate} job is missing`);
      assert.match(
        consumerJob,
        /if: >-\n\s+!cancelled\(\) &&/,
        `${gate} must stop when the workflow is cancelled`,
      );
    }

    const finalJob = ci.split("\n  ci:\n", 2)[1];
    assert.ok(finalJob, "Final ci job is missing");
    const finalName = finalJob.match(/^    name: \$\{\{ (.+) \}\}$/m)?.[1];
    assert.ok(finalName, "Final check name expression is missing");
    for (const action of ["opened", "reopened", "synchronize", "edited"]) {
      assert.equal(runInNewContext(finalName, {
        github: { event_name: "pull_request", event: {
          action, changes: { base: { ref: { from: "old-target" } } },
        } },
      }), "ci", `${action} code validation must retain the required ci name`);
    }
    assert.match(finalJob, /if: always\(\)/);
    assert.match(
      finalJob,
      /needs: \[policy, docs, site, admin, firebase\]/,
    );
    assert.match(
      finalJob,
      /node \.github\/scripts\/ci-classifier\.mjs aggregate/,
    );
  });
});

describe("CI classifier trust boundary", () => {
  const workflow = readFileSync(
    new URL("workflows/ci.yml", githubDirectory), "utf8",
  );
  const finalJob = workflow.split("\n  ci:\n", 2)[1];
  const classifyStep = workflow.split("- name: Classify the exact base diff", 2)[1]
    .split(/\n      - /, 1)[0];
  const classifyCommand = classifyStep.match(/run: (.+)/)[1] === "|"
    ? classifyStep.split("run: |\n", 2)[1].trim().replace(/^\s+/gm, "")
    : classifyStep.match(/run: (.+)/)[1];
  const trustedRef = classifyStep.match(/TRUSTED_SHA: \$\{\{ (.+) \}\}/)?.[1];
  const headRef = classifyStep.match(/HEAD_REF: \$\{\{ (.+) \}\}/)?.[1];
  const checkoutRef = finalJob.match(/^\s+ref: \$\{\{ (.+) \}\}$/m)?.[1];
  const aggregateCommand = finalJob.split("- name: Require every selected CI gate", 2)[1].match(/^\s+run: (.+)$/m)[1];
  const directory = mkdtempSync(join(tmpdir(), "njpbs-ci-trust-"));
  temporaryDirectories.push(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Test contributor");
  git(directory, "config", "user.email", "contributor@example.org");
  mkdirSync(join(directory, ".github/scripts"), { recursive: true });
  const classifierPath = join(directory, ".github/scripts/ci-classifier.mjs");
  writeFileSync(classifierPath, readFileSync(new URL("ci-classifier.mjs", import.meta.url)));
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "Trusted base");
  const baseSha = git(directory, "rev-parse", "HEAD");
  git(directory, "update-ref", "refs/remotes/origin/main", baseSha);
  writeFileSync(join(directory, "README.md"), "Docs-only decoy\n");
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "Docs-only decoy");
  const decoySha = git(directory, "rev-parse", "HEAD");
  git(directory, "checkout", "-q", "--detach", baseSha);
  // The PR deselects every consumer and approves every aggregate result.
  writeFileSync(classifierPath, `import { appendFileSync } from "node:fs";
if (process.argv[2] === "classify") {
  appendFileSync(process.env.GITHUB_OUTPUT,
    "docs=false\\nsite=false\\nadmin=false\\nfirebase=false\\nclassification=exact\\n");
} else {
  console.log("All selected CI consumers passed.");
}
`);
  mkdirSync(join(directory, "site/src/pages"), { recursive: true });
  writeFileSync(join(directory, "site/src/pages/index.astro"), "<main>Changed site</main>\n");
  writeFileSync(join(directory, ".github/scripts/metered-api-scan.mjs"),
    `import { execFileSync } from "node:child_process";
execFileSync("git", ["checkout", "-q", "--detach", "${decoySha}"]);
`);
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "Self-approving PR classifier");
  const prHeadSha = git(directory, "rev-parse", "HEAD");
  git(directory, "checkout", "-q", "--detach", baseSha);
  git(directory, "merge", "-q", "--no-ff", prHeadSha, "-m", "Tested merge");
  const headSha = git(directory, "rev-parse", "HEAD");
  const github = { event_name: "pull_request", event: { pull_request: { base: { sha: baseSha, ref: "main" }, head: { sha: prHeadSha } } }, sha: headSha };

  const runClassification = ({ tamperScan = false } = {}) => {
    git(directory, "checkout", "-q", "--detach", headSha);
    const runnerTemp = mkdtempSync(join(tmpdir(), "njpbs-ci-classify-output-"));
    temporaryDirectories.push(runnerTemp);
    const outputPath = join(runnerTemp, "output.txt");
    if (tamperScan && workflow.indexOf("- name: Metered-API source scan") <
        workflow.indexOf("- name: Classify the exact base diff")) {
      execFileSync(process.execPath, [".github/scripts/metered-api-scan.mjs"], { cwd: directory });
    }
    const result = spawnSync("bash", ["-e", "-c", classifyCommand], {
      cwd: directory, encoding: "utf8",
      env: {
        ...process.env, BASE_SHA: baseSha, GITHUB_WORKSPACE: directory,
        GITHUB_EVENT_NAME: "pull_request", PR_HEAD_SHA: prHeadSha,
        PR_BASE_REF: "main",
        RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: outputPath,
        TRUSTED_SHA: trustedRef ? runInNewContext(trustedRef, { github }) : "",
        HEAD_REF: headRef ? runInNewContext(headRef, { github }) : "",
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return Object.fromEntries(readFileSync(outputPath, "utf8").trim()
      .split("\n").map((line) => line.split("=")));
  };

  const runAggregate = (overrides = {}) => {
    const ref = checkoutRef
      ? runInNewContext(checkoutRef, { github })
      : headSha;
    git(directory, "checkout", "-q", "--detach", ref);
    return spawnSync("bash", ["-e", "-c", aggregateCommand], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        CLASSIFIER_RESULT: "success", POLICY_RESULT: "success",
        DOCS_SELECTED: "true", DOCS_RESULT: "success",
        SITE_SELECTED: "false", SITE_RESULT: "skipped",
        ADMIN_SELECTED: "false", ADMIN_RESULT: "skipped",
        FIREBASE_SELECTED: "false", FIREBASE_RESULT: "skipped",
        ...overrides,
      },
    });
  };

  it("rejects failed policy despite a self-approving PR classifier", () => {
    const result = runAggregate({ POLICY_RESULT: "failure" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /policy gate did not pass/);
  });

  it("rejects a failed selected gate despite a self-approving PR classifier", () => {
    const result = runAggregate({ DOCS_RESULT: "failure" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /selected docs gate did not pass/);
  });

  it("requires all gates after classifier failure despite PR self-approval", () => {
    const result = runAggregate({ CLASSIFIER_RESULT: "failure" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /selected site gate did not pass/);
  });

  it("passes successful selected gates with unselected gates skipped", () => {
    const result = runAggregate();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /All selected CI consumers passed/);
  });

  it("selects changed site source despite a self-deselecting PR classifier", () => {
    assert.equal(runClassification().site, "true");
  });

  it("does not let a PR source scan replace the classified head with a docs-only commit", () => {
    assert.equal(runClassification({ tamperScan: true }).site, "true");
  });

  it("rejects a skipped site gate despite a self-deselecting PR classifier", () => {
    const selection = runClassification();
    const result = runAggregate({
      SITE_SELECTED: selection.site, SITE_RESULT: "skipped", DOCS_RESULT: "success",
      DOCS_SELECTED: selection.docs,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /selected site gate did not pass/);
  });
});
