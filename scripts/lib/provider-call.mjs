// The one rule for a call to an outside service (Google, Cloudflare, GitHub,
// our own sites through the edge): a failure is retried unless it is a known
// permanent fault of ours. A provider-side or unknown fault never ends a
// release on its first occurrence.
//
// Wrap only the idempotent transport. Checks of the answer stay outside, so a
// refusal of ours is never repeated. A write whose repeat is not idempotent
// passes `readBack`, which answers undefined when the write did not land.
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const PROVIDER_ATTEMPTS = 5;

// Waits of 2, 4, 8 and 16 s. Dev run 45429859229 (Nov. 24, 2026) ended on one
// Secret Manager 503; such faults clear in seconds, and 30 s in total is short
// beside the 26 minutes a new run costs. A provider that names a longer
// Retry-After is waited for, to 60 s, so one answer cannot hold a job.
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
// A quota is final only when the provider names a limit that waiting cannot
// free: a daily limit or a per-project count. Cloud Run's regional CPU and
// memory allocation frees as revisions settle (dev run 45504015954, Nov. 24,
// 2026: "Quota exceeded for total allowable CPU per project per region"), and
// any other quota wording is retried and reported on each wait.
const FINAL_QUOTA = /\bdaily limit\b|\bper day\b|limit '[^']* per project'/i;

// Firebase prints this when the provider answers an update without the
// function's service. Firebase takes a schedule's URL from that answer, so it
// then sends Cloud Scheduler an empty URL (dev run 45562533334, Nov. 25, 2026).
// Our configuration holds no schedule URL, so that one 400 is the provider's
// fault. The deploy names the functions it can still retry for it. Every other 400
// is final.
const INCOMPLETE_ANSWER = /unexpected state - please re-deploy your functions/;
const EMPTY_SCHEDULE_URL = /^Request to https:\/\/cloudscheduler\.googleapis\.com\/\S+\/jobs\/firebase-schedule-([A-Za-z][A-Za-z0-9]*)-[a-z0-9-]+(?:\?\S*)? had HTTP Error: 400, URL cannot be empty\b/;

/** The functions whose schedule Firebase sent with an empty URL after an incomplete answer. */
export function emptyScheduleUrls(output) {
  const lines = output.split("\n");
  return lines.some(line => INCOMPLETE_ANSWER.test(line)) ? lines.flatMap(line => line.match(EMPTY_SCHEDULE_URL)?.[1] ?? []) : [];
}

function permanentMatch(output, retryableSchedules = []) {
  const lines = output.split("\n");
  const retryable = emptyScheduleUrls(output).filter(name => retryableSchedules.includes(name));
  for (const [kind, pattern] of PERMANENT_FAILURES) {
    const line = lines.find(line => pattern.test(line) && !(kind === "request" && RATE_QUOTA.test(line)) &&
      !(kind === "quota" && (RATE_QUOTA.test(line) || !FINAL_QUOTA.test(line))) &&
      !(kind === "config" && retryable.includes(line.match(EMPTY_SCHEDULE_URL)?.[1])));
    if (line !== undefined) return { kind, line: line.trim().slice(0, 300) };
  }
  return null;
}

export const permanentFailure = (output, retryableSchedules) => permanentMatch(output, retryableSchedules)?.kind ?? null;

/** The output line that gave permanentFailure its class. */
export const permanentFailureLine = (output, retryableSchedules) => permanentMatch(output, retryableSchedules)?.line ?? "none";

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

const isChildFault = error => ["stdout", "stderr", "spawnargs"].some(key => error?.[key] != null) || Number.isInteger(error?.status);

// The code a caller sets on an error when its own rule refuses a call. Only
// this ends a call at once: an unmarked error can come from a provider library
// after an answer, so it is repeated.
export const CALLER_REFUSED = "CALLER_REFUSED";

// Deploy logs are public. The first line of a message stays, without URL
// credentials and queries, labelled secrets, addresses and opaque values.
function publicText(text) {
  return String(text).split(/[\r\n]/, 1)[0]
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi, "$1")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1?[withheld]")
    .replace(/\b(bearer|basic)\s+[^\s"',]+/gi, "$1 [withheld]")
    .replace(/(authorization|cookie|token|secret|password|passphrase|credential|signature|(?:api|private|access|signing)[_ -]?key(?:_id)?)(["']?\s*[:=]\s*)[^&]+/gi, "$1$2[withheld]")
    .replace(/[^\s@"'<>:/]+@[^\s@"'<>:/]+\.[a-z]{2,}/gi, "[withheld]")
    // A path has no part that mixes all three classes; an opaque value does.
    .replace(/[A-Za-z0-9+/_=-]{20,}/g, run => run.split("/").some(part => part.length > 7 && /[a-z]/.test(part) && /[A-Z]/.test(part) && /\d/.test(part)) ? "[withheld]" : run)
    .replace(/[A-Za-z0-9_-]{20,}/g, run => /\d/.test(run) && /[A-Za-z]/.test(run) ? "[withheld]" : run)
    .replace(/\{[\s\S]*/, "{[withheld]")
    // eslint-disable-next-line no-control-regex -- A log line cannot carry controls.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 300).trim();
}

/**
 * One line about a fault that is safe in a public log. An HTTP error can carry
 * a response body and authorization headers, a command's message its arguments
 * and its stdout a secret, and a JSON parse error the text it read. Those
 * report only the status, the error stream and the kind.
 * @param {any} error
 * @returns {string}
 */
export function faultLine(error) {
  const status = httpStatus(error);
  if (status !== undefined) return `HTTP ${status}`;
  // The owner of a child that prints private input writes its own line.
  if (typeof error?.providerLine === "string") return error.providerLine;
  if (error?.stderr) return publicText(lastProviderLine(String(error.stderr)));
  const code = /^[A-Z][A-Z0-9_]{2,40}$/.test(error?.code ?? "") ? error.code : undefined;
  // An SDK's request error can quote the request it carries.
  if (["config", "request", "response", "$metadata"].some(key => error?.[key] != null)) return code ?? "none";
  if (isChildFault(error)) return code ?? (Number.isInteger(error.status) ? `exit ${error.status}` : "none");
  const name = /^[A-Za-z]{1,40}$/.test(error?.name ?? "") ? error.name : undefined;
  const message = error instanceof SyntaxError ? "" : publicText(error?.message ?? "");
  const kind = code ? (message.startsWith(code) ? undefined : code) : ["Error", "FaultCause"].includes(name) && message ? undefined : name;
  const line = [kind, message].filter(Boolean).join(": ") || "none";
  return error?.cause instanceof Error ? `${line}; cause: ${faultLine(error.cause)}` : line;
}

class FaultCause extends Error { name = "FaultCause"; }

/**
 * The options of an error that replaces a caught one:
 * throw new OwnError("What failed", faultCause(error)). The caught error is
 * not kept, so printing the new one cannot show a header or body.
 * @param {any} error
 */
export const faultCause = error => ({ cause: new FaultCause(faultLine(error)) });

/** An own error's message and the cause it was given by faultCause. The output of a script ends here.
 * @param {any} error */
export const failureText = error => error?.cause?.name === "FaultCause" ? `${error.message}; cause: ${error.cause.message}` : `${error?.message}`;

function retryAfterMs(error) {
  const headers = error?.response?.headers;
  const value = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  return /^[1-9]\d{0,5}$/.test(value ?? "") ? Number(value) * 1_000 : 0;
}

/** Answers the wait before the next attempt, or reports the final failure and throws it. */
function afterFailure(label, error, attempt, { permanent = permanentFault, log = console.error } = {}) {
  const kind = permanent(error) ?? (error?.code === CALLER_REFUSED ? "caller" : null);
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
 * @param {{ wait?: (ms: number) => unknown, readBack?: () => Promise<T | undefined> | T | undefined,
 *   permanent?: (error: any) => string | null, log?: (line: string) => void }} [options]
 * @returns {Promise<T>}
 */
export async function providerCall(label, call, { wait = pause, readBack, ...options } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await call(); }
    catch (error) {
      let delay, failure;
      try { delay = afterFailure(label, error, attempt, options); }
      catch (final) { failure = final; }
      // A lost answer can hide a write that landed, after the last attempt too.
      if (!failure) await wait(delay);
      const landed = await readBack?.();
      if (landed !== undefined) return landed;
      if (failure) throw failure;
    }
  }
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
  return providerCallSync(label, () => {
    const result = launch(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    process.stderr.write(result.stderr ?? "");
    if (result.error || result.status !== 0) {
      throw Object.assign(new Error(`${command} did not succeed`), { code: result.error?.code, stdout: result.stdout, stderr: result.stderr });
    }
    return result.stdout;
  }, { permanent: permanentGcloudFault, ...options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(main(process.argv.slice(2))); }
  catch (error) { process.exitCode = permanentGcloudFault(error) === "absent" ? ABSENT_EXIT : 1; }
}
