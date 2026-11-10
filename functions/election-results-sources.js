"use strict";
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { COLLECTION, parseRequest, contentPrincipal, mutateConnection, view } = require("./lib/election-source-connections");
const { publiclyVisible } = require("./lib/public-video-references");
const { connectionId, publicBlock } = require("./lib/election-source-refresh");
const { readRoster } = require("./lib/election-source-http");
const { pollConnections } = require("./lib/election-source-poller");
const { logUnexpected } = require("./lib/election-source-log");
const { rehearsalRoster } = require("./lib/election-source-rehearsal");
function createElectionSourcesHandler({ firestore = db, now = () => new Date().toISOString(), fetchImpl = fetch } = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
    try {
      validateBoundedJsonRequest(req, 128 * 1024);
      const actor = await requirePrincipal(req, { cacheRevocation: false });
      const request = parseRequest(req.body);
      if (request.action !== "get") {
        const roster = request.action === "connect" ? request.config?.rehearsal === true
          ? rehearsalRoster() : await readRoster({ fetchImpl }) : undefined;
        return res.status(200).json({ success: true, ...await mutateConnection({ firestore, actor, request, roster, now: now() }) });
      }
      const result = await firestore.runTransaction(async transaction => {
        const document = (await transaction.get(firestore.doc(`${request.collection}/${request.documentId}`))).data();
        if (!document || document.deleted) throw Object.assign(new Error("This Page/Post is unavailable."), { status: 404 });
        const principal = await contentPrincipal({ firestore, transaction, actor, collection: request.collection,
          documentId: request.documentId, document, publishing: false });
        const { can } = require("./lib/rbac");
        const { contentResource } = require("./lib/content-authorization");
        const record = (await transaction.get(firestore.doc(`${COLLECTION}/${connectionId(request.collection, request.documentId, request.blockId)}`))).data();
        return { connection: view(record), documentVersion: document.version, publicData: publicBlock(document, request.blockId)?.data ?? null, canConnect: publiclyVisible(document) && !!publicBlock(document, request.blockId), canManage: can(principal, "content.publish", contentResource({
          collection: request.collection, documentId: request.documentId, stored: document })) };
      });
      if (request.includeRoster) {
        try { result.roster = await readRoster({ fetchImpl }); }
        catch { result.roster = null; result.rosterError = "The public candidate roster is unavailable. Existing public values are retained."; }
      }
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : error.name === "ElectionSourceError" ? 400 : 500;
      if (status >= 500) logUnexpected(error, "endpoint");
      return res.status(status).json({ error: status >= 500 ? "Election connections are unavailable. Try again." : error.message });
    }
  };
}
const onElectionResultsSourcePoll = onSchedule({ schedule: "0 8,20 * * *", timeZone: "America/New_York", region: "us-central1",
  timeoutSeconds: 180, maxInstances: 1, concurrency: 1, memory: "256MiB" }, async () => {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  await pollConnections({ firestore: db });
});
module.exports = { createElectionSourcesHandler, onElectionResultsSourcePoll,
  cmsElectionResultsSources: cmsOnRequest({ cors: true, timeoutSeconds: 60 }, createElectionSourcesHandler()) };
