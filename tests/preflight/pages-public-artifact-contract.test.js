import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const pages = read("../../.github/workflows/pages.yml");
const cmsPublish = read("../../.github/workflows/cms-publish.yml");
const runtimeMarker = read(
  "../../scripts/pages-public-artifact-runtime-v1.txt",
);
const runtimeMarkerV2 = read(
  "../../scripts/pages-public-artifact-runtime-v2.txt",
);
const runtimeMarkerV3 = read(
  "../../scripts/pages-public-artifact-runtime-v3.txt",
);
const activeArtifactSelector = read(
  "../../functions/lib/pages-public-artifact.js",
);
const workerArtifactRuntimeMarker = read(
  "../../scripts/public-worker-artifact-runtime-v1.txt",
);
const pagesWorkflow = parse(pages);
const cmsPublishWorkflow = parse(cmsPublish);

function ordered(source, ...markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    expect(next, `${marker} is missing or out of order`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("production Pages public artifact contract", () => {
  it("refuses a credentialless production build", () => {
    expect(pages).toContain(
      "FIREBASE_SERVICE_ACCOUNT_CONFIGURED: ${{ (secrets.FIREBASE_PUBLISH_SERVICE_ACCOUNT || secrets.FIREBASE_SERVICE_ACCOUNT) != '' }}",
    );
    expect(pages).toContain("name: Require published CMS build credentials");
    expect(pages).toContain("env.FIREBASE_SERVICE_ACCOUNT_CONFIGURED != 'true'");
    expect(pages).toContain('if [ "$project_id" != "njpbs-site" ]');
  });

  it("keeps the prior build path for a pre-runtime deployment source", () => {
    expect(runtimeMarker.trim()).toBe("pages-public-artifact-runtime-v1");
    expect(runtimeMarkerV2.trim()).toBe("pages-public-artifact-runtime-v2");
    expect(runtimeMarkerV3.trim()).toBe("pages-public-artifact-runtime-v3");
    ordered(
      pages,
      "uses: actions/checkout@v7",
      "name: Detect regular Pages artifact runtime",
      "name: Require published CMS build credentials",
      "name: Verify the CMS artifact credential's project",
      "uses: actions/setup-node@v7",
    );
    expect(pages).toContain(
      'marker="scripts/pages-public-artifact-runtime-v1.txt"',
    );
    expect(pages).toContain(
      'marker_v2="scripts/pages-public-artifact-runtime-v2.txt"',
    );
    expect(pages).toContain(
      'marker_v3="scripts/pages-public-artifact-runtime-v3.txt"',
    );
    expect(pages).toContain('echo "version=v3" >> "$GITHUB_OUTPUT"');
    expect(pages).toContain('echo "version=v2" >> "$GITHUB_OUTPUT"');
    expect(pages).toContain('echo "version=v1" >> "$GITHUB_OUTPUT"');
    expect(pages).toContain('echo "version=legacy" >> "$GITHUB_OUTPUT"');
    expect(pages).toContain(
      "Selected deploy source predates the exact artifact runtime",
    );
    expect(pages).toContain(
      "Selected deploy source contains the verified pre-marker exact artifact runtime",
    );
    expect(pages).toContain('runtime_complete=true');
    expect(pages).toContain('marker_present=false');
    expect(pages).toContain(
      "if: steps.artifact_runtime.outputs.ready == 'true'",
    );
    expect(pages).toContain(
      "CMS_LOADER_STRICT: ${{ steps.artifact_runtime.outputs.ready == 'true' && '1' || '' }}",
    );
  });

  it("reuses the aligned active Worker cutoff without reserving a generation", () => {
    ordered(
      pages,
      "name: Refresh Media Manager content",
      "run: npm run sync:launch-content",
      "name: Refresh external content concurrently",
      "npm run sync:spotlight-news &",
      "npm run sync:schedule &",
      'if ! wait "$sync_pid"; then',
      'exit "$result"',
      "name: Reuse active public artifact cutoff",
      "name: Build",
    );
    expect(pages).toContain(
      'active_batch_id="$(node scripts/select-active-public-artifact.cjs "$SOURCE_SHA")"',
    );
    expect(pages).toContain(
      'echo "PUBLIC_BUILD_BATCH_ID=$active_batch_id" >> "$GITHUB_ENV"',
    );
    expect(pages).toContain(
      "PUBLIC_BUILD_BATCH_ID: ${{ steps.artifact_runtime.outputs.ready == 'true' && steps.active_artifact.outputs.build_batch_id || '' }}",
    );
    expect(pages).toContain(
      "PUBLIC_ARTIFACT_BATCH_MODE: ${{ steps.artifact_runtime.outputs.version == 'v3' && 'deployed' || '' }}",
    );
    expect(pages).not.toContain("name: Reserve exact public artifact cutoff");
    expect(pages).not.toContain("pages-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(activeArtifactSelector).toContain(
      "pointer.activeGeneration !== pointer.lastReservedGeneration",
    );
    expect(activeArtifactSelector).toContain(
      "pointer.activeGeneration !== pointer.newestEligibleGeneration",
    );
    expect(activeArtifactSelector).toContain(
      "pointer.activeCommitSha !== commitSha",
    );
    expect(pages).toContain("CMS_LOADER_STRICT:");
    expect(pages).toContain("CMS_CONTENT_MODE:");
    expect(pages).toContain(
      "PUBLIC_BUILD_COMMIT_SHA: ${{ steps.artifact_runtime.outputs.ready == 'true' && steps.source.outputs.sha || '' }}",
    );
    expect(pages).toContain(
      "PUBLIC_ARTIFACT_INVENTORY_PATH: ${{ steps.artifact_runtime.outputs.ready == 'true' && format('{0}/public-artifact.json', runner.temp) || '' }}",
    );
  });

  it("binds the final public bytes before the Pages artifact upload", () => {
    ordered(
      pages,
      "name: Detect prepared Worker artifact runtime",
      "name: Bind the final public Worker artifact",
      "uses: actions/configure-pages@v6",
      "uses: actions/upload-pages-artifact@v5",
    );
    expect(pages).toContain(
      '"$RUNNER_TEMP/public-worker-artifact.json"',
    );
    expect(workerArtifactRuntimeMarker.trim()).toBe(
      "public-worker-artifact-runtime-v1",
    );
    expect(pages).toContain(
      "steps.worker_artifact_runtime.outputs.ready == 'true'",
    );
    expect(pages).toContain(
      "Selected deploy source predates the prepared Worker artifact runtime",
    );
  });

  it("revalidates the selected batch immediately before Pages deployment", () => {
    ordered(
      pages,
      "name: Revalidate active public artifact",
      'current_batch_id="$(node scripts/select-active-public-artifact.cjs "$SOURCE_SHA")"',
      'if [ "$current_batch_id" != "$BUILD_BATCH_ID" ]; then',
      "name: Clean up published CMS build credentials",
      "uses: actions/upload-pages-artifact@v5",
    );
    expect(pages).toContain(
      "BUILD_BATCH_ID: ${{ steps.active_artifact.outputs.build_batch_id }}",
    );
    expect(pages).toContain("The selected public artifact is no longer active");
  });

  it("keeps regular and CMS Pages builds on the same strict artifact inputs", () => {
    for (const workflow of [pages, cmsPublish]) {
      expect(workflow).toContain("CMS_CONTENT_MODE:");
      expect(workflow).toContain("CMS_LOADER_STRICT:");
      expect(workflow).toContain("PUBLIC_BUILD_BATCH_ID:");
      expect(workflow).toContain("PUBLIC_BUILD_COMMIT_SHA:");
      expect(workflow).toContain("PUBLIC_ARTIFACT_INVENTORY_PATH:");
    }
    expect(JSON.stringify(pagesWorkflow.jobs.build.env)).not.toContain(
      "runner.temp",
    );
    expect(JSON.stringify(cmsPublishWorkflow.jobs.build.env)).not.toContain(
      "runner.temp",
    );
  });
});
