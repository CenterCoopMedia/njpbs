#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";
import mediaDiscovery from "../functions/lib/media-discovery.js";
import mediaDiscoveryQuery from "../functions/lib/media-discovery-query.js";

const {
  MEDIA_DISCOVERY_SCHEMA,
  MEDIA_DISCOVERY_STATE,
  deriveMediaDiscovery,
} = mediaDiscovery;
const { probeDiscoveryIndexes } = mediaDiscoveryQuery;

const PROJECT_ID = "njpbs-site";
const PAGE_SIZE = 100;
const LEASE_MS = 5 * 60 * 1_000;
const TRANSACTION_TOO_BIG = "Transaction too big. Decrease transaction size.";

function stateRef(firestore) {
  return firestore.doc(MEDIA_DISCOVERY_STATE);
}

function revisionOf(checkpoint) {
  return Number.isSafeInteger(checkpoint?.revision) && checkpoint.revision >= 0
    ? checkpoint.revision
    : 0;
}

function validSourceSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isTransactionTooBig(error) {
  if (error?.code !== 3 && error?.code !== "invalid-argument") return false;
  return error.details === TRANSACTION_TOO_BIG ||
    error.message === TRANSACTION_TOO_BIG ||
    error.message === `3 INVALID_ARGUMENT: ${TRANSACTION_TOO_BIG}`;
}

function leaseExpiry(nowMs, leaseMs = LEASE_MS) {
  return new Date(nowMs + leaseMs).toISOString();
}

function assertLease(checkpoint, owner, nowMs) {
  const expiresAt = Date.parse(checkpoint?.leaseExpiresAt ?? "");
  if (
    checkpoint?.leaseOwner &&
    checkpoint.leaseOwner !== owner &&
    Number.isFinite(expiresAt) &&
    expiresAt > nowMs
  ) {
    throw new Error("Media discovery backfill lease is held by another process");
  }
}

function assertBuildingCheckpoint(checkpoint, owner, nowMs, phase) {
  if (
    checkpoint?.schema !== MEDIA_DISCOVERY_SCHEMA ||
    checkpoint.state !== "building" ||
    checkpoint.phase !== phase
  ) {
    throw new Error(`Media discovery checkpoint is not in ${phase}`);
  }
  assertLease(checkpoint, owner, nowMs);
}

function queryPage(firestore, afterId, pageSize = PAGE_SIZE) {
  let query = firestore.collection("media_assets")
    .orderBy(FieldPath.documentId())
    .limit(pageSize);
  if (afterId) query = query.startAfter(afterId);
  return query;
}

function expectedDiscovery(document) {
  return deriveMediaDiscovery(document.id, document.data());
}

function invalidResult(document, error) {
  return {
    assetId: document.id,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function acquireCheckpoint({
  firestore,
  owner,
  sourceSha,
  nowMs,
  leaseMs,
}) {
  return firestore.runTransaction(async (transaction) => {
    const ref = stateRef(firestore);
    const snapshot = await transaction.get(ref);
    const checkpoint = snapshot.exists ? snapshot.data() : {};
    if (
      checkpoint.schema !== undefined &&
      checkpoint.schema !== MEDIA_DISCOVERY_SCHEMA
    ) {
      throw new Error("Media discovery checkpoint has an unsupported schema");
    }
    if (checkpoint.state === "ready") {
      return {
        status: "ready",
        readyAt: checkpoint.readyAt ?? null,
        sourceSha: checkpoint.sourceSha ?? null,
      };
    }
    assertLease(checkpoint, owner, nowMs);

    const canResume = checkpoint.state === "building" &&
      checkpoint.sourceSha === sourceSha &&
      ["write", "verify"].includes(checkpoint.phase);
    transaction.set(ref, {
      schema: MEDIA_DISCOVERY_SCHEMA,
      state: "building",
      phase: canResume ? checkpoint.phase : "write",
      afterId: canResume && typeof checkpoint.afterId === "string"
        ? checkpoint.afterId
        : null,
      sourceSha,
      revision: revisionOf(checkpoint),
      verifyRevision: canResume && Number.isSafeInteger(checkpoint.verifyRevision)
        ? checkpoint.verifyRevision
        : null,
      verificationComplete: canResume && checkpoint.verificationComplete === true,
      leaseOwner: owner,
      leaseExpiresAt: leaseExpiry(nowMs, leaseMs),
      error: null,
      updatedAt: new Date(nowMs).toISOString(),
      ...(!canResume
        ? {
          readyAt: FieldValue.delete(),
          verifiedRevision: FieldValue.delete(),
        }
        : {}),
    }, { merge: true });
    return { status: "building" };
  });
}

async function writePage({ firestore, owner, sourceSha, nowMs, leaseMs, pageSize }) {
  return firestore.runTransaction(async (transaction) => {
    const checkpointRef = stateRef(firestore);
    const checkpointSnapshot = await transaction.get(checkpointRef);
    const checkpoint = checkpointSnapshot.data();
    assertBuildingCheckpoint(checkpoint, owner, nowMs, "write");

    const page = await transaction.get(queryPage(firestore, checkpoint.afterId, pageSize));
    const updates = [];
    let invalid = null;
    for (const document of page.docs) {
      try {
        const expected = expectedDiscovery(document);
        if (!isDeepStrictEqual(document.data().mediaDiscovery, expected)) {
          updates.push({ ref: document.ref, mediaDiscovery: expected });
        }
      } catch (error) {
        invalid ??= invalidResult(document, error);
      }
    }

    const updatedAt = new Date(nowMs).toISOString();
    if (invalid) {
      transaction.set(checkpointRef, {
        error: { code: "invalid_asset", ...invalid },
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt,
      }, { merge: true });
      return { status: "blocked", invalid };
    }

    for (const update of updates) {
      transaction.update(update.ref, { mediaDiscovery: update.mediaDiscovery });
    }
    const done = page.size < pageSize;
    const currentRevision = revisionOf(checkpoint);
    const nextRevision = currentRevision + (updates.length > 0 ? 1 : 0);
    transaction.set(checkpointRef, {
      phase: done ? "verify" : "write",
      afterId: done ? null : page.docs.at(-1).id,
      sourceSha,
      verifyRevision: done ? nextRevision : null,
      verificationComplete: false,
      leaseOwner: owner,
      leaseExpiresAt: leaseExpiry(nowMs, leaseMs),
      error: null,
      updatedAt,
      ...(updates.length > 0
        ? { revision: FieldValue.increment(1) }
        : {}),
    }, { merge: true });
    return {
      status: done ? "verify" : "write",
      scanned: page.size,
      updated: updates.length,
    };
  });
}

async function verifyPage({ firestore, owner, sourceSha, nowMs, leaseMs, pageSize }) {
  return firestore.runTransaction(async (transaction) => {
    const checkpointRef = stateRef(firestore);
    const checkpointSnapshot = await transaction.get(checkpointRef);
    const checkpoint = checkpointSnapshot.data();
    assertBuildingCheckpoint(checkpoint, owner, nowMs, "verify");

    const revision = revisionOf(checkpoint);
    const updatedAt = new Date(nowMs).toISOString();
    if (checkpoint.verifyRevision !== revision) {
      transaction.set(checkpointRef, {
        afterId: null,
        sourceSha,
        verifyRevision: revision,
        verificationComplete: false,
        leaseOwner: owner,
        leaseExpiresAt: leaseExpiry(nowMs, leaseMs),
        error: null,
        updatedAt,
      }, { merge: true });
      return { status: "verify_restarted", scanned: 0 };
    }
    if (checkpoint.verificationComplete === true) {
      return { status: "probe", scanned: 0 };
    }

    const page = await transaction.get(queryPage(firestore, checkpoint.afterId, pageSize));
    let invalid = null;
    for (const document of page.docs) {
      try {
        if (!isDeepStrictEqual(document.data().mediaDiscovery, expectedDiscovery(document))) {
          invalid = { assetId: document.id, message: "Index fields do not match" };
          break;
        }
      } catch (error) {
        invalid = invalidResult(document, error);
        break;
      }
    }
    if (invalid) {
      transaction.set(checkpointRef, {
        error: { code: "verification_failed", ...invalid },
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt,
      }, { merge: true });
      return { status: "blocked", invalid };
    }

    const done = page.size < pageSize;
    transaction.set(checkpointRef, {
      afterId: done ? null : page.docs.at(-1).id,
      sourceSha,
      verificationComplete: done,
      leaseOwner: owner,
      leaseExpiresAt: leaseExpiry(nowMs, leaseMs),
      error: null,
      updatedAt,
    }, { merge: true });
    return { status: done ? "probe" : "verify", scanned: page.size };
  });
}

async function recordProbeFailure({ firestore, owner, nowMs, message }) {
  await firestore.runTransaction(async (transaction) => {
    const ref = stateRef(firestore);
    const snapshot = await transaction.get(ref);
    const checkpoint = snapshot.data();
    if (
      checkpoint?.state !== "building" ||
      checkpoint.phase !== "verify" ||
      checkpoint.leaseOwner !== owner
    ) return;
    transaction.set(ref, {
      error: { code: "index_probe_failed", message },
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(nowMs).toISOString(),
    }, { merge: true });
  });
}

async function releaseLease({ firestore, owner, nowMs }) {
  await firestore.runTransaction(async (transaction) => {
    const ref = stateRef(firestore);
    const snapshot = await transaction.get(ref);
    const checkpoint = snapshot.data();
    if (checkpoint?.state !== "building" || checkpoint.leaseOwner !== owner) return;
    transaction.set(ref, {
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(nowMs).toISOString(),
    }, { merge: true });
  });
}

async function probeReadyState({
  firestore,
  sourceSha,
  probeIndexes,
  expectedReadyAt,
  expectedSourceSha,
  nowMs,
}) {
  try {
    const probeResult = await probeIndexes({ firestore });
    if (probeResult === false || probeResult?.ok === false) {
      throw new Error("Index-shape probe did not confirm readiness");
    }
    const probe = probeResult ?? { ok: true };
    return await firestore.runTransaction(async (transaction) => {
      const ref = stateRef(firestore);
      const checkpoint = (await transaction.get(ref)).data();
      if (
        checkpoint?.schema !== MEDIA_DISCOVERY_SCHEMA ||
        checkpoint.state !== "ready" ||
        (checkpoint.readyAt ?? null) !== expectedReadyAt ||
        (checkpoint.sourceSha ?? null) !== expectedSourceSha
      ) {
        throw new Error("Media discovery state changed during the index probe");
      }
      const revision = revisionOf(checkpoint);
      const at = new Date(nowMs).toISOString();
      transaction.set(ref, {
        sourceSha,
        lastProbe: {
          sourceSha,
          revision,
          at,
          ...(Number.isSafeInteger(probe.shapes) ? { shapes: probe.shapes } : {}),
        },
        error: null,
        updatedAt: at,
      }, { merge: true });
      return { revision, probe };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await firestore.runTransaction(async (transaction) => {
      const ref = stateRef(firestore);
      const snapshot = await transaction.get(ref);
      const checkpoint = snapshot.data();
      if (
        checkpoint?.schema !== MEDIA_DISCOVERY_SCHEMA ||
        checkpoint.state !== "ready" ||
        (checkpoint.readyAt ?? null) !== expectedReadyAt ||
        (checkpoint.sourceSha ?? null) !== expectedSourceSha
      ) return;
      transaction.set(ref, {
        error: { code: "index_probe_failed", message },
        updatedAt: new Date(nowMs).toISOString(),
      }, { merge: true });
    });
    throw error;
  }
}

async function markReady({ firestore, owner, sourceSha, probe, nowMs }) {
  return firestore.runTransaction(async (transaction) => {
    const ref = stateRef(firestore);
    const snapshot = await transaction.get(ref);
    const checkpoint = snapshot.data();
    assertBuildingCheckpoint(checkpoint, owner, nowMs, "verify");
    const revision = revisionOf(checkpoint);
    if (
      checkpoint.verificationComplete !== true ||
      checkpoint.verifyRevision !== revision
    ) {
      transaction.set(ref, {
        afterId: null,
        verifyRevision: revision,
        verificationComplete: false,
        leaseExpiresAt: leaseExpiry(nowMs),
        error: null,
        updatedAt: new Date(nowMs).toISOString(),
      }, { merge: true });
      return { status: "verify_restarted" };
    }
    const at = new Date(nowMs).toISOString();
    transaction.set(ref, {
      schema: MEDIA_DISCOVERY_SCHEMA,
      state: "ready",
      phase: "verify",
      afterId: null,
      sourceSha,
      verifiedRevision: revision,
      lastProbe: {
        sourceSha,
        revision,
        at,
        ...(Number.isSafeInteger(probe.shapes) ? { shapes: probe.shapes } : {}),
      },
      verificationComplete: true,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      updatedAt: at,
      readyAt: at,
    }, { merge: true });
    return { status: "ready", revision };
  });
}

async function dryRun(firestore, pageSize) {
  const result = { apply: false, scanned: 0, mismatched: 0, invalid: [] };
  let afterId = null;
  while (true) {
    const page = await queryPage(firestore, afterId, pageSize).get();
    for (const document of page.docs) {
      result.scanned += 1;
      try {
        if (!isDeepStrictEqual(document.data().mediaDiscovery, expectedDiscovery(document))) {
          result.mismatched += 1;
        }
      } catch (error) {
        result.invalid.push(invalidResult(document, error));
      }
    }
    if (page.size < pageSize) return result;
    afterId = page.docs.at(-1).id;
  }
}

export async function backfillMediaDiscovery({
  firestore,
  apply = false,
  sourceSha = null,
  owner = randomUUID(),
  probeIndexes,
  maxPages = null,
  pageSize = PAGE_SIZE,
  leaseMs = LEASE_MS,
  now = () => Date.now(),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
    throw new Error(`pageSize must be a whole number from 1 to ${PAGE_SIZE}`);
  }
  if (!apply) return dryRun(firestore, pageSize);
  if (!validSourceSha(sourceSha)) throw new Error("A full source SHA is required for --apply");
  if (typeof probeIndexes !== "function") {
    throw new Error("An index-shape probe is required for --apply");
  }
  if (maxPages !== null && (!Number.isSafeInteger(maxPages) || maxPages < 1)) {
    throw new Error("maxPages must be a positive safe integer");
  }

  const result = {
    apply: true,
    state: "building",
    writeScanned: 0,
    updated: 0,
    verifyScanned: 0,
    verificationRestarts: 0,
    pages: 0,
  };
  let writePageSize = pageSize;
  let nowMs = now();
  const acquired = await acquireCheckpoint({
    firestore, owner, sourceSha, nowMs, leaseMs,
  });
  if (acquired.status === "ready") {
    const ready = await probeReadyState({
      firestore,
      sourceSha,
      probeIndexes,
      expectedReadyAt: acquired.readyAt,
      expectedSourceSha: acquired.sourceSha,
      nowMs: now(),
    });
    return { ...result, state: "ready", ...ready };
  }

  while (maxPages === null || result.pages < maxPages) {
    const checkpoint = (await stateRef(firestore).get()).data();
    if (checkpoint.state === "ready") {
      const ready = await probeReadyState({
        firestore,
        sourceSha,
        probeIndexes,
        expectedReadyAt: checkpoint.readyAt ?? null,
        expectedSourceSha: checkpoint.sourceSha ?? null,
        nowMs: now(),
      });
      return { ...result, state: "ready", ...ready };
    }
    nowMs = now();
    let page;
    if (checkpoint.phase === "write") {
      try {
        page = await writePage({
          firestore, owner, sourceSha, nowMs, leaseMs, pageSize: writePageSize,
        });
      } catch (error) {
        if (!isTransactionTooBig(error) || writePageSize === 1) throw error;
        writePageSize = Math.max(1, Math.floor(writePageSize / 2));
        continue;
      }
      result.writeScanned += page.scanned ?? 0;
      result.updated += page.updated ?? 0;
    } else if (checkpoint.phase === "verify") {
      page = await verifyPage({
        firestore, owner, sourceSha, nowMs, leaseMs, pageSize,
      });
      result.verifyScanned += page.scanned ?? 0;
      if (page.status === "verify_restarted") result.verificationRestarts += 1;
    } else {
      throw new Error("Media discovery checkpoint has an invalid phase");
    }
    result.pages += 1;
    if (page.status === "blocked") {
      return { ...result, state: "building", blocked: page.invalid };
    }
    if (page.status !== "probe") continue;

    try {
      const probeResult = await probeIndexes({ firestore });
      if (probeResult === false || probeResult?.ok === false) {
        throw new Error("Index-shape probe did not confirm readiness");
      }
      const probe = probeResult ?? { ok: true };
      nowMs = now();
      const ready = await markReady({
        firestore, owner, sourceSha, probe, nowMs,
      });
      if (ready.status === "ready") {
        return { ...result, state: "ready", revision: ready.revision, probe };
      }
      result.verificationRestarts += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordProbeFailure({ firestore, owner, nowMs: now(), message });
      throw error;
    }
  }
  await releaseLease({ firestore, owner, nowMs: now() });
  return { ...result, state: "building" };
}

function parseArgs(args) {
  let apply = false;
  let project = null;
  let sourceSha = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--project") project = args[++index];
    else if (argument === "--source-sha") sourceSha = args[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (project !== PROJECT_ID) {
    throw new Error(`--project ${PROJECT_ID} is required`);
  }
  if (apply && !validSourceSha(sourceSha)) {
    throw new Error("--apply requires --source-sha with a full commit SHA");
  }
  return { apply, project, sourceSha };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credential = JSON.parse(readFileSync(0, "utf8"));
  if (credential.project_id !== options.project) throw new Error("Wrong Firebase project");
  const app = initializeApp({
    credential: cert(credential),
    projectId: options.project,
  }, "media-discovery-backfill");
  try {
    const result = await backfillMediaDiscovery({
      firestore: getFirestore(app),
      apply: options.apply,
      sourceSha: options.sourceSha,
      probeIndexes: options.apply
        ? async ({ firestore }) => {
          const shapes = await probeDiscoveryIndexes(firestore);
          return { ok: true, shapes };
        }
        : undefined,
    });
    console.log(JSON.stringify(result));
    if (options.apply && result.state !== "ready") {
      throw new Error("Media discovery backfill did not reach ready state");
    }
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Media discovery backfill failed: ${error?.message || "Error"}`);
    process.exitCode = 1;
  });
}
