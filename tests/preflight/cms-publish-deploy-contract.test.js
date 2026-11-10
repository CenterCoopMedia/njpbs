import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/cms-publish.yml", import.meta.url),
);
const PAGES_WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/pages.yml", import.meta.url),
);

function orderedIndex(source, marker, after = -1) {
  const index = source.indexOf(marker, after + 1);
  expect(index, `Missing workflow marker: ${marker}`).toBeGreaterThan(after);
  return index;
}

describe("CMS publish deployment contract", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const pagesWorkflow = readFileSync(PAGES_WORKFLOW_PATH, "utf8");

  it("serializes the complete artifact lifecycle with regular Pages", () => {
    const jobs = orderedIndex(workflow, "jobs:\n");
    const workflowHeader = workflow.slice(0, jobs);
    expect(workflowHeader).toMatch(
      /concurrency:\n(?:\s+#.*\n)+\s+group: pages\n\s+queue: max\n\s+cancel-in-progress: false/,
    );
    expect(pagesWorkflow.slice(0, orderedIndex(pagesWorkflow, "jobs:\n"))).toMatch(
      /concurrency:\n\s+group: pages\n\s+queue: max\n\s+cancel-in-progress: false/,
    );

    const buildJob = orderedIndex(workflow, "  build:\n");
    const launchSync = orderedIndex(workflow, "- name: Refresh Media Manager content", buildJob);
    const launchCommand = orderedIndex(workflow, "run: npm run sync:launch-content", launchSync);
    const publicSync = orderedIndex(workflow, "- name: Refresh external content concurrently", launchCommand);
    const newsSync = orderedIndex(
      workflow,
      "npm run sync:spotlight-news &",
      publicSync,
    );
    const scheduleSync = orderedIndex(workflow, "npm run sync:schedule &", newsSync);
    const waitForAll = orderedIndex(workflow, 'if ! wait "$sync_pid"; then', scheduleSync);
    const refreshExit = orderedIndex(workflow, 'exit "$result"', waitForAll);
    const reserve = orderedIndex(
      workflow,
      "- name: Reserve exact public artifact cutoff",
      refreshExit,
    );
    const publicBuild = orderedIndex(workflow, "- name: Build site", reserve);
    const bindArtifact = orderedIndex(
      workflow,
      "- name: Bind the final public Worker artifact",
      publicBuild,
    );
    const pagesUpload = orderedIndex(
      workflow,
      "actions/upload-pages-artifact@v5",
      bindArtifact,
    );
    const deployJob = orderedIndex(workflow, "  deploy:\n", pagesUpload);
    const deployAction = orderedIndex(workflow, "actions/deploy-pages@v5", deployJob);

    const buildSection = workflow.slice(buildJob, deployJob);
    expect(buildSection).toContain("pages: read");
    expect(buildSection).not.toContain("pages: write");
    expect(buildSection).not.toContain("id-token: write");
    expect(buildSection.match(/REQUIRE_FRESH_CONTENT: "1"/g)).toHaveLength(2);
    expect(buildSection).toContain(
      "PUBLIC_REPORT_ENDPOINT: ${{ vars.PUBLIC_REPORT_ENDPOINT }}",
    );
    expect(buildSection).toContain(
      "PUBLIC_TURNSTILE_SITEKEY: ${{ vars.PUBLIC_TURNSTILE_SITEKEY }}",
    );

    const deploySection = workflow.slice(deployJob);
    expect(deploySection).toContain("needs: [authorize, build]");
    expect(deploySection).not.toMatch(/\n    concurrency:\n/);
    expect(deploySection).toContain("pages: write");
    expect(deploySection).toContain("id-token: write");
    expect(deploySection).not.toContain("contents: write");
    expect(deployAction).toBeGreaterThan(deployJob);
  });

  it("activates the self-contained receipt only with its production runtime", () => {
    expect(workflow).toContain('marker_v2="scripts/cms-publish-pages-deploy-v2.txt"');
    expect(workflow).toContain('echo "version=v2" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('echo "version=v1" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "deploy_runtime_version: ${{ steps.deploy_runtime.outputs.version }}",
    );
    expect(workflow).toContain(
      "DEPLOY_RUNTIME_VERSION: ${{ needs.build.outputs.deploy_runtime_version }}",
    );
    expect(workflow).toContain("PAGES_DEPLOYMENT_ID: ${{ github.sha }}");
    expect(workflow).toContain(
      'if (process.env.DEPLOY_RUNTIME_VERSION === "v2") {',
    );
    expect(workflow).toContain(
      "deployment.pagesDeploymentId = process.env.PAGES_DEPLOYMENT_ID;",
    );
  });

  it("prepares terminal writeback before deploy and settles no earlier", () => {
    const receiptPathExport = [
      "      - name: Export terminal receipt paths",
      "        env:",
      "          RECEIPT_DIRECTORY: ${{ runner.temp }}/cms-writeback",
      "        run: |",
      '          echo "ARTIFACT_RECEIPT=$RECEIPT_DIRECTORY/cms-public-artifact.json" >> "$GITHUB_ENV"',
      '          echo "DEPLOYMENT_RECEIPT=$RECEIPT_DIRECTORY/cms-deployment.json" >> "$GITHUB_ENV"',
    ].join("\n");
    expect(workflow.split(receiptPathExport)).toHaveLength(3);

    const buildJob = orderedIndex(workflow, "  build:\n");
    const bundle = orderedIndex(
      workflow,
      "- name: Prepare terminal writeback runtime",
      buildJob,
    );
    const bundleUpload = orderedIndex(
      workflow,
      "- name: Upload terminal writeback runtime",
      bundle,
    );
    const deployJob = orderedIndex(workflow, "  deploy:\n", bundleUpload);
    const bundleDownload = orderedIndex(
      workflow,
      "- name: Download terminal writeback runtime",
      deployJob,
    );
    const verify = orderedIndex(
      workflow,
      "- name: Verify terminal writeback before deploy",
      bundleDownload,
    );
    const deploy = orderedIndex(workflow, "actions/deploy-pages@v5", verify);
    const publicReceipt = orderedIndex(
      workflow,
      "- name: Verify exact CMS artifact at the public apex",
      deploy,
    );
    const settle = orderedIndex(
      workflow,
      "- name: Write terminal deployment result",
      publicReceipt,
    );

    expect(workflow.slice(buildJob, deployJob)).toContain(
      "steps.deploy_runtime.outputs.ready != 'true'",
    );
    const postDeploy = workflow.slice(deploy, settle);
    expect(postDeploy).not.toContain("actions/checkout");
    expect(postDeploy).not.toContain("actions/setup-node");
    expect(postDeploy).not.toContain("npm ci");
    expect(postDeploy).not.toContain("metered-api-scan");
    expect(workflow.slice(settle)).toContain("steps.deployment.outcome");
    expect(workflow.slice(deployJob)).toContain(
      "visible_at_ms: ${{ steps.public_receipt.outputs.visible_at_ms || steps.legacy_completion.outputs.visible_at_ms }}",
    );
    expect(workflow.slice(publicReceipt, settle)).toContain(
      "continue-on-error: true",
    );
    expect(workflow.slice(publicReceipt)).toContain("receipt.visibleAtMs");
    expect(workflow.slice(settle)).toContain('"$DEPLOYMENT_RECEIPT"');
    expect(workflow.slice(settle)).toContain("public_unconfirmed");
    expect(workflow).toContain("cms-deployment.json");

    const finalize = orderedIndex(workflow, "  finalize:\n", settle);
    const finalizeSection = workflow.slice(finalize);
    expect(finalizeSection).toContain(
      "VISIBLE_AT_MS: ${{ needs.deploy.outputs.visible_at_ms }}",
    );
    expect(finalizeSection).toContain(
      'if (/^\\d{1,16}$/.test(process.env.VISIBLE_AT_MS ?? ""))',
    );
    expect(finalizeSection).not.toContain(
      "The Pages completion time is missing or invalid",
    );
    expect(finalizeSection).toContain("if: >-");
    expect(finalizeSection).toContain("always() &&");
    expect(finalizeSection).toContain("needs.deploy.result != 'success'");
    expect(finalizeSection).toContain("actions: read");
    expect(finalizeSection).not.toContain("pages: write");
    expect(finalizeSection).not.toContain("id-token: write");
  });
});
