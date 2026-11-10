import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import mediaFavorites from "../../functions/media-favorites.js";
import favoriteContract from "../../functions/lib/media-favorites.js";

const { createCmsSetMediaFavoritesHandler } = mediaFavorites;
const { canonicalFavoriteRef, favoriteDocumentId } = favoriteContract;
const uid = "batch-favorite-staff";
const createdAt = admin.firestore.Timestamp.fromDate(new Date("2026-10-01T12:00:00Z"));

function savedFavorite(ref) {
  return { ref, canonicalRef: canonicalFavoriteRef(ref), createdAt };
}

function savedAsset(ref) {
  return {
    name: ref.id,
    originalName: `${ref.id}.png`,
    mimeType: "image/png",
    kind: "image",
    category: "news",
    lifecycle: "active",
    version: 1,
    sizeBytes: 128,
    width: 10,
    height: 10,
    url: `https://media.example.test/${ref.id}.png`,
  };
}

describe("batch favorite request database budget", () => {
  let db;
  let databaseTransactions;
  let transactionFailure;
  let handler;

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error("Use the Firestore emulator for batch favorite tests");
    }
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("media-favorites-batch.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    databaseTransactions = 0;
    transactionFailure = false;
    // Measure the database boundary while retaining the real SDK and emulator.
    const firestore = {
      collection: (name) => db.collection(name),
      runTransaction: (work) => {
        databaseTransactions += 1;
        return db.runTransaction(async (transaction) => {
          const result = await work(transaction);
          if (transactionFailure) throw new Error("Database transaction failed");
          return result;
        });
      },
    };
    handler = createCmsSetMediaFavoritesHandler({
      firestore,
      requirePrincipalFn: async () => ({
        uid,
        emailVerified: true,
        approvedActive: true,
        principal: { id: uid, grants: [{ role: "super_admin" }] },
      }),
      verifyAppCheckFn: async () => true,
      log: { error() {} },
    });
  });

  async function submit(refs, favorite) {
    const body = { refs, favorite };
    const res = { statusCode: null, body: null, headersSent: false };
    res.set = () => res;
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (value) => { res.body = value; res.headersSent = true; return res; };
    await handler({
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-firebase-appcheck": "local-only" },
      rawBody: Buffer.from(JSON.stringify(body)),
    }, res);
    return res;
  }

  it.each([true, false])("uses one transaction for 100 refs with favorite=%s, including replay", async (favorite) => {
    const refs = Array.from({ length: 100 }, (_, index) => ({
      backend: "r2", id: `batch-asset-${index}`,
    }));
    const seed = db.batch();
    for (const ref of refs) {
      if (favorite) {
        seed.set(db.doc(`media_assets/${ref.id}`), savedAsset(ref));
      } else {
        // Clearing unavailable favorites must retain the same database budget.
        seed.set(db.doc(`mediaFavorites/${uid}/items/${favoriteDocumentId(ref)}`), savedFavorite(ref));
      }
    }
    const otherAccount = db.doc(`mediaFavorites/other-staff/items/${favoriteDocumentId(refs[0])}`);
    seed.set(otherAccount, savedFavorite(refs[0]));
    await seed.commit();

    let firstSaved;
    for (const changed of [true, false]) {
      databaseTransactions = 0;
      const res = await submit(refs, favorite);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        success: true,
        favorite,
        results: refs.map((ref) => ({ ref, favorite, changed })),
      });
      const stored = await db.collection(`mediaFavorites/${uid}/items`).get();
      expect(stored.size).toBe(favorite ? 100 : 0);
      if (changed) firstSaved = stored.docs.map((document) => document.data());
      else expect(stored.docs.map((document) => document.data())).toEqual(firstSaved);
      for (const document of stored.docs) {
        expect(document.data().canonicalRef).toBe(canonicalFavoriteRef(document.data().ref));
        expect(document.data().createdAt).toBeInstanceOf(admin.firestore.Timestamp);
      }
      expect((await otherAccount.get()).data()).toEqual(savedFavorite(refs[0]));
      expect(databaseTransactions).toBe(1);
    }
  });

  it("keeps ordered partial results and preserves a colliding record", async () => {
    const refs = ["available", "missing", "collision", "already-saved"]
      .map((id) => ({ backend: "r2", id }));
    const seed = db.batch();
    for (const ref of [refs[0], refs[2], refs[3]]) {
      seed.set(db.doc(`media_assets/${ref.id}`), savedAsset(ref));
    }
    const collision = db.doc(`mediaFavorites/${uid}/items/${favoriteDocumentId(refs[2])}`);
    const otherRef = { backend: "r2", id: "different-identity" };
    seed.set(collision, savedFavorite(otherRef));
    seed.set(db.doc(`mediaFavorites/${uid}/items/${favoriteDocumentId(refs[3])}`), savedFavorite(refs[3]));
    await seed.commit();

    const res = await submit(refs, true);
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([
      { ref: refs[0], favorite: true, changed: true },
      { ref: refs[1], error: "Media asset is unavailable", status: 404 },
      { ref: refs[2], error: "Failed to set media favorite", status: 500 },
      { ref: refs[3], favorite: true, changed: false },
    ]);
    const stored = await db.collection(`mediaFavorites/${uid}/items`).get();
    expect(stored.size).toBe(3);
    expect((await collision.get()).data()).toEqual(savedFavorite(otherRef));
    expect((await db.doc(`mediaFavorites/${uid}/items/${favoriteDocumentId(refs[3])}`).get()).data())
      .toEqual(savedFavorite(refs[3]));
    expect(databaseTransactions).toBe(1);
  });

  it("does no transaction when every target is unavailable", async () => {
    const refs = [{ backend: "r2", id: "missing" }];
    const res = await submit(refs, true);
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([
      { ref: refs[0], error: "Media asset is unavailable", status: 404 },
    ]);
    expect((await db.collection(`mediaFavorites/${uid}/items`).get()).empty).toBe(true);
    expect(databaseTransactions).toBe(0);
  });

  it("reports transaction failure without committed changes or false successes", async () => {
    const refs = ["available", "missing", "already-saved"]
      .map((id) => ({ backend: "r2", id }));
    const seed = db.batch();
    for (const ref of [refs[0], refs[2]]) {
      seed.set(db.doc(`media_assets/${ref.id}`), savedAsset(ref));
    }
    const existing = db.doc(`mediaFavorites/${uid}/items/${favoriteDocumentId(refs[2])}`);
    seed.set(existing, savedFavorite(refs[2]));
    await seed.commit();
    transactionFailure = true;

    const res = await submit(refs, true);
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([
      { ref: refs[0], error: "Failed to set media favorite", status: 500 },
      { ref: refs[1], error: "Media asset is unavailable", status: 404 },
      { ref: refs[2], error: "Failed to set media favorite", status: 500 },
    ]);
    expect((await db.collection(`mediaFavorites/${uid}/items`).get()).size).toBe(1);
    expect((await existing.get()).data()).toEqual(savedFavorite(refs[2]));
  });
});
