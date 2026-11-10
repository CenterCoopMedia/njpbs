"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const view = require("./public-release-pair-view");
const proofs = require("./public-release-pair-namespace-proof");
const PAIR_CONTENT_FEED_NAMESPACE = "/api/v1/content/";
const PAIR_CONTENT_FEED_INDEX = "/api/v1/content.json";
const MIME = "application/json; charset=utf-8", PAGE_SIZE = 20;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse() { throw new work.PairExecutionError("byte-mismatch"); }
function member(value) {
  protocol.exact(value, ["path", "mime", "size", "sha256"]);
  if (!view.isPrivatePairArtifactPath(value.path) || value.mime !== MIME || !protocol.digest(value.sha256) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > view.BODY_BYTES_LIMIT) refuse();
  return Object.freeze({ path: value.path, mime: MIME, size: value.size, sha256: value.sha256 });
}
function isPublicReleasePairContentFeedPagePath(value) {
  if (typeof value !== "string") return false;
  const matched = /^\/api\/v1\/content\/([1-9][0-9]*)\.json$/.exec(value);
  return Boolean(matched && matched[0] === value && Number.isSafeInteger(Number(matched[1])));
}
function members(value) {
  if (!Array.isArray(value) || value.length > view.VIEW_OUTPUT_LIMIT) refuse();
  let previous = "", total = 0;
  const numbers = new Set();
  const rows = value.map(raw => {
    const row = member(raw), number = /^\/api\/v1\/content\/([1-9][0-9]*)\.json$/.exec(row.path)?.[1];
    if (!isPublicReleasePairContentFeedPagePath(row.path) || !number || Number(number) > value.length ||
        view.comparePrivatePairArtifactPaths(previous, row.path) >= 0) refuse();
    previous = row.path; numbers.add(Number(number)); total += row.size;
    return row;
  });
  if (numbers.size !== rows.length || total > view.VIEW_TOTAL_BYTES_LIMIT) refuse();
  return Object.freeze(rows);
}
function parsePublicReleasePairContentFeedNamespace(value, rawPair, rawIdentity, expectedCursor) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  protocol.exact(value, ["schemaVersion", "kind", "namespace", "pairDigest", "inputManifestDigest", "cursor", "index", "members"]);
  const cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-content-feed-namespace" || value.namespace !== PAIR_CONTENT_FEED_NAMESPACE ||
      value.pairDigest !== protocol.publicReleaseDigest(pair) || value.inputManifestDigest !== identity.inputManifestDigest ||
      expectedCursor && protocol.publicReleaseDigest(cursor) !== protocol.publicReleaseDigest(view.parsePublicReleasePairViewCursor(expectedCursor, identity))) refuse();
  protocol.exact(value.index, ["path", "mime", "size", "sha256", "pageCount"]);
  const index = member({ path: value.index.path, mime: value.index.mime, size: value.index.size, sha256: value.index.sha256 });
  const rows = members(value.members);
  if (index.path !== PAIR_CONTENT_FEED_INDEX || value.index.pageCount !== rows.length) refuse();
  return protocol.freeze({ schemaVersion: 1, kind: "pair-content-feed-namespace", namespace: PAIR_CONTENT_FEED_NAMESPACE,
    pairDigest: value.pairDigest, inputManifestDigest: identity.inputManifestDigest,
    cursor: { baselineDigest: cursor.baselineDigest, sequence: cursor.sequence, lastDigest: cursor.lastDigest },
    index: { ...index, pageCount: rows.length }, members: rows });
}
function publicReleasePairContentFeedNamespaceRootDigest(value) { return hash(members(value)); }
function publicReleasePairContentFeedNamespaceManifestDigest(value, pair, identity, cursor) {
  return hash(parsePublicReleasePairContentFeedNamespace(value, pair, identity, cursor));
}
function json(bytes, row) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== row.size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) refuse();
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return refuse(); }
}
function origin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.href !== value) refuse();
    return url;
  } catch { return refuse(); }
}
/** The actual existing index has pages[], never a synthetic totalPages field. */
function assertPublicReleasePairContentFeedIndex(bytes, manifest) {
  const value = json(bytes, manifest.index);
  protocol.exact(value, ["apiVersion", "title", "homeUrl", "feedUrl", "rssUrl", "pageSize", "totalItems", "pages"]);
  const home = origin(value.homeUrl), url = path => new URL(path, home).href;
  if (value.apiVersion !== 1 || value.title !== "NJ PBS released content" || value.pageSize !== PAGE_SIZE ||
      !Number.isSafeInteger(value.totalItems) || value.totalItems < 0 || !Array.isArray(value.pages) ||
      value.pages.length !== manifest.index.pageCount || value.pages.length !== manifest.members.length ||
      Math.ceil(value.totalItems / PAGE_SIZE) !== value.pages.length || value.feedUrl !== url(PAIR_CONTENT_FEED_INDEX) ||
      value.rssUrl !== url("/feeds/news.xml")) refuse();
  for (let index = 0; index < value.pages.length; index++) {
    const page = value.pages[index];
    protocol.exact(page, ["page", "url", "itemCount"]);
    if (page.page !== index + 1 || page.url !== url(`${PAIR_CONTENT_FEED_NAMESPACE}${index + 1}.json`) ||
        page.itemCount !== Math.min(PAGE_SIZE, value.totalItems - PAGE_SIZE * index)) refuse();
  }
  return protocol.freeze(value);
}
function findMember(rows, path) {
  let start = 0, end = rows.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2), order = view.comparePrivatePairArtifactPaths(rows[middle].path, path);
    if (order < 0) start = middle + 1; else end = middle;
  }
  return rows[start]?.path === path ? rows[start] : null;
}
function assertPublicReleasePairContentFeedPage(bytes, path, manifest, index) {
  const row = findMember(manifest.members, path);
  if (!row) refuse();
  const value = json(bytes, row), page = Number(path.slice(PAIR_CONTENT_FEED_NAMESPACE.length, -5));
  protocol.exact(value, ["apiVersion", "title", "indexUrl", "selfUrl", "previousUrl", "nextUrl", "page", "pageSize", "totalItems", "totalPages", "items"]);
  const home = origin(index.homeUrl), url = number => new URL(`${PAIR_CONTENT_FEED_NAMESPACE}${number}.json`, home).href;
  if (value.apiVersion !== 1 || value.title !== index.title || value.page !== page || value.pageSize !== PAGE_SIZE ||
      value.totalItems !== index.totalItems || value.totalPages !== manifest.members.length ||
      value.indexUrl !== index.feedUrl || value.selfUrl !== url(page) ||
      value.previousUrl !== (page === 1 ? null : url(page - 1)) || value.nextUrl !== (page === manifest.members.length ? null : url(page + 1)) ||
      !Array.isArray(value.items) || value.items.length !== index.pages[page - 1]?.itemCount) refuse();
  return protocol.freeze(value);
}
function publicReleasePairContentFeedNamespaceProofPath(pair, digest) {
  return proofs.publicReleasePairNamespaceProofPath(pair, digest, "content-feed");
}
function parsePublicReleasePairContentFeedNamespaceProof(value, pair, identity, claimDigest, viewManifestDigest) {
  return proofs.parsePublicReleasePairNamespaceProof(value, pair, identity, claimDigest, viewManifestDigest, "content-feed");
}
async function assertReadPublicReleasePairContentFeedNamespaceInTransaction(options) {
  const manifest = parsePublicReleasePairContentFeedNamespace(options.manifest, options.pair, options.identity, options.cursor);
  if (publicReleasePairContentFeedNamespaceRootDigest(manifest.members) !== options.namespaceRootDigest ||
      publicReleasePairContentFeedNamespaceManifestDigest(manifest, options.pair, options.identity, options.cursor) !== options.namespaceManifestDigest) refuse();
  return proofs.assertReadPublicReleasePairNamespaceInTransaction({ ...options, manifest, kind: "content-feed" });
}
module.exports = { publicReleasePairContentFeedNamespaceProofPath, parsePublicReleasePairContentFeedNamespaceProof, assertReadPublicReleasePairContentFeedNamespaceInTransaction, PAIR_CONTENT_FEED_NAMESPACE, PAIR_CONTENT_FEED_INDEX, isPublicReleasePairContentFeedPagePath, parsePublicReleasePairContentFeedNamespace,
  publicReleasePairContentFeedNamespaceRootDigest, publicReleasePairContentFeedNamespaceManifestDigest,
  assertPublicReleasePairContentFeedIndex, assertPublicReleasePairContentFeedPage };
