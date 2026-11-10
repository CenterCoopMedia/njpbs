import { preparePreviewPairStateDirectory } from "./cms-preview-pair-state.ts";
import { createServer } from "node:http";
import { parseCmsPublicationFirebaseServiceAccount } from "./cms-publication-credentials.ts";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential.ts";
import { firebaseAdminRuntime } from "./firebase-admin-runtime.ts";
import { startCmsPreviewSerializerService } from "./cms-preview-serializer-service.ts";
import { openCmsPreviewCloudTokenJournal } from "./cms-preview-cloud-token-journal.ts";
import { createCmsPreviewCloudStorage } from "./cms-preview-cloud-storage.ts";
import { processCmsPreview, removePrivatePreviewJob } from "./process-cms-preview.ts";
import { assertPreviewRuntimeIdentity, confirmPreviewRuntimeReady } from "./cms-preview-cloud-control.ts";
import type { previewDiagnostics, PreviewStartup } from "./preview-diagnostics.ts";
import { serveCmsPreviewPairCloud } from "./cms-preview-pair-cloud-runtime.ts";
import type { PreviewPairCodeTransportFactory } from "./cms-preview-pair-context.ts";

const STATE_DIRECTORY = "/var/lib/njpbs-cms-preview";

/** Called only after source, sealed package and sandbox admission succeed. */
export async function serveCmsPreviewCloud({ rawAccount, rawStorage, rendererSha, serializerId, nodeStartupMs, measure,
  deploymentEnvironment = "production", publicationAccess, pairRuntime, startup }: {
  pairRuntime?: { workerVersion: string; readSecret: () => string; createTransport: PreviewPairCodeTransportFactory };
  rawAccount: string; rawStorage: string; rendererSha: string; serializerId: string;
  deploymentEnvironment?: string; publicationAccess?: { clientId: string; clientSecret: string };
  nodeStartupMs: number; measure: ReturnType<typeof previewDiagnostics>;
  startup?: () => PreviewStartup;
}) {
  if (pairRuntime) return serveCmsPreviewPairCloud({ rawAccount, rawStorage, rendererSha, serializerId,
    deploymentEnvironment, measure, startup, ...pairRuntime });
  const { projectId, credentials, stateDirectory, app, firestore, contextWait, storage } = await measure("runtime-setup", async () => {
    if (!["production", "development"].includes(deploymentEnvironment)) throw new Error("Invalid preview environment");
    const projectId = deploymentEnvironment === "development" ? "njpbs-site-dev" : "njpbs-site";
    const account = parseCmsPublicationFirebaseServiceAccount(rawAccount, projectId);
    const credentials = parsePreviewStorageCredential(rawStorage);
    const stateDirectory = /^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId)
      ? await preparePreviewPairStateDirectory(STATE_DIRECTORY, serializerId) : STATE_DIRECTORY;
    const app = firebaseAdminRuntime.initializeApp({
      credential: firebaseAdminRuntime.cert(account), projectId,
    }, "cms-preview-cloud");
    const firestore = firebaseAdminRuntime.getFirestore(app);
    const contextWait = new AbortController();
    const storage = createCmsPreviewCloudStorage({ ...credentials, deploymentEnvironment, publicationAccess,
      contextSignal: contextWait.signal,
      bucket: deploymentEnvironment === "development" ? "template-dev-cms-previews" : "njpbs-cms-previews" });
    return { projectId, credentials, stateDirectory, app, firestore, contextWait, storage };
  });
  let runtime: Awaited<ReturnType<typeof startCmsPreviewSerializerService>> | undefined;
  let stopping = false;
  let ready = false;
  const stop = () => {
    stopping = true; ready = false;
    contextWait.abort(new Error("Preview runtime is stopping"));
    runtime?.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(ready ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ status: ready ? "ready" : "starting", rendererSha, serializerId,
      ...(startup ? { startup: startup() } : {}) }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(8080, "0.0.0.0", resolve);
    });
    // Trusted source/package/sandbox admission has already completed. These
    // read-only probes share no results; drain all before processing or cleanup.
    const probes = await Promise.allSettled([
      measure("runtime-check", () => assertPreviewRuntimeIdentity(firestore, rendererSha, serializerId)),
      measure("public-context", () => storage.readPublicContext(firestore)),
      // A newly deployed index must be usable before admission opens.
      measure("index-check", () => firestore.collection("cmsPreviewQueue").where("status", "==", "pending")
        .where("transport", "==", "serializer").where("rendererSha", "==", rendererSha).select().limit(1).get()),
    ]);
    // Keep error priority deterministic: identity, public context, then index.
    for (const probe of probes) if (probe.status === "rejected") throw probe.reason;
    runtime = await measure("listener-start", () => startCmsPreviewSerializerService({ firestore, serializerId, rendererSha,
      stateDirectory, deploymentEnvironment, projectId, ...credentials,
      dependencies: {
        openJournal: () => openCmsPreviewCloudTokenJournal({ firestore, serializerId }),
        process: options => processCmsPreview({ ...options, inputStorage: storage, startup,
          dependencies: { readPublicContext: onRefreshing => storage.readEditorialPublicContext(firestore, onRefreshing) } }),
        cleanup: async (stateDirectory, queueId) => {
          await storage.remove(queueId);
          await removePrivatePreviewJob(stateDirectory, queueId);
        },
      },
    }));
    // Observe listener failures while the readiness transaction is in flight.
    const closed = runtime.closed.then(() => null, error => ({ error }));
    if (stopping) runtime.stop();
    else {
      await measure("runtime-ready", () => confirmPreviewRuntimeReady(firestore, rendererSha, serializerId, {
        ...measure.timings(), "node-startup": nodeStartupMs,
      }));
      ready = true;
    }
    const outcome = await closed;
    if (outcome) throw outcome.error;
  } finally {
    ready = false;
    runtime?.stop();
    await runtime?.closed.catch(() => undefined);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
    await firebaseAdminRuntime.deleteApp(app);
  }
}
