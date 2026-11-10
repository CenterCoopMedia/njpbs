"use strict";

const { win32 } = require("node:path");
const {
  LIVE_COMMAND_MAX_TTL_MS, LIVE_TEMPLATES, parseLiveCommand, parsePersistedLiveCommand, parseBannerRecord,
  parseAgentObservation, parseTemplateMapping, parseStudioTitleFiles, mappedOverlayInput, issueLiveCommandDelivery,
} = require("./live-production-contract");
const { assertStaffAuthority } = require("./live-production-authority");
const { fail, validId, positive, nonnegative, hash, fingerprint, fields } = require("./live-production-requests");
const { writeBanner, sessionRef, controlRef, initialControl, observed, fences, snapshotFor,
  getSession, getMapping, audit, checkVersion } = require("./live-production-store");

function same(left, right) { return fingerprint(left) === fingerprint(right); }
function matchesBanner(report, target) {
  return report?.source === "boardwalk" && report.state === "on_air" &&
    report.correlation?.bannerId === target.bannerId && report.correlation?.bannerVersion === target.version &&
    report.text?.templateId === target.templateId;
}
function managedClear(action, target) { return action === "clear" && target?.kind === "managed_overlay"; }
function assertFresh(session, control, request, now) {
  if (session.state !== "active") fail("Activate the production session first.", 409);
  if (session.generation !== request.sessionGeneration || session.mappingVersion !== request.mappingVersion) fail("Session or mapping changed.", 409);
  if (managedClear(request.commandAction, request.target)) return;
  const state = observed(control, now);
  const sequenceMatches = request.commandAction === "clear"
    ? request.expectedObservationSequence <= control.report?.sequence
    : request.expectedObservationSequence === control.report?.sequence;
  if (!["on_air", "clear"].includes(state.state) || !sequenceMatches) fail("Refresh native observed state before live control.", 409);
}
function assertActionContext(request, control, snapshot, mapping) {
  if (request.commandAction === "update_text" && (!matchesBanner(control.report, {
    bannerId: snapshot.bannerId, version: control.report?.correlation?.bannerVersion, templateId: snapshot.text.templateId,
  }) || control.report.inputKey !== mappedOverlayInput(mapping, snapshot.text.templateId)?.key ||
    control.report.correlation.bannerVersion >= snapshot.version || same(control.report.text, snapshot.text))) {
    fail("Update live needs changed saved text for the same observed Boardwalk banner and template.", 409);
  }
  if (request.commandAction === "clear" && request.target?.kind === "banner" && !matchesBanner(control.report, request.target)) {
    fail("The expected banner is no longer observed on air.", 409);
  }
}
async function admitCommand(db, request, actor, clock = Date.now) {
  const actorId = actor.uid;
  if (!validId(request.commandId) || !["take", "update_text", "clear"].includes(request.commandAction)) fail("Choose a command action and unique commandId.");
  if (![request.sessionGeneration, request.mappingVersion].every(positive)) fail("Specify session and mapping preconditions.");
  if (request.commandAction !== "clear" && !positive(request.expectedObservationSequence)) fail("Specify an observation precondition.");
  if (request.commandAction === "clear" && !managedClear(request.commandAction, request.target) && !positive(request.expectedObservationSequence)) fail("Specify an observation precondition.");
  if (request.commandAction === "clear" && (request.bannerId !== undefined || request.baseVersion !== undefined)) fail("Clear uses only an explicit target.");
  if (request.commandAction !== "clear" && (request.target !== undefined || !validId(request.bannerId) || !positive(request.baseVersion))) fail("Take/update needs a banner version.");
  const ref = sessionRef(db, request.sessionId);
  const commandRef = ref.collection("commands").doc(request.commandId);
  const requestRef = ref.collection("audit").doc(`request_${hash(`${actorId}:${request.requestId}`)}`);
  const digest = fingerprint(request);
  return db.runTransaction(async transaction => {
    await assertStaffAuthority(db, transaction, actor);
    const session = await getSession(transaction, ref);
    const prior = (await transaction.get(requestRef)).data();
    const existing = (await transaction.get(commandRef)).data();
    if (prior || existing) {
      if (!prior || prior.fingerprint !== digest || !existing || existing.actorId !== actorId || existing.requestId !== request.requestId) fail("Command/request ID is already bound to different intent.", 409);
      return { command: parseLiveCommand(existing), replayed: true };
    }
    const mapping = await getMapping(transaction, ref, session);
    const control = (await transaction.get(controlRef(ref))).data() ?? initialControl();
    const now = clock();
    if (request.commandAction !== "clear" && (!nonnegative(request.expectedClearGeneration) || request.expectedClearGeneration !== control.clearGeneration)) fail("A Clear or native intervention superseded this intent.", 409, undefined, "stale_clear_generation");
    assertFresh(session, control, request, now);
    if (mapping.state !== "commissioned" || mapping.deviceId !== session.deviceId) fail("Mapping is not commissioned.", 409);
    const device = (await transaction.get(db.collection("liveProductionDevices").doc(session.deviceId))).data();
    if (device?.active !== true || device.activeSessionId !== session.id) fail("Device is inactive or bound to another active session.", 409);
    if (request.commandAction === "update_text" && await latestPendingManagedClear(transaction, ref, session, mapping, control, now)) fail("Clear is pending. Use Take for a new banner.", 409);
    let bannerRef, banner, snapshot;
    if (request.commandAction !== "clear") {
      bannerRef = ref.collection("banners").doc(request.bannerId);
      banner = (await transaction.get(bannerRef)).data();
      if (!banner || banner.archived) fail("Banner unavailable.", 404);
      checkVersion(banner.record.draft.version, request.baseVersion, banner);
      snapshot = snapshotFor(session, banner.record);
    }
    assertActionContext(request, control, snapshot, mapping);
    const clearGeneration = control.clearGeneration + (request.commandAction === "clear" ? 1 : 0);
    const command = parseLiveCommand({ schemaVersion: 1, protocolVersion: 1, id: request.commandId, requestId: request.requestId,
      actorId, sessionId: session.id, deviceId: session.deviceId, sessionGeneration: session.generation,
      mappingVersion: session.mappingVersion, sequence: control.lastSequence + 1, clearGeneration, overlay: 1,
      createdAtMs: now, expiresAtMs: now + LIVE_COMMAND_MAX_TTL_MS, expectedObservationSequence: control.report?.sequence ?? 0,
      action: request.commandAction, ...(snapshot ? { snapshot } : { target: request.target }),
      ...(request.commandAction === "update_text" ? { expectedLive: control.report } : {}) });
    transaction.create(commandRef, command);
    transaction.set(controlRef(ref), { ...control, clearGeneration, lastSequence: command.sequence });
    if (banner) writeBanner(transaction, bannerRef, { ...banner, record: parseBannerRecord({ ...banner.record, acceptedCommand: command }) });
    audit(transaction, ref, requestRef.id, actorId, "command", now, { commandId: command.id, fingerprint: digest, clientExpectedObservationSequence: request.expectedObservationSequence ?? null });
    return { command, replayed: false };
  });
}

async function assertDevice(transaction, db, device) {
  const enrollment = (await transaction.get(db.collection("liveProductionDevices").doc(device.deviceId))).data();
  if (enrollment?.active !== true || enrollment.authUid !== device.uid) fail("Device enrollment is inactive or does not match.", 403);
}
function bound(session, mapping, device) {
  if (session.deviceId !== device.deviceId || mapping.deviceId !== device.deviceId) fail("Device is not bound to this session.", 403);
}
function contextualTargetMatches(command, mapping, report) {
  if (command.action === "clear" && command.target.kind === "banner") return matchesBanner(report, command.target);
  if (command.action !== "update_text") return true;
  const expected = command.expectedLive;
  return matchesBanner(report, { bannerId: command.snapshot.bannerId,
    version: expected.correlation.bannerVersion, templateId: command.snapshot.text.templateId }) &&
    report.correlation.commandId === expected.correlation.commandId &&
    report.inputKey === expected.inputKey && report.inputKey === mappedOverlayInput(mapping, command.snapshot.text.templateId)?.key &&
    same(report.text, expected.text);
}
function commandAllowed(command, session, mapping, control, now) {
  // Legacy updates remain history; never deliver or start their weaker intent.
  if (command.action === "update_text" && !command.expectedLive) return false;
  return contextualTargetMatches(command, mapping, control.report) &&
    (!managedClear(command.action, command.target) || command.sequence === control.lastSequence) &&
    (managedClear(command.action, command.target) || ["on_air", "clear"].includes(observed(control, now).state)) && session.state === "active" && mapping.state === "commissioned" &&
    command.sessionId === session.id && command.deviceId === session.deviceId &&
    command.sessionGeneration === session.generation && command.mappingVersion === session.mappingVersion &&
    command.clearGeneration === control.clearGeneration && now >= command.createdAtMs && now < command.expiresAtMs;
}
function executionRefs(commandRef) {
  return ["delivered", "started", "succeeded", "failed", "outcome_unknown", "expired", "superseded"].map(status => commandRef.collection("receipts").doc(status));
}
async function execution(transaction, commandRef) {
  const docs = await transaction.getAll(...executionRefs(commandRef));
  return Object.fromEntries(docs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
}
async function pull({ transaction, ref, session, mapping, control, request, now }) {
  if (!validId(request.timingId) || !nonnegative(request.afterSequence)) fail("Pull needs timingId and afterSequence.");
  const docs = (await transaction.get(ref.collection("commands").orderBy("sequence").startAfter(request.afterSequence).limit(20))).docs;
  const commands = docs.map(doc => parsePersistedLiveCommand(doc.data()));
  const states = await Promise.all(docs.map(doc => execution(transaction, doc.ref)));
  const eligible = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    const state = states[index];
    const startedOrFinished = state.started || state.succeeded || state.failed || state.outcome_unknown;
    const allowed = commandAllowed(command, session, mapping, control, now);
    if (allowed && !startedOrFinished && !state.expired && !state.superseded) {
      eligible.push(command);
      if (!state.delivered) transaction.create(docs[index].ref.collection("receipts").doc("delivered"), {
        commandId: command.id, status: "delivered", receivedAtMs: now,
      });
    } else if (!startedOrFinished) {
      const status = now >= command.expiresAtMs ? "expired" : "superseded";
      if (!state[status]) transaction.create(docs[index].ref.collection("receipts").doc(status), {
        commandId: command.id, status, receivedAtMs: now,
      });
    }
  }
  return { commands: eligible, scannedThroughSequence: commands.at(-1)?.sequence ?? request.afterSequence,
    fences: fences(session, control), mapping };
}
async function storeReceipt({ transaction, ref, session, mapping, control, request, device, now }) {
  const statuses = ["started", "succeeded", "failed", "outcome_unknown"];
  if (!validId(request.commandId) || !validId(request.receiptId) || !statuses.includes(request.status)) fail("Invalid command receipt.");
  const commandRef = ref.collection("commands").doc(request.commandId);
  const data = (await transaction.get(commandRef)).data();
  if (!data) fail("Command not found.", 404);
  const command = parsePersistedLiveCommand(data);
  if (command.deviceId !== device.deviceId) fail("Wrong command device.", 403);
  const states = await execution(transaction, commandRef);
  const digest = fingerprint(request);
  const identityRef = ref.collection("audit").doc(`receipt_identity_${hash(request.receiptId)}`);
  const identity = (await transaction.get(identityRef)).data();
  if (identity) {
    if (identity.fingerprint !== digest || identity.commandId !== command.id) fail("Receipt ID is already bound to different evidence.", 409);
    return { receipt: identity.receipt, replayed: true };
  }
  if (Object.values(states).some(receipt => receipt.receiptId === request.receiptId && receipt.fingerprint !== digest)) fail("Receipt ID is already bound to different evidence.", 409);
  const prior = states[request.status];
  if (prior) {
    if (prior.fingerprint !== digest) fail("Receipt status is already recorded with another identity.", 409);
    transaction.create(identityRef, { actorId: device.uid, action: "receipt_identity", commandId: command.id, fingerprint: digest, receipt: prior, atMs: now });
    return { receipt: prior, replayed: true };
  }
  if (states.succeeded || states.failed || states.outcome_unknown) fail("The command already has a terminal outcome.", 409);
  if (request.status === "started" && (states.expired || states.superseded || !commandAllowed(command, session, mapping, control, now))) fail("Command expired or superseded.", 409);
  if (request.status === "succeeded" && !states.started) fail("Success needs a durable start receipt.", 409);
  const receipt = { commandId: command.id, receiptId: request.receiptId, deviceId: device.deviceId,
    status: request.status, receivedAtMs: now, fingerprint: digest };
  transaction.create(commandRef.collection("receipts").doc(request.status), receipt);
  transaction.create(identityRef, { actorId: device.uid, action: "receipt_identity", commandId: command.id, fingerprint: digest, receipt, atMs: now });
  audit(transaction, ref, `receipt_${hash(`${command.id}:${request.status}`)}`, device.uid, "receipt", now, { commandId: command.id, status: request.status });
  return { receipt, replayed: false };
}
async function verifyMapping({ transaction, ref, session, mapping, request, now, expectedTitleFiles }) {
  let configuredTitles;
  try { configuredTitles = parseStudioTitleFiles(expectedTitleFiles); }
  catch { fail("Studio title-file configuration is unavailable.", 503); }
  checkVersion(mapping.version, request.mappingVersion);
  if (session.state !== "draft") fail("Mapping verification is setup-only.", 409);
  const expectedFields = Object.fromEntries(Object.entries(LIVE_TEMPLATES).map(([id, template]) => [id, Object.values(template.fields)]));
  const inputTypes = { headline: "GT", name_title: "GT" };
  if (!same(request.inputs, mapping.inputs) || !same(request.fields, expectedFields) || !request.inputTypes || !same(request.inputTypes, inputTypes)) fail("Native GT inputs or text fields do not match setup.", 409);
  if (!same(request.overlayInputs ?? null, mapping.overlayInputs ?? null)) fail("Native overlay inputs do not match setup.", 409);
  const setup = (await transaction.get(ref.collection("audit").doc(`mapping_setup_${mapping.version}`))).data();
  const prior = (await transaction.get(ref.collection("audit").doc(`mapping_verified_${mapping.version}`))).data();
  if (setup?.titleFilesConfirmed !== true) fail("An operator must confirm the studio title files.", 409);
  const titleFiles = request.titleFiles ?? { headline: null, name_title: null };
  fields(titleFiles, ["headline", "name_title"]);
  const evidence = {};
  for (const templateId of ["headline", "name_title"]) {
    const path = titleFiles[templateId];
    if (path !== null && (typeof path !== "string" || Array.from(path).some(char => char.codePointAt(0) < 32) || /[?<>|]/.test(path) || /^[A-Za-z]{2,}:/.test(path) ||
        win32.basename(path).toLowerCase() !== configuredTitles[templateId].toLowerCase())) fail("Native GT title file does not match the confirmed template.", 409);
    evidence[templateId] = path ?? "operator-confirmed";
  }
  if (prior) {
    if (!same(prior.commissioning.titleFiles, evidence)) fail("Native title-file evidence changed. Create a new mapping version.", 409);
    return { mapping, commissioning: prior.commissioning };
  }
  const verified = parseTemplateMapping({ ...mapping, state: "commissioned", verifiedAtMs: now });
  const commissioning = { mappingVersion: mapping.version, inputTypes, titleFiles: evidence,
    operatorId: setup.actorId, operatorConfirmedAtMs: setup.atMs, verifiedByDeviceId: session.deviceId, verifiedAtMs: now };
  transaction.set(ref.collection("mappings").doc(String(mapping.version)), verified);
  audit(transaction, ref, `mapping_verified_${mapping.version}`, session.deviceId, "verify_mapping", now, { commissioning });
  return { mapping: verified, commissioning };
}
function nativeState(report) {
  return report && { vmix: report.vmix, state: report.state, inputKey: report.inputKey, text: report.text };
}
async function latestPendingManagedClear(transaction, ref, session, mapping, control, now) {
  if (!control.lastSequence) return false;
  const docs = (await transaction.get(ref.collection("commands").where("sequence", "==", control.lastSequence).limit(1))).docs;
  const command = docs[0]?.data();
  if (!command || !managedClear(command.action, command.target) || !commandAllowed(command, session, mapping, control, now)) return false;
  const states = await execution(transaction, docs[0].ref);
  return !states.succeeded && !states.failed && !states.outcome_unknown && !states.expired && !states.superseded;
}
async function storeObservation({ transaction, ref, session, mapping, control, request, now }) {
  const report = parseAgentObservation(request.observation);
  if (report.sessionId !== session.id || report.deviceId !== session.deviceId || report.sessionGeneration !== session.generation || report.mappingVersion !== session.mappingVersion) fail("Stale observation binding.", 409);
  if (report.sequence <= (control.report?.sequence ?? 0)) fail("Duplicate or out-of-order native sample.", 409);
  let bannerRef, banner, confirmedLive;
  if (report.source === "boardwalk") {
    const commandRef = ref.collection("commands").doc(report.correlation.commandId);
    const data = (await transaction.get(commandRef)).data();
    if (!data) fail("Observation command not found.", 409);
    const command = parsePersistedLiveCommand(data);
    const states = await execution(transaction, commandRef);
    if (!states.started || command.sessionId !== session.id || command.sessionGeneration !== session.generation || command.mappingVersion !== session.mappingVersion || command.deviceId !== session.deviceId || report.sequence <= command.expectedObservationSequence) fail("Observation lacks causal execution evidence.", 409);
    if (report.state === "clear") {
      if (command.action !== "clear") fail("Clear observation must name a Clear command.", 409);
    } else {
      if (command.action === "clear" || report.correlation.bannerId !== command.snapshot.bannerId ||
        report.correlation.bannerVersion !== command.snapshot.version || !same(report.text, command.snapshot.text) ||
        report.inputKey !== mappedOverlayInput(mapping, command.snapshot.text.templateId)?.key) fail("Observation does not match the immutable command snapshot.", 409);
      bannerRef = ref.collection("banners").doc(command.snapshot.bannerId);
      banner = (await transaction.get(bannerRef)).data();
      if (!banner) fail("Observed banner not found.", 409);
      confirmedLive = { commandId: command.id, observationSequence: report.sequence, observedAtMs: report.observedAtMs, snapshot: command.snapshot };
    }
  }
  // A new native poll refreshes evidence; only a native change invalidates intent.
  const manualIntervention = control.report !== null && report.source !== "boardwalk" && (control.report?.source === "boardwalk" ||
    !same(nativeState(report), nativeState(control.report)));
  // A latest pending safety Clear already fenced every older Take. Preserve it
  // through reconciliation; a newer Take or a terminal Clear ends this exception.
  const preserveClear = manualIntervention && await latestPendingManagedClear(transaction, ref, session, mapping, control, now);
  const next = { ...control, report, receivedAtMs: now,
    clearGeneration: control.clearGeneration + (manualIntervention && !preserveClear ? 1 : 0) };
  transaction.create(ref.collection("observations").doc(`sample_${session.generation}_${report.sequence}`), { report, receivedAtMs: now });
  transaction.set(controlRef(ref), next);
  if (banner) writeBanner(transaction, bannerRef, { ...banner, record: parseBannerRecord({ ...banner.record, confirmedLive }) });
  return { observed: observed(next, now), serverNowMs: now };
}
async function agentRequest(db, request, device, clock = Date.now, expectedTitleFiles) {
  const ref = sessionRef(db, request.sessionId);
  const result = await db.runTransaction(async transaction => {
    await assertDevice(transaction, db, device);
    const session = await getSession(transaction, ref);
    const mapping = await getMapping(transaction, ref, session);
    bound(session, mapping, device);
    const control = (await transaction.get(controlRef(ref))).data() ?? initialControl();
    const now = clock();
    const context = { transaction, ref, session, mapping, control, request, device, now, expectedTitleFiles };
    switch (request.action) {
    case "pull": return pull(context);
    case "heartbeat":
      if (!validId(request.timingId)) fail("Heartbeat needs a timingId.");
      return { fences: fences(session, control), mapping, observed: observed(control, now), serverNowMs: now };
    case "fence": {
      if (!validId(request.commandId)) fail("Fence needs a commandId.");
      const command = (await transaction.get(ref.collection("commands").doc(request.commandId))).data();
      const states = command ? await execution(transaction, ref.collection("commands").doc(request.commandId)) : {};
      return { allowed: Boolean(command && commandAllowed(command, session, mapping, control, now) && !states.succeeded && !states.failed && !states.outcome_unknown && !states.expired && !states.superseded), fences: fences(session, control) };
    }
    case "receipt": return storeReceipt(context);
    case "observe": return storeObservation(context);
    case "verify_mapping": return verifyMapping(context);
    default: fail("Unknown device action.");
    }
  });
  if (request.action !== "pull") return result;
  // Compute lifetime at response creation, after the transaction has completed.
  const now = clock();
  const { commands, ...rest } = result;
  return { ...rest, serverNowMs: now, deliveries: commands.filter(command => command.expiresAtMs > now)
    .map(command => issueLiveCommandDelivery(command, request.timingId, now)) };
}
module.exports = { admitCommand, agentRequest, assertDevice, commandAllowed };
