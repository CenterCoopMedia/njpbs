import { beforeEach, expect, it, vi } from "vitest";
import { releasePair, pairReference, releaseSelector } from "./helpers/private-public-release-pair.js";
import { createHash } from "node:crypto";
import inputs from "../functions/lib/public-release-pair-input.js";
import { writePublicReleasePairView, writePublicReleasePairClaimJson } from "../site/scripts/public-release-pair-view-storage";
import protocol from "../functions/lib/public-release-pair.js";
import { createPublicReleaseSlot } from "../workers/src/public-release-slot";
import { readPublicReleasePairOutput, verifyPairRouteTarget } from "../workers/src/public-release-view-reader";
import { createPublicReleaseRouter } from "../workers/src/public-release-router";
import type { PairServingDecision } from "../functions/lib/public-release-serving";
import type { PairTaskIdentity } from "../functions/lib/public-release-pair-work";
import sourceBody from "../functions/lib/public-release-source-body.js";

const pair = releasePair(), operationId = "O".repeat(20), snapshotDigest = "d".repeat(64), claimDigest = "e".repeat(64);
const body = new TextEncoder().encode("<!doctype html><html>current</html>");
let identity: PairTaskIdentity = { schemaVersion: 2, pair: pairReference(pair), kind: "qualification", sourceOperationId: operationId,
  sourceVersion: 7, snapshotDigest, contextSequence: 0, inputManifestDigest: "f".repeat(64) };
const cursor = { baselineDigest: "1".repeat(64), sequence: 0, lastDigest: "1".repeat(64) };
const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
const store = {
  async put(key: string, bytes: Uint8Array, options: { customMetadata: Record<string, string> }) { objects.set(key, { bytes: new Uint8Array(bytes), metadata: options.customMetadata }); },
  get: vi.fn(async (key: string) => { const value = objects.get(key); if (!value) return null;
    return { size: value.bytes.length, customMetadata: value.metadata, body: new Blob([new Uint8Array(value.bytes)]).stream() }; }),
};
let decision: PairServingDecision;
const selection = () => ({ environment: "development" as const, selector: { ...releaseSelector(), contentHead: decision.contentHead }, readStartedAt: Date.now() });
const getDecision = vi.fn(async () => decision as PairServingDecision | { kind: "reselect" });
const slot = () => createPublicReleaseSlot({ pair, workerVersionId: pair.publicWorker.versionId, store, getDecision });
const request = (headers = {}, method = "GET") => new Request("https://dev-public.example.org/contact/", { method, headers });
async function setup(staticPost = false, staticProof?: unknown, contentRedirect = false) {
  objects.clear(); store.get.mockClear(); getDecision.mockReset(); getDecision.mockImplementation(async () => decision);
  const ownerPath = "system/publicDeployment/noBuildPageOwners/contact";
  const owner = staticPost ? { operationId, sourceVersion: 6, snapshotDigest: "b".repeat(64), mode: "static", ...(staticProof ? { staticProof } : {}) } : { operationId, sourceVersion: 7, snapshotDigest };
  const sourcePath = "cmsPosts/contact", sourceDigest = "c".repeat(64);
  const metadataCore = { schemaVersion: 1, kind: "pair-public-source-metadata", members: [{ path: ownerPath, digest: protocol.publicReleaseDigest(owner) }, ...(staticPost ? [{ path: sourcePath, digest: sourceDigest }] : [])] };
  const frozenMetadata = new TextEncoder().encode(JSON.stringify({ ...metadataCore, digest: protocol.publicReleaseDigest(metadataCore) }));
  const metadataDigest = createHash("sha256").update(frozenMetadata).digest("hex");
  const frozenRoot = { schemaVersion: 2, kind: "pair-render-input", pairDigest: protocol.publicReleaseDigest(pair),
    source: { kind: "inventory", id: "baseline" }, scope: { kind: identity.kind, sourceOperationId: identity.sourceOperationId,
      sourceVersion: identity.sourceVersion, snapshotDigest, contextSequence: 0 }, cursor, snapshotFile: "snapshot.json",
    entryFiles: ["snapshot.json", "source-metadata.json"], files: [
      { name: "snapshot.json", digest: snapshotDigest, bytes: 1, objectKey: inputs.publicReleasePairInputObjectKey(pair, snapshotDigest), dependencies: [] },
      { name: "source-metadata.json", digest: metadataDigest, bytes: frozenMetadata.length,
        objectKey: inputs.publicReleasePairInputObjectKey(pair, metadataDigest), dependencies: [] } ] };
  const inputBytes = new TextEncoder().encode(JSON.stringify(inputs.parsePublicReleasePairInputRoot(frozenRoot, pair)));
  const inputDigest = createHash("sha256").update(inputBytes).digest("hex");
  identity = { ...identity, inputManifestDigest: inputDigest };
  for (const [key, bytes, digest] of [[inputs.publicReleasePairInputRootKey(pair, inputDigest), inputBytes, inputDigest],
    [inputs.publicReleasePairInputObjectKey(pair, metadataDigest), frozenMetadata, metadataDigest]] as const) {
    objects.set(key, { bytes, metadata: { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: digest } });
  }
  const bytes = contentRedirect ? new Uint8Array() : body, status = contentRedirect ? 302 as const : 200 as const;
  const manifest = await writePublicReleasePairView({ store, pair, identity, claimDigest, cursor,
    outputs: (async function* () { yield { path: "/contact/", status, bytes, headers: {
      "cache-control": "no-store", "content-type": "text/html", "x-njpbs-renderer-sha": pair.commitSha,
      ...(contentRedirect ? { location: "https://example.test/linked-page", "x-robots-tag": "noindex, nofollow" } : {}) } }; })() });
  const projection = { kind: staticPost ? "public-post-shadow" : "public-page", target: { documentId: "contact", sourceVersion: 7, rendererSha: pair.commitSha, pagePath: "/contact/" } };
  const receipt = { schemaVersion: 1, kind: "pair-render-target", identityDigest: protocol.publicReleaseDigest(identity),
    inputManifestDigest: identity.inputManifestDigest, path: "/contact/", method: "GET", source: { inputDigest: "1".repeat(64), provenanceDigest: "2".repeat(64) },
    target: { pair: pairReference(pair), pairDigest: protocol.publicReleaseDigest(pair), rendererSha: pair.commitSha,
      rendererDigest: pair.rendererDigest, readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest,
      projection, targetDigest: protocol.publicReleaseDigest(projection) } };
  const targetPage = await writePublicReleasePairClaimJson({ store, pair, identity, claimDigest, limit: 512 * 1024,
    value: { schemaVersion: 1, index: 0, targets: [{ receipt, bodyDigest: createHash("sha256").update(bytes).digest("hex"), status }] } });
  const targetProof = await writePublicReleasePairClaimJson({ store, pair, identity, claimDigest, limit: 256 * 1024,
    value: { schemaVersion: 1, kind: "pair-render-targets", pairDigest: protocol.publicReleaseDigest(pair), taskId: protocol.publicReleaseDigest(identity),
      claimDigest, viewManifestDigest: manifest.manifestDigest, inputManifestDigest: identity.inputManifestDigest, pages: [targetPage], targetCount: 1 } });
  decision = { kind: "decision", targetProof, epoch: 1, pairId: pair.pairId,
    contentHead: { pairId: pair.pairId, viewId: "view-one", manifestDigest: manifest.manifestDigest, contextSequence: 0 },
    locator: { pairDigest: protocol.publicReleaseDigest(pair), identity, claimDigest, manifestDigest: manifest.manifestDigest, manifestBytes: manifest.manifestBytes },
    route: { kind: "serve", family: staticPost ? "post" : "page", ...(staticPost ? { sourcePath, sourceDigest } : {}), id: "contact", operationId, sourceVersion: 7, snapshotDigest, canonicalPath: "/contact/", owner, ownerPath }, path: "/contact/", authorityDigest: "a".repeat(64) };
  store.get.mockClear();
}
beforeEach(() => setup());
it("serves and proves a sealed custom-link 302 with current route ownership for GET and HEAD", async () => {
  await setup(false, undefined, true);
  const router = createPublicReleaseRouter({ environment: "development", slots: [slot(), { identity: releasePair("b"), serve: vi.fn() }],
    readSelector: async () => selection() });
  for (const method of ["GET", "HEAD"]) {
    const response = await router.fetch(request({}, method));
    expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("https://example.test/linked-page");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow"); expect(await response.text()).toBe("");
  }
  const digest = createHash("sha256").update("").digest("hex");
  const proof = await router.prove(request(), digest, { status: 302 });
  expect(proof.status).toBe(302); expect(proof.headers.get("x-njpbs-publication-operation")).toBe(operationId);
  expect((await router.prove(request(), digest, { status: 200 })).status).toBe(503);
});
it("serves exact pair bytes with current owner checks on both sides and bounded R2 reads", async () => {
  const result = await slot().serve(request(), selection());
  expect(result.kind).toBe("response"); if (result.kind !== "response") return;
  expect(await result.response.text()).toBe(new TextDecoder().decode(body));
  expect(result.evidence?.operationId).toBe(operationId); expect(store.get).toHaveBeenCalledTimes(7);
  expect(getDecision).toHaveBeenCalledTimes(2); expect(result.response.headers.get("x-content-type-options")).toBe("nosniff");
});
it.each(["sourceVersion", "snapshotDigest", "operationId"] as const)("reselects when output differs from current %s", async field => {
  decision = { ...decision, route: { ...decision.route, [field]: field === "sourceVersion" ? 8 : "changed" } as typeof decision.route };
  expect(await slot().serve(request(), selection())).toEqual({ kind: "reselect" });
});
it("reselects when current ownership changes while bytes are being read", async () => {
  getDecision.mockResolvedValueOnce(decision).mockResolvedValue({ ...decision, authorityDigest: "b".repeat(64) });
  expect(await slot().serve(request(), selection())).toEqual({ kind: "reselect" });
});
it("refuses wrong deployed version and incarnation before reading bytes", async () => {
  const wrong = createPublicReleaseSlot({ pair, workerVersionId: releasePair("b").publicWorker.versionId, store, getDecision });
  await expect(wrong.serve(request(), selection())).rejects.toThrow(); expect(store.get).not.toHaveBeenCalled();
  await expect(slot().serve(request(), { ...selection(), selector: { ...selection().selector, selectedPair: pairReference(releasePair("b")) } })).rejects.toThrow();
});
it("serves current withdrawals and redirects without accessing obsolete bytes", async () => {
  decision = { ...decision, route: { ...decision.route, kind: "gone" } as typeof decision.route };
  const gone = await slot().serve(request(), selection()); expect(gone.kind === "response" && gone.response.status).toBe(410);
  expect(gone.kind === "response" && gone.response.headers.get("x-content-type-options")).toBe("nosniff");
  decision = { ...decision, route: { ...decision.route, kind: "redirect", canonicalPath: "/current/" } as typeof decision.route };
  const alias = await slot().serve(request(), selection()); expect(alias.kind === "response" && alias.response.headers.get("location")).toBe("/current/");
  expect(alias.kind === "response" && alias.response.headers.get("strict-transport-security")).toContain("max-age");
  expect(store.get).not.toHaveBeenCalled();
});
it("covers GET/HEAD, range, conditionals and security headers", async () => {
  const full = await slot().serve(request(), selection()); if (full.kind !== "response") throw new Error("No full reply");
  const etag = full.response.headers.get("etag")!;
  for (const [headers, method, status] of [[{}, "HEAD", 200], [{ range: "bytes=0-3" }, "GET", 206],
    [{ range: "bytes=999-" }, "GET", 416], [{ "if-none-match": etag }, "GET", 304], [{ "if-match": '"wrong"' }, "GET", 412],
    [{ range: "bytes=0-3", "if-range": '"wrong"' }, "GET", 200]] as const) {
    const result = await slot().serve(request(headers, method), selection()); if (result.kind !== "response") throw new Error("No response");
    expect(result.response.status).toBe(status);
    if (method === "HEAD") expect(await result.response.text()).toBe("");
    if (status === 206) expect(await result.response.text()).toBe("<!do");
    expect(result.response.headers.get("x-content-type-options")).toBe("nosniff");
  }
});
it("refuses corrupt object bytes and metadata without returning an old body", async () => {
  const object = [...objects.values()].find(value => value.bytes.length === body.length)!; object.bytes[0] ^= 1;
  await expect(slot().serve(request(), selection())).rejects.toThrow();
});
it("isolates the exact root, claim, source and incarnation", async () => {
  for (const locator of [{ ...decision.locator, claimDigest: "0".repeat(64) }, { ...decision.locator, pairDigest: "0".repeat(64) },
    { ...decision.locator, identity: { ...identity, pair: pairReference(releasePair("b")) } }]) {
    await expect(readPublicReleasePairOutput({ store, pair, locator, path: "/contact/" })).rejects.toThrow();
  }
});
it("provides complete private proof evidence while ordinary viewers get no proof", async () => {
  const router = createPublicReleaseRouter({ environment: "development", slots: [slot(), { identity: releasePair("b"), serve: vi.fn() }], readSelector: async () => selection() });
  const expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), b => b.toString(16).padStart(2, "0")).join("");
  const normal = await router.fetch(request()); expect(normal.headers.has("x-njpbs-publication-operation")).toBe(false);
  const proof = await router.prove(request(), expected); expect(proof.status).toBe(200);
  expect(proof.headers.get("x-njpbs-publication-operation")).toBe(operationId);
  expect(proof.headers.get("x-njpbs-release-pair")).toBe(pair.pairId);
  expect(proof.headers.get("x-njpbs-content-head-sha256")).toBe(decision.contentHead.manifestDigest);
});
it.each([["gone", 410], ["redirect", 308]] as const)("proves a current %s with native status and fresh owner evidence", async (kind, status) => {
  decision = { ...decision, route: { ...decision.route, kind, canonicalPath: "/current/" } as typeof decision.route };
  const router = createPublicReleaseRouter({ environment: "development", slots: [slot(), { identity: releasePair("b"), serve: vi.fn() }], readSelector: async () => selection() });
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array())), b => b.toString(16).padStart(2, "0")).join("");
  const proof = await router.prove(request(), digest, { status });
  expect(proof.status).toBe(status); expect(proof.headers.get("x-njpbs-publication-operation")).toBe(operationId);
  expect(proof.headers.get("x-njpbs-html-sha256")).toBe(digest); expect(await proof.text()).toBe("");
  if (status === 308) expect(proof.headers.get("location")).toBe("/current/");
  expect((await router.prove(request(), digest)).status).toBe(503);
  expect(store.get).not.toHaveBeenCalled();
});
it("rechecks an absent route after storage I/O and reselects when ownership changes", async () => {
  decision = { ...decision, path: "/missing/", route: { kind: "unowned" } };
  const missing = new Request("https://dev-public.example.org/missing/");
  const result = await slot().serve(missing, selection());
  expect(result.kind === "response" && result.response.status).toBe(404); expect(getDecision).toHaveBeenCalledTimes(2);
  getDecision.mockReset(); getDecision.mockResolvedValueOnce(decision).mockResolvedValue({ ...decision, authorityDigest: "e".repeat(64) });
  expect(await slot().serve(missing, selection())).toEqual({ kind: "reselect" });
});
it.each(["/bad%xy/", "/a+b/", "/foo%20bar/", "/x//y", "/assets/cafe%CC%81.svg", "/_pair-compiled/server.js"])("returns 404 before authority for malformed/private path %s", async path => {
  const result = await slot().serve(new Request(`https://dev-public.example.org${path}`), selection());
  expect(result.kind === "response" && result.response.status).toBe(404); expect(getDecision).not.toHaveBeenCalled();
  expect(result.kind === "response" && result.response.headers.get("x-content-type-options")).toBe("nosniff");
});
it("verifies Home JSON against its real frozen json-renderer input without a target receipt", async () => {
  const catalog = { schemaVersion: 1, source: "frozen Home catalog", sources: [] };
  const rawRequest = { schemaVersion: 1, read: catalog, homeSourcesFile: null, resources: [] };
  const rootKey = inputs.publicReleasePairInputRootKey(pair, identity.inputManifestDigest);
  const root = JSON.parse(new TextDecoder().decode(objects.get(rootKey)!.bytes));
  const owner = { operationId, sourceVersion: 7, snapshotDigest }, ownerPath = "system/publicDeployment/noBuildPageOwners/home";
  const metadataCore = { schemaVersion: 1, kind: "pair-public-source-metadata", members: [{ path: ownerPath, digest: protocol.publicReleaseDigest(owner) }] };
  const frozenFiles = [
    ["source-metadata.json", { ...metadataCore, digest: protocol.publicReleaseDigest(metadataCore) }],
    ["render-plan.json", { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), snapshotDigest,
      renderedAt: "2026-10-28T12:00:00.000Z", expectedOutputs: [{ path: "/_home-sources.json", status: 200, contentType: "application/json; charset=utf-8" }],
      routes: [{ path: "/_home-sources.json", renderer: "json", method: "GET", inputFile: "routes/home-sources.json", dependencies: [] }] }],
    ["routes/home-sources.json", rawRequest],
  ] as const;
  root.files = root.files.filter((file: any) => file.name !== "source-metadata.json");
  for (const [name, value] of frozenFiles) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)), digest = createHash("sha256").update(bytes).digest("hex"), objectKey = inputs.publicReleasePairInputObjectKey(pair, digest);
    root.files.push({ name, digest, bytes: bytes.length, objectKey, dependencies: [] });
    objects.set(objectKey, { bytes, metadata: { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: digest } });
  }
  root.files.sort((a: any, b: any) => a.name < b.name ? -1 : 1); root.entryFiles = root.files.map((file: any) => file.name);
  const rootBytes = new TextEncoder().encode(JSON.stringify(inputs.parsePublicReleasePairInputRoot(root, pair))), digest = createHash("sha256").update(rootBytes).digest("hex");
  objects.set(inputs.publicReleasePairInputRootKey(pair, digest), { bytes: rootBytes, metadata: { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: digest } });
  identity = { ...identity, inputManifestDigest: digest };
  const serve = async (jsonBody: string) => {
    const manifest = await writePublicReleasePairView({ store, pair, identity, claimDigest, cursor,
      outputs: (async function* () { yield { path: "/_home-sources.json", status: 200 as const, bytes: new TextEncoder().encode(jsonBody),
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-njpbs-renderer-sha": pair.commitSha } }; })() });
    decision = { ...decision, path: "/_home-sources.json", targetProof: null,
      contentHead: { ...decision.contentHead, manifestDigest: manifest.manifestDigest },
      locator: { ...decision.locator, identity, manifestDigest: manifest.manifestDigest, manifestBytes: manifest.manifestBytes },
      route: { kind: "serve", family: "page", id: "home", operationId, sourceVersion: 7, snapshotDigest, canonicalPath: "/", ownerPath, owner } };
    return slot().serve(new Request("https://dev-public.example.org/_home-sources.json"), selection());
  };
  const result = await serve(JSON.stringify(catalog));
  expect(result.kind === "response" && await result.response.json()).toEqual(catalog);
  const mismatched = { ...decision, contentHead: { ...decision.contentHead, contextSequence: 1 },
    locator: { ...decision.locator, identity: { ...decision.locator.identity, contextSequence: 1 } } };
  expect(await verifyPairRouteTarget({ store, pair, decision: mismatched, output: { path: "/_home-sources.json", status: 200,
    bodyDigest: createHash("sha256").update(JSON.stringify(catalog)).digest("hex") } })).toBe(false);
  expect(await serve('{"changed":true}')).toEqual({ kind: "reselect" });
});

it("rechecks withdrawal after a pending cache write completes", async () => {
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => { started(); await pending; }) };
  const serving = createPublicReleaseSlot({ pair, workerVersionId: pair.publicWorker.versionId, store, getDecision, cache });
  const result = serving.serve(request(), selection());
  await entered;
  expect(getDecision).toHaveBeenCalledTimes(1);
  decision = { ...decision, route: { ...decision.route, kind: "gone" } as typeof decision.route, authorityDigest: "f".repeat(64) };
  release();
  expect(await result).toEqual({ kind: "reselect" });
  expect(getDecision).toHaveBeenCalledTimes(2);
});

it("binds a static Post's current source and render target while retaining its original owner identity", async () => {
  await setup(true);
  const result = await slot().serve(request(), selection());
  expect(result.kind === "response" && result.response.status).toBe(200);
  expect(result.kind === "response" && result.evidence?.sourceVersion).toBe(7);
  decision = { ...decision, route: { ...decision.route, sourceDigest: "0".repeat(64) } as typeof decision.route };
  expect(await slot().serve(request(), selection())).toEqual({ kind: "reselect" });
});
it("serves a composed head's original verified view and binds proof to the selection head", async () => {
  const expected = createHash("sha256").update(body).digest("hex");
  decision = { ...decision, contentHead: { ...decision.contentHead, viewId: "b".repeat(64), manifestDigest: "c".repeat(64) },
    composition: { artifactPath: "/contact/", expectedBodyDigest: expected, absent: false, witnessDigest: "b".repeat(64) } };
  const result = await slot().serve(request(), selection());
  expect(result.kind === "response" && await result.response.text()).toBe(new TextDecoder().decode(body));
  expect(result.kind === "response" && result.evidence?.manifestDigest).toBe("c".repeat(64));
  decision = { ...decision, composition: { ...decision.composition!, expectedBodyDigest: "0".repeat(64) } };
  await expect(slot().serve(request(), selection())).rejects.toThrow();
});
it("keeps a composed namespace absence from reading any retained baseline body", async () => {
  decision = { ...decision, path: "/pagefind/old.pf_fragment", route: { kind: "unowned" },
    contentHead: { ...decision.contentHead, viewId: "b".repeat(64), manifestDigest: "c".repeat(64) },
    composition: { artifactPath: "/pagefind/old.pf_fragment", expectedBodyDigest: null, absent: true, witnessDigest: "b".repeat(64) } };
  const result = await slot().serve(new Request("https://dev-public.example.org/pagefind/old.pf_fragment"), selection());
  expect(result.kind === "response" && result.response.status).toBe(404); expect(store.get).not.toHaveBeenCalled();
  expect(getDecision).toHaveBeenCalledTimes(2);
});

it.each(["equal", "body", "mime", "status", "header"])("keeps baseline selection and requires exact current-head equality: %s", async variant => {
  const current = decision.locator;
  const manifest = await writePublicReleasePairView({ store, pair, identity, claimDigest: "9".repeat(64), cursor,
    outputs: (async function* () { yield { path: "/contact/index.html", status: variant === "status" ? 410 as const : 200 as const,
      bytes: variant === "body" ? new TextEncoder().encode("different") : body,
      headers: { ...(variant === "header" ? { "x-robots-tag": "noindex" } : {}), "cache-control": "no-store", "content-type": variant === "mime" ? "text/plain" : "text/html", "x-njpbs-renderer-sha": pair.commitSha } }; })() });
  decision = { ...decision, locator: { ...current, claimDigest: "9".repeat(64), manifestDigest: manifest.manifestDigest, manifestBytes: manifest.manifestBytes },
    contentHead: { ...decision.contentHead, viewId: "b".repeat(64), manifestDigest: "c".repeat(64) },
    composition: { artifactPath: "/contact/index.html", expectedBodyDigest: null, absent: false, witnessDigest: "b".repeat(64), proofLocator: current } };
  const result = await slot().serve(request(), selection());
  if (variant === "equal") {
    expect(result.kind === "response" && await result.response.text()).toBe(new TextDecoder().decode(body));
    expect(result.kind === "response" && result.evidence?.manifestDigest).toBe("c".repeat(64));
  } else expect(result).toEqual({ kind: "reselect" });
});

it("refuses a selected composed member missing from its original view instead of inventing absence", async () => {
  decision = { ...decision, path: "/assets/missing.js", route: { kind: "unowned" },
    contentHead: { ...decision.contentHead, viewId: "b".repeat(64), manifestDigest: "c".repeat(64) },
    composition: { artifactPath: "/assets/missing.js", expectedBodyDigest: "d".repeat(64), absent: false, witnessDigest: "b".repeat(64) } };
  await expect(slot().serve(new Request("https://dev-public.example.org/assets/missing.js"), selection())).rejects.toThrow();
});

const staticProof = () => ({ schemaVersion: 1, postId: "contact", operationId, sourceVersion: 6, visible: true,
  slug: "contact", ownedSlugs: ["contact"], snapshotDigest: "b".repeat(64), contextDigest: "a".repeat(64),
  files: ["/posts/", "/posts/contact/", "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js", "/search/meaning-index.json",
    "/_publication.json", "/_content-status.json", "/sitemap-index.xml"].map(path => ({ path, bytes: 1, digest: "f".repeat(64) })) });
it("serves legacy H owner bodies after the live projection starts retaining a validated static proof", async () => {
  await setup(true);
  const owner = sourceBody.publicReleaseAuthorityProjection({ ...decision.route.owner, staticProof: staticProof() });
  expect(owner.staticProof).toEqual(staticProof());
  decision = { ...decision, route: { ...decision.route, owner } as typeof decision.route };
  expect((await slot().serve(request(), selection())).kind).toBe("response");
  const original = decision;
  decision = { ...original, route: { ...original.route, owner: { ...owner, sourceVersion: 99 } } as typeof original.route };
  expect(await slot().serve(request(), selection())).toEqual({ kind: "reselect" });
  decision = { ...original, route: { ...original.route, sourceDigest: "0".repeat(64) } as typeof original.route };
  expect(await slot().serve(request(), selection())).toEqual({ kind: "reselect" });
});
it("requires the exact retained static proof when the H owner body includes it", async () => {
  const proof = staticProof(); await setup(true, proof);
  expect((await slot().serve(request(), selection())).kind).toBe("response");
  decision = { ...decision, route: { ...decision.route, owner: { ...decision.route.owner,
    staticProof: { ...proof, contextDigest: "c".repeat(64) } } } as typeof decision.route };
  expect(await slot().serve(request(), selection())).toEqual({ kind: "reselect" });

});
