import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import adminPkg from "../helpers/firebase-admin.js";
import favoriteContract from "../../functions/lib/media-favorites.js";
import {
  assertMigrationEnvironment,
  migrateVoiceoversToMedia,
  parseArguments,
} from "../../scripts/migrate-voiceovers-to-media.mjs";
import {
  FIXTURE_CATEGORY,
  FIXTURE_NOW,
  seedVoiceoverMediaFixture,
} from "../helpers/voiceover-media-migration-fixture.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const COMPLETION_PATH = "system/voiceoverMediaMigrationV1";
const { favoriteDocumentId } = favoriteContract;
let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function sourceSnapshot() {
  const [library, takes, reviews] = await Promise.all([
    db.doc("voiceoverLibrary/current").get(),
    db.collection("voiceoverTakes").get(),
    db.collectionGroup("takes").get(),
  ]);
  return {
    library: library.data(),
    takes: takes.docs.map((document) => [document.ref.path, document.data()]),
    reviews: reviews.docs
      .filter((document) => document.ref.path.startsWith("voiceoverReviews/"))
      .map((document) => [document.ref.path, document.data()]),
  };
}

async function migrationTargetSnapshot() {
  const [media, favorites, discovery, completion] = await Promise.all([
    db.collection("media_assets").get(),
    db.collectionGroup("items").get(),
    db.doc("system/mediaDiscovery").get(),
    db.doc(COMPLETION_PATH).get(),
  ]);
  return {
    media: media.docs
      .map((document) => [document.ref.path, document.data()])
      .sort(([left], [right]) => left.localeCompare(right)),
    favorites: favorites.docs
      .map((document) => [document.ref.path, document.data()])
      .sort(([left], [right]) => left.localeCompare(right)),
    discovery: discovery.data(),
    completion: completion.data(),
  };
}

function migrationOptions(overrides = {}) {
  return {
    firestore: db,
    category: FIXTURE_CATEGORY,
    nowIso: FIXTURE_NOW,
    ...overrides,
  };
}

function favoritePath(uid, takeId) {
  const ref = { backend: "r2", id: `voiceover-${takeId}` };
  return `mediaFavorites/${uid}/items/${favoriteDocumentId(ref)}`;
}

function firestoreWithTransactionRace(firestore, mutate, transactionNumber = 1) {
  let transactions = 0;
  return {
    app: firestore.app,
    _settings: firestore._settings,
    collection: (...args) => firestore.collection(...args),
    collectionGroup: (...args) => firestore.collectionGroup(...args),
    doc: (...args) => firestore.doc(...args),
    getAll: (...args) => firestore.getAll(...args),
    batch: (...args) => firestore.batch(...args),
    runTransaction: async (callback) => {
      transactions += 1;
      if (transactions === transactionNumber) {
        await mutate();
      }
      return firestore.runTransaction(callback);
    },
  };
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("Use the Firestore emulator for voiceover media migration tests.");
  }
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("voiceover media migration", () => {
  describe("canonical migration fixture", () => {
    let fixture;
    let before;

    beforeEach(async () => {
      fixture = await seedVoiceoverMediaFixture(db);
      before = await sourceSnapshot();
    });

    it("dry-runs all 196 assets and favorite writes without changing Firestore", async () => {

      const result = await migrateVoiceoversToMedia(migrationOptions());

      expect(result).toEqual({
        mode: "migrate",
        apply: false,
        chunkSize: 25,
        project: PROJECT,
        source: {
          activeTakes: 196,
          reviews: 4,
          favoriteReviews: 3,
          falseFavorites: 1,
          moreLikeThis: 2,
          notes: 3,
          derivedTagOmissions: 0,
        },
        media: {
          planned: 196,
          created: 0,
          verified: 0,
          retained: 0,
          deleted: 0,
          skipped: 0,
          conflicts: 0,
        },
        favorites: {
          planned: 2,
          created: 0,
          verified: 0,
          retained: 1,
          deleted: 0,
          skipped: 0,
          conflicts: 0,
        },
        discoveryRevision: { planned: 8, updated: 0 },
        completion: {
          planned: 1,
          created: 0,
          verified: 0,
          retained: 0,
          deleted: 0,
          skipped: 0,
          conflicts: 0,
        },
        plannedWrites: 207,
      });
      expect((await db.collection("media_assets").get()).empty).toBe(true);
      expect((await db.collectionGroup("items").get()).size).toBe(1);
      expect((await db.doc("system/mediaDiscovery").get()).exists).toBe(false);
      expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(false);
      expect(await sourceSnapshot()).toEqual(before);
      expect((await db.doc(fixture.existingFavoritePath).get()).exists).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(fixture.takes[0].objectKey);
      expect(serialized).not.toContain(fixture.takes[0].contentHash);
      expect(serialized).not.toContain("Warm delivery.");
    });

    it("applies the canonical assets and favorites, then verifies an exact rerun", async () => {
      const categoryBefore = (await db.doc(
        `mediaCategories/${FIXTURE_CATEGORY}`,
      ).get()).data();

      const applied = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));

      expect(applied.media).toMatchObject({ planned: 196, created: 196, verified: 0 });
      expect(applied.favorites).toMatchObject({
        planned: 2,
        created: 2,
        verified: 0,
        retained: 1,
      });
      expect(applied.discoveryRevision).toEqual({ planned: 8, updated: 8 });
      expect(applied.completion).toMatchObject({ planned: 1, created: 1 });
      expect(applied.plannedWrites).toBe(207);
      expect((await db.collection("media_assets").get()).size).toBe(196);
      expect((await db.collectionGroup("items").get()).size).toBe(3);
      expect((await db.doc("system/mediaDiscovery").get()).data().revision).toBe(8);
      const completionMarker = (await db.doc(COMPLETION_PATH).get()).data();
      expect(completionMarker).toMatchObject({
        id: "voiceover-media-v1",
        version: 1,
        category: FIXTURE_CATEGORY,
        state: "complete",
        source: {
          libraryDocument: "voiceoverLibrary/current",
          manifestVersion: 1,
          activeTakeCount: 196,
        },
      });
      expect(completionMarker.source.datasetHash).toMatch(/^[a-f0-9]{64}$/);

      const source = fixture.takes[0];
      const mediaId = `voiceover-${source.id}`;
      const stored = (await db.doc(`media_assets/${mediaId}`).get()).data();
      expect(stored).toMatchObject({
        id: mediaId,
        name: `Voiceover: ${source.display_text}`,
        originalName: `${source.id}.wav`,
        category: FIXTURE_CATEGORY,
        categories: [FIXTURE_CATEGORY],
        tags: ["voiceover", source.style],
        description: source.text,
        altText: null,
        license: null,
        credit: "Jules Avery",
        mimeType: "audio/wav",
        kind: "audio",
        sizeBytes: source.sizeBytes,
        width: null,
        height: null,
        contentHash: source.contentHash,
        storageKey: source.objectKey,
        url: `https://admin.njpbs.org/media/voiceovers?asset=${mediaId}`,
        lifecycle: "active",
        source: "voiceover",
        voiceoverTakeId: source.id,
        voiceover: {
          manifestVersion: 1,
          id: source.id,
          family_id: source.family_id,
          family: source.family,
          take: source.take,
          style: source.style,
          performer_id: source.performer_id,
          performer_name: "Jules Avery",
          text: source.text,
          display_text: source.display_text,
          complete: source.complete,
          flags: source.flags,
          insert_note: source.insert_note,
          duration_seconds: source.duration_seconds,
        },
        version: 1,
        createdAt: source.createdAt,
        createdBy: source.recordedByUid,
        updatedAt: source.updatedAt,
        updatedBy: source.recordedByUid,
        voiceoverMigration: {
          id: "voiceover-media-v1",
          version: 1,
          category: FIXTURE_CATEGORY,
        },
      });
      expect(stored.mediaDiscovery).toMatchObject({ schema: 1, eligible: true });
      expect(stored).not.toHaveProperty("audioSha256");
      expect(stored).not.toHaveProperty("storageChecksum");
      expect(await sourceSnapshot()).toEqual(before);
      expect((await db.doc(`mediaCategories/${FIXTURE_CATEGORY}`).get()).data())
        .toEqual(categoryBefore);

      const rerun = await migrateVoiceoversToMedia(migrationOptions({
        apply: true,
        nowIso: "2026-10-05T15:00:00.000Z",
      }));
      expect(rerun.media).toMatchObject({ planned: 0, created: 0, verified: 196 });
      expect(rerun.favorites).toMatchObject({
        planned: 0,
        created: 0,
        verified: 2,
        retained: 1,
      });
      expect(rerun.discoveryRevision).toEqual({ planned: 0, updated: 0 });
      expect(rerun.completion).toMatchObject({ planned: 0, verified: 1 });
      expect(rerun.plannedWrites).toBe(0);
      expect((await db.doc(`media_assets/${mediaId}`).get()).data()).toEqual(stored);
      expect(await sourceSnapshot()).toEqual(before);
    });

  });

  it("aborts an apply when a source take changes after preflight", async () => {
    const fixture = await seedVoiceoverMediaFixture(db, { seedExistingFavorite: false });
    const changedTake = [...fixture.takes]
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(`voiceoverTakes/${changedTake.id}`).update({
        updatedAt: "2026-10-04T16:30:00.000Z",
      });
    });

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/Voiceover source changed/);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).empty).toBe(true);
    expect((await db.doc("system/mediaDiscovery").get()).exists).toBe(false);
  });

  it("aborts an apply when the active category changes after preflight", async () => {
    await seedVoiceoverMediaFixture(db, { seedExistingFavorite: false });
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(`mediaCategories/${FIXTURE_CATEGORY}`).update({ active: false });
    });

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/Media category changed/);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).empty).toBe(true);
    expect((await db.doc("system/mediaDiscovery").get()).exists).toBe(false);
  });

  it("aborts an apply when a missing target appears after preflight", async () => {
    const fixture = await seedVoiceoverMediaFixture(db, { seedExistingFavorite: false });
    const changedTake = [...fixture.takes]
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    const targetPath = `media_assets/voiceover-${changedTake.id}`;
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(targetPath).create({ id: `voiceover-${changedTake.id}`, source: "staff" });
    });

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/Media asset collision/);
    expect((await db.collection("media_assets").get()).size).toBe(1);
    expect((await db.collectionGroup("items").get()).empty).toBe(true);
    expect((await db.doc("system/mediaDiscovery").get()).exists).toBe(false);
  });

  it("does not create a favorite when its review changes after preflight", async () => {
    const fixture = await seedVoiceoverMediaFixture(db, { seedExistingFavorite: false });
    const reviewPath = `voiceoverReviews/reviewer-a/takes/${fixture.takes[0].id}`;
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(reviewPath).update({
        favorite: false,
        version: 2,
        updatedAt: "2026-10-04T16:30:00.000Z",
      });
    });

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/Voiceover review changed/);
    expect((await db.doc(favoritePath("reviewer-a", fixture.takes[0].id)).get()).exists)
      .toBe(false);
    expect((await db.collectionGroup("items").get()).empty).toBe(true);
    expect((await db.collection("media_assets").get()).size).toBe(196);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(false);

    const resumed = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    expect(resumed.media).toMatchObject({ planned: 0, verified: 196 });
    expect(resumed.favorites).toMatchObject({ planned: 2, created: 2 });
    expect(resumed.completion).toMatchObject({ planned: 1, created: 1 });
    expect(resumed.plannedWrites).toBe(3);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
  });

  it("accepts unmapped personal review edits on a completed rerun", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const reviewPath = `voiceoverReviews/reviewer-a/takes/${fixture.takes[0].id}`;
    await db.doc(reviewPath).update({
      notes: "Updated from the shared Audio inspector.",
      moreLikeThis: true,
      version: 2,
      updatedAt: "2026-10-04T19:00:00.000Z",
    });

    const rerun = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));

    expect(rerun.media).toMatchObject({ planned: 0, verified: 196 });
    expect(rerun.favorites).toMatchObject({
      planned: 0,
      verified: 2,
      retained: 1,
      conflicts: 0,
    });
    expect(rerun.completion).toMatchObject({ planned: 0, verified: 1 });
    expect(rerun.plannedWrites).toBe(0);
    expect((await db.doc(reviewPath).get()).data()).toMatchObject({
      notes: "Updated from the shared Audio inspector.",
      moreLikeThis: true,
      version: 2,
    });
  });

  it("does not let completion suppress a changed source collision", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const removedPath = favoritePath("reviewer-a", fixture.takes[0].id);
    await Promise.all([
      db.doc(removedPath).delete(),
      db.doc(`voiceoverTakes/${fixture.takes[0].id}`).update({
        updatedAt: "2026-10-04T18:00:00.000Z",
      }),
    ]);

    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/completion marker collision/);
    expect((await db.doc(removedPath).get()).exists).toBe(false);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
  });

  it("rejects a same-version replacement take dataset without target writes", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const before = await migrationTargetSnapshot();
    const original = fixture.takes[10];
    const replacementId = `replacement-${original.id}`;
    const replacement = {
      ...original,
      id: replacementId,
      objectKey: `takes/v1/${replacementId}.wav`,
    };
    const batch = db.batch();
    batch.delete(db.doc(`voiceoverTakes/${original.id}`));
    batch.create(db.doc(`voiceoverTakes/${replacementId}`), replacement);
    await batch.commit();

    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/completion marker collision/);
    expect(await migrationTargetSnapshot()).toEqual(before);
    expect((await db.doc(`media_assets/voiceover-${replacementId}`).get()).exists)
      .toBe(false);
  });

  it("rolls back only owned unchanged records and keeps every legacy source", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    const before = await sourceSnapshot();
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));

    const favoritesBefore = (await migrationTargetSnapshot()).favorites;

    const dryRun = await migrateVoiceoversToMedia(migrationOptions({ rollback: true }));
    expect(dryRun.media).toMatchObject({ planned: 196, deleted: 0, conflicts: 0 });
    expect(dryRun.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
    expect(dryRun.discoveryRevision).toEqual({ planned: 8, updated: 0 });
    expect(dryRun.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
    expect(dryRun.plannedWrites).toBe(204);

    const rolledBack = await migrateVoiceoversToMedia(migrationOptions({
      rollback: true,
      apply: true,
    }));
    expect(rolledBack.media).toMatchObject({
      planned: 196,
      deleted: 196,
      retained: 0,
      conflicts: 0,
    });
    expect(rolledBack.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
    expect(rolledBack.discoveryRevision).toEqual({ planned: 8, updated: 8 });
    expect(rolledBack.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).size).toBe(3);
    expect((await db.doc(fixture.existingFavoritePath).get()).exists).toBe(true);
    expect((await db.doc("system/mediaDiscovery").get()).data().revision).toBe(16);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
    expect(await sourceSnapshot()).toEqual(before);
    expect((await migrationTargetSnapshot()).favorites).toEqual(favoritesBefore);
  });

  it("plans one-record transaction chunks without writes", async () => {
    await seedVoiceoverMediaFixture(db);
    const legacyBefore = await sourceSnapshot();
    const { chunkSize } = parseArguments([
      "--category", FIXTURE_CATEGORY, "--chunk-size", "1",
    ]);

    const dryRun = await migrateVoiceoversToMedia(migrationOptions({ chunkSize }));

    expect(dryRun.chunkSize).toBe(1);
    expect(dryRun.media).toMatchObject({ planned: 196, created: 0 });
    expect(dryRun.favorites).toMatchObject({ planned: 2, created: 0, retained: 1 });
    expect(dryRun.discoveryRevision).toEqual({ planned: 196, updated: 0 });
    expect(dryRun.completion).toMatchObject({ planned: 1, created: 0 });
    expect(dryRun.plannedWrites).toBe(395);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).size).toBe(1);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(false);
    expect(await sourceSnapshot()).toEqual(legacyBefore);
  });

  it("applies one-record transaction chunks and verifies an unchanged rerun", async () => {
    await seedVoiceoverMediaFixture(db);
    const legacyBefore = await sourceSnapshot();
    const { chunkSize } = parseArguments([
      "--category", FIXTURE_CATEGORY, "--chunk-size", "1",
    ]);

    const applied = await migrateVoiceoversToMedia(migrationOptions({
      apply: true,
      chunkSize,
    }));

    expect(applied.chunkSize).toBe(1);
    expect(applied.media).toMatchObject({ planned: 196, created: 196 });
    expect(applied.favorites).toMatchObject({ planned: 2, created: 2, retained: 1 });
    expect(applied.discoveryRevision).toEqual({ planned: 196, updated: 196 });
    expect(applied.completion).toMatchObject({ planned: 1, created: 1 });
    expect(applied.plannedWrites).toBe(395);
    expect((await db.doc("system/mediaDiscovery").get()).data().revision).toBe(196);
    expect(await sourceSnapshot()).toEqual(legacyBefore);

    const rerun = await migrateVoiceoversToMedia(migrationOptions({
      apply: true,
      chunkSize,
    }));

    expect(rerun.chunkSize).toBe(1);
    expect(rerun.media).toMatchObject({ planned: 0, verified: 196 });
    expect(rerun.favorites).toMatchObject({ planned: 0, verified: 2, retained: 1 });
    expect(rerun.discoveryRevision).toEqual({ planned: 0, updated: 0 });
    expect(rerun.completion).toMatchObject({ planned: 0, verified: 1 });
    expect(rerun.plannedWrites).toBe(0);
    expect(await sourceSnapshot()).toEqual(legacyBefore);
  });

  describe("one-record rollback", () => {
    let fixture;
    let legacyBefore;

    beforeEach(async () => {
      fixture = await seedVoiceoverMediaFixture(db);
      legacyBefore = await sourceSnapshot();
      const setup = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
      expect(setup.chunkSize).toBe(25);
      expect(setup.plannedWrites).toBe(207);
      expect(await sourceSnapshot()).toEqual(legacyBefore);
    });

    it("rolls back with one-record transaction chunks", async () => {
      const rolledBack = await migrateVoiceoversToMedia(migrationOptions({
        apply: true,
        rollback: true,
        chunkSize: 1,
      }));

      expect(rolledBack.chunkSize).toBe(1);
      expect(rolledBack.media).toMatchObject({ planned: 196, deleted: 196 });
      expect(rolledBack.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
      expect(rolledBack.discoveryRevision).toEqual({ planned: 196, updated: 196 });
      expect(rolledBack.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
      expect(rolledBack.plannedWrites).toBe(392);
      expect((await db.doc("system/mediaDiscovery").get()).data().revision).toBe(204);
      expect((await db.collection("media_assets").get()).empty).toBe(true);
      expect((await db.collectionGroup("items").get()).size).toBe(3);
      expect((await db.doc(fixture.existingFavoritePath).get()).exists).toBe(true);
      expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
      expect(await sourceSnapshot()).toEqual(legacyBefore);
    });
  });

  it("rechecks rollback fingerprints in transactions and retains intervening staff edits", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const editedAssetPath = `media_assets/voiceover-${fixture.takes[0].id}`;
    const editedFavoritePath = favoritePath("reviewer-a", fixture.takes[0].id);
    const raced = firestoreWithTransactionRace(db, async () => {
      await Promise.all([
        db.doc(editedAssetPath).update({ name: "Staff-edited voiceover", version: 2 }),
        db.doc(editedFavoritePath).update({
          createdAt: Timestamp.fromDate(new Date("2026-10-04T16:00:00.000Z")),
        }),
      ]);
    });

    const result = await migrateVoiceoversToMedia({
      ...migrationOptions({ rollback: true, apply: true }),
      firestore: raced,
    });

    expect(result.media).toMatchObject({
      planned: 196,
      deleted: 195,
      retained: 1,
      skipped: 1,
      conflicts: 1,
    });
    expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
    expect(result.completion).toMatchObject({
      planned: 0,
      deleted: 0,
      retained: 1,
      skipped: 1,
    });
    expect((await db.doc(editedAssetPath).get()).data()).toMatchObject({
      name: "Staff-edited voiceover",
      version: 2,
    });
    expect((await db.doc(editedFavoritePath).get()).exists).toBe(true);
    expect((await db.collection("media_assets").get()).size).toBe(1);
    expect((await db.collectionGroup("items").get()).size).toBe(3);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
  });

  it("rechecks legacy sources in delete transactions after rollback preflight", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const changedTake = fixture.takes[0];
    const changedAssetPath = `media_assets/voiceover-${changedTake.id}`;
    const changedReviewPath = `voiceoverReviews/reviewer-a/takes/${changedTake.id}`;
    const changedFavoritePath = favoritePath("reviewer-a", changedTake.id);
    const raced = firestoreWithTransactionRace(db, async () => {
      await Promise.all([
        db.doc(`voiceoverTakes/${changedTake.id}`).update({
          updatedAt: "2026-10-04T16:30:00.000Z",
        }),
        db.doc(changedReviewPath).update({
          notes: "Changed after rollback preflight.",
          version: 2,
          updatedAt: "2026-10-04T16:30:00.000Z",
        }),
      ]);
    });

    const result = await migrateVoiceoversToMedia({
      ...migrationOptions({ rollback: true, apply: true }),
      firestore: raced,
    });

    expect(result.media).toMatchObject({
      planned: 196,
      deleted: 195,
      retained: 1,
      skipped: 1,
      conflicts: 1,
    });
    expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
    expect(result.completion).toMatchObject({
      planned: 0,
      deleted: 0,
      retained: 1,
      skipped: 1,
    });
    expect((await db.doc(changedAssetPath).get()).exists).toBe(true);
    expect((await db.doc(changedFavoritePath).get()).exists).toBe(true);
    expect((await db.doc(changedReviewPath).get()).data()).toMatchObject({
      notes: "Changed after rollback preflight.",
      version: 2,
    });
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
  });

  describe("rollback after completed migration", () => {
    let fixture;

    beforeEach(async () => {
      fixture = await seedVoiceoverMediaFixture(db);
      await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    });

    it("preserves a shared un-favorite after the migration completes", async () => {
      const removedPath = favoritePath("reviewer-a", fixture.takes[0].id);
      await db.doc(removedPath).delete();

      const rerun = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));

      expect(rerun.media).toMatchObject({ planned: 0, verified: 196 });
      expect(rerun.favorites).toMatchObject({
        planned: 0,
        created: 0,
        verified: 1,
        retained: 2,
        skipped: 1,
      });
      expect(rerun.completion).toMatchObject({ planned: 0, verified: 1 });
      expect(rerun.plannedWrites).toBe(0);
      expect((await db.doc(removedPath).get()).exists).toBe(false);
      expect((await db.doc(
        `voiceoverReviews/reviewer-a/takes/${fixture.takes[0].id}`,
      ).get()).data().favorite).toBe(true);
    });

    describe("reapply after clean rollback", () => {
      let favoritesBefore;
      beforeEach(async () => {
        favoritesBefore = (await migrationTargetSnapshot()).favorites;
        const rolledBack = await migrateVoiceoversToMedia(migrationOptions({ rollback: true, apply: true }));
        expect(rolledBack.plannedWrites).toBe(204);
        expect(rolledBack.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
      });

      it("preserves a canonical un-favorite made after clean rollback", async () => {
        const path = favoritePath("reviewer-a", fixture.takes[0].id);
        await db.doc(path).delete();
        const before = await sourceSnapshot();
        const reapplied = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
        expect(reapplied.plannedWrites).toBe(204);
        expect(reapplied.favorites).toMatchObject({ planned: 0, skipped: 1 });
        expect((await db.doc(path).get()).exists).toBe(false);
        expect(await sourceSnapshot()).toEqual(before);
      });

      it("keeps shared favorites authoritative after historical review changes", async () => {
        await db.doc(`voiceoverReviews/reviewer-a/takes/${fixture.takes[0].id}`).update({ favorite: false });
        await db.doc(`voiceoverReviews/reviewer-b/takes/${fixture.takes[1].id}`).update({ createdAt: "2026-10-04T18:00:00.000Z" });
        const before = await sourceSnapshot();
        const reapplied = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
        expect(reapplied.plannedWrites).toBe(204);
        expect(reapplied.favorites.planned).toBe(0);
        expect((await migrationTargetSnapshot()).favorites).toEqual(favoritesBefore);
        expect(await sourceSnapshot()).toEqual(before);
      });
    });

    describe("resume interrupted rollback", () => {
      let favoritesBefore;
      beforeEach(async () => {
        favoritesBefore = (await migrationTargetSnapshot()).favorites;
        const interrupted = firestoreWithTransactionRace(db, async () => {
          throw new Error("Simulated rollback interruption");
        }, 2);
        await expect(migrateVoiceoversToMedia({
          ...migrationOptions({ rollback: true, apply: true }),
          firestore: interrupted,
        })).rejects.toThrow("Simulated rollback interruption");
        expect((await db.collection("media_assets").get()).size).toBe(171);
      });
      it("finishes a partial rollback without deleting shared favorites", async () => {
        const result = await migrateVoiceoversToMedia(migrationOptions({ rollback: true, apply: true }));
        expect(result.media).toMatchObject({ planned: 171, deleted: 171, conflicts: 0 });
        expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
        expect(result.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
        expect(result.plannedWrites).toBe(178);
        expect((await db.collection("media_assets").get()).empty).toBe(true);
        expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
        expect((await migrationTargetSnapshot()).favorites).toEqual(favoritesBefore);
        const rerun = await migrateVoiceoversToMedia(migrationOptions({ rollback: true, apply: true }));
        expect(rerun.plannedWrites).toBe(0);
        expect((await migrationTargetSnapshot()).favorites).toEqual(favoritesBefore);
      });
    });

    describe("resume resolved rollback conflict", () => {
      let favoritesBefore;
      beforeEach(async () => {
        favoritesBefore = (await migrationTargetSnapshot()).favorites;
        const target = db.doc(`media_assets/voiceover-${fixture.takes[0].id}`);
        const original = (await target.get()).data();
        await target.update({ name: "Staff edit", version: 2 });
        const first = await migrateVoiceoversToMedia(migrationOptions({ rollback: true, apply: true }));
        expect(first.media).toMatchObject({ deleted: 195, conflicts: 1 });
        expect(first.completion).toMatchObject({ deleted: 0, retained: 1 });
        await target.set(original);
      });
      it("finishes rollback after the original asset conflict is resolved", async () => {
        const result = await migrateVoiceoversToMedia(migrationOptions({ rollback: true, apply: true }));
        expect(result.media).toMatchObject({ planned: 1, deleted: 1, conflicts: 0 });
        expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
        expect(result.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
        expect(result.plannedWrites).toBe(2);
        expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
        expect((await migrationTargetSnapshot()).favorites).toEqual(favoritesBefore);
      });
    });

    it("re-reads mapped performer data in rollback delete transactions", async () => {
      const raced = firestoreWithTransactionRace(db, async () => {
        await db.doc("voiceoverLibrary/current").update({
          "performers.jules-avery.name": "Updated performer",
        });
      });
      const result = await migrateVoiceoversToMedia({
        ...migrationOptions({ rollback: true, apply: true }),
        firestore: raced,
      });
      expect(result.media).toMatchObject({ planned: 196, deleted: 0, retained: 196, conflicts: 196 });
      expect((await db.collection("media_assets").get()).size).toBe(196);
      expect((await db.doc(`media_assets/voiceover-${fixture.takes[0].id}`).get()).data().credit)
        .toBe("Jules Avery");
      expect((await db.doc("voiceoverLibrary/current").get()).data().performers["jules-avery"].name)
        .toBe("Updated performer");
      expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
    });

    describe("staff removed a shared favorite", () => {
      let removedFavoritePath;
      let before;

      beforeEach(async () => {
        removedFavoritePath = favoritePath("reviewer-a", fixture.takes[0].id);
        await db.doc(removedFavoritePath).delete();
        before = await sourceSnapshot();
      });

      it("dry-runs rollback with a missing favorite as a conflict", async () => {
        const result = await migrateVoiceoversToMedia(migrationOptions({ rollback: true }));
        expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 1 });
        expect(result.completion).toMatchObject({ planned: 0, retained: 1 });
        expect(result.plannedWrites).toBe(204);
        expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
      });

      it("retains the marker after rollback of a removed shared favorite", async () => {
        const result = await migrateVoiceoversToMedia(migrationOptions({ rollback: true, apply: true }));
        expect(result.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
        expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
        expect((await db.doc(fixture.existingFavoritePath).get()).exists).toBe(true);
        expect(await sourceSnapshot()).toEqual(before);
      });

      describe("rerun after rollback", () => {
        beforeEach(async () => {
          await migrateVoiceoversToMedia(migrationOptions({ rollback: true, apply: true }));
        });

        it("does not resurrect the staff member's removed favorite", async () => {
          await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
          expect((await db.doc(removedFavoritePath).get()).exists).toBe(false);
          expect((await db.doc(`voiceoverReviews/reviewer-a/takes/${fixture.takes[0].id}`).get()).data().favorite)
            .toBe(true);
          expect(await sourceSnapshot()).toEqual(before);
        });
      });
    });

    it("retains the rollback marker if a preexisting favorite is removed after preflight", async () => {
      const before = await sourceSnapshot();
      const raced = firestoreWithTransactionRace(db, async () => {
        await db.doc(fixture.existingFavoritePath).delete();
      });
      const result = await migrateVoiceoversToMedia({
        ...migrationOptions({ rollback: true, apply: true }),
        firestore: raced,
      });
      expect(result.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1, conflicts: 1 });
      expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
      expect((await db.doc(fixture.existingFavoritePath).get()).exists).toBe(false);
      expect(await sourceSnapshot()).toEqual(before);
    });
  });

  it("preserves shared favorites after an unmapped personal review edit", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const reviewPath = `voiceoverReviews/reviewer-a/takes/${fixture.takes[0].id}`;
    await db.doc(reviewPath).update({
      notes: "Keep the revised personal note.",
      moreLikeThis: true,
      version: 2,
      updatedAt: "2026-10-04T19:00:00.000Z",
    });
    const legacyAfterEdit = await sourceSnapshot();

    const result = await migrateVoiceoversToMedia(migrationOptions({
      rollback: true,
      apply: true,
    }));

    expect(result.media).toMatchObject({
      planned: 196,
      deleted: 196,
      conflicts: 0,
    });
    expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
    expect(result.completion).toMatchObject({ planned: 0, deleted: 0, retained: 1 });
    expect(result.plannedWrites).toBe(204);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).size).toBe(3);
    expect((await db.doc(fixture.existingFavoritePath).get()).exists).toBe(true);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
    expect(await sourceSnapshot()).toEqual(legacyAfterEdit);
  });

  it("retains a completion marker that changes during rollback", async () => {
    await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(COMPLETION_PATH).update({ state: "staff-edited" });
    });

    const result = await migrateVoiceoversToMedia({
      ...migrationOptions({ rollback: true, apply: true }),
      firestore: raced,
    });

    expect(result.media).toMatchObject({ planned: 196, deleted: 196 });
    expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
    expect(result.completion).toMatchObject({
      planned: 0,
      deleted: 0,
      retained: 1,
      conflicts: 1,
    });
    expect((await db.doc(COMPLETION_PATH).get()).data().state).toBe("staff-edited");
  });

  it("retains owned records when their mapped source fields change", async () => {
    const fixture = await seedVoiceoverMediaFixture(db);
    await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    const changedTake = fixture.takes[0];
    const changedAssetPath = `media_assets/voiceover-${changedTake.id}`;
    const changedReviewPath = `voiceoverReviews/reviewer-a/takes/${changedTake.id}`;
    const changedFavoritePath = favoritePath("reviewer-a", changedTake.id);
    await Promise.all([
      db.doc(`voiceoverTakes/${changedTake.id}`).update({
        updatedAt: "2026-10-04T17:00:00.000Z",
      }),
      db.doc(changedReviewPath).update({
        favorite: false,
        version: 2,
        updatedAt: "2026-10-04T17:00:00.000Z",
      }),
    ]);

    const result = await migrateVoiceoversToMedia(migrationOptions({
      rollback: true,
      apply: true,
    }));

    expect(result.media).toMatchObject({
      planned: 195,
      deleted: 195,
      retained: 1,
      skipped: 1,
      conflicts: 1,
    });
    expect(result.favorites).toMatchObject({ planned: 0, deleted: 0, retained: 3, conflicts: 0 });
    expect(result.completion).toMatchObject({
      planned: 0,
      deleted: 0,
      retained: 1,
      skipped: 1,
    });
    expect((await db.doc(changedAssetPath).get()).exists).toBe(true);
    expect((await db.doc(changedFavoritePath).get()).exists).toBe(true);
    expect((await db.doc(changedReviewPath).get()).data()).toMatchObject({
      favorite: false,
      version: 2,
    });
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
  });

  it("fails the full preflight before writes on asset or favorite collisions", async () => {
    const fixture = await seedVoiceoverMediaFixture(db, { seedExistingFavorite: false });
    const firstId = `voiceover-${fixture.takes[0].id}`;
    await db.doc(`media_assets/${firstId}`).set({ id: firstId, source: "other" });
    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/Media asset collision/);
    expect((await db.collection("media_assets").get()).size).toBe(1);
    expect((await db.collectionGroup("items").get()).empty).toBe(true);

    await clearFirestore();
    const favoriteFixture = await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
    });
    await db.doc(favoritePath("reviewer-a", favoriteFixture.takes[0].id)).set({
      ref: { backend: "r2", id: "different-id" },
      canonicalRef: "r2:different-id",
      createdAt: Timestamp.fromDate(new Date(FIXTURE_NOW)),
    });
    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/Media favorite collision/);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).size).toBe(1);
  });

  it.each([
    {
      label: "category",
      marker: {
        id: "voiceover-media-v1",
        version: 1,
        category: "general",
        state: "complete",
        source: {
          libraryDocument: "voiceoverLibrary/current",
          manifestVersion: 1,
          activeTakeCount: 196,
        },
      },
    },
    {
      label: "source schema",
      marker: {
        id: "voiceover-media-v1",
        version: 1,
        category: FIXTURE_CATEGORY,
        state: "complete",
        source: {
          libraryDocument: "voiceoverLibrary/current",
          manifestVersion: 1,
          activeTakeCount: 195,
        },
      },
    },
  ])("rejects a completion marker with a conflicting $label", async ({ marker }) => {
    await seedVoiceoverMediaFixture(db, { seedExistingFavorite: false });
    await db.doc(COMPLETION_PATH).set(marker);

    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/completion marker collision/);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).empty).toBe(true);
  });

  it("rechecks a newly appearing completion marker after target writes", async () => {
    await seedVoiceoverMediaFixture(db, { seedExistingFavorite: false });
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(COMPLETION_PATH).create({ state: "forged" });
    });

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/completion marker changed/);
    expect((await db.collection("media_assets").get()).size).toBe(196);
    expect((await db.collectionGroup("items").get()).size).toBe(3);
    expect((await db.doc(COMPLETION_PATH).get()).data()).toEqual({ state: "forged" });
  });

  it("rechecks the source dataset before writing completion", async () => {
    const fixture = await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
    });
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(`voiceoverTakes/${fixture.takes[10].id}`).update({
        updatedAt: "2026-10-04T18:30:00.000Z",
      });
    }, 10);

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/source dataset changed after migration preflight/);
    expect((await db.collection("media_assets").get()).size).toBe(196);
    expect((await db.collectionGroup("items").get()).size).toBe(3);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(false);
  });

  it("resumes after an unmapped favorite-review edit stops completion", async () => {
    const fixture = await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
    });
    const reviewPath = `voiceoverReviews/reviewer-a/takes/${fixture.takes[0].id}`;
    const raced = firestoreWithTransactionRace(db, async () => {
      await db.doc(reviewPath).update({
        notes: "Changed after the favorite chunk committed.",
        moreLikeThis: true,
        version: 2,
        updatedAt: "2026-10-04T19:00:00.000Z",
      });
    }, 10);

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/review dataset changed after migration preflight/);
    expect((await db.collection("media_assets").get()).size).toBe(196);
    expect((await db.collectionGroup("items").get()).size).toBe(3);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(false);

    const resumed = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    expect(resumed.media).toMatchObject({ planned: 0, verified: 196 });
    expect(resumed.favorites).toMatchObject({ planned: 0, verified: 3 });
    expect(resumed.completion).toMatchObject({ planned: 1, created: 1 });
    expect(resumed.plannedWrites).toBe(1);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(true);
  });

  it.each([
    {
      label: "a false review becomes a favorite",
      mutate: async (fixture) => {
        await db.doc(`voiceoverReviews/reviewer-a/takes/${fixture.takes[3].id}`).update({
          favorite: true,
          version: 2,
          updatedAt: "2026-10-04T18:30:00.000Z",
        });
      },
    },
    {
      label: "a new favorite review appears",
      mutate: async (fixture) => {
        const takeId = fixture.takes[4].id;
        await db.doc(`voiceoverReviews/reviewer-new/takes/${takeId}`).create({
          schemaVersion: 1,
          manifestVersion: 1,
          takeId,
          favorite: true,
          moreLikeThis: false,
          notes: "",
          version: 1,
          createdAt: "2026-10-04T18:30:00.000Z",
          updatedAt: "2026-10-04T18:30:00.000Z",
        });
      },
    },
  ])("rechecks reviews before completion when $label", async ({ mutate }) => {
    const fixture = await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
    });
    const raced = firestoreWithTransactionRace(db, async () => mutate(fixture), 10);

    await expect(migrateVoiceoversToMedia({
      ...migrationOptions({ apply: true }),
      firestore: raced,
    })).rejects.toThrow(/review dataset changed after migration preflight/);
    expect((await db.collection("media_assets").get()).size).toBe(196);
    expect((await db.collectionGroup("items").get()).size).toBe(3);
    expect((await db.doc(COMPLETION_PATH).get()).exists).toBe(false);
  });

  it("requires an active category and explicit production access", async () => {
    await seedVoiceoverMediaFixture(db, { categoryActive: false });
    await expect(migrateVoiceoversToMedia(migrationOptions()))
      .rejects.toThrow(/not active/);
    await clearFirestore();
    await expect(migrateVoiceoversToMedia(migrationOptions()))
      .rejects.toThrow(/does not exist/);

    expect(() => assertMigrationEnvironment({
      firestore: db,
      env: {},
      projectId: PROJECT,
    })).toThrow(/local Firestore emulator/);
    expect(() => assertMigrationEnvironment({
      firestore: db,
      env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      projectId: "other-project",
    })).toThrow(/demo-njpbs.*njpbs-site/);
    expect(() => assertMigrationEnvironment({
      firestore: db,
      env: {},
      projectId: "njpbs-site",
    })).toThrow(/allow-production/);
    expect(assertMigrationEnvironment({
      firestore: db,
      env: {},
      projectId: "njpbs-site",
      allowProduction: true,
    })).toBe("njpbs-site");
    expect(parseArguments(["--category", FIXTURE_CATEGORY])).toMatchObject({
      apply: false,
      allowProduction: false,
      chunkSize: 25,
      rollback: false,
      project: PROJECT,
    });
    expect(parseArguments([
      "--category", FIXTURE_CATEGORY, "--chunk-size", "1",
    ])).toMatchObject({ chunkSize: 1 });
    for (const value of ["0", "26", "1.5", "01", "text"]) {
      expect(() => parseArguments([
        "--category", FIXTURE_CATEGORY, "--chunk-size", value,
      ])).toThrow(/--chunk-size/);
    }
    await expect(migrateVoiceoversToMedia(migrationOptions({ chunkSize: 0 })))
      .rejects.toThrow(/chunk size/);
    expect(parseArguments(["--category", FIXTURE_CATEGORY, "--rollback", "--apply"]))
      .toMatchObject({ apply: true, rollback: true });
    expect(() => parseArguments([])).toThrow(/--category is required/);
    expect(() => parseArguments([
      "--category", FIXTURE_CATEGORY, "--project", "njpbs-site",
    ])).toThrow(/allow-production/);
    expect(parseArguments([
      "--category", FIXTURE_CATEGORY,
      "--project", "njpbs-site",
      "--allow-production",
    ])).toMatchObject({
      apply: false,
      allowProduction: true,
      project: "njpbs-site",
    });
    expect(parseArguments([
      "--category", FIXTURE_CATEGORY,
      "--project", "njpbs-site",
      "--allow-production",
      "--apply",
    ])).toMatchObject({
      apply: true,
      allowProduction: true,
      project: "njpbs-site",
    });
  });

  it.each([
    {
      label: "an invalid source id",
      id: "Invalid-voiceover-id",
      message: /voiceover library is unavailable/i,
    },
    {
      label: "a source id that makes a 129-byte media id",
      id: "a".repeat(119),
      message: /cannot form a valid media asset id/i,
    },
  ])("fails closed for $label", async ({ id, message }) => {
    await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
      seedReviews: false,
      mutateTake: (take, index) => index === 0 ? {
        ...take,
        id,
        objectKey: `takes/v1/${id}.wav`,
      } : take,
    });

    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(message);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
  });

  it("requires exactly 196 active takes", async () => {
    await seedVoiceoverMediaFixture(db, {
      takeCount: 195,
      seedExistingFavorite: false,
      seedReviews: false,
    });
    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/exactly 196 takes/);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
  });

  it.each([
    {
      label: "a noncanonical storage key",
      change: { objectKey: "other/private.wav" },
      message: /storage object/,
    },
    {
      label: "audio larger than the voiceover limit",
      change: { sizeBytes: 10 * 1024 * 1024 + 1 },
      message: /invalid size/,
    },
  ])("rejects $label before any target write", async ({ change, message }) => {
    await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
      seedReviews: false,
      mutateTake: (take, index) => index === 0 ? { ...take, ...change } : take,
    });
    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(message);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
  });

  it.each([
    { label: "a missing source createdAt", field: "createdAt", value: undefined },
    { label: "an invalid source updatedAt", field: "updatedAt", value: "not-a-date" },
  ])("rejects $label without timestamp fallback writes", async ({ field, value }) => {
    await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
      seedReviews: false,
      mutateTake: (take, index) => {
        if (index !== 0) return take;
        const changed = { ...take, [field]: value };
        if (value === undefined) delete changed[field];
        return changed;
      },
    });

    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/invalid source timestamps/);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.doc("system/mediaDiscovery").get()).exists).toBe(false);
  });

  it("rejects a review with a missing source timestamp before target writes", async () => {
    await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
      mutateReview: (review, index) => {
        if (index !== 0) return review;
        const changed = { ...review };
        delete changed.createdAt;
        return changed;
      },
    });

    await expect(migrateVoiceoversToMedia(migrationOptions({ apply: true })))
      .rejects.toThrow(/invalid source timestamps/);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collectionGroup("items").get()).empty).toBe(true);
  });

  it("counts omitted derived tags and preserves every raw voiceover flag", async () => {
    const flags = [
      "x".repeat(41),
      ...Array.from({ length: 19 }, (_, index) => `flag-${index + 1}`),
    ];
    const fixture = await seedVoiceoverMediaFixture(db, {
      seedExistingFavorite: false,
      seedReviews: false,
      mutateTake: (take, index) => index === 0 ? { ...take, flags } : take,
    });

    const result = await migrateVoiceoversToMedia(migrationOptions({ apply: true }));
    expect(result.source.derivedTagOmissions).toBe(2);
    const stored = (await db.doc(
      `media_assets/voiceover-${fixture.takes[0].id}`,
    ).get()).data();
    expect(stored.tags).toHaveLength(20);
    expect(stored.tags).toEqual([
      "voiceover",
      fixture.takes[0].style,
      ...flags.slice(1, 19),
    ]);
    expect(stored.voiceover.flags).toEqual(flags);
  });
});
