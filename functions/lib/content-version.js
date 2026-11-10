"use strict";

const { isDeepStrictEqual } = require("node:util");
const { SERVER_MANAGED_CONTENT_FIELDS } = require("./content-document-contract");

const ignored = new Set([
  ...SERVER_MANAGED_CONTENT_FIELDS.filter(field => !["slug", "unassignedDraft"].includes(field)),
  "status", "publishAt", "scheduledPublishFailure",
]);

function contentVersion(document) {
  const candidate = document?.contentVersion;
  const value = Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : document?.version;
  return Number.isSafeInteger(value) && value >= 1 ? value : 0;
}

// Editorial versions count content changes. Transaction versions still guard
// every write, including assignment and workflow changes.
function authoredContent(document) {
  return Object.fromEntries(Object.entries(document ?? {}).filter(
    ([key, value]) => !ignored.has(key) && value !== undefined,
  ));
}

function hasContentChanges(before, after) {
  return !isDeepStrictEqual(authoredContent(before), authoredContent(after));
}

module.exports = { contentVersion, hasContentChanges };
