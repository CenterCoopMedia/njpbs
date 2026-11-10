import { parse } from "yaml";
// @vitest-environment node
import { readFileSync } from "node:fs";
import { readCmsDeployWorkflow } from "../../tests/helpers/cms-deploy-workflow.mjs";
import { describe, expect, it } from "vitest";
import {
  classifyChangedPaths,
  classifyPath,
} from "../../.github/scripts/ci-classifier.mjs";

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");

function workflowJob(source: string, name: string): string {
  const jobs = source.split("\njobs:\n", 2)[1] ?? "";
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = jobs.search(new RegExp(`^  ${escapedName}:`, "m"));
  if (start === -1) return "";
  const rest = jobs.slice(start);
  const next = rest.slice(1).search(/^  [\w-]+:/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function workflowStep(job: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  if (start === -1) return "";
  const rest = job.slice(start + marker.length);
  const next = rest.search(/\n {6}- (?:name:|uses:)/);
  return next === -1 ? rest : rest.slice(0, next);
}

function expectOrdered(source: string, first: string, second: string): void {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  expect(firstIndex, `${first} missing`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `${second} missing`).toBeGreaterThanOrEqual(0);
  expect(firstIndex, `${first} must come before ${second}`).toBeLessThan(
    secondIndex,
  );
}

describe("Workers Builds public endpoint contract", () => {
  const wrangler = read("../../workers/wrangler.jsonc");

  it("keeps the production workers.dev endpoint disabled", () => {
    expect(
      /^\s*"workers_dev":\s*(true|false),?$/m.exec(wrangler)?.[1],
    ).toBe("false");
  });

  it("keeps version and branch preview URLs disabled", () => {
    expect(
      /^\s*"preview_urls":\s*(true|false),?$/m.exec(wrangler)?.[1],
    ).toBe("false");
  });
});

describe("PUBLIC_ONLY artifact assertion wiring", () => {
  const ci = read("../../.github/workflows/ci.yml");
  const packageJson = read("../package.json");

  it("runs guardrails with PUBLIC_ONLY set after the public-only build", () => {
    expect(ci).toMatch(
      /name:\s*Guardrail scan over public build[\s\S]*?env:\s*\n\s*PUBLIC_ONLY:\s*"1"[\s\S]*?run:\s*npm run guardrails/,
    );
  });

  it("keeps the local public verifier running guardrails in PUBLIC_ONLY mode", () => {
    // The metered-API source scan runs before the build (it reads source, not dist),
    // then the PUBLIC_ONLY build and PUBLIC_ONLY guardrails run as before.
    expect(packageJson).toContain(
      '"verify:public": "npm run guardrails:source && PUBLIC_ONLY=1 astro build && PUBLIC_ONLY=1 npm run guardrails"',
    );
  });
});

describe("metered-API source scan runs before any scanned code executes", () => {
  // The scan's guarantee is only as strong as the earliest step that loads a
  // scanned file (issue #607): check, lint, test, the docs pointer guardrail,
  // and the sync scripts all evaluate files in scan scope, so "before the
  // build" was not early enough. Every workflow that installs site deps and
  // then executes scanned code must install with lifecycle scripts disabled and
  // run a dependency-free scanner directly. Lifecycle hooks stay disabled for
  // the whole job because dependency manifests are outside the first-party scan.
  // Lock that guarantee here per workflow: a future reorder or rebuild that
  // defeats it would otherwise stay green in every other test.
  const ci = read("../../.github/workflows/ci.yml");
  const pages = read("../../.github/workflows/pages.yml");
  const devPublish = read("../../.github/workflows/cms-dev-publish.yml");
  const preview = read("../../.github/workflows/preview.yml");
  const cmsPublish = read("../../.github/workflows/cms-publish.yml");
  const scheduleBake = read("../../.github/workflows/schedule-bake.yml");
  const probeMediaManager = read(
    "../../.github/workflows/probe-media-manager.yml",
  );
  const adminCi = read("../../.github/workflows/admin-ci.yml");
  const firebaseCi = read("../../.github/workflows/firebase-ci.yml");
  const cmsStaging = readCmsDeployWorkflow();
  const packageJsonSource = read("../package.json");
  const rootPackageJsonSource = read("../../package.json");
  const bootstrap = read("../../.github/scripts/metered-api-scan.mjs");
  const packageJson = JSON.parse(packageJsonSource) as {
    scripts?: Record<string, string>;
  };
  const rootPackageJson = JSON.parse(rootPackageJsonSource) as {
    scripts?: Record<string, string>;
  };
  const wrangler = read("../../workers/wrangler.jsonc");

  // These deploy and probe workflows install dependencies before the scan, but
  // keep lifecycle hooks disabled. Required CI instead scans once in its policy
  // job before either reusable package workflow can start.
  const protectedWorkflows = [
    ["pages.yml", pages],
    ["preview.yml", preview],
    ["schedule-bake.yml", scheduleBake],
    ["probe-media-manager.yml", probeMediaManager],
  ] as const;

  it.each(protectedWorkflows)(
    "disables lifecycle scripts before the source scan in %s",
    (_name, workflow) => {
      const scan = workflow.indexOf(
        "- name: Metered-API source scan (before any scanned code runs)",
      );
      expect(scan).toBeGreaterThanOrEqual(0);
      expect(
        workflow.lastIndexOf("run: npm ci --ignore-scripts", scan),
      ).toBeGreaterThanOrEqual(0);
      expect(workflow.slice(0, scan)).not.toContain("run: npm ci\n");
    },
  );

  it("scans each dev publication job before executing repository code", () => {
    for (const name of ["prepare", "build", "finalize"]) {
      const job = workflowJob(devPublish, name);
      const scan = job.indexOf("run: node .github/scripts/metered-api-scan.mjs");
      expect(scan, name).toBeGreaterThanOrEqual(0);
      const beforeScan = job.slice(0, scan);
      expect(beforeScan).not.toMatch(/run: npm ci\s*$/m);
      expect(beforeScan).not.toContain("site/scripts/");
      expect(beforeScan).not.toContain("node <<");
      expect(job).not.toMatch(/run: npm ci\s*$/m);
    }
  });

  it("runs source-policy guards before either package consumer", () => {
    const policy = workflowJob(ci, "policy");
    const scan = policy.indexOf(
      "name: Metered-API source scan (before any scanned code runs)",
    );
    const identity = policy.indexOf("name: Identity boundary guard");
    const setup = policy.indexOf("uses: actions/setup-node@v7");
    expect(scan).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(scan);
    expect(setup).toBeGreaterThan(identity);
    for (const jobName of ["admin", "firebase"]) {
      const consumer = workflowJob(ci, jobName);
      expect(consumer).toContain("needs: [policy]");
      expect(consumer).toContain("needs.policy.result == 'success'");
    }
    for (const workflow of [adminCi, firebaseCi]) {
      expect(workflow).toContain("workflow_call:");
      expect(workflow).not.toContain("pull_request:");
      expect(workflow).not.toContain("name: Identity boundary guard");
    }
  });

  it.each([
    ["admin-ci.yml", adminCi],
    ["firebase-ci.yml", firebaseCi],
  ])("keeps install hooks disabled in %s", (_name, workflow) => {
    expect(workflow).not.toMatch(/^\s*run: npm ci\s*$/m);
    expect(workflow.match(/run: npm ci --ignore-scripts/g)?.length).toBe(
      workflow.match(/run: npm ci/g)?.length,
    );
  });

  it("runs the root public Worker suite in Firebase CI", () => {
    expect(rootPackageJson.scripts?.["test:public-worker"]).toBe(
      "vitest run --config workers/vitest.public-worker.config.mts && vitest run tests/public-background-runtime.test.ts --maxWorkers=1 --no-file-parallelism",
    );
    for (const path of [
      "workers/src/public-worker.ts",
      "workers/src/public-worker-configuration.d.ts",
      "site/public/_headers",
      "workers/vitest.public-worker.config.mts",
      "workers/wrangler.jsonc",
    ]) {
      expect(classifyPath(path)?.firebase, path).toBe(true);
    }
    expect(firebaseCi).toContain("- name: Public Worker tests");
    expect(firebaseCi).toContain("run: npm run test:public-worker");
  });

  it("runs the private preview Worker checks in Firebase CI", () => {
    expect(rootPackageJson.scripts?.["test:preview-worker"]).toBe(
      "vitest run --config workers/vitest.preview-worker.config.mts",
    );
    for (const path of [
      "workers/src/preview-worker.ts",
      "workers/src/preview-worker-configuration.d.ts",
      "tests/preview-worker.test.ts",
      "workers/tsconfig.preview-worker.json",
      "workers/vitest.preview-worker.config.mts",
      "workers/wrangler.preview.jsonc",
    ]) {
      expect(classifyPath(path)?.firebase, path).toBe(true);
    }
    expect(firebaseCi).toContain("- name: Private preview Worker checks");
    expect(firebaseCi).toContain("npm run check:preview-worker");
    expect(firebaseCi).toContain("npm run test:preview-worker");
    expect(firebaseCi).toContain(
      "wrangler deploy --config workers/wrangler.preview.jsonc --dry-run",
    );
  });

  it("retains the approved HTTPS apex route and protects owned paths before Assets", () => {
    const routePatterns = Array.from(
      wrangler.matchAll(/"pattern":\s*"([^"]+)"/g),
      (match) => match[1],
    );

    expect(routePatterns).toEqual(["https://njpbs.org/*"]);
    expect(wrangler).toContain(
      '"run_worker_first": true',
    );
    expect(wrangler).toContain(
      "Verify the current HTTPS route before changing public traffic.",
    );
  });

  it("scans every selected staging tree with the current trusted scanner", () => {
    const stagingJobs = [
      ["verify", ".release-gate", "run: npm ci --ignore-scripts"],
      ["admin-build", ".admin-status-gate", "run: npm ci --ignore-scripts"],
      [
        "smoke-manifest",
        ".cms-smoke-gate",
        "node scripts/component-runner.mjs functions manifest",
      ],
      [
        "firebase-preflight",
        ".cms-smoke-gate",
        "uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3",
      ],
      ["cms-api", ".metered-api-gate", "run: npm ci --ignore-scripts"],
      ["firebase", ".metered-api-gate", "run: npm ci --ignore-scripts"],
      [
        "live-smoke",
        ".cms-smoke-gate",
        "node scripts/component-runner.mjs functions smoke",
      ],
      [
        "admin-deploy",
        ".metered-api-gate",
        "uses: cloudflare/wrangler-action@953926a2e2182532811c01a25e53647d93bf07c0 # v4.1.3",
      ],
    ] as const;

    for (const [name, gateDirectory, execution] of stagingJobs) {
      const job = workflowJob(cmsStaging, name);
      const scan = workflowStep(
        job,
        "Metered-API source scan (before any scanned code runs)",
      );
      const trustedCommand = `run: node "$RUNNER_TEMP/${gateDirectory.slice(1)}"/.github/scripts/metered-api-scan.mjs --target-root "$GITHUB_WORKSPACE"`;
      expect(job, `${name} job missing`).not.toBe("");
      expect(job).toContain(`ref: \${{ github.sha }}`);
      expectOrdered(job, `path: ${gateDirectory}`, trustedCommand);
      expectOrdered(
        job,
        "name: Metered-API source scan (before any scanned code runs)",
        execution,
      );
      expect(scan).toContain(trustedCommand);
      expect(scan).not.toContain("run: node .github/scripts/metered-api-scan.mjs");
    }
  });

  it("checks the selected CMS rollback floor before code or secrets can run", () => {
    const adminBuild = workflowJob(cmsStaging, "admin-build");
    const compatibilityCommand =
      "run: node \"$RUNNER_TEMP/admin-status-gate\"/.github/scripts/cms-deploy-compatibility.mjs --target-root \"$GITHUB_WORKSPACE\"";
    expect(adminBuild).toContain(`ref: \${{ github.sha }}`);
    expectOrdered(adminBuild, "path: .admin-status-gate", compatibilityCommand);
    expectOrdered(
      adminBuild,
      "name: Require reviewed deploy ref",
      "name: Require CMS deploy compatibility floor",
    );
    expectOrdered(
      adminBuild,
      "name: Metered-API source scan (before any scanned code runs)",
      "name: Require CMS deploy compatibility floor",
    );
    expectOrdered(
      adminBuild,
      "name: Metered-API source scan for current Admin status gate",
      "name: Require CMS deploy compatibility floor",
    );
    expectOrdered(
      adminBuild,
      "name: Require CMS deploy compatibility floor",
      "uses: actions/setup-node@v7",
    );
    expectOrdered(
      adminBuild,
      "name: Require CMS deploy compatibility floor",
      "name: Preflight admin env",
    );
  });

  it.each([["verify", ".release-gate"], ["cms-api", ".metered-api-gate"], ["firebase", ".metered-api-gate"], ["admin-deploy", ".metered-api-gate"]])(
    "keeps trusted scripts separate from release operators in the gate checkout for %s",
    (name, directory) => {
      const job = workflowJob(cmsStaging, name);
      const checkout = parse(cmsStaging).jobs[name].steps.find((step: { with?: { path?: string } }) => step.with?.path === directory);
      expect(checkout.with.ref).toBe("${{ github.sha }}");
      expect(checkout.with["sparse-checkout"]).toBe(".github/scripts");
    },
  );

  it.each(["verify", "admin-build", "firebase-preflight", "cms-api", "firebase"])(
    "validates the selected staging ref before its scanner runs in %s",
    (name) => {
      const job = workflowJob(cmsStaging, name);
      expectOrdered(
        job,
        "name: Require reviewed deploy ref",
        "name: Metered-API source scan (before any scanned code runs)",
      );
    },
  );

  it.each([
    [
      "admin-build",
      ".admin-status-gate",
      "node \"$RUNNER_TEMP/admin-status-gate\"/.github/scripts/cms-deploy-compatibility.mjs",
    ],
    [
      "smoke-manifest",
      ".cms-smoke-gate",
      "node scripts/component-runner.mjs functions manifest",
    ],
    [
      "firebase-preflight",
      ".cms-smoke-gate",
      "node scripts/component-runner.mjs functions verify-config",
    ],
    [
      "live-smoke",
      ".cms-smoke-gate",
      "node scripts/component-runner.mjs functions smoke",
    ],
  ])(
    "scans the nested current gate checkout before it runs in %s",
    (jobName, gateDirectory, execution) => {
      const job = workflowJob(cmsStaging, jobName);
      const nestedScan = `working-directory: \${{ runner.temp }}/${gateDirectory.slice(1)}\n        run: node .github/scripts/metered-api-scan.mjs`;
      expectOrdered(job, `path: ${gateDirectory}`, nestedScan);
      expectOrdered(job, nestedScan, execution);
    },
  );


  it("keeps the post-build public contracts in a CMS data publish", () => {
    const build = workflowJob(cmsPublish, "build");
    expect(build).not.toContain("Metered-API source scan");
    expect(build).toContain("npm run assert:public-contract");
    expect(build).toContain("npm run guardrails");
    expect(build).toContain("name: Reserve exact public artifact cutoff");
    expect(build).toContain("name: Build site");
    expect(build).toContain("name: Bind the final public Worker artifact");
    expect(build).toContain(
      "name: Mark exact artifact ready for deployment",
    );
    expect(build).toContain("run: npm ci --ignore-scripts");
  });

  it("keeps only isolated Admin changes out of the Astro consumer gate", () => {
    expect(classifyPath("admin/src/App.tsx")).toEqual({ docs: false, site: false, admin: true, firebase: false });
    expect(classifyPath("functions/lib/publish.js")).toEqual({ docs: false, site: true, admin: false, firebase: true });
    expect(classifyPath("functions/package.json")).toEqual({ docs: false, site: true, admin: false, firebase: true });
    expect(classifyPath("functions/README.md")).toEqual({ docs: true, site: false, admin: false, firebase: false });
    expect(classifyPath("admin/package.json")).toEqual({ docs: false, site: false, admin: true, firebase: false });
    expect(classifyPath("admin/README.md")).toEqual({ docs: true, site: false, admin: false, firebase: false });
    expect(classifyPath("packages/content-core/content-model.ts")).toEqual({ docs: false, site: true, admin: true, firebase: true });
    expect(classifyPath("site/src/pages/index.astro")).toEqual({ docs: false, site: true, admin: false, firebase: false });
    expect(classifyPath(".github/workflows/admin-ci.yml")).toEqual({ docs: false, site: false, admin: true, firebase: false });
    expect(classifyPath("admin/content/.markdownlint-cli2.cjs")).toEqual({ docs: true, site: false, admin: true, firebase: false });
    expect(classifyChangedPaths(["LICENSE"])).toMatchObject({
      gates: { docs: true, site: true, admin: true, firebase: true },
      classification: "fallback",
    });
  });

  it("keeps isolated Admin scans in the required CI job", () => {
    const policy = workflowJob(ci, "policy");
    expect(policy).toContain("name: Metered-API source scan (before any scanned code runs)");
    expect(policy).toContain("steps.changes.outputs");
    expect(policy).not.toContain("needs.classify.outputs");
  });

  it.each(protectedWorkflows)(
    "runs the dependency-free bootstrap without re-enabling hooks in %s",
    (_name, workflow) => {
      const scan = workflow.indexOf(
        "- name: Metered-API source scan (before any scanned code runs)",
      );
      const directBootstrap = workflow.indexOf(
        "run: node ../.github/scripts/metered-api-scan.mjs",
        scan,
      );
      expect(directBootstrap).toBeGreaterThan(scan);
      expect(workflow).not.toMatch(/run: npm rebuild(?:\s|$)/);
    },
  );

  it("keeps docs-only PRs in the source scan", () => {
    // The docs pointer guardrail runs under vitest on docs-only PRs, which
    // evaluates scanned config files, so the scan cannot hide behind the
    // site-only gate.
    expect(classifyPath("docs/overview.md")).toEqual({
      docs: true,
      site: false,
      admin: false,
      firebase: false,
    });
    expect(workflowJob(ci, "policy")).toContain(
      "name: Metered-API source scan (before any scanned code runs)",
    );
  });

  it("classifies scanner, manifest, source, and nested lint-config changes", () => {
    expect(classifyPath("nested/.markdownlint-cli2.cjs")?.docs).toBe(true);
    expect(classifyPath("package.json")).toEqual({ docs: true, site: true, admin: true, firebase: true });
    expect(classifyPath(".github/scripts/metered-api-scan.mjs")).toEqual({ docs: false, site: true, admin: false, firebase: false });
    for (const path of [
      ".github/cms-deploy-compatibility.json",
      ".github/scripts/cms-deploy-compatibility.mjs",
    ]) {
      expect(classifyPath(path)).toEqual({ docs: false, site: true, admin: true, firebase: true });
    }
  });

  it("runs the source scan before Markdown lint can load a local custom rule", () => {
    const scan = ci.indexOf(
      "- name: Metered-API source scan (before any scanned code runs)",
    );
    expect(scan).toBeGreaterThanOrEqual(0);
    expect(ci.indexOf("- name: Markdown lint")).toBeGreaterThan(scan);
  });

  it("runs the offline link check before dependency READMEs enter its glob", () => {
    const linkCheck = ci.indexOf("- name: Check relative links (offline)");
    const install = ci.indexOf("- name: Install docs gate dependencies");
    expect(linkCheck).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(linkCheck);
  });

  it.each([
    ["ADR numbering guard", "run: python3 qa/adr_guard.py"],
    [
      "QA harness unit tests",
      "python3 -m unittest discover -s qa -p 'test_*.py'",
    ],
  ])("runs the source scan before the CI %s", (name, command) => {
    expect(workflowStep(ci, name)).toContain(command);
    expectOrdered(
      ci,
      "- name: Metered-API source scan (before any scanned code runs)",
      `- name: ${name}\n`,
    );
  });

  it("keeps the local scan shortcut dependency-free", () => {
    // Workflows invoke Node directly so npm cannot run a PR-added pre-script
    // before the scan. This package shortcut is for local checks after install.
    expect(packageJson.scripts?.["guardrails:source"]).toBe(
      "node ../.github/scripts/metered-api-scan.mjs",
    );
  });

  it("keeps the trusted bootstrap outside scan scope and built-in-only", () => {
    const imports = [...bootstrap.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["node:fs", "node:path", "node:url"]);
    expect(bootstrap).not.toContain("site/src/lib/metered-api-guardrail");
    expect(bootstrap).not.toMatch(/\bfetch\s*\(/);
    expect(bootstrap).not.toMatch(/\bimport\s*\(/);
    expect(bootstrap).not.toMatch(/\b(?:eval|Function)\s*\(/);
  });


  it("runs the source scan before the build in the local deploy verifier", () => {
    // The normal build uses the programmatic Astro path and creates Pagefind
    // after the meaning-search hook. Keep that shared path and both output gates.
    expect(packageJson.scripts?.["verify:deploy"]).toBe(
      "npm run guardrails:source && npm run build && npm run assert:public-contract && npm run guardrails",
    );
  });

  it("scans source before the build in the Workers Builds dashboard command", () => {
    const command = wrangler
      .split("// The dashboard build command must be:\n", 2)[1]
      ?.split("\n  //\n", 1)[0]
      .replace(/^\s*\/\/\s?/gm, "")
      .replace(/\s+/g, " ")
      .trim();

    expect(command).toBe(
      "cd site && npm ci --ignore-scripts && node ../.github/scripts/metered-api-scan.mjs && npm run build:workers",
    );
    expect(packageJson.scripts?.["build:workers"]).toBe(
      "npm run guardrails:source && npm run build:public-post-renderer -- --compile-only && npm run sync:launch-content && npm run sync:spotlight-news && npm run build && npm run build:public-post-renderer -- --copy-assets && npm run assert:public-contract && npm run guardrails",
    );
  });
});
