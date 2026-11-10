import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { bridgeFixture } from "../helpers/cms-reader-bridge.js";
import { pairReference, releaseSelector } from "../helpers/public-release-pair.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { pair, selector } from "../helpers/cms-preview-pairs.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
const require = createRequire(import.meta.url);
const { createCmsPairCurrentCodeMount } = require("../../functions/cms-reader-endpoints.js");
const db = isolatedFirestore("cms-reader-endpoints");
const environment = { CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-install",
  CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-100-1", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-100-1" };
function response() {
  return { statusCode: 0, headersSent: false, headers: {}, body: null,
    set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; } };
}
function request(headers = {}, body = {}) {
  return { method: "POST", is: value => value === "application/json", headers: {
    "x-njpbs-cms-edge": "fixture-edge", ...headers,
  }, body };
}
async function invoke({ config = environment, headers, body } = {}) {
  const handler = createCmsPairCurrentCodeMount({ firestore: db, environment: config,
    edge: { readSecret: () => "fixture-edge", logger: { warn() {}, error() {} } } });
  const res = response(); await handler(request(headers, body), res); return res;
}
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
});
afterEach(() => vi.unstubAllEnvs());
it.each(["cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2"])("deployed %s stays disabled and preserves direct-origin refusal", async name => {
  vi.stubEnv("CMS_READER_BRIDGE_ENABLED", "false");
  vi.stubEnv("CMS_EDGE_ORIGIN_SECRET", "fixture-edge");
  const endpoint = require("../../functions/index.js")[name];
  const disabled = response(); await endpoint(request(), disabled);
  expect(disabled.statusCode).toBe(503);
  const direct = response(); await endpoint(request({ "x-njpbs-cms-edge": "" }), direct);
  expect(direct.statusCode).toBe(403);
});
it("the private CODE mount refuses origins and oversized bodies before any descriptor read", async () => {
  expect((await invoke({ headers: { origin: "https://admin.njpbs.org" } })).statusCode).toBe(400);
  expect((await invoke({ body: { data: "x".repeat(8192) } })).statusCode).toBe(400);
  expect((await invoke({ config: {} })).statusCode).toBe(503);
});
it("the private CODE mount refuses missing original receipts without creating install evidence", async () => {
  const result = await invoke({ body: { mode: "current-code-v2" } });
  expect(result.statusCode).toBe(503);
  expect(result.body).toEqual({ error: "Private pair CODE unavailable" });
  expect((await db.doc("cmsReaderBridgeInstallAttempts/reader-install").get()).exists).toBe(false);
});
it("complete original descriptors serve only the sealed retained CODE and keep its authority checks", async () => {
  for (const [component, reader] of Object.entries(bridgeFixture().request.readers)) {
    const mutation = { sourceSha: reader.sourceSha, inputFingerprint: reader.inputFingerprint,
      configurationFingerprint: reader.configurationFingerprint, providerIdentities: reader.providerIdentities,
      runId: "100", runAttempt: 1, completedAt: reader.verifiedAt };
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation });
    await db.doc(`cmsDeploymentCandidates/${component}-100-1`).set({ schemaVersion: 2, component, state: "verified", mutation });
  }
  const p = require("../../functions/lib/public-release-pair.js");
  const work = require("../../functions/lib/public-release-pair-work.js");
  const history = require("../../functions/lib/public-release-historical-code.js");
  const old = releasePair(), next = releasePair("b", "b".repeat(40));
  const preview = pair("old", "c"), previewNew = pair("new", "d");
  const publicRoot = { ...releaseSelector(), selectedPair: pairReference(old), recoveryPair: pairReference(next),
    contentHead: { ...releaseSelector().contentHead, pairId: old.pairId } };
  await db.doc("system/publicDeployment").set(publicRoot);
  await db.doc("system/cmsPreviewRuntime").set(selector(preview, previewNew));
  await db.doc(`cmsPreviewPairs/${preview.pairId}`).set(preview);
  const base = work.publicReleasePairPath(old.pairId);
  await db.doc(base).set(old);
  const pack = { schemaVersion: 1, kind: "pair-code-pack-baseline", pairDigest: p.publicReleaseDigest(old), commitSha: old.commitSha,
    codeAssetManifestDigest: old.codeAssetManifestDigest, codePackManifestDigest: "9".repeat(64) };
  await db.doc(`${base}/codePacks/baseline`).set(pack);
  const qualified = publicReleaseBaselineCodeFixture(db, old.commitSha).qualified;
  const retained = history.prepareRetainedPublicReleaseCode(qualified);
  for (const chunk of retained.chunks) await db.doc(`${history.CHUNKS}/${chunk.digest}`).set(chunk.value);
  await db.doc(`${base}/codePacks/publication`).set({ schemaVersion: 2, kind: "pair-code-publication", pairDigest: p.publicReleaseDigest(old),
    baselineDigest: p.publicReleaseDigest(pack), codePackManifestDigest: pack.codePackManifestDigest, historicalCode: retained.descriptor,
    reference: { schemaVersion: 2, kind: "pair", side: pairReference(old), commitSha: old.commitSha,
      codeAssetManifestDigest: old.codeAssetManifestDigest, publicationDigest: "8".repeat(64) } });
  const body = { schemaVersion: 2, mode: "current-code-v2", rendererSha: preview.rendererSha,
    selection: { pair: pairReference(old), expectedPublicSelectorDigest: p.publicReleaseDigest(publicRoot),
      previewPairId: preview.pairId, previewCandidateReceiptId: null } };
  const result = await invoke({ body });
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(Buffer.from(result.body.qualifiedCodeBase64, "base64").toString())).toEqual(qualified);
  expect(result.body.reference.source.side).toEqual(pairReference(old));
  expect(result.headers["cache-control"]).toBe("private, no-store");
  await db.doc("system/publicDeployment").update({ epoch: 2 });
  expect((await invoke({ body })).statusCode).toBe(503);
});
