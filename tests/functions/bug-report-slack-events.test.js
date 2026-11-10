import { describe, expect, it, vi } from "vitest";
import events from "../../functions/lib/bug-report-slack-events.js";
import slackReports from "../../functions/lib/bug-report-slack.js";

const ID = `br_${"a".repeat(32)}`;
const SECOND = `br_${"b".repeat(32)}`;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const config = {
  workspaceId: "T12345678", channelId: "C12345678", botUserId: "U12345678",
  identity: { mode: "email-lookup", lookupAuthorized: true }, activationVerified: true,
  isolatedTest: { channelName: "boardwalk-status-test", reportIds: [ID, SECOND],
    reporterUids: ["synthetic-owner"], memberIds: ["U12345678", "U87654321"] },
};
function record(id = ID) {
  return { id, category: "bug", area: "other", status: "open", version: 1,
    updatedAt: new Date(NOW).toISOString(), reporter: { uid: "synthetic-owner", email: "fixture@example.test" }, links: {} };
}
function fixture() {
  let at = NOW; let control = {}; let chain = Promise.resolve();
  const reports = new Map([[ID, record()], [SECOND, record(SECOND)]]);
  const jobs = new Map();
  const store = { changeWork: (id, fn) => {
    const pending = chain.then(() => {
      const change = fn({ record: structuredClone(reports.get(id)), work: structuredClone(jobs.get(id)), control: structuredClone(control) });
      if (change.work) jobs.set(id, structuredClone(change.work));
      if (change.control) control = structuredClone(change.control);
      return change.result;
    });
    chain = pending.catch(() => {}); return pending;
  } };
  const consumer = { binding: slackReports.slackConfigBinding(config), syncReport: vi.fn(async (id) => ({ reportId: id, status: "created" })) };
  const runtime = events.createBugReportSlackEvents({ store, consumer, config, now: () => at });
  return { reports, jobs, store, consumer, runtime, advance: ms => { at += ms; } };
}

describe("dormant report event outbox", () => {
  it("requires an explicit isolated test target and activates nothing on construction", () => {
    const h = fixture();
    expect(h.jobs.size).toBe(0); expect(h.consumer.syncReport).not.toHaveBeenCalled();
    expect(() => events.createBugReportSlackEvents({ ...h, config: { ...config, isolatedTest: undefined } })).toThrow();
    expect(() => events.createBugReportSlackEvents({ ...h, config: { ...config, activationVerified: false } })).toThrow();
  });
  it("deduplicates duplicate events and ignores stale/untrusted payloads", async () => {
    const h = fixture();
    const event = { params: { reportId: ID }, data: { after: { status: "resolved", happened: "PRIVATE_CANARY" } } };
    expect(await h.runtime.reportWritten(event)).toMatchObject({ status: "done" });
    expect(await h.runtime.reportWritten(event)).toMatchObject({ status: "done" });
    expect(h.consumer.syncReport).toHaveBeenCalledOnce();
    expect(JSON.stringify([...h.jobs.values()])).not.toMatch(/PRIVATE_CANARY|fixture@example.test/);
  });
  it("coalesces changes and leaves newer work pending when a send is in flight", async () => {
    const h = fixture(); let finish; let started;
    const gate = new Promise(resolve => { finish = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    h.consumer.syncReport.mockImplementationOnce(async id => { started(); await gate; return { reportId: id, status: "created" }; });
    const pending = h.runtime.reportWritten({ params: { reportId: ID } });
    await entered;
    Object.assign(h.reports.get(ID), { status: "in_progress", version: 2 });
    expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "busy" });
    finish(); expect(await pending).toMatchObject({ status: "pending" });
    expect(h.jobs.get(ID)).toMatchObject({ state: "pending", generation: 2 });
    h.advance(1_100);
    expect(await h.runtime.workWritten({ params: { reportId: ID } })).toMatchObject({ status: "done" });
    expect(h.consumer.syncReport).toHaveBeenCalledTimes(2);
  });
  it("serializes a channel and persists pacing across consumers", async () => {
    const h = fixture();
    const output = await Promise.all([ID, SECOND].map(reportId => h.runtime.reportWritten({ params: { reportId } })));
    expect(output.filter(row => row.status === "done")).toHaveLength(1);
    expect(h.consumer.syncReport).toHaveBeenCalledOnce();
    h.advance(1_100);
    const other = output.find(row => row.status !== "done").reportId;
    expect(await h.runtime.workWritten({ params: { reportId: other } })).toMatchObject({ status: "done" });
  });
  it("retains ambiguous creation for human reconciliation, never reposting on newer events", async () => {
    const h = fixture();
    h.consumer.syncReport.mockResolvedValueOnce({ reportId: ID, status: "reconciliation_required" });
    expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "blocked" });
    Object.assign(h.reports.get(ID), { status: "in_progress", version: 2 });
    h.advance(300_000);
    expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "blocked" });
    expect(h.consumer.syncReport).toHaveBeenCalledOnce();
  });
  it("does not let a blocked first report starve a later report during reconciliation", async () => {
    const h = fixture();
    h.consumer.syncReport.mockResolvedValueOnce({ reportId: ID, status: "reconciliation_required" });
    await h.runtime.reportWritten({ params: { reportId: ID } }); h.advance(300_000);
    const output = await h.runtime.reconcile();
    expect(output.results.find(row => row.reportId === SECOND)).toMatchObject({ status: "done" });
  });
  it("recovers missed create events and current freshness without an LLM", async () => {
    const h = fixture(); h.reports.delete(SECOND);
    expect(await h.runtime.reconcile()).toMatchObject({ results: [{ reportId: ID, status: "done" }, { reportId: SECOND, status: "skipped" }] });
    h.advance(300_000);
    await h.runtime.reconcile(); expect(h.consumer.syncReport).toHaveBeenCalledOnce();
    h.reports.get(ID).githubDelivery = { state: "synced", lastSyncedAt: new Date(NOW).toISOString() };
    h.reports.get(ID).links = { githubIssues: [{ number: 12, state: "open" }] };
    await h.runtime.reconcile();
    h.advance(27 * 60 * 60 * 1000);
    await h.runtime.reconcile(); expect(h.consumer.syncReport).toHaveBeenCalledTimes(2);
  });
  it("bounds retries and refuses source outside the fixture allowlist", async () => {
    const h = fixture();
    h.consumer.syncReport.mockResolvedValue({ reportId: ID, status: "source_changed" });
    for (let n = 0; n < 5; n++) { await h.runtime.reportWritten({ params: { reportId: ID } }); h.advance(300_000); }
    expect(h.jobs.get(ID).state).toBe("blocked");
    const count = h.consumer.syncReport.mock.calls.length;
    await h.runtime.reportWritten({ params: { reportId: ID } });
    expect(h.consumer.syncReport).toHaveBeenCalledTimes(count);
    expect(await h.runtime.reportWritten({ params: { reportId: `br_${"c".repeat(32)}` } })).toMatchObject({ status: "skipped" });
  });
  it("reclaims an expired work lease through the existing conservative delivery consumer", async () => {
    const h = fixture(); await h.runtime.enqueue(ID);
    Object.assign(h.jobs.get(ID), { state: "running", leaseUntil: NOW - 1, leaseToken: "expired" });
    h.consumer.syncReport.mockResolvedValue({ reportId: ID, status: "reconciliation_required" });
    expect(await h.runtime.workWritten({ params: { reportId: ID } })).toMatchObject({ status: "blocked" });
    expect(h.consumer.syncReport).toHaveBeenCalledOnce();
  });
  it("keeps storage and provider errors private and durable", async () => {
    const h = fixture(); h.consumer.syncReport.mockRejectedValue(new Error("PRIVATE_CANARY"));
    expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "retry" });
    expect(JSON.stringify([...h.jobs.values()])).not.toContain("PRIVATE_CANARY");
  });
});


it("does not exhaust attempts while the delivery consumer respects a long Retry-After", async () => {
  const h = fixture(); h.consumer.syncReport.mockResolvedValue({ reportId: ID, status: "backoff" });
  for (let n = 0; n < 12; n++) { await h.runtime.reportWritten({ params: { reportId: ID } }); h.advance(300_000); }
  expect(h.jobs.get(ID)).toMatchObject({ state: "retry", attempts: 0 });
  h.consumer.syncReport.mockResolvedValue({ reportId: ID, status: "updated" });
  expect(await h.runtime.workWritten({ params: { reportId: ID } })).toMatchObject({ status: "done" });
});

it("does not reflect an invalid event path in diagnostic output", async () => {
  const h = fixture(); const result = await h.runtime.reportWritten({ params: { reportId: "PRIVATE_CANARY" } });
  expect(result).toEqual({ reportId: null, status: "skipped" });
});


it.each(["request_uncertain", "verification_retry_required", "source_read_failed", "delivery_claim_failed"])("recovers transient pre-send failure %s", async code => {
  const h = fixture(); h.consumer.syncReport.mockResolvedValueOnce({ reportId: ID, status: "blocked", code });
  expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "retry" });
  h.advance(300_000);
  expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "done" });
});


it("rejects a real consumer configured for a different channel or isolation policy", () => {
  const h = fixture();
  const staffConfig = { ...config, channelId: "C87654321", isolatedTest: undefined };
  const wrongConsumer = slackReports.createBugReportSlackConsumer({ store: {}, slack: {}, config: staffConfig });
  expect(() => events.createBugReportSlackEvents({ store: h.store, consumer: wrongConsumer, config })).toThrow("event_consumer_binding_mismatch");
  expect(() => events.createBugReportSlackEvents({ store: h.store, consumer: { syncReport() {} }, config })).toThrow("event_consumer_binding_mismatch");
});

it("retains long read-side Retry-After without consuming attempts before it is due", async () => {
  const h = fixture(); h.consumer.syncReport.mockResolvedValueOnce({ reportId: ID, status: "blocked", code: "verification_retry_required", retryAfterMs: 1_800_000 });
  expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "retry" });
  for (let n = 0; n < 5; n++) { h.advance(300_000); expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "backoff" }); }
  expect(h.consumer.syncReport).toHaveBeenCalledOnce();
  h.advance(300_000);
  expect(await h.runtime.workWritten({ params: { reportId: ID } })).toMatchObject({ status: "done" });
});


it("retains provider cooldown across new source generations and other reports", async () => {
  const h = fixture(); h.consumer.syncReport.mockResolvedValueOnce({ reportId: ID, status: "blocked", code: "verification_retry_required", retryAfterMs: 1_800_000 });
  await h.runtime.reportWritten({ params: { reportId: ID } });
  Object.assign(h.reports.get(ID), { status: "in_progress", version: 2 });
  h.advance(300_000);
  expect(await h.runtime.reportWritten({ params: { reportId: ID } })).toMatchObject({ status: "backoff" });
  expect(await h.runtime.reportWritten({ params: { reportId: SECOND } })).toMatchObject({ status: "backoff" });
  expect(h.consumer.syncReport).toHaveBeenCalledOnce();
});
