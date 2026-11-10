// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { type PublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { assertPublicArtifactBundle, normalizePublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { assertContextMatchesPublication, readRetainedPublicContext, retainPublicContext } from "../src/lib/retained-public-context";
import { readPreviewPublicContext } from "../scripts/read-preview-public-context";
import savedHome from "./fixtures/home-v2-selections.json";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function bundle(buildBatchId = "released-build"): PublicArtifactBundle {
  const cutoffAt = { seconds: 1_780_000_000, nanoseconds: 0, toMillis: () => 1_780_000_000_000 };
  return { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
    receipt: createPublicArtifactInventoryReceipt({
      reservation: { schemaVersion: 1, buildBatchId, generation: 1, status: "reserved",
        commitSha: "a".repeat(40), reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
        reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt },
      pages: [], posts: [], programs: [], authors: [], settings: [],
    }) };
}

function publication(context: PublicArtifactBundle) {
  return { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: context.receipt.buildBatchId,
    generation: context.receipt.generation, commitSha: context.receipt.commitSha,
    mediaManifestDigest: context.receipt.mediaManifestDigest, artifactDigest: "d".repeat(64),
    artifactReceiptDigest: createHash("sha256").update(JSON.stringify(context.receipt)).digest("hex") };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "njpbs-retained-context-"));
  directories.push(root);
  const privateDirectory = path.join(root, "private");
  const distDirectory = path.join(root, "dist");
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(distDirectory, { mode: 0o700 });
  return { root, privateDirectory, distDirectory, outputPath: path.join(privateDirectory, "public-context.json"), bundle: bundle() };
}

it("keeps the private catalog dormant and forwards only the old v3 shape to legacy readers", async () => {
  const input = await fixture();
  const programImageDescriptors = { schemaVersion: 1 as const, buildBatchId: input.bundle.receipt.buildBatchId,
    generation: input.bundle.receipt.generation, rendererSha: input.bundle.receipt.commitSha,
    mediaManifestDigest: input.bundle.receipt.mediaManifestDigest, programs: [], files: [] };
  const enriched = { ...input.bundle, programImageDescriptors };
  expect(assertPublicArtifactBundle(enriched)).toEqual(enriched);
  expect(normalizePublicArtifactBundle(structuredClone(enriched))).toEqual(input.bundle);
  await retainPublicContext({ ...input, bundle: enriched });
  expect(await readFile(input.outputPath, "utf8")).toBe(`${JSON.stringify(input.bundle)}\n`);
  expect(await readRetainedPublicContext(input.outputPath, publication(input.bundle))).toEqual(input.bundle);
});

it("refuses mismatched paired-source support before producing or writing a catalog", async () => {
  const input = await fixture();
  await expect(retainPublicContext({ ...input, programImageReaders: {
    "node-compute": { rendererSha: input.bundle.receipt.commitSha, schemaVersion: 1 },
    cloudflare: { rendererSha: "b".repeat(40), schemaVersion: 1 },
  } })).rejects.toMatchObject({ code: "program_image_contract" });
  expect(await readdir(input.privateDirectory)).toEqual([]);
});

it("retains one complete owner-only copy and permits concurrent exact retries", async () => {
  const input = await fixture();
  await Promise.all([retainPublicContext(input), retainPublicContext(input)]);
  expect((await lstat(input.outputPath)).mode & 0o777).toBe(0o600);
  expect(await readdir(input.privateDirectory)).toEqual(["public-context.json"]);
  expect(await readdir(input.distDirectory)).toEqual([]);
  expect(await readRetainedPublicContext(input.outputPath, publication(input.bundle))).toEqual(input.bundle);
  const before = await readFile(input.outputPath);
  await expect(retainPublicContext({ ...input, bundle: bundle("different-build") })).rejects.toThrow(/cannot be replaced/);
  expect(await readFile(input.outputPath)).toEqual(before);
  expect(await readdir(input.privateDirectory)).toEqual(["public-context.json"]);
});

it("refuses public output folders and directories readable by other users", async () => {
  const input = await fixture();
  await expect(retainPublicContext({ ...input, outputPath: path.join(input.distDirectory, "public-context.json") }))
    .rejects.toThrow(/outside the public artifact/);
  await chmod(input.privateDirectory, 0o755);
  await expect(retainPublicContext(input)).rejects.toThrow(/owner-only directory/);
  expect(await readdir(input.distDirectory)).toEqual([]);
  expect(await readdir(input.privateDirectory)).toEqual([]);
});

it("refuses symlinked output files and readable retained files", async () => {
  const input = await fixture();
  await retainPublicContext(input);
  const alias = path.join(input.privateDirectory, "alias.json");
  await symlink(input.outputPath, alias);
  await expect(readRetainedPublicContext(alias, publication(input.bundle))).rejects.toThrow();
  await chmod(input.outputPath, 0o644);
  await expect(readRetainedPublicContext(input.outputPath, publication(input.bundle))).rejects.toThrow(/owner-only regular file/);
});

it.each([
  { generation: 2 }, { buildBatchId: "other-build" }, { commitSha: "b".repeat(40) },
  { artifactReceiptDigest: "e".repeat(64) }, { mediaManifestDigest: "f".repeat(64) },
])("refuses context from a different publication: %j", mismatch => {
  const context = bundle();
  expect(() => assertContextMatchesPublication(context, { ...publication(context), ...mismatch }))
    .toThrow(/does not match the current publication/);
});

it("selects only the real root's current serializer job and detects a deployment change", async () => {
  const input = await fixture();
  const queueId = "11111111111111111111";
  const job = path.join(input.privateDirectory, "jobs", queueId);
  await mkdir(job, { recursive: true, mode: 0o700 });
  const context = bundle(`cms-${queueId}`);
  await retainPublicContext({ ...input, bundle: context, outputPath: path.join(job, "public-context.json") });
  const current = publication(context);
  const request = vi.fn(async () => JSON.stringify(current));
  expect(await readPreviewPublicContext(input.privateDirectory, request)).toEqual({ publicContext: context, publication: current });
  expect(request.mock.calls).toEqual([["https://njpbs.org/_publication.json?cms-context=code"], ["https://njpbs.org/_publication.json?cms-context=code"]]);
  request.mockResolvedValueOnce(JSON.stringify(current));
  request.mockResolvedValueOnce(JSON.stringify({ ...current, generation: 2 }));
  await expect(readPreviewPublicContext(input.privateDirectory, request)).rejects.toThrow(/changed while reading/);
  request.mockResolvedValueOnce(JSON.stringify({ ...current, buildBatchId: "manual-build" }));
  await expect(readPreviewPublicContext(input.privateDirectory, request)).rejects.toThrow(/no retained serializer context/);
});

it("accepts a context written before the Programs route move and returns the current shape", () => {
  const current = bundle();
  const old = structuredClone(current) as unknown as { receipt: { aggregateRoutes: string[] } };
  old.receipt.aggregateRoutes = ["/posts/", "/staff/"];
  const live = { ...publication(current),
    artifactReceiptDigest: createHash("sha256").update(JSON.stringify(old.receipt)).digest("hex") };
  const read = assertContextMatchesPublication(old, live);
  expect(read.receipt.aggregateRoutes).toEqual(["/posts/", "/programs/", "/events/", "/staff/"]);
  expect(old.receipt.aggregateRoutes).toEqual(["/posts/", "/staff/"]);
});

it("retains the same published source catalog that the built Home and staff endpoint used", async () => {
  const input = await fixture();
  const receipt = { ...savedHome.editorial.receipt, buildBatchId: input.bundle.receipt.buildBatchId, generation: 1 };
  const homeSources = { schemaVersion: 1, publication: { buildBatchId: receipt.buildBatchId, generation: 1, commitSha: receipt.commitSha },
    editorial: { ...savedHome.editorial, receipt }, pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] },
    spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } };
  await writeFile(path.join(input.distDirectory, "_home-sources.json"), JSON.stringify(homeSources));
  await retainPublicContext(input);
  const reopened = await readRetainedPublicContext(input.outputPath, publication(input.bundle));
  expect(reopened.homeSources).toEqual(homeSources);
  const wrong = { ...homeSources, publication: { ...homeSources.publication, generation: 2 } };
  await writeFile(path.join(input.distDirectory, "_home-sources.json"), JSON.stringify(wrong));
  await expect(retainPublicContext(input)).rejects.toThrow(/do not match this publication/);
});
