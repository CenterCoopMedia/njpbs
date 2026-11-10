import { describe, expect, it } from "vitest";
import intake from "../../functions/ugc-intake.js";
import quota from "../../functions/lib/ugc-quota.js";

const NOW = 1_000_000;
const CUTOFF = NOW + 60 * 60 * 1000;
const record = { status: "uploading", quarantineKey: "ugc-quarantine/test/file",
  uploadExpiresAt: { toMillis: () => NOW }, file: { size: 500 } };

// Model the storage boundary's conditional writes. A delayed client PUT must
// satisfy If-None-Match against the state that exists when the write commits.
function bucket(initial = null) {
  let object = initial;
  return {
    head: async () => object,
    rejectUpload: async () => { object = { size: 0, quotaReleased: true }; },
    sealMissing: async () => {
      if (object) return false;
      object = { size: 0, quotaReleased: true };
      return true;
    },
    finishUpload: () => {
      if (object) return false;
      object = { size: 500 };
      return true;
    },
  };
}

describe("UGC quota reconciliation", () => {
  it("releases an abandoned empty reservation and prevents a late PUT from reopening it", async () => {
    const storage = bucket();
    expect(await quota.reconcileQuota(storage, record, CUTOFF)).toBe(0);
    expect(storage.finishUpload()).toBe(false);
    expect(await quota.reconcileQuota(storage, record, CUTOFF)).toBe(0);
  });

  it("keeps actual bytes charged when a client uploads but never completes", async () => {
    const storage = bucket({ size: 500 });
    expect(await quota.reconcileQuota(storage, record, CUTOFF)).toBe(500);
    expect(await storage.head()).toEqual({ size: 500 });
  });

  it("keeps the charge when an in-flight PUT wins the conditional write race", async () => {
    const storage = bucket();
    const seal = storage.sealMissing;
    storage.sealMissing = async () => { storage.finishUpload(); return seal(); };
    expect(await quota.reconcileQuota(storage, record, CUTOFF)).toBe(500);
  });

  it("does not fence a still-valid upload URL", async () => {
    const storage = bucket();
    expect(await quota.reconcileQuota(storage, record, NOW - 1)).toBeNull();
    expect(storage.finishUpload()).toBe(true);
  });

  it("allows a slow upload to finish during the hour after URL expiry", async () => {
    const storage = bucket();
    expect(await quota.reconcileQuota(storage, record, CUTOFF - 1)).toBeNull();
    expect(storage.finishUpload()).toBe(true);
    expect(await quota.reconcileQuota(storage, record, CUTOFF)).toBe(500);
  });

  it("fences a deleted rejection even while its old upload URL is valid", async () => {
    const storage = bucket();
    expect(await quota.reconcileQuota(storage, { ...record, status: "rejected" }, NOW - 1)).toBe(0);
    expect(storage.finishUpload()).toBe(false);
  });

  it.each(["pending", "imported"])("retains the verified size for %s records", async (status) => {
    expect(await quota.reconcileQuota(bucket(), { ...record, status, size: 500 }, NOW)).toBe(500);
  });

  it("fails closed on ambiguous storage and invalid size receipts", async () => {
    const failed = { head: async () => null, sealMissing: async () => { throw new Error("Storage unavailable"); } };
    await expect(quota.reconcileQuota(failed, record, CUTOFF)).rejects.toThrow("Storage unavailable");
    await expect(quota.reconcileQuota({ ...failed, sealMissing: async () => false }, record, CUTOFF))
      .rejects.toThrow("Upload outcome unavailable");
    await expect(quota.reconcileQuota(bucket({ size: NaN }), record, NOW)).rejects.toThrow("Invalid stored upload size");
  });
});

describe("UGC storage fence", () => {
  it("writes an empty marker with a one-write condition through the S3 adapter", async () => {
    let stored;
    const storage = intake.createUgcStorage({ bucket: "test-bucket", client: { send: async (command) => { stored = command.input; } } });
    expect(await storage.sealMissing(record.quarantineKey)).toBe(true);
    expect(stored).toEqual({ Bucket: "test-bucket", Key: record.quarantineKey, Body: Buffer.alloc(0),
      ContentLength: 0, IfNoneMatch: "*", Metadata: { "ugc-quota-released": "true" }, CacheControl: "no-store" });
  });

  it("distinguishes a competing write from a storage outage", async () => {
    for (const status of [412, 409, 503]) {
      const storage = intake.createUgcStorage({ bucket: "test-bucket", client: { send: async () => {
        throw Object.assign(new Error("Storage failure"), { $metadata: { httpStatusCode: status } });
      } } });
      if (status === 412) expect(await storage.sealMissing(record.quarantineKey)).toBe(false);
      else await expect(storage.sealMissing(record.quarantineKey)).rejects.toThrow("Storage failure");
    }
  });
});

describe("origin quota route", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const ipHash = "a".repeat(32);
  const request = (headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers },
    body: { requestId: id, submissionId: id, clientIpHash: ipHash } });
  const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const handlers = (storage, fields = {}) => intake.createUgcHandlers({
    firestore: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true,
      data: () => ({ ...record, clientIpHash: ipHash, ...fields }) }) }) }) },
    storage: () => storage, now: () => NOW,
  });

  it("returns measured bytes only to the internal reconciliation request with the bound IP", async () => {
    const handler = handlers(bucket({ size: 500 }));
    const res = response();
    await handler.complete(request({ "x-njpbs-quota-reconcile": "1" }), res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ quotaBytes: 500 });
    const foreign = request({ "x-njpbs-quota-reconcile": "1" });
    foreign.body.clientIpHash = "b".repeat(32);
    await expect(handler.complete(foreign, response())).rejects.toMatchObject({ code: "invalid" });
  });

  it("settles a staff-rejected upload from its verified size after quarantine deletion", async () => {
    const storage = {
      head: async () => { throw new Error("Deleted quarantine key must not be read"); },
      sealMissing: async () => { throw new Error("Deleted quarantine key must not be fenced"); },
    };
    const res = response();
    await handlers(storage, { status: "rejected", quarantineKey: undefined, size: 500 })
      .complete(request({ "x-njpbs-quota-reconcile": "1" }), res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ quotaBytes: 500 });
    await expect(handlers(storage, { status: "rejected", quarantineKey: undefined })
      .complete(request({ "x-njpbs-quota-reconcile": "1" }), response()))
      .rejects.toThrow("Missing verified upload size");
  });

  it("keeps an expired fence when completion or rejection is replayed", async () => {
    for (const status of ["uploading", "rejected"]) {
      const storage = bucket({ size: 0, quotaReleased: true });
      storage.delete = async () => { throw new Error("Fence must remain"); };
      await expect(handlers(storage, { status, rejectionReason: "file_check" }).complete(request(), response()))
        .rejects.toMatchObject({ code: status === "uploading" ? "expired" : "rejected_file" });
      expect(storage.finishUpload()).toBe(false);
    }
  });
});
