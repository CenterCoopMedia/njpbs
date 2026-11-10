"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BoardwalkClient } = require("../client.js");

function secureStorage() {
  const data = new Map();
  return {
    async setItem(key, value) { data.set(key, new Uint8Array(Buffer.from(value))); },
    async getItem(key) { if (!data.has(key)) throw new Error("Not found"); return data.get(key); },
    async removeItem(key) { data.delete(key); },
  };
}
test("a 30-day connection restores across host restarts, including Unicode names", async () => {
  const storage = secureStorage();
  const session = { sessionToken: `pds_${"A".repeat(43)}`, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), user: { uid: "staff-fixture", displayName: "Renée" } };
  await new BoardwalkClient(storage).remember(session);
  assert.deepEqual(await new BoardwalkClient(storage).restore(), session);
});
test("expired and revoked sessions cannot keep a signed-in local state", async () => {
  const storage = secureStorage();
  const client = new BoardwalkClient(storage, async () => Response.json({ error: "Session revoked" }, { status: 401 }));
  await client.remember({ sessionToken: `pds_${"A".repeat(43)}`, user: { uid: "staff-fixture", displayName: "Staff" }, expiresAt: "2000-01-01T00:00:00Z" });
  assert.equal(await client.restore(), null);
  await client.remember({ sessionToken: `pds_${"A".repeat(43)}`, user: { uid: "staff-fixture", displayName: "Staff" }, expiresAt: "2099-01-01T00:00:00Z" });
  await assert.rejects(client.request("session"), /revoked/);
  assert.equal(await new BoardwalkClient(storage).restore(), null);
});
test("failed revocation keeps the local credential so sign-out can be retried", async () => {
  const storage = secureStorage();
  const client = new BoardwalkClient(storage, async () => Response.json({ error: "Offline" }, { status: 503 }));
  await client.remember({ sessionToken: `pds_${"A".repeat(43)}`, user: { uid: "staff-fixture", displayName: "Staff" }, expiresAt: "2099-01-01T00:00:00Z" });
  await assert.rejects(client.signOut(), /Offline/);
  assert.ok(await new BoardwalkClient(storage).restore());
});

test("requests without cancellation omit signal for UXP fetch", async () => {
  // Premiere 26.5.2 tries to subscribe to an explicitly undefined signal.
  const client = new BoardwalkClient(secureStorage(), async (_url, options) => {
    if (Object.hasOwn(options, "signal")) options.signal.addEventListener("abort", () => {});
    return Response.json({ status: "pending" });
  });
  assert.deepEqual(await client.post("cmsStartPremierePairing", {}), { status: "pending" });
  assert.deepEqual(await client.post("cmsPollPremierePairing", {}, { signal: new AbortController().signal }), { status: "pending" });
});

test("diagnostics retain the gateway correlation ID from its response header", async () => {
  const requestId = "c107b0aa-3858-4659-abba-93f3a67a5c5f";
  const client = new BoardwalkClient(secureStorage(), async () =>
    Response.json({ status: "pending" }, { headers: { "X-NJPBS-Request-ID": requestId } }));
  let result;
  client.onResult = value => { result = value; };
  await client.post("cmsStartPremierePairing", {});
  assert.equal(result.requestId, requestId);
  assert.equal(result.outcome, "success");
});

test("a late rejection of an old request cannot clear a newer connection", async () => {
  const storage = secureStorage();
  let rejectOldSession;
  const client = new BoardwalkClient(storage, () => new Promise(resolve => { rejectOldSession = resolve; }));
  const oldSession = { sessionToken: `pds_${"A".repeat(43)}`, user: { uid: "old-fixture", displayName: "Old account" }, expiresAt: "2099-01-01T00:00:00Z" };
  const newSession = { ...oldSession, sessionToken: `pds_${"B".repeat(43)}`, user: { uid: "new-fixture", displayName: "New account" } };
  await client.remember(oldSession);
  const rejected = assert.rejects(client.request("cmsListSourceMedia"), /Session revoked/);
  await client.remember(newSession);
  rejectOldSession(Response.json({ error: "Session revoked" }, { status: 401 }));
  await rejected;
  assert.deepEqual(await new BoardwalkClient(storage).restore(), newSession);
});
