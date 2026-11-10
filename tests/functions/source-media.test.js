import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import sourceMedia from "../../functions/source-media.js";
import mediaSources from "../../functions/lib/media-sources.js";
import sourceContract from "../../functions/lib/source-media-contract.js";
import s3MediaSource from "../../functions/lib/s3-media-source.js";
import workloadCredentials from "../../functions/lib/aws-workload-credentials.js";

const {
  createCmsCreateSourceMediaReadHandler,
  createCmsListMediaSourcesHandler,
  createCmsListSourceMediaHandler,
  readSourceMediaPage,
} = sourceMedia;
const {
  MediaSourceAccessError,
  authorizeMediaSource,
  buildMediaSourceRegistry,
} = mediaSources;
const { parseSourceMediaAsset, sourceMediaAssetSummary } = sourceContract;
const { SourceObjectError, createS3MediaSourceReader } = s3MediaSource;

function response() {
  const res = { statusCode: null, body: null, headersSent: false, headers: new Map() };
  res.set = (name, value) => { res.headers.set(name.toLowerCase(), value); return res; };
  res.status = (statusCode) => { res.statusCode = statusCode; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  return res;
}

function request(body) {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function actor(grants = [{ role: "staff" }]) {
  return { uid: "staff-1", principal: { id: "staff-1", grants } };
}

function source(overrides = {}) {
  return {
    id: "video-library",
    label: "Shared video library",
    description: "Station video.",
    mediaKind: "video",
    bucket: "njpbs-video-123456789012-us-east-2",
    expectedBucketOwner: "123456789012",
    prefix: "shared/",
    roleArn: "arn:aws:iam::123456789012:role/boardwalk-shared-video",
    access: "active_staff",
    writable: true,
    enabled: true,
    ...overrides,
  };
}

function storedAsset(overrides = {}) {
  return {
    sourceId: "video-library",
    lifecycle: "active",
    name: "County meeting.mp4",
    originalName: "County meeting.mp4",
    description: "A county government meeting.",
    nameSort: "county meeting.mp4",
    updatedAtSort: "2026-09-14T16:00:00.000Z",
    mimeType: "video/mp4",
    kind: "video",
    sizeBytes: 1024,
    preview: "browser",
    rightsStatus: "complete",
    license: "Station owned",
    credit: "NJ PBS",
    tags: ["county"],
    version: 1,
    createdAt: "2026-09-14T15:00:00.000Z",
    updatedAt: "2026-09-14T16:00:00.000Z",
    objectKey: "shared/2dcd49b4-a77b-4d63-b40a-1105b38759ab.mp4",
    objectVersionId: "private-version-id",
    ...overrides,
  };
}

function categoryFirestore(categoryData) {
  return {
    collection(name) {
      expect(name).toBe("mediaCategories");
      return {
        doc(id) {
          expect(id).toBe("archive");
          return { get: async () => ({ exists: Boolean(categoryData), data: () => categoryData }) };
        },
      };
    },
  };
}

describe("source media authorization", () => {
  it("denies active accounts without a video read capability", async () => {
    await expect(authorizeMediaSource({
      firestore: {}, actor: actor([]), source: source(), operation: "read",
      isApprovedActiveAccountFn: async () => true,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("admits active staff to the shared video source", async () => {
    await expect(authorizeMediaSource({
      firestore: {},
      actor: actor(),
      source: source(),
      operation: "browse",
      isApprovedActiveAccountFn: async () => true,
    })).resolves.toBe(true);
  });

  it.each([
    ["upload", "media.upload"],
    ["metadata", "media.video.manage"],
  ])("requires %s capability for shared video writes", async (operation, capability) => {
    await expect(authorizeMediaSource({
      firestore: {},
      actor: actor(),
      source: source(),
      operation,
      isApprovedActiveAccountFn: async () => true,
    })).rejects.toMatchObject({ status: 403 });
    const canFn = vi.fn((_principal, requestedCapability) =>
      requestedCapability === capability,
    );
    await expect(authorizeMediaSource({
      firestore: {},
      actor: actor(),
      source: source(),
      operation,
      isApprovedActiveAccountFn: async () => true,
      canFn,
    })).resolves.toBe(true);
    expect(canFn).toHaveBeenCalledWith(actor().principal, capability, {});
  });

  it("keeps transcript work under approved active-account access", async () => {
    const canFn = vi.fn(() => false);
    await expect(authorizeMediaSource({
      firestore: {},
      actor: actor(),
      source: source(),
      operation: "transcript",
      isApprovedActiveAccountFn: async () => true,
      canFn,
    })).resolves.toBe(true);
    expect(canFn).not.toHaveBeenCalled();
  });

  it("fails closed for archive access when its managed category is absent", async () => {
    await expect(authorizeMediaSource({
      firestore: categoryFirestore(null),
      actor: actor([{ role: "admin" }]),
      source: source({ id: "archive-working", access: "archive" }),
      operation: "browse",
      isApprovedActiveAccountFn: async () => true,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("allows archive media holders from any area when the category exists", async () => {
    const archiveCategory = {
      id: "archive",
      label: "Archive",
      description: "Restricted archive.",
      order: 30,
      active: true,
      version: 1,
    };
    await expect(authorizeMediaSource({
      firestore: categoryFirestore(archiveCategory),
      actor: actor([{ role: "editor", sections: ["archive"], registeredMediaSections: ["archive"] }]),
      source: source({ id: "archive-working", access: "archive" }),
      operation: "browse",
      isApprovedActiveAccountFn: async () => true,
    })).resolves.toBe(true);
    await expect(authorizeMediaSource({
      firestore: categoryFirestore(archiveCategory),
      actor: actor([{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      source: source({ id: "archive-working", access: "archive" }),
      operation: "browse",
      isApprovedActiveAccountFn: async () => true,
    })).resolves.toBe(true);
  });

  it("denies a Viewer archive browsing even with its active category", async () => {
    await expect(authorizeMediaSource({
      firestore: categoryFirestore({ id: "archive", label: "Archive", order: 30, active: true, version: 1 }),
      actor: actor([{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      source: source({ id: "archive-working", access: "archive", writable: true }),
      operation: "browse",
      isApprovedActiveAccountFn: async () => true,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("keeps archive originals metadata read only", async () => {
    const archiveCategory = {
      id: "archive",
      label: "Archive",
      description: "Restricted archive.",
      order: 30,
      active: true,
      version: 1,
    };
    await expect(authorizeMediaSource({
      firestore: categoryFirestore(archiveCategory),
      actor: actor([{ role: "editor", sections: ["archive"], registeredMediaSections: ["archive"] }]),
      source: source({ id: "archive-originals", access: "archive", writable: false }),
      operation: "metadata",
      isApprovedActiveAccountFn: async () => true,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("allows working-file metadata management from any area", async () => {
    const archiveCategory = {
      id: "archive",
      label: "Archive",
      description: "Restricted archive.",
      order: 30,
      active: true,
      version: 1,
    };
    const archiveWorking = source({
      id: "archive-working",
      access: "archive",
      writable: true,
    });
    await expect(authorizeMediaSource({
      firestore: categoryFirestore(archiveCategory),
      actor: actor([{ role: "editor", sections: ["archive"], registeredMediaSections: ["archive"] }]),
      source: archiveWorking,
      operation: "metadata",
      isApprovedActiveAccountFn: async () => true,
    })).resolves.toBe(true);
    await expect(authorizeMediaSource({
      firestore: categoryFirestore(archiveCategory),
      actor: actor([{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      source: archiveWorking,
      operation: "metadata",
      isApprovedActiveAccountFn: async () => true,
    })).resolves.toBe(true);
  });

  it("denies a Viewer archive metadata even with its active category", async () => {
    await expect(authorizeMediaSource({
      firestore: categoryFirestore({ id: "archive", label: "Archive", order: 30, active: true, version: 1 }),
      actor: actor([{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      source: source({ id: "archive-working", access: "archive", writable: true }),
      operation: "metadata",
      isApprovedActiveAccountFn: async () => true,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("keeps malformed or disabled deployment sources out of the registry", () => {
    const registry = buildMediaSourceRegistry({
      videoEnabled: "true",
      videoAccountId: "123456789012",
      videoBucket: "njpbs-video-123456789012-us-east-2",
      videoRoleArn: "arn:aws:iam::403776648647:role/wrong-account",
      archiveEnabled: "false",
    });
    expect(registry.size).toBe(0);
  });

  it("rejects a writable source prefix that is outside the fixed IAM write scope", () => {
    const config = {
      videoEnabled: "true",
      videoAccountId: "123456789012",
      videoBucket: "njpbs-video-123456789012-us-east-2",
      videoRoleArn: "arn:aws:iam::123456789012:role/boardwalk-shared-video",
      archiveEnabled: "false",
    };
    expect(buildMediaSourceRegistry({ ...config, videoPrefix: "" }).has("video-library"))
      .toBe(true);
    expect(buildMediaSourceRegistry({ ...config, videoPrefix: "station/" }).has("video-library"))
      .toBe(false);
  });
});

describe("media source list counts", () => {
  // The handler requires media-sources natively, so its error class is the one to throw here.
  const { MediaSourceAccessError } = createRequire(import.meta.url)("../../functions/lib/media-sources.js");

  function sourcesHandler(overrides = {}) {
    return createCmsListMediaSourcesHandler({
      firestore: {},
      requirePrincipalFn: vi.fn(async () => ({ ...actor(), approvedActive: true })),
      registryFn: () => new Map([
        ["video-library", source()],
        ["archive-originals", source({ id: "archive-originals", access: "archive", writable: false })],
      ]),
      authorizeFn: vi.fn(async ({ source: target, operation }) => {
        if (target.access === "archive" || operation === "delete") {
          throw new MediaSourceAccessError(403, "Denied");
        }
        return true;
      }),
      computeTabCountsFn: vi.fn(async () => ({ favorites: 2, sources: { "video-library": 412 } })),
      log: { error: vi.fn(), warn: vi.fn() },
      ...overrides,
    });
  }

  it("keeps the empty request unchanged and makes no count call", async () => {
    const requirePrincipalFn = vi.fn(async () => actor());
    const computeTabCountsFn = vi.fn();
    const res = response();
    await sourcesHandler({ requirePrincipalFn, computeTabCountsFn })(request({}), res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body)).toEqual(["success", "sources"]);
    expect(res.body.sources.map((item) => item.id)).toEqual(["video-library"]);
    expect(requirePrincipalFn.mock.calls[0]).toHaveLength(1);
    expect(computeTabCountsFn).not.toHaveBeenCalled();
  });

  it("reports upload, metadata, and production access independently", async () => {
    const authorizeFn = vi.fn(async ({ source: target, operation }) => {
      if (target.access === "archive" || ["upload", "metadata", "delete"].includes(operation)) {
        throw new MediaSourceAccessError(403, "Denied");
      }
      return true;
    });
    const res = response();
    await sourcesHandler({ authorizeFn })(request({}), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toEqual([expect.objectContaining({
      id: "video-library",
      canUpload: false,
      canEditMetadata: false,
      canRequestProduction: true,
      canDelete: false,
    })]);
    expect(authorizeFn.mock.calls.map(([call]) => call.operation)).toEqual([
      "browse", "upload", "metadata", "transcript", "delete", "browse",
    ]);
  });

  it("adds counts on request for the sources the caller may browse", async () => {
    const computeTabCountsFn = vi.fn(async () => ({ favorites: 2, sources: { "video-library": 412 } }));
    const requirePrincipalFn = vi.fn(async () => ({ ...actor(), approvedActive: true }));
    const authorizeFn = vi.fn(async ({ source: target, operation }) => {
      if (target.access === "archive" || operation === "delete") {
        throw new MediaSourceAccessError(403, "Denied");
      }
      return true;
    });
    const res = response();
    await sourcesHandler({ computeTabCountsFn, requirePrincipalFn, authorizeFn })(request({ counts: true }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.counts).toEqual({ favorites: 2, sources: { "video-library": 412 } });
    expect(requirePrincipalFn).toHaveBeenCalledWith(expect.anything(), { includeAccountStatus: true });
    expect(computeTabCountsFn).toHaveBeenCalledWith(expect.objectContaining({
      approvedActive: true,
      browseSourceIds: ["video-library"],
    }));
    // The account status from the principal read answers every source check.
    const statusFn = authorizeFn.mock.calls[0][0].isApprovedActiveAccountFn;
    await expect(statusFn()).resolves.toBe(true);
  });

  it("still lists sources when the counts cannot be built", async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const res = response();
    await sourcesHandler({
      computeTabCountsFn: vi.fn(async () => { throw new Error("boom"); }),
      log,
    })(request({ counts: true }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty("counts");
    expect(res.body.sources).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it.each([[{ counts: false }], [{ counts: 1 }], [{ other: true }], [{ counts: true, other: true }]])(
    "rejects %j",
    async (body) => {
      const computeTabCountsFn = vi.fn();
      const res = response();
      await sourcesHandler({ computeTabCountsFn })(request(body), res);
      expect(res.statusCode).toBe(400);
      expect(computeTabCountsFn).not.toHaveBeenCalled();
    },
  );
});

describe("source media indexed reads", () => {
  it("validates exact asset IDs and rejects mixed list filters", () => {
    expect(sourceContract.parseSourceMediaListRequest({ sourceId: "video-library", assetId: "asset-1" })).toEqual({ sourceId: "video-library", assetId: "asset-1" });
    for (const assetId of ["../asset", "a/b", ""]) expect(() => sourceContract.parseSourceMediaListRequest({ sourceId: "video-library", assetId })).toThrow();
    expect(() => sourceContract.parseSourceMediaListRequest({ sourceId: "video-library", assetId: "asset-1", q: "county" })).toThrow();
  });

  it("reads one current asset and excludes missing, deleted, other-source, and out-of-prefix assets", async () => {
    for (const data of [storedAsset(), null, storedAsset({ lifecycle: "tombstoned" }), storedAsset({ sourceId: "other" }), storedAsset({ objectKey: "outside/video.mp4" })]) {
      const doc = vi.fn(() => ({ get: async () => ({ id: "asset-1", exists: !!data, data: () => data }) }));
      const page = await readSourceMediaPage({ collection: () => ({ doc }) }, source(), { assetId: "asset-1" }, "__name__");
      expect(doc).toHaveBeenCalledWith("asset-1");
      expect(page.records).toHaveLength(data?.objectKey === storedAsset().objectKey && data?.sourceId === "video-library" && data?.lifecycle === "active" ? 1 : 0);
      expect(page).toMatchObject({ nextCursor: null, hasMore: false });
    }
  });

  it("uses bounded prefix conditions and a stable cursor without scanning", async () => {
    const calls = [];
    const query = {
      where(...args) { calls.push(["where", ...args]); return this; },
      orderBy(...args) { calls.push(["orderBy", ...args]); return this; },
      startAfter(...args) { calls.push(["startAfter", ...args]); return this; },
      limit(...args) { calls.push(["limit", ...args]); return this; },
      async get() {
        return {
          docs: [
            { id: "asset-1", data: () => storedAsset() },
            { id: "asset-2", data: () => storedAsset({ nameSort: "county report.mp4" }) },
          ],
        };
      },
    };
    const firestore = { collection: () => query };
    const page = await readSourceMediaPage(
      firestore,
      source(),
      { sourceId: "video-library", q: "county", limit: 1, cursor: null },
      "__name__",
    );
    expect(calls).toContainEqual(["where", "nameSort", ">=", "county"]);
    expect(calls).toContainEqual(["where", "nameSort", "<", "county\uf8ff"]);
    expect(calls).toContainEqual(["limit", 2]);
    expect(page.records).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.records[0]).not.toHaveProperty("objectKey");
    expect(page.records[0]).not.toHaveProperty("objectVersionId");
  });

  it("authorizes before querying records or totals", async () => {
    const readPageFn = vi.fn();
    const readTotalFn = vi.fn();
    const handler = createCmsListSourceMediaHandler({
      firestore: {},
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => { throw new MediaSourceAccessError(403, "Denied"); },
      readPageFn,
      readTotalFn,
      documentIdField: "__name__",
      log: { error: vi.fn() },
    });
    const res = response();
    await handler(request({ sourceId: "video-library", assetId: "asset-1" }), res);
    expect(res.statusCode).toBe(403);
    expect(readPageFn).not.toHaveBeenCalled();
    expect(readTotalFn).not.toHaveBeenCalled();
  });

  it("signs ready posters for a listed page only when asked, without returning private records", async () => {
    const assets = [
      { id: "ready-1", rendition: { state: "ready" } },
      { id: "processing-1", rendition: { state: "processing" } },
      { id: "ready-missing", rendition: { state: "ready" } },
    ];
    const createReadFn = vi.fn(async (_source, asset, action) => {
      if (asset.id === "ready-missing") throw new SourceObjectError(409, "The video poster is not available");
      return { assetId: asset.id, action, url: `https://signed.example/${asset.id}`, expiresAt: "2026-09-25T15:05:00.000Z" };
    });
    const handler = createCmsListSourceMediaHandler({
      firestore: {},
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      readPageFn: async () => ({ records: [], assets, nextCursor: null, hasMore: false }),
      readTotalFn: async () => 3,
      createReadFn,
      documentIdField: "__name__",
      log: { error: vi.fn(), warn: vi.fn() },
    });

    const listed = response();
    await handler(request({ sourceId: "video-library" }), listed);
    expect(createReadFn).not.toHaveBeenCalled();
    expect(listed.body).not.toHaveProperty("posters");
    expect(listed.body).not.toHaveProperty("assets");

    const withPosters = response();
    await handler(request({ sourceId: "video-library", posters: true }), withPosters);
    expect(createReadFn.mock.calls.map(([, asset, action]) => [asset.id, action])).toEqual([
      ["ready-1", "poster"],
      ["ready-missing", "poster"],
    ]);
    expect(withPosters.body.posters).toEqual([
      { assetId: "ready-1", url: "https://signed.example/ready-1", expiresAt: "2026-09-25T15:05:00.000Z" },
    ]);
    expect(withPosters.body).not.toHaveProperty("assets");
  });

  it("returns the page when poster signing outlasts its budget", async () => {
    const handler = createCmsListSourceMediaHandler({
      firestore: {},
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      readPageFn: async () => ({
        records: [{ id: "slow" }],
        assets: [{ id: "slow", rendition: { state: "ready" } }],
        nextCursor: null,
        hasMore: false,
      }),
      readTotalFn: async () => 1,
      createReadFn: () => new Promise(() => {}),
      posterBudgetMs: 10,
      documentIdField: "__name__",
      log: { error: vi.fn(), warn: vi.fn() },
    });
    const res = response();
    await handler(request({ sourceId: "video-library", posters: true }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.records.map((record) => record.id)).toEqual(["slow"]);
    expect(res.body.posters).toEqual([]);
  });

  it("returns no filtered total", async () => {
    const readTotalFn = vi.fn();
    const handler = createCmsListSourceMediaHandler({
      firestore: {},
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      readPageFn: async () => ({ records: [], nextCursor: null, hasMore: false }),
      readTotalFn,
      documentIdField: "__name__",
      log: { error: vi.fn() },
    });
    const res = response();
    await handler(request({ sourceId: "video-library", q: "county" }), res);
    expect(res.body.total).toBeNull();
    expect(readTotalFn).not.toHaveBeenCalled();
  });

  it("withholds uploader account data from staff without users.view", async () => {
    const getAll = vi.fn(async () => [{ id: "staff-2", exists: true, data: () => ({
      displayName: "Alex Rivera", email: "private@example.org",
    }) }]);
    const handler = createCmsListSourceMediaHandler({
      firestore: { collection: () => ({ doc: id => ({ id }) }), getAll },
      requirePrincipalFn: async () => actor([{ role: "editor" }]),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      readPageFn: async () => ({
        records: [{ uploadedBy: { uid: "staff-2", name: "Uploader name unavailable" } }],
        nextCursor: null,
        hasMore: false,
      }),
      readTotalFn: async () => 1,
      documentIdField: "__name__",
      log: { error: vi.fn() },
    });
    const res = response();

    await handler(request({ sourceId: "video-library" }), res);

    expect(res.body.records[0].uploadedBy).toEqual({ name: "Alex Rivera" });
    expect(getAll).toHaveBeenCalledOnce();
    expect(JSON.stringify(res.body)).not.toMatch(/staff-2|private@example.org/);
  });

  it("returns uploader account data only with users.view", async () => {
    const getAll = vi.fn(async () => [{ id: "staff-2",
      exists: true,
      data: () => ({ displayName: "Administrator" }),
    }]);
    const handler = createCmsListSourceMediaHandler({
      firestore: { collection: () => ({ doc: id => ({ id }) }), getAll },
      requirePrincipalFn: async () => actor([{ role: "admin" }]),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      readPageFn: async () => ({
        records: [{ uploadedBy: { uid: "staff-2", name: "Uploader name unavailable" } }],
        nextCursor: null,
        hasMore: false,
      }),
      readTotalFn: async () => 1,
      documentIdField: "__name__",
      log: { error: vi.fn() },
    });
    const res = response();

    await handler(request({ sourceId: "video-library" }), res);

    expect(res.body.records[0].uploadedBy).toEqual({ uid: "staff-2", name: "Administrator" });
    expect(getAll).toHaveBeenCalledOnce();
  });

  it("requires users.view to filter media by uploader id", async () => {
    const readPageFn = vi.fn();
    const handler = createCmsListSourceMediaHandler({
      firestore: {},
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      readPageFn,
      documentIdField: "__name__",
      log: { error: vi.fn() },
    });
    const res = response();

    await handler(request({ sourceId: "video-library", createdBy: "staff-2" }), res);

    expect(res.statusCode).toBe(403);
    expect(readPageFn).not.toHaveBeenCalled();
  });

  it("lets staff filter their own uploads without directory access", async () => {
    const readPageFn = vi.fn(async () => ({ records: [], nextCursor: null, hasMore: false }));
    const handler = createCmsListSourceMediaHandler({
      firestore: {},
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      readPageFn,
      documentIdField: "__name__",
      log: { error: vi.fn() },
    });
    const res = response();

    await handler(request({ sourceId: "video-library", createdBy: "staff-1" }), res);

    expect(res.statusCode).toBe(200);
    expect(readPageFn).toHaveBeenCalledOnce();
  });
});

describe("private version reads", () => {
  it.each(["download", "download_web"])("returns the current saved credit with each %s authorization", async (action) => {
    let saved = storedAsset({ credit: null });
    const handler = createCmsCreateSourceMediaReadHandler({
      // Firestore and the object signer are the external storage boundaries.
      firestore: { collection: name => ({ doc: id => ({
        get: async () => ({ exists: true, id, data: () => name === "users" ? { active: true } : saved }),
      }) }) },
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      createReadFn: async () => ({ url: "https://signed.example/read", action }),
      log: { error() {} },
    });
    // The client's list summary stays blank while another editor saves these credits.
    for (const credit of [null, "County pool camera", "Corrected pool credit", null]) {
      saved = { ...saved, credit, version: saved.version + 1 };
      const res = response();
      await handler(request({ sourceId: "video-library", assetId: "asset-1", action }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, access: { url: "https://signed.example/read", action, credit,
        fileVersion: sourceContract.sourceMediaFileVersion(saved.objectVersionId) } });
    }
  });

  it("loads the indexed asset and passes its private version to the signer only", async () => {
    const createReadFn = vi.fn(async (_source, asset, action) => ({
      assetId: asset.id,
      action,
      url: "https://signed.example/read",
      expiresAt: "2026-09-14T16:05:00.000Z",
      mimeType: asset.mimeType,
      disposition: "inline",
      supportsRange: true,
    }));
    const firestore = {
      collection: (name) => ({
        doc: (id) => ({
          get: async () => ({ exists: true, id, data: () => storedAsset() }),
        }),
      }),
    };
    const handler = createCmsCreateSourceMediaReadHandler({
      firestore,
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      createReadFn,
      log: { error: vi.fn() },
    });
    const res = response();
    await handler(request({
      sourceId: "video-library",
      assetId: "asset-1",
      action: "preview",
    }), res);
    expect(res.statusCode).toBe(200);
    expect(createReadFn.mock.calls[0][1].objectVersionId).toBe("private-version-id");
    expect(res.body.access).not.toHaveProperty("objectVersionId");
    expect(res.body.access.fileVersion).toBe(sourceContract.sourceMediaFileVersion("private-version-id"));
  });

  it.each([{ sourceId: "archive-working" }, { lifecycle: "deleted" }])(
    "refuses an inaccessible indexed asset before signing: %j", async (changes) => {
    const createReadFn = vi.fn();
    const firestore = {
      collection: () => ({
        doc: (id) => ({
          get: async () => ({
            exists: true,
            id,
            data: () => storedAsset(changes),
          }),
        }),
      }),
    };
    const handler = createCmsCreateSourceMediaReadHandler({
      firestore,
      requirePrincipalFn: async () => actor(),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      createReadFn,
      log: { error: vi.fn() },
    });
    const res = response();
    await handler(request({
      sourceId: "video-library",
      assetId: "asset-1",
      action: "download",
    }), res);
    expect(res.statusCode).toBe(404);
    expect(createReadFn).not.toHaveBeenCalled();
  });

  it.each(["STANDARD", "INTELLIGENT_TIERING"])("signs GetObject and verifies HeadObject against the exact %s version", async (StorageClass) => {
    const sent = [];
    class FakeS3Client {
      async send(command) {
        sent.push(command.input);
        return { VersionId: "private-version-id", ContentLength: 1024, StorageClass };
      }
    }
    const signUrlFn = vi.fn(async (_client, command) => {
      sent.push(command.input);
      return "https://signed.example/read";
    });
    const reader = createS3MediaSourceReader(
      { audience: "njpbs-boardwalk-s3", region: "us-east-2" },
      {
        S3ClientCtor: FakeS3Client,
        createAwsRoleCredentialsFn: async () => ({
          accessKeyId: "temporary",
          secretAccessKey: "temporary",
          sessionToken: "temporary",
        }),
        getSignedUrlFn: signUrlFn,
        nowFn: () => Date.parse("2026-09-14T16:00:00.000Z"),
      },
    );
    const asset = parseSourceMediaAsset("asset-1", storedAsset());
    const result = await reader(source(), asset, "download");
    expect(sent).toHaveLength(2);
    expect(sent.every((input) => input.VersionId === "private-version-id")).toBe(true);
    expect(sent.every((input) => input.ExpectedBucketOwner === "123456789012")).toBe(true);
    expect(result).toMatchObject({ disposition: "attachment", supportsRange: true });
  });

  it("obtains AWS temporary credentials from a bounded Google identity token", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => "signed-google-token" }));
    const fromWebTokenFn = vi.fn(() => async () => ({
      accessKeyId: "temporary",
      secretAccessKey: "temporary",
      sessionToken: "temporary",
    }));
    await workloadCredentials.createAwsRoleCredentials({
      roleArn: "arn:aws:iam::123456789012:role/boardwalk-shared-video",
      audience: "njpbs-boardwalk-s3",
      region: "us-east-2",
    }, { fetchImpl, fromWebTokenFn });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("audience=njpbs-boardwalk-s3"),
      expect.objectContaining({ headers: { "Metadata-Flavor": "Google" } }),
    );
    expect(fromWebTokenFn).toHaveBeenCalledWith(expect.objectContaining({
      roleArn: "arn:aws:iam::123456789012:role/boardwalk-shared-video",
      webIdentityToken: "signed-google-token",
    }));
  });

  it("projects indexed assets without storage coordinates", () => {
    const summary = sourceMediaAssetSummary(
      parseSourceMediaAsset("asset-1", storedAsset()),
    );
    expect(summary).not.toHaveProperty("objectKey");
    expect(summary).not.toHaveProperty("objectVersionId");
    expect(summary).not.toHaveProperty("bucket");
    expect(summary).not.toHaveProperty("roleArn");
  });
});

describe("source video delete authorization", () => {
  it.each([
    ["staff", false], ["contributor", false], ["editor", true],
    ["admin", true], ["super_admin", true],
  ])("allows %s according to media.video.manage", async (role, allowed) => {
    const authorization = authorizeMediaSource({
      firestore: {}, actor: actor([{ role }]), source: source(), operation: "delete",
      isApprovedActiveAccountFn: async () => true,
    });
    if (allowed) await expect(authorization).resolves.toBe(true);
    else await expect(authorization).rejects.toMatchObject({ status: 403 });
  });

  it("rejects inactive accounts, empty area grants, and archive deletion", async () => {
    const baseline = { firestore: {}, actor: actor([{ role: "super_admin" }]),
      source: source(), operation: "delete", isApprovedActiveAccountFn: async () => true };
    for (const overrides of [
      { isApprovedActiveAccountFn: async () => false },
      { actor: actor([{ role: "editor", sections: [], registeredMediaSections: [] }]) },
      { source: source({ id: "archive-working", access: "archive" }) },
    ]) await expect(authorizeMediaSource({ ...baseline, ...overrides })).rejects.toMatchObject({ status: 403 });
  });

  it("lets a Watch Editor delete from the shared video source", async () => {
    await expect(authorizeMediaSource({
      firestore: {}, actor: actor([{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      source: source(), operation: "delete", isApprovedActiveAccountFn: async () => true,
    })).resolves.toBe(true);
  });

  it("keeps deleted videos out of all summary/read parsing", () => {
    expect(parseSourceMediaAsset("asset-1", storedAsset({ lifecycle: "deleted" }))).toBeNull();
  });
});

describe("bounded pending video status", () => {
  const deps = (firestore, overrides = {}) => ({
    firestore, requirePrincipalFn: async () => actor(),
    registryFn: () => new Map([["video-library", source()]]),
    authorizeFn: async () => true, log: { error: vi.fn() }, ...overrides,
  });
  it("rejects empty, excessive, malformed and mixed requests before reading", async () => {
    const getAll = vi.fn();
    for (const body of [
      { pendingIds: [] }, { pendingIds: Array(101).fill("asset") },
      { pendingIds: ["a/b"] }, { pendingIds: ["asset"], posters: true },
      { pendingIds: ["asset"], assetId: "asset" }, { pendingIds: ["asset"], q: "news" },
    ]) {
      const res = response();
      await createCmsListSourceMediaHandler(deps({ getAll }))(request({ sourceId: "video-library", ...body }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(getAll).not.toHaveBeenCalled();
  });
  it("authorizes before any ID read", async () => {
    const getAll = vi.fn();
    const res = response();
    await createCmsListSourceMediaHandler(deps({ getAll }, {
      authorizeFn: async () => { throw new MediaSourceAccessError(403, "Denied"); },
    }))(request({ sourceId: "video-library", pendingIds: ["asset"] }), res);
    expect(res.statusCode).toBe(403);
    expect(getAll).not.toHaveBeenCalled();
  });
  it("reads each distinct ID once and excludes missing, deleted, other-source and outside-prefix records", async () => {
    const values = [storedAsset(), null, storedAsset({ lifecycle: "deleted" }),
      storedAsset({ sourceId: "other" }), storedAsset({ objectKey: "other/asset.mp4" })];
    const getAll = vi.fn(async (...refs) => refs.map(({ id }) => ({ id, exists: Boolean(values[Number(id.slice(-1))]), data: () => values[Number(id.slice(-1))] })));
    const readPageFn = vi.fn(), readTotalFn = vi.fn(), createReadFn = vi.fn();
    const res = response();
    await createCmsListSourceMediaHandler(deps({
      collection: name => { expect(name).toBe("mediaSourceAssets"); return { doc: id => ({ id }) }; }, getAll,
    }, { readPageFn, readTotalFn, createReadFn }))(request({ sourceId: "video-library", pendingIds: ["asset-0", "asset-0", "asset-1", "asset-2", "asset-3", "asset-4"] }), res);
    expect(res.statusCode).toBe(200);
    expect(getAll.mock.calls[0]).toHaveLength(5);
    expect(res.body.records.map(record => record.id)).toEqual(["asset-0"]);
    expect(res.body.records[0]).toEqual({ id: "asset-0", viewingCopy: expect.any(Object),
      fileVersion: sourceContract.sourceMediaFileVersion("private-version-id") });
    expect(JSON.stringify(res.body)).not.toMatch(/uploadedBy|createdBy|name/);
    expect(JSON.stringify(res.body)).not.toMatch(/objectKey|objectVersionId|private-version-id/);
    expect(readPageFn).not.toHaveBeenCalled();
    expect(readTotalFn).not.toHaveBeenCalled();
    expect(createReadFn).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("measures 26 page and total document reads versus 1 pending document per poll", async () => {
    let reads = 0;
    const docs = Array.from({ length: 25 }, (_, i) => ({ id: `asset-${i}`, exists: true, data: () => storedAsset() }));
    let limit = 0;
    const query = {
      where() { return this; }, orderBy() { return this; }, limit(n) { limit = n; return this; },
      async get() { reads += Math.min(limit, docs.length); return { docs: docs.slice(0, limit) }; },
      doc(id) { return { id, async get() { reads += 1; return { exists: false }; } }; },
    };
    const firestore = { collection: () => query, async getAll(...refs) {
      reads += refs.length; return refs.map(ref => docs.find(doc => doc.id === ref.id));
    } };
    const handler = createCmsListSourceMediaHandler(deps(firestore));
    await handler(request({ sourceId: "video-library", limit: 24 }), response());
    const before = reads;
    reads = 0;
    await handler(request({ sourceId: "video-library", pendingIds: ["asset-0"] }), response());
    expect({ before, after: reads }).toEqual({ before: 26, after: 1 });
  });
});


it.each(["publication_refresh_failed", "replacement_permission_changed", "replacement_video_changed", "internal-provider-detail"])("preserves only safe replacement recovery codes in the asset summary: %s", code => {
  const parsed = parseSourceMediaAsset("asset-1", storedAsset({ replacement: {
    state: "failed", requestedAt: "2026-11-03T14:20:00Z", requestedBy: "Editor", errorCode: code } }));
  expect(sourceMediaAssetSummary(parsed).replacement.errorCode).toBe(code === "internal-provider-detail" ? "processing_failed" : code);
});
