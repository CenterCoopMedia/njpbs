import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import purgeModule from "../../functions/lib/post-route-purge.js";
import queueModule from "../../functions/lib/cms-publish-serializer-queue.js";
import reconcileModule from "../../functions/publish-reconcile.js";
import serializerModule from "../../functions/lib/cms-publication-serializer.js";
import artifactModule from "../../functions/lib/cms-publish-artifact.js";
import saveModule from "../../functions/save.js";
import "../../functions/lib/firebase.js";
const db = isolatedFirestore("post-route-purge.test.js");

const { routePurgeSecretNames, createCloudflareRoutePurger, routeTags, attemptPostRoutePurge, retryPostRoutePurges, prepareRoutePurgeInTransaction } = purgeModule;
const { enqueueSerializerBuild } = queueModule;
const { createPublishQueueReconcileRunner } = reconcileModule;
const { claimCmsPublishQueue } = serializerModule;
const { reserveCmsPublishArtifact } = artifactModule;
const { createCmsSaveHandler } = saveModule;
const config = { enabled: true, environment: "dev", projectId: db.projectId, zoneId: "1".repeat(32) };
const token = randomBytes(32).toString("hex");
const START = Date.parse("2026-10-07T13:00:00Z");
const changes = [{ collection: "cmsPosts", id: "purge-post", sourceVersion: 7 }];
const log = () => ({ warn: vi.fn(), info: vi.fn() });
function adapter(fetchImpl, settings = config) { return createCloudflareRoutePurger({ config: settings, getToken: () => token, fetchImpl }); }
async function seed(overrides = {}) {
  await db.doc("cmsPosts/purge-post").set({ version: 8, status: "draft", publiclyVisible: true,
    publishBuildPending: true, publishBuildQueueId: null, title: "Private later draft",
    published: { sourceVersion: 7, metadata: { type: "post", slug: "new-post", previousSlugs: ["old-post", "new-post"] } }, ...overrides });
}
function enqueue(purger, overrides = {}) {
  return enqueueSerializerBuild({ firestore: db, actor: { uid: "fixture-editor", email: "editor@example.test" }, source: "fixture",
    queueId: "purge-queue", changes, routePurge: { config, purger, now: () => START, log: log() }, ...overrides });
}
const success = () => new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { id: "fixture-purge" } }),
  { headers: { "Content-Type": "application/json" } });

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("This suite requires the local demo Firestore emulator");
  }
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});

describe("dev route tag purge", () => {
  it("refuses production tags before any provider request", async () => {
    const fetchImpl = vi.fn();
    await expect(adapter(fetchImpl).purge(["njpbs-post-background"]))
      .rejects.toMatchObject({ code: "purge_invalid_tags", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("builds distinct canonical/retired route tags and rejects invalid slugs", () => {
    expect(routeTags(["old-post", "new-post", "old-post"])).toEqual(["njpbs-dev-post-old-post", "njpbs-dev-post-new-post"]);
    expect(() => routeTags(["/posts/private/"])).toThrow();
  });
  it("uses the cache-tag API schema, chunks tags and keeps the token only in the request", async () => {
    const fetchImpl = vi.fn(async (url, request) => {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`);
      expect(request.method).toBe("POST");
      expect(request.headers.Authorization).toBe(`Bearer ${token}`);
      expect(request.redirect).toBe("error");
      expect(request.body).not.toContain(token);
      expect(Object.keys(JSON.parse(request.body))).toEqual(["tags"]);
      return success();
    });
    const tags = Array.from({ length: 31 }, (_, index) => `njpbs-dev-post-route-${index}`);
    await adapter(fetchImpl).purge(tags);
    expect(fetchImpl.mock.calls.map(call => JSON.parse(call[1].body).tags)).toEqual([tags.slice(0, 30), tags.slice(30)]);
  });
  it.each([{ enabled: false }, { environment: "production" }, { projectId: "njpbs-production" }, { zoneId: "" }])(
    "makes no request for disabled or non-dev configuration %j", async override => {
      const fetchImpl = vi.fn();
      await adapter(fetchImpl, { ...config, ...override }).purge(["njpbs-dev-post-new-post"]);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  it("binds the named token only in the explicitly configured dev deployment", () => {
    const env = { SHADOW_POST_ROUTE_PURGE_ENABLED: "true", SHADOW_POST_ROUTE_PURGE_ZONE_ID: config.zoneId,
      SHADOW_POST_ROUTE_PURGE_PROJECT_ID: "example-dev", GCLOUD_PROJECT: "example-dev" };
    expect(routePurgeSecretNames(env)).toEqual(["SHADOW_POST_ROUTE_PURGE_TOKEN"]);
    expect(routePurgeSecretNames({ ...env, GCLOUD_PROJECT: "njpbs-production" })).toEqual([]);
    expect(routePurgeSecretNames({ ...env, SHADOW_POST_ROUTE_PURGE_ENABLED: "false" })).toEqual([]);
  });
  it.each([true, false, "wrong-project"])("binds the token to every publish/withdrawal/recovery Function only when admitted: %s", mode => {
    // A fresh local process reads real trigger metadata. No token value exists,
    // no handler runs, and no remote client is called.
    const script = `const owners = [require('./functions/save').cmsSaveContent, require('./functions/publish').cmsPublish,
      require('./functions/scheduled-publish').onScheduledPublish,
      require('./functions/lifecycle-transition').cmsTransitionContent,
      require('./functions/bulk-archive').cmsBulkArchiveContent,
      require('./functions/publish-reconcile').onPublishQueueReconcile];
      console.log(JSON.stringify(owners.map(fn => fn.__endpoint.secretEnvironmentVariables
        .some(secret => secret.key === 'SHADOW_POST_ROUTE_PURGE_TOKEN'))));`;
    const env = { ...process.env, GCLOUD_PROJECT: config.projectId,
      SHADOW_POST_ROUTE_PURGE_ENABLED: mode === false ? "false" : "true",
      SHADOW_POST_ROUTE_PURGE_ENVIRONMENT: "dev", SHADOW_POST_ROUTE_PURGE_ZONE_ID: config.zoneId,
      SHADOW_POST_ROUTE_PURGE_PROJECT_ID: mode === "wrong-project" ? "another-dev" : config.projectId };
    delete env.SHADOW_POST_ROUTE_PURGE_TOKEN;
    const result = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(Array(6).fill(mode === true));
  });
  it.each([408, 429, 500])("classifies transient HTTP %i for retry", async status => {
    await expect(adapter(async () => new Response(null, { status })).purge(["njpbs-dev-post-new-post"]))
      .rejects.toMatchObject({ code: `purge_http_${status}`, retryable: true });
  });
  it("records missing configuration and provider refusal using fixed codes", async () => {
    const missing = createCloudflareRoutePurger({ config, getToken: () => undefined, fetchImpl: vi.fn() });
    await expect(missing.purge(["njpbs-dev-post-new-post"])).rejects.toMatchObject({ code: "purge_not_configured", retryable: false });
    const unavailable = createCloudflareRoutePurger({ config, getToken() { throw new Error(token); }, fetchImpl: vi.fn() });
    await expect(unavailable.purge(["njpbs-dev-post-new-post"])).rejects.toMatchObject({ code: "purge_not_configured", retryable: false });
    await expect(adapter(async () => new Response(JSON.stringify({ success: false, errors: [{ message: token }] })))
      .purge(["njpbs-dev-post-new-post"])).rejects.toMatchObject({ code: "purge_refused", retryable: false });
  });
  it("purges only after durable acceptance and records success without changing published state", async () => {
    await seed();
    const fetchImpl = vi.fn(async (_url, request) => {
      expect((await db.doc("cmsPosts/purge-post").get()).data().published.sourceVersion).toBe(7);
      expect((await db.doc("cmsPublishQueue/purge-queue").get()).data().routePurge.tags).toEqual([
        "njpbs-dev-post-new-post", "njpbs-dev-post-old-post",
      ]);
      expect(JSON.parse(request.body)).toEqual({ tags: ["njpbs-dev-post-new-post", "njpbs-dev-post-old-post"] });
      return success();
    });
    const before = (await db.doc("cmsPosts/purge-post").get()).data().published;
    expect(await enqueue(adapter(fetchImpl))).toMatchObject({ success: true, status: "pending" });
    expect((await db.doc("cmsPublishQueue/purge-queue").get()).data()).toMatchObject({ status: "pending", error: null,
      routePurge: { phase: "success", attempts: 1, error: null, nextAttemptAt: null } });
    expect((await db.doc("cmsPosts/purge-post").get()).data().published).toEqual(before);
    // An exact retry of the accepted queue cannot send a second successful purge.
    expect(await enqueue(adapter(fetchImpl), { queueReserved: true })).toMatchObject({ success: true, idempotent: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([200, 503, "disabled", "rollback"])("covers the Admin's atomic save-and-publish path: %s", async outcome => {
    await seed({ status: "approved", type: "post", slug: "new-post", section: "watch", createdBy: "fixture-editor",
      previousSlugs: ["older-post", "old-post"], date: "2026-10-07", tags: [], blocks: [],
      published: { sourceVersion: 7, publishedAt: "2026-10-06T12:00:00Z",
        metadata: { type: "post", title: "Old title", slug: "old-post", previousSlugs: ["older-post"] }, blocks: [] } });
    const observed = [];
    const fetchImpl = vi.fn(async (_url, request) => {
      const saved = (await db.doc("cmsPosts/purge-post").get()).data();
      const row = (await db.collection("cmsPublishQueue").get()).docs[0].data();
      observed.push({ sourceVersion: saved.published.sourceVersion, changes: row.changes,
        tags: row.routePurge.tags, requestTags: JSON.parse(request.body).tags });
      return outcome === 503 ? new Response(null, { status: 503 }) : success();
    });
    const settings = outcome === "disabled" ? { ...config, enabled: false } : config;
    const logger = { ...log(), error: vi.fn() };
    const handler = createCmsSaveHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: "fixture-editor", email: "editor@example.test",
        principal: { id: "fixture-editor", grants: [{ role: "admin" }] } }),
      enablePublishSnapshot: true, assertPublishReadyFn: async () => ({ transport: "serializer" }),
      assertPublishedMediaSafeFn: async () => {}, now: () => new Date(START).toISOString(), log: logger,
      ...(outcome === "rollback" ? { adminLogEntryFn() { throw new Error("Local audit refusal"); } } : {}),
      routePurge: { config: settings, purger: adapter(fetchImpl, settings), now: () => START } });
    const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await handler({ method: "POST", headers: {}, body: {
      collection: "cmsPosts", id: "purge-post", baseVersion: 8, publish: true, document: {} } }, res);
    if (outcome === "rollback") {
      expect([res.statusCode, res.body?.error]).toEqual([500, "Local audit refusal"]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
      expect((await db.doc("cmsPosts/purge-post").get()).data().published.sourceVersion).toBe(7);
      return;
    }
    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const rowRef = db.doc(`cmsPublishQueue/${res.body.publication.queueId}`);
    const row = (await rowRef.get()).data();
    expect(row).toMatchObject({ status: "pending", error: null });
    if (outcome === "disabled") {
      expect(row).not.toHaveProperty("routePurge");
      expect(fetchImpl).not.toHaveBeenCalled();
    } else {
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(observed).toEqual([{ sourceVersion: 9,
        changes: [{ collection: "cmsPosts", id: "purge-post", sourceVersion: 9 }],
        tags: ["njpbs-dev-post-new-post", "njpbs-dev-post-older-post", "njpbs-dev-post-old-post"],
        requestTags: ["njpbs-dev-post-new-post", "njpbs-dev-post-older-post", "njpbs-dev-post-old-post"] }]);
      expect(row.routePurge).toMatchObject({ phase: outcome === 503 ? "retry" : "success", attempts: 1 });
      if (outcome === 503) {
        expect(row.routePurge).toMatchObject({ error: "purge_http_503", nextAttemptAt: START + 60_000 });
        await retryPostRoutePurges({ firestore: db, config, purger: adapter(async () => success()), now: () => START + 60_000 });
        expect((await rowRef.get()).data().routePurge.phase).toBe("success");
      }
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.stringify([row, logger.warn.mock.calls])).not.toContain(token);
  });
  it("records transient failure and retries with backoff through the existing background runner", async () => {
    await seed();
    let time = START;
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockImplementation(success);
    const purger = adapter(fetchImpl);
    const accepted = await enqueue(purger);
    expect(accepted.success).toBe(true);
    const ref = db.doc("cmsPublishQueue/purge-queue");
    expect((await ref.get()).data()).toMatchObject({ status: "pending", error: null,
      routePurge: { phase: "retry", attempts: 1, nextAttemptAt: START + 60_000, error: "purge_http_503" } });
    const run = createPublishQueueReconcileRunner({ firestore: db, now: () => time, log: log(),
      getHealthchecksUrl: () => "https://example.test/health", fetchImpl: async () => ({ ok: true }),
      routePurge: { config, purger, now: () => time, log: log() } });
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time += 60_000;
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await ref.get()).data()).toMatchObject({ status: "pending", routePurge: { phase: "success", attempts: 2 } });
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("preserves purge state through serializer claim and artifact reservation", async () => {
    await seed();
    const queueId = "77777777777777777777";
    const request = { firestore: db, queueId, buildBatchId: `cms-${queueId}`, commitSha: "a".repeat(40),
      serializerId: "dev-fixture", claimToken: "77777777-7777-4777-8777-777777777777" };
    await enqueue(adapter(async () => success()), { queueId, commitSha: request.commitSha });
    expect(await claimCmsPublishQueue(request)).toMatchObject({ outcome: "claimed", idempotent: false });
    const artifactBuild = await reserveCmsPublishArtifact(request);
    expect(await claimCmsPublishQueue(request)).toMatchObject({ outcome: "claimed", idempotent: true });
    const row = (await db.doc(`cmsPublishQueue/${queueId}`).get()).data();
    expect(row).toMatchObject({ status: "publishing", artifactBuild, routePurge: { phase: "success", attempts: 1 } });
  });
  it("completes stale-row reconciliation and its health ping before isolating a failed purge query", async () => {
    const events = [];
    const logger = log();
    const firestore = { projectId: config.projectId, collection() { events.push("purge"); throw new Error(token); } };
    const run = createPublishQueueReconcileRunner({ firestore, log: logger,
      reconcileStaleFn: async () => { events.push("reconcile"); return 3; },
      getHealthchecksUrl: () => "https://example.test/health", fetchImpl: async () => { events.push("health"); return { ok: true }; },
      routePurge: { config } });
    expect(await run()).toEqual({ reconciledCount: 3 });
    expect(events).toEqual(["reconcile", "health", "purge"]);
    expect(logger.warn).toHaveBeenCalledWith("Post route purge retry unavailable", { code: "purge_retry_unavailable" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token);
  });
  it("bounds background purge work and leaves an aborted attempt durable for recovery", async () => {
    await seed();
    let state;
    await db.runTransaction(async transaction => {
      state = await prepareRoutePurgeInTransaction({ firestore: db, transaction, config, changes, now: START });
    });
    await db.doc("cmsPublishQueue/purge-queue").set({ status: "success", routePurge: state });
    const events = [];
    const stop = new AbortController();
    const fetchImpl = vi.fn(async (_url, request) => {
      events.push("purge");
      await new Promise((_, reject) => {
        if (request.signal.aborted) reject(new Error(token));
        else request.signal.addEventListener("abort", () => reject(new Error(token)), { once: true });
        stop.abort();
      });
    });
    const logger = log();
    const run = createPublishQueueReconcileRunner({ firestore: db, now: () => START, log: logger,
      reconcileStaleFn: async () => { events.push("reconcile"); return 0; },
      getHealthchecksUrl: () => "https://example.test/health", fetchImpl: async () => { events.push("health"); return { ok: true }; },
      routePurge: { config, purger: adapter(fetchImpl), signal: stop.signal } });
    expect(await run()).toEqual({ reconciledCount: 0 });
    expect(events).toEqual(["reconcile", "health", "purge"]);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith("Post route purge retry unavailable", { code: "purge_retry_unavailable" });
    // Firestore operations cannot be cancelled. Either their expiring claim or
    // their fixed retry result remains durable; neither changes publication.
    const row = (await db.doc("cmsPublishQueue/purge-queue").get()).data();
    expect(row.status).toBe("success");
    expect(["processing", "retry"]).toContain(row.routePurge.phase);
    expect(row.routePurge.nextAttemptAt).toBe(START + 60_000);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token);
  });
  it("expires a hung retry query within the total wait budget", async () => {
    const events = [];
    const logger = log();
    const query = { where() { return this; }, orderBy() { return this; }, limit() { return this; },
      get() { events.push("query"); return new Promise(() => {}); } };
    const firestore = { projectId: config.projectId, collection: () => query };
    const run = createPublishQueueReconcileRunner({ firestore, log: logger,
      reconcileStaleFn: async () => { events.push("reconcile"); return 0; },
      getHealthchecksUrl: () => "https://example.test/health", fetchImpl: async () => { events.push("health"); return { ok: true }; },
      routePurge: { config, budgetMs: 20 } });
    expect(await run()).toEqual({ reconciledCount: 0 });
    expect(events).toEqual(["reconcile", "health", "query"]);
    expect(logger.warn).toHaveBeenCalledWith("Post route purge retry unavailable", { code: "purge_retry_unavailable" });
  });
  it.each([400, 401, 403])("records permanent HTTP %i failure without rollback or token logging", async status => {
    await seed();
    const logger = log();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: token }] }), { status }));
    const result = await enqueue(adapter(fetchImpl), { routePurge: { config, purger: adapter(fetchImpl), now: () => START, log: logger } });
    expect(result.success).toBe(true);
    const row = (await db.doc("cmsPublishQueue/purge-queue").get()).data();
    expect(row.status).toBe("pending");
    expect(row.routePurge).toMatchObject({ phase: "failed", attempts: 1, error: `purge_http_${status}`, nextAttemptAt: null });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token);
    expect(await retryPostRoutePurges({ firestore: db, config, purger: adapter(fetchImpl), now: () => START + 99_000 })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("records thrown fetch errors using only a fixed reason code", async () => {
    await seed();
    const logger = log();
    const purger = adapter(async () => { throw new Error(`Bearer ${token}`); });
    expect((await enqueue(purger, { routePurge: { config, purger, now: () => START, log: logger } })).success).toBe(true);
    const row = (await db.doc("cmsPublishQueue/purge-queue").get()).data();
    expect(row.routePurge.error).toBe("purge_network_error");
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token);
  });
  it("captures withdrawal's canonical and old aliases even when the Post is hidden", async () => {
    await seed({ publiclyVisible: false });
    const fetchImpl = vi.fn(async () => success());
    expect((await enqueue(adapter(fetchImpl), { changes: [{ ...changes[0], operation: "withdraw" }] })).success).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ tags: ["njpbs-dev-post-new-post", "njpbs-dev-post-old-post"] });
    expect((await db.doc("cmsPosts/purge-post").get()).data().publiclyVisible).toBe(false);
  });
  it("keeps default-off queues unchanged and refuses queue work against another project", async () => {
    await seed();
    const fetchImpl = vi.fn();
    expect((await enqueue(adapter(fetchImpl), { routePurge: { config: { ...config, enabled: false }, purger: adapter(fetchImpl) } })).success).toBe(true);
    expect((await db.doc("cmsPublishQueue/purge-queue").get()).data().routePurge).toBeUndefined();
    expect(await retryPostRoutePurges({ firestore: db, config: { ...config, projectId: "another-dev" }, purger: adapter(fetchImpl) })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("ignores Programs in a mixed batch and records invalid Post routing without blocking acceptance", async () => {
    await seed();
    await db.doc("cmsPosts/purge-program").set({ version: 7, published: { sourceVersion: 7,
      metadata: { type: "program", slug: "program-route", previousSlugs: [] } } });
    const program = { ...changes[0], id: "purge-program" };
    const fetchImpl = vi.fn(success);
    expect((await enqueue(adapter(fetchImpl), { changes: [...changes, program] })).success).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ tags: ["njpbs-dev-post-new-post", "njpbs-dev-post-old-post"] });
    let state;
    await db.runTransaction(async transaction => {
      state = await prepareRoutePurgeInTransaction({ firestore: db, transaction, config, changes: [program], now: START });
    });
    expect(state).toBeUndefined();
    await seed({ published: { sourceVersion: 7, metadata: { type: "post", slug: "/invalid/", previousSlugs: [] } } });
    expect((await enqueue(adapter(fetchImpl), { queueId: "invalid-routes" })).success).toBe(true);
    expect((await db.doc("cmsPublishQueue/invalid-routes").get()).data()).toMatchObject({ status: "pending",
      routePurge: { phase: "failed", attempts: 0, error: "purge_invalid_routes" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retains queued work while the adapter is disabled and refuses a changed zone", async () => {
    await seed();
    let state;
    await db.runTransaction(async transaction => {
      state = await prepareRoutePurgeInTransaction({ firestore: db, transaction, config, changes, now: START });
    });
    const ref = db.doc("cmsPublishQueue/purge-queue");
    await ref.set({ status: "success", routePurge: state });
    const fetchImpl = vi.fn();
    expect(await attemptPostRoutePurge({ firestore: db, queueId: ref.id, config,
      purger: adapter(fetchImpl, { ...config, enabled: false }), now: () => START })).toBe(false);
    expect((await ref.get()).data().routePurge.phase).toBe("pending");
    expect(await attemptPostRoutePurge({ firestore: db, queueId: ref.id, config: { ...config, zoneId: "2".repeat(32) },
      purger: adapter(fetchImpl), now: () => START })).toBe(false);
    expect((await ref.get()).data()).toMatchObject({ status: "success", routePurge: { phase: "failed", error: "purge_retry_refused" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("recovers an interrupted claim, fences its late result and stops at the retry cap", async () => {
    await seed();
    let state;
    await db.runTransaction(async transaction => {
      state = await prepareRoutePurgeInTransaction({ firestore: db, transaction, config, changes, now: START });
    });
    const ref = db.doc("cmsPublishQueue/purge-queue");
    await ref.set({ status: "success", routePurge: { ...state, phase: "processing", attempts: 1, claim: "interrupted", nextAttemptAt: START } });
    const purger = adapter(async () => success());
    expect(await retryPostRoutePurges({ firestore: db, config, purger, now: () => START })).toBe(1);
    expect((await ref.get()).data()).toMatchObject({ status: "success", routePurge: { phase: "success", attempts: 2 } });
    let resume;
    await ref.update({ routePurge: state });
    // Use a network barrier to exercise late completion after claim replacement.
    let started;
    const barrier = new Promise(resolve => { started = resolve; });
    const late = attemptPostRoutePurge({ firestore: db, queueId: ref.id, config, now: () => START,
      purger: { async purge() { started(); await new Promise(resolve => { resume = resolve; }); } } });
    await barrier;
    await attemptPostRoutePurge({ firestore: db, queueId: ref.id, config, purger, now: () => START + 60_000 });
    resume();
    await late;
    expect((await ref.get()).data().routePurge.attempts).toBe(2);
    await ref.update({ routePurge: { ...state, phase: "processing", attempts: 6, nextAttemptAt: START, claim: "last-interruption" } });
    expect(await retryPostRoutePurges({ firestore: db, config, purger, now: () => START })).toBe(0);
    expect((await ref.get()).data()).toMatchObject({ status: "success", routePurge: { phase: "failed", error: "purge_retry_refused" } });
  });
});
