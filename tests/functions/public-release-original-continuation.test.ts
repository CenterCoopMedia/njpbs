import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { privatePairReader } from "../../publisher/pair-work-reader";
import { wakePublicReleasePair } from "../../publisher/release-pair-wake";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { createOriginalPublicReleaseContinuation, bindOriginalPublicReleaseContinuation } from "../../site/scripts/public-release-original-continuation";
import { handoffPublicReleasePairActivation, activationOutboxPath } from "../../site/scripts/public-release-pair-activation-outbox";
import activation from "../../functions/lib/public-release-content-activation.js";
import { startPublicReleasePairServer } from "../../site/scripts/public-release-pair-server";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { pairOwnerWriteRpc } from "../../publisher/pair-owner-write-rpc";
import { pairOwnerEvidenceClient } from "../../publisher/pair-owner-evidence-client";
import { decodePairEvidenceFields } from "../../publisher/pair-work-reader";
import { pairTerminalRpc } from "../../publisher/pair-terminal-rpc";
import { publicReleaseTerminalTransport } from "../../site/scripts/public-release-terminal-transport";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import work from "../../functions/lib/public-release-pair-work.js";
import admission from "../../functions/lib/public-release-admission.js";
import serving from "../../functions/lib/public-release-serving.js";
import protocol from "../../functions/lib/public-release-pair.js";

const require = createRequire(import.meta.url), family = require("../../functions/lib/public-release-family-admission.js");
const networkFetch = globalThis.fetch, operationId = "R".repeat(20);
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
let now: number, continuation: ReturnType<typeof createOriginalPublicReleaseContinuation>;
beforeAll(async () => {
  ({ runtime, store } = await publicReleaseR2Fixture("original-continuation"));
}, 120_000);
afterAll(async () => { vi.unstubAllGlobals(); await fixture?.close(); await runtime?.dispose(); });
afterEach(() => vi.restoreAllMocks());

it("rediscovers a missed original wake and retries real canonical settlement without a second claim", async () => {
  const database = isolatedFirestore("original-publication-continuation");
  fixture = await switchedPairFixture(database, store);
  const { firestore, pair, sourcePair } = fixture;
  const code = await fixture.captureCode();
  const codeTask = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
    input: { ...code.root.scope, inputManifestDigest: code.receipt.inputManifestDigest } }));
  await stagedPublicReleasePairCompositeFixture({ ...fixture, content: code, taskId: codeTask.taskId }, store);
  // The actual G recovery owner revalidates and acknowledges the CODE staging
  // debt. No unrelated pending task may conceal the missing original wake.
  await createPublicReleasePairExecutor({ firestore, pair, store }).recover();
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
    slots: [pair, sourcePair].map(side => createPublicReleaseSlot({ pair: side, workerVersionId: side.publicWorker.versionId, store,
      getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair: side,
        selection, path, composedReadersEnabled: true }) })) });
  const evidence = pairOwnerEvidenceClient({ pair, projectId: database.projectId, token: "owner", decode: decodePairEvidenceFields,
    request: (input, init) => networkFetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}${new URL(String(input)).pathname}`, init) });
  const authority = { pair, read: async (path: string) => (await firestore.doc(path).get()).data() ?? null, ...evidence };
  let canonicalAvailable = false;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init), host = new URL(request.url).hostname;
    if (host === "pair-owner-write.internal") return pairOwnerWriteRpc(request, store as any, authority);
    if (host === "pair-terminal.internal") return pairTerminalRpc(request, store as any, authority, {
      prove: (request, digest, expected) => canonicalAvailable ? router.prove(request, digest, expected) : Promise.resolve(new Response(null, { status: 503 })),
    });
    if (host === "oauth2.googleapis.com") return Promise.resolve(Response.json({ access_token: "owner", token_type: "Bearer", expires_in: 300 }));
    if (host === "firestore.googleapis.com") {
      const url = new URL(request.url);
      const target = "projects/njpbs-site-dev/databases/(default)", local = `projects/${database.projectId}/databases/(default)`;
      if (!url.pathname.startsWith(`/v1/${target}/`)) throw new Error("Unexpected wake project");
      return networkFetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}${url.pathname.replace(target, local)}${url.search}`,
        { method: request.method, headers: request.headers, body: request.method === "POST" ? request.body : undefined, duplex: "half" } as RequestInit)
        .then(async response => new Response((await response.text()).replaceAll(local, target), { status: response.status, headers: response.headers }));
    }
    return networkFetch(input, init);
  });
  const story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextDocument = { ...story, version: 10, publishBuildPending: true, publishBuildQueueId: operationId,
    published: { ...story.published, sourceVersion: 10, metadata: { ...story.published.metadata, title: "Runtime original continuation" } } };
  await firestore.runTransaction(async transaction => {
    const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    prepared.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
  });
  now = Date.now();
  const transport = publicReleaseTerminalTransport(pair.environment);
  continuation = createOriginalPublicReleaseContinuation({
    enabled: true, firestore, pair, ...transport, fieldValues: FieldValue, clock: () => now,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resource fallback"); } },
  });
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encoded = Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64");
  const account = JSON.stringify({ type: "service_account", project_id: "njpbs-site-dev",
      client_email: "fixture-wake@njpbs-site-dev.iam.gserviceaccount.com",
      private_key: `-----BEGIN PRIVATE KEY-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n` });
  const wakeIdentity = { pairId: pair.pairId, commitSha: pair.commitSha, environment: pair.environment,
    journalNamespace: pair.publisher.journalNamespace };
  let origin = "";
  const checkWorkerWake = async (enabled = true) => {
    const reader = await privatePairReader({ account, identity: wakeIdentity,
      workerVersionId: pair.publisher.workerVersionId, originalRecoveryEnabled: enabled });
    return wakePublicReleasePair({ pair: reader.pair, identity: wakeIdentity, readWork: () => reader.due(),
      start: async () => { const response = await networkFetch(`${origin}/wake`, { method: "POST" });
        expect(response.ok).toBe(true); await response.body?.cancel(); } });
  };
  const workerClock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const bound = bindOriginalPublicReleaseContinuation({ firestore, pair, continuation,
    executor: createPublicReleasePairExecutor({ firestore, pair, store, clock: () => now, publication: continuation.publication }) });
  const explicitRepair = async () => {
    const repairServer = await startPublicReleasePairServer({ firestore, pair, ...bound, host: "127.0.0.1", port: 0 });
    try {
      if (!repairServer.address || typeof repairServer.address === "string") throw new Error("No repair server");
      const response = await networkFetch(`http://127.0.0.1:${repairServer.address.port}/retry-staging`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: protocol.publicReleaseDigest(completed.identity) }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "staged", taskId: protocol.publicReleaseDigest(completed.identity) });
    } finally { await repairServer.close(); }
  };
  // No task or direct wake exists. The actual server must preserve beforePoll
  // and discover H/enqueue before considering any ordinary pair claim.
  const server = await startPublicReleasePairServer({ firestore, pair, host: "127.0.0.1", port: 0,
    execute: async () => { throw new Error("This probe must stop before rendering"); },
    beforePoll: async input => { await continuation.beforePoll!(input); throw new Error("Injected exit after original discovery"); } });
  try {
    if (!server.address || typeof server.address === "string") throw new Error("No private server address");
    origin = `http://127.0.0.1:${server.address.port}`;
    const ownBase = work.publicReleasePairPath(pair.pairId);
    expect((await firestore.collection(`${ownBase}/staging`).get()).empty).toBe(true);
    expect((await firestore.collection(`${ownBase}/activationPending`).get()).empty).toBe(true);
    expect((await firestore.collection(`${ownBase}/work`).get()).docs.every(row => row.data().status === "complete")).toBe(true);
    expect(await checkWorkerWake(false)).toBe(false);
    expect(await checkWorkerWake()).toBe(true);
    await server.waitForCurrentWork();
  } finally { await server.close(); }
  const base = work.publicReleasePairPath(pair.pairId), tasks = await firestore.collection(`${base}/work`)
    .where("identity.sourceOperationId", "==", operationId).get();
  expect(tasks.size).toBe(1); expect(tasks.docs[0].data()).toMatchObject({ status: "pending", attempts: 0 });
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: tasks.docs[0].id }, store);
  const original = (await tasks.docs[0].ref.get()).data()!;
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.execution).toBe(null);
  const completed = { identity: staged.claim.identity, claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest };
  await handoffPublicReleasePairActivation({ firestore, store, pair, ...completed });
  const activationHint = firestore.doc(activationOutboxPath(pair, tasks.docs[0].id));
  const activationReceipt = firestore.doc(activation.activationPath(pair, operationId));
  const writerFence = firestore.doc("system/publicDeployment/releaseWriter/fence");
  await writerFence.set({ schemaVersion: 2, operationId: "fixture-switch-held", attemptDigest: "e".repeat(64) });
  for (let wake = 0; wake < 4; wake++) {
    if (wake) now += 1_001;
    await continuation.completed!(completed);
    expect((await activationReceipt.get()).exists).toBe(false);
    expect((await activationHint.get()).data()!.nextAttemptAt).toBe(0);
    expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).data()).toMatchObject({
      nextAttemptAt: now + 1_000 * 2 ** wake, recoveryFailure: "activation-pending", continuationFailures: 0 });
  }
  await writerFence.delete();
  const adoption = firestore.doc(`${admission.ADMISSIONS}/controls/adoption`);
  await adoption.update({ enabled: false });
  for (let wake = 0; wake < 4; wake++) {
    now += 1_001;
    await bound.recover();
    expect((await activationReceipt.get()).exists).toBe(false);
    expect((await activationHint.get()).data()).toMatchObject({ attempts: 0,
      nextAttemptAt: now + 1_000, lastFailure: "stale-snapshot" });
  }
  await explicitRepair();
  expect((await activationReceipt.get()).exists).toBe(false);
  expect((await activationHint.get()).data()).toMatchObject({ attempts: 0 });
  await adoption.update({ enabled: true });
  await activationHint.update({ attempts: 1, nextAttemptAt: now + 60_000, lastFailure: "activation-refused" });
  const deferredActivation = await activationHint.get();
  await continuation.completed!(completed);
  expect((await activationReceipt.get()).exists).toBe(false);
  expect((await activationHint.get()).updateTime!.isEqual(deferredActivation.updateTime!)).toBe(true);
  expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).data()).toMatchObject({
    recoveryFailure: "activation-pending", nextAttemptAt: now + 60_000 });
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.status).toBe("pending");
  await activationHint.update({ attempts: 3, nextAttemptAt: null });
  const quarantinedActivation = await activationHint.get();
  now += 60_001;
  await continuation.completed!(completed);
  await continuation.beforePoll!({});
  expect((await activationReceipt.get()).exists).toBe(false);
  expect((await activationHint.get()).updateTime!.isEqual(quarantinedActivation.updateTime!)).toBe(true);
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(true);
  expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).data()).toMatchObject({
    recoveryFailure: "activation-quarantined", nextAttemptAt: null });
  expect(await checkWorkerWake()).toBe(false);
  await explicitRepair();
  expect((await activationReceipt.get()).exists).toBe(true);
  expect((await activationHint.get()).exists).toBe(false);
  const actualActivation = (await activationReceipt.get()).data()!;
  // Corrupt actual immutable SDK evidence. Three real owner refusals park
  // only this continuation; neither the original census nor queue may settle.
  await activationReceipt.update({ "attempt.originalView.claimDigest": "f".repeat(64) });
  for (let attempt = 1; attempt <= 3; attempt++) {
    now += 1_001;
    await continuation.completed!(completed);
    const hint = (await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).data()!;
    expect(hint.recoveryFailure).toBe("activation-refused");
    expect(hint.continuationFailures).toBe(attempt);
    expect(hint.nextAttemptAt).toBe(attempt === 3 ? null : now + 1_000 * 2 ** (attempt - 1));
    expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.status).toBe("pending");
  }
  expect(await checkWorkerWake()).toBe(false);
  await expect(continuation.retryCompleted!({ ...completed, claimDigest: protocol.publicReleaseDigest("forged") })).rejects.toThrow();
  expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).data()!.nextAttemptAt).toBeNull();
  await activationReceipt.set(actualActivation);
  await explicitRepair();
  await continuation.completed!({ identity: staged.claim.identity, claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "pending", terminalReceipt: null });
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(true);
  expect((await firestore.doc(admission.ADMISSIONS).get()).data()!.pendingCount).toBe(1);
  expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).data()).toMatchObject({
    nextAttemptAt: now + 2_000, recoveryFailure: "public-confirmation-pending" });
  canonicalAvailable = true; now += 2_001;
  const confirmationServer = await startPublicReleasePairServer({ firestore, pair, host: "127.0.0.1", port: 0,
    execute: async () => { throw new Error("Completed original must not render twice"); }, beforePoll: continuation.beforePoll });
  try {
    if (!confirmationServer.address || typeof confirmationServer.address === "string") throw new Error("No confirmation server");
    origin = `http://127.0.0.1:${confirmationServer.address.port}`;
    expect((await firestore.collection(`${base}/staging`).get()).empty).toBe(true);
    expect((await firestore.collection(`${base}/activationPending`).get()).empty).toBe(true);
    expect((await firestore.collection(`${base}/work`).get()).docs.every(row => row.data().status === "complete")).toBe(true);
    expect(await checkWorkerWake(false)).toBe(false);
    expect(await checkWorkerWake()).toBe(true);
    await confirmationServer.waitForCurrentWork();
  } finally { await confirmationServer.close(); workerClock.mockRestore(); }
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "success", execution: { taskId: tasks.docs[0].id } });
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(false);
  expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).exists).toBe(false);
  expect((await firestore.doc(admission.ADMISSIONS).get()).data()).toMatchObject({ pendingCount: 0 });
  expect((await tasks.docs[0].ref.get()).data()).toEqual(original);
  await continuation.beforePoll!({});
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.publication-settle").get()).size).toBe(1);
}, 120_000);

it("defers an older completed operation so its not-yet-rendered successor is discovered", async () => {
  const { firestore, pair } = fixture, olderId = "A".repeat(20), successorId = "Z".repeat(20);
  const accept = async (id: string, version: number) => {
    const story = (await firestore.doc("cmsPosts/story").get()).data()!;
    const nextDocument = { ...story, version, publishBuildPending: true, publishBuildQueueId: id,
      published: { ...story.published, sourceVersion: version, metadata: { ...story.published.metadata, title: `Version ${version}` } } };
    await firestore.runTransaction(async transaction => {
      const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
        nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${id}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
      prepared.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
    });
  };
  now = Date.now();
  await accept(olderId, 11); await continuation.beforePoll!({});
  const rows = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`)
    .where("identity.sourceOperationId", "==", olderId).get();
  expect(rows.size).toBe(1);
  const original = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: rows.docs[0].id }, store);
  await accept(successorId, 12);
  now = Date.now();
  for (let wake = 0; wake < 4; wake++) {
    if (wake) now += 1_001;
    await continuation.completed!({ identity: original.claim.identity, claimDigest: original.owner.claimDigest, manifestDigest: original.rendered.manifestDigest });
    expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, olderId)).get()).data()).toMatchObject({
      nextAttemptAt: now + 1_000 * 2 ** wake, recoveryFailure: "supersession-pending", continuationFailures: 0 });
  }
  expect((await firestore.doc(`cmsPublishQueue/${olderId}`).get()).data()).toMatchObject({ status: "pending", execution: null });
  await continuation.beforePoll!({});
  const successor = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`)
    .where("identity.sourceOperationId", "==", successorId).get();
  expect(successor.size).toBe(1); expect(successor.docs[0].data()).toMatchObject({ status: "pending", attempts: 0,
    identity: { sourceOperationId: successorId, sourceVersion: 12 } });
  expect((await firestore.doc(`cmsPosts/story`).get()).data()).toMatchObject({ version: 12, publishBuildPending: true, publishBuildQueueId: successorId });
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${olderId}`).get()).exists).toBe(true);
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${successorId}`).get()).exists).toBe(true);
}, 120_000);
