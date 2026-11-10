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
import { readFileSync } from "node:fs";
import adminPkg from "../helpers/firebase-admin.js";
import media from "../../functions/media.js";
import mediaRecovery from "../../functions/media-recovery.js";
import mediaContract from "../../functions/lib/media-contract.js";
import r2Media from "../../functions/lib/r2-media.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const NOW = "2026-08-14T12:16:00.000Z";
const CREATED_AT = "2026-08-14T12:00:00.000Z";
const EXPIRED_AT = "2026-08-14T12:15:00.000Z";
const LIVE_AT = "2026-08-14T12:31:00.000Z";
const HASH = "a".repeat(64);

const {
  MAX_MEDIA_RECOVERY_ATTEMPTS,
  createCmsRecoverMediaUploadsHandler,
  parseMediaRecoveryRequest,
} = mediaRecovery;
const { mediaProjection } = mediaContract;
const { R2MediaStorage } = r2Media;

let db;

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false, headers: {} };
  res.set = (name, value) => {
    res.headers[name.toLocaleLowerCase("en-US")] = value;
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

function actor(grants = [{ role: "editor" }], overrides = {}) {
  return {
    uid: "editor-1",
    email: "editor@example.org",
    principal: { id: "editor-1", grants },
    ...overrides,
  };
}

function claim(contentHash = HASH, overrides = {}) {
  const assetId = overrides.assetId ?? `asset-${contentHash.slice(0, 8)}`;
  const attemptId = overrides.attemptId ?? `attempt-${contentHash.slice(0, 8)}`;
  const category = overrides.category ?? "news";
  const mimeType = overrides.mimeType ?? "image/png";
  return {
    state: "reserved",
    attemptId,
    assetId,
    category,
    finalKey: `cms-media/${category}/${assetId}/${contentHash}.png`,
    stagingKey: `cms-media-staging/${attemptId}`,
    sizeBytes: 68,
    mimeType,
    recordSeed: {
      metadata: {
        name: "Studio control room",
        category,
        description: "The NJ PBS studio control room.",
        altText: "Monitors in the NJ PBS control room",
        license: "NJ PBS owned",
        credit: "NJ PBS",
        tags: ["studio", "newsroom"],
      },
      originalName: "studio.png",
      dimensions: { width: 1, height: 1 },
      actor: {
        uid: overrides.ownerUid ?? "editor-1",
        email: overrides.ownerEmail ?? "editor@example.org",
      },
      source: "203.0.113.7",
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    leaseExpiresAt: EXPIRED_AT,
    ...overrides,
  };
}

function expectedObject(contentHash, owner) {
  return {
    contentLength: owner.sizeBytes,
    contentType: owner.mimeType,
    metadata: {
      contenthash: contentHash,
      assetid: owner.assetId,
      attemptid: owner.attemptId,
      sizebytes: String(owner.sizeBytes),
    },
  };
}

function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    headIfExists: vi.fn(async (key) => objects.get(key) ?? null),
    deleteStaging: vi.fn(async (key) => {
      objects.delete(key);
    }),
    deleteFinal: vi.fn(async () => {
      throw new Error("Recovery must not delete a final object");
    }),
  };
}

function recoveryHandler({
  principal = actor(),
  storage = memoryStorage(),
  now = () => new Date(NOW),
  log = { error: vi.fn(), warn: vi.fn() },
} = {}) {
  return {
    storage,
    log,
    run: createCmsRecoverMediaUploadsHandler({
      firestore: db,
      requirePrincipalFn: async () => principal,
      assertBillingEnabledFn: async () => {},
      storageFactory: () => storage,
      publicOrigin: "https://media.njpbs.org",
      now,
      log,
    }),
  };
}

async function invoke(run, body = {}) {
  const res = makeRes();
  await run(
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.8",
      },
      rawBody: Buffer.from(JSON.stringify(body)),
      body,
      ip: "127.0.0.1",
    },
    res,
  );
  return res;
}

async function seedOwner(contentHash, owner) {
  await db
    .collection("system")
    .doc("media")
    .collection("hashOwners")
    .doc(contentHash)
    .set(owner);
}

async function owner(contentHash = HASH) {
  return (
    await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc(contentHash)
      .get()
  ).data();
}

async function documents(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({
    id: document.id,
    ...document.data(),
  }));
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("media-recovery.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  await db.collection("mediaCategories").doc("news").set({
    id: "news",
    label: "News",
    description: "Newsroom media",
    order: 10,
    active: true,
    version: 1,
  });
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("media recovery request contract", () => {
  it("keeps the reviewed recovery handler out of the production manifest", () => {
    const functionIndex = readFileSync(
      new URL("../../functions/index.js", import.meta.url),
      "utf8",
    );
    expect(functionIndex).not.toContain("cmsRecoverMediaUploads");
    expect(functionIndex).not.toContain("media-recovery");
  });

  it("accepts only a bounded limit and a stable content-hash cursor", () => {
    expect(parseMediaRecoveryRequest({})).toEqual({
      cursor: null,
      limit: MAX_MEDIA_RECOVERY_ATTEMPTS,
    });
    expect(
      parseMediaRecoveryRequest({ cursor: HASH, limit: 1 }),
    ).toEqual({ cursor: HASH, limit: 1 });
    for (const value of [
      null,
      [],
      { unknown: true },
      { cursor: "A".repeat(64) },
      { cursor: "a".repeat(63) },
      { limit: 0 },
      { limit: MAX_MEDIA_RECOVERY_ATTEMPTS + 1 },
      { limit: 1.5 },
    ]) {
      expect(() => parseMediaRecoveryRequest(value)).toThrow();
    }
  });

  it("accepts legacy and current category-assignment upload claims", () => {
    const legacy = claim();
    expect(mediaRecovery.assertMutableOwner(HASH, legacy)).toBe(legacy);

    const current = structuredClone(legacy);
    current.recordSeed.metadata.categories = ["news", "arts"];
    expect(mediaRecovery.assertMutableOwner(HASH, current)).toBe(current);

    for (const requested of [true, false]) {
      const requestedClaim = structuredClone(current);
      requestedClaim.recordSeed.metadata.metadataUpdateRequested = requested;
      expect(mediaRecovery.assertMutableOwner(HASH, requestedClaim)).toBe(requestedClaim);
    }

    current.recordSeed.metadata.categories = ["news", "news"];
    expect(() => mediaRecovery.assertMutableOwner(HASH, current)).toThrow();
  });

  it("accepts a kept or flagged master and rejects a master that could name another object", () => {
    const masterHash = "b".repeat(64);
    const master = {
      retained: true,
      key: `masters/bb/${masterHash}.jpg`,
      contentHash: masterHash,
      mimeType: "image/jpeg",
      sizeBytes: 1_000,
      width: 9_000,
      height: 6_000,
    };
    const kept = claim();
    kept.recordSeed.master = master;
    expect(mediaRecovery.assertMutableOwner(HASH, kept)).toBe(kept);

    const flagged = claim();
    const { key: _key, ...rest } = master;
    flagged.recordSeed.master = { ...rest, retained: false, reason: "not-configured" };
    expect(mediaRecovery.assertMutableOwner(HASH, flagged)).toBe(flagged);

    const pending = claim();
    pending.recordSeed.master = { ...master, retained: false, reason: "pending" };
    expect(mediaRecovery.assertMutableOwner(HASH, pending)).toBe(pending);
    pending.recordSeed.master = {
      ...rest, mimeType: "image/webp", retained: false, reason: "pending",
    };
    expect(mediaRecovery.assertMutableOwner(HASH, pending)).toBe(pending);

    for (const bad of [
      { ...master, key: "cms-media/news/asset/public.jpg" },
      { ...master, mimeType: "image/webp", key: `masters/bb/${masterHash}.webp` },
      { ...master, extra: true },
      { ...rest, retained: false, reason: "because" },
      { ...rest, retained: false, reason: "pending" },
      { ...master, retained: false, reason: "pending", extra: true },
      { ...master, width: 20_000, height: 20_000 },
    ]) {
      const owner = claim();
      owner.recordSeed.master = bad;
      expect(() => mediaRecovery.assertMutableOwner(HASH, owner)).toThrow();
    }
  });

  it("denies a caller without media upload authority before storage access", async () => {
    const storage = memoryStorage();
    const instance = recoveryHandler({
      principal: actor([{ role: "contributor" }]),
      storage,
    });

    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "You do not have permission to recover media uploads.",
    });
    expect(storage.headIfExists).not.toHaveBeenCalled();
  });
});

describe("bounded stale media upload recovery", () => {
  it.each([undefined, false, true])("commits a not-retained master with metadata request %s after a resume crashes", async (requested) => {
    const intent = media.masterIntent(
      { buffer: Buffer.from("original"), mimeType: "image/png" },
      { width: 1, height: 1 },
    );
    const { key: _key, ...master } = intent;
    const failedMaster = { ...master, reason: "store-failed" };
    const pending = claim(HASH, { state: "object_ready", objectReadyAt: CREATED_AT });
    pending.recordSeed.master = failedMaster;
    if (requested !== undefined) pending.recordSeed.metadata.metadataUpdateRequested = requested;
    await seedOwner(HASH, pending);
    const retry = claim(HASH, { updatedAt: NOW, leaseExpiresAt: LIVE_AT });
    retry.recordSeed.master = intent;
    if (requested !== undefined) retry.recordSeed.metadata.metadataUpdateRequested = requested;
    const reservation = await media.reserveHashOwner({
      firestore: db, contentHash: HASH, claim: retry,
      nowDate: new Date(NOW), principal: actor().principal,
    });
    expect(reservation.resumed).toBe(true);
    expect((await owner()).recordSeed.master).toEqual(intent);

    const crash = vi.spyOn(db, "runTransaction").mockRejectedValueOnce(new Error("crash"));
    try {
      await expect(media.recordMasterResult({
        firestore: db, refs: [media.ownerRef(db, HASH)],
        attemptId: pending.attemptId, master: failedMaster,
      })).rejects.toThrow("crash");
    } finally {
      crash.mockRestore();
    }
    expect(await owner()).toMatchObject({
      state: "object_ready", recordSeed: { master: intent },
    });
    const storage = memoryStorage();
    storage.objects.set(pending.finalKey, expectedObject(HASH, pending));
    const instance = recoveryHandler({ storage, now: () => new Date(LIVE_AT) });
    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([{
      contentHash: HASH, attemptId: pending.attemptId,
      state: "committed", idempotent: false,
    }]);
    expect((await owner()).recordSeed.master).toEqual(failedMaster);
    const asset = (await db.collection("media_assets").doc(pending.assetId).get()).data();
    expect(asset.master).toEqual(failedMaster);
    expect(asset.metadataUpdateRequested).toBe(requested === true);
    expect(storage.deleteFinal).not.toHaveBeenCalled();
    const repeated = await invoke(instance.run, { limit: 1 });
    expect(repeated.body.attempts[0]).toMatchObject({ state: "committed", idempotent: true });
  });

  it("refuses a pending master intent whose key names a different object", async () => {
    const pending = claim(HASH, { state: "object_ready", objectReadyAt: CREATED_AT });
    pending.recordSeed.master = {
      ...media.masterIntent(
        { buffer: Buffer.from("original"), mimeType: "image/png" },
        { width: 1, height: 1 },
      ),
      key: `masters/bb/${"b".repeat(64)}.png`,
    };
    await seedOwner(HASH, pending);
    const instance = recoveryHandler();
    const res = await invoke(instance.run, { limit: 1 });

    expect(res.body.attempts).toEqual([{
      contentHash: HASH, state: "error", code: "invalid_claim", retryable: false,
    }]);
    expect(await owner()).toEqual(pending);
    expect(instance.storage.headIfExists).not.toHaveBeenCalled();
    expect(await documents("media_assets")).toHaveLength(0);
  });

  it("releases a stale attempt with no final object for same-file retry", async () => {
    const pending = claim();
    await seedOwner(HASH, pending);
    const instance = recoveryHandler();

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      scanned: 1,
      nextCursor: null,
      attempts: [
        {
          contentHash: HASH,
          attemptId: pending.attemptId,
          state: "pending",
          reason: "final_object_missing",
          idempotent: false,
        },
      ],
    });
    expect(await owner()).toMatchObject({
      state: "reserved",
      attemptId: pending.attemptId,
      assetId: pending.assetId,
      updatedAt: NOW,
      leaseExpiresAt: NOW,
      resumedAt: NOW,
      recoveryCount: 1,
    });
    expect(instance.storage.deleteStaging).toHaveBeenCalledWith(
      pending.stagingKey,
    );
    expect(instance.storage.deleteFinal).not.toHaveBeenCalled();
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  // A finished object that is gone is destroyed evidence, and the discard that
  // destroyed it may have died before it could write its own row (#205). A
  // reserved attempt that never had an object is not that case, and the test
  // above pins that it still writes nothing.
  it("finishes an interrupted discard by appending the receipt the destroyed object needs", async () => {
    const pending = claim(HASH, {
      state: "object_ready",
      objectReadyAt: CREATED_AT,
    });
    await seedOwner(HASH, pending);
    const instance = recoveryHandler();

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([
      {
        contentHash: HASH,
        attemptId: pending.attemptId,
        state: "pending",
        reason: "final_object_missing",
        idempotent: false,
      },
    ]);
    const rows = await documents("admin_logs");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUid: "editor-1",
      actorEmail: "editor@example.org",
      action: "media.upload.discard",
      target: `media_assets/${pending.assetId}`,
      after: null,
    });
    expect(rows[0].before).toMatchObject({
      attemptId: pending.attemptId,
      contentHash: HASH,
      storageKey: pending.finalKey,
      reason: "final_object_missing",
    });
  });

  it("does not write a second discard receipt for the same attempt", async () => {
    const pending = claim(HASH, {
      state: "object_ready",
      objectReadyAt: CREATED_AT,
    });
    await seedOwner(HASH, pending);
    const instance = recoveryHandler();

    expect((await invoke(instance.run, { limit: 1 })).statusCode).toBe(200);
    expect((await invoke(instance.run, { limit: 1 })).statusCode).toBe(200);

    expect(await documents("admin_logs")).toHaveLength(1);
  });

  it("retries an exact abandoned receipt without a second audit write", async () => {
    const pending = claim();
    await seedOwner(HASH, pending);
    const storage = memoryStorage();
    storage.objects.set(pending.finalKey, {
      ...expectedObject(HASH, pending),
      contentLength: pending.sizeBytes + 1,
    });
    const instance = recoveryHandler({ storage });
    expect((await invoke(instance.run, { limit: 1 })).statusCode).toBe(200);
    const receipt = await owner();

    const retry = await invoke(instance.run, { limit: 1 });

    expect(retry.statusCode).toBe(200);
    expect(retry.body.attempts).toEqual([
      {
        contentHash: HASH,
        attemptId: pending.attemptId,
        state: "abandoned",
        reason: "final_object_mismatch",
        idempotent: true,
      },
    ]);
    expect(await owner()).toEqual(receipt);
    expect(await documents("admin_logs")).toHaveLength(1);
    expect(instance.storage.deleteStaging).toHaveBeenCalledTimes(2);
    expect(instance.storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("commits the original record when the stale attempt owns an exact final object", async () => {
    const pending = claim();
    await seedOwner(HASH, pending);
    const storage = memoryStorage();
    storage.objects.set(pending.finalKey, expectedObject(HASH, pending));
    storage.objects.set(pending.stagingKey, { staging: true });
    const instance = recoveryHandler({ storage });

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([
      {
        contentHash: HASH,
        attemptId: pending.attemptId,
        state: "committed",
        idempotent: false,
      },
    ]);
    expect(await owner()).toMatchObject({
      state: "committed",
      attemptId: pending.attemptId,
      assetId: pending.assetId,
    });
    expect(await documents("media_assets")).toEqual([
      expect.objectContaining({
        id: pending.assetId,
        contentHash: HASH,
        storageKey: pending.finalKey,
        createdAt: CREATED_AT,
        updatedAt: NOW,
        createdBy: "editor-1",
        updatedBy: "editor-1",
      }),
    ]);
    expect(await documents("media_assets_public")).toEqual([
      expect.objectContaining({
        id: pending.assetId,
        url: `https://media.njpbs.org/${pending.finalKey}`,
      }),
    ]);
    expect(storage.objects.has(pending.finalKey)).toBe(true);
    expect(storage.objects.has(pending.stagingKey)).toBe(false);
    expect(storage.deleteFinal).not.toHaveBeenCalled();
    expect(await documents("admin_logs")).toEqual([
      expect.objectContaining({
        actorUid: "editor-1",
        action: "media.upload",
        target: `media_assets/${pending.assetId}`,
      }),
    ]);
  });

  it("abandons a mismatched final object without deleting it", async () => {
    const pending = claim();
    await seedOwner(HASH, pending);
    const storage = memoryStorage();
    storage.objects.set(pending.finalKey, {
      ...expectedObject(HASH, pending),
      contentLength: pending.sizeBytes + 1,
    });
    const instance = recoveryHandler({ storage });

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts[0]).toMatchObject({
      state: "abandoned",
      reason: "final_object_mismatch",
      idempotent: false,
    });
    expect(await owner()).toEqual({
      schemaVersion: 1,
      state: "abandoned",
      contentHash: HASH,
      attemptId: pending.attemptId,
      assetId: pending.assetId,
      category: "news",
      finalKey: pending.finalKey,
      stagingKey: pending.stagingKey,
      sizeBytes: 68,
      mimeType: "image/png",
      recordSeed: pending.recordSeed,
      createdAt: CREATED_AT,
      previousState: "reserved",
      abandonedAt: NOW,
      abandonedReason: "final_object_mismatch",
      abandonedBy: {
        uid: "editor-1",
        email: "editor@example.org",
      },
    });
    expect(storage.objects.has(pending.finalKey)).toBe(true);
    expect(storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("leaves the lease-backed claim unchanged after an unknown R2 read error", async () => {
    const pending = claim();
    await seedOwner(HASH, pending);
    const storage = memoryStorage();
    storage.headIfExists.mockRejectedValueOnce(
      new Error("R2 authorization service unavailable"),
    );
    const instance = recoveryHandler({ storage });

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([
      {
        contentHash: HASH,
        state: "error",
        code: "retryable",
        retryable: true,
      },
    ]);
    expect(await owner()).toMatchObject({
      state: "reserved",
      attemptId: pending.attemptId,
      leaseExpiresAt: LIVE_AT,
    });
    expect(await documents("admin_logs")).toHaveLength(0);
    expect(storage.deleteStaging).not.toHaveBeenCalled();
    expect(storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("does not inspect R2 for a live attempt", async () => {
    const pending = claim(HASH, { leaseExpiresAt: LIVE_AT });
    await seedOwner(HASH, pending);
    const instance = recoveryHandler();

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([
      {
        contentHash: HASH,
        attemptId: pending.attemptId,
        state: "live",
        idempotent: true,
      },
    ]);
    expect(instance.storage.headIfExists).not.toHaveBeenCalled();
    expect(instance.storage.deleteStaging).not.toHaveBeenCalled();
    expect(instance.storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("does not trust a committed owner without the atomic asset records", async () => {
    const committed = claim(HASH, {
      state: "committed",
      objectReadyAt: CREATED_AT,
      committedAt: CREATED_AT,
    });
    await seedOwner(HASH, committed);
    const instance = recoveryHandler();

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([
      {
        contentHash: HASH,
        state: "error",
        code: "retryable",
        retryable: true,
      },
    ]);
    expect(await owner()).toEqual(committed);
    expect(instance.storage.deleteStaging).not.toHaveBeenCalled();
    expect(instance.storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("accepts current metadata after an exact committed upload", async () => {
    const committed = claim(HASH, {
      state: "committed",
      objectReadyAt: CREATED_AT,
      committedAt: CREATED_AT,
    });
    const original = media.uploadRecordFromClaim({
      contentHash: HASH,
      claim: committed,
      publicOrigin: "https://media.njpbs.org",
      nowIso: CREATED_AT,
    });
    const current = {
      ...original,
      altText: "An updated description of the studio control room",
      version: 2,
      updatedAt: NOW,
      updatedBy: "editor-2",
    };
    await Promise.all([
      seedOwner(HASH, committed),
      db.collection("media_assets").doc(committed.assetId).set(current),
      db
        .collection("media_assets_public")
        .doc(committed.assetId)
        .set(mediaProjection(current)),
    ]);
    const storage = memoryStorage();
    storage.objects.set(committed.stagingKey, { staging: true });
    const instance = recoveryHandler({ storage });

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([
      {
        contentHash: HASH,
        attemptId: committed.attemptId,
        state: "committed",
        idempotent: true,
      },
    ]);
    expect(await documents("media_assets")).toEqual([
      expect.objectContaining({
        id: committed.assetId,
        altText: current.altText,
        version: 2,
      }),
    ]);
    expect(await documents("media_assets_public")).toEqual([
      {
        id: committed.assetId,
        ...mediaProjection(current),
      },
    ]);
    expect(storage.deleteStaging).toHaveBeenCalledWith(committed.stagingKey);
    expect(storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("accepts an exact tombstoned committed upload only for recovery", async () => {
    const committed = claim(HASH, {
      state: "committed",
      objectReadyAt: CREATED_AT,
      committedAt: CREATED_AT,
    });
    const original = media.uploadRecordFromClaim({
      contentHash: HASH,
      claim: committed,
      publicOrigin: "https://media.njpbs.org",
      nowIso: CREATED_AT,
    });
    const tombstoned = {
      ...original,
      lifecycle: "tombstoned",
      version: 2,
      updatedAt: NOW,
      updatedBy: "editor-2",
      tombstonedAt: NOW,
      tombstonedBy: "editor-2",
    };
    await Promise.all([
      seedOwner(HASH, committed),
      db.collection("media_assets").doc(committed.assetId).set(tombstoned),
    ]);
    const storage = memoryStorage();
    storage.objects.set(committed.stagingKey, { staging: true });

    await expect(
      media.committedUpload(db, {
        contentHash: HASH,
        attemptId: committed.attemptId,
        record: original,
      }),
    ).resolves.toBe(false);

    const res = await invoke(recoveryHandler({ storage }).run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toEqual([
      {
        contentHash: HASH,
        attemptId: committed.attemptId,
        state: "committed",
        idempotent: true,
      },
    ]);
    expect(await documents("media_assets_public")).toHaveLength(0);
    expect(await documents("media_assets")).toEqual([
      expect.objectContaining({
        id: committed.assetId,
        lifecycle: "tombstoned",
        version: 2,
      }),
    ]);
    expect(storage.deleteStaging).toHaveBeenCalledWith(committed.stagingKey);
    expect(storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("uses an owner-scoped stable cursor and a hard page cap", async () => {
    const hashes = Array.from({ length: MAX_MEDIA_RECOVERY_ATTEMPTS + 2 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    await Promise.all(
      hashes.map((contentHash) =>
        seedOwner(contentHash, claim(contentHash, { leaseExpiresAt: LIVE_AT })),
      ),
    );
    const otherHash = "f".repeat(64);
    await seedOwner(
      otherHash,
      claim(otherHash, {
        ownerUid: "editor-2",
        ownerEmail: "fixture-e396eca9ea@example.org",
        leaseExpiresAt: LIVE_AT,
      }),
    );
    const instance = recoveryHandler();

    const first = await invoke(instance.run, {
      limit: MAX_MEDIA_RECOVERY_ATTEMPTS,
    });
    const second = await invoke(instance.run, {
      cursor: first.body.nextCursor,
      limit: MAX_MEDIA_RECOVERY_ATTEMPTS,
    });

    expect(first.statusCode).toBe(200);
    expect(first.body.scanned).toBe(MAX_MEDIA_RECOVERY_ATTEMPTS);
    expect(first.body.attempts.map((entry) => entry.contentHash)).toEqual(
      hashes.slice(0, MAX_MEDIA_RECOVERY_ATTEMPTS),
    );
    expect(first.body.nextCursor).toBe(
      hashes[MAX_MEDIA_RECOVERY_ATTEMPTS - 1],
    );
    expect(second.statusCode).toBe(200);
    expect(second.body.scanned).toBe(2);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.attempts.map((entry) => entry.contentHash)).toEqual(
      hashes.slice(MAX_MEDIA_RECOVERY_ATTEMPTS),
    );
    expect(
      [...first.body.attempts, ...second.body.attempts].some(
        (entry) => entry.contentHash === otherHash,
      ),
    ).toBe(false);
    expect(instance.storage.headIfExists).not.toHaveBeenCalled();
  });

  it("skips replacement owners without changing them or reporting upload errors", async () => {
    const replacementHash = "0".repeat(64);
    const uploadHash = "1".repeat(64);
    const replacementOwner = {
      operation: "replacement",
      state: "reserved",
      assetId: "asset-existing",
      attemptId: "replacement-attempt",
      contentHash: replacementHash,
      category: "news",
      recordSeed: {
        actor: { uid: "editor-1", email: "editor@example.org" },
      },
      leaseExpiresAt: EXPIRED_AT,
    };
    await Promise.all([
      seedOwner(replacementHash, replacementOwner),
      seedOwner(uploadHash, claim(uploadHash, { leaseExpiresAt: LIVE_AT })),
    ]);
    const instance = recoveryHandler();

    const response = await invoke(instance.run, { limit: 2 });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      scanned: 2,
      nextCursor: null,
      attempts: [
        {
          contentHash: uploadHash,
          attemptId: `attempt-${uploadHash.slice(0, 8)}`,
          state: "live",
          idempotent: true,
        },
      ],
    });
    expect(await owner(replacementHash)).toEqual(replacementOwner);
    expect(instance.storage.headIfExists).not.toHaveBeenCalled();
    expect(instance.storage.deleteStaging).not.toHaveBeenCalled();
    expect(instance.storage.deleteFinal).not.toHaveBeenCalled();
    expect(instance.log.error).not.toHaveBeenCalled();
  });

  it("rejects a replacement owner re-read inside the recovery transaction", async () => {
    const replacementOwner = {
      operation: "replacement",
      state: "reserved",
      assetId: "asset-existing",
      attemptId: "replacement-attempt",
      contentHash: HASH,
      category: "news",
      recordSeed: {
        actor: { uid: "editor-1", email: "editor@example.org" },
      },
      leaseExpiresAt: EXPIRED_AT,
    };
    await seedOwner(HASH, replacementOwner);
    const storage = memoryStorage();

    await expect(
      mediaRecovery.recoverOneUpload({
        firestore: db,
        storage,
        contentHash: HASH,
        user: actor(),
        nowDate: new Date(NOW),
        publicOrigin: "https://media.njpbs.org",
        source: "203.0.113.8",
      }),
    ).rejects.toMatchObject({
      status: 409,
      recoveryCode: "not_upload",
    });
    expect(await owner()).toEqual(replacementOwner);
    expect(storage.headIfExists).not.toHaveBeenCalled();
    expect(storage.deleteStaging).not.toHaveBeenCalled();
    expect(storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("recovers a pending owner across categories and continues through the page", async () => {
    const pending = claim(HASH, { category: "arts" });
    await seedOwner(HASH, pending);
    const nextHash = "b".repeat(64);
    await seedOwner(
      nextHash,
      claim(nextHash, { leaseExpiresAt: LIVE_AT }),
    );
    const instance = recoveryHandler({
      principal: actor([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]),
    });

    const res = await invoke(instance.run, { limit: 2 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      scanned: 2,
      nextCursor: null,
      attempts: [
        {
          contentHash: HASH,
          attemptId: "attempt-aaaaaaaa",
          state: "pending",
          reason: "final_object_missing",
          idempotent: false,
        },
        {
          contentHash: nextHash,
          attemptId: `attempt-${nextHash.slice(0, 8)}`,
          state: "live",
          idempotent: true,
        },
      ],
    });
    expect(await owner()).toMatchObject({ state: "reserved", category: "arts" });
    expect(instance.storage.headIfExists).toHaveBeenCalledWith(pending.finalKey);
    expect(instance.storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("fails closed on malformed pending and abandoned owner contracts", async () => {
    const malformedPending = claim(HASH, { unexpected: true });
    await seedOwner(HASH, malformedPending);
    const instance = recoveryHandler();

    const pendingResponse = await invoke(instance.run, { limit: 1 });

    expect(pendingResponse.statusCode).toBe(200);
    expect(pendingResponse.body.attempts).toEqual([
      {
        contentHash: HASH,
        state: "error",
        code: "invalid_claim",
        retryable: false,
      },
    ]);
    expect(await owner()).toEqual(malformedPending);
    expect(instance.storage.headIfExists).not.toHaveBeenCalled();

    await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc(HASH)
      .update({ state: "abandoned" });
    const abandonedResponse = await invoke(instance.run, { limit: 1 });
    expect(abandonedResponse.statusCode).toBe(200);
    expect(abandonedResponse.body.attempts).toEqual([
      {
        contentHash: HASH,
        state: "error",
        code: "invalid_claim",
        retryable: false,
      },
    ]);
    expect(instance.storage.deleteStaging).not.toHaveBeenCalled();
    expect(instance.storage.deleteFinal).not.toHaveBeenCalled();
  });

  it("keeps a matching final object retryable when the media cap is full", async () => {
    const batch = db.batch();
    for (let index = 0; index < 500; index += 1) {
      batch.set(db.collection("media_assets").doc(`seed-${index}`), {
        lifecycle: "active",
      });
    }
    await batch.commit();
    const pending = claim();
    await seedOwner(HASH, pending);
    const storage = memoryStorage();
    storage.objects.set(pending.finalKey, expectedObject(HASH, pending));
    const instance = recoveryHandler({ storage });

    const res = await invoke(instance.run, { limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.attempts[0]).toMatchObject({
      state: "pending",
      reason: "capacity_limit",
      idempotent: false,
    });
    expect(await owner()).toMatchObject({
      state: "object_ready",
      attemptId: pending.attemptId,
      leaseExpiresAt: NOW,
    });
    expect(storage.objects.has(pending.finalKey)).toBe(true);
    expect(storage.deleteFinal).not.toHaveBeenCalled();
    expect(await documents("media_assets")).toHaveLength(500);
  });

  it("discards a matching final object when its category is inactive", async () => {
    const pending = claim(HASH, {
      state: "object_ready",
      objectReadyAt: CREATED_AT,
    });
    await seedOwner(HASH, pending);
    await db
      .collection("mediaCategories")
      .doc("news")
      .update({ active: false });
    const storage = memoryStorage();
    storage.objects.set(pending.finalKey, expectedObject(HASH, pending));
    storage.objects.set(pending.stagingKey, { body: Buffer.from("staging") });
    storage.deleteFinal = vi.fn(async (key) => {
      storage.objects.delete(key);
    });
    const instance = recoveryHandler({ storage });

    const response = await invoke(instance.run, { limit: 1 });

    expect(response.statusCode).toBe(200);
    expect(response.body.attempts).toEqual([
      {
        contentHash: HASH,
        attemptId: pending.attemptId,
        state: "abandoned",
        reason: "invalid_category",
        idempotent: false,
      },
    ]);
    expect(await owner()).toBeUndefined();
    expect(storage.objects.size).toBe(0);
    expect(storage.deleteFinal).toHaveBeenCalledWith(pending.finalKey);
    expect(storage.deleteStaging).toHaveBeenCalledWith(pending.stagingKey);
    expect(await documents("media_assets")).toHaveLength(0);
    expect(await documents("admin_logs")).toEqual([
      expect.objectContaining({
        action: "media.upload.discard",
        before: expect.objectContaining({
          category: "news",
          reason: "invalid_media_category",
        }),
        after: null,
      }),
    ]);
  });

  it("serializes concurrent recovery so only one caller touches R2", async () => {
    const pending = claim();
    await seedOwner(HASH, pending);
    const storage = memoryStorage();
    storage.objects.set(pending.finalKey, expectedObject(HASH, pending));
    let releaseHead;
    const headStarted = new Promise((resolve) => {
      storage.headIfExists.mockImplementationOnce(
        () =>
          new Promise((release) => {
            releaseHead = () => {
              release(storage.objects.get(pending.finalKey));
              resolve();
            };
          }),
      );
    });
    const instance = recoveryHandler({ storage });

    const firstPromise = invoke(instance.run, { limit: 1 });
    while (storage.headIfExists.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const second = await invoke(instance.run, { limit: 1 });
    releaseHead();
    await headStarted;
    const first = await firstPromise;

    expect([first.body.attempts[0].state, second.body.attempts[0].state].sort()).toEqual([
      "committed",
      "live",
    ]);
    expect(storage.headIfExists).toHaveBeenCalledTimes(1);
    expect(await documents("media_assets")).toHaveLength(1);
    expect(await documents("admin_logs")).toHaveLength(1);
    expect(storage.deleteFinal).not.toHaveBeenCalled();
  });
});

describe("R2 recovery reads", () => {
  it("returns null only for an authoritative missing-object result", async () => {
    const missing = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      Code: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const client = { send: vi.fn().mockRejectedValueOnce(missing) };
    const storage = new R2MediaStorage({ bucket: "cms-media", client });

    await expect(storage.headIfExists("missing-key")).resolves.toBeNull();

    const genericMissing = Object.assign(new Error("not found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    client.send.mockRejectedValueOnce(genericMissing);
    await expect(storage.headIfExists("generic-missing-key")).resolves.toBeNull();

    const forbidden = Object.assign(new Error("forbidden"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    client.send.mockRejectedValueOnce(forbidden);
    await expect(storage.headIfExists("forbidden-key")).rejects.toBe(forbidden);

    const unknown = new Error("R2 unavailable");
    client.send.mockRejectedValueOnce(unknown);
    await expect(storage.headIfExists("unknown-key")).rejects.toBe(unknown);
  });
});

describe("new upload after a completed permanent purge", () => {
  it("archives the purge receipt and reserves new bytes without reviving the deleted asset", async () => {
    const previous = claim(HASH, { state: "purged", assetId: "purged-asset", attemptId: "purged-attempt" });
    await seedOwner(HASH, previous);
    const next = claim(HASH, { attemptId: "new-attempt", assetId: "new-asset", leaseExpiresAt: LIVE_AT });
    const result = await media.reserveHashOwner({ firestore: db, contentHash: HASH, claim: next,
      nowDate: new Date(NOW), principal: actor().principal });
    expect(result).toMatchObject({ claim: next, resumed: false });
    expect(result.ref.path).toBe(`system/media/hashOwners/${HASH}`);
    expect(await owner()).toEqual(next);
    expect((await media.ownerRef(db, HASH).collection("superseded").doc("purged-attempt").get()).data()).toEqual(previous);
  });
  it("continues to refuse reuse while a deletion fence is active", async () => {
    await seedOwner(HASH, claim(HASH, { state: "purging" }));
    await expect(media.reserveHashOwner({ firestore: db, contentHash: HASH, claim: claim(),
      nowDate: new Date(NOW), principal: actor().principal })).rejects.toMatchObject({ status: 503 });
  });
});
