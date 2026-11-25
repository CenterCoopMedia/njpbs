#!/usr/bin/env node
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cert, deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { cmsTarget } from "./lib/cms-target.mjs";
import {
  ComponentReceiptError,
  abandonReceipt,
  collectLiveIdentities,
  completeReceipt,
  configurationFingerprint,
  edgeOriginSecretFingerprint,
  fingerprintInputs,
  readReceipt,
  startReceipt,
} from "./lib/cms-component-receipt.mjs";
import { assertLegacyCmsWorkflow, fingerprintExecutionSource, fingerprintReceiptExecutionSource, identitiesMatch, planCmsApiRelease } from "./lib/cms-release-plan.mjs";

function fail(message) {
  throw new ComponentReceiptError(message);
}

function arg(name, argv) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) fail(`${name} is required`);
  return argv[index + 1];
}

const quiet = (promise) => Promise.resolve().then(() => promise).catch(() => null);

function optionalArg(name, argv) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function recordedIdentityMatchesSource(component, recorded, expectedSha) {
  return component !== "renderer" || !expectedSha || recorded?.rendererSha === expectedSha;
}

// A missing digest records null, and the next plan deploys the Worker.
function readConfigurationFingerprint(argv) {
  const digest = optionalArg("--configuration-fingerprint", argv);
  if (digest) return digest;
  const path = optionalArg("--configuration-fingerprint-file", argv);
  if (!path) return null;
  try {
    return readFileSync(resolve(path), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// A one-way digest of the Worker secrets file lets the plan detect a secret
// change without storing a secret value. The complete step records the digest
// this plan wrote, after the secrets file is removed.
function writeConfigurationFingerprint(argv) {
  const out = arg("--configuration-fingerprint-file", argv);
  rmSync(resolve(out), { force: true });
  const secrets = JSON.parse(readFileSync(resolve(arg("--secrets-file", argv)), "utf8"));
  const edgeFingerprint = edgeOriginSecretFingerprint(secrets);
  const digest = configurationFingerprint(secrets);
  writeFileSync(resolve(out), `${digest}\n`, { mode: 0o600 });
  return { configurationFingerprint: digest, edgeOriginSecretFingerprint: edgeFingerprint };
}

async function readWorkerPlan(firestore, { pairing, cwd, sourceSha, trustedWorkflowSha, configurationFingerprint: digest }) {
  const receipt = await quiet(readReceipt(firestore, "cmsApi"));
  const baseline = receipt?.state === "complete" ? receipt.mutation : null;
  const [inputFingerprint, trustedFingerprint, trustedReceiptFingerprint, liveIdentities] = await Promise.all([
    quiet(fingerprintInputs(sourceSha, "cmsApi", { cwd })),
    quiet(fingerprintExecutionSource(sourceSha, trustedWorkflowSha, { cwd })),
    fingerprintReceiptExecutionSource(baseline, { cwd }),
    quiet(collectLiveIdentities("cmsApi", { firestore })),
  ]);
  return planCmsApiRelease({ ...pairing, receipt, inputFingerprint, trustedFingerprint, trustedReceiptFingerprint,
    configurationFingerprint: digest, liveIdentities });
}

// The Worker plan before the Functions plan: whether the Worker changes on its own inputs.
export async function planUnpairedWorker(firestore, { secrets, ...source }) {
  const edgeOriginSecret = edgeOriginSecretFingerprint(secrets);
  return readWorkerPlan(firestore, { ...source, configurationFingerprint: configurationFingerprint(secrets),
    pairing: { configurationRequiresRelease: "false", edgeOriginSecretFingerprint: edgeOriginSecret,
      expectedEdgeOriginSecretFingerprint: edgeOriginSecret } });
}

// After secret agreement, unavailable deployment metadata selects a deploy.
async function planWorker(argv) {
  const cwd = process.env.GITHUB_WORKSPACE;
  const pairing = {
    configurationRequiresRelease: process.env.CONFIGURATION_REQUIRES_RELEASE,
    expectedEdgeOriginSecretFingerprint: process.env.CMS_EDGE_ORIGIN_SECRET_FINGERPRINT,
  };
  // Read and validate before any fail-open deployment fallback. A partial job
  // rerun can observe a newer GitHub secret than the successful preflight did.
  let fingerprints;
  try {
    fingerprints = writeConfigurationFingerprint(argv);
  } catch (error) {
    // JSON parse errors can include secret-file content, which faultCause leaves out.
    const { faultCause } = await import("./lib/provider-call.mjs");
    throw new ComponentReceiptError("CMS API secret fingerprints could not be prepared", faultCause(error));
  }
  pairing.edgeOriginSecretFingerprint = fingerprints.edgeOriginSecretFingerprint;
  const paired = planCmsApiRelease(pairing);
  if (paired.abort || paired.reason === "paired_release") return paired;
  try {
    return await withFirestore((firestore) => readWorkerPlan(firestore, { pairing, cwd,
      sourceSha: arg("--source-sha", argv), trustedWorkflowSha: arg("--trusted-workflow-sha", argv),
      configurationFingerprint: fingerprints.configurationFingerprint }));
  } catch {
    return { mutated: true, reason: "plan_unavailable" };
  }
}

function credential() {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")
    : process.env.CMS_PREVIEW_FIREBASE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) fail("Firebase credentials are required");
  const parsed = typeof json === "string" && json.trim().startsWith("{")
    ? JSON.parse(json)
    : JSON.parse(readFileSync(json, "utf8"));
  const { projectId } = cmsTarget();
  if (parsed.project_id !== projectId) fail(`Firebase project must be ${projectId}`);
  return parsed;
}

const RENDERER_CONTROL = "system/cmsPreviewRuntime";

// A complete renderer receipt with a reported control that still says starting
// is an open that did not happen: the run ended between them. The open follows
// the receipt and nothing else writes ready, so it is idempotent.
async function openPendingPreview(firestore, collect = collectLiveIdentities) {
  const controlRef = firestore.doc(RENDERER_CONTROL);
  const receiptDoc = firestore.collection("cmsDeploymentReceipts").doc("renderer");
  const pending = (control, receipt) => control?.phase === "starting" && receipt?.state === "complete"
    && receipt.mutation?.sourceSha === control.rendererSha;
  const [control, receipt] = (await Promise.all([controlRef.get(), receiptDoc.get()])).map(row => row.data());
  if (!pending(control, receipt)) return false;
  const live = await collect("renderer", { firestore, reportedRendererSha: control.rendererSha });
  if (!identitiesMatch(live, receipt.mutation.providerIdentities)) fail("The pending renderer differs from its receipt");
  await firestore.runTransaction(async transaction => {
    const [now, stored] = [(await transaction.get(controlRef)).data(), (await transaction.get(receiptDoc)).data()];
    if (!pending(now, stored) || now.rendererSha !== control.rendererSha || now.checkedAt !== control.checkedAt) {
      fail("Preview admission changed during the open");
    }
    transaction.set(controlRef, { ...now, phase: "ready" });
  });
  return true;
}

async function withFirestore(work) {
  const app = getApps()[0] || initializeApp({ credential: cert(credential()), projectId: cmsTarget().projectId });
  try {
    return await work(getFirestore(app), app);
  } finally {
    if (!getApps().length) return;
    await deleteApp(app);
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "open-pending") {
    const opened = await withFirestore(firestore => openPendingPreview(firestore));
    process.stdout.write(opened ? "Preview admission opened for a complete receipt\n" : "No preview admission is pending\n");
    return;
  }
  if (command === "protocol") {
    await withFirestore(assertLegacyCmsWorkflow);
    process.stdout.write("preview_protocol=schema-one\n");
    return;
  }
  const component = arg("--component", argv);
  if (command === "read") {
    const receipt = await withFirestore((firestore) => readReceipt(firestore, component));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  if (command === "confirm") {
    const expectedSha = optionalArg("--source-sha", argv);
    await withFirestore(async (firestore) => {
      await assertLegacyCmsWorkflow(firestore);
      const receipt = await readReceipt(firestore, component);
      const resume = selectiveReceiptResumable(receipt, {
        component, sourceSha: optionalArg("--resume-source-sha", argv),
        runId: optionalArg("--resume-run-id", argv), runAttempt: optionalArg("--resume-run-attempt", argv),
      });
      if (resume && receipt.state === "in_progress") {
        process.stdout.write("Resuming this run's interrupted Functions mutation at the same source\n");
        return;
      }
      if (receipt?.state !== "complete") {
        fail("Receipt is not complete");
      }
      if (!resume && expectedSha && receipt.mutation?.sourceSha !== expectedSha) {
        fail("Receipt source does not match the planned release");
      }
      const recorded = receipt.mutation?.providerIdentities;
      if (!recordedIdentityMatchesSource(component, recorded, expectedSha)) {
        fail("Receipt renderer identity does not match the planned release");
      }
      let lastError = "Live identity does not match the receipt";
      const attempts = component === "renderer" ? 8 : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          // One sample per confirm attempt. This loop waits for a state that has not settled.
          const live = await collectLiveIdentities(component, { firestore, rolloutDeadlineMs: 0 });
          if (identitiesMatch(live, recorded)) {
            process.stdout.write(`${component} live identity matches the receipt\n`);
            return;
          }
          lastError = "Live identity does not match the receipt";
        } catch (error) {
          lastError = error instanceof ComponentReceiptError ? error.message : "Live identity could not be read";
        }
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      fail(lastError);
    });
    return;
  }
  if (command === "plan") {
    if (component !== "cmsApi") fail("Only the cmsApi receipt has a job-level plan");
    const plan = await planWorker(argv);
    if (plan.abort) fail("CMS edge origin secret differs from the Functions release; rerun the full release");
    const lines = [`mutated=${plan.mutated}`, `reason=${plan.reason}`];
    process.stdout.write(`${lines.join("\n")}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
    return;
  }
  if (command === "abandon") {
    // A renderer receipt needs a new paired release, selected by completed-run
    // recovery or force_firebase, to resume the preview admission it paused.
    if (component !== "functions") fail("Only the functions receipt can be abandoned");
    const runId = arg("--run-id", argv);
    const runAttempt = arg("--run-attempt", argv);
    const result = await withFirestore((firestore) => abandonReceipt(firestore, {
      component,
      runId,
      runAttempt,
    }));
    process.stdout.write(`${component} receipt ${result.receipt.state}\n`);
    return;
  }
  const sourceSha = arg("--source-sha", argv);
  const runId = arg("--run-id", argv);
  const runAttempt = arg("--run-attempt", argv);
  if (command === "start") {
    const result = await withFirestore((firestore) => startReceipt(firestore, {
      component,
      sourceSha,
      trustedWorkflowSha: arg("--trusted-workflow-sha", argv),
      previewRendererSha: process.env.RENDERER_TARGET_SHA,
      inputFingerprint: optionalArg("--input-fingerprint", argv) ?? undefined,
      runId,
      runAttempt,
    }));
    process.stdout.write(`${component} receipt ${result.changed ? "started" : "already in progress"}\n`);
    return;
  }
  if (command === "complete") {
    const configurationFingerprint = readConfigurationFingerprint(argv);
    if (component === "functions" && !/^[a-f0-9]{64}$/.test(configurationFingerprint ?? "")) {
      fail("Functions configuration fingerprint is required");
    }
    const live = argv.includes("--live");
    const expectedWorkerVersion = live && component === "cmsApi" ? arg("--expected-worker-version", argv) : undefined;
    const identities = optionalArg("--provider-identities", argv) ?? optionalArg("--provider-identities-file", argv);
    const result = await withFirestore(async (firestore) => {
      const providerIdentities = live
        ? await collectLiveIdentities(component, { firestore, expectedWorkerVersion, ...(component === "renderer" ? { reportedRendererSha: sourceSha } : {}) })
        : (identities && !identities.trim().startsWith("{")
          ? readFileSync(resolve(identities), "utf8")
          : identities);
      const completed = await completeReceipt(firestore, {
        component,
        sourceSha,
        runId,
        runAttempt,
        providerIdentities,
        configurationFingerprint,
        variablesFingerprint: optionalArg("--variables-fingerprint", argv),
      });
      if (live && component === "renderer") await openPendingPreview(firestore);
      return completed;
    });
    process.stdout.write(`${component} receipt ${result.receipt.state}\n`);
    return;
  }
  fail("Receipt command must be start, complete, confirm, read, or abandon");
}



export { main, openPendingPreview, recordedIdentityMatchesSource, withFirestore };

export function selectiveReceiptResumable(receipt, input) {
  const mutation = receipt?.mutation;
  return input.component === "functions" && receipt?.component === "functions" && receipt.schemaVersion === 1
    && ["in_progress", "complete"].includes(receipt.state)
    && /^[a-f0-9]{40}$/.test(input.sourceSha ?? "") && mutation?.sourceSha === input.sourceSha
    && /^[0-9]{1,20}$/.test(input.runId ?? "") && mutation.runId === input.runId
    && Number.isSafeInteger(Number(input.runAttempt)) && Number(input.runAttempt) > 1
    && Number.isSafeInteger(mutation.runAttempt) && mutation.runAttempt >= 1
    && mutation.runAttempt < Number(input.runAttempt);
}
