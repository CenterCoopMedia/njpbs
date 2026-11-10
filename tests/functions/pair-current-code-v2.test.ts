import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { pairReference, releaseSelector } from "../helpers/public-release-pair.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { pair, reader, selector, candidate } from "../helpers/cms-preview-pairs.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import { bodyDigest, bridgeFixture } from "../helpers/cms-reader-bridge.js";
import { handlePrivateRecordCode } from "../../cms-api/src/record-code";
import { handlePairRecordCode } from "../../cms-api/src/record-code-v2";
const require = createRequire(import.meta.url);
const p = require("../../functions/lib/public-release-pair.js");
const cms = require("../../functions/lib/cms-preview-pair.js");
const work = require("../../functions/lib/public-release-pair-work.js");
const history = require("../../functions/lib/public-release-historical-code.js");
const { createCurrentCodeTransport } = require("../../functions/lib/current-public-code-source.js");
const { readPairCurrentCode, readPairCodeReplaySource } = require("../../functions/lib/pair-current-code-source.js");
const { prepareFirstInstallPreviewCodeSource } = require("../../functions/lib/cms-reader-first-install-code-source.js");
const { createPairCurrentCodeHandler } = require("../../functions/pair-current-code.js");
const { publicationTarget } = require("../../functions/lib/publication-target.js");
const editorial = require("../../functions/lib/cms-pair-editorial-context.js");
const { readPairCurrentEditorial } = require("../../functions/lib/pair-current-editorial-source.js");
const db = isolatedFirestore("pair-current-code-v2");
const old = releasePair(), next = releasePair("b", "b".repeat(40));
const previewOld = pair("old", "c"), previewNew = pair("new", "d");
let publicRoot: ReturnType<typeof releaseSelector>;
let server: Server | undefined;
const originals = new Map<string, unknown>();
const selection = (source = old, preview = previewOld) => ({ pair: pairReference(source),
  expectedPublicSelectorDigest: p.publicReleaseDigest(publicRoot), previewPairId: preview.pairId, previewCandidateReceiptId: null });
const request = (source = old, preview = previewOld, mode = "current-code-v2") => ({ schemaVersion: 2, mode,
  rendererSha: preview.rendererSha, selection: selection(source, preview) });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  publicRoot = { ...releaseSelector(), selectedPair: pairReference(old), recoveryPair: pairReference(next),
    contentHead: { ...releaseSelector().contentHead, pairId: old.pairId } }; originals.clear();
  await db.doc("system/publicDeployment").set(publicRoot);
  await db.doc("system/cmsPreviewRuntime").set(selector(previewOld, previewNew));
  for (const preview of [previewOld, previewNew]) await db.doc(`cmsPreviewPairs/${preview.pairId}`).set(preview);
  for (const component of ["functions", "cmsApi"]) await db.doc(`cmsReaderCompatibilityReceipts/${component}`).set({ schemaVersion: 2,
    component, state: "complete", lastComplete: reader(component) });
  for (const source of [old, next]) {
    const base = work.publicReleasePairPath(source.pairId);
    await db.doc(base).set(source);
    const pack = { schemaVersion: 1, kind: "pair-code-pack-baseline", pairDigest: p.publicReleaseDigest(source), commitSha: source.commitSha,
      codeAssetManifestDigest: source.codeAssetManifestDigest, codePackManifestDigest: "9".repeat(64) };
    await db.doc(`${base}/codePacks/baseline`).set(pack);
    const fixture = publicReleaseBaselineCodeFixture(db, source.commitSha).qualified;
    // A frozen, sealed fixture includes fields which a bespoke projection
    // must not discard. The original DTO is returned by exact chunk bytes.
    Object.assign(fixture.publicContext, { privateFixturePostChrome: { footer: source.commitSha },
      privateFixtureCapabilities: { dataFigureVersion: 1, electionResultsVersion: 1, liveBlogVersion: 1,
        dataHubReportingVersion: 1, dataHubCompositionVersion: 1 }, privateFixtureSettings: { stationName: "Retained" } });
    originals.set(source.pairId, structuredClone(fixture));
    const retained = history.prepareRetainedPublicReleaseCode(fixture);
    for (const chunk of retained.chunks) await db.doc(`${history.CHUNKS}/${chunk.digest}`).set(chunk.value);
    await db.doc(`${base}/codePacks/publication`).set({ schemaVersion: 2, kind: "pair-code-publication", pairDigest: p.publicReleaseDigest(source),
      baselineDigest: p.publicReleaseDigest(pack), codePackManifestDigest: pack.codePackManifestDigest, historicalCode: retained.descriptor,
      reference: { schemaVersion: 2, kind: "pair", side: pairReference(source), commitSha: source.commitSha,
        codeAssetManifestDigest: source.codeAssetManifestDigest, publicationDigest: "8".repeat(64) } });
  }
});
afterEach(async () => { vi.unstubAllGlobals(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
async function editorialFixture() {
  const base = work.publicReleasePairPath(old.pairId), digest = (letter: string) => letter.repeat(64);
  const cursor = { baselineDigest: digest("b"), sequence: 0, lastDigest: digest("b") };
  const identity = { schemaVersion: 2, pair: pairReference(old), kind: "accepted", sourceOperationId: "editorial-operation", sourceVersion: 1,
    snapshotDigest: digest("4"), contextSequence: 0, inputManifestDigest: digest("5") };
  const qualified = originals.get(old.pairId) as any;
  const source = { schemaVersion: 2, kind: "pair-editorial-context-source", pair: pairReference(old), pairDigest: p.publicReleaseDigest(old),
    identity, claimDigest: digest("6"), viewManifestDigest: publicRoot.contentHead.manifestDigest, cursor,
    renderedAt: "2026-10-28T12:00:00.000Z", sourcePair: pairReference(old),
    originalCode: { reference: qualified.reference, qualifiedCodeDigest: digest("a") },
    documents: [{ path: "cmsPosts/current", data: { published: { title: "Current accepted source" } } }],
    homeSources: { publication: { buildBatchId: qualified.publication.buildBatchId, generation: qualified.publication.generation, commitSha: old.commitSha } } };
  const manifestKey = `release-pairs/${old.pairId}/${p.publicReleaseDigest(identity)}/claims/${source.claimDigest}/views/${source.viewManifestDigest}.json`;
  await db.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: old.pairId, status: "retained" });
  await db.doc(`${base}/heads/current`).set({ schemaVersion: 2, pairDigest: p.publicReleaseDigest(old), contentHead: publicRoot.contentHead });
  await db.doc("system/publicReleaseChanges").set(require("../../functions/lib/public-release-change-log.js").initialPublicReleaseChangeHead(cursor.baselineDigest));
  await db.doc(`${base}/views/${source.viewManifestDigest}`).set({ schemaVersion: 2, status: "staged", pairDigest: p.publicReleaseDigest(old),
    taskId: p.publicReleaseDigest(identity), identity, claimDigest: source.claimDigest, manifestDigest: source.viewManifestDigest,
    manifestKey, manifestBytes: 100, cursor });
  const retained = await editorial.writePairEditorialContext({ firestore: db, pair: old, source });
  return { source, retained, base };
}
it("current editorial reads require the actual selected physical view, complete output and deployed compatible reader cohort", async () => {
  const value = await editorialFixture(), query = request(old, previewOld, "current-editorial-v2");
  const read = () => readPairCurrentEditorial({ firestore: db, request: query });
  const result = await read();
  expect(JSON.parse(Buffer.from(result.sourceBase64, "base64").toString())).toEqual(value.source);
  expect(result.reference.manifest).toEqual(value.retained.manifest);
  expect((await readPairCurrentEditorial({ firestore: db, request: request(old, previewOld, "current-editorial-reference-v2") })).reference).toEqual(result.reference);
  await db.doc("cmsPosts/current").set({ published: { title: "Mutable future data" } });
  expect((await read()).sourceBase64).toBe(result.sourceBase64);
  await expect(readPairCurrentEditorial({ firestore: db, request: request(next, previewOld, "current-editorial-v2") })).rejects.toThrow();
  const index = db.doc(`${editorial.ROOT}/${p.publicReleaseDigest(old)}/views/${value.source.viewManifestDigest}`), saved = (await index.get()).data();
  await index.delete(); await expect(read()).rejects.toThrow(); await index.set(saved);
  await db.doc(`${value.base}/views/${value.source.viewManifestDigest}`).update({ claimDigest: "f".repeat(64) });
  await expect(read()).rejects.toThrow();
});
it("editorial context refuses head/context and reader movement across immutable chunk I/O", async () => {
  const value = await editorialFixture(); let changed = false;
  const wrapped = { projectId: db.projectId, getAll: db.getAll.bind(db), runTransaction: db.runTransaction.bind(db),
    doc(path: string) { if (path.includes("/chunks/")) return { get: async () => {
      const row = await db.doc(path).get(); if (!changed) { changed = true;
        await db.doc(`${value.base}/heads/current`).update({ "contentHead.viewId": "later-view" }); }
      return row;
    } }; return db.doc(path); } };
  await expect(readPairCurrentEditorial({ firestore: wrapped, request: request(old, previewOld, "current-editorial-v2") })).rejects.toThrow();
  await db.doc(`${value.base}/heads/current`).update({ "contentHead.viewId": publicRoot.contentHead.viewId });
  changed = false;
  wrapped.doc = (path: string) => path.includes("/chunks/") ? { get: async () => {
    const row = await db.doc(path).get(); if (!changed) { changed = true;
      await db.doc("cmsReaderCompatibilityReceipts/functions").update({ "lastComplete.providerIdentities.deploymentId": "new-reader" }); }
    return row;
  } } as never : db.doc(path) as never;
  await expect(readPairCurrentEditorial({ firestore: wrapped, request: request(old, previewOld, "current-editorial-v2") })).rejects.toThrow();
});
it.each(["head", "identity", "cursor", "private-path"])("the actual wire client refuses malformed editorial %s even with coherent outer hashes", async field => {
  await editorialFixture();
  const wire = structuredClone(await readPairCurrentEditorial({ firestore: db, request: request(old, previewOld, "current-editorial-v2") }));
  if (field === "head") wire.reference.contentHead.extra = true;
  if (field === "identity") wire.reference.manifest.identity.extra = true;
  if (field === "cursor") wire.reference.manifest.cursor.extra = true;
  if (field === "private-path") {
    const source = JSON.parse(Buffer.from(wire.sourceBase64, "base64").toString()); source.documents[0].path = "privateCredentials/forbidden";
    const bytes = Buffer.from(JSON.stringify(source)); wire.sourceBase64 = bytes.toString("base64");
    wire.reference.manifest.bodyBytes = bytes.length; wire.reference.manifest.bodyDigest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  }
  const transport = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: previewOld.rendererSha,
    pairSelection: selection(old, previewOld), readSecret: () => "fixture-edge", request: async () => Response.json(wire) });
  await expect(transport.readPairEditorialContext()).rejects.toMatchObject({ status: 409 });
});
it.each([409, 503])("the editorial transport keeps an unclassified %s refusal non-retryable without exposing its body", async status => {
  const transport = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: previewOld.rendererSha,
    pairSelection: selection(old, previewOld), readSecret: () => "fixture-edge", request: async () => new Response("private upstream body", { status }) });
  await expect(transport.readPairEditorialContext()).rejects.toMatchObject({ status: 409, message: "Versioned current CODE is unavailable" });
});
it("only the explicit bounded pending response marks the editorial transport retryable", async () => {
  const transport = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: previewOld.rendererSha,
    pairSelection: selection(old, previewOld), readSecret: () => "fixture-edge",
    request: async () => Response.json({ code: "pair_editorial_context_refreshing" }, { status: 503 }) });
  await expect(transport.readPairEditorialContext()).rejects.toMatchObject({ code: "pair_editorial_context_refreshing" });
});
it.each(["request", "stream"].flatMap(phase => ["Error", "TypeError", "TimeoutError", "AbortError"].map(name => [phase, name])))
  ("classifies %s %s at both transport hops without exposing private errors", async (phase, name) => {
    const error = Object.assign(new Error("fixture-private-upstream-error"), { name });
    const network: typeof fetch = async () => {
      if (phase === "request") throw error;
      return new Response(new ReadableStream({ start(controller) { controller.error(error); } }), { headers: { "content-type": "application/json" } });
    };
    const pending = ["TimeoutError", "AbortError"].includes(name);
    const transport = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: previewOld.rendererSha,
      pairSelection: selection(old, previewOld), readSecret: () => "fixture-edge", request: network });
    await expect(transport.readPairEditorialContext()).rejects.toMatchObject(pending
      ? { code: "pair_editorial_context_refreshing", message: "Paired editorial source is refreshing" }
      : { status: 409, message: "Versioned current CODE is unavailable" });
    const relay = await handlePairRecordCode(request(old, previewOld, "current-editorial-v2"), {
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", CMS_EDGE_ORIGIN_SECRET: "fixture-edge" }, network);
    expect(relay.status).toBe(pending ? 503 : 409);
    const body = await relay.json(); expect(body.code).toBe(pending ? "pair_editorial_context_refreshing" : undefined);
    expect(JSON.stringify(body)).not.toContain("fixture-private-upstream-error");
  });
it("reads both retained public CODE packs for both distinct preview renderers without rewriting either identity or dropping fields", async () => {
  for (const source of [old, next]) for (const preview of [previewOld, previewNew]) {
    const value = await readPairCurrentCode({ firestore: db, request: request(source, preview) });
    expect(value.reference.rendererSha).toBe(preview.rendererSha);
    expect(value.reference.source.side).toEqual(pairReference(source));
    expect(JSON.parse(Buffer.from(value.qualifiedCodeBase64, "base64").toString())).toEqual(originals.get(source.pairId));
    expect(value.reference.source.commitSha).toBe(source.commitSha);
    expect(value.reference.source.commitSha).not.toBe(preview.rendererSha);
  }
});
it("actual HTTP runs the private Function producer, gateway v2 relay and selected client hook over verified original chunks", async () => {
  const selectedEditorial = await editorialFixture();
  const handler = createPairCurrentCodeHandler({ firestore: db,
    edge: { readSecret: () => "fixture-edge", logger: { warn() {}, error() {} } } });
  const nativeFetch = globalThis.fetch;
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      if (incoming.url === "/cmsReadPairCurrentCodeV2") {
        const req = { method: incoming.method, headers: incoming.headers, is: () => true, body: JSON.parse(raw.toString()) };
        const res = { statusCode: 200, set: (key: string, value: string) => { outgoing.setHeader(key, value); return res; },
          status: (code: number) => { res.statusCode = code; return res; },
          json: (value: unknown) => { outgoing.statusCode = res.statusCode; outgoing.setHeader("content-type", "application/json"); outgoing.end(JSON.stringify(value)); } };
        await handler(req, res);
      } else {
        const response = await handlePrivateRecordCode(new Request("https://dev-api.example.org/_internal/record-code", {
          method: "POST", body: raw, headers: incoming.headers as Record<string, string>,
        }), { FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", FIREBASE_PROJECT_ID: "njpbs-site-dev",
          CMS_DEPLOYMENT_ENVIRONMENT: "development", ADMIN_ORIGIN: "https://dev-admin.example.org", CMS_EDGE_ORIGIN_SECRET: "fixture-edge" });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch { outgoing.writeHead(503); outgoing.end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server");
  const origin = `http://127.0.0.1:${address.port}`;
  const network: typeof fetch = (url, init) => {
    const target = new URL(String(url));
    if (!["dev-api.example.org", "us-central1-njpbs-site-dev.cloudfunctions.net"].includes(target.hostname)) throw new Error("Unexpected fixture network target");
    return nativeFetch(`${origin}${target.pathname}`, init);
  };
  vi.stubGlobal("fetch", network);
  const transport = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: previewOld.rendererSha,
    pairSelection: selection(next, previewOld), readSecret: () => "fixture-edge", request: (url: string, init: RequestInit) => network(url, init) });
  const result = await transport.readPairCodeContext();
  expect(result.qualifiedCode).toEqual(originals.get(next.pairId));
  expect(await transport.readPairCodeReference()).toEqual(result.reference);
  const editorialTransport = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: previewOld.rendererSha,
    pairSelection: selection(old, previewOld), readSecret: () => "fixture-edge", request: (url: string, init: RequestInit) => network(url, init) });
  const current = await editorialTransport.readPairEditorialContext();
  expect(current.source).toEqual(selectedEditorial.source);
  expect(await editorialTransport.readPairEditorialReference()).toEqual(current.reference);
  // Exercise the actual producer and relay classification, including an
  // incomplete optional write and corruption behind an existing immutable index.
  const prefix = `${editorial.ROOT}/${p.publicReleaseDigest(old)}`;
  const index = db.doc(`${prefix}/views/${selectedEditorial.source.viewManifestDigest}`), savedIndex = (await index.get()).data()!;
  await index.delete();
  await expect(editorialTransport.readPairEditorialContext()).rejects.toMatchObject({ code: "pair_editorial_context_refreshing" });
  await index.set(savedIndex);
  const chunk = db.doc(`${prefix}/chunks/${selectedEditorial.retained.manifest.chunks[0]}`), savedChunk = (await chunk.get()).data()!;
  await chunk.update({ base64: Buffer.from("damaged private source").toString("base64") });
  await expect(editorialTransport.readPairEditorialContext()).rejects.toMatchObject({ status: 409 });
  await chunk.set(savedChunk);
  const wrongRenderer = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: "f".repeat(40),
    pairSelection: selection(old, previewOld), readSecret: () => "fixture-edge", request: (url: string, init: RequestInit) => network(url, init) });
  await expect(wrongRenderer.readPairEditorialContext()).rejects.toMatchObject({ status: 409 });
  publicRoot = { ...publicRoot, epoch: publicRoot.epoch + 1 };
  await db.doc("system/publicDeployment").set(publicRoot);
  // A transport captures its selector. Retrying that stale request cannot
  // recover; the next read must acquire a fresh authority and transport.
  await expect(editorialTransport.readPairEditorialContext()).rejects.toMatchObject({ status: 409 });
  const refreshed = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha: previewOld.rendererSha,
    pairSelection: selection(old, previewOld), readSecret: () => "fixture-edge", request: (url: string, init: RequestInit) => network(url, init) });
  expect((await refreshed.readPairEditorialContext()).source).toEqual(selectedEditorial.source);
});
it("refuses a missing chunk, changed source/preview identity, mismatched selector and an unretained source", async () => {
  await expect(readPairCurrentCode({ firestore: db, request: { ...request(), rendererSha: "e".repeat(40) } })).rejects.toThrow();
  await expect(readPairCurrentCode({ firestore: db, request: { ...request(), selection: { ...selection(), expectedPublicSelectorDigest: "0".repeat(64) } } })).rejects.toThrow();
  await db.doc("system/cmsPreviewRuntime").update({ recoveryPairId: "preview-unrelated" });
  await expect(readPairCurrentCode({ firestore: db, request: request(old, previewNew) })).rejects.toThrow();
  await db.doc("system/cmsPreviewRuntime").set(selector(previewOld, previewNew));
  const source = (await db.doc(`${work.publicReleasePairPath(old.pairId)}/codePacks/publication`).get()).data()!;
  await db.doc(`${history.CHUNKS}/${source.historicalCode.chunks[0]}`).delete();
  await expect(readPairCurrentCode({ firestore: db, request: request() })).rejects.toThrow();
});
it("refuses authority movement across immutable chunk IO and leaves all selectors untouched", async () => {
  let moved = false;
  const wrapped = { projectId: db.projectId, runTransaction: db.runTransaction.bind(db),
    doc(path: string) { const original = db.doc(path); return { ...original, get: async () => {
      const row = await original.get();
      if (path.startsWith(history.CHUNKS) && !moved) { moved = true; await db.doc("system/publicDeployment").update({ epoch: publicRoot.epoch + 1 }); }
      return row;
    } }; } };
  // SDK transactions must receive real references; only external chunk reads
  // are decorated, preserving the original real transaction implementation.
  wrapped.doc = (path: string) => path.startsWith(history.CHUNKS)
    ? { get: async () => { const row = await db.doc(path).get(); if (!moved) { moved = true;
      await db.doc("system/publicDeployment").update({ epoch: publicRoot.epoch + 1 }); } return row; } } as never : db.doc(path) as never;
  await expect(readPairCurrentCode({ firestore: wrapped, request: request() })).rejects.toThrow();
  expect((await db.doc("system/publicDeployment").get()).data()!.epoch).toBe(publicRoot.epoch + 1);
});
it.each([old, next])("derives CODE replay expectations from the original sealed source $pairId without an HTTP result or request expectations", async source => {
  const query = request(source, previewNew), original = originals.get(source.pairId);
  const publication = (await db.doc(`${work.publicReleasePairPath(source.pairId)}/codePacks/publication`).get()).data()!;
  // Original endpoint wire contract, independently assembled from the sealed
  // fixture bytes and specification. No expected value comes from a new reader.
  const wire = { schemaVersion: 2, kind: "pair-current-code", reference: {
    schemaVersion: 2, kind: "pair-current-code", rendererSha: previewNew.rendererSha,
    selection: query.selection, source: publication.reference, pairDigest: p.publicReleaseDigest(source),
    readerDigests: Object.fromEntries(["functions", "cmsApi"].map(component => [component,
      require("../../functions/lib/cms-reader-session.js").readerSessionDigest(reader(component))])),
    qualifiedCodeDigest: bodyDigest(JSON.stringify(original)), qualifiedCodeBytes: Buffer.byteLength(JSON.stringify(original)),
  }, qualifiedCodeBase64: Buffer.from(JSON.stringify(original)).toString("base64") };
  const evidence = await readPairCodeReplaySource({ firestore: db, request: query });
  expect(evidence).toMatchObject({ schemaVersion: 2, kind: "retained-pair-code-replay-source", request: query,
    consumer: { previewPairId: previewNew.pairId, previewPairDigest: cms.digest(previewNew), rendererSha: previewNew.rendererSha },
    source: { pair: pairReference(source), pairDigest: p.publicReleaseDigest(source), reference: publication.reference,
      qualifiedCodeDigest: bodyDigest(JSON.stringify(original)) },
    expected: { status: 200, contentType: "application/json", bodyDigest: bodyDigest(JSON.stringify(wire)) } });
  await expect(readPairCodeReplaySource({ firestore: db, request: { ...query, expected: evidence.expected } })).rejects.toThrow();
  await expect(readPairCodeReplaySource({ firestore: db, request: request(source, previewNew, "current-code-reference-v2") })).rejects.toThrow();
  expect((await db.collection("cmsReaderBridgeInstallAttempts").get()).empty).toBe(true);
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
});
it("keeps NEW preview consumer evidence distinct from original OLD CODE and refuses NEW public CODE during first installation", async () => {
  const { initialPublicDeploymentPointer } = require("../../functions/lib/public-deployment.js");
  const legacy = { ...initialPublicDeploymentPointer(), activeGeneration: 1, activeDeploymentId: "old-release",
    activeCommitSha: old.commitSha, lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "old-release" };
  await db.doc("system/publicDeployment").set(legacy);
  await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready", rendererSha: previewOld.rendererSha, serializerId: "legacy" });
  const deployedReaders = bridgeFixture().request.readers, candidateId = "renderer-100-1";
  for (const component of ["functions", "cmsApi"]) {
    await db.doc(`cmsReaderCompatibilityReceipts/${component}`).delete();
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation: deployedReaders[component] });
  }
  await db.doc(`cmsDeploymentCandidates/${candidateId}`).set({ schemaVersion: 2, component: "renderer", state: "verified",
    mutation: { sourceSha: previewNew.rendererSha, completedAt: new Date().toISOString(), providerIdentities: previewNew } });
  const query = { ...request(old, previewNew), selection: { ...selection(old, previewNew),
    expectedPublicSelectorDigest: p.publicReleaseDigest(legacy), previewCandidateReceiptId: candidateId } };
  const evidence = await readPairCodeReplaySource({ firestore: db, deployedReaders, request: query });
  expect(evidence.consumer.previewPairDigest).toBe(cms.digest(previewNew));
  expect(evidence.source.pairDigest).toBe(p.publicReleaseDigest(old));
  expect(evidence.source.pair).toEqual(pairReference(old));
  await expect(readPairCodeReplaySource({ firestore: db, deployedReaders,
    request: { ...query, selection: { ...query.selection, pair: pairReference(next) } } })).rejects.toThrow();
  await db.doc(`cmsDeploymentCandidates/${candidateId}`).update({ "mutation.completedAt": new Date(Date.now() - 300_001).toISOString() });
  await expect(readPairCodeReplaySource({ firestore: db, deployedReaders, request: query })).rejects.toThrow();
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(legacy);
  expect((await db.collection("cmsReaderCompatibilityReceipts").get()).empty).toBe(true);
});
it("refuses replay source evidence if the original publication changes while immutable chunks are opened", async () => {
  let moved = false;
  const publication = db.doc(`${work.publicReleasePairPath(old.pairId)}/codePacks/publication`);
  const wrapped = { projectId: db.projectId, runTransaction: db.runTransaction.bind(db),
    doc: (path: string) => path.startsWith(history.CHUNKS) ? { get: async () => {
      const row = await db.doc(path).get();
      if (!moved) { moved = true; await publication.update({ "reference.publicationDigest": "0".repeat(64) }); }
      return row;
    } } : db.doc(path) };
  await expect(readPairCodeReplaySource({ firestore: wrapped, request: request() })).rejects.toThrow();
  expect(moved).toBe(true);
  expect((await db.collection("cmsReaderBridgeInstallAttempts").get()).empty).toBe(true);
});
async function firstInstallSourceFixture() {
  const bootstrap = require("../../functions/lib/cms-preview-pair-candidate.js");
  const { initialPublicDeploymentPointer } = require("../../functions/lib/public-deployment.js");
  const legacy = { ...initialPublicDeploymentPointer(), activeGeneration: 1, activeDeploymentId: "old-release",
    activeCommitSha: old.commitSha, lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "old-release" };
  const runtime = { schemaVersion: 1, phase: "ready", rendererSha: previewOld.rendererSha, serializerId: "legacy" };
  await db.doc("system/publicDeployment").set(legacy);
  await db.doc("system/cmsPreviewRuntime").set(runtime);
  let time = Date.now();
  const verified = candidate(previewNew, time), candidateId = "renderer-100-1";
  Object.assign(verified.mutation.providerIdentities, { applicationId: "new-application", workerDeploymentId: "new-deployment" });
  await db.doc(`cmsDeploymentCandidates/${candidateId}`).set(verified);
  await bootstrap.recordPreviewPairCandidatePointer({ firestore: db, request: { operationId: "preview-code-source",
    pairId: previewNew.pairId, candidateReceiptId: candidateId, expectedPointerDigest: null,
    expectedRuntimeDigest: cms.digest(bootstrap.previewRuntimeIdentity(runtime)), bootstrapPublicPair: pairReference(old) }, clock: () => time });
  const deployedReaders = bridgeFixture(time).request.readers;
  for (const component of ["functions", "cmsApi"]) {
    await db.doc(`cmsReaderCompatibilityReceipts/${component}`).delete();
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation: deployedReaders[component] });
  }
  return { options: { firestore: db, deployedReaders, now: () => time,
    consumer: { previewPairId: previewNew.pairId, rendererSha: previewNew.rendererSha, workerVersion: previewNew.workerVersion } },
  pointer: db.doc(`${bootstrap.POINTERS}/${previewNew.pairId}`), candidate: db.doc(`cmsDeploymentCandidates/${candidateId}`),
  expire: () => { time += 300_001; } };
}
it("derives the first-install NEW preview/OLD public CODE binding from the original pointer without creating a NEW queue or install proof", async () => {
  const { options } = await firstInstallSourceFixture();
  const prerequisite = await prepareFirstInstallPreviewCodeSource(options);
  expect(prerequisite.evidence).toMatchObject({ schemaVersion: 2, kind: "first-install-preview-code-source", code: {
    consumer: { previewPairId: previewNew.pairId, previewPairDigest: cms.digest(previewNew) },
    source: { pair: pairReference(old), pairDigest: p.publicReleaseDigest(old) },
    request: { selection: { pair: pairReference(old), previewPairId: previewNew.pairId, previewCandidateReceiptId: "renderer-100-1" } },
  } });
  const late = await db.runTransaction((transaction: unknown) => prerequisite.assertCurrentInTransaction({ transaction }), { readOnly: true });
  expect(late).toBe(prerequisite.digest);
  expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  expect((await db.collection("cmsReaderCompatibilityReceipts").get()).empty).toBe(true);
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
});
it.each(["pointer", "candidate", "source", "reader", "selector", "billing"])("rechecks original %s authority in the caller's real SDK transaction", async boundary => {
  const fixture = await firstInstallSourceFixture(), prerequisite = await prepareFirstInstallPreviewCodeSource(fixture.options);
  if (boundary === "pointer") await fixture.pointer.update({ bootstrapPublicPair: pairReference(next) });
  if (boundary === "candidate") fixture.expire();
  if (boundary === "source") await db.doc(`${work.publicReleasePairPath(old.pairId)}/codePacks/publication`).update({ "reference.publicationDigest": "0".repeat(64) });
  if (boundary === "reader") await db.doc("cmsDeploymentReceipts/functions").update({ state: "in_progress" });
  if (boundary === "selector") await db.doc("system/publicDeployment").set(publicRoot);
  if (boundary === "billing") await db.doc("system/billing").set({ disabled: true });
  await expect(db.runTransaction((transaction: unknown) => prerequisite.assertCurrentInTransaction({ transaction }), { readOnly: true })).rejects.toThrow();
});
it("retains the original bootstrap source after preview retention without renewing an expired candidate", async () => {
  const { options, expire, candidate: candidateRef } = await firstInstallSourceFixture();
  const originalCandidate = (await candidateRef.get()).data();
  await db.doc("system/cmsPreviewRuntime").set(selector(previewOld, previewNew));
  expire();
  const prerequisite = await prepareFirstInstallPreviewCodeSource(options);
  expect(prerequisite.evidence.code.request.selection.previewCandidateReceiptId).toBeNull();
  expect(prerequisite.evidence.code.source.pair).toEqual(pairReference(old));
  expect((await candidateRef.get()).data()).toEqual(originalCandidate);
});
it("refuses a changed bootstrap pointer across original immutable CODE I/O", async () => {
  const fixture = await firstInstallSourceFixture();
  let moved = false;
  const wrapped = { projectId: db.projectId, runTransaction: db.runTransaction.bind(db),
    doc: (path: string) => path.startsWith(history.CHUNKS) ? { get: async () => {
      const row = await db.doc(path).get();
      if (!moved) { moved = true; await fixture.pointer.update({ bootstrapPublicPair: pairReference(next) }); }
      return row;
    } } : db.doc(path) };
  await expect(prepareFirstInstallPreviewCodeSource({ ...fixture.options, firestore: wrapped })).rejects.toThrow();
  expect(moved).toBe(true);
});
it("refuses absent or wrong original bootstrap bindings and mismatched consumer identity", async () => {
  const fixture = await firstInstallSourceFixture();
  await expect(prepareFirstInstallPreviewCodeSource({ ...fixture.options,
    consumer: { ...fixture.options.consumer, workerVersion: previewOld.workerVersion } })).rejects.toThrow();
  const original = (await fixture.pointer.get()).data()!;
  await fixture.pointer.update({ bootstrapPublicPair: pairReference(next) });
  await expect(prepareFirstInstallPreviewCodeSource(fixture.options)).rejects.toThrow();
  await fixture.pointer.set(original);
  await fixture.pointer.delete();
  await expect(prepareFirstInstallPreviewCodeSource(fixture.options)).rejects.toThrow();
});
it("first installation replays original OLD CODE against actual completed deployment descriptors before creating compatibility receipts", async () => {
  const { initialPublicDeploymentPointer } = require("../../functions/lib/public-deployment.js");
  const legacy = { ...initialPublicDeploymentPointer(), activeGeneration: 1, activeDeploymentId: "old-release",
    activeCommitSha: old.commitSha, lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "old-release" };
  await db.doc("system/publicDeployment").set(legacy);
  await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready", rendererSha: previewOld.rendererSha, serializerId: "legacy" });
  const deployedReaders = bridgeFixture().request.readers;
  const readerOperationId = "reader-recovered-install";
  await db.doc("cmsReaderBridgeInstallAttempts/reader-old-attempt").set({ schemaVersion: 2, state: "uncertain" });
  for (const component of ["functions", "cmsApi"]) {
    await db.doc(`cmsReaderCompatibilityReceipts/${component}`).delete();
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation: deployedReaders[component] });
  }
  const query = { ...request(), selection: { ...selection(), expectedPublicSelectorDigest: p.publicReleaseDigest(legacy) } };
  const output = await readPairCurrentCode({ firestore: db, deployedReaders, request: query });
  expect(output.reference.source.side).toEqual(pairReference(old));
  expect((await db.collection("cmsReaderCompatibilityReceipts").get()).empty).toBe(true);
  const candidateId = "renderer-100-1";
  await db.doc(`cmsDeploymentCandidates/${candidateId}`).set({ schemaVersion: 2, component: "renderer", state: "verified",
    mutation: { sourceSha: previewNew.rendererSha, completedAt: new Date().toISOString(), providerIdentities: previewNew } });
  const candidateQuery = { ...query, rendererSha: previewNew.rendererSha,
    selection: { ...query.selection, previewPairId: previewNew.pairId, previewCandidateReceiptId: candidateId } };
  const candidateCode = await readPairCurrentCode({ firestore: db, deployedReaders, request: candidateQuery });
  expect(candidateCode.reference.rendererSha).toBe(previewNew.rendererSha);
  expect(candidateCode.reference.source.side).toEqual(pairReference(old));
  expect((await db.doc("system/cmsPreviewRuntime").get()).data()!.schemaVersion).toBe(1);
  await db.doc(`cmsDeploymentCandidates/${candidateId}`).update({ "mutation.providerIdentities.imageDigest": `sha256:${"0".repeat(64)}` });
  await expect(readPairCurrentCode({ firestore: db, deployedReaders, request: candidateQuery })).rejects.toThrow();
  await db.doc("cmsDeploymentReceipts/functions").update({ "mutation.providerIdentities": { deploymentId: "changed" } });
  await expect(readPairCurrentCode({ firestore: db, deployedReaders, request: query })).rejects.toThrow();
  const { readerSessionDigest } = require("../../functions/lib/cms-reader-session.js");
  const proofFixture = bridgeFixture().request;
  const { cmsReaderBridgeProofKey } = require("../../functions/lib/cms-reader-bridge-proof.js");
  await db.doc(`cmsReaderBridgeInstalledProofs/${cmsReaderBridgeProofKey(deployedReaders)}`).set({ schemaVersion: 2,
    readerDigests: Object.fromEntries(Object.entries(deployedReaders).map(([component, value]) => [component, p.publicReleaseDigest(value)])),
    proof: { schemaVersion: 2, operationId: readerOperationId, requestDigest: "a".repeat(64), stateDigest: "b".repeat(64),
      verifiedAt: new Date().toISOString(), readers: deployedReaders, readerIdentities: Object.fromEntries(Object.entries(deployedReaders)
        .map(([component, value]) => [component, readerSessionDigest(value)])),
      results: ["functions", "cmsApi"].flatMap(component => proofFixture.cases.map(row => ({ component,
        scope: row.scope, version: row.version, feature: row.feature, pairDigest: row.pairDigest, ...row.expected }))) } });
  await db.doc("cmsDeploymentReceipts/cmsApi").set({ state: "in_progress" });
  expect(await readPairCurrentCode({ firestore: db, deployedReaders, request: query })).toEqual(output);
  await db.doc("cmsDeploymentReceipts/cmsApi").set({ schemaVersion: 1, component: "cmsApi", state: "complete",
    mutation: { ...deployedReaders.cmsApi, sourceSha: "f".repeat(40) } });
  expect(await readPairCurrentCode({ firestore: db, deployedReaders, request: query })).toEqual(output);
});
