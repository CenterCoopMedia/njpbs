import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";

export const POST_PASS_LIMIT_MS = 20_000;
export const MAX_BASELINE_AGE_MS = 30 * 60 * 1_000;
export const MAX_CLOCK_UNCERTAINTY_MS = 1_000;
export const REQUIRED_AGGREGATES = ["home", "feeds", "sitemap", "search"];
export const OBSERVED_STATUS_CODES = [200, 308, 410, 503];

const SECRET_QUERY_NAMES = new Set([
  "access_token", "api_key", "auth", "authorization", "key", "password", "secret", "sig", "signature", "token",
]);

function assertAllowedKeys(value, allowed, fieldName) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${fieldName} has unsupported field ${key}`);
  }
}

export function parseTimestamp(value, fieldName = "timestamp") {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${fieldName} must be an ISO timestamp with a timezone`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${fieldName} is invalid`);
  return milliseconds;
}

export function easternTimestamp(milliseconds) {
  const date = new Date(milliseconds);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date).map(part => [part.type, part.value]));
  const fraction = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${fraction} ${parts.timeZoneName}`;
}

export function timestampFields(milliseconds) {
  return {
    utc: new Date(milliseconds).toISOString(),
    eastern: easternTimestamp(milliseconds),
  };
}

export function estimateRemoteClockOffset(remoteNowMs, officeStartedAtMs, officeFinishedAtMs) {
  if (![remoteNowMs, officeStartedAtMs, officeFinishedAtMs].every(Number.isFinite)
    || officeFinishedAtMs < officeStartedAtMs) {
    throw new Error("Remote clock sample is invalid");
  }
  const officeMidpointMs = (officeStartedAtMs + officeFinishedAtMs) / 2;
  return {
    remoteMinusOfficeMs: Math.round(remoteNowMs - officeMidpointMs),
    uncertaintyMs: Math.ceil((officeFinishedAtMs - officeStartedAtMs) / 2),
    measuredAt: timestampFields(officeMidpointMs),
  };
}

export function normalizeDigest(value) {
  return typeof value === "string" ? value.replace(/^sha256:/i, "").toLowerCase() : "";
}

export function validatePublicUrl(value, fieldName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid public HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error(`${fieldName} must use a public HTTPS hostname without credentials`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || /\.(?:localhost|local|internal|test)$/.test(host)) {
    throw new Error(`${fieldName} must use a public internet hostname`);
  }
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_NAMES.has(name.toLowerCase())) throw new Error(`${fieldName} cannot contain a credential query parameter`);
  }
  if (url.searchParams.has("__nobuild_probe")) throw new Error(`${fieldName} cannot use the probe query parameter`);
  return url;
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Config must be a JSON object");
  assertAllowedKeys(config, ["post", "aggregates"], "config");
  const post = config.post;
  if (!post || typeof post !== "object") throw new Error("Config must include post details");
  assertAllowedKeys(post, ["canonicalUrl", "aliases", "publishedVersion", "operationId", "htmlSha256"], "post");
  const canonical = validatePublicUrl(post.canonicalUrl, "post.canonicalUrl");
  if (canonical.search || canonical.hash) throw new Error("post.canonicalUrl cannot include a query or fragment");
  if (!Array.isArray(post.aliases)) throw new Error("post.aliases must be an array");
  if (post.aliases.length > 100) throw new Error("post.aliases cannot exceed 100 URLs");
  for (const [index, aliasValue] of post.aliases.entries()) {
    const alias = validatePublicUrl(aliasValue, `post.aliases[${index}]`);
    if (alias.search || alias.hash) throw new Error(`post.aliases[${index}] cannot include a query or fragment`);
  }
  if (!post.publishedVersion || !post.operationId) throw new Error("post must include publishedVersion and operationId");
  if (!/^[0-9a-f]{64}$/i.test(normalizeDigest(post.htmlSha256))) throw new Error("post.htmlSha256 must be a SHA-256 hex digest");

  validateAggregateTargets(config.aggregates);
  return config;
}

export function validateAggregateTargets(aggregates) {
  if (!Array.isArray(aggregates)) throw new Error("Config must include aggregates");
  const aggregateNames = new Set();
  for (const [index, aggregate] of aggregates.entries()) {
    const name = aggregate?.name;
    if (!aggregate || typeof aggregate !== "object") throw new Error(`aggregates[${index}] must be an object`);
    assertAllowedKeys(aggregate, ["name", "url", "needle", "presence", "expectation"], `aggregates[${index}]`);
    if (!REQUIRED_AGGREGATES.includes(name)) throw new Error(`aggregates[${index}].name must be one of ${REQUIRED_AGGREGATES.join(", ")}`);
    if (aggregateNames.has(name)) throw new Error(`Aggregate ${name} is duplicated`);
    aggregateNames.add(name);
    validatePublicUrl(aggregate.url, `aggregates[${index}].url`);
    if (typeof aggregate.needle !== "string" || !aggregate.needle || aggregate.needle.length > 512) {
      throw new Error(`aggregates[${index}].needle must contain 1 to 512 characters`);
    }
    if (!["contains", "omits"].includes(aggregate.presence)) throw new Error(`aggregates[${index}].presence must be contains or omits`);
    if (aggregate.expectation !== undefined
      && (aggregate.expectation !== "unchanged" || name !== "home" || aggregate.presence !== "omits")) {
      throw new Error("Only Home with presence omits can use expectation unchanged");
    }
  }
  const missing = REQUIRED_AGGREGATES.filter(name => !aggregateNames.has(name));
  if (missing.length) throw new Error(`Config is missing aggregate targets: ${missing.join(", ")}`);
  return aggregates;
}

export function aggregateConfigFingerprint(aggregates) {
  validateAggregateTargets(aggregates);
  const stableTargets = REQUIRED_AGGREGATES.map(name => {
    const target = aggregates.find(item => item.name === name);
    return {
      name, url: target.url, needle: target.needle, presence: target.presence,
      ...(target.expectation === "unchanged" ? { expectation: "unchanged" } : {}),
    };
  });
  return createHash("sha256").update(JSON.stringify(stableTargets)).digest("hex");
}

export function baselinePresenceFor(aggregate) {
  if (aggregate.expectation === "unchanged") return "omits";
  return aggregate.presence === "contains" ? "omits" : "contains";
}

export function validateBaselineReceipt(receipt, aggregates, startAt, requiredVantages, clockCalibratedVantages = []) {
  if (receipt?.schemaVersion !== 1 || receipt.receiptType !== "njpbs-no-build-aggregate-baseline") {
    throw new Error("A supported aggregate baseline receipt is required");
  }
  if (receipt.pass !== true || !Array.isArray(receipt.vantages)) throw new Error("Aggregate baseline did not pass");
  if (receipt.aggregateConfigSha256 !== aggregateConfigFingerprint(aggregates)) {
    throw new Error("Aggregate baseline config does not match the probe config");
  }
  const operationStart = parseTimestamp(startAt, "startAt");
  const baselineComplete = parseTimestamp(receipt.finishedAtUtc, "baseline.finishedAtUtc");
  if (baselineComplete >= operationStart) throw new Error("Aggregate baseline must finish before startAt");
  if (operationStart - baselineComplete > MAX_BASELINE_AGE_MS) {
    throw new Error(`Aggregate baseline must be no more than ${MAX_BASELINE_AGE_MS / 60_000} minutes before startAt`);
  }
  const byName = new Map(receipt.vantages.map(vantage => [vantage.name, vantage]));
  for (const vantageName of requiredVantages) {
    const vantage = byName.get(vantageName);
    if (!vantage?.pass) throw new Error(`Aggregate baseline did not pass from ${vantageName}`);
    if (clockCalibratedVantages.includes(vantageName)
      && (!Number.isFinite(vantage.clockCalibration?.remoteMinusOfficeMs)
        || !Number.isFinite(vantage.clockCalibration?.uncertaintyMs)
        || vantage.clockCalibration.uncertaintyMs < 0
        || vantage.clockCalibration.uncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS)) {
      throw new Error(`Aggregate baseline has no valid clock calibration for ${vantageName}`);
    }
    for (const aggregate of aggregates) {
      const before = vantage.targets?.[aggregate.name];
      const expectedBefore = baselinePresenceFor(aggregate);
      if (!before?.pass
        || before.name !== aggregate.name
        || before.url !== aggregate.url
        || before.needle !== aggregate.needle
        || (before.expectation ?? "transition") !== (aggregate.expectation ?? "transition")
        || before.baselinePresence !== expectedBefore) {
        throw new Error(`Aggregate baseline did not confirm ${aggregate.name} ${expectedBefore} from ${vantageName}`);
      }
      const lastBaselineObservation = parseTimestamp(
        before.baselineLastObservedAtUtc,
        `baseline.${vantageName}.${aggregate.name}.baselineLastObservedAtUtc`,
      );
      const lastBaselineRequestStart = parseTimestamp(
        before.baselineLastObservedRequestStartedAtUtc,
        `baseline.${vantageName}.${aggregate.name}.baselineLastObservedRequestStartedAtUtc`,
      );
      const baselineClockUncertaintyMs = vantage.clockCalibration?.uncertaintyMs ?? 0;
      if (lastBaselineRequestStart > lastBaselineObservation
        || lastBaselineObservation - baselineComplete > baselineClockUncertaintyMs) {
        throw new Error(`Aggregate baseline observation times are invalid for ${aggregate.name} from ${vantageName}`);
      }
    }
  }
  return true;
}

function jsonReceiptMatches(sample, expected) {
  const receipt = sample.receipt;
  if (!receipt || typeof receipt !== "object") return false;
  return String(receipt.sourceVersion ?? "") === String(expected.publishedVersion)
    && receipt.operationId === expected.operationId
    && normalizeDigest(receipt.htmlDigest) === normalizeDigest(expected.htmlSha256);
}

export function matchesPostResponse(sample, expected) {
  if (sample.requestLabel !== "plain" || sample.status !== 200) return false;
  const headers = sample.headers ?? {};
  const version = headers.sourceVersion ?? sample.receipt?.sourceVersion;
  const operationId = headers.publicationOperation ?? sample.receipt?.operationId;
  const digest = normalizeDigest(headers.htmlSha256 ?? sample.receipt?.htmlDigest ?? sample.bodySha256);
  const identityMatches = String(version ?? "") === String(expected.publishedVersion)
    && operationId === expected.operationId
    && digest === normalizeDigest(expected.htmlSha256);
  if (!identityMatches) return false;

  const hasJsonReceipt = jsonReceiptMatches(sample, expected);
  return hasJsonReceipt || normalizeDigest(sample.bodySha256) === normalizeDigest(expected.htmlSha256);
}

function responseSequence(samples, matches, requiredConfirmations, afterIndex = -1) {
  let firstExpectedAtUtc = null;
  let firstExpectedRequestStartedAtUtc = null;
  let firstExpectedHeadersAtUtc = null;
  let firstExpectedElapsedMs = null;
  let firstExpectedIndex = null;
  let lastNonmatchingAtUtc = null;
  let lastNonmatchingRequestStartedAtUtc = null;
  let lastNonmatchingCompletedAtUtc = null;
  let lastNonmatchingElapsedMs = null;
  let confirmations = 0;
  let regressions = 0;
  let probeErrors = 0;
  for (const sample of samples) {
    if (sample.requestLabel !== "plain" || sample.index <= afterIndex) continue;
    if (sample.status === null || (sample.error && sample.status === 200)) {
      probeErrors += 1;
      continue;
    }
    if (!firstExpectedAtUtc) {
      if (matches(sample)) {
        firstExpectedAtUtc = sample.expectedEvidenceAtUtc ?? sample.atUtc;
        firstExpectedRequestStartedAtUtc = sample.requestStartedAtUtc ?? sample.atUtc;
        firstExpectedHeadersAtUtc = sample.responseHeadersAtUtc ?? sample.atUtc;
        firstExpectedElapsedMs = sample.expectedEvidenceElapsedMsFromStart ?? sample.elapsedMsFromStart;
        firstExpectedIndex = sample.index;
      } else {
        lastNonmatchingAtUtc = sample.responseHeadersAtUtc ?? sample.atUtc;
        lastNonmatchingRequestStartedAtUtc = sample.requestStartedAtUtc ?? sample.atUtc;
        lastNonmatchingCompletedAtUtc = sample.atUtc;
        lastNonmatchingElapsedMs = sample.elapsedMsFromStart;
      }
      continue;
    }
    if (confirmations >= requiredConfirmations) break;
    if (matches(sample)) confirmations += 1;
    else {
      regressions += 1;
      break;
    }
  }
  return {
    firstExpectedAtUtc,
    firstExpectedRequestStartedAtUtc,
    firstExpectedHeadersAtUtc,
    firstExpectedElapsedMs,
    firstExpectedIndex,
    lastNonmatchingAtUtc,
    lastNonmatchingRequestStartedAtUtc,
    lastNonmatchingCompletedAtUtc,
    lastNonmatchingElapsedMs,
    confirmations,
    regressions,
    probeErrors,
    requiredConfirmations,
    complete: confirmations >= requiredConfirmations && regressions === 0,
    pass: Boolean(firstExpectedAtUtc) && confirmations >= requiredConfirmations && regressions === 0,
  };
}

export function matchesAliasResponse(sample, canonicalUrl, aliasUrl) {
  if (sample.requestLabel !== "plain" || sample.status !== 308) return false;
  const location = sample.location ?? sample.headers?.location;
  if (!location) return false;
  try {
    const destination = new URL(location, aliasUrl);
    const canonical = new URL(canonicalUrl);
    destination.hash = "";
    canonical.hash = "";
    return destination.href === canonical.href;
  } catch {
    return false;
  }
}

export function evaluatePostProgress(post, expected, requiredConfirmations, clockUncertaintyMs = 0) {
  if (!Number.isFinite(clockUncertaintyMs) || clockUncertaintyMs < 0) {
    throw new Error("clockUncertaintyMs must be a nonnegative number");
  }
  const canonical = responseSequence(post.canonical.samples.map(sample => {
    const headers = sample.headers ?? {};
    const headersCarryExpectedIdentity = String(headers.sourceVersion ?? "") === String(expected.publishedVersion)
      && headers.publicationOperation === expected.operationId
      && normalizeDigest(headers.htmlSha256) === normalizeDigest(expected.htmlSha256);
    return {
      ...sample,
      expectedEvidenceAtUtc: headersCarryExpectedIdentity
        ? sample.responseHeadersAtUtc ?? sample.atUtc
        : sample.atUtc,
      expectedEvidenceElapsedMsFromStart: headersCarryExpectedIdentity
        ? sample.responseHeadersElapsedMsFromStart ?? sample.elapsedMsFromStart
        : sample.elapsedMsFromStart,
    };
  }), sample => matchesPostResponse(sample, expected), requiredConfirmations);
  const aliases = post.aliases.map(alias => ({
    url: alias.url,
    ...responseSequence(
      alias.samples,
      sample => matchesAliasResponse(sample, post.canonical.url, alias.url),
      requiredConfirmations,
      canonical.firstExpectedIndex ?? Number.MAX_SAFE_INTEGER,
    ),
  }));
  const aliasPass = aliases.every(alias => alias.pass);
  const conservativeFirstExpectedElapsedMs = canonical.firstExpectedElapsedMs === null
    ? null
    : canonical.firstExpectedElapsedMs + clockUncertaintyMs;
  const timingPass = conservativeFirstExpectedElapsedMs !== null
    && conservativeFirstExpectedElapsedMs <= POST_PASS_LIMIT_MS;
  return {
    canonical: { url: post.canonical.url, ...canonical },
    aliases,
    clockUncertaintyMs,
    conservativeFirstExpectedElapsedMs,
    timingPass,
    stablePass: canonical.pass && aliasPass,
    pass: canonical.pass && aliasPass && timingPass,
  };
}

export function matchesAggregateResponse(sample, aggregate) {
  if (sample.requestLabel !== "plain" || sample.status !== 200) return false;
  const containsNeedle = typeof sample.containsNeedle === "boolean"
    ? sample.containsNeedle
    : typeof sample.body === "string" && sample.body.includes(aggregate.needle);
  return aggregate.presence === "contains" ? containsNeedle : !containsNeedle;
}

export function evaluateAggregateProgress(aggregateState, requiredConfirmations) {
  const progress = responseSequence(
    aggregateState.samples,
    sample => matchesAggregateResponse(sample, aggregateState),
    requiredConfirmations,
  );
  const unchanged = aggregateState.expectation === "unchanged";
  // Any observed appearance violates continued absence, even before the first match.
  const unexpectedAppearance = unchanged && aggregateState.samples.some(sample =>
    sample.requestLabel === "plain" && sample.status === 200
    && matchesAggregateResponse(sample, { ...aggregateState, presence: "contains" }));
  return {
    name: aggregateState.name,
    url: aggregateState.url,
    needle: aggregateState.needle,
    presence: aggregateState.presence,
    expectation: aggregateState.expectation ?? "transition",
    firstExpectedAtUtc: progress.firstExpectedAtUtc,
    firstExpectedRequestStartedAtUtc: progress.firstExpectedRequestStartedAtUtc,
    firstExpectedHeadersAtUtc: progress.firstExpectedHeadersAtUtc,
    catchUpElapsedMs: unchanged ? null : progress.firstExpectedElapsedMs,
    lastNonmatchingAtUtc: progress.lastNonmatchingAtUtc,
    lastNonmatchingRequestStartedAtUtc: progress.lastNonmatchingRequestStartedAtUtc,
    lastNonmatchingCompletedAtUtc: progress.lastNonmatchingCompletedAtUtc,
    lastNonmatchingElapsedMs: progress.lastNonmatchingElapsedMs,
    confirmations: progress.confirmations,
    regressions: unexpectedAppearance ? Math.max(1, progress.regressions) : progress.regressions,
    probeErrors: progress.probeErrors,
    requiredConfirmations: progress.requiredConfirmations,
    complete: progress.complete && !unexpectedAppearance,
    pass: progress.pass && !unexpectedAppearance,
    samples: aggregateState.samples,
  };
}

export function homeAbsenceAfterConvergence(targets) {
  const affected = REQUIRED_AGGREGATES.filter(name => name !== "home").map(name => targets[name]);
  if (affected.some(target => !target?.pass)) return null;
  const convergedAt = Math.max(...affected.flatMap(target => target.samples
    .filter(sample => sample.requestLabel === "plain")
    .map(sample => Date.parse(sample.atUtc))));
  return targets.home?.samples.find(sample =>
    matchesAggregateResponse(sample, targets.home) && !sample.error
    && Date.parse(sample.requestStartedAtUtc ?? sample.atUtc) > convergedAt) ?? null;
}

export function evaluateAggregateBuildWindow(receipt, build) {
  if (receipt?.receiptType !== "njpbs-no-build-trial-measurement") {
    throw new Error("Receipt is not a no-build trial measurement");
  }
  const startAt = parseTimestamp(receipt.startAtUtc, "receipt.startAtUtc");
  const buildStart = parseTimestamp(build.startedAt, "normalBuild.startedAt");
  const buildComplete = parseTimestamp(build.completedAt, "normalBuild.completedAt");
  if (typeof build.id !== "string" || !build.id.trim()) throw new Error("normalBuild.id is required");
  if (!/^[0-9a-f]{40}$/i.test(build.sourceSha ?? "")) throw new Error("normalBuild.sourceSha must be a 40-character commit SHA");
  const startsAfterOperation = buildStart >= startAt;
  const orderedWindow = buildComplete >= buildStart;
  const targets = [];
  for (const vantage of receipt.vantages) {
    const matchClockUncertaintyMs = vantage.polling?.clockUncertaintyMs ?? 0;
    if (!Number.isFinite(matchClockUncertaintyMs) || matchClockUncertaintyMs < 0) {
      throw new Error(`Invalid match clock uncertainty for ${vantage.name}`);
    }
    for (const name of REQUIRED_AGGREGATES) {
      const aggregate = vantage.aggregates?.targets?.[name];
      const unchanged = aggregate?.expectation === "unchanged";
      const catchUp = aggregate?.firstExpectedAtUtc ? Date.parse(aggregate.firstExpectedAtUtc) : NaN;
      const catchUpRequestStart = Date.parse(aggregate?.firstExpectedRequestStartedAtUtc ?? aggregate?.firstExpectedAtUtc ?? "");
      const catchUpHeaders = Date.parse(aggregate?.firstExpectedHeadersAtUtc ?? aggregate?.firstExpectedAtUtc ?? "");
      const lastNonmatchingSource = aggregate?.lastNonmatchingAtUtc ? "post-operation" : "pre-operation-baseline";
      const lastNonmatchingRaw = aggregate?.lastNonmatchingAtUtc ?? aggregate?.baselineLastObservedAtUtc;
      const lastNonmatching = lastNonmatchingRaw ? Date.parse(lastNonmatchingRaw) : NaN;
      const lastNonmatchingRequestRaw = aggregate?.lastNonmatchingRequestStartedAtUtc
        ?? aggregate?.baselineLastObservedRequestStartedAtUtc
        ?? lastNonmatchingRaw;
      const lastNonmatchingRequestStart = lastNonmatchingRequestRaw ? Date.parse(lastNonmatchingRequestRaw) : NaN;
      const staleClockUncertaintyMs = aggregate?.lastNonmatchingAtUtc
        ? matchClockUncertaintyMs
        : (aggregate?.baselineClockUncertaintyMs ?? 0);
      if (!Number.isFinite(staleClockUncertaintyMs) || staleClockUncertaintyMs < 0) {
        throw new Error(`Invalid stale clock uncertainty for ${vantage.name} ${name}`);
      }
      const totalClockUncertaintyMs = matchClockUncertaintyMs + staleClockUncertaintyMs;
      const measurementUncertaintyMs = Number.isFinite(catchUp) && Number.isFinite(lastNonmatchingRequestStart)
        ? catchUp - lastNonmatchingRequestStart
        : null;
      const catchUpRequestStartedAfterOperation = Number.isFinite(catchUpRequestStart)
        && catchUpRequestStart - matchClockUncertaintyMs >= startAt;
      const observedBeforeBuild = Number.isFinite(catchUp)
        && catchUp + matchClockUncertaintyMs < buildStart;
      const observedDuringBuild = Number.isFinite(catchUpRequestStart)
        && Number.isFinite(catchUp)
        && catchUpRequestStart - matchClockUncertaintyMs >= buildStart
        && catchUp + matchClockUncertaintyMs <= buildComplete;
      const observedByBuildCompletion = Number.isFinite(catchUp)
        && catchUp + matchClockUncertaintyMs <= buildComplete;
      const baseConverged = Boolean(aggregate)
        && aggregate.name === name
        && aggregate.complete
        && aggregate.regressions === 0;
      const catchUpEvidence = !catchUpRequestStartedAfterOperation
        ? "before-operation-or-uncertain"
        : observedBeforeBuild
          ? "observed-before-build"
          : observedDuringBuild
            ? "observed-during-build"
            : observedByBuildCompletion ? "observed-by-build-completion" : "outside-build-deadline";
      const observedInWindow = baseConverged && catchUpRequestStartedAfterOperation && observedByBuildCompletion;
      if (unchanged) {
        const baselineAt = Date.parse(aggregate.baselineLastObservedAtUtc ?? "");
        const absence = homeAbsenceAfterConvergence(vantage.aggregates.targets);
        const absenceAt = Date.parse(absence?.atUtc ?? "");
        const unchangedPass = name === "home" && aggregate.presence === "omits"
          && aggregate.baselinePresence === "omits"
          && baselineAt + staleClockUncertaintyMs < startAt && observedInWindow
          && absenceAt + matchClockUncertaintyMs <= buildComplete;
        targets.push({
          vantage: vantage.name,
          name,
          expectation: "unchanged",
          baselineLastObservedAt: Number.isFinite(baselineAt) ? timestampFields(baselineAt) : null,
          firstExpectedAt: Number.isFinite(catchUp) ? timestampFields(catchUp) : null,
          firstExpectedRequestStartedAt: Number.isFinite(catchUpRequestStart) ? timestampFields(catchUpRequestStart) : null,
          firstExpectedHeadersAt: Number.isFinite(catchUpHeaders) ? timestampFields(catchUpHeaders) : null,
          confirmedUnchangedAt: Number.isFinite(absenceAt) ? timestampFields(absenceAt) : null,
          clockUncertaintyMs: totalClockUncertaintyMs,
          catchUpEvidence: "unchanged-home",
          caughtUpByBuildCompletion: null,
          unchangedByBuildCompletion: unchangedPass,
          pass: unchangedPass,
        });
        continue;
      }
      targets.push({
        vantage: vantage.name,
        name,
        lastNonmatchingSource,
        lastNonmatchingAt: Number.isFinite(lastNonmatching) ? timestampFields(lastNonmatching) : null,
        lastNonmatchingRequestStartedAt: Number.isFinite(lastNonmatchingRequestStart)
          ? timestampFields(lastNonmatchingRequestStart)
          : null,
        firstExpectedAt: Number.isFinite(catchUp) ? timestampFields(catchUp) : null,
        firstExpectedRequestStartedAt: Number.isFinite(catchUpRequestStart) ? timestampFields(catchUpRequestStart) : null,
        firstExpectedHeadersAt: Number.isFinite(catchUpHeaders) ? timestampFields(catchUpHeaders) : null,
        measurementUncertaintyMs,
        clockUncertaintyMs: totalClockUncertaintyMs,
        effectiveMeasurementUncertaintyMs: measurementUncertaintyMs === null
          ? null
          : measurementUncertaintyMs + totalClockUncertaintyMs,
        catchUpEvidence,
        caughtUpByBuildCompletion: observedInWindow,
        pass: observedInWindow,
      });
    }
  }
  return {
    buildId: build.id,
    sourceSha: build.sourceSha,
    startedAt: timestampFields(buildStart),
    completedAt: timestampFields(buildComplete),
    startsAfterOperation,
    orderedWindow,
    targets,
    pass: startsAfterOperation && orderedWindow && targets.length > 0 && targets.every(target => target.pass),
  };
}

export function sealReceipt(receipt, build) {
  if (receipt?.schemaVersion !== 1
    || receipt.receiptType !== "njpbs-no-build-trial-measurement"
    || !Array.isArray(receipt.vantages)) throw new Error("Receipt is not a supported trial receipt");
  if (receipt.sealedAtUtc || receipt.normalBuild) throw new Error("Receipt is already sealed");
  const window = evaluateAggregateBuildWindow(receipt, build);
  const now = Date.now();
  return {
    ...receipt,
    normalBuild: window,
    sealedAtUtc: new Date(now).toISOString(),
    sealedAtEastern: easternTimestamp(now),
    decisions: {
      ...receipt.decisions,
      aggregateWithinOneNormalBuildPass: window.pass,
      overallPass: receipt.decisions.detailPass && receipt.decisions.aggregateConvergencePass && window.pass,
    },
  };
}

export async function writeJsonReceipt(receiptPath, receipt) {
  const destination = resolve(receiptPath);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}
