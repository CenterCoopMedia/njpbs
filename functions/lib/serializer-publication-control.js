"use strict";

const SERIALIZER_CONTROL_PATH = "system/publicDeployment/controls/serializer";
const DISABLED_MESSAGE = "The full-site build was retired on October 13, 2026. This change has no build-free publication path yet. Ask an administrator.";
function refuse(message, invalid = false) {
  throw Object.assign(new Error(message), { status: 409,
    code: invalid ? "serializer_publication_control_invalid" : "serializer_publication_unavailable",
    ...(invalid ? { scheduleDeferred: true } : {}) });
}
function parseSerializerPublicationControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "enabled,schemaVersion" ||
      value.schemaVersion !== 1 || typeof value.enabled !== "boolean") {
    refuse("Publication control is unavailable. Try again later.", true);
  }
  return { schemaVersion: 1, enabled: value.enabled };
}
async function readSerializerPublicationControlInTransaction({ firestore, transaction }) {
  const row = await transaction.get(firestore.doc(SERIALIZER_CONTROL_PATH));
  return row.exists ? parseSerializerPublicationControl(row.data()) : { schemaVersion: 1, enabled: true };
}
async function assertSerializerPublicationEnabledInTransaction(input) {
  const control = await readSerializerPublicationControlInTransaction(input);
  if (!control.enabled) refuse(DISABLED_MESSAGE);
  return control;
}
module.exports = { SERIALIZER_CONTROL_PATH, DISABLED_MESSAGE, parseSerializerPublicationControl,
  readSerializerPublicationControlInTransaction, assertSerializerPublicationEnabledInTransaction };
