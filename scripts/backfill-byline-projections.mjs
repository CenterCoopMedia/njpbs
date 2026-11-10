// Build the narrow byline read model from every private author profile before
// the Worker begins serving it. The same transactional writer maintains it
// after this one-time pass, and rerunning the pass is safe.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import projectionPkg from "../functions/lib/byline-projection.js";

const { syncBylineProjection } = projectionPkg;
const PAGE_SIZE = 200;

export async function backfillBylineProjections({ firestore }) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }

  let cursor = null;
  let synced = 0;
  while (true) {
    let query = firestore.collection("cmsAuthorProfiles")
      .orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();

    for (const source of page.docs) {
      await firestore.runTransaction(async (transaction) => {
        const current = await transaction.get(source.ref);
        if (!current.exists) {
          syncBylineProjection(transaction, firestore, source.id, null);
          return;
        }
        const profile = current.data();
        const staffSnapshot = typeof profile.uid === "string"
          ? await transaction.get(firestore.collection("cmsStaffRecords").doc(profile.uid))
          : null;
        syncBylineProjection(
          transaction,
          firestore,
          source.id,
          profile,
          staffSnapshot?.exists ? staffSnapshot.data() : null,
        );
      });
      synced += 1;
    }

    if (page.docs.length < PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1].id;
  }
  return { synced };
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  }
  const app = getApps()[0] || initializeApp({ projectId: "njpbs-site" });
  try {
    const result = await backfillBylineProjections({ firestore: getFirestore(app) });
    console.log(`Byline projections ready: ${result.synced} profiles synced.`);
  } finally {
    await deleteApp(app);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
