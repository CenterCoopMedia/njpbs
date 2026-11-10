import { createHash } from "node:crypto";
import work from "../../functions/lib/public-release-pair-work.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { privateReaderFixture } from "../helpers/private-pair-reader-fixture";
import { verifyPairViewRemoteBytes, verifyPairNamespaceRemoteAbsence, type QualifiedByteEvidence } from "../../site/scripts/public-release-pair-qualification-bytes";
import { readQualificationCodePack, openQualificationInput } from "../../site/scripts/public-release-pair-qualification-inputs";
import { createQualificationEvidenceWriter, readQualificationEvidence } from "../../site/scripts/public-release-pair-qualification-evidence";
import type { PairViewOutputInput } from "../../site/scripts/public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import { createExternalContentManifest, createExternalContentStaticFeed } from "../../site/src/lib/external-content-feed";
import { parsePublicReleasePairContentFeedNamespace, assertPublicReleasePairContentFeedIndex } from "../../site/scripts/public-release-pair-content-feed-namespace";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const row = (path: string, status: 200 | 308 | 410 = 200, body = `actual ${path}`): PairViewOutputInput => ({ path, status,
  headers: { "content-type": "application/octet-stream", "cache-control": "no-store", ...(status === 308 ? { location: "/current/" } : {}) },
  bytes: status === 308 ? new Uint8Array() : encode(body) });
const rows = [row("/_astro/main.js"), row("/_home-sources.json"), row("/current/"), row("/old/", 308), row("/withdrawn/", 410, "")];
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, bucket: R2Bucket;
let fixture: Awaited<ReturnType<typeof privateReaderFixture>> | undefined;
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-qualification-bytes.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "qualification-byte-test", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "qualification-views" } } } }] });
  bucket = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  const objects = await bucket.list(); if (objects.objects.length) await bucket.delete(objects.objects.map(row => row.key));
});
afterEach(async () => { await fixture?.close(); fixture = undefined; });
afterAll(async () => { await runtime?.dispose(); });
async function prepare(values = rows) { fixture = await privateReaderFixture(db, bucket, values); return fixture; }
const expectation = (values: PairViewOutputInput[]) => new Map(values.map(value => [value.path,
  { bodyDigest: sha(value.bytes), status: value.status, bytes: value.bytes.byteLength, mime: value.headers["content-type"], location: value.headers.location ?? null }]));
function verify(values = rows, overrides = {}) {
  if (!fixture) throw new Error("Missing fixture");
  const evidence: QualifiedByteEvidence[] = [];
  return verifyPairViewRemoteBytes({ ...fixture, expected: expectation(values), stagedReadbackDigest: fixture.staged.readbackDigest,
    evidence: async row => { evidence.push(row); }, signal: AbortSignal.timeout(20_000), ...overrides }).then(result => ({ result, evidence }));
}
it("compares actual remote bytes for code/aggregate/current/alias/withdrawn outputs with the settled manifest", async () => {
  const prepared = await prepare(); const before = (await db.doc("system/publicDeployment").get()).data();
  const { result, evidence } = await verify();
  expect(prepared.received).toBe(1); expect(result.outputCount).toBe(5);
  expect(evidence.map(row => [row.path, row.bodyDigest])).toEqual(rows.map(row => [row.path, sha(row.bytes)]));
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
});
it("rejects a 200 remote body even when the remote changes its own size and digest consistently", async () => {
  const prepared = await prepare(); prepared.setTransform(async response => {
    const value = await response.json() as any, wrong = encode("wrong remote bytes");
    value.outputs[0].bytes = wrong.byteLength; value.outputs[0].bodyDigest = sha(wrong); value.outputs[0].bodyBase64 = Buffer.from(wrong).toString("base64");
    return new Response(JSON.stringify(value), { headers: response.headers });
  });
  await expect(verify()).rejects.toThrow("reader-mismatch");
});
it("partitions 65 actual remote reads into bounded 32-route batches", async () => {
  const values = Array.from({ length: 65 }, (_, index) => row(`/route-${String(index).padStart(3, "0")}/`));
  const prepared = await prepare(values), { result } = await verify(values);
  expect(result.batches).toBe(3); expect(prepared.received).toBe(3); expect(result.outputCount).toBe(65);
});
it("partitions by actual body bytes as well as count", async () => {
  const values = [row("/large-one.bin"), row("/large-two.bin")];
  for (const value of values) value.bytes = new Uint8Array(9 * 1024 * 1024);
  const prepared = await prepare(values), { result } = await verify(values);
  expect(result.batches).toBe(2); expect(prepared.received).toBe(2); expect(result.outputBytes).toBe(18 * 1024 * 1024);
});
it("reads exact NFC artifact names in shared UTF-8 order, including an empty 200 file", async () => {
  const values = [row("/artifact-\ue000.bin"), row("/artifact-\u{10000}.bin")];
  values[0].bytes = new Uint8Array();
  const prepared = await prepare(values), signal = AbortSignal.timeout(20_000), witnessDigest = "d".repeat(64);
  const writer = createQualificationEvidenceWriter({ store: bucket, pair: prepared.pair, qualificationId: "utf8-artifacts", witnessDigest, signal });
  const { result } = await verify(values, { evidence: async (row: QualifiedByteEvidence) => writer.append({ kind: "baseline", ...row }) });
  const root = await writer.finish(), evidence = [];
  for await (const row of readQualificationEvidence({ store: bucket, pair: prepared.pair, qualificationId: "utf8-artifacts", witnessDigest, ...root, signal })) evidence.push(row);
  expect(prepared.received).toBe(1); expect(result.outputCount).toBe(2);
  expect(evidence.map(row => [row.path, row.status, row.bytes])).toEqual(values.map(row => [row.path, row.status, row.bytes.length]));
});
it("checks the actual zero-page feed index after HTTP byte equality", async () => {
  const { index } = createExternalContentStaticFeed(createExternalContentManifest({ site: "https://www.njpbs.org",
    posts: [], programs: [], authors: [], recordCards: [] }));
  const indexRow = row("/api/v1/content.json", 200, JSON.stringify(index) + "\n");
  indexRow.headers["content-type"] = "application/json; charset=utf-8";
  const values = [indexRow], prepared = await prepare(values);
  const manifest = parsePublicReleasePairContentFeedNamespace({ schemaVersion: 1, kind: "pair-content-feed-namespace",
    namespace: "/api/v1/content/", pairDigest: protocol.publicReleaseDigest(prepared.pair),
    inputManifestDigest: prepared.selectedView.identity.inputManifestDigest, cursor: prepared.captured.cursor,
    index: { path: indexRow.path, mime: indexRow.headers["content-type"], size: indexRow.bytes.length, sha256: sha(indexRow.bytes), pageCount: 0 },
    members: [] },
    prepared.pair, prepared.selectedView.identity);
  const expected = new Map([...expectation(values)].map(([path, value]) => [path, { ...value,
    ...(path === indexRow.path ? { verifyBody: (body: Uint8Array) => { assertPublicReleasePairContentFeedIndex(body, manifest); } } : {}) }]));
  expect((await verify(values, { expected })).result.outputCount).toBe(1);
  expect(prepared.received).toBe(1);
});
it.each(["missing", "digest", "status", "mime", "location", "staged"])("refuses %s expected evidence", async mode => {
  await prepare(); const expected = expectation(rows);
  if (mode === "missing") expected.set("/absent/", { ...expected.get("/current/")! });
  else if (mode !== "staged") {
    const path = mode === "location" ? "/old/" : "/current/", before = expected.get(path)!;
    expected.set(path, { ...before, ...(mode === "digest" ? { bodyDigest: "f".repeat(64) } : mode === "status" ? { status: 410 }
      : mode === "mime" ? { mime: "text/html" } : { location: "/wrong/" }) });
  }
  await expect(verify(rows, { expected, ...(mode === "staged" ? { stagedReadbackDigest: "e".repeat(64) } : {}) })).rejects.toThrow();
});
it("writes and reads back paged immutable per-route evidence, without creating a qualification or selector", async () => {
  const prepared = await prepare(), signal = AbortSignal.timeout(20_000);
  const proof = createQualificationEvidenceWriter({ store: bucket, pair: prepared.pair, qualificationId: "qualify-one", witnessDigest: "d".repeat(64), signal });
  await verify(rows, { evidence: async (output: QualifiedByteEvidence) => proof.append({ kind: "content", ...output }) });
  const result = await proof.finish(), object = await bucket.get(result.evidenceKey), bytes = new Uint8Array(await object!.arrayBuffer());
  expect(sha(bytes)).toBe(result.evidenceDigest); const root = JSON.parse(new TextDecoder().decode(bytes));
  expect(root.pages).toHaveLength(1); expect(root.outputCount).toBe(5);
  const retained = []; for await (const row of readQualificationEvidence({ store: bucket, pair: prepared.pair, qualificationId: "qualify-one",
    witnessDigest: "d".repeat(64), ...result, signal })) retained.push(row);
  expect(retained.map(row => row.path)).toEqual(rows.map(row => row.path));
  const page = await bucket.get(result.evidenceKey.replace(/roots\/.+$/, `pages/${root.pages[0].digest}.json`));
  expect(JSON.parse(await page!.text()).outputs.map((row: QualifiedByteEvidence) => row.path)).toEqual(rows.map(row => row.path));
  expect((await db.collection(`${work.publicReleasePairPath(prepared.pair.pairId)}/qualifications`).get()).empty).toBe(true);
});
it("pages 257 evidence records, preserves claims, and refuses a corrupt conditional retry", async () => {
  const prepared = await prepare(), signal = AbortSignal.timeout(20_000);
  const values = Array.from({ length: 257 }, (_, index) => ({ kind: "content" as const, path: `/proof-${String(index).padStart(3, "0")}/`,
    manifestDigest: prepared.selectedView.manifestDigest, claimDigest: prepared.selectedView.claimDigest,
    inputManifestDigest: prepared.selectedView.identity.inputManifestDigest, bodyDigest: "a".repeat(64), bytes: 10, status: 200 as const,
    headersDigest: "b".repeat(64), requestDigest: "c".repeat(64) }));
  const write = async () => { const proof = createQualificationEvidenceWriter({ store: bucket, pair: prepared.pair, qualificationId: "pages", witnessDigest: "d".repeat(64), signal });
    for (const value of values) await proof.append(value); return proof.finish(); };
  const result = await write(), root = JSON.parse(await (await bucket.get(result.evidenceKey))!.text());
  expect(root.pages.map((page: { count: number }) => page.count)).toEqual([256, 1]);
  const key = result.evidenceKey.replace(/roots\/.+$/, `pages/${root.pages[0].digest}.json`), object = await bucket.get(key);
  const bytes = new Uint8Array(await object!.arrayBuffer()); bytes[0] ^= 1;
  await bucket.put(key, bytes, { customMetadata: object!.customMetadata });
  await expect(write()).rejects.toThrow();
  const read = async () => { for await (const row of readQualificationEvidence({ store: bucket, pair: prepared.pair, qualificationId: "pages",
    witnessDigest: "d".repeat(64), ...result, signal })) void row; };
  await expect(read()).rejects.toThrow();
});

it("refuses a fully staged private view without a complete frozen code pack by named error", async () => {
  const prepared = await prepare();
  await expect(readQualificationCodePack({ firestore: db, store: bucket, pair: prepared.pair, reference: prepared.selectedView,
    captured: prepared.captured, signal: AbortSignal.timeout(10_000) })).rejects.toMatchObject({ code: "incomplete-code-pack" });
});
it("refuses an original H dependency deleted after completed work and G staging", async () => {
  const prepared = await prepare(), options = { firestore: db, store: bucket, pair: prepared.pair,
    reference: prepared.selectedView, captured: prepared.captured, signal: AbortSignal.timeout(10_000) };
  const opened = await openQualificationInput(options), dependency = opened.root.files.find(file => file.name === "context.json")!;
  await bucket.delete(dependency.objectKey);
  await expect(openQualificationInput(options)).rejects.toThrow();
  expect(prepared.received).toBe(0);
});

it("refuses an unlisted settled output in a closed source inventory", async () => {
  const prepared = await prepare();
  await expect(verify([rows[0]], { inventory: expectation(rows.slice(0, -1)) })).rejects.toThrow("reader-mismatch");
  expect(prepared.received).toBe(0);
});
it("refuses a declared output absent from the settled inventory", async () => {
  const prepared = await prepare();
  await expect(verify(rows, { inventory: expectation([...rows, row("/missing/")]) })).rejects.toThrow("reader-mismatch");
  expect(prepared.received).toBe(0);
});

it("retains typed namespace absence independently of actual body evidence", async () => {
  const prepared = await prepare(), signal = AbortSignal.timeout(20_000), witnessDigest = "d".repeat(64);
  const writer = createQualificationEvidenceWriter({ store: bucket, pair: prepared.pair, qualificationId: "namespace-proof", witnessDigest, signal });
  const absent = { kind: "absence" as const, path: "/pagefind/old-shard.pf_index", status: 404 as const, bytes: 0 as const,
    manifestDigest: prepared.selectedView.manifestDigest, claimDigest: prepared.selectedView.claimDigest,
    inputManifestDigest: prepared.selectedView.identity.inputManifestDigest, requestDigest: "a".repeat(64),
    namespaceRootDigest: "b".repeat(64), namespaceManifestDigest: "c".repeat(64), cursor: prepared.captured.cursor };
  await expect(writer.append({ ...absent, path: "/outside-search.bin" })).rejects.toThrow();
  await expect(writer.append({ ...absent, namespaceManifestDigest: "" })).rejects.toThrow();
  await writer.append(absent);
  await verify(rows, { evidence: async (output: QualifiedByteEvidence) => writer.append({ kind: "content", ...output }) });
  const root = await writer.finish(), retained = [];
  for await (const row of readQualificationEvidence({ store: bucket, pair: prepared.pair, qualificationId: "namespace-proof", witnessDigest, ...root, signal })) retained.push(row);
  expect(retained[0]).toEqual(absent); expect(root.outputCount).toBe(rows.length + 1);
  expect(root.outputBytes).toBe(rows.reduce((total, row) => total + row.bytes.byteLength, 0));
});

it("never treats an actual private handler refusal as namespace absence", async () => {
  const prepared = await prepare(), retained: unknown[] = [];
  await expect(verifyPairNamespaceRemoteAbsence({ ...prepared, absence: { namespace: "/pagefind/",
    namespaceRootDigest: "b".repeat(64), namespaceManifestDigest: "c".repeat(64), cursor: prepared.captured.cursor,
    paths: ["/pagefind/old-shard.pf_index"] }, stagedReadbackDigest: prepared.staged.readbackDigest,
    evidence: async row => { retained.push(row); }, signal: AbortSignal.timeout(20_000) })).rejects.toThrow("Private pair reader refused");
  expect(prepared.received).toBe(1); expect(retained).toEqual([]);
});
