import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "firebase-admin/app";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential";
import { CmsPublicationRuntimeGuardError } from "./cms-publication-runtime-guard";

const require = createRequire(import.meta.url);
const { PreparedPublicReleaseError } = require("../../functions/lib/public-release-error");
const root = fileURLToPath(new URL("../..", import.meta.url));
const usage = "Usage: prepared-cms-publication-cloud-release.sh --seal|--check|--handover|--promote <operation-id> <commit-sha> [--apply for promote]";
class PreparedReleaseOperatorError extends Error {}

export function preparedReleaseErrorMessage(error: unknown): string {
  return error instanceof PreparedReleaseOperatorError || error instanceof PreparedPublicReleaseError ||
    error instanceof CmsPublicationRuntimeGuardError ? (error as Error).message :
    "Prepared release refused; read the preparation, handover and live pointer before retrying";
}

export function parsePreparedReleaseArguments(args: string[]) {
  if (![3, 4].includes(args.length) || args.length === 4 && (args[0] !== "--promote" || args[3] !== "--apply") ||
      !["--seal", "--check", "--handover", "--promote"].includes(args[0]) ||
      !/^[A-Za-z0-9]{20}$/.test(args[1] ?? "") || !/^[a-f0-9]{40}$/.test(args[2] ?? "")) {
    throw new PreparedReleaseOperatorError(usage);
  }
  return { action: args[0], queueId: args[1], commitSha: args[2], apply: args.length === 4 };
}

async function loadReleaseDependencies() {
  try {
    const [{ firebaseAdminRuntime }, { assertProductionFirestoreRouting, parseCmsPublicationFirebaseServiceAccount },
      { createCmsPublicationCloudStorage }, { sealPreparedCloudRelease, promotePreparedCloudRelease }] = await Promise.all([
      import("./firebase-admin-runtime"), import("./run-cms-publication-serializer"),
      import("./cms-publication-cloud-storage"), import("./prepared-cloud-release"),
    ]);
    const { checkSealedPublicRelease, handoverPreparedPublicRelease } = require("../../functions/lib/public-release-promotion");
    const { parseCloudflareToken } = require("../../scripts/bootstrap-public-deployment.cjs");
    return { firebaseAdminRuntime, assertProductionFirestoreRouting, parseCmsPublicationFirebaseServiceAccount,
      createCmsPublicationCloudStorage, sealPreparedCloudRelease, promotePreparedCloudRelease,
      checkSealedPublicRelease, handoverPreparedPublicRelease, parseCloudflareToken };
  } catch {
    throw new PreparedReleaseOperatorError("Prepared release dependencies failed to load; check the local installation before retrying");
  }
}

export async function main(args = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env) {
  let app: App | undefined;
  let runtime: typeof import("./firebase-admin-runtime")["firebaseAdminRuntime"] | undefined;
  let storage: ReturnType<typeof import("./cms-publication-cloud-storage")["createCmsPublicationCloudStorage"]> | undefined;
  try {
    const { action, queueId, commitSha, apply } = parsePreparedReleaseArguments(args);
    if (environment.CMS_DEPLOYMENT_ENVIRONMENT !== undefined && environment.CMS_DEPLOYMENT_ENVIRONMENT !== "production") {
      throw new PreparedReleaseOperatorError("The prepared release target must be production");
    }
    const { firebaseAdminRuntime, assertProductionFirestoreRouting, parseCmsPublicationFirebaseServiceAccount,
      createCmsPublicationCloudStorage, sealPreparedCloudRelease, promotePreparedCloudRelease,
      checkSealedPublicRelease, handoverPreparedPublicRelease, parseCloudflareToken } = await loadReleaseDependencies();
    runtime = firebaseAdminRuntime;
    assertProductionFirestoreRouting(environment);
    const serviceAccount = parseCmsPublicationFirebaseServiceAccount(readFileSync(3, "utf8"));
    app = firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(serviceAccount), projectId: "njpbs-site" },
      "prepared-cloud-release-operator");
    const firestore = firebaseAdminRuntime.getFirestore(app);
    let result;
    if (action === "--check") {
      const sealed = await checkSealedPublicRelease({ firestore, preparationId: queueId, commitSha });
      result = { queueId, commitSha, generation: sealed.candidate.generation, status: "fresh" };
    } else if (action === "--handover") {
      result = await handoverPreparedPublicRelease({ firestore, preparationId: queueId, commitSha });
    } else if (action === "--promote") {
      result = await promotePreparedCloudRelease({ firestore, queueId, commitSha, apply });
    } else {
      const stateDirectory = environment.CMS_PUBLICATION_RELEASE_STATE_DIRECTORY ?? "";
      if (!path.isAbsolute(stateDirectory) || !path.relative(root, stateDirectory).startsWith("..")) {
        throw new PreparedReleaseOperatorError("The prepared release state directory must be outside the checkout");
      }
      const credential = parsePreviewStorageCredential(readFileSync(4, "utf8"));
      const previewStorageCredential = parsePreviewStorageCredential(readFileSync(5, "utf8"));
      const cloudflareApiToken = parseCloudflareToken(readFileSync(6, "utf8"));
      storage = createCmsPublicationCloudStorage({ ...credential, includeRenderer: true });
      result = await sealPreparedCloudRelease({ firestore, storage, queueId, commitSha, stateDirectory,
        previewStorageCredential, cloudflareApiToken });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${preparedReleaseErrorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    storage?.close();
    if (app && runtime) await runtime.deleteApp(app).catch(() => { process.exitCode = 1; });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
