import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { boardwalkFixture, registry, newsdeskId, now } from "../helpers/cuez-boardwalk-fixture.js";
import { storydeskProvider } from "../helpers/cuez-storydesk-provider.js";
import firebase from "../../functions/lib/firebase.js";
import auth from "../../functions/lib/auth.js";
import api from "../../functions/cuez-transfers.js";
import storageModule from "../../functions/lib/cuez-transfer-storage.js";
import operationsModule from "../../functions/lib/cuez-transfer-operations.js";
import selectionModule from "../../functions/lib/cuez-transfer-selection.js";
import contentAuthorization from "../../functions/lib/content-authorization.js";
import transcriptJobs from "../../functions/lib/video-transcript-job.js";
import byok from "../../functions/lib/video-transcript-byok-job.js";
import { initialOperationPages, operationPages } from "../../admin/src/lib/cuez-operation-pages.ts";

const db = firebase.db;
let provider, token, uid, fixture, actorEmail;
beforeAll(async () => {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? "")) throw new Error("Local Auth emulator required");
  const email = actorEmail = `cuez-${crypto.randomUUID()}@example.test`;
  const body = { email, password: "synthetic-emulator-password", returnSecureToken: true };
  const signup = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  uid = (await signup.json()).localId;
  await firebase.admin.auth().updateUser(uid, { emailVerified: true });
  const signin = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  token = (await signin.json()).idToken;
});
beforeEach(async () => {
  fixture = await boardwalkFixture(db);
  await db.doc(`users/${uid}`).set({ active: true, role: "admin", emailVerified: true });
  await db.doc(api.SETTINGS_PATH).set({ enabled: true, newsdeskId });
  auth.resetAuthTokenCache();
  provider = storydeskProvider();
  provider.objects.stories.push({ id: "external-story", title: "External story", description: "Source description",
    updatedAt: "2026-10-29T12:00:00Z", link: "https://storydesk.example.test/story" });
});
function handler(action, extra = {}) {
  return api.createCuezHandler(action, { firestore: db, apiKey: () => "synthetic-provider-key", fetchImpl: provider.fetch,
    registry: () => registry, awsConfig: () => ({ renditionBucket: "test-renditions" }), now: () => now,
    publicMediaOrigin: () => "https://media.example.test",
    // App Check is an external identity boundary; Firebase has no local App Check emulator.
    verifyAppCheck: async value => { if (value !== "synthetic-app-check") throw new auth.AuthError("Invalid App Check token"); }, ...extra });
}
async function invoke(action, body = {}, { bearer = token, appCheck = "synthetic-app-check", extra, headers, rawBody } = {}) {
  const res = { statusCode: 0, body: null, headers: {}, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }, set(name, value) { this.headers[name] = value; return this; } };
  await handler(action, extra)({ method: "POST", headers: { "content-type": "application/json",
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(appCheck ? { "x-firebase-appcheck": appCheck } : {}), ...headers }, body, rawBody, ip: "127.0.0.1" }, res);
  return res;
}
async function ok(action, body) {
  const response = await invoke(action, body);
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  expect(response.headers["Cache-Control"]).toBe("private, no-store");
  return response.body;
}
const prepare = () => ok("prepare", { action: "prepare", resource: { kind: "post", id: "post" }, target: { kind: "new-story" } });
const syntheticStorage = () => storageModule.createTransferStorage({
  clientFor: () => ({ send: async command => ({ VersionId: command.input.VersionId,
    ContentLength: command.input.Key.includes("clips/") ? 100 : 500, Body: Readable.from(["Reporter: Cached text"]) }) }),
  sign: async () => "https://renditions.example.test/viewing.mp4",
  fetchImpl: async () => new Response(null, { headers: { "content-length": "100" } }),
});
const resourceFor = kind => ({ kind, id: kind === "image" ? "image" : "asset",
  ...(kind === "clip" ? { jobId: fixture.clip.id } : kind === "transcript" ? { jobId: fixture.transcript.id } : {}) });

describe("default-off StoryDesk endpoints", () => {
  it.each(["original", "rendition"])("skips a stale %s transcript and lists the remaining ready job", async staleKind => {
    const source = registry.get("video-library");
    let stale;
    if (staleKind === "original") stale = { ...fixture.transcript, id: "a".repeat(64), sourceObjectVersionId: "old-original" };
    else stale = byok.createJob({ sourceId: source.id, assetId: fixture.asset.id,
      originalBucket: source.bucket, originalKey: fixture.asset.objectKey,
      originalVersion: fixture.asset.objectVersionId, originalSize: fixture.asset.sizeBytes,
      renditionBucket: "test-renditions", renditionKey: fixture.asset.rendition.web.objectKey,
      renditionVersion: "old-web-version", renditionSize: 500, durationSeconds: 60,
      languageCode: "en-US", maxSpeakers: 2, credentialScope: "organization",
      credentialId: createHash("sha256").update(JSON.stringify(["credential-v1", "organization", null, "elevenlabs"])).digest("hex"),
      credentialRevision: 1 }, { uid }, now);
    await fixture.ref("mediaSourceTranscriptJobs", stale.id).set({ ...stale, phase: "ready", active: false,
      outputs: { "segments.json": "stale-segments", txt: "stale-text" } });
    await expect(transcriptJobs.getTranscriptJob({ firestore: db, source, renditionBucket: "test-renditions",
      request: { sourceId: source.id, assetId: "asset", transcriptId: stale.id } }))
      .rejects.toMatchObject({ status: staleKind === "original" ? 404 : 409 });
    const result = await ok("prepare", { action: "list", kind: "transcript", assetId: "asset" });
    expect(result.items.map(item => item.resource.jobId)).toEqual([fixture.transcript.id]);
    expect(provider.calls).toHaveLength(0);
  });
  it("lets another authorized staff member confirm a shared import preview", async () => {
    const first = await ok("preview", { storyId: "external-story" });
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const email = `second-${crypto.randomUUID()}@example.test`, password = "synthetic-emulator-password";
    const signup = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    const secondUid = (await signup.json()).localId;
    await firebase.admin.auth().updateUser(secondUid, { emailVerified: true });
    await fixture.ref("users", secondUid).set({ active: true, role: "admin", emailVerified: true });
    const signin = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    const secondToken = (await signin.json()).idToken;
    const second = await invoke("preview", { storyId: "external-story" }, { bearer: secondToken });
    expect(second.body.operation.operationId).toBe(first.operation.operationId);
    const confirmed = await invoke("confirm", { operationId: first.operation.operationId, confirmed: true }, { bearer: secondToken });
    expect(confirmed).toMatchObject({ statusCode: 200, body: { operation: { state: "complete" } } });
    expect((await fixture.ref("cmsPosts", confirmed.body.operation.draftId).get()).data().createdBy).toBe(secondUid);
    expect((await ok("confirm", { operationId: first.operation.operationId, confirmed: true })).operation.draftId)
      .toBe(confirmed.body.operation.draftId);
    expect((await db.collection("cmsPosts").get()).size).toBe(2);
  });
  it.each(["video", "clip", "transcript", "image"].flatMap(kind => ["new", "existing"].map(target => [kind, target])))(
    "refuses Viewer preparation of %s for a %s story", async (kind, destination) => {
      const activation = db.doc("system/staffAccessActivation");
      await activation.set({ schema: 1, state: "active", cleanScan: true });
      try {
        await fixture.ref("users", uid).set({ active: true, emailVerified: true, accessTier: "viewer" });
        const target = destination === "new" ? { kind: "new-story" }
          : { kind: kind === "transcript" ? "dossier" : "story-asset", storyId: "external-story" };
        expect(await invoke("prepare", { action: "prepare", resource: resourceFor(kind), target }, { extra: { storage: syntheticStorage() } }))
          .toMatchObject({ statusCode: 403, body: { code: "not_authorized" } });
        expect((await db.collection("cuezTransferOperations").get()).empty).toBe(true);
        expect(provider.calls).toHaveLength(0);
      } finally { await activation.delete(); }
    });
  it.each(["send", "retry", "reconcile"])("rechecks write permission on %s after a Viewer downgrade", async action => {
    const extra = { storage: syntheticStorage() };
    const queued = await invoke("prepare", { action: "prepare", resource: resourceFor("video"), target: { kind: "new-story" } }, { extra });
    const operationId = queued.body.operation.operationId;
    if (action !== "send") {
      provider.failNext({ tool: "stories_create", mode: action === "retry" ? "http" : "drop-before", status: 429 });
      await invoke("send", { operationId }, { extra });
    }
    provider.calls.length = 0;
    const activation = db.doc("system/staffAccessActivation");
    await activation.set({ schema: 1, state: "active", cleanScan: true });
    try {
      await fixture.ref("users", uid).set({ active: true, emailVerified: true, accessTier: "viewer" });
      expect(await invoke(action, { operationId, ...(action === "reconcile" ? { acknowledged: true } : {}) }, { extra }))
        .toMatchObject({ statusCode: 403, body: { code: "not_authorized" } });
      expect(provider.calls).toHaveLength(0);
    } finally { await activation.delete(); }
  });
  it("requires edit access even when a tier account can read the Post", async () => {
    const activation = db.doc("system/staffAccessActivation");
    await activation.set({ schema: 1, state: "active", cleanScan: true });
    try {
      await db.doc(`users/${uid}`).set({ active: true, emailVerified: true, accessTier: "contributor" });
      const actor = await auth.requirePrincipal({ headers: { authorization: `Bearer ${token}` } });
      const record = (await fixture.ref("cmsPosts", "post").get()).data();
      expect(contentAuthorization.authorizeContentRead(actor.principal, { exists: true,
        resource: contentAuthorization.contentResource({ collection: "cmsPosts", documentId: "post", stored: record }) }).allowed).toBe(true);
      expect((await invoke("prepare", { action: "prepare", resource: { kind: "post", id: "post" }, target: { kind: "new-story" } })).statusCode).toBe(403);
      expect((await ok("prepare", { action: "list", kind: "post" })).items).toEqual([]);
      await fixture.ref("cmsPosts", "post").update({ createdBy: uid });
      expect((await prepare()).operation.state).toBe("queued");
      await fixture.ref("cmsPosts", "post").update({ status: "review" });
      expect((await invoke("prepare", { action: "prepare", resource: { kind: "post", id: "post" }, target: { kind: "new-story" } })).statusCode).toBe(403);
      expect(provider.calls).toHaveLength(0);
    } finally { await activation.delete(); }
  });
  it.each(["destinations", "candidates", "preview", "confirm"])("refuses %s for base staff without reading the key or StoryDesk", async action => {
    await db.doc(`users/${uid}`).set({ active: true, role: "staff", emailVerified: true });
    const result = await invoke(action, {}, { extra: { apiKey: () => { throw new Error("Key must not be read"); } } });
    expect(result).toMatchObject({ statusCode: 403, body: { code: "not_authorized" } });
    expect(provider.calls).toHaveLength(0);
  });
  it.each(["video", "clip", "transcript"])("binds %s authorization to a concrete asset in the configured source", async kind => {
    const body = { action: "prepare", resource: { kind, id: "asset", ...(kind === "clip" ? { jobId: fixture.clip.id } : kind === "transcript" ? { jobId: fixture.transcript.id } : {}) },
      target: { kind: "new-story" } };
    for (const patch of [{ sourceId: "archive-originals" }, { sourceId: "video-library", objectKey: "elsewhere/private.mp4" }]) {
      await fixture.ref("mediaSourceAssets", "asset").update(patch);
      expect((await invoke("prepare", body))).toMatchObject({ statusCode: 403, body: { code: "not_authorized" } });
      if (kind !== "video") expect((await invoke("prepare", { action: "list", kind, assetId: "asset" })).statusCode).toBe(403);
    }
    await fixture.ref("mediaSourceAssets", "asset").delete();
    expect((await invoke("prepare", body)).body.code).toBe("not_authorized");
    expect(provider.calls).toHaveLength(0);
  });
  it("lists videos with a direct source browse check and omits assets outside its prefix", async () => {
    expect((await ok("prepare", { action: "list", kind: "video" })).items).toHaveLength(1);
    await fixture.ref("mediaSourceAssets", "asset").update({ objectKey: "elsewhere/private.mp4" });
    expect((await ok("prepare", { action: "list", kind: "video" })).items).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
  it.each(["video", "clip", "transcript"])("hides %s operation status after its concrete asset moves to another source", async kind => {
    const prepared = await selectionModule.prepareExportSelection({ firestore: db, request: await fixture.request(kind, true),
      actorUid: uid, newsdeskId, registry, renditionBucket: "test-renditions", now });
    const queued = await operationsModule.createTransferOperations({ firestore: db, now: () => now }).enqueue(prepared);
    await fixture.ref("mediaSourceAssets", "asset").update({ sourceId: "archive-originals" });
    expect((await invoke("operations", { operationId: queued.operation.operationId }))).toMatchObject({ statusCode: 403, body: { code: "not_authorized" } });
    expect((await ok("operations")).operations).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
  it("preserves the authenticated actor's email in import audit rows", async () => {
    const preview = await ok("preview", { storyId: "external-story" });
    const result = await ok("confirm", { operationId: preview.operation.operationId, confirmed: true });
    const rows = await db.collection("admin_logs").where("target", "==", `cmsPosts/${result.operation.draftId}`).get();
    expect(rows.docs.map(row => row.data())).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "cms.save", actorUid: uid, actorEmail }),
    ]));
  });
  it("does not acknowledge a recovery read that fails, and permits closure after recovery despite a source edit", async () => {
    const queued = await ok("prepare", { action: "prepare", resource: { kind: "clip", id: "asset", jobId: fixture.clip.id }, target: { kind: "new-story" } });
    provider.failNext({ tool: "stories_get", mode: "http", status: 503 });
    expect((await ok("send", { operationId: queued.operation.operationId })).operation.state).toBe("reconciliation");
    await fixture.ref("mediaSourceAssets", "asset").update({ description: "Later edit" });
    await fixture.ref("mediaSourceClipJobs", fixture.clip.id).update({ expiresAt: "2026-10-29T15:00:01Z" });
    provider.failNext({ tool: "stories_get", mode: "http", status: 503 });
    expect((await invoke("reconcile", { operationId: queued.operation.operationId, acknowledged: true })).statusCode).toBe(503);
    expect((await db.doc(`cuezTransferOperations/${queued.operation.operationId}`).get()).data().reconciliationAcknowledgedBy).toBeUndefined();
    const recovered = await ok("reconcile", { operationId: queued.operation.operationId, acknowledged: true });
    expect(recovered.operation).toMatchObject({ state: "failed", acknowledged: true, canClosePartial: true });
    expect((await ok("reconcile", { operationId: queued.operation.operationId, acknowledged: true, closePartial: true })).operation)
      .toMatchObject({ partialAcknowledged: true, canRetry: false });
  });
  it.each([[{ headers: { "content-type": "text/plain" } }, 415], [{ rawBody: Buffer.alloc(16385) }, 413]])("returns a safe invalid-request code for bounded JSON refusal", async (options, status) => {
    expect(await invoke("status", {}, options)).toMatchObject({ statusCode: status, body: { code: "invalid_request" } });
    expect(provider.calls).toHaveLength(0);
  });
  it("logs an unexpected error's diagnostic cause without its content or credentials", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const error = Object.assign(new TypeError("Private draft text and Bearer secret https://private.example.test/?signature=secret"), { code: 9 });
    const response = await invoke("operations", {}, { extra: { logger, awsConfig: () => { throw error; } } });
    expect(response).toMatchObject({ statusCode: 503, body: { code: "transient_failure", error: "The transfer could not finish. Try again." } });
    expect(logger.error).toHaveBeenCalledWith("StoryDesk transfer request failed", expect.objectContaining({
      action: "operations", cause: expect.objectContaining({ name: "TypeError", code: 9 }),
    }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/Private draft|Bearer|signature=|secret|https:/);
  });
  it.each(api.ACTIONS)("%s refuses before auth, configuration, or provider work when the flag is missing or off", async action => {
    await db.doc(api.SETTINGS_PATH).delete();
    const extra = { apiKey: () => { throw new Error("Secret must not be read"); } };
    const result = await invoke(action, { newsdeskId: "forged" }, { bearer: null, appCheck: null, extra });
    expect(result).toMatchObject({ statusCode: 503, body: { code: "not_configured", enabled: false } });
    expect(provider.calls).toHaveLength(0);
    await db.doc(api.SETTINGS_PATH).set({ enabled: false });
    expect((await invoke(action)).body.enabled).toBe(false);
  });
  it.each(api.ACTIONS)("%s refuses missing auth and invalid App Check with the flag on", async action => {
    expect((await invoke(action, {}, { bearer: null })).statusCode).toBe(401);
    expect((await invoke(action, {}, { appCheck: "wrong" })).statusCode).toBe(401);
    expect(provider.calls).toHaveLength(0);
  });
  it("rechecks the flag and staff authority on every call", async () => {
    expect((await ok("status")).enabled).toBe(true);
    await db.doc(api.SETTINGS_PATH).update({ enabled: false });
    expect((await invoke("status")).body.enabled).toBe(false);
    await db.doc(api.SETTINGS_PATH).update({ enabled: true });
    await db.doc(`users/${uid}`).update({ active: false });
    expect((await invoke("status")).statusCode).toBe(403);
  });
  it.each([undefined, "", " padded", "padded ", "x".repeat(1025), "bad\u0000id"])(
    "keeps the workflow unavailable for an unusable newsdesk ID %#", async newsdeskIdValue => {
      await db.doc(api.SETTINGS_PATH).set({ enabled: true, ...(newsdeskIdValue === undefined ? {} : { newsdeskId: newsdeskIdValue }) });
      expect(await invoke("status")).toMatchObject({ statusCode: 503, body: { code: "not_configured" } });
      const result = await invoke("operations", {}, { extra: {
        registry: () => { throw new Error("Registry must not be read"); },
        awsConfig: () => { throw new Error("Config must not be read"); },
        apiKey: () => { throw new Error("Key must not be read"); },
      } });
      expect(result).toMatchObject({ statusCode: 503, body: { code: "not_configured" } });
      expect(provider.calls).toHaveLength(0);
    });
  it("pages through older transfer results and rejects a cursor from another actor", async () => {
    const operationIds = Array.from({ length: 30 }, (_, index) => index.toString(16).padStart(64, "0"));
    await Promise.all(operationIds.map((operationId, index) => fixture.ref("cuezTransferOperations", operationId).set({
      direction: "import", state: index === 29 ? "reconciliation" : "complete", initiatedBy: uid,
      selectionSnapshot: { workspaceId: newsdeskId, importKind: "story-with-brief-and-dossiers",
        storyId: `story-${index}`, mappingVersion: 1, remoteChangeMarker: `revision-${index}` },
      steps: {}, errorCode: index === 29 ? "outcome_unknown" : null, updatedAt: new Date(now - index * 1000),
    })));
    const first = await ok("operations");
    expect(first.operations).toHaveLength(25);
    expect(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString())).toMatchObject({ actorUid: uid, operationId: operationIds[24] });
    const second = await ok("operations", { cursor: first.nextCursor });
    expect(second.operations.map(item => item.operationId)).toEqual(operationIds.slice(25));
    expect(second.operations.at(-1)).toMatchObject({ operationId: operationIds[29], state: "reconciliation" });
    expect(second.nextCursor).toBeNull();
    const otherCursor = "f".repeat(64);
    await fixture.ref("cuezTransferOperations", otherCursor).set({ initiatedBy: "another-user", updatedAt: new Date(now) });
    expect(await invoke("operations", { cursor: otherCursor })).toMatchObject({ statusCode: 400, body: { code: "invalid_request" } });
    const foreignCursor = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()), actorUid: "another-user" })).toString("base64url");
    expect(await invoke("operations", { cursor: foreignCursor })).toMatchObject({ statusCode: 400, body: { code: "invalid_request" } });
    expect(await invoke("operations", { operationId: operationIds[0], cursor: operationIds[24] }))
      .toMatchObject({ statusCode: 400, body: { code: "invalid_request" } });
  });
  it.each(["moved", "deleted"])("continues after the serialized position when the cursor document is %s", async change => {
    const ids = Array.from({ length: 28 }, (_, index) => index.toString(16).padStart(64, "0"));
    // Equal timestamps exercise the explicit document-ID tiebreaker as well.
    const updatedAt = new Timestamp(Math.floor(now / 1000), 123456789);
    await Promise.all(ids.map(id => fixture.ref("cuezTransferOperations", id).set({
      direction: "import", state: "complete", initiatedBy: uid, steps: {}, errorCode: null, updatedAt,
      selectionSnapshot: { workspaceId: newsdeskId, importKind: "story-with-brief-and-dossiers", storyId: id, mappingVersion: 1 },
    })));
    const first = JSON.parse(JSON.stringify(await ok("operations")));
    expect(first.operations.map(item => item.operationId)).toEqual(ids.toReversed().slice(0, 25));
    const boundary = first.operations.at(-1).operationId;
    if (change === "moved") await fixture.ref("cuezTransferOperations", boundary).update({ updatedAt: new Date(now + 1000), state: "reconciliation" });
    else await fixture.ref("cuezTransferOperations", boundary).delete();
    const second = await ok("operations", { cursor: first.nextCursor });
    expect(second.operations.map(item => item.operationId)).toEqual(ids.slice(0, 3).toReversed());
    expect(second.nextCursor).toBeNull();
  });
  it("keeps every transfer reachable across multi-page gaps, polling and resumed history", async () => {
    let state = initialOperationPages;
    const ids = [];
    async function seed(start, count, timestamp) {
      const added = Array.from({ length: count }, (_, index) => (start + index).toString(16).padStart(64, "0"));
      ids.push(...added);
      await Promise.all(added.map((id, index) => fixture.ref("cuezTransferOperations", id).set({
        direction: "import", state: "reconciliation", initiatedBy: uid, steps: {}, errorCode: "outcome_unknown",
        updatedAt: new Date(timestamp - index * 1000),
        selectionSnapshot: { workspaceId: newsdeskId, importKind: "story-with-brief-and-dossiers", storyId: id, mappingVersion: 1 },
      })));
    }
    async function read(cursor) {
      const page = JSON.parse(JSON.stringify(await ok("operations", cursor ? { cursor } : {})));
      state = operationPages(state, { type: "page", page, cursor });
      expect(state.error).toBeNull();
      return page;
    }
    await seed(0, 80, now);
    await read();
    await read(state.scans[0].cursor);
    const deeperFrontier = state.scans[0].cursor;
    await seed(100, 65, now + 100000);
    await read();
    await fixture.ref("cuezTransferOperations", ids[0]).update({ updatedAt: new Date(now + 60000) });
    await read(state.scans[0].cursor);
    const gapFrontier = state.scans[0].cursor;
    expect(state.scans).toHaveLength(2); // A moved anchor must not end the scan.
    await seed(200, 35, now + 300000); // A second burst interrupts that gap.
    await read();
    await read(state.scans[0].cursor);
    expect(state.scans[0].cursor).toBe(gapFrontier);
    await read(); // Polling must not rewind the in-progress gap.
    expect(state.scans[0].cursor).toBe(gapFrontier);
    await read(state.scans[0].cursor);
    expect(state.scans[0].cursor).toBe(deeperFrontier);
    for (let pages = 0; state.scans.length && pages < 4; pages++) await read(state.scans[0].cursor);
    expect(state.scans).toHaveLength(0);
    expect(state.operations.map(item => item.operationId).sort()).toEqual(ids.toSorted());

    await seed(300, 1, now + 400000); // A one-row shift after fully loading history.
    await read();
    expect(state.scans).toHaveLength(0);
    expect(state.operations.map(item => item.operationId).sort()).toEqual(ids.toSorted());
  });
  it("opens a continuation after an empty list receives more than one page", async () => {
    let state = operationPages(initialOperationPages, { type: "page", page: await ok("operations") });
    const ids = Array.from({ length: 26 }, (_, index) => index.toString(16).padStart(64, "0"));
    await Promise.all(ids.map((id, index) => fixture.ref("cuezTransferOperations", id).set({
      direction: "import", state: "reconciliation", initiatedBy: uid, steps: {}, errorCode: "outcome_unknown", updatedAt: new Date(now - index * 1000),
      selectionSnapshot: { workspaceId: newsdeskId, importKind: "story-with-brief-and-dossiers", storyId: id, mappingVersion: 1 },
    })));
    state = operationPages(state, { type: "page", page: await ok("operations") });
    expect(state.scans).toHaveLength(1);
    const cursor = state.scans[0].cursor;
    state = operationPages(state, { type: "page", page: await ok("operations", { cursor }), cursor });
    expect(state.scans).toHaveLength(0);
    expect(state.operations.map(item => item.operationId).sort()).toEqual(ids.toSorted());
  });
  it("enforces selected-resource permissions and refuses client workspace or provider configuration", async () => {
    await db.doc(`users/${uid}`).set({ active: true, grants: [{ role: "contributor", sections: ["other"] }] });
    expect((await invoke("prepare", { action: "prepare", resource: { kind: "post", id: "post" }, target: { kind: "new-story" } })).statusCode).toBe(403);
    expect((await invoke("destinations", { newsdeskId: "forged" })).statusCode).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });
  it("lists local choices, sends a Post, returns status, previews and confirms an import, and retries a known failure", async () => {
    expect((await ok("status")).canImport).toBe(true);
    expect((await ok("destinations")).stories[0].id).toBe("external-story");
    expect((await ok("prepare", { action: "list", kind: "post" })).items[0].label).toBe("Post");
    const queued = (await prepare()).operation;
    expect(queued.state).toBe("queued");
    const sent = (await ok("send", { operationId: queued.operationId })).operation;
    expect(sent.state).toBe("complete");
    expect((await ok("operations", { operationId: sent.operationId })).operation).toMatchObject({ state: "complete", label: "Post" });
    expect((await ok("operations")).operations.map(item => item.operationId)).toContain(sent.operationId);
    expect((await ok("candidates")).stories.map(item => item.id)).toContain("external-story");
    const preview = await ok("preview", { storyId: "external-story" });
    expect((await invoke("confirm", { operationId: preview.operation.operationId, confirmed: false })).statusCode).toBe(400);
    const imported = (await ok("confirm", { operationId: preview.operation.operationId, confirmed: true })).operation;
    expect(imported.state).toBe("complete");
    expect((await db.doc(`cmsPosts/${imported.draftId}`).get()).data().status).toBe("draft");
    await fixture.ref("cmsPosts", "post").update({ summary: "A later local revision" });
    const retryable = (await prepare()).operation;
    provider.failNext({ tool: "stories_update", mode: "http", status: 429 });
    expect((await ok("send", { operationId: retryable.operationId })).operation).toMatchObject({ state: "failed", canRetry: true });
    expect((await ok("retry", { operationId: retryable.operationId })).operation.state).toBe("complete");
    expect(provider.calls.every(call => call.args.newsdeskId === undefined || call.args.newsdeskId === newsdeskId)).toBe(true);
  });
  it("acknowledges an uncertain asset import without authorizing another asset write", async () => {
    const queued = await ok("prepare", { action: "prepare", resource: { kind: "video", id: "asset" }, target: { kind: "new-story" } });
    // The storage network boundary issues only the already selected viewing copy.
    const storage = storageModule.createTransferStorage({ clientFor: () => ({ send: async command => {
      expect(command.input.Bucket).toBe("test-renditions"); expect(command.input.VersionId).toBe("web-v1");
      return { VersionId: "web-v1", ContentLength: 500 };
    } }), sign: async () => "https://renditions.example.test/viewing.mp4" });
    provider.failNext({ tool: "assets_import_from_url", mode: "drop-after" });
    const sent = await invoke("send", { operationId: queued.operation.operationId }, { extra: { storage } });
    expect(sent.body.operation.state).toBe("reconciliation");
    const refused = await invoke("reconcile", { operationId: queued.operation.operationId, acknowledged: true, closePartial: true }, { extra: { storage } });
    expect(refused.statusCode).toBe(409);
    const result = await invoke("reconcile", { operationId: queued.operation.operationId, acknowledged: true }, { extra: { storage } });
    expect(result.body.operation).toMatchObject({ state: "reconciliation", acknowledged: true, canRetry: false });
    expect(provider.objects.assets).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toMatch(/objectKey|signature|apiKey|selectionSnapshot|resolvedSelection/);
  });
  it("closes a known partial export only after explicit acknowledgment and reuses the adopted story", async () => {
    const storage = storageModule.createTransferStorage({ clientFor: () => ({ send: async () => ({ VersionId: "web-v1", ContentLength: 500 }) }),
      sign: async () => "https://renditions.example.test/viewing.mp4" });
    const queued = await ok("prepare", { action: "prepare", resource: { kind: "video", id: "asset" }, target: { kind: "new-story" } });
    provider.failNext({ tool: "assets_import_from_url", mode: "http", status: 400 });
    const sent = await invoke("send", { operationId: queued.operation.operationId }, { extra: { storage } });
    expect(sent.body.operation).toMatchObject({ state: "failed", canRetry: true, canClosePartial: true });
    const count = provider.calls.length;
    expect((await invoke("reconcile", { operationId: queued.operation.operationId, closePartial: true })).statusCode).toBe(409);
    const closed = await ok("reconcile", { operationId: queued.operation.operationId, acknowledged: true, closePartial: true });
    expect(closed.operation).toMatchObject({ state: "failed", partialAcknowledged: true, canRetry: false, canClosePartial: false });
    expect(provider.calls).toHaveLength(count);
    expect((await invoke("retry", { operationId: queued.operation.operationId }, { extra: { storage } })).statusCode).toBe(409);
    await fixture.ref("mediaSourceAssets", "asset").update({ description: "A later selection" });
    const next = await ok("prepare", { action: "prepare", resource: { kind: "video", id: "asset" }, target: { kind: "new-story" } });
    expect((await invoke("send", { operationId: next.operation.operationId }, { extra: { storage } })).body.operation.state).toBe("complete");
    expect(provider.objects.stories.filter(item => item.id !== "external-story")).toHaveLength(1);
    expect(provider.objects.assets).toHaveLength(1);
  });
});
