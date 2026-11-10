#!/usr/bin/env node
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { freemem } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Isolated auxiliary ports avoid disturbing other live CI/emulator sessions.
// Functions starts only with the explicit option for focused HTTP tests.
// This runner never starts a build, a suite or a production project.
const port = Number(process.env.FIRESTORE_EMULATOR_PORT);
const withFunctions = process.argv[2] === "--functions";
const files = process.argv.slice(withFunctions ? 3 : 2);
const report = process.env.CMS_READER_TEST_REPORT;
if (report !== undefined && !/^\/[A-Za-z0-9_/-]{1,500}\.json$/.test(report)) throw new Error("Reader test report requires a safe absolute JSON path");
if (!Number.isInteger(port) || port < 1024 || port > 65530 || freemem() < 6 * 1024 ** 3 || !files.length ||
    files.some(file => !/^tests\/functions\/[a-z0-9-]+\.test\.(?:js|ts)$/.test(file))) {
  throw new Error("Explicit emulator port, available memory and focused test files required");
}
const path = join(process.cwd(), `.firebase-emulator-reader-${randomUUID()}.json`), config = JSON.parse(readFileSync("firebase.json", "utf8"));
config.firestore.rules = resolve(config.firestore.rules); config.firestore.indexes = resolve(config.firestore.indexes);
config.emulators = { singleProjectMode: false, firestore: { host: "127.0.0.1", port, websocketPort: port + 3 },
  auth: { host: "127.0.0.1", port: port + 4 }, hub: { host: "127.0.0.1", port: port + 1 },
  logging: { host: "127.0.0.1", port: port + 2 }, ui: { enabled: false },
  ...(withFunctions ? { functions: { host: "127.0.0.1", port: port + 5 } } : {}) };
writeFileSync(path, JSON.stringify(config));
const child = spawn(process.execPath, ["node_modules/firebase-tools/lib/bin/firebase.js", "emulators:exec", "--project", "demo-njpbs",
  "--only", withFunctions ? "auth,firestore,functions" : "auth,firestore", "--config", path,
  `node node_modules/vitest/vitest.mjs run ${files.join(" ")} --maxWorkers=1 --no-file-parallelism${report ? ` --reporter=default --reporter=json --outputFile.json=${report}` : ""}`], {
  stdio: "inherit", env: { ...process.env, JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS ?? "-Xmx768m", METADATA_SERVER_DETECTION: "none",
    ...(withFunctions ? { FUNCTIONS_EMULATOR_HOST: `127.0.0.1:${port + 5}` } : {}) },
});
const stop = signal => child.kill(signal);
const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
try {
  const [code] = await once(child, "exit"); process.exitCode = code ?? 1;
} finally {
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  rmSync(path, { force: true });
}
