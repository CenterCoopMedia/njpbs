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
import {
  assertCmsPublicationSerializerLock,
  CmsPublicationSerializerOperatorError,
  parseCmsPublicationFirebaseServiceAccount,
} from "./cms-publication-inputs";
import {
  CmsPublicationTokenJournalError,
  openCmsPublicationTokenJournal,
  type CmsPublicationJournalJob,
  type CmsPublicationTokenJournal,
} from "./cms-publication-token-journal";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";

const requireModule = createRequire(import.meta.url);
const cancellationModule = requireModule(
  "../../functions/lib/cms-publication-baseline-unclaimed-cancellation.js",
) as {
  CmsPublicationBaselineUnclaimedCancellationError: typeof Error;
  cancelUnclaimedCmsPublicationBaseline(input: {
    firestore: Firestore;
    expected: CancellationExpectation;
    serverTimestamp: () => unknown;
  }): Promise<CancellationResult>;
};
const serializerModule = requireModule(
  "../../functions/lib/cms-publication-serializer.js",
) as {
  cmsPublicationSerializerTokenDigest(claimToken: string): string;
};

const {
  CmsPublicationBaselineUnclaimedCancellationError,
} = cancellationModule;
const cancelUnclaimedCmsPublicationBaseline: CancelQueue = (input) =>
  cancellationModule.cancelUnclaimedCmsPublicationBaseline({
    ...input,
    serverTimestamp: () => firebaseAdminRuntime.FieldValue.serverTimestamp(),
  });
const { cmsPublicationSerializerTokenDigest } = serializerModule;

const FIREBASE_PROJECT_ID = "njpbs-site";
const STATE_DIRECTORY = "/var/lib/njpbs-cms-publisher";
const LOCK_PATH = "/run/njpbs-cms-publisher/serializer.lock";
const FIREBASE_CREDENTIAL_FD = 3;
const LOCK_FD = 5;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

interface CancellationIntent {
  operatorCommitSha: string;
  queueId: string;
  buildBatchId: string;
  queueCommitSha: string;
  serializerId: string;
}

interface CancellationExpectation extends CancellationIntent {
  claimTokenDigest: string | null;
}

interface CancellationResult {
  outcome: "cancelled";
  idempotent: boolean;
  receipt: Record<string, unknown>;
}

type CancelQueue = (input: {
  firestore: Firestore;
  expected: CancellationExpectation;
}) => Promise<CancellationResult>;

interface CancellationDependencies {
  cancelQueue: CancelQueue;
}

interface CommandDependencies extends CancellationDependencies {
  readCredential(fd: number): string;
  assertLock(fd: number, lockPath: string): void;
  initializeFirebase(serviceAccount: ServiceAccount): App;
  firestoreFor(app: App): Firestore;
  openJournal(input: {
    stateDirectory: string;
    serializerId: string;
  }): Promise<CmsPublicationTokenJournal>;
  deleteFirebase(app: App): Promise<void>;
}

export class CmsPublicationBaselineUnclaimedCancellationOperatorError
  extends Error {
  constructor(message: string) {
    super(message);
    this.name =
      "CmsPublicationBaselineUnclaimedCancellationOperatorError";
  }
}

function operatorError(message: string): never {
  throw new CmsPublicationBaselineUnclaimedCancellationOperatorError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateJournalJob(
  job: CmsPublicationJournalJob,
  intent: CancellationIntent,
): void {
  if (
    job.queueId !== intent.queueId ||
    job.buildBatchId !== intent.buildBatchId ||
    job.commitSha !== intent.queueCommitSha
  ) {
    operatorError("The CMS publication token journal belongs to another job");
  }
}

function expectation(
  intent: CancellationIntent,
  job: CmsPublicationJournalJob | null,
): CancellationExpectation {
  if (job) validateJournalJob(job, intent);
  return {
    ...intent,
    claimTokenDigest: job
      ? cmsPublicationSerializerTokenDigest(job.claimToken)
      : null,
  };
}

function assertCancellationResult(
  result: CancellationResult,
  expected: CancellationIntent,
): void {
  if (
    result.outcome !== "cancelled" ||
    typeof result.idempotent !== "boolean" ||
    !plainObject(result.receipt) ||
    result.receipt.queueId !== expected.queueId ||
    result.receipt.buildBatchId !== expected.buildBatchId ||
    result.receipt.queueCommitSha !== expected.queueCommitSha ||
    result.receipt.operatorCommitSha !== expected.operatorCommitSha ||
    result.receipt.serializerId !== expected.serializerId
  ) {
    operatorError("The unclaimed CMS publication baseline was not cancelled");
  }
}

export async function runCmsPublicationBaselineUnclaimedCancellation({
  firestore,
  journal,
  intent,
  dependencies: dependencyOverrides,
}: {
  firestore: Firestore;
  journal: CmsPublicationTokenJournal;
  intent: CancellationIntent;
  dependencies?: Partial<CancellationDependencies>;
}): Promise<Record<string, unknown>> {
  if (!firestore || !journal || typeof journal.read !== "function") {
    operatorError(
      "The unclaimed CMS publication baseline cancellation input is invalid",
    );
  }
  const dependencies: CancellationDependencies = {
    cancelQueue: cancelUnclaimedCmsPublicationBaseline,
    ...dependencyOverrides,
  };
  if (typeof dependencies.cancelQueue !== "function") {
    operatorError(
      "The unclaimed CMS publication baseline cancellation dependencies are invalid",
    );
  }

  const journalJob = await journal.read();
  const expected = expectation(intent, journalJob);
  const queueResult = await dependencies.cancelQueue({ firestore, expected });
  assertCancellationResult(queueResult, intent);

  let journalIdempotent = true;
  if (journalJob) {
    const clear = await journal.clear({
      queueId: journalJob.queueId,
      claimToken: journalJob.claimToken,
    });
    journalIdempotent = clear.idempotent;
  }
  if (await journal.read() !== null) {
    operatorError("The CMS publication token journal was not cleared");
  }

  const finalResult = await dependencies.cancelQueue({
    firestore,
    expected: expectation(intent, null),
  });
  assertCancellationResult(finalResult, intent);
  if (!finalResult.idempotent) {
    operatorError(
      "The unclaimed CMS publication baseline cancellation was not persisted",
    );
  }

  return Object.freeze({
    outcome: "cancelled",
    idempotent:
      queueResult.idempotent && journalIdempotent && finalResult.idempotent,
    queueId: intent.queueId,
    buildBatchId: intent.buildBatchId,
    queueCommitSha: intent.queueCommitSha,
    operatorCommitSha: intent.operatorCommitSha,
    serializerId: intent.serializerId,
    queueIdempotent: queueResult.idempotent,
    journalIdempotent,
  });
}

export function parseCancellationArguments(
  args: string[],
): CancellationIntent {
  if (
    args.length !== 5 ||
    args[0] !== "--apply" ||
    !COMMIT_SHA.test(args[1] ?? "") ||
    !QUEUE_ID.test(args[2] ?? "") ||
    !COMMIT_SHA.test(args[3] ?? "") ||
    args[1] === args[3] ||
    !SERIALIZER_ID.test(args[4] ?? "")
  ) {
    operatorError(
      "Usage: cancel-unclaimed-cms-publication-baseline --apply <operator-commit> <queue-id> <old-queue-commit> <serializer-id>",
    );
  }
  return Object.freeze({
    operatorCommitSha: args[1],
    queueId: args[2],
    buildBatchId: `cms-${args[2]}`,
    queueCommitSha: args[3],
    serializerId: args[4],
  });
}

export function assertProductionFirestoreRouting(
  environment: NodeJS.ProcessEnv,
): void {
  if (Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST")) {
    operatorError("The Firestore emulator route is not allowed");
  }
}

const defaultCommandDependencies: CommandDependencies = {
  readCredential: (fd) => readFileSync(fd, "utf8"),
  assertLock: assertCmsPublicationSerializerLock,
  initializeFirebase: (serviceAccount) => firebaseAdminRuntime.initializeApp(
    {
      credential: firebaseAdminRuntime.cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID,
    },
    "cms-publication-baseline-unclaimed-cancellation-operator",
  ),
  firestoreFor: firebaseAdminRuntime.getFirestore,
  openJournal: openCmsPublicationTokenJournal,
  deleteFirebase: firebaseAdminRuntime.deleteApp,
  cancelQueue: cancelUnclaimedCmsPublicationBaseline,
};

function resolveCommandDependencies(
  overrides: Partial<CommandDependencies> | undefined,
): CommandDependencies {
  const dependencies = { ...defaultCommandDependencies, ...overrides };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    operatorError(
      "The unclaimed CMS publication baseline command dependencies are invalid",
    );
  }
  return dependencies;
}

export async function runCmsPublicationBaselineUnclaimedCancellationCommand(
  args: string[],
  dependencyOverrides?: Partial<CommandDependencies>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  assertProductionFirestoreRouting(environment);
  const intent = parseCancellationArguments(args);
  const dependencies = resolveCommandDependencies(dependencyOverrides);
  await assertCmsPublicationSourceCheckout(intent.operatorCommitSha);
  dependencies.assertLock(LOCK_FD, LOCK_PATH);
  const serviceAccount = parseCmsPublicationFirebaseServiceAccount(
    dependencies.readCredential(FIREBASE_CREDENTIAL_FD),
  );
  let app: App | undefined;
  try {
    app = dependencies.initializeFirebase(serviceAccount);
    const firestore = dependencies.firestoreFor(app);
    const journal = await dependencies.openJournal({
      stateDirectory: STATE_DIRECTORY,
      serializerId: intent.serializerId,
    });
    return await runCmsPublicationBaselineUnclaimedCancellation({
      firestore,
      journal,
      intent,
      dependencies,
    });
  } finally {
    if (app) await dependencies.deleteFirebase(app);
  }
}

function controlledErrorMessage(error: unknown): string {
  return error instanceof
      CmsPublicationBaselineUnclaimedCancellationOperatorError ||
      error instanceof CmsPublicationBaselineUnclaimedCancellationError ||
      error instanceof CmsPublicationSerializerOperatorError ||
      error instanceof CmsPublicationRuntimeGuardError ||
      error instanceof CmsPublicationTokenJournalError
    ? error.message
    : "The unclaimed CMS publication baseline cancellation failed without a verified result";
}

export async function main(
  args = process.argv.slice(2),
  dependencyOverrides?: Partial<CommandDependencies>,
): Promise<void> {
  try {
    if (args.length === 1 && args[0] === "--preflight") return;
    const result =
      await runCmsPublicationBaselineUnclaimedCancellationCommand(
        args,
        dependencyOverrides,
      );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `Unclaimed publication baseline cancellation refused: ${controlledErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
