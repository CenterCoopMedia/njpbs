import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { releasePair, releaseSelector, pairReference } from "./helpers/private-public-release-pair.js";
import protocol from "../functions/lib/public-release-pair.js";
import { writePublicReleasePairView } from "../site/scripts/public-release-pair-view-storage";
import { readPairCodeAssetIndex, routingPrefix, serveRetainedPairCodeAsset } from "../workers/src/public-release-code-assets";
import { committedRecoveryKey, readCommittedPairRecovery, recordCommittedPairRecovery, serveCommittedPairRecovery } from "../workers/src/public-release-recovery";
import type { PairTaskIdentity } from "../functions/lib/public-release-pair-work";
const hash = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);
const now = () => 1000;
const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; etag: string }>();
let counter = 0;
const store = {
  async put(key: string, body: Uint8Array, options: any) {
    const prior = objects.get(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && prior || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== prior?.etag) return null;
    const row = { bytes: new Uint8Array(body), metadata: options.customMetadata, etag: String(++counter) }; objects.set(key, row); return { etag: row.etag };
  },
  get: vi.fn(async (key: string) => { const row = objects.get(key); return row ? {
    size: row.bytes.length, customMetadata: row.metadata, etag: row.etag, body: new Blob([new Uint8Array(row.bytes)]).stream() } : null; }),
};
const json = async (key: string, value: unknown) => store.put(key, bytes(JSON.stringify(value)), { customMetadata: {} });
let pairs: ReturnType<typeof releasePair>[];
async function prepare(slot: string, environment: "development" | "production" = "development") {
  const files = [ { path: "/_astro/app.abcdef12.js", body: bytes("export const current = true;"), family: "clientAsset", mime: "application/javascript; charset=utf-8", source: "compiled" },
    { path: "/contact/index.html", body: bytes("<html>safe baseline</html>"), family: "fallbackAsset", mime: "text/html; charset=utf-8", source: "static" },
    { path: "/pagefind/old.pf_fragment", body: bytes("old search"), family: "searchIndex", mime: "application/octet-stream", source: "aggregate" } ];
  const members = files.map(file => ({ path: file.path, mime: file.mime, size: file.body.length, sha256: hash(file.body), family: file.family, source: file.source,
    dynamic: file.family === "searchIndex" }));
  const pair = { ...releasePair(slot), environment, codeAssetManifestDigest: hash(JSON.stringify(members)) };
  const identity: PairTaskIdentity = { schemaVersion: 2, pair: pairReference(pair), kind: "qualification", sourceOperationId: "baseline", sourceVersion: 1,
    snapshotDigest: "a".repeat(64), contextSequence: 0, inputManifestDigest: "b".repeat(64) };
  const claimDigest = "c".repeat(64);
  const view = await writePublicReleasePairView({ store, pair, identity, claimDigest, cursor: { baselineDigest: "d".repeat(64), sequence: 0, lastDigest: "d".repeat(64) },
    outputs: (async function* () { for (const file of files) yield { path: file.path, status: 200 as const, bytes: file.body,
      headers: { "cache-control": "no-store", "content-type": file.mime, "x-njpbs-renderer-sha": pair.commitSha } }; })() });
  await json(`${routingPrefix(pair)}code-assets-v1.json`, { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), codeAssetManifestDigest: pair.codeAssetManifestDigest,
    view: { pairDigest: protocol.publicReleaseDigest(pair), identity, claimDigest, manifestDigest: view.manifestDigest, manifestBytes: view.manifestBytes }, members });
  await json(`${routingPrefix(pair)}lifecycle-v1.json`, { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), status: "retained", validUntil: 10_000 });
  await json(`${routingPrefix(pair)}namespace-v1.json`, { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), revision: 1, validUntil: 10_000,
    routes: [{ path: "/contact/", state: "fallback", canonicalPath: "/contact/" }] });
  return pair;
}
const request = (path = "/contact/", headers = {}, method = "GET") => new Request(`https://dev-public.example.org${path}`, { method, headers });
const selection = () => ({ environment: "development" as const, selector: releaseSelector(), readStartedAt: 1000 });
beforeEach(async () => { objects.clear(); counter = 0; pairs = [await prepare("a"), await prepare("b")]; store.get.mockClear(); });
it("reads exact OLD dependencies after selection changes without consulting selector authority", async () => {
  const response = await serveRetainedPairCodeAsset({ store, pairs: [...pairs].reverse(), request: request("/_astro/app.abcdef12.js"), now });
  expect(await response!.text()).toBe("export const current = true;"); expect(response!.headers.has("x-njpbs-renderer-sha")).toBe(false);
  expect(await serveRetainedPairCodeAsset({ store, pairs, request: request("/pagefind/old.pf_fragment"), now })).toBeNull();
  expect(await serveRetainedPairCodeAsset({ store, pairs, request: request("/_pair-compiled/server.js"), now })).toBeNull();
});
it("never exposes candidate assets and refuses missing, corrupt or expired authority", async () => {
  for (const pair of pairs) await json(`${routingPrefix(pair)}lifecycle-v1.json`, { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), status: "candidate", validUntil: 10_000 });
  expect(await serveRetainedPairCodeAsset({ store, pairs, request: request("/_astro/app.abcdef12.js"), now })).toBeNull();
  objects.delete(`${routingPrefix(pairs[0])}lifecycle-v1.json`);
  expect(await serveRetainedPairCodeAsset({ store, pairs, request: request("/_astro/app.abcdef12.js"), now })).toBeNull();
});
it("stores committed recovery with fresh authority on both sides and works in a cold isolate", async () => {
  const readSelector = vi.fn(async () => selection());
  await recordCommittedPairRecovery({ store, environment: "development", pairs, readSelector, now });
  expect(readSelector).toHaveBeenCalledTimes(2);
  const recovered = await readCommittedPairRecovery({ store, environment: "development", pairs, now });
  const response = await serveCommittedPairRecovery({ store, pairs, request: request(), selection: recovered, now });
  expect(await response!.text()).toBe("<html>safe baseline</html>"); expect(response!.headers.get("publication-refresh")).toBe("pending");
  expect(response!.headers.has("x-njpbs-html-sha256")).toBe(false);
  expect(await serveCommittedPairRecovery({ store, pairs, request: request("/unknown/"), selection: recovered, now })).toBeNull();
});
it("refuses epoch changes during capture and never rewrites a newer durable selector", async () => {
  const readSelector = vi.fn().mockResolvedValueOnce(selection()).mockResolvedValue({ ...selection(), selector: { ...releaseSelector(), epoch: 2 } });
  await expect(recordCommittedPairRecovery({ store, environment: "development", pairs, readSelector, now })).rejects.toThrow();
  expect(objects.has(committedRecoveryKey("development"))).toBe(false);
  await recordCommittedPairRecovery({ store, environment: "development", pairs, readSelector: async () => ({ ...selection(), selector: { ...releaseSelector(), epoch: 2 } }), now });
  await expect(recordCommittedPairRecovery({ store, environment: "development", pairs, readSelector: async () => selection(), now })).rejects.toThrow();
});
it("captures production OLD then NEW through the native conditional owner without changing selector authority", async () => {
  objects.clear();
  const productionPairs = [await prepare("a", "production"), await prepare("b", "production")];
  const old = { ...releaseSelector(), selectedPair: pairReference(productionPairs[0]), recoveryPair: pairReference(productionPairs[1]) };
  const next = { ...old, epoch: 2, selectedPair: pairReference(productionPairs[1]), recoveryPair: pairReference(productionPairs[0]),
    activeCommitSha: productionPairs[1].commitSha, contentHead: { ...old.contentHead, pairId: productionPairs[1].pairId } };
  for (const selector of [old, next]) {
    const authority = { environment: "production" as const, selector, readStartedAt: now() };
    await recordCommittedPairRecovery({ store, environment: "production", pairs: productionPairs, readSelector: async () => authority, now });
    expect(await readCommittedPairRecovery({ store, environment: "production", pairs: productionPairs, now })).toEqual(authority);
    expect(JSON.parse(new TextDecoder().decode(objects.get(committedRecoveryKey("production"))!.bytes)).selectorDigest)
      .toBe(protocol.publicReleaseDigest(selector));
  }
  expect(objects.has(committedRecoveryKey("development"))).toBe(false);
  await expect(recordCommittedPairRecovery({ store, environment: "production", pairs: productionPairs,
    readSelector: async () => ({ environment: "production", selector: old, readStartedAt: now() }), now })).rejects.toThrow();
});
it("preserves withdrawals during an outage and refuses retirement, unavailable namespace and stale recovery", async () => {
  await recordCommittedPairRecovery({ store, environment: "development", pairs, readSelector: async () => selection(), now });
  const pair = pairs[0], namespace = `${routingPrefix(pair)}namespace-v1.json`;
  await json(namespace, { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), revision: 2, validUntil: 10_000,
    routes: [{ path: "/contact/", state: "gone", canonicalPath: "/contact/" }] });
  expect((await serveCommittedPairRecovery({ store, pairs, request: request(), selection: selection(), now }))!.status).toBe(410);
  objects.delete(namespace);
  await expect(serveCommittedPairRecovery({ store, pairs, request: request(), selection: selection(), now })).rejects.toThrow();
  await json(`${routingPrefix(pair)}lifecycle-v1.json`, { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), status: "retired", validUntil: 10_000 });
  await expect(serveCommittedPairRecovery({ store, pairs, request: request(), selection: selection(), now })).rejects.toThrow();
  await expect(readCommittedPairRecovery({ store, environment: "development", pairs, now: () => 24 * 60 * 60 * 1000 + 1001 })).rejects.toThrow();
});
it("covers HEAD, ranges, conditionals and verified immutable MIME without editorial proof", async () => {
  const read = (headers = {}, method = "GET") => serveRetainedPairCodeAsset({ store, pairs, request: request("/_astro/app.abcdef12.js", headers, method), now });
  const full = (await read())!, etag = full.headers.get("etag")!;
  expect(full.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  expect((await read({ "if-none-match": etag }))!.status).toBe(304);
  expect((await read({ range: "bytes=0-5" }))!.status).toBe(206);
  expect(await (await read({}, "HEAD"))!.text()).toBe("");
});
it("refuses a changed inventory and corrupt retained body", async () => {
  const pair = pairs[0];
  const index = await readPairCodeAssetIndex(store, pair);
  const member = index.members[0];
  const outputObject = [...objects.values()].find(row => hash(row.bytes) === member.sha256)!; outputObject.bytes[0] ^= 1;
  await expect(serveRetainedPairCodeAsset({ store, pairs: [pair], request: request(member.path), now })).rejects.toThrow();
  const roster = JSON.parse(new TextDecoder().decode(objects.get(`${routingPrefix(pair)}code-assets-v1.json`)!.bytes)); roster.members[0].mime = "text/html";
  await json(`${routingPrefix(pair)}code-assets-v1.json`, roster);
  await expect(readPairCodeAssetIndex({ ...store }, pair)).rejects.toThrow();
});
it("renews expired advisory records and permits a rotated configured pair set", async () => {
  await recordCommittedPairRecovery({ store, environment: "development", pairs, readSelector: async () => selection(), now });
  const later = () => 24 * 60 * 60 * 1000 + 2000;
  for (const pair of pairs) await json(`${routingPrefix(pair)}lifecycle-v1.json`, {
    schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), status: "retained", validUntil: later() + 10_000 });
  await recordCommittedPairRecovery({ store, environment: "development", pairs, readSelector: async () => selection(), now: later });
  expect((await readCommittedPairRecovery({ store, environment: "development", pairs, now: later })).selector.epoch).toBe(1);
  const switched = { ...releaseSelector(), epoch: 2, selectedPair: pairReference(pairs[1]), recoveryPair: pairReference(pairs[0]),
    activeCommitSha: pairs[1].commitSha, contentHead: { ...releaseSelector().contentHead, pairId: pairs[1].pairId } };
  await recordCommittedPairRecovery({ store, environment: "development", pairs: [pairs[1]], readSelector: async () => ({ ...selection(), selector: switched }), now: later });
  expect((await readCommittedPairRecovery({ store, environment: "development", pairs: [pairs[1]], now: later })).selector.epoch).toBe(2);
});
it("coalesces immutable index reads per isolate while rechecking lifecycle on every request", async () => {
  const freshStore = { ...store, get: vi.fn(store.get) };
  await Promise.all(Array.from({ length: 10 }, () => readPairCodeAssetIndex(freshStore, pairs[0])));
  expect(freshStore.get.mock.calls.filter(([key]) => key.endsWith("code-assets-v1.json"))).toHaveLength(1);
  await serveRetainedPairCodeAsset({ store: freshStore, pairs: [pairs[0]], request: request("/_astro/app.abcdef12.js"), now });
  expect(freshStore.get.mock.calls.filter(([key]) => key.endsWith("code-assets-v1.json"))).toHaveLength(1);
  expect(freshStore.get.mock.calls.filter(([key]) => key.endsWith("lifecycle-v1.json"))).toHaveLength(2);
});
