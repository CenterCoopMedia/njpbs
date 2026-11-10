import { createHash } from "node:crypto";
import type { PairCodePack } from "./public-release-pair-code-pack";
export const PAIR_CONTENT_FEED_NAMESPACE = "/api/v1/content/";
export const PAIR_CONTENT_FEED_INDEX = "/api/v1/content.json";
export const PAIR_CONTENT_FEED_AUTHORITY_FILE = "pair-content-feed-namespace.json";
export const PAIR_CONTENT_FEED_AUTHORITY_PACK_PATH = "/_pair-compiled/pair-content-feed-namespace.json";
export type PairContentFeedNamespaceAuthority = Readonly<{ schemaVersion: 1; kind: "pair-content-feed-namespace-authority";
  namespace: "/api/v1/content/"; family: "contentFeedPages"; commitSha: string; indexPath: "/api/v1/content.json" }>;
export class PairContentFeedAuthorityError extends Error {
  constructor(readonly code: "content-feed-authority-missing" | "content-feed-authority-mismatch" | "content-feed-pages-incomplete" | "content-feed-index-mismatch") {
    super(code); this.name = "PairContentFeedAuthorityError";
  }
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fail(code: PairContentFeedAuthorityError["code"]): never { throw new PairContentFeedAuthorityError(code); }
export function publicReleasePairContentFeedAuthorityBytes(commitSha: string) {
  if (!/^[a-f0-9]{40}$/.test(commitSha)) fail("content-feed-authority-mismatch");
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, kind: "pair-content-feed-namespace-authority", namespace: PAIR_CONTENT_FEED_NAMESPACE,
    family: "contentFeedPages", commitSha, indexPath: PAIR_CONTENT_FEED_INDEX }) + "\n");
}
/** Only this sealed numbered namespace can grow or shrink. The index remains
 * an exact dynamic path, and its real bytes must agree with the page roster. */
export function assertPublicReleasePairContentFeedAuthority(manifest: PairCodePack, expected: { commitSha: string; codeAssetManifestDigest?: string }): PairContentFeedNamespaceAuthority {
  const bytes = publicReleasePairContentFeedAuthorityBytes(expected.commitSha);
  const marker = manifest.members.find(member => member.path === PAIR_CONTENT_FEED_AUTHORITY_PACK_PATH);
  if (!marker) fail("content-feed-authority-missing");
  const sealed = [...manifest.members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(member => ({
    path: member.path, mime: member.mime, size: member.size, sha256: member.sha256, family: member.family, source: member.source, dynamic: member.dynamic }));
  if (manifest.commitSha !== expected.commitSha || expected.codeAssetManifestDigest !== undefined && manifest.codeAssetManifestDigest !== expected.codeAssetManifestDigest ||
      marker.family !== "compiledGraph" || marker.source !== "compiled" || marker.dynamic || marker.size !== bytes.length || marker.sha256 !== hash(bytes) ||
      hash(JSON.stringify(sealed)) !== manifest.codeAssetManifestDigest) fail("content-feed-authority-mismatch");
  const index = manifest.members.find(member => member.path === PAIR_CONTENT_FEED_INDEX);
  if (!index || index.family !== "feed" || index.source !== "aggregate" || !index.dynamic) fail("content-feed-pages-incomplete");
  const selected = manifest.members.filter(member => member.path.startsWith(PAIR_CONTENT_FEED_NAMESPACE));
  const pages = selected.map(member => {
    const match = /^\/api\/v1\/content\/([1-9][0-9]*)\.json$/.exec(member.path);
    if (!match || member.family !== "contentFeedPages" || member.source !== "aggregate" || !member.dynamic || member.mime !== "application/json; charset=utf-8") fail("content-feed-pages-incomplete");
    return Number(match[1]);
  }).sort((a, b) => a - b);
  if (pages.some((page, index) => page !== index + 1)) fail("content-feed-pages-incomplete");
  return Object.freeze({ schemaVersion: 1, kind: "pair-content-feed-namespace-authority", namespace: PAIR_CONTENT_FEED_NAMESPACE,
    family: "contentFeedPages", commitSha: expected.commitSha, indexPath: PAIR_CONTENT_FEED_INDEX });
}
export function assertPublicReleasePairContentFeedIndex(bytes: Uint8Array, manifest: PairCodePack) {
  const member = manifest.members.find(member => member.path === PAIR_CONTENT_FEED_INDEX);
  if (!member || member.size !== bytes.length || member.sha256 !== hash(bytes)) fail("content-feed-index-mismatch");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("content-feed-index-mismatch"); }
  const pages = manifest.members.filter(member => member.path.startsWith(PAIR_CONTENT_FEED_NAMESPACE));
  if (!value || value.apiVersion !== 1 || !Array.isArray(value.pages) || value.pages.length !== pages.length) fail("content-feed-index-mismatch");
  value.pages.forEach((page: { page: number; url: string }, index: number) => {
    if (page?.page !== index + 1 || typeof page.url !== "string") fail("content-feed-index-mismatch");
    let url;
    try { url = new URL(page.url); } catch { fail("content-feed-index-mismatch"); }
    if (url.pathname !== `${PAIR_CONTENT_FEED_NAMESPACE}${index + 1}.json` || url.search || url.hash) fail("content-feed-index-mismatch");
  });
}
