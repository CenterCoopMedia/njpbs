// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readCmsDeployWorkflow } from "../../tests/helpers/cms-deploy-workflow.mjs";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const astroConfig = read("../astro.config.mjs");
const previewWorkflow = read("../../.github/workflows/preview.yml");
const productionWorkflow = read("../../.github/workflows/pages.yml");
const ciWorkflow = read("../../.github/workflows/ci.yml");
const cmsPublishWorkflow = read("../../.github/workflows/cms-publish.yml");
const stagingDeployWorkflowPath = new URL(
  "../../.github/workflows/cms-staging-deploy.yml",
  import.meta.url,
);
const sitePackage = read("../package.json");
const functionManifest = read("../../functions/index.js");
const deploymentBootstrap = read(
  "../../functions/lib/public-deployment-bootstrap.js",
);
const deploymentBootstrapOperator = read(
  "../../scripts/bootstrap-public-deployment.cjs",
);
const deploymentCoordinator = read(
  "../../functions/lib/public-deployment-coordinator.js",
);
const deploymentCloudflareEvidence = read(
  "../../functions/lib/public-deployment-cloudflare.js",
);
const workerActivationEvidence = read(
  "../../functions/lib/public-worker-activation.js",
);
const workerActivationOperator = read(
  "../scripts/activate-public-worker-candidate.ts",
);
const publicMediaLifecycleActivation = read(
  "../../functions/lib/public-media-lifecycle-activation.js",
);
const publicMediaLifecycleActivationOperator = read(
  "../scripts/activate-public-media-lifecycle.ts",
);
const workerDeploymentReconciler = read(
  "../scripts/reconcile-public-worker-deployment.ts",
);
const workerDeploymentReconciliationOwner = read(
  "../scripts/public-worker-deployment-reconciliation-owner.ts",
);
const publicWorker = read("../../workers/src/public-worker.ts");
const deploymentOutcomeStore = read(
  "../../functions/lib/public-deployment-outcome-store.js",
);
const cmsPublicDeploymentWriteback = read(
  "../../functions/lib/cms-public-deployment-writeback.js",
);
const cmsPublicationSerializer = read(
  "../../functions/lib/cms-publication-serializer.js",
);
const cmsPreviewSerializer = read(
  "../../functions/lib/cms-preview-serializer.js",
);
const cmsPublicationTokenJournal = read(
  "../scripts/cms-publication-token-journal.ts",
);
const claimedBaselineCancellation = read(
  "../../functions/lib/cms-publication-baseline-claimed-cancellation.js",
);
const firestoreIndexes = read("../../firestore.indexes.json");
const devPublishWorkflow = new URL(
  "../../.github/workflows/cms-dev-publish.yml",
  import.meta.url,
);

function workflowJob(source: string, name: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const jobsStart = normalized.indexOf("\njobs:\n");
  if (jobsStart === -1) return "";
  const jobsSection = normalized.slice(jobsStart + "\njobs:\n".length);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(
    `^  (["']?)${escapedName}\\1\\s*:`,
    "m",
  ).exec(jobsSection);
  if (!header || header.index === undefined) return "";
  const start = header.index;
  const nextLine = jobsSection.indexOf("\n", start);
  const afterStart = nextLine === -1 ? jobsSection.length : nextLine + 1;
  const nextJobOffset = jobsSection
    .slice(afterStart)
    .search(/^  (["']?)[\w-]+\1\s*:/m);
  return nextJobOffset === -1
    ? jobsSection.slice(start)
    : jobsSection.slice(start, afterStart + nextJobOffset);
}

function workflowPushPaths(source: string): string[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const pathsStart = lines.indexOf("    paths:");
  if (pathsStart === -1) return [];

  const paths: string[] = [];
  for (const line of lines.slice(pathsStart + 1)) {
    if (!line.startsWith("      ")) break;
    const match = /^\s{6}-\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    paths.push(match[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
  }
  return paths;
}

function workflowJobNames(source: string): string[] {
  const normalized = source.replace(/\r\n/g, "\n");
  const jobsStart = normalized.indexOf("\njobs:\n");
  expect(jobsStart, "jobs block missing").toBeGreaterThanOrEqual(0);
  return Array.from(
    normalized
      .slice(jobsStart + "\njobs:\n".length)
      .matchAll(/^  (["']?)([\w-]+)\1\s*:/gm),
    (match) => match[2],
  );
}

function readDevPublishWorkflow(): string {
  expect(
    existsSync(fileURLToPath(devPublishWorkflow)),
    "dev publication workflow missing",
  ).toBe(true);
  return readFileSync(fileURLToPath(devPublishWorkflow), "utf8");
}

// One step of the publish workflow, so an assertion about a step cannot be
// satisfied by a neighbour. A pattern that spans steps reads fine and proves
// nothing: it matches whichever later step happens to carry the same clause.
function publishStep(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = cmsPublishWorkflow.indexOf(marker);
  expect(start, `${name} step missing`).toBeGreaterThanOrEqual(0);
  const rest = cmsPublishWorkflow.slice(start + marker.length);
  const next = rest.search(/\n {6}- name: /);
  return next === -1 ? rest : rest.slice(0, next);
}

function expectOrdered(workflow: string, first: string, second: string): void {
  const firstIndex = workflow.indexOf(first);
  const secondIndex = workflow.indexOf(second);
  expect(firstIndex, `${first} missing`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `${second} missing`).toBeGreaterThanOrEqual(0);
  expect(firstIndex, `${first} must come before ${second}`).toBeLessThan(
    secondIndex,
  );
}

describe("production deploy authority", () => {
  it("keeps public Pages deployment admission on every job", () => {
    expect(productionWorkflow).toContain(
      "repository_dispatch:\n    types: [production_deploy]",
    );
    expect(productionWorkflow).toContain("workflow_dispatch:");
    expect(productionWorkflow).toContain("run-name: >-");
    expect(productionWorkflow).toContain("production_deploy {0}");
    expect(productionWorkflow).toContain(
      "github.event.client_payload.refresh_id || 'invalid'",
    );
    expect(productionWorkflow).toContain("PRODUCTION_DEPLOY_DISPATCH_SECRET");
    expect(productionWorkflow).toContain("createHmac");
    expect(productionWorkflow).toContain("timingSafeEqual");
    expect(productionWorkflow).toContain("timestamp is outside the 10-minute window");
    // Media Manager and the public feed step both keep the refresh policy.
    expect(productionWorkflow.match(/REQUIRE_FRESH_CONTENT:/g)).toHaveLength(2);
    expect(productionWorkflow).toContain(
      "needs.authorize.outputs.require_fresh",
    );
    const authorize = workflowJob(productionWorkflow, "authorize");
    const build = workflowJob(productionWorkflow, "build");
    expect(authorize).not.toContain("actions/checkout");
    expect(authorize).toContain("PRODUCTION_DEPLOY_DISPATCH_SECRET");
    expect(build).toContain("needs: authorize");
    expect(build).not.toContain("PRODUCTION_DEPLOY_DISPATCH_SECRET");
    expect(productionWorkflow).toContain(
      "ref: ${{ needs.authorize.outputs.deploy_ref }}",
    );
    expect(build).not.toContain("github.event.client_payload");
    expect(build).toContain("git merge-base --is-ancestor HEAD origin/main");
    expectOrdered(productionWorkflow, "Require reviewed deploy ref", "run: npm ci");

    const jobNames = workflowJobNames(productionWorkflow);
    expect(jobNames).not.toHaveLength(0);
    for (const jobName of jobNames) {
      expect(workflowJob(productionWorkflow, jobName)).toContain(
        "github.triggering_actor == vars.CMS_DEPLOY_OWNER",
      );
    }
  });

  it("accepts only reviewed main commits or tree-identical promotion merges", () => {
    const build = workflowJob(productionWorkflow, "build");
    expect(build).toContain(
      'reviewed_main_sha="$(git rev-parse HEAD^2)"',
    );
    expect(build).toContain(
      'git merge-base --is-ancestor "$reviewed_main_sha" origin/main',
    );
    expect(build).toContain('git diff --quiet "$reviewed_main_sha" HEAD');
  });

  it("allows only the configured owner to start or re-run a full-stack CMS deployment", () => {
    const stagingDeployWorkflow = readCmsDeployWorkflow();
    expect(stagingDeployWorkflow).toContain("workflow_dispatch:");
    expect(stagingDeployWorkflow).not.toContain("repository_dispatch:");
    expect(stagingDeployWorkflow).toContain(
      "inputs.deploy_ref",
    );
    expect(stagingDeployWorkflow).toContain(
      "inputs.cloudflare_pages_branch",
    );
    expect(stagingDeployWorkflow).toContain("id: pages_branch");
    expect(stagingDeployWorkflow).toContain("CLOUDFLARE_PAGES_BRANCH:");
    expect(stagingDeployWorkflow).toMatch(
      /\[\[ !? ?\"\$CLOUDFLARE_PAGES_BRANCH\" =~/,
    );
    expect(
      workflowJob(stagingDeployWorkflow, "admin-deploy").match(
        /command:.*client_payload/,
      ),
    ).toBeNull();

    const jobNames = workflowJobNames(stagingDeployWorkflow);
    expect(jobNames).not.toHaveLength(0);
    for (const jobName of jobNames) {
      expect(workflowJob(stagingDeployWorkflow, jobName)).toContain(
        "(vars.CMS_DEPLOY_OWNER != '' && github.triggering_actor == vars.CMS_DEPLOY_OWNER) && github.ref == 'refs/heads/main'",
      );
    }
  });

  it("discovers alternative top-level job spellings instead of skipping them", () => {
    const synthetic = [
      "name: synthetic",
      "jobs:",
      "  commented: # still a job",
      "    if: github.triggering_actor == 'fixture-owner'",
      "  inline: {}",
      '  "quoted":',
      "    if: github.triggering_actor == 'fixture-owner'",
      "  spaced :",
      "    if: github.triggering_actor == 'fixture-owner'",
      "",
    ].join("\n");
    expect(workflowJobNames(synthetic)).toEqual([
      "commented",
      "inline",
      "quoted",
      "spaced",
    ]);
    expect(workflowJob(synthetic, "quoted")).toContain("triggering_actor");
    expect(workflowJob(synthetic, "spaced")).toContain("triggering_actor");
  });
});

describe("internal route gate", () => {
  it("injects the route only when the internal surface gate is open", () => {
    expect(astroConfig).toContain("internalSurfaceRoutesEnabled(process.env)");
  });
});

describe("public deployment reservation", () => {
  it("records the inert one-time bootstrap without claiming live settlement", () => {
    expect(functionManifest).not.toContain("public-deployment-bootstrap");
    expect(deploymentBootstrap).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret/,
    );
    expect(deploymentBootstrapOperator).toContain("readFileSync(3");
    expect(deploymentBootstrapOperator).toContain("readFileSync(4");
    const environmentReads = [...deploymentBootstrapOperator.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(match => match[1]);
    expect([...new Set(environmentReads)].sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_PUBLIC_WORKER_TAG"]);
    expect(deploymentBootstrapOperator).not.toMatch(/process\.env\s*\[/);
  });

  it("records the inert exclusive lease and newest-eligible contract", () => {
    expect(functionManifest).not.toContain(
      "exports.acquirePublicDeploymentLease",
    );
    expect(deploymentCoordinator).not.toContain("leaseExpiresAt");
    expect(deploymentCoordinator).not.toMatch(/cloudflare|fetch\s*\(/i);
  });

  it("records the Cloudflare deployment evidence contract", () => {
    expect(functionManifest).not.toContain(
      "public-deployment-cloudflare",
    );
    expect(deploymentCloudflareEvidence).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret|firebase-admin|runTransaction/,
    );
  });

  it("records the serialized direct-deployment activation operator", () => {
    expect(workerActivationEvidence).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret|firebase-admin|runTransaction/,
    );
    expect(publicWorker).toContain(
      'const PUBLICATION_PROBE_PATH = "/_publication.json"',
    );
    expect(functionManifest).not.toContain("public-worker-activation");
    expect(sitePackage).toContain("activate:public-worker-candidate");
    expect(existsSync(new URL(
      "../scripts/activate-public-worker-candidate.ts",
      import.meta.url,
    ))).toBe(true);
    expect(workerActivationOperator).toContain(
      'const UPLOAD_ONLY_DEPLOY_COMMAND = "npx wrangler versions upload --config workers/wrangler.jsonc"',
    );
    expect(workerActivationOperator).toContain(
      "const PROVIDER_DEPLOYMENT_PATHS_SERIALIZED = true",
    );
    expect(workerActivationOperator).toContain(
      "assertProductionFirestoreRouting(process.env)",
    );
    expect(workerActivationOperator).toContain("readFileSync(3");
    expect(workerActivationOperator).toContain("readFileSync(4");
    expect(workerActivationOperator).not.toContain("process.env.CLOUDFLARE");
    expect(workerActivationOperator).not.toContain("process.env.GOOGLE");
    expect(productionWorkflow).not.toContain(
      "activate:public-worker-candidate",
    );
    expect(cmsPublishWorkflow).not.toContain(
      "activate:public-worker-candidate",
    );
  });

  it("records the guarded public media lifecycle activation", () => {
    expect(sitePackage).toContain("activate:public-media-lifecycle");
    expect(publicMediaLifecycleActivation).toContain(
      "mediaLifecycleReady: true",
    );
    expect(publicMediaLifecycleActivationOperator).toContain(
      "assertFullApexWorkerRoute(routesResponse)",
    );
    expect(functionManifest).not.toContain(
      "public-media-lifecycle-activation",
    );
  });

  it("records the Firestore outcome settlement boundary", () => {
    expect(functionManifest).not.toContain(
      "public-deployment-outcome-store",
    );
    expect(deploymentOutcomeStore).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret|onCall|onRequest/,
    );
  });

  it("records exact Cloudflare queue writeback", () => {
    expect(functionManifest).not.toContain(
      "cms-public-deployment-writeback",
    );
    expect(cmsPublicDeploymentWriteback).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret|onCall|onRequest/,
    );
  });

  it("records retained serializer claims", () => {
    expect(firestoreIndexes).toContain(
      '"fieldPath": "serializerClaim.serializerId"',
    );
    expect(firestoreIndexes).toContain('"fieldPath": "transport"');
    expect(functionManifest).not.toContain(
      "cms-publication-serializer",
    );
    expect(cmsPublicationSerializer).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret|onCall|onRequest/,
    );
  });

  it("records the durable preview serializer claim and listener", () => {
    expect(functionManifest).not.toContain("cms-preview-serializer");
    expect(cmsPreviewSerializer).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret|onCall|onRequest/,
    );
  });

  it("records the durable serializer token journal", () => {
    expect(cmsPublicationTokenJournal).toContain(
      "openCmsPublicationTokenJournal",
    );
    expect(cmsPublicationTokenJournal).not.toMatch(
      /process\.argv|function main|startCmsPublishSerializerListener/,
    );
  });

  it("records the claimed included or pre-inclusion cancellation boundary", () => {
    expect(claimedBaselineCancellation).toContain(
      "transaction.update(batchRef",
    );
  });

  it("records the direct-deployment reconciliation core", () => {
    expect(workerDeploymentReconciler).toContain(
      "reconcilePublicWorkerDeployment",
    );
    expect(workerDeploymentReconciler).not.toMatch(
      /process\.argv|function main|defineSecret|onSchedule|setInterval/,
    );
  });

  it("records the event-driven reconciliation owner", () => {
    expect(workerDeploymentReconciliationOwner).toContain(
      "PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS",
    );
    expect(workerDeploymentReconciliationOwner).toContain(
      "waitForIdleAfter",
    );
    expect(workerDeploymentReconciliationOwner).not.toMatch(
      /process\.argv|function main|defineSecret|onSchedule|setInterval/,
    );
  });
});

describe("workflow gate", () => {
  it("gates every consumer with fail-closed exact-diff classification", () => {
    expect(ciWorkflow).toMatch(
      /name:\s*Set fail-closed defaults[\s\S]*?docs=true\\nsite=true\\nadmin=true\\nfirebase=true/,
    );
    expect(ciWorkflow).toContain("fetch-depth: 0");
    const classifier = parse(ciWorkflow).jobs.policy.steps.find(
      (step: { id?: string }) => step.id === "changes",
    );
    const baseExpression = classifier.env.BASE_SHA.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    for (const [eventName, event, expectedBase] of [
      ["pull_request", { pull_request: { base: { sha: "pr-base" } } }, "pr-base"],
      ["merge_group", { merge_group: { base_sha: "queue-base", head_sha: "queue-head" } }, "queue-base"],
      ["push", { before: "push-base" }, "push-base"],
    ] as const) {
      expect(runInNewContext(baseExpression, {
        github: { event_name: eventName, event, sha: "event-head" },
      }), `${eventName} must classify from its exact event base`).toBe(expectedBase);
    }
    expect(ciWorkflow).toContain(
      "TRUSTED_SHA: ${{ (github.event_name == 'merge_group' && github.event.merge_group.base_sha) || github.event.pull_request.base.sha || (github.event_name == 'push' && github.sha) || format('origin/{0}', github.event.repository.default_branch) }}",
    );
    expect(ciWorkflow).toContain('HEAD_REF: ${{ github.sha }}');
    expect(ciWorkflow).toContain('git show "$TRUSTED_SHA:.github/scripts/ci-classifier.mjs"');
    expect(ciWorkflow).toContain('node "$RUNNER_TEMP/ci-classifier.mjs" classify');
    expect(ciWorkflow.match(/needs: \[policy\]/g)).toHaveLength(4);
    expect(ciWorkflow).toContain(
      "needs.policy.outputs.classifier_result != 'success' || needs.policy.outputs.docs != 'false'",
    );
    expect(ciWorkflow).toContain(
      "needs.policy.outputs.classifier_result != 'success' || needs.policy.outputs.site != 'false'",
    );
    expect(ciWorkflow).toContain(
      "needs.policy.outputs.classifier_result != 'success' || needs.policy.outputs.admin != 'false'",
    );
    expect(ciWorkflow).toContain(
      "needs.policy.outputs.classifier_result != 'success' || needs.policy.outputs.firebase != 'false'",
    );
    expect(ciWorkflow).toContain("needs: [policy, docs, site, admin, firebase]");
    // Code events retain the required check; metadata uses a distinct name.
    const finalName = parse(ciWorkflow).jobs.ci.name.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    for (const eventName of ["pull_request", "merge_group", "push", "workflow_dispatch"]) {
      for (const action of ["opened", "reopened", "synchronize", "edited"]) {
        expect(runInNewContext(finalName, {
          github: { event_name: eventName, event: {
            action, changes: { base: { ref: { from: "old-target" } } },
          } },
        })).toBe("ci");
      }
    }
  });

  it("keeps the docs pointer guardrail wired and ordered", () => {
    expectOrdered(
      ciWorkflow,
      "name: Install docs gate dependencies",
      "name: Docs pointer and vault guardrails",
    );
    expect(ciWorkflow).toContain("run: npm run guardrails:docs");
    expect(ciWorkflow).toContain(
      "needs.policy.outputs.classifier_result != 'success' || needs.policy.outputs.docs != 'false'",
    );
  });

  it("every workflow that builds the site watches the shared content core", () => {
    const siteBuilders: [string, string][] = [
      ["pages.yml", productionWorkflow],
      ["preview.yml", previewWorkflow],
      [
        "cms-dev-publish.yml",
        read("../../.github/workflows/cms-dev-publish.yml"),
      ],
    ];
    for (const [name, workflow] of siteBuilders) {
      expect(
        workflow,
        `${name} builds the site, so it must rebuild on a packages/ change`,
      ).toContain('- "packages/**"');
    }
  });

  it("opts PR preview artifacts into internal surfaces from ci", () => {
    expect(ciWorkflow).toMatch(
      /name:\s*Build PR preview artifact[\s\S]*?env:\s*[\s\S]*?INTERNAL_SURFACES:\s*"1"/,
    );
    expect(ciWorkflow).toContain("name: site-preview-${{ github.sha }}");
    expect(ciWorkflow).toContain("retention-days: 7");
    expect(ciWorkflow).toContain("if-no-files-found: error");
    expect(previewWorkflow).not.toMatch(/^\s*pull_request:/m);
  });

  it("retires the Pages writer and targets only the private dev Worker", () => {
    expect(existsSync(new URL("../../.github/workflows/dev-autodeploy.yml", import.meta.url))).toBe(false);
    const workflow = parse(readDevPublishWorkflow());
    expect(workflow.env.CLOUDFLARE_DEV_PUBLIC_WORKER).toBe("${{ vars.CLOUDFLARE_DEV_PUBLIC_WORKER }}");
    expect(workflow.env.CLOUDFLARE_DEV_PAGES_PROJECT).toBeUndefined();
    expect(workflow.env.CMS_DEV_PAGES_BRANCH).toBeUndefined();
    expect(readDevPublishWorkflow()).not.toContain("pages deploy");
    expect(workflow.concurrency).toEqual({ group: "cms-dev-publication", queue: "max", "cancel-in-progress": false });
  });

  it("uses frozen inputs for the secretless dev build", () => {
    const workflow = readDevPublishWorkflow();
    expect(workflow).not.toContain("sync:launch-content");
    expect(workflow).not.toContain("sync:spotlight-news");
    expect(workflow).not.toContain("MEDIA_MANAGER_API_KEY");
    expect(workflow).not.toContain("MEDIA_MANAGER_API_SECRET");
    expect(workflow).toContain("Build from frozen input without network or credentials");
    const publisher = read("../scripts/cms-dev-publication.mjs");
    expect(publisher).toContain('"--unshare-net"');
    expect(publisher).toContain('INTERNAL_SURFACES: "0"');
    expect(publisher).toContain('LAUNCH_CONTENT_DATA_PATH: path.join(directory, "launch.json")');
    expect(publisher).toContain('SPOTLIGHT_NEWS_DATA_PATH: path.join(directory, "spotlight.json")');
  });

  it("pins dev jobs to their accepted source before freezing, building or reconciliation", () => {
    const workflow = parse(readDevPublishWorkflow());
    const prepare = workflow.jobs.prepare;
    expect(prepare.outputs.source_sha).toBe("${{ steps.source.outputs.source_sha }}");
    expect(prepare.steps[0].with.ref).toBe("${{ github.sha }}");
    expect(prepare.steps[0].with["fetch-depth"]).toBe(0);
    const names = prepare.steps.map((step: { name?: string }) => step.name);
    expect(names.indexOf("Authenticate only to dev Firestore")).toBeLessThan(names.indexOf("Select accepted dev source without changing ownership"));
    expect(names.indexOf("Select accepted dev source without changing ownership")).toBeLessThan(names.indexOf("Check trusted source ancestry and restore exact code"));
    expect(names.indexOf("Check trusted source ancestry and restore exact code")).toBeLessThan(names.indexOf("Reserve generation and freeze published inputs"));
    const acceptedScan = prepare.steps.find((step: { name?: string }) => step.name === "Scan accepted source before reserving public work");
    // The accepted checkout replaces the scanner, so the current trusted copy must scan it.
    expect(acceptedScan.run).toBe('node "$RUNNER_TEMP/metered-api-gate/.github/scripts/metered-api-scan.mjs" --target-root "$GITHUB_WORKSPACE"');
    const preserved = prepare.steps.find((step: { name?: string }) => step.name === "Preserve the trusted metered-API scanner");
    expect(preserved.run).toContain('cp .github/scripts/metered-api-scan.mjs "$RUNNER_TEMP/metered-api-gate/.github/scripts/metered-api-scan.mjs"');
    expect(names.indexOf(preserved.name)).toBeLessThan(names.indexOf("Check trusted source ancestry and restore exact code"));
    expect(names.indexOf("Check trusted source ancestry and restore exact code")).toBeLessThan(names.indexOf(acceptedScan.name));
    expect(names.indexOf(acceptedScan.name)).toBeLessThan(names.indexOf("Reserve generation and freeze published inputs"));
    const approvedSource = prepare.steps.find((step: { id?: string }) => step.id === "source");
    expect(approvedSource.name).toBe("Check trusted source ancestry and restore exact code");
    expect(approvedSource.run.indexOf("dev-publication-source-checkout.mjs")).toBeLessThan(approvedSource.run.indexOf('echo "source_sha=$SOURCE_SHA"'));
    for (const name of ["build", "finalize"]) {
      expect(workflow.jobs[name].env.SOURCE_SHA).toBe("${{ needs.prepare.outputs.source_sha }}");
    }
    expect(workflow.jobs.finalize.if).toContain("needs.prepare.outputs.source_sha != ''");
    const reconcile = workflow.jobs.reconcile;
    expect(reconcile.steps[0].with["fetch-depth"]).toBe(0);
    const recoveryNames = reconcile.steps.map((step: { name?: string }) => step.name);
    expect(recoveryNames.indexOf("Retain verified original run source")).toBeLessThan(recoveryNames.indexOf("Select accepted dev source without changing ownership"));
    expect(recoveryNames.indexOf("Check retained source ancestry before repaired reconciliation")).toBeLessThan(recoveryNames.indexOf("Reconcile the retained candidate without rebuilding or uploading"));
  });

  it("keeps shared Admin preview inputs in the preview artifact workflow", () => {
    expect(workflowPushPaths(previewWorkflow)).toEqual(expect.arrayContaining([
      "admin/dev-preview/**",
      "admin/src/routes/PoliticsResourceRoute.*", "admin/src/routes/ElectionsPanel.*",
      "admin/src/routes/ShellContext.tsx", "admin/src/lib/politics-resource.ts",
      "admin/src/lib/election-directory.ts", "admin/src/lib/guide-preview-source.ts",
      "admin/src/styles.css", "admin/src/design-system/**",
    ]));
    expect(workflowPushPaths(readDevPublishWorkflow()).filter(path => path.startsWith("admin/"))).toEqual([]);
  });

  it("omits the wiki before retaining the dev artifact", () => {
    const publisher = read("../scripts/cms-dev-publication.mjs");
    expectOrdered(publisher,
      'await rm(path.join(site, "dist/wiki"), { recursive: true, force: true })',
      'await cp(path.join(site, "dist"), path.join(directory, "dist"), { recursive: true })');
  });

  it("isolates dev upload credentials from the offline build", () => {
    const workflow = readDevPublishWorkflow();
    const buildJob = workflowJob(workflow, "build");
    const finalizeJob = workflowJob(workflow, "finalize");
    const workflowHeader = workflow.slice(0, workflow.indexOf("\njobs:\n"));
    expect(workflowHeader).not.toMatch(/\$\{\{[^}\n]*\bsecrets\b/);
    expect(buildJob).not.toMatch(/\$\{\{[^}\n]*\bsecrets\b/);
    expect(buildJob).not.toContain("id-token: write");
    expect(buildJob).toContain("Require offline build sandbox");
    expect(buildJob).toContain("Verify offline build sandbox");
    expect(finalizeJob).toContain("needs: [prepare, build]");
    expect(finalizeJob).toContain("environment: development");
    expect(finalizeJob).toContain("secrets.CLOUDFLARE_DEV_PUBLIC_WORKER_TOKEN");
    expect(finalizeJob).not.toContain("secrets.CLOUDFLARE_DEV_WORKER_TOKEN");
    expect(finalizeJob).not.toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(finalizeJob).not.toContain("secrets.CLOUDFLARE_DEV_PAGES_TOKEN");
    expectOrdered(finalizeJob,
      "uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      "- name: Upload only to dev, verify receipts, and settle dev queue");
  });

  it("keeps the dev deploy out of unrelated secret-consumer maps", () => {
    expect(readDevPublishWorkflow()).not.toMatch(/\bsecrets\.MEDIA_MANAGER_API_(?:KEY|SECRET)\b/);
  });

  it("keeps production builds on the production artifact contract", () => {
    expect(productionWorkflow).not.toContain("INTERNAL_SURFACES");
    expect(ciWorkflow).toMatch(
      // The launch switch for /share/ is the only setting the full build may add.
      /name:\s*Full build\s+working-directory:\s*site\s+(?:env:\s+PUBLIC_SHARE_PAGE:[^\n]*\s+)?run:\s*npm run build/,
    );
    expect(cmsPublishWorkflow).not.toContain("INTERNAL_SURFACES");
  });

  it("prefers the narrow publish credential over the admin key", () => {
    const preferred = "secrets.FIREBASE_PUBLISH_SERVICE_ACCOUNT || ";
    const adminRefs = [
      ...cmsPublishWorkflow.matchAll(/secrets\.FIREBASE_SERVICE_ACCOUNT/g),
    ];

    expect(adminRefs.length).toBeGreaterThan(0);
    for (const ref of adminRefs) {
      expect(cmsPublishWorkflow.slice(0, ref.index).endsWith(preferred)).toBe(
        true,
      );
    }
  });

  it("refuses a publish credential from another Firebase project", () => {
    const guard = 'if [ "$project_id" != "njpbs-site" ]';
    expect(cmsPublishWorkflow).toContain(guard);
    expectOrdered(cmsPublishWorkflow, guard, "name: Install site deps");

    // The rejection has to happen before npm ci, and the key still must not be
    // on disk while npm ci runs: this workflow does not pass --ignore-scripts,
    // and site/package-lock.json marks packages with hasInstallScript. So the
    // check reads the secret from stdin, and the credential file is written
    // only after the install, for the build that actually needs it.
    expect(
      publishStep("Verify the publish credential's project"),
    ).not.toContain("RUNNER_TEMP");
    expectOrdered(
      cmsPublishWorkflow,
      "name: Install site deps",
      'credentials_path="$RUNNER_TEMP/service-account.json"',
    );
  });

  it("blocks writeback for a rejected key without stranding other runs", () => {
    const readiness = publishStep("Check whether writeback is configured");

    // It judges the key, not another step. Every writeback step materializes
    // the secret itself instead of reusing the build credential, so a decision
    // borrowed from the verify step would be about the wrong thing anyway. And
    // no step outcome can answer this: writeback runs on failure and on
    // cancellation, and a run cancelled during checkout leaves that outcome
    // "skipped", which is neither proof the key is ours nor cause to strand the
    // row. Hence no steps.* reference here at all.
    expect(readiness).toContain('if [ "$project_id" = "njpbs-site" ]');
    expect(readiness).not.toContain("steps.");
    expect(cmsPublishWorkflow).not.toContain("CREDS_OUTCOME");

    // Inline, so the check does not need the checkout that a cancelled run may
    // never have finished. Asserted as one string with the assignment: read
    // apart, a hardcoded project_id next to an unrelated stdin line satisfies
    // both halves.
    expect(readiness).toContain(
      'project_id="$(printf \'%s\' "$SA" | node -e \'let s="";process.stdin',
    );

    for (const trigger of ["if: failure()", "if: cancelled()"]) {
      expect(cmsPublishWorkflow).toContain(
        `${trigger} && steps.wb.outputs.ready == 'true'`,
      );
    }
  });
});

describe("cms staging deploy surface", () => {
  it("keeps Firebase key files and exported credentials out of Cloudflare tool jobs", () => {
    const workflow = parse(readFileSync(stagingDeployWorkflowPath, "utf8"));
    expect(workflow.env ?? {}).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
    for (const [name, job] of Object.entries<any>(workflow.jobs)) {
      const runsCloudflareTool = job.steps.some((step: any) =>
        step.uses?.startsWith("cloudflare/") ||
        /\bwrangler\b|deploy-cms-preview-cloud\.ts deploy/.test(step.run ?? ""),
      );
      if (!runsCloudflareTool) continue;
      // Only this ADC consumer may create a file; its shell cleanup is exercised
      // in tests/preflight/admin-deploy-identity.test.js on success and failure.
      const sharedSteps = job.steps.filter((step: any) =>
        !(name === "admin-deploy" && step.name === "Recheck live Functions identity before Admin upload"),
      );
      expect(JSON.stringify(sharedSteps), name).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
      expect(JSON.stringify(sharedSteps), name).not.toContain("firebase-service-account.json");
      expect(job.env ?? {}, name).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
      expect(job.env ?? {}, name).not.toHaveProperty("CMS_PREVIEW_FIREBASE_ACCOUNT");
      expect(job.env ?? {}, name).not.toHaveProperty("FIREBASE_SERVICE_ACCOUNT");
    }
  });

  it.each(["cms-api", "admin-deploy"])("gives %s receipt checks step-scoped Firebase credentials", name => {
    const workflow = parse(readFileSync(stagingDeployWorkflowPath, "utf8"));
    const receiptSteps = workflow.jobs[name].steps.filter((step: any) =>
      step.run?.includes("node scripts/component-runner.mjs"),
    );
    expect(receiptSteps.length).toBeGreaterThan(0);
    for (const step of receiptSteps) {
      if (name === "admin-deploy" && step.name === "Recheck live Functions identity before Admin upload") {
        expect(step.env.SA).toBe("${{ secrets.FIREBASE_SERVICE_ACCOUNT }}");
        expect(step.env.GOOGLE_APPLICATION_CREDENTIALS).toBe("${{ runner.temp }}/firebase-service-account.json");
        expect(step.run).not.toContain("GITHUB_ENV");
      } else {
        expect(step.env.CMS_PREVIEW_FIREBASE_ACCOUNT, step.name).toBe("${{ secrets.FIREBASE_SERVICE_ACCOUNT }}");
      }
    }
  });

  it("adds the manual Firebase and admin deploy workflow", () => {
    expect(
      existsSync(fileURLToPath(stagingDeployWorkflowPath)),
      "cms staging deploy workflow missing",
    ).toBe(true);

    const stagingDeployWorkflow = readCmsDeployWorkflow();

    expect(stagingDeployWorkflow).toContain("workflow_dispatch:");
    expect(stagingDeployWorkflow).not.toContain("repository_dispatch:");
    expect(stagingDeployWorkflow).not.toContain("pull_request:");
    expect(stagingDeployWorkflow).toContain('node-version: "22.23.5"');
    expect(stagingDeployWorkflow).toContain("FIREBASE_SERVICE_ACCOUNT");
    expect(stagingDeployWorkflow).toContain(
      '--only "firestore:rules,firestore:indexes,storage"',
    );
    expect(stagingDeployWorkflow).toContain(
      "node scripts/component-runner.mjs functions deploy",
    );
    expect(stagingDeployWorkflow).toContain(
      "FUNCTION_TARGETS: ${{ needs.smoke-manifest.outputs.function_targets }}",
    );
    expect(stagingDeployWorkflow).toContain("CMS_WRITEBACK_CONFIGURED");
    expect(stagingDeployWorkflow).toContain(
      "Configure functions runtime params",
    );
    expect(stagingDeployWorkflow).toContain("functions/.env.njpbs-site");
    expect(stagingDeployWorkflow).toContain("Preflight admin env");
    expect(stagingDeployWorkflow).toContain(
      "Missing required admin build env vars",
    );
    expect(stagingDeployWorkflow).toContain("npm run admin:build");
    expect(stagingDeployWorkflow).toContain("VITE_FIREBASE_API_KEY");
    expect(stagingDeployWorkflow).toContain("VITE_FUNCTIONS_BASE_URL");
    expect(stagingDeployWorkflow).toContain(
      "uses: cloudflare/wrangler-action@953926a2e2182532811c01a25e53647d93bf07c0 # v4.1.3",
    );
    expect(stagingDeployWorkflow).toContain("workingDirectory: admin");
    expect(stagingDeployWorkflow).toContain(
      "pages deploy dist --project-name=njpbs-admin",
    );
  });

  it("builds every Admin with Home layouts enabled now that production renders them", () => {
    const workflow = parse(readFileSync(stagingDeployWorkflowPath, "utf8"));
    const builds = Object.values(workflow.jobs).flatMap((job: any) => job.steps ?? [])
      .filter((step: any) => step.run?.includes("npm run admin:build"));
    expect(builds.length).toBeGreaterThan(0);
    for (const build of builds) {
      expect(build.env ?? {}).not.toHaveProperty("VITE_CMS_HOME_LAYOUTS_ENABLED");
    }
    expect(read("../../scripts/deploy-admin.sh")).toMatch(
      /env -u GH_TOKEN -u GITHUB_TOKEN \\\r?\n\s+ADMIN_STATUS_MANIFEST_BASE64="\$admin_status_manifest" \\\r?\n\s+VITE_AUTHOR_PAGES_LIVE="\$author_release_selection" \\\r?\n\s+npm run admin:build/,
    );
    expect(read("../../scripts/deploy-admin.sh")).not.toContain("VITE_CMS_HOME_LAYOUTS_ENABLED");
    expect(read("../../.github/workflows/cms-dev-deploy.yml")).not.toContain("VITE_CMS_HOME_LAYOUTS_ENABLED");
  });

  it("keeps normal reviewed-main ancestry and binds authorized freeze source in every deploy job", () => {
    const workflow = parse(readFileSync(stagingDeployWorkflowPath, "utf8"));
    const sourceGate = read("../../.github/scripts/require-release-source.mjs");
    expect(workflow.on.workflow_dispatch.inputs.emergency_release.default).toBe(false);
    expect(sourceGate).toContain('git("merge-base", "--is-ancestor", sha, "origin/main")');
    expect(sourceGate).toContain('git("rev-list", "--first-parent", sha)');
    for (const name of ["admin-build", "firebase-preflight", "cms-api", "firebase", "preview-renderer"]) {
      const steps = workflow.jobs[name].steps;
      const target = steps.find((step: any) => step.uses === "actions/checkout@v7");
      expect(target.with.ref).toBe(name === "admin-build"
        ? "${{ inputs.deploy_ref }}" : "${{ needs.admin-build.outputs.deploy_sha }}");
      expect(target.with["fetch-depth"]).toBe(0);
      expect(target.with["persist-credentials"]).toBe(name !== "preview-renderer");
      const gateSource = steps.find((step: any) => step.with?.path === ".release-gate");
      expect(gateSource.with.ref).toBe("${{ github.sha }}");
      expect(gateSource.with["persist-credentials"]).toBe(false);
      const gate = steps.find((step: any) => step.name === (name === "preview-renderer"
        ? "Require reviewed renderer source" : "Require reviewed deploy ref"));
      expect(steps.indexOf(gateSource)).toBeLessThan(steps.indexOf(gate));
      expect(gate.run).toContain('node "$RUNNER_TEMP/release-gate"/.github/scripts/require-release-source.mjs');
      expect(gate.env.EMERGENCY_RELEASE).toBe("${{ inputs.emergency_release || false }}");
      expect(gate.env.EMERGENCY_AUTHORIZATION).toBe("${{ inputs.emergency_authorization || '' }}");
      if (name !== "preview-renderer") expect(gate.run).toContain("git fetch origin main");
    }
  });

  it("writes explicit bootstrap and account-email values without admission lists", () => {
    const stagingDeployWorkflow = readCmsDeployWorkflow();

    const table = JSON.parse(read("../../config/functions-configuration.json"));
    for (const key of ["BOOTSTRAP_SUPER_ADMINS", "CMS_STAFF_EMAIL_FROM", "CMS_STAFF_EMAIL_REPLY_TO"]) {
      expect(table.parameters[key].input).toBe(key);
      expect(table.inputs[key].variable).toBe(key);
    }
    expect(table.inputs.CMS_STAFF_EMAIL_ADMIN_ORIGIN.default).toBe("https://admin.njpbs.org");
    expect(stagingDeployWorkflow).toContain("component-runner.mjs functions configure");
    expect(stagingDeployWorkflow).toContain("CMS_DEPLOYMENT_VARIABLES_JSON: ${{ toJSON(vars) }}");
    expect(stagingDeployWorkflow).not.toContain("STAFF_EMAIL_DOMAINS");
    expect(stagingDeployWorkflow).not.toContain("STAFF_EMAIL_ALLOWLIST");
    expect(stagingDeployWorkflow).not.toContain(
      'if [ -n "${BOOTSTRAP_SUPER_ADMINS:-}" ]',
    );
  });

  it("builds the admin artifact before Firebase and uploads it afterward", () => {
    const stagingDeployWorkflow = readCmsDeployWorkflow();
    const adminBuildJob = workflowJob(stagingDeployWorkflow, "admin-build");
    const smokeManifestJob = workflowJob(
      stagingDeployWorkflow,
      "smoke-manifest",
    );
    const firebaseJob = workflowJob(stagingDeployWorkflow, "firebase");
    const cmsApiJob = workflowJob(stagingDeployWorkflow, "cms-api");
    const liveSmokeJob = workflowJob(stagingDeployWorkflow, "live-smoke");
    const adminDeployJob = workflowJob(stagingDeployWorkflow, "admin-deploy");

    expect(adminBuildJob).toContain("Preflight admin env");
    expect(adminBuildJob).toContain("npm run admin:build");
    expect(adminBuildJob).toContain("uses: actions/upload-artifact@v7");
    expect(adminBuildJob).toContain("name: cms-staging-admin");
    expect(adminBuildJob).toContain("path: admin/dist/");
    expect(adminBuildJob).not.toContain("firebase deploy");
    expect(smokeManifestJob).toContain("needs: admin-build");
    expect(smokeManifestJob).not.toContain("FIREBASE_SERVICE_ACCOUNT");
    expect(firebaseJob).toContain(
      "needs: [admin-build, firebase-preflight, smoke-manifest, verify]",
    );
    expect(firebaseJob).toContain(
      "ref: ${{ needs.admin-build.outputs.deploy_sha }}",
    );
    expect(firebaseJob).toContain("firebase deploy");
    expect(firebaseJob).not.toContain(".cms-smoke-gate");
    expect(cmsApiJob).toContain(
      "needs: [admin-build, firebase-preflight, firebase]",
    );
    expect(cmsApiJob).toContain("Deploy CMS API Worker");
    expect(liveSmokeJob).toContain(
      "needs: [admin-build, firebase, admin-deploy]",
    );
    expect(liveSmokeJob).toContain("node scripts/component-runner.mjs functions smoke");
    expect(liveSmokeJob).not.toContain("FIREBASE_SERVICE_ACCOUNT");
    expect(adminDeployJob).toContain("needs: [admin-build, cms-api, firebase, preview-renderer, firebase-preflight]");
    expect(adminDeployJob).toContain("uses: actions/download-artifact@v8");
    expect(adminDeployJob).toContain("name: cms-staging-admin");
    expect(adminDeployJob).toContain("path: admin/dist");
    expect(adminDeployJob).toContain("uses: cloudflare/wrangler-action@953926a2e2182532811c01a25e53647d93bf07c0 # v4.1.3");
    expect(adminDeployJob).toContain("CMS_ADMIN_ACCESS_API_TOKEN");
    expect(adminDeployJob).toContain("configure-admin-public-shell.mjs");
  });
});
