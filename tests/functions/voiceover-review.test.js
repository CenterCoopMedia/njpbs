import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { Readable, Writable } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import reviewModule from "../../functions/voiceover-review.js";
import audioModule from "../../functions/voiceover-audio.js";
import contract from "../../functions/lib/voiceover-review.js";
import voiceoverMedia from "../../functions/lib/voiceover-media.js";

const TAKE_ID = "soft-spoken-watching-station-01";
const HASH = "a".repeat(64);
const admitted = (uid = "reviewer", sections) => ({
  uid,
  email: `${uid}@example.org`,
  emailVerified: true,
  approvedActive: true,
  principal: { id: uid, grants: [{ role: "staff", ...(sections ? { sections } : {}) }] },
});
function take(overrides = {}) {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    active: true,
    id: TAKE_ID,
    family_id: "watching-station",
    family: "Watching NJ PBS",
    take: 1,
    style: "soft-spoken",
    performer_id: "jules-avery",
    text: "You're watching NJ PBS.",
    display_text: "You're watching NJ PBS.",
    complete: true,
    flags: [],
    insert_note: "",
    duration_seconds: 2.058,
    order: 0,
    objectKey: `takes/v1/${TAKE_ID}.wav`,
    sizeBytes: 4,
    contentHash: HASH,
    recordedByUid: "private-recorder-uid",
    recordedByName: "Private CMS name",
    ...overrides,
  };
}

function mediaAsset(overrides = {}) {
  const storedTake = take();
  return {
    source: "voiceover",
    kind: "audio",
    mimeType: "audio/wav",
    lifecycle: "active",
    category: "general",
    voiceoverTakeId: TAKE_ID,
    voiceover: {
      manifestVersion: storedTake.manifestVersion,
      id: storedTake.id,
      family_id: storedTake.family_id,
      family: storedTake.family,
      take: storedTake.take,
      style: storedTake.style,
      performer_id: storedTake.performer_id,
      performer_name: "Jules Avery",
      text: storedTake.text,
      display_text: storedTake.display_text,
      complete: storedTake.complete,
      flags: storedTake.flags,
      insert_note: storedTake.insert_note,
      duration_seconds: storedTake.duration_seconds,
    },
    storageKey: storedTake.objectKey,
    sizeBytes: storedTake.sizeBytes,
    contentHash: storedTake.contentHash,
    ...overrides,
  };
}

function jsonResponse() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

function audioResponse() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.statusCode = 0;
  response.headers = {};
  response.body = null;
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.set = (name, value) => {
    response.headers[name.toLowerCase()] = value;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    response.end();
    return response;
  };
  response.collected = () => Buffer.concat(chunks);
  return response;
}

function request(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    body,
    rawBody,
    headers: { "content-type": "application/json" },
  };
}

describe("voiceover review contract", () => {
  it("parses the exact obsolete list and save payloads for a clear endpoint response", () => {
    expect(contract.parseReviewRequest({ action: "list", schemaVersion: 1 }))
      .toEqual({ action: "list", schemaVersion: 1 });
    expect(contract.parseReviewRequest({
      action: "save",
      schemaVersion: 1,
      manifestVersion: 1,
      takeId: TAKE_ID,
      baseVersion: 0,
      favorite: true,
      moreLikeThis: false,
      notes: "First\r\nSecond",
    }).notes).toBe("First\nSecond");
  });

  it("rejects client identity, invalid versions and overlong notes", () => {
    expect(() => contract.parseReviewRequest({
      action: "list",
      schemaVersion: 1,
      reviewerUid: "other",
    })).toThrow(/invalid/i);
    expect(() => contract.parseReviewRequest({
      action: "save",
      schemaVersion: 1,
      manifestVersion: 2,
      takeId: TAKE_ID,
      baseVersion: 0,
      favorite: false,
      moreLikeThis: false,
      notes: "",
    })).toThrow(/reload/i);
    expect(() => contract.normalizeNotes("x".repeat(2_001))).toThrow(/2,000/);
    expect(contract.normalizeNotes("😀".repeat(2_000))).toHaveLength(4_000);
  });

  it("accepts bounded media review and audio payloads without a legacy favorite write", () => {
    expect(contract.parseReviewRequest({
      action: "get-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    })).toEqual({
      action: "get-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    });
    expect(contract.parseReviewRequest({
      action: "save-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
      baseVersion: 2,
      moreLikeThis: true,
      notes: "New\rnotes",
    })).toEqual({
      action: "save-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
      baseVersion: 2,
      moreLikeThis: true,
      notes: "New\nnotes",
    });
    expect(contract.parseAudioRequest({
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    })).toEqual({
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    });
    expect(() => contract.parseReviewRequest({
      action: "save-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
      baseVersion: 0,
      favorite: true,
      moreLikeThis: false,
      notes: "",
    })).toThrow(/invalid/i);
  });

  it("projects safe voiceover media metadata without private storage fields", () => {
    const projection = voiceoverMedia.projectVoiceoverMedia(mediaAsset());
    expect(projection).toMatchObject({
      manifestVersion: 1,
      id: TAKE_ID,
      performer_name: "Jules Avery",
      display_text: "You're watching NJ PBS.",
    });
    expect(projection).not.toHaveProperty("storageKey");
    expect(projection).not.toHaveProperty("contentHash");
    expect(voiceoverMedia.projectVoiceoverMedia(mediaAsset({
      voiceoverTakeId: "different-take",
    }))).toBeNull();
  });
});

describe("voiceover review persistence", () => {
  let db;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error("Use the Firestore emulator for voiceover review tests.");
    }
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("voiceover-review.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    await db.doc("voiceoverLibrary/current").set({
      schemaVersion: 1,
      manifestVersion: 1,
      status: "review-ready",
      takeCount: 1,
      performers: { "jules-avery": { name: "Jules Avery" } },
    });
    await db.doc(`voiceoverTakes/${TAKE_ID}`).set(take());
    await db.doc(`media_assets/voiceover-${TAKE_ID}`).set(mediaAsset());
    log.error.mockClear();
  });

  async function invokeReview(body, user = admitted(), firestore = db) {
    const res = jsonResponse();
    await reviewModule.createCmsVoiceoverReviewHandler({
      firestore,
      requirePrincipalFn: async () => user,
      now: () => "2026-09-10T18:00:00.000Z",
      log,
    })(request(body), res);
    return res;
  }

  it("retires obsolete list and save actions without reading legacy or review data", async () => {
    const save = {
      action: "save",
      schemaVersion: 1,
      manifestVersion: 1,
      takeId: TAKE_ID,
      baseVersion: 0,
      favorite: false,
      moreLikeThis: false,
      notes: "",
    };
    const firestore = {
      collection: vi.fn(() => { throw new Error("unexpected Firestore collection read"); }),
      doc: vi.fn(() => { throw new Error("unexpected Firestore document read"); }),
      runTransaction: vi.fn(() => { throw new Error("unexpected Firestore transaction"); }),
    };

    for (const body of [{ action: "list", schemaVersion: 1 }, save]) {
      const result = await invokeReview(body, admitted(), firestore);
      expect(result.statusCode).toBe(409);
      expect(result.body).toEqual({
        error: "Voiceovers now live in Audio. Reload Boardwalk to continue.",
        code: "voiceover_review_obsolete",
      });
    }
    expect(firestore.collection).not.toHaveBeenCalled();
    expect(firestore.doc).not.toHaveBeenCalled();
    expect(firestore.runTransaction).not.toHaveBeenCalled();
  });

  it("reads and saves media reviews for only the caller with optimistic versions", async () => {
    const reviewRef = db.doc(`voiceoverReviews/reviewer/takes/${TAKE_ID}`);
    await reviewRef.set({
      schemaVersion: 1,
      manifestVersion: 1,
      takeId: TAKE_ID,
      favorite: true,
      moreLikeThis: false,
      notes: "Legacy note.",
      version: 1,
      createdAt: "2026-09-10T17:00:00.000Z",
      updatedAt: "2026-09-10T17:30:00.000Z",
    });
    await db.doc("voiceoverLibrary/current").delete();
    await db.doc(`voiceoverTakes/${TAKE_ID}`).delete();

    const get = await invokeReview({
      action: "get-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    }, admitted());
    expect(get.statusCode).toBe(200);
    expect(get.body).toEqual({
      success: true,
      review: {
        favorite: true,
        moreLikeThis: false,
        notes: "Legacy note.",
        version: 1,
        updatedAt: "2026-09-10T17:30:00.000Z",
      },
    });

    const saveRequest = {
      action: "save-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
      baseVersion: 1,
      moreLikeThis: true,
      notes: "Keep this read.",
    };
    const save = await invokeReview(saveRequest, admitted());
    expect(save.statusCode).toBe(200);
    expect(save.body).toEqual({
      success: true,
      review: {
        favorite: true,
        moreLikeThis: true,
        notes: "Keep this read.",
        version: 2,
        updatedAt: "2026-09-10T18:00:00.000Z",
      },
    });
    expect((await reviewRef.get()).data().favorite).toBe(true);

    const stale = await invokeReview(saveRequest, admitted());
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("voiceover_review_conflict");
    const other = await invokeReview({
      action: "get-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    }, admitted("other"));
    expect(other.body).toEqual({ success: true, review: null });
  });

  it("denies media reviews without admission or a valid grant", async () => {
    const body = {
      action: "get-media",
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    };
    expect((await invokeReview(body, {
      ...admitted(),
      emailVerified: false,
    })).statusCode).toBe(403);
    expect((await invokeReview(
      body,
      admitted("scoped", []),
    )).statusCode).toBe(403);
  });

  it("keeps admission and request validation ahead of the obsolete response", async () => {
    const list = { action: "list", schemaVersion: 1 };
    expect((await invokeReview(list, { ...admitted(), emailVerified: false })).statusCode)
      .toBe(403);
    expect((await invokeReview(list, {
      ...admitted(),
      principal: { id: "reviewer", grants: [{ role: "unknown" }] },
    })).statusCode).toBe(403);
    expect((await invokeReview({
      action: "list",
      schemaVersion: 1,
      reviewerUid: "other",
    })).statusCode).toBe(400);
  });

  it("translates a legacy take ID to canonical media without reading legacy records", async () => {
    await db.doc("voiceoverLibrary/current").delete();
    await db.doc(`voiceoverTakes/${TAKE_ID}`).delete();
    const storage = {
      getIfExists: vi.fn(async () => ({
        body: Readable.from([Buffer.from("WAVE")]),
        contentLength: 4,
        contentType: "audio/wav",
        metadata: { sha256: HASH },
      })),
    };
    const collection = vi.fn((name) => {
      if (name !== "media_assets") throw new Error(`unexpected collection: ${name}`);
      return db.collection(name);
    });
    const res = audioResponse();
    await audioModule.createCmsGetVoiceoverAudioHandler({
      firestore: { collection },
      requirePrincipalFn: async () => admitted(),
      storageFactory: () => storage,
      log,
    })(request({ schemaVersion: 1, takeId: TAKE_ID }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "cache-control": "private, no-store",
      "content-type": "audio/wav",
      "content-length": "4",
    });
    expect(res.collected().toString()).toBe("WAVE");
    expect(storage.getIfExists).toHaveBeenCalledWith(`takes/v1/${TAKE_ID}.wav`);
    expect(collection).toHaveBeenCalledTimes(1);
    expect(collection).toHaveBeenCalledWith("media_assets");
  });

  it("streams canonical media audio without reading the legacy voiceover library", async () => {
    await db.doc("voiceoverLibrary/current").delete();
    await db.doc(`voiceoverTakes/${TAKE_ID}`).delete();
    const storage = {
      getIfExists: vi.fn(async () => ({
        body: Readable.from([Buffer.from("WAVE")]),
        contentLength: 4,
        contentType: "audio/wav",
        metadata: { sha256: HASH },
      })),
    };
    const res = audioResponse();
    await audioModule.createCmsGetVoiceoverAudioHandler({
      firestore: db,
      requirePrincipalFn: async () => admitted(),
      storageFactory: () => storage,
      log,
    })(request({
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.collected().toString()).toBe("WAVE");
    expect(storage.getIfExists).toHaveBeenCalledWith(`takes/v1/${TAKE_ID}.wav`);
  });

  it("denies inadmissible and malformed-grant media audio before R2", async () => {
    const storage = { getIfExists: vi.fn() };
    const unadmitted = audioResponse();
    await audioModule.createCmsGetVoiceoverAudioHandler({
      firestore: db,
      requirePrincipalFn: async () => ({ ...admitted(), emailVerified: false }),
      storageFactory: () => storage,
      log,
    })(request({
      schemaVersion: 1,
      assetId: `voiceover-${TAKE_ID}`,
    }), unadmitted);
    expect(unadmitted.statusCode).toBe(403);

    for (const body of [
      { schemaVersion: 1, assetId: `voiceover-${TAKE_ID}` },
      { schemaVersion: 1, takeId: TAKE_ID },
    ]) {
      const denied = audioResponse();
      await audioModule.createCmsGetVoiceoverAudioHandler({
        firestore: db,
        requirePrincipalFn: async () => admitted("scoped", []),
        storageFactory: () => storage,
        log,
      })(request(body), denied);
      expect(denied.statusCode).toBe(403);
    }
    expect(storage.getIfExists).not.toHaveBeenCalled();
  });

  it("refuses malformed canonical media locators for both request bodies before R2", async () => {
    await db.doc(`media_assets/voiceover-${TAKE_ID}`).update({
      storageKey: "takes/v1/different.wav",
    });
    const storage = { getIfExists: vi.fn() };
    for (const body of [
      { schemaVersion: 1, assetId: `voiceover-${TAKE_ID}` },
      { schemaVersion: 1, takeId: TAKE_ID },
    ]) {
      const res = audioResponse();
      await audioModule.createCmsGetVoiceoverAudioHandler({
        firestore: db,
        requirePrincipalFn: async () => admitted(),
        storageFactory: () => storage,
        log,
      })(request(body), res);
      expect(res.statusCode).toBe(503);
    }
    expect(storage.getIfExists).not.toHaveBeenCalled();
  });

  it("does not read R2 for denied callers and refuses mismatched objects", async () => {
    const storage = { getIfExists: vi.fn() };
    const denied = audioResponse();
    await audioModule.createCmsGetVoiceoverAudioHandler({
      firestore: db,
      requirePrincipalFn: async () => ({ ...admitted(), emailVerified: false }),
      storageFactory: () => storage,
      log,
    })(request({ schemaVersion: 1, takeId: TAKE_ID }), denied);
    expect(denied.statusCode).toBe(403);
    expect(storage.getIfExists).not.toHaveBeenCalled();

    storage.getIfExists.mockResolvedValue({
      body: Readable.from([Buffer.from("bad")]),
      contentLength: 3,
      contentType: "audio/wav",
      metadata: { sha256: HASH },
    });
    const mismatch = audioResponse();
    await audioModule.createCmsGetVoiceoverAudioHandler({
      firestore: db,
      requirePrincipalFn: async () => admitted(),
      storageFactory: () => storage,
      log,
    })(request({ schemaVersion: 1, takeId: TAKE_ID }), mismatch);
    expect(mismatch.statusCode).toBe(503);
    expect(mismatch.body.error).toMatch(/unavailable/i);
  });
});
