import { pathToFileURL } from "node:url";

export const TIERS = Object.freeze({
  first: Object.freeze({ requestsPerSecond: 1, durationSeconds: 60, requestCap: 60 }),
  second: Object.freeze({ requestsPerSecond: 5, durationSeconds: 120, requestCap: 600 }),
});
const CACHE_VALUES = new Set(["HIT", "MISS", "EXPIRED", "STALE", "BYPASS", "DYNAMIC", "UPDATING", "REVALIDATED", "NONE/UNKNOWN"]);
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
const refuse = message => { throw new Error(message); };
export const inNewscastWindow = time => Number(clock.format(new Date(time))) === 17;

export function planCheck({ postUrl, secondTier = false }) {
  let page;
  try { page = new URL(postUrl); } catch { refuse("A canonical public Post URL is required."); }
  if (typeof postUrl !== "string" || postUrl !== `${page.origin}${page.pathname}` ||
      page.protocol !== "https:" || page.hostname !== "njpbs.org" || page.port || page.username || page.password ||
      page.search || page.hash || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(page.pathname) || typeof secondTier !== "boolean") {
    refuse("Use https://njpbs.org/posts/<canonical-slug>/ without credentials, query or fragment.");
  }
  const feed = new URL(page); feed.searchParams.set("live-blog", "updates");
  const tier = secondTier ? "second" : "first";
  return Object.freeze({ tier, ...TIERS[tier], postUrl: page.href, feedUrl: feed.href,
    originRequests: "not measured by the checker" });
}

export function parseArgs(args) {
  let postUrl, secondTier = false, run = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (seen.has(name)) refuse("Repeated option."); seen.add(name);
    if (name === "--post-url") postUrl = args[++index];
    else if (name === "--second-tier") secondTier = true;
    else if (name === "--run") run = true;
    else refuse("Use --post-url URL, optionally --second-tier and --run. The default is a dry run.");
  }
  return { plan: planCheck({ postUrl, secondTier }), run };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function pause(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
const increment = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
function headerStatus(value) {
  if (value === null) return "MISSING";
  const normalized = value.trim().toUpperCase();
  return CACHE_VALUES.has(normalized) ? normalized : "OTHER";
}
function observation() {
  return { requests: 0, completed: 0, bytes: 0, statuses: {}, cfCacheStatus: {}, renderCacheStatus: {},
    age: { present: 0, missingOrInvalid: 0, min: null, max: null }, feedCacheStatus: {} };
}
function recordHeaders(target, response) {
  increment(target.statuses, String(response.status));
  increment(target.cfCacheStatus, headerStatus(response.headers.get("cf-cache-status")));
  increment(target.renderCacheStatus, headerStatus(response.headers.get("x-njpbs-render-cache")));
  // Feed cache telemetry is optional.
  for (const [name, value] of response.headers) {
    if (name.startsWith("x-njpbs-") && name.replaceAll("-", "").includes("liveblog") && name.includes("cache")) {
      target.feedCacheStatus[name] ??= {};
      increment(target.feedCacheStatus[name], headerStatus(value));
    }
  }
  const raw = response.headers.get("age"), age = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(age)) {
    target.age.present++; target.age.min = target.age.min === null ? age : Math.min(age, target.age.min);
    target.age.max = target.age.max === null ? age : Math.max(age, target.age.max);
  } else target.age.missingOrInvalid++;
}
async function consume(response, endpoint, signal, remaining) {
  const expected = endpoint === "feed" ? "application/json" : "text/html";
  if (response.headers.get("content-type")?.toLowerCase().split(";")[0].trim() !== expected) {
    throw new Error("unexpected-content-type");
  }
  const reader = response.body?.getReader(), chunks = [];
  let bytes = 0;
  try {
    if (reader) for (;;) {
      remaining();
      const part = await abortable(reader.read(), signal); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > (endpoint === "feed" ? 64 * 1024 : 8 * 1024 * 1024)) throw new Error("response-too-large");
      if (endpoint === "feed") chunks.push(Buffer.from(part.value));
    }
    if (endpoint === "feed") {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(value.updatedAt)) || !Number.isSafeInteger(value.totalCount) || value.totalCount < 0) throw new Error("invalid-feed");
    }
    return bytes;
  } finally {
    if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

/** Only the CLI's fixed public edge URLs are requested. No SDK, origin probe,
 * cookies, auth header, cache buster, redirect following or retry is used. */
export async function runCheck(input, dependencies = {}) {
  const plan = planCheck(input), request = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => performance.now()), wallNow = dependencies.wallNow ?? Date.now;
  const wait = dependencies.wait ?? pause;
  const startedAt = wallNow(), started = now(), deadline = started + plan.durationSeconds * 1000;
  if (inNewscastWindow(startedAt) || inNewscastWindow(startedAt + plan.durationSeconds * 1000 - 1)) {
    refuse("Execution is refused during or across 5–6 PM Eastern time.");
  }
  const controller = new AbortController();
  let reason = "duration-complete", attempts = 0, nextStart = started;
  const stop = value => { reason = value; controller.abort(value); };
  let timeout;
  const expire = () => {
    const remaining = deadline - now();
    if (remaining > 0) timeout = setTimeout(expire, Math.ceil(remaining));
    else stop("duration-complete");
  };
  timeout = setTimeout(expire, Math.max(0, Math.ceil(deadline - now())));
  const waitUntil = async target => {
    while (!controller.signal.aborted) {
      const remaining = Math.min(target, deadline) - now();
      if (remaining <= 0) break;
      // Timers may wake early. Only the monotonic clock admits a request.
      await wait(Math.ceil(remaining), controller.signal);
    }
  };
  const interrupted = () => stop("interrupted");
  dependencies.signal?.addEventListener("abort", interrupted, { once: true });
  if (dependencies.signal?.aborted) interrupted();
  const results = { feed: observation(), page: observation() };
  try {
    while (!controller.signal.aborted && attempts < plan.requestCap && now() < deadline) {
      if (inNewscastWindow(wallNow())) { stop("newscast-window"); break; }
      await waitUntil(nextStart);
      if (controller.signal.aborted || now() >= deadline) break;
      if (inNewscastWindow(wallNow())) { stop("newscast-window"); break; }
      const requestStarted = now(), remaining = deadline - requestStarted;
      if (remaining <= 0) { stop("duration-complete"); break; }
      const endpoint = attempts % 2 === 0 ? "feed" : "page", target = results[endpoint];
      nextStart = requestStarted + 1000 / plan.requestsPerSecond; attempts++; target.requests++;
      const scope = new AbortController();
      const abort = () => scope.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      // The shared absolute deadline owns the final request's shorter budget.
      const requestTimeout = remaining > 5000 ? setTimeout(() => scope.abort("request-timeout"), 5000) : undefined;
      try {
        const response = await abortable(request(endpoint === "feed" ? plan.feedUrl : plan.postUrl, {
          method: "GET", redirect: "manual", signal: scope.signal,
          headers: { accept: endpoint === "feed" ? "application/json" : "text/html", "user-agent": "NJPBS-election-night-bounded-check/1" },
        }), scope.signal);
        recordHeaders(target, response);
        if (response.status >= 500) { response.body?.cancel().catch(() => {}); stop(`http-${response.status}`); break; }
        if (endpoint === "feed" && response.status === 404) { response.body?.cancel().catch(() => {}); stop("feed-not-deployed"); break; }
        if (response.status < 200 || response.status >= 300) { response.body?.cancel().catch(() => {}); stop(`http-${response.status}`); break; }
        target.bytes += await consume(response, endpoint, scope.signal, () => {
          if (now() >= deadline) { stop("duration-complete"); throw new Error("duration-complete"); }
        }); target.completed++;
      } catch {
        if (!controller.signal.aborted) stop(scope.signal.aborted ? "request-timeout" : "request-or-response-failed");
        break;
      } finally { clearTimeout(requestTimeout); controller.signal.removeEventListener("abort", abort); scope.abort(); }
    }
    // Keep the measured window honest when the final allowed request finishes
    // before the duration cap. A slow response never causes catch-up bursts.
    await waitUntil(deadline);
  } catch {
    if (!controller.signal.aborted) stop("request-or-response-failed");
  } finally {
    clearTimeout(timeout); controller.abort(); dependencies.signal?.removeEventListener("abort", interrupted);
  }
  const elapsedSeconds = Math.max(0, now() - started) / 1000;
  for (const value of Object.values(results)) {
    const reported = Object.entries(value.cfCacheStatus).filter(([key]) => !["MISSING", "OTHER"].includes(key)).reduce((sum, [, count]) => sum + count, 0);
    value.cfHitRatioAmongReportedStatuses = reported ? (value.cfCacheStatus.HIT ?? 0) / reported : null;
  }
  return { ...plan, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(wallNow()).toISOString(),
    elapsedSeconds, measuredRequestsPerSecond: elapsedSeconds ? attempts / elapsedSeconds : 0,
    attempts, stopReason: reason, endpoints: results };
}

export async function main(args, output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  const { plan, run } = parseArgs(args);
  if (!run) { output({ dryRun: true, ...plan, window: "Run outside 5–6 PM Eastern time; no requests made." }); return 0; }
  const abort = new AbortController(), interrupt = () => abort.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const result = await runCheck({ postUrl: plan.postUrl, secondTier: plan.tier === "second" }, { signal: abort.signal });
    output(result); return result.stopReason === "duration-complete" ? 0 : 1;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Check refused."}\n`); process.exitCode = 1;
  });
}
