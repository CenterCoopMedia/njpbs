import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import admin from "../helpers/firebase-admin.js";
import api from "../../functions/live-production.js";
import csv from "../../functions/lib/live-production-requests.js";
import contract from "../../functions/lib/live-production-contract.js";
import firebase from "../../functions/lib/firebase.js";

const staff = { uid: "producer", emailVerified: true, approvedActive: true, principal: { id: "producer", grants: [{ role: "editor" }] } };
const device = { uid: "studio-device-user", deviceId: "studio-device" };
const inputs = { headline: { key: "fixture-headline", number: 4, title: "Fixture headline" },
  name_title: { key: "fixture-name", number: 7, title: "Fixture name and title" } };
const inputTypes = { headline: "GT", name_title: "GT" };
const fields = { headline: ["TextBlock1.Text"], name_title: ["TextBlock1.Text", "TextBlock2.Text"] };
const headline = text => ({ templateId: "headline", headline: text });
const configuredTitleFiles = { headline: "synthetic-headline.gtzip", name_title: "synthetic-name-title.gtzip" };
let db, now, session, observationSequence;
async function invoke(body, { agent = false, user = staff, authenticatedDevice = device, token, titleFiles = () => configuredTitleFiles } = {}) {
  const response = { statusCode: 0, body: null, headers: {} };
  response.status = status => { response.statusCode = status; return response; };
  response.set = (name, value) => { response.headers[name] = value; return response; };
  response.json = value => { response.body = value; return response; };
  const handler = api.createLiveProductionHandler({ firestore: db, requirePrincipalFn: async () => user,
    ...(token ? {} : { requireDeviceFn: async () => authenticatedDevice }), clock: () => now, agent, titleFiles });
  await handler({ method: "POST", body, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response);
  return response;
}
async function ok(body, options) {
  const response = await invoke(body, options);
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  expect(response.headers["Cache-Control"]).toBe("private, no-store");
  return response.body;
}
const staffCall = (action, values = {}) => ok({ action, sessionId: session.id, requestId: randomUUID(), ...(action === "set_mapping" ? { titleFilesConfirmed: true } : {}), ...values });
const agentCall = (action, values = {}) => ok({ action, sessionId: session.id, deviceId: device.deviceId, ...(action === "verify_mapping" ? { inputTypes } : {}), ...values }, { agent: true });
function sample(overrides = {}) {
  return { schemaVersion: 1, protocolVersion: 1, sessionId: session.id, deviceId: device.deviceId,
    sessionGeneration: session.generation, mappingVersion: session.mappingVersion, sequence: ++observationSequence,
    observedAtMs: 9999999999999, vmix: "reachable", overlay: 1, state: "clear", inputKey: null,
    text: null, source: "manual", correlation: null, ...overrides };
}
async function banner(text = headline("POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY"), values = {}) {
  return (await staffCall("save_banner", { baseVersion: 0, text, order: 0, ...values })).banner;
}
async function command(record, overrides = {}) {
  return staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
    mappingVersion: session.mappingVersion, expectedObservationSequence: observationSequence, expectedClearGeneration: 0,
    commandAction: "take", bannerId: record.record.id, baseVersion: record.record.draft.version, ...overrides });
}
async function setup({ observe = true } = {}) {
  await db.doc("users/producer").set({ active: true, grants: [{ role: "editor" }] });
  await db.doc(`liveProductionDevices/${device.deviceId}`).set({ active: true, authUid: device.uid });
  const created = await ok({ action: "create_session", requestId: randomUUID(), title: "Synthetic rehearsal", productionProgramId: "fixture-news" });
  session = created.session;
  session = (await staffCall("set_mapping", { baseMappingVersion: 1, deviceId: device.deviceId, inputs })).session;
  await agentCall("verify_mapping", { mappingVersion: session.mappingVersion, inputs, fields });
  session = (await staffCall("set_session_state", { baseGeneration: session.generation, state: "ready" })).session;
  session = (await staffCall("set_session_state", { baseGeneration: session.generation, state: "active" })).session;
  if (observe) await agentCall("observe", { observation: sample() });
}

// Golden cases come from the CSV file format and the two templates in #3329.
describe("literal banner CSV", () => {
  it("preserves BOM, Unicode, quotes, commas, newlines, whitespace and empty title", () => {
    expect(csv.parseBannerCsv('\uFEFFtemplateId,headline,name,title\r\nheadline,"  中文, ""news""\nsecond line  ",,\r\nname_title,,JULIE O\'CONNOR,\r\n')).toEqual([
      headline('  中文, "news"\nsecond line  '), { templateId: "name_title", name: "JULIE O'CONNOR", title: "" },
    ]);
    expect(csv.parseBannerCsv('templateId,headline,name,title\nheadline,=1+1,,')[0].headline).toBe("=1+1");
  });
  it.each([
    'templateId,headline,name,title\nheadline,"bad quote,,',
    'templateId,headline,name,title\nheadline,"quoted"junk,,',
    'type,text\nheadline,news',
    'templateId,headline,name,title\nthird,news,,',
    'templateId,headline,name,title\nheadline,news,hidden,',
    'templateId,headline,name,title\nname_title,,,',
    'templateId,headline,name,title\nheadline,news,,extra,cell',
  ])("rejects ambiguous or invalid CSV (%s)", text => expect(() => csv.parseBannerCsv(text)).toThrow());
  it("rejects byte and row overflow explicitly", () => {
    expect(() => csv.parseBannerCsv("x".repeat(240 * 1024 + 1))).toThrow(/budget/);
    expect(() => csv.parseBannerCsv('templateId,headline,name,title\n' + 'headline,news,,\n'.repeat(101))).toThrow(/100/);
  });
});

describe("private live production Firestore and HTTP boundary", () => {
  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Use Auth/Firestore emulators.");
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = firebase.db;
  });
  beforeEach(async () => {
    await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" });
    now = 1000000; observationSequence = 0;
    await setup();
  });
  it("producer preparation: pages sessions by server creation time with stable ID ties", async () => {
    const batch = db.batch();
    for (let index = 0; index < 101; index++) {
      const id = `session-${String(index).padStart(3, "0")}`;
      batch.set(db.doc(`liveProductionSessions/${id}`), { ...session, id, createdAtMs: now + 1000,
        updatedAtMs: index === 0 ? now + 999999 : now + 1000 });
    }
    batch.set(db.doc("liveProductionSessions/z-newest"), { ...session, id: "z-newest", createdAtMs: now + 2000, updatedAtMs: now + 2000 });
    await batch.commit();
    const first = await ok({ action: "list_sessions" });
    expect(first.sessions.map(row => row.id)).toEqual(["z-newest", ...Array.from({ length: 99 }, (_, index) => `session-${String(index).padStart(3, "0")}`)]);
    const second = await ok({ action: "list_sessions", cursor: first.nextCursor });
    expect(second.sessions.map(row => row.id)).toEqual(["session-099", "session-100", session.id]);
    expect(second.nextCursor).toBeNull();
    expect((await invoke({ action: "list_sessions", cursor: "missing-session" })).statusCode).toBe(400);
  });
  it("producer preparation: excludes archived rows before the first banner page", async () => {
    const base = await banner();
    const collection = db.collection(`liveProductionSessions/${session.id}/banners`), batch = db.batch();
    batch.update(collection.doc(base.record.id), { archived: true });
    for (let index = 0; index < 150; index++) {
      const id = `archived-${index}`;
      batch.set(collection.doc(id), { ...base, archived: true, order: index, record: { ...base.record, id } });
    }
    for (const [id, order] of [["active-a", 150], ["active-b", 151]]) batch.set(collection.doc(id), { ...base, order, record: { ...base.record, id } });
    await batch.commit();
    const first = await staffCall("list_banners");
    expect(first.banners.map(row => row.record.id)).toEqual(["active-a", "active-b"]);
    expect(first.nextCursor).toBeNull();
    expect((await staffCall("list_banners", { cursor: "archived-149" })).banners.map(row => row.record.id)).toEqual(["active-a", "active-b"]);
  });
  it("producer preparation: restarting pages after moving a cursor row keeps every unseen banner", async () => {
    const base = await banner();
    const collection = db.collection(`liveProductionSessions/${session.id}/banners`), batch = db.batch();
    batch.delete(collection.doc(base.record.id));
    const ids = Array.from({ length: 201 }, (_, order) => `banner-${String(order).padStart(3, "0")}`);
    ids.forEach((id, order) => batch.set(collection.doc(id), { ...base, order, record: { ...base.record, id } }));
    await batch.commit();
    const first = await staffCall("list_banners");
    expect(first.banners).toHaveLength(100);
    expect(first.nextCursor).toBe("banner-099");
    await staffCall("save_banner", { bannerId: first.nextCursor, baseVersion: 1, text: base.record.draft.text, order: 200 });
    const restarted = await staffCall("list_banners");
    expect(restarted.banners).toHaveLength(100);
    expect(restarted.nextCursor).toBe("banner-100");
    const next = await staffCall("list_banners", { cursor: restarted.nextCursor });
    expect(next.banners).toHaveLength(100);
    const last = await staffCall("list_banners", { cursor: next.nextCursor });
    expect(last.banners).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    expect([...restarted.banners, ...next.banners, ...last.banners].map(row => row.record.id).sort()).toEqual(ids);
  });
  it("producer preparation: archive-first import is atomic and idempotent without clearing on-air output", async () => {
    const first = await banner(headline("Still on air")), second = await banner(headline("Old second"), { order: 1 });
    const take = (await command(first)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key, text: first.record.draft.text,
      source: "boardwalk", correlation: { commandId: take.id, bannerId: first.record.id, bannerVersion: 1 } }) });
    const before = await staffCall("get_session");
    const body = { action: "import_csv", sessionId: session.id, requestId: "replace-rundown", archiveExisting: true,
      csv: 'templateId,headline,name,title\nheadline,"  New, literal  ",,\nname_title,,Zoë & 李,' };
    const imported = await ok(body);
    expect(imported.banners.map(row => row.record.draft.text)).toEqual([headline("  New, literal  "), { templateId: "name_title", name: "Zoë & 李", title: "" }]);
    const collection = db.collection(`liveProductionSessions/${session.id}/banners`);
    for (const row of [first, second]) expect((await collection.doc(row.record.id).get()).data().archived).toBe(true);
    expect((await staffCall("list_banners")).banners.map(row => row.record.id)).toEqual(imported.banners.map(row => row.record.id));
    const after = await staffCall("get_session");
    expect(after.observed).toEqual(before.observed);
    expect(after.fences.clearGeneration).toBe(before.fences.clearGeneration);
    expect((await db.collection(`liveProductionSessions/${session.id}/commands`).get()).size).toBe(1);
    const replay = await ok(body);
    expect(replay.replayed).toBe(true); expect(replay.banners).toEqual(imported.banners);
    expect((await collection.get()).size).toBe(4);
    expect((await invoke({ ...body, archiveExisting: false })).statusCode).toBe(409);
    expect((await collection.get()).size).toBe(4);
  });
  it("producer preparation: invalid CSV and order overflow leave current banners untouched", async () => {
    const row = await banner(headline("Keep me"), { order: Number.MAX_SAFE_INTEGER });
    const collection = db.collection(`liveProductionSessions/${session.id}/banners`);
    const base = { action: "import_csv", sessionId: session.id, requestId: "bad-import", archiveExisting: true };
    expect((await invoke({ ...base, csv: "templateId,headline,name,title\nheadline,valid,,\nname_title,,," })).statusCode).toBe(400);
    expect((await invoke({ ...base, csv: "templateId,headline,name,title\nheadline,valid,," })).statusCode).toBe(409);
    expect((await invoke({ ...base, archiveExisting: "yes", csv: "templateId,headline,name,title\nheadline,valid,," })).statusCode).toBe(400);
    expect((await collection.doc(row.record.id).get()).data().archived).toBe(false);
    expect((await collection.get()).size).toBe(1);
    expect((await db.collection(`liveProductionSessions/${session.id}/audit`).where("action", "==", "import_csv").get()).empty).toBe(true);
  });
  it("producer preparation: archive-first byte overflow refuses before any banner write", async () => {
    const base = await banner(headline("Keep every current banner"));
    const collection = db.collection(`liveProductionSessions/${session.id}/banners`);
    // Exceeds even the entire 8 MiB / 4 KiB archive reserve, regardless of CSV size.
    for (let offset = 0; offset < 2100; offset += 350) {
      const batch = db.batch();
      for (let index = offset; index < offset + 350; index++) {
        const id = `archive-budget-${index}`;
        batch.set(collection.doc(id), { ...base, record: { ...base.record, id } });
      }
      await batch.commit();
    }
    const response = await invoke({ action: "import_csv", sessionId: session.id, requestId: "over-byte-budget", archiveExisting: true,
      csv: "templateId,headline,name,title\nheadline,new,," });
    expect(response.statusCode).toBe(413);
    expect((await collection.where("archived", "==", true).limit(1).get()).empty).toBe(true);
    expect((await collection.where("source", "==", "csv").limit(1).get()).empty).toBe(true);
    expect((await db.collection(`liveProductionSessions/${session.id}/audit`).where("action", "==", "import_csv").get()).empty).toBe(true);
  });
  it("keeps operator input identities, fixed fields and Overlay 1, and requires device verification", async () => {
    const state = await ok({ action: "get_session", sessionId: session.id });
    expect(state.mapping).toMatchObject({ inputs, overlay: 1, state: "commissioned", version: 2 });
    expect(state.serverNowMs).toBe(now);
    expect(state.commissioning).toMatchObject({ inputTypes, titleFiles: { headline: "operator-confirmed", name_title: "operator-confirmed" },
      operatorId: "producer", operatorConfirmedAtMs: now, verifiedByDeviceId: device.deviceId, verifiedAtMs: now });
    const changed = await staffCall("set_mapping", { baseMappingVersion: 2, deviceId: device.deviceId,
      inputs: { ...inputs, headline: { ...inputs.headline, key: "new-real-input" } } });
    expect(changed.session.state).toBe("draft");
    expect(changed.session.generation).toBe(session.generation + 1);
    session = changed.session;
    const stale = await invoke({ action: "set_session_state", sessionId: session.id, requestId: randomUUID(), baseGeneration: session.generation, state: "ready" });
    expect(stale.statusCode).toBe(409);
    const mismatch = await invoke({ action: "verify_mapping", sessionId: session.id, deviceId: device.deviceId,
      mappingVersion: 3, inputs, fields, inputTypes }, { agent: true });
    expect(mismatch.statusCode).toBe(409);
  });
  it.each(["headline", "name_title"])("commissions and correlates the named layered overlay for %s", async templateId => {
    const textInputs = { headline: { key: "text-headline", number: 111, title: "synthetic-headline.gtzip" },
      name_title: { key: "text-name", number: 112, title: "synthetic-name-title.gtzip" } };
    const overlayInputs = { headline: { key: "overlay-headline", number: 113, title: "Synthetic headline overlay" },
      name_title: { key: "overlay-name", number: 114, title: "Synthetic name-title overlay" } };
    const oldGeneration = session.generation;
    session = (await staffCall("set_mapping", { baseMappingVersion: 2, deviceId: device.deviceId, inputs: textInputs, overlayInputs })).session;
    expect(session).toMatchObject({ mappingVersion: 3, generation: oldGeneration + 1, state: "draft" });
    for (const evidence of [undefined, { ...overlayInputs, headline: textInputs.headline }]) {
      expect((await invoke({ action: "verify_mapping", sessionId: session.id, deviceId: device.deviceId,
        mappingVersion: 3, inputs: textInputs, fields, inputTypes, ...(evidence ? { overlayInputs: evidence } : {}) }, { agent: true })).statusCode).toBe(409);
    }
    expect((await agentCall("verify_mapping", { mappingVersion: 3, inputs: textInputs, overlayInputs, fields })).mapping)
      .toMatchObject({ inputs: textInputs, overlayInputs, state: "commissioned" });
    session = (await staffCall("set_session_state", { baseGeneration: session.generation, state: "ready" })).session;
    session = (await staffCall("set_session_state", { baseGeneration: session.generation, state: "active" })).session;
    await agentCall("observe", { observation: sample() });
    const text = templateId === "headline" ? headline("Layered headline") : { templateId, name: "Studio name", title: "" };
    const row = await banner(text);
    const take = (await command(row)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    const onAir = sample({ state: "on_air", inputKey: textInputs[templateId].key, text, source: "boardwalk",
      correlation: { commandId: take.id, bannerId: row.record.id, bannerVersion: 1 } });
    expect((await invoke({ action: "observe", sessionId: session.id, deviceId: device.deviceId, observation: onAir }, { agent: true })).statusCode).toBe(409);
    expect((await agentCall("observe", { observation: { ...onAir, inputKey: overlayInputs[templateId].key } })).observed.state).toBe("on_air");
    expect((await db.doc(`liveProductionSessions/${session.id}/banners/${row.record.id}`).get()).data().record.confirmedLive.snapshot).toEqual(take.snapshot);
    const edited = (await staffCall("save_banner", { bannerId: row.record.id, baseVersion: 1, order: 0,
      text: templateId === "headline" ? headline("Updated layered headline") : { templateId, name: "Updated name", title: "" } })).banner;
    const update = (await command(edited, { commandAction: "update_text" })).command;
    expect(update.expectedLive).toMatchObject({ inputKey: overlayInputs[templateId].key,
      correlation: { commandId: take.id, bannerVersion: 1 } });
    expect((await agentCall("fence", { commandId: update.id })).allowed).toBe(true);
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 3, expectedObservationSequence: observationSequence, commandAction: "clear",
      target: { kind: "banner", bannerId: row.record.id, version: 1, templateId } })).command;
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(true);
  });
  it("requires an explicit operator attestation and real GT-type evidence for commissioning", async () => {
    const missing = await invoke({ action: "set_mapping", sessionId: session.id, requestId: randomUUID(), baseMappingVersion: 2, deviceId: device.deviceId, inputs });
    expect(missing.statusCode).toBe(409);
    session = (await staffCall("set_mapping", { baseMappingVersion: 2, deviceId: device.deviceId, inputs })).session;
    const wrongType = await invoke({ action: "verify_mapping", sessionId: session.id, deviceId: device.deviceId,
      mappingVersion: 3, inputs, fields, inputTypes: { headline: "Video", name_title: "GT" } }, { agent: true });
    expect(wrongType.statusCode).toBe(409);
    const wrongFile = await invoke({ action: "verify_mapping", sessionId: session.id, deviceId: device.deviceId,
      mappingVersion: 3, inputs, fields, inputTypes, titleFiles: { headline: "C:\\Studio\\wrong.gtzip", name_title: null } }, { agent: true });
    expect(wrongFile.statusCode).toBe(409);
    const state = await ok({ action: "get_session", sessionId: session.id });
    expect(state.mapping.state).toBe("uncommissioned");
    expect(state.commissioning).toBeNull();
    const verified = await agentCall("verify_mapping", { mappingVersion: 3, inputs, fields, titleFiles: null });
    expect(verified.commissioning.titleFiles).toEqual({ headline: "operator-confirmed", name_title: "operator-confirmed" });
    expect(verified.commissioning.operatorId).toBe("producer");
    const titleFiles = { headline: `C:\\Studio\\${configuredTitleFiles.headline}`, name_title: `C:\\Studio\\${configuredTitleFiles.name_title}` };
    const changedEvidence = await invoke({ action: "verify_mapping", sessionId: session.id, deviceId: device.deviceId,
      mappingVersion: 3, inputs, fields, inputTypes, titleFiles }, { agent: true });
    expect(changedEvidence.statusCode).toBe(409);
    session = (await staffCall("set_mapping", { baseMappingVersion: 3, deviceId: device.deviceId, inputs })).session;
    expect((await agentCall("verify_mapping", { mappingVersion: 4, inputs, fields, titleFiles })).commissioning.titleFiles).toEqual(titleFiles);
  });
  it("uses independently supplied filenames and refuses missing or invalid configuration before commissioning", async () => {
    session = (await staffCall("set_mapping", { baseMappingVersion: 2, deviceId: device.deviceId, inputs })).session;
    const request = { action: "verify_mapping", sessionId: session.id, deviceId: device.deviceId,
      mappingVersion: 3, inputs, fields, inputTypes,
      titleFiles: { headline: "C:\\Studio\\custom-headline.GTZIP", name_title: "C:\\Studio\\custom-person.gtzip" } };
    for (const configuration of [undefined, null, {}, { ...configuredTitleFiles, extra: "field" },
      { ...configuredTitleFiles, headline: "../bad.gtzip" }, { ...configuredTitleFiles, headline: "C:\\private\\example.gtzip" }]) {
      for (const titleFiles of [request.titleFiles, null]) {
        const refused = await invoke({ ...request, titleFiles }, { agent: true, titleFiles: () => configuration });
        expect(refused.statusCode).toBe(503);
        expect(refused.body).toEqual({ error: "Live production is unavailable." });
        expect(refused.headers["Cache-Control"]).toBe("private, no-store");
        expect((await ok({ action: "get_session", sessionId: session.id })).mapping.state).toBe("uncommissioned");
      }
    }
    const custom = () => ({ headline: "custom-headline.gtzip", name_title: "custom-person.gtzip" });
    const wrong = await invoke({ ...request, titleFiles: { ...request.titleFiles, headline: "C:\\Studio\\example-headline.gtzip" } }, { agent: true, titleFiles: custom });
    expect(wrong.statusCode).toBe(409);
    expect((await invoke(request, { agent: true, titleFiles: custom })).statusCode).toBe(200);
    expect((await ok({ action: "get_session", sessionId: session.id })).commissioning.titleFiles).toEqual(request.titleFiles);
  });
  it("preserves long text and distinct draft/cue/accepted snapshots; draft saves never issue commands", async () => {
    const text = { templateId: "name_title", name: "  名字 ".repeat(1000), title: "" };
    const first = await banner(text);
    await staffCall("cue", { bannerId: first.record.id, baseVersion: 1 });
    const accepted = (await command(first)).command;
    const updated = (await staffCall("save_banner", { bannerId: first.record.id, baseVersion: 1, text: { ...text, title: "New title" }, order: 3 })).banner;
    expect(updated.record.cue.snapshot.text).toEqual(text);
    expect(updated.record.acceptedCommand).toEqual(accepted);
    expect(updated.record.draft.version).toBe(2);
    expect(updated.record.confirmedLive).toBeNull();
    const commands = await db.collection(`liveProductionSessions/${session.id}/commands`).get();
    expect(commands.size).toBe(1);
    expect(commands.docs[0].data().snapshot.text).toEqual(text);
    expect((await db.doc(`liveProductionSessions/${session.id}/banners/${first.record.id}`).get()).data()).toEqual(updated);
  });
  it("returns explicit concurrent version conflicts and idempotent create/import results", async () => {
    const first = await banner();
    const edits = await Promise.all(["First editor", "Second editor"].map(text => invoke({ action: "save_banner", sessionId: session.id,
      requestId: randomUUID(), bannerId: first.record.id, baseVersion: 1, order: 5, text: headline(text) })));
    expect(edits.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(edits.find(result => result.statusCode === 409).body.current.record.draft.version).toBe(2);
    const request = { action: "import_csv", sessionId: session.id, requestId: randomUUID(),
      csv: 'templateId,headline,name,title\nheadline,"  exact text  ",,\nname_title,,Name,' };
    const imported = await ok(request);
    expect(imported.banners.map(row => row.order)).toEqual([6, 7]);
    const replay = await ok(request);
    expect(replay.replayed).toBe(true);
    expect(replay.banners).toEqual(imported.banners);
    const list = await ok({ action: "list_banners", sessionId: session.id });
    expect(list.banners).toHaveLength(3);
    expect(list.banners[1].record.draft.text.headline).toBe("  exact text  ");
    expect((await invoke({ ...request, csv: request.csv + "\nheadline,changed,," })).statusCode).toBe(409);
  });
  it("rejects invalid imports atomically and never creates command side effects for Cue or archive", async () => {
    const bad = await invoke({ action: "import_csv", sessionId: session.id, requestId: randomUUID(), csv: 'templateId,headline,name,title\nheadline,good,,\nname_title,,,' });
    expect(bad.statusCode).toBe(400);
    expect((await db.collection(`liveProductionSessions/${session.id}/banners`).get()).size).toBe(0);
    const first = await banner();
    await staffCall("cue", { bannerId: first.record.id, baseVersion: 1 });
    await staffCall("archive_banner", { bannerId: first.record.id, baseVersion: 1 });
    expect((await db.collection(`liveProductionSessions/${session.id}/commands`).get()).size).toBe(0);
  });
  it("sequences concurrent intents, deduplicates immutable commands and audits once", async () => {
    const first = await banner();
    const request = { action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      commandAction: "take", sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: 1, expectedClearGeneration: 0,
      bannerId: first.record.id, baseVersion: 1 };
    const results = await Promise.all([ok(request), ok(request)]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].command).toEqual(results[1].command);
    const later = await command(first);
    expect(later.command.sequence).toBe(2);
    expect(later.command.expiresAtMs - later.command.createdAtMs).toBe(15000);
    expect((await invoke({ ...request, commandAction: "update_text" })).statusCode).toBe(409);
    expect((await db.collection(`liveProductionSessions/${session.id}/commands`).get()).size).toBe(2);
    expect((await db.collection(`liveProductionSessions/${session.id}/audit`).where("action", "==", "command").get()).size).toBe(2);
  });
  it("Clear fences queued and started Takes and returns only current generation deliveries", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: 1, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    expect(clear.clearGeneration).toBe(take.clearGeneration + 1);
    expect((await agentCall("fence", { commandId: take.id })).allowed).toBe(false);
    const response = await agentCall("pull", { timingId: "request-pull-1", afterSequence: 0 });
    expect(response.deliveries.map(value => value.command.id)).toEqual([clear.id]);
    expect(response.deliveries[0].timingId).toBe("request-pull-1");
    expect(contract.parseLiveCommandDelivery(response.deliveries[0]).ttlMs).toBe(15000);
    expect((await db.doc(`liveProductionSessions/${session.id}/commands/${take.id}`).get()).data()).toEqual(take);
  });
  it("rejects a Take submitted before Clear but arriving after Clear without a new journal entry", async () => {
    const first = await banner();
    const delayed = { action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: 1, expectedClearGeneration: 0,
      commandAction: "take", bannerId: first.record.id, baseVersion: 1 };
    await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation, mappingVersion: 2,
      expectedObservationSequence: 1, commandAction: "clear", target: { kind: "managed_overlay" } });
    const rejected = await invoke(delayed);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body.code).toBe("stale_clear_generation");
    expect((await db.doc(`liveProductionSessions/${session.id}/commands/${delayed.commandId}`).get()).exists).toBe(false);
    expect((await db.collection(`liveProductionSessions/${session.id}/commands`).get()).size).toBe(1);
  });
  it("admits Clear after a newer unchanged native poll and audits client and server sequence separately", async () => {
    await agentCall("observe", { observation: sample() });
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: 1, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    expect(clear.expectedObservationSequence).toBe(2);
    const audit = await db.collection(`liveProductionSessions/${session.id}/audit`).where("commandId", "==", clear.id).get();
    expect(audit.docs[0].data().clientExpectedObservationSequence).toBe(1);
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(true);
  });
  it("admits and observes managed Clear before any native sample, using the zero sentinel", async () => {
    await staffCall("set_session_state", { baseGeneration: session.generation, state: "ended" });
    observationSequence = 0;
    await setup({ observe: false });
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    expect(clear.expectedObservationSequence).toBe(0);
    await agentCall("observe", { observation: sample() });
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(true);
    expect((await agentCall("pull", { timingId: "initial-clear", afterSequence: 0 })).deliveries[0].command).toEqual(clear);
    await agentCall("receipt", { commandId: clear.id, receiptId: randomUUID(), status: "started" });
    expect((await agentCall("observe", { observation: sample({ source: "boardwalk", correlation: { commandId: clear.id } }) })).observed.state).toBe("clear");
  });
  it("preserves the latest pending safety Clear through stale reconnect and supersedes it with a newer Take", async () => {
    const row = await banner();
    const take = (await command(row)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key, text: row.record.draft.text,
      source: "boardwalk", correlation: { commandId: take.id, bannerId: row.record.id, bannerVersion: 1 } }) });
    now += 31000; // A disconnect leaves the last Boardwalk observation stale.
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: 0, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    const reconciled = await agentCall("observe", { observation: sample({ state: "on_air", inputKey: "fixture-td-input",
      text: null, source: "unknown", correlation: null }) });
    expect(reconciled.observed.report.source).toBe("unknown");
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(true);
    expect((await agentCall("pull", { timingId: "clear-after-reconnect", afterSequence: 0 })).deliveries.map(value => value.command.id)).toEqual([clear.id]);
    const laterTake = (await command(row, { expectedClearGeneration: clear.clearGeneration })).command;
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(false);
    expect((await agentCall("pull", { timingId: "newer-take", afterSequence: 0 })).deliveries.map(value => value.command.id)).toEqual([laterTake.id]);
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: "fixture-td-changed", source: "manual", correlation: null }) });
    expect((await agentCall("fence", { commandId: laterTake.id })).allowed).toBe(false);
  });
  it("keeps text updates from cancelling Clear and never revives Clear after a newer failed Take", async () => {
    const row = await banner();
    const firstTake = (await command(row)).command;
    await agentCall("receipt", { commandId: firstTake.id, receiptId: randomUUID(), status: "started" });
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key, text: row.record.draft.text,
      source: "boardwalk", correlation: { commandId: firstTake.id, bannerId: row.record.id, bannerVersion: 1 } }) });
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: 0, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    const updateId = randomUUID();
    const rejected = await invoke({ action: "command", sessionId: session.id, requestId: randomUUID(), commandId: updateId,
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: observationSequence,
      expectedClearGeneration: clear.clearGeneration, commandAction: "update_text", bannerId: row.record.id, baseVersion: 1 });
    expect(rejected.statusCode).toBe(409);
    expect((await db.doc(`liveProductionSessions/${session.id}/commands/${updateId}`).get()).exists).toBe(false);
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(true);
    const laterTake = (await command(row, { expectedClearGeneration: clear.clearGeneration })).command;
    await agentCall("receipt", { commandId: laterTake.id, receiptId: randomUUID(), status: "failed" });
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(false);
    expect((await agentCall("pull", { timingId: "failed-newer-intent", afterSequence: 0 })).deliveries).toEqual([]);
  });
  it("uses server expiry, never agent wall time; heartbeat cannot refresh native evidence", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    now += 14999;
    expect((await agentCall("pull", { timingId: "late-request", afterSequence: 0 })).deliveries[0].ttlMs).toBe(1);
    now++;
    expect((await agentCall("fence", { commandId: take.id })).allowed).toBe(false);
    expect((await agentCall("pull", { timingId: "expired-request", afterSequence: 0 })).deliveries).toEqual([]);
    now += 15000;
    expect((await agentCall("heartbeat", { timingId: "heartbeat-1" })).observed.state).toBe("stale");
    expect((await invoke({ action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: 1, expectedClearGeneration: 0,
      commandAction: "take", bannerId: first.record.id, baseVersion: 1 })).statusCode).toBe(409);
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: 0, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    expect((await agentCall("pull", { timingId: "stale-safety-clear", afterSequence: 0 })).deliveries.map(value => value.command.id)).toEqual([clear.id]);
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(true);
  });
  it("never redelivers started/unknown work; duplicate ACKs are idempotent without confirming on-air", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    const receipt = { commandId: take.id, receiptId: randomUUID(), status: "started" };
    await agentCall("receipt", receipt);
    expect((await agentCall("receipt", receipt)).replayed).toBe(true);
    expect((await agentCall("pull", { timingId: "after-restart", afterSequence: 0 })).deliveries).toEqual([]);
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "outcome_unknown" });
    expect((await agentCall("fence", { commandId: take.id })).allowed).toBe(false);
    const stored = (await db.doc(`liveProductionSessions/${session.id}/banners/${first.record.id}`).get()).data();
    expect(stored.record.confirmedLive).toBeNull();
    expect((await ok({ action: "get_session", sessionId: session.id })).observed.state).toBe("clear");
  });
  it("confirms only a new native observation with exact input, text, command and execution evidence", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    const onAir = sample({ state: "on_air", inputKey: inputs.headline.key, text: first.record.draft.text,
      source: "boardwalk", correlation: { commandId: take.id, bannerId: first.record.id, bannerVersion: 1 } });
    const request = { action: "observe", sessionId: session.id, deviceId: device.deviceId, observation: onAir };
    expect((await invoke(request, { agent: true })).statusCode).toBe(409);
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    expect((await invoke({ ...request, observation: { ...onAir, inputKey: "wrong-input" } }, { agent: true })).statusCode).toBe(409);
    const result = await ok(request, { agent: true });
    expect(result.observed.state).toBe("on_air");
    const stored = (await db.doc(`liveProductionSessions/${session.id}/banners/${first.record.id}`).get()).data();
    expect(stored.record.confirmedLive.snapshot).toEqual(take.snapshot);
    now += 100;
    expect((await invoke(request, { agent: true })).statusCode).toBe(409);
    expect((await ok({ action: "get_session", sessionId: session.id })).observed.receivedAtMs).toBe(now - 100);
    const edited = (await staffCall("save_banner", { bannerId: first.record.id, baseVersion: 1, order: 0, text: headline("Deliberate update") })).banner;
    expect((await command(edited, { commandAction: "update_text" })).command.snapshot.version).toBe(2);
    const targetedClear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: 1, commandAction: "clear",
      target: { kind: "banner", bannerId: first.record.id, version: 1, templateId: "headline" } })).command;
    expect(targetedClear.expectedObservationSequence).toBe(observationSequence);
  });
  it("Update live captures the old observation and exact saved revision without sending on Save", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    const old = sample({ state: "on_air", inputKey: inputs.headline.key, text: first.record.draft.text,
      source: "boardwalk", correlation: { commandId: take.id, bannerId: first.record.id, bannerVersion: 1 } });
    await agentCall("observe", { observation: old });
    expect((await invoke({ action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      sessionGeneration: session.generation, mappingVersion: session.mappingVersion, expectedObservationSequence: observationSequence,
      expectedClearGeneration: 0, commandAction: "update_text", bannerId: first.record.id, baseVersion: 1 })).statusCode).toBe(409);
    const edited = (await staffCall("save_banner", { bannerId: first.record.id, baseVersion: 1, order: 0,
      text: headline("Saved but not live") })).banner;
    expect((await ok({ action: "get_session", sessionId: session.id })).observed.report).toEqual(old);
    expect((await db.collection(`liveProductionSessions/${session.id}/commands`).get()).size).toBe(1);
    const update = (await command(edited, { commandAction: "update_text" })).command;
    expect(update).toMatchObject({ expectedLive: old, snapshot: { version: 2, text: headline("Saved but not live") } });
    await staffCall("save_banner", { bannerId: first.record.id, baseVersion: 2, order: 0, text: headline("Later draft only") });
    expect((await agentCall("pull", { timingId: "update-delivery", afterSequence: take.sequence })).deliveries[0].command).toEqual(update);
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: session.mappingVersion, expectedObservationSequence: observationSequence,
      commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    expect((await agentCall("fence", { commandId: update.id })).allowed).toBe(false);
    expect((await agentCall("fence", { commandId: clear.id })).allowed).toBe(true);
  });
  it("legacy update history keeps receipt retries, observations and saved banners readable", async () => {
    const row = await banner();
    const take = (await command(row)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    const legacy = { ...take, action: "update_text" };
    const commandRef = db.doc(`liveProductionSessions/${session.id}/commands/${legacy.id}`);
    await commandRef.set(legacy);
    await db.doc(`liveProductionSessions/${session.id}/banners/${row.record.id}`).set({ ...row,
      record: { ...row.record, acceptedCommand: legacy } });
    const receipt = { commandId: legacy.id, receiptId: randomUUID(), status: "succeeded" };
    expect((await agentCall("receipt", receipt)).replayed).toBe(false);
    expect((await agentCall("receipt", receipt)).replayed).toBe(true);
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key,
      text: legacy.snapshot.text, source: "boardwalk",
      correlation: { commandId: legacy.id, bannerId: row.record.id, bannerVersion: 1 } }) });
    const saved = (await staffCall("save_banner", { bannerId: row.record.id, baseVersion: 1, order: 0,
      text: headline("Saved after upgrade") })).banner;
    expect(contract.parseBannerRecord(saved.record).acceptedCommand).toEqual(legacy);
    expect(saved.record.confirmedLive.commandId).toBe(legacy.id);
    expect((await commandRef.get()).data()).toEqual(legacy);
  });
  it("legacy queued updates cannot start or deliver and do not block a newer Clear", async () => {
    const take = (await command(await banner())).command;
    const legacy = { ...take, action: "update_text" };
    const commandRef = db.doc(`liveProductionSessions/${session.id}/commands/${legacy.id}`);
    await commandRef.set(legacy);
    expect((await agentCall("fence", { commandId: legacy.id })).allowed).toBe(false);
    expect((await invoke({ action: "receipt", sessionId: session.id, deviceId: device.deviceId,
      commandId: legacy.id, receiptId: randomUUID(), status: "started" }, { agent: true })).statusCode).toBe(409);
    expect((await agentCall("pull", { timingId: "legacy-scan", afterSequence: 0 })).deliveries).toEqual([]);
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: session.mappingVersion, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    const pulled = await agentCall("pull", { timingId: "legacy-clear", afterSequence: 0 });
    expect(pulled.deliveries.map(value => value.command.id)).toEqual([clear.id]);
    expect(pulled.scannedThroughSequence).toBe(clear.sequence);
    expect((await commandRef.get()).data()).toEqual(legacy);
  });
  it("Update live rejects a later Take of the same banner even with identical observed text", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    const laterTake = (await command(first)).command;
    for (const item of [take, laterTake]) await agentCall("receipt", { commandId: item.id, receiptId: randomUUID(), status: "started" });
    const current = { state: "on_air", inputKey: inputs.headline.key, text: first.record.draft.text, source: "boardwalk" };
    await agentCall("observe", { observation: sample({ ...current,
      correlation: { commandId: take.id, bannerId: first.record.id, bannerVersion: 1 } }) });
    const edited = (await staffCall("save_banner", { bannerId: first.record.id, baseVersion: 1, order: 0, text: headline("Next text") })).banner;
    const update = (await command(edited, { commandAction: "update_text" })).command;
    await agentCall("observe", { observation: sample({ ...current,
      correlation: { commandId: laterTake.id, bannerId: first.record.id, bannerVersion: 1 } }) });
    expect((await agentCall("fence", { commandId: update.id })).allowed).toBe(false);
  });
  it("accepts Boardwalk Clear correlation without creating a confirmed live banner", async () => {
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: 1, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    await agentCall("receipt", { commandId: clear.id, receiptId: randomUUID(), status: "started" });
    const result = await agentCall("observe", { observation: sample({ source: "boardwalk", correlation: { commandId: clear.id } }) });
    expect(result.observed.state).toBe("clear");
  });
  it("projects the latest native evidence through manual change, unknown, stale and recovered Clear", async () => {
    const row = await banner();
    const take = (await command(row)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "succeeded" });
    expect((await staffCall("get_session")).observed.state).toBe("clear");
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key, text: take.snapshot.text,
      source: "boardwalk", correlation: { commandId: take.id, bannerId: row.record.id, bannerVersion: 1 } }) });
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key, text: take.snapshot.text }) });
    const manual = (await staffCall("get_session")).observed;
    expect(manual.state).toBe("on_air");
    expect(manual.report.source).toBe("manual");
    expect(manual.report.correlation).toBeNull(); // Equal text cannot restore banner identity.
    await agentCall("observe", { observation: sample({ state: "unknown", source: "unknown" }) });
    const received = now;
    now += 31000;
    const heartbeat = await agentCall("heartbeat", { timingId: "stale-unknown" });
    expect(heartbeat.observed).toMatchObject({ state: "stale", receivedAtMs: received, report: { state: "unknown" } });
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: session.mappingVersion, expectedObservationSequence: 0, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    await agentCall("receipt", { commandId: clear.id, receiptId: randomUUID(), status: "started" });
    await agentCall("observe", { observation: sample({ source: "boardwalk", correlation: { commandId: clear.id } }) });
    const recovered = (await staffCall("get_session")).observed;
    expect(recovered).toMatchObject({ state: "clear", receivedAtMs: now, report: { source: "boardwalk", correlation: { commandId: clear.id } } });
  });
  it("keeps queued intent across unchanged fresh manual polls while renewing observation freshness", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    now += 1000;
    await agentCall("observe", { observation: sample() });
    const status = await agentCall("heartbeat", { timingId: "unchanged-native-poll" });
    expect(status.fences.clearGeneration).toBe(take.clearGeneration);
    expect(status.observed.receivedAtMs).toBe(now);
    expect((await agentCall("fence", { commandId: take.id })).allowed).toBe(true);
    const clear = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: observationSequence, commandAction: "clear", target: { kind: "managed_overlay" } })).command;
    await agentCall("observe", { observation: sample() });
    expect((await agentCall("pull", { timingId: "clear-after-repeat", afterSequence: 0 })).deliveries.map(value => value.command.id)).toEqual([clear.id]);
  });
  it("fences pending work after manual TD intervention and accepts only the fresh generation", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: "native-td-input", source: "manual" }) });
    expect((await agentCall("fence", { commandId: take.id })).allowed).toBe(false);
    const delayed = await invoke({ action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: observationSequence,
      expectedClearGeneration: 0, commandAction: "take", bannerId: first.record.id, baseVersion: 1 });
    expect(delayed.body.code).toBe("stale_clear_generation");
    expect((await command(first, { expectedClearGeneration: 1 })).command.sequence).toBe(2);
  });
  it("does not admit text updates or targeted Clear against unrelated native graphics", async () => {
    const first = await banner();
    const update = await invoke({ action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: 1, expectedClearGeneration: 0,
      commandAction: "update_text", bannerId: first.record.id, baseVersion: 1 });
    expect(update.statusCode).toBe(409);
    const clear = await invoke({ action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: 1,
      commandAction: "clear", target: { kind: "banner", bannerId: first.record.id, version: 1, templateId: "headline" } });
    expect(clear.statusCode).toBe(409);
    expect((await db.collection(`liveProductionSessions/${session.id}/commands`).get()).size).toBe(0);
  });
  it("pages ordered rows without losing equal-order identities and bounds pages by response bytes", async () => {
    const first = await banner(headline("x".repeat(190000)));
    const second = await banner(headline("y".repeat(190000)));
    const third = await banner(headline("z".repeat(190000)));
    const page = await ok({ action: "list_banners", sessionId: session.id });
    expect(page.banners).toHaveLength(2);
    expect(page.nextCursor).toBe(page.banners[1].record.id);
    const next = await ok({ action: "list_banners", sessionId: session.id, cursor: page.nextCursor });
    expect(next.banners).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect([...page.banners, ...next.banners].map(row => row.record.id).sort()).toEqual([first.record.id, second.record.id, third.record.id].sort());
  });
  it("ends or remaps sessions without replaying old commands and preserves command sequence", async () => {
    const first = await banner();
    const take = (await command(first)).command;
    const changed = await staffCall("set_mapping", { baseMappingVersion: 2, deviceId: device.deviceId, inputs });
    session = changed.session;
    expect((await db.doc(`liveProductionDevices/${device.deviceId}`).get()).data().activeSessionId).toBeNull();
    expect((await agentCall("fence", { commandId: take.id })).allowed).toBe(false);
    expect((await agentCall("heartbeat", { timingId: "after-remap" })).fences.lastSequence).toBe(1);
    session = (await staffCall("set_session_state", { baseGeneration: session.generation, state: "ended" })).session;
    expect((await agentCall("fence", { commandId: take.id })).allowed).toBe(false);
  });
  it("denies staff without existing global edit access and rejects inactive or mismatched devices", async () => {
    for (const user of [{ ...staff, approvedActive: false }, { ...staff, principal: { grants: [{ role: "staff" }] } },
      { ...staff, principal: { grants: [{ role: "editor", sections: ["news"] }] } }]) {
      const result = await invoke({ action: "list_sessions" }, { user });
      expect(result.statusCode).toBe(403);
      expect(result.body).not.toHaveProperty("sessions");
    }
    await db.doc(`liveProductionDevices/${device.deviceId}`).update({ active: false });
    expect((await invoke({ action: "heartbeat", sessionId: session.id, deviceId: device.deviceId, timingId: "inactive" }, { agent: true })).statusCode).toBe(403);
    await db.doc(`liveProductionDevices/${device.deviceId}`).update({ active: true, authUid: "another-account" });
    expect((await invoke({ action: "heartbeat", sessionId: session.id, deviceId: device.deviceId, timingId: "wrong-uid" }, { agent: true })).statusCode).toBe(403);
  });
  it("verifies a real emulator Firebase device claim before consulting enrollment", async () => {
    const uid = `device-${randomUUID()}`;
    const email = `${uid}@example.test`;
    const password = "synthetic-test-password";
    await admin.auth().createUser({ uid, email, password });
    await admin.auth().setCustomUserClaims(uid, { liveProductionDeviceId: device.deviceId });
    await db.doc(`liveProductionDevices/${device.deviceId}`).update({ authUid: uid });
    const login = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const token = (await login.json()).idToken;
    expect(typeof token).toBe("string");
    const response = await invoke({ action: "heartbeat", sessionId: session.id, deviceId: device.deviceId, timingId: "real-token" }, { agent: true, token });
    expect(response.statusCode).toBe(200);
    expect((await invoke({ action: "heartbeat", sessionId: session.id, deviceId: "other-device", timingId: "wrong-device" }, { agent: true, token })).statusCode).toBe(403);
  });
  it("admits a realistic long headline without a graphic-fit or character limit", async () => {
    const text = headline("STATE ELECTION OFFICIALS OUTLINE VOTER REGISTRATION, EARLY VOTING AND MAIL BALLOT DEADLINES AHEAD OF NOVEMBER'S GENERAL ELECTION, WHILE COUNTY CLERKS PREPARE ADDITIONAL POLLING PLACES AND ACCESSIBLE TRANSPORT OPTIONS FOR RESIDENTS");
    const row = await banner(text);
    await staffCall("cue", { bannerId: row.record.id, baseVersion: 1 });
    expect((await command(row)).command.snapshot.text).toEqual(text);
  });
  it("reserves confirmation space before native admission and keeps large admitted observations recordable", async () => {
    const tooLarge = await banner(headline("x".repeat(261700)));
    await staffCall("cue", { bannerId: tooLarge.record.id, baseVersion: 1 });
    const rejectedId = "command".padEnd(128, "x");
    const rejected = await invoke({ action: "command", sessionId: session.id, requestId: "request".padEnd(128, "x"), commandId: rejectedId,
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: 1, expectedClearGeneration: 0,
      commandAction: "take", bannerId: tooLarge.record.id, baseVersion: 1 });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.body.error).toBe("Banner text too large to store");
    expect((await db.doc(`liveProductionSessions/${session.id}/commands/${rejectedId}`).get()).exists).toBe(false);
    expect((await agentCall("pull", { timingId: "after-size-rejection", afterSequence: 0 })).deliveries).toEqual([]);
    const fits = await banner(headline("y".repeat(220000)));
    await staffCall("cue", { bannerId: fits.record.id, baseVersion: 1 });
    const take = (await command(fits)).command;
    await agentCall("receipt", { commandId: take.id, receiptId: randomUUID(), status: "started" });
    const result = await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key,
      text: fits.record.draft.text, source: "boardwalk", correlation: { commandId: take.id, bannerId: fits.record.id, bannerVersion: 1 } }) });
    expect(result.observed.state).toBe("on_air");
    const stored = (await db.doc(`liveProductionSessions/${session.id}/banners/${fits.record.id}`).get()).data();
    expect(stored.record.confirmedLive.snapshot.text).toEqual(fits.record.draft.text);
    expect((await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: observationSequence, commandAction: "clear", target: { kind: "managed_overlay" } })).command.action).toBe("clear");
  });
  it("rechecks revoked staff authority inside reads and mutations instead of trusting the handler snapshot", async () => {
    const row = await banner();
    await db.doc("users/producer").update({ grants: [] });
    // invoke still supplies the formerly authorized principal at the auth boundary.
    const requests = [
      { action: "get_session", sessionId: session.id },
      { action: "list_sessions" },
      { action: "save_banner", sessionId: session.id, requestId: randomUUID(), bannerId: row.record.id, baseVersion: 1, order: 0, text: headline("Unauthorized edit") },
      { action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(), sessionGeneration: session.generation,
        mappingVersion: 2, expectedObservationSequence: 1, expectedClearGeneration: 0, commandAction: "take", bannerId: row.record.id, baseVersion: 1 },
      { action: "create_session", requestId: randomUUID(), title: "Unauthorized session", productionProgramId: "fixture-news" },
    ];
    for (const request of requests) expect((await invoke(request)).statusCode).toBe(403);
    expect((await db.doc(`liveProductionSessions/${session.id}/banners/${row.record.id}`).get()).data().record.draft.version).toBe(1);
    expect((await db.collection(`liveProductionSessions/${session.id}/commands`).get()).size).toBe(0);
    expect((await db.collection("liveProductionSessions").get()).size).toBe(1);
  });
  it("honors a newly activated staff tier inside admission even when legacy grants were cached", async () => {
    const row = await banner();
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    await db.doc("users/producer").update({ accessTier: "viewer" });
    const result = await invoke({ action: "command", sessionId: session.id, requestId: randomUUID(), commandId: randomUUID(),
      sessionGeneration: session.generation, mappingVersion: 2, expectedObservationSequence: 1, expectedClearGeneration: 0,
      commandAction: "take", bannerId: row.record.id, baseVersion: 1 });
    expect(result.statusCode).toBe(403);
  });
  it.each(["update_text", "clear"])("rechecks the live banner for contextual %s before pull and native fences", async action => {
    const a = await banner(headline("Duplicate wording"));
    const b = await banner(headline("Duplicate wording"));
    const pendingB = (await command(b)).command;
    await agentCall("receipt", { commandId: pendingB.id, receiptId: randomUUID(), status: "started" });
    const currentA = (await command(a)).command;
    await agentCall("receipt", { commandId: currentA.id, receiptId: randomUUID(), status: "started" });
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key, text: a.record.draft.text,
      source: "boardwalk", correlation: { commandId: currentA.id, bannerId: a.record.id, bannerVersion: 1 } }) });
    let queued;
    if (action === "update_text") {
      const edited = (await staffCall("save_banner", { bannerId: a.record.id, baseVersion: 1, order: 0, text: headline("Revised wording") })).banner;
      queued = (await command(edited, { commandAction: "update_text" })).command;
    } else queued = (await staffCall("command", { commandId: randomUUID(), sessionGeneration: session.generation,
      mappingVersion: 2, expectedObservationSequence: observationSequence, commandAction: "clear",
      target: { kind: "banner", bannerId: a.record.id, version: 1, templateId: "headline" } })).command;
    expect((await agentCall("fence", { commandId: queued.id })).allowed).toBe(true);
    // An earlier started Take can settle later. Equal words/input do not make B the same banner as A.
    await agentCall("observe", { observation: sample({ state: "on_air", inputKey: inputs.headline.key, text: b.record.draft.text,
      source: "boardwalk", correlation: { commandId: pendingB.id, bannerId: b.record.id, bannerVersion: 1 } }) });
    expect((await agentCall("fence", { commandId: queued.id })).allowed).toBe(false);
    expect((await agentCall("pull", { timingId: `context-${action}`, afterSequence: 0 })).deliveries).toEqual([]);
  });
  it("binds receipt IDs across commands without suppressing another command on a misaddressed retry", async () => {
    const row = await banner();
    const a = (await command(row)).command;
    const b = (await command(row)).command;
    const receiptId = randomUUID();
    const body = { commandId: a.id, receiptId, status: "failed" };
    await agentCall("receipt", body);
    const wrong = await invoke({ action: "receipt", sessionId: session.id, deviceId: device.deviceId,
      commandId: b.id, receiptId, status: "failed" }, { agent: true });
    expect(wrong.statusCode).toBe(409);
    expect((await agentCall("receipt", body)).replayed).toBe(true);
    expect((await db.doc(`liveProductionSessions/${session.id}/commands/${b.id}/receipts/failed`).get()).exists).toBe(false);
    expect((await agentCall("pull", { timingId: "receipt-identity", afterSequence: 0 })).deliveries.map(value => value.command.id)).toEqual([b.id]);
  });
  it("rejects unknown fields and oversize bytes instead of shortening banner text", async () => {
    const request = { action: "save_banner", sessionId: session.id, requestId: randomUUID(), baseVersion: 0, order: 0, text: headline("x".repeat(270000)) };
    expect((await invoke(request)).statusCode).toBe(413);
    expect((await invoke({ action: "get_session", sessionId: session.id, actorId: "forged" })).statusCode).toBe(400);
  });
});
