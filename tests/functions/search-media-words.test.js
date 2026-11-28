import { FieldPath } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import searchMedia from "../../functions/search-media.js";
import uploads from "../../functions/source-media-uploads.js";
import searchTokens from "../../functions/lib/source-media-search-tokens.js";
import contract from "../../functions/lib/source-media-contract.js";
import { backfillVideoSearchTokens, parseBackfillArgs } from "../../scripts/backfill-video-search-tokens.mjs";

const { createCmsSearchMediaHandler } = searchMedia;
const videos = { id: "video-library", label: "Videos", access: "active_staff", prefix: "station/" };
const db = isolatedFirestore("search-media-words");

function stored(id, name, overrides = {}) {
  const value = {
    sourceId: videos.id, lifecycle: "active", kind: "video", name, originalName: `${id}.mp4`,
    nameSort: name.normalize("NFKC").toLocaleLowerCase("en-US"), mimeType: "video/mp4", sizeBytes: 1024,
    preview: "browser", rightsStatus: "pending", version: 1, tags: [], description: null,
    updatedAtSort: "2026-11-27T16:00:00.000Z", objectKey: `station/${id}.mp4`, objectVersionId: "v1",
    ...overrides,
  };
  return { ...value, searchTokens: searchTokens.sourceMediaSearchTokens(value), ...overrides };
}

async function seed(records) {
  const batch = db.batch();
  for (const [id, value] of Object.entries(records)) batch.set(db.collection("mediaSourceAssets").doc(id), value);
  await batch.commit();
}

async function search(body) {
  const handler = createCmsSearchMediaHandler({
    firestore: db, documentIdField: FieldPath.documentId(), log: { warn: vi.fn(), error: vi.fn() },
    requirePrincipalFn: async () => ({ uid: "editor-1", approvedActive: true,
      principal: { id: "editor-1", grants: [{ tier: "viewer" }] } }),
    registryFn: () => new Map([[videos.id, videos]]),
  });
  const res = { set: vi.fn(), status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
  await handler({ method: "POST", body, headers: { "content-type": "application/json" } }, res);
  return res;
}

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

describe("cmsSearchMedia word search in Firestore", () => {
  it("finds a word anywhere in the name, tags or description", async () => {
    await seed({
      dusk: stored("dusk", "Dusk harbor"),
      tagged: stored("tagged", "Ferry crossing", { tags: ["Harbor"] }),
      described: stored("described", "Night shot", { description: "Lights over the harbor." }),
      partial: stored("partial", "Harborside"),
      deleted: stored("deleted", "Harbor bin", { lifecycle: "deleted" }),
    });
    const result = await search({ q: "harbor" });
    expect(result.code).toBe(200);
    expect(result.body.records.map(record => record.id)).toEqual(["dusk", "tagged", "described"]);
    const narrowed = await search({ q: "harbor dus" });
    expect(narrowed.body.records).toEqual([{ id: "dusk", sourceId: videos.id, kind: "video", name: "Dusk harbor" }]);
  });

  it("writes tokens on metadata edits through the shared write point", async () => {
    await seed({ edited: stored("edited", "Old title") });
    const ref = db.collection("mediaSourceAssets").doc("edited");
    await db.runTransaction(async (transaction) => {
      const current = contract.parseSourceMediaAsset("edited", (await transaction.get(ref)).data());
      uploads.writeSourceMetadata({
        transaction, firestore: db, ref, current, patch: { name: "Dusk harbor", tags: ["sunset"] },
        actor: { uid: "editor-1" }, adminLogEntryFn: (entry) => entry, now: "2026-11-27T17:00:00.000Z",
      });
    });
    expect((await ref.get()).data().searchTokens).toEqual(["dusk", "harbor", "sunset"]);
    expect((await search({ q: "sunset" })).body.records.map(record => record.id)).toEqual(["edited"]);
  });

  it("backfills missing tokens idempotently with a counts-only dry run", async () => {
    const legacy = stored("legacy", "Dusk harbor");
    delete legacy.searchTokens;
    await seed({ legacy, current: stored("current", "County meeting") });
    expect((await search({ q: "harbor" })).body.records).toEqual([]);
    expect(await backfillVideoSearchTokens({ firestore: db })).toEqual({
      dryRun: true, pages: 1, scanned: 2, current: 1, eligible: 1, updated: 0, skipped: 0,
    });
    expect((await db.collection("mediaSourceAssets").doc("legacy").get()).data().searchTokens).toBeUndefined();
    expect(await backfillVideoSearchTokens({ firestore: db, apply: true, pageSize: 1 })).toMatchObject({
      dryRun: false, eligible: 1, updated: 1,
    });
    const after = (await db.collection("mediaSourceAssets").doc("legacy").get()).data();
    expect(after).toMatchObject({ searchTokens: ["dusk", "harbor"], version: 1 });
    expect(await backfillVideoSearchTokens({ firestore: db, apply: true })).toMatchObject({ current: 2, updated: 0 });
    expect((await search({ q: "harbor" })).body.records.map(record => record.id)).toEqual(["legacy"]);
  });

  it("targets only the project that the configured target names", () => {
    const development = { emulator: false, targetProject: () => "njpbs-site-dev" };
    expect(parseBackfillArgs(["--project", "njpbs-site-dev", "--apply"], development))
      .toEqual({ apply: true, project: "njpbs-site-dev" });
    expect(() => parseBackfillArgs(["--project", "njpbs-site"], development)).toThrow("configured CMS_TARGET project");
    expect(() => parseBackfillArgs([], development)).toThrow("configured CMS_TARGET project");
    expect(() => parseBackfillArgs(["--project"], development)).toThrow("configured CMS_TARGET project");
    expect(() => parseBackfillArgs(["--apply", "--apply", "--project", "njpbs-site-dev"], development)).toThrow("optional --apply");
    expect(parseBackfillArgs(["--apply"], { emulator: true, targetProject: () => { throw new Error("not read"); } }))
      .toEqual({ apply: true, project: null });
    expect(() => parseBackfillArgs(["--project", "njpbs-site-dev"], { emulator: true, targetProject: () => "njpbs-site-dev" }))
      .toThrow("optional --apply");
  });
});
