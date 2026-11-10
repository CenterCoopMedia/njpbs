"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Reports, safeEvent, reportContext, expectedError } = require("../reports.js");
const { BoardwalkClient } = require("../client.js");

async function fixture(t, send) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "boardwalk-reports-"));
  let uid = "editor-a";
  let now = Date.parse("2026-10-03T18:00:00Z");
  const store = {
    async read(account) { try { return await fs.readFile(path.join(directory, account), "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    write: (account, data) => fs.writeFile(path.join(directory, account), data),
  };
  const options = { store, account: () => uid, now: () => now, uuid: randomUUID,
    context: () => ({ pluginVersion: "0.1.1", premiereVersion: "26.5.2.5", uxpVersion: "uxp-9.3.0", platform: "win32", view: "library" }), send };
  const reports = new Reports(options);
  t.after(async () => { await reports.writes; await fs.rm(directory, { recursive: true, force: true }); });
  await reports.setAccount(uid);
  return { reports, options, store, setUid: value => { uid = value; }, advance: delta => { now += delta; } };
}

test("the durable journal bounds events and excludes arbitrary diagnostic data", async t => {
  const { reports, store, advance } = await fixture(t, async () => { throw new Error("offline"); });
  const secret = "pds_" + "A".repeat(43);
  for (let index = 0; index < 130; index++) reports.record({ operation: "library.list", outcome: "success", durationMs: index,
    message: secret, url: "https://bucket.s3.us-east-2.amazonaws.com/private.mov?X-Amz-Signature=secret",
    path: "C:\\Users\\private\\interview.mov", headers: { Authorization: secret }, body: { name: "Confidential title" } });
  await reports.persist();
  const text = await store.read("editor-a");
  const data = JSON.parse(text);
  assert.equal(data.events.length, 100);
  assert.equal(data.events[0].durationMs, 30);
  assert.deepEqual(Object.keys(data.events[0]).sort(), ["durationMs", "operation", "outcome", "timestamp"]);
  assert.doesNotMatch(text, /pds_|private|interview|Confidential|X-Amz|Authorization/);
  assert.ok(Buffer.byteLength(text) < 65536);
  advance(86400001);
  await reports.persist();
  assert.equal(JSON.parse(await store.read("editor-a")).events.length, 0);
  assert.equal(safeEvent({ timestamp: new Date().toISOString(), operation: secret, outcome: "failure" }, Date.now()), null);
  assert.equal(reportContext({ pluginVersion: secret, premiereVersion: "26.5.2.5", uxpVersion: "uxp-9.3.0", platform: "win32", view: "library", path: secret }).uxpVersion, "9.3.0");
});

test("manual retries across restarts retain the exact receipt key, payload and account", async t => {
  const delivered = [];
  let offline = true;
  const f = await fixture(t, async payload => {
    delivered.push(structuredClone(payload));
    if (offline) throw new Error("Connection lost after submission");
    return { success: true, mode: "manual", idempotent: true, report: { id: "br_" + "a".repeat(32) } };
  });
  await assert.rejects(f.reports.submitManual("Import stopped after download"), /Connection lost/);
  const restarted = new Reports(f.options);
  await restarted.setAccount("editor-a");
  assert.equal(restarted.manual.description, "Import stopped after download");
  offline = false;
  assert.equal(await restarted.submitManual("This edit must not create a different report"), "br_" + "a".repeat(32));
  assert.deepEqual(delivered[1], delivered[0]);
  assert.equal(restarted.manual, null);
  f.setUid("editor-b");
  await restarted.setAccount("editor-b");
  assert.deepEqual(restarted.events, []);
  assert.equal(restarted.manual, null);
  restarted.record({ operation: "media.import", outcome: "failure", code: "premiere" }, "editor-a");
  assert.deepEqual(restarted.events, [], "a late failure from another account is ignored");
  await restarted.persist();
});

test("automatic failure retries keep their payload; reporting errors and expected cancellations never recurse", async t => {
  const attempts = [];
  let offline = true;
  const f = await fixture(t, async payload => {
    attempts.push(structuredClone(payload));
    if (offline) throw Object.assign(new Error("offline"), { status: 503 });
    return { success: true, mode: "automatic", accepted: true, deduplicated: true, repeatCount: 1 };
  });
  await assert.rejects(f.reports.measure("media.import", async () => { throw expectedError("Open a project"); }), /Open a project/);
  f.reports.record({ operation: "auth.restore", outcome: "failure", status: 401, code: "http" });
  f.reports.record({ operation: "library.list", outcome: "failure", status: 429, code: "http" });
  f.reports.record({ operation: "report.submit", outcome: "failure", status: 503, code: "http" });
  await f.reports.persist();
  assert.equal(attempts.length, 0);
  await assert.rejects(f.reports.measure("media.import", async () => { throw new Error("Sensitive video title and local path"); }));
  await f.reports.persist();
  assert.equal(attempts.length, 1);
  await f.reports.flush();
  assert.equal(attempts.length, 1, "offline failures respect the retry delay");
  f.advance(30000);
  offline = false;
  await f.reports.flush();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.doesNotMatch(JSON.stringify(attempts), /Sensitive|local path/);
  assert.equal(f.reports.automatic.length, 0);
});

test("expired sessions retain reports for the same account after reconnecting", async t => {
  const attempts = [];
  let expired = true;
  const f = await fixture(t, async payload => {
    attempts.push(structuredClone(payload));
    if (expired) throw Object.assign(new Error("Session expired"), { status: 401 });
    return payload.mode === "manual"
      ? { success: true, mode: "manual", report: { id: "br_" + "b".repeat(32) } }
      : { success: true, mode: "automatic", accepted: true };
  });
  await assert.rejects(f.reports.submitManual("The selected video did not import"), /Session expired/);
  // A late failure queues while disconnected; await its 401 before changing accounts.
  f.setUid(null);
  f.reports.record({ operation: "media.import", outcome: "failure", code: "premiere" }, "editor-a");
  await f.reports.persist();
  f.setUid("editor-a");
  await f.reports.flush();
  const beforeReconnect = JSON.parse(await f.store.read("editor-a"));
  assert.equal(beforeReconnect.manual.description, "The selected video did not import");
  assert.equal(beforeReconnect.automatic.length, 1);
  f.setUid("editor-b");
  await f.reports.setAccount("editor-b");
  assert.equal(f.reports.manual, null);
  assert.deepEqual(f.reports.automatic, []);
  f.setUid("editor-a");
  expired = false;
  await f.reports.setAccount("editor-a");
  assert.equal(await f.reports.submitManual(""), "br_" + "b".repeat(32));
  await f.reports.flush();
  assert.deepEqual(attempts[2], attempts[0]);
  assert.deepEqual(attempts[3], attempts[1]);
  assert.equal(f.reports.manual, null);
  assert.deepEqual(f.reports.automatic, []);
});

test("a diagnostics or filesystem failure cannot replace the result of a media request", async t => {
  const f = await fixture(t, async () => { throw new Error("Reporting down"); });
  f.reports.store = { read: async () => null, write: async () => { throw new Error("Disk full"); } };
  assert.equal(await f.reports.measure("media.import", async () => "imported"), "imported");
  await f.reports.persist();
  assert.equal(f.reports.storageAvailable, false);
  const client = new BoardwalkClient({}, async () => new Response(JSON.stringify({ records: [] }), { status: 200 }));
  client.session = { sessionToken: "pds_" + "A".repeat(43), user: { uid: "editor-a" } };
  client.onResult = () => { throw new Error("Logger failed"); };
  assert.deepEqual(await client.request("cmsListSourceMedia"), { records: [] });
});

test("an account change while saving a manual draft cannot submit it as the next user", async t => {
  let delivered = 0;
  const f = await fixture(t, async () => { delivered++; });
  let release;
  const originalWrite = f.store.write;
  f.store.write = async (uid, data) => { await new Promise(resolve => { release = resolve; }); await originalWrite(uid, data); };
  const pending = f.reports.submitManual("The import stopped unexpectedly");
  const rejection = assert.rejects(pending, /account changed/i);
  await new Promise(resolve => setImmediate(resolve));
  f.setUid("editor-b");
  const nextAccount = f.reports.setAccount("editor-b");
  release();
  await Promise.all([rejection, nextAccount]);
  assert.equal(delivered, 0);
  assert.equal(f.reports.manual, null);
});
