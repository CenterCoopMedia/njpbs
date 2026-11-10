"use strict";
const protocol = require("./public-release-pair");
const log = require("./public-release-change-log");
const baselines = require("./public-release-change-baseline");
const evidence = require("./public-release-change-evidence");
const bodies = require("./public-release-source-body");
const { publicReleasePairPath } = require("./public-release-pair-work");
const ROOT = log.PUBLIC_RELEASE_CHANGES_PATH;
const sourceLimits = require("./public-release-source-limits");
function refuse() { throw new protocol.PublicReleaseProtocolError(); }
/** Immutable baseline plus every contiguous member, including tombstones. The
 * only mutable reads select an epoch/upper bound; they never supply source data.
 * This object is a private reader input, never a write plan for the live CMS. */
async function reconstructPublicReleaseState({ firestore, sourceOperationId, logBaselineDigest }) {
  return firestore.runTransaction(async actualTransaction => {
    const budget = sourceLimits.historicalSourceReadBudget();
    const transaction = { get: ref => budget.read(() => actualTransaction.get(ref)),
      getAll: (...refs) => budget.read(() => actualTransaction.getAll(...refs)) };
    const [controlRow, headRow] = await transaction.getAll(firestore.doc("system/publicReleaseChangeLog"), firestore.doc(ROOT));
    let control = controlRow.data();
    const head = log.parsePublicReleaseChangeHead(headRow.data());
    if (!controlRow.exists) {
      // Before OLD controls exist, only the original closed first-install
      // enrollment can select its immutable epoch. Never seed a producer row.
      const enrolled = await require("./public-release-change-enrollment").assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction });
      const before = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
      if (before?.schemaVersion === 2 || !require("node:util").isDeepStrictEqual(head, enrolled.receipt.initialHead)) refuse();
      const environment = enrolled.receipt.request.expected.projectId === "njpbs-site-dev" ? "development" : "production";
      require("./publication-target").assertPublicationDatabase(firestore, require("./publication-target").publicationTarget(environment));
      await require("./public-release-bootstrap-adoption").assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment,
        before, operationId: enrolled.receipt.request.operationId });
      control = { logEpoch: enrolled.receipt.request.logEpoch };
    }
    if (typeof control?.logEpoch !== "string") refuse();
    const receipt = baselines.parsePublicReleaseChangeBaseline((await transaction.get(firestore.doc(`${ROOT}/baselines/${control.logEpoch}`))).data());
    const actualBaselineDigest = protocol.publicReleaseDigest(receipt);
    if (logBaselineDigest && logBaselineDigest !== actualBaselineDigest || receipt.logEpoch !== control.logEpoch || receipt.baselineCursor.baselineDigest !== head.baselineDigest) refuse();
    let upper = receipt.baselineCursor.sequence;
    if (sourceOperationId !== undefined) {
      const operation = (await transaction.get(firestore.doc(`${ROOT}/operations/${sourceOperationId}`))).data();
      if (!operation || !Number.isSafeInteger(operation.sequence) || operation.sequence <= upper || operation.sequence > head.sequence) refuse();
      upper = operation.sequence;
    }
    const changes = upper - receipt.baselineCursor.sequence;
    sourceLimits.checkHistoricalSourceLimit("changes", changes);
    const baseline = await baselines.assertReadPublicReleaseChangeBaselineInTransaction({ firestore, transaction, logBaselineDigest: actualBaselineDigest });
    const documents = new Map(), sourceBodies = new Map(), sourceMembers = new Map();
    const apply = (contentDigest, body) => {
      budget.check();
      sourceBodies.set(contentDigest, body);
      for (const { path, data } of body.documents) {
        if (data === null) { documents.delete(path); sourceMembers.delete(path); }
        else { documents.set(path, data); sourceMembers.set(path, contentDigest); }
      }
    };
    for (const member of baseline.sourceMembers) {
      const body = await bodies.readPublicReleaseSourceBody({ firestore, transaction, contentDigest: member.contentDigest });
      if (!body.documents.some(document => document.path === `${member.collection}/${member.id}` && document.data !== null)) refuse();
      apply(member.contentDigest, body);
    }
    let cursor = receipt.baselineCursor, final = null;
    const accepted = [];
    for (let start = cursor.sequence + 1; start <= upper; start += 100) {
      budget.check();
      const refs = Array.from({ length: Math.min(100, upper - start + 1) }, (_, index) => firestore.doc(`${ROOT}/entries/${String(start + index).padStart(16, "0")}`));
      const rows = await transaction.getAll(...refs);
      const entries = rows.map(row => log.parsePublicReleaseChange(row.data()));
      const next = log.verifyPublicReleaseChangePage(cursor, entries);
      for (const entry of entries) {
        const event = await evidence.assertReadPublicReleaseChangeEvidenceInTransaction({ firestore, transaction, entry });
        for (const member of event.members) apply(member.contentDigest, member.body);
        const context = { ...(documents.get("system/publicDeployment/contexts/public") ?? {}) };
        const provider = event.members.find(member => member.change.kind === "provider" && member.change.id !== "public-code");
        const schedule = event.members.find(member => member.change.kind === "schedule");
        if (provider) context.externalInputs = provider.snapshot;
        if (schedule && !provider) context.externalInputs = { ...context.externalInputs, schedulePacket: schedule.snapshot };
        documents.set("system/publicDeployment/contexts/public", { ...context, schemaVersion: 1, revision: entry.contextRevision,
          changedAt: new Date(event.createdAt).toISOString() });
        accepted.push(event); final = event;
      }
      cursor = { baselineDigest: cursor.baselineDigest, ...next };
    }
    if (sourceOperationId !== undefined && final?.entry.operationId !== sourceOperationId) refuse();
    if (final) {
      const data = documents.get("system/publicDeployment/contexts/public");
      const value = bodies.makePublicReleaseSourceBody({ kind: "provider", id: "historical-context", action: "dependency",
        sourceVersion: data.revision, snapshot: data, sourceDocuments: [{ path: "system/publicDeployment/contexts/public", data }] });
      sourceBodies.set(value.contentDigest, JSON.parse(value.json));
      sourceMembers.set("system/publicDeployment/contexts/public", value.contentDigest);
    }
    let originalPair;
    if (final) {
      const sourcePair = documents.get("system/publicReleaseHistoricalCode")?.pair ?? final.entry.pair;
      originalPair = protocol.parsePublicReleasePair((await transaction.get(firestore.doc(publicReleasePairPath(sourcePair.pairId)))).data());
      if (protocol.publicReleaseDigest(protocol.publicReleasePairReference(originalPair)) !== protocol.publicReleaseDigest(sourcePair) ||
          documents.get("system/publicDeployment")?.activeCommitSha !== originalPair.commitSha) refuse();
    } else {
      const registry = (await transaction.get(firestore.doc("system/publicReleasePairs"))).data();
      if (!Array.isArray(registry?.pairIds) || registry.pairIds.length > 8) refuse();
      const registered = await transaction.getAll(...registry.pairIds.map(id => firestore.doc(publicReleasePairPath(id))));
      const matches = registered.map(row => protocol.parsePublicReleasePair(row.data())).filter(pair => pair.commitSha === receipt.liveReleaseSha);
      if (matches.length !== 1) refuse(); originalPair = matches[0];
    }
    const renderedAt = final ? new Date(final.createdAt).toISOString() : receipt.createdAt;
    budget.check();
    return { receipt, logBaselineDigest: actualBaselineDigest, baselineMembers: baseline.sourceMembers, cursor, documents,
      sourceBodies, sourceMembers, accepted, event: final, originalPair, renderedAt,
      headroom: sourceLimits.historicalSourceHeadroom({ changes, ...budget.usage() }) };
  }, { readOnly: true });
}
module.exports = { reconstructPublicReleaseState };
