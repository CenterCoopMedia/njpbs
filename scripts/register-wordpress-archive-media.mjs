#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import billing from "../functions/lib/billing-state.js";
import contract from "../functions/lib/media-contract.js";
import categories from "../functions/lib/media-categories.js";
import discovery from "../functions/lib/media-discovery.js";
import thumbnails from "../functions/lib/media-thumbnails.js";
import media from "../functions/media.js";
import { ArchiveInputError } from "./lib/wordpress-archive-interchange.mjs";
import { attachmentProblem } from "./lib/wordpress-archive-staging.mjs";
import { readManifest, verifyOriginal } from "./stage-wordpress-archive-media.mjs";
import { archiveItemRef, firebaseOptions, writeArchiveReportRow } from "./stage-wordpress-archive.mjs";

const ACTOR = { uid: "system:wordpress-archive-media", email: null };
const review = reason => ({ action: "review", reason });

function applyFailure(error) {
  if (error instanceof RegistrationCleanupError) return "registration-cleanup-required";
  if (error instanceof media.MediaCapacityError || error?.code === "media-admission-overflow") return "library-capacity";
  if (error instanceof categories.MediaCategoryValidationError) return "general-category-unavailable";
  if (error instanceof media.MediaRequestError) return error.status === 409 ? "immutable-object-conflict" : "media-store-or-reservation";
  if (error instanceof contract.MediaValidationError) return "invalid-media-configuration";
  if (error?.code === "failed-precondition") return "apply-precondition-failed";
  if (error?.code === 7 || error?.code === 16) return "firestore-access-refused";
  return "apply-interrupted";
}

async function readRegistration(firestore, reader, target) {
  const { ref, stagingReceipt, sourceRef, entry, privateRef, publicRef } = target;
  const [doc, stagedReceipt, asset, projection] = await reader.getAll(ref, stagingReceipt, privateRef, publicRef);
  const staged = doc.data();
  const problem = await attachmentProblem({ firestore, reader, staged, receipt: stagedReceipt.data(), sourceRef,
    revisionSha256: entry.revisionSha256 });
  return { staged, asset, projection, problem };
}

function registrationState({ staged, asset, projection, problem }, target, proof, expectedVersion) {
  if (problem) return review(problem);
  if (expectedVersion !== undefined && expectedVersion !== staged.version) return review("staging-changed");
  if (!staged.media) return review("original-not-staged");
  if (!isDeepStrictEqual(staged.media, proof)) return review("original-or-metadata-conflict");

  if (asset.exists) {
    return isDeepStrictEqual(asset.data()?.archiveImport, target.archiveImport)
      ? { action: "skip", reason: "already-registered", assetId: target.assetId }
      : review("media-identity-conflict");
  }
  if (projection.exists) return review("media-identity-conflict");
  return { action: "register", version: staged.version };
}

function registrationClaim(target, proof, nowDate) {
  const { original } = proof;
  const assetId = target.privateRef.id;
  const metadata = contract.normalizeUploadMetadata({ name: proof.title, description: proof.caption,
    altText: proof.altText, credit: proof.credit, license: proof.license }, original.originalName);
  return {
    state: "reserved",
    attemptId: randomUUID(),
    assetId,
    contentHash: original.sha256,
    category: metadata.category,
    finalKey: contract.finalObjectKey({ category: metadata.category, assetId, contentHash: original.sha256,
      mimeType: original.mimeType }),
    sizeBytes: original.sizeBytes,
    mimeType: original.mimeType,
    recordSeed: {
      actor: ACTOR,
      metadata,
      originalName: original.originalName,
      dimensions: { width: original.width ?? null, height: original.height ?? null },
      ...(proof.kind === "image" ? { animated: original.animated } : {}),
      archiveImport: target.archiveImport,
    },
    createdAt: nowDate.toISOString(),
    updatedAt: nowDate.toISOString(),
    leaseExpiresAt: new Date(nowDate.getTime() + media.RESERVATION_LEASE_MS).toISOString(),
  };
}

class RegistrationChanged extends Error {
  constructor(result) {
    super("Archive registration changed before commit.");
    this.result = result;
  }
}

class RegistrationCleanupError extends Error {}

async function releaseRegistrationLease(firestore, ref, claim, nowIso) {
  await firestore.runTransaction(async transaction => {
    const owner = (await transaction.get(ref)).data();
    if (owner?.attemptId === claim.attemptId && owner.leaseExpiresAt === claim.leaseExpiresAt &&
        ["reserved", "object_ready"].includes(owner.state)) {
      transaction.update(ref, { leaseExpiresAt: nowIso });
    }
  });
}

async function registerOriginal({ firestore, target, verified, expectedVersion, getStorage, publicOrigin, now }) {
  const { bytes, proof } = verified;
  const contentHash = proof.original.sha256;
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const proposed = registrationClaim(target, proof, nowDate);
  const ref = media.ownerRef(firestore, contentHash, proposed.assetId);
  contract.publicMediaUrl(publicOrigin, proposed.finalKey);
  const inspect = async reader => registrationState(await readRegistration(firestore, reader, target),
    target, proof, expectedVersion);
  const reservation = await firestore.runTransaction(async transaction => {
    const state = await inspect(transaction);
    if (state.action !== "register") return state;
    const owner = (await transaction.get(ref)).data();
    if (owner) {
      if (!["reserved", "object_ready"].includes(owner.state) ||
          !isDeepStrictEqual(owner.recordSeed, proposed.recordSeed) ||
          owner.assetId !== proposed.assetId || typeof owner.attemptId !== "string" ||
          owner.contentHash !== contentHash || !Number.isFinite(Date.parse(owner.leaseExpiresAt)) ||
          owner.finalKey !== proposed.finalKey || owner.category !== proposed.category ||
          owner.mimeType !== proposed.mimeType || owner.sizeBytes !== proposed.sizeBytes) {
        return review("media-identity-conflict");
      }
      if (Date.parse(owner.leaseExpiresAt) > nowDate.getTime()) return review("registration-in-progress");
    }
    await categories.requireActiveMediaCategory(transaction, firestore, proposed.category);
    const admission = await discovery.readMediaAdmission(transaction, firestore);
    if (admission.activeCount >= admission.limit) throw new media.MediaCapacityError();
    const claim = owner ? { ...owner, leaseExpiresAt: proposed.leaseExpiresAt, updatedAt: nowIso } : proposed;
    transaction.set(ref, claim);
    return { claim };
  });
  if (!reservation.claim) return reservation;

  const { claim } = reservation;
  const { attemptId, assetId, finalKey, mimeType, sizeBytes, leaseExpiresAt } = claim;
  let storage;
  const record = media.uploadRecordFromClaim({ contentHash, claim, publicOrigin, nowIso, thumbnailAttempt: true });
  try {
    await billing.assertBillingEnabled(firestore);
    storage = await getStorage();
    const expected = { contentHash, attemptId, assetId, mimeType, sizeBytes };
    await media.putOrConfirm({ storage, method: "putFinal", key: finalKey, body: bytes, mimeType,
      metadata: media.objectMetadata(expected), expected });
    await media.markObjectReady({ firestore, ref, attemptId, nowIso });
    await media.commitUpload({ firestore, ref, attemptId, record, projection: contract.mediaProjection(record),
      actor: ACTOR, source: "wordpress-archive", nowIso, expectedLeaseExpiresAt: leaseExpiresAt,
      authorizeInTransaction: async transaction => {
        const state = await inspect(transaction);
        if (state.action !== "register") throw new RegistrationChanged(state);
      },
    });
  } catch (error) {
    if (error instanceof RegistrationChanged && error.result.action === "skip") return error.result;
    const discard = error instanceof RegistrationChanged ? media.discardArchiveRejectedUpload
      : error instanceof media.MediaCapacityError ? media.discardCapacityRejectedUpload
        : error instanceof categories.MediaCategoryValidationError ? media.discardCategoryRejectedUpload : null;
    if (discard) {
      try {
        await discard({ firestore, storage, ref, attemptId, finalKey, stagingKeys: [], nowIso, leaseExpiresAt });
      } catch {
        throw new RegistrationCleanupError("The rejected archive object needs operator cleanup.");
      }
      if (error instanceof RegistrationChanged) return error.result;
      throw error;
    }
    if (!await media.committedUpload(firestore, { contentHash, attemptId, record })) {
      await releaseRegistrationLease(firestore, ref, claim, nowIso);
      throw error;
    }
  }
  // The thumbnail backfill can retry transient failures using the committed original.
  const finalRecord = await thumbnails.addMediaThumbnails({ firestore, storage, record, buffer: bytes, publicOrigin,
    log: { warn() {} } });
  return { action: "register", assetId,
    ...(finalRecord.thumbnailStatus ? { thumbnailStatus: finalRecord.thumbnailStatus } : {}) };
}

function targetFor(firestore, source, entry) {
  const sourceRef = { source, postId: entry.postId };
  const ref = archiveItemRef(firestore, source, entry.postId);
  const assetId = `archive-${ref.id}`;
  return { ref, sourceRef, entry, assetId,
    stagingReceipt: ref.collection("archiveImportReceipts").doc("staged"),
    privateRef: firestore.collection("media_assets").doc(assetId),
    publicRef: firestore.collection("media_assets_public").doc(assetId),
  };
}

function withImportProof(target, proof) {
  return { ...target, archiveImport: { ...target.sourceRef, revisionSha256: proof.sourceRevisionSha256,
    originalSha256: proof.original.sha256,
    ...(proof.kind === "document" ? { pageCount: proof.original.pageCount } : {}),
  } };
}

export async function registerWordPressArchiveMedia({ firestore, manifestFile, originals, apply = false,
  getStorage, publicOrigin, now = () => new Date(), report = () => {} }) {
  const { source, items } = await readManifest(manifestFile);
  const plan = [];
  const counts = { register: 0, skip: 0, review: 0 };
  for (const entry of items) {
    const target = targetFor(firestore, source, entry);
    const stored = await readRegistration(firestore, firestore, target);
    const verified = stored.problem ? review(stored.problem) : await verifyOriginal(originals, entry);
    const result = verified.proof
      ? registrationState(stored, withImportProof(target, verified.proof), verified.proof) : verified;
    counts[result.action]++;
    if (result.action === "register") plan.push({ target, version: result.version });
    await report({ phase: "plan", sourceRef: target.sourceRef, action: result.action,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.action === "review" ? {} : { assetId: target.assetId }),
    });
  }
  await report({ phase: "plan-complete", counts });
  if (!apply) return counts;

  const applied = { ...counts, register: 0 };
  for (const { target, version } of plan) {
    let result;
    try {
      const verified = await verifyOriginal(originals, target.entry);
      result = verified.proof ? await registerOriginal({ firestore, target: withImportProof(target, verified.proof),
        verified, expectedVersion: version, getStorage, publicOrigin, now }) : verified;
    } catch (error) {
      await report({ phase: "apply", sourceRef: target.sourceRef, action: "failed", reason: applyFailure(error) });
      throw error;
    }
    applied[result.action]++;
    await report({ phase: "apply", sourceRef: target.sourceRef, ...result });
  }
  await report({ phase: "apply-complete", counts: applied });
  return applied;
}

async function main() {
  let app;
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      project: { type: "string" }, apply: { type: "boolean", default: false },
    } });
    if (positionals.length !== 2 || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values.project ?? "")) {
      throw new ArchiveInputError("Usage: node scripts/register-wordpress-archive-media.mjs <manifest.json> <originals-dir> --project <project-id> [--apply]");
    }
    if (values.apply && values.project.startsWith("demo-")) {
      throw new ArchiveInputError("Use the synthetic registration test for emulator writes.");
    }
    const publicOrigin = process.env.CMS_MEDIA_PUBLIC_ORIGIN;
    if (values.apply && !publicOrigin) throw new ArchiveInputError("Set the media origin for the selected project.");
    app = initializeApp(await firebaseOptions(values.project), "wordpress-archive-media-registration");
    let storage;
    await registerWordPressArchiveMedia({ firestore: getFirestore(app), manifestFile: positionals[0],
      originals: positionals[1], apply: values.apply, publicOrigin, report: writeArchiveReportRow,
      getStorage: () => storage ??= media.createDefaultStorage(),
    });
  } catch (error) {
    console.error(error instanceof ArchiveInputError ? error.message :
      "Archive media registration stopped. Check the target and rerun the same manifest to reconcile committed items.");
    process.exitCode = 1;
  } finally {
    if (app) await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
