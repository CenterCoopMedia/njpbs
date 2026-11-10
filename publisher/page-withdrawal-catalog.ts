import targets, { type PublicationTarget } from "../functions/lib/publication-target.js";
import { pageWithdrawalManifestKey, encodePageWithdrawalManifest, readPageWithdrawalObject,
  type PageWithdrawal, type PageWithdrawalManifest } from "../workers/src/durable-page-withdrawals";
import { observeWithdrawalCatalog, publishWithdrawalCatalogObject, type CatalogObservation, type CatalogStore } from "./withdrawal-catalog";

function refuse(): never { throw new Error("Durable Page withdrawal publication is unavailable"); }
export async function mergePageWithdrawalCatalog(previous: PageWithdrawalManifest | null, observation: CatalogObservation,
  workerName: string, verifiedAt = Date.now()): Promise<PageWithdrawalManifest> {
  if (previous && previous.contextRevision > observation.contextRevision) refuse();
  const entries = new Map((previous?.withdrawals ?? []).map(entry => [entry.pageId, entry]));
  for (const owner of observation.owners) {
    const marker = owner.durableWithdrawal;
    if (!marker) continue;
    const queue = observation.queues.get(marker.operationId), operation = queue?.noBuildPage;
    const document = observation.posts.get(owner.pageId);
    if (owner.schemaVersion !== 1 || marker.schemaVersion !== 1 || marker.pageId !== owner.pageId ||
        typeof owner.visible !== "boolean" || !Array.isArray(owner.ownedPaths) || !Array.isArray(marker.ownedPaths) ||
        marker.ownedPaths.some((path: unknown) => !owner.ownedPaths.includes(path)) ||
        !Number.isSafeInteger(owner.generation) || marker.revision > owner.generation ||
        (owner.operationId === marker.operationId ? owner.visible !== false || owner.generation !== marker.revision ||
          owner.sourceVersion !== marker.sourceVersion || !document || document.published?.sourceVersion !== marker.sourceVersion ||
          !document.deleted && (document.publiclyVisible === true || document.publiclyVisible === undefined && document.status === "published") :
          owner.generation <= marker.revision) ||
        !Number.isSafeInteger(marker.contextRevision) || marker.contextRevision < 1 || marker.contextRevision > observation.contextRevision ||
        !/^[a-f0-9]{64}$/.test(marker.snapshotDigest ?? "") || queue?.transport !== "page-no-build-v1" ||
        !["pending", "failed", "success", "cancelled"].includes(queue.status) || operation?.schemaVersion !== 1 ||
        operation.pageId !== marker.pageId || operation.operationId !== marker.operationId || operation.visible !== false ||
        operation.generation !== marker.revision || operation.sourceVersion !== marker.sourceVersion ||
        operation.snapshotDigest !== marker.snapshotDigest || operation.contextRevision !== marker.contextRevision ||
        JSON.stringify(operation.ownedPaths) !== JSON.stringify(marker.ownedPaths)) refuse();
    const old = entries.get(marker.pageId);
    if (old && old.revision > marker.revision) continue;
    if (old && old.revision === marker.revision && (old.operationId !== marker.operationId || old.sourceVersion !== marker.sourceVersion)) refuse();
    const entry: PageWithdrawal = { pageId: marker.pageId, operationId: marker.operationId, sourceVersion: marker.sourceVersion,
      revision: marker.revision, ownedPaths: [...new Set([...(old?.ownedPaths ?? []), ...marker.ownedPaths])],
      verifiedAt: old && old.operationId === marker.operationId ? old.verifiedAt : verifiedAt };
    entries.set(entry.pageId, entry);
  }
  return JSON.parse(encodePageWithdrawalManifest({ schemaVersion: 1, workerName,
    contextRevision: observation.contextRevision, withdrawals: [...entries.values()] }, workerName));
}

/** The authorized Page transaction retains its marker; R2 publication must precede completion. */
export async function publishPageWithdrawalCatalog(options: { store: CatalogStore | undefined; target: PublicationTarget;
  account: string; commitSha: string }, observe?: () => Promise<CatalogObservation>): Promise<void> {
  targets.assertPublicationTarget(options.target);
  return publishWithdrawalCatalogObject({ store: options.store, key: pageWithdrawalManifestKey(options.target.workerName),
    read: (object, signal) => readPageWithdrawalObject(object, options.target.workerName, signal),
    observe: signal => observe ? observe() : observeWithdrawalCatalog({ ...options, family: "page", signal }),
    merge: (previous, observation) => mergePageWithdrawalCatalog(previous, observation, options.target.workerName),
    encode: value => encodePageWithdrawalManifest(value, options.target.workerName) });
}
