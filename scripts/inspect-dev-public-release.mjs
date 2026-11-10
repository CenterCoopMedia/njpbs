import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseDevOperatorCredential } from "./lib/dev-proof-admission.mjs";
import protocol from "../functions/lib/public-release-pair.js";
import pairs from "../functions/lib/public-release-pair-work.js";
import preview from "../functions/lib/cms-preview-pair.js";
import runtime from "../functions/lib/cms-publication-runtime-control.js";
import coordinator from "../functions/lib/public-deployment-coordinator.js";

const require = createRequire(import.meta.url);
const PROJECT = "njpbs-site-dev";
const ROOT = "system/publicDeployment";
const FIXED = [ROOT, "system/devPublication", "system/publicReleasePairs", runtime.RUNTIME_DOCUMENT_PATH, preview.SELECTOR_PATH,
  "system/publicReleaseChangeLog", "system/publicReleaseChanges", "system/publicReleaseAdmissions",
  "system/noBuildPostAdmission", "system/billing", "cmsDeploymentReceipts/adminManifest"];
const AMBIENT = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST",
  "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG"];
const SAFE_REFUSALS = new Set(["dev_inventory_target_required", "dev_inventory_explicit_stdin_required",
  "dev_inventory_wrong_database", "dev_inventory_pair_limit_exceeded", "dev_inventory_credential_required"]);

function refuse(code) { throw new Error(code); }

function legacyProjection(parsed) {
  const fields = {};
  for (const key of ["state", "activeGeneration", "activeCommitSha", "lastReservedGeneration",
    "newestEligibleGeneration", "newestEligibleBuildBatchId", "candidateGeneration", "candidateBuildBatchId",
    "candidateCommitSha", "predecessorGeneration", "predecessorCommitSha", "cloudflareEvidenceDigest"])
    if (Object.hasOwn(parsed, key)) fields[key] = parsed[key];
  for (const key of ["updatedAt", "leaseAcquiredAt", "reconcilingAt"])
    if (parsed[key]) fields[key] = new Date(parsed[key].toMillis()).toISOString();
  return fields;
}

function reconciliationFields(value) {
  const fields = {};
  if (["reserved", "ready", "deploying", "reconciling", "deployed", "failed", "cancelled", "queued", "running", "success",
    "pending", "publishing", "runtime_confirmed", "public_unconfirmed", "superseded"].includes(value?.status))
    fields.status = value.status;
  for (const key of ["generation", "attempts", "runId", "runAttempt"])
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) fields[key] = value[key];
  for (const key of ["commitSha", "inputDigest", "artifactDigest", "cloudflareEvidenceDigest"])
    if (typeof value?.[key] === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[key])) fields[key] = value[key];
  if (typeof value?.workerVersionId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.workerVersionId))
    fields.workerVersionId = value.workerVersionId;
  for (const key of ["reservedAt", "readyAt", "leaseAcquiredAt", "reconcilingAt", "recordedAt", "updatedAt", "triggeredAt", "completedAt"])
    if (typeof value?.[key]?.toMillis === "function" && Number.isFinite(value[key].toMillis()))
      fields[key] = new Date(value[key].toMillis()).toISOString();
  return fields;
}

export function assertDevInventoryArguments(args, env, isTTY) {
  if (args.length !== 3 || args[0] !== "--project" || args[1] !== PROJECT || args[2] !== "--read-only")
    refuse("dev_inventory_target_required");
  // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GOOGLE_APPLICATION_CREDENTIALS
  if (isTTY || AMBIENT.some(key => env[key] !== undefined)) refuse("dev_inventory_explicit_stdin_required");
}

// A projection is an observation, never a readiness, qualification or install receipt.
// Unknown/raw document fields and provider error text must not cross stdout.
export function projectDevReleaseDocument(path, value) {
  if (value === undefined) return { path, status: "absent" };
  try {
    if (path === ROOT) {
      const parsed = protocol.parseVersionedPublicDeployment(value);
      return parsed.schemaVersion === 2
        ? { path, status: "valid-schema-two", selector: parsed, digest: protocol.publicReleaseDigest(parsed) }
        : { path, status: "valid-legacy", ...legacyProjection(parsed) };
    }
    if (path === runtime.RUNTIME_DOCUMENT_PATH)
      return { path, status: "parsed", runtime: runtime.parseCmsPublicationRuntimeControl(value) };
    if (path === preview.SELECTOR_PATH)
      return { path, status: "parsed", selector: preview.parseSelector(value) };
    if (path.startsWith("system/publicReleasePairs/entries/") && path.split("/").length === 4) {
      const pair = protocol.parsePublicReleasePair(value);
      if (pair.environment !== "development" || path !== pairs.publicReleasePairPath(pair.pairId)) refuse("invalid_pair");
      pairs.assertPrivatePairResources(pair);
      return { path, status: "parsed", pair, digest: protocol.publicReleaseDigest(pair) };
    }
  } catch {
    return { path, status: "invalid-or-other-schema" };
  }
  if (/^system\/publicDeployment\/buildBatches\/cms-[A-Za-z0-9]{20}(?:\/(?:candidates\/worker|inputs\/devFrozen))?$/.test(path) ||
      /^cmsPublishQueue\/[A-Za-z0-9]{20}$/.test(path))
    return { path, status: "present-unvalidated", fields: reconciliationFields(value) };
  // These controls require their owners' full validation before any operation.
  // Do not emit unchecked strings, source bodies, tokens or arbitrary map keys.
  const fields = {};
  for (const key of ["schemaVersion", "sequence", "revision", "admissionSequence"])
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) fields[key] = value[key];
  for (const key of ["enabled", "disabled", "paused"])
    if (typeof value?.[key] === "boolean") fields[key] = value[key];
  if (["candidate", "retained", "retired"].includes(value?.status)) fields.status = value.status;
  return { path, status: "present-unvalidated", fields };
}

function observation(row) {
  return { ...projectDevReleaseDocument(row.ref.path, row.exists ? row.data() : undefined),
    readAt: row.readTime.toDate().toISOString() };
}

export async function collectDevReleaseInventory(firestore) {
  if (firestore.projectId !== PROJECT) refuse("dev_inventory_wrong_database");
  const startedAt = new Date().toISOString();
  const rows = await firestore.getAll(...FIXED.map(path => firestore.doc(path)));
  const originalRoot = observation(rows[0]);
  const pending = originalRoot.status === "valid-legacy" &&
    /^cms-[A-Za-z0-9]{20}$/.test(originalRoot.candidateBuildBatchId ?? "") ? originalRoot.candidateBuildBatchId : null;
  const legacyPublication = [];
  if (pending) {
    const batch = coordinator.publicBuildBatchRef(firestore, pending);
    const found = await firestore.getAll(batch, coordinator.publicWorkerCandidateRef(firestore, pending),
      batch.collection("inputs").doc("devFrozen"), firestore.doc(`cmsPublishQueue/${pending.slice(4)}`));
    legacyPublication.push(...found.map(observation));
  }
  const entries = await firestore.collection("system/publicReleasePairs/entries").limit(9).get();
  if (entries.size > 8) refuse("dev_inventory_pair_limit_exceeded");
  const registered = entries.docs.map(observation);
  const controls = [];
  for (const entry of registered) {
    if (entry.status !== "parsed") continue;
    const base = pairs.publicReleasePairPath(entry.pair.pairId);
    const paths = [`${base}/controls/runtime`, `${base}/heads/current`, `${base}/seals/privateReader`];
    const found = await firestore.getAll(...paths.map(path => firestore.doc(path)));
    controls.push(...found.map(observation));
  }
  const finalRoot = observation(await firestore.doc(ROOT).get());
  return { schemaVersion: 1, kind: "read-only-development-inventory", projectId: PROJECT,
    startedAt, finishedAt: new Date().toISOString(),
    consistency: "Independent strong reads with root bookends; not an atomic snapshot or readiness proof",
    documents: rows.map(observation), legacyPublication, registeredPairs: registered, pairControls: controls, finalRoot };
}

async function readCredential(stream) {
  let input = "";
  const timeout = setTimeout(() => stream.destroy(new Error("credential_timeout")), 10_000);
  try {
    for await (const chunk of stream) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 32_768) refuse("dev_inventory_credential_required");
    }
    return parseDevOperatorCredential(input);
  } finally { clearTimeout(timeout); }
}

export async function main(args = process.argv.slice(2)) {
  assertDevInventoryArguments(args, process.env, process.stdin.isTTY);
  const account = await readCredential(process.stdin);
  const { cert, initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ projectId: PROJECT, credential: cert(account) }, `dev-inventory-${process.pid}`);
  try {
    const result = await collectDevReleaseInventory(getFirestore(app));
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { await deleteApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deadline = setTimeout(() => {
    process.stderr.write("dev_inventory_deadline_exceeded\n");
    process.exit(1);
  }, 60_000);
  main().catch(error => {
    process.stderr.write((SAFE_REFUSALS.has(error?.message) ? error.message : "dev_inventory_refused") + "\n");
    process.exitCode = 1;
  }).finally(() => clearTimeout(deadline));
}
