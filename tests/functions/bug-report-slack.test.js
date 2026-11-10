import { describe, expect, it, vi } from "vitest";
import slackReports from "../../functions/lib/bug-report-slack.js";
import progressContract from "../../functions/lib/bug-report-progress.js";

const { buildSlackCard, createBugReportSlackConsumer, createFirestoreSlackStore, resolveReporterIdentity } = slackReports;
const ID = `br_${"a".repeat(32)}`;
const SECOND = `br_${"b".repeat(32)}`;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const config = {
  workspaceId: "T12345678", channelId: "C12345678", botUserId: "U12345678",
  identity: { mode: "email-lookup", lookupAuthorized: true },
  activationVerified: true,
};
const member = {
  id: "U87654321", team_id: config.workspaceId, deleted: false, is_bot: false,
  is_app_user: false, profile: { email: "editor@example.org" },
};
function record(id = ID, extra = {}) {
  return { id, category: "bug", area: "content_editing", status: "open", version: 1,
    updatedAt: new Date(NOW).toISOString(), reporter: { uid: "firebase-user", email: "editor@example.org" },
    links: { githubIssues: [{ number: 123, state: "open" }] }, ...extra };
}
const project = (report) => ({
  label: report.status === "resolved" ? "Resolved" : "Report received",
  detail: report.status === "resolved" ? "An administrator marked this report resolved." : "Your report is ready for review.",
});
function memoryStore(reports = [record()]) {
  const records = new Map(reports.map((r) => [r.id, structuredClone(r)]));
  const deliveries = new Map();
  let control = {};
  let chain = Promise.resolve();
  const serial = (fn) => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };
  return {
    records, deliveries,
    readSnapshot: async (id) => ({ record: structuredClone(records.get(id)), delivery: structuredClone(deliveries.get(id) || null) }),
    changeDelivery: (id, fn) => serial(() => {
      const change = fn({ record: structuredClone(records.get(id)), delivery: structuredClone(deliveries.get(id) || null) });
      if (change.next) deliveries.set(id, structuredClone(change.next));
      return change.result;
    }),
    listReportIds: async ({ afterId, limit }) => [...records.keys()].sort().filter((id) => !afterId || id > afterId).slice(0, limit),
    readControl: async () => structuredClone(control),
    changeControl: (fn) => serial(() => { const change = fn(structuredClone(control)); if (change.next) control = structuredClone(change.next); return change.result; }),
  };
}
function clients() {
  let ts = 0;
  return {
    authTest: vi.fn(async () => ({ ok: true, team_id: config.workspaceId, user_id: config.botUserId, bot_id: "B12345678" })),
    conversationsInfo: vi.fn(async () => ({ ok: true, channel: { id: config.channelId, name: "tech", is_member: true, is_archived: false, is_ext_shared: false } })),
    usersLookupByEmail: vi.fn(async () => ({ ok: true, user: structuredClone(member) })),
    usersInfo: vi.fn(async () => ({ ok: true, user: structuredClone(member) })),
    chatPostMessage: vi.fn(async () => ({ ok: true, channel: config.channelId, ts: `1234567890.${String(++ts).padStart(6, "0")}`, message: { user: config.botUserId } })),
    chatUpdate: vi.fn(async ({ ts }) => ({ ok: true, channel: config.channelId, ts })),
  };
}
function fixture(reports) {
  const store = memoryStore(reports); const slack = clients(); let at = NOW;
  const worker = createBugReportSlackConsumer({ store, slack, config, now: () => at, project });
  return { store, slack, worker, advance: (ms) => { at += ms; } };
}

describe("private-safe report cards", () => {
  it("allows only fixed report fields and the authenticated CMS link", () => {
    const canary = "PRIVATE_SENTINEL <@U99999999> https://private.invalid token=secret";
    const report = record(ID, { happened: canary, tryingToDo: canary, evidence: { screenshot: canary }, consoleLogs: [canary], githubDelivery: { lastError: canary }, category: canary, area: canary });
    const payload = buildSlackCard(report, { config, userId: member.id, project, now: NOW });
    expect(JSON.stringify(payload)).not.toContain(canary);
    expect(JSON.stringify(payload)).not.toContain(report.reporter.email);
    expect(payload.text).toContain(`<@${member.id}>`);
    expect(payload.text).toContain(`https://admin.njpbs.org/reports/${ID}`);
    expect(payload.unfurl_links).toBe(false);
    expect(payload.thread_ts).toBeUndefined();
  });
  it("uses the actual CMS projection with a Date and never treats merged as live", () => {
    const report = record(ID, { links: { pullRequests: [{ number: 99, state: "closed", merged: true, title: "PRIVATE_SENTINEL" }] } });
    const payload = buildSlackCard(report, { config, userId: member.id, now: NOW });
    const progress = progressContract.reportProgress(report, { now: new Date(NOW) });
    expect(payload.text).toContain(progress.label);
    expect(payload.text).toContain("live fix has not been verified");
    expect(payload.text).not.toContain("PRIVATE_SENTINEL");
  });
  it("does not interpolate unsafe report IDs or member IDs", () => {
    expect(() => buildSlackCard(record("<@U99999999>"), { config, userId: member.id, project })).toThrow();
    expect(() => buildSlackCard(record(), { config, userId: "U1> <@everyone", project })).toThrow();
  });
});

describe("authenticated reporter identity", () => {
  it("requires exact normalized email, active human, and expected workspace", async () => {
    const slack = clients();
    expect(await resolveReporterIdentity(record(), { slack, config })).toMatchObject({ userId: member.id });
    expect(slack.usersLookupByEmail).toHaveBeenCalledWith({ email: "editor@example.org" }, expect.anything());
    for (const change of [{ profile: { email: "fixture-0a8b684dc2@example.org" } }, { deleted: true }, { is_bot: true }, { is_app_user: true }, { team_id: "T99999999" }]) {
      slack.usersLookupByEmail.mockResolvedValueOnce({ ok: true, user: { ...member, ...change } });
      await expect(resolveReporterIdentity(record(), { slack, config })).rejects.toMatchObject({ code: "reporter_identity_unverified" });
    }
  });
  it("fails closed for missing scope, no account, absent authority, and unconfigured mappings", async () => {
    const slack = clients();
    for (const error of ["missing_scope", "users_not_found"]) {
      slack.usersLookupByEmail.mockResolvedValueOnce({ ok: false, error });
      await expect(resolveReporterIdentity(record(), { slack, config })).rejects.toMatchObject({ code: "reporter_identity_unverified" });
    }
    await expect(resolveReporterIdentity(record(), { slack, config: { ...config, identity: { mode: "email-lookup" } } })).rejects.toThrow();
    await expect(resolveReporterIdentity(record(), { slack, config: { ...config, identity: { mode: "verified-map", members: [] } } })).rejects.toThrow();
  });
  it("validates configured mappings through users.info without email lookup", async () => {
    const slack = clients(); const mapped = { ...config, identity: { mode: "verified-map", members: [{ email: "EDITOR@EXAMPLE.ORG", userId: member.id, workspaceId: config.workspaceId }] } };
    expect(await resolveReporterIdentity(record(), { slack, config: mapped })).toMatchObject({ userId: member.id });
    expect(slack.usersLookupByEmail).not.toHaveBeenCalled();
    slack.usersInfo.mockResolvedValueOnce({ ok: true, user: { ...member, id: "U99999999" } });
    await expect(resolveReporterIdentity(record(), { slack, config: mapped })).rejects.toThrow();
    slack.usersInfo.mockResolvedValueOnce({ ok: true, user: { ...member, profile: {} } });
    await expect(resolveReporterIdentity(record(), { slack, config: mapped })).rejects.toMatchObject({ code: "reporter_identity_unverified" });
    expect(slack.usersLookupByEmail).not.toHaveBeenCalled();
  });
});

describe("durable Slack delivery", () => {
  it("dry-runs without any Slack calls or durable writes", async () => {
    const { worker, store, slack } = fixture();
    expect(await worker.syncReport(ID)).toMatchObject({ status: "dry_run" });
    expect(store.deliveries.size).toBe(0);
    for (const method of Object.values(slack)) expect(method).not.toHaveBeenCalled();
  });
  it("deduplicates duplicate and concurrent report events", async () => {
    const { worker, store, slack } = fixture();
    await Promise.all([worker.syncReport(ID, { send: true }), worker.syncReport(ID, { send: true })]);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "unchanged" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(store.deliveries.get(ID)).toMatchObject({ state: "delivered", reportId: ID, workspaceId: config.workspaceId, channelId: config.channelId, botUserId: config.botUserId, reporterUserId: member.id });
  });
  it("keeps two report cards when they share the same issue", async () => {
    const { worker, store, slack } = fixture([record(), record(SECOND)]);
    await worker.syncReport(ID, { send: true }); await worker.syncReport(SECOND, { send: true });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(2);
    expect(store.deliveries.get(ID).rootTs).not.toBe(store.deliveries.get(SECOND).rootTs);
  });
  it("updates an existing card for progress and reopen, including unchanged source version", async () => {
    const { worker, store, slack } = fixture();
    await worker.syncReport(ID, { send: true }); const ts = store.deliveries.get(ID).rootTs;
    store.records.get(ID).status = "resolved";
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "updated" });
    store.records.get(ID).status = "open";
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "updated" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(slack.chatUpdate).toHaveBeenCalledTimes(2);
    expect(slack.chatUpdate.mock.calls.every(([payload]) => payload.ts === ts && !payload.thread_ts)).toBe(true);
  });
  it("updates freshness caveats through the real shared projection without a phase or version change", async () => {
    const store = memoryStore([record(ID, { githubDelivery: { state: "linked", fixStatus: "pending", lastSyncedAt: new Date(NOW).toISOString() } })]);
    const slack = clients(); let at = NOW;
    const worker = createBugReportSlackConsumer({ store, slack, config, now: () => at });
    const phase = progressContract.reportProgress(store.records.get(ID), { now: new Date(at) }).phase;
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "created" });
    expect(slack.chatPostMessage.mock.calls[0][0].text).not.toContain("last known progress");
    at += progressContract.STALE_AFTER_MILLIS + 1;
    expect(progressContract.reportProgress(store.records.get(ID), { now: new Date(at) }).phase).toBe(phase);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "updated" });
    expect(slack.chatUpdate.mock.calls[0][0].text).toContain("Engineering updates are out of date. This is the last known progress.");
    store.records.get(ID).githubDelivery.state = "retryable_failed";
    store.records.get(ID).githubDelivery.lastError = "PRIVATE_SENTINEL";
    expect(progressContract.reportProgress(store.records.get(ID), { now: new Date(at) }).phase).toBe(phase);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "updated" });
    expect(slack.chatUpdate.mock.calls[1][0].text).toContain("Engineering updates are unavailable. This is the last known progress.");
    store.records.get(ID).githubDelivery.state = "linked";
    store.records.get(ID).githubDelivery.lastSyncedAt = new Date(at).toISOString();
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "updated" });
    expect(slack.chatUpdate.mock.calls[2][0].text).not.toContain("last known progress");
    expect(JSON.stringify(slack.chatUpdate.mock.calls)).not.toContain("PRIVATE_SENTINEL");
    expect(store.records.get(ID).version).toBe(1);
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "unchanged" });
  });
  it("rejects stale revisions and refuses a changed authoritative snapshot during lookup", async () => {
    const { worker, store, slack } = fixture([record(ID, { version: 4 })]);
    await worker.syncReport(ID, { send: true });
    store.records.get(ID).version = 3; store.records.get(ID).status = "resolved";
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "stale_source" });
    store.records.get(ID).version = 5;
    store.records.get(ID).updatedAt = new Date(NOW - 1).toISOString();
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "stale_source" });
    store.records.get(ID).updatedAt = new Date(NOW).toISOString();
    slack.usersLookupByEmail.mockImplementationOnce(async () => { store.records.get(ID).version = 6; return { ok: true, user: member }; });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "source_changed" });
    expect(slack.chatUpdate).not.toHaveBeenCalled();
  });
  it("never retries an uncertain initial send, including expired initial leases", async () => {
    const { worker, store, slack, advance } = fixture();
    slack.chatPostMessage.mockRejectedValueOnce(new Error("PRIVATE_SENTINEL network body"));
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
    expect(JSON.stringify(store.deliveries.get(ID))).not.toContain("PRIVATE_SENTINEL");
    advance(600_000);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    store.deliveries.get(ID).state = "sending"; store.deliveries.get(ID).leaseUntil = NOW - 1;
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
  });
  it("retries known-ts edits after backoff without creating another card", async () => {
    const { worker, store, slack, advance } = fixture();
    await worker.syncReport(ID, { send: true }); store.records.get(ID).status = "resolved";
    slack.chatUpdate.mockRejectedValueOnce(new Error("PRIVATE_SENTINEL"));
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "retryable_failed" });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "backoff" });
    advance(61_000);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "updated" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.deliveries.get(ID))).not.toContain("PRIVATE_SENTINEL");
  });
  it("treats ambiguous ok:false provider errors as unknown initial sends", async () => {
    for (const error of ["internal_error", "request_timeout", "new_unrecognized_error"]) {
      const { worker, slack } = fixture();
      slack.chatPostMessage.mockResolvedValueOnce({ ok: false, error });
      expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
      expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
      expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    }
  });
  it("recovers an expired known-ts update lease and stops after five rejected attempts", async () => {
    const { worker, slack, store, advance } = fixture();
    await worker.syncReport(ID, { send: true }); store.records.get(ID).status = "resolved";
    store.deliveries.get(ID).state = "sending"; store.deliveries.get(ID).leaseUntil = NOW - 1;
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "updated" });
    store.records.get(ID).status = "open";
    slack.chatUpdate.mockResolvedValue({ ok: false, error: "ratelimited" });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: attempt === 5 ? "terminal_failed" : "retryable_failed" });
      advance(3_600_001);
    }
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "terminal_failed" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(slack.chatUpdate).toHaveBeenCalledTimes(6);
  });
  it("preserves initial-send uncertainty when writing the success receipt fails", async () => {
    const { worker, slack, store, advance } = fixture();
    const write = store.changeDelivery;
    let calls = 0;
    store.changeDelivery = (...args) => { calls += 1; if (calls === 2) throw new Error("PRIVATE_SENTINEL"); return write(...args); };
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required", code: "delivery_receipt_uncommitted" });
    advance(61_000);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
  });
  it("aborts a timed-out initial request without retrying or leaking its body", async () => {
    vi.useFakeTimers();
    try {
      const { worker, slack } = fixture();
      let signal;
      slack.chatPostMessage.mockImplementationOnce((_payload, options) => {
        signal = options.signal;
        return new Promise(() => {});
      });
      const pending = worker.syncReport(ID, { send: true });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toMatchObject({ status: "reconciliation_required" });
      expect(signal.aborted).toBe(true);
      expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
      expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("uses bounded retry-after for definitive rate-limit rejection and terminal errors", async () => {
    const { worker, slack, store, advance } = fixture();
    slack.chatPostMessage.mockResolvedValueOnce({ ok: false, error: "ratelimited", retryAfter: 120 });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "retryable_failed" });
    advance(60_000); expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "backoff" });
    advance(61_000); slack.chatPostMessage.mockResolvedValueOnce({ ok: false, error: "missing_scope", body: "PRIVATE_SENTINEL" });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "terminal_failed" });
    expect(JSON.stringify(store.deliveries.get(ID))).not.toContain("PRIVATE_SENTINEL");
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "terminal_failed" });
  });
  it("blocks changed bot, reporter identity, workspace, and channel without posting", async () => {
    const { worker, slack, store } = fixture();
    slack.authTest.mockResolvedValueOnce({ ok: true, team_id: "T99999999", user_id: config.botUserId });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked", code: "runtime_identity_unverified" });
    await worker.syncReport(ID, { send: true });
    store.records.get(ID).reporter.uid = "different-firebase-user";
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked", code: "reporter_identity_changed" });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(slack.chatUpdate).not.toHaveBeenCalled();
  });
  it("never posts when reporter lookup or runtime channel verification fails", async () => {
    const { worker, slack } = fixture();
    slack.usersLookupByEmail.mockResolvedValueOnce({ ok: false, error: "missing_scope" });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked", code: "reporter_identity_unverified" });
    slack.conversationsInfo.mockResolvedValueOnce({ ok: true, channel: { id: config.channelId, name: "general", is_member: true, is_archived: false, is_ext_shared: false } });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked", code: "runtime_channel_unverified" });
    expect(slack.chatPostMessage).not.toHaveBeenCalled();
  });
  it("skips native Premiere and automatic incident records", async () => {
    const { worker, slack } = fixture([record(ID, { environment: { native: { source: "premiere", mode: "automatic" } } })]);
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "not_boardwalk" });
    expect(slack.authTest).not.toHaveBeenCalled();
  });
  it("requires reconciliation for a post receipt with wrong ownership or target", async () => {
    const { worker, slack, store } = fixture();
    slack.chatPostMessage.mockResolvedValueOnce({ ok: true, channel: config.channelId, ts: "1234567890.111111", message: { user: "U99999999" } });
    expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "reconciliation_required" });
    expect(store.deliveries.get(ID).rootTs).toBeNull();
  });
});

describe("bounded scans", () => {
  it("uses document-ID Firestore queries and restricts all writes to private delivery state", async () => {
    const transaction = { get: vi.fn(async (ref) => ({ exists: ref.path.startsWith("bug_reports/"), data: () => record() })), set: vi.fn() };
    const query = { startAfter: vi.fn(() => query), limit: vi.fn(() => query), select: vi.fn(() => query), get: vi.fn(async () => ({ docs: [{ id: SECOND }] })) };
    const orderBy = vi.fn(() => query);
    const db = {
      collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }), orderBy }),
      runTransaction: vi.fn(async (update) => update(transaction)),
    };
    const store = createFirestoreSlackStore(db, { config });
    expect((await store.readSnapshot(ID)).record.id).toBe(ID);
    expect(db.runTransaction.mock.calls[0][1]).toEqual({ readOnly: true });
    await store.changeDelivery(ID, () => ({ next: { state: "sending" }, result: "claimed" }));
    expect(transaction.set.mock.calls[0][0].path).toBe(`bugReportSlackDeliveries/${ID}`);
    expect(db.runTransaction.mock.calls[1][1]).toEqual({ maxAttempts: 3 });
    expect(await store.listReportIds({ afterId: ID, limit: 2 })).toEqual([SECOND]);
    expect(orderBy).toHaveBeenCalledWith("__name__");
    expect(query.startAfter).toHaveBeenCalledWith(ID);
    expect(query.limit).toHaveBeenCalledWith(2);
    expect(query.select).toHaveBeenCalledWith();
    await expect(store.listReportIds({ limit: 26 })).rejects.toThrow();
  });
  it("blocks malformed dry-run rows and never mutates an unactivated runtime", async () => {
    const { store, slack } = fixture([record(ID, { version: 0 })]);
    const worker = createBugReportSlackConsumer({ store, slack, config: { ...config, activationVerified: false }, project });
    expect(await worker.runBatch()).toMatchObject({ status: "blocked" });
    expect(await worker.runBatch({ send: true })).toMatchObject({ status: "blocked", code: "runtime_activation_unverified" });
    expect(store.deliveries.size).toBe(0);
    expect(await store.readControl()).toEqual({});
    expect(slack.authTest).not.toHaveBeenCalled();
  });
  it("does not skip failed rows or equal-timestamp records across cursor restarts", async () => {
    const { worker, store, slack, advance } = fixture([record(), record(SECOND)]);
    slack.chatPostMessage.mockResolvedValueOnce({ ok: false, error: "ratelimited", retryAfter: 1 });
    const failed = await worker.runBatch({ send: true, maxReports: 2 });
    expect(failed.results).toHaveLength(1);
    expect((await store.readControl()).cursor).toBeNull();
    advance(61_000);
    const successful = await worker.runBatch({ send: true, maxReports: 2 });
    expect(successful.results.map((r) => r.reportId)).toEqual([ID, SECOND]);
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(3);
    await worker.runBatch({ send: true, maxReports: 2 });
    expect((await store.readControl()).cursor).toBeNull();
  });
  it("dry-runs a synthetic batch by default without calls, writes, or report content", async () => {
    const { worker, store, slack } = fixture([record(ID, { happened: "PRIVATE_SENTINEL" })]);
    const output = await worker.runBatch();
    expect(output).toEqual({ status: "sweep_complete", results: [{ reportId: ID, status: "dry_run" }], cursor: null });
    for (const method of Object.values(slack)) expect(method).not.toHaveBeenCalled();
    expect(store.deliveries.size).toBe(0);
    expect(await store.readControl()).toEqual({});
    expect(JSON.stringify(output)).not.toContain("PRIVATE_SENTINEL");
  });
  it("bounds one run and requires an explicit send option for delivery", async () => {
    const { worker, store, slack } = fixture([record(), record(SECOND)]);
    expect(await worker.runBatch({ maxReports: 1 })).toEqual({
      status: "bounded", results: [{ reportId: ID, status: "dry_run" }], cursor: ID,
    });
    expect(slack.chatPostMessage).not.toHaveBeenCalled();
    for (const maxReports of [0, 51, 1.5]) {
      await expect(worker.runBatch({ maxReports })).rejects.toMatchObject({ code: "batch_limit_invalid" });
    }
    expect(await worker.runBatch({ send: true, maxReports: 1 })).toEqual({
      status: "bounded", results: [{ reportId: ID, status: "created" }], cursor: ID,
    });
    expect(slack.chatPostMessage).toHaveBeenCalledTimes(1);
    expect([...store.deliveries.keys()]).toEqual([ID]);
  });
});

// The event-driven rehearsal is confined to a small, verified private channel.
describe("isolated synthetic rehearsal", () => {
  function isolated() {
    const h = fixture();
    const testConfig = { ...config, isolatedTest: {
      channelName: "boardwalk-status-test", reportIds: [ID],
      reporterUids: ["firebase-user"], memberIds: [config.botUserId, member.id],
    } };
    h.slack.conversationsInfo.mockResolvedValue({ ok: true, channel: {
      id: config.channelId, name: "boardwalk-status-test", is_member: true,
      is_private: true, is_archived: false, is_ext_shared: false,
    } });
    h.slack.conversationsMembers = vi.fn(async () => ({ ok: true,
      members: [config.botUserId, member.id], response_metadata: { next_cursor: "" } }));
    h.worker = createBugReportSlackConsumer({ store: h.store, slack: h.slack,
      config: testConfig, now: () => NOW, project });
    return { ...h, testConfig };
  }
  it("posts only an explicitly allowed fixture in the isolated channel", async () => {
    const h = isolated();
    expect(await h.worker.syncReport(ID, { send: true })).toMatchObject({ status: "created" });
    expect(h.slack.chatPostMessage).toHaveBeenCalledOnce();
    expect(h.slack.conversationsMembers).toHaveBeenCalledOnce();
  });
  it("rejects non-fixture reports before any Slack request", async () => {
    const h = isolated(); h.store.records.set(SECOND, record(SECOND));
    expect(await h.worker.syncReport(SECOND, { send: true })).toMatchObject({ status: "blocked", code: "test_report_not_allowed" });
    h.store.records.get(ID).reporter.uid = "other-staff";
    expect(await h.worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked", code: "test_report_not_allowed" });
    expect(h.slack.authTest).not.toHaveBeenCalled();
  });
  it.each([
    { members: [config.botUserId, member.id, "U99999999"] },
    { members: [config.botUserId] },
    { members: [config.botUserId, member.id], response_metadata: { next_cursor: "more" } },
    { ok: false, error: "missing_scope" },
  ])("blocks unexpected, missing, or incompletely enumerated members", async (change) => {
    const h = isolated();
    h.slack.conversationsMembers.mockResolvedValue({ ok: true, ...change });
    expect(await h.worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked", code: "test_membership_unverified" });
    expect(h.slack.chatPostMessage).not.toHaveBeenCalled();
  });
  it("rejects public channels and never lets a test configuration target tech", async () => {
    const h = isolated();
    h.slack.conversationsInfo.mockResolvedValue({ ok: true, channel: {
      id: config.channelId, name: "boardwalk-status-test", is_member: true,
      is_private: false, is_archived: false, is_ext_shared: false,
    } });
    expect(await h.worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked" });
    expect(() => createBugReportSlackConsumer({ store: h.store, slack: h.slack,
      config: { ...h.testConfig, isolatedTest: { ...h.testConfig.isolatedTest, channelName: "tech" } } })).toThrow();
    expect(h.slack.chatPostMessage).not.toHaveBeenCalled();
  });
});


it("classifies read-only verification rate limiting without attempting a post", async () => {
  const h = fixture();
  h.slack.authTest.mockResolvedValueOnce({ ok: false, error: "ratelimited", retryAfter: 30 });
  expect(await h.worker.syncReport(ID, { send: true })).toMatchObject({ status: "blocked", code: "verification_retry_required", retryAfterMs: 30_000 });
  expect(h.slack.chatPostMessage).not.toHaveBeenCalled();
  expect(await h.worker.syncReport(ID, { send: true })).toMatchObject({ status: "created" });
});


it("snapshots its configuration so host mutation cannot retarget a consumer", async () => {
  const localConfig = structuredClone(config); const h = fixture();
  const worker = createBugReportSlackConsumer({ store: h.store, slack: h.slack, config: localConfig, now: () => NOW });
  localConfig.channelId = "C87654321";
  expect(await worker.syncReport(ID, { send: true })).toMatchObject({ status: "created" });
  expect(h.slack.chatPostMessage.mock.calls[0][0].channel).toBe(config.channelId);
});


it("requires a rehearsal with only the bot and one approved tester", () => {
  const testConfig = { ...config, isolatedTest: { channelName: "boardwalk-status-test", reportIds: [ID],
    reporterUids: ["firebase-user"], memberIds: [config.botUserId, member.id, "U99999999"] } };
  expect(() => createBugReportSlackConsumer({ store: {}, slack: {}, config: testConfig })).toThrow("test_configuration_invalid");
});
