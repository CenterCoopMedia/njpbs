import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Firestore } from "firebase-admin/firestore";
import { parseBlocks } from "../packages/content-core/src/content-model";
import { visibleLayoutBlocks } from "../packages/content-core/src/content-layout";
import { validateSection } from "../packages/content-core/src/editor-admin";
import { isCustomPageId } from "../packages/content-core/src/public-pages";
import mediaUsage from "../functions/lib/media-usage.js";
import documentSize from "../functions/lib/document-size.js";
import pageReaders from "../functions/lib/page-reader-compatibility.js";

const ACTOR = "system:newsletters-signup";
class MigrationRefusal extends Error {}

/** Preserve all staff payloads and existing signup placement, including hidden planks. */
export function planNewslettersSignup(document: Record<string, unknown>) {
  if (document.slug !== "newsletters" || document.template !== "genericPage" || document.deleted === true) {
    throw new MigrationRefusal("Expected the saved newsletters Page");
  }
  if (!Number.isSafeInteger(document.version) || Number(document.version) < 1 || document.version === Number.MAX_SAFE_INTEGER ||
      document.contentVersion !== undefined && (!Number.isSafeInteger(document.contentVersion) || Number(document.contentVersion) < 1 || document.contentVersion === Number.MAX_SAFE_INTEGER)) {
    throw new MigrationRefusal("Page requires safely incrementable saved versions");
  }
  if (!["draft", "published"].includes(String(document.status)) || document.publishBuildPending === true) {
    throw new MigrationRefusal("Page has a publication in progress or unsupported status");
  }
  const parsed = parseBlocks(document.blocks, { complete: false });
  if (!parsed.ok) throw new MigrationRefusal(parsed.error);
  if (parsed.blocks.some(block => block.type === "embed_anchor")) return { changed: false, blocks: structuredClone(parsed.blocks) };
  const intro = visibleLayoutBlocks(parsed.blocks).find(block => block.type === "prose");
  if (!intro) throw new MigrationRefusal("Review the Page introduction before migrating");
  const introGroup = intro.layout?.rowId ?? intro.id;
  const start = parsed.blocks.findIndex(block => block.id === introGroup);
  let after = start + 1;
  if (intro.layout) while (after < parsed.blocks.length && parsed.blocks[after].layout?.rowId === introGroup) after++;
  const id = "newsletters-signup";
  if (parsed.blocks.some(block => block.id === id)) throw new MigrationRefusal("Signup plank id already belongs to staff content");
  const blocks = structuredClone(parsed.blocks);
  blocks.splice(after, 0, { id, type: "embed_anchor", order: after, visible: true, data: { anchorId: "njpbssignup" } });
  const arranged = blocks.map((block, order) => ({ ...block, order }));
  const result = parseBlocks(arranged, { complete: false });
  if (!result.ok) throw new MigrationRefusal(result.error);
  const placement = validateSection("genericPage", result.blocks);
  if (placement) throw new MigrationRefusal(placement.detail);
  return { changed: true, blocks: result.blocks };
}

/** Save only the working draft under the existing Page version/lease contract. */
export async function applyNewslettersSignup(firestore: Firestore, pageId: string, expectedVersion: number, now = new Date()) {
  if (!isCustomPageId(pageId)) throw new MigrationRefusal("Explicit custom Page id required");
  const { FieldValue } = await import("firebase-admin/firestore");
  return firestore.runTransaction(async transaction => {
    const ref = firestore.collection("cmsPages").doc(pageId);
    const historyRef = firestore.collection("cmsVersionHistory").doc(`newsletters-signup-${pageId}`);
    const lockRef = firestore.collection("cmsEditorLocks").doc(`cmsPages:${pageId}`);
    const [snapshot, history, lock] = await transaction.getAll(ref, historyRef, lockRef);
    // A retained revision also prevents a rerun from restoring a plank staff removed.
    if (history.exists) return { changed: false, reason: "already-migrated" };
    if (!snapshot.exists) throw new MigrationRefusal("Newsletters Page is missing");
    const document = snapshot.data()!;
    if (document.version !== expectedVersion) throw new MigrationRefusal("Page changed; review its current saved version");
    const plan = planNewslettersSignup(document);
    if (!plan.changed) return { changed: false, reason: "signup-already-present" };
    if (lock.exists) {
      const lease = lock.data()!;
      const heartbeat = lease.heartbeatAt?.toMillis?.();
      const released = Number.isFinite(lease.releasedAt?.toMillis?.()) && lease.heartbeatAt === undefined;
      if (!released && (!Number.isFinite(heartbeat) || now.getTime() - heartbeat < 120_000)) {
        throw new MigrationRefusal("Close the active Page editor before migrating");
      }
    }
    await pageReaders.assertInstalledPageReaders({ firestore, transaction, pageId, blocks: plan.blocks, preview: true });
    const patch = { blocks: plan.blocks, status: "draft", version: expectedVersion + 1,
      contentVersion: Number(document.contentVersion ?? expectedVersion) + 1, updatedAt: now.toISOString(), updatedBy: ACTOR };
    const next = { ...document, ...patch };
    const revision = { collection: "cmsPages", documentId: pageId, action: "newsletters-signup",
      before: document, after: next, userId: ACTOR, userEmail: null,
      source: "reviewed_operator_migration", at: now.toISOString(), timestamp: FieldValue.serverTimestamp() };
    for (const [value, path] of [[next, ref.path], [revision, historyRef.path]] as const) {
      const error = documentSize.documentSizeError(value, path, { label: "Newsletters signup draft" });
      if (error) throw new MigrationRefusal(error.reason);
    }
    const usage = mediaUsage.collectWorkingMediaUsage({ collection: "cmsPages", documentId: pageId, document: next });
    const receipt = await mediaUsage.prepareMediaUsageWrite({ firestore, transaction, collection: "cmsPages",
      documentId: pageId, state: "working", sourceVersion: patch.version, usage });
    transaction.update(ref, patch);
    transaction.create(historyRef, revision);
    transaction.set(receipt.ref, receipt.document);
    transaction.create(firestore.collection("admin_logs").doc(), { actorUid: ACTOR, actorEmail: null,
      action: "content.newsletters_signup_migrated", target: ref.path, before: { version: expectedVersion },
      after: { version: patch.version, status: "draft" }, source: "reviewed_operator_migration",
      at: now.toISOString(), timestamp: FieldValue.serverTimestamp() });
    return { changed: true, version: patch.version, status: "draft" };
  });
}

async function main(args: string[]) {
  if (args.length === 2 && args[0] === "--fixture") {
    const document = JSON.parse(await readFile(resolve(args[1]), "utf8"));
    const plan = planNewslettersSignup(document);
    return { mode: "dry-run", changed: plan.changed, version: document.version,
      blocks: plan.blocks.map(block => ({ id: block.id, type: block.type, visible: block.visible, order: block.order })) };
  }
  const [mode, projectId, pageId, versionText] = args;
  const expectedVersion = Number(versionText);
  if (args.length !== 4 || !["--read", "--apply"].includes(mode) || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) ||
      !isCustomPageId(pageId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new MigrationRefusal("Use --fixture <saved-page.json> or --read|--apply <project-id> <page-id> <saved-version>; service-account JSON on fd 3");
  }
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new MigrationRefusal("Supply the explicit project's service-account JSON on fd 3 without credential-file or emulator settings");
  }
  let bytes = "";
  for await (const chunk of createReadStream("", { fd: 3, autoClose: false, encoding: "utf8" })) {
    bytes += chunk;
    if (Buffer.byteLength(bytes) > 16 * 1024) throw new MigrationRefusal("Invalid credential input");
  }
  let key;
  try { key = JSON.parse(bytes); } catch { throw new MigrationRefusal("Invalid credential input"); }
  bytes = "";
  if (key.type !== "service_account" || key.project_id !== projectId || typeof key.client_email !== "string" ||
      !key.client_email.endsWith(".gserviceaccount.com") || typeof key.private_key !== "string" || !key.private_key.includes("BEGIN PRIVATE KEY")) {
    throw new MigrationRefusal("Credential project does not match the explicit target");
  }
  const { cert, initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ projectId, credential: cert(key) }, "newsletters-signup");
  key = undefined;
  try {
    const firestore = getFirestore(app);
    if (mode === "--apply") return await applyNewslettersSignup(firestore, pageId, expectedVersion);
    const snapshot = await firestore.collection("cmsPages").doc(pageId).get();
    if (!snapshot.exists || snapshot.data()!.version !== expectedVersion) throw new MigrationRefusal("Review the current saved Page version");
    const plan = planNewslettersSignup(snapshot.data()!);
    return { mode: "dry-run", changed: plan.changed, version: expectedVersion,
      blocks: plan.blocks.map(block => ({ id: block.id, type: block.type, visible: block.visible, order: block.order })) };
  } finally { await deleteApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`${error instanceof MigrationRefusal ? error.message : "Migration failed; no publication was requested"}\n`);
    process.exitCode = 1;
  });
}
