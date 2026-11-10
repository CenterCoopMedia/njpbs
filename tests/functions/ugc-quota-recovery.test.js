import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import { ugcBucket } from "../helpers/ugc-r2.js";
import intake from "../../functions/ugc-intake.js";
import contract from "../../functions/lib/ugc-contract.js";
import { applyLimit, initializeLimiter, DAY_MS, COMPLETION_LEASE_MS } from "../../site/share-intake/rate-limit.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const BYTES = 500 * 1024 * 1024;
const ipHash = "a".repeat(32);
const texts = Object.fromEntries(contract.CONSENT_TEXT_FIELDS.map((field) => [field, `${field} text`]));
const config = { consentVersion: "test-v1", approvedBy: "test-reviewer", approvedAt: new Date(NOW), texts };
const request = (body, reconcile = false) => ({ method: "POST",
  headers: { "content-type": "application/json", ...(reconcile ? { "x-njpbs-quota-reconcile": "1" } : {}) }, body });
const response = () => ({ set() { return this; }, status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; } });
let firestore;
let sqlite;
let sql;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Firestore emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  firestore = admin.firestore();
});
beforeEach(async () => {
  await firestore.recursiveDelete(firestore.collection("ugcSubmissions"));
  await firestore.collection("ugcConfig").doc("current").set(config);
  sqlite = new DatabaseSync(":memory:");
  sql = { exec(query, ...bindings) {
    const statement = sqlite.prepare(query);
    return statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
  } };
  initializeLimiter(sql);
});
afterEach(() => sqlite?.close());

async function accepted() {
  const bucket = ugcBucket();
  let now = NOW;
  const handlers = intake.createUgcHandlers({ firestore, storage: () => bucket.storage, now: () => now });
  const id = randomUUID();
  const body = { requestId: id, name: "Test submitter", email: "submitter@example.test",
    message: "A synthetic upload for quota recovery.", consentChecked: true, ageAttested: true,
    consentVersion: config.consentVersion, consentTextHash: contract.consentTextHash(texts.release),
    clientIpHash: ipHash, file: { name: "test.mp4", type: "video/mp4", size: BYTES } };
  const binding = { requestId: id, submissionId: id, ipHash };
  expect(applyLimit(sql, { action: "reserve", ...binding, bytes: BYTES, now }).allowed).toBe(true);
  await handlers.start(request(body), response());
  expect(applyLimit(sql, { action: "accept", ...binding, now }).allowed).toBe(true);
  const ref = firestore.collection("ugcSubmissions").doc(id);
  const key = (await ref.get()).data().quarantineKey;
  return { ...bucket, handlers, body, binding, ref, key,
    advance(value) { now = value; },
    complete(reconcile = true) { return request({ requestId: id, submissionId: id, clientIpHash: ipHash }, reconcile); } };
}

function settle(f, now, bytes) {
  const claim = applyLimit(sql, { action: "claim_reconcile", ...f.binding, now });
  expect(claim.allowed).toBe(true);
  expect(applyLimit(sql, { action: "reconcile", ...f.binding, now,
    leaseUntil: claim.reconciliation.leaseUntil, bytes }).allowed).toBe(true);
}

describe("quota recovery with Firestore and the real storage adapter", () => {
  it.each([0, BYTES])("settles %i bytes after parent TTL deletion without deleting the storage binding", async (bytes) => {
    const f = await accepted();
    const evidence = (await f.ref.collection("quota").doc("storage").get()).data();
    expect(evidence).toEqual({ quarantineKey: f.key, clientIpHash: ipHash, uploadExpiresAtMs: NOW + 15 * 60 * 1000 });
    if (bytes) f.objects.set(f.key, { ContentLength: bytes, ETag: '"uploaded"' });
    await f.ref.delete(); // Firestore TTL's parent-only deletion semantics.
    const now = NOW + 91 * DAY_MS;
    f.advance(now);
    const res = response();
    await f.handlers.complete(f.complete(), res);
    expect(res.body).toEqual({ quotaBytes: bytes });
    settle(f, now, res.body.quotaBytes);
    expect([...sql.exec("SELECT bytes, charged_at FROM starts")]).toEqual([{ bytes, charged_at: now }]);
    await expect(f.client.send(new PutObjectCommand({ Key: f.key, ContentLength: BYTES, IfNoneMatch: "*" })))
      .rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    await expect(f.handlers.start(request(f.body), response())).rejects.toMatchObject({ code: "invalid" });
    await expect(f.handlers.complete(f.complete(false), response())).rejects.toMatchObject({ code: "missing_upload" });
  });

  it("keeps the IP binding after TTL and ignores caller-supplied storage keys", async () => {
    const f = await accepted();
    await f.ref.delete();
    f.advance(NOW + 91 * DAY_MS);
    const req = f.complete();
    req.body.clientIpHash = "b".repeat(32);
    req.body.quarantineKey = "unrelated-key";
    await expect(f.handlers.complete(req, response())).rejects.toMatchObject({ code: "invalid" });
    expect(f.objects.size).toBe(0);
  });

  it("does not release an old reservation when both origin and trusted binding are missing", async () => {
    const f = await accepted();
    await firestore.recursiveDelete(f.ref);
    f.advance(NOW + 91 * DAY_MS);
    await expect(f.handlers.complete(f.complete(), response())).rejects.toMatchObject({ code: "missing_upload" });
    expect([...sql.exec("SELECT bytes, charged_at FROM starts")]).toEqual([{ bytes: BYTES, charged_at: null }]);
    expect(f.objects.size).toBe(0);
  });

  it.each(["head", "fence", "lost-fence-receipt", "lost-race"])("retains capacity on %s uncertainty after TTL, then safely retries", async (failure) => {
    const f = await accepted();
    await f.ref.delete();
    const now = NOW + 91 * DAY_MS;
    f.advance(now);
    const claim = applyLimit(sql, { action: "claim_reconcile", ...f.binding, now });
    f.hooks.beforeSend = async (command) => {
      if (failure === "head" || failure === "fence" && command.constructor.name === "PutObjectCommand") throw new Error("Storage unavailable");
      if (failure === "lost-race" && command.constructor.name === "PutObjectCommand") {
        throw Object.assign(new Error("Competing upload"), { $metadata: { httpStatusCode: 412 } });
      }
    };
    f.hooks.afterSend = async (command) => {
      if (failure === "lost-fence-receipt" && command.constructor.name === "PutObjectCommand") throw new Error("Lost response");
    };
    await expect(f.handlers.complete(f.complete(), response())).rejects.toThrow();
    expect([...sql.exec("SELECT bytes, charged_at FROM starts")]).toEqual([{ bytes: BYTES, charged_at: null }]);
    expect(applyLimit(sql, { action: "claim_complete", ...f.binding, now }).allowed).toBe(false);
    f.hooks.beforeSend = null;
    f.hooks.afterSend = null;
    f.advance(now + COMPLETION_LEASE_MS);
    const res = response();
    await f.handlers.complete(f.complete(), res);
    expect(res.body.quotaBytes).toBe(0);
    expect(applyLimit(sql, { action: "reconcile", ...f.binding, now: now + COMPLETION_LEASE_MS,
      leaseUntil: claim.reconciliation.leaseUntil, bytes: 0 }).allowed).toBe(false);
    settle(f, now + COMPLETION_LEASE_MS, 0);
  });

  it("charges a late conditional PUT that wins the fence race after parent expiry", async () => {
    const f = await accepted();
    await f.ref.delete();
    f.advance(NOW + 91 * DAY_MS);
    f.hooks.beforeSend = async (command) => {
      if (command.constructor.name === "PutObjectCommand") f.objects.set(f.key, { ContentLength: BYTES, ETag: '"late"' });
    };
    const res = response();
    await f.handlers.complete(f.complete(), res);
    expect(res.body.quotaBytes).toBe(BYTES);
    settle(f, NOW + 91 * DAY_MS, BYTES);
  });
});
