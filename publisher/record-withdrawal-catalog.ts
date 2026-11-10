import targets, { type PublicationTarget } from "../functions/lib/publication-target.js";
import { recordWithdrawalManifestKey, encodeRecordWithdrawalManifest, readRecordWithdrawalObject,
  type RecordWithdrawal, type RecordWithdrawalManifest, type RecordFamily } from "../workers/src/durable-record-withdrawals";
import { observeWithdrawalCatalog, publishWithdrawalCatalogObject, type CatalogObservation, type CatalogStore } from "./withdrawal-catalog";

function refuse(): never { throw new Error("Durable record withdrawal publication is unavailable"); }
export async function mergeRecordWithdrawalCatalog(previous: RecordWithdrawalManifest | null, observation: CatalogObservation,
  workerName: string, verifiedAt = Date.now()): Promise<RecordWithdrawalManifest> {
  const families = observation.recordFamilies ?? [];
  if (previous && (previous.contextRevision > observation.contextRevision || previous.families.some(family => !families.includes(family)))) refuse();
  const entries = new Map((previous?.withdrawals ?? []).map(entry => [entry.recordId, entry]));
  for (const owner of observation.owners) {
    if (!families.includes(owner.family)) refuse();
    const marker = owner.durableWithdrawal;
    if (!marker) continue;
    const queue = observation.queues.get(marker.operationId), operation = queue?.recordPublication;
    const document = observation.posts.get(owner.documentId);
    if (owner.schemaVersion !== 1 || marker.schemaVersion !== 1 || marker.recordId !== owner.documentId || marker.family !== owner.family ||
        typeof owner.visible !== "boolean" || !Array.isArray(owner.ownedPaths) || !Array.isArray(marker.ownedPaths) ||
        marker.ownedPaths.some((path: unknown) => !owner.ownedPaths.includes(path)) ||
        !Number.isSafeInteger(owner.generation) || marker.revision > owner.generation ||
        (owner.operationId === marker.operationId ? owner.visible !== false || owner.generation !== marker.revision ||
          owner.sourceVersion !== marker.sourceVersion || !document || document.published?.sourceVersion !== marker.sourceVersion ||
          !document.deleted && (document.publiclyVisible === true || document.publiclyVisible === undefined && document.status === "published") :
          owner.generation <= marker.revision) ||
        !Number.isSafeInteger(marker.contextRevision) || marker.contextRevision < 1 || marker.contextRevision > observation.contextRevision ||
        !/^[a-f0-9]{64}$/.test(marker.snapshotDigest ?? "") || queue?.transport !== "public-context-no-build-v1" ||
        !["pending", "publishing", "failed", "success", "cancelled"].includes(queue.status) || operation?.schemaVersion !== 1 ||
        operation.documentId !== marker.recordId || operation.family !== marker.family || operation.operationId !== marker.operationId || operation.visible !== false ||
        operation.generation !== marker.revision || operation.sourceVersion !== marker.sourceVersion ||
        operation.snapshotDigest !== marker.snapshotDigest || operation.contextRevision !== marker.contextRevision ||
        JSON.stringify(operation.ownedPaths) !== JSON.stringify(marker.ownedPaths)) refuse();
    const old = entries.get(marker.recordId);
    if (old && old.revision > marker.revision) continue;
    if (old && old.revision === marker.revision && (old.operationId !== marker.operationId || old.sourceVersion !== marker.sourceVersion)) refuse();
    const entry: RecordWithdrawal = { recordId: marker.recordId, family: marker.family, operationId: marker.operationId,
      sourceVersion: marker.sourceVersion, revision: marker.revision, ownedPaths: [...new Set([...(old?.ownedPaths ?? []), ...marker.ownedPaths])],
      verifiedAt: old && old.operationId === marker.operationId ? old.verifiedAt : verifiedAt };
    entries.set(entry.recordId, entry);
  }
  return JSON.parse(encodeRecordWithdrawalManifest({ schemaVersion: 1, workerName, contextRevision: observation.contextRevision,
    families: families as RecordFamily[], withdrawals: [...entries.values()] }, workerName));
}

/** Use the same authenticated observation, bounded CAS and R2 readback as Pages. */
export async function publishRecordWithdrawalCatalog(options: { store: CatalogStore | undefined; target: PublicationTarget;
  account: string; commitSha: string }, observe?: () => Promise<CatalogObservation>): Promise<void> {
  targets.assertPublicationTarget(options.target);
  return publishWithdrawalCatalogObject({ store: options.store, key: recordWithdrawalManifestKey(options.target.workerName),
    read: (object, signal) => readRecordWithdrawalObject(object, options.target.workerName, signal),
    observe: signal => observe ? observe() : observeWithdrawalCatalog({ ...options, family: "record", signal }),
    merge: (previous, observation) => mergeRecordWithdrawalCatalog(previous, observation, options.target.workerName),
    encode: value => encodeRecordWithdrawalManifest(value, options.target.workerName) });
}
