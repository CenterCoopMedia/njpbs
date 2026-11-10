import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/shadow-posts/post.json";
import { createShadowPostWorker, purgePublishedPostRoutes, servicePublishedPostReader } from "../../workers/src/shadow-post-worker";

const url = "https://dev-public.example.org/posts/shadow-fixture/";
const config = { SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture" };

// Fake only the remote reader and edge cache. The signer, projector and Worker
// are real. Expectations come from #2857 and its withdrawal requirement.
function harness() {
  let time = new Date("2026-10-07T13:00:00Z");
  let published = true;
  let gone = false;
  let input = structuredClone(fixture);
  let cacheReads = 0;
  let renderWait: Promise<void> | undefined;
  let rendering: (() => void) | undefined;
  let unavailable = false;
  let refused = false;
  let storeUnavailable = false;
  let record: unknown = { schemaVersion: 1, kind: "published", revision: "1".repeat(64), sourceRevision: createHash("sha256").update(JSON.stringify(fixture)).digest("hex") };
  let requests = 0;
  const entries = new Map<string, { response: Response; expires: number }>();
  const reader = servicePublishedPostReader({
    async fetch() {
      requests++;
      if (refused) return Response.json({ error: "Published content is unavailable" }, { status: 503, headers: { "X-Njpbs-Post-Read-Failure": "refusal" } });
      if (unavailable) throw new Error("Reader unavailable");
      if (gone) return Response.json({ kind: "gone" }, { status: 410 });
      return Response.json(published ? input : { kind: "not-found" }, { status: published ? 200 : 404 });
    },
  }, { secret: "test-only-reader-key-with-at-least-32-characters", now: () => time });
  const worker = createShadowPostWorker({
    revisions: { async get() { if (storeUnavailable) throw new Error("KV unavailable"); return record; } },
    reader, rendererSha: "a".repeat(40), now: () => time,
    cache: {
      async match(key) {
        cacheReads++;
        const entry = entries.get(key.url);
        return entry && entry.expires > time.getTime() ? entry.response.clone() : undefined;
      },
      async put(key, response) {
        const ttl = Number(/(?:^|[, ])max-age=(\d+)/.exec(response.headers.get("Cache-Control") ?? "")?.[1] ?? 0);
        entries.set(key.url, { response: response.clone(), expires: time.getTime() + ttl * 1000 });
      },
    },
    async render(content) {
      rendering?.();
      await renderWait;
      return `<!doctype html><html><title>${content.posts[0].title}</title><main>Published body</main></html>`;
    },
  });
  return {
    get: (method = "GET") => worker.fetch(new Request(url, { method }), config),
    cacheReads: () => cacheReads,
    setRecord(value: unknown) { record = value; },
    update() {
      input.document.published.sourceVersion = 8;
      input.document.published.metadata.title = "Updated public title";
      record = { schemaVersion: 1, kind: "published", revision: "2".repeat(64),
        sourceRevision: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
    },
    holdRender(wait: Promise<void>, started: () => void) { renderWait = wait; rendering = started; },
    requests: () => requests,
    withdrawReader() { published = false; },
    deleteReader() { gone = true; },
    restoreReader() { published = true; gone = false; },
    withdraw() { published = false; record = { schemaVersion: 1, kind: "withdrawn" }; },
    loseStore() { storeUnavailable = true; },
    fail() { unavailable = true; },
    refuse() { refused = true; },
    advance(milliseconds: number) { time = new Date(time.getTime() + milliseconds); },
  };
}

describe("issue 2857 cache and withdrawal contract", () => {
  it("does not reuse old HTML when KV advances and the reader is unavailable", async () => {
    const h = harness();
    expect((await h.get()).status).toBe(200);
    h.update(); h.fail();
    expect((await h.get()).status).toBe(503);
  });

  it("renders a new revision and reuses it for GET and HEAD", async () => {
    const h = harness();
    await h.get(); h.update();
    expect(await (await h.get()).text()).toContain("Updated public title");
    const head = await h.get("HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(h.requests()).toBe(2);
  });

  it("remembers a reader-confirmed withdrawal while KV propagation lags", async () => {
    const h = harness();
    await h.get(); h.advance(301_000); h.withdrawReader();
    expect((await h.get()).status).toBe(404);
    h.fail();
    expect((await h.get()).status).toBe(404);
  });

  it.each([null, {}, { schemaVersion: 9, kind: "withdrawn" }, { schemaVersion: 1, kind: "published", revision: "bad" }])(
    "falls back to read-through for an absent or invalid record %j", async record => {
      const h = harness();
      await h.get(); h.setRecord(record); h.withdrawReader();
      expect((await h.get()).status).toBe(404);
      expect(h.requests()).toBe(2);
    });

  it("does not admit a late in-flight cache write after a KV tombstone", async () => {
    const h = harness();
    let start!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    h.holdRender(gate, start);
    const pending = h.get(); await started;
    h.withdraw();
    expect((await h.get()).status).toBe(410);
    finish(); await pending;
    expect((await h.get()).status).toBe(410);
  });

  it("does not serve stale HTML after an authoritative reader refusal", async () => {
    const h = harness();
    await h.get(); h.advance(301_000); h.refuse();
    expect((await h.get()).status).toBe(503);
  });

  it.each([404, 410])("rechecks an expired %i marker after reader recovery without a KV change", async status => {
    const h = harness();
    if (status === 410) h.deleteReader(); else h.withdrawReader();
    expect((await h.get()).status).toBe(status);
    h.restoreReader();
    h.advance(299_999);
    expect((await h.get()).status).toBe(status);
    expect(h.requests()).toBe(1);
    h.advance(1);
    expect((await h.get()).status).toBe(200);
    expect(h.requests()).toBe(2);
  });

  it("allows only one minute of stale HTML after freshness ends", async () => {
    const h = harness();
    expect((await h.get()).status).toBe(200);
    h.advance(359_999); h.fail();
    expect((await h.get()).status).toBe(200);
    h.advance(1);
    expect((await h.get()).status).toBe(503);
    h.advance(60_000);
    expect((await h.get()).status).toBe(503);
  });

  it("bounds stale storage to one day", async () => {
    const h = harness();
    await h.get(); h.advance(86_400_001); h.fail();
    expect((await h.get()).status).toBe(503);
  });

  it("serves a fresh cache hit without another reader request", async () => {
    const h = harness();
    expect((await h.get()).status).toBe(200);
    expect((await h.get()).status).toBe(200);
    expect(h.requests()).toBe(1);
  });

  it("serves the last good render after freshness expires and the reader fails", async () => {
    const h = harness();
    expect((await h.get()).status).toBe(200);
    h.advance(301_000);
    h.fail();
    const response = await h.get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain("Published body");
  });

  it("fails closed through the reader when KV is unreachable", async () => {
    const h = harness();
    expect((await h.get()).status).toBe(200);
    h.loseStore();
    h.withdraw();
    expect((await h.get()).status).toBe(404);
    h.fail();
    expect((await h.get()).status).toBe(503);
  });

  it("does not serve a confirmed withdrawal while its remote purge is unavailable", async () => {
    const h = harness();
    expect((await h.get()).status).toBe(200);
    const cacheReads = h.cacheReads();
    h.withdraw();
    await expect(purgePublishedPostRoutes(["shadow-fixture"], {
      async purge() { throw new Error("Remote purge unavailable"); },
    })).rejects.toThrow("Remote purge unavailable");
    const withdrawn = await h.get();
    expect(withdrawn.status).toBe(410);
    expect(await withdrawn.text()).not.toContain("Published body");
    h.fail();
    const failed = await h.get();
    expect(failed.status).toBe(410);
    expect(h.cacheReads()).toBe(cacheReads);
    expect(await failed.text()).not.toContain("Published body");
  });
});
