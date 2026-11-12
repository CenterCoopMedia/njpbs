"use strict";

const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { PublicReleaseProtocolError, parsePublicReleasePair, parsePublicReleasePairReference,
  publicReleasePairReference, publicReleaseDigest, exact, digest, positive, freeze } = require("./public-release-pair");
const { assertPrivatePairResources } = require("./public-release-pair-execution");

const VIEW_PAGE_OUTPUT_LIMIT = 256;
const VIEW_PAGE_BYTES_LIMIT = 512 * 1024;
const VIEW_ROOT_BYTES_LIMIT = 256 * 1024;
const VIEW_OUTPUT_LIMIT = 100_000;
const VIEW_TOTAL_BYTES_LIMIT = 100 * 1024 ** 3;
const BODY_BYTES_LIMIT = 16 * 1024 * 1024;
const HEADER_NAMES = new Set(["content-type", "cache-control", "location", "content-security-policy",
  "content-security-policy-report-only", "permissions-policy", "referrer-policy", "strict-transport-security",
  "x-content-type-options", "x-frame-options", "x-robots-tag", "access-control-allow-origin", "access-control-expose-headers",
  "content-language", "content-disposition", "link", "retry-after",
  "x-njpbs-admission-revision", "x-njpbs-asset-storage", "x-njpbs-background-assets", "x-njpbs-background-context-sha256",
  "x-njpbs-background-renderer-sha", "x-njpbs-background-state", "x-njpbs-code-context-sha256", "x-njpbs-code-generation",
  "x-njpbs-code-post-frame-sha256", "x-njpbs-code-receipt-sha256", "x-njpbs-content-source", "x-njpbs-context-sha256",
  "x-njpbs-dataset-figures-sha256", "x-njpbs-durable-withdrawal-operation", "x-njpbs-home-refresh-revision",
  "x-njpbs-html-sha256", "x-njpbs-input-sha256", "x-njpbs-input-source-sha256", "x-njpbs-page-path",
  "x-njpbs-public-context-revision", "x-njpbs-publication-operation", "x-njpbs-publication-origin", "x-njpbs-publication-refresh",
  "x-njpbs-raw-schedule-sha256", "x-njpbs-record-family", "x-njpbs-record-id", "x-njpbs-record-generation",
  "x-njpbs-record-source-sha256", "x-njpbs-record-visible", "x-njpbs-renderer-sha", "x-njpbs-schedule-exported-at",
  "x-njpbs-schedule-pdf-sha256", "x-njpbs-schedule-projection-sha256", "x-njpbs-schedule-receipt-sha256",
  "x-njpbs-snapshot-sha256", "x-njpbs-source-version", "x-njpbs-withdrawal-revision"]);
function refuse() { throw new PublicReleaseProtocolError(); }
function same(left, right) { return publicReleaseDigest(left) === publicReleaseDigest(right); }
function bounded(value, limit) { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limit) refuse(); }
function privatePair(value) {
  const pair = parsePublicReleasePair(value);
  assertPrivatePairResources(pair);
  return pair;
}
function parseViewIdentity(value, pair) {
  pair = privatePair(pair);
  exact(value, ["schemaVersion", "pair", "kind", "sourceOperationId", "sourceVersion", "snapshotDigest", "contextSequence", "inputManifestDigest"]);
  const reference = parsePublicReleasePairReference(value.pair);
  if (value.schemaVersion !== 2 || !same(reference, publicReleasePairReference(pair)) ||
      !["accepted", "qualification", "recovery"].includes(value.kind) || !isPublicDeploymentIdentifier(value.sourceOperationId) ||
      !positive(value.sourceVersion) || !digest(value.snapshotDigest) || !digest(value.inputManifestDigest) ||
      !Number.isSafeInteger(value.contextSequence) || value.contextSequence < 0) refuse();
  return freeze({ ...value, pair: reference });
}
function publicReleasePairViewPrefix(pair, identity, claimDigest) {
  pair = privatePair(pair);
  identity = parseViewIdentity(identity, pair);
  if (!digest(claimDigest)) refuse();
  return `release-pairs/${pair.pairId}/${publicReleaseDigest(identity)}/claims/${claimDigest}/`;
}
function publicReleasePairViewObjectKey(pair, identity, claimDigest, bodyDigest) {
  if (!digest(bodyDigest)) refuse();
  return `${publicReleasePairViewPrefix(pair, identity, claimDigest)}objects/${bodyDigest}`;
}
function renderedPath(value) {
  return typeof value === "string" && value.length <= 1024 && /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(value) &&
    value.split("/").every(part => ![".", ".."].includes(part));
}
/** Exact private file paths; rendered route/redirect rules stay ASCII. */
function isPrivatePairArtifactPath(value) {
  if (typeof value !== "string" || value.length < 2 || !value.startsWith("/") || value.endsWith("/") ||
      value.normalize("NFC") !== value || new TextEncoder().encode(value).byteLength > 1024 ||
      /[\\%?#]/u.test(value) || value.includes("//") ||
      value.split("/").slice(1).some(part => part === "." || part === "..")) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x20 || code >= 0x7f && code <= 0x9f || code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
function comparePrivatePairArtifactPaths(a, b) {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}
function path(value) { return renderedPath(value) || isPrivatePairArtifactPath(value); }

function parseHeaders(value, status) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length > 64) refuse();
  const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [name, item] of entries) {
    if (!HEADER_NAMES.has(name) ||
        typeof item !== "string" || item.length > 4096 || /[\r\n\0]/.test(item)) refuse();
  }
  if (value["cache-control"] !== "no-store" || !value["content-type"] ||
      (status === 302 ? require("./content-link").contentLinkError({ contentLinkMode: "custom", contentLinkUrl: value.location }) !== null || value["x-robots-tag"] !== "noindex, nofollow" : status === 308 ? !renderedPath(value.location) : value.location !== undefined)) refuse();
  return Object.fromEntries(entries);
}
function parsePublicReleasePairViewOutput(value, pair, identity, claimDigest) {
  exact(value, ["path", "status", "headers", "bodyDigest", "bytes", "objectKey"]);
  if (!path(value.path) || ![200, 302, 308, 410].includes(value.status) || !digest(value.bodyDigest) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.status === 200 && value.bytes === 0 && !isPrivatePairArtifactPath(value.path) || value.bytes > BODY_BYTES_LIMIT ||
      value.objectKey !== publicReleasePairViewObjectKey(pair, identity, claimDigest, value.bodyDigest)) refuse();
  const headers = parseHeaders(value.headers, value.status);
  // Empty code/static files are valid. Rendered HTML and JSON must retain
  // their nonempty-body integrity check, including non-slash catalogue routes.
  if (value.status === 200 && value.bytes === 0 && ["text/html", "application/json"].includes(headers["content-type"].split(";", 1)[0].trim().toLowerCase())) refuse();
  if (headers["content-type"].split(";", 1)[0].trim().toLowerCase() === "text/html" && value.bytes > 4 * 1024 * 1024 ||
      [302, 308].includes(value.status) && (value.bytes !== 0 || headers.location === value.path) ||
      headers["x-njpbs-html-sha256"] !== undefined && headers["x-njpbs-html-sha256"] !== value.bodyDigest ||
      ["x-njpbs-renderer-sha", "x-njpbs-background-renderer-sha"].some(name =>
        headers[name] !== undefined && headers[name] !== pair.commitSha)) refuse();
  return freeze({ ...value, headers });
}
function parsePublicReleasePairViewPage(value, rawPair, rawIdentity, claimDigest) {
  const pair = privatePair(rawPair), identity = parseViewIdentity(rawIdentity, pair);
  exact(value, ["schemaVersion", "pairDigest", "taskId", "claimDigest", "index", "outputs"]);
  if (value.schemaVersion !== 2 || value.pairDigest !== publicReleaseDigest(pair) ||
      value.taskId !== publicReleaseDigest(identity) || value.claimDigest !== claimDigest || !digest(claimDigest) ||
      !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= 512 ||
      !Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > VIEW_PAGE_OUTPUT_LIMIT) refuse();
  const outputs = value.outputs.map(output => parsePublicReleasePairViewOutput(output, pair, identity, claimDigest));
  if (outputs.some((output, index) => index > 0 && comparePrivatePairArtifactPaths(outputs[index - 1].path, output.path) >= 0)) refuse();
  const parsed = freeze({ ...value, outputs });
  bounded(parsed, VIEW_PAGE_BYTES_LIMIT);
  return parsed;
}
function parsePublicReleasePairViewCursor(value, identity) {
  exact(value, ["baselineDigest", "sequence", "lastDigest"]);
  if (!digest(value.baselineDigest) || !digest(value.lastDigest) ||
      value.sequence !== identity.contextSequence ||
      value.sequence === 0 && value.lastDigest !== value.baselineDigest) refuse();
  return Object.freeze({ ...value });
}
function parsePublicReleasePairViewRoot(value, rawPair) {
  const pair = privatePair(rawPair);
  exact(value, ["schemaVersion", "kind", "pairDigest", "identity", "claimDigest", "cursor", "pages", "outputCount", "outputBytes",
    ...(Object.prototype.hasOwnProperty.call(value ?? {}, "namespaces") ? ["namespaces"] : []),
    ...(Object.prototype.hasOwnProperty.call(value ?? {}, "catalogImages") ? ["catalogImages"] : []),
    ...(Object.prototype.hasOwnProperty.call(value ?? {}, "composite") ? ["composite"] : [])]);
  const identity = parseViewIdentity(value.identity, pair);
  const cursor = parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 2 || value.kind !== "private-pair-view" || value.pairDigest !== publicReleaseDigest(pair) ||
      !digest(value.claimDigest) ||
      !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 512 ||
      !positive(value.outputCount) || value.outputCount > VIEW_OUTPUT_LIMIT ||
      !Number.isSafeInteger(value.outputBytes) || value.outputBytes < 0 || value.outputBytes > VIEW_TOTAL_BYTES_LIMIT) refuse();
  let count = 0, bytes = 0, previous = "";
  const pages = value.pages.map((page, index) => {
    exact(page, ["index", "digest", "count", "bytes", "firstPath", "lastPath"]);
    if (page.index !== index || !digest(page.digest) || !positive(page.count) || page.count > VIEW_PAGE_OUTPUT_LIMIT ||
        !Number.isSafeInteger(page.bytes) || page.bytes < 0 || page.bytes > page.count * BODY_BYTES_LIMIT ||
        !path(page.firstPath) || !path(page.lastPath) || comparePrivatePairArtifactPaths(page.firstPath, page.lastPath) > 0 || page.count > 1 && page.firstPath === page.lastPath ||
        comparePrivatePairArtifactPaths(page.firstPath, previous) <= 0 || page.count === 1 && page.firstPath !== page.lastPath) refuse();
    previous = page.lastPath;
    count += page.count; bytes += page.bytes;
    return { ...page };
  });
  if (count !== value.outputCount || bytes !== value.outputBytes) refuse();
  if (Object.prototype.hasOwnProperty.call(value, "namespaces")) {
    exact(value.namespaces, ["search", "contentFeed"]);
    for (const [name, link] of Object.entries(value.namespaces)) {
      exact(link, ["namespace", "namespaceRootDigest", "descriptor"]);
      exact(link.descriptor, ["digest", "key", "bytes"]);
      if (link.namespace !== (name === "search" ? "/pagefind/" : "/api/v1/content/") || !digest(link.namespaceRootDigest) ||
          !digest(link.descriptor.digest) || link.descriptor.key !== publicReleasePairViewObjectKey(pair, identity, value.claimDigest, link.descriptor.digest) ||
          !positive(link.descriptor.bytes) || link.descriptor.bytes > BODY_BYTES_LIMIT) refuse();
    }
  }
  for (const name of ["catalogImages", "composite"]) if (Object.prototype.hasOwnProperty.call(value, name)) {
    const link = value[name];
    exact(link, ["descriptor", "memberCount", "memberBytes"]);
    exact(link.descriptor, ["digest", "key", "bytes"]);
    if (!digest(link.descriptor.digest) || link.descriptor.key !== publicReleasePairViewObjectKey(pair, identity, value.claimDigest, link.descriptor.digest) ||
        !positive(link.descriptor.bytes) || link.descriptor.bytes > BODY_BYTES_LIMIT || !Number.isSafeInteger(link.memberCount) || link.memberCount < 0 ||
        link.memberCount > VIEW_OUTPUT_LIMIT || !Number.isSafeInteger(link.memberBytes) || link.memberBytes < 0 || link.memberBytes > VIEW_TOTAL_BYTES_LIMIT) refuse();
  }
  const parsed = freeze({ ...value, identity, cursor, pages });
  bounded(parsed, VIEW_ROOT_BYTES_LIMIT);
  return parsed;
}

module.exports = { VIEW_PAGE_OUTPUT_LIMIT, VIEW_PAGE_BYTES_LIMIT, VIEW_ROOT_BYTES_LIMIT, VIEW_OUTPUT_LIMIT,
  VIEW_TOTAL_BYTES_LIMIT, BODY_BYTES_LIMIT, isPrivatePairArtifactPath, comparePrivatePairArtifactPaths, parseViewIdentity, publicReleasePairViewPrefix,
  publicReleasePairViewObjectKey, parsePublicReleasePairViewOutput, parsePublicReleasePairViewPage,
  parsePublicReleasePairViewCursor, parsePublicReleasePairViewRoot };
