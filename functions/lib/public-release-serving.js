"use strict";

const { parseStoredPublicReleaseSelector, PublicReleaseProtocolError } = require("./public-release-pair");
const { publicationTarget, assertPublicationDatabase } = require("./publication-target");

function assertServingDatabase(firestore, environment) {
  const target = publicationTarget(environment);
  const emulator = /^demo-[a-z0-9-]+$/.test(firestore.projectId ?? "") && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "");
  if (!emulator) assertPublicationDatabase(firestore, target);
}

/** Exactly one strongly consistent document read. Never owner/catalog enumeration. */
async function readPublicReleaseSelector({ firestore, environment, now = Date.now }) {
  assertServingDatabase(firestore, environment);
  const readStartedAt = now();
  const selector = parseStoredPublicReleaseSelector((await firestore.doc("system/publicDeployment").get()).data());
  return { environment, selector, readStartedAt };
}

module.exports = { readPublicReleaseSelector, assertServingDatabase, PublicReleaseProtocolError };

const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const view = require("./public-release-pair-view");
const { parsePublicReleaseChangeHead } = require("./public-release-change-log");
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new PublicReleaseProtocolError(); };

/** Current route ownership is independent of the code pair that originally
 * accepted it. These checks intentionally do not read the legacy active SHA. */
async function readCurrentPairRouteInTransaction({ firestore, transaction, path }) {
  const pages = require("./no-build-page-ownership");
  const claim = (await transaction.get(pages.pageRouteRef(firestore, path))).data();
  if (claim) {
    if (claim.schemaVersion !== 1 || claim.path !== path) refuse();
    const { state } = await pages.readNoBuildPageOwner({ firestore, transaction, pageId: claim.pageId });
    if (!state || !state.ownedPaths.includes(path)) refuse();
    const document = (await transaction.get(firestore.doc(`cmsPages/${state.pageId}`))).data();
    pages.assertPageOwnerSnapshot(state, document);
    return routeReceipt("page", state.pageId, state, state.path, path);
  }
  if ((await pages.listNoBuildPageOwners({ firestore, transaction, path })).length) refuse();
  const postSlug = /^\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path)?.[1];
  if (postSlug) {
    const owners = await require("./no-build-post-ownership").findNoBuildPostOwnersForSlug({ firestore, transaction, slug: postSlug });
    if (owners.length > 1) refuse();
    if (owners.length) {
      const owner = owners[0].state, document = (await transaction.get(firestore.doc(`cmsPosts/${owner.postId}`))).data();
      let state = owner;
      if (owner.mode === "static") {
        const current = await require("./no-build-post-static-return").currentStaticInput({ firestore, transaction, state: owner });
        state = { ...owner, sourceVersion: current.sourceVersion, visible: current.visible, slug: current.slug,
          ownedSlugs: current.ownedSlugs, snapshotDigest: pages.digest(document.published) };
      }
      const { publiclyVisible } = require("./public-video-references");
      if (!state.ownedSlugs.includes(postSlug) || document?.published?.sourceVersion !== state.sourceVersion ||
          document.published.metadata?.slug !== state.slug || publiclyVisible(document) !== state.visible ||
          state.snapshotDigest && pages.digest(document.published) !== state.snapshotDigest) refuse();
      return routeReceipt("post", state.postId, state, `/posts/${state.slug}/`, path, owners[0].ref.path, document, owner);
    }
  }
  const family = require("./no-build-record-contract").recordFamilyForPath(path);
  if (family && /^\/(?:programs|shows|events)\/[^/]+\/$/.test(path)) {
    const records = require("./no-build-record-ownership");
    const route = (await transaction.get(records.recordRouteRef(firestore, path))).data();
    if (route) {
      if (route.schemaVersion !== 1 || route.path !== path || route.family !== family) refuse();
      const { state } = await records.readNoBuildRecordOwner({ firestore, transaction, documentId: route.documentId });
      if (!state || !state.ownedPaths.includes(path)) refuse();
      records.assertRecordOwnerSnapshot(state, (await transaction.get(firestore.doc(`cmsPosts/${state.documentId}`))).data());
      return routeReceipt("record", state.documentId, state, state.canonicalPath, path);
    }
    const missingClaims = await transaction.get(firestore.collection(records.RECORD_OWNER_COLLECTION)
      .where("ownedPaths", "array-contains", path).limit(2));
    if (!missingClaims.empty) refuse();
  }
  return { kind: "unowned" };
}
function routeReceipt(family, id, state, canonicalPath, path, actualOwnerPath, document, originalOwner = state) {
  const collection = family === "page" ? "noBuildPageOwners" : family === "post" ? "noBuildPostOwners" : "noBuildRecordOwners";
  const ownerPath = actualOwnerPath ?? `system/publicDeployment/${collection}/${id}`;
  return { kind: state.visible ? family === "record" || path === canonicalPath || path === "/_home-sources.json" ? "serve" : "redirect" : "gone",
    family, id, operationId: state.operationId, sourceVersion: state.sourceVersion,
    snapshotDigest: state.snapshotDigest ?? require("./no-build-page-ownership").digest(document.published), canonicalPath, ownerPath,
    ...(family === "post" ? { sourcePath: `cmsPosts/${id}`, sourceDigest: protocol.publicReleaseDigest(JSON.parse(JSON.stringify({
      published: document.published, publiclyVisible: require("./public-video-references").publiclyVisible(document) }))) } : {}),
    owner: require("./public-release-source-body").publicReleaseAuthorityDocument(ownerPath, originalOwner) };
}
function selectionCode(selector) {
  const code = { ...selector };
  delete code.contentHead;
  return code;
}

/** Fresh transactional decision, including retained request epochs. The view
 * locator is storage authority only; it cannot acknowledge a publication. */
async function readPublicReleaseDecision({ firestore, environment, selection, pair: rawPair, path, now = Date.now,
  readRoute = readCurrentPairRouteInTransaction,
  composedReadersEnabled = false,
  prepareComposedRead = require("./public-release-serving-replay").prepareComposedPairRead,
  readComposedArtifact = require("./public-release-serving-replay").readComposedPairArtifactInTransaction }) {
  assertServingDatabase(firestore, environment);
  const pair = protocol.parsePublicReleasePair(rawPair); work.assertPrivatePairResources(pair);
  const requested = protocol.parsePublicReleaseSelector(selection?.selector);
  const at = now();
  if (selection.environment !== environment || pair.environment !== environment ||
      !Number.isSafeInteger(selection.readStartedAt) || selection.readStartedAt > at + 100 ||
      !same(requested.selectedPair, protocol.publicReleasePairReference(pair)) ||
      !(typeof path === "string" && path.length <= 1024 && /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(path) &&
        path.split("/").every(part => ![".", ".."].includes(part)) || view.isPrivatePairArtifactPath(path)) ||
      path.startsWith("/_pair-compiled/")) refuse();
  if (at - selection.readStartedAt >= 5_000) return { kind: "reselect" };
  const base = work.publicReleasePairPath(pair.pairId);
  const prepared = composedReadersEnabled ? await prepareComposedRead({ firestore, pair, activatedOnly: true }) : null;
  return firestore.runTransaction(async transaction => {
    const refs = ["system/publicDeployment", base, `${base}/controls/runtime`, `${base}/heads/current`, "system/publicReleaseChanges"];
    const [pointerRow, pairRow, controlRow, headRow, changeRow] = await transaction.getAll(...refs.map(name => firestore.doc(name)));
    const current = protocol.parseStoredPublicReleaseSelector(pointerRow.data()), control = controlRow.data(), head = headRow.data();
    const storedPair = protocol.parsePublicReleasePair(pairRow.data());
    if (!same(pair, storedPair) || control?.schemaVersion !== 2 || control.pairId !== pair.pairId || control.status !== "retained" ||
        requested.epoch > current.epoch) refuse();
    if (requested.epoch === current.epoch) {
      if (!same(selectionCode(requested), selectionCode(current))) refuse();
    } else {
      let receipt = (await transaction.get(firestore.doc(`system/publicDeployment/switchReceipts/${requested.switchOperationId}`))).data();
      if (!receipt && requested.epoch === 1) {
        receipt = (await transaction.get(firestore.doc(`system/publicDeployment/bootstrapSelectors/${requested.switchOperationId}`))).data();
        if (receipt?.kind !== "public-release-bootstrap" || receipt.sourceDigest !== requested.priorSelectorDigest ||
            !protocol.digest(receipt.attemptDigest) || !protocol.digest(receipt.storedSelectorDigest)) refuse();
      }
      const committed = protocol.parsePublicReleaseSelector(receipt?.selector);
      if (receipt.schemaVersion !== 2 || receipt.operationId !== requested.switchOperationId ||
          receipt.selectorDigest !== protocol.publicReleaseDigest(committed) || !same(selectionCode(requested), selectionCode(committed))) refuse();
    }
    const activated = await require("./public-release-serving-head").readActivatedPairServingHeadInTransaction({
      firestore, transaction, pair, current, head, global: parsePublicReleaseChangeHead(changeRow.data()) });
    if (!activated) return { kind: "reselect" };
    const { contentHead, changes } = activated;
    let staged = (await transaction.get(firestore.doc(`${base}/views/${contentHead.manifestDigest}`))).data();
    if (!staged && !composedReadersEnabled) refuse();
    if (!staged && (!prepared || !same(prepared.contentHead, contentHead) || !same(prepared.changes, changes))) return { kind: "reselect" };
    const composed = staged ? null : await readComposedArtifact({ firestore, transaction, pair, contentHead, changes, path, readWitness: prepared.readWitness });
    if (composed) staged = (await transaction.get(firestore.doc(`${base}/views/${composed.locator.manifestDigest}`))).data();
    const physicalDigest = composed?.locator.manifestDigest ?? contentHead.manifestDigest;
    if (!staged || staged.schemaVersion !== 2 || staged.status !== "staged" || staged.pairDigest !== protocol.publicReleaseDigest(pair) ||
        staged.manifestDigest !== physicalDigest || !Number.isSafeInteger(staged.cursor?.sequence) ||
        (composed ? staged.cursor.sequence > contentHead.contextSequence : staged.cursor.sequence !== contentHead.contextSequence) ||
        staged.cursor.baselineDigest !== changes.baselineDigest || !composed && staged.cursor.lastDigest !== changes.lastDigest) refuse();
    if (composed && (composed.locator.pairDigest !== staged.pairDigest || !same(composed.locator.identity, staged.identity) ||
        composed.locator.claimDigest !== staged.claimDigest || composed.locator.manifestBytes !== staged.manifestBytes)) refuse();
    const identity = view.parseViewIdentity(staged.identity, pair);
    if (staged.taskId !== protocol.publicReleaseDigest(identity) || !protocol.digest(staged.claimDigest) ||
        !Number.isSafeInteger(staged.manifestBytes) || staged.manifestBytes < 1 || staged.manifestBytes > view.VIEW_ROOT_BYTES_LIMIT ||
        staged.manifestKey !== `${view.publicReleasePairViewPrefix(pair, identity, staged.claimDigest)}views/${staged.manifestDigest}.json`) refuse();
    const route = await readRoute({ firestore, transaction, path });
    const locator = { pairDigest: staged.pairDigest, identity, claimDigest: staged.claimDigest,
      manifestDigest: staged.manifestDigest, manifestBytes: staged.manifestBytes };
    if (composed?.absent && route.kind === "serve") return { kind: "reselect" };
    const proofLocator = route.kind === "serve" ? composed?.proofLocator ?? locator : locator;
    let proofStaged = staged;
    if (!same(proofLocator, locator)) {
      proofStaged = (await transaction.get(firestore.doc(`${base}/views/${proofLocator.manifestDigest}`))).data();
      const proofIdentity = view.parseViewIdentity(proofLocator.identity, pair);
      if (!proofStaged || proofStaged.schemaVersion !== 2 || proofStaged.status !== "staged" ||
          proofStaged.pairDigest !== locator.pairDigest || proofStaged.manifestDigest !== proofLocator.manifestDigest ||
          !same(proofStaged.identity, proofIdentity) || proofStaged.claimDigest !== proofLocator.claimDigest ||
          proofStaged.manifestBytes !== proofLocator.manifestBytes || proofStaged.taskId !== protocol.publicReleaseDigest(proofIdentity) ||
          !same(proofStaged.cursor, { baselineDigest: changes.baselineDigest, sequence: changes.sequence, lastDigest: changes.lastDigest }) ||
          !Number.isSafeInteger(proofStaged.manifestBytes) || proofStaged.manifestBytes < 1 || proofStaged.manifestBytes > view.VIEW_ROOT_BYTES_LIMIT ||
          proofStaged.manifestKey !== `${view.publicReleasePairViewPrefix(pair, proofIdentity, proofLocator.claimDigest)}views/${proofLocator.manifestDigest}.json`) refuse();
    }
    let targetProof = null;
    if (route.kind === "serve" && path !== "/_home-sources.json") {
      const proof = (await transaction.get(firestore.doc(`${base}/renderTargets/${proofLocator.manifestDigest}`))).data();
      if (!proof || proof.schemaVersion !== 1 || proof.status !== "staged" || proof.pairDigest !== proofStaged.pairDigest ||
          !same(proof.identity, proofLocator.identity) || proof.taskId !== proofStaged.taskId || proof.claimDigest !== proofLocator.claimDigest ||
          proof.viewManifestDigest !== proofLocator.manifestDigest || proof.inputManifestDigest !== proofLocator.identity.inputManifestDigest ||
          proof.snapshotDigest !== proofLocator.identity.snapshotDigest || !same(proof.cursor, proofStaged.cursor) ||
          !Number.isSafeInteger(proof.targetCount) || proof.targetCount < 1) refuse();
      targetProof = proof.descriptor;
      protocol.exact(targetProof, ["digest", "key", "bytes"]);
      if (!protocol.digest(targetProof.digest) || !Number.isSafeInteger(targetProof.bytes) || targetProof.bytes < 1 ||
          targetProof.bytes > view.VIEW_ROOT_BYTES_LIMIT ||
          targetProof.key !== view.publicReleasePairViewObjectKey(pair, proofLocator.identity, proofLocator.claimDigest, targetProof.digest)) refuse();
    }
    if (now() - selection.readStartedAt >= 5_000) return { kind: "reselect" };
    const composition = composed ? { artifactPath: composed.artifactPath, expectedBodyDigest: composed.expectedBodyDigest,
      absent: composed.absent, witnessDigest: composed.witnessDigest, proofLocator: route.kind === "serve" ? composed.proofLocator : null } : null;
    const core = { epoch: requested.epoch, pairId: pair.pairId, contentHead, locator, composition, targetProof, route, path };
    return { kind: "decision", ...core, authorityDigest: protocol.publicReleaseDigest({ ...core, currentSelector: current, changes }) };
  }, { readOnly: true });
}
module.exports.readPublicReleaseDecision = readPublicReleaseDecision;
module.exports.readCurrentPairRouteInTransaction = readCurrentPairRouteInTransaction;
