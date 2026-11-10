// Backfill the editorial desk (#619) onto stored records from an explicit mapping.
//
// The mapping is an input, never an inference. A record's section is an editorial fact
// about who owns the work, and the two things that look like they could stand in for it
// cannot: record type is explicitly not a section (an article, an event or a newsletter
// can belong to any desk), and an owner's current grants describe the person, not the
// piece. So this script refuses to guess: every stored record must appear in the mapping,
// and an unmapped one stops the run with its id rather than being skipped or defaulted.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/backfill-record-sections.mjs mapping.json
//
// mapping.json is { "<recordId>": "<sectionId>", ... }. Sections must already exist in the
// registry (seed them with scripts/seed-content-sections.mjs first).
//
// Idempotent: a record already stamped with its mapped section is verified and left alone.
// A record stored in a different section stops the run -- moving a record between desks is
// a deliberate act, not a migration side effect.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import contentSections from "../functions/lib/content-sections.js";

const SYSTEM_ACTOR = "system:record-section-backfill";
const { CONTENT_SECTIONS_COLLECTION, isSectionId } = contentSections;

export function parseSectionMapping(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The section mapping must be an object of record id to section id");
  }
  const mapping = new Map();
  for (const [recordId, section] of Object.entries(value)) {
    if (typeof recordId !== "string" || recordId.trim() === "") {
      throw new Error("The section mapping has an empty record id");
    }
    if (!isSectionId(section)) {
      throw new Error(`Record ${recordId} is mapped to an invalid section id`);
    }
    mapping.set(recordId, section);
  }
  return mapping;
}

function auditEntry(recordId, section, nowIso) {
  return {
    actorUid: SYSTEM_ACTOR,
    actorEmail: null,
    action: "content.section_backfill",
    target: `cmsPosts/${recordId}`,
    before: null,
    after: { section },
    source: "cms_staging_deploy",
    timestamp: FieldValue.serverTimestamp(),
    at: nowIso,
  };
}

export async function backfillRecordSections({
  firestore,
  mapping,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!(mapping instanceof Map)) {
    throw new Error("A parsed section mapping is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new Error("The record section backfill timestamp is invalid");
  }

  return firestore.runTransaction(async (transaction) => {
    const [registrySnapshot, recordsSnapshot] = await Promise.all([
      transaction.get(firestore.collection(CONTENT_SECTIONS_COLLECTION)),
      transaction.get(firestore.collection("cmsPosts")),
    ]);

    const registered = new Set(registrySnapshot.docs.map((doc) => doc.id));
    const unregistered = [...new Set(mapping.values())]
      .filter((section) => !registered.has(section))
      .sort();
    if (unregistered.length > 0) {
      throw new Error(
        `The mapping names sections that are not in the registry: ${unregistered.join(", ")}`,
      );
    }

    // Collect every refusal before throwing so one run reports the complete list of
    // records still needing a decision, instead of making the operator rediscover them
    // one failed run at a time.
    const unmapped = [];
    const conflicting = [];
    const pending = [];
    let verified = 0;

    for (const doc of recordsSnapshot.docs) {
      const stored = doc.data();
      const mapped = mapping.get(doc.id);
      if (mapped === undefined) {
        // A soft-deleted record still needs an explicit decision: a delete is
        // recoverable, so a restored record must come back with a desk.
        unmapped.push(doc.id);
        continue;
      }
      if (stored.section === mapped) {
        verified += 1;
        continue;
      }
      if (stored.section !== undefined && stored.section !== null) {
        conflicting.push(`${doc.id} (stored ${stored.section}, mapped ${mapped})`);
        continue;
      }
      pending.push({ ref: doc.ref, id: doc.id, section: mapped });
    }

    if (unmapped.length > 0) {
      throw new Error(
        `The mapping is missing ${unmapped.length} stored record(s): ${unmapped.sort().join(", ")}`,
      );
    }
    if (conflicting.length > 0) {
      throw new Error(
        `The mapping disagrees with stored sections: ${conflicting.sort().join(", ")}`,
      );
    }

    for (const entry of pending) {
      transaction.update(entry.ref, {
        section: entry.section,
        updatedAt: nowIso,
        updatedBy: SYSTEM_ACTOR,
      });
      transaction.create(
        firestore.collection("admin_logs").doc(),
        auditEntry(entry.id, entry.section, nowIso),
      );
    }

    return { stamped: pending.length, verified };
  });
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  }
  const mappingPath = process.argv[2];
  if (!mappingPath) {
    throw new Error("A section mapping JSON file path is required");
  }
  const mapping = parseSectionMapping(
    JSON.parse(readFileSync(resolve(mappingPath), "utf8")),
  );
  const app = getApps()[0] || initializeApp({ projectId: "njpbs-site" });
  try {
    const result = await backfillRecordSections({
      firestore: getFirestore(app),
      mapping,
    });
    console.log(
      `Record sections ready: ${result.stamped} stamped, ${result.verified} verified.`,
    );
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
