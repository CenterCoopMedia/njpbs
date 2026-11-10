import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Firestore } from "firebase-admin/firestore";
import { openCmsPublicationTokenJournal, type CmsPublicationJournalJob } from "./cms-publication-token-journal.ts";
import { assertCmsPublicationDirectoriesSeparated, assertCmsPreviewSourceCheckout } from "./cms-publication-runtime-guard.ts";
import { processCmsPreview, removePrivatePreviewJob } from "./process-cms-preview.ts";
import { uploadPrivatePreview, retainPrivatePreview, removeRetainedPreview } from "./upload-private-preview.mjs";
import { previewOutputTarget } from "./preview-output-target.mjs";

const require = createRequire(import.meta.url);
const { startCmsPreviewSerializerListener } = require("../../functions/lib/cms-preview-serializer.js");
const TERMINAL = new Set(["ready", "failed", "expired"]);

/** The operator must hold one process lock for this private state directory.
 * Reuse the existing durable token journal in a separate preview directory;
 * its buildBatchId field holds a local preview job identity, not a publication.
 */
export async function startCmsPreviewSerializerService({ firestore, serializerId, rendererSha,
  stateDirectory, publisherStateDirectory, accessKeyId, secretAccessKey,
  deploymentEnvironment = "production", projectId = "njpbs-site", dependencies = {} }: {
  firestore: Firestore;
  serializerId: string;
  rendererSha: string;
  stateDirectory: string;
  publisherStateDirectory?: string;
  accessKeyId: string;
  secretAccessKey: string;
  deploymentEnvironment?: string;
  projectId?: string;
  dependencies?: Partial<{
    assertSource: typeof assertCmsPreviewSourceCheckout;
    openJournal: typeof openCmsPublicationTokenJournal;
    startListener: typeof startCmsPreviewSerializerListener;
    process: typeof processCmsPreview;
    upload: typeof uploadPrivatePreview;
    retain: typeof retainPrivatePreview;
    removeRetained: typeof removeRetainedPreview;
    cleanup: typeof removePrivatePreviewJob;
  }>;
}): Promise<{ stop(): void; closed: Promise<unknown> }> {
  const target = previewOutputTarget(deploymentEnvironment, projectId);
  if (!accessKeyId || !secretAccessKey) throw new Error("Private preview storage credentials are required");
  const operations = { assertSource: assertCmsPreviewSourceCheckout,
    openJournal: openCmsPublicationTokenJournal, startListener: startCmsPreviewSerializerListener,
    process: processCmsPreview, upload: uploadPrivatePreview, retain: retainPrivatePreview,
    removeRetained: removeRetainedPreview,
    cleanup: removePrivatePreviewJob, ...dependencies };
  await operations.assertSource(rendererSha);
  if (publisherStateDirectory) await assertCmsPublicationDirectoriesSeparated(stateDirectory, publisherStateDirectory);
  await assertCmsPublicationDirectoriesSeparated(stateDirectory, fileURLToPath(new URL("..", import.meta.url)));
  const journal = await operations.openJournal({ stateDirectory, serializerId });

  async function runJob(job: CmsPublicationJournalJob) {
    if (job.commitSha !== rendererSha || job.buildBatchId !== `preview-${job.queueId}`) {
      throw new Error("Retained preview claim requires its original renderer and job identity");
    }
    const result = await operations.process({ firestore, stateDirectory, publisherStateDirectory,
      deploymentEnvironment: target.environment, projectId: target.projectId,
      claim: { queueId: job.queueId, rendererSha, serializerId, claimToken: job.claimToken },
      upload: artifact => operations.upload(artifact, { accessKeyId, secretAccessKey, target }),
      retain: identity => operations.retain(identity, { accessKeyId, secretAccessKey, target }),
      removeRetained: queueId => operations.removeRetained(queueId, { accessKeyId, secretAccessKey, target }) });
    if (!TERMINAL.has(result?.status) || (result?.outcome && result.outcome !== "terminal")) {
      throw new Error("Preview completion is unconfirmed; retained claim was kept");
    }
    await operations.cleanup(stateDirectory, job.queueId);
    await journal.clear({ queueId: job.queueId, claimToken: job.claimToken });
  }

  // Resume even a pending queue reserved just before a crash. Listener recovery
  // alone finds only building rows and cannot recover that pre-claim interval.
  const retained = await journal.read();
  if (retained) await runJob(retained);
  return operations.startListener({ firestore, serializerId, rendererSha, processQueue: async (queueId: string) => {
    const existing = await journal.read();
    if (existing) {
      if (existing.queueId !== queueId) throw new Error("Another preview claim remains active");
      await runJob(existing);
      return;
    }
    const snapshot = await firestore.collection("cmsPreviewQueue").doc(queueId).get();
    const queue = snapshot.data();
    if (queue?.transport !== "serializer") throw new Error("Preview queue has another transport");
    if (TERMINAL.has(queue.status)) return;
    if (queue.status !== "pending") throw new Error("Building preview has no retained claim token");
    if (queue.rendererSha !== rendererSha) throw new Error("Preview queue requires another renderer");
    if (queue.previewPairId !== undefined && (queue.previewPairId !== serializerId || queue.serializerId !== serializerId)) {
      throw new Error("Preview queue requires its original pair journal");
    }
    const { job } = await journal.reserve({ queueId, buildBatchId: `preview-${queueId}`, commitSha: rendererSha });
    await runJob(job);
  } });
}
