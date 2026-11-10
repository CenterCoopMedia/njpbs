import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import mediaFavorites from "../../functions/media-favorites.js";
import mediaAssetResolver from "../../functions/lib/media-asset-resolver.js";
import favoriteContract from "../../functions/lib/media-favorites.js";
import mediaSources from "../../functions/lib/media-sources.js";

const {
  createCmsListMediaFavoritesHandler,
  createCmsSetMediaFavoriteHandler,
  createCmsSetMediaFavoritesHandler,
  readFavoritePage,
  readFavoriteProjection,
  resolveFavoriteRecords,
  writeFavoriteState,
} = mediaFavorites;
const { resolveMediaAssets } = mediaAssetResolver;
const {
  canonicalFavoriteRef,
  decodeFavoriteCursor,
  favoriteDocumentId,
  parseFavoriteRef,
  parseListFavoritesRequest,
} = favoriteContract;
const { authorizeMediaSource } = mediaSources;

function request(body = {}, headers = {}) {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function response() {
  const res = { statusCode: null, body: null, headersSent: false, headers: new Map() };
  res.set = (name, value) => { res.headers.set(name.toLowerCase(), value); return res; };
  res.status = (statusCode) => { res.statusCode = statusCode; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  return res;
}

function actor(uid = "staff-1", grants = [{ role: "super_admin" }], overrides = {}) {
  return {
    uid,
    emailVerified: true,
    principal: { id: uid, grants },
    ...overrides,
  };
}

function timestamp(iso = "2026-09-22T17:00:00.000Z") {
  const date = new Date(iso);
  return {
    seconds: Math.floor(date.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => date,
  };
}

function storedR2(overrides = {}) {
  return {
    name: "Favorite image",
    originalName: "favorite.png",
    category: "news",
    categories: ["news"],
    tags: [],
    description: null,
    altText: "Favorite",
    license: "Station owned",
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 10,
    height: 10,
    url: "https://media.njpbs.org/cms-media/news/favorite.png",
    source: "upload",
    lifecycle: "active",
    version: 3,
    createdAt: "2026-09-20T12:00:00.000Z",
    createdBy: "staff-1",
    updatedAt: "2026-09-21T12:00:00.000Z",
    updatedBy: "staff-1",
    ...overrides,
  };
}

const VOICEOVER_TAKE_ID = "soft-spoken-watching-station-01";
const VOICEOVER_ASSET_ID = `voiceover-${VOICEOVER_TAKE_ID}`;
const VOICEOVER_FLAGS = ["alternate-read", "producer-review"];

function storedVoiceover(overrides = {}) {
  return storedR2({
    name: "Watching station, soft spoken, take 1",
    originalName: `${VOICEOVER_TAKE_ID}.wav`,
    description: "Private station voiceover",
    altText: null,
    mimeType: "audio/wav",
    kind: "audio",
    sizeBytes: 48_256,
    width: null,
    height: null,
    url: `https://admin.njpbs.org/media/voiceovers?asset=${VOICEOVER_ASSET_ID}`,
    source: "voiceover",
    voiceoverTakeId: VOICEOVER_TAKE_ID,
    voiceover: {
      manifestVersion: 1,
      id: VOICEOVER_TAKE_ID,
      family_id: "watching-station",
      family: "Watching station",
      take: 1,
      style: "soft-spoken",
      performer_id: "jules-avery",
      performer_name: "Jules Avery",
      text: "You're watching NJ PBS.",
      display_text: "You're watching NJ PBS.",
      complete: true,
      flags: VOICEOVER_FLAGS,
      duration_seconds: 2.058,
    },
    storageKey: `takes/v1/${VOICEOVER_TAKE_ID}.wav`,
    contentHash: "a".repeat(64),
    ...overrides,
  });
}

function storedS3(overrides = {}) {
  return {
    sourceId: "video-library",
    lifecycle: "active",
    name: "Favorite video",
    originalName: "favorite.mp4",
    description: null,
    nameSort: "favorite video",
    updatedAtSort: "2026-09-21T12:00:00.000Z",
    mimeType: "video/mp4",
    kind: "video",
    sizeBytes: 1024,
    preview: "browser",
    rightsStatus: "complete",
    license: "Station owned",
    credit: null,
    tags: [],
    version: 2,
    createdBy: "staff-1",
    createdAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-21T12:00:00.000Z",
    objectKey: "favorite.mp4",
    objectVersionId: "private-version",
    ...overrides,
  };
}

function source() {
  return {
    id: "video-library",
    prefix: "",
  };
}

describe("media favorite contract", () => {
  it("keeps equal ids distinct across backends and sources", () => {
    const refs = [
      { backend: "r2", id: "same-id" },
      { backend: "s3", sourceId: "video-library", id: "same-id" },
      { backend: "s3", sourceId: "archive-working", id: "same-id" },
    ];
    expect(new Set(refs.map(canonicalFavoriteRef)).size).toBe(3);
    expect(new Set(refs.map(favoriteDocumentId)).size).toBe(3);
  });

  it("rejects storage fields and directs legacy voiceover refs to canonical R2 audio", () => {
    expect(() => parseFavoriteRef({ backend: "r2", id: "asset-1", storageKey: "secret" }))
      .toThrow(/Unknown asset reference field/);
    expect(() => parseFavoriteRef({ backend: "voiceover", id: "take-1" }))
      .toThrow(/canonical R2 audio asset reference/);
  });

  it("binds list cursors to the authenticated owner", () => {
    const encoded = Buffer.from(JSON.stringify({
      v: 1,
      uid: "staff-1",
      seconds: 1_795_000_000,
      nanoseconds: 123,
      id: "a".repeat(64),
    })).toString("base64url");
    expect(decodeFavoriteCursor(encoded, "staff-1")).toMatchObject({
      seconds: 1_795_000_000,
      nanoseconds: 123,
    });
    expect(() => parseListFavoritesRequest({ cursor: encoded }, "staff-2"))
      .toThrow(/Cursor is invalid/);
  });

  it("rejects cursor timestamps outside the Firestore range", () => {
    const encoded = Buffer.from(JSON.stringify({
      v: 1,
      uid: "staff-1",
      seconds: Number.MAX_SAFE_INTEGER,
      nanoseconds: 0,
      id: "a".repeat(64),
    })).toString("base64url");
    expect(() => parseListFavoritesRequest({ cursor: encoded }, "staff-1"))
      .toThrow(/Cursor is invalid/);
  });

  it("bounds one page to 30 and one state projection to 100 refs", () => {
    expect(() => parseListFavoritesRequest({ limit: 31 }, "staff-1")).toThrow();
    expect(() => parseListFavoritesRequest({
      refs: Array.from({ length: 101 }, (_, index) => ({
        backend: "r2",
        id: `asset-${index}`,
      })),
    }, "staff-1")).toThrow(/too many/);
  });
});

describe("batch media favorites", () => {
  const refs = [
    { backend: "r2", id: "asset-1" },
    { backend: "r2", id: "asset-2" },
  ];

  function setup() {
    const documents = new Map();
    const assetGet = vi.fn(async (id) => ({
      id, exists: true, data: () => storedR2(),
    }));
    const firestore = {
      collection: (name) => {
        if (name === "media_assets") {
          return { doc: (id) => ({ get: () => assetGet(id) }) };
        }
        expect(name).toBe("mediaFavorites");
        return {
          doc: (uid) => ({
            collection: (items) => {
              expect(items).toBe("items");
              return { doc: (id) => ({ path: `${uid}/${id}` }) };
            },
          }),
        };
      },
      runTransaction: vi.fn(async (callback) => callback({
        get: async (ref) => ({
          exists: documents.has(ref.path),
          data: () => documents.get(ref.path),
        }),
        create: (ref, value) => documents.set(ref.path, value),
        delete: (ref) => documents.delete(ref.path),
      })),
    };
    const requirePrincipalFn = vi.fn(async () =>
      actor("staff-1", [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]));
    const isActiveFn = vi.fn(async () => true);
    const verifyAppCheckFn = vi.fn(async () => true);
    const serverTimestampFn = vi.fn(() => timestamp());
    const handler = createCmsSetMediaFavoritesHandler({
      firestore, requirePrincipalFn, isActiveFn, verifyAppCheckFn, serverTimestampFn,
    });
    return {
      handler, firestore, documents, assetGet,
      requirePrincipalFn, isActiveFn, verifyAppCheckFn, serverTimestampFn,
    };
  }

  it("accepts 100 refs and checks App Check and the actor once", async () => {
    const context = setup();
    const batch = Array.from({ length: 100 }, (_, index) => ({
      backend: "r2", id: `asset-${index}`,
    }));
    const res = response();
    await context.handler(request({ refs: batch, favorite: true }, {
      "x-firebase-appcheck": "app-check-token",
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true, favorite: true,
      results: batch.map((ref) => ({ ref, favorite: true, changed: true })),
    });
    expect(context.documents.size).toBe(100);
    expect(context.verifyAppCheckFn).toHaveBeenCalledExactlyOnceWith("app-check-token");
    expect(context.requirePrincipalFn).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), { includeAccountStatus: true },
    );
    expect(context.isActiveFn).toHaveBeenCalledExactlyOnceWith(context.firestore, "staff-1");
  });

  it.each([
    ["over 100 refs", { refs: Array.from({ length: 101 }, (_, i) => ({ backend: "r2", id: `asset-${i}` })), favorite: true }],
    ["empty refs", { refs: [], favorite: true }],
    ["non-array refs", { refs: {}, favorite: true }],
    ["missing refs", { favorite: true }],
    ["missing favorite", { refs }],
    ["non-boolean favorite", { refs, favorite: "true" }],
    ["unknown fields", { refs, favorite: true, uid: "staff-2" }],
    ["duplicate refs", { refs: [refs[0], { ...refs[0] }], favorite: true }],
    ["malformed later ref", { refs: [refs[0], { ...refs[1], storageKey: "private" }], favorite: true }],
  ])("rejects %s before authentication or writes", async (_label, body) => {
    const context = setup();
    const res = response();
    await context.handler(request(body), res);
    expect(res.statusCode).toBe(400);
    expect(context.verifyAppCheckFn).not.toHaveBeenCalled();
    expect(context.requirePrincipalFn).not.toHaveBeenCalled();
    expect(context.firestore.runTransaction).not.toHaveBeenCalled();
    expect(context.assetGet).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects voiceover refs for favorite=%s before any write", async (favorite) => {
    const context = setup();
    const res = response();
    await context.handler(request({
      refs: [refs[0], { backend: "voiceover", id: "take-1" }], favorite,
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/canonical R2 audio asset reference/);
    expect(context.firestore.runTransaction).not.toHaveBeenCalled();
  });

  it("sets and clears idempotently, preserves another account, and clears unavailable assets", async () => {
    const context = setup();
    const otherPath = `staff-2/${favoriteDocumentId(refs[0])}`;
    const otherFavorite = { ref: refs[0], canonicalRef: canonicalFavoriteRef(refs[0]), createdAt: timestamp() };
    context.documents.set(otherPath, otherFavorite);
    for (const [favorite, changed] of [[true, true], [true, false], [false, true], [false, false]]) {
      if (!favorite) {
        context.assetGet.mockClear();
        context.assetGet.mockRejectedValue(new Error("Asset no longer available"));
      }
      const res = response();
      await context.handler(request({ refs, favorite }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true, favorite,
        results: refs.map((ref) => ({ ref, favorite, changed })),
      });
      expect(context.documents.get(otherPath)).toBe(otherFavorite);
      expect(context.documents.size).toBe(favorite ? 3 : 1);
      if (!favorite) expect(context.assetGet).not.toHaveBeenCalled();
    }
    expect(context.serverTimestampFn).toHaveBeenCalledTimes(2);
  });

  it("returns no metadata for a denied ref while another ref commits in request order", async () => {
    const context = setup();
    context.assetGet.mockImplementation(async (id) => ({
      id, exists: true,
      data: () => storedR2(id === refs[0].id ? { lifecycle: "deleted" } : {}),
    }));
    const res = response();
    await context.handler(request({ refs, favorite: true }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true, favorite: true,
      results: [
        { ref: refs[0], error: "Media asset is unavailable", status: 404 },
        { ref: refs[1], favorite: true, changed: true },
      ],
    });
    expect([...context.documents.keys()]).toEqual([`staff-1/${favoriteDocumentId(refs[1])}`]);
    expect(context.firestore.runTransaction).toHaveBeenCalledOnce();
  });

  it("refuses inactive accounts before any asset access or write", async () => {
    const context = setup();
    context.isActiveFn.mockResolvedValue(false);
    const res = response();
    await context.handler(request({ refs, favorite: true }), res);
    expect(res.statusCode).toBe(403);
    expect(context.assetGet).not.toHaveBeenCalled();
    expect(context.firestore.runTransaction).not.toHaveBeenCalled();
  });
});

describe("media favorite persistence", () => {
  it("sets and unsets an explicit state idempotently without changing createdAt", async () => {
    const documents = new Map();
    const firestore = {
      collection: () => ({
        doc: (uid) => ({
          collection: () => ({
            doc: (id) => ({ id, path: `mediaFavorites/${uid}/items/${id}` }),
          }),
        }),
      }),
      runTransaction: async (callback) => callback({
        get: async (ref) => ({
          exists: documents.has(ref.path),
          data: () => documents.get(ref.path),
        }),
        create: (ref, value) => documents.set(ref.path, value),
        delete: (ref) => documents.delete(ref.path),
      }),
    };
    const ref = { backend: "r2", id: "asset-1" };
    const firstTimestamp = { marker: "first" };
    const secondTimestamp = { marker: "second" };

    await expect(writeFavoriteState(
      firestore, "staff-1", ref, true, () => firstTimestamp,
    )).resolves.toBe(true);
    await expect(writeFavoriteState(
      firestore, "staff-1", ref, true, () => secondTimestamp,
    )).resolves.toBe(false);
    expect([...documents.values()][0].createdAt).toBe(firstTimestamp);
    await expect(writeFavoriteState(
      firestore, "staff-1", ref, false, () => secondTimestamp,
    )).resolves.toBe(true);
    await expect(writeFavoriteState(
      firestore, "staff-1", ref, false, () => secondTimestamp,
    )).resolves.toBe(false);
  });

  it("reads a bounded state projection with one batched Firestore call", async () => {
    const refs = [
      { backend: "r2", id: "asset-1" },
      { backend: "s3", sourceId: "video-library", id: "video-1" },
    ];
    const getAll = vi.fn(async (...documents) => documents.map((document, index) => ({
      exists: index === 0,
      data: () => index === 0 ? {
        ref: refs[0],
        canonicalRef: canonicalFavoriteRef(refs[0]),
      } : null,
    })));
    const firestore = {
      getAll,
      collection: () => ({
        doc: () => ({
          collection: () => ({ doc: (id) => ({ id }) }),
        }),
      }),
    };

    await expect(readFavoriteProjection(firestore, "staff-1", refs)).resolves.toEqual([
      { ref: refs[0], favorite: true },
      { ref: refs[1], favorite: false },
    ]);
    expect(getAll).toHaveBeenCalledOnce();
    expect(getAll.mock.calls[0]).toHaveLength(2);
  });

  it("uses a stable tie-breaker and retains continuation past a filtered page", async () => {
    const calls = [];
    const createdAt = timestamp();
    const query = {
      orderBy(...args) { calls.push(["orderBy", ...args]); return this; },
      startAfter(...args) { calls.push(["startAfter", ...args]); return this; },
      limit(...args) { calls.push(["limit", ...args]); return this; },
      async get() {
        return {
          docs: [
            { id: "a".repeat(64), data: () => ({ createdAt }) },
            { id: "b".repeat(64), data: () => ({ createdAt }) },
          ],
        };
      },
    };
    const firestore = {
      collection: () => ({ doc: () => ({ collection: () => query }) }),
    };
    const page = await readFavoritePage(
      firestore,
      "staff-1",
      { limit: 1, cursor: null },
      "__name__",
      (seconds, nanoseconds) => ({ seconds, nanoseconds }),
    );

    expect(calls).toContainEqual(["orderBy", "createdAt", "desc"]);
    expect(calls).toContainEqual(["orderBy", "__name__", "desc"]);
    expect(calls).toContainEqual(["limit", 2]);
    expect(page.documents).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it("starts a later page after the cursor timestamp and document id", async () => {
    const calls = [];
    const cursorTimestamp = { seconds: 1_795_000_000, nanoseconds: 123 };
    const query = {
      orderBy() { return this; },
      startAfter(...args) { calls.push(args); return this; },
      limit() { return this; },
      async get() { return { docs: [] }; },
    };
    const firestore = {
      collection: () => ({ doc: () => ({ collection: () => query }) }),
    };
    const timestampFn = vi.fn(() => cursorTimestamp);

    const page = await readFavoritePage(
      firestore,
      "staff-1",
      {
        limit: 30,
        cursor: {
          seconds: cursorTimestamp.seconds,
          nanoseconds: cursorTimestamp.nanoseconds,
          id: "a".repeat(64),
        },
      },
      "__name__",
      timestampFn,
    );

    expect(timestampFn).toHaveBeenCalledWith(1_795_000_000, 123);
    expect(calls).toEqual([[cursorTimestamp, "a".repeat(64)]]);
    expect(page).toEqual({ documents: [], nextCursor: null });
  });
});

describe("media favorite authorization", () => {
  it("requires App Check before authentication on a favorite mutation", async () => {
    const requirePrincipalFn = vi.fn();
    const handler = createCmsSetMediaFavoriteHandler({
      firestore: {},
      verifyAppCheckFn: vi.fn(async () => {
        throw Object.assign(new Error("Missing App Check token"), { status: 401 });
      }),
      requirePrincipalFn,
    });
    const res = response();

    await handler(request({ ref: { backend: "r2", id: "asset-1" }, favorite: false }), res);

    expect(res.statusCode).toBe(401);
    expect(requirePrincipalFn).not.toHaveBeenCalled();
  });

  it("does not resolve an asset when its owner removes a stale reference", async () => {
    const registryFn = vi.fn();
    const writeStateFn = vi.fn(async () => true);
    const verifyAppCheckFn = vi.fn(async () => true);
    const handler = createCmsSetMediaFavoriteHandler({
      firestore: {},
      requirePrincipalFn: vi.fn(async () => actor()),
      isActiveFn: vi.fn(async () => true),
      registryFn,
      verifyAppCheckFn,
      writeStateFn,
    });
    const res = response();

    await handler(
      request(
        {
          ref: { backend: "s3", sourceId: "disabled-source", id: "stale-asset" },
          favorite: false,
        },
        { "x-firebase-appcheck": "app-check-token" },
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ favorite: false, changed: true });
    expect(registryFn).not.toHaveBeenCalled();
    expect(verifyAppCheckFn).toHaveBeenCalledWith("app-check-token");
    expect(writeStateFn).toHaveBeenCalledWith(
      {},
      "staff-1",
      { backend: "s3", sourceId: "disabled-source", id: "stale-asset" },
      false,
      expect.any(Function),
    );
  });

  it("refuses an inaccessible new favorite before persistence", async () => {
    const writeStateFn = vi.fn();
    const firestore = {
      collection: (name) => {
        expect(name).toBe("media_assets");
        return { doc: () => ({ get: async () => ({ exists: false }) }) };
      },
    };
    const handler = createCmsSetMediaFavoriteHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => actor()),
      isActiveFn: vi.fn(async () => true),
      verifyAppCheckFn: vi.fn(async () => true),
      writeStateFn,
    });
    const res = response();

    await handler(request({ ref: { backend: "r2", id: "missing" }, favorite: true }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Media asset is unavailable" });
    expect(writeStateFn).not.toHaveBeenCalled();
  });

  it("refuses an existing R2 image without a media capability", async () => {
    const writeStateFn = vi.fn();
    const firestore = {
      collection: (name) => {
        expect(name).toBe("media_assets");
        return {
          doc: (id) => ({
            get: async () => ({
              id,
              exists: true,
              data: () => storedR2({ category: "archive", categories: ["archive"] }),
            }),
          }),
        };
      },
    };
    const handler = createCmsSetMediaFavoriteHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () =>
        actor("editor-1", [{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }])),
      isActiveFn: vi.fn(async () => true),
      verifyAppCheckFn: vi.fn(async () => true),
      writeStateFn,
    });
    const res = response();

    await handler(request({ ref: { backend: "r2", id: "archive-image" }, favorite: true }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Media asset is unavailable" });
    expect(writeStateFn).not.toHaveBeenCalled();
  });

  it("refuses a new S3 favorite when its source is unavailable", async () => {
    const writeStateFn = vi.fn();
    const handler = createCmsSetMediaFavoriteHandler({
      firestore: {},
      requirePrincipalFn: vi.fn(async () => actor()),
      isActiveFn: vi.fn(async () => true),
      verifyAppCheckFn: vi.fn(async () => true),
      registryFn: () => new Map(),
      writeStateFn,
    });
    const res = response();

    await handler(request({
      ref: { backend: "s3", sourceId: "disabled-source", id: "video-1" },
      favorite: true,
    }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Media asset is unavailable" });
    expect(writeStateFn).not.toHaveBeenCalled();
  });

  it("derives the owner from authentication and refuses inactive accounts", async () => {
    const readPageFn = vi.fn();
    const handler = createCmsListMediaFavoritesHandler({
      firestore: {},
      requirePrincipalFn: vi.fn(async () => actor("staff-2")),
      isActiveFn: vi.fn(async () => false),
      readPageFn,
    });
    const res = response();

    await handler(request({}), res);

    expect(res.statusCode).toBe(403);
    expect(readPageFn).not.toHaveBeenCalled();
  });

  it("reuses the account status resolved with the principal", async () => {
    const isActiveFn = vi.fn();
    const requirePrincipalFn = vi.fn(async () => ({
      ...actor(),
      approvedActive: true,
    }));
    const handler = createCmsListMediaFavoritesHandler({
      firestore: {},
      requirePrincipalFn,
      isActiveFn,
      readPageFn: vi.fn(async () => ({ documents: [], nextCursor: null })),
      resolveRecordsFn: vi.fn(async () => []),
    });
    const res = response();

    await handler(request({}), res);

    expect(res.statusCode).toBe(200);
    expect(requirePrincipalFn).toHaveBeenCalledWith(
      expect.anything(),
      { includeAccountStatus: true },
    );
    expect(isActiveFn).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied owner before any favorite read", async () => {
    const readPageFn = vi.fn();
    const handler = createCmsListMediaFavoritesHandler({
      firestore: {},
      requirePrincipalFn: vi.fn(async () => actor("staff-1")),
      isActiveFn: vi.fn(async () => true),
      readPageFn,
    });
    const res = response();

    await handler(request({ uid: "staff-2" }), res);

    expect(res.statusCode).toBe(400);
    expect(readPageFn).not.toHaveBeenCalled();
  });

  it("returns an unavailable own reference without metadata and keeps its continuation", async () => {
    const ref = { backend: "r2", id: "withdrawn-asset" };
    const createdAt = timestamp();
    const handler = createCmsListMediaFavoritesHandler({
      firestore: {},
      requirePrincipalFn: vi.fn(async () => actor()),
      isActiveFn: vi.fn(async () => true),
      readPageFn: vi.fn(async () => ({
        documents: [{
          id: favoriteDocumentId(ref),
          data: () => ({
            ref,
            canonicalRef: canonicalFavoriteRef(ref),
            createdAt,
          }),
        }],
        nextCursor: "more",
      })),
      resolveRecordsFn: vi.fn(async ({ records }) =>
        records.map((record) => ({ ...record, available: false }))),
    });
    const res = response();

    await handler(request({}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      records: [{
        ref,
        createdAt: "2026-09-22T17:00:00.000Z",
        available: false,
      }],
      nextCursor: "more",
      hasMore: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/title|thumbnail|url|name/);
  });

  it("batches asset reads and authorizes each S3 source once", async () => {
    const refs = [
      { backend: "r2", id: "image-1" },
      { backend: "s3", sourceId: "video-library", id: "video-1" },
      { backend: "s3", sourceId: "video-library", id: "video-2" },
    ];
    const dataById = new Map([
      ["image-1", storedR2()],
      ["video-1", storedS3({ createdBy: "system:import" })],
      ["video-2", storedS3({ name: "Second video", createdBy: "system:import" })],
    ]);
    const getAll = vi.fn(async (...references) => references.map((reference) => ({
      id: reference.id,
      exists: dataById.has(reference.id),
      data: () => dataById.get(reference.id),
    })));
    const firestore = {
      getAll,
      collection: () => ({ doc: (id) => ({ id }) }),
    };
    const authorizeFn = vi.fn(async () => true);

    const resolved = await resolveMediaAssets({
      firestore,
      actor: actor(),
      refs,
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn,
    });

    expect(getAll).toHaveBeenCalledOnce();
    expect(getAll.mock.calls[0]).toHaveLength(5); // Three assets and two exact-original status records, in one RPC.
    expect(authorizeFn).toHaveBeenCalledOnce();
    expect(resolved.map((record) => record.available)).toEqual([true, true, true]);
    expect(resolved[1].summary).not.toHaveProperty("objectKey");
    expect(resolved[1].summary).not.toHaveProperty("objectVersionId");
  });

  it("keeps uploader identity private in the shared resolver", async () => {
    const ref = { backend: "s3", sourceId: "video-library", id: "video-1" };
    const firestore = {
      getAll: async (...refs) => refs[0].id === "uploader-1" ? [{
        id: "uploader-1", exists: true, data: () => ({ displayName: "Alex Rivera", email: "private@example.org" }),
      }] : [{
        id: ref.id,
        exists: true,
        data: () => storedS3({ createdBy: "uploader-1" }),
      }],
      collection: (name) => {
        return { doc: (id) => ({ id }) };
      },
    };

    const [resolved] = await resolveMediaAssets({
      firestore,
      actor: actor("editor-1", [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]),
      refs: [ref],
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: vi.fn(async () => true),
    });

    expect(resolved).toMatchObject({
      ref,
      available: true,
      summary: { uploadedBy: { name: "Alex Rivera" } },
    });
    expect(resolved.summary.uploadedBy).not.toHaveProperty("uid");
  });

  it("returns no metadata for an R2 image without a media capability", async () => {
    const ref = { backend: "r2", id: "archive-image" };
    const resolved = await resolveFavoriteRecords({
      firestore: {
        getAll: async () => [{
          id: ref.id,
          exists: true,
          data: () => storedR2({ category: "archive", categories: ["archive"] }),
        }],
        collection: () => ({ doc: (id) => ({ id }) }),
      },
      actor: actor("editor-1", [{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      records: [{ ref, createdAt: "2026-09-22T17:00:00.000Z" }],
      registryFn: vi.fn(),
      authorizeFn: vi.fn(),
    });

    expect(resolved).toEqual([{
      ref,
      createdAt: "2026-09-22T17:00:00.000Z",
      available: false,
    }]);
    expect(JSON.stringify(resolved)).not.toMatch(/Favorite image|url|name/);
  });

  it("returns no metadata when an S3 asset belongs to another source", async () => {
    const ref = { backend: "s3", sourceId: "video-library", id: "video-1" };
    const resolved = await resolveFavoriteRecords({
      firestore: {
        getAll: async () => [{
          id: ref.id,
          exists: true,
          data: () => storedS3({
            sourceId: "archive-working",
            createdBy: "system:import",
          }),
        }],
        collection: () => ({ doc: (id) => ({ id }) }),
      },
      actor: actor(),
      records: [{ ref, createdAt: "2026-09-22T17:00:00.000Z" }],
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: vi.fn(async () => true),
    });

    expect(resolved).toEqual([{
      ref,
      createdAt: "2026-09-22T17:00:00.000Z",
      available: false,
    }]);
    expect(JSON.stringify(resolved)).not.toMatch(/Favorite video|objectKey|name/);
  });

  it("does not read an S3 asset after its source authorization is denied", async () => {
    const getAll = vi.fn();
    const ref = { backend: "s3", sourceId: "archive-working", id: "video-1" };
    const firestore = {
      getAll,
      collection: (name) => ({
        doc: (id) => ({
          id,
          get: async () => name === "users"
            ? { exists: true, data: () => ({ active: true }) }
            : { exists: false, data: () => null },
        }),
      }),
    };
    const resolved = await resolveFavoriteRecords({
      firestore,
      actor: actor(),
      records: [{ ref, createdAt: "2026-09-22T17:00:00.000Z" }],
      registryFn: () => new Map([["archive-working", {
        ...source(),
        id: "archive-working",
        access: "archive",
      }]]),
      authorizeFn: authorizeMediaSource,
    });

    expect(getAll).not.toHaveBeenCalled();
    expect(resolved).toEqual([{
      ref,
      createdAt: "2026-09-22T17:00:00.000Z",
      available: false,
    }]);
  });
});

describe("voiceover media favorite integration", () => {
  let db;
  const ref = { backend: "r2", id: VOICEOVER_ASSET_ID };
  const newsReader = actor("voiceover-reviewer", [
    { role: "contributor", sections: ["news"], registeredMediaSections: ["news"] },
  ]);
  const archiveReader = actor("voiceover-reviewer", [
    { role: "contributor", sections: ["archive"], registeredMediaSections: ["archive"] },
  ]);
  const unverifiedNewsReader = actor("voiceover-reviewer", [
    { role: "contributor", sections: ["news"], registeredMediaSections: ["news"] },
  ], { emailVerified: false });

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error("Use the Firestore emulator for voiceover favorite tests");
    }
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("media-favorites.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    await db.doc(`media_assets/${VOICEOVER_ASSET_ID}`).set(storedVoiceover());
    await db.doc("media_assets/news-image").set(storedR2());
  });

  async function setFavorite(currentActor, favorite = true, targetRef = ref) {
    const handler = createCmsSetMediaFavoriteHandler({
      firestore: db,
      requirePrincipalFn: vi.fn(async () => currentActor),
      isActiveFn: vi.fn(async () => true),
      verifyAppCheckFn: vi.fn(async () => true),
    });
    const res = response();
    await handler(request({ ref: targetRef, favorite }, {
      "x-firebase-appcheck": "app-check-token",
    }), res);
    return res;
  }

  async function listFavorites(currentActor) {
    const handler = createCmsListMediaFavoritesHandler({
      firestore: db,
      requirePrincipalFn: vi.fn(async () => currentActor),
      isActiveFn: vi.fn(async () => true),
    });
    const res = response();
    await handler(request({}), res);
    return res;
  }

  it("favorites and lists a canonical voiceover without exposing its private locator", async () => {
    const saved = await setFavorite(newsReader);
    expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ success: true, ref, favorite: true, changed: true });

    const listed = await listFavorites(newsReader);
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.records).toHaveLength(1);
    expect(listed.body.records[0]).toMatchObject({
      ref,
      available: true,
      asset: {
        id: VOICEOVER_ASSET_ID,
        source: "voiceover",
        kind: "audio",
        mimeType: "audio/wav",
        voiceoverTakeId: VOICEOVER_TAKE_ID,
        voiceover: {
          performer_name: "Jules Avery",
          flags: VOICEOVER_FLAGS,
        },
      },
    });
    expect(JSON.stringify(listed.body)).not.toMatch(/storageKey|contentHash|takes\/v1\//);

    const unverifiedSave = await setFavorite(unverifiedNewsReader);
    expect(unverifiedSave.statusCode).toBe(404);
    expect(unverifiedSave.body).toEqual({ error: "Media asset is unavailable" });
    const unverifiedList = await listFavorites(unverifiedNewsReader);
    expect(unverifiedList.statusCode).toBe(200);
    expect(unverifiedList.body.records).toEqual([expect.objectContaining({
      ref,
      available: false,
    })]);
    expect(unverifiedList.body.records[0]).not.toHaveProperty("asset");

    const imageSave = await setFavorite(newsReader, true, { backend: "r2", id: "news-image" });
    expect(imageSave.statusCode).toBe(404);
    expect(imageSave.body).toEqual({ error: "Media asset is unavailable" });

    const crossAreaList = await listFavorites(archiveReader);
    expect(crossAreaList.statusCode).toBe(200);
    expect(crossAreaList.body.records).toEqual([expect.objectContaining({
      ref, available: true, asset: expect.objectContaining({ id: VOICEOVER_ASSET_ID, kind: "audio" }),
    })]);
    expect(JSON.stringify(crossAreaList.body)).not.toMatch(/storageKey|contentHash|takes\/v1\//);
    const crossAreaSave = await setFavorite(archiveReader);
    expect(crossAreaSave.statusCode).toBe(200);

  });
});
