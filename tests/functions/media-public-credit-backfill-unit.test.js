import { afterAll, expect, it, vi } from "vitest";
const originalRepairId = vi.hoisted(() => {
  const original = process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID;
  process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID = "a1b2c3d4";
  return original;
});
afterAll(() => {
  if (originalRepairId === undefined) delete process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID;
  else process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID = originalRepairId;
});
import {
  backfillMediaPublicCredit as runBackfill, recordCurrentMediaPublicCredit as runRecordCurrent, parseMediaPublicCreditArgs,
} from "../../scripts/backfill-media-public-credit.mjs";

const auditEntry = async (fields) => ({ ...fields, timestamp: "server-time", at: "test-time" });
const backfillMediaPublicCredit = (options) => runBackfill({ ...options, auditEntry });
const recordCurrentMediaPublicCredit = (options) => runRecordCurrent({ ...options, auditEntry });
const CONTEXT = "system/publicDeployment/contexts/public";

it.each([undefined, "", "bad/id", "a1b2c3d4\n"])("refuses missing or invalid startup repair identity before database access (%j)", async value => {
  vi.stubEnv("CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID", value);
  vi.resetModules();
  try {
    const { recordCurrentMediaPublicCredit: operation } = await import("../../scripts/backfill-media-public-credit.mjs");
    const collection = vi.fn();
    await expect(operation({ firestore: { collection }, expectedCount: 1, apply: true })).rejects.toThrow("repair identity");
    expect(collection).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

const image = {
  url: "https://media.njpbs.org/cms-media/general/asset/original.webp", altText: "An image",
  mimeType: "image/webp", width: 1920, height: 992, credit: "  NJ PBS  ",
  storageKey: "private-storage-key", lifecycle: "active", credential: "private-credential",
  source: "upload", version: 1, name: "Image", originalName: "image.webp",
  category: "general", kind: "image", sizeBytes: 42,
};
const oldPublic = {
  url: image.url, altText: "An image", mimeType: "image/webp", width: 1920, height: 992,
};

function store() {
  const records = new Map([[CONTEXT, { schemaVersion: 1, revision: 7 }], ["system/mediaDiscovery", { revision: 5 }]]);
  const writes = [];
  let nextId = 0;
  const ref = (path) => ({
    path, id: path.split("/").at(-1),
    async get() {
      const value = records.get(path);
      return { id: this.id, ref: this, exists: value !== undefined, data: () => structuredClone(value) };
    },
  });
  const collection = (name, cursor = null, count = 100, filters = []) => ({
    doc: (id = `audit-${++nextId}`) => ref(`${name}/${id}`),
    orderBy() { return this; },
    limit: (value) => collection(name, cursor, value, filters),
    startAfter: (value) => collection(name, value, count, filters),
    where: (field, operator, value) => {
      if (operator !== "==") throw new Error("Unsupported fixture filter");
      return collection(name, cursor, count, [...filters, [field, value]]);
    },
    async get() {
      const paths = [...records.keys()].filter((path) => path.startsWith(`${name}/`))
        .sort().filter((path) => (cursor === null || path.split("/").at(-1) > cursor) &&
          filters.every(([field, value]) => records.get(path)[field] === value)).slice(0, count);
      const docs = await Promise.all(paths.map((path) => ref(path).get()));
      return { docs, size: docs.length };
    },
  });
  return {
    records, writes, collection, doc: ref,
    getAll: (...references) => Promise.all(references.map(reference => reference.get())),
    runTransaction: vi.fn(async (callback) => {
      const pending = [];
      const result = await callback({
        get: (reference) => reference.get(),
        getAll: (...references) => Promise.all(references.map(reference => reference.get())),
        set: (reference, value, options) => pending.push({ path: reference.path, value, options }),
      });
      for (const write of pending) {
        writes.push(write);
        const previous = records.get(write.path) ?? {};
        const value = Object.fromEntries(Object.entries(write.value).map(([key, field]) => [key,
          field?.constructor?.name === "NumericIncrementTransform" ? (previous[key] ?? 0) + field.operand :
            field?.constructor?.name === "ServerTimestampTransform" ? "server-time" : structuredClone(field)]));
        records.set(write.path, write.options?.merge ? { ...previous, ...value } : value);
      }
      return result;
    }),
  };
}

function seed(db, id, privateData = image, publicData = oldPublic) {
  db.records.set(`media_assets/${id}`, structuredClone(privateData));
  if (publicData !== null) db.records.set(`media_assets_public/${id}`, structuredClone(publicData));
}

it("defaults to a read-only plan and reports only counts, ids and field names", async () => {
  const db = store();
  seed(db, "eligible");
  seed(db, "current", image, { ...oldPublic, credit: "NJ PBS" });
  seed(db, "no-credit", { ...image, credit: "   " });
  seed(db, "video", { ...image, mimeType: "video/mp4" });
  seed(db, "missing", image, null);
  seed(db, "other", image, { ...oldPublic, width: 3 });
  const before = structuredClone(db.records);
  const result = await backfillMediaPublicCredit({ firestore: db });
  expect(result).toMatchObject({ dryRun: true, scanned: 6, noCredit: 2, current: 1, eligible: 1, updated: 0, blocked: 2 });
  expect(result.assetIds.eligible).toEqual(["eligible"]);
  expect(result.differences).toContainEqual({ id: "other", fields: ["credit", "width"] });
  expect(result.differences.find((row) => row.id === "missing").fields).toEqual(["altText", "credit", "height", "mimeType", "url", "width"]);
  expect(JSON.stringify(result)).not.toContain(image.url);
  expect(JSON.stringify(result)).not.toContain(image.storageKey);
  expect(JSON.stringify(result)).not.toContain(image.credential);
  expect(db.records).toEqual(before);
  expect(db.runTransaction).not.toHaveBeenCalled();
});

// Issue #3205: deletion intentionally removes the public projection, while an
// active asset missing that document is still an unexplained projection gap.
it.each([false, true])("separates withdrawn media from active missing projections without writes (apply=%s)", async (apply) => {
  const db = store();
  seed(db, "withdrawn", { ...image, lifecycle: "tombstoned" }, null);
  seed(db, "missing", image, null);
  seed(db, "unknown", { ...image, lifecycle: "unknown" }, null);
  const before = structuredClone(db.records);
  const result = await backfillMediaPublicCredit({ firestore: db, apply });
  expect(result).toMatchObject({ scanned: 3, withdrawn: 1, blocked: 2, eligible: 0, updated: 0 });
  expect(result.assetIds.withdrawn).toEqual(["withdrawn"]);
  expect(result.differences).toEqual([
    { id: "missing", fields: ["altText", "credit", "height", "mimeType", "url", "width"] },
    { id: "unknown", fields: ["lifecycle"] },
  ]);
  expect(db.records).toEqual(before);
  expect(db.writes).toEqual([]);
  expect(db.runTransaction).not.toHaveBeenCalled();
});

it("writes the exact current projection once, preserving all private and unrelated documents", async () => {
  const db = store();
  seed(db, "eligible");
  seed(db, "wrong-credit", image, { ...oldPublic, credit: "Another credit" });
  seed(db, "extra-field", image, { ...oldPublic, storageKey: "public-extra-key" });
  db.records.set("cmsPosts/post", { published: true });
  db.records.set("cmsPublishQueue/queue", { status: "pending" });
  db.records.set("system/publicDeployment", { state: "idle" });
  const before = structuredClone(db.records);
  const result = await backfillMediaPublicCredit({ firestore: db, apply: true });
  expect(result).toMatchObject({ updated: 1, eligible: 1, blocked: 2 });
  expect(db.writes.filter(write => write.path.startsWith("media_assets_public/")))
    .toEqual([{ path: "media_assets_public/eligible", value: { ...oldPublic, credit: "NJ PBS" }, options: undefined }]);
  before.set("media_assets_public/eligible", { ...oldPublic, credit: "NJ PBS" });
  for (const [path, value] of before) {
    if (![CONTEXT, "system/mediaDiscovery"].includes(path)) expect(db.records.get(path)).toEqual(value);
  }
  expect(db.records.get(CONTEXT).revision).toBe(8);
  expect(db.records.get("system/mediaDiscovery").revision).toBe(6);
  expect(db.records.get("admin_logs/audit-1")).toMatchObject({ action: "media.public-credit.backfill",
    target: "media_assets_public/eligible", after: { credit: "NJ PBS", publicContextRevision: 8 } });
  const writes = db.writes.length;
  expect((await backfillMediaPublicCredit({ firestore: db, apply: true })).updated).toBe(0);
  expect(db.writes).toHaveLength(writes);
});

it.each(["public-changed", "public-deleted", "private-changed", "private-deleted", "credit-removed", "already-current"])(
  "re-reads both documents and refuses a stale write after %s", async (change) => {
    const db = store();
    seed(db, "asset");
    const original = db.runTransaction;
    db.runTransaction = vi.fn(async (callback) => {
      if (change === "public-changed") db.records.set("media_assets_public/asset", { ...oldPublic, height: 1 });
      if (change === "public-deleted") db.records.delete("media_assets_public/asset");
      if (change === "private-changed") db.records.set("media_assets/asset", { ...image, width: 3 });
      if (change === "private-deleted") db.records.delete("media_assets/asset");
      if (change === "credit-removed") db.records.set("media_assets/asset", { ...image, credit: "" });
      if (change === "already-current") db.records.set("media_assets_public/asset", { ...oldPublic, credit: "NJ PBS" });
      return original(callback);
    });
    expect((await backfillMediaPublicCredit({ firestore: db, apply: true })).updated).toBe(0);
    expect(db.writes).toEqual([]);
  },
);

it("uses the freshly re-projected private credit in its transaction", async () => {
  const db = store();
  seed(db, "asset");
  const original = db.runTransaction;
  db.runTransaction = vi.fn(async (callback) => {
    db.records.set("media_assets/asset", { ...image, credit: "  Updated credit  " });
    return original(callback);
  });
  expect((await backfillMediaPublicCredit({ firestore: db, apply: true })).updated).toBe(1);
  expect(db.records.get("media_assets_public/asset")).toEqual({ ...oldPublic, credit: "Updated credit" });
});

it("reads every ordered page", async () => {
  const db = store();
  for (let index = 0; index < 101; index++) seed(db, String(index).padStart(3, "0"));
  expect(await backfillMediaPublicCredit({ firestore: db })).toMatchObject({ scanned: 101, eligible: 101 });
});

it("requires the production project and explicit apply", () => {
  expect(parseMediaPublicCreditArgs(["--project", "njpbs-site"])).toEqual({ project: "njpbs-site", apply: false });
  expect(parseMediaPublicCreditArgs(["--project", "njpbs-site", "--apply"])).toEqual({ project: "njpbs-site", apply: true });
  for (const args of [[], ["--apply"], ["--project", "another-project"], ["--project", "njpbs-site", "--unknown"]]) {
    expect(() => parseMediaPublicCreditArgs(args)).toThrow();
  }
});

it.each([
  ["withdrawn", { lifecycle: "tombstoned" }, "lifecycle"],
  ["unsupported-source", { source: "other" }, "source"],
  ["unsupported-image", { mimeType: "image/svg+xml" }, "mimeType"],
  ["invalid-dimension", { width: -1 }, "privateRecord"],
  ["wrong-origin", { url: "https://another.example.test/cms-media/image" }, "url"],
])("refuses an exact legacy projection for %s", async (_name, change, field) => {
  const db = store();
  const privateData = { ...image, ...change };
  const publicData = { ...oldPublic, ...Object.fromEntries(Object.entries(change).filter(([key]) => key in oldPublic)) };
  seed(db, "asset", privateData, publicData);
  const result = await backfillMediaPublicCredit({ firestore: db, apply: true });
  expect(result.updated).toBe(0);
  expect(result.differences).toEqual([{ id: "asset", fields: [field] }]);
  expect(db.writes).toEqual([]);
});

it("refuses a replacement claimed after planning", async () => {
  const db = store();
  seed(db, "asset");
  const original = db.runTransaction;
  db.runTransaction = async (callback) => {
    db.records.set("system/media/replacements/asset", { operation: "replacement" });
    return original(callback);
  };
  const result = await backfillMediaPublicCredit({ firestore: db, apply: true });
  expect(result.differences).toEqual([{ id: "asset", fields: ["replacementClaim"] }]);
  expect(db.writes).toEqual([]);
});

it("fails apply when referenced media remains unsafe despite skipping its mismatch", async () => {
  const db = store();
  seed(db, "asset", image, { ...oldPublic, width: 1 });
  db.records.set("cmsAuthorProfilesPublic/author", { photo: { assetId: "asset" } });
  await expect(backfillMediaPublicCredit({ firestore: db, apply: true })).rejects.toThrow();
  expect(db.writes).toEqual([]);
});

function repairedCohort() {
  const db = store();
  seed(db, "asset-b", { ...image, source: "site_seed" }, { ...oldPublic, credit: "NJ PBS" });
  seed(db, "asset-a", { ...image, source: "site_seed" }, { ...oldPublic, credit: "NJ PBS" });
  seed(db, "withdrawn", { ...image, lifecycle: "tombstoned" }, null);
  db.records.set("cmsAuthorProfilesPublic/author", { photo: { assetId: "asset-a" } });
  return db;
}

it("plans the post-hoc receipt without writes and records the same cohort exactly once", async () => {
  const db = repairedCohort();
  const before = structuredClone(db.records);
  const plan = await recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 2 });
  expect(plan).toMatchObject({ dryRun: true, current: 2, blocked: 0, withdrawn: 1, recorded: false,
    alreadyRecorded: false, safety: { assetCount: 1 }, publicContextRevision: 7 });
  expect(db.records).toEqual(before);
  expect(db.writes).toEqual([]);
  const result = await recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 2, apply: true });
  expect(result).toMatchObject({ dryRun: false, recorded: true, publicContextRevision: 8 });
  expect(db.writes.map(write => write.path)).toEqual([
    CONTEXT, "system/mediaDiscovery", "admin_logs/media-public-credit-backfill-a1b2c3d4",
  ]);
  expect(db.records.get("admin_logs/media-public-credit-backfill-a1b2c3d4")).toMatchObject({
    action: "media.public-credit.backfill.record-current",
    after: { assetIds: ["asset-a", "asset-b"], publicContextRevision: 8 },
    source: "scripts/backfill-media-public-credit.mjs:a1b2c3d4",
  });
  for (const [path, value] of before) {
    if (![CONTEXT, "system/mediaDiscovery"].includes(path)) expect(db.records.get(path)).toEqual(value);
  }
  vi.stubEnv("CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID", "deadbeef");
  try {
    expect(await recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 2, apply: true }))
      .toMatchObject({ recorded: false, alreadyRecorded: true, publicContextRevision: 8 });
  } finally { vi.unstubAllEnvs(); }
  expect(db.records.get(CONTEXT).revision).toBe(8);
  expect(db.records.get("system/mediaDiscovery").revision).toBe(6);
  expect(db.writes).toHaveLength(3);
});

it.each([false, true])("refuses a different valid repair identity after module reload without writes (apply=%s)", async apply => {
  const db = repairedCohort();
  await recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 2, apply: true });
  const before = structuredClone(db.records), writes = db.writes.length;
  vi.stubEnv("CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID", "deadbeef");
  vi.resetModules();
  try {
    const { recordCurrentMediaPublicCredit: operation } = await import("../../scripts/backfill-media-public-credit.mjs");
    await expect(operation({ firestore: db, expectedCount: 2, apply, auditEntry }))
      .rejects.toThrow("identity conflicts");
  } finally { vi.unstubAllEnvs(); }
  expect(db.records).toEqual(before);
  expect(db.writes).toHaveLength(writes);
});

it("refuses a post-hoc count mismatch or outstanding repair", async () => {
  const db = repairedCohort();
  await expect(recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 143, apply: true })).rejects.toThrow();
  seed(db, "unrepaired");
  await expect(recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 2, apply: true })).rejects.toThrow();
  expect(db.writes).toEqual([]);
});

it("runs post-hoc baseline safety inside the same read transaction", async () => {
  const db = repairedCohort();
  db.getAll = vi.fn(() => { throw new Error("Nontransactional safety read"); });
  expect(await recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 2 }))
    .toMatchObject({ safety: { assetCount: 1 }, recorded: false });
  expect(db.getAll).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
});

it.each(["replacement", "credit-change", "unsafe-baseline", "conflicting-audit"])(
  "rechecks the post-hoc cohort and refuses %s atomically", async (change) => {
    const db = repairedCohort();
    const original = db.runTransaction;
    db.runTransaction = async (callback) => {
      if (change === "replacement") db.records.set("system/media/replacements/asset-a", { operation: "replacement" });
      if (change === "credit-change") db.records.set("media_assets/asset-a", { ...image, source: "site_seed", credit: "new" });
      if (change === "unsafe-baseline") db.records.set("cmsAuthorProfilesPublic/other", { photo: { assetId: "missing" } });
      if (change === "conflicting-audit") db.records.set("admin_logs/media-public-credit-backfill-a1b2c3d4", { action: "other" });
      return original(callback);
    };
    await expect(recordCurrentMediaPublicCredit({ firestore: db, expectedCount: 2, apply: true })).rejects.toThrow();
    expect(db.writes).toEqual([]);
    expect(db.records.get(CONTEXT).revision).toBe(7);
  },
);

it("requires a bounded explicit count for post-hoc mode", () => {
  expect(parseMediaPublicCreditArgs(["--project", "njpbs-site", "--record-current", "--expected-count", "143"]))
    .toEqual({ project: "njpbs-site", apply: false, recordCurrent: true, expectedCount: 143 });
  for (const extra of [["--record-current"], ["--expected-count", "143"],
    ["--record-current", "--expected-count", "0"], ["--record-current", "--expected-count", "501"]]) {
    expect(() => parseMediaPublicCreditArgs(["--project", "njpbs-site", ...extra])).toThrow();
  }
});
