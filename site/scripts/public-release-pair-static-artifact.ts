import { contentLinkFallbackHtml } from "../src/lib/content-link-render";
import { contentLink, type ContentLinkMetadata } from "../../packages/content-core/src/content-link.ts";
import { publishedContentLinkRecords } from "../src/lib/content-link-search";
import { COVERAGE_LABELS_SETTINGS_ID } from "../../packages/content-core/src/cms-settings.ts";
import { STORY_CTAS_SETTINGS_ID } from "../../packages/content-core/src/cms-settings.ts";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import type { PublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import proofParser from "../../functions/lib/no-build-post-static-proof.js";
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, SITE_NAVIGATION_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID } from "../../packages/content-core/src/cms-settings.ts";
import approvals from "../../functions/lib/approved-library-records.js";
import { projectPublicArtifactContent, type PublicArtifactContentRead } from "../src/lib/cms-loader";
import { finalizePublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact, artifactFiles } from "../src/lib/public-worker-artifact";
import { prepareStaticPostProof } from "./prepare-static-post-proof";
import { PAIR_COMPILED_PREFIX, isPairCodePackPath, type PairCodePack } from "./public-release-pair-code-pack";
import { publicReleasePairHtmlRoute } from "./public-release-pair-aggregate-outputs";
import type { openFrozenPublicReleasePairStaticSource } from "./public-release-pair-static-source";
export type StaticArtifactOutput = { path: string; status: number; bytes: Uint8Array; headers?: Readonly<Record<string, string>> };
export function renderPairContentLinkFallback(output: StaticArtifactOutput, entries: ReadonlyMap<string, ContentLinkMetadata>): string {
  const entry = entries.get(output.path);
  if (output.status !== 302 || output.bytes.length || !entry || contentLink(entry, output.path).href !== output.headers?.location) refuse();
  return contentLinkFallbackHtml(entry);
}
export type FrozenStaticSource = NonNullable<Awaited<ReturnType<typeof openFrozenPublicReleasePairStaticSource>>>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function refuse(): never { throw new work.PairExecutionError("byte-mismatch"); }
function artifactPath(route: string) {
  const file = route.endsWith("/") ? `${route}index.html` : route;
  if (!isPairCodePackPath(file) || file.startsWith(PAIR_COMPILED_PREFIX)) refuse();
  return file.slice(1);
}
/** A private logical build identity, bound to the full accepted H task rather
 * than a claim attempt. No live build reservation, watermark or CODE changes.
 * The ordinary live projector below computes every inventory/media seal anew. */
export function projectPublicReleasePairStaticArtifact({ pair, identity, source, documents, renderedAt }: {
  pair: PublicReleasePair; identity: PairTaskIdentity; source: FrozenStaticSource; documents: ReadonlyMap<string, any>; renderedAt: string;
}) {
  const task = view.parseViewIdentity(identity, pair);
  const admissionTime = new Date(renderedAt), instant = admissionTime.getTime();
  if (!Number.isFinite(instant) || admissionTime.toISOString() !== renderedAt || !Number.isSafeInteger(source.owner.state.generation) || source.owner.state.generation < 1) refuse();
  const cutoffAt = { seconds: Math.floor(instant / 1000), nanoseconds: (instant % 1000) * 1_000_000, toMillis: () => instant };
  const reservation = { schemaVersion: 1, buildBatchId: `pair-${protocol.publicReleaseDigest(task)}`, generation: source.owner.state.generation,
    commitSha: pair.commitSha, reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt };
  const rows = (prefix: string) => [...documents].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => ({ ...value, id: name.slice(prefix.length) }));
  const history = rows("cmsVersionHistory/");
  const posts = rows("cmsPosts/").map(record => ({ ...record, approvedLibraryVersion: approvals.approvedLibraryVersion(record, history) }));
  const setting = (id: string) => { const value = documents.get(`cmsSettings/${id}`); return value ? { ...value, id } : undefined; };
  const read: PublicArtifactContentRead = { pages: rows("cmsPages/"), posts, assets: rows("media_assets_public/"),
    authors: [...documents].filter(([name]) => name.startsWith("cmsAuthorProfilesPublic/")).map(([name, data]) => ({ authorId: name.split("/")[1], data })),
    setting: setting(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID), navigation: setting(SITE_NAVIGATION_SETTINGS_ID), chrome: setting(PUBLIC_SITE_CHROME_SETTINGS_ID), njDecides: setting(NJ_DECIDES_SETTINGS_ID), coverageLabels: setting(COVERAGE_LABELS_SETTINGS_ID), storyCtas: setting(STORY_CTAS_SETTINGS_ID), reservation, admissionTime };
  return projectPublicArtifactContent(read);
}
/** The full live finalizer requires both emitted CMS aliases and aliases of
 * committed frames which have no overriding CMS Page in this artifact. */
export function publicReleasePairStaticAliasTargets(artifact: PublicArtifactInventoryReceipt) {
  const result = new Map<string, { canonicalPath: string; collection: string; documentId: string }>();
  const add = (path: string, canonicalPath: string, collection: string, documentId: string) => {
    if (result.has(path) && result.get(path)!.canonicalPath !== canonicalPath) refuse();
    result.set(path, { canonicalPath, collection, documentId });
  };
  for (const family of artifact.families) for (const record of family.artifacts) {
    if (!record.canonicalPath) continue;
    for (const path of record.aliases) add(path, record.canonicalPath, family.collection, record.documentId);
  }
  const cmsPages = artifact.families.find(family => family.collection === "cmsPages")!;
  for (const page of PUBLIC_PAGES) if (!cmsPages.artifacts.some(record => record.canonicalPath === page.path)) {
    for (const path of "aliases" in page ? page.aliases : []) add(path, page.path, "site", page.id);
  }
  return result;
}

/** Materialize only the verified NEW pack and actual claimed renderer outputs,
 * then call the same full inventory/artifact/static-proof producers as a live
 * build. File data is bounded and streamed one member at a time. */
async function recomputeStaticArtifact(options: {
  pair: PublicReleasePair; identity: PairTaskIdentity; source: FrozenStaticSource; documents: ReadonlyMap<string, any>;
  renderedAt: string; baseline: PairCodePack; readBaseline(path: string): Promise<Uint8Array>;
  outputs: readonly { path: string; read(): Promise<StaticArtifactOutput> }[];
  aliases: readonly { path: string; read(): Promise<Uint8Array> }[]; directory: string; verifyReceipts: boolean; signal?: AbortSignal; progress?(): Promise<unknown>;
}) {
  const projected = projectPublicReleasePairStaticArtifact(options), artifact = projected.receipt;
  const contentLinks = new Map(publishedContentLinkRecords(options.documents, new Date(options.renderedAt)).map(entry => [entry.path, entry]));
  const distDirectory = path.join(options.directory, "dist"); await mkdir(distDirectory, { recursive: true, mode: 0o700 });
  const wrote = new Map<string, string>(), originalReceipts = new Map<string, Uint8Array>();
  const write = async (route: string, bytes: Uint8Array) => {
    options.signal?.throwIfAborted(); const name = artifactPath(route);
    if (bytes.length > 16 * 1024 * 1024 || wrote.has(name)) refuse(); wrote.set(name, hash(bytes));
    await mkdir(path.dirname(path.join(distDirectory, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(distDirectory, name), bytes, { flag: "wx", mode: 0o600 }); await options.progress?.();
  };
  const owned = new Set(options.outputs.map(output => output.path));
  if (owned.size !== options.outputs.length || options.baseline.commitSha !== options.pair.commitSha ||
      options.baseline.codeAssetManifestDigest !== options.pair.codeAssetManifestDigest) refuse();
  for (const member of options.baseline.members) {
    if (member.path.startsWith(PAIR_COMPILED_PREFIX) || member.dynamic || owned.has(member.path) ||
        member.mime.startsWith("text/html") && owned.has(publicReleasePairHtmlRoute(member.path))) continue;
    const bytes = await options.readBaseline(member.path);
    if (bytes.length !== member.size || hash(bytes) !== member.sha256) refuse(); await write(member.path, bytes);
  }
  for (const selected of options.outputs) {
    const output = await selected.read(); if (output.path !== selected.path || ![200, 302, 308, 410].includes(output.status)) refuse();
    if (["/_publication.json", "/_content-status.json"].includes(output.path)) { originalReceipts.set(output.path, output.bytes); continue; }
    if (output.status === 302) {
      await write(output.path, new TextEncoder().encode(renderPairContentLinkFallback(output, contentLinks)));
    }
    else if (output.status === 200) await write(output.path, output.bytes);
    else if (output.bytes.length) refuse();
  }
  const aliases = publicReleasePairStaticAliasTargets(artifact);
  for (const alias of options.aliases) {
    if (!aliases.has(alias.path) || wrote.has(artifactPath(alias.path))) refuse();
    const bytes = await alias.read(); if (!bytes.length) refuse(); await write(alias.path, bytes);
  }
  await finalizePublicArtifactInventoryReceipt({ receipt: artifact, distDirectory, outputPath: path.join(options.directory, "inventory.json") });
  options.signal?.throwIfAborted(); await options.progress?.();
  const prepared = await preparePublicWorkerArtifact({ artifactReceipt: artifact, distDirectory, outputPath: path.join(options.directory, "prepared.json") });
  options.signal?.throwIfAborted(); await options.progress?.();
  const proof = await prepareStaticPostProof({ input: proofParser.staticProofInput(options.source.proof), artifact, prepared, distDirectory });
  options.signal?.throwIfAborted(); await options.progress?.();
  const files = await artifactFiles(distDirectory);
  const readReceipt = async (name: string) => {
    const { readFile } = await import("node:fs/promises"); const bytes = new Uint8Array(await readFile(path.join(distDirectory, name.slice(1))));
    if (options.verifyReceipts && (!originalReceipts.has(name) || !Buffer.from(bytes).equals(Buffer.from(originalReceipts.get(name)!)))) refuse();
    return bytes;
  };
  return { artifact, prepared, proof, files, publicationBytes: await readReceipt("/_publication.json"), statusBytes: await readReceipt("/_content-status.json") };
}

export async function recomputePublicReleasePairStaticArtifact(options: Parameters<typeof recomputeStaticArtifact>[0]) {
  try { return await recomputeStaticArtifact(options); }
  catch (error) {
    options.signal?.throwIfAborted(); if (error instanceof work.PairExecutionError) throw error;
    const failure = new work.PairExecutionError(options.verifyReceipts ? "byte-mismatch" : "input-unavailable");
    Object.defineProperty(failure, "cause", { value: error });
    throw failure;
  }
}
