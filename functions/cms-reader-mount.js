"use strict";
const { createCmsReaderInstallation } = require("./cms-reader-installation");
const { readCmsReaderMountDescriptor } = require("./lib/cms-reader-mount-descriptor");
const { withCmsEdge } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { can } = require("./lib/rbac");
const { sessionRefusalFields, SESSION_EXPIRED_CODE } = require("./lib/session-refusal");

// Retained reader construction; native registrations live in cms-reader-endpoints.
function createCmsReaderMount({ firestore, version, environment = process.env, edge,
  authenticate = (req, options = {}) => requirePrincipal(req, { ...options, checkRevoked: true, cacheRevocation: false }), now = Date.now } = {}) {
  if (![1, 2].includes(version) || !firestore) throw new Error("CMS reader mount unavailable");
  return withCmsEdge(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (environment.CMS_READER_BRIDGE_ENABLED !== "true") return res.status(503).json({ error: "CMS reader unavailable" });
      if (req.method !== "POST" || !req.is?.("application/json")) return res.status(400).json({ error: "CMS reader request refused" });
      const actor = await authenticate(req);
      if (typeof actor?.uid !== "string" || !can(actor.principal, "guide.view")) return res.status(403).json({ error: "CMS reader unavailable" });
      const descriptor = await readCmsReaderMountDescriptor({ firestore, environment });
      if (req.body?.action === "describe") {
        if (req.headers?.origin || req.body.version !== version || Object.keys(req.body).sort().join(",") !== "action,version") {
          return res.status(400).json({ error: "CMS reader request refused" });
        }
        // Digests only. No arbitrary receipt, provider body or secret is exposed.
        const cmsApiVersion = descriptor.readers.cmsApi.providerIdentities.versionId;
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(cmsApiVersion ?? "")) {
          return res.status(503).json({ error: "CMS reader unavailable" });
        }
        return res.status(200).json({ schemaVersion: 2, version, operationId: descriptor.operationId,
          functionsReader: descriptor.identities.functions, cmsApiReader: descriptor.identities.cmsApi, cmsApiVersion });
      }
      return await createCmsReaderInstallation({ firestore, readers: descriptor.readers, version, authenticate, edge, now }).reader(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (error?.status === 401 && error.code === SESSION_EXPIRED_CODE) {
        return res.status(401).json({ error: "CMS reader unavailable", code: SESSION_EXPIRED_CODE, ...sessionRefusalFields(error) });
      }
      res.status(503).json({ error: "CMS reader unavailable" });
    }
  }, edge);
}
module.exports = { createCmsReaderMount };
