"use strict";

const { randomUUID } = require("node:crypto");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { parsePublicReleasePair, publicReleasePairReference, parseVersionedPublicDeployment,
  PublicReleaseProtocolError, publicReleaseDigest, exact, digest, positive, freeze } = require("./public-release-pair");
const { publicationTarget, assertPublicationDatabase } = require("./publication-target");
const pairInputs = require("./public-release-pair-input");
const { isPairFailureCode, PairExecutionError, assertPrivatePairResources } = require("./public-release-pair-execution");

const PAIRS = "system/publicReleasePairs";
const KINDS = new Set(["accepted", "qualification", "recovery"]);
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 4;
function refuse() { throw new PublicReleaseProtocolError(); }

/** Read-only, non-transactional hint for the private Worker. Claim/settlement
 * always revalidate their SDK transaction; this cannot certify a publication.
 */
async function readPublicReleasePairWorkHint({ pair: rawPair, read, listDue, now = Date.now() }) {
  const pair = parsePublicReleasePair(rawPair);
  assertPrivatePairResources(pair);
  if (!positive(now)) refuse();
  const base = publicReleasePairPath(pair.pairId);
  const [storedPair, runtime, pointer, billing, rawJournal] = await Promise.all([
    read(base), read(`${base}/controls/runtime`), read("system/publicDeployment"), read("system/billing"),
    read(`${base}/journals/${pair.publisher.journalNamespace}`),
  ]);
  if (!samePair(parsePublicReleasePair(storedPair), pair)) refuse();
  const status = control(runtime, pair.pairId).status;
  if (status === "retired") refuse();
  const selector = parseVersionedPublicDeployment(pointer), journal = parseJournal(rawJournal, pair);
  if (billing?.disabled === true) return { taskIds: [], billingDisabled: true };
  if (journal.job?.leaseUntil > now) return { taskIds: [] };
  if (journal.job) {
    const id = journal.job.taskId, task = parseTask(await read(`${base}/work/${id}`), pair, id);
    allowed(status, selector, task.identity.kind, pair, false);
    if (task.status !== "running" || task.claimDigest !== journal.job.claimDigest || task.leaseUntil !== journal.job.leaseUntil) refuse();
    return { taskIds: [id] };
  }
  const accepted = await listDue("acceptedDueAt", 1);
  if (!Array.isArray(accepted) || accepted.length > 1) refuse();
  const rows = accepted.length ? accepted : (await Promise.all([listDue("nextAttemptAt", 20), listDue("leaseUntil", 20)])).flat();
  if (!Array.isArray(rows) || rows.length > 40) refuse();
  const tasks = new Map();
  for (const row of rows) {
    const task = parseTask(row.data, pair, row.id);
    allowed(status, selector, task.identity.kind, pair, false);
    if (accepted.length && task.identity.kind !== "accepted") refuse();
    if (publicReleasePairTaskDue(task, now)) tasks.set(row.id, task);
  }
  return { taskIds: [...tasks.keys()] };
}
function ref(firestore, pairId) {
  return firestore.doc(publicReleasePairPath(pairId));
}
function publicReleasePairKey(pairId) {
  if (!isPublicDeploymentIdentifier(pairId)) refuse();
  return publicReleaseDigest({ kind: "pair-document", schemaVersion: 2, pairId });
}
function publicReleasePairPath(pairId) { return `${PAIRS}/entries/${publicReleasePairKey(pairId)}`; }
function database(firestore, pair) {
  assertPrivatePairResources(pair);
  const emulator = /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") && /^demo-[a-z0-9-]+$/.test(firestore.projectId);
  if (!emulator) assertPublicationDatabase(firestore, publicationTarget(pair.environment));
}
function control(value, pairId) {
  exact(value, ["schemaVersion", "pairId", "status"]);
  if (value.schemaVersion !== 2 || value.pairId !== pairId || !["candidate", "retained", "retired"].includes(value.status)) refuse();
  return value;
}
function samePair(left, right) { return publicReleaseDigest(left) === publicReleaseDigest(right); }
function assertSeparate(left, right) {
  const occupied = new Set([right.publisher.application, right.publicWorker.service]);
  if (left.environment !== right.environment || left.pairId === right.pairId ||
      occupied.has(left.publisher.application) || occupied.has(left.publicWorker.service) ||
      left.publisher.journalNamespace === right.publisher.journalNamespace ||
      left.publicWorker.service === right.publicWorker.service) refuse();
}

/** Candidate registration is the only lifecycle write supplied here. Selection,
 * retention and retirement belong to later guarded switch/retirement layers.
 */
async function registerPublicReleasePair({ firestore, pair: input }) {
  const pair = parsePublicReleasePair(input);
  database(firestore, pair);
  const pairRef = ref(firestore, pair.pairId);
  return firestore.runTransaction(async transaction => {
    const [registryRow, pairRow] = await transaction.getAll(firestore.doc(PAIRS), pairRef);
    const registry = registryRow.exists ? registryRow.data() : { schemaVersion: 2, pairIds: [] };
    exact(registry, ["schemaVersion", "pairIds"]);
    if (registry.schemaVersion !== 2 || !Array.isArray(registry.pairIds) || registry.pairIds.length > 8 ||
        new Set(registry.pairIds).size !== registry.pairIds.length || registry.pairIds.some(id => !isPublicDeploymentIdentifier(id))) refuse();
    // Load at call time: the upload owner also reuses this module's resource
    // contract. Both fences run in the same registration transaction.
    await require("./public-release-pair-rollout").assertPublicReleasePairUploadRegistration(transaction, firestore, pair, registry);
    if (pairRow.exists) {
      if (!registry.pairIds.includes(pair.pairId) || !samePair(parsePublicReleasePair(pairRow.data()), pair)) refuse();
      return { idempotent: true, pair };
    }
    if (registry.pairIds.includes(pair.pairId) || registry.pairIds.length === 8) refuse();
    const rows = registry.pairIds.length ? await transaction.getAll(...registry.pairIds.map(id => ref(firestore, id))) : [];
    for (const row of rows) {
      const retained = parsePublicReleasePair(row.data());
      if (row.id !== publicReleasePairKey(retained.pairId)) refuse();
      assertSeparate(pair, retained);
    }
    transaction.create(pairRef, pair);
    transaction.create(pairRef.collection("controls").doc("runtime"), { schemaVersion: 2, pairId: pair.pairId, status: "candidate" });
    transaction.create(pairRef.collection("journals").doc(pair.publisher.journalNamespace), {
      schemaVersion: 2, pairId: pair.pairId, journalNamespace: pair.publisher.journalNamespace, job: null,
    });
    transaction.set(firestore.doc(PAIRS), { schemaVersion: 2, pairIds: [...registry.pairIds, pair.pairId].sort() });
    return { idempotent: false, pair };
  });
}

function parseTaskInput(value) {
  exact(value, ["kind", "sourceOperationId", "sourceVersion", "snapshotDigest", "contextSequence", "inputManifestDigest"]);
  if (!KINDS.has(value.kind) || !isPublicDeploymentIdentifier(value.sourceOperationId) || !positive(value.sourceVersion) ||
      !digest(value.snapshotDigest) || !digest(value.inputManifestDigest) ||
      !Number.isSafeInteger(value.contextSequence) || value.contextSequence < 0) refuse();
  return Object.freeze({ ...value });
}
function taskIdentity(pair, input) {
  return freeze({ schemaVersion: 2, pair: publicReleasePairReference(pair), ...parseTaskInput(input) });
}
function parseTask(value, pair, taskId) {
  exact(value, ["identity", "status", "attempts", "claimDigest", "leaseUntil", "nextAttemptAt", "acceptedDueAt", "receiptDigest", "lastFailure"]);
  const identity = value.identity;
  exact(identity, ["schemaVersion", "pair", "kind", "sourceOperationId", "sourceVersion", "snapshotDigest", "contextSequence", "inputManifestDigest"]);
  const expected = taskIdentity(pair, { kind: identity.kind, sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence,
    inputManifestDigest: identity.inputManifestDigest });
  if (!samePair(identity, expected) || publicReleaseDigest(identity) !== taskId ||
      !["pending", "running", "complete", "failed"].includes(value.status) ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > MAX_ATTEMPTS ||
      !(value.lastFailure === null || isPairFailureCode(value.lastFailure)) ||
      value.acceptedDueAt !== (identity.kind === "accepted" ? value.nextAttemptAt : null)) refuse();
  if (value.status === "pending" && (value.attempts !== 0 || value.claimDigest !== null || value.leaseUntil !== null ||
      value.nextAttemptAt !== 0 || value.receiptDigest !== null || value.lastFailure !== null)) refuse();
  if (value.status === "running" && (value.attempts < 1 || !digest(value.claimDigest) || !positive(value.leaseUntil) ||
      value.nextAttemptAt !== null || value.receiptDigest !== null)) refuse();
  if (value.status === "failed" && (value.attempts < 1 || value.claimDigest !== null || value.leaseUntil !== null || value.receiptDigest !== null || value.lastFailure === null ||
      (value.attempts === MAX_ATTEMPTS ? value.nextAttemptAt !== null : !positive(value.nextAttemptAt)))) refuse();
  if (value.status === "complete" && (value.attempts < 1 || value.claimDigest !== null || value.leaseUntil !== null ||
      value.nextAttemptAt !== null || !digest(value.receiptDigest))) refuse();
  return freeze({ ...value, identity: expected });
}
function parseJournal(value, pair) {
  exact(value, ["schemaVersion", "pairId", "journalNamespace", "job"]);
  if (value.schemaVersion !== 2 || value.pairId !== pair.pairId || value.journalNamespace !== pair.publisher.journalNamespace) refuse();
  if (value.job !== null) {
    exact(value.job, ["taskId", "claimDigest", "leaseUntil"]);
    if (!digest(value.job.taskId) || !digest(value.job.claimDigest) || !positive(value.job.leaseUntil)) refuse();
  }
  return value;
}
async function authority(transaction, firestore, pair) {
  database(firestore, pair);
  const pairRef = ref(firestore, pair.pairId);
  const [row, runtime, selectorRow] = await transaction.getAll(pairRef,
    pairRef.collection("controls").doc("runtime"), firestore.doc("system/publicDeployment"));
  if (!samePair(parsePublicReleasePair(row.data()), pair)) refuse();
  const status = control(runtime.data(), pair.pairId).status;
  if (status === "retired") refuse();
  return { pairRef, status, selector: parseVersionedPublicDeployment(selectorRow.data()) };
}
const switchCodeAuthorities = new WeakSet();
async function switchCodeAuthority(input) {
  const proof = await require("./public-release-switch-code-recovery").assertSwitchCodeRecoveryInTransaction(input);
  switchCodeAuthorities.add(proof); return proof;
}
function allowed(status, selector, kind, pair, admission, switchCode, initialControls = false) {
  if (kind === "qualification") {
    if (admission && status !== "candidate" && !initialControls) refuse();
    return;
  }
  if (status !== "retained" || selector.schemaVersion !== 2) refuse();
  if (admission && kind === "recovery" && samePair(selector.selectedPair, publicReleasePairReference(pair)) &&
      switchCodeAuthorities.has(switchCode) && switchCode.pairDigest === publicReleaseDigest(pair)) return;
  // Existing accepted work remains on its exact owner after the default moves.
  // Creating new accepted work must still choose the selected pair atomically.
  if (admission && !samePair(kind === "accepted" ? selector.selectedPair : selector.recoveryPair,
    publicReleasePairReference(pair))) refuse();
}

async function enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair: rawPair, input }) {
  const pair = parsePublicReleasePair(rawPair);
  const identity = taskIdentity(pair, input), taskId = publicReleaseDigest(identity);
  const { pairRef, status, selector } = await authority(transaction, firestore, pair);
  const workRef = pairRef.collection("work").doc(taskId);
  const existing = await transaction.get(workRef);
  if (existing.exists) return { idempotent: true, taskId, task: parseTask(existing.data(), pair, taskId) };
  const scope = pairInputs.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
  const [captured, billing, frozenScope] = await transaction.getAll(pairRef.collection("inputs").doc(identity.inputManifestDigest),
    firestore.doc("system/billing"), pairRef.collection("inputScopes").doc(pairInputs.publicReleasePairInputScopeKey(pair, scope)));
  if (billing.data()?.disabled === true) refuse();
  const receipt = pairInputs.parsePublicReleasePairInputReceipt(captured.data(), pair, scope, identity.inputManifestDigest);
  const slot = pairInputs.parsePublicReleasePairInputSlot(frozenScope.data(), pair, scope, identity.inputManifestDigest);
  if (slot.receiptDigest !== publicReleaseDigest(receipt)) refuse();
  if (identity.kind === "accepted" && status === "retained" && selector.schemaVersion === 2 &&
      !samePair(selector.selectedPair, publicReleasePairReference(pair))) {
    // H is captured after the source owner's atomic admission/outbox commit.
    // A changed default cannot strand that exact original admission, and
    // cannot authorize an unrelated new OLD operation.
    await require("./public-release-admission-contract").assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair, scope });
    allowed(status, selector, identity.kind, pair, false);
  } else {
    const initialControls = identity.kind === "qualification" && status === "retained" && selector.schemaVersion === 1
      ? await require("./public-release-initial-control-guard").assertInitialControlCaptureInTransaction({ firestore, transaction, pair, scope }) : null;
    const switchCode = identity.kind === "recovery" && status === "retained" && selector.schemaVersion === 2 &&
      samePair(selector.selectedPair, publicReleasePairReference(pair)) ? await switchCodeAuthority({ firestore, transaction, pair, scope,
        inputManifestDigest: identity.inputManifestDigest }) : undefined;
    allowed(status, selector, identity.kind, pair, true, switchCode, initialControls !== null);
  }
  const task = parseTask({ identity, status: "pending", attempts: 0, claimDigest: null, leaseUntil: null, nextAttemptAt: 0,
    acceptedDueAt: identity.kind === "accepted" ? 0 : null, receiptDigest: null, lastFailure: null }, pair, taskId);
  transaction.create(workRef, task);
  return { idempotent: false, taskId, task };
}

/** A new capture must still belong to an admissible private pair. Existing
 * immutable captures can be verified/repaired for retained original work. */
async function assertPublicReleasePairInputOwnerInTransaction({ firestore, transaction, pair: rawPair, scope: rawScope,
  inputManifestDigest }) {
  const pair = parsePublicReleasePair(rawPair), scope = pairInputs.parsePublicReleasePairInputScope(rawScope);
  if (!digest(inputManifestDigest)) refuse();
  const { pairRef, status, selector } = await authority(transaction, firestore, pair);
  const originalTaskId = publicReleaseDigest(taskIdentity(pair, { ...scope, inputManifestDigest }));
  const [captured, billing, originalWork, frozenScope] = await transaction.getAll(pairRef.collection("inputs").doc(inputManifestDigest),
    firestore.doc("system/billing"), pairRef.collection("work").doc(originalTaskId),
    pairRef.collection("inputScopes").doc(pairInputs.publicReleasePairInputScopeKey(pair, scope)));
  if (billing.data()?.disabled === true) refuse();
  const slot = frozenScope.exists ? pairInputs.parsePublicReleasePairInputSlot(frozenScope.data(), pair, scope, inputManifestDigest) : null;
  const receipt = captured.exists ? pairInputs.parsePublicReleasePairInputReceipt(captured.data(), pair, scope, inputManifestDigest) : null;
  if (receipt && (!slot || slot.receiptDigest !== publicReleaseDigest(receipt))) refuse();
  if (originalWork.exists) parseTask(originalWork.data(), pair, originalTaskId);
  if (!captured.exists && !originalWork.exists && scope.kind === "accepted" && status === "retained" &&
      selector.schemaVersion === 2 && !samePair(selector.selectedPair, publicReleasePairReference(pair))) {
    await require("./public-release-admission-contract").assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair, scope });
    allowed(status, selector, scope.kind, pair, false);
  } else {
    const isNew = !captured.exists && !originalWork.exists;
    const initialControls = isNew && scope.kind === "qualification" && status === "retained" && selector.schemaVersion === 1
      ? await require("./public-release-initial-control-guard").assertInitialControlCaptureInTransaction({ firestore, transaction, pair, scope }) : null;
    const switchCode = isNew && scope.kind === "recovery" && status === "retained" && selector.schemaVersion === 2 &&
      samePair(selector.selectedPair, publicReleasePairReference(pair)) ? await switchCodeAuthority({ firestore, transaction, pair, scope, inputManifestDigest }) : undefined;
    allowed(status, selector, scope.kind, pair, isNew, switchCode, initialControls !== null);
  }
  return { receipt, slot };
}

// Read-only wake hints and minute recovery use the same bounded due predicate.
// Hints never supply a claim, create work, or certify a publication.
function publicReleasePairTaskDue(task, now) {
  return task.status === "pending" || task.status === "running" && task.leaseUntil <= now ||
    task.status === "failed" && task.attempts < MAX_ATTEMPTS && task.nextAttemptAt <= now;
}
async function claimPublicReleasePairWork({ firestore, pair: rawPair, taskId, now = Date.now() }) {
  const pair = parsePublicReleasePair(rawPair);
  if (!digest(taskId) || !positive(now) || !Number.isSafeInteger(now + LEASE_MS)) refuse();
  const token = randomUUID(), claimDigest = publicReleaseDigest(token);
  return firestore.runTransaction(async transaction => {
    const { pairRef, status, selector } = await authority(transaction, firestore, pair);
    const journalRef = pairRef.collection("journals").doc(pair.publisher.journalNamespace);
    const workRef = pairRef.collection("work").doc(taskId);
    const [workRow, journalRow, billing] = await transaction.getAll(workRef, journalRef, firestore.doc("system/billing"));
    const task = parseTask(workRow.data(), pair, taskId), journal = parseJournal(journalRow.data(), pair);
    allowed(status, selector, task.identity.kind, pair, false);
    if (billing.data()?.disabled === true || !publicReleasePairTaskDue(task, now)) return null;
    if (journal.job !== null) {
      if (journal.job.leaseUntil > now) return null;
      // An expired task must be reconciled before taking a different task.
      if (journal.job.taskId !== taskId || journal.job.claimDigest !== task.claimDigest ||
          journal.job.leaseUntil !== task.leaseUntil) refuse();
    } else if (task.status === "running") refuse();
    if (task.attempts === MAX_ATTEMPTS) {
      transaction.set(workRef, { ...task, status: "failed", claimDigest: null, leaseUntil: null, nextAttemptAt: null,
        acceptedDueAt: null, lastFailure: "lease-expired" });
      transaction.set(journalRef, { ...journal, job: null });
      return null;
    }
    const leaseUntil = now + LEASE_MS;
    transaction.set(workRef, { ...task, status: "running", attempts: task.attempts + 1, claimDigest, leaseUntil, nextAttemptAt: null, acceptedDueAt: null });
    transaction.set(journalRef, { ...journal, job: { taskId, claimDigest, leaseUntil } });
    return { taskId, token, leaseUntil, identity: task.identity, outputPrefix: `release-pairs/${pair.pairId}/${taskId}/claims/${claimDigest}/` };
  });
}

async function readPublicReleasePairWork({ firestore, pair: rawPair, now = Date.now() }) {
  const pair = parsePublicReleasePair(rawPair);
  if (!positive(now)) refuse();
  return firestore.runTransaction(async transaction => {
    const { pairRef, status, selector } = await authority(transaction, firestore, pair);
    const [journalRow, billing] = await transaction.getAll(pairRef.collection("journals").doc(pair.publisher.journalNamespace),
      firestore.doc("system/billing"));
    const journal = parseJournal(journalRow.data(), pair);
    if (billing.data()?.disabled === true || journal.job?.leaseUntil > now) return { taskIds: [] };
    if (journal.job) {
      const task = parseTask((await transaction.get(pairRef.collection("work").doc(journal.job.taskId))).data(), pair, journal.job.taskId);
      allowed(status, selector, task.identity.kind, pair, false);
      if (task.status !== "running" || task.claimDigest !== journal.job.claimDigest || task.leaseUntil !== journal.job.leaseUntil) refuse();
      return { taskIds: [journal.job.taskId] };
    }
    // Both are single-field range queries, bounded independently. Null fields
    // belong to a different Firestore value type and do not match numeric ranges.
    const work = pairRef.collection("work");
    // Give accepted retries their own bounded single-field index query.
    const accepted = await transaction.get(work.where("acceptedDueAt", "<=", now).limit(1));
    if (!accepted.empty) {
      const row = accepted.docs[0], task = parseTask(row.data(), pair, row.id);
      if (task.identity.kind !== "accepted" || !publicReleasePairTaskDue(task, now)) refuse();
      allowed(status, selector, task.identity.kind, pair, false);
      return { taskIds: [row.id] };
    }
    const [pending, expired] = await Promise.all([
      transaction.get(work.where("nextAttemptAt", "<=", now).limit(20)),
      transaction.get(work.where("leaseUntil", "<=", now).limit(20)),
    ]);
    const tasks = new Map([...pending.docs, ...expired.docs].map(row => [row.id, parseTask(row.data(), pair, row.id)]));
    const due = [...tasks].filter(([, task]) => publicReleasePairTaskDue(task, now));
    for (const [, task] of due) allowed(status, selector, task.identity.kind, pair, false);
    due.sort((a, b) => Number(b[1].identity.kind === "accepted") - Number(a[1].identity.kind === "accepted") || a[0].localeCompare(b[0]));
    return { taskIds: due.map(([id]) => id) };
  }, { readOnly: true });
}

async function renewPublicReleasePairWork({ firestore, pair: rawPair, taskId, token, now = Date.now() }) {
  const pair = parsePublicReleasePair(rawPair);
  if (!digest(taskId) || typeof token !== "string" || !positive(now) || !Number.isSafeInteger(now + LEASE_MS)) refuse();
  return firestore.runTransaction(async transaction => {
    const { pairRef, status, selector } = await authority(transaction, firestore, pair);
    const journalRef = pairRef.collection("journals").doc(pair.publisher.journalNamespace), workRef = pairRef.collection("work").doc(taskId);
    const [workRow, journalRow] = await transaction.getAll(workRef, journalRef);
    const task = parseTask(workRow.data(), pair, taskId), journal = parseJournal(journalRow.data(), pair);
    allowed(status, selector, task.identity.kind, pair, false);
    if (task.status !== "running" || task.claimDigest !== publicReleaseDigest(token) || task.leaseUntil <= now ||
        journal.job?.taskId !== taskId || journal.job.claimDigest !== task.claimDigest || journal.job.leaseUntil !== task.leaseUntil) refuse();
    const leaseUntil = Math.max(task.leaseUntil, now + LEASE_MS);
    transaction.set(workRef, { ...task, leaseUntil });
    transaction.set(journalRef, { ...journal, job: { ...journal.job, leaseUntil } });
    return { leaseUntil };
  });
}

async function settlePublicReleasePairWork({ firestore, pair: rawPair, taskId, token, manifestDigest,
  retryAt = null, failureCode = null, now = Date.now() }) {
  const pair = parsePublicReleasePair(rawPair);
  if (!digest(taskId) || typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token) || !positive(now) ||
      !(manifestDigest === null || digest(manifestDigest)) || !(retryAt === null || positive(retryAt) && retryAt > now) ||
      manifestDigest !== null && retryAt !== null ||
      (manifestDigest === null ? !isPairFailureCode(failureCode) : failureCode !== null)) refuse();
  return firestore.runTransaction(async transaction => {
    const { pairRef, status, selector } = await authority(transaction, firestore, pair);
    const journalRef = pairRef.collection("journals").doc(pair.publisher.journalNamespace);
    const workRef = pairRef.collection("work").doc(taskId);
    const receiptRef = pairRef.collection("receipts").doc(taskId);
    const [workRow, journalRow, receiptRow] = await transaction.getAll(workRef, journalRef, receiptRef);
    const task = parseTask(workRow.data(), pair, taskId), journal = parseJournal(journalRow.data(), pair);
    allowed(status, selector, task.identity.kind, pair, false);
    const claimDigest = publicReleaseDigest(token);
    const receipt = manifestDigest === null ? null : { schemaVersion: 2, taskId, identity: task.identity, manifestDigest, claimDigest };
    if (task.status === "complete") {
      if (!receipt || !samePair(receiptRow.data(), receipt) || task.receiptDigest !== publicReleaseDigest(receipt)) refuse();
      return { idempotent: true };
    }
    if (task.status !== "running" || task.claimDigest !== claimDigest || task.leaseUntil <= now ||
        journal.job?.taskId !== taskId || journal.job.claimDigest !== claimDigest || journal.job.leaseUntil !== task.leaseUntil || receiptRow.exists) refuse();
    if (receipt) {
      transaction.create(receiptRef, receipt);
      // Atomic private staging outbox: a crash after completion cannot lose the
      // original claim/manifest or make recovery claim and render it again.
      transaction.create(pairRef.collection("staging").doc(taskId), { ...receipt, attempts: 0, nextAttemptAt: 0, lastFailure: null });
    }
    else if (task.attempts < MAX_ATTEMPTS && retryAt === null) refuse();
    transaction.set(workRef, { ...task, status: receipt ? "complete" : "failed", claimDigest: null, leaseUntil: null,
      nextAttemptAt: receipt || task.attempts === MAX_ATTEMPTS ? null : retryAt,
      acceptedDueAt: receipt || task.attempts === MAX_ATTEMPTS || task.identity.kind !== "accepted" ? null : retryAt,
      receiptDigest: receipt ? publicReleaseDigest(receipt) : null, lastFailure: receipt ? task.lastFailure : failureCode });
    transaction.set(journalRef, { ...journal, job: null });
    // This completes private rendering work only. It NEVER writes a public
    // operation outcome, admission pin, content head or deployment pointer.
    return { idempotent: false };
  });
}

/** Private staged-byte owners must prove the original completed claim. A
 * caller's output digest alone is never a durable work-completion receipt. */
async function assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair: rawPair,
  taskId, manifestDigest, claimDigest }) {
  const pair = parsePublicReleasePair(rawPair);
  if (![taskId, manifestDigest, claimDigest].every(digest)) refuse();
  const { pairRef, status, selector } = await authority(transaction, firestore, pair);
  const [workRow, receiptRow, billing] = await transaction.getAll(pairRef.collection("work").doc(taskId),
    pairRef.collection("receipts").doc(taskId), firestore.doc("system/billing"));
  const task = parseTask(workRow.data(), pair, taskId);
  allowed(status, selector, task.identity.kind, pair, false);
  const receipt = receiptRow.data();
  exact(receipt, ["schemaVersion", "taskId", "identity", "manifestDigest", "claimDigest"]);
  const expected = { schemaVersion: 2, taskId, identity: task.identity, manifestDigest, claimDigest };
  if (billing.data()?.disabled === true || task.status !== "complete" || !samePair(receipt, expected) ||
      task.receiptDigest !== publicReleaseDigest(expected)) refuse();
  return freeze(expected);
}

module.exports = { PAIRS, LEASE_MS, registerPublicReleasePair, enqueuePublicReleasePairWorkInTransaction,
  claimPublicReleasePairWork, settlePublicReleasePairWork, publicReleasePairTaskDue, readPublicReleasePairWork,
  renewPublicReleasePairWork, assertPublicReleasePairDatabase: database, assertPrivatePairResources, PairExecutionError,
  readPublicReleasePairWorkHint, publicReleasePairPath, publicReleasePairKey, assertPublicReleasePairCompletedReceiptInTransaction,
  assertPublicReleasePairInputOwnerInTransaction };
