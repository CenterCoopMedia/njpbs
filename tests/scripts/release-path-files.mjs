// Lists the files the release path runs and the time constructs in them.
// tests/scripts/release-path-waits.test.mjs is the only caller. Run this file
// with --list to print every site.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
export const WAIT_MODULE = "functions/lib/release-wait.js";
export const REMAINING = "tests/scripts/release-path-waits-remaining.json";
// Tracked files only: build outputs differ between machines.
const TRACKED = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean));

// The release run, the candidate build, the publish path, the confirmation and
// recovery functions, and the dev and production deploy workflows.
export const RELEASE_ENTRIES = [
  ".github/workflows/cms-dev-deploy.yml",
  ".github/workflows/cms-dev-publish.yml",
  ".github/workflows/cms-staging-deploy.yml",
  ".github/workflows/promote.yml",
  ".github/workflows/publisher-image.yml",
  "functions/publish.js",
  "functions/scheduled-publish.js",
  "functions/publish-reconcile.js",
  "functions/recheck-publication.js",
  "functions/no-build-post-confirmation.js",
  "functions/no-build-cloud-wake.js",
];

const CODE = /\.(?:c|m)?[jt]s$/;
const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", "/index.js", "/index.mjs", "/index.ts"];

function resolveLocal(from, spec) {
  const base = spec.startsWith(".") ? resolve(dirname(join(ROOT, from)), spec) : join(ROOT, spec);
  for (const suffix of EXTENSIONS) {
    const path = relative(ROOT, base + suffix);
    if (TRACKED.has(path)) return path;
  }
  return null;
}

function npmScriptCommands(prefix, name) {
  const file = join(prefix, "package.json");
  if (!TRACKED.has(file)) return [];
  const command = JSON.parse(readFileSync(join(ROOT, file), "utf8")).scripts?.[name];
  return command ? [{ prefix, command }] : [];
}

// Repository paths named by a workflow, shell script or npm script command.
function namedPaths(text, prefix = "") {
  const found = [];
  const pathPattern = /(?:^|[\s"'=/])((?:\.github\/scripts|scripts|functions|publisher|deploy|ops)\/[\w./-]+\.(?:mjs|cjs|js|ts|mts|sh))/g;
  for (const [, path] of text.matchAll(pathPattern)) found.push(join(prefix, path));
  for (const [, runPrefix = "", name] of text.matchAll(/npm\s+(?:--prefix\s+([\w./-]+)\s+)?run\s+([\w:.-]+)/g)) {
    for (const script of npmScriptCommands(runPrefix || prefix, name)) found.push(...namedPaths(script.command, script.prefix));
  }
  return found.filter(path => TRACKED.has(path));
}

function codeImports(file, text) {
  const specs = [];
  const pattern = /\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  for (const match of text.matchAll(pattern)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!spec.startsWith(".")) continue;
    const path = resolveLocal(file, spec);
    if (path) specs.push(path);
  }
  return specs;
}

export function listReleasePathFiles() {
  const seen = new Set(), queue = [...RELEASE_ENTRIES];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !TRACKED.has(file)) continue;
    seen.add(file);
    const text = readFileSync(join(ROOT, file), "utf8");
    if (CODE.test(file)) queue.push(...codeImports(file, text));
    else queue.push(...namedPaths(text));
  }
  return [...seen].sort();
}

// Each construct is a way for code to stop work by a clock or a count.
export const CODE_CONSTRUCTS = [
  ["setTimeout", /\bsetTimeout\s*\(/],
  ["setInterval", /\bsetInterval\s*\(/],
  ["timers/promises", /["']node:timers\/promises["']|["']timers\/promises["']/],
  ["AbortSignal.timeout", /AbortSignal\.timeout\s*\(/],
  ["timeoutSeconds", /\btimeoutSeconds\b(?!\s*:\s*platformLimit\()/],
  ["timeout option", /\btimeout(?:Ms|MS|Millis|Seconds|Minutes)?\s*[:=]\s*[\d(]/],
  // Not wait limits: lock leases, credential, cache and session expiry, clock
  // skew, retention and media lengths. Their names say which.
  ["duration constant", /\b(?![A-Z0-9_]*(?:LEASE|TTL|SKEW|RETENTION|LIFETIME|SESSION|DURATION|TIMESTAMP|PASSAGE|AUDIO_SECONDS|_AGE))[A-Z][A-Z0-9_]*(?:_MS|_SECONDS|_MINUTES|TIMEOUT|DEADLINE|STALL|BUDGET|BACKSTOP)\b[A-Z0-9_]*\s*=/],
  ["attempt cap", /\b[A-Z][A-Z0-9_]*(?:ATTEMPTS|RETRIES|ROUNDS|POLLS|ATTEMPT_LIMIT|RETRY_LIMIT)\b[A-Z0-9_]*\s*=\s*[\d(]|\bmax(?:Attempts|Retries|Rounds|Polls)\b/],
  // "deadline-exceeded" is a gRPC status name, not a limit.
  ["deadline", /\bdeadline\b(?!-exceeded)/i],
];
export const SHELL_CONSTRUCTS = [
  ["timeout-minutes", /\btimeout-minutes\s*:/],
  ["timeout command", /(?:^|[\s;|&(])timeout\s+(?:-\w+\s+)*\d/],
  ["sleep", /(?:^|[\s;|&(])sleep\s+\d/],
  ["curl limit", /--max-time\b|--connect-timeout\b|--retry(?:-max-time)?\s+\d/],
  ["counted loop", /\bseq\s+(?:1\s+)?\d+|\bfor\s*\(\(\s*\w+\s*=\s*\d+;\s*\w+\s*<=?\s*\d+/],
  ["--timeout flag", /--timeout[=\s]+\d/],
];

export function countByFile(sites) {
  const counts = {};
  for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function timeSites(files = listReleasePathFiles()) {
  const sites = [];
  for (const file of files.filter(path => path !== WAIT_MODULE)) {
    const constructs = CODE.test(file) ? CODE_CONSTRUCTS : SHELL_CONSTRUCTS;
    readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, index) => {
      if (/^\s*(?:\/\/|\/?\*|#)/.test(line)) return;
      for (const [name, pattern] of constructs) {
        if (pattern.test(line)) { sites.push({ file, line: index + 1, construct: name, text: line.trim().slice(0, 160) }); break; }
      }
    });
  }
  return sites;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const files = listReleasePathFiles(), sites = timeSites(files);
  const byConstruct = {};
  for (const site of sites) byConstruct[site.construct] = (byConstruct[site.construct] ?? 0) + 1;
  console.log(JSON.stringify({ files: files.length, sites: sites.length, byConstruct }, null, 1));
  if (process.argv.includes("--write-remaining")) writeFileSync(join(ROOT, REMAINING), `${JSON.stringify(countByFile(sites), null, 2)}\n`);
  if (process.argv.includes("--list")) for (const site of sites) console.log(`${site.file}:${site.line}\t${site.construct}\t${site.text}`);
}
