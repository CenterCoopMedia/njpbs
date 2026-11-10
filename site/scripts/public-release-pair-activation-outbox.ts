import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import views from "../../functions/lib/public-release-pair-view.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import admissions from "../../functions/lib/public-release-admission.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import type { ContentActivationReceipt } from "../../functions/lib/public-release-content-activation";
import { readPublicReleasePairClaimJson, type PairViewStore } from "./public-release-pair-view-storage";
import type { activateStagedPublicReleasePairPublication } from "./public-release-pair-content-activation";

type Owner = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity;
  claimDigest: string; manifestDigest: string; signal?: AbortSignal };
type Intent = Readonly<{ schemaVersion: 2; pairDigest: string; taskId: string; identity: PairTaskIdentity;
  claimDigest: string; manifestDigest: string; admissionDigest: string }>;
type Continuation = Readonly<{ schemaVersion: 2; intent: Intent; intentDigest: string; attempts: number;
  nextAttemptAt: number | null; lastFailure: "activation-refused" | "replay-pending" | "replay-predecessor-failed" | "stale-snapshot" | null }>;
export type PairPublicationActivation = Readonly<{ activate: typeof activateStagedPublicReleasePairPublication }>;
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
export function activationOutboxPath(pair: PublicReleasePair, taskId: string) {
  pair = protocol.parsePublicReleasePair(pair);
  if (!digest(taskId)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/activationPending/${taskId}`;
}
function parseContinuation(raw: any, pair: PublicReleasePair, taskId: string): Continuation {
  if (!raw || Object.keys(raw).sort().join(",") !== "attempts,intent,intentDigest,lastFailure,nextAttemptAt,schemaVersion") refuse();
  const intent = raw.intent;
  if (!intent || Object.keys(intent).sort().join(",") !== "admissionDigest,claimDigest,identity,manifestDigest,pairDigest,schemaVersion,taskId") refuse();
  const identity = views.parseViewIdentity(intent.identity, pair);
  if (raw.schemaVersion !== 2 || intent.schemaVersion !== 2 || intent.pairDigest !== protocol.publicReleaseDigest(pair) ||
      intent.taskId !== taskId || protocol.publicReleaseDigest(identity) !== taskId || !["accepted", "recovery"].includes(identity.kind) ||
      ![intent.admissionDigest, intent.claimDigest, intent.manifestDigest].every(digest) || raw.intentDigest !== protocol.publicReleaseDigest(intent) ||
      !Number.isInteger(raw.attempts) || raw.attempts < 0 || raw.attempts > 3 ||
      (raw.attempts === 3 || raw.lastFailure === "replay-predecessor-failed" ? raw.nextAttemptAt !== null :
        !Number.isSafeInteger(raw.nextAttemptAt) || raw.nextAttemptAt < 0) ||
      ![null, "activation-refused", "replay-pending", "replay-predecessor-failed", "stale-snapshot"].includes(raw.lastFailure)) refuse();
  return Object.freeze({ ...raw, intent: Object.freeze({ ...intent, identity }) });
}
function assertReceipt(receipt: ContentActivationReceipt, intent: Intent, pair: PublicReleasePair) {
  const reference = receipt.attempt.originalView;
  if (!same(receipt.attempt.pair, pair) || receipt.admission.operationId !== intent.identity.sourceOperationId ||
      receipt.attempt.admissionDigest !== intent.admissionDigest || !same(reference.identity, intent.identity) ||
      reference.claimDigest !== intent.claimDigest || reference.manifestDigest !== intent.manifestDigest) refuse();
}

/** G's immutable full-byte proof precedes this handoff. Recheck its actual
 * original completion/composite owner and admission in the same transaction
 * that creates the continuation and removes staging. There is no crash gap.
 */
export async function handoffPublicReleasePairActivation(owner: Owner) {
  const { firestore, store, signal } = owner, pair = protocol.parsePublicReleasePair(owner.pair);
  work.assertPublicReleasePairDatabase(firestore, pair);
  const identity = views.parseViewIdentity(owner.identity, pair), taskId = protocol.publicReleaseDigest(identity);
  if (!["accepted", "recovery"].includes(identity.kind)) refuse();
  const base = work.publicReleasePairPath(pair.pairId), outboxRef = firestore.doc(activationOutboxPath(pair, taskId));
  const rawProof = (await firestore.doc(composite.publicReleasePairCompositeProofPath(pair, owner.manifestDigest)).get()).data();
  const proof = composite.parsePublicReleasePairCompositeProof(rawProof, pair, identity, owner.claimDigest, owner.manifestDigest);
  const manifest = composite.parsePublicReleasePairCompositeManifest(await readPublicReleasePairClaimJson({ store, pair,
    identity, claimDigest: owner.claimDigest, descriptor: proof.descriptor, limit: views.BODY_BYTES_LIMIT, signal }), pair, identity);
  signal?.throwIfAborted();
  return firestore.runTransaction(async transaction => {
    const stageRef = firestore.doc(`${base}/staging/${taskId}`), receiptRef = firestore.doc(activation.activationPath(pair, identity.sourceOperationId));
    const failureRef = firestore.doc(`${base}/stagingFailures/${taskId}`);
    const [staging, pending, admissionRow, activated, quarantined] = await transaction.getAll(stageRef, outboxRef,
      firestore.doc(`${admissions.ADMISSIONS}/operations/${identity.sourceOperationId}`), receiptRef, failureRef);
    await composite.assertReadPublicReleasePairCompositeInTransaction({ firestore, transaction, pair, identity,
      claimDigest: owner.claimDigest, viewManifestDigest: owner.manifestDigest, manifest, manifestDigest: proof.descriptor.digest });
    if (quarantined.exists) {
      const failed = quarantined.data()!;
      if (Object.keys(failed).sort().join(",") !== "attempts,claimDigest,failedAt,identity,lastFailure,manifestDigest,nextAttemptAt,schemaVersion,status,taskId" ||
          failed.schemaVersion !== 2 || failed.status !== "quarantined" || failed.attempts !== 3 || failed.nextAttemptAt !== null ||
          !Number.isSafeInteger(failed.failedAt) || failed.failedAt <= 0 ||
          failed.taskId !== taskId || !same(failed.identity, identity) || failed.claimDigest !== owner.claimDigest ||
          failed.manifestDigest !== owner.manifestDigest) refuse();
    }
    if (staging.exists && (!same(staging.data()!.identity, identity) || staging.data()!.taskId !== taskId ||
        staging.data()!.claimDigest !== owner.claimDigest || staging.data()!.manifestDigest !== owner.manifestDigest)) refuse();
    signal?.throwIfAborted();
    if (!admissionRow.exists) {
      // Recovery includes settings, code and other dependency log entries.
      // They contribute replay evidence but do not own publication admissions.
      if (identity.kind !== "recovery" || pending.exists || activated.exists) refuse();
      if (staging.exists) transaction.delete(stageRef);
      if (quarantined.exists) transaction.delete(failureRef);
      return { taskId, activationRequired: false, idempotent: !staging.exists && !quarantined.exists };
    }
    const admission = admissions.parseAdmission(admissionRow.data());
    if (admission.operationId !== identity.sourceOperationId || admission.source.sourceVersion !== identity.sourceVersion ||
        admission.source.snapshotDigest !== identity.snapshotDigest || admission.changeSequence !== identity.contextSequence) refuse();
    const intent: Intent = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), taskId, identity,
      claimDigest: owner.claimDigest, manifestDigest: owner.manifestDigest, admissionDigest: protocol.publicReleaseDigest(admission) };
    const previous = pending.exists ? parseContinuation(pending.data(), pair, taskId) : null;
    if (previous && !same(previous.intent, intent)) refuse();
    if (!staging.exists && !pending.exists && !activated.exists && !quarantined.exists) refuse();
    if (activated.exists) {
      const receipt = activation.parseContentActivationRecord(activated.data(), activated.data()!.attempt);
      assertReceipt(receipt, intent, pair);
      if (pending.exists) transaction.delete(outboxRef);
    } else if (!previous) transaction.create(outboxRef, { schemaVersion: 2, intent,
      intentDigest: protocol.publicReleaseDigest(intent), attempts: 0, nextAttemptAt: 0, lastFailure: null });
    signal?.throwIfAborted();
    if (staging.exists) transaction.delete(stageRef);
    if (quarantined.exists) transaction.delete(failureRef);
    return { taskId, activationRequired: true, idempotent: !staging.exists || previous !== null || activated.exists };
  });
}

/** A callback cannot acknowledge itself. Only the actual immutable guarded
 * activation receipt allows this exact continuation to leave the outbox.
 */
async function acknowledge(firestore: Firestore, pair: PublicReleasePair, continuation: Continuation) {
  const { intent } = continuation, ref = firestore.doc(activationOutboxPath(pair, intent.taskId));
  await firestore.runTransaction(async transaction => {
    const [pending, row] = await transaction.getAll(ref, firestore.doc(activation.activationPath(pair, intent.identity.sourceOperationId)));
    const receipt = activation.parseContentActivationRecord(row.data(), row.data()?.attempt);
    assertReceipt(receipt, intent, pair);
    if (!pending.exists) return;
    if (!same(parseContinuation(pending.data(), pair, intent.taskId).intent, intent)) refuse();
    transaction.delete(ref);
  });
}

/** One bounded due batch on the existing pair recovery wake. It never creates
 * a new acceptance, task, claim, renderer attempt or recovery scheduler.
 */
export async function recoverPublicReleasePairActivations({ firestore, store, pair: rawPair, publication, signal, now = Date.now,
  taskId }: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; publication: PairPublicationActivation;
  signal?: AbortSignal; now?: () => number; taskId?: string }) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPublicReleasePairDatabase(firestore, pair);
  await work.readPublicReleasePairWork({ firestore, pair });
  // A held release writer leaves this durable intent pending. Avoid full
  // replay/R2 preparation while activation is already known to be unavailable;
  // the actual activation transaction still rechecks both operational guards.
  const [billing, fence] = await firestore.getAll(firestore.doc("system/billing"),
    firestore.doc("system/publicDeployment/releaseWriter/fence"));
  if (billing.data()?.disabled === true || fence.exists) return;
  const rows = taskId ? [await firestore.doc(activationOutboxPath(pair, taskId)).get()] :
    (await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/activationPending`).where("nextAttemptAt", "<=", now()).limit(1).get()).docs;
  for (const row of rows) {
    if (!row.exists) continue;
    signal?.throwIfAborted();
    const pending = parseContinuation(row.data(), pair, row.id);
    if (pending.nextAttemptAt === null || pending.nextAttemptAt > now()) continue;
    try {
      await publication.activate({ firestore, store, pair, ...pending.intent, signal });
      await acknowledge(firestore, pair, pending);
    } catch (error) {
      signal?.throwIfAborted();
      await work.readPublicReleasePairWork({ firestore, pair });
      const [billing, fence] = await firestore.getAll(firestore.doc("system/billing"), firestore.doc("system/publicDeployment/releaseWriter/fence"));
      if (billing.data()?.disabled === true || fence.exists) return;
      await firestore.runTransaction(async transaction => {
        const current = await transaction.get(row.ref);
        if (!current.exists || !same(current.data(), pending)) return;
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        const replayPending = code === "content-activation-replay-pending", predecessorFailed = code === "content-activation-predecessor-failed";
        const staleSnapshot = code === "content-activation-stale-snapshot";
        const attempts = pending.attempts + (replayPending || predecessorFailed || staleSnapshot ? 0 : 1);
        let lastFailure: Continuation["lastFailure"] = "activation-refused";
        if (predecessorFailed) lastFailure = "replay-predecessor-failed";
        else if (replayPending) lastFailure = "replay-pending";
        else if (staleSnapshot) lastFailure = "stale-snapshot";
        transaction.set(row.ref, { ...pending, attempts, nextAttemptAt: attempts >= 3 || predecessorFailed ? null : now() + 1_000, lastFailure });
      });
    }
  }
}

/** Explicit private repair. Reopen the same original completed composite;
 * resetting its bounded failures never creates another task or claim.
 */
export async function retryPublicReleasePairActivation({ firestore, store, pair, taskId, publication, signal, now = Date.now }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; taskId: string;
  publication: PairPublicationActivation; signal?: AbortSignal; now?: () => number;
}) {
  const ref = firestore.doc(activationOutboxPath(pair, taskId)), row = await ref.get();
  if (!row.exists) return;
  const pending = parseContinuation(row.data(), pair, taskId);
  await handoffPublicReleasePairActivation({ firestore, store, pair, ...pending.intent, signal });
  await firestore.runTransaction(async transaction => {
    const current = await transaction.get(ref);
    if (!current.exists) return;
    const value = parseContinuation(current.data(), pair, taskId);
    if (!same(value.intent, pending.intent)) refuse();
    if (value.nextAttemptAt === null) transaction.set(ref, { ...value, attempts: 0, nextAttemptAt: 0, lastFailure: null });
  });
  await recoverPublicReleasePairActivations({ firestore, store, pair, taskId, publication, signal, now });
}
