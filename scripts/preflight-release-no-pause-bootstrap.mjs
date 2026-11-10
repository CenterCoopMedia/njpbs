#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runBootstrapPreflights } from "./lib/public-release-bootstrap-preflight.mjs";
class BootstrapPreflightError extends Error {}
const REFUSALS = new Set(["invalid-invocation", "invalid-packet", "source-mismatch", "source-dirty",
  "adapter-outside-source", "adapter-untracked", "adapter-mismatch", "adapter-unbound"]);

// This CLI has no production mode, provider credential lookup or install writer.
// Fixture creation is a separate, explicitly named demo setup before this CLI.
async function main() {
  const [mode, packetPath, adapterPath, ...extra] = process.argv.slice(2);
  if (mode !== "dry-run" || !packetPath || !adapterPath || extra.length ||
      !/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new BootstrapPreflightError("invalid-invocation");
  const bytes = await readFile(packetPath);
  if (bytes.length > 64 * 1024) throw new BootstrapPreflightError("invalid-packet");
  const packet = JSON.parse(bytes.toString("utf8"));
  if (packet.schemaVersion !== 1 || typeof packet.projectId !== "string" || typeof packet.sourceSha !== "string" || !/^demo-[a-z0-9-]{1,60}$/.test(packet.projectId ?? "") ||
      !/^[a-f0-9]{40}$/.test(packet.sourceSha ?? "")) throw new BootstrapPreflightError("invalid-packet");
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const git = async args => (await promisify(execFile)("git", args, { cwd: sourceRoot })).stdout;
  const stdout = await git(["rev-parse", "HEAD"]);
  if (packet.sourceSha !== stdout.trim()) throw new BootstrapPreflightError("source-mismatch");
  try {
    assertDevelopmentSource(sourceRoot);
  } catch (error) {
    if (error?.message === "Development configuration refused; configure every named input before rendering") {
      throw new BootstrapPreflightError("source-dirty");
    }
    throw error;
  }
  const resolvedAdapter = await realpath(adapterPath);
  const relativeAdapter = path.relative(await realpath(sourceRoot), resolvedAdapter);
  if (!relativeAdapter || relativeAdapter.startsWith(`..${path.sep}`) || relativeAdapter === ".." || path.isAbsolute(relativeAdapter)) throw new BootstrapPreflightError("adapter-outside-source");
  try { await git(["ls-files", "--error-unmatch", "--", relativeAdapter]); }
  catch { throw new BootstrapPreflightError("adapter-untracked"); }
  const adapterDigest = createHash("sha256").update(await readFile(resolvedAdapter)).digest("hex");
  if (packet.adapterDigest !== adapterDigest) throw new BootstrapPreflightError("adapter-mismatch");
  // The explicit adapter is executable reviewed source, never a URL from the
  // packet. Keep the packet free of credentials and the adapter source pinned.
  const adapter = await import(pathToFileURL(resolvedAdapter).href);
  if (typeof adapter.createBootstrapPreflights !== "function") throw new BootstrapPreflightError("adapter-unbound");
  const app = initializeApp({ projectId: packet.projectId }, "rnp-bootstrap-read-only");
  try {
    const adapters = await adapter.createBootstrapPreflights();
    const report = await runBootstrapPreflights({ firestore: getFirestore(app), adapters, input: packet, adapterDigest,
      packetDigest: createHash("sha256").update(bytes).digest("hex"),
      emit: row => process.stdout.write(`${row.status} layer-${row.layer} ${row.name} ${row.receiptDigest ?? row.code}\n`) });
    process.stdout.write(`REPORT ${JSON.stringify(report)}\n`);
    process.stdout.write(`${report.passed ? "PASS" : "FAIL"} emulator-preflight ${report.digest}; production-authority=false\n`);
    if (!report.passed) process.exitCode = 1;
  } finally { await deleteApp(app); }
}
main().catch(error => {
  const reason = error instanceof BootstrapPreflightError && REFUSALS.has(error.message) ? error.message : "bootstrap-preflight-refused";
  process.stderr.write(`FAIL bootstrap-preflight: ${reason}\n`); process.exitCode = 1;
});
