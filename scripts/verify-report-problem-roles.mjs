#!/usr/bin/env node

// Real React UI in jsdom -> Auth/Functions/Firestore emulators -> fake delivery providers.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareEmulatorEnv } from "./prepare-emulator-env.mjs";
import {
  assertSafeHostEnvironment, assertEmulatorEnvironment,
  assertFunctionsEmulatorEnvContract, assertIsolatedEmulatorOutput,
  sanitizedSubprocessEnv,
  createFunctionsSecretOverride, cleanupFunctionsSecretOverride,
} from "./lib/admin-e2e-guard.mjs";
import { createStreamOutputGuard, forwardSignalAndWait } from "./lib/admin-e2e-process.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function runChild(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const inspect = createStreamOutputGuard(assertIsolatedEmulatorOutput);
  let failure;
  for (const stream of ["stdout", "stderr"]) child[stream].on("data", (chunk) => {
    try { inspect(stream, chunk); process[stream].write(chunk); }
    catch (error) { failure = error; child.kill("SIGTERM"); }
  });
  const interrupt = () => { void forwardSignalAndWait(child, "SIGINT"); };
  const terminate = () => { void forwardSignalAndWait(child, "SIGTERM"); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const [status, signal] = await once(child, "exit");
    if (failure) throw failure;
    if (status !== 0 || signal) throw new Error("Role matrix command failed");
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

async function inside() {
  const { firestorePort } = assertEmulatorEnvironment();
  const sessionEnded = process.argv.includes("--session-ended");
  if (process.argv.includes("--auth-refusals")) {
    const { createFixtureClients, closeFixtureClients, resetFixtureProject, proveFixtureProjectEmpty } =
      await import("./lib/admin-e2e-fixtures.mjs");
    const clients = createFixtureClients();
    try {
      await resetFixtureProject();
      await runChild(["node_modules/vitest/vitest.mjs", "run", "tests/functions/auth.test.js",
        "tests/functions/cms-edge.test.js", "tests/functions/navigation-preferences.test.js", "--maxWorkers=1"], process.env);
    } finally {
      try { await resetFixtureProject(); await proveFixtureProjectEmpty(clients); }
      finally { await closeFixtureClients(clients); }
    }
    return;
  }
  await runChild(["node_modules/vitest/vitest.mjs", "run", "--root", "admin",
    "--config", "vitest.config.ts", sessionEnded ? "tests/SessionEnded.emulator.test.tsx" : "tests/ReportProblemRoles.emulator.test.tsx",
    "--maxWorkers=1", "--testTimeout=30000"], { ...process.env,
    VITE_FIRESTORE_EMULATOR_PORT: String(firestorePort),
    ...(sessionEnded ? { SESSION_ENDED_EMULATORS: "true" } : { REPORT_PROBLEM_ROLE_EMULATORS: "true" }) });
}

async function main() {
  if (process.argv.includes("--inside-emulators")) return inside();
  assertSafeHostEnvironment();
  prepareEmulatorEnv(root);
  assertFunctionsEmulatorEnvContract(root);
  const runtimeDirectory = mkdtempSync(join(root, ".report-roles-"));
  mkdirSync(join(runtimeDirectory, "config"), { mode: 0o700 });
  let override;
  try {
    override = createFunctionsSecretOverride(root);
    const env = sanitizedSubprocessEnv(process.env, {
      firestorePort: process.env.FIRESTORE_EMULATOR_PORT ?? "8080", runtimeDirectory,
    });
    await runChild(["scripts/run-firebase-emulators.mjs", "exec", "auth,firestore,functions",
      `node scripts/verify-report-problem-roles.mjs --inside-emulators${process.argv.includes("--session-ended") ? " --session-ended" : ""}${process.argv.includes("--auth-refusals") ? " --auth-refusals" : ""}`], env);
  } finally {
    if (override) cleanupFunctionsSecretOverride(override);
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
}

await main();
