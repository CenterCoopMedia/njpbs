import { createRequire } from "node:module";
import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { pair, candidate, selector } from "../helpers/cms-preview-pairs.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
const require = createRequire(import.meta.url);
const pairs = require("../../functions/lib/cms-preview-pair.js");
const api = require("../../functions/lib/cms-preview-pair-candidate.js");
const db = isolatedFirestore("cms-preview-pair-candidate");
const old = pair("old"), next = pair("new", "b"), legacy = { schemaVersion: 1, phase: "ready", rendererSha: old.rendererSha, serializerId: "cloudflare-preview" };
let now, input, sequence = 0;
const record = overrides => api.recordPreviewPairCandidatePointer({ firestore: db, request: { ...input, ...overrides }, clock: () => now });
const observe = overrides => api.readPreviewPairRuntimeAuthority({ read: async path => (await db.doc(path).get()).data() ?? null,
  pairId: next.pairId, rendererSha: next.rendererSha, workerVersion: next.workerVersion, now, ...overrides });
beforeEach(async () => {
  now = Date.now();
  await pairs.registerPair(db, old); await pairs.registerPair(db, next);
  await db.doc(pairs.SELECTOR_PATH).set(legacy);
  await db.doc(`${api.POINTERS}/${next.pairId}`).delete();
  const verified = candidate(next, now);
  Object.assign(verified.mutation.providerIdentities, { applicationId: "new-application", workerDeploymentId: "new-deployment" });
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(verified);
  input = { operationId: `preview-candidate-${++sequence}`, pairId: next.pairId, candidateReceiptId: "renderer-100-1",
    expectedPointerDigest: null, expectedRuntimeDigest: pairs.digest(api.previewRuntimeIdentity(legacy)), bootstrapPublicPair: pairReference(releasePair()) };
});
it("starts a verified private candidate beside the unchanged legacy OLD selection", async () => {
  const result = await record();
  expect(await observe()).toMatchObject({ mode: "candidate", pair: next, candidateReceiptId: input.candidateReceiptId });
  expect((await db.doc(pairs.SELECTOR_PATH).get()).data()).toEqual(legacy);
  expect((await db.doc(pairs.RENDERER_RECEIPT_PATH).get()).exists).toBe(false);
  expect(await record()).toEqual(result);
});
it("uses retained authority after the initial selector appears without redeploying the Worker", async () => {
  const original = await record();
  await db.doc(pairs.SELECTOR_PATH).set(selector(old, next));
  now += 300_001;
  expect(await observe()).toMatchObject({ mode: "retained", pair: next, candidateReceiptId: null });
  expect(await record()).toEqual(original);
});
it.each(["candidate", "runtime", "version", "pointer", "expiry"])("refuses changed %s authority", async boundary => {
  await record();
  if (boundary === "candidate") await db.doc("cmsDeploymentCandidates/renderer-100-1").update({ "mutation.providerIdentities.imageDigest": old.imageDigest });
  if (boundary === "runtime") await db.doc(pairs.SELECTOR_PATH).update({ rendererSha: "c".repeat(40) });
  if (boundary === "pointer") await db.doc(`${api.POINTERS}/${next.pairId}`).update({ candidateDigest: "c".repeat(64) });
  if (boundary === "expiry") now += 300_001;
  await expect(observe(boundary === "version" ? { workerVersion: old.workerVersion } : {})).rejects.toThrow("authority is unavailable");
});
it("does not confuse restart telemetry with a changed runtime identity", async () => {
  await record();
  await db.doc(pairs.SELECTOR_PATH).update({ checkedAt: new Date(now + 1).toISOString(), startupTimingsMs: { runtime: 2 } });
  expect((await observe()).mode).toBe("candidate");
  await db.doc(pairs.SELECTOR_PATH).update({ phase: "paused" });
  await expect(observe()).rejects.toThrow("authority is unavailable");
});
it("refuses a missing candidate and conflicting pointer writer without creating an operation receipt", async () => {
  await expect(observe()).rejects.toThrow();
  await db.doc("cmsDeploymentCandidates/renderer-100-1").update({ state: "in_progress" });
  await expect(record()).rejects.toThrow();
  expect((await db.doc(`${api.RECEIPTS}/${input.operationId}`).get()).exists).toBe(false);
  await db.doc("cmsDeploymentCandidates/renderer-100-1").update({ state: "verified" });
  const first = await record();
  await expect(record({ operationId: `${input.operationId}-race` })).rejects.toThrow();
  expect((await db.doc(`${api.POINTERS}/${next.pairId}`).get()).data()).toEqual(first.pointer);
});
it("never rewinds a newer verified pointer when an older response is retried", async () => {
  const original = await record();
  const candidateRow = (await db.doc("cmsDeploymentCandidates/renderer-100-1").get()).data();
  candidateRow.mutation.runId = "101";
  await db.doc("cmsDeploymentCandidates/renderer-101-1").set(candidateRow);
  const newer = await record({ operationId: `${input.operationId}-next`, candidateReceiptId: "renderer-101-1", expectedPointerDigest: original.pointerDigest });
  expect(await record()).toEqual(original);
  expect((await db.doc(`${api.POINTERS}/${next.pairId}`).get()).data()).toEqual(newer.pointer);
});
