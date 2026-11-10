import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import log from "../../functions/lib/public-release-change-log.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import producer from "../../functions/lib/public-release-producer.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import legacy from "../../functions/lib/public-deployment.js";
import { releasePair, pairReference } from "./private-public-release-pair.js";
import { sealedPair } from "./sealed-public-release-pair";
import { privateReaderTransport } from "./private-pair-reader-fixture";
import { publicReleaseCodePackFixture } from "./public-release-code-pack";
import { frozenReplayProgramRead } from "./public-release-replay-inputs";
import { projectPublishedRecordRoute } from "../../site/src/lib/published-record-render";
import { schedulePacketFixture } from "../functions/page-schedule-packet-fixture";
import { publicReleasePairSourceInputsBytes } from "../../site/scripts/public-release-pair-source-inputs";
import { derivePublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack";
import { capturePublicReleasePairCodePackBaselineInput, captureHistoricalPublicReleasePairBaselineInput, captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { derivePublicReleasePairAuthors } from "../../site/scripts/public-release-pair-author";
import { writePublicReleasePairReplayProof } from "../../site/scripts/public-release-pair-replay-storage";
import { openPublicReleasePairCompositeAuthority, stagePublicReleasePairComposite } from "../../site/scripts/public-release-pair-composite-storage";
import { openFrozenPublicReleasePairCatalogImages } from "../../site/scripts/public-release-pair-catalog-image-storage";
import { isPublicReleasePairProjection, projectPublicReleasePairReplay } from "../../site/scripts/public-release-pair-replay";
import { initializePublicReleasePairReplayBaseline, replayPublicReleasePairToHead } from "../../site/scripts/public-release-pair-log-replay";
import { writePublicReleasePairView, type PairViewOutputInput, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-executor";
import { createPrivatePairReader, readerSealPath } from "../../site/scripts/public-release-pair-private-reader";

const source = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
const encode = (value: string) => new TextEncoder().encode(value);
const require = createRequire(import.meta.url), owners = require("../../functions/lib/no-build-page-ownership.js");

/** Actual baseline/H/G/replay APIs and loopback HTTP. The compiled/static
 * artifact is a small sealed fixture; this performs no build or deployment. */
export async function qualifiedPairFixture(firestore: Firestore, store: PairViewStore, options: { draftSettings?: number; catalog?: boolean; authors?: boolean; mediaLifecycleReady?: boolean; pairCommitSha?: string; environment?: 'development' | 'production' } = {}) {
  const transport = await privateReaderTransport(options.environment), directory = await mkdtemp(path.join(tmpdir(), "qualified-pair-"));
  let packet: Awaited<ReturnType<typeof schedulePacketFixture>> | undefined;
  try {
    const environment = options.environment ?? 'development';
    const target = require('../../functions/lib/publication-target.js').publicationTarget(environment);
    const pairFor = (slot?: string, sha?: string) => ({ ...releasePair(slot, sha), environment });
    const original = pairFor(), pairCommitSha = options.pairCommitSha ?? "b".repeat(40);
    const anchor = "f".repeat(64), cursor = log.initialPublicReleaseChangeHead(anchor), epoch = "qualification-test-epoch";
    await firestore.doc("system/publicDeployment").set({ ...legacy.initialPublicDeploymentPointer(), mediaLifecycleReady: options.mediaLifecycleReady ?? false, activeGeneration: 1,
      activeDeploymentId: "qualification-source", activeCommitSha: original.commitSha, lastReservedGeneration: 1,
      newestEligibleGeneration: 1, newestEligibleBuildBatchId: "qualification-source" });
    // A first-install OLD slot has the current source. Register its fully
    // sealed pair below; no unused legacy placeholder may duplicate that SHA.
    if (pairCommitSha !== original.commitSha) await work.registerPublicReleasePair({ firestore, pair: original });
    await firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(cursor);
    await firestore.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
    for (let start = 0; start < (options.draftSettings ?? 0); start += 100) {
      const batch = firestore.batch();
      for (let index = start; index < Math.min(start + 100, options.draftSettings!); index++) {
        batch.set(firestore.doc(`cmsSettings/private-draft-${index}`), { draft: { title: `Working setting ${index}` } });
      }
      await batch.commit();
    }
    for (const [id, visible] of [["story", true], ["removed", false]] as const) {
      const slug = visible ? "shadow-fixture" : "removed-fixture", previous = visible ? "old-fixture" : "removed-old";
      const published = { ...source.published, metadata: { ...source.published.metadata, slug, previousSlugs: [previous] } };
      await firestore.doc(`cmsPosts/${id}`).set({ ...source, id, version: 7, published, status: "published", publiclyVisible: visible });
      await firestore.doc(`system/publicDeployment/noBuildPostOwners/${id}`).set({ schemaVersion: 1, postId: id,
        rendererSha: original.commitSha, servingEnabled: true, generation: 1, operationId: (visible ? "A" : "B").repeat(20),
        sourceVersion: 7, slug, ownedSlugs: [slug, previous], visible, snapshotDigest: owners.digest(published) });
    }
    const authorId = "au_" + "a".repeat(32), retiredAuthorId = "au_" + "c".repeat(32);
    if (options.authors) for (const [id, slug] of [[authorId, "ada"], [retiredAuthorId, "retired"]]) {
      await firestore.doc(`cmsAuthorProfilesPublic/${id}`).set({ authorId: id, slug, previousSlugs: [slug + "-old"], displayName: `Reporter ${slug}`,
        jobTitle: "Reporter", bio: "Frozen public biography.", photo: null, links: {}, pinnedPostId: null, hiddenPostIds: [],
        snapshotVersion: 3, publishedAt: "2026-10-01T12:00:00.000Z" });
    }
    await firestore.doc("system/publicReleaseChangeLog").set({ schemaVersion: 2, enabled: true, logEpoch: epoch, pair: pairReference(original), head: cursor });
    const sourceDatabase = new Proxy(firestore, { get(database, key) { if (key === "projectId") return target.projectId;
      const value = Reflect.get(database, key); return typeof value === "function" ? value.bind(database) : value; } });
    const schedulePublished = require("../../functions/lib/publish-snapshot.js").createPublishedSnapshot({ collection: "cmsPages",
      document: { id: "schedule", version: 1, title: "Schedule", blocks: [] }, publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
    await firestore.doc("cmsPages/schedule").set({ version: 1, status: "published", publiclyVisible: true,
      publishAt: schedulePublished.publishedAt, published: schedulePublished });
    const programRead = options.catalog ? frozenReplayProgramRead(original.commitSha) : undefined;
    if (programRead) {
      const document = programRead.documents[0], published = document.published;
      Object.assign(published, { publishedBy: "original-editor" });
      const contract = require("../../functions/lib/no-build-record-contract.js");
      const ownership = require("../../functions/lib/no-build-record-ownership.js");
      const plan = contract.validateNoBuildRecordSnapshot({ family: "programs", documentId: document.id, snapshot: published });
      const asset = programRead.assets[0], media = require("../../functions/lib/media-contract.js");
      const privateAsset = { ...asset, source: "site_seed", lifecycle: "active", altText: "Frozen program art" };
      await firestore.doc(`media_assets/${asset.id}`).set(privateAsset);
      await firestore.doc(`media_assets_public/${asset.id}`).set(media.mediaProjection(privateAsset));
      await firestore.doc(`cmsPosts/${document.id}`).set({ ...document, type: "program" });
      await firestore.doc(`${ownership.RECORD_OWNER_COLLECTION}/${document.id}`).set({ schemaVersion: 1, family: "programs", documentId: document.id,
        sourceVersion: published.sourceVersion, operationId: "C".repeat(20), snapshotDigest: contract.recordSnapshotDigest(published),
        canonicalPath: plan.canonicalPath, ownedPaths: plan.ownedPaths, visible: true, rendererSha: original.commitSha, generation: 1,
        runtime: { owner: "cloudflare", release: original.commitSha }, contextRevision: 1,
        contextDigest: require("../../functions/lib/public-context-revision.js").publicContextDigest(1), admissionRevision: null });
      await firestore.doc("system/publicDeployment/noBuildRecordFamilies/current").set({ schemaVersion: 1, families: ["programs"] });
      for (const path of plan.ownedPaths) await ownership.recordRouteRef(firestore, path).set({ schemaVersion: 1, family: "programs", documentId: document.id, path });
    }
    packet = await schedulePacketFixture({ firestore: sourceDatabase, target, rendererSha: original.commitSha, generation: 1, includeHomeSources: true, programRead });
    await firestore.doc("system/publicDeployment/noBuildPages/capability").update({ dataHubReportingVersion: 1 });
    const global = await baseline.capturePublicReleaseChangeBaseline({ firestore: sourceDatabase, logEpoch: epoch, currentCodeRequest: (url, options) => packet!.request(url instanceof Request ? url.url : String(url), options ?? {}) });
    const providerStore: PairViewStore = { put: async () => { throw new Error("Read-only fixture provider"); }, async get(key) {
      const bytes = packet!.boundary.objects.get(key);
      return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : null;
    } };
    packet.refuseCode();
    const artifacts = await publicReleaseCodePackFixture(directory, pairCommitSha, publicReleasePairSourceInputsBytes(global.receipt, global.logBaselineDigest),
      { ...(options.authors ? { "authors/static/index.html": "<html>Frozen static author fallback</html>" } : {}),
        ...(options.catalog ? { "_astro/art.png": "abc" } : {}) });
    const built = await derivePublicReleasePairCodePack(artifacts);
    const { pair, seals } = sealedPair(transport.origin, { ...pairFor("b", pairCommitSha),
      rendererDigest: artifacts.pair.rendererDigest, codeAssetManifestDigest: built.manifest.codeAssetManifestDigest });
    await work.registerPublicReleasePair({ firestore, pair });
    await firestore.doc(readerSealPath(pair)).create(seals);

    async function stage(captured: Awaited<ReturnType<typeof capturePublicReleasePairCodePackBaselineInput>>, outputs: PairViewOutputInput[], proveTargets = false) {
      const { taskId } = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({
        firestore, transaction, pair, input: { ...captured.receipt.scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
      const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId });
      if (!claim) throw new Error("Missing fixture claim");
      const claimDigest = protocol.publicReleaseDigest(claim.token);
      const original = proveTargets ? await openPublicReleasePairCompositeAuthority({ firestore, store, pair, identity: claim.identity }) : undefined;
      const catalog = proveTargets ? await openFrozenPublicReleasePairCatalogImages({ firestore, store, pair, identity: claim.identity }) : undefined;
      const authors = original ? await derivePublicReleasePairAuthors({ pair, identity: claim.identity, root: original.frozen.root, readFrozenFile: original.frozen.readFile }) : undefined;
      let compositeManifest;
      if (original && catalog) {
        // Use the owner's combined plan and closed roster. The tiny fixture
        // bodies exercise real staging/qualification, not a compiled render.
        outputs = [];
        for (const expected of original.plan.expectedOutputs) {
          const route = original.plan.routes.find(route => route.path === expected.path)!;
          const headers: Record<string, string> = { "content-type": expected.contentType, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha };
          if (expected.status === 308) {
            const envelope = JSON.parse(new TextDecoder().decode(await original.frozen.readFile(route.inputFile)));
            if (route.renderer === "record") {
              const projected = projectPublishedRecordRoute(envelope.read, route.path, new Date(original.plan.renderedAt));
              if (!projected) throw new Error("Missing fixture record redirect");
              headers.location = projected.target?.path ?? `/${projected.family}/`;
            } else headers.location = envelope.read.location;
          }
          const baselineMember = built.manifest.members.find(member => member.path === expected.path);
          outputs.push({ path: expected.path, status: expected.status, headers,
            bytes: baselineMember ? await built.readMember(baselineMember.path)
              : expected.status === 200 ? encode(`<!doctype html><html>Frozen ${expected.path}</html>`) : new Uint8Array() });
        }
        for (const member of built.manifest.members) if (member.dynamic && !outputs.some(output => output.path === member.path)) {
          const auxiliaryKind = composite.publicReleasePairCompositeAuxiliaryKind(member.path);
          const mime = auxiliaryKind ? composite.publicReleasePairCompositeAuxiliaryMime(auxiliaryKind) : member.mime;
          if (!mime) throw new Error("Missing original composite auxiliary MIME");
          outputs.push({ path: member.path, status: 200, headers: { "content-type": mime,
            "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha }, bytes: await built.readMember(member.path) });
        }
        for (const member of catalog.manifest.members) outputs.push({ path: member.path, status: 200,
          headers: { "content-type": member.mime, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha }, bytes: await catalog.readMember(member.path) });
        for (const route of authors!.routes) outputs.push({ path: route.path, status: route.status,
          headers: { "content-type": route.contentType, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha,
            ...(route.location ? { location: route.location } : {}) }, bytes: route.status === 200 ? encode(`<html>Frozen author ${route.path}</html>`) : new Uint8Array() });
        outputs.sort((a, b) => view.comparePrivatePairArtifactPaths(a.path, b.path));
        compositeManifest = composite.parsePublicReleasePairCompositeManifest({ schemaVersion: 1, kind: "pair-composite-manifest",
          pairDigest: protocol.publicReleaseDigest(pair), inputManifestDigest: claim.identity.inputManifestDigest,
          cursor: captured.receipt.cursor, authority: original.authority, members: outputs.map(output => {
            const route = original.plan.routes.find(route => route.path === output.path);
            const author = authors!.routes.find(route => route.path === output.path);
            const role = route ? "route" : output.path.startsWith("/pagefind/") ? "search" : output.path.startsWith("/api/v1/content/") ? "content-feed"
              : catalog.manifest.members.some(member => member.path === output.path) ? "catalog" : "auxiliary";
            return { path: output.path, role, kind: route?.renderer ?? (role === "search" ? "pagefind" : role === "content-feed" ? "content-feed-page"
              : role === "catalog" ? "catalog-image" : author ? "author" : composite.publicReleasePairCompositeAuxiliaryKind(output.path)),
              status: output.status, mime: output.headers["content-type"], size: output.bytes.length,
              sha256: createHash("sha256").update(output.bytes).digest("hex"), sourceDependencyDigest: original.authority.sourceDependencyDigest,
              ...(author ? { owner: author.owner } : {}) };
          }) }, pair, claim.identity, captured.receipt.cursor);
      }
      async function* stream() { yield* outputs.sort((a, b) => view.comparePrivatePairArtifactPaths(a.path, b.path)); }
      const written = await writePublicReleasePairView({ store, pair, identity: claim.identity, claimDigest, cursor: captured.receipt.cursor, outputs: stream(),
        ...(compositeManifest ? { deriveNamespaces: true, catalogImages: catalog!.manifest, compositeManifest } : {}) });
      const owner = { firestore, store, pair, identity: claim.identity, claimDigest, viewManifestDigest: written.manifestDigest };
      if (proveTargets) {
        async function* targets() {
          for (const route of original!.plan.routes) if (isPublicReleasePairProjection(route.renderer)) {
            const target = await projectPublicReleasePairReplay(await original!.context(route));
            const output = outputs.find(output => output.path === route.path)!;
            yield { receipt: target.receipt, bodyDigest: createHash("sha256").update(output.bytes).digest("hex"), status: output.status };
          }
        }
        await writePublicReleasePairReplayProof({ ...owner, targets: targets() });
      }
      await work.settlePublicReleasePairWork({ firestore, pair, taskId, token: claim.token, manifestDigest: written.manifestDigest });
      if (proveTargets) {
        await stagePublicReleasePairComposite(owner);
      } else await stagePublicReleasePairCodePack(owner);
      return { identity: claim.identity, claimDigest, manifestDigest: written.manifestDigest, manifestBytes: written.manifestBytes };
    }
    const resourceRequest: typeof fetch = async request => {
      if (programRead && String(request) === programRead.assets[0].url) return new Response("abc", { headers: { "content-type": "image/png" } });
      throw new Error("No mutable fixture resource fallback");
    };
    const codeInput = await capturePublicReleasePairCodePackBaselineInput({ firestore: sourceDatabase, store, providerStore, resourceRequest, pair, logBaselineDigest: global.logBaselineDigest, codePackArtifacts: artifacts });
    const codeOutputs: PairViewOutputInput[] = [];
    for (const member of built.manifest.members) codeOutputs.push({ path: member.path, status: 200,
      headers: { "content-type": member.mime, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha }, bytes: await built.readMember(member.path) });
    const codePackView = await stage(codeInput, codeOutputs);
    const contentInput = await captureHistoricalPublicReleasePairBaselineInput({ firestore: sourceDatabase, store, providerStore, resourceRequest, pair, logBaselineDigest: global.logBaselineDigest });
    const contentView = await stage(contentInput, [], true);
    await initializePublicReleasePairReplayBaseline({ firestore, store, pair, logBaselineDigest: global.logBaselineDigest, views: [contentView], codePackView });
    if (options.authors) {
      await firestore.runTransaction(async transaction => {
        const append = await producer.preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId: "qualification-author-withdrawal",
          changes: [{ kind: "author", id: retiredAuthorId, action: "withdraw", sourceVersion: 4, snapshot: null }] });
        append(); transaction.delete(firestore.doc(`cmsAuthorProfilesPublic/${retiredAuthorId}`));
        transaction.update(firestore.doc("system/publicDeployment/contexts/public"), { revision: 2 });
      });
      const current = await captureHistoricalPublicReleasePairInput({ firestore: sourceDatabase, store, providerStore, resourceRequest, pair,
        sourceOperationId: "qualification-author-withdrawal" });
      const currentView = await stage(current, [], true);
      await replayPublicReleasePairToHead({ firestore, store, pair, resolveView: async () => currentView });
    }
    const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
    const witnessProof = await replay.openPublicReleasePairReplayWitnessProof({
      firestore, pair, headCursor: witness.witness.headCursor, witnessDigest: witness.witnessDigest });
    const setReaderStore = (readerStore: PairViewStore) => transport.install(createPrivatePairReader({ firestore, store: readerStore, pair, installed: seals }));
    setReaderStore(store);
    return { pair, seals, store, global, codePackView, contentView, authorId, ...witness, namespaces: witnessProof.namespaces, credentials: transport.credentials,
      get received() { return transport.received; }, setTransform: transport.setTransform, setReaderStore,
      async close() { await transport.close(); await packet?.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await transport.close(); await packet?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
