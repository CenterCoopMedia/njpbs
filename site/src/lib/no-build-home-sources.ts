import { createHash } from "node:crypto";
import { assertHomeSourcePublication, createHomeEditorialCatalog, rebuildHomeSourcesForPosts } from "./home-editorial-catalog";
import { createHomeSourceSnapshot } from "./home-sources";
import { homeSelectedPostIds } from "../../../packages/content-core/src/home-source-catalog";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { CmsPostBuildData } from "./cms-posts-projection";

export interface RetainedHomeSource {
  file: { path: string; key: string; digest: string; size: number; contentType: string };
  publication: NonNullable<HomeSourceSnapshot["publication"]>;
  catalogDigest: string;
}

export interface PreparedHomeExternalInputs {
  schemaVersion: 1;
  operationId: string;
  runtime: { owner: "cloudflare"; release: string };
  contentDigest: string;
  checkedAt: number;
  files: Record<string, { key: string; digest: string; size: number }>;
}
const externalInputNames = ["launch-media-manager.json", "spotlight-news.json", "schedule.json"] as const;

// Matches the producer's semantic seal: observations do not change content.
function externalContentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(externalContentValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => !["checkedAt", "generatedAt", "sourceCheckedAt"].includes(key))
    .map(([key, item]) => [key, externalContentValue(item)]));
  return value;
}

/** Project only the exact accepted provider bytes; current rendering identity
 * does not rewrite the original external input receipt or its runtime. */
export async function readPreparedHomeSources({ inputs, read, publication }: {
  inputs: PreparedHomeExternalInputs;
  read: (key: string) => Promise<Uint8Array>;
  publication: NonNullable<HomeSourceSnapshot["publication"]>;
}): Promise<HomeSourceSnapshot> {
  if (inputs?.schemaVersion !== 1 || !/^[A-Za-z0-9]{20}$/.test(inputs.operationId) ||
      inputs.runtime?.owner !== "cloudflare" || !/^[a-f0-9]{40}$/.test(inputs.runtime.release) ||
      !/^[a-f0-9]{64}$/.test(inputs.contentDigest) || !Number.isSafeInteger(inputs.checkedAt) || inputs.checkedAt < 1 ||
      !Number.isFinite(new Date(inputs.checkedAt).getTime()) || !inputs.files || Object.keys(inputs.files).length !== 3) {
    throw new Error("The prepared Home provider identity is invalid.");
  }
  for (const name of externalInputNames) {
    const file = inputs.files[name];
    if (!file || file.key !== `post-background-v1/external-inputs/${inputs.operationId}/${name}` ||
        !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 * 1024) {
      throw new Error("The prepared Home provider file identity is invalid.");
    }
  }
  const payloads: Record<string, unknown> = {};
  for (const name of externalInputNames) {
    const file = inputs.files[name];
    const bytes = await read(file.key);
    if (!(bytes instanceof Uint8Array) || bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.digest) {
      throw new Error("The prepared Home provider bytes changed.");
    }
    payloads[name] = JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
  const content = Object.fromEntries(externalInputNames.map(name => [name, externalContentValue(payloads[name])]));
  if (createHash("sha256").update(JSON.stringify(content)).digest("hex") !== inputs.contentDigest) {
    throw new Error("The prepared Home provider content identity changed.");
  }
  const media = payloads["launch-media-manager.json"] as Parameters<typeof createHomeSourceSnapshot>[0];
  const spotlight = payloads["spotlight-news.json"] as Parameters<typeof createHomeSourceSnapshot>[1];
  const snapshot = createHomeSourceSnapshot(media, spotlight, publication);
  const editorial = createHomeEditorialCatalog(snapshot, spotlight, [], new Date(inputs.checkedAt).toISOString());
  return assertHomeSourcePublication({ ...snapshot, editorial }, publication);
}

/** Read the complete frozen provider snapshot before preparing the Page graph. */
export async function readRetainedHomeSources({ source, read }: {
  source: RetainedHomeSource;
  read: (key: string) => Promise<Uint8Array>;
}): Promise<HomeSourceSnapshot> {
  const file = source.file;
  if (file.path !== "/_home-sources.json" || !["application/json", "application/json; charset=utf-8"].includes(file.contentType) ||
      !/^post-background-v1\/home\/[A-Za-z0-9-]+\/[a-f0-9]{64}$/.test(file.key) ||
      !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 * 1024) {
    throw new Error("The retained Home source identity is invalid.");
  }
  const bytes = await read(file.key);
  if (!(bytes instanceof Uint8Array) || bytes.length !== file.size ||
      createHash("sha256").update(bytes).digest("hex") !== file.digest) {
    throw new Error("The retained Home source bytes changed.");
  }
  const sources = assertHomeSourcePublication(JSON.parse(Buffer.from(bytes).toString("utf8")), source.publication);
  if (!sources.editorial || sources.editorial.receipt.digest !== source.catalogDigest) {
    throw new Error("The retained Home catalog identity changed.");
  }
  return sources;
}

/** Saved selections resolve through the existing arrangement and catalog code. */
export function homeSourcesForPagePublication({ sources, posts, publication, cutoffAt, home }: {
  sources: HomeSourceSnapshot;
  posts: readonly CmsPostBuildData[];
  publication: NonNullable<HomeSourceSnapshot["publication"]>;
  cutoffAt: string;
  home: Parameters<typeof homeSelectedPostIds>[0];
}): HomeSourceSnapshot {
  return rebuildHomeSourcesForPosts(sources, posts, publication, cutoffAt, homeSelectedPostIds(home));
}
