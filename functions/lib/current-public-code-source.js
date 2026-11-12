"use strict";

const { assertPublicationTarget } = require("./publication-target");
const { CURRENT_CODE_BYTES, validateCurrentCodeReference } = require("./current-public-code-reference");
const CURRENT_CODE_REPLY_BYTES = Math.ceil(CURRENT_CODE_BYTES / 3) * 4 + 8192;
function refuse(rpcStatus) { throw Object.assign(new Error("Private current CODE source is unavailable"),
  { status: 409, ...(rpcStatus ? { rpcStatus } : {}) }); }

// The caller supplies the secret reader. A default here would pull Functions
// modules into the preview renderer Worker bundle, which shares this file.
function privateCodeTransport({ target, rendererSha, request = fetch, readSecret }) {
  if ((process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST) && request === fetch) {
    throw Object.assign(new Error("Emulated record code reads require an explicit local fixture transport"), { status: 409 });
  }
  target = assertPublicationTarget(target);
  if (typeof rendererSha !== "string" || !/^[a-f0-9]{40}$/.test(rendererSha)) refuse();
  const origin = target.environment === "development" ? "https://dev-api.example.org" : "https://api.example.org";
  return {
    async readCurrentCodeWire(mode = "current-code") {
      const query = { mode, rendererSha };
      const maxReplyBytes = mode === "current-code-reference" ? 8192 : CURRENT_CODE_REPLY_BYTES;
      const secret = readSecret?.(); if (typeof secret !== "string" || !secret.trim()) refuse();
      const response = await request(`${origin}/_internal/record-code`, { method: "POST", redirect: "manual",
        signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", "x-njpbs-cms-edge": secret },
        body: JSON.stringify(query) });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        await response.body?.cancel(); refuse(response.ok ? undefined : response.status);
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^[1-9][0-9]*$/.test(declared) || Number(declared) > maxReplyBytes)) {
        await response.body.cancel(); refuse();
      }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const row = await reader.read(); if (row.done) break;
          size += row.value.length; if (size > maxReplyBytes) refuse(); chunks.push(row.value);
        }
      } finally { await reader.cancel(); }
      if (!size || declared !== null && Number(declared) !== size) refuse();
      let wire; try { wire = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { refuse(); }
      return wire;
    },
  };
}
function createCurrentCodeTransport(options) {
  if (options.pairSelection !== undefined) return require("./current-public-code-v2").createPairCurrentCodeTransport(options);
  const transport = privateCodeTransport(options);
  return { async readCurrentCodeReference() {
    const wire = await transport.readCurrentCodeWire("current-code-reference");
    if (!wire || Object.keys(wire).sort().join(",") !== "kind,reference,schemaVersion" || wire.schemaVersion !== 1 ||
        wire.kind !== "current-code-reference") refuse();
    const reference = validateCurrentCodeReference(wire.reference);
    if (reference.publication.commitSha !== options.rendererSha) refuse();
    return reference;
  }, async readCurrentCode() {
    const wire = await transport.readCurrentCodeWire();
    if (!wire || Object.keys(wire).sort().join(",") !== "bytes,kind,reference,schemaVersion" || wire.schemaVersion !== 1 ||
        wire.kind !== "current-code" || typeof wire.bytes !== "string" || wire.bytes.length > Math.ceil(CURRENT_CODE_BYTES / 3) * 4) refuse();
    const reference = validateCurrentCodeReference(wire.reference), bytes = Buffer.from(wire.bytes, "base64");
    if (!bytes.length || bytes.length > CURRENT_CODE_BYTES || bytes.length !== reference.manifest.byteLength ||
        bytes.toString("base64") !== wire.bytes || reference.publication.commitSha !== options.rendererSha) refuse();
    return { reference, bytes };
  } };
}
module.exports = { validateCurrentCodeReference, createCurrentCodeTransport };
