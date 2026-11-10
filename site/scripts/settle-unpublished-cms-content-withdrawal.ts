import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertCmsPublicationSourceCheckout,
  CmsPublicationRuntimeGuardError,
} from "./cms-publication-runtime-guard";
import {
  assertProductionFirestoreRouting,
  CmsPublicationSerializerOperatorError,
  parseCmsPublicationFirebaseServiceAccount,
} from "./cms-publication-credentials";
import { assertCmsPublicationSerializerLock } from "./cms-publication-lock";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";

interface SettlementIntent {
  operatorCommitSha: string;
  collection: "cmsPages" | "cmsPosts";
  recordId: string;
  sourceVersion: number;
  queueId: string;
  activeGeneration: number;
  activeBuildBatchId: string;
}

interface SettlementResult {
  outcome: "settled";
  idempotent: boolean;
  receipt: Record<string, unknown>;
}

const requireModule = createRequire(import.meta.url);
const settlementModule = requireModule(
  "../../functions/lib/cms-content-unpublished-withdrawal-settlement.js",
) as {
  CmsContentUnpublishedWithdrawalSettlementError: typeof Error;
  settleUnpublishedCmsContentWithdrawal(input: {
    firestore: Firestore;
    expected: SettlementIntent;
    serverTimestamp: () => unknown;
  }): Promise<SettlementResult>;
};

export class CmsContentUnpublishedWithdrawalSettlementOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsContentUnpublishedWithdrawalSettlementOperatorError";
  }
}

function operatorError(message: string): never {
  throw new CmsContentUnpublishedWithdrawalSettlementOperatorError(message);
}

export function parseSettlementArguments(args: string[]): SettlementIntent {
  if (
    args.length !== 8 || args[0] !== "--apply" ||
    !/^[a-f0-9]{40}$/.test(args[1] ?? "") ||
    !["cmsPages", "cmsPosts"].includes(args[2]) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args[3] ?? "") ||
    !/^[1-9]\d*$/.test(args[4] ?? "") || !Number.isSafeInteger(Number(args[4])) ||
    !/^[A-Za-z0-9]{20}$/.test(args[5] ?? "") ||
    !/^[1-9]\d*$/.test(args[6] ?? "") || !Number.isSafeInteger(Number(args[6])) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args[7] ?? "")
  ) {
    operatorError(
      "Usage: settle-unpublished-cms-content-withdrawal --apply <operator-commit> <collection> <record-id> <published-source-version> <cancelled-queue-id> <active-generation> <active-batch-id>",
    );
  }
  return Object.freeze({
    operatorCommitSha: args[1], collection: args[2] as SettlementIntent["collection"],
    recordId: args[3], sourceVersion: Number(args[4]), queueId: args[5],
    activeGeneration: Number(args[6]), activeBuildBatchId: args[7],
  });
}

async function readServiceState(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/systemctl",
      ["show", "njpbs-cms-publisher.service", "--property=ActiveState", "--value"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1_024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
  });
}

export async function runCmsContentUnpublishedWithdrawalSettlement({
  firestore, intent, readState = readServiceState,
}: {
  firestore: Firestore;
  intent: SettlementIntent;
  readState?: () => Promise<string>;
}): Promise<SettlementResult> {
  let state: string;
  try {
    state = await readState();
  } catch {
    operatorError("The publisher service state could not be verified");
  }
  if (state !== "inactive") operatorError("The publisher service must be stopped");
  return settlementModule.settleUnpublishedCmsContentWithdrawal({
    firestore, expected: intent,
    serverTimestamp: () => firebaseAdminRuntime.FieldValue.serverTimestamp(),
  });
}

async function runCommand(args: string[]): Promise<SettlementResult> {
  assertProductionFirestoreRouting(process.env);
  const intent = parseSettlementArguments(args);
  await assertCmsPublicationSourceCheckout(intent.operatorCommitSha);
  assertCmsPublicationSerializerLock(5, "/run/njpbs-cms-publisher/serializer.lock");
  const serviceAccount = parseCmsPublicationFirebaseServiceAccount(readFileSync(3, "utf8"));
  const app = firebaseAdminRuntime.initializeApp({
    credential: firebaseAdminRuntime.cert(serviceAccount), projectId: "njpbs-site",
  }, "cms-content-unpublished-withdrawal-settlement-operator");
  try {
    return await runCmsContentUnpublishedWithdrawalSettlement({
      firestore: firebaseAdminRuntime.getFirestore(app), intent,
    });
  } finally {
    await firebaseAdminRuntime.deleteApp(app);
  }
}

function controlledErrorMessage(error: unknown): string {
  return error instanceof CmsContentUnpublishedWithdrawalSettlementOperatorError ||
      error instanceof settlementModule.CmsContentUnpublishedWithdrawalSettlementError ||
      error instanceof CmsPublicationSerializerOperatorError ||
      error instanceof CmsPublicationRuntimeGuardError
    ? error.message
    : "The unpublished withdrawal settlement failed without a verified result";
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    if (args.length === 1 && args[0] === "--preflight") return;
    const result = await runCommand(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Unpublished withdrawal settlement refused: ${controlledErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) void main();
