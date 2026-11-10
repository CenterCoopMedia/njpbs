"use strict";

// Mirrors CONTENT_STATUSES in packages/content-core/src/content-model.ts. Keep
// this dependency-free so the site parity test can load the Functions allowlist
// without importing the Firebase runtime.
const CONTENT_STATUSES = new Set([
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "archived",
]);

module.exports = { CONTENT_STATUSES };
