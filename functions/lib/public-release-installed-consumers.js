"use strict";
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const p = require("./public-release-pair");

// Static deployment-source evidence only. No caller supplies paths, flags,
// hashes or a revision. The operator also checks provider source identities
// and the current deployment receipt; this response alone grants no action.
// Literal, never-invoked loaders also declare these file dependencies to the
// existing selective Functions deployment graph. A source hash must not stay
// on an old archive when one of the source files it fingerprints changes.
const SOURCE_MODULES = Object.freeze({
  "public-content.js": () => require("../public-content"),
  "save.js": () => require("../save"),
  "lifecycle-transition.js": () => require("../lifecycle-transition"),
  "scheduled-publish.js": () => require("../scheduled-publish"),
  "lib/public-release-installed-consumers.js": () => require("./public-release-installed-consumers"),
  "lib/public-release-bootstrap-admission.js": () => require("./public-release-bootstrap-admission"),
  "lib/public-release-producer.js": () => require("./public-release-producer"),
  "lib/public-release-admission.js": () => require("./public-release-admission"),
  "lib/public-release-family-admission.js": () => require("./public-release-family-admission"),
  "lib/no-build-content-publication.js": () => require("./no-build-content-publication"),
  "lib/public-release-serving.js": () => require("./public-release-serving"),
  "lib/public-release-serving-replay.js": () => require("./public-release-serving-replay"),
  "lib/public-release-pair.js": () => require("./public-release-pair"),
  "lib/public-release-source-body.js": () => require("./public-release-source-body"),
  "lib/no-build-page-render-context.js": () => require("./no-build-page-render-context"),
  "lib/no-build-record-source.js": () => require("./no-build-record-source"),
  "lib/no-build-page-source.js": () => require("./no-build-page-source"),
  "lib/no-build-page-serving.js": () => require("./no-build-page-serving"),
  "lib/no-build-page-context-decision.js": () => require("./no-build-page-context-decision"),
  "lib/no-build-page-schedule-reader.js": () => require("./no-build-page-schedule-reader"),
  "lib/public-release-page-schedule-code.js": () => require("./public-release-page-schedule-code"),
  "lib/publication-recovery.js": () => require("./publication-recovery"),
  "lib/no-build-page-recovery.js": () => require("./no-build-page-recovery"),
  "lib/public-release-media-fence.js": () => require("./public-release-media-fence"),
});
const INSTALLED_CONSUMER_FILES = Object.freeze(Object.keys(SOURCE_MODULES));
const FLAGS = Object.freeze(["PUBLIC_RELEASE_READERS_ENABLED", "PUBLIC_RELEASE_COMPOSED_READERS_ENABLED"]);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function installedConsumerSourceFiles(read = file => readFileSync(resolve(__dirname, "..", file))) {
  let total = 0;
  return INSTALLED_CONSUMER_FILES.map(path => {
    const bytes = read(path);
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 2 * 1024 * 1024 ||
        (total += bytes.length) > 8 * 1024 * 1024) refuse();
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}
function installedPublicReleaseConsumers({ nonce, environment = process.env, read } = {}) {
  if (!/^[a-f0-9]{64}$/.test(nonce ?? "") || environment.PUBLIC_RELEASE_READERS_ENABLED !== "true" ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(environment.K_REVISION ?? "")) refuse();
  const files = installedConsumerSourceFiles(read);
  return p.freeze({ schemaVersion: 2, kind: "public-release-installed-consumers", nonce,
    revision: environment.K_REVISION, files, sourceDigest: p.publicReleaseDigest(files),
    // config-input: PUBLIC_RELEASE_COMPOSED_READERS_ENABLED, PUBLIC_RELEASE_READERS_ENABLED
    flags: Object.fromEntries(FLAGS.map(name => [name, environment[name] === "true"])) });
}
module.exports = { INSTALLED_CONSUMER_FILES, FLAGS, installedConsumerSourceFiles, installedPublicReleaseConsumers };
