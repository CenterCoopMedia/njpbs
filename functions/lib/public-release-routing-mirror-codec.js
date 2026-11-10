"use strict";
const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const views = require("./public-release-pair-view");
const { readBoundedPairObject } = require("./public-release-view-read");
class RoutingMirrorError extends Error { constructor(code = "mirror-unavailable") { super(code); this.name = "RoutingMirrorError"; this.code = code; } }
const refuse = () => { throw new RoutingMirrorError(); };
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const prefix = pair => `public-release-routing/${pair.environment}/pairs/${p.publicReleaseDigest(pair)}/`;
const routePath = path => typeof path === "string" && /^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(path) && path.length <= 1024 &&
  path.split("/").every(part => ![".", ".."].includes(part));
function locator(value, pair) {
  p.exact(value, ["pairDigest", "identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const identity = views.parseViewIdentity(value.identity, pair);
  if (value.pairDigest !== p.publicReleaseDigest(pair) || !p.digest(value.claimDigest) || !p.digest(value.manifestDigest) ||
      !Number.isSafeInteger(value.manifestBytes) || value.manifestBytes < 1 || value.manifestBytes > views.VIEW_ROOT_BYTES_LIMIT) refuse();
  return { ...value, identity };
}
function parseCodeIndex(value, pair) {
  p.exact(value, ["schemaVersion", "pairDigest", "codeAssetManifestDigest", "view", "members"]);
  if (value.schemaVersion !== 1 || value.pairDigest !== p.publicReleaseDigest(pair) || value.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
      !Array.isArray(value.members) || !value.members.length || value.members.length > 100_000) refuse();
  const ref = locator(value.view, pair); let previous = "", total = 0;
  const members = value.members.map(member => {
    p.exact(member, ["path", "mime", "size", "sha256", "family", "source", "dynamic"]);
    if (!views.isPrivatePairArtifactPath(member.path) || views.comparePrivatePairArtifactPaths(previous, member.path) >= 0 ||
        !Number.isSafeInteger(member.size) || member.size < 0 || member.size > views.BODY_BYTES_LIMIT || !p.digest(member.sha256) ||
        typeof member.mime !== "string" || member.mime.length > 256 || /[\r\n]/.test(member.mime) || typeof member.family !== "string" ||
        !["compiled", "static", "aggregate"].includes(member.source) || typeof member.dynamic !== "boolean") refuse();
    previous = member.path; total += member.size;
    return { path: member.path, mime: member.mime, size: member.size, sha256: member.sha256,
      family: member.family, source: member.source, dynamic: member.dynamic };
  });
  if (total > views.VIEW_TOTAL_BYTES_LIMIT || hash(Buffer.from(JSON.stringify(members))) !== pair.codeAssetManifestDigest) refuse();
  return { ...value, view: ref, members };
}
function parseMirrorBody(value, pair) {
  p.exact(value, ["locator", "artifactPath", "bodyDigest", "bytes", "mime", "source", "verifiedSequence", "validUntil"]);
  const ref = locator(value.locator, pair);
  if (typeof value.artifactPath !== "string" || !(routePath(value.artifactPath) || views.isPrivatePairArtifactPath(value.artifactPath)) ||
      !p.digest(value.bodyDigest) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > views.BODY_BYTES_LIMIT ||
      typeof value.mime !== "string" || value.mime.length > 256 || /[\r\n]/.test(value.mime) ||
      !Number.isSafeInteger(value.verifiedSequence) || value.verifiedSequence < ref.identity.contextSequence ||
      !Number.isSafeInteger(value.validUntil) || value.validUntil < 1) refuse();
  if (value.source !== null) {
    p.exact(value.source, ["family", "id", "operationId", "sourceVersion", "snapshotDigest"]);
    if (!["page", "post", "record"].includes(value.source.family) || typeof value.source.id !== "string" ||
        typeof value.source.operationId !== "string" || !Number.isSafeInteger(value.source.sourceVersion) || value.source.sourceVersion < 1 ||
        !p.digest(value.source.snapshotDigest)) refuse();
  }
  return { ...value, locator: ref };
}
function parseNamespace(value, pair, now = Date.now()) {
  p.exact(value, ["schemaVersion", "pairDigest", "revision", "validUntil", "sourceDigest", "routes"]);
  if (value.schemaVersion !== 2 || value.pairDigest !== p.publicReleaseDigest(pair) || !p.digest(value.sourceDigest) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Number.isSafeInteger(value.validUntil) || value.validUntil <= now || !Array.isArray(value.routes) || value.routes.length > 100_000) refuse();
  let previous = "";
  const routes = value.routes.map(route => {
    p.exact(route, ["path", "state", "canonicalPath", "body"]);
    if (!routePath(route.path) || route.path <= previous || !routePath(route.canonicalPath) ||
        !["fallback", "gone", "redirect"].includes(route.state) || route.state === "redirect" && route.canonicalPath === route.path ||
        route.state !== "fallback" && route.body !== null) refuse();
    previous = route.path;
    const body = route.body === null ? null : parseMirrorBody(route.body, pair);
    if (body && body.verifiedSequence >= value.revision) refuse();
    return { ...route, body };
  });
  return { ...value, routes };
}
async function readJson(store, key, limit = 16 * 1024 * 1024) {
  return JSON.parse(Buffer.from(await readBoundedPairObject(store, key, limit)).toString("utf8"));
}
async function existingJson(store, key, limit) {
  const object = await store.get(key); if (!object) return null;
  if (!object.etag || typeof object.etag !== "string") { await object.body.cancel(); refuse(); }
  // The ETag and bytes must belong to the SAME GET. A second GET can race a
  // competing writer and attach a stale precondition to newer bytes.
  const bytes = await readBoundedPairObject({ get: async () => object }, key, limit ?? 16 * 1024 * 1024);
  return { etag: object.etag, value: JSON.parse(Buffer.from(bytes).toString("utf8")) };
}
async function writeJson(store, key, value, prior, immutable = false) {
  if (immutable && prior) { if (!same(prior.value, value)) refuse(); return prior; }
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > 16 * 1024 * 1024) refuse();
  const stored = await store.put(key, bytes, { onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: "*" },
    customMetadata: { schemaversion: String(value.schemaVersion), bodydigest: hash(bytes) } });
  if (!stored) refuse();
  const readback = await existingJson(store, key); if (!readback || !same(readback.value, value)) refuse();
  return readback;
}
module.exports = { RoutingMirrorError, same, hash, prefix, routePath, locator, parseCodeIndex, parseMirrorBody, parseNamespace,
  readJson, existingJson, writeJson };
