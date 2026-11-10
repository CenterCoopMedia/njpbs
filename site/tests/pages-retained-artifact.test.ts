// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preparePublicArtifactBundle } from "../src/lib/public-artifact-build";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { readPublicArtifactBundle, writePublicArtifactBundle } from "../src/lib/public-artifact-bundle";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "pages-retained-"));
  directories.push(dir);
  // Older than PITR retention and deliberately not rounded to a whole minute.
  const cutoffAt = { seconds: 1_780_000_001, nanoseconds: 123456789, toMillis: () => 1_780_000_001_123 };
  const receipt = createPublicArtifactInventoryReceipt({ reservation: {
    schemaVersion: 1, buildBatchId: "cms-11111111111111111111", generation: 1, status: "reserved",
    commitSha: "a".repeat(40), reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
    reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt,
  }, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const bundle = { schemaVersion: 3 as const, pages: [], posts: [], programs: [], authors: [], settings: [], receipt };
  const retainedPath = path.join(dir, "retained.json");
  await writePublicArtifactBundle(retainedPath, bundle);
  const request = { buildBatchId: receipt.buildBatchId, commitSha: receipt.commitSha,
    batchMode: "deployed" as const, bundlePath: path.join(dir, "bundle.json"), outputPath: path.join(dir, "receipt.json") };
  return { bundle, request, env: { PUBLIC_ARTIFACT_DEPLOYED_CONTEXT_PATH: retainedPath } };
}

it("builds an old deployed cutoff from frozen content without Firestore credentials or reads", async () => {
  const { bundle, request, env } = await fixture();
  await preparePublicArtifactBundle(request, new Date("2026-09-16T00:00:00Z"), env);
  expect(await readPublicArtifactBundle(request.bundlePath)).toEqual(bundle);
});

it("fails closed when retained content is missing instead of reading old Firestore content", async () => {
  const { request } = await fixture();
  await expect(preparePublicArtifactBundle(request, new Date(), {})).rejects.toThrow(/requires retained/);
});

it.each(["commitSha", "buildBatchId"] as const)("rejects a retained %s mismatch", async field => {
  const { request, env } = await fixture();
  const mismatched = { ...request, [field]: field === "commitSha" ? "b".repeat(40) : "cms-22222222222222222222" };
  await expect(preparePublicArtifactBundle(mismatched, new Date(), env)).rejects.toThrow(/does not match/);
});
