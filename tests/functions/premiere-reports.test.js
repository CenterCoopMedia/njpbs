import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import firebase from "../../functions/lib/firebase.js";
import desktop from "../../functions/premiere-desktop.js";
import delivery from "../../functions/bug-report-delivery.js";
import triage from "../../functions/bug-report-triage.js";
import github from "../../functions/bug-report-github.js";
import contract from "../../functions/lib/bug-report-contract.js";

const { admin, db } = firebase;
const PROJECT = process.env.GCLOUD_PROJECT;
const quiet = { info() {}, error() {} };
const VERSION_CONTEXT = {
  pluginVersion: "0.1.0", premiereVersion: "26.5.2.5", uxpVersion: "9.3.0",
  pluginRevision: "c".repeat(40), platform: "win32", view: "library",
};
let clock;
let handlers;
let users;
let editor;

function response() {
  return {
    statusCode: 200, headersSent: false, headers: {},
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

async function call(handler, body, token) {
  const res = response();
  await handler({
    method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)),
    headers: { "content-type": "application/json", "x-njpbs-request-id": randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }, res);
  return res;
}

async function identity() {
  const uid = `premiere-report-${randomUUID()}`;
  const email = `${uid}@example.test`;
  const created = await admin.auth().createUser({ uid, email, emailVerified: true, password: "local-test-password" });
  users.push(uid);
  await db.collection("users").doc(uid).set({ active: true, grants: [{ role: "editor" }] });
  // The emulator sets the revocation time at account creation, and a sign-in in that same second
  // is refused. This account predates the sign-in.
  const backdated = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:update?key=local-test`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ localId: uid, validSince: String(Math.floor(Date.now() / 1000) - 60), targetProjectId: process.env.GCLOUD_PROJECT }),
  });
  if (!backdated.ok) throw new Error(`Auth emulator account setup failed: ${await backdated.text()}`);
  const login = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-test`, {
    // The Auth emulator's API-key route otherwise uses its default project.
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ email, password: "local-test-password", returnSecureToken: true, targetProjectId: PROJECT }),
  });
  if (!login.ok) throw new Error(`Auth emulator sign-in failed: ${await login.text()}`);
  const idToken = (await login.json()).idToken;
  const start = await call(handlers.start, { deviceName: "Test editing bay" });
  expect(start.statusCode).toBe(200);
  const approve = await call(handlers.approve, { action: "approve", userCode: start.body.userCode }, idToken);
  expect(approve.statusCode).toBe(200);
  const poll = await call(handlers.poll, { deviceCode: start.body.deviceCode });
  expect(poll.body.status).toBe("approved");
  return { uid, email, token: poll.body.sessionToken };
}

function payload(mode = "automatic", overrides = {}) {
  return {
    mode, clientRequestId: randomUUID(), context: { ...VERSION_CONTEXT },
    events: [{ timestamp: new Date(clock).toISOString(), operation: "media.import", outcome: "failure",
      code: "premiere", durationMs: 120, requestId: randomUUID() }], ...overrides,
  };
}

function submit(value, actor = editor) {
  return call(handlers.request, { operation: "cmsSubmitPremiereReport", payload: value }, actor.token);
}

async function rows(collection) {
  return (await db.collection(collection).get()).docs.map(doc => ({ ...doc.data(), _id: doc.id }));
}

async function reportRecord() {
  const records = await rows("bug_reports");
  expect(records).toHaveLength(1);
  return records[0];
}

async function action(record, action, extra = {}) {
  return triage.commitAdminAction({
    firestore: db,
    body: { reportId: record.id, baseVersion: record.version, mutationId: randomUUID(), action, ...extra },
    actor: { uid: "test-admin", email: "test@example.com", principal: { id: "test-admin", grants: [{ role: "admin" }] } },
    now: () => new Date(clock).toISOString(), source: { requestId: randomUUID() },
  });
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      !PROJECT?.startsWith("demo-")) {
    throw new Error("Run report tests with a demo project and Auth and Firestore emulators");
  }
});

beforeEach(async () => {
  process.env.FUNCTIONS_EMULATOR = "true";
  clock = Date.now();
  users = [];
  const reset = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  expect(reset.ok).toBe(true);
  handlers = desktop.createPremiereHandlers({
    firestore: db, now: () => clock, log: quiet, enabled: () => true,
    buildRevision: () => "b".repeat(40), deploymentEnvironment: () => "emulator",
  });
  editor = await identity();
});

afterEach(async () => {
  await Promise.all(users.map(uid => admin.auth().deleteUser(uid)));
});

describe("Premiere report intake through approved sessions", () => {
  it.each(["manual", "automatic"])("keeps trusted development %s intake and repeats stored-only", async (mode) => {
    handlers = desktop.createPremiereHandlers({
      firestore: db, now: () => clock, log: quiet, enabled: () => true,
      buildRevision: () => "b".repeat(40), deploymentEnvironment: () => "development",
    });
    const first = payload(mode, mode === "manual" ? { description: "The newsroom import did not complete." } : {});
    expect((await submit(first)).statusCode).toBe(201);
    expect((await submit(first)).statusCode).toBe(200);
    let record = await reportRecord();
    expect(record.deliveryStatus).toBe("not_queued");
    if (mode === "automatic") {
      const repeated = payload();
      expect((await submit(repeated)).body).toMatchObject({ deduplicated: true, repeatCount: 2 });
      expect((await submit(repeated)).body).toMatchObject({ deduplicated: true, repeatCount: 2 });
      record = await reportRecord();
      expect(record.automatic.repeatCount).toBe(2);
    }
    expect(await rows("bugReportDeliveryOutbox")).toEqual([]);
    expect(await rows("admin_logs")).toHaveLength(1);
  });

  it("stores trusted native context and only bounded diagnostic facts", async () => {
    const res = await submit(payload("manual", { description: "Import did not finish after selecting a clip." }));
    expect(res.statusCode).toBe(201);
    const record = await reportRecord();
    expect(res.body).toEqual({ success: true, mode: "manual", idempotent: false, report: { id: record.id } });
    expect(record).toMatchObject({ route: null, affectedRecord: null,
      reporter: { uid: editor.uid, email: editor.email },
      environment: { buildRevision: "b".repeat(40), deploymentEnvironment: "emulator",
        native: { source: "premiere", mode: "manual", ...VERSION_CONTEXT } } });
    expect(record.environment).not.toHaveProperty("browser");
    expect(record.consoleLogs[0].message).toContain("Source: Premiere native panel");
    expect(record.consoleLogs[1].message).toMatch(/^operation=media.import; outcome=failure;/);
    expect(record.actionableResolution.verification).toContain("succeeds in Premiere");
    expect(contract.reportForAdmin(record).environment.native.source).toBe("premiere");
    expect(github.renderGithubIssue(record).body).toContain("Source: Premiere native panel");
    expect(delivery.renderTelegramCard(record)).toContain("Premiere native panel; manual");
    expect((await rows("bugReportDeliveryOutbox")).map(row => row.channel).sort()).toEqual(["email", "telegram"]);
  });

  it.each([["resolved", "resolved"], ["dismissed", "closed"]])(
    "keeps branded receipt and final %s emails for a manually submitted native report",
    async (status, reporterStatus) => {
      const submitted = payload("manual", { description: "Import stopped after choosing the newsroom clip." });
      expect((await submit(submitted)).statusCode).toBe(201);
      let record = await reportRecord();
      const receiptRows = (await rows("bugReportDeliveryOutbox")).filter(row => row.channel === "email");
      expect(receiptRows).toEqual([expect.objectContaining({
        reportId: record.id, eventType: "report_received", eventStatus: "open", state: "pending",
      })]);
      const messages = [];
      const deps = {
        firestore: db, now: () => new Date(clock), adminOrigin: "https://admin.njpbs.org",
        sendEmail: async message => { messages.push(message); return { delivered: true }; },
      };
      expect(await delivery.deliverOutboxRow(receiptRows[0]._id, deps)).toEqual({ state: "delivered" });

      record = (await action(record, "set_status", { status })).record;
      const emailRows = (await rows("bugReportDeliveryOutbox")).filter(row => row.channel === "email");
      expect(emailRows).toHaveLength(2);
      const finalRow = emailRows.find(row => row.eventType === "report_status_changed");
      expect(finalRow).toMatchObject({
        reportId: record.id, eventStatus: status, eventResolution: record.actionableResolution, state: "pending",
      });
      expect(await delivery.deliverOutboxRow(finalRow._id, deps)).toEqual({ state: "delivered" });

      expect(messages).toHaveLength(2);
      expect(messages[0].subject).toBe("We received your bug or error report: Premiere panel report");
      expect(messages[0].html).toContain(">We received your bug or error report</h1>");
      expect(messages[1].subject).toBe(`Your bug or error report is now ${reporterStatus}: Premiere panel report`);
      expect(messages[1].html).toContain(`>Report ${reporterStatus}</h1>`);
      for (const message of messages) {
        expect(message.to).toBe(editor.email);
        expect(message.text).toContain(`Reference: ${record.id}`);
        expect(message.text).toContain(`https://admin.njpbs.org/reports/${record.id}`);
        expect(message.html).toContain('src="cid:njpbs-email-logo"');
        expect(message.html).toContain('bgcolor="#0b223d"');
        expect(message.attachments).toEqual([expect.objectContaining({
          content_id: "njpbs-email-logo", disposition: "inline", type: "image/png",
        })]);
        expect(`${message.text}\n${message.html}`).not.toContain(submitted.description);
        expect(`${message.text}\n${message.html}`).not.toContain(submitted.events[0].requestId);
      }
      expect((await rows("bugReportDeliveryOutbox")).filter(row => row.channel === "email")
        .every(row => row.state === "delivered")).toBe(true);
    },
  );

  it("checks the current verified email, role, activity, and session before storing a report", async () => {
    await admin.auth().updateUser(editor.uid, { emailVerified: false });
    expect((await submit(payload("manual"))).statusCode).toBe(403);
    await admin.auth().updateUser(editor.uid, { emailVerified: true });
    await db.collection("users").doc(editor.uid).update({ grants: [] });
    expect((await submit(payload("manual"))).statusCode).toBe(403);
    await db.collection("users").doc(editor.uid).update({ grants: [{ role: "editor" }], active: false });
    expect((await submit(payload("manual"))).statusCode).toBe(403);
    await db.collection("users").doc(editor.uid).update({ active: true });
    await call(handlers.revoke, {}, editor.token);
    expect((await submit(payload("manual"))).statusCode).toBe(401);
    expect(await rows("bug_reports")).toHaveLength(0);
  });

  it("redacts pasted session tokens, signed URLs, paths, and credentials in manual text", async () => {
    const secrets = [
      `pds_${"A".repeat(43)}`,
      "https://fixture.s3.amazonaws.com/private.mov?X-Amz-Signature=secret-signature",
      "C:\\Users\\test-editor\\Newsroom\\project.prproj",
      "/Users/test-editor/Movies/private.mov",
    ];
    const res = await submit(payload("manual", { description: `Import failed.\n${secrets.join("\n")}\nAuthorization: Bearer test-secret-value` }));
    expect(res.statusCode).toBe(201);
    const record = await reportRecord();
    const storedAndExternal = JSON.stringify([record, delivery.renderTelegramCard(record), github.renderGithubIssue(record)]);
    for (const value of [...secrets, "test-secret-value", "secret-signature", "project.prproj", "private.mov"]) {
      expect(storedAndExternal).not.toContain(value);
    }
    expect(record.happened).toContain("[redacted path]");
  });

  it("rejects arbitrary diagnostic strings, impersonated fields, excessive events and invalid versions", async () => {
    const valid = payload("manual");
    const cases = [
      { ...valid, reporter: { uid: "another-user" } },
      { ...valid, screenshot: "private bytes" },
      { ...valid, context: { ...valid.context, filename: "private.mov" } },
      { ...valid, context: { ...valid.context, pluginVersion: "secret/value" } },
      { ...valid, events: [{ ...valid.events[0], message: "pds_secret" }] },
      { ...valid, events: [{ ...valid.events[0], operation: "private.mov" }] },
      { ...valid, events: [{ ...valid.events[0], requestId: "signed-url" }] },
      { ...valid, events: Array(41).fill(valid.events[0]) },
      { ...valid, description: "short" },
      { ...valid, description: "x".repeat(2001) },
    ];
    for (const candidate of cases) expect((await submit(candidate)).statusCode).toBe(400);
    expect((await submit({ ...valid, description: "x".repeat(65536) })).statusCode).toBe(413);
    expect(await rows("bug_reports")).toHaveLength(0);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(0);
  });

  it("accepts optional descriptions, UTF-8 byte bounds, and fixed latest-failure summaries", async () => {
    const empty = await submit(payload("manual", { events: [] }));
    expect(empty.statusCode).toBe(201);
    expect((await db.collection("bug_reports").doc(empty.body.report.id).get()).data().happened)
      .toBe("Premiere panel problem reported by staff");
    expect((await submit(payload("manual", { description: "漢字漢字" }))).statusCode).toBe(201);
    const failure = await submit(payload("manual"));
    expect(failure.statusCode).toBe(201);
    expect((await db.collection("bug_reports").doc(failure.body.report.id).get()).data().happened)
      .toBe("Premiere media.import failed (premiere).");
  });

  // Allow the Firestore SDK's bounded transaction backoff under real contention.
  it("deduplicates concurrent cross-user incidents and immutable UUID retries without exposing report details", async () => {
    const other = await identity();
    const first = payload();
    const second = payload();
    const results = await Promise.all([submit(first), submit(second, other)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 201]);
    expect(results.map(result => result.body.repeatCount).sort()).toEqual([1, 2]);
    const record = await reportRecord();
    expect(record.automatic.repeatCount).toBe(2);
    expect(contract.reportForAdmin(record).automatic.repeatCount).toBe(2);
    for (const res of results) expect(Object.keys(res.body).sort())
      .toEqual(["accepted", "deduplicated", "mode", "repeatCount", "success"]);
    expect((await submit(first)).body).toEqual(results[0].body);
    expect((await reportRecord()).automatic.repeatCount).toBe(2);
    expect((await submit({ ...first, context: { ...first.context, view: "detail" } })).statusCode).toBe(409);
    expect((await reportRecord()).automatic.repeatCount).toBe(2);
    expect(await rows("bugReportGithubOutbox")).toHaveLength(0);
    expect(await rows("bugReportAutofixOutbox")).toHaveLength(0);
    expect((await rows("bugReportDeliveryOutbox")).filter(row => row.eventType === "report_created")).toHaveLength(1);
  }, 20_000);

  it("replays manual UUID receipts and rejects changed content under the same UUID", async () => {
    const first = payload("manual");
    const results = await Promise.all([submit(first), submit(first)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 201]);
    expect(results.map(result => result.body.idempotent).sort()).toEqual([false, true]);
    expect(results[0].body.report.id).toBe(results[1].body.report.id);
    expect((await submit({ ...first, description: "This is different report content." })).statusCode).toBe(409);
    expect(await rows("bug_reports")).toHaveLength(1);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(2);
  }, 20_000);

  it("starts a new incident exactly 15 minutes after the first occurrence, without extending on repeats", async () => {
    const first = await submit(payload());
    const record = await reportRecord();
    clock += 14 * 60000;
    expect((await submit(payload())).body).toMatchObject({ deduplicated: true, repeatCount: 2 });
    expect((await reportRecord()).automatic.windowExpiresAt).toBe(record.automatic.windowExpiresAt);
    clock += 60000;
    const next = await submit(payload());
    expect(first.statusCode).toBe(201);
    expect(next.statusCode).toBe(201);
    expect(next.body).toMatchObject({ deduplicated: false, repeatCount: 1 });
    expect(await rows("bug_reports")).toHaveLength(2);
  });

  it("keeps manual quotas separate and lets duplicates join an existing incident after the new-incident quota is full", async () => {
    for (const view of ["library", "detail", "return"]) {
      expect((await submit(payload("automatic", { context: { ...VERSION_CONTEXT, view } }))).statusCode).toBe(201);
    }
    const capped = await submit(payload("automatic", { context: { ...VERSION_CONTEXT, view: "settings" } }));
    expect(capped.statusCode).toBe(429);
    expect(capped.headers["retry-after"]).toBe("900");
    expect((await submit(payload())).body).toMatchObject({ accepted: true, deduplicated: true, repeatCount: 2 });
    for (let index = 0; index < 5; index++) expect((await submit(payload("manual"))).statusCode).toBe(201);
    expect((await submit(payload("manual"))).statusCode).toBe(429);
    expect((await submit(payload())).statusCode).toBe(200);
    expect((await rows("bugReportDeliveryOutbox")).filter(row => row.channel === "email")).toHaveLength(5);
  });

  it("caps global new incidents without consuming another editor's manual quota", async () => {
    const actors = [editor, await identity(), await identity(), await identity()];
    for (let index = 0; index < 10; index++) {
      expect((await submit(payload("automatic", { context: { ...VERSION_CONTEXT, pluginVersion: `0.1.${index}` } }), actors[Math.floor(index / 3)])).statusCode).toBe(201);
    }
    expect((await submit(payload("automatic", { context: { ...VERSION_CONTEXT, pluginVersion: "0.2.0" } }), actors[3])).statusCode).toBe(429);
    expect((await submit(payload("manual"), actors[3])).statusCode).toBe(201);
    expect(await rows("bug_reports")).toHaveLength(11);
  });

  it("bounds duplicate intake attempts while keeping successful retries and manual reports available", async () => {
    const firstPayload = payload();
    const first = await submit(firstPayload);
    for (let index = 1; index < 20; index++) expect((await submit(payload())).statusCode).toBe(200);
    expect((await submit(payload())).statusCode).toBe(429);
    expect((await submit(firstPayload)).body).toEqual(first.body);
    expect((await submit(payload("manual"))).statusCode).toBe(201);
    clock += 60000;
    expect((await submit(payload())).body).toMatchObject({ repeatCount: 21 });
  });

  it("rejects cancellation, expected HTTP errors, and report-submission failures from automatic alerts", async () => {
    const source = payload();
    for (const event of [
      { ...source.events[0], outcome: "canceled", code: undefined },
      ...[400, 401, 403, 404, 408, 409, 422, 429].map(status => ({ ...source.events[0], status, code: "http" })),
      { ...source.events[0], operation: "report.submit" },
    ]) expect((await submit({ ...source, events: event.outcome === "canceled" ? [event] : [source.events[0], event] })).statusCode).toBe(400);
    expect((await submit({ ...source, description: "Automatic free text is forbidden." })).statusCode).toBe(400);
    expect(await rows("bug_reports")).toHaveLength(0);
  });
});

describe("native incident delivery and administrator actions", () => {
  it("coalesces delayed repeat edits, preserves a sending lease, and keeps one Telegram card", async () => {
    const calls = [];
    const telegramClient = {
      async sendMessage(...args) { calls.push({ method: "send", args, at: clock }); return { chat: { id: "-1001" }, message_id: 42 }; },
      async editMessage(...args) { calls.push({ method: "edit", args, at: clock }); return null; },
    };
    const deps = { firestore: db, now: () => new Date(clock), telegramClient, chatId: "-1001", adminOrigin: "https://admin.njpbs.org" };
    await submit(payload());
    const record = await reportRecord();
    await delivery.deliverOutboxRow(`${record.id}--telegram`, deps);
    await submit(payload());
    clock += 61000;
    await submit(payload());
    clock += 61000;
    await submit(payload());
    const repeats = (await rows("bugReportDeliveryOutbox")).filter(row => row.eventType === "report_repeated");
    const initial = repeats.find(row => row._id.endsWith("repeat-0"));
    const claimed = await delivery.claimOutboxRow(db, initial._id, new Date(clock));
    expect(claimed.operation).toBe("edit");
    const leased = (await db.collection("bugReportDeliveryOutbox").doc(initial._id).get()).data();
    await submit(payload());
    expect((await db.collection("bugReportDeliveryOutbox").doc(initial._id).get()).data()).toEqual(leased);
    clock += 90000;
    await delivery.settleOutboxSuccess(claimed, { chatId: "-1001", messageId: "42" }, deps);
    for (const repeat of repeats) await delivery.deliverOutboxRow(repeat._id, deps);
    expect(calls.filter(call => call.method === "edit")).toHaveLength(0);
    clock += 61000;
    for (const repeat of repeats) await delivery.deliverOutboxRow(repeat._id, deps);
    expect(calls.filter(call => call.method === "send")).toHaveLength(1);
    expect(calls.filter(call => call.method === "edit")).toHaveLength(1);
    expect(calls.find(call => call.method === "edit").args[2]).toContain("<b>Occurrences</b> 5");
    expect((await reportRecord()).delivery.telegramRepeatCount).toBe(5);
  });

  it("blocks repeats when the initial Telegram send is ambiguous", async () => {
    await submit(payload());
    await submit(payload());
    const record = await reportRecord();
    await delivery.deliverOutboxRow(`${record.id}--telegram`, {
      firestore: db, now: () => new Date(clock), chatId: "-1001", adminOrigin: "https://admin.njpbs.org",
      telegramClient: { async sendMessage() { throw new delivery.DeliveryError("Unknown result", { kind: "ambiguous" }); } },
    });
    clock += 60000;
    const repeat = (await rows("bugReportDeliveryOutbox")).find(row => row.eventType === "report_repeated");
    expect(await delivery.claimOutboxRow(db, repeat._id, new Date(clock))).toBeNull();
    expect((await db.collection("bugReportDeliveryOutbox").doc(repeat._id).get()).data().state).toBe("blocked_unknown");
    expect((await reportRecord()).deliveryStatus).toBe("unknown");
  });

  it.each(["during delivery", "after settlement"])("delivers a final repeat committed %s using an earlier intake timestamp", async (arrival) => {
    const calls = [];
    let workerClock = clock;
    const deps = { firestore: db, now: () => new Date(workerClock), chatId: "-1001", adminOrigin: "https://admin.njpbs.org",
      telegramClient: {
        async sendMessage() { calls.push("send"); return { chat: { id: "-1001" }, message_id: 42 }; },
        async editMessage(_chat, _id, text) { calls.push(text); },
      } };
    await submit(payload());
    const record = await reportRecord();
    await delivery.deliverOutboxRow(`${record.id}--telegram`, deps);
    clock += 1000;
    await submit(payload());
    workerClock += 61000;
    const repeat = (await rows("bugReportDeliveryOutbox")).find(row => row.eventType === "report_repeated");
    const claimed = await delivery.claimOutboxRow(db, repeat._id, new Date(workerClock));
    expect(claimed.record.automatic.repeatCount).toBe(2);
    if (arrival === "after settlement") await delivery.settleOutboxSuccess(claimed, { chatId: "-1001", messageId: "42" }, deps);
    // Intake can have captured its request time before the worker acquired this lease.
    await submit(payload());
    expect((await rows("bugReportDeliveryOutbox")).filter(row => row.eventType === "report_repeated")).toHaveLength(1);
    if (arrival === "during delivery") await delivery.settleOutboxSuccess(claimed, { chatId: "-1001", messageId: "42" }, deps);
    expect(await delivery.deliverOutboxRow(repeat._id, deps)).toEqual({ state: "skipped" });
    workerClock += 60000;
    expect(await delivery.deliverOutboxRow(repeat._id, deps)).toEqual({ state: "delivered" });
    expect(calls).toEqual(["send", expect.stringContaining("<b>Occurrences</b> 3")]);
    expect((await reportRecord()).delivery.telegramRepeatCount).toBe(3);
    expect((await rows("bugReportDeliveryOutbox")).every(row => row.state === "delivered")).toBe(true);
  });

  it("terminates repeat edits when the initial Telegram send has permanently failed", async () => {
    await submit(payload());
    await submit(payload());
    const record = await reportRecord();
    await delivery.deliverOutboxRow(`${record.id}--telegram`, {
      firestore: db, now: () => new Date(clock), chatId: "-1001", adminOrigin: "https://admin.njpbs.org",
      telegramClient: { async sendMessage() { throw new delivery.DeliveryError("Chat unavailable", { kind: "terminal" }); } },
    });
    clock += 60000;
    const repeat = (await rows("bugReportDeliveryOutbox")).find(row => row.eventType === "report_repeated");
    expect(await delivery.claimOutboxRow(db, repeat._id, new Date(clock))).toBeNull();
    const settled = (await db.collection("bugReportDeliveryOutbox").doc(repeat._id).get()).data();
    expect(settled).toMatchObject({ state: "terminal_failed", nextAttemptAt: null, leaseUntil: null });
    expect((await reportRecord()).deliveryStatus).toBe("terminal_failed");
  });

  it("suppresses receipt and every status email for automatic incidents, including existing retry rows", async () => {
    await submit(payload());
    let record = await reportRecord();
    record = (await action(record, "acknowledge")).record;
    record = (await action(record, "set_status", { status: "in_progress" })).record;
    record = (await action(record, "update_resolution", { actionableResolution: {
      ...record.actionableResolution, immediateSafeAction: "Keep Premiere open while the administrator checks the problem.",
    } })).record;
    expect(await rows("bugReportGithubOutbox")).toHaveLength(0);
    record = (await action(record, "create_github_issue_and_fix")).record;
    const job = (await rows("bugReportGithubOutbox"))[0];
    let issue;
    const fixed = await github.processGithubOutboxRow(job._id, {
      firestore: db, now: () => new Date(clock), client: {
        async listIssues() { return []; },
        async listOpenIssues() { return []; },
        async createIssue(value) {
          issue = value;
          return { number: 1400, html_url: "https://github.com/CenterCoopMedia/njpbs/issues/1400",
            title: "Premiere report", state: "open", created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() };
        },
      },
    });
    expect(fixed.state).toBe("delivered");
    expect(issue.body).toContain("Source: Premiere native panel");
    expect(await rows("bugReportAutofixOutbox")).toHaveLength(1);
    record = await reportRecord();
    record = (await action(record, "set_status", { status: "resolved" })).record;
    expect((await rows("bugReportDeliveryOutbox")).filter(row => row.channel === "email")).toHaveLength(0);
    const staleRef = db.collection("bugReportDeliveryOutbox").doc(`${record.id}--email--legacy-retry`);
    await staleRef.set({ reportId: record.id, eventType: "report_status_changed", eventStatus: "resolved",
      channel: "email", state: "pending", attemptCount: 1, nextAttemptAt: new Date(clock), leaseUntil: null });
    const result = await delivery.deliverOutboxRow(staleRef.id, { firestore: db, now: () => new Date(clock),
      sendEmail: async () => { throw new Error("An automatic report must not invoke the email provider"); } });
    expect(result.state).toBe("skipped");
    expect((await staleRef.get()).data().state).toBe("suppressed");
    expect((await submit(payload())).body).toMatchObject({ deduplicated: true, repeatCount: 2 });
    expect((await reportRecord()).status).toBe("resolved");
    expect(await rows("bugReportAutofixOutbox")).toHaveLength(1);
    expect((await rows("bugReportDeliveryOutbox")).filter(row => row.channel === "email" && row.state !== "suppressed")).toHaveLength(0);
  });
});
