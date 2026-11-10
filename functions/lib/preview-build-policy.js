"use strict";

const PREVIEW_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const PREVIEW_BUILD_TIMEOUT_ERROR =
  "Preview build did not finish within 45 minutes";

module.exports = {
  PREVIEW_BUILD_TIMEOUT_MS,
  PREVIEW_BUILD_TIMEOUT_ERROR,
};
