import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { openCmsPublicationCloudTokenJournal } from "../../site/scripts/cms-publication-cloud-token-journal";
import { documents, operation, preparationPath, release, runtime, taskPath } from "../no-build-cloud-contract";
import cloudWork from "../../functions/lib/no-build-cloud-work.js";
const require = createRequire(import.meta.url);
const { wakeNoBuildCloud } = require("../../functions/no-build-cloud-wake.js");
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let firestore: ReturnType<typeof firebaseAdminRuntime.getFirestore>;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !["demo-njpbs", "demo-cloud3057-pr3"].includes(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Dedicated demo emulator required");
  app = firebaseAdminRuntime.initializeApp({ projectId: "demo-cloud3057-pr3" }, "cloud-execution-test");
  firestore = firebaseAdminRuntime.getFirestore(app);
});
afterAll(async () => { if (app) await firebaseAdminRuntime.deleteApp(app); });
beforeEach(async () => {
  for (const name of ["system", "cmsPublishQueue", "cmsBackgroundOutputs", "cmsPublicationSerializerJournals"]) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
  const batch = firestore.batch();
  for (const [path, data] of Object.entries(documents())) batch.set(firestore.doc(path), data);
  await batch.commit();
});
const work = () => cloudWork.readNoBuildCloudWork({ runtime, now: 1000, read: async path => (await firestore.doc(path).get()).data() ?? null });
it("reads durable due work and sleeps through bounded retry backoff and exhaustion", async () => {
  expect((await work()).maintenance).toBe(true);
  await firestore.doc(preparationPath).set({ runtime, status: "building", attempts: 1, nextAttemptAt: 1001 });
  expect((await work()).maintenance).toBe(false);
  await firestore.doc(preparationPath).update({ status: "verified" });
  expect((await work()).maintenance).toBe(true);
  await firestore.doc(taskPath).update({ status: "failed", attempts: 4, nextAttemptAt: null });
  expect((await work()).maintenance).toBe(false);
});
it.each(["missing", "invalid", "different-post"])("wakes an owned reserved Home removal after %s admission", async change => {
  // Isolate the Home reservation from unrelated accepted family work, which
  // now also drains after admission changes.
  await firestore.doc("cmsBackgroundOutputs/listings").delete();
  await firestore.doc("system/publicDeployment/noBuildPosts/current").update({ visible: false });
  await firestore.doc(`cmsPublishQueue/${operation}`).update({ homeFullBuild: { status: "reserved" } });
  const admission = firestore.doc("system/noBuildPostAdmission");
  if (change === "missing") await admission.delete();
  else await admission.update(change === "invalid" ? { schemaVersion: 99 } : { postId: "another-post" });
  expect(await work()).toEqual({ maintenance: true, reconcile: false });
  await firestore.doc(`cmsPublishQueue/${operation}`).update({ homeFullBuild: { status: "queued" } });
  expect(await work()).toEqual({ maintenance: false, reconcile: false });
});
it("retains one cloud release journal reservation across restart and refuses legacy/source crossover", async () => {
  const input = { firestore, serializerId: "cloud-contract", runtime };
  const journal = await openCmsPublicationCloudTokenJournal(input);
  const reserved = await journal.reserve({ queueId: operation, buildBatchId: `cms-${operation}`, commitSha: release });
  const restarted = await openCmsPublicationCloudTokenJournal(input);
  expect(await restarted.read()).toEqual(reserved.job);
  expect((await restarted.reserve({ queueId: operation, buildBatchId: `cms-${operation}`, commitSha: release })).idempotent).toBe(true);
  await expect(openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloud-contract" }).then(value => value.read())).rejects.toThrow();
  await expect(journal.reserve({ queueId: operation, buildBatchId: `cms-${operation}`, commitSha: "b".repeat(40) })).rejects.toThrow();
  await journal.clear({ queueId: operation, claimToken: reserved.job.claimToken });
  expect(await restarted.read()).toBeNull();
});
it("delivers an authenticated hint from current durable control without changing accepted work", async () => {
  await firestore.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" });
  const wakeDatabase = { projectId: "njpbs-site", doc: firestore.doc.bind(firestore) }; // Still routed only to the dedicated emulator above.
  let attempts = 0;
  const before = (await firestore.doc(taskPath).get()).data();
  const fetchImpl = async (url: string, init: RequestInit) => {
    attempts++;
    expect(url).toBe("https://publisher-health.njpbs.org/wake");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-publication-release")).toBe(release);
    expect(new Headers(init.headers).get("x-publication-target")).toBe("production");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${"x".repeat(32)}`);
    return new Response(null, { status: 204 });
  };
  // The demo project cannot enable a production-bound packaged decision.
  // Inject only that public decision; durable control and emulator writes stay real.
  const getDeployment = () => ({ enabled: true, environment: "production" });
  await wakeNoBuildCloud({ firestore: wakeDatabase, environment: "production", getDeployment, fetchImpl, getToken: () => "x".repeat(32) });
  await wakeNoBuildCloud({ firestore: wakeDatabase, environment: "production", getDeployment, fetchImpl, getToken: () => "x".repeat(32) });
  expect(attempts).toBe(2);
  expect((await firestore.doc(taskPath).get()).data()).toEqual(before);
});

it("refuses source-mismatched release work before storage or activation and retains bounded retries", async () => {
  const { runNoBuildCloudRelease } = await import("../../site/scripts/no-build-cloud-release");
  const ref = firestore.doc(`cmsPublicationSerializerJournals/cloud-contract/releases/${operation}`);
  await ref.set({ schemaVersion: 1, runtime, queueId: operation, buildBatchId: `cms-${operation}`,
    commitSha: release, inputSha256: "b".repeat(64), artifactCheckpointDigest: "c".repeat(64),
    status: "pending", attempts: 0, nextAttemptAt: 0 });
  await firestore.doc(`system/publicDeployment/buildBatches/cms-${operation}`).set({ runtime, status: "reserved" });
  // Real source guard rejects this fixture SHA before any external operation.
  await runNoBuildCloudRelease({ firestore, serializerId: "cloud-contract", commitSha: release,
    stateDirectory: "/tmp/cloud3057-pr3-release-unused", storage: undefined as never,
    cloudflareApiToken: "x".repeat(32), previewStorageCredential: { accessKeyId: "fixture", secretAccessKey: "fixture" } });
  expect((await ref.get()).data()).toMatchObject({ status: "failed", attempts: 1 });
  expect((await ref.get()).data()!.nextAttemptAt).toBeGreaterThan(Date.now());
  const journal = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloud-contract", runtime });
  expect((await journal.read())?.queueId).toBe(operation);
  const snapshot = (await ref.get()).data();
  await runNoBuildCloudRelease({ firestore, serializerId: "cloud-contract", commitSha: release,
    stateDirectory: "/tmp/cloud3057-pr3-release-unused", storage: undefined as never,
    cloudflareApiToken: "x".repeat(32), previewStorageCredential: { accessKeyId: "fixture", secretAccessKey: "fixture" } });
  expect((await ref.get()).data()).toEqual(snapshot);
});

it("allows an empty cloud journal to admit its next reviewed source without rebinding a retained job", async () => {
  const first = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloud-rollover", runtime });
  const reserved = await first.reserve({ queueId: operation, buildBatchId: `cms-${operation}`, commitSha: release });
  const nextRelease = "b".repeat(40);
  const next = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloud-rollover", runtime: { ...runtime, release: nextRelease } });
  await expect(next.read()).rejects.toThrow("another runtime");
  await first.clear({ queueId: operation, claimToken: reserved.job.claimToken });
  expect(await next.read()).toBeNull();
  expect((await next.reserve({ queueId: operation, buildBatchId: `cms-${operation}`, commitSha: nextRelease })).job.commitSha).toBe(nextRelease);
});

it("stages only complete digest-checked approved release artifacts and restores them on empty disk", async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { Readable } = await import("node:stream");
  const { createHash } = await import("node:crypto");
  const { createCmsPublicationCloudStorage } = await import("../../site/scripts/cms-publication-cloud-storage");
  const { checkpointNoBuildCloudRelease, stageNoBuildCloudRelease } = await import("../../site/scripts/no-build-cloud-release");
  const { createPublicArtifactInventoryReceipt } = await import("../../site/src/lib/public-artifact-inventory");
  const { preparePublicWorkerArtifact } = await import("../../site/src/lib/public-worker-artifact");
  const { reservePublicBuildBatch } = require("../../functions/lib/public-deployment-coordinator");
  const objects = new Map<string, any>();
  // S3's conditional-write/stream boundary; all checkpoint and Firestore code is real.
  const storage = createCmsPublicationCloudStorage({ includeRenderer: true, client: { async send(command: any) {
    const input = command.input;
    if (command.constructor.name === "PutObjectCommand") {
      expect(input.IfNoneMatch).toBe("*");
      if (objects.has(input.Key)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(input.Key, { ...input, Body: Buffer.from(input.Body) });
      return {};
    }
    const stored = objects.get(input.Key);
    if (!stored) throw { $metadata: { httpStatusCode: 404 } };
    return { ...stored, Body: { transformToWebStream: () => Readable.toWeb(Readable.from([stored.Body])) } };
  } } as never });
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-release-staging-"));
  const restored = await mkdtemp(path.join(tmpdir(), "cloud-release-empty-"));
  try {
    await firestore.recursiveDelete(firestore.doc("system/publicDeployment"));
    const buildBatchId = `cms-${operation}`;
    const { batch } = await reservePublicBuildBatch({ firestore, buildBatchId, commitSha: release, runtime });
    const artifact = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], posts: [], programs: [], authors: [], settings: [] });
    await mkdir(path.join(directory, "dist/posts/_no-build-assets"), { recursive: true });
    await mkdir(path.join(directory, "renderer/server"), { recursive: true });
    const seal = JSON.stringify({ schemaVersion: 1, rendererSha: release });
    await writeFile(path.join(directory, "renderer/renderer-release.json"), seal);
    await writeFile(path.join(directory, "renderer/server/entry.mjs"), `export const rendererSha = "${release}";`);
    await writeFile(path.join(directory, "dist/posts/_no-build-assets/renderer-release.json"), seal);
    await writeFile(path.join(directory, "dist/index.html"), "<!doctype html><title>Fixture</title>");
    await writeFile(path.join(directory, "artifact-inventory.json"), JSON.stringify(artifact));
    await writeFile(path.join(directory, "public-context.json"), "{}");
    await preparePublicWorkerArtifact({ artifactReceipt: artifact, distDirectory: path.join(directory, "dist"), outputPath: path.join(directory, "prepared-worker.json") });
    const bytes = await storage.freezeInput(operation, Buffer.from("approved release fixture"));
    const identity = { queueId: operation, buildBatchId, commitSha: release, inputSha256: createHash("sha256").update(bytes).digest("hex") };
    const options = { firestore, storage, serializerId: "cloud-stage", identity, directory };
    const ref = firestore.doc(`cmsPublicationSerializerJournals/cloud-stage/releases/${operation}`);
    await writeFile(path.join(directory, "renderer/renderer-release.json"), JSON.stringify({ schemaVersion: 1, rendererSha: "b".repeat(40) }));
    await expect(stageNoBuildCloudRelease(options)).rejects.toThrow("renderer differs");
    expect((await ref.get()).exists).toBe(false);
    await writeFile(path.join(directory, "renderer/renderer-release.json"), seal);
    const pointerBefore = (await firestore.doc("system/publicDeployment").get()).data();
    const checkpoint = await checkpointNoBuildCloudRelease({ storage, identity, directory });
    expect(checkpoint.prepared).toMatchObject({ buildBatchId, commitSha: release, generation: batch.generation });
    expect(checkpoint.artifactCheckpointDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await ref.get()).exists).toBe(false);
    expect((await firestore.doc("system/publicDeployment").get()).data()).toEqual(pointerBefore);
    await stageNoBuildCloudRelease(options);
    const request = (await ref.get()).data()!;
    expect(request).toMatchObject({ runtime, status: "pending", attempts: 0 });
    await stageNoBuildCloudRelease(options);
    expect((await ref.get()).data()).toEqual(request);
    await rm(directory, { recursive: true, force: true });
    expect(await storage.restoreArtifact(identity, restored, request.artifactCheckpointDigest)).toBe(true);
    expect(await readFile(path.join(restored, "renderer/renderer-release.json"), "utf8")).toBe(seal);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});
