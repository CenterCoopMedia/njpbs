import { CloudflareConfigurationError, cloudflarePublicZone, cloudflarePublicWorkerTag } from "./cloudflare-account.mjs";
import { createHash } from "node:crypto";
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
} from "../src/lib/public-worker-artifact";
import {
  activeDeployment,
  assertPublicWorkerIdentity,
  assertUploadOnlyProductionTrigger,
  PUBLIC_WORKER_NAME,
  requestCloudflareJson,
  requestPublicPublicationReceipt,
  workerApiPath,
} from "./activate-public-worker-candidate";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";

const requireModule = createRequire(import.meta.url);
const bootstrapModule = requireModule(
  "../../scripts/bootstrap-public-deployment.cjs",
) as {
  parseCloudflareToken(value: string): string;
  parseFirebaseServiceAccount(value: string): ServiceAccount;
};
const mediaActivationModule = requireModule(
  "../../functions/lib/public-media-lifecycle-activation.js",
) as {
  PUBLIC_RECEIPT_URL: string;
  activatePublicMediaLifecycle(input: {
    firestore: Firestore;
    proof: PublicMediaLifecycleProof;
  }): Promise<PublicMediaLifecycleActivationResult>;
};
const workerActivationModule = requireModule(
  "../../functions/lib/public-worker-activation.js",
) as {
  projectApiDeploymentStatus(value: unknown): ActiveDeployment;
};

const { parseCloudflareToken, parseFirebaseServiceAccount } = bootstrapModule;
const { PUBLIC_RECEIPT_URL, activatePublicMediaLifecycle } =
  mediaActivationModule;
const { projectApiDeploymentStatus } = workerActivationModule;

const FULL_APEX_ROUTE_PATTERN = "https://njpbs.org/*";
const FIREBASE_PROJECT_ID = "njpbs-site";
const CLOUDFLARE_WORKER_CREDENTIAL_FD = 3;
const FIREBASE_CREDENTIAL_FD = 4;
const CLOUDFLARE_ROUTE_CREDENTIAL_FD = 6;
const ROUTE_ID = /^[a-f0-9]{32}$/i;

interface ActiveDeployment {
  deploymentId: string;
  versionId: string;
  createdOn: string;
}

interface PublicMediaLifecycleProof {
  schemaVersion: 1;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  deploymentId: string;
  versionId: string;
  publicationReceiptDigest: string;
  publicReceiptUrl: string;
}

interface PublicMediaLifecycleActivationResult {
  idempotent: boolean;
  receipt: PublicMediaLifecycleProof & { activatedAt: unknown };
}

interface CloudflareRequest {
  url: string;
  method: "GET" | "POST";
  token: string;
  body?: unknown;
}

type RequestJson = (request: CloudflareRequest) => Promise<unknown>;
type RequestPublication = (url: string) => Promise<string>;
type Activate = typeof activatePublicMediaLifecycle;

export class PublicMediaLifecycleActivationOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicMediaLifecycleActivationOperatorError";
  }
}

function operatorError(message: string): never {
  throw new PublicMediaLifecycleActivationOperatorError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function targetsApex(pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  const route = pattern.trim().toLowerCase().replace(
    /^(?:https?|\*):\/\//,
    "",
  );
  const host = route.split("/", 1)[0];
  return host === "njpbs.org" || host === "*njpbs.org";
}

export function assertFullApexWorkerRoute(response: unknown): string {
  if (!plainObject(response) || response.success !== true ||
      !Array.isArray(response.result)) {
    operatorError("The Cloudflare Worker route response is invalid");
  }
  const matches = response.result.filter((route) =>
    plainObject(route) &&
    route.pattern === FULL_APEX_ROUTE_PATTERN &&
    route.script === PUBLIC_WORKER_NAME &&
    typeof route.id === "string" &&
    ROUTE_ID.test(route.id)
  );
  if (matches.length !== 1) {
    operatorError("The full apex Worker route is not active");
  }
  const apexRoutes = response.result.filter((route) =>
    plainObject(route) && targetsApex(route.pattern)
  );
  if (apexRoutes.length !== 1) {
    operatorError("Another apex Worker route overlaps the public artifact");
  }
  return String(matches[0].id).toLowerCase();
}

function sameActiveDeployment(
  left: ActiveDeployment,
  right: ActiveDeployment,
): boolean {
  return left.deploymentId === right.deploymentId &&
    left.versionId === right.versionId &&
    left.createdOn === right.createdOn;
}

async function exactPublicReceipt({
  prepared,
  active,
  requestPublication,
}: {
  prepared: PreparedPublicWorkerArtifact;
  active: ActiveDeployment;
  requestPublication: RequestPublication;
}): Promise<void> {
  const probe = new URL(PUBLIC_RECEIPT_URL);
  probe.searchParams.set("cms-context", "code");
  probe.searchParams.set("candidate", prepared.buildBatchId);
  probe.searchParams.set("version", active.versionId);
  const body = await requestPublication(probe.toString());
  if (!publicPublicationReceiptMatchesPreparedArtifact(body, prepared)) {
    operatorError("The public root publication receipt does not match the candidate");
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== prepared.publicationReceiptDigest) {
    operatorError("The public root publication receipt digest is invalid");
  }
}

export async function runPublicMediaLifecycleActivationOperator({
  firestore,
  cloudflareWorkerApiToken,
  cloudflareRouteApiToken,
  preparedArtifact,
  requestJson = requestCloudflareJson,
  requestPublication = requestPublicPublicationReceipt,
  activateFn = activatePublicMediaLifecycle,
}: {
  firestore: Firestore;
  cloudflareWorkerApiToken: string;
  cloudflareRouteApiToken: string;
  preparedArtifact: unknown;
  requestJson?: RequestJson;
  requestPublication?: RequestPublication;
  activateFn?: Activate;
}): Promise<PublicMediaLifecycleActivationResult> {
  if (!firestore || typeof requestJson !== "function" ||
      typeof requestPublication !== "function" || typeof activateFn !== "function") {
    operatorError("The public media lifecycle operator input is invalid");
  }
  cloudflarePublicWorkerTag();
  const routesUrl = `https://api.cloudflare.com/client/v4/zones/${cloudflarePublicZone()}/workers/routes`;
  const workerApiToken = parseCloudflareToken(cloudflareWorkerApiToken);
  const routeApiToken = parseCloudflareToken(cloudflareRouteApiToken);
  const prepared = assertPreparedPublicWorkerArtifact(preparedArtifact);
  const workerResponse = await requestJson({
    url: workerApiPath("/workers/scripts"),
    method: "GET",
    token: workerApiToken,
  });
  const workerTag = assertPublicWorkerIdentity(workerResponse);

  const observe = async (): Promise<ActiveDeployment> => {
    const [triggerResponse, routesResponse, deploymentsResponse] =
      await Promise.all([
        requestJson({
          url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
          method: "GET",
          token: workerApiToken,
        }),
        requestJson({
          url: routesUrl,
          method: "GET",
          token: routeApiToken,
        }),
        requestJson({
          url: workerApiPath(`/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`),
          method: "GET",
          token: workerApiToken,
        }),
      ]);
    assertUploadOnlyProductionTrigger(triggerResponse, workerTag);
    assertFullApexWorkerRoute(routesResponse);
    return projectApiDeploymentStatus(activeDeployment(deploymentsResponse));
  };

  const first = await observe();
  await exactPublicReceipt({ prepared, active: first, requestPublication });
  const second = await observe();
  await exactPublicReceipt({ prepared, active: second, requestPublication });
  if (!sameActiveDeployment(first, second)) {
    operatorError("The active public Worker changed during activation proof");
  }

  return activateFn({
    firestore,
    proof: {
      schemaVersion: 1,
      buildBatchId: prepared.buildBatchId,
      generation: prepared.generation,
      commitSha: prepared.commitSha,
      deploymentId: second.deploymentId,
      versionId: second.versionId,
      publicationReceiptDigest: prepared.publicationReceiptDigest,
      publicReceiptUrl: PUBLIC_RECEIPT_URL,
    },
  });
}

function parseApplyArguments(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--apply" || !path.isAbsolute(args[1])) {
    operatorError(
      "Usage: npm run activate:public-media-lifecycle -- --apply <absolute-prepared-artifact-path>",
    );
  }
  return args[1];
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

function receiptTime(value: unknown): string {
  if (plainObject(value) && typeof value.toDate === "function") {
    const date = value.toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  operatorError("The public media lifecycle activation timestamp is invalid");
}

function projectResult(result: PublicMediaLifecycleActivationResult) {
  return {
    idempotent: result.idempotent,
    buildBatchId: result.receipt.buildBatchId,
    generation: result.receipt.generation,
    commitSha: result.receipt.commitSha,
    deploymentId: result.receipt.deploymentId,
    versionId: result.receipt.versionId,
    publicationReceiptDigest: result.receipt.publicationReceiptDigest,
    publicReceiptUrl: result.receipt.publicReceiptUrl,
    activatedAt: receiptTime(result.receipt.activatedAt),
  };
}

export function assertProductionFirestoreRouting(
  environment: NodeJS.ProcessEnv,
): void {
  if (Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST")) {
    operatorError("The Firestore emulator route is not allowed");
  }
}

function controlledErrorMessage(error: unknown): string {
  if (error instanceof PublicMediaLifecycleActivationOperatorError || error instanceof CloudflareConfigurationError) {
    return error.message;
  }
  return "The operation failed; no unverified media activation was settled";
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let app: App | undefined;
  try {
    assertProductionFirestoreRouting(process.env);
    const preparedPath = parseApplyArguments(args);
    const cloudflareWorkerApiToken = parseCloudflareToken(
      readFileSync(CLOUDFLARE_WORKER_CREDENTIAL_FD, "utf8"),
    );
    const cloudflareRouteApiToken = parseCloudflareToken(
      readFileSync(CLOUDFLARE_ROUTE_CREDENTIAL_FD, "utf8"),
    );
    const serviceAccount = parseFirebaseServiceAccount(
      readFileSync(FIREBASE_CREDENTIAL_FD, "utf8"),
    );
    const preparedArtifact = await readPreparedArtifact(preparedPath);
    app = firebaseAdminRuntime.initializeApp({
      credential: firebaseAdminRuntime.cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID,
    }, "public-media-lifecycle-activation-operator");
    const result = await runPublicMediaLifecycleActivationOperator({
      firestore: firebaseAdminRuntime.getFirestore(app),
      cloudflareWorkerApiToken,
      cloudflareRouteApiToken,
      preparedArtifact,
    });
    process.stdout.write(`${JSON.stringify(projectResult(result))}\n`);
  } catch (error) {
    process.stderr.write(
      `Media lifecycle activation refused: ${controlledErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (app) await firebaseAdminRuntime.deleteApp(app).catch(() => {
      process.exitCode = 1;
    });
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
