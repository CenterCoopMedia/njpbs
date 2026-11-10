import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { writePublicReleasePairView, readPublicReleasePairView, type PairViewOutputInput, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import codec from "../../functions/lib/public-release-pair-view.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";

const pair = releasePair();
const captured = capturedPairInput(pair, { sourceOperationId: "view-operation" });
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const claimDigest = "e".repeat(64), cursor = { baselineDigest: "b".repeat(64), sequence: 12, lastDigest: "c".repeat(64) };
const html = '<!doctype html><html>Verified view</html><script type="module" src="/_astro/layout.js"></script>';
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const output = (path: string, text = html): PairViewOutputInput => ({ path, status: 200,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha },
  bytes: new TextEncoder().encode(text) });
async function* stream(rows: PairViewOutputInput[]) { yield* rows; }
let runtime: Miniflare, store: R2Bucket;
const write = (rows = [output("/about/"), output("/posts/example/")], overrides = {}) =>
  writePublicReleasePairView({ store, pair, identity, claimDigest, cursor, outputs: stream(rows), ...overrides });
async function read(receipt: Awaited<ReturnType<typeof write>>, overrides = {}) {
  const rows = [];
  for await (const row of readPublicReleasePairView({ store, pair, identity, claimDigest,
    manifestDigest: receipt.manifestDigest, manifestBytes: receipt.manifestBytes, ...overrides })) rows.push(row);
  return rows;
}

beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "pair-view-test", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "pair-views" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  const listed = await store.list();
  if (listed.objects.length) await store.delete(listed.objects.map(object => object.key));
});
afterAll(async () => { await runtime?.dispose(); });

it("prefetches at most four actual G bodies while preserving the complete ordered stream", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => output(`/p${index}/`, html + index));
  const receipt = await write(rows);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let bodies = 0;
  const observed: PairViewStore = { put: (...args) => store.put(...args), async get(key) {
    const object = await store.get(key);
    if (key.includes("/objects/")) { bodies++; if (bodies === 4) entered(); await gate; }
    return object;
  } };
  const result = read(receipt, { store: observed });
  try {
    await ready; expect(bodies).toBe(4);
    release(); const actual = await result;
    expect(actual.map(row => row.path)).toEqual(rows.map(row => row.path));
    expect(actual.map(row => new TextDecoder().decode(row.body))).toEqual(rows.map(row => new TextDecoder().decode(row.bytes)));
    expect(bodies).toBe(6);
  } finally { release(); await result.catch(() => {}); }
});

it("waits for all real G body reads on a failed batch and never starts a later batch", async () => {
  const receipt = await write(Array.from({ length: 6 }, (_, index) => output(`/p${index}/`, html + index)));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let bodies = 0, settled = false;
  const observed: PairViewStore = { put: (...args) => store.put(...args), async get(key) {
    const object = await store.get(key);
    if (key.includes("/objects/")) {
      bodies++; if (bodies === 4) entered();
      if (bodies === 1) { await object?.body.cancel(); throw new Error("original body transport failure"); }
      await gate;
    }
    return object;
  } };
  const result = read(receipt, { store: observed }), checked = expect(result).rejects.toThrow("original body transport failure");
  void result.then(() => { settled = true; }, () => { settled = true; });
  try {
    await ready; expect(bodies).toBe(4); expect(settled).toBe(false);
    release(); await checked; expect(bodies).toBe(4);
  } finally { release(); await result.catch(() => {}); }
});

it("stores and independently reads exact Page and Post view bytes in the actual R2 binding", async () => {
  const receipt = await write();
  expect(receipt.root.identity).toEqual(identity);
  expect(receipt.root.cursor).toEqual(cursor);
  expect(receipt.root.outputCount).toBe(2);
  const root = await store.get(receipt.manifestKey);
  expect(sha(new Uint8Array(await root!.arrayBuffer()))).toBe(receipt.manifestDigest);
  const rows = await read(receipt);
  expect(rows.map(row => row.path)).toEqual(["/about/", "/posts/example/"]);
  expect(rows.map(row => new TextDecoder().decode(row.body))).toEqual([html, html]);
  for (const row of rows) expect(row.objectKey).toContain(`/claims/${claimDigest}/objects/`);
});

it("reuses exact immutable objects on retry and refuses an intervening corrupt object", async () => {
  const first = await write();
  const before = await store.head(first.manifestKey);
  const retry = await write();
  expect(retry.manifestDigest).toBe(first.manifestDigest);
  expect((await store.head(first.manifestKey))!.etag).toBe(before!.etag);
  const rows = await read(first), row = rows[0];
  const original = await store.head(row.objectKey);
  const corrupt = new Uint8Array(row.body); corrupt[0] ^= 1;
  await store.put(row.objectKey, corrupt, { customMetadata: original!.customMetadata });
  const corruptHead = await store.head(row.objectKey);
  await expect(write()).rejects.toThrow("Private pair view bytes differ");
  expect((await store.head(row.objectKey))!.etag).toBe(corruptHead!.etag);
  expect(await (await store.get(row.objectKey))!.arrayBuffer()).toEqual(corrupt.buffer);
});

it("bounds independent body readbacks to four and waits before emitting the root", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0, active = 0, maximum = 0;
  const observed: PairViewStore = { put: (...args) => store.put(...args), async get(key) {
    if (!key.includes("/objects/")) return store.get(key);
    reads++; maximum = Math.max(maximum, ++active);
    if (reads === 4) entered();
    try { await gate; return await store.get(key); } finally { active--; }
  } };
  const outputs = Array.from({ length: 5 }, (_, index) => output(`/batch-${index}/`, `<html>Body ${index}</html>`));
  const writing = write(outputs, { store: observed });
  try {
    await ready;
    expect(reads).toBe(4); expect(maximum).toBe(4);
    expect((await store.list()).objects.some(object => object.key.includes("/views/"))).toBe(false);
  } finally { release(); }
  const receipt = await writing;
  expect(maximum).toBe(4); expect(reads).toBe(5);
  expect((await read(receipt)).map(row => new TextDecoder().decode(row.body))).toEqual(outputs.map(row => new TextDecoder().decode(row.bytes)));
});

it("drains a failed body batch and retains no root or later writes", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const failure = new Error("readback unavailable");
  let reads = 0, finished = 0, settled = false;
  const observed: PairViewStore = { put: (...args) => store.put(...args), async get(key) {
    if (!key.includes("/objects/")) return store.get(key);
    const ordinal = ++reads; if (reads === 4) entered();
    if (ordinal === 2) throw failure;
    await gate; const value = await store.get(key); finished++; return value;
  } };
  const result = write(Array.from({ length: 5 }, (_, index) => output(`/batch-${index}/`, `<html>Body ${index}</html>`)), { store: observed })
    .then(value => { settled = true; return value; }, error => { settled = true; return error; });
  try { await ready; expect(settled).toBe(false); }
  finally { release(); }
  expect(await result).toBe(failure); expect(finished).toBe(3); expect(reads).toBe(4);
  expect((await store.list()).objects.some(object => object.key.includes("/views/"))).toBe(false);
});

it.each(["root", "page", "body", "metadata"])("refuses %s corruption at readback", async mode => {
  const receipt = await write();
  const rows = await read(receipt);
  const prefix = codec.publicReleasePairViewPrefix(pair, identity, claimDigest);
  const key = mode === "root" ? receipt.manifestKey : mode === "page"
    ? `${prefix}pages/${receipt.root.pages[0].digest}.json` : rows[0].objectKey;
  const object = await store.get(key), bytes = new Uint8Array(await object!.arrayBuffer());
  const metadata = { ...object!.customMetadata };
  if (mode === "metadata") metadata.pairdigest = "0".repeat(64);
  else bytes[bytes.length - 1] ^= 1;
  await store.put(key, bytes, { customMetadata: metadata });
  await expect(read(receipt)).rejects.toThrow("Private pair view bytes differ");
});

it("isolates pairs, sources, tasks and claim attempts even for identical bytes", async () => {
  const receipt = await write();
  await expect(read(receipt, { claimDigest: "f".repeat(64) })).rejects.toThrow();
  const other = releasePair("b", "b".repeat(40));
  await expect(read(receipt, { pair: other })).rejects.toThrow();
  await expect(read(receipt, { identity: { ...identity, sourceVersion: 8 } })).rejects.toThrow();
  const second = await write(undefined, { claimDigest: "f".repeat(64) });
  expect(second.manifestKey).not.toBe(receipt.manifestKey);
  expect((await read(second, { claimDigest: "f".repeat(64) })).map(row => row.path)).toEqual(["/about/", "/posts/example/"]);
  expect((await read(receipt)).map(row => row.path)).toEqual(["/about/", "/posts/example/"]);
});

it("rejects a wrong cursor or unsafe response before storing a root", async () => {
  await expect(write(undefined, { cursor: { ...cursor, sequence: 13 } })).rejects.toThrow();
  await expect(write([output("/../private/")])).rejects.toThrow();
  const credential = output("/about/"); credential.headers.authorization = "synthetic-must-not-store";
  await expect(write([credential])).rejects.toThrow();
  const internal = output("/about/"); internal.headers["x-njpbs-internal-token"] = "synthetic-must-not-store";
  await expect(write([internal])).rejects.toThrow();
  const mismatched = output("/about/"); mismatched.headers["x-njpbs-html-sha256"] = "0".repeat(64);
  await expect(write([mismatched])).rejects.toThrow();
  const wrongRenderer = output("/about/"); wrongRenderer.headers["x-njpbs-renderer-sha"] = "b".repeat(40);
  await expect(write([wrongRenderer])).rejects.toThrow();
  expect((await store.list()).objects).toHaveLength(0);
});

it("pages a sorted view across the manifest bound and preserves complete route coverage", async () => {
  const paths = Array.from({ length: 257 }, (_, index) => `/route-${String(index).padStart(3, "0")}/`);
  const receipt = await write(paths.map(path => output(path)));
  expect(receipt.root.pages.map(page => page.count)).toEqual([256, 1]);
  expect((await read(receipt)).map(row => row.path)).toEqual(paths);
});

it("flushes at the JSON byte bound before the row count bound", async () => {
  const rows = Array.from({ length: 128 }, (_, index) => {
    const row = output(`/route-${String(index).padStart(3, "0")}/`);
    row.headers["content-security-policy"] = "a".repeat(4000);
    return row;
  });
  const receipt = await write(rows);
  expect(receipt.root.pages.length).toBeGreaterThan(1);
  const prefix = codec.publicReleasePairViewPrefix(pair, identity, claimDigest);
  for (const page of receipt.root.pages) {
    expect(page.count).toBeLessThan(256);
    expect((await store.head(`${prefix}pages/${page.digest}.json`))!.size).toBeLessThanOrEqual(512 * 1024);
  }
  expect((await read(receipt)).map(row => row.path)).toEqual(rows.map(row => row.path));
});

it("refuses duplicate or unsorted routes and an aborted attempt without emitting a view root", async () => {
  await expect(write([output("/about/"), output("/about/")])).rejects.toThrow("input is invalid");
  await expect(write([output("/posts/example/"), output("/about/")])).rejects.toThrow("input is invalid");
  const controller = new AbortController(); controller.abort();
  await expect(write(undefined, { signal: controller.signal })).rejects.toThrow();
  expect((await store.list()).objects.some(object => object.key.includes("/views/"))).toBe(false);
});

it("parses roots and pages strictly and refuses changed coverage or identities", async () => {
  const receipt = await write(), root = structuredClone(receipt.root);
  for (const changed of [
    { ...root, schemaVersion: 3 }, { ...root, ready: true }, { ...root, outputCount: 3 },
    { ...root, pairDigest: "0".repeat(64) }, { ...root, claimDigest: "invalid" },
    { ...root, identity: { ...root.identity, sourceVersion: 0 } },
    { ...root, pages: [{ ...root.pages[0], firstPath: "/posts/example/", lastPath: "/about/" }] },
    { ...root, pages: [{ ...root.pages[0], count: 1 }] },
  ]) expect(() => codec.parsePublicReleasePairViewRoot(changed, pair)).toThrow();
  const key = `${codec.publicReleasePairViewPrefix(pair, identity, claimDigest)}pages/${root.pages[0].digest}.json`;
  const page = await (await store.get(key))!.json<codec.PairViewPage>();
  for (const changed of [
    { ...page, index: -1 }, { ...page, taskId: "0".repeat(64) },
    { ...page, outputs: [...page.outputs].reverse() },
    { ...page, outputs: [page.outputs[0], page.outputs[0]] },
    { ...page, outputs: [{ ...page.outputs[0], extra: true }] },
  ]) expect(() => codec.parsePublicReleasePairViewPage(changed, pair, identity, claimDigest)).toThrow();
});

it("keeps an already verified shared body independent from a consumer's mutation", async () => {
  const receipt = await write();
  const iterator = readPublicReleasePairView({ store, pair, identity, claimDigest,
    manifestDigest: receipt.manifestDigest, manifestBytes: receipt.manifestBytes });
  const first = await iterator.next();
  expect(first.done).toBe(false);
  first.value!.body[0] ^= 1;
  const second = await iterator.next();
  expect(new TextDecoder().decode(second.value!.body)).toBe(html);
  expect((await iterator.next()).done).toBe(true);
});

it("applies the HTML byte bound to media-type case and parameter variants", async () => {
  const receipt = await write(), row = (await read(receipt))[0];
  const descriptor = { path: row.path, status: row.status, headers: { ...row.headers, "content-type": "application/javascript" },
    bodyDigest: row.bodyDigest, bytes: 4 * 1024 * 1024 + 1, objectKey: row.objectKey };
  expect(codec.parsePublicReleasePairViewOutput(descriptor, pair, identity, claimDigest).bytes).toBe(descriptor.bytes);
  for (const contentType of ["text/html", "text/html;charset=utf-8", "text/html; charset=UTF-8", "TEXT/HTML ; charset=utf-8"]) {
    expect(() => codec.parsePublicReleasePairViewOutput({ ...descriptor,
      headers: { ...descriptor.headers, "content-type": contentType } }, pair, identity, claimDigest)).toThrow();
  }
});

it("links the exact complete composite roster into G and refuses an unexplained row", async () => {
  const rows = [output("/about/"), output("/posts/example/")];
  const sourceDependencyDigest = "d".repeat(64);
  const manifest = composite.parsePublicReleasePairCompositeManifest({ schemaVersion: 1, kind: "pair-composite-manifest",
    pairDigest: captured.root.pairDigest, inputManifestDigest: identity.inputManifestDigest, cursor,
    authority: { baselineInputManifestDigest: "a".repeat(64), baselineCodePackManifestDigest: "b".repeat(64), baselineViewManifestDigest: "c".repeat(64),
      codeAssetManifestDigest: pair.codeAssetManifestDigest, sourceDependencyDigest, sourceCensusDigest: "e".repeat(64), searchInputDigest: "f".repeat(64) },
    members: rows.map(row => ({ path: row.path, role: "route", kind: "page", status: row.status, mime: row.headers["content-type"], size: row.bytes.length,
      sha256: sha(row.bytes), sourceDependencyDigest })) }, pair, identity, cursor);
  const written = await write(rows, { compositeManifest: manifest });
  expect(written.root.composite?.descriptor.digest).toBe(composite.publicReleasePairCompositeManifestDigest(manifest));
  expect(written.root.composite?.memberCount).toBe(rows.length);
  expect(await read(written)).toHaveLength(rows.length);
  await expect(write([...rows, output("/unexplained/")], { compositeManifest: manifest })).rejects.toThrow();
  await expect(write(rows.slice(0, 1), { compositeManifest: manifest })).rejects.toThrow();
  await expect(write(rows, { compositeManifest: { ...manifest, members: [{ ...manifest.members[0], sha256: "0".repeat(64) }, manifest.members[1]] } })).rejects.toThrow();
});
