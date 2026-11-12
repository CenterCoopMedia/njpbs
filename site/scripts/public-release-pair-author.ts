import { createHash } from "node:crypto";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import type { PairAuthorOwner } from "../../functions/lib/public-release-pair-author";
import protocol from "../../functions/lib/public-release-pair.js";
import inputs from "../../functions/lib/public-release-pair-input.js";
import views from "../../functions/lib/public-release-pair-view.js";
import work from "../../functions/lib/public-release-pair-execution.js";
import log from "../../functions/lib/public-release-change-log.js";
import baseline from "../../functions/lib/public-release-change-baseline-receipt.js";
import { validateCurrentCodeReference } from "../../functions/lib/current-public-code-reference.js";
import { authorPublicPath } from "../../packages/content-core/src/author-profiles";
import { projectAuthorSnapshot, assertAuthorRouteUniqueness, type CmsAuthorBuildData } from "../src/lib/cms-authors-projection";
import { projectCmsPost, assertPostRouteUniqueness } from "../src/lib/cms-posts-projection";
import chromeProjection from "../../functions/lib/published-chrome-projection.js";
import { projectChrome, type PublishedPostContent } from "../src/lib/published-post-shadow";
import { parsePublicReleasePairReplayProvenance } from "./public-release-pair-replay";
import { PAIR_CODE_PACK_CHUNK_BYTES, decodePublicReleasePairCodePackChunk } from "./public-release-pair-code-pack-chunks";

export type PairAuthorContext = Readonly<{ pair: PublicReleasePair; identity: PairTaskIdentity; root: PairInputRoot;
  checkpoint?(): Promise<unknown>;
  readFrozenFile(name: string): Promise<Uint8Array> }>;
export type PairAuthorRoute = Readonly<{ path: string; status: 200 | 308 | 410; contentType: "text/html; charset=utf-8";
  location: string | null; owner: PairAuthorOwner }>;
export type PairAuthorContent = Omit<PublishedPostContent, "kind"> & { readonly kind: "public-pair-author" };
export class PairAuthorError extends work.PairExecutionError {
  constructor(code: "author-input-missing" | "author-input-mismatch" | "author-route-collision" | "author-owner-mismatch") {
    super(code); this.name = "PairAuthorError";
  }
}
function fail(code: ConstructorParameters<typeof PairAuthorError>[0] = "author-input-mismatch"): never { throw new PairAuthorError(code); }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
function object(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
}
class AuthorReadFailure extends Error {
  constructor(readonly original: unknown) { super("Frozen author read failed"); }
}

/** Open only H-listed bytes. No database, current CODE, provider or storage
 * fallback is available at this private projection boundary. */
export async function derivePublicReleasePairAuthors(context: PairAuthorContext) {
  try { return await deriveAuthors(context); }
  catch (error) {
    if (error instanceof AuthorReadFailure) throw error.original;
    if (error instanceof PairAuthorError) throw error;
    return fail();
  }
}
async function deriveAuthors(context: PairAuthorContext) {
  const pair = protocol.parsePublicReleasePair(context.pair), identity = views.parseViewIdentity(context.identity, pair);
  const root = inputs.parsePublicReleasePairInputRoot(context.root, pair);
  if (hash(JSON.stringify(root)) !== identity.inputManifestDigest || !same(root.scope, { kind: identity.kind,
    sourceOperationId: identity.sourceOperationId, sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest,
    contextSequence: identity.contextSequence }) || !root.entryFiles.includes("source-dependencies.json")) fail();
  const files = new Map(root.files.map(file => [file.name, file]));
  const reachable = new Set<string>(), pending = ["source-dependencies.json"];
  while (pending.length) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    const file = files.get(name); if (!file) fail("author-input-missing");
    reachable.add(name); pending.push(...file.dependencies);
  }
  const read = async (name: string, dependency = true): Promise<any> => {
    const file = files.get(name);
    if (!file || dependency && !reachable.has(name)) fail("author-input-missing");
    let bytes: Uint8Array;
    try { await context.checkpoint?.(); bytes = await context.readFrozenFile(name); } catch (error) {
      if (error instanceof work.PairExecutionError && error.code === "input-unavailable") return fail("author-input-missing");
      if (error instanceof work.PairExecutionError && error.code === "byte-mismatch") return fail();
      // Storage outages and cancellation keep the original classification so
      // staging recovery does not spend a valid view's bounded byte retries.
      throw new AuthorReadFailure(error);
    }
    if (bytes.length !== file.bytes || hash(bytes) !== file.digest) fail();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail(); }
  };
  if (!same(await read("source-dependencies.json"), { schemaVersion: 1 })) fail();
  const census = await read("source-census.json"), provenance = parsePublicReleasePairReplayProvenance(await read("reader-provenance.json", false));
  const receipt = baseline.parsePublicReleaseChangeBaseline(census?.baseline?.receipt);
  if (census.schemaVersion !== 1 || census.kind !== "pair-public-source-census" || !same(census.cursor, root.cursor) ||
      census.baseline.logBaselineDigest !== protocol.publicReleaseDigest(receipt) ||
      protocol.publicReleaseDigest(census.baseline.sourceMembers) !== receipt.sourceMemberCensusDigest ||
      !Array.isArray(census.documents) || census.documents.length > 20_000 || !Array.isArray(census.changes) || census.changes.length > 10_000 ||
      provenance.pair.environment !== pair.environment) fail();
  const bodies = new Map<string, any>();
  const body = async (digest: string, name = `sources/${digest}.json`) => {
    if (!/^[a-f0-9]{64}$/.test(digest) || name !== `sources/${digest}.json`) fail();
    if (bodies.has(digest)) return bodies.get(digest);
    const value = await read(name);
    if (hash(canonical(value)) !== digest || value.schemaVersion !== 2 || !Array.isArray(value.documents) || value.documents.length > 100) fail();
    bodies.set(digest, value); return value;
  };
  const current = new Map<string, any>();
  let previous = "";
  for (const member of census.documents) {
    object(member);
    if (typeof member.path !== "string" || member.path <= previous) fail(); previous = member.path;
    const value = await body(member.contentDigest, member.bodyFile);
    const matches = value.documents.filter((document: any) => document.path === member.path && document.data !== null);
    if (matches.length !== 1) fail(); current.set(member.path, matches[0].data);
  }
  // Reconstruct public author membership and every previously owned route from
  // the complete baseline and contiguous history, including null tombstones.
  const historical = new Map<string, CmsAuthorBuildData>(), profiles = new Map<string, any>(), lastProfiles = new Map<string, any>();
  const remembered = new Map<string, Set<string>>();
  const applyAuthor = (value: any) => {
    for (const document of value.documents) if (typeof document.path === "string" && document.path.startsWith("cmsAuthorProfilesPublic/")) {
      const id = document.path.slice("cmsAuthorProfilesPublic/".length);
      if (document.data === null) { profiles.delete(id); continue; }
      const author = projectAuthorSnapshot(id, document.data);
      if (!author) fail();
      profiles.set(id, document.data); lastProfiles.set(id, document.data); historical.set(id, author);
      const paths = remembered.get(id) ?? new Set<string>();
      for (const path of [author.path, ...author.previousSlugs.map(authorPublicPath)]) paths.add(path);
      remembered.set(id, paths);
    }
  };
  if (!Array.isArray(census.baseline.sourceMembers) || census.baseline.sourceMembers.length > 10_000) fail();
  for (const member of census.baseline.sourceMembers) {
    const value = await body(member.contentDigest);
    if (!value.documents.some((document: any) => document.path === `${member.collection}/${member.id}` && document.data !== null)) fail();
    applyAuthor(value);
  }
  let cursor = receipt.baselineCursor;
  for (const event of census.changes) {
    const entry = log.parsePublicReleaseChange(event.entry), next = log.verifyPublicReleaseChangePage(cursor, [entry]);
    if (!Array.isArray(event.members) || event.members.length !== entry.changes.length) fail();
    for (let index = 0; index < entry.changes.length; index++) {
      const member = event.members[index], change = entry.changes[index], value = await body(member.contentDigest, member.bodyFile);
      if (!same(member.change, change) || value.kind !== change.kind || value.id !== change.id || value.action !== change.action ||
          value.sourceVersion !== change.sourceVersion || hash(canonical(value.snapshot)) !== change.snapshotDigest) fail();
      applyAuthor(value);
    }
    cursor = { baselineDigest: cursor.baselineDigest, ...next };
  }
  if (!same(cursor, root.cursor)) fail();
  const rawAuthors = [...current].filter(([path]) => path.startsWith("cmsAuthorProfilesPublic/"));
  if (rawAuthors.length !== profiles.size || rawAuthors.some(([path, value]) => !profiles.has(path.split("/")[1]) || !same(value, profiles.get(path.split("/")[1])))) fail();

  const code = await read("code-source.json");
  if (code.schemaVersion !== 1 || !Number.isSafeInteger(code.bytes) || code.bytes < 1 || code.bytes > 20 * 1024 * 1024 ||
      !Array.isArray(code.chunkFiles) || code.chunkFiles.length !== Math.ceil(code.bytes / PAIR_CODE_PACK_CHUNK_BYTES) || new Set(code.chunkFiles).size !== code.chunkFiles.length) fail();
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < code.chunkFiles.length; index++) chunks.push(decodePublicReleasePairCodePackChunk(await read(code.chunkFiles[index]),
    Math.min(PAIR_CODE_PACK_CHUNK_BYTES, code.bytes - index * PAIR_CODE_PACK_CHUNK_BYTES)));
  const codeBytes = Buffer.concat(chunks);
  if (hash(codeBytes) !== code.sha256) fail();
  const qualified = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(codeBytes));
  const reference = validateCurrentCodeReference(qualified.reference);
  if (!same(reference, code.reference) || !same(reference.publication, qualified.publication) ||
      reference.publication.commitSha !== provenance.rendererSha ||
      ["buildBatchId", "generation", "commitSha", "mediaManifestDigest"].some(key => qualified.publicContext?.receipt?.[key] !== reference.publication[key as keyof typeof reference.publication])) fail();
  const renderPlan = await read("render-plan.json", false), renderedAt = renderPlan.renderedAt;
  if (typeof renderedAt !== "string" || !Number.isFinite(Date.parse(renderedAt)) || new Date(renderedAt).toISOString() !== renderedAt) fail();
  const now = new Date(renderedAt), authors = rawAuthors.map(([path, value]) => projectAuthorSnapshot(path.split("/")[1], value)!);
  try { assertAuthorRouteUniqueness(authors); } catch { return fail("author-route-collision"); }
  const assets = new Map([...current].filter(([path]) => path.startsWith("media_assets_public/")).map(([path, value]) => [path.split("/")[1], value]));
  const posts: NonNullable<ReturnType<typeof projectCmsPost>>[] = [];
  for (const [path, document] of current) if (path.startsWith("cmsPosts/") && document?.published?.metadata?.type === "post") {
    const post = projectCmsPost({ ...document, id: path.split("/")[1] }, { now, assets });
    if (post) posts.push(post);
  }
  assertPostRouteUniqueness(posts);
  const chrome = projectChrome(chromeProjection.projectPublishedChromeRecords(current, now));
  const sourceCensusDigest = files.get("source-census.json")!.digest, readerProvenanceDigest = files.get("reader-provenance.json")!.digest;
  const routes = new Map<string, PairAuthorRoute>();
  const add = (route: PairAuthorRoute) => { if (routes.has(route.path)) fail("author-route-collision"); routes.set(route.path, Object.freeze(route)); };
  for (const [id, paths] of remembered) {
    const author = authors.find(value => value.authorId === id), last = author ?? historical.get(id)!;
    const owner: PairAuthorOwner = Object.freeze({ authorId: id, sourceVersion: last.sourceVersion,
      snapshotDigest: protocol.publicReleaseDigest(lastProfiles.get(id)), canonicalPath: last.path, sourceCensusDigest, readerProvenanceDigest });
    const active = new Set(author ? [author.path, ...author.previousSlugs.map(authorPublicPath)] : []);
    for (const path of paths) {
      const status = !active.has(path) ? 410 : path === author!.path ? 200 : 308;
      add({ path, status, contentType: "text/html; charset=utf-8", location: status === 308 ? author!.path : null, owner });
    }
  }
  const content = (path: string): PairAuthorContent => {
    const route = routes.get(path), author = authors.find(author => author.authorId === route?.owner.authorId);
    if (!route || !author || route.status !== 200) return fail("author-owner-mismatch");
    return Object.freeze({ kind: "public-pair-author", target: { documentId: author.authorId, sourceVersion: author.sourceVersion,
      rendererSha: pair.commitSha, pagePath: path }, posts, pages: [], authors, programs: [], events: [], recordCards: [], ...chrome });
  };
  return Object.freeze({ pair, identity, root, routes: Object.freeze([...routes.values()].sort((a, b) => a.path < b.path ? -1 : 1)), content,
    source: Object.freeze({ codeSourceDigest: code.sha256, sourceCensusDigest, readerProvenanceDigest, renderedAt }) });
}

/** Compare the full exact roster, so an omitted author or withdrawal refuses. */
export function assertPublicReleasePairAuthorRoster(rows: readonly { path: string; status: number; mime: string; owner?: unknown }[], routes: readonly PairAuthorRoute[]) {
  if (rows.length !== routes.length) fail("author-owner-mismatch");
  for (let index = 0; index < routes.length; index++) {
    const row = rows[index], route = routes[index];
    if (row.path !== route.path || row.status !== route.status || row.mime !== route.contentType || !row.owner || !same(row.owner, route.owner)) fail("author-owner-mismatch");
  }
}
