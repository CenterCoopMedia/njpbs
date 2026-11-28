"use strict";

const { createHash } = require("node:crypto");

// Usage analytics keys people and markers by this digest. Permission refusal logs use the same
// digest of a uid, so a refusal can be matched to that person's usage rows without the uid.
const usageHash = value => createHash("sha256").update(value).digest("hex");

module.exports = { usageHash };
