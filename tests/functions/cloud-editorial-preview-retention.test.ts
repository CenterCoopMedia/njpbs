import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { Timestamp } from "firebase-admin/firestore";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import aggregates from "../../functions/lib/public-context-publication.js";
import context from "../../functions/lib/public-context-revision.js";
import work from "../../functions/lib/no-build-cloud-work.js";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { backgroundInputFiles, createNoBuildPreparationStorage } from "../../site/scripts/no-build-preparation-storage";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import { buildNoBuildCloudPreviewProjection } from "../../site/scripts/build-no-build-cloud-background";
import { assertHomeSourcePublication } from "../../site/src/lib/home-editorial-catalog";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { createCmsPreviewCloudStorage } from "../../site/scripts/cms-preview-cloud-storage";
import { cloudEditorialPreviewRetention } from "../../site/scripts/cloud-editorial-preview-retention";
import { requestPublicPublicationReceipt } from "../../site/scripts/activate-public-worker-candidate";
import { EDITORIAL_CONTEXTS_COLLECTION, EDITORIAL_SEALS_COLLECTION, LAST_SEALED_EDITORIAL_CONTEXT } from "../../site/scripts/cms-preview-editorial-context";
import { readPublicationHealth, OVERDUE_MS } from "../../publisher/publication-health";

const db = isolatedFirestore("cloud-editorial-preview-retention.test.ts");
const A = "A".repeat(20), B = "B".repeat(20), digest = context.publicContextDigest(1);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const queueRef = () => db.doc(`cmsPublishQueue/${B}`);
const preparationRef = () => db.doc(`cmsPublishQueue/${A}/backgroundPreparation/${digest}`);
let release: string, directory: string, endpoint: string, clock: number;
let publication: any, bundle: any, runtime: any;
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let background: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let client: S3Client;
let server: ReturnType<typeof createServer>;
const objects = new Map<string, Buffer>();
let puts = 0, receiptReads = 0, losePut = false, refuseReceipt = false;
let afterPut: (() => Promise<void>) | null = null;
let afterGet: (() => Promise<void>) | null = null;
let beforeReceipt: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use local demo emulators");
  release = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  runtime = { owner: "cloudflare", release };
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "editorial-retention-")));
  background = await backgroundStorageFixture("editorial-background-fixture");
  app = firebaseAdminRuntime.initializeApp({ projectId: db.projectId }, "editorial-retention");
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/receipt") {
      receiptReads++;
      await beforeReceipt?.();
      if (refuseReceipt) { response.writeHead(503).end(); return; }
      response.writeHead(200, { "content-type": "application/json", "x-njpbs-publication-origin": "njpbs-production" })
        .end(JSON.stringify(publication)); return;
    }
    const key = decodeURIComponent(url.pathname.slice("/njpbs-cms-previews/".length));
    if (!url.pathname.startsWith("/njpbs-cms-previews/")) { response.writeHead(404).end(); return; }
    if (request.method === "PUT") {
      expect(request.headers["if-none-match"]).toBe("*");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) { response.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>"); return; }
      objects.set(key, Buffer.concat(chunks)); puts++;
      await afterPut?.();
      if (losePut) { response.writeHead(500).end("<Error><Code>InternalError</Code></Error>"); return; }
      response.writeHead(200).end(); return;
    }
    const bytes = objects.get(key);
    if (!bytes) { response.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>"); return; }
    await afterGet?.();
    response.writeHead(200, { "content-length": String(bytes.length), "content-type": "application/octet-stream" }).end(bytes);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  client = new S3Client({ endpoint, region: "auto", forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: "local-fixture", secretAccessKey: "local-fixture" } });
});
afterAll(async () => {
  client?.destroy(); await new Promise<void>(resolve => server?.close(() => resolve()));
  await background?.close(); if (app) await firebaseAdminRuntime.deleteApp(app);
  if (directory) await rm(directory, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  // Reset only this fixture's project, without BulkWriter's wall-clock limiter.
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  background.objects.clear(); background.reject(null); background.refuseReads(false); background.onRead(null);
  objects.clear(); puts = 0; receiptReads = 0; losePut = false; refuseReceipt = false; afterPut = null; afterGet = null; beforeReceipt = null;
  clock = Date.parse("2026-10-13T04:00:00Z");
  publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: "cms-" + "C".repeat(20),
    generation: 1, commitSha: release, artifactDigest: "c".repeat(64), artifactReceiptDigest: "d".repeat(64), mediaManifestDigest: "e".repeat(64) };
  await db.doc("system/publicDeployment").set({ state: "idle", activeGeneration: 1, activeCommitSha: release, activeDeploymentId: "fixture" });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: clock });
  const accept = async (operationId: string) => db.runTransaction(async transaction => {
    const accepted = await aggregates.enqueuePublicContextInTransaction({ transaction, firestore: db, operationId, runtime, reason: "context", contextRevision: 1 });
    accepted.write();
  });
  await accept(A);
  const reservation = { schemaVersion: 1 as const, buildBatchId: `post-background-${A}-${digest}`, generation: 2,
    commitSha: release, status: "reserved" as const, reservedAgainstGeneration: 1, reservedAgainstDeploymentId: "fixture",
    reservedAgainstCommitSha: release, cutoffAt: Timestamp.fromMillis(clock), reservedAt: Timestamp.fromMillis(clock) };
  const receipt = createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: [], programs: [], authors: [], settings: [] });
  bundle = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [], receipt };
  const prepared = path.join(directory, "prepared"); await mkdir(prepared, { recursive: true, mode: 0o700 });
  await writeFile(path.join(prepared, "public-context.json"), JSON.stringify(bundle) + "\n", { mode: 0o600 });
  await writeFile(path.join(prepared, "receipt.json"), "{}", { mode: 0o600 });
  await writeFile(path.join(prepared, "artifact-inventory.json"), JSON.stringify(receipt), { mode: 0o600 });
  const cloud = createNoBuildPreparationStorage("editorial-background-fixture", app,
    { operationId: A, contextDigest: digest, commitSha: release, owner: "cloudflare", cutoffMillis: clock, admissionRevision: null });
  const preparedDigest = await cloud.checkpoint("prepared", prepared, ["receipt.json", "artifact-inventory.json", "public-context.json"]);
  const batch = db.batch();
  batch.set(preparationRef(), { schemaVersion: 1, runtime, status: "verified", contextDigest: digest, preparedDigest,
    backgroundBucket: "editorial-background-fixture", admissionRevision: null, reservation });
  for (const output of aggregates.OUTPUTS) {
    batch.update(db.doc(`cmsBackgroundOutputs/${output}`), { status: "verified", receipt: {
      rendererSha: release, contextDigest: digest, revision: 1, verifiedAt: clock, digest: "f".repeat(64), routeSetDigest: "e".repeat(64) } });
    batch.update(db.doc(`cmsPublishQueue/${A}/backgroundOutputs/${output}`), { status: "verified" });
  }
  await batch.commit(); expect(await aggregates.settlePublicContext({ firestore: db, operationId: A, runtime })).toBe(true);
  await accept(B); expect(await aggregates.settlePublicContext({ firestore: db, operationId: B, runtime })).toBe(true);
  await rm(prepared, { recursive: true, force: true });
});
const owner = () => cloudEditorialPreviewRetention({ firestore: db, firebaseApp: app, runtime, serializerId: "cloudflare-publisher",
  backgroundBucket: "editorial-background-fixture", stateDirectory: directory, client,
  previewStorageCredential: { accessKeyId: "unused-fixture", secretAccessKey: "unused-fixture" },
  requestPublication: () => requestPublicPublicationReceipt(endpoint + "/receipt?cms-context=code"), clock: () => clock });
const preview = async () => (await queueRef().get()).data()!.previewContext;

it("restores original A on cold disk and retains accepted B with the real CODE receipt", async () => {
  const original = await preparationRef().get();
  expect(await owner()()).toBe(true);
  const marker = await preview(); expect(marker).toMatchObject({ status: "verified", contextDigest: digest,
    publicationGeneration: 1, publicationArtifactReceiptDigest: publication.artifactReceiptDigest });
  const manifest = (await db.collection(EDITORIAL_CONTEXTS_COLLECTION).doc(marker.manifestId).get()).data()!;
  expect(manifest.schemaVersion).toBe(1);
  expect(Object.keys(manifest).sort()).toEqual(["byteLength", "contextReceipt", "key", "schemaVersion", "selection", "sha256"]);
  expect((await db.collection(EDITORIAL_SEALS_COLLECTION).doc(marker.manifestId).get()).data()).toEqual({
    ...manifest, schemaVersion: 2, withdrawalRevision: 0 });
  expect(manifest.selection).toMatchObject({ operationId: B, checkpointIdentity: { operationId: A }, publication });
  expect(manifest.contextReceipt.generation).toBe(2);
  expect(manifest.selection.publication.generation).toBe(1);
  expect(hash(objects.get(manifest.key)!)).toBe(manifest.sha256);
  const after = await preparationRef().get(); expect(after.data()).toEqual(original.data()); expect(after.updateTime).toEqual(original.updateTime);
  expect((await db.doc(`cmsPublishQueue/${B}/backgroundPreparation/${digest}`).get()).exists).toBe(false);
  const before = receiptReads; expect(await owner()()).toBe(false); expect(receiptReads).toBe(before); expect(puts).toBe(1);
});

it("resumes uploaded bytes after lost response without another write or checkpoint build", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  losePut = true; await owner()(); expect((await preview()).status).toBe("failed");
  expect((await db.collection(EDITORIAL_CONTEXTS_COLLECTION).get()).size).toBe(0); expect(puts).toBe(1);
  clock = (await preview()).nextAttemptAt; losePut = false;
  await rm(path.join(directory, "preview-context"), { recursive: true, force: true });
  await owner()(); expect((await preview()).status).toBe("verified"); expect(puts).toBe(1);
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain("InternalError");
});

it("bounds receipt failures and exposes exhaustion through the existing health reader", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {}); refuseReceipt = true;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await owner()(); expect(await preview()).toMatchObject({ status: "failed", attempts: attempt, diagnostic: "receipt" });
    if (attempt < 4) clock = (await preview()).nextAttemptAt;
  }
  const reads = receiptReads; expect(await owner()()).toBe(false); expect(receiptReads).toBe(reads);
  const health = await readPublicationHealth({ runtime, now: clock + OVERDUE_MS,
    read: async name => (await db.doc(name).get()).data() ?? null, listOwners: async () => [] });
  expect(health.reasons).toContain("preview_context_exhausted");
  expect((await queueRef().get()).data()!.status).toBe("success"); expect(puts).toBe(0);
});

it.each(["claim", "context", "code", "pause"])("refuses verified completion after an upload %s race", async race => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  afterPut = async () => {
    if (race === "claim") await queueRef().update({ "previewContext.claim": "Z".repeat(20) });
    if (race === "context") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
    if (race === "code") await db.doc("system/publicDeployment").update({ activeGeneration: 2 });
    if (race === "pause") await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  };
  await owner()(); expect((await preview()).status).not.toBe("verified");
  expect((await db.collection(EDITORIAL_CONTEXTS_COLLECTION).get()).size).toBe(0);
  if (race === "claim") expect((await preview()).claim).toBe("Z".repeat(20));
});

it("refuses a concurrent malformed verified marker without resetting its state", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const malformed = { status: "verified", publicationGeneration: 1, contextDigest: digest,
    manifestId: "bad", publicationArtifactReceiptDigest: "d".repeat(64) };
  beforeReceipt = async () => { await queueRef().update({ previewContext: malformed }); };
  await expect(owner()()).rejects.toThrow(/Invalid verified/);
  expect(await preview()).toEqual(malformed); expect(puts).toBe(0);
});

it("records an expired final claim once without receipt or storage work", async () => {
  await queueRef().update({ previewContext: { status: "building", publicationGeneration: 1, contextDigest: digest,
    manifestId: "b".repeat(64), publicationArtifactReceiptDigest: "d".repeat(64), attempts: 4,
    startedAt: clock - 600_000, nextAttemptAt: clock - 1, claim: "Q".repeat(20) } });
  expect(await owner()()).toBe(true); expect(await preview()).toMatchObject({ status: "failed", attempts: 4, nextAttemptAt: null });
  expect(await owner()()).toBe(false); expect(receiptReads).toBe(0); expect(puts).toBe(0);
});

it("global pause refuses a new claim and any CODE request", async () => {
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  expect(await owner()()).toBe(false); expect(receiptReads).toBe(0); expect(await preview()).toBeUndefined();
});

it("refuses a corrupt original checkpoint without changing A or the public queue", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const before = await preparationRef().get();
  const key = `post-background-v1/preparation/${A}/${digest}/prepared.json`;
  background.objects.set(key, Buffer.from("corrupt"));
  await owner()();
  expect(await preview()).toMatchObject({ status: "failed", attempts: 1, diagnostic: "restore" });
  const after = await preparationRef().get(); expect(after.data()).toEqual(before.data()); expect(after.updateTime).toEqual(before.updateTime);
  expect((await queueRef().get()).data()!.status).toBe("success"); expect(puts).toBe(0);
});

it("refuses corrupted private object readback before publishing the manifest", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  afterPut = async () => { for (const key of objects.keys()) objects.set(key, Buffer.from("corrupt")); };
  await owner()(); expect(await preview()).toMatchObject({ status: "failed", diagnostic: "retain" });
  expect((await db.collection(EDITORIAL_CONTEXTS_COLLECTION).get()).size).toBe(0);
  expect((await queueRef().get()).data()!.status).toBe("success");
});

it("bounds a foreign real receipt source without restoring or storing context", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  publication.commitSha = "f".repeat(40);
  await owner()(); expect(await preview()).toMatchObject({ status: "failed", attempts: 1, diagnostic: "selector" });
  expect(puts).toBe(0); expect((await db.collection(EDITORIAL_CONTEXTS_COLLECTION).get()).size).toBe(0);
});

it("retains a new real CODE generation without relabeling A or B", async () => {
  await owner()(); const first = await preview(); const original = await preparationRef().get();
  clock = Math.max(clock, (await db.doc(aggregates.CURRENT_PATH).get()).data()!.acceptedAt) + 1;
  await db.doc("system/publicDeployment").update({ activeGeneration: 2, updatedAt: Timestamp.fromMillis(clock) });
  await db.doc("system/publicDeployment/externalRefresh/current").set({ schemaVersion: 1, runtime,
    status: "verified", nextAttemptAt: clock + 3_600_000 });
  publication = { ...publication, generation: 2, artifactReceiptDigest: "a".repeat(64) };
  const health = () => readPublicationHealth({ runtime, now: clock, read: async name => (await db.doc(name).get()).data() ?? null });
  expect(await health()).toEqual({ healthy: true, reasons: [], oldestDueAt: clock });
  await owner()(); const next = await preview();
  expect((await health()).healthy).toBe(true);
  expect(next.status).toBe("verified"); expect(next.publicationGeneration).toBe(2); expect(next.manifestId).not.toBe(first.manifestId);
  const manifest = (await db.collection(EDITORIAL_CONTEXTS_COLLECTION).doc(next.manifestId).get()).data()!;
  expect(manifest.selection.checkpointIdentity.operationId).toBe(A); expect(manifest.selection.operationId).toBe(B);
  expect(manifest.contextReceipt.buildBatchId).toBe(bundle.receipt.buildBatchId);
  expect(manifest.selection.publication.buildBatchId).toBe(publication.buildBatchId);
  const after = await preparationRef().get(); expect(after.data()).toEqual(original.data()); expect(after.updateTime).toEqual(original.updateTime);
});

it.each(["failed", "cancelled"])("does not add preview exhaustion to a %s public aggregate queue", async status => {
  await queueRef().update({ status, previewContext: { status: "failed", attempts: 4, nextAttemptAt: null, startedAt: clock - OVERDUE_MS } });
  const health = await readPublicationHealth({ runtime, now: clock,
    read: async name => (await db.doc(name).get()).data() ?? null, listOwners: async () => [] });
  expect(health.reasons).not.toContain("preview_context_exhausted");
});

it("propagates the caller abort into an active prepared checkpoint read", async () => {
  const controller = new AbortController();
  background.onRead(async () => { controller.abort(new Error("Fixture interruption")); });
  const stored = (await preparationRef().get()).data()!;
  const cloud = createNoBuildPreparationStorage("editorial-background-fixture", app,
    { operationId: A, contextDigest: digest, commitSha: release, owner: "cloudflare", cutoffMillis: clock, admissionRevision: null },
    { signal: controller.signal });
  await expect(cloud.restore("prepared", path.join(directory, "aborted"), stored.preparedDigest)).rejects.toThrow(/interruption/i);
});

it("constructs the factory without I/O and refuses omitted local boundaries on attempt", async () => {
  const reads = background.reads.length;
  const run = cloudEditorialPreviewRetention({ firestore: db, firebaseApp: app, runtime, serializerId: "cloudflare-publisher",
    backgroundBucket: "editorial-background-fixture", stateDirectory: directory,
    previewStorageCredential: { accessKeyId: "unused-fixture", secretAccessKey: "unused-fixture" } });
  expect(receiptReads).toBe(0); expect(puts).toBe(0); expect(background.reads.length).toBe(reads);
  await expect(run()).rejects.toThrow("Demo preview retention requires local");
  expect(receiptReads).toBe(0); expect(puts).toBe(0); expect(background.reads.length).toBe(reads);
});

it.each([undefined, "bad"])("refuses missing or malformed full claim %s before CODE or checkpoint I/O without resetting attempts", async claim => {
  const marker = { status: "building", contextDigest: digest, publicationGeneration: 1,
    manifestId: "b".repeat(64), publicationArtifactReceiptDigest: "c".repeat(64),
    attempts: 2, startedAt: clock - 1000, nextAttemptAt: clock, ...(claim === undefined ? {} : { claim }) };
  await queueRef().update({ previewContext: marker });
  const reads = background.reads.length;
  await expect(owner()()).rejects.toThrow("Invalid preview retention retry state");
  expect(await preview()).toEqual(marker); expect(receiptReads).toBe(0); expect(puts).toBe(0);
  expect(background.reads.length).toBe(reads);
});

it.each(["pending", "failed"])("retains the verified original preparation when generated outputs leave both queues %s", async status => {
  for (const id of [A, B]) await db.doc(`cmsPublishQueue/${id}`).update({ status, aggregateReceipt: null });
  await db.doc("cmsBackgroundOutputs/search").update({ status: "failed", receipt: null });
  const before = await preparationRef().get();
  const due = await work.readNoBuildCloudWork({ runtime, now: clock,
    read: async name => (await db.doc(name).get()).data() ?? null, listOwners: async () => [] });
  expect(due.previewContext).toBe(true);
  expect(await owner()()).toBe(true);
  const marker = await preview();
  expect(marker.status).toBe("verified");
  expect(puts).toBe(1);
  const manifest = (await db.collection(EDITORIAL_CONTEXTS_COLLECTION).doc(marker.manifestId).get()).data()!;
  expect(manifest.selection.checkpointIdentity.operationId).toBe(A);
  for (const id of [A, B]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data()).toMatchObject({ status, aggregateReceipt: null });
  const after = await preparationRef().get();
  expect(after.data()).toEqual(before.data());
  expect(after.updateTime).toEqual(before.updateTime);
});


const readSavedContext = () => createCmsPreviewCloudStorage({ client, contextMode: "editorial" }).readPublicContext(db,
  () => requestPublicPublicationReceipt(endpoint + "/receipt?cms-context=code"));

async function frozenProjectionInput(withImage = false) {
  const input = path.join(directory, "frozen-projection");
  await rm(input, { recursive: true, force: true });
  await mkdir(input, { recursive: true, mode: 0o700 });
  const values: Record<string, unknown> = {
    "input.json": bundle, "routes.json": [], "schedule.json": {},
    "launch-media-manager.json": { source: "media-manager", checkedAt: new Date(clock).toISOString(),
      cards: [{ title: "Frozen program", description: "Frozen description", href: "https://watch.njpbs.org/frozen/" }] },
    "spotlight-news.json": { checkedAt: new Date(clock).toISOString(), cards: [] },
    "remote-images.json": { schemaVersion: 1, buildBatchId: bundle.receipt.buildBatchId, commitSha: release, images: [] },
  };
  if (withImage) {
    const image = Buffer.from("frozen-required-image");
    const imageDigest = createHash("sha256").update(image).digest("hex");
    const imageFile = `images/${imageDigest}`;
    const blocks = [{ id: "required-image", type: "image", visible: true, data: { assetId: "image" } }];
    const original = (await preparationRef().get()).data()!;
    const receipt = createPublicArtifactInventoryReceipt({ reservation: original.reservation,
      pages: [{ documentId: "about", sourceVersion: 1, publishedSnapshot: { blocks, metadata: { title: "About" }, sourceVersion: 1 } }],
      posts: [], programs: [], authors: [], settings: [] });
    const url = "https://media.njpbs.org/cms-media/fixture/required.webp";
    values["input.json"] = { ...bundle, receipt, pages: [{ pageId: "about", path: "/about/", sourceVersion: 1, blocks,
      assets: { image: { url, mimeType: "image/webp", width: 640, height: 360 } } }] };
    values["remote-images.json"] = { schemaVersion: 1, buildBatchId: receipt.buildBatchId, commitSha: release,
      images: [{ url, file: imageFile, digest: imageDigest, size: image.length, contentType: "image/webp" }] };
    await mkdir(path.join(input, "images"), { mode: 0o700 });
    await writeFile(path.join(input, imageFile), image, { mode: 0o600 });
  }
  for (const [file, value] of Object.entries(values)) await writeFile(path.join(input, file), JSON.stringify(value), { mode: 0o600 });
  return { input, request: { buildBatchId: bundle.receipt.buildBatchId, commitSha: release,
    retainedInputDirectory: input, artifactReceiptPath: path.join(input, "artifact-inventory.json") } };
}

it.each([false, true])("isolates real search compilation and preview projection (projection refusal: %s)", async projectionRefuses => {
  const { input } = await frozenProjectionInput();
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ changedAt: Timestamp.fromMillis(clock) });
  const original = (await preparationRef().get()).data()!;
  const cloud = createNoBuildPreparationStorage("editorial-background-fixture", app, {
    operationId: A, contextDigest: digest, commitSha: release, owner: "cloudflare", cutoffMillis: clock, admissionRevision: null });
  background.objects.clear();
  const inputDigest = await cloud.checkpoint("input", input, [...backgroundInputFiles, "remote-images.json"]);
  const { preparedDigest: _oldPreparedDigest, ...reserved } = original;
  await preparationRef().set({ ...reserved, status: "failed", inputDigest, attempts: 3, nextAttemptAt: 0 });
  await db.doc(aggregates.CURRENT_PATH).update({ operationId: A, preparationOperationId: A, namespaceOperationId: A, operationIds: [A] });
  for (const output of aggregates.OUTPUTS) await db.doc(`cmsBackgroundOutputs/${output}`).update({ taskPath: `cmsPublishQueue/${A}/backgroundOutputs/${output}` });
  await db.doc("cmsBackgroundOutputs/search").update({ status: "pending", receipt: null });
  await db.doc(`cmsPublishQueue/${A}/backgroundOutputs/search`).update({ status: "pending", attempts: 0, nextAttemptAt: 0 });
  await db.doc(`cmsPublishQueue/${A}`).update({ status: "pending", aggregateReceipt: null });
  const search = path.join(directory, "search-failure");
  await mkdir(search, { recursive: true, mode: 0o700 });
  await writeFile(path.join(search, "index.html"), '<html lang="en"><body data-pagefind-body>Frozen search fixture</body></html>');
  await writeFile(path.join(search, "pagefind"), "output path occupied");
  let retention: Promise<unknown> | undefined;
  let searchFailed = false;
  let searchDiagnostic = "";
  const maintain = noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: release, runtime,
    stateDirectory: directory, distDirectory: path.join(directory, "dist"), buildEnvironment: {},
    backgroundBucket: "editorial-background-fixture", serializerId: "cloudflare-publisher",
    buildPreviewProjection: projectionRefuses ? async () => { throw new Error("Fixture independent projection refusal"); } : buildNoBuildCloudPreviewProjection,
    onPreviewProjection: () => { retention = owner()(); },
    buildPublication: async () => {
      await retention;
      expect((await preparationRef().get()).data()?.status).toBe("building");
      if (!projectionRefuses) expect((await db.doc(`cmsPublishQueue/${A}`).get()).data()?.previewContext?.status).toBe("verified");
      await new Promise<void>((resolve, reject) => execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        'import {buildSearchIndex} from "./scripts/build-with-production-sync.mjs"; try { await buildSearchIndex(process.argv[1]); process.exit(0); } catch(e) { console.error(e.message); process.exit(1); }', search],
      { cwd: path.resolve("site"), timeout: 10_000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
        searchDiagnostic = JSON.stringify({ code: error?.code, signal: error?.signal, stderr });
        searchFailed = Boolean(error && (stderr.includes("pagefind: could not write the index") ||
          stderr.includes("pagefind/src/output") && /kind: (?:AlreadyExists|NotADirectory),/.test(stderr)));
        error ? reject(new Error("Search compilation failed")) : resolve();
      }));
      throw new Error("The search child must refuse the occupied output path");
    } });
  await maintain();
  expect(searchFailed, searchDiagnostic).toBe(true);
  expect(await readFile(path.join(search, "pagefind"), "utf8")).toBe("output path occupied");
  expect((await preparationRef().get()).data()).toMatchObject({ status: "failed", attempts: 4 });
  if (projectionRefuses) {
    expect((await preparationRef().get()).data()?.previewProjection).toBeUndefined();
    return;
  }
  expect((await preparationRef().get()).data()?.previewProjection).toMatchObject({ status: "verified", inputDigest });
  expect((await db.doc(`cmsPublishQueue/${A}`).get()).data()).toMatchObject({ status: "failed", aggregateReceipt: null });
  expect([...background.objects.keys()].some(key => key.endsWith("/prepared.json"))).toBe(false);
  const opened = await readSavedContext();
  const projection = opened.publicContext;
  expect(projection.homeSources?.editorial).toBeDefined();
  expect(assertHomeSourcePublication(projection.homeSources!, bundle.receipt)).toEqual(projection.homeSources);
  const marker = (await db.doc(`cmsPublishQueue/${A}`).get()).data()!.previewContext;
  const seal = (await db.collection(EDITORIAL_SEALS_COLLECTION).doc(marker.manifestId).get()).data()!;
  expect(seal.selection).toMatchObject({ checkpointStage: "preview", checkpointIdentity: { inputDigest } });
  // New source/withdrawal and byte fences still apply to this independent lane.
  await preparationRef().update({ inputDigest: "0".repeat(64) });
  await expect(readSavedContext()).rejects.toThrow();
  await preparationRef().update({ inputDigest });
  objects.set(seal.key, Buffer.from("corrupt required Home catalog"));
  await expect(readSavedContext()).rejects.toThrow();
});

it.each(["missing-home", "corrupt-home", "missing-media", "corrupt-media", "missing-image", "corrupt-image", "incomplete-media-roster"])(
  "refuses %s at the real offline projection boundary", async failure => {
    const { input, request } = await frozenProjectionInput(["missing-image", "corrupt-image", "incomplete-media-roster"].includes(failure));
    await buildNoBuildCloudPreviewProjection(request, path.join(input, "good", "dist"));
    if (failure === "missing-home") await rm(path.join(input, "launch-media-manager.json"));
    if (failure === "corrupt-home") await writeFile(path.join(input, "spotlight-news.json"), "invalid JSON");
    if (failure === "missing-media") await rm(path.join(input, "remote-images.json"));
    if (failure === "corrupt-media") await writeFile(path.join(input, "remote-images.json"), "invalid JSON");
    if (["missing-image", "corrupt-image", "incomplete-media-roster"].includes(failure)) {
      const manifest = JSON.parse(await readFile(path.join(input, "remote-images.json"), "utf8"));
      if (failure === "missing-image") await rm(path.join(input, manifest.images[0].file));
      if (failure === "corrupt-image") await writeFile(path.join(input, manifest.images[0].file), "corrupt");
      if (failure === "incomplete-media-roster") await writeFile(path.join(input, "remote-images.json"), JSON.stringify({ ...manifest, images: [] }));
    }
    const output = path.join(input, "result", "dist");
    await expect(buildNoBuildCloudPreviewProjection(request, output)).rejects.toThrow();
    await expect(readFile(path.join(output, "public-context.json"))).rejects.toThrow();
  });

it("opens the last immutable sealed context during a publish burst with real Firestore and private bytes", async () => {
  await owner()();
  const marker = await preview();
  expect((await db.doc(LAST_SEALED_EDITORIAL_CONTEXT).get()).data()).toMatchObject({ schemaVersion: 1,
    manifestId: marker.manifestId, publication, contextRevision: 1 });
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  const start = performance.now();
  expect(await readSavedContext()).toMatchObject({ publicContext: bundle, publication });
  console.info(JSON.stringify({ measurement: "sealed-preview-local-read", durationMs: performance.now() - start,
    readinessIntervals: 0, production: false }));
});

it.each(["pending", "failed"])("uses a newly sealed %s aggregate through real admission and repeated context churn", async status => {
  for (const id of [A, B]) await db.doc(`cmsPublishQueue/${id}`).update({ status, aggregateReceipt: null });
  await db.doc("cmsBackgroundOutputs/search").update({ status, receipt: null });
  expect(await owner()()).toBe(true);
  const manifestRef = db.collection(EDITORIAL_SEALS_COLLECTION).doc((await preview()).manifestId);
  const manifest = (await manifestRef.get()).data()!;
  expect(manifest).toMatchObject({ schemaVersion: 2, withdrawalRevision: 0 });
  const original = await preparationRef().get();
  for (const revision of [2, 3]) {
    const operationId = (revision === 2 ? "C" : "D").repeat(20);
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision });
    await db.runTransaction(async transaction => {
      const accepted = await aggregates.enqueuePublicContextInTransaction({ transaction, firestore: db,
        operationId, runtime, reason: "context", contextRevision: revision });
      accepted.write();
    });
    await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${context.publicContextDigest(revision)}`).set({
      status: revision === 2 ? "pending" : "failed", attempts: 1, nextAttemptAt: clock + 60_000,
      runtime, contextDigest: context.publicContextDigest(revision) });
    expect((await queueRef().get()).data()).toMatchObject({ status: "cancelled", error: "public_context_superseded" });
    const result = await readSavedContext();
    expect(result).toMatchObject({ publicContext: bundle, publication });
    if (!("verifyBeforeFreeze" in result) || typeof result.verifyBeforeFreeze !== "function") {
      throw new Error("Fallback omitted its freeze fence");
    }
    await expect(result.verifyBeforeFreeze()).resolves.toBeUndefined();
  }
  expect((await preparationRef().get()).updateTime).toEqual(original.updateTime);
  expect((await manifestRef.get()).data()).toEqual(manifest);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ withdrawalRevision: 1 });
  await expect(readSavedContext()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});

it.each(["withdrawal", "code"])("refuses a %s race after the real fallback object read", async race => {
  await owner()();
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  afterGet = async () => {
    if (race === "withdrawal") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 3, withdrawalRevision: 1 });
    else publication = { ...publication, artifactReceiptDigest: "f".repeat(64) };
  };
  await expect(readSavedContext()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});

it("keeps schema-one manifests readable only at the exact current context", async () => {
  await owner()();
  const ref = db.collection(EDITORIAL_CONTEXTS_COLLECTION).doc((await preview()).manifestId);
  const manifest = (await ref.get()).data()!;
  expect(manifest.schemaVersion).toBe(1);
  await db.collection(EDITORIAL_SEALS_COLLECTION).doc((await preview()).manifestId).delete();
  await db.doc(LAST_SEALED_EDITORIAL_CONTEXT).delete();
  expect(await readSavedContext()).toEqual({ publicContext: bundle, publication });
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  await expect(readSavedContext()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});

it("does not add withdrawal authority to a historical legacy-only manifest on real retention retry", async () => {
  await owner()();
  const marker = await preview();
  const legacyRef = db.collection(EDITORIAL_CONTEXTS_COLLECTION).doc(marker.manifestId);
  const legacy = await legacyRef.get();
  await db.collection(EDITORIAL_SEALS_COLLECTION).doc(marker.manifestId).delete();
  await db.doc(LAST_SEALED_EDITORIAL_CONTEXT).delete();
  await queueRef().update({ previewContext: { ...marker, status: "failed", attempts: 1,
    startedAt: clock, nextAttemptAt: clock, claim: null } });
  expect(await owner()()).toBe(true);
  expect((await preview()).status).toBe("verified");
  expect((await legacyRef.get()).updateTime).toEqual(legacy.updateTime);
  expect((await db.collection(EDITORIAL_SEALS_COLLECTION).doc(marker.manifestId).get()).exists).toBe(false);
  expect((await db.doc(LAST_SEALED_EDITORIAL_CONTEXT).get()).exists).toBe(false);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  await expect(readSavedContext()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});
