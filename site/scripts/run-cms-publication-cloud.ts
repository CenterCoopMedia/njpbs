import { cloudflarePublicWorkerTag } from "./cloudflare-account.mjs";
import { assertProviderDeploymentPathsSerialized } from "./activate-public-worker-candidate";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCmsPreviewSourceCheckout } from "./cms-publication-runtime-guard";
import {
  assertProductionFirestoreRouting,
  parseCmsPublicationFirebaseServiceAccount,
  parseCmsPublicationSerializerArguments,
  parseCmsPublicationPublicBuildEnvironment,
  parseCmsPublicationMediaManagerCredential,
} from "./cms-publication-inputs";
import { assertPreviewSandboxAvailable } from "./run-cms-preview-serializer";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { startNoBuildCloudRuntime } from "./no-build-cloud-runtime";
import { createCmsPublicationCloudStorage } from "./cms-publication-cloud-storage";
import { createSpotlightImageStorage } from "./spotlight-image-cache.mjs";
import {
  assertPublicationRuntimeIdentity,
  confirmPublicationRuntimeReady,
} from "./cms-publication-cloud-control";

const STATE_DIRECTORY = "/var/lib/njpbs-cms-publisher";

// Names the startup step that failed. The message stays the original one for
// callers; the process log prints only the stage, error name and error code.
export class CloudPublicationStageError extends Error {
  constructor(readonly stage: string, readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : "Cloud publication failed", { cause: failure });
    this.name = "CloudPublicationStageError";
  }
}

export function describeCloudPublicationFailure(error: unknown) {
  const staged = error instanceof CloudPublicationStageError;
  const failure = staged ? error.failure : error;
  const name = failure instanceof Error ? failure.name : typeof failure;
  const code = (failure as { code?: unknown } | null)?.code;
  const safeCode = typeof code === "number" || (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) ? String(code) : "none";
  return `Cloud publication runtime stopped without a verified result (stage ${staged ? error.stage : "unknown"}, error ${/^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "Error"}, code ${safeCode})\n`;
}

export async function runCmsPublicationCloud(
  mode: string,
  environment = process.env,
) {
  const progress = { stage: "environment" };
  try {
    await runCloudPublicationStages(mode, environment, progress);
  } catch (error) {
    throw new CloudPublicationStageError(progress.stage, error);
  }
}

async function runCloudPublicationStages(
  mode: string,
  environment: NodeJS.ProcessEnv,
  progress: { stage: string },
) {
  // Keep secrets in the operator only. No file, log, child environment or
  // inherited descriptor carries these credentials into the Astro process.
  const rawAccount = environment.CMS_PUBLICATION_FIREBASE_ACCOUNT ?? "";
  const rawStorage = environment.CMS_PUBLICATION_R2_CREDENTIAL ?? "";
  const rawPreviewStorage = environment.CMS_PUBLICATION_PREVIEW_R2_CREDENTIAL ?? "";
  const cloudflareApiToken = environment.CMS_PUBLICATION_ACTIVATION_TOKEN ?? "";
  const rawMediaManager = environment.CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL ?? "";
  const rawMediaStorage = environment.CMS_PUBLICATION_MEDIA_R2_CREDENTIAL ?? "";
  const mediaEndpoint = environment.CMS_MEDIA_R2_ENDPOINT;
  const mediaBucket = environment.CMS_MEDIA_R2_BUCKET;
  const inheritedMediaManager = environment.MEDIA_MANAGER_API_KEY !== undefined || environment.MEDIA_MANAGER_API_SECRET !== undefined;
  const inheritedMediaStorage = environment.CMS_MEDIA_R2_ACCESS_KEY_ID !== undefined || environment.CMS_MEDIA_R2_SECRET_ACCESS_KEY !== undefined;
  for (const key of [
    "CMS_PUBLICATION_FIREBASE_ACCOUNT",
    "CMS_PUBLICATION_R2_CREDENTIAL",
    "CMS_PUBLICATION_PREVIEW_R2_CREDENTIAL",
    "CMS_PUBLICATION_ACTIVATION_TOKEN",
    "CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL",
    "CMS_PUBLICATION_MEDIA_R2_CREDENTIAL",
    "MEDIA_MANAGER_API_KEY",
    "MEDIA_MANAGER_API_SECRET",
    "CMS_MEDIA_R2_ACCESS_KEY_ID",
    "CMS_MEDIA_R2_SECRET_ACCESS_KEY",
  ])
    // config-input: CMS_MEDIA_R2_ACCESS_KEY_ID, CMS_MEDIA_R2_SECRET_ACCESS_KEY, CMS_PUBLICATION_ACTIVATION_TOKEN
    // config-input: CMS_PUBLICATION_FIREBASE_ACCOUNT, CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL
    // config-input: CMS_PUBLICATION_MEDIA_R2_CREDENTIAL, CMS_PUBLICATION_PREVIEW_R2_CREDENTIAL, CMS_PUBLICATION_R2_CREDENTIAL
    // config-input: MEDIA_MANAGER_API_KEY, MEDIA_MANAGER_API_SECRET
    delete environment[key];
  if (inheritedMediaManager) throw new Error("Cloud publication refuses inherited Media Manager credentials");
  if (inheritedMediaStorage) throw new Error("Cloud publication refuses inherited media storage credentials");
  progress.stage = "routing";
  assertProductionFirestoreRouting(environment);
  progress.stage = "arguments";
  assertProviderDeploymentPathsSerialized();
  const { commitSha, serializerId } = parseCmsPublicationSerializerArguments([
    "--serve",
    environment.CMS_PUBLICATION_COMMIT_SHA ?? "",
    environment.CMS_PUBLICATION_SERIALIZER_ID ?? "",
  ]);
  if (!["--serve", "--preflight"].includes(mode))
    throw new Error("Invalid cloud publication operator mode");
  progress.stage = "cloudflare-configuration";
  cloudflarePublicWorkerTag(environment);
  progress.stage = "source-checkout";
  await assertCmsPreviewSourceCheckout(commitSha);
  progress.stage = "sandbox";
  await assertPreviewSandboxAvailable();
  if (mode === "--preflight") return;
  progress.stage = "inputs";
  const buildEnvironment =
    parseCmsPublicationPublicBuildEnvironment(environment);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(cloudflareApiToken)) {
    throw new Error("Cloud publication credentials are invalid");
  }
  const account = parseCmsPublicationFirebaseServiceAccount(rawAccount);
  const mediaManagerCredential = parseCmsPublicationMediaManagerCredential(rawMediaManager);
  // Keep the optional media credential in this operator. Parse it only when a
  // normal refresh needs storage; never pass it into the Astro build environment.
  const spotlightImageStorageFactory = rawMediaStorage ? (signal: AbortSignal) =>
    createSpotlightImageStorage({ ...parsePreviewStorageCredential(rawMediaStorage), endpoint: mediaEndpoint, bucket: mediaBucket }, signal) : undefined;
  const credentials = parsePreviewStorageCredential(rawStorage);
  const previewStorageCredential = parsePreviewStorageCredential(rawPreviewStorage);
  progress.stage = "firebase";
  const app = firebaseAdminRuntime.initializeApp(
    { credential: firebaseAdminRuntime.cert(account), projectId: "njpbs-site" },
    "cms-publication-cloud",
  );
  const firestore = firebaseAdminRuntime.getFirestore(app);
  progress.stage = "storage-client";
  const storage = createCmsPublicationCloudStorage({ ...credentials, includeRenderer: true });
  let runtime:
    ReturnType<typeof startNoBuildCloudRuntime> | undefined;
  let stopping = false;
  let ready = false;
  let observation = 0;
  const stop = () => {
    stopping = true;
    ready = false;
    runtime?.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const server = createServer((request, response) => {
    const wake = request.method === "POST" && request.url === "/wake";
    if (!wake && (request.method !== "GET" || request.url !== "/health")) {
      response.writeHead(404).end();
      return;
    }
    if (wake) runtime?.wake();
    // The Worker receives exact release identity, then exposes only an aggregate
    // public status. An active coordinator observation is required for readiness.
    response.writeHead(ready && observation > 0 ? 200 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        status: ready && observation > 0 ? "ready" : "starting",
        commitSha,
        serializerId,
        busy: runtime?.isRunning() ?? false,
      }),
    );
  });
  let unwatch: (() => void) | undefined;
  let watchFailure: unknown;
  try {
    progress.stage = "listen";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(8080, "0.0.0.0", resolve);
    });
    progress.stage = "runtime-identity";
    await assertPublicationRuntimeIdentity(firestore, commitSha, serializerId);
    progress.stage = "storage-ready";
    await storage.assertReady();
    progress.stage = "deployment-watch";
    // Read errors stop the process instead of leaving a green health response.
    unwatch = firestore
      .doc("system/publicDeployment")
      .onSnapshot((snapshot) => {
        if (!snapshot.exists) {
          stop();
          return;
        }
        observation++;
      }, (error) => {
        watchFailure ??= error;
        stop();
      });
    progress.stage = "runtime-start";
    runtime = startNoBuildCloudRuntime({
      firestore, firebaseApp: app, serializerId, commitSha, cloudflareApiToken,
      stateDirectory: STATE_DIRECTORY, buildEnvironment, storage, previewStorageCredential, mediaManagerCredential, spotlightImageStorageFactory,
    });
    const closed = runtime.closed.then(
      () => null,
      (error) => ({ error }),
    );
    if (stopping) runtime.stop();
    else {
      progress.stage = "runtime-ready";
      await confirmPublicationRuntimeReady(firestore, commitSha, serializerId);
      ready = true;
    }
    progress.stage = "runtime";
    const outcome = await closed;
    if (outcome) throw outcome.error;
    if (watchFailure !== undefined) {
      progress.stage = "deployment-watch";
      throw watchFailure;
    }
  } finally {
    ready = false;
    runtime?.stop();
    await runtime?.closed.catch(() => undefined);
    unwatch?.();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    await firebaseAdminRuntime.deleteApp(app);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCmsPublicationCloud(process.argv[2] ?? "").catch((error) => {
    process.stderr.write(describeCloudPublicationFailure(error));
    process.exitCode = 1;
  });
}
