import { parsePreviewOperatorArguments, assertPreviewSandboxAvailable } from "./cms-preview-operator-checks";
export { parsePreviewOperatorArguments, assertPreviewSandboxAvailable } from "./cms-preview-operator-checks";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential";
export { parsePreviewStorageCredential, type PreviewStorageCredential } from "./cms-preview-storage-credential";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCmsPreviewSourceCheckout } from "./cms-publication-runtime-guard";
import { assertCmsPublicationSerializerLock, assertProductionFirestoreRouting,
  parseCmsPublicationFirebaseServiceAccount, resolveCmsPublicationCredentialPath } from "./cms-publication-inputs";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { startCmsPreviewSerializerService } from "./cms-preview-serializer-service";
import { verifyCompiledRenderer } from "./compiled-renderer-release.mjs";

const STATE_DIRECTORY = "/var/lib/njpbs-cms-preview";
const PUBLISHER_STATE_DIRECTORY = "/var/lib/njpbs-cms-publisher";
const LOCK_PATH = "/run/njpbs-cms-preview/serializer.lock";
const CREDENTIAL_DIRECTORY = "/run/credentials/njpbs-cms-preview.service";

function readCredential(fd: number, name: string, limit: number) {
  resolveCmsPublicationCredentialPath(fd, `${CREDENTIAL_DIRECTORY}/${name}`);
  if (fstatSync(fd).size > limit) throw new Error("Preview credential exceeds its size limit");
  try { return readFileSync(fd, "utf8"); }
  finally { closeSync(fd); }
}

const defaultDependencies = {
  assertSource: assertCmsPreviewSourceCheckout,
  assertRelease: (rendererSha: string) => verifyCompiledRenderer(fileURLToPath(new URL("../.compiled-renderer", import.meta.url)), rendererSha),
  assertSandbox: assertPreviewSandboxAvailable,
  assertLock: assertCmsPublicationSerializerLock,
  readCredential,
  initializeFirebase: (serviceAccount: ReturnType<typeof parseCmsPublicationFirebaseServiceAccount>) =>
    firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(serviceAccount), projectId: "njpbs-site" }, "cms-preview-serializer"),
  firestoreFor: firebaseAdminRuntime.getFirestore,
  deleteFirebase: firebaseAdminRuntime.deleteApp,
  startService: startCmsPreviewSerializerService,
  attachSignals: (stop: () => void) => {
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); };
  },
};

export async function runCmsPreviewSerializerOperator(args: string[],
  dependencies: Partial<typeof defaultDependencies> = {}, environment = process.env) {
  assertProductionFirestoreRouting(environment);
  const { preflight, rendererSha, serializerId } = parsePreviewOperatorArguments(args);
  const operations = { ...defaultDependencies, ...dependencies };
  await operations.assertSource(rendererSha);
  await operations.assertRelease(rendererSha);
  await operations.assertSandbox();
  if (preflight) return;
  operations.assertLock(5, LOCK_PATH);
  const storage = parsePreviewStorageCredential(operations.readCredential(3, "r2-preview", 4096));
  const account = parseCmsPublicationFirebaseServiceAccount(operations.readCredential(4, "firebase-service-account", 64 * 1024));
  const app = operations.initializeFirebase(account);
  let runtime: { stop(): void; closed: Promise<unknown> } | undefined;
  let stopping = false;
  const detach = operations.attachSignals(() => { stopping = true; runtime?.stop(); });
  try {
    runtime = await operations.startService({ firestore: operations.firestoreFor(app), rendererSha, serializerId,
      stateDirectory: STATE_DIRECTORY, publisherStateDirectory: PUBLISHER_STATE_DIRECTORY, ...storage });
    if (stopping) runtime.stop();
    await runtime.closed;
  } finally {
    detach();
    runtime?.stop();
    await operations.deleteFirebase(app);
  }
}

export async function main(args = process.argv.slice(2)) {
  try { await runCmsPreviewSerializerOperator(args); }
  catch {
    // Provider and credential-parser exceptions can contain private input.
    process.stderr.write("CMS preview serializer stopped without a verified result\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
