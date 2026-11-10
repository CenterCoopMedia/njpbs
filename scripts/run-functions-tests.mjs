#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vitestEntry = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const shard = (process.env.VITEST_SHARD_ARGS ?? "").trim();
// Concurrent transactions on one document deadlock in the Firestore emulator.
// Each deadlock waits for its fixed 2 s lock timeout, and the Admin SDK then
// backs off up to 2 s, 3 s, ... before a retry. Two or three rounds exceed
// Vitest's 5 s default, so the emulator suite gets a larger budget.
const args = ["run", "--no-file-parallelism", "--testTimeout=20000"];

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

const filters = process.argv.slice(2);
if (filters.some((filter) => !filter.startsWith("tests/functions/") || filter.includes(".."))) {
  throw new Error("Functions test filters must be paths under tests/functions/");
}
args.push(...(filters.length ? filters : ["tests/functions"]));
const result = spawnSync(process.execPath, [vitestEntry, ...args], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.signal) throw new Error(`Functions tests stopped by ${result.signal}`);
process.exitCode = result.status ?? 1;
