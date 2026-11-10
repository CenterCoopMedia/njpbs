import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { backgroundInputFiles, backgroundOutputFiles, createNoBuildPreparationStorage } from "../../site/scripts/no-build-preparation-storage";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { freezeRetainedPublicImages, installRetainedPublicImages } from "../../site/scripts/retained-public-images";

const bucket = "background-durable-fixture";
const identity = { operationId: "11111111111111111111", contextDigest: "a".repeat(64), commitSha: "b".repeat(40),
  owner: "cloudflare" as const, cutoffMillis: 1700000000000, admissionRevision: 3 };
const prefix = `post-background-v1/preparation/${identity.operationId}/${identity.contextDigest}`;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let directory: string;
let cloud: ReturnType<typeof createNoBuildPreparationStorage>;
beforeAll(async () => {
  boundary = await backgroundStorageFixture(bucket);
  app = firebaseAdminRuntime.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-njpbs" }, "durable-preparation-storage");
  cloud = createNoBuildPreparationStorage(bucket, app, identity);
});
beforeEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "background-cloud-boundary-")));
  boundary.objects.clear(); boundary.writes.length = 0; boundary.reads.length = 0; boundary.refuseReads(false); boundary.reject(null);
  for (const name of backgroundInputFiles) await writeFile(path.join(directory, name), `retained ${name}`);
});
afterAll(async () => {
  if (app) await firebaseAdminRuntime.deleteApp(app);
  if (boundary) await boundary.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("restores exact input and cutoff to empty disk through the named-app JSON API", async () => {
  const digest = await cloud.checkpoint("input", directory, backgroundInputFiles);
  await rm(directory, { recursive: true, force: true });
  expect(await cloud.restore("input", directory)).toBe(digest);
  expect(await readFile(path.join(directory, "input.json"), "utf8")).toBe("retained input.json");
  const checkpoint = JSON.parse(boundary.objects.get(`${prefix}/input.json`)!.toString());
  expect(checkpoint.identity).toEqual(identity);
  expect(boundary.writes.at(-1)).toBe(`${prefix}/input.json`);
});

it("batches prepared-file readbacks eight at a time and commits the manifest only after every readback", async () => {
  const names = [...backgroundOutputFiles];
  for (let index = 0; index < 21; index++) names.push(`files/${index}.html`);
  await mkdir(path.join(directory, "files"));
  for (const name of names) await writeFile(path.join(directory, name), `unique ${name}`);
  let active = 0, maximum = 0, entered!: () => void, release!: () => void;
  const full = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  boundary.onRead(async key => {
    if (!key.includes("/bytes/")) return;
    maximum = Math.max(maximum, ++active);
    if (active === 8) entered();
    await held;
    // Model slow storage responses so over-limit reads remain observable.
    await new Promise(resolve => setTimeout(resolve, 100));
    active--;
  });
  const checkpoint = cloud.checkpoint("prepared", directory, names);
  try {
    await full;
    expect(boundary.objects.has(`${prefix}/prepared.json`)).toBe(false);
    expect(maximum).toBe(8);
  } finally { release(); await checkpoint; boundary.onRead(null); }
  const digest = await checkpoint;
  expect(maximum).toBe(8);
  await rm(directory, { recursive: true, force: true });
  expect(await cloud.restore("prepared", directory, digest)).toBe(digest);
  expect(await readFile(path.join(directory, "files/20.html"), "utf8")).toBe("unique files/20.html");
});
it("keeps a partial upload unrecoverable and completes the same operation on retry", async () => {
  boundary.reject(key => key.endsWith("/input.json"));
  await expect(cloud.checkpoint("input", directory, backgroundInputFiles)).rejects.toThrow();
  expect(await cloud.restore("input", directory)).toBeNull();
  boundary.reject(null);
  await cloud.checkpoint("input", directory, backgroundInputFiles);
  expect(await cloud.restore("input", directory)).toMatch(/^[a-f0-9]{64}$/);
  expect(boundary.writes.length).toBe(backgroundInputFiles.length + 1);
});
it("retains the first complete checkpoint on an immutable retry", async () => {
  const first = await cloud.checkpoint("input", directory, backgroundInputFiles);
  await writeFile(path.join(directory, "input.json"), "different later input");
  expect(await cloud.checkpoint("input", directory, backgroundInputFiles)).toBe(first);
  expect(await readFile(path.join(directory, "input.json"), "utf8")).toBe("retained input.json");
});
it("refuses changed bytes even when the storage CRC matches those changed bytes", async () => {
  await cloud.checkpoint("input", directory, backgroundInputFiles);
  const sha = createHash("sha256").update("retained input.json").digest("hex");
  boundary.objects.set(`${prefix}/bytes/${sha}`, Buffer.from("changed"));
  await expect(cloud.restore("input", directory)).rejects.toThrow("bytes differ");
});
it("rejects another cutoff or owner for the same operation", async () => {
  await cloud.checkpoint("input", directory, backgroundInputFiles);
  const other = createNoBuildPreparationStorage(bucket, app, { ...identity, cutoffMillis: identity.cutoffMillis + 1 });
  await expect(other.restore("input", directory)).rejects.toThrow("identity differs");
  const wrongOwner = createNoBuildPreparationStorage(bucket, app, { ...identity, owner: "node-compute" });
  await expect(wrongOwner.restore("input", directory)).rejects.toThrow("identity differs");
});

it("uses the recorded digest and every file digest before trusting the local cache", async () => {
  const receipt = await cloud.checkpoint("input", directory, backgroundInputFiles);
  boundary.reads.length = 0;
  expect(await cloud.restore("input", directory, receipt)).toBe(receipt);
  expect(boundary.reads).toHaveLength(0);
  await writeFile(path.join(directory, "input.json"), "changed cache");
  expect(await cloud.restore("input", directory, receipt)).toBe(receipt);
  expect(boundary.reads.length).toBeGreaterThan(0);
  expect(await readFile(path.join(directory, "input.json"), "utf8")).toBe("retained input.json");
  boundary.reads.length = 0;
  await writeFile(path.join(directory, ".checkpoint-input.json"), "changed manifest");
  expect(await cloud.restore("input", directory, receipt)).toBe(receipt);
  expect(boundary.reads.length).toBeGreaterThan(0);
});

it.each(["cloudflare", "node-compute"] as const)("restores every Post image to empty disk for %s without a provider fetch", async owner => {
  const runtimeIdentity = { ...identity, owner };
  const storage = createNoBuildPreparationStorage(bucket, app, runtimeIdentity);
  const imageIdentity = { buildBatchId: `post-background-${identity.operationId}-${identity.contextDigest}`, commitSha: identity.commitSha };
  const urls = ["https://media.njpbs.org/cms-media/fixture/post.webp", "https://njpbs.org/brand/spotlight/watch.jpg"];
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ pages: [{ blocks: urls.map((_, index) => ({ type: "image", visible: true, data: { assetId: String(index) } })), assets: Object.fromEntries(urls.map((url, index) => [String(index), { url, mimeType: "image/webp", width: 640, height: 360 }])) }] }));
  for (const file of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) await writeFile(path.join(directory, file), "{}");
  const provider = vi.fn(async () => new Response("frozen-image", { headers: { "content-type": "image/webp" } }));
  const images = await freezeRetainedPublicImages(directory, imageIdentity, provider);
  const receipt = await storage.checkpoint("input", directory, [...backgroundInputFiles, ...images]);
  expect(provider).toHaveBeenCalledTimes(2);
  await rm(directory, { recursive: true, force: true });
  expect(await storage.restore("input", directory, receipt)).toBe(receipt);
  const network = vi.fn(async () => { throw new Error("Provider unavailable after checkpoint"); });
  vi.stubGlobal("fetch", network);
  const restore = await installRetainedPublicImages(path.join(directory, "remote-images.json"), imageIdentity);
  try {
    for (const url of urls) expect(await (await fetch(url)).text()).toBe("frozen-image");
    expect(network).not.toHaveBeenCalled();
  } finally { restore(); vi.unstubAllGlobals(); }
});

it("refuses an input checkpoint whose image catalog omits its binary objects", async () => {
  const imageIdentity = { buildBatchId: `post-background-${identity.operationId}-${identity.contextDigest}`, commitSha: identity.commitSha };
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ pages: [{ blocks: [{ type: "image", visible: true, data: { assetId: "image" } }], assets: { image: { url: "https://media.njpbs.org/cms-media/fixture/post.webp", mimeType: "image/webp", width: 640, height: 360 } } }] }));
  for (const file of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) await writeFile(path.join(directory, file), "{}");
  await freezeRetainedPublicImages(directory, imageIdentity, async () => new Response("frozen-image", { headers: { "content-type": "image/webp" } }));
  await expect(cloud.checkpoint("input", directory, [...backgroundInputFiles, "remote-images.json"])).rejects.toThrow("image checkpoint differs");
  expect(boundary.writes).toHaveLength(0);
});

it("recovers a supported CMS image larger than the ordinary 16 MiB artifact bound", async () => {
  const imageIdentity = { buildBatchId: `post-background-${identity.operationId}-${identity.contextDigest}`, commitSha: identity.commitSha };
  const url = "https://media.njpbs.org/cms-media/fixture/large.webp";
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ pages: [{ blocks: [{ type: "image", visible: true, data: { assetId: "image" } }],
    assets: { image: { url, mimeType: "image/webp", width: 640, height: 360 } } }] }));
  const bytes = new Uint8Array(17 * 1024 * 1024);
  const names = await freezeRetainedPublicImages(directory, imageIdentity, async () => new Response(bytes, { headers: { "content-type": "image/webp" } }));
  const receipt = await cloud.checkpoint("input", directory, [...backgroundInputFiles, ...names]);
  await rm(directory, { recursive: true, force: true });
  expect(await cloud.restore("input", directory, receipt)).toBe(receipt);
  const restore = await installRetainedPublicImages(path.join(directory, "remote-images.json"), imageIdentity);
  try { expect((await (await fetch(url)).arrayBuffer()).byteLength).toBe(17 * 1024 * 1024); }
  finally { restore(); }
});

it("replays an empty image catalog after restore without requiring an empty directory in storage", async () => {
  const imageIdentity = { buildBatchId: `post-background-${identity.operationId}-${identity.contextDigest}`, commitSha: identity.commitSha };
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ pages: [], posts: [], programs: [] }));
  const names = await freezeRetainedPublicImages(directory, imageIdentity, async () => { throw new Error("No image should be fetched"); });
  const receipt = await cloud.checkpoint("input", directory, [...backgroundInputFiles, ...names]);
  await rm(directory, { recursive: true, force: true });
  expect(await cloud.restore("input", directory, receipt)).toBe(receipt);
  await expect(readFile(path.join(directory, "images"))).rejects.toMatchObject({ code: "ENOENT" });
  const restore = await installRetainedPublicImages(path.join(directory, "remote-images.json"), imageIdentity);
  restore();
});


it("checkpoints and restores a prepared receipt larger than 2 MiB with exact bytes", async () => {
  const receipt = JSON.stringify({ schemaVersion: 2, retained: "frozen".repeat(400_000) });
  expect(Buffer.byteLength(receipt)).toBeGreaterThan(2 * 1024 * 1024);
  for (const file of backgroundOutputFiles) await writeFile(path.join(directory, file), file === "receipt.json" ? receipt : "{}");
  const digest = await cloud.checkpoint("prepared", directory, backgroundOutputFiles);
  await rm(directory, { recursive: true, force: true });
  expect(await cloud.restore("prepared", directory, digest)).toBe(digest);
  expect(await readFile(path.join(directory, "receipt.json"), "utf8")).toBe(receipt);
});
