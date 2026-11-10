import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import exportJobs from "../../functions/lib/video-orientation-export.js";
import worker from "../../functions/lib/video-transcript-worker.js";
import handlers from "../../functions/video-transcript-worker.js";
import uploads from "../../functions/source-media-uploads.js";
import staff from "../../functions/video-orientation-exports.js";

const now = 1_800_000_000_000;
const source = { id: "video-library", bucket: "originals", prefix: "" };
const actor = { uid: "staff", email: "staff@example.test" };
const sha256 = "b".repeat(64);
const checksum = Buffer.from(sha256, "hex").toString("base64");

function store() {
  const web = { objectKey: "outputs/asset/web.mp4", objectVersionId: "web1", sizeBytes: 50, durationSeconds: 30, mimeType: "video/mp4" };
  const asset = { id: "asset", sourceId: source.id, lifecycle: "active", kind: "video", name: "Board meeting",
    originalName: "board-meeting.mov", description: "Full meeting", license: null, credit: "NJ PBS", tags: ["board"],
    rightsStatus: "complete", objectKey: "objects/asset.mov", objectVersionId: "v1", sizeBytes: 100,
    rendition: { state: "ready", web } };
  const rows = new Map([["mediaSourceAssets/asset", asset],
    ["mediaSourceStats/video-library", { exact: true, activeCount: 4 }]]);
  let tail = Promise.resolve();
  let generated = 0;
  const ref = (collection, name = `auto-${++generated}`) => {
    const value = { path: `${collection}/${name}`, id: name };
    return { ...value, get: async () => snapshot(value), set: async (data) => { rows.set(value.path, structuredClone(data)); },
      create: async (data) => { if (rows.has(value.path)) throw new Error("exists"); rows.set(value.path, structuredClone(data)); } };
  };
  const snapshot = (r) => ({ id: r.id, ref: r, exists: rows.has(r.path), data: () => structuredClone(rows.get(r.path)) });
  const collection = (name, filters = [], order = null, max = Infinity) => ({ doc: (key) => ref(name, key),
    where: (key, op, value) => collection(name, [...filters, [key, op, value]], order, max),
    orderBy: (key, direction = "asc") => collection(name, filters, [key, direction], max),
    limit: (count) => collection(name, filters, order, count),
    get: async () => {
      const matches = [...rows].filter(([path, value]) => path.startsWith(`${name}/`) &&
        filters.every(([key, op, v]) => (op === "<=" ? value[key] <= v : value[key] === v)));
      if (order) {
        const [key, direction] = order;
        matches.sort(([, a], [, b]) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === "desc" ? -1 : 1));
      }
      const docs = matches.slice(0, max).map(([path]) => snapshot({ path, id: path.split("/").at(-1) }));
      return { docs, size: docs.length };
    } });
  const firestore = { collection, runTransaction: (fn) => {
    const run = tail.then(async () => {
      const writes = [];
      let wrote = false;
      const write = (fn) => { wrote = true; writes.push(fn); };
      const result = await fn({
        get: async (r) => { if (wrote) throw new Error("Transaction read after write"); return r.path ? snapshot(r) : r.get(); },
        update: (r, data) => write(() => rows.set(r.path, { ...rows.get(r.path), ...structuredClone(data) })),
        set: (r, data) => write(() => rows.set(r.path, structuredClone(data))),
        create: (r, data) => write(() => { if (rows.has(r.path)) throw new Error("exists"); rows.set(r.path, structuredClone(data)); }),
        delete: (r) => write(() => rows.delete(r.path)),
      });
      writes.forEach((apply) => apply());
      return result;
    });
    tail = run.catch(() => {});
    return run;
  } };
  const all = (prefix) => [...rows].filter(([path]) => path.startsWith(prefix)).map(([, value]) => value);
  return { rows, firestore, source, all };
}

const request = (orientation = "vertical") => ({ sourceId: "video-library", assetId: "asset", orientation });

async function claimed(s, orientation) {
  const { job } = await exportJobs.requestExport({ firestore: s.firestore, request: request(orientation), actor, now });
  const lease = await exportJobs.claimExportJob({ firestore: s.firestore, now });
  return { job, lease, identity: { kind: "orientation", jobId: job.id, leaseToken: lease.leaseToken } };
}

function completion(s, identity, uploaded, overrides = {}) {
  const uploader = { signPut: vi.fn(async () => ({ url: "https://upload.example/objects/x.mp4" })),
    head: vi.fn(async (_source, session) => ({ VersionId: "out-v1", ContentLength: session.sizeBytes, ChecksumSHA256: checksum,
      Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId } })) };
  const args = { firestore: s.firestore, source, now, clock: () => now, uploader, objectKeyFn: uploads.objectKey,
    assertBillingEnabled: async () => {},
    completedAssetFn: uploads.completedAsset, ...overrides,
    request: { ...identity, engine: exportJobs.ENGINE, output: { sizeBytes: 4000, sha256 }, uploaded } };
  return { args, uploader };
}

describe("orientation export jobs", () => {
  it("saves a rendered export as a new library video linked to its source", async () => {
    const s = store();
    const { job, identity } = await claimed(s, "vertical");
    const reserve = completion(s, identity, false);
    expect(await exportJobs.completeExportJob(reserve.args)).toMatchObject({ completed: false,
      upload: { url: "https://upload.example/objects/x.mp4" } });
    expect(reserve.uploader.signPut.mock.calls[0][1]).toMatchObject({ id: job.id, assetId: job.outputAssetId,
      objectKey: `objects/${job.outputAssetId}.mp4`, sizeBytes: 4000, checksumSha256: checksum, mimeType: "video/mp4" });

    const confirm = completion(s, identity, true);
    expect(await exportJobs.completeExportJob(confirm.args)).toEqual({ completed: true, outputAssetId: job.outputAssetId });
    const output = s.rows.get(`mediaSourceAssets/${job.outputAssetId}`);
    expect(output).toMatchObject({ kind: "video", lifecycle: "active", name: "Board meeting (vertical)",
      originalName: "board-meeting-vertical.mp4", mimeType: "video/mp4", preview: "browser", sizeBytes: 4000,
      objectKey: `objects/${job.outputAssetId}.mp4`, objectVersionId: "out-v1", credit: "NJ PBS", tags: ["board"],
      rightsStatus: "complete", parentSource: { sourceId: "video-library", assetId: "asset" }, createdBy: "staff",
      rendition: { state: "processing" } });
    expect(s.all("mediaSourcePreviewJobs/")).toEqual([expect.objectContaining({ phase: "consumed", active: false }),
      expect.objectContaining({ assetId: job.outputAssetId, active: true })]);
    expect(s.rows.get("mediaSourceStats/video-library").activeCount).toBe(5);
    expect(s.rows.get(`${exportJobs.EXPORTS}/${job.id}`)).toMatchObject({ phase: "complete", active: false });
    expect(s.rows.get(`${worker.WORKERS}/${worker.WORKER_ID}`)).toMatchObject({ kind: null, jobId: null });

    // A lost confirmation response is answered from the stored result.
    expect(await exportJobs.completeExportJob(completion(s, identity, true).args))
      .toEqual({ completed: true, outputAssetId: job.outputAssetId });
    expect(s.all("mediaSourceAssets/")).toHaveLength(2);
  });

  it("waits for viewing-copy capacity before issuing the upload", async () => {
    const s = store();
    for (let index = 0; index < 20; index += 1) s.rows.set(`mediaSourcePreviewJobs/busy-${index}`, { active: true, actorUid: "other" });
    const { job, identity } = await claimed(s, "vertical");
    const reserve = completion(s, identity, false);
    expect(await exportJobs.completeExportJob(reserve.args)).toEqual({ completed: false, retryAfterSeconds: 60 });
    expect(reserve.uploader.signPut).not.toHaveBeenCalled();
    for (let index = 0; index < 20; index += 1) s.rows.delete(`mediaSourcePreviewJobs/busy-${index}`);
    expect(await exportJobs.completeExportJob(completion(s, identity, false).args)).toMatchObject({ completed: false, upload: {} });
    const hold = `mediaSourcePreviewJobs/hold-${job.id}`;
    expect(s.rows.get(hold)).toMatchObject({ active: true, phase: "reserved", actorUid: "staff" });
    // One address per export: a second request would move the deadline.
    await expect(exportJobs.completeExportJob(completion(s, identity, false).args)).rejects.toMatchObject({ status: 409 });
  });

  it("stops before upload or video creation while billing is stopped", async () => {
    const s = store();
    const { identity } = await claimed(s, "vertical");
    const stopped = async () => { throw Object.assign(new Error("Billing is stopped"), { status: 503 }); };
    const reserve = completion(s, identity, false, { assertBillingEnabled: stopped });
    await expect(exportJobs.completeExportJob(reserve.args)).rejects.toMatchObject({ status: 503 });
    expect(reserve.uploader.signPut).not.toHaveBeenCalled();
    await exportJobs.completeExportJob(completion(s, identity, false).args);
    const confirm = completion(s, identity, true, { assertBillingEnabled: stopped });
    await expect(exportJobs.completeExportJob(confirm.args)).rejects.toMatchObject({ status: 503 });
    expect(confirm.uploader.head).not.toHaveBeenCalled();
    expect(s.all("mediaSourceAssets/")).toHaveLength(1);
  });

  it("finishes an export whose source changes after its upload address is issued", async () => {
    const s = store();
    const { job, identity } = await claimed(s, "vertical");
    await exportJobs.completeExportJob(completion(s, identity, false).args);
    s.rows.get("mediaSourceAssets/asset").lifecycle = "deleted";
    expect(await exportJobs.completeExportJob(completion(s, identity, true).args))
      .toEqual({ completed: true, outputAssetId: job.outputAssetId });
    expect(s.rows.get(`mediaSourceAssets/${job.outputAssetId}`)).toMatchObject({ name: "Board meeting (vertical)",
      parentSource: { sourceId: "video-library", assetId: "asset" } });
  });

  it("keeps an issued upload with its worker until the deadline without holding the slot", async () => {
    const s = store();
    const { job, identity } = await claimed(s, "vertical");
    await exportJobs.completeExportJob(completion(s, identity, false).args);
    const deadline = now + 2 * 3600 * 1000;
    // The worker's lease and slot lapse; the waiting export blocks no newer claim.
    const before = deadline - 1;
    const other = await exportJobs.requestExport({ firestore: s.firestore, request: request("horizontal"), actor, now: before });
    expect(await exportJobs.claimExportJob({ firestore: s.firestore, now: before })).toMatchObject({ id: other.job.id });
    expect(s.rows.get(`${exportJobs.EXPORTS}/${job.id}`)).toMatchObject({ phase: "running", uploadIssued: true });
    expect(exportJobs.publicExport(s.rows.get(`${exportJobs.EXPORTS}/${job.id}`)).state).toBe("finishing_upload");
    // The worker still owns the job and can confirm before the deadline.
    expect(await exportJobs.completeExportJob(completion(s, identity, true, { now: before, clock: () => before }).args))
      .toEqual({ completed: true, outputAssetId: job.outputAssetId });
    expect(s.rows.get(`${worker.WORKERS}/${worker.WORKER_ID}`)).toMatchObject({ jobId: other.job.id });
  });

  it("adopts a stored upload once the deadline passes", async () => {
    const s = store();
    const { job, identity } = await claimed(s, "vertical");
    await exportJobs.completeExportJob(completion(s, identity, false).args);
    const deadline = now + 2 * 3600 * 1000;
    expect(await exportJobs.claimExportJob({ firestore: s.firestore, now: deadline - 1 })).toBeNull();
    const lease = await exportJobs.claimExportJob({ firestore: s.firestore, now: deadline });
    expect(lease).toMatchObject({ id: job.id, uploadIssued: true, attempt: 1 });
    const { args } = completion(s, { kind: "orientation", jobId: job.id, leaseToken: lease.leaseToken }, true,
      { now: deadline, clock: () => deadline });
    expect(await exportJobs.settleIssuedUpload(args)).toBe("complete");
    expect(s.rows.get(`mediaSourceAssets/${job.outputAssetId}`)).toMatchObject({ objectVersionId: "out-v1" });
    expect(s.rows.get(`${exportJobs.EXPORTS}/${job.id}`)).toMatchObject({ phase: "complete" });
  });

  it("fails once at the deadline when no upload was stored", async () => {
    const s = store();
    const { job, identity } = await claimed(s, "vertical");
    await exportJobs.completeExportJob(completion(s, identity, false).args);
    const deadline = now + 2 * 3600 * 1000;
    const lease = await exportJobs.claimExportJob({ firestore: s.firestore, now: deadline });
    const missing = { head: vi.fn(async () => { throw Object.assign(new Error("missing"), { name: "NotFound" }); }) };
    const { args } = completion(s, { kind: "orientation", jobId: job.id, leaseToken: lease.leaseToken }, true,
      { uploader: missing, now: deadline, clock: () => deadline });
    expect(await exportJobs.settleIssuedUpload(args)).toBe("failed");
    expect(missing.head).toHaveBeenCalledTimes(1);
    expect(s.rows.get(`${exportJobs.EXPORTS}/${job.id}`)).toMatchObject({ phase: "failed", active: false,
      errorCode: "export_upload_failed" });
    expect(s.rows.get(`mediaSourcePreviewJobs/hold-${job.id}`)).toMatchObject({ active: false, phase: "released" });
    // The worker's own token no longer owns the job after the deadline.
    await expect(exportJobs.completeExportJob(completion(s, identity, true, { now: deadline, clock: () => deadline }).args))
      .rejects.toMatchObject({ status: 409 });
    expect(await exportJobs.claimExportJob({ firestore: s.firestore, now: deadline })).toBeNull();
  });

  it("claims queued exports behind exports that wait on their uploads", async () => {
    const s = store();
    for (let index = 0; index < 5; index += 1) {
      s.rows.set(`${exportJobs.EXPORTS}/waiting-${index}`, { id: `waiting-${index}`, active: true, uploadIssued: true,
        uploadDeadline: now + 60_000, createdAt: "2026-01-01T00:00:00.000Z", assetId: "asset", attempt: 1 });
    }
    const { job } = await exportJobs.requestExport({ firestore: s.firestore, request: request("vertical"), actor, now });
    expect(await exportJobs.claimExportJob({ firestore: s.firestore, now })).toMatchObject({ id: job.id });
  });

  it("refuses a confirmation whose upload does not carry the reserved checksum", async () => {
    const s = store();
    const { identity } = await claimed(s, "horizontal");
    await exportJobs.completeExportJob(completion(s, identity, false).args);
    const confirm = completion(s, identity, true);
    confirm.uploader.head.mockResolvedValueOnce({ VersionId: "x", ChecksumSHA256: "other" });
    await expect(exportJobs.completeExportJob(confirm.args)).rejects.toMatchObject({ status: 409 });
    expect(s.all("mediaSourceAssets/")).toHaveLength(1);
  });

  it("returns the existing export until it fails or its video is deleted", async () => {
    const s = store();
    const first = await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    const again = await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    expect(again).toMatchObject({ cached: true, job: { id: first.job.id } });
    const other = await exportJobs.requestExport({ firestore: s.firestore, request: request("horizontal"), actor, now });
    expect(other.job.id).not.toBe(first.job.id);

    const lease = await exportJobs.claimExportJob({ firestore: s.firestore, now });
    await exportJobs.failExportJob({ firestore: s.firestore, now,
      request: { kind: "orientation", jobId: lease.id, leaseToken: lease.leaseToken, errorCode: "export_upload_failed" } });
    const retry = await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    expect(retry).toMatchObject({ cached: false, job: { phase: "queued" } });

    s.rows.set(`${exportJobs.EXPORTS}/${first.job.id}`, { ...retry.job, phase: "complete", active: false });
    s.rows.set(`mediaSourceAssets/${first.job.outputAssetId}`, { lifecycle: "deleted" });
    const replacement = await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    expect(replacement.job.outputAssetId).not.toBe(first.job.outputAssetId);
  });

  it("refuses an orientation that is not a plain string", () => {
    const base = { sourceId: "video-library", assetId: "asset-1" };
    expect(exportJobs.parseExportRequest({ ...base, orientation: "vertical" })).toMatchObject({ orientation: "vertical" });
    for (const orientation of [["vertical"], [["horizontal"]], "toString"]) {
      expect(() => exportJobs.parseExportRequest({ ...base, orientation })).toThrow("Video export request is invalid");
    }
  });

  it("lists only exports of the current file", async () => {
    const s = store();
    await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    expect((await exportJobs.listExports({ firestore: s.firestore, request: { sourceId: "video-library", assetId: "asset" } })).exports)
      .toEqual([expect.objectContaining({ orientation: "vertical", state: "queued" })]);
    s.rows.get("mediaSourceAssets/asset").objectVersionId = "v2";
    expect((await exportJobs.listExports({ firestore: s.firestore, request: { sourceId: "video-library", assetId: "asset" } })).exports).toEqual([]);
  });

  it("needs a ready viewing copy of one hour or less and 2 GB or less", async () => {
    const s = store();
    s.rows.get("mediaSourceAssets/asset").rendition.web.sizeBytes = 2_000_000_001;
    await expect(exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now }))
      .rejects.toMatchObject({ status: 409 });
    s.rows.get("mediaSourceAssets/asset").rendition.web.sizeBytes = 50;
    s.rows.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 3601;
    await expect(exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now }))
      .rejects.toMatchObject({ status: 409 });
    s.rows.get("mediaSourceAssets/asset").rendition.state = "processing";
    await expect(exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("retires a queued export when the source video changes", async () => {
    const s = store();
    const { job } = await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    s.rows.get("mediaSourceAssets/asset").objectVersionId = "v2";
    expect(await exportJobs.claimExportJob({ firestore: s.firestore, now })).toBeNull();
    expect(s.rows.get(`${exportJobs.EXPORTS}/${job.id}`)).toMatchObject({ phase: "stale", active: false });
  });

  it("shares the worker slot with transcription in both directions", async () => {
    const s = store();
    await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    s.rows.set(`${worker.WORKERS}/${worker.WORKER_ID}`, { kind: "transcription", jobId: "t", leaseUntil: now + 1000 });
    expect(await exportJobs.claimExportJob({ firestore: s.firestore, now })).toBeNull();
    s.rows.set(`${worker.WORKERS}/${worker.WORKER_ID}`, { kind: null, jobId: null, leaseUntil: 0 });
    const lease = await exportJobs.claimExportJob({ firestore: s.firestore, now });
    expect(await worker.claimLocalJob({ firestore: s.firestore, source, now })).toBeNull();
    // A restarted worker gets its leased export back.
    expect(await exportJobs.claimExportJob({ firestore: s.firestore, now: now + 1 })).toMatchObject({ leaseToken: lease.leaseToken });
  });
});

describe("orientation export broker routes", () => {
  const token = "t".repeat(48);
  const readAuth = async () => ({ enabled: true, workerId: worker.WORKER_ID,
    tokenSha256: createHash("sha256").update(token).digest("hex") });
  const config = { enabled: false, bucket: "renditions", accountId: "1",
    controlRoleArn: "role", source };
  const response = () => ({ set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const req = (body) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });

  it("hands exports only to a worker that asks for them", async () => {
    const s = store();
    await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    const processor = { signVideoInput: vi.fn(async () => ({ url: "https://input.example", versionId: "web1", sizeBytes: 50 })) };
    const deps = { firestore: s.firestore, readAuth, configFn: () => config, processor, clock: () => now,
      assertBillingEnabledFn: async () => {} };
    const legacy = response();
    await handlers.createWorkerHandler("claim", deps)(req({}), legacy);
    expect(legacy.body).toMatchObject({ success: true, job: null });
    const current = response();
    await handlers.createWorkerHandler("claim", deps)(req({ capabilities: ["orientation"] }), current);
    expect(current.body.job).toMatchObject({ kind: "orientation", engine: exportJobs.ENGINE, orientation: "vertical",
      width: 1080, height: 1920, durationSeconds: 30, input: { url: "https://input.example" } });
    expect(processor.signVideoInput).toHaveBeenCalledWith(expect.objectContaining({ objectKey: "outputs/asset/web.mp4" }));
    expect((await exportJobs.listExports({ firestore: s.firestore, now,
      request: { sourceId: "video-library", assetId: "asset" } })).workerReady).toBe(true);
  });

  it("ends a reported upload failure at once and checks its upload key once at the deadline", async () => {
    const s = store();
    const { job, identity } = await claimed(s, "vertical");
    await exportJobs.completeExportJob(completion(s, identity, false).args);
    const deps = (at, uploader) => ({ firestore: s.firestore, readAuth, configFn: () => config, uploader, clock: () => at,
      processor: { signVideoInput: vi.fn() }, assertBillingEnabledFn: async () => {} });
    const res = response();
    await handlers.createWorkerHandler("fail", deps(now))(req({ ...identity, errorCode: "export_upload_failed" }), res);
    expect(res.body).toEqual({ success: true, completed: true });
    expect(exportJobs.publicExport(s.rows.get(`${exportJobs.EXPORTS}/${job.id}`))).toMatchObject({ state: "failed" });
    expect(s.rows.get(`mediaSourcePreviewJobs/hold-${job.id}`)).toMatchObject({ active: false, phase: "released" });
    expect(s.rows.get(`${worker.WORKERS}/${worker.WORKER_ID}`)).toMatchObject({ kind: null, jobId: null });
    // Staff can export again at once; the new export uploads to a new key.
    const retry = await exportJobs.requestExport({ firestore: s.firestore, request: request(), actor, now });
    expect(retry).toMatchObject({ cached: false, job: { phase: "queued" } });
    expect(retry.job.outputAssetId).not.toBe(job.outputAssetId);

    // The stray check waits for the deadline, then looks once and records a late file.
    const deadline = now + 2 * 3600 * 1000;
    const stored = completion(s, identity, true).uploader;
    const claim = (at) => handlers.createWorkerHandler("claim", deps(at, stored))(req({ capabilities: ["orientation"] }), response());
    s.rows.set(`${worker.WORKERS}/${worker.WORKER_ID}`, { kind: "transcription", jobId: "t", leaseUntil: deadline + 60_000 });
    await claim(deadline - 1);
    expect(stored.head).not.toHaveBeenCalled();
    // A failed storage check keeps the record for the next claim.
    stored.head.mockRejectedValueOnce(new Error("storage unavailable"));
    await claim(deadline);
    expect(s.all(`${exportJobs.STRAYS}/`)).toHaveLength(1);
    await claim(deadline + 1);
    await claim(deadline + 2);
    expect(stored.head).toHaveBeenCalledTimes(2);
    expect(stored.head.mock.calls[0][1]).toMatchObject({ objectKey: `objects/${job.outputAssetId}.mp4` });
    expect(s.all("admin_logs/").filter((entry) => entry.action === "media.video.export.stray"))
      .toEqual([expect.objectContaining({ target: `objects/${job.outputAssetId}.mp4` })]);
    expect(s.all(`${exportJobs.STRAYS}/`)).toEqual([]);
    expect(s.all("mediaSourceAssets/")).toHaveLength(1);
  });

  it("refuses export calls when the video storage is not configured", async () => {
    const res = response();
    await handlers.createWorkerHandler("heartbeat", { readAuth, configFn: () => ({ ...config, bucket: "" }) })(
      req({ kind: "orientation", jobId: "e".repeat(64), leaseToken: "12345678-1234-1234-1234-123456789abc", stage: "rendering" }), res);
    expect(res.code).toBe(503);
  });
});

describe("orientation export staff routes", () => {
  const response = () => ({ set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const call = async (operation, body, overrides = {}) => {
    const s = store();
    const authorizeFn = vi.fn(async () => true);
    const res = response();
    await staff.createExportHandler(operation, { firestore: s.firestore, verifyAppCheckFn: async () => {},
      requirePrincipalFn: async () => actor, registryFn: () => new Map([["video-library", source]]),
      authorizeFn, audit: (entry) => entry, ...overrides })(
      { method: "POST", headers: { "content-type": "application/json" }, body }, res);
    return { res, authorizeFn };
  };

  it("needs upload access to export and browse access to read status", async () => {
    const requested = await call("request", request());
    expect(requested.res.code).toBe(200);
    expect(requested.res.body.export).toMatchObject({ orientation: "vertical", state: "queued", outputAssetId: null });
    expect(requested.authorizeFn).toHaveBeenCalledWith(expect.objectContaining({ operation: "upload" }));
    const listed = await call("list", { sourceId: "video-library", assetId: "asset" });
    expect(listed.authorizeFn).toHaveBeenCalledWith(expect.objectContaining({ operation: "browse" }));
  });

  it("reports a media worker that has not checked in", async () => {
    const { res } = await call("list", { sourceId: "video-library", assetId: "asset" });
    expect(res.body).toEqual({ success: true, exports: [], workerReady: false });
  });
});
