import { createRequire } from "node:module";
import { Timestamp } from "firebase-admin/firestore";
import { releasePair } from "./private-public-release-pair.js";
import { pairReference, releaseSelector } from "./public-release-pair.js";
import { pair, candidate, reader, selector } from "./cms-preview-pairs.js";
import { publicReleaseBaselineCodeFixture } from "./public-release-baseline-code";
import postFixture from "../../site/tests/fixtures/shadow-posts/post.json";
import { chromeSettings } from "../../site/tests/fixtures/shadow-posts/chrome";
import { functionsInventoryIdentity } from "../../scripts/lib/cms-component-receipt.mjs";
import { DEV_TARGETS } from "../../scripts/assert-dev-cms-targets.mjs";
const require = createRequire(import.meta.url);
const p = require("../../functions/lib/public-release-pair.js");
const cms = require("../../functions/lib/cms-preview-pair.js");
const history = require("../../functions/lib/public-release-historical-code.js");
const work = require("../../functions/lib/public-release-pair-work.js");

// All SDK I/O is against the explicitly required local emulator, including
// the original native saved-preview admission. No installed proof is seeded.
export async function retainedSourceFixture(db: any) {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Local emulator only");
  const oldPair = releasePair(), newPair = releasePair("b", "b".repeat(40));
  const previewPairs = [pair("old"), pair("new", "b")];
  const now = Date.now();
  const readers = Object.fromEntries(["functions", "cmsApi"].map(component => [component,
    { ...reader(component, now), supported: { ...reader(component, now).supported, adminSession: [1, 2] } }]));
  const functionsInventory = [1, 2].map(version => ({ name: `projects/njpbs-site-dev/locations/us-central1/functions/cmsReaderV${version}`,
    state: "ACTIVE", updateTime: new Date(now).toISOString(), serviceConfig: { revision: `reader-${version}` } }));
  const apiDeployment = { id: "api-deployment", versions: [{ version_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", percentage: 100 }] };
  readers.functions.providerIdentities = functionsInventoryIdentity(functionsInventory);
  readers.cmsApi.providerIdentities = { script: DEV_TARGETS.CMS_API_WORKER, deploymentId: apiDeployment.id, versionId: apiDeployment.versions[0].version_id };
  const initial = require("../../functions/lib/public-deployment.js").initialPublicDeploymentPointer();
  const legacyRoot = { ...initial, activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
    newestEligibleBuildBatchId: "baseline", activeDeploymentId: "baseline", activeCommitSha: oldPair.commitSha, mediaLifecycleReady: true,
    updatedAt: Timestamp.fromMillis(now) };
  await db.doc("system/publicDeployment").set(legacyRoot);
  const runtime = { schemaVersion: 1, phase: "ready", rendererSha: previewPairs[0].rendererSha, serializerId: "legacy-preview" };
  await db.doc(cms.SELECTOR_PATH).set(runtime);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, enabled: true, revision: 1,
    families: { posts: { mode: "all" }, pages: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" });
  const document = { ...structuredClone(postFixture.document), type: "post", version: 8 };
  await db.doc("cmsPosts/shadow-fixture").set(document);
  await db.doc("system/publicDeployment/noBuildPostOwners/shadow-fixture").set({ schemaVersion: 1,
    postId: "shadow-fixture", rendererSha: oldPair.commitSha, servingEnabled: true, generation: 1,
    operationId: "P".repeat(20), sourceVersion: 7, slug: "shadow-fixture", visible: true, ownedSlugs: ["shadow-fixture"],
    snapshotDigest: require("../../functions/lib/no-build-page-ownership.js").digest(document.published) });
  await db.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2,
    rendererSha: oldPair.commitSha, servingEnabled: true, generation: 1 });
  await db.doc("system/publicDeployment/noBuildPages/capability").set({ schemaVersion: 1,
    rendererSha: oldPair.commitSha, servingEnabled: true, generation: 1 });
  const page = { id: "contact", version: 7, title: "Contact fixture", blocks: [], status: "draft", template: "genericPage" };
  await db.doc("cmsPages/contact").set({ ...page, publiclyVisible: true,
    published: require("../../functions/lib/publish-snapshot.js").createPublishedSnapshot({ collection: "cmsPages", document: page,
      publishedAt: "2026-10-07T12:00:00.000Z", publishedBy: "fixture-staff" }) });
  for (const row of chromeSettings()) { const { id, ...document } = row; await db.doc(`cmsSettings/${id}`).set(document); }
  for (const source of [oldPair, newPair]) {
    const base = work.publicReleasePairPath(source.pairId);
    await db.doc(base).set(source);
    const baseline = { schemaVersion: 1, kind: "pair-code-pack-baseline", pairDigest: p.publicReleaseDigest(source),
      commitSha: source.commitSha, codeAssetManifestDigest: source.codeAssetManifestDigest, codePackManifestDigest: "9".repeat(64) };
    await db.doc(`${base}/codePacks/baseline`).set(baseline);
    const retained = history.prepareRetainedPublicReleaseCode(publicReleaseBaselineCodeFixture(db, source.commitSha).qualified);
    for (const chunk of retained.chunks) await db.doc(`${history.CHUNKS}/${chunk.digest}`).set(chunk.value);
    await db.doc(`${base}/codePacks/publication`).set({ schemaVersion: 2, kind: "pair-code-publication",
      pairDigest: p.publicReleaseDigest(source), baselineDigest: p.publicReleaseDigest(baseline),
      codePackManifestDigest: baseline.codePackManifestDigest, historicalCode: retained.descriptor,
      reference: { schemaVersion: 2, kind: "pair", side: pairReference(source), commitSha: source.commitSha,
        codeAssetManifestDigest: source.codeAssetManifestDigest, publicationDigest: "8".repeat(64) } });
  }
  for (const [index, preview] of previewPairs.entries()) {
    await db.doc(`${cms.PAIRS}/${preview.pairId}`).set(preview);
    const id = `renderer-${100 + index}-1`;
    const record = candidate(preview, now);
    record.mutation.runId = String(100 + index);
    Object.assign(record.mutation.providerIdentities, { applicationId: `application-${index}`, workerDeploymentId: `deployment-${index}` });
    await db.doc(`cmsDeploymentCandidates/${id}`).set(record);
    await require("../../functions/lib/cms-preview-pair-candidate.js").recordPreviewPairCandidatePointer({ firestore: db,
      request: { operationId: `preview-pointer-${index}`, pairId: preview.pairId, candidateReceiptId: id,
        expectedPointerDigest: null, expectedRuntimeDigest: cms.digest(runtime), bootstrapPublicPair: pairReference(oldPair) }, clock: () => now });
  }
  const candidates: Record<string, string> = {};
  for (const [index, component] of ["functions", "cmsApi"].entries()) {
    const id = `${component}-${200 + index}-1`; candidates[component] = id;
    const descriptor = readers[component];
    const mutation = { ...Object.fromEntries(["sourceSha", "inputFingerprint", "configurationFingerprint", "providerIdentities"].map(key => [key, descriptor[key]])),
      runId: String(200 + index), runAttempt: 1, trustedWorkflowSha: "e".repeat(40), startedAt: descriptor.verifiedAt, completedAt: descriptor.verifiedAt };
    await db.doc(`cmsDeploymentCandidates/${id}`).set({ schemaVersion: 2, component, state: "verified", mutation });
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation });
  }
  const actor = { uid: "fixture-staff", principal: { id: "fixture-staff", grants: [{ role: "admin" }] } };
  const preview = require("../../functions/preview.js");
  const admitted = await preview.enqueuePreview({ actor, collection: "cmsPages", pageId: "contact", persistent: true },
    { firestore: db, getTransport: () => "serializer", serializerReady: () => true, getRendererSha: () => oldPair.commitSha, now: () => now });
  // Renderer completion is the external boundary in this fixture. Admission,
  // frozen saved version, queue identity and audit all come from the real owner.
  await db.doc(`cmsPreviewQueue/${admitted.queueId}`).update({ status: "ready", completedAt: Timestamp.fromMillis(now),
    previewUrl: `https://preview.njpbs.org/p/${admitted.queueId}/` });
  const headPath = `cmsPreviewHeads/${require("../../functions/lib/preview-target.js").previewContentKey("cmsPages", "contact")}`;
  await db.doc(headPath).set({ collection: "cmsPages", pageId: "contact",
    latestQueueId: admitted.queueId, readyQueueId: admitted.queueId });
  const requests = { postChrome: { mode: "no-build-post-v1", path: "/posts/shadow-fixture/", rendererSha: oldPair.commitSha, method: "GET" },
    capabilities: { mode: "no-build-page-v1", path: "/contact/", rendererSha: oldPair.commitSha, method: "GET" },
    settings: { id: "public-site-chrome" }, previewRequest: { collection: "cmsPages", pageId: "contact" } };
  return { oldPair, newPair, previewPairs, readers, requests, legacyRoot, actor, now, admitted, headPath, candidates, functionsInventory, apiDeployment,
    convertedRoot: { ...releaseSelector(), activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
      selectedPair: pairReference(oldPair), recoveryPair: pairReference(newPair),
      contentHead: { ...releaseSelector().contentHead, pairId: oldPair.pairId } },
    convertedPreview: selector(...previewPairs) };
}
