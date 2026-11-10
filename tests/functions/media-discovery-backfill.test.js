import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import mediaDiscovery from "../../functions/lib/media-discovery.js";
import mediaDiscoveryQuery from "../../functions/lib/media-discovery-query.js";
import { backfillMediaDiscovery } from "../../scripts/backfill-media-discovery.mjs";

const admin = adminPkg;
const { bumpMediaDiscoveryRevision, deriveMediaDiscovery, discoveryTerm, withMediaDiscovery } =
  mediaDiscovery;
const { discoveryQueries, probeDiscoveryIndexes } = mediaDiscoveryQuery;
const PROJECT = "demo-njpbs";
const SOURCE_SHA = "a".repeat(40);
const OWNER = "media-discovery-test";

let db;

function record(id, overrides = {}) {
  return {
    id,
    name: `Asset ${id}`,
    originalName: `${id}.jpg`,
    category: "general",
    categories: ["general"],
    tags: ["fixture"],
    description: "Synthetic media discovery fixture.",
    altText: "Synthetic image",
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 1024,
    width: 640,
    height: 360,
    contentHash: id.padEnd(64, "0").slice(0, 64),
    storageKey: `cms-media/general/${id}/fixture.jpg`,
    url: `https://media.njpbs.org/cms-media/general/${id}/fixture.jpg`,
    lifecycle: "active",
    source: "upload",
    version: 1,
    createdAt: "2026-10-03T12:00:00.000Z",
    createdBy: "fixture",
    updatedAt: "2026-10-03T12:00:00.000Z",
    updatedBy: "fixture",
    ...overrides,
  };
}

function withoutDiscovery(value) {
  const { mediaDiscovery: _mediaDiscovery, ...canonical } = value;
  return canonical;
}

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function probeIndexes({ firestore }) {
  const shapes = await probeDiscoveryIndexes(firestore);
  return { ok: true, shapes };
}

function firestoreWithWriteFailure(firestore, { error, shouldFail, onFailure }) {
  let failures = 0;
  return {
    firestore: {
      collection: (...args) => firestore.collection(...args),
      doc: (...args) => firestore.doc(...args),
      runTransaction: async (callback) => {
        let mediaWrites = 0;
        let injected = false;
        try {
          return await firestore.runTransaction(async (transaction) => {
            const boundaryTransaction = new Proxy(transaction, {
              get(target, property) {
                if (property === "update") {
                  return (reference, value) => {
                    if (
                      reference.parent.id === "media_assets" &&
                      Object.hasOwn(value, "mediaDiscovery")
                    ) {
                      mediaWrites += 1;
                    }
                    return target.update(reference, value);
                  };
                }
                const member = Reflect.get(target, property, target);
                return typeof member === "function" ? member.bind(target) : member;
              },
            });
            const result = await callback(boundaryTransaction);
            if (mediaWrites > 0 && shouldFail(mediaWrites)) {
              failures += 1;
              injected = true;
              throw error;
            }
            return result;
          });
        } catch (caught) {
          if (injected && onFailure) await onFailure();
          throw caught;
        }
      },
    },
    failureCount: () => failures,
  };
}

function firestoreError(code, message) {
  return Object.assign(new Error(message), { code });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("media-discovery-backfill.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("media discovery backfill", () => {
  it.each(["name", "createdAt", "updatedAt", "sizeBytes"].flatMap((sort) => [
    ["Audio", sort, ["audio"]],
    ["Images", sort, ["image", "document"]],
  ]))("executes every %s %s index shape against Firestore", async (_label, sort, kinds) => {
    const queries = [];
    for (const owners of [null, ["general", "news", "programs", "education", "events", "staff-profile"]]) {
      for (const direction of ["asc", "desc"]) {
        for (const term of [null, discoveryTerm("xyz")]) {
          queries.push(...discoveryQueries(db, {
            owners, kinds, sort, direction, term, limit: 1, fields: ["name"],
          }).map((query) => query.get()));
        }
      }
    }
    expect(await Promise.all(queries)).toHaveLength(kinds.length === 2 ? 12 : 8);
  });
  it("retries a rolled-back oversized write with a retained smaller page", async () => {
    const records = Array.from({ length: 5 }, (_, index) => {
      const id = `asset-${String(index).padStart(4, "0")}`;
      return record(id);
    });
    const seed = db.batch();
    for (const asset of records) {
      seed.create(db.collection("media_assets").doc(asset.id), asset);
    }
    await seed.commit();

    const rollbackReceipts = [];
    const boundary = firestoreWithWriteFailure(db, {
      error: firestoreError(
        3,
        "3 INVALID_ARGUMENT: Transaction too big. Decrease transaction size.",
      ),
      shouldFail: (mediaWrites) => mediaWrites > 2,
      onFailure: async () => {
        const checkpoint = (await db.doc("system/mediaDiscovery").get()).data();
        const assets = await db.collection("media_assets").get();
        rollbackReceipts.push({
          afterId: checkpoint.afterId,
          revision: checkpoint.revision,
          indexed: assets.docs.filter((document) => document.data().mediaDiscovery)
            .length,
        });
      },
    });

    const result = await backfillMediaDiscovery({
      firestore: boundary.firestore,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      pageSize: 4,
      probeIndexes: async () => ({ ok: true, shapes: 32 }),
    });

    expect(boundary.failureCount()).toBe(1);
    expect(rollbackReceipts).toEqual([{ afterId: null, revision: 0, indexed: 0 }]);
    expect(result).toMatchObject({
      state: "ready",
      writeScanned: 5,
      updated: 5,
      verifyScanned: 5,
      revision: 3,
      probe: { ok: true, shapes: 32 },
    });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      state: "ready",
      revision: 3,
      verifiedRevision: 3,
    });
    const indexed = await db.collection("media_assets").get();
    for (const document of indexed.docs) {
      expect(document.data().mediaDiscovery).toEqual(
        deriveMediaDiscovery(document.id, document.data()),
      );
    }
  });

  it.each([
    {
      label: "an unrelated transaction error",
      pageSize: 4,
      error: firestoreError(9, "9 FAILED_PRECONDITION: Injected write failure"),
    },
    {
      label: "an oversized single-record transaction",
      pageSize: 1,
      error: firestoreError(
        3,
        "3 INVALID_ARGUMENT: Transaction too big. Decrease transaction size.",
      ),
    },
  ])("fails closed for $label", async ({ pageSize, error }) => {
    const asset = record("asset-0000");
    await db.collection("media_assets").doc(asset.id).set(asset);
    const boundary = firestoreWithWriteFailure(db, {
      error,
      shouldFail: () => true,
    });

    await expect(backfillMediaDiscovery({
      firestore: boundary.firestore,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      pageSize,
      probeIndexes: async () => ({ ok: true, shapes: 32 }),
    })).rejects.toBe(error);

    expect(boundary.failureCount()).toBe(1);
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      state: "building",
      phase: "write",
      afterId: null,
      revision: 0,
    });
    expect((await db.collection("media_assets").doc(asset.id).get()).data())
      .not.toHaveProperty("mediaDiscovery");
  });

  it("resumes a 100-ID write boundary without changing canonical fields", async () => {
    const records = Array.from({ length: 101 }, (_, index) => {
      const id = `asset-${String(index).padStart(4, "0")}`;
      return record(id);
    });
    const seed = db.batch();
    for (const asset of records) {
      seed.create(db.collection("media_assets").doc(asset.id), asset);
    }
    await seed.commit();

    const first = await backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      probeIndexes: async () => {
        throw new Error("The index probe ran before verification");
      },
      maxPages: 1,
    });
    expect(first).toMatchObject({
      state: "building",
      writeScanned: 100,
      updated: 100,
      pages: 1,
    });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      state: "building",
      phase: "write",
      afterId: "asset-0099",
      revision: 1,
    });

    const changedId = "asset-0005";
    const changedRef = db.collection("media_assets").doc(changedId);
    const changedAt = "2026-10-03T12:05:00.000Z";
    await db.runTransaction(async (transaction) => {
      const stored = (await transaction.get(changedRef)).data();
      transaction.set(changedRef, withMediaDiscovery(changedId, {
        ...stored,
        name: "Concurrent edit",
        version: stored.version + 1,
        updatedAt: changedAt,
        updatedBy: "concurrent-writer",
      }));
      bumpMediaDiscoveryRevision(transaction, db);
    });

    await expect(backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      probeIndexes: async () => {
        throw new Error("The index probe ran before verification");
      },
      maxPages: 1,
    })).resolves.toMatchObject({ state: "building", updated: 1 });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      phase: "verify",
      verifyRevision: 3,
    });

    const finalDocuments = await db.collection("media_assets").get();
    expect(finalDocuments.size).toBe(101);
    for (const document of finalDocuments.docs) {
      const stored = document.data();
      expect(stored.mediaDiscovery).toEqual(deriveMediaDiscovery(document.id, stored));
      const original = records.find((asset) => asset.id === document.id);
      if (document.id === changedId) {
        expect(withoutDiscovery(stored)).toEqual({
          ...original,
          name: "Concurrent edit",
          version: 2,
          updatedAt: changedAt,
          updatedBy: "concurrent-writer",
        });
      } else {
        expect(withoutDiscovery(stored)).toEqual(original);
      }
    }
  });

  it("restarts verification after a concurrent writer and checks every index shape", async () => {
    const first = withMediaDiscovery("asset-0000", record("asset-0000"));
    const second = withMediaDiscovery("asset-0001", record("asset-0001"));
    const seed = db.batch();
    seed.create(db.collection("media_assets").doc(first.id), first);
    seed.create(db.collection("media_assets").doc(second.id), second);
    seed.set(db.doc("system/mediaDiscovery"), {
      schema: 1,
      state: "building",
      phase: "verify",
      afterId: first.id,
      sourceSha: SOURCE_SHA,
      revision: 0,
      verifyRevision: 0,
      verificationComplete: false,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await seed.commit();

    const changedRef = db.collection("media_assets").doc(first.id);
    await db.runTransaction(async (transaction) => {
      const stored = (await transaction.get(changedRef)).data();
      transaction.set(changedRef, withMediaDiscovery(first.id, {
        ...stored,
        name: "Concurrent verification edit",
        version: 2,
        updatedAt: "2026-10-03T12:10:00.000Z",
        updatedBy: "concurrent-writer",
      }));
      bumpMediaDiscoveryRevision(transaction, db);
    });

    const final = await backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      probeIndexes,
      maxPages: 5,
    });
    expect(final).toMatchObject({
      state: "ready",
      revision: 1,
      verificationRestarts: 1,
      probe: { ok: true, shapes: 96 },
    });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      schema: 1,
      state: "ready",
      phase: "verify",
      revision: 1,
      verifiedRevision: 1,
      sourceSha: SOURCE_SHA,
      leaseOwner: null,
    });
  });

  it("reprobes ready state across a concurrent edit and preserves it on probe failure", async () => {
    const first = withMediaDiscovery("asset-0000", record("asset-0000", {
      name: "Concurrent verification edit",
      version: 2,
      updatedAt: "2026-10-03T12:10:00.000Z",
      updatedBy: "concurrent-writer",
    }));
    const second = withMediaDiscovery("asset-0001", record("asset-0001"));
    const seed = db.batch();
    seed.create(db.collection("media_assets").doc(first.id), first);
    seed.create(db.collection("media_assets").doc(second.id), second);
    seed.set(db.doc("system/mediaDiscovery"), {
      schema: 1,
      state: "ready",
      phase: "verify",
      sourceSha: SOURCE_SHA,
      afterId: null,
      revision: 1,
      verifiedRevision: 1,
      readyAt: "2026-10-03T12:15:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await seed.commit();

    await expect(backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      probeIndexes: async () => ({ ok: true, mode: "ready-reprobe" }),
    })).resolves.toMatchObject({
      state: "ready",
      pages: 0,
      revision: 1,
      probe: { ok: true, mode: "ready-reprobe" },
    });

    const nextSourceSha = "b".repeat(40);
    const changedSource = await backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: nextSourceSha,
      owner: OWNER,
      probeIndexes: async ({ firestore }) => {
        const probe = await probeIndexes({ firestore });
        const editedRef = firestore.collection("media_assets").doc(second.id);
        await firestore.runTransaction(async (transaction) => {
          const stored = (await transaction.get(editedRef)).data();
          transaction.set(editedRef, withMediaDiscovery(second.id, {
            ...stored,
            description: "Edited while the release probed index shapes.",
            version: stored.version + 1,
            updatedAt: "2026-10-03T12:20:00.000Z",
            updatedBy: "concurrent-writer",
          }));
          bumpMediaDiscoveryRevision(transaction, firestore);
        });
        return probe;
      },
      maxPages: 1,
    });
    expect(changedSource).toMatchObject({
      state: "ready",
      pages: 0,
      revision: 2,
      probe: { ok: true, shapes: 96 },
    });
    const reprobed = (await db.doc("system/mediaDiscovery").get()).data();
    expect(reprobed).toMatchObject({
      state: "ready",
      phase: "verify",
      sourceSha: nextSourceSha,
      afterId: null,
      revision: 2,
      verifiedRevision: 1,
      lastProbe: {
        sourceSha: nextSourceSha,
        revision: 2,
        shapes: 96,
      },
    });
    expect((await db.collection("media_assets").doc(second.id).get()).data())
      .toMatchObject({
        description: "Edited while the release probed index shapes.",
        version: 2,
        updatedBy: "concurrent-writer",
      });

    await expect(backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: nextSourceSha,
      owner: OWNER,
      probeIndexes: async () => {
        throw new Error("Injected index probe failure");
      },
    })).rejects.toThrow("Injected index probe failure");
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      state: "ready",
      sourceSha: nextSourceSha,
      revision: 2,
      verifiedRevision: 1,
      readyAt: reprobed.readyAt,
      lastProbe: reprobed.lastProbe,
      error: {
        code: "index_probe_failed",
        message: "Injected index probe failure",
      },
    });
  });

  it("runs past 100 pages by default and reaches ready", async () => {
    const seed = db.batch();
    for (let index = 0; index < 51; index += 1) {
      const id = `inactive-${String(index).padStart(4, "0")}`;
      seed.create(db.collection("media_assets").doc(id), {
        lifecycle: "tombstoned",
      });
    }
    await seed.commit();

    const result = await backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      pageSize: 1,
      probeIndexes: async () => ({ ok: true, shapes: 32 }),
    });

    expect(result).toMatchObject({
      state: "ready",
      writeScanned: 51,
      updated: 51,
      verifyScanned: 51,
      revision: 51,
      probe: { ok: true, shapes: 32 },
    });
    expect(result.pages).toBeGreaterThan(100);
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      state: "ready",
      revision: 51,
      verifiedRevision: 51,
      lastProbe: {
        sourceSha: SOURCE_SHA,
        revision: 51,
        shapes: 32,
      },
    });
    const indexed = await db.collection("media_assets").get();
    expect(indexed.docs).toHaveLength(51);
    for (const document of indexed.docs) {
      expect(document.data().mediaDiscovery).toEqual({
        schema: 1,
        eligible: false,
        terms: [],
      });
    }
  });

  it("keeps the gate building when an active record cannot be indexed", async () => {
    await db.collection("media_assets").doc("invalid-active").set(
      record("invalid-active", { name: "" }),
    );

    let probes = 0;
    const result = await backfillMediaDiscovery({
      firestore: db,
      apply: true,
      sourceSha: SOURCE_SHA,
      owner: OWNER,
      probeIndexes: async () => {
        probes += 1;
        return { ok: true };
      },
    });

    expect(result).toMatchObject({
      state: "building",
      blocked: { assetId: "invalid-active" },
    });
    expect(probes).toBe(0);
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      schema: 1,
      state: "building",
      phase: "write",
      error: { code: "invalid_asset", assetId: "invalid-active" },
      leaseOwner: null,
    });
    expect((await db.collection("media_assets").doc("invalid-active").get()).data())
      .not.toHaveProperty("mediaDiscovery");
  });
});
