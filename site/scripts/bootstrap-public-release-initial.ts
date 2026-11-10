/** Initial conversion operator preserving the original selector owner and
 * qualification/read-budget guards. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import targets from "../../functions/lib/publication-target.js";
import { prepareMeasuredBootstrapQualification, BootstrapReadBudgetError } from "./public-release-bootstrap-read-budget";
import { prepareInitialBootstrapInstalledGuard } from "./public-release-bootstrap-installed-guard";
import { createBootstrapReadStore } from "./public-release-bootstrap-read-store";
import { createBootstrapS3Reads } from "./public-release-bootstrap-s3-read";
import { parseBootstrapResumeAttempt, prepareBootstrapLoggedResume, resumePreparedBootstrap, readBootstrapResumeReceipt } from "./public-release-bootstrap-logged-resume";
import { readInitialBootstrapReceipt } from "./public-release-bootstrap-readback";

function refuse(): never { throw new Error("Initial public release selector was refused"); }
export function parseInitialBootstrapOperatorArgs(args: string[]) {
  const apply = args.length === 3 && args[2] === "--apply";
  if (args.length === 2 && args[0] === "--measure-attempt" && args[1]) return { attemptFile: args[1], dryRun: true, measureOnly: true };
  if (args.length === 2 && args[1] && args[0] === "--readback-attempt") return { initialReadbackFile: args[1], dryRun: true };
  if (args.length === 2 && args[1] && args[0] === "--resume-readback") return { resumeReadbackFile: args[1], dryRun: true };
  if (args[0] === "--resume-attempt" && args[1] && (args.length === 2 || apply)) return { resumeFile: args[1], dryRun: !apply };
  if (args[0] !== "--attempt" || !args[1] || !(args.length === 2 || apply)) refuse();
  return { attemptFile: args[1], dryRun: !apply };
}
export async function runInitialBootstrapOperator(args: string[]) {
  const options = parseInitialBootstrapOperatorArgs(args);
  const file = options.attemptFile ?? options.initialReadbackFile ?? options.resumeReadbackFile ?? options.resumeFile;
  if (!file) refuse();
  const bytes = await readFile(file);
  if (bytes.length > 64 * 1024) refuse();
  const raw = JSON.parse(bytes.toString("utf8"));
  const resume = options.resumeFile || options.resumeReadbackFile ? parseBootstrapResumeAttempt(raw) : null;
  const attempt = resume?.bootstrap ?? bootstrap.parseBootstrapAttempt(raw);
  const target = targets.publicationTarget(attempt.currentPair.environment);
  const readback = options.initialReadbackFile || options.resumeReadbackFile;
  const objects = readback ? null : createBootstrapS3Reads({ environment: attempt.currentPair.environment });
  let app: ReturnType<typeof initializeApp> | undefined;
  try {
    app = initializeApp({ projectId: target.projectId, credential: applicationDefault() });
    const firestore = getFirestore(app);
    if (readback) {
      const receipt = resume ? await readBootstrapResumeReceipt({ firestore, attempt: resume }) : await readInitialBootstrapReceipt({ firestore, attempt });
      process.stdout.write(`${JSON.stringify({ receipt }, null, 2)}\n`); return;
    }
    if (resume) {
      const prior = await readBootstrapResumeReceipt({ firestore, attempt: resume });
      if (prior) { process.stdout.write(`${JSON.stringify({ idempotent: true, receipt: prior }, null, 2)}\n`); return; }
      const signal = AbortSignal.timeout(120_000);
      const store = createBootstrapReadStore({ firestore, attempt, objects: objects!, enabled: true, signal });
      const proof = await prepareBootstrapLoggedResume({ firestore, attempt: resume, store, signal });
      const result = await resumePreparedBootstrap({ firestore, proof, dryRun: options.dryRun });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
    }
    const installed = await prepareInitialBootstrapInstalledGuard({ firestore, attempt });
    const signal = AbortSignal.timeout(30_000);
    const store = createBootstrapReadStore({ firestore, attempt, objects: objects!, enabled: true, signal });
    const { qualificationGuard, measurement } = await prepareMeasuredBootstrapQualification({ firestore, attempt, store, signal });
    if (options.measureOnly) { process.stdout.write(`${JSON.stringify({ measurement }, null, 2)}\n`); return; }
    const result = await bootstrap.bootstrapPublicReleaseSelector({ firestore, attempt, dryRun: options.dryRun, qualificationGuard, ...installed });
    process.stdout.write(`${JSON.stringify({ ...result, measurement }, null, 2)}\n`);
  } finally { objects?.close(); if (app) await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInitialBootstrapOperator(process.argv.slice(2)).catch(error => {
    if (error instanceof BootstrapReadBudgetError) process.stdout.write(`${JSON.stringify({ measurement: error.measurement }, null, 2)}\n`);
    process.stderr.write("Initial public release selector was refused\n"); process.exitCode = 1;
  });
}
