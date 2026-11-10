import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { releasePair } from "./helpers/private-public-release-pair.js";
import { createPublicArtifactInventoryReceipt } from "../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../site/src/lib/public-worker-artifact";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function runPacket(operationIds: string[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "installed-timing-packet-")); directories.push(directory);
  const distDirectory = path.join(directory, "dist"); await mkdir(distDirectory);
  await writeFile(path.join(distDirectory, "index.html"), "<html>Timing census</html>");
  const timestamp = { seconds: 1_760_000_000, nanoseconds: 0, toMillis: () => 1_760_000_000_000 };
  const artifactReceipt = createPublicArtifactInventoryReceipt({ reservation: {
    schemaVersion: 1, buildBatchId: "timing-packet", generation: 1, commitSha: "a".repeat(40),
    reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null,
    cutoffAt: timestamp, reservedAt: timestamp,
  }, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const preparedArtifact = await preparePublicWorkerArtifact({ artifactReceipt, distDirectory, outputPath: path.join(directory, "prepared.json") });
  const packetPath = path.join(directory, "packet.json");
  await writeFile(packetPath, JSON.stringify({ schemaVersion: 2, pair: releasePair(), distDirectory, preparedArtifact, setup: {},
    cases: operationIds.map(operationId => ({ operationId, sourceVersion: 1, snapshotDigest: "f".repeat(64), path: "/", status: 200 })) }));
  // The parent and child share fd3's file offset. This fake single-use credential
  // stream proves unread bytes remain, rather than only checking an error message.
  const fakeCredential = "synthetic-credential-stream", credentialPath = path.join(directory, "fd3");
  await writeFile(credentialPath, fakeCredential);
  const credential = await open(credentialPath, "r");
  try {
    const child = spawnSync(process.execPath, ["--import", path.join(root, "site/node_modules/tsx/dist/loader.mjs"),
      "--input-type=module", "-e", `
        import { readFileSync } from "node:fs";
        import { runInstalledPublicationTimingPacket } from "./site/scripts/measure-public-release-pair-publication.ts";
        try {
          await runInstalledPublicationTimingPacket({ packet: JSON.parse(readFileSync(process.argv[1], "utf8")),
            outputDirectory: process.argv[2], openSetup: async () => {
              readFileSync(3);
              throw new Error("setup-read-fd3");
            } });
        } catch (error) { process.stderr.write(error.code ?? error.message); process.exitCode = 1; }
      `, packetPath, path.join(directory, "evidence")],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", credential.fd], timeout: 5_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    return { reason: child.stderr, remaining: await credential.readFile("utf8"), fakeCredential };
  } finally { await credential.close(); }
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => String(index).padStart(20, "0"));

it("refuses 21 otherwise-valid unique cases without reading inherited fd3", async () => {
  const result = await runPacket(ids(21));
  expect(result.reason).toBe("installed-timing-packet-invalid");
  expect(result.remaining).toBe(result.fakeCredential);
});

it.each(["abc", "A".repeat(19), "A".repeat(21), "A".repeat(19) + "_", "A".repeat(19) + "-"])(
  "refuses owner-unsupported ID %s without reading inherited fd3", async operationId => {
    const result = await runPacket([operationId]);
    expect(result.reason).toBe("case-invalid");
    expect(result.remaining).toBe(result.fakeCredential);
  });

it("admits 20 unique alphanumeric IDs to the setup credential boundary", async () => {
  const result = await runPacket([...ids(19), "aB".repeat(10)]);
  expect(result.reason).toBe("setup-read-fd3");
  expect(result.remaining).toBe("");
});
