import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import adminPkg from "../helpers/firebase-admin.js";
import mediaContract from "../../functions/lib/media-contract.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import replacement from "../../functions/replace-media.js";
import media from "../../functions/media.js";
import { releaseSelector } from "../helpers/private-public-release-pair.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNg+M/wHwAEAQH/U7xMcQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const OLD_HASH = "a".repeat(64);
const NEW_HASH = createHash("sha256").update(PNG).digest("hex");
const { finalObjectKey, mediaProjection } = mediaContract;
const { formatMediaEtag } = mediaLibrary;
const {
  cmsReplaceMediaBinary,
  createCmsReplaceMediaBinaryHandler,
  commitReplacement,
  replacementRecord,
  reserveReplacement,
} = replacement;

let db;

function actor(grants = [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]) {
  return {
    uid: "editor-1",
    email: "editor@example.org",
    principal: { id: "editor-1", grants },
  };
}

function stored(overrides = {}) {
  const storageKey = finalObjectKey({
    category: "news",
    assetId: "asset-one",
    contentHash: OLD_HASH,
    mimeType: "image/png",
  });
  return {
    id: "asset-one",
    name: "Studio control room",
    originalName: "studio-old.png",
    category: "news",
    tags: ["studio"],
    description: "Main production room",
    altText: "Monitors and switchers",
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 99,
    width: 10,
    height: 10,
    contentHash: OLD_HASH,
    storageKey,
    url: `https://media.njpbs.org/${storageKey}`,
    lifecycle: "active",
    source: "upload",
    version: 2,
    createdAt: "2026-08-13T12:00:00.000Z",
    createdBy: "editor-before",
    updatedAt: "2026-08-13T12:00:00.000Z",
    updatedBy: "editor-before",
    ...overrides,
  };
}

function makeReq({
  assetId = "asset-one",
  etag = formatMediaEtag(assetId, 2),
  includeEtag = true,
} = {}) {
  const request = {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=test",
      "x-forwarded-for": "203.0.113.17",
    },
    ip: "127.0.0.1",
    rawBody: PNG,
    testAssetId: assetId,
  };
  if (includeEtag) request.headers["if-match"] = etag;
  return request;
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    headers: new Map(),
  };
  res.set = (name, value) => {
    res.headers.set(name.toLocaleLowerCase("en-US"), value);
    return res;
  };
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  return res;
}

function memoryStorage({ failFinal = false, failDeleteStaging = false } = {}) {
  const objects = new Map();
  const writes = [];
  let shouldFailFinal = failFinal;
  let shouldFailDeleteStaging = failDeleteStaging;
  return {
    objects,
    writes,
    setFailFinal(value) {
      shouldFailFinal = value;
    },
    setFailDeleteStaging(value) {
      shouldFailDeleteStaging = value;
    },
    async putStaging({ key, body, mimeType, metadata }) {
      writes.push({ method: "staging", key });
      objects.set(key, { body, mimeType, metadata });
    },
    async putFinal({ key, body, mimeType, metadata }) {
      writes.push({ method: "final", key });
      if (shouldFailFinal) throw new Error("R2 connection failed");
      if (objects.has(key)) return { created: false };
      objects.set(key, { body, mimeType, metadata });
      return { created: true };
    },
    async head(key) {
      const object = objects.get(key);
      if (!object) throw new Error("Not found");
      return {
        contentLength: object.body.length,
        contentType: object.mimeType,
        metadata: object.metadata,
      };
    },
    async deleteStaging(key) {
      if (shouldFailDeleteStaging) throw new Error("R2 delete failed");
      objects.delete(key);
    },
    async deleteFinal() {
      throw new Error("A replacement must never delete an immutable final object");
    },
  };
}

function handler({
  principal = actor(),
  storage = memoryStorage(),
  now = () => new Date("2026-08-14T12:00:00.000Z"),
  commitReplacementFn,
  inspectUploadFn,
  masterStorageFactory,
  mintId = () => "replace-attempt-one",
  upload = {
    originalName: "studio-new.png",
    mimeType: "image/png",
    buffer: PNG,
  },
} = {}) {
  return {
    storage,
    run: createCmsReplaceMediaBinaryHandler({
      firestore: db,
      requirePrincipalFn: async () => principal,
      parseUploadFn: async (req) => ({
        ...upload,
        fields: { assetId: req.testAssetId, ...upload.fields },
      }),
      storageFactory: () => storage,
      ...(masterStorageFactory ? { masterStorageFactory } : {}),
      mintId,
      now,
      maxUploadBytes: 25 * 1024 * 1024,
      publicOrigin: "https://media.njpbs.org",
      ...(commitReplacementFn ? { commitReplacementFn } : {}),
      ...(inspectUploadFn ? { inspectUploadFn } : {}),
      log: { error: vi.fn(), warn: vi.fn() },
    }),
  };
}

async function seedAsset(record = stored()) {
  await Promise.all([
    db.collection("media_assets").doc(record.id).set(record),
    db.collection("media_assets_public").doc(record.id).set(mediaProjection(record)),
    db.collection("system").doc("media").collection("hashOwners").doc(record.contentHash).set({
      state: "committed",
      operation: "upload",
      assetId: record.id,
      category: record.category,
      finalKey: record.storageKey,
    }),
  ]);
}

async function seedActiveDeployment(generation = 7) {
  await db.collection("system").doc("publicDeployment").set({
    schemaVersion: 1,
    mediaLifecycleReady: true,
    state: "idle",
    activeGeneration: generation,
    activeDeploymentId: `deployment-${generation}`,
    activeCommitSha: "b".repeat(40),
    lastReservedGeneration: generation,
    newestEligibleGeneration: generation,
    newestEligibleBuildBatchId: `build-${generation}`,
  });
}

async function invoke(run, request = makeReq()) {
  const res = makeRes();
  await run(request, res);
  return res;
}

async function documents(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("replace-media.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("cmsReplaceMediaBinary", () => {
  it("keeps the exported handler on the bounded secret-backed upload runtime", () => {
    expect(cmsReplaceMediaBinary.__endpoint.secretEnvironmentVariables).toEqual([
      { key: "CMS_MEDIA_R2_ACCESS_KEY_ID" },
      { key: "CMS_MEDIA_R2_SECRET_ACCESS_KEY" },
      { key: "CMS_EDGE_ORIGIN_SECRET" },
    ]);
    expect(cmsReplaceMediaBinary.__endpoint).toMatchObject({
      availableMemoryMb: 1024,
      concurrency: 1,
      maxInstances: 5,
      timeoutSeconds: 120,
    });
  });

  it("maps an invalid replacement record to the retryable typed error", () => {
    const attemptId = "replacement-attempt";
    const claim = {
      assetId: "asset-one",
      attemptId,
      recordSeed: {
        originalName: "studio-new.png",
        dimensions: { width: 1, height: 1 },
        actor: { uid: "editor-1" },
      },
      mimeType: "image/png",
      sizeBytes: PNG.length,
      contentHash: NEW_HASH,
      finalKey: "cms-media/news/asset-one/new.png",
      publicUrl: "https://media.njpbs.org/cms-media/news/asset-one/new.png",
    };

    let error;
    try {
      replacementRecord(stored({ name: "" }), claim, "2026-08-14T12:00:00.000Z");
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: "MediaRequestError",
      status: 503,
      message: "The replacement media record is invalid",
      details: { retryable: true, attemptId },
    });
  });

  it.each([
    ["undersized", undefined, { width: 1, height: 1 }, false, 400, /at least/],
    ["animated", undefined, { width: 500, height: 500 }, true, 415, /still/],
    ["optimized", "webp", { width: 500, height: 500 }, false, 400, /keep the original/],
  ])("refuses an %s staff-profile replacement before storage writes", async (
    _kind, imageProcessing, dimensions, animated, status, error,
  ) => {
    const before = stored({ category: "staff-profile" });
    await seedAsset(before);
    const { run, storage } = handler({
      principal: actor([{ role: "editor" }]),
      upload: {
        originalName: "profile.png", mimeType: "image/png", buffer: PNG,
        fields: imageProcessing ? { imageProcessing } : {},
      },
      inspectUploadFn: async () => ({ dimensions, animated }),
    });
    const res = await invoke(run);
    expect(res.statusCode).toBe(status);
    expect(res.body.error).toMatch(error);
    expect(storage.writes).toEqual([]);
    expect((await db.doc("media_assets/asset-one").get()).data()).toEqual(before);
    expect(await documents("adminLogs")).toHaveLength(0);
  });

  it("allows schema-two replacement with missing pins while retaining the old immutable bytes for guarded GC", async () => {
    const before = stored();
    await seedAsset(before);
    await db.doc("system/publicDeployment").set(releaseSelector());
    const { run, storage } = handler(), bytes = Buffer.from("original immutable version");
    storage.objects.set(before.storageKey, { body: bytes, mimeType: before.mimeType, metadata: {} });
    const res = await invoke(run);
    expect(res.statusCode).toBe(200);
    expect(storage.objects.get(before.storageKey).body).toEqual(bytes);
    const queued = (await db.doc(`mediaPurgeQueue/version:asset-one:${OLD_HASH}`).get()).data();
    expect(queued).toMatchObject({ state: "pending", assetId: "asset-one", reason: "superseded" });
    expect(queued.objects).toContainEqual(expect.objectContaining({ store: "public", key: before.storageKey }));
    expect((await documents("admin_logs"))[0].after.retainedReleaseBytes).toBe("pair-retention-unproven");
  });

  it("keeps the asset id, commits a new immutable object and exact projection, and retains the old owner", async () => {
    const before = stored();
    await seedAsset(before);
    const { run, storage } = handler();

    const res = await invoke(run);

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 3));
    expect(res.body).toMatchObject({
      success: true,
      changed: true,
      asset: {
        id: "asset-one",
        originalName: "studio-new.png",
        version: 3,
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
    });
    const record = (await db.collection("media_assets").doc("asset-one").get()).data();
    const expectedKey = finalObjectKey({
      category: "news",
      assetId: "asset-one",
      contentHash: NEW_HASH,
      mimeType: "image/png",
    });
    expect(record).toMatchObject({
      id: "asset-one",
      contentHash: NEW_HASH,
      storageKey: expectedKey,
      url: `https://media.njpbs.org/${expectedKey}`,
      version: 3,
      updatedBy: "editor-1",
    });
    expect((await db.collection("media_assets_public").doc("asset-one").get()).data())
      .toEqual(mediaProjection(record));
    expect((await db.collection("system").doc("media").collection("hashOwners").doc(OLD_HASH).get()).data())
      .toMatchObject({
        state: "committed",
        assetId: "asset-one",
        finalKey: before.storageKey,
        supersededByContentHash: NEW_HASH,
      });
    expect((await db.collection("system").doc("media").collection("hashOwners").doc(NEW_HASH).get()).data())
      .toMatchObject({
        state: "committed",
        operation: "replacement",
        assetId: "asset-one",
        finalKey: expectedKey,
        previousContentHash: OLD_HASH,
        previousFinalKey: before.storageKey,
        committedVersion: 3,
      });
    expect((await db.collection("system").doc("media").collection("replacements").doc("asset-one").get()).exists)
      .toBe(false);
    expect(storage.objects.has(before.storageKey)).toBe(false);
    expect(storage.objects.has(expectedKey)).toBe(true);
    expect(await documents("admin_logs")).toEqual([
      expect.objectContaining({
        action: "media.binary.replace",
        target: "media_assets/asset-one",
        before: expect.objectContaining({ contentHash: OLD_HASH, version: 2 }),
        after: expect.objectContaining({ contentHash: NEW_HASH, version: 3 }),
      }),
    ]);
  });

  it("keeps metadata and queues the exact prior keys for 30 days without a stale master", async () => {
    const before = stored({
      categories: ["news"], focalPoint: { x: 0.3, y: 0.7 },
      master: { key: "masters/aa/old.png", contentHash: OLD_HASH, retained: true },
      thumbnails: [{ storageKey: "cms-media/news/asset-one/thumbs/old.webp" }],
    });
    await seedAsset(before);
    await db.collection("cmsPages/home/mediaUsage").doc("working").set({ state: "working", assetIds: [before.id] });
    expect((await invoke(handler().run)).statusCode).toBe(200);
    const after = (await db.collection("media_assets").doc(before.id).get()).data();
    for (const field of ["id", "name", "altText", "description", "credit", "license", "tags", "category", "categories", "focalPoint"]) {
      expect(after[field]).toEqual(before[field]);
    }
    expect(after.master).toBeNull();
    const purgeEntryId = `version:${before.id}:${OLD_HASH}`;
    expect((await db.collection("mediaPurgeQueue").doc(purgeEntryId).get()).data()).toMatchObject({
      reason: "superseded", state: "pending", queuedAt: "2026-08-14T12:00:00.000Z",
      eligibleAt: "2026-09-13T12:00:00.000Z", masterKey: before.master.key,
      objects: [{ store: "public", key: before.storageKey },
        { store: "public", key: before.thumbnails[0].storageKey },
        { store: "masters", key: before.master.key }],
    });
    expect((await documents("admin_logs"))[0]).toMatchObject({
      before: { master: before.master }, after: { master: null, purgeEntryId },
    });
  });

  it("refuses a purging master lock before a replacement stores the original", async () => {
    await seedAsset();
    const buffer = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer();
    const hash = createHash("sha256").update(buffer).digest("hex");
    await db.doc(`system/media/masterLocks/${hash}`).set({ state: "purging" });
    const putIfAbsent = vi.fn();
    const res = await invoke(handler({
      upload: { buffer, mimeType: "image/png", originalName: "new.png", fields: { imageProcessing: "webp" } },
      masterStorageFactory: () => ({ putIfAbsent }),
    }).run);
    expect(res.statusCode).toBe(503);
    expect(res.body.retryable).toBe(true);
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect((await db.collection("media_assets").doc("asset-one").get()).data().version).toBe(2);
  });

  it("uses the upload WebP pipeline and retains the new original master", async () => {
    await seedAsset();
    const buffer = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer();
    const putIfAbsent = vi.fn(async ({ key }) => {
      const claims = await db.collection("system/media/hashOwners")
        .where("state", "==", "reserved").get();
      expect(claims.size).toBe(1);
      expect(claims.docs[0].data().recordSeed.master).toMatchObject({ key, retained: false, reason: "pending" });
    });
    const res = await invoke(handler({
      upload: { buffer, mimeType: "image/png", originalName: "new.png", fields: { imageProcessing: "webp" } },
      masterStorageFactory: () => ({ putIfAbsent }),
    }).run);
    expect(res.statusCode).toBe(200);
    const after = (await db.collection("media_assets").doc("asset-one").get()).data();
    expect(after.mimeType).toBe("image/webp");
    expect(after.master).toMatchObject({ retained: true, mimeType: "image/png", contentHash: createHash("sha256").update(buffer).digest("hex") });
    expect(putIfAbsent).toHaveBeenCalledOnce();
    expect(putIfAbsent.mock.calls[0][0].body).toEqual(buffer);
  });

  it.each([false, true])("preserves the original retention result through replacement recovery (stored: %s)", async (retained) => {
    await seedAsset();
    const buffer = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer();
    const upload = { buffer, mimeType: "image/png", originalName: "new.png", fields: { imageProcessing: "webp" } };
    const storage = memoryStorage({ failFinal: true });
    const putIfAbsent = vi.fn(async () => { if (!retained) throw new Error("Private store unavailable"); });
    expect((await invoke(handler({ upload, storage,
      masterStorageFactory: () => ({ putIfAbsent }) }).run)).statusCode).toBe(503);
    const claim = (await db.doc("system/media/replacements/asset-one").get()).data();
    expect(claim.recordSeed.master).toMatchObject(retained
      ? { retained: true } : { retained: false, reason: "store-failed" });
    const owner = (await db.doc(`system/media/hashOwners/${claim.contentHash}`).get()).data();
    expect(owner.recordSeed.master).toEqual(claim.recordSeed.master);
    storage.setFailFinal(false);
    const retryPut = vi.fn();
    expect((await invoke(handler({ upload, storage,
      now: () => new Date("2026-08-14T12:16:00.000Z"),
      masterStorageFactory: () => retained ? null : { putIfAbsent: retryPut },
    }).run)).statusCode).toBe(200);
    expect((await db.doc("media_assets/asset-one").get()).data().master.retained).toBe(true);
    expect(retryPut).toHaveBeenCalledTimes(retained ? 0 : 1);
  });

  it("reuses a superseded version and cancels its pending purge without rewriting its object", async () => {
    await seedAsset();
    const storage = memoryStorage();
    expect((await invoke(handler({ storage }).run)).statusCode).toBe(200);
    const second = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
    expect((await invoke(handler({ storage, mintId: () => "second", upload: { buffer: second, mimeType: "image/png", originalName: "second.png" } }).run,
      makeReq({ etag: formatMediaEtag("asset-one", 3) }))).statusCode).toBe(200);
    const third = await sharp({ create: { width: 3, height: 2, channels: 3, background: "green" } }).png().toBuffer();
    expect((await invoke(handler({ storage, mintId: () => "third", upload: { buffer: third, mimeType: "image/png", originalName: "third.png" } }).run,
      makeReq({ etag: formatMediaEtag("asset-one", 4) }))).statusCode).toBe(200);
    expect((await invoke(handler({ storage, mintId: () => "fourth" }).run,
      makeReq({ etag: formatMediaEtag("asset-one", 5) }))).statusCode).toBe(200);
    expect((await db.collection("mediaPurgeQueue").doc(`version:asset-one:${NEW_HASH}`).get()).data().state).toBe("cancelled");
    expect((await db.doc(`system/media/hashOwners/${NEW_HASH}/superseded/replace-attempt-one`).get()).exists).toBe(true);
  });

  it("refuses a purging historical version before writing storage", async () => {
    await seedAsset();
    await db.collection("mediaPurgeQueue").doc(`version:asset-one:${NEW_HASH}`).set({ state: "purging" });
    const { run, storage } = handler();
    const res = await invoke(run);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/being purged/);
    expect(storage.writes).toHaveLength(0);
    expect((await db.doc("system/media/replacements/asset-one").get()).exists).toBe(false);
  });

  it.each(["contributor", "viewer"])("refuses the %s role before storage", async (role) => {
    await seedAsset();
    const { run, storage } = handler({ principal: actor([{ role, sections: ["news"], registeredMediaSections: ["news"] }]) });
    expect((await invoke(run)).statusCode).toBe(404);
    expect(storage.writes).toHaveLength(0);
  });

  it("writes thumbnails for the replacement hash", async () => {
    await seedAsset();
    const buffer = await sharp({
      create: { width: 2, height: 3, channels: 3, background: "blue" },
    }).png().toBuffer();
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const { run, storage } = handler({
      upload: { originalName: "new.png", mimeType: "image/png", buffer },
    });
    const res = await invoke(run);
    expect(res.statusCode).toBe(200);
    const asset = (await db.collection("media_assets").doc("asset-one").get()).data();
    expect(asset.thumbnails).toMatchObject([{
      width: 2,
      height: 3,
      storageKey: expect.stringContaining(`${contentHash}-w2.webp`),
    }]);
    expect(storage.objects.has(asset.thumbnails[0].storageKey)).toBe(true);
    expect(res.body.asset.thumbnails).toMatchObject([{
      width: 2,
      height: 3,
      url: expect.stringContaining(`${contentHash}-w2.webp`),
    }]);
  });

  it("denies a Viewer for absent and existing assets before R2", async () => {
    await seedAsset();
    const forbiddenStorage = memoryStorage();
    const forbidden = await invoke(handler({
      principal: actor([{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      storage: forbiddenStorage,
    }).run);
    const absentStorage = memoryStorage();
    const absent = await invoke(
      handler({ storage: absentStorage, principal: actor([{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]) }).run,
      makeReq({ assetId: "missing", etag: formatMediaEtag("missing", 2) }),
    );

    expect(forbidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(forbidden.body).toEqual(absent.body);
    expect(forbiddenStorage.writes).toHaveLength(0);
    expect(absentStorage.writes).toHaveLength(0);
  });

  it("requires the exact strong asset ETag before any object write", async () => {
    await seedAsset();
    const storage = memoryStorage();

    const missing = await invoke(
      handler({ storage }).run,
      makeReq({ includeEtag: false }),
    );
    const stale = await invoke(
      handler({ storage }).run,
      makeReq({ etag: formatMediaEtag("asset-one", 1) }),
    );

    expect(missing.statusCode).toBe(428);
    expect(stale.statusCode).toBe(412);
    expect(stale.headers.get("etag")).toBe(formatMediaEtag("asset-one", 2));
    expect(storage.writes).toHaveLength(0);
  });

  it("writes nothing when the verified bytes are already current", async () => {
    const current = stored({
      originalName: "studio-new.png",
      sizeBytes: PNG.length,
      width: 1,
      height: 1,
      contentHash: NEW_HASH,
      storageKey: finalObjectKey({
        category: "news",
        assetId: "asset-one",
        contentHash: NEW_HASH,
        mimeType: "image/png",
      }),
    });
    current.url = `https://media.njpbs.org/${current.storageKey}`;
    await seedAsset(current);
    const storage = memoryStorage();

    const res = await invoke(handler({ storage }).run);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, changed: false, asset: { version: 2 } });
    expect(storage.writes).toHaveLength(0);
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it("refuses site-seed or published assets because no safe deployment trigger exists", async () => {
    await seedAsset(stored({ source: "site_seed" }));
    const seededStorage = memoryStorage();
    const seeded = await invoke(handler({ storage: seededStorage }).run);
    expect(seeded.statusCode).toBe(409);
    expect(seededStorage.writes).toHaveLength(0);

    await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    await seedAsset();
    await db.collection("cmsPages/home/mediaUsage").doc("published").set({
      state: "published",
      sourceVersion: 4,
      assetIds: ["asset-one"],
      occurrenceCount: 1,
    });
    const publishedStorage = memoryStorage();
    const published = await invoke(handler({ storage: publishedStorage }).run);
    expect(published.statusCode).toBe(409);
    expect(publishedStorage.writes).toHaveLength(0);
  });

  it("keeps a working image reference from being replaced with a document", async () => {
    await seedAsset();
    await db.collection("cmsPages/home/mediaUsage").doc("working").set({
      state: "working",
      sourceVersion: 4,
      assetIds: ["asset-one"],
      occurrenceCount: 1,
    });
    const storage = memoryStorage();

    const res = await invoke(handler({
      storage,
      upload: {
        originalName: "studio-new.pdf",
        mimeType: "application/pdf",
        buffer: PDF,
      },
      inspectUploadFn: async () => ({ width: null, height: null }),
    }).run);

    expect(res.statusCode).toBe(400);
    expect(storage.writes).toHaveLength(0);
  });

  it("ignores deployed use from a generation that is no longer active", async () => {
    await seedAsset();
    await Promise.all([
      seedActiveDeployment(8),
      db.collection("cmsPages/home/mediaUsage").doc("deployed-7").set({
        state: "deployed",
        generation: 7,
        assetIds: ["asset-one"],
        occurrenceCount: 1,
      }),
    ]);

    const res = await invoke(handler().run);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, changed: true });
  });

  it("fails closed before R2 when the current public projection is not exact", async () => {
    await seedAsset();
    await db.collection("media_assets_public").doc("asset-one").update({
      url: "https://media.njpbs.org/tampered.png",
    });
    const storage = memoryStorage();

    const res = await invoke(handler({ storage }).run);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/operator recovery/i);
    expect(storage.writes).toHaveLength(0);
  });

  it("refuses bytes already owned by a different asset without exposing R2", async () => {
    await seedAsset();
    await db.collection("system").doc("media").collection("hashOwners").doc(NEW_HASH).set({
      state: "committed",
      operation: "upload",
      assetId: "asset-two",
      category: "arts",
      finalKey: "cms-media/arts/asset-two/owned.png",
    });
    const storage = memoryStorage();

    const res = await invoke(handler({ storage }).run);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "This file is already in the media library.", duplicateAssetId: "asset-two" });
    expect(storage.writes).toHaveLength(0);
  });

  it.each(["active", "tombstoned"])("discloses a duplicate %s image to a media holder", async (lifecycle) => {
    await seedAsset();
    await db.doc(`system/media/hashOwners/${NEW_HASH}`).set({
      state: "committed", assetId: "asset-two", category: "news",
    });
    await db.collection("media_assets").doc("asset-two").set({ ...stored(), id: "asset-two", lifecycle });
    const res = await invoke(handler().run);
    expect(res.statusCode).toBe(409);
    expect(res.body.duplicateAssetId).toBe("asset-two");
  });

  it("refuses document-to-image replacement even without usage", async () => {
    await seedAsset(stored({ kind: "document", mimeType: "application/pdf" }));
    const { run, storage } = handler();
    expect((await invoke(run)).statusCode).toBe(400);
    expect(storage.writes).toHaveLength(0);
  });

  it("retains a lease-backed receipt when R2 is unclear and resumes the exact attempt after expiry", async () => {
    await seedAsset();
    const storage = memoryStorage({ failFinal: true });
    const first = await invoke(handler({ storage }).run);

    expect(first.statusCode).toBe(503);
    const ownerRef = db.collection("system").doc("media").collection("hashOwners").doc(NEW_HASH);
    const claimRef = db.collection("system").doc("media").collection("replacements").doc("asset-one");
    expect((await ownerRef.get()).data()).toMatchObject({
      state: "reserved",
      operation: "replacement",
      attemptId: "replace-attempt-one",
    });
    expect((await claimRef.get()).data()).toMatchObject({
      state: "reserved",
      attemptId: "replace-attempt-one",
    });

    storage.setFailFinal(false);
    const resumed = await invoke(handler({
      storage,
      now: () => new Date("2026-08-14T12:16:00.000Z"),
    }).run);

    expect(resumed.statusCode).toBe(200);
    expect((await ownerRef.get()).data()).toMatchObject({
      state: "committed",
      attemptId: "replace-attempt-one",
      recoveryCount: 1,
    });
    expect((await claimRef.get()).exists).toBe(false);
  });

  it("blocks a retry during the live recovery lease before another R2 write", async () => {
    await seedAsset();
    const storage = memoryStorage({ failFinal: true });
    const first = await invoke(handler({ storage }).run);
    expect(first.statusCode).toBe(503);
    const writesBeforeRetry = storage.writes.length;

    const retry = await invoke(handler({
      storage,
      mintId: () => "replace-attempt-two",
    }).run);

    expect(retry.statusCode).toBe(409);
    expect(retry.body).toMatchObject({
      retryable: true,
      attemptId: "replace-attempt-one",
    });
    expect(storage.writes).toHaveLength(writesBeforeRetry);
  });

  it.each(["deployed", "published"])("rechecks %s use before committing a replacement", async (state) => {
    await seedAsset();
    const racingCommit = vi.fn(async (options) => {
      await Promise.all([
        seedActiveDeployment(7),
        db.collection("cmsPages/home/mediaUsage").doc("deployed-7").set({
          state,
          generation: 7,
          assetIds: ["asset-one"],
          occurrenceCount: 1,
        }),
      ]);
      await commitReplacement(options);
    });

    const res = await invoke(handler({ commitReplacementFn: racingCommit }).run);

    expect(res.statusCode).toBe(503);
    expect(racingCommit).toHaveBeenCalledOnce();
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ contentHash: OLD_HASH, version: 2 });
  });

  async function seedUnpublishedPhoto(before) {
    const profileRef = db.collection("cmsAuthorProfiles").doc("author-one");
    await profileRef.set({ visibility: "private", lifecycle: "active", photo: { assetId: before.id, url: before.url } });
    await profileRef.collection("mediaUsage").doc("working").set({
      state: "working", assetIds: [before.id], occurrenceCount: 1,
    });
  }

  it("refuses replacement while an unpublished author profile retains the photo", async () => {
    const before = stored({ width: 800, height: 800 });
    await seedAsset(before);
    await seedUnpublishedPhoto(before);
    const { run, storage } = handler();

    const res = await invoke(run);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/author profile/);
    expect(storage.writes).toEqual([]);
    expect((await db.doc("media_assets/asset-one").get()).data()).toEqual(before);
  });

  it("allows replacement when the photo belongs only to a permanently archived profile", async () => {
    const before = stored({ width: 800, height: 800 });
    await seedAsset(before);
    await seedUnpublishedPhoto(before);
    await db.doc("cmsAuthorProfiles/author-one").update({ lifecycle: "archived" });

    const res = await invoke(handler().run);

    expect(res.statusCode).toBe(200);
    expect((await db.doc("media_assets/asset-one").get()).data()).toMatchObject({
      contentHash: NEW_HASH, version: 3,
    });
    expect((await db.doc("cmsAuthorProfiles/author-one").get()).data().lifecycle).toBe("archived");
  });

  it("rechecks an unpublished author photo attached after replacement reservation", async () => {
    const before = stored({ width: 800, height: 800 });
    await seedAsset(before);
    const { run } = handler({ commitReplacementFn: async options => {
      await seedUnpublishedPhoto(before);
      await commitReplacement(options);
    } });

    const res = await invoke(run);

    // Once immutable bytes were written, a rejected commit uses the existing
    // recovery response rather than the pre-reservation conflict response.
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ retryable: true, attemptId: "replace-attempt-one" });
    expect((await db.doc("media_assets/asset-one").get()).data()).toEqual(before);
    expect((await db.doc("cmsAuthorProfiles/author-one").get()).data().photo.url).toBe(before.url);
    expect(await documents("mediaPurgeQueue")).toHaveLength(0);
  });

  it("returns the proposed attempt after an ambiguous reservation commit", async () => {
    await seedAsset();
    const ambiguousReservation = vi.fn(async (options) => {
      await reserveReplacement(options);
      throw new Error("Firestore response lost");
    });
    const storage = memoryStorage();
    const run = createCmsReplaceMediaBinaryHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      parseUploadFn: async () => ({
        originalName: "studio-new.png",
        mimeType: "image/png",
        buffer: PNG,
        fields: { assetId: "asset-one" },
      }),
      storageFactory: () => storage,
      mintId: () => "replace-attempt-one",
      now: () => new Date("2026-08-14T12:00:00.000Z"),
      maxUploadBytes: 25 * 1024 * 1024,
      publicOrigin: "https://media.njpbs.org",
      reserveReplacementFn: ambiguousReservation,
      log: { error: vi.fn(), warn: vi.fn() },
    });

    const res = await invoke(run);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "The media replacement needs recovery before it can be retried",
      retryable: true,
      attemptId: "replace-attempt-one",
    });
    expect(storage.writes).toHaveLength(0);
    expect((await db.collection("system").doc("media").collection("replacements").doc("asset-one").get()).data())
      .toMatchObject({ attemptId: "replace-attempt-one", state: "reserved" });
  });

  it("confirms an ambiguous Firestore commit from exact records instead of writing twice", async () => {
    await seedAsset();
    const ambiguousCommit = vi.fn(async (options) => {
      await commitReplacement(options);
      throw new Error("Firestore response lost");
    });

    const res = await invoke(handler({ commitReplacementFn: ambiguousCommit }).run);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, changed: true, asset: { version: 3 } });
    expect(ambiguousCommit).toHaveBeenCalledOnce();
    expect(await documents("admin_logs")).toHaveLength(1);
  });

  it("confirms an exact retry after the success response is lost", async () => {
    await seedAsset();
    const storage = memoryStorage();
    const first = await invoke(handler({ storage }).run);
    expect(first.statusCode).toBe(200);
    const writesAfterCommit = storage.writes.length;

    const retry = await invoke(handler({ storage }).run);

    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({
      success: true,
      changed: false,
      asset: { id: "asset-one", version: 3 },
    });
    expect(retry.headers.get("etag")).toBe(formatMediaEtag("asset-one", 3));
    expect(storage.writes).toHaveLength(writesAfterCommit);
    expect(await documents("admin_logs")).toHaveLength(1);
  });

  it.each(["lost response", "expired lease"])(
    "binds optimized recovery to the original master after a %s",
    async (failure) => {
      await seedAsset();
      const original = await sharp({
        create: { width: 4, height: 3, channels: 3, background: "red" },
      }).png().toBuffer();
      const different = await sharp(original).withMetadata({ density: 144 }).png().toBuffer();
      expect(different).not.toEqual(original);
      const processOriginal = (buffer) => media.processUploadImage(
        buffer, "image/png", "webp", { width: 4, height: 3 },
      );
      const processed = await processOriginal(original);
      expect((await processOriginal(different)).buffer).toEqual(processed.buffer);

      const storage = memoryStorage({ failFinal: failure === "expired lease" });
      const masterStorageFactory = () => ({ putIfAbsent: vi.fn() });
      const options = (buffer, retry = false) => ({
        storage,
        masterStorageFactory,
        upload: {
          buffer, mimeType: "image/png", originalName: "new.png",
          fields: { imageProcessing: "webp" },
        },
        ...(retry ? { now: () => new Date("2026-08-14T12:16:00.000Z") } : {}),
      });
      const first = await invoke(handler(options(original)).run);
      expect(first.statusCode).toBe(failure === "lost response" ? 200 : 503);
      const assetRef = db.doc("media_assets/asset-one");
      const claimRef = db.doc("system/media/replacements/asset-one");
      const before = (await assetRef.get()).data();
      const claimBefore = (await claimRef.get()).data();
      const master = failure === "lost response" ? before.master : claimBefore.recordSeed.master;
      expect(master).toMatchObject({
        retained: true, contentHash: createHash("sha256").update(original).digest("hex"),
      });
      const writesBefore = storage.writes.length;
      storage.setFailFinal(false);

      const refused = await invoke(handler(options(different, true)).run);
      expect(refused.statusCode).toBe(failure === "lost response" ? 412 : 503);
      expect(refused.body.success).toBeUndefined();
      expect((await assetRef.get()).data()).toEqual(before);
      expect((await claimRef.get()).data()).toEqual(claimBefore);
      expect(storage.writes).toHaveLength(writesBefore);

      const exact = await invoke(handler(options(original, true)).run);
      expect(exact.statusCode).toBe(200);
      expect(exact.body).toMatchObject({
        success: true, changed: failure === "expired lease", asset: { version: 3 },
      });
      expect((await assetRef.get()).data().master).toEqual(master);
      expect((await claimRef.get()).exists).toBe(false);
      expect(await documents("admin_logs")).toHaveLength(1);
    },
  );

  it("keeps a committed staging cleanup retryable after a transient deletion failure", async () => {
    await seedAsset();
    const storage = memoryStorage({ failDeleteStaging: true });

    const first = await invoke(handler({ storage }).run);

    expect(first.statusCode).toBe(200);
    expect(storage.objects.has("cms-media-staging/replace-attempt-one")).toBe(true);
    const ownerRef = db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc(NEW_HASH);
    expect((await ownerRef.get()).data()).toMatchObject({
      stagingCleanupPending: true,
    });

    storage.setFailDeleteStaging(false);
    const retry = await invoke(handler({ storage }).run);

    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({ success: true, changed: false });
    expect(storage.objects.has("cms-media-staging/replace-attempt-one")).toBe(false);
    expect((await ownerRef.get()).data()).not.toHaveProperty(
      "stagingCleanupPending",
    );
  });
});
