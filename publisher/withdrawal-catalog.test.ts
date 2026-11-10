import { Miniflare } from "miniflare";
import background from "../functions/lib/post-background-outputs.js";
import context from "../functions/lib/public-context-revision.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { publishWithdrawalCatalog, mergeWithdrawalCatalog, WITHDRAWAL_PUBLISH_TIMEOUT_MS, type CatalogObservation, type CatalogStore } from "./withdrawal-catalog";
import { encodeWithdrawalManifest, withdrawalManifestKey, WITHDRAWAL_MANIFEST_POSTS, type WithdrawalManifest } from "../workers/src/durable-post-withdrawals";
import { publicationTarget } from "../functions/lib/publication-target.js";
import { createTransitionalPostReadWorker } from "../workers/src/transitional-post-read-worker";
import { readDurablePostWithdrawal } from "../workers/src/durable-post-withdrawals";
import fixture from "../site/tests/fixtures/shadow-posts/post.json";

const target = publicationTarget(), operationId = "A".repeat(20), sha = "a".repeat(40), postId = "story-post";
const key = withdrawalManifestKey(target.workerName);
let runtime: Miniflare, store: CatalogStore;
function observation(visible = false, revision = 3, verified = true): CatalogObservation {
  const owner = { schemaVersion: 1, postId, operationId, sourceVersion: 7, generation: revision, visible,
    ownedSlugs: ["old-story", "story"], slug: "story", rendererSha: sha };
  const queue = { transport: "post-no-build-v1", status: "success", noBuildPost: { ...owner },
    // This is readPublicPostReceipt's persisted shape: generation belongs to
    // the accepted operation, not the independently observed public receipt.
    ...(verified ? { publicReceipt: { operationId, sourceVersion: 7, visible, htmlDigest: visible ? "b".repeat(64) : null,
      admissionRevision: 1, rendererSha: sha, contextDigest: "c".repeat(64) }, postProof: { status: "verified" } } : { postProof: { status: "pending" } }) };
  return { contextRevision: revision, pointer: { state: "idle", activeCommitSha: sha }, owners: [owner],
    queues: new Map([[operationId, queue]]), posts: new Map([[postId, { publiclyVisible: visible,
      published: { sourceVersion: 7, metadata: { slug: "story" } } }]]) };
}
const options = () => ({ store, target, account: "unused-test-observer", commitSha: sha });
const current = async () => JSON.parse(await (await runtime.getR2Bucket("CATALOG")).get(key).then(value => value!.text())) as WithdrawalManifest;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "catalog-writer", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: "export default { fetch(){ return new Response('test'); } }" } } },
    env: { CATALOG: { type: "r2", name: "catalog" } } } }] });
  await runtime.ready;
  store = await runtime.getR2Bucket("CATALOG") as unknown as CatalogStore;
});
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => { await (await runtime.getR2Bucket("CATALOG")).delete(key); });

it("stores verified absence permanently through unconfirmed and verified republishing", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  const removed = await current();
  expect(removed.withdrawals).toMatchObject([{ postId, operationId, sourceVersion: 7, ownedSlugs: ["old-story", "story"] }]);
  await publishWithdrawalCatalog(options(), async () => observation(true, 4, false));
  expect((await current()).withdrawals).toEqual(removed.withdrawals);
  await publishWithdrawalCatalog(options(), async () => observation(true, 4));
  expect((await current()).withdrawals).toEqual(removed.withdrawals);
});

it("keeps unknown retained tombstones and does not rewrite an unchanged catalog", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  const before = await store.get(key);
  await publishWithdrawalCatalog(options(), async () => observation());
  expect((await store.get(key))?.etag).toBe(before?.etag);
  const missing = { ...observation(), owners: [], queues: new Map(), posts: new Map() };
  await publishWithdrawalCatalog(options(), async () => missing);
  expect((await current()).withdrawals).toHaveLength(1);
});

it("keeps R2 revision 3 when a revision 4 republish scan races a Firestore-only revision 5 withdrawal", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  let privateState = observation(true, 4);
  let commitWithdrawal!: () => void, ready!: () => void;
  const held = new Promise<void>(resolve => { commitWithdrawal = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = publishWithdrawalCatalog({ ...options(), store: { get: key => store.get(key),
    async put(key, text, conditions) { ready(); await held; return store.put(key, text, conditions); } } },
    async () => structuredClone(privateState));
  await started;
  privateState = observation(false, 5);
  commitWithdrawal();
  await pending;
  expect((await current()).withdrawals).toMatchObject([{ revision: 3, postId }]);

  let down = true, assetReads = 0;
  const cache = new Map<string, Response>();
  const published = structuredClone(fixture);
  published.document.id = postId;
  published.document.published.metadata.slug = "story";
  const worker = createTransitionalPostReadWorker({ rendererSha: sha,
    cache: { async match(key) { return cache.get((key as Request).url)?.clone(); },
      async put(key, value) { cache.set((key as Request).url, value.clone()); } }, waitUntil() {},
    readWithdrawal: slug => readDurablePostWithdrawal(store, target.workerName, slug),
    async getDecision() {
      if (down) throw new Error("Authority unavailable");
      const owner = privateState.owners[0];
      return { kind: owner.visible ? "post" : "gone", receipt: { ...owner, admissionRevision: 1, contextDigest: "c".repeat(64) }, published };
    },
    async render() { return "<!doctype html><html>Verified republished story</html>"; },
    async fetchAsset() { assetReads++; return new Response("Old withdrawn Asset"); } });
  const request = (method = "GET") => worker.fetch(new Request(`${target.origin}/posts/story/`, { method }));
  // Fresh empty cache, with only the newer private withdrawal committed.
  expect((await request())?.status).toBe(410);
  down = false;
  cache.clear();
  const currentRemoval = await request();
  expect(currentRemoval?.status).toBe(410);
  expect(currentRemoval?.headers.get("x-njpbs-content-source")).toBe("cms-no-build");
  expect(assetReads).toBe(0);
});

it("caches successful republish authority for 60 seconds while fresh newer R2 withdrawals win immediately", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  let clock = Date.now(), down = false, reads = 0, assets = 0, identities = 0;
  const entries = new Map<string, Response>();
  const published = structuredClone(fixture);
  published.document.id = postId;
  published.document.published.metadata.slug = "story";
  const owner = observation(true, 4).owners[0];
  const worker = createTransitionalPostReadWorker({ rendererSha: sha, now: () => clock,
    cache: { async match(key) { return entries.get((key as Request).url)?.clone(); },
      async put(key, value) { entries.set((key as Request).url, value.clone()); } }, waitUntil() {},
    readWithdrawal: slug => readDurablePostWithdrawal(store, target.workerName, slug),
    async getDecision() { reads++; if (down) throw new Error("Authority unavailable");
      return { kind: "post", receipt: { ...owner, admissionRevision: 1, contextDigest: "c".repeat(64) }, published }; },
    async render() { return "<!doctype html><html>Verified republished story</html>"; },
    async fetchAsset(request) {
      if (new URL(request.url).pathname === "/_publication.json") {
        identities++;
        return Response.json({ schemaVersion: 1, commitSha: sha, generation: 1 });
      }
      assets++; return new Response("Old withdrawn Asset");
    } });
  const request = (method = "GET") => worker.fetch(new Request(`${target.origin}/posts/story/`, { method }));
  const first = await request();
  expect(first?.status).toBe(200);
  expect(first?.headers.get("x-njpbs-code-generation")).toBe("1");
  expect((await request("HEAD"))?.status).toBe(200);
  expect(reads).toBe(1);
  down = true;
  clock += 59_999;
  expect((await request())?.status).toBe(200);
  expect(reads).toBe(1);
  clock += 1;
  expect((await request())?.status).toBe(410);
  expect((await request("HEAD"))?.status).toBe(410);
  expect(reads).toBe(2); // Failure throttling is separate from successful authority.
  down = false;
  clock += 1_001;
  expect((await request())?.status).toBe(200);
  expect(reads).toBe(3);
  await publishWithdrawalCatalog(options(), async () => observation(false, 5));
  expect((await request())?.status).toBe(410);
  expect((await request("HEAD"))?.status).toBe(410);
  expect(reads).toBe(3);
  expect(assets).toBe(0);
  expect(identities).toBe(3); // Three successful GETs; HEAD and withdrawals read no artifact.
});

it.each(["production", "development"])("invalidates republish authority with the %s background purge tag", async environment => {
  const readerTarget = publicationTarget(environment);
  const tag = environment === "development" ? "njpbs-dev-post-background" : "njpbs-post-background";
  const entries = new Map<string, Response>();
  let down = false, reads = 0, assets = 0, identities = 0;
  const published = structuredClone(fixture);
  published.document.id = postId;
  published.document.published.metadata.slug = "story";
  const owner = observation(true, 4).owners[0];
  const worker = createTransitionalPostReadWorker({ target: readerTarget, rendererSha: sha,
    cache: { async match(key) { return entries.get((key as Request).url)?.clone(); },
      async put(key, value) { entries.set((key as Request).url, value.clone()); } }, waitUntil() {},
    async readWithdrawal() { return { postId, operationId, sourceVersion: 7, revision: 3,
      ownedSlugs: ["story"], verifiedAt: 1234 }; },
    async getDecision() { reads++; if (down) throw new Error("Authority unavailable after purge");
      return { kind: "post", receipt: { ...owner, admissionRevision: 1, contextDigest: "c".repeat(64) }, published }; },
    async render() { return "<!doctype html><html>Verified republished story</html>"; },
    async fetchAsset(request) {
      if (new URL(request.url).pathname === "/_publication.json") {
        identities++;
        return Response.json({ schemaVersion: 1, commitSha: sha, generation: 1 });
      }
      assets++; return new Response("Old withdrawn Asset");
    } });
  const request = () => worker.fetch(new Request(`${readerTarget.origin}/posts/story/`));
  expect((await request())?.status).toBe(200);
  const authorityEntries = [...entries].filter(([url]) => new URL(url).pathname === "/__post-withdrawal-authority/v1");
  expect(authorityEntries).toHaveLength(2);
  expect(authorityEntries.every(([, response]) => response.headers.get("cache-tag") === tag)).toBe(true);
  for (const [url, response] of entries) if (response.headers.get("cache-tag") === tag) entries.delete(url);
  down = true;
  expect((await request())?.status).toBe(410);
  expect(reads).toBe(2);
  expect(assets).toBe(0);
  expect(identities).toBe(1); // Only the initial successful GET needs its code identity.
});

it("preserves max revision and every alias across stale observations and response loss after CAS", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  const next = observation(false, 5);
  next.owners[0].ownedSlugs = ["story", "new-alias"];
  next.queues.get(operationId)!.noBuildPost.ownedSlugs = ["story", "new-alias"];
  await expect(publishWithdrawalCatalog({ ...options(), store: { get: key => store.get(key),
    async put(key, text, conditions) {
      await store.put(key, text, conditions);
      throw new Error("Publisher stopped after persisted CAS");
    } } }, async () => next)).rejects.toThrow("stopped");
  const persisted = await current();
  expect(persisted.withdrawals).toMatchObject([{ revision: 5, ownedSlugs: ["new-alias", "old-story", "story"] }]);
  const etag = (await store.get(key))!.etag;
  await publishWithdrawalCatalog(options(), async () => next);
  expect((await store.get(key))!.etag).toBe(etag);
  // A newer unrelated context cannot lower this Post's publication revision.
  const stale = observation(false, 4);
  stale.contextRevision = 6;
  await publishWithdrawalCatalog(options(), async () => stale);
  expect((await current()).withdrawals).toEqual(persisted.withdrawals);
});

it.each(["wrong operation", "wrong source", "unconfirmed", "changed visibility", "changed aliases", "deleted"])(
  "retains a tombstone through %s republish proof", async mismatch => {
  await publishWithdrawalCatalog(options(), async () => observation());
  const candidate = observation(true, 4);
  const queue = candidate.queues.get(operationId)!;
  if (mismatch === "wrong operation") queue.publicReceipt.operationId = "B".repeat(20);
  if (mismatch === "wrong source") queue.publicReceipt.sourceVersion = 8;
  if (mismatch === "unconfirmed") queue.postProof.status = "failed";
  if (mismatch === "changed visibility") candidate.posts.get(postId)!.publiclyVisible = false;
  if (mismatch === "changed aliases") queue.noBuildPost.ownedSlugs = ["story"];
  if (mismatch === "deleted") candidate.posts.get(postId)!.deleted = true;
  await publishWithdrawalCatalog(options(), async () => candidate);
  expect((await current()).withdrawals).toHaveLength(1);
});

it("retains the tombstone when an older writer loses to a republish observation", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const stale = observation();
  stale.owners[0].sourceVersion = 8;
  stale.queues.get(operationId)!.noBuildPost.sourceVersion = 8;
  stale.queues.get(operationId)!.publicReceipt.sourceVersion = 8;
  stale.posts.get(postId)!.published.sourceVersion = 8;
  const old = publishWithdrawalCatalog(options(), async () => { started(); await held; return stale; });
  await ready;
  await publishWithdrawalCatalog(options(), async () => observation(true, 4));
  release();
  await expect(old).rejects.toThrow("Durable withdrawal publication");
  expect((await current()).contextRevision).toBe(4);
  expect((await current()).withdrawals).toMatchObject([{ revision: 3, postId }]);
});

it("rejects a delayed revision 4 CAS after revision 5 persists under the native R2 ETag fence", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  let first = true, lost = false;
  const old = publishWithdrawalCatalog({ ...options(), store: { get: key => store.get(key),
    async put(key, text, conditions) {
      if (first) { first = false; ready(); await held; }
      const written = await store.put(key, text, conditions);
      lost = written === null;
      return written;
    } } }, async () => observation(false, 4));
  await started;
  await publishWithdrawalCatalog(options(), async () => observation(false, 5));
  release();
  await expect(old).rejects.toThrow("Durable withdrawal publication");
  expect(lost).toBe(true);
  expect((await current()).withdrawals).toMatchObject([{ revision: 5, postId }]);
});

it("refuses an overflowing write and leaves the prior immutable data intact", async () => {
  const previous = { schemaVersion: 1, workerName: target.workerName, contextRevision: 3,
    withdrawals: Array.from({ length: WITHDRAWAL_MANIFEST_POSTS }, (_, index) => ({ postId: `retained-${index}`,
      operationId, sourceVersion: 1, revision: 1, ownedSlugs: [`retained-${index}`], verifiedAt: 1234 })) } as WithdrawalManifest;
  await expect(mergeWithdrawalCatalog(previous, observation(), target.workerName)).rejects.toThrow("exceeds its limit");
  await (await runtime.getR2Bucket("CATALOG")).put(key, encodeWithdrawalManifest(previous, target.workerName));
  const beforeOverflow = (await store.get(key))!.etag;
  await expect(publishWithdrawalCatalog(options(), async () => observation())).rejects.toThrow("exceeds its limit");
  expect((await store.get(key))!.etag).toBe(beforeOverflow);
  await (await runtime.getR2Bucket("CATALOG")).delete(key);
  await publishWithdrawalCatalog(options(), async () => observation());
  const before = await current();
  await expect(publishWithdrawalCatalog({ ...options(), store: undefined })).rejects.toThrow("Durable withdrawal publication");
  expect(await current()).toEqual(before);
});

it("retains the tombstone through an exact deployed static return", async () => {
  await publishWithdrawalCatalog(options(), async () => observation());
  const candidate = observation(true, 4);
  const post = { version: 8, publiclyVisible: true, published: { sourceVersion: 8,
    publishedAt: "2026-10-12T12:00:00.000Z", authorIds: ["z-author"], blocks: [],
    metadata: { type: "post", slug: "story", previousSlugs: ["old-story"],
      credits: [{ kind: "registered", authorId: "a-author" }] } } };
  const dependency = background.dependency(post);
  candidate.posts.set(postId, post);
  const owner = candidate.owners[0];
  owner.mode = "static";
  owner.staticProof = { schemaVersion: 1, postId, operationId, sourceVersion: 8, visible: true,
    slug: "story", ownedSlugs: owner.ownedSlugs, snapshotDigest: dependency.digest,
    contextDigest: context.publicContextDigest(4) };
  candidate.queues.clear();
  candidate.pointer.activeCommitSha = "d".repeat(40);
  await publishWithdrawalCatalog(options(), async () => candidate);
  expect((await current()).withdrawals).toHaveLength(1);
  candidate.pointer.activeCommitSha = sha;
  owner.staticProof.snapshotDigest = "e".repeat(64);
  await publishWithdrawalCatalog(options(), async () => candidate);
  expect((await current()).withdrawals).toHaveLength(1);
  owner.staticProof.snapshotDigest = dependency.digest;
  await publishWithdrawalCatalog(options(), async () => candidate);
  expect((await current()).withdrawals).toMatchObject([{ revision: 3, postId }]);
});

it("bounds a stalled observation and never writes after its deadline", async () => {
  vi.useFakeTimers();
  try {
    let release!: (value: CatalogObservation) => void;
    const put = vi.fn();
    const pending = publishWithdrawalCatalog({ ...options(), store: { get: async () => null, put } },
      () => new Promise(resolve => { release = resolve; }));
    const rejected = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(WITHDRAWAL_PUBLISH_TIMEOUT_MS);
    await rejected;
    release(observation());
    await Promise.resolve();
    expect(put).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
