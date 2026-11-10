"use strict";

const { FieldPath } = require("firebase-admin/firestore");
const { assertStaffAuthority } = require("./live-production-authority");
const { firestoreDocumentBytes, MAX_DOCUMENT_BYTES } = require("./document-size");
function assertDocumentFits(ref, value) {
  if (firestoreDocumentBytes(value, ref.path) > MAX_DOCUMENT_BYTES) fail("Banner text too large to store", 413);
}
function boundedWrite(transaction, method, ref, value) {
  assertDocumentFits(ref, value);
  return transaction[method](ref, value);
}
const {
  LIVE_PRODUCTION_COLLECTION, parseProductionSession, parseTemplateMapping,
  parseBannerText, parseBannerRecord, parseCueSnapshot, projectObservedState,
} = require("./live-production-contract");
const { MAX_REQUEST_BYTES, fail, validId, positive, nonnegative, hash, fingerprint, parseBannerCsv } = require("./live-production-requests");

// Reserve enough space for any historical accepted snapshot to be confirmed.
// This is a byte budget check only; it never stores a predicted on-air result.
function assertBannerFits(ref, banner) {
  const reservation = { ...banner, record: { ...banner.record, confirmedLive: {
    commandId: "_".repeat(128), observationSequence: 1, observedAtMs: 0,
    snapshot: { bannerId: banner.record.id, sessionId: banner.record.sessionId,
      version: 1, mappingVersion: 1, text: { templateId: "name_title", name: "", title: "" } },
  } } };
  // Every accepted text payload fits the shared HTTP byte budget. The skeleton
  // accounts for map fields, maximum command ID length and fixed-width numbers.
  if (firestoreDocumentBytes(reservation, ref.path) + MAX_REQUEST_BYTES > MAX_DOCUMENT_BYTES) {
    fail("Banner text too large to store", 413);
  }
  assertDocumentFits(ref, banner);
}
function writeBanner(transaction, ref, banner, method = "set") {
  assertBannerFits(ref, banner);
  return boundedWrite(transaction, method, ref, banner);
}

const sessionRef = (db, id) => db.collection(LIVE_PRODUCTION_COLLECTION).doc(id);
const controlRef = ref => ref.collection("observations").doc("current");
const initialControl = () => ({ clearGeneration: 0, lastSequence: 0, report: null, receivedAtMs: 0 });
const observed = (control, now) => ({ ...projectObservedState(control.report, control.receivedAtMs, now), receivedAtMs: control.receivedAtMs });
const fences = (session, control) => ({ sessionGeneration: session.generation, mappingVersion: session.mappingVersion,
  clearGeneration: control.clearGeneration, lastSequence: control.lastSequence, active: session.state === "active" });
function snapshotFor(session, record) {
  return { bannerId: record.id, sessionId: session.id, version: record.draft.version, mappingVersion: session.mappingVersion, text: record.draft.text };
}
function assertEditable(session) { if (session.state === "ended") fail("This session ended.", 409); }
function checkVersion(actual, expected, current) {
  if (actual !== expected) fail("The record changed. Reload before saving.", 409, current);
}
async function getSession(transaction, ref) {
  const data = (await transaction.get(ref)).data();
  if (!data) fail("Session not found.", 404);
  return parseProductionSession(data);
}
async function getMapping(transaction, ref, session) {
  const data = (await transaction.get(ref.collection("mappings").doc(String(session.mappingVersion)))).data();
  if (!data) fail("Mapping not found.", 409);
  return parseTemplateMapping(data);
}
function audit(transaction, ref, id, actorId, action, atMs, detail = {}) {
  boundedWrite(transaction, "create", ref.collection("audit").doc(id), { actorId, action, atMs, ...detail });
}
function bannerWrapper(session, actorId, id, text, order, now, source = "manual") {
  return { record: parseBannerRecord({ schemaVersion: 1, id, sessionId: session.id,
    draft: { version: 1, text, updatedAtMs: now, updatedBy: actorId }, cue: null, acceptedCommand: null, confirmedLive: null }),
  order, source, archived: false };
}

function pageOf(docs, transform) {
  const values = [];
  let bytes = 0;
  for (const doc of docs.slice(0, 100)) {
    const value = transform(doc);
    const size = Buffer.byteLength(JSON.stringify(value));
    if (values.length && bytes + size > 512 * 1024) break;
    bytes += size; values.push(value);
  }
  return { values, nextCursor: docs.length > values.length ? docs[values.length - 1].id : null };
}
async function readStaff(db, request, actor, now) {
  return db.runTransaction(async transaction => {
    await assertStaffAuthority(db, transaction, actor);
    if (request.action === "list_sessions") {
      let query = db.collection(LIVE_PRODUCTION_COLLECTION).orderBy("createdAtMs", "desc").orderBy(FieldPath.documentId()).limit(101);
      if (request.cursor) {
        const cursor = (await transaction.get(sessionRef(db, request.cursor))).data();
        if (!cursor) fail("Session cursor not found.", 400);
        query = query.startAfter(parseProductionSession(cursor).createdAtMs, request.cursor);
      }
      const docs = (await transaction.get(query)).docs;
      const page = pageOf(docs, doc => parseProductionSession(doc.data()));
      return { sessions: page.values, nextCursor: page.nextCursor };
    }
    const ref = sessionRef(db, request.sessionId);
    const session = await getSession(transaction, ref);
    if (request.action === "get_session") {
      const mapping = await getMapping(transaction, ref, session);
      const control = (await transaction.get(controlRef(ref))).data() ?? initialControl();
      const commissioning = (await transaction.get(ref.collection("audit").doc(`mapping_verified_${mapping.version}`))).data()?.commissioning ?? null;
      return { session, mapping, commissioning, fences: fences(session, control), observed: observed(control, now), serverNowMs: now };
    }
    let query = ref.collection("banners").where("archived", "==", false).orderBy("order").orderBy(FieldPath.documentId()).limit(101);
    if (request.cursor) {
      const cursor = (await transaction.get(ref.collection("banners").doc(request.cursor))).data();
      if (!cursor) fail("Banner cursor not found.", 400);
      query = query.startAfter(cursor.order, request.cursor);
    }
    const docs = (await transaction.get(query)).docs;
    const page = pageOf(docs, doc => doc.data());
    return { banners: page.values, nextCursor: page.nextCursor };
  });
}

async function saveMapping({ db, transaction, ref, session, request, actorId, now }) {
  assertEditable(session);
  checkVersion(session.mappingVersion, request.baseMappingVersion);
  if (request.titleFilesConfirmed !== true) fail("Confirm the two studio GT title files before saving the mapping.", 409);
  if (!validId(request.deviceId)) fail("A device is required.");
  const deviceRef = db.collection("liveProductionDevices").doc(request.deviceId);
  const device = (await transaction.get(deviceRef)).data();
  if (!device?.active || !validId(device.authUid)) fail("Enroll the device before mapping inputs.", 409);
  if (device.activeSessionId && device.activeSessionId !== session.id) fail("The device has another active session.", 409);
  const oldDeviceRef = session.deviceId && session.deviceId !== request.deviceId ? db.collection("liveProductionDevices").doc(session.deviceId) : null;
  const oldDevice = oldDeviceRef ? (await transaction.get(oldDeviceRef)).data() : null;
  const mapping = parseTemplateMapping({ schemaVersion: 1, sessionId: session.id, deviceId: request.deviceId,
    version: session.mappingVersion + 1, overlay: 1, state: "uncommissioned", inputs: request.inputs,
    ...(Object.hasOwn(request, "overlayInputs") ? { overlayInputs: request.overlayInputs } : {}), verifiedAtMs: null });
  // A remap also fences in-flight work; it needs a new native inventory check.
  const next = parseProductionSession({ ...session, deviceId: request.deviceId, mappingVersion: mapping.version,
    generation: session.generation + 1, state: "draft", updatedAtMs: now });
  const control = (await transaction.get(controlRef(ref))).data() ?? initialControl();
  transaction.create(ref.collection("mappings").doc(String(mapping.version)), mapping);
  audit(transaction, ref, `mapping_setup_${mapping.version}`, actorId, "mapping_setup", now, { mappingVersion: mapping.version, titleFilesConfirmed: true });
  transaction.set(ref, next);
  transaction.set(controlRef(ref), { ...control, report: null, receivedAtMs: 0 });
  if (oldDevice?.activeSessionId === session.id) transaction.update(oldDeviceRef, { activeSessionId: null });
  if (device.activeSessionId === session.id) transaction.update(deviceRef, { activeSessionId: null });
  return { session: next, mapping };
}
async function setState({ db, transaction, ref, session, request, now }) {
  checkVersion(session.generation, request.baseGeneration);
  const transitions = { draft: ["ready", "ended"], ready: ["active", "ended"], active: ["ended"], ended: [] };
  if (!transitions[session.state].includes(request.state)) fail("Invalid session lifecycle change.", 409);
  if (request.state !== "ended") {
    const mapping = await getMapping(transaction, ref, session);
    if (mapping.state !== "commissioned" || mapping.deviceId !== session.deviceId) fail("Verify the device mapping first.", 409);
  }
  let deviceRef, enrollment;
  if (session.deviceId) {
    deviceRef = db.collection("liveProductionDevices").doc(session.deviceId);
    enrollment = (await transaction.get(deviceRef)).data();
  }
  if (request.state === "active" && (enrollment?.active !== true || (enrollment.activeSessionId && enrollment.activeSessionId !== session.id))) fail("End the device’s other active session before activation.", 409);
  const next = parseProductionSession({ ...session, state: request.state,
    generation: session.generation + (request.state === "ended" ? 1 : 0), updatedAtMs: now });
  transaction.set(ref, next);
  if (deviceRef && (request.state === "active" || enrollment?.activeSessionId === session.id)) transaction.update(deviceRef, { activeSessionId: request.state === "active" ? session.id : null });
  return { session: next };
}
async function saveBanner({ transaction, ref, session, request, actorId, now }) {
  assertEditable(session);
  const create = request.bannerId === undefined;
  const id = create ? hash(`${actorId}:${request.requestId}`).slice(0, 32) : request.bannerId;
  if (!validId(id) || !nonnegative(request.baseVersion) || !nonnegative(request.order)) fail("Specify banner version and order.");
  const bannerRef = ref.collection("banners").doc(id);
  const before = (await transaction.get(bannerRef)).data();
  checkVersion(before?.record.draft.version ?? 0, request.baseVersion, before);
  if (before?.archived) fail("The banner is archived.", 409);
  if (!create && !before) fail("Banner not found.", 404);
  if (create && before) fail("Banner already exists.", 409);
  const text = parseBannerText(request.text);
  const banner = before ? { ...before, order: request.order,
    record: parseBannerRecord({ ...before.record, draft: { version: before.record.draft.version + 1, text, updatedAtMs: now, updatedBy: actorId } }) }
    : bannerWrapper(session, actorId, id, text, request.order, now);
  writeBanner(transaction, bannerRef, banner);
  return { banner };
}
async function changeBanner({ transaction, ref, session, request, now }) {
  assertEditable(session);
  if (!validId(request.bannerId) || !positive(request.baseVersion)) fail("Specify banner and version.");
  const bannerRef = ref.collection("banners").doc(request.bannerId);
  const banner = (await transaction.get(bannerRef)).data();
  if (!banner) fail("Banner not found.", 404);
  checkVersion(banner.record.draft.version, request.baseVersion, banner);
  let next;
  if (request.action === "archive_banner") next = { ...banner, archived: true };
  else {
    if (banner.archived) fail("The banner is archived.", 409);
    const cue = parseCueSnapshot({ id: hash(request.requestId).slice(0, 32), capturedAtMs: now, snapshot: snapshotFor(session, banner.record) });
    next = { ...banner, record: parseBannerRecord({ ...banner.record, cue }) };
  }
  writeBanner(transaction, bannerRef, next);
  return { banner: next };
}
// Below Firestore's 10 MiB Commit limit. Include write/index/protocol reserves;
// do not invent a 500-write ceiling (removed March 29, 2023).
// https://docs.cloud.google.com/firestore/docs/release-notes#March_29_2023
const IMPORT_WRITE_BUDGET = 8 * 1024 * 1024;
const IMPORT_DOCUMENT_RESERVE = 16 * 1024;
const IMPORT_ARCHIVE_RESERVE = 4 * 1024;
async function importCsv({ transaction, ref, session, request, actorId, now, checkResult }) {
  assertEditable(session);
  // Validate every row before reading or queuing any archive write.
  const rows = parseBannerCsv(request.csv);
  const latest = await transaction.get(ref.collection("banners").orderBy("order", "desc").select("order").limit(1));
  const start = latest.empty ? 0 : latest.docs[0].data().order + 1;
  if (!nonnegative(start) || rows.length - 1 > Number.MAX_SAFE_INTEGER - start) fail("Banner order exceeds the integer budget.", 409);
  const banners = rows.map((text, index) => bannerWrapper(session, actorId,
    hash(`${actorId}:${request.requestId}:${index}`).slice(0, 32), text, start + index, now, "csv"));
  const result = { banners };
  let bytes = checkResult(result) * 2 + IMPORT_DOCUMENT_RESERVE;
  for (const banner of banners) {
    const bannerRef = ref.collection("banners").doc(banner.record.id);
    assertBannerFits(bannerRef, banner);
    bytes += firestoreDocumentBytes(banner, bannerRef.path) * 2 + IMPORT_DOCUMENT_RESERVE;
  }
  if (bytes > IMPORT_WRITE_BUDGET) fail("This import exceeds the transaction size budget. Import a smaller CSV.", 413);
  let archived = [];
  if (request.archiveExisting === true) {
    const allowance = Math.floor((IMPORT_WRITE_BUDGET - bytes) / IMPORT_ARCHIVE_RESERVE);
    // Project only the changed field; historical banner text is not hydrated.
    // The remaining byte allowance bounds this query plus one overflow sentinel.
    archived = (await transaction.get(ref.collection("banners").where("archived", "==", false).select("archived").limit(allowance + 1))).docs;
    if (archived.length > allowance) fail("Too many current banners for one archive-first import. Archive some first, or append the CSV.", 413);
  }
  // Every read and every document/aggregate size check precedes the first write.
  for (const doc of archived) transaction.update(doc.ref, { archived: true });
  for (const banner of banners) writeBanner(transaction, ref.collection("banners").doc(banner.record.id), banner, "create");
  return result;
}
async function mutateStaff(db, request, actor, clock = Date.now) {
  const actorId = actor.uid;
  const id = request.action === "create_session" ? hash(`${actorId}:${request.requestId}`).slice(0, 32) : request.sessionId;
  const ref = sessionRef(db, id);
  const requestKey = hash(`${actorId}:${request.requestId}`);
  const requestRef = ref.collection("audit").doc(`request_${requestKey}`);
  const digest = fingerprint(request);
  return db.runTransaction(async transaction => {
    await assertStaffAuthority(db, transaction, actor);
    const prior = (await transaction.get(requestRef)).data();
    if (prior) {
      if (prior.fingerprint !== digest) fail("Request ID was used with different data.", 409);
      return { ...prior.result, replayed: true };
    }
    const now = clock();
    let result;
    if (request.action === "create_session") {
      const session = parseProductionSession({ schemaVersion: 1, id, title: request.title, productionProgramId: request.productionProgramId,
        publicProgramId: request.publicProgramId ?? null, showPlanId: request.showPlanId ?? null, deviceId: null, generation: 1,
        mappingVersion: 1, state: "draft", createdAtMs: now, updatedAtMs: now });
      const mapping = parseTemplateMapping({ schemaVersion: 1, sessionId: id, deviceId: null, version: 1, overlay: 1,
        state: "uncommissioned", inputs: { headline: null, name_title: null }, verifiedAtMs: null });
      transaction.create(ref, session);
      transaction.create(ref.collection("mappings").doc("1"), mapping);
      transaction.create(controlRef(ref), initialControl());
      result = { session };
    } else {
      const session = await getSession(transaction, ref);
      const checkResult = result => {
        const receipt = { actorId, action: request.action, atMs: now, fingerprint: digest, result };
        assertDocumentFits(requestRef, receipt);
        return firestoreDocumentBytes(receipt, requestRef.path);
      };
      const context = { db, transaction, ref, session, request, actorId, now, checkResult };
      switch (request.action) {
      case "set_mapping": result = await saveMapping(context); break;
      case "set_session_state": result = await setState(context); break;
      case "save_banner": result = await saveBanner(context); break;
      case "archive_banner": case "cue": result = await changeBanner(context); break;
      case "import_csv": result = await importCsv(context); break;
      default: fail("Unsupported staff mutation.");
      }
    }
    // Request receipt and audit are one append-only record in the same transaction.
    audit(transaction, ref, `request_${requestKey}`, actorId, request.action, now, { fingerprint: digest, result });
    return { ...result, replayed: false };
  });
}
module.exports = { boundedWrite, writeBanner, sessionRef, controlRef, initialControl, observed, fences, snapshotFor, assertEditable,
  checkVersion, getSession, getMapping, audit, readStaff, mutateStaff };
