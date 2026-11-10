// Seed the content section registry and stamp the canonical pages that belong to it (#619).
//
// Two jobs, one transaction, because they are one fact: the registry is the finite list of
// editorial desks a scoped role grant may name, and a canonical page's desk is its area in
// the public page registry. Seeding one without the other leaves either a vocabulary that
// scopes nothing or pages scoped to desks that do not exist.
//
// Deliberately not in scope here: stored records. A record's desk is an editorial choice
// that cannot be inferred, so it is backfilled from an explicit mapping by
// scripts/backfill-record-sections.mjs. Legacy template singletons stay unsectioned.
//
// Idempotent: an existing registry row or page section that already matches is verified and
// left alone; one that disagrees with the repository stops the run rather than being
// overwritten, so a deliberate live edit is never silently reverted.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import contentSections from "../functions/lib/content-sections.js";
import publicPageContract from "../functions/lib/public-page-contract.js";

const SYSTEM_ACTOR = "system:content-section-seed";
const { CONTENT_SECTIONS_COLLECTION, SEEDED_CONTENT_SECTIONS } = contentSections;
const { PAGE_SECTIONS } = publicPageContract;

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sectionRecord(section, nowIso) {
  return {
    id: section.id,
    label: section.label,
    description: section.description,
    order: section.order,
    createdAt: nowIso,
    createdBy: SYSTEM_ACTOR,
    updatedAt: nowIso,
    updatedBy: SYSTEM_ACTOR,
  };
}

// The fields that define the desk. A live edit to label, description or order is a staff
// decision and is left alone; a mismatched id is a different section wearing this key.
function sameSection(stored, expected) {
  return plainObject(stored) && stored.id === expected.id;
}

function auditEntry({ action, target, after }, nowIso) {
  return {
    actorUid: SYSTEM_ACTOR,
    actorEmail: null,
    action,
    target,
    before: null,
    after,
    source: "cms_staging_deploy",
    timestamp: FieldValue.serverTimestamp(),
    at: nowIso,
  };
}

export async function seedContentSections({
  firestore,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new Error("The content section seed timestamp is invalid");
  }

  const plannedSections = SEEDED_CONTENT_SECTIONS.map((section) => ({
    record: sectionRecord(section, nowIso),
    ref: firestore.collection(CONTENT_SECTIONS_COLLECTION).doc(section.id),
  }));
  const plannedPages = Object.entries(PAGE_SECTIONS).map(([pageId, section]) => ({
    pageId,
    section,
    ref: firestore.collection("cmsPages").doc(pageId),
  }));

  return firestore.runTransaction(async (transaction) => {
    const sectionSnapshots = await Promise.all(
      plannedSections.map((entry) => transaction.get(entry.ref)),
    );
    const pageSnapshots = await Promise.all(
      plannedPages.map((entry) => transaction.get(entry.ref)),
    );

    const missingSections = [];
    let verifiedSections = 0;
    for (const [index, entry] of plannedSections.entries()) {
      const snapshot = sectionSnapshots[index];
      if (!snapshot.exists) {
        missingSections.push(entry);
        continue;
      }
      if (!sameSection(snapshot.data(), entry.record)) {
        throw new Error(
          `Existing section ${entry.record.id} does not match the repository registry`,
        );
      }
      verifiedSections += 1;
    }

    // A page that has never been saved has no document to stamp. That is not a failure:
    // the save path composes the section from the same page registry on its first write,
    // so an unsaved page arrives correctly sectioned without a row here.
    const pagesToStamp = [];
    let verifiedPages = 0;
    let absentPages = 0;
    for (const [index, entry] of plannedPages.entries()) {
      const snapshot = pageSnapshots[index];
      if (!snapshot.exists) {
        absentPages += 1;
        continue;
      }
      const stored = snapshot.data();
      if (stored.section === entry.section) {
        verifiedPages += 1;
        continue;
      }
      if (stored.section !== undefined && stored.section !== null) {
        throw new Error(
          `Page ${entry.pageId} is stored in section ${stored.section}, not ${entry.section}`,
        );
      }
      pagesToStamp.push(entry);
    }

    for (const entry of missingSections) {
      transaction.create(entry.ref, entry.record);
      transaction.create(
        firestore.collection("admin_logs").doc(),
        auditEntry(
          {
            action: "section.registry_seed",
            target: `${CONTENT_SECTIONS_COLLECTION}/${entry.record.id}`,
            after: { id: entry.record.id, order: entry.record.order },
          },
          nowIso,
        ),
      );
    }

    for (const entry of pagesToStamp) {
      transaction.update(entry.ref, {
        section: entry.section,
        updatedAt: nowIso,
        updatedBy: SYSTEM_ACTOR,
      });
      transaction.create(
        firestore.collection("admin_logs").doc(),
        auditEntry(
          {
            action: "content.section_backfill",
            target: `cmsPages/${entry.pageId}`,
            after: { section: entry.section },
          },
          nowIso,
        ),
      );
    }

    return {
      sectionsCreated: missingSections.length,
      sectionsVerified: verifiedSections,
      pagesStamped: pagesToStamp.length,
      pagesVerified: verifiedPages,
      pagesAbsent: absentPages,
    };
  });
}

/**
 * Read the registry back and confirm every repository desk is registered.
 *
 * Separate from the seed transaction on purpose. A record create fails closed against the
 * live `sections` collection, so a deployment that activates the functions before the
 * registry exists refuses every create and every scoped grant. Committing the write is not
 * the same fact as the registry being readable afterwards, and the deploy step needs the
 * second one before it hands the functions to staff.
 */
export async function verifyContentSectionsRegistered({ firestore } = {}) {
  if (!firestore || typeof firestore.collection !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  const snapshot = await firestore.collection(CONTENT_SECTIONS_COLLECTION).get();
  const registered = new Set(snapshot.docs.map((doc) => doc.id));
  const missing = SEEDED_CONTENT_SECTIONS.map((section) => section.id).filter(
    (id) => !registered.has(id),
  );
  if (missing.length > 0) {
    throw new Error(
      `The content section registry is missing ${missing.join(", ")}; ` +
        "record creation and every scoped grant would fail closed",
    );
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
    const result = await seedContentSections({ firestore });
    console.log(
      `Sections ready: ${result.sectionsCreated} created, ${result.sectionsVerified} verified. ` +
        `Pages: ${result.pagesStamped} stamped, ${result.pagesVerified} verified, ` +
        `${result.pagesAbsent} not yet saved.`,
    );
    const verified = await verifyContentSectionsRegistered({ firestore });
    console.log(`Registry verified: ${verified.registered} desks readable.`);
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
