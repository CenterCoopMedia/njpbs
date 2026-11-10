"use strict";
const { PublicReleaseProtocolError } = require("./public-release-pair");

// First-install qualification admission belongs to the native SDK operator.
// Shared Worker codecs retain their original refusal of this path.
async function assertInitialControlCaptureInTransaction() { throw new PublicReleaseProtocolError(); }
module.exports = { assertInitialControlCaptureInTransaction };
