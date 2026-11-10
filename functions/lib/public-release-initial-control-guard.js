"use strict";
// Keep the native edge statically visible to the committed renderer graph.
// The package browser map supplies an explicit refusal in Worker bundles.
const { assertInitialControlCaptureInTransaction } = require("./public-release-bootstrap-control-source");
module.exports = { assertInitialControlCaptureInTransaction };
