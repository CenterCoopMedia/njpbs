#!/usr/bin/env node
"use strict";

// Explicit operator only. No ADC fallback, workflow, handler or provider writer.
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { cert, deleteApp, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const bootstrap = require("../functions/lib/cms-preview-pair-bootstrap");
const REFUSALS = new Set(["invalid-request", "receipt-conflict", "legacy-runtime-not-paused", "candidate-not-current",
  "legacy-journal-not-drained", "installed-consumer-guard-unbound", "installed-selector-disagrees", "legacy-runtime-changed",
  "current-renderer-changed", "selected-receipt-already-exists", "legacy-component-not-complete", "pair-proof-changed",
  "legacy-queue-not-drained", "installed-consumer-proof-changed", "pair-proof-expired", "reader-proof-changed"]);

function refuse() { throw new Error("Preview bootstrap operator refused"); }
function parseArguments(args) {
  if (![3, 5].includes(args.length) || args.some(value => typeof value !== "string" || !value)) refuse();
  const [command, projectId, inputPath, adapterPath, adapterDigest] = args;
  if (!["plan", "dry-run", "apply", "receipt"].includes(command) ||
      !(["njpbs-site", "njpbs-site-dev"].includes(projectId) || /^demo-[a-z0-9-]{1,50}$/.test(projectId)) ||
      adapterPath && !/^[a-f0-9]{64}$/.test(adapterDigest)) refuse();
  return { command, projectId, inputPath, adapterPath, adapterDigest };
}
function parseCredential(text, projectId) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) refuse();
  const value = JSON.parse(text);
  if (!value || value.type !== "service_account" || value.project_id !== projectId ||
      typeof value.client_email !== "string" || !value.client_email ||
      typeof value.private_key !== "string" || !value.private_key ||
      projectId === "njpbs-site-dev" && !value.client_email.endsWith("@njpbs-site-dev.iam.gserviceaccount.com")) refuse();
  return value;
}
async function runOperator({ firestore, command, input, prepareInstalledConsumers, signal }) {
  const common = { firestore, prepareInstalledConsumers, signal };
  if (command === "plan") return bootstrap.planCmsPreviewBootstrap({ ...common, identity: input });
  if (command === "dry-run" || command === "receipt") {
    const result = await bootstrap.dryRunCmsPreviewBootstrap({ ...common, request: input });
    if (command === "receipt" && !result.receipt) refuse();
    return result;
  }
  if (command === "apply") return bootstrap.applyCmsPreviewBootstrap({ ...common, request: input });
  refuse();
}
async function main() {
  let app, closePipes;
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const args = parseArguments(process.argv.slice(2));
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;
    const demo = args.projectId.startsWith("demo-");
    // Refuse either real project with an emulator host and a demo without one.
    if (demo !== Boolean(emulator) || emulator && !/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(emulator)) refuse();
    const input = JSON.parse(readFileSync(args.inputPath, "utf8"));
    let prepareInstalledConsumers;
    if (args.adapterPath) {
      const bytes = readFileSync(args.adapterPath);
      if (createHash("sha256").update(bytes).digest("hex") !== args.adapterDigest) refuse();
      // Execute the bytes that were verified, with no second file read. The
      // reviewed adapter is a single-file bundle; relative imports cannot work.
      const adapter = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
      closePipes = adapter.prepareCredentialPipes?.({ purpose: args.command === "receipt" ? "none" : "preview-bootstrap", signal: cancellation.signal });
      prepareInstalledConsumers = adapter.prepareInstalledConsumers;
      if (typeof prepareInstalledConsumers !== "function") refuse();
    }
    // Only an explicit real-project invocation consumes a credential from stdin.
    const options = { projectId: args.projectId };
    if (!demo) options.credential = cert(parseCredential(readFileSync(0, "utf8"), args.projectId));
    app = initializeApp(options, "cms-preview-pair-bootstrap-operator");
    const result = await runOperator({ firestore: getFirestore(app), command: args.command, input, prepareInstalledConsumers, signal: cancellation.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Provider/SDK/adapter errors may include request credentials. Never echo them.
    const reason = error instanceof bootstrap.CmsPreviewBootstrapError && REFUSALS.has(error.code) ? error.code : "operation-refused";
    process.stderr.write(`Preview bootstrap refused: ${reason}.\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    closePipes?.();
    if (app) { try { await deleteApp(app); } catch { process.exitCode = 1; } }
  }
}
if (require.main === module) void main();
module.exports = { parseArguments, parseCredential, runOperator };
