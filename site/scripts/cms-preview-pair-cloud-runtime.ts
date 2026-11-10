import { createRequire } from "node:module";
import { preparePreviewPairStateDirectory } from "./cms-preview-pair-state.ts";
import { parseCmsPublicationFirebaseServiceAccount } from "./cms-publication-credentials.ts";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential.ts";
import { firebaseAdminRuntime } from "./firebase-admin-runtime.ts";
import type { PublicationTarget } from "../../functions/lib/publication-target";
import { createPreviewPairContextReader, type PreviewPairCodeTransportFactory } from "./cms-preview-pair-context.ts";
import { createPreviewPairEditorialContextReader } from "./cms-preview-pair-editorial-context.ts";
import { servePreviewPairStandby } from "./cms-preview-pair-standby.ts";
import { createCmsPreviewCloudStorage } from "./cms-preview-cloud-storage.ts";
import { startCmsPreviewSerializerService } from "./cms-preview-serializer-service.ts";
import { openCmsPreviewCloudTokenJournal } from "./cms-preview-cloud-token-journal.ts";
import { processCmsPreview, removePrivatePreviewJob } from "./process-cms-preview.ts";
import { previewDiagnostics, type PreviewStartup } from "./preview-diagnostics.ts";

const authority = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair-candidate.js");
const { publicationTarget } = createRequire(import.meta.url)("../../functions/lib/publication-target.js") as { publicationTarget(value: string): PublicationTarget };
/** Explicit private pair mode only; legacy startup never enters this function.
 * Source, compiled-package and sandbox checks happen in the unbundled launcher. */
export async function serveCmsPreviewPairCloud({ rawAccount, rawStorage, rendererSha, serializerId, workerVersion,
  deploymentEnvironment, readSecret, createTransport, startup,
  measure = previewDiagnostics({ rendererSha, serializerId, ...startup?.() }) }: {
  rawAccount: string; rawStorage: string; rendererSha: string; serializerId: string; workerVersion: string;
  deploymentEnvironment: string; readSecret: () => string; createTransport: PreviewPairCodeTransportFactory;
  startup?: () => PreviewStartup; measure?: ReturnType<typeof previewDiagnostics>;
}) {
  if (!/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId) || !/^[a-f0-9]{40}$/.test(rendererSha) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workerVersion)) throw new Error("Private preview pair identity is invalid");
  const { target, credentials, stateDirectory, app, firestore, abort, stop, storage, pairContextReader } = await measure("runtime-setup", async () => {
    const target = publicationTarget(deploymentEnvironment);
    const account = parseCmsPublicationFirebaseServiceAccount(rawAccount, target.projectId);
    const credentials = parsePreviewStorageCredential(rawStorage);
    const stateDirectory = await preparePreviewPairStateDirectory("/var/lib/njpbs-cms-preview", serializerId);
    const app = firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(account), projectId: target.projectId }, "cms-preview-pair-cloud");
    const firestore = firebaseAdminRuntime.getFirestore(app);
    const abort = new AbortController(), stop = () => abort.abort();
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    const contextOptions = { firestore, target, rendererSha, pairId: serializerId, workerVersion, readSecret, createTransport };
    const pairContextReader = createPreviewPairContextReader(contextOptions);
    const pairEditorialContextReader = createPreviewPairEditorialContextReader(contextOptions);
    const storage = createCmsPreviewCloudStorage({ ...credentials, bucket: target.previewBucket,
      deploymentEnvironment, contextSignal: abort.signal, pairContextReader, pairEditorialContextReader });
    return { target, credentials, stateDirectory, app, firestore, abort, stop, storage, pairContextReader };
  });
  const readAuthority = () => firestore.runTransaction<{ mode: "candidate" | "retained" }>(transaction => authority.readPreviewPairRuntimeAuthority({
    read: async (path: string) => (await transaction.get(firestore.doc(path))).data(),
    pairId: serializerId, rendererSha, workerVersion,
  }), { readOnly: true });
  try {
    const standby = await servePreviewPairStandby({ identity: { pairId: serializerId, rendererSha, serializerId, workerVersion },
      readAuthority, checkContext: pairContextReader, signal: abort.signal, startup,
      startListener: () => measure("listener-start", () => startCmsPreviewSerializerService({ firestore, serializerId, rendererSha, stateDirectory,
        deploymentEnvironment, projectId: target.projectId, ...credentials,
        dependencies: {
          openJournal: () => openCmsPreviewCloudTokenJournal({ firestore, serializerId }),
          process: options => processCmsPreview({ ...options, inputStorage: storage, startup,
            dependencies: { readPublicContext: onRefreshing => storage.readEditorialPublicContext(firestore, onRefreshing) } }),
          cleanup: async (directory, queueId) => { await storage.remove(queueId); await removePrivatePreviewJob(directory, queueId); },
        },
      })),
    });
    await standby.closed;
  } finally {
    abort.abort(); storage.close(); process.off("SIGTERM", stop); process.off("SIGINT", stop);
    await firebaseAdminRuntime.deleteApp(app);
  }
}
