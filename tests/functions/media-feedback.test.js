import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import feedback from "../../functions/media-feedback.js";
import contract from "../../functions/lib/media-feedback.js";
import rendition from "../../functions/lib/source-media-rendition.js";
import sourceMedia from "../../functions/lib/source-media-contract.js";
import { mediaCommentsCsv } from "../../admin/src/lib/media-comment-csv";

// The opaque file tokens a reviewer's client would hold for these originals.
const STORED_FILE = sourceMedia.sourceMediaFileVersion("private-version");
const ORIGINAL_FILE = sourceMedia.sourceMediaFileVersion("original-v1");

const {
  createCmsGetMediaReviewHandler,
  createCmsListMediaCommentsHandler,
  createCmsMutateMediaCommentHandler,
  createCmsSaveMediaReviewHandler,
} = feedback;

const ASSET_REF = { backend: "r2", id: "asset-1" };
const VOICEOVER_TAKE_ID = "soft-spoken-watching-station-01";
const VOICEOVER_ASSET_ID = `voiceover-${VOICEOVER_TAKE_ID}`;
const VOICEOVER_REF = { backend: "r2", id: VOICEOVER_ASSET_ID };
const SOURCE_REF = { backend: "s3", sourceId: "video-library", id: "video-1" };

function actor(
  uid = "staff-1",
  grants = [{ role: "editor" }],
  approvedActive = true,
) {
  return {
    uid,
    email: `${uid}@example.org`,
    emailVerified: true,
    approvedActive,
    principal: { id: uid, grants },
  };
}

function response() {
  const res = { statusCode: 0, body: null, headersSent: false, headers: new Map() };
  res.set = (name, value) => {
    res.headers.set(name.toLowerCase(), value);
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

function request(body, appCheck = true) {
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
    name: "Feedback image",
    originalName: "feedback.png",
    category: "news",
    categories: ["news"],
    tags: [],
    description: null,
    altText: "Feedback image",
    license: "Station owned",
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 10,
    height: 10,
    url: "https://media.njpbs.org/cms-media/news/feedback.png",
    source: "upload",
    lifecycle: "active",
    version: 3,
    createdAt: "2026-10-01T12:00:00.000Z",
    createdBy: "staff-1",
    updatedAt: "2026-10-02T12:00:00.000Z",
    updatedBy: "staff-1",
    ...overrides,
  };
}

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
      flags: ["producer-review"],
      duration_seconds: 2.058,
    },
    storageKey: `takes/v1/${VOICEOVER_TAKE_ID}.wav`,
    contentHash: "a".repeat(64),
    ...overrides,
  });
}

function storedSourceAsset(overrides = {}) {
  return {
    sourceId: "video-library",
    lifecycle: "active",
    name: "Feedback video",
    originalName: "feedback.mp4",
    description: null,
    nameSort: "feedback video",
    updatedAtSort: "2026-10-02T12:00:00.000Z",
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
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-02T12:00:00.000Z",
    objectKey: "feedback.mp4",
    objectVersionId: "private-version",
    ...overrides,
  };
}

describe("media feedback contract", () => {
  it("parses exact review and comment requests", () => {
    expect(contract.parseSaveMediaReviewRequest({
      schemaVersion: 1,
      ref: ASSET_REF,
      baseVersion: 0,
      moreLikeThis: true,
      notes: "First\rSecond",
    })).toEqual({
      schemaVersion: 1,
      ref: ASSET_REF,
      baseVersion: 0,
      moreLikeThis: true,
      notes: "First\nSecond",
    });
    expect(contract.parseMutateMediaCommentRequest({
      schemaVersion: 1,
      ref: ASSET_REF,
      action: "create",
      requestId: "request_12345678",
      text: "A comment",
    })).toMatchObject({ action: "create", text: "A comment" });
  });

  it("rejects identity spoofing, extra fields and invalid action shapes", () => {
    expect(() => contract.parseGetMediaReviewRequest({
      schemaVersion: 1,
      ref: ASSET_REF,
      ownerUid: "other",
    })).toThrow(/unknown/i);
    expect(() => contract.parseMutateMediaCommentRequest({
      schemaVersion: 1,
      ref: ASSET_REF,
      action: "create",
      requestId: "request_12345678",
      text: "A comment",
      authorUid: "other",
    })).toThrow(/unknown/i);
    expect(() => contract.parseMutateMediaCommentRequest({
      schemaVersion: 1,
      ref: ASSET_REF,
      action: "delete",
      requestId: "request_12345678",
      commentId: "a".repeat(64),
      baseVersion: 1,
      text: "Hidden payload",
    })).toThrow(/cannot include text/i);
    expect(() => contract.normalizeText("x".repeat(2_001), "Comment"))
      .toThrow(/2,000/);
  });
});

describe("comment thread contract", () => {
  const PARENT = "b".repeat(64);
  const mutate = (body) => contract.parseMutateMediaCommentRequest({
    schemaVersion: 1,
    ref: SOURCE_REF,
    requestId: "request_12345678",
    ...body,
  });

  it("accepts a reply with mentions and refuses a reply with its own time", () => {
    expect(mutate({ action: "create", text: "Agreed", parentId: PARENT, mentions: ["staff-2"] }))
      .toMatchObject({ parentId: PARENT, mentions: ["staff-2"], time: null });
    expect(mutate({ action: "create", text: "Top level" }))
      .toMatchObject({ parentId: null, mentions: [] });
    expect(() => mutate({
      action: "create", text: "Reply", parentId: PARENT,
      time: { startMs: 10, fileVersion: ORIGINAL_FILE },
    })).toThrow(/reply cannot have its own time/i);
    expect(() => mutate({ action: "create", text: "Reply", parentId: "not-a-comment" }))
      .toThrow(/reply target is invalid/i);
    expect(() => mutate({
      action: "edit", commentId: PARENT, baseVersion: 1, text: "Move", parentId: PARENT,
    })).toThrow(/another thread/i);
  });

  it("bounds mentions and refuses repeated or malformed IDs", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `staff-${index}`);
    expect(() => mutate({ action: "create", text: "Many", mentions: eleven })).toThrow(/up to 10/i);
    expect(mutate({ action: "create", text: "Ten", mentions: eleven.slice(0, 10) }).mentions)
      .toHaveLength(10);
    expect(() => mutate({ action: "create", text: "Twice", mentions: ["staff-1", "staff-1"] }))
      .toThrow(/more than once/i);
    expect(() => mutate({ action: "create", text: "Bad", mentions: ["users/staff-1"] }))
      .toThrow(/mentions must be/i);
    expect(() => mutate({ action: "create", text: "Bad", mentions: "staff-1" }))
      .toThrow(/mentions must be/i);
    // An edit without mentions keeps the stored list; an edit with mentions replaces it.
    expect(mutate({ action: "edit", commentId: PARENT, baseVersion: 1, text: "Edit" }).mentions)
      .toBeNull();
    expect(mutate({ action: "edit", commentId: PARENT, baseVersion: 1, text: "Edit", mentions: [] }).mentions)
      .toEqual([]);
  });

  it("parses resolve and reopen as a version-checked change with no text", () => {
    for (const action of ["resolve", "reopen"]) {
      expect(mutate({ action, commentId: PARENT, baseVersion: 3 })).toEqual({
        schemaVersion: 1,
        ref: SOURCE_REF,
        action,
        requestId: "request_12345678",
        commentId: PARENT,
        baseVersion: 3,
      });
      expect(() => mutate({ action, commentId: PARENT })).toThrow(/reload/i);
      expect(() => mutate({ action, commentId: PARENT, baseVersion: 1, text: "Done" }))
        .toThrow(/cannot change its text/i);
      expect(() => mutate({ action, commentId: PARENT, baseVersion: 1, mentions: ["staff-1"] }))
        .toThrow(/cannot change its text/i);
    }
    expect(() => mutate({ action: "approve", commentId: PARENT, baseVersion: 1 }))
      .toThrow(/action is invalid/i);
  });

  it("parses a staff list request only without a cursor or limit", () => {
    expect(contract.parseListMediaCommentsRequest({ schemaVersion: 1, ref: SOURCE_REF, staff: true }))
      .toEqual({ schemaVersion: 1, ref: SOURCE_REF, staff: true });
    expect(() => contract.parseListMediaCommentsRequest({
      schemaVersion: 1, ref: SOURCE_REF, staff: true, limit: 5,
    })).toThrow(/only the item reference/i);
    expect(() => contract.parseListMediaCommentsRequest({ schemaVersion: 1, ref: SOURCE_REF, staff: false }))
      .toThrow(/only the item reference/i);
  });

  const storedBase = {
    schemaVersion: 1,
    ref: ASSET_REF,
    canonicalRef: "r2:asset-1",
    authorUid: "staff-2",
    authorName: "Taylor Staff",
    text: "Stored",
    version: 2,
    createFingerprint: "c".repeat(64),
    createdAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-05T12:00:00.000Z",
  };
  const stored = (fields) => contract.storedMediaComment("d".repeat(64), ASSET_REF, { ...storedBase, ...fields });

  it("reads comments saved before threads as open top-level comments", () => {
    expect(stored({})).toMatchObject({
      parentId: null, mentions: [], resolvedAt: null, resolvedBy: null, replyCount: 0,
    });
    expect(() => stored({ resolvedAt: "2026-10-05T13:00:00.000Z" })).toThrow(/thread fields/i);
    expect(() => stored({ parentId: PARENT, resolvedAt: "2026-10-05T13:00:00.000Z", resolvedBy: "staff-1" }))
      .toThrow(/thread fields/i);
    expect(() => stored({ parentId: PARENT, replyCount: 1 })).toThrow(/thread fields/i);
    expect(() => stored({ mentions: ["staff-1", "staff-1"] })).toThrow(/thread fields/i);
  });

  it("projects names at read time, hides the reply count, and limits who can resolve", () => {
    const comment = stored({
      mentions: ["staff-1", "gone-1"],
      resolvedAt: "2026-10-05T13:00:00.000Z",
      resolvedBy: "staff-1",
      replyCount: 2,
    });
    const names = new Map([["staff-1", "Sam Staff"]]);
    const asReader = contract.commentProjection("d".repeat(64), comment, "staff-1", null, { names });
    expect(asReader).toMatchObject({
      parentId: null,
      mentions: [{ uid: "staff-1", name: "Sam Staff" }, { uid: "gone-1", name: "Former staff member" }],
      mentionsYou: true,
      resolvedAt: "2026-10-05T13:00:00.000Z",
      resolvedBy: { uid: "staff-1", name: "Sam Staff" },
      canEdit: false,
      canResolve: false,
    });
    expect(asReader).not.toHaveProperty("replyCount");
    expect(asReader.hasReplies).toBe(true);
    expect(contract.commentProjection("d".repeat(64), stored({}), "staff-1", null).hasReplies).toBe(false);
    expect(contract.commentProjection("d".repeat(64), comment, "staff-2", null, { names }).canResolve).toBe(true);
    expect(contract.commentProjection("d".repeat(64), comment, "staff-3", null, { names, moderates: true }).canResolve)
      .toBe(true);
    const reply = stored({ parentId: PARENT });
    expect(contract.commentProjection("d".repeat(64), reply, "staff-2", null, { moderates: true }).canResolve)
      .toBe(false);
  });

  it("keeps the create fingerprint of a plain comment and binds a reply to its parent", () => {
    const plain = createHash("sha256")
      .update(JSON.stringify({ ref: "r2:asset-1", text: "Same" }), "utf8")
      .digest("hex");
    expect(contract.commentCreateFingerprint(ASSET_REF, "Same")).toBe(plain);
    expect(contract.commentCreateFingerprint(ASSET_REF, "Same", null, null, [])).toBe(plain);
    expect(contract.commentCreateFingerprint(ASSET_REF, "Same", null, PARENT)).not.toBe(plain);
    expect(contract.commentCreateFingerprint(ASSET_REF, "Same", null, null, ["staff-1"])).not.toBe(plain);
  });
});

// A ready web copy for video-1 with the given source frame rate.
function readyRendition(asset, rate, durationSeconds = 120, sourceRate = rate) {
  const prefix = rendition.sourceMediaRenditionOutputPrefix({ id: "video-1", ...asset }, "preview-v1");
  return {
    schemaVersion: 1,
    state: "ready",
    sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes,
    attemptId: "preview-v1",
    updatedAt: "2026-10-05T16:00:00Z",
    web: {
      objectKey: `${prefix}preview.mp4`,
      objectVersionId: "web-v1",
      sizeBytes: 500,
      mimeType: "video/mp4",
      durationSeconds,
      ...(sourceRate ? { sourceFrameRateNumerator: sourceRate[0], sourceFrameRateDenominator: sourceRate[1] } : {}),
      ...(rate ? { frameRateNumerator: rate[0], frameRateDenominator: rate[1] } : {}),
    },
    poster: {
      objectKey: `${prefix}preview-poster.0000000.jpg`,
      objectVersionId: "poster-v1",
      sizeBytes: 100,
      mimeType: "image/jpeg",
    },
  };
}

describe("timed comment contract", () => {
  const create = (time) => contract.parseMutateMediaCommentRequest({
    schemaVersion: 1,
    ref: SOURCE_REF,
    action: "create",
    requestId: "request_12345678",
    text: "At a frame",
    ...(time === undefined ? {} : { time }),
  });

  it("accepts a frame, a frame range, a millisecond point, or no time", () => {
    const file = { fileVersion: ORIGINAL_FILE };
    expect(create({ startFrame: 1800, ...file }).time)
      .toEqual({ startFrame: 1800, endFrame: null, ...file });
    expect(create({ startFrame: 1800, endFrame: 1829, ...file }).time)
      .toEqual({ startFrame: 1800, endFrame: 1829, ...file });
    expect(create({ startMs: 60_060, ...file }).time).toEqual({ startMs: 60_060, endMs: null, ...file });
    expect(create().time).toBeNull();
  });

  it("rejects mixed units, empty or reversed ranges, and time on an edit", () => {
    const file = { fileVersion: ORIGINAL_FILE };
    expect(() => create({ startFrame: 1, startMs: 1, ...file })).toThrow(/unknown/i);
    expect(() => create({ startFrame: 10, endFrame: 10, ...file })).toThrow(/time is invalid/i);
    expect(() => create({ startFrame: 10, endFrame: 9, ...file })).toThrow(/time is invalid/i);
    expect(() => create({ startFrame: -1, ...file })).toThrow(/time is invalid/i);
    expect(() => create({ startFrame: 1.5, ...file })).toThrow(/time is invalid/i);
    expect(() => create({ startMs: "60", ...file })).toThrow(/time is invalid/i);
    // The file token is required and has a fixed form.
    expect(() => create({ startFrame: 10 })).toThrow(/time is invalid/i);
    expect(() => create({ startFrame: 10, fileVersion: "original-v1" })).toThrow(/time is invalid/i);
    expect(() => contract.parseMutateMediaCommentRequest({
      schemaVersion: 1,
      ref: SOURCE_REF,
      action: "edit",
      requestId: "request_12345678",
      commentId: "a".repeat(64),
      baseVersion: 1,
      text: "Moved",
      time: { startFrame: 1 },
    })).toThrow(/cannot change/i);
  });

  it("derives millisecond times from the asset rate, not the request", () => {
    const at = (rate, time, sourceRate = rate) => contract.timedCommentFields({
      objectVersionId: "original-v1",
      rendition: { state: "ready", web: { durationSeconds: 3600,
        frameRateNumerator: rate[0], frameRateDenominator: rate[1],
        ...(sourceRate ? { sourceFrameRateNumerator: sourceRate[0], sourceFrameRateDenominator: sourceRate[1] } : {}) } },
    }, { fileVersion: ORIGINAL_FILE, ...time });
    // Frame n starts at n * den / num seconds; a range ends where its last frame ends.
    expect(at([30000, 1001], { startFrame: 1800, endFrame: 1829 })).toEqual({
      sourceVersion: "original-v1", startFrame: 1800, endFrame: 1829,
      rateNum: 30000, rateDen: 1001, startMs: 60_060, endMs: 61_061,
    });
    expect(at([24000, 1001], { startFrame: 24, endFrame: null }).startMs).toBe(1_001);
    expect(at([60000, 1001], { startFrame: 3600, endFrame: null }).startMs).toBe(60_060);
    expect(() => at([30000, 1001], { startMs: 1, endMs: null })).toThrow(/frame rate/i);
    expect(() => contract.timedCommentFields(null, { startMs: 1, endMs: null }))
      .toThrow(/only on videos/i);
  });

  it("keeps a time inside the measured video", () => {
    const at = (web, time) => contract.timedCommentFields(
      { objectVersionId: "original-v1", rendition: { state: "ready", web } },
      { fileVersion: ORIGINAL_FILE, ...time },
    );
    // One second at 25 fps has frames 0 to 24.
    const second = { durationSeconds: 1, frameRateNumerator: 25, frameRateDenominator: 1,
      sourceFrameRateNumerator: 25, sourceFrameRateDenominator: 1 };
    expect(at(second, { startFrame: 0, endFrame: 24 }).endMs).toBe(1_000);
    expect(() => at(second, { startFrame: 0, endFrame: 25 })).toThrow(/past the end/i);
    expect(() => at(second, { startFrame: 25, endFrame: null })).toThrow(/past the end/i);
    const unmeasured = { durationSeconds: 1 };
    expect(at(unmeasured, { startMs: 0, endMs: 1_000 }).endMs).toBe(1_000);
    expect(() => at(unmeasured, { startMs: 0, endMs: 1_001 })).toThrow(/past the end/i);
    // Without a measured duration the server cannot check a time, so it refuses it.
    expect(() => at({}, { startMs: 86_400_000, endMs: null })).toThrow(/web copy/i);
  });

  it("rejects a time picked on a file that was replaced since", () => {
    const asset = { objectVersionId: "replacement-v2", rendition: { state: "ready", web: { durationSeconds: 60,
      frameRateNumerator: 30000, frameRateDenominator: 1001,
      sourceFrameRateNumerator: 30000, sourceFrameRateDenominator: 1001 } } };
    let error;
    try {
      contract.timedCommentFields(asset, { startFrame: 30, endFrame: null, fileVersion: ORIGINAL_FILE });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toMatch(/replaced/i);
    expect(error?.status ?? error?.statusCode).toBe(409);
    expect(error?.code).toBe(contract.COMMENT_TIME_CHANGED_CODE);
  });

  it("uses milliseconds when the web copy rate differs from a variable-rate original", () => {
    const at = (rate, sourceRate, time) => contract.timedCommentFields({
      objectVersionId: "original-v1",
      rendition: { state: "ready", web: { durationSeconds: 3600,
        ...(rate ? { frameRateNumerator: rate[0], frameRateDenominator: rate[1] } : {}),
        sourceFrameRateNumerator: sourceRate[0], sourceFrameRateDenominator: sourceRate[1] } },
    }, { fileVersion: ORIGINAL_FILE, ...time });
    // A phone file reports 29.97 fps but averages about 25.8; the web copy came out at 25 fps.
    expect(() => at([25, 1], [30000, 1001], { startFrame: 30, endFrame: null }))
      .toThrow(/frame rate/i);
    expect(at([25, 1], [30000, 1001], { startMs: 1_200, endMs: null }))
      .toMatchObject({ startFrame: null, rateNum: null, startMs: 1_200 });
    // A web copy made before its rate was measured also uses milliseconds.
    expect(at(null, [30000, 1001], { startMs: 1_200, endMs: null }).rateNum).toBeNull();
    // Equal fractions in other terms still count as the same rate.
    expect(at([60000, 2002], [30000, 1001], { startFrame: 1800, endFrame: null }).startMs).toBe(60_060);
  });
});

describe("media feedback API", () => {
  let db;
  let nowIndex;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const registry = new Map([["video-library", {
    id: "video-library",
    prefix: "",
  }]]);

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error("Use the Firestore emulator for media feedback tests");
    }
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("media-feedback.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
      { method: "DELETE" }, db);
    await Promise.all([
      db.doc("media_assets/asset-1").set(storedAsset()),
      db.doc(`media_assets/${VOICEOVER_ASSET_ID}`).set(storedVoiceover()),
      db.doc("mediaSourceAssets/video-1").set(storedSourceAsset()),
      db.doc("users/staff-1").set({
        active: true,
        displayName: "Sam Staff",
        grants: [{ role: "editor" }],
      }),
      db.doc("users/staff-2").set({
        active: true,
        displayName: "Taylor Staff",
        grants: [{ role: "editor" }],
      }),
      db.doc("users/admin-1").set({
        active: true,
        displayName: "Alex Admin",
        role: "super_admin",
      }),
    ]);
    nowIndex = 0;
    log.error.mockClear();
  });

  function runtime(currentActor, overrides = {}) {
    return {
      firestore: db,
      requirePrincipalFn: vi.fn(async () => currentActor),
      isActiveFn: vi.fn(async () => currentActor.approvedActive),
      verifyAppCheckFn: vi.fn(async () => true),
      registryFn: () => registry,
      authorizeFn: vi.fn(async () => true),
      nowFn: () => admin.firestore.Timestamp.fromDate(
        new Date(Date.UTC(2026, 9, 5, 12, 0, nowIndex++)),
      ),
      log,
      ...overrides,
    };
  }

  async function invoke(factory, body, currentActor = actor(), overrides = {}) {
    const res = response();
    await factory(runtime(currentActor, overrides))(request(body), res);
    return res;
  }

  const getReview = (ref = ASSET_REF, currentActor, overrides) => invoke(
    createCmsGetMediaReviewHandler,
    { schemaVersion: 1, ref },
    currentActor,
    overrides,
  );
  const saveReview = (body, currentActor, overrides) => invoke(
    createCmsSaveMediaReviewHandler,
    { schemaVersion: 1, ref: ASSET_REF, ...body },
    currentActor,
    overrides,
  );
  const listComments = (body = {}, currentActor, overrides) => invoke(
    createCmsListMediaCommentsHandler,
    { schemaVersion: 1, ref: ASSET_REF, ...body },
    currentActor,
    overrides,
  );
  const mutateComment = (body, currentActor, overrides) => invoke(
    createCmsMutateMediaCommentHandler,
    { schemaVersion: 1, ref: ASSET_REF, requestId: randomUUID(), ...body },
    currentActor,
    overrides,
  );

  describe("comment CSV export", () => {
    const id = (n) => n.toString(16).padStart(64, "0");
    const exportComments = (filter = "all", currentActor, overrides) =>
      listComments({ export: filter }, currentActor, overrides);
    async function seedComments(count) {
      const collection = contract.mediaComments(db, ASSET_REF);
      for (let offset = 0; offset < count; offset += 400) {
        const batch = db.batch();
        for (let index = offset; index < Math.min(count, offset + 400); index++) {
          batch.set(collection.doc(id(index + 1)), {
            schemaVersion: 1, ref: ASSET_REF, canonicalRef: "r2:asset-1",
            authorUid: index === count - 1 ? "staff-1" : "staff-2",
            authorName: "Taylor Staff", text: `Comment ${index + 1}`, version: 1,
            createFingerprint: "c".repeat(64),
            createdAt: admin.firestore.Timestamp.fromMillis(1_800_000_000_000 + index),
            updatedAt: admin.firestore.Timestamp.fromMillis(1_800_000_000_000 + index),
            parentId: index > 1 ? id(1) : null,
            mentions: index === count - 1 ? ["staff-1"] : [],
            ...(index === 1 ? { resolvedAt: admin.firestore.Timestamp.now(), resolvedBy: "staff-2" } : {}),
          });
        }
        await batch.commit();
      }
    }

    it("exports complete filtered threads beyond the loaded page and audits metadata only", async () => {
      await seedComments(35);
      await saveReview({ baseVersion: 0, moreLikeThis: false, notes: "Private export exclusion" });
      for (const [filter, expected] of [
        ["open", [1, ...Array.from({ length: 33 }, (_, i) => i + 3)]],
        ["resolved", [2]],
        ["mine", [1, ...Array.from({ length: 33 }, (_, i) => i + 3)]],
        ["mentions", [1, ...Array.from({ length: 33 }, (_, i) => i + 3)]],
        ["all", Array.from({ length: 35 }, (_, i) => i + 1)],
      ]) {
        const result = await exportComments(filter);
        expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
        expect(result.body.comments.map(comment => comment.id)).toEqual(expected.map(id));
        expect(result.body.exported).toBe(true);
        expect(result.headers.get("cache-control")).toBe("private, no-store");
        expect(JSON.stringify(result.body)).not.toMatch(/Private export exclusion|createFingerprint|canonicalRef/);
      }
      const entries = (await db.collection("admin_logs").get()).docs.map(doc => doc.data());
      expect(entries).toHaveLength(5);
      expect(entries.every(entry => entry.action === "media_comment_export" && entry.actorUid === "staff-1")).toBe(true);
      expect(entries.map(entry => entry.after.count).sort((a, b) => a - b)).toEqual([1, 34, 34, 34, 35]);
      expect(JSON.stringify(entries)).not.toContain("Comment 1");
    });

    it("fails closed for lost access, missing items, App Check and audit failures", async () => {
      await seedComments(1);
      expect((await exportComments("all", actor("staff-1", [], false))).statusCode).toBe(403);
      expect((await exportComments("all", actor("staff-1", []))).statusCode).toBe(404);
      expect((await exportComments("all", actor(), {
        verifyAppCheckFn: async () => { throw Object.assign(new Error("App Check required"), { status: 401 }); },
      })).statusCode).toBe(401);
      const failed = await exportComments("all", actor(), {
        auditFn: () => { throw new Error("audit unavailable"); },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toHaveProperty("comments");
      await db.doc("media_assets/asset-1").delete();
      expect((await exportComments()).statusCode).toBe(404);
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    });

    it("bounds the complete asset scan and never exports a partial thread", async () => {
      await seedComments(1001);
      const overflow = await exportComments("resolved");
      expect(overflow.statusCode).toBe(413);
      expect(overflow.body).not.toHaveProperty("comments");
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
      await contract.mediaComments(db, ASSET_REF).doc(id(1001)).delete();
      const complete = await exportComments();
      expect(complete.statusCode).toBe(200);
      expect(complete.body.comments).toHaveLength(1000);
    });

    it("rejects unknown filters and mixed paging/staff/export requests", async () => {
      for (const fields of [
        { export: true }, { export: "__proto__" }, { export: "all", limit: 1 },
        { export: "all", cursor: "cursor" }, { export: "all", staff: true },
      ]) {
        expect((await listComments(fields)).statusCode).toBe(400);
      }
    });

    it("serializes a stored 29.97 fps range and marks it earlier after file replacement", async () => {
      const asset = storedSourceAsset();
      await db.doc("mediaSourceAssets/video-1").set({ ...asset, rendition: readyRendition(asset, [30000, 1001]) });
      const created = await mutateComment({ ref: SOURCE_REF, action: "create", text: 'José, check "audio"\n第二行',
        time: { startFrame: 1800, endFrame: 1830, fileVersion: STORED_FILE } });
      expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
      const current = await listComments({ ref: SOURCE_REF, export: "all" });
      expect(current.statusCode).toBe(200);
      const csv = mediaCommentsCsv(current.body.comments);
      expect(csv).toContain('"00:01:00;02","60.06","00:01:01;02","61.061"');
      expect(csv).toContain('"José, check ""audio""\n第二行"');
      expect(csv).toContain('"Current"');
      await db.doc("mediaSourceAssets/video-1").update({ objectVersionId: "replacement-version" });
      const earlier = await listComments({ ref: SOURCE_REF, export: "all" });
      expect(earlier.statusCode).toBe(200);
      expect(mediaCommentsCsv(earlier.body.comments)).toContain('"Earlier"');
      expect(JSON.stringify(earlier.body)).not.toMatch(/private-version|replacement-version|sourceVersion/);
      await db.doc("mediaSourceAssets/video-1").update({ lifecycle: "binned" });
      expect((await listComments({ ref: SOURCE_REF, export: "all" })).statusCode).toBe(404);
    });
  });

  it("keeps normal reviews private and enforces optimistic versions", async () => {
    const saved = await saveReview({
      baseVersion: 0,
      moreLikeThis: true,
      notes: "Private note",
    });
    expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.review).toEqual({
      moreLikeThis: true,
      notes: "Private note",
      version: 1,
      updatedAt: "2026-10-05T12:00:00.000Z",
    });
    expect((await getReview()).body.review).toEqual(saved.body.review);
    expect((await getReview(ASSET_REF, actor("staff-2"))).body.review).toBeNull();

    const stale = await saveReview({
      baseVersion: 0,
      moreLikeThis: false,
      notes: "Stale note",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("media_review_conflict");
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("uses the existing voiceover review record and preserves its favorite", async () => {
    const legacyRef = db.doc(
      `voiceoverReviews/staff-1/takes/${VOICEOVER_TAKE_ID}`,
    );
    await legacyRef.set({
      schemaVersion: 1,
      manifestVersion: 1,
      takeId: VOICEOVER_TAKE_ID,
      favorite: true,
      moreLikeThis: false,
      notes: "Legacy note",
      version: 4,
      createdAt: "2026-09-10T17:00:00.000Z",
      updatedAt: "2026-09-10T17:30:00.000Z",
    });
    expect((await getReview(VOICEOVER_REF)).body.review).toEqual({
      moreLikeThis: false,
      notes: "Legacy note",
      version: 4,
      updatedAt: "2026-09-10T17:30:00.000Z",
    });

    const saved = await invoke(createCmsSaveMediaReviewHandler, {
      schemaVersion: 1,
      ref: VOICEOVER_REF,
      baseVersion: 4,
      moreLikeThis: true,
      notes: "Common API note",
    });
    expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.review.version).toBe(5);
    expect((await legacyRef.get()).data()).toMatchObject({
      favorite: true,
      moreLikeThis: true,
      notes: "Common API note",
      version: 5,
    });
    expect((await db.collection("mediaReviews").get()).empty).toBe(true);
  });

  it("supports an authorized S3 item and rejects a source identity mismatch", async () => {
    const saved = await invoke(createCmsSaveMediaReviewHandler, {
      schemaVersion: 1,
      ref: SOURCE_REF,
      baseVersion: 0,
      moreLikeThis: false,
      notes: "Video note",
    });
    expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);
    await db.doc("mediaSourceAssets/video-1").update({ sourceId: "other-source" });
    const denied = await getReview(SOURCE_REF);
    expect(denied.statusCode).toBe(404);
  });

  it("denies inactive actors, admits area-scoped Editors and rechecks the asset on write", async () => {
    const inactive = await getReview(ASSET_REF, actor("staff-1", [{ role: "editor" }], false));
    expect(inactive.statusCode).toBe(403);
    const scoped = await getReview(
      ASSET_REF,
      actor("staff-1", [{ role: "editor", sections: ["arts"], registeredMediaSections: ["arts"] }]),
    );
    expect(scoped.statusCode).toBe(200);

    const first = await saveReview({
      baseVersion: 0,
      moreLikeThis: false,
      notes: "Before bin",
    });
    expect(first.statusCode).toBe(200);
    await db.doc("media_assets/asset-1").update({ lifecycle: "binned" });
    const afterBin = await saveReview({
      baseVersion: 1,
      moreLikeThis: true,
      notes: "After bin",
    });
    expect(afterBin.statusCode).toBe(404);
  });

  it("requires App Check before authenticating review and comment mutations", async () => {
    const requirePrincipalFn = vi.fn();
    const verifyAppCheckFn = vi.fn(async () => {
      throw Object.assign(new Error("Missing App Check token"), { status: 401 });
    });
    for (const [factory, body] of [
      [createCmsSaveMediaReviewHandler, {
        schemaVersion: 1,
        ref: ASSET_REF,
        baseVersion: 0,
        moreLikeThis: false,
        notes: "",
      }],
      [createCmsMutateMediaCommentHandler, {
        schemaVersion: 1,
        ref: ASSET_REF,
        action: "create",
        requestId: randomUUID(),
        text: "Comment",
      }],
    ]) {
      const res = response();
      await factory({
        firestore: db,
        verifyAppCheckFn,
        requirePrincipalFn,
        log,
      })(request(body, false), res);
      expect(res.statusCode).toBe(401);
    }
    expect(requirePrincipalFn).not.toHaveBeenCalled();
  });

  it("shares comments with authorized staff but lets only the author change them", async () => {
    const created = await mutateComment({
      action: "create",
      text: "Shared observation",
    }, { ...actor(), displayName: "Caller-controlled name" });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    expect(created.body.comment).toMatchObject({
      authorUid: "staff-1",
      authorName: "Sam Staff",
      text: "Shared observation",
      version: 1,
      canEdit: true,
    });
    const commentId = created.body.comment.id;
    const otherList = await listComments({}, actor("staff-2"));
    expect(otherList.body.comments).toEqual([
      expect.objectContaining({ id: commentId, canEdit: false }),
    ]);
    const adminEdit = await mutateComment({
      action: "edit",
      commentId,
      baseVersion: 1,
      text: "Admin override",
    }, actor("admin-1", [{ role: "super_admin" }]));
    expect(adminEdit.statusCode).toBe(403);

    const edited = await mutateComment({
      action: "edit",
      commentId,
      baseVersion: 1,
      text: "Author revision",
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.body.comment).toMatchObject({
      text: "Author revision",
      version: 2,
      canEdit: true,
    });
    const stale = await mutateComment({
      action: "edit",
      commentId,
      baseVersion: 1,
      text: "Stale revision",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("media_comment_conflict");
  });

  it("makes creates idempotent without resurrecting a deleted comment", async () => {
    const requestId = randomUUID();
    const create = {
      action: "create",
      requestId,
      text: "Keep one copy",
    };
    const first = await mutateComment(create);
    const replay = await mutateComment(create);
    expect(replay.body.comment).toEqual(first.body.comment);
    const changedReplay = await mutateComment({ ...create, text: "Different text" });
    expect(changedReplay.statusCode).toBe(409);

    const removed = await mutateComment({
      action: "delete",
      commentId: first.body.comment.id,
      baseVersion: 1,
    });
    expect(removed.body.comment).toBeNull();
    const replayAfterDelete = await mutateComment(create);
    expect(replayAfterDelete.statusCode).toBe(200);
    expect(replayAfterDelete.body.comment).toBeNull();
    expect((await db.collectionGroup("items").get()).docs.filter(
      (document) => document.ref.path.startsWith("mediaComments/"),
    )).toHaveLength(0);
    expect((await db.collectionGroup("requests").get()).docs.filter(
      (document) => document.ref.path.startsWith("mediaComments/"),
    )).toHaveLength(1);

    const audits = (await db.collection("admin_logs").get()).docs
      .map((document) => document.data());
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      "media_comment_create",
      "media_comment_delete",
    ]);
    expect(JSON.stringify(audits)).not.toContain("Keep one copy");
  });

  it("rolls back the comment and receipt when the audit cannot be created", async () => {
    const failed = await mutateComment({
      action: "create",
      text: "Must not commit",
    }, actor(), {
      auditFn: () => { throw new Error("audit unavailable"); },
    });
    expect(failed.statusCode).toBe(500);
    expect((await db.collectionGroup("items").get()).docs.filter(
      (document) => document.ref.path.startsWith("mediaComments/"),
    )).toHaveLength(0);
    expect((await db.collectionGroup("requests").get()).docs.filter(
      (document) => document.ref.path.startsWith("mediaComments/"),
    )).toHaveLength(0);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("paginates comments oldest first with a cursor bound to the item", async () => {
    const created = [];
    for (const text of ["First", "Second", "Third"]) {
      created.push((await mutateComment({ action: "create", text })).body.comment);
    }
    const first = await listComments({ limit: 2 });
    expect(first.body.comments.map((comment) => comment.text)).toEqual([
      "First",
      "Second",
    ]);
    expect(first.body.nextCursor).toBeTypeOf("string");
    const second = await listComments({ limit: 2, cursor: first.body.nextCursor });
    expect(second.body.comments.map((comment) => comment.text)).toEqual(["Third"]);
    expect(second.body.nextCursor).toBeNull();
    expect(() => contract.parseListMediaCommentsRequest({
      schemaVersion: 1,
      ref: VOICEOVER_REF,
      cursor: first.body.nextCursor,
    })).toThrow(/cursor/i);
    expect(created.map((comment) => comment.id)).toHaveLength(3);
  });

  it("lets only one same-version edit win a race", async () => {
    const created = await mutateComment({ action: "create", text: "Original" });
    const commentId = created.body.comment.id;
    const [left, right] = await Promise.all([
      mutateComment({
        action: "edit",
        commentId,
        baseVersion: 1,
        text: "Left edit",
      }),
      mutateComment({
        action: "edit",
        commentId,
        baseVersion: 1,
        text: "Right edit",
      }),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const page = await listComments();
    expect(page.body.comments[0].version).toBe(2);
  });

  const mutateSource = (body) => invoke(createCmsMutateMediaCommentHandler, {
    schemaVersion: 1, ref: SOURCE_REF, requestId: randomUUID(), ...body,
  });

  it("stores a frame range on the current file version and keeps it on that version", async () => {
    const asset = storedSourceAsset();
    await db.doc("mediaSourceAssets/video-1").set({
      ...asset,
      rendition: readyRendition(asset, [30000, 1001]),
    });
    const created = await mutateSource({
      action: "create", text: "Logo is cut off", time: { startFrame: 1800, endFrame: 1829, fileVersion: STORED_FILE },
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    expect(created.body.comment.time).toEqual({
      startFrame: 1800, endFrame: 1829, rateNum: 30000, rateDen: 1001,
      startMs: 60_060, endMs: 61_061, currentVersion: true,
    });
    const stored = await contract.mediaComments(db, SOURCE_REF).doc(created.body.comment.id).get();
    expect(stored.data()).toMatchObject({ sourceVersion: "private-version", startFrame: 1800 });
    expect(JSON.stringify(created.body)).not.toContain("private-version");

    const untimed = await mutateSource({ action: "create", text: "General note" });
    expect(untimed.body.comment).not.toHaveProperty("time");

    // A replaced original has a new S3 version; the old comment stays on its own version.
    await db.doc("mediaSourceAssets/video-1").update({
      objectVersionId: "replacement-version",
      rendition: admin.firestore.FieldValue.delete(),
    });
    const listed = await invoke(createCmsListMediaCommentsHandler, { schemaVersion: 1, ref: SOURCE_REF });
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.comments.find((comment) => comment.id === created.body.comment.id).time)
      .toMatchObject({ startFrame: 1800, currentVersion: false });

    // A reviewer who still has the old file open cannot stamp its time on the replacement.
    const stale = await mutateSource({
      action: "create", text: "Picked on the old file", time: { startMs: 1_000, fileVersion: STORED_FILE },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("media_comment_time_changed");
  });

  it("rejects a frame time the asset cannot honor and a replay with a different time", async () => {
    const noRate = await mutateSource({
      action: "create", text: "Frame on unmeasured video", time: { startFrame: 10, fileVersion: STORED_FILE },
    });
    expect(noRate.statusCode).toBe(409);
    expect(noRate.body.code).toBe("media_comment_time_changed");

    const r2 = await mutateComment({ action: "create", text: "Image time", time: { startMs: 10, fileVersion: STORED_FILE } });
    expect(r2.statusCode).toBe(400);

    const asset = storedSourceAsset();
    await db.doc("mediaSourceAssets/video-1").set({
      ...asset,
      rendition: readyRendition(asset, [24000, 1001], 10),
    });
    const late = await mutateSource({
      action: "create", text: "After the end", time: { startFrame: 240, fileVersion: STORED_FILE },
    });
    expect(late.statusCode).toBe(400);

    const requestId = randomUUID();
    const first = await mutateSource({
      requestId, action: "create", text: "Same text", time: { startFrame: 24, fileVersion: STORED_FILE },
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    const moved = await mutateSource({
      requestId, action: "create", text: "Same text", time: { startFrame: 25, fileVersion: STORED_FILE },
    });
    expect(moved.statusCode).toBe(409);
  });

  describe("threads, resolve, and mentions", () => {
    const staffOnly = (uid) => actor(uid, [{ role: "staff" }]);
    const onSource = (body, currentActor = staffOnly("staff-2")) => invoke(
      createCmsMutateMediaCommentHandler,
      { schemaVersion: 1, ref: SOURCE_REF, requestId: randomUUID(), ...body },
      currentActor,
    );
    const listSource = (currentActor = staffOnly("staff-2"), body = {}) => invoke(
      createCmsListMediaCommentsHandler,
      { schemaVersion: 1, ref: SOURCE_REF, ...body },
      currentActor,
    );
    const storedComment = async (id, ref = SOURCE_REF) =>
      (await contract.mediaComments(db, ref).doc(id).get()).data();
    const auditActions = async () => (await db.collection("admin_logs").get()).docs
      .map((document) => document.data());

    beforeEach(async () => {
      await Promise.all([
        db.doc("users/staff-3").set({ active: true, displayName: "Riley Staff", grants: [{ role: "staff" }] }),
        db.doc("users/gone-1").set({ active: false, displayName: "Gone Staff", grants: [{ role: "editor" }] }),
      ]);
    });

    it("adds one level of replies on the same item", async () => {
      const parent = await onSource({ action: "create", text: "Logo is cut off" });
      expect(parent.statusCode, JSON.stringify(parent.body)).toBe(200);
      const parentId = parent.body.comment.id;
      expect(parent.body.comment).toMatchObject({ parentId: null, resolvedAt: null, canResolve: true });

      const reply = await onSource({ action: "create", text: "Fixed in v2", parentId }, staffOnly("staff-3"));
      expect(reply.statusCode, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.comment).toMatchObject({ parentId, canResolve: false, canEdit: true });
      expect(reply.body.comment).not.toHaveProperty("time");
      expect((await storedComment(parentId)).replyCount).toBe(1);

      const toReply = await onSource({ action: "create", text: "Nested", parentId: reply.body.comment.id });
      expect(toReply.statusCode).toBe(400);
      expect(toReply.body.error).toMatch(/first comment in the thread/i);

      const missing = await onSource({ action: "create", text: "Gone", parentId: "e".repeat(64) });
      expect(missing.statusCode).toBe(404);

      // A parent on another item is not in this item's comments.
      const otherItem = await mutateComment({ action: "create", text: "On the image", parentId });
      expect(otherItem.statusCode).toBe(404);

      const timed = await onSource({
        action: "create", text: "Timed reply", parentId, time: { startMs: 1, fileVersion: STORED_FILE },
      });
      expect(timed.statusCode).toBe(400);

      const listed = await listSource();
      expect(listed.body.comments.map((comment) => [comment.text, comment.parentId])).toEqual([
        ["Logo is cut off", null],
        ["Fixed in v2", parentId],
      ]);
      expect(JSON.stringify(listed.body)).not.toContain("replyCount");
      expect(listed.body.comments.map((comment) => comment.hasReplies)).toEqual([true, false]);
      expect((await storedComment(parentId)).replyCount).toBe(1);
      const creates = (await auditActions()).filter((entry) => entry.action === "media_comment_create");
      expect(creates).toHaveLength(2);
      expect(creates.find((entry) => entry.target.commentId === reply.body.comment.id).after)
        .toMatchObject({ parentId, resolved: false });
    });

    it("keeps a first comment with replies and allows its delete after the replies go", async () => {
      const parent = await onSource({ action: "create", text: "Thread start" });
      const parentId = parent.body.comment.id;
      const reply = await onSource({ action: "create", text: "Reply", parentId }, staffOnly("staff-3"));
      const blocked = await onSource({ action: "delete", commentId: parentId, baseVersion: 1 });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.body.code).toBe("media_comment_has_replies");
      expect(await storedComment(parentId)).toBeDefined();

      const removedReply = await onSource({
        action: "delete", commentId: reply.body.comment.id, baseVersion: 1,
      }, staffOnly("staff-3"));
      expect(removedReply.statusCode).toBe(200);
      expect((await storedComment(parentId)).replyCount).toBe(0);
      const removedParent = await onSource({ action: "delete", commentId: parentId, baseVersion: 1 });
      expect(removedParent.statusCode, JSON.stringify(removedParent.body)).toBe(200);
      expect((await auditActions()).map((entry) => entry.action).sort()).toEqual([
        "media_comment_create",
        "media_comment_create",
        "media_comment_delete",
        "media_comment_delete",
      ]);
    });

    it("lets the author, the uploader, and a media manager resolve and reopen", async () => {
      // staff-1 uploaded video-1; staff-2 writes the comment; staff-3 has neither role.
      const created = await onSource({ action: "create", text: "Check the levels" });
      const commentId = created.body.comment.id;
      expect((await listSource(staffOnly("staff-3"))).body.comments[0].canResolve).toBe(false);
      expect((await listSource(staffOnly("staff-1"))).body.comments[0].canResolve).toBe(true);
      expect((await listSource(actor("admin-1", [{ role: "super_admin" }]))).body.comments[0].canResolve)
        .toBe(true);

      const outsider = await onSource({ action: "resolve", commentId, baseVersion: 1 }, staffOnly("staff-3"));
      expect(outsider.statusCode).toBe(403);
      expect((await storedComment(commentId)).resolvedAt).toBeNull();

      const byUploader = await onSource({ action: "resolve", commentId, baseVersion: 1 }, staffOnly("staff-1"));
      expect(byUploader.statusCode, JSON.stringify(byUploader.body)).toBe(200);
      expect(byUploader.body.comment).toMatchObject({
        version: 2,
        resolvedBy: { uid: "staff-1", name: "Sam Staff" },
        canResolve: true,
      });
      expect(byUploader.body.comment.resolvedAt).toBeTypeOf("string");
      // Resolving does not mark the text as edited.
      expect(byUploader.body.comment.updatedAt).toBe(created.body.comment.updatedAt);

      const byAuthor = await onSource({ action: "reopen", commentId, baseVersion: 2 });
      expect(byAuthor.statusCode).toBe(200);
      expect(byAuthor.body.comment).toMatchObject({ version: 3, resolvedAt: null, resolvedBy: null });

      const byManager = await onSource(
        { action: "resolve", commentId, baseVersion: 3 },
        actor("admin-1", [{ role: "super_admin" }]),
      );
      expect(byManager.statusCode).toBe(200);
      expect(byManager.body.comment.resolvedBy).toEqual({ uid: "admin-1", name: "Alex Admin" });

      const audits = (await auditActions()).filter((entry) => entry.action !== "media_comment_create");
      expect(audits.map((entry) => entry.action).sort()).toEqual([
        "media_comment_reopen",
        "media_comment_resolve",
        "media_comment_resolve",
      ]);
      const reopen = audits.find((entry) => entry.action === "media_comment_reopen");
      expect(reopen.before).toMatchObject({ resolved: true, version: 2 });
      expect(reopen.after).toMatchObject({ resolved: false, version: 3 });
      expect(JSON.stringify(audits)).not.toContain("Check the levels");
    });

    it("replays a resolve request, checks versions, and refuses replies and repeats", async () => {
      const created = await onSource({ action: "create", text: "Fix the fade" });
      const commentId = created.body.comment.id;
      const requestId = randomUUID();
      const first = await onSource({ requestId, action: "resolve", commentId, baseVersion: 1 });
      const replay = await onSource({ requestId, action: "resolve", commentId, baseVersion: 1 });
      expect(first.statusCode).toBe(200);
      expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.comment).toEqual(first.body.comment);
      expect((await storedComment(commentId)).version).toBe(2);
      expect((await auditActions()).filter((entry) => entry.action === "media_comment_resolve"))
        .toHaveLength(1);

      const reused = await onSource({ requestId, action: "reopen", commentId, baseVersion: 2 });
      expect(reused.statusCode).toBe(409);
      expect(reused.body.error).toMatch(/already used/i);

      const stale = await onSource({ action: "reopen", commentId, baseVersion: 1 });
      expect(stale.statusCode).toBe(409);
      expect(stale.body.code).toBe("media_comment_conflict");
      const again = await onSource({ action: "resolve", commentId, baseVersion: 2 });
      expect(again.statusCode).toBe(409);

      const reply = await onSource({ action: "create", text: "Reply", parentId: commentId });
      expect(reply.statusCode).toBe(200);
      const resolveReply = await onSource({
        action: "resolve", commentId: reply.body.comment.id, baseVersion: 1,
      });
      expect(resolveReply.statusCode).toBe(400);
      expect(resolveReply.body.error).toMatch(/first comment in a thread/i);
    });

    it("stores mention IDs for active staff only and renders names at read time", async () => {
      const unknown = await onSource({ action: "create", text: "Hi @Ghost", mentions: ["staff-1", "ghost-1"] });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.body.code).toBe("media_comment_mention_invalid");
      const inactive = await onSource({ action: "create", text: "Hi @Gone", mentions: ["gone-1"] });
      expect(inactive.statusCode).toBe(400);
      expect(inactive.body.code).toBe("media_comment_mention_invalid");
      expect((await db.collectionGroup("items").get()).docs.filter(
        (document) => document.ref.path.startsWith("mediaComments/"),
      )).toHaveLength(0);

      const created = await onSource({ action: "create", text: "@Sam Staff and @Riley Staff", mentions: ["staff-1", "staff-3"] });
      expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
      expect((await storedComment(created.body.comment.id)).mentions).toEqual(["staff-1", "staff-3"]);
      expect(created.body.comment.mentions).toEqual([
        { uid: "staff-1", name: "Sam Staff" },
        { uid: "staff-3", name: "Riley Staff" },
      ]);

      // A later name change and a deactivation show on the next read; the stored IDs stay.
      await db.doc("users/staff-1").update({ displayName: "Sam Q. Staff" });
      await db.doc("users/staff-3").update({ active: false });
      const listed = await listSource(staffOnly("staff-1"));
      expect(listed.body.comments[0].mentions).toEqual([
        { uid: "staff-1", name: "Sam Q. Staff" },
        { uid: "staff-3", name: "Former staff member" },
      ]);

      // An edit cannot add someone who is not active staff.
      const badEdit = await onSource({
        action: "edit", commentId: created.body.comment.id, baseVersion: 1, text: "Edit", mentions: ["staff-1", "staff-3", "gone-1"],
      });
      expect(badEdit.statusCode).toBe(400);
      expect(badEdit.body.code).toBe("media_comment_mention_invalid");
      const keepMentions = await onSource({
        action: "edit", commentId: created.body.comment.id, baseVersion: 1, text: "Edited text",
      });
      expect(keepMentions.statusCode).toBe(200);
      expect((await storedComment(created.body.comment.id)).mentions).toEqual(["staff-1", "staff-3"]);
      const audit = (await auditActions()).find((entry) => entry.action === "media_comment_edit");
      expect(audit.after.mentions).toEqual(["staff-1", "staff-3"]);

      // An edit that keeps a stored mention of someone who left can still add active staff.
      const added = await onSource({
        action: "edit", commentId: created.body.comment.id, baseVersion: 2,
        text: "Edited text, @Pat Staff", mentions: ["staff-1", "staff-3", "staff-2"],
      });
      expect(added.statusCode, JSON.stringify(added.body)).toBe(200);
      expect((await storedComment(created.body.comment.id)).mentions).toEqual(["staff-1", "staff-3", "staff-2"]);
    });

    it("returns the fields the open, resolved, mine, and mentions-me filters use", async () => {
      const mine = await onSource({ action: "create", text: "Mine", mentions: ["staff-3"] });
      const theirs = await onSource({ action: "create", text: "Theirs" }, staffOnly("staff-3"));
      await onSource({ action: "resolve", commentId: theirs.body.comment.id, baseVersion: 1 }, staffOnly("staff-3"));
      const forStaff3 = (await listSource(staffOnly("staff-3"))).body.comments;
      expect(forStaff3.map((comment) => ({
        text: comment.text,
        mine: comment.canEdit,
        mentionsYou: comment.mentionsYou,
        resolved: comment.resolvedAt !== null,
      }))).toEqual([
        { text: "Mine", mine: false, mentionsYou: true, resolved: false },
        { text: "Theirs", mine: true, mentionsYou: false, resolved: true },
      ]);
      expect(mine.body.comment.mentionsYou).toBe(false);
    });

    it("lists active named staff for mentions only to readers of the item", async () => {
      await db.doc("users/no-name").set({ active: true, grants: [{ role: "staff" }] });
      const listed = await listSource(staffOnly("staff-2"), { staff: true });
      expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body).toEqual({
        success: true,
        staff: [
          { uid: "admin-1", name: "Alex Admin" },
          { uid: "staff-3", name: "Riley Staff" },
          { uid: "staff-1", name: "Sam Staff" },
          { uid: "staff-2", name: "Taylor Staff" },
        ],
      });
      const scoped = await listComments(
        { staff: true },
        actor("staff-1", [{ role: "editor", sections: [], registeredMediaSections: [] }]),
      );
      expect(scoped.statusCode).toBe(404);
      expect(scoped.body).not.toHaveProperty("staff");
    });
  });
});
