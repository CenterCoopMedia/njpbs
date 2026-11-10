import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const workflow = read("../../.github/workflows/cms-publish.yml");
const workerArtifactRuntimeMarker = read(
  "../../scripts/public-worker-artifact-runtime-v1.txt",
);

function ordered(...markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = workflow.indexOf(marker, cursor + 1);
    expect(next, `${marker} is missing or out of order`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("CMS publish artifact workflow contract", () => {
  it("reserves one Firestore cutoff before the strict published build", () => {
    ordered(
      "name: Capture built source commit",
      "name: Detect exact artifact runtime",
      "name: Configure Firestore build credentials",
      "name: Reserve exact public artifact cutoff",
      "name: Build site",
    );
    expect(workflow).toContain(
      'node scripts/prepare-cms-publish-artifact.cjs "$QUEUE_ID" "$BUILD_BATCH_ID" "$SOURCE_SHA"',
    );
    expect(workflow).toContain(
      "BUILD_BATCH_ID: cms-${{ github.event.client_payload.queueId }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain(
      "PUBLIC_BUILD_BATCH_ID: ${{ steps.artifact_runtime.outputs.ready == 'true' && env.BUILD_BATCH_ID || '' }}",
    );
    expect(workflow).toContain(
      "PUBLIC_BUILD_COMMIT_SHA: ${{ steps.artifact_runtime.outputs.ready == 'true' && steps.source.outputs.sha || '' }}",
    );
    expect(workflow).toContain(
      "PUBLIC_ARTIFACT_INVENTORY_PATH: ${{ steps.artifact_runtime.outputs.ready == 'true' && format('{0}/cms-public-artifact.json', runner.temp) || '' }}",
    );
    expect(workflow).toContain(
      "ARTIFACT_RECEIPT: ${{ runner.temp }}/cms-public-artifact.json",
    );
  });



  it("binds the final public bytes before it uploads the immutable artifact", () => {
    ordered(
      "name: Detect prepared Worker artifact runtime",
      "name: Bind the final public Worker artifact",
      "name: Prepare terminal writeback runtime",
      "name: Upload exact CMS publish artifact",
    );
    expect(workflow).toContain(
      '"$RUNNER_TEMP/cms-public-worker-artifact.json"',
    );
    expect(workerArtifactRuntimeMarker.trim()).toBe(
      "public-worker-artifact-runtime-v1",
    );
    expect(workflow).toContain(
      "steps.worker_artifact_runtime.outputs.ready == 'true'",
    );
    expect(workflow).toContain(
      'if [ "$WORKER_ARTIFACT_RUNTIME_READY" = "true" ]; then',
    );
    expect(workflow).toContain(
      "checksum_files=(update-publish-status.cjs cms-public-artifact.json)",
    );
    expect(workflow).toContain(
      'sha256sum "${checksum_files[@]}" > SHA256SUMS',
    );
  });




});
