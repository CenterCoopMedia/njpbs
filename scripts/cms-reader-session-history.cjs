#!/usr/bin/env node
"use strict";
// Explicit retention operator for the versioned CMS reader. Each production run
// is a named coordinator task. See docs/cms/functions-deploy.md#reader-session-history.
const { readFileSync } = require("node:fs");
const sessions = require("../functions/lib/cms-reader-session");
function refuse() { throw new Error("CMS reader history operator refused"); }
function parseArguments(args, environment = process.env) {
  const [command, projectId, readerDigest] = args;
  if (!(command === "plan" && args.length === 2 || ["close", "sweep"].includes(command) && args.length === 3 && /^[a-f0-9]{64}$/.test(readerDigest)) ||
      !(["njpbs-site", "njpbs-site-dev"].includes(projectId) || /^demo-[a-z0-9-]{1,50}$/.test(projectId))) refuse();
  const emulator = environment.FIRESTORE_EMULATOR_HOST;
  if (projectId.startsWith("demo-") !== Boolean(emulator) || emulator && !/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(emulator)) refuse();
  return { command, projectId, readerDigest };
}
async function runOperator({ firestore, command, readerDigest, signal }) {
  if (command === "plan") return sessions.readReaderSessionHistory(firestore);
  if (command === "close") {
    await sessions.closeReader(firestore, readerDigest, { retiredOnly: true });
    return { readerDigest, closed: true };
  }
  let deleted = 0, complete = false;
  while (!complete) {
    signal?.throwIfAborted();
    const page = await sessions.sweepClosedReaderSessions(firestore, readerDigest);
    deleted += page.deleted; complete = page.complete;
  }
  return { readerDigest, deleted };
}
async function main() {
  let app;
  const cancellation = new AbortController(), cancel = () => cancellation.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    // Target/emulator rejection precedes stdin or any credential consumption.
    const args = parseArguments(process.argv.slice(2));
    const { cert, initializeApp, deleteApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const options = { projectId: args.projectId };
    if (!args.projectId.startsWith("demo-")) options.credential = cert(require("./bootstrap-cms-preview-pair.cjs").parseCredential(readFileSync(0, "utf8"), args.projectId));
    app = { value: initializeApp(options, "cms-reader-session-history"), deleteApp };
    const result = await runOperator({ firestore: getFirestore(app.value), ...args, signal: cancellation.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch { process.stderr.write("CMS reader history operator refused.\n"); process.exitCode = 1; }
  finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    if (app) { try { await app.deleteApp(app.value); } catch { process.exitCode = 1; } }
  }
}
if (require.main === module) void main();
module.exports = { parseArguments, runOperator };
