import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import preview from "../../functions/preview.js";
import wait from "../../functions/lib/preview-status-wait.js";
const { createCmsPreviewStatusHandler } = preview;
const queueId = "a".repeat(20);
const stamp = value => ({ toMillis: () => value });
let callbacks;
let unsubscribe;
let queueRef;
let req;
let res;
let current;
let content;
let subscribed;
let signalSubscribed;
const snapshot = data => ({ exists: data !== null, data: () => data });
const actor = {
  uid: "staff",
  principal: { id: "staff", grants: [{ role: "admin" }] },
};
function body(fields = {}) {
  return { status: "building", transport: "serializer", persistent: false,
    pageId: "home", collection: "cmsPages", sourceVersion: 7, rendererSha: "b".repeat(40), pagePath: "/",
    requestedAt: stamp(Date.now()), expiresAt: stamp(Date.now() + 60000), ...fields };
}
function response() {
  const result = new EventEmitter();
  result.status = vi.fn(() => result);
  result.json = vi.fn(() => { result.headersSent = true; return result; });
  return result;
}
function handler(auth = vi.fn(async () => actor)) {
  const tx = { get: vi.fn(async () => snapshot(current)), update: vi.fn((ref, fields) => { current = { ...current, ...fields }; }) };
  const contentRef = { get: vi.fn(async () => snapshot(content)) };
  const firestore = { collection: vi.fn(name => ({
    doc: vi.fn(() => ["cmsPages", "cmsPosts"].includes(name) ? contentRef : queueRef),
  })),
    runTransaction: vi.fn(callback => callback(tx)) };
  return { run: createCmsPreviewStatusHandler({ firestore, requirePrincipalFn: auth, log: { error: vi.fn(), warn: vi.fn() } }), auth, firestore, tx };
}
async function begin(instance = handler()) {
  const running = instance.run(req, res);
  await Promise.race([subscribed, running]);
  return { ...instance, running };
}
function emit(data) { current = data; callbacks.next(snapshot(data)); }
function cleaned() {
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(req.listenerCount("aborted")).toBe(0);
  expect(res.listenerCount("close")).toBe(0);
  expect(res.listenerCount("finish")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
  content = { status: "draft", createdBy: "staff", section: "news" };
  subscribed = new Promise(resolve => { signalSubscribed = resolve; });
  current = body(); unsubscribe = vi.fn(); callbacks = undefined;
  queueRef = { get: vi.fn(async () => snapshot(current)), onSnapshot: vi.fn((next, error) => { callbacks = { next, error }; signalSubscribed(); return unsubscribe; }) };
  req = Object.assign(new EventEmitter(), { method: "POST", body: { queueId, waitMs: 5000, observedStatus: "building" } });
  res = response();
});
afterEach(() => { vi.useRealTimers(); });

it.each(["pending", "ready", "failed"])("returns a changed %s state and reauthorizes after waiting", async status => {
  const test = await begin(); emit(current);
  expect(res.json).not.toHaveBeenCalled();
  emit(body({ status })); await test.running;
  expect(res.json.mock.calls[0][0].status).toBe(status);
  expect(test.auth).toHaveBeenCalledTimes(2);
  expect(queueRef.get).toHaveBeenCalledTimes(1);
  cleaned();
});
it("returns an already-advanced first snapshot without holding the request", async () => {
  req.body.observedStatus = "pending";
  const test = await begin(); emit(current); await test.running;
  expect(res.json.mock.calls[0][0].status).toBe("building");
  expect(test.auth).toHaveBeenCalledTimes(1); cleaned();
});

it.each([
  { status: "building", fields: { contextRefreshing: true } },
  { status: "failed", fields: { failureReason: "preview_context_refreshing" } },
])("returns bounded refresh metadata for $status through the existing status API", async ({ status, fields }) => {
  req.body.observedStatus = "pending";
  const test = await begin(); emit(body({ status, ...fields })); await test.running;
  expect(res.json.mock.calls[0][0]).toMatchObject({ status, ...fields });
  cleaned();
});
it("returns deletion as 404 after reauthorization", async () => {
  const test = await begin(); emit(current); emit(null); await test.running;
  expect(res.status).toHaveBeenCalledWith(404); expect(test.auth).toHaveBeenCalledTimes(2); cleaned();
});
it.each([401, 403])("does not disclose status when delayed authorization rejects with %s", async status => {
  const auth = vi.fn().mockResolvedValueOnce(actor).mockRejectedValueOnce(Object.assign(new Error("Access denied"), { status }));
  const test = await begin(handler(auth)); emit(current); emit(body({ status: "ready" })); await test.running;
  expect(res.status).toHaveBeenCalledWith(status);
  expect(res.json.mock.calls[0][0]).toEqual({ error: "Access denied" }); cleaned();
});
it.each(["bound", "expiry", "build"])("settles on the server %s deadline without another status read", async kind => {
  if (kind === "expiry") current.expiresAt = stamp(Date.now() + 100);
  if (kind === "build") current.requestedAt = stamp(Date.now() - 45 * 60000 + 100);
  const test = await begin(); emit(current);
  await vi.advanceTimersByTimeAsync(kind === "bound" ? 5000 : 100); await test.running;
  expect(res.json.mock.calls[0][0].status).toBe(kind === "bound" ? "building" : kind === "expiry" ? "expired" : "failed");
  expect(test.tx.update).toHaveBeenCalledTimes(kind === "build" ? 1 : 0);
  expect(test.auth).toHaveBeenCalledTimes(2); cleaned();
});
it("does not extend the request budget after same-status document updates", async () => {
  const test = await begin(); emit(current);
  await vi.advanceTimersByTimeAsync(4000); emit(body());
  await vi.advanceTimersByTimeAsync(1000); await test.running;
  expect(res.json.mock.calls[0][0].status).toBe("building"); cleaned();
});
it("cleans up a listener error without returning raw provider diagnostics", async () => {
  const test = await begin(); emit(current); callbacks.error(new Error("private provider details")); await test.running;
  expect(res.json.mock.calls[0][0]).toEqual({ error: "Preview status wait unavailable" }); cleaned();
});
it.each(["aborted", "close", "finish"])("cleans up on %s and ignores late snapshots", async event => {
  const test = await begin(); emit(current);
  if (event === "aborted") { req.aborted = true; req.emit(event); }
  else { res.destroyed = true; res.emit(event); }
  emit(body({ status: "ready" })); await test.running;
  expect(res.json).not.toHaveBeenCalled(); cleaned();
});
it("cleans up when the initial listener never produces a snapshot", async () => {
  const test = await begin(); await vi.advanceTimersByTimeAsync(5000); await test.running;
  expect(res.status).toHaveBeenCalledWith(500); cleaned();
});
it("unsubscribes even when a terminal callback runs synchronously during registration", async () => {
  queueRef.onSnapshot = next => { next(snapshot(null)); return unsubscribe; };
  await wait.waitForPreviewStatus({ queueRef, req, res, waitMs: 5000, inspect: () => null }); cleaned();
});
it("preserves ordinary addressed callers without a listener", async () => {
  delete req.body.waitMs; delete req.body.observedStatus;
  const test = handler(); await test.run(req, res);
  expect(queueRef.get).toHaveBeenCalledTimes(1); expect(queueRef.onSnapshot).not.toHaveBeenCalled();
});
it("rejects a persistent status row with an invalid content target", async () => {
  current = body({ persistent: true, collection: "invalid" });
  const test = await begin();
  if (callbacks) emit(current);
  await test.running;
  expect(res.status).toHaveBeenCalledWith(404);
  expect(test.auth).toHaveBeenCalledTimes(1);
  expect(queueRef.onSnapshot).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps the page-head path independent of wait options", async () => {
  req.body = { pageId: "home", waitMs: 5000, observedStatus: "building" }; current = {};
  const test = handler(); await test.run(req, res);
  expect(queueRef.onSnapshot).not.toHaveBeenCalled(); expect(test.auth).toHaveBeenCalledTimes(1);
});
it.each([0, 5001, -1, 1.5, "5000"])("rejects invalid wait duration %s before reading", async waitMs => {
  req.body.waitMs = waitMs; const test = handler(); await test.run(req, res);
  expect(res.status).toHaveBeenCalledWith(400); expect(queueRef.onSnapshot).not.toHaveBeenCalled();
});
it("does not subscribe when initial authorization fails", async () => {
  const test = handler(vi.fn().mockRejectedValue(Object.assign(new Error("Access denied"), { status: 401 })));
  await test.run(req, res);
  expect(res.status).toHaveBeenCalledWith(401); expect(queueRef.onSnapshot).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not treat ordinary request close as a disconnect", async () => {
  const test = await begin(); emit(current); req.emit("close");
  expect(res.json).not.toHaveBeenCalled(); expect(unsubscribe).not.toHaveBeenCalled();
  emit(body({ status: "ready" })); await test.running; cleaned();
});
it("cleans up synchronous listener registration failure", async () => {
  queueRef.onSnapshot = () => { throw new Error("private provider failure"); };
  const test = handler(); await test.run(req, res);
  expect(res.json.mock.calls[0][0]).toEqual({ error: "Preview status wait unavailable" });
  expect(req.listenerCount("aborted")).toBe(0); expect(res.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects an observed terminal status instead of allowing it to hold a request", async () => {
  req.body.observedStatus = "ready"; const test = handler(); await test.run(req, res);
  expect(res.status).toHaveBeenCalledWith(400); expect(queueRef.onSnapshot).not.toHaveBeenCalled();
});

it.each(["missing job", "missing record"])("refuses %s before starting a status wait", async kind => {
  const principal = { id: "other-writer", grants: [{ role: "contributor" }] };
  if (kind === "missing job") current = null;
  if (kind === "missing record") content = null;
  const test = await begin(handler(vi.fn(async () => ({ uid: principal.id, principal }))));
  if (callbacks) emit(current ? body({ status: "ready" }) : null);
  await test.running;
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json.mock.calls[0][0]).toEqual({ error: "Preview request not found" });
  expect(queueRef.onSnapshot).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["deletion", "soft deletion", "archive"])("rechecks stored %s after the status wait", async kind => {
  const principal = kind === "area"
    ? { id: "staff", grants: [{ role: "editor", sections: ["news"] }] }
    : { id: "staff", grants: [{ role: "contributor" }] };
  current.collection = "cmsPosts";
  const test = await begin(handler(vi.fn(async () => ({ uid: "staff", principal }))));
  // An allowed reader must reach the wait before the stored record changes.
  expect(queueRef.onSnapshot).toHaveBeenCalledTimes(1);
  emit(current);
  content = kind === "deletion" ? null : { ...content,
    ...(kind === "area" ? { section: "watch" }
      : kind === "soft deletion" ? { deleted: true }
        : kind === "archive" ? { status: "archived" } : { createdBy: "other-writer" }) };
  emit({ ...current, status: "ready" });
  await test.running;
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json.mock.calls[0][0]).toEqual({ error: "Preview request not found" });
  cleaned();
});

it("returns a valid persistent status from the first snapshot without waiting", async () => {
  current = body({ persistent: true });
  const test = await begin(); emit(current); await test.running;
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json.mock.calls[0][0].status).toBe("building");
  expect(test.auth).toHaveBeenCalledTimes(1); cleaned();
});

it.each(["ownership", "area"])("keeps active staff access across a stored %s change during a wait", async kind => {
  const principal = { id: "staff", grants: [{ role: "contributor" }] };
  const test = await begin(handler(vi.fn(async () => ({ uid: "staff", principal }))));
  emit(current);
  content = { ...content, ...(kind === "area" ? { section: "watch" } : { createdBy: "other" }) };
  emit({ ...current, status: "ready" });
  await test.running;
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json.mock.calls[0][0].status).toBe("ready");
  cleaned();
});
