import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { FieldValue } = require("firebase-admin/firestore");
const originalState = require("../../functions/lib/source-original-state");
const originals = require("../../functions/lib/source-originals");
const { createOriginalHandler } = require("../../functions/source-media-originals");
const { parseSourceMediaAsset, sourceMediaAssetSummary } = require("../../functions/lib/source-media-contract");
const { ORIGINAL_STATUS, readOriginalStatuses } = require("../../functions/lib/source-original-status");
const { createS3MediaSourceReader } = require("../../functions/lib/s3-media-source");
const { sourceMediaRenditionOutputPrefix } = require("../../functions/lib/source-media-rendition");
const { createVideoPreviewProcessor } = require("../../functions/lib/video-preview-processor");
const { clipHandler } = require("../../functions/video-clips");
const { createCmsListSourceMediaHandler } = require("../../functions/source-media");

const now = Date.parse("2026-10-17T18:00:00Z");
const source = { id: "video-library", prefix: "objects/", bucket: "njpbs-video-originals-123456789012-us-east-2",
  expectedBucketOwner: "123456789012", roleArn: "arn:aws:iam::123456789012:role/njpbs-boardwalk-video-read",
  access: "active_staff", writable: true };
const actor = { uid: "staff", principal: { id: "staff", grants: [{ role: "staff" }] } };
const manager = { uid: "other", principal: { id: "other", grants: [{ tier: "contributor" }] } };
const config = { region: "us-east-2", audience: "njpbs-boardwalk-s3", source,
  workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
const data = () => ({ sourceId: source.id, lifecycle: "active", name: "News master", originalName: "news.mxf",
  nameSort: "news master", updatedAtSort: new Date(now).toISOString(), mimeType: "application/mxf", kind: "video",
  sizeBytes: 1000, preview: "download_only", rightsStatus: "complete", tags: [], version: 4,
  objectKey: "objects/news.mxf", objectVersionId: "original-version" });
const head = (extra = {}) => ({ VersionId: "original-version", ContentLength: 1000, StorageClass: "INTELLIGENT_TIERING", ...extra });
const archived = () => head({ ArchiveStatus: "DEEP_ARCHIVE_ACCESS" });
const parsed = (value = data()) => parseSourceMediaAsset("asset", value);

// Firestore is a network boundary. This fake commits writes only after a transaction succeeds.
function database() {
  const rows = new Map([["mediaSourceAssets/asset", data()], ["users/staff", { active: true }], ["users/other", { active: true }]]);
  let auto = 0;
  const committedPaths = [];
  const snapshot = ref => ({ ref, id: ref.id, exists: rows.has(ref.path), data: () => rows.get(ref.path) && { ...rows.get(ref.path) } });
  function ref(path) {
    return { path, id: path.split("/").at(-1), collection: name => collection(`${path}/${name}`),
      get: async () => snapshot(ref(path)), set: async value => rows.set(path, value),
      update: async changes => update(path, changes), delete: async () => rows.delete(path) };
  }
  function update(path, changes) {
    committedPaths.push(path);
    const next = { ...rows.get(path) };
    for (const [key, value] of Object.entries(changes)) {
      if (value?.isEqual?.(FieldValue.delete())) delete next[key]; else next[key] = value;
    }
    rows.set(path, next);
  }
  function collection(path, filters = [], maximum = Infinity, order) {
    return { doc: id => ref(`${path}/${id ?? `auto-${++auto}`}`),
      where: (field, op, value) => collection(path, [...filters, [field, op, value]], maximum, order),
      orderBy: field => collection(path, filters, maximum, field),
      limit: count => collection(path, filters, count, order),
      get: async () => {
        let items = [...rows].filter(([key, value]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).indexOf("/") < 0 &&
          filters.every(([field, op, expected]) => op === "==" ? value[field] === expected :
            typeof value[field] === "number" && value[field] <= expected));
        if (order) items.sort((a, b) => a[1][order] - b[1][order]);
        const docs = items.slice(0, maximum).map(([key]) => snapshot(ref(key)));
        return { docs, size: docs.length };
      } };
  }
  return { rows, committedPaths, collection, doc: ref, async runTransaction(fn) {
    const writes = [];
    const result = await fn({ get: async reference => snapshot(reference),
      set: (reference, value) => writes.push(() => { committedPaths.push(reference.path); rows.set(reference.path, value); }),
      create: (reference, value) => writes.push(() => { committedPaths.push(reference.path); rows.set(reference.path, value); }),
      update: (reference, changes) => writes.push(() => update(reference.path, changes)) });
    writes.forEach(write => write());
    return result;
  } };
}
function sdk(initial = archived()) {
  let current = initial;
  let restoreError;
  const send = vi.fn(async command => {
    if (command.constructor.name === "HeadObjectCommand") {
      if (current instanceof Error) throw current;
      return current;
    }
    if (command.constructor.name === "RestoreObjectCommand") {
      if (restoreError) throw restoreError;
      return { $metadata: { httpStatusCode: 202 } };
    }
    throw new Error("Unexpected S3 operation");
  });
  return { client: { send }, storage: originals.createOriginalStorage(config, { client: { send } }),
    setHead(value) { current = value; }, setRestoreError(value) { restoreError = value; }, send };
}
const log = { warn: vi.fn(), error: vi.fn() };
function response() { return { set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function request(body) { return { method: "POST", body, headers: { "content-type": "application/json" }, rawBody: Buffer.from(JSON.stringify(body)) }; }
async function restore(db, aws, who = actor) {
  return originals.requestOriginalRestore({ firestore: db, storage: aws.storage, source, asset: parsed(db.rows.get("mediaSourceAssets/asset")), actor: who, now });
}
async function tick(db, aws, time = now + 60_001) {
  return originals.processOriginalRestores({ firestore: db, storage: aws.storage, registry: new Map([[source.id, source]]), now: time, log });
}

describe("master availability and SDK storage contract", () => {
  it.each([
    [head(), "available"], [head({ StorageClass: "STANDARD" }), "available"],
    [head({ ArchiveStatus: "ARCHIVE_ACCESS" }), "archived"], [archived(), "archived"],
    [head({ ArchiveStatus: "DEEP_ARCHIVE_ACCESS", Restore: 'ongoing-request="true"' }), "restoring"],
    [head({ Restore: 'ongoing-request="false"' }), "restored"],
    [head({ StorageClass: "GLACIER" }), "archived"],
    [head({ StorageClass: "DEEP_ARCHIVE" }), "archived"],
    [head({ StorageClass: "GLACIER", Restore: 'ongoing-request="true"' }), "restoring"],
    [head({ StorageClass: "DEEP_ARCHIVE", Restore: 'ongoing-request="false"' }), "restored"],
    // The two x-amz-restore values below are the forms in the AWS S3 HeadObject reference.
    [head({ StorageClass: "DEEP_ARCHIVE", Restore: 'ongoing-request="true"' }), "restoring"],
    [head({ StorageClass: "DEEP_ARCHIVE", Restore: 'ongoing-request="false", expiry-date="Fri, 23 Oct 2026 00:00:00 GMT"' }), "restored"],
    [head({ StorageClass: "DEEP_ARCHIVE", Restore: 'ongoing-request="false", expiry-date="Sat, 17 Oct 2026 00:00:00 GMT"' }), "archived"],
    [head({ Restore: 'ongoing-request="false", expiry-date="Sat, 17 Oct 2026 00:00:00 GMT"' }), "restored"],
  ])("reads S3 archive state without confusing instant access with an archive", (value, expected) => {
    const original = originalState.stateFromHead(value, null, now);
    expect(original.state).toBe(expected);
    if (value.StorageClass === "INTELLIGENT_TIERING" || expected !== "restored") expect(original).not.toHaveProperty("availableUntil");
  });
  it("returns the real Restore expiry through the status boundary and the exact-version cache", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-08T09:20:13.213Z") });
    try {
      const db = database();
      const aws = sdk(head({ StorageClass: "DEEP_ARCHIVE",
        Restore: 'ongoing-request="false", expiry-date="Mon, 16 Nov 2026 00:00:00 GMT"' }));
      const handler = createOriginalHandler({ firestore: db, storage: aws.storage, registry: () => new Map([[source.id, source]]),
        requirePrincipal: async () => actor, log });
      const res = response();
      await handler(request({ action: "status", sourceId: source.id, assetId: "asset" }), res);
      expect(res.code).toBe(200);
      expect(res.body.original).toMatchObject({ state: "restored", availableUntil: "2026-11-16T00:00:00.000Z" });
      expect(db.rows.get(`${ORIGINAL_STATUS}/asset`)).toMatchObject({ ...res.body.original,
        sourceId: source.id, objectKey: data().objectKey, objectVersionId: data().objectVersionId, sizeBytes: data().sizeBytes });
      expect((await readOriginalStatuses(db, [parsed()])).get("asset")).toEqual(res.body.original);
      aws.send.mockClear();
      expect(await originals.refreshOriginal({ firestore: db, storage: aws.storage, source, asset: parsed() })).toEqual(res.body.original);
      expect(aws.send).not.toHaveBeenCalled();
      expect((await readOriginalStatuses(db, [parsed({ ...data(), objectVersionId: "replacement" })])).get("asset")).toBeNull();

      vi.setSystemTime(Date.parse("2026-11-16T00:00:00Z"));
      const expired = response();
      await handler(request({ action: "status", sourceId: source.id, assetId: "asset" }), expired);
      expect(expired.code).toBe(200);
      expect(expired.body.original.state).toBe("archived");
      expect(expired.body.original).not.toHaveProperty("availableUntil");
      expect((await readOriginalStatuses(db, [parsed()])).get("asset")).toEqual(expired.body.original);
    } finally { vi.useRealTimers(); }
  });
  it("retains the restored state after Intelligent-Tiering clears its archive and restore headers", () => {
    expect(originalState.stateFromHead(head(), { state: "restoring" }, now).state).toBe("restored");
  });
  it("restores only the indexed version, owner and Standard tier, without a temporary-copy Days field", async () => {
    const aws = sdk();
    await aws.storage.restore(source, parsed());
    expect(aws.send.mock.calls[0][0].input).toEqual({ Bucket: source.bucket, Key: data().objectKey,
      VersionId: data().objectVersionId, ExpectedBucketOwner: source.expectedBucketOwner,
      // AWS RestoreObject defines Tier at this level; Intelligent-Tiering does not accept Days.
      RestoreRequest: { Tier: "Standard" } });
    aws.setRestoreError(Object.assign(new Error("private SDK body"), { name: "RestoreAlreadyInProgress" }));
    await expect(aws.storage.restore(source, parsed())).resolves.toBeUndefined();
  });
  it("sends a DEEP_ARCHIVE restore with Days and a Standard Glacier job tier, also when the checker retries", async () => {
    const expected = { Bucket: source.bucket, Key: data().objectKey, VersionId: data().objectVersionId,
      ExpectedBucketOwner: source.expectedBucketOwner,
      // AWS RestoreObject: Days and GlacierJobParameters.Tier, with Tier required in that container.
      RestoreRequest: { Days: 7, GlacierJobParameters: { Tier: "Standard" } } };
    const restores = aws => aws.send.mock.calls.map(([command]) => command).filter(command => command.constructor.name === "RestoreObjectCommand");
    const db = database(); const aws = sdk(head({ StorageClass: "DEEP_ARCHIVE" }));
    expect((await restore(db, aws, manager)).state).toBe("restoring");
    expect(restores(aws).map(command => command.input)).toEqual([expected]);

    const lostDb = database(); const lost = sdk(head({ StorageClass: "DEEP_ARCHIVE" }));
    lost.setRestoreError(Object.assign(new Error("private SDK body"), { name: "ServiceUnavailable" }));
    await expect(restore(lostDb, lost, manager)).rejects.toMatchObject({ name: "ServiceUnavailable" });
    lost.setRestoreError(undefined); await tick(lostDb, lost);
    expect(restores(lost).map(command => command.input)).toEqual([expected, expected]);
  });
  it("starts no paid DEEP_ARCHIVE restore while the billing switch is on, and leaves free restores alone", async () => {
    const restores = aws => aws.send.mock.calls.filter(([command]) => command.constructor.name === "RestoreObjectCommand");
    const jobKey = `${originals.RESTORES}/${originals.restoreId(parsed())}`;
    const stopped = database(); stopped.rows.set("system/billing", { disabled: true });
    const blocked = sdk(head({ StorageClass: "DEEP_ARCHIVE" }));
    await expect(restore(stopped, blocked, manager)).rejects.toMatchObject({ status: 409,
      message: "Restore is paused while billing is stopped. Ask a CMS administrator." });
    expect(restores(blocked)).toHaveLength(0);
    expect(stopped.rows.has(jobKey)).toBe(false);
    const outage = Object.assign(new Error("Firestore unavailable"), { code: 14 });
    const unreadable = database(); unreadable.doc = () => ({ get: async () => { throw outage; } });
    await expect(restore(unreadable, blocked, manager)).rejects.toBe(outage);
    expect(restores(blocked)).toHaveLength(0);

    const saved = database(); const pending = sdk(head({ StorageClass: "DEEP_ARCHIVE" }));
    pending.setRestoreError(Object.assign(new Error("private SDK body"), { name: "ServiceUnavailable" }));
    await expect(restore(saved, pending, manager)).rejects.toMatchObject({ name: "ServiceUnavailable" });
    saved.rows.set("system/billing", { disabled: true }); pending.setRestoreError(undefined);
    await tick(saved, pending);
    expect(restores(pending)).toHaveLength(1);
    expect(saved.rows.get(jobKey)).toMatchObject({ active: true, phase: "requesting" });
    saved.rows.delete("system/billing");
    await tick(saved, pending, now + 17 * 60_000);
    expect(restores(pending)).toHaveLength(2);

    const free = database(); free.rows.set("system/billing", { disabled: true });
    const tiered = sdk();
    await restore(free, tiered);
    expect(restores(tiered)).toHaveLength(1);
  });
  it("finishes a DEEP_ARCHIVE restore on the copy, then archives the version again when the copy expires", async () => {
    const db = database(); const aws = sdk(head({ StorageClass: "DEEP_ARCHIVE" }));
    await restore(db, aws, manager);
    aws.setHead(head({ StorageClass: "DEEP_ARCHIVE", Restore: 'ongoing-request="true"' }));
    await tick(db, aws);
    expect(db.rows.get(`${originals.RESTORES}/${originals.restoreId(parsed())}`).active).toBe(true);
    const restored = head({ StorageClass: "DEEP_ARCHIVE", Restore: 'ongoing-request="false", expiry-date="Sun, 25 Oct 2026 00:00:00 GMT"' });
    aws.setHead(restored); await tick(db, aws, now + 17 * 60_000);
    expect(db.rows.get(`${originals.RESTORES}/${originals.restoreId(parsed())}`).active).toBe(false);
    const status = time => originals.refreshOriginal({ firestore: db, storage: aws.storage, source, asset: parsed(), fresh: true, now: time });
    expect((await status(now + 3_600_000)).state).toBe("restored");
    expect((await status(Date.parse("2026-10-25T00:00:00Z"))).state).toBe("archived");
    aws.setHead(head({ StorageClass: "DEEP_ARCHIVE" }));
    expect((await status(Date.parse("2026-10-25T01:00:00Z"))).state).toBe("archived");
  });
  it("blocks reads of an expired DEEP_ARCHIVE copy and allows reads of a current one", () => {
    vi.useFakeTimers({ now });
    try {
      const copy = date => head({ StorageClass: "DEEP_ARCHIVE", Restore: `ongoing-request="false", expiry-date="${date}"` });
      expect(() => originalState.assertOriginalReadable(copy("Sat, 17 Oct 2026 00:00:00 GMT"))).toThrow(originalState.OriginalArchivedError);
      expect(() => originalState.assertOriginalReadable(copy("Sun, 18 Oct 2026 00:00:00 GMT"))).not.toThrow();
    } finally { vi.useRealTimers(); }
  });
  it("offers administrator recovery for direct GLACIER originals", async () => {
    const db = database(); const aws = sdk(head({ StorageClass: "GLACIER" }));
    const original = await originals.refreshOriginal({ firestore: db, storage: aws.storage, source, asset: parsed(), fresh: true, now });
    expect(original.state).toBe("archived");
    await expect(restore(db, aws)).rejects.toMatchObject({ status: 409,
      message: "Ask a CMS administrator to restore this storage class." });
    expect(aws.send.mock.calls.every(([command]) => command.constructor.name === "HeadObjectCommand")).toBe(true);
    expect(db.rows.has(`${originals.RESTORES}/${originals.restoreId(parsed())}`)).toBe(false);
  });
  it("overlaps poster signing and original status work on a listed page", async () => {
    const db = database(); const value = data();
    const prefix = sourceMediaRenditionOutputPrefix({ id: "asset", ...value }, "viewing");
    value.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: value.objectKey,
      sourceObjectVersionId: value.objectVersionId, sourceSizeBytes: value.sizeBytes, attemptId: "viewing", updatedAt: new Date(now).toISOString(),
      web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web", sizeBytes: 500, mimeType: "video/mp4" },
      poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster", sizeBytes: 50, mimeType: "image/jpeg" } };
    const asset = parsed(value); db.rows.set("mediaSourceAssets/asset", value);
    const started = new Set(); let release;
    const bothStarted = new Promise(resolve => { release = resolve; });
    const join = async kind => { started.add(kind); if (started.size === 2) release(); await bothStarted; };
    const storage = originals.createOriginalStorage(config, { client: { send: async () => { await join("original"); return head(); } } });
    const handler = createCmsListSourceMediaHandler({ firestore: db, originalStorage: storage,
      requirePrincipalFn: async () => actor, registryFn: () => new Map([[source.id, source]]), authorizeFn: async () => {},
      readPageFn: async () => ({ assets: [asset], records: [sourceMediaAssetSummary(asset)] }), readTotalFn: async () => null,
      createReadFn: async () => { await join("poster"); return { assetId: asset.id, url: "https://example.test/poster", expiresAt: "later" }; }, log });
    const res = response(); await handler(request({ sourceId: source.id, posters: true }), res);
    expect(res.code).toBe(200);
    expect(res.body.records[0].original.state).toBe("available");
    expect(res.body.posters).toEqual([{ assetId: "asset", url: "https://example.test/poster", expiresAt: "later" }]);
  });
  it("blocks signed original downloads while archived, but signs the independent viewing copy and poster", async () => {
    const value = data(); const prefix = sourceMediaRenditionOutputPrefix({ id: "asset", ...value }, "viewing");
    value.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: value.objectKey,
      sourceObjectVersionId: value.objectVersionId, sourceSizeBytes: value.sizeBytes, attemptId: "viewing", updatedAt: new Date(now).toISOString(),
      web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web", sizeBytes: 500, mimeType: "video/mp4" },
      poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster", sizeBytes: 50, mimeType: "image/jpeg" } };
    const sign = vi.fn(async () => "https://example.test/read");
    class FakeS3 { async send(command) { return command.input.Bucket === source.bucket ? archived() :
      { VersionId: command.input.VersionId, ContentLength: command.input.VersionId === "web" ? 500 : 50 }; } }
    const read = createS3MediaSourceReader({ ...config, renditionBucket: "renditions", renditionExpectedBucketOwner: source.expectedBucketOwner },
      { S3ClientCtor: FakeS3, getSignedUrlFn: sign, createAwsRoleCredentialProviderFn: () => async () => ({}) });
    await expect(read(source, parsed(value), "download")).rejects.toMatchObject({ status: 409, code: "original_archived" });
    expect(sign).not.toHaveBeenCalled();
    for (const action of ["preview", "poster", "download_web"]) await expect(read(source, parsed(value), action)).resolves.toHaveProperty("url");
  });
  it("maps InvalidObjectState to a safe restore offer without exposing the SDK body", async () => {
    const aws = sdk(Object.assign(new Error("private SDK body"), { name: "InvalidObjectState" }));
    await expect(aws.storage.head(source, parsed())).rejects.toMatchObject({ code: "original_archived", status: 409 });
  });
  it("never starts a re-transcode on an archived original", async () => {
    const aws = sdk(); const provider = { send: vi.fn() };
    const process = createVideoPreviewProcessor(config, { client: provider, s3: aws.client });
    await expect(process({ id: "job", phase: "pending", sourceObjectKey: data().objectKey,
      sourceObjectVersionId: data().objectVersionId, sourceSizeBytes: 1000 }, vi.fn())).rejects.toMatchObject({ code: "original_archived" });
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe("restore authorization and exact object binding", () => {
  it.each(["inactive", "no role", "disabled source", "other source", "outside prefix", "extra bucket", "wrong version"])("fails closed for %s", async scenario => {
    const db = database(); const aws = sdk();
    let user = actor; let enabled = true;
    const body = { action: "restore", sourceId: source.id, assetId: "asset" };
    if (scenario === "inactive") db.rows.set("users/staff", { active: false });
    if (scenario === "no role") user = { ...actor, principal: { id: "staff", grants: [] } };
    if (scenario === "disabled source") enabled = false;
    if (scenario === "other source") db.rows.get("mediaSourceAssets/asset").sourceId = "another-source";
    if (scenario === "outside prefix") db.rows.get("mediaSourceAssets/asset").objectKey = "private/news.mxf";
    if (scenario === "extra bucket") body.bucket = "attacker";
    if (scenario === "wrong version") aws.setHead(head({ VersionId: "another-version" }));
    const handler = createOriginalHandler({ firestore: db, storage: aws.storage, registry: () => new Map(enabled ? [[source.id, source]] : []),
      requirePrincipal: async () => user, verifyAppCheck: async () => {}, log });
    const res = response(); await handler(request(body), res);
    expect(res.code).toBeGreaterThanOrEqual(400);
    expect(aws.send.mock.calls.some(([command]) => command.constructor.name === "RestoreObjectCommand")).toBe(false);
    expect(db.rows.has(`${originals.RESTORES}/${originals.restoreId(parsed())}`)).toBe(false);
  });
  it("allows download roles to request restore even without upload or metadata permission", async () => {
    const db = database(); const aws = sdk();
    const handler = createOriginalHandler({ firestore: db, storage: aws.storage, registry: () => new Map([[source.id, source]]),
      requirePrincipal: async () => actor, verifyAppCheck: async () => {}, log });
    const res = response(); await handler(request({ sourceId: source.id, assetId: "asset", action: "restore" }), res);
    expect(res.code).toBe(200); expect(res.body.original.state).toBe("restoring");
    expect(JSON.stringify(res.body)).not.toMatch(/objectKey|objectVersionId|roleArn|bucket/);
  });
  describe("paid DEEP_ARCHIVE restore", () => {
    const deepArchive = () => head({ StorageClass: "DEEP_ARCHIVE" });
    const restores = aws => aws.send.mock.calls.filter(([command]) => command.constructor.name === "RestoreObjectCommand");
    const jobKey = () => `${originals.RESTORES}/${originals.restoreId(parsed())}`;
    const handler = (db, aws, user) => createOriginalHandler({ firestore: db, storage: aws.storage, registry: () => new Map([[source.id, source]]),
      requirePrincipal: async () => user, verifyAppCheck: async () => {}, log });
    const body = { sourceId: source.id, assetId: "asset", action: "restore" };

    it.each([
      ["Viewer tier", [{ tier: "viewer" }]], ["legacy staff", [{ role: "staff" }]], ["legacy contributor", [{ role: "contributor" }]],
    ])("refuses %s with no RestoreObject and no saved job", async (_label, grants) => {
      const db = database(); const aws = sdk(deepArchive());
      const res = response(); await handler(db, aws, { ...actor, principal: { id: "staff", grants } })(request(body), res);
      expect(res.code).toBe(403);
      expect(res.body.error).toBe("Ask a person who manages video to restore this original.");
      expect(restores(aws)).toHaveLength(0);
      expect(db.rows.has(jobKey())).toBe(false);
      expect(db.rows.has(`${ORIGINAL_STATUS}/asset`)).toBe(false);
    });
    it.each([
      ["Contributor tier", [{ tier: "contributor" }]], ["Editor tier", [{ tier: "editor" }]], ["Publisher tier", [{ tier: "publisher" }]],
      ["Admin tier", [{ tier: "admin" }]], ["Owner tier", [{ tier: "owner" }]], ["legacy editor", [{ role: "editor" }]],
      ["legacy admin", [{ role: "admin" }]], ["legacy super admin", [{ role: "super_admin" }]],
    ])("allows %s, who manages video", async (_label, grants) => {
      const db = database(); const aws = sdk(deepArchive());
      const res = response(); await handler(db, aws, { ...actor, principal: { id: "staff", grants } })(request(body), res);
      expect(res.code).toBe(200); expect(res.body.original.state).toBe("restoring");
      expect(restores(aws)).toHaveLength(1);
      expect(db.rows.get(jobKey()).deepArchiveApprovedBy).toBe("staff");
    });
    it("keeps the Viewer Intelligent-Tiering restore free of the check, with its original request", async () => {
      const db = database(); const aws = sdk();
      const res = response(); await handler(db, aws, { ...actor, principal: { id: "staff", grants: [{ tier: "viewer" }] } })(request(body), res);
      expect(res.code).toBe(200);
      expect(restores(aws).map(([command]) => command.input.RestoreRequest)).toEqual([{ Tier: "Standard" }]);
      expect(db.rows.get(jobKey())).not.toHaveProperty("deepArchiveApprovedBy");
    });
    it("retries a lost S3 response for a manager's saved request", async () => {
      const db = database(); const aws = sdk(deepArchive());
      aws.setRestoreError(new Error("connection lost"));
      await expect(restore(db, aws, manager)).rejects.toThrow("connection lost");
      aws.setRestoreError(undefined); await tick(db, aws);
      expect(restores(aws)).toHaveLength(2);
      expect(db.rows.get(jobKey())).toMatchObject({ active: true, phase: "restoring" });
    });
    it("never starts a paid retry from a Viewer's free request after the object moves to DEEP_ARCHIVE", async () => {
      const db = database(); const aws = sdk();
      aws.setRestoreError(new Error("connection lost"));
      await expect(restore(db, aws)).rejects.toThrow("connection lost");
      aws.setRestoreError(undefined); aws.setHead(deepArchive()); await tick(db, aws);
      expect(restores(aws)).toHaveLength(1);
      expect(restores(aws)[0][0].input.RestoreRequest).toEqual({ Tier: "Standard" });
      expect(db.rows.get(jobKey())).toMatchObject({ active: false, phase: "failed" });
      expect(db.rows.get(`${ORIGINAL_STATUS}/asset`).state).toBe("archived");
      expect([...db.rows.values()].filter(row => row.outcome === "failed")).toHaveLength(1);
    });
    it("keeps a request that a manager approves while the checker reads S3", async () => {
      const db = database(); const aws = sdk();
      aws.setRestoreError(new Error("connection lost"));
      await expect(restore(db, aws)).rejects.toThrow("connection lost");
      aws.setRestoreError(undefined); aws.setHead(deepArchive());
      const storage = { ...aws.storage, head: async (...args) => {
        const result = await aws.storage.head(...args);
        await restore(db, aws, manager);
        return result;
      } };
      await originals.processOriginalRestores({ firestore: db, storage, registry: new Map([[source.id, source]]), now: now + 60_001, log });
      expect(db.rows.get(jobKey())).toMatchObject({ active: true, phase: "requesting", deepArchiveApprovedBy: manager.uid });
      expect([...db.rows.values()].filter(row => row.outcome === "failed")).toHaveLength(0);
      await tick(db, aws, now + 17 * 60_000);
      expect(restores(aws).at(-1)[0].input.RestoreRequest).toEqual({ Days: 7, GlacierJobParameters: { Tier: "Standard" } });
    });
    it("lets a manager who joins that request approve its paid retry", async () => {
      const db = database(); const aws = sdk();
      aws.setRestoreError(new Error("connection lost"));
      await expect(restore(db, aws)).rejects.toThrow("connection lost");
      aws.setRestoreError(undefined); aws.setHead(deepArchive());
      await restore(db, aws, manager); await tick(db, aws);
      expect(restores(aws)).toHaveLength(2);
      expect(restores(aws)[1][0].input.RestoreRequest).toEqual({ Days: 7, GlacierJobParameters: { Tier: "Standard" } });
    });
  });
  it("rechecks the indexed version after storage work, so a replacement cannot receive stale state", async () => {
    const db = database(); const aws = sdk(); const send = aws.client.send;
    aws.client.send = async command => { const result = await send(command); db.rows.get("mediaSourceAssets/asset").objectVersionId = "replacement"; return result; };
    const storage = originals.createOriginalStorage(config, { client: aws.client });
    await expect(originals.refreshOriginal({ firestore: db, storage, source, asset: parsed(), now })).rejects.toMatchObject({ status: 409 });
    expect(db.rows.get(`${ORIGINAL_STATUS}/asset`)).toBeUndefined();
  });
  it("rejects an original-based export before admission while its master is archived", async () => {
    const db = database(); const aws = sdk(); const body = { sourceId: source.id, assetId: "asset", scope: "source", format: "prores_mov" };
    const value = db.rows.get("mediaSourceAssets/asset");
    const prefix = sourceMediaRenditionOutputPrefix({ id: "asset", ...value }, "viewing");
    value.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: value.objectKey,
      sourceObjectVersionId: value.objectVersionId, sourceSizeBytes: value.sizeBytes,
      attemptId: "viewing", updatedAt: new Date(now).toISOString(),
      web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 120 },
      poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster", sizeBytes: 50, mimeType: "image/jpeg" } };
    const handler = clipHandler("request", { firestore: db, registry: () => new Map([[source.id, source]]), originalStorage: aws.storage,
      requirePrincipal: async () => actor, verifyAppCheck: async () => {}, config: () => ({}), editorExportsEnabled: () => true });
    const res = response(); await handler(request(body), res);
    expect(res.code).toBe(409); expect(res.body.error).toContain("Restore original");
    expect([...db.rows.keys()].some(key => key.startsWith("mediaSourceClipJobs/"))).toBe(false);
  });
});

describe("durable restore completion and requester notices", () => {
  it("joins concurrent staff requests without another restore and notifies only the requesting accounts", async () => {
    const db = database(); const aws = sdk();
    await restore(db, aws); await restore(db, aws, { ...actor, uid: "other" });
    expect(aws.send.mock.calls.filter(([command]) => command.constructor.name === "RestoreObjectCommand")).toHaveLength(1);
    aws.setHead(head()); await tick(db, aws);
    expect((await readOriginalStatuses(db, [parsed(db.rows.get("mediaSourceAssets/asset"))])).get("asset").state).toBe("restored");
    expect(db.rows.get("mediaSourceAssets/asset")).toEqual(data());
    expect(db.rows.get("mediaSourceAssets/asset").version).toBe(4);
    expect([...db.rows.keys()].filter(key => key.startsWith("mediaSourceOriginalNotices/"))).toHaveLength(2);
    expect([...db.rows.values()].filter(row => row.outcome === "restored")).toHaveLength(2);
    expect(await tick(db, aws, now + 3_600_000)).toBe(0);
  });
  it("recovers a lost S3 response from the saved intent with the same exact version", async () => {
    const db = database(); const aws = sdk(); aws.setRestoreError(new Error("connection lost"));
    await expect(restore(db, aws)).rejects.toThrow("connection lost");
    expect(db.rows.get(`${originals.RESTORES}/${originals.restoreId(parsed())}`).phase).toBe("requesting");
    aws.setRestoreError(null); await tick(db, aws);
    expect(db.rows.get(`${originals.RESTORES}/${originals.restoreId(parsed())}`).phase).toBe("restoring");
    aws.setHead(head()); await tick(db, aws, now + originals.CHECK_MS + 60_002);
    expect(db.rows.get(`${ORIGINAL_STATUS}/asset`).state).toBe("restored");
  });
  it("does not mark a replaced file as restored and gives the requester a stale notice", async () => {
    const db = database(); const aws = sdk(); await restore(db, aws);
    db.rows.set("mediaSourceAssets/asset", { ...data(), objectVersionId: "replacement", version: 5 });
    aws.setHead(head()); await tick(db, aws);
    expect(db.rows.get("mediaSourceAssets/asset")).not.toHaveProperty("originalAvailability");
    expect([...db.rows.values()].find(row => row.outcome)?.outcome).toBe("stale");
  });
  it("bounds unresolved restore work to 72 hours and leaves a failure notice", async () => {
    const db = database(); const aws = sdk(); await restore(db, aws);
    aws.send.mockClear(); await tick(db, aws, now + 73 * 3_600_000);
    expect(aws.send).not.toHaveBeenCalled();
    expect([...db.rows.values()].find(row => row.outcome)?.outcome).toBe("failed");
    expect(await tick(db, aws, now + 74 * 3_600_000)).toBe(0);
  });
  it("keeps list, status, request and completion work off the asset/search stamp", async () => {
    const db = database(); const aws = sdk();
    await originals.refreshOriginal({ firestore: db, storage: aws.storage, source, asset: parsed(), fresh: true, now });
    expect(db.rows.get("mediaSourceAssets/asset")).toEqual(data());
    await restore(db, aws);
    expect(db.rows.get("mediaSourceAssets/asset")).toEqual(data());
    aws.setHead(head()); await tick(db, aws);
    expect(db.rows.get("mediaSourceAssets/asset")).toEqual(data());
    expect(sourceMediaAssetSummary(parsed())).not.toHaveProperty("original");
    expect(db.committedPaths).not.toContain("mediaSourceAssets/asset");
  });
  it("logs safe storage diagnostics without SDK bodies", async () => {
    const db = database(); const aws = sdk(Object.assign(new Error("private SDK body"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
    const logger = { error: vi.fn(), warn: vi.fn() };
    const handler = createOriginalHandler({ firestore: db, storage: aws.storage, registry: () => new Map([[source.id, source]]),
      requirePrincipal: async () => actor, verifyAppCheck: async () => {}, log: logger });
    const res = response(); await handler(request({ action: "status", sourceId: source.id, assetId: "asset" }), res);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ errorName: "AccessDenied", httpStatus: 403 });
    expect(JSON.stringify([res.body, logger.error.mock.calls])).not.toContain("private SDK body");
  });
  it("keeps application error locations without messages or raw stack data", async () => {
    const db = database(); const error = new TypeError("private runtime value");
    // Functions deploys this directory as the application root, without a functions/ segment.
    const appRoot = new URL("../../functions/", import.meta.url).pathname;
    error.stack = `TypeError: private runtime value\n    at list (${appRoot}source-media.js:120:9)\n    at https://private.example/signed?token=secret\n    at resolve (${appRoot}lib/media-asset-resolver.js:44:3)\n    at framework (${appRoot}node_modules/firebase-functions/lib/logger/index.js:20:3)`;
    const logger = { error: vi.fn(), warn: vi.fn() };
    const handler = createOriginalHandler({ firestore: db, storage: sdk(error).storage,
      registry: () => new Map([[source.id, source]]), requirePrincipal: async () => actor,
      verifyAppCheck: async () => {}, log: logger });
    const res = response(); await handler(request({ action: "status", sourceId: source.id, assetId: "asset" }), res);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ errorName: "TypeError",
      frames: ["source-media.js:120:9", "lib/media-asset-resolver.js:44:3"] });
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/private|secret|workspace/);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(appRoot);
  });
  it("caches bounded list status while a manual check gets current S3 state", async () => {
    const db = database(); const aws = sdk(head());
    await originals.refreshOriginal({ firestore: db, storage: aws.storage, source, asset: parsed(), now });
    aws.setHead(archived());
    expect((await originals.refreshOriginal({ firestore: db, storage: aws.storage, source,
      asset: parsed(db.rows.get("mediaSourceAssets/asset")), now: now + 1000 })).state).toBe("available");
    expect(aws.send).toHaveBeenCalledTimes(1);
    expect((await originals.refreshOriginal({ firestore: db, storage: aws.storage, source,
      asset: parsed(db.rows.get("mediaSourceAssets/asset")), now: now + 2000, fresh: true })).state).toBe("archived");
  });
  it("keeps notices private to the signed-in user and authorized source", async () => {
    const db = database(); const aws = sdk(); await restore(db, aws); aws.setHead(head()); await tick(db, aws);
    const handler = user => createOriginalHandler({ firestore: db, storage: aws.storage, registry: () => new Map([[source.id, source]]),
      requirePrincipal: async () => user, verifyAppCheck: async () => {}, log });
    const own = response(); await handler(actor)(request({ sourceId: source.id, action: "notices" }), own);
    const other = response(); await handler({ ...actor, uid: "other" })(request({ sourceId: source.id, action: "notices" }), other);
    expect(own.body.notices).toHaveLength(1); expect(other.body.notices).toHaveLength(0);
    const denied = response(); await handler({ ...actor, uid: "other" })(request({ sourceId: source.id, action: "dismiss", noticeId: own.body.notices[0].id }), denied);
    expect(denied.code).toBe(404);
  });
});
