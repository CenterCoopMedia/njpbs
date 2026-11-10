"use strict";
const { withCmsEdge } = require("./lib/cms-edge");
const { readPairCurrentCode } = require("./lib/pair-current-code-source");
const { parsePairCodeRequest } = require("./lib/current-public-code-v2");

// Explicit installer hook. Its production mount is separately default off.
// Uses the existing private server channel; a browser cannot mint its secret.
function createPairCurrentCodeHandler({ firestore, readers, now = Date.now, edge } = {}) {
  if (!firestore) throw new Error("Pair current CODE reader is unbound");
  const deployedReaders = readers === undefined ? undefined : structuredClone(readers);
  return withCmsEdge(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (req.method !== "POST" || req.headers?.origin || !req.is?.("application/json") ||
          Buffer.byteLength(JSON.stringify(req.body ?? null)) > 8192) return res.status(400).json({ error: "Private pair CODE request refused" });
      const request = parsePairCodeRequest(req.body);
      const read = request.mode.startsWith("current-editorial") ? require("./lib/pair-current-editorial-source").readPairCurrentEditorial : readPairCurrentCode;
      return res.status(200).json(await read({ firestore, request, now, deployedReaders }));
    } catch (error) {
      if (req.body?.mode?.startsWith?.("current-editorial")) {
        const pending = error?.code === "pair_editorial_context_refreshing";
        return res.status(pending ? 503 : 409).json({ error: "Private paired editorial context unavailable",
          ...(pending ? { code: "pair_editorial_context_refreshing" } : {}) });
      }
      return res.status(503).json({ error: "Private pair CODE unavailable" });
    }
  }, edge);
}
module.exports = { createPairCurrentCodeHandler };
