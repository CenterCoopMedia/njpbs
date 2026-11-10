import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import mediaContract from "../../functions/lib/media-contract.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import lifecycle from "../../functions/set-media-lifecycle.js";
import bin from "../../functions/lib/media-bin.js";
import binnedList from "../../functions/list-binned-media.js";
import principals from "../../functions/lib/principal.js";
import { releaseSelector } from "../helpers/private-public-release-pair.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const { mediaProjection } = mediaContract;
const { formatMediaEtag } = mediaLibrary;
const {
  createCmsSetMediaLifecycleHandler,
  createCmsRestoreMediaHandler,
  sameExpectedStoredObject,
  validateMediaLifecycleRequest,
} = lifecycle;

let db;

function makeReq({
  method = "POST",
  body = {},
  headers = { "content-type": "application/json" },
} = {}) {
  return { method, body, headers, ip: "203.0.113.29" };
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

function actor(grants = [{ role: "editor" }]) {
  return {
    uid: "editor-1",
    email: "editor@example.org",
    principal: { id: "editor-1", grants },
  };
}

const contentHash = "a".repeat(64);
const attemptId = "attempt-one";

function record(overrides = {}) {
  return {
    id: "asset-one",
    name: "Studio control room",
    originalName: "studio.png",
    category: "news",
    tags: ["studio"],
    description: "Studio equipment",
    altText: "Monitors and switchers",
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 1600,
    height: 900,
    contentHash,
    storageKey: `cms-media/news/asset-one/${contentHash}.png`,
    url: `https://media.njpbs.org/cms-media/news/asset-one/${contentHash}.png`,
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

function objectHead(overrides = {}) {
  return {
    contentLength: 128,
    contentType: "image/png",
    metadata: {
      contenthash: contentHash,
      assetid: "asset-one",
      attemptid: attemptId,
      sizebytes: "128",
    },
    ...overrides,
  };
}

async function seedDeployment(overrides = {}) {
  await db.collection("system").doc("publicDeployment").set({
    schemaVersion: 1,
    mediaLifecycleReady: true,
    state: "idle",
    activeGeneration: 7,
    activeDeploymentId: "deployment-7",
    activeCommitSha: "b".repeat(40),
    lastReservedGeneration: 7,
    newestEligibleGeneration: 7,
    newestEligibleBuildBatchId: "build-seven",
    ...overrides,
  });
}

async function seedAsset(overrides = {}) {
  const stored = record(overrides);
  const writes = [
    db.collection("media_assets").doc(stored.id).set(stored),
    db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc(stored.contentHash)
      .set({
        state: "committed",
        attemptId,
        assetId: stored.id,
        finalKey: stored.storageKey,
      }),
  ];
  if (stored.lifecycle === "active") {
    writes.push(
      db.collection("media_assets_public").doc(stored.id).set(mediaProjection(stored)),
    );
  }
  await Promise.all(writes);
  return stored;
}

async function docsIn(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

function request(action, version = 2) {
  return makeReq({
    headers: {
      "content-type": "application/json",
      "if-match": formatMediaEtag("asset-one", version),
    },
    body: { assetId: "asset-one", action },
  });
}

function handler(overrides = {}) {
  return createCmsSetMediaLifecycleHandler({
    firestore: db,
    requirePrincipalFn: async () => actor(),
    now: () => "2026-08-13T20:45:00.000Z",
    log: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("set-media-lifecycle.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  await db.collection("users").doc("editor-1").set({
    active: true, grants: [{ role: "editor" }],
  });
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("cmsSetMediaLifecycle", () => {
  it("compares immutable stored-object identity without property-order coupling", () => {
    const expected = {
      contentHash,
      assetId: "asset-one",
      attemptId,
      sizeBytes: 128,
      mimeType: "image/png",
    };
    const reordered = {
      mimeType: "image/png",
      sizeBytes: 128,
      attemptId,
      assetId: "asset-one",
      contentHash,
    };

    expect(sameExpectedStoredObject(reordered, expected)).toBe(true);
    for (const field of Object.keys(expected)) {
      expect(sameExpectedStoredObject(
        { ...reordered, [field]: `${reordered[field]}-changed` },
        expected,
      )).toBe(false);
    }
  });

  it("accepts only one bounded asset id and a known lifecycle action", () => {
    expect(validateMediaLifecycleRequest({})).toMatch(/assetId/i);
    expect(validateMediaLifecycleRequest({ assetId: "bad/path", action: "tombstone" }))
      .toMatch(/assetId/i);
    expect(validateMediaLifecycleRequest({ assetId: "asset-one", action: "delete" }))
      .toMatch(/action/i);
    expect(validateMediaLifecycleRequest({
      assetId: "asset-one",
      action: "tombstone",
      force: true,
    })).toMatch(/unknown request field/i);
    expect(validateMediaLifecycleRequest({
      assetId: "asset-one",
      action: "reactivate",
    })).toBeNull();
  });

  it("requires a strong If-Match condition before reading the asset", async () => {
    const firestore = {
      collection: vi.fn(),
      runTransaction: vi.fn(),
    };
    const lifecycleHandler = createCmsSetMediaLifecycleHandler({
      firestore,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await lifecycleHandler(
      makeReq({ body: { assetId: "asset-one", action: "tombstone" } }),
      res,
    );

    expect(res.statusCode).toBe(428);
    expect(firestore.collection).not.toHaveBeenCalled();
    expect(firestore.runTransaction).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps the lifecycle boundary closed until coordinated deployment is ready and idle", async () => {
    await seedAsset();
    const lifecycleHandler = handler();

    const missing = makeRes();
    await lifecycleHandler(request("tombstone"), missing);
    expect(missing.statusCode).toBe(503);

    await seedDeployment({
      state: "deploying",
      lastReservedGeneration: 8,
      newestEligibleGeneration: 8,
      newestEligibleBuildBatchId: "build-eight",
      leaseToken: "11111111-1111-4111-8111-111111111111",
      leaseAcquiredAt: admin.firestore.Timestamp.fromDate(
        new Date("2026-08-14T15:00:00.000Z"),
      ),
      candidateGeneration: 8,
      candidateBuildBatchId: "build-eight",
      candidateCommitSha: "c".repeat(40),
      predecessorGeneration: 7,
      predecessorDeploymentId: "deployment-7",
      predecessorCommitSha: "b".repeat(40),
    });
    const deploying = makeRes();
    await lifecycleHandler(request("tombstone"), deploying);
    expect(deploying.statusCode).toBe(503);

    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it.each([
    ["reserved", { lastReservedGeneration: 8 }],
    [
      "eligible",
      {
        lastReservedGeneration: 8,
        newestEligibleGeneration: 8,
        newestEligibleBuildBatchId: "build-eight",
      },
    ],
  ])("keeps the lifecycle boundary closed while a newer generation is %s", async (
    _state,
    deploymentOverrides,
  ) => {
    await Promise.all([
      seedAsset(),
      seedDeployment(deploymentOverrides),
    ]);
    const lifecycleHandler = handler();

    const response = makeRes();
    await lifecycleHandler(request("tombstone"), response);

    expect(response.statusCode).toBe(503);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
    expect((await db.collection("media_assets_public").doc("asset-one").get())
      .exists).toBe(true);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("returns one missing result for an absent asset and a denied asset", async () => {
    await Promise.all([seedDeployment(), seedAsset()]);
    const deniedHandler = handler({
      requirePrincipalFn: async () => actor([
        { role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] },
      ]),
    });

    const denied = makeRes();
    await deniedHandler(request("tombstone"), denied);
    const absent = makeRes();
    await handler()(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("missing", 2),
      },
      body: { assetId: "missing", action: "tombstone" },
    }), absent);

    expect(denied.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(denied.body).toEqual(absent.body);
  });

  it("returns the current ETag for a stale lifecycle request", async () => {
    await Promise.all([seedDeployment(), seedAsset()]);
    const storageFactory = vi.fn();
    const res = makeRes();

    await handler({ storageFactory })(request("reactivate", 1), res);

    expect(res.statusCode).toBe(412);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 2));
    expect(storageFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["working", "working", null],
    ["published", "published", null],
    ["active deployment", "deployed-7", 7],
  ])("blocks tombstoning while %s usage names the asset", async (_label, id, generation) => {
    await Promise.all([seedDeployment(), seedAsset()]);
    await db.collection("cmsPages/home/mediaUsage").doc(id).set({
      state: generation === null ? id : "deployed",
      ...(generation === null ? { sourceVersion: 4 } : { generation }),
      assetIds: ["asset-one"],
      occurrenceCount: 1,
    });
    const res = makeRes();

    await handler()(request("tombstone"), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/still used/i);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
    expect((await db.collection("media_assets_public").doc("asset-one").get()).exists)
      .toBe(true);
  });

  it("does not tombstone an asset while its binary is being replaced", async () => {
    await Promise.all([seedDeployment(), seedAsset()]);
    await db.collection("system/media/replacements").doc("asset-one").set({
      operation: "replacement",
      state: "object_ready",
      assetId: "asset-one",
    });
    const res = makeRes();

    await handler()(request("tombstone"), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/file replacement is in progress/i);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
  });

  it("ignores deployed use from a generation that is no longer active", async () => {
    await Promise.all([seedDeployment(), seedAsset()]);
    await db.collection("cmsPages/home/mediaUsage").doc("deployed-6").set({
      state: "deployed",
      generation: 6,
      assetIds: ["asset-one"],
      occurrenceCount: 1,
    });
    const res = makeRes();

    await handler()(request("tombstone"), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      changed: true,
      asset: { lifecycle: "tombstoned", version: 3 },
    });
  });

  it("keeps a verified staged generation fenced until the pointer activates it", async () => {
    await Promise.all([
      seedDeployment({ lastReservedGeneration: 8 }),
      seedAsset(),
    ]);
    await Promise.all([
      db.collection("cmsPages/home/mediaUsage").doc("deployed-8").set({
        schemaVersion: 1,
        state: "deployed",
        generation: 8,
        buildBatchId: "build-eight",
        commitSha: "c".repeat(40),
        mediaManifestDigest: "d".repeat(64),
        sourceVersion: 5,
        assetIds: ["asset-one"],
        occurrenceCount: 1,
      }),
      db
        .collection("system/publicDeployment/buildBatches/build-eight/manifests")
        .doc("publicMedia")
        .collection("verifications")
        .doc("complete")
        .set({
          schemaVersion: 1,
          buildBatchId: "build-eight",
          generation: 8,
          mediaManifestDigest: "d".repeat(64),
          ownerCount: 1,
          chunkCount: 1,
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
    ]);
    const res = makeRes();

    await handler()(request("tombstone"), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "Media lifecycle changes are temporarily unavailable.",
      errorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
    expect((await db.collection("media_assets_public").doc("asset-one").get())
      .exists).toBe(true);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("allows schema-two tombstone metadata with missing pins and leaves physical retention to the sweep", async () => {
    await db.doc("system/mediaDiscovery").set({ revision: 0, admission: { schema: 1, activeCount: 1, revision: 0 } });
    await seedAsset();
    await db.doc("system/publicDeployment").set(releaseSelector());
    const storageFactory = vi.fn(), res = makeRes();
    await handler({ storageFactory })(request("tombstone"), res);
    expect(res.statusCode).toBe(200);
    expect((await db.doc("media_assets/asset-one").get()).data()).toMatchObject({ lifecycle: "tombstoned", version: 3 });
    expect((await db.doc("media_assets_public/asset-one").get()).exists).toBe(false);
    expect(storageFactory).not.toHaveBeenCalled();
    expect((await docsIn("admin_logs"))[0].after.retainedReleaseBytes).toBe("pair-retention-unproven");
  });

  it("tombstones metadata and withdraws the projection without touching R2", async () => {
    await db.doc("system/mediaDiscovery").set({ revision: 0, admission: { schema: 1, activeCount: 1, revision: 0 } });
    await Promise.all([
      seedDeployment(),
      seedAsset({
        reactivatedAt: "2026-08-13T19:00:00.000Z",
        reactivatedBy: "editor-before",
      }),
    ]);
    const storageFactory = vi.fn();
    const res = makeRes();

    await handler({ storageFactory })(request("tombstone"), res);

    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().withdrawalRevision).toBe(1);
    expect(res.statusCode).toBe(200);
    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(0);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 3));
    expect(res.body).toEqual({
      success: true,
      changed: true,
      asset: {
        id: "asset-one",
        lifecycle: "tombstoned",
        version: 3,
        etag: formatMediaEtag("asset-one", 3),
      },
    });
    const stored = (await db.collection("media_assets").doc("asset-one").get()).data();
    expect(stored).toMatchObject({
        lifecycle: "tombstoned",
        version: 3,
        tombstonedAt: "2026-08-13T20:45:00.000Z",
        tombstonedBy: "editor-1",
      });
    expect(stored).not.toHaveProperty("reactivatedAt");
    expect(stored).not.toHaveProperty("reactivatedBy");
    expect((await db.collection("media_assets_public").doc("asset-one").get()).exists)
      .toBe(false);
    expect(storageFactory).not.toHaveBeenCalled();
    expect(await docsIn("admin_logs")).toEqual([
      expect.objectContaining({
        actorUid: "editor-1",
        action: "media.lifecycle.tombstone",
        target: "media_assets/asset-one",
      }),
    ]);
    const repeated = makeRes();
    await handler({ storageFactory })(request("tombstone", 3), repeated);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.body.changed).toBe(false);
    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(0);
  });

  it("reactivates only after the exact immutable R2 object is verified", async () => {
    await Promise.all([
      seedDeployment(),
      seedAsset({
        lifecycle: "tombstoned",
        version: 3,
        tombstonedAt: "2026-08-13T20:00:00.000Z",
        tombstonedBy: "editor-before",
      }),
    ]);
    const head = vi.fn(async () => objectHead());
    const res = makeRes();

    await handler({ storageFactory: () => ({ head }) })(request("reactivate", 3), res);

    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(1);
    expect(head).toHaveBeenCalledWith(record().storageKey);
    expect(res.statusCode).toBe(200);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 4));
    expect(res.body).toMatchObject({
      success: true,
      changed: true,
      asset: { id: "asset-one", lifecycle: "active", version: 4 },
    });
    const stored = (await db.collection("media_assets").doc("asset-one").get()).data();
    expect(stored).toMatchObject({
      lifecycle: "active",
      version: 4,
      reactivatedAt: "2026-08-13T20:45:00.000Z",
      reactivatedBy: "editor-1",
    });
    expect((await db.collection("media_assets_public").doc("asset-one").get()).data())
      .toEqual(mediaProjection(stored));
    expect(await docsIn("admin_logs")).toEqual([
      expect.objectContaining({ action: "media.lifecycle.reactivate" }),
    ]);
  });

  it("refuses reactivation when the owner or immutable object does not match", async () => {
    await Promise.all([
      seedDeployment(),
      seedAsset({ lifecycle: "tombstoned", version: 3 }),
    ]);
    const res = makeRes();

    await handler({
      storageFactory: () => ({
        head: vi.fn(async () => objectHead({ contentLength: 127 })),
      }),
    })(request("reactivate", 3), res);

    expect(res.statusCode).toBe(409);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "tombstoned", version: 3 });
    expect((await db.collection("media_assets_public").doc("asset-one").get()).exists)
      .toBe(false);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("refuses reactivation if the object owner changes after the R2 check", async () => {
    await Promise.all([
      seedDeployment(),
      seedAsset({ lifecycle: "tombstoned", version: 3 }),
    ]);
    const res = makeRes();

    await handler({
      storageFactory: () => ({
        head: vi.fn(async () => {
          await db
            .collection("system")
            .doc("media")
            .collection("hashOwners")
            .doc(contentHash)
            .update({ attemptId: "attempt-two" });
          return objectHead();
        }),
      }),
    })(request("reactivate", 3), res);

    expect(res.statusCode).toBe(409);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "tombstoned", version: 3 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("refuses reactivation if deployment reconciliation starts after the R2 check", async () => {
    await Promise.all([
      seedDeployment(),
      seedAsset({ lifecycle: "tombstoned", version: 3 }),
    ]);
    const res = makeRes();

    await handler({
      storageFactory: () => ({
        head: vi.fn(async () => {
          await db.collection("system").doc("publicDeployment").update({
            state: "reconciling",
          });
          return objectHead();
        }),
      }),
    })(request("reactivate", 3), res);

    expect(res.statusCode).toBe(503);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "tombstoned", version: 3 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it.each([
    [{ code: 9 }, 503, "Error", 9],
    [{}, 500, "Error", null],
    [{ code: "failed-precondition" }, 503, "Error", "failed-precondition"],
    [{ status: 503, name: "Private request text", code: "provider /internal/request-fragment" }, 503, "unknown", null],
  ])("masks unexpected media errors with %j while keeping status %i", async (fields, status, errorType, errorCode) => {
    const unavailable = Object.assign(new Error("Provider detail: /internal/request-fragment"), fields);
    const log = { error: vi.fn(), warn: vi.fn() };
    const res = makeRes();

    await handler({
      log,
      firestore: {
        runTransaction: vi.fn(async () => {
          throw unavailable;
        }),
      },
    })(request("tombstone"), res);

    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({
      error: "Failed to change media lifecycle",
      errorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(log.error.mock.calls).toEqual([
      ["cmsSetMediaLifecycle failed", { errorId: res.body.errorId, status, errorType, errorCode }],
    ]);
  });
});

describe("image bin endpoints", () => {
  async function seedBin(overrides = {}) {
    const stored = await seedAsset({ lifecycle: "tombstoned", version: 3,
      tombstonedAt: "2026-08-01T00:00:00.000Z", tombstonedBy: "editor-before",
      purgeAfter: "2026-08-31T00:00:00.000Z", ...overrides });
    await db.collection("mediaCategories").doc("news").set({
      id: "news", label: "News", description: "", active: true, order: 1, version: 1,
    });
    await bin.mediaPurgeRef(db, stored.id).set(bin.createImagePurgeEntry(
      stored.id, stored, stored.tombstonedAt, stored.purgeAfter,
    ));
    return stored;
  }
  function restoreHandler(overrides = {}) {
    return createCmsRestoreMediaHandler({ firestore: db,
      requirePrincipalFn: async () => actor(),
      storageFactory: () => ({ head: async () => objectHead() }),
      now: () => "2026-08-13T20:45:00.000Z", log: { error: vi.fn() }, ...overrides });
  }
  function restoreRequest() {
    const req = request("reactivate", 3);
    delete req.body.action;
    return req;
  }
  it("restores inside 30 days without a deployment fence and atomically cancels the queue and audits", async () => {
    await seedBin();
    const res = makeRes();
    await restoreHandler()(restoreRequest(), res);
    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("media_assets").doc("asset-one").get()).data();
    expect(stored.lifecycle).toBe("active");
    expect(stored).not.toHaveProperty("purgeAfter");
    expect((await bin.mediaPurgeRef(db, "asset-one").get()).data().state).toBe("cancelled");
    expect((await db.collection("media_assets_public").doc("asset-one").get()).exists).toBe(true);
    expect(await docsIn("admin_logs")).toEqual([expect.objectContaining({ action: "media.library.restore" })]);
  });
  describe.each([
    ["restore endpoint", true],
    ["private lifecycle endpoint", false],
  ])("restore authorization at the %s", (_name, restoreOnly) => {
    async function invokeRestore(storageFactory, userDoc = { active: true, grants: [{ role: "editor" }] }) {
      await db.doc("users/editor-1").set(userDoc);
      if (!restoreOnly) await seedDeployment();
      const admittedPrincipal = await principals.registeredPrincipalFromUserDoc(db, "editor-1", userDoc);
      const deps = { storageFactory,
        requirePrincipalFn: async () => ({ ...actor(), principal: admittedPrincipal }) };
      const res = makeRes();
      await (restoreOnly ? restoreHandler(deps) : handler(deps))(
        restoreOnly ? restoreRequest() : request("reactivate", 3), res,
      );
      return res;
    }

    it.each([
      ["inactive account", { active: false, grants: [{ role: "editor" }] }],
      ["demoted account", { active: true, grants: [{ role: "staff" }] }],
      ["deleted account", null],
    ])("refuses the %s revoked during storage verification without changing media", async (_state, userDoc) => {
      const before = await seedBin();
      const queueBefore = (await bin.mediaPurgeRef(db, "asset-one").get()).data();
      await db.doc("system/mediaDiscovery").set({ schema: 1, state: "ready", revision: 7 });
      const res = await invokeRestore(() => ({ head: async () => {
        if (userDoc) await db.doc("users/editor-1").set(userDoc);
        else await db.doc("users/editor-1").delete();
        return objectHead();
      } }));

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: "This media asset is not available." });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect((await db.doc("media_assets/asset-one").get()).data()).toEqual(before);
      expect((await bin.mediaPurgeRef(db, "asset-one").get()).data()).toEqual(queueBefore);
      expect((await db.doc("system/mediaDiscovery").get()).data().revision).toBe(7);
      expect(await docsIn("media_assets_public")).toEqual([]);
      expect(await docsIn("admin_logs")).toEqual([]);
    });

    it("refuses a scoped editor whose area is removed during storage verification", async () => {
      const before = await seedBin();
      await db.doc("sections/news").set({ id: "news", label: "News" });
      const queueBefore = (await bin.mediaPurgeRef(db, "asset-one").get()).data();
      const res = await invokeRestore(() => ({ head: async () => {
        await db.doc("sections/news").delete();
        return objectHead();
      } }), { active: true, grants: [{ role: "editor", sections: ["news"] }] });

      expect(res.statusCode).toBe(404);
      expect((await db.doc("media_assets/asset-one").get()).data()).toEqual(before);
      expect((await bin.mediaPurgeRef(db, "asset-one").get()).data()).toEqual(queueBefore);
      expect(await docsIn("media_assets_public")).toEqual([]);
      expect(await docsIn("admin_logs")).toEqual([]);
    });

    it.each([
      ["legacy editor", { grants: [{ role: "editor" }] }],
      ["registered scoped editor", { active: true, grants: [{ role: "editor", sections: ["news"] }] }],
    ])("allows an authorized %s through the transaction", async (_state, userDoc) => {
      await seedBin();
      await db.doc("sections/news").set({ id: "news", label: "News" });
      const res = await invokeRestore(() => ({ head: async () => objectHead() }), userDoc);

      expect(res.statusCode).toBe(200);
      const restored = (await db.doc("media_assets/asset-one").get()).data();
      expect(restored).toMatchObject({ lifecycle: "active", version: 4, reactivatedBy: "editor-1" });
      expect((await bin.mediaPurgeRef(db, "asset-one").get()).data().state).toBe("cancelled");
      expect((await db.doc("media_assets_public/asset-one").get()).data()).toEqual(mediaProjection(restored));
      expect(await docsIn("admin_logs")).toEqual([expect.objectContaining({
        actorUid: "editor-1", action: restoreOnly ? "media.library.restore" : "media.lifecycle.reactivate",
      })]);
    });
  });
  it("returns the typed conflict when the restored record is invalid", async () => {
    const before = await seedBin({ name: "" });
    const res = makeRes();

    await restoreHandler()(restoreRequest(), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("This media asset record is invalid.");
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toEqual(before);
    expect((await bin.mediaPurgeRef(db, "asset-one").get()).data().state)
      .toBe("pending");
    expect(await docsIn("admin_logs")).toEqual([]);
  });
  it("restores a reverted image using its retained object's original attempt", async () => {
    await seedBin();
    await db.doc(`system/media/hashOwners/${contentHash}`).update({
      operation: "replacement", attemptId: "replacement-attempt", finalObjectAttemptId: attemptId,
    });
    const res = makeRes();
    await restoreHandler()(restoreRequest(), res);
    expect(res.statusCode).toBe(200);
  });
  it.each(["purging", "purged"])("refuses a %s queue before reading storage", async (state) => {
    await seedBin();
    await bin.mediaPurgeRef(db, "asset-one").update({ state });
    const storageFactory = vi.fn();
    const res = makeRes();
    await restoreHandler({ storageFactory })(restoreRequest(), res);
    expect(res.statusCode).toBe(409);
    expect(storageFactory).not.toHaveBeenCalled();
    expect(await docsIn("admin_logs")).toEqual([]);
  });
  it.each(["purging", "purged"])("refuses an asset already marked %s", async (lifecycle) => {
    await seedBin({ lifecycle });
    const storageFactory = vi.fn();
    const res = makeRes();
    await restoreHandler({ storageFactory })(restoreRequest(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/being removed or has already been removed/);
    expect(storageFactory).not.toHaveBeenCalled();
  });
  it("returns the current ETag for a stale restore without reading storage", async () => {
    await seedBin();
    const req = restoreRequest();
    req.headers["if-match"] = formatMediaEtag("asset-one", 2);
    const storageFactory = vi.fn();
    const res = makeRes();
    await restoreHandler({ storageFactory })(req, res);
    expect(res.statusCode).toBe(412);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 3));
    expect(storageFactory).not.toHaveBeenCalled();
  });
  it.each(["admin", "super_admin"])("allows %s to restore a pending image after its deadline", async (role) => {
    await seedBin({ purgeAfter: "2026-08-12T00:00:00.000Z" });
    await db.doc("users/editor-1").set({ active: true, role });
    const requirePrincipalFn = async () => actor([{ role }]);
    const listed = makeRes();
    await binnedList.createCmsListBinnedMediaHandler({ firestore: db, requirePrincipalFn })(makeReq(), listed);
    expect(listed.statusCode).toBe(200);
    expect(listed.body.total).toBe(1);
    const res = makeRes();
    await restoreHandler({ requirePrincipalFn })(restoreRequest(), res);
    expect(res.statusCode).toBe(200);
  });
  it("rechecks the purge claim after the storage check", async () => {
    await seedBin();
    const res = makeRes();
    await restoreHandler({ storageFactory: () => ({ head: async () => {
      await bin.mediaPurgeRef(db, "asset-one").update({ state: "purging" });
      return objectHead();
    } }) })(restoreRequest(), res);
    expect(res.statusCode).toBe(409);
    expect(await docsIn("media_assets_public")).toEqual([]);
  });
  it.each(["pending", "purging"])("keeps the private lifecycle path consistent with a %s queue", async (state) => {
    await seedBin();
    await seedDeployment();
    await bin.mediaPurgeRef(db, "asset-one").update({ state });
    const res = makeRes();
    await handler({ storageFactory: () => ({ head: async () => objectHead() }) })(request("reactivate", 3), res);
    expect(res.statusCode).toBe(state === "pending" ? 200 : 409);
    expect((await bin.mediaPurgeRef(db, "asset-one").get()).data().state)
      .toBe(state === "pending" ? "cancelled" : "purging");
    expect((await db.collection("media_assets").doc("asset-one").get()).data().lifecycle)
      .toBe(state === "pending" ? "active" : "tombstoned");
  });
  it.each(["news", "arts"])("refuses an archived primary or assigned category: %s", async (category) => {
    await seedBin({ categories: ["news", "arts"] });
    await db.collection("mediaCategories").doc("arts").set({
      id: "arts", label: "Arts", description: "", active: true, order: 2, version: 1,
    });
    await db.collection("mediaCategories").doc(category).update({ active: false });
    const res = makeRes();
    await restoreHandler()(restoreRequest(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/categories before restoring/);
    expect(await docsIn("admin_logs")).toEqual([]);
  });
  it.each([true, false])("refuses a full active library and keeps later attempts warm (restoreOnly=%s)", async restoreOnly => {
    await seedBin();
    if (!restoreOnly) await seedDeployment();
    const batch = db.batch();
    for (let i = 0; i < 500; i++) batch.set(db.collection("media_assets").doc(`full-${i}`), { lifecycle: "active" });
    await batch.commit();
    const res = makeRes();
    const call = (firestore = db) => (restoreOnly ? restoreHandler({ firestore }) : handler({ firestore, storageFactory: () => ({ head: async () => objectHead() }) }));
    const req = restoreOnly ? restoreRequest() : request("reactivate", 3);
    await call()(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/full/);
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({ revision: 0, admission: { schema: 1, activeCount: 500, revision: 0 } });
    const guarded = {
      doc: path => db.doc(path),
      runTransaction: fn => db.runTransaction(fn),
      getAll: (...refs) => db.getAll(...refs),
      collection(name) {
        const collection = db.collection(name);
        return name === "media_assets" ? {
          doc: id => collection.doc(id),
          where() { throw new Error("Repeated refused restore scanned active media"); },
        } : collection;
      },
    };
    const repeated = makeRes();
    await call(guarded)(req, repeated);
    expect(repeated.statusCode).toBe(409);
    expect(repeated.body.error).toBe("The active media library is full.");
    expect(await docsIn("admin_logs")).toEqual([]);
  });
  it.each([true, false])("maps media admission ledger overflow to a full-library conflict (restoreOnly=%s)", async restoreOnly => {
    await seedBin();
    if (!restoreOnly) await seedDeployment();
    for (let start = 0; start < 5001; start += 500) {
      const batch = db.batch();
      for (let i = start; i < Math.min(start + 500, 5001); i++) {
        batch.set(db.collection("media_assets").doc(`overflow-${i}`), { lifecycle: "active" });
      }
      await batch.commit();
    }
    await db.doc("system/mediaDiscovery").set({ schema: 1, state: "ready", revision: 1 });
    const res = makeRes();
    await (restoreOnly ? restoreHandler() : handler({ storageFactory: () => ({ head: async () => objectHead() }) }))(
      restoreOnly ? restoreRequest() : request("reactivate", 3), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("The active media library is full.");
    expect((await db.doc("media_assets/asset-one").get()).data().lifecycle).toBe("tombstoned");
    expect(await docsIn("admin_logs")).toEqual([]);
  });
  it("restores the 501st active asset when indexed discovery is ready", async () => {
    await seedBin();
    const batch = db.batch();
    for (let i = 0; i < 500; i++) {
      batch.set(db.collection("media_assets").doc(`full-${i}`), {
        lifecycle: "active",
      });
    }
    await batch.commit();
    await db.doc("system/mediaDiscovery").set({
      schema: 1,
      state: "ready",
      revision: 1,
      sourceSha: "a".repeat(40),
    });
    const res = makeRes();

    await restoreHandler()(restoreRequest(), res);

    expect(res.statusCode).toBe(200);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 4 });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      schema: 1,
      state: "ready",
      revision: 2,
    });
  });
  it.each(["staff", "contributor"])("denies restore and bin listing to %s", async (role) => {
    await seedBin();
    const deps = { firestore: db, requirePrincipalFn: async () => actor([{ role }]) };
    const restored = makeRes();
    await restoreHandler(deps)(restoreRequest(), restored);
    expect(restored.statusCode).toBe(404);
    const listed = makeRes();
    await binnedList.createCmsListBinnedMediaHandler(deps)(makeReq(), listed);
    expect(listed.statusCode).toBe(403);
    expect(await docsIn("admin_logs")).toEqual([]);
  });
  it("requires authentication for both endpoints", async () => {
    const requirePrincipalFn = async () => { throw Object.assign(new Error("Sign in"), { status: 401 }); };
    for (const [handler, req] of [
      [restoreHandler({ requirePrincipalFn }), restoreRequest()],
      [binnedList.createCmsListBinnedMediaHandler({ firestore: db, requirePrincipalFn }), makeReq()],
    ]) {
      const res = makeRes();
      await handler(req, res);
      expect(res.statusCode).toBe(401);
    }
  });
  it("lists all binned images across categories without private keys or audit writes", async () => {
    await seedBin();
    await db.collection("media_assets").doc("hidden").set(record({ category: "arts", lifecycle: "tombstoned", purgeAfter: "2026-08-15T00:00:00.000Z" }));
    await db.collection("media_assets").doc("document").set(record({ kind: "document", mimeType: "application/pdf", lifecycle: "tombstoned", purgeAfter: "2026-08-16T00:00:00.000Z" }));
    const deps = { firestore: db, requirePrincipalFn: async () => actor([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]) };
    const res = makeRes();
    await binnedList.createCmsListBinnedMediaHandler(deps)(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.records.map(row => row.id)).toEqual(["hidden", "asset-one"]);
    expect(res.body.records[0]).not.toHaveProperty("storageKey");
    expect(await docsIn("admin_logs")).toEqual([]);
    const denied = makeRes();
    await restoreHandler({ requirePrincipalFn: async () => actor([{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]) })(restoreRequest(), denied);
    expect(denied.statusCode).toBe(404);
  });
  it("does not expose tombstoning through the restore endpoint", async () => {
    const res = makeRes();
    await restoreHandler()(request("tombstone"), res);
    expect(res.statusCode).toBe(400);
  });
});
