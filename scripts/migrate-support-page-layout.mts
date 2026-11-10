import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// firebase-admin loads only on paths that reach Firestore, so the fixture dry-run
// works where only the site dependencies are installed.
import type { ServiceAccount } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { planSupportPageComposition } from "../packages/content-core/src/support-page-composition";
import mediaUsage from "../functions/lib/media-usage.js";
import documentSize from "../functions/lib/document-size.js";

export const PROJECT_ID = "njpbs-site";
const ACTOR = "system:support-page-layout";
class MigrationRefusal extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function reviewSupportMigration(document: Record<string, unknown>) {
  if (document.id !== undefined && document.id !== "support") throw new MigrationRefusal("Only cmsPages/support can be migrated");
  if (document.template !== undefined && document.template !== "programLanding") throw new MigrationRefusal("Unexpected support template");
  if (document.deleted === true) throw new MigrationRefusal("Support is deleted");
  if (!Number.isSafeInteger(document.version) || Number(document.version) < 1) throw new MigrationRefusal("Support requires a saved version");
  if (document.contentVersion !== undefined && (!Number.isSafeInteger(document.contentVersion) || Number(document.contentVersion) < 1)) {
    throw new MigrationRefusal("Support has an invalid contentVersion");
  }
  if (!["draft", "published"].includes(String(document.status)) || document.publishBuildPending === true) {
    throw new MigrationRefusal("Support must be a draft or published page with no publication in progress");
  }
  if (document.status === "published" && typeof document.publiclyVisible !== "boolean") {
    throw new MigrationRefusal("Legacy public visibility must be reviewed before migrating");
  }
  if (document.version === Number.MAX_SAFE_INTEGER || document.contentVersion === Number.MAX_SAFE_INTEGER) {
    throw new MigrationRefusal("Support version cannot be incremented safely");
  }
  let plan;
  try { plan = planSupportPageComposition(document); }
  catch (error) { throw new MigrationRefusal(error instanceof Error ? error.message : "Support composition is invalid"); }
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ document, plan }))).digest("hex");
  return { ...plan, fingerprint, fromVersion: document.version as number };
}

export function parseMigrationArgs(args: string[]) {
  let apply = false;
  let fixture: string | undefined;
  let expectedPlan: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply" && !apply) apply = true;
    else if ((arg === "--fixture" && !fixture) || (arg === "--expected-plan" && !expectedPlan)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new MigrationRefusal(`Missing value for ${arg}`);
      if (arg === "--fixture") fixture = value;
      else expectedPlan = value;
    } else throw new MigrationRefusal(`Unknown or repeated argument: ${arg}`);
  }
  if (fixture && apply) throw new MigrationRefusal("Fixture mode is read-only");
  if (apply && !/^[a-f0-9]{64}$/.test(expectedPlan ?? "")) throw new MigrationRefusal("--apply requires the fingerprint from a reviewed dry-run with --expected-plan");
  return { apply, fixture, expectedPlan };
}

export function parseFirebaseKey(bytes: string): ServiceAccount {
  if (Buffer.byteLength(bytes) > 16 * 1024) throw new MigrationRefusal("Invalid Firebase key on stdin");
  let key;
  try { key = JSON.parse(bytes); } catch { throw new MigrationRefusal("Invalid Firebase key on stdin"); }
  if (key?.type !== "service_account" || key.project_id !== PROJECT_ID ||
    typeof key.client_email !== "string" || !key.client_email.endsWith(".gserviceaccount.com") ||
    typeof key.private_key !== "string" || !key.private_key.includes("BEGIN PRIVATE KEY")) {
    throw new MigrationRefusal("Expected an njpbs-site Firebase service-account key on stdin");
  }
  return key;
}

function summary(plan: ReturnType<typeof reviewSupportMigration>, mode: "dry-run" | "applied-draft" | "already-migrated" = "dry-run") {
  return {
    mode, target: "cmsPages/support",
    changed: plan.changed, fromVersion: plan.fromVersion,
    toVersion: plan.changed ? plan.fromVersion + 1 : plan.fromVersion,
    fingerprint: plan.fingerprint, insertedIds: plan.insertedIds, retainedIds: plan.retainedIds,
    blockOrder: plan.blocks.map(block => ({ id: block.id, type: block.type, visible: block.visible })),
  };
}

export async function applySupportMigration(firestore: Firestore, expectedPlan: string, now = new Date()) {
  const { FieldValue } = await import("firebase-admin/firestore");
  return firestore.runTransaction(async transaction => {
    const ref = firestore.collection("cmsPages").doc("support");
    const lockRef = firestore.collection("cmsEditorLocks").doc("cmsPages:support");
    const [snapshot, lock] = await transaction.getAll(ref, lockRef);
    if (!snapshot.exists) throw new MigrationRefusal("cmsPages/support is missing; save a support draft first");
    const document = snapshot.data()!;
    const plan = reviewSupportMigration(document);
    if (!plan.changed) return summary(plan, "already-migrated");
    if (plan.fingerprint !== expectedPlan) throw new MigrationRefusal("Support changed after the reviewed dry-run; review a fresh dry-run");
    if (lock.exists) {
      const data = lock.data()!;
      const heartbeat = data.heartbeatAt?.toMillis?.();
      const releasedAt = data.releasedAt?.toMillis?.();
      const released = Number.isFinite(releasedAt) && data.heartbeatAt === undefined;
      if (!released && (!Number.isFinite(heartbeat) || now.getTime() - heartbeat < 120_000)) {
        throw new MigrationRefusal("Close the active support editor before applying the migration");
      }
    }
    const next = { ...document, blocks: plan.blocks, serviceCompositionVersion: 1,
      status: "draft", version: plan.fromVersion + 1,
      contentVersion: Number.isSafeInteger(document.contentVersion) && document.contentVersion >= 1
        ? document.contentVersion + 1 : plan.fromVersion + 1,
      updatedAt: now.toISOString(), updatedBy: ACTOR };
    const historyRef = firestore.collection("cmsVersionHistory").doc();
    const history = { collection: "cmsPages", documentId: "support", action: "support-page-layout",
      before: document, after: next, userId: ACTOR, userEmail: null,
      source: "reviewed_operator_migration", at: now.toISOString(), timestamp: FieldValue.serverTimestamp() };
    for (const [value, path, label] of [[next, ref.path, "support draft"], [history, historyRef.path, "support revision"]] as const) {
      const error = documentSize.documentSizeError(value, path, { label });
      if (error) throw new MigrationRefusal(error.reason);
    }
    const usage = mediaUsage.collectWorkingMediaUsage({ collection: "cmsPages", documentId: "support", document: next });
    const receipt = await mediaUsage.prepareMediaUsageWrite({ firestore, transaction, collection: "cmsPages",
      documentId: "support", state: "working", sourceVersion: next.version, usage });
    // All reads finish before any write. No published snapshot, public receipt,
    // visibility flag, publish queue or scheduler record is changed.
    transaction.update(ref, { blocks: next.blocks, serviceCompositionVersion: 1, status: "draft",
      version: next.version, contentVersion: next.contentVersion, updatedAt: next.updatedAt, updatedBy: ACTOR });
    transaction.create(historyRef, history);
    transaction.set(receipt.ref, receipt.document);
    transaction.create(firestore.collection("admin_logs").doc(), { actorUid: ACTOR, actorEmail: null,
      action: "content.support_layout_migrated", target: "cmsPages/support",
      before: { version: plan.fromVersion, status: document.status },
      after: { version: next.version, status: "draft", fingerprint: plan.fingerprint },
      source: "reviewed_operator_migration", at: now.toISOString(), timestamp: FieldValue.serverTimestamp() });
    return summary(plan, "applied-draft");
  });
}

export async function runSupportMigration(args: string[]) {
  const options = parseMigrationArgs(args);
  if (options.fixture) return summary(reviewSupportMigration(JSON.parse(await readFile(resolve(options.fixture), "utf8"))));
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new MigrationRefusal("Remove credential-file and emulator environment variables; the Firebase key is accepted only on stdin");
  }
  if (process.stdin.isTTY) throw new MigrationRefusal("Provide the Firebase key on stdin");
  let bytes = "";
  for await (const chunk of process.stdin) {
    bytes += chunk;
    if (Buffer.byteLength(bytes) > 16 * 1024) throw new MigrationRefusal("Invalid Firebase key on stdin");
  }
  const { cert, deleteApp, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ projectId: PROJECT_ID, credential: cert(parseFirebaseKey(bytes)) }, "support-page-layout");
  bytes = "";
  try {
    const firestore = getFirestore(app);
    if (options.apply) return await applySupportMigration(firestore, options.expectedPlan!);
    const snapshot = await firestore.collection("cmsPages").doc("support").get();
    if (!snapshot.exists) throw new MigrationRefusal("cmsPages/support is missing; save a support draft first");
    return summary(reviewSupportMigration(snapshot.data()!));
  } finally { await deleteApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSupportMigration(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    // SDK exceptions can carry credential/request internals. Keep the CLI failure
    // bounded; pure planner errors are exposed by fixture tests and dry-run review.
    process.stderr.write(`Support migration refused: ${error instanceof MigrationRefusal ? error.message : "Firebase read or transaction failed; check operator access and try a fresh dry-run"}. No publication was requested.\n`);
    process.exitCode = 1;
  });
}
