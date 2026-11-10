import { beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { bridgeFixture } from "../helpers/cms-reader-bridge.js";
const require = createRequire(import.meta.url);
const { createVersionedCmsReaderHandler, readerIdentities } = require("../../functions/lib/cms-versioned-reader.js");
const sessions = require("../../functions/lib/cms-reader-session.js");
const { markSessionRefused } = require("../../functions/lib/session-refusal.js");
const { createCmsGetPublicPageHandler } = require("../../functions/public-content.js");
const { createCmsPreviewStatusHandler } = require("../../functions/preview.js");
import { createInstalledReaderTransport } from "../../admin/src/lib/installed-reader-transport";
import { createCmsReaderBridge } from "../../cms-api/src/cms-reader-bridge";
const db = isolatedFirestore("cms-versioned-reader");
const actor = { uid: "staff", principal: { id: "staff", grants: [{ role: "admin" }] } };
const sessionIds = { functions: "11111111-1111-4111-8111-111111111111", cmsApi: "22222222-2222-4222-8222-222222222222" };
let time, readers, identities;
function req(body, headers = {}) {
  return { method: "POST", is: value => value === "application/json", headers: {
    "x-njpbs-cms-edge": "fixture-edge", "x-njpbs-cms-reader": identities.cmsApi, ...headers,
  }, body };
}
function res() {
  return { statusCode: 0, headers: {}, headersSent: false, body: null,
    set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = JSON.stringify(value); this.headersSent = true; return this; } };
}
const open = (version = 1) => ({ version, action: "open", sessionIds, ttlMs: 60_000 });
const read = (version = 1, body = { mode: "no-build-post-v1", path: "/posts/frozen/", rendererSha: "a".repeat(40) }) =>
  ({ version, action: "request", sessionIds, endpoint: "cmsGetPublicPage", body });
function setup(extra = {}) {
  const authenticate = vi.fn(async () => actor), endpoint = vi.fn(async (_req, res) => res.status(200).json({ success: true }));
  const handler = createVersionedCmsReaderHandler({ firestore: db, readers, version: 1,
    handlers: { cmsGetPublicPage: endpoint }, authenticate, now: () => time,
    edge: { readSecret: () => "fixture-edge", logger: { warn() {}, error() {} } }, ...extra });
  const invokeRaw = async (headers, body) => { const output = res(); await handler({ ...req(body), headers }, output); return output; };
  return { handler, authenticate, endpoint, invokeRaw, invoke: async body => { const output = res(); await handler(req(body), output); return output; } };
}
beforeEach(async () => {
  time = Date.now(); readers = bridgeFixture(time).request.readers; identities = readerIdentities(readers);
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});
it("requires both edge and fresh staff authorization on every request, including valid leases", async () => {
  const setup1 = setup();
  const denied = res(); await setup1.handler(req(open(), { "x-njpbs-cms-edge": "wrong" }), denied);
  expect(denied.statusCode).toBe(403); expect(setup1.authenticate).not.toHaveBeenCalled();
  expect((await setup1.invoke(open())).statusCode).toBe(200);
  expect((await setup1.invoke(read())).statusCode).toBe(200);
  setup1.authenticate.mockRejectedValueOnce(Object.assign(new Error("revoked"), { status: 401 }));
  expect((await setup1.invoke(read())).statusCode).toBe(401);
  setup1.authenticate.mockResolvedValueOnce({ uid: "staff", principal: { id: "staff", grants: [] } });
  expect((await setup1.invoke(read())).statusCode).toBe(403);
  expect(setup1.endpoint).toHaveBeenCalledOnce();
  const forwarded = setup1.endpoint.mock.calls[0][0];
  expect(forwarded.rawBody.toString()).toBe(JSON.stringify(read().body));
  expect(forwarded.headers["content-length"]).toBe(String(Buffer.byteLength(JSON.stringify(read().body))));
});
it("keeps a session refusal raised inside the forwarded endpoint", async () => {
  const bridge = setup();
  await bridge.invoke(open());
  bridge.endpoint.mockImplementationOnce(async (forwarded, output) => {
    markSessionRefused(forwarded, "token_expired");
    return output.status(401).json({ error: "Access is unavailable" });
  });
  const refused = await bridge.invoke(read());
  expect(refused.statusCode).toBe(401);
  expect(JSON.parse(refused.body)).toEqual({ error: "Access is unavailable", code: "session_expired", reason: "token_expired" });
});
it("does not renew either reader after a lost open response, close, replacement or exact expiry", async () => {
  const bridge = setup(), first = JSON.parse((await bridge.invoke(open())).body);
  time += 1000;
  expect(JSON.parse((await bridge.invoke(open())).body)).toEqual(first);
  await Promise.all(Object.values(identities).map(digest => sessions.closeReader(db, digest)));
  expect((await bridge.invoke(read())).statusCode).toBe(200);
  const replaced = setup({ readers: { ...readers, functions: { ...readers.functions, sourceSha: "c".repeat(40) } } });
  expect((await replaced.invoke(read())).statusCode).toBe(503);
  time = first.leases.functions.expiresAt;
  expect((await bridge.invoke(read())).statusCode).toBe(503);
  expect((await bridge.invoke(open())).statusCode).toBe(410);
  expect((await db.doc(`cmsReaderSessions/${sessionIds.functions}`).get()).data().expiresAt).toBe(first.leases.functions.expiresAt);
});
it.each([1, 2])("keeps the established public Post decision bytes and settings/chrome/capability fields on version %s", async version => {
  const frozen = { kind: "post", receipt: { rendererSha: "a".repeat(40), sourceVersion: 7 }, published: {
    chrome: { station: { footer: "retained" } }, metadata: { dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 1 },
  } };
  const legacy = createCmsGetPublicPageHandler({ firestore: db, readNoBuildPostFn: async () => structuredClone(frozen), log: { error() {}, warn() {} } });
  const bridge = setup({ version, handlers: { cmsGetPublicPage: legacy } });
  await bridge.invoke(open(version));
  const body = read(version).body, direct = res(); await legacy(req(body), direct);
  const output = await bridge.invoke(read(version));
  expect(output.statusCode).toBe(direct.statusCode); expect(output.body).toBe(direct.body);
  expect(JSON.parse(output.body)).toEqual(frozen);
  expect(output.headers["x-njpbs-functions-reader"]).toBe(identities.functions);
});
it("retains actual preview status for its original immutable queue and rejects arbitrary endpoint/version/reader selection", async () => {
  await db.doc("cmsPages/contact").set({ status: "draft", version: 8 });
  await db.doc(`cmsPreviewQueue/${"q".repeat(20)}`).set({ collection: "cmsPages", pageId: "contact", sourceVersion: 7,
    status: "ready", transport: "serializer", requestedAt: new Date(time), expiresAt: new Date(time + 60_000), persistent: false,
    rendererSha: "a".repeat(40), previewPairId: "preview-old", previewEpoch: 1, serializerId: "preview-old" });
  const legacy = createCmsPreviewStatusHandler({ firestore: db, now: () => time, requirePrincipalFn: async () => actor, log: { error() {} } });
  const bridge = setup({ handlers: { cmsPreviewStatus: legacy } }); await bridge.invoke(open());
  const body = { queueId: "q".repeat(20) }, direct = res(); await legacy(req(body), direct);
  const output = await bridge.invoke({ ...read(), endpoint: "cmsPreviewStatus", body });
  expect(output.statusCode).toBe(200); expect(output.body).toBe(direct.body);
  expect((await bridge.invoke({ ...read(), endpoint: "deleteEverything" })).statusCode).toBe(400);
  expect((await bridge.invoke(read(2))).statusCode).toBe(400);
  const forged = res(); await bridge.handler(req(read(), { "x-njpbs-cms-reader": "f".repeat(64) }), forged);
  expect(forged.statusCode).toBe(403);
});

// Real Admin transport, CMS API gateway, Functions handler and Firestore. Only
// the two HTTP hops and the clock are replaced. dropReplies loses a reply after
// the server has committed its work.
const DAY = 24 * 60 * 60_000;
function deployment() {
  const bridge = setup({ handlers: { cmsGetPublicPage: async (_req, res) => res.status(200).json({ success: true }) } });
  const toFunctions = async (_url, init) => {
    const output = await bridge.invokeRaw(Object.fromEntries(Object.entries(init.headers)), JSON.parse(new TextDecoder().decode(init.body)));
    return new Response(output.body, { status: output.statusCode, headers: { "content-type": "application/json", ...output.headers } });
  };
  const gateway = createCmsReaderBridge({ projectId: "njpbs-site", readEdgeSecret: () => "fixture-edge", verifyToken: async () => ({}), request: toFunctions,
    targets: [{ version: 1, functionsUrl: "https://us-central1-njpbs-site.cloudfunctions.net/cmsReaderV1", gatewayReaderDigest: identities.cmsApi }] });
  const network = { dropReplies: 0, sent: [] };
  const request = async (url, init) => {
    network.sent.push(JSON.parse(init.body));
    const reply = await gateway(new Request(url, init), { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", clientIp: null });
    if (network.dropReplies > 0) { network.dropReplies--; throw new TypeError("lost response"); }
    return reply;
  };
  return { network, request };
}
function browserTab({ request }, clock = () => time) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const page = (options = {}) => {
    const transport = createInstalledReaderTransport({ enabled: "true", origin: "https://api.example.org", storage, request, now: clock,
      manifest: JSON.stringify({ schemaVersion: 2, version: 1, functionsReader: identities.functions, cmsApiReader: identities.cmsApi }), ...options });
    return { send: async () => {
      const { response, token } = await transport.send({ endpoint: "cmsGetPublicPage", principalId: "staff", token: "fixture-staff", body: read().body });
      expect(token).toBe("fixture-staff");
      return response;
    } };
  };
  const duplicate = () => { const copy = browserTab({ request }, clock); for (const [key, value] of values) copy.storage.setItem(key, value); return copy; };
  return { page, duplicate, storage, ids: () => JSON.parse([...values.values()][0]).ids };
}
const leaseRows = async () => (await db.collection("cmsReaderSessions").get()).docs.filter(row => row.data().schemaVersion === 2);
const ENDED = "Reload Boardwalk";
it("confirms expiry only to the authenticated original principal, with stored values", async () => {
  const bridge = setup(), first = JSON.parse((await bridge.invoke(open())).body);
  time = first.leases.functions.expiresAt + 5000;
  const reply = await bridge.invoke(open());
  expect(reply.statusCode).toBe(410);
  expect(JSON.parse(reply.body)).toEqual({ schemaVersion: 2, version: 1, code: "cms-reader-session-expired", identities,
    expired: ["functions", "cmsApi"].map(component => { const { sessionId, readerDigest, issuedAt, expiresAt } = first.leases[component]; return { sessionId, readerDigest, issuedAt, expiresAt }; }) });
  const other = setup({ authenticate: async () => ({ ...actor, uid: "other" }) }), refused = await other.invoke(open());
  expect(refused.statusCode).toBe(503);
  expect(JSON.parse(refused.body)).toEqual({ error: "Versioned CMS reader unavailable" });
  const unsigned = res(); await bridge.handler(req(open(), { "x-njpbs-cms-edge": "wrong" }), unsigned);
  expect(unsigned.statusCode).toBe(403);
});
it("keeps original IDs through lost opens, then needs typed expiry and one explicit reload for new IDs", async () => {
  const live = deployment(), tab = browserTab(live), started = time;
  live.network.dropReplies = 1;
  await expect(tab.page().send()).rejects.toThrow("lost response");
  const original = tab.ids(), rows = await leaseRows();
  expect(rows.map(row => row.id).sort()).toEqual(Object.values(original).sort());
  time += 60 * 60_000;
  live.network.dropReplies = 1;
  await expect(tab.page().send()).rejects.toThrow("lost response");
  expect(tab.ids()).toEqual(original);
  time = started + DAY;
  const page = tab.page();
  await expect(page.send()).rejects.toThrow(ENDED);
  const sent = live.network.sent.length;
  await expect(page.send()).rejects.toThrow(ENDED);
  expect(live.network.sent).toHaveLength(sent);
  expect(tab.ids()).toEqual(original);
  expect(live.network.sent.every(body => body.sessionIds.functions === original.functions && body.action === "open")).toBe(true);
  expect((await tab.page().send()).status).toBe(200);
  expect(tab.ids().functions).not.toBe(original.functions);
  expect(tab.ids().cmsApi).not.toBe(original.cmsApi);
  for (const row of rows) expect((await db.doc(row.ref.path).get()).data()).toEqual(row.data());
  expect((await db.doc(`cmsReaderSessions/${original.functions}`).get()).data().expiresAt).toBe(started + DAY);
});
it("rotates after server-confirmed expiry even when the browser clock is behind", async () => {
  const live = deployment(), tab = browserTab(live, () => time - 7 * DAY);
  live.network.dropReplies = 1;
  await expect(tab.page().send()).rejects.toThrow("lost response");
  const original = tab.ids();
  time += DAY;
  await expect(tab.page().send()).rejects.toThrow(ENDED);
  expect((await tab.page().send()).status).toBe(200);
  expect(tab.ids().functions).not.toBe(original.functions);
});
it("duplicated tabs confirm the same expiry and rotate to separate new sessions", async () => {
  const live = deployment(), first = browserTab(live);
  live.network.dropReplies = 1;
  await expect(first.page().send()).rejects.toThrow("lost response");
  const second = first.duplicate(), original = first.ids();
  time += DAY;
  const outcomes = await Promise.allSettled([first.page().send(), second.page().send()]);
  expect(outcomes.map(result => result.reason?.message)).toEqual([expect.stringContaining(ENDED), expect.stringContaining(ENDED)]);
  expect(await leaseRows()).toHaveLength(2);
  expect((await Promise.all([first.page().send(), second.page().send()])).map(reply => reply.status)).toEqual([200, 200]);
  expect(new Set([first.ids().functions, second.ids().functions, original.functions]).size).toBe(3);
  expect(await leaseRows()).toHaveLength(6);
});
it("ends the group on one expired historical lease without renewing or issuing its partner", async () => {
  const live = deployment(), tab = browserTab(live);
  live.network.dropReplies = 1;
  await expect(tab.page().send()).rejects.toThrow("lost response");
  const original = tab.ids();
  // Earlier sessions could commit one component: the other is absent or later.
  await db.doc(`cmsReaderSessions/${original.cmsApi}`).delete();
  time += DAY;
  await expect(tab.page().send()).rejects.toThrow(ENDED);
  expect((await db.doc(`cmsReaderSessions/${original.cmsApi}`).get()).exists).toBe(false);
  expect(tab.ids()).toEqual(original);
});
it("keeps a closed window refusing explicit recovery and swept same-ID retries", async () => {
  const live = deployment(), tab = browserTab(live), retained = browserTab(live);
  live.network.dropReplies = 2;
  await expect(tab.page().send()).rejects.toThrow("lost response");
  await expect(retained.page().send()).rejects.toThrow("lost response");
  time += DAY;
  await expect(tab.page().send()).rejects.toThrow(ENDED);
  await Promise.all(Object.values(identities).map(digest => sessions.closeReader(db, digest)));
  expect((await tab.page().send()).status).toBe(503);
  expect(await leaseRows()).toHaveLength(4);
  const swept = await Promise.all(Object.values(identities).map(digest => sessions.sweepClosedReaderSessions(db, digest, time)));
  expect(swept.map(page => page.deleted)).toEqual([2, 2]);
  const original = retained.ids();
  expect((await retained.page().send()).status).toBe(503);
  expect(retained.ids()).toEqual(original);
  expect(await leaseRows()).toHaveLength(0);
});
