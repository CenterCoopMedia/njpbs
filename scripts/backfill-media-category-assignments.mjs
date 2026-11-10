// Materialize the #1294 assignment array without changing the owning category,
// version, object identity, URL, content hash, lifecycle, or usage records.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";
import mediaContract from "../functions/lib/media-contract.js";
import mediaDiscovery from "../functions/lib/media-discovery.js";

const SYSTEM_ACTOR = "system:media-category-assignment-backfill";
const PAGE_SIZE = 100;
const { normalizeMediaCategoryAssignments } = mediaContract;
const { bumpMediaDiscoveryRevision, deriveMediaDiscovery } = mediaDiscovery;

function normalizedCategories(document) {
  const stored = document.data();
  try {
    return normalizeMediaCategoryAssignments(stored.categories, stored.category);
  } catch (error) {
    throw new Error(
      `Media asset ${document.id} has invalid category assignments: ${error.message}`,
    );
  }
}

async function migrateMissingAssignments({ firestore, reference, nowIso }) {
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return { migrated: 0, verified: 0 };

    const stored = snapshot.data();
    const categories = normalizedCategories(snapshot);
    if (stored.categories !== undefined) return { migrated: 0, verified: 1 };

    transaction.update(snapshot.ref, {
      categories,
      mediaDiscovery: deriveMediaDiscovery(snapshot.id, {
        ...stored,
        categories,
      }),
    });
    transaction.create(
      firestore.collection("admin_logs").doc(),
      {
        actorUid: SYSTEM_ACTOR,
        actorEmail: null,
        action: "media.categories.backfill",
        target: `media_assets/${snapshot.id}`,
        before: { category: stored.category, categories: null },
        after: { category: stored.category, categories },
        source: "cms_staging_deploy",
        timestamp: FieldValue.serverTimestamp(),
        at: nowIso,
      },
    );
    bumpMediaDiscoveryRevision(transaction, firestore);
    return { migrated: 1, verified: 0 };
  });
}

export async function backfillMediaCategoryAssignments({
  firestore,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new Error("The media category assignment timestamp is invalid");
  }

  let cursor = null;
  let migrated = 0;
  let verified = 0;
  do {
    let query = firestore
      .collection("media_assets")
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;

    const candidates = [];
    for (const document of page.docs) {
      if (document.data().categories === undefined) {
        candidates.push(document.ref);
        continue;
      }
      normalizedCategories(document);
      verified += 1;
    }
    for (const reference of candidates) {
      const result = await migrateMissingAssignments({
        firestore,
        reference,
        nowIso,
      });
      migrated += result.migrated;
      verified += result.verified;
    }
    cursor = page.docs.at(-1).id;
  } while (cursor !== null);

  return { migrated, verified };
}

export async function verifyMediaCategoryAssignments({ firestore } = {}) {
  if (!firestore || typeof firestore.collection !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  const snapshot = await firestore.collection("media_assets").get();
  for (const document of snapshot.docs) {
    const stored = document.data();
    if (stored.categories === undefined) {
      throw new Error(`Media asset ${document.id} has no category assignments`);
    }
    normalizedCategories(document);
  }
  return { verified: snapshot.size };
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  }
  const app = getApps()[0] || initializeApp({ projectId: "njpbs-site" });
  try {
    const firestore = getFirestore(app);
    const result = await backfillMediaCategoryAssignments({ firestore });
    console.log(
      `Media assignments ready: ${result.migrated} migrated, ${result.verified} verified.`,
    );
    const verification = await verifyMediaCategoryAssignments({ firestore });
    console.log(`Assignments verified: ${verification.verified} media assets.`);
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
