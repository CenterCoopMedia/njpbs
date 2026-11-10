import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import revisions from "../../functions/shadow-post-revisions.js";
import reader from "../../functions/published-post-reader.js";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { chromeSettings } from "../../site/tests/fixtures/shadow-posts/chrome";
import fixture from "../../site/tests/fixtures/shadow-posts/post.json";
import { createShadowPostWorker, servicePublishedPostReader } from "../../workers/src/shadow-post-worker";

const db = isolatedFirestore("shadow-post-revisions.test.ts");
const config = { enabled: true, origin: "https://dev-public.example.org", projectId: db.projectId, accountId: "1".repeat(32),
  namespaceId: "2".repeat(32), zoneId: "3".repeat(32), slugs: ["shadow-fixture", "old-fixture"] };
const START = Date.parse("2026-10-07T13:00:00Z");
const token = "test-only-cloudflare-token";
function document(overrides = {}) { return structuredClone({ ...fixture.document, version: 8, publicSourceVersion: 7, ...overrides }); }
function boundary() {
  const kv = new Map<string, unknown>();
  const requests: { url: string; body: any }[] = [];
  let fail = "";
  let time = START;
  const deps = { firestore: db, config, now: () => time, getToken: () => token,
    async fetchImpl(url: string, init: RequestInit) {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
      expect(init.redirect).toBe("error");
      const body = JSON.parse(String(init.body));
      requests.push({ url, body });
      if (url.includes(fail) && fail) throw new Error(token);
      if (init.method === "PUT") {
        expect(url).toContain(`/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/`);
        kv.set(decodeURIComponent(url.split("/").at(-1)!), body);
      } else {
        expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`);
        expect(Object.keys(body)).toEqual(["tags"]);
      }
      return Response.json({ success: true, errors: [], messages: [], result: null });
    } };
  return { kv, requests, deps, run: revisions.createShadowPostRevisionRunner(deps),
    fail(value: string) { fail = value; }, advance(ms: number) { time += ms; } };
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("Use a local demo Firestore emulator");
  }
});
beforeEach(async () => {
  await Promise.all([db.doc("cmsPosts/kv-fixture").delete(), ...config.slugs.map(slug => db.doc(`cmsShadowPostRevisions/${slug}`).delete())]);
});

describe("shadow revision delivery across Firestore and Cloudflare HTTP", () => {
  it("refreshes the KV revision for published chrome on the minute sweep without a Post write", async () => {
    const h = boundary();
    const post = document();
    await db.doc("cmsPosts/kv-fixture").set(post);
    const setting = chromeSettings()[1];
    const ref = db.doc(`cmsSettings/${setting.id}`);
    try {
      await ref.set({ version: setting.version, published: setting.published });
      await h.run(["shadow-fixture"]);
      const first = h.kv.get("post:shadow-fixture");
      await ref.update({ version: 5, values: { newsletterLabel: "Private draft" } });
      await h.run(["shadow-fixture"]);
      expect(h.kv.get("post:shadow-fixture")).toEqual(first);
      expect(h.requests).toHaveLength(2);
      await ref.update({ published: chromeSettings("Station newsletter")[1].published });
      h.advance(60_000);
      await h.run(["shadow-fixture"]);
      expect(h.kv.get("post:shadow-fixture")).not.toEqual(first);
      expect(h.requests).toHaveLength(4);
      expect(h.requests.at(-1)?.body).toEqual({ tags: ["njpbs-dev-post-shadow-fixture"] });
      expect((await db.doc("cmsPosts/kv-fixture").get()).data()).toEqual(post);
    } finally { await ref.delete(); }
  });

  it("does not rewrite a tombstone after Firestore sorts its map keys", async () => {
    const h = boundary();
    await h.run(["shadow-fixture"]);
    // Firestore's documented map order is kind, schemaVersion. Supply that
    // order explicitly because the emulator need not model production ordering.
    const ref = db.doc("cmsShadowPostRevisions/shadow-fixture");
    const retained = (await ref.get()).data();
    // The emulator preserves the first insertion order even across set/update.
    await ref.delete();
    await ref.set({ ...retained, delivered: { kind: "withdrawn", schemaVersion: 1 } });
    expect(Object.keys((await ref.get()).data()!.delivered)).toEqual(["kind", "schemaVersion"]);
    await h.run(["shadow-fixture"]);
    await h.run(["shadow-fixture"]);
    expect(h.requests).toHaveLength(2);
    expect(h.kv.get("post:shadow-fixture")).toEqual({ schemaVersion: 1, kind: "withdrawn" });
  });

  it("does not renew admission for duplicate or older events", async () => {
    const h = boundary();
    const ref = db.doc("cmsPosts/kv-fixture");
    const before = await ref.get();
    await ref.set(document());
    const after = await ref.get();
    const event = { data: { before, after } };
    const followup = revisions.createShadowPostRevisionFollowup(h.deps);
    await followup(event);
    const first = h.kv.get("post:shadow-fixture");
    await followup(event);
    expect(h.kv.get("post:shadow-fixture")).toEqual(first);
    expect(h.requests).toHaveLength(2);
    await ref.update({ "published.metadata.title": "Updated public title", "published.sourceVersion": 8 });
    await followup({ data: { before: after, after: await ref.get() } });
    const updated = h.kv.get("post:shadow-fixture");
    expect(updated).not.toEqual(first);
    await followup(event);
    expect(h.kv.get("post:shadow-fixture")).toEqual(updated);
    expect(h.requests).toHaveLength(4);
  });

  it("retries a failed event purge without minting another revision", async () => {
    const h = boundary();
    const ref = db.doc("cmsPosts/kv-fixture");
    const before = await ref.get();
    await ref.set(document());
    const event = { data: { before, after: await ref.get() } };
    const followup = revisions.createShadowPostRevisionFollowup(h.deps);
    h.fail("purge_cache");
    await expect(followup(event)).rejects.toThrow("pending");
    const first = h.kv.get("post:shadow-fixture");
    h.fail(""); h.advance(60_000);
    await followup(event);
    expect(h.kv.get("post:shadow-fixture")).toEqual(first);
    expect(h.requests.filter(request => request.url.includes("/values/"))).toHaveLength(1);
    expect(h.requests.filter(request => request.url.endsWith("purge_cache"))).toHaveLength(2);
  });

  it("retains renewal through a failed withdrawal without renewing its retry twice", async () => {
    const h = boundary();
    const ref = db.doc("cmsPosts/kv-fixture");
    const before = await ref.get();
    const original = document();
    await ref.set(original);
    const published = await ref.get();
    const followup = revisions.createShadowPostRevisionFollowup(h.deps);
    await followup({ data: { before, after: published } });
    const first = h.kv.get("post:shadow-fixture") as any;
    await ref.update({ publiclyVisible: false });
    const withdrawal = { data: { before: published, after: await ref.get() } };
    h.fail("/values/");
    await expect(followup(withdrawal)).rejects.toThrow("pending");
    await ref.set(original);
    h.fail(""); h.advance(60_000);
    // The scheduler must retain the missed withdrawal's admission-renewal intent.
    await h.run(["shadow-fixture"]);
    const renewed = h.kv.get("post:shadow-fixture") as any;
    expect(renewed.sourceRevision).toBe(first.sourceRevision);
    expect(renewed.revision).not.toBe(first.revision);
    const requestCount = h.requests.length;
    await followup(withdrawal);
    expect(h.kv.get("post:shadow-fixture")).toEqual(renewed);
    expect(h.requests).toHaveLength(requestCount);
  });

  it("delivers a deletion during backoff once even though it has no after update time", async () => {
    const h = boundary();
    const ref = db.doc("cmsPosts/kv-fixture");
    const before = await ref.get();
    await ref.set(document());
    const published = await ref.get();
    const followup = revisions.createShadowPostRevisionFollowup(h.deps);
    h.fail("purge_cache");
    await expect(followup({ data: { before, after: published } })).rejects.toThrow("pending");
    await ref.delete();
    const deletion = { data: { before: published, after: await ref.get() } };
    h.fail("");
    await followup(deletion);
    expect(h.kv.get("post:shadow-fixture")).toEqual({ schemaVersion: 1, kind: "withdrawn" });
    const requestCount = h.requests.length;
    await followup(deletion);
    expect(h.requests).toHaveLength(requestCount);
  });

  it("ignores non-pilot writes before validating delivery configuration", async () => {
    const h = boundary();
    const followup = revisions.createShadowPostRevisionFollowup({ ...h.deps,
      config: { ...config, namespaceId: "" } });
    const otherPost = document();
    otherPost.published.metadata.slug = "outside-pilot";
    for (const after of [{ title: "Draft" }, otherPost]) {
      await expect(followup({ data: { before: { data: () => undefined }, after: { data: () => after } } }))
        .resolves.toBeUndefined();
    }
    await expect(followup({ data: { before: { data: () => undefined }, after: { data: () => document() } } }))
      .rejects.toThrow("refused");
    expect(h.requests).toHaveLength(0);
    expect((await db.collection("cmsShadowPostRevisions").get()).empty).toBe(true);
  });

  it("uses a new admission revision after an identical-byte republication", async () => {
    const h = boundary();
    const original = document();
    await db.doc("cmsPosts/kv-fixture").set(original);
    await h.run(["shadow-fixture"]);
    const first = h.kv.get("post:shadow-fixture") as any;
    await db.doc("cmsPosts/kv-fixture").update({ publiclyVisible: false });
    await h.run(["shadow-fixture"]);
    await db.doc("cmsPosts/kv-fixture").set(original);
    await h.run(["shadow-fixture"]);
    const restored = h.kv.get("post:shadow-fixture") as any;
    expect(restored.sourceRevision).toBe(first.sourceRevision);
    expect(restored.revision).not.toBe(first.revision);
  });

  it("repairs a KV result after a crash before Firestore acknowledgement", async () => {
    const h = boundary();
    await db.doc("cmsPosts/kv-fixture").set(document());
    await h.run(["shadow-fixture"]);
    const previous = h.kv.get("post:shadow-fixture");
    // Provider accepted a tombstone but the process ended before writeback.
    h.kv.set("post:shadow-fixture", { schemaVersion: 1, kind: "withdrawn" });
    await db.doc("cmsShadowPostRevisions/shadow-fixture").update({ claim: "crashed", phase: "processing",
      nextAttemptAt: START - 1, leaseUntil: START - 1 });
    await h.run(["shadow-fixture"]);
    expect(h.kv.get("post:shadow-fixture")).toMatchObject({ kind: "published" });
    expect(h.kv.get("post:shadow-fixture")).not.toEqual(previous);
  });

  it("writes only the public revision, serves repeated views without reader calls, then withdraws despite purge failure", async () => {
    await db.doc("cmsPosts/kv-fixture").set(document());
    const h = boundary();
    await h.run(["shadow-fixture"]);
    const input = await reader.readPublishedPost({ firestore: db, slug: "shadow-fixture", now: new Date(START) });
    expect(h.kv.get("post:shadow-fixture")).toEqual({ schemaVersion: 1, kind: "published",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/), sourceRevision: createHash("sha256").update(JSON.stringify(input)).digest("hex") });
    expect(JSON.stringify(h.requests)).not.toMatch(/Private working title|Published body|test-only-cloudflare-token/);
    const cache = new Map<string, Response>();
    let reads = 0;
    const worker = createShadowPostWorker({ rendererSha: "a".repeat(40), now: () => new Date(START),
      revisions: { async get(key) { return h.kv.get(key); } },
      reader: servicePublishedPostReader({ async fetch() { reads++; return Response.json(input); } },
        { secret: "test-only-reader-secret-at-least-32-characters" }),
      cache: { async match(key) { return cache.get(key.url)?.clone(); }, async put(key, value) { cache.set(key.url, value); } },
      async render(content) { return `<!doctype html><html>${content.posts[0].title}</html>`; } });
    const get = () => worker.fetch(new Request("https://dev-public.example.org/posts/shadow-fixture/"),
      { SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture" });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect(reads).toBe(1);
    await db.doc("cmsPosts/kv-fixture").update({ publiclyVisible: false });
    h.fail("purge_cache");
    await expect(h.run(["shadow-fixture"])).rejects.toThrow("pending");
    expect(h.kv.get("post:shadow-fixture")).toEqual({ schemaVersion: 1, kind: "withdrawn" });
    expect((await get()).status).toBe(410);
    expect(reads).toBe(1);
    expect((await db.doc("cmsShadowPostRevisions/shadow-fixture").get()).data()).toMatchObject({ phase: "retry", purged: false,
      delivered: { kind: "withdrawn" }, nextAttemptAt: START + 60_000 });
    h.fail(""); h.advance(60_000);
    await h.run(["shadow-fixture"]);
    expect((await db.doc("cmsShadowPostRevisions/shadow-fixture").get()).data()).toMatchObject({ phase: "success", purged: true });
    expect(h.requests.filter(request => request.url.includes("/values/")).length).toBe(2);
  });

  it("retains failed KV writes, then retries the latest state instead of replaying an old publication", async () => {
    const before = document();
    await db.doc("cmsPosts/kv-fixture").set(before);
    const h = boundary(); h.fail("/values/");
    await expect(h.run(["shadow-fixture"])).rejects.toThrow("pending");
    const state = (await db.doc("cmsShadowPostRevisions/shadow-fixture").get()).data();
    expect(state).toMatchObject({ phase: "retry", delivered: null, attempts: 1, nextAttemptAt: START + 60_000 });
    expect(JSON.stringify(state)).not.toContain(token);
    const after = document({ deleted: true, publiclyVisible: false });
    await db.doc("cmsPosts/kv-fixture").set(after);
    h.fail("");
    // A new withdrawal bypasses retry backoff, and old event delivery reads
    // current Firestore state rather than publishing its old snapshot again.
    const followup = revisions.createShadowPostRevisionFollowup(h.deps);
    await followup({ data: { before: { data: () => before }, after: { data: () => after } } });
    await followup({ data: { before: { data: () => undefined }, after: { data: () => before } } });
    expect(h.kv.get("post:shadow-fixture")).toEqual({ schemaVersion: 1, kind: "withdrawn" });
    expect((await db.doc("cmsPosts/kv-fixture").get()).data()).toEqual(after);
  });

  it("writes tombstones for retired slugs and a new revision for updates", async () => {
    const h = boundary();
    await db.doc("cmsPosts/kv-fixture").set(document());
    await h.run();
    const first = h.kv.get("post:shadow-fixture");
    await db.doc("cmsPosts/kv-fixture").update({ "published.metadata.title": "Updated public title",
      "published.metadata.previousSlugs": ["old-fixture"], "published.sourceVersion": 8 });
    await h.run();
    expect(h.kv.get("post:shadow-fixture")).not.toEqual(first);
    expect(h.kv.get("post:old-fixture")).toEqual({ schemaVersion: 1, kind: "withdrawn" });
    expect(h.requests.filter(value => value.url.endsWith("purge_cache")).map(value => value.body.tags))
      .toContainEqual(["njpbs-dev-post-shadow-fixture"]);
  });

  it("serializes concurrent delivery and recovers an expired claim", async () => {
    await db.doc("cmsPosts/kv-fixture").set(document());
    const h = boundary();
    let start!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const run = revisions.createShadowPostRevisionRunner({ ...h.deps, fetchImpl: async (url: string, init: RequestInit) => {
      if (init.method === "PUT") { start(); await gate; }
      return h.deps.fetchImpl(url, init);
    } });
    const pending = run(["shadow-fixture"]);
    await started;
    await expect(h.run(["shadow-fixture"])).rejects.toThrow("pending");
    expect(h.requests).toHaveLength(0);
    finish(); await pending;
    await db.doc("cmsShadowPostRevisions/shadow-fixture").update({ claim: "crashed", leaseUntil: START - 1,
      nextAttemptAt: START - 1, phase: "processing" });
    await h.run(["shadow-fixture"]);
    expect((await db.doc("cmsShadowPostRevisions/shadow-fixture").get()).data()).toMatchObject({ phase: "success", claim: null });
  });

  it("reasserts a tombstone when an interrupted publication was never acknowledged", async () => {
    const h = boundary();
    await db.doc("cmsPosts/kv-fixture").set(document({ publiclyVisible: false }));
    await h.run(["shadow-fixture"]);
    h.kv.set("post:shadow-fixture", { schemaVersion: 1, kind: "published", revision: "a".repeat(64), sourceRevision: "b".repeat(64) });
    await db.doc("cmsShadowPostRevisions/shadow-fixture").update({ claim: "crashed", phase: "processing",
      nextAttemptAt: START - 1, leaseUntil: START - 1 });
    await h.run(["shadow-fixture"]);
    expect(h.kv.get("post:shadow-fixture")).toEqual({ schemaVersion: 1, kind: "withdrawn" });
  });

  it("renews admission for a forced event even when withdrawal was never delivered", async () => {
    const h = boundary();
    const original = document();
    await db.doc("cmsPosts/kv-fixture").set(original);
    await h.run(["shadow-fixture"]);
    const first = h.kv.get("post:shadow-fixture");
    const withdrawn = document({ publiclyVisible: false });
    await db.doc("cmsPosts/kv-fixture").set(withdrawn);
    h.fail("/values/");
    await expect(h.run(["shadow-fixture"], { force: true })).rejects.toThrow("pending");
    // Republish identical content before the withdrawal's delayed retry.
    await db.doc("cmsPosts/kv-fixture").set(original);
    h.fail("");
    await revisions.createShadowPostRevisionFollowup(h.deps)({ data: {
      before: { data: () => original }, after: { data: () => withdrawn },
    } });
    expect(h.kv.get("post:shadow-fixture")).not.toEqual(first);
    expect(h.kv.get("post:shadow-fixture")).toMatchObject({ kind: "published" });
  });

  it("withdraws an admitted revision when the current reader deterministically refuses it", async () => {
    const h = boundary();
    await db.doc("cmsPosts/kv-fixture").set(document());
    await h.run(["shadow-fixture"]);
    await db.doc("cmsPosts/kv-fixture").update({ publicSourceVersion: 9 });
    await h.run(["shadow-fixture"]);
    expect(h.kv.get("post:shadow-fixture")).toEqual({ schemaVersion: 1, kind: "withdrawn" });
  });

  it("does no work while disabled and rejects non-dev or mismatched configuration", async () => {
    const h = boundary();
    await revisions.createShadowPostRevisionRunner({ ...h.deps, config: { ...config, enabled: false } })();
    for (const invalid of [{ origin: "https://njpbs.org" }, { projectId: "njpbs-site" }, { namespaceId: "" }]) {
      await expect(revisions.createShadowPostRevisionRunner({ ...h.deps, config: { ...config, ...invalid } })()).rejects.toThrow("refused");
    }
    expect(h.requests).toHaveLength(0);
    expect((await db.collection("cmsShadowPostRevisions").get()).empty).toBe(true);
  });
});
