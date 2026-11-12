import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairRenderRoute } from "./public-release-pair-render-plan";
import type { HomeSourceSnapshot } from "../src/lib/home-sources";
import protocol from "../../functions/lib/public-release-pair.js";
import views from "../../functions/lib/public-release-pair-view.js";
import work from "../../functions/lib/public-release-pair-execution.js";
import { parsePublicReleasePairRenderRequest } from "./public-release-pair-render-request";
import { projectPublishedPostRead, type PublishedPostContent } from "../src/lib/published-post-shadow";
import { projectPublishedPageRead, type PublishedPageContent } from "../src/lib/published-page-render";
import { projectPublicPageContextRead, type PublicPageContextContent } from "../src/lib/public-page-context-render";
import { projectPublishedRecordRead, projectPublishedRecordRoute, type PublishedRecordContent } from "../src/lib/published-record-render";
import { projectPageScheduleInputs } from "../src/lib/published-page-render";
import { assertFrozenReplayRequest, rederiveFrozenReplaySchedule, PairReplayFrozenInputError, type FrozenReplayFileReader } from "./public-release-pair-replay-inputs";
import { ProgramImagePreparationError } from "../src/lib/published-record-images";

export const PAIR_REPLAY_PROVENANCE_FILE = "reader-provenance.json";
export type PairReplayProvenance = Readonly<{ schemaVersion: 1; pair: PublicReleasePair; rendererSha: string;
  readerContractDigest: string; readerReceiptDigest: string }>;
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Captured by the source owner from the registered original pair, never from
 * a caller label or the target pair. H verifies this file's actual byte hash. */
export function parsePublicReleasePairReplayProvenance(value: unknown): PairReplayProvenance {
  if (!object(value) || Object.keys(value).sort().join(",") !== "pair,readerContractDigest,readerReceiptDigest,rendererSha,schemaVersion" ||
      value.schemaVersion !== 1) refuse();
  const pair = protocol.parsePublicReleasePair(value.pair);
  work.assertPrivatePairResources(pair);
  if (value.rendererSha !== pair.commitSha || value.readerContractDigest !== pair.readerContractDigest ||
      value.readerReceiptDigest !== pair.readerReceiptDigest) refuse();
  return Object.freeze({ schemaVersion: 1, pair, rendererSha: pair.commitSha,
    readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest });
}

type Content = PublishedPostContent | PublishedPageContent | PublicPageContextContent | PublishedRecordContent;
export type PairReplayContext = {
  pair: PublicReleasePair; identity: PairTaskIdentity; route: PairRenderRoute; request: unknown; provenance: unknown;
  inputDigest: string; provenanceDigest: string; renderedAt: string; homeSources?: HomeSourceSnapshot;
  readFrozenFile?: FrozenReplayFileReader;
};
export function assertPublicReleasePairReplayInput(context: PairReplayContext) {
  const { route, inputDigest, provenanceDigest, renderedAt } = context;
  const pair = protocol.parsePublicReleasePair(context.pair), identity = views.parseViewIdentity(context.identity, pair);
  const provenance = parsePublicReleasePairReplayProvenance(context.provenance);
  if (provenance.pair.environment !== pair.environment || !/^[a-f0-9]{64}$/.test(inputDigest) || !/^[a-f0-9]{64}$/.test(provenanceDigest) ||
      route.dependencies.find(file => file.name === route.inputFile)?.digest !== inputDigest ||
      route.dependencies.find(file => file.name === PAIR_REPLAY_PROVENANCE_FILE)?.digest !== provenanceDigest ||
      typeof renderedAt !== "string" || !Number.isFinite(Date.parse(renderedAt)) || new Date(renderedAt).toISOString() !== renderedAt) refuse();
  const request = parsePublicReleasePairRenderRequest(context.request, route);
  if (!object(request.read)) refuse();
  const input = request.read, originalSha = provenance.rendererSha, sourceSeal = input.sourceSeal;
  if (sourceSeal !== undefined && (!object(sourceSeal) || sourceSeal.rendererSha !== originalSha)) refuse();
  const pageId = route.renderer === "context" ? input.pageId : object(input.page) ? input.page.pageId : undefined;
  return { pair, identity, provenance, request, input, originalSha, sourceSeal, pageId };
}
export const isPublicReleasePairProjection = (renderer: string) => ["post", "page", "context", "record"].includes(renderer);

/** Run this only in verified NEW projector code over H-verified bytes. The
 * original read/sourceSeal is never rewritten. Projection validates the OLD
 * input identity first, then derives a distinct NEW target before rendering.
 * The receipt preserves the exact source pair incarnation and reader seals.
 * This supplies no current ownership, cursor advancement or public proof. */
export async function projectPublicReleasePairReplay(context: PairReplayContext) {
  const { pair, identity, provenance, request, input, originalSha, sourceSeal, pageId } = assertPublicReleasePairReplayInput(context);
  const { route, inputDigest, provenanceDigest, renderedAt, homeSources } = context;
  if (request.homeSourcesFile === null ? homeSources !== undefined : homeSources === undefined) refuse();
  if (context.readFrozenFile) {
    await assertFrozenReplayRequest(context.readFrozenFile, route.inputFile, inputDigest, context.request);
    await assertFrozenReplayRequest(context.readFrozenFile, PAIR_REPLAY_PROVENANCE_FILE, provenanceDigest, context.provenance);
    if (request.homeSourcesFile) {
      const descriptor = route.dependencies.find(file => file.name === request.homeSourcesFile);
      if (!descriptor) refuse();
      await assertFrozenReplayRequest(context.readFrozenFile, request.homeSourcesFile, descriptor.digest, homeSources);
    }
  }
  let projectionInput = input;
  if (["page", "context"].includes(route.renderer) && ["schedule", "live"].includes(String(pageId)) && originalSha !== pair.commitSha) {
    if (!input.schedule) throw new PairReplayFrozenInputError("replay-frozen-schedule-missing");
    try { await projectPageScheduleInputs(input, String(pageId), originalSha); }
    catch { throw new PairReplayFrozenInputError("replay-frozen-schedule-mismatch"); }
    projectionInput = { ...input, schedule: await rederiveFrozenReplaySchedule(input, originalSha, context.readFrozenFile) };
  }
  const now = new Date(renderedAt);
  let projected: Content | null;
  if (route.renderer === "post") {
    const slug = route.path.match(/^\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/)?.[1];
    if (!slug) refuse();
    projected = projectPublishedPostRead(input, slug, originalSha, now);
  } else if (route.renderer === "page") {
    if (typeof pageId !== "string") refuse();
    projected = await projectPublishedPageRead(projectionInput, pageId, originalSha, now, homeSources);
  } else if (route.renderer === "context") {
    projected = await projectPublicPageContextRead(projectionInput, originalSha, now, { homeSources });
  } else if (route.renderer === "record") {
    try { projected = await projectPublishedRecordRead(input, route.path, originalSha, now); }
    catch (error) {
      if (error instanceof ProgramImagePreparationError) throw new PairReplayFrozenInputError(
        input.programImageDescriptors === undefined ? "replay-frozen-program-images-missing" : "replay-frozen-program-images-mismatch");
      throw error;
    }
  } else refuse();
  if (!projected || projected.target.pagePath !== route.path) refuse();
  const content = Object.freeze({ ...projected, target: Object.freeze({ ...projected.target, rendererSha: pair.commitSha }) }) as Content;
  const receipt = freeze({ schemaVersion: 1 as const, kind: "pair-render-target" as const,
    identityDigest: protocol.publicReleaseDigest(identity), inputManifestDigest: identity.inputManifestDigest,
    path: route.path, method: route.method,
    source: { pair: protocol.publicReleasePairReference(provenance.pair), pairDigest: protocol.publicReleaseDigest(provenance.pair),
      rendererSha: originalSha, readerContractDigest: provenance.readerContractDigest, readerReceiptDigest: provenance.readerReceiptDigest,
      inputDigest, provenanceDigest, sourceSealDigest: sourceSeal === undefined ? null : protocol.publicReleaseDigest(sourceSeal) },
    target: { pair: protocol.publicReleasePairReference(pair), pairDigest: protocol.publicReleaseDigest(pair), rendererSha: pair.commitSha,
      rendererDigest: pair.rendererDigest, readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest,
      projection: { kind: content.kind, target: content.target },
      targetDigest: protocol.publicReleaseDigest({ kind: content.kind, target: content.target }) } });
  return Object.freeze({ content, receipt });
}

export type PairReplayTargetReceipt = Awaited<ReturnType<typeof projectPublicReleasePairReplay>>["receipt"];
/** Validate the child's small target identity against H's original read and
 * pair seals. Actual rendered bytes are bound separately by G readback. */
export function parsePublicReleasePairReplayTargetReceipt(value: unknown, context: PairReplayContext): PairReplayTargetReceipt {
  const { pair, identity, provenance, input, sourceSeal } = assertPublicReleasePairReplayInput(context);
  const { route } = context;
  if (!object(value) || !object(value.target) || !object(value.target.projection) || !object(value.target.projection.target)) refuse();
  const projection = value.target.projection, target = projection.target as Record<string, unknown>;
  const kinds = { post: "public-post-shadow", page: "public-page", context: "public-page-context", record: "public-record-family" };
  if (projection.kind !== kinds[route.renderer as keyof typeof kinds] || target.rendererSha !== pair.commitSha || target.pagePath !== route.path) refuse();
  let expected: Record<string, unknown>;
  const seal = object(sourceSeal) ? sourceSeal : {};
  if (route.renderer === "post") {
    if (!object(input.document) || !object(input.document.published)) refuse();
    expected = { documentId: input.document.id, sourceVersion: input.document.published.sourceVersion, rendererSha: pair.commitSha, pagePath: route.path };
  } else if (route.renderer === "page") {
    if (!object(input.page)) refuse();
    expected = { documentId: input.page.pageId, sourceVersion: input.page.sourceVersion, rendererSha: pair.commitSha, pagePath: route.path,
      contextRevision: seal.contextRevision, contextDigest: seal.contextDigest, ...(input.schedule ? { codeGeneration: seal.codeGeneration } : {}) };
  } else if (route.renderer === "context") {
    expected = { documentId: input.pageId, pagePath: route.path, rendererSha: pair.commitSha, contextRevision: seal.contextRevision,
      contextDigest: seal.contextDigest, codeGeneration: seal.codeGeneration, source: input.page ? "cms" : "site",
      ...(object(input.page) ? { sourceVersion: input.page.sourceVersion } : {}) };
  } else if (route.renderer === "record") {
    const projected = projectPublishedRecordRoute(input, route.path, new Date(context.renderedAt));
    if (!projected) refuse();
    const owner = projected.target;
    expected = { family: projected.family, documentId: owner ? ("programId" in owner ? owner.programId : owner.eventId) : null,
      sourceVersion: owner?.sourceVersion ?? null, pagePath: route.path, rendererSha: pair.commitSha,
      contextRevision: seal.contextRevision, contextDigest: seal.contextDigest, renderedAt: context.renderedAt };
  } else refuse();
  if (protocol.publicReleaseDigest(target) !== protocol.publicReleaseDigest(expected)) refuse();
  const expectedReceipt = {
    schemaVersion: 1, kind: "pair-render-target", identityDigest: protocol.publicReleaseDigest(identity), inputManifestDigest: identity.inputManifestDigest,
    path: route.path, method: route.method,
    source: { pair: protocol.publicReleasePairReference(provenance.pair), pairDigest: protocol.publicReleaseDigest(provenance.pair),
      rendererSha: provenance.rendererSha, readerContractDigest: provenance.readerContractDigest, readerReceiptDigest: provenance.readerReceiptDigest,
      inputDigest: context.inputDigest, provenanceDigest: context.provenanceDigest,
      sourceSealDigest: sourceSeal === undefined ? null : protocol.publicReleaseDigest(sourceSeal) },
    target: { pair: protocol.publicReleasePairReference(pair), pairDigest: protocol.publicReleaseDigest(pair), rendererSha: pair.commitSha,
      rendererDigest: pair.rendererDigest, readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest,
      projection: { kind: projection.kind, target: expected }, targetDigest: protocol.publicReleaseDigest({ kind: projection.kind, target: expected }) },
  };
  if (protocol.publicReleaseDigest(value) !== protocol.publicReleaseDigest(expectedReceipt)) refuse();
  return freeze(expectedReceipt) as PairReplayTargetReceipt;
}
