import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { bridgeFixture } from "../helpers/cms-reader-bridge.js";
const require = createRequire(import.meta.url);
const { createCmsReaderMount } = require("../../functions/cms-reader-mount.js");
const { admin } = require("../../functions/lib/firebase.js");
const { AuthError, resetAuthTokenCache } = require("../../functions/lib/auth.js");
const { readCmsReaderMountDescriptor } = require("../../functions/lib/cms-reader-mount-descriptor.js");
const { readerIdentities } = require("../../functions/lib/cms-versioned-reader.js");
const api = require("../../functions/lib/cms-preview-pair.js");
const db = isolatedFirestore("cms-reader-mount");
const environment = { CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-install",
  CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-100-1", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-100-1" };
const actor = { uid: "staff", principal: { id: "staff", grants: [{ role: "admin" }] } };
const cmsApiVersion = "55555555-5555-4555-8555-555555555555";
let fixture;
function response() {
  return { statusCode: 0, headersSent: false, headers: {}, body: null,
    set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; } };
}
function request(body, headers = {}) {
  return { method: "POST", is: value => value === "application/json", headers: {
    "x-njpbs-cms-edge": "fixture-edge", ...headers,
  }, body };
}
async function invoke(body = { action: "describe", version: 1 }, extra = {}, headers = {}) {
  const handler = createCmsReaderMount({ firestore: db, version: 1, environment,
    authenticate: async () => actor, edge: { readSecret: () => "fixture-edge", logger: { warn() {}, error() {} } }, ...extra });
  const res = response(); await handler(request(body, headers), res); return res;
}
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
  fixture = bridgeFixture();
  fixture.request.readers.cmsApi.providerIdentities.versionId = cmsApiVersion;
  for (const component of ["functions", "cmsApi"]) {
    const reader = fixture.request.readers[component];
    const mutation = { sourceSha: reader.sourceSha, inputFingerprint: reader.inputFingerprint,
      configurationFingerprint: reader.configurationFingerprint, providerIdentities: reader.providerIdentities,
      runId: "100", runAttempt: 1, completedAt: reader.verifiedAt };
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation });
    await db.doc(`cmsDeploymentCandidates/${component}-100-1`).set({ schemaVersion: 2, component, state: "verified", mutation });
  }
});
it("describes only the two deployed reader digests from matching original complete receipts", async () => {
  const res = await invoke();
  expect(res.statusCode).toBe(200);
  const identities = readerIdentities(fixture.request.readers);
  expect(res.body).toEqual({ schemaVersion: 2, version: 1, operationId: "reader-install",
    functionsReader: identities.functions, cmsApiReader: identities.cmsApi, cmsApiVersion });
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(JSON.stringify(res.body)).not.toContain("deployed-v1");
});
it("defaults off and retains independent edge and fresh staff permission checks", async () => {
  expect((await invoke(undefined, { environment: {} })).statusCode).toBe(503);
  expect((await invoke(undefined, {}, { "x-njpbs-cms-edge": "wrong" })).statusCode).toBe(403);
  expect((await invoke(undefined, { authenticate: async () => ({ uid: "staff", principal: { id: "staff", grants: [] } }) })).statusCode).toBe(403);
  expect((await invoke(undefined, { authenticate: async () => { throw new Error("revoked"); } })).statusCode).toBe(503);
});
afterEach(() => { vi.restoreAllMocks(); resetAuthTokenCache(); });
// Only the Admin SDK is fake, so the mounted route runs the real authentication and edge wrapper.
it.each([
  ["auth/id-token-expired", { code: "session_expired", reason: "token_expired" }],
  ["auth/id-token-revoked", { code: "session_expired" }],
])("carries the typed session refusal for %s through the mounted preflight", async (code, expected) => {
  vi.spyOn(admin.auth(), "verifyIdToken").mockRejectedValue(Object.assign(new Error("Synthetic refusal"), { code }));
  const res = await invoke(undefined, { authenticate: undefined }, { authorization: "Bearer synthetic-refusal" });
  expect(res.statusCode).toBe(401);
  expect(res.body).toEqual({ error: "CMS reader unavailable", ...expected });
  expect(res.headers["cache-control"]).toBe("private, no-store");
});
it("keeps every other authentication failure as an unavailable reader", async () => {
  for (const failure of [new AuthError("Invalid App Check token", "app_check_failed"),
    Object.assign(new Error("Key service detail"), { status: 401 }),
    Object.assign(new Error("Key service detail"), { code: "session_expired" })]) {
    const res = await invoke(undefined, { authenticate: async () => { throw failure; } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "CMS reader unavailable" });
  }
});
it("refuses browser-origin descriptor requests and changed configuration before exposing metadata", async () => {
  expect((await invoke(undefined, {}, { origin: "https://admin.njpbs.org" })).statusCode).toBe(400);
  expect((await invoke({ version: 2, action: "describe" })).statusCode).toBe(400);
  expect((await invoke({ version: 1, action: "describe", operationId: "reader-other" })).statusCode).toBe(400);
  expect((await invoke(undefined, { environment: { ...environment, CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-200-1" } })).statusCode).toBe(503);
});
it("never substitutes pending, missing or mismatched component evidence", async () => {
  for (const change of [{ state: "pending" }, { "mutation.configurationFingerprint": "e".repeat(64) }, { "mutation.sourceSha": "e".repeat(40) }]) {
    const ref = db.doc("cmsDeploymentReceipts/functions"), previous = (await ref.get()).data();
    await ref.update(change);
    await expect(readCmsReaderMountDescriptor({ firestore: db, environment })).rejects.toThrow();
    await ref.set(previous);
  }
  await db.doc("cmsDeploymentCandidates/cmsApi-100-1").delete();
  expect((await invoke()).statusCode).toBe(503);
});
it("an installed proof retains its original readers through a later global deployment", async () => {
  const readers = fixture.request.readers;
  const proof = { schemaVersion: 2, operationId: "reader-install", requestDigest: api.digest(fixture.request),
    stateDigest: fixture.request.expectedStateDigest, readerIdentities: readerIdentities(readers), readers,
    results: ["functions", "cmsApi"].flatMap(component => fixture.request.cases.map(({ scope, version, feature, pairDigest, expected }) =>
      ({ component, scope, version, feature, pairDigest, ...expected }))), verifiedAt: readers.functions.verifiedAt };
  await db.doc("cmsReaderBridgeInstalledProofs/reader-install").set({ schemaVersion: 2, proof,
    readerDigests: { functions: api.digest(readers.functions), cmsApi: api.digest(readers.cmsApi) } });
  await db.doc("cmsDeploymentReceipts/functions").update({ "mutation.sourceSha": "e".repeat(40) });
  const descriptor = await readCmsReaderMountDescriptor({ firestore: db, environment });
  expect(descriptor.readers).toEqual(readers);
  expect((await invoke()).statusCode).toBe(200);
});
it("opens original nonrenewable leases through the mounted factory", async () => {
  const sessionIds = { functions: "11111111-1111-4111-8111-111111111111", cmsApi: "22222222-2222-4222-8222-222222222222" };
  const open = { version: 1, action: "open", sessionIds, ttlMs: 300000 };
  const stamp = { "x-njpbs-cms-reader": readerIdentities(fixture.request.readers).cmsApi };
  const first = await invoke(open, { now: () => 1000 }, stamp);
  expect(first.statusCode).toBe(200);
  expect((await invoke(open, { now: () => 2000 }, stamp)).body).toEqual(first.body);
  expect((await invoke(open, { now: () => 301000 }, stamp)).statusCode).toBe(410);
  expect((await db.doc(`cmsReaderSessions/${sessionIds.functions}`).get()).data().expiresAt).toBe(301000);
});

function idsFor(index) {
  const uuid = value => `${value.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
  return { functions: uuid(index * 2 + 1), cmsApi: uuid(index * 2 + 2) };
}
async function openPair(index, extra = {}, at = 1000, ttlMs = 300000) {
  return invoke({ version: 1, action: "open", sessionIds: idsFor(index), ttlMs },
    { now: () => at, ...extra }, { "x-njpbs-cms-reader": readerIdentities(fixture.request.readers).cmsApi });
}
const staffLeases = async () => (await db.collection("cmsReaderSessions").get()).docs
  .map(row => row.data()).filter(value => value.schemaVersion === 2 && value.principalId === "staff");
it("caps new issuance across both readers while preserving retry, expiry and other staff", async () => {
  let first;
  for (let index = 0; index < 16; index++) {
    const opened = await openPair(index);
    expect(opened.statusCode).toBe(200); first ??= opened.body;
  }
  const limited = await openPair(16);
  expect(limited.statusCode).toBe(429);
  expect(limited.headers["retry-after"]).toBe("900");
  expect(await staffLeases()).toHaveLength(32);
  expect((await openPair(0, {}, 2000)).body).toEqual(first);
  expect((await openPair(17, { authenticate: async () => ({ ...actor, uid: "other" }) })).statusCode).toBe(200);
  expect((await openPair(0, {}, 301000)).statusCode).toBe(410);
  expect((await openPair(16, {}, 301000)).statusCode).toBe(429);
  expect((await openPair(16, {}, 901000)).statusCode).toBe(200);
  expect((await db.doc(`cmsReaderSessions/${idsFor(0).functions}`).get()).data().expiresAt).toBe(301000);
});
it("concurrent new UUID pairs cannot pass the remaining principal session slots", async () => {
  for (let index = 0; index < 15; index++) expect((await openPair(index)).statusCode).toBe(200);
  const results = await Promise.all([openPair(15), openPair(16)]);
  expect(results.every(result => [200, 429].includes(result.statusCode))).toBe(true);
  expect(results.filter(result => result.statusCode === 200)).toHaveLength(1);
  expect(await staffLeases()).toHaveLength(32);
  expect((await openPair(17)).statusCode).toBe(429);
});
it("permits another tab after the issuance window while earlier 24-hour leases remain live", async () => {
  let original;
  for (let index = 0; index < 16; index++) {
    const reply = await openPair(index, {}, 1000, 86_400_000);
    expect(reply.statusCode).toBe(200); original ??= reply.body;
  }
  expect((await openPair(16, {}, 1001, 86_400_000)).statusCode).toBe(429);
  expect((await openPair(16, {}, 901000, 86_400_000)).statusCode).toBe(200);
  expect((await openPair(0, {}, 901000, 86_400_000)).body).toEqual(original);
  expect(await staffLeases()).toHaveLength(34);
});
it("a refused second reader creates neither a partial lease pair nor a principal quota row", async () => {
  const { closeReader } = require("../../functions/lib/cms-reader-session.js");
  await closeReader(db, readerIdentities(fixture.request.readers).cmsApi);
  expect((await openPair(0)).statusCode).toBe(503);
  expect((await db.collection("cmsReaderSessions").get()).empty).toBe(true);
});
