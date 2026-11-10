import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { gzipSync } from "node:zlib";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { qualifyPublicReleasePair } from "../../site/scripts/public-release-pair-qualification";
import { readQualificationEvidence } from "../../site/scripts/public-release-pair-qualification-evidence";
import { prepareBootstrapIngressProof, assertPreparedBootstrapIngress } from "../../site/scripts/public-release-bootstrap-ingress-proof";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { isPublicPairRequestPath } from "../../workers/src/public-release-view-reader";
import p from "../../functions/lib/public-release-pair.js";
import serving from "../../functions/lib/public-release-serving.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import work from "../../functions/lib/public-release-pair-work.js";

let app: App, firestore: Firestore, r2: Awaited<ReturnType<typeof publicReleaseR2Fixture>>;
let f: Awaited<ReturnType<typeof qualifiedPairFixture>>, selector: any, qualification: { qualificationId: string; receiptDigest: string };
let router: ReturnType<typeof createPublicReleaseRouter>;
const expectedPaths = new Set<string>();
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the loopback demo emulator");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "bootstrap-ingress-proof"); firestore = getFirestore(app);
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, firestore);
  r2 = await publicReleaseR2Fixture("bootstrap-public-roster");
  f = await qualifiedPairFixture(firestore, r2.store, { mediaLifecycleReady: true, pairCommitSha: "a".repeat(40) });
  const original = (await firestore.doc("system/publicDeployment").get()).data()!;
  await adoption.closePublicReleaseBootstrapAdmission({ firestore, attempt: { schemaVersion: 2, operationId: "bootstrap-roster-test",
    environment: "development", legacyPointerDigest: adoption.legacyBootstrapPointerDigest(original) } });
  const recovery = releasePair("c", "c".repeat(40)), contract = { schemaVersion: 2, families: ["posts", "pages"], features: [] };
  selector = p.parsePublicReleaseSelector({ ...original, schemaVersion: 2, epoch: 1, selectedPair: p.publicReleasePairReference(f.pair),
    recoveryPair: p.publicReleasePairReference(recovery), contentHead: { pairId: f.pair.pairId, viewId: f.witnessDigest,
      manifestDigest: f.witness.contentViewDigest, contextSequence: f.witness.headCursor.sequence }, admittedContractDigest: p.publicReleaseDigest(contract),
    priorSelectorDigest: p.publicReleaseDigest(original), switchOperationId: "bootstrap-roster-test", proofDigest: "f".repeat(64) });
  // This is the source/HTTP proof suite. The initial-CAS owner and the resume
  // transaction have separate tests; no bootstrap installation is claimed here.
  await firestore.doc("system/publicDeployment").set(selector);
  const base = work.publicReleasePairPath(f.pair.pairId);
  await firestore.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: f.pair.pairId, status: "retained" });
  await firestore.doc(`${base}/heads/current`).set({ schemaVersion: 2, pairDigest: p.publicReleaseDigest(f.pair), contentHead: selector.contentHead });
  await firestore.doc("system/publicDeployment/pairMedia/current").set({ schemaVersion: 2, epoch: 1, activeGeneration: selector.activeGeneration,
    lastReservedGeneration: selector.activeGeneration, newestEligibleGeneration: selector.activeGeneration, references: [
      { pairId: f.pair.pairId, manifestDigest: f.witness.contentViewDigest }, { pairId: recovery.pairId, manifestDigest: "c".repeat(64) }] });
  const result = await qualifyPublicReleasePair({ firestore, ...f, qualificationId: "bootstrap-current-roster" });
  qualification = { qualificationId: result.receipt.qualificationId, receiptDigest: result.digest };
  for await (const member of readQualificationEvidence({ store: r2.store, pair: f.pair, qualificationId: result.receipt.qualificationId,
    witnessDigest: result.receipt.witnessDigest, ...result.receipt.evidence, signal: AbortSignal.timeout(20_000) }))
    if (isPublicPairRequestPath(member.path) && !member.path.startsWith("/_pair-")) expectedPaths.add(member.path);
  const slot = createPublicReleaseSlot({ pair: f.pair, workerVersionId: f.pair.publicWorker.versionId, store: r2.store,
    getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, pair: f.pair, selection, path, environment: "development", composedReadersEnabled: true }) });
  router = createPublicReleaseRouter({ environment: "development", bootstrapPairId: f.pair.pairId,
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }), slots: [slot,
      { identity: recovery, serve: async () => { throw new Error("The recovery slot must not serve first-install OLD"); } }] });
}, 60_000);
afterAll(async () => { await f?.close(); await r2?.runtime.dispose(); if (app) await deleteApp(app); });
function options(request: typeof fetch) { return { firestore, store: r2.store, pair: f.pair, selector, qualification, request, signal: AbortSignal.timeout(30_000) }; }
it("proves every qualified public path through actual router/slot bytes and two ordinary canonical-root GETs", async () => {
  const paths: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url)); expect(parsed.origin).toBe("https://dev-public.example.org"); expect(parsed.search).toBe("");
    expect(init).toMatchObject({ method: "GET", cache: "no-store" }); paths.push(parsed.pathname);
    return router.fetch(new Request(url, init));
  };
  const proof = await prepareBootstrapIngressProof(options(request));
  expect(proof.kind).toBe("fenced-bootstrap-readiness"); expect(proof.outputCount).toBe(expectedPaths.size);
  expect(new Set(paths.filter(path => path !== "/_publication-v2.json"))).toEqual(expectedPaths);
  expect(paths.filter(path => path === "/_publication-v2.json")).toHaveLength(2);
  const evidence = assertPreparedBootstrapIngress({ firestore, pair: f.pair, selector, proof });
  expect(evidence.roster).toHaveLength(expectedPaths.size);
  expect(() => assertPreparedBootstrapIngress({ firestore, pair: f.pair, selector, proof: { ...proof } })).toThrow();
  expect((await firestore.doc("system/publicReleaseAdmissions/controls/bootstrapFence").get()).data()!.status).toBe("closed");
}, 60_000);
it("accepts fetch-decoded gzip bytes when the encoded length exceeds the sealed byte count", async () => {
  let compressed = false;
  const request: typeof fetch = async (url, init) => {
    expect(new Headers(init?.headers).get("accept-encoding")).toBe(new URL(String(url)).pathname === "/_publication-v2.json" ? null : "identity");
    const response = await router.fetch(new Request(url, init));
    if (new URL(String(url)).pathname !== "/_astro/client.js") return response;
    const decoded = new Uint8Array(await response.arrayBuffer()), encoded = gzipSync(decoded);
    expect(encoded.length).toBeGreaterThan(decoded.length); compressed = true;
    const headers = new Headers(response.headers); headers.set("content-encoding", "gzip"); headers.set("content-length", String(encoded.length));
    // Node fetch exposes decoded bytes while preserving encoded HTTP headers.
    const body = new Response(new Uint8Array(encoded)).body!.pipeThrough(new DecompressionStream("gzip"));
    return new Response(body, { status: response.status, headers });
  };
  const proof = await prepareBootstrapIngressProof(options(request));
  expect(compressed).toBe(true); expect(proof.outputCount).toBe(expectedPaths.size);
}, 60_000);
it.each(["body", "mime", "redirect", "cache", "pending", "status", "root"])("refuses %s mismatch from the actual HTTP boundary", async fault => {
  let changed = false, roots = 0;
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, response = await router.fetch(new Request(url, init));
    if (path === "/_publication-v2.json") {
      if (++roots === 2 && fault === "root") {
        changed = true; const value = await response.json() as any; value.epoch = 2;
        return new Response(JSON.stringify(value), { headers: response.headers });
      }
      return response;
    }
    if (changed || fault === "root" || fault === "redirect" && response.status !== 308 || fault !== "redirect" && response.status !== 200) return response;
    const body = new Uint8Array(await response.arrayBuffer()), headers = new Headers(response.headers);
    if (fault === "body" && !body.length) return new Response(body, { status: response.status, headers });
    changed = true;
    if (fault === "body") body[0] ^= 1;
    if (fault === "mime") headers.set("content-type", "application/x-wrong");
    if (fault === "redirect") headers.set("location", "/wrong/");
    if (fault === "cache") headers.set("cache-control", "public, max-age=60");
    if (fault === "pending") headers.set("publication-refresh", "pending");
    return new Response(body, { status: fault === "status" ? 503 : response.status, headers });
  };
  await expect(prepareBootstrapIngressProof(options(request))).rejects.toThrow(); expect(changed).toBe(true);
}, 60_000);
it.each(["cache", "pending", "digest"])("identifies the public path and %s refusal without provider details", async fault => {
  const request: typeof fetch = async (url, init) => {
    const response = await router.fetch(new Request(url, init));
    if (new URL(String(url)).pathname !== "/") return response;
    const headers = new Headers(response.headers), body = new Uint8Array(await response.arrayBuffer());
    if (fault === "cache") headers.set("cache-control", "public, max-age=60");
    if (fault === "pending") headers.set("publication-refresh", "pending");
    if (fault === "digest") body[0] ^= 1;
    return new Response(body, { status: response.status, headers });
  };
  const reason = fault === "cache" ? "HTTP cache-control lacks no-store" : fault === "pending" ? "HTTP response is recovery-pending" : "decoded HTTP digest differs";
  await expect(prepareBootstrapIngressProof(options(request))).rejects.toThrow(`Bootstrap readiness refused /: ${reason}`);
}, 60_000);
it.each(["firestore", "storage"])("bounds a stalled %s read by the caller abort without later public requests", async kind => {
  const controller = new AbortController(), request = vi.fn();
  let markStarted!: () => void, release!: () => void, hits = 0;
  const entered = new Promise<void>(resolve => { markStarted = resolve; });
  const parked = new Promise<void>(resolve => { release = resolve; });
  const finishing: Promise<unknown>[] = [];
  const database = kind === "firestore" ? new Proxy(firestore, { get(target, key) {
    if (key === "doc") return (path: string) => {
      const ref = target.doc(path);
      return new Proxy(ref, { get(original, member) {
        if (member === "get") return () => {
          hits++; markStarted(); const read = parked.then(() => original.get()); finishing.push(read); return read;
        };
        const value = Reflect.get(original, member, original); return typeof value === "function" ? value.bind(original) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) : firestore;
  const store = kind === "storage" ? { put: r2.store.put.bind(r2.store), get: (key: string) => {
    hits++; markStarted(); const read = parked.then(() => r2.store.get(key)); finishing.push(read); return read;
  } } : r2.store;
  const result = prepareBootstrapIngressProof({ ...options(request), firestore: database, store, signal: controller.signal });
  let hitsAtAbort = 0;
  try {
    await entered; hitsAtAbort = hits; const abortedAt = performance.now(); controller.abort();
    await expect(result).rejects.toThrow("Private pair read deadline");
    expect(performance.now() - abortedAt).toBeLessThan(1_000); expect(request).not.toHaveBeenCalled();
  } finally { release(); }
  // Let the uncancellable read finish; it cannot start public I/O or mint a
  // successful handle after the caller's cancellation.
  await Promise.allSettled(finishing); await new Promise(resolve => setImmediate(resolve));
  expect(request).not.toHaveBeenCalled(); expect(hitsAtAbort).toBeGreaterThan(0); expect(hits).toBe(hitsAtAbort);
}, 10_000);
it("cancels a stalled immutable object body when readiness is aborted", async () => {
  const controller = new AbortController(), request = vi.fn();
  let markStarted!: () => void, markCancelled!: () => void, replaced = false;
  const entered = new Promise<void>(resolve => { markStarted = resolve; });
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
  const cancel = vi.fn(() => { markCancelled(); });
  const store = { put: r2.store.put.bind(r2.store), async get(key: string) {
    const object = await r2.store.get(key);
    if (!object || replaced) return object;
    replaced = true; await object.body.cancel();
    return { size: object.size, customMetadata: object.customMetadata,
      body: new ReadableStream<Uint8Array>({ pull() { markStarted(); }, cancel }) };
  } };
  const result = prepareBootstrapIngressProof({ ...options(request), store, signal: controller.signal });
  await entered; const abortedAt = performance.now(); controller.abort();
  await expect(result).rejects.toThrow("Private pair read deadline"); await cancelled;
  expect(performance.now() - abortedAt).toBeLessThan(1_000); expect(cancel).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
}, 10_000);
