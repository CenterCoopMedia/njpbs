"use strict";
const { can } = require("./rbac");
const { contentResource, authorizeContentRead } = require("./content-authorization");
const { registeredPrincipalFromUserDoc } = require("./principal");
const { sessionPredatesWatermark } = require("./auth");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./audit");
const { ElectionSourceError, ELECTION_SOURCE_MODES, ELECTION_SHEET_COLUMNS, parseElectionApMapping,
  electionStatusKey, parseElectionApRehearsal } = require("./election-result-sources");
const { connectionId, publicBlock, digest } = require("./election-source-refresh");
const { publiclyVisible } = require("./public-video-references");
const { assertRehearsalTarget } = require("./election-source-rehearsal");
const COLLECTION = "cmsElectionResultConnections";
const MUTATION_ACTIONS = Object.freeze(["connect", "approve", "status", "pause", "resume"]);
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hasControl = value => /\p{Cc}/u.test(value);
function fail(message, status = 400) { throw Object.assign(new ElectionSourceError("connection", message), { status }); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function fields(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail("Unknown or missing connection fields.");
}
function parseConfig(config, roster, now) {
  fields(config, ["source", "raceIds", "mode", "maxAgeSeconds"], ["photos", "rehearsal", "apRehearsal"]);
  if (config.rehearsal !== undefined && config.rehearsal !== true) fail("Omit rehearsal for live sources.");
  if (config.rehearsal === true && !["repo", "sheet"].includes(config.source?.kind)) fail("Rehearsal supports only Sheet and repo sources.");
  if (config.apRehearsal !== undefined) {
    if (config.rehearsal || config.source?.kind !== "ap") fail("AP test and historical rehearsals use separate source modes.");
    parseElectionApRehearsal(config.apRehearsal, now, roster.electionDate);
  }
  if (!ELECTION_SOURCE_MODES.includes(config.mode) || !Array.isArray(config.raceIds) || !config.raceIds.length || config.raceIds.length > 20 ||
      new Set(config.raceIds).size !== config.raceIds.length || config.raceIds.some(id => !roster.races.some(race => race.id === id)) ||
      !Number.isSafeInteger(config.maxAgeSeconds) || config.maxAgeSeconds < 60 || config.maxAgeSeconds > 86400) fail("Choose known races, a publish mode and a source age between 60 seconds and 24 hours.");
  const source = config.source;
  if (source?.kind === "repo") fields(source, ["kind"]);
  else if (source?.kind === "sheet") {
    fields(source, ["kind", "spreadsheetId", "tab", "columns"]);
    if (typeof source.spreadsheetId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(source.spreadsheetId) ||
        typeof source.tab !== "string" || !source.tab.trim() || source.tab.length > 100 || hasControl(source.tab) || [...source.tab].some(char => "[]!*?:/\\".includes(char)) || !object(source.columns) ||
        Object.keys(source.columns).some(key => !ELECTION_SHEET_COLUMNS.includes(key)) ||
        Object.values(source.columns).some(value => typeof value !== "string" || !value.trim() || value.length > 120 || hasControl(value))) fail("Use a Sheet ID, tab name and explicit column headers.");
    const names = ELECTION_SHEET_COLUMNS.map(key => source.columns[key] ?? key);
    if (new Set(names).size !== names.length) fail("Each Sheet column must map to a different header.");
  } else if (source?.kind === "ap") {
    fields(source, ["kind", "mapping"]);
    parseElectionApMapping(source.mapping, { roster, raceIds: config.raceIds, now });
  } else fail("Choose Sheet, nj-decides or AP.");
  if (config.photos !== undefined) {
    if (!object(config.photos) || Object.keys(config.photos).length > 480) fail("Choose photos by roster candidate identity.");
    for (const [id, photo] of Object.entries(config.photos)) {
      if (!roster.candidates.some(candidate => candidate.id === id && config.raceIds.includes(candidate.raceId))) fail("A photo refers to an unselected roster candidate.");
      fields(photo, ["assetId", "alt"], ["caption"]);
      if (!validId(photo.assetId) || typeof photo.alt !== "string" || !photo.alt.trim() || photo.alt.length > 300 ||
          hasControl(photo.alt) || photo.caption !== undefined && (typeof photo.caption !== "string" || photo.caption.length > 300 || hasControl(photo.caption))) fail("Each Media photo needs a description and valid credit.");
    }
  }
  return structuredClone(config);
}
function parseRequest(body) {
  const common = ["action", "collection", "documentId", "blockId"];
  const actions = { get: [], connect: ["baseVersion", "contentVersion", "config"],
    approve: ["baseVersion"], status: ["baseVersion", "pendingDigest"], pause: ["baseVersion"], resume: ["baseVersion"] };
  if (!object(body) || !Object.hasOwn(actions, body.action)) fail("Choose a connection action.");
  fields(body, [...common, ...actions[body.action]], body.action === "get" ? ["includeRoster"] : []);
  if (!["cmsPages", "cmsPosts"].includes(body.collection) || !validId(body.documentId) || !validId(body.blockId)) fail("Choose a Page/Post results section.");
  if (body.action !== "get" && (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0)) fail("Reload the connection before changing it.");
  if (body.action === "connect" && (!Number.isSafeInteger(body.contentVersion) || body.contentVersion < 1)) fail("Save and publish the section before connecting it.");
  if (body.action === "status" && !/^[a-f0-9]{64}$/.test(body.pendingDigest)) fail("Review the current pending status changes.");
  if (body.includeRoster !== undefined && typeof body.includeRoster !== "boolean") fail("Choose whether to load the roster.");
  return body;
}
async function contentPrincipal({ firestore, transaction, actor, collection, documentId, document, publishing = true }) {
  const profile = (await transaction.get(firestore.doc(`users/${actor.uid}`))).data();
  if (!profile || profile.active === false || actor.emailVerified !== true || sessionPredatesWatermark(actor.authTime, profile)) fail("An active verified staff publisher is required.", 403);
  const principal = await registeredPrincipalFromUserDoc(firestore, actor.uid, profile, transaction);
  const resource = contentResource({ collection, documentId, stored: document });
  if (publishing ? !can(principal, "content.publish", resource) : !authorizeContentRead(principal, { exists: true, resource }).allowed) fail("You do not have access to this Page/Post connection.", 403);
  return principal;
}
function view(record) {
  if (!record) return null;
  const keys = ["schemaVersion", "collection", "documentId", "blockId", "config", "version", "configRevision", "paused",
    "authorizedConfigRevision", "lastCheckAt", "lastSourceSuccessAt", "lastGoodAt", "lastGoodDigest", "lastHoldReason", "lastSchedulingReason",
    "pendingDigest", "pendingStatuses", "pendingData", "lastGoodData", "publicationRevision", "operationId"];
  return Object.fromEntries(keys.map(key => [key, record[key] ?? null]));
}
const authorizationActor = actor => ({ uid: actor.uid, emailVerified: actor.emailVerified === true, authTime: actor.authTime ?? null });
async function mutateConnection({ firestore, actor, request, roster, now }) {
  if (!MUTATION_ACTIONS.includes(request.action)) fail("Choose a connection action.");
  const ref = firestore.doc(`${COLLECTION}/${connectionId(request.collection, request.documentId, request.blockId)}`);
  return firestore.runTransaction(async transaction => {
    const document = (await transaction.get(firestore.doc(`${request.collection}/${request.documentId}`))).data();
    if (!document || document.deleted) fail("This Page/Post is unavailable.", 404);
    await contentPrincipal({ firestore, transaction, actor, collection: request.collection, documentId: request.documentId, document });
    const before = (await transaction.get(ref)).data();
    if ((before?.version ?? 0) !== request.baseVersion) fail("This connection changed. Reload it before continuing.", 409);
    if (request.action !== "pause" && (!publiclyVisible(document) || !publicBlock(document, request.blockId))) fail("Publish this results section before connecting or changing its source.", 409);
    let after;
    if (request.action === "connect") {
      if (document.version !== request.contentVersion) fail("This Page/Post changed. Reload it before connecting.", 409);
      const config = parseConfig(request.config, roster, now);
      if (before?.config.apRehearsal && !config.apRehearsal) fail("An AP rehearsal connection cannot become a live source. Pause and retire this test Page instead.");
      await assertRehearsalTarget({ firestore, transaction, connection: { ...request, config }, document });
      if (!before || before.paused) {
        const enabled = await transaction.get(firestore.collection(COLLECTION).where("paused", "==", false).limit(21));
        if (enabled.size >= 20) fail("Pause an existing connection before enabling more than 20.", 409);
      }
      const revision = (before?.configRevision ?? 0) + 1;
      after = { schemaVersion: 1, collection: request.collection, documentId: request.documentId, blockId: request.blockId,
        draftDigest: digest((document.blocks ?? []).find(block => block.id === request.blockId)?.data ?? null),
        config, configRevision: revision, version: (before?.version ?? 0) + 1, paused: false,
        authorizedConfigRevision: config.mode === "approve-once" ? null : revision,
        authorizedBy: authorizationActor(actor), statusAuthorizations: {}, boundDigest: digest(publicBlock(document, request.blockId).data),
        lastGoodData: null, lastGoodDigest: null,
        lastGoodAt: null, publicationRevision: before?.publicationRevision ?? 0,
        lastCheckAt: null, lastSourceSuccessAt: null, lastHoldReason: null, lastSchedulingReason: null,
        pendingStatuses: [], pendingDigest: null, pendingData: null, apCursor: null, sourceCache: null, apStaging: null, apVirtualAsOf: null,
        sourceEtag: null, sourceGeneratedAt: null, lastApFullCheckAt: null,
        lease: null, nextPollAt: 0, updatedAt: now, updatedBy: actor.uid };
    } else {
      if (!before) fail("Connect a source first.", 409);
      if (request.action !== "pause") {
        await assertRehearsalTarget({ firestore, transaction, connection: before, document });
        if (before.config.apRehearsal) parseElectionApRehearsal(before.config.apRehearsal, now, "2026-11-03");
      }
      after = { ...before, version: before.version + 1, lease: null, updatedAt: now, updatedBy: actor.uid };
      if (request.action === "pause") { after.paused = true; after.nextPollAt = null; }
      if (request.action === "resume") {
        if (digest((document.blocks ?? []).find(block => block.id === request.blockId)?.data ?? null) !== before.draftDigest) fail("The manual results draft changed while paused. Review and publish it or discard it before reconnecting the source.", 409);
        if (digest(publicBlock(document, request.blockId).data) !== before.boundDigest) fail("Results changed while paused. Review the current results and reconnect the source before resuming.", 409);
        if (before.paused) {
          const enabled = await transaction.get(firestore.collection(COLLECTION).where("paused", "==", false).limit(21));
          if (enabled.size >= 20) fail("Pause an existing connection before enabling more than 20.", 409);
        }
        after.paused = false; after.nextPollAt = 0; after.authorizedBy = authorizationActor(actor);
      }
      if (["approve", "status"].includes(request.action)) {
        if (before.paused || !before.pendingData || before.lastHoldReason) fail("Wait for a valid source check before approving.", 409);
        if (Date.parse(now) - Date.parse(before.lastSourceSuccessAt) > before.config.maxAgeSeconds * 1000) fail("Check fresh source values before approving.", 409);
        if (request.action === "approve") {
          if (before.config.mode !== "approve-once") fail("This connection does not use link approval.");
          after.authorizedConfigRevision = before.configRevision;
        } else {
          if (before.config.mode !== "counts-auto" || request.pendingDigest !== before.pendingDigest || !before.pendingStatuses.length) fail("The pending status changes changed. Review them again.", 409);
          after.statusAuthorizations = { ...before.statusAuthorizations,
            ...Object.fromEntries(before.pendingData.races.filter(race => before.pendingStatuses.includes(race.id)).map(race => [race.id, electionStatusKey(race)])) };
        }
        after.authorizedBy = authorizationActor(actor); after.nextPollAt = 0;
      }
    }
    if (request.action === "connect") transaction.create(ref.collection("configurations").doc(String(after.configRevision)), {
      schemaVersion: 1, configRevision: after.configRevision, config: after.config, rosterDigest: digest(roster),
      authorizedBy: actor.uid, configuredAt: now,
    });
    transaction.set(ref, after);
    transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: actor.uid,
      action: `election_source.${request.action}`, target: ref.path,
      before: before ? { version: before.version, configRevision: before.configRevision, paused: before.paused } : null,
      after: { version: after.version, configRevision: after.configRevision, paused: after.paused, mode: after.config.mode } }));
    return { connection: view(after), canManage: true };
  });
}
module.exports = { COLLECTION, MUTATION_ACTIONS, validId, parseConfig, parseRequest, contentPrincipal, mutateConnection, view };
