import { createRequire } from "node:module";
import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { reader } from "../helpers/cms-preview-pairs.js";
const require = createRequire(import.meta.url);
const api = require("../../functions/lib/cms-reader-session.js");
const pairs = require("../../functions/lib/cms-preview-pair.js");
const { digest } = pairs;
const operator = require("../../scripts/cms-reader-session-history.cjs");
const db = isolatedFirestore("cms-reader-session");
const now = Date.now(), liveReader = reader("cmsApi", now), readerDigest = api.readerSessionDigest(liveReader);
const input = { reader: liveReader, principalId: "staff", sessionId: "11111111-1111-4111-8111-111111111111", ttlMs: 60_000 };
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});
it("retains old Admin sessions through the boundary and rejects their exact expiry", async () => {
  const lease = await api.openSession(db, input, now);
  await api.closeReader(db, readerDigest);
  const identity = { sessionId: lease.sessionId, principalId: input.principalId, readerDigest };
  expect(await api.assertSession(db, identity, lease.expiresAt - 1)).toEqual(lease);
  await expect(api.assertReaderExpired(db, readerDigest, lease.expiresAt - 1)).rejects.toThrow("old Admin sessions");
  await expect(api.assertSession(db, identity, lease.expiresAt)).rejects.toThrow("expired");
  expect(await api.assertReaderExpired(db, readerDigest, lease.expiresAt)).toEqual({ readerDigest, maxExpiresAt: lease.expiresAt });
  await expect(api.openSession(db, { ...input, sessionId: "22222222-2222-4222-8222-222222222222" }, now + 1)).rejects.toThrow("no longer issues");
});
it("session retries cannot extend the lifetime, change the principal or use another reader", async () => {
  const lease = await api.openSession(db, input, now);
  expect(await api.openSession(db, input, now + 500)).toEqual(lease);
  await expect(api.openSession(db, { ...input, principalId: "other" }, now)).rejects.toThrow();
  await expect(api.assertSession(db, { sessionId: lease.sessionId, principalId: "other", readerDigest }, now)).rejects.toThrow();
  await expect(api.assertSession(db, { sessionId: lease.sessionId, principalId: "staff", readerDigest: "a".repeat(64) }, now)).rejects.toThrow();
  await expect(api.openSession(db, { ...input, ttlMs: api.MAX_SESSION_MS + 1 }, now)).rejects.toThrow();
});
it("closing a reader races issuance on the same durable window", async () => {
  const results = await Promise.allSettled([api.openSession(db, input, now), api.closeReader(db, readerDigest)]);
  expect(results[1].status).toBe("fulfilled");
  if (results[0].status === "fulfilled") {
    await expect(api.assertReaderExpired(db, readerDigest, now)).rejects.toThrow("old Admin sessions");
  } else expect(await api.assertReaderExpired(db, readerDigest, now)).toEqual({ readerDigest, maxExpiresAt: 0 });
});

it("refreshing a receipt does not reset the closed session lifetime", async () => {
  const lease = await api.openSession(db, input, now);
  await api.closeReader(db, readerDigest);
  const refreshed = { ...liveReader, verifiedAt: new Date(now + 30_000).toISOString() };
  expect(api.readerSessionDigest(refreshed)).toBe(readerDigest);
  await expect(api.openSession(db, { ...input, reader: refreshed, sessionId: "33333333-3333-4333-8333-333333333333" }, now + 30_000)).rejects.toThrow("no longer issues");
  expect(lease.expiresAt).toBe(now + 60_000);
});

it("one-millisecond leases hold all 32 issuance slots for 15 minutes without extending any lease", async () => {
  const sessionId = index => `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
  for (let index = 0; index < 32; index++) {
    const issuedAt = now + index * 2;
    const lease = await api.openSession(db, { ...input, sessionId: sessionId(index), ttlMs: 1 }, issuedAt);
    expect(lease.issuedAt).toBe(issuedAt);
    expect(lease.expiresAt).toBe(issuedAt + 1);
  }
  await expect(api.openSession(db, { ...input, sessionId: sessionId(32), ttlMs: 1 }, now + 64))
    .rejects.toMatchObject({ status: 429, retryAfterSeconds: 900 });
  await expect(api.openSession(db, { ...input, sessionId: sessionId(0), ttlMs: 1 }, now + 64)).rejects.toThrow("expired");
  const next = now + 15 * 60_000 + 64;
  expect((await api.openSession(db, { ...input, sessionId: sessionId(32), ttlMs: 1 }, next)).expiresAt).toBe(next + 1);
  await expect(api.openSession(db, { ...input, sessionId: sessionId(0), ttlMs: 1 }, next)).rejects.toThrow("expired");
});

it("retains 128 live leases while its separate issuance quota resets, then reports the live-cap wait", async () => {
  const sessionId = index => `${index.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`;
  for (let index = 0; index < 128; index++) {
    const at = now + Math.floor(index / 32) * 15 * 60_000;
    await api.openSession(db, { ...input, sessionId: sessionId(index), ttlMs: 86_400_000 }, at);
  }
  const at = now + 4 * 15 * 60_000;
  await expect(api.openSession(db, { ...input, sessionId: sessionId(128), ttlMs: 86_400_000 }, at))
    .rejects.toMatchObject({ status: 429, retryAfterSeconds: 82_800 });
  expect((await db.collection("cmsReaderSessions").get()).docs.filter(row => row.data().schemaVersion === 2)).toHaveLength(128);
});

const functionsReader = reader("functions", now), functionsDigest = api.readerSessionDigest(functionsReader);
const pairInput = { readers: { functions: functionsReader, cmsApi: liveReader }, principalId: "staff", ttlMs: 60_000,
  sessionIds: { functions: input.sessionId, cmsApi: "22222222-2222-4222-8222-222222222222" } };
const row = id => db.doc(`cmsReaderSessions/${id}`).get();
const principalRow = async () => (await db.collection("cmsReaderSessions").get()).docs.find(item => item.id.startsWith("principal-"))?.data();
it("a retry that finds one historical lease expired ends the group with its stored expiry", async () => {
  const expired = await api.openSession(db, { ...input, reader: functionsReader }, now);
  const later = await api.openSession(db, { ...input, sessionId: pairInput.sessionIds.cmsApi }, now + 30_000);
  const quota = await principalRow();
  await expect(api.openReaderSessions(db, pairInput, now + 60_000)).rejects.toMatchObject({
    expiredLeases: [{ sessionId: expired.sessionId, readerDigest: functionsDigest, issuedAt: now, expiresAt: now + 60_000 }] });
  expect(await principalRow()).toEqual(quota);
  expect((await row(later.sessionId)).data()).toEqual(later);
  expect(await api.assertSession(db, { sessionId: later.sessionId, principalId: "staff", readerDigest }, now + 89_999)).toEqual(later);
  await expect(api.assertSession(db, { sessionId: later.sessionId, principalId: "staff", readerDigest }, now + 90_000)).rejects.toThrow("expired");
});
it("an expired lease never issues its absent partner under the original ID", async () => {
  await api.openSession(db, { ...input, reader: functionsReader }, now);
  await expect(api.openReaderSessions(db, pairInput, now + 60_000)).rejects.toMatchObject({ expiredLeases: [{ sessionId: input.sessionId }] });
  expect((await row(pairInput.sessionIds.cmsApi)).exists).toBe(false);
});
it("another principal learns nothing from an expired UUID", async () => {
  await api.openSession(db, input, now);
  const refused = await api.openSession(db, { ...input, principalId: "other" }, now + 60_000).catch(error => error);
  expect(refused.message).toBe("CMS reader session retry conflicts or expired");
  expect(refused.expiredLeases).toBeUndefined();
});
it("sweeps only a closed reader whose every lease has ended", async () => {
  const lease = await api.openSession(db, input, now);
  await expect(api.sweepClosedReaderSessions(db, readerDigest, lease.expiresAt)).rejects.toThrow("old Admin sessions");
  await api.closeReader(db, readerDigest);
  await expect(api.sweepClosedReaderSessions(db, readerDigest, lease.expiresAt - 1)).rejects.toThrow("old Admin sessions");
  expect((await row(lease.sessionId)).exists).toBe(true);
  expect(await api.sweepClosedReaderSessions(db, readerDigest, lease.expiresAt)).toEqual({ readerDigest, deleted: 1, complete: true });
  expect((await row(lease.sessionId)).exists).toBe(false);
});
it("uses database time, so a sweep without a clock cannot delete a live lease", async () => {
  const lease = await api.openSession(db, input, Date.now());
  await api.closeReader(db, readerDigest);
  await expect(api.sweepClosedReaderSessions(db, readerDigest)).rejects.toThrow("old Admin sessions");
  expect((await row(lease.sessionId)).exists).toBe(true);
});
it("a swept UUID stays refused and a sweep leaves other readers alone", async () => {
  const lease = await api.openSession(db, input, now);
  const other = await api.openSession(db, { ...input, reader: functionsReader, sessionId: pairInput.sessionIds.cmsApi }, now);
  await api.closeReader(db, readerDigest);
  await api.sweepClosedReaderSessions(db, readerDigest, lease.expiresAt);
  await expect(api.openSession(db, input, lease.expiresAt + 86_400_000)).rejects.toThrow("no longer issues");
  expect((await row(lease.sessionId)).exists).toBe(false);
  expect((await row(other.sessionId)).data()).toEqual(other);
});
it("a same-ID retry that races the sweep is refused on both orderings", async () => {
  for (let index = 0; index < 8; index++) {
    const sessionId = `${index.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`, attempt = { ...input, sessionId };
    const lease = await api.openSession(db, attempt, now + index * 15 * 60_000);
    await api.closeReader(db, readerDigest);
    const [swept, retried] = await Promise.allSettled([
      api.sweepClosedReaderSessions(db, readerDigest, lease.expiresAt), api.openSession(db, attempt, lease.expiresAt)]);
    expect(swept.status).toBe("fulfilled");
    expect(retried.status).toBe("rejected");
    expect((await row(sessionId)).exists).toBe(false);
    await db.doc(`cmsReaderSessionWindows/${readerDigest}`).delete();
  }
});
it("eventually removes a large history in bounded pages and retains its principal row", async () => {
  // The operator uses database time, so this history ended in the real past.
  const past = now - 120_000;
  await api.openSession(db, input, past);
  const quota = await principalRow(), batch = db.batch();
  for (let index = 0; index < api.MAX_SWEPT_SESSIONS; index++) {
    const sessionId = `${index.toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`;
    batch.set(db.doc(`cmsReaderSessions/${sessionId}`), { schemaVersion: 2, sessionId, readerDigest, principalId: "staff", ttlMs: 60_000, issuedAt: past, expiresAt: past + 60_000 });
  }
  await batch.commit();
  await api.closeReader(db, readerDigest);
  const first = await api.sweepClosedReaderSessions(db, readerDigest);
  expect(first).toEqual({ readerDigest, deleted: api.MAX_SWEPT_SESSIONS, complete: false });
  expect(await operator.runOperator({ firestore: db, command: "plan" })).toEqual([{ readerDigest, closed: true, maxExpiresAt: past + 60_000, sessionRows: 1 }]);
  expect(await operator.runOperator({ firestore: db, command: "sweep", readerDigest })).toEqual({ readerDigest, deleted: 1 });
  expect((await db.collection("cmsReaderSessions").get()).docs.map(item => item.data())).toEqual([quota]);
});
it("refuses a session row that its reader window does not account for", async () => {
  await api.openSession(db, input, now);
  await api.closeReader(db, readerDigest);
  await db.doc(`cmsReaderSessions/${input.sessionId}`).update({ expiresAt: now + 120_000 });
  await expect(api.sweepClosedReaderSessions(db, readerDigest, now + 200_000)).rejects.toThrow("inventory is incomplete");
  expect((await row(input.sessionId)).exists).toBe(true);
});
it("keeps a swept UUID rate-limited until its original issuance slot expires", async () => {
  await api.openSession(db, { ...input, ttlMs: 1 }, now);
  await api.closeReader(db, readerDigest);
  expect(await api.sweepClosedReaderSessions(db, readerDigest, now + 1)).toMatchObject({ deleted: 1, complete: true });
  const nextReader = { ...liveReader, sourceSha: "e".repeat(40) };
  const reused = { ...input, reader: nextReader, ttlMs: 1 };
  const principal = db.doc(`cmsReaderSessions/principal-${pairs.digest(input.principalId)}`);
  const before = (await principal.get()).data();
  await expect(api.openSession(db, reused, now + 1)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 900 });
  expect((await principal.get()).data()).toEqual(before);
  expect((await row(input.sessionId)).exists).toBe(false);
  const other = { ...reused, sessionId: "33333333-3333-4333-8333-333333333333" };
  expect((await api.openSession(db, other, now + 2)).sessionId).toBe(other.sessionId);
  expect((await api.openSession(db, reused, now + 15 * 60_000)).sessionId).toBe(input.sessionId);
  expect((await api.openSession(db, { ...other, sessionId: "44444444-4444-4444-8444-444444444444" }, now + 15 * 60_000 + 1)).sessionId)
    .toBe("44444444-4444-4444-8444-444444444444");
});
it("the operator names one explicit target and refuses to close a current reader", async () => {
  expect(() => operator.parseArguments(["sweep", "njpbs-site"], {})).toThrow("refused");
  expect(() => operator.parseArguments(["plan", "other-project"], {})).toThrow("refused");
  expect(() => operator.parseArguments(["plan", "njpbs-site"], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" })).toThrow("refused");
  expect(operator.parseArguments(["close", "njpbs-site", readerDigest], {})).toEqual({ command: "close", projectId: "njpbs-site", readerDigest });
  for (const [component, value] of [["functions", functionsReader], ["cmsApi", liveReader]]) {
    await db.doc(`${pairs.READER_RECEIPTS}/${component}`).set({ schemaVersion: 2, component, state: "complete", lastComplete: value });
  }
  await api.openSession(db, input, now);
  await expect(operator.runOperator({ firestore: db, command: "close", readerDigest })).rejects.toThrow("Current CMS readers");
  expect((await db.doc(`cmsReaderSessionWindows/${readerDigest}`).get()).data().closed).toBe(false);
  await db.doc(`${pairs.READER_RECEIPTS}/cmsApi`).set({ schemaVersion: 2, component: "cmsApi", state: "complete", lastComplete: { ...liveReader, sourceSha: "e".repeat(40) } });
  expect(await operator.runOperator({ firestore: db, command: "close", readerDigest })).toEqual({ readerDigest, closed: true });
  expect((await db.doc(`cmsReaderSessionWindows/${readerDigest}`).get()).data().closed).toBe(true);
});
