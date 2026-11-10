import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import codec from "../../functions/lib/public-release-pair-content-feed-namespace.js";
import views from "../../functions/lib/public-release-pair-view.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { createExternalContentStaticFeed, type ExternalContentManifest } from "../../site/src/lib/external-content-feed";
const pair = releasePair(), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fixture(count = 21) {
  const feed: ExternalContentManifest = { apiVersion: 1, title: "NJ PBS released content", homeUrl: "https://njpbs.org/",
    feedUrl: "https://njpbs.org/api/v1/content.json", rssUrl: "https://njpbs.org/feeds/news.xml", items: Array.from({ length: count }, (_, index) => ({
      id: `post:${index}`, type: "post", sourceId: `post-${index}`, sourceVersion: 1, url: `https://njpbs.org/posts/story-${index}/`, locale: "en",
      title: `Story ${index}`, summary: "Published summary", contentHtml: "<p>Released content</p>", publishedAt: "2026-10-28T04:00:00.000Z",
      modifiedAt: "2026-10-28T04:00:00.000Z", authors: [], categories: [], tags: [] })) };
  const output = createExternalContentStaticFeed(feed), indexBytes = encode(output.index);
  const files = new Map(output.pages.map(page => [`/api/v1/content/${page.page}.json`, encode(page)]));
  const manifest = { schemaVersion: 1, kind: "pair-content-feed-namespace", namespace: "/api/v1/content/", pairDigest: protocol.publicReleaseDigest(pair),
    inputManifestDigest: identity.inputManifestDigest, cursor: captured.cursor, index: { path: "/api/v1/content.json", mime: "application/json; charset=utf-8",
      size: indexBytes.length, sha256: sha(indexBytes), pageCount: output.pages.length }, members: [...files].map(([path, bytes]) => ({ path,
      mime: "application/json; charset=utf-8", size: bytes.length, sha256: sha(bytes) })).sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path)) };
  return { output, indexBytes, files, manifest };
}
it.each([0, 21, 201])("binds the actual existing %i-item index and every numbered page including UTF8/numeric order differences", count => {
  const value = fixture(count), manifest = codec.parsePublicReleasePairContentFeedNamespace(value.manifest, pair, identity, captured.cursor);
  const index = codec.assertPublicReleasePairContentFeedIndex(value.indexBytes, manifest);
  expect(index.pages.length).toBe(manifest.members.length);
  expect(manifest.index.pageCount).toBe(Math.ceil(count / 20));
  for (const [path, bytes] of value.files) expect(codec.assertPublicReleasePairContentFeedPage(bytes, path, manifest, index).page).toBe(Number(path.split("/").at(-1)!.slice(0, -5)));
  expect(codec.publicReleasePairContentFeedNamespaceRootDigest(manifest.members)).toBe(sha(JSON.stringify(manifest.members)));
  expect(codec.publicReleasePairContentFeedNamespaceManifestDigest(manifest, pair, identity)).toBe(sha(JSON.stringify(manifest)));
});
it.each(["missing-index", "gap", "leading-zero", "outside", "duplicate", "wrong-count", "wrong-cursor", "wrong-input", "unknown-namespace"])("refuses %s namespace authority", mode => {
  const value = fixture();
  if (mode === "missing-index") Object.assign(value.manifest, { index: null });
  if (mode === "gap") value.manifest.members[1].path = "/api/v1/content/3.json";
  if (mode === "leading-zero") value.manifest.members[0].path = "/api/v1/content/01.json";
  if (mode === "outside") value.manifest.members[1].path = "/other/2.json";
  if (mode === "duplicate") value.manifest.members[1] = value.manifest.members[0];
  if (mode === "wrong-count") value.manifest.index.pageCount = 3;
  if (mode === "wrong-cursor") value.manifest.cursor = { ...value.manifest.cursor, lastDigest: "f".repeat(64) };
  if (mode === "wrong-input") value.manifest.inputManifestDigest = "f".repeat(64);
  if (mode === "unknown-namespace") value.manifest.namespace = "/api/";
  expect(() => codec.parsePublicReleasePairContentFeedNamespace(value.manifest, pair, identity, captured.cursor)).toThrow();
});
it.each(["count", "page-url", "item-count", "invented-totalPages", "wrong-feed-url"])("refuses an actual index with internally rehashed %s mismatch", mode => {
  const value = fixture(), index = structuredClone(value.output.index);
  if (mode === "count") index.pages.pop();
  if (mode === "page-url") index.pages[0].url = "https://njpbs.org/api/v1/content/2.json";
  if (mode === "item-count") index.pages[0].itemCount = 19;
  if (mode === "invented-totalPages") Object.assign(index, { totalPages: 2 });
  if (mode === "wrong-feed-url") index.feedUrl = "https://njpbs.org/api/v1/content.json?cursor=other";
  const bytes = encode(index);
  value.manifest.index.sha256 = sha(bytes); value.manifest.index.size = bytes.length;
  const manifest = codec.parsePublicReleasePairContentFeedNamespace(value.manifest, pair, identity);
  expect(() => codec.assertPublicReleasePairContentFeedIndex(bytes, manifest)).toThrow();
});
it("refuses a numbered page whose rehashed total/link fields disagree with the same-cursor actual index", () => {
  const value = fixture(), path = "/api/v1/content/1.json", page = structuredClone(value.output.pages[0]);
  page.totalPages = 3;
  const bytes = encode(page), row = value.manifest.members.find(row => row.path === path)!;
  row.sha256 = sha(bytes); row.size = bytes.length;
  const manifest = codec.parsePublicReleasePairContentFeedNamespace(value.manifest, pair, identity);
  const index = codec.assertPublicReleasePairContentFeedIndex(value.indexBytes, manifest);
  expect(() => codec.assertPublicReleasePairContentFeedPage(bytes, path, manifest, index)).toThrow();
});
it("keeps the members-only root distinct from full manifest identity at another producing cursor", () => {
  const value = fixture(), nextIdentity = { ...identity, contextSequence: identity.contextSequence + 1, inputManifestDigest: "f".repeat(64) };
  const next = { ...value.manifest, inputManifestDigest: nextIdentity.inputManifestDigest,
    cursor: { ...captured.cursor, sequence: nextIdentity.contextSequence, lastDigest: "e".repeat(64) } };
  expect(codec.publicReleasePairContentFeedNamespaceRootDigest(value.manifest.members)).toBe(codec.publicReleasePairContentFeedNamespaceRootDigest(next.members));
  expect(codec.publicReleasePairContentFeedNamespaceManifestDigest(value.manifest, pair, identity)).not.toBe(codec.publicReleasePairContentFeedNamespaceManifestDigest(next, pair, nextIdentity));
});

it("recognizes old missing numbered paths independently of current count, with no alias or coercion", () => {
  for (const path of ["/api/v1/content/1.json", "/api/v1/content/9007199254740991.json"]) expect(codec.isPublicReleasePairContentFeedPagePath(path)).toBe(true);
  for (const path of ["/api/v1/content/0.json", "/api/v1/content/01.json", "/api/v1/content/9007199254740992.json", "/api/v1/content/1.json\n",
    "/api/v1/content/1.json?x=1", "/api/v1/content/-1.json", "/api/v1/content/1.0.json", ["/api/v1/content/1.json"]]) {
    expect(codec.isPublicReleasePairContentFeedPagePath(path)).toBe(false);
  }
});
