import { CloudflareConfigurationError, cloudflarePublicZone, cloudflarePublicWorkerTag } from "./cloudflare-account.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import type { App, ServiceAccount } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertPreparedPublicWorkerArtifact,
  MAX_PUBLICATION_RECEIPT_BYTES,
  publicPublicationReceiptMatchesPreparedArtifact,
  type PreparedPublicWorkerArtifact,
} from "../src/lib/public-worker-artifact";
import {
  canonicalPublicationReceipt,
} from "../src/lib/public-publication-receipt";
import {
  activeDeployment,
  assertPublicWorkerIdentity,
  assertUploadOnlyProductionTrigger,
  PublicWorkerActivationOperatorError,
  PUBLIC_WORKER_NAME,
  requestCloudflareJson,
  workerApiPath,
} from "./activate-public-worker-candidate";
import {
  assertCmsPublicationSerializerLock,
  CmsPublicationSerializerOperatorError,
  parseCmsPublicationCloudflareToken,
  parseCmsPublicationFirebaseServiceAccount,
} from "./cms-publication-inputs";
import {
  assertCmsPublicationSourceCheckout,
  CmsPublicationRuntimeGuardError,
} from "./cms-publication-runtime-guard";
import {
  CmsPublicationTokenJournalError,
  openCmsPublicationTokenJournal,
  type CmsPublicationJournalJob,
  type CmsPublicationTokenJournal,
} from "./cms-publication-token-journal";

const requireModule = createRequire(import.meta.url);
const requireFunctionsModule = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const {
  cert,
  deleteApp,
  initializeApp,
} = requireFunctionsModule(
  "firebase-admin/app",
) as typeof import("firebase-admin/app");
const {
  FieldValue,
  getFirestore,
} = requireFunctionsModule(
  "firebase-admin/firestore",
) as typeof import("firebase-admin/firestore");
const retirementModule = requireModule(
  "../../functions/lib/cms-publication-baseline-retirement.js",
) as {
  CmsPublicationBaselineRetirementError: typeof Error;
  readCmsPublicationBaselineRetirementState(input: {
    firestore: Firestore;
    expected: RetirementExpectation;
  }): Promise<RetirementState>;
  retireCmsPublicationBaseline(input: {
    firestore: Firestore;
    expected: RetirementExpectation;
    serverTimestamp: () => unknown;
  }): Promise<RetirementResult>;
};
const serializerModule = requireModule(
  "../../functions/lib/cms-publication-serializer.js",
) as {
  cmsPublicationSerializerTokenDigest(claimToken: string): string;
};
const activationEvidenceModule = requireModule(
  "../../functions/lib/public-worker-activation.js",
) as {
  planPublicWorkerActivationEvidence(input: {
    lease: PublicDeploymentLease;
    candidate: PublicWorkerCandidate;
    deploymentStatus: unknown;
    deploymentSource: "api";
  }): ActivationEvidence;
};
const outcomeStoreModule = requireModule(
  "../../functions/lib/public-deployment-outcome-store.js",
) as {
  settlePublicDeploymentOutcome(input: {
    firestore: Firestore;
    lease: PublicDeploymentLease;
    evidence: ActivationEvidence;
  }): Promise<DeploymentResult>;
};
const publicDeploymentModule = requireModule(
  "../../functions/lib/public-deployment.js",
) as {
  PublicDeploymentStateError: typeof Error;
};

const {
  CmsPublicationBaselineRetirementError,
  readCmsPublicationBaselineRetirementState,
} = retirementModule;
const retireCmsPublicationBaseline: RetireQueue = (input) =>
  retirementModule.retireCmsPublicationBaseline({
    ...input,
    serverTimestamp: () => FieldValue.serverTimestamp(),
  });
const { cmsPublicationSerializerTokenDigest } = serializerModule;
const { planPublicWorkerActivationEvidence } = activationEvidenceModule;
const { settlePublicDeploymentOutcome } = outcomeStoreModule;
const { PublicDeploymentStateError } = publicDeploymentModule;

const FIREBASE_PROJECT_ID = "njpbs-site";
const STATE_DIRECTORY = "/var/lib/njpbs-cms-publisher";
const LOCK_PATH = "/run/njpbs-cms-publisher/serializer.lock";
const WORKER_CREDENTIAL_FD = 3;
const FIREBASE_CREDENTIAL_FD = 4;
const LOCK_FD = 5;
const ROUTE_CREDENTIAL_FD = 6;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_APEX_RESPONSE_BYTES = MAX_PUBLICATION_RECEIPT_BYTES;
const MAX_ROUTE_PATTERN_BYTES = 2_048;
const MAX_CUSTOM_DOMAIN_HOSTNAME_BYTES = 253;
const MAX_CUSTOM_DOMAIN_ROWS = 100;

interface RetirementIntent {
  operatorCommitSha: string;
  queueId: string;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  deploymentId: string;
  versionId: string;
  serializerId: string;
}

interface RetirementExpectation extends Omit<RetirementIntent, "operatorCommitSha"> {
  claimTokenDigest: string | null;
}

interface PublicDeploymentLease {
  schemaVersion: 1;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  leaseToken: string;
  leaseAcquiredAt: unknown;
  predecessorGeneration: number;
  predecessorDeploymentId: string | null;
  predecessorCommitSha: string | null;
}

interface PublicWorkerCandidate {
  schemaVersion: 1;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  workerVersionId: string;
  artifactDigest: string;
  artifactReceiptDigest: string;
  publicationReceiptDigest: string;
  mediaManifestDigest: string;
  artifactFileCount: number;
  artifactBytes: number;
  [field: string]: unknown;
}

interface RetirementState {
  phase: "reconciling" | "deployed";
  lease: PublicDeploymentLease;
  candidate: PublicWorkerCandidate;
  queue: {
    queue: { status: "publishing" | "cancelled" };
    receipt: Record<string, unknown> | null;
  };
}

type ActivationEvidence =
  | { action: "reconcile" }
  | {
      action: "activate";
      buildBatchId: string;
      deploymentId: string;
      versionId: string;
      commitSha: string;
    };

interface DeploymentResult {
  outcome: "deployed" | "reconciling";
  idempotent: boolean;
  receipt?: Record<string, unknown>;
}

interface RetirementResult {
  outcome: "cancelled";
  idempotent: boolean;
  receipt: Record<string, unknown>;
}

interface ApexReceipt {
  body: string;
  publicationOrigin: string | null;
}

interface CloudflareRequest {
  url: string;
  method: "GET" | "POST";
  token: string;
  body?: unknown;
}

type RequestJson = (request: CloudflareRequest) => Promise<unknown>;
type RequestApex = (url: string) => Promise<ApexReceipt>;
type ReadState = (input: {
  firestore: Firestore;
  expected: RetirementExpectation;
}) => Promise<RetirementState>;
type SettleOutcome = (input: {
  firestore: Firestore;
  lease: PublicDeploymentLease;
  evidence: ActivationEvidence;
}) => Promise<DeploymentResult>;
type RetireQueue = (input: {
  firestore: Firestore;
  expected: RetirementExpectation;
}) => Promise<RetirementResult>;

interface RetirementDependencies {
  requestJson: RequestJson;
  requestApex: RequestApex;
  readState: ReadState;
  settleOutcome: SettleOutcome;
  retireQueue: RetireQueue;
}

interface CommandDependencies extends RetirementDependencies {
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

export class CmsPublicationBaselineRetirementOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationBaselineRetirementOperatorError";
  }
}

function operatorError(message: string): never {
  throw new CmsPublicationBaselineRetirementOperatorError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function routePatternMatches(pattern: string, url: string): boolean {
  const normalized = pattern.includes("://") ? pattern : `https://${pattern}`;
  const expression = normalized
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${expression}$`, "i").test(url);
}

export function assertNoApexWildcardRoute(response: unknown): void {
  if (
    !plainObject(response) ||
    response.success !== true ||
    !Array.isArray(response.result)
  ) {
    operatorError("The Cloudflare route response is invalid");
  }
  for (const route of response.result) {
    if (
      !plainObject(route) ||
      typeof route.pattern !== "string" ||
      route.pattern.length < 1 ||
      Buffer.byteLength(route.pattern, "utf8") > MAX_ROUTE_PATTERN_BYTES
    ) {
      operatorError("The Cloudflare route response is invalid");
    }
    if (
      routePatternMatches(route.pattern, "https://njpbs.org/") &&
      routePatternMatches(
        route.pattern,
        "https://njpbs.org/_baseline-retirement-guard",
      )
    ) {
      operatorError("The full apex Worker route is already active");
    }
  }
}

export function assertNoApexCustomDomain(response: unknown): void {
  if (
    !plainObject(response) ||
    response.success !== true ||
    !Array.isArray(response.result) ||
    !plainObject(response.result_info)
  ) {
    operatorError("The Cloudflare custom-domain response is invalid");
  }
  const {
    count,
    page,
    per_page: perPage,
    total_count: totalCount,
    total_pages: totalPages,
  } = response.result_info;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_CUSTOM_DOMAIN_ROWS ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page !== 1 ||
    typeof totalCount !== "number" ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    count !== response.result.length ||
    totalCount !== count ||
    (perPage !== undefined && perPage !== null &&
      (typeof perPage !== "number" ||
        !Number.isSafeInteger(perPage) ||
        perPage < count)) ||
    (totalPages !== undefined && totalPages !== null &&
      (typeof totalPages !== "number" ||
        !Number.isSafeInteger(totalPages) ||
        totalPages !== 1))
  ) {
    operatorError("The Cloudflare custom-domain list is incomplete");
  }
  for (const domain of response.result) {
    if (
      !plainObject(domain) ||
      typeof domain.hostname !== "string" ||
      domain.hostname.length < 1 ||
      domain.hostname.trim() !== domain.hostname ||
      Buffer.byteLength(domain.hostname, "utf8") >
        MAX_CUSTOM_DOMAIN_HOSTNAME_BYTES
    ) {
      operatorError("The Cloudflare custom-domain response is invalid");
    }
    if (domain.hostname.toLowerCase() === "njpbs.org") {
      operatorError("The apex Worker custom domain is already active");
    }
  }
}

function preparedFromCandidate(
  candidate: PublicWorkerCandidate,
): PreparedPublicWorkerArtifact {
  return assertPreparedPublicWorkerArtifact({
    schemaVersion: candidate.schemaVersion,
    digestAlgorithm: "sha256",
    buildBatchId: candidate.buildBatchId,
    generation: candidate.generation,
    commitSha: candidate.commitSha,
    artifactDigest: candidate.artifactDigest,
    artifactReceiptDigest: candidate.artifactReceiptDigest,
    publicationReceiptDigest: candidate.publicationReceiptDigest,
    mediaManifestDigest: candidate.mediaManifestDigest,
    artifactFileCount: candidate.artifactFileCount,
    artifactBytes: candidate.artifactBytes,
  });
}

export function assertApexDoesNotServeCandidate(
  receipt: ApexReceipt,
  candidate: PublicWorkerCandidate,
): void {
  let canonicalBody: string;
  try {
    const canonical = canonicalPublicationReceipt(JSON.parse(receipt.body));
    canonicalBody = `${JSON.stringify(canonical, null, 2)}\n`;
  } catch {
    operatorError("The apex publication receipt response is invalid");
  }
  if (
    !plainObject(receipt) ||
    typeof receipt.body !== "string" ||
    receipt.publicationOrigin !== null ||
    Buffer.byteLength(receipt.body, "utf8") > MAX_APEX_RESPONSE_BYTES ||
    publicPublicationReceiptMatchesPreparedArtifact(
      canonicalBody,
      preparedFromCandidate(candidate),
    )
  ) {
    operatorError("The exact Worker candidate is already public at the apex");
  }
}

export async function requestApexPublicationReceipt(
  url: string,
): Promise<ApexReceipt> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    operatorError("The apex publication receipt request did not complete");
  }
  if (
    !response.ok ||
    !response.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) {
    operatorError("The apex publication receipt response is invalid");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_APEX_RESPONSE_BYTES) {
    operatorError("The apex publication receipt response is invalid");
  }
  return {
    body,
    publicationOrigin: response.headers.get("x-njpbs-publication-origin"),
  };
}

function zoneApiPath(suffix: string): string {
  return `https://api.cloudflare.com/client/v4/zones/${cloudflarePublicZone()}${suffix}`;
}

function assertExactEvidence(
  evidence: ActivationEvidence,
  expected: RetirementIntent,
): asserts evidence is Extract<ActivationEvidence, { action: "activate" }> {
  if (
    evidence.action !== "activate" ||
    evidence.buildBatchId !== expected.buildBatchId ||
    evidence.deploymentId !== expected.deploymentId ||
    evidence.versionId !== expected.versionId ||
    evidence.commitSha !== expected.commitSha
  ) {
    operatorError("The active Cloudflare deployment is not the retirement target");
  }
}

async function observeProvider({
  expected,
  state,
  workerApiToken,
  routeApiToken,
  requestJson,
}: {
  expected: RetirementIntent;
  state: RetirementState;
  workerApiToken: string;
  routeApiToken: string;
  requestJson: RequestJson;
}): Promise<Extract<ActivationEvidence, { action: "activate" }>> {
  cloudflarePublicWorkerTag();
  const routesUrl = zoneApiPath("/workers/routes");
  const workerResponse = await requestJson({
    url: workerApiPath("/workers/scripts"),
    method: "GET",
    token: workerApiToken,
  });
  const workerTag = assertPublicWorkerIdentity(workerResponse);
  const triggerResponse = await requestJson({
    url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
    method: "GET",
    token: workerApiToken,
  });
  assertUploadOnlyProductionTrigger(triggerResponse, workerTag);
  const customDomainResponse = await requestJson({
    url: workerApiPath("/workers/domains"),
    method: "GET",
    token: workerApiToken,
  });
  assertNoApexCustomDomain(customDomainResponse);
  const routeResponse = await requestJson({
    url: routesUrl,
    method: "GET",
    token: routeApiToken,
  });
  assertNoApexWildcardRoute(routeResponse);
  const deploymentsResponse = await requestJson({
    url: workerApiPath(`/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`),
    method: "GET",
    token: workerApiToken,
  });
  const evidence = planPublicWorkerActivationEvidence({
    lease: state.lease,
    candidate: state.candidate,
    deploymentStatus: activeDeployment(deploymentsResponse),
    deploymentSource: "api",
  });
  assertExactEvidence(evidence, expected);
  return evidence;
}

function validateJournalJob(
  job: CmsPublicationJournalJob,
  expected: RetirementIntent,
): void {
  if (
    job.queueId !== expected.queueId ||
    job.buildBatchId !== expected.buildBatchId ||
    job.commitSha !== expected.commitSha
  ) {
    operatorError("The CMS publication token journal belongs to another job");
  }
}

function expectation(
  intent: RetirementIntent,
  job: CmsPublicationJournalJob | null,
): RetirementExpectation {
  if (job) validateJournalJob(job, intent);
  const { operatorCommitSha: _operatorCommitSha, ...target } = intent;
  return {
    ...target,
    claimTokenDigest: job
      ? cmsPublicationSerializerTokenDigest(job.claimToken)
      : null,
  };
}

function assertDeploymentResult(
  result: DeploymentResult,
  expected: RetirementIntent,
): void {
  const receipt = result.receipt;
  if (
    result.outcome !== "deployed" ||
    typeof result.idempotent !== "boolean" ||
    !plainObject(receipt) ||
    receipt.buildBatchId !== expected.buildBatchId ||
    receipt.generation !== expected.generation ||
    receipt.commitSha !== expected.commitSha ||
    receipt.deploymentId !== expected.deploymentId ||
    receipt.versionId !== expected.versionId
  ) {
    operatorError("The baseline control-plane activation was not settled");
  }
}

function assertRetirementResult(
  result: RetirementResult,
  expected: RetirementIntent,
): void {
  if (
    result.outcome !== "cancelled" ||
    typeof result.idempotent !== "boolean" ||
    !plainObject(result.receipt) ||
    result.receipt.queueId !== expected.queueId ||
    result.receipt.buildBatchId !== expected.buildBatchId ||
    result.receipt.generation !== expected.generation ||
    result.receipt.commitSha !== expected.commitSha ||
    result.receipt.deploymentId !== expected.deploymentId ||
    result.receipt.versionId !== expected.versionId
  ) {
    operatorError("The CMS publication baseline was not retired");
  }
}

export async function runCmsPublicationBaselineRetirement({
  firestore,
  journal,
  intent,
  workerApiToken,
  routeApiToken,
  dependencies: dependencyOverrides,
}: {
  firestore: Firestore;
  journal: CmsPublicationTokenJournal;
  intent: RetirementIntent;
  workerApiToken: string;
  routeApiToken: string;
  dependencies?: Partial<RetirementDependencies>;
}): Promise<Record<string, unknown>> {
  if (!firestore || !journal || typeof journal.read !== "function") {
    operatorError("The CMS publication baseline retirement input is invalid");
  }
  const validatedWorkerApiToken = parseCmsPublicationCloudflareToken(
    workerApiToken,
  );
  const validatedRouteApiToken = parseCmsPublicationCloudflareToken(
    routeApiToken,
  );
  const dependencies: RetirementDependencies = {
    requestJson: requestCloudflareJson,
    requestApex: requestApexPublicationReceipt,
    readState: readCmsPublicationBaselineRetirementState,
    settleOutcome: settlePublicDeploymentOutcome,
    retireQueue: retireCmsPublicationBaseline,
    ...dependencyOverrides,
  };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    operatorError("The CMS publication baseline retirement dependencies are invalid");
  }

  const journalJob = await journal.read();
  const expected = expectation(intent, journalJob);
  let state = await dependencies.readState({ firestore, expected });
  let deploymentIdempotent = true;
  let queueResult: RetirementResult;

  if (state.queue.receipt) {
    queueResult = await dependencies.retireQueue({ firestore, expected });
  } else {
    if (!journalJob) {
      operatorError("The publishing baseline has no retained journal token");
    }
    const firstEvidence = await observeProvider({
      expected: intent,
      state,
      workerApiToken: validatedWorkerApiToken,
      routeApiToken: validatedRouteApiToken,
      requestJson: dependencies.requestJson,
    });
    const probe = new URL("/_publication.json", "https://njpbs.org");
    probe.searchParams.set("cms-context", "code");
    probe.searchParams.set("baseline-retirement", intent.queueId);
    probe.searchParams.set("version", intent.versionId);
    assertApexDoesNotServeCandidate(
      await dependencies.requestApex(probe.toString()),
      state.candidate,
    );
    const finalEvidence = await observeProvider({
      expected: intent,
      state,
      workerApiToken: validatedWorkerApiToken,
      routeApiToken: validatedRouteApiToken,
      requestJson: dependencies.requestJson,
    });
    if (!isDeepStrictEqual(firstEvidence, finalEvidence)) {
      operatorError("The active Cloudflare deployment changed during retirement");
    }
    const deploymentResult = await dependencies.settleOutcome({
      firestore,
      lease: state.lease,
      evidence: finalEvidence,
    });
    assertDeploymentResult(deploymentResult, intent);
    deploymentIdempotent = deploymentResult.idempotent;
    state = await dependencies.readState({ firestore, expected });
    if (state.phase !== "deployed") {
      operatorError("The baseline control-plane activation was not persisted");
    }
    const postSettlementEvidence = await observeProvider({
      expected: intent,
      state,
      workerApiToken: validatedWorkerApiToken,
      routeApiToken: validatedRouteApiToken,
      requestJson: dependencies.requestJson,
    });
    if (!isDeepStrictEqual(finalEvidence, postSettlementEvidence)) {
      operatorError("The active Cloudflare deployment changed during retirement");
    }
    assertApexDoesNotServeCandidate(
      await dependencies.requestApex(probe.toString()),
      state.candidate,
    );
    queueResult = await dependencies.retireQueue({ firestore, expected });
  }
  assertRetirementResult(queueResult, intent);

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
  const finalExpected = expectation(intent, null);
  const finalState = await dependencies.readState({
    firestore,
    expected: finalExpected,
  });
  if (!finalState.queue.receipt || finalState.phase !== "deployed") {
    operatorError("The CMS publication baseline retirement was not persisted");
  }
  return Object.freeze({
    outcome: "retired",
    idempotent:
      deploymentIdempotent && queueResult.idempotent && journalIdempotent,
    queueId: intent.queueId,
    buildBatchId: intent.buildBatchId,
    generation: intent.generation,
    commitSha: intent.commitSha,
    deploymentId: intent.deploymentId,
    versionId: intent.versionId,
    queueIdempotent: queueResult.idempotent,
    journalIdempotent,
  });
}

export function parseRetirementArguments(args: string[]): RetirementIntent {
  if (
    args.length !== 8 ||
    args[0] !== "--apply" ||
    !COMMIT_SHA.test(args[1] ?? "") ||
    !QUEUE_ID.test(args[2] ?? "") ||
    !/^\d+$/.test(args[3] ?? "") ||
    !COMMIT_SHA.test(args[4] ?? "") ||
    !CLOUDFLARE_UUID.test(args[5] ?? "") ||
    !CLOUDFLARE_UUID.test(args[6] ?? "") ||
    !SERIALIZER_ID.test(args[7] ?? "")
  ) {
    operatorError(
      "Usage: retire-cms-publication-baseline --apply <operator-commit> <queue-id> <generation> <target-commit> <deployment-id> <version-id> <serializer-id>",
    );
  }
  const generation = Number(args[3]);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    operatorError("The CMS publication baseline generation is invalid");
  }
  return Object.freeze({
    operatorCommitSha: args[1],
    queueId: args[2],
    buildBatchId: `cms-${args[2]}`,
    generation,
    commitSha: args[4],
    deploymentId: args[5].toLowerCase(),
    versionId: args[6].toLowerCase(),
    serializerId: args[7],
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
  initializeFirebase: (serviceAccount) => initializeApp(
    {
      credential: cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID,
    },
    "cms-publication-baseline-retirement-operator",
  ),
  firestoreFor: getFirestore,
  openJournal: openCmsPublicationTokenJournal,
  deleteFirebase: deleteApp,
  requestJson: requestCloudflareJson,
  requestApex: requestApexPublicationReceipt,
  readState: readCmsPublicationBaselineRetirementState,
  settleOutcome: settlePublicDeploymentOutcome,
  retireQueue: retireCmsPublicationBaseline,
};

function resolveCommandDependencies(
  overrides: Partial<CommandDependencies> | undefined,
): CommandDependencies {
  const dependencies = { ...defaultCommandDependencies, ...overrides };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    operatorError("The CMS publication baseline command dependencies are invalid");
  }
  return dependencies;
}

export async function runCmsPublicationBaselineRetirementCommand(
  args: string[],
  dependencyOverrides?: Partial<CommandDependencies>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  assertProductionFirestoreRouting(environment);
  const intent = parseRetirementArguments(args);
  const dependencies = resolveCommandDependencies(dependencyOverrides);
  await assertCmsPublicationSourceCheckout(intent.operatorCommitSha);
  dependencies.assertLock(LOCK_FD, LOCK_PATH);
  const workerApiToken = parseCmsPublicationCloudflareToken(
    dependencies.readCredential(WORKER_CREDENTIAL_FD),
  );
  const serviceAccount = parseCmsPublicationFirebaseServiceAccount(
    dependencies.readCredential(FIREBASE_CREDENTIAL_FD),
  );
  const routeApiToken = parseCmsPublicationCloudflareToken(
    dependencies.readCredential(ROUTE_CREDENTIAL_FD),
  );
  let app: App | undefined;
  try {
    app = dependencies.initializeFirebase(serviceAccount);
    const firestore = dependencies.firestoreFor(app);
    const journal = await dependencies.openJournal({
      stateDirectory: STATE_DIRECTORY,
      serializerId: intent.serializerId,
    });
    return await runCmsPublicationBaselineRetirement({
      firestore,
      journal,
      intent,
      workerApiToken,
      routeApiToken,
      dependencies,
    });
  } finally {
    if (app) await dependencies.deleteFirebase(app);
  }
}

function controlledErrorMessage(error: unknown): string {
  return error instanceof CmsPublicationBaselineRetirementOperatorError ||
      error instanceof CmsPublicationBaselineRetirementError ||
      error instanceof CmsPublicationSerializerOperatorError ||
      error instanceof CmsPublicationRuntimeGuardError ||
      error instanceof CmsPublicationTokenJournalError ||
      error instanceof PublicWorkerActivationOperatorError ||
      error instanceof PublicDeploymentStateError ||
      error instanceof CloudflareConfigurationError
    ? error.message
    : "The CMS publication baseline retirement failed without a verified result";
}

export async function main(
  args = process.argv.slice(2),
  dependencyOverrides?: Partial<CommandDependencies>,
): Promise<void> {
  try {
    if (args.length === 1 && args[0] === "--preflight") return;
    const result = await runCmsPublicationBaselineRetirementCommand(
      args,
      dependencyOverrides,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `Publication baseline retirement refused: ${controlledErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
