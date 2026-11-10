import { CloudflareConfigurationError } from "./cloudflare-account.mjs";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App, ServiceAccount } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertPreparedPublicWorkerArtifact,
  MAX_PUBLICATION_RECEIPT_BYTES,
  publicPublicationReceiptMatchesPreparedArtifact,
  type PreparedPublicWorkerArtifact,
} from "../src/lib/public-worker-artifact.ts";
import { firebaseAdminRuntime } from "./firebase-admin-runtime.ts";
import { PUBLIC_WORKER_NAME, publicWorkerTag, workerApiPath } from "./public-worker-cloudflare.ts";
export { PUBLIC_WORKER_NAME, workerApiPath } from "./public-worker-cloudflare.ts";

const requireModule = createRequire(import.meta.url);
const { projectPublicDeploymentRestoreReceipt } = requireModule("../../functions/lib/public-deployment.js") as {
  projectPublicDeploymentRestoreReceipt(value: unknown): Record<string, unknown> };
const bootstrapOperatorModule = requireModule(
  "../../scripts/bootstrap-public-deployment.cjs",
) as {
  parseCloudflareToken(value: string): string;
  parseFirebaseServiceAccount(value: string): ServiceAccount & {
    project_id: string;
  };
};
const { verifyNoBuildPostPublicRoute } = requireModule("../../functions/lib/no-build-post-recovery.js") as {
  verifyNoBuildPostPublicRoute(input: { firestore: Firestore; candidate: PublicWorkerCandidate }): Promise<void> };
type PublicationRuntime = { owner: "node-compute" | "cloudflare"; release: string };
const coordinatorModule = requireModule(
  "../../functions/lib/public-deployment-coordinator.js",
) as {
  acquirePublicDeploymentLease(input: {
    firestore: Firestore;
    buildBatchId: string;
    commitSha: string;
    runtime?: PublicationRuntime;
  }): Promise<LeaseAcquisition>;
};
const activationEvidenceModule = requireModule(
  "../../functions/lib/public-worker-activation.js",
) as {
  planPublicWorkerActivationEvidence(input: {
    lease: PublicDeploymentLease;
    candidate: PublicWorkerCandidate;
    deploymentStatus: unknown;
    deploymentSource?: "api" | "wrangler";
  }): ActivationEvidence;
};
const { publicDeploymentCloudflareEvidenceDigest } = requireModule(
  "../../functions/lib/public-deployment-cloudflare.js",
) as {
  publicDeploymentCloudflareEvidenceDigest(evidence: ActivationEvidence, buildBatchId: string): string;
};
const outcomeStoreModule = requireModule(
  "../../functions/lib/public-deployment-outcome-store.js",
) as {
  PublicDeploymentTerminalEvidenceError: new (message: string) => Error;
  settlePublicDeploymentOutcome(input: {
    firestore: Firestore;
    lease: PublicDeploymentLease;
    evidence: ActivationEvidence;
    runtime?: PublicationRuntime;
  }): Promise<ActivationResult>;
};

const { parseCloudflareToken, parseFirebaseServiceAccount } =
  bootstrapOperatorModule;
const { acquirePublicDeploymentLease } = coordinatorModule;
const { planPublicWorkerActivationEvidence } = activationEvidenceModule;
const { settlePublicDeploymentOutcome, PublicDeploymentTerminalEvidenceError } = outcomeStoreModule;

const FIREBASE_PROJECT_ID = "njpbs-site";
const UPLOAD_ONLY_DEPLOY_COMMAND = "npx wrangler versions upload --config workers/wrangler.jsonc";
// The repository-connected Worker trigger uploads immutable versions only.
// This lease-backed operator is the sole reviewed path that can change traffic.
const PROVIDER_DEPLOYMENT_PATHS_SERIALIZED = true;
export const PUBLICATION_PROBE_ORIGIN = "https://njpbs.org";
// The probe must attest the real public root served by the exact active Worker.
export const PUBLICATION_PROBE_PATH = "/_publication.json";
export const PUBLICATION_ORIGIN_HEADER = "x-njpbs-publication-origin";
export const PUBLICATION_ORIGIN_VALUE = PUBLIC_WORKER_NAME;
const CLOUDFLARE_TOKEN = /^[A-Za-z0-9_-]{20,80}$/;
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_CLOUDFLARE_RESPONSE_BYTES = 2 * 1024 * 1024;

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

type LeaseAcquisition =
  | {
      outcome: "acquired";
      idempotent: boolean;
      lease: PublicDeploymentLease;
      candidate: PublicWorkerCandidate;
    }
  | {
      outcome: "busy" | "superseded";
      idempotent: boolean;
      [field: string]: unknown;
    };

type ActivationEvidence =
  | { action: "reconcile" }
  | {
      action: "activate";
      buildBatchId: string;
      deploymentId: string;
      versionId: string;
      commitSha: string;
    };

interface ActivationResult {
  outcome: "deployed" | "reconciling" | "busy" | "superseded" | "failed";
  idempotent: boolean;
  receipt?: Record<string, unknown>;
  [field: string]: unknown;
}

interface CloudflareRequest {
  url: string;
  method: "GET" | "POST";
  token: string;
  body?: unknown;
}

type RequestJson = (request: CloudflareRequest) => Promise<unknown>;
type RequestPublication = (url: string) => Promise<string>;
type AcquireLease = (input: {
  runtime?: PublicationRuntime;
  firestore: Firestore;
  buildBatchId: string;
  commitSha: string;
}) => Promise<LeaseAcquisition>;
type SettleOutcome = (input: {
  runtime?: PublicationRuntime;
  firestore: Firestore;
  lease: PublicDeploymentLease;
  evidence: ActivationEvidence;
}) => Promise<ActivationResult>;

export class PublicWorkerActivationOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicWorkerActivationOperatorError";
  }
}

function operatorError(message: string): never {
  throw new PublicWorkerActivationOperatorError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

export function assertPublicWorkerIdentity(response: unknown): string {
  const workerTag = publicWorkerTag();
  if (
    !plainObject(response) ||
    response.success !== true ||
    !Array.isArray(response.result)
  ) {
    operatorError("The Cloudflare Worker list response is invalid");
  }
  const matches = response.result.filter(
    (worker) =>
      plainObject(worker) &&
      worker.id === PUBLIC_WORKER_NAME &&
      worker.tag === workerTag,
  );
  if (matches.length !== 1) {
    operatorError("The Cloudflare Worker identity is invalid");
  }
  return workerTag;
}

export function assertUploadOnlyProductionTrigger(
  response: unknown,
  expectedWorkerTag: string,
): string {
  if (
    expectedWorkerTag !== publicWorkerTag() ||
    !plainObject(response) ||
    response.success !== true ||
    !Array.isArray(response.result) ||
    response.result.length !== 1
  ) {
    operatorError("The Cloudflare production trigger is not upload-only");
  }
  const trigger = response.result[0];
  if (
    !plainObject(trigger) ||
    typeof trigger.trigger_uuid !== "string" ||
    !CLOUDFLARE_UUID.test(trigger.trigger_uuid) ||
    trigger.external_script_id !== expectedWorkerTag ||
    trigger.deploy_command !== UPLOAD_ONLY_DEPLOY_COMMAND ||
    trigger.root_directory !== "/" ||
    !exactArray(trigger.branch_includes, ["production"]) ||
    !exactArray(trigger.branch_excludes, [])
  ) {
    operatorError("The Cloudflare production trigger is not upload-only");
  }
  return trigger.trigger_uuid;
}

export function assertProductionWorkerSubdomainDisabled(
  response: unknown,
): void {
  if (
    !plainObject(response) ||
    response.success !== true ||
    !plainObject(response.result) ||
    response.result.enabled !== false ||
    response.result.previews_enabled !== false
  ) {
    operatorError("The production Worker subdomain is not disabled");
  }
}

function responseSucceeded(response: unknown): boolean {
  return plainObject(response) && response.success === true;
}

export function activeDeployment(response: unknown): unknown {
  if (
    !plainObject(response) ||
    response.success !== true ||
    !plainObject(response.result) ||
    !Array.isArray(response.result.deployments) ||
    response.result.deployments.length < 1
  ) {
    return {};
  }
  return response.result.deployments[0];
}

function candidateMatchesPrepared(
  candidate: PublicWorkerCandidate,
  prepared: PreparedPublicWorkerArtifact,
): boolean {
  return candidate.buildBatchId === prepared.buildBatchId &&
    candidate.generation === prepared.generation &&
    candidate.commitSha === prepared.commitSha &&
    candidate.artifactDigest === prepared.artifactDigest &&
    candidate.artifactReceiptDigest === prepared.artifactReceiptDigest &&
    candidate.publicationReceiptDigest === prepared.publicationReceiptDigest &&
    candidate.mediaManifestDigest === prepared.mediaManifestDigest &&
    candidate.artifactFileCount === prepared.artifactFileCount &&
    candidate.artifactBytes === prepared.artifactBytes;
}

export async function requestCloudflareJson(
  request: CloudflareRequest,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${request.token}`,
        ...(request.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: request.body === undefined
        ? undefined
        : JSON.stringify(request.body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    operatorError("The Cloudflare API request did not complete");
  }
  if (!response.ok) {
    operatorError(`The Cloudflare API returned HTTP ${response.status}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CLOUDFLARE_RESPONSE_BYTES) {
    operatorError("The Cloudflare API response was too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    operatorError("The Cloudflare API response was not JSON");
  }
}

export async function requestPublicPublicationReceipt(
  url: string,
): Promise<string> {
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
    operatorError("The public publication receipt request did not complete");
  }
  if (
    !response.ok ||
    response.headers.get(PUBLICATION_ORIGIN_HEADER) !==
      PUBLICATION_ORIGIN_VALUE ||
    !response.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) {
    operatorError("The public publication receipt response is invalid");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_PUBLICATION_RECEIPT_BYTES) {
    operatorError("The public publication receipt response is invalid");
  }
  return body;
}

async function settleWithFallback({
  firestore,
  lease,
  evidence,
  settleOutcomeFn,
}: {
  firestore: Firestore;
  lease: PublicDeploymentLease;
  evidence: ActivationEvidence;
  settleOutcomeFn: SettleOutcome;
}): Promise<ActivationResult> {
  try {
    return await settleOutcomeFn({ firestore, lease, evidence });
  } catch (error) {
    if (error instanceof PublicDeploymentTerminalEvidenceError) throw error;
    if (evidence.action === "reconcile") {
      operatorError("The public deployment reconciliation was not persisted");
    }
    try {
      const fallback = await settleOutcomeFn({
        firestore,
        lease,
        evidence: { action: "reconcile" },
      });
      // A competing owner may have settled while the first request failed.
      // A terminal success must still match the caller's original evidence.
      if (fallback.outcome === "deployed" &&
        fallback.receipt?.cloudflareEvidenceDigest !== publicDeploymentCloudflareEvidenceDigest(evidence, lease.buildBatchId)) {
        throw new PublicDeploymentTerminalEvidenceError("The public deployment terminal receipt is invalid");
      }
      return fallback;
    } catch {
      operatorError(
        "The active public deployment outcome is ambiguous; reconciliation is required",
      );
    }
  }
}

export async function runPublicWorkerActivationOperator({
  firestore,
  cloudflareApiToken,
  preparedArtifact,
  runtime,
  requestJson = requestCloudflareJson,
  requestPublication = requestPublicPublicationReceipt,
  acquireLeaseFn = acquirePublicDeploymentLease,
  settleOutcomeFn = settlePublicDeploymentOutcome,
}: {
  firestore: Firestore;
  cloudflareApiToken: string;
  preparedArtifact: unknown;
  runtime?: PublicationRuntime;
  requestJson?: RequestJson;
  requestPublication?: RequestPublication;
  acquireLeaseFn?: AcquireLease;
  settleOutcomeFn?: SettleOutcome;
}): Promise<ActivationResult> {
  if (
    !firestore ||
    !CLOUDFLARE_TOKEN.test(cloudflareApiToken) ||
    typeof requestJson !== "function" ||
    typeof requestPublication !== "function" ||
    typeof acquireLeaseFn !== "function" ||
    typeof settleOutcomeFn !== "function"
  ) {
    operatorError("The public Worker activation operator input is invalid");
  }
  publicWorkerTag();
  const prepared = assertPreparedPublicWorkerArtifact(preparedArtifact);

  const settleOwned: SettleOutcome = input => settleOutcomeFn({ ...input, ...(runtime ? { runtime } : {}) });
  const workerResponse = await requestJson({
    url: workerApiPath("/workers/scripts"),
    method: "GET",
    token: cloudflareApiToken,
  });
  const workerTag = assertPublicWorkerIdentity(workerResponse);
  const triggerResponse = await requestJson({
    url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
    method: "GET",
    token: cloudflareApiToken,
  });
  assertUploadOnlyProductionTrigger(triggerResponse, workerTag);

  const acquisition = await acquireLeaseFn({
    firestore,
    buildBatchId: prepared.buildBatchId,
    commitSha: prepared.commitSha,
    ...(runtime ? { runtime } : {}),
  });
  if (acquisition.outcome !== "acquired") return acquisition;
  const { lease, candidate } = acquisition;
  if (!candidateMatchesPrepared(candidate, prepared)) {
    return settleWithFallback({
      firestore,
      lease,
      evidence: { action: "reconcile" },
      settleOutcomeFn: settleOwned,
    });
  }

  if (!acquisition.idempotent) {
    try {
      const preDeployTriggerResponse = await requestJson({
        url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
        method: "GET",
        token: cloudflareApiToken,
      });
      assertUploadOnlyProductionTrigger(preDeployTriggerResponse, workerTag);
      const subdomainResponse = await requestJson({
        url: workerApiPath(
          `/workers/scripts/${PUBLIC_WORKER_NAME}/subdomain`,
        ),
        method: "POST",
        token: cloudflareApiToken,
        body: { enabled: false, previews_enabled: false },
      });
      assertProductionWorkerSubdomainDisabled(subdomainResponse);
    } catch {
      return settleWithFallback({
        firestore,
        lease,
        evidence: { action: "reconcile" },
        settleOutcomeFn: settleOwned,
      });
    }
    try {
      const deploymentResponse = await requestJson({
        url: workerApiPath(
          `/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`,
        ),
        method: "POST",
        token: cloudflareApiToken,
        body: {
          strategy: "percentage",
          versions: [{
            version_id: candidate.workerVersionId,
            percentage: 100,
          }],
        },
      });
      if (!responseSucceeded(deploymentResponse)) {
        operatorError("The Cloudflare deployment response is invalid");
      }
    } catch {
      // The response is ambiguous. The authoritative active-deployment read
      // below decides whether the exact version is live or must reconcile.
    }
  }

  let deploymentResponse: unknown = {};
  try {
    deploymentResponse = await requestJson({
      url: workerApiPath(
        `/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`,
      ),
      method: "GET",
      token: cloudflareApiToken,
    });
  } catch {
    deploymentResponse = {};
  }
  let evidence = planPublicWorkerActivationEvidence({
    lease,
    candidate,
    deploymentStatus: activeDeployment(deploymentResponse),
    deploymentSource: "api",
  });

  if (evidence.action === "activate") {
    const probe = new URL(PUBLICATION_PROBE_PATH, PUBLICATION_PROBE_ORIGIN);
    probe.searchParams.set("candidate", prepared.buildBatchId);
    probe.searchParams.set("version", candidate.workerVersionId);
    try {
      const body = await requestPublication(probe.toString());
      if (!publicPublicationReceiptMatchesPreparedArtifact(body, prepared)) {
        evidence = { action: "reconcile" };
      } else {
        await verifyNoBuildPostPublicRoute({ firestore, candidate });
      }
    } catch {
      evidence = { action: "reconcile" };
    }
  }

  if (evidence.action === "activate") {
    try {
      const finalTriggerResponse = await requestJson({
        url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
        method: "GET",
        token: cloudflareApiToken,
      });
      assertUploadOnlyProductionTrigger(finalTriggerResponse, workerTag);
    } catch {
      evidence = { action: "reconcile" };
    }
  }

  return settleWithFallback({
    firestore,
    lease,
    evidence,
    settleOutcomeFn: settleOwned,
  });
}

export function projectActivationOperatorResult(
  value: unknown,
): Record<string, unknown> {
  if (
    !plainObject(value) ||
    !["deployed", "reconciling", "busy", "superseded", "failed"].includes(
      String(value.outcome),
    ) ||
    typeof value.idempotent !== "boolean"
  ) {
    operatorError("The public Worker activation result is invalid");
  }
  const projected: Record<string, unknown> = {
    outcome: value.outcome,
    idempotent: value.idempotent,
  };
  if (plainObject(value.receipt)) {
    for (const field of [
      "buildBatchId",
      "generation",
      "commitSha",
      "deploymentId",
      "versionId",
    ]) {
      if (value.receipt[field] !== undefined) {
        projected[field] = value.receipt[field];
      }
    }
    if (value.receipt.restoredPredecessor !== undefined) {
      projected.restoredPredecessor = projectPublicDeploymentRestoreReceipt(value.receipt.restoredPredecessor);
    }
  }
  return projected;
}

export function parseApplyArguments(args: string[]): { preparedArtifactPath: string } |
  { buildBatchId: string; predecessorBuildBatchId: string } {
  if (args.length === 3 && args[0] === "--restore-predecessor" &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(args[1]) && /^[A-Za-z0-9._:-]{1,128}$/.test(args[2]) &&
      ![args[1], args[2]].some(value => value === "." || value === ".." || /^__.*__$/.test(value))) {
    return { buildBatchId: args[1], predecessorBuildBatchId: args[2] };
  }
  if (
    args.length !== 2 ||
    args[0] !== "--apply" ||
    !path.isAbsolute(args[1])
  ) {
    operatorError(
      "Usage: activate:public-worker-candidate --apply <absolute-prepared-artifact-path> or --restore-predecessor <leased-build-batch-id> <predecessor-build-batch-id>",
    );
  }
  return { preparedArtifactPath: args[1] };
}

async function readPreparedArtifact(inputPath: string): Promise<unknown> {
  let body: string;
  try {
    body = await readFile(inputPath, "utf8");
  } catch {
    operatorError("The prepared public Worker artifact is missing");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_PUBLICATION_RECEIPT_BYTES) {
    operatorError("The prepared public Worker artifact is invalid");
  }
  try {
    return JSON.parse(body);
  } catch {
    operatorError("The prepared public Worker artifact is invalid");
  }
}

function controlledErrorMessage(error: unknown): string {
  if (error instanceof PublicWorkerActivationOperatorError || error instanceof CloudflareConfigurationError) {
    return error.message;
  }
  return "The operation failed; no unverified activation was settled";
}

export function assertProductionFirestoreRouting(
  environment: NodeJS.ProcessEnv,
): void {
  if (Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST")) {
    operatorError("The Firestore emulator route is not allowed");
  }
}

export function assertProviderDeploymentPathsSerialized(): void {
  if (!PROVIDER_DEPLOYMENT_PATHS_SERIALIZED) {
    operatorError("Cloudflare deployment paths are not serialized");
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let app: App | undefined;
  try {
    assertProductionFirestoreRouting(process.env);
    assertProviderDeploymentPathsSerialized();
    const input = parseApplyArguments(args);
    const cloudflareApiToken = parseCloudflareToken(readFileSync(3, "utf8"));
    const serviceAccount = parseFirebaseServiceAccount(
      readFileSync(4, "utf8"),
    );
    const preparedArtifact = "preparedArtifactPath" in input ? await readPreparedArtifact(input.preparedArtifactPath) : undefined;
    app = firebaseAdminRuntime.initializeApp(
      {
        credential: firebaseAdminRuntime.cert(serviceAccount),
        projectId: FIREBASE_PROJECT_ID,
      },
      "public-worker-activation-operator",
    );
    const result = "preparedArtifactPath" in input ? await runPublicWorkerActivationOperator({
      firestore: firebaseAdminRuntime.getFirestore(app),
      cloudflareApiToken,
      preparedArtifact,
    }) : await (await import("./reconcile-public-worker-deployment")).restorePublicWorkerPredecessor({
      firestore: firebaseAdminRuntime.getFirestore(app), cloudflareApiToken, ...input,
    });
    process.stdout.write(
      `${JSON.stringify(projectActivationOperatorResult(result))}\n`,
    );
    if (result.outcome !== "deployed" && !(result.outcome === "failed" && result.receipt?.restoredPredecessor)) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Activation refused: ${controlledErrorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (app) {
      try {
        await firebaseAdminRuntime.deleteApp(app);
      } catch {
        process.exitCode = 1;
      }
    }
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
