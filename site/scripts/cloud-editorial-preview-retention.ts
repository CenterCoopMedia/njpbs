import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { App } from "firebase-admin/app";
import type { S3Client } from "@aws-sdk/client-s3";
import { canonicalPublicationReceipt } from "../src/lib/public-publication-receipt";
import { PUBLICATION_PROBE_ORIGIN, PUBLICATION_PROBE_PATH, requestPublicPublicationReceipt } from "./activate-public-worker-candidate";
import { editorialPreviewContextId, readEditorialPreviewSelection } from "./cms-preview-editorial-context";
import { retainCloudEditorialPreviewContext } from "./cms-preview-cloud-storage";
import { createNoBuildPreparationStorage } from "./no-build-preparation-storage";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";
import type { PreviewStorageCredential } from "./cms-preview-storage-credential";

const require = createRequire(import.meta.url);
const { cloudCmsPublicationRuntimeControl } = require("../../functions/lib/cms-publication-runtime-control");
const { retryDue, retryExhausted, previewContextDue } = require("../../functions/lib/no-build-cloud-work");
const CURRENT = "system/publicDeployment/aggregateContexts/current";
const CONTROL = "system/cmsPublicationRuntime";
const ready = (value: unknown, release: string, serializerId: string) => {
  const control = cloudCmsPublicationRuntimeControl(value);
  return control?.phase === "ready" && control.commitSha === release && control.serializerId === serializerId;
};

/** Private retention is separate from public aggregate completion. */
export function cloudEditorialPreviewRetention({ firestore, firebaseApp, runtime, serializerId, backgroundBucket,
  stateDirectory, previewStorageCredential, client, requestPublication = requestPublicPublicationReceipt, clock = Date.now }: {
  firestore: Firestore; firebaseApp: App; runtime: { owner: "cloudflare"; release: string }; serializerId: string;
  backgroundBucket: string; stateDirectory: string; previewStorageCredential: PreviewStorageCredential;
  client?: S3Client; requestPublication?: typeof requestPublicPublicationReceipt; clock?: () => number;
}) {
  return async () => {
    if (process.env.FIRESTORE_EMULATOR_HOST && (requestPublication === requestPublicPublicationReceipt || !client)) {
      throw new Error("Demo preview retention requires local receipt and private Storage boundaries");
    }
    if (!ready((await firestore.doc(CONTROL).get()).data(), runtime.release, serializerId)) return false;
    const selected = (await firestore.doc(CURRENT).get()).data();
    if (!selected || selected.runtime?.owner !== runtime.owner || selected.runtime.release !== runtime.release ||
        !/^[A-Za-z0-9]{20}$/.test(selected.operationId ?? "")) return false;
    const queueBefore = (await firestore.doc(`cmsPublishQueue/${selected.operationId}`).get()).data();
    const pointerBefore = (await firestore.doc("system/publicDeployment").get()).data();
    const preparationBefore = /^[A-Za-z0-9]{20}$/.test(selected.preparationOperationId ?? "")
      ? (await firestore.doc(`cmsPublishQueue/${selected.preparationOperationId}/backgroundPreparation/${selected.contextDigest}`).get()).data() : null;
    if (pointerBefore?.state !== "idle" || pointerBefore.activeCommitSha !== runtime.release ||
        queueBefore?.transport !== "public-context-no-build-v1" || queueBefore.runtime?.owner !== runtime.owner ||
        queueBefore.runtime.release !== runtime.release || queueBefore.publicContext?.contextDigest !== selected.contextDigest ||
        !previewContextDue(queueBefore, pointerBefore, clock(), false, preparationBefore)) return false;
    if (queueBefore.previewContext?.status === "building" &&
        queueBefore.previewContext.publicationGeneration === pointerBefore.activeGeneration &&
        retryExhausted(queueBefore.previewContext, clock())) {
      return firestore.runTransaction(async transaction => {
        const [queue, pointer, currentRow, control] = await transaction.getAll(
          firestore.doc(`cmsPublishQueue/${selected.operationId}`), firestore.doc("system/publicDeployment"),
          firestore.doc(CURRENT), firestore.doc(CONTROL));
        const value = queue.data()?.previewContext;
        if (!ready(control.data(), runtime.release, serializerId) || !["pending", "failed", "success"].includes(queue.data()?.status) ||
            pointer.data()?.state !== "idle" || pointer.data()?.activeCommitSha !== runtime.release ||
            pointer.data()?.activeGeneration !== pointerBefore.activeGeneration ||
            currentRow.data()?.operationId !== selected.operationId || currentRow.data()?.contextDigest !== selected.contextDigest ||
            value?.claim !== queueBefore.previewContext.claim || value?.status !== "building" ||
            !retryExhausted(value, clock())) return false;
        transaction.update(firestore.doc(`cmsPublishQueue/${selected.operationId}`), { previewContext: { ...value,
          status: "failed", claim: null, nextAttemptAt: null, error: "preview_context_retention_failed", diagnostic: "lease" } });
        return true;
      });
    }
    const claim = randomUUID().replaceAll("-", "").slice(0, 20);
    const queueRef = firestore.doc(`cmsPublishQueue/${selected.operationId}`);
    let directory: string | null = null;
    let stage: "source" | "receipt" | "selector" | "restore" | "retain" = "source";
    try {
      await assertCmsPublicationSourceCheckout(runtime.release);
      stage = "receipt";
      const url = new URL(`${PUBLICATION_PROBE_PATH}?cms-context=code`, PUBLICATION_PROBE_ORIGIN).toString();
      const publication = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
      stage = "selector";
      const selection = await firestore.runTransaction(async transaction => {
        const current = await readEditorialPreviewSelection(transaction, firestore, publication, selected.operationId);
        if (!current) return null;
        const [queue, control, preparation, pointer] = await transaction.getAll(queueRef, firestore.doc(CONTROL),
          firestore.doc(`cmsPublishQueue/${current.checkpointIdentity.operationId}/backgroundPreparation/${current.contextDigest}`),
          firestore.doc("system/publicDeployment"));
        if (!ready(control.data(), runtime.release, serializerId)) return null;
        if (!previewContextDue(queue.data(), pointer.data(), clock(), false, preparation.data())) return null;
        if (preparation.data()?.backgroundBucket !== backgroundBucket) throw new Error("Editorial preparation bucket changed");
        const manifestId = editorialPreviewContextId(publication, current.contextDigest, current.operationId);
        const before = queue.data()?.previewContext;
        const same = before?.publicationGeneration === publication.generation && before.contextDigest === current.contextDigest;
        if (same && before.status === "verified" && before.manifestId === manifestId) return null;
        if (same && before.status !== "verified" && !retryDue(before, clock())) return null;
        transaction.update(queueRef, { previewContext: { status: "building", manifestId, contextDigest: current.contextDigest,
          publicationArtifactReceiptDigest: publication.artifactReceiptDigest, publicationGeneration: publication.generation,
          claim, attempts: same && before.status !== "verified" ? before.attempts + 1 : 1,
          startedAt: same && before.status !== "verified" ? before.startedAt : clock(),
          nextAttemptAt: clock() + 10 * 60_000, error: null, diagnostic: null } });
        return current;
      });
      if (!selection) return false;
      stage = "restore";
      directory = path.join(stateDirectory, "preview-context", selected.operationId, claim);
      const storage = createNoBuildPreparationStorage(backgroundBucket, firebaseApp, selection.checkpointIdentity,
        { signal: AbortSignal.timeout(4 * 60_000) });
      if (await storage.restore(selection.checkpointStage ?? "prepared", directory, selection.preparedDigest) !== selection.preparedDigest) {
        throw new Error("Editorial preparation checkpoint is unavailable");
      }
      stage = "retain";
      await retainCloudEditorialPreviewContext({ firestore, file: path.join(directory, "public-context.json"),
        operationId: selection.operationId, publication, claim, serializerId, clock, client, ...previewStorageCredential });
      return true;
    } catch {
      console.error(`Editorial preview retention failed at ${stage}`);
      await firestore.runTransaction(async transaction => {
        const [queue, pointer, currentRow, control] = await transaction.getAll(queueRef,
          firestore.doc("system/publicDeployment"), firestore.doc(CURRENT), firestore.doc(CONTROL));
        const current = queue.data()?.previewContext;
        const ownClaim = current?.status === "building" && current.claim === claim;
        let failed = current;
        if (!ownClaim) {
          // Receipt/selector failures precede the qualified claim. Record only
          // bounded failure metadata for the unchanged server-owned selection.
          const live = currentRow.data();
          if (!ready(control.data(), runtime.release, serializerId) || pointer.data()?.state !== "idle" ||
              pointer.data()?.activeCommitSha !== runtime.release || pointer.data()?.activeGeneration !== pointerBefore.activeGeneration ||
              !live || live.operationId !== selected.operationId || live.contextDigest !== selected.contextDigest ||
              live.runtime?.owner !== runtime.owner || live.runtime.release !== runtime.release ||
              queue.data()?.runtime?.owner !== runtime.owner || queue.data()?.runtime?.release !== runtime.release ||
              !previewContextDue(queue.data(), pointer.data(), clock(), false, preparationBefore)) return;
          const same = current?.publicationGeneration === pointerBefore.activeGeneration && current.contextDigest === selected.contextDigest;
          if (same && !retryDue(current, clock())) return;
          const attempts = same ? current.attempts + 1 : 1;
          failed = { status: "failed", manifestId: same ? current.manifestId ?? null : null,
            publicationArtifactReceiptDigest: same ? current.publicationArtifactReceiptDigest ?? null : null,
            publicationGeneration: pointerBefore.activeGeneration, contextDigest: selected.contextDigest,
            attempts, startedAt: same ? current.startedAt : clock() };
        }
        transaction.update(queueRef, { previewContext: { ...failed, status: "failed", claim: null,
          error: "preview_context_retention_failed", diagnostic: stage,
          nextAttemptAt: failed.attempts >= 4 ? null : clock() + 60_000 * 2 ** (failed.attempts - 1) } });
      });
      return true;
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  };
}
