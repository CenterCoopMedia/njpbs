import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "firebase-admin/app";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential";
import { CmsPublicationRuntimeGuardError } from "./cms-publication-runtime-guard";
import { assertProductionFirestoreRouting, parseCmsPublicationFirebaseServiceAccount } from "./cms-publication-credentials";
import { devCloudflareAccount } from "./dev-cloudflare-account.mjs";
import { expectedPublicBuildValues } from "./prepared-public-build-settings";
import { assertPreparedPublicBuildSettings } from "../../functions/lib/public-build-settings.js";

const require = createRequire(import.meta.url);
const { PreparedPublicReleaseError } = require("../../functions/lib/public-release-error");
const { publicationTarget } = require("../../functions/lib/publication-target") as typeof import("../../functions/lib/publication-target");
const root = fileURLToPath(new URL("../..", import.meta.url));
const usage = "Usage: prepared-cms-publication-cloud-release.sh --seal|--check|--handover|--promote <operation-id> <commit-sha> [--apply for promote]";
class PreparedReleaseOperatorError extends Error {}

export function preparedReleaseErrorMessage(error: unknown): string {
  return error instanceof PreparedReleaseOperatorError || error instanceof PreparedPublicReleaseError ||
    error instanceof CmsPublicationRuntimeGuardError ? (error as Error).message :
    "Prepared release refused; read the preparation, handover and live pointer before retrying";
}

/** The release runner names the target from its run record and always passes
 * it. Unset is the installed production runner; any other value refuses. */
export function preparedReleaseTarget(environment: NodeJS.ProcessEnv) {
  const target = environment.CMS_DEPLOYMENT_ENVIRONMENT;
  if (target !== undefined && target !== "production" && target !== "development") {
    throw new PreparedReleaseOperatorError("The prepared release target must be production or development");
  }
  return publicationTarget(target ?? "production");
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
    const [{ firebaseAdminRuntime }, { createCmsPublicationCloudStorage }, { sealPreparedCloudRelease, promotePreparedCloudRelease }] =
      await Promise.all([import("./firebase-admin-runtime"), import("./cms-publication-cloud-storage"), import("./prepared-cloud-release"),
    ]);
    const { checkSealedPublicRelease, handoverPreparedPublicRelease } = require("../../functions/lib/public-release-promotion");
    const { parseCloudflareToken } = require("../../scripts/bootstrap-public-deployment.cjs");
    return { firebaseAdminRuntime, createCmsPublicationCloudStorage, sealPreparedCloudRelease, promotePreparedCloudRelease,
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
    const target = preparedReleaseTarget(environment);
    // Shared release records treat an absent target as production.
    const scoped = target.environment === "development" ? { target } : {};
    assertProductionFirestoreRouting(environment);
    // The account must belong to the target project, so a mixed credential refuses before any dependency loads.
    const serviceAccount = parseCmsPublicationFirebaseServiceAccount(readFileSync(3, "utf8"), target.projectId);
    // Wrangler uploads to the active account; a development seal requires the independent development pin.
    if (action === "--seal" && target.environment === "development") {
      try { devCloudflareAccount(environment); } catch {
        throw new PreparedReleaseOperatorError("Development Cloudflare account configuration is missing or differs");
      }
    }
    const { firebaseAdminRuntime, createCmsPublicationCloudStorage, sealPreparedCloudRelease, promotePreparedCloudRelease,
      checkSealedPublicRelease, handoverPreparedPublicRelease, parseCloudflareToken } = await loadReleaseDependencies();
    runtime = firebaseAdminRuntime;
    app = firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(serviceAccount), projectId: target.projectId },
      "prepared-cloud-release-operator");
    const firestore = firebaseAdminRuntime.getFirestore(app);
    let result;
    if (action === "--check") {
      const expectedValues = expectedPublicBuildValues(commitSha, environment);
      const sealed = await checkSealedPublicRelease({ firestore, preparationId: queueId, commitSha, ...scoped });
      assertPreparedPublicBuildSettings(sealed.proof.publicBuildSettings, commitSha, expectedValues);
      result = { queueId, commitSha, generation: sealed.candidate.generation, status: "fresh" };
    } else if (action === "--handover") {
      result = await handoverPreparedPublicRelease({ firestore, preparationId: queueId, commitSha, ...scoped });
    } else if (action === "--promote") {
      result = await promotePreparedCloudRelease({ firestore, queueId, commitSha, apply, ...scoped });
    } else {
      const buildEnvironment = expectedPublicBuildValues(commitSha, environment);
      const stateDirectory = environment.CMS_PUBLICATION_RELEASE_STATE_DIRECTORY ?? "";
      if (!path.isAbsolute(stateDirectory) || !path.relative(root, stateDirectory).startsWith("..")) {
        throw new PreparedReleaseOperatorError("The prepared release state directory must be outside the checkout");
      }
      const credential = parsePreviewStorageCredential(readFileSync(4, "utf8"));
      const previewStorageCredential = parsePreviewStorageCredential(readFileSync(5, "utf8"));
      const cloudflareApiToken = parseCloudflareToken(readFileSync(6, "utf8"));
      storage = createCmsPublicationCloudStorage({ ...credential, includeRenderer: true, target });
      result = await sealPreparedCloudRelease({ firestore, storage, queueId, commitSha, stateDirectory,
        previewStorageCredential, cloudflareApiToken, ...scoped,
        buildEnvironment: { ...buildEnvironment, ...(target.environment === "development" ? { CMS_DEPLOYMENT_ENVIRONMENT: target.environment } : {}) } });
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
