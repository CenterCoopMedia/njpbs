"use strict";

const { publicPageDefinition } = require("./public-page-contract");

// Deployment-safe mirror; service-composition.test.ts pins it to the shared model.
function serviceCompositionError(pageId, version) {
  if (version === undefined) return null;
  if (version !== 1) return "The service composition version is invalid.";
  if (publicPageDefinition(pageId)?.family !== "service") return "Only service pages can use a service composition.";
  return null;
}

module.exports = { serviceCompositionError };
