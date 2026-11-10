import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { guardedPublicReleaseSwitchFixture } from "../helpers/guarded-public-release-switch";
import { qualifyPublicReleasePair } from "../../site/scripts/public-release-pair-qualification";
import { prepareGuardedPublicReleaseSwitch, applyPreparedGuardedPublicReleaseSwitch,
  readGuardedPublicReleaseSwitchReceipt, readGuardedPublicReleaseSwitchAttempt,
  abandonGuardedPublicReleaseSwitch, reservePreparedGuardedPublicReleaseSwitch } from "../../site/scripts/public-release-switch-operator";
import replay from "../../functions/lib/public-release-pair-replay.js";
import protocol from "../../functions/lib/public-release-pair.js";
import switches from "../../functions/lib/public-release-switch.js";
import inclusion from "../../functions/lib/public-release-inclusion.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import admission from "../../functions/lib/public-release-admission.js";
import serving from "../../functions/lib/public-release-serving.js";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
import { preparePublicReleasePublicationTerminal, settlePreparedPublicReleasePublication } from "../../site/scripts/public-release-publication-terminal";
import { publicReleaseTerminalTransport } from "../../site/scripts/public-release-terminal-transport";
import { pairOwnerWriteRpc } from "../../publisher/pair-owner-write-rpc";
import { pairOwnerEvidenceClient } from "../../publisher/pair-owner-evidence-client";
import { pairFirestoreReader, decodePairEvidenceFields } from "../../publisher/pair-work-reader";
import { ownerTerminalFactReader } from "../../publisher/pair-owner-terminal-fact";
import { pairTerminalRpc } from "../../publisher/pair-terminal-rpc";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { advancePublicReleaseSwitchCodeHead } from "../../site/scripts/public-release-switch-code-head";
import { createRequire } from "node:module";
const family = createRequire(import.meta.url)("../../functions/lib/public-release-family-admission.js");

let runtime: Miniflare, fixture: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const db = () => fixture.selected.firestore;
let settlement: { options: Parameters<typeof preparePublicReleasePublicationTerminal>[0]; pending(): Promise<void>;
  originalPair: any; selectedPair: any; operationId: string; originalExecution: any; originalQueue: any; saved: any; record: any };
beforeAll(async () => {
  ({ runtime, store } = await publicReleaseR2Fixture("guarded-switch"));
  fixture = await guardedPublicReleaseSwitchFixture(isolatedFirestore("actual-guarded-switch-operator"), store);
}, 120_000);

async function proveCurrentContentReturn() {
  const firestore = db(), oldPair = fixture.pair, newPair = fixture.selected.pair;
  const switchChange = switches.switchChangeOperationId("actual-guarded-switch");
  await fixture.replayOperation(switchChange);
  const operationId = "M".repeat(20), story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextDocument = { ...story, version: 10, publishBuildPending: true, publishBuildQueueId: operationId,
    published: { ...story.published, sourceVersion: 10, metadata: { ...story.published.metadata, title: "Current content after switch" } } };
  await firestore.runTransaction(async transaction => {
    const accepted = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    accepted.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
  });
  await fixture.replayOperation(operationId);
  for (const [index, pair] of [oldPair, newPair].entries()) {
    const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
    await qualifyPublicReleasePair({ firestore, store, pair, qualificationId: index ? "return-new" : "return-old",
      witnessDigest: witness.witnessDigest, credentials: fixture.transport.credentials });
  }
  const before = protocol.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data());
  const proof = await prepareGuardedPublicReleaseSwitch({ firestore, store, oldPair, newPair, operationId: "actual-guarded-return",
    oldQualificationId: "return-old", newQualificationId: "return-new" });
  const result = await applyPreparedGuardedPublicReleaseSwitch({ firestore, proof });
  expect(result.receipt.selector.selectedPair).toEqual(protocol.publicReleasePairReference(newPair));
  expect(result.receipt.selector.epoch).toBe(before.epoch + 1);
  expect(result.receipt.selector.activeGeneration).toBe(before.activeGeneration + 1);
  expect(result.receipt.selector.contentHead.contextSequence).toBe(4);
  const accepted = (await firestore.doc(`system/publicReleaseAdmissions/operations/${operationId}`).get()).data()!;
  expect(accepted.pair).toEqual(protocol.publicReleasePairReference(oldPair));
  expect(accepted.source.sourceVersion).toBe(10);
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "pending", execution: null, pair: accepted.pair });
  expect((await firestore.doc(`system/publicReleaseAdmissions/pending/${operationId}`).get()).exists).toBe(true);
  expect((await firestore.doc("system/publicReleaseAdmissions").get()).data()!.pendingCount).toBe(2);
  expect((await firestore.doc("cmsPosts/story").get()).data()!.published.sourceVersion).toBe(10);
}
afterAll(async () => { vi.unstubAllGlobals(); await fixture?.close(); await runtime?.dispose(); });

it("guards the actual switch and current-content return, retaining original work and recovering the original receipt", async () => {
  const firestore = db(), oldPair = fixture.selected.pair, newPair = fixture.pair;
  async function qualify(ids: string[]) {
    for (const [index, pair] of [oldPair, newPair].entries()) {
      const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
      const result = await qualifyPublicReleasePair({ firestore, store, pair, qualificationId: ids[index],
        witnessDigest: witness.witnessDigest, credentials: fixture.transport.credentials });
      expect(result.receipt.kind).toBe("private-pair-qualification");
    }
  }
  const qualificationIds = ["guarded-old", "guarded-new"];
  await qualify(qualificationIds);
  const operationId = "actual-guarded-switch";
  const cancelled = new AbortController();
  const expired = await prepareGuardedPublicReleaseSwitch({ firestore, store, oldPair, newPair, operationId: "aborted-before-reserve",
    oldQualificationId: qualificationIds[0], newQualificationId: qualificationIds[1], signal: cancelled.signal });
  const mediaRef = firestore.doc(switches.MEDIA), mediaBefore = (await mediaRef.get()).data()!;
  await mediaRef.update({ references: mediaBefore.references.filter((row: any) => row.pairId !== newPair.pairId) });
  await expect(applyPreparedGuardedPublicReleaseSwitch({ firestore, proof: expired })).rejects.toThrow();
  expect(await readGuardedPublicReleaseSwitchAttempt({ firestore, operationId: expired.operationId })).toBeNull();
  expect((await firestore.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
  await mediaRef.set(mediaBefore);
  cancelled.abort();
  await expect(applyPreparedGuardedPublicReleaseSwitch({ firestore, proof: expired })).rejects.toThrow();
  expect(await readGuardedPublicReleaseSwitchAttempt({ firestore, operationId: expired.operationId })).toBeNull();
  expect((await firestore.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
  const stale = await prepareGuardedPublicReleaseSwitch({ firestore, store, oldPair, newPair, operationId: "refused-guarded-switch",
    oldQualificationId: qualificationIds[0], newQualificationId: qualificationIds[1] });
  const before = protocol.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data());
  await expect(applyPreparedGuardedPublicReleaseSwitch({ firestore, proof: { ...stale } })).rejects.toThrow();
  await reservePreparedGuardedPublicReleaseSwitch({ firestore, proof: stale });
  await firestore.doc("system/billing").update({ disabled: true });
  await expect(applyPreparedGuardedPublicReleaseSwitch({ firestore, proof: stale })).rejects.toThrow();
  expect(protocol.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data())).toEqual(before);
  expect(await readGuardedPublicReleaseSwitchReceipt({ firestore, operationId: stale.operationId })).toBeNull();
  await firestore.doc("system/billing").update({ disabled: false });
  const durable = await readGuardedPublicReleaseSwitchAttempt({ firestore, operationId: stale.operationId });
  expect(protocol.publicReleaseDigest(durable)).toBe(stale.attemptDigest);
  await expect(abandonGuardedPublicReleaseSwitch({ firestore, operationId: stale.operationId,
    expectedAttemptDigest: "f".repeat(64) })).rejects.toThrow();
  await abandonGuardedPublicReleaseSwitch({ firestore, operationId: stale.operationId, expectedAttemptDigest: protocol.publicReleaseDigest(durable) });
  await qualify(["guarded-old-fresh", "guarded-new-fresh"]);
  const proof = await prepareGuardedPublicReleaseSwitch({ firestore, store, oldPair, newPair, operationId,
    oldQualificationId: "guarded-old-fresh", newQualificationId: "guarded-new-fresh" });
  const result = await applyPreparedGuardedPublicReleaseSwitch({ firestore, proof });
  expect(result.idempotent).toBe(false);
  expect(result.receipt.selector.selectedPair).toEqual(protocol.publicReleasePairReference(newPair));
  expect(result.receipt.selector.recoveryPair).toEqual(protocol.publicReleasePairReference(oldPair));
  expect(result.receipt.selector.epoch).toBe(before.epoch + 1);
  expect(result.receipt.selector.activeGeneration).toBe(before.activeGeneration + 1);
  expect(result.receipt.selector.contentHead.contextSequence).toBe(2);
  const pins = (await firestore.doc("system/cmsPublicationRuntime").get()).data()!;
  expect(pins).toMatchObject({ phase: "ready", commitSha: newPair.commitSha, cloud: { phase: "ready", commitSha: newPair.commitSha } });
  expect(await readGuardedPublicReleaseSwitchReceipt({ firestore, operationId })).toEqual(result.receipt);
  await expect(abandonGuardedPublicReleaseSwitch({ firestore, operationId, expectedAttemptDigest: proof.attemptDigest })).rejects.toThrow();
  expect((await applyPreparedGuardedPublicReleaseSwitch({ firestore, proof })).receipt).toEqual(result.receipt);
  expect((await firestore.collection("admin_logs").where("operationId", "==", operationId).get()).size).toBe(1);
}, 120_000);

it("returns to OLD with current content and leaves NEW's original accepted work pending", async () => {
  expect(await readGuardedPublicReleaseSwitchReceipt({ firestore: db(), operationId: "actual-guarded-switch" })).not.toBeNull();
  await proveCurrentContentReturn();
}, 120_000);

it("settles the original NEW operation through OLD only with immutable inclusion and actual canonical bytes", async () => {
  const firestore = db(), originalPair = fixture.pair, selectedPair = fixture.selected.pair, operationId = "M".repeat(20);
  const before = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!;
  expect(before.pair).toEqual(protocol.publicReleasePairReference(originalPair));
  const rendered = await recoverOriginalPublicReleaseWork({ firestore, store, pair: originalPair, operationId,
    capture: { providerStore: fixture.selected.providerStore, resourceRequest: async () => { throw new Error("No latest resource fallback"); } } });
  expect(rendered.status).toBe("rendered");
  const originalExecution = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.execution;
  // The switch appends CODE after its qualified watermark. Advance through
  // that actual immutable event before requesting current canonical proof.
  await fixture.replayOperation(switches.switchChangeOperationId("actual-guarded-return"));
  const latest = await replay.sealPublicReleasePairReplayWitness({ firestore, pair: selectedPair });
  const replayed = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair: selectedPair,
    headCursor: latest.witness.headCursor, witnessDigest: latest.witnessDigest });
  const advanced = await advancePublicReleaseSwitchCodeHead({ firestore, store, pair: selectedPair,
    identity: replayed.headView.identity, claimDigest: replayed.headView.claimDigest, manifestDigest: replayed.headView.manifestDigest });
  expect(advanced.status).toBe("activated");
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
    slots: [originalPair, selectedPair].map(pair => createPublicReleaseSlot({ pair,
      workerVersionId: pair.publicWorker.versionId, store, getDecision: (selection, path) => serving.readPublicReleaseDecision({
        firestore, environment: "development", pair, selection, path, composedReadersEnabled: true }) })) });
  const actualIngress = { prove: (request: Request, digest: string, expected: { status: 200 | 308 | 410 }) => router.prove(request, digest, expected) };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname !== "pair-terminal.internal") return originalFetch(request);
    return pairTerminalRpc(request, store as any,
      { pair: originalPair, read: async path => (await firestore.doc(path).get()).data() ?? null }, actualIngress);
  });
  process.stderr.write("inclusion: CODE advanced; entering actual terminal proof\n");
  const transport = publicReleaseTerminalTransport(originalPair.environment);
  const options = { firestore, store: transport.store, ingress: transport.ingress, operationId, fieldValues: FieldValue };
  const pending = async () => {
    expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "pending", execution: originalExecution });
    expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(true);
    expect((await firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`).get()).exists).toBe(false);
  };
  await expect(preparePublicReleasePublicationTerminal({ ...options, store, ingress: { prove: request => router.fetch(request) } })).rejects.toThrow();
  await pending();
  await expect(preparePublicReleasePublicationTerminal({ ...options, ingress: {
    async prove(request, digest, expected) {
      const response = await actualIngress.prove(request, digest, expected);
      return new Response("Altered public bytes", { status: response.status, headers: response.headers });
    },
  } })).rejects.toThrow();
  await pending();
  process.stderr.write("inclusion: ordinary/altered proof refused; preparing inclusion\n");
  const proof = await preparePublicReleasePublicationTerminal(options);
  process.stderr.write("inclusion: durable proof issued; checking tamper refusals\n");
  const records = await firestore.collection(inclusion.INCLUSION_PROOFS).where("operationId", "==", operationId).get();
  expect(records.size).toBe(1);
  const saved = records.docs[0], record = inclusion.parsePairPublicationInclusion(saved.data());
  expect(record.originalRendererDigest).toBe(originalPair.rendererDigest);
  expect(record.selectedRendererDigest).toBe(selectedPair.rendererDigest);
  expect(record.originalExecutionDigest).toBe(protocol.publicReleaseDigest(originalExecution));
  expect(record.originalPair).toEqual(protocol.publicReleasePairReference(originalPair));
  expect(record.selectedPair).toEqual(protocol.publicReleasePairReference(selectedPair));
  expect(record.sourceVersion).toBe(10);
  await pending(); // private evidence alone never acknowledges publication
  settlement = { options, pending, originalPair, selectedPair, operationId, originalExecution, originalQueue: before, saved, record };
}, 120_000);

it("refuses an altered immutable inclusion renderer without settling the original queue", async () => {
  const { options, pending, saved } = settlement, firestore = db();
  const proof = await preparePublicReleasePublicationTerminal(options);
  await saved.ref.update({ selectedRendererDigest: "f".repeat(64) });
  await expect(settlePreparedPublicReleasePublication({ firestore, proof })).rejects.toThrow(); await pending();
  await saved.ref.set(saved.data());
}, 120_000);

it("refuses altered immutable inclusion bytes without settling the original queue", async () => {
  const { options, pending, record } = settlement, firestore = db();
  const proof = await preparePublicReleasePublicationTerminal(options);
  const pageRef = firestore.doc(`${inclusion.INCLUSION_PAGES}/${record.outputs.pages[0]}`), page = (await pageRef.get()).data()!;
  await pageRef.update({ members: [{ ...page.members[0], selectedBodyDigest: "f".repeat(64) }, ...page.members.slice(1)] });
  await expect(settlePreparedPublicReleasePublication({ firestore, proof })).rejects.toThrow(); await pending();
  await pageRef.set(page);
}, 120_000);

it("refuses an absent immutable inclusion root without settling the original queue", async () => {
  const { options, pending, saved } = settlement, firestore = db();
  const proof = await preparePublicReleasePublicationTerminal(options);
  await saved.ref.delete();
  await expect(settlePreparedPublicReleasePublication({ firestore, proof })).rejects.toThrow(); await pending();
  await saved.ref.set(saved.data());
}, 120_000);

it("settles original NEW work on OLD with the exact inclusion evidence and one terminal audit", async () => {
  const { options, operationId, originalExecution, selectedPair, originalQueue: before } = settlement, firestore = db();
  const proof = await preparePublicReleasePublicationTerminal(options);
  const result = await settlePreparedPublicReleasePublication({ firestore, proof });
  expect(result.receipt.outcome).toBe("success");
  expect(result.receipt.originalExecution).toEqual(originalExecution);
  expect(result.receipt.selector.selectedPair).toEqual(protocol.publicReleasePairReference(selectedPair));
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.pair).toEqual(before.pair);
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(false);
  expect((await firestore.doc(admission.ADMISSIONS).get()).data()!.pendingCount).toBe(1);
  const fact = await firestore.runTransaction(transaction => terminal.assertPairPublicationTerminalReceiptInTransaction({
    firestore, transaction, operationId, admissionDigest: result.receipt.admissionDigest }));
  expect(fact).toEqual(result.receipt);
  expect((await settlePreparedPublicReleasePublication({ firestore, proof })).idempotent).toBe(true);
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.publication-settle").get()).size).toBe(1);
}, 120_000);

it("reads the large issued cross-pair FACT over real REST for post-G replay and refuses unissued/tampered facts before storage", async () => {
  const { operationId, originalPair: pair } = settlement, firestore = db();
  const factRef = firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`), queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const fact = (await factRef.get()).data()!, queue = (await queueRef.get()).data()!;
  const canonicalRef = firestore.doc(`${admission.ADMISSIONS}/canonicalProofs/${fact.canonicalProofDigest}`);
  const canonical = (await canonicalRef.get()).data()!;
  const networkFetch = globalThis.fetch, wireSizes: number[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const response = await networkFetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}${url.pathname}${url.search}`, init);
    if (url.pathname.endsWith(`/canonicalProofs/${fact.canonicalProofDigest}`)) wireSizes.push((await response.clone().arrayBuffer()).byteLength);
    return response;
  };
  const projectId = factRef.firestore.projectId, token = "owner"; // The fixture proxy advertises the contract target; refs retain the isolated demo project.
  const reader = pairFirestoreReader({ projectId, token, request });
  const evidence = pairOwnerEvidenceClient({ projectId, token, pair, decode: decodePairEvidenceFields, request });
  const terminalFact = ownerTerminalFactReader({ pair, read: evidence.readTerminalEvidence });
  expect(await terminalFact(operationId, fact.admissionDigest)).toEqual(fact);
  expect(Math.max(...wireSizes)).toBeGreaterThan(64 * 1024);
  console.info("terminal FACT REST bytes", Math.max(...wireSizes), "canonical outputs", canonical.proofs.length);
  await expect(reader.read(canonicalRef.path)).rejects.toThrow("size limit");

  const prefix = `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/pages/`;
  let retained: { key: string; body: Uint8Array; metadata: Record<string, string> } | undefined;
  for (const object of (await store.list({ prefix })).objects) {
    const stored = (await store.get(object.key))!, body = new Uint8Array(await stored.arrayBuffer());
    const page = JSON.parse(new TextDecoder().decode(body));
    if (page.kind === "content" && page.members.some((member: any) => member.view.identity.sourceOperationId === operationId)) {
      retained = { key: object.key, body, metadata: stored.customMetadata! }; break;
    }
  }
  expect(retained).toBeDefined();
  const page = retained!;
  const makeRequest = () => new Request(`http://pair-owner-write.internal/${page.key}`, { method: "PUT", body: page.body,
    headers: { "if-none-match": "*", "content-length": String(page.body.length), "x-owner-operation": operationId,
      "x-pair-metadata": JSON.stringify(page.metadata) } });
  let writes = 0;
  const bucket = { get: (key: string) => store.get(key), put: (...args: Parameters<typeof store.put>) => { writes++; return store.put(...args); } };
  const authority = { pair, read: reader.read, ...evidence };
  const unissued = { schemaVersion: 2, operationId, selectorDigest: fact.selectorDigest,
    proofs: Array.from({ length: 101 }, () => ({})) };
  const unissuedDigest = protocol.publicReleaseDigest(unissued), unissuedRef = firestore.doc(`${admission.ADMISSIONS}/canonicalProofs/${unissuedDigest}`);
  await unissuedRef.set(unissued);
  expect(await evidence.readTerminalEvidence(unissuedRef.path)).toEqual(unissued);
  await expect(reader.read(unissuedRef.path)).rejects.toThrow("Invalid private pair array");
  try {
    // A readable 101-element REST document is not an issued inclusion FACT.
    const forged = { ...fact, canonicalProofDigest: unissuedDigest };
    await factRef.set(forged); await queueRef.update({ terminalReceipt: protocol.publicReleaseDigest(forged) });
    expect((await pairOwnerWriteRpc(makeRequest(), bucket as any, authority)).status).toBe(403);
    expect(writes).toBe(0);
    await factRef.set(fact); await queueRef.set(queue);
    await canonicalRef.update({ proofs: [{ ...canonical.proofs[0], bodyDigest: "f".repeat(64) }, ...canonical.proofs.slice(1)] });
    expect((await pairOwnerWriteRpc(makeRequest(), bucket as any, authority)).status).toBe(403);
    expect(writes).toBe(0);
    await canonicalRef.set(canonical);
    const before = (await store.head(page.key))!.etag;
    // Existing immutable page: 412 is the transport's verified-idempotent result.
    expect((await pairOwnerWriteRpc(makeRequest(), bucket as any, authority)).status).toBe(412);
    expect(writes).toBe(1); expect((await store.head(page.key))!.etag).toBe(before);
    expect((await factRef.get()).data()).toEqual(fact);
    expect((await queueRef.get()).data()).toEqual(queue);
  } finally {
    await canonicalRef.set(canonical); await factRef.set(fact); await queueRef.set(queue); await unissuedRef.delete();
  }
});
