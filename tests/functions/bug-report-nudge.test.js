import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import nudges from "../../functions/lib/bug-report-nudge.js";
import triage from "../../functions/bug-report-triage.js";
import delivery from "../../functions/bug-report-delivery.js";
import contract from "../../functions/lib/bug-report-contract.js";

const project = process.env.GCLOUD_PROJECT || "demo-njpbs";
const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const id = `br_${"c".repeat(32)}`;
const created = "2026-10-01T00:00:00.000Z";
const now = () => new Date("2026-10-05T00:00:00.000Z");
const mutationId = "11111111-1111-4111-8111-111111111111";
const actor = { uid: "reporter", emailVerified: true, principal: { id: "reporter", grants: [{ role: "staff" }] } };
let db;
const request = (extra = {}) => ({ method: "POST", headers: {}, body: { reportId: id, mutationId, ...extra } });
function response() {
  return { statusCode: null, body: null, set() { return this; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } };
}
async function record() { return (await db.doc(`bug_reports/${id}`).get()).data(); }
async function outbox() { return (await db.collection("bugReportDeliveryOutbox").get()).docs; }
async function submit(uid = actor.uid, token = mutationId, clock = now) {
  return nudges.commitReporterNudge({ firestore: db, actor: { ...actor, uid }, reportId: id, mutationId: token, now: clock });
}
function client() {
  return { sendMessage: vi.fn(async () => ({ chat: { id: "chat" }, message_id: 73 })), editMessage: vi.fn(), editKeyboard: vi.fn(), answerCallbackQuery: vi.fn() };
}
async function send(clock = now) {
  const notification = (await outbox()).find((row) => row.data().eventType === "report_nudged");
  const fake = client();
  const result = await delivery.deliverOutboxRow(notification.id, { firestore: db, telegramClient: fake, chatId: "chat", now: clock });
  return { notification, fake, result };
}
beforeAll(() => { if (!admin.apps.length) admin.initializeApp({ projectId: project }); db = isolatedFirestore("bug-report-nudge.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
  await db.doc("users/reporter").set({ active: true, accessTier: "viewer" });
  await db.doc("users/administrator").set({ active: true, accessTier: "admin" });
  await db.doc(`bug_reports/${id}`).set({
    id, status: "open", severity: "minor", area: "media", tryingToDo: "Review a clip", happened: "Preview stopped",
    reporter: { uid: "reporter", role: "staff" }, createdAt: created, updatedAt: now().toISOString(), version: 1,
    ownerUid: null, acknowledgedAt: null, actionableResolution: null,
    links: {}, githubDelivery: { lastSyncedAt: now().toISOString() },
    deliveryStatus: "delivered", delivery: { telegramMessageId: "12", telegramChatId: "chat" },
  });
});
afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });

describe("reporter nudge admission and replay", () => {
  it.each(["GET", "PUT", "DELETE"])("refuses %s as a method error without authentication, logging or writes", async (method) => {
    const principal = vi.fn();
    const log = { error: vi.fn() };
    const endpoint = triage.createCmsNudgeBugReportHandler({ firestore: db, now, requirePrincipalFn: principal, log });
    const result = response();
    await endpoint({ method, headers: {} }, result);
    expect(result.statusCode).toBe(405);
    expect(principal).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(await outbox()).toHaveLength(0);
    expect((await record()).version).toBe(1);
  });
  it("authenticates an empty unauthenticated POST before exposing payload validation", async () => {
    const endpoint = triage.createCmsNudgeBugReportHandler({ firestore: db, now });
    const result = response();
    await endpoint({ method: "POST", headers: {}, body: {} }, result);
    expect(result.statusCode).toBe(401);
    expect(await outbox()).toHaveLength(0);
  });
  it("uses semantic progress, not a fresh identical sync or notification timestamp", async () => {
    expect(nudges.nudgeForReporter(await record(), now()).eligible).toBe(true);
    const result = await submit();
    expect(result.record.nudgeHistory).toHaveLength(1);
    expect(nudges.nudgeForReporter(result.record, now()).eligible).toBe(false);
    expect(contract.reportForReporter(result.record, "reporter").nudge.history).toHaveLength(1);
    expect(JSON.stringify(contract.reportForStaff(result.record))).not.toContain("nudge");
  });
  it("refuses the exact three-day boundary and accepts only after it", async () => {
    await expect(submit(actor.uid, mutationId, () => new Date("2026-10-04T00:00:00.000Z"))).rejects.toMatchObject({ status: 409 });
    expect(await outbox()).toHaveLength(0);
    await submit(actor.uid, mutationId, () => new Date("2026-10-04T00:00:00.001Z"));
  });
  it("serializes concurrent different requests and replays the accepted mutation", async () => {
    const outcomes = await Promise.allSettled([submit(), submit(actor.uid, "22222222-2222-4222-8222-222222222222")]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    const accepted = (await db.collection("bugReportMutationReceipts").get()).docs[0].data();
    expect((await submit(actor.uid, accepted.mutationId)).replayed).toBe(true);
    const later = () => new Date("2026-10-08T00:00:00.001Z");
    await submit(actor.uid, "33333333-3333-4333-8333-333333333333", later);
    expect(await outbox()).toHaveLength(2);
  });
  it("denies another reporter, a revoked account, the inactive gate and forged input", async () => {
    await db.doc("users/other").set({ accessTier: "viewer", active: true });
    await expect(submit("other")).rejects.toMatchObject({ status: 404 });
    await db.doc("users/reporter").update({ active: false });
    await expect(submit()).rejects.toMatchObject({ status: 403 });
    await db.doc("users/reporter").update({ active: true });
    await db.doc("system/staffAccessActivation").delete();
    await expect(submit()).rejects.toMatchObject({ status: 409 });
    const endpoint = triage.createCmsNudgeBugReportHandler({ firestore: db, requirePrincipalFn: async () => actor, now });
    const result = response(); await endpoint(request({ approvedBy: "forged" }), result);
    expect(result.statusCode).toBe(400);
    expect(await outbox()).toHaveLength(0);
  });
  it("requires verified admission and keeps raw provider errors out of responses and logs", async () => {
    const endpoint = triage.createCmsNudgeBugReportHandler({ firestore: db, requirePrincipalFn: async () => ({ ...actor, emailVerified: false }), now });
    const unverified = response(); await endpoint(request(), unverified);
    expect(unverified.statusCode).toBe(403);
    const log = { error: vi.fn() };
    const failing = triage.createCmsNudgeBugReportHandler({ firestore: db, requirePrincipalFn: async () => { throw Object.assign(new Error("PROVIDER-CANARY"), { status: 400, code: 10 }); }, log, now });
    const failed = response(); await failing(request(), failed);
    expect(failed.statusCode).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("PROVIDER-CANARY");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("PROVIDER-CANARY");
    expect(log.error).toHaveBeenCalledWith("cmsNudgeBugReport failed", { reportId: id, code: 10 });
    expect(await outbox()).toHaveLength(0);
  });
  it("does not nudge terminal reports or restart the timer on a real recent change", async () => {
    await db.doc(`bug_reports/${id}`).update({ status: "resolved" });
    await expect(submit()).rejects.toMatchObject({ status: 409 });
    await db.doc(`bug_reports/${id}`).update({ status: "open", progressChangedAt: now().toISOString() });
    await expect(submit()).rejects.toMatchObject({ status: 409 });
  });
});

describe("existing delivery path and scoped approval", () => {
  it.each(["attach_github_issue", "attach_github_pr", "create_github_issue"])("cancels a queued nudge when %s starts before link hydration", async (action) => {
    await submit();
    const at = "2026-10-05T00:01:00.000Z";
    await triage.commitAdminAction({ firestore: db, actor: { uid: "administrator" }, source: { surface: "reports" },
      body: { reportId: id, baseVersion: (await record()).version, mutationId: "22222222-2222-4222-8222-222222222222", action,
        ...(action === "create_github_issue" ? {} : { githubNumber: 2835 }) },
      now: () => at });
    expect((await record()).progressChangedAt).toBe(at);
    expect(nudges.nudgeForReporter(await record(), new Date(at)).progressAt).toBe(at);
    const { fake, notification } = await send(() => new Date("2026-10-05T00:02:00.000Z"));
    expect(fake.sendMessage).not.toHaveBeenCalled();
    expect((await notification.ref.get()).data().state).toBe("suppressed");
    expect((await record()).nudgeHistory[0].delivery).toBe("cancelled");
    expect((await record()).progressChangedAt).toBe(at);
  });
  it.each([
    ["acknowledgement", { status: "acknowledged" }],
    ["assignment", { ownerUid: "administrator" }],
    ["active work", { githubDelivery: { fixStatus: "running" } }],
    ["merged work", { links: { pullRequests: [{ number: 2835, state: "closed", merged: true }] } }],
  ])("refuses stale delivered approval after later %s but still permits ignore", async (_label, fields) => {
    await submit(); const { notification } = await send();
    const args = { firestore: db, actor: { uid: "administrator" }, reportId: id, nudgeId: notification.data().nudgeId,
      chatId: "chat", messageId: 73, now };
    await db.doc(`bug_reports/${id}`).update({ ...fields, progressChangedAt: "2026-10-05T00:01:00.000Z" });
    expect(contract.reportForReporter(await record(), "reporter").progress.active).toBe(true);
    await expect(nudges.decideNudge({ ...args, decision: "approved" })).rejects.toMatchObject({ status: 409 });
    expect((await db.collection("bugReportFollowupOutbox").get()).empty).toBe(true);
    expect((await notification.ref.get()).data().decision ?? null).toBeNull();
    await nudges.decideNudge({ ...args, decision: "ignored" });
    expect((await record()).nudgeHistory[0].decision).toBe("ignored");
    expect((await db.collection("bugReportFollowupOutbox").get()).empty).toBe(true);
  });
  it.each(["missing", "invalid"])("refuses approval with %s progress snapshot evidence", async (kind) => {
    await submit(); const { notification } = await send();
    await notification.ref.update({ waitingSince: kind === "missing" ? admin.firestore.FieldValue.delete() : "invalid" });
    await expect(nudges.decideNudge({ firestore: db, actor: { uid: "administrator" }, reportId: id,
      nudgeId: notification.data().nudgeId, decision: "approved", chatId: "chat", messageId: 73, now })).rejects.toMatchObject({ status: 409 });
    expect((await db.collection("bugReportFollowupOutbox").get()).empty).toBe(true);
  });
  it("sends a separate bounded approval card without overwriting the original report receipt", async () => {
    await submit(); const { fake, result } = await send();
    expect(result.state).toBe("delivered");
    expect(fake.editMessage).not.toHaveBeenCalled();
    expect(fake.sendMessage).toHaveBeenCalledOnce();
    const [, text, keyboard] = fake.sendMessage.mock.calls[0];
    expect(text).toContain("No recorded progress since");
    expect(keyboard.inline_keyboard[0].map((button) => button.text)).toEqual(["Approve a follow-up", "Ignore"]);
    for (const button of keyboard.inline_keyboard[0]) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    expect((await record()).delivery.telegramMessageId).toBe("12");
    expect((await record()).nudgeHistory[0].delivery).toBe("delivered");
  });
  it.each(["approved", "ignored"])("records %s once and binds the exact delivered nudge message", async (decision) => {
    await submit(); const { notification } = await send();
    const row = (await notification.ref.get()).data();
    const args = { firestore: db, actor: { uid: "administrator" }, reportId: id, nudgeId: row.nudgeId, decision, chatId: "chat", messageId: 73, now };
    await expect(nudges.decideNudge({ ...args, messageId: 12 })).rejects.toMatchObject({ status: 409 });
    await nudges.decideNudge(args);
    expect((await nudges.decideNudge(args)).replayed).toBe(true);
    await expect(nudges.decideNudge({ ...args, decision: decision === "approved" ? "ignored" : "approved" })).rejects.toMatchObject({ status: 409 });
    expect((await record()).status).toBe("open");
    expect((await record()).nudgeHistory[0].decision).toBe(decision);
    const jobs = await db.collection("bugReportFollowupOutbox").get();
    expect(jobs.size).toBe(decision === "approved" ? 1 : 0);
    if (jobs.size) expect(jobs.docs[0].data()).toMatchObject({ schema: 1, operation: "investigate_report", state: "pending", nudgeId: row.nudgeId });
    const audit = await db.collection("admin_logs").get();
    expect(audit.size).toBe(2);
    await db.doc(`bug_reports/${id}`).update({ progressChangedAt: "2026-10-05T00:01:00.000Z" });
    expect((await nudges.decideNudge(args)).replayed).toBe(true);
    expect((await db.collection("bugReportFollowupOutbox").get()).size).toBe(jobs.size);
  });
  it("rechecks administrator authority and rejects approval after closure", async () => {
    await submit(); const { notification } = await send();
    const row = (await notification.ref.get()).data();
    const args = { firestore: db, actor: { uid: "administrator" }, reportId: id, nudgeId: row.nudgeId, decision: "approved", chatId: "chat", messageId: 73, now };
    await db.doc("users/administrator").update({ accessTier: "viewer" });
    await expect(nudges.decideNudge(args)).rejects.toMatchObject({ status: 403 });
    await db.doc("users/administrator").update({ accessTier: "admin" });
    await db.doc(`bug_reports/${id}`).update({ status: "dismissed" });
    await expect(nudges.decideNudge(args)).rejects.toMatchObject({ status: 409 });
    expect((await db.collection("bugReportFollowupOutbox").get()).empty).toBe(true);
  });
  it("keeps ambiguous sends unknown without an automatic duplicate", async () => {
    await submit(); const notification = (await outbox())[0]; const fake = client();
    fake.sendMessage.mockRejectedValue(new delivery.DeliveryError("Uncertain", { kind: "ambiguous" }));
    const deps = { firestore: db, telegramClient: fake, chatId: "chat", now };
    expect((await delivery.deliverOutboxRow(notification.id, deps)).state).toBe("unknown");
    expect((await delivery.deliverOutboxRow(notification.id, deps)).state).toBe("skipped");
    expect(fake.sendMessage).toHaveBeenCalledOnce();
    expect((await record()).nudgeHistory[0].delivery).toBe("unknown");
    expect((await record()).deliveryStatus).toBe("delivered");
    const row = (await notification.ref.get()).data();
    const handler = await delivery.createTelegramWebhookHandler({ firestore: db, client: fake, webhookSecret: "synthetic-webhook", chatId: "chat", adminMap: { "7": "administrator" }, now: () => now().toISOString() });
    const result = response();
    await handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "synthetic-webhook" }, body: { callback_query: { id: "synthetic-callback", data: `br:2:i:${id}:${row.nudgeId}`, from: { id: 7 }, message: { message_id: 73, chat: { id: "chat" } } } } }, result);
    expect(fake.answerCallbackQuery).toHaveBeenCalledWith("synthetic-callback", "This nudge cannot be applied. An operator must check its delivery receipt and current report status.");
    expect((await record()).nudgeHistory[0].decision).toBeNull();
    expect((await db.collection("bugReportFollowupOutbox").get()).empty).toBe(true);
  });
  it("suppresses queued nudges when meaningful progress changes before delivery", async () => {
    await submit(); await db.doc(`bug_reports/${id}`).update({ progressChangedAt: "2026-10-05T00:00:01.000Z" });
    const { fake, result } = await send();
    expect(result.state).toBe("skipped"); expect(fake.sendMessage).not.toHaveBeenCalled();
    expect((await record()).nudgeHistory[0].delivery).toBe("cancelled");
  });
  it.each([false, true])("records a callback decision even when keyboard refresh fails: %s", async (keyboardFails) => {
    await submit(); const { notification } = await send(); const row = (await notification.ref.get()).data(); const fake = client();
    if (keyboardFails) fake.editKeyboard.mockRejectedValue(new Error("Synthetic card refresh failure"));
    const handler = await delivery.createTelegramWebhookHandler({ firestore: db, client: fake, webhookSecret: "synthetic-webhook", chatId: "chat", adminMap: { "7": "administrator" }, now: () => now().toISOString() });
    const result = response();
    await handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "synthetic-webhook" }, body: { callback_query: { id: "synthetic-callback", data: `br:2:i:${id}:${row.nudgeId}`, from: { id: 7 }, message: { message_id: 73, chat: { id: "chat" } } } } }, result);
    expect(result.statusCode).toBe(200);
    expect((await record()).nudgeHistory[0].decision).toBe("ignored");
    expect(fake.editKeyboard).toHaveBeenCalledWith("chat", 73, { inline_keyboard: [] });
    if (keyboardFails) expect(fake.answerCallbackQuery).toHaveBeenCalledWith("synthetic-callback", "Nudge decision saved. Open the CMS report for current status.");
  });
});
