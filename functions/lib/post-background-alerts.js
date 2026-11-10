"use strict";

const { createHash, randomUUID } = require("node:crypto");
const logger = require("firebase-functions/logger");
const { SUPPORTED_OUTPUTS: OUTPUTS, dependency, backgroundHealth, pageOwnsHomeInTransaction } = require("./post-background-outputs");
const { readPublicBackgroundContextInTransaction } = require("./public-context-revision");
const { listNoBuildPostOwners, readNoBuildPostOwner } = require("./no-build-post-ownership");
const { POST_PROOF_EXHAUSTED_WARNING } = require("./no-build-post-proof-state");
const { outputLimits } = require("./no-build-record-namespace");
const { publicContextProgressAt } = require("./no-build-cloud-work");
const { automaticRecoveryActive } = require("./public-context-alerts");
const { ownsPublication } = require("./publication-runtime-owner");
const { cmsPublicationRuntimeRef, projectCmsPublicationRuntimeControl, cloudCmsPublicationRuntimeControl } = require("./cms-publication-runtime-control");
const ALERT_LEASE_MS = 5 * 60_000;
const RESUME_GRACE_MS = 5 * 60_000;
const REBUILD_ALERT_AFTER_MS = 15 * 60_000;
const ALERT_MESSAGES = {
  search_capacity: "Search output has reached 80% of its file or byte limit; increase capacity before the next corpus growth.",
  release_mismatch: "Listing output has no verified release asset manifest; old output is blocked until replacement verifies.",
  release_pending: "Listing regeneration is pending for another code release; last verified output remains available within its safety limits.",
  state_unreadable: "Listing state is unreadable; inspect the family and published input.",
  withdrawal_expired: "Withdrawal stale limit reached; old listing output is blocked.",
  stale_expired: "24-hour stale limit reached; old listing output is blocked.",
  output_blocked: "Public listing output is blocked; the publishing operator must restore a verified replacement.",
  recovery_exhausted: "Automatic listing recovery is exhausted; the publishing operator must retry or repair the output.",
};

const replacementRunning = (value, time) => Boolean(["building", "pending", "failed"].includes(value?.status) &&
  value.claim && value.nextAttemptAt > time);
const replacementFailed = (value, time) => value?.status === "failed" && value.nextAttemptAt === null ||
  Boolean(value?.claim && value.attempts >= 4 && value.nextAttemptAt <= time);
const recoveryExhausted = (value, time) => (value?.status === "failed" && value.nextAttemptAt === null ||
  value?.claim && value.attempts >= 4 && value.nextAttemptAt <= time) && !automaticRecoveryActive(value, time);

function actionableReason(health) {
  if (health.reason === "search_capacity") return null;
  if (["release_mismatch", "state_unreadable", "withdrawal_expired", "stale_expired"].includes(health.reason)) return health.reason;
  if (health.terminalFailure) return "recovery_exhausted";
  if (health.reason === "rebuild_delayed" && health.servingBlocked) return "output_blocked";
  return null;
}

function delayedAlertsSuppressed(snapshot, time) {
  try {
    const control = projectCmsPublicationRuntimeControl(snapshot);
    if (!control) return false;
    const runtime = cloudCmsPublicationRuntimeControl(control);
    // The control has no timestamp field. Its existing update time also covers
    // a pause and resume that occur between minute-observer passes.
    return runtime.phase !== "ready" || time < snapshot.updateTime.toMillis() + RESUME_GRACE_MS;
  } catch {
    // Missing or invalid admission evidence must not hide an actual failure.
    return false;
  }
}

function familyAlertMessage(families) {
  const groups = new Map();
  for (const { output, health } of families) {
    if (!groups.has(health.reason)) groups.set(health.reason, []);
    groups.get(health.reason).push(output);
  }
  return [...groups].map(([reason, outputs]) => `NJ PBS ${outputs.join(", ")}: ${ALERT_MESSAGES[reason]}`).join("\n");
}

async function readFamilyHealthInTransaction({ firestore, transaction, time }) {
  const rows = await transaction.getAll(...OUTPUTS.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
  const homeRow = rows.find(row => row.id === "home");
  const home = homeRow?.data();
  let pageHome = false;
  try { pageHome = await pageOwnsHomeInTransaction({ firestore, transaction, marker: home }); }
  catch { /* An invalid handoff stays visible as unreadable state below. */ }
  const active = rows.filter(row => row.exists && !(row.id === "home" && pageHome));
  let context;
  try { if (active.length) context = await readPublicBackgroundContextInTransaction(transaction, firestore); }
  catch { /* Each active family below records the unreadable shared input. */ }
  const selected = active.some(row => row.data()?.contextOnly === true)
    ? (await transaction.get(firestore.doc("system/publicDeployment/aggregateContexts/current"))).data() : null;
  let progressAt = null;
  let preparationRunning = false, preparationFailed = false, preparationExhausted = false;
  if (context && /^[A-Za-z0-9]{20}$/.test(selected?.operationId ?? "") && /^[A-Za-z0-9]{20}$/.test(selected?.preparationOperationId ?? "")) {
    const [queue, preparation] = await transaction.getAll(firestore.doc(`cmsPublishQueue/${selected.operationId}`),
      firestore.doc(`cmsPublishQueue/${selected.preparationOperationId}/backgroundPreparation/${selected.contextDigest}`));
    progressAt = publicContextProgressAt({ aggregate: selected, queue: queue.data(), preparation: preparation.data(),
      // An expired lease does not erase actual completed progress from the
      // longer notification window. Health keeps its stricter lease check.
      runtime: { owner: "cloudflare", release: context.rendererSha }, now: time, retainProgress: true });
    const runtime = { owner: "cloudflare", release: context.rendererSha };
    if (queue.exists && ownsPublication(selected, runtime) && ownsPublication(queue.data(), runtime) &&
        queue.data().transport === "public-context-no-build-v1" && queue.data().publicContext?.contextDigest === selected.contextDigest) {
      const prepared = preparation.data();
      const matching = prepared && ownsPublication(prepared, runtime) && prepared.contextDigest === selected.contextDigest;
      preparationRunning = queue.data().status === "pending" && matching && prepared.status === "building" && replacementRunning(prepared, time);
      preparationFailed = queue.data().status === "failed" || matching && replacementFailed(prepared, time);
      preparationExhausted = queue.data().status === "failed" && queue.data().error === "background_preparation_failed" ||
        matching && recoveryExhausted(prepared, time);
    }
  }
  const taskPaths = [...new Set(active.map(row => row.data().taskPath))]
    .filter(value => /^cmsPublishQueue\/[A-Za-z0-9_-]{1,200}\/backgroundOutputs\/[A-Za-z0-9_-]+$/.test(value ?? ""));
  const tasks = taskPaths.length ? await transaction.getAll(...taskPaths.map(value => firestore.doc(value))) : [];
  const preparationPaths = context ? [...new Set(active.filter(row => row.data().contextOnly !== true && taskPaths.includes(row.data().taskPath))
    .map(row => `cmsPublishQueue/${row.data().taskPath.split("/")[1]}/backgroundPreparation/${context.digest}`))] : [];
  const preparations = preparationPaths.length ? await transaction.getAll(...preparationPaths.map(value => firestore.doc(value))) : [];
  const postIds = [...new Set(active.map(row => row.data().postId))]
    .filter(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id));
  const posts = postIds.length ? await transaction.getAll(...postIds.map(id => firestore.doc(`cmsPosts/${id}`))) : [];
  // End a repaired owner-pair outage even though the Page marker is excluded
  // from Post output monitoring. A later invalid pair needs a fresh alert.
  if (pageHome && Number.isFinite(home.pendingSince)) transaction.update(homeRow.ref, { pendingSince: null });
  const states = active.map(row => {
    const state = row.data();
    let health;
    try {
      if (!context) throw new Error("Public context is unavailable");
      const source = dependency(posts.find(post => post.id === state.postId)?.data());
      const selectedFamily = state.contextOnly === true && state.taskPath === `cmsPublishQueue/${selected?.namespaceOperationId}/backgroundOutputs/${row.id}`;
      const task = tasks.find(task => task.ref.path === state.taskPath)?.data();
      const matching = task?.owner === state.owner && task.schemaVersion === 1 && task.revision === state.revision &&
        task.output === row.id && task.contextDigest === state.contextDigest &&
        (state.runtime ? ownsPublication(task, state.runtime) : task.runtime === undefined);
      const postPreparation = state.contextOnly !== true && preparations.find(value =>
        value.ref.path === `cmsPublishQueue/${state.taskPath?.split("/")[1]}/backgroundPreparation/${context.digest}`)?.data();
      const postPreparationStopped = matching && postPreparation?.contextDigest === context.digest &&
        (state.runtime ? ownsPublication(postPreparation, { ...state.runtime, release: context.rendererSha }) : postPreparation.runtime === undefined) &&
        replacementFailed(postPreparation, time);
      const failed = selectedFamily && preparationFailed || matching && replacementFailed(task, time) || postPreparationStopped;
      const running = selectedFamily && preparationRunning || matching && replacementRunning(task, time);
      health = backgroundHealth(state, source, { ...context, progressAt: selectedFamily ? progressAt : null }, time,
        failed ? 0 : running ? Infinity : REBUILD_ALERT_AFTER_MS);
      health.terminalFailure = selectedFamily && preparationExhausted || matching && recoveryExhausted(task, time) || postPreparationStopped;
    } catch {
      const pendingSince = Number.isFinite(state.pendingSince) ? state.pendingSince : time;
      if (!Number.isFinite(state.pendingSince)) transaction.update(row.ref, { pendingSince });
      return { output: row.id, health: { reason: "state_unreadable", good: null,
        pendingSince } };
    }
    // Preparation can fail before recovery creates a new task. Retain the
    // first observed outage so unrelated publications cannot defer its alert.
    if (!health.current && !Number.isFinite(state.pendingSince)) {
      transaction.update(row.ref, { pendingSince: health.pendingSince });
    } else if (health.current && Number.isFinite(state.pendingSince)) {
      transaction.update(row.ref, { pendingSince: null });
    }
    return { output: row.id, health };
  });
  if (pageHome) states.push({ output: "home", health: { current: true } });
  return states;
}

// The existing minute scheduler and staff alert credentials deliver these fixed,
// public-only messages. A durable lease bounds duplicates and retries per outage.
async function checkFamilyAlerts({ firestore, send, now = Date.now, log = logger, capacity = false }) {
  // Capacity persists across context regenerations. Give it its own instance
  // of the existing alert lease so outages can recover independently.
  const alertRef = firestore.doc(capacity ? "system/cmsSearchCapacityAlerts" : "system/cmsBackgroundAlerts");
  const acquired = await firestore.runTransaction(async transaction => {
    const time = now();
    const [runtimeRow, alertRow] = await transaction.getAll(cmsPublicationRuntimeRef(firestore), alertRef);
    const prior = alertRow.data() ?? {};
    const suppressDelayed = delayedAlertsSuppressed(runtimeRow, time);
    const states = (await readFamilyHealthInTransaction({ firestore, transaction, time }))
      .filter(({ output }) => !capacity || output === "search")
      .map(family => ({ ...family, health: { ...family.health,
        reason: (family.health.reason === "search_capacity") === capacity ? family.health.reason : null } }));
    if (prior.nextAttemptAt > time) return null;
    const pending = states.filter(({ health }) => health.reason &&
      !(suppressDelayed && health.reason === "rebuild_delayed" && !health.terminalFailure))
      .map(family => {
        const notifyReason = actionableReason(family.health);
        const identity = createHash("sha256").update(JSON.stringify([family.output, family.health.reason, notifyReason,
          capacity ? outputLimits("search") : family.health.good?.receipt.digest ?? family.health.pendingSince])).digest("hex");
        return { ...family, notifyReason, identity };
      })
      .filter(family => !prior.sentIdentities?.includes(family.identity));
    // A suppressed or not-yet-delayed family is still pending, not recovered.
    // Require each alerted family or its validated Page Home handoff. A missing
    // family record is not evidence of recovery.
    const recovered = Boolean(prior.outputs?.length) && states.every(({ health }) => health.current && !health.reason) &&
      prior.outputs.every(output => states.some(family => family.output === output));
    if (!pending.length && !recovered) return null;
    const claim = randomUUID();
    transaction.set(alertRef, { ...prior, claim, nextAttemptAt: time + ALERT_LEASE_MS });
    return { claim, recovered, identities: pending.map(family => family.identity),
      outputs: recovered ? prior.outputs : pending.map(family => family.output),
      message: recovered ? null : familyAlertMessage(pending.filter(family => family.notifyReason)
        .map(family => ({ ...family, health: { ...family.health, reason: family.notifyReason } }))),
      observations: pending.map(({ output, health }) => ({ output, reason: health.reason })) };
  });
  if (!acquired) return;
  try {
    if (acquired.message) await send(acquired.message);
    log.info?.("Post background output status", { outputs: acquired.outputs, recovered: acquired.recovered,
      observations: acquired.observations });
    await firestore.runTransaction(async transaction => {
      const prior = (await transaction.get(alertRef)).data();
      if (prior?.claim !== acquired.claim) return;
      const sentIdentities = acquired.recovered ? [] : [...new Set([...(prior.sentIdentities ?? []), ...acquired.identities])];
      const outputs = acquired.recovered ? [] : [...new Set([...(prior.outputs ?? []), ...acquired.outputs])];
      transaction.set(alertRef, { sentIdentities, outputs, claim: null, nextAttemptAt: null });
    });
  } catch {
    log.error("Post background alert delivery failed", { outputs: acquired.outputs, recovered: acquired.recovered });
    // The next minute pass retries after the durable five-minute lease.
  }
}

async function checkPostProofAlerts({ firestore, send, now = Date.now, log = logger }) {
  const owners = (await listNoBuildPostOwners({ firestore })).filter(owner => owner.state.operationId && owner.state.mode !== "static");
  for (const { state } of owners) {
    const queueRef = firestore.doc(`cmsPublishQueue/${state.operationId}`);
    const ref = queueRef.collection("alerts").doc("public-proof");
    const claim = randomUUID();
    const acquired = await firestore.runTransaction(async transaction => {
      const queue = (await transaction.get(queueRef)).data();
      const prior = (await transaction.get(ref)).data();
      const current = (await readNoBuildPostOwner({ firestore, transaction, postId: state.postId })).state;
      if (current?.operationId !== state.operationId || queue?.transport !== "post-no-build-v1" ||
          queue.status !== "success" || queue.postProof?.status !== "failed" || queue.postProof.nextAttemptAt !== null ||
          prior?.sentAt || prior?.nextAttemptAt > now()) return null;
      // Alert only after the last retry fails; a failed check with a retry due usually passes on its own.
      transaction.set(ref, { reason: "public_proof_failed", claim, nextAttemptAt: now() + 5 * 60_000, sentAt: null });
      return POST_PROOF_EXHAUSTED_WARNING;
    });
    if (!acquired) continue;
    try {
      await send(`NJ PBS Post ${state.slug}: ${acquired}`);
      await firestore.runTransaction(async transaction => {
        if ((await transaction.get(ref)).data()?.claim === claim) transaction.update(ref, { sentAt: now(), claim: null });
      });
    } catch {
      log.error("Post public check alert delivery failed", { postId: state.postId });
    }
  }
}

async function checkPostBackgroundAlerts(options) {
  try { await checkPostProofAlerts(options); }
  finally {
    try { await require("./public-context-alerts").checkPublicContextAlerts(options); }
    finally { await checkFamilyAlerts(options); await checkFamilyAlerts({ ...options, capacity: true }); }
  }
}
module.exports = { checkPostBackgroundAlerts, checkPostProofAlerts };
