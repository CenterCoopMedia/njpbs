import { contentLink } from "../../packages/content-core/src/content-link.ts";
import { PAIR_SEARCH_INPUTS_FILE, derivePublicReleasePairSearchInputs, parsePublicReleasePairSearchInputs, publicReleasePairSearchInputDescriptor, PairSearchInputsError, type PairSearchInputs } from "./public-release-pair-search-inputs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { assertContextMatchesPublication } from "../src/lib/retained-public-context";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { homeHeroNeedsPageRefresh } from "../../packages/content-core/src/home-hero";
import { projectPublicPageContextRead } from "../src/lib/public-page-context-render";
import { projectPublishedRecordRoute, recordPaths } from "../src/lib/published-record-render";
import type { Firestore, Transaction, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseChange } from "../../packages/content-core/src/public-release";
import type { PairInputScope, PairInputSource } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import log from "../../functions/lib/public-release-change-log.js";
import producer from "../../functions/lib/public-release-producer.js";
import input from "../../functions/lib/public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { capturePublicReleasePairInput, openPublicReleasePairInput, publicReleasePairSourceInputPath } from "./public-release-pair-input-storage";
import { PAIR_RENDER_PLAN_FILE, parsePublicReleasePairRenderPlan, type PairRenderRoute } from "./public-release-pair-render-plan";
import sourceLimits from "../../functions/lib/public-release-source-limits.js";
import historical, { type HistoricalPublicReleaseState } from "../../functions/lib/public-release-historical-state.js";
import { createHistoricalPublicReleaseReader } from "./public-release-pair-historical-reader";
import { derivePublicReleasePairCodePack, PAIR_CODE_PACK_FILE, PAIR_CODE_PACK_CHUNK_BYTES,
  publicReleasePairCodePackChunkCount, publicReleasePairCodePackChunkName, encodePublicReleasePairCodePackChunk, PairCodePackError } from "./public-release-pair-code-pack";
import { persistPublicReleasePairCodePackBaseline, readFrozenPublicReleasePairCodePackManifest, publicReleasePairCodePackBaselinePath } from "./public-release-pair-code-pack-storage";
import { publicReleasePairSourceInputsBytes, PAIR_SOURCE_INPUTS_PACK_PATH, PairSourceInputsError } from "./public-release-pair-source-inputs";
import { freezePublicReleaseSourceDependencies, publicReleasePairFrozenSourceCensus } from "./public-release-pair-frozen-sources";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { projectPublicReleasePairSourceCensusDocuments, PAIR_SOURCE_METADATA_FILE } from "./public-release-pair-source-census";
import { preparePublicReleasePairMediaPin, preparePublicReleasePairMediaPinInTransaction,
  retainPreparedPublicReleasePairMediaPin, preparePublicReleasePairCodeMediaPin } from "./public-release-pair-media-pin";

const require = createRequire(import.meta.url);
const postReader = require("../../functions/published-post-reader.js");
const pageReader = require("../../functions/lib/no-build-page-render-context.js");
const recordReader = require("../../functions/lib/no-build-record-source.js");
const pages = require("../../functions/lib/no-build-page-ownership.js");
const records = require("../../functions/lib/no-build-record-ownership.js");
const { publiclyVisible } = require("../../functions/lib/public-video-references.js");
const { PUBLIC_CONTEXT_PATH } = require("../../functions/lib/public-context-revision.js");
const { publicationTarget } = require("../../functions/lib/publication-target.js");
const { publicPagePath, PUBLIC_PAGE_DEFINITIONS } = require("../../functions/lib/public-page-contract.js");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(producer.publicReleaseSnapshotJson(value, input.INPUT_FILE_BYTES_LIMIT));
const same = (a: unknown, b: unknown) => producer.publicReleaseSnapshotJson(a) === producer.publicReleaseSnapshotJson(b);
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
const bounded = async (transaction: Transaction, firestore: Firestore, collection: string, query: Query = firestore.collection(collection)) => {
  const rows = await transaction.get(query.limit(input.INPUT_FILE_LIMIT + 1));
  if (rows.size > input.INPUT_FILE_LIMIT) refuse();
  return rows.docs;
};

const identified = async (transaction: Transaction, firestore: Firestore, collection: string, ids: string[]) => {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await transaction.getAll(...unique.map(id => firestore.doc(`${collection}/${id}`)));
  return rows.filter(row => row.exists) as QueryDocumentSnapshot[];
};

/** Verify every member of the real accepted operation. Caller hints never
 * provide its source, version, snapshot, member list or log cursor. */
async function readAcceptance(firestore: Firestore, transaction: Transaction, operationId: string) {
  const operationRef = firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations/${operationId}`);
  const operation = (await transaction.get(operationRef)).data();
  if (!operation || !Number.isSafeInteger(operation.sequence) || operation.sequence < 1) refuse();
  const row = await transaction.get(firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(operation.sequence).padStart(16, "0")}`));
  const entry = log.parsePublicReleaseChange(row.data());
  if (entry.operationId !== operationId || entry.entryDigest !== operation.entryDigest ||
      protocol.publicReleaseDigest(log.parsePublicReleaseChangeInput({ operationId, pair: entry.pair,
        contextRevision: entry.contextRevision, changes: entry.changes })) !== operation.inputDigest) refuse();
  const rows = await transaction.getAll(...entry.changes.map(change =>
    firestore.doc(producer.publicReleaseMemberPath(operationId, change.kind, change.id))));
  const members = rows.map((row, index) => {
    const evidence = row.data(), change = entry.changes[index];
    if (!evidence || evidence.schemaVersion !== 2 || evidence.operationId !== operationId || evidence.sequence !== entry.sequence ||
        evidence.entryDigest !== entry.entryDigest || !same(evidence.change, change) ||
        typeof evidence.json !== "string" || hash(evidence.json) !== change.snapshotDigest) refuse();
    const snapshot = JSON.parse(evidence.json);
    if (producer.publicReleaseSnapshotJson(snapshot) !== evidence.json) refuse();
    return { change, snapshot };
  });
  for (const { change, snapshot } of members) {
    let current: unknown;
    if (["post", "page", "record"].includes(change.kind)) {
      const collection = change.kind === "page" ? "cmsPages" : "cmsPosts";
      const document = (await transaction.get(firestore.doc(`${collection}/${change.id}`))).data();
      if (!document || publiclyVisible(document) !== (change.action !== "withdraw")) refuse();
      current = document.published;
      const ownerPath = change.kind === "page" ? `${pages.PAGE_OWNER_COLLECTION}/${change.id}` : change.kind === "record"
        ? `${records.RECORD_OWNER_COLLECTION}/${change.id}` : `system/publicDeployment/noBuildPostOwners/${change.id}`;
      const owner = (await transaction.get(firestore.doc(ownerPath))).data();
      if (owner?.operationId && owner.operationId !== operationId) refuse();
    } else if (change.kind === "settings") {
      current = (await transaction.get(firestore.doc(`cmsSettings/${change.id}`))).data()?.published;
    } else if (change.kind === "media" || change.kind === "author") {
      current = (await transaction.get(firestore.doc(`${change.kind === "media" ? "media_assets_public" : "cmsAuthorProfilesPublic"}/${change.id}`))).data() ?? null;
    } else if (change.kind === "library") {
      const document = (await transaction.get(firestore.doc(`cmsPosts/${change.id}`))).data();
      const history = await transaction.get(firestore.collection("cmsVersionHistory").where("collection", "==", "cmsPosts").where("documentId", "==", change.id));
      current = require("../../functions/lib/joined-records.js").shapeJoinedRecord(change.id, document,
        history.docs.map(row => row.data()))?.approvedLibraryVersion ?? null;
    } else if (change.id === "public-code") {
      if (snapshot.codeReference?.kind === "pair") {
        await require("../../functions/lib/public-release-pair-code-reference.js").assertPairCodeReferenceInTransaction({
          firestore, transaction, reference: snapshot.codeReference });
      } else if (snapshot.codeReference?.schemaVersion === 2) refuse();
      const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
      current = { commitSha: pointer?.activeCommitSha, generation: pointer?.activeGeneration, deploymentId: pointer?.activeDeploymentId,
        ...(snapshot.codeReference ? { codeReference: snapshot.codeReference } : {}) };
    } else {
      const context = (await transaction.get(firestore.doc(PUBLIC_CONTEXT_PATH))).data();
      current = change.kind === "schedule" ? context?.externalInputs?.schedulePacket : context?.externalInputs;
    }
    if (!same(current, snapshot)) refuse();
  }
  const acceptedAt = rows[0].createTime?.toMillis();
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt! < 1 || rows.some(row => row.createTime?.toMillis() !== acceptedAt)) refuse();
  return { entry, members, acceptedAt: acceptedAt! };
}

type FrozenRoute = { path: string; renderer: PairRenderRoute["renderer"]; read: unknown; homeSources: unknown; status: 200 | 302 | 308 | 410 };
type SourceOptions = { firestore: Firestore; pair: PublicReleasePair; sourceOperationId: string;
  kind?: PairInputScope["kind"]; clock?: () => number; signal?: AbortSignal;
  currentCodeRequest?: typeof fetch; resourceRequest?: typeof fetch; providerStore: PairViewStore; codeStore?: PairViewStore; contentStore?: Pick<PairViewStore, "get"> };

async function immutableBytes(store: PairViewStore, key: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const object = await store.get(key);
  if (!object || object.size > input.INPUT_FILE_BYTES_LIMIT) refuse();
  const reader = object.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > object.size) refuse();
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  if (size !== object.size) refuse();
  return new Uint8Array(Buffer.concat(chunks));
}

/** A source owner freezes complete deployed-reader projections at one server
 * read-time. Renderers later open only H's immutable pack. No latest reads,
 * caller inventory, caller cursor or replacement source are accepted. */
export async function derivePublicReleasePairInput(options: SourceOptions) { return derivePairInput(options); }
async function derivePairInput(options: SourceOptions, retained?: HistoricalPublicReleaseState, extra?: {
  pack: Awaited<ReturnType<typeof readFrozenPublicReleasePairCodePackManifest>>;
  dependencies: Awaited<ReturnType<typeof freezePublicReleaseSourceDependencies>>;
  initialControls?: unknown;
}, projection?: { global: true; prefix: string; resourceFiles: ReadonlyMap<string, { bytes: Uint8Array; dependencies: string[] }> }) {
  const { firestore, providerStore, sourceOperationId, signal } = options;
  const pair = protocol.parsePublicReleasePair(options.pair);
  work.assertPrivatePairResources(pair);
  if (!require("../../functions/lib/public-deployment-pointer.js").isPublicDeploymentIdentifier(sourceOperationId)) refuse();
  const captureTime = (options.clock ?? Date.now)();
  if (!Number.isFinite(captureTime)) refuse();
  const target = publicationTarget(pair.environment);
  // Qualified Schedule capture contains its own live authority recheck inside
  // the final read transaction. Its original CODE/provider identity stays intact.
  const retainedAcceptance = retained ? { entry: retained.event?.entry ?? null,
    members: retained.event?.members ?? retained.baselineMembers.map(member => {
      const body = retained.sourceBodies.get(member.contentDigest); if (!body) refuse();
      return { change: { kind: body.kind, id: body.id, action: body.action, sourceVersion: body.sourceVersion,
        snapshotDigest: hash(encode(body.snapshot)) }, snapshot: body.snapshot };
    }), acceptedAt: Date.parse(retained.renderedAt) } : null;
  const initialAcceptance = retainedAcceptance ?? await firestore.runTransaction(transaction => readAcceptance(firestore, transaction, sourceOperationId), { readOnly: true });
  const globalCapture = !!projection?.global || !!retained && !retained.event || initialAcceptance.members.some(({ change }) => !["post", "page", "record"].includes(change.kind));
  const needsSchedule = globalCapture || initialAcceptance.members.some(({ change }) =>
    change.kind === "page" && ["schedule", "live"].includes(change.id) && change.action !== "withdraw");
  let scheduleCapture: object | undefined;
  if (needsSchedule && retained) {
    const qualifiedCode = extra?.dependencies.qualifiedCode;
    if (!qualifiedCode) throw new HistoricalInputError("historical-code-authority-missing");
    assertContextMatchesPublication(qualifiedCode.publicContext, qualifiedCode.publication);
    scheduleCapture = await require("../../functions/lib/no-build-page-schedule-reader.js").captureHistoricalPageSchedule({
      firestore, target, rendererSha: retained.originalPair.commitSha, originalPair: retained.originalPair, qualifiedCode,
      storage: { get: async (key: string) => Buffer.from(await immutableBytes(providerStore, key, signal)), put: async () => { refuse(); } } });
  } else if (needsSchedule) scheduleCapture = await require("../../functions/lib/no-build-page-schedule-reader.js").capturePageSchedule({
    firestore, target, rendererSha: (await firestore.doc("system/publicDeployment").get()).data()?.activeCommitSha,
    request: options.currentCodeRequest });
  const postHomeOwner = initialAcceptance.members.some(({ change }) => change.kind === "post")
    ? (await firestore.doc("system/publicDeployment/noBuildPageOwners/home").get()).data() : null;
  const changedPages = initialAcceptance.members.filter(({ change }) => change.kind === "page").map(({ change }) => change.id);
  const pageHome = changedPages.length ? (await firestore.doc("cmsPages/home").get()).data() : null;
  const pagePinsNeedHome = homeHeroNeedsPageRefresh(pageHome?.published?.metadata?.homeHero, changedPages, captureTime);
  const needsHomeFrame = globalCapture || changedPages.includes("home") || pagePinsNeedHome ||
    !!postHomeOwner && (!!retained || postHomeOwner.homeRefresh?.sourceOperationId === sourceOperationId);
  let homeCodeCapture: object | undefined;
  if (needsHomeFrame && retained && extra?.dependencies.qualifiedCode?.publicContext?.homeSources) {
    homeCodeCapture = await require("../../functions/lib/no-build-page-home-code-capture.js").captureHistoricalPageHomeCodeSources({
      firestore, target, rendererSha: retained.originalPair.commitSha, originalPair: retained.originalPair, qualifiedCode: extra.dependencies.qualifiedCode });
  } else if (needsHomeFrame && !retained) homeCodeCapture = await require("../../functions/lib/no-build-page-home-code-capture.js").capturePageHomeCodeSourcesIfNeeded({
    firestore, target, request: options.currentCodeRequest, rendererSha: (await firestore.doc("system/publicDeployment").get()).data()?.activeCommitSha });
  const sourceReadOptions = { readProviderInput: extra?.dependencies.readProviderInput, strictPublicReleaseInputs: !!retained };
  const frozen = await firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const { entry, members, acceptedAt } = retainedAcceptance ?? await readAcceptance(firestore, transaction, sourceOperationId);
    if (acceptedAt > captureTime) refuse();
    const [headRow, pointerRow, contextRow] = await transaction.getAll(firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH),
      firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
    const head = log.parsePublicReleaseChangeHead(headRow.data());
    const renderedAt = headRow.updateTime?.toMillis();
    if (!Number.isSafeInteger(renderedAt) || renderedAt! < acceptedAt || renderedAt! > captureTime) refuse();
    const now = new Date(renderedAt!);
    const pointer = require("../../functions/lib/public-release-pair.js").parseVersionedPublicDeployment(pointerRow.data());
    if (entry && head.sequence < entry.sequence || pointer.state !== "idle" || !pointer.activeCommitSha ||
        !Number.isSafeInteger(contextRow.data()?.revision) || entry && contextRow.data()!.revision < entry.contextRevision) refuse();
    const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
    let readerPair = retained ? protocol.publicReleasePairReference(retained.originalPair) : entry!.pair;
    const activation = members.find(({ change }) => change.kind === "provider" && change.id === "public-code");
    if (activation && !retained) {
      // The accepted entry keeps its pre-activation owner. The consumed control
      // handover identifies the actual reader used after this exact activation.
      const control = (await transaction.get(firestore.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL))).data();
      const anchor = log.parsePublicReleaseChangeHead(control?.head);
      const next = protocol.parsePublicReleasePairReference(control?.pair);
      if (control?.schemaVersion !== 2 || control.enabled !== true || anchor.baselineDigest !== head.baselineDigest ||
          anchor.sequence !== entry!.sequence || anchor.lastDigest !== entry!.entryDigest ||
          next.commitSha !== activation.snapshot.commitSha || activation.change.sourceVersion !== pointer.activeGeneration) refuse();
      readerPair = next;
    }
    const originalPair = protocol.parsePublicReleasePair((await transaction.get(
      firestore.doc(work.publicReleasePairPath(readerPair.pairId)))).data());
    if (originalPair.commitSha !== pointer.activeCommitSha ||
        !same(protocol.publicReleasePairReference(originalPair), readerPair) ||
        pointer.schemaVersion === 2 && !same(pointer.selectedPair, readerPair)) refuse();
    const readerProvenance = { schemaVersion: 1, pair: originalPair, rendererSha: originalPair.commitSha,
      readerContractDigest: originalPair.readerContractDigest, readerReceiptDigest: originalPair.readerReceiptDigest };
    const routes = new Map<string, FrozenRoute>();
    const add = (route: FrozenRoute) => {
      if (routes.has(route.path)) refuse();
      routes.set(route.path, route.renderer === "withdrawal" ? { ...route, read: { kind: "withdrawn", path: route.path } } : route);
    };
    const global = globalCapture;
    const postIds = members.filter(member => member.change.kind === "post").map(member => member.change.id);
    const affectedPageIds = members.filter(member => member.change.kind === "page").map(member => member.change.id);
    const changedPageIds = [...affectedPageIds];
    if (postIds.length || changedPageIds.length) affectedPageIds.push("home");
    const posts = global ? await bounded(transaction, firestore, "cmsPosts", firestore.collection("cmsPosts")
      .where("published.metadata.type", "in", ["post", "program", "event"])) : await identified(transaction, firestore, "cmsPosts", postIds);
    const pageRows = global ? await bounded(transaction, firestore, "cmsPages", firestore.collection("cmsPages")
      .where("published.sourceVersion", ">", 0)) : await identified(transaction, firestore, "cmsPages", affectedPageIds);
    const pageOwners = global ? await bounded(transaction, firestore, pages.PAGE_OWNER_COLLECTION)
      : await identified(transaction, firestore, pages.PAGE_OWNER_COLLECTION, affectedPageIds);
    const postOwners = global ? await bounded(transaction, firestore, "system/publicDeployment/noBuildPostOwners")
      : await identified(transaction, firestore, "system/publicDeployment/noBuildPostOwners", postIds);
    const affectedFamilies = [...new Set(members.filter(member => member.change.kind === "record")
      .map(member => member.snapshot.metadata.type === "program" ? "programs" : "events"))];
    const recordOwners = global ? await bounded(transaction, firestore, records.RECORD_OWNER_COLLECTION) : affectedFamilies.length
      ? await bounded(transaction, firestore, records.RECORD_OWNER_COLLECTION,
        firestore.collection(records.RECORD_OWNER_COLLECTION).where("family", "in", affectedFamilies)) : [];
    const homeOwner = pageOwners.find(row => row.id === "home")?.data();
    const postChange = members.some(member => member.change.kind === "post");
    const homeRefresh = postChange ? (await transaction.get(firestore.doc(`cmsPublishQueue/${sourceOperationId}/homePageRefresh/home`))).data() : null;
    const dependentHome = retained ? postChange && !!homeOwner : postChange && homeOwner?.homeRefresh?.sourceOperationId === sourceOperationId;
    const pinnedPageHome = !!homeOwner && changedPageIds.length > 0 && homeHeroNeedsPageRefresh(
      pageRows.find(row => row.id === "home")?.data()?.published?.metadata?.homeHero, changedPageIds, now.getTime());
    if (!retained && (dependentHome && (!homeRefresh || homeRefresh.schemaVersion !== 1 || homeRefresh.owner !== "page-no-build-v1" ||
        homeRefresh.pageId !== "home" || homeRefresh.revision !== homeOwner?.homeRefresh?.revision ||
        homeRefresh.input?.sourceOperationId !== sourceOperationId || homeRefresh.input?.homeOperationId !== homeOwner?.operationId ||
        homeRefresh.input?.homeSourceVersion !== homeOwner?.sourceVersion) || homeRefresh && !dependentHome)) refuse();
    if (dependentHome && !retained) {
      if (!homeRefresh) refuse();
      const expected = members.filter(member => member.change.kind === "post").map(({ change }) => ({
        postId: change.id, sourceVersion: change.sourceVersion, visible: change.action !== "withdraw" })).sort((a, b) => a.postId < b.postId ? -1 : 1);
      const actual = homeRefresh.input.postChanges ?? [{ postId: homeRefresh.input.postId,
        sourceVersion: homeRefresh.input.sourceVersion, visible: homeRefresh.input.visible }];
      if (!same(actual, expected)) refuse();
    }
    const affected = (kind: string, id: string) => global || kind === "page" && id === "home" && (dependentHome || pinnedPageHome) ||
      members.some(member => member.change.kind === kind && member.change.id === id);
    for (const row of posts) {
      const document = row.data();
      if (!affected("post", row.id) || document.published?.metadata?.type !== "post") continue;
      const owner = postOwners.find(owner => owner.id === row.id)?.data();
      const slugs = [...new Set<string>([...(owner?.ownedSlugs ?? []), document.published.metadata.slug,
        ...(document.published.metadata.previousSlugs ?? [])])];
      if (!publiclyVisible(document)) {
        if (owner || affected("post", row.id) && !global) for (const slug of slugs) add({ path: `/posts/${slug}/`, renderer: "withdrawal", read: null, homeSources: null, status: 410 });
        continue;
      }
      const read = await postReader.readPublishedPost({ firestore, transaction, slug: document.published.metadata.slug, now });
      if (read.kind !== "published-post") refuse();
      const canonical = `/posts/${document.published.metadata.slug}/`;
      for (const slug of slugs) {
        const path = `/posts/${slug}/`;
        add(path === canonical ? { path, renderer: "post", read, homeSources: null, status: contentLink(document.published.metadata, canonical).external ? 302 : 200 }
          : { path, renderer: "redirect", read: { kind: "redirect", path, location: canonical }, homeSources: null, status: 308 });
      }
    }
    const pageIds = new Set([...pageRows.filter(row => affected("page", row.id) && row.data().published &&
      (row.id !== "home" || pageOwners.some(owner => owner.id === "home"))).map(row => row.id),
      ...pageOwners.filter(row => affected("page", row.id)).map(row => row.id)]);
    for (const pageId of [...pageIds].sort()) {
      const document = pageRows.find(row => row.id === pageId)?.data(), owner = pageOwners.find(row => row.id === pageId)?.data();
      const canonical = document?.published && publicPagePath(pageId, document.published.metadata);
      const paths = [...new Set<string>([...(owner?.ownedPaths ?? []), ...(canonical ? [canonical] : []),
        ...(document?.published?.metadata?.previousSlugs ?? []).map((slug: string) => `/${slug}/`),
        ...(PUBLIC_PAGE_DEFINITIONS[pageId]?.aliases ?? [])])];
      if (!document || !publiclyVisible(document)) {
        for (const path of paths) add({ path, renderer: "withdrawal", read: null, homeSources: null, status: 410 });
        continue;
      }
      const read = await pageReader.assertNoBuildPageContextInTransaction({ firestore, transaction, pageId,
        rendererSha: pointer.activeCommitSha, now, target, scheduleCapture, ...sourceReadOptions });
      const home = pageId === "home" ? await require("../../functions/lib/no-build-home-ownership.js").readHomeSourcesInTransaction({
        firestore, transaction, state: owner, rendererSha: pointer.activeCommitSha, target, homeCodeCapture,
        readHomeSource: ({ key }: { key: string }) => immutableBytes(providerStore, key, signal) }) : null;
      if (home?.needsBaseline) refuse();
      const homeCatalog = home ? (await projectPublishedPageRead(
        read, "home", pointer.activeCommitSha, now, home.homeSources, home.publication)).homeSources : null;
      if (home && !homeCatalog) refuse();
      for (const path of paths) add(path === canonical
        ? { path, renderer: "page", read, homeSources: home?.homeSources ?? null, status: contentLink(document.published.metadata, canonical!).external ? 302 : 200 }
        : pageId === "home" && path === "/_home-sources.json"
          ? { path, renderer: "json", read: homeCatalog, homeSources: home?.homeSources ?? null, status: 200 }
          : { path, renderer: "redirect", read: { kind: "redirect", path, location: canonical }, homeSources: null, status: 308 });
    }
    if (global) {
      // Settings/authors/provider changes also affect unowned committed frames.
      // A missing deployed reader/capability refuses the whole inventory.
      for (const [pageId, definition] of Object.entries(PUBLIC_PAGE_DEFINITIONS) as [string, { path: string; aliases?: string[] }][]) {
        if (pageIds.has(pageId)) continue;
        for (const path of [definition.path, ...(definition.aliases ?? []), ...(pageId === "home" ? ["/_home-sources.json"] : [])]) {
          const decision = await require("../../functions/lib/no-build-page-context-decision.js").readNoBuildPageContextDecision({
            firestore, transaction, path: pageId === "home" && path === "/_home-sources.json" ? "/" : path,
            rendererSha: pointer.activeCommitSha, now, target, scheduleCapture, ...sourceReadOptions });
          if (decision.kind === "redirect") add({ path, renderer: "redirect", read: { kind: "redirect", path, location: decision.location }, homeSources: null, status: 308 });
          else if (decision.kind === "context-page") {
            let sources = null, catalog = null;
            if (pageId === "home") {
              if (!homeCodeCapture) throw new HistoricalInputError("historical-code-authority-missing");
              sources = (await require("../../functions/lib/no-build-page-home-code-capture.js").readCapturedPageHomeCodeSourcesInTransaction({
                firestore, transaction, target, rendererSha: pointer.activeCommitSha, capture: homeCodeCapture })).homeSources;
              catalog = (await projectPublicPageContextRead(
                decision.renderContext, pointer.activeCommitSha, now, { homeSources: sources })).homeSources;
              if (!catalog) refuse();
            }
            add({ path, renderer: path === "/_home-sources.json" ? "json" : "context",
              read: path === "/_home-sources.json" ? catalog : decision.renderContext, homeSources: sources, status: path !== "/_home-sources.json" && contentLink((decision.renderContext as any).page ?? {}, path).external ? 302 : 200 });
          }
          else refuse();
        }
      }
    }
    const families = new Set<string>(recordOwners.filter(row => global || affected("record", row.data().documentId)).map(row => row.data().family));
    for (const { change, snapshot } of members) if (change.kind === "record") families.add(snapshot.metadata.type === "program" ? "programs" : "events");
    for (const family of [...families].sort()) {
      const captured = await recordReader.readPendingRecordFamilyInTransaction({ firestore, transaction, family,
        rendererSha: pointer.activeCommitSha, now, ...(pointer.schemaVersion === 2 ? { releaseSelector: pointer } : {}) });
      const catalog = extra?.dependencies.qualifiedCode?.originalProgramImageCatalog ?? extra?.dependencies.qualifiedCode?.publicContext?.programImageDescriptors;
      if (family === "programs" && catalog) captured.read.programImageDescriptors = structuredClone(catalog);
      const paths = new Set<string>([`/${family}/`, ...(family === "programs" ? ["/shows/"] : []),
        ...captured.sources.flatMap((source: { ownedPaths: string[] }) => source.ownedPaths)]);
      for (const owner of recordOwners.filter(row => row.data().family === family)) {
        if (owner.data().visible === false) for (const path of owner.data().ownedPaths) {
          add({ path, renderer: "withdrawal", read: null, homeSources: null, status: 410 }); paths.delete(path);
        }
      }
      const projected = projectPublishedRecordRoute(captured.read, `/${family}/`, now);
      if (!projected) refuse();
      // The live producer emits both indexes and every canonical/former-slug
      // record path as HTML. Edge legacy redirects are a separate boundary.
      const emitted = new Set([`/${family}/`, ...(family === "programs" ? ["/shows/"] : []),
        ...(family === "programs" ? projected.programs : projected.events).flatMap(record => recordPaths(projected.family, record))]);
      for (const path of paths) {
        if (!emitted.has(path)) refuse();
        add({ path, renderer: "record", read: captured.read, homeSources: null, status: 200 });
      }
    }
    if (!routes.size) refuse();
    const snapshot = retained && !retained.event ? retained.baselineMembers : members.length === 1 ? members[0].snapshot : members.map(({ change, snapshot }) => ({ change, snapshot }));
    const source: PairInputSource = retained && !retained.event ? { kind: "inventory", id: sourceOperationId } : members.length === 1 ? { kind: members[0].change.kind, id: members[0].change.id }
      : { kind: "inventory", id: sourceOperationId };
    return { entry, source, snapshot, cursor, readerProvenance, renderedAt: now.toISOString(), sourceVersion: Math.max(...members.map(({ change }) => change.sourceVersion)),
      routes: [...routes.values()].sort((a, b) => a.path < b.path ? -1 : 1),
      authority: { schemaVersion: 2, ...(entry ? { entry } : { baseline: retained!.receipt, logBaselineDigest: retained!.logBaselineDigest }), cursor,
        globalPaths: [...routes.keys()].sort(),
        members: members.map(({ change, snapshot }) => {
          if (!["post", "page", "record"].includes(change.kind)) return { change, pathScope: "global", paths: [], withdrawnPaths: [] };
          let paths = [...routes.keys()];
          if (change.kind === "post") {
            const owner = postOwners.find(row => row.id === change.id)?.data();
            const own = new Set([...(owner?.ownedSlugs ?? []), snapshot.metadata.slug, ...(snapshot.metadata.previousSlugs ?? [])].map(slug => `/posts/${slug}/`));
            paths = paths.filter(path => own.has(path) || dependentHome && ["/", "/_home-sources.json"].includes(path));
          } else if (change.kind === "page") {
            const owner = pageOwners.find(row => row.id === change.id)?.data();
            const own = new Set([...(owner?.ownedPaths ?? []), publicPagePath(change.id, snapshot.metadata),
              ...(snapshot.metadata.previousSlugs ?? []).map((slug: string) => `/${slug}/`), ...(PUBLIC_PAGE_DEFINITIONS[change.id]?.aliases ?? [])]);
            paths = paths.filter(path => own.has(path) || pinnedPageHome && ["/", "/_home-sources.json"].includes(path));
          }
          paths.sort();
          return { change, paths, withdrawnPaths: ["post", "page", "record"].includes(change.kind)
            ? paths.filter(path => routes.get(path)?.status === 410) : [] };
        }), readerSource: pointer.activeCommitSha, contextRevision: contextRow.data()!.revision,
        codeAssetManifestDigest: pair.codeAssetManifestDigest } };
  }, { readOnly: true });
  signal?.throwIfAborted();
  const files = sourceLimits.createHistoricalSourceInventory<{ bytes: Uint8Array; dependencies: string[] }>();
  const add = (name: string, value: unknown, dependencies: string[] = []) => { files.set(name, { bytes: name === "source-census.json" ? sourceLimits.encodeHistoricalSourceCensus(value) : encode(value), dependencies: [...dependencies].sort() }); };
  add("snapshot.json", frozen.snapshot);
  add("reader-provenance.json", frozen.readerProvenance);
  const bodyNames: string[] = [];
  if (retained) {
    for (const [digest, body] of retained.sourceBodies) { const name = `sources/${digest}.json`; add(name, body); bodyNames.push(name); }
    add(PAIR_SEARCH_INPUTS_FILE, derivePublicReleasePairSearchInputs(retained, extra!.dependencies), bodyNames);
    bodyNames.push(PAIR_SEARCH_INPUTS_FILE);
    add("source-census.json", publicReleasePairFrozenSourceCensus(retained), bodyNames);
    bodyNames.push("source-census.json");
    add(PAIR_SOURCE_METADATA_FILE, projectPublicReleasePairSourceCensusDocuments(retained.documents));
    if (extra?.initialControls) { add("initial-controls.json", extra.initialControls); bodyNames.push("initial-controls.json"); }
    bodyNames.push(PAIR_SOURCE_METADATA_FILE);
    add("baseline.json", { receipt: retained.receipt, logBaselineDigest: retained.logBaselineDigest, sourceMembers: retained.baselineMembers });
    bodyNames.push("baseline.json");
  }
  if (extra) {
    for (const [name, bytes] of extra.dependencies.files) { files.set(name, { bytes, dependencies: [] }); bodyNames.push(name); }
    files.set(PAIR_CODE_PACK_FILE, { bytes: extra.pack.bytes, dependencies: [] }); bodyNames.push(PAIR_CODE_PACK_FILE);
    add("code-pack-baseline.json", extra.pack.receipt); bodyNames.push("code-pack-baseline.json");
  }
  // Raw census/history is a separate H entry. Route DTOs already freeze their
  // renderer inputs; repeating the whole source graph per route is quadratic.
  if (bodyNames.length) add("source-dependencies.json", { schemaVersion: 1 }, bodyNames);
  const authorityFile = `${projection?.prefix ?? ""}authority.json`;
  add(authorityFile, frozen.authority);
  const resourceUrls = new Map<string, string>();
  const routeResourceUrls = new Map<string, Set<string>>();
  function images(value: any, prepared: ReadonlySet<string>, urls: Set<string>) {
    if (!value || typeof value !== "object") return;
    if (typeof value.url === "string" && /^image\//.test(value.mimeType) && !prepared.has(value.url)) {
      if (resourceUrls.has(value.url) && resourceUrls.get(value.url) !== value.mimeType) refuse();
      resourceUrls.set(value.url, value.mimeType); urls.add(value.url);
    }
    for (const [name, child] of Object.entries(value)) if (name !== "programImageDescriptors" && child && typeof child === "object") images(child, prepared, urls);
  }
  for (const route of frozen.routes) {
    const catalog = (route.read as { programImageDescriptors?: any } | null)?.programImageDescriptors;
    const prepared = new Set<string>((catalog?.programs ?? []).filter((program: any) => program.original.mimeType !== "image/gif").map((program: any) => program.original.url));
    const urls = new Set<string>(); routeResourceUrls.set(route.path, urls);
    images(route.read, prepared, urls); images(route.homeSources, new Set(), urls);
  }
  const resources: { url: string; file: string; contentType: string }[] = [];
  for (const [url, mime] of [...resourceUrls].sort(([a], [b]) => a < b ? -1 : 1)) {
    signal?.throwIfAborted();
    const file = `resources/${hash(url)}.json`;
    const retainedResource = projection?.resourceFiles.get(file);
    if (retainedResource) {
      files.set(file, retainedResource); resources.push({ url, file, contentType: mime }); continue;
    }
    const response = await (options.resourceRequest ?? fetch)(url, { signal, credentials: "omit", redirect: "error" });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== mime) refuse();
    const reader = response.body?.getReader();
    if (!reader) refuse();
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 8 * 1024 * 1024) refuse(); chunks.push(part.value); signal?.throwIfAborted(); } }
    finally { void reader.cancel().catch(() => {}); }
    add(file, { bodyBase64: Buffer.concat(chunks).toString("base64") });
    resources.push({ url, file, contentType: mime });
  }
  const routes = frozen.routes.map((route, index) => {
    const routeResources = resources.filter(resource => routeResourceUrls.get(route.path)!.has(resource.url));
    const resourceNames = routeResources.map(resource => resource.file);
    const inputFile = `${projection?.prefix ?? ""}routes/${String(index).padStart(6, "0")}.json`;
    let homeSourcesFile: string | null = null;
    if (route.homeSources) { homeSourcesFile = `${projection?.prefix ?? ""}home/${String(index).padStart(6, "0")}.json`; add(homeSourcesFile, route.homeSources); }
    const dependencies = ["snapshot.json", authorityFile, "reader-provenance.json", ...resourceNames, ...(homeSourcesFile ? [homeSourcesFile] : [])].sort();
    // Reader DTO digests (notably Schedule inputDigest) bind their original
    // JSON key order. Canonical source/snapshot bodies remain separate; never
    // recursively reorder the actual frozen reader request.
    files.set(inputFile, { bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, read: route.read, homeSourcesFile, resources: routeResources })), dependencies });
    return { path: route.path, method: "GET" as const, renderer: route.renderer, inputFile,
      dependencies: [...dependencies, inputFile].sort().map(name => ({ name, digest: hash(files.get(name)!.bytes) })) };
  });
  const snapshotDigest = hash(files.get("snapshot.json")!.bytes);
  if (frozen.entry && frozen.entry.changes.length === 1 && snapshotDigest !== frozen.entry.changes[0].snapshotDigest) refuse();
  const renderPlan = { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), snapshotDigest,
    renderedAt: frozen.renderedAt, routes, expectedOutputs: frozen.routes.map(route => ({ path: route.path, status: route.status,
      contentType: route.renderer === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8" })) };
  add(PAIR_RENDER_PLAN_FILE, renderPlan, [...new Set(routes.flatMap(route => route.dependencies.map(dependency => dependency.name)))].sort());
  const root = input.parsePublicReleasePairInputRoot({ schemaVersion: 2, kind: "pair-render-input", pairDigest: protocol.publicReleaseDigest(pair),
    source: frozen.source, scope: { kind: options.kind ?? "qualification", sourceOperationId, sourceVersion: frozen.sourceVersion,
      snapshotDigest, contextSequence: frozen.cursor.sequence }, cursor: frozen.cursor, snapshotFile: "snapshot.json",
    entryFiles: [PAIR_RENDER_PLAN_FILE, "snapshot.json", ...(bodyNames.length ? ["source-dependencies.json"] : [])].sort(), files: [...files].sort(([a], [b]) => a < b ? -1 : 1).map(([name, file]) => ({
      name, digest: hash(file.bytes), bytes: file.bytes.byteLength, objectKey: input.publicReleasePairInputObjectKey(pair, hash(file.bytes)), dependencies: file.dependencies })) }, pair);
  parsePublicReleasePairRenderPlan(renderPlan, root);
  return { pair, root, files, global: globalCapture };
}

export const PAIR_AGGREGATE_RENDER_PLAN_FILE = "aggregate-render-plan.json";
/** Source-owned full projection at the SAME reconstructed cursor. This helper
 * never selects a source, recaptures CODE or changes the ordinary snapshot. */
export async function derivePublicReleasePairAggregateRenderPlan(options: SourceOptions,
  state: HistoricalPublicReleaseState, extra: NonNullable<Parameters<typeof derivePairInput>[2]>,
  ordinary: Awaited<ReturnType<typeof derivePairInput>>) {
  const complete = ordinary.global ? ordinary : await derivePairInput({ ...options,
    firestore: createHistoricalPublicReleaseReader({ firestore: options.firestore, documents: state.documents,
      cursor: state.cursor, renderedAt: state.renderedAt }), providerStore: extra.dependencies.providerStore }, state, extra,
  { global: true, prefix: "aggregate/", resourceFiles: ordinary.files });
  const globalPlan = JSON.parse(new TextDecoder().decode(complete.files.get(PAIR_RENDER_PLAN_FILE)!.bytes));
  const ordinaryPlan = JSON.parse(new TextDecoder().decode(ordinary.files.get(PAIR_RENDER_PLAN_FILE)!.bytes));
  if (!same(complete.root.cursor, ordinary.root.cursor) || !same(state.cursor, ordinary.root.cursor) ||
      globalPlan.renderedAt !== ordinaryPlan.renderedAt || globalPlan.renderedAt !== state.renderedAt ||
      complete.root.scope.snapshotDigest !== ordinary.root.scope.snapshotDigest) refuse();
  const plan = { schemaVersion: 1, kind: "pair-aggregate-render-plan", pairDigest: ordinary.root.pairDigest,
    cursor: ordinary.root.cursor, renderedAt: globalPlan.renderedAt, routes: globalPlan.routes, expectedOutputs: globalPlan.expectedOutputs };
  const files = sourceLimits.createHistoricalSourceInventory(ordinary.files);
  for (const [name, file] of complete.files) {
    if ([PAIR_RENDER_PLAN_FILE, "source-dependencies.json"].includes(name)) continue;
    const before = files.get(name);
    if (before && (hash(before.bytes) !== hash(file.bytes) || !same(before.dependencies, file.dependencies))) refuse();
    files.set(name, file);
  }
  files.set(PAIR_AGGREGATE_RENDER_PLAN_FILE, { bytes: encode(plan),
    dependencies: complete.files.get(PAIR_RENDER_PLAN_FILE)!.dependencies });
  const source = files.get("source-dependencies.json"); if (!source) refuse();
  files.set("source-dependencies.json", { bytes: source.bytes,
    dependencies: [...source.dependencies, PAIR_AGGREGATE_RENDER_PLAN_FILE].sort() });
  const root = input.parsePublicReleasePairInputRoot({ ...ordinary.root, files: [...files].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([name, file]) => ({ name, digest: hash(file.bytes), bytes: file.bytes.length,
      objectKey: input.publicReleasePairInputObjectKey(ordinary.pair, hash(file.bytes)), dependencies: file.dependencies })) }, ordinary.pair);
  return { ...ordinary, root, files, aggregatePlan: plan };
}

export async function captureOwnedPublicReleasePairInput(options: SourceOptions & { store: PairViewStore }) {
  const pair = protocol.parsePublicReleasePair(options.pair), kind = options.kind ?? "qualification";
  const binding = (await options.firestore.doc(publicReleasePairSourceInputPath(pair, { kind, sourceOperationId: options.sourceOperationId })).get()).data();
  if (binding) {
    require("../../functions/lib/public-release-pair.js").exact(binding, ["schemaVersion", "pairDigest", "scope", "source", "cursor", "inputManifestDigest"]);
    const scope = input.parsePublicReleasePairInputScope(binding.scope);
    if (binding.schemaVersion !== 2 || binding.pairDigest !== protocol.publicReleaseDigest(pair) ||
        scope.kind !== kind || scope.sourceOperationId !== options.sourceOperationId) refuse();
    const frozen = await openPublicReleasePairInput({ firestore: options.firestore, store: options.store, pair,
      identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...scope, inputManifestDigest: binding.inputManifestDigest },
      expectedSource: binding.source, expectedCursor: binding.cursor, signal: options.signal });
    return { idempotent: true, receipt: frozen.receipt, root: frozen.root };
  }
  const derived = await derivePublicReleasePairInput(options);
  async function* files() { for (const [name, file] of derived.files) yield { name, bytes: file.bytes }; }
  return capturePublicReleasePairInput({ firestore: options.firestore, store: options.store, pair: derived.pair,
    plan: derived.root, expectedSource: derived.root.source, expectedCursor: derived.root.cursor, files: files(), signal: options.signal, bindSourceOperation: true });
}

export class HistoricalInputError extends Error {
  readonly code: string;
  constructor(code: string) { super("Historical public input is unavailable"); this.name = "HistoricalInputError"; this.code = code; }
}
type HistoricalOptions = Omit<SourceOptions, "providerStore" | "sourceOperationId" | "kind"> & {
  store: PairViewStore; providerStore?: PairViewStore; codeStore?: PairViewStore; kind?: "qualification" | "recovery" | "accepted";
  codePackArtifacts?: Pick<Parameters<typeof derivePublicReleasePairCodePack>[0], "distDirectory" | "compiledDirectory" | "preparedArtifact">;
  firstInstallControls?: boolean;
};
const historicalProviderStore = (pair: PublicReleasePair): PairViewStore => ({
  put: async () => { refuse(); },
  async get(key) {
    const bytes = await require("../../functions/lib/post-background-storage.js").createPostBackgroundStorage(publicationTarget(pair.environment).backgroundBucket).get(key,
      { maxBytes: input.INPUT_FILE_BYTES_LIMIT, signal: AbortSignal.timeout(10_000) });
    return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : null;
  },
});
async function recordHistoricalCapture(options: HistoricalOptions & { sourceOperationId: string }, retained: {
  event: { entry: PublicReleaseChange } | null; cursor: HistoricalPublicReleaseState["cursor"]; receipt: Pick<HistoricalPublicReleaseState["receipt"], "logEpoch"> },
  captured: Awaited<ReturnType<typeof capturePublicReleasePairInput>>, searchInputs?: PairSearchInputs) {
  const mediaPin = await preparePublicReleasePairMediaPin({ ...options, receipt: captured.receipt });
  if (!retained.event) {
    await retainPreparedPublicReleasePairMediaPin({ firestore: options.firestore, proof: mediaPin });
    return;
  }
  if (!searchInputs) refuse();
  const pair = protocol.parsePublicReleasePair(options.pair), kind = options.kind ?? "qualification";
  await options.firestore.runTransaction(async transaction => {
    const ref = options.firestore.doc(`system/publicReleaseChanges/captures/${options.sourceOperationId}`), row = await transaction.get(ref), value = row.data();
    if (!value || value.schemaVersion !== 2 || value.operationId !== options.sourceOperationId || value.entryDigest !== retained.event!.entry.entryDigest ||
        value.sequence !== retained.cursor.sequence || value.logEpoch !== retained.receipt.logEpoch) throw new HistoricalInputError("historical-capture-outbox-missing");
    const searchRef = options.firestore.doc(`system/publicReleaseChanges/operations/${options.sourceOperationId}/evidence/searchInputs`);
    const descriptor = publicReleasePairSearchInputDescriptor(searchInputs), previousSearch = await transaction.get(searchRef);
    if (searchInputs.entryDigest !== retained.event!.entry.entryDigest || !same(searchInputs.cursor, retained.cursor) ||
        previousSearch.exists && !same(previousSearch.data(), descriptor)) refuse();
    const key = protocol.publicReleaseDigest({ pair: protocol.publicReleasePairReference(pair), kind });
    if (value.status === "failed" || value.packs?.[key]?.status === "failed") throw new HistoricalInputError("historical-capture-failed");
    const pack = { status: "captured", pair: protocol.publicReleasePairReference(pair), kind,
      inputManifestDigest: captured.receipt.inputManifestDigest, receiptDigest: protocol.publicReleaseDigest(captured.receipt), searchInputDigest: searchInputs.searchInputDigest };
    if (value.packs[key]?.status === "captured" && !same(value.packs[key], pack)) refuse();
    const packs = { ...value.packs, [key]: pack };
    const registry = (await transaction.get(options.firestore.doc("system/publicReleasePairs"))).data();
    if (!Array.isArray(registry?.pairIds) || registry.pairIds.length > 8) refuse();
    const states = await transaction.getAll(...registry.pairIds.map((id: string) => options.firestore.doc(`${work.publicReleasePairPath(id)}/controls/runtime`)));
    const complete = states.every((state, index) => state.data()?.status === "retired" ||
      Object.values(packs).some((pack: any) => pack.status === "captured" && pack.pair.pairId === registry.pairIds[index]));
    const retention = await preparePublicReleasePairMediaPinInTransaction({ firestore: options.firestore, transaction, proof: mediaPin });
    retention.write();
    if (!previousSearch.exists) transaction.create(searchRef, descriptor);
    transaction.update(ref, { packs, status: complete ? "captured" : "pending" });
  });
}
async function captureHistoricalInput(options: HistoricalOptions & { sourceOperationId?: string; logBaselineDigest?: string }) {
  const pair = protocol.parsePublicReleasePair(options.pair), kind = options.kind ?? "qualification";
  let initialControlsProof: { controlsDigest: string } | undefined;
  if (options.firstInstallControls) {
    if (kind !== "qualification" || options.sourceOperationId || !protocol.digest(options.logBaselineDigest)) refuse();
    initialControlsProof = await options.firestore.runTransaction(transaction => require("../../functions/lib/public-release-bootstrap-control-source.js")
      .assertInitialControlCaptureInTransaction({ firestore: options.firestore, transaction, pair }), { readOnly: true });
  }
  if (kind === "accepted") {
    if (!options.sourceOperationId) refuse();
    const admissions = require("../../functions/lib/public-release-admission-contract.js");
    const admission = admissions.parseAdmission((await options.firestore.doc(
      `${admissions.ADMISSIONS}/operations/${options.sourceOperationId}`).get()).data());
    if (admission.operationId !== options.sourceOperationId) refuse();
    const scope = { kind, sourceOperationId: admission.operationId, sourceVersion: admission.source.sourceVersion,
      snapshotDigest: admission.source.snapshotDigest, contextSequence: admission.changeSequence };
    // This is an original admission, never a new request against the selected
    // pair. Check before writing private objects and again in H's final guard.
    await options.firestore.runTransaction(transaction => admissions.assertRetainedPairAdmissionInTransaction({
      firestore: options.firestore, transaction, pair, scope }), { readOnly: true });
  }
  if (options.sourceOperationId) {
    const outbox = (await options.firestore.doc(`system/publicReleaseChanges/captures/${options.sourceOperationId}`).get()).data();
    const key = protocol.publicReleaseDigest({ pair: protocol.publicReleasePairReference(pair), kind });
    if (!outbox) throw new HistoricalInputError("historical-capture-outbox-missing");
    if (outbox.status === "failed" || outbox.packs?.[key]?.status === "failed") throw new HistoricalInputError("historical-capture-failed");
  }
  // CODE can have committed before its pin, including on a legacy H retry.
  // Use its actual immutable owner rather than trusting baseline existence.
  if ((await options.firestore.doc(publicReleasePairCodePackBaselinePath(pair)).get()).exists) {
    await retainPreparedPublicReleasePairMediaPin({ firestore: options.firestore,
      proof: await preparePublicReleasePairCodeMediaPin({ ...options, pair }) });
  }
  const requestedId = initialControlsProof ? `baseline-controls-${initialControlsProof.controlsDigest}` : options.sourceOperationId ?? `baseline-${options.logBaselineDigest}`;
  const binding = (await options.firestore.doc(publicReleasePairSourceInputPath(pair, { kind, sourceOperationId: requestedId })).get()).data();
  if (binding) {
    require("../../functions/lib/public-release-pair.js").exact(binding, ["schemaVersion", "pairDigest", "scope", "source", "cursor", "inputManifestDigest"]);
    const scope = input.parsePublicReleasePairInputScope(binding.scope);
    if (binding.schemaVersion !== 2 || binding.pairDigest !== protocol.publicReleaseDigest(pair) || scope.kind !== kind || scope.sourceOperationId !== requestedId) refuse();
    const original = await openPublicReleasePairInput({ firestore: options.firestore, store: options.store, pair,
      identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...scope, inputManifestDigest: binding.inputManifestDigest },
      expectedSource: binding.source, expectedCursor: binding.cursor, signal: options.signal });
    // An older partial capture cannot masquerade as a historical complete pack.
    if (!["authority.json", "baseline.json", "source-census.json", "reader-provenance.json", PAIR_SEARCH_INPUTS_FILE, PAIR_SOURCE_METADATA_FILE, PAIR_AGGREGATE_RENDER_PLAN_FILE].every(name => original.root.files.some(file => file.name === name)))
      throw new HistoricalInputError("historical-input-incomplete");
    for (const file of original.root.files) await original.readFile(file.name);
    const baseline = JSON.parse(new TextDecoder().decode(await original.readFile("baseline.json")));
    const authority = JSON.parse(new TextDecoder().decode(await original.readFile("authority.json")));
    if (protocol.publicReleaseDigest(baseline.receipt) !== baseline.logBaselineDigest ||
        options.logBaselineDigest && options.logBaselineDigest !== baseline.logBaselineDigest) refuse();
    if (options.sourceOperationId) {
      const entry = log.parsePublicReleaseChange((await options.firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(original.root.cursor.sequence).padStart(16, "0")}`).get()).data());
      if (entry.operationId !== options.sourceOperationId || entry.entryDigest !== original.root.cursor.lastDigest || !same(entry, authority.entry)) refuse();
      const searchInputs = parsePublicReleasePairSearchInputs(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await original.readFile(PAIR_SEARCH_INPUTS_FILE))),
        { cursor: original.root.cursor, logBaselineDigest: baseline.logBaselineDigest, entryDigest: entry.entryDigest });
      await recordHistoricalCapture({ ...options, sourceOperationId: requestedId }, { receipt: baseline.receipt, event: { entry }, cursor: original.root.cursor },
        { idempotent: true, root: original.root, receipt: original.receipt }, searchInputs);
    } else {
      if (!same(authority.baseline, baseline.receipt) || !same(original.root.cursor, baseline.receipt.baselineCursor)) refuse();
      await recordHistoricalCapture({ ...options, sourceOperationId: requestedId },
        { receipt: baseline.receipt, event: null, cursor: original.root.cursor },
        { idempotent: true, root: original.root, receipt: original.receipt });
    }
    return { idempotent: true, root: original.root, receipt: original.receipt,
      headroom: sourceLimits.historicalSourceHeadroom({ changes: original.root.cursor.sequence - baseline.receipt.baselineCursor.sequence,
        rootFiles: original.root.files.length, censusBytes: original.root.files.find(file => file.name === "source-census.json")!.bytes }) };
  }
  let retained = await historical.reconstructPublicReleaseState({ firestore: options.firestore,
    sourceOperationId: options.sourceOperationId, logBaselineDigest: options.logBaselineDigest });
  let initialControls: unknown;
  if (options.firstInstallControls) {
    const current = await require("../../functions/lib/public-release-bootstrap-control-source.js").captureInitialControlledState({ firestore: options.firestore, pair, state: retained });
    retained = current; initialControls = current.initialControls;
  }
  const sourceOperationId = initialControlsProof ? requestedId : options.sourceOperationId ?? `baseline-${retained.logBaselineDigest}`;
  if (!(await options.firestore.doc(publicReleasePairCodePackBaselinePath(pair)).get()).exists) {
    if (!options.codePackArtifacts) throw new PairCodePackError("incomplete-code-pack");
    await capturePublicReleasePairCodePackBaselineInput({ ...options, logBaselineDigest: retained.logBaselineDigest });
  }
  const pack = await readFrozenPublicReleasePairCodePackManifest({ ...options, pair });
  const sourceInputs = publicReleasePairSourceInputsBytes(retained.receipt, retained.logBaselineDigest);
  const sourceMember = pack.manifest.members.find(member => member.path === PAIR_SOURCE_INPUTS_PACK_PATH);
  if (!sourceMember || sourceMember.size !== sourceInputs.length || sourceMember.sha256 !== hash(sourceInputs) ||
      !same(pack.receipt.cursor, retained.receipt.baselineCursor)) throw new PairSourceInputsError("pair-source-inputs-mismatch");
  const dependencies = await freezePublicReleaseSourceDependencies({ ...options, state: retained,
    providerStore: options.providerStore ?? historicalProviderStore(pair) });
  const reader = createHistoricalPublicReleaseReader({ firestore: options.firestore, documents: retained.documents, cursor: retained.cursor, renderedAt: retained.renderedAt });
  const ordinary = await derivePairInput({ ...options, firestore: reader, pair, sourceOperationId,
    providerStore: dependencies.providerStore }, retained, { pack, dependencies, initialControls });
  const derived = await derivePublicReleasePairAggregateRenderPlan({ ...options, pair, sourceOperationId,
    providerStore: dependencies.providerStore }, retained, { pack, dependencies, initialControls }, ordinary);
  async function* files() { for (const [name, file] of derived.files) yield { name, bytes: file.bytes }; }
  const captured = await capturePublicReleasePairInput({ firestore: options.firestore, store: options.store, pair, plan: derived.root,
    expectedSource: derived.root.source, expectedCursor: derived.root.cursor, files: files(), bindSourceOperation: true, signal: options.signal });
  await recordHistoricalCapture({ ...options, sourceOperationId }, retained, captured, derivePublicReleasePairSearchInputs(retained, dependencies));
  const census = derived.files.get("source-census.json")!;
  return { ...captured, headroom: sourceLimits.historicalSourceHeadroom({
    changes: retained.headroom?.checks.changes.used ?? null, transactionMs: retained.headroom?.checks.transactionMs.used ?? null,
    readMs: retained.headroom?.checks.readMs.used ?? null, rootFiles: derived.files.size, censusBytes: census.bytes.byteLength }) };
}
/** Owner derives source, every immutable dependency and the exact event cursor.
 * No mutable CMS source or current-CODE transport is consulted. */
export function captureHistoricalPublicReleasePairInput(options: HistoricalOptions & { sourceOperationId: string }) {
  return captureHistoricalInput(options);
}
export function captureHistoricalPublicReleasePairBaselineInput(options: HistoricalOptions & { logBaselineDigest: string }) {
  return captureHistoricalInput(options);
}

/** Dedicated immutable baseline inventory for the copy-only code-pack task.
 * Its cursor and snapshot come from the actual global baseline, never a hint. */
export async function capturePublicReleasePairCodePackBaselineInput(options: HistoricalOptions & { logBaselineDigest: string }) {
  const pair = protocol.parsePublicReleasePair(options.pair), kind = "qualification" as const;
  const sourceOperationId = `baseline-codepack-${options.logBaselineDigest}`;
  const bound = (await options.firestore.doc(publicReleasePairSourceInputPath(pair, { kind, sourceOperationId })).get()).data();
  if (bound) {
    const captured = await captureOwnedPublicReleasePairInput({ ...options, pair, kind, sourceOperationId,
      providerStore: options.providerStore ?? historicalProviderStore(pair) });
    await persistPublicReleasePairCodePackBaseline({ ...options, pair, captured });
    await retainPreparedPublicReleasePairMediaPin({ firestore: options.firestore,
      proof: await preparePublicReleasePairCodeMediaPin({ ...options, pair }) });
    return captured;
  }
  if (!options.codePackArtifacts) throw new PairCodePackError("incomplete-code-pack");
  const state = await historical.reconstructPublicReleaseState({ firestore: options.firestore, logBaselineDigest: options.logBaselineDigest });
  const built = await derivePublicReleasePairCodePack({ ...options.codePackArtifacts, pair, signal: options.signal });
  const sourceMember = built.manifest.members.find(member => member.path === PAIR_SOURCE_INPUTS_PACK_PATH);
  if (!sourceMember) throw new PairSourceInputsError("pair-source-inputs-missing");
  const expected = publicReleasePairSourceInputsBytes(state.receipt, state.logBaselineDigest);
  const actual = await built.readMember(PAIR_SOURCE_INPUTS_PACK_PATH);
  if (!Buffer.from(expected).equals(Buffer.from(actual))) throw new PairSourceInputsError("pair-source-inputs-mismatch");
  const dependencies = await freezePublicReleaseSourceDependencies({ ...options, state,
    providerStore: options.providerStore ?? historicalProviderStore(pair) });
  const files = sourceLimits.createHistoricalSourceInventory<{ bytes: Uint8Array; dependencies: string[] }>();
  const add = (name: string, value: unknown, names: string[] = []) => files.set(name, { bytes: name === "source-census.json" ? sourceLimits.encodeHistoricalSourceCensus(value) : encode(value), dependencies: [...names].sort() });
  const sourceNames = [];
  for (const [digest, body] of state.sourceBodies) { const name = `sources/${digest}.json`; add(name, body); sourceNames.push(name); }
  for (const [name, bytes] of dependencies.files) { files.set(name, { bytes, dependencies: [] }); sourceNames.push(name); }
  add("snapshot.json", state.baselineMembers, sourceNames);
  add(PAIR_SEARCH_INPUTS_FILE, derivePublicReleasePairSearchInputs(state, dependencies), sourceNames);
  add("source-census.json", publicReleasePairFrozenSourceCensus(state), [...sourceNames, PAIR_SEARCH_INPUTS_FILE]);
  add("baseline.json", { receipt: state.receipt, logBaselineDigest: state.logBaselineDigest, sourceMembers: state.baselineMembers });
  add("authority.json", { schemaVersion: 2, baseline: state.receipt, logBaselineDigest: state.logBaselineDigest, cursor: state.cursor,
    readerSource: state.originalPair.commitSha, codeAssetManifestDigest: pair.codeAssetManifestDigest });
  add("reader-provenance.json", { schemaVersion: 1, pair: state.originalPair, rendererSha: state.originalPair.commitSha,
    readerContractDigest: state.originalPair.readerContractDigest, readerReceiptDigest: state.originalPair.readerReceiptDigest });
  for (const member of built.manifest.members) {
    const bytes = await built.readMember(member.path);
    for (let index = 0; index < publicReleasePairCodePackChunkCount(member.size); index++) {
      const name = publicReleasePairCodePackChunkName(member, index);
      files.set(name, { bytes: encodePublicReleasePairCodePackChunk(bytes.subarray(index * PAIR_CODE_PACK_CHUNK_BYTES, (index + 1) * PAIR_CODE_PACK_CHUNK_BYTES)), dependencies: [] });
    }
  }
  add(PAIR_CODE_PACK_FILE, built.manifest, [...files.keys()]);
  const root = input.parsePublicReleasePairInputRoot({ schemaVersion: 2, kind: "pair-render-input", pairDigest: protocol.publicReleaseDigest(pair),
    source: { kind: "inventory", id: sourceOperationId }, scope: { kind, sourceOperationId, sourceVersion: 1,
      snapshotDigest: hash(files.get("snapshot.json")!.bytes), contextSequence: state.cursor.sequence }, cursor: state.cursor, snapshotFile: "snapshot.json",
    entryFiles: [PAIR_CODE_PACK_FILE, "snapshot.json"], files: [...files].sort(([a], [b]) => a < b ? -1 : 1).map(([name, file]) => ({
      name, digest: hash(file.bytes), bytes: file.bytes.length, objectKey: input.publicReleasePairInputObjectKey(pair, hash(file.bytes)), dependencies: file.dependencies })) }, pair);
  async function* capturedFiles() { for (const [name, file] of files) yield { name, bytes: file.bytes }; }
  const captured = await capturePublicReleasePairInput({ ...options, pair, plan: root, expectedSource: root.source, expectedCursor: root.cursor,
    files: capturedFiles(), bindSourceOperation: true });
  await persistPublicReleasePairCodePackBaseline({ ...options, pair, captured });
  await retainPreparedPublicReleasePairMediaPin({ firestore: options.firestore,
    proof: await preparePublicReleasePairCodeMediaPin({ ...options, pair }) });
  return captured;
}

/** Call after commit or during missed-wake catch-up. The public mutation
 * never waits for capture or retries.
 * Failed evidence is retained; there is no automatic body/pack deletion. */
export async function processPublicReleaseCaptureOutboxOperation(options: HistoricalOptions & { sourceOperationId: string; now?: () => number }) {
  const now = (options.now ?? Date.now)(), pair = protocol.parsePublicReleasePair(options.pair), kind = options.kind ?? "qualification";
  const key = protocol.publicReleaseDigest({ pair: protocol.publicReleasePairReference(pair), kind });
  const ref = options.firestore.doc(`system/publicReleaseChanges/captures/${options.sourceOperationId}`);
  const initial = (await ref.get()).data();
  if (!initial) throw new HistoricalInputError("historical-capture-outbox-missing");
  if (initial.status === "failed" || initial.packs?.[key]?.status === "failed") throw new HistoricalInputError("historical-capture-failed");
  if (initial.packs?.[key]?.nextAttemptAt > now) return { status: "pending" as const, nextAttemptAt: initial.packs[key].nextAttemptAt };
  try {
    const captured = await captureHistoricalPublicReleasePairInput(options);
    return { status: "captured" as const, ...captured };
  } catch (error) {
    const sourceLimit = sourceLimits.isHistoricalSourceLimitError(error);
    const permanent = error instanceof protocol.PublicReleaseProtocolError || sourceLimit && ["changes", "rootFiles", "censusBytes"].includes(error.details.metric);
    const code = sourceLimit ? error.code : permanent ? "historical-source-evidence-invalid" : error instanceof HistoricalInputError || error instanceof PairCodePackError || error instanceof PairSourceInputsError || error instanceof PairSearchInputsError
      ? error.code : "historical-capture-transport-unavailable";
    return options.firestore.runTransaction(async transaction => {
      const row = await transaction.get(ref), before = row.data();
      if (!before || before.entryDigest !== initial.entryDigest || before.sequence !== initial.sequence) throw new HistoricalInputError("historical-capture-outbox-missing");
      const previous = before.packs?.[key];
      if (previous?.status === "captured") return { status: "captured" as const, inputManifestDigest: previous.inputManifestDigest };
      const attempts = (previous?.attempts ?? 0) + 1, failed = permanent || attempts >= 4;
      const nextAttemptAt = now + Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000);
      const failure = { status: failed ? "failed" : "pending", pair: protocol.publicReleasePairReference(pair), kind, attempts, nextAttemptAt, failure: code };
      transaction.update(ref, { packs: { ...before.packs, [key]: failure }, attempts: (before.attempts ?? 0) + 1 });
      return { status: failed ? "failed" as const : "pending" as const, attempts, nextAttemptAt, failure: code };
    });
  }
}
