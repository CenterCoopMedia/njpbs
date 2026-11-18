#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vitestEntry = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const shard = (process.env.VITEST_SHARD_ARGS ?? "").trim();
const filters = process.argv.slice(2);
const group = ["--unit", "--emulator"].includes(filters[0]) ? filters.shift() : null;
// Concurrent transactions on one document deadlock in the Firestore emulator.
// Each deadlock waits for its fixed 2 s lock timeout, and the Admin SDK then
// backs off up to 2 s, 3 s, ... before a retry. Two or three rounds exceed
// Vitest's 5 s default, so the emulator suite gets a larger budget.
const args = ["run", "--testTimeout=20000"];
args.push(group === "--unit" ? "--maxWorkers=2" : "--no-file-parallelism");

if (shard) {
  const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (
    !match ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index > count
  ) {
    throw new Error("VITEST_SHARD_ARGS must use --shard=<index>/<count>");
  }
  args.push(shard);
}

if (filters.some((filter) => !filter.startsWith("tests/functions/") || filter.includes(".."))) {
  throw new Error("Functions test filters must be paths under tests/functions/");
}

if (group) {
  const unitFiles = JSON.parse(readFileSync(join(repoRoot, "tests/functions/unit-files.json"), "utf8"));
  if (!Array.isArray(unitFiles) || !unitFiles.length ||
      unitFiles.some(file => typeof file !== "string" || !/^tests\/functions\/[\w-]+\.test\.[cm]?[jt]sx?$/.test(file))) {
    throw new Error("Functions unit-files.json must list test paths under tests/functions/");
  }
  if (group === "--unit") {
    if (filters.length) throw new Error("Run the whole Functions unit group without path filters");
    args.push(...unitFiles);
  } else {
    args.push(...unitFiles.flatMap((file) => ["--exclude", file]));
  }
}

if (group !== "--unit") args.push(...(filters.length ? filters : ["tests/functions"]));
const result = spawnSync(process.execPath, [vitestEntry, ...args], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.signal) throw new Error(`Functions tests stopped by ${result.signal}`);
process.exitCode = result.status ?? 1;
