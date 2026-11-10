import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App, ServiceAccount } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertCmsPublicationSourceCheckout,
  assertCmsPublicationSourceAncestor,
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
  "../../functions/lib/cms-publication-content-claimed-cancellation.js",
) as {
  CmsPublicationContentClaimedCancellationError: typeof Error;
  cancelClaimedCmsPublicationContent(input: {
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
  CmsPublicationContentClaimedCancellationError,
} = cancellationModule;
const cancelClaimedCmsPublicationContent: CancelQueue = (input) =>
  cancellationModule.cancelClaimedCmsPublicationContent({
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
  journalPath: string;
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
  readServiceState(): Promise<string>;
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

export class CmsPublicationContentClaimedCancellationOperatorError
  extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationContentClaimedCancellationOperatorError";
  }
}

function operatorError(message: string): never {
  throw new CmsPublicationContentClaimedCancellationOperatorError(message);
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
    operatorError("The claimed CMS publication content was not cancelled");
  }
}

export async function runCmsPublicationContentClaimedCancellation({
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
      "The claimed CMS publication content cancellation input is invalid",
    );
  }
  const dependencies: CancellationDependencies = {
    cancelQueue: cancelClaimedCmsPublicationContent,
    readServiceState,
    ...dependencyOverrides,
  };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    operatorError(
      "The claimed CMS publication content cancellation dependencies are invalid",
    );
  }

  await assertPublisherStopped(dependencies.readServiceState);
  if (journal.journalPath !== intent.journalPath) {
    operatorError("The CMS publication journal path conflicts");
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
      "The claimed CMS publication content cancellation was not persisted",
    );
  }

  return Object.freeze({
    outcome: "cancelled",
    idempotent:
      queueResult.idempotent && journalIdempotent && finalResult.idempotent,
    queueId: intent.queueId,
    buildBatchId: intent.buildBatchId,
    generation: finalResult.receipt.generation,
    receipt: finalResult.receipt,
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
    args.length !== 7 ||
    args[0] !== "--apply" ||
    !COMMIT_SHA.test(args[1] ?? "") ||
    !QUEUE_ID.test(args[2] ?? "") ||
    args[3] !== `cms-${args[2]}` ||
    !SERIALIZER_ID.test(args[4] ?? "") ||
    !COMMIT_SHA.test(args[5] ?? "") ||
    args[1] === args[5] ||
    !path.isAbsolute(args[6] ?? "") ||
    path.normalize(args[6]) !== args[6] ||
    path.basename(args[6]) !== "claim-journal.json"
  ) {
    operatorError(
      "Usage: cancel-claimed-cms-publication-content --apply <operator-commit> <queue-id> <batch-id> <serializer-id> <source-commit> <claim-journal-path>",
    );
  }
  return Object.freeze({
    operatorCommitSha: args[1],
    queueId: args[2],
    buildBatchId: args[3],
    serializerId: args[4],
    queueCommitSha: args[5],
    journalPath: args[6],
  });
}

async function readServiceState(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/systemctl",
      ["show", "njpbs-cms-publisher.service", "--property=ActiveState", "--value"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1_024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

async function assertPublisherStopped(
  readState: () => Promise<string>,
): Promise<void> {
  let state: string;
  try {
    state = await readState();
  } catch {
    operatorError("The publisher service state could not be verified");
  }
  if (state !== "inactive") {
    operatorError("The publisher service must be stopped");
  }
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
    "cms-publication-content-claimed-cancellation-operator",
  ),
  firestoreFor: firebaseAdminRuntime.getFirestore,
  openJournal: async (input) => {
    // Refuse an absent journal; opening must not create a replacement token file.
    await lstat(path.join(input.stateDirectory, "claim-journal.json"));
    return openCmsPublicationTokenJournal(input);
  },
  deleteFirebase: firebaseAdminRuntime.deleteApp,
  cancelQueue: cancelClaimedCmsPublicationContent,
  readServiceState,
};

function resolveCommandDependencies(
  overrides: Partial<CommandDependencies> | undefined,
): CommandDependencies {
  const dependencies = { ...defaultCommandDependencies, ...overrides };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    operatorError(
      "The claimed CMS publication content command dependencies are invalid",
    );
  }
  return dependencies;
}

export async function runCmsPublicationContentClaimedCancellationCommand(
  args: string[],
  dependencyOverrides?: Partial<CommandDependencies>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  assertProductionFirestoreRouting(environment);
  const intent = parseCancellationArguments(args);
  const dependencies = resolveCommandDependencies(dependencyOverrides);
  await assertCmsPublicationSourceCheckout(intent.operatorCommitSha);
  await assertCmsPublicationSourceAncestor(
    intent.queueCommitSha,
    intent.operatorCommitSha,
  );
  if (intent.journalPath !== path.join(STATE_DIRECTORY, "claim-journal.json")) {
    operatorError("The claim journal path is not the publisher state path");
  }
  await assertPublisherStopped(dependencies.readServiceState);
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
    return await runCmsPublicationContentClaimedCancellation({
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
      CmsPublicationContentClaimedCancellationOperatorError ||
      error instanceof CmsPublicationContentClaimedCancellationError ||
      error instanceof CmsPublicationSerializerOperatorError ||
      error instanceof CmsPublicationRuntimeGuardError ||
      error instanceof CmsPublicationTokenJournalError
    ? error.message
    : "The claimed CMS publication content cancellation failed without a verified result";
}

export async function main(
  args = process.argv.slice(2),
  dependencyOverrides?: Partial<CommandDependencies>,
): Promise<void> {
  try {
    if (args.length === 1 && args[0] === "--preflight") return;
    const result =
      await runCmsPublicationContentClaimedCancellationCommand(
        args,
        dependencyOverrides,
      );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `Claimed publication content cancellation refused: ${controlledErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
