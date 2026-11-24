// Why: twelve releases died on a timer nobody listed (Nov. 24, 2026). The
// release path stops work only on real state; functions/lib/release-wait.js is
// the one place that waits, retries and measures, and holds no stopping number.
// Delete this test when the release path has had no timers outside that module
// for 30 days of releases.
// Each slice that removes sites runs
//   node tests/scripts/release-path-files.mjs --write-remaining
// so the remaining counts only go down. The file goes when it reaches {}.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { REMAINING, ROOT, WAIT_MODULE, countByFile, listReleasePathFiles, timeSites } from "./release-path-files.mjs";

const files = listReleasePathFiles();
const sites = timeSites(files);

test("no release-path file outside the wait module adds a time construct", () => {
  const remaining = JSON.parse(readFileSync(join(ROOT, REMAINING), "utf8"));
  const counts = countByFile(sites);
  const grown = Object.entries(counts).filter(([file, count]) => count > (remaining[file] ?? 0));
  assert.deepEqual(grown.flatMap(([file]) => sites.filter(site => site.file === file)
    .map(site => `${site.file}:${site.line} ${site.construct}: ${site.text}`)), [],
  "Use callOutside, waitFor or platformLimit from functions/lib/release-wait.js instead");
  const shrunk = Object.keys(remaining).filter(file => (counts[file] ?? 0) < remaining[file]);
  assert.deepEqual(shrunk, [], `Sites were removed: run node tests/scripts/release-path-files.mjs --write-remaining`);
});

test("the wait module holds no number that stops a wait", () => {
  const source = readFileSync(join(ROOT, WAIT_MODULE), "utf8");
  const code = source.split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
  assert.doesNotMatch(code, /AbortSignal\.timeout|\.abort\(|\bdeadline\b|\bmax(?:Attempts|Retries)\b|attempts\s*[<>]=?\s*\d|reads\s*[<>]=?\s*\d/i);
  assert.equal(code.match(/\bsetTimeout\(/g)?.length, 1, "setTimeout only paces the next read");
  assert.equal(code.match(/\bsetInterval\(/g)?.length, 1, "setInterval only journals a waiting line");
  const durations = [...code.matchAll(/^const ([A-Z_]+_MS) = [\d_]+; \/\/ .+$/gm)].map(match => match[1]).sort();
  assert.deepEqual(durations, ["CAPACITY_FIRST_PAUSE_MS", "CAPACITY_LONGEST_PAUSE_MS", "FIRST_PAUSE_MS", "JOURNAL_EVERY_MS", "LONGEST_PAUSE_MS"]);
});

test("a call retries until the service answers and a wait ends only on its state", async () => {
  const { callOutside, waitFor, setJournal } = createRequire(import.meta.url)(join(ROOT, WAIT_MODULE));
  const lines = [];
  setJournal(line => lines.push(line));
  let calls = 0;
  const answer = await callOutside("probe", async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return "answered";
  });
  assert.equal(answer, "answered");
  await assert.rejects(callOutside("refused", async () => { throw new Error("refused"); }), /refused/);
  let reads = 0;
  assert.equal(await waitFor("job", async () => (++reads < 2 ? { pending: "running" } : { done: "built" })), "built");
  await assert.rejects(waitFor("job", async () => ({ failed: new Error("build failed") })), /build failed/);
  assert.deepEqual(lines.filter(line => line.event !== "retry").map(line => [line.event, line.what, line.result]),
    [["call", "probe", "answered"], ["call", "refused", "error"], ["wait", "job", "done"], ["wait", "job", "failed"]]);
});
