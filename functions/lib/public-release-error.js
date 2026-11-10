"use strict";

// Only fixed operator-owned text belongs to this error. Provider and SDK errors
// keep their own types and must not pass through the CLI's message boundary.
class PreparedPublicReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreparedPublicReleaseError";
  }
}

module.exports = { PreparedPublicReleaseError };
