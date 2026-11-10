"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { dateKey, periodFor, previousPeriod, snapshotDocument } = require("./lib/cost-ledger");
const store = require("./lib/cost-ledger-store");
const pullers = require("./lib/cost-pullers");

// Discovery does not receive functions dotenv values. This deployed artifact
// is the single decision used by discovery and the scheduled runtime.
function readDeploymentFlags() {
  try {
    const flags = JSON.parse(readFileSync(join(__dirname, "cost-ledger-pulls.generated.json"), "utf8"));
    if (!flags || Array.isArray(flags) || typeof flags !== "object"
      || pullers.PULLERS.some(({ flag }) => typeof flags[flag] !== "boolean")) return Object.freeze({});
    return Object.freeze(Object.fromEntries(pullers.PULLERS.map(({ flag }) => [flag, flags[flag]])));
  } catch {
    return Object.freeze({});
  }
}

const DEPLOYMENT_FLAGS = readDeploymentFlags();

function configuredSecret(flag, name) {
  return pullers.flagOn(DEPLOYMENT_FLAGS, flag) ? defineSecret(name) : null;
}

const GCP_BILLING_SA = configuredSecret("COST_LEDGER_GCP_PULL", "COST_LEDGER_GCP_BILLING_SA");
const CLOUDFLARE_API_TOKEN = configuredSecret("COST_LEDGER_CLOUDFLARE_PULL", "COST_LEDGER_CLOUDFLARE_API_TOKEN");
const AWS_ACCESS_KEY_ID = configuredSecret("COST_LEDGER_AWS_PULL", "COST_LEDGER_AWS_ACCESS_KEY_ID");
const AWS_SECRET_ACCESS_KEY = configuredSecret("COST_LEDGER_AWS_PULL", "COST_LEDGER_AWS_SECRET_ACCESS_KEY");
const GITHUB_TOKEN = configuredSecret("COST_LEDGER_GITHUB_PULL", "COST_LEDGER_GITHUB_TOKEN");

function deploymentFlags() {
  return DEPLOYMENT_FLAGS;
}

// The deploy workflow changes a requested flag to false when its required
// secret version or public configuration is absent. This makes the binding
// list safe during discovery and avoids a deploy-time secret prompt.
function configuredSecrets(flags) {
  const secrets = [];
  if (pullers.flagOn(flags, "COST_LEDGER_GCP_PULL")) secrets.push(GCP_BILLING_SA);
  if (pullers.flagOn(flags, "COST_LEDGER_CLOUDFLARE_PULL")) secrets.push(CLOUDFLARE_API_TOKEN);
  if (pullers.flagOn(flags, "COST_LEDGER_AWS_PULL")) {
    secrets.push(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY);
  }
  if (pullers.flagOn(flags, "COST_LEDGER_GITHUB_PULL")) secrets.push(GITHUB_TOKEN);
  return secrets;
}

const COST_PULL_SECRETS = configuredSecrets(DEPLOYMENT_FLAGS);

function runtimePullEnv(flags) {
  const env = { ...process.env };
  if (pullers.flagOn(flags, "COST_LEDGER_GCP_PULL")) {
    env.COST_LEDGER_GCP_BILLING_SA = GCP_BILLING_SA?.value() || "";
  }
  if (pullers.flagOn(flags, "COST_LEDGER_CLOUDFLARE_PULL")) {
    env.COST_LEDGER_CLOUDFLARE_API_TOKEN = CLOUDFLARE_API_TOKEN?.value() || "";
  }
  if (pullers.flagOn(flags, "COST_LEDGER_AWS_PULL")) {
    env.COST_LEDGER_AWS_ACCESS_KEY_ID = AWS_ACCESS_KEY_ID?.value() || "";
    env.COST_LEDGER_AWS_SECRET_ACCESS_KEY = AWS_SECRET_ACCESS_KEY?.value() || "";
  }
  if (pullers.flagOn(flags, "COST_LEDGER_GITHUB_PULL")) {
    env.COST_LEDGER_GITHUB_TOKEN = GITHUB_TOKEN?.value() || "";
  }
  return env;
}

async function closePreviousOpenPeriod(ledger, firestore, period, actor, nowIso) {
  return ledger.closeMonth(firestore, period, actor, nowIso, {
    onlyIfExists: true,
    respectSchedulerBlock: true,
  });
}

async function refreshCostLedger(deps = {}) {
  const {
    firestore = db,
    ledger = store,
    now = () => new Date(),
    flags = DEPLOYMENT_FLAGS,
    env = process.env,
    clients = pullers.LIVE_CLIENTS,
    log = logger,
  } = deps;
  if (!pullers.anyFlagOn(flags)) {
    return { outcome: "disabled", results: [] };
  }
  const clock = now();
  const nowIso = clock.toISOString();
  const period = periodFor(clock);
  const schedulerCanClose = Number(dateKey(clock).slice(-2)) >= 8;
  const actor = { uid: "cost-ledger-refresh", email: null, source: "scheduler" };
  async function applyResults(targetPeriod, pullResults) {
    for (const result of pullResults) {
      if (result.status === "fresh") {
        const applied = await ledger.writeAutomaticPeriod(firestore, targetPeriod, result.entries, nowIso);
        const appliedLines = new Set(applied.skipped ? [] : applied.appliedLineIds);
        const manualLines = new Set(applied.skipped ? [] : applied.manualLineIds);
        const eligibleLines = applied.eligibleLineIds || [];
        if (eligibleLines.some((lineId) => !appliedLines.has(lineId) && !manualLines.has(lineId))) {
          result.status = "error";
          result.message = "Automatic lines were not fully applied.";
        }
        for (const lineId of eligibleLines) {
          const freshness = manualLines.has(lineId) ? "manual" : appliedLines.has(lineId) ? "fresh" : "error";
          await ledger.writeLineFreshness(firestore, lineId, freshness, nowIso);
        }
        continue;
      }
      const freshnessAt = result.status === "disabled" ? null : nowIso;
      for (const lineId of result.lines) {
        await ledger.writeLineFreshness(firestore, lineId, result.status, freshnessAt);
      }
    }
  }
  const priorPeriod = previousPeriod(period);
  const prior = await ledger.loadPeriod(firestore, priorPeriod);
  let closed = { changed: false, period: prior };
  if (prior?.status === "open") {
    const priorResults = await pullers.collectPulls({ flags, env, clients, period: priorPeriod });
    await applyResults(priorPeriod, priorResults);
    if (
      schedulerCanClose
      && !prior.schedulerCloseBlockedAt
      && !priorResults.some((result) => result.status === "error")
    ) {
      closed = await closePreviousOpenPeriod(ledger, firestore, priorPeriod, actor, nowIso);
    }
  }
  const results = await pullers.collectPulls({ flags, env, clients, period });
  await applyResults(period, results);
  const view = await ledger.loadView(firestore, period);
  const snapshot = snapshotDocument(period, view, nowIso);
  await ledger.writeSnapshot(firestore, dateKey(clock), snapshot);
  log.info("cost ledger refresh completed", {
    period,
    closedPrevious: closed.changed === true,
    ...(closed.blocked ? { closeBlocked: { reason: closed.blocked.reason, lineIds: closed.blocked.lineIds } } : {}),
    pullers: results.map((result) => ({ id: result.id, status: result.status })),
  });
  return { period, closed, results };
}

function createCostLedgerRefreshRunner(deps) {
  return () => refreshCostLedger(deps);
}

const onCostLedgerRefresh = onSchedule(
  {
    schedule: "0 8 * * 1",
    timeZone: "America/New_York",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
    maxInstances: 1,
    concurrency: 1,
    secrets: COST_PULL_SECRETS,
  },
  () => {
    const flags = deploymentFlags();
    return refreshCostLedger({ flags, env: runtimePullEnv(flags) });
  },
);

module.exports = {
  createCostLedgerRefreshRunner,
  configuredSecrets,
  deploymentFlags,
  onCostLedgerRefresh,
  refreshCostLedger,
  runtimePullEnv,
};
