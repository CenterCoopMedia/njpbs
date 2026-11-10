import { readFileSync } from "node:fs";

function requireText(source, text, owner) {
  if (!source.includes(text)) {
    throw new Error(`${owner} is missing ${text}`);
  }
}

export function assertPagesFallbackSafety(read = readFileSync) {
  const workflow = read(".github/workflows/pages.yml", "utf8");
  const safetyWorkflow = read(".github/workflows/pages-fallback-safety.yml", "utf8");
  const marker = read("scripts/pages-public-artifact-runtime-v3.txt", "utf8");
  const loader = read("site/src/lib/cms-loader.ts", "utf8");
  const inventory = read("site/src/lib/public-artifact-inventory.ts", "utf8");

  if (marker.trim() !== "pages-public-artifact-runtime-v3") {
    throw new Error("The Pages active-batch runtime marker is invalid");
  }
  for (const text of [
    "name: Reject generation-reserving Pages artifact runtimes",
    "name: Reuse active public artifact cutoff",
    "      - name: Revalidate active public artifact\n",
    'if [ "$current_batch_id" != "$BUILD_BATCH_ID" ]; then',
    "PUBLIC_ARTIFACT_BATCH_MODE: ${{ steps.artifact_runtime.outputs.version == 'v3' && 'deployed' || '' }}",
    "select-active-public-artifact.cjs",
    "site/scripts/prepare-pages-public-context.ts",
    "PUBLIC_ARTIFACT_DEPLOYED_CONTEXT_PATH:",
  ]) {
    requireText(workflow, text, "The Pages workflow");
  }
  const orderedSteps = [
    "      - name: Build\n",
    "      - name: Bind the final public Worker artifact\n",
    "      - name: Revalidate active public artifact\n",
    "      - name: Clean up published CMS build credentials\n",
    "      - uses: actions/upload-pages-artifact@v5\n",
  ];
  let previous = -1;
  for (const step of orderedSteps) {
    const position = workflow.indexOf(step);
    if (position <= previous) {
      throw new Error("The Pages artifact revalidation steps are out of order");
    }
    previous = position;
  }
  const deploy = workflow.split("\n  deploy:\n")[1] ?? "";
  for (const text of [
    "artifact_ready: ${{ steps.artifact_runtime.outputs.ready }}",
    "source_sha: ${{ steps.source.outputs.sha }}",
    "build_batch_id: ${{ steps.active_artifact.outputs.build_batch_id }}",
  ]) {
    requireText(workflow, text, "The Pages build outputs");
  }
  for (const text of [
    "ref: ${{ needs.build.outputs.source_sha }}",
    "SOURCE_SHA: ${{ needs.build.outputs.source_sha }}",
    "BUILD_BATCH_ID: ${{ needs.build.outputs.build_batch_id }}",
    'current_batch_id="$(node scripts/select-active-public-artifact.cjs "$SOURCE_SHA")"',
    'if [ "$current_batch_id" != "$BUILD_BATCH_ID" ]; then',
  ]) {
    requireText(deploy, text, "The Pages deploy job");
  }
  const deployCheck = deploy.indexOf(
    "      - name: Revalidate active public artifact at deployment\n",
  );
  const deployAction = deploy.indexOf(
    "      - id: deployment\n        uses: actions/deploy-pages@v5\n",
  );
  if (deployCheck < 0 || deployAction < 0) {
    throw new Error("The Pages deploy check must immediately precede deployment");
  }
  const nextDeployStep = deploy.indexOf("      - ", deployCheck + 1);
  if (nextDeployStep !== deployAction) {
    throw new Error("The Pages deploy check must immediately precede deployment");
  }
  const deployCheckStep = deploy.slice(deployCheck, deployAction);
  requireText(
    deployCheckStep,
    "        if: needs.build.outputs.artifact_ready == 'true'\n",
    "The Pages deploy check",
  );
  if (deployCheckStep.includes("\n        continue-on-error:")) {
    throw new Error("The Pages deploy check must fail closed");
  }
  for (const text of [
    '"production-candidate/**"',
    "node .github/scripts/pages-fallback-safety.mjs",
    "node --test .github/scripts/pages-fallback-safety.test.mjs",
  ]) {
    requireText(safetyWorkflow, text, "The Pages safety workflow");
  }
  for (const unsafe of [
    "name: Reserve exact public artifact cutoff",
    "pages-${{ github.run_id }}-${{ github.run_attempt }}",
    'node scripts/prepare-public-artifact.cjs "$PUBLIC_BUILD_BATCH_ID" "$SOURCE_SHA"',
  ]) {
    if (workflow.includes(unsafe)) {
      throw new Error(`The Pages workflow still contains ${unsafe}`);
    }
  }
  for (const text of [
    "assertStoredDeployedPublicArtifactBatch",
    'request.batchMode === "deployed"',
  ]) {
    requireText(loader, text, "The CMS artifact loader");
  }
  for (const text of [
    "assertStoredDeployedPublicArtifactBatch",
    "assertPublicDeploymentTerminalBatchStructure",
    'batch.status !== "deployed"',
  ]) {
    requireText(inventory, text, "The deployed-batch validator");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertPagesFallbackSafety();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
