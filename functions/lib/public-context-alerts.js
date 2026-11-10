"use strict";

const { createHash, randomUUID } = require("node:crypto");
const logger = require("firebase-functions/logger");
const { FAILURE_CLASSES } = require("./background-output-attempt");
const { OUTPUTS } = require("./post-background-paths");
const { RECORD_FAMILIES } = require("./no-build-record-namespace");
const { ownsPublication } = require("./publication-runtime-owner");
const ALERT_PATH = "system/cmsContextJobAlerts";
const LEASE_MS = 60_000;
const RECOVERY_STALL_MS = 15 * 60_000;
const taskPath = /^cmsPublishQueue\/([A-Za-z0-9_-]{1,200})\/backgroundOutputs\/([A-Za-z0-9_-]+)$/;
const failureClass = value => FAILURE_CLASSES.includes(value) ? value : "validation";
const identityDigest = value => createHash("sha256").update(value).digest("hex");
const alertEpoch = value => typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : "legacy";

function automaticRecoveryActive(task, time) {
  if (!["pending", "failed", "building"].includes(task?.status)) return false;
  const dueAt = task.nextAttemptAt ?? task.slowRetryAt;
  // Due work remains automatic during the existing stalled-work window. A
  // stopped wake must not hide behind its old retry or claim indefinitely.
  return Number.isFinite(dueAt) && time - dueAt < RECOVERY_STALL_MS;
}

// Fixed family reads also cover Post-selected outputs. Keep notification text
// limited to identities and allowlisted outcomes, never content/provider text.
async function checkPublicContextAlerts({ firestore, send, now = Date.now, log = logger }) {
  const ref = firestore.doc(ALERT_PATH);
  const acquired = await firestore.runTransaction(async transaction => {
    const time = now();
    const [priorRow, deployment, anchorRow, ...states] = await transaction.getAll(ref,
      firestore.doc("system/publicDeployment"), firestore.doc("system/publicDeployment/aggregateContexts/current"),
      ...[...OUTPUTS, ...RECORD_FAMILIES].map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
    const runtime = { owner: "cloudflare", release: deployment.data()?.activeCommitSha };
    if (!/^[a-f0-9]{40}$/.test(runtime.release ?? "")) return null;
    const prior = priorRow.data() ?? {};
    if (prior.nextAttemptAt > time) return null;
    const anchor = anchorRow.data();
    const jobRef = /^[A-Za-z0-9]{20}$/.test(anchor?.operationId ?? "") && ownsPublication(anchor, runtime)
      ? firestore.doc(`cmsPublishQueue/${anchor.operationId}`) : null;
    const selected = states.filter(row => row.data()?.owner === "post-background-v1" && ownsPublication(row.data(), runtime) &&
      taskPath.test(row.data().taskPath ?? ""));
    const tasks = selected.length ? await transaction.getAll(...selected.map(row => firestore.doc(row.data().taskPath))) : [];
    const job = jobRef ? (await transaction.get(jobRef)).data() : null;
    const notices = [];
    const selectedIdentities = new Set();
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index].data();
      const state = selected[index].data();
      if (!task || !ownsPublication(task, runtime) || task.revision !== state.revision || task.output !== selected[index].id) continue;
      const id = taskPath.exec(state.taskPath)[1];
      const identity = `${state.taskPath}:${task.revision}:${alertEpoch(task.alertEpoch)}`;
      for (const reason of ["failed", "multiple_attempts", "attempt_over_half_budget"]) {
        selectedIdentities.add(identityDigest(`${identity}:${reason}`));
      }
      selectedIdentities.add(identityDigest(`${identity}:failed:actionable`));
      const add = (reason, outcome) => notices.push({ output: task.output, jobId: id, reason, failureClass: outcome,
        actionable: reason === "failed" && !automaticRecoveryActive(task, time),
        identity: `${identity}:${reason}` });
      const exhausted = task.attempts >= 4 && task.status !== "verified" &&
        (task.nextAttemptAt === null || task.claim && task.nextAttemptAt <= time);
      if (exhausted) add("failed", task.claim ? "lease_lost" : failureClass(task.lastAttempt?.failureClass));
      if (task.attempts > 1) add("multiple_attempts", task.lastAttempt?.failureClass == null && task.status === "verified"
        ? "none" : failureClass(task.lastAttempt?.failureClass));
      if (task.lastAttempt?.durationMs > task.lastAttempt?.budgetMs / 2) {
        add("attempt_over_half_budget", task.lastAttempt.failureClass == null ? "none" : failureClass(task.lastAttempt.failureClass));
      }
    }
    if (job?.transport === "public-context-no-build-v1" && ownsPublication(job, runtime) &&
        job.publicContext?.contextDigest === anchor.contextDigest) {
      const identity = `aggregate:${anchor.operationId}:${anchor.contextDigest}:${alertEpoch(job.alertEpoch)}:failed`;
      selectedIdentities.add(identityDigest(identity));
      selectedIdentities.add(identityDigest(`${identity}:actionable`));
      if (job.status === "failed") notices.push({ output: "aggregate", jobId: anchor.operationId, reason: "failed",
        actionable: job.error === "background_preparation_failed" ||
          !tasks.some(row => automaticRecoveryActive(row.data(), time)) &&
            !(tasks.length && tasks.every(row => row.data()?.status === "verified")),
        failureClass: notices.find(value => value.reason === "failed")?.failureClass ?? "validation", identity });
    }
    notices.sort((a, b) => Number(b.actionable) - Number(a.actionable) || Number(b.reason === "failed") - Number(a.reason === "failed"));
    const identities = notices.map(value => identityDigest(`${value.identity}${value.actionable ? ":actionable" : ""}`));
    const pending = notices.map((notice, index) => ({ ...notice, identity: identities[index] }))
      .filter(notice => !prior.sentIdentities?.includes(notice.identity)).slice(0, 8);
    if (!pending.length) return null;
    const claim = randomUUID();
    transaction.set(ref, { ...prior, claim, nextAttemptAt: time + LEASE_MS });
    return { claim, identities: [...new Set([...(prior.sentIdentities ?? []).filter(identity => selectedIdentities.has(identity)),
      ...pending.map(value => value.identity)])],
      observations: pending.map(({ output, jobId, reason, failureClass }) => ({ output, jobId, reason, failureClass })),
      message: pending.filter(value => value.actionable).map(value =>
      `NJ PBS background output ${value.output}: ${value.reason}; failure class ${value.failureClass}; job ${value.jobId}.`).join("\n") };
  });
  if (!acquired) return;
  try {
    if (acquired.message) await send(acquired.message);
    log.info?.("Public context output status", { observations: acquired.observations });
    await firestore.runTransaction(async transaction => {
      if ((await transaction.get(ref)).data()?.claim === acquired.claim) {
        // At most four identities per fixed family plus the current aggregate.
        // Replacing a job drops old identities instead of growing a history.
        transaction.set(ref, { claim: null, nextAttemptAt: null, sentIdentities: acquired.identities });
      }
    });
  } catch {
    log.error("Public context alert delivery failed");
  }
}

module.exports = { checkPublicContextAlerts, automaticRecoveryActive };
