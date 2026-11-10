#!/usr/bin/env -S node --experimental-strip-types

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isCmsImageUrl } from "../packages/content-core/src/media-origin.ts";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import releaseProducer from "../functions/lib/public-release-producer.js";
import mediaContract from "../functions/lib/media-contract.js";
import mediaLibrary from "../functions/lib/media-library.js";
import mediaDiscovery from "../functions/lib/media-discovery.js";
import mediaReplacement from "../functions/lib/media-replacement.js";
import publicContext from "../functions/lib/public-context-revision.js";
import mediaSafety from "../functions/lib/published-media-safety.js";

const { mediaProjection } = mediaContract;
const PROJECT_ID = "njpbs-site";
const PAGE_SIZE = 100;
// The historical repair identity is trusted startup configuration, never a CLI
// argument. Preserve it across retries so record-current reuses its receipt.
const REPAIR_ID = process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID;
function configuredRepairId() {
  if (typeof REPAIR_ID !== "string" || !/^[a-f0-9]{8}$/.test(REPAIR_ID)) {
    throw new Error("A valid historical media credit repair identity is required");
  }
  return REPAIR_ID;
}

async function ownedAuditEntry(fields) {
  // Initialize the explicit stdin-authenticated app before loading the audit owner.
  const { default: audit } = await import("../functions/lib/audit.js");
  return audit.adminLogEntry(fields);
}

function invalidFields(id, record, replacement) {
  if (replacement?.exists) return ["replacementClaim"];
  if (record.lifecycle !== "active") return ["lifecycle"];
  if (!["upload", "site_seed"].includes(record.source)) return ["source"];
  if (!mediaContract.mediaType(record.mimeType) || !record.mimeType.startsWith("image/")) return ["mimeType"];
  if (!mediaLibrary.mediaAssetSummary(id, record)) return ["privateRecord"];
  if (!isCmsImageUrl(new URL(record.url))) return ["url"];
  return [];
}

function differences(expected, actual) {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((key) => Object.hasOwn(expected, key) !== Object.hasOwn(actual, key) ||
      !isDeepStrictEqual(expected[key], actual[key])).sort();
}

function inspect(privateSnapshot, publicSnapshot, replacementSnapshot) {
  const actual = publicSnapshot.data() ?? {};
  if (!privateSnapshot.exists) return { status: "blocked", fields: Object.keys(actual).sort() };
  const expected = mediaProjection(privateSnapshot.data());
  if (!Object.hasOwn(expected, "credit")) return { status: "noCredit" };
  // Deletion tombstones the private record and intentionally removes its public projection.
  if (privateSnapshot.data().lifecycle === "tombstoned" && !publicSnapshot.exists && !replacementSnapshot?.exists) {
    return { status: "withdrawn" };
  }
  const fields = invalidFields(privateSnapshot.id, privateSnapshot.data(), replacementSnapshot);
  if (fields.length) return { status: "blocked", fields };
  if (publicSnapshot.exists && isDeepStrictEqual(actual, expected)) return { status: "current" };
  const prior = { ...expected };
  delete prior.credit;
  if (publicSnapshot.exists && isDeepStrictEqual(actual, prior)) return { status: "eligible", expected };
  return { status: "blocked", fields: differences(expected, actual) };
}

/** Replace only an exact legacy public projection missing its new credit key. */
export async function backfillMediaPublicCredit({ firestore, apply = false,
  actorUid = "system:media-public-credit-backfill", auditEntry = ownedAuditEntry } = {}) {
  const result = {
    dryRun: !apply, scanned: 0, noCredit: 0, current: 0, eligible: 0, updated: 0, blocked: 0, withdrawn: 0,
    assetIds: { noCredit: [], current: [], eligible: [], updated: [], withdrawn: [] }, differences: [],
  };
  let cursor = null;
  let minimumContextRevision = 0;
  while (true) {
    let query = firestore.collection("media_assets").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    for (const privateSnapshot of page.docs) {
      result.scanned += 1;
      const id = privateSnapshot.id;
      // Assets without projected credit need no public read or transaction.
      const expected = mediaProjection(privateSnapshot.data());
      let outcome = !Object.hasOwn(expected, "credit") ? { status: "noCredit" } :
        inspect(privateSnapshot, await firestore.collection("media_assets_public").doc(id).get(),
          await mediaReplacement.mediaReplacementRef(firestore, id).get());
      if (apply && outcome.status === "eligible") {
        const publicRef = firestore.collection("media_assets_public").doc(id);
        outcome = await firestore.runTransaction(async (transaction) => {
          const freshPrivate = await transaction.get(privateSnapshot.ref);
          const freshPublic = await transaction.get(publicRef);
          const replacement = await transaction.get(mediaReplacement.mediaReplacementRef(firestore, id));
          const checked = inspect(freshPrivate, freshPublic, replacement);
          if (checked.status === "eligible") {
            const revision = await publicContext.readPublicContextRevisionInTransaction(transaction, firestore);
            if (!Number.isSafeInteger(revision + 1)) throw new Error("Public context revision overflow");
            const entry = await auditEntry({ actorUid, action: "media.public-credit.backfill",
              target: publicRef.path, before: { credit: null, publicContextRevision: revision },
              after: { credit: checked.expected.credit, publicContextRevision: revision + 1 },
              source: "scripts/backfill-media-public-credit.mjs" });
            const writeReleaseChange = await releaseProducer.preparePublicMediaChangeInTransaction({ firestore, transaction,
              id, version: freshPrivate.data().version, before: freshPublic.data(), after: checked.expected, mediaSource: freshPrivate.data() });
            writeReleaseChange();
            transaction.set(publicRef, checked.expected);
            mediaDiscovery.bumpMediaDiscoveryRevision(transaction, firestore);
            transaction.set(firestore.collection("admin_logs").doc(), entry);
            return { ...checked, publicContextRevision: revision + 1 };
          }
          return checked;
        });
      }
      result[outcome.status] += 1;
      if (outcome.status === "blocked") result.differences.push({ id, fields: outcome.fields });
      else result.assetIds[outcome.status].push(id);
      if (apply && outcome.status === "eligible") {
        result.updated += 1;
        result.assetIds.updated.push(id);
        minimumContextRevision = Math.max(minimumContextRevision, outcome.publicContextRevision);
      }
    }
    if (page.size < PAGE_SIZE) break;
    cursor = page.docs.at(-1).id;
  }
  if (apply) {
    for (const id of result.assetIds.updated) {
      const outcome = inspect(await firestore.collection("media_assets").doc(id).get(),
        await firestore.collection("media_assets_public").doc(id).get(),
        await mediaReplacement.mediaReplacementRef(firestore, id).get());
      if (outcome.status !== "current") throw new Error("Repaired media readback failed");
    }
    const context = (await firestore.doc(publicContext.PUBLIC_CONTEXT_PATH).get()).data();
    if (context?.schemaVersion !== 1 || !Number.isSafeInteger(context.revision) ||
      context.revision < Math.max(1, minimumContextRevision)) {
      throw new Error("Public context readback failed");
    }
    result.publicContextRevision = context.revision;
    result.safety = await mediaSafety.assertPublishedMediaSafe({ firestore });
  }
  return result;
}

/** Record the original repair cohort and advance its context exactly once. */
export async function recordCurrentMediaPublicCredit({ firestore, expectedCount, apply = false,
  actorUid = "system:media-public-credit-backfill", auditEntry = ownedAuditEntry } = {}) {
  const repairId = configuredRepairId();
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 500) {
    throw new Error("An expected cohort count from 1 to 500 is required");
  }
  const plan = await backfillMediaPublicCredit({ firestore });
  const ids = plan.assetIds.current;
  if (ids.length !== expectedCount || plan.eligible !== 0) throw new Error("Credit repair cohort changed");
  const auditRef = firestore.collection("admin_logs").doc(`media-public-credit-backfill-${repairId}`);
  const inspectCohort = async (transaction) => {
    const existing = await transaction.get(auditRef);
    const receipts = await transaction.get(firestore.collection("admin_logs")
      .where("action", "==", "media.public-credit.backfill.record-current").limit(2));
    if (receipts.docs.some(receipt => receipt.id !== auditRef.id)) {
      throw new Error("Credit repair identity conflicts with an existing receipt");
    }
    const priorRevision = await publicContext.readPublicContextRevisionInTransaction(transaction, firestore);
    for (let start = 0; start < ids.length; start += 33) {
      const chunk = ids.slice(start, start + 33);
      const snapshots = await transaction.getAll(...chunk.flatMap(id => [
        firestore.collection("media_assets").doc(id), firestore.collection("media_assets_public").doc(id),
        mediaReplacement.mediaReplacementRef(firestore, id),
      ]));
      for (let index = 0; index < chunk.length; index++) {
        if (inspect(...snapshots.slice(index * 3, index * 3 + 3)).status !== "current") {
          throw new Error("Credit repair cohort is unsafe");
        }
      }
    }
    const safety = await mediaSafety.assertPublishedMediaSafe({ firestore, transaction });
    if (existing.exists) {
      const entry = existing.data();
      if (entry.action !== "media.public-credit.backfill.record-current" ||
        !isDeepStrictEqual(entry.after?.assetIds, ids) || !Number.isSafeInteger(entry.after?.publicContextRevision) ||
        priorRevision < entry.after.publicContextRevision) throw new Error("Credit repair audit does not match");
      return { recorded: false, alreadyRecorded: true, safety, publicContextRevision: entry.after.publicContextRevision };
    }
    if (apply) {
      if (!Number.isSafeInteger(priorRevision + 1)) throw new Error("Public context revision overflow");
      const entry = await auditEntry({ actorUid, action: "media.public-credit.backfill.record-current",
        target: "media_assets_public", before: { publicContextRevision: priorRevision },
        after: { assetIds: ids, publicContextRevision: priorRevision + 1 },
        source: `scripts/backfill-media-public-credit.mjs:${repairId}` });
      mediaDiscovery.bumpMediaDiscoveryRevision(transaction, firestore);
      transaction.set(auditRef, entry);
    }
    return { recorded: apply, alreadyRecorded: false, safety,
      publicContextRevision: priorRevision + (apply ? 1 : 0) };
  };
  const outcome = await firestore.runTransaction(inspectCohort);
  if (apply) {
    const receipt = (await auditRef.get()).data();
    const context = (await firestore.doc(publicContext.PUBLIC_CONTEXT_PATH).get()).data();
    if (!isDeepStrictEqual(receipt?.after?.assetIds, ids) || context?.schemaVersion !== 1 ||
      !Number.isSafeInteger(context.revision) || context.revision < outcome.publicContextRevision) {
      throw new Error("Credit repair audit/context readback failed");
    }
    await mediaSafety.assertPublishedMediaSafe({ firestore });
  }
  return { ...plan, dryRun: !apply, recordCurrent: true, ...outcome };
}

export function parseMediaPublicCreditArgs(args) {
  let apply = false;
  let project = null;
  let recordCurrent = false;
  let expectedCount;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply" && !apply) apply = true;
    else if (args[index] === "--project" && project === null) project = args[++index];
    else if (args[index] === "--record-current" && !recordCurrent) recordCurrent = true;
    else if (args[index] === "--expected-count" && expectedCount === undefined) expectedCount = Number(args[++index]);
    else throw new Error("Use --project njpbs-site [--apply]");
  }
  if (project !== PROJECT_ID) throw new Error("--project njpbs-site is required");
  if (recordCurrent !== (expectedCount !== undefined) || (recordCurrent &&
    (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 500))) {
    throw new Error("--record-current requires --expected-count from 1 to 500");
  }
  return { apply, project, ...(recordCurrent ? { recordCurrent, expectedCount } : {}) };
}

async function main() {
  const options = parseMediaPublicCreditArgs(process.argv.slice(2));
  if (process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development") throw new Error("Production contract required");
  if (options.recordCurrent) configuredRepairId();
  // Match the existing backfill pattern: credential JSON comes only on stdin.
  const credential = JSON.parse(readFileSync(0, "utf8"));
  if (credential.project_id !== options.project) throw new Error("Wrong Firebase project");
  const app = initializeApp({ credential: cert(credential), projectId: options.project });
  try {
    const operation = options.recordCurrent ? recordCurrentMediaPublicCredit : backfillMediaPublicCredit;
    const result = await operation({ firestore: getFirestore(app), ...options, actorUid: credential.client_email });
    console.log(JSON.stringify(result));
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Media public credit backfill failed; details withheld");
    process.exitCode = 1;
  });
}
