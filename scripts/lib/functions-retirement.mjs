import { createHash } from "node:crypto";
import { ComponentReceiptError, requireRunAttempt, requireRunId, requireSha } from "./cms-component-receipt.mjs";

const NAME = /^[A-Za-z][A-Za-z0-9]{0,62}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const refuse = (reason = "scope_or_attempt_unverified") => { throw new ComponentReceiptError(`Functions retirement refused (${reason})`); };
const canonical = value => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : Array.isArray(value) ? value.map(canonical) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function requireRetirementScope(scope) {
  if (!scope || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(scope.projectId ?? "")
    || !/^[a-z]+-[a-z]+\d$/.test(scope.region ?? "") || !/^[a-z][a-z0-9_-]{0,62}$/.test(scope.codebase ?? "")) refuse();
  return { projectId: scope.projectId, region: scope.region, codebase: scope.codebase };
}

function names(value, empty = false) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > 512
    || value.some(name => typeof name !== "string" || !NAME.test(name)) || new Set(value).size !== value.length) refuse();
  return [...value].sort();
}

function functionIdentity(fn) {
  if ((fn.state ?? fn.status) !== "ACTIVE" || !Number.isFinite(Date.parse(fn.updateTime ?? ""))
    || !/^[A-Za-z0-9._-]{1,200}$/.test(String(fn.versionId ?? fn.serviceConfig?.revision ?? ""))) refuse("function_version_unverified");
  // Whitelist provider metadata: never copy parameter values or credentials.
  return digest({ name: fn.name, platform: fn.platform, state: fn.state ?? fn.status,
    updateTime: fn.updateTime, version: fn.versionId ?? fn.serviceConfig?.revision,
    entryPoint: fn.buildConfig?.entryPoint ?? fn.entryPoint, runtime: fn.buildConfig?.runtime ?? fn.runtime,
    uri: fn.serviceConfig?.uri ?? fn.httpsTrigger?.url,
    managed: fn.labels?.["deployment-tool"], codebase: fn.labels?.["firebase-functions-codebase"] ?? "default",
    scheduled: fn.labels?.["deployment-scheduled"], eventType: fn.eventType,
    eventFilters: fn.eventFilters, eventFilterPathPatterns: fn.eventFilterPathPatterns, triggerRegion: fn.triggerRegion });
}

function inventoryRows(functions, scope, targets) {
  if (!Array.isArray(functions) || functions.length > 5000) refuse();
  const rows = new Map();
  for (const fn of functions) {
    const match = fn?.name?.match(/^projects\/([^/]+)\/locations\/([^/]+)\/functions\/([A-Za-z][A-Za-z0-9-]*)$/);
    if (!match || match[1] !== scope.projectId || !["gcfv1", "gcfv2"].includes(fn.platform)
      || !fn.labels || typeof fn.labels !== "object" || Array.isArray(fn.labels)) refuse();
    if (match[2] !== scope.region) continue;
    const codebase = fn.labels["firebase-functions-codebase"] ?? "default";
    if (codebase !== scope.codebase) {
      if (targets.has(match[3])) refuse();
      continue;
    }
    if (typeof fn.labels["deployment-tool"] !== "string" || !fn.labels["deployment-tool"].startsWith("cli-firebase")) refuse("ownership_unverified");
    const existing = rows.get(match[3]);
    // Gen-1 resources can appear in both APIs. Prefer their authoritative v1
    // record; conflicting platforms or ownership never collapse silently.
    if (existing) {
      if (existing.platform !== fn.platform || existing.labels["deployment-tool"] !== fn.labels["deployment-tool"]
        || existing.labels["firebase-functions-codebase"] !== fn.labels["firebase-functions-codebase"]
        || existing.platform !== "gcfv1") refuse();
      if (existing.inventoryApiVersion === "v1") continue;
    }
    rows.set(match[3], fn);
  }
  return rows;
}

function schedulerIdentity(job) {
  if (!Number.isFinite(Date.parse(job.userUpdateTime ?? ""))) refuse("scheduler_version_unverified");
  return digest({ name: job.name, userUpdateTime: job.userUpdateTime, state: job.state, schedule: job.schedule, timeZone: job.timeZone,
    httpTarget: { uri: job.httpTarget?.uri, httpMethod: job.httpTarget?.httpMethod,
      oidcToken: { serviceAccountEmail: job.httpTarget?.oidcToken?.serviceAccountEmail, audience: job.httpTarget?.oidcToken?.audience } },
    pubsubTarget: { topicName: job.pubsubTarget?.topicName }, retryConfig: job.retryConfig });
}

function schedulerFor(fn, scope, jobs) {
  if (fn.platform === "gcfv1" && fn.labels["deployment-scheduled"]) refuse("scheduler_region_not_approved");
  const name = fn.name.split("/").at(-1);
  const resource = `projects/${scope.projectId}/locations/${scope.region}/jobs/firebase-schedule-${name}-${scope.region}`;
  const matches = jobs.filter(job => job?.name === resource);
  if (matches.length > 1) refuse();
  if (!matches.length) return null;
  const job = matches[0];
  const endpoint = fn.serviceConfig?.uri ?? fn.httpsTrigger?.url;
  const canonicalUrl = `https://${scope.region}-${scope.projectId}.cloudfunctions.net/${name}`;
  const urls = [canonicalUrl, `${canonicalUrl}/`];
  if (typeof endpoint === "string" && /^https:\/\/[a-z0-9.-]+\.run\.app\/?$/.test(endpoint)) {
    urls.push(endpoint, endpoint.endsWith("/") ? endpoint.slice(0, -1) : `${endpoint}/`);
  }
  const topic = fn.eventFilters?.topic ?? fn.eventFilters?.resource;
  if (fn.labels["deployment-scheduled"] !== "true" ||
    !(job.httpTarget?.httpMethod === "POST" && urls.includes(job.httpTarget.uri)
      || typeof topic === "string" && topic.startsWith(`projects/${scope.projectId}/topics/`) && job.pubsubTarget?.topicName === topic)) refuse();
  return { name: resource, fingerprint: schedulerIdentity(job) };
}

function attemptIdentity(value) {
  return { sourceSha: requireSha(value?.sourceSha), trustedWorkflowSha: requireSha(value?.trustedWorkflowSha),
    runId: requireRunId(value?.runId), runAttempt: requireRunAttempt(value?.runAttempt) };
}

function retainedEntry(entry, fn, jobs, scope) {
  if (fn && (fn.platform !== entry.platform || functionIdentity(fn) !== entry.fingerprint)) refuse("function_identity_changed");
  const name = `projects/${scope.projectId}/locations/${scope.region}/jobs/firebase-schedule-${entry.name}-${scope.region}`;
  const found = jobs.filter(job => job?.name === name);
  if (found.length > 1 || found.length && (!entry.scheduler || schedulerIdentity(found[0]) !== entry.scheduler.fingerprint)) refuse();
  return { ...entry, origin: { ...entry.origin } };
}

export function planFunctionRetirements({ scope: rawScope, targetNames, priorNames = [], functions, jobs = [], pendingPlan = null, ...attempt }) {
  const scope = requireRetirementScope(rawScope), targets = names(targetNames), origin = attemptIdentity(attempt);
  if (pendingPlan) validateRetirementPlan(pendingPlan, { ...pendingPlan, scope });
  const prior = names([...new Set([...names(priorNames, true), ...(pendingPlan?.priorNames ?? []), ...(pendingPlan?.targetNames ?? [])])], true);
  const pending = new Map((pendingPlan?.entries ?? []).filter(entry => !targets.includes(entry.name)).map(entry => [entry.name, entry]));
  if (!Array.isArray(jobs) || jobs.length > 5000) refuse();
  const target = new Set(targets), known = new Set([...targets, ...prior]);
  const rows = inventoryRows(functions, scope, target);
  const entries = [];
  for (const [name, fn] of rows) {
    if (!known.has(name)) refuse("unknown_live_function");
    if (target.has(name)) continue;
    entries.push(pending.has(name) ? retainedEntry(pending.get(name), fn, jobs, scope)
      : { name, platform: fn.platform, fingerprint: functionIdentity(fn), scheduler: schedulerFor(fn, scope, jobs), origin });
  }
  for (const entry of pending.values()) if (!rows.has(entry.name)) entries.push(retainedEntry(entry, null, jobs, scope));
  for (const name of prior.filter(name => !target.has(name) && !rows.has(name) && !pending.has(name))) {
    const orphan = `projects/${scope.projectId}/locations/${scope.region}/jobs/firebase-schedule-${name}-${scope.region}`;
    if (jobs.some(job => job?.name === orphan)) refuse("orphan_scheduler_without_original_plan");
  }
  return { schemaVersion: 1, scope, sourceSha: requireSha(attempt.sourceSha), trustedWorkflowSha: requireSha(attempt.trustedWorkflowSha),
    runId: requireRunId(attempt.runId), runAttempt: requireRunAttempt(attempt.runAttempt), targetNames: targets, priorNames: prior,
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function validateRetirementPlan(plan, context) {
  const scope = requireRetirementScope(context.scope);
  if (plan?.schemaVersion !== 1 || digest(plan.scope) !== digest(scope)
    || plan.sourceSha !== requireSha(context.sourceSha) || plan.trustedWorkflowSha !== requireSha(context.trustedWorkflowSha)
    || plan.runId !== requireRunId(context.runId) || requireRunAttempt(plan.runAttempt) > requireRunAttempt(context.runAttempt)
    || digest(names(plan.targetNames)) !== digest(names(context.targetNames)) || !Array.isArray(plan.entries)
    || plan.entries.length > 512) refuse();
  const prior = new Set(names(plan.priorNames, true)), seen = new Set();
  for (const entry of plan.entries) {
    const scheduler = `projects/${scope.projectId}/locations/${scope.region}/jobs/firebase-schedule-${entry?.name}-${scope.region}`;
    if (!NAME.test(entry?.name ?? "") || !prior.has(entry.name) || plan.targetNames.includes(entry.name) || seen.has(entry.name)
      || !["gcfv1", "gcfv2"].includes(entry.platform) || !DIGEST.test(entry.fingerprint ?? "")
      || entry.scheduler !== null && (entry.scheduler?.name !== scheduler || !DIGEST.test(entry.scheduler?.fingerprint ?? ""))) refuse();
    attemptIdentity(entry.origin);
    seen.add(entry.name);
  }
  return plan;
}

export async function applyFunctionRetirements(plan, context, io, selectedNames) {
  validateRetirementPlan(plan, context);
  for (const key of ["listFunctions", "listSchedules", "deleteFunction", "deleteSchedule", "assertAttempt"]) {
    if (typeof io?.[key] !== "function") refuse("provider_adapter_incomplete");
  }
  const selected = selectedNames === undefined ? plan.entries.map(entry => entry.name) : selectedNames;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length ||
      selected.some(name => !plan.entries.some(entry => entry.name === name))) refuse("invalid_retirement_selection");
  const entries = plan.entries.filter(entry => selected.includes(entry.name));
  // Keep the immutable full plan as the inventory authority in every phase.
  const targets = new Set(plan.targetNames), known = new Set([...plan.targetNames, ...plan.entries.map(entry => entry.name)]);
  const census = async () => {
    const rows = inventoryRows(await io.listFunctions(), plan.scope, targets);
    if ([...rows.keys()].some(name => !known.has(name))) refuse("unknown_live_function");
    return rows;
  };
  const readJob = async entry => {
    const jobs = await io.listSchedules();
    if (!Array.isArray(jobs)) refuse();
    const resource = `projects/${plan.scope.projectId}/locations/${plan.scope.region}/jobs/firebase-schedule-${entry.name}-${plan.scope.region}`;
    const matches = jobs.filter(job => job?.name === resource);
    if (matches.length > 1 || matches.length && (!entry.scheduler || schedulerIdentity(matches[0]) !== entry.scheduler.fingerprint)) refuse();
    return matches[0] ?? null;
  };
  for (const entry of entries) {
    await io.assertAttempt();
    const fn = (await census()).get(entry.name);
    await readJob(entry);
    if (fn) {
      if (fn.platform !== entry.platform || functionIdentity(fn) !== entry.fingerprint) refuse("function_identity_changed");
      await io.assertAttempt();
      // A lost response is settled only by actual absence of this exact target.
      try { await io.deleteFunction(entry.name, plan.scope); } catch { /* readback below owns settlement */ }
      if ((await census()).has(entry.name)) refuse("function_absence_unverified");
    }
    if (await readJob(entry)) {
      await io.assertAttempt();
      // Re-read ownership immediately before deleting the retained schedule.
      if (await readJob(entry)) {
        await io.assertAttempt();
        try { await io.deleteSchedule(entry.scheduler.name, plan.scope); } catch { /* absence must still be proved */ }
      }
      if (await readJob(entry)) refuse("scheduler_absence_unverified");
    }
  }
  const remaining = await census();
  for (const entry of entries) if (remaining.has(entry.name) || await readJob(entry)) refuse();
  await io.assertAttempt();
  return { retired: entries.length };
}
