"use strict";

const { createHash, randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const { can } = require("./rbac");
const { isApprovedActiveAccount } = require("./active-account");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const { principalFromStoredUserDoc } = require("./principal");

const CREDENTIAL_COLLECTION = "mediaTranscriptionCredentials";
class CredentialError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseCredentialRequest(value, operation) {
  const allowed = operation === "save" ? ["scope", "provider", "key", "expectedRevision"]
    : operation === "disconnect" ? ["scope", "provider", "expectedRevision"] : ["scope", "provider"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) ||
      !["personal", "organization"].includes(value.scope) || value.provider !== "elevenlabs") {
    throw new CredentialError(400, "Transcription credential request is invalid");
  }
  if (operation !== "list" && (!Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 0 || value.expectedRevision >= Number.MAX_SAFE_INTEGER)) {
    throw new CredentialError(400, "Credential revision is invalid");
  }
  if (operation === "save" && (typeof value.key !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(value.key))) {
    throw new CredentialError(400, "Provider key must contain 16 to 4096 printable characters without spaces");
  }
  return { scope: value.scope, provider: value.provider,
    ...(operation === "list" ? {} : { expectedRevision: value.expectedRevision }),
    ...(operation === "save" ? { key: value.key } : {}) };
}

async function authorizeCredentialScope({ firestore, actor, scope, activeAccount = isApprovedActiveAccount }) {
  if (typeof actor?.uid !== "string" || !actor.uid || !await activeAccount(firestore, actor.uid) ||
      (scope === "organization" && !can(actor.principal, "settings.manage", {}))) {
    throw new CredentialError(403, "Transcription credential access denied");
  }
}

function credentialIdentity(actor, request) {
  const ownerUid = request.scope === "personal" ? actor.uid : null;
  const id = createHash("sha256").update(JSON.stringify(["credential-v1", request.scope, ownerUid, request.provider])).digest("hex");
  return { id, scope: request.scope, ownerUid, provider: request.provider };
}

function aad(record) {
  return Buffer.from(JSON.stringify([1, record.id, record.scope, record.ownerUid, record.provider, record.revision, record.keyVersion]), "utf8");
}

function encryptionKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new CredentialError(503, "Credential storage is unavailable");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new CredentialError(503, "Credential storage is unavailable");
  return key;
}

function encryptCredential(plaintext, record, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(record));
  const input = Buffer.from(plaintext, "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    return { nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  } finally { input.fill(0); }
}

function decryptCredential(record, expected, key, keyVersion) {
  // The caller must supply identity from the authenticated owner/scope, never from this ciphertext row.
  if (record.schemaVersion !== 1 || !record.enabled || record.keyVersion !== keyVersion ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      ["id", "scope", "ownerUid", "provider", "revision"].some((field) => record[field] !== expected[field])) {
    throw new CredentialError(409, "Transcription credential changed");
  }
  try {
    const nonce = Buffer.from(record.nonce, "base64");
    const tag = Buffer.from(record.authTag, "base64");
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length < 16 || ciphertext.length > 4096) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad(record));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw new CredentialError(503, "Credential storage is unavailable"); }
}

function credentialSummary(record) {
  if (!record) return null;
  return { id: record.id, scope: record.scope, provider: record.provider, revision: record.revision,
    configured: record.enabled === true, verification: "unverified", updatedAt: record.updatedAt };
}

function checkIdentity(record, identity) {
  if (record && ["id", "scope", "ownerUid", "provider"].some((field) => record[field] !== identity[field])) {
    throw new CredentialError(503, "Credential storage is unavailable");
  }
}

async function authorizeCredentialMutation({ tx, firestore, actor, scope }) {
  if (typeof actor?.uid !== "string" || !actor.uid.trim()) {
    throw new CredentialError(403, "Transcription credential access denied");
  }
  // Keep account authorization in the read set so a concurrent revocation retries the transaction.
  const snapshot = await tx.get(firestore.collection("users").doc(actor.uid));
  const user = snapshot.exists ? snapshot.data() : null;
  const principal = await principalFromStoredUserDoc(firestore, actor.uid, user, tx);
  if (!user || user.active === false ||
      (scope === "organization" && !can(principal, "settings.manage", {}))) {
    throw new CredentialError(403, "Transcription credential access denied");
  }
}

async function listCredential({ firestore, actor, request }) {
  const identity = credentialIdentity(actor, request);
  const record = (await firestore.collection(CREDENTIAL_COLLECTION).doc(identity.id).get()).data();
  checkIdentity(record, identity);
  return { credentials: record ? [credentialSummary(record)] : [] };
}

async function saveCredential({ firestore, actor, request, key, keyVersion, audit = adminLogEntry, now = Date.now }) {
  if (!/^[1-9]\d{0,9}$/.test(keyVersion)) throw new CredentialError(503, "Credential storage is unavailable");
  const identity = credentialIdentity(actor, request);
  const ref = firestore.collection(CREDENTIAL_COLLECTION).doc(identity.id);
  return firestore.runTransaction(async (tx) => {
    await authorizeCredentialMutation({ tx, firestore, actor, scope: request.scope });
    const previous = (await tx.get(ref)).data();
    checkIdentity(previous, identity);
    if ((previous?.revision ?? 0) !== request.expectedRevision) throw new CredentialError(409, "Credential changed. Reload before saving");
    const at = new Date(now()).toISOString();
    const record = { ...identity, schemaVersion: 1, revision: request.expectedRevision + 1, keyVersion, enabled: true,
      createdAt: previous?.createdAt ?? at, createdBy: previous?.createdBy ?? actor.uid,
      updatedAt: at, updatedBy: actor.uid };
    Object.assign(record, encryptCredential(request.key, record, key));
    tx.set(ref, record);
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({
      actorUid: actor.uid, action: "media.transcription.credential.save", target: `${CREDENTIAL_COLLECTION}/${identity.id}`,
      after: { scope: identity.scope, provider: identity.provider, revision: record.revision },
    }));
    return { credential: credentialSummary(record) };
  });
}

async function disconnectCredential({ firestore, actor, request, audit = adminLogEntry, now = Date.now }) {
  const identity = credentialIdentity(actor, request);
  const ref = firestore.collection(CREDENTIAL_COLLECTION).doc(identity.id);
  return firestore.runTransaction(async (tx) => {
    await authorizeCredentialMutation({ tx, firestore, actor, scope: request.scope });
    const record = (await tx.get(ref)).data();
    checkIdentity(record, identity);
    if (!record || record.revision !== request.expectedRevision) throw new CredentialError(409, "Credential changed. Reload before disconnecting");
    const changes = { enabled: false, revision: record.revision + 1, updatedAt: new Date(now()).toISOString(), updatedBy: actor.uid };
    // Keep a disabled tombstone for CAS. Remove ciphertext; saved transcripts remain independent.
    tx.set(ref, { ...identity, schemaVersion: 1, createdAt: record.createdAt, createdBy: record.createdBy, ...changes });
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({
      actorUid: actor.uid, action: "media.transcription.credential.disconnect", target: `${CREDENTIAL_COLLECTION}/${identity.id}`,
      after: { scope: identity.scope, provider: identity.provider, revision: changes.revision },
    }));
    return { credential: credentialSummary({ ...record, ...changes }) };
  });
}

module.exports = { CREDENTIAL_COLLECTION, CredentialError, parseCredentialRequest, authorizeCredentialScope,
  credentialIdentity, encryptionKey, encryptCredential, decryptCredential, credentialSummary,
  listCredential, saveCredential, disconnectCredential };
