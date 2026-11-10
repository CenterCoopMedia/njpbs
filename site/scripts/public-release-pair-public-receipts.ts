import { createHash } from "node:crypto";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { publicPostReceiptIdentity } from "../../packages/content-core/src/public-post-receipt-identity";
import { contentLink } from "../../packages/content-core/src/content-link.ts";
import targets from "../../functions/lib/publication-target.js";
import work from "../../functions/lib/public-release-pair-work.js";
import visibility from "../../functions/lib/public-video-references.js";
import postState from "../../functions/lib/no-build-post-state.js";
import { canonicalPublicationReceipt } from "../src/lib/public-publication-receipt";
import { isPublicContentSlug, programPublicPath, eventPublicPath } from "../src/lib/public-content-routes";
import type { PairReplayTargetReceipt } from "./public-release-pair-replay";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
export class PairPublicReceiptError extends work.PairExecutionError {
  readonly reason = "pair-static-owner-receipt-unavailable";
  constructor() { super("input-unavailable"); this.name = "PairPublicReceiptError"; }
}
const json = (bytes: Uint8Array) => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); } };
/** The preparation receipt is a sealed NEW-code input. Public identity follows
 * the same ordered owner/context recipe as the live Worker after each operation. */
export async function derivePublicReleasePairPublicReceipts(options: { pair: PublicReleasePair; documents: ReadonlyMap<string, any>;
  baselinePublication: Uint8Array; baselineStatus: Uint8Array;
  targets: readonly { receipt: PairReplayTargetReceipt; status: number }[]; ownedPaths: ReadonlySet<string> }) {
  let baseline;
  try { baseline = canonicalPublicationReceipt(json(options.baselinePublication)); } catch { return refuse(); }
  const status = json(options.baselineStatus);
  if (baseline.commitSha !== options.pair.commitSha || status.schemaVersion !== 1 || status.buildBatchId !== baseline.buildBatchId ||
      status.generation !== baseline.generation || status.commitSha !== baseline.commitSha || !Array.isArray(status.routes) || status.routes.length > 10_000 ||
      JSON.stringify(status.collections) !== JSON.stringify(["cmsPages", "cmsPosts"])) refuse();
  const context = options.documents.get("system/publicDeployment/contexts/public"), admission = options.documents.get("system/noBuildPostAdmission");
  if (!Number.isSafeInteger(context?.revision) || context.revision < 1) refuse();
  const contextDigest = hash(`njpbs-public-context-v1:${context.revision}`);
  let capability;
  try { capability = postState.validateCapability(options.documents.get("system/publicDeployment/noBuildPosts/capability")); }
  catch { return refuse(); }
  const states = [...options.documents].filter(([path, value]) => /^system\/publicDeployment\/noBuildPostOwners\/[A-Za-z0-9_-]+$/.test(path) && value.operationId).map(([, state]) => state);
  const legacy = options.documents.get("system/publicDeployment/noBuildPosts/current");
  if (legacy?.operationId && !states.some(state => state.postId === legacy.postId)) states.push(legacy);
  const ids = new Set<string>();
  const posts = states.map(retainedState => {
    let state;
    try { state = postState.effectiveNoBuildPostState(retainedState, capability); } catch { return refuse(); }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(state.postId) || ids.has(state.postId) || !/^[A-Za-z0-9]{20}$/.test(state.operationId) ||
        ![undefined, "dynamic", "static"].includes(state.mode) || !Number.isSafeInteger(state.generation) || state.generation < 1 ||
        !Number.isSafeInteger(state.sourceVersion) || state.sourceVersion < 1 || typeof state.visible !== "boolean" ||
        !isPublicContentSlug(state.slug) || !Array.isArray(state.ownedSlugs) || !state.ownedSlugs.includes(state.slug) ||
        !state.ownedSlugs.every(isPublicContentSlug) || new Set(state.ownedSlugs).size !== state.ownedSlugs.length ||
        state.snapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(state.snapshotDigest) ||
        state.datasetFiguresDigest !== undefined && (!/^[a-f0-9]{64}$/.test(state.datasetFiguresDigest) || !state.snapshotDigest)) refuse();
    ids.add(state.postId);
    const document = options.documents.get(`cmsPosts/${state.postId}`);
    if (state.mode === "static") {
      const snapshot = document?.published, metadata = snapshot?.metadata;
      if (metadata?.type !== "post" || !Number.isSafeInteger(snapshot?.sourceVersion) || snapshot.sourceVersion < 1 ||
          !isPublicContentSlug(metadata.slug) || metadata.previousSlugs !== undefined && !Array.isArray(metadata.previousSlugs)) refuse();
      const currentSlugs = [metadata.slug, ...(metadata.previousSlugs ?? [])];
      const visible = visibility.publiclyVisible(document);
      if (currentSlugs.length > 100 || !currentSlugs.every(isPublicContentSlug) || visible &&
          (!Number.isSafeInteger(document.version) || snapshot.sourceVersion > document.version ||
            Number.isSafeInteger(document.publicSourceVersion) && snapshot.sourceVersion < document.publicSourceVersion)) refuse();
      const ownedSlugs = [...new Set<string>([...state.ownedSlugs, ...currentSlugs])].sort();
      if (ownedSlugs.length > 100) refuse();
      const link = visible ? contentLink(metadata, `/posts/${metadata.slug}/`) : null;
      // currentStaticInput derives these fields from the current frozen
      // document; a static owner's retained source version/slug may be older.
      return { schemaVersion: 1, postId: state.postId, operationId: state.operationId, generation: state.generation,
        sourceVersion: snapshot.sourceVersion, visible, slug: metadata.slug, ownedSlugs,
        rendererSha: options.pair.commitSha, mode: "static", contextDigest,
        ...(link?.external ? { contentRedirectUrl: link.href } : {}) };
    }
    if (document?.published?.sourceVersion !== state.sourceVersion || document.published.metadata?.slug !== state.slug) refuse();
    if (!Number.isSafeInteger(admission?.revision) || admission.revision < 1) refuse();
    return { schemaVersion: 1, postId: state.postId, operationId: state.operationId, rendererSha: options.pair.commitSha,
      sourceVersion: state.sourceVersion, slug: state.slug, ownedSlugs: state.ownedSlugs, visible: state.visible,
      admissionRevision: admission.revision, contextDigest,
      ...(state.snapshotDigest ? { snapshotDigest: state.snapshotDigest } : {}), ...(state.datasetFiguresDigest ? { datasetFiguresDigest: state.datasetFiguresDigest } : {}),
      generation: state.generation };
  });
  const pointer = options.documents.get("system/publicDeployment");
  // A sole static owner serves exact receipt files from its static proof; it
  // never runs the Post catalog identity recipe. H currently retains owner
  // authority but not those proof files. Refuse instead of inventing identity.
  const soleStaticOwner = posts.length === 1 && "mode" in posts[0] && posts[0].mode === "static";
  if (soleStaticOwner) throw new PairPublicReceiptError();
  const generation = posts.length === 1 ? posts[0].generation : Math.max(pointer?.activeGeneration ?? 0, ...posts.map(post => post.generation));
  const identity = posts.length ? await publicPostReceiptIdentity({ posts, workerName: targets.publicationTarget(options.pair.environment).workerName,
    rendererSha: options.pair.commitSha, contextDigest, admissionRevision: soleStaticOwner ? undefined : admission?.revision,
    generation, baseline }) : { schemaVersion: 1 as const, buildBatchId: baseline.buildBatchId, generation: baseline.generation, commitSha: baseline.commitSha };
  const routes: Array<{ path: string; source: "site" | "cms"; contentKey?: string; sourceVersion?: number }> = [];
  for (const row of status.routes) {
    if (!row || typeof row.path !== "string" || !/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/.test(row.path)) refuse();
    if (row.source === "site" && !options.ownedPaths.has(row.path)) routes.push({ path: row.path, source: "site" });
  }
  const keys = new Set<string>();
  for (const { receipt, status } of options.targets) {
    if (status !== 200 && status !== 302) continue;
    const projection = receipt.target.projection, target = projection.target as Record<string, any>;
    if (projection.kind === "public-page-context" && target.source === "site" || projection.kind === "public-record-family" && target.documentId === null) { routes.push({ path: receipt.path, source: "site" }); continue; }
    if (typeof target.documentId !== "string" || !Number.isSafeInteger(target.sourceVersion)) continue;
    if (projection.kind === "public-record-family") {
      const snapshot = options.documents.get(`cmsPosts/${target.documentId}`)?.published, metadata = snapshot?.metadata;
      const kind = target.family === "programs" ? "program" : target.family === "events" ? "event" : null;
      if (!kind || metadata?.type !== kind || !isPublicContentSlug(metadata.slug) || snapshot.sourceVersion !== target.sourceVersion) refuse();
      const canonical = kind === "program" ? programPublicPath(metadata.slug) : eventPublicPath(metadata.slug);
      if (receipt.path !== canonical) continue;
    }
    const key = hash(`${["public-page", "public-page-context"].includes(projection.kind) ? "cmsPages" : "cmsPosts"}/${target.documentId}`);
    // Record aliases share an owner; only its canonical target enters Admin's
    // one-contentKey inventory. The renderer's target receipt owns that path.
    if (keys.has(key)) continue;
    keys.add(key); routes.push({ path: receipt.path, source: "cms", contentKey: key, sourceVersion: target.sourceVersion });
  }
  routes.sort((a, b) => a.path.localeCompare(b.path));
  if (routes.length > 10_000 || new Set(routes.map(route => route.path)).size !== routes.length) refuse();
  return [{ path: "/_publication.json", mime: "application/json; charset=utf-8", bytes: new TextEncoder().encode(JSON.stringify(identity)) },
    { path: "/_content-status.json", mime: "application/json; charset=utf-8", bytes: new TextEncoder().encode(JSON.stringify({ ...identity, collections: ["cmsPages", "cmsPosts"], routes })) }];
}
