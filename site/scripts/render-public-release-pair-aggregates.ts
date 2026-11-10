import { contentLinkSearchRecords } from "../src/lib/content-link-search";
import { PAIR_STATIC_SOURCE_FILE, soleStaticPostOwner } from "./public-release-pair-static-source";
import { pathToFileURL } from "node:url";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import type { PairReplayTargetReceipt } from "./public-release-pair-replay";
import { parsePublicReleasePairCodePack } from "./public-release-pair-code-pack";
import { openPublicReleasePairSourceDocuments } from "./public-release-pair-source-documents";
import { derivePublicReleasePairFrozenSchedule } from "./public-release-pair-frozen-output";
import { derivePublicReleasePairContentFeeds, buildPublicReleasePairSitemaps, type PairAggregateFile } from "./public-release-pair-aggregate-outputs";
import { derivePublicReleasePairPublicReceipts } from "./public-release-pair-public-receipts";
import { buildPublicReleasePairPagefind } from "./public-release-pair-pagefind";
import { buildPublicReleasePairSemanticIndex } from "./public-release-pair-semantic";
import views from "../../functions/lib/public-release-pair-view.js";
import work from "../../functions/lib/public-release-pair-work.js";
/** Runs only in the sealed offline child. Its readers can open original H or
 * exact baseline G members materialized read-only by their verified owner. */
export async function renderPublicReleasePairAggregates(options: { pair: PublicReleasePair; root: PairInputRoot; renderedAt: string;
  semanticPriorBytes?: Uint8Array;
  readFrozenFile(name: string): Promise<Uint8Array>; readBaseline(path: string): Promise<Uint8Array>;
  html(): AsyncIterable<{ path: string; bytes: Uint8Array }>;
  targets: readonly { receipt: PairReplayTargetReceipt; status: number }[]; ownedPaths: ReadonlySet<string> }) {
  const baseline = parsePublicReleasePairCodePack(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await options.readFrozenFile("code-pack.json"))), options.pair);
  const { documents } = await openPublicReleasePairSourceDocuments(options.root, options.readFrozenFile);
  const origin = options.pair.environment === "development" ? "https://dev-public.example.org" : "https://njpbs.org";
  const files: PairAggregateFile[] = derivePublicReleasePairContentFeeds(documents, new Date(options.renderedAt), origin);
  files.push(...await derivePublicReleasePairFrozenSchedule({ root: options.root, baseline, readFile: options.readFrozenFile }));
  const contentLinks = contentLinkSearchRecords(documents, new Date(options.renderedAt));
  const pagefind = await buildPublicReleasePairPagefind(options.html(), "/pair/pagefind", contentLinks); files.push(...pagefind.files);
  const semantic = await buildPublicReleasePairSemanticIndex({ contentLinks, html: options.html(), baselineBytes: await options.readBaseline("/search/meaning-index.json"), priorBytes: options.semanticPriorBytes,
    createEncoder: async () => {
      const module = await import(pathToFileURL("/pair/semantic-encoder.mjs").href);
      return module.createPublicReleasePairSemanticEncoder();
    } });
  files.push(semantic);
  files.push(...await buildPublicReleasePairSitemaps(options.html(), baseline.members.filter(member => member.family === "sitemap").map(member => member.path), origin));
  const staticSource = options.root.files.some(file => file.name === PAIR_STATIC_SOURCE_FILE);
  if (staticSource && !soleStaticPostOwner(documents)) throw new work.PairExecutionError("input-unavailable");
  if (!staticSource) files.push(...await derivePublicReleasePairPublicReceipts({ pair: options.pair, documents,
    baselinePublication: await options.readBaseline("/_publication.json"), baselineStatus: await options.readBaseline("/_content-status.json"),
    targets: options.targets, ownedPaths: options.ownedPaths }));
  files.sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path));
  if (files.reduce((sum, file) => sum + file.bytes.length, 0) > 256 * 1024 * 1024 || files.some((file, index) =>
    file.bytes.length > views.BODY_BYTES_LIMIT || index > 0 && file.path === files[index - 1].path || options.ownedPaths.has(file.path))) throw new work.PairExecutionError("input-unavailable");
  return { files, metrics: { pagefind: pagefind.metrics, semantic: semantic.metrics } };
}
