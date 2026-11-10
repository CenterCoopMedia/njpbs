import { artifactFiles as preparedArtifactFiles } from "../../site/src/lib/public-worker-artifact";
import { publicReleasePairContentFeedAuthorityBytes } from "../../site/scripts/public-release-pair-content-feed-authority";
import { publicReleasePairSearchAuthorityBytes } from "../../site/scripts/public-release-pair-search-authority";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PAIR_CODE_PACK_FAMILIES, PAIR_COMPILED_PREFIX, derivePublicReleasePairCodePack,
  parsePublicReleasePairCodePack, publicReleasePairCodeAssetManifestDigest, isPairCodePackPath } from "../../site/scripts/public-release-pair-code-pack";
import type { PreparedPublicWorkerArtifact } from "../../site/src/lib/public-publication-receipt";
import postSlugs from "../../functions/lib/post-slug-contract.js";
import pages from "../../functions/lib/public-page-contract.js";
import { isPublicPagePath } from "../../packages/content-core/src/public-pages";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const commitSha = "a".repeat(40), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(feedPages = 1, indexPages = feedPages) {
  const root = await mkdtemp(path.join(tmpdir(), "pair-code-pack-")); roots.push(root);
  const distDirectory = path.join(root, "dist"), compiledDirectory = path.join(root, "compiled");
  const dist: Record<string, string> = {
    "_astro/client.js": "export{}", "_home-sources.json": "{}", "_schedule-sources.json": "{}", "api/v1/content.json": JSON.stringify({ apiVersion: 1, pages: [{ page: 1, url: "https://njpbs.org/api/v1/content/1.json" }] }), "api/v1/content/1.json": "{}",
    "brand/logo.svg": "<svg/>", "index.html": "<html>Baseline fallback</html>",
    "meeting-notices/njpba-audit-committee-2026-10-16.pdf": "%PDF-1.7 public meeting notice fixture",
    "pagefind/pagefind-entry.json": "{}", "pagefind/pagefind.js": "export{}", "search/meaning-index.json": "{}", "schedule/downloads/nj-pbs-schedule.pdf": "%PDF-1.7 fixture",
    "schedule/downloads/schedule.json": "{}", "sitemap-index.xml": "<sitemapindex/>",
    "feeds/news.xml": "<rss/>", "wiki/index.html": "<html>Public wiki</html>",
  };
  delete dist["api/v1/content/1.json"];
  dist["api/v1/content.json"] = JSON.stringify({ apiVersion: 1, pages: Array.from({ length: indexPages }, (_, index) => ({ page: index + 1, url: `https://njpbs.org/api/v1/content/${index + 1}.json` })) });
  for (let page = 1; page <= feedPages; page++) dist[`api/v1/content/${page}.json`] = "{}";
  const compiled = { "server/entry.mjs": "export{}", "client/client.js": "export{}", "renderer-release.json": JSON.stringify({ schemaVersion: 1, rendererSha: commitSha }),
    "pair-content-feed-namespace.json": new TextDecoder().decode(publicReleasePairContentFeedAuthorityBytes(commitSha)),
    "pair-search-namespace.json": new TextDecoder().decode(publicReleasePairSearchAuthorityBytes(commitSha)) };
  async function files(directory: string, values: Record<string, string>) {
    for (const [relative, body] of Object.entries(values)) { const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, body); }
  }
  await files(distDirectory, dist); await files(compiledDirectory, compiled);
  const graphBody = JSON.stringify({ schemaVersion: 1, kind: "pair-public-renderer", rendererSha: commitSha,
    files: Object.fromEntries(Object.entries(compiled).map(([name, body]) => [name, sha(body)])) }) + "\n";
  await writeFile(path.join(compiledDirectory, "pair-renderer-release.json"), graphBody);
  const artifactFiles = await preparedArtifactFiles(distDirectory);
  const artifactDigest = sha(JSON.stringify({ schemaVersion: 1, digestAlgorithm: "sha256", files: artifactFiles }));
  const receipt = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: "baseline", generation: 1, commitSha,
    artifactDigest, artifactReceiptDigest: "b".repeat(64), mediaManifestDigest: "c".repeat(64) };
  const publication = JSON.stringify(receipt) + "\n";
  await writeFile(path.join(distDirectory, "_publication.json"), publication);
  const preparedArtifact = { ...receipt, publicationReceiptDigest: sha(publication), artifactFileCount: artifactFiles.length + 1,
    artifactBytes: artifactFiles.reduce((sum, file) => sum + file.bytes, 0) + Buffer.byteLength(publication) } as PreparedPublicWorkerArtifact;
  const options = { pair: { commitSha, rendererDigest: sha(graphBody) }, distDirectory, compiledDirectory, preparedArtifact };
  return { ...options, options };
}
it("derives every exact baseline file, family and canonical digest from both sealed walks", async () => {
  const fixtureValue = await fixture(), { manifest, readMember } = await derivePublicReleasePairCodePack(fixtureValue.options);
  expect(new Set(manifest.members.map(member => member.family))).toEqual(new Set(PAIR_CODE_PACK_FAMILIES));
  expect(manifest.members.find(member => member.path === "/index.html")).toMatchObject({ family: "fallbackAsset", dynamic: false });
  expect(manifest.members.find(member => member.path === "/wiki/index.html")).toMatchObject({ family: "wiki", dynamic: false });
  expect(manifest.members.find(member => member.path === "/schedule/downloads/nj-pbs-schedule.pdf")).toMatchObject({ family: "schedule", dynamic: true });
  const canonical = JSON.stringify(manifest.members.map(member => ({ path: member.path, mime: member.mime, size: member.size,
    sha256: member.sha256, family: member.family, source: member.source, dynamic: member.dynamic })));
  expect(manifest.codeAssetManifestDigest).toBe(sha(canonical));
  expect(parsePublicReleasePairCodePack(manifest, { commitSha, codeAssetManifestDigest: sha(canonical) })).toEqual(manifest);
  for (const member of manifest.members) expect(sha(await readMember(member.path))).toBe(member.sha256);
});
it("includes committed public meeting-notice PDFs as immutable static files in the full dist", async () => {
  const value = await fixture(), pack = await derivePublicReleasePairCodePack(value.options);
  const name = "/meeting-notices/njpba-audit-committee-2026-10-16.pdf";
  expect(pack.manifest.members.find(member => member.path === name)).toMatchObject({
    mime: "application/pdf", family: "static", source: "static", dynamic: false,
  });
  expect(new TextDecoder().decode(await pack.readMember(name))).toBe("%PDF-1.7 public meeting notice fixture");
});
it("characterization: preserves the original schema-one pack and digest accepted by source 28c273993", async () => {
  // Generated with the unchanged S digest owner and its existing small sealed
  // artifact fixture, not with the new classifier. This is a protocol example,
  // not an installed S artifact or a receipt for a different source.
  const legacy = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(
    new URL('../fixtures/public-release-code-pack-v1-28c.json', import.meta.url), 'utf8')));
  expect(legacy.codeAssetManifestDigest).toBe('1c68b577486f02d194df4ad4ffe6c41e45b868001c04ee3c96fe0c4f6ca7d317');
  expect(parsePublicReleasePairCodePack(legacy, { commitSha: legacy.commitSha,
    codeAssetManifestDigest: legacy.codeAssetManifestDigest })).toEqual(legacy);
  expect(publicReleasePairCodeAssetManifestDigest(legacy.members)).toBe(legacy.codeAssetManifestDigest);
});
it.each(PAIR_CODE_PACK_FAMILIES.filter(family => family !== "contentFeedPages"))("census refuses a missing %s family even after recomputing its digest", async family => {
  const fixtureValue = await fixture(), { manifest } = await derivePublicReleasePairCodePack(fixtureValue.options);
  const members = manifest.members.filter(member => member.family !== family);
  expect(() => parsePublicReleasePairCodePack({ ...manifest, members,
    codeAssetManifestDigest: publicReleasePairCodeAssetManifestDigest(members) }, { commitSha })).toThrow("incomplete-code-pack");
});
it.each(["public-change", "graph-change", "unlisted", "unknown-family", "wrong-source"])("refuses %s instead of sealing partial coverage", async mode => {
  const value = await fixture();
  if (mode === "public-change") await writeFile(path.join(value.distDirectory, "brand/logo.svg"), "changed");
  if (mode === "graph-change") await writeFile(path.join(value.compiledDirectory, "server/entry.mjs"), "changed");
  if (mode === "unlisted") await writeFile(path.join(value.compiledDirectory, "unlisted.js"), "extra");
  if (mode === "unknown-family") await writeFile(path.join(value.distDirectory, "unknown.json"), "{}");
  if (mode === "wrong-source") value.options.pair.commitSha = "e".repeat(40);
  await expect(derivePublicReleasePairCodePack(value.options)).rejects.toThrow();
});
it("rejects duplicate paths, static overlays, bad paths and unsealed later bytes", async () => {
  const value = await fixture(), pack = await derivePublicReleasePairCodePack(value.options);
  const duplicate = [...pack.manifest.members, pack.manifest.members[0]];
  expect(() => parsePublicReleasePairCodePack({ ...pack.manifest, members: duplicate }, { commitSha })).toThrow();
  const altered = pack.manifest.members.map(member => member.family === "static" ? { ...member, dynamic: true } : member);
  expect(() => parsePublicReleasePairCodePack({ ...pack.manifest, members: altered }, { commitSha })).toThrow();
  await writeFile(path.join(value.distDirectory, "brand/logo.svg"), "later");
  await expect(pack.readMember("/brand/logo.svg")).rejects.toThrow("code-pack-bytes-mismatch");
  for (const file of ["/a/../b", "/a//b", "/a/%2e", "/a\\b", "/cafe\u0301.svg", "/bad\ud800.svg"]) expect(isPairCodePackPath(file), file).toBe(false);
  expect(isPairCodePackPath("/brand/caf\u00e9.svg")).toBe(true);
  expect(postSlugs.isServerMintableSlugShape("_pair-compiled")).toBe(false);
  expect(pages.isAvailablePageSlug("contact", "_pair-compiled")).toBe(false);
  expect(isPublicPagePath("contact", PAIR_COMPILED_PREFIX + "server/entry.mjs")).toBe(false);
});
it("requires both Schedule PDF and JSON and the complete graph manifest", async () => {
  const value = await fixture(), { manifest } = await derivePublicReleasePairCodePack(value.options);
  const members = manifest.members.filter(member => member.path !== "/schedule/downloads/nj-pbs-schedule.pdf");
  expect(() => parsePublicReleasePairCodePack({ ...manifest, members,
    codeAssetManifestDigest: publicReleasePairCodeAssetManifestDigest(members) }, { commitSha })).toThrow("incomplete-code-pack");
  await unlink(path.join(value.compiledDirectory, "server/entry.mjs"));
  await expect(derivePublicReleasePairCodePack(value.options)).rejects.toThrow("incomplete-code-pack");
});

it("bounds binary JSON chunks, including one exact empty chunk for an empty member", async () => {
  const codec = await import("../../site/scripts/public-release-pair-code-pack");
  const empty = { sha256: sha(new Uint8Array()), size: 0 };
  expect(codec.publicReleasePairCodePackChunkCount(0)).toBe(1);
  expect(codec.publicReleasePairCodePackChunkName(empty, 0)).toBe(`code-pack/objects/${empty.sha256}/0000.json`);
  expect(codec.decodePublicReleasePairCodePackChunk(JSON.parse(new TextDecoder().decode(codec.encodePublicReleasePairCodePackChunk(new Uint8Array()))), 0)).toEqual(new Uint8Array());
  expect(codec.publicReleasePairCodePackChunkCount(codec.PAIR_CODE_PACK_CHUNK_BYTES + 1)).toBe(2);
  expect(() => codec.publicReleasePairCodePackChunkName(empty, 1)).toThrow();
  expect(() => codec.decodePublicReleasePairCodePackChunk({ bodyBase64: "YQ==" }, 0)).toThrow();
  expect(() => codec.decodePublicReleasePairCodePackChunk({ bodyBase64: "YR==" }, 1)).toThrow();
});

it.each(["missing-authority", "wrong-authority", "missing-entry", "outside-namespace", "false-static"])("refuses search namespace %s", async mode => {
  const value = await fixture(), { manifest } = await derivePublicReleasePairCodePack(value.options);
  let members = [...manifest.members];
  if (mode === "missing-authority") members = members.filter(member => member.path !== "/_pair-compiled/pair-search-namespace.json");
  if (mode === "wrong-authority") members = members.map(member => member.path === "/_pair-compiled/pair-search-namespace.json"
    ? { ...member, sha256: sha(publicReleasePairSearchAuthorityBytes("b".repeat(40))) } : member);
  if (mode === "missing-entry") members = members.filter(member => member.path !== "/pagefind/pagefind-entry.json");
  if (mode === "outside-namespace") members = members.map(member => member.path === "/pagefind/pagefind.js" ? { ...member, path: "/search/pagefind.js" } : member);
  if (mode === "false-static") members = members.map(member => member.path === "/pagefind/pagefind.js" ? { ...member, dynamic: false } : member);
  members.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  expect(() => parsePublicReleasePairCodePack({ ...manifest, members,
    codeAssetManifestDigest: sha(JSON.stringify(members)) }, { commitSha })).toThrow();
});

it.each(["missing-authority", "wrong-authority", "missing-index", "gap", "zero", "leading-zero", "nested"])("refuses content feed namespace %s", async mode => {
  const value = await fixture(), { manifest } = await derivePublicReleasePairCodePack(value.options);
  let members = [...manifest.members];
  if (mode === "missing-authority") members = members.filter(member => member.path !== "/_pair-compiled/pair-content-feed-namespace.json");
  if (mode === "wrong-authority") members = members.map(member => member.path === "/_pair-compiled/pair-content-feed-namespace.json"
    ? { ...member, sha256: sha(publicReleasePairContentFeedAuthorityBytes("b".repeat(40))) } : member);
  if (mode === "missing-index") members = members.filter(member => member.path !== "/api/v1/content.json");
  const names: Record<string, string> = { gap: "2.json", zero: "0.json", "leading-zero": "01.json", nested: "1/2.json" };
  if (names[mode]) members = members.map(member => member.path === "/api/v1/content/1.json" ? { ...member, path: `/api/v1/content/${names[mode]}` } : member);
  members.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  expect(() => parsePublicReleasePairCodePack({ ...manifest, members,
    codeAssetManifestDigest: sha(JSON.stringify(members)) }, { commitSha })).toThrow();
});
it("seals contiguous numbered feed pages and verifies their real index, including an empty feed", async () => {
  const value = await fixture(12), { manifest } = await derivePublicReleasePairCodePack(value.options);
  expect(manifest.members.filter(member => member.family === "contentFeedPages")).toHaveLength(12);
  const empty = await fixture(0);
  expect((await derivePublicReleasePairCodePack(empty.options)).manifest.members.some(member => member.family === "contentFeedPages")).toBe(false);
  const missing = await fixture(0, 1), mismatch = await fixture(2, 1);
  await expect(derivePublicReleasePairCodePack(missing.options)).rejects.toThrow("content-feed-index-mismatch");
  await expect(derivePublicReleasePairCodePack(mismatch.options)).rejects.toThrow("content-feed-index-mismatch");
});
