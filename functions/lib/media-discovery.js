"use strict";

const { bumpPublicContextRevision } = require("./public-context-revision");
const { FieldValue } = require("firebase-admin/firestore");
const { mediaAssetSummary, mediaSearchText } = require("./media-library");

const MEDIA_DISCOVERY_SCHEMA = 1;
const MEDIA_DISCOVERY_STATE = "system/mediaDiscovery";
const MAX_DISCOVERY_TERMS = 512;
const OVERFLOW_TERM = "overflow";
const BROWSE_TERM = "browse";
const LEGACY_ACTIVE_MEDIA_ADMISSION_LIMIT = 500;
const INDEXED_ACTIVE_MEDIA_ADMISSION_LIMIT = 5_000;

// Encode code units, rather than storing partial surrogate pairs in Firestore strings.
// This keeps the existing JavaScript substring contract, including unusual Unicode input.
function discoveryTerm(text) {
  return Array.from({ length: text.length }, (_, i) =>
    text.charCodeAt(i).toString(16).padStart(4, "0")).join("");
}

function discoveryTerms(text) {
  const terms = new Set();
  for (let i = 0; i <= text.length - 3; i++) {
    terms.add(discoveryTerm(text.slice(i, i + 3)));
    if (terms.size > MAX_DISCOVERY_TERMS) {
      return [...terms].slice(0, MAX_DISCOVERY_TERMS).concat(OVERFLOW_TERM);
    }
  }
  return [...terms];
}

function dateKey(value) {
  // Missing dates sort last ascending and first descending, as in the earlier list.
  return value === null ? Number.MAX_SAFE_INTEGER : Date.parse(value);
}

function deriveMediaDiscovery(id, record) {
  if (record.lifecycle !== "active") {
    return { schema: MEDIA_DISCOVERY_SCHEMA, eligible: false, terms: [] };
  }
  const summary = mediaAssetSummary(id, record);
  if (!summary) throw new Error("Active media cannot be indexed: Invalid summary");
  const nameKey = summary.name.toWellFormed().normalize("NFC").toLocaleLowerCase("en-US");
  // Bound every array index entry, including legacy records outside current input bounds.
  if (Buffer.byteLength(nameKey, "utf8") > 540) {
    throw new Error("Active media cannot be indexed: Name is too long");
  }
  return {
    schema: MEDIA_DISCOVERY_SCHEMA,
    eligible: true,
    nameKey,
    createdAtKey: dateKey(summary.createdAt),
    updatedAtKey: dateKey(summary.updatedAt),
    sizeBytesKey: summary.sizeBytes,
    terms: [BROWSE_TERM, ...discoveryTerms(mediaSearchText(summary).toWellFormed())],
  };
}

function withMediaDiscovery(id, record) {
  return { ...record, mediaDiscovery: deriveMediaDiscovery(id, record) };
}

function bumpMediaDiscoveryRevision(transaction, firestore, {
  withdrawal = false, admissionCount = null, admissionRevision = null, preserveAdmission = false,
} = {}) {
  bumpPublicContextRevision(transaction, firestore, { withdrawal });
  transaction.set(firestore.doc(MEDIA_DISCOVERY_STATE), {
    revision: admissionCount !== null ? admissionRevision : FieldValue.increment(1),
    // Bulk writers invalidate the ledger unless they account for the lifecycle change.
    ...(admissionCount !== null ? { admission: { schema: 1, activeCount: admissionCount, revision: admissionRevision } }
      : preserveAdmission ? { admission: { revision: FieldValue.increment(1) } }
        : { admission: FieldValue.delete() }),
  }, { merge: true });
}

function mediaRevision(state) {
  const revision = state?.revision ?? 0;
  // Leave room for the next mutation as well as repairing malformed values.
  return Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER
    ? revision : 0;
}

function validAdmission(state) {
  const cached = state?.admission;
  const revision = state?.revision ?? 0;
  return Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER && cached?.schema === 1 &&
    cached.revision === revision && Number.isSafeInteger(cached.activeCount) &&
    cached.activeCount >= 0 && cached.activeCount <= INDEXED_ACTIVE_MEDIA_ADMISSION_LIMIT;
}

async function prepareMediaAdmissionRelease(transaction, firestore) {
  const state = (await transaction.get(firestore.doc(MEDIA_DISCOVERY_STATE))).data();
  // Deletion is how an over-capacity library recovers. Missing, stale, zero or
  // corrupt counts invalidate the ledger without preventing the deletion.
  return validAdmission(state) && state.admission.activeCount > 0 ? {
    admissionCount: state.admission.activeCount - 1,
    admissionRevision: mediaRevision(state) + 1,
  } : {};
}

// Canonical lifecycle checks and this shared document serialize admission with
// upload, deletion, restore and reconciliation. Call before any writes.
async function readMediaAdmission(transaction, firestore, { reconcile = false } = {}) {
  const snapshot = await transaction.get(firestore.doc(MEDIA_DISCOVERY_STATE));
  const state = snapshot.exists ? snapshot.data() : null;
  const limit = state?.schema === MEDIA_DISCOVERY_SCHEMA && state.state === "ready"
    ? INDEXED_ACTIVE_MEDIA_ADMISSION_LIMIT : LEGACY_ACTIVE_MEDIA_ADMISSION_LIMIT;
  const cached = state?.admission;
  const revision = mediaRevision(state);
  if (!reconcile && validAdmission(state)) {
    return { activeCount: cached.activeCount, limit, revision };
  }
  const active = await transaction.get(firestore.collection("media_assets")
    .where("lifecycle", "==", "active").select().limit(INDEXED_ACTIVE_MEDIA_ADMISSION_LIMIT + 1));
  if (active.size > INDEXED_ACTIVE_MEDIA_ADMISSION_LIMIT) {
    throw Object.assign(new Error("Media admission reconciliation exceeds 5,000 active records"), {
      status: 503, code: "media-admission-overflow",
    });
  }
  return { activeCount: active.size, limit, revision };
}

function writeMediaAdmission(transaction, firestore, activeCount, revision) {
  if (!Number.isSafeInteger(activeCount) || activeCount < 0 || activeCount > INDEXED_ACTIVE_MEDIA_ADMISSION_LIMIT ||
      !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new Error("Media admission count needs reconciliation"), { status: 503 });
  }
  transaction.set(firestore.doc(MEDIA_DISCOVERY_STATE), {
    revision,
    admission: { schema: 1, activeCount, revision },
  }, { merge: true });
}

async function reconcileMediaAdmission(firestore, { apply = false } = {}) {
  return firestore.runTransaction(async transaction => {
    const result = await readMediaAdmission(transaction, firestore, { reconcile: true });
    if (apply) writeMediaAdmission(transaction, firestore, result.activeCount, result.revision);
    return { ...result, applied: apply };
  });
}

module.exports = {
  MEDIA_DISCOVERY_SCHEMA,
  MEDIA_DISCOVERY_STATE,
  MAX_DISCOVERY_TERMS,
  OVERFLOW_TERM,
  BROWSE_TERM,
  LEGACY_ACTIVE_MEDIA_ADMISSION_LIMIT,
  INDEXED_ACTIVE_MEDIA_ADMISSION_LIMIT,
  discoveryTerm,
  discoveryTerms,
  deriveMediaDiscovery,
  withMediaDiscovery,
  bumpMediaDiscoveryRevision,
  prepareMediaAdmissionRelease,
  readMediaAdmission,
  writeMediaAdmission,
  reconcileMediaAdmission,
};
