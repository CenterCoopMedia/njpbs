import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { bridgeFixture } from "../helpers/cms-reader-bridge.js";
import { pairReference, releaseSelector } from "../helpers/public-release-pair.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { candidate } from "../helpers/cms-preview-pairs.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import { createCmsReaderBridge } from "../../cms-api/src/cms-reader-bridge";
import { runBridgeOperator } from "../../scripts/install-cms-reader-bridge.mjs";
import { BRIDGE_ATTEMPTS, BRIDGE_PROOFS, createCmsReaderReplayTransport, dryRunCmsReaderBridge,
  proveCmsReaderBridge, installCmsReaderBridge, prepareInstalledCmsReaderConsumers,
  FIRST_INSTALL_STAGE, CONVERTED_STAGE, parseCmsReaderBridgeRequest,
} from "../../scripts/lib/cms-reader-bridge-install.mjs";
const require = createRequire(import.meta.url);
const api = require("../../functions/lib/cms-preview-pair.js");
const { createVersionedCmsReaderHandler, readerIdentities } = require("../../functions/lib/cms-versioned-reader.js");
const db = isolatedFirestore("cms-reader-bridge-install");
const actor = { uid: "staff", principal: { id: "staff", grants: [{ role: "admin" }] } };
let fixture: ReturnType<typeof bridgeFixture>, server: Server | undefined, networkCalls: number;
const readLiveState = async () => (await db.doc("system/bridgeFixtureAuthority").get()).data();
const assertStateInTransaction = async ({ transaction }: { transaction: any }) => api.digest((await transaction.get(db.doc("system/bridgeFixtureAuthority"))).data());
const readProviders = async () => Object.fromEntries(Object.entries(fixture.request.readers).map(([key, reader]) => [key, reader.providerIdentities]));
const common = () => ({ firestore: db, request: fixture.request, readLiveState, readProviders,
  readRetainedCases: async () => structuredClone(fixture.request.cases), assertStateInTransaction });
beforeEach(async () => {
  fixture = bridgeFixture(); networkCalls = 0;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/bridgeFixtureAuthority").set(fixture.state);
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
});
async function actualHttpTransport(codeEndpoint?: any) {
  const functions = Object.fromEntries([1, 2].map(version => {
    const endpoint = async (req: { body: { fixtureCase: string } }, res: any) => {
      const row = fixture.request.cases.find(row => row.body.fixtureCase === req.body.fixtureCase)!;
      return res.status(200).json({ fixtureCase: row.body.fixtureCase, immutableSource: row.sourcePairDigest ?? row.pairDigest });
    };
    return [version, createVersionedCmsReaderHandler({ firestore: db, readers: fixture.request.readers, version,
      handlers: { cmsGetPublicPage: endpoint, cmsGetPublishedSettings: endpoint, cmsPreviewStatus: endpoint, cmsReadPairCurrentCodeV2: codeEndpoint ?? endpoint },
      authenticate: async () => actor, edge: { readSecret: () => "fixture-edge", logger: { warn() {}, error() {} } } })];
  }));
  let origin: string;
  const direct: typeof fetch = (url, init) => fetch(`${origin}${new URL(String(url)).pathname}`, init);
  const gateway = createCmsReaderBridge({ targets: [1, 2].map(version => ({ version: version as 1 | 2,
    functionsUrl: `https://us-central1-njpbs-site.cloudfunctions.net/readerV${version}`,
    gatewayReaderDigest: readerIdentities(fixture.request.readers).cmsApi })), projectId: "njpbs-site",
    readEdgeSecret: () => "fixture-edge", verifyToken: async () => ({ uid: "staff" }), request: direct });
  server = createServer(async (incoming, outgoing) => {
    networkCalls++;
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks), path = incoming.url!;
      if (path.startsWith("/api/cms/")) {
        const response = await gateway(new Request(`https://api.example.org${path}`, { method: "POST",
          headers: incoming.headers as Record<string, string>, body: bytes }), {
          requestId: "33333333-3333-4333-8333-333333333333", clientIp: "203.0.113.9" });
        if (!response) throw new Error("Unknown fixture route");
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
      } else {
        const version = Number(path.at(-1));
        const req = { method: incoming.method, headers: incoming.headers, is: () => true, body: JSON.parse(bytes.toString()) };
        const res = { statusCode: 200, headersSent: false, set(key: string, value: string) { outgoing.setHeader(key, value); return res; },
          status(code: number) { res.statusCode = code; return res; }, json(value: unknown) {
            res.headersSent = true; outgoing.statusCode = res.statusCode; outgoing.setHeader("content-type", "application/json"); outgoing.end(JSON.stringify(value)); return res;
          } };
        await functions[version](req, res);
      }
    } catch { outgoing.writeHead(503); outgoing.end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture server");
  origin = `http://127.0.0.1:${address.port}`;
  return createCmsReaderReplayTransport({ projectId: db.projectId, targets: { functions: { 1: `${origin}/readerV1`, 2: `${origin}/readerV2` },
    cmsApi: { 1: `${origin}/api/cms/v1/reader`, 2: `${origin}/api/cms/v2/reader` } },
    readStaffToken: async () => "fixture-staff", readEdgeSecret: async () => "fixture-edge", allowLocalEmulator: true });
}
function receiptWriter() {
  return vi.fn(async (_db: any, input: any) => {
    const reader = fixture.request.readers[input.component as "functions" | "cmsApi"];
    const receipt = { schemaVersion: 2, component: input.component, state: "complete", lastComplete: reader };
    await db.doc(`${api.READER_RECEIPTS}/${input.component}`).set(receipt); return receipt;
  });
}
const candidates = { functions: { component: "functions" }, cmsApi: { component: "cmsApi" } };
it("keeps historical CLI readback independent of the adapter's current retained authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-historical-readback-"));
  try {
    const input = join(directory, "request.json"), bundle = join(directory, "adapter.mjs");
    const bytes = Buffer.from('export function openBridgeInstallAdapter() { throw new Error("Current authority must not reopen"); }');
    writeFileSync(input, JSON.stringify(fixture.request)); writeFileSync(bundle, bytes);
    const result = spawnSync(process.execPath, ["scripts/install-cms-reader-bridge.mjs", "readback", db.projectId, input, bundle,
      createHash("sha256").update(bytes).digest("hex")], { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "readback", operationId: fixture.request.operationId });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("malformed operator requests keep their request refusal code without reading any source", async () => {
  for (const request of [null, undefined, 1, "invalid", [], {},
    { ...fixture.request, stage: "unknown" }, { ...fixture.request, stage: CONVERTED_STAGE }]) {
    await expect(Promise.resolve().then(() => parseCmsReaderBridgeRequest(request)))
      .rejects.toMatchObject({ name: "CmsReaderBridgeError", code: "bridge-request-invalid" });
  }
  const proofs = require("../../functions/lib/cms-reader-bridge-proof.js");
  for (const proof of [null, undefined]) expect(() => proofs.parseInstalledCmsReaderProof({ schemaVersion: 2, proof,
    readerDigests: {} }, fixture.request.operationId)).toThrow("Installed CMS reader proof is unavailable");
  expect(networkCalls).toBe(0); expect((await db.collection(BRIDGE_ATTEMPTS).get()).empty).toBe(true);
});
it("dry-run is read-only and refuses an incomplete roster or moved authority", async () => {
  const result = await dryRunCmsReaderBridge(common()); expect(result).toMatchObject({ writes: 0, cases: 36, httpAttempts: 76 });
  expect((await db.collection(BRIDGE_ATTEMPTS).get()).empty).toBe(true);
  await expect(dryRunCmsReaderBridge({ ...common(), request: { ...fixture.request, cases: fixture.request.cases.slice(1) } })).rejects.toThrow();
  await expect(dryRunCmsReaderBridge({ ...common(), request: { ...fixture.request, cases: fixture.request.cases.map(row => ({ ...row,
    expected: { ...row.expected, status: 404 } })) } })).rejects.toThrow();
  await db.doc("system/bridgeFixtureAuthority").update({ publicSelectorDigest: "0".repeat(64) });
  await expect(dryRunCmsReaderBridge(common())).rejects.toThrow(); expect(networkCalls).toBe(0);
});
it("replays both actual HTTP paths on both envelope versions over the exhaustive retained request roster, then installs through the owned receipt seam", async () => {
  const proof = await proveCmsReaderBridge({ ...common(), transport: await actualHttpTransport() });
  expect(proof.results).toHaveLength(72);
  expect((await db.doc(`${BRIDGE_ATTEMPTS}/${fixture.request.operationId}`).get()).data()!.state).toBe("complete");
  const commitReader = receiptWriter();
  const record = await installCmsReaderBridge({ ...common(), commitReader, candidates });
  expect(commitReader).toHaveBeenCalledTimes(2);
  expect((await db.doc(`${BRIDGE_PROOFS}/${fixture.request.operationId}`).get()).data()).toEqual(record);
  const before = networkCalls;
  expect(await proveCmsReaderBridge({ ...common(), transport: async () => { throw new Error("Retry made a network call"); } })).toEqual(proof);
  // Completed retries read their original result even after later authority.
  await db.doc("system/bridgeFixtureAuthority").update({ publicSelectorDigest: "0".repeat(64) });
  expect(await installCmsReaderBridge({ ...common(), commitReader, candidates, now: () => Date.now() + 600_000 })).toEqual(record);
  expect(commitReader).toHaveBeenCalledTimes(2); expect(networkCalls).toBe(before);
});
it("reserves an uncertain attempt before HTTP and never repeats a lost session response or logs its error", async () => {
  const real = await actualHttpTransport(); let calls = 0;
  const transport = async (input: any) => { calls++; await real(input); throw new Error("private fixture response must not be recorded"); };
  await expect(proveCmsReaderBridge({ ...common(), transport })).rejects.toMatchObject({ code: "bridge-attempt-uncertain" });
  await expect(proveCmsReaderBridge({ ...common(), transport })).rejects.toMatchObject({ code: "bridge-attempt-uncertain" });
  expect(calls).toBe(1);
  const attempt = (await db.doc(`${BRIDGE_ATTEMPTS}/${fixture.request.operationId}`).get()).data();
  expect(JSON.stringify(attempt)).not.toContain("private fixture response"); expect(attempt!.state).toBe("uncertain");
  fixture.request = { ...fixture.request, operationId: "reader-recover-lost" };
  await proveCmsReaderBridge({ ...common(), transport: real });
  const record = await installCmsReaderBridge({ ...common(), commitReader: receiptWriter(), candidates });
  const { cmsReaderBridgeProofKey } = require("../../functions/lib/cms-reader-bridge-proof.js");
  expect((await db.doc(`${BRIDGE_PROOFS}/${cmsReaderBridgeProofKey(fixture.request.readers)}`).get()).data()).toEqual(record);
});
it.each(["fixture", "provider", "bytes"])("refuses a changed %s instead of recording compatibility", async kind => {
  const real = await actualHttpTransport();
  const changes = kind === "fixture" ? { readRetainedCases: async () => [] } : kind === "provider"
    ? { readProviders: async () => ({ functions: { deploymentId: "changed" }, cmsApi: fixture.request.readers.cmsApi.providerIdentities }) }
    : { transport: async (input: any) => { const result = await real(input); return input.envelope.action === "request"
      ? { ...result, bytes: Buffer.from("{}") } : result; } };
  await expect(proveCmsReaderBridge({ ...common(), transport: real, ...changes })).rejects.toThrow();
  expect((await db.collection(BRIDGE_PROOFS).get()).empty).toBe(true);
  expect((await db.collection(api.READER_RECEIPTS).get()).empty).toBe(true);
});
it("the installed-consumer guard rechecks receipts and live authority in the caller's original transaction", async () => {
  await proveCmsReaderBridge({ ...common(), transport: await actualHttpTransport() });
  await installCmsReaderBridge({ ...common(), commitReader: receiptWriter(), candidates });
  const guard = await prepareInstalledCmsReaderConsumers({ firestore: db, operationId: fixture.request.operationId, readProviders, assertStateInTransaction });
  expect(await db.runTransaction(transaction => guard.assertCurrentInTransaction({ transaction }), { readOnly: true })).toBe(guard.digest);
  await db.doc("system/bridgeFixtureAuthority").update({ publicSelectorDigest: "0".repeat(64) });
  await expect(db.runTransaction(transaction => guard.assertCurrentInTransaction({ transaction }), { readOnly: true })).rejects.toThrow();
});
it("the actual explicit operator dry-runs demo authority with verified adapter bytes and rejects a changed bundle without printing private inputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-operator-"));
  try {
    const requestPath = join(directory, "request.json"), adapterPath = join(directory, "adapter.mjs");
    writeFileSync(requestPath, JSON.stringify(fixture.request), { mode: 0o600 });
    const adapter = 'export async function openBridgeInstallAdapter({firestore}) {return {readLiveState:async()=>(await firestore.doc("system/bridgeFixtureAuthority").get()).data()};}';
    writeFileSync(adapterPath, adapter, { mode: 0o600 });
    const digest = createHash("sha256").update(adapter).digest("hex");
    const args = ["scripts/install-cms-reader-bridge.mjs", "dry-run", db.projectId, requestPath, adapterPath, digest];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "dry-run", cases: 36, writes: 0 });
    expect(result.stdout).not.toContain("fixtureCase"); expect(result.stdout).not.toContain("providerIdentities");
    writeFileSync(adapterPath, "throw new Error('private fixture input must not print')");
    const refused = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 });
    expect(refused.status).toBe(1); expect(refused.stderr).toContain("bridge-operation-refused");
    expect(refused.stderr).not.toContain("private fixture input");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("the real install command uses the owned candidate/legacy/provider CAS instead of a replacement writer", async () => {
  const owned = await import("../../scripts/lib/cms-component-receipt.mjs");
  const attempts: Record<string, unknown> = {};
  for (const component of ["functions", "cmsApi"] as const) {
    const reader = fixture.request.readers[component];
    const input = { component, sourceSha: reader.sourceSha, trustedWorkflowSha: "e".repeat(40), runId: "100", runAttempt: 1,
      inputFingerprint: reader.inputFingerprint, configurationFingerprint: reader.configurationFingerprint };
    await owned.startCandidateReceipt(db, input);
    const candidate = await owned.verifyCandidateReceipt(db, input, { collect: async () => reader.providerIdentities });
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation: candidate.mutation });
    attempts[component] = input;
  }
  await proveCmsReaderBridge({ ...common(), transport: await actualHttpTransport() });
  const record = await runBridgeOperator({ command: "install", firestore: db, request: fixture.request,
    adapter: { ...common(), candidates: attempts } });
  expect(record.proof.requestDigest).toBe(api.digest(fixture.request));
  for (const component of ["functions", "cmsApi"]) {
    const saved = (await db.doc(`${api.READER_RECEIPTS}/${component}`).get()).data();
    expect(api.currentReader(saved, component).supported).toEqual(fixture.request.readers[component].supported);
  }
});
it("an expired uninstalled proof recovers under a new explicit attempt and retains the same stable reader binding on later refresh", async () => {
  const transport = await actualHttpTransport(), commitReader = receiptWriter();
  await proveCmsReaderBridge({ ...common(), transport });
  await expect(installCmsReaderBridge({ ...common(), commitReader, candidates, now: () => Date.now() + 300_001 })).rejects.toMatchObject({ code: "bridge-proof-unavailable-or-expired" });
  expect(commitReader).not.toHaveBeenCalled();
  fixture.request = { ...fixture.request, operationId: "reader-recover-expired" };
  await proveCmsReaderBridge({ ...common(), transport });
  const original = await installCmsReaderBridge({ ...common(), commitReader, candidates });
  fixture.request = { ...fixture.request, operationId: "reader-refresh" };
  await proveCmsReaderBridge({ ...common(), transport });
  const refreshed = await installCmsReaderBridge({ ...common(), commitReader, candidates });
  expect(refreshed.proof.operationId).toBe("reader-refresh");
  const { cmsReaderBridgeProofKey } = require("../../functions/lib/cms-reader-bridge-proof.js");
  expect((await db.doc(`${BRIDGE_PROOFS}/${cmsReaderBridgeProofKey(fixture.request.readers)}`).get()).data()).toEqual(original);
});

// Stage A exercises the real sealed CODE owner and real SDK sessions through
// both HTTP paths. Other endpoint bodies below are explicit protocol fixtures,
// not the missing production retained-source adapter or a fabricated queue.
async function firstInstallFixture() {
  const p = require("../../functions/lib/public-release-pair.js");
  const work = require("../../functions/lib/public-release-pair-work.js");
  const history = require("../../functions/lib/public-release-historical-code.js");
  const preview = require("../../functions/lib/cms-preview-pair-candidate.js");
  const code = require("../../functions/lib/pair-current-code-source.js");
  const { initialPublicDeploymentPointer } = require("../../functions/lib/public-deployment.js");
  const old = releasePair(), next = releasePair("b", "b".repeat(40));
  const legacy = { ...initialPublicDeploymentPointer(), activeGeneration: 1, activeDeploymentId: "old-release",
    activeCommitSha: old.commitSha, lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "old-release" };
  const legacyDigest = p.publicReleaseDigest(legacy), [previewOld, previewNew] = fixture.state.previewPairs;
  const runtime = { schemaVersion: 1, phase: "ready", rendererSha: previewOld.rendererSha, serializerId: "legacy" };
  await db.doc("system/publicDeployment").set(legacy);
  await db.doc("system/cmsPreviewRuntime").set(runtime);
  for (const consumer of fixture.state.previewPairs) await db.doc(`cmsPreviewPairs/${consumer.pairId}`).set(consumer);
  for (const component of ["functions", "cmsApi"] as const) await db.doc(`cmsDeploymentReceipts/${component}`).set({
    schemaVersion: 1, component, state: "complete", mutation: fixture.request.readers[component] });
  const verified = candidate(previewNew);
  Object.assign(verified.mutation.providerIdentities, { applicationId: "fixture-app", workerDeploymentId: "fixture-deploy" });
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(verified);
  await preview.recordPreviewPairCandidatePointer({ firestore: db, request: { operationId: "preview-stage-a-code",
    pairId: previewNew.pairId, candidateReceiptId: "renderer-100-1", expectedPointerDigest: null,
    expectedRuntimeDigest: api.digest(preview.previewRuntimeIdentity(runtime)), bootstrapPublicPair: pairReference(old) } });
  for (const source of [old, next]) {
    const path = work.publicReleasePairPath(source.pairId);
    await db.doc(path).set(source);
    const baseline = { schemaVersion: 1, kind: "pair-code-pack-baseline", pairDigest: p.publicReleaseDigest(source), commitSha: source.commitSha,
      codeAssetManifestDigest: source.codeAssetManifestDigest, codePackManifestDigest: "9".repeat(64) };
    await db.doc(`${path}/codePacks/baseline`).set(baseline);
    const retained = history.prepareRetainedPublicReleaseCode(publicReleaseBaselineCodeFixture(db, source.commitSha).qualified);
    for (const chunk of retained.chunks) await db.doc(`${history.CHUNKS}/${chunk.digest}`).set(chunk.value);
    await db.doc(`${path}/codePacks/publication`).set({ schemaVersion: 2, kind: "pair-code-publication", pairDigest: p.publicReleaseDigest(source),
      baselineDigest: p.publicReleaseDigest(baseline), codePackManifestDigest: baseline.codePackManifestDigest, historicalCode: retained.descriptor,
      reference: { schemaVersion: 2, kind: "pair", side: pairReference(source), commitSha: source.commitSha,
        codeAssetManifestDigest: source.codeAssetManifestDigest, publicationDigest: "8".repeat(64) } });
  }
  const state = { ...fixture.state, publicSelectorDigest: legacyDigest, publicPairs: [old, next].map(source => ({
    pairDigest: p.publicReleaseDigest(source), pair: pairReference(source), requirements: previewOld.requirements })) };
  const consumerDigests = { publicOld: state.publicPairs[0].pairDigest, publicNew: state.publicPairs[1].pairDigest,
    previewOld: api.digest(previewOld), previewNew: api.digest(previewNew) };
  const cases: any[] = [], refusals: any[] = [];
  const prerequisite = await require("../../functions/lib/cms-reader-first-install-code-source.js").prepareFirstInstallPreviewCodeSource({
    firestore: db, deployedReaders: fixture.request.readers,
    consumer: { previewPairId: previewNew.pairId, rendererSha: previewNew.rendererSha, workerVersion: previewNew.workerVersion } });
  for (const original of fixture.request.cases) {
    const refusal = original.scope === "publicNew";
    if (refusal && original.feature !== "publicCode") continue;
    const row: any = { ...structuredClone(original), pairDigest: consumerDigests[original.scope as keyof typeof consumerDigests],
      sourcePairDigest: state.publicPairs[refusal ? 1 : 0].pairDigest };
    if (row.feature === "publicCode") {
      const consumer = row.scope === "previewNew" ? previewNew : previewOld;
      row.body = row.scope === "previewNew" ? structuredClone(prerequisite.evidence.code.request) : { schemaVersion: 2, mode: "current-code-v2",
        rendererSha: consumer.rendererSha, selection: { pair: pairReference(refusal ? next : old), expectedPublicSelectorDigest: legacyDigest,
          previewPairId: consumer.pairId, previewCandidateReceiptId: null } };
      row.expected = refusal ? { status: 503, contentType: "application/json",
        bodyDigest: createHash("sha256").update('{"error":"Private pair CODE unavailable"}').digest("hex") }
        : (await code.readPairCodeReplaySource({ firestore: db, deployedReaders: fixture.request.readers, request: row.body })).expected;
    } else row.expected.bodyDigest = createHash("sha256").update(JSON.stringify({ fixtureCase: row.body.fixtureCase, immutableSource: row.sourcePairDigest })).digest("hex");
    (refusal ? refusals : cases).push(row);
  }
  const request: any = { ...fixture.request, stage: FIRST_INSTALL_STAGE, legacyPublicSelectorDigest: legacyDigest,
    expectedStateDigest: api.digest(state), cases, refusals };
  fixture.state = state; fixture.request = request;
  await db.doc("system/bridgeFixtureAuthority").set(state);
  // Capture the independent source oracle before any caller mutation or HTTP.
  const oracle = structuredClone({ cases, refusals });
  return { request, state, legacy, old, next, prerequisite,
    options: { ...common(), readRetainedCases: async () => structuredClone(oracle),
      assertStateInTransaction: async (input: any) => {
        await prerequisite.assertCurrentInTransaction(input);
        return assertStateInTransaction(input);
      } },
    endpoint: require("../../functions/pair-current-code.js").createPairCurrentCodeHandler({ firestore: db, readers: fixture.request.readers,
      edge: { readSecret: () => "fixture-edge", logger: { warn() {}, error() {} } } }) };
}
it("Stage A requires three complete consumer scopes and two separate exact public NEW refusals", async () => {
  const stage = await firstInstallFixture();
  expect(await dryRunCmsReaderBridge(stage.options)).toMatchObject({ stage: FIRST_INSTALL_STAGE, cases: 28, refusals: 2, httpAttempts: 64, writes: 0 });
  for (const request of [
    { ...stage.request, refusals: [] },
    { ...stage.request, cases: [...stage.request.cases, stage.request.refusals[0]] },
    { ...stage.request, refusals: stage.request.refusals.map((row: any) => ({ ...row, expected: { ...row.expected, status: 200 } })) },
    { ...stage.request, cases: stage.request.cases.map((row: any) => row.scope === "previewNew" ? { ...row, sourcePairDigest: row.pairDigest } : row) },
    { ...stage.request, cases: stage.request.cases.map((row: any) => row.scope === "previewNew" && row.feature === "publicCode"
      ? { ...row, body: { ...row.body, selection: { ...row.body.selection, pair: pairReference(stage.next) } } } : row) },
  ]) await expect(dryRunCmsReaderBridge({ ...stage.options, request })).rejects.toThrow();
  expect(networkCalls).toBe(0); expect((await db.collection(BRIDGE_ATTEMPTS).get()).empty).toBe(true);
  const directory = mkdtempSync(join(tmpdir(), "reader-stage-a-"));
  try {
    const requestPath = join(directory, "request.json"), adapterPath = join(directory, "adapter.mjs");
    writeFileSync(requestPath, JSON.stringify(stage.request), { mode: 0o600 });
    const adapter = 'export async function openBridgeInstallAdapter({firestore}) {return {readLiveState:async()=>(await firestore.doc("system/bridgeFixtureAuthority").get()).data()};}';
    writeFileSync(adapterPath, adapter, { mode: 0o600 });
    const result = spawnSync(process.execPath, ["scripts/install-cms-reader-bridge.mjs", "dry-run", db.projectId, requestPath, adapterPath,
      createHash("sha256").update(adapter).digest("hex")], { encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stage: FIRST_INSTALL_STAGE, cases: 28, refusals: 2, httpAttempts: 64, writes: 0 });
    expect(result.stdout).not.toContain("sourcePairDigest");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("Stage A installs real legacy CODE replay with public NEW refusal and cannot satisfy a Stage B guard or identity", async () => {
  const stage = await firstInstallFixture(), transport = await actualHttpTransport(stage.endpoint);
  const proof = await proveCmsReaderBridge({ ...stage.options, transport });
  expect(proof.stage).toBe(FIRST_INSTALL_STAGE); expect(proof.results).toHaveLength(56); expect(proof.refusals).toHaveLength(4);
  expect(proof.results.some((row: any) => row.scope === "publicNew")).toBe(false);
  expect(proof.refusals.every((row: any) => row.scope === "publicNew" && row.status === 503 && row.pairDigest === row.sourcePairDigest)).toBe(true);
  expect(proof.results.filter((row: any) => row.scope === "previewNew").every((row: any) =>
    row.pairDigest === api.digest(stage.state.previewPairs[1]) && row.sourcePairDigest === stage.state.publicPairs[0].pairDigest)).toBe(true);
  const owned = await import("../../scripts/lib/cms-component-receipt.mjs"), attempts: Record<string, unknown> = {};
  for (const component of ["functions", "cmsApi"] as const) {
    const reader = stage.request.readers[component];
    const input = { component, sourceSha: reader.sourceSha, trustedWorkflowSha: "e".repeat(40), runId: "100", runAttempt: 1,
      inputFingerprint: reader.inputFingerprint, configurationFingerprint: reader.configurationFingerprint };
    await owned.startCandidateReceipt(db, input);
    const verified = await owned.verifyCandidateReceipt(db, input, { collect: async () => reader.providerIdentities });
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation: verified.mutation });
    attempts[component] = input;
  }
  const record = await runBridgeOperator({ command: "install", firestore: db, request: stage.request,
    adapter: { ...stage.options, candidates: attempts } });
  const { readCmsReaderMountDescriptor } = require("../../functions/lib/cms-reader-mount-descriptor.js");
  const mountIdentity = () => readCmsReaderMountDescriptor({ firestore: db, environment: {
    CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: stage.request.operationId,
    CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-100-1", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-100-1",
  } });
  expect(await mountIdentity()).toMatchObject({ operationId: stage.request.operationId, identities: proof.readerIdentities });
  const proofs = require("../../functions/lib/cms-reader-bridge-proof.js");
  expect(() => proofs.parseInstalledCmsReaderProof(record, stage.request.operationId)).toThrow();
  expect(proofs.parseInstalledCmsReaderProof(record, stage.request.operationId, { stage: FIRST_INSTALL_STAGE })).toEqual(record);
  const aKey = proofs.cmsReaderBridgeProofKey(stage.request.readers, FIRST_INSTALL_STAGE), bKey = proofs.cmsReaderBridgeProofKey(stage.request.readers);
  expect(aKey).not.toBe(bKey); expect((await db.doc(`${BRIDGE_PROOFS}/${bKey}`).get()).exists).toBe(false);
  expect((await db.doc(`${BRIDGE_PROOFS}/${aKey}`).get()).data()).toEqual(record);
  const consumerOptions = { firestore: db, operationId: stage.request.operationId, readProviders,
    assertStateInTransaction: stage.options.assertStateInTransaction };
  await expect(prepareInstalledCmsReaderConsumers(consumerOptions)).rejects.toThrow();
  await expect(prepareInstalledCmsReaderConsumers({ ...consumerOptions, stage: CONVERTED_STAGE })).rejects.toThrow();
  // Serving and switch consumers use the strict B parser/guard, even if an A
  // proof is copied under B's identity key. The private mount above reads only
  // the original identity; it cannot turn that receipt into B authority.
  const servingSource = { firestore: db, deployedReaders: stage.request.readers,
    request: stage.request.cases.find((row: any) => row.scope === "publicOld" && row.feature === "publicCode").body };
  const { readPairCodeReplaySource } = require("../../functions/lib/pair-current-code-source.js");
  expect((await readPairCodeReplaySource(servingSource)).source.pairDigest).toBe(stage.state.publicPairs[0].pairDigest);
  await db.doc(`${BRIDGE_PROOFS}/${bKey}`).set(record);
  await expect(readPairCodeReplaySource(servingSource)).rejects.toThrow("Installed CMS reader proof is unavailable");
  await db.doc(`${BRIDGE_PROOFS}/${bKey}`).delete();
  const guard = await prepareInstalledCmsReaderConsumers({ ...consumerOptions, stage: FIRST_INSTALL_STAGE });
  expect(guard.stage).toBe(FIRST_INSTALL_STAGE);
  expect(await db.runTransaction(transaction => guard.assertCurrentInTransaction({ transaction }), { readOnly: true })).toBe(guard.digest);
  // Closure inventories Stage A's windows, but still requires Stage B's live identity.
  await expect(db.runTransaction(transaction => require("../../functions/lib/cms-reader-session.js")
    .prepareRecoveryReaderFenceInTransaction({ firestore: db, transaction }), { readOnly: true }))
    .rejects.toThrow("Closure-aware deployed CMS readers are required");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(stage.legacy);
  expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  const before = networkCalls;
  expect(await proveCmsReaderBridge({ ...stage.options, transport })).toEqual(proof);
  expect(await installCmsReaderBridge({ ...stage.options, commitReader: receiptWriter(), candidates })).toEqual(record);
  expect(networkCalls).toBe(before);
  expect((await runBridgeOperator({ command: "readback", firestore: db, request: stage.request, adapter: {} })).installed).toEqual(record);
  await expect(runBridgeOperator({ command: "readback", firestore: db, request: bridgeFixture().request, adapter: {} }))
    .rejects.toMatchObject({ code: "bridge-operation-conflict" });
  await db.doc("system/publicDeployment").set(releaseSelector());
  await expect(db.runTransaction(transaction => guard.assertCurrentInTransaction({ transaction }), { readOnly: true })).rejects.toThrow();
  // The immutable reader identity remains usable for private Stage B probes;
  // Stage A still cannot satisfy the converted consumer or public switch gate.
  expect((await mountIdentity()).identities).toEqual(proof.readerIdentities);
  // The operation cannot change stage. Stage B retains its original full roster.
  const converted = bridgeFixture();
  await db.doc("system/bridgeFixtureAuthority").set(converted.state); fixture = converted;
  await expect(proveCmsReaderBridge({ ...common(), transport })).rejects.toMatchObject({ code: "bridge-operation-conflict" });
  fixture.request.operationId = "reader-stage-b";
  server!.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
  await proveCmsReaderBridge({ ...common(), transport: await actualHttpTransport() });
  const stageB = await installCmsReaderBridge({ ...common(), commitReader: receiptWriter(), candidates });
  expect(stageB.proof.results).toHaveLength(72); expect(stageB.proof).not.toHaveProperty("stage");
  expect(proofs.parseInstalledCmsReaderProof(stageB, fixture.request.operationId)).toEqual(stageB);
  const convertedGuard = await prepareInstalledCmsReaderConsumers({ firestore: db, operationId: fixture.request.operationId,
    readProviders, assertStateInTransaction });
  expect(convertedGuard.stage).toBe(CONVERTED_STAGE);
  expect(await db.runTransaction(transaction => convertedGuard.assertCurrentInTransaction({ transaction }), { readOnly: true })).toBe(convertedGuard.digest);
  expect((await db.doc(`${BRIDGE_PROOFS}/${aKey}`).get()).data()).toEqual(record);
});
it.each(["status", "bytes"])("Stage A refuses a different public NEW %s, never recording a retained success", async kind => {
  const stage = await firstInstallFixture(), real = await actualHttpTransport(stage.endpoint);
  const transport = async (input: any) => {
    const reply = await real(input);
    return input.envelope.action === "request" && input.envelope.body.selection?.pair.pairId === stage.next.pairId
      ? { ...reply, ...(kind === "status" ? { status: 200 } : { bytes: Buffer.from('{"error":"Other refusal"}') }) } : reply;
  };
  await expect(proveCmsReaderBridge({ ...stage.options, transport })).rejects.toMatchObject({ code: "bridge-replay-mismatch" });
  expect((await db.collection(BRIDGE_PROOFS).get()).empty).toBe(true);
});
it("Stage A checks the actual legacy root before HTTP, after replay and in the installation transaction", async () => {
  const stage = await firstInstallFixture(), transport = await actualHttpTransport(stage.endpoint);
  await db.doc("system/publicDeployment").set(releaseSelector());
  await expect(proveCmsReaderBridge({ ...stage.options, transport })).rejects.toMatchObject({ code: "bridge-first-install-root-changed" });
  expect(networkCalls).toBe(0);
  await db.doc("system/publicDeployment").set(stage.legacy);
  let reads = 0;
  await expect(proveCmsReaderBridge({ ...stage.options, transport, readProviders: async () => {
    if (++reads === 2) await db.doc("system/publicDeployment").set(releaseSelector());
    return readProviders();
  } })).rejects.toMatchObject({ code: "bridge-first-install-root-changed" });
  expect((await db.collection(BRIDGE_PROOFS).get()).empty).toBe(true);
  stage.request.operationId = "reader-stage-a-install";
  await db.doc("system/publicDeployment").set(stage.legacy);
  await proveCmsReaderBridge({ ...stage.options, request: stage.request, transport });
  const commit = receiptWriter();
  await expect(installCmsReaderBridge({ ...stage.options, request: stage.request, candidates, commitReader: async (firestore: any, input: any) => {
    const receipt = await commit(firestore, input);
    if (input.component === "cmsApi") await db.doc("system/publicDeployment").set(releaseSelector());
    return receipt;
  } })).rejects.toMatchObject({ code: "bridge-first-install-root-changed" });
  expect((await db.collection(BRIDGE_PROOFS).get()).empty).toBe(true);
});
it("Stage A does not accept request-derived retained cases without the separate original refusal evidence", async () => {
  const stage = await firstInstallFixture();
  await expect(proveCmsReaderBridge({ ...stage.options, transport: await actualHttpTransport(stage.endpoint),
    readRetainedCases: async () => stage.request.cases })).rejects.toMatchObject({ code: "bridge-retained-cases-mismatch" });
  expect(networkCalls).toBe(0); expect((await db.collection(BRIDGE_ATTEMPTS).get()).empty).toBe(true);
  expect((await dryRunCmsReaderBridge(common())).stage).toBe(FIRST_INSTALL_STAGE);
  const converted = bridgeFixture(); fixture = converted;
  await db.doc("system/bridgeFixtureAuthority").set(converted.state);
  expect((await dryRunCmsReaderBridge(common())).stage).toBe(CONVERTED_STAGE);
});
it("Stage A repeats the original candidate pointer guard in the installer SDK transaction", async () => {
  const stage = await firstInstallFixture();
  await proveCmsReaderBridge({ ...stage.options, transport: await actualHttpTransport(stage.endpoint) });
  await db.doc(`cmsPreviewPairCandidatePointers/${stage.state.previewPairs[1].pairId}`).update({ bootstrapPublicPair: pairReference(stage.next) });
  await expect(installCmsReaderBridge({ ...stage.options, commitReader: receiptWriter(), candidates })).rejects.toThrow();
  expect((await db.collection(BRIDGE_PROOFS).get()).empty).toBe(true);
});
