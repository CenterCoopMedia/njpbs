#!/usr/bin/env node
// HTTP status probes for release-path shell steps, through the one wait module.
//   answer <what> <curl args...>          print the first HTTP status the URL answers
//   until <what> <status> <curl args...>  wait until the URL answers that status
// A request with no answer is asked again; any HTTP status is an answer.
import { execFile } from "node:child_process";
import releaseWait from "../functions/lib/release-wait.js";

const { callOutside, waitFor } = releaseWait;

function curlStatus(args) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", ...args],
      (error, stdout, stderr) => {
        const status = stdout.trim();
        if (error || !/^[1-5]\d\d$/.test(status)) {
          reject(Object.assign(new Error(stderr.trim() || `curl exited ${error?.code ?? "without a status"}`), { retry: true }));
        } else resolve(status);
      });
  });
}

const [mode, what, ...rest] = process.argv.slice(2);
if (mode === "answer" && what && rest.length) {
  process.stdout.write(await callOutside(what, () => curlStatus(rest)));
} else if (mode === "until" && what && /^[1-5]\d\d$/.test(rest[0] ?? "") && rest.length > 1) {
  const [expected, ...args] = rest;
  await waitFor(what, async () => {
    const status = await callOutside(what, () => curlStatus(args));
    return status === expected ? { done: status } : { pending: `HTTP ${status}` };
  });
} else {
  console.error("Usage: release-wait-status.mjs answer <what> <curl args...> | until <what> <status> <curl args...>");
  process.exit(64);
}
