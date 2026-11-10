"use strict";

const { randomUUID } = require("node:crypto");
const { assertStaffAuthority } = require("./live-production-authority");
const { sessionRef, getSession, assertEditable, checkVersion, boundedWrite, writeBanner, audit } = require("./live-production-store");
const { fail, fingerprint, hash } = require("./live-production-requests");
const { parseBannerText, parseBannerRecord } = require("./live-production-contract");
const { sourceRef, snapshotRef } = require("./rundown-source-store");
const { proposalRef } = require("./rundown-parser-store");
const { contentKey, protectedFields, reconcileCandidates, acceptedText, proposalBaseline } = require("./rundown-reconcile");
const reviewRef = ref => ref.collection("rundownReview").doc("current");

async function currentSource(transaction, ref, now, generation) {
  const source = (await transaction.get(sourceRef(ref))).data();
  const snapshot = (await transaction.get(snapshotRef(ref))).data();
  const parsed = (await transaction.get(proposalRef(ref))).data();
  if (!source?.config?.enabled || !snapshot || snapshot.expiresAtMs <= now || !parsed || parsed.expiresAtMs <= now ||
    snapshot.configVersion !== source.configVersion || parsed.configVersion !== source.configVersion ||
    parsed.sourceHash !== snapshot.hash || parsed.sourceGeneration !== source.generation) fail("Refresh and extract the current rundown before reviewing.", 409);
  checkVersion(source.generation, generation);
  return parsed;
}
async function reconcileRundown(db, request, actor, now) {
  const ref = sessionRef(db, request.sessionId);
  return db.runTransaction(async transaction => {
    await assertStaffAuthority(db, transaction, actor);
    const session = await getSession(transaction, ref);
    assertEditable(session);
    const parsed = await currentSource(transaction, ref, now, request.sourceGeneration);
    const previous = (await transaction.get(reviewRef(ref))).data();
    const records = await transaction.get(ref.collection("banners").where("source", "==", "rundown").where("archived", "==", false)
      .select("record.id", "record.draft", "order", "source", "archived", "rundown").limit(101));
    const banners = records.docs.map(doc => doc.data()).filter(banner => !banner.archived && banner.rundown);
    if (records.size > 100) fail("Archive older source-linked banners before continuing.", 413);
    const presenceRefs = banners.map(banner => ref.collection("rundownPresence").doc(banner.record.id));
    const presenceSnapshots = presenceRefs.length ? await transaction.getAll(...presenceRefs) : [];
    const previousPresence = Object.fromEntries(presenceSnapshots.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
    const { changes, presence } = reconcileCandidates(parsed, banners, previousPresence);
    const ignored = changes.length ? await transaction.getAll(...changes.map(change => ref.collection("rundownIgnored").doc(change.fingerprint))) : [];
    const review = { schemaVersion: 1, version: (previous?.version ?? 0) + 1, sourceGeneration: parsed.sourceGeneration,
      sourceHash: parsed.sourceHash, configVersion: parsed.configVersion, parserCacheKey: parsed.cacheKey,
      changes: changes.filter((_change, index) => !ignored[index].exists), reconciledAtMs: now,
      expiresAtMs: parsed.expiresAtMs, purgeAt: parsed.purgeAt };
    if (Buffer.byteLength(JSON.stringify(review)) > 512 * 1024) fail("Review exceeds the byte budget. Select fewer tabs.", 413);
    for (const [id, state] of Object.entries(presence)) {
      if (fingerprint(state) !== fingerprint(previousPresence[id] ?? null)) boundedWrite(transaction, "set", ref.collection("rundownPresence").doc(id), state);
    }
    boundedWrite(transaction, "set", reviewRef(ref), review);
    audit(transaction, ref, `rundown_reconcile_${randomUUID()}`, actor.uid, "rundown_reconcile", now,
      { sourceGeneration: parsed.sourceGeneration, sourceHash: parsed.sourceHash, reviewVersion: review.version, count: review.changes.length });
    return { review };
  });
}

async function decideRundown(db, request, actor, now) {
  const ref = sessionRef(db, request.sessionId), receiptId = hash(`${actor.uid}:${request.requestId}`);
  const digest = fingerprint(request), receiptRef = ref.collection("rundownDecisions").doc(receiptId);
  return db.runTransaction(async transaction => {
    await assertStaffAuthority(db, transaction, actor);
    const session = await getSession(transaction, ref);
    const prior = (await transaction.get(receiptRef)).data();
    if (prior) {
      if (prior.fingerprint !== digest) fail("This decision ID was already used for different content.", 409);
      return { ...prior.result, replayed: true };
    }
    assertEditable(session);
    const parsed = await currentSource(transaction, ref, now, request.sourceGeneration);
    const review = (await transaction.get(reviewRef(ref))).data();
    if (!review || review.expiresAtMs <= now || review.sourceHash !== parsed.sourceHash || review.sourceGeneration !== parsed.sourceGeneration || review.configVersion !== parsed.configVersion) fail("The review changed. Refresh before deciding.", 409);
    checkVersion(review.version, request.reviewVersion);
    const change = review.changes.find(item => item.id === request.suggestionId);
    if (!change) fail("This suggestion is no longer pending.", 409);
    const targetId = change.target?.bannerId ?? request.targetBannerId ?? null;
    if (request.targetBannerId && request.targetBannerId !== change.target?.bannerId &&
      !change.possibleTargets.some(target => target.bannerId === request.targetBannerId)) fail("Choose a banner from this suggestion's review choices.");
    if (request.action === "ignore" && request.targetBannerId) fail("Ignore applies to the complete suggestion.");
    const targetRef = targetId ? ref.collection("banners").doc(targetId) : null;
    const current = targetRef ? (await transaction.get(targetRef)).data() : null;
    if (targetId && (!current || current.archived || current.source !== "rundown" || !current.rundown)) fail("The source-linked draft is unavailable.", 409);
    checkVersion(current?.record.draft.version ?? 0, request.baseVersion);
    let result;
    if (request.action === "ignore") {
      boundedWrite(transaction, "set", ref.collection("rundownIgnored").doc(change.fingerprint),
        { fingerprint: change.fingerprint, sourceHash: parsed.sourceHash, sourceGeneration: parsed.sourceGeneration, atMs: now, actorId: actor.uid });
      result = { decision: "ignored", bannerId: targetId, draftVersion: current?.record.draft.version ?? null };
    } else if (change.status === "REMOVED") {
      writeBanner(transaction, targetRef, { ...current, rundown: { ...current.rundown, removedFingerprint: change.fingerprint } });
      result = { decision: "removal_acknowledged", bannerId: targetId, draftVersion: current.record.draft.version };
    } else {
      const proposal = parseBannerText(request.text);
      const sourceText = change.candidate.text;
      const resolutionText = proposalBaseline(change.candidate, proposal.templateId);
      const editedFields = Object.keys(proposal).filter(key => key !== "templateId" && proposal[key] !== resolutionText[key]);
      const manualTemplate = sourceText?.templateId !== proposal.templateId ? ["templateId"] : [];
      if (editedFields.some(key => !request.editedFields?.includes(key))) fail("Confirm edited proposal fields or reload the source suggestion.", 409);
      const overrides = request.overrideFields ?? [];
      const text = parseBannerText(acceptedText(current, proposal, overrides));
      const id = targetId ?? hash(`${receiptId}:${change.id}`).slice(0, 32);
      const bannerRef = targetRef ?? ref.collection("banners").doc(id);
      // A deterministic request ID makes an uncertain response safe to retry.
      if (!current && (await transaction.get(bannerRef)).exists) fail("The proposed new draft already exists.", 409);
      const order = current && protectedFields(current).includes("order") && !overrides.includes("order") ? current.order : change.candidate.order;
      const draft = { version: (current?.record.draft.version ?? 0) + 1, text, updatedAtMs: now, updatedBy: actor.uid };
      const record = parseBannerRecord(current ? { ...current.record, draft } : { schemaVersion: 1, id, sessionId: session.id,
        draft, cue: null, acceptedCommand: null, confirmedLive: null });
      const banner = { ...current, record, order, source: "rundown", archived: false,
        rundown: { contextKey: change.candidate.contextKey, contentKey: contentKey(change.candidate), sourceFingerprint: change.candidate.fingerprint,
          tabId: change.candidate.tabId, tabTitle: change.candidate.tabTitle, segmentId: change.candidate.segmentId, segmentTitle: change.candidate.segmentTitle,
          rawLines: change.candidate.rawLines, acceptedText: text, acceptedOrder: order, documentId: parsed.documentId,
          sourceText, resolutionText, protectedFields: [...new Set([...(current ? protectedFields(current).filter(key => !overrides.includes(key)) : []), ...editedFields, ...manualTemplate])],
          sourceGeneration: parsed.sourceGeneration, sourceHash: parsed.sourceHash, removedFingerprint: null } };
      writeBanner(transaction, bannerRef, banner);
      result = { decision: "accepted", bannerId: id, draftVersion: draft.version };
    }
    const nextReview = { ...review, version: review.version + 1, changes: review.changes.filter(item => item.id !== change.id) };
    boundedWrite(transaction, "set", reviewRef(ref), nextReview);
    boundedWrite(transaction, "create", receiptRef, { fingerprint: digest, result, atMs: now, actorId: actor.uid });
    audit(transaction, ref, `rundown_decision_${receiptId}`, actor.uid, `rundown_${result.decision}`, now,
      { suggestionFingerprint: change.fingerprint, sourceGeneration: parsed.sourceGeneration, sourceHash: parsed.sourceHash,
        bannerId: result.bannerId, draftVersion: result.draftVersion });
    return { ...result, replayed: false };
  });
}
module.exports = { reviewRef, reconcileRundown, decideRundown };
