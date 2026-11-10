import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import { finalizePublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { prepareContentBaseline, seedContentBaseline } from "../../site/scripts/public-content-baseline-artifact";
import { publicationFromPrepared } from "../../site/src/lib/public-publication-receipt";
import { publicationTarget } from "../../functions/lib/publication-target";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { createHash } from "node:crypto";
/** An actual sealed OLD artifact, with deliberately small fixture bodies.
 * NEW renderer proof uses the separately compiled real graph. */
export async function prepareOriginalStaticPairArtifact(directory: string, codeContext: any, store: PairViewStore) {
  const distDirectory = path.join(directory, "dist"); await mkdir(distDirectory, { recursive: true });
  const bodies = new Map<string, Uint8Array>(), encode = (value: string) => new TextEncoder().encode(value);
  const add = (route: string, bytes: Uint8Array) => bodies.set(route.endsWith("/") ? `${route.slice(1)}index.html` : route.slice(1), bytes);
  for (const page of PUBLIC_PAGES) for (const route of [page.path, ...("aliases" in page ? page.aliases : [])]) add(route, encode(`<html>OLD committed ${route}</html>`));
  for (const family of codeContext.receipt.families) for (const record of family.artifacts) if (record.canonicalPath) {
    for (const route of [record.canonicalPath, ...record.aliases]) add(route, encode(`<html>OLD emitted ${route}</html>`));
  }
  for (const route of codeContext.receipt.aggregateRoutes) if (!bodies.has(`${route.slice(1)}index.html`)) add(route, encode(`<html>OLD aggregate ${route}</html>`));
  for (const [route, body] of [["/feeds/news.xml", "<rss>OLD</rss>"], ["/api/v1/content.json", "{}"], ["/pagefind/pagefind.js", "OLD engine"],
    ["/search/meaning-index.json", "{}"], ["/sitemap-index.xml", "<sitemapindex/>"], ["/sitemap-0.xml", "<urlset/>"]] as const) add(route, encode(body));
  if (codeContext.homeSources) add("/_home-sources.json", encode(JSON.stringify(codeContext.homeSources)));
  for (const file of codeContext.programImageDescriptors?.files ?? []) add(file.path, new Uint8Array(Buffer.from(file.base64, "base64")));
  for (const [name, bytes] of bodies) { await mkdir(path.dirname(path.join(distDirectory, name)), { recursive: true }); await writeFile(path.join(distDirectory, name), bytes); }
  await finalizePublicArtifactInventoryReceipt({ receipt: codeContext.receipt, distDirectory, outputPath: path.join(directory, "inventory.json") });
  const prepared = await preparePublicWorkerArtifact({ artifactReceipt: codeContext.receipt, distDirectory, outputPath: path.join(directory, "prepared.json") });
  const plan = await prepareContentBaseline({ target: publicationTarget("development"), distDirectory, preparedArtifact: prepared });
  await seedContentBaseline(plan, { writeAndVerify: async (key, bytes) => { await store.put(key, new Uint8Array(bytes), {
    onlyIf: { etagDoesNotMatch: "*" }, sha256: createHash("sha256").update(bytes).digest("hex"), customMetadata: {} }); } });
  return { distDirectory, prepared, plan, publication: publicationFromPrepared(prepared), artifact: codeContext.receipt };
}
