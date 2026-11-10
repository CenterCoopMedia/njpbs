"use strict";

const { defineSecret } = require("firebase-functions/params");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { db } = require("./lib/firebase");
const { publicationTarget } = require("./lib/publication-target");
const { recheckPublication } = require("./lib/publication-recheck");

const development = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
const accessId = development ? defineSecret("CMS_DEV_ACCESS_CLIENT_ID") : null;
const accessSecret = development ? defineSecret("CMS_DEV_ACCESS_CLIENT_SECRET") : null;
const cachePurgeToken = defineSecret("CMS_MEDIA_CACHE_PURGE_TOKEN");
const readback = () => ({ target: publicationTarget(development ? "development" : "production"),
  headers: development ? { "cf-access-client-id": accessId.value(), "cf-access-client-secret": accessSecret.value() } : {} });

function createCmsRecheckPublicationHandler({ firestore = db, requirePrincipalFn = requirePrincipal,
  readbackFn = readback, ...network } = {}) {
  return async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try {
      const actor = await requirePrincipalFn(req);
      if (actor.emailVerified !== true) { res.status(403).json({ error: "A verified staff identity is required." }); return; }
      res.status(200).json(await recheckPublication({ firestore, actor, queueId: req.body?.queueId,
        source: req.ip ?? null, ...readbackFn(), ...network }));
    } catch (error) {
      // Public network errors never expose URLs, headers or provider bodies.
      res.status(error.status ?? 500).json({ error: error.status ? error.message : "Publication could not be checked. Try again." });
    }
  };
}

const cmsRecheckPublication = cmsOnRequest({ cors: true, timeoutSeconds: 60, minInstances: 0, maxInstances: 2,
  secrets: development ? [accessId, accessSecret] : [cachePurgeToken] }, createCmsRecheckPublicationHandler());

module.exports = { cmsRecheckPublication, createCmsRecheckPublicationHandler };
