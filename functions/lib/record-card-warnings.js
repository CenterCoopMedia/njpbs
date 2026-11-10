"use strict";

const { resolveApprovedLibraryVersions } = require("./approved-library-records");

const MAX_REFERENCE_CHECKS = 24;
const WARNING_DEADLINE_MS = 1_000;
const incompleteWarning = "Some record card references could not be checked. Reopen this content to verify them.";

async function recordCardSaveWarnings(firestore, document) {
  const cards = (Array.isArray(document.blocks) ? document.blocks : [])
    .flatMap(block => {
      if (block.type === "record_card" && block.data?.recordId) {
        return [{ label: `Record card ${block.id}`, kind: block.data.recordKind, id: block.data.recordId }];
      }
      if (block.type === "sponsor_strip" && Array.isArray(block.data?.sponsorIds)) {
        return block.data.sponsorIds.map(id => ({ label: `Sponsor strip ${block.id}`, kind: "sponsor", id }));
      }
      if (block.type === "newsletter_signup" && Array.isArray(block.data?.newsletterIds)) {
        return block.data.newsletterIds.map(id => ({ label: `Newsletter signup ${block.id}`, kind: "newsletter", id }));
      }
      return [];
    });
  if (cards.length === 0) return [];
  const allIds = [...new Set(cards.map(card => card.id))];
  const ids = allIds.slice(0, MAX_REFERENCE_CHECKS);
  let timer;
  try {
    // These checks run after commit. Bound both fan-out and response latency so
    // advisory guidance cannot turn a successful save into an apparent timeout.
    return await Promise.race([
      warningsForCards(firestore, cards, ids, allIds.length > ids.length),
      new Promise(resolve => { timer = setTimeout(() => resolve([incompleteWarning]), WARNING_DEADLINE_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function warningsForCards(firestore, cards, ids, truncated) {
  const snapshots = await Promise.all(ids.map(id =>
    firestore.collection("cmsPosts").doc(id).get()));
  const resolved = await resolveApprovedLibraryVersions(firestore, snapshots.flatMap((snapshot, index) =>
    snapshot.exists ? [{ ...snapshot.data(), id: ids[index] }] : []));
  const records = new Map(resolved.map(record => [record.id, record]));
  const checked = new Set(ids);
  const warnings = cards.filter(card => checked.has(card.id)).flatMap(card => {
    const record = records.get(card.id);
    if (!record || record.deleted || record.status === "archived" || record.type !== card.kind) {
      return [`${card.label}: The selected ${card.kind} is missing or archived. This card will be hidden on the public site.`];
    }
    if (["sponsor", "newsletter"].includes(card.kind) && !record.approvedLibraryVersion) {
      return [`${card.label}: The selected ${card.kind} has no approved version available. This card will be hidden on the public site.`];
    }
    return [];
  });
  if (truncated) warnings.push(incompleteWarning);
  return warnings;
}

module.exports = { recordCardSaveWarnings };
