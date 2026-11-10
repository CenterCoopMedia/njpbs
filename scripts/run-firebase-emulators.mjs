#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  emulatorCliArgs,
  firebaseEmulatorEnv,
  resolveFirebaseEmulatorConfig,
  shouldForwardEmulatorSignal,
} from "./firebase-emulator-config.mjs";
import { prepareEmulatorEnv } from "./prepare-emulator-env.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceConfigPath = join(repoRoot, "firebase.json");
const firebaseEntry = join(
  repoRoot,
  "node_modules",
  "firebase-tools",
  "lib",
  "bin",
  "firebase.js",
);

function invocation(argv) {
  const [mode, only, command, ...extra] = argv;
  if (extra.length > 0) {
    throw new Error("The Firebase emulator wrapper received unexpected arguments.");
  }
  if (mode === "start") return { mode };
  if (mode === "exec") return { mode, only, command };
  throw new Error('Usage: run-firebase-emulators.mjs start | exec <only> "<command>"');
}

async function run() {
  const requested = invocation(process.argv.slice(2));
  if (requested.mode === "start" || requested.only?.split(",").includes("functions")) {
    prepareEmulatorEnv();
  }
  if (!existsSync(firebaseEntry)) {
    throw new Error("firebase-tools is not installed. Run npm install at the repository root.");
  }

  const sourceConfig = JSON.parse(readFileSync(sourceConfigPath, "utf8"));
  const resolvedConfig = resolveFirebaseEmulatorConfig(sourceConfig);
  const hasOverride = resolvedConfig !== sourceConfig;
  const generatedConfigPath = hasOverride
    ? join(repoRoot, `.firebase-emulator-${process.pid}-${randomUUID()}.json`)
    : null;
  const configPath = generatedConfigPath ?? sourceConfigPath;

  try {
    if (generatedConfigPath) {
      writeFileSync(
        generatedConfigPath,
        `${JSON.stringify(resolvedConfig, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }

    const child = spawn(
      process.execPath,
      [firebaseEntry, ...emulatorCliArgs({ ...requested, configPath })],
      {
        cwd: repoRoot,
        env: firebaseEmulatorEnv(),
        stdio: "inherit",
      },
    );

    const forwardSignal = (signal) => {
      if (
        shouldForwardEmulatorSignal() &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill(signal);
      }
    };
    const forwardSigint = () => forwardSignal("SIGINT");
    const forwardSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", forwardSigint);
    process.once("SIGTERM", forwardSigterm);

    try {
      const [status, signal] = await once(child, "exit");
      if (signal === "SIGINT") {
        process.exitCode = 130;
      } else if (signal === "SIGTERM") {
        process.exitCode = 143;
      } else if (signal) {
        throw new Error(`Firebase emulator command stopped by signal ${signal}.`);
      } else if (typeof status === "number") {
        process.exitCode = status;
      } else {
        throw new Error("Firebase emulator command exited without a status.");
      }
    } finally {
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
    }
  } finally {
    if (generatedConfigPath) rmSync(generatedConfigPath, { force: true });
  }
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
