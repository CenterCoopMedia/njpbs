import { releasePair, pairReference } from "../helpers/private-public-release-pair";
import { projectPublicReleasePairStaticArtifact } from "../../site/scripts/public-release-pair-static-artifact";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import staticReturn from "../../functions/lib/no-build-post-static-return.js";
import sourceBody from "../../functions/lib/public-release-source-body.js";
import { prepareStaticPostProof } from "../../site/scripts/prepare-static-post-proof";
import { prepareStaticPostProof as liveProducer } from "../../site/scripts/upload-public-worker-candidate";
import { createPublicArtifactInventoryReceipt, finalizePublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { prepareContentBaseline, seedContentBaseline } from "../../site/scripts/public-content-baseline-artifact";
import { baselineObjectKey } from "../../packages/content-core/src/public-content-baseline";
import { publicationTarget } from "../../functions/lib/publication-target";
import { freezePublicReleasePairStaticSource } from "../../site/scripts/public-release-pair-static-source-storage";
import { openFrozenPublicReleasePairStaticSource, PAIR_STATIC_SOURCE_FILE } from "../../site/scripts/public-release-pair-static-source";
import { PAIR_CODE_PACK_CHUNK_BYTES, encodePublicReleasePairCodePackChunk } from "../../site/scripts/public-release-pair-code-pack-chunks";
const oldSha = "a".repeat(40), target = publicationTarget("development");
const fixtureSource = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8"));
let runtime: Miniflare, bucket: R2Bucket;
const directories: string[] = [];
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "pair-static-source", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "pair-static-source" } } } }] }); bucket = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => { const objects = await bucket.list(); if (objects.objects.length) await bucket.delete(objects.objects.map(object => object.key)); });
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
afterAll(async () => { await runtime?.dispose(); });
async function fixture(visible = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "pair-static-source-")); directories.push(directory);
  const distDirectory = path.join(directory, "dist"); await mkdir(distDirectory);
  const document = { ...structuredClone(fixtureSource.document), version: 7, publishAt: fixtureSource.document.published.publishedAt, publiclyVisible: visible, status: visible ? "published" : "draft" };
  const state: any = { mode: "static", postId: document.id, operationId: "S".repeat(20), generation: 5, rendererSha: oldSha,
    sourceVersion: 7, visible, slug: document.published.metadata.slug, ownedSlugs: [document.published.metadata.slug] };
  const ownerPath = `system/publicDeployment/noBuildPostOwners/${document.id}`;
  const documents = new Map<string, any>([[`cmsPosts/${document.id}`, document], [ownerPath, state], ["system/publicDeployment/contexts/public", { schemaVersion: 1, revision: 2 }]]);
  const input = await staticReturn.currentStaticInput({ state, firestore: { doc: (path: string) => path }, transaction: { get: async (path: string) => ({ data: () => documents.get(path) }) } } as any);
  const contents: Record<string, string> = { "index.html": "<html>OLD home</html>", "posts/index.html": "<html>OLD listing</html>", "programs/index.html": "<html>OLD programs</html>",
    "events/index.html": "<html>OLD events</html>", "staff/index.html": "<html>OLD staff</html>", "feeds/news.xml": "<rss>OLD</rss>", "api/v1/content.json": "{}",
    "pagefind/pagefind.js": "OLD engine", "search/meaning-index.json": "{}", "sitemap.xml": "<urlset/>" };
  if (visible) contents[`posts/${input.slug}/index.html`] = "<html>OLD Post</html>";
  for (const page of PUBLIC_PAGES) for (const route of [page.path, ...("aliases" in page ? page.aliases : [])]) {
    const name = `${route.slice(1)}index.html`; contents[name] ??= `<html>OLD committed ${route}</html>`;
  }
  for (const [name, body] of Object.entries(contents)) { await mkdir(path.dirname(path.join(distDirectory, name)), { recursive: true }); await writeFile(path.join(distDirectory, name), body); }
  const timestamp = { seconds: 1_760_000_000, nanoseconds: 0, toMillis: () => 1_760_000_000_000 };
  const reservation = { schemaVersion: 1, buildBatchId: `cms-${"B".repeat(20)}`, generation: 5, commitSha: oldSha,
    reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt: timestamp, reservedAt: timestamp };
  const artifact = createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: visible ? [{ kind: "post", documentId: document.id, sourceVersion: 7,
    canonicalPath: `/posts/${input.slug}/`, aliases: [], publishedSnapshot: document.published }] : [], programs: [], authors: [], settings: [] });
  await finalizePublicArtifactInventoryReceipt({ receipt: artifact, distDirectory, outputPath: path.join(directory, "inventory.json") });
  const prepared = await preparePublicWorkerArtifact({ artifactReceipt: artifact, distDirectory, outputPath: path.join(directory, "prepared.json") });
  state.staticProof = await prepareStaticPostProof({ input, artifact, prepared, distDirectory });
  expect(liveProducer).toBe(prepareStaticPostProof);
  const plan = await prepareContentBaseline({ target, distDirectory, preparedArtifact: prepared });
  await seedContentBaseline(plan, { writeAndVerify: async (key, bytes) => { await bucket.put(key, new Uint8Array(bytes)); } });
  const publicationBytes = new Uint8Array(await readFile(path.join(distDirectory, "_publication.json")));
  const statusBytes = new Uint8Array(await readFile(path.join(distDirectory, "_content-status.json")));
  const files = new Map<string, Uint8Array>();
  const chunk = (prefix: string, bytes: Uint8Array) => Array.from({ length: Math.max(1, Math.ceil(bytes.length / PAIR_CODE_PACK_CHUNK_BYTES)) }, (_, index) => {
    const name = `${prefix}/${String(index).padStart(4, "0")}.json`; files.set(name, encodePublicReleasePairCodePackChunk(bytes.subarray(index * PAIR_CODE_PACK_CHUNK_BYTES, (index + 1) * PAIR_CODE_PACK_CHUNK_BYTES))); return name;
  });
  const capture = (originalPublication = plan.baseline.publication) => freezePublicReleasePairStaticSource({ state: { documents } as any, originalPublication, environment: "development", files, chunk,
    readContentObject: async key => { const object = await bucket.get(key); if (!object) throw new Error("Missing immutable test object"); return new Uint8Array(await object.arrayBuffer()); } });
  const open = () => openFrozenPublicReleasePairStaticSource({ documents, originalPublication: plan.baseline.publication,
    readFrozenFile: async name => { const bytes = files.get(name); if (!bytes) throw new Error("Missing H test dependency"); return bytes; } });
  return { documents, state, ownerPath, plan, files, capture, open, publicationBytes, statusBytes };
}
it.each([true, false])("retains actual original static receipt bytes and reopens H after all original R2 objects disappear (visible %s)", async visible => {
  const value = await fixture(visible); await value.capture();
  const objects = await bucket.list(); await bucket.delete(objects.objects.map(object => object.key));
  const reopened = await value.open(); expect(reopened!.publicationBytes).toEqual(value.publicationBytes); expect(reopened!.statusBytes).toEqual(value.statusBytes);
  expect(reopened!.publication.commitSha).toBe(oldSha);
  const retained = sourceBody.publicReleaseAuthorityProjection(value.state); expect(retained.staticProof).toEqual(value.state.staticProof);
  expect(() => sourceBody.publicReleaseAuthorityProjection({ ...value.state, staticProof: { ...value.state.staticProof, privateSecret: "not a valid public proof field" } })).toThrow();
});
it.each(["missing", "corrupt"])("refuses %s original immutable publication bytes before H capture", async mode => {
  const value = await fixture(), file = value.state.staticProof.files.find((file: any) => file.path === "/_publication.json");
  const key = baselineObjectKey(target, file.digest);
  if (mode === "missing") await bucket.delete(key); else await bucket.put(key, "corrupt original publication");
  await expect(value.capture()).rejects.toThrow();
});
it("retains the owner's actual static artifact when CODE has another artifact under the same renderer", async () => {
  const value = await fixture();
  await value.capture({ ...value.plan.baseline.publication, buildBatchId: `cms-${"Z".repeat(20)}`, generation: 4,
    artifactDigest: "e".repeat(64), artifactReceiptDigest: "f".repeat(64) });
  expect((await value.open())!.publicationBytes).toEqual(value.publicationBytes);
  await expect(value.capture({ ...value.plan.baseline.publication, commitSha: "b".repeat(40) })).rejects.toThrow();
});
it("refuses stale source input and missing or mismatched H chunks", async () => {
  const value = await fixture(); value.documents.get("system/publicDeployment/contexts/public").revision++;
  await expect(value.capture()).rejects.toThrow(); value.documents.get("system/publicDeployment/contexts/public").revision--;
  await value.capture(); const descriptor = JSON.parse(new TextDecoder().decode(value.files.get(PAIR_STATIC_SOURCE_FILE)!)), file = descriptor.files[1].chunkFiles[0];
  const bytes = value.files.get(file)!; value.files.delete(file);
  await expect(value.open()).rejects.toMatchObject({ code: "input-unavailable", reason: "pair-static-source-missing" });
  value.files.set(file, new TextEncoder().encode(JSON.stringify({ bodyBase64: Buffer.from("corrupt").toString("base64") })));
  await expect(value.open()).rejects.toMatchObject({ code: "byte-mismatch", reason: "pair-static-source-mismatch" }); value.files.set(file, bytes);
  value.state.staticProof.files[0].digest = "f".repeat(64);
  await expect(value.open()).rejects.toMatchObject({ code: "byte-mismatch", reason: "pair-static-source-mismatch" });
});

it.each([true, false])("projects the full NEW artifact recipe from frozen raw source with an attempt-independent task identity (visible %s)", async visible => {
  const value = await fixture(visible); await value.capture(); const source = (await value.open())!;
  const originalProof = JSON.stringify(source.proof), originalPublication = new Uint8Array(source.publicationBytes);
  const pair = releasePair("b", "b".repeat(40));
  const identity = { schemaVersion: 2 as const, pair: pairReference(pair), kind: "qualification" as const,
    sourceOperationId: "static-target-one", sourceVersion: 7, snapshotDigest: "c".repeat(64), contextSequence: 1, inputManifestDigest: "d".repeat(64) };
  const options = { pair, identity, source, documents: value.documents, renderedAt: "2026-10-28T04:00:00.000Z" };
  const first = projectPublicReleasePairStaticArtifact(options), repeated = projectPublicReleasePairStaticArtifact(options);
  const next = projectPublicReleasePairStaticArtifact({ ...options, identity: { ...identity, inputManifestDigest: "e".repeat(64) } });
  expect(repeated.receipt).toEqual(first.receipt); expect(next.receipt.buildBatchId).not.toBe(first.receipt.buildBatchId);
  expect(first.receipt.commitSha).toBe(pair.commitSha); expect(first.receipt.generation).toBe(source.owner.state.generation);
  expect(first.receipt.mediaManifestDigest).not.toBe(source.publication.mediaManifestDigest);
  expect(first.receipt.families.find(family => family.collection === "cmsPosts")!.artifacts).toEqual(visible ? [
    { documentId: source.proof.postId, sourceVersion: 7, canonicalPath: "/posts/shadow-fixture/", aliases: [] },
  ] : []);
  expect(first.receipt.ownerCount).toBe(visible ? 1 : 0);
  value.documents.set("cmsSettings/coverage-labels", { schemaVersion: 1, version: 2,
    values: { labels: [] }, published: { schemaVersion: 1, sourceVersion: 1, publishedAt: "2026-10-28T03:00:00.000Z",
      values: { labels: [{ id: "nj-decides-2026", name: "NJ Decides 2026", textColor: "#011375", backgroundColor: "#e9eaee", retired: true }] } } });
  const withCoverage = projectPublicReleasePairStaticArtifact(options);
  expect(withCoverage.receipt.ownerCount).toBe(visible ? 2 : 1);
  expect(withCoverage.settings).toContainEqual({ settingId: "coverage-labels", sourceVersion: 1, publishedAt: "2026-10-28T03:00:00.000Z",
    labels: [{ id: "nj-decides-2026", name: "NJ Decides 2026", textColor: "#011375", backgroundColor: "#e9eaee", retired: true }] });
  expect(JSON.stringify(source.proof)).toBe(originalProof); expect(source.publicationBytes).toEqual(originalPublication);
});
