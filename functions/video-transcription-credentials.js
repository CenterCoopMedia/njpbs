"use strict";

const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest, JsonRequestError } = require("./lib/http-json");
const { runtimeRegistry } = require("./source-media");
const { authorizeMediaSource } = require("./lib/media-sources");
const { assertBillingEnabled } = require("./lib/billing-state");
const { CredentialError, parseCredentialRequest, authorizeCredentialScope, encryptionKey,
  listCredential, saveCredential, disconnectCredential } = require("./lib/video-transcription-credentials");

const { KEY, KEY_VERSION, CREDENTIAL_SERVICE_ACCOUNT: SERVICE_ACCOUNT } = require("./lib/video-transcription-config");

function createCredentialHandler(operation, dependencies = {}) {
  const firestore = dependencies.firestore ?? db;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    let key;
    try {
      // A 4096-character key can double in size through JSON escaping.
      validateBoundedJsonRequest(req, (operation === "save" ? 16 : 8) * 1024);
      await (dependencies.verifyAppCheckFn ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      const actor = await (dependencies.requirePrincipalFn ?? requirePrincipal)(req);
      const request = parseCredentialRequest(req.body, operation);
      await (dependencies.authorizeSourceFn ?? authorizeMediaSource)({ firestore, actor,
        source: (dependencies.registryFn ?? runtimeRegistry)().get("video-library"), operation: "browse" });
      await authorizeCredentialScope({ firestore, actor, scope: request.scope, activeAccount: dependencies.activeAccountFn });
      const args = { firestore, actor, request, audit: dependencies.audit, now: dependencies.now };
      let result;
      if (operation === "save") {
        try { await (dependencies.assertBillingEnabledFn ?? assertBillingEnabled)(firestore); }
        catch { throw new CredentialError(503, "Credential storage is unavailable while billing is stopped"); }
        key = encryptionKey((dependencies.keyFn ?? (() => KEY.value()))());
        result = await saveCredential({ ...args, key, keyVersion: (dependencies.keyVersionFn ?? (() => KEY_VERSION.value()))() });
      } else if (operation === "disconnect") result = await disconnectCredential(args);
      else result = await listCredential(args);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const known = error instanceof CredentialError || error instanceof JsonRequestError;
      const authStatus = [401, 403].includes(error?.status) ? error.status : null;
      const status = known ? error.status : authStatus ?? 500;
      if (status >= 500) (dependencies.log ?? logger).warn("Transcription credential request failed", { operation, status });
      return res.status(status).json({ error: known ? error.message : authStatus ? "Transcription credential access denied" : "Transcription credential request failed" });
    } finally { key?.fill(0); }
  };
}

const options = { cors: true, maxInstances: 3, concurrency: 10, timeoutSeconds: 30, serviceAccount: SERVICE_ACCOUNT };
const cmsListTranscriptionCredentials = cmsOnRequest(options, createCredentialHandler("list"));
const cmsSaveTranscriptionCredential = cmsOnRequest({ ...options, secrets: [KEY] }, createCredentialHandler("save"));
const cmsDisconnectTranscriptionCredential = cmsOnRequest(options, createCredentialHandler("disconnect"));
module.exports = { createCredentialHandler, cmsListTranscriptionCredentials, cmsSaveTranscriptionCredential, cmsDisconnectTranscriptionCredential };
