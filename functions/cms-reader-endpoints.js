"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("./lib/firebase");
const { cmsEdgeOptions, withCmsEdge } = require("./lib/cms-edge");
const { createCmsReaderMount } = require("./cms-reader-mount");
const { createPairCurrentCodeHandler } = require("./pair-current-code");
const { readCmsReaderMountDescriptor } = require("./lib/cms-reader-mount-descriptor");

// Private server relay only. Keep the original CODE owner's authority checks.
function createCmsPairCurrentCodeMount({ firestore, environment = process.env, edge, now = Date.now } = {}) {
  return withCmsEdge(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (environment.CMS_READER_BRIDGE_ENABLED !== "true") return res.status(503).json({ error: "Private pair CODE unavailable" });
      if (req.method !== "POST" || req.headers?.origin || !req.is?.("application/json") ||
          Buffer.byteLength(JSON.stringify(req.body ?? null)) > 8192) {
        return res.status(400).json({ error: "Private pair CODE request refused" });
      }
      const descriptor = await readCmsReaderMountDescriptor({ firestore, environment });
      return await createPairCurrentCodeHandler({ firestore, readers: descriptor.readers, edge, now })(req, res);
    } catch {
      if (!res.headersSent) res.status(503).json({ error: "Private pair CODE unavailable" });
    }
  }, edge);
}

module.exports = {
  createCmsPairCurrentCodeMount,
  cmsReaderV1: onRequest(cmsEdgeOptions({ invoker: "public" }), createCmsReaderMount({ firestore: db, version: 1 })),
  cmsReaderV2: onRequest(cmsEdgeOptions({ invoker: "public" }), createCmsReaderMount({ firestore: db, version: 2 })),
  cmsReadPairCurrentCodeV2: onRequest(cmsEdgeOptions({ invoker: "public" }), createCmsPairCurrentCodeMount({ firestore: db })),
};
