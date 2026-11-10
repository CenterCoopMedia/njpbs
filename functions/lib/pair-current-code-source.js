"use strict";
const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const code = require("./public-release-pair-code-reference");
const history = require("./public-release-historical-code");
const { parsePairCodeRequest } = require("./current-public-code-v2");
const { serializePairCurrentCodeResponse } = require("./pair-current-code-response");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const hash = value => createHash("sha256").update(value).digest("hex");
function refuse() { throw Object.assign(new Error("Versioned current CODE is unavailable"), { status: 409 }); }
async function readAuthority({ firestore, transaction, request, now, deployedReaders, includeCode = true }) {
  const cms = require("./cms-preview-pair");
  const selection = request.selection;
  const rows = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc(cms.SELECTOR_PATH),
    firestore.doc(`${cms.PAIRS}/${selection.previewPairId}`),
    firestore.doc(`${cms.READER_RECEIPTS}/functions`), firestore.doc(`${cms.READER_RECEIPTS}/cmsApi`));
  const publicSelector = p.parseVersionedPublicDeployment(rows[0].data());
  if (p.publicReleaseDigest(publicSelector) !== selection.expectedPublicSelectorDigest) refuse();
  const pair = p.parsePublicReleasePair((await transaction.get(firestore.doc(work.publicReleasePairPath(selection.pair.pairId)))).data());
  work.assertPublicReleasePairDatabase(firestore, pair);
  if (!same(p.publicReleasePairReference(pair), selection.pair)) refuse();
  const runtime = rows[1].data(), preview = cms.parsePair(rows[2].data());
  if (preview.rendererSha !== request.rendererSha || preview.pairId !== selection.previewPairId) refuse();
  if (selection.previewCandidateReceiptId) {
    const candidate = (await transaction.get(firestore.doc(`cmsDeploymentCandidates/${selection.previewCandidateReceiptId}`))).data();
    if (candidate?.schemaVersion !== 2 || candidate.state !== "verified" || candidate.component !== "renderer" ||
        candidate.mutation?.sourceSha !== request.rendererSha || !Number.isFinite(Date.parse(candidate.mutation.completedAt)) ||
        now < Date.parse(candidate.mutation.completedAt) || now - Date.parse(candidate.mutation.completedAt) > 300_000 ||
        ["pairId", "rendererSha", "serializerId", "workerName", "applicationName", "workerVersion", "imageDigest"]
          .some(key => candidate.mutation.providerIdentities?.[key] !== preview[key])) refuse();
  } else if (runtime?.schemaVersion === 2) {
    cms.parseSelector(runtime);
    if (![runtime.selectedPairId, runtime.recoveryPairId].includes(preview.pairId)) refuse();
  } else if (runtime?.schemaVersion !== 1 || runtime.phase !== "ready" || runtime.rendererSha !== request.rendererSha) refuse();
  let installed, legacyRows;
  if (deployedReaders) {
    const proofs = require("./cms-reader-bridge-proof");
    const key = proofs.cmsReaderBridgeProofKey(deployedReaders);
    installed = (await transaction.get(firestore.doc(`cmsReaderBridgeInstalledProofs/${key}`))).data();
    if (installed) {
      proofs.parseInstalledCmsReaderProof(installed, installed.proof?.operationId);
      if (proofs.cmsReaderBridgeProofKey(installed.proof.readers) !== key) refuse();
    } else {
      // This private read has no mutation or acceptance side effect. Before
      // installation it requires actual complete deployment receipts; probe
      // attempts are independent so an uncertain attempt cannot trap the reader.
      legacyRows = await transaction.getAll(...["functions", "cmsApi"]
        .map(component => firestore.doc(`cmsDeploymentReceipts/${component}`)));
    }
  }
  const readers = Object.fromEntries(["functions", "cmsApi"].map((component, index) => {
    // During first installation, actual bridge descriptors come from trusted
    // deployment configuration and must match complete live legacy receipts.
    // They cannot come from the request or a source-only supported-version list.
    const reader = deployedReaders ? cms.parseReader(deployedReaders[component]) : cms.currentReader(rows[index + 3].data(), component);
    if (deployedReaders) {
      const identity = require("./cms-reader-session").readerSessionDigest(reader);
      if (reader.component !== component) refuse();
      if (installed) {
        const original = cms.parseReader(installed.proof.readers?.[component]);
        if (installed.proof.readerIdentities?.[component] !== identity ||
            require("./cms-reader-session").readerSessionDigest(original) !== identity) refuse();
      } else {
        const legacy = legacyRows[index].data();
        if (legacy?.schemaVersion !== 1 || legacy.state !== "complete" || legacy.component !== component ||
            ["sourceSha", "inputFingerprint", "configurationFingerprint"].some(key => legacy.mutation?.[key] !== reader[key]) ||
            !same(legacy.mutation?.providerIdentities, reader.providerIdentities)) refuse();
      }
    }
    cms.assertReaderSupports(reader, [preview]);
    return [component, reader];
  }));
  let publication, resolved;
  if (includeCode) {
    const referenceRow = await transaction.get(firestore.doc(code.pairCodePublicationPath(pair)));
    publication = code.parsePairCodePublication(referenceRow.data(), pair);
    resolved = await code.assertPairCodeReferenceInTransaction({ firestore, transaction, reference: publication.reference });
  }
  if (publicSelector.schemaVersion === 2) {
    if (![publicSelector.selectedPair, publicSelector.recoveryPair].some(side => same(side, selection.pair))) refuse();
  } else {
    // First-install private replay may read the original OLD pack while the
    // live root is still legacy. It cannot name NEW or rewrite that root.
    if (!includeCode) refuse();
    const original = publication.historicalCode.reference.publication;
    if (publicSelector.state !== "idle" || pair.commitSha !== publicSelector.activeCommitSha ||
        original.generation !== publicSelector.activeGeneration) refuse();
  }
  return { pair, publicSelector, preview, readers, ...(resolved ? { publication: resolved.publication, baseline: resolved.baseline } : {}) };
}

/** Real SDK/immutable-chunk producer. Only metadata is read in transactions;
 * the complete original qualified DTO is verified outside them. No latest
 * CODE, receipt rewrite or raw-schema-one byte reconstruction is permitted.
 */
async function readVerifiedSource({ firestore, request: raw, now = Date.now, deployedReaders }) {
  const request = parsePairCodeRequest(raw);
  if (!["current-code-v2", "current-code-reference-v2"].includes(request.mode)) refuse();
  deployedReaders = deployedReaders === undefined ? undefined : structuredClone(deployedReaders);
  const before = await firestore.runTransaction(transaction => readAuthority({ firestore, transaction, request, now: now(), deployedReaders }), { readOnly: true });
  let bytes;
  if (request.mode === "current-code-v2") {
    const qualifiedCode = await history.readRetainedPublicReleaseCode({ firestore, descriptor: before.publication.historicalCode });
    bytes = Buffer.from(JSON.stringify(qualifiedCode));
  }
  const after = await firestore.runTransaction(transaction => readAuthority({ firestore, transaction, request, now: now(), deployedReaders }), { readOnly: true });
  if (!same(before, after)) refuse();
  return { request, authority: before, bytes };
}

async function readPairCurrentCode(options) {
  return serializePairCurrentCodeResponse(await readVerifiedSource(options));
}

/** CODE evidence only, derived without HTTP or caller-supplied expectations.
 * Consumer and original public source identities remain distinct. This is not
 * the 36-case installer adapter or an installed-consumer proof. In particular,
 * the unchanged legacy-root authority still refuses a NEW public source. */
async function readPairCodeReplaySource(options) {
  if (options?.request?.mode !== "current-code-v2") refuse();
  const verified = await readVerifiedSource(options), { request, authority } = verified;
  const body = Buffer.from(JSON.stringify(serializePairCurrentCodeResponse(verified)));
  return { schemaVersion: 2, kind: "retained-pair-code-replay-source", request,
    consumer: { previewPairId: authority.preview.pairId, previewPairDigest: require("./cms-preview-pair").digest(authority.preview), rendererSha: request.rendererSha },
    source: { pair: p.publicReleasePairReference(authority.pair), pairDigest: p.publicReleaseDigest(authority.pair),
      reference: authority.publication.reference, qualifiedCodeDigest: authority.publication.historicalCode.qualifiedCodeDigest },
    authorityDigest: p.publicReleaseDigest(authority),
    expected: { status: 200, contentType: "application/json", bodyDigest: hash(body) } };
}

module.exports = { readPairCurrentCode, readPairCodeReplaySource, readPairCodeAuthority: readAuthority };
