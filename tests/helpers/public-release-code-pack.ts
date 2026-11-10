import { MODEL_ID, MODEL_REVISION } from "../../packages/browser-search/contracts";
import { artifactFiles as preparedArtifactFiles } from "../../site/src/lib/public-worker-artifact";
import { publicReleasePairContentFeedAuthorityBytes } from "../../site/scripts/public-release-pair-content-feed-authority";
import { publicReleasePairSearchAuthorityBytes } from "../../site/scripts/public-release-pair-search-authority";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createExternalContentStaticFeed, type ExternalContentManifest } from "../../site/src/lib/external-content-feed";
import type { PreparedPublicWorkerArtifact } from "../../site/src/lib/public-publication-receipt";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Small sealed files only; no build, deployment or network source. */
export async function publicReleaseCodePackFixture(root: string, commitSha: string, sourceInputs?: Uint8Array, extraDist: Record<string, string> = {}) {
  const distDirectory = path.join(root, "dist"), compiledDirectory = path.join(root, "compiled");
  const feed: ExternalContentManifest = { apiVersion: 1, title: "NJ PBS released content", homeUrl: "https://njpbs.org/", feedUrl: "https://njpbs.org/api/v1/content.json",
    rssUrl: "https://njpbs.org/feeds/news.xml", items: [{ id: "post:fixture", type: "post", sourceId: "fixture", sourceVersion: 1,
      url: "https://njpbs.org/posts/fixture/", locale: "en", title: "Released fixture", summary: "Public summary", contentHtml: "<p>Public</p>",
      publishedAt: "2026-10-28T04:00:00.000Z", modifiedAt: "2026-10-28T04:00:00.000Z", authors: [], categories: [], tags: [] }] };
  const output = createExternalContentStaticFeed(feed);
  const dist: Record<string, string> = { "_content-status.json": JSON.stringify({ schemaVersion: 1, buildBatchId: "baseline", generation: 1, commitSha, collections: ["cmsPages", "cmsPosts"], routes: [{ path: "/", source: "site" }] }), "_astro/client.js": "export{}", "_home-sources.json": "{}", "_schedule-sources.json": "{}",
    "api/v1/content.json": JSON.stringify(output.index) + "\n", "api/v1/content/1.json": JSON.stringify(output.pages[0]) + "\n",
    "brand/logo.svg": "<svg/>", "index.html": "<html>Baseline fallback</html>", "pagefind/pagefind-entry.json": "{}", "pagefind/pagefind.js": "export{}", "search/meaning-index.json": JSON.stringify({ version: 1, model: MODEL_ID, revision: MODEL_REVISION, passages: [] }),
    "schedule/downloads/nj-pbs-schedule.pdf": "%PDF-1.7 fixture",
    "sitemap-index.xml": "<sitemapindex/>", "sitemap-0.xml": "<urlset/>", "feeds/news.xml": "<rss/>", "wiki/index.html": "<html>Public wiki</html>" };
  Object.assign(dist, extraDist);
  const compiled: Record<string, string> = { "server/entry.mjs": "export{}", "client/client.js": "export{}",
    "renderer-release.json": JSON.stringify({ schemaVersion: 1, rendererSha: commitSha }),
    "pair-content-feed-namespace.json": new TextDecoder().decode(publicReleasePairContentFeedAuthorityBytes(commitSha)),
    "pair-search-namespace.json": new TextDecoder().decode(publicReleasePairSearchAuthorityBytes(commitSha)),
    ...(sourceInputs ? { "pair-source-inputs.json": new TextDecoder().decode(sourceInputs) } : {}) };
  for (const [directory, files] of [[distDirectory, dist], [compiledDirectory, compiled]] as const) for (const [relative, body] of Object.entries(files)) {
    const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, body);
  }
  const graph = JSON.stringify({ schemaVersion: 1, kind: "pair-public-renderer", rendererSha: commitSha,
    files: Object.fromEntries(Object.entries(compiled).map(([name, body]) => [name, hash(body)])) }) + "\n";
  await writeFile(path.join(compiledDirectory, "pair-renderer-release.json"), graph);
  const files = await preparedArtifactFiles(distDirectory);
  const publication = { schemaVersion: 1 as const, digestAlgorithm: "sha256" as const, buildBatchId: "baseline", generation: 1, commitSha,
    artifactDigest: hash(JSON.stringify({ schemaVersion: 1, digestAlgorithm: "sha256", files })), artifactReceiptDigest: "b".repeat(64), mediaManifestDigest: "c".repeat(64) };
  const bytes = JSON.stringify(publication) + "\n"; await writeFile(path.join(distDirectory, "_publication.json"), bytes);
  const preparedArtifact: PreparedPublicWorkerArtifact = { ...publication, publicationReceiptDigest: hash(bytes),
    artifactFileCount: files.length + 1, artifactBytes: files.reduce((sum, file) => sum + file.bytes, 0) + Buffer.byteLength(bytes) };
  return { pair: { commitSha, rendererDigest: hash(graph) }, distDirectory, compiledDirectory, preparedArtifact };
}
