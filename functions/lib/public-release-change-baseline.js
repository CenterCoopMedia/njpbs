"use strict";
const protocol = require("./public-release-pair");
const log = require("./public-release-change-log");
const source = require("./public-release-source-body");
const { publiclyVisible } = require("./public-video-references");
const { shapeJoinedRecord } = require("./joined-records");
const { parsePublicReleaseChangeBaseline } = require("./public-release-change-baseline-receipt");
const ROOT = "system/publicReleaseChanges";
const LIMIT = 10_000;
const AUTHORITY_COLLECTIONS = ["system/publicDeployment/noBuildPostOwners", "system/publicDeployment/noBuildPageOwners",
  "system/publicDeployment/noBuildRecordOwners", "system/publicDeployment/noBuildPageRoutes", "system/publicDeployment/noBuildRecordRoutes"];
const AUTHORITY_DOCUMENTS = ["system/publicDeployment", "system/publicDeployment/pairMedia/current", "system/publicDeployment/contexts/public", "system/noBuildPostAdmission",
  "system/publicDeployment/noBuildPosts/current", "system/publicDeployment/noBuildPosts/capability",
  "system/publicDeployment/noBuildPages/capability", "system/publicDeployment/noBuildRecords/capability",
  "system/publicDeployment/noBuildRecordFamilies/current", "cmsBackgroundOutputs/home"];
function refuse() { throw new protocol.PublicReleaseProtocolError(); }
function parseCursor(value) {
  protocol.exact(value, ["baselineDigest", "sequence", "lastDigest"]);
  log.parsePublicReleaseChangeHead({ schemaVersion: 2, ...value });
  return { baselineDigest: value.baselineDigest, sequence: value.sequence, lastDigest: value.lastDigest };
}
function censusRow(value) {
  protocol.exact(value, ["collection", "id", "publicRevision", "contentDigest"]);
  if (typeof value.collection !== "string" || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value.collection) ||
      value.collection.split("/").length % 2 !== 1 || !require("./public-deployment-pointer").isPublicDeploymentIdentifier(value.id) ||
      !(Number.isSafeInteger(value.publicRevision) && value.publicRevision > 0 || typeof value.publicRevision === "string" && /^[a-f0-9]{64}$/.test(value.publicRevision)) ||
      !/^[a-f0-9]{64}$/.test(value.contentDigest ?? "")) refuse();
  return { collection: value.collection, id: value.id, publicRevision: value.publicRevision, contentDigest: value.contentDigest };
}
function parseCensus(values) {
  if (!Array.isArray(values) || !values.length || values.length > LIMIT) refuse();
  let previous = "";
  return values.map(value => { const row = censusRow(value), key = `${row.collection}/${row.id}`;
    if (key <= previous) refuse(); previous = key; return row; });
}
async function rows(transaction, firestore, collection) {
  const result = await transaction.get(firestore.collection(collection).limit(LIMIT + 1));
  if (result.size > LIMIT) refuse(); return result.docs;
}
/** Public projections only: working fields/versions never enter the census. */
async function readPublicReleaseSourceCensusInTransaction({ firestore, transaction }) {
  const result = [], values = [];
  const add = (collection, id, revision, change) => {
    const value = source.makePublicReleaseSourceBody(change);
    values.push(value); result.push({ collection, id, publicRevision: revision ?? value.contentDigest, contentDigest: value.contentDigest });
  };
  for (const collection of ["cmsPosts", "cmsPages"]) for (const row of await rows(transaction, firestore, collection)) {
    const document = row.data();
    if (collection === "cmsPosts" && ["sponsor", "newsletter"].includes(document.type)) {
      const history = await transaction.get(firestore.collection("cmsVersionHistory").where("collection", "==", collection).where("documentId", "==", row.id));
      const approved = shapeJoinedRecord(row.id, document, history.docs.map(row => row.data()))?.approvedLibraryVersion;
      if (approved) add(collection, row.id, approved.version ?? null, { kind: "library", id: row.id, action: "publish", sourceVersion: approved.version ?? 1, snapshot: approved });
      continue;
    }
    if (!document.published?.metadata || !Number.isSafeInteger(document.published.sourceVersion)) continue;
    const kind = collection === "cmsPages" ? "page" : document.published.metadata.type === "post" ? "post" : "record";
    add(collection, row.id, document.published.sourceVersion, { kind, id: row.id,
      action: publiclyVisible(document) ? "publish" : "withdraw", sourceVersion: document.published.sourceVersion, snapshot: document.published });
  }
  for (const row of await rows(transaction, firestore, "cmsSettings")) {
    const published = row.data().published;
    if (published) add("cmsSettings", row.id, published.sourceVersion, { kind: "settings", id: row.id, action: "publish", sourceVersion: published.sourceVersion, snapshot: published });
  }
  for (const row of await rows(transaction, firestore, "cmsAuthorProfilesPublic")) {
    const value = row.data();
    add("cmsAuthorProfilesPublic", row.id, value.version ?? null, { kind: "author", id: row.id, action: "dependency", sourceVersion: value.version ?? 1, snapshot: value });
  }
  const media = await rows(transaction, firestore, "media_assets_public");
  const privateMedia = [];
  for (let offset = 0; offset < media.length; offset += 100) {
    privateMedia.push(...await transaction.getAll(...media.slice(offset, offset + 100).map(row => firestore.doc(`media_assets/${row.id}`))));
  }
  for (const [index, row] of media.entries()) {
    const privateValue = privateMedia[index].data();
    if (!privateValue || privateValue.lifecycle !== "active" || !["upload", "site_seed", "voiceover"].includes(privateValue.source)) refuse();
    add("media_assets_public", row.id, null, { kind: "media", id: row.id, action: "dependency", sourceVersion: 1,
      snapshot: row.data(), mediaSource: { source: privateValue.source } });
  }
  const authority = (await Promise.all(AUTHORITY_COLLECTIONS.map(name => rows(transaction, firestore, name)))).flat();
  authority.push(...await transaction.getAll(...AUTHORITY_DOCUMENTS.map(name => firestore.doc(name))));
  if (firestore.projectId === "njpbs-site-dev") authority.push(await transaction.get(
    firestore.doc("system/devPublicReleasePauseRecovery")));
  // An unsupported production marker must refuse capture, not disappear from
  // H or the live qualification census. The source codec owns this refusal.
  if (firestore.projectId === "njpbs-site") authority.push(await transaction.get(
    firestore.doc("system/productionPublicReleasePauseRecovery")));
  for (const row of authority.filter(row => row.exists)) {
    const stored = row.data(), data = source.publicReleaseAuthorityDocument(row.ref.path, stored);
    const split = row.ref.path.lastIndexOf("/"), collection = row.ref.path.slice(0, split), id = row.id;
    add(collection, id, null, { kind: "provider", id: `authority-${protocol.publicReleaseDigest(row.ref.path)}`, action: "dependency", sourceVersion: 1,
      snapshot: data, sourceDocuments: [{ path: row.ref.path, data }] });
  }
  result.sort((a, b) => `${a.collection}/${a.id}` < `${b.collection}/${b.id}` ? -1 : 1);
  const sourceMembers = parseCensus(result);
  return { sourceMembers, values, sourceMemberCensusDigest: protocol.publicReleaseDigest(sourceMembers) };
}
async function createImmutable(firestore, path, value) {
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(path), row = await transaction.get(ref);
    if (row.exists) { if (protocol.publicReleaseDigest(row.data()) !== protocol.publicReleaseDigest(value)) refuse(); return; }
    transaction.create(ref, value);
  });
}
/** Coordinator-run enrollment operator; no call site, installer or public API.
 * Bodies/pages may be prepared privately, then source and cursor are re-read in
 * the create-only receipt transaction. Losing that CAS never enrolls a partial
 * or stale baseline. No production control is changed by this function. */
async function capturePublicReleaseChangeBaseline({ firestore, logEpoch, codeAssetManifestDigest = null, currentCodeRequest, readSecret, enrollment, dryRun = false }) {
  if (!require("./public-deployment-pointer").isPublicDeploymentIdentifier(logEpoch) || typeof dryRun !== "boolean" || dryRun && !enrollment) refuse();
  const enrollmentOwner = enrollment ? require("./public-release-change-enrollment") : null;
  if (enrollment && (enrollmentOwner.parsePublicReleaseChangeEnrollmentRequest(enrollment).logEpoch !== logEpoch || codeAssetManifestDigest !== null)) refuse();
  const capture = await firestore.runTransaction(async transaction => {
    if (enrollment) return enrollmentOwner.preparePublicReleaseChangeEnrollmentInTransaction({ firestore, transaction, request: enrollment });
    const [head, pointer] = await transaction.getAll(firestore.doc(ROOT), firestore.doc("system/publicDeployment"));
    const parsed = log.parsePublicReleaseChangeHead(head.data());
    if (!/^[a-f0-9]{40}$/.test(pointer.data()?.activeCommitSha ?? "")) refuse();
    return { ...(await readPublicReleaseSourceCensusInTransaction({ firestore, transaction })),
      cursor: { baselineDigest: parsed.baselineDigest, sequence: parsed.sequence, lastDigest: parsed.lastDigest },
      liveReleaseSha: pointer.data().activeCommitSha, createdAt: head.readTime.toDate().toISOString() };
  }, { readOnly: true });
  if (capture.original) return capture.original;
  const code = require("./public-release-historical-code");
  const target = require("./publication-target").publicationTarget(firestore.projectId === "njpbs-site-dev" ? "development" : "production");
  const readCode = require("./no-build-page-schedule-reader").createPageCurrentCodeContextReader({ firestore, rendererSha: capture.liveReleaseSha, target, request: currentCodeRequest, readSecret });
  const readHistoricalCode = () => readCode.readHistoricalCodeContext ? readCode.readHistoricalCodeContext() : readCode();
  const qualified = await readHistoricalCode();
  if (qualified.publication.commitSha !== capture.liveReleaseSha) refuse();
  const retainedCode = code.prepareRetainedPublicReleaseCode(qualified);
  if (!dryRun) for (const chunk of retainedCode.chunks) await createImmutable(firestore, `${code.CHUNKS}/${chunk.digest}`, chunk.value);
  const augmentCode = census => {
    const value = source.makePublicReleaseSourceBody({ kind: "provider", id: "historical-code", action: "dependency", sourceVersion: 1,
      snapshot: retainedCode.descriptor, sourceDocuments: [{ path: code.CODE_PATH, data: retainedCode.descriptor },
        { path: `cmsPreviewPublicContexts/${retainedCode.descriptor.reference.publication.buildBatchId}`, data: retainedCode.descriptor.reference.manifest }] });
    const sourceMembers = [...census.sourceMembers, { collection: "system", id: "publicReleaseHistoricalCode", publicRevision: value.contentDigest, contentDigest: value.contentDigest }]
      .sort((a, b) => `${a.collection}/${a.id}` < `${b.collection}/${b.id}` ? -1 : 1);
    return { sourceMembers, values: [...census.values, value], sourceMemberCensusDigest: protocol.publicReleaseDigest(sourceMembers) };
  };
  Object.assign(capture, augmentCode(capture));
  if (!dryRun) for (let index = 0; index < capture.values.length; index += 50) await firestore.runTransaction(async transaction => {
    const writeBodies = await source.preparePublicReleaseSourceBodies({ firestore, transaction, values: capture.values.slice(index, index + 50) });
    writeBodies();
  });
  const pages = [];
  for (let index = 0; index < capture.sourceMembers.length; index += 100) {
    const page = { schemaVersion: 2, sourceMembers: capture.sourceMembers.slice(index, index + 100) }, digest = protocol.publicReleaseDigest(page);
    if (!dryRun) await createImmutable(firestore, `${ROOT}/censusPages/${digest}`, page); pages.push(digest);
  }
  if (!dryRun) await createImmutable(firestore, `${ROOT}/baselineCensuses/${capture.sourceMemberCensusDigest}`, { schemaVersion: 2, memberCount: capture.sourceMembers.length, pages });
  const receipt = parsePublicReleaseChangeBaseline({ schemaVersion: 2, logEpoch, baselineCursor: capture.cursor,
    liveReleaseSha: capture.liveReleaseSha, sourceMemberCensusDigest: capture.sourceMemberCensusDigest, codeAssetManifestDigest,
    ...(codeAssetManifestDigest === null ? { codeAssetManifestReason: "legacy-release-predates-code-packs" } : {}), createdAt: capture.createdAt });
  const logBaselineDigest = protocol.publicReleaseDigest(receipt);
  const freshQualified = await readHistoricalCode();
  code.prepareRetainedPublicReleaseCode(freshQualified);
  // Keep the original retained bytes; RPC map field order is not source drift.
  if (protocol.publicReleaseDigest(freshQualified) !== protocol.publicReleaseDigest(qualified)) refuse();
  return firestore.runTransaction(async transaction => {
    if (enrollment) return enrollmentOwner.commitPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction, request: enrollment,
      receipt, sourceMembers: capture.sourceMembers, logBaselineDigest, augmentCode, dryRun });
    const [head, pointer, before] = await transaction.getAll(firestore.doc(ROOT), firestore.doc("system/publicDeployment"), firestore.doc(`${ROOT}/baselines/${logEpoch}`));
    const current = augmentCode(await readPublicReleaseSourceCensusInTransaction({ firestore, transaction }));
    if (before.exists || protocol.publicReleaseDigest(parseCursor({ baselineDigest: head.data().baselineDigest, sequence: head.data().sequence, lastDigest: head.data().lastDigest })) !== protocol.publicReleaseDigest(capture.cursor) ||
        pointer.data()?.activeCommitSha !== receipt.liveReleaseSha ||
        current.sourceMemberCensusDigest !== receipt.sourceMemberCensusDigest) refuse();
    transaction.create(firestore.doc(`${ROOT}/baselines/${logEpoch}`), receipt);
    transaction.create(firestore.doc(`${ROOT}/baselineDigests/${logBaselineDigest}`), { schemaVersion: 2, logEpoch });
    return { receipt, sourceMembers: capture.sourceMembers, logBaselineDigest };
  }, dryRun ? { readOnly: true } : undefined);
}
async function assertReadPublicReleaseChangeBaselineInTransaction({ firestore, transaction, logBaselineDigest }) {
  if (!/^[a-f0-9]{64}$/.test(logBaselineDigest ?? "")) refuse();
  const index = (await transaction.get(firestore.doc(`${ROOT}/baselineDigests/${logBaselineDigest}`))).data();
  if (index?.schemaVersion !== 2 || !require("./public-deployment-pointer").isPublicDeploymentIdentifier(index.logEpoch)) refuse();
  const receipt = parsePublicReleaseChangeBaseline((await transaction.get(firestore.doc(`${ROOT}/baselines/${index.logEpoch}`))).data());
  if (protocol.publicReleaseDigest(receipt) !== logBaselineDigest || receipt.logEpoch !== index.logEpoch) refuse();
  const census = (await transaction.get(firestore.doc(`${ROOT}/baselineCensuses/${receipt.sourceMemberCensusDigest}`))).data();
  if (census?.schemaVersion !== 2 || !Array.isArray(census.pages) || census.pages.length > 100 || !Number.isSafeInteger(census.memberCount)) refuse();
  const pages = census.pages.length ? await transaction.getAll(...census.pages.map(digest => firestore.doc(`${ROOT}/censusPages/${digest}`))) : [];
  const sourceMembers = [];
  for (const [index, row] of pages.entries()) {
    if (protocol.publicReleaseDigest(row.data()) !== census.pages[index] || row.data()?.schemaVersion !== 2 || !Array.isArray(row.data()?.sourceMembers)) refuse();
    sourceMembers.push(...row.data().sourceMembers);
  }
  const parsed = parseCensus(sourceMembers);
  if (parsed.length !== census.memberCount || protocol.publicReleaseDigest(parsed) !== receipt.sourceMemberCensusDigest) refuse();
  for (const member of parsed) await source.readPublicReleaseSourceBody({ firestore, transaction, contentDigest: member.contentDigest });
  return { receipt, sourceMembers: parsed };
}
module.exports = { parsePublicReleaseChangeBaseline, readPublicReleaseSourceCensusInTransaction,
  capturePublicReleaseChangeBaseline, assertReadPublicReleaseChangeBaselineInTransaction };
