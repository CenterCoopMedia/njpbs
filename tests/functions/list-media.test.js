import { describe, expect, it, vi } from "vitest";
import listMedia from "../../functions/list-media.js";

const {
  MAX_MEDIA_SCAN,
  MEDIA_SCAN_BATCH_SIZE,
  createCmsListMediaHandler,
  readMediaAssetSummaries,
  readMediaAssetSummariesByIds,
  readSelfProfilePhotoSummaries,
} = listMedia;

function makeReq({
  method = "POST",
  body = {},
  headers = { "content-type": "application/json" },
  rawBody,
} = {}) {
  return { method, body, headers, rawBody, ip: "203.0.113.9" };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    headers: new Map(),
  };
  res.set = (name, value) => {
    res.headers.set(name.toLocaleLowerCase(), value);
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

const principal = (grants, overrides = {}) => ({
  uid: "editor-1",
  email: "editor@example.org",
  principal: { id: "editor-1", grants },
  ...overrides,
});

function stored(id, category, overrides = {}) {
  return {
    id,
    name: `${category} asset`,
    originalName: `${id}.png`,
    category,
    tags: [],
    description: null,
    altText: null,
    license: "NJ PBS owned",
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 1,
    height: 1,
    url: `https://media.njpbs.org/${id}.png`,
    lifecycle: "active",
    version: 1,
    createdAt: "2026-08-13T12:00:00.000Z",
    createdBy: "editor-1",
    updatedAt: "2026-08-13T12:00:00.000Z",
    updatedBy: "editor-1",
    contentHash: "do-not-return",
    storageKey: `cms-media/${category}/${id}.png`,
    ...overrides,
  };
}

describe("cmsListMedia handler", () => {
  it("selects and returns the media source and generated alt-text marker", async () => {
    const select = vi.fn(() => ({
      limit: vi.fn(() => ({
        get: vi.fn(async () => ({
          docs: [{
            id: "upload-one",
            data: () => stored("upload-one", "news", {
              source: "upload",
              altTextGenerated: true,
              thumbnails: [{
                width: 480,
                height: 320,
                storageKey: "cms-media/news/upload-one/thumbs/hash-w480.webp",
                url: "https://media.njpbs.org/cms-media/news/upload-one/thumbs/hash-w480.webp",
              }],
            }),
          }],
        })),
      })),
    }));
    const firestore = {
      collection: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: () => ({ count: () => ({ get: async () => ({ data: () => ({ count: 1 }) }) }) }),
          orderBy: vi.fn(() => ({ select })),
        })),
      })),
    };

    const result = await readMediaAssetSummaries(firestore);

    expect(select.mock.calls[0]).toContain("source");
    expect(select.mock.calls[0]).toContain("altTextGenerated");
    expect(select.mock.calls[0]).toContain("thumbnails");
    expect(select.mock.calls[0]).toContain("animated");
    expect(result.records[0]).toMatchObject({
      id: "upload-one",
      source: "upload",
      altTextGenerated: true,
      thumbnails: [{
        width: 480,
        height: 320,
        url: "https://media.njpbs.org/cms-media/news/upload-one/thumbs/hash-w480.webp",
      }],
    });
  });

  it("bounds self profile-photo reads by caller, category, and lifecycle", async () => {
    const constraints = [];
    const query = {
      where: vi.fn((field, operator, value) => {
        constraints.push([field, operator, value]);
        return query;
      }),
      orderBy: vi.fn(() => query),
      select: vi.fn(() => query),
      limit: vi.fn(() => query),
      count: () => ({ get: async () => ({ data: () => ({ count: 1 }) }) }),
      get: vi.fn(async () => ({
        docs: [{
          id: "own-photo",
          data: () => stored("own-photo", "staff-profile"),
        }],
      })),
    };
    const firestore = { collection: vi.fn(() => query) };

    const result = await readSelfProfilePhotoSummaries(firestore, "editor-1");

    expect(constraints).toEqual([
      ["createdBy", "==", "editor-1"],
      ["category", "==", "staff-profile"],
      ["lifecycle", "==", "active"],
    ]);
    expect(query.limit).toHaveBeenCalledWith(MEDIA_SCAN_BATCH_SIZE);
    expect(result.records.map((asset) => asset.id)).toEqual(["own-photo"]);
  });

  it("keeps successful direct reads when another requested asset fails", async () => {
    const get = vi.fn((assetId) => {
      if (assetId === "failed-one") return Promise.reject(new Error("read failed"));
      if (assetId === "missing-one") {
        return Promise.resolve({ exists: false, id: assetId });
      }
      return Promise.resolve({
        exists: true,
        id: assetId,
        data: () => stored(assetId, "news"),
      });
    });
    const firestore = {
      collection: vi.fn(() => ({
        doc: vi.fn((assetId) => ({ get: () => get(assetId) })),
      })),
    };

    const result = await readMediaAssetSummariesByIds(firestore, [
      "news-one",
      "missing-one",
      "failed-one",
    ]);

    expect(result.records.map((asset) => asset.id)).toEqual(["news-one"]);
    expect(result.failedIds).toEqual(["failed-one"]);
    expect(result.overflow).toBe(false);
  });

  it("hydrates thumbnail ids with getAll when the Firestore client has it", async () => {
    const getAll = vi.fn(async (...refs) => refs.map((ref) => ({
      exists: ref.id !== "missing-one",
      id: ref.id,
      data: () => stored(ref.id, "news"),
    })));
    const firestore = {
      getAll,
      collection: vi.fn(() => ({
        doc: vi.fn((assetId) => ({ id: assetId, get: vi.fn() })),
      })),
    };
    const result = await readMediaAssetSummariesByIds(firestore, [
      "news-one",
      "missing-one",
    ]);
    expect(getAll).toHaveBeenCalledOnce();
    expect(result.records.map((asset) => asset.id)).toEqual(["news-one"]);
    expect(result.failedIds).toEqual([]);
  });

  it("rejects unsupported methods before authentication", async () => {
    const requirePrincipalFn = vi.fn();
    const handler = createCmsListMediaHandler({ requirePrincipalFn });
    const res = makeRes();

    await handler(makeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(405);
    expect(requirePrincipalFn).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("validates the strict request after authentication and before Firestore", async () => {
    const readRecordsFn = vi.fn();
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => principal([{ role: "editor" }])),
      readRecordsFn,
    });
    const res = makeRes();

    await handler(makeReq({ body: { storageKey: "secret" } }), res);

    expect(res.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
  });

  it("rejects compressed and oversized JSON before authentication", async () => {
    const requirePrincipalFn = vi.fn();
    const handler = createCmsListMediaHandler({ requirePrincipalFn });
    const compressed = makeRes();
    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
    }), compressed);
    const oversized = makeRes();
    await handler(makeReq({
      rawBody: Buffer.alloc(16 * 1024 + 1),
    }), oversized);

    expect(compressed.statusCode).toBe(415);
    expect(oversized.statusCode).toBe(413);
    expect(requirePrincipalFn).not.toHaveBeenCalled();
  });

  it("refuses a caller without media authority before Firestore", async () => {
    const readRecordsFn = vi.fn();
    const readRecordsByIdsFn = vi.fn();
    const readCategoryLabelsFn = vi.fn();
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => principal([{ role: "unknown" }])),
      readRecordsFn,
      readRecordsByIdsFn,
      readCategoryLabelsFn,
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const res = makeRes();

    await handler(makeReq({ body: { assetIds: ["news-one"] } }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("You do not have permission to list media.");
    expect(readRecordsFn).not.toHaveBeenCalled();
    expect(readRecordsByIdsFn).not.toHaveBeenCalled();
    expect(readCategoryLabelsFn).not.toHaveBeenCalled();
  });

  it("admits verified active audio readers only to audio-only indexed requests", async () => {
    const readRecordsFn = vi.fn(async () => ({ records: [], overflow: false }));
    const readIndexedMediaFn = vi.fn(async () => ({
      records: [], paging: "cursor", nextCursor: null, total: 0, allCount: 0,
      page: 1, pageCount: null, categoryCounts: null, kindCounts: null,
    }));
    const actor = principal([{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }], {
      emailVerified: true,
      approvedActive: true,
    });
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => actor),
      readRecordsFn,
      readCategoryLabelsFn: vi.fn(async () => ({ news: "News" })),
      readIndexedMediaFn,
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const allowed = makeRes();
    await handler(makeReq({ body: { paging: "cursor", kinds: ["audio"] } }), allowed);
    expect(allowed.statusCode).toBe(200);
    expect(readIndexedMediaFn).toHaveBeenCalledOnce();
    const legacy = makeRes();
    await handler(makeReq({ body: { kinds: ["audio"] } }), legacy);
    expect(legacy.statusCode).toBe(200);
    expect(readRecordsFn).toHaveBeenCalledOnce();

    for (const body of [
      { paging: "cursor" },
      { paging: "cursor", kinds: ["audio", "image"] },
      { corpus: true },
    ]) {
      const denied = makeRes();
      await handler(makeReq({ body }), denied);
      expect(denied.statusCode, JSON.stringify(body)).toBe(403);
    }
    expect(readIndexedMediaFn).toHaveBeenCalledOnce();
  });

  it("requires verified approved status for the read-only audio capability", async () => {
    const readIndexedMediaFn = vi.fn();
    const run = async (overrides) => {
      const handler = createCmsListMediaHandler({
        requirePrincipalFn: vi.fn(async () => principal(
          [{ role: "staff", sections: ["news"], registeredMediaSections: ["news"] }],
          { emailVerified: true, approvedActive: true, ...overrides },
        )),
        readIndexedMediaFn,
        log: { warn: vi.fn(), error: vi.fn() },
      });
      const res = makeRes();
      await handler(makeReq({ body: { paging: "cursor", kinds: ["audio"] } }), res);
      return res;
    };
    expect((await run({ emailVerified: false })).statusCode).toBe(403);
    expect((await run({ approvedActive: false })).statusCode).toBe(403);
    expect(readIndexedMediaFn).not.toHaveBeenCalled();
  });

  it("projects exact id reads by kind across categories for read-only audio callers", async () => {
    const readRecordsByIdsFn = vi.fn(async () => ({
      records: [
        stored("news-audio", "news", { kind: "audio", mimeType: "audio/wav", width: null,
          height: null, originalName: "news-audio.wav" }),
        stored("news-image", "news"),
        stored("arts-audio", "arts", { kind: "audio", mimeType: "audio/wav", width: null,
          height: null, originalName: "arts-audio.wav" }),
      ],
      failedIds: [],
      overflow: false,
    }));
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => principal(
        [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }],
        { emailVerified: true, approvedActive: true },
      )),
      readRecordsByIdsFn,
      readCategoryLabelsFn: vi.fn(async () => ({ news: "News", arts: "Arts" })),
    });
    const res = makeRes();
    await handler(makeReq({ body: { assetIds: ["news-audio", "news-image", "arts-audio"] } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.records.map((record) => record.id)).toEqual(["arts-audio", "news-audio"]);
  });

  it("lists only the caller's own staff profile images in self scope", async () => {
    const readRecordsFn = vi.fn();
    const readSelfProfileRecordsFn = vi.fn(async () => ({
      records: [
        stored("own-photo", "staff-profile"),
        stored("other-photo", "staff-profile", { createdBy: "editor-2" }),
        stored("own-news", "news"),
      ],
      overflow: false,
    }));
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () =>
        principal([{ role: "contributor" }]),
      ),
      isApprovedActiveAccountFn: vi.fn(async () => true),
      readRecordsFn,
      readSelfProfileRecordsFn,
      readCategoryLabelsFn: vi.fn(async () => ({})),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        categories: ["staff-profile"],
        kinds: ["image"],
        profilePhotoScope: "self",
      },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.records.map((asset) => asset.id)).toEqual(["own-photo"]);
    expect(res.body).toMatchObject({ allCount: 1, total: 1 });
    expect(readSelfProfileRecordsFn).toHaveBeenCalledWith(expect.anything(), "editor-1");
    expect(readRecordsFn).not.toHaveBeenCalled();
  });

  it("keeps direct id reads within the caller's self profile-photo scope", async () => {
    const readSelfProfileRecordsFn = vi.fn();
    const readRecordsByIdsFn = vi.fn(async () => ({
      records: [
        stored("own-photo", "staff-profile"),
        stored("other-photo", "staff-profile", { createdBy: "editor-2" }),
      ],
      failedIds: [],
      overflow: false,
    }));
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () =>
        principal([{ role: "contributor" }]),
      ),
      isApprovedActiveAccountFn: vi.fn(async () => true),
      readRecordsByIdsFn,
      readSelfProfileRecordsFn,
      readCategoryLabelsFn: vi.fn(async () => ({})),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        assetIds: ["own-photo", "other-photo"],
        categories: ["staff-profile"],
        kinds: ["image"],
        profilePhotoScope: "self",
      },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.records.map((asset) => asset.id)).toEqual(["own-photo"]);
    expect(readRecordsByIdsFn).toHaveBeenCalledWith(expect.anything(), [
      "own-photo",
      "other-photo",
    ]);
    expect(readSelfProfileRecordsFn).not.toHaveBeenCalled();
  });

  it("refuses a wider query through the self profile-photo scope", async () => {
    const readRecordsFn = vi.fn();
    const readSelfProfileRecordsFn = vi.fn();
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () =>
        principal([{ role: "contributor" }]),
      ),
      isApprovedActiveAccountFn: vi.fn(async () => true),
      readRecordsFn,
      readSelfProfileRecordsFn,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        categories: [],
        kinds: ["image"],
        profilePhotoScope: "self",
      },
    }), res);

    expect(res.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
    expect(readSelfProfileRecordsFn).not.toHaveBeenCalled();
  });

  it("lists media across categories for an area-scoped Editor", async () => {
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () =>
        principal([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]),
      ),
      readRecordsFn: vi.fn(async () => ({
        records: [stored("news-one", "news"), stored("arts-one", "arts")],
        overflow: false,
      })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, allCount: 2, total: 2 });
    expect(res.body.records.map((asset) => asset.id)).toEqual(["arts-one", "news-one"]);
    expect(res.body.records[0]).not.toHaveProperty("contentHash");
    expect(res.body.records[0]).not.toHaveProperty("storageKey");
  });

  it("pages at 30 unless the request asks for a size up to the scan cap", async () => {
    const records = Array.from({ length: 31 }, (_, index) => stored(`asset-${index}`, "news"));
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () =>
        principal([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]),
      ),
      readRecordsFn: vi.fn(async () => ({ records, overflow: false })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
    });
    const wide = makeRes();
    await handler(makeReq({ body: { pageSize: MAX_MEDIA_SCAN } }), wide);
    expect(wide.statusCode).toBe(200);
    expect(wide.body.records).toHaveLength(31);
    expect(wide.body.pageCount).toBe(1);

    const narrow = makeRes();
    await handler(makeReq({ body: { pageSize: 1 } }), narrow);
    expect(narrow.body.records).toHaveLength(1);
    expect(narrow.body.pageCount).toBe(31);

    const omitted = makeRes();
    await handler(makeReq({ body: {} }), omitted);
    expect(omitted.body.records).toHaveLength(30);
    expect(omitted.body.pageCount).toBe(2);

    const readRecordsFn = vi.fn();
    const rejected = makeRes();
    await createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => principal([{ role: "editor" }])),
      readRecordsFn,
    })(makeReq({ body: { pageSize: MAX_MEDIA_SCAN + 1 } }), rejected);
    expect(rejected.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
  });

  it("honors a page size and tab counts sent together", async () => {
    const records = Array.from({ length: 31 }, (_, index) => stored(`asset-${index}`, "news"));
    const computeTabCountsFn = vi.fn(async () => ({ images: 31 }));
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => ({
        ...principal([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]),
        approvedActive: true,
      })),
      readRecordsFn: vi.fn(async () => ({ records, overflow: false })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
      computeTabCountsFn,
      registryFn: () => new Map(),
    });
    const res = makeRes();

    await handler(makeReq({ body: { pageSize: MAX_MEDIA_SCAN, counts: true } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.records).toHaveLength(31);
    expect(res.body.pageCount).toBe(1);
    expect(res.body.counts).toEqual({ images: 31 });
    expect(computeTabCountsFn).toHaveBeenCalledWith(expect.objectContaining({ imagesCount: 31 }));
  });

  it("keeps the response unchanged and omits counts when the counts flag is absent", async () => {
    const requirePrincipalFn = vi.fn(async () => principal([{ role: "editor" }]));
    const computeTabCountsFn = vi.fn();
    const handler = createCmsListMediaHandler({
      requirePrincipalFn,
      readRecordsFn: vi.fn(async () => ({ records: [stored("news-one", "news")], overflow: false })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
      computeTabCountsFn,
      registryFn: vi.fn(),
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body)).toEqual([
      "success", "records", "total", "allCount", "page", "pageCount", "categoryCounts", "kindCounts",
    ]);
    expect(computeTabCountsFn).not.toHaveBeenCalled();
  });

  it("adds tab counts on request, reusing the list's own total and account status", async () => {
    const actor = { ...principal([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]), approvedActive: true };
    const requirePrincipalFn = vi.fn(async () => actor);
    const registry = new Map();
    const computeTabCountsFn = vi.fn(async () => ({ images: 2, favorites: 4, sources: { "video-library": 7 } }));
    const isApprovedActiveAccountFn = vi.fn();
    const handler = createCmsListMediaHandler({
      requirePrincipalFn,
      readRecordsFn: vi.fn(async () => ({
        records: [stored("news-one", "news"), stored("arts-one", "arts")],
        overflow: false,
      })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
      computeTabCountsFn,
      registryFn: () => registry,
      isApprovedActiveAccountFn,
    });
    const res = makeRes();

    await handler(makeReq({ body: { q: "zzz", counts: true } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ total: 0, allCount: 2 });
    expect(res.body.counts).toEqual({ images: 2, favorites: 4, sources: { "video-library": 7 } });
    expect(requirePrincipalFn).toHaveBeenCalledWith(expect.anything(), { includeAccountStatus: true });
    expect(isApprovedActiveAccountFn).not.toHaveBeenCalled();
    expect(computeTabCountsFn).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      approvedActive: true,
      registry,
      imagesCount: 2,
    }));
  });

  it("still lists media when the counts cannot be built", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => ({ ...principal([{ role: "editor" }]), approvedActive: true })),
      readRecordsFn: vi.fn(async () => ({ records: [stored("news-one", "news")], overflow: false })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
      computeTabCountsFn: vi.fn(async () => { throw new Error("boom"); }),
      registryFn: () => new Map(),
      log,
    });
    const res = makeRes();

    await handler(makeReq({ body: { counts: true } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty("counts");
    expect(res.body.allCount).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ counts: false }],
    [{ counts: "yes" }],
    [{ counts: true, assetIds: ["news-one"] }],
    [{ counts: true, profilePhotoScope: "self", categories: ["author-photos"], kinds: ["image"] }],
  ])("rejects an invalid counts request %j before Firestore", async (body) => {
    const readRecordsFn = vi.fn();
    const computeTabCountsFn = vi.fn();
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => principal([{ role: "editor" }])),
      readRecordsFn,
      readRecordsByIdsFn: readRecordsFn,
      readSelfProfileRecordsFn: readRecordsFn,
      computeTabCountsFn,
    });
    const res = makeRes();

    await handler(makeReq({ body }), res);

    expect(res.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
    expect(computeTabCountsFn).not.toHaveBeenCalled();
  });

  it("returns favorite states for the listed page when asked, from one projection read", async () => {
    const readFavoriteProjectionFn = vi.fn(async (_firestore, _uid, refs) => refs.map((ref) => ({ ref, favorite: ref.id === "news-one" })));
    const requirePrincipalFn = vi.fn(async () => ({ ...principal([{ role: "editor" }]), approvedActive: true }));
    const handler = createCmsListMediaHandler({
      requirePrincipalFn,
      readRecordsFn: vi.fn(async () => ({ records: [stored("news-one", "news"), stored("arts-one", "arts")], overflow: false })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
      readFavoriteProjectionFn,
    });
    const res = makeRes();

    await handler(makeReq({ body: { favorites: true } }), res);

    expect(res.statusCode).toBe(200);
    expect(requirePrincipalFn).toHaveBeenCalledWith(expect.anything(), { includeAccountStatus: true });
    expect(readFavoriteProjectionFn).toHaveBeenCalledTimes(1);
    const ids = res.body.records.map((asset) => asset.id);
    expect(res.body.favoriteStates).toEqual(ids.map((id) => ({ ref: { backend: "r2", id }, favorite: id === "news-one" })));
  });

  it.each([
    ["an inactive account", { approvedActive: false }, async () => []],
    ["a failed favorites read", { approvedActive: true }, async () => { throw new Error("private detail"); }],
  ])("lists media without favorite states for %s", async (_label, status, read) => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const readFavoriteProjectionFn = vi.fn(read);
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => ({ ...principal([{ role: "editor" }]), ...status })),
      readRecordsFn: vi.fn(async () => ({ records: [stored("news-one", "news")], overflow: false })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
      readFavoriteProjectionFn,
      log,
    });
    const res = makeRes();

    await handler(makeReq({ body: { favorites: true } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.allCount).toBe(1);
    expect(res.body).not.toHaveProperty("favoriteStates");
    expect(JSON.stringify(res.body)).not.toContain("private detail");
    if (!status.approvedActive) expect(readFavoriteProjectionFn).not.toHaveBeenCalled();
  });

  it.each([
    [{ favorites: false }],
    [{ favorites: "yes" }],
    [{ favorites: true, profilePhotoScope: "self", categories: ["author-photos"], kinds: ["image"] }],
  ])("rejects an invalid favorites request %j before Firestore", async (body) => {
    const readRecordsFn = vi.fn();
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => principal([{ role: "editor" }])),
      readRecordsFn,
      readSelfProfileRecordsFn: readRecordsFn,
    });
    const res = makeRes();

    await handler(makeReq({ body }), res);

    expect(res.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
  });

  it("reads requested ids across categories without scanning or returning missing assets", async () => {
    const readRecordsFn = vi.fn();
    const readRecordsByIdsFn = vi.fn(async () => ({
      records: [stored("news-one", "news"), stored("arts-one", "arts")],
      failedIds: [],
      overflow: false,
    }));
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () =>
        principal([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]),
      ),
      readRecordsFn,
      readRecordsByIdsFn,
      readCategoryLabelsFn: vi.fn(async () => ({})),
    });
    const res = makeRes();

    await handler(makeReq({
      body: { assetIds: ["news-one", "arts-one", "missing-one"] },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, allCount: 2, total: 2 });
    expect(res.body.records.map((asset) => asset.id)).toEqual(["arts-one", "news-one"]);
    expect(readRecordsByIdsFn).toHaveBeenCalledWith(expect.anything(), [
      "news-one",
      "arts-one",
      "missing-one",
    ]);
    expect(readRecordsFn).not.toHaveBeenCalled();
  });

  it("filters by descriptive secondary category assignments across areas", async () => {
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () =>
        principal([{ role: "editor", sections: ["arts"], registeredMediaSections: ["arts"] }]),
      ),
      readRecordsFn: vi.fn(async () => ({
        records: [
          stored("news-one", "news", { categories: ["news", "arts"] }),
        ],
        overflow: false,
      })),
      readCategoryLabelsFn: vi.fn(async () => ({
        news: "News",
        arts: "Arts",
      })),
    });
    const res = makeRes();

    await handler(makeReq({ body: { categories: ["arts"] } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ allCount: 1, total: 1, records: [expect.objectContaining({ id: "news-one" })] });
  });

  it("fails honestly when the bounded search backend reaches its scan cap", async () => {
    const handler = createCmsListMediaHandler({
      requirePrincipalFn: vi.fn(async () => principal([{ role: "editor" }])),
      readRecordsFn: vi.fn(async () => ({ records: [], overflow: true })),
      readCategoryLabelsFn: vi.fn(async () => ({})),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(MAX_MEDIA_SCAN).toBe(500);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/indexed media search/i);
  });
});
