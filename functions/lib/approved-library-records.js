"use strict";

const libraryKinds = new Set(["sponsor", "newsletter"]);
const version = value => Number.isSafeInteger(value) && value > 0;

// Approval already commits the complete `after` document to immutable
// cmsVersionHistory in the same transaction as the lifecycle change. Reopening,
// saving and sending back leave that approval intact. Archive/unpublish revoke it
// until a later approval; restoring a record alone does not approve its content.
function approvedLibraryVersion(record, history) {
  if (!libraryKinds.has(record.type) || record.deleted || record.status === "archived" || !version(record.version)) return null;
  let latest = null;
  let ambiguous = false;
  for (const entry of history) {
    if (entry.collection !== "cmsPosts" || entry.documentId !== record.id) continue;
    const revoked = entry.after?.deleted === true || entry.after?.status === "archived";
    if (!revoked && !["approve", "archive", "unpublish"].includes(entry.action)) continue;
    // Lifecycle transitions advance exactly one version. An incomplete old row
    // may be ordered using its retained before.version, but can never supply
    // approved content itself. Unorderable history still fails closed.
    const eventVersion = version(entry.after?.version) ? entry.after.version
      : version(entry.before?.version) ? entry.before.version + 1 : null;
    if (!version(eventVersion) || eventVersion > record.version) return null;
    if (!latest || eventVersion > latest.version) {
      latest = { entry, version: eventVersion, revoked };
      ambiguous = false;
    } else if (eventVersion === latest.version) {
      // Supported writers commit distinct versions. Corrupt ties must not let
      // random history document IDs choose which content becomes public.
      ambiguous = true;
    }
  }
  if (!latest || ambiguous || latest.revoked || latest.entry.action !== "approve") return null;
  const approved = latest.entry.after;
  if (!version(approved?.version) || approved.status !== "approved" || approved.type !== record.type || approved.deleted) return null;
  return { ...approved, id: record.id };
}

async function resolveApprovedLibraryVersions(firestore, records, readQuery = query => query.get()) {
  return Promise.all(records.map(async record => {
    // This is an in-memory projection, never a field trusted from cmsPosts.
    let approved = null;
    if (libraryKinds.has(record.type) && !record.deleted && record.status !== "archived") {
      const query = firestore.collection("cmsVersionHistory")
        .where("collection", "==", "cmsPosts")
        .where("documentId", "==", record.id);
      const history = await readQuery(query);
      approved = approvedLibraryVersion(record, history.docs.map(doc => doc.data()));
    }
    return { ...record, approvedLibraryVersion: approved };
  }));
}

module.exports = { approvedLibraryVersion, resolveApprovedLibraryVersions };
