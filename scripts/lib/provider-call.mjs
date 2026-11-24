// The one rule for a call to an outside service (Google, Cloudflare, GitHub,
// our own sites through the edge): a failure is retried until the provider
// answers, unless it is a known permanent fault of ours. A provider-side or
// unknown fault never ends a release. functions/lib/release-wait.js paces and
// journals the repeats.
//
// Wrap only the idempotent transport. Checks of the answer stay outside, so a
// refusal of ours is never repeated. A write whose repeat is not idempotent
// passes `readBack`, which answers undefined when the write did not land.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import releaseWait from "../../functions/lib/release-wait.js";

const { callOutside, setJournal } = releaseWait;

// The promise-free form below still counts and sleeps by itself: its callers
// (gcloud reads in configure-cms-functions.mjs and check-cms-secret-iam.mjs,
// the CMS API wrangler deploy) are synchronous, and the wait module is not.
export const PROVIDER_ATTEMPTS = 5;
const FIRST_WAIT_MS = 2_000;
const LONGEST_WAIT_MS = 60_000;

const PERMANENT_FAILURES = Object.freeze([
  ["build", /^Build failed with status: FAILURE\b|predeploy error|Command terminated with non-zero exit code|\berror TS\d+:|^SyntaxError:|Cannot find module /],
  ["config", /Failed to load function definition|HTTP Error: 400\b|INVALID_ARGUMENT|is not a valid|Invalid (?:function|configuration|config|trigger)\b/i],
  ["permission", /HTTP Error: 40[13]\b|PERMISSION_DENIED|Permission denied|does not have (?:the )?(?:required )?permission|Missing (?:required )?permissions?/i],
  ["quota", /\bquota\b.*\b(?:exceeded|exhausted)\b|\bexceed(?:s|ed)? (?:the )?quota\b/i],
  // gh prints the status of a refused API request this way.
  ["request", /\(HTTP 4(?!08|25|29)\d\d\)/],
]);

// A rate quota (per second, minute or 100 seconds) or rate limit clears by itself and is retried.
const RATE_QUOTA = /\bper (?:second|minute|100 seconds)\b|\brate limit\b/i;

export function permanentFailure(output) {
  const lines = output.split("\n");
  for (const [kind, pattern] of PERMANENT_FAILURES) {
    if (lines.some(line => pattern.test(line) && !(["quota", "request"].includes(kind) && RATE_QUOTA.test(line)))) return kind;
  }
  return null;
}

export function lastProviderLine(output) {
  const line = output.split("\n").map(value => value.trim()).filter(value => /error|failed|denied|unavailable|timed? ?out|HTTP/i.test(value)).at(-1);
  return line ? line.slice(0, 300) : "none";
}

/** A 4xx answer names a fault in our request, except the three that ask for a later try. */
const permanentStatus = status => status < 500 && ![408, 425, 429].includes(status);

// A child process error carries its exit code as `status`, below 300.
const httpStatus = error => [error?.response?.status, error?.$metadata?.httpStatusCode, error?.status >= 300 ? error.status : undefined]
  .find(value => Number.isInteger(value) && value >= 100 && value <= 599);

/** The thrown form of an HTTP answer the caller did not accept. */
export const httpFault = response => Object.assign(new Error(`HTTP ${response.status}`), { response });

export function permanentFault(error) {
  const status = httpStatus(error);
  // A rate limit can come as 403 with the time to try again.
  if (status !== undefined) return permanentStatus(status) && !retryAfterMs(error) ? "request" : null;
  return permanentFailure(commandOutput(error));
}

// gcloud reports an absent resource in its own words.
export const permanentGcloudFault = error => permanentFault(error) ??
  (/\bNOT_FOUND\b/.test(commandOutput(error)) ? "absent" : null);

function commandOutput(error) {
  return [error?.stderr, error?.stdout].filter(value => value != null).join("\n");
}

// An HTTP error can carry a response body and authorization headers, and a
// command's stdout can carry a secret. Report only the status, the code, the
// error's kind and a command's error stream.
function faultLine(error) {
  const status = httpStatus(error);
  if (status !== undefined) return `HTTP ${status}`;
  // The owner of a child that prints private input writes its own line.
  if (typeof error?.providerLine === "string") return error.providerLine;
  if (error?.stderr) return lastProviderLine(String(error.stderr));
  const code = [error?.code, error?.cause?.code].find(value => /^[A-Z][A-Z0-9_]{2,40}$/.test(value ?? ""));
  return code ?? (/^[A-Za-z]{1,40}$/.test(error?.name ?? "") ? error.name : "none");
}

function retryAfterMs(error) {
  const headers = error?.response?.headers;
  const value = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  return /^[1-9]\d{0,5}$/.test(value ?? "") ? Number(value) * 1_000 : 0;
}

/** Answers the wait before the next attempt, or reports the final failure and throws it. */
function afterFailure(label, error, attempt, { permanent = permanentFault, log = console.error } = {}) {
  const kind = permanent(error);
  if (kind || attempt >= PROVIDER_ATTEMPTS) {
    log(`Provider call failed: ${label}, class ${kind ?? "transient"}, ${attempt} of ${PROVIDER_ATTEMPTS} attempts, last provider line: ${faultLine(error)}`);
    throw Object.assign(error, { providerAttempts: attempt });
  }
  return Math.min(Math.max(FIRST_WAIT_MS * 2 ** (attempt - 1), retryAfterMs(error)), LONGEST_WAIT_MS);
}

/**
 * @template T
 * @param {string} label
 * @param {() => T | Promise<T>} call
 * @param {{ readBack?: () => Promise<T | undefined> | T | undefined,
 *   permanent?: (error: any) => string | null, log?: (line: string) => void }} [options]
 * @returns {Promise<T>}
 */
export async function providerCall(label, call, { readBack, permanent = permanentFault, log = console.error } = {}) {
  let attempt = 0;
  // A final fault returns from the wait, so its own error code cannot ask for another try.
  const outcome = await callOutside(label, async () => {
    // A lost answer can hide a write that landed.
    if (attempt > 0) {
      const landed = await readBack?.();
      if (landed !== undefined) return { value: landed };
    }
    attempt += 1;
    try { return { value: await call() }; }
    catch (error) {
      const kind = error?.name === "AbortError" ? "cancelled" : permanent(error);
      if (!kind) throw Object.assign(new Error(`${label}: ${faultLine(error)}`), { retry: true });
      const landed = await readBack?.();
      if (landed !== undefined) return { value: landed };
      log(`Provider call failed: ${label}, class ${kind}, attempt ${attempt}, last provider line: ${faultLine(error)}`);
      return { failure: Object.assign(error, { providerAttempts: attempt }) };
    }
  });
  if ("failure" in outcome) throw outcome.failure;
  return outcome.value;
}

const pauseSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function providerCallSync(label, call, { wait = pauseSync, ...options } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return call(); }
    catch (error) { wait(afterFailure(label, error, attempt, options)); }
  }
}

/** One JSON read. An answer that is not 2xx, or an unreadable body, is a fault. */
export function providerJson(label, send, options) {
  return providerCall(label, async () => {
    const response = await send();
    if (!response?.ok) {
      await response?.body?.cancel?.();
      throw httpFault(response ?? {});
    }
    return response.json();
  }, options);
}

/** gcloud, with its arguments and child options. */
export function providerGcloud(args, childOptions, execute = execFileSync, options = {}) {
  return providerCallSync(`gcloud ${args.slice(0, 3).join(" ")}`, () => execute("gcloud", args, childOptions),
    { permanent: permanentGcloudFault, ...options });
}

// Workflow steps: node scripts/lib/provider-call.mjs <label> -- <command> <arguments>
// stdout is written only after success, so a command substitution gets one answer.
// Exit 4 names an absent resource, which a caller can accept as an answer.
export const ABSENT_EXIT = 4;
export function main([label, separator, command, ...args], launch = spawnSync, options = {}) {
  if (!label || separator !== "--" || !command) throw new Error("Usage: provider-call <label> -- <command> [arguments]");
  return providerCall(label, () => {
    const result = launch(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    process.stderr.write(result.stderr ?? "");
    if (result.error || result.status !== 0) {
      throw Object.assign(new Error(`${command} did not succeed`), { code: result.error?.code, stdout: result.stdout, stderr: result.stderr });
    }
    return result.stdout;
  }, { permanent: permanentGcloudFault, ...options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A command substitution reads stdout, so the wait journal goes to stderr.
  setJournal(line => process.stderr.write(`${JSON.stringify(line)}\n`));
  try { process.stdout.write(await main(process.argv.slice(2))); }
  catch (error) { process.exitCode = permanentGcloudFault(error) === "absent" ? ABSENT_EXIT : 1; }
}
