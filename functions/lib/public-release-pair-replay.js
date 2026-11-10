"use strict";

const protocol = require("./public-release-pair");
const log = require("./public-release-change-log");
const work = require("./public-release-pair-work");
const inputs = require("./public-release-pair-input");
const views = require("./public-release-pair-view");
const inventories = require("./public-release-pair-replay-inventory");
const search = require("./public-release-pair-replay-namespace");
const contentFeed = require("./public-release-pair-replay-content-feed");
const codePackOwner = require("./public-release-pair-code-pack-view");
const capsules = require("./public-release-pair-replay-capsule");
const { exact, digest, positive, freeze, publicReleaseDigest: hash } = protocol;
// Keep even maximum-size member identities below one Firestore receipt.
const PAGE_LIMIT = 20;
const history = require("./public-release-pair-replay-history");
class PairReplayError extends Error {
  constructor(code) {
    super("Private pair replay refused");
    this.name = "PairReplayError";
    this.code = code;
  }
}
function refuse(code = "replay-evidence-invalid") {
  throw new PairReplayError(code);
}
function same(a, b) {
  return hash(a) === hash(b);
}
function initialBaselineSource(operationId, logBaselineDigest) {
  return operationId === `baseline-${logBaselineDigest}` || /^baseline-controls-[a-f0-9]{64}$/.test(operationId);
}
const parseReplayCursor = history.parseReplayHistoryCursor;

function parseReplayViewReference(value, pair) {
  exact(value, ["identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const identity = views.parseViewIdentity(value.identity, pair);
  if (
    !digest(value.claimDigest) ||
    !digest(value.manifestDigest) ||
    !positive(value.manifestBytes) ||
    value.manifestBytes > views.VIEW_ROOT_BYTES_LIMIT
  )
    refuse();
  return freeze({
    identity,
    claimDigest: value.claimDigest,
    manifestDigest: value.manifestDigest,
    manifestBytes: value.manifestBytes,
  });
}
function parseReplayWitness(value, pair) {
  exact(value, [
    "schemaVersion",
    "pairRef",
    "pairDigest",
    "logBaselineDigest",
    "pairBaselineDigest",
    "fromCursor",
    "headCursor",
    "pageCount",
    "logPagesRootDigest",
    "coveredMembersDigest",
    "contentViewDigest",
    "codeAssetManifestDigest",
    "codePackOverlayDigest",
    "codePackView",
    "capsuleDigest",
    "completedAt",
  ]);
  const fromCursor = parseReplayCursor(value.fromCursor),
    headCursor = parseReplayCursor(value.headCursor);
  const codePackView = parseReplayViewReference(value.codePackView, pair);
  if (
    value.schemaVersion !== 2 ||
    !same(
      protocol.parsePublicReleasePairReference(value.pairRef),
      protocol.publicReleasePairReference(pair),
    ) ||
    value.pairDigest !== hash(pair) ||
    ![
      value.logBaselineDigest,
      value.pairBaselineDigest,
      value.coveredMembersDigest,
      value.contentViewDigest,
      value.codeAssetManifestDigest,
      value.codePackOverlayDigest,
      value.capsuleDigest,
    ].every(digest) ||
    value.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
    headCursor.baselineDigest !== fromCursor.baselineDigest ||
    fromCursor.sequence > headCursor.sequence ||
    (fromCursor.sequence === headCursor.sequence && fromCursor.lastDigest !== headCursor.lastDigest) ||
    !positive(value.completedAt)
  )
    refuse();
  history.parseReplayHistoryDescriptor(
    { fromCursor, headCursor, pageCount: value.pageCount, logPagesRootDigest: value.logPagesRootDigest },
    pair,
  );
  return freeze({
    ...value,
    pairRef: protocol.publicReleasePairReference(pair),
    fromCursor,
    headCursor,
    codePackView,
  });
}
function parseReplayCheckpoint(value, pair) {
  exact(value, [
    "schemaVersion",
    "pairDigest",
    "pairBaselineDigest",
    "cursor",
    "history",
    "coveredMembersDigest",
    "contentViewDigest",
    "codePackOverlayDigest",
    "capsuleDigest",
    "witnessDigest",
  ]);
  const cursor = parseReplayCursor(value.cursor);
  if (
    value.schemaVersion !== 2 ||
    value.pairDigest !== hash(pair) ||
    ![
      value.pairBaselineDigest,
      value.coveredMembersDigest,
      value.contentViewDigest,
      value.codePackOverlayDigest,
      value.capsuleDigest,
    ].every(digest) ||
    !(value.witnessDigest === null || digest(value.witnessDigest))
  )
    refuse();
  const parsedHistory = history.parseReplayHistoryDescriptor(value.history, pair);
  if (!same(parsedHistory.headCursor, cursor)) refuse();
  return freeze({ ...value, cursor, history: parsedHistory });
}
function replayBase(pair) {
  return work.publicReleasePairPath(pair.pairId);
}
const checkpointPath = (pair) => `${replayBase(pair)}/replay/current`;
async function immutable(transaction, firestore, path, expected) {
  const ref = firestore.doc(path),
    row = await transaction.get(ref);
  if (row.exists && !same(row.data(), expected)) refuse("replay-immutable-conflict");
  return () => {
    if (!row.exists) transaction.create(ref, expected);
  };
}
async function assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference: raw, cursor }) {
  const reference = parseReplayViewReference(raw, pair),
    identity = reference.identity;
  const receipt = await work.assertPublicReleasePairCompletedReceiptInTransaction({
    firestore,
    transaction,
    pair,
    taskId: hash(identity),
    manifestDigest: reference.manifestDigest,
    claimDigest: reference.claimDigest,
  });
  const row = await transaction.get(firestore.doc(`${replayBase(pair)}/views/${reference.manifestDigest}`));
  const staged = row.data();
  exact(staged, [
    "schemaVersion",
    "status",
    "pairDigest",
    "taskId",
    "identity",
    "claimDigest",
    "manifestDigest",
    "manifestKey",
    "manifestBytes",
    "outputCount",
    "outputBytes",
    "cursor",
    "readbackDigest",
  ]);
  if (
    staged.schemaVersion !== 2 ||
    staged.status !== "staged" ||
    staged.pairDigest !== hash(pair) ||
    staged.taskId !== hash(identity) ||
    !same(staged.identity, identity) ||
    staged.claimDigest !== reference.claimDigest ||
    staged.manifestDigest !== reference.manifestDigest ||
    staged.manifestBytes !== reference.manifestBytes ||
    !positive(staged.outputCount) ||
    staged.outputCount > views.VIEW_OUTPUT_LIMIT ||
    !Number.isSafeInteger(staged.outputBytes) ||
    staged.outputBytes < 0 ||
    staged.outputBytes > views.VIEW_TOTAL_BYTES_LIMIT ||
    !digest(staged.readbackDigest) ||
    staged.manifestKey !==
      `${views.publicReleasePairViewPrefix(pair, identity, reference.claimDigest)}views/${reference.manifestDigest}.json` ||
    !same(parseReplayCursor(staged.cursor), cursor)
  )
    refuse();
  const scope = inputs.parsePublicReleasePairInputScope({
    kind: identity.kind,
    sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion,
    snapshotDigest: identity.snapshotDigest,
    contextSequence: identity.contextSequence,
  });
  const [inputRow, scopeRow] = await transaction.getAll(
    firestore.doc(`${replayBase(pair)}/inputs/${identity.inputManifestDigest}`),
    firestore.doc(`${replayBase(pair)}/inputScopes/${inputs.publicReleasePairInputScopeKey(pair, scope)}`),
  );
  const captured = inputs.parsePublicReleasePairInputReceipt(
    inputRow.data(),
    pair,
    scope,
    identity.inputManifestDigest,
  );
  const slot = inputs.parsePublicReleasePairInputSlot(
    scopeRow.data(),
    pair,
    scope,
    identity.inputManifestDigest,
  );
  if (slot.receiptDigest !== hash(captured) || !same(captured.cursor, cursor)) refuse();
  const renderTargetProof = (
    await transaction.get(firestore.doc(`${replayBase(pair)}/renderTargets/${reference.manifestDigest}`))
  ).data();
  return {
    renderTargetProofDigest: renderTargetProof ? hash(renderTargetProof) : null,
    reference,
    inputReceiptDigest: hash(captured),
    viewReceiptDigest: hash(staged),
    workReceiptDigest: hash(receipt),
    captured,
  };
}

/** Re-read immutable log events, operation indexes and every retained member.
 * The source owner never consults mutable latest state at this boundary. */
async function readEntryEvidence({ firestore, transaction, entry }) {
  const evidence = require("./public-release-change-evidence");
  return evidence.assertReadPublicReleaseChangeEvidenceInTransaction({ firestore, transaction, entry });
}
async function readBaseline({ firestore, transaction, logBaselineDigest }) {
  const baseline = require("./public-release-change-baseline");
  const evidence = await baseline.assertReadPublicReleaseChangeBaselineInTransaction({
    firestore,
    transaction,
    logBaselineDigest,
  });
  const [control, row] = await transaction.getAll(
    firestore.doc("system/publicReleaseChangeLog"),
    firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH),
  );
  const head = log.parsePublicReleaseChangeHead(row.data()),
    cursor = evidence.receipt.baselineCursor;
  if (
    control.data()?.logEpoch !== evidence.receipt.logEpoch ||
    cursor.baselineDigest !== head.baselineDigest ||
    cursor.sequence > head.sequence ||
    (cursor.sequence === head.sequence && cursor.lastDigest !== head.lastDigest)
  )
    refuse("replay-log-epoch-changed");
  return evidence;
}

function parseReplayPairBaseline(value, pair) {
  exact(value, [
    "schemaVersion",
    "pairDigest",
    "logBaselineDigest",
    "cursor",
    "sourceInventoryDigest",
    "codeAssetManifestDigest",
    "inputReceiptDigests",
    "viewReceiptDigests",
    "views",
    "codePackView",
    "contentViewDigest",
    "codePackOverlayDigest",
  ]);
  const cursor = parseReplayCursor(value.cursor),
    codePackView = parseReplayViewReference(value.codePackView, pair);
  if (
    value.schemaVersion !== 2 ||
    value.pairDigest !== hash(pair) ||
    ![
      value.logBaselineDigest,
      value.sourceInventoryDigest,
      value.contentViewDigest,
      value.codePackOverlayDigest,
    ].every(digest) ||
    value.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
    !Array.isArray(value.views) ||
    !value.views.length ||
    value.views.length > 100 ||
    !Array.isArray(value.inputReceiptDigests) ||
    !Array.isArray(value.viewReceiptDigests) ||
    value.inputReceiptDigests.length !== value.views.length + 1 ||
    value.viewReceiptDigests.length !== value.views.length + 1 ||
    ![...value.inputReceiptDigests, ...value.viewReceiptDigests].every(digest)
  )
    refuse();
  const refs = value.views.map((view) => parseReplayViewReference(view, pair));
  if (
    new Set([...refs, codePackView].map((ref) => ref.manifestDigest)).size !== refs.length + 1 ||
    [...refs, codePackView].some((ref) => ref.identity.contextSequence !== cursor.sequence) ||
    refs.some(
      (ref) =>
        ref.identity.snapshotDigest !== value.sourceInventoryDigest ||
        !initialBaselineSource(ref.identity.sourceOperationId, value.logBaselineDigest) ||
        ref.identity.sourceOperationId !== refs[0].identity.sourceOperationId,
    )
  )
    refuse();
  return freeze({
    ...value,
    cursor,
    views: refs,
    codePackView,
    inputReceiptDigests: [...value.inputReceiptDigests],
    viewReceiptDigests: [...value.viewReceiptDigests],
  });
}
async function assertBaseline({ firestore, transaction, pair, pairBaselineDigest, baseline: rawBaseline }) {
  if (!digest(pairBaselineDigest)) refuse();
  const value =
    rawBaseline ??
    (
      await transaction.get(firestore.doc(`${replayBase(pair)}/replayBaselines/${pairBaselineDigest}`))
    ).data();
  const baseline = parseReplayPairBaseline(value, pair);
  if (hash(baseline) !== pairBaselineDigest) refuse();
  const global = await readBaseline({
    firestore,
    transaction,
    logBaselineDigest: baseline.logBaselineDigest,
  });
  if (
    !same(global.receipt.baselineCursor, baseline.cursor) ||
    global.receipt.sourceMemberCensusDigest !== baseline.sourceInventoryDigest
  )
    refuse();
  const proofs = [];
  for (const [index, reference] of [...baseline.views, baseline.codePackView].entries()) {
    const proof = await assertStagedReplayViewInTransaction({
      firestore,
      transaction,
      pair,
      reference,
      cursor: baseline.cursor,
    });
    if (
      index < baseline.views.length &&
      (proof.captured.source.kind !== "inventory" ||
        proof.captured.source.id !== reference.identity.sourceOperationId ||
        !initialBaselineSource(reference.identity.sourceOperationId, baseline.logBaselineDigest))
    )
      refuse("replay-baseline-source-mismatch");
    proofs.push(proof);
  }
  if (
    !same(
      proofs.map((proof) => proof.inputReceiptDigest),
      baseline.inputReceiptDigests,
    ) ||
    !same(
      proofs.map((proof) => proof.viewReceiptDigest),
      baseline.viewReceiptDigests,
    )
  )
    refuse();
  await assertSelectionReceipt({
    firestore,
    transaction,
    pair,
    selectionDigest: baseline.contentViewDigest,
    kind: "content",
    cursor: baseline.cursor,
  });
  await assertSelectionReceipt({
    firestore,
    transaction,
    pair,
    selectionDigest: baseline.codePackOverlayDigest,
    kind: "code-pack-overlay",
    cursor: baseline.cursor,
  });
  return { baseline, proofs };
}
function parseReplayPage(value, pair) {
  exact(value, ["schemaVersion", "pairDigest", "fromCursor", "headCursor", "entries", "coverage"]);
  const fromCursor = parseReplayCursor(value.fromCursor),
    headCursor = parseReplayCursor(value.headCursor);
  if (
    value.schemaVersion !== 2 ||
    value.pairDigest !== hash(pair) ||
    fromCursor.baselineDigest !== headCursor.baselineDigest ||
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > PAGE_LIMIT ||
    !Array.isArray(value.coverage) ||
    value.coverage.length !== value.entries.length
  )
    refuse();
  const entries = value.entries.map(log.parsePublicReleaseChange);
  const verified = log.verifyPublicReleaseChangePage(fromCursor, entries);
  if (verified.sequence !== headCursor.sequence || verified.lastDigest !== headCursor.lastDigest)
    refuse("replay-log-gap");
  const coverage = value.coverage.map((raw, index) => {
    exact(raw, [
      "entryDigest",
      "membersDigest",
      "memberContentDigests",
      "reference",
      "inputReceiptDigest",
      "viewReceiptDigest",
      "outputInventoryDigest",
      "renderTargetProofDigest",
    ]);
    const reference = parseReplayViewReference(raw.reference, pair),
      entry = entries[index];
    if (
      raw.entryDigest !== entry.entryDigest ||
      !Array.isArray(raw.memberContentDigests) ||
      raw.memberContentDigests.length !== entry.changes.length ||
      !raw.memberContentDigests.every(digest) ||
      raw.membersDigest !==
        hash(
          entry.changes.map((change, index) => ({ change, contentDigest: raw.memberContentDigests[index] })),
        ) ||
      ![
        raw.inputReceiptDigest,
        raw.viewReceiptDigest,
        raw.outputInventoryDigest,
        raw.renderTargetProofDigest,
      ].every(digest) ||
      reference.identity.sourceOperationId !== entry.operationId ||
      reference.identity.contextSequence !== entry.sequence ||
      reference.identity.sourceVersion !== Math.max(...entry.changes.map((change) => change.sourceVersion))
    )
      refuse();
    return { ...raw, memberContentDigests: [...raw.memberContentDigests], reference };
  });
  const parsed = freeze({ ...value, fromCursor, headCursor, entries, coverage });
  if (Buffer.byteLength(JSON.stringify(parsed)) > 800_000) refuse("replay-page-too-large");
  return parsed;
}
function nextCoveredMembersDigest(previous, page) {
  return hash([
    previous,
    ...page.coverage.map((coverage, index) => ({
      sequence: page.entries[index].sequence,
      entryDigest: coverage.entryDigest,
      membersDigest: coverage.membersDigest,
    })),
  ]);
}
async function readReplayBaselineSelectionState({ firestore, pair, baseline }) {
  const transaction = capsules.outsideReplayRead(firestore);
  const artifacts = await inventories.readReplayCodePackInventory({
    firestore,
    transaction,
    pair,
    codePackView: baseline.codePackView,
    baseline,
  });
  const stagedCodePack = await codePackOwner.assertReadPublicReleasePairStagedCodePackInTransaction({
    firestore,
    transaction,
    pair,
  });
  if (
    !same(stagedCodePack.identity, baseline.codePackView.identity) ||
    stagedCodePack.claimDigest !== baseline.codePackView.claimDigest ||
    stagedCodePack.viewManifestDigest !== baseline.codePackView.manifestDigest ||
    !same(stagedCodePack.cursor, baseline.cursor) ||
    stagedCodePack.memberCount !== artifacts.size ||
    stagedCodePack.memberBytes !== [...artifacts.values()].reduce((sum, member) => sum + member.size, 0)
  )
    refuse("replay-code-pack-owner-mismatch");
  const state = {
    artifacts,
    content: new Map(),
    overlay: new Map(),
    contentFeedNamespace: contentFeed.baselineReplayContentFeedNamespace({
      pair,
      artifacts,
      codePackView: baseline.codePackView,
      cursor: baseline.cursor,
    }),
    searchNamespace: search.baselineReplaySearchNamespace({
      pair,
      artifacts,
      codePackView: baseline.codePackView,
      cursor: baseline.cursor,
    }),
  };
  for (const reference of baseline.views) {
    const outputs = await inventories.readReplayOutputInventory({
      firestore,
      transaction,
      pair,
      reference,
      cursor: baseline.cursor,
      requireRenderTargets: true,
    });
    const retained = (
      await transaction.get(
        firestore.doc(`${replayBase(pair)}/replayOutputInventories/${reference.manifestDigest}`),
      )
    ).data();
    const compositeVerified = Boolean(retained?.composite);
    let remaining = outputs;
    if (compositeVerified) {
      const selectedFeed = await contentFeed.applyReplayContentFeedNamespace({
        firestore,
        transaction,
        pair,
        artifacts,
        outputs: remaining,
        reference,
        cursor: baseline.cursor,
        previous: state.contentFeedNamespace,
        overlay: state.overlay,
        retainEqual: true,
      });
      state.contentFeedNamespace = selectedFeed.state;
      const selectedSearch = await search.applyReplaySearchNamespace({
        firestore,
        transaction,
        pair,
        artifacts,
        outputs: selectedFeed.outputs,
        reference,
        cursor: baseline.cursor,
        previous: state.searchNamespace,
        overlay: state.overlay,
        retainEqual: true,
      });
      state.searchNamespace = selectedSearch.state;
      remaining = selectedSearch.outputs;
    }
    remaining = await inventories.applyReplayCatalogImages({
      firestore,
      transaction,
      pair,
      ...state,
      outputs: remaining,
      reference,
      cursor: baseline.cursor,
    });
    inventories.selectReplayOutputs({
      ...state,
      outputs: remaining,
      reference,
      baseline: true,
      compositeVerified,
    });
  }
  return state;
}
async function baselineSelections({ firestore, pair, baseline }) {
  const state = await readReplayBaselineSelectionState({ firestore, pair, baseline });
  assertSelectedDigests(
    pair,
    baseline.cursor,
    state,
    baseline.contentViewDigest,
    baseline.codePackOverlayDigest,
  );
  return state;
}
function assertSelectedDigests(pair, cursor, state, contentViewDigest, codePackOverlayDigest) {
  const content = inventories.replaySelectionManifest({
    pair,
    kind: "content",
    cursor,
    members: state.content,
  });
  const overlay = inventories.replaySelectionManifest({
    pair,
    kind: "code-pack-overlay",
    cursor,
    members: state.overlay,
  });
  if (hash(content) !== contentViewDigest || hash(overlay) !== codePackOverlayDigest)
    refuse("replay-current-selection-mismatch");
}
async function applyPageOutputs({ firestore, transaction, pair, page, state }) {
  for (const [index, coverage] of page.coverage.entries()) {
    const entry = page.entries[index],
      cursor = {
        baselineDigest: page.headCursor.baselineDigest,
        sequence: entry.sequence,
        lastDigest: entry.entryDigest,
      };
    const outputs = await inventories.readReplayOutputInventory({
      firestore,
      transaction,
      pair,
      reference: coverage.reference,
      cursor,
      inventoryDigest: coverage.outputInventoryDigest,
      renderTargetProofDigest: coverage.renderTargetProofDigest,
    });
    const selectedFeed = await contentFeed.applyReplayContentFeedNamespace({
      firestore,
      transaction,
      pair,
      artifacts: state.artifacts,
      outputs,
      reference: coverage.reference,
      cursor,
      previous: state.contentFeedNamespace,
      overlay: state.overlay,
    });
    state.contentFeedNamespace = selectedFeed.state;
    const selected = await search.applyReplaySearchNamespace({
      firestore,
      transaction,
      pair,
      artifacts: state.artifacts,
      outputs: selectedFeed.outputs,
      reference: coverage.reference,
      cursor,
      previous: state.searchNamespace,
      overlay: state.overlay,
    });
    state.searchNamespace = selected.state;
    const remaining = await inventories.applyReplayCatalogImages({
      firestore,
      transaction,
      pair,
      ...state,
      outputs: selected.outputs,
      reference: coverage.reference,
      cursor,
    });
    const retained = (
      await transaction.get(
        firestore.doc(`${replayBase(pair)}/replayOutputInventories/${coverage.reference.manifestDigest}`),
      )
    ).data();
    inventories.selectReplayOutputs({
      ...state,
      outputs: remaining,
      reference: coverage.reference,
      compositeVerified: Boolean(retained?.composite),
    });
  }
}
async function assertSelectionReceipt({ firestore, transaction, pair, selectionDigest, kind, cursor }) {
  const row = await transaction.get(firestore.doc(`${replayBase(pair)}/replaySelections/${selectionDigest}`));
  const record = row.data();
  exact(record, ["root", "readbackDigest"]);
  const root = record.root;
  exact(root, ["schemaVersion", "kind", "pairDigest", "cursor", "pages", "count"]);
  if (
    root.schemaVersion !== 2 ||
    root.kind !== kind ||
    root.pairDigest !== hash(pair) ||
    hash(root) !== selectionDigest ||
    !same(parseReplayCursor(root.cursor), cursor) ||
    !digest(record.readbackDigest) ||
    !Array.isArray(root.pages) ||
    root.pages.length > 391 ||
    !Number.isSafeInteger(root.count) ||
    root.count < 0 ||
    root.count > 100_000
  )
    refuse("replay-selection-missing");
  let count = 0,
    previous = "";
  for (const page of root.pages) {
    exact(page, ["digest", "count", "firstPath", "lastPath"]);
    if (
      !digest(page.digest) ||
      !positive(page.count) ||
      page.count > 256 ||
      typeof page.firstPath !== "string" ||
      typeof page.lastPath !== "string" ||
      Buffer.compare(Buffer.from(page.firstPath), Buffer.from(previous)) <= 0 ||
      Buffer.compare(Buffer.from(page.firstPath), Buffer.from(page.lastPath)) > 0
    )
      refuse();
    previous = page.lastPath;
    count += page.count;
  }
  if (count !== root.count) refuse();
}
async function assertTransition({
  firestore,
  transaction,
  pair,
  page,
  pageDigest,
  priorContentViewDigest,
  priorCodePackOverlayDigest,
}) {
  const row = await transaction.get(firestore.doc(`${replayBase(pair)}/replayTransitions/${pageDigest}`));
  const transition = row.data();
  exact(transition, [
    "schemaVersion",
    "pairDigest",
    "fromCursor",
    "headCursor",
    "pageDigest",
    "priorContentViewDigest",
    "priorCodePackOverlayDigest",
    "contentViewDigest",
    "codePackOverlayDigest",
  ]);
  if (
    transition.schemaVersion !== 2 ||
    transition.pairDigest !== hash(pair) ||
    transition.pageDigest !== pageDigest ||
    !same(transition.fromCursor, page.fromCursor) ||
    !same(transition.headCursor, page.headCursor) ||
    ![
      transition.priorContentViewDigest,
      transition.priorCodePackOverlayDigest,
      transition.contentViewDigest,
      transition.codePackOverlayDigest,
    ].every(digest) ||
    (priorContentViewDigest && transition.priorContentViewDigest !== priorContentViewDigest) ||
    (priorCodePackOverlayDigest && transition.priorCodePackOverlayDigest !== priorCodePackOverlayDigest)
  )
    refuse();
  await assertSelectionReceipt({
    firestore,
    transaction,
    pair,
    selectionDigest: transition.contentViewDigest,
    kind: "content",
    cursor: page.headCursor,
  });
  await assertSelectionReceipt({
    firestore,
    transaction,
    pair,
    selectionDigest: transition.codePackOverlayDigest,
    kind: "code-pack-overlay",
    cursor: page.headCursor,
  });
  return transition;
}
async function assertPage({
  firestore,
  transaction,
  pair,
  pageDigest,
  expectedCursor,
  priorContentViewDigest,
  priorCodePackOverlayDigest,
  page: rawPage,
}) {
  const value =
    rawPage ?? (await transaction.get(firestore.doc(`${replayBase(pair)}/replayPages/${pageDigest}`))).data();
  const page = parseReplayPage(value, pair);
  if (hash(page) !== pageDigest || !same(page.fromCursor, expectedCursor)) refuse("replay-log-gap");
  let lastProof;
  const proofs = [];
  for (const [index, entry] of page.entries.entries()) {
    const evidence = await readEntryEvidence({ firestore, transaction, entry });
    const coverage = page.coverage[index];
    if (
      !same(
        evidence.members.map((member) => member.contentDigest),
        coverage.memberContentDigests,
      )
    )
      refuse("replay-member-evidence-missing");
    const cursor = {
      baselineDigest: page.headCursor.baselineDigest,
      sequence: entry.sequence,
      lastDigest: entry.entryDigest,
    };
    const proof = await assertStagedReplayViewInTransaction({
      firestore,
      transaction,
      pair,
      reference: coverage.reference,
      cursor,
    });
    if (
      proof.inputReceiptDigest !== coverage.inputReceiptDigest ||
      proof.viewReceiptDigest !== coverage.viewReceiptDigest ||
      proof.renderTargetProofDigest !== coverage.renderTargetProofDigest
    )
      refuse();
    lastProof = proof;
    proofs.push(proof);
  }
  const transition = await assertTransition({
    firestore,
    transaction,
    pair,
    page,
    pageDigest,
    priorContentViewDigest,
    priorCodePackOverlayDigest,
  });
  return { page, transition, lastProof, verifiedViewProofsDigest: hash(proofs) };
}

function namespaceStates(namespaces) {
  if (
    !Array.isArray(namespaces) ||
    namespaces.length > 2 ||
    new Set(namespaces.map((value) => value.namespace)).size !== namespaces.length
  )
    refuse();
  const restore = (selected) =>
    selected
      ? {
          manifest: selected.manifest,
          view: selected.view,
          namespaceRootDigest: selected.namespaceRootDigest,
          namespaceManifestDigest: selected.namespaceManifestDigest,
          priorPaths: new Set(selected.priorPaths),
        }
      : null;
  if (namespaces.some((value) => !["/pagefind/", "/api/v1/content/"].includes(value.namespace))) refuse();
  return {
    searchNamespace: restore(namespaces.find((value) => value.namespace === "/pagefind/")),
    contentFeedNamespace: restore(namespaces.find((value) => value.namespace === "/api/v1/content/")),
  };
}
function replayNamespacesProof(state, headCursor) {
  return [
    ...contentFeed.replayContentFeedNamespaceProof(state.contentFeedNamespace, headCursor),
    ...search.replaySearchNamespaceProof(state.searchNamespace, headCursor),
  ];
}

async function assertMutableReplayAuthority({
  firestore,
  transaction,
  pair,
  baseline,
  lastView,
  lastViewProofDigest,
}) {
  const root = "system/publicReleaseChanges";
  const [control, index, headRow] = await transaction.getAll(
    firestore.doc("system/publicReleaseChangeLog"),
    firestore.doc(`${root}/baselineDigests/${baseline.logBaselineDigest}`),
    firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH),
  );
  const epoch = index.data()?.logEpoch;
  if (index.data()?.schemaVersion !== 2 || typeof epoch !== "string" || epoch !== control.data()?.logEpoch)
    refuse("replay-log-epoch-changed");
  const receipt = require("./public-release-change-baseline").parsePublicReleaseChangeBaseline(
    (await transaction.get(firestore.doc(`${root}/baselines/${epoch}`))).data(),
  );
  const head = log.parsePublicReleaseChangeHead(headRow.data());
  if (
    hash(receipt) !== baseline.logBaselineDigest ||
    receipt.sourceMemberCensusDigest !== baseline.sourceInventoryDigest ||
    !same(receipt.baselineCursor, baseline.cursor) ||
    head.baselineDigest !== baseline.cursor.baselineDigest
  )
    refuse("replay-log-epoch-changed");
  const references = new Map([baseline.codePackView, lastView].map((ref) => [hash(ref), ref]));
  for (const reference of references.values()) {
    const cursor =
      reference.identity.contextSequence === baseline.cursor.sequence
        ? baseline.cursor
        : {
            baselineDigest: head.baselineDigest,
            sequence: reference.identity.contextSequence,
            lastDigest: (
              await transaction.get(
                firestore.doc(
                  `${root}/entries/${String(reference.identity.contextSequence).padStart(16, "0")}`,
                ),
              )
            ).data()?.entryDigest,
          };
    const proof = await assertStagedReplayViewInTransaction({
      firestore,
      transaction,
      pair,
      reference,
      cursor,
    });
    if (hash(reference) === hash(lastView) && hash(proof) !== lastViewProofDigest)
      refuse("replay-owner-changed");
    if (
      hash(reference) === hash(baseline.codePackView) &&
      (proof.inputReceiptDigest !== baseline.inputReceiptDigests.at(-1) ||
        proof.viewReceiptDigest !== baseline.viewReceiptDigests.at(-1))
    )
      refuse("replay-owner-changed");
  }
  return head;
}
async function acceptedCapsule({ firestore, transaction, pair, capsuleDigest }) {
  const result = await capsules.readReplayCapsule({
    firestore,
    transaction,
    pair,
    capsuleDigest,
    accepted: true,
  });
  if (result.capsule.pageIndex) {
    const prior = (
      await transaction.get(
        firestore.doc(`${replayBase(pair)}/replayCapsuleIndexes/${result.capsule.pageIndex - 1}`),
      )
    ).data();
    if (
      prior?.schemaVersion !== 2 ||
      prior.pairDigest !== hash(pair) ||
      prior.pageIndex !== result.capsule.pageIndex - 1 ||
      prior.capsuleDigest !== result.capsule.prevCapsuleDigest
    )
      refuse("replay-capsule-link-mismatch");
  }
  return result;
}
async function preparePublicReleasePairReplayBaselineCapsule({
  firestore,
  pair: rawPair,
  baseline: rawBaseline,
  verifiedAt,
}) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    baseline = parseReplayPairBaseline(rawBaseline, pair);
  const transaction = capsules.outsideReplayRead(firestore),
    pairBaselineDigest = hash(baseline);
  const { proofs } = await assertBaseline({ firestore, transaction, pair, pairBaselineDigest, baseline });
  const state = await baselineSelections({ firestore, transaction, pair, baseline });
  const readback = await transaction.get(
    firestore.doc(`${replayBase(pair)}/replayBaselineReadbacks/${pairBaselineDigest}`),
  );
  if (!same(readback.data(), baseline)) refuse("replay-baseline-readback-missing");
  const namespaceProof = await capsules.writeReplayNamespaceProof({
    firestore,
    pair,
    namespaces: replayNamespacesProof(state, baseline.cursor),
  });
  const evidence = {
    schemaVersion: 2,
    pairDigest: hash(pair),
    logBaselineDigest: baseline.logBaselineDigest,
    priorStateDigest: null,
    state: {
      pairBaselineDigest,
      cursor: baseline.cursor,
      history: history.emptyReplayHistory(pair, baseline.cursor),
      coveredMembersDigest: hash([]),
      contentViewDigest: baseline.contentViewDigest,
      codePackOverlayDigest: baseline.codePackOverlayDigest,
    },
    codePackView: baseline.codePackView,
    lastView: baseline.views.at(-1),
    lastViewProofDigest: hash(proofs.at(-2)),
    verifiedViewProofsDigest: hash(proofs),
    namespaceProof,
  };
  return capsules.prepareReplayCapsule({
    firestore,
    pair,
    pageIndex: 0,
    pageDigest: pairBaselineDigest,
    prevCapsuleDigest: null,
    evidence,
    verifiedAt,
  });
}
async function preparePublicReleasePairReplayPageCapsule({
  firestore,
  pair: rawPair,
  page: rawPage,
  contentViewDigest,
  codePackOverlayDigest,
  verifiedAt,
}) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    page = parseReplayPage(rawPage, pair),
    pageDigest = hash(page);
  const transaction = capsules.outsideReplayRead(firestore);
  const checkpoint = parseReplayCheckpoint(
    (await transaction.get(firestore.doc(checkpointPath(pair)))).data(),
    pair,
  );
  const prior = await acceptedCapsule({
    firestore,
    transaction,
    pair,
    capsuleDigest: checkpoint.capsuleDigest,
  });
  if (
    !same(prior.evidence.state, capsules.checkpointState(checkpoint)) ||
    !same(checkpoint.cursor, page.fromCursor)
  )
    refuse("replay-cursor-conflict");
  const baseline = parseReplayPairBaseline(
    (
      await transaction.get(
        firestore.doc(`${replayBase(pair)}/replayBaselines/${checkpoint.pairBaselineDigest}`),
      )
    ).data(),
    pair,
  );
  const { transition, lastProof, verifiedViewProofsDigest } = await assertPage({
    firestore,
    transaction,
    pair,
    page,
    pageDigest,
    expectedCursor: checkpoint.cursor,
    priorContentViewDigest: checkpoint.contentViewDigest,
    priorCodePackOverlayDigest: checkpoint.codePackOverlayDigest,
  });
  if (
    transition.contentViewDigest !== contentViewDigest ||
    transition.codePackOverlayDigest !== codePackOverlayDigest
  )
    refuse();
  const artifacts = await inventories.readReplayCodePackInventory({
    firestore,
    transaction,
    pair,
    codePackView: baseline.codePackView,
    baseline,
  });
  const content = await inventories.readReplaySelectionMembers({
    firestore,
    transaction,
    pair,
    kind: "content",
    cursor: page.fromCursor,
    selectionDigest: checkpoint.contentViewDigest,
  });
  const overlay = await inventories.readReplaySelectionMembers({
    firestore,
    transaction,
    pair,
    kind: "code-pack-overlay",
    cursor: page.fromCursor,
    selectionDigest: checkpoint.codePackOverlayDigest,
  });
  const namespaces = await capsules.readReplayNamespaceProof({
    firestore,
    pair,
    descriptor: prior.evidence.namespaceProof,
  });
  const state = { content, overlay, artifacts, ...namespaceStates(namespaces) };
  await applyPageOutputs({ firestore, transaction, pair, page, state });
  assertSelectedDigests(pair, page.headCursor, state, contentViewDigest, codePackOverlayDigest);
  const appended = await history.appendReplayHistoryInTransaction({
    firestore,
    transaction,
    pair,
    history: checkpoint.history,
    pageDigest,
    headCursor: page.headCursor,
  });
  const namespaceProof = await capsules.writeReplayNamespaceProof({
    firestore,
    pair,
    namespaces: replayNamespacesProof(state, page.headCursor),
  });
  const evidence = {
    schemaVersion: 2,
    pairDigest: hash(pair),
    logBaselineDigest: baseline.logBaselineDigest,
    priorStateDigest: hash(capsules.checkpointState(checkpoint)),
    state: {
      pairBaselineDigest: checkpoint.pairBaselineDigest,
      cursor: page.headCursor,
      history: appended.history,
      coveredMembersDigest: nextCoveredMembersDigest(checkpoint.coveredMembersDigest, page),
      contentViewDigest,
      codePackOverlayDigest,
    },
    codePackView: baseline.codePackView,
    lastView: page.coverage.at(-1).reference,
    lastViewProofDigest: hash(lastProof),
    verifiedViewProofsDigest,
    namespaceProof,
  };
  return capsules.prepareReplayCapsule({
    firestore,
    pair,
    pageIndex: appended.history.pageCount,
    pageDigest,
    prevCapsuleDigest: checkpoint.capsuleDigest,
    evidence,
    verifiedAt,
  });
}

/** Immutable baseline registration follows complete frozen input/output readback
 * in the private replay runner. This cannot register a new global log epoch. */
async function commitPublicReleasePairReplayBaseline({ firestore, pair: rawPair, baseline: rawBaseline }) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    baseline = parseReplayPairBaseline(rawBaseline, pair),
    pairBaselineDigest = hash(baseline);
  return firestore.runTransaction(async (transaction) => {
    for (const reference of baseline.views) if (reference.identity.sourceOperationId.startsWith("baseline-controls-")) {
      await require("./public-release-initial-control-guard").assertInitialControlCaptureInTransaction({
        firestore, transaction, pair, scope: reference.identity });
    }
    const candidate = await capsules.readReplayPageCapsule({
      firestore,
      transaction,
      pair,
      pageDigest: pairBaselineDigest,
    });
    if (
      candidate.capsule.pageIndex !== 0 ||
      candidate.evidence.logBaselineDigest !== baseline.logBaselineDigest ||
      candidate.evidence.state.pairBaselineDigest !== pairBaselineDigest ||
      !same(candidate.evidence.state.cursor, baseline.cursor) ||
      candidate.evidence.state.contentViewDigest !== baseline.contentViewDigest ||
      candidate.evidence.state.codePackOverlayDigest !== baseline.codePackOverlayDigest
    )
      refuse();
    await assertMutableReplayAuthority({
      firestore,
      transaction,
      pair,
      baseline,
      lastView: candidate.evidence.lastView,
      lastViewProofDigest: candidate.evidence.lastViewProofDigest,
    });
    const create = await immutable(
      transaction,
      firestore,
      `${replayBase(pair)}/replayBaselines/${pairBaselineDigest}`,
      baseline,
    );
    const ref = firestore.doc(checkpointPath(pair)),
      before = await transaction.get(ref);
    if (before.exists) {
      if (parseReplayCheckpoint(before.data(), pair).pairBaselineDigest !== pairBaselineDigest)
        refuse("replay-baseline-conflict");
      return { idempotent: true, pairBaselineDigest };
    }
    const index = await capsules.prepareReplayCapsuleIndex({
      firestore,
      transaction,
      pair,
      capsuleDigest: candidate.capsuleDigest,
      pageIndex: 0,
    });
    const coverage = await capsules.prepareReplayCoveredViews({
      firestore,
      transaction,
      pair,
      pairBaselineDigest,
      references: [...baseline.views, baseline.codePackView],
      pageIndex: 0,
      capsuleDigest: candidate.capsuleDigest,
    });
    create();
    index();
    coverage();
    transaction.create(ref, {
      schemaVersion: 2,
      pairDigest: hash(pair),
      ...candidate.evidence.state,
      capsuleDigest: candidate.capsuleDigest,
      witnessDigest: null,
    });
    return { idempotent: false, pairBaselineDigest };
  });
}

/** Commit one complete verified page and its selections together. No accepted
 * publication is enqueued or settled, and no public selector is written. */
async function commitPublicReleasePairReplayPage({
  firestore,
  pair: rawPair,
  page: rawPage,
  contentViewDigest,
  codePackOverlayDigest,
}) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    page = parseReplayPage(rawPage, pair),
    pageDigest = hash(page);
  return firestore.runTransaction(async (transaction) => {
    const ref = firestore.doc(checkpointPath(pair)),
      row = await transaction.get(ref);
    if (!row.exists) refuse("replay-baseline-missing");
    const checkpoint = parseReplayCheckpoint(row.data(), pair);
    const candidate = await capsules.readReplayPageCapsule({ firestore, transaction, pair, pageDigest });
    const existing = await transaction.get(firestore.doc(`${replayBase(pair)}/replayPages/${pageDigest}`));
    if (existing.exists) {
      await acceptedCapsule({ firestore, transaction, pair, capsuleDigest: candidate.capsuleDigest });
      if (!same(existing.data(), page) || candidate.capsule.pageIndex > checkpoint.history.pageCount)
        refuse();
      return { idempotent: true, pageDigest };
    }
    const prior = await acceptedCapsule({
      firestore,
      transaction,
      pair,
      capsuleDigest: checkpoint.capsuleDigest,
    });
    if (
      !same(prior.evidence.state, capsules.checkpointState(checkpoint)) ||
      !same(checkpoint.cursor, page.fromCursor) ||
      candidate.capsule.pageIndex !== checkpoint.history.pageCount + 1 ||
      candidate.capsule.prevCapsuleDigest !== checkpoint.capsuleDigest ||
      candidate.evidence.priorStateDigest !== hash(capsules.checkpointState(checkpoint)) ||
      candidate.evidence.state.pairBaselineDigest !== checkpoint.pairBaselineDigest ||
      candidate.evidence.state.contentViewDigest !== contentViewDigest ||
      candidate.evidence.state.codePackOverlayDigest !== codePackOverlayDigest ||
      !same(candidate.evidence.state.cursor, page.headCursor) ||
      candidate.evidence.state.coveredMembersDigest !==
        nextCoveredMembersDigest(checkpoint.coveredMembersDigest, page)
    )
      refuse("replay-cursor-conflict");
    const baseline = parseReplayPairBaseline(
      (
        await transaction.get(
          firestore.doc(`${replayBase(pair)}/replayBaselines/${checkpoint.pairBaselineDigest}`),
        )
      ).data(),
      pair,
    );
    const head = await assertMutableReplayAuthority({
      firestore,
      transaction,
      pair,
      baseline,
      lastView: candidate.evidence.lastView,
      lastViewProofDigest: candidate.evidence.lastViewProofDigest,
    });
    if (
      head.sequence < page.headCursor.sequence ||
      (head.sequence === page.headCursor.sequence && head.lastDigest !== page.headCursor.lastDigest)
    )
      refuse("replay-log-head-changed");
    const appended = await history.appendReplayHistoryInTransaction({
      firestore,
      transaction,
      pair,
      history: checkpoint.history,
      pageDigest,
      headCursor: page.headCursor,
    });
    if (!same(appended.history, candidate.evidence.state.history)) refuse("replay-capsule-link-mismatch");
    const index = await capsules.prepareReplayCapsuleIndex({
      firestore,
      transaction,
      pair,
      capsuleDigest: candidate.capsuleDigest,
      pageIndex: candidate.capsule.pageIndex,
    });
    const coverage = await capsules.prepareReplayCoveredViews({
      firestore,
      transaction,
      pair,
      pairBaselineDigest: checkpoint.pairBaselineDigest,
      references: page.coverage.map((member) => member.reference),
      pageIndex: candidate.capsule.pageIndex,
      capsuleDigest: candidate.capsuleDigest,
    });
    appended.write();
    index();
    coverage();
    transaction.create(firestore.doc(`${replayBase(pair)}/replayPages/${pageDigest}`), page);
    transaction.set(ref, {
      schemaVersion: 2,
      pairDigest: hash(pair),
      ...candidate.evidence.state,
      capsuleDigest: candidate.capsuleDigest,
      witnessDigest: null,
    });
    return { idempotent: false, pageDigest };
  });
}

async function readReplayWitnessLogPagesInTransaction({ firestore, transaction, pair, witness: raw }) {
  const witness = parseReplayWitness(raw, pair);
  return history.readReplayHistoryInTransaction({
    firestore,
    transaction,
    pair,
    history: {
      fromCursor: witness.fromCursor,
      headCursor: witness.headCursor,
      pageCount: witness.pageCount,
      logPagesRootDigest: witness.logPagesRootDigest,
    },
  });
}

async function auditPublicReleasePairReplayWitness({
  firestore,
  pair: rawPair,
  headCursor: rawCursor,
  witnessDigest,
  selectedViews = [],
}) {
  const transaction = capsules.outsideReplayRead(firestore);
  const pair = protocol.parsePublicReleasePair(rawPair),
    headCursor = parseReplayCursor(rawCursor);
  if (!digest(witnessDigest)) refuse();
  const row = await transaction.get(firestore.doc(`${replayBase(pair)}/replayWitnesses/${witnessDigest}`));
  const witness = parseReplayWitness(row.data(), pair);
  if (hash(witness) !== witnessDigest || !same(witness.headCursor, headCursor)) refuse();
  const { baseline, proofs: baselineProofs } = await assertBaseline({
    firestore,
    transaction,
    pair,
    pairBaselineDigest: witness.pairBaselineDigest,
  });
  if (
    !same(witness.fromCursor, baseline.cursor) ||
    witness.logBaselineDigest !== baseline.logBaselineDigest ||
    !same(witness.codePackView, baseline.codePackView)
  )
    refuse();
  const selectionState = await baselineSelections({ firestore, transaction, pair, baseline });
  const approvedViews = new Set([...baseline.views, baseline.codePackView].map(hash));
  let cursor = baseline.cursor,
    covered = hash([]),
    contentViewDigest = baseline.contentViewDigest,
    codePackOverlayDigest = baseline.codePackOverlayDigest;
  const logPageDigests = await readReplayWitnessLogPagesInTransaction({
    firestore,
    transaction,
    pair,
    witness,
  });
  let auditState = {
    pairBaselineDigest: witness.pairBaselineDigest,
    cursor: baseline.cursor,
    history: history.emptyReplayHistory(pair, baseline.cursor),
    coveredMembersDigest: hash([]),
    contentViewDigest: baseline.contentViewDigest,
    codePackOverlayDigest: baseline.codePackOverlayDigest,
  };
  const expectedCapsules = [
    {
      state: auditState,
      lastView: baseline.views.at(-1),
      lastViewProofDigest: hash(baselineProofs.at(-2)),
      verifiedViewProofsDigest: hash(baselineProofs),
      namespaces: replayNamespacesProof(selectionState, baseline.cursor),
    },
  ];
  for (const pageDigest of logPageDigests) {
    const { page, transition, lastProof, verifiedViewProofsDigest } = await assertPage({
      firestore,
      transaction,
      pair,
      pageDigest,
      expectedCursor: cursor,
      priorContentViewDigest: contentViewDigest,
      priorCodePackOverlayDigest: codePackOverlayDigest,
    });
    contentViewDigest = transition.contentViewDigest;
    codePackOverlayDigest = transition.codePackOverlayDigest;
    for (const coverage of page.coverage) approvedViews.add(hash(coverage.reference));
    await applyPageOutputs({ firestore, transaction, pair, page, state: selectionState });
    assertSelectedDigests(
      pair,
      page.headCursor,
      selectionState,
      transition.contentViewDigest,
      transition.codePackOverlayDigest,
    );
    cursor = page.headCursor;
    covered = nextCoveredMembersDigest(covered, page);
    const appended = await history.appendReplayHistoryInTransaction({
      firestore,
      transaction,
      pair,
      history: auditState.history,
      pageDigest,
      headCursor: page.headCursor,
    });
    auditState = {
      pairBaselineDigest: witness.pairBaselineDigest,
      cursor: page.headCursor,
      history: appended.history,
      coveredMembersDigest: covered,
      contentViewDigest,
      codePackOverlayDigest,
    };
    expectedCapsules.push({
      state: auditState,
      lastView: page.coverage.at(-1).reference,
      lastViewProofDigest: hash(lastProof),
      verifiedViewProofsDigest,
      namespaces: replayNamespacesProof(selectionState, page.headCursor),
    });
  }
  if (
    !same(cursor, headCursor) ||
    witness.coveredMembersDigest !== covered ||
    witness.contentViewDigest !== contentViewDigest ||
    witness.codePackOverlayDigest !== codePackOverlayDigest
  )
    refuse("replay-log-gap");
  if (!Array.isArray(selectedViews) || selectedViews.length > 100_001)
    refuse("replay-selection-view-uncovered");
  for (const reference of selectedViews) {
    if (!approvedViews.has(hash(parseReplayViewReference(reference, pair))))
      refuse("replay-selection-view-uncovered");
  }
  const head = log.parsePublicReleaseChangeHead(
    (await transaction.get(firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH))).data(),
  );
  if (
    head.baselineDigest !== headCursor.baselineDigest ||
    head.sequence < headCursor.sequence ||
    (head.sequence === headCursor.sequence && head.lastDigest !== headCursor.lastDigest)
  )
    refuse();
  let previous = null;
  const namespaceReads = new Map();
  for (const [pageIndex, pageDigest] of [witness.pairBaselineDigest, ...logPageDigests].entries()) {
    const certified = await capsules.readReplayPageCapsule({ firestore, transaction, pair, pageDigest });
    await acceptedCapsule({ firestore, transaction, pair, capsuleDigest: certified.capsuleDigest });
    if (certified.capsule.pageIndex !== pageIndex || certified.capsule.prevCapsuleDigest !== previous)
      refuse("replay-capsule-link-mismatch");
    const expected = expectedCapsules[pageIndex];
    if (
      !same(certified.evidence.state, expected.state) ||
      !same(certified.evidence.lastView, expected.lastView) ||
      certified.evidence.lastViewProofDigest !== expected.lastViewProofDigest ||
      certified.evidence.verifiedViewProofsDigest !== expected.verifiedViewProofsDigest ||
      !same(certified.evidence.codePackView, baseline.codePackView) ||
      certified.evidence.logBaselineDigest !== baseline.logBaselineDigest ||
      certified.evidence.priorStateDigest !== (pageIndex ? hash(expectedCapsules[pageIndex - 1].state) : null)
    )
      refuse("replay-capsule-conflict");
    const descriptor = certified.evidence.namespaceProof,
      key = hash(descriptor);
    if (!namespaceReads.has(key))
      namespaceReads.set(key, await capsules.readReplayNamespaceProof({ firestore, pair, descriptor }));
    if (!same(namespaceReads.get(key), expected.namespaces)) refuse("replay-capsule-conflict");
    previous = certified.capsuleDigest;
  }
  if (previous !== witness.capsuleDigest) refuse("replay-capsule-link-mismatch");
  const namespaces = replayNamespacesProof(selectionState, headCursor);
  return { witness, namespaces };
}
async function readReplayRows(transaction, firestore, paths) {
  const rows = [];
  for (let start = 0; start < paths.length; start += 200)
    rows.push(
      ...(await transaction.getAll(...paths.slice(start, start + 200).map((path) => firestore.doc(path)))),
    );
  return rows;
}
async function assertSelectedReplayViews({ firestore, transaction, pair, witness, selectedViews }) {
  if (!Array.isArray(selectedViews) || selectedViews.length > 100_001)
    refuse("replay-selection-view-uncovered");
  const references = new Map(
    selectedViews.map((raw) => {
      const reference = parseReplayViewReference(raw, pair);
      return [hash(reference), reference];
    }),
  );
  const entries = [...references],
    rows = await readReplayRows(
      transaction,
      firestore,
      entries.map(([digest]) => `${replayBase(pair)}/replayCoveredViews/${digest}`),
    );
  const indexes = new Map();
  for (const [index, snapshot] of rows.entries()) {
    const row = snapshot.data(),
      reference = entries[index][1];
    if (!row) refuse("replay-selection-view-uncovered");
    exact(row, [
      "schemaVersion",
      "pairDigest",
      "pairBaselineDigest",
      "reference",
      "pageIndex",
      "capsuleDigest",
    ]);
    if (
      row.schemaVersion !== 2 ||
      row.pairDigest !== hash(pair) ||
      row.pairBaselineDigest !== witness.pairBaselineDigest ||
      !same(row.reference, reference) ||
      !Number.isSafeInteger(row.pageIndex) ||
      row.pageIndex < 0 ||
      row.pageIndex > witness.pageCount ||
      (indexes.has(row.pageIndex) && indexes.get(row.pageIndex) !== row.capsuleDigest)
    )
      refuse("replay-selection-view-uncovered");
    indexes.set(row.pageIndex, row.capsuleDigest);
  }
  const keys = [...indexes.keys()],
    accepted = await readReplayRows(
      transaction,
      firestore,
      keys.map((index) => `${replayBase(pair)}/replayCapsuleIndexes/${index}`),
    );
  for (const [index, snapshot] of accepted.entries()) {
    const row = snapshot.data(),
      pageIndex = keys[index];
    if (!row) refuse("replay-selection-view-uncovered");
    exact(row, ["schemaVersion", "pairDigest", "pageIndex", "capsuleDigest"]);
    if (
      row.schemaVersion !== 2 ||
      row.pairDigest !== hash(pair) ||
      row.pageIndex !== pageIndex ||
      row.capsuleDigest !== indexes.get(pageIndex)
    )
      refuse("replay-selection-view-uncovered");
  }
}

async function assertReplayWitnessCapsule({
  firestore,
  transaction,
  pair: rawPair,
  headCursor: rawCursor,
  witnessDigest,
  selectedViews = [],
}) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    headCursor = parseReplayCursor(rawCursor);
  if (!digest(witnessDigest)) refuse();
  const witness = parseReplayWitness(
    (await transaction.get(firestore.doc(`${replayBase(pair)}/replayWitnesses/${witnessDigest}`))).data(),
    pair,
  );
  if (hash(witness) !== witnessDigest || !same(witness.headCursor, headCursor)) refuse();
  const certified = await acceptedCapsule({
    firestore,
    transaction,
    pair,
    capsuleDigest: witness.capsuleDigest,
  });
  const baseline = parseReplayPairBaseline(
    (
      await transaction.get(
        firestore.doc(`${replayBase(pair)}/replayBaselines/${witness.pairBaselineDigest}`),
      )
    ).data(),
    pair,
  );
  const state = certified.evidence.state;
  if (
    state.contentViewDigest !== witness.contentViewDigest ||
    state.codePackOverlayDigest !== witness.codePackOverlayDigest
  )
    refuse("replay-current-selection-mismatch");
  if (certified.evidence.lastView.identity.contextSequence !== headCursor.sequence)
    refuse("replay-owner-changed");
  if (
    hash(baseline) !== witness.pairBaselineDigest ||
    !same(witness.fromCursor, baseline.cursor) ||
    witness.logBaselineDigest !== baseline.logBaselineDigest ||
    certified.evidence.logBaselineDigest !== baseline.logBaselineDigest ||
    !same(witness.codePackView, baseline.codePackView) ||
    state.pairBaselineDigest !== witness.pairBaselineDigest ||
    !same(state.cursor, headCursor) ||
    state.history.pageCount !== witness.pageCount ||
    state.history.logPagesRootDigest !== witness.logPagesRootDigest ||
    !same(state.history.fromCursor, witness.fromCursor) ||
    state.coveredMembersDigest !== witness.coveredMembersDigest ||
    state.contentViewDigest !== witness.contentViewDigest ||
    state.codePackOverlayDigest !== witness.codePackOverlayDigest
  )
    refuse();
  const tail = await history.readReplayHistoryTailInTransaction({
    firestore,
    transaction,
    pair,
    history: state.history,
  });
  if (tail && tail.logPageDigests.at(-1) !== certified.capsule.pageDigest)
    refuse("replay-capsule-link-mismatch");
  const head = await assertMutableReplayAuthority({
    firestore,
    transaction,
    pair,
    baseline,
    lastView: certified.evidence.lastView,
    lastViewProofDigest: certified.evidence.lastViewProofDigest,
  });
  if (
    head.sequence < headCursor.sequence ||
    (head.sequence === headCursor.sequence && head.lastDigest !== headCursor.lastDigest)
  )
    refuse();
  await assertSelectedReplayViews({ firestore, transaction, pair, witness, selectedViews });
  return { witness, certified };
}
async function assertReadReplayWitnessInTransaction(options) {
  return (await assertReplayWitnessCapsule(options)).witness;
}
async function assertReadReplayWitnessProofInTransaction(options) {
  const { witness, certified } = await assertReplayWitnessCapsule(options);
  const namespaces = options.namespaces ?? [];
  if (
    options.headView &&
    !same(parseReplayViewReference(options.headView, options.pair), certified.evidence.lastView)
  )
    refuse("replay-head-view-mismatch");
  if (hash(namespaces) !== certified.evidence.namespaceProof.payloadDigest)
    refuse("replay-namespace-readback-required");
  return { witness, namespaces, headView: certified.evidence.lastView };
}
async function openPublicReleasePairReplayWitnessProof(options) {
  const pair = protocol.parsePublicReleasePair(options.pair);
  const { witness, certified } = await assertReplayWitnessCapsule({
    ...options,
    pair,
    transaction: capsules.outsideReplayRead(options.firestore),
  });
  const namespaces = await capsules.readReplayNamespaceProof({
    firestore: options.firestore,
    pair,
    descriptor: certified.evidence.namespaceProof,
  });
  return { witness, namespaces, headView: certified.evidence.lastView };
}
async function sealPublicReleasePairReplayWitness({ firestore, pair: rawPair, completedAt = Date.now() }) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  if (!positive(completedAt)) refuse();
  return firestore.runTransaction(async (transaction) => {
    const ref = firestore.doc(checkpointPath(pair)),
      row = await transaction.get(ref);
    if (!row.exists) refuse("replay-baseline-missing");
    const checkpoint = parseReplayCheckpoint(row.data(), pair);
    const certified = await acceptedCapsule({
      firestore,
      transaction,
      pair,
      capsuleDigest: checkpoint.capsuleDigest,
    });
    if (
      !same(certified.evidence.state, capsules.checkpointState(checkpoint)) ||
      certified.evidence.lastView.identity.contextSequence !== checkpoint.cursor.sequence
    )
      refuse("replay-capsule-conflict");
    const baseline = parseReplayPairBaseline(
      (
        await transaction.get(
          firestore.doc(`${replayBase(pair)}/replayBaselines/${checkpoint.pairBaselineDigest}`),
        )
      ).data(),
      pair,
    );
    if (
      hash(baseline) !== checkpoint.pairBaselineDigest ||
      certified.evidence.logBaselineDigest !== baseline.logBaselineDigest
    )
      refuse();
    const tail = await history.readReplayHistoryTailInTransaction({
      firestore,
      transaction,
      pair,
      history: checkpoint.history,
    });
    if (tail && tail.logPageDigests.at(-1) !== certified.capsule.pageDigest)
      refuse("replay-capsule-link-mismatch");
    const head = await assertMutableReplayAuthority({
      firestore,
      transaction,
      pair,
      baseline,
      lastView: certified.evidence.lastView,
      lastViewProofDigest: certified.evidence.lastViewProofDigest,
    });
    if (
      !same(checkpoint.cursor, {
        baselineDigest: head.baselineDigest,
        sequence: head.sequence,
        lastDigest: head.lastDigest,
      })
    )
      refuse("replay-not-caught-up");
    if (checkpoint.witnessDigest)
      return {
        idempotent: true,
        witnessDigest: checkpoint.witnessDigest,
        witness: await assertReadReplayWitnessInTransaction({
          firestore,
          transaction,
          pair,
          headCursor: checkpoint.cursor,
          witnessDigest: checkpoint.witnessDigest,
        }),
      };
    const witness = parseReplayWitness(
      {
        schemaVersion: 2,
        pairRef: protocol.publicReleasePairReference(pair),
        pairDigest: hash(pair),
        logBaselineDigest: baseline.logBaselineDigest,
        pairBaselineDigest: checkpoint.pairBaselineDigest,
        fromCursor: baseline.cursor,
        headCursor: checkpoint.cursor,
        pageCount: checkpoint.history.pageCount,
        logPagesRootDigest: checkpoint.history.logPagesRootDigest,
        coveredMembersDigest: checkpoint.coveredMembersDigest,
        contentViewDigest: checkpoint.contentViewDigest,
        codeAssetManifestDigest: pair.codeAssetManifestDigest,
        codePackOverlayDigest: checkpoint.codePackOverlayDigest,
        codePackView: baseline.codePackView,
        capsuleDigest: checkpoint.capsuleDigest,
        completedAt,
      },
      pair,
    );
    const witnessDigest = hash(witness),
      create = await immutable(
        transaction,
        firestore,
        `${replayBase(pair)}/replayWitnesses/${witnessDigest}`,
        witness,
      );
    create();
    transaction.set(ref, { ...checkpoint, witnessDigest });
    return { idempotent: false, witnessDigest, witness };
  });
}

module.exports = {
  PAGE_LIMIT,
  PairReplayError,
  parseReplayCursor,
  parseReplayViewReference,
  parseReplayWitness,
  parseReplayPairBaseline,
  parseReplayPage,
  parseReplayCheckpoint,
  readReplayBaselineSelectionState,
  assertStagedReplayViewInTransaction,
  assertSelectionReceipt,
  commitPublicReleasePairReplayBaseline,
  preparePublicReleasePairReplayBaselineCapsule,
  preparePublicReleasePairReplayPageCapsule,
  commitPublicReleasePairReplayPage,
  readReplayWitnessLogPagesInTransaction,
  auditPublicReleasePairReplayWitness,
  openPublicReleasePairReplayWitnessProof,
  assertReadReplayWitnessInTransaction,
  assertReadReplayWitnessProofInTransaction,
  sealPublicReleasePairReplayWitness,
  checkpointPath,
};
