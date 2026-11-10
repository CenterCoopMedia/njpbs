import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import collections from "../../functions/media-collections.js";
import contract from "../../functions/lib/media-collections.js";

const {
  createCmsListMediaCollectionItemsHandler,
  createCmsListMediaCollectionsHandler,
  createCmsMutateMediaCollectionHandler,
  createCmsSetMediaCollectionItemsHandler,
} = collections;
const {
  collectionDocumentId,
  collectionRequestDocumentId,
  parseListCollectionsRequest,
  parseMutateCollectionRequest,
  parseSetCollectionItemsRequest,
  requestFingerprint,
} = contract;

const actor = (
  uid = "staff-1",
  approvedActive = true,
  grants = [{ role: "super_admin" }],
  overrides = {},
) => ({
  uid,
  email: `${uid}@example.org`,
  emailVerified: true,
  approvedActive,
  principal: { id: uid, grants },
  ...overrides,
});

function response() {
  const res = { statusCode: 0, body: null, headersSent: false, headers: new Map() };
  res.set = (name, value) => { res.headers.set(name.toLowerCase(), value); return res; };
  res.status = (statusCode) => { res.statusCode = statusCode; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  return res;
}

function request(body, appCheck = false) {
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...(appCheck ? { "x-firebase-appcheck": "app-check-token" } : {}),
    },
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function storedAsset(overrides = {}) {
  return {
    name: "Collection image",
    originalName: "collection.png",
    category: "news",
    categories: ["news"],
    tags: [],
    description: null,
    altText: "Collection image",
    license: "Station owned",
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 10,
    height: 10,
    url: "https://media.njpbs.org/cms-media/news/collection.png",
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
  return storedAsset({
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

function storedSourceAsset(id, overrides = {}) {
  return {
    sourceId: "video-library",
    lifecycle: "active",
    name: `Video ${id}`,
    originalName: `${id}.mp4`,
    description: null,
    nameSort: `video ${id}`,
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
    objectKey: `${id}.mp4`,
    objectVersionId: "private-version",
    ...overrides,
  };
}

describe("media collection contract", () => {
  it("declares the private and all-staff list indexes", () => {
    const indexes = JSON.parse(readFileSync(
      new URL("../../firestore.indexes.json", import.meta.url),
      "utf8",
    )).indexes.filter((index) => index.collectionGroup === "mediaCollections");
    expect(indexes).toHaveLength(2);
    expect(indexes.map((index) => index.fields.map((field) => field.fieldPath)))
      .toEqual(expect.arrayContaining([
        ["scope", "ownerUid", "lifecycle", "updatedAt", "__name__"],
        ["scope", "lifecycle", "updatedAt", "__name__"],
      ]));
  });

  it("uses actor-bound deterministic ids and strict private or all-staff scopes", () => {
    expect(collectionDocumentId("staff-1", "request_12345678"))
      .toMatch(/^[0-9a-f]{64}$/);
    expect(collectionDocumentId("staff-1", "request_12345678"))
      .not.toBe(collectionDocumentId("staff-2", "request_12345678"));
    expect(parseMutateCollectionRequest({
      action: "create",
      requestId: "request_12345678",
      scope: "all_staff",
      name: "  Shared selects  ",
    })).toMatchObject({ scope: "all_staff", name: "Shared selects" });
    expect(() => parseMutateCollectionRequest({
      action: "create",
      requestId: "request_12345678",
      scope: "team",
      name: "Unapproved scope",
    })).toThrow(/scope/i);
    expect(parseMutateCollectionRequest({
      action: "create",
      requestId: "request_12345678",
      scope: "private",
      name: "Shore b-roll",
      color: "blue",
    })).toMatchObject({ color: "blue" });
    const omittedColor = parseMutateCollectionRequest({
      action: "create",
      requestId: "request_12345678",
      scope: "private",
      name: "Shore b-roll",
    });
    expect(omittedColor).not.toHaveProperty("color");
    expect(requestFingerprint(omittedColor)).toBe(requestFingerprint({
      action: "create",
      requestId: "request_12345678",
      scope: "private",
      name: "Shore b-roll",
      description: "",
    }));
    expect(() => parseMutateCollectionRequest({
      action: "create",
      requestId: "request_12345678",
      scope: "private",
      name: "Shore b-roll",
      color: "pink",
    })).toThrow(/color/i);
  });

  it("rejects storage coordinates, unknown fields, oversized batches, and unbound cursors", () => {
    expect(() => parseSetCollectionItemsRequest({
      collectionId: "a".repeat(64),
      requestId: "request_12345678",
      baseMembershipVersion: 1,
      present: true,
      refs: [{ backend: "r2", id: "asset-1", storageKey: "private" }],
    })).toThrow(/unknown asset reference field/i);
    expect(() => parseSetCollectionItemsRequest({
      collectionId: "a".repeat(64),
      requestId: "request_12345678",
      baseMembershipVersion: 1,
      present: true,
      refs: Array.from({ length: 31 }, (_, index) => ({
        backend: "r2",
        id: `asset-${index}`,
      })),
    })).toThrow(/too many/i);
    expect(() => parseListCollectionsRequest({
      scope: "private",
      lifecycle: "active",
      cursor: Buffer.from(JSON.stringify({
        v: 1,
        uid: "other",
        scope: "private",
        lifecycle: "active",
        kind: "collections",
        seconds: 1,
        nanoseconds: 0,
        id: "a".repeat(64),
      })).toString("base64url"),
    }, "staff-1")).toThrow(/cursor/i);
  });
});

describe("media collection service", () => {
  let db;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error("Use the Firestore emulator for media collection tests");
    }
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("media-collections.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
      { method: "DELETE" }, db);
    await db.doc("media_assets/asset-1").set(storedAsset());
    await db.doc("media_assets/asset-2").set(storedAsset({ name: "Second image" }));
    await Promise.all([
      "staff-1", "staff-2", "voiceover-collector", "voiceover-collector-2",
      "voiceover-collector-3",
    ].map((uid) => db.doc(`users/${uid}`).set({ active: true, role: "super_admin" })));
    await Promise.all(["news", "archive"].map((id) =>
      db.doc(`sections/${id}`).set({ label: id })));
    await Promise.all([
      ["voiceover-collector", "news"],
      ["voiceover-collector-2", "archive"],
      ["voiceover-collector-3", "news"],
    ].map(([uid, section]) => db.doc(`users/${uid}`).set({
      active: true, grants: [{ role: "contributor", sections: [section] }],
    })));
    log.error.mockClear();
  });

  async function invoke(factory, body, currentActor = actor(), deps = {}) {
    const res = response();
    await factory({
      firestore: db,
      requirePrincipalFn: vi.fn(async () => currentActor),
      isActiveFn: vi.fn(async () => currentActor.approvedActive),
      verifyAppCheckFn: vi.fn(async () => true),
      log,
      ...deps,
    })(request(body, true), res);
    return res;
  }

  const mutate = (body, currentActor, deps) =>
    invoke(createCmsMutateMediaCollectionHandler, body, currentActor, deps);
  const setItems = (body, currentActor, deps) =>
    invoke(createCmsSetMediaCollectionItemsHandler, body, currentActor, deps);
  const list = (body, currentActor, deps) =>
    invoke(createCmsListMediaCollectionsHandler, body, currentActor, deps);
  const listItems = (body, currentActor, deps) =>
    invoke(createCmsListMediaCollectionItemsHandler, body, currentActor, deps);

  async function create(scope = "private", currentActor = actor()) {
    const requestId = randomUUID();
    const result = await mutate({
      action: "create",
      requestId,
      scope,
      name: scope === "private" ? "My selects" : "Team selects",
      description: "Current choices",
    }, currentActor);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    return { ...result.body.collection, requestId };
  }

  async function collectionState(collectionId) {
    const collectionRef = db.doc(`mediaCollections/${collectionId}`);
    const [collection, items, receipts, audits] = await Promise.all([
      collectionRef.get(),
      collectionRef.collection("items").get(),
      collectionRef.collection("requests").get(),
      db.collection("admin_logs").get(),
    ]);
    const records = (snapshot) => snapshot.docs.map((doc) => ({
      id: doc.id, data: doc.data(),
    }));
    return { collection: collection.data(), items: records(items),
      receipts: records(receipts), audits: records(audits) };
  }

  const writeCases = ["private", "all_staff"].flatMap((scope) =>
    ["inactive", "missing", "role-revoked", "grant-revoked"].flatMap((account) =>
      ["create", "update", "add", "remove"].map((operation) => ({
        scope, account, operation,
      }))));

  it.each(writeCases)(
    "rejects collection writes after $account admission changes: $scope $operation",
    async ({ scope, account, operation }) => {
      const currentActor = account === "grant-revoked"
        ? actor("staff-1", true, [{ role: "editor", sections: ["news"],
          registeredMediaSections: ["news"] }])
        : actor();
      if (account === "grant-revoked") {
        await db.doc("users/staff-1").set({ active: true,
          grants: [{ role: "editor", sections: ["news"] }] });
      }
      const requestId = randomUUID();
      const collection = operation === "create"
        ? { id: collectionDocumentId("staff-1", requestId) }
        : await create(scope, currentActor);
      const refs = [{ backend: "r2", id: "asset-1" }];
      if (operation === "remove") {
        expect((await setItems({ collectionId: collection.id, requestId: randomUUID(),
          baseMembershipVersion: 1, present: true, refs }, currentActor)).statusCode).toBe(200);
      }
      const metadata = operation === "create" || operation === "update";
      const body = metadata
        ? { action: operation, requestId, name: "Changed collection",
          ...(operation === "create" ? { scope }
            : { collectionId: collection.id, baseVersion: 1 }) }
        : { collectionId: collection.id, requestId, refs,
          baseMembershipVersion: operation === "remove" ? 2 : 1,
          present: operation === "add" };
      const before = await collectionState(collection.id);
      // Authentication already captured an active actor before this staff change.
      if (account === "missing") await db.doc("users/staff-1").delete();
      else if (account === "role-revoked") await db.doc("users/staff-1").update({ role: null });
      else if (account === "grant-revoked") await db.doc("users/staff-1").update({ grants: [] });
      else await db.doc("users/staff-1").update({ active: false });

      const result = await (metadata ? mutate : setItems)(body, currentActor);

      expect(result.statusCode).toBe(403);
      expect(result.body).toEqual({ error: "Media collection access denied" });
      if (account.endsWith("revoked")) {
        expect((await db.doc("users/staff-1").get()).data().active).toBe(true);
      }
      expect(await collectionState(collection.id)).toEqual(before);
    },
  );

  it.each(["metadata", "membership"].flatMap((kind) =>
    ["replay", "retry"].map((phase) => ({ kind, phase }))))(
    "rejects collection $kind after grant revocation during $phase",
    async ({ kind, phase }) => {
      const currentActor = actor("staff-1", true, [{ role: "editor" }]);
      await db.doc("users/staff-1").set({ active: true, grants: [{ role: "editor" }] });
      const collection = await create("all_staff", currentActor);
      const body = kind === "metadata"
        ? { action: "update", collectionId: collection.id, requestId: randomUUID(),
          baseVersion: 1, name: "Renamed collection" }
        : { collectionId: collection.id, requestId: randomUUID(), baseMembershipVersion: 1,
          present: true, refs: [{ backend: "r2", id: "asset-1" }] };
      const write = kind === "metadata" ? mutate : setItems;
      if (phase === "replay") expect((await write(body, currentActor)).statusCode).toBe(200);
      const before = await collectionState(collection.id);
      let retry = false;
      const firestore = {
        collection: db.collection.bind(db),
        runTransaction: (callback) => db.runTransaction(async (transaction) => {
          if (retry) {
            await db.doc("users/staff-1").update({ grants: [] });
            return callback(transaction);
          }
          await callback(transaction);
          retry = true;
          throw Object.assign(new Error("Transaction aborted"), { code: 10 });
        }),
      };
      if (phase === "replay") await db.doc("users/staff-1").update({ grants: [] });

      const result = await write(body, currentActor, phase === "retry" ? { firestore } : {});

      expect(result.statusCode).toBe(403);
      expect(result.body).toEqual({ error: "Media collection access denied" });
      expect((await db.doc("users/staff-1").get()).data()).toMatchObject({
        active: true, grants: [],
      });
      expect(await collectionState(collection.id)).toEqual(before);
    },
  );

  it.each([
    { name: "legacy admin", profile: { role: "admin" }, grants: [{ role: "admin" }] },
    { name: "staff", profile: { active: true, grants: [{ role: "staff" }] },
      grants: [{ role: "staff" }] },
    { name: "scoped contributor", profile: { active: true,
      grants: [{ role: "contributor", sections: ["news"] }] },
      grants: [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }] },
  ])("allows collection writes with current $name media grants", async ({ profile, grants }) => {
    await db.doc("users/staff-1").set(profile);
    await db.doc(`media_assets/${VOICEOVER_ASSET_ID}`).set(storedVoiceover());
    const currentActor = actor("staff-1", true, grants);
    const collection = await create("all_staff", currentActor);
    const added = await setItems({ collectionId: collection.id, requestId: randomUUID(),
      baseMembershipVersion: 1, present: true,
      refs: [{ backend: "r2", id: VOICEOVER_ASSET_ID }] }, currentActor);
    expect(added.statusCode, JSON.stringify(added.body)).toBe(200);
    expect(await collectionState(collection.id)).toMatchObject({
      collection: { itemCount: 1, membershipVersion: 2 },
      items: [expect.objectContaining({ data: expect.objectContaining({
        ref: { backend: "r2", id: VOICEOVER_ASSET_ID },
      }) })],
    });
  });

  it.each(["metadata", "membership"])(
    "rejects collection receipt replays after deactivation: %s",
    async (kind) => {
      const collection = await create("all_staff");
      const requestId = randomUUID();
      const body = kind === "metadata"
        ? { action: "update", collectionId: collection.id, requestId,
          baseVersion: 1, name: "Renamed collection" }
        : { collectionId: collection.id, requestId, baseMembershipVersion: 1,
          present: true, refs: [{ backend: "r2", id: "asset-1" }] };
      const write = kind === "metadata" ? mutate : setItems;
      expect((await write(body)).statusCode).toBe(200);
      const before = await collectionState(collection.id);
      await db.doc("users/staff-1").update({ active: false });

      const replay = await write(body);

      expect(replay.statusCode).toBe(403);
      expect(replay.body).toEqual({ error: "Media collection access denied" });
      expect(await collectionState(collection.id)).toEqual(before);
    },
  );

  it.each(["metadata", "membership"])(
    "rejects collection writes after deactivation during a database retry: %s",
    async (kind) => {
      const collection = await create("all_staff");
      const requestId = randomUUID();
      const body = kind === "metadata"
        ? { action: "update", collectionId: collection.id, requestId,
          baseVersion: 1, name: "Renamed collection" }
        : { collectionId: collection.id, requestId, baseMembershipVersion: 1,
          present: true, refs: [{ backend: "r2", id: "asset-1" }] };
      const before = await collectionState(collection.id);
      let retry = false;
      const firestore = {
        collection: db.collection.bind(db),
        runTransaction: (callback) => db.runTransaction(async (transaction) => {
          if (retry) {
            await db.doc("users/staff-1").update({ active: false });
            return callback(transaction);
          }
          await callback(transaction);
          retry = true;
          // Inject a retryable database failure; the SDK rolls back the first attempt.
          throw Object.assign(new Error("Transaction aborted"), { code: 10 });
        }),
      };

      const result = await (kind === "metadata" ? mutate : setItems)(
        body, actor(), { firestore },
      );

      expect(result.statusCode).toBe(403);
      expect(result.body).toEqual({ error: "Media collection access denied" });
      expect((await db.doc("users/staff-1").get()).data().active).toBe(false);
      expect(await collectionState(collection.id)).toEqual(before);
    },
  );

  it("requires App Check before authentication for mutations", async () => {
    const requirePrincipalFn = vi.fn();
    const handler = createCmsMutateMediaCollectionHandler({
      firestore: db,
      verifyAppCheckFn: vi.fn(async () => {
        throw Object.assign(new Error("Missing App Check token"), { status: 401 });
      }),
      requirePrincipalFn,
      log,
    });
    const res = response();
    await handler(request({
      action: "create",
      requestId: randomUUID(),
      scope: "private",
      name: "Private",
    }), res);
    expect(res.statusCode).toBe(401);
    expect(requirePrincipalFn).not.toHaveBeenCalled();
    expect((await db.collection("mediaCollections").get()).empty).toBe(true);
  });

  it("keeps private collections owner-only while all active staff can organize shared collections", async () => {
    const privateCollection = await create("private");
    const sharedCollection = await create("all_staff");
    const other = actor("staff-2");

    expect((await listItems({ collectionId: privateCollection.id }, other)).statusCode)
      .toBe(404);
    const rename = await mutate({
      action: "update",
      requestId: randomUUID(),
      collectionId: sharedCollection.id,
      baseVersion: sharedCollection.version,
      name: "Shared by another staff member",
    }, other);
    expect(rename.statusCode, JSON.stringify(rename.body)).toBe(200);
    expect(rename.body.collection.name).toBe("Shared by another staff member");
    expect(rename.body.collection).not.toHaveProperty("itemCount");
    expect(rename.body.collection).not.toHaveProperty("ownerUid");
  });

  it("makes duplicate concurrent membership idempotent and preserves asset records", async () => {
    const collection = await create("all_staff");
    const requestId = randomUUID();
    const body = {
      collectionId: collection.id,
      requestId,
      baseMembershipVersion: 1,
      present: true,
      refs: [{ backend: "r2", id: "asset-1" }],
    };
    const before = (await db.doc("media_assets/asset-1").get()).data();
    const attempts = await Promise.all([setItems(body), setItems(body)]);
    expect(attempts.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(attempts.every((result) => result.body.changed)).toBe(true);
    expect(attempts.filter((result) => result.body.replayed)).toHaveLength(1);
    expect(attempts.map((result) => result.body.changedRefs)).toEqual([
      [{ backend: "r2", id: "asset-1" }],
      [{ backend: "r2", id: "asset-1" }],
    ]);
    expect(attempts.every((result) => result.body.hiddenChangedCount === 0)).toBe(true);
    const stored = (await db.doc(`mediaCollections/${collection.id}`).get()).data();
    expect(stored).toMatchObject({ itemCount: 1, membershipVersion: 2 });
    expect((await db.collection(`mediaCollections/${collection.id}/items`).get()).size)
      .toBe(1);
    expect((await db.doc("media_assets/asset-1").get()).data()).toEqual(before);
    const audits = await db.collection("admin_logs")
      .where("target.documentId", "==", collection.id).get();
    expect(audits.docs.filter((entry) =>
      entry.data().action === "media_collection_items_add")).toHaveLength(1);
    const receipt = (await db.doc(
      `mediaCollections/${collection.id}/requests/${collectionRequestDocumentId("staff-1", requestId)}`,
    ).get()).data();
    expect(receipt.changedRefs).toEqual([{ backend: "r2", id: "asset-1" }]);
  });

  it("adds and lists a canonical voiceover without exposing its private locator", async () => {
    await db.doc(`media_assets/${VOICEOVER_ASSET_ID}`).set(storedVoiceover());
    await db.doc("media_assets/news-image").set(storedAsset());
    const newsReader = actor("voiceover-collector", true, [
      { role: "contributor", sections: ["news"], registeredMediaSections: ["news"] },
    ]);
    const archiveReader = actor("voiceover-collector-2", true, [
      { role: "contributor", sections: ["archive"], registeredMediaSections: ["archive"] },
    ]);
    const unverifiedNewsReader = actor("voiceover-collector-3", true, [
      { role: "contributor", sections: ["news"], registeredMediaSections: ["news"] },
    ], { emailVerified: false });
    const collection = await create("all_staff", newsReader);
    const ref = { backend: "r2", id: VOICEOVER_ASSET_ID };

    const added = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: collection.membershipVersion,
      present: true,
      refs: [ref],
    }, newsReader);
    expect(added.statusCode, JSON.stringify(added.body)).toBe(200);
    expect(added.body).toMatchObject({
      changed: true,
      changedRefs: [ref],
      hiddenChangedCount: 0,
    });

    const listed = await listItems({ collectionId: collection.id }, newsReader);
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
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

    const covered = await mutate({
      action: "update",
      requestId: randomUUID(),
      collectionId: collection.id,
      baseVersion: collection.version,
      coverRef: ref,
    }, newsReader);
    expect(covered.statusCode, JSON.stringify(covered.body)).toBe(200);
    const unverifiedCollections = await list({
      scope: "all_staff",
      lifecycle: "active",
    }, unverifiedNewsReader);
    expect(unverifiedCollections.statusCode).toBe(200);
    expect(unverifiedCollections.body.collections).toEqual([
      expect.objectContaining({ id: collection.id, cover: null }),
    ]);
    const unverifiedItems = await listItems({
      collectionId: collection.id,
    }, unverifiedNewsReader);
    expect(unverifiedItems.statusCode).toBe(200);
    expect(unverifiedItems.body.items).toEqual([]);
    expect(JSON.stringify(unverifiedItems.body)).not.toContain(VOICEOVER_ASSET_ID);

    const unverifiedAdd = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: added.body.membershipVersion,
      present: true,
      refs: [ref],
    }, unverifiedNewsReader);
    expect(unverifiedAdd.statusCode).toBe(404);
    expect(unverifiedAdd.body).toEqual({ error: "Media collection item is unavailable" });

    const imageAdd = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: added.body.membershipVersion,
      present: true,
      refs: [{ backend: "r2", id: "news-image" }],
    }, newsReader);
    expect(imageAdd.statusCode).toBe(404);
    expect(imageAdd.body).toEqual({ error: "Media collection item is unavailable" });

    const crossAreaList = await listItems({ collectionId: collection.id }, archiveReader);
    expect(crossAreaList.statusCode).toBe(200);
    expect(crossAreaList.body.items).toEqual([expect.objectContaining({ ref })]);
    expect(JSON.stringify(crossAreaList.body)).not.toMatch(/storageKey|contentHash|takes\/v1\//);
    const crossAreaAdd = await setItems({
      collectionId: collection.id, requestId: randomUUID(),
      baseMembershipVersion: added.body.membershipVersion, present: true, refs: [ref],
    }, archiveReader);
    expect(crossAreaAdd.statusCode).toBe(200);

  });

  it("removes one bounded group of refs and rejects a stale membership version", async () => {
    const collection = await create("private");
    const refs = ["asset-1", "asset-2"].map((id) => ({ backend: "r2", id }));
    const added = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 1,
      present: true,
      refs,
    });
    expect(added.statusCode, JSON.stringify(added.body)).toBe(200);
    const removed = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: added.body.membershipVersion,
      present: false,
      refs,
    });
    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ changed: true, membershipVersion: 3 });
    expect((await db.collection(`mediaCollections/${collection.id}/items`).get()).size).toBe(0);
    const stale = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 2,
      present: false,
      refs,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("media_collection_conflict");
  });

  it("authorizes one S3 source once for a batch and stores only opaque references", async () => {
    const collection = await create("all_staff");
    await Promise.all(["video-1", "video-2"].map((id) =>
      db.doc(`mediaSourceAssets/${id}`).set(storedSourceAsset(id))));
    const authorizeFn = vi.fn(async () => true);
    const registryFn = vi.fn(() => new Map([[
      "video-library",
      { id: "video-library", prefix: "" },
    ]]));
    const result = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 1,
      present: true,
      refs: ["video-1", "video-2"].map((id) => ({
        backend: "s3",
        sourceId: "video-library",
        id,
      })),
    }, actor(), { authorizeFn, registryFn });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect(authorizeFn).toHaveBeenCalledOnce();
    const items = await db.collection(`mediaCollections/${collection.id}/items`).get();
    expect(items.size).toBe(2);
    for (const item of items.docs) {
      expect(item.data()).not.toHaveProperty("objectKey");
      expect(item.data()).not.toHaveProperty("objectVersionId");
      expect(item.data()).not.toHaveProperty("name");
    }
  });

  it("lets a rename and membership change commit on independent revisions", async () => {
    const collection = await create("all_staff");
    const [rename, add] = await Promise.all([
      mutate({
        action: "update",
        requestId: randomUUID(),
        collectionId: collection.id,
        baseVersion: 1,
        name: "Renamed while adding",
      }),
      setItems({
        collectionId: collection.id,
        requestId: randomUUID(),
        baseMembershipVersion: 1,
        present: true,
        refs: [{ backend: "r2", id: "asset-1" }],
      }),
    ]);
    expect([rename.statusCode, add.statusCode]).toEqual([200, 200]);
    expect((await db.doc(`mediaCollections/${collection.id}`).get()).data())
      .toMatchObject({ name: "Renamed while adding", version: 2, membershipVersion: 2 });
  });

  it("gives one of two renames a conflict and returns the current authorized summary", async () => {
    const collection = await create("private");
    const results = await Promise.all(["First", "Second"].map((name) => mutate({
      action: "update",
      requestId: randomUUID(),
      collectionId: collection.id,
      baseVersion: 1,
      name,
    })));
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const rejected = results.find((result) => result.statusCode === 409);
    expect(rejected.body).toMatchObject({
      code: "media_collection_conflict",
      revision: "metadata",
      collection: { id: collection.id, version: 2 },
    });
  });

  it("preserves an added item when archived and refuses later membership changes", async () => {
    const collection = await create("all_staff");
    const added = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 1,
      present: true,
      refs: [{ backend: "r2", id: "asset-1" }],
    });
    expect(added.statusCode).toBe(200);
    const archived = await mutate({
      action: "archive",
      requestId: randomUUID(),
      collectionId: collection.id,
      baseVersion: 1,
    });
    expect(archived.statusCode).toBe(200);
    const refused = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 2,
      present: true,
      refs: [{ backend: "r2", id: "asset-2" }],
    });
    expect(refused.statusCode).toBe(409);
    expect((await db.collection(`mediaCollections/${collection.id}/items`).get()).size)
      .toBe(1);
  });

  it("returns a cover only while the member and current asset access remain valid", async () => {
    const collection = await create("private");
    const ref = { backend: "r2", id: "asset-1" };
    expect((await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 1,
      present: true,
      refs: [ref],
    })).statusCode).toBe(200);
    const covered = await mutate({
      action: "update",
      requestId: randomUUID(),
      collectionId: collection.id,
      baseVersion: 1,
      coverRef: ref,
    });
    expect(covered.statusCode, JSON.stringify(covered.body)).toBe(200);
    expect(covered.body.collection.cover).toMatchObject({ id: "asset-1" });
    expect((await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 2,
      present: false,
      refs: [ref],
    })).statusCode).toBe(200);
    const reopened = await listItems({ collectionId: collection.id });
    expect(reopened.body.collection.cover).toBeNull();
  });

  it("allows stale removal without resolving the asset and fences late retries", async () => {
    const collection = await create("private");
    await db.doc(`mediaCollections/${collection.id}`).update({
      itemCount: 1,
      membershipVersion: 2,
    });
    const staleRef = {
      backend: "s3",
      sourceId: "disabled-source",
      id: "stale-asset",
    };
    await db.doc(
      `mediaCollections/${collection.id}/items/${contract.mediaAssetRefDocumentId(staleRef)}`,
    ).set({
      schemaVersion: 1,
      ref: staleRef,
      canonicalRef: "s3:disabled-source:stale-asset",
      addedBy: "staff-1",
      addedAt: admin.firestore.Timestamp.now(),
    });
    const registryFn = vi.fn(() => new Map());
    const removeRequest = {
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 2,
      present: false,
      refs: [staleRef],
    };
    const removed = await setItems(removeRequest, actor(), { registryFn });
    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ changedRefs: [], hiddenChangedCount: 1 });
    expect(JSON.stringify(removed.body)).not.toContain("stale-asset");
    expect(registryFn).toHaveBeenCalledOnce();

    const readd = await setItems({
      collectionId: collection.id,
      requestId: randomUUID(),
      baseMembershipVersion: 3,
      present: true,
      refs: [{ backend: "r2", id: "asset-1" }],
    });
    expect(readd.statusCode).toBe(200);
    const lateRetry = await setItems(removeRequest, actor(), { registryFn });
    expect(lateRetry.statusCode).toBe(409);
    expect(lateRetry.body.code).toBe("media_collection_conflict");
  });

  it("projects changed refs through current access and keeps the canonical receipt", async () => {
    const collection = await create("all_staff");
    const refs = [
      { backend: "r2", id: "missing-asset" },
      { backend: "r2", id: "asset-1" },
    ];
    const batch = db.batch();
    for (const ref of refs) {
      batch.set(db.doc(
        `mediaCollections/${collection.id}/items/${contract.mediaAssetRefDocumentId(ref)}`,
      ), {
        schemaVersion: 1,
        ref,
        canonicalRef: `r2:${ref.id}`,
        addedBy: "staff-1",
        addedAt: admin.firestore.Timestamp.now(),
      });
    }
    batch.update(db.doc(`mediaCollections/${collection.id}`), {
      itemCount: 2,
      membershipVersion: 2,
    });
    await batch.commit();

    const requestId = randomUUID();
    const body = {
      collectionId: collection.id,
      requestId,
      baseMembershipVersion: 2,
      present: false,
      refs,
    };
    const first = await setItems(body);
    const replay = await setItems(body);
    for (const result of [first, replay]) {
      expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({
        changed: true,
        changedRefs: [{ backend: "r2", id: "asset-1" }],
        hiddenChangedCount: 1,
        membershipVersion: 3,
      });
      expect(JSON.stringify(result.body)).not.toContain("missing-asset");
    }
    expect(first.body.replayed).toBe(false);
    expect(replay.body.replayed).toBe(true);
    const receipt = (await db.doc(
      `mediaCollections/${collection.id}/requests/${collectionRequestDocumentId("staff-1", requestId)}`,
    ).get()).data();
    expect(receipt.changedRefs).toEqual([
      { backend: "r2", id: "asset-1" },
      { backend: "r2", id: "missing-asset" },
    ]);
  });

  it("acknowledges a committed removal if optional changed-ref projection fails", async () => {
    const collection = await create("private");
    const ref = { backend: "r2", id: "asset-1" };
    const added = await setItems({ collectionId: collection.id, requestId: randomUUID(),
      baseMembershipVersion: 1, present: true, refs: [ref] });
    expect(added.statusCode).toBe(200);
    const requestId = randomUUID();
    const body = { collectionId: collection.id, requestId,
      baseMembershipVersion: added.body.membershipVersion, present: false, refs: [ref] };
    const read = vi.spyOn(db, "getAll").mockRejectedValueOnce(new Error("Resolver unavailable"));
    let removed;
    try {
      removed = await setItems(body);
    } finally {
      read.mockRestore();
    }
    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ changed: true, replayed: false,
      membershipVersion: added.body.membershipVersion + 1 });
    expect(removed.body).not.toHaveProperty("changedRefs");
    expect(removed.body).not.toHaveProperty("hiddenChangedCount");
    expect(log.error).toHaveBeenCalledOnce();
    expect((await db.collection(`mediaCollections/${collection.id}/items`).get()).empty).toBe(true);
    const receipt = (await db.doc(
      `mediaCollections/${collection.id}/requests/${collectionRequestDocumentId("staff-1", requestId)}`,
    ).get()).data();
    expect(receipt.changedRefs).toEqual([ref]);
  });

  it("replays a legacy membership receipt without claiming an undo contract", async () => {
    const collection = await create("private");
    const requestId = randomUUID();
    const body = {
      collectionId: collection.id,
      requestId,
      baseMembershipVersion: 1,
      present: true,
      refs: [{ backend: "r2", id: "asset-1" }],
    };
    const first = await setItems(body);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    const receiptRef = db.doc(
      `mediaCollections/${collection.id}/requests/${collectionRequestDocumentId("staff-1", requestId)}`,
    );
    await receiptRef.update({ changedRefs: admin.firestore.FieldValue.delete() });

    const replay = await setItems(body);
    expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ changed: true, replayed: true });
    expect(replay.body).not.toHaveProperty("changedRefs");
    expect(replay.body).not.toHaveProperty("hiddenChangedCount");
  });

  it("rejects a changed create replay and recovers an exact lost response", async () => {
    const requestId = randomUUID();
    const original = {
      action: "create",
      requestId,
      scope: "private",
      name: "Recovered create",
    };
    const first = await mutate(original);
    const replay = await mutate(original);
    const changed = await mutate({ ...original, name: "Changed retry" });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.collection.id).toBe(first.body.collection.id);
    expect(changed.statusCode).toBe(409);
    expect((await db.collection("mediaCollections").get()).size).toBe(1);
  });

  it("omits restricted shared items while private owners can remove neutral unavailable rows", async () => {
    const shared = await create("all_staff");
    const personal = await create("private");
    for (const collection of [shared, personal]) {
      await db.doc(`mediaCollections/${collection.id}`).update({
        itemCount: 1,
        membershipVersion: 2,
      });
      const ref = { backend: "r2", id: "missing-asset" };
      await db.doc(
        `mediaCollections/${collection.id}/items/${contract.mediaAssetRefDocumentId(ref)}`,
      ).set({
        schemaVersion: 1,
        ref,
        canonicalRef: "r2:missing-asset",
        addedBy: "staff-1",
        addedAt: admin.firestore.Timestamp.now(),
      });
    }
    const sharedPage = await listItems({ collectionId: shared.id });
    const privatePage = await listItems({ collectionId: personal.id });
    expect(sharedPage.body.items).toEqual([]);
    expect(JSON.stringify(sharedPage.body)).not.toContain("missing-asset");
    expect(privatePage.body.items).toEqual([expect.objectContaining({
      ref: { backend: "r2", id: "missing-asset" },
      available: false,
    })]);
  });

  it("returns a continuation after a full hidden candidate scan without exposing counts", async () => {
    const collection = await create("all_staff");
    const batch = db.batch();
    const addedAt = admin.firestore.Timestamp.fromDate(new Date("2026-09-22T12:00:00Z"));
    for (let index = 0; index <= 100; index += 1) {
      const ref = { backend: "r2", id: `missing-${String(index).padStart(3, "0")}` };
      batch.set(db.doc(
        `mediaCollections/${collection.id}/items/${contract.mediaAssetRefDocumentId(ref)}`,
      ), {
        schemaVersion: 1,
        ref,
        canonicalRef: `r2:${ref.id}`,
        addedBy: "staff-1",
        addedAt,
      });
    }
    batch.update(db.doc(`mediaCollections/${collection.id}`), {
      itemCount: 101,
      membershipVersion: 2,
    });
    await batch.commit();

    const first = await listItems({ collectionId: collection.id, limit: 30 });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items).toEqual([]);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBeTypeOf("string");
    expect(first.body.collection).not.toHaveProperty("itemCount");
    const second = await listItems({
      collectionId: collection.id,
      limit: 30,
      cursor: first.body.nextCursor,
    });
    expect(second.statusCode).toBe(200);
    expect(second.body.items).toEqual([]);
    expect(second.body.hasMore).toBe(false);
  });

  it("lists private collections by owner and binds page order with a stable cursor", async () => {
    await create("private");
    await create("private", actor("staff-2"));
    const own = await list({ scope: "private", lifecycle: "active", limit: 1 });
    expect(own.statusCode, JSON.stringify(own.body)).toBe(200);
    expect(own.body.collections).toHaveLength(1);
    expect(own.body.collections[0]).toMatchObject({ scope: "private", itemCount: 0 });
    expect(own.body.collections[0]).not.toHaveProperty("ownerUid");
  });

  it("blocks inactive accounts without deleting shared collection state", async () => {
    const collection = await create("all_staff");
    const inactive = await list(
      { scope: "all_staff", lifecycle: "active" },
      actor("staff-1", false),
    );
    expect(inactive.statusCode).toBe(403);
    expect((await db.doc(`mediaCollections/${collection.id}`).get()).exists).toBe(true);
  });
});
