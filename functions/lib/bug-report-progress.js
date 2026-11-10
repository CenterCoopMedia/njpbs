"use strict";

// Shared, staff-safe projection. Engineering state is evidence of work, never
// proof that a fix is live or that an administrator resolved the report.
const STALE_AFTER_MILLIS = 26 * 60 * 60 * 1_000;
const LABELS = Object.freeze({
  received: ["Received", "The report is saved and awaiting review."],
  acknowledged: ["Acknowledged", "The report has been acknowledged."],
  queued: ["Work queued", "A fix has been requested and is waiting to start."],
  in_progress: ["In progress", "Work on this report has started."],
  ready_for_review: ["Fix ready for review", "A proposed fix is awaiting review. It is not confirmed live."],
  changes_requested: ["Changes requested", "The proposed fix needs changes before it can proceed."],
  checks_failed: ["Checks need attention", "The proposed fix has a failed check and needs attention."],
  merged: ["Merged; live verification pending", "The code change is merged. The live fix has not been verified."],
  closed: ["Engineering work closed", "The linked engineering work is closed. This does not confirm a live fix or resolve this report."],
  resolved: ["Resolved", "An administrator marked this report resolved."],
  dismissed: ["Closed", "An administrator closed this report without marking it resolved."],
  blocked: ["Blocked", "Work on this report is blocked."],
  needs_attention: ["Needs attention", "The requested work needs an administrator to review the next step."],
  reopened: ["Reopened", "Linked engineering work has reopened and needs follow-up."],
});

function iso(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function numberedRows(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => Number.isSafeInteger(row?.number) && row.number > 0 &&
    row.number <= 2_147_483_647 && ["open", "closed"].includes(row.state)).slice(0, 10);
}

function progressEvidence(record) {
  return JSON.stringify({
    status: record?.status, ownerUid: record?.ownerUid ?? null,
    acknowledgedAt: record?.acknowledgedAt ?? null,
    resolution: record?.actionableResolution ?? null,
    fixStatus: record?.githubDelivery?.fixStatus ?? "not_requested",
    issues: numberedRows(record?.links?.githubIssues).map(({ number, state, reopenedAt, unavailable }) => ({ number, state, reopenedAt, unavailable: unavailable === true })),
    pulls: numberedRows(record?.links?.pullRequests).map(({ number, state, draft, merged, reviewState, checksState, unavailable }) => ({ number, state, draft, merged, reviewState, checksState, unavailable: unavailable === true })),
  });
}

function lastProgressAt(record) {
  // updatedAt and lastSyncedAt also change on delivery and identical syncs.
  return [record?.progressChangedAt, record?.createdAt, record?.acknowledgedAt,
    record?.assignedAt, record?.resolvedAt, record?.dismissedAt,
    record?.githubDelivery?.fixRequestedAt, record?.githubDelivery?.fixStartedAt,
    record?.githubDelivery?.fixCompletedAt]
    .map(iso).filter(Boolean).sort().at(-1) ?? null;
}

function progressChangeFields(before, after, at) {
  // A new GitHub handoff selection precedes hydrated link rows. Count its intent
  // once, while retries and settlement of that same handoff remain bookkeeping.
  const handoff = (record) => {
    const delivery = record?.githubDelivery;
    if (delivery?.lastOperation === "create_issue") return "create_issue";
    return ["attach_issue", "attach_pull_request"].includes(delivery?.lastOperation) &&
      Number.isSafeInteger(delivery.lastTargetNumber) && delivery.lastTargetNumber > 0 &&
      delivery.lastTargetNumber <= 2_147_483_647
      ? `${delivery.lastOperation}:${delivery.lastTargetNumber}` : null;
  };
  const queuedHandoff = after?.githubDelivery?.state === "pending" &&
    handoff(after) !== null && handoff(after) !== handoff(before);
  return { progressChangedAt: !queuedHandoff && progressEvidence(before) === progressEvidence(after)
    ? lastProgressAt(before) : iso(at) };
}

function reportProgress(record, { now = new Date() } = {}) {
  const delivery = record?.githubDelivery ?? {};
  const issueRows = numberedRows(record?.links?.githubIssues);
  const pullRows = numberedRows(record?.links?.pullRequests);
  const issues = issueRows.map(({ number, state, unavailable }) => ({ number, state: unavailable ? "unavailable" : state }));
  const pullRequests = pullRows.map((pull) => ({
    number: pull.number,
    state: pull.unavailable ? "unavailable" : pull.state,
    draft: pull.draft === true,
    merged: pull.merged === true,
    reviewState: ["approved", "changes_requested", "pending", "none"].includes(pull.reviewState)
      ? pull.reviewState : "none",
    checksState: ["success", "failure", "pending", "none"].includes(pull.checksState)
      ? pull.checksState : "none",
  }));
  const pendingPull = (record?.links?.pullRequestNumbers ?? []).some((number) => !pullRequests.some((pull) => pull.number === number));
  const openPulls = pullRequests.filter((pull) => pull.state === "open" && !pull.merged);
  const terminalAt = iso(record?.resolvedAt) || iso(record?.dismissedAt);
  const reopened = issueRows.some((issue) => issue.state === "open" && iso(issue.reopenedAt) &&
    (!terminalAt || iso(issue.reopenedAt) > terminalAt));
  let phase = "received";
  if (record?.status === "resolved" && !reopened) phase = "resolved";
  else if (record?.status === "dismissed" && !reopened) phase = "dismissed";
  else if (record?.status === "blocked") phase = "blocked";
  else if ([...issues, ...pullRequests].some((item) => item.state === "unavailable")) phase = "needs_attention";
  else if (openPulls.some((pull) => pull.reviewState === "changes_requested")) phase = "changes_requested";
  else if (openPulls.some((pull) => pull.checksState === "failure")) phase = "checks_failed";
  else if (openPulls.some((pull) => pull.draft)) phase = "in_progress";
  else if (openPulls.length) phase = "ready_for_review";
  else if (!reopened && pullRequests.some((pull) => pull.merged)) phase = "merged";
  else if (delivery.fixStatus === "running") phase = "in_progress";
  else if (delivery.fixStatus === "pending") phase = "queued";
  else if (reopened) phase = "reopened";
  else if (issues.length && issues.every((issue) => issue.state === "closed")) phase = "closed";
  else if (pullRequests.length && !pendingPull && pullRequests.every((pull) => pull.state === "closed" && !pull.merged)) phase = "needs_attention";
  else if (delivery.fixStatus === "draft_pr_open") phase = "in_progress";
  else if (["failed", "investigation_only"].includes(delivery.fixStatus)) phase = "needs_attention";
  else if (record?.status === "in_progress") phase = "in_progress";
  else if (record?.status === "acknowledged") phase = "acknowledged";
  const linked = issues.length > 0 || pullRequests.length > 0 ||
    (record?.links?.githubIssueNumbers?.length ?? 0) > 0 ||
    (record?.links?.pullRequestNumbers?.length ?? 0) > 0;
  const lastSyncedAt = iso(delivery.lastSyncedAt);
  let syncState = linked ? "current" : "not_linked";
  if (["retryable_failed", "terminal_failed", "unknown"].includes(delivery.state) ||
    [...issues, ...pullRequests].some((item) => item.state === "unavailable")) syncState = "unavailable";
  else if (linked && (!lastSyncedAt || now.getTime() - Date.parse(lastSyncedAt) > STALE_AFTER_MILLIS)) syncState = "stale";
  else if (delivery.state === "pending" ||
    (record?.links?.githubIssueNumbers ?? []).some((number) => !issues.some((item) => item.number === number)) ||
    (record?.links?.pullRequestNumbers ?? []).some((number) => !pullRequests.some((item) => item.number === number))) syncState = "pending";
  return {
    phase,
    stage: ["resolved", "dismissed"].includes(phase) ? "closed" : phase === "merged" ? "awaiting_live"
      : ["ready_for_review", "changes_requested", "checks_failed"].includes(phase) ? "review"
        : phase === "in_progress" && (pullRequests.length || ["running", "draft_pr_open"].includes(delivery.fixStatus)) ? "fixing"
          : phase === "received" ? "received" : "investigating",
    label: LABELS[phase][0],
    detail: LABELS[phase][1],
    active: !["resolved", "dismissed"].includes(phase),
    updatedAt: lastProgressAt(record),
    lastSyncedAt,
    syncState,
    issues,
    pullRequests,
    deployment: "unverified",
  };
}

// GitHub reads can finish out of order. Never overwrite newer linked evidence.
// A closed-to-open transition is recorded separately from report.status.
function mergeGithubEvidence(current, updates, { trackReopen = false, observedAt = null } = {}) {
  const values = new Map((current ?? []).map((entry) => [entry.number, entry]));
  for (const update of updates ?? []) {
    const previous = values.get(update.number);
    const observation = iso(observedAt) || iso(update.observedAt);
    const newerSource = iso(previous?.updatedAt) && iso(update.updatedAt) && iso(update.updatedAt) > iso(previous.updatedAt);
    const olderObservation = !newerSource && iso(previous?.observedAt) && observation && observation < iso(previous.observedAt);
    const olderSource = previous && iso(previous.updatedAt) &&
      (!iso(update.updatedAt) || iso(update.updatedAt) < iso(previous.updatedAt));
    if (olderObservation || olderSource) {
      // Transition hints are monotonic metadata, independent of snapshot order.
      // Keep a verified hint only while the newer authoritative state is open.
      const hint = trackReopen && iso(update.reopenedAt);
      if (hint && previous?.state === "open" && !previous.unavailable &&
          iso(previous.updatedAt) >= hint && (!iso(previous.reopenedAt) || hint > iso(previous.reopenedAt))) {
        values.set(update.number, { ...previous, reopenedAt: hint });
      }
      continue;
    }
    const reopenedAt = trackReopen ? [
      iso(previous?.reopenedAt), iso(update.reopenedAt),
      previous?.state === "closed" && !previous.unavailable && update.state === "open" && !update.unavailable
        ? iso(update.updatedAt) : null,
    ].filter(Boolean).sort().at(-1) : null;
    values.set(update.number, { ...update, ...(observation ? { observedAt: observation } : {}), ...(reopenedAt ? { reopenedAt } : {}) });
  }
  return [...values.values()].sort((left, right) => left.number - right.number).slice(0, 10);
}

function validGithubNumbers(values) {
  return [...new Set(values ?? [])].filter((number) =>
    Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647);
}

function manualPullRequestNumbers(links = {}) {
  const discovered = new Set(links.discoveredPullRequestNumbers ?? []);
  return validGithubNumbers([
    ...(links.pullRequestNumbers ?? []),
    ...(links.pullRequests ?? []).map((pull) => pull.number),
  ]).filter((number) => !discovered.has(number));
}

function mergePullRequestLinks(current, result, observedAt) {
  const refreshDiscovery = Array.isArray(result.discoveredPullRequestNumbers);
  const discoveryObservedAt = iso(observedAt);
  const staleDiscovery = refreshDiscovery && iso(current.discoveryObservedAt) &&
    discoveryObservedAt && discoveryObservedAt < iso(current.discoveryObservedAt);
  const incomingDiscovery = refreshDiscovery && !staleDiscovery
    ? result.discoveredPullRequestNumbers : current.discoveredPullRequestNumbers ?? [];
  const resultDiscovery = new Set(refreshDiscovery
    ? result.discoveredPullRequestNumbers : incomingDiscovery);
  const manual = validGithubNumbers([
    ...manualPullRequestNumbers(current),
    ...(result.pullRequests ?? []).map((pull) => pull.number)
      .filter((number) => !resultDiscovery.has(number)),
    ...(result.manualPullRequestNumber ? [result.manualPullRequestNumber] : []),
  ]);
  const manualSet = new Set(manual);
  const discovery = validGithubNumbers(incomingDiscovery)
    .filter((number) => !manualSet.has(number)).slice(0, Math.max(0, 10 - manual.length));
  const numbers = new Set([...manual, ...discovery]);
  const pulls = mergeGithubEvidence(
    (current.pullRequests ?? []).filter((pull) => numbers.has(pull.number)),
    (result.pullRequests ?? []).filter((pull) => numbers.has(pull.number)),
    { observedAt },
  );
  return {
    pullRequests: pulls,
    pullRequestNumbers: [...numbers].sort((left, right) => left - right),
    ...(refreshDiscovery || current.discoveredPullRequestNumbers
      ? { discoveredPullRequestNumbers: discovery } : {}),
    ...(refreshDiscovery && !staleDiscovery && discoveryObservedAt
      ? { discoveryObservedAt } : {}),
  };
}

function mergeGithubLinks(current = {}, result, { observedAt = null } = {}) {
  const githubIssues = mergeGithubEvidence(current.githubIssues, result.issues, { trackReopen: true, observedAt });
  return {
    ...current,
    githubIssues,
    githubIssueNumbers: validGithubNumbers([
      ...(current.githubIssueNumbers ?? []), ...githubIssues.map((issue) => issue.number),
    ]).sort((left, right) => left - right).slice(0, 10),
    ...mergePullRequestLinks(current, result, observedAt),
    workflowRunUrls: [...new Set([...(current.workflowRunUrls ?? []), ...(result.workflowRunUrls ?? [])])].slice(0, 10),
    deploymentRunUrls: [...new Set([...(current.deploymentRunUrls ?? []), ...(result.deploymentRunUrls ?? [])])].slice(0, 10),
  };
}

module.exports = { STALE_AFTER_MILLIS, lastProgressAt, progressChangeFields, mergeGithubEvidence, mergeGithubLinks, manualPullRequestNumbers, reportProgress };
