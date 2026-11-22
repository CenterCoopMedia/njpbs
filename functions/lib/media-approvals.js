"use strict";

const { sourceMediaApprovalVersions } = require("./source-media-contract");
const { MEDIA_APPROVAL_PURPOSES, MediaFeedbackValidationError, timestampIso } = require("./media-feedback");

const PAGE_SIZE = 20;

function approvalItems(firestore, target) {
  return firestore.collection("mediaApprovals").doc(target.documentId).collection("items");
}

function approvalId(purpose, version) {
  return `${purpose}-${version}`;
}

function approvalProjection(id, record) {
  return {
    id,
    rendition: record.rendition,
    version: record.version,
    purpose: record.purpose,
    originalName: record.originalName,
    approvedByName: record.approvedByName,
    approvedAt: timestampIso(record.approvedAt),
  };
}

function projectApproval(snapshot) {
  return approvalProjection(snapshot.id, snapshot.data());
}

async function readMediaApprovals({ firestore, target, cursor }) {
  const items = approvalItems(firestore, target);
  return firestore.runTransaction(async (transaction) => {
    const asset = target.assertSnapshot(await transaction.get(target.reference));
    const versions = sourceMediaApprovalVersions(asset);
    let history = items.orderBy("approvedAt", "desc").limit(PAGE_SIZE + 1);
    if (cursor) {
      const previous = await transaction.get(items.doc(cursor));
      if (!previous.exists) throw new MediaFeedbackValidationError("Approval history cursor is invalid");
      history = history.startAfter(previous);
    }
    const refs = Object.values(versions).filter(Boolean).flatMap(version =>
      MEDIA_APPROVAL_PURPOSES.map(purpose => items.doc(approvalId(purpose, version))));
    const [current, page] = await Promise.all([
      refs.length ? transaction.getAll(...refs) : [],
      transaction.get(history),
    ]);
    const rows = page.docs.slice(0, PAGE_SIZE);
    return {
      versions,
      current: current.filter(snapshot => snapshot.exists).map(projectApproval),
      history: rows.map(projectApproval),
      nextCursor: page.size > PAGE_SIZE ? rows.at(-1).id : null,
    };
  }, { readOnly: true });
}

async function recordMediaApproval({ firestore, target, actor, approval, authorName, nowFn }) {
  const { purpose, rendition, version } = approval;
  const reference = approvalItems(firestore, target).doc(approvalId(purpose, version));
  return firestore.runTransaction(async (transaction) => {
    const [assetSnapshot, existing] = await transaction.getAll(target.reference, reference);
    const asset = target.assertSnapshot(assetSnapshot);
    if (sourceMediaApprovalVersions(asset)[rendition] !== version) {
      throw new MediaFeedbackValidationError(
        "The video file changed. Reopen it before recording approval.", 409, "media_approval_version_changed",
      );
    }
    // A retry or a concurrent approval for this purpose preserves the first decision.
    if (existing.exists) return projectApproval(existing);
    const record = {
      rendition,
      version,
      purpose,
      originalName: asset.originalName,
      approvedByUid: actor.uid,
      approvedByName: authorName,
      approvedAt: nowFn(),
    };
    transaction.create(reference, record);
    return approvalProjection(reference.id, record);
  });
}

module.exports = { readMediaApprovals, recordMediaApproval };
