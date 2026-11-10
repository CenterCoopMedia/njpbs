#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function child(command, args, options) {
  const childProcess = spawn(command, args, options);
  const forward = () => childProcess.kill("SIGINT");
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  try {
    await new Promise((resolve, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", code => code === 0 ? resolve() : reject(Error("Isolated backup drill failed")));
    });
  } finally {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
  }
}
async function main() {
  assert.equal(process.argv.length, 2, "No target or credential arguments accepted");
  assert(!process.env.FIRESTORE_EMULATOR_HOST, "Refusing an existing emulator target");
  const directory = await mkdtemp(join(tmpdir(), "njpbs-video-backup-"));
  const project = `demo-video-backup-${randomBytes(4).toString("hex")}`;
  const ports = new Set();
  while (ports.size < 4) ports.add(await freePort());
  const [firestore, hub, logging, websocketPort] = ports;
  const config = join(directory, "firebase.json");
  const fixture = join(repo, "tests/fixtures/video-backup-drill.mjs");
  const startedAt = new Date().toISOString();
  const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "JAVA_HOME", "SystemRoot", "TEMP", "TMP", "TMPDIR"]
    // config-input: HOME, JAVA_HOME, PATH, SystemRoot, TEMP, TMP, TMPDIR, USERPROFILE
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(env, { CI: "true", GCLOUD_PROJECT: project, GOOGLE_CLOUD_PROJECT: project,
    METADATA_SERVER_DETECTION: "none", JAVA_TOOL_OPTIONS: "-Xmx512m",
    NJPBS_VIDEO_BACKUP_ROOT: directory, NJPBS_VIDEO_BACKUP_PROJECT: project });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    await writeFile(config, JSON.stringify({ emulators: { singleProjectMode: true,
      firestore: { host: "127.0.0.1", port: firestore, websocketPort },
      hub: { host: "127.0.0.1", port: hub }, logging: { host: "127.0.0.1", port: logging }, ui: { enabled: false } } }));
    await child(process.execPath, [join(repo, "node_modules/firebase-tools/lib/bin/firebase.js"),
      "emulators:exec", "--only", "firestore", "--project", project, "--config", config,
      `${quote(process.execPath)} ${quote(fixture)} backup`], { cwd: directory, env, stdio: "inherit" });
    // Recovery starts only after Firestore has stopped. Destroy both the source
    // MP4 and the complete local worker state, then use destination files alone.
    await rm(join(directory, "source"), { recursive: true });
    await rm(join(directory, "state"), { recursive: true });
    await child(process.execPath, [fixture, "recover"], { cwd: directory, env, stdio: "inherit" });
    const verified = JSON.parse(await readFile(join(directory, "recovery.json"), "utf8"));
    console.log(JSON.stringify({ result: "PASS", evidence: "synthetic-video-backup", project,
      startedAt, completedAt: new Date().toISOString(), configuredLiveJobs: 0, ...verified }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

await main().catch(() => { console.error("Video backup drill failed; provider details suppressed"); process.exitCode = 1; });
