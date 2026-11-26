// The release's preview smoke opens one fixture record (CMS_PREVIEW_SMOKE_TARGET). An archived
// fixture has no Preview button, so the smoke cannot pass. On Nov. 23, 2026 the production fixture
// was archived by hand in a cleanup of test posts, and the Nov. 25 release waited on it. The seed
// step restores it to draft the way Boardwalk's restore does, with its history and audit rows.
// Any other state is left alone: the smoke reports it.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { editorPath } from "./lib/cms-development-settings.mjs";

const SYSTEM_ACTOR = "system:preview-smoke-fixture-seed";
const COLLECTIONS = { post: "cmsPosts", pages: "cmsPages" };

/** The fixture's collection and id, or null when no smoke target is set. */
export function smokeFixture(target) {
  if (!target) return null;
  const { editor } = JSON.parse(target);
  if (typeof editor !== "string" || !editorPath.test(editor)) throw new Error("CMS_PREVIEW_SMOKE_TARGET must hold an editor path");
  const [, , kind, id] = editor.split("/");
  return { collection: COLLECTIONS[kind], id };
}

export async function restorePreviewSmokeFixture({ firestore, fixture, now = () => new Date().toISOString() }) {
  // Load the audit owner after the app exists; it reuses that app.
  const { default: audit } = await import("../functions/lib/audit.js");
  const { retiredRecordKindError } = (await import("../functions/lib/content-library.js")).default;
  const { MAX_DOCUMENT_BYTES, firestoreDocumentBytes } = (await import("../functions/lib/document-size.js")).default;
  const ref = firestore.collection(fixture.collection).doc(fixture.id);
  return firestore.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return "missing";
    const current = snapshot.data();
    if (current.status !== "archived") return current.status;
    // Boardwalk's restore refuses a retired record type (lifecycle-transition.js); so does this.
    if (retiredRecordKindError(current.type)) return "archived with a retired type";
    const changed = { ...current, status: "draft", publiclyVisible: false, updatedAt: now(), updatedBy: SYSTEM_ACTOR,
      // A restore keeps the editorial version (functions/lib/content-version.js).
      version: current.version + 1, contentVersion: Number.isSafeInteger(current.contentVersion) && current.contentVersion >= 1 ? current.contentVersion : current.version };
    tx.set(ref, changed);
    // The full `before` when the row fits; otherwise its receipt form, as lifecycle-transition.js does.
    const historyRef = firestore.collection(audit.AUDIT_COLLECTIONS.versionHistory).doc();
    const entry = before => audit.versionHistoryEntry({ collection: fixture.collection, documentId: fixture.id, action: "restore",
      before, after: changed, actorUid: SYSTEM_ACTOR });
    const full = entry(current);
    tx.set(historyRef, firestoreDocumentBytes(full, historyRef.path) <= MAX_DOCUMENT_BYTES ? full
      : { ...entry({ status: current.status, version: current.version, beforeTruncated: true }), beforeTruncated: true });
    tx.set(firestore.collection(audit.AUDIT_COLLECTIONS.adminLogs).doc(), audit.adminLogEntry({
      actorUid: SYSTEM_ACTOR, action: "cms.restore", target: `${fixture.collection}/${fixture.id}`,
      before: { status: current.status, version: current.version }, after: { status: changed.status, version: changed.version } }));
    return "restored";
  });
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  const fixture = smokeFixture(process.env.CMS_PREVIEW_SMOKE_TARGET);
  if (!fixture) return console.log("No preview smoke fixture is set");
  const app = getApps()[0] || initializeApp(); // deploy-cms.mjs sets the target project
  try {
    const state = await restorePreviewSmokeFixture({ firestore: getFirestore(app), fixture });
    console.log(state === "restored" ? "Preview smoke fixture restored from archived to draft" : `Preview smoke fixture is ${state}`);
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
