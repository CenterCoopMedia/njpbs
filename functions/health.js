"use strict";

const { onRequest } = require("firebase-functions/v2/https");

// Minimal liveness endpoint. Later packages add the real function surface.
const health = onRequest((req, res) => {
  res.status(200).json({ status: "ok" });
});

module.exports = { health };
