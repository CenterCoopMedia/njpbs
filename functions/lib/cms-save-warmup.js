"use strict";

// cmsOnRequest verifies the origin secret before this wrapper runs. A warmup
// never enters the staff save handler, so it performs no auth-store or audit work.
function withCmsSaveWarmup(handler) {
  return async (req, res) => {
    if (req.method === "POST" && req.body?.mode === "warm") {
      res.set("Cache-Control", "private, no-store");
      if (Object.keys(req.body).length !== 1) {
        res.status(400).json({ error: "Warmup accepts only its mode" });
        return;
      }
      res.status(200).json({ success: true, warmed: true });
      return;
    }
    await handler(req, res);
  };
}

module.exports = { withCmsSaveWarmup };
