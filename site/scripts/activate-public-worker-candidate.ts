import { CloudflareConfigurationError, cloudflareAccount } from "./cloudflare-account.mjs";
import { verifyDevPublicWorkerPrivate } from "../../scripts/lib/dev-private-worker.mjs";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
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
import { PUBLIC_WORKER_NAME, cloudflareApiUrl, publicWorkerTag, workerApiPath } from "./public-worker-cloudflare.ts";
import type { PublicationTarget } from "../../functions/lib/publication-target";
export { PUBLIC_WORKER_NAME, workerApiPath } from "./public-worker-cloudflare.ts";

const requireModule = createRequire(import.meta.url);
const { assertPublicationTarget, publicationTarget } = requireModule("../../functions/lib/publication-target.js") as
  typeof import("../../functions/lib/publication-target");
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
  verifyNoBuildPostPublicRoute(input: { firestore: Firestore; candidate: PublicWorkerCandidate; target?: PublicationTarget;
    headers?: Record<string, string> }): Promise<void> };
type PublicationRuntime = { owner: "node-compute" | "cloudflare"; release: string };
const coordinatorModule = requireModule(
  "../../functions/lib/public-deployment-coordinator.js",
) as {
  acquirePublicDeploymentLease(input: {
    firestore: Firestore;
    buildBatchId: string;
    commitSha: string;
    runtime?: PublicationRuntime;
    target?: PublicationTarget;
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
    target?: PublicationTarget;
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
    target?: PublicationTarget;
  }): Promise<ActivationResult>;
};

const { parseCloudflareToken, parseFirebaseServiceAccount } =
  bootstrapOperatorModule;
const { acquirePublicDeploymentLease } = coordinatorModule;
const { planPublicWorkerActivationEvidence } = activationEvidenceModule;
const { settlePublicDeploymentOutcome, PublicDeploymentTerminalEvidenceError } = outcomeStoreModule;

const FIREBASE_PROJECT_ID = "njpbs-site";
const UPLOAD_ONLY_DEPLOY_COMMAND = "npx wrangler versions upload --config workers/wrangler.jsonc";
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
export type PublicationAccess = { clientId: string; clientSecret: string };
type RequestPublication = (url: string, access?: PublicationAccess) => Promise<string>;
type AcquireLease = (input: {
  runtime?: PublicationRuntime;
  target?: PublicationTarget;
  firestore: Firestore;
  buildBatchId: string;
  commitSha: string;
}) => Promise<LeaseAcquisition>;
type SettleOutcome = (input: {
  runtime?: PublicationRuntime;
  target?: PublicationTarget;
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

/** Production keeps its fixed Worker; a development target names only its own. */
export function publicWorkerTarget(target?: PublicationTarget): PublicationTarget {
  return target === undefined ? publicationTarget("production") : assertPublicationTarget(target);
}

export function assertPublicWorkerIdentity(response: unknown, target?: PublicationTarget): string {
  const { workerName } = publicWorkerTarget(target);
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
      worker.id === workerName &&
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

/** The dev Worker has no Workers Builds trigger; any trigger could deploy it
 * outside the lease, so development activation refuses one. */
export function assertPublicWorkerTriggers(response: unknown, expectedWorkerTag: string, target?: PublicationTarget): void {
  if (publicWorkerTarget(target).environment === "production") {
    assertUploadOnlyProductionTrigger(response, expectedWorkerTag);
    return;
  }
  if (expectedWorkerTag !== publicWorkerTag() || !plainObject(response) || response.success !== true ||
      !Array.isArray(response.result) || response.result.length !== 0) {
    operatorError("The Cloudflare development Worker has a build trigger");
  }
}

/** Development reads its Access-protected origin; production never sends Access credentials. */
export function publicationReadAccess(target: PublicationTarget, access?: PublicationAccess): PublicationAccess | undefined {
  if (publicWorkerTarget(target).environment === "production") {
    if (access !== undefined) operatorError("Production publication reads refuse Access credentials");
    return undefined;
  }
  if (!access?.clientId?.trim() || !access.clientSecret?.trim()) operatorError("Development publication reads require Access credentials");
  return access;
}

export function publicationReadHeaders(access?: PublicationAccess): Record<string, string> {
  return access ? { "cf-access-client-id": access.clientId, "cf-access-client-secret": access.clientSecret } : {};
}

/** A dev route or custom domain would serve a new version outside the staff gateway. */
export async function assertDevelopmentWorkerPrivate(target: PublicationTarget, requestJson: RequestJson, token: string): Promise<void> {
  if (publicWorkerTarget(target).environment !== "development") return;
  await verifyDevPublicWorkerPrivate(async (pathname: string) => {
    const response = await requestJson({ url: cloudflareApiUrl(pathname), method: "GET", token });
    if (!plainObject(response) || response.success !== true) operatorError("The Cloudflare API response is invalid");
    return response.result;
  }, undefined, cloudflareAccount());
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

/** The request got no answer: whether it took effect is unknown. */
export class UnansweredRequestError extends Error {}

const ASK_AGAIN_MS = 1_000;
const LONGEST_ATTEMPT_MS = 30 * 60_000;

// Only a lost or late answer is asked again. Every other fetch error (a refused
// redirect, an invalid header) repeats forever, and its message can carry a
// header value, so only the error name and provider code are kept.
function unansweredReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = error.cause instanceof Error ? error.cause as Error & { code?: unknown } : undefined;
  if (error.name === "TimeoutError" || error.name === "AbortError") return error.name;
  if (error.name !== "TypeError" || !["fetch failed", "terminated"].includes(error.message) ||
      cause?.message === "unexpected redirect") return null;
  return `${error.message} (${typeof cause?.code === "string" ? cause.code : cause?.name ?? "no code"})`;
}

async function answered<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PublicWorkerActivationOperatorError || error instanceof UnansweredRequestError) throw error;
    const reason = unansweredReason(error);
    if (reason) throw new UnansweredRequestError(`${label} did not complete: ${reason}`);
    operatorError(`${label} did not complete`);
  }
}

// A read ends on its answer. Each repeat gets twice the time, so a slow answer
// is waited for and every unanswered attempt is named in the log.
async function readUntilAnswered<T>(firstAttemptMs: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read(AbortSignal.timeout(Math.min(firstAttemptMs * 2 ** attempt, LONGEST_ATTEMPT_MS)));
    } catch (error) {
      if (!(error instanceof UnansweredRequestError)) throw error;
      reportActivationFault(`asking again after attempt ${attempt + 1}`, error);
      await new Promise(resolve => setTimeout(resolve, ASK_AGAIN_MS));
    }
  }
}

/** A read is asked again until Cloudflare answers. A write is sent once: its
 * caller reads the resulting state before it repeats the write. */
export async function requestCloudflareJson(
  request: CloudflareRequest,
): Promise<unknown> {
  const attempt = (signal: AbortSignal) => sendCloudflareRequest(request, signal);
  return request.method === "GET" ? readUntilAnswered(15_000, attempt) : attempt(AbortSignal.timeout(15_000));
}

async function sendCloudflareRequest(request: CloudflareRequest, signal: AbortSignal): Promise<unknown> {
  const label = `The Cloudflare API request ${request.method} ${new URL(request.url).pathname.replace(/^.*\/accounts\/[^/]+/, "")}`;
  const text = await answered(label, async () => {
    const response = await fetch(request.url, {
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
      signal,
    });
    if (response.status === 429 || response.status >= 500) {
      throw new UnansweredRequestError(`${label} did not complete: HTTP ${response.status}`);
    }
    if (!response.ok) {
      operatorError(`The Cloudflare API returned HTTP ${response.status}`);
    }
    return response.text();
  });
  if (Buffer.byteLength(text, "utf8") > MAX_CLOUDFLARE_RESPONSE_BYTES) {
    operatorError("The Cloudflare API response was too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    operatorError("The Cloudflare API response was not JSON");
  }
}

// The receipt origin selects its Worker identity; every other origin keeps production's.
function publicationOriginValue(url: string): string {
  const development = publicationTarget("development");
  return new URL(url).origin === development.origin ? development.workerName : PUBLICATION_ORIGIN_VALUE;
}

export async function requestPublicPublicationReceipt(
  url: string,
  access?: PublicationAccess,
): Promise<string> {
  const label = "The public publication receipt request";
  const body = await readUntilAnswered(10_000, signal => answered(label, async () => {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        ...(access ? { "CF-Access-Client-Id": access.clientId, "CF-Access-Client-Secret": access.clientSecret } : {}),
      },
      redirect: "error",
      signal,
    });
    if (
      !response.ok ||
      response.headers.get(PUBLICATION_ORIGIN_HEADER) !==
        publicationOriginValue(url) ||
      !response.headers.get("content-type")?.toLowerCase().startsWith(
        "application/json",
      )
    ) {
      operatorError(`The public publication receipt response is invalid (HTTP ${response.status})`);
    }
    return response.text();
  }));
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
  target,
  publicationAccess,
}: {
  firestore: Firestore;
  cloudflareApiToken: string;
  preparedArtifact: unknown;
  runtime?: PublicationRuntime;
  target?: PublicationTarget;
  publicationAccess?: PublicationAccess;
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
  const selected = publicWorkerTarget(target);
  const access = target ? publicationReadAccess(selected, publicationAccess) : undefined;
  const owned = { ...(runtime ? { runtime } : {}), ...(target ? { target: selected } : {}) };
  const prepared = assertPreparedPublicWorkerArtifact(preparedArtifact);

  const settleOwned: SettleOutcome = input => settleOutcomeFn({ ...input, ...owned });
  const workerResponse = await requestJson({
    url: workerApiPath("/workers/scripts"),
    method: "GET",
    token: cloudflareApiToken,
  });
  const workerTag = assertPublicWorkerIdentity(workerResponse, selected);
  const triggerResponse = await requestJson({
    url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
    method: "GET",
    token: cloudflareApiToken,
  });
  assertPublicWorkerTriggers(triggerResponse, workerTag, selected);
  await assertDevelopmentWorkerPrivate(selected, requestJson, cloudflareApiToken);

  const acquisition = await acquireLeaseFn({
    firestore,
    buildBatchId: prepared.buildBatchId,
    commitSha: prepared.commitSha,
    ...owned,
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

  const deploymentsUrl = workerApiPath(`/workers/scripts/${selected.workerName}/deployments`);
  const readDeployments = async (): Promise<unknown> => {
    try {
      return await requestJson({ url: deploymentsUrl, method: "GET", token: cloudflareApiToken });
    } catch (error) {
      reportActivationFault("deployment list", error);
      return {};
    }
  };
  // The switch has not happened while the lease's predecessor still serves. An
  // unread list or any other deployment never permits a write.
  const predecessorServes = (response: unknown): boolean => {
    const active = activeDeployment(response);
    return plainObject(active) && typeof active.id === "string" && active.id === lease.predecessorDeploymentId;
  };

  // Another attempt of this operation may have settled this lease while this one
  // waited. A write after that would put an older version back.
  const leaseStillHeld = async (): Promise<boolean> => {
    try {
      const held = await acquireLeaseFn({ firestore, buildBatchId: prepared.buildBatchId, commitSha: prepared.commitSha, ...owned });
      return held.outcome === "acquired" && isDeepStrictEqual(held.lease, lease);
    } catch (error) {
      reportActivationFault("lease before the deployment write", error);
      return false;
    }
  };

  // A lease survives a fault before or at the deployment write, so a held lease
  // writes again when its predecessor still serves.
  let deploymentResponse: unknown = acquisition.idempotent ? await readDeployments() : undefined;
  if (!acquisition.idempotent || predecessorServes(deploymentResponse)) {
    try {
      const preDeployTriggerResponse = await requestJson({
        url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
        method: "GET",
        token: cloudflareApiToken,
      });
      assertPublicWorkerTriggers(preDeployTriggerResponse, workerTag, selected);
      const subdomainResponse = await requestJson({
        url: workerApiPath(
          `/workers/scripts/${selected.workerName}/subdomain`,
        ),
        method: "POST",
        token: cloudflareApiToken,
        body: { enabled: false, previews_enabled: false },
      });
      assertProductionWorkerSubdomainDisabled(subdomainResponse);
      await assertDevelopmentWorkerPrivate(selected, requestJson, cloudflareApiToken);
    } catch (error) {
      reportActivationFault("before the deployment write", error);
      return settleWithFallback({
        firestore,
        lease,
        evidence: { action: "reconcile" },
        settleOutcomeFn: settleOwned,
      });
    }
    for (let unanswered = true; unanswered;) {
      unanswered = false;
      if (!await leaseStillHeld()) {
        reportActivationFault("deployment write", new Error("The lease is no longer held; nothing was written"));
        return settleWithFallback({ firestore, lease, evidence: { action: "reconcile" }, settleOutcomeFn: settleOwned });
      }
      try {
        const writeResponse = await requestJson({
          url: deploymentsUrl,
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
        if (!responseSucceeded(writeResponse)) {
          operatorError("The Cloudflare deployment response is invalid");
        }
      } catch (error) {
        // The response is ambiguous. The authoritative active-deployment read
        // below decides whether the exact version is live, the write is
        // repeated, or the lease must reconcile.
        reportActivationFault("deployment write", error);
        unanswered = error instanceof UnansweredRequestError;
      }
      deploymentResponse = await readDeployments();
      unanswered &&= predecessorServes(deploymentResponse);
      if (unanswered) await new Promise(resolve => setTimeout(resolve, ASK_AGAIN_MS));
    }
  }

  let evidence = planPublicWorkerActivationEvidence({
    lease,
    candidate,
    deploymentStatus: activeDeployment(deploymentResponse),
    deploymentSource: "api",
    ...(target ? { target: selected } : {}),
  });

  if (evidence.action === "activate") {
    const probe = new URL(PUBLICATION_PROBE_PATH, selected.origin);
    probe.searchParams.set("candidate", prepared.buildBatchId);
    probe.searchParams.set("version", candidate.workerVersionId);
    try {
      const body = await (access ? requestPublication(probe.toString(), access) : requestPublication(probe.toString()));
      if (!publicPublicationReceiptMatchesPreparedArtifact(body, prepared)) {
        reportActivationFault("public receipt", new Error("The public publication receipt names another artifact"));
        evidence = { action: "reconcile" };
      } else {
        await verifyNoBuildPostPublicRoute({ firestore, candidate,
          ...(target ? { target: selected, headers: publicationReadHeaders(access) } : {}) });
      }
    } catch (error) {
      reportActivationFault("public readback", error);
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
      assertPublicWorkerTriggers(finalTriggerResponse, workerTag, selected);
      await assertDevelopmentWorkerPrivate(selected, requestJson, cloudflareApiToken);
    } catch (error) {
      reportActivationFault("after the readback", error);
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

/** The operator settles a fault as "reconcile"; this names it in the log. */
export function reportActivationFault(step: string, error: unknown): void {
  console.error(JSON.stringify({ event: "public_activation_fault", step, message: error instanceof Error ? error.message : "unknown" }));
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  let app: App | undefined;
  try {
    assertProductionFirestoreRouting(process.env);
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
