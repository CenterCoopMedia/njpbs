// Seed the managed media-category registry before upload validation begins (#1293).
//
// Existing category ids are data, not names this migration may reinterpret. The seed
// discovers every id held by an asset or durable upload-recovery receipt, adds the two
// reserved categories, and creates only missing registry rows. Existing rows are verified
// and left untouched so a staff label, description, order or archived state is never
// reverted by a deployment.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import mediaCategories from "../functions/lib/media-categories.js";

const SYSTEM_ACTOR = "system:media-category-seed";
const MAX_CATEGORIES_PER_TRANSACTION = 250;
const {
  MEDIA_CATEGORIES_COLLECTION,
  SEEDED_MEDIA_CATEGORIES,
  normalizeMediaCategoryId,
  parseMediaCategoryDefinition,
} = mediaCategories;

function labelFromId(id) {
  return id
    .split("-")
    .map((word) => word.charAt(0).toLocaleUpperCase("en-US") + word.slice(1))
    .join(" ");
}

function categoryRecord(category, nowIso) {
  return {
    id: category.id,
    label: category.label,
    description: category.description,
    order: category.order,
    active: true,
    version: 1,
    createdAt: nowIso,
    createdBy: SYSTEM_ACTOR,
    updatedAt: nowIso,
    updatedBy: SYSTEM_ACTOR,
  };
}

async function referencedCategoryIds(firestore) {
  const [assets, receipts] = await Promise.all([
    firestore.collection("media_assets").select("category", "categories").get(),
    firestore
      .collectionGroup("hashOwners")
      .select("category", "recordSeed.metadata.categories")
      .get(),
  ]);
  const ids = new Set();
  for (const document of [...assets.docs, ...receipts.docs]) {
    const data = document.data();
    const values = [
      data?.category,
      ...(Array.isArray(data?.categories) ? data.categories : []),
      ...(Array.isArray(data?.recordSeed?.metadata?.categories)
        ? data.recordSeed.metadata.categories
        : []),
    ];
    for (const value of values) {
      if (typeof value !== "string") continue;
      try {
        ids.add(normalizeMediaCategoryId(value));
      } catch {
        throw new Error(
          `Stored media record ${document.ref.path} has an invalid category id`,
        );
      }
    }
  }
  return ids;
}

export async function seedMediaCategories({
  firestore,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new Error("The media category seed timestamp is invalid");
  }

  const reserved = new Map(
    SEEDED_MEDIA_CATEGORIES.map((category) => [category.id, category]),
  );
  const discovered = await referencedCategoryIds(firestore);
  const ids = new Set([...reserved.keys(), ...discovered]);
  const planned = [...ids].sort().map((id, index) => {
    const seed = reserved.get(id) ?? {
      id,
      label: labelFromId(id),
      description: "Migrated from an existing media record.",
      order: 1_000 + index * 10,
    };
    return {
      ref: firestore.collection(MEDIA_CATEGORIES_COLLECTION).doc(id),
      record: categoryRecord(seed, nowIso),
    };
  });

  const result = { created: 0, verified: 0 };
  for (
    let offset = 0;
    offset < planned.length;
    offset += MAX_CATEGORIES_PER_TRANSACTION
  ) {
    const chunk = planned.slice(
      offset,
      offset + MAX_CATEGORIES_PER_TRANSACTION,
    );
    const chunkResult = await firestore.runTransaction(async (transaction) => {
      const snapshots = await Promise.all(
        chunk.map((entry) => transaction.get(entry.ref)),
      );
      let verified = 0;
      const missing = [];
      for (const [index, entry] of chunk.entries()) {
        const snapshot = snapshots[index];
        if (!snapshot.exists) {
          missing.push(entry);
          continue;
        }
        if (!parseMediaCategoryDefinition(snapshot.id, snapshot.data())) {
          throw new Error(
            `Existing media category ${entry.record.id} is invalid`,
          );
        }
        verified += 1;
      }

      for (const entry of missing) {
        transaction.create(entry.ref, entry.record);
        transaction.create(firestore.collection("admin_logs").doc(), {
          actorUid: SYSTEM_ACTOR,
          actorEmail: null,
          action: "media.category.seed",
          target: `${MEDIA_CATEGORIES_COLLECTION}/${entry.record.id}`,
          before: null,
          after: {
            id: entry.record.id,
            label: entry.record.label,
            active: true,
            version: 1,
          },
          source: "cms_staging_deploy",
          timestamp: FieldValue.serverTimestamp(),
          at: nowIso,
        });
      }
      return { created: missing.length, verified };
    });
    result.created += chunkResult.created;
    result.verified += chunkResult.verified;
  }
  return result;
}

export async function verifyMediaCategoriesRegistered({ firestore } = {}) {
  if (!firestore || typeof firestore.collection !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  const [registry, referenced] = await Promise.all([
    firestore.collection(MEDIA_CATEGORIES_COLLECTION).get(),
    referencedCategoryIds(firestore),
  ]);
  const registered = new Set();
  for (const document of registry.docs) {
    if (!parseMediaCategoryDefinition(document.id, document.data())) {
      throw new Error(`Media category ${document.id} is invalid`);
    }
    registered.add(document.id);
  }
  const required = new Set([
    ...SEEDED_MEDIA_CATEGORIES.map((category) => category.id),
    ...referenced,
  ]);
  const missing = [...required].filter((id) => !registered.has(id)).sort();
  if (missing.length > 0) {
    throw new Error(`The media category registry is missing ${missing.join(", ")}`);
  }
  return { registered: registered.size };
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  }
  const app = getApps()[0] || initializeApp({ projectId: "njpbs-site" });
  try {
    const firestore = getFirestore(app);
    const result = await seedMediaCategories({ firestore });
    console.log(
      `Media categories ready: ${result.created} created, ${result.verified} verified.`,
    );
    const verified = await verifyMediaCategoriesRegistered({ firestore });
    console.log(`Registry verified: ${verified.registered} categories readable.`);
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
