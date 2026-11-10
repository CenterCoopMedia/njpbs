"use strict";
const protocol = require("./public-release-pair");
const log = require("./public-release-change-log");
const bodies = require("./public-release-source-body");
const { createHash } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
function refuse() { throw new protocol.PublicReleaseProtocolError(); }
async function assertReadPublicReleaseChangeEvidenceInTransaction({ firestore, transaction, entry: raw }) {
  const entry = log.parsePublicReleaseChange(raw), base = firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH);
  const [stored, index] = await transaction.getAll(base.collection("entries").doc(String(entry.sequence).padStart(16, "0")),
    base.collection("operations").doc(entry.operationId));
  if (!stored.exists || protocol.publicReleaseDigest(log.parsePublicReleaseChange(stored.data())) !== protocol.publicReleaseDigest(entry) ||
      index.data()?.sequence !== entry.sequence || index.data()?.entryDigest !== entry.entryDigest ||
      index.data()?.inputDigest !== protocol.publicReleaseDigest(log.parsePublicReleaseChangeInput({ operationId: entry.operationId,
        pair: entry.pair, contextRevision: entry.contextRevision, changes: entry.changes }))) refuse();
  const rows = await transaction.getAll(...entry.changes.map(change => base.collection("operations").doc(entry.operationId)
    .collection("members").doc(hash(JSON.stringify([change.kind, change.id])))));
  const members = [];
  for (let index = 0; index < rows.length; index++) {
    const value = rows[index].data(), change = entry.changes[index];
    if (!value || value.schemaVersion !== 2 || value.sequence !== entry.sequence || value.operationId !== entry.operationId ||
        value.entryDigest !== entry.entryDigest || protocol.publicReleaseDigest(value.change) !== protocol.publicReleaseDigest(change) ||
        typeof value.json !== "string" || hash(value.json) !== change.snapshotDigest) refuse();
    const body = await bodies.readPublicReleaseSourceBody({ firestore, transaction, contentDigest: value.contentDigest });
    if (body.kind !== change.kind || body.id !== change.id || body.sourceVersion !== change.sourceVersion ||
        body.action !== change.action || bodies.publicReleaseSnapshotJson(body.snapshot) !== value.json) refuse();
    members.push({ change, snapshot: body.snapshot, contentDigest: value.contentDigest, body });
  }
  return { entry, members, createdAt: stored.createTime.toMillis() };
}
module.exports = { assertReadPublicReleaseChangeEvidenceInTransaction };
