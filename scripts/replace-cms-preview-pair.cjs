#!/usr/bin/env node
"use strict";
const { readFileSync } = require("node:fs");
const pairs = require("../functions/lib/cms-preview-pair");
const closures = require("../functions/lib/cms-preview-pair-reader-closure");
function refuse() { throw new Error("Recurring preview operator refused"); }
function parseArguments(args, environment = process.env) {
  if (args.length !== 3) refuse();
  const [command, projectId, inputPath] = args;
  if (!["plan", "close", "select", "receipt", "fence-reader"].includes(command) || typeof inputPath !== "string" || !inputPath ||
      !(["njpbs-site", "njpbs-site-dev"].includes(projectId) || /^demo-[a-z0-9-]{1,50}$/.test(projectId))) refuse();
  const emulator = environment.FIRESTORE_EMULATOR_HOST;
  if (projectId.startsWith("demo-") !== Boolean(emulator) || emulator && !/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(emulator)) refuse();
  // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST, FUNCTIONS_EMULATOR
  if (["FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "FUNCTIONS_EMULATOR"].some(name => environment[name]) && !projectId.startsWith("demo-")) refuse();
  return { command, projectId, inputPath };
}
async function runOperator({ firestore, command, input, now, signal }) {
  signal?.throwIfAborted();
  if (command === "fence-reader") {
    const { parseCmsReaderBridgeRequest } = await import("./lib/cms-reader-bridge-install.mjs");
    const request = parseCmsReaderBridgeRequest(input), sessions = require("../functions/lib/cms-reader-session");
    const readerIdentities = Object.fromEntries(Object.entries(request.readers).map(([component, reader]) => [component, sessions.readerSessionDigest(reader)]));
    const attemptRef = firestore.doc(`cmsReaderBridgeInstallAttempts/${request.operationId}`), fenceRef = firestore.doc(`cmsPreviewReaderAttemptFences/${request.operationId}`);
    return firestore.runTransaction(async transaction => {
      const [attemptRow, existing, ...live] = await transaction.getAll(attemptRef, fenceRef,
        ...["functions", "cmsApi"].map(component => firestore.doc(`${pairs.READER_RECEIPTS}/${component}`)));
      const attempt = attemptRow.data();
      if (attempt?.schemaVersion !== 2 || !["started", "uncertain", "complete"].includes(attempt.state) || attempt.requestDigest !== pairs.digest(request)) refuse();
      if (existing.exists) {
        const original = sessions.parseReaderAttemptFence(existing.data(), attempt, request.operationId);
        if (pairs.digest(original.readers) !== pairs.digest(request.readers)) refuse();
        return original;
      }
      const current = live.map((row, index) => sessions.readerSessionDigest(pairs.currentReader(row.data(), ["functions", "cmsApi"][index])));
      const refs = Object.values(readerIdentities).map(identity => firestore.doc(`cmsReaderSessionWindows/${identity}`));
      const windows = await transaction.getAll(...refs);
      const values = windows.map((row, index) => row.exists ? sessions.parseReaderSessionWindow(row.data(), refs[index].id)
        : { schemaVersion: 2, readerDigest: refs[index].id, maxExpiresAt: 0, closed: false });
      if (values.some((value, index) => current.includes(refs[index].id) && (value.recoveryClosureVersion !== 1 || value.closed))) {
        throw new Error("Current CMS readers cannot be fenced");
      }
      const result = sessions.parseReaderAttemptFence({ schemaVersion: 2, operationId: request.operationId,
        requestDigest: pairs.digest(request), readers: request.readers, readerIdentities }, attempt, request.operationId);
      signal?.throwIfAborted();
      // A lost probe may name readers which are already current, or will
      // become current through another completed probe. Their actual stamp
      // proves the needed behavior; preserve those issuance windows.
      for (let index = 0; index < refs.length; index++) if (values[index].recoveryClosureVersion !== 1) {
        transaction.set(refs[index], { ...values[index], closed: true });
      }
      transaction.create(fenceRef, result);
      return result;
    });
  }
  if (command === "close") return closures.closeRecoveryReaderIssuance(firestore, input, now, signal);
  if (command === "select") {
    if (!input || Object.keys(input).sort().join() !== "expectedSelectorDigest,newPairId,operationId,proofDigest") refuse();
    return pairs.selectPair(firestore, { ...input, signal }, now);
  }
  if (command === "receipt") {
    if (!input || Object.keys(input).join() !== "operationId" || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(input.operationId)) refuse();
    const value = (await firestore.doc(`${pairs.SWITCHES}/${input.operationId}`).get()).data();
    if (value?.schemaVersion !== 2 || value.request?.operationId !== input.operationId) refuse();
    const selector = pairs.parseSelector(value.selector);
    if (!Number.isFinite(Date.parse(value.selectedAt))) refuse();
    return { schemaVersion: 2, operationId: input.operationId, selector, selectedAt: value.selectedAt,
      ...(value.retirement ? { retirement: { pairId: value.retirement.pairId, pairDigest: value.retirement.pairDigest,
        closureDigest: value.retirement.closureDigest } } : {}) };
  }
  if (command === "plan" && input && Object.keys(input).join() === "operationId") {
    if (!/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(input.operationId)) refuse();
    const selector = pairs.parseSelector((await firestore.doc(pairs.SELECTOR_PATH).get()).data());
    return { schemaVersion: 2, phase: "close-recovery", closeRequest: { operationId: input.operationId,
      expectedSelectorDigest: pairs.digest(selector), pairId: selector.recoveryPairId } };
  }
  if (command !== "plan" || !input || Object.keys(input).sort().join() !== "newPairId,operationId,proofDigest" ||
      !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(input.newPairId) || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(input.operationId) ||
      !/^[a-f0-9]{64}$/.test(input.proofDigest)) refuse();
  const snapshot = await firestore.runTransaction(async transaction => {
    const selector = pairs.parseSelector((await transaction.get(firestore.doc(pairs.SELECTOR_PATH))).data());
    const rows = await transaction.getAll(...[`${pairs.PAIRS}/${selector.selectedPairId}`, `${pairs.PAIRS}/${selector.recoveryPairId}`, `${pairs.PAIRS}/${input.newPairId}`,
      `${pairs.READER_RECEIPTS}/functions`, `${pairs.READER_RECEIPTS}/cmsApi`, `${pairs.PROOFS}/${input.proofDigest}`].map(path => firestore.doc(path)));
    const proof = pairs.parseProof(rows[5].data());
    if (pairs.digest(proof) !== input.proofDigest || proof.oldPairDigest !== pairs.digest(pairs.parsePair(rows[0].data())) ||
        proof.newPairDigest !== pairs.digest(pairs.parsePair(rows[2].data()))) refuse();
    return { selector, selectedPair: rows[0].data(), recoveryPair: rows[1].data(), candidatePair: rows[2].data(), functionsReceipt: rows[3].data(), cmsApiReceipt: rows[4].data() };
  }, { readOnly: true });
  const { planPairedCmsRelease } = await import("./lib/cms-preview-pair-release.mjs");
  const plan = planPairedCmsRelease(snapshot), selectorDigest = pairs.digest(snapshot.selector);
  return { schemaVersion: 2, plan,
    ...(plan.retiringPairId ? { closeRequest: { operationId: input.operationId, expectedSelectorDigest: selectorDigest, pairId: plan.retiringPairId } } : {}),
    selectionRequest: { operationId: input.operationId, expectedSelectorDigest: selectorDigest, newPairId: input.newPairId, proofDigest: input.proofDigest } };
}
async function main() {
  let app;
  const cancellation = new AbortController(), cancel = () => cancellation.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    // Target/emulator rejection precedes stdin or any credential consumption.
    const args = parseArguments(process.argv.slice(2));
    const input = JSON.parse(readFileSync(args.inputPath, "utf8"));
    const { cert, initializeApp, deleteApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const options = { projectId: args.projectId };
    if (!args.projectId.startsWith("demo-")) options.credential = cert(require("./bootstrap-cms-preview-pair.cjs").parseCredential(readFileSync(0, "utf8"), args.projectId));
    app = { value: initializeApp(options, "recurring-preview-operator"), deleteApp };
    const result = await runOperator({ firestore: getFirestore(app.value), command: args.command, input, signal: cancellation.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch { process.stderr.write("Recurring preview operator refused.\n"); process.exitCode = 1; }
  finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    if (app) { try { await app.deleteApp(app.value); } catch { process.exitCode = 1; } }
  }
}
if (require.main === module) void main();
module.exports = { parseArguments, runOperator };
