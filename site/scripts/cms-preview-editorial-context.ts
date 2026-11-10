import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PreparationIdentity } from "./no-build-preparation-storage";
import { canonicalPublicationReceipt, type PublicPublicationReceipt } from "../src/lib/public-publication-receipt";
import { normalizePublicArtifactBundle } from "../src/lib/public-artifact-bundle";

export const EDITORIAL_CONTEXTS_COLLECTION = "cmsPreviewEditorialContexts";
export const EDITORIAL_SEALS_COLLECTION = "cmsPreviewEditorialSeals";
export const LAST_SEALED_EDITORIAL_CONTEXT = "system/publicDeployment/aggregateContexts/previewSealed";
const CURRENT = "system/publicDeployment/aggregateContexts/current";
const CONTEXT = "system/publicDeployment/contexts/public";
const recordNamespace = createRequire(import.meta.url)("../../functions/lib/no-build-record-namespace.js");
const { verifiedPreviewProjection } = createRequire(import.meta.url)("../../functions/lib/editorial-preview-projection.js");
const DIGEST = /^[a-f0-9]{64}$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("Editorial preview context is unavailable");
}

export class EditorialPreviewContextNotReadyError extends Error {
  readonly code = "preview_context_refreshing";
  constructor(message = "Editorial preview context is unavailable while refreshing") {
    super(message);
    this.name = "EditorialPreviewContextNotReadyError";
  }
}

export interface EditorialPreviewSelection {
  operationId: string;
  contextRevision: number;
  contextDigest: string;
  preparedDigest: string;
  checkpointStage?: "preview";
  checkpointIdentity: PreparationIdentity;
  source: { buildBatchId: string; generation: number; commitSha: string };
  publication: PublicPublicationReceipt;
}
type ContextReceipt = EditorialPreviewSelection["source"] & {
  mediaManifestDigest: string;
  artifactReceiptDigest: string;
}
export interface EditorialPreviewManifest {
  schemaVersion: 1 | 2;
  withdrawalRevision?: number;
  selection: EditorialPreviewSelection;
  contextReceipt: ContextReceipt;
  sha256: string;
  byteLength: number;
  key: string;
}

/** Preserve the strict deployed schema-one reader while sealing separately. */
export function legacyEditorialContextManifest(seal: EditorialPreviewManifest): EditorialPreviewManifest {
  const { withdrawalRevision: _withdrawalRevision, ...compatible } = seal;
  return { ...compatible, schemaVersion: 1 };
}

export function editorialPreviewContextId(publication: PublicPublicationReceipt, contextDigest: string, operationId: string): string {
  requireValue(DIGEST.test(contextDigest) && /^[A-Za-z0-9]{20}$/.test(operationId));
  return hash(JSON.stringify([canonicalPublicationReceipt(publication), contextDigest, operationId]));
}

/** Preview reads the prepared content bundle, not generated public outputs.
 * Its original verified checkpoint remains distinct from the active code. */
export async function readEditorialPreviewSelection(transaction: Transaction, firestore: Firestore,
  publication: PublicPublicationReceipt, operationId?: string): Promise<EditorialPreviewSelection | null> {
  const [currentRow, contextRow, deploymentRow] = await transaction.getAll(
    firestore.doc(CURRENT), firestore.doc(CONTEXT), firestore.doc("system/publicDeployment"));
  if (!currentRow.exists) { requireValue(operationId === undefined); return null; }
  const current = currentRow.data()!;
  const context = contextRow.data();
  const deployment = deploymentRow.data();
  const receipt = canonicalPublicationReceipt(publication);
  const runtime = { owner: "cloudflare", release: receipt.commitSha };
  if (current.contextRevision !== context?.revision || !isDeepStrictEqual(current.runtime, runtime) ||
      deployment?.state !== "idle" || deployment.activeCommitSha !== receipt.commitSha ||
      deployment.activeGeneration !== receipt.generation) throw new EditorialPreviewContextNotReadyError();
  requireValue(/^[A-Za-z0-9]{20}$/.test(current.operationId ?? "") &&
    (operationId === undefined || operationId === current.operationId) &&
    context?.schemaVersion === 1 && Number.isSafeInteger(context.revision) && context.revision > 0 &&
    current.contextRevision === context.revision &&
    current.contextDigest === hash(`njpbs-public-context-v1:${context.revision}`) &&
    isDeepStrictEqual(current.runtime, runtime) && deployment?.state === "idle" &&
    deployment.activeCommitSha === receipt.commitSha && deployment.activeGeneration === receipt.generation);
  return readEditorialPreviewPreparation(transaction, firestore, receipt, current);
}

async function readEditorialPreviewPreparation(transaction: Transaction, firestore: Firestore,
  receipt: PublicPublicationReceipt, selected: Record<string, any>, sealedSource = false): Promise<EditorialPreviewSelection> {
  const runtime = { owner: "cloudflare", release: receipt.commitSha };
  const eligible = (job: Record<string, any> | undefined) => job &&
    (["pending", "failed", "success"].includes(job.status) || sealedSource &&
      job.status === "cancelled" && job.error === "public_context_superseded");
  const job = (await transaction.get(firestore.doc(`cmsPublishQueue/${selected.operationId}`))).data();
  requireValue(job?.transport === "public-context-no-build-v1" && eligible(job) &&
    isDeepStrictEqual(job.runtime, runtime) && job.publicContext?.contextDigest === selected.contextDigest &&
    job.publicContext?.operationId === selected.operationId && job.publicContext?.contextRevision === selected.contextRevision && isDeepStrictEqual(job.publicContext.runtime, runtime));
  // The producer explicitly retains the preparation owner. Family task owners
  // can include Posts at the same context and do not identify this checkpoint.
  if (selected.preparationOperationId == null) {
    throw Object.assign(new Error("Editorial preview context is unavailable"), { code: "editorial_preparation_reference_missing" });
  }
  const preparationOperationId = selected.preparationOperationId;
  requireValue(/^[A-Za-z0-9]{20}$/.test(preparationOperationId));
  const originalJob = preparationOperationId === selected.operationId ? job :
    (await transaction.get(firestore.doc(`cmsPublishQueue/${preparationOperationId}`))).data();
  const preparation = (await transaction.get(firestore.doc(
    `cmsPublishQueue/${preparationOperationId}/backgroundPreparation/${selected.contextDigest}`))).data();
  requireValue(originalJob?.transport === "public-context-no-build-v1" && eligible(originalJob) &&
    isDeepStrictEqual(originalJob.runtime, runtime) && originalJob.publicContext?.operationId === preparationOperationId &&
    originalJob.publicContext.contextDigest === selected.contextDigest &&
    originalJob.publicContext.contextRevision === selected.contextRevision &&
    isDeepStrictEqual(originalJob.publicContext.runtime, runtime));
  const projected = preparation?.previewProjection !== undefined;
  const projectionVerified = verifiedPreviewProjection(preparation, runtime, selected.contextDigest);
  if (!projectionVerified && (!preparation && job.status === "pending" || preparation &&
      (["pending", "building"].includes(preparation.status) || preparation.status === "failed" &&
        Number.isSafeInteger(preparation.attempts) && preparation.attempts >= 0 && preparation.attempts < 4 &&
        Number.isFinite(preparation.nextAttemptAt)))) throw new EditorialPreviewContextNotReadyError();
  requireValue(preparation && (projected ? projectionVerified : preparation.status === "verified" && DIGEST.test(preparation.preparedDigest ?? "")) &&
    isDeepStrictEqual(preparation.runtime, runtime) && preparation.contextDigest === selected.contextDigest &&
    preparation.reservation?.commitSha === receipt.commitSha &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(preparation.reservation.buildBatchId ?? "") &&
    Number.isSafeInteger(preparation.reservation.generation) && preparation.reservation.generation > 0);
  const { buildBatchId, generation, commitSha } = preparation.reservation;
  const cutoffMillis = preparation.reservation.cutoffAt?.toMillis();
  const admissionRevision = preparation.admissionRevision;
  requireValue(Number.isSafeInteger(cutoffMillis) && cutoffMillis > 0 &&
    (admissionRevision === null || Number.isSafeInteger(admissionRevision) && admissionRevision > 0));
  return { operationId: selected.operationId, contextRevision: selected.contextRevision, contextDigest: selected.contextDigest,
    preparedDigest: projected ? preparation.previewProjection.digest : preparation.preparedDigest,
    ...(projected ? { checkpointStage: "preview" as const } : {}),
    checkpointIdentity: { operationId: preparationOperationId, contextDigest: selected.contextDigest, commitSha,
      owner: "cloudflare", cutoffMillis, admissionRevision,
      ...(projected ? { inputDigest: preparation.previewProjection.inputDigest } : {}) },
    source: { buildBatchId, generation, commitSha }, publication: receipt };
}

/** Only the producer-selected immutable manifest may cover a newer context.
 * Old manifests carry no withdrawal seal and can never enter this path. */
export async function readSealedEditorialPreviewSelection(transaction: Transaction, firestore: Firestore,
  publication: PublicPublicationReceipt, selectedManifestId?: string): Promise<EditorialPreviewManifest | null> {
  const receipt = canonicalPublicationReceipt(publication);
  const [pointerRow, contextRow, deploymentRow] = await transaction.getAll(
    firestore.doc(LAST_SEALED_EDITORIAL_CONTEXT), firestore.doc(CONTEXT), firestore.doc("system/publicDeployment"));
  const pointer = pointerRow.data(), context = contextRow.data(), deployment = deploymentRow.data();
  if (pointer?.schemaVersion !== 1 || !DIGEST.test(pointer.manifestId ?? "") ||
      !isDeepStrictEqual(pointer.publication, receipt) || context?.schemaVersion !== 1 ||
      !Number.isSafeInteger(context.revision) || context.revision < 1 ||
      deployment?.state !== "idle" || deployment.activeCommitSha !== receipt.commitSha ||
      deployment.activeGeneration !== receipt.generation) return null;
  const manifestId = selectedManifestId ?? pointer.manifestId;
  requireValue(DIGEST.test(manifestId));
  const [sealRow, legacyRow] = await transaction.getAll(
    firestore.doc(`${EDITORIAL_SEALS_COLLECTION}/${manifestId}`), firestore.doc(`${EDITORIAL_CONTEXTS_COLLECTION}/${manifestId}`));
  const manifest = sealRow.data() as EditorialPreviewManifest | undefined;
  if (manifest?.schemaVersion !== 2 || !Number.isSafeInteger(manifest.withdrawalRevision) || manifest.withdrawalRevision! < 0 ||
      manifest.withdrawalRevision !== (context.withdrawalRevision ?? 0) ||
      !isDeepStrictEqual(manifest.selection?.publication, receipt) ||
      !Number.isSafeInteger(manifest.selection?.contextRevision) || manifest.selection.contextRevision < 1 ||
      manifest.selection.contextRevision > context.revision || !legacyRow.exists) return null;
  assertEditorialContextManifest(manifest, manifest.selection);
  requireValue(isDeepStrictEqual(legacyRow.data(), legacyEditorialContextManifest(manifest)));
  requireValue(manifestId === editorialPreviewContextId(receipt, manifest.selection.contextDigest, manifest.selection.operationId) &&
    manifest.selection.contextDigest === hash(`njpbs-public-context-v1:${manifest.selection.contextRevision}`));
  const operations = await transaction.getAll(firestore.doc(`cmsPublishQueue/${manifest.selection.operationId}`),
    firestore.doc(`cmsPublishQueue/${manifest.selection.checkpointIdentity.operationId}`));
  // Ordinary context admission cancels an unfinished public aggregate without
  // revoking its verified sealed input. Other cancellation remains unavailable.
  if (operations.some(row => ["cancelled", "superseded"].includes(row.data()?.status) &&
      !(row.data()?.status === "cancelled" && row.data()?.error === "public_context_superseded"))) return null;
  const selected = await readEditorialPreviewPreparation(transaction, firestore, receipt, {
    ...manifest.selection, runtime: { owner: "cloudflare", release: receipt.commitSha },
    preparationOperationId: manifest.selection.checkpointIdentity.operationId }, true);
  requireValue(isDeepStrictEqual(selected, manifest.selection));
  return manifest;
}

export function assertEditorialPreparedContext(bytes: Buffer, checkpointBytes: Buffer, selection: EditorialPreviewSelection) {
  requireValue(checkpointBytes.length <= recordNamespace.CHECKPOINT_MANIFEST_BYTES_MAX && hash(checkpointBytes) === selection.preparedDigest);
  const checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
  requireValue(checkpoint.schemaVersion === 1 && isDeepStrictEqual(checkpoint.identity, selection.checkpointIdentity) &&
    Array.isArray(checkpoint.files));
  const entries = checkpoint.files.filter((file: { path?: string }) => file?.path === "public-context.json");
  requireValue(entries.length === 1 && entries[0].size === bytes.length && entries[0].digest === hash(bytes));
}

export function editorialContextBundle(bytes: Buffer, selection: EditorialPreviewSelection) {
  requireValue(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024);
  const written = JSON.parse(bytes.toString("utf8"));
  const artifactReceiptDigest = hash(JSON.stringify(written?.receipt) ?? "");
  const bundle = normalizePublicArtifactBundle(written);
  const { buildBatchId, generation, commitSha, mediaManifestDigest } = bundle.receipt;
  requireValue(isDeepStrictEqual({ buildBatchId, generation, commitSha }, selection.source));
  return { bundle, contextReceipt: { buildBatchId, generation, commitSha, mediaManifestDigest, artifactReceiptDigest } };
}

export function editorialContextManifest(bytes: Buffer, selection: EditorialPreviewSelection, withdrawalRevision: number): EditorialPreviewManifest {
  requireValue(Number.isSafeInteger(withdrawalRevision) && withdrawalRevision >= 0);
  const { contextReceipt } = editorialContextBundle(bytes, selection);
  const sha256 = hash(bytes);
  const id = editorialPreviewContextId(selection.publication, selection.contextDigest, selection.operationId);
  return { schemaVersion: 2, withdrawalRevision, selection, contextReceipt, sha256, byteLength: bytes.length,
    key: `editorial-context/${id}/${sha256}.json` };
}

export function assertEditorialContextManifest(value: unknown, selection: EditorialPreviewSelection): EditorialPreviewManifest {
  const manifest = value as EditorialPreviewManifest;
  requireValue(manifest && typeof manifest === "object" && !Array.isArray(manifest) &&
    (manifest.schemaVersion === 1 && Object.keys(manifest).sort().join(",") === "byteLength,contextReceipt,key,schemaVersion,selection,sha256" ||
      manifest.schemaVersion === 2 && Object.keys(manifest).sort().join(",") === "byteLength,contextReceipt,key,schemaVersion,selection,sha256,withdrawalRevision" &&
      Number.isSafeInteger(manifest.withdrawalRevision) && manifest.withdrawalRevision! >= 0) && isDeepStrictEqual(manifest.selection, selection) && DIGEST.test(manifest.sha256) &&
    Number.isSafeInteger(manifest.byteLength) && manifest.byteLength > 0 && manifest.byteLength <= 64 * 1024 * 1024 &&
    manifest.key === `editorial-context/${editorialPreviewContextId(selection.publication, selection.contextDigest, selection.operationId)}/${manifest.sha256}.json`);
  return manifest;
}

export function assertEditorialContextBytes(bytes: Buffer | null, manifest: EditorialPreviewManifest) {
  requireValue(bytes && bytes.length === manifest.byteLength && hash(bytes) === manifest.sha256);
  const { bundle, contextReceipt } = editorialContextBundle(bytes!, manifest.selection);
  requireValue(isDeepStrictEqual(contextReceipt, manifest.contextReceipt));
  return bundle;
}
