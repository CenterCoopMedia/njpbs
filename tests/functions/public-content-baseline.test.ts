import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { build } from "esbuild";
import { createContentBaselineAssetReader } from "../../workers/src/public-content-baseline";
import { baselineManifestKey, baselineObjectKey } from "../../packages/content-core/src/public-content-baseline";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { prepareContentBaseline, seedContentBaseline } from "../../site/scripts/public-content-baseline-artifact";
import { publicationTarget } from "../../functions/lib/publication-target";
import { retainedHomeSources } from "../../site/tests/fixtures/published-pages/fixtures";
import { readHomeSourceSnapshot } from "../../packages/content-core/src/home-published-sources";
import { createHomeEditorialCatalog } from "../../site/src/lib/home-editorial-catalog";

const target = publicationTarget("production"), rendererSha = "a".repeat(40);
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sources = retainedHomeSources(rendererSha);
const contents = { "index.html": "<!doctype html><html>Verified Home baseline</html>",
  "wiki/index.html": "<!doctype html><html>Curated public wiki</html>",
  "_home-sources.json": JSON.stringify(sources), "_content-status.json": '{"schemaVersion":1}',
  "_schedule-sources.json": '{"syntheticSchedule":true}', "posts/fixture/index.html": "<html>Public Post fixture</html>",
  "pagefind/fixture.pf_fragment": "Independent search fixture bytes", "_astro/app.js": "export const fixture = true;" };
let runtime: Miniflare, bucket: R2Bucket;
let currentPublication: Buffer, fixtureSequence = 0;
const directories: string[] = [];

beforeAll(async () => {
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { createContentBaselineAssetReader } from './workers/src/public-content-baseline';
    import { publicationTarget } from './functions/lib/publication-target';
    export default { fetch(request, env) { return createContentBaselineAssetReader({
      target: publicationTarget('production'), rendererSha: '${rendererSha}', store: env.BASELINE,
      fetchAsset: request => env.ASSETS.fetch(request) })(request); } };` },
    bundle: true, format: "esm", platform: "browser", write: false });
  runtime = new Miniflare({ workers: [{ config: { name: "content-baseline", type: "worker", compatibilityDate: "2026-07-10",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm",
      contents: compiled.outputFiles[0].text } } },
    env: { BASELINE: { type: "r2", name: "baseline" }, ASSETS: { type: "fetcher", handler: request =>
      new URL(request.url).pathname === "/_publication.json" ? new WorkerResponse(currentPublication)
        : new WorkerResponse("Legacy Assets fallback") } } } }] });
  bucket = await runtime.getR2Bucket("BASELINE");
});
beforeEach(async () => {
  const objects = await bucket.list();
  if (objects.objects.length) await bucket.delete(objects.objects.map(object => object.key));
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
afterAll(async () => { await runtime?.dispose(); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-content-baseline-")); directories.push(directory);
  const distDirectory = path.join(directory, "dist");
  await mkdir(distDirectory);
  const homeSources = { ...sources, publication: { ...sources.publication!,
    buildBatchId: `baseline-fixture-${++fixtureSequence}` } };
  homeSources.editorial = createHomeEditorialCatalog(homeSources, {}, [], "2026-10-12T10:00:00.000Z");
  for (const [name, bytes] of Object.entries({ ...contents, "_home-sources.json": JSON.stringify(homeSources) })) {
    await mkdir(path.dirname(path.join(distDirectory, name)), { recursive: true });
    await writeFile(path.join(distDirectory, name), bytes);
  }
  const cutoffAt = { seconds: 1_787_856_000, nanoseconds: 0, toMillis: () => 1_787_856_000_000 };
  const reservation = { schemaVersion: 1, buildBatchId: homeSources.publication.buildBatchId, generation: homeSources.publication.generation,
    status: "reserved", commitSha: rendererSha, reservedAgainstGeneration: 4, reservedAgainstDeploymentId: "previous",
    reservedAgainstCommitSha: "b".repeat(40), cutoffAt, reservedAt: cutoffAt };
  const artifactReceipt = createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const preparedArtifact = await preparePublicWorkerArtifact({ artifactReceipt, distDirectory, outputPath: path.join(directory, "prepared.json") });
  const plan = await prepareContentBaseline({ target, distDirectory, preparedArtifact });
  const publicationBytes = await readFile(path.join(distDirectory, "_publication.json"));
  currentPublication = publicationBytes;
  // Actual local R2 binding: conditional writes, intrinsic checksums and streams.
  const storage = { async writeAndVerify(key: string, bytes: Buffer) {
    await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: sha(bytes) });
    const stored = await bucket.get(key);
    if (!stored || sha(new Uint8Array(await stored.arrayBuffer())) !== sha(bytes)) throw new Error("Fixture readback differs");
  } };
  const fetchAsset = async (request: Request) => new URL(request.url).pathname === "/_publication.json"
    ? new Response(publicationBytes) : new Response("Legacy Assets fallback");
  const reader = () => createContentBaselineAssetReader({ target, rendererSha, store: bucket, fetchAsset });
  return { directory, distDirectory, artifactReceipt, preparedArtifact, plan, storage, reader, fetchAsset, publicationBytes, homeSources };
}

it("prepares without a storage write, seeds once and serves cold content with content Assets absent", async () => {
  const input = await fixture();
  expect((await bucket.list()).objects).toHaveLength(0);
  const receipt = await seedContentBaseline(input.plan, input.storage);
  expect(receipt.status).toBe("seeded");
  const retainedPublication = await bucket.get(baselineObjectKey(target, input.preparedArtifact.publicationReceiptDigest));
  expect(new Uint8Array(await retainedPublication!.arrayBuffer())).toEqual(new Uint8Array(input.publicationBytes));
  expect(receipt.files).toBe(Object.keys(contents).length);
  const read = input.reader();
  for (const [route, name] of [["/", "index.html"], ["/wiki/", "wiki/index.html"],
    ["/pagefind/fixture.pf_fragment", "pagefind/fixture.pf_fragment"]] as const) {
    const response = await read(new Request(target.origin + route));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(contents[name]);
    expect(response.headers.get("x-njpbs-asset-storage")).toBe("r2-baseline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
  const home = await read(new Request(target.origin + "/_home-sources.json"));
  expect(readHomeSourceSnapshot(await home.json(), input.plan.baseline.publication)).toEqual(input.homeSources);
  expect(home.headers.get("access-control-allow-origin")).toBe("https://admin.njpbs.org");
  const head = await read(new Request(target.origin + "/wiki/", { method: "HEAD" }));
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(contents["wiki/index.html"])));
  const native = await runtime.dispatchFetch(target.origin + "/wiki/");
  expect(await native.text()).toBe(contents["wiki/index.html"]);
  expect(native.headers.get("x-njpbs-asset-storage")).toBe("r2-baseline");
});

it("keeps exact retries immutable and deduplicates shared bytes", async () => {
  const input = await fixture();
  await seedContentBaseline(input.plan, input.storage);
  const before = await bucket.get(input.plan.manifestKey);
  await seedContentBaseline(input.plan, input.storage);
  const after = await bucket.get(input.plan.manifestKey);
  expect(after!.etag).toBe(before!.etag);
  expect((await bucket.list()).objects).toHaveLength(Object.keys(contents).length + 2);
  expect(await after!.text()).toBe(input.plan.manifestBytes.toString("utf8"));
  await before!.body.cancel();
});

it("keeps a healthy code asset on the current Assets path", async () => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  const read = createContentBaselineAssetReader({ target, rendererSha, store: bucket,
    fetchAsset: async request => new URL(request.url).pathname === "/_publication.json"
      ? new Response(input.publicationBytes) : new Response("Current code asset") });
  const response = await read(new Request(target.origin + "/_astro/app.js"));
  expect(await response.text()).toBe("Current code asset");
  expect(response.headers.has("x-njpbs-asset-storage")).toBe(false);
});

it("reuses only the verified immutable table across requests and still verifies each blob", async () => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe(contents["wiki/index.html"]);
  await bucket.delete(input.plan.manifestKey);
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe(contents["wiki/index.html"]);
  const file = input.plan.baseline.files.find(file => file.path === "wiki/index.html")!;
  const bytes = Buffer.from("Changed stored body");
  await bucket.put(baselineObjectKey(target, file.digest), bytes, { sha256: sha(bytes) });
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe("Legacy Assets fallback");
});

it("bounds missing-manifest caching so a later additive seed becomes readable", async () => {
  const input = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T18:00:00Z"));
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe("Legacy Assets fallback");
  await seedContentBaseline(input.plan, input.storage);
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe("Legacy Assets fallback");
  vi.setSystemTime(new Date("2026-10-26T18:00:31Z"));
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe(contents["wiki/index.html"]);
});

it("keeps a verified table when an overlapping cold read fails", async () => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  let rejectRead!: (error: Error) => void, started!: () => void;
  const pending = new Promise<never>((_, reject) => { rejectRead = reject; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const read = createContentBaselineAssetReader({ target, rendererSha, fetchAsset: input.fetchAsset,
    store: { get(key) { if (key === input.plan.manifestKey) { started(); return pending; } return bucket.get(key); } } });
  const first = read(new Request(target.origin + "/wiki/"));
  await reading;
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe(contents["wiki/index.html"]);
  rejectRead(new Error("Synthetic storage interruption"));
  expect(await (await first).text()).toBe(contents["wiki/index.html"]);
  await bucket.delete(input.plan.manifestKey);
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe(contents["wiki/index.html"]);
});

it("revalidates exact sealed bytes without redownloading and preserves no-store paths", async () => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  const file = input.plan.baseline.files.find(file => file.path === "wiki/index.html")!;
  const first = await input.reader()(new Request(target.origin + "/wiki/"));
  expect(first.headers.get("etag")).toBe(`"${sha(contents["wiki/index.html"])}"`);
  expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  await first.body?.cancel();
  const read = input.reader();
  for (const condition of [`"${file.digest}"`, `W/"${file.digest}"`, `"prior", "${file.digest}"`, "*"]) {
    const response = await read(new Request(target.origin + "/wiki/", { headers: { "if-none-match": condition } }));
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.has("content-length")).toBe(false);
  }
  const changed = await read(new Request(target.origin + "/wiki/", { headers: { "if-none-match": '"prior"' } }));
  expect(changed.status).toBe(200);
  expect(await changed.text()).toBe(contents["wiki/index.html"]);
  for (const route of ["/posts/fixture/", "/_schedule-sources.json"]) {
    const response = await read(new Request(target.origin + route));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-njpbs-asset-storage")).toBe("r2-baseline");
    await response.body?.cancel();
  }
});

it("refuses changed sealed bytes before any storage write", async () => {
  const input = await fixture();
  await writeFile(path.join(input.distDirectory, "index.html"), "Changed after seal");
  await expect(prepareContentBaseline(input)).rejects.toThrow();
  expect((await bucket.list()).objects).toHaveLength(0);
});

it("never seals a manifest when a file changes after preparation", async () => {
  const input = await fixture();
  await writeFile(path.join(input.distDirectory, "wiki/index.html"), "Changed after preparation");
  await expect(seedContentBaseline(input.plan, input.storage)).rejects.toThrow("changed after preparation");
  expect(await bucket.get(input.plan.manifestKey)).toBeNull();
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe("Legacy Assets fallback");
});

it("keeps separately prepared input under a new immutable manifest key while the planned generation is unchanged", async () => {
  const first = await fixture();
  await seedContentBaseline(first.plan, first.storage);
  await writeFile(path.join(first.distDirectory, "index.html"), "<!doctype html><html>Newer accepted input</html>");
  // A new build uses the existing artifact producer; no generation is reserved here.
  const preparedArtifact = await preparePublicWorkerArtifact({ artifactReceipt: first.artifactReceipt,
    distDirectory: first.distDirectory, outputPath: path.join(first.directory, "second.json") });
  const second = await prepareContentBaseline({ target, distDirectory: first.distDirectory, preparedArtifact });
  expect(second.baseline.publication.generation).toBe(first.plan.baseline.publication.generation);
  expect(second.manifestKey).not.toBe(first.plan.manifestKey);
  await seedContentBaseline(second, first.storage);
  expect(await bucket.head(first.plan.manifestKey)).not.toBeNull();
  expect(await bucket.head(second.manifestKey)).not.toBeNull();
});

it.each(["table", "publication", "shape"])("refuses a corrupted manifest %s", async mode => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  const corrupt = JSON.parse(input.plan.manifestBytes.toString("utf8"));
  if (mode === "table") corrupt.files[0].digest = "f".repeat(64);
  if (mode === "publication") corrupt.publication.artifactReceiptDigest = "f".repeat(64);
  if (mode === "shape") corrupt.extra = true;
  const bytes = Buffer.from(JSON.stringify(corrupt));
  await bucket.put(input.plan.manifestKey, bytes, { sha256: sha(bytes) });
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe("Legacy Assets fallback");
});

it("uses intrinsic stored checksum and size before streaming a file", async () => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  const file = input.plan.baseline.files.find(file => file.path === "wiki/index.html")!;
  const bytes = Buffer.from("Different bytes under an unchanged key");
  await bucket.put(baselineObjectKey(target, file.digest), bytes, { sha256: sha(bytes) });
  expect(await (await input.reader()(new Request(target.origin + "/wiki/"))).text()).toBe("Legacy Assets fallback");
  await expect(bucket.put("bad-checksum", bytes, { sha256: file.digest })).rejects.toThrow();
});

it("returns a sealed file stream before its body transport completes", async () => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  const file = input.plan.baseline.files.find(file => file.path === "wiki/index.html")!;
  let release!: () => void;
  const bodyReady = new Promise<void>(resolve => { release = resolve; });
  const store = { async get(key: string) {
    const object = await bucket.get(key);
    if (!object || key !== baselineObjectKey(target, file.digest)) return object;
    const reader = object.body.getReader();
    return { size: object.size, checksums: object.checksums, body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        await bodyReady;
        const chunk = await reader.read();
        if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
      }, cancel: reason => reader.cancel(reason) }) };
  } };
  const read = createContentBaselineAssetReader({ target, rendererSha, store, fetchAsset: input.fetchAsset });
  const response = await read(new Request(target.origin + "/wiki/"));
  expect(response.headers.get("x-njpbs-asset-storage")).toBe("r2-baseline");
  release();
  expect(await response.text()).toBe(contents["wiki/index.html"]);
});

it.each(["range", "conditional", "navigation", "query", "credential"])("keeps legacy %s behavior during additive adoption", async mode => {
  const input = await fixture(); await seedContentBaseline(input.plan, input.storage);
  const request = new Request(target.origin + (mode === "navigation" ? "/wiki" : "/wiki/") + (mode === "query" ? "?x=1" : ""), {
    headers: mode === "range" ? { range: "bytes=0-2" } : mode === "conditional" ? { "if-modified-since": "Mon, 26 Oct 2026 18:00:00 GMT" }
      : mode === "credential" ? { authorization: "synthetic-fixture" } : {} });
  expect(await (await input.reader()(request)).text()).toBe("Legacy Assets fallback");
});

it("refuses changed publication receipt bytes before committing any immutable baseline objects", async () => {
  const input = await fixture();
  await writeFile(path.join(input.distDirectory, "_publication.json"), Buffer.concat([input.publicationBytes, Buffer.from(" ")]));
  await expect(seedContentBaseline(input.plan, input.storage)).rejects.toThrow("publication changed after preparation");
  expect((await bucket.list()).objects).toHaveLength(0);
});
