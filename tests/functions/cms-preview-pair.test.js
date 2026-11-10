import { createRequire } from "node:module";
import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { pair, reader, receipt, selector, candidate, proof } from "../helpers/cms-preview-pairs.js";
const api = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
const db = isolatedFirestore("cms-preview-pair");
const now = Date.now();
const old = pair("old"), next = pair("new", "b"), initial = selector(old, next);
let proofDigest;
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await api.registerPair(db, old); await api.registerPair(db, next);
  await db.doc(api.SELECTOR_PATH).set(initial);
  await db.doc(api.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, component: "renderer", state: "complete",
    pairId: old.pairId, selectorDigest: api.digest(initial), lastComplete: candidate(old, now).mutation });
  for (const component of ["functions", "cmsApi"]) await db.doc(`${api.READER_RECEIPTS}/${component}`).set(receipt(component, now));
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(candidate(next, now));
  proofDigest = await api.recordProof(db, proof(old, next, now));
});
const select = (overrides = {}) => api.selectPair(db, { operationId: "preview-switch", expectedSelectorDigest: api.digest(initial),
  newPairId: next.pairId, proofDigest, ...overrides }, now);
const current = async () => (await db.doc(api.SELECTOR_PATH).get()).data();

it("selects NEW and its completed receipt together; lost-response retry returns the same epoch", async () => {
  await db.doc("cmsDeploymentReceipts/renderer").set({ schemaVersion: 1, state: "in_progress", mutation: { sourceSha: "c".repeat(40) } });
  const legacy = (await db.doc("cmsDeploymentReceipts/renderer").get()).data();
  const first = await select(), second = await select();
  expect((await db.doc("cmsDeploymentReceipts/renderer").get()).data()).toEqual(legacy);
  expect(first).toEqual(second);
  expect(await current()).toMatchObject({ phase: "ready", epoch: 2, selectedPairId: next.pairId, recoveryPairId: old.pairId });
  await expect(select({ proofDigest: "f".repeat(64) })).rejects.toThrow();
});
it.each(["candidate", "proof", "functions", "cmsApi"])("failure/cancellation before %s verification keeps OLD ready", async boundary => {
  const paths = { candidate: "cmsDeploymentCandidates/renderer-100-1", proof: `${api.PROOFS}/${proofDigest}`,
    functions: "cmsReaderCompatibilityReceipts/functions", cmsApi: "cmsReaderCompatibilityReceipts/cmsApi" };
  await db.doc(paths[boundary]).delete();
  await expect(select()).rejects.toThrow();
  expect(await current()).toEqual(initial);
  expect((await db.collection(api.SWITCHES).get()).empty).toBe(true);
});
it("refuses stale proofs, changed live readers and provider identity drift", async () => {
  const oldProof = { ...proof(old, next, now), verifiedAt: new Date(now - 300_001).toISOString() };
  await expect(select({ proofDigest: await api.recordProof(db, oldProof) })).rejects.toThrow();
  const stale = receipt("functions", now - 300_001);
  await db.doc("cmsReaderCompatibilityReceipts/functions").set(stale);
  const staleReaderProof = { ...proof(old, next, now), readerDigests: {
    ...proof(old, next, now).readerDigests, functions: api.digest(stale.lastComplete) } };
  await expect(select({ proofDigest: await api.recordProof(db, staleReaderProof) })).rejects.toThrow();
  await db.doc("cmsReaderCompatibilityReceipts/functions").set(receipt("functions", now));
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(candidate(next, now - 300_001));
  await expect(select()).rejects.toThrow();
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(candidate(next, now));
  const changedReader = receipt("functions", now);
  changedReader.lastComplete.providerIdentities.deploymentId = "replaced";
  await db.doc("cmsReaderCompatibilityReceipts/functions").set(changedReader);
  await expect(select()).rejects.toThrow();
  await db.doc("cmsReaderCompatibilityReceipts/functions").set(receipt("functions", now));
  const changed = candidate(next, now); changed.mutation.providerIdentities.workerVersion = old.workerVersion;
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(changed);
  await expect(select()).rejects.toThrow();
  expect(await current()).toEqual(initial);
});
it("permits only one concurrent selector commit", async () => {
  const results = await Promise.allSettled([select(), select({ operationId: "preview-race" })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await current()).epoch).toBe(2);
});
it("requires both retained reader contracts, including Post chrome and settings", () => {
  api.assertReaderSupports(reader("functions", now), [old, next]);
  const incompatible = structuredClone(next); incompatible.requirements.postChrome = 2;
  expect(() => api.assertReaderSupports(reader("functions", now), [old, incompatible])).toThrow("both retained");
});
it("strictly parses schema two and refuses reuse of immutable pair identities", async () => {
  expect(() => api.parseSelector({ ...initial, phase: "paused" })).toThrow();
  expect(() => api.parseSelector({ ...initial, epoch: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  expect(() => api.parsePair({ ...next, workerName: "njpbs-cms-preview-renderer" })).toThrow();
  expect(() => api.parsePair({ ...next, extra: true })).toThrow();
  await expect(api.registerPair(db, { ...next, rendererSha: "c".repeat(40) })).rejects.toThrow();
});

it.each([null, { schemaVersion: 1, state: "in_progress" }, { schemaVersion: 3, state: "complete" },
  { schemaVersion: 2, state: "complete", pairId: "preview-other" }])("preserves a missing or conflicting live renderer receipt", async value => {
  const ref = db.doc(api.RENDERER_RECEIPT_PATH);
  if (value) await ref.set({ lastComplete: candidate(old, now).mutation, ...value });
  else await ref.delete();
  const before = (await ref.get()).data();
  await expect(select()).rejects.toThrow();
  expect((await ref.get()).data()).toEqual(before);
  expect(await current()).toEqual(initial);
});

it("refuses values coerced into schema-two strings or timestamps", () => {
  expect(() => api.parsePair({ ...next, rendererSha: [next.rendererSha] })).toThrow();
  expect(() => api.parseReader({ ...reader("functions", now), sourceSha: [old.rendererSha] })).toThrow();
  expect(() => api.parseProof({ ...proof(old, next, now), candidateReceiptId: ["renderer-100-1"] })).toThrow();
  expect(() => api.parseProof({ ...proof(old, next, now), verifiedAt: [new Date(now).toISOString()] })).toThrow();
});
