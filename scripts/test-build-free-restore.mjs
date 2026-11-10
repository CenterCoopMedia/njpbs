#!/usr/bin/env node

// Synthetic data only. Two separate emulator lifetimes exercise the native
// export/import format; application reads after restart cannot use seed memory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function run() {
  assert.equal(process.argv.length, 2, "This drill accepts no target, import or credential arguments");
  assert(!process.env.FIRESTORE_EMULATOR_HOST, "Run outside an existing emulator session");
  const directory = await mkdtemp(join(tmpdir(), "njpbs-restore-"));
  const project = `demo-njpbs-restore-${randomBytes(4).toString("hex")}`;
  const ports = new Set();
  while (ports.size < 4) ports.add(await availablePort());
  const [firestore, hub, logging, websocketPort] = ports;
  const config = join(directory, "firebase.json");
  const backup = join(directory, "firestore-backup");
  const fixture = join(repo, "tests/fixtures/build-free-restore.mjs");
  const startedAt = new Date().toISOString();
  const start = performance.now();
  // Allowlist the child environment. Do not pass cloud credentials, Node
  // preloads, emulator routing or a caller-selected project to either process.
  const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "JAVA_HOME", "SystemRoot", "TEMP", "TMP", "TMPDIR"]
    // config-input: HOME, JAVA_HOME, PATH, SystemRoot, TEMP, TMP, TMPDIR, USERPROFILE
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(env, { CI: "true", GCLOUD_PROJECT: project, GOOGLE_CLOUD_PROJECT: project,
    METADATA_SERVER_DETECTION: "none", JAVA_TOOL_OPTIONS: "-Xmx512m",
    NJPBS_RESTORE_DRILL_ROOT: directory, NJPBS_RESTORE_DRILL_PROJECT: project });
  await writeFile(config, JSON.stringify({ emulators: { singleProjectMode: true,
    firestore: { host: "127.0.0.1", port: firestore, websocketPort },
    hub: { host: "127.0.0.1", port: hub }, logging: { host: "127.0.0.1", port: logging },
    ui: { enabled: false } } }));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  async function phase(name) {
    const child = spawn(process.execPath, [join(repo, "node_modules/firebase-tools/lib/bin/firebase.js"),
      "emulators:exec", "--only", "firestore", "--project", project, "--config", config,
      ...(name === "seed" ? [`--export-on-exit=${backup}`] : [`--import=${backup}`]),
      `${quote(process.execPath)} ${quote(fixture)} ${name}`], { cwd: directory, env, stdio: "inherit" });
    const forward = () => child.kill("SIGINT");
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${name} failed (${signal ?? code})`)));
      });
    } finally {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
    }
  }
  try {
    await phase("seed");
    const exported = JSON.parse(await readFile(join(backup, "firebase-export-metadata.json"), "utf8"));
    assert(exported.firestore, "Native Firestore export must exist before restore");
    await cp(join(directory, "source-artifacts"), join(directory, "artifact-backup"), { recursive: true, errorOnExist: true });
    // Destroy the only live artifact copy before restoring to a different path.
    await rm(join(directory, "source-artifacts"), { recursive: true });
    await cp(join(directory, "artifact-backup"), join(directory, "restored-artifacts"), { recursive: true, errorOnExist: true });
    await phase("verify");
    const checks = JSON.parse(await readFile(join(directory, "verified.json"), "utf8"));
    console.log(JSON.stringify({ result: "PASS", evidence: "synthetic-emulator-restore", project,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), ...checks }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await run();
