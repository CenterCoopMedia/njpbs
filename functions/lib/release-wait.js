"use strict";

// The one place on the release path where work waits or calls an outside
// service (Joe, Nov. 24, 2026: "we don't need any timers until we know how
// long things actually take"). Nothing here stops work by a clock or a count.
// A call is retried until the service answers; a wait ends only when the state
// it reads is done or reports its own failure. Every call and wait is measured
// and written to the run journal, with a line each minute while it waits, so a
// stuck run names what it waits on. Timers come back one at a time, from these
// measurements, each with its measured normal value and reason.
// tests/scripts/release-path-waits.test.mjs keeps time constructs out of every
// other release-path file and keeps stopping numbers out of this one.
// Platform-neutral: the preview renderer Worker bundles callers of this file.

// Pacing only: the pause before the next read or retry. It never ends a wait.
const FIRST_PAUSE_MS = 1_000; // Refresh-pending answers ask for a retry after one second.
const LONGEST_PAUSE_MS = 30_000; // Keeps an unchanged wait from reading more than twice a minute.
const JOURNAL_EVERY_MS = 60_000; // One "still waiting" line a minute.
// A regional capacity allocation (Cloud Run CPU for new revisions) frees as
// other revisions settle, which takes minutes (lgn-checks, njpbs #633).
const CAPACITY_FIRST_PAUSE_MS = 60_000; // The first pause before a capacity retry.
const CAPACITY_LONGEST_PAUSE_MS = 300_000; // The longest pause between capacity retries.
const PACING = Object.freeze({
  default: { first: FIRST_PAUSE_MS, longest: LONGEST_PAUSE_MS },
  capacity: { first: CAPACITY_FIRST_PAUSE_MS, longest: CAPACITY_LONGEST_PAUSE_MS },
});

// Limits the platforms enforce themselves. Callers that must name a limit use
// these maximums; none is ours.
const PLATFORM_LIMITS = Object.freeze({
  // Cloud Functions 2nd gen maximum timeoutSeconds by trigger.
  cloudFunctionsHttpSeconds: 3600,
  cloudFunctionsScheduleSeconds: 1800,
  cloudFunctionsTaskQueueSeconds: 1800,
  cloudFunctionsEventSeconds: 540,
  // GitHub-hosted runner job maximum; the default when timeout-minutes is absent.
  githubHostedJobMinutes: 360,
});

// Network failures that mean the service did not answer. Any HTTP status is an
// answer; its caller decides whether that state means ask again.
const NO_ANSWER_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH",
  "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED"]);

// stderr keeps captured stdout clean; the severity field keeps Cloud Logging at INFO.
let journalSink = line => console.error(JSON.stringify({ severity: "INFO", ...line }));
function journal(line) { try { journalSink({ releaseWait: true, ...line }); } catch { /* A journal write never stops work. */ } }
function setJournal(sink) { journalSink = sink; }

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function noAnswer(error) {
  if (error?.retry === true) return true;
  if (error?.name === "AbortError") return false;
  for (let cause = error; cause; cause = cause.cause) {
    if (NO_ANSWER_CODES.has(cause.code)) return true;
  }
  // fetch reports an answered refusal (a prohibited redirect, a rejected
  // certificate) with the same message as a lost connection. Its cause decides.
  return error?.name === "TypeError" && error.cause === undefined && /fetch failed|network|terminated|socket/i.test(error.message ?? "");
}

function describe(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.slice(0, 200);
  try { return JSON.stringify(value).slice(0, 200); } catch { return String(value).slice(0, 200); }
}

// Journals "still waiting" each minute while work runs; returns its stop.
function everyMinute(what, start, last) {
  const ticker = setInterval(() => journal({ event: "waiting", what, start, waitedMs: Date.now() - start, last: describe(last()) }),
    JOURNAL_EVERY_MS);
  ticker.unref?.();
  return () => clearInterval(ticker);
}

// Calls an outside service until it answers. `request` makes one attempt and
// returns its result; a thrown network error or an error marked { retry: true }
// is retried. Any other result or error is the answer. A stop signal is the
// caller's own cancellation. `pacing` names the pause schedule.
/** @param {string} what @param {() => any} request @param {{ signal?: AbortSignal, pacing?: keyof typeof PACING }} [options] */
async function callOutside(what, request, { signal, pacing = "default" } = {}) {
  if (!Object.hasOwn(PACING, pacing)) throw new Error(`Unknown pacing ${pacing}`);
  const { first, longest } = PACING[pacing];
  const start = Date.now();
  let attempts = 0, lastProblem = null, wait = first, floor = 0;
  const stop = everyMinute(what, start, () => ({ attempts, lastProblem }));
  try {
    while (true) {
      attempts += 1;
      try {
        const result = await request();
        journal({ event: "call", what, start, end: Date.now(), durationMs: Date.now() - start, attempts, result: "answered" });
        return result;
      } catch (error) {
        if (!noAnswer(error)) {
          journal({ event: "call", what, start, end: Date.now(), durationMs: Date.now() - start, attempts, result: "error", error: describe(error?.message) });
          throw error;
        }
        lastProblem = describe(error?.cause?.code ?? error?.message);
        floor = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
      }
      journal({ event: "retry", what, attempts, problem: lastProblem });
      // The service can name its own earliest next try.
      await pause(Math.max(wait, floor), signal);
      wait = Math.min(wait * 2, longest);
    }
  } finally { stop(); }
}

// Waits for a state. `read` returns { done: value } when finished, { failed:
// error } when the thing itself reports failure, or { pending: state } while it
// works. Only done or failed end the wait. A changed pending state reads again
// soon; an unchanged one reads less often, never stopping.
/** @param {string} what @param {() => any} read @param {{ signal?: AbortSignal }} [options] */
async function waitFor(what, read, { signal } = {}) {
  const start = Date.now();
  let reads = 0, last = null, wait = FIRST_PAUSE_MS;
  const stop = everyMinute(what, start, () => ({ reads, last }));
  const finish = (result, extra = {}) =>
    journal({ event: "wait", what, start, end: Date.now(), durationMs: Date.now() - start, reads, result, ...extra });
  try {
    while (true) {
      reads += 1;
      let row;
      try { row = await read(); } catch (error) { finish("error", { error: describe(error?.message) }); throw error; }
      if (row && "done" in row) { finish("done"); return row.done; }
      if (row && "failed" in row) { finish("failed", { error: describe(row.failed?.message ?? row.failed) }); throw row.failed; }
      const state = describe(row?.pending);
      if (state !== last) { last = state; wait = FIRST_PAUSE_MS; } else wait = Math.min(wait * 2, LONGEST_PAUSE_MS);
      await pause(wait, signal);
    }
  } finally { stop(); }
}

// An advisory read that a required step must not wait for. The required step
// goes on with `fallback` when the read has not answered by the first pause. A
// failed read still throws. Never wrap a required step in this.
/** @template T @param {string} what @param {() => Promise<T>} read @param {T} fallback @returns {Promise<T>} */
async function optionalRead(what, read, fallback) {
  let answered = false;
  const value = Promise.resolve().then(read).finally(() => { answered = true; });
  const late = pause(FIRST_PAUSE_MS).then(() => {
    if (!answered) journal({ event: "optional", what, result: "skipped" });
    return fallback;
  });
  return Promise.race([value, late]);
}

/** @param {keyof typeof PLATFORM_LIMITS} name @returns {number} */
function platformLimit(name) {
  if (!Object.hasOwn(PLATFORM_LIMITS, name)) throw new Error(`Unknown platform limit ${name}`);
  return PLATFORM_LIMITS[name];
}

module.exports = { callOutside, waitFor, optionalRead, noAnswer, platformLimit, PLATFORM_LIMITS, setJournal };
