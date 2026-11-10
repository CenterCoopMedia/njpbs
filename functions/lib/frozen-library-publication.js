"use strict";

const { readCmsPublicationRuntimeControlInTransaction } = require("./cms-publication-runtime-control");
const { addressedPublishChanges } = require("./publish-build-state");
const { readSerializerPublicationControlInTransaction } = require("./serializer-publication-control");
const FROZEN_TYPES = new Set(["program", "event", "sponsor", "newsletter"]);
const CLOUD_SERIALIZERS = new Set(["cloudflare-publisher", "cloudflare-dev-publisher"]);
const KIND_LABELS = { program: "Program", event: "Event", sponsor: "Sponsor", newsletter: "Newsletter" };
const RETIRED = "since the full-site build was retired on October 13, 2026";

// Routed families stay frozen until their owner is ready. Card-only kinds use
// approval context publication instead of this detail/schedule path.
function frozenKindMessage(type) {
  const label = KIND_LABELS[type];
  if (type === "sponsor" || type === "newsletter") {
    return `Use Approve to publish this ${label} card. It has no detail page and cannot be scheduled.`;
  }
  return `${label} records cannot publish or unpublish ${RETIRED}. Live ${type} pages stay as they are. Ask an administrator.`;
}

function frozenLibraryPublicationMessage(collection, document, control) {
  if (collection !== "cmsPosts" || !FROZEN_TYPES.has(document?.type)) return null;
  const cloudOnly = CLOUD_SERIALIZERS.has(control?.serializerId) ||
    control?.cloud && control.phase !== "ready";
  return cloudOnly ? frozenKindMessage(document.type) : null;
}

async function recordPublicationReady({ firestore, transaction, documentId, document, withdrawal }) {
  const { recordFamily, readRecordPublicationPrerequisites } = require("./no-build-record-publication");
  const family = recordFamily(document);
  if (!family || !documentId) return false;
  const { readNoBuildFamilyAdmission, selectsNoBuildRecord } = require("./no-build-family-admission");
  const config = await readNoBuildFamilyAdmission({ firestore, transaction });
  const { state } = await require("./no-build-record-ownership").readNoBuildRecordOwner({ firestore, transaction, documentId });
  if (withdrawal && state) return true;
  if (!state && !selectsNoBuildRecord(config, family, documentId)) return false;
  await readRecordPublicationPrerequisites({ firestore, transaction, family });
  return true;
}
async function readFrozenLibraryPublicationMessage({ firestore, transaction, collection, documentId, document, withdrawal = false }) {
  if (collection !== "cmsPosts" || !FROZEN_TYPES.has(document?.type)) return null;
  if (await recordPublicationReady({ firestore, transaction, documentId, document, withdrawal })) return null;
  if (!(await readSerializerPublicationControlInTransaction({ firestore, transaction })).enabled) return frozenKindMessage(document.type);
  const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
  return frozenLibraryPublicationMessage(collection, document, control);
}

async function assertRequestedLibraryPublicationAvailable({ firestore, transaction, changes }) {
  const selected = addressedPublishChanges(changes).filter(change => change.collection === "cmsPosts" && change.operation !== "withdraw");
  if (!selected.length) return;
  const rows = await transaction.getAll(...selected.map(change => firestore.doc(`cmsPosts/${change.id}`)));
  const frozen = rows.filter(row => FROZEN_TYPES.has(row.data()?.type));
  if (!frozen.length) return;
  if (!(await readSerializerPublicationControlInTransaction({ firestore, transaction })).enabled) {
    throw Object.assign(new Error(frozenKindMessage(frozen[0].data().type)), { status: 409, code: "library_publication_unavailable" });
  }
  const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
  for (const row of frozen) {
    const message = frozenLibraryPublicationMessage("cmsPosts", row.data(), control);
    if (message) throw Object.assign(new Error(message), { status: 409, code: "library_publication_unavailable" });
  }
}

module.exports = { frozenLibraryPublicationMessage, readFrozenLibraryPublicationMessage,
  assertRequestedLibraryPublicationAvailable };
