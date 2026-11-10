import { createRequire } from "node:module";

const pairApi = () => createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");

export function planPairedCmsRelease({ selector, selectedPair, candidatePair, recoveryPair, functionsReceipt, cmsApiReceipt }) {
  const api = pairApi();
  api.assertProjection(selector, selectedPair);
  api.parsePair(candidatePair);
  const replacement = selector.recoveryPairId !== candidatePair.pairId;
  if (replacement && (api.parsePair(recoveryPair).pairId !== selector.recoveryPairId || candidatePair.pairId === selectedPair.pairId)) throw new Error("Preview replacement recovery identity differs");
  for (const [component, receipt] of [["functions", functionsReceipt], ["cmsApi", cmsApiReceipt]]) {
    api.assertReaderSupports(api.currentReader(receipt, component), [selectedPair, candidatePair]);
  }
  return { schemaVersion: 2, previewPaused: false, selectedPairId: selectedPair.pairId,
    candidatePairId: candidatePair.pairId, expectedSelectorDigest: api.digest(selector),
    ...(replacement ? { retiringPairId: recoveryPair.pairId } : {}),
    order: ["compatibility-bridge", ...(replacement ? ["close-recovery-reader-issuance", "recovery-expiry-and-drain"] : []),
      "private-preview", "reader-replay", "preview-selection", "admin-manifest"] };
}

export function assertPairedAdminManifest({ selector, selectedPair, rendererReceipt, functionsReceipt, cmsApiReceipt }) {
  const api = pairApi();
  api.assertProjection(selector, selectedPair);
  if (rendererReceipt?.schemaVersion !== 2 || rendererReceipt.state !== "complete"
    || rendererReceipt.pairId !== selectedPair.pairId || rendererReceipt.selectorDigest !== api.digest(selector)
    || rendererReceipt.lastComplete?.sourceSha !== selectedPair.rendererSha) {
    throw new Error("Admin manifest requires the selected preview receipt");
  }
  for (const [component, receipt] of [["functions", functionsReceipt], ["cmsApi", cmsApiReceipt]]) {
    api.assertReaderSupports(api.currentReader(receipt, component), [selectedPair]);
  }
  return { previewSelectorDigest: api.digest(selector),
    // Fresh readbacks may refresh verifiedAt without changing deployed code or
    // contracts. An upload's immutable intent binds those stable identities.
    readerDigests: Object.fromEntries([["functions", functionsReceipt], ["cmsApi", cmsApiReceipt]]
      .map(([component, receipt]) => [component, api.digest({ ...receipt.lastComplete, verifiedAt: null })])) };
}

async function reconcileAdminAttempt(firestore, ref, lock, liveRef, request, adapter, api, signal) {
  const digest = value => api.digest(value ?? null);
  const before = (await ref.get()).data();
  if (digest(before?.request) !== digest(request) || !/^[a-f0-9]{64}$/.test(before?.operationDigest ?? "")) throw new Error("Admin operation identity is unavailable");
  if (before.state === "complete") return before;
  let operation;
  try {
    // This may close/tombstone a provider operation journal, never upload. The
    // close must reject a late publish even if the old permission holder wakes.
    operation = await adapter.reconcileOperation({ operationId: request.operationId,
      operationDigest: before.operationDigest, manifestDigest: request.manifestDigest, signal });
  }
  catch {
    const completed = (await ref.get()).data();
    if (completed?.state === "complete" && digest(completed.request) === digest(request)) return completed;
    throw new Error("Admin operation journal unavailable; reconcile without another upload");
  }
  if (operation?.operationId !== request.operationId || operation?.operationDigest !== before.operationDigest
    || operation?.providerSettled !== true || !["not_written", "uploaded", "failed"].includes(operation?.outcome)) {
    throw new Error("Admin provider operation remains uncertain; reconcile without another upload");
  }
  signal?.throwIfAborted();
  const proof = { operationId: operation.operationId, operationDigest: operation.operationDigest,
    providerSettled: true, outcome: operation.outcome };
  if (["uploaded", "failed"].includes(operation.outcome)) {
    if (operation.manifestDigest !== request.manifestDigest || !/^[a-f0-9]{64}$/.test(operation.providerReceiptDigest ?? "")) {
      throw new Error("Admin operation journal identity disagrees");
    }
    proof.manifestDigest = operation.manifestDigest;
    proof.providerReceiptDigest = operation.providerReceiptDigest;
  }
  let actual = null;
  if (operation.outcome === "uploaded") {
    try { actual = await adapter.readActiveManifest(); } catch { /* Settlement cannot certify an unreadable active manifest. */ }
  }
  let observed = null;
  if (operation.outcome === "uploaded") {
    try { observed = await adapter.readLiveReaderIdentities(); } catch { /* Settlement can release a lock without certifying Admin readiness. */ }
  }
  const result = await firestore.runTransaction(async tx => {
    const [row, writer, live] = await tx.getAll(ref, lock, liveRef);
    const stored = row.data();
    if (digest(stored?.request) !== digest(request) || stored.operationDigest !== before.operationDigest) throw new Error("Admin operation changed");
    if (["complete", "settled", "not_written"].includes(stored.state)) return stored;
    if (!["reserved", "uncertain"].includes(stored.state) || writer.data()?.state !== "reserved"
      || writer.data()?.operationId !== request.operationId) throw new Error("Admin writer changed");
    if (operation.outcome === "not_written") {
      const closed = { ...stored, state: "not_written", failure: "provider_fenced_before_upload", operationProofDigest: digest(proof) };
      tx.set(ref, closed);
      tx.set(lock, { schemaVersion: 2, state: "not_written", operationId: request.operationId, requestDigest: digest(request) });
      return closed;
    }
    if (operation.outcome === "failed") {
      const settled = { ...stored, state: "settled", providerReceiptDigest: operation.providerReceiptDigest,
        operationProofDigest: digest(proof), mutated: true, settlementReason: "provider_deployment_failed" };
      tx.set(ref, settled);
      tx.set(lock, { schemaVersion: 2, state: "settled", operationId: request.operationId, requestDigest: digest(request) });
      return settled;
    }
    let checked = null;
    try { checked = await adminEvidence(firestore, tx, api); } catch { /* Changed contracts cannot certify the old manifest. */ }
    const settlementReason = !actual ? "active_manifest_readback_unavailable"
      : actual.operationId !== request.operationId || actual.operationDigest !== before.operationDigest
        || actual.manifestDigest !== request.manifestDigest || actual.providerReceiptDigest !== operation.providerReceiptDigest ? "active_manifest_changed"
      : !observed ? "reader_readback_unavailable"
      : !checked ? "cms_receipt_unavailable"
      : digest(checked.evidence) !== digest(stored.evidence) ? "cms_evidence_changed"
      : digest(checked.identities) !== digest(observed) ? "reader_identity_changed"
      : digest(live.data()) !== stored.previousAdminDigest ? "admin_baseline_changed" : null;
    const complete = { ...stored, state: settlementReason ? "settled" : "complete",
      providerReceiptDigest: operation.providerReceiptDigest, operationProofDigest: digest(proof), mutated: true };
    if (settlementReason) complete.settlementReason = settlementReason;
    tx.set(ref, complete);
    // Exact provider settlement proves this attempt cannot write later. When
    // receipts changed, release only the lock and leave last-complete Admin.
    if (!settlementReason) tx.set(liveRef, { schemaVersion: 2, state: "complete", lastComplete: complete });
    tx.set(lock, { schemaVersion: 2, state: complete.state, operationId: request.operationId, requestDigest: digest(request) });
    return complete;
  });
  if (result.state === "not_written") throw new Error("Admin operation was durably fenced before upload; start a new operation");
  if (result.state === "settled") throw new Error(`Admin operation settled (${result.settlementReason}); start a new operation with current receipts`);
  return result;
}

async function adminEvidence(firestore, tx, api) {
  const selector = api.parseSelector((await tx.get(firestore.doc(api.SELECTOR_PATH))).data());
  const rows = await tx.getAll(firestore.collection(api.PAIRS).doc(selector.selectedPairId),
    firestore.doc(api.RENDERER_RECEIPT_PATH), firestore.collection(api.READER_RECEIPTS).doc("functions"),
    firestore.collection(api.READER_RECEIPTS).doc("cmsApi"));
  const functionsReceipt = rows[2].data(), cmsApiReceipt = rows[3].data();
  return {
    evidence: assertPairedAdminManifest({ selector, selectedPair: rows[0].data(), rendererReceipt: rows[1].data(), functionsReceipt, cmsApiReceipt }),
    identities: { functions: api.currentReader(functionsReceipt, "functions").providerIdentities,
      cmsApi: api.currentReader(cmsApiReceipt, "cmsApi").providerIdentities },
  };
}

// No default adapter or credentials. The adapter publishes already-sealed bytes,
// binds operationId durably, and reports providerSettled only after that exact
// operation can no longer produce a later write. Reconciliation may fence the
// operation journal but never gains a second upload permission.
export async function publishPairedAdminManifest(firestore, {
  operationId, manifestDigest, expectedProviderReceiptDigest,
}, adapter, signal) {
  const api = pairApi();
  const digest = value => api.digest(value ?? null);
  if (!/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(operationId) || !/^[a-f0-9]{64}$/.test(manifestDigest)
    || (expectedProviderReceiptDigest !== null && !/^[a-f0-9]{64}$/.test(expectedProviderReceiptDigest ?? ""))) {
    throw new Error("Invalid paired Admin manifest identity");
  }
  signal?.throwIfAborted();
  const request = { operationId, manifestDigest, expectedProviderReceiptDigest };
  const ref = firestore.collection("cmsAdminManifestAttempts").doc(operationId);
  const lock = firestore.doc("cmsAdminManifestState/writer");
  const liveRef = firestore.doc("cmsDeploymentReceipts/adminManifest");
  const initial = await firestore.runTransaction(async tx => {
    const [row, live] = await tx.getAll(ref, liveRef);
    const stored = row.data();
    if (stored && digest(stored.request) !== digest(request)) throw new Error("Admin operation identity conflicts");
    if (stored?.state === "complete") return { complete: stored };
    if (stored?.state === "not_written") throw new Error("Admin attempt made no upload; correct the precondition and use a new operation");
    if (stored?.state === "settled") throw new Error("Admin operation is settled; start a new operation with current receipts");
    if (stored) return { reconcile: true };
    const checked = await adminEvidence(firestore, tx, api);
    return { stored, ...checked, baselineDigest: digest(live.data()) };
  });
  if (initial.complete) return initial.complete;
  if (typeof adapter?.reconcileOperation !== "function") throw new Error("Admin transport requires durable operation fencing and reconciliation");
  if (initial.reconcile) return reconcileAdminAttempt(firestore, ref, lock, liveRef, request, adapter, api, signal);
  // Fresh provider reads precede mutation permission. Read failures consume no
  // attempt and cannot leave the writer reserved.
  let observed;
  try {
    observed = await adapter.readLiveReaderIdentities();
  } catch {
    throw new Error("Admin reader provider readback is unavailable");
  }
  if (digest(observed) !== digest(initial.identities)) throw new Error("Admin reader provider identities changed");
  signal?.throwIfAborted();
  const permission = await firestore.runTransaction(async tx => {
    const [row, writer, live] = await tx.getAll(ref, lock, liveRef);
    const stored = row.data(), currentWriter = writer.data();
    if (stored?.state === "complete" && digest(stored.request) === digest(request)) return { complete: stored };
    const checked = await adminEvidence(firestore, tx, api);
    if (digest(checked.evidence) !== digest(initial.evidence) || digest(checked.identities) !== digest(observed)
      || digest(live.data()) !== initial.baselineDigest) throw new Error("CMS receipts changed before Admin permission");
    if (currentWriter?.state === "reserved" && currentWriter.operationId !== operationId) throw new Error("Another Admin operation is unresolved");
    if (stored) {
      if (digest(stored.request) !== digest(request) || digest(stored.evidence) !== digest(initial.evidence)
        || currentWriter?.state !== "reserved" || currentWriter.operationId !== operationId) throw new Error("Admin operation conflicts");
      return { attempt: stored, mutate: false };
    }
    signal?.throwIfAborted();
    const operationDigest = digest({ request, evidence: initial.evidence, previousAdminDigest: initial.baselineDigest });
    const attempt = { schemaVersion: 2, request, evidence: initial.evidence, previousAdminDigest: initial.baselineDigest, operationDigest, state: "reserved" };
    tx.create(ref, attempt);
    tx.set(lock, { schemaVersion: 2, state: "reserved", operationId, requestDigest: digest(request) });
    return { attempt, mutate: true };
  });
  if (permission.complete) return permission.complete;
  let providerInvoked = false;
  let stage = "active_manifest_readback";
  try {
    signal?.throwIfAborted();
    let actual = await adapter.readActiveManifest();
    if (actual?.manifestDigest !== manifestDigest) {
      stage = "active_manifest_identity";
      if (!permission.mutate) throw new Error("Provider operation remains uncertain");
      if ((actual?.providerReceiptDigest ?? null) !== expectedProviderReceiptDigest) throw new Error("Active Admin deployment changed");
      stage = "reader_recheck";
      const current = await firestore.runTransaction(tx => adminEvidence(firestore, tx, api));
      const readers = await adapter.readLiveReaderIdentities();
      if (digest(current.evidence) !== digest(initial.evidence) || digest(readers) !== digest(initial.identities)) throw new Error("Admin reader changed before upload");
      signal?.throwIfAborted();
      stage = "upload";
      providerInvoked = true;
      await adapter.publish({ ...request, ...initial.evidence, operationDigest: permission.attempt.operationDigest, signal });
      stage = "upload_readback";
      actual = await adapter.readActiveManifest();
    }
    // A read-only retry cannot certify another writer's same-content upload:
    // its own prior mutation must be durably settled before releasing the lock.
    stage = "provider_operation_binding";
    if (actual?.manifestDigest !== manifestDigest || !/^[a-f0-9]{64}$/.test(actual?.providerReceiptDigest ?? "")
      || ((!permission.mutate || providerInvoked) && (actual.operationId !== operationId
        || actual.operationDigest !== permission.attempt.operationDigest || actual.providerSettled !== true))) {
      throw new Error("Admin provider readback disagrees");
    }
    signal?.throwIfAborted();
    stage = "reader_final_readback";
    const freshReaders = await adapter.readLiveReaderIdentities();
    stage = "receipt_commit";
    return await firestore.runTransaction(async tx => {
      const [row, writer, live] = await tx.getAll(ref, lock, liveRef);
      const stored = row.data();
      if (stored?.state === "complete" && digest(stored.request) === digest(request)) return stored;
      const current = await adminEvidence(firestore, tx, api);
      if (digest(stored?.request) !== digest(request) || writer.data()?.operationId !== operationId
        || writer.data()?.state !== "reserved" || digest(current.evidence) !== digest(initial.evidence)
        || digest(live.data()) !== stored.previousAdminDigest
        || digest(freshReaders) !== digest(current.identities)) throw new Error("CMS state changed during Admin upload");
      const complete = { ...stored, state: "complete", providerReceiptDigest: actual.providerReceiptDigest,
        mutated: providerInvoked || !permission.mutate };
      tx.set(ref, complete);
      tx.set(liveRef, { schemaVersion: 2, state: "complete", lastComplete: complete });
      tx.set(lock, { schemaVersion: 2, state: "complete", operationId, requestDigest: digest(request) });
      return complete;
    });
  } catch {
    // The original holder can release its own unused permission here. Other
    // callers require the durable journal reconciliation above.
    const complete = await firestore.runTransaction(async tx => {
      const [row, writer] = await tx.getAll(ref, lock);
      const stored = row.data();
      if (digest(stored?.request) !== digest(request)) throw new Error("Admin operation changed");
      if (stored.state === "complete") return stored;
      if (stored.state === "not_written") throw new Error("Admin attempt made no upload; correct the precondition and use a new operation");
      if (stored.state === "settled") throw new Error("Admin operation is settled; start a new operation with current receipts");
      if (permission.mutate && !providerInvoked) {
        if (writer.data()?.operationId !== operationId || writer.data()?.state !== "reserved") throw new Error("Admin writer changed");
        tx.set(ref, { ...stored, state: "not_written", failure: "before_upload" });
        tx.set(lock, { schemaVersion: 2, state: "not_written", operationId, requestDigest: digest(request) });
        return null;
      }
      tx.set(ref, { ...stored, state: "uncertain", failure: signal?.aborted ? "cancelled" : "upload_or_readback" });
      return null;
    });
    if (complete) return complete;
    if (permission.mutate && !providerInvoked) throw new Error(`Paired Admin manifest was not uploaded (${stage}); correct the precondition and use a new operation`);
    throw new Error(`Paired Admin manifest was not confirmed (${stage}); reconcile this operation read-only before another upload`);
  }
}
