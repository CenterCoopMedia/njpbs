"use strict";
const { randomUUID } = require("node:crypto");
const { COLLECTION, contentPrincipal } = require("./election-source-connections");
const { digest, publicBlock, assertElectionSourceRefresh } = require("./election-source-refresh");
const { publiclyVisible } = require("./public-video-references");
const { normalizeRepoResults, normalizeSheetGridResults, normalizeApResults, selectElectionSourceMode,
  electionStatusKey, electionApCache, ElectionSourceError, parseElectionApRehearsal } = require("./election-result-sources");
const { readRoster, readSource, fetchFailure } = require("./election-source-http");
const { prepareNoBuildContentPublication } = require("./no-build-content-publication");
const { prepareMediaUsageWrite, collectPublishedMediaUsage } = require("./media-usage");
const { prepareDatasetUsageWrites } = require("./dataset-usage");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./audit");
const { logUnexpected } = require("./election-source-log");
const { prepareElectionLineage } = require("./election-source-lineage");
const { rehearsalRoster, assertRehearsalTarget, assertRehearsalLabels } = require("./election-source-rehearsal");
const CONTROL = "system/electionResultSources";
// Leave scheduler jitter/fetch margin; the scheduler owns the cadence.
const nextTick = captured => captured.lease.expiresAt - 90000 + 45000;
const fail = (code, message) => { throw new ElectionSourceError(code, message); };

async function leaseConnection({ firestore, ref, now }) {
  return firestore.runTransaction(async transaction => {
    const value = (await transaction.get(ref)).data();
    const time = Date.parse(now);
    if (!value || value.paused || value.nextPollAt > time || value.lease?.expiresAt > time) return null;
    const lease = { token: randomUUID(), expiresAt: time + 90000 };
    transaction.update(ref, { lease });
    return { ...value, lease };
  });
}
async function reserveApRequest({ firestore, now, connectionRef }) {
  return firestore.runTransaction(async transaction => {
    const control = (await transaction.get(firestore.doc(CONTROL))).data();
    const budgetRef = firestore.doc("system/electionResultApBudget");
    const before = (await transaction.get(budgetRef)).data();
    const limit = control?.ap?.requestsPerMinute;
    if (control?.ap?.enabled !== true || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) fail("ap-disabled", "AP is not configured. Enable it only after provisioning the key and its query quota.");
    const time = Date.parse(now);
    const budget = before && time - before.startedAt < 60000 ? before : { startedAt: time, used: 0, lastRequestAt: 0 };
    if (budget.used >= limit || time - budget.lastRequestAt < 5000) fail("ap-quota", "AP polling is deferred to remain within the configured key quota.");
    transaction.set(budgetRef, { startedAt: budget.startedAt, used: budget.used + 1, lastRequestAt: time });
    if (connectionRef) transaction.update(connectionRef, { lastApRequestAt: time });
  });
}
function sameLease(current, captured) {
  return current && !current.paused && current.version === captured.version && current.configRevision === captured.configRevision &&
    current.lease?.token === captured.lease.token;
}
async function hold({ firestore, ref, captured, now, error, pause = false }) {
  return firestore.runTransaction(async transaction => {
    const current = (await transaction.get(ref)).data();
    if (!sameLease(current, captured)) return;
    if (error instanceof ElectionSourceError && error.code === "ap-quota") {
      const stale = current.lastSourceSuccessAt && Date.parse(now) - Date.parse(current.lastSourceSuccessAt) > current.config.maxAgeSeconds * 1000;
      transaction.update(ref, { lease: null, nextPollAt: nextTick(captured), lastSchedulingReason: {
        code: "ap-quota", message: error.message, at: now }, ...(stale ? { lastHoldReason: {
        code: "stale", message: "AP has not completed a successful check within the allowed source age. The previous public values are retained.", at: now } } : {}) });
      if (stale && current.lastHoldReason?.code !== "stale") transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
        actorUid: "system:election-source", action: "election_source.hold", target: ref.path,
        after: { code: "stale", source: "ap", configRevision: current.configRevision } }));
      return;
    }
    const known = error instanceof ElectionSourceError;
    const failure = known ? fetchFailure(error) : null;
    const staleAp = current.config.source.kind === "ap" && current.lastSourceSuccessAt &&
      Date.parse(now) - Date.parse(current.lastSourceSuccessAt) > current.config.maxAgeSeconds * 1000 &&
      ["source-unavailable", "source-access"].includes(error.code);
    const reason = { code: staleAp ? "stale" : known ? error.code : "publication-unavailable",
      message: known ? error.message : "Publication is unavailable. The previous public values are retained.", at: now };
    if (staleAp) reason.message = "AP has not completed a successful check within the allowed source age. The previous public values are retained.";
    const retry = Number.isFinite(error.retryAfterSeconds) ? Math.min(86400, Math.max(60, error.retryAfterSeconds)) : 60;
    transaction.update(ref, { lastCheckAt: now, lastHoldReason: reason, lastSchedulingReason: null, lease: null,
      // Preserve the latest fetch failure after the next successful check replaces the hold.
      ...(failure ? { lastFetchFailure: { ...failure, at: now } } : {}),
      ...(typeof error.electionSourceValidAt === "string" && Number.isFinite(Date.parse(error.electionSourceValidAt))
        ? { lastSourceSuccessAt: error.electionSourceValidAt } : {}),
      paused: pause || current.paused, nextPollAt: pause ? null : Number.isFinite(error.retryAfterSeconds) ? Date.parse(now) + retry * 1000 : nextTick(captured) });
    if (current.lastHoldReason?.code !== reason.code || current.lastHoldReason?.message !== reason.message) {
      transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
        actorUid: "system:election-source", action: "election_source.hold", target: ref.path,
        after: { code: reason.code, source: current.config.source.kind, configRevision: current.configRevision,
          ...(failure ? { fetchFailure: { ...failure, at: now } } : {}) } }));
    }
  });
}
async function supportsExpectedVote({ firestore, transaction, collection, capability }) {
  if (capability?.servingEnabled !== true || capability.electionResultsVersion !== 2) return false;
  const admission = require("./public-release-admission");
  const adoption = (await transaction.get(firestore.doc(`${admission.ADMISSIONS}/controls/adoption`))).data();
  if (adoption?.enabled !== true) return true;
  const selector = require("./public-release-media-fence").parseStoredSelector(
    (await transaction.get(firestore.doc("system/publicDeployment"))).data());
  const contract = (await transaction.get(firestore.doc(`${admission.CONTRACTS}/${selector.admittedContractDigest}`))).data();
  return contract?.schemaVersion === 2 && Array.isArray(contract.features) && contract.features.includes("electionResultsVersion:2") &&
    Array.isArray(contract.families) && contract.families.includes(collection === "cmsPages" ? "pages" : "posts") &&
    require("./public-release-pair").publicReleaseDigest(contract) === selector.admittedContractDigest;
}
async function accept({ firestore, ref, captured, roster, source, now }) {
  return firestore.runTransaction(async transaction => {
    const current = (await transaction.get(ref)).data();
    if (!sameLease(current, captured)) return { discarded: true };
    const contentRef = firestore.doc(`${current.collection}/${current.documentId}`);
    const document = (await transaction.get(contentRef)).data();
    if (!publiclyVisible(document) || !publicBlock(document, current.blockId)) fail("binding", "The connected section is no longer public. The connection has been paused.");
    await contentPrincipal({ firestore, transaction, actor: current.authorizedBy, collection: current.collection,
      documentId: current.documentId, document });
    await assertRehearsalTarget({ firestore, transaction, connection: current, document });
    const block = publicBlock(document, current.blockId);
    if (digest(block.data) !== current.boundDigest) fail("binding", "The connected results changed outside this source. Reconnect after reviewing the section.");
    const prior = new Map();
    // Prefer the pending source tuple on timestamp ties in Counts automatic.
    for (const race of [...block.data.races, ...(current.lastGoodData?.races ?? []), ...(current.pendingData?.races ?? [])]) {
      if (!prior.has(race.id) || Date.parse(race.asOf) >= Date.parse(prior.get(race.id).asOf)) prior.set(race.id, race);
    }
    // Read the installed family capability in this acceptance transaction.
    // Old readers continue to receive the V1 precinct-reporting shape.
    const capabilityPath = current.collection === "cmsPages"
      ? require("./no-build-page-ownership").PAGE_CAPABILITY_PATH : require("./no-build-post-ownership").CAPABILITY_PATH;
    const capability = (await transaction.get(firestore.doc(capabilityPath))).data();
    const expectedVoteShareEnabled = await supportsExpectedVote({ firestore, transaction, collection: current.collection, capability });
    const kind = current.config.source.kind;
    const fullAp = kind === "ap" && (source.full || current.apStaging?.full === true);
    const context = { roster, raceIds: current.config.raceIds, now, maxAgeSeconds: current.config.maxAgeSeconds, expectedVoteShareEnabled,
      apFullReconciliation: fullAp,
      photos: current.config.photos, previous: { races: [...prior.values()] }, rehearsal: current.config.rehearsal === true, apRehearsal: current.config.apRehearsal };
    let apCache = fullAp ? undefined : current.sourceCache ?? undefined;
    if (kind === "ap" && current.apStaging) {
      const races = new Map([...(apCache?.data.races ?? []), ...current.apStaging.data.races].map(race => [race.id, race]));
      apCache = electionApCache({ races: [...races.values()] }, current.config.source.mapping);
    }
    if (kind === "ap" && source.data.isTruncated === true) {
      if (!Array.isArray(source.data.races) || !source.data.races.length) fail("ap", "AP returned an incomplete update without races.");
      const partialIds = source.data.races.map(race => current.config.source.mapping[String(race.raceID)]?.raceId);
      if (partialIds.some(id => !id)) fail("roster", "An AP race is not mapped to the roster.");
      const partialMapping = Object.fromEntries(Object.entries(current.config.source.mapping).filter(([, value]) => partialIds.includes(value.raceId)));
      const partial = normalizeApResults({ ...source.data, isTruncated: false }, partialMapping,
        { ...context, raceIds: partialIds });
      const races = new Map([...(current.apStaging?.data.races ?? []), ...partial.races].map(race => [race.id, race]));
      transaction.update(ref, { apStaging: { ...electionApCache({ races: [...races.values()] }, current.config.source.mapping), full: fullAp },
        apCursor: source.cursor, lastCheckAt: now, lastSourceSuccessAt: now, lease: null, nextPollAt: nextTick(captured),
        lastHoldReason: { code: "ap-incomplete", message: "AP is delivering a multi-part update. The previous public values stay up until it is complete.", at: now } });
      return { staged: true };
    }
    const incoming = kind === "sheet" ? normalizeSheetGridResults(source.data, current.config.source.columns, context)
      : kind === "repo" ? normalizeRepoResults(source.data, context)
        : normalizeApResults(source.data, current.config.source.mapping, context, apCache);
    const beforeData = current.lastGoodData ?? block.data;
    if (current.config.rehearsal === true || current.config.apRehearsal) assertRehearsalLabels(incoming);
    const selected = selectElectionSourceMode(incoming, beforeData, current.config.mode, current.statusAuthorizations);
    const pendingDigest = selected.pending.length ? digest(incoming.races.filter(race => selected.pending.includes(race.id))
      .map(race => [race.id, electionStatusKey(race)])) : null;
    const nextDigest = digest(selected.data);
    const next = { lastCheckAt: now, lastSourceSuccessAt: now, lastHoldReason: null, lastSchedulingReason: null, pendingData: incoming,
      pendingStatuses: selected.pending, pendingDigest, lease: null, nextPollAt: nextTick(captured),
      ...(kind === "repo" ? { sourceEtag: typeof source.etag === "string" && source.etag.length <= 256 ? source.etag : null,
        sourceGeneratedAt: source.data.generatedAt } : {}),
      ...(fullAp ? { lastApFullCheckAt: now } : {}),
      ...(kind === "ap" ? { sourceCache: electionApCache(incoming, current.config.source.mapping), apCursor: source.cursor, apStaging: null } : {}),
      ...(context.apRehearsal ? { apVirtualAsOf: Object.fromEntries(incoming.races.map(race => [race.id,
        new Date(Date.parse(race.asOf) - Date.parse(context.apRehearsal.replayTimeOrigin) + Date.parse(context.apRehearsal.sourceTimeOrigin)).toISOString()])) } : {}) };
    if (current.authorizedConfigRevision !== current.configRevision) {
      transaction.update(ref, next);
      return { pendingApproval: true };
    }
    if (digest(block.data) === nextDigest) {
      transaction.update(ref, { ...next, lastGoodData: selected.data, lastGoodDigest: nextDigest,
        lastGoodAt: current.lastGoodAt ?? now, boundDigest: nextDigest });
      return { unchanged: true };
    }
    const published = { ...document.published, blocks: document.published.blocks.map(item => item.id === current.blockId
      ? { ...item, data: selected.data } : item) };
    const queueRef = firestore.collection("cmsPublishQueue").doc();
    const nextDocument = { ...document, published, publishBuildPending: true, publishBuildQueueId: queueRef.id };
    assertElectionSourceRefresh(document, nextDocument, current);
    const lineage = await prepareElectionLineage({ firestore, transaction, collection: current.collection,
      documentId: current.documentId, before: document, after: nextDocument });
    let prepared, media, datasets;
    try {
      prepared = await prepareNoBuildContentPublication({ firestore, transaction, collection: current.collection,
      documentId: current.documentId, nextDocument, queueRef, actor: { uid: "system:election-source" },
      electionResultsRefresh: { blockId: current.blockId } });
    if (!prepared || ![current.collection === "cmsPages" ? "page-no-build-v1" : "post-no-build-v1", "release-pair-publication-v2"].includes(prepared.transport)) fail("publication", "The connected section needs the existing fast publication owner.");
      media = await prepareMediaUsageWrite({ firestore, transaction, collection: current.collection, documentId: current.documentId,
      state: "published", sourceVersion: published.sourceVersion,
      usage: collectPublishedMediaUsage({ collection: current.collection, snapshot: published }),
      ...(prepared.transport === "release-pair-publication-v2" ? { releaseSelector: prepared.releaseSelector } : {}) });
      datasets = await prepareDatasetUsageWrites({ firestore, transaction, collection: current.collection,
      documentId: current.documentId, snapshot: published, previousSnapshot: document.published,
        operationId: prepared.operation.operationId, visible: true, editorialLineage: lineage.lineage });
    } catch (error) {
      error.electionSourceValidAt = now;
      throw error;
    }
    const revision = current.publicationRevision + 1;
    prepared.write(); datasets(); lineage.write(); transaction.set(media.ref, media.document);
    transaction.update(contentRef, { published, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
    transaction.update(ref, { ...next, lastGoodData: selected.data, lastGoodDigest: nextDigest, lastGoodAt: now,
      boundDigest: nextDigest, publicationRevision: revision, operationId: prepared.operation.operationId });
    transaction.create(ref.collection("publications").doc(), { schemaVersion: 1, revision, source: kind, digest: nextDigest,
      sourceTimes: incoming.races.map(race => ({ raceId: race.id, asOf: race.asOf })), checkedAt: now,
      configRevision: current.configRevision, authorizedBy: current.authorizedBy.uid, operationId: prepared.operation.operationId });
    transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: "system:election-source",
      action: "election_source.publish", target: contentRef.path,
      after: { source: kind, digest: nextDigest, configRevision: current.configRevision,
        operationId: prepared.operation.operationId, authorizedBy: current.authorizedBy.uid } }));
    return { published: true, operationId: prepared.operation.operationId };
  });
}
async function pollConnection({ firestore, id, now = () => new Date().toISOString(), fetchImpl = fetch, sheetsApi, roster: suppliedRoster }) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid election connection identity");
  const ref = firestore.doc(`${COLLECTION}/${id}`);
  const at = now();
  const captured = await leaseConnection({ firestore, ref, now: at });
  if (!captured) return { skipped: true };
  let apReserved = false;
  try {
    await firestore.runTransaction(async transaction => {
      const current = (await transaction.get(ref)).data();
      if (!sameLease(current, captured)) fail("binding", "The connection changed before its source check.");
      const document = (await transaction.get(firestore.doc(`${current.collection}/${current.documentId}`))).data();
      if (!publiclyVisible(document) || !publicBlock(document, current.blockId)) fail("binding", "The connected section is no longer public.");
      await contentPrincipal({ firestore, transaction, actor: current.authorizedBy, collection: current.collection,
        documentId: current.documentId, document });
      await assertRehearsalTarget({ firestore, transaction, connection: current, document });
      if (current.config.apRehearsal) parseElectionApRehearsal(current.config.apRehearsal, at, "2026-11-03");
    });
    if (captured.config.source.kind === "ap") { await reserveApRequest({ firestore, now: at, connectionRef: ref }); apReserved = true; }
    const roster = captured.config.rehearsal === true ? rehearsalRoster() : suppliedRoster ?? await readRoster({ fetchImpl });
    const source = await readSource({ connection: captured, roster, now: at, fetchImpl, sheetsApi, projectId: firestore.projectId });
    return { ...await accept({ firestore, ref, captured, roster, source, now: now() }), ...(apReserved ? { apReserved: true } : {}) };
  } catch (error) {
    if (!(error instanceof ElectionSourceError)) logUnexpected(error, "poll");
    await hold({ firestore, ref, captured, now: now(), error, pause: error.code === "binding" || error.code === "rehearsal" && Boolean(captured.config.apRehearsal) || error.status === 403 });
    return { held: true, code: error instanceof ElectionSourceError ? error.code : "publication-unavailable", ...(apReserved ? { apReserved: true } : {}) };
  }
}
async function pollConnections({ firestore, now = () => new Date().toISOString(), fetchImpl = fetch, sheetsApi,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  const rows = await firestore.collection(COLLECTION).where("paused", "==", false).limit(21).get();
  // Connect/resume admission caps enabled connections; refuse a corrupted set.
  if (rows.size > 20) throw new Error("Election connection limit exceeded");
  if (rows.empty) return [];
  let roster;
  try { roster = await readRoster({ fetchImpl }); } catch { /* Each connection records its own safe hold. */ }
  const outcomes = [];
  const ordinary = rows.docs.filter(row => row.data().config.source.kind !== "ap");
  for (let offset = 0; offset < ordinary.length; offset += 4) {
    outcomes.push(...await Promise.allSettled(ordinary.slice(offset, offset + 4).map(row =>
      pollConnection({ firestore, id: row.id, now, fetchImpl, sheetsApi, roster }))));
  }
  // Pace AP separately, after other sources, and rotate the oldest actual
  // attempt first so a low key quota cannot starve one fixed connection.
  const ap = rows.docs.filter(row => row.data().config.source.kind === "ap")
    .sort((a, b) => (a.data().lastApRequestAt ?? 0) - (b.data().lastApRequestAt ?? 0));
  const control = ap.length ? (await firestore.doc(CONTROL).get()).data() : null;
  let previousAttemptAt = null;
  let reservedThisRun = 0;
  for (const row of ap) {
    const at = Date.parse(now());
    if (row.data().nextPollAt > at || row.data().lease?.expiresAt > at) continue;
    if (control?.ap?.enabled === true && reservedThisRun < control.ap.requestsPerMinute && previousAttemptAt !== null) {
      const delay = Math.max(0, 5000 - (Date.parse(now()) - previousAttemptAt));
      if (delay) await wait(delay);
    }
    const attemptedAt = Date.parse(now());
    const settled = await Promise.allSettled([pollConnection({ firestore, id: row.id, now, fetchImpl, sheetsApi, roster })]);
    if (settled[0].status === "fulfilled" && settled[0].value.apReserved) { previousAttemptAt = attemptedAt; reservedThisRun++; }
    outcomes.push(...settled);
  }
  for (const outcome of outcomes) if (outcome.status === "rejected") logUnexpected(outcome.reason, "poll-settlement");
  return outcomes;
}
module.exports = { CONTROL, leaseConnection, reserveApRequest, pollConnection, pollConnections };
