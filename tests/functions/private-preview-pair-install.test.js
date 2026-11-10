import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { previewProviderFixture, versionId } from "../helpers/private-preview-provider-fixture.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { installPrivatePreviewPair, qualifyPrivatePreviewPair } from "../../scripts/lib/install-private-preview-pair.mjs";
const require = createRequire(import.meta.url), preview = require("../../functions/lib/cms-preview-pair.js"), p = require("../../functions/lib/public-release-pair.js");
let sequence = 0;
async function fixture(overrides) {
  const f = await previewProviderFixture(overrides), db = isolatedFirestore(`private-preview-install-${++sequence}`);
  const root = { schemaVersion: 1, phase: "ready", rendererSha: "a".repeat(40), serializerId: "cloudflare-preview" };
  await db.doc(preview.SELECTOR_PATH).set(root); await db.doc("system/billing").set({ disabled: false });
  for (const component of ["functions", "cmsApi", "renderer"]) await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, state: "complete", unchanged: component });
  await db.doc("cmsPreviewQueue/11111111111111111111").set({ status: "building", rendererSha: root.rendererSha, serializerId: root.serializerId, claimToken: "synthetic-original-claim" });
  const request = { operationId: `preview-install-${sequence}`, expectedRuntimeDigest: preview.digest(root), expectedCandidatePointerDigest: null,
    bootstrapPublicPair: pairReference(releasePair()), candidate: { sourceSha: f.descriptor.rendererSha, trustedWorkflowSha: "e".repeat(40),
      runId: String(100 + sequence), runAttempt: 1, inputFingerprint: f.prepared.bundleDigest, configurationFingerprint: f.prepared.configurationDigest } };
  const input = { firestore: db, prepared: f.prepared, request, readToken: () => "synthetic-api", readSecret: () => "synthetic-binding", fetchImpl: f.request, dryRun: false };
  const key = p.publicReleaseDigest({ worker: f.prepared.applicationName });
  f.state.beforeWrite = async action => {
    const value = (await db.doc(`system/publicReleasePrivateInstalls/attempts/${request.operationId}/steps/${key}-${action}`).get()).data();
    expect(value).toMatchObject({ schemaVersion: 1, action, attemptId: request.operationId, worker: f.prepared.applicationName });
  };
  const unchanged = async () => {
    expect((await db.doc(preview.SELECTOR_PATH).get()).data()).toEqual(root);
    expect((await db.doc("cmsPreviewQueue/11111111111111111111").get()).data()).toMatchObject({ status: "building", claimToken: "synthetic-original-claim", serializerId: root.serializerId });
    for (const component of ["functions", "cmsApi", "renderer"]) expect((await db.doc(`cmsDeploymentReceipts/${component}`).get()).data()).toEqual({ schemaVersion: 1, state: "complete", unchanged: component });
  };
  return { ...f, db, root, request, input, unchanged };
}
it("reserves each actual provider effect, registers only the assigned UUID, and proves private candidate health beside OLD", async () => {
  const f = await fixture(), result = await installPrivatePreviewPair(f.input);
  expect(f.state.writes).toEqual(["identity", "version", "deployment", "container", "schedule"]);
  expect(result.resource.pair.workerVersion).toBe(versionId); expect(result.qualification.health).toMatchObject({ ready: true, workerVersion: versionId });
  expect((await f.db.doc(`cmsPreviewPairs/${f.descriptor.pairId}`).get()).data().workerVersion).toBe(versionId);
  expect((await f.db.doc(`cmsDeploymentCandidates/renderer-${f.request.candidate.runId}-1`).get()).data()).toMatchObject({ state: "verified" });
  await f.unchanged();
  const requests = f.state.requests.length, retry = await installPrivatePreviewPair(f.input);
  expect(retry).toEqual(result); expect(f.state.writes).toHaveLength(5);
  expect(f.state.requests.slice(requests).every(r => r.method === "GET")).toBe(true);
});
it("plan mode validates the opaque seal but makes no network, credential or database write", async () => {
  const f = await fixture(); const result = await installPrivatePreviewPair({ ...f.input, dryRun: true });
  expect(result.dryRun).toBe(true); expect(f.state.requests).toHaveLength(0); await f.unchanged();
});
it.each(["identity", "version", "deployment", "container", "schedule"])("failure at %s consumes its send and leaves OLD rows and receipts intact", async action => {
  const f = await fixture(); f.state.failAction = action;
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); const writes = [...f.state.writes];
  f.state.failAction = null;
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); expect(f.state.writes).toEqual(writes); await f.unchanged();
});
it.each(["version", "deployment"])("lost %s reply reconciles the original observed resources without redispatch", async action => {
  const f = await fixture(); f.state.lostAction = action;
  expect((await installPrivatePreviewPair(f.input)).qualification.health.ready).toBe(true);
  expect(f.state.writes.filter(v => v === "version")).toHaveLength(1);
  expect(f.state.writes.filter(v => v === "deployment")).toHaveLength(1); await f.unchanged();
});
it("uncertain health never repeats its authority; explicit fresh proof retains all original provider receipts", async () => {
  const f = await fixture(); f.state.healthLost = true;
  await expect(installPrivatePreviewPair(f.input)).rejects.toMatchObject({ uncertain: true });
  const originalCandidate = (await f.db.doc(`cmsDeploymentCandidates/renderer-${f.request.candidate.runId}-1`).get()).data();
  const pointer = (await f.db.doc(`cmsPreviewPairCandidatePointers/${f.descriptor.pairId}`).get()).data();
  const writes = [...f.state.writes], requestCount = f.state.requests.length;
  f.state.healthLost = false;
  await expect(installPrivatePreviewPair(f.input)).rejects.toMatchObject({ uncertain: true });
  expect(f.state.writes).toEqual(writes);
  expect((await f.db.doc(`cmsDeploymentCandidates/renderer-${f.request.candidate.runId}-1`).get()).data()).toEqual(originalCandidate);
  expect(f.state.requests.slice(requestCount).some(r => r.path.endsWith("edge-preview"))).toBe(false);
  const fresh = { ...f.request, operationId: `preview-fresh-${sequence}`, expectedCandidatePointerDigest: preview.digest(pointer),
    candidate: { ...f.request.candidate, runId: String(1000 + sequence) } };
  const result = await qualifyPrivatePreviewPair({ ...f.input, request: fresh, resourceOperationId: f.request.operationId });
  expect(result.health.ready).toBe(true); expect(f.state.writes).toEqual(writes); await f.unchanged();
});
it("refuses prior resource ownership, disabled sealed config and pre-cancellation before any provider mutation", async () => {
  const f = await fixture(); f.state.identity = true;
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); expect(f.state.writes).toHaveLength(0);
  const off = await fixture({ rendererReady: false }); await expect(installPrivatePreviewPair(off.input)).rejects.toMatchObject({ code: "renderer-disabled-in-sealed-version" });
  expect(off.state.requests).toHaveLength(0);
  const cancelled = await fixture(), signal = AbortSignal.abort(); await expect(installPrivatePreviewPair({ ...cancelled.input, signal })).rejects.toThrow();
  expect(cancelled.state.requests).toHaveLength(0); await cancelled.unchanged();
});
it.each(["billing", "selector"])("refuses %s drift before the next boundary and preserves accepted legacy claims", async field => {
  const f = await fixture();
  f.state.beforeWrite = async action => {
    if (action === "identity") await f.db.doc(field === "billing" ? "system/billing" : preview.SELECTOR_PATH).update(field === "billing" ? { disabled: true } : { phase: "paused" });
  };
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); expect(f.state.writes).toEqual(["identity"]);
  expect((await f.db.doc("cmsPreviewQueue/11111111111111111111").get()).data().claimToken).toBe("synthetic-original-claim");
});
it("renews legacy runtime authority and qualification identity without changing original partial resource ownership", async () => {
  const f = await fixture(), planned = await installPrivatePreviewPair({ ...f.input, dryRun: true });
  f.state.beforeWrite = async action => {
    if (action === "deployment") await f.db.doc(preview.SELECTOR_PATH).update({ phase: "paused" });
  };
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow();
  expect(f.state.writes).toEqual(["identity", "version", "deployment"]);
  f.state.beforeWrite = async () => {};
  const newRoot = { ...f.root, rendererSha: "f".repeat(40) };
  await f.db.doc(preview.SELECTOR_PATH).set(newRoot);
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow();
  const fresh = { ...f.request, expectedRuntimeDigest: preview.digest(newRoot),
    candidate: { ...f.request.candidate, runId: String(2000 + sequence) } };
  const renewedPlan = await installPrivatePreviewPair({ ...f.input, request: fresh, dryRun: true });
  expect(renewedPlan.planDigest).toBe(planned.planDigest);
  const result = await installPrivatePreviewPair({ ...f.input, request: fresh });
  expect(f.state.writes).toEqual(["identity", "version", "deployment", "container", "schedule"]);
  expect(result.resource.planDigest).toBe(planned.planDigest);
  expect(result.qualification.health.ready).toBe(true);
  expect((await f.db.doc(preview.SELECTOR_PATH).get()).data()).toEqual(newRoot);
  expect((await f.db.doc("cmsPreviewQueue/11111111111111111111").get()).data().claimToken).toBe("synthetic-original-claim");
});
it("actual source drift or damaged immutable mutation receipts cannot obtain another health proof", async () => {
  const f = await fixture(); await installPrivatePreviewPair(f.input);
  f.state.corrupt = "bytes";
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); f.state.corrupt = null;
  const key = p.publicReleaseDigest({ worker: f.prepared.applicationName });
  await f.db.doc(`system/publicReleasePrivateInstalls/attempts/${f.request.operationId}/readbacks/${key}-version`).update({ "result.bundleDigest": "0".repeat(64) });
  await expect(qualifyPrivatePreviewPair({ ...f.input, resourceOperationId: f.request.operationId })).rejects.toThrow();
  expect(f.state.writes).toHaveLength(5); await f.unchanged();
});
it.each(["identity", "version", "deployment", "container", "schedule"])("cancellation during %s is preserved as the original uncertain attempt", async action => {
  const f = await fixture(), abort = new AbortController();
  f.state.beforeWrite = async current => { if (current === action) { abort.abort(); throw new Error("synthetic cancellation"); } };
  await expect(installPrivatePreviewPair({ ...f.input, signal: abort.signal })).rejects.toThrow();
  const sent = [...f.state.writes]; f.state.beforeWrite = async () => {};
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); expect(f.state.writes).toEqual(sent); await f.unchanged();
});
it.each(["FIREBASE_SERVICE_ACCOUNT", "R2_PREVIEW_CREDENTIAL", "CMS_EDGE_ORIGIN_SECRET"])("an unreadable %s stream releases only its confirmed unsent original step", async secretName => {
  const f = await fixture();
  const readSecret = name => { if (name === secretName) throw new Error("synthetic unreadable stream"); return "synthetic-binding"; };
  await expect(installPrivatePreviewPair({ ...f.input, readSecret })).rejects.toThrow();
  expect(f.state.writes).toEqual(["identity"]);
  const key = p.publicReleaseDigest({ worker: f.prepared.applicationName });
  expect((await f.db.doc(`system/publicReleasePrivateInstalls/attempts/${f.request.operationId}/steps/${key}-version`).get()).data().notSent).toBe(true);
  expect((await installPrivatePreviewPair(f.input)).qualification.health.ready).toBe(true);
  expect(f.state.writes).toEqual(["identity", "version", "deployment", "container", "schedule"]); await f.unchanged();
});
it("a token failure before upload dispatch can resume the same original grant after credentials recover", async () => {
  const f = await fixture(); let tokenUnavailable = false;
  const readSecret = name => { if (name === "CMS_EDGE_ORIGIN_SECRET") tokenUnavailable = true; return "synthetic-binding"; };
  const readToken = () => { if (tokenUnavailable) throw new Error("synthetic unreadable token"); return "synthetic-api"; };
  await expect(installPrivatePreviewPair({ ...f.input, readSecret, readToken })).rejects.toThrow();
  expect(f.state.writes).toEqual(["identity"]); tokenUnavailable = false;
  expect((await installPrivatePreviewPair({ ...f.input, readToken })).qualification.health.ready).toBe(true);
  expect(f.state.writes).toHaveLength(5); await f.unchanged();
});
it("unrelated account domains do not retag installed target identity, but exposing this Worker refuses", async () => {
  const f = await fixture(), original = await installPrivatePreviewPair(f.input);
  f.state.domains.push({ id: "0".repeat(32), service: "unrelated-worker" });
  expect(await installPrivatePreviewPair(f.input)).toEqual(original);
  f.state.domains.push({ id: "1".repeat(32), service: f.prepared.applicationName });
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); expect(f.state.writes).toHaveLength(5);
});
it("a name race with a foreign empty Worker cannot satisfy this operation's create receipt", async () => {
  const f = await fixture();
  f.state.beforeWrite = async action => {
    if (action === "identity") { f.state.identity = true; f.state.tags = ["private-preview:" + "0".repeat(64)]; throw new Error("synthetic name conflict"); }
  };
  await expect(installPrivatePreviewPair(f.input)).rejects.toThrow(); expect(f.state.writes).toEqual(["identity"]); await f.unchanged();
});
