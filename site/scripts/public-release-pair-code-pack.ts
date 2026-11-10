import { isPrivatePairArtifactPath, comparePrivatePairArtifactPaths } from "../../functions/lib/public-release-pair-view";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { verifyPreparedPublicWorkerArtifact, type PreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";
import { assertPublicReleasePairSearchAuthority } from "./public-release-pair-search-authority";
import { assertPublicReleasePairContentFeedAuthority, assertPublicReleasePairContentFeedIndex, PAIR_CONTENT_FEED_INDEX } from "./public-release-pair-content-feed-authority";
import { publicPublicationReceiptMatchesPreparedArtifact } from "../src/lib/public-publication-receipt";
import { PairCodePackError } from "./public-release-pair-code-pack-chunks";
export { PairCodePackError, PAIR_CODE_PACK_CHUNK_BYTES, publicReleasePairCodePackChunkCount, publicReleasePairCodePackChunkName,
  encodePublicReleasePairCodePackChunk, decodePublicReleasePairCodePackChunk } from "./public-release-pair-code-pack-chunks";

export const PAIR_CODE_PACK_FILE = "code-pack.json";
export const PAIR_CODE_PACK_VERSION = 1;
export const PAIR_COMPILED_PREFIX = "/_pair-compiled/";
export const PAIR_CODE_PACK_FAMILIES = ["compiledGraph", "clientAsset", "static", "fallbackAsset", "search", "searchIndex", "contentFeedPages", "wiki", "schedule", "sitemap", "feed", "aggregate"] as const;
export type PairCodePackFamily = typeof PAIR_CODE_PACK_FAMILIES[number];
export type PairCodePackMember = Readonly<{ path: string; mime: string; size: number; sha256: string;
  family: PairCodePackFamily; source: "compiled" | "static" | "aggregate"; dynamic: boolean }>;
export type PairCodePack = Readonly<{ schemaVersion: 1; inventoryVersion: 1; commitSha: string;
  codeAssetManifestDigest: string; members: readonly PairCodePackMember[] }>;
const fail = (code: PairCodePackError["code"] = "invalid-code-pack"): never => { throw new PairCodePackError(code); };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const compare = comparePrivatePairArtifactPaths;
const MAX_FILES = 100_000, MAX_BYTES = 100 * 1024 ** 3, MAX_FILE_BYTES = 16 * 1024 ** 2;
const graphManifest = "pair-renderer-release.json";
function exact(value: unknown, names: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join("\n") !== [...names].sort().join("\n")) fail();
}
/** Paths are exact case-sensitive UTF-8 NFC file paths, never decoded aliases.
 * Reject dot segments, repeated slashes, backslashes, URL escapes/delimiters,
 * controls and malformed Unicode. Public dist cannot occupy the private prefix. */
export const isPairCodePackPath = isPrivatePairArtifactPath;

const mimeByExtension: Record<string, string> = {
  html: "text/html; charset=utf-8", json: "application/json; charset=utf-8", js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8", css: "text/css; charset=utf-8", xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8", webmanifest: "application/manifest+json", wasm: "application/wasm",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif",
  webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  pdf: "application/pdf", csv: "text/csv; charset=utf-8", map: "application/json; charset=utf-8", mp4: "video/mp4",
  webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", bin: "application/octet-stream",
  md: "text/markdown; charset=utf-8", pf_filter: "application/octet-stream", pf_meta: "application/octet-stream",
  pf_index: "application/octet-stream", pf_fragment: "application/octet-stream", pagefind: "application/octet-stream",
};
function classification(file: string) {
  const extension = path.posix.extname(file).slice(1).toLowerCase();
  const mime = ["_headers", "_redirects", "CNAME", "LICENSE"].includes(path.posix.basename(file)) ? "text/plain; charset=utf-8" : mimeByExtension[extension];
  if (!mime) fail();
  let family: PairCodePackFamily;
  if (file.startsWith(PAIR_COMPILED_PREFIX)) family = "compiledGraph";
  else if (file.startsWith("/wiki/")) family = "wiki";
  else if (file.startsWith("/pagefind/")) family = "searchIndex";
  else if (file.startsWith("/api/v1/content/")) {
    if (!/^\/api\/v1\/content\/[1-9][0-9]*\.json$/.test(file)) fail();
    family = "contentFeedPages";
  }
  else if (file.startsWith("/search/") && extension !== "html") family = "search";
  else if (file === "/_schedule-sources.json" || file.startsWith("/schedule/downloads/")) family = "schedule";
  else if (/^\/sitemap(?:-[A-Za-z0-9_-]+)?\.xml$/.test(file)) family = "sitemap";
  else if (file.startsWith("/feeds/") || file.startsWith("/_external-content/") || file === "/api/v1/content.json" ||
      /^\/api\/v1\/content\/[0-9]+\.json$/.test(file) || ["/rss.xml", "/feed.xml", "/atom.xml"].includes(file)) family = "feed";
  else if (file.startsWith("/api/") || ["/_publication.json", "/_content-status.json", "/_home-sources.json"].includes(file)) family = "aggregate";
  else if (extension === "html") family = "fallbackAsset";
  else if (file.startsWith("/_astro/") || file.startsWith("/posts/_no-build-assets/") || ["js", "mjs", "css", "wasm"].includes(extension)) family = "clientAsset";
  else if (file === "/_design-system-tokens.json" || /^(image\/|font\/|video\/|audio\/)/.test(mime) ||
      file.startsWith("/meeting-notices/") && extension === "pdf" ||
      ["txt", "md", "webmanifest", "csv"].includes(extension) || ["_headers", "_redirects", "CNAME", "LICENSE"].includes(path.posix.basename(file))) family = "static";
  else fail(); // New aggregate paths must be added to this authoritative census.
  const source = ["compiledGraph", "clientAsset"].includes(family!) ? "compiled" as const
    : ["static", "fallbackAsset"].includes(family!) ? "static" as const : "aggregate" as const;
  return { mime, family: family!, source, dynamic: ["search", "searchIndex", "contentFeedPages", "schedule", "sitemap", "feed", "aggregate"].includes(family!) };
}
function member(value: unknown): PairCodePackMember {
  exact(value, ["path", "mime", "size", "sha256", "family", "source", "dynamic"]);
  if (!isPairCodePackPath(value.path) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_FILE_BYTES ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) fail();
  const expected = classification(value.path);
  if (value.mime !== expected.mime || value.family !== expected.family || value.source !== expected.source || value.dynamic !== expected.dynamic) fail();
  // Key order is a protocol: dynamic follows source, including in the digest.
  return Object.freeze({ path: value.path, mime: value.mime, size: value.size, sha256: value.sha256,
    family: value.family, source: value.source, dynamic: value.dynamic });
}
export function publicReleasePairCodeAssetManifestDigest(values: readonly PairCodePackMember[]) {
  return sha(JSON.stringify(values.map(member).sort((a, b) => compare(a.path, b.path))));
}
export function parsePublicReleasePairCodePack(value: unknown, expected: Pick<PublicReleasePair, "commitSha"> & Partial<Pick<PublicReleasePair, "codeAssetManifestDigest">>): PairCodePack {
  exact(value, ["schemaVersion", "inventoryVersion", "commitSha", "codeAssetManifestDigest", "members"]);
  if (value.schemaVersion !== 1 || value.inventoryVersion !== PAIR_CODE_PACK_VERSION ||
      !/^[a-f0-9]{40}$/.test(expected.commitSha) || value.commitSha !== expected.commitSha) fail("code-pack-source-mismatch");
  if (!Array.isArray(value.members) || !value.members.length || value.members.length > MAX_FILES) fail("incomplete-code-pack");
  let previous = "", total = 0;
  const members: PairCodePackMember[] = (value.members as unknown[]).map((raw: unknown) => {
    const parsed = member(raw);
    if (compare(parsed.path, previous) <= 0) fail();
    previous = parsed.path; total += parsed.size;
    return parsed;
  });
  if (total > MAX_BYTES) fail();
  // An empty feed-page namespace is valid only when the real index has zero
  // pages; derive/persist verify those bytes separately from this inventory.
  if (PAIR_CODE_PACK_FAMILIES.some(family => family !== "contentFeedPages" && !members.some(item => item.family === family)) ||
      !members.some(item => item.path === "/schedule/downloads/nj-pbs-schedule.pdf") ||
      !members.some(item => item.path === "/_schedule-sources.json")) fail("incomplete-code-pack");
  const digest = publicReleasePairCodeAssetManifestDigest(members);
  if (value.codeAssetManifestDigest !== digest || expected.codeAssetManifestDigest !== undefined && expected.codeAssetManifestDigest !== digest) fail("code-pack-bytes-mismatch");
  const parsed: PairCodePack = Object.freeze({ schemaVersion: 1, inventoryVersion: 1, commitSha: value.commitSha,
    codeAssetManifestDigest: digest, members: Object.freeze(members) });
  assertPublicReleasePairSearchAuthority(parsed, expected);
  assertPublicReleasePairContentFeedAuthority(parsed, expected);
  return parsed;
}

async function bytes(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) fail();
    const body = await handle.readFile(); signal?.throwIfAborted();
    const after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || body.length !== after.size) fail("code-pack-bytes-mismatch");
    return new Uint8Array(body);
  } finally { await handle.close(); }
}
async function walk(directory: string, prefix = "", output = new Map<string, string>()) {
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) fail();
  for (const name of (await readdir(directory)).sort(compare)) {
    const relative = prefix + name, file = path.join(directory, name), state = await lstat(file);
    if (!isPairCodePackPath("/" + relative) || state.isSymbolicLink()) fail();
    if (state.isDirectory()) await walk(file, relative + "/", output);
    else if (state.isFile()) output.set(relative, file);
    else fail();
    if (output.size > MAX_FILES) fail();
  }
  return output;
}
/** Derive from verified exact-source artifacts; accept no member list or family
 * hints. This reads existing build output and never runs a build or publishes.
 * The returned byte reader rechecks hashes, so later disk changes cannot be
 * written by the executor under an earlier inventory. */
export async function derivePublicReleasePairCodePack({ pair, distDirectory, compiledDirectory, preparedArtifact, signal }: {
  pair: Pick<PublicReleasePair, "commitSha" | "rendererDigest"> & Partial<Pick<PublicReleasePair, "codeAssetManifestDigest">>;
  distDirectory: string; compiledDirectory: string; preparedArtifact: PreparedPublicWorkerArtifact; signal?: AbortSignal;
}) {
  signal?.throwIfAborted();
  const prepared = await verifyPreparedPublicWorkerArtifact({ preparedArtifact, distDirectory });
  if (prepared.commitSha !== pair.commitSha || !publicPublicationReceiptMatchesPreparedArtifact(await readFile(path.join(distDirectory, "_publication.json"), "utf8"), prepared)) fail("code-pack-source-mismatch");
  const [publicFiles, graphFiles] = await Promise.all([walk(distDirectory), walk(compiledDirectory)]);
  const graphBody = await bytes(path.join(compiledDirectory, graphManifest), signal);
  if (sha(graphBody) !== pair.rendererDigest) fail("code-pack-source-mismatch");
  const graph = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(graphBody));
  exact(graph, ["schemaVersion", "kind", "rendererSha", "files"]);
  if (graph.schemaVersion !== 1 || graph.kind !== "pair-public-renderer" || graph.rendererSha !== pair.commitSha ||
      !graph.files || typeof graph.files !== "object" || Array.isArray(graph.files)) fail("code-pack-source-mismatch");
  graphFiles.delete(graphManifest);
  if (graphFiles.size !== Object.keys(graph.files).length || !graphFiles.has("server/entry.mjs") || !graphFiles.has("renderer-release.json")) fail("incomplete-code-pack");
  const locations = new Map<string, string>(), members: PairCodePackMember[] = [];
  for (const [isGraph, files] of [[false, publicFiles], [true, graphFiles]] as const) for (const [relative, file] of files) {
    const name = isGraph ? PAIR_COMPILED_PREFIX + relative : "/" + relative;
    if (!isGraph && name.startsWith(PAIR_COMPILED_PREFIX)) fail();
    const body = await bytes(file, signal), digest = sha(body);
    if (isGraph && graph.files[relative] !== digest) fail("code-pack-bytes-mismatch");
    const parsed = member({ path: name, ...classification(name), size: body.byteLength, sha256: digest });
    locations.set(name, file); members.push(parsed);
  }
  // The source manifest is itself part of the private compiled pack.
  const name = PAIR_COMPILED_PREFIX + graphManifest;
  locations.set(name, path.join(compiledDirectory, graphManifest));
  members.push(member({ path: name, ...classification(name), size: graphBody.byteLength, sha256: sha(graphBody) }));
  members.sort((a, b) => compare(a.path, b.path));
  const manifest = parsePublicReleasePairCodePack({ schemaVersion: 1, inventoryVersion: 1, commitSha: pair.commitSha,
    codeAssetManifestDigest: publicReleasePairCodeAssetManifestDigest(members), members }, pair);
  await verifyPreparedPublicWorkerArtifact({ preparedArtifact, distDirectory });
  const readMember = async (requestedPath: string) => {
    const expected = manifest.members.find(item => item.path === requestedPath), file = locations.get(requestedPath);
    if (!expected || !file) fail();
    const body = await bytes(file!, signal);
    if (body.byteLength !== expected!.size || sha(body) !== expected!.sha256) fail("code-pack-bytes-mismatch");
    return body;
  };
  assertPublicReleasePairContentFeedIndex(await readMember(PAIR_CONTENT_FEED_INDEX), manifest);
  return Object.freeze({ manifest, readMember });
}
