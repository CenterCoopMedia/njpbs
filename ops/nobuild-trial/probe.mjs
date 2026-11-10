import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  OBSERVED_STATUS_CODES,
  MAX_CLOCK_UNCERTAINTY_MS,
  POST_PASS_LIMIT_MS,
  REQUIRED_AGGREGATES,
  aggregateConfigFingerprint,
  baselinePresenceFor,
  estimateRemoteClockOffset,
  evaluateAggregateProgress,
  evaluatePostProgress,
  homeAbsenceAfterConvergence,
  matchesAggregateResponse,
  parseTimestamp,
  sealReceipt,
  timestampFields,
  validateConfig,
  validateAggregateTargets,
  validateBaselineReceipt,
  writeJsonReceipt,
} from "./probe-core.mjs";

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULTS = {
  confirmations: 3,
  intervalMs: 1_000,
  aggregateIntervalMs: 15_000,
  maxDurationMs: 600_000,
  requestTimeoutMs: 8_000,
  lateDetailIntervalMs: 5_000,
};

function requestUrl(route, requestLabel, runId, vantage) {
  const url = new URL(route.url);
  if (requestLabel === "unique-query-diagnostic") {
    url.searchParams.set("__nobuild_probe", `${runId}-${vantage}-${randomUUID()}`);
  }
  return url.href;
}

async function readResponseBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${MAX_RESPONSE_BYTES}-byte probe limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function receiptFromJson(body, contentType) {
  if (!contentType?.includes("json")) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    const candidates = [parsed, parsed?.publicReceipt, parsed?.receipt];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const sourceVersion = candidate.sourceVersion ?? candidate.publishedVersion ?? candidate.version;
      const operationId = candidate.operationId ?? candidate.publicationOperation;
      const htmlDigest = candidate.htmlDigest ?? candidate.htmlSha256 ?? candidate.digest;
      if (sourceVersion !== undefined && operationId && htmlDigest) {
        return { sourceVersion, operationId, htmlDigest };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function responseHeaders(response) {
  const get = name => response.headers.get(name);
  return {
    cacheControl: get("cache-control"),
    cfCacheStatus: get("cf-cache-status"),
    xCache: get("x-cache"),
    cacheStatus: get("cache-status"),
    renderCache: get("x-njpbs-render-cache"),
    age: get("age"),
    cdnCacheControl: get("cdn-cache-control"),
    surrogateControl: get("surrogate-control"),
    contentType: get("content-type"),
    location: get("location"),
    contentSource: get("x-njpbs-content-source"),
    sourceVersion: get("x-njpbs-source-version"),
    publicationOperation: get("x-njpbs-publication-operation"),
    htmlSha256: get("x-njpbs-html-sha256"),
    rendererSha: get("x-njpbs-renderer-sha"),
    contextSha256: get("x-njpbs-context-sha256"),
  };
}

async function captureSample(route, requestLabel, context) {
  const startedAt = Date.now();
  const index = context.nextIndex++;
  const url = requestUrl(route, requestLabel, context.runId, context.vantage);
  let status = null;
  let headers = {};
  let responseHeadersAtLocal = null;
  let body = Buffer.alloc(0);
  let error = null;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { accept: "text/html,application/json,application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(context.requestTimeoutMs),
    });
    responseHeadersAtLocal = Date.now();
    status = response.status;
    headers = responseHeaders(response);
    body = await readResponseBody(response);
  } catch (caught) {
    error = `${caught?.name ?? "Error"}: ${caught?.message ?? String(caught)}`;
  }
  const observedAtLocal = Date.now();
  const observedAt = observedAtLocal - (context.clockOffsetMs ?? 0);
  const requestStartedAt = startedAt - (context.clockOffsetMs ?? 0);
  const responseHeadersAt = responseHeadersAtLocal === null
    ? null
    : responseHeadersAtLocal - (context.clockOffsetMs ?? 0);
  const observedTimestamp = timestampFields(observedAt);
  const requestStartedTimestamp = timestampFields(requestStartedAt);
  const responseHeadersTimestamp = responseHeadersAt === null ? null : timestampFields(responseHeadersAt);
  const bodyText = body.toString("utf8");
  const sample = {
    index,
    requestLabel,
    requestedUrl: url,
    requestStartedAtUtc: requestStartedTimestamp.utc,
    requestStartedAtEastern: requestStartedTimestamp.eastern,
    responseHeadersAtUtc: responseHeadersTimestamp?.utc ?? null,
    responseHeadersAtEastern: responseHeadersTimestamp?.eastern ?? null,
    responseHeadersElapsedMsFromStart: responseHeadersAt === null
      ? null
      : responseHeadersAt - context.startAtMs,
    atUtc: observedTimestamp.utc,
    atEastern: observedTimestamp.eastern,
    elapsedMsFromStart: observedAt - context.startAtMs,
    durationMs: observedAtLocal - startedAt,
    status,
    statusCategory: status === null ? "network-error" : OBSERVED_STATUS_CODES.includes(status) ? "tracked" : "other",
    headers,
    bodySha256: body.length ? createHash("sha256").update(body).digest("hex") : null,
    receipt: receiptFromJson(body, headers.contentType),
    error,
  };
  if (route.kind === "aggregate") sample.containsNeedle = bodyText.includes(route.needle);
  return sample;
}

async function runLimited(items, limit, work) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index]);
    }
  });
  await Promise.all(workers);
}

function summarizePost(post, config, confirmations, clockUncertaintyMs = 0) {
  const result = evaluatePostProgress(post, {
    publishedVersion: config.post.publishedVersion,
    operationId: config.post.operationId,
    htmlSha256: config.post.htmlSha256,
  }, confirmations, clockUncertaintyMs);
  const failed = result.canonical.regressions > 0 || result.aliases.some(alias => alias.regressions > 0);
  return { ...result, failed };
}

function summarizeAggregates(aggregates, confirmations) {
  const targets = Object.fromEntries(aggregates.map(aggregate => [
    aggregate.name,
    evaluateAggregateProgress(aggregate, confirmations),
  ]));
  if (targets.home?.expectation === "unchanged" && !homeAbsenceAfterConvergence(targets)) {
    targets.home.pass = false;
    targets.home.complete = false;
  }
  const failed = Object.values(targets).some(target => target.regressions > 0);
  return { targets, failed, pass: !failed && Object.values(targets).every(target => target.pass) };
}

function allAggregateTargets(aggregates) {
  return aggregates.map(aggregate => ({
    kind: "aggregate", name: aggregate.name, url: aggregate.url, needle: aggregate.needle,
  }));
}

export function nextPollWakeTime(postDone, nextPostPoll, aggregatesDone, nextAggregatePoll, deadline) {
  const activeTimes = [deadline];
  if (!postDone) activeTimes.push(nextPostPoll);
  if (!aggregatesDone) activeTimes.push(nextAggregatePoll);
  return Math.min(...activeTimes);
}

export async function runVantage(config, startAt, options = {}) {
  validateConfig(config);
  const settings = { ...DEFAULTS, ...options };
  const now = () => Date.now() - (settings.clockOffsetMs ?? 0);
  const startAtMs = parseTimestamp(startAt, "startAt");
  if (startAtMs > now()) throw new Error("startAt cannot be in the future");
  const runId = settings.runId ?? randomUUID();
  const vantage = settings.vantage ?? hostname();
  const probeStartedAt = now();
  const deadline = probeStartedAt + settings.maxDurationMs;
  const context = {
    runId, vantage, startAtMs, nextIndex: 0,
    requestTimeoutMs: settings.requestTimeoutMs,
    clockOffsetMs: settings.clockOffsetMs ?? 0,
  };
  const post = {
    canonical: { url: config.post.canonicalUrl, samples: [] },
    aliases: config.post.aliases.map(url => ({ url, samples: [] })),
  };
  const aggregates = config.aggregates.map(aggregate => ({ ...aggregate, kind: "aggregate", samples: [] }));
  const routes = [
    { kind: "post", name: "canonical", url: post.canonical.url, samples: post.canonical.samples },
    ...post.aliases.map((alias, index) => ({ kind: "post", name: `alias-${index + 1}`, url: alias.url, samples: alias.samples })),
    ...allAggregateTargets(aggregates).map(route => ({ ...route, samples: aggregates.find(item => item.name === route.name).samples })),
  ];
  const plainInFlight = new WeakMap();
  const record = async (route, requestLabel) => {
    const send = async () => {
      const sample = await captureSample(route, requestLabel, context);
      route.samples.push(sample);
      return sample;
    };
    if (requestLabel !== "plain") return send();
    const previous = plainInFlight.get(route.samples);
    if (previous) return previous;
    const current = send();
    plainInFlight.set(route.samples, current);
    try {
      return await current;
    } finally {
      if (plainInFlight.get(route.samples) === current) plainInFlight.delete(route.samples);
    }
  };

  await record(routes[0], "plain");
  const auxiliaryRoutes = routes.slice(1);
  const initialAuxiliary = Promise.all(auxiliaryRoutes.map(route => record(route, "plain")));
  const diagnostics = runLimited(routes, 2, route => record(route, "unique-query-diagnostic"));
  const activeDetailPolls = new Set();
  const activeAggregatePolls = new Set();
  const detailInterval = () => now() - startAtMs < POST_PASS_LIMIT_MS
    ? settings.intervalMs
    : Math.max(settings.intervalMs, settings.lateDetailIntervalMs);
  let nextPostPoll = now() + detailInterval();
  let nextAggregatePoll = now() + settings.aggregateIntervalMs;
  while (now() < deadline) {
    const postResult = summarizePost(post, config, settings.confirmations, settings.clockUncertaintyMs ?? 0);
    const aggregateResult = summarizeAggregates(aggregates, settings.confirmations);
    const postDone = postResult.stablePass || postResult.failed;
    const aggregatesDone = aggregateResult.pass || aggregateResult.failed;
    if (postDone && aggregatesDone) break;

    const currentTime = now();
    if (!postDone && currentTime >= nextPostPoll) {
      const detailRoutes = [routes[0]];
      if (postResult.canonical.firstExpectedAtUtc) {
        detailRoutes.push(...routes.filter(route => route.name.startsWith("alias-")));
      }
      const poll = Promise.all(detailRoutes.map(route => record(route, "plain"))).catch(() => undefined);
      activeDetailPolls.add(poll);
      poll.finally(() => activeDetailPolls.delete(poll));
      nextPostPoll = now() + detailInterval();
    }
    if (!aggregatesDone && now() >= nextAggregatePoll) {
      const pending = aggregates.filter(aggregate => {
        const target = aggregateResult.targets[aggregate.name];
        return !target.pass && target.regressions === 0;
      });
      const poll = Promise.all(pending.map(aggregate => record(aggregate, "plain"))).catch(() => undefined);
      activeAggregatePolls.add(poll);
      poll.finally(() => activeAggregatePolls.delete(poll));
      nextAggregatePoll = now() + settings.aggregateIntervalMs;
    }
    const waitUntil = nextPollWakeTime(postDone, nextPostPoll, aggregatesDone, nextAggregatePoll, deadline);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, waitUntil - now())));
  }
  await Promise.all([initialAuxiliary, diagnostics, ...activeDetailPolls, ...activeAggregatePolls]);

  const finishedAt = now();
  const postSummary = summarizePost(post, config, settings.confirmations, settings.clockUncertaintyMs ?? 0);
  const aggregateSummary = summarizeAggregates(aggregates, settings.confirmations);
  return {
    name: vantage,
    startedAtUtc: new Date(probeStartedAt).toISOString(),
    startedAtEastern: timestampFields(probeStartedAt).eastern,
    finishedAtUtc: new Date(finishedAt).toISOString(),
    finishedAtEastern: timestampFields(finishedAt).eastern,
    timedOut: finishedAt >= deadline && !(postSummary.pass && aggregateSummary.pass),
    post: {
      ...postSummary,
      publishedVersion: config.post.publishedVersion,
      operationId: config.post.operationId,
      expectedHtmlSha256: config.post.htmlSha256,
      canonical: { ...post.canonical, ...postSummary.canonical },
      aliases: post.aliases.map((alias, index) => ({
        ...alias,
        ...postSummary.aliases[index],
      })),
    },
    aggregates: { ...aggregateSummary },
    polling: {
      confirmations: settings.confirmations,
      detailIntervalMs: settings.intervalMs,
      lateDetailIntervalMs: settings.lateDetailIntervalMs,
      aggregateIntervalMs: settings.aggregateIntervalMs,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxDurationMs: settings.maxDurationMs,
      clockUncertaintyMs: settings.clockUncertaintyMs ?? 0,
    },
  };
}

export async function runBaselineVantage(aggregates, options = {}) {
  validateAggregateTargets(aggregates);
  const settings = { ...DEFAULTS, ...options };
  const now = () => Date.now() - (settings.clockOffsetMs ?? 0);
  const vantage = settings.vantage ?? hostname();
  const runId = settings.runId ?? randomUUID();
  const startedAt = now();
  const context = {
    runId,
    vantage,
    startAtMs: startedAt,
    nextIndex: 0,
    requestTimeoutMs: settings.requestTimeoutMs,
    clockOffsetMs: settings.clockOffsetMs ?? 0,
  };
  const targets = {};
  for (const aggregate of aggregates) {
    const baselinePresence = baselinePresenceFor(aggregate);
    const route = { ...aggregate, kind: "aggregate", samples: [] };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      route.samples.push(await captureSample(route, "plain", context));
    }
    const baselineState = { ...route, presence: baselinePresence };
    const progress = evaluateAggregateProgress(baselineState, 2);
    const finalSampleMatches = matchesAggregateResponse(route.samples.at(-1), baselineState);
    targets[aggregate.name] = {
      ...progress,
      complete: progress.complete && finalSampleMatches,
      pass: progress.pass && finalSampleMatches,
      baselinePresence,
      expectedAfterPresence: aggregate.presence,
      baselineLastObservedAtUtc: finalSampleMatches
        ? route.samples.at(-1).responseHeadersAtUtc ?? route.samples.at(-1).atUtc
        : null,
      baselineLastObservedRequestStartedAtUtc: finalSampleMatches
        ? route.samples.at(-1).requestStartedAtUtc ?? route.samples.at(-1).atUtc
        : null,
    };
  }
  const finishedAt = now();
  return {
    name: vantage,
    startedAtUtc: new Date(startedAt).toISOString(),
    startedAtEastern: timestampFields(startedAt).eastern,
    finishedAtUtc: new Date(finishedAt).toISOString(),
    finishedAtEastern: timestampFields(finishedAt).eastern,
    targets,
    pass: Object.values(targets).every(target => target.pass),
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function bundledProbeSource() {
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");
  const corePath = new URL("./probe-core.mjs", import.meta.url);
  const core = await readFile(corePath, "utf8");
  const importPath = 'from "./probe-core.mjs"';
  if (!source.includes(importPath)) throw new Error("Cannot prepare the remote probe module");
  return source.replace(importPath, `from "data:text/javascript;base64,${Buffer.from(core).toString("base64")}"`);
}

function validRemoteHost(host) {
  return typeof host === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host);
}

export function remoteRunnerSource() {
  return String.raw`let input = "";
let pingCount = 0;
let payload = null;
let protocolError = null;
const failProtocol = message => {
  protocolError = message;
  process.stderr.write(message + "\n");
  process.exitCode = 1;
  process.stdin.destroy();
};
process.stdin.setEncoding("utf8");
process.stdout.write("READY\n");
process.stdin.on("data", chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (pingCount < 3) {
      if (line !== "ping") { failProtocol("Expected clock ping"); return; }
      pingCount += 1;
      process.stdout.write(JSON.stringify(Date.now()) + "\n");
    } else if (payload === null) payload = line;
    else { failProtocol("Unexpected extra input"); return; }
  }
});
process.stdin.on("end", () => {
  try {
    if (protocolError || pingCount !== 3) throw new Error(protocolError || "Clock calibration is incomplete");
    if (payload === null && input) payload = input;
    if (payload === null) throw new Error("Probe payload is missing");
    const p = JSON.parse(payload);
    import("data:text/javascript;base64," + Buffer.from(p.source).toString("base64"))
      .then(m => m[p.method](...p.args))
      .then(result => process.stdout.write(JSON.stringify(result)))
      .catch(error => { process.stderr.write(String(error?.stack || error)); process.exitCode = 1; });
  } catch (error) {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
  }
});`;
}

async function runRemoteModule(host, method, args, options, runId, timeoutMs) {
  if (!validRemoteHost(host)) throw new Error("remote host must be a simple SSH host alias");
  const source = await bundledProbeSource();
  const runner = remoteRunnerSource();
  const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
  const command = `timeout --foreground --signal=TERM --kill-after=5s ${timeoutSeconds}s node --input-type=module -e ${shellQuote(runner)}`;
  const optionsForRemote = { ...options, vantage: host, runId };
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let protocolBuffer = "";
    let finalOutput = "";
    let state = "ready";
    let fatalError = null;
    let clockCalibration = null;
    const pings = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      fatalError = new Error(`ssh ${host} exceeded the remote probe timeout`);
      child.kill("SIGTERM");
    }, timeoutMs + 90_000);
    const stopWithError = error => {
      fatalError ??= error;
      child.kill("SIGTERM");
    };
    const sendPing = () => {
      pings.push({ officeStartedAt: Date.now() });
      state = "clock";
      child.stdin.write("ping\n");
    };
    const sendPayload = () => {
      const best = pings.map(ping => ping.calibration).sort((left, right) => left.uncertaintyMs - right.uncertaintyMs)[0];
      if (best.uncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS) {
        stopWithError(new Error(`Remote clock calibration uncertainty exceeds ${MAX_CLOCK_UNCERTAINTY_MS} ms`));
        return;
      }
      clockCalibration = {
        remoteMinusOfficeMs: best.remoteMinusOfficeMs,
        uncertaintyMs: best.uncertaintyMs,
        measuredAtUtc: best.measuredAt.utc,
        measuredAtEastern: best.measuredAt.eastern,
        samples: pings.map(ping => ({
          remoteMinusOfficeMs: ping.calibration.remoteMinusOfficeMs,
          uncertaintyMs: ping.calibration.uncertaintyMs,
          measuredAtUtc: ping.calibration.measuredAt.utc,
        })),
      };
      const payload = JSON.stringify({
        source,
        method,
        args: [...args, {
          ...optionsForRemote,
          clockOffsetMs: clockCalibration.remoteMinusOfficeMs,
          clockUncertaintyMs: clockCalibration.uncertaintyMs,
        }],
      });
      state = "payload";
      child.stdin.end(`${payload}\n`);
    };
    child.stdout.on("data", chunk => {
      const text = chunk.toString("utf8");
      if (state === "payload") {
        finalOutput += text;
        return;
      }
      protocolBuffer += text;
      let newline;
      while (state !== "payload" && (newline = protocolBuffer.indexOf("\n")) >= 0) {
        const line = protocolBuffer.slice(0, newline);
        protocolBuffer = protocolBuffer.slice(newline + 1);
        if (state === "ready") {
          if (line !== "READY") {
            stopWithError(new Error(`ssh ${host} returned an invalid clock-calibration handshake`));
            return;
          }
          sendPing();
        } else if (state === "clock") {
          try {
            const remoteNow = JSON.parse(line);
            const ping = pings.at(-1);
            ping.calibration = estimateRemoteClockOffset(remoteNow, ping.officeStartedAt, Date.now());
            if (pings.length < 3) sendPing();
            else sendPayload();
          } catch (error) {
            stopWithError(new Error(`ssh ${host} returned an invalid clock sample: ${error.message}`));
            return;
          }
        }
      }
      if (state === "payload" && protocolBuffer) {
        finalOutput += protocolBuffer;
        protocolBuffer = "";
      }
    });
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") stopWithError(error);
    });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (fatalError) return reject(fatalError);
      if (code !== 0) return reject(new Error(`ssh ${host} exited ${code}: ${err || finalOutput.trim()}`));
      try {
        resolve({ ...JSON.parse(finalOutput), clockCalibration });
      } catch (error) {
        reject(new Error(`ssh ${host} returned invalid probe JSON: ${error.message}; ${err}`));
      }
    });
  });
}

async function runRemoteVantage(host, config, startAt, options, runId) {
  const routeCount = 1 + config.post.aliases.length + config.aggregates.length;
  const diagnosticDurationMs = Math.ceil(routeCount / 2) * options.requestTimeoutMs;
  const diagnosticDrainMs = Math.max(
    0,
    options.requestTimeoutMs + diagnosticDurationMs - options.maxDurationMs,
  );
  const finishDrainMs = Math.max(options.requestTimeoutMs, diagnosticDrainMs);
  const timeoutMs = 10_000 + options.maxDurationMs + finishDrainMs + 15_000;
  return runRemoteModule(host, "runVantage", [config, startAt], options, runId, timeoutMs);
}

async function runRemoteBaseline(host, aggregates, options, runId) {
  const timeoutMs = 10_000 + aggregates.length * 3 * options.requestTimeoutMs + 15_000;
  return runRemoteModule(host, "runBaselineVantage", [aggregates], options, runId, timeoutMs);
}

export async function runBaseline(config, options = {}) {
  if (!config || typeof config !== "object" || Object.keys(config).some(key => key !== "aggregates")) {
    throw new Error("Baseline config must contain only aggregates");
  }
  validateAggregateTargets(config.aggregates);
  const runId = options.runId ?? randomUUID();
  const localName = options.vantage ?? "local-probe";
  const settings = { ...DEFAULTS, ...options, runId, vantage: localName };
  const remoteHost = options.remoteHost;
  if (remoteHost && (!validRemoteHost(remoteHost) || remoteHost === localName)) {
    throw new Error("remote host must be a distinct simple SSH host alias");
  }
  const tasks = [runBaselineVantage(config.aggregates, settings)];
  if (remoteHost) tasks.push(runRemoteBaseline(remoteHost, config.aggregates, settings, runId));
  const results = await Promise.allSettled(tasks);
  const vantages = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      name: index === 0 ? localName : remoteHost,
      error: `${result.reason?.name ?? "Error"}: ${result.reason?.message ?? String(result.reason)}`,
      targets: {},
      pass: false,
    };
  });
  const starts = vantages.map(vantage => Date.parse(vantage.startedAtUtc)).filter(Number.isFinite);
  const startedAt = starts.length ? Math.min(...starts) : Date.now();
  const finishedAt = Date.now();
  return {
    schemaVersion: 1,
    receiptType: "njpbs-no-build-aggregate-baseline",
    runId,
    aggregateConfigSha256: aggregateConfigFingerprint(config.aggregates),
    startedAtUtc: new Date(startedAt).toISOString(),
    startedAtEastern: timestampFields(startedAt).eastern,
    finishedAtUtc: new Date(finishedAt).toISOString(),
    finishedAtEastern: timestampFields(finishedAt).eastern,
    vantages,
    pass: vantages.length > 0 && vantages.every(vantage => vantage.pass),
  };
}

export async function runProbe(config, startAt, baselineReceipt, options = {}) {
  validateConfig(config);
  const startAtMs = parseTimestamp(startAt, "startAt");
  if (startAtMs > Date.now()) throw new Error("startAt cannot be in the future");
  const runId = options.runId ?? randomUUID();
  const localName = options.vantage ?? "local-probe";
  const remoteHost = options.remoteHost;
  if (remoteHost && (!validRemoteHost(remoteHost) || remoteHost === localName)) {
    throw new Error("remote host must be a distinct simple SSH host alias");
  }
  const requiredVantages = remoteHost ? [localName, remoteHost] : [localName];
  validateBaselineReceipt(baselineReceipt, config.aggregates, startAt, requiredVantages, remoteHost ? [remoteHost] : []);
  const localOptions = { ...DEFAULTS, ...options, runId, vantage: localName };
  const tasks = [runVantage(config, startAt, localOptions)];
  if (remoteHost) tasks.push(runRemoteVantage(remoteHost, config, startAt, { ...DEFAULTS, ...options }, runId));
  const results = await Promise.allSettled(tasks);
  const vantages = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const name = index === 0 ? localName : remoteHost;
    return {
      name,
      error: `${result.reason?.name ?? "Error"}: ${result.reason?.message ?? String(result.reason)}`,
      post: { pass: false, failed: true },
      aggregates: { pass: false, failed: true, targets: {} },
    };
  });
  for (const vantage of vantages) {
    const baselineVantage = baselineReceipt.vantages.find(item => item.name === vantage.name);
    for (const [name, aggregate] of Object.entries(vantage.aggregates.targets)) {
      aggregate.baselinePresence = baselineVantage?.targets?.[name]?.baselinePresence ?? null;
      aggregate.baselineLastObservedAtUtc = baselineVantage?.targets?.[name]?.baselineLastObservedAtUtc ?? null;
      aggregate.baselineLastObservedRequestStartedAtUtc = baselineVantage?.targets?.[name]?.baselineLastObservedRequestStartedAtUtc ?? null;
      aggregate.baselineClockUncertaintyMs = baselineVantage?.clockCalibration?.uncertaintyMs ?? 0;
    }
  }
  const createdAt = Date.now();
  const detailPass = vantages.length > 0 && vantages.every(vantage => vantage.post.pass);
  const aggregateConvergencePass = vantages.length > 0 && vantages.every(vantage => vantage.aggregates.pass);
  return {
    schemaVersion: 1,
    receiptType: "njpbs-no-build-trial-measurement",
    runId,
    startAtUtc: new Date(parseTimestamp(startAt, "startAt")).toISOString(),
    startAtEastern: timestampFields(parseTimestamp(startAt, "startAt")).eastern,
    createdAtUtc: new Date(createdAt).toISOString(),
    createdAtEastern: timestampFields(createdAt).eastern,
    baseline: {
      receiptSha256: createHash("sha256").update(JSON.stringify(baselineReceipt)).digest("hex"),
      finishedAtUtc: baselineReceipt.finishedAtUtc,
      finishedAtEastern: timestampFields(Date.parse(baselineReceipt.finishedAtUtc)).eastern,
      aggregateConfigSha256: baselineReceipt.aggregateConfigSha256,
    },
    limits: {
      postLiveMs: POST_PASS_LIMIT_MS,
      trackedStatusCodes: OBSERVED_STATUS_CODES,
      aggregateTargets: REQUIRED_AGGREGATES,
      uniqueQueryRequestsAffectPass: false,
    },
    expectedPost: {
      canonicalUrl: config.post.canonicalUrl,
      aliases: config.post.aliases,
      publishedVersion: config.post.publishedVersion,
      operationId: config.post.operationId,
      htmlSha256: config.post.htmlSha256,
    },
    vantages,
    normalBuild: null,
    sealedAtUtc: null,
    sealedAtEastern: null,
    decisions: {
      detailPass,
      aggregateConvergencePass,
      aggregateWithinOneNormalBuildPass: null,
      overallPass: null,
    },
  };
}

export function takeFlag(args, flag, fallback = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
  const [, value] = args.splice(index, 2);
  return value;
}

function numberFlag(value, flag, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  return parsed;
}

function parseProbeFlags(args) {
  const configPath = takeFlag(args, "--config");
  const baselineReceiptPath = takeFlag(args, "--baseline-receipt");
  const receiptPath = takeFlag(args, "--receipt");
  const startAt = takeFlag(args, "--start-at");
  if (!configPath || !baselineReceiptPath || !receiptPath || !startAt) {
    throw new Error("probe requires --config, --baseline-receipt, --start-at and --receipt");
  }
  const options = {
    vantage: takeFlag(args, "--vantage", "local-probe"),
    remoteHost: takeFlag(args, "--remote-host"),
    confirmations: numberFlag(takeFlag(args, "--confirmations"), "--confirmations", DEFAULTS.confirmations, 1, 50),
    intervalMs: numberFlag(takeFlag(args, "--interval-ms"), "--interval-ms", DEFAULTS.intervalMs, 250, 30_000),
    lateDetailIntervalMs: numberFlag(takeFlag(args, "--late-detail-interval-ms"), "--late-detail-interval-ms", DEFAULTS.lateDetailIntervalMs, 1_000, 60_000),
    aggregateIntervalMs: numberFlag(takeFlag(args, "--aggregate-interval-ms"), "--aggregate-interval-ms", DEFAULTS.aggregateIntervalMs, 1_000, 300_000),
    maxDurationMs: numberFlag(takeFlag(args, "--max-duration-ms"), "--max-duration-ms", DEFAULTS.maxDurationMs, 1_000, 3_600_000),
    requestTimeoutMs: numberFlag(takeFlag(args, "--request-timeout-ms"), "--request-timeout-ms", DEFAULTS.requestTimeoutMs, 500, 30_000),
  };
  if (args.length) throw new Error(`Unknown probe options: ${args.join(" ")}`);
  return { configPath, baselineReceiptPath, receiptPath, startAt, options };
}

function parseBaselineFlags(args) {
  const configPath = takeFlag(args, "--config");
  const receiptPath = takeFlag(args, "--receipt");
  if (!configPath || !receiptPath) throw new Error("baseline requires --config and --receipt");
  const options = {
    vantage: takeFlag(args, "--vantage", "local-probe"),
    remoteHost: takeFlag(args, "--remote-host"),
    requestTimeoutMs: numberFlag(takeFlag(args, "--request-timeout-ms"), "--request-timeout-ms", DEFAULTS.requestTimeoutMs, 500, 30_000),
  };
  if (args.length) throw new Error(`Unknown baseline options: ${args.join(" ")}`);
  return { configPath, receiptPath, options };
}

async function runCli(argv) {
  const [command = "probe", ...remaining] = argv;
  if (command === "seal") {
    const args = [...remaining];
    const receiptPath = takeFlag(args, "--receipt");
    const id = takeFlag(args, "--normal-build-id");
    const sourceSha = takeFlag(args, "--normal-build-source-sha");
    const startedAt = takeFlag(args, "--normal-build-start-at");
    const completedAt = takeFlag(args, "--normal-build-complete-at");
    if (!receiptPath || !id || !sourceSha || !startedAt || !completedAt || args.length) {
      throw new Error("seal requires --receipt, --normal-build-id, --normal-build-source-sha, --normal-build-start-at and --normal-build-complete-at");
    }
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const sealed = sealReceipt(receipt, { id, sourceSha, startedAt, completedAt });
    await writeJsonReceipt(receiptPath, sealed);
    console.log(JSON.stringify({ receiptPath: resolve(receiptPath), decisions: sealed.decisions, normalBuild: sealed.normalBuild }, null, 2));
    if (!sealed.decisions.overallPass) process.exitCode = 1;
    return;
  }
  if (command === "baseline") {
    const parsed = parseBaselineFlags([...remaining]);
    const config = JSON.parse(await readFile(parsed.configPath, "utf8"));
    const receipt = await runBaseline(config, parsed.options);
    await writeJsonReceipt(parsed.receiptPath, receipt);
    console.log(JSON.stringify({
      receiptPath: resolve(parsed.receiptPath),
      runId: receipt.runId,
      aggregateConfigSha256: receipt.aggregateConfigSha256,
      vantages: receipt.vantages.map(vantage => ({ name: vantage.name, pass: vantage.pass, error: vantage.error ?? null })),
      pass: receipt.pass,
    }, null, 2));
    if (!receipt.pass) process.exitCode = 1;
    return;
  }
  if (command !== "probe") throw new Error("Command must be probe, baseline or seal");
  const parsed = parseProbeFlags([...remaining]);
  const config = JSON.parse(await readFile(parsed.configPath, "utf8"));
  const baselineReceipt = JSON.parse(await readFile(parsed.baselineReceiptPath, "utf8"));
  const receipt = await runProbe(config, parsed.startAt, baselineReceipt, parsed.options);
  await writeJsonReceipt(parsed.receiptPath, receipt);
  console.log(JSON.stringify({
    receiptPath: resolve(parsed.receiptPath),
    runId: receipt.runId,
    vantages: receipt.vantages.map(vantage => ({
      name: vantage.name,
      detailPass: vantage.post.pass,
      firstPostElapsedMs: vantage.post.canonical?.firstExpectedElapsedMs ?? null,
      aggregateConvergencePass: vantage.aggregates.pass,
      timedOut: vantage.timedOut ?? false,
      error: vantage.error ?? null,
    })),
    decisions: receipt.decisions,
  }, null, 2));
  if (!receipt.decisions.detailPass || !receipt.decisions.aggregateConvergencePass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
