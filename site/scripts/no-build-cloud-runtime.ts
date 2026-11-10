import path from "node:path";
import type { PreviewStorageCredential } from "./cms-preview-storage-credential";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { App } from "firebase-admin/app";
import { cloudExternalRefresh } from "./cloud-external-refresh";
import { createSpotlightImageStorage } from "./spotlight-image-cache.mjs";
import { cloudEditorialPreviewRetention } from "./cloud-editorial-preview-retention";
import { noBuildPostMaintenance } from "./no-build-post-background";
import { startNoBuildPostMaintenanceService } from "./no-build-post-maintenance-service";
import { buildNoBuildCloudBackground } from "./build-no-build-cloud-background";
import { startPublicWorkerDeploymentReconciliationOwner } from "./public-worker-deployment-reconciliation-owner";
import { runNoBuildCloudRelease } from "./no-build-cloud-release";
import { createCmsPublicationCloudStorage } from "./cms-publication-cloud-storage";
import type { MediaManagerCredential } from "./frozen-publication";

const require = createRequire(import.meta.url);
const { readNoBuildCloudWork, cloudBillingPaused } = require("../../functions/lib/no-build-cloud-work");
const { OWNER_COLLECTION } = require("../../functions/lib/no-build-post-ownership");

/** The cloud runtime never constructs a legacy serializer or claims its queue. */
export function startNoBuildCloudRuntime({ firestore, firebaseApp, commitSha, serializerId,
  stateDirectory, buildEnvironment, cloudflareApiToken, storage, previewStorageCredential, mediaManagerCredential, spotlightImageStorageFactory }: {
  firestore: Firestore; firebaseApp: App; commitSha: string; serializerId: string;
  stateDirectory: string; buildEnvironment: Record<string, string | undefined>; cloudflareApiToken: string;
  previewStorageCredential: PreviewStorageCredential;
  mediaManagerCredential: MediaManagerCredential;
  spotlightImageStorageFactory?: (signal: AbortSignal) => ReturnType<typeof createSpotlightImageStorage>;
  storage: ReturnType<typeof createCmsPublicationCloudStorage>;
}) {
  const runtime = { owner: "cloudflare" as const, release: commitSha };
  const paused = () => cloudBillingPaused({ runtime,
    read: async (document: string) => (await firestore.doc(document).get()).data() ?? null });
  const owner = startPublicWorkerDeploymentReconciliationOwner({ firestore, cloudflareApiToken, runtime });
  const distDirectory = path.join(stateDirectory, "background", "dist");
  const maintain = noBuildPostMaintenance({ firestore, firebaseApp, commitSha, stateDirectory, distDirectory,
    buildEnvironment, runtime, serializerId, mediaManagerCredential, backgroundBucket: storage.target.backgroundBucket,
    onPreviewProjection: () => kickPreview(), buildPublication: input => buildNoBuildCloudBackground(input, distDirectory) });
  const refresh = cloudExternalRefresh({ firestore, firebaseApp, runtime, serializerId, backgroundBucket: storage.target.backgroundBucket,
    stateDirectory, buildEnvironment, mediaManagerCredential, spotlightImageStorageFactory });
  const retainPreview = cloudEditorialPreviewRetention({ firestore, firebaseApp, runtime, serializerId,
    backgroundBucket: storage.target.backgroundBucket, stateDirectory, previewStorageCredential });
  let stopped = false;
  let refreshWork: Promise<void> | null = null;
  let previewWork: Promise<void> | null = null;
  const kickPreview = () => {
    if (!stopped && !previewWork) {
      previewWork = Promise.resolve().then(async () => await paused() || stopped ? false : retainPreview())
        .then(() => {})
        .catch(() => { console.error("Editorial preview retention failed; durable preview health remains authoritative"); })
        .finally(() => { previewWork = null; });
    }
  };
  const kickRefresh = () => {
    if (!stopped && !refreshWork) {
      refreshWork = Promise.resolve().then(async () => { if (!await paused() && !stopped) await refresh(); })
        .catch(() => { console.error("Cloud external refresh failed; durable refresh health remains authoritative"); })
        .finally(() => { refreshWork = null; });
    }
  };
  const service = startNoBuildPostMaintenanceService({ firestore, onWake: kickRefresh, maintain: async () => {
    if (await paused() || stopped) return;
    const work = await readNoBuildCloudWork({ runtime,
      read: async (document: string) => (await firestore.doc(document).get()).data() ?? null,
      listOwners: async () => (await firestore.collection(OWNER_COLLECTION).get()).docs.map(row => row.data()),
    });
    if (work.maintenance) await maintain();
    const pointer = (await firestore.doc("system/publicDeployment").get()).data();
    if (!stopped && pointer?.state === "idle") await runNoBuildCloudRelease({ firestore, storage, serializerId, commitSha, stateDirectory, cloudflareApiToken, previewStorageCredential });
    if (!stopped && "previewContext" in work && work.previewContext) kickPreview();
  } });
  const stop = () => { stopped = true; service.stop(); owner.stop(); };
  const closed = (async () => {
    try { await Promise.race([service.closed, owner.closed]); }
    finally { stop(); await Promise.allSettled([service.closed, owner.closed, refreshWork, previewWork]); }
    return { reason: "stopped" as const };
  })();
  return { stop, closed, wake: service.wake, isRunning: () => service.isRunning() || refreshWork !== null || previewWork !== null };
}
