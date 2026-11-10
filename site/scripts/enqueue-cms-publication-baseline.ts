import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App, ServiceAccount } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertCmsPublicationSourceCheckout,
  CmsPublicationRuntimeGuardError,
} from "./cms-publication-runtime-guard";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";

const requireModule = createRequire(import.meta.url);
const bootstrapModule = requireModule(
  "../../scripts/bootstrap-public-deployment.cjs",
) as {
  parseFirebaseServiceAccount(value: string): ServiceAccount;
};
const baselineModule = requireModule(
  "../../functions/lib/cms-publication-baseline.js",
) as {
  CmsPublicationBaselineError: typeof Error;
  enqueueCmsPublicationBaseline(input: {
    firestore: Firestore;
    queueId: string;
    commitSha: string;
    returnPostId?: string;
  }): Promise<BaselineResult>;
};

const { parseFirebaseServiceAccount } = bootstrapModule;
const { CmsPublicationBaselineError, enqueueCmsPublicationBaseline } =
  baselineModule;
interface RecoveryPredecessor {
  activeGeneration: number;
  lastReservedGeneration: number;
  activeDeploymentId: string;
  activeCommitSha: string;
}
const { assertRecoveryInput, recoverCmsPublicationBaseline } = requireModule(
  "../../functions/lib/cms-publication-baseline-recovery.js",
) as {
  assertRecoveryInput(input: {
    queueId: string;
    commitSha: string;
    expected: RecoveryPredecessor;
  }): void;
  recoverCmsPublicationBaseline(input: {
    firestore: Firestore;
    queueId: string;
    commitSha: string;
    expected: RecoveryPredecessor;
  }): Promise<BaselineResult>;
};
export const cmsPublicationBaselineRuntime = Object.freeze({
  cert: firebaseAdminRuntime.cert,
  deleteApp: firebaseAdminRuntime.deleteApp,
  enqueueCmsPublicationBaseline,
  getFirestore: firebaseAdminRuntime.getFirestore,
  initializeApp: firebaseAdminRuntime.initializeApp,
  recoverCmsPublicationBaseline,
});
const FIREBASE_PROJECT_ID = "njpbs-site";
const FIREBASE_CREDENTIAL_FD = 3;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

interface BaselineResult {
  success: true;
  queueId: string;
  status: string;
  transport: "serializer";
  idempotent: boolean;
}

export class CmsPublicationBaselineOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationBaselineOperatorError";
  }
}

function operatorError(message: string): never {
  throw new CmsPublicationBaselineOperatorError(message);
}

export function parseApplyArguments(args: string[]): {
  queueId: string;
  commitSha: string;
  expected?: RecoveryPredecessor;
  returnPostId?: string;
} {
  if (args.length === 7 && args[0] === "--apply-recovery") {
    if (!/^[1-9][0-9]*$/.test(args[3]) || !/^[1-9][0-9]*$/.test(args[4])) {
      operatorError("The baseline recovery generations are invalid");
    }
    const input = {
      queueId: args[1],
      commitSha: args[2],
      expected: {
        activeGeneration: Number(args[3]),
        lastReservedGeneration: Number(args[4]),
        activeDeploymentId: args[5],
        activeCommitSha: args[6],
      },
    };
    assertRecoveryInput(input);
    return input;
  }
  if (
    ![3, 5].includes(args.length) ||
    (args.length === 5 && (args[3] !== "--return-post-to-static" || !/^[A-Za-z0-9_-]{1,128}$/.test(args[4] ?? ""))) ||
    args[0] !== "--apply" ||
    !QUEUE_ID.test(args[1] ?? "") ||
    !COMMIT_SHA.test(args[2] ?? "")
  ) {
    operatorError(
      "Retained baseline arguments: --apply <20-character-queue-id> <40-character-commit-sha> [--return-post-to-static <post-id>]",
    );
  }
  return { queueId: args[1], commitSha: args[2], ...(args.length === 5 ? { returnPostId: args[4] } : {}) };
}

export function assertProductionFirestoreRouting(
  environment: NodeJS.ProcessEnv,
): void {
  if (Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST")) {
    operatorError("The Firestore emulator route is not allowed");
  }
}

export function projectOperatorResult(result: BaselineResult) {
  if (
    result?.success !== true ||
    !QUEUE_ID.test(result.queueId ?? "") ||
    result.transport !== "serializer" ||
    typeof result.status !== "string" ||
    typeof result.idempotent !== "boolean"
  ) {
    operatorError("The CMS publication baseline result is invalid");
  }
  return {
    queueId: result.queueId,
    status: result.status,
    transport: result.transport,
    idempotent: result.idempotent,
  };
}

function controlledErrorMessage(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "serializer_publication_unavailable") {
    return "New baselines are disabled after the serializer handoff";
  }
  if (error instanceof Error && "code" in error && error.code === "serializer_publication_control_invalid") {
    return "Baseline publication control is unavailable";
  }
  return error instanceof CmsPublicationBaselineOperatorError ||
    error instanceof CmsPublicationRuntimeGuardError ||
    error instanceof CmsPublicationBaselineError
    ? error.message
    : "The CMS publication baseline failed without a verified result";
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let app: App | undefined;
  try {
    assertProductionFirestoreRouting(process.env);
    const { queueId, commitSha, expected, returnPostId } = parseApplyArguments(args);
    await assertCmsPublicationSourceCheckout(commitSha);
    const serviceAccount = parseFirebaseServiceAccount(
      readFileSync(FIREBASE_CREDENTIAL_FD, "utf8"),
    );
    app = cmsPublicationBaselineRuntime.initializeApp(
      {
        credential: cmsPublicationBaselineRuntime.cert(serviceAccount),
        projectId: FIREBASE_PROJECT_ID,
      },
      "cms-publication-baseline-operator",
    );
    const input = {
      firestore: cmsPublicationBaselineRuntime.getFirestore(app),
      queueId,
      commitSha,
      ...(returnPostId === undefined ? {} : { returnPostId }),
    };
    const result = expected
      ? await cmsPublicationBaselineRuntime.recoverCmsPublicationBaseline({
          ...input,
          expected,
        })
      : await cmsPublicationBaselineRuntime.enqueueCmsPublicationBaseline(
          input,
        );
    process.stdout.write(`${JSON.stringify(projectOperatorResult(result))}\n`);
  } catch (error) {
    process.stderr.write(
      `Publication baseline refused: ${controlledErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (app)
      await cmsPublicationBaselineRuntime.deleteApp(app).catch(() => {
        process.exitCode = 1;
      });
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
