import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
// Handler fixtures must not also run through the live Functions emulator.
const db = isolatedFirestore("post-background-outputs.test.js");
import alerts from "../../functions/lib/post-background-alerts.js";
import contextRevision from "../../functions/lib/public-context-revision.js";
import background from "../../functions/lib/post-background-outputs.js";
import mediaBin from "../../functions/lib/media-bin.js";
import homeAdmission from "../../functions/lib/home-source-selection-admission.js";

const outputs = ["listings", "authors", "feed", "contentApi", "sitemap", "search"];
const digest = value => createHash("sha256").update(value).digest("hex");
const postId = "background-fixture";
const rendererSha = "a".repeat(40);
const start = Date.parse("2026-10-08T12:00:00Z");
let directory;
let time;
let fail;
let onBuild;
let onRead;
let files;

function document(version = 1, overrides = {}) {
  return { version, publiclyVisible: true, title: "Private working title",
    published: { sourceVersion: version, publishedAt: "2026-10-08T12:00:00Z", authorIds: ["author-old"],
      metadata: { type: "post", slug: "old-story", previousSlugs: [], date: "2026-10-08", title: "Public story",
        categories: ["News"], tags: ["text"], credits: [{ kind: "registered", authorId: "author-old", name: "Old author" }] },
      blocks: [] }, ...overrides };
}

const artifacts = {
  async put(key, bytes) {
    const path = join(directory, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  },
  async get(key) {
    if (onRead) await onRead(key);
    return readFile(join(directory, key));
  },
};

function owner(options = {}) {
  return background.createPostBackgroundOutputs({ firestore: db, enabled: true, postIds: [postId],
    contentApiEnabled: true, now: () => time, artifacts,
    async readContextInTransaction(transaction) {
      const value = (await transaction.get(db.doc("backgroundTestContext/current"))).data();
      return { rendererSha, ...value, withdrawalRevision: value.withdrawalRevision ?? 0, changedAt: value.changedAt ?? time };
    },
    async build(task, { signal }) {
      if (onBuild) await onBuild(task, signal);
      if (fail === task.output) throw new Error("private provider secret must not be persisted");
      const current = (await db.doc(`cmsPosts/${postId}`).get()).data();
      const visible = (current?.publiclyVisible === true || (current?.publiclyVisible === undefined && current?.status === "published")) && current.deleted !== true;
      const routeSet = visible ? [{ path: `/posts/${current.published.metadata.slug}/`,
        sourceVersion: current.published.sourceVersion, digest: task.dependencies.after.digest }] : [];
      const contextDigest = (await db.doc("backgroundTestContext/current").get()).data().digest;
      const otherPost = (await db.doc("cmsPosts/other-post").get()).data();
      const otherVisible = otherPost?.publiclyVisible === true && otherPost.deleted !== true;
      const publication = { buildBatchId: `home-${task.revision}`, generation: task.revision, commitSha: rendererSha };
      const catalog = { schemaVersion: 1, cutoffAt: "2026-10-11T12:00:00Z", sources: Object.fromEntries(
        ["home-featured", "home-more", "home-spotlight", "home-posts"].map(section => [section,
          { status: "ready", checkedAt: "2026-10-11T12:00:00Z", cards: [] }])) };
      const homeSource = homeAdmission.sealHomeCatalog(catalog, publication);
      if (otherVisible) routeSet.push({ path: `/posts/${otherPost.published.metadata.slug}/`, sourceVersion: otherPost.published.sourceVersion,
        digest: digest(JSON.stringify(otherPost.published)) });
      return { input: { kind: "public-background", rendererSha: (await db.doc("backgroundTestContext/current").get()).data().rendererSha ?? rendererSha, contextDigest, routes: routeSet },
        assets: [{ path: "/_astro/old.abc123.css", contentType: "text/css", bytes: "body { color: red; }" }],
        files: files[task.output].map(path => ({ path, contentType: path.endsWith(".json") ? "application/json" : "text/plain",
          bytes: path === "/_home-sources.json" ? JSON.stringify({ schemaVersion: 1, publication, editorial: homeSource,
            pbs: { source: "manual", checkedAt: "2026-10-11T12:00:00Z", featured: [], more: [] },
            spotlight: { source: "spotlight-rss", checkedAt: "2026-10-11T12:00:00Z", cards: [] } }) :
            `${task.output} revision ${task.revision}: ${visible ? current.published.metadata.title : "Removed"}${otherVisible ? `; ${otherPost.published.metadata.title}` : ""}` })) };
    }, ...options });
}

// This models the #2791 integration boundary: The caller owns authorization and
// writes detail/history/queue plus the prepared follow-ups in one transaction.
async function accept(queueId, nextDocument, worker = owner(), { abort = false, homePlacementPaths = [] } = {}) {
  await db.runTransaction(async transaction => {
    const before = (await transaction.get(db.doc(`cmsPosts/${postId}`))).data();
    const oldContext = (await transaction.get(db.doc("backgroundTestContext/current"))).data();
    const writeBackground = await worker.prepareInTransaction({ transaction, queueId, postId, nextDocument,
      homePlacementPaths });
    transaction.set(db.doc(`cmsPosts/${postId}`), nextDocument);
    transaction.set(db.doc(`cmsVersionHistory/${queueId}`), { sourceVersion: nextDocument.published.sourceVersion });
    transaction.set(db.doc(`cmsPublishQueue/${queueId}`), { status: "success", transport: "test-detail", changes: [] });
    if (before?.publiclyVisible && nextDocument.publiclyVisible === false) {
      transaction.set(db.doc("backgroundTestContext/current"), { ...oldContext,
        withdrawalRevision: (oldContext.withdrawalRevision ?? 0) + 1 });
    }
    writeBackground();
    if (abort) throw new Error("abort publication");
  });
}
async function request(path, worker = owner(), method = "GET") {
  return worker.serve(new Request(`https://example.test${path}`, { method }));
}
async function task(queueId, output) {
  return (await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/${output}`).get()).data();
}

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) {
    throw new Error("Use a local demo Firestore emulator");
  }
  directory = await mkdtemp(join(tmpdir(), "background-2792-"));
});
beforeEach(async () => {
  await Promise.all(["cmsBackgroundOutputs", "cmsPosts", "cmsPublishQueue", "cmsVersionHistory", "cmsHomeSourceCatalogs"].map(name =>
    db.recursiveDelete(db.collection(name))));
  await db.doc("system/publicDeployment").delete();
  await db.doc("system/cmsPublicationRuntime").delete();
  await db.doc("system/cmsBackgroundAlerts").delete();
  await db.doc("backgroundTestContext/current").set({ digest: digest("frozen public context") });
  await db.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: rendererSha });
  time = start;
  fail = onBuild = onRead = null;
  files = { listings: ["/posts/", "/posts/page/2/"], authors: ["/authors/old-author/", "/authors/new-author/"],
    feed: ["/feeds/news.xml"], contentApi: ["/api/v1/content.json", "/api/v1/content/2.json"],
    sitemap: ["/sitemap-index.xml", "/sitemap-0.xml"],
    search: ["/pagefind/pagefind.js", "/pagefind/fragment/one.pf_fragment", "/search/meaning-index.json"] };
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("Post background publication at the database, artifact and HTTP boundaries", () => {
  it("tracks live-blog update and follow-up profile dependencies within the hydration budget", () => {
    const value = document();
    value.published.metadata.liveBlog = { updates: [{ credits: [{ kind: "registered", authorId: "update-reporter" }],
      followUps: [{ credits: [{ kind: "registered", authorId: "follow-up-reporter" }, { kind: "custom", name: "Custom credit" }] }] }] };
    expect(background.dependency(value).authorIds).toEqual(["author-old", "follow-up-reporter", "update-reporter"]);
  });

  it("excludes private audit-thread identities when a live-blog parent is withdrawn", () => {
    const value = document();
    value.published.metadata.liveBlog = { updates: [{ credits: [{ kind: "registered", authorId: "withdrawn-reporter" }],
      withdrawal: "The report was withdrawn.", followUps: [{ credits: [{ kind: "registered", authorId: "private-audit-reporter" }] }] }] };
    expect(background.dependency(value).authorIds).toEqual(["author-old", "withdrawn-reporter"]);
    expect(value.published.metadata.liveBlog.updates[0].followUps).toHaveLength(1);
  });

  it("bounds live-blog profile dependencies without dropping reporting or failing publication", () => {
    const value = document();
    value.published.authorIds = ["historical-extra"];
    const ids = Array.from({ length: 101 }, (_, index) => `reporter-${String(index).padStart(3, "0")}`);
    value.published.metadata.liveBlog = { updates: ids.map(id => ({ credits: [{ kind: "registered", authorId: id }] })) };
    const selected = background.dependency(value);
    expect(selected.authorIds).toHaveLength(100);
    expect(selected.authorIds).toContain("author-old");
    expect(selected.authorIds).toContain(ids[98]);
    expect(selected.authorIds).not.toContain(ids[99]);
    expect(selected.authorIds).not.toContain("historical-extra");
    expect(value.published.metadata.liveBlog.updates).toHaveLength(101);
  });
  async function delayedAlertFixture() {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    time += 900_000;
    const messages = [], statuses = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      log: { info: (_message, status) => statuses.push(status) },
      send: async message => { messages.push(message); } });
    return { messages, statuses, check };
  }

  it.each(["paused", "starting"])("suppresses delayed alerts during operator admission %s", async phase => {
    const { messages, check } = await delayedAlertFixture();
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused",
      commitSha: rendererSha, serializerId: "node-compute-primary",
      cloud: { phase, commitSha: rendererSha, serializerId: "cloudflare-publisher" } });
    await check();
    time += 60 * 60_000;
    await check();
    expect(messages).toEqual([]);
  });

  it("suppresses delays for five minutes after resume, then alerts a real failure", async () => {
    const { messages, check } = await delayedAlertFixture();
    const runtime = db.doc("system/cmsPublicationRuntime");
    await runtime.set({ schemaVersion: 1, phase: "paused", commitSha: rendererSha, serializerId: "cloudflare-publisher" });
    // The pause can start and end between observer passes. Use the stored resume time.
    const resumed = await runtime.update({ phase: "ready" });
    time = resumed.writeTime.toMillis();
    await check();
    time += 299_999;
    await check();
    expect(messages).toEqual([]);
    time++;
    await check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Public listing output is blocked");
    await check();
    expect(messages).toHaveLength(1);
  });

  it("groups one outage across all six families under concurrent observers", async () => {
    const { messages, check } = await delayedAlertFixture();
    await Promise.all([check(), check()]);
    expect(messages).toHaveLength(1);
    for (const output of outputs) expect(messages[0]).toContain(output);
    await check();
    expect(messages).toHaveLength(1);
  });

  it("logs recovery silently, rearms delivery and escalates a later exhausted replacement", async () => {
    const { messages, statuses, check } = await delayedAlertFixture();
    await check();
    await owner().recover();
    await Promise.all([check(), check()]);
    expect(messages).toHaveLength(1);
    expect(statuses.filter(status => status.recovered)).toHaveLength(1);
    expect((await db.doc("system/cmsBackgroundAlerts").get()).data().sentIdentities).toEqual([]);
    await accept("publish-2", document(2));
    time += 900_000;
    await check();
    expect(messages).toHaveLength(1);
    expect(statuses.at(-1).observations.some(item => item.reason === "rebuild_delayed")).toBe(true);
    await db.doc("cmsPublishQueue/publish-2/backgroundOutputs/listings").update({ status: "failed", attempts: 4,
      nextAttemptAt: null, claim: null });
    await check();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("Automatic listing recovery is exhausted");
    await check();
    expect(messages).toHaveLength(2);
  });

  it("uses cloud readiness even when the retired primary stays paused", async () => {
    const { messages, check } = await delayedAlertFixture();
    const ready = await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused",
      commitSha: rendererSha, serializerId: "node-compute-primary",
      cloud: { phase: "ready", commitSha: rendererSha, serializerId: "cloudflare-publisher" } });
    time = ready.writeTime.toMillis() + 300_000;
    await check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Public listing output is blocked");
  });

  it("keeps safety alerts visible during a planned pause and invalid controls cannot suppress delays", async () => {
    const { messages, check } = await delayedAlertFixture();
    const runtime = db.doc("system/cmsPublicationRuntime");
    await runtime.set({ schemaVersion: 1, phase: "paused", commitSha: rendererSha, serializerId: "cloudflare-publisher" });
    await db.doc("cmsBackgroundOutputs/authors").update({ schemaVersion: 99 });
    await check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("authors: Listing state is unreadable");
    expect(messages[0]).not.toContain("Public listing output is blocked");
    await runtime.update({ schemaVersion: 99 });
    await check();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("Public listing output is blocked");
  });

  it("waits for every family to recover and does not mistake suppression for recovery", async () => {
    const { messages, check } = await delayedAlertFixture();
    await check();
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused",
      commitSha: rendererSha, serializerId: "cloudflare-publisher" });
    await check();
    expect(messages).toHaveLength(1);
    fail = "feed";
    await owner().recover();
    await check();
    expect(messages).toHaveLength(1);
    expect((await db.doc("system/cmsBackgroundAlerts").get()).data().outputs).toContain("feed");
    fail = null;
    time += 60_000;
    await owner().recover();
    await check();
    expect(messages).toHaveLength(1);
    expect((await db.doc("system/cmsBackgroundAlerts").get()).data().outputs).toEqual([]);
  });

  it("does not report recovery when an alerted family record disappears", async () => {
    const { messages, check } = await delayedAlertFixture();
    await check();
    await owner().recover();
    const ref = db.doc("cmsBackgroundOutputs/feed");
    const verified = (await ref.get()).data();
    await ref.delete();
    await check();
    expect(messages).toHaveLength(1);
    expect((await db.doc("system/cmsBackgroundAlerts").get()).data().outputs).toContain("feed");
    await ref.set(verified);
    await check();
    expect(messages).toHaveLength(1);
    expect((await db.doc("system/cmsBackgroundAlerts").get()).data().outputs).toEqual([]);
  });

  it("clears recovery state without invoking the Telegram sender", async () => {
    const { messages, check } = await delayedAlertFixture();
    await check();
    await owner().recover();
    let calls = 0;
    const statuses = [];
    await alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      log: { info: (_message, status) => statuses.push(status) },
      send: async () => { calls++; throw new Error("sender must not run"); } });
    expect(calls).toBe(0);
    expect(messages).toHaveLength(1);
    expect(statuses.some(status => status.recovered)).toBe(true);
    expect((await db.doc("system/cmsBackgroundAlerts").get()).data()).toMatchObject({
      sentIdentities: [], outputs: [], claim: null, nextAttemptAt: null });
  });

  it.each(["pending", "failed"])("keeps %s automatic recovery off Telegram while verified output serves", async status => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    await accept("publish-2", document(2));
    time += 900_000;
    const taskRef = db.doc("cmsPublishQueue/publish-2/backgroundOutputs/listings");
    await taskRef.update({ status, attempts: 4, claim: null,
      nextAttemptAt: status === "failed" ? null : time - 1,
      slowRetryAt: status === "failed" ? time + 600_000 : null,
      lastAttempt: { failureClass: "storage_readback", retryable: true } });
    const messages = [];
    await alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => messages.push(message) });
    expect(messages).toEqual([]);
    expect((await request("/posts/")).status).toBe(200);
    expect((await taskRef.get()).data().attempts).toBe(4);
  });

  it.each(["slow_retry", "expired_claim"])("escalates %s after 15 minutes overdue while verified output still serves", async kind => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    await accept("publish-2", document(2));
    time += 900_000;
    const dueAt = time + 600_000;
    await db.doc("cmsPublishQueue/publish-2/backgroundOutputs/listings").update({ attempts: 4,
      status: kind === "slow_retry" ? "failed" : "pending",
      claim: kind === "slow_retry" ? null : "expired-final-claim",
      nextAttemptAt: kind === "slow_retry" ? null : dueAt,
      slowRetryAt: kind === "slow_retry" ? dueAt : null,
      lastAttempt: { failureClass: "storage_readback", retryable: true } });
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => messages.push(message) });
    await check();
    time = dueAt + 900_000 - 1; await check();
    expect(messages).toEqual([]);
    time++; await check(); await check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Automatic listing recovery is exhausted");
    expect((await request("/posts/")).status).toBe(200);
  });

  it.each(["failed", "expired_claim"])("alerts exhausted Post-selected preparation (%s) while last-good output remains available", async kind => {
    const runtime = { owner: "cloudflare", release: rendererSha };
    const worker = owner({ runtime });
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    const contextDigest = contextRevision.publicContextDigest(1);
    await db.doc("backgroundTestContext/current").set({ digest: contextDigest });
    await accept("publish-1", document(), worker);
    await worker.recover();
    await accept("publish-2", document(2), worker);
    const preparation = db.doc(`cmsPublishQueue/publish-2/backgroundPreparation/${contextDigest}`);
    await preparation.set({ runtime, contextDigest, status: kind === "failed" ? "failed" : "building",
      attempts: 4, nextAttemptAt: time + 60_000, claim: kind === "failed" ? null : "final-preparation-claim" });
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => messages.push(message) });
    await check();
    expect(messages).toEqual([]);
    await preparation.update({ nextAttemptAt: kind === "failed" ? null : time });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused",
      commitSha: rendererSha, serializerId: "cloudflare-publisher" });
    await check();
    await check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Automatic listing recovery is exhausted");
    expect((await task("publish-2", "listings")).attempts).toBe(0);
    expect((await request("/posts/", worker)).status).toBe(200);
  });

  it("commits independent pending outputs with the detail and fences every old aggregate", async () => {
    await db.doc(`cmsPosts/${postId}`).set(document());
    const next = document(2);
    next.published.metadata.slug = "new-story";
    next.published.metadata.previousSlugs = ["old-story"];
    next.published.authorIds = ["author-new"];
    next.published.metadata.credits = [{ kind: "registered", authorId: "author-new", name: "New author" }];
    await accept("publish-2", next);
    for (const output of outputs) {
      const pending = await task("publish-2", output);
      expect(pending).toMatchObject({ status: "pending", attempts: 0, output,
        dependencies: { authorIds: ["author-new", "author-old"], slugs: ["new-story", "old-story"],
          before: { sourceVersion: 1, visible: true }, after: { sourceVersion: 2, visible: true } } });
      expect(JSON.stringify(pending)).not.toContain("Private working title");
      for (const path of files[output]) {
        const response = await request(path);
        expect(response?.status, path).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect((await db.doc("cmsPublishQueue/publish-2").get()).data().status).toBe("success");
    expect((await request("/posts/new-story/"))).toBeNull();
    expect((await request("/"))).toBeNull();
    expect((await request("/guide/pagefind/pagefind.js"))).toBeNull();
  });

  it("verifies immutable bytes and exposes separate results without changing the detail receipt", async () => {
    const worker = owner();
    await accept("publish-1", document(), worker);
    fail = "feed";
    await worker.recover();
    expect(await task("publish-1", "feed")).toMatchObject({ status: "failed", attempts: 1,
      error: "background_generation_failed", nextAttemptAt: start + 60_000 });
    for (const output of outputs.filter(value => value !== "feed")) {
      const verified = await task("publish-1", output);
      expect(verified.status).toBe("verified");
      expect(verified.receipt).toMatchObject({ revision: 1, contextDigest: digest("frozen public context") });
      for (const path of files[output]) {
        const response = await request(path, worker);
        expect(response.status, path).toBe(200);
        expect(await response.text()).toContain("Public story");
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect((await request("/feeds/news.xml", worker)).status).toBe(503);
    expect(JSON.stringify(await task("publish-1", "feed"))).not.toContain("private provider secret");
    expect((await db.doc("cmsPublishQueue/publish-1").get()).data().status).toBe("success");
    fail = null;
    time += 60_000;
    await owner().recover(); // A new process resumes from persisted work.
    expect((await request("/feeds/news.xml")).status).toBe(200);
    expect(await task("publish-1", "feed")).toMatchObject({ status: "verified", attempts: 2, nextAttemptAt: null });
    const head = await request("/feeds/news.xml", worker, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("bounds automatic retries and leaves failed outputs fenced", async () => {
    fail = "search";
    await accept("publish-1", document());
    for (let attempt = 1; attempt <= 4; attempt++) {
      await owner().recover();
      const state = await task("publish-1", "search");
      expect(state).toMatchObject({ status: "failed", attempts: attempt });
      if (attempt < 4) time = state.nextAttemptAt;
    }
    expect((await task("publish-1", "search")).nextAttemptAt).toBeNull();
    time += 86_400_000;
    fail = null;
    await owner().recover();
    expect((await task("publish-1", "search")).attempts).toBe(4);
    expect((await request("/pagefind/fragment/one.pf_fragment")).status).toBe(503);
    expect((await request("/search/meaning-index.json")).status).toBe(503);
    expect((await request("/posts/")).status).toBe(200);
  });

  it("retains last good families through failures and repeated publications without extending their age", async () => {
    await accept("publish-1", document());
    await owner().recover();
    const original = await (await request("/posts/")).text();
    time += 60_000;
    await accept("publish-2", document(2));
    fail = "listings";
    await owner().recover();
    expect(await (await request("/posts/")).text()).toBe(original);
    await accept("publish-3", document(3));
    time = start + 24 * 60 * 60_000 - 1;
    expect((await request("/posts/")).status).toBe(200);
    time++;
    expect((await request("/posts/")).status).toBe(503);
    fail = null;
    await owner().recover();
    expect((await request("/posts/")).status).toBe(200);
  });

  it("does not extend the first withdrawal deadline on republish or another withdrawal", async () => {
    await accept("publish-1", document());
    await owner().recover();
    time += 120_000;
    await accept("withdraw-1", document(2, { publiclyVisible: false }));
    const deadline = time + 60_000;
    await db.doc("backgroundTestContext/current").set({ digest: digest("withdrawal"), withdrawalRevision: 1 });
    time += 30_000;
    await accept("republish", document(3));
    await accept("withdraw-2", document(4, { publiclyVisible: false }));
    expect((await request("/posts/")).status).toBe(200);
    time = deadline;
    expect((await request("/posts/")).status).toBe(503);
  });

  it("serves the replacement when a family verifies during the old artifact read", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await accept("publish-2", document(2));
    onRead = async () => { onRead = null; await owner().recover(); };
    const response = await request("/posts/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("revision 2");
  });

  it("does not return an artifact whose stale deadline passed during its read", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await accept("withdraw-1", document(2, { publiclyVisible: false }));
    onRead = async () => { onRead = null; time += 60_000; };
    expect((await request("/posts/")).status).toBe(503);
  });

  it("logs delayed work and alerts withdrawal expiry at the next minute check", async () => {
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => { messages.push(message); } });
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    await check();
    expect(messages).toEqual([]);
    await accept("publish-2", document(2));
    time += 899_999;
    await check();
    expect(messages).toEqual([]);
    time++;
    await Promise.all([check(), check()]);
    expect(messages).toHaveLength(0);
    await check();
    expect(messages).toHaveLength(0);
    await owner().recover();
    await accept("withdraw-1", document(3, { publiclyVisible: false }));
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).update({ withdrawalRevision: 1 });
    time += 59_999;
    await check();
    expect(messages).toHaveLength(0);
    time++;
    await check();
    expect(messages).toHaveLength(1);
    expect(messages.every(message => message.includes("Withdrawal stale limit"))).toBe(true);
  });

  it("alerts when the age limit blocks previously delayed output", async () => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    await accept("publish-2", document(2));
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => { messages.push(message); } });
    time += 900_000;
    await check();
    expect(messages).toHaveLength(0);
    expect((await request("/posts/")).status).toBe(200);
    time = start + 24 * 60 * 60_000;
    expect((await request("/posts/")).status).toBe(503);
    await check();
    await check();
    expect(messages).toHaveLength(1);
    expect(messages.every(message => message.includes("24-hour stale limit reached"))).toBe(true);
  });

  it("keeps the first delayed-context alert time when preparation never starts", async () => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => { messages.push(message); } });
    time += 1_000;
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).update({ revision: 2, changedAt: new Date(time) });
    await check();
    time += 900_000;
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).update({ revision: 3, changedAt: new Date(time) });
    await check();
    expect(messages).toHaveLength(0);
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data().pendingSince).toBe(start + 1_000);
  });

  it("does not restore stale output after another Post was withdrawn before the pilot", async () => {
    await accept("publish-1", document());
    await owner().recover();
    time += 120_000;
    await db.doc("backgroundTestContext/current").set({ digest: digest("other withdrawal"), withdrawalRevision: 1 });
    expect((await request("/posts/")).status).toBe(503);
    await accept("withdraw-pilot", document(2, { publiclyVisible: false }));
    expect((await request("/posts/")).status).toBe(503);
  });

  it.each([null, { schemaVersion: 99, revision: 1 }, { schemaVersion: 1, revision: 0 }])(
    "alerts active families when public context is missing or unreadable: %j", async context => {
      await accept("publish-1", document());
      await owner().recover();
      const ref = db.doc(contextRevision.PUBLIC_CONTEXT_PATH);
      if (context) await ref.set(context);
      else await ref.delete();
      const messages = [];
      const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
        send: async message => { messages.push(message); } });
      await check();
      expect(messages).toHaveLength(1);
      expect(messages.every(message => message.includes("state is unreadable"))).toBe(true);
      await check();
      expect(messages).toHaveLength(1);
      for (const output of outputs) {
        expect((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data().pendingSince).toBe(start);
      }
    });

  it.each(["revision", "contextDigest"])("does not promote a verified receipt with a mismatched %s", async field => {
    await accept("publish-1", document());
    await owner().recover();
    const ref = db.doc("cmsBackgroundOutputs/listings");
    const verified = (await ref.get()).data();
    await ref.update({ lastGood: null,
      [`receipt.${field}`]: field === "revision" ? verified.revision + 1 : digest("another context") });
    expect((await request("/posts/")).status).toBe(503);
    await accept("publish-2", document(2));
    expect((await ref.get()).data().lastGood).toBeNull();
    expect((await request("/posts/")).status).toBe(503);
  });

  // #3096 option 1: October 10's release gap must serve last-good output.
  // ADR 0023 and #3057 comment 6102461430 retain the first 60s removal deadline.
  it("serves a prior release silently and alerts only when its safety contract blocks output", async () => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    const originals = new Map();
    for (const path of Object.values(files).flat()) originals.set(path, await (await request(path)).text());
    const family = db.doc("cmsBackgroundOutputs/listings");
    const nextRelease = "b".repeat(40);
    await db.doc("system/publicDeployment").update({ activeCommitSha: nextRelease });
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
    await db.doc("backgroundTestContext/current").set({ rendererSha: nextRelease, digest: contextRevision.publicContextDigest(2) });
    // A fresh reader instance receives persisted receipts minted by the old code.
    const reader = owner({ accepting: false, readContextInTransaction: transaction =>
      contextRevision.readPublicBackgroundContextInTransaction(transaction, db) });
    for (const [path, bytes] of originals) {
      const response = await request(path, reader);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(bytes);
      expect(response.headers.get("x-njpbs-background-renderer-sha")).toBe(rendererSha);
      expect(response.headers.get("x-njpbs-background-state")).toBe("stale");
      expect((await request(path, reader, "HEAD")).status, path).toBe(200);
    }
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => { messages.push(message); } });
    await check();
    await check();
    expect(messages).toEqual([]);
    time += 33 * 60_000;
    for (const [path, bytes] of originals) expect(await (await request(path, reader)).text(), path).toBe(bytes);
    await check();
    expect(messages).toEqual([]);
    fail = "listings";
    await owner().recover();
    expect(await (await request("/posts/", reader)).text()).toBe(originals.get("/posts/"));
    fail = null;
    time += 60_000;
    await owner().recover();
    const response = await request("/posts/", reader);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-njpbs-background-renderer-sha")).toBe(nextRelease);
    expect(response.headers.get("x-njpbs-background-state")).toBe("current");
    expect((await family.get()).data().receipt.rendererSha).toBe(nextRelease);
    time += 15_000;
    await family.update({ "receipt.rendererSha": null, lastGood: null });
    expect((await request("/posts/", reader)).status).toBe(503);
    await check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("old output is blocked");
    await owner().recover();
    expect((await request("/posts/", reader)).status).toBe(200);
  });

  it.each(["before", "during"])("enforces withdrawal %s release regeneration at 60 seconds and alerts", async when => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, withdrawalRevision: 0 });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    const nextRelease = "b".repeat(40);
    const release = async () => {
      await db.doc("system/publicDeployment").update({ activeCommitSha: nextRelease });
      await db.doc("backgroundTestContext/current").update({ rendererSha: nextRelease });
    };
    time += 33 * 60_000;
    if (when === "during") {
      await release();
      fail = "listings";
      await owner().recover();
    }
    await accept("withdraw-1", document(2, { publiclyVisible: false }));
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).update({ withdrawalRevision: 1 });
    const deadline = time + 60_000;
    if (when === "before") await release();
    const reader = owner({ accepting: false, readContextInTransaction: transaction =>
      contextRevision.readPublicBackgroundContextInTransaction(transaction, db) });
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => { messages.push(message); } });
    await check();
    time = deadline - 1;
    for (const path of Object.values(files).flat()) expect((await request(path, reader)).status, path).toBe(200);
    // A second code release must not renew the withdrawal budget either.
    await db.doc("system/publicDeployment").update({ activeCommitSha: "c".repeat(40) });
    time = deadline;
    for (const path of Object.values(files).flat()) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(path, reader, method);
        expect(response.status, path).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    await check();
    expect(messages.filter(message => message.includes("Withdrawal stale limit"))).toHaveLength(1);
  });

  it("refuses legacy receipts across releases until an asset-bearing replacement verifies", async () => {
    await accept("publish-1", document());
    await owner().recover();
    for (const output of outputs) {
      const ref = db.doc(`cmsBackgroundOutputs/${output}`);
      const state = (await ref.get()).data();
      delete state.receipt.assets;
      delete state.lastGood.receipt.assets;
      await ref.set(state);
    }
    expect((await request("/posts/")).status).toBe(200);
    await db.doc("backgroundTestContext/current").update({ rendererSha: "b".repeat(40) });
    for (const path of Object.values(files).flat()) expect((await request(path)).status).toBe(503);
    await owner().recover();
    expect((await request("/posts/")).status).toBe(200);
  });

  it("retains verified asset bytes across a release and expires the single predecessor graph after handoff", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await db.doc("backgroundTestContext/current").update({ rendererSha: "b".repeat(40) });
    const assetPath = "/_astro/old.abc123.css";
    const asset = await request(assetPath);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("body { color: red; }");
    expect(asset.headers.get("content-type")).toBe("text/css");
    expect(await (await request(assetPath, owner(), "HEAD")).text()).toBe("");
    expect((await request("/_astro/unrecorded.css")).status).toBe(404);
    const worker = owner();
    const buildOwner = owner({ build: async task => ({
      input: { kind: "public-background", rendererSha: "b".repeat(40), contextDigest: digest("frozen public context"),
        routes: [{ path: "/posts/old-story/", sourceVersion: 1, digest: task.dependencies.after.digest }] },
      files: files[task.output].map(path => ({ path, contentType: "text/plain", bytes: "replacement" })),
      assets: [{ path: "/_astro/new.def456.css", contentType: "text/css", bytes: "body { color: blue; }" }],
    }) });
    await buildOwner.recover();
    expect(await (await request(assetPath, worker)).text()).toBe("body { color: red; }");
    // Another publication must neither discard nor renew the first graph's grace.
    time += 5_000;
    await accept("publish-during-grace", document(2));
    await buildOwner.recover();
    expect(await (await request(assetPath, worker)).text()).toBe("body { color: red; }");
    time += 10_000;
    expect((await request(assetPath, worker)).status).toBe(404);
    expect(await (await request("/_astro/new.def456.css", worker)).text()).toBe("body { color: blue; }");
  });

  it("rejects corrupt retained assets and withdrawals that expire during asset reads", async () => {
    await accept("publish-1", document());
    await owner().recover();
    const assetPath = "/_astro/old.abc123.css";
    for (const output of outputs) {
      const state = (await db.doc(`cmsBackgroundOutputs/${output}`).get()).data();
      const retained = state.receipt.fileManifest
        ? JSON.parse(await readFile(join(directory, state.receipt.fileManifest.key), "utf8")) : state.receipt.assets;
      const asset = retained.find(file => file.path === assetPath);
      expect(asset).toBeDefined();
      await writeFile(join(directory, asset.key), "corrupt");
    }
    expect((await request(assetPath)).status).toBe(503);
    await db.doc("backgroundTestContext/current").update({ rendererSha: "b".repeat(40) });
    await owner().recover();
    await accept("withdraw-1", document(2, { publiclyVisible: false }));
    onRead = async () => { onRead = null; time += 60_000; };
    expect((await request(assetPath)).status).toBe(503);
  });

  it("keeps the removal counter and stale age bounds across releases", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await db.doc("backgroundTestContext/current").update({ rendererSha: "b".repeat(40) });
    time = start + 24 * 60 * 60_000 - 1;
    expect((await request("/posts/")).status).toBe(200);
    time++;
    expect((await request("/posts/")).status).toBe(503);
    // Another Post, author or media removal uses the shared safety marker.
    time = start + 59_999;
    await db.doc("backgroundTestContext/current").update({ withdrawalRevision: 1 });
    expect((await request("/posts/")).status).toBe(200);
    time++;
    expect((await request("/posts/")).status).toBe(503);
  });

  it("alerts unreadable state without blocking delayed alerts for other families", async () => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await accept("publish-1", document());
    await db.doc("cmsBackgroundOutputs/authors").update({ schemaVersion: 99 });
    time += 900_000;
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => { messages.push(message); } });
    await check();
    expect(messages).toHaveLength(1);
    expect(messages.find(message => message.includes("authors:"))).toContain("state is unreadable");
    expect((await db.doc("cmsBackgroundOutputs/authors").get()).data().schemaVersion).toBe(99);
    await check();
    expect(messages).toHaveLength(1);
    await db.doc(`cmsPosts/${postId}`).update({ "published.metadata.previousSlugs": { invalid: true } });
    await check();
    expect(messages).toHaveLength(2);
    expect(messages.slice(1).every(message => message.includes("state is unreadable"))).toBe(true);
  });

  it("alerts each unreadable outage after a verified family recovers", async () => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await db.doc("backgroundTestContext/current").set({ digest: contextRevision.publicContextDigest(1) });
    await accept("publish-1", document());
    await owner().recover();
    const messages = [];
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      send: async message => { messages.push(message); } });
    const family = db.doc("cmsBackgroundOutputs/authors");
    await family.update({ schemaVersion: 99 });
    await check();
    await check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("authors: Listing state is unreadable");
    await family.update({ schemaVersion: 1 });
    await check();
    expect(messages).toHaveLength(1);
    expect((await db.doc("system/cmsBackgroundAlerts").get()).data().outputs).toEqual([]);
    time += 60_000;
    await family.update({ schemaVersion: 99 });
    await check();
    await check();
    expect(messages).toHaveLength(2);
  });

  it("logs only a fixed alert delivery failure and retries after its lease", async () => {
    await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, changedAt: new Date(time) });
    await accept("publish-1", document());
    time += 900_000;
    const logs = [];
    let calls = 0;
    const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time,
      log: { error: (...args) => logs.push(args) },
      send: async () => { calls++; throw new Error("private provider credentials"); } });
    await check();
    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("private provider credentials");
    expect(logs[0][0]).toBe("Post background alert delivery failed");
    await check();
    expect(calls).toBe(1);
    time += 300_000;
    await check();
    expect(calls).toBe(2);
  });

  it("makes an aborted acceptance leave neither detail nor follow-ups", async () => {
    await expect(accept("aborted", document(), owner(), { abort: true })).rejects.toThrow("abort publication");
    expect((await db.doc(`cmsPosts/${postId}`).get()).exists).toBe(false);
    expect((await db.doc("cmsPublishQueue/aborted").get()).exists).toBe(false);
    expect((await db.collection("cmsBackgroundOutputs").get()).empty).toBe(true);
    expect((await db.collection("cmsPublishQueue/aborted/backgroundOutputs").get()).empty).toBe(true);
  });

  it("supersedes exhausted families after a public-context change without resetting the accepted operation", async () => {
    await accept("publish-1", document());
    const broken = owner({ build: async () => { throw new Error("Storage unavailable"); } });
    for (let attempt = 1; attempt <= 4; attempt++) {
      await broken.recover();
      if (attempt < 4) time = (await task("publish-1", "listings")).nextAttemptAt;
    }
    for (const output of outputs) {
      expect(await task("publish-1", output)).toMatchObject({ status: "failed", attempts: 4, nextAttemptAt: null });
    }
    const accepted = (await db.doc("cmsPublishQueue/publish-1").get()).data();
    // Successful code activation advances this shared context through its owner.
    await db.doc("backgroundTestContext/current").set({ digest: digest("repaired public source") });
    await owner().recover();
    for (const output of outputs) {
      expect(await task("publish-1", output)).toMatchObject({ status: "superseded", attempts: 4, nextAttemptAt: null });
      expect(await task("publish-1", `${output}-2`)).toMatchObject({ status: "verified", attempts: 1,
        revision: 2, receipt: { contextDigest: digest("repaired public source") } });
      expect((await request(files[output][0])).status).toBe(200);
    }
    expect((await db.doc("cmsPublishQueue/publish-1").get()).data()).toEqual(accepted);
  });

  it("keeps defaults inert, requires the Post allowlist and refuses unsupported Home paths", async () => {
    const disabled = owner({ enabled: false });
    await accept("disabled", document(), disabled);
    await disabled.recover();
    expect((await db.collection("cmsBackgroundOutputs").get()).empty).toBe(true);
    expect(await request("/posts/", disabled)).toBeNull();
    await accept("outside-allowlist", document(2), owner({ postIds: ["different-post"] }));
    expect((await db.collection("cmsBackgroundOutputs").get()).empty).toBe(true);
    await expect(db.runTransaction(transaction => owner().prepareInTransaction({ transaction,
      queueId: "home", postId, nextDocument: document(3), homePlacementPaths: ["/private/"] }))).rejects.toThrow("contract refused");
    expect((await db.collection("cmsBackgroundOutputs").get()).empty).toBe(true);
  });

  it("activates immutable Home with the publication families and preserves removal and generation fences", async () => {
    files.home = ["/", "/_home-sources.json"];
    expect(await request("/")).toBeNull();
    await accept("placed", document(), owner(), { homePlacementPaths: ["/"] });
    expect((await task("placed", "home")).dependencies.homePlacementPaths).toEqual(["/"]);
    await owner().recover();
    const home = await request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toBe("home revision 1: Public story");
    expect(home.headers.get("x-njpbs-background-renderer-sha")).toBe(rendererSha);
    const snapshot = await (await request("/_home-sources.json")).json();
    expect((await db.doc(`cmsHomeSourceCatalogs/${snapshot.editorial.receipt.buildBatchId}`).get()).data()).toEqual(snapshot.editorial);
    expect((await db.doc("cmsBackgroundOutputs/home").get()).data().receipt.homeSourceReceipt).toEqual(snapshot.editorial.receipt);
    expect((await db.doc("cmsBackgroundOutputs/home").get()).data().receipt.contextDigest)
      .toBe((await db.doc("cmsBackgroundOutputs/listings").get()).data().receipt.contextDigest);
    const pulled = document(2, { publiclyVisible: false });
    await accept("pulled", pulled, owner(), { homePlacementPaths: ["/"] });
    fail = "home";
    await owner().recover();
    expect((await db.doc("cmsHomeSourceCatalogs/home-2").get()).exists).toBe(false);
    expect(await (await request("/_home-sources.json")).json()).toEqual(snapshot);
    expect(await (await request("/")).text()).toBe("home revision 1: Public story");
    time += 60_000;
    expect((await request("/")).status).toBe(503);
    fail = null;
    await owner().recover();
    expect(await (await request("/")).text()).toBe("home revision 2: Removed");
    // A later publication must keep a previously activated Home current even
    // after Home removes this Post selection entirely.
    await accept("unplaced", document(3));
    expect(await task("unplaced", "home")).toBeDefined();
  });

  it("yields old Home to Assets after a normal Home publication until a matching generation verifies", async () => {
    files.home = ["/", "/_home-sources.json"];
    await accept("placed", document(), owner(), { homePlacementPaths: ["/"] });
    await owner().recover();
    expect((await request("/")).status).toBe(200);
    await db.doc("backgroundTestContext/current").update({ digest: digest("normal Home publication"), homeRevision: 1 });
    // The private reader rejects both old HTML and catalog; Home's Worker then
    // uses Assets, which contains the completed normal Home publication.
    expect((await request("/")).status).toBe(503);
    expect((await request("/_home-sources.json")).status).toBe(503);
    fail = "home";
    await owner().recover();
    expect((await request("/")).status).toBe(503);
    fail = null;
    time += 60_000;
    await owner().recover();
    expect((await request("/")).status).toBe(200);
    expect((await db.doc("cmsBackgroundOutputs/home").get()).data().receipt.homeRevision).toBe(1);
  });

  it("refuses Home activation without its matching catalog while other families verify", async () => {
    files.home = ["/"];
    await accept("missing-home-catalog", document(), owner(), { homePlacementPaths: ["/"] });
    await owner().recover();
    expect(await task("missing-home-catalog", "home")).toMatchObject({ status: "failed", receipt: null,
      error: "background_generation_failed" });
    expect((await db.collection("cmsHomeSourceCatalogs").get()).size).toBe(0);
    expect((await task("missing-home-catalog", "listings")).status).toBe("verified");
  });

  it("queues content APIs only when enabled", async () => {
    const worker = owner({ contentApiEnabled: false });
    await accept("publish-1", document(), worker);
    expect(await task("publish-1", "contentApi")).toBeUndefined();
    expect(await request("/api/v1/content.json", worker)).toBeNull();
    expect((await request("/feeds/news.xml", worker)).status).toBe(503);
  });

  it("keeps exact retry identity without replaying an older publication over current output", async () => {
    await accept("publish-1", document());
    await owner().recover();
    const before = await task("publish-1", "listings");
    // Retry the prepared queue identity only. The publication owner separately
    // retains its exact acceptance receipt instead of rewriting the old detail.
    await db.runTransaction(async transaction => {
      const write = await owner().prepareInTransaction({ transaction, queueId: "publish-1", postId,
        nextDocument: document(), homePlacementPaths: [] });
      write();
    });
    expect(await task("publish-1", "listings")).toEqual(before);
    await expect(db.runTransaction(transaction => owner().prepareInTransaction({ transaction,
      queueId: "publish-1", postId, nextDocument: document(2), homePlacementPaths: [] }))).rejects.toThrow("contract refused");
    expect((await request("/posts/")).status).toBe(200);
  });

  it("ignores ordinary working-copy edits and records changed dates, taxonomy and media", async () => {
    await accept("publish-1", document());
    await owner().recover();
    const draft = document(2, { published: document().published, title: "A different private draft" });
    await accept("draft-only", draft);
    expect(await task("draft-only", "listings")).toBeUndefined();
    expect((await request("/posts/")).status).toBe(200);
    const next = document(3);
    next.published.metadata.date = "2026-10-09";
    next.published.metadata.categories = ["Politics"];
    next.published.metadata.heroImage = "asset-new";
    await accept("publish-3", next);
    const queued = await task("publish-3", "listings");
    expect(queued.dependencies.after.dates.date).toBe("2026-10-09");
    expect(queued.dependencies.before.taxonomyDigest).not.toBe(queued.dependencies.after.taxonomyDigest);
    expect(queued.dependencies.mediaIds).toContain("asset-new");
    expect((await request("/posts/")).status).toBe(200);
  });

  it("bounds stale withdrawal with admission disabled, then removes old pages", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await accept("withdraw-1", document(2, { publiclyVisible: false }));
    for (const path of Object.values(files).flat()) expect((await request(path, owner({ enabled: false }))).status, path).toBe(200);
    time += 60_000;
    for (const path of Object.values(files).flat()) expect((await request(path, owner({ enabled: false }))).status, path).toBe(503);
    files.listings = ["/posts/"];
    files.authors = ["/authors/new-author/"];
    files.contentApi = ["/api/v1/content.json"];
    await owner().recover();
    for (const path of ["/posts/page/2/", "/authors/old-author/", "/api/v1/content/2.json"]) {
      expect((await request(path)).status, path).toBe(404);
    }
    for (const path of ["/posts/", "/feeds/news.xml", "/search/meaning-index.json"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Removed");
    }
  });

  it("uses the withdrawal deadline when withdrawal commits during an artifact read", async () => {
    await accept("publish-1", document());
    await owner().recover();
    onRead = async () => {
      onRead = null;
      await accept("withdraw-1", document(2, { publiclyVisible: false }));
    };
    const response = await request("/feeds/news.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-njpbs-background-expires-at")).toBe(String(start + 60_000));
    time += 60_000;
    expect((await request("/feeds/news.xml")).status).toBe(503);
  });

  it("requires a new generation even when republication reuses identical public bytes", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await accept("withdraw-1", document(1, { publiclyVisible: false }));
    await owner().recover();
    await accept("republish-1", document());
    expect((await request("/posts/")).status).toBe(200);
    await owner().recover();
    expect(await task("republish-1", "listings")).toMatchObject({ status: "verified", revision: 3 });
    expect(await (await request("/posts/")).text()).toContain("revision 3: Public story");
  });

  it("does not let delayed generation completion clear a newer withdrawal fence", async () => {
    await accept("publish-1", document());
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    onBuild = async task => {
      if (task.output === "listings") { onBuild = null; entered(); await gate; }
    };
    const first = owner().recover();
    await waiting;
    await accept("withdraw-1", document(2, { publiclyVisible: false }));
    await owner().recover();
    release();
    await first;
    expect(await task("publish-1", "listings")).toMatchObject({ status: "superseded" });
    expect(await task("withdraw-1", "listings")).toMatchObject({ status: "verified", revision: 2 });
    expect(await (await request("/posts/")).text()).toContain("Removed");
  });

  it("recovers a crashed lease and rejects a late worker using that expired claim", async () => {
    await accept("publish-1", document());
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    onBuild = async task => {
      if (task.output === "listings") { onBuild = null; entered(); await gate; }
    };
    const first = owner().recover();
    await waiting;
    time += 60_001;
    await owner().recover();
    const recovered = await task("publish-1", "listings");
    expect(recovered).toMatchObject({ status: "verified", attempts: 2 });
    release();
    await first;
    expect(await task("publish-1", "listings")).toEqual(recovered);
    expect((await request("/posts/")).status).toBe(200);
  });

  it("fails closed for corrupt immutable artifacts and current-source drift", async () => {
    await accept("publish-1", document());
    await owner().recover();
    const verified = await task("publish-1", "feed");
    await writeFile(join(directory, verified.receipt.manifest[0].key), "wrong bytes");
    expect((await request("/feeds/news.xml")).status).toBe(503);
    await db.doc(`cmsPosts/${postId}`).update({ publiclyVisible: false });
    time += 60_000;
    expect((await request("/posts/")).status).toBe(503);
    expect((await request("/pagefind/pagefind.js")).status).toBe(503);
  });

  it("cannot serve a source version older than the recorded public version", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await db.doc(`cmsPosts/${postId}`).update({ version: 2, publicSourceVersion: 2 });
    expect((await request("/posts/")).status).toBe(503);
    expect((await request("/search/meaning-index.json")).status).toBe(503);
  });

  it("requires paired Pagefind and meaning outputs from one public input", async () => {
    files.search = ["/pagefind/pagefind.js"];
    await accept("publish-1", document());
    await owner().recover();
    expect(await task("publish-1", "search")).toMatchObject({ status: "failed", receipt: null });
    expect((await request("/pagefind/pagefind.js")).status).toBe(503);
    expect((await request("/search/meaning-index.json")).status).toBe(503);
    expect((await request("/posts/")).status).toBe(200);
  });

  it("keeps path aliases and request variants behind the same withdrawal fence", async () => {
    await accept("publish-1", document());
    await owner().recover();
    expect((await request("/posts/index.html")).status).toBe(200);
    expect((await request("/posts")).status).toBe(200);
    await accept("withdraw-1", document(2, { publiclyVisible: false }));
    time += 60_000;
    for (const path of ["/posts", "/posts/index.html", "/p%6fsts/", "/p%2525256fsts/",
      "/p%25252525252525252525256fsts/", `/p%${"25".repeat(40)}6fsts/`,
      "/posts%252f", "/posts/?page=2", "/authors/old-author/index.html",
      "/p%256fsts/page/%zz", "/au%2574hors/name%zz"]) {
      const response = await request(path);
      expect(response.status, path).toBe(503);
      expect(await response.text()).not.toContain("Public story");
    }
    expect((await request("/posts/", owner(), "HEAD")).status).toBe(503);
    expect((await request("/posts/", owner(), "POST")).status).toBe(405);
  });

  it("returns unavailable when the authoritative database cannot be read", async () => {
    const worker = owner({ firestore: { async runTransaction() { throw new Error("database unavailable"); } } });
    const response = await request("/posts/", worker);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not verify a generation whose stored bytes differ from the built bytes", async () => {
    await accept("publish-1", document());
    await owner({ artifacts: { ...artifacts, async get(key) {
      return key.includes("/feed/") ? Buffer.from("wrong stored bytes") : artifacts.get(key);
    } } }).recover();
    expect(await task("publish-1", "feed")).toMatchObject({ status: "failed", receipt: null });
    expect((await request("/feeds/news.xml")).status).toBe(503);
    expect((await request("/posts/")).status).toBe(200);
  });

  it("allows only one active claim for each output across recovery processes", async () => {
    await accept("publish-1", document());
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    onBuild = async task => {
      if (task.output === "listings") { onBuild = null; entered(); await gate; }
    };
    const first = owner().recover();
    await waiting;
    await owner().recover();
    expect(await task("publish-1", "listings")).toMatchObject({ status: "pending", attempts: 1 });
    expect((await request("/posts/")).status).toBe(503);
    expect((await request("/feeds/news.xml")).status).toBe(200);
    release();
    await first;
    for (const output of outputs) expect(await task("publish-1", output)).toMatchObject({ status: "verified", attempts: 1 });
  });

  it.each(["private-preview", "old-version", "retired-slug", "home-file"])("refuses %s output without affecting detail acceptance", async kind => {
    await accept("publish-1", document());
    const worker = owner({ async build() {
      return { input: { kind: kind === "private-preview" ? "private-preview" : "public-background",
        rendererSha, contextDigest: digest("context"), routes: [{ path: kind === "retired-slug" ? "/posts/retired/" : "/posts/old-story/",
          sourceVersion: kind === "old-version" ? 99 : 1, digest: (await task("publish-1", "listings")).dependencies.after.digest }] },
        files: [{ path: kind === "home-file" ? "/" : "/posts/", contentType: "text/html", bytes: "unsafe generation" }] };
    } });
    await worker.recover();
    expect((await request("/posts/")).status).toBe(503);
    expect((await db.doc("cmsPublishQueue/publish-1").get()).data().status).toBe("success");
  });

  it("fences and regenerates shared outputs when another Post changes the public context", async () => {
    await accept("publish-1", document());
    await owner().recover();
    const batch = db.batch();
    const other = document();
    other.published.metadata.title = "Another public story";
    other.published.metadata.slug = "other-story";
    batch.set(db.doc("cmsPosts/other-post"), other);
    batch.set(db.doc("backgroundTestContext/current"), { digest: digest("new complete public context") });
    await batch.commit();
    for (const path of ["/posts/", "/feeds/news.xml", "/search/meaning-index.json"]) expect((await request(path)).status).toBe(200);
    await owner().recover();
    const state = (await db.doc("cmsBackgroundOutputs/listings").get()).data();
    expect(state.status).toBe("verified");
    expect(state.receipt.contextDigest).toBe(digest("new complete public context"));
    expect(await (await request("/posts/")).text()).toContain("Another public story");
    expect((await task("publish-1", "listings")).status).toBe("verified"); // Original receipt retained.
    const withdrawal = db.batch();
    withdrawal.update(db.doc("cmsPosts/other-post"), { publiclyVisible: false });
    withdrawal.set(db.doc("backgroundTestContext/current"), { digest: digest("other Post withdrawn"), withdrawalRevision: 1 });
    await withdrawal.commit();
    time += 60_000;
    expect((await request("/search/meaning-index.json")).status).toBe(503);
    await owner().recover();
    expect(await (await request("/search/meaning-index.json")).text()).not.toContain("Another public story");
  });

  it("keeps a verified response when public context changes during its artifact read", async () => {
    await accept("publish-1", document());
    await owner().recover();
    onRead = async () => {
      onRead = null;
      await db.doc("backgroundTestContext/current").set({ digest: digest("withdrawn different Post") });
    };
    expect((await request("/feeds/news.xml")).status).toBe(200);
  });

  it("does not activate bytes when the public context changes during staging", async () => {
    await accept("publish-1", document());
    onRead = async () => {
      onRead = null;
      await db.doc("backgroundTestContext/current").set({ digest: digest("context changed during staging") });
    };
    await owner().recover();
    expect(await task("publish-1", "listings")).toMatchObject({ status: "failed", receipt: null });
    expect((await request("/posts/")).status).toBe(503);
    await owner().recover();
    expect((await request("/posts/")).status).toBe(200);
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data().receipt.contextDigest).toBe(digest("context changed during staging"));
  });

  it("leaves static output alone until the first atomic admission", async () => {
    expect(await request("/posts/")).toBeNull();
    expect(await request("/feeds/news.xml")).toBeNull();
    await accept("publish-1", document());
    expect((await request("/posts/")).status).toBe(503);
  });

  it("can pause admission while the sole recovery owner keeps existing families current", async () => {
    await accept("publish-1", document());
    await owner().recover();
    const paused = owner({ accepting: false });
    await accept("publish-2", document(2), paused);
    expect(await task("publish-2", "listings")).toBeUndefined();
    expect((await request("/posts/", paused)).status).toBe(200);
    await paused.recover();
    expect((await request("/posts/", paused)).status).toBe(200);
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data().after.sourceVersion).toBe(2);
  });

  it("keeps legacy published records visible under the existing publisher contract", async () => {
    const legacy = document();
    delete legacy.publiclyVisible;
    legacy.status = "published";
    await accept("publish-1", legacy);
    await owner().recover();
    expect((await request("/posts/")).status).toBe(200);
    expect(await (await request("/posts/")).text()).toContain("Public story");
  });

  it("leaves malformed and percent-encoded unrelated paths to their existing owner", async () => {
    for (const path of ["/about/%zz", "/about/100%25", "/guide/%25", "/not-owned/%252f",
      "/not-owned/%25252525252525252525256f"]) {
      expect(await request(path), path).toBeNull();
    }
  });

  it("refuses paths whose ownership remains ambiguous after bounded decoding", async () => {
    const response = await request(`/not-owned/%${"25".repeat(40)}6f`, owner({ enabled: false }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an unknown background state schema", async () => {
    await accept("publish-1", document());
    await owner().recover();
    await db.doc("cmsBackgroundOutputs/listings").update({ schemaVersion: 2 });
    expect((await request("/posts/")).status).toBe(503);
    await expect(accept("publish-2", document(2))).rejects.toThrow("contract refused");
    expect((await db.doc(`cmsPosts/${postId}`).get()).data().published.sourceVersion).toBe(1);
  });

  it.each(["unknown-schema", "missing-task", "malformed-snapshot", "missing-task-path", "malformed-task-path"])("allows withdrawal despite %s background preparation failure", async kind => {
    await accept("publish-1", document());
    await owner().recover();
    if (kind === "unknown-schema") await db.doc("cmsBackgroundOutputs/listings").update({ schemaVersion: 2 });
    if (kind === "missing-task") await db.doc("cmsPublishQueue/publish-1/backgroundOutputs/listings").delete();
    if (kind.endsWith("task-path")) await db.doc("cmsBackgroundOutputs/listings").update({
      taskPath: kind === "missing-task-path" ? null : "cmsPublishQueue" });
    const withdrawn = document(2, { publiclyVisible: false });
    if (kind === "malformed-snapshot") withdrawn.published.metadata.previousSlugs = { invalid: true };
    await accept("withdraw-1", withdrawn);
    expect((await db.doc(`cmsPosts/${postId}`).get()).data().publiclyVisible).toBe(false);
    expect((await db.doc("cmsPublishQueue/withdraw-1").get()).data().status).toBe("success");
    expect((await db.doc("cmsPublishQueue/withdraw-1/backgroundOutputs/_admission").get()).data()).toMatchObject({
      stage: "preparation", status: "failed", error: "background_preparation_failed" });
    time += 60_000;
    for (const path of Object.values(files).flat()) expect((await request(path)).status, path).toBe(503);
    if (kind === "unknown-schema") expect((await db.doc("cmsBackgroundOutputs/listings").get()).data().schemaVersion).toBe(2);
  });

  it.each(["legacy-status", "null-visibility", "legacy-deleted"])("preserves %s withdrawal despite obsolete background metadata", async kind => {
    await accept("publish-1", document());
    await owner().recover();
    await db.doc("cmsBackgroundOutputs/listings").update({ schemaVersion: 2 });
    const withdrawn = document(2);
    if (kind === "legacy-status") { delete withdrawn.publiclyVisible; withdrawn.status = "draft"; }
    if (kind === "null-visibility") withdrawn.publiclyVisible = null;
    if (kind === "legacy-deleted") withdrawn.deleted = 1;
    await accept("withdraw-1", withdrawn);
    expect((await db.doc(`cmsPosts/${postId}`).get()).data()).toEqual(withdrawn);
    expect((await db.doc("cmsPublishQueue/withdraw-1").get()).data().status).toBe("success");
    expect((await db.doc("cmsPublishQueue/withdraw-1/backgroundOutputs/_admission").get()).data().status).toBe("failed");
    time += 60_000;
    for (const path of Object.values(files).flat()) expect((await request(path)).status, path).toBe(503);
  });
});


describe("background runtime ownership", () => {
  const cloud = { owner: "cloudflare", release: "a".repeat(40) };
  const office = { owner: "node-compute", release: "a".repeat(40) };
  it("does not let cloud claim legacy families or OFJ claim cloud families", async () => {
    await accept("legacy", document());
    await owner({ runtime: cloud }).recover();
    expect(await task("legacy", "listings")).toMatchObject({ attempts: 0, status: "pending" });
    await accept("cloud", document(2), owner({ runtime: cloud }));
    await owner({ runtime: office }).recover();
    await owner({ runtime: { ...cloud, release: "b".repeat(40) } }).recover();
    expect(await task("cloud", "listings")).toMatchObject({ runtime: cloud, attempts: 0, status: "pending" });
    await owner({ runtime: cloud }).recover();
    expect(await task("cloud", "listings")).toMatchObject({ runtime: cloud, attempts: 1, status: "verified", receipt: { runtime: cloud } });
  });
  it("coalesces duplicate recovery and refuses a late result after ownership changes", async () => {
    await accept("cloud", document(), owner({ runtime: cloud }));
    let started;
    let complete;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { complete = resolve; });
    onBuild = async task => { if (task.output === "listings") { started(); await gate; } };
    const first = owner({ runtime: cloud }).recover();
    await entered;
    await owner({ runtime: cloud }).recover();
    expect(await task("cloud", "listings")).toMatchObject({ runtime: cloud, attempts: 1 });
    const ref = db.doc("cmsPublishQueue/cloud/backgroundOutputs/listings");
    await ref.update({ runtime: office });
    await db.doc("cmsBackgroundOutputs/listings").update({ runtime: office });
    const retained = (await ref.get()).data();
    complete();
    await first;
    expect((await ref.get()).data()).toEqual(retained);
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data().status).toBe("pending");
  });
});


it("creates a new same-owner generation after a code activation without changing the old job release", async () => {
  const previous = { owner: "node-compute", release: "a".repeat(40) };
  const current = { owner: "node-compute", release: "b".repeat(40) };
  await accept("release", document(), owner({ runtime: previous }));
  await owner({ runtime: previous }).recover();
  const retained = await task("release", "listings");
  await db.doc("backgroundTestContext/current").set({ digest: digest("new code release") });
  await owner({ runtime: current }).recover();
  expect(await task("release", "listings")).toEqual(retained);
  // Only the actual active source can create the successor. An arbitrary new
  // release or another host cannot take the old runtime's retained work.
  await db.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: current.release });
  await owner({ runtime: { ...current, owner: "cloudflare" } }).recover();
  expect(await task("release", "listings")).toEqual(retained);
  await owner({ runtime: current }).recover();
  expect(await task("release", "listings")).toEqual(retained);
  expect(await task("release", "listings-2")).toMatchObject({ runtime: current, status: "verified", receipt: { runtime: current } });
  expect((await request("/posts/")).status).toBe(200);
});

it.each(["node-compute", "cloudflare"])("keeps %s release fallback and enforces a withdrawal during the gap", async runtimeOwner => {
  const previous = { owner: runtimeOwner, release: "a".repeat(40) };
  const current = { owner: runtimeOwner, release: "b".repeat(40) };
  await accept("release-gap", document(), owner({ runtime: previous }));
  await owner({ runtime: previous }).recover();
  await db.doc("system/publicDeployment").update({ activeCommitSha: current.release });
  await db.doc("backgroundTestContext/current").update({ rendererSha: current.release });
  time += 33 * 60_000;
  for (const output of outputs) {
    const response = await request(files[output][0]);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-njpbs-background-renderer-sha")).toBe(previous.release);
    expect((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data().receipt.runtime).toEqual(previous);
  }
  await accept("release-gap-withdrawal", document(2, { publiclyVisible: false }), owner({ runtime: current }));
  time += 59_999;
  for (const output of outputs) expect((await request(files[output][0])).status).toBe(200);
  time++;
  for (const output of outputs) expect((await request(files[output][0])).status).toBe(503);
});


it("ends last-good uploaded-image custody before media-bin purge can delete the original", async () => {
  const original = document();
  original.published.metadata.heroImage = "dynamic-upload";
  await accept("with-image", original);
  await owner().recover();
  time += 60_000;
  await accept("without-image", document(2));
  const queued = await task("without-image", "listings");
  expect(queued.dependencies.mediaIds).toEqual(["dynamic-upload"]);
  expect(queued.dependencies.before.mediaIds).toEqual(["dynamic-upload"]);
  expect(queued.dependencies.after.mediaIds).toEqual([]);
  const tombstonedAt = time;
  const purgeAfter = Date.parse(mediaBin.purgeAfterFor(new Date(tombstonedAt).toISOString()));
  expect(mediaBin.MEDIA_RETENTION_MS).toBeGreaterThan(background.MAX_STALE_MS);
  time = start + background.MAX_STALE_MS - 1;
  expect((await request("/posts/")).status).toBe(200);
  expect(time).toBeLessThan(purgeAfter);
  time += 1;
  expect((await request("/posts/")).status).toBe(503);
  time = purgeAfter;
  expect((await request("/posts/")).status).toBe(503);
});


it("keeps the validated Page Home pair while a Post accepts all six non-Home outputs", async () => {
  const marker = { schemaVersion: 1, owner: "page-no-build-v1", pageId: "home", ownerPath: "system/publicDeployment/noBuildPageOwners/home" };
  await db.doc(marker.ownerPath).set({ pageId: "home", ownedPaths: ["/", "/_home-sources.json"] });
  await db.doc("cmsBackgroundOutputs/home").set(marker);
  await accept("post-after-home-handoff", document(), owner(), { homePlacementPaths: ["/"] });
  expect((await db.doc("cmsBackgroundOutputs/home").get()).data()).toEqual(marker);
  expect((await db.doc("cmsPublishQueue/post-after-home-handoff/backgroundOutputs/home").get()).exists).toBe(false);
  await owner().recover();
  for (const output of outputs) expect(await task("post-after-home-handoff", output)).toMatchObject({ status: "verified" });
  expect(await request("/", owner())).toBeNull();
  await db.doc(contextRevision.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  // Non-Home output monitoring still uses the common context identity.
  await db.recursiveDelete(db.collection("cmsBackgroundOutputs"));
  await db.doc("cmsBackgroundOutputs/home").set(marker);
  const messages = [];
  await alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time + 6 * 60_000, send: async message => { messages.push(message); } });
  expect(messages).toEqual([]);
  await db.doc(marker.ownerPath).update({ ownedPaths: ["/"] });
  await alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time + 6 * 60_000, send: async message => { messages.push(message); } });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Listing state is unreadable");
  await alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time + 6 * 60_000, send: async message => { messages.push(message); } });
  expect(messages).toHaveLength(1);
  await db.doc(marker.ownerPath).update({ ownedPaths: ["/", "/_home-sources.json"] });
  await alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time + 7 * 60_000, send: async message => { messages.push(message); } });
  expect((await db.doc("cmsBackgroundOutputs/home").get()).data().pendingSince).toBeNull();
  expect(messages).toHaveLength(1);
  expect((await db.doc("system/cmsBackgroundAlerts").get()).data().outputs).toEqual([]);
  await db.doc(marker.ownerPath).update({ ownedPaths: ["/"] });
  await alerts.checkPostBackgroundAlerts({ firestore: db, now: () => time + 8 * 60_000, send: async message => { messages.push(message); } });
  expect(messages).toHaveLength(2);
  await db.doc(marker.ownerPath).delete();
});
