import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import publication from "../../functions/source-video-publication.js";
import publicVideo from "../../functions/lib/public-video.js";
import renditionModule from "../../functions/lib/source-media-rendition.js";
import scheduledPublish from "../../functions/scheduled-publish.js";
import buildState from "../../functions/lib/publish-build-state.js";
import firebaseConfig from "../../firebase.json";
import { resolveFirebaseEmulatorConfig } from "../../scripts/firebase-emulator-config.mjs";

// Handler tests deliver their own events. Keep fixtures outside the project
// whose live Functions emulator also delivers Firestore withdrawal triggers.
const PROJECT = "demo-njpbs-video-withdrawal";
const ORIGIN = "https://media.njpbs.org";
const assetId = "withdrawal-video";
const media = {
  url: `${ORIGIN}/cms-media/video/${assetId}/${"a".repeat(64)}.mp4`,
  posterUrl: `${ORIGIN}/cms-media/video/${assetId}/${"b".repeat(64)}.jpg`,
  width: 1920,
  height: 1080,
  mimeType: "video/mp4",
};
const log = { info() {}, warn() {}, error() {} };
let app;
let firestore;

function block(copy = media, extra = {}) {
  return {
    id: "video",
    type: "video",
    visible: true,
    order: 0,
    data: {
      sourceId: "video-library",
      assetId,
      title: "Test video",
      public: copy,
    },
    ...extra,
  };
}
function record(extra = {}) {
  return {
    status: "published",
    publiclyVisible: true,
    version: 1,
    published: {
      sourceVersion: 1,
      publishedAt: "2026-10-07T12:00:00.000Z",
      blocks: [block()],
    },
    ...extra,
  };
}

// Real S3 serialization, with R2 and Cloudflare replaced only at their HTTP boundaries.
function providers() {
  const objects = new Map(
    [media.url, media.posterUrl].map((url) => [
      new URL(url).pathname,
      "fixture bytes",
    ]),
  );
  const cached = new Map([...objects]);
  let deleteError = false;
  let purgeError = false;
  let duringDelete;
  let duringPut;
  const r2 = new S3Client({
    region: "auto",
    endpoint: "https://r2.example.invalid",
    forcePathStyle: true,
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 1,
    requestHandler: {
      async handle(request) {
        expect(request.hostname).toBe("r2.example.invalid");
        const path = request.path.replace(/^\/njpbs/, "");
        if (request.method === "HEAD")
          return {
            response: {
              statusCode: objects.has(path) ? 200 : 404,
              headers: objects.has(path)
                ? {
                    "content-length": String(
                      Buffer.byteLength(objects.get(path)),
                    ),
                  }
                : {},
              body: Readable.from([]),
            },
          };
        if (request.method === "PUT") {
          if (duringPut) await duringPut();
          const parts = [];
          for await (const part of request.body) parts.push(Buffer.from(part));
          objects.set(path, Buffer.concat(parts).toString());
          return {
            response: { statusCode: 200, headers: {}, body: Readable.from([]) },
          };
        }
        expect(request.method).toBe("DELETE");
        if (duringDelete) await duringDelete();
        if (deleteError) throw new Error("fixture deletion failure");
        objects.delete(path);
        return {
          response: { statusCode: 204, headers: {}, body: Readable.from([]) },
        };
      },
    },
  });
  const fetchImpl = async (url, options) => {
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${"c".repeat(32)}/purge_cache`,
    );
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    const { prefixes } = JSON.parse(options.body);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.length).toBeLessThanOrEqual(100);
    expect(
      prefixes.every((prefix) =>
        prefix.startsWith("media.njpbs.org/cms-media/video/"),
      ),
    ).toBe(true);
    if (purgeError) return Response.json({ success: false }, { status: 503 });
    for (const path of cached.keys()) {
      if (
        prefixes.some((prefix) => `media.njpbs.org${path}`.startsWith(prefix))
      )
        cached.delete(path);
    }
    return Response.json({ success: true });
  };
  return {
    r2,
    fetchImpl,
    objects,
    cached,
    get(url, { cache = true, method = "GET" } = {}) {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const body =
        (cache ? cached.get(path + parsed.search) : undefined) ??
        objects.get(path);
      return new Response(method === "HEAD" ? null : (body ?? "Not found"), {
        status: body === undefined ? 404 : 200,
      });
    },
    failDelete(value) {
      deleteError = value;
    },
    failPurge(value) {
      purgeError = value;
    },
    duringDelete(callback) {
      duringDelete = callback;
    },
    duringPut(callback) {
      duringPut = callback;
    },
  };
}

async function change(collection, id, after) {
  const ref = firestore.collection(collection).doc(id);
  const before = await ref.get();
  if (after === null) await ref.delete();
  else await ref.set(after);
  return { data: { before, after: await ref.get() }, params: { id } };
}
function consumer(stores, extra = {}) {
  // Before #2783 there is no withdrawal consumer. The same HTTP assertions then
  // reproduce the live 200, rather than failing because an export is missing.
  return (
    publication.createPublicVideoWithdrawalHandler?.({
      firestore,
      r2Fn: () => ({ client: stores.r2, bucket: "njpbs" }),
      purgeConfigFn: () => ({ zoneId: "c".repeat(32), token: "fixture" }),
      fetchImpl: stores.fetchImpl,
      log,
      ...extra,
    }) ?? (async () => {})
  );
}

async function copyRequest(stores) {
  const asset = {
    sourceId: "video-library",
    lifecycle: "active",
    name: "Fixture.mxf",
    originalName: "Fixture.mxf",
    nameSort: "fixture.mxf",
    updatedAtSort: "2026-10-07T12:00:00.000Z",
    mimeType: "application/mxf",
    kind: "video",
    sizeBytes: 8,
    preview: "download_only",
    rightsStatus: "complete",
    version: 1,
    tags: [],
    objectKey: "objects/fixture.mxf",
    objectVersionId: "source-v1",
  };
  const prefix = renditionModule.sourceMediaRenditionOutputPrefix(
    { id: assetId, ...asset },
    "attempt-1",
  );
  asset.rendition = {
    schemaVersion: 1,
    state: "ready",
    sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes,
    attemptId: "attempt-1",
    updatedAt: "2026-10-07T12:00:00.000Z",
    web: {
      objectKey: `${prefix}preview.mp4`,
      objectVersionId: "copy-web",
      sizeBytes: 4,
      mimeType: "video/mp4",
    },
    poster: {
      objectKey: `${prefix}preview-poster.0000000.jpg`,
      objectVersionId: "copy-poster",
      sizeBytes: 4,
      mimeType: "image/jpeg",
    },
  };
  await firestore.collection("mediaSourceAssets").doc(assetId).set(asset);
  const source = { id: "video-library", prefix: "objects/" };
  const handler = publication.createCmsPublishSourceVideoHandler({
    firestore,
    requirePrincipalFn: async () => ({
      uid: "editor",
      principal: { id: "editor", grants: [{ role: "editor" }] },
    }),
    registryFn: () => new Map([[source.id, source]]),
    authorizeFn: async () => {},
    awsConfigFn: () => ({}),
    r2Fn: () => ({ client: stores.r2, bucket: "njpbs" }),
    publicOriginFn: () => ORIGIN,
    s3ClientFn: () => ({
      async send(command) {
        return {
          VersionId: command.input.VersionId,
          ContentLength: 4,
          Body: Readable.from(["data"]),
        };
      },
    }),
    log,
  });
  const body = { sourceId: "video-library", assetId };
  const response = {
    headersSent: false,
    set() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.headersSent = true;
      return this;
    },
  };
  await handler(
    {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from(JSON.stringify(body)),
    },
    response,
  );
  return response;
}

beforeAll(() => {
  const { host, port } =
    resolveFirebaseEmulatorConfig(firebaseConfig).emulators.firestore;
  expect(host).toBe("127.0.0.1");
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe(`${host}:${port}`);
  expect(process.env.GCLOUD_PROJECT).toBe("demo-njpbs");
  app = initializeApp({ projectId: PROJECT }, PROJECT);
  firestore = getFirestore(app);
});
beforeEach(async () => {
  const response = await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  expect(response.ok).toBe(true);
  await firestore
    .collection("cmsPublicVideos")
    .doc(assetId)
    .set({ schemaVersion: 1, sourceId: "video-library", assetId, media });
  await firestore.collection("cmsPosts").doc("one").set(record());
});
afterAll(async () => {
  await deleteApp(app);
});

function scheduledRecord(blocks, extra = {}) {
  return {
    id: "due",
    type: "post",
    title: "Due video",
    date: "2026-10-07",
    tags: [],
    slug: "due-video",
    previousSlugs: [],
    locale: "en",
    status: "scheduled",
    publishAt: "2026-10-07T12:00:00.000Z",
    version: 1,
    blocks,
    ...extra,
  };
}
async function runScheduler(now = "2026-10-07T12:00:00.000Z") {
  return scheduledPublish.createScheduledPublishRunner({
    firestore,
    now: () => now,
    log,
    assertPublishReadyFn: async () => ({}),
    assertPublishedMediaSafeFn: async () => {},
    enqueuePublishFn: async ({ queueId }) => ({ queueId }),
  })();
}
function historicalCopies(copy = media) {
  return [copy.url, copy.posterUrl].map((url) => ({ assetId, url }));
}

describe("withdrawn public video HTTP reachability", () => {
  it.each(["published", "scheduled"])("retains another Post's %s live-blog video through the masked withdrawal scan", async status => {
    const stores = providers();
    const data = { ...block().data };
    if (status === "scheduled") delete data.public;
    const entry = {
      id: "entry-one", headline: "Community briefing", keyUpdate: false,
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Local reporting." }] }] },
      credits: [{ kind: "custom", name: "Newsroom" }], media: { kind: "library-video", data },
    };
    const liveBlog = { schemaVersion: 1, coverageState: "ongoing", updates: [status === "scheduled" ? entry : {
      ...entry, publishedAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T12:00:00.000Z",
    }], ...(status === "published" ? { updatedAt: "2026-10-07T12:00:00.000Z" } : {}) };
    await firestore.collection("cmsPosts").doc("live-blog-owner").set(status === "scheduled"
      ? scheduledRecord([], { publiclyVisible: false, liveBlog })
      : record({ published: { sourceVersion: 1, metadata: { type: "post", liveBlog }, blocks: [] } }));
    const handler = consumer(stores);
    await handler(await change("cmsPosts", "one", record({ publiclyVisible: false })));
    for (const url of [media.url, media.posterUrl]) expect(stores.get(url).status).toBe(200);
    expect((await firestore.collection("cmsPublicVideos").doc(assetId).get()).data().revoked).not.toBe(true);
    await handler(await change("cmsPosts", "live-blog-owner", null));
    for (const url of [media.url, media.posterUrl]) expect(stores.get(url).status).toBe(404);
  });

  it.each(["published", "scheduled"])("retains another Post's %s lead media during a body withdrawal", async status => {
    const stores = providers();
    const data = { ...block().data };
    if (status === "scheduled") delete data.public;
    const leadMedia = { kind: "library-video", data };
    await firestore.collection("cmsPosts").doc("lead-owner").set(status === "scheduled"
      ? { status, publiclyVisible: false, blocks: [], leadMedia }
      : record({ published: { sourceVersion: 1, metadata: { leadMedia }, blocks: [] } }));
    const handler = consumer(stores);
    await handler(await change("cmsPosts", "one", record({ publiclyVisible: false })));
    for (const url of [media.url, media.posterUrl]) expect(stores.get(url).status).toBe(200);
    expect((await firestore.collection("cmsPublicVideos").doc(assetId).get()).data().revoked).not.toBe(true);
    await handler(await change("cmsPosts", "lead-owner", record({ publiclyVisible: false, leadMedia: null,
      published: { sourceVersion: 2, metadata: { leadMedia: null }, blocks: [] } })));
    for (const url of [media.url, media.posterUrl]) expect(stores.get(url).status).toBe(404);
  });

  it.each(["configuration", "claim", "delete", "purge"])(
    "independently recovers a failed %s withdrawal after event delivery has expired",
    async (failure) => {
      const stores = providers();
      let now = Date.now();
      let configured = failure !== "configuration";
      const deps = {
        now: () => now,
        purgeConfigFn: () => ({
          zoneId: configured ? "c".repeat(32) : "",
          token: "fixture",
        }),
      };
      if (failure === "claim")
        await firestore
          .collection("cmsPublicVideos")
          .doc(assetId)
          .update({
            operation: {
              id: "busy-copy",
              kind: "copy",
              expiresAt: now + 60_000,
            },
          });
      stores.failDelete(failure === "delete");
      stores.failPurge(failure === "purge");
      const event = await change(
        "cmsPosts",
        "one",
        record({ publiclyVisible: false }),
      );
      await expect(consumer(stores, deps)(event)).rejects.toMatchObject({
        status: 503,
      });
      for (const url of [media.url, media.posterUrl])
        expect(stores.get(url).status).toBe(200);
      const pending = (
        await firestore
          .collection("cmsPublicVideoWithdrawals")
          .doc(assetId)
          .get()
      ).data();
      // No event is redelivered. The independent owner still sees the outage
      // beyond Firebase's documented 24-hour second-generation retry window.
      now += 25 * 60 * 60_000;
      const recover =
        publication.createPublicVideoWithdrawalRecoveryHandler?.({
          firestore,
          r2Fn: () => ({ client: stores.r2, bucket: "njpbs" }),
          fetchImpl: stores.fetchImpl,
          log,
          ...deps,
        }) ?? (async () => {});
      await recover();
      if (failure !== "claim")
        for (const url of [media.url, media.posterUrl])
          expect(stores.get(url).status).toBe(200);
      configured = true;
      stores.failDelete(false);
      stores.failPurge(false);
      now += 16 * 60_000;
      await recover();
      for (const url of [media.url, media.posterUrl]) {
        expect(stores.get(url).status).toBe(404);
        expect(stores.get(url, { cache: false, method: "HEAD" }).status).toBe(
          404,
        );
      }
      expect(Object.keys(pending).sort()).toEqual([
        "nextAttemptAt",
        "revision",
        "urls",
      ]);
      expect(pending.urls.sort()).toEqual([media.url, media.posterUrl].sort());
    },
  );

  it("keeps shared, scheduled and newer copies during independent recovery", async () => {
    const stores = providers();
    let now = Date.now();
    await expect(
      consumer(stores, { purgeConfigFn: () => ({}) })(
        await change("cmsPosts", "one", record({ publiclyVisible: false })),
      ),
    ).rejects.toMatchObject({ status: 503 });
    const recover = publication.createPublicVideoWithdrawalRecoveryHandler({
      firestore,
      r2Fn: () => ({ client: stores.r2, bucket: "njpbs" }),
      purgeConfigFn: () => ({ zoneId: "c".repeat(32), token: "fixture" }),
      fetchImpl: stores.fetchImpl,
      now: () => now,
      log,
    });
    await firestore.collection("cmsPages").doc("shared").set(record());
    now += 25 * 60 * 60_000;
    await recover();
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(200);
    // No further content events are delivered. The stored request must survive
    // both kinds of retained reference until their current state permits cleanup.
    await firestore.collection("cmsPages").doc("shared").delete();
    await firestore
      .collection("cmsPosts")
      .doc("scheduled")
      .set(scheduledRecord([block()]));
    now += 16 * 60_000;
    await recover();
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(200);
    const copy = await copyRequest(stores);
    expect(copy.statusCode).toBe(200);
    now += 16 * 60_000;
    await recover();
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
    for (const url of [copy.body.media.url, copy.body.media.posterUrl])
      expect(stores.get(url).status).toBe(200);
    expect((await runScheduler()).publishedCount).toBe(1);
  });

  it("does not clear concurrent new intent when an older recovery completes", async () => {
    const stores = providers();
    let now = Date.now();
    const next = {
      ...media,
      url: media.url.replace("a".repeat(64), "d".repeat(64)),
      posterUrl: media.posterUrl.replace("b".repeat(64), "e".repeat(64)),
    };
    for (const url of [next.url, next.posterUrl])
      stores.objects.set(new URL(url).pathname, "new intent");
    await expect(
      consumer(stores, { purgeConfigFn: () => ({}) })(
        await change("cmsPosts", "one", record({ publiclyVisible: false })),
      ),
    ).rejects.toMatchObject({ status: 503 });
    await firestore
      .collection("cmsPages")
      .doc("two")
      .set(record({ published: { sourceVersion: 1, blocks: [block(next)] } }));
    let submitted = false;
    stores.duringDelete(async () => {
      if (submitted) return;
      submitted = true;
      await expect(
        consumer(stores, { now: () => now })(
          await change("cmsPages", "two", record({ publiclyVisible: false })),
        ),
      ).rejects.toMatchObject({ status: 503 });
    });
    const recover = publication.createPublicVideoWithdrawalRecoveryHandler({
      firestore,
      r2Fn: () => ({ client: stores.r2, bucket: "njpbs" }),
      purgeConfigFn: () => ({ zoneId: "c".repeat(32), token: "fixture" }),
      fetchImpl: stores.fetchImpl,
      now: () => now,
      log,
    });
    now += 25 * 60 * 60_000;
    await recover();
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
    for (const url of [next.url, next.posterUrl])
      expect(stores.get(url).status).toBe(200);
    now += 16 * 60_000;
    await recover();
    for (const url of [next.url, next.posterUrl])
      expect(stores.get(url).status).toBe(404);
  });

  it.each(["assets", "versions"])(
    "bounds independent recovery of many %s without losing later intent",
    async (kind) => {
      const stores = providers();
      let now = Date.now();
      const copies = Array.from(
        { length: kind === "assets" ? 11 : 21 },
        (_, index) => {
          const id = kind === "assets" ? `fixture-${index}` : assetId;
          return {
            assetId: id,
            url: `${ORIGIN}/cms-media/video/${id}/${createHash("sha256").update(String(index)).digest("hex")}.mp4`,
          };
        },
      );
      for (const { url } of copies) {
        stores.objects.set(new URL(url).pathname, "version");
        stores.cached.set(new URL(url).pathname, "cached version");
      }
      await firestore
        .collection("cmsPosts")
        .doc("one")
        .set(
          record({
            published: {
              sourceVersion: 1,
              blocks: [],
              previousVideoCopies: copies,
            },
          }),
        );
      await expect(
        consumer(stores, { now: () => now, purgeConfigFn: () => ({}) })(
          await change("cmsPosts", "one", record({ publiclyVisible: false })),
        ),
      ).rejects.toMatchObject({ status: 503 });
      const recover = publication.createPublicVideoWithdrawalRecoveryHandler({
        firestore,
        r2Fn: () => ({ client: stores.r2, bucket: "njpbs" }),
        purgeConfigFn: () => ({ zoneId: "c".repeat(32), token: "fixture" }),
        fetchImpl: stores.fetchImpl,
        now: () => now,
        log,
      });
      now += 25 * 60 * 60_000;
      await recover();
      const remaining = copies.filter(
        ({ url }) => stores.get(url).status === 200,
      );
      expect(remaining).toHaveLength(1);
      if (kind === "versions") {
        await recover();
        expect(stores.get(remaining[0].url).status).toBe(200);
      }
      now += 16 * 60_000;
      await recover();
      for (const { url } of copies) expect(stores.get(url).status).toBe(404);
    },
  );

  it("retains a scheduled copy through another record's withdrawal and releases it after its last scheduled use", async () => {
    const stores = providers();
    const response = await copyRequest(stores);
    expect(response.statusCode).toBe(200);
    const copy = response.body.media;
    await firestore
      .collection("cmsPosts")
      .doc("one")
      .set(record({ published: { sourceVersion: 1, blocks: [block(copy)] } }));
    // Save strips client public URLs. Scheduling retains the server's current
    // copy by asset identity, without creating a public content snapshot.
    const workingBlock = block();
    delete workingBlock.data.public;
    const dueRef = firestore.collection("cmsPosts").doc("due");
    const pageRef = firestore.collection("cmsPages").doc("about");
    await dueRef.set(
      scheduledRecord([workingBlock], { publiclyVisible: false }),
    );
    await pageRef.set(
      scheduledRecord([workingBlock], {
        publiclyVisible: false,
        publishAt: "2026-10-08T12:00:00.000Z",
      }),
    );
    const handler = consumer(stores);
    await handler(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    for (const url of [copy.url, copy.posterUrl]) {
      expect(stores.get(url).status).toBe(200);
      expect(stores.get(url, { cache: false, method: "HEAD" }).status).toBe(
        200,
      );
    }
    expect((await dueRef.get()).data()).toMatchObject({
      status: "scheduled",
      publiclyVisible: false,
    });
    expect((await dueRef.get()).data().published).toBeUndefined();
    expect((await pageRef.get()).data().published).toBeUndefined();
    // An idempotent copy must not discard deferred withdrawal ownership.
    expect((await copyRequest(stores)).body.media).toEqual(copy);
    const beforePublish = await dueRef.get();
    expect((await runScheduler()).publishedCount).toBe(1);
    const published = await dueRef.get();
    expect(published.data().scheduledPublishFailure).toBeUndefined();
    expect(published.data().published.blocks[0].data.public).toEqual(copy);
    await handler({
      data: { before: beforePublish, after: published },
      params: { id: "due" },
    });
    await handler(
      await change("cmsPosts", "due", {
        ...published.data(),
        status: "draft",
        publiclyVisible: false,
      }),
    );
    for (const url of [copy.url, copy.posterUrl])
      expect(stores.get(url).status).toBe(200);
    const cancellation = await change("cmsPages", "about", {
      ...(await pageRef.get()).data(),
      status: "draft",
    });
    await handler(cancellation);
    for (const url of [copy.url, copy.posterUrl]) {
      expect(stores.get(url).status).toBe(404);
      expect(stores.get(url, { cache: false, method: "HEAD" }).status).toBe(
        404,
      );
    }
    const replacement = await copyRequest(stores);
    expect(replacement.statusCode).toBe(200);
    expect(replacement.body.media.url).not.toBe(copy.url);
    await handler(cancellation);
    for (const url of [
      replacement.body.media.url,
      replacement.body.media.posterUrl,
    ])
      expect(stores.get(url).status).toBe(200);
    expect((await pageRef.get()).data().publiclyVisible).toBe(false);
  });

  it.each(["republish", "unpublish"])(
    "does not revive completed cleanup history on a later %s",
    async (action) => {
      const stores = providers();
      const sameVersion = {
        ...media,
        url: `${ORIGIN}/cms-media/video/${assetId}/${createHash("sha256").update("copy-web").digest("hex")}.mp4`,
        posterUrl: `${ORIGIN}/cms-media/video/${assetId}/${createHash("sha256").update("copy-poster").digest("hex")}.jpg`,
      };
      for (const url of [sameVersion.url, sameVersion.posterUrl])
        stores.objects.set(new URL(url).pathname, "data");
      await firestore
        .collection("cmsPublicVideos")
        .doc(assetId)
        .update({ media: sameVersion });
      const ref = firestore.collection("cmsPosts").doc("one");
      await ref.set(
        scheduledRecord([], {
          ...record(),
          id: "one",
          status: "scheduled",
          blocks: [],
          published: { sourceVersion: 1, blocks: [block(sameVersion)] },
        }),
      );
      const handler = consumer(stores);
      async function replaceAndConfirm() {
        const before = await ref.get();
        const result = await runScheduler();
        expect(result.publishedCount).toBe(1);
        const pending = await ref.get();
        await handler({
          data: { before, after: pending },
          params: { id: "one" },
        });
        expect(
          await buildState.settleBuildQueue(firestore, {
            queueId: result.queueId,
            status: "success",
            queueUpdate: { status: "success" },
          }),
        ).toBe(true);
        await handler({
          data: { before: pending, after: await ref.get() },
          params: { id: "one" },
        });
      }
      await replaceAndConfirm();
      expect((await ref.get()).data().published.previousVideoCopies).toEqual(
        [],
      );
      for (const url of [sameVersion.url, sameVersion.posterUrl])
        expect(stores.get(url).status).toBe(404);
      const response = await copyRequest(stores);
      expect(response.statusCode).toBe(200);
      expect(response.body.media.url).not.toBe(sameVersion.url);
      expect(response.body.media.posterUrl).not.toBe(sameVersion.posterUrl);
      expect((await copyRequest(stores)).body.media).toEqual(
        response.body.media,
      );
      await firestore
        .collection("cmsPosts")
        .doc("due")
        .set(
          scheduledRecord([block(response.body.media)], {
            publishAt: "2026-10-08T12:00:00.000Z",
          }),
        );
      if (action === "republish") {
        await ref.update({
          status: "scheduled",
          publishAt: "2026-10-07T12:00:00.000Z",
        });
        await replaceAndConfirm();
      } else {
        await handler(
          await change("cmsPosts", "one", {
            ...(await ref.get()).data(),
            publiclyVisible: false,
          }),
        );
      }
      for (const url of [
        response.body.media.url,
        response.body.media.posterUrl,
      ])
        expect(stores.get(url).status).toBe(200);
      expect(
        (await runScheduler("2026-10-08T12:00:00.000Z")).publishedCount,
      ).toBe(1);
      const due = (
        await firestore.collection("cmsPosts").doc("due").get()
      ).data();
      expect(due.status).toBe("published");
      expect(due.scheduledPublishFailure).toBeUndefined();
    },
  );

  it("keeps an identical recopied version usable by scheduling after another version is withdrawn", async () => {
    const stores = providers();
    const sameVersion = {
      ...media,
      url: `${ORIGIN}/cms-media/video/${assetId}/${createHash("sha256").update("copy-web").digest("hex")}.mp4`,
      posterUrl: `${ORIGIN}/cms-media/video/${assetId}/${createHash("sha256").update("copy-poster").digest("hex")}.jpg`,
    };
    for (const url of [sameVersion.url, sameVersion.posterUrl]) {
      stores.objects.set(new URL(url).pathname, "data");
      stores.cached.set(new URL(url).pathname, "data");
    }
    await firestore
      .collection("cmsPublicVideos")
      .doc(assetId)
      .update({ media: sameVersion });
    await firestore
      .collection("cmsPosts")
      .doc("one")
      .set(record({ published: { blocks: [block(sameVersion)] } }));
    await firestore.collection("cmsPosts").doc("two").set(record());
    const handler = consumer(stores);
    const firstWithdrawal = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    stores.failPurge(true);
    await expect(handler(firstWithdrawal)).rejects.toMatchObject({
      status: 503,
    });
    await firestore
      .collection("cmsPublicVideos")
      .doc(assetId)
      .update({ "operation.expiresAt": Date.now() - 1 });
    stores.failPurge(false);
    const response = await copyRequest(stores);
    expect(response.statusCode).toBe(200);
    expect(response.body.media.url).not.toBe(sameVersion.url);
    expect(response.body.media.posterUrl).not.toBe(sameVersion.posterUrl);
    expect((await copyRequest(stores)).body.media).toEqual(response.body.media);
    await firestore
      .collection("cmsPosts")
      .doc("due")
      .set(scheduledRecord([block(response.body.media)]));
    await handler(firstWithdrawal);
    await handler(firstWithdrawal);
    for (const url of [sameVersion.url, sameVersion.posterUrl])
      expect(stores.get(url).status).toBe(404);
    await handler(
      await change("cmsPosts", "two", record({ publiclyVisible: false })),
    );
    for (const url of [
      response.body.media.url,
      response.body.media.posterUrl,
    ]) {
      expect(stores.get(url).status).toBe(200);
      expect(stores.get(url, { cache: false, method: "HEAD" }).status).toBe(
        200,
      );
    }
    expect((await runScheduler()).publishedCount).toBe(1);
    const due = (
      await firestore.collection("cmsPosts").doc("due").get()
    ).data();
    expect(due.status).toBe("published");
    expect(due.scheduledPublishFailure).toBeUndefined();
    expect(due.published.blocks[0].data.public).toEqual(response.body.media);
  });

  it("withdraws copies of an earlier video block removed by a committed republish", async () => {
    const stores = providers();
    const handler = consumer(stores);
    const ref = firestore.collection("cmsPosts").doc("one");
    await ref.set(
      scheduledRecord([], { ...record(), status: "scheduled", blocks: [] }),
    );
    const before = await ref.get();
    expect((await runScheduler()).publishedCount).toBe(1);
    await handler({
      data: { before, after: await ref.get() },
      params: { id: "one" },
    });
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(200);
    await handler(
      await change("cmsPosts", "one", {
        ...(await ref.get()).data(),
        publiclyVisible: false,
      }),
    );
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
  });

  it("withdraws unused copies despite an unrelated stalled public build", async () => {
    const stores = providers();
    await firestore
      .collection("cmsPosts")
      .doc("malformed-schedule")
      .set(scheduledRecord("invalid blocks", { publiclyVisible: false }));
    await firestore
      .collection("cmsPages")
      .doc("malformed-schedule")
      .set(scheduledRecord([null], { publiclyVisible: false }));
    await firestore
      .collection("cmsPages")
      .doc("unrelated")
      .set(
        record({
          publishBuildPending: true,
          publicSourceVersion: 1,
          published: { sourceVersion: 2, blocks: [] },
        }),
      );
    await consumer(stores)(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
  });

  it.each(["copy", "withdraw"])(
    "publishes a due scheduled post with a valid current copy during a %s lease",
    async (kind) => {
      await firestore
        .collection("cmsPublicVideos")
        .doc(assetId)
        .update({
          operation: {
            id: "in-flight",
            kind,
            expiresAt: Date.now() + 60_000,
            urls: [media.url.replace("a".repeat(64), "d".repeat(64))],
          },
        });
      await firestore
        .collection("cmsPosts")
        .doc("due")
        .set({
          id: "due",
          type: "post",
          title: "Due video",
          date: "2026-10-07",
          tags: [],
          slug: "due-video",
          previousSlugs: [],
          locale: "en",
          status: "scheduled",
          publishAt: "2026-10-07T12:00:00.000Z",
          version: 1,
          blocks: [block()],
        });
      const run = scheduledPublish.createScheduledPublishRunner({
        firestore,
        now: () => "2026-10-07T12:00:00.000Z",
        log,
        assertPublishReadyFn: async () => ({}),
        assertPublishedMediaSafeFn: async () => {},
        enqueuePublishFn: async ({ queueId }) => ({ queueId }),
      });
      expect((await run()).publishedCount).toBe(1);
      const saved = (
        await firestore.collection("cmsPosts").doc("due").get()
      ).data();
      expect(saved.status).toBe("published");
      expect(saved.scheduledPublishFailure).toBeUndefined();
      expect(saved.published.blocks[0].data.public).toEqual(media);
    },
  );

  it("checks purge configuration before revoking or deleting a public copy", async () => {
    const stores = providers();
    const event = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    await expect(
      consumer(stores, { purgeConfigFn: () => ({ zoneId: "", token: "" }) })(
        event,
      ),
    ).rejects.toMatchObject({ status: 503 });
    const stored = (
      await firestore.collection("cmsPublicVideos").doc(assetId).get()
    ).data();
    expect(stored.operation).toBeUndefined();
    expect(stored.revoked).toBeUndefined();
    for (const url of [media.url, media.posterUrl]) {
      expect(stores.get(url).status).toBe(200);
      expect(stores.get(url, { cache: false }).status).toBe(200);
    }
  });

  it("recovers an expired failed cleanup through recopy without losing old cache-purge work", async () => {
    const stores = providers();
    const handler = consumer(stores);
    const event = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    stores.failPurge(true);
    await expect(handler(event)).rejects.toMatchObject({ status: 503 });
    await firestore
      .collection("cmsPublicVideos")
      .doc(assetId)
      .update({ "operation.expiresAt": Date.now() - 1 });
    stores.failPurge(false);
    const response = await copyRequest(stores);
    expect(response.statusCode).toBe(200);
    await firestore
      .collection("cmsPosts")
      .doc("due")
      .set(scheduledRecord([block(response.body.media)]));
    await handler(event);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
    for (const url of [response.body.media.url, response.body.media.posterUrl])
      expect(stores.get(url).status).toBe(200);
    expect((await runScheduler()).publishedCount).toBe(1);
    const due = (
      await firestore.collection("cmsPosts").doc("due").get()
    ).data();
    expect(due.status).toBe("published");
    expect(due.scheduledPublishFailure).toBeUndefined();
    expect(due.published.blocks[0].data.public).toEqual(response.body.media);
  });

  it("keeps the old live version during another record's pending or unconfirmed replacement build", async () => {
    const stores = providers();
    const next = {
      ...media,
      url: media.url.replace("a".repeat(64), "d".repeat(64)),
    };
    stores.objects.set(new URL(next.url).pathname, "new version");
    await firestore
      .collection("cmsPages")
      .doc("two")
      .set(
        record({
          publishBuildPending: true,
          publicSourceVersion: 1,
          published: {
            sourceVersion: 2,
            blocks: [block(next)],
            previousVideoCopies: historicalCopies(),
          },
        }),
      );
    const event = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    const handler = consumer(stores);
    await handler(event);
    expect(stores.get(media.url).status).toBe(200);
    await firestore
      .collection("cmsPages")
      .doc("two")
      .update({ publishBuildPending: false });
    await handler(event);
    expect(stores.get(media.url).status).toBe(200);
    await handler(
      await change("cmsPages", "two", {
        ...(await firestore.collection("cmsPages").doc("two").get()).data(),
        publicSourceVersion: 2,
      }),
    );
    expect(stores.get(media.url).status).toBe(404);
    expect(stores.get(next.url).status).toBe(200);
    expect(stores.get(media.posterUrl).status).toBe(200);
  });

  it("withdraws more than one purge batch of superseded public versions", async () => {
    const stores = providers();
    const versions = Array.from({ length: 101 }, (_, index) =>
      media.url.replace(
        "a".repeat(64),
        createHash("sha256").update(String(index)).digest("hex"),
      ),
    );
    for (const url of versions) {
      stores.objects.set(new URL(url).pathname, "old version");
      stores.cached.set(new URL(url).pathname, "old cached version");
    }
    await firestore
      .collection("cmsPosts")
      .doc("one")
      .update({
        "published.previousVideoCopies": versions.map((url) => ({
          assetId,
          url,
        })),
      });
    await consumer(stores)(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    for (const url of [media.url, media.posterUrl, ...versions])
      expect(stores.get(url).status).toBe(404);
  });

  it.each([
    ["onPublicVideoPostWithdrawal", "cmsPosts/{id}"],
    ["onPublicVideoPageWithdrawal", "cmsPages/{id}"],
  ])(
    "binds %s to retrying content-write events with the required storage and purge credentials",
    (name, document) => {
      const endpoint = publication[name]?.__endpoint;
      expect(endpoint?.eventTrigger).toMatchObject({
        eventType: "google.cloud.firestore.document.v1.written",
        eventFilterPathPatterns: { document },
        retry: true,
      });
      expect(
        endpoint.secretEnvironmentVariables.map((secret) => secret.key),
      ).toEqual([
        "CMS_MEDIA_R2_ACCESS_KEY_ID",
        "CMS_MEDIA_R2_SECRET_ACCESS_KEY",
        "CMS_MEDIA_CACHE_PURGE_TOKEN",
      ]);
    },
  );
  it.each(["unpublish", "archive", "delete"])(
    "withdraws MP4 and poster after %s, including cached query variants and HEAD",
    async (action) => {
      const stores = providers();
      stores.cached.set(
        `${new URL(media.url).pathname}?variant=phone`,
        "cached variant",
      );
      const handler = consumer(stores);
      const event = await change(
        "cmsPosts",
        "one",
        action === "delete"
          ? null
          : record({
              status: action === "archive" ? "archived" : "draft",
              publiclyVisible: false,
            }),
      );
      await handler(event);
      for (const url of [
        media.url,
        media.posterUrl,
        `${media.url}?variant=phone`,
      ]) {
        expect(stores.get(url).status).toBe(404);
        expect(stores.get(url, { cache: false, method: "HEAD" }).status).toBe(
          404,
        );
      }
    },
  );

  it.each(["cmsPosts", "cmsPages"])(
    "retains URLs used by another published %s record, then removes them after its withdrawal",
    async (collection) => {
      const stores = providers();
      const handler = consumer(stores);
      // A public snapshot stays in use while staff work on a newer draft.
      await firestore
        .collection(collection)
        .doc("two")
        .set(record({ status: "draft" }));
      await handler(
        await change(
          "cmsPosts",
          "one",
          record({ status: "draft", publiclyVisible: false }),
        ),
      );
      for (const url of [media.url, media.posterUrl])
        expect(stores.get(url).status).toBe(200);
      await handler(
        await change(
          collection,
          "two",
          record({ status: "archived", publiclyVisible: false }),
        ),
      );
      for (const url of [media.url, media.posterUrl])
        expect(stores.get(url).status).toBe(404);
    },
  );

  it("protects a legacy published record with no explicit visibility flag", async () => {
    const stores = providers();
    const legacy = record();
    delete legacy.publiclyVisible;
    await firestore.collection("cmsPosts").doc("two").set(legacy);
    await consumer(stores)(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(200);
  });

  it("removes the old MP4 while keeping a poster shared with another version", async () => {
    const stores = providers();
    const next = {
      ...media,
      url: media.url.replace("a".repeat(64), "d".repeat(64)),
    };
    stores.objects.set(new URL(next.url).pathname, "new version");
    await firestore
      .collection("cmsPages")
      .doc("two")
      .set(record({ published: { blocks: [block(next)] } }));
    await consumer(stores)(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    expect(stores.get(media.url).status).toBe(404);
    expect(stores.get(media.posterUrl).status).toBe(200);
    expect(stores.get(next.url).status).toBe(200);
  });

  it("ignores working drafts and hidden-row videos when retaining public copies", async () => {
    const stores = providers();
    await firestore
      .collection("cmsPosts")
      .doc("two")
      .set(record({ status: "draft", publiclyVisible: false }));
    const row = {
      id: "row",
      type: "row",
      visible: false,
      order: 0,
      data: { columns: [12] },
    };
    await firestore
      .collection("cmsPages")
      .doc("two")
      .set(
        record({
          published: {
            blocks: [
              row,
              block(media, { order: 1, layout: { rowId: "row", column: 0 } }),
            ],
          },
        }),
      );
    await consumer(stores)(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
  });

  it("rechecks current records before a delayed withdrawal event", async () => {
    const stores = providers();
    const event = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    await firestore.collection("cmsPosts").doc("one").set(record());
    await consumer(stores)(event);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(200);
  });

  it("retains superseded versions for the live static page until actual withdrawal", async () => {
    const stores = providers();
    const next = {
      ...media,
      url: media.url.replace("a".repeat(64), "d".repeat(64)),
      posterUrl: media.posterUrl.replace("b".repeat(64), "e".repeat(64)),
    };
    for (const url of [next.url, next.posterUrl])
      stores.objects.set(new URL(url).pathname, "new version");
    const event = await change(
      "cmsPosts",
      "one",
      record({
        publishBuildPending: true,
        published: {
          blocks: [block(next)],
          previousVideoCopies: historicalCopies(),
        },
      }),
    );
    await consumer(stores)(event);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(200);
    for (const url of [next.url, next.posterUrl])
      expect(stores.get(url).status).toBe(200);
    await consumer(stores)(
      await change(
        "cmsPosts",
        "one",
        record({
          publiclyVisible: false,
          published: {
            blocks: [block(next)],
            previousVideoCopies: historicalCopies(),
          },
        }),
      ),
    );
    for (const url of [media.url, media.posterUrl, next.url, next.posterUrl])
      expect(stores.get(url).status).toBe(404);
  });

  it("accepts duplicate withdrawal delivery without revoking a later public reuse", async () => {
    const stores = providers();
    const handler = consumer(stores);
    const event = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    await handler(event);
    await handler(event);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
    for (const url of [media.url, media.posterUrl])
      stores.objects.set(new URL(url).pathname, "reused copy");
    await firestore.collection("cmsPosts").doc("two").set(record());
    await handler(event);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(200);
  });

  it.each(["delete", "purge"])(
    "retries a %s failure without admitting a missing public copy",
    async (failure) => {
      const stores = providers();
      let now = Date.now();
      const handler = consumer(stores, { now: () => now });
      const event = await change(
        "cmsPosts",
        "one",
        record({ publiclyVisible: false }),
      );
      if (failure === "delete") stores.failDelete(true);
      else stores.failPurge(true);
      await expect(handler(event)).rejects.toThrow();
      await expect(
        firestore.runTransaction((tx) =>
          publicVideo.withPublicVideos({
            tx,
            firestore,
            document: { blocks: [block()] },
          }),
        ),
      ).rejects.toMatchObject({ status: 409 });
      stores.failDelete(false);
      stores.failPurge(false);
      now += 16 * 60_000;
      await handler(event);
      for (const url of [media.url, media.posterUrl])
        expect(stores.get(url).status).toBe(404);
    },
  );

  it("blocks a new publish during object removal", async () => {
    const stores = providers();
    stores.duringDelete(async () => {
      await expect(
        firestore.runTransaction(async (tx) => {
          const doc = await publicVideo.withPublicVideos({
            tx,
            firestore,
            document: { blocks: [block()] },
          });
          tx.set(
            firestore.collection("cmsPosts").doc("two"),
            record({ published: doc }),
          );
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
    await consumer(stores)(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    expect(
      (await firestore.collection("cmsPosts").doc("two").get()).exists,
    ).toBe(false);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
  });

  it("blocks a copy request during withdrawal, then allows recopy and public reuse", async () => {
    const stores = providers();
    stores.duringDelete(async () => {
      expect((await copyRequest(stores)).statusCode).toBe(409);
    });
    await consumer(stores)(
      await change("cmsPosts", "one", record({ publiclyVisible: false })),
    );
    stores.duringDelete(null);
    const response = await copyRequest(stores);
    expect(response.statusCode).toBe(200);
    const expected = response.body.media;
    expect(expected).toMatchObject({
      width: 1920,
      height: 1080,
      mimeType: "video/mp4",
    });
    expect(expected.url).toMatch(
      /^https:\/\/media\.njpbs\.org\/cms-media\/video\/withdrawal-video\/[a-f0-9]{64}\.mp4$/,
    );
    expect(expected.posterUrl).toMatch(
      /^https:\/\/media\.njpbs\.org\/cms-media\/video\/withdrawal-video\/[a-f0-9]{64}\.jpg$/,
    );
    expect(expected.url).not.toBe(media.url);
    expect(expected.posterUrl).not.toBe(media.posterUrl);
    for (const url of [expected.url, expected.posterUrl])
      expect(stores.get(url).status).toBe(200);
    await firestore.runTransaction(async (tx) => {
      const published = await publicVideo.withPublicVideos({
        tx,
        firestore,
        document: { blocks: [block()] },
      });
      tx.set(
        firestore.collection("cmsPosts").doc("two"),
        record({ published }),
      );
    });
    expect(
      (await firestore.collection("cmsPosts").doc("two").get()).data().published
        .blocks[0].data.public,
    ).toEqual(expected);
  });

  it("retries withdrawal while a copy is in flight without removing its new version", async () => {
    const stores = providers();
    const handler = consumer(stores);
    const event = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    stores.duringPut(async () => {
      await expect(handler(event)).rejects.toMatchObject({ status: 503 });
    });
    const response = await copyRequest(stores);
    expect(response.statusCode).toBe(200);
    await handler(event);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
    for (const url of [response.body.media.url, response.body.media.posterUrl])
      expect(stores.get(url).status).toBe(200);
    await firestore.runTransaction(async (tx) => {
      const published = await publicVideo.withPublicVideos({
        tx,
        firestore,
        document: { blocks: [block()] },
      });
      tx.set(
        firestore.collection("cmsPosts").doc("two"),
        record({ published }),
      );
    });
    expect(
      (await firestore.collection("cmsPosts").doc("two").get()).exists,
    ).toBe(true);
  });

  it("serializes concurrent duplicate withdrawal events", async () => {
    const stores = providers();
    const handler = consumer(stores);
    const event = await change(
      "cmsPosts",
      "one",
      record({ publiclyVisible: false }),
    );
    stores.duringDelete(async () => {
      await expect(handler(event)).rejects.toMatchObject({ status: 503 });
    });
    await handler(event);
    for (const url of [media.url, media.posterUrl])
      expect(stores.get(url).status).toBe(404);
  });
});

it("withdraws an unreferenced public copy promptly while retaining the private rollback version", async () => {
  const retained = firestore.doc(`mediaSourceReplacements/${assetId}/versions/prior`);
  await retained.set({ state: "retained", expiresAt: Date.now() + 14 * 86400_000, publicMedia: media });
  const stores = providers();
  await consumer(stores)(await change("cmsPosts", "one", record({ publiclyVisible: false })));
  for (const url of [media.url, media.posterUrl]) expect(stores.get(url).status).toBe(404);
  expect((await retained.get()).data().state).toBe("retained");
});


it.each(["binary", "operation"])("rejects a stale first publication after its %s changes during copying", async change => {
  await firestore.doc(`cmsPublicVideos/${assetId}`).delete();
  const stores = providers();
  let changed = false;
  stores.duringPut(async () => {
    if (changed) return;
    changed = true;
    if (change === "binary") await firestore.doc(`mediaSourceAssets/${assetId}`).update({ objectVersionId: "replacement-v2" });
    else await firestore.doc(`cmsPublicVideos/${assetId}`).update({ "operation.id": "new-owner" });
  });
  const response = await copyRequest(stores);
  expect(response.statusCode).toBe(409);
  expect(response.body.error).toMatch(/video changed/);
  expect((await firestore.doc(`cmsPublicVideos/${assetId}`).get()).data()?.media).toBeUndefined();
});
